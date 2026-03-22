# Critical Architecture Review — Live Salary Negotiation Coaching
## Reviewer: Senior Software Architect
## Date: 2026-03-20
## Plan: `planning/live-negotiation/claude-plan.md`

---

## Executive Summary

The plan is well-structured and addresses a real product gap. The core ideas — a stateful phase tracker, a live LLM advisor, and a visually distinct coaching card — are sound. However, there are several correctness bugs in the proposed code, a critical type-system mismatch that would break the existing data flow, underspecified STT routing that is the most important integration point in the whole feature, and performance risks that could push latency well past the 3-second budget. These issues require resolution before implementation begins.

Overall verdict: **Do not implement as written.** Fix the 5 issues flagged as critical before any code is written.

---

## 1. Technical Correctness

### 1a. CRITICAL — `processQuestion()` return type mismatch

`processQuestion()` currently returns `Promise<PromptAssemblyResult | null>`, where `PromptAssemblyResult` is defined as:

```typescript
export interface PromptAssemblyResult {
  systemPromptInjection: string;
  contextBlock: string;
  isIntroQuestion: boolean;
  introResponse?: string;
}
```

The plan proposes returning an object with `isLiveNegotiationCoaching: true` and `contextBlock: JSON.stringify(coachingResponse)` from inside the negotiation branch. The plan treats `processQuestion()` as if it can signal back to `LLMHelper` that a coaching card response should bypass the normal LLM call entirely.

But in `LLMHelper.chatWithGemini()`, the return value of `processQuestion()` is used only to inject a system prompt and context block. The response is then passed through the full Gemini/Groq LLM pipeline again — meaning the JSON string that IS the final answer gets fed into the LLM as context, which will destroy it.

**Fix required:** Either (a) add an `earlyReturn?: string` field to `PromptAssemblyResult` and have `chatWithGemini` short-circuit when it is set (mirroring the existing `isIntroQuestion` / `introResponse` pattern), or (b) keep `LiveCoachingResponse` construction entirely inside `LLMHelper` as a new branch before the normal LLM path. The `isIntroQuestion` pattern from the existing code is the right model to follow here.

### 1b. CRITICAL — Broken prompt template in `LiveNegotiationAdvisor`

Line 413 of the plan contains a literal placeholder in the prompt string:

```typescript
${state_xml_here}  // Replaced by getStateXML() output at call site
```

This is not a template variable — it is a comment stub that will appear verbatim in the prompt sent to the LLM. The note at the bottom of the section says "pass `tracker.getStateXML()` from the orchestrator call site," but the call site shown at line 446 does:

```typescript
prompt.replace('${state_xml_here}', state.getStateXML ? (state as any).getStateXML() : JSON.stringify(state))
```

This relies on `state` (a plain `NegotiationState` struct) having a `getStateXML()` method, which it doesn't — that method lives on the tracker instance, not the state snapshot returned by `getState()`. The `(state as any).getStateXML()` cast will silently fail and fall back to `JSON.stringify(state)`, which produces redundant, ugly JSON inside the prompt.

**Fix required:** Pass the XML string as a separate argument to `generateLiveCoachingResponse()`, computed from the tracker before calling the function.

### 1c. Regex correctness — `normalizeAmount` edge cases

The `SALARY_PATTERNS` array uses patterns like `/(\d{2,3})[k]\b/gi` to capture amounts like "95k". But the normalization function `normalizeAmount` strips `$`, `,`, and spaces before calling `parseFloat`. If the captured group is `"95"` (without the `k`), the function correctly multiplies by 1000. However:

- The pattern `/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)[k]?/gi` captures `"1,000"` for "$1,000" and `normalizeAmount` strips the comma to get `1000`, then sees `1000 >= 1000` and does NOT multiply — correct. But it also matches "$95" with no `k`, captures `"95"`, and normalizes to `95000`. However "$95" in natural speech likely means $95/hour, not $95k/year. There is no hourly-rate detection at all.
- The pattern `/between\s+(\d{2,3})[k]?\s+and\s+(\d{2,3})[k]?/gi` uses capture group `[1]` and `[0]` but the outer loop calls `match[1] || match[0]`. For this pattern, `match[0]` is the full match (`"between 90k and 110k"`) and `match[1]` is `"90"`. So the upper end of the range (`"110"`) is never extracted. A range offer like "we're budgeting between 90 and 110" would show `latestRecruiterAmount = 90000` and miss the ceiling entirely.
- The `seen` Set deduplicates by normalized amount, so two captures of the same number within different patterns are deduplicated — but the loop reuses the outer `SALARY_PATTERNS` with `new RegExp(pattern.source, pattern.flags)`, which is correct but worth noting: the global flag on the originals means re-creating from `.source` is necessary, and the plan does this right.

### 1d. Phase state machine is too rigid

`transitionPhase()` only allows forward movement through `['INACTIVE', 'PROBE', 'ANCHOR', 'COUNTER', 'HOLD', 'PIVOT_BENEFITS', 'CLOSE']` in that strict order. But real negotiation is non-linear:

- After a `HOLD`, the recruiter might come back with a new, higher number. The tracker should move back to `ANCHOR` (or at minimum `COUNTER`), but the guard blocks it.
- After `PIVOT_BENEFITS`, if the recruiter says "actually, let me check with the team — we might be able to do $105k," the phase should return to `ANCHOR` to prompt a counter. Currently it stays at `PIVOT_BENEFITS` forever.

The unidirectional model will cause the coaching card to give wrong advice (e.g., telling the user to negotiate benefits when a new base offer just landed).

### 1e. `addRecruiterUtterance` signal priority ordering bug

When a recruiter utterance contains both a dollar amount AND a pushback signal (e.g., "the best we can do is 98k"), the code:
1. Extracts the amount → pushes event, sets phase to ANCHOR
2. Detects pushback → increments `pushbackCount`, sets phase to HOLD

But then at the bottom: `amounts.length > 0` is true, so `lastRecruiterSignal` gets overwritten to `'offer'`. The pushback count was incremented correctly, but the `lastRecruiterSignal` is wrong ("offer" not "pushback"), and the LLM will receive conflicting signals.

The signal detection `else if` chain also short-circuits: if pushback is detected, `REJECTION_SIGNALS`, `ACCEPTANCE_SIGNALS` are skipped but the `amounts` block ran first unconditionally. The `lastRecruiterSignal = 'offer'` reassignment at the bottom of the `else if` chain needs to respect what was already set by the pushback branch.

---

## 2. Edge Cases and Failure Modes

### 2a. No recruiter speech at all (most common real-world case)

The feature requires system audio STT to be running and capturing recruiter speech. Section 9 explicitly says "this needs verification." If system audio capture is off, the audio quality is poor, or the recruiter is on a call where system audio isn't routed (e.g., through a Bluetooth headset with separate playback), `feedInterviewerUtterance()` never gets called, `isActive()` is always `false`, and the feature is invisible with no user feedback. There is no onboarding state ("System audio not capturing — enable it to get live coaching") and no in-app indicator.

### 2b. The silence timer triggers on non-negotiation user speech

`addUserUtterance()` is called in `processQuestion()` for every message the user types, including technical questions. If the user asks "I have experience with $130k lines of code in our codebase," the tracker would set `silenceTimerActive = true` and `userTarget = 130000`. This is a false positive that will incorrectly show the silence timer on an unrelated message.

The fix is to gate `addUserUtterance()` behind `negotiationTracker.isActive()` — only feed user utterances when a negotiation is in progress.

### 2c. LLM response latency: the plan assumes <3s but adds a full extra LLM call

The plan adds a new blocking LLM call (`generateLiveCoachingResponse`) inside `processQuestion()`, which itself is inside `chatWithGemini()`, which may already be doing an LLM call (for `assemblePromptContext` if `ContextAssembler` calls LLM for dynamic context). This stacks two sequential LLM round trips. For cloud LLM providers under load, a single call can take 2-4 seconds. Two calls cascaded will routinely exceed the 3-second target.

### 2d. Currency detection is a stub

`OfferEvent.currency` is hardcoded to `'USD'` in both `addRecruiterUtterance` and `addUserUtterance`. The `OfferState.latestRecruiterCurrency` initializes to `'USD'`. Currency detection is listed in the type definition as a feature (`'USD'`, `'INR'`, etc.) but is never implemented. For a global product this is a correctness hole — an Indian candidate being offered ₹1,800,000 will have the tracker detect `1800` → multiply to `1,800,000` (correct by coincidence in USD terms, wrong semantically) and the coaching card will show "USD 1,800,000" when it should show "INR 18,00,000."

### 2e. `getState()` shallow copy exposes mutable nested objects

```typescript
getState(): NegotiationState {
  return { ...this.state };
}
```

This is a shallow copy. The caller receives the same reference to `this.state.offers.allEvents` array. If the caller (or the renderer process via IPC serialization and back) modifies the array, it mutates internal tracker state. This should be a deep clone, especially since the state is serialized over IPC.

### 2f. No debouncing on STT utterances

STT results arrive incrementally — a provider might emit partial results every 500ms before the final transcript. If `feedInterviewerUtterance` is called for each partial result, the tracker might:
- Extract the same dollar amount multiple times, creating duplicate `OfferEvent` entries
- Increment `pushbackCount` multiple times for a single recruiter sentence
- Transition phases multiple times

The plan has no deduplication, debouncing, or finality flag handling for STT events.

### 2g. Negotiation detection fires on non-negotiation calls

The tracker activates whenever any salary signal appears in recruiter speech, including technical screenings where compensation is briefly mentioned in passing ("this is a senior role with competitive compensation"). Once `isActive()` is true, every subsequent user question routes through the live LLM advisor call, even "can you explain your system design experience?" This creates unnecessary latency and irrelevant coaching cards for the rest of the session.

---

## 3. Missing Implementation Details

### 3a. STT routing is the most critical missing piece

Section 9 says "this needs verification" and offers a possible IPC event name (`system-audio-transcript`) but confirms nothing. The actual code paths in `electron/audio/SystemAudioCapture.ts`, `DeepgramStreamingSTT.ts`, and related files were not analyzed. The plan does not specify:
- Whether system audio STT results currently go anywhere other than the live transcript display
- Which process (main vs renderer) emits the STT events
- Whether the event is the final transcript or a streaming partial
- How to distinguish system audio from microphone audio at the STT output layer

This is not a detail — it is the critical integration path. If system audio isn't already being piped to the main process in a way that reaches `KnowledgeOrchestrator`, the entire feature requires additional audio infrastructure work that is not scoped.

### 3b. No `getNegotiationScript()` implementation shown

Section 4b and 4e reference `this.getNegotiationScript()`. This method doesn't appear in the current `KnowledgeOrchestrator.ts` (based on reading the file). The AOT pipeline produces a negotiation script, but the accessor for it is not defined. The plan should specify where it lives (in `aotPipeline.getCachedScript()`? In the DB? As a field on `KnowledgeOrchestrator`?) and how it's retrieved.

### 3c. `buildLiveNegotiationSystemPrompt()` is defined but never used at the right layer

The function is exported from `ContextAssembler.ts` and referenced in the orchestrator's return value as `systemPromptInjection`. But in `LLMHelper.chatWithGemini()`, `knowledgeResult.systemPromptInjection` is never actually used as the system prompt — the code sets `skipSystemPrompt = false` but then uses `buildMessage(systemPrompt)` where `systemPrompt` is the existing app-level system prompt, not the returned one. The knowledge system prompt injection has no effect on the actual LLM call unless this wiring is fixed.

### 3d. `NegotiationPhase` type import in UI component

`NegotiationCoachingCard.tsx` imports `NegotiationPhase` from `'../types/negotiation'`, a file that doesn't exist. The type is defined in `premium/electron/knowledge/types.ts`, which is in the Electron main process and is not directly importable from the renderer. The plan needs to either (a) duplicate the type in `src/types/` or (b) re-export it from a shared types package.

### 3e. No session persistence

When the user closes and reopens the app mid-negotiation, the tracker resets. For a live negotiation that spans a bathroom break or reconnect, this means losing all context. This is acceptable as a v1 trade-off, but it should be explicitly called out as a known limitation, not an accidental gap.

### 3f. No guard against `activeResume` being null

In Section 4e, `this.activeResume!` is used with a non-null assertion. But `processQuestion()` already guards `if (!this.isKnowledgeMode() || !this.activeResume)` at the top, so this is safe. However, the plan should make this dependency explicit in the live negotiation branch rather than relying on the outer guard being read carefully.

---

## 4. Architecture Issues

### 4a. Dual-LLM-call architecture is fundamentally wrong for latency

The current design calls `generateLiveCoachingResponse()` from inside `processQuestion()`, which returns to `chatWithGemini()`, which then makes another LLM call with the result injected as context. This is two sequential LLM calls for a single user interaction.

The correct architecture: `generateLiveCoachingResponse()` should produce the final answer, and `chatWithGemini()` should detect the coaching response and return it directly (using the same `introResponse` short-circuit pattern that already exists). One LLM call total.

### 4b. Tracker lives in the wrong layer

`NegotiationConversationTracker` is instantiated inside `KnowledgeOrchestrator`, but the tracker responds to audio events that have nothing to do with user questions (recruiter utterances from system audio STT). This creates a temporal coupling: the tracker must be hydrated with recruiter speech before `processQuestion()` is called. Since STT events and user questions arrive on different event loops, there's a race condition where the user types a question before the final STT transcript for the recruiter's offer has been committed.

A better model: the tracker is a singleton owned by a dedicated `NegotiationSessionManager` service that both the audio pipeline and the orchestrator reference directly, decoupling ingestion from query processing.

### 4c. `contextBlock: JSON.stringify(coachingResponse)` pollutes the context window

The plan proposes passing the raw JSON of `LiveCoachingResponse` as the `contextBlock` and then parsing it on the renderer side. This means the serialized JSON is treated as context for the LLM, then separately parsed by the UI. This is architecturally confused — context blocks are for LLM consumption, and structured data for the UI should travel via a separate field or a dedicated IPC result type.

A cleaner approach: return a discriminated `result` type from `processQuestion` with a `liveNegotiationCoaching` field separate from `contextBlock`.

### 4d. `NegotiationCoachingCard` silence timer has a stale closure risk

The `useEffect` for the silence timer uses `onSilenceTimerEnd?.()` but captures it at the time of effect creation. If the parent re-renders and passes a new callback reference, the timer still holds the old one. The `useEffect` dependency array only includes `[showSilenceTimer]`, not `onSilenceTimerEnd`. This is a common React bug that should use `useRef` for the callback.

---

## 5. Performance and Latency

### 5a. The 3-second budget is almost certainly broken

The budget breakdown is:
- STT finalization: 200-500ms (happens before user types)
- `processQuestion()` intent classification: ~0ms (regex, instant)
- `generateLiveCoachingResponse()` LLM call: **1,500-3,000ms** (network-dependent)
- Streaming response to renderer: 100-300ms

Total: 1.8-3.8 seconds. At P95 latencies for cloud LLMs, this will exceed 3 seconds regularly. The plan notes "Response generated within 3 seconds for typical prompts" as an acceptance criterion but provides no mechanism to enforce it (timeout, abort signal, streaming).

### 5b. No abort signal or timeout on the advisor LLM call

`generateLiveCoachingResponse` calls `generateContentFn` with no timeout. If the LLM call hangs (network issue, rate limit, model loading), it blocks indefinitely. There is no `AbortController` integration, no timeout fallback, and no user-visible loading state while the call is in-flight.

### 5c. Prompt size scales with conversation history

`getStateXML()` includes the full `allEvents` array: every offer event from every recruiter utterance. In a long negotiation with many STT partial results, this could grow to hundreds of entries. The prompt can balloon significantly, increasing both latency and LLM cost.

**Fix:** Cap `allEvents` rendering in `getStateXML()` to the last N events (5-10) and use a summary for older history.

### 5d. Resume highlights are extracted by slicing `experience[0-2]` — brittle and context-blind

The advisor picks the top 3 experience entries by array index. These may be the least relevant ones for the current negotiation (e.g., a student internship is listed before senior roles in a different resume format). At minimum, the highlights should be drawn from the pre-computed STAR stories or resume nodes, not raw array slicing.

---

## 6. Concrete Suggestions for Improvement

### Priority 1 — Fix before implementation starts

1. **Fix the return type / data flow:** Add `liveNegotiationResponse?: LiveCoachingResponse` to `PromptAssemblyResult` and short-circuit in `chatWithGemini` when it's present, identical to the `introResponse` pattern. Remove the double-LLM-call path.

2. **Fix the prompt template:** Pass `stateXML: string` as a first-class argument to `generateLiveCoachingResponse`. Remove the `.replace()` hack.

3. **Resolve STT routing before writing any other code:** Read `SystemAudioCapture.ts` and trace the exact path from audio capture to main process event. Confirm whether `feedInterviewerUtterance` can be called from there, and whether the transcript is final or partial. Gate the tracker on final transcripts only.

4. **Gate `addUserUtterance` behind `isActive()`:** Only feed user messages to the tracker during an active negotiation.

5. **Fix the state machine to allow backward transitions for ANCHOR and COUNTER phases:** Use a `canTransition(from, to)` matrix rather than strict ordering.

### Priority 2 — Fix in the same sprint

6. **Add an abort/timeout to the advisor LLM call:** Pass an `AbortSignal` with a 2.5-second timeout; on timeout, fall through to the static script fallback immediately.

7. **Deep-clone `getState()` output:** Use `structuredClone()` instead of spread.

8. **Fix the `NegotiationPhase` import in the UI component:** Create `src/types/negotiation.ts` that re-exports from a shared location, or inline the type.

9. **Fix the `between X and Y` regex:** Capture both groups and push both as a `range_min` and `range_max` OfferEvent.

10. **Cap `allEvents` in `getStateXML()`:** Render only the last 8 events.

### Priority 3 — Polish / v1.1

11. **Add system audio capture status to the coaching card:** Show a "System audio not active" warning in the NegotiationCoachingCard when the tracker is inactive so users understand why they're not getting live coaching.

12. **Debounce STT input:** Only call `addRecruiterUtterance` on final STT results, not partials.

13. **Add a `NegotiationSessionManager` service** to own the tracker lifecycle independently from `KnowledgeOrchestrator`, eliminating the temporal coupling between audio events and query processing.

14. **Fix `useRef` for `onSilenceTimerEnd`** in the React component to avoid stale closure behavior.

---

## Summary Table

| Issue | Severity | Blocking? |
|---|---|---|
| `processQuestion` return type mismatch → double LLM call | Critical | Yes |
| Broken prompt template (`${state_xml_here}` literal) | Critical | Yes |
| STT routing unverified | Critical | Yes |
| `addUserUtterance` fires on non-negotiation messages | High | Yes |
| Phase state machine blocks backward transitions | High | Yes |
| No timeout on advisor LLM call | High | No |
| `getState()` shallow copy | Medium | No |
| Currency detection not implemented | Medium | No |
| `NegotiationPhase` import path wrong | Medium | No |
| `between X and Y` range regex misses upper bound | Medium | No |
| STT partial result deduplication missing | Medium | No |
| `allEvents` unbounded growth in prompt | Low | No |
| Stale closure in silence timer `useEffect` | Low | No |
| Resume highlights use array index, not relevance | Low | No |
