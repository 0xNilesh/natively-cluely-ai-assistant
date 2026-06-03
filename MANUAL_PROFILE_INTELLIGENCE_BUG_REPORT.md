# Manual Profile Intelligence Bug Report

Date: 2026-06-03  
Branch: `fix/overlay-startup-slide`

## Root cause

Manual typed questions in the overlay were routed through the generic chat IPC path:

```txt
src/components/NativelyInterface.tsx handleManualSubmit
→ window.electronAPI.streamGeminiChat(...)
→ electron/preload.ts ipcRenderer.invoke('gemini-chat-stream')
→ electron/ipcHandlers.ts
→ LLMHelper.streamChat(..., CHAT_MODE_PROMPT, ...)
```

`gemini-chat-stream` did run `planAnswer({ source: 'manual_input' })`, but the result was used only for coding isolation/answer contract handling. Non-coding manual profile questions such as `what is my name?`, `what are your experiences?`, and `what all projects have you done?` fell through to generic `CHAT_MODE_PROMPT` without a deterministic profile-fact fast path. With no profile facts in the prompt, the assistant identity won and the model answered as Natively.

## Current route before fix

```txt
manual question
→ handleManualSubmit
→ streamGeminiChat
→ gemini-chat-stream
→ narrow assistant identity probe OR generic chat
→ LLMHelper.streamChat
→ provider answer
```

Profile Intelligence was only reached opportunistically inside `LLMHelper.streamChat` when knowledge mode was active and the knowledge intercept chose to apply. The manual IPC handler itself did not require candidate profile routing for candidate profile questions.

## Expected route after fix

```txt
manual question
→ handleManualSubmit
→ streamGeminiChat
→ gemini-chat-stream
→ answerPlan
→ assistant identity guard
→ deterministic structured profile/JD fast path when possible
→ otherwise Profile Intelligence / LLMHelper knowledge route
→ otherwise generic chat fallback
```

## Files involved

- `src/components/NativelyInterface.tsx` — real manual input UI calls `streamGeminiChat`.
- `electron/preload.ts` — exposes `streamGeminiChat` as `gemini-chat-stream`.
- `electron/ipcHandlers.ts` — fixed production choke point for manual chat stream.
- `electron/llm/manualProfileIntelligence.ts` — new deterministic profile/JD fast-path helper and safe route log builder.
- `electron/llm/__tests__/manualProfileIntelligence.test.mjs` — new backend regression tests.
- `intelligence-eval-real-ui/tests/real-ui-manual-input.spec.ts` — real UI manual regression added.
- `premium/electron/knowledge/KnowledgeOrchestrator.ts` — existing structured factual recall path still covers non-fast-path Profile Intelligence grounding.

## Where context was lost

The renderer supplied only `conversationContext` to `streamGeminiChat`; it did not pass structured resume/JD facts. In `gemini-chat-stream`, the `answerPlan` was not used for profile fact routing, so candidate profile questions reached the generic provider path.

## Why assistant identity won

Candidate-profile questions like `what are your experiences?` and `what all projects have you done?` were interpreted by the provider as questions about the assistant when profile context was absent. `CORE_IDENTITY`/chat-system framing therefore dominated over candidate identity.

The fix adds code-level disambiguation:

- Manual `what is your name?` remains assistant identity.
- Manual `what is my name?`, `who am I?`, `what are your experiences?`, `what all projects have you done?`, `what are my skills?`, and education questions use structured profile facts when available.
- WTA/transcript `Interviewer: What is your name?` remains candidate identity and uses first-person wording.

## Profile facts readiness behavior

`profile:get-status` now exposes explicit readiness metadata:

```txt
resume_structured_extraction_complete
resume_profile_facts_ready
profileFactsReady
jd_structured_extraction_complete
jdFactsReady
aot_pipeline_running
```

Simple profile facts do not wait for embeddings or AOT. As soon as structured resume extraction is saved, name/experience/projects/skills/education can answer deterministically. JD target-role facts can answer from structured JD even without resume facts.

## Safe route logging

Manual route logs include only metadata:

```json
{
  "source": "manual_input",
  "questionHash": "<12-char-sha256>",
  "answerType": "identity_answer",
  "selectedContextLayers": ["stable_identity", "resume"],
  "excludedContextLayers": ["assistant_identity"],
  "profileFactsReady": true,
  "usedDeterministicFastPath": true,
  "providerUsed": false
}
```

No raw resume/JD facts or raw questions are logged. Resume readiness logs use `hasName` and category counts, not the raw name.

## Tests added / updated

Backend:

- `MANUAL-PI-IDENTITY-001`: `what is my name?` → `Your name is Evin John.`
- `MANUAL-PI-EXPERIENCE-001`: `what are your experiences?` → candidate experience.
- `MANUAL-PI-PROJECTS-001`: `what all projects have you done?` → candidate projects.
- `MANUAL-PI-SKILLS-001`: `what are my skills?` → candidate skills.
- Education and target-role fast paths.
- Resume-only facts work without JD; target role does not fabricate without JD.
- JD-only target role works without resume facts.
- WTA/interviewer source uses first-person candidate wording.
- Assistant identity questions (`who are you?`, `what is Natively?`, `what is your name?`, `what's your name?`, `who made you?`) do not use candidate facts.
- Route logs redact raw profile facts.

Real UI:

- Added `MANUAL-PI real UI regression` in `intelligence-eval-real-ui/tests/real-ui-manual-input.spec.ts`:
  - loads the Data Analyst fixture through the UI,
  - waits for `profileFactsReady`,
  - asks manual name/experience/projects/skills/education/role questions,
  - asserts visible answers contain profile/JD facts,
  - asserts `who are you?` and `what is your name?` stay assistant identity.

## Verification run in this environment

Command:

```bash
npm run typecheck:electron && npm run build:electron && node --test \
  electron/llm/__tests__/manualProfileIntelligence.test.mjs \
  electron/llm/__tests__/AnswerPlannerValidator.test.mjs \
  electron/services/__tests__/ProfileFactualRecallProductionPath.test.mjs
```

Result:

```txt
electron typecheck: PASS
build:electron: PASS
36 focused tests: PASS
```

## Real API / Real UI status

After the user provided `NATIVELY_TEST_API_KEY`, actual gates were run/attempted:

- Real API full eval: **FAIL** — 89/105 pass, critical 25/26, assistant-identity confusion 0, but release gate fails on latency stalls and coding WTA resume-context leakage.
- Real UI Data Analyst runner: **FAIL** — launched the app and drove profile upload through the UI, but `resumeLoaded=false` and `jdLoaded=false`; manual identity/projects cases failed because the profile facts never became ready in the real UI flow.

See `REAL_API_EVAL_REPORT.md` and `REAL_UI_EVAL_REPORT.md` for evidence paths and raw outputs.

## Remaining risks

- A narrow mocked IPC integration test for `gemini-chat-stream` would further protect event ordering (`gemini-stream-token` then `gemini-stream-done`) and provider bypass. The real UI regression covers the production path when run with credentials/GUI.
- `gemini-chat` non-streaming remains a legacy path. The actual manual UI uses `gemini-chat-stream`; if `gemini-chat` becomes user-facing for manual profile questions, it should receive the same preflight.
