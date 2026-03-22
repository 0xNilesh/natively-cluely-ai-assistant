# Synthesized Specification — Live Salary Negotiation Coaching

## Product Summary

A real-time salary negotiation coach that activates automatically during live interviews when salary topics arise. Unlike the existing static script (which just injects a pre-computed opening line), this system tracks the actual conversation, knows what the recruiter just offered, detects the negotiation phase, and gives the user a specific tactical response — two sections: what's happening tactically + the exact words to say.

The user is literally on a call with a recruiter. They need precision, not platitudes.

---

## Input Sources

### Recruiter Speech
- **Source:** System audio capture (already implemented in the app)
- **Path:** System audio STT → `NegotiationConversationTracker.addRecruiterUtterance(text)`
- **Extraction:** Dollar amounts, ranges, rejection/acceptance/pushback signals, comp components, vague offers
- Fully automatic — no user effort required

### User Speech / Questions
- **Source:** User mic (existing) or manual chat input
- **Path:** Existing streamGeminiChat → knowledge mode intercept → processQuestion()
- When user asks a negotiation question, the tracker state is injected into the LLM context

---

## Core Components

### 1. `NegotiationConversationTracker`
**New file:** `premium/electron/knowledge/NegotiationConversationTracker.ts`

Stateful, session-scoped tracker. Lives in KnowledgeOrchestrator. Mirrors TechnicalDepthScorer pattern.

**Phase state machine:**
```
INACTIVE → PROBE → ANCHOR → COUNTER → HOLD → PIVOT_BENEFITS → CLOSE
```

**State it tracks:**
```typescript
interface NegotiationState {
  phase: NegotiationPhase;
  recruiterOffers: OfferEvent[];       // All numbers recruiter mentioned, in order
  lastOffer: OfferState | null;        // Most recent parsed offer
  userTarget: number | null;           // User's stated target (from negotiation script)
  pushbackCount: number;               // How many times recruiter pushed back
  benefitsMentioned: string[];         // Equity, PTO, signing bonus flagged
  vagueOfferDetected: boolean;         // "competitive" without a number
  silenceTimerActive: boolean;         // Whether to show silence countdown
  conversationHistory: Turn[];         // Alternating recruiter/user turns
}
```

**Key methods:**
- `addRecruiterUtterance(text: string): void` — extract signals, update phase, update state
- `addUserUtterance(text: string): void` — detect if user stated a number (triggers silence timer)
- `getStateXML(): string` — formatted XML block for LLM context injection
- `getCurrentPhase(): NegotiationPhase`
- `getLastOffer(): OfferState | null`
- `reset(): void` — called on session end
- `isActive(): boolean` — true after first negotiation signal detected

**Phase transition logic:**
- INACTIVE → PROBE: any NEGOTIATION intent detected
- PROBE → ANCHOR: first dollar amount mentioned (recruiter OR user)
- ANCHOR → COUNTER: user responds to offer with a different number
- COUNTER → HOLD: recruiter says "above our range / budget / can't go higher"
- HOLD → PIVOT_BENEFITS: recruiter explicitly says salary is fixed, OR after 2+ pushbacks
- Any → CLOSE: recruiter or user signals agreement, or user asks for time to consider

### 2. Offer Extraction (within NegotiationConversationTracker)

**Regex patterns:**
```typescript
const SALARY_PATTERNS = [
  /\$\s?(\d{2,3})[k,]?(\d{3})?/gi,           // "$130k", "$130,000", "$130"
  /(\d{2,3})[k]\b/gi,                           // "130k"
  /between\s+(\d{2,3})[k]?\s+and\s+(\d{2,3})[k]?/gi,  // "between 100 and 120"
  /(\d{2,3})[k]?\s+(?:base|salary|comp)/gi,    // "110 base", "95 salary"
  /budget\s+(?:is|tops?|caps?)\s+(?:at|out\s+at)?\s+(\d{2,3})[k]?/gi,
];
```

**LLM extraction fallback** (for vague speech): When no number found but negotiation context active, call `generateContentStructured` with recruiter text to extract structured offer.

**Signal detection:**
```typescript
const REJECTION_SIGNALS = ['not possible', "won't work", 'decline', 'no flexibility'];
const PUSHBACK_SIGNALS = ['above our', 'beyond our', 'out of range', "can't go higher", 'budget is'];
const ACCEPTANCE_SIGNALS = ['that works', "i'll get that approved", "let me send", 'we can do that'];
const BENEFITS_SIGNALS = ['signing bonus', 'equity', 'stock', 'pto', 'vacation', 'remote', 'flexible'];
const VAGUE_SIGNALS = ['competitive', 'above market', 'market rate', 'industry standard'];
```

### 3. `LiveNegotiationAdvisor`
**New file:** `premium/electron/knowledge/LiveNegotiationAdvisor.ts`

Single function that generates the coaching response given current negotiation state + user question + resume/dossier context.

```typescript
export async function generateLiveCoachingResponse(
  state: NegotiationState,
  userQuestion: string,
  resumeDoc: KnowledgeDocument,
  jdDoc: KnowledgeDocument | null,
  dossier: CompanyDossier | null,
  negotiationScript: NegotiationScript | null,
  generateContentFn: (contents: any[]) => Promise<string>
): Promise<LiveCoachingResponse>
```

**Output:**
```typescript
interface LiveCoachingResponse {
  tacticalNote: string;      // 1-2 sentences: what's happening + why this move
  exactScript: string;       // Exact words to say — copy-ready
  showSilenceTimer: boolean; // True when user just named their number
  phase: NegotiationPhase;
  offerDelta: { theirOffer: number | null; yourTarget: number | null } | null;
}
```

**Prompt construction:**
- Includes: current phase, offer history, pushback count, benefits flagged, user's resume highlights, market salary range from dossier, pre-computed negotiation script
- System rules enforced: be precise (use real numbers), be directive (say "Say: ..."), be tactical (brief explanation first), never be vague

### 4. KnowledgeOrchestrator Integration

**Additions to KnowledgeOrchestrator:**
```typescript
private negotiationTracker: NegotiationConversationTracker;  // New private field
```

**Modified methods:**
- `feedInterviewerUtterance(text)` — ALSO calls `negotiationTracker.addRecruiterUtterance(text)` if tracker is active
- `processQuestion(question)` — when NEGOTIATION intent AND tracker.isActive(), call `LiveNegotiationAdvisor.generateLiveCoachingResponse()` instead of static salary_intelligence injection; return result as `contextBlock`

**New methods:**
- `getNegotiationTracker(): NegotiationConversationTracker` — for IPC handler access
- `resetNegotiationSession(): void` — called on JD change or explicit reset

### 5. ContextAssembler Rules Update

Add new system prompt rules when tracker is active:
```
LIVE NEGOTIATION MODE — ACTIVE:
- You are coaching through an active salary negotiation. The user needs precision, not generalities.
- Always lead with a 1-2 sentence tactical note explaining what just happened and why this move makes sense.
- Then provide the exact words to say — formatted as: Say: "[exact script]"
- Use real numbers from the negotiation context. Never give a range when you know their target number.
- If this is the moment they just named their number: remind them to hold silence.
- Do not pad the response. Brevity is critical — they are on a live call.
```

---

## UI: Negotiation Coaching Card

### Rendering Location
Inline in the NativelyInterface chat stream. When a negotiation coaching response is detected (via `isNegotiationCoaching: true` flag on the message), render `<NegotiationCoachingCard>` instead of the standard markdown response.

### Card Structure
```
┌─────────────────────────────────────────────┐
│  ⚡ NEGOTIATION  ·  COUNTER  ·  Gap: $35k   │
│─────────────────────────────────────────────│
│  Their offer: $95,000  →  Your target: $130k │
│─────────────────────────────────────────────│
│  📋 Tactical note                           │
│  They anchored 27% below your target.       │
│  Standard low-ball opener. Counter with     │
│  specific justification.                     │
│─────────────────────────────────────────────│
│  💬 Say this                                │
│  "I appreciate the offer. Based on market   │
│   data and my 5 years leading backend       │
│   teams at scale, I'm targeting $130,000.   │
│   Can we work toward that?"                 │
│                               [Copy] ✓       │
│─────────────────────────────────────────────│
│  [Hold silence ▶ 5s]    [Pivot to Benefits] │
└─────────────────────────────────────────────┘
```

### Silence Timer
When `showSilenceTimer: true`:
- Show animated 5-second countdown bar
- Label: "Hold silence. Let them speak first."
- Auto-dismisses after 5 seconds

### Phase Badges
- `PROBE` — gray (intel gathering)
- `ANCHOR` — blue (first number on table)
- `COUNTER` — orange (active negotiation)
- `HOLD` — yellow (recruiter pushed back)
- `PIVOT_BENEFITS` — purple (shifting to total comp)
- `CLOSE` — green (approaching agreement)

### Offer Tracker (collapsible section)
Shows all offer events in chronological order with timestamp and speaker labels. Arrow indicators show trajectory (offers going up ↑ or stuck →).

---

## IPC Handlers

**New handlers:**
- `profile:get-negotiation-state` — returns current tracker state (phase, lastOffer, pushbackCount, benefitsMentioned)
- `profile:reset-negotiation` — explicitly reset tracker (e.g., if user wants to restart the negotiation phase)

**Modified response from `profile:generate-negotiation`:**
- Already fixed to return actual script
- No changes needed for the new live flow — live coaching runs through the existing chat stream

---

## Data Flow (End-to-End)

```
1. SYSTEM AUDIO STT captures recruiter: "Our budget for this role is around 95k"
   ↓
2. LLMHelper.feedInterviewerUtterance("Our budget...")
   ↓
3. KnowledgeOrchestrator.feedInterviewerUtterance()
   → depthScorer.addUtterance()         [existing]
   → negotiationTracker.addRecruiterUtterance()  [NEW]
     → Extracts: offer = $95k
     → Phase: INACTIVE → ANCHOR
     → Stores: OfferEvent { speaker: 'recruiter', amount: 95000, raw: "around 95k" }
   ↓
4. USER types: "What should I say?"
   ↓
5. streamGeminiChat IPC → LLMHelper.streamChat()
   ↓
6. Knowledge mode intercept → KnowledgeOrchestrator.processQuestion("What should I say?")
   → classifyIntent() → NEGOTIATION
   → tracker.isActive() === true
   → LiveNegotiationAdvisor.generateLiveCoachingResponse(state, question, resume, jd, dossier, script)
     → Builds prompt: phase=ANCHOR, theirOffer=$95k, userTarget=$130k, resume highlights, market data
     → LLM generates: { tacticalNote, exactScript, showSilenceTimer: false, phase: COUNTER }
   → Returns as contextBlock with flag: isNegotiationCoaching: true
   ↓
7. LLM streams response using coaching system prompt + context
   ↓
8. NativelyInterface receives stream with isNegotiationCoaching flag
   → Renders <NegotiationCoachingCard> instead of plain markdown
   → Shows phase badge (COUNTER), offer gap ($35k), tactical note, exact script, copy button
   ↓
9. User copies script, says it, recruiter responds
   ↓
10. REPEAT from step 1
```

---

## Technical Constraints & Decisions

- **No new npm dependencies** — regex extraction + existing LLM for fallback
- **Session-only state** — NegotiationConversationTracker lives in memory, reset on JD change or overlay close
- **Latency budget** — Live coaching response must fit within existing 2-4s chat latency. The coaching prompt is compact (no large document injection) so this is achievable.
- **System audio STT routing** — recruiter speech is already captured; the routing hook into negotiationTracker is in `feedInterviewerUtterance()` which is called in `chatWithGemini()`. For the streaming path in `streamChat()`, the same call should be made.
- **Graceful degradation** — if tracker has no offer data, fall back to static salary_intelligence injection (existing behavior). No regression.
- **TypeScript** throughout — all new types exported from types.ts

---

## Success Criteria

1. User asks "what should I say?" after recruiter drops $95k → gets a response that contains $95k, their $130k target, and an exact counter script within 3 seconds
2. Tracker correctly identifies phase transitions across a 5-turn negotiation conversation
3. Silence timer appears after user says their target number
4. Benefits pivot button appears after 2+ pushbacks or when recruiter says salary is fixed
5. Coaching card renders inline in the chat, distinct from regular AI responses
6. Zero regression in existing non-negotiation chat behavior
