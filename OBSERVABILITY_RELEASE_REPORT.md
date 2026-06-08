# Observability Release Report — 2026-06-07c

## Marker-only telemetry for Profile Intelligence + live SessionMemory

`electron/llm/piTelemetry.ts` — `piTelemetry.emit(event, data)`. Every payload passes
through an **allowlist scrub** before it is buffered/logged/shipped, so raw sensitive
content can never be recorded.

### Privacy model (ALLOWLIST — code-review HIGH fix)

The scrub was converted from a denylist to an **allowlist** after review: only known
marker keys are kept; **everything else is dropped outright**. So a future careless
caller passing `recalledEntity` / `entity` / `jdText` / `question` / `answerText` /
`apiKey` can never leak — those keys aren't on the allowlist. On top of that, a value
backstop drops free-text, salary-shaped, and PII-number values **even under an allowed
key** (`safeStringValue`: ≤48 chars, marker-label shape, no `\d{2,3}k` / `\d{4,}` /
SSN/phone patterns).

**Never recorded:** resume, JD, salary, transcript, custom context, answer text, API
keys, the recalled entity VALUE, any free-text or numeric PII.

**Recorded (markers only):** answerType, mode, surface, route source, sessionMemory
enabled (yes/no) + reason + rollout bucket/percent, memory item count, recalled KIND
(`'entity'`/`'none'`, never the value), age bucket, resolved-followup, context-free
clarification, selected/forbidden context layer NAMES, provider name, model name,
first-token/first-useful/total ms, fallback used, provider error class, sanitizer
repair applied, validator violation code, flag state, kill switch.

### Events

`pi_answer_plan_created`, `pi_context_policy_applied`, `pi_candidate_sanitizer_applied`,
`pi_provider_error_classified`, `wta_question_extracted`,
`wta_live_session_memory_enabled`, `wta_live_followup_resolved`,
`wta_context_free_clarification`, `session_memory_recall_attempted`,
`session_memory_recall_succeeded`, `session_memory_recall_blocked_by_mode`,
`session_memory_sensitive_comp_blocked`, `session_memory_correction_applied`,
`session_memory_stale_context_rejected`, `provider_fallback_used`,
`provider_zero_token_empty`, `first_useful_token_recorded`.

### Wired emit sites (live)

- `IntelligenceEngine.ts` (WTA): `wta_live_session_memory_enabled` (with rollout
  reason/bucket/killSwitch), `wta_live_followup_resolved` (recalledKind/ageBucket —
  never the value), `wta_context_free_clarification`.
- `ipcHandlers.ts` (manual): `pi_answer_plan_created`, `pi_candidate_sanitizer_applied`,
  `pi_provider_error_classified`, `provider_fallback_used`.

### Delivery + cost

- Bounded 500-entry in-memory ring (`piTelemetry.recent(n)` for diagnostics).
- Optional `setSink()` for an analytics backend — the sink only ever sees scrubbed
  marker payloads; a throwing sink can never break the hot path (wrapped in try/catch).
- Marker line logged only when `NATIVELY_PI_TELEMETRY_DEBUG=true`.
- Pure, bounded, non-throwing.

## Tests

`RolloutAndTelemetry2026_06_07c.test.mjs` (21 subtests) includes adversarial scrub
tests proving the allowlist drops every HIGH leak vector (`recalledEntity`, `entity`,
`jdText`, bare-number `120000`, "wants 95000 base", SSN-bearing label, `city`,
`question`) while keeping legitimate markers, plus the value backstop (long free-text
and salary-shaped values dropped even under an allowed key).

## Metrics to monitor after rollout

WTA follow-up resolution success · context-free clarification count · memory recall
success/blocked-by-mode · comp-blocked count · candidate sanitizer count · provider
error count · fallback count · first-useful p95/p99 · 10s+ waits · identity/context
leak validator hits · crash rate · renderer/main process errors.

## Verdict

Release debugging is possible **without privacy risk** — the allowlist scrub makes the
"no raw sensitive content" guarantee structural (not a best-effort denylist), and it is
proven by adversarial unit tests.
