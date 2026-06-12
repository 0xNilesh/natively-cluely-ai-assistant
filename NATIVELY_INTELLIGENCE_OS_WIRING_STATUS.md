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

**Phase 3 verified by test-engineer agent.**

---

## Phase 4 — Wire OutputShapeNormalizer / Answer Diversity Guard Live
Status: **complete**
Goal: Apply answer-shape cleanup (empty bullets, scaffold labels) where it's missing.
**HONEST FINDING:** the MANUAL path already polishes live (ipcHandlers ~1255: cleanAnswerArtifacts + AnswerDiversityGuard + compressToSpeakable) → wiring there = redundant. The GAP: the WTA path (`runWhatShouldISay`) applies NO polish — empty "*" bullets and scaffold labels in default-style WTA answers reach the UI uncleaned. Phase 4 closed THAT.
Files changed: `electron/IntelligenceEngine.ts` (~line 1472, before addAssistantMessage/emit) — import normalizeOutputShape + isIntelligenceFlagEnabled; compute `finalWtaAnswer` via normalizeOutputShape behind `answer_diversity_guard_enabled`; thread it through addAssistantMessage/pushUsage/emit (single source, NO double-add).
Feature flags touched: `answer_diversity_guard_enabled` (env `NATIVELY_ANSWER_DIVERSITY_GUARD`, default OFF). OFF = finalWtaAnswer === fullAnswer byte-for-byte.
Tests added: `electron/intelligence/__tests__/WtaOutputShapeWiring.test.mjs` (11 tests, by test-engineer).
Tests run: typecheck **0** · build clean · intelligence **324 pass / 0 fail / 9 todo** · services **33 pass / 0 fail**.
Manual verification: deferred to Phase 15.
Result: ✅ test-engineer verdict: PASS all 5 — genuine gap-closer, no-op when OFF, safe when ON. Verified: NO duplicate addAssistantMessage (single call, confirmed by grep+test log); renderer REPLACES streamed text with normalized final via finalizeStreamingByIntent (traced into streamingTokenQueue.mjs/overlayMessagePersistence.mjs) — no garble; coding answers skipped; clean prose is a no-op; sub-10-char shrinks rejected.
Rollback: `NATIVELY_ANSWER_DIVERSITY_GUARD` unset = off. Revert the finalWtaAnswer block.
Notes: Streaming caveat handled — streamed tokens are pre-normalized, final emit replaces in place (the existing validate→repair pattern). Early-return WTA paths (provider-key error / clarification) aren't normalized but are deterministic canned text with no artifacts.

**Phase 4 verified by test-engineer agent.**

---

## Phase 5 — Wire ContextRouter Into Manual Answer Path
Status: **complete**
Goal: Make live routing explicit / prevent profile/RAG/mode confusion.
**HONEST FINDING:** the manual path ALREADY routes correctly via answerPlan (requiredContextLayers/forbiddenContextLayers/profileContextPolicy + CONTRACT/CANDIDATE_CONTRACT sets) — sales gets no profile, lecture no interview framing, identity no heavy RAG. ContextRouter is a COMPOSITION of the same deciders (planAnswer + decideProfileIntelligence) that already drive live. Having it DRIVE = regression risk, zero gain. So wired in **SHADOW/OBSERVE-ONLY** mode: compute the decision, record on the trace, emit a divergence telemetry marker — never gate the answer.
Files changed: `electron/ipcHandlers.ts` (~line 734) — import routeContext; shadow block behind `context_router_v2_enabled`; routerDecision read ONLY for telemetry + trace (verified by test-engineer: never touches context/streamChat/control flow).
Feature flags touched: `context_router_v2_enabled` (env `NATIVELY_CONTEXT_ROUTER_V2`, default OFF). OFF = block doesn't execute.
Tests added: `electron/intelligence/__tests__/ContextRouterShadowWiring.test.mjs` (14 tests, by test-engineer).
Tests run: typecheck **0** · build clean · intelligence **338 pass / 0 fail / 9 todo** · LLM baseline **1656 pass / 0 fail** · services **33 pass / 0 fail**.
Manual verification: deferred to Phase 15.
Result: ✅ test-engineer verdict: PASS (4 items) + 1 CONCERN fixed. Shadow is the right call (vs driving); genuinely zero-behavior-change; routeDecision never reaches the answer; negligible latency (pure, once-per-answer, off token path). **CONCERN FIXED:** the divergence proxy measured policy intent but ignored profile availability (false-fired on profile questions with no resume loaded) → AND'd `profileAvailable` into the proxy so the marker now fires only on a GENUINE disagreement when a profile exists.
Rollback: `NATIVELY_CONTEXT_ROUTER_V2` unset = off. Revert the shadow block.
Notes: This is "shadow-before-drive" validation + a consistency guard against future drift between the two routing representations. Low-value-but-harmless and the correct prerequisite before ever letting ContextRouter drive.

**Phase 5 verified by test-engineer agent.**

---

## Phase 6 — Wire LiveTranscriptBrain Into WTA Path
Status: **complete**
Goal: Make WTA use the current transcript correctly + fast.
**HONEST FINDING:** the WTA path ALREADY builds the hot window inline (IntelligenceEngine ~716: getContext(180) + interim injection) and extracts the question (extractLatestQuestion ~790) — exactly what LiveTranscriptBrain encapsulates, and it already meets every Phase-6 acceptance criterion (uses current question + recent context, no global search, no Hindsight). Replacing the proven inline window = pure refactor, regression risk, zero gain. NOTE: the brain's getHotWindow defaults to 30s vs the inline 180s — a naive swap would silently narrow the window (test-engineer caught this). So wired in **SHADOW/PARITY** mode.
Files changed: `electron/IntelligenceEngine.ts` (~line 790) — import LiveTranscriptBrain; shadow block behind `live_transcript_brain_enabled`: construct brain over the live session, record getCurrentQuestion + a brain_parity / brain_question_divergence marker on the trace. Output NEVER touches the answer.
Feature flags touched: `live_transcript_brain_enabled` (env `NATIVELY_LIVE_TRANSCRIPT_BRAIN`, default OFF). OFF = block doesn't execute.
Tests added: `electron/intelligence/__tests__/LiveBrainShadowWiring.test.mjs` (9 tests, by test-engineer).
Tests run: typecheck **0** · build clean · intelligence **347 pass / 0 fail / 9 todo** · services **33 pass / 0 fail**.
Manual verification: deferred to Phase 15.
Result: ✅ test-engineer verdict: PASS all 6. Shadow is the right call (vs replacing inline). Genuinely zero-behavior-change; all 4 SessionTrackerLike methods exist on SessionTracker (as-any hides no crash); brain crash-proof even with hostile session; ~4ms latency. HONEST: this phase ships NO user-visible behavior — its deliverable is a parity signal that de-risks a FUTURE refactor (and catches drift between the inline interim-injection and the brain's getContextWithInterim).
Rollback: `NATIVELY_LIVE_TRANSCRIPT_BRAIN` unset = off. Revert the shadow block.

**Phase 6 verified by test-engineer agent. "Must Finish First" tier (Phases 0–6) COMPLETE.**

---

## Phase 7 — Wire ContextFusionEngine + PromptAssemblerV2 Gradually
Status: **complete**
Goal: Use the new fusion + V2 assembly without breaking prompt quality. The prompt said: gradual, small path, preserve security, do NOT replace all assembly.
Approach: SHADOW. The live WTA prompt (`packet` from the benchmark-green V1 PromptAssembler at WhatToAnswerLLM.ts:354) is UNCHANGED (`const`, never reassigned). When flag on, run the SAME context blocks through fuseContext → toPromptContextContract → assemblePromptV2 to produce the spec's CONTEXT INCLUSION REPORT + trust tags, recorded on a trace. Zero effect on the real prompt/answer.
Files changed: `electron/llm/WhatToAnswerLLM.ts` (~line 369) — imports + shadow V2 pipeline block behind `prompt_assembler_v2_enabled`.
Feature flags touched: `prompt_assembler_v2_enabled` (env `NATIVELY_PROMPT_ASSEMBLER_V2`, default OFF). (Note: the spec's `context_fusion_v2_enabled` is folded into this one flag — fusion is part of the V2 pipeline; comment corrected after test-engineer caught the stale "BOTH flags" wording.)
Tests added: `electron/intelligence/__tests__/V2ShadowAssemblyWiring.test.mjs` (12 tests, by test-engineer).
Tests run: typecheck **0** · build clean · intelligence **359 pass / 0 fail / 9 todo** · LLM baseline **1656 pass / 0 fail / 10 skipped** · services **33 pass / 0 fail**.
Manual verification: deferred to Phase 15.
Result: ✅ test-engineer verdict: PASS all 5. Real packet const-immutable + untouched (verified); V2 genuinely preserves security end-to-end (injection neutralized+escaped, profile_tree ordered before untrusted, low-trust trimmed first, system/profile never dropped, report content-free); negligible latency (pure string ops, off token path); inclusion report meaningful over real WTA inputs.
Rollback: `NATIVELY_PROMPT_ASSEMBLER_V2` unset = off. Revert the shadow block.
Notes: Scaffolding-with-purpose — ships no user-visible behavior; de-risks an eventual V2 cutover by proving a sound, security-preserving assembly over live inputs. Shadow omits the `mode` fusion option (correct for candidate-voice WTA; revisit if extended to sales/lecture).

**Phase 7 verified by test-engineer agent.**

---

## Phase 8 — Wire MeetingMemoryService Into Post-Meeting Pipeline
Status: **complete**
Goal: Make meeting memory real + persisted (not just in-memory).
Files changed: `electron/MeetingPersistence.ts` (~line 346, after buildPostCallEnhancements) — import MeetingMemoryService + isIntelligenceFlagEnabled; behind `meeting_memory_v2_enabled`, call buildMeetingRecord(data.transcript) and write the structured memory into `summaryData.meetingMemory` (NEW key → flows into summary_json).
Feature flags touched: `meeting_memory_v2_enabled` (env `NATIVELY_MEETING_MEMORY_V2`, default OFF). OFF = summaryData byte-for-byte unchanged.
Tests added: `electron/intelligence/__tests__/MeetingMemoryWiringExtraction.test.mjs` (10 tests, by test-engineer).
Tests run: typecheck **0** · build clean · meeting-specific (MeetingPersistenceRace + PostCall*) **15 pass / 0 fail** · intelligence **369 pass / 0 fail / 9 todo** · services **1299 pass / 41 fail (PRE-EXISTING, 0 meeting-related) / 30 skipped** (41 verified identical with+without the change by stashing).
Manual verification: deferred to Phase 15.
Result: ✅ test-engineer verdict: PASS all 5. Safe to persist: flag-OFF zero-change; flag-ON additive (new JSON key, NO DB migration), backward-compatible (readers JSON.parse and tolerate missing/extra keys), runs in the ALREADY-BACKGROUND processAndSaveMeeting worker (can't block live answers), non-fatal on error (double try/catch, save in a separate try block). Deterministic no-LLM extraction genuinely works (pricing question, pilot decision, redis skill, participants, bounded sourceQuality).
**RACE INVESTIGATION (prompt asked):** the "double summary / chunk-not-found / embedding race" is NOT a real live bug — the RAG pipeline is already guarded by main.ts `_ragProcessingInFlight` Set + INSERT OR IGNORE; the summary path is idempotent via INSERT OR REPLACE; processAndSaveMeeting's two callers (stopMeeting / recoverUnprocessedMeetings@is_processed=0) don't overlap. Phase 8 adds no new write/query/async surface. Nothing to fix.
Rollback: `NATIVELY_MEETING_MEMORY_V2` unset = off. Revert the meetingMemory block.
Notes: meetingMemory persisted untyped (`as any`) — no compile-time contract on readers yet (the cost of a zero-migration additive key; add the optional typed field when a consumer reads it).

**Phase 8 verified by test-engineer agent.**

---

## Phase 9 — Replace Fake Global Search With SearchOrchestrator
Status: **complete**
Goal: Make global meeting search real (the Launcher "literal search" was fake — re-ran the AI query).
Files changed: `electron/ipcHandlers.ts` (NEW IPC `search:global-meetings` after get-meeting-details — builds SearchCandidate[] from local meetings' title+summary+overview+keyPoints+Phase-8 meetingMemory, ranks via SearchOrchestrator.globalSearch), `electron/preload.ts` (+searchGlobalMeetings), `src/types/electron.d.ts` (+type), `src/components/Launcher.tsx` (onLiteralSearch now async — real search when flag on, opens top result; falls back to AI query otherwise).
Feature flags touched: `global_search_v2_enabled` (env `NATIVELY_GLOBAL_SEARCH_V2`, default OFF). OFF = IPC returns {enabled:false}, renderer fallback byte-identical to original.
Tests added: `electron/intelligence/__tests__/GlobalSearchHandlerLogic.test.mjs` (8 tests, by test-engineer).
Tests run: typecheck:electron **0** · renderer tsc **0** · build clean · intelligence **377 pass / 0 fail / 9 todo**.
Manual verification: deferred to Phase 15.
Result: ✅ test-engineer verdict: PASS all 5. REAL local search (not the fake AI passthrough); safe flag OFF (zero renderer change, IPC empty); safe flag ON (no crash on empty DB / old meetings / no match; correct fallback). NO Hindsight (local-first). Isolation invariant holds (single-user 'local' scope; foreign userId dropped). **CONCERN FIXED:** handler scanned 200 meetings but renderer holds 50 → top hit in #51-200 silently fell back → aligned both to 50 so a returned result is always openable.
Rollback: `NATIVELY_GLOBAL_SEARCH_V2` unset = off. Revert the 4 file edits.
Notes (honest v1 limitations, test-engineer-acknowledged-acceptable): opens the top hit directly rather than showing a result list with snippets (the data is there for a list — presentation choice); lexical search is naive (substring, no stemming/fuzzy/semantic — semantic recall is what the AI-query fallback is for).

Post-commit: a React Doctor commit-hook flagged the staged Launcher.tsx. Investigated — the ~30 findings are PRE-EXISTING throughout the 1200-line file (lines 292/384/873/1050/…), ZERO at my changed lines (421-446); the hook flags the whole file when any line is staged. Did NOT mass-refactor pre-existing issues (out of scope, rule 3). DID fix the one genuine concern my code could introduce: made onLiteralSearch synchronous (prop is `(q)=>void`) with the async work in a voided IIFE, so no floating Promise is returned to the event-handler prop. Renderer tsc 0.

**Phase 9 verified by test-engineer agent.**

---

## Phase 10 — Wire In-Meeting Search
Status: **complete**
Goal: Fast local-first in-meeting search over the current meeting transcript.
Files changed: `electron/IntelligenceManager.ts` (+getCurrentMeetingTranscript accessor over session.getFullTranscript), `electron/ipcHandlers.ts` (NEW IPC `search:in-meeting` → SearchOrchestrator.inMeetingSearch over current transcript, behind in_meeting_search_v2_enabled), `electron/preload.ts` + `src/types/electron.d.ts` (+searchInMeeting), `electron/intelligence/SearchOrchestrator.ts` (scoring fix — see below).
Feature flags touched: `in_meeting_search_v2_enabled` (env `NATIVELY_IN_MEETING_SEARCH_V2`, default OFF). OFF = IPC returns {enabled:false}.
Tests added: `electron/intelligence/__tests__/InMeetingSearchHandlerLogic.test.mjs` (9 tests, by test-engineer).
Tests run: typecheck:electron **0** · renderer tsc **0** · build clean · intelligence **386 pass / 0 fail / 9 todo**.
Manual verification: deferred to Phase 15.
Result: ✅ test-engineer verdict: PASS all 5. Real capability (deterministic local search, ~3.2ms median for 1000-turn meeting, jump-to-segment timestamps + speaker preserved); safe flag OFF (immediate no-op before session read); safe flag ON (no crash on empty/no-active-meeting; no Hindsight/RAG/network). Backend IPC fully wired+typed+tested; renderer search-box UI is a separate phase (reasonable boundary).
**SCORING FIX (test-engineer caught):** inMeetingSearch score was `min(1, hits/terms + 0.5phrase)` — coverage clamped the phrase bonus to invisibility when all terms matched (phrase priority lost to the timestamp tiebreak). Fixed to `min(1, 0.7*coverage + 0.3phrase)` so a contiguous phrase always outranks a fully-covered scattered match. Improves both global + in-meeting ranking; all 32 search tests green (updated the b2 test that documented the old behavior).
Rollback: `NATIVELY_IN_MEETING_SEARCH_V2` unset = off. Revert the IPC + accessor (scoring fix is a strict improvement, safe to keep).

**Phase 10 verified by test-engineer agent.**

---

## Phase 11 — Wire ConversationMemoryService for Same-Session Follow-Ups
Status: **complete**
Goal: Make bare follow-ups work in the SINGLE-SHOT manual chat path (no history threaded → "make that shorter"/"why?" hit a dead-end clarification).
Files changed: `electron/ipcHandlers.ts` (per-process `_manualConversationMemory`; record each delivered manual turn keyed by senderId; on a bare follow-up with no context, behind conversation_memory_v2_enabled, resolveSameSession → synthesize a "PRIOR EXCHANGE" context block so it flows to the LLM instead of the clarification), `electron/intelligence/intelligenceFlags.ts` (+conversationMemoryV2 flag key — was missing), `electron/intelligence/ConversationMemoryService.ts` (recency-fallback fix — see below), `__tests__/IntelligenceFlags.test.mjs` (ALL_FLAG_KEYS +1).
Feature flags touched: `conversation_memory_v2_enabled` (env `NATIVELY_CONVERSATION_MEMORY_V2`, default OFF). OFF = recovery block skipped (flag is the last AND clause), original clarification fires byte-for-byte.
Tests added: `electron/intelligence/__tests__/ConversationMemoryWiring.test.mjs` (14 tests, by test-engineer).
Tests run: typecheck **0** · build clean · intelligence **401 pass / 0 fail / 9 todo** · LLM baseline **1656 pass / 0 fail** · flags **9/0**.
Manual verification: deferred to Phase 15.
Result: ✅ test-engineer verdict: PASS on all safety items (flag-OFF byte-identical; NO cross-session leak — keyed by senderId, proven; NO stealth-context resurfacing — gated by isBareFollowUp which excludes multi-word asks; can't crash — record+recovery both try/catch; bounded — MAX_TURNS_PER_SESSION=100). + 1 CONCERN FIXED.
**CONCERN FIXED:** resolveSameSession's recency-fallback regex was too narrow (only that/it/this/continue/and) → common bare follow-ups (why?/how?/go on/expand/tell me more/…) returned null and still dead-ended. Widened to cover content-free continuation/clarification verbs (safe: bare follow-ups are content-free by construction + a <=6-word library guard + the handler's isBareFollowUp gate). Now they resolve to the most-recent turn. Updated the test that documented the old gap.
Rollback: `NATIVELY_CONVERSATION_MEMORY_V2` unset = off. Revert the ipcHandlers blocks (the flag key + regex widening are safe to keep).
Notes (honest): only the manual single-shot path needed this (WTA already has liveSessionMemory). Cross-session recall (recallCrossSession) intentionally NOT wired (that's Hindsight, Phase 13/16). Unbounded axis = distinct senderIds, but those are renderer webContents ids (few per app run, each capped at 100 turns) — no practical leak.

**Phase 11 verified by test-engineer agent. Proceeding to Phase 12 (autopilot).**
