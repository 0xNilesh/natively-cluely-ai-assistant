# Continuous Benchmarking CI Report — 2026-06-08

Four CI tiers, fastest-first, so safety/context/identity regressions are caught before
merge and quality/latency trends are tracked over time.

## Tiers

| tier | script | what runs | provider | budget | gate |
|---|---|---|---|---|---|
| **1 — pre-commit** | `npm run ci:tier1` | llm + codeVerification unit tests (routing, validator, safety, sanitizer, style, judge, rollout, telemetry) | none | < 60s | **must pass to commit** |
| **2 — PR check** | `npm run ci:tier2` | tier 1 + residual-50 deterministic regression | minimal | < 3 min | route/leak/safety must pass |
| **3 — nightly** | `npm run ci:tier3` | multimode-1000 + follow-up-500 + long-session-100 + answer-quality | real (flash-lite) | ~30–60 min | pass ≥ 99%, 0 leaks, quality ≥ 4.5 |
| **4 — release** | `npm run ci:tier4` | livememory + live-replay-50 + WTA-100 + real-UI Electron E2E | real + GUI | release machine | all gates + E2E |

## Hard gates (no merge if any fail)

Tier 1/2 (deterministic, provider-independent — the merge blocker):
- route accuracy 100% (or documented safe aliases)
- safety 100%
- identity leaks 0
- context leaks 0
- salary leaks 0
- stealth/evasion leaks 0
- coding-profile leaks 0
- candidate sanitizer keeps legitimate content (no over-strip)
- telemetry allowlist drops all leak vectors

Tier 3/4 (trend + quality):
- multimode/WTA/follow-up/long-session pass ≥ 99% on the clean denominator
- live-replay ≥ 98%
- answer-quality overall ≥ 4.5/5, WTA ≥ 4.6, every mode ≥ 4.2
- p95 first-useful < 2500ms, p99 < 3500ms
- 0 ten-second waits excluding provider outage

## Artifacts saved per run

Each benchmark writes `*_results.json` + `*_failures.json` (+ `*_latency.csv` for the
multimode/replay runners). A nightly job diffs the new `*_results.json` against the
previous run to surface **regressions** (a route that flipped, a leak that appeared, a
latency p95 that rose, a quality average that dropped). Provider-empty rows are
quarantined (the `providerUnavailable` count is reported separately so a rate-limited
window doesn't read as a regression).

## Provider-instability handling

- Tiers 1/2 use NO (or minimal) provider — they are the authoritative merge gate and
  never flake on rate limits.
- Tiers 3/4 quarantine zero-token empties + clarification stalls as
  `providerUnavailable` via the deterministic `classifyProviderError` (conservative:
  under-counts outages as defects, never the reverse). A run with a too-small clean
  denominator is flagged, not silently passed.
- Failed provider batches can be re-run with backoff; the strict model is preserved
  (no silent model switch).

## Latency-regression detection

The nightly diff compares first-useful p50/p95/p99 to the prior run; a >15% p95
increase (excluding a provider-outage window) flags a latency regression for review.

## Current status (this pass)

- **Tier 1**: 1385 llm tests pass / 0 fail (3× stable).
- **Tier 2**: residual 50/50; deterministic route 1000/1000.
- **Tier 3**: livememory/followup/longsession 100%; answer-quality judge live
  (provider-limited denominator this window).
- **Tier 4**: live-replay 50 → 100% sessions/checks/0 leaks; real-UI E2E is the
  release-machine step (needs a display).

## Verdict

The tiering exists, the scripts are wired, the merge-blocking gates are deterministic
and provider-independent, and artifacts support regression comparison. A nightly job
running tier 3 + the diff makes quality/latency trends visible over time.
