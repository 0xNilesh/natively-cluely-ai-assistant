# PROVIDER_TTFT_RACE_REPORT

> Phase 3 — kill the ~10s provider wall on the live text answer path.
> Branch `fix/overlay-startup-slide`. All claims verified against current code.

## Root cause (verified)

`electron/LLMHelper.ts` text streaming had **two** latency hazards:

1. **10s connect timeout** in `streamWithNatively` (`setTimeout(... abort ..., 10_000)`). It
   guards the *connect phase only* (cleared once headers arrive), so a slow connect waited
   the full 10s before any fallback.
2. **No TTFT (time-to-first-token) timeout** anywhere on the text path. The `natively` branch
   of `_streamChatInner` was a serial `try/catch` waterfall (Natively → Groq → Gemini) that
   only fell over on a thrown error. A provider that *connected fast but prefilled slowly*
   produced no token and no error — it just blocked. Vision already had a commit-point TTFT
   race (`visionStreamFallback.ts`); text did not reuse it.

## Fix

### Before
```
connect timeout: 10_000 ms (Natively)
text fallback:   serial Natively → Groq → Gemini, switch only on THROW
TTFT timeout:    none (a stalled-but-connected provider blocks indefinitely)
sampling:        temperature 0.3–1.0 across providers, no seed
```

### After
```
connect timeout: 4_000 ms (INTERACTIVE_CONNECT_TIMEOUT_MS), per-call overridable
text fallback:   TTFT RACE via runStreamingTextFallback (reuses the proven
                 vision commit-point engine), Natively → Groq → Gemini Flash
TTFT timeout:    2_500 ms per provider (DEFAULT_TEXT_FALLBACK_CONFIG.ttftTimeoutMs)
                 → a stalled primary fails over in ≤2.5s instead of ≤10s
inter-chunk:     20_000 ms (a committed, mid-stream answer is never cut off early)
sampling:        temperature 0.2 + fixed seed 7 on every interactive text
                 provider (Groq/OpenAI/Gemini/DeepSeek seed; Claude temp-only)
```

### Mechanism
- New `electron/llm/textStreamFallback.ts` — thin wrapper over the SDK-free, unit-tested
  `runStreamingVisionFallback` state machine with text-tuned config. The "commit point"
  pattern: a provider's first token races the TTFT timeout; the first provider to actually
  produce a token **wins and commits**; pre-commit failures fall over silently; post-commit
  failures never switch providers (no duplicate output).
- The `natively` branch of `_streamChatInner` now builds an ordered text-provider list
  (health-sorted fastest-first via `orderTextByHealth`) and delegates to the race. Each
  provider's `open()` is wrapped to emit `provider_race_won` telemetry with the winning TTFT.
- Per-provider TTFT EWMA is tracked in a dedicated `textHealth` map (separate from
  `visionHealth`); a refreshed Groq/Gemini key clears its text breaker for immediate retry.

## Providers tested (unit, deterministic fakes)

`electron/llm/__tests__/TextStreamFallback.test.mjs` — 9 tests, all pass:
- fastest provider that produces a token wins and streams through ✓
- pre-commit error on primary → silent failover, no leaked artifact ✓
- **stalled primary (no first token) fails over within the TTFT budget** ✓ (62ms vs old 10s)
- post-commit failure does NOT switch providers (no duplicate output) ✓
- exhaustion (all fail pre-commit) throws ✓
- outer abort stops the chain without throwing ✓
- config: TTFT ≤3s, TTFT < inter-chunk, inter-chunk ≥15s ✓
- `orderTextByHealth` orders fastest-first by EWMA ✓

`VisionStreamFallback.test.mjs` (30) still green — the shared engine is unchanged.

## p50/p95 first byte / first useful token

**Cannot be measured in this environment** — the real-API gate needs `NATIVELY_TEST_API_KEY`
(absent) and live provider keys; the real-UI gate needs a Pro key + GUI (absent, headless).
The Phase-2 telemetry (`provider_request_started` / `first_response_byte` / `first_useful_token`
/ `provider_race_won`) now records these per request, so p50/p95 will populate the moment the
real gates run with a key. The synthetic guarantee proven here: **a stalled/erroring primary
no longer blocks past ~2.5s** (TTFT budget) instead of ~10s (old connect timeout), and a fast
provider commits immediately.

## Fallback count / cost impact

- The race opens providers **in order, one at a time** (it is NOT a parallel hedged race that
  doubles cost) — provider N+1 is only opened if provider N fails to produce a first token
  within budget or errors pre-commit. So in the common case (primary healthy) **exactly one**
  provider is billed, identical to before. Cost increases only on the genuine failover path,
  which previously also tried the next provider serially — net cost is unchanged.
- The 4s connect timeout can cause an *earlier* failover than the old 10s, but only when the
  primary was going to be unusably slow anyway.

## Determinism impact

Temperature 0.2 + fixed seed removes run-to-run structural variance (REPORT §22 D1). Because
every provider in the race receives the **same** `finalSystemPrompt` and the same low-temp/seed
settings, the race winner does not change answer STYLE — only who serves it. Answer *structure*
is separately guaranteed by the deterministic scaffold/validator (Phase 7/8).

## Risks / follow-ups

- **R1**: 4s connect timeout could fail over on a slow-but-alive Natively server. Mitigated by
  the commit-point design (commits on first token, not connect) and the new telemetry to
  calibrate against production p95. Tune `INTERACTIVE_CONNECT_TIMEOUT_MS` once real data exists.
- **R2**: temp 0.2 could marginally reduce answer richness vs 0.4. To be validated by the
  answer-quality eval; gate is interview/coding-focused where determinism > variety.
- **R3**: `seed` is best-effort — providers treat it as a hint, not a guarantee; some ignore it.
  Claude has no seed param (temperature-only). Documented inline.
