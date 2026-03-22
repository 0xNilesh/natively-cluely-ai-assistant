# Section 03 — LiveNegotiationAdvisor

**File to create:** `premium/electron/knowledge/LiveNegotiationAdvisor.ts`

**Depends on:** Section 01 (types in `types.ts`), Section 02 (`NegotiationConversationTracker`)

**Blocks:** Section 04 (KnowledgeOrchestrator integration)

---

## Purpose

Single exported async function. Receives the live tracker **instance** (not a plain state struct), all available context (resume doc, JD doc, company dossier, pre-computed negotiation script), and a `generateContentFn` abstraction. Returns a `LiveCoachingResponse` with a tactical note and an exact script the user can speak verbatim.

Key design decisions:
- The tracker **instance** is passed in so `tracker.getStateXML()` can be called directly inside the template literal — eliminating the broken `${state_xml_here}` placeholder from the original plan.
- A 5-second `Promise.race` timeout wraps the LLM call. If the LLM times out or throws, the function falls back to the pre-computed negotiation script rather than hanging the UI.
- A null guard on `activeResume` is enforced at the call site in the orchestrator (Section 04); inside the advisor itself, the `resumeDoc` parameter is treated as non-null but `structured_data` fields are accessed with safe fallbacks to prevent crashes when the structured data is malformed.
- `NegotiationScript` is imported from `./NegotiationEngine` (where it is defined), not from `./types`.

---

## Imports

```typescript
import {
  KnowledgeDocument,
  CompanyDossier,
  StructuredResume,
  StructuredJD,
} from './types';
import { NegotiationConversationTracker } from './NegotiationConversationTracker';
import { NegotiationScript } from './NegotiationEngine';
import { NegotiationPhase, LiveCoachingResponse } from './types';
```

> **Note:** `NegotiationPhase` and `LiveCoachingResponse` live in `./types` (added in Section 01). `NegotiationScript` lives in `./NegotiationEngine`. Do not move `NegotiationScript` — it is already used there by the orchestrator and AOT pipeline.

---

## Phase Instructions Map

The map is `Record<NegotiationPhase, string>`. Every phase key must be present. The empty string for `INACTIVE` is intentional — the advisor should never be called when the tracker is inactive, but the key must exist for type safety.

```typescript
const PHASE_INSTRUCTIONS: Record<NegotiationPhase, string> = {
  INACTIVE: '',

  PROBE: `The negotiation has just started. No specific numbers have been mentioned yet.
Coach the user to:
(1) Delay stating a number if possible — ask "What's the budgeted range for this role?" to make the recruiter anchor first.
(2) If pressed to go first, anchor at the upper end of their target range with a brief justification grounded in experience and market data.
Do NOT suggest lowballing or "being flexible." Frame confidence as professionalism.`,

  ANCHOR: `The recruiter has stated a specific number. The user must counter — never accept the first offer.
Coach:
- Acknowledge the offer briefly and warmly ("I appreciate that").
- Counter at 10–15% above the user's target (not above the recruiter's number — above the user's own target).
- Ground the counter in 2–3 specific resume achievements and/or market rate data.
- Keep the exact script under 3 sentences and end with confidence, not a question.
Even if the offer is good, always counter up at least once.`,

  COUNTER: `The user has named their number. Now hold position and justify.
Coach:
- Do NOT suggest reducing the ask. Silence is the correct move immediately after naming a number.
- If the recruiter responds without countering, re-justify with one more specific achievement.
- Ask an open-ended question to keep the negotiation moving: "What's the timeline for making a decision?"
- Do NOT volunteer concessions. Wait for the recruiter to make a move.`,

  HOLD: `The recruiter pushed back — said the ask is above their range or budget.
This is a standard negotiation tactic, not a final no.
Coach in this order:
(1) Hold position: brief silence acknowledgment + re-justify with one achievement.
(2) If the recruiter repeats the pushback, ask about the budget band: "Could you share the full range for this role?"
(3) If the ceiling is genuinely fixed, pivot to signing bonus or equity as a bridge.
Do NOT immediately drop the number in response to the first pushback.`,

  PIVOT_BENEFITS: `The base salary ceiling appears to be fixed.
Coach the user to maximize total compensation systematically:
(1) Signing bonus first — easiest to approve, often from a separate budget. Frame as: "I understand the base is fixed — could we explore a signing bonus to bridge the gap? That often comes from a different budget."
(2) Equity or RSUs if applicable.
(3) Extra PTO or remote flexibility.
(4) Professional development / learning budget.
Treat each component as its own negotiation. Do not ask for everything at once.`,

  CLOSE: `The recruiter is signaling agreement or near-agreement.
Coach:
- Confirm the full package out loud: base + signing bonus + equity + PTO (any components that came up).
- Ask for the written offer: "That sounds great — could you send over the written offer so I can review the full package?"
- Express genuine enthusiasm without desperation.
- Do NOT negotiate further at this stage. Secure the agreement and exit cleanly.`,
};
```

---

## Full Implementation

```typescript
// premium/electron/knowledge/LiveNegotiationAdvisor.ts
// Generates a live coaching response during an active salary negotiation.
// Depends on: NegotiationConversationTracker (Section 02), types (Section 01)

import {
  KnowledgeDocument,
  CompanyDossier,
  StructuredResume,
  StructuredJD,
  NegotiationPhase,
  LiveCoachingResponse,
} from './types';
import { NegotiationConversationTracker } from './NegotiationConversationTracker';
import { NegotiationScript } from './NegotiationEngine';

// ── Phase instructions ────────────────────────────────────────

const PHASE_INSTRUCTIONS: Record<NegotiationPhase, string> = {
  INACTIVE: '',

  PROBE: `The negotiation has just started. No specific numbers have been mentioned yet.
Coach the user to:
(1) Delay stating a number if possible — ask "What's the budgeted range for this role?" to make the recruiter anchor first.
(2) If pressed to go first, anchor at the upper end of their target range with a brief justification grounded in experience and market data.
Do NOT suggest lowballing or "being flexible." Frame confidence as professionalism.`,

  ANCHOR: `The recruiter has stated a specific number. The user must counter — never accept the first offer.
Coach:
- Acknowledge the offer briefly and warmly ("I appreciate that").
- Counter at 10–15% above the user's target (not above the recruiter's number — above the user's own target).
- Ground the counter in 2–3 specific resume achievements and/or market rate data.
- Keep the exact script under 3 sentences and end with confidence, not a question.
Even if the offer is good, always counter up at least once.`,

  COUNTER: `The user has named their number. Now hold position and justify.
Coach:
- Do NOT suggest reducing the ask. Silence is the correct move immediately after naming a number.
- If the recruiter responds without countering, re-justify with one more specific achievement.
- Ask an open-ended question to keep the negotiation moving: "What's the timeline for making a decision?"
- Do NOT volunteer concessions. Wait for the recruiter to make a move.`,

  HOLD: `The recruiter pushed back — said the ask is above their range or budget.
This is a standard negotiation tactic, not a final no.
Coach in this order:
(1) Hold position: brief silence acknowledgment + re-justify with one achievement.
(2) If the recruiter repeats the pushback, ask about the budget band: "Could you share the full range for this role?"
(3) If the ceiling is genuinely fixed, pivot to signing bonus or equity as a bridge.
Do NOT immediately drop the number in response to the first pushback.`,

  PIVOT_BENEFITS: `The base salary ceiling appears to be fixed.
Coach the user to maximize total compensation systematically:
(1) Signing bonus first — easiest to approve, often from a separate budget. Frame as: "I understand the base is fixed — could we explore a signing bonus to bridge the gap? That often comes from a different budget."
(2) Equity or RSUs if applicable.
(3) Extra PTO or remote flexibility.
(4) Professional development / learning budget.
Treat each component as its own negotiation. Do not ask for everything at once.`,

  CLOSE: `The recruiter is signaling agreement or near-agreement.
Coach:
- Confirm the full package out loud: base + signing bonus + equity + PTO (any components that came up).
- Ask for the written offer: "That sounds great — could you send over the written offer so I can review the full package?"
- Express genuine enthusiasm without desperation.
- Do NOT negotiate further at this stage. Secure the agreement and exit cleanly.`,
};

// ── Timeout constant ──────────────────────────────────────────

const LLM_TIMEOUT_MS = 5000;

// ── Main export ───────────────────────────────────────────────

/**
 * Generate a live coaching response for an active salary negotiation.
 *
 * IMPORTANT: `tracker` is the full NegotiationConversationTracker instance,
 * not a plain NegotiationState struct. This allows calling tracker.getStateXML()
 * directly inside the prompt template literal.
 *
 * The orchestrator (Section 04) must guard against a null activeResume BEFORE
 * calling this function. This function treats resumeDoc as non-null.
 */
export async function generateLiveCoachingResponse(
  tracker: NegotiationConversationTracker,
  userQuestion: string,
  resumeDoc: KnowledgeDocument,
  jdDoc: KnowledgeDocument | null,
  dossier: CompanyDossier | null,
  negotiationScript: NegotiationScript | null,
  generateContentFn: (contents: { text: string }[]) => Promise<string>
): Promise<LiveCoachingResponse> {
  const state = tracker.getState();
  const resume = (resumeDoc.structured_data as StructuredResume) ?? ({} as StructuredResume);
  const jd = jdDoc?.structured_data as StructuredJD | undefined;

  // ── Resume highlights (top 3 roles, up to 2 bullets each) ──
  const highlights = (resume.experience ?? [])
    .slice(0, 3)
    .map(
      (e) =>
        `${e.role ?? 'Unknown role'} at ${e.company ?? 'Unknown company'}: ${(e.bullets ?? []).slice(0, 2).join('; ')}`
    )
    .join('\n');

  // ── Market salary context ────────────────────────────────────
  const marketRange = negotiationScript?.salary_range
    ? `${negotiationScript.salary_range.currency} ${negotiationScript.salary_range.min.toLocaleString()} – ${negotiationScript.salary_range.max.toLocaleString()} (${negotiationScript.salary_range.confidence} confidence)`
    : dossier?.salary_estimates?.[0]
    ? `${dossier.salary_estimates[0].currency} ${dossier.salary_estimates[0].min.toLocaleString()} – ${dossier.salary_estimates[0].max.toLocaleString()}`
    : 'No market data available';

  // ── User target (tracker wins; fall back to script max) ─────
  const userTarget =
    state.userTarget ?? negotiationScript?.salary_range?.max ?? null;

  const phaseInstruction =
    PHASE_INSTRUCTIONS[state.phase] ?? PHASE_INSTRUCTIONS.ANCHOR;

  // ── Prompt (tracker.getStateXML() called directly — Fix 2) ──
  const prompt = `You are an expert salary negotiation coach. The user is in a LIVE salary negotiation RIGHT NOW.

CURRENT NEGOTIATION STATE:
${tracker.getStateXML()}

USER'S PROFILE:
Role: ${resume.identity?.current_role ?? 'Unknown'}
Skills: ${(resume.skills ?? []).slice(0, 8).join(', ')}
Key achievements:
${highlights || '(no experience data available)'}

CONTEXT:
Job: ${jd?.title ?? 'Unknown'} at ${jd?.company ?? 'Unknown'}
Market salary range: ${marketRange}
User's target: ${userTarget ? `${state.offers.latestRecruiterCurrency ?? 'USD'} ${userTarget.toLocaleString()}` : 'Not established'}

PHASE GUIDANCE:
${phaseInstruction}

USER'S QUESTION: ${userQuestion}

Respond in exactly this JSON format (no markdown fences, no extra keys):
{
  "tacticalNote": "1-2 sentences: what just happened tactically and why this is the right move",
  "exactScript": "The exact words for the user to say — written as if speaking, in first person, with real numbers"
}

Rules:
- tacticalNote: brief, direct, no fluff. Tell them what is happening and why this move is correct.
- exactScript: must contain real dollar amounts when offer data is available. No brackets or placeholders like [AMOUNT].
- Use REAL numbers from the negotiation state above. If you know the offer was $95,000 and the target is $130,000, say those exact numbers.
- Keep exactScript under 3 sentences. The user is on a live call.
- Do NOT reveal you are an AI or that a pre-computed script exists.
- Be directive, not advisory. Say exactly what to say, do not hedge.`;

  // ── LLM call with 5-second timeout (Fix 10) ─────────────────
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('LiveNegotiationAdvisor: LLM timeout')), LLM_TIMEOUT_MS)
  );

  try {
    const raw = await Promise.race([
      generateContentFn([{ text: prompt }]),
      timeoutPromise,
    ]);

    const clean = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    const parsed = JSON.parse(clean) as { tacticalNote?: string; exactScript?: string };

    return {
      tacticalNote: parsed.tacticalNote?.trim() || buildFallbackTacticalNote(state.phase, state.offers.latestRecruiterAmount, state.offers.latestRecruiterCurrency ?? 'USD'),
      exactScript: parsed.exactScript?.trim() || buildFallbackScript(negotiationScript, userTarget, state.offers.latestRecruiterCurrency ?? 'USD'),
      showSilenceTimer: state.silenceTimerActive,
      phase: state.phase,
      theirOffer: state.offers.latestRecruiterAmount,
      yourTarget: userTarget,
      currency: state.offers.latestRecruiterCurrency ?? 'USD',
      isNegotiationCoaching: true,
    };
  } catch (err) {
    // Covers: LLM timeout, network error, JSON parse failure, LLM returned non-JSON.
    // Always log so errors are diagnosable in production logs.
    console.error('[LiveNegotiationAdvisor] Falling back to pre-computed script:', err);

    return {
      tacticalNote: buildFallbackTacticalNote(
        state.phase,
        state.offers.latestRecruiterAmount,
        state.offers.latestRecruiterCurrency ?? 'USD'
      ),
      exactScript: buildFallbackScript(
        negotiationScript,
        userTarget,
        state.offers.latestRecruiterCurrency ?? 'USD'
      ),
      showSilenceTimer: state.silenceTimerActive,
      phase: state.phase,
      theirOffer: state.offers.latestRecruiterAmount,
      yourTarget: userTarget,
      currency: state.offers.latestRecruiterCurrency ?? 'USD',
      isNegotiationCoaching: true,
    };
  }
}

// ── Fallback helpers ──────────────────────────────────────────

function buildFallbackTacticalNote(
  phase: NegotiationPhase,
  theirOffer: number | null,
  currency: string
): string {
  const offerPart = theirOffer
    ? ` Their offer: ${currency} ${theirOffer.toLocaleString()}.`
    : '';
  return `Phase: ${phase}.${offerPart} Use your pre-computed opening line.`;
}

function buildFallbackScript(
  negotiationScript: NegotiationScript | null,
  userTarget: number | null,
  currency: string
): string {
  if (negotiationScript?.opening_line) {
    return negotiationScript.opening_line;
  }
  if (userTarget) {
    return `Based on my experience and market research, I'm targeting ${currency} ${userTarget.toLocaleString()} for this role.`;
  }
  return "Based on my experience and market data, I'm targeting the upper end of the market range for this role.";
}
```

---

## Call Site Contract (enforced by Section 04)

The orchestrator (Section 04) is responsible for two guards before calling `generateLiveCoachingResponse`:

**Fix 7 — null guard on activeResume:**

```typescript
// In KnowledgeOrchestrator.processQuestion(), Section 04:
if (!this.activeResume) {
  // Fall through to static salary intelligence path — no crash
  // (same fallback used when tracker is inactive)
  return this.buildStaticNegotiationContext(/* ... */);
}

const coachingResponse = await generateLiveCoachingResponse(
  this.negotiationTracker,   // tracker INSTANCE — not getState()
  question,
  this.activeResume,         // safe after guard above
  this.activeJD,
  dossier,
  script,
  this.generateContentFn
);
```

The advisor does NOT call `this.activeResume!` — it receives `resumeDoc` as a parameter that is guaranteed non-null by the orchestrator guard.

**Fix 2 — tracker instance, not state struct:**

The first parameter is `tracker: NegotiationConversationTracker` (the class instance), not `state: NegotiationState` (the plain object returned by `tracker.getState()`). This is what allows `tracker.getStateXML()` to be called directly inside the template literal.

**Fix 10 — 5-second timeout:**

`Promise.race` wraps the `generateContentFn` call with a 5-second timeout. On timeout or any error, the catch block returns the pre-computed `negotiationScript.opening_line` (if available) or a generic market-rate fallback. The UI never hangs.

---

## Acceptance Criteria

- [ ] `generateLiveCoachingResponse` is a named export from `premium/electron/knowledge/LiveNegotiationAdvisor.ts`
- [ ] Function signature accepts `tracker: NegotiationConversationTracker` as the first parameter (not `NegotiationState`)
- [ ] `tracker.getStateXML()` is called directly in the template literal — no `${state_xml_here}` placeholder and no `.replace()` workaround
- [ ] Returned object has `isNegotiationCoaching: true` (literal `true`, not a boolean variable)
- [ ] `tacticalNote` is always a non-empty string (either LLM output or fallback)
- [ ] `exactScript` is always a non-empty string (either LLM output or fallback) — never an empty quoted block in the UI
- [ ] `showSilenceTimer` reflects `tracker.getState().silenceTimerActive` at call time
- [ ] `theirOffer` reflects `tracker.getState().offers.latestRecruiterAmount` (may be null)
- [ ] `yourTarget` reflects `state.userTarget ?? negotiationScript?.salary_range?.max ?? null`
- [ ] `currency` falls back to `'USD'` if `latestRecruiterCurrency` is null or empty
- [ ] LLM call is wrapped in `Promise.race` with a 5-second timeout — if LLM hangs, function still returns within ~5 seconds
- [ ] On LLM timeout, JSON parse failure, or any thrown error: fallback response is returned, error is logged with `console.error`
- [ ] All 7 `NegotiationPhase` keys are present in `PHASE_INSTRUCTIONS` — TypeScript will enforce this via `Record<NegotiationPhase, string>`
- [ ] `PHASE_INSTRUCTIONS.INACTIVE` is an empty string (not missing, not undefined)
- [ ] File compiles with `tsc --noEmit` — zero type errors
- [ ] `NegotiationScript` is imported from `./NegotiationEngine`, not from `./types`
- [ ] No `any` casts except where `structured_data` is cast to `StructuredResume` / `StructuredJD` (same pattern as the rest of the knowledge pipeline)

---

## Edge Cases

| Scenario | Expected behavior |
|---|---|
| `resumeDoc.structured_data` is null or malformed | Safe fallbacks (`?? []`, `?? {}`) prevent crashes; highlights/skills will be empty strings in the prompt |
| `jdDoc` is null | `jd?.title` and `jd?.company` fall back to `'Unknown'` in the prompt |
| `negotiationScript` is null | `marketRange` uses dossier salary estimates or `'No market data available'`; fallback script uses generic market-rate sentence |
| LLM returns valid JSON with empty `exactScript` | `buildFallbackScript` is used — no empty quoted block reaches the UI |
| LLM returns markdown-fenced JSON (` ```json ... ``` `) | Fence stripping regex handles both ` ```json ` and plain ` ``` ` |
| Tracker phase is `INACTIVE` at call time | `PHASE_INSTRUCTIONS.INACTIVE` is `''`; the orchestrator should never call the advisor when `isActive()` is false, but the function handles it gracefully |
| Both `userTarget` and `negotiationScript?.salary_range?.max` are null | `yourTarget` is null in the response; the prompt states "Not established" — the LLM will give general advice |

---

## What This Section Does NOT Do

- Does not modify `KnowledgeOrchestrator.ts` — that is Section 04.
- Does not add IPC handlers — that is Section 06.
- Does not define `NegotiationScript` — it imports it from `./NegotiationEngine`.
- Does not define `NegotiationPhase`, `LiveCoachingResponse`, `KnowledgeDocument`, `CompanyDossier`, `StructuredResume`, or `StructuredJD` — those are Section 01 types imported from `./types`.
- Does not call `tracker.getState()` to pass the plain struct to `generateContentFn` — `getStateXML()` is called directly on the tracker instance.
