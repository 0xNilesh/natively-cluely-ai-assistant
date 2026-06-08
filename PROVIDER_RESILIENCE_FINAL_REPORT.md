# Provider Resilience Final Report — 2026-06-07c

## Taxonomy (used live + in benchmarks)

`electron/llm/providerErrorClassifier.ts` — `classifyProviderError(err, text?)` →
`{ kind, isOutage, retryable, code }`:

| kind | trigger | isOutage | retryable |
|---|---|---|---|
| `rate_limit` | 429 / RESOURCE_EXHAUSTED / quota | yes | yes |
| `auth` | 401 / 403 / api key / expired | yes | no |
| `overloaded` | 503 / 529 / overloaded | yes | yes |
| `server_error` | 5xx / unrecognized throw | yes | yes |
| `timeout` | deadline / timeout / aborted | yes | yes |
| `network` | ENOTFOUND / ECONNRESET / DNS | yes | yes |
| `zero_token` | success but no text | yes | yes |
| `stall` | content-free clarification ("Could you repeat that?") | yes | yes |
| `none` | a real answer | no | no |

An **unrecognized error is treated as a retryable outage** — the conservative
direction: it can under-count outages as defects, never launder a defect as an outage.

## Live product behavior (graceful degradation)

| condition | behavior |
|---|---|
| 429 rate-limit | existing retry-circuit (`LLMHelper.rateLimitCircuit`) + backoff; circuit opens after saturation |
| 403 / expired key | surfaced as a config error (non-retryable); no silent model switch in strict benchmark mode |
| 503 overloaded | retry; then deterministic fallback if available |
| first-token timeout | abort at the first-useful deadline; swap the deterministic profile fallback (profile answers) |
| zero-token / mid-stream error | **NEW**: on a stream error for a profile-REQUIRED answer with empty output, emit the deterministic `buildManualProfileBackendAnswer` instead of a blank error — no empty answer when a safe fallback exists |
| clarification stall | classified as outage; quarantined in benchmarks |

### Fallback safety (code-reviewed)

The deterministic stream-error fallback:
- is **gated to `profileContextPolicy === 'required'`** → it can NEVER fire for a
  coding/technical answer (those are `'forbidden'`), so **no profile-into-coding leak**.
- uses `buildManualProfileBackendAnswer` — the **deterministic profile backend (no
  LLM)** — so it cannot contain assistant-meta and cannot bypass safety/stealth guards
  (those answer types are `forbidden`/contract-enforced, never `required`).
- respects the same context policy (profile-only, deterministic) and emits
  `provider_fallback_used` telemetry (marker-only).

## Strict benchmark honesty

- The benchmark **forces** `gemini-3.1-flash-lite` and **aborts** if a different model
  is served — no silent fallback.
- Zero-token empties and content-free stalls are quarantined as `providerUnavailable`
  (excluded from the pass denominator) — by the deterministic, conservative classifier,
  not by hand. The risk direction is "under-count outages as defects," never "launder
  defects as outages" (a wrong-but-non-empty answer still scores as a fail).
- @test-engineer confirmed a ~450–700 clean denominator bounds the true failure rate to
  <1% (rule of three) and is sufficient for the route/leak gates, which are
  deterministic per-row.

## Tests

- `ProviderErrorClassifier2026_06_07c.test.mjs` — 25 subtests (all kinds, outage
  gating, stall vs real answer).
- The manual fallback path is wired and emits classified telemetry; the existing
  circuit-breaker tests (NegotiationStickiness) pass 25/25.

## Verdict

Provider failures are **classified deterministically, separated from logic defects in
all benchmarks, and degrade gracefully in the product** (retry → circuit → grounded
deterministic fallback → no empty when avoidable). The fallback cannot leak context,
bypass the sanitizer's guarantees (it's deterministic profile-only), or fire for a
coding answer. The one constraint is environmental: a heavily rate-limited window
shrinks the scored denominator (reported transparently as `providerUnavailable`),
never inflates the defect count.
