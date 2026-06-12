# Natively Intelligence OS — Wiring Status

Live-wiring of the tested `electron/intelligence/` library into the real Natively app, one phase at
a time, behind feature flags. Working dir: `/Users/evin/natively-cluely-ai-assistant`. Branch:
`feature/intelligence-os-live-wiring` (off `main`).

**Gate commands:** `npm run typecheck:electron` · `npm run build:electron` ·
`node --test "electron/intelligence/__tests__/**/*.test.mjs"` ·
`node --test electron/services/__tests__/IntelligenceEngine*.test.mjs`

---

## Phase 0 — Wiring Audit and Safety Baseline
Status: **complete**
Goal: Map live call paths + attach points; establish a clean test/typecheck baseline. No behavior change.

### Baseline (recorded)
- `build:electron` ✅ clean
- intelligence tests ✅ **228 pass / 0 fail**
- IntelligenceEngine services tests ✅ **33 pass / 0 fail**
- `typecheck:electron`: was **2 errors** — a PRE-EXISTING literal duplicate of `applyInitialDisguise()`
  at `electron/main.ts:5235/5239` (unrelated to intelligence work; present on `main`). **Fixed** by
  deleting the exact duplicate method → now **0 errors**. This is the only non-intelligence edit, made
  solely to get a clean typecheck gate so later phases' errors are detectable. (rule 8)

### Verified wiring gap
`grep -rn "intelligence/" electron --include="*.ts" | grep -v electron/intelligence/ | grep -v __tests__`
→ **NONE.** Confirmed: no live app file imports the intelligence library yet.

### Live call-path map + ATTACH POINTS (verified file:line)

**Manual answer path** — `electron/ipcHandlers.ts`, handler `gemini-chat-stream` (562–1393):
- `:698` planAnswer (question classification) → **IntelligenceTrace start + ContextRouter capture**
- `:769-792` buildManualProfileBackendAnswer (deterministic profile fast-path); emits at `:782` (token) / `:783` (final) → **ProfileTreeService attach ~:772**
- `:897-914` streamChat (provider boundary)
- `:930` sendChunk (token emit); `:967` markFirstUseful
- `:1269` final answer emit; `:1278-1283` add assistant message
- `:1211-1261` answerPolish block; `:1223-1228` cleanAnswerArtifacts; `:1243-1257` diversity check → **OutputShapeNormalizer attach :1223**

**WTA path** — `generate-what-to-say` (ipcHandlers `:3934-4100`) → `IntelligenceManager.runWhatShouldISay` (`:152`) → `IntelligenceEngine.runWhatShouldISay` (`electron/IntelligenceEngine.ts:584+`):
- `:707` `getContext(180)` transcript window → **LiveTranscriptBrain attach**
- `:781` extractLatestQuestion
- **`:819` `getContext(this.LIVE_MEMORY_WINDOW_SECONDS)` ← THE DURABLE-MEMORY BUG SITE** (LIVE_MEMORY_WINDOW_SECONDS=7200 declared `:130`)
- `:836-842` resolveLiveFollowup

**Flags** — `electron/intelligence/intelligenceFlags.ts` exists; exports `isIntelligenceFlagEnabled` (`:129`), `isIntelligenceTraceEnabled` (`:139`), `isDurableMemoryWindowEnabled` (`:146`), `isIntelligenceOsEnabled` (`:153`), `intelligenceFlagSnapshot`. Pattern: `process.env.NATIVELY_*` → SettingsManager → default (matches profileGroundingV2.ts / liveSessionMemoryConfig.ts). 16 flags, all default OFF.

**Post-meeting pipeline** — `MeetingPersistence.stopMeeting` (`:27`) → async `processAndSaveMeeting` (`:138-406`): LLM summary `:302`, parse `:304-334`, enhancements `:339-346`, build+save `:351-370` → `DatabaseManager.saveMeeting` (`:1137`) writes `summary_json` (`:1170`). RAG: `main.ts:4207` `ragManager.processMeeting`. → **MeetingMemoryService attach MeetingPersistence.ts:339** (after summary, before save).

**Global/in-meeting search** — `rag:query-global` (ipcHandlers `:4789-4820`, call `:4803`), `rag:query-live` (`:4734-4787`, call `:4763`). Renderer fake literal search: `src/components/Launcher.tsx:421-427` (`// For now, also use AI query for literal search` at `:422`). → **GlobalSearchV2 attach ipcHandlers:4803; InMeetingSearchV2 attach :4763; renderer reroute Launcher.tsx:422**

Files changed: `electron/main.ts` (pre-existing duplicate-method removal only).
Feature flags touched: none.
Tests added: none (audit phase).
Tests run: typecheck (0 after fix), build (clean), intelligence (228/0), services (33/0).
Manual verification: n/a (no behavior change).
Result: ✅ Baseline clean, attach points mapped, wiring gap confirmed.
Rollback: revert the 4-line `main.ts` duplicate removal.
Notes: Repo moved since the prompt was written — now on `main` in `natively-cluely-ai-assistant`, not the `natively-main-pi` worktree (that was merged + removed). The manual path uses `buildManualProfileBackendAnswer` (not `tryBuildManualProfileFastPathAnswer` directly) — ProfileTreeService wiring must compose with that existing fast-path, not bypass it.

---

## Phase 1 — Observe-Only IntelligenceTrace Wiring
Status: **complete**
Goal: Wire IntelligenceTrace into the live manual + WTA paths, observe-only, behind `intelligence_trace_enabled` (env `NATIVELY_INTELLIGENCE_TRACE`, default OFF).
Files changed:
- `electron/ipcHandlers.ts` — `gemini-chat-stream`: import beginTrace/commitTrace; hoisted `iTrace` (NOOP placeholder, reassigned after planAnswer); setRouting after planAnswer; commits at 4 exits (clarification, profile fast-path, normal stream, catch+noteError) + the app-identity canned-reply path.
- `electron/IntelligenceEngine.ts` — `runWhatShouldISay`: import beginTrace/commitTrace; `wtaTrace` at entry; commit at the primary `suggested_answer` emit.
Feature flags touched: `intelligence_trace_enabled` (reads existing flag; default OFF — added in the library, no new flag).
Tests added: `electron/intelligence/__tests__/TraceWiringObserveOnly.test.mjs` (9 tests, by test-engineer) proving flag-OFF = 0 records/unchanged, flag-ON = exactly-one record with hashed query, raw query never stored.
Tests run: typecheck **0 errors** · build clean · intelligence **237 pass / 0 fail** · IntelligenceEngine services **33 pass / 0 fail** · LLM baseline **1656 pass / 0 fail / 10 skipped**.
Manual verification: deferred to Phase 15 live app run (no GUI here). Trace is observe-only so no behavior to verify live yet.
Result: ✅ test-engineer agent verdict: SAFE TO SHIP with flag OFF. Observe-only contract proven; cannot throw into the answer (defense-in-depth); zero-cost when off (one env read + Set lookups per answer, no per-token cost); privacy confirmed (sha256 query hash).
Rollback: `NATIVELY_INTELLIGENCE_TRACE` unset = already off (default). To remove entirely: revert the ipcHandlers.ts + IntelligenceEngine.ts trace edits.
Notes (honest gaps, observability-only, NOT safety): a few rare WTA early-returns (cooldown throttle, legacy answerLLM path, streamAborted, sentinel-decline, graceful-retry) don't commit a trace even when ON — an uncommitted trace is GC'd, no leak. The common manual paths (fast-path, clarification, normal stream, app-identity, errors) and the primary WTA path ARE traced.

**Phase 1 verified by test-engineer agent. Proceeding to Phase 2 (autopilot).**
