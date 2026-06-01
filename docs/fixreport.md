# Fix Report / Changelog — Embedding Migration

Running changelog for the embedding-system upgrade (2026-06-01). Newest first.

---

## FIX-006 — `bad_request` no longer stamps failReason on a healthy slot (cosmetic)
- **Issue found:** A 400 (`bad_request`) wrote `h.failReason` even though it doesn't open
  the breaker, so `/health` could momentarily show `failReason:'bad_request'` with `healthy:true`.
- **Root cause:** Early-return branch set `failReason` before returning.
- **Files changed:** `natively-api/server.js` (`markEmbeddingFailed` ~`:785`).
- **Before:** healthy slot could display a fault reason.
- **After:** `bad_request` returns immediately, touches nothing.
- **Tests:** code-reviewer re-pass (LOW resolved); `node --check` OK.

## FIX-005 — Telemetry semantics corrected (HIGH ×2)
- **Issue found:** (a) `fallback_used` only incremented on fallback *success*, hiding
  cases where the fallback slot was circuit-open. (b) `byModel` (attempt-level) silently
  disagreed with request-level `success/failure`, misleading on-call.
- **Root cause:** counter placement + unlabeled mixing of request- vs attempt-level metrics.
- **Files changed:** `natively-api/server.js` (`getEmbedding` ~`:2998`, `embedTelemetry`
  `:2147`, `embedTelemetrySnapshot` `:2180`, `tryEmbedSlot` `:2961`).
- **Before:** `fallback_used` = fallback-succeeded; `by_model` looked broken vs headline.
- **After:** `fallbackUsed`++ on fallback *attempt* (truthful when breaker open);
  `badRequest` counter added; renamed `by_model_attempts` with documented semantics.
- **Tests:** code-reviewer re-pass VERIFIED counted-exactly-once.

## FIX-004 — Non-destructive circuit half-open (HIGH)
- **Issue found:** `embeddingSlotAvailable` called `markEmbeddingHealthy` on read, so a
  `/health` poll could "heal" a provider that never served a request and wipe `failReason`.
- **Root cause:** read-with-side-effect in the availability check.
- **Files changed:** `natively-api/server.js` (`embeddingSlotAvailable` `:815`).
- **Before:** mutation-on-read; flapping providers reset their strike count via /health.
- **After:** pure check; only `tryEmbedSlot` success clears the breaker. Cooldown still
  guarantees a half-open probe, so no permanent lockout.
- **Tests:** health state-machine unit (half-open preserves failReason); code-reviewer VERIFIED.

## FIX-003 — CRITICAL: 400 could disable BOTH embedding slots (self-inflicted outage)
- **Issue found:** `classifyEmbedHttp` mapped 400→`model_error`, which opened the breaker
  on the FIRST failure. A request-shaped 400 (e.g. empty/oversized content) 400s on both
  primary and fallback → both slots disabled for 5 min from one bad input. (Confirmed
  reachable: live probe showed empty string → HTTP 400.)
- **Root cause:** conflating per-request 400 with provider-down 404.
- **Files changed:** `natively-api/server.js` (`classifyEmbedHttp` `:2873`, `markEmbeddingFailed` `:780`).
- **Before:** one malformed input → 5-min embedding outage for all users.
- **After:** 400→`bad_request` (never opens breaker, never increments failCount); 404 stays
  `model_error` (opens breaker — config-level, affects all requests equally).
- **Tests:** health state-machine unit — "400 both slots still available" PASS; "404 disables
  primary" PASS. code-reviewer re-pass: CRITICAL resolved.

## FIX-002 — Server embedding waterfall + health + telemetry (the migration)
- **Issue found:** Server primary `text-embedding-004` returns 404 on the key (verified
  live) — production silently ran entirely on `gemini-embedding-001` after a wasted
  round-trip + warning per call. No embedding observability.
- **Root cause:** dead/retired model left as primary; no health tracking for embeddings.
- **Files changed:** `natively-api/server.js` (model constants, `providerHealth`,
  `mark*`/`embeddingSlotAvailable`, `callEmbedModel`, `tryEmbedSlot`, `getEmbedding`,
  `shipEmbedMetric`, `/health`).
- **Before:** `004 → 001`, no health, no telemetry, hardcoded 768.
- **After:** `[004 if flagged] → gemini-embedding-2 → gemini-embedding-001`; env-driven
  models/dims; circuit breaker; full telemetry; dimension guard; `/health` block.
- **Tests:** live ListModels + embedContent (2/2 models 200@768, 004=404); 100-concurrent
  live stress (100/100, 0 fallback, 0 dim errors); booted-server `/health` + `/v1/embed` auth.

## FIX-001 — Audit gate (Phases 0–3), no code change
- **Issue found:** Mission premises required verification: model name, who embeds, vector spaces.
- **Findings:** desktop embeds locally (not via server); desktop already on `gemini-embedding-2`
  with space-keyed re-index safety; `gemini-embedding-2` confirmed real via live API;
  `text-embedding-004` dead (404); no code expects 3072 dims.
- **Docs:** `app-api-contract-audit.md`, `embedding-migration-analysis.md`,
  `google-embedding-verification.md`, `vector-dimension-audit.md`.
- **Result:** scope corrected to "server fix + verify desktop" (user-approved).
