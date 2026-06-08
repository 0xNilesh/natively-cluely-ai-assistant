# Session-Memory Rollout Report — 2026-06-07c

## Rollout controls (production-safe gradual rollout)

`electron/llm/liveSessionMemoryConfig.ts` resolves a full decision per session:

```ts
resolveLiveSessionMemoryConfig(sessionId?) → {
  enabled, reason, rolloutPercent, bucket, maxItems, killSwitch
}
```

### Decision precedence (highest first)

| # | gate | env / settings | effect |
|---|---|---|---|
| 1 | **Emergency kill switch** | `NATIVELY_LIVE_SESSION_MEMORY_KILL_SWITCH=1` / `settings.liveSessionMemoryKillSwitch` | force OFF — overrides everything, re-read every call (un-bypassable) |
| 2 | Env override | `NATIVELY_ENABLE_LIVE_SESSION_MEMORY=on/off` | that value |
| 3 | Settings opt-in | `settings.enableLiveSessionMemory` true/false | that value |
| 4 | Internal context | `NODE_ENV=test/development`, `BENCHMARK_MODEL`, `NATIVELY_INTERNAL/DEV` | ON |
| 5 | **Percentage rollout** | `NATIVELY_LIVE_SESSION_MEMORY_ROLLOUT_PERCENT` / `settings.liveSessionMemoryRolloutPercent` | deterministic per-session bucket; `bucket < percent` → IN |
| 6 | Default | — | **OFF in production** |

### Deterministic bucketing

`sessionBucket(sessionId)` = FNV-1a hash mod 100 (stable for the same id, ~uniform). A
partial rollout (`0 < percent < 100`) includes a session iff its bucket `< percent`.
`percent=0` → nobody; `percent=100` → everybody. A session with **no id** at partial
percent defaults OFF (id-less sessions are not lumped into one bucket — they don't skew
the cohort).

### Bounds + emergency stop

- `NATIVELY_SESSION_MEMORY_MAX_ITEMS` (20–2000, default 200) bounds memory growth.
- The kill switch is read fresh on every call (not cached), so flipping it takes effect
  at runtime without a redeploy — a clean rollback path.

## Safety verification (senior-reviewed)

@test-engineer + @code-reviewer both reviewed the rollout and concluded
**production-safe to ship behind the flag**:

- **Production-default-OFF proven** (no env, no internal markers, no percent → `default_off`).
- **Kill switch un-bypassable** (re-read every call; wins over env-on and benchmark context).
- **Percent boundaries correct** (`pct<=0`→OFF before bucketing, `pct>=100`→ON; `bucket<percent` inclusion).
- **Flag OFF is a true no-op** — the proven single-prior-turn path runs unchanged.
- 21 unit tests (`RolloutAndTelemetry2026_06_07c.test.mjs`): flag states, percent 0/50/100,
  kill-switch-overrides-env, bucketing stability + distribution, empty-sessionId default-OFF.

### One operator caveat (documented, not a defect)

The env override (`...=on`) intentionally bypasses the percent gate (that's how the
benchmark forces it on). So "production default OFF" assumes no operator/CI env leaks
`NATIVELY_ENABLE_LIVE_SESSION_MEMORY=on` into the shipped process. The **kill switch is
the mitigation** and correctly wins over env-on.

## Recommended rollout sequence

1. **Keep production flag OFF** (current default).
2. Enable for **founder/internal** (`NATIVELY_INTERNAL=1` or settings opt-in).
3. Run **real calls for 24–48 h**; watch telemetry (recall success, blocked-by-mode,
   comp-blocked, clarification count, provider errors, p95 first-useful, 10s+ waits).
4. **5% beta** via `ROLLOUT_PERCENT=5`; watch telemetry.
5. → **25%** → **50%**, watching at each step.
6. **Default ON** only after clean telemetry (0 identity/context/salary validator hits,
   stable latency, no crash-rate change).
7. **Kill switch** is the instant rollback at any step.

## Pre-canary follow-ups (none block the flagged ship)

- Add a settings-tier-precedence unit test (env-driven path is tested; settings path
  needs a SettingsManager stub).
- Add an engine→telemetry-seam integration test (the engine emits `recalledKind`/
  `ageBucket`, never the value — currently verified by code reading + the scrub unit
  tests).

## Verdict

**Production-safe to ship behind the default-OFF flag**, with a deterministic,
kill-switchable, gradually-rampable rollout. Do not enable globally without the
percent ramp + telemetry watch above.
