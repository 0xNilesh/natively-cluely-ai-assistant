# Section 01 — Types

**Feature:** Live Salary Negotiation Coaching
**Section:** 01 of 08
**Depends on:** Section 00 (STT Routing Verification) — no code dependency, sequencing only
**Blocks:** Sections 02, 03, 04, 07

---

## Background

Natively is an Electron desktop app that provides real-time AI coaching during job interviews. The user runs it as a floating overlay while on a video call. It captures system audio (recruiter) and microphone (user) via speech-to-text, then provides live guidance through a chat interface.

The existing codebase has a static salary negotiation script that is computed ahead of time from the user's resume, job description, and company dossier. That script is injected as a fixed block regardless of what the recruiter actually says during the call. If the recruiter says "our budget is $95k", the app currently has no awareness of it.

This section lays the **type foundation** for the Live Salary Negotiation Coaching feature. All downstream sections (tracker, advisor, orchestrator, UI) import from this file. Nothing in the feature compiles without these types being in place first.

### What the feature does (summary for context)

1. Automatically tracks what the recruiter offers in real-time via system audio STT
2. Detects the negotiation phase (first offer, pushback, benefits pivot, etc.)
3. Generates a tactical note and an exact script tailored to the current moment
4. Renders a visually distinct coaching card inline in the chat
5. Shows a 5-second silence timer when the user names their number (a core negotiation tactic)

---

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `premium/electron/knowledge/types.ts` | Modify | Add 5 new exported types at the end of the file |
| `premium/electron/knowledge/ContextAssembler.ts` | Modify | Extend `PromptAssemblyResult` with optional `liveNegotiationResponse` field |

---

## Current State of Target Files

### `premium/electron/knowledge/types.ts`

The file ends at line 293 with the `IntentType` enum (the last declaration in the file):

```typescript
export enum IntentType {
    TECHNICAL = 'technical',
    INTRO = 'intro',
    COMPANY_RESEARCH = 'company_research',
    NEGOTIATION = 'negotiation',
    PROFILE_DETAIL = 'profile_detail',
    GENERAL = 'general'
}
```

The new types must be appended **after** this closing brace.

### `premium/electron/knowledge/ContextAssembler.ts`

The `PromptAssemblyResult` interface is declared at the top of the file (lines 7–12) and currently has four fields:

```typescript
export interface PromptAssemblyResult {
    systemPromptInjection: string;
    contextBlock: string;
    isIntroQuestion: boolean;
    introResponse?: string;
}
```

A fifth optional field must be added to this interface.

---

## Changes to Make

### Change 1 — Append new types to `premium/electron/knowledge/types.ts`

Append the following block to the **end of the file**, after the closing brace of the `IntentType` enum. Add one blank line as a separator before the new block.

```typescript

// ============================================
// Live Salary Negotiation Coaching Types
// ============================================

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

### Change 2 — Extend `PromptAssemblyResult` in `premium/electron/knowledge/ContextAssembler.ts`

This change comes from **ERRATA Fix 1** in the plan. The fix addresses a critical architectural flaw: without this field, the orchestrator would be forced to serialize `LiveCoachingResponse` as JSON into `contextBlock`, which would then be fed into a second LLM call and destroyed.

The correct approach is to carry the coaching response as a typed field through `PromptAssemblyResult`, letting the LLM layer detect it and short-circuit before any LLM call is made.

Add the import and the new field as follows.

**Step A — Add import to `ContextAssembler.ts`**

The existing import line at the top of the file is:

```typescript
import { KnowledgeStatus, ScoredNode, DocType, KnowledgeDocument, StructuredResume, StructuredJD } from './types';
```

Replace it with:

```typescript
import { KnowledgeStatus, ScoredNode, DocType, KnowledgeDocument, StructuredResume, StructuredJD, LiveCoachingResponse } from './types';
```

**Step B — Extend `PromptAssemblyResult`**

Replace the current interface:

```typescript
export interface PromptAssemblyResult {
    systemPromptInjection: string;
    contextBlock: string;
    isIntroQuestion: boolean;
    introResponse?: string;
}
```

With:

```typescript
export interface PromptAssemblyResult {
    systemPromptInjection: string;
    contextBlock: string;
    isIntroQuestion: boolean;
    introResponse?: string;
    liveNegotiationResponse?: LiveCoachingResponse;  // Short-circuits LLM call for negotiation coaching
}
```

---

## Type Design Notes

### `NegotiationPhase` — why a string union not an enum

Using a string union (`type NegotiationPhase = 'INACTIVE' | 'PROBE' | ...`) rather than an `enum` matches the existing pattern in `types.ts` for domain-specific string sets (see `ToneDirective`, `JDLevel`, `EmploymentType`). String unions serialize naturally to JSON (enums require a reverse-mapping lookup), which matters when `NegotiationState` is transmitted over IPC in Section 06.

### `OfferEvent.isVague` — why a boolean not a separate phase

Vague offers ("competitive", "above market") do NOT advance the phase to `ANCHOR` because there is no number to anchor to. The `isVague` flag on `OfferEvent` lets the tracker record that _something_ was said about compensation without triggering the phase transition. The phase stays at `PROBE` until a concrete number appears.

### `LiveCoachingResponse.isNegotiationCoaching: true` — literal type discriminator

The field is typed as the literal `true` (not `boolean`). This means TypeScript can narrow a union type to `LiveCoachingResponse` purely by checking `obj.isNegotiationCoaching === true`, with no runtime casting required. The UI in Section 07 and Section 08 rely on this discriminator to decide whether to render a `NegotiationCoachingCard` or the standard response card.

### `PromptAssemblyResult.liveNegotiationResponse` — the short-circuit field (ERRATA Fix 1)

When the orchestrator (Section 04) detects a negotiation event, it calls `LiveNegotiationAdvisor` to produce a `LiveCoachingResponse` and then returns a `PromptAssemblyResult` with:
- `systemPromptInjection: ''`
- `contextBlock: ''`
- `isIntroQuestion: false`
- `liveNegotiationResponse: <the coaching response>`

In `LLMHelper.streamChat()` (and `chatWithGemini`), the knowledge intercept checks for this field **before** making any LLM call:

```typescript
if (knowledgeResult.liveNegotiationResponse) {
  // Short-circuit: yield the coaching data as a special token
  yield JSON.stringify({ __negotiationCoaching: knowledgeResult.liveNegotiationResponse });
  return;
}
```

The renderer detects `__negotiationCoaching` in the streamed token and renders the coaching card directly — no second LLM call, no JSON destruction. This wiring happens in Sections 04 and 08; this section only establishes the type contract.

---

## Acceptance Criteria

- [ ] `NegotiationPhase` is exported from `premium/electron/knowledge/types.ts` as a string union with exactly 7 members: `INACTIVE`, `PROBE`, `ANCHOR`, `COUNTER`, `HOLD`, `PIVOT_BENEFITS`, `CLOSE`
- [ ] `OfferEvent` is exported with all 7 fields at the specified types
- [ ] `OfferState` is exported with `latestRecruiterAmount: number | null`, `latestRecruiterCurrency: string`, `trajectory: 'rising' | 'flat' | 'first'`, `allEvents: OfferEvent[]`
- [ ] `NegotiationState` is exported with all 8 fields including `lastRecruiterSignal` as the specified union or `null`
- [ ] `LiveCoachingResponse` is exported with `isNegotiationCoaching: true` (literal `true`, not `boolean`)
- [ ] `PromptAssemblyResult` in `ContextAssembler.ts` has the new optional field `liveNegotiationResponse?: LiveCoachingResponse`
- [ ] `LiveCoachingResponse` is imported in `ContextAssembler.ts` from `./types`
- [ ] All pre-existing types in `types.ts` are **unchanged** (no field renames, no removals)
- [ ] `tsc --noEmit` reports **zero TypeScript errors** across the entire project after these changes
- [ ] No other files are modified in this section

---

## Zero TypeScript Errors Requirement

Run the following from the repo root after making the changes:

```bash
npx tsc --noEmit
```

Expected output: no output (zero errors). If errors appear:

1. **"Cannot find name 'LiveCoachingResponse'"** in `ContextAssembler.ts` — the import in Step A was not applied or was applied with a typo. Check the import line exactly.
2. **"Property 'liveNegotiationResponse' does not exist on type 'PromptAssemblyResult'"** in downstream files — the interface extension in Step B was not applied. Check the exact field name and type.
3. **"Type 'true' is not assignable to type 'boolean'"** at a call site — a caller is constructing `LiveCoachingResponse` with `isNegotiationCoaching: true` which is correct. If the error appears at a narrowing site, ensure you are using `=== true` not just a truthiness check.
4. Any errors in files that import `NegotiationPhase`, `NegotiationState`, etc. — these indicate a typo in one of the export names. Cross-check the exact spelling above.

Do **not** proceed to Section 02 until `tsc --noEmit` is clean.
