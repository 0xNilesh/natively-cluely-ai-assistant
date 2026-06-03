# LATENCY_ROOT_CAUSE_REPORT

> Root-cause analysis of Profile Intelligence latency, with the concrete fixes
> applied. Branch `fix/overlay-startup-slide`. All line numbers verified against
> current code.

## The "~10 second" class — root causes (confirmed)

| # | Root cause | Evidence (verified) | Fix applied |
|---|---|---|---|
| L1 | **Natively connect timeout was 10s** and only guarded the connect phase | `LLMHelper.streamWithNatively` `setTimeout(...abort..., 10_000)` | Lowered to **4s** (`INTERACTIVE_CONNECT_TIMEOUT_MS`), per-call overridable. |
| L1b | **No TTFT timeout** on the text path — a provider that connected then prefilled slowly blocked indefinitely with no fallback | text path `_streamChatInner` `natively` branch was a serial try/catch that only fell over on a THROW | Added a **commit-point TTFT race** (`textStreamFallback.ts`, 2.5s TTFT budget) reusing the proven vision fallback engine. A stalled primary now fails over in ≤2.5s. |
| L2 | **Blocking profile grounding** before the stream — `await orchestrator.processQuestion` had no timeout | `IntelligenceEngine.runWhatShouldISay` awaited grounding with no bound | Wrapped in `withTimeout(..., 2000ms)`; on timeout we proceed with no profile and flag `degraded_context`. Grounding can never stall first-token > 2s. |
| L4 | DNS retry adds ~1s on a Railway resolver hiccup | in-fetch DNS retry loop (3× / 500ms) | Left intact (correct for Railway's 1s TTL); the 4s connect budget already absorbs it, and the TTFT race covers the rest. |

## Perceived-latency root cause (the bigger UX win)

The app *felt* slow on coding answers because there was **no immediate feedback**:
the WTA path waited until 160 chars of raw model output accumulated before showing
anything, and coding answers then often appeared malformed/code-first.

**Fix:** for coding/DSA answer types the UI now paints a deterministic six-section
**scaffold in <500ms** (before any model token), buffers the raw stream, and swaps in
the validated final answer once. Perceived time-to-first-structure dropped from
"whenever the model warms up" to **immediate**.

## Pre-stream serial work (bounded)

The WTA pre-stream sequence (transcript window → intent classify → latest-question
extract → grounding → plan → prompt assembly) is now fully instrumented with spans
(`PiLatencyTrace`) and the only previously-unbounded step (grounding) is capped at 2s.
The deterministic stages measure **sub-millisecond** in the backend eval
(extraction p95 = 0.2ms, manual first-token p95 = 0.5ms, WTA first-token p95 = 1.1ms) —
i.e. the routing/planning layer is not a latency source; provider TTFT is.

## What is NOT a Natively-side bottleneck

Provider prefill/first-token for the actual LLM call is external. The TTFT race +
4s connect timeout ensure no *Natively-controllable* step adds the 10s tail; beyond
that, first-token is the provider's own latency, now measured per-attempt
(`provider_request_started` / `first_response_byte` / `first_useful_token` /
`provider_race_won`) so production p50/p95 can be tracked and the budget recalibrated.

## Verification status

- Deterministic-stage latency: measured, sub-ms (backend eval).
- Provider TTFT p50/p95: **requires real keys** (`NATIVELY_TEST_API_KEY` absent here) —
  telemetry is wired so the numbers populate the moment the real-API gate runs.
- The TTFT failover behavior is proven by unit test (`TextStreamFallback.test.mjs`):
  a stalled primary fails over in ~62ms (test clock) vs the old 10s wall.
