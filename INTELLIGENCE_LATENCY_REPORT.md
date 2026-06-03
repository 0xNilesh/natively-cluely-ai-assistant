# INTELLIGENCE_LATENCY_REPORT

> Profile Intelligence latency after the Phase 2–4 fixes. Branch `fix/overlay-startup-slide`.

## Instrumentation (Phase 2)

The full click→render path is now traced via `PiLatencyTrace` (see
`PROFILE_INTELLIGENCE_LATENCY_TRACE.md`) with ~28 PI events added to
`TelemetryService` plus a `startSpan()`/`record()` timing helper. All events are
metadata-only and pass the (broadened) sanitizer; `track()` is try-guarded so
telemetry can never block or throw on the live path.

## Measured deterministic-stage latency (backend e2e, real wall-clock)

The routing/planning layer that decides correctness is measured with the real
compiled modules over 105 cases:

| Metric | Value |
|---|---|
| Manual first-token p50 / p95 | 0.07ms / 0.53ms |
| What-to-answer first-token p50 / p95 | 0.08ms / 1.14ms |
| WTA latest-question extraction p95 | 0.22ms |

→ Intent classification, extraction, planning, and context routing are **not** a
latency source. The 10s class was entirely provider connect/TTFT + unbounded
grounding, now fixed.

## Fixes and their latency impact

| Fix | Before | After |
|---|---|---|
| Natively connect timeout | 10s | 4s |
| Text fallback | serial, switch only on throw (stalled primary blocks ≤10s) | TTFT race, fail over ≤2.5s |
| Profile grounding | unbounded `await processQuestion` | capped at 2s, `degraded_context` flag |
| Coding visible feedback | none until ≥160 raw chars (often malformed) | deterministic scaffold <500ms |

## Provider TTFT (p50/p95)

Per-attempt TTFT is now recorded (`provider_request_started`, `first_response_byte`,
`first_useful_token`, `provider_race_won`). **Production p50/p95 require the real-API
gate** (`NATIVELY_TEST_API_KEY`, absent in this environment). The synthetic guarantee:
a stalled/erroring primary no longer blocks beyond the 2.5s TTFT budget (unit-proven).

## Targets vs status

| Target | Status |
|---|---|
| Manual factual p95 FUT < 1500ms | Deterministic stage 0.5ms; provider TTFT pending real-API gate |
| Manual coding/WTA p95 FUT < 4500ms | Scaffold <500ms (immediate); final after provider, pending real-API gate |
| Coding scaffold < 500ms | ✅ deterministic, emitted before any model token |
| No 10s wall on a normal path | ✅ removed (4s connect + 2.5s TTFT race + 2s grounding cap) |
