# REAL_API_EVAL_REPORT

> Status of the real-API release gate. Branch `fix/overlay-startup-slide`.

## Gate status: FAIL (actual run with provided key)

Ran the real API eval with the provided `NATIVELY_TEST_API_KEY` (redacted in output). The harness hit the production endpoint:

```txt
https://api.natively.software/v1/chat
```

Command run:

```bash
NATIVELY_TEST_API_KEY=<redacted> node --experimental-strip-types \
  intelligence-eval-real-api/run-real-api-e2e.ts
```

## Result

```txt
Tests: 89/105 passed | critical 25/26
Real API calls: 76 | provider-backed: 76 | fast-path: 29 | mocks: 0
Manual factual first-useful p50/p95: 0.035/3.333ms
Manual LLM first-useful p50/p95: 7165.603/53638.029ms
What-to-answer first-useful p50/p95: 6050.963/23651.559ms | extraction p95: 0.596ms
Assistant-identity confusion: 0
Release gate: FAIL
```

## Interpretation for this manual Profile Intelligence bug

Good signal:

- `Assistant-identity confusion: 0` — the core candidate-vs-assistant identity confusion is fixed in the real API harness.
- Deterministic manual factual fast path is extremely fast: p50/p95 `0.035/3.333ms`.
- 29 cases used deterministic fast path, 76 used real provider streaming, 0 mocks detected.

Gate still failed due to:

- latency stalls on several provider-backed cases,
- one critical failure,
- coding WTA context leakage in two coding cases (`forbidden_context_layer_selected:resume`).

Failures printed by the harness:

```txt
BE-003 [projects_manual] latency_stall:firstUseful_20956ms
ML-004 [projects_interviewer] latency_stall:firstUseful_22263ms
UX-003 [projects_manual] latency_stall:firstUseful_19158ms
DA-005 [jd_alignment] latency_stall:firstUseful_21404ms
DA-007 [metrics_manual] latency_stall:firstUseful_12054ms
CSM-007 [follow_up] latency_stall:firstUseful_19883ms
CY-003 [projects_manual] latency_stall:firstUseful_73076ms
CY-004 [approach] latency_stall:firstUseful_24240ms
CY-005 [jd_alignment] latency_stall:firstUseful_38904ms
CY-008 [negotiation] latency_stall:firstUseful_37062ms
CY-009 [unknown] latency_stall:firstUseful_29287ms
FND-005 [jd_alignment] latency_stall:firstUseful_53638ms
FND-006 [metrics_guard] latency_stall:firstUseful_23652ms
FND-008 [negotiation] latency_stall:firstUseful_49353ms
TWO-SUM-WTA [coding_interviewer] forbidden_context_layer_selected:resume, latency_stall:firstUseful_18021ms
REVERSE-LINKED-LIST-WTA [coding_interviewer] forbidden_context_layer_selected:resume
```

## Evidence

Raw command output path:

```txt
/private/tmp/claude-501/-Users-evin-natively-cluely-ai-assistant/646ad8e7-dc81-4b5a-8c5e-bd6b1df70e88/tasks/bdivlp6v0.output
```

Results are also written by the harness under:

```txt
intelligence-eval-real-api/results/
```

## Verdict

Real API: **FAIL**. The manual factual identity confusion appears fixed (`Assistant-identity confusion: 0`), but the release gate does not pass because of latency stalls and coding WTA context leakage.
