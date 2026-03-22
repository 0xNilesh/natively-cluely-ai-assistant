# Section 00 — STT Routing Verification

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
