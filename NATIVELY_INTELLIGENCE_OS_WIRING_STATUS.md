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

**Phase 1 verified by test-engineer agent.**

---

## Phase 2 — Wire the Durable Memory Bug Fix Live
Status: **complete**
Goal: Fix the verified live-memory bug — `runWhatShouldISay` read the long-range follow-up window from `getContext(7200)` (capped to ~120s by contextItems eviction); route it to `getDurableContext(7200)` (durable fullTranscript) behind `durableMemoryWindow`.
Files changed: `electron/IntelligenceEngine.ts` (~line 826) — import `isDurableMemoryWindowEnabled`; flag-gated ternary selecting the memory source. (SessionTracker.getDurableContext already existed/tested from the library build.)
Feature flags touched: `durableMemoryWindow` (env `NATIVELY_DURABLE_MEMORY_WINDOW`, default OFF). OFF = original getContext path byte-for-byte.
Tests added: `electron/intelligence/__tests__/DurableMemoryWiring.test.mjs` (9 tests, by test-engineer) — drives the REAL SessionTracker: proves getContext(7200) loses a minute-1 entity after eviction (the bug) while getDurableContext(7200) retains it (the fix); shape contract; flag flips source.
Tests run: typecheck **0** · build clean · intelligence **246 pass / 0 fail / 9 todo** · IntelligenceEngine services **33 pass / 0 fail** · `benchmark:livememory` ran offline **100 scenarios 100% / p95 1ms**.
Manual verification: deferred to Phase 15 live run ("client is Mark, topic Redis scaling" → after 2 min ask "what was the client and topic?" with flag ON → recalls Mark + Redis scaling).
Result: ✅ test-engineer verdict: PASS all 5 items. Fix correct (targets the right method), flag-OFF is a true no-op (double-gated behind lsmConfig.enabled too), no downstream regression. Edge cases checked: assistant turns already present in OFF path (no new role); growth bounded (fullTranscript compaction + SessionMemory 200-item cap); durable === getContext when nothing evicted.
Rollback: `NATIVELY_DURABLE_MEMORY_WINDOW` unset = off (default). Revert the ternary to restore the single getContext call.
Notes (honest): `benchmark:livememory` does NOT touch SessionTracker, so it does NOT cover this source-swap — the real proof is DurableMemoryWiring.test.mjs. To actually USE this fix in production, flip the flag ON (recommended after a live soak).

**Phase 2 verified by test-engineer agent.**

---

## Phase 3 — Wire ProfileTreeService Into Live Manual/Profile Questions
Status: **complete**
Goal: Strengthen the no-assistant-identity guard for misclassified candidate-identity asks.
**HONEST FINDING:** the manual path ALREADY has a robust 3-layer identity guard (identity-probe short-circuit @602, deterministic profile fast-path `buildManualProfileBackendAnswer` @798, post-stream candidate sanitizer @1203) — all using the same `tryBuildManualProfileFastPathAnswer` that ProfileTreeService wraps. So re-wiring ProfileTreeService's identity ANSWERS would be REDUNDANT (the "I'm Natively" bug was already fixed in prior work; Phase-2 baseline tests confirm). The real GAP: the layer-3 sanitizer triggers on `CANDIDATE_VOICE_ANSWER_TYPES.has(answerType)` — so a candidate-identity ask MISCLASSIFIED to a non-candidate answerType (e.g. general_meeting_answer) skips the assistant-meta strip and could leak "I'm Natively".
Files changed: `electron/ipcHandlers.ts` (~line 1203) — import ProfileTreeService + isIntelligenceFlagEnabled; compute mode-based `ProfileTreeService.getCandidatePerspectiveGuard(mode, query)` behind `profile_tree_v2_enabled` to WIDEN the existing sanitizer trigger (independent of answerType).
Feature flags touched: `profile_tree_v2_enabled` (env `NATIVELY_PROFILE_TREE_V2`, default OFF). OFF = `|| false` = byte-identical original trigger.
Tests added: `electron/intelligence/__tests__/PerspectiveGuardWiring.test.mjs` (67 tests, by test-engineer).
Tests run: typecheck **0** · build clean · intelligence **313 pass / 0 fail / 9 todo** · LLM baseline **1656 pass / 0 fail** · services **33 pass / 0 fail**.
Manual verification: deferred to Phase 15.
Result: ✅ test-engineer verdict: PASS all 5 — genuine gap-closer (not redundant), no-op when OFF, safe when ON (never over-strips: app questions are exempted by the guard, sales mode never widens, the sanitizer is a verified no-op on clean answers).
Rollback: `NATIVELY_PROFILE_TREE_V2` unset = off (default). Revert the `_perspectiveExpectsCandidate` block.
Notes: This is a DEFENSE-IN-DEPTH net, not a rewrite of identity routing (rule 2 honored — deterministic identity routing untouched).

**Phase 3 verified by test-engineer agent. Proceeding to Phase 4 (autopilot).**
