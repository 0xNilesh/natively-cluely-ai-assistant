# Real API Natively Intelligence E2E Report


Endpoint: `https://api.natively.software/v1/chat`
API key: len=52:natively_sk_**** (redacted)

Total tests: 105
Passed: 89
Failed: 16
Overall accuracy: 84.8%

Real API usage:
- Real API sessions created: 105
- Real streaming responses: 76
- Provider-backed responses: 76
- Deterministic fast-path responses: 29
- Mock/stub responses detected: 0

Critical tests: 25/26 (failed: TWO-SUM-WTA)

Latency (real, ms):
- Manual factual p50/p95 first useful token: 0.035/3.333
- Manual LLM p50/p95 first useful token: 7165.603/53638.029
- What-to-answer p50/p95 first useful token: 6050.963/23651.559
- What-to-answer extraction p95: 0.596
- Total response p50/p95: 6634.969/30162.14

Top failures:
1. BE-003 [projects_manual] — latency_stall:firstUseful_20956ms
2. ML-004 [projects_interviewer] — latency_stall:firstUseful_22263ms
3. UX-003 [projects_manual] — latency_stall:firstUseful_19158ms
4. DA-005 [jd_alignment] — latency_stall:firstUseful_21404ms
5. DA-007 [metrics_manual] — latency_stall:firstUseful_12054ms

Context pollution findings:
1. none

Provider/network bottlenecks:
1. First-useful-token is dominated by provider prefill (model: gemini-3.5-flash)
2. Network RTT to https://api.natively.software/v1/chat
3. n/a

Release gate: FAIL
