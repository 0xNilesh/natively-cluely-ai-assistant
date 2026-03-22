# Mission

Build Live Salary Negotiation Coaching for Natively — a real-time AI coach that listens to the recruiter's words via system audio STT, tracks what offers and pushback have been made, and surfaces a coaching card with a tactical note and exact script the user can speak verbatim on the live call. The feature turns the app's existing static salary script into a dynamic, conversation-aware coach that adapts turn-by-turn to what the recruiter actually says.

# Codebase Context

- Electron + React + TypeScript app
- Working directory: /Users/evin/natively-cluely-ai-assistant
- Key existing files:
  - `premium/electron/knowledge/KnowledgeOrchestrator.ts`
  - `premium/electron/knowledge/IntentClassifier.ts`
  - `premium/electron/knowledge/ContextAssembler.ts`
  - `premium/electron/knowledge/SalaryIntelligenceEngine.ts`
  - `premium/electron/knowledge/NegotiationEngine.ts`
  - `electron/LLMHelper.ts`
  - `src/components/NativelyInterface.tsx`

# Quality Gate (run after EVERY section)

```bash
npx tsc --noEmit
npx tsc -p tsconfig.node.json --noEmit
```

Zero errors required before proceeding to the next section.

# Dependency Order

```
00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08
```

---

# SECTION 00: STT Routing Verification

**Status:** Prerequisite — must be completed before any code in sections 01–08 is written.

---

## Background

The entire Live Salary Negotiation Coaching feature depends on one foundational assumption: that recruiter speech captured via system audio is reaching `KnowledgeOrchestrator.feedInterviewerUtterance()`. If that path does not exist, every downstream component — `NegotiationConversationTracker`, `LiveNegotiationAdvisor`, and the coaching card UI — will never receive recruiter input, rendering the feature inert regardless of how well those components are implemented.

This section exists to confirm or deny that assumption against the actual codebase before any new code is written. It is an investigation-first, code-second section.

### Why recruiter speech is the critical input

The tracker's entire state machine (`INACTIVE → PROBE → ANCHOR → COUNTER → HOLD → PIVOT_BENEFITS → CLOSE`) is driven by what the recruiter says. Dollar amounts, pushback phrases, benefits pivots — all of these are extracted from the recruiter's STT transcript. If the tracker receives the user's own microphone input instead (or nothing at all), it will produce nonsensical phase transitions and the coaching advice will be wrong or absent.

---

## Architecture Context (from codebase research)

The app runs two parallel STT pipelines:

- `this.googleSTT` — system audio (interviewer/recruiter), fed by `SystemAudioCapture`
- `this.googleSTT_User` — microphone (user), fed by `MicrophoneCapture`

Both are wired in `electron/main.ts` inside `setupSystemAudioPipeline()`. Both STT instances emit a `'transcript'` event. When a transcript fires, `main.ts` sends it to the renderer windows via `webContents.send('native-audio-transcript', payload)` where `payload.speaker` is either `'interviewer'` or `'user'`.

The existing hook for `feedInterviewerUtterance()` is in `electron/LLMHelper.ts` inside `chatWithGemini()` (line ~744):

```typescript
// Inside chatWithGemini() — knowledge mode intercept
this.knowledgeOrchestrator.feedInterviewerUtterance(message);
```

**Critical finding from research:** The `message` parameter passed here is the user's own typed/spoken question submitted to the chat — NOT the recruiter's live system audio transcript. The name `feedInterviewerUtterance` is misleading: it currently feeds user speech as a proxy for "what the interviewer is asking about" to drive the TechnicalDepthScorer's tone calibration. It is not wired to the recruiter's STT output at all.

There is no existing main-process handler that calls `feedInterviewerUtterance()` with the system audio STT result.

---

## What to Investigate

### Step 1 — Trace system audio STT output in `electron/main.ts`

Read `electron/main.ts`. Locate `createSTTProvider()` and `setupSystemAudioPipeline()`. Confirm:

1. That `this.googleSTT` (the interviewer STT provider) emits `'transcript'` events with `speaker = 'interviewer'`.
2. Exactly what happens with those transcript events. The current code sends them to renderer windows via `webContents.send('native-audio-transcript', payload)`. Confirm no main-process handler calls `feedInterviewerUtterance()` with that text.

Search terms to use:
```
feedInterviewerUtterance
native-audio-transcript
system-audio-transcript
stt-result
interviewer-speech
interviewer.*transcript
transcript.*interviewer
```

### Step 2 — Trace the IPC chain in `electron/ipcHandlers.ts`

Read `electron/ipcHandlers.ts`. Search for any `safeHandle` registration that processes system audio or interviewer STT output and routes it to the knowledge orchestrator. Confirm whether any of the following exist:

- `safeHandle("native-audio-transcript", ...)`
- `safeHandle("system-audio-transcript", ...)`
- `safeHandle("stt-result", ...)`
- `safeHandle("interviewer-speech", ...)`
- Any other handler that receives a `speaker: 'interviewer'` payload and calls `orchestrator.feedInterviewerUtterance()`

### Step 3 — Check `streamChat()` in `electron/LLMHelper.ts`

Read `electron/LLMHelper.ts`. Locate `streamChat()` (line ~1791). Confirm whether the streaming knowledge mode intercept calls `feedInterviewerUtterance()`. Based on research it does NOT — the `chatWithGemini()` path calls it but `streamChat()` does not. Document this gap as it will need to be addressed in Section 04.

### Step 4 — Confirm speaker separation is correct

In `electron/main.ts`, confirm that system audio (`SystemAudioCapture`) writes only to `this.googleSTT` and that microphone (`MicrophoneCapture`) writes only to `this.googleSTT_User`. Confirm that the `speaker` field on the transcript payload correctly identifies `'interviewer'` for system audio and `'user'` for microphone. This separation must exist before the negotiation tracker can distinguish who spoke.

---

## Expected Findings

Based on the codebase research already done, the expected findings are:

| Question | Expected Answer |
|---|---|
| Does `googleSTT` (system audio) have `speaker = 'interviewer'`? | Yes — confirmed in `createSTTProvider()` |
| Does `googleSTT_User` (mic) have `speaker = 'user'`? | Yes — confirmed in `setupSystemAudioPipeline()` |
| Are transcripts sent to renderer via `native-audio-transcript`? | Yes — `webContents.send('native-audio-transcript', payload)` |
| Is there a main-process handler routing system audio STT to `feedInterviewerUtterance()`? | **No — this routing is missing** |
| Does `chatWithGemini()` call `feedInterviewerUtterance()` with user speech? | Yes (line ~744) — but `message` is the user's question, not recruiter speech |
| Does `streamChat()` call `feedInterviewerUtterance()` at all? | **No — also missing** |

The routing gap is: system audio STT transcripts (recruiter speech) reach the renderer as `native-audio-transcript` events, but there is no main-process path that feeds them to `KnowledgeOrchestrator.feedInterviewerUtterance()`.

---

## Outcome A — Routing Already Exists

If investigation reveals that a `safeHandle` or main-process listener already calls `orchestrator.feedInterviewerUtterance()` with interviewer STT text:

1. Document the exact file, line number, and event name.
2. Confirm the `speaker` filter is present (i.e., only `speaker === 'interviewer'` transcripts are passed through).
3. Confirm it uses final transcripts only (`segment.isFinal === true`), not partials.
4. Confirm the same call exists in the `streamChat()` path.
5. Record findings in a comment block at the top of this file and mark all acceptance criteria checked.
6. Proceed directly to Section 01.

---

## Outcome B — Routing is Missing (Expected)

If no main-process handler routes system audio STT to `feedInterviewerUtterance()`, add it. This is the expected state of the codebase.

### Where to add the routing

The routing belongs in `electron/main.ts` inside `createSTTProvider()`, in the `stt.on('transcript', ...)` handler — specifically in the branch that fires when `speaker === 'interviewer'` and `segment.isFinal === true`.

**Do not** add it in `ipcHandlers.ts` via a renderer-to-main IPC round-trip. The system audio transcript is already in the main process; routing it through the renderer and back would add unnecessary latency and complexity.

### Code to add in `electron/main.ts`

Locate the `stt.on('transcript', ...)` block inside `createSTTProvider()` (around line 652). Inside that handler, after the existing `intelligenceManager.handleTranscript()` call, add a guard for final interviewer transcripts:

```typescript
// Feed final recruiter (system audio) transcripts to negotiation tracker
if (segment.isFinal && speaker === 'interviewer') {
  const llmHelper = this.getLLMHelper?.();
  llmHelper?.feedInterviewerUtterance?.(segment.text);
}
```

Alternatively, if `LLMHelper` exposes `knowledgeOrchestrator` indirectly, call it directly:

```typescript
if (segment.isFinal && speaker === 'interviewer') {
  const orchestrator = appState.getKnowledgeOrchestrator?.();
  orchestrator?.feedInterviewerUtterance(segment.text);
}
```

Use whichever accessor is available at that call site. Do not guess — read the class structure at the point of insertion to determine which reference is in scope.

### Why final transcripts only

STT providers emit partial results every few hundred milliseconds as the recognizer refines its hypothesis. Feeding partials to the negotiation tracker would cause the same phrase to trigger multiple state transitions as the text changes. Only `segment.isFinal === true` results represent a complete, committed utterance.

### Also confirm the `streamChat()` gap

Section 04 (KnowledgeOrchestrator Integration) will add the `negotiationTracker.addRecruiterUtterance()` call inside `feedInterviewerUtterance()`. But the `streamChat()` path in `LLMHelper.ts` currently never calls `feedInterviewerUtterance()` at all. Note this gap here; it will be fixed in Section 04. Do not fix it in this section — the method being called does not yet do anything for negotiation until the tracker is wired in Section 04.

---

## Files to Read

| File | Purpose |
|---|---|
| `electron/main.ts` | Confirm STT pipeline wiring, find the `stt.on('transcript')` handler |
| `electron/ipcHandlers.ts` | Confirm no existing handler already routes recruiter STT to orchestrator |
| `electron/LLMHelper.ts` | Confirm `feedInterviewerUtterance()` call site in `chatWithGemini()` and its absence in `streamChat()` |
| `premium/electron/knowledge/KnowledgeOrchestrator.ts` | Confirm `feedInterviewerUtterance()` signature and what it currently does |

## Files to Modify (if routing is missing)

| File | Change |
|---|---|
| `electron/main.ts` | Add `feedInterviewerUtterance(segment.text)` call in `stt.on('transcript')` for `speaker === 'interviewer'` and `segment.isFinal === true` |

---

## Acceptance Criteria

- [ ] Investigator has read `createSTTProvider()` in `electron/main.ts` and confirmed the `stt.on('transcript', ...)` handler structure
- [ ] Investigator has confirmed that `googleSTT` uses `speaker = 'interviewer'` and `googleSTT_User` uses `speaker = 'user'`
- [ ] Investigator has searched `electron/ipcHandlers.ts` for any existing handler routing interviewer STT to `feedInterviewerUtterance()` and documented the result (exists / does not exist)
- [ ] Investigator has confirmed that `chatWithGemini()` at line ~744 calls `feedInterviewerUtterance(message)` with the user's question (not recruiter speech) — and documented this as the current (incorrect) behavior for negotiation purposes
- [ ] Investigator has confirmed that `streamChat()` does NOT call `feedInterviewerUtterance()` at all
- [ ] If routing was missing: a call to `feedInterviewerUtterance(segment.text)` has been added in `main.ts` gated on `speaker === 'interviewer' && segment.isFinal`
- [ ] If routing was missing: the change compiles with `tsc --noEmit` (zero errors)
- [ ] Findings are documented inline in this file (update the Expected Findings table with actual findings)
- [ ] Section 01 is unblocked — implementer can proceed

---

## Notes on Scope

This section does NOT:
- Implement `NegotiationConversationTracker` (that is Section 02)
- Modify `feedInterviewerUtterance()` to call the tracker (that is Section 04)
- Add any IPC handlers for negotiation state reads (that is Section 06)

The only deliverable is confirming that recruiter speech flows into `feedInterviewerUtterance()` in the main process, and adding the routing if it is absent. Everything else is out of scope for this section.

---

# SECTION 01: Types

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

---

# SECTION 02: NegotiationConversationTracker

## Overview

**File to create:** `premium/electron/knowledge/NegotiationConversationTracker.ts`

**Depends on:** Section 01 (Types) — `NegotiationPhase`, `NegotiationState`, `OfferEvent`, `OfferState` must exist in `premium/electron/knowledge/types.ts`

**Blocks:** Section 03 (LiveNegotiationAdvisor), Section 04 (KnowledgeOrchestrator Integration)

**Purpose:** Stateful turn-by-turn tracker that processes recruiter and user utterances, extracts dollar amounts via regex, detects negotiation signals (offers, pushback, rejection, acceptance, benefits, vague offers), and maintains a phase state machine. Mirrors the TechnicalDepthScorer pattern — same instantiation point in the orchestrator, same injection pattern.

---

## Prerequisites: Types (from Section 01)

The following types must exist in `premium/electron/knowledge/types.ts` before implementing this section:

```typescript
export type NegotiationPhase =
  | 'INACTIVE'
  | 'PROBE'
  | 'ANCHOR'
  | 'COUNTER'
  | 'HOLD'
  | 'PIVOT_BENEFITS'
  | 'CLOSE';

export interface OfferEvent {
  speaker: 'recruiter' | 'user';
  amount: number;
  currency: string;
  offerType: 'base' | 'total' | 'range_min' | 'range_max' | 'ceiling' | 'unknown';
  raw: string;
  timestamp: number;
  isVague: boolean;
}

export interface OfferState {
  latestRecruiterAmount: number | null;
  latestRecruiterCurrency: string;
  trajectory: 'rising' | 'flat' | 'first';
  allEvents: OfferEvent[];
}

export interface NegotiationState {
  phase: NegotiationPhase;
  offers: OfferState;
  userTarget: number | null;
  pushbackCount: number;
  benefitsMentioned: string[];
  vagueOfferDetected: boolean;
  silenceTimerActive: boolean;
  lastRecruiterSignal: 'offer' | 'pushback' | 'rejection' | 'acceptance' | 'vague' | 'benefits' | null;
}
```

---

## Full Implementation

Create `premium/electron/knowledge/NegotiationConversationTracker.ts` with the following complete content:

```typescript
import { NegotiationPhase, NegotiationState, OfferEvent, OfferState } from './types';

// ── Signal pattern constants ──────────────────────────────────

/**
 * Regex patterns for extracting salary amounts from natural speech.
 * Order matters: more specific patterns first.
 *
 * Pattern breakdown:
 *   1. $95,000 or $95k or $ 95k
 *   2. 95k or 130k (bare number + k suffix, no dollar sign)
 *   3. "between 90k and 110k" — captures both bounds
 *   4. "130k base" / "95k salary" / "100k comp"
 *   5. "budget is 95k" / "budget tops at 95k" / "budget caps out at 95"
 *   6. "offer is 95k" / "offering 95k" / "offer you 95k"
 */
const SALARY_PATTERNS: RegExp[] = [
  /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)[k]?/gi,
  /(\d{2,3})[k]\b/gi,
  /between\s+(\d{2,3})[k]?\s+and\s+(\d{2,3})[k]?/gi,
  /(\d{2,3})[k]?\s+(?:base|salary|comp|compensation|package)/gi,
  /budget\s+(?:is|tops?|caps?)\s+(?:at|out\s+at)?\s+(\d{2,3})[k]?/gi,
  /(?:offer|offering|offer you)\s+(?:is|of)?\s+(\d{2,3})[k]?/gi,
];

/**
 * Phrases indicating the recruiter is pushing back on the candidate's ask.
 * These are normal negotiation tactics — NOT final rejections.
 */
const PUSHBACK_SIGNALS: string[] = [
  'above our', 'beyond our', 'out of range', "can't go higher",
  "can't go above", 'budget is fixed', 'budget tops', 'best we can do',
  'highest we can go', 'max is', 'ceiling is',
];

/**
 * Phrases indicating a hard rejection or non-negotiable position.
 * Triggers PIVOT_BENEFITS phase.
 */
const REJECTION_SIGNALS: string[] = [
  'not possible', "won't work", 'decline', 'no flexibility',
  'take it or leave', 'final offer', 'non-negotiable',
];

/**
 * Phrases indicating the recruiter is moving toward agreement.
 * Triggers CLOSE phase.
 */
const ACCEPTANCE_SIGNALS: string[] = [
  "that works", "i'll get that approved", "let me send that",
  "we can do that", "let me confirm", "i can approve",
];

/**
 * Benefits and perks the recruiter may mention as alternatives to base salary.
 * Each matched signal is stored in benefitsMentioned for advisor context.
 */
const BENEFITS_SIGNALS: string[] = [
  'signing bonus', 'sign-on', 'equity', 'stock', 'rsu', 'options',
  'pto', 'vacation days', 'remote', 'work from home', 'wfh',
  'flexible', 'professional development', 'learning budget',
];

/**
 * Vague compensation language — recruiter acknowledges comp without naming a number.
 * Sets vagueOfferDetected = true so the advisor can prompt the candidate to get specifics.
 */
const VAGUE_SIGNALS: string[] = [
  'competitive', 'above market', 'market rate', 'industry standard',
  'in line with', 'within range', 'fair compensation',
];

/**
 * Context words required in the USER's utterance before the silence timer activates.
 * Guards against triggering the silence timer on incidental numbers (e.g., "I have 3 years of experience").
 * The user must be explicitly stating a salary ask.
 *
 * ERRATA Fix 4: addUserUtterance silence timer gating.
 */
const SALARY_CONTEXT_WORDS: string[] = [
  'targeting', 'asking', 'looking for', 'expect', 'want', 'need', 'require', 'range',
];

// ── Helper: normalize number to annual salary ─────────────────

/**
 * Normalizes a raw matched string to an annual salary integer.
 * Strips dollar signs, commas, and whitespace.
 * Numbers below 1000 are treated as thousands (e.g., "95" → 95000, "130" → 130000).
 */
function normalizeAmount(raw: string): number {
  const clean = raw.replace(/[$,\s]/g, '');
  const num = parseFloat(clean);
  return num < 1000 ? num * 1000 : num;
}

// ── Main class ────────────────────────────────────────────────

export class NegotiationConversationTracker {
  private state: NegotiationState;

  constructor() {
    this.state = this.initialState();
  }

  private initialState(): NegotiationState {
    return {
      phase: 'INACTIVE',
      offers: {
        latestRecruiterAmount: null,
        latestRecruiterCurrency: 'USD',
        trajectory: 'first',
        allEvents: [],
      },
      userTarget: null,
      pushbackCount: 0,
      benefitsMentioned: [],
      vagueOfferDetected: false,
      silenceTimerActive: false,
      lastRecruiterSignal: null,
    };
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Feed a recruiter (system audio STT) utterance into the tracker.
   *
   * Processing order (ERRATA Fix 9):
   *   1. INACTIVE → PROBE transition fires FIRST, before any signal extraction.
   *      This ensures the tracker is active before other phase transitions run.
   *   2. Extract salary amounts — may trigger ANCHOR or COUNTER phase.
   *   3. Detect pushback / rejection / acceptance / benefits / vague signals.
   *
   * @param text - Raw recruiter utterance from system audio STT
   */
  addRecruiterUtterance(text: string): void {
    const lower = text.toLowerCase();

    // ERRATA Fix 9: INACTIVE → PROBE is the FIRST operation.
    // Any recruiter speech activates the tracker, even without a number.
    if (this.state.phase === 'INACTIVE') {
      this.state.phase = 'PROBE';
    }

    // Extract salary amounts from recruiter speech
    const amounts = this.extractAmounts(text);
    for (const amount of amounts) {
      const event: OfferEvent = {
        speaker: 'recruiter',
        amount,
        currency: 'USD',
        offerType: 'base',
        raw: text,
        timestamp: Date.now(),
        isVague: false,
      };
      this.state.offers.allEvents.push(event);

      // Update trajectory
      const prev = this.state.offers.latestRecruiterAmount;
      this.state.offers.latestRecruiterAmount = amount;
      this.state.offers.trajectory = prev === null ? 'first' : amount > prev ? 'rising' : 'flat';

      // ERRATA Fix 5: pass 'new_offer' trigger so HOLD/PIVOT_BENEFITS can re-anchor to COUNTER
      this.transitionPhase('ANCHOR', 'new_offer');
    }

    // Signal detection — runs after amount extraction
    if (PUSHBACK_SIGNALS.some(s => lower.includes(s))) {
      this.state.pushbackCount++;
      this.state.lastRecruiterSignal = 'pushback';
      this.transitionPhase('HOLD');
      if (this.state.pushbackCount >= 2) {
        this.transitionPhase('PIVOT_BENEFITS');
      }
    } else if (REJECTION_SIGNALS.some(s => lower.includes(s))) {
      this.state.lastRecruiterSignal = 'rejection';
      this.transitionPhase('PIVOT_BENEFITS');
    } else if (ACCEPTANCE_SIGNALS.some(s => lower.includes(s))) {
      this.state.lastRecruiterSignal = 'acceptance';
      this.transitionPhase('CLOSE');
    } else if (amounts.length > 0) {
      this.state.lastRecruiterSignal = 'offer';
    }

    // Benefits detection — each unique signal stored
    for (const signal of BENEFITS_SIGNALS) {
      if (lower.includes(signal) && !this.state.benefitsMentioned.includes(signal)) {
        this.state.benefitsMentioned.push(signal);
        this.state.lastRecruiterSignal = 'benefits';
      }
    }

    // Vague offer detection — only when no specific number was stated
    if (VAGUE_SIGNALS.some(s => lower.includes(s)) && amounts.length === 0) {
      this.state.vagueOfferDetected = true;
      this.state.lastRecruiterSignal = 'vague';
    }
  }

  /**
   * Feed a user (microphone STT) utterance into the tracker.
   *
   * ERRATA Fix 4: Silence timer gating — the silence timer only activates when:
   *   1. The tracker is already active (isActive() === true) — guards against
   *      triggering before any negotiation has started.
   *   2. The user's utterance contains a salary amount.
   *   3. The utterance contains at least one salary context word (targeting, asking,
   *      looking for, expect, want, need, require, range) — prevents incidental
   *      numbers like "I have 5 years of experience" from triggering the timer.
   *
   * @param text - Raw user utterance from microphone STT
   */
  addUserUtterance(text: string): void {
    const lower = text.toLowerCase();
    const amounts = this.extractAmounts(text);

    if (amounts.length > 0) {
      // ERRATA Fix 4: require isActive() AND salary context words
      const hasSalaryContext = SALARY_CONTEXT_WORDS.some(w => lower.includes(w));

      if (this.isActive() && hasSalaryContext) {
        this.state.silenceTimerActive = true;

        // First number the user states becomes their target
        if (this.state.userTarget === null) {
          this.state.userTarget = amounts[0];
        }

        const event: OfferEvent = {
          speaker: 'user',
          amount: amounts[0],
          currency: 'USD',
          offerType: 'base',
          raw: text,
          timestamp: Date.now(),
          isVague: false,
        };
        this.state.offers.allEvents.push(event);

        // User countering after an anchor moves to COUNTER phase
        if (this.state.phase === 'ANCHOR') {
          this.transitionPhase('COUNTER');
        }
      }
    } else {
      // User spoke without stating a salary number — silence timer is no longer relevant
      this.state.silenceTimerActive = false;
    }
  }

  /**
   * Manually clear the silence timer (e.g., after the recruiter speaks again).
   */
  clearSilenceTimer(): void {
    this.state.silenceTimerActive = false;
  }

  /**
   * Returns a deep copy of the current negotiation state.
   *
   * ERRATA Fix 6: Deep copy — prevents external mutation of nested objects
   * (offers.allEvents array and benefitsMentioned array).
   */
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

  /**
   * Returns true once any negotiation signal has been received.
   * Used by KnowledgeOrchestrator to decide whether to activate the live coaching path.
   */
  isActive(): boolean {
    return this.state.phase !== 'INACTIVE';
  }

  /**
   * Resets the tracker to initial state.
   * Called when the user uploads a new JD or explicitly resets the session.
   */
  reset(): void {
    this.state = this.initialState();
  }

  /**
   * Seeds the user's salary target from the pre-computed negotiation script.
   * Called during KnowledgeOrchestrator.refreshCache() when the script is loaded.
   * Important: must be called before the first recruiter utterance so the advisor
   * has target context even before the user speaks.
   *
   * @param amount - Normalized annual amount (e.g., 130000)
   */
  setUserTarget(amount: number): void {
    this.state.userTarget = amount;
  }

  /**
   * Returns an XML-formatted string of the current negotiation state for LLM injection.
   * Called by LiveNegotiationAdvisor to build the prompt context block.
   *
   * Format is XML so the LLM can parse it reliably and so it is visually distinct
   * from the surrounding natural language in the prompt.
   */
  getStateXML(): string {
    const s = this.state;
    const offerHistory = s.offers.allEvents
      .map(e =>
        `  - ${e.speaker === 'recruiter' ? 'Recruiter' : 'You'}: ${e.currency} ${(e.amount / 1000).toFixed(0)}k (${e.raw.substring(0, 60)})`
      )
      .join('\n');

    return `<live_negotiation_state>
Phase: ${s.phase}
Their latest offer: ${s.offers.latestRecruiterAmount
      ? `${s.offers.latestRecruiterCurrency} ${s.offers.latestRecruiterAmount.toLocaleString()}`
      : 'Not stated yet'}
Your target: ${s.userTarget
      ? `${s.offers.latestRecruiterCurrency} ${s.userTarget.toLocaleString()}`
      : 'Not stated yet'}
Pushback count: ${s.pushbackCount}
Benefits mentioned by recruiter: ${s.benefitsMentioned.length > 0 ? s.benefitsMentioned.join(', ') : 'None'}
Vague offer detected: ${s.vagueOfferDetected}
Last recruiter signal: ${s.lastRecruiterSignal || 'none'}
Offer history:
${offerHistory || '  (no offers yet)'}
</live_negotiation_state>`;
  }

  // ── Private methods ───────────────────────────────────────────

  /**
   * Extracts and normalizes all salary amounts from a text string.
   * Applies all SALARY_PATTERNS, deduplicates by amount value, and filters
   * out implausible salaries (below $20k or above $5M).
   *
   * For range patterns (e.g., "between 90k and 110k"), both bounds are extracted.
   *
   * @param text - Raw utterance (any speaker)
   * @returns Array of unique, plausible annual salary amounts
   */
  private extractAmounts(text: string): number[] {
    const amounts: number[] = [];
    const seen = new Set<number>();

    for (const pattern of SALARY_PATTERNS) {
      // Clone the regex to reset lastIndex on each call (avoids stateful regex bugs)
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        // match[1] is the first capture group; match[0] is the full match
        const raw = match[1] || match[0];
        const amount = normalizeAmount(raw);

        // Filter implausible salaries
        if (amount >= 20000 && amount <= 5000000 && !seen.has(amount)) {
          seen.add(amount);
          amounts.push(amount);
        }

        // For range patterns, also extract the second bound (match[2])
        if (match[2]) {
          const amount2 = normalizeAmount(match[2]);
          if (amount2 >= 20000 && amount2 <= 5000000 && !seen.has(amount2)) {
            seen.add(amount2);
            amounts.push(amount2);
          }
        }
      }
    }

    return amounts;
  }

  /**
   * Transitions the phase state machine to a new phase.
   *
   * ERRATA Fix 5: The state machine supports two modes:
   *
   * 1. Normal forward-only progression (default):
   *    INACTIVE → PROBE → ANCHOR → COUNTER → HOLD → PIVOT_BENEFITS → CLOSE
   *    A phase can only advance; it cannot move backward.
   *    CLOSE is always terminal — nothing can overwrite it.
   *
   * 2. Re-anchoring on new recruiter offer (trigger === 'new_offer'):
   *    If the recruiter makes a NEW offer while the phase is HOLD or PIVOT_BENEFITS,
   *    the phase resets to COUNTER. This models the real-world scenario where the
   *    recruiter comes back with an improved offer after pushback.
   *
   * @param to      - Target phase
   * @param trigger - 'new_offer' enables re-anchoring from HOLD/PIVOT_BENEFITS;
   *                  'signal' (default) uses forward-only rules
   */
  private transitionPhase(to: NegotiationPhase, trigger?: 'new_offer' | 'signal'): void {
    // CLOSE is always terminal — nothing overwrites it
    if (this.state.phase === 'CLOSE') return;

    // ERRATA Fix 5: New offer from recruiter re-activates COUNTER from HOLD or PIVOT_BENEFITS
    if (
      trigger === 'new_offer' &&
      (this.state.phase === 'HOLD' || this.state.phase === 'PIVOT_BENEFITS')
    ) {
      this.state.phase = 'COUNTER';
      return;
    }

    // Normal forward-only progression
    const order: NegotiationPhase[] = [
      'INACTIVE', 'PROBE', 'ANCHOR', 'COUNTER', 'HOLD', 'PIVOT_BENEFITS', 'CLOSE',
    ];
    const currentIdx = order.indexOf(this.state.phase);
    const targetIdx = order.indexOf(to);

    if (targetIdx > currentIdx) {
      this.state.phase = to;
    }
  }
}
```

---

## Phase State Machine — Reference

```
INACTIVE ──(any recruiter speech)──────────────────────────► PROBE
   │
   │ Note: INACTIVE → PROBE fires at the TOP of addRecruiterUtterance,
   │ before any signal extraction. (ERRATA Fix 9)

PROBE ──(recruiter states number)──────────────────────────► ANCHOR
                                                               │
ANCHOR ──(user counters with number)───────────────────────► COUNTER
                                                               │
COUNTER ──(recruiter pushback × 1)─────────────────────────► HOLD
                                                               │
HOLD ──(recruiter pushback × 2 total)──────────────────────► PIVOT_BENEFITS
    │                                                          │
    └──(recruiter new offer, trigger='new_offer')──────────► COUNTER  ← re-anchor (Fix 5)

PIVOT_BENEFITS ──(recruiter new offer, trigger='new_offer')► COUNTER  ← re-anchor (Fix 5)
              │
              └──(any acceptance signal)───────────────────► CLOSE

CLOSE (terminal — nothing overwrites)
```

---

## Acceptance Criteria

### Core Functionality

- [ ] `addRecruiterUtterance("our budget is around 95k")` → `phase === 'ANCHOR'`, `offers.latestRecruiterAmount === 95000`
- [ ] `addRecruiterUtterance("that's above our range")` → `pushbackCount === 1`, `phase === 'HOLD'`
- [ ] `addRecruiterUtterance("that's above our range")` called twice total → `pushbackCount === 2`, `phase === 'PIVOT_BENEFITS'`
- [ ] `addRecruiterUtterance("we can do equity and signing bonus")` → `benefitsMentioned` contains both `'equity'` and `'signing bonus'`
- [ ] `addUserUtterance("I'm targeting 130,000")` after recruiter has spoken → `silenceTimerActive === true`, `userTarget === 130000`
- [ ] Phase never moves backward via normal transitions (COUNTER → ANCHOR is blocked)
- [ ] `isActive()` returns `false` until first recruiter utterance is processed
- [ ] `reset()` restores all initial state
- [ ] `getStateXML()` produces valid XML containing all fields

### ERRATA Fix 4: Silence Timer Gating

- [ ] `addUserUtterance("I have 130 clients")` → `silenceTimerActive` remains `false` (no salary context word)
- [ ] `addUserUtterance("I'm targeting $130k")` before any recruiter speech → `silenceTimerActive` remains `false`
- [ ] `addUserUtterance("I'm targeting $130k")` after recruiter has spoken → `silenceTimerActive === true`

### ERRATA Fix 5: Re-anchoring on New Offer

- [ ] After `phase === 'HOLD'`, calling `addRecruiterUtterance("we can do 100k")` → `phase === 'COUNTER'`
- [ ] After `phase === 'PIVOT_BENEFITS'`, calling `addRecruiterUtterance("let me offer 105k")` → `phase === 'COUNTER'`
- [ ] After `phase === 'CLOSE'`, any new offer → `phase` remains `'CLOSE'`

### ERRATA Fix 6: Deep Copy in getState()

- [ ] Mutating the array returned by `getState().offers.allEvents` does not affect internal tracker state
- [ ] Mutating the array returned by `getState().benefitsMentioned` does not affect internal tracker state

### ERRATA Fix 9: PROBE Transition Ordering

- [ ] `addRecruiterUtterance("can we schedule the final interview?")` (no salary content) → `phase === 'PROBE'`
- [ ] After `addRecruiterUtterance("our budget is 95k")`, `phase === 'ANCHOR'` (PROBE → ANCHOR in same call)

---

# SECTION 03: LiveNegotiationAdvisor

**File to create:** `premium/electron/knowledge/LiveNegotiationAdvisor.ts`

**Depends on:** Section 01 (types in `types.ts`), Section 02 (`NegotiationConversationTracker`)

**Blocks:** Section 04 (KnowledgeOrchestrator integration)

---

## Purpose

Single exported async function. Receives the live tracker **instance** (not a plain state struct), all available context (resume doc, JD doc, company dossier, pre-computed negotiation script), and a `generateContentFn` abstraction. Returns a `LiveCoachingResponse` with a tactical note and an exact script the user can speak verbatim.

Key design decisions:
- The tracker **instance** is passed in so `tracker.getStateXML()` can be called directly inside the template literal — eliminating the broken `${state_xml_here}` placeholder from the original plan (ERRATA Fix 2).
- A 5-second `Promise.race` timeout wraps the LLM call. If the LLM times out or throws, the function falls back to the pre-computed negotiation script rather than hanging the UI (ERRATA Fix 10).
- `NegotiationScript` is imported from `./NegotiationEngine` (where it is defined), not from `./types`.

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
 * directly inside the prompt template literal. (ERRATA Fix 2)
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

## Acceptance Criteria

- [ ] `generateLiveCoachingResponse` is a named export from `premium/electron/knowledge/LiveNegotiationAdvisor.ts`
- [ ] Function signature accepts `tracker: NegotiationConversationTracker` as the first parameter (not `NegotiationState`)
- [ ] `tracker.getStateXML()` is called directly in the template literal — no `${state_xml_here}` placeholder
- [ ] Returned object has `isNegotiationCoaching: true` (literal `true`, not a boolean variable)
- [ ] `tacticalNote` is always a non-empty string (either LLM output or fallback)
- [ ] `exactScript` is always a non-empty string (either LLM output or fallback)
- [ ] LLM call is wrapped in `Promise.race` with a 5-second timeout
- [ ] On LLM timeout, JSON parse failure, or any thrown error: fallback response is returned, error is logged with `console.error`
- [ ] All 7 `NegotiationPhase` keys are present in `PHASE_INSTRUCTIONS`
- [ ] File compiles with `tsc --noEmit` — zero type errors
- [ ] `NegotiationScript` is imported from `./NegotiationEngine`, not from `./types`

---

# SECTION 04: KnowledgeOrchestrator Integration

**Files modified:**
- `premium/electron/knowledge/KnowledgeOrchestrator.ts`
- `electron/LLMHelper.ts`

**Depends on:** Section 01 (Types), Section 02 (Tracker), Section 03 (Advisor), Section 05 (ContextAssembler)

---

## Overview

This section wires the `NegotiationConversationTracker` and `LiveNegotiationAdvisor` into the existing orchestrator pipeline. The live negotiation path short-circuits the normal LLM flow: when the tracker is active and a NEGOTIATION intent is detected, the advisor generates a `LiveCoachingResponse` directly and returns it via `liveNegotiationResponse` in the `PromptAssemblyResult`. `LLMHelper` detects this field and yields a special token instead of calling the LLM again.

---

## 4a. Imports and Private Field

In `KnowledgeOrchestrator.ts`, add the following imports alongside existing imports at the top of the file:

```typescript
import { NegotiationConversationTracker } from './NegotiationConversationTracker';
import { generateLiveCoachingResponse } from './LiveNegotiationAdvisor';
```

Add the private field alongside the other private fields (approximately line 35):

```typescript
private negotiationTracker: NegotiationConversationTracker;
```

In the constructor, after other field initializations (approximately line 43):

```typescript
this.negotiationTracker = new NegotiationConversationTracker();
```

---

## 4b. Seed User Target from Negotiation Script in `refreshCache()`

After the negotiation script is loaded from the DB or AOT pipeline in `refreshCache()`, seed the tracker's user target:

```typescript
const script = this.getNegotiationScript();
if (script?.salary_range?.max) {
  this.negotiationTracker.setUserTarget(script.salary_range.max);
}
```

---

## 4c. Wire `feedInterviewerUtterance`

Find the existing `feedInterviewerUtterance` method. Add the tracker call immediately after `this.depthScorer.addUtterance(text)`:

```typescript
feedInterviewerUtterance(text: string): void {
  this.depthScorer.addUtterance(text);
  // NEW: Feed recruiter speech into negotiation tracker
  this.negotiationTracker.addRecruiterUtterance(text);
}
```

---

## 4d. Wire User Utterances in `processQuestion()`

Near the top of `processQuestion()`, before the intent detection check, add:

```typescript
// Feed user's question to tracker for user-side number detection (silence timer)
this.negotiationTracker.addUserUtterance(question);
```

---

## 4e. Live Negotiation Path in `processQuestion()` — CRITICAL (ERRATA Fix 1)

**WARNING:** Do NOT return `JSON.stringify(coachingResponse)` as `contextBlock`. This causes a double LLM call which destroys the coaching data. Use the `liveNegotiationResponse` field on `PromptAssemblyResult`.

In the `NEGOTIATION` intent handler block, add the live path BEFORE the existing static fallback:

```typescript
if (intent === IntentType.NEGOTIATION) {
  // Live negotiation path: only when tracker has seen recruiter speech
  if (this.negotiationTracker.isActive()) {
    // Null guards (Fix 7)
    if (!this.activeResume) return null;
    if (!this.generateContentFn) return null;

    const dossier = this.activeJD
      ? this.companyResearch.getCachedDossier(
          (this.activeJD.structured_data as StructuredJD).company || ''
        )
      : null;
    const script = this.getNegotiationScript();

    const coachingResponse = await generateLiveCoachingResponse(
      this.negotiationTracker,   // Pass tracker INSTANCE (Fix 2 — not .getState())
      question,
      this.activeResume,
      this.activeJD,
      dossier,
      script,
      this.generateContentFn
    );

    // Return with liveNegotiationResponse — NOT contextBlock (Fix 1)
    return {
      systemPromptInjection: '',
      contextBlock: '',
      isIntroQuestion: false,
      liveNegotiationResponse: coachingResponse,
    };
  }

  // Fallback: existing static salary_intelligence injection — unchanged
  // ...existing code continues here...
}
```

---

## 4f. Short-Circuit in `LLMHelper.streamChat()` and `chatWithGemini()`

In `electron/LLMHelper.ts`, in both `streamChat()` and `chatWithGemini()`, find the point where `knowledgeResult` is used and add the short-circuit before any LLM call:

```typescript
// Short-circuit: if coaching response is pre-computed, emit it directly
if (knowledgeResult?.liveNegotiationResponse) {
  const data = knowledgeResult.liveNegotiationResponse;
  yield JSON.stringify({ __negotiationCoaching: data });
  return;
}
```

---

## 4g. New Public Methods

Add these two public methods to `KnowledgeOrchestrator`:

```typescript
getNegotiationTracker(): NegotiationConversationTracker {
  return this.negotiationTracker;
}

resetNegotiationSession(): void {
  this.negotiationTracker.reset();
}
```

---

## 4h. Reset Tracker on JD Delete or Replace

In `deleteDocumentsByType()` and any code path where the active JD is replaced or cleared, add:

```typescript
this.negotiationTracker.reset();
```

---

## Acceptance Criteria

- [ ] `feedInterviewerUtterance("budget is 95k")` causes `negotiationTracker.getState().phase === 'ANCHOR'` and `latestRecruiterAmount === 95000`
- [ ] `processQuestion("what should I say?")` with active tracker returns an object with `liveNegotiationResponse` set and `contextBlock === ''`
- [ ] `processQuestion` without an active tracker falls through to existing static `salary_intelligence` injection — no regression
- [ ] No double LLM call: `streamChat` short-circuits when `liveNegotiationResponse` is present
- [ ] `streamChat` yields exactly one token: `JSON.stringify({ __negotiationCoaching: ... })` and then returns
- [ ] `chatWithGemini` applies the same short-circuit
- [ ] `resetNegotiationSession()` resets tracker to INACTIVE phase
- [ ] `getNegotiationTracker()` returns the live tracker instance
- [ ] Null guards prevent crash when `activeResume` is null or `generateContentFn` is undefined
- [ ] Tracker resets when JD is deleted or replaced
- [ ] `setUserTarget` is called with `script.salary_range.max` during `refreshCache()` when script is available

---

# SECTION 05: ContextAssembler Update

**File modified:** `premium/electron/knowledge/ContextAssembler.ts`

**Depends on:** Section 04 (KnowledgeOrchestrator Integration)

---

## Overview

Two additions to `ContextAssembler.ts`:

1. A new exported function `buildLiveNegotiationSystemPrompt()` that returns a system prompt string tuned for live negotiation coaching.
2. The `liveNegotiationResponse` field on the `PromptAssemblyResult` interface (carrier for `LiveCoachingResponse` through the pipeline without triggering a second LLM call).
3. A small helper `isLiveNegotiationContext()` used by the orchestrator to decide which system prompt to inject.

---

## 5a. Extend `PromptAssemblyResult` Interface

Find the `PromptAssemblyResult` interface in `ContextAssembler.ts` and add the optional field:

```typescript
interface PromptAssemblyResult {
  systemPromptInjection: string;
  contextBlock: string;
  isIntroQuestion: boolean;
  introResponse?: string;
  liveNegotiationResponse?: LiveCoachingResponse;  // ← ADD THIS
}
```

Also add the import for `LiveCoachingResponse` at the top of the file if not already present:

```typescript
import { LiveCoachingResponse } from './types';
```

---

## 5b. Add `buildLiveNegotiationSystemPrompt()`

Add this exported function to `ContextAssembler.ts`:

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

---

## 5c. Add `isLiveNegotiationContext()` Helper

```typescript
export function isLiveNegotiationContext(trackerActive: boolean): boolean {
  return trackerActive;
}
```

---

## Acceptance Criteria

- [ ] `PromptAssemblyResult` interface compiles with `liveNegotiationResponse?: LiveCoachingResponse` field
- [ ] `LiveCoachingResponse` import resolves from `./types` with no TypeScript error
- [ ] `buildLiveNegotiationSystemPrompt()` returns a non-empty string containing "LIVE NEGOTIATION MODE"
- [ ] `isLiveNegotiationContext(true)` returns `true`, `isLiveNegotiationContext(false)` returns `false`
- [ ] No changes to any existing exports or interfaces — purely additive

---

# SECTION 06: IPC Handlers & Preload

**Files modified:**
- `electron/ipcHandlers.ts`
- `electron/preload.ts`
- `src/types/electron.d.ts`

**Depends on:** Section 04 (KnowledgeOrchestrator — `getNegotiationTracker()`, `resetNegotiationSession()`)

---

## Overview

Two new IPC handlers expose negotiation tracker state and reset capability to the renderer process. Both handlers follow the existing `safeHandle` pattern used throughout `ipcHandlers.ts`.

---

## 6a. New Handlers in `electron/ipcHandlers.ts`

Find the block of `profile:*` handlers and add:

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
    if (!orchestrator) return { success: false, error: 'Engine not ready' };
    orchestrator.resetNegotiationSession();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});
```

---

## 6b. Preload Additions in `electron/preload.ts`

Find the `contextBridge.exposeInMainWorld` call and add inside the exposed API object:

```typescript
profileGetNegotiationState: () =>
  ipcRenderer.invoke('profile:get-negotiation-state'),

profileResetNegotiation: () =>
  ipcRenderer.invoke('profile:reset-negotiation'),
```

---

## 6c. TypeScript Types in `src/types/electron.d.ts`

Find the renderer-facing API interface and add:

```typescript
profileGetNegotiationState: () => Promise<{
  success: boolean;
  state?: {
    phase: string;
    offers: {
      latestRecruiterAmount: number | null;
      latestRecruiterCurrency: string;
      trajectory: 'rising' | 'flat' | 'first';
      allEvents: Array<{
        speaker: 'recruiter' | 'user';
        amount: number;
        currency: string;
        offerType: string;
        raw: string;
        timestamp: number;
        isVague: boolean;
      }>;
    };
    userTarget: number | null;
    pushbackCount: number;
    benefitsMentioned: string[];
    vagueOfferDetected: boolean;
    silenceTimerActive: boolean;
    lastRecruiterSignal: string | null;
  };
  isActive?: boolean;
  error?: string;
}>;

profileResetNegotiation: () => Promise<{
  success: boolean;
  error?: string;
}>;
```

**Typing strategy:** Inline the shape rather than importing from the main-process types path — that would create a cross-boundary import.

---

## Acceptance Criteria

- [ ] `window.electronAPI.profileGetNegotiationState()` resolves in the renderer without TypeScript errors
- [ ] `window.electronAPI.profileResetNegotiation()` resolves in the renderer without TypeScript errors
- [ ] Calling `profileGetNegotiationState()` after recruiter utterances returns `isActive: true` and the correct phase
- [ ] Calling `profileResetNegotiation()` resets the tracker: a subsequent call returns `isActive: false`
- [ ] Both handlers return `{ success: false, error: 'Engine not ready' }` when orchestrator is not yet initialized
- [ ] No existing profile handlers are modified

---

# SECTION 07: NegotiationCoachingCard UI

**File created:** `src/components/NegotiationCoachingCard.tsx`

**Depends on:** Section 01 (Types — but `NegotiationPhase` is defined inline per Fix 8)

---

## Overview

A visually distinct inline chat card that renders when a `LiveCoachingResponse` is detected in the stream. It shows the negotiation phase badge, their offer vs. your target, a tactical note, the exact script the user should speak, a copy button, and an optional 5-second silence timer.

**ERRATA Notes:**
- **Fix 8:** Do NOT `import { NegotiationPhase } from '../types/negotiation'` — that path does not exist. Define the type inline.
- **Fix 11:** Do NOT call `onSilenceTimerEnd` from inside the `setSilenceSeconds` setState updater. Use a separate `setTimeout` with a ref guard.

---

## Full Implementation

```typescript
import React, { useState, useEffect } from 'react';
import { Copy, Check, TrendingUp, Clock } from 'lucide-react';

// Fix 8: Define inline — do NOT import from a non-existent path
type NegotiationPhase =
  | 'INACTIVE'
  | 'PROBE'
  | 'ANCHOR'
  | 'COUNTER'
  | 'HOLD'
  | 'PIVOT_BENEFITS'
  | 'CLOSE';

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
  PROBE:          'bg-gray-500/15 text-gray-400 border-gray-500/25',
  ANCHOR:         'bg-blue-500/15 text-blue-400 border-blue-500/25',
  COUNTER:        'bg-orange-500/15 text-orange-400 border-orange-500/25',
  HOLD:           'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
  PIVOT_BENEFITS: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  CLOSE:          'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
};

const PHASE_LABELS: Record<string, string> = {
  PROBE:          'Gathering Intel',
  ANCHOR:         'First Offer',
  COUNTER:        'Countering',
  HOLD:           'Holding Position',
  PIVOT_BENEFITS: 'Total Comp',
  CLOSE:          'Closing',
};

export const NegotiationCoachingCard: React.FC<Props> = ({
  tacticalNote,
  exactScript,
  showSilenceTimer,
  phase,
  theirOffer,
  yourTarget,
  currency,
  onSilenceTimerEnd,
}) => {
  const [copied, setCopied] = useState(false);
  const [silenceSeconds, setSilenceSeconds] = useState(5);

  // Copy handler
  const handleCopy = () => {
    navigator.clipboard?.writeText(exactScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Fix 11: Silence timer — onSilenceTimerEnd called via separate setTimeout,
  // NOT inside setState updater, to avoid calling it during a React render cycle.
  useEffect(() => {
    if (!showSilenceTimer) return;

    const timerEndedRef = { current: false };
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

    // Call onSilenceTimerEnd via a separate timeout — NOT inside setState
    const endTimer = setTimeout(() => {
      if (!timerEndedRef.current) {
        timerEndedRef.current = true;
        onSilenceTimerEnd?.();
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      clearTimeout(endTimer);
    };
  }, [showSilenceTimer]); // onSilenceTimerEnd intentionally omitted — use ref pattern

  const phaseColor = PHASE_COLORS[phase] || PHASE_COLORS.ANCHOR;
  const gap = theirOffer && yourTarget ? yourTarget - theirOffer : null;

  return (
    <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 overflow-hidden my-2 text-sm">

      {/* Header row: phase badge + offer gap */}
      <div className="flex items-center justify-between px-3.5 pt-3 pb-2.5 border-b border-orange-500/10">
        <div className="flex items-center gap-2">
          <span
            className={`text-[9px] font-bold px-2 py-0.5 rounded-full border tracking-widest uppercase ${phaseColor}`}
          >
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
            <span className="text-red-400/80">
              {currency} {(theirOffer / 1000).toFixed(0)}k
            </span>
            <span className="mx-1.5 text-text-muted">→</span>
            <span className="text-emerald-400/80">
              {currency} {(yourTarget / 1000).toFixed(0)}k
            </span>
          </div>
        )}
      </div>

      {/* Silence timer (shown when user just named their number) */}
      {showSilenceTimer && silenceSeconds > 0 && (
        <div className="px-3.5 py-2.5 bg-yellow-500/5 border-b border-yellow-500/15 flex items-center gap-3">
          <Clock size={12} className="text-yellow-400 shrink-0" />
          <div className="flex-1">
            <div className="text-[10px] font-semibold text-yellow-400">
              Hold the silence. Let them speak first.
            </div>
            <div className="mt-1.5 h-1 rounded-full bg-yellow-500/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-yellow-400/60 transition-all duration-1000"
                style={{ width: `${(silenceSeconds / 5) * 100}%` }}
              />
            </div>
          </div>
          <span className="text-[13px] font-bold text-yellow-400 tabular-nums">
            {silenceSeconds}
          </span>
        </div>
      )}

      {/* Tactical note */}
      <div className="px-3.5 py-2.5 border-b border-orange-500/10">
        <div className="text-[9px] font-bold uppercase tracking-widest text-text-tertiary mb-1.5">
          Tactical Note
        </div>
        <p className="text-[11px] text-text-secondary leading-relaxed">
          {tacticalNote}
        </p>
      </div>

      {/* Exact script + copy button */}
      <div className="px-3.5 py-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[9px] font-bold uppercase tracking-widest text-orange-400">
            Say This
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[9px] font-medium text-text-tertiary hover:text-text-primary transition-colors px-2 py-0.5 rounded hover:bg-bg-input"
          >
            {copied
              ? <Check size={9} className="text-emerald-400" />
              : <Copy size={9} />
            }
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

---

## Acceptance Criteria

- [ ] Card renders with phase badge using the correct color for each phase value
- [ ] Offer gap line appears only when `theirOffer` and `yourTarget` are both non-null and `yourTarget > theirOffer`
- [ ] Copy button copies `exactScript` to clipboard and shows `Check` icon for 2 seconds, then reverts
- [ ] Silence timer section renders when `showSilenceTimer` is `true` and `silenceSeconds > 0`
- [ ] Progress bar drains from 100% to 0% over 5 seconds
- [ ] `onSilenceTimerEnd` is called once, approximately 5 seconds after mount with `showSilenceTimer: true`
- [ ] `onSilenceTimerEnd` is NOT called from inside a React setState updater (Fix 11 satisfied)
- [ ] `NegotiationPhase` is defined inline — no import from `../types/negotiation` (Fix 8 satisfied)
- [ ] Component compiles with `tsc --noEmit` with zero errors

---

# SECTION 08: NativelyInterface Integration

**File modified:** `src/components/NativelyInterface.tsx`

**Depends on:** Section 04 (stream token format), Section 06 (IPC types), Section 07 (NegotiationCoachingCard)

---

## Overview

`NativelyInterface.tsx` receives streamed tokens from the LLM layer. When the live negotiation path fires, `LLMHelper` emits exactly one token: `{ __negotiationCoaching: LiveCoachingResponse }`. This section makes the interface detect that token and render `NegotiationCoachingCard` in place of normal markdown.

---

## 8a. Import NegotiationCoachingCard

```typescript
import { NegotiationCoachingCard } from './NegotiationCoachingCard';
```

---

## 8b. Extend the Message Type

Find the local message type definition and add:

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

Use `phase: string` (not the `NegotiationPhase` union) to avoid a cross-boundary import.

---

## 8c. Detect `__negotiationCoaching` in the Stream Token Handler

Find the handler where individual stream tokens are appended to the current message's `text` field. Add before appending:

```typescript
const handleStreamToken = (token: string) => {
  // Check for negotiation coaching short-circuit token
  try {
    const parsed = JSON.parse(token);
    if (parsed?.__negotiationCoaching) {
      const data = parsed.__negotiationCoaching;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'system') return prev;
        return [
          ...prev.slice(0, -1),
          {
            ...lastMsg,
            isStreaming: false,
            isNegotiationCoaching: true,
            negotiationCoachingData: {
              tacticalNote: data.tacticalNote,
              exactScript: data.exactScript,
              showSilenceTimer: data.showSilenceTimer,
              phase: data.phase,
              theirOffer: data.theirOffer,
              yourTarget: data.yourTarget,
              currency: data.currency,
            },
            text: '', // Clear raw text so no JSON leaks into markdown render
          },
        ];
      });
      return; // Do NOT append to text
    }
  } catch {
    // Not JSON — fall through to normal text append
  }

  // Normal token: append to current streaming message
  setMessages(prev => {
    const lastMsg = prev[prev.length - 1];
    if (!lastMsg || lastMsg.role !== 'system') return prev;
    return [
      ...prev.slice(0, -1),
      { ...lastMsg, text: lastMsg.text + token },
    ];
  });
};
```

---

## 8d. Render NegotiationCoachingCard in the Message List

Find the message rendering loop. Before the existing text/markdown render path, add:

```typescript
{messages.map((msg, index) => (
  <div key={index} /* ... existing classes ... */>
    {msg.isNegotiationCoaching && msg.negotiationCoachingData ? (
      <NegotiationCoachingCard
        tacticalNote={msg.negotiationCoachingData.tacticalNote}
        exactScript={msg.negotiationCoachingData.exactScript}
        showSilenceTimer={msg.negotiationCoachingData.showSilenceTimer}
        phase={msg.negotiationCoachingData.phase as any}
        theirOffer={msg.negotiationCoachingData.theirOffer}
        yourTarget={msg.negotiationCoachingData.yourTarget}
        currency={msg.negotiationCoachingData.currency}
        onSilenceTimerEnd={() => {
          setMessages(prev =>
            prev.map(m =>
              m === msg
                ? {
                    ...m,
                    negotiationCoachingData: {
                      ...m.negotiationCoachingData!,
                      showSilenceTimer: false,
                    },
                  }
                : m
            )
          );
        }}
      />
    ) : (
      // ... existing markdown/text render for this message ...
    )}
  </div>
))}
```

---

## Acceptance Criteria

- [ ] When a `{ __negotiationCoaching: ... }` token arrives in the stream, a `NegotiationCoachingCard` renders in place of the raw JSON
- [ ] The `NegotiationCoachingCard` shows the correct phase badge, their offer, your target, tactical note, and exact script
- [ ] Regular streamed messages (non-negotiation) continue to render as markdown — no regression
- [ ] The silence timer shows when `showSilenceTimer: true` in the coaching data
- [ ] After 5 seconds, `onSilenceTimerEnd` fires and the timer row disappears
- [ ] No TypeScript errors on the extended message type or the `NegotiationCoachingCard` prop spread
- [ ] `phase as any` cast is the only type cast added — no broader type suppressions
- [ ] The raw JSON token text does not appear in the chat as a regular message

---

# Execution Rules

1. Implement sections in order 00 → 08. Never skip.
2. After each section: run both tsc commands. Fix ALL errors before continuing.
3. Check every acceptance criteria checkbox before moving to the next section.
4. Do not modify files outside the scope listed in each section.
5. After all 9 sections: run final tsc check and confirm zero errors.

<promise>ALL-SECTIONS-COMPLETE</promise>
