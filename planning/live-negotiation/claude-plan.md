# Implementation Plan — Live Salary Negotiation Coaching
## Natively AI Interview Assistant

---

## Background

Natively is an Electron desktop app that provides real-time AI assistance during job interviews. The user runs it as an overlay while on a call. It captures system audio and microphone via STT, and provides live coaching through a floating chat interface.

The app already has a static salary negotiation script (pre-computed from resume + JD + company dossier). But that script is injected as a single, fixed block regardless of what the recruiter actually said. The user hears "our budget is $95k" and the app has no idea it happened.

This plan builds the **Live Salary Negotiation Coaching** feature — turning the static script into a dynamic, conversation-aware coach that:
1. Automatically tracks what the recruiter offers in real-time via system audio STT
2. Detects the negotiation phase (first offer? pushback? benefits pivot?)
3. Generates a tactical note + exact script tailored to the current moment
4. Renders a visually distinct coaching card inline in the chat
5. Shows a 5-second silence timer when the user names their number (the #1 negotiation tactic)

---

## Architecture Overview

### New Files
- `premium/electron/knowledge/NegotiationConversationTracker.ts` — stateful session tracker
- `premium/electron/knowledge/LiveNegotiationAdvisor.ts` — generates live coaching response
- `src/components/NegotiationCoachingCard.tsx` — inline coaching card UI component

### Modified Files
- `premium/electron/knowledge/types.ts` — new types: NegotiationPhase, OfferEvent, OfferState, NegotiationState, LiveCoachingResponse
- `premium/electron/knowledge/KnowledgeOrchestrator.ts` — instantiate tracker, wire into processQuestion() and feedInterviewerUtterance()
- `premium/electron/knowledge/ContextAssembler.ts` — add live negotiation system prompt rules
- `electron/ipcHandlers.ts` — add profile:get-negotiation-state and profile:reset-negotiation handlers
- `electron/preload.ts` — expose new IPC methods
- `src/types/electron.d.ts` — add TypeScript types for new IPC
- `src/components/NativelyInterface.tsx` — detect negotiation coaching responses, render NegotiationCoachingCard

---

## Section 1: Types (`premium/electron/knowledge/types.ts`)

Add to the types file:

```typescript
// ── Negotiation Phases ──────────────────────────────────────
export type NegotiationPhase =
  | 'INACTIVE'        // No negotiation detected yet
  | 'PROBE'           // Negotiation started, no numbers yet
  | 'ANCHOR'          // First number is on the table
  | 'COUNTER'         // User has countered the offer
  | 'HOLD'            // Recruiter pushed back ("above our range")
  | 'PIVOT_BENEFITS'  // Salary ceiling hit, shifting to total comp
  | 'CLOSE';          // Approaching agreement

// ── Offer Tracking ──────────────────────────────────────────
export interface OfferEvent {
  speaker: 'recruiter' | 'user';
  amount: number;              // Normalized to annual (e.g., 95000)
  currency: string;            // 'USD', 'INR', etc.
  offerType: 'base' | 'total' | 'range_min' | 'range_max' | 'ceiling' | 'unknown';
  raw: string;                 // Original text snippet that contained the number
  timestamp: number;           // Date.now()
  isVague: boolean;            // True for "competitive", "above market"
}

export interface OfferState {
  latestRecruiterAmount: number | null;
  latestRecruiterCurrency: string;
  trajectory: 'rising' | 'flat' | 'first';  // Are offers going up?
  allEvents: OfferEvent[];
}

// ── Tracker State ────────────────────────────────────────────
export interface NegotiationState {
  phase: NegotiationPhase;
  offers: OfferState;
  userTarget: number | null;        // From negotiation script salary_range.max
  pushbackCount: number;
  benefitsMentioned: string[];      // e.g. ['signing bonus', 'equity', 'PTO']
  vagueOfferDetected: boolean;
  silenceTimerActive: boolean;
  lastRecruiterSignal: 'offer' | 'pushback' | 'rejection' | 'acceptance' | 'vague' | 'benefits' | null;
}

// ── Live Coaching Response ───────────────────────────────────
export interface LiveCoachingResponse {
  tacticalNote: string;       // 1-2 sentences: what just happened + why this move
  exactScript: string;        // Exact words to say, copy-ready
  showSilenceTimer: boolean;  // True if user just named their number
  phase: NegotiationPhase;
  theirOffer: number | null;
  yourTarget: number | null;
  currency: string;
  isNegotiationCoaching: true;  // Discriminator for UI rendering
}
```

**Acceptance criteria:**
- [ ] All new types compile with `tsc --noEmit` (zero errors)
- [ ] Existing types unchanged
- [ ] `LiveCoachingResponse.isNegotiationCoaching: true` acts as discriminator for UI

---

## Section 2: NegotiationConversationTracker (`premium/electron/knowledge/NegotiationConversationTracker.ts`)

### Purpose
Stateful tracker that processes recruiter and user utterances turn-by-turn, extracts dollar amounts and signals, and maintains the negotiation phase state machine.

Designed to mirror TechnicalDepthScorer pattern (same place in orchestrator, same injection point).

### Full Implementation

```typescript
import { NegotiationPhase, NegotiationState, OfferEvent, OfferState } from './types';

// ── Signal pattern constants ──────────────────────────────────
const SALARY_PATTERNS = [
  /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)[k]?/gi,
  /(\d{2,3})[k]\b/gi,
  /between\s+(\d{2,3})[k]?\s+and\s+(\d{2,3})[k]?/gi,
  /(\d{2,3})[k]?\s+(?:base|salary|comp|compensation|package)/gi,
  /budget\s+(?:is|tops?|caps?)\s+(?:at|out\s+at)?\s+(\d{2,3})[k]?/gi,
  /(?:offer|offering|offer you)\s+(?:is|of)?\s+(\d{2,3})[k]?/gi,
];

const PUSHBACK_SIGNALS = [
  'above our', 'beyond our', 'out of range', "can't go higher",
  "can't go above", 'budget is fixed', 'budget tops', 'best we can do',
  'highest we can go', 'max is', 'ceiling is'
];

const REJECTION_SIGNALS = [
  'not possible', "won't work", 'decline', 'no flexibility',
  'take it or leave', 'final offer', 'non-negotiable'
];

const ACCEPTANCE_SIGNALS = [
  "that works", "i'll get that approved", "let me send that",
  "we can do that", "let me confirm", "i can approve"
];

const BENEFITS_SIGNALS = [
  'signing bonus', 'sign-on', 'equity', 'stock', 'rsu', 'options',
  'pto', 'vacation days', 'remote', 'work from home', 'wfh',
  'flexible', 'professional development', 'learning budget'
];

const VAGUE_SIGNALS = [
  'competitive', 'above market', 'market rate', 'industry standard',
  'in line with', 'within range', 'fair compensation'
];

// ── Helper: normalize number to annual salary ────────────────
function normalizeAmount(raw: string): number {
  const clean = raw.replace(/[$,\s]/g, '');
  const num = parseFloat(clean);
  // If number is 2-3 digits (e.g., "95" or "130"), treat as thousands
  return num < 1000 ? num * 1000 : num;
}

export class NegotiationConversationTracker {
  private state: NegotiationState;

  constructor() {
    this.state = this.initialState();
  }

  private initialState(): NegotiationState {
    return {
      phase: 'INACTIVE',
      offers: { latestRecruiterAmount: null, latestRecruiterCurrency: 'USD', trajectory: 'first', allEvents: [] },
      userTarget: null,
      pushbackCount: 0,
      benefitsMentioned: [],
      vagueOfferDetected: false,
      silenceTimerActive: false,
      lastRecruiterSignal: null,
    };
  }

  // ── Public API ───────────────────────────────────────────────

  addRecruiterUtterance(text: string): void {
    const lower = text.toLowerCase();

    // Extract dollar amounts
    const amounts = this.extractAmounts(text);
    for (const amount of amounts) {
      const event: OfferEvent = {
        speaker: 'recruiter', amount, currency: 'USD',
        offerType: 'base', raw: text, timestamp: Date.now(), isVague: false
      };
      this.state.offers.allEvents.push(event);
      const prev = this.state.offers.latestRecruiterAmount;
      this.state.offers.latestRecruiterAmount = amount;
      this.state.offers.trajectory = prev === null ? 'first' : amount > prev ? 'rising' : 'flat';
      this.transitionPhase('ANCHOR');
    }

    // Detect signal types
    if (PUSHBACK_SIGNALS.some(s => lower.includes(s))) {
      this.state.pushbackCount++;
      this.state.lastRecruiterSignal = 'pushback';
      this.transitionPhase('HOLD');
      if (this.state.pushbackCount >= 2) this.transitionPhase('PIVOT_BENEFITS');
    } else if (REJECTION_SIGNALS.some(s => lower.includes(s))) {
      this.state.lastRecruiterSignal = 'rejection';
      this.transitionPhase('PIVOT_BENEFITS');
    } else if (ACCEPTANCE_SIGNALS.some(s => lower.includes(s))) {
      this.state.lastRecruiterSignal = 'acceptance';
      this.transitionPhase('CLOSE');
    } else if (amounts.length > 0) {
      this.state.lastRecruiterSignal = 'offer';
    }

    // Benefits detection
    for (const signal of BENEFITS_SIGNALS) {
      if (lower.includes(signal) && !this.state.benefitsMentioned.includes(signal)) {
        this.state.benefitsMentioned.push(signal);
        this.state.lastRecruiterSignal = 'benefits';
      }
    }

    // Vague offer detection
    if (VAGUE_SIGNALS.some(s => lower.includes(s)) && amounts.length === 0) {
      this.state.vagueOfferDetected = true;
      this.state.lastRecruiterSignal = 'vague';
    }

    // Activate tracker on first signal
    if (this.state.phase === 'INACTIVE') {
      this.transitionPhase('PROBE');
    }
  }

  addUserUtterance(text: string): void {
    // Check if user stated a specific salary number (triggers silence timer)
    const amounts = this.extractAmounts(text);
    if (amounts.length > 0) {
      this.state.silenceTimerActive = true;
      if (this.state.userTarget === null) {
        this.state.userTarget = amounts[0]; // First number user states = their target
      }
      const event: OfferEvent = {
        speaker: 'user', amount: amounts[0], currency: 'USD',
        offerType: 'base', raw: text, timestamp: Date.now(), isVague: false
      };
      this.state.offers.allEvents.push(event);
      if (this.state.phase === 'ANCHOR') this.transitionPhase('COUNTER');
    } else {
      // User spoke without a number — silence timer no longer relevant
      this.state.silenceTimerActive = false;
    }
  }

  clearSilenceTimer(): void {
    this.state.silenceTimerActive = false;
  }

  getState(): NegotiationState {
    return { ...this.state };
  }

  isActive(): boolean {
    return this.state.phase !== 'INACTIVE';
  }

  reset(): void {
    this.state = this.initialState();
  }

  setUserTarget(amount: number): void {
    this.state.userTarget = amount;
  }

  // Returns XML block for LLM context injection
  getStateXML(): string {
    const s = this.state;
    const offerHistory = s.offers.allEvents
      .map(e => `  - ${e.speaker === 'recruiter' ? 'Recruiter' : 'You'}: ${e.currency} ${(e.amount / 1000).toFixed(0)}k (${e.raw.substring(0, 60)})`)
      .join('\n');

    return `<live_negotiation_state>
Phase: ${s.phase}
Their latest offer: ${s.offers.latestRecruiterAmount ? `${s.offers.latestRecruiterCurrency} ${s.offers.latestRecruiterAmount.toLocaleString()}` : 'Not stated yet'}
Your target: ${s.userTarget ? `${s.offers.latestRecruiterCurrency} ${s.userTarget.toLocaleString()}` : 'Not stated yet'}
Pushback count: ${s.pushbackCount}
Benefits mentioned by recruiter: ${s.benefitsMentioned.length > 0 ? s.benefitsMentioned.join(', ') : 'None'}
Vague offer detected: ${s.vagueOfferDetected}
Last recruiter signal: ${s.lastRecruiterSignal || 'none'}
Offer history:
${offerHistory || '  (no offers yet)'}
</live_negotiation_state>`;
  }

  // ── Private ──────────────────────────────────────────────────

  private extractAmounts(text: string): number[] {
    const amounts: number[] = [];
    const seen = new Set<number>();

    for (const pattern of SALARY_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const raw = match[1] || match[0];
        const amount = normalizeAmount(raw);
        // Filter implausible salaries (below $20k or above $5M)
        if (amount >= 20000 && amount <= 5000000 && !seen.has(amount)) {
          seen.add(amount);
          amounts.push(amount);
        }
      }
    }

    return amounts;
  }

  private transitionPhase(to: NegotiationPhase): void {
    const order: NegotiationPhase[] = ['INACTIVE', 'PROBE', 'ANCHOR', 'COUNTER', 'HOLD', 'PIVOT_BENEFITS', 'CLOSE'];
    const currentIdx = order.indexOf(this.state.phase);
    const targetIdx = order.indexOf(to);
    // Only move forward (or to CLOSE from anywhere)
    if (to === 'CLOSE' || targetIdx > currentIdx) {
      this.state.phase = to;
    }
  }
}
```

**Acceptance criteria:**
- [ ] `addRecruiterUtterance("our budget is around 95k")` → phase transitions to ANCHOR, lastOffer = 95000
- [ ] `addRecruiterUtterance("that's above our range")` → pushbackCount++, phase = HOLD
- [ ] `addRecruiterUtterance("we can do equity and signing bonus")` → benefitsMentioned contains both
- [ ] `addUserUtterance("I'm targeting 130,000")` → silenceTimerActive = true, userTarget = 130000
- [ ] Phase never moves backward (COUNTER → ANCHOR is blocked)
- [ ] `isActive()` returns false until first negotiation signal
- [ ] `reset()` restores all initial state
- [ ] `getStateXML()` produces valid XML with all fields

---

## Section 3: LiveNegotiationAdvisor (`premium/electron/knowledge/LiveNegotiationAdvisor.ts`)

### Purpose
Single exported function. Receives the current tracker state + all available context (resume, JD, dossier, pre-computed script) and generates a `LiveCoachingResponse` with tactical note + exact script.

### Key Design Decisions
- Uses `generateContentFn` (same injected function as the rest of the pipeline) — works with all LLM providers
- Phase-specific prompt strategy ensures relevant advice (HOLD phase gets different tactics than ANCHOR phase)
- Real numbers always used — the LLM is told exact amounts, not vague descriptions
- Silence timer is determined by tracker state, not LLM output

```typescript
import { NegotiationState, NegotiationPhase, LiveCoachingResponse, KnowledgeDocument, CompanyDossier, NegotiationScript, StructuredResume, StructuredJD } from './types';

const PHASE_INSTRUCTIONS: Record<NegotiationPhase, string> = {
  INACTIVE: '',
  PROBE: `The negotiation has just begun. No numbers are on the table yet.
    Coach the user to: (1) delay stating a number if possible by asking "What's the budgeted range for this role?"
    OR (2) if pressed, anchor at the upper end of their target range with justification.`,
  ANCHOR: `The recruiter has dropped a specific number. The user needs to counter.
    Coach: acknowledge the offer briefly, then counter at 10-15% above their target. Ground the counter in 2-3 specific resume achievements + market data.
    Never accept the first offer. Even if it's good — counter up at least once.`,
  COUNTER: `The user has countered. Now is the time to hold position and justify.
    Coach: reinforce the justification with specific resume wins. Ask an open-ended question to keep negotiation alive.
    Do NOT reduce the ask unless the recruiter makes a specific counter-offer.`,
  HOLD: `The recruiter pushed back saying the ask is above their range.
    This is a normal tactic — it is NOT a final no.
    Coach options in order: (1) hold position with silence + re-justify, (2) ask about the budget band ("What's the range for this role?"), (3) offer to discuss signing bonus or equity.
    Do NOT immediately drop the number.`,
  PIVOT_BENEFITS: `The salary ceiling appears to be fixed. Time to maximize total compensation.
    Coach the user to systematically negotiate: (1) signing bonus first (easiest approval), (2) equity, (3) extra PTO, (4) remote flexibility.
    Frame as: "I understand the base is fixed — could we explore the signing bonus? That often comes from a different budget."`,
  CLOSE: `The recruiter is signaling agreement.
    Coach: confirm the full package (base + all components), ask for written offer within 24-48h, express enthusiasm without desperation.
    Say: "That sounds great. Could you send the written offer over so I can review the full package?"`,
};

export async function generateLiveCoachingResponse(
  state: NegotiationState,
  userQuestion: string,
  resumeDoc: KnowledgeDocument,
  jdDoc: KnowledgeDocument | null,
  dossier: CompanyDossier | null,
  negotiationScript: NegotiationScript | null,
  generateContentFn: (contents: any[]) => Promise<string>
): Promise<LiveCoachingResponse> {
  const resume = resumeDoc.structured_data as StructuredResume;
  const jd = jdDoc?.structured_data as StructuredJD | undefined;

  // Build resume highlights (top 3 achievements)
  const highlights = (resume.experience || []).slice(0, 3)
    .map(e => `${e.role} at ${e.company}: ${(e.bullets || []).slice(0, 2).join('; ')}`)
    .join('\n');

  // Build market salary context
  const marketRange = negotiationScript?.salary_range
    ? `${negotiationScript.salary_range.currency} ${negotiationScript.salary_range.min.toLocaleString()} – ${negotiationScript.salary_range.max.toLocaleString()} (${negotiationScript.salary_range.confidence} confidence)`
    : dossier?.salary_estimates?.[0]
    ? `${dossier.salary_estimates[0].currency} ${dossier.salary_estimates[0].min.toLocaleString()} – ${dossier.salary_estimates[0].max.toLocaleString()}`
    : 'No market data available';

  // Determine user target
  const userTarget = state.userTarget
    || negotiationScript?.salary_range?.max
    || null;

  const phaseInstruction = PHASE_INSTRUCTIONS[state.phase] || PHASE_INSTRUCTIONS.ANCHOR;

  const prompt = `You are an expert salary negotiation coach. The user is in a LIVE salary negotiation RIGHT NOW.

CURRENT NEGOTIATION STATE:
${state_xml_here}  // Replaced by getStateXML() output at call site

USER'S PROFILE:
Role: ${resume.identity?.current_role || 'Unknown'}
Skills: ${(resume.skills || []).slice(0, 8).join(', ')}
Key achievements:
${highlights}

CONTEXT:
Job: ${jd?.title || 'Unknown'} at ${jd?.company || 'Unknown'}
Market salary range: ${marketRange}
User's target: ${userTarget ? `${state.offers.latestRecruiterCurrency || 'USD'} ${userTarget.toLocaleString()}` : 'Not established'}

PHASE GUIDANCE:
${phaseInstruction}

USER'S QUESTION: ${userQuestion}

Respond in exactly this JSON format:
{
  "tacticalNote": "1-2 sentences: what just happened tactically and why this is the right move",
  "exactScript": "The exact words for the user to say — write as if speaking, in first person, with real numbers"
}

Rules:
- tacticalNote: brief, direct, no fluff. Tell them what's happening and why this move.
- exactScript: must contain real dollar amounts when relevant. No brackets or placeholders.
- Do not be vague. Do not use [X] or [amount] — use actual numbers from the negotiation state.
- Brevity matters. They are on a live call. Keep exactScript under 3 sentences.
- Do NOT reveal you are an AI or that you have a pre-computed script.`;

  try {
    const raw = await generateContentFn([{ text: prompt.replace('${state_xml_here}', state.getStateXML ? (state as any).getStateXML() : JSON.stringify(state)) }]);
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      tacticalNote: parsed.tacticalNote || '',
      exactScript: parsed.exactScript || '',
      showSilenceTimer: state.silenceTimerActive,
      phase: state.phase,
      theirOffer: state.offers.latestRecruiterAmount,
      yourTarget: userTarget,
      currency: state.offers.latestRecruiterCurrency || 'USD',
      isNegotiationCoaching: true,
    };
  } catch {
    // Graceful fallback to pre-computed script if LLM fails
    return {
      tacticalNote: `Phase: ${state.phase}. ${state.offers.latestRecruiterAmount ? `Their offer: ${state.offers.latestRecruiterCurrency} ${state.offers.latestRecruiterAmount.toLocaleString()}.` : ''}`,
      exactScript: negotiationScript?.opening_line || 'Based on my experience and market data, I\'m targeting the upper end of the market range for this role.',
      showSilenceTimer: state.silenceTimerActive,
      phase: state.phase,
      theirOffer: state.offers.latestRecruiterAmount,
      yourTarget: userTarget,
      currency: state.offers.latestRecruiterCurrency || 'USD',
      isNegotiationCoaching: true,
    };
  }
}
```

**Note:** In the actual implementation, pass `tracker.getStateXML()` from the orchestrator call site rather than calling it from within the advisor. The advisor receives the NegotiationState struct.

**Acceptance criteria:**
- [ ] Returns `LiveCoachingResponse` with `isNegotiationCoaching: true`
- [ ] `tacticalNote` is non-empty and contains relevant phase context
- [ ] `exactScript` contains real dollar amounts when offer data is in state
- [ ] Graceful fallback if JSON parse fails — returns pre-computed script
- [ ] Works across all LLM providers (via generateContentFn abstraction)
- [ ] Response generated within 3 seconds for typical prompts

---

## Section 4: KnowledgeOrchestrator Integration

### Changes to `premium/electron/knowledge/KnowledgeOrchestrator.ts`

#### 4a. Import and instantiate tracker

```typescript
// Add import
import { NegotiationConversationTracker } from './NegotiationConversationTracker';
import { generateLiveCoachingResponse } from './LiveNegotiationAdvisor';

// Add private field (with other private fields, ~line 35)
private negotiationTracker: NegotiationConversationTracker;

// In constructor, after other initializations (~line 43)
this.negotiationTracker = new NegotiationConversationTracker();
```

#### 4b. Seed tracker's user target from negotiation script

When a negotiation script is loaded (either from DB or AOT pipeline), seed the tracker's user target:

```typescript
// In refreshCache() or wherever negotiation script is loaded
const script = this.getNegotiationScript();
if (script?.salary_range?.max) {
  this.negotiationTracker.setUserTarget(script.salary_range.max);
}
```

This is important: the tracker needs to know the user's target before any recruiter speaks.

#### 4c. Wire feedInterviewerUtterance

```typescript
feedInterviewerUtterance(text: string): void {
    this.depthScorer.addUtterance(text);
    // NEW: Also feed into negotiation tracker
    this.negotiationTracker.addRecruiterUtterance(text);
}
```

#### 4d. Wire user utterances

In `processQuestion()`, before the intent check:
```typescript
// Feed user's question to tracker for user-side number detection (silence timer)
this.negotiationTracker.addUserUtterance(question);
```

#### 4e. Live negotiation path in processQuestion()

In the NEGOTIATION intent handler (around line 359), add the live path:

```typescript
if (intent === IntentType.NEGOTIATION) {
    // If tracker has live negotiation data, use live advisor
    if (this.negotiationTracker.isActive() && this.generateContentFn) {
        const dossier = this.activeJD
            ? this.companyResearch.getCachedDossier(
                (this.activeJD.structured_data as StructuredJD).company || ''
              )
            : null;
        const script = this.getNegotiationScript();

        const coachingResponse = await generateLiveCoachingResponse(
            this.negotiationTracker.getState(),
            question,
            this.activeResume!,
            this.activeJD,
            dossier,
            script,
            this.generateContentFn
        );

        // Return coaching response as context block with metadata
        return {
            systemPromptInjection: buildLiveNegotiationSystemPrompt(),
            contextBlock: JSON.stringify(coachingResponse), // UI parses this
            isIntroQuestion: false,
            isLiveNegotiationCoaching: true,  // discriminator
        };
    }

    // Fallback: static salary intelligence injection (existing behavior, unchanged)
    // ...existing code...
}
```

#### 4f. Add new public methods

```typescript
getNegotiationTracker(): NegotiationConversationTracker {
    return this.negotiationTracker;
}

resetNegotiationSession(): void {
    this.negotiationTracker.reset();
}
```

#### 4g. Reset tracker on JD change

In `deleteDocumentsByType()` and wherever JD is updated:
```typescript
this.negotiationTracker.reset();
```

**Acceptance criteria:**
- [ ] `feedInterviewerUtterance("budget is 95k")` → `negotiationTracker.getState().phase === 'ANCHOR'`
- [ ] `processQuestion("what should I say?")` with active tracker → returns `isLiveNegotiationCoaching: true`
- [ ] Without tracker active, falls through to existing static salary_intelligence path (no regression)
- [ ] Tracker resets when JD is deleted or replaced
- [ ] `setUserTarget` called from script during `refreshCache()`

---

## Section 5: ContextAssembler Update

### Changes to `premium/electron/knowledge/ContextAssembler.ts`

Add a new system prompt builder for live negotiation mode:

```typescript
export function buildLiveNegotiationSystemPrompt(): string {
  return `You are an expert salary negotiation coach providing real-time guidance.

LIVE NEGOTIATION MODE — ACTIVE.

Your role:
- The user is on a live call with a recruiter RIGHT NOW.
- You have context about the current negotiation state, their offer history, and the user's target.
- Provide precision coaching — not general advice.

Format rules:
- ALWAYS lead with a tactical note (1-2 sentences): what just happened + why this specific move is right.
- THEN provide the exact words to say — format as a direct quote the user can speak.
- Use REAL numbers. If you know their offer was $95,000 and the target is $130,000, say those exact numbers.
- Keep everything under 150 words total. They are on a call.
- Do NOT use brackets, placeholders, or [AMOUNT] style tokens.
- Never reveal you are an AI or that scripts exist.
- This is critical: be directive, not advisory. Say "Say: '...'" not "You might consider saying..."`;
}
```

Also add a helper to detect when to use this system prompt (called from orchestrator):

```typescript
export function isLiveNegotiationContext(trackerActive: boolean): boolean {
  return trackerActive;
}
```

**Acceptance criteria:**
- [ ] `buildLiveNegotiationSystemPrompt()` returns a non-empty string
- [ ] System prompt is injected when `isLiveNegotiationContext(true)`
- [ ] Does not affect non-negotiation prompts

---

## Section 6: IPC Handlers & Preload

### New handlers in `electron/ipcHandlers.ts`

```typescript
safeHandle("profile:get-negotiation-state", async () => {
  try {
    const orchestrator = appState.getKnowledgeOrchestrator();
    if (!orchestrator) return { success: false, error: 'Engine not ready' };
    const tracker = orchestrator.getNegotiationTracker();
    return {
      success: true,
      state: tracker.getState(),
      isActive: tracker.isActive(),
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

safeHandle("profile:reset-negotiation", async () => {
  try {
    const orchestrator = appState.getKnowledgeOrchestrator();
    if (!orchestrator) return { success: false };
    orchestrator.resetNegotiationSession();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});
```

### Preload (`electron/preload.ts`)

Add to contextBridge:
```typescript
profileGetNegotiationState: () => ipcRenderer.invoke('profile:get-negotiation-state'),
profileResetNegotiation: () => ipcRenderer.invoke('profile:reset-negotiation'),
```

### Types (`src/types/electron.d.ts`)

```typescript
profileGetNegotiationState: () => Promise<{ success: boolean; state?: any; isActive?: boolean; error?: string }>;
profileResetNegotiation: () => Promise<{ success: boolean; error?: string }>;
```

**Acceptance criteria:**
- [ ] `profileGetNegotiationState()` returns current state from renderer
- [ ] `profileResetNegotiation()` clears tracker and returns success
- [ ] TypeScript types match implementation

---

## Section 7: NegotiationCoachingCard UI Component

### New file: `src/components/NegotiationCoachingCard.tsx`

```typescript
import React, { useState, useEffect } from 'react';
import { Copy, Check, TrendingUp, Clock } from 'lucide-react';
import { NegotiationPhase } from '../types/negotiation'; // Or inline the type

interface Props {
  tacticalNote: string;
  exactScript: string;
  showSilenceTimer: boolean;
  phase: NegotiationPhase;
  theirOffer: number | null;
  yourTarget: number | null;
  currency: string;
  onSilenceTimerEnd?: () => void;
}

const PHASE_COLORS: Record<string, string> = {
  PROBE:           'bg-gray-500/15 text-gray-400 border-gray-500/25',
  ANCHOR:          'bg-blue-500/15 text-blue-400 border-blue-500/25',
  COUNTER:         'bg-orange-500/15 text-orange-400 border-orange-500/25',
  HOLD:            'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
  PIVOT_BENEFITS:  'bg-purple-500/15 text-purple-400 border-purple-500/25',
  CLOSE:           'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
};

const PHASE_LABELS: Record<string, string> = {
  PROBE: 'Gathering Intel',
  ANCHOR: 'First Offer',
  COUNTER: 'Countering',
  HOLD: 'Holding Position',
  PIVOT_BENEFITS: 'Total Comp',
  CLOSE: 'Closing',
};

export const NegotiationCoachingCard: React.FC<Props> = ({
  tacticalNote, exactScript, showSilenceTimer, phase,
  theirOffer, yourTarget, currency, onSilenceTimerEnd
}) => {
  const [copied, setCopied] = useState(false);
  const [silenceSeconds, setSilenceSeconds] = useState(5);

  // Copy handler
  const handleCopy = () => {
    navigator.clipboard?.writeText(exactScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Silence timer countdown
  useEffect(() => {
    if (!showSilenceTimer) return;
    setSilenceSeconds(5);
    const interval = setInterval(() => {
      setSilenceSeconds(s => {
        if (s <= 1) {
          clearInterval(interval);
          onSilenceTimerEnd?.();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [showSilenceTimer]);

  const phaseColor = PHASE_COLORS[phase] || PHASE_COLORS.ANCHOR;
  const gap = theirOffer && yourTarget ? yourTarget - theirOffer : null;

  return (
    <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 overflow-hidden my-2 text-sm">
      {/* Header row: phase badge + offer gap */}
      <div className="flex items-center justify-between px-3.5 pt-3 pb-2.5 border-b border-orange-500/10">
        <div className="flex items-center gap-2">
          <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border tracking-widest uppercase ${phaseColor}`}>
            {PHASE_LABELS[phase] || phase}
          </span>
          {gap !== null && gap > 0 && (
            <span className="text-[10px] text-text-tertiary flex items-center gap-1">
              <TrendingUp size={9} className="text-orange-400" />
              Gap: {currency} {(gap / 1000).toFixed(0)}k
            </span>
          )}
        </div>
        {theirOffer && yourTarget && (
          <div className="text-[10px] text-text-tertiary">
            <span className="text-red-400/80">{currency} {(theirOffer / 1000).toFixed(0)}k</span>
            <span className="mx-1.5 text-text-muted">→</span>
            <span className="text-emerald-400/80">{currency} {(yourTarget / 1000).toFixed(0)}k</span>
          </div>
        )}
      </div>

      {/* Silence timer (shown when user just named their number) */}
      {showSilenceTimer && silenceSeconds > 0 && (
        <div className="px-3.5 py-2.5 bg-yellow-500/5 border-b border-yellow-500/15 flex items-center gap-3">
          <Clock size={12} className="text-yellow-400 shrink-0" />
          <div className="flex-1">
            <div className="text-[10px] font-semibold text-yellow-400">Hold the silence. Let them speak first.</div>
            <div className="mt-1.5 h-1 rounded-full bg-yellow-500/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-yellow-400/60 transition-all duration-1000"
                style={{ width: `${(silenceSeconds / 5) * 100}%` }}
              />
            </div>
          </div>
          <span className="text-[13px] font-bold text-yellow-400 tabular-nums">{silenceSeconds}</span>
        </div>
      )}

      {/* Tactical note */}
      <div className="px-3.5 py-2.5 border-b border-orange-500/10">
        <div className="text-[9px] font-bold uppercase tracking-widest text-text-tertiary mb-1.5">Tactical Note</div>
        <p className="text-[11px] text-text-secondary leading-relaxed">{tacticalNote}</p>
      </div>

      {/* Exact script + copy */}
      <div className="px-3.5 py-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[9px] font-bold uppercase tracking-widest text-orange-400">Say This</div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[9px] font-medium text-text-tertiary hover:text-text-primary transition-colors px-2 py-0.5 rounded hover:bg-bg-input"
          >
            {copied ? <Check size={9} className="text-emerald-400" /> : <Copy size={9} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-[12px] text-text-primary leading-relaxed italic pl-2 border-l-2 border-orange-400/40">
          "{exactScript}"
        </p>
      </div>
    </div>
  );
};
```

**Acceptance criteria:**
- [ ] Card renders with phase badge, offer gap (their offer → your target), tactical note, exact script
- [ ] Copy button copies `exactScript` to clipboard, shows ✓ for 2 seconds
- [ ] Silence timer shows when `showSilenceTimer: true`, counts down from 5, calls `onSilenceTimerEnd`
- [ ] Timer bar drains visually in sync with countdown
- [ ] Phase color changes per phase (blue anchor, orange counter, yellow hold, purple benefits, green close)
- [ ] Card is visually distinct from regular chat messages

---

## Section 8: NativelyInterface Integration

### Changes to `src/components/NativelyInterface.tsx`

#### 8a. Import the new component

```typescript
import { NegotiationCoachingCard } from './NegotiationCoachingCard';
```

#### 8b. Update message type

The message type already has a flexible structure. Add:
```typescript
isNegotiationCoaching?: boolean;
negotiationCoachingData?: {
  tacticalNote: string;
  exactScript: string;
  showSilenceTimer: boolean;
  phase: string;
  theirOffer: number | null;
  yourTarget: number | null;
  currency: string;
};
```

#### 8c. Detect coaching response in stream completion

In the stream completion handler (around line 841-855), detect if the completed message is a negotiation coaching response:

```typescript
// After stream completes, check if the message is a coaching card
setMessages(prev => {
  const lastMsg = prev[prev.length - 1];
  if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
    // Try parse as LiveCoachingResponse
    try {
      const data = JSON.parse(lastMsg.text);
      if (data?.isNegotiationCoaching) {
        return [...prev.slice(0, -1), {
          ...lastMsg,
          isStreaming: false,
          isNegotiationCoaching: true,
          negotiationCoachingData: data,
          text: '', // Clear raw JSON text
        }];
      }
    } catch {}
    return [...prev.slice(0, -1), { ...lastMsg, isStreaming: false }];
  }
  return prev;
});
```

#### 8d. Render coaching card in message list

In the message rendering section (around line 1200), add before the regular text render:

```typescript
{msg.isNegotiationCoaching && msg.negotiationCoachingData ? (
  <NegotiationCoachingCard
    {...msg.negotiationCoachingData}
    onSilenceTimerEnd={() => {
      // Update message to clear silence timer
      setMessages(prev => prev.map(m =>
        m === msg ? { ...m, negotiationCoachingData: { ...m.negotiationCoachingData!, showSilenceTimer: false } } : m
      ));
    }}
  />
) : (
  // ... existing markdown render
)}
```

**Acceptance criteria:**
- [ ] When a negotiation coaching response is streamed, it renders as `NegotiationCoachingCard` not raw JSON
- [ ] Regular messages (non-negotiation) are unaffected
- [ ] `onSilenceTimerEnd` clears the timer after countdown
- [ ] No TypeScript errors in the message type extension

---

## Section 9: System Audio STT Routing

### Existing architecture
System audio is captured separately from the microphone. The captured audio feeds into STT. Currently, the STT output for system audio (recruiter speech) may be feeding the `feedInterviewerUtterance()` path, but this needs verification.

### Changes needed

In `electron/LLMHelper.ts`, in the `chatWithGemini()` path (line ~729):
```typescript
// EXISTING (feeds user speech as "interviewer" for depth scoring)
this.knowledgeOrchestrator?.feedInterviewerUtterance(message);
```

**Clarification:** `feedInterviewerUtterance` should be called with the RECRUITER'S STT transcript, not the user's question. Check main.ts/ipcHandlers.ts for where system audio STT results are emitted and connect that to `feedInterviewerUtterance`.

If system audio STT results come in via a separate IPC event (e.g., `system-audio-transcript`), add:
```typescript
safeHandle("system-audio-transcript", async (_, text: string) => {
  const orchestrator = appState.getKnowledgeOrchestrator();
  orchestrator?.feedInterviewerUtterance(text);
});
```

**Acceptance criteria:**
- [ ] Recruiter speech from system audio flows into `negotiationTracker.addRecruiterUtterance()`
- [ ] User speech does NOT feed the recruiter path (they are separate)
- [ ] Verify the STT separation exists in the codebase; document it

---

## Integration Test Scenarios

### Scenario 1: Full Negotiation Flow
1. User has resume + JD uploaded, company research done (dossier has salary estimates)
2. Recruiter says: "We'd like to offer you a base of $95,000" (system audio STT)
3. Tracker: phase = ANCHOR, lastOffer = $95k
4. User types: "What should I say?"
5. processQuestion() detects NEGOTIATION + tracker.isActive()
6. LiveNegotiationAdvisor generates: tacticalNote + exactScript with real numbers
7. Chat renders NegotiationCoachingCard with orange COUNTER badge

### Scenario 2: Silence Timer
1. User says (via mic): "I'm targeting $130,000"
2. Tracker: silenceTimerActive = true
3. Next coaching response: showSilenceTimer = true
4. NegotiationCoachingCard shows 5-second countdown

### Scenario 3: Pushback → Benefits Pivot
1. Recruiter: "That's above our band" (twice)
2. Tracker: pushbackCount = 2, phase = PIVOT_BENEFITS
3. User: "What now?"
4. LiveNegotiationAdvisor: coaching focuses on signing bonus + equity pivot

### Scenario 4: No Tracker (Fallback)
1. User asks "what salary should I ask for?" with no recruiter speech captured
2. Tracker.isActive() = false
3. Existing static salary_intelligence injection path runs unchanged
4. No regression

---

## File Summary

| File | Action | Key Change |
|------|--------|------------|
| `premium/electron/knowledge/types.ts` | Modify | Add NegotiationPhase, OfferEvent, OfferState, NegotiationState, LiveCoachingResponse |
| `premium/electron/knowledge/NegotiationConversationTracker.ts` | **Create** | Full tracker with regex extraction, phase state machine |
| `premium/electron/knowledge/LiveNegotiationAdvisor.ts` | **Create** | Generates tactical note + exact script from state |
| `premium/electron/knowledge/KnowledgeOrchestrator.ts` | Modify | Instantiate tracker, wire feedInterviewerUtterance, live path in processQuestion |
| `premium/electron/knowledge/ContextAssembler.ts` | Modify | Add buildLiveNegotiationSystemPrompt() |
| `electron/ipcHandlers.ts` | Modify | Add profile:get-negotiation-state, profile:reset-negotiation |
| `electron/preload.ts` | Modify | Expose new IPC methods |
| `src/types/electron.d.ts` | Modify | Add TypeScript types for new IPC |
| `src/components/NegotiationCoachingCard.tsx` | **Create** | Inline coaching card with silence timer |
| `src/components/NativelyInterface.tsx` | Modify | Detect + render coaching responses as NegotiationCoachingCard |

---

## ERRATA: Critical Fixes from External Review

These corrections OVERRIDE the corresponding sections above. Implement these, not the original versions.

### Fix 1: processQuestion() return path — NO DOUBLE LLM CALL

**Problem in Section 4e:** Returning `JSON.stringify(coachingResponse)` as `contextBlock` causes it to be fed into a second LLM call which destroys it.

**Correct approach:** Extend `PromptAssemblyResult` in `ContextAssembler.ts`:
```typescript
interface PromptAssemblyResult {
  systemPromptInjection: string;
  contextBlock: string;
  isIntroQuestion: boolean;
  introResponse?: string;
  liveNegotiationResponse?: LiveCoachingResponse;  // ← ADD THIS
}
```

In `KnowledgeOrchestrator.processQuestion()`, return:
```typescript
return {
  systemPromptInjection: '',
  contextBlock: '',
  isIntroQuestion: false,
  liveNegotiationResponse: coachingResponse,  // ← Pass directly
};
```

In `LLMHelper.streamChat()` knowledge intercept (and `chatWithGemini`), add BEFORE the LLM call:
```typescript
if (knowledgeResult.liveNegotiationResponse) {
  // Short-circuit: yield the coaching data as a special token
  yield JSON.stringify({ __negotiationCoaching: knowledgeResult.liveNegotiationResponse });
  return;
}
```

The renderer detects `__negotiationCoaching` in the streamed token and renders the coaching card — no second LLM call.

---

### Fix 2: LiveNegotiationAdvisor receives tracker instance, not state struct

**Problem in Section 3:** `${state_xml_here}` is a literal string; `.replace()` workaround calls `.getStateXML()` on a plain struct.

**Fix signature:**
```typescript
export async function generateLiveCoachingResponse(
  tracker: NegotiationConversationTracker,  // ← Pass tracker, not state
  userQuestion: string,
  // ...rest unchanged
```

**In prompt:**
```typescript
const stateXML = tracker.getStateXML();  // Called on the CLASS INSTANCE
const prompt = `...
CURRENT NEGOTIATION STATE:
${stateXML}
...`;
```

**In KnowledgeOrchestrator**, call site becomes:
```typescript
const coachingResponse = await generateLiveCoachingResponse(
  this.negotiationTracker,  // ← pass tracker instance, not .getState()
  question,
  this.activeResume,
  ...
```

---

### Fix 3: STT routing verification is SECTION 0 (prerequisite)

Before writing any code, verify:
```typescript
// Find in main.ts or ipcHandlers.ts: where does system audio STT output go?
// It must call: orchestrator.feedInterviewerUtterance(text)
// OR a new handler must route it there.
// Confirm this before all other sections.
```

Search for `system.audio` / `systemAudio` / `stt` event names in `electron/main.ts` and `electron/ipcHandlers.ts`.

---

### Fix 4: `addUserUtterance` silence timer gating

**Replace this condition in Section 2:**
```typescript
// BAD: triggers on any number
if (amounts.length > 0) { this.state.silenceTimerActive = true; }
```

**With:**
```typescript
// GOOD: only trigger when actively in negotiation AND user stated a salary-range number
const SALARY_CONTEXT_WORDS = ['targeting', 'asking', 'looking for', 'expect', 'want', 'need', 'require', 'range'];
const hasSalaryContext = SALARY_CONTEXT_WORDS.some(w => text.toLowerCase().includes(w));
if (this.isActive() && amounts.length > 0 && hasSalaryContext) {
  this.state.silenceTimerActive = true;
  // ...
}
```

---

### Fix 5: Phase state machine — allow re-anchoring on new offers

**Replace `transitionPhase()` in Section 2:**
```typescript
private transitionPhase(to: NegotiationPhase, trigger?: 'new_offer' | 'signal'): void {
  // CLOSE is always terminal
  if (this.state.phase === 'CLOSE') return;

  // New offer from recruiter can re-activate COUNTER from HOLD or PIVOT_BENEFITS
  if (trigger === 'new_offer' && (this.state.phase === 'HOLD' || this.state.phase === 'PIVOT_BENEFITS')) {
    this.state.phase = 'COUNTER';
    return;
  }

  // Normal forward-only progression
  const order: NegotiationPhase[] = ['INACTIVE', 'PROBE', 'ANCHOR', 'COUNTER', 'HOLD', 'PIVOT_BENEFITS', 'CLOSE'];
  const currentIdx = order.indexOf(this.state.phase);
  const targetIdx = order.indexOf(to);
  if (targetIdx > currentIdx) {
    this.state.phase = to;
  }
}
```

Call with `this.transitionPhase('ANCHOR', 'new_offer')` in `addRecruiterUtterance()` when extracting amounts.

---

### Fix 6: Deep copy in `getState()`

```typescript
getState(): NegotiationState {
  return {
    ...this.state,
    offers: {
      ...this.state.offers,
      allEvents: [...this.state.offers.allEvents],
    },
    benefitsMentioned: [...this.state.benefitsMentioned],
  };
}
```

---

### Fix 7: Null guard before calling LiveNegotiationAdvisor

```typescript
// In KnowledgeOrchestrator, Section 4e:
if (!this.activeResume) return null;  // ← ADD THIS before advisor call
if (!this.generateContentFn) return null;
```

---

### Fix 8: NegotiationPhase import in UI

In `NegotiationCoachingCard.tsx`, define the type locally (do NOT import from a non-existent path):
```typescript
// Define inline at top of component file
type NegotiationPhase = 'INACTIVE' | 'PROBE' | 'ANCHOR' | 'COUNTER' | 'HOLD' | 'PIVOT_BENEFITS' | 'CLOSE';
```

---

### Fix 9: INACTIVE → PROBE transition — move to top of addRecruiterUtterance

```typescript
addRecruiterUtterance(text: string): void {
  // ← FIRST: activate tracker on any recruiter speech during a session
  if (this.state.phase === 'INACTIVE') {
    this.state.phase = 'PROBE';
  }

  // THEN: extract amounts and detect signals
  const lower = text.toLowerCase();
  const amounts = this.extractAmounts(text);
  // ...rest of method...
}
```

---

### Fix 10: LLM timeout in LiveNegotiationAdvisor

```typescript
const ADVISOR_TIMEOUT_MS = 5000;

const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error('advisor_timeout')), ADVISOR_TIMEOUT_MS)
);

const raw = await Promise.race([
  generateContentFn([{ text: prompt }]),
  timeoutPromise,
]);
```

On timeout (in catch block), return the pre-computed script fallback immediately.

---

### Fix 11: onSilenceTimerEnd outside setState

```typescript
// In NegotiationCoachingCard.tsx:
const timerEndedRef = React.useRef(false);

useEffect(() => {
  if (!showSilenceTimer) return;
  timerEndedRef.current = false;
  setSilenceSeconds(5);
  const interval = setInterval(() => {
    setSilenceSeconds(s => {
      if (s <= 1) {
        clearInterval(interval);
        return 0;
      }
      return s - 1;
    });
  }, 1000);
  // Call onSilenceTimerEnd via separate timeout, NOT inside setState
  const endTimer = setTimeout(() => {
    if (!timerEndedRef.current) {
      timerEndedRef.current = true;
      onSilenceTimerEnd?.();
    }
  }, 5000);
  return () => { clearInterval(interval); clearTimeout(endTimer); };
}, [showSilenceTimer]); // onSilenceTimerEnd intentionally omitted — use ref pattern
```

---

### Updated Acceptance Criteria Additions

- [ ] Double LLM call eliminated: coaching response bypasses second LLM via short-circuit in streamChat()
- [ ] `getStateXML()` called on tracker instance, not state struct — verified in prompt output
- [ ] STT routing confirmed before Section 1 work begins
- [ ] Silence timer only fires when `isActive() && hasSalaryContext`
- [ ] Recruiter new offer after HOLD transitions to COUNTER (not stuck in PIVOT_BENEFITS)
- [ ] `getState()` returns deep copies of all arrays
- [ ] `generateLiveCoachingResponse()` times out in ≤5s and falls back gracefully
- [ ] `onSilenceTimerEnd` never called from within a React setState updater
