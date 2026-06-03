# INTELLIGENCE_COST_REPORT

> Cost tracking for Profile Intelligence. Branch `fix/overlay-startup-slide`.

## What is tracked

The real-API recorder (`intelligence-eval-real-api/real-api-latency-recorder.ts`) and
the new telemetry events (`cost_estimated`, `tokens_used`) capture per response:
provider, model, input/output/total tokens, estimated cost, repair count, retry count,
fallback count, and the selected/excluded context layers (so prompt size is auditable).

## Cost-affecting design decisions in this work

| Decision | Cost impact |
|---|---|
| TTFT race opens providers **sequentially**, not hedged-parallel | No extra cost in the common case — exactly one provider is billed (provider N+1 only opens if N fails to produce a first token). Same as the old serial waterfall. |
| 4s connect timeout (was 10s) | Slightly earlier failover only when the primary was unusably slow; net neutral. |
| Coding context **isolation** (no resume/JD/negotiation in coding prompts) | **Reduces** prompt tokens for every coding question — the prompt no longer carries the resume/JD dump. |
| 2s grounding cap | Avoids paying for a slow grounding call that would be discarded anyway. |
| temperature 0.2 + seed | No cost change; reduces wasted retries from format variance. |
| Deterministic scaffold | No model cost (rendered locally); improves perceived latency for free. |

## Waste flags the suite raises

The cost recorder + grader flag: identity question with a large prompt, coding question
that leaked resume/JD, full transcript sent unnecessarily, retry that doubled cost, and
large model used where a small one would do. The 5 new coding cases assert
context-isolation, which is the primary cost-leak guard for the coding path.

## Measured numbers

Estimated/actual per-response cost **requires the real-API gate** (needs
`NATIVELY_TEST_API_KEY`, absent here). The recorder is wired and the dry-run path
exercises it; numbers will populate when an operator runs the gate with a key. No
real provider calls were made in this environment, so there is no spend to report.

## Privacy of cost telemetry

`cost_estimated` / `tokens_used` carry numeric metadata only (token counts, USD
estimate). The `TelemetryService` sanitizer strips any content-bearing key as a
backstop. Verified by `LatencyMetadata.test.mjs`.
