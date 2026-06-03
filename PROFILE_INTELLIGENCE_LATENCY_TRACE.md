# PROFILE_INTELLIGENCE_LATENCY_TRACE

> The full live-path trace now emitted for every manual/WTA request, and how to read it.

## The trace

`electron/services/telemetry/PiLatencyTracer.ts` — one `PiLatencyTrace` per live
request. Each milestone records elapsed-ms-from-start (monotonic clock) and emits a
telemetry event. `IntelligenceEngine.getLastTraceSnapshot()` exposes the timings to
evals/debug without parsing the JSONL log.

## Milestones (in order)

```
question_submitted | what_to_answer_clicked   ← t0 (click)
transcript_window_loaded                       (turns count)
intent_classified                              (intent, confidence)
latest_question_extracted                      (questionType, speaker, isFollowUp)
context_build_completed | degraded_context     (groundingMs; degraded if >2s)
answer_type_selected                           (answerType, isCoding, forbiddenLayers)
provider_request_started
first_visible_text                             (via: scaffold | stream)
first_useful_token                             (via: scaffold | stream)   ← the KPI
provider_race_won                              (provider, ttftMs)  [LLMHelper]
response_completed                             (chars, scaffolded)
validation_started → validation_completed | validation_failed
repair_used                                    (only if validation failed)
suggested_answer (final)                       ← replaces scaffold
ui_render_completed                            [renderer, optional]
```

## Privacy

Every milestone carries **metadata only** — counts, enums (intent/answerType/
questionType), booleans, durations, short reason strings. **No** raw question,
transcript, resume, persona, JD, or negotiation text. The `TelemetryService`
sanitizer (broadened in this work) strips any content-bearing key as a backstop,
and `track()` is fully try-guarded so it can never throw on the live path.

## Reading first-useful-token

`first_useful_token.via`:
- `scaffold` — coding/DSA: the deterministic six-section scaffold (target <500ms).
- `stream` — non-coding: the first 160-char safe prefix of the model stream.

## Latency targets (from the task)

| Path | p95 first useful token |
|---|---|
| Manual factual | < 1500ms |
| Manual coding/interview | < 4500ms |
| What-to-answer | < 4500ms |
| Coding scaffold (visible) | < 500ms |

Deterministic-stage timings (backend eval, real wall-clock): extraction p95 0.2ms,
manual first-token p95 0.5ms, WTA first-token p95 1.1ms. Provider TTFT is the
remaining variable, now measured per attempt; full p50/p95 require the real-API gate
(needs `NATIVELY_TEST_API_KEY`).
