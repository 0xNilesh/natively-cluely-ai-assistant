# Manual Sequential Stress Report
Generated: 2026-06-12T00:41:53.231Z · model=gemini-3.1-flash-lite provider=gemini

## Summary — 216 prompts, one session · ✅ ALL GATES PASS

| metric | value |
|---|---|
| pass | 216/216 (100.0%) |
| first-useful p50/p90/p95/p99 (all) | 746.50425 / 919.891667 / 1002.125666 / 1069.633625 ms |
| first-useful p50/p95 (LLM only) | 804.302292 / 1018.087583 ms |
| provider timeouts | 0 |
| heap growth | -10.3% |
| event-loop delay p95/max | 22.1 / 76.1 ms |
| background ticks (gate working) | 37 ticks, 37 during answers |
| routes | {"fast_path":47,"identity_probe":6,"llm":160,"clarification":3} |

## Gates
- ✅ p95 first-useful < 2500ms
- ✅ p99 first-useful < 3500ms
- ✅ provider_timeout = 0
- ✅ heap growth < 20%
- ✅ event-loop p95 < 250ms
- ✅ no assistant identity leak
- ✅ no sales identity leak
- ✅ no visible scaffold (default style)
- ✅ no empty bullets
- ✅ no exact answer reuse
- ✅ no generic intro collapse
- ✅ no stealth advice

## Failure counts
- none

## Failed rows
- none

## Per-set latency (first-useful p95, LLM rows)
- set 1: all deterministic
- set 2: 1048.672834ms
- set 3: 1039.907208ms
- set 4: 906.477ms
- set 5: 1008.180792ms
- set 6: 882.836125ms
- set 7: 1170.469542ms
- set 8: 1018.087583ms
- set 9: all deterministic
- set 10: 1121.261375ms
- set 11: 918.548417ms
- set 12: 1019.788125ms
- set 13: 1069.633625ms
- set 14: 836.805417ms
- set 15: 1012.926291ms
- set 16: 1002.125666ms
- set 17: 906.962625ms
- set 18: 919.891667ms