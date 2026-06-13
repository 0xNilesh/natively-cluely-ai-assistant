# Intelligence OS — Live-Wiring Verification (evidence-backed)

**Repo:** `/Users/evin/natively-cluely-ai-assistant` · **Branch:** `fix/whisper-external-data-download`
**Date:** 2026-06-13 · **Method:** static call-graph trace (rg + Read), flag-fork tracing per module, renderer-caller confirmation.

**Headline:** The Intelligence OS is *imported* into the live app, but it is overwhelmingly **SHADOW / library-only / UI-less**. Of 16 modules, the count that actually change a user-visible answer/DB-write when their flag is flipped is small, and **every behavior-changing flag is default OFF with NO renderer UI to turn it on** (only `env NATIVELY_*` or a programmatic `setIntelligenceFlag` IPC that no renderer calls). The app is local-first and runs identically with the whole OS disabled, which is the default shipping state.

---

## PART A — STATIC WIRING TABLE

Flag resolution precedence (verified `intelligenceFlags.ts:131-138`): env `NATIVELY_*` → `SettingsManager.get(setting)` → default. All 17 flags default **OFF** (`intelligenceFlags.ts:65-91`). No cache (read fresh each call).

| Module | Exists? | Imported by live (non-test)? | Live call-site file:line | Flag | Default | Flipping flag ON changes behavior? (traced) | Evidence | Status |
|---|---|---|---|---|---|---|---|---|
| **ProfileTreeService** | Yes | Yes | `ipcHandlers.ts:24, 1339-1342` | `profileTreeV2` | OFF | **YES.** `getCandidatePerspectiveGuard` sets `_perspectiveExpectsCandidate`, which widens the sanitizer trigger at `ipcHandlers.ts:1344` (`CANDIDATE_VOICE_ANSWER_TYPES.has(...) \|\| _perspectiveExpectsCandidate`) → can run `sanitizeCandidateAnswer`/fallback on a misclassified answer that would otherwise leak "I'm Natively". Different final text. | `ipcHandlers.ts:1337-1361` | **LIVE** (flag-gated, default off) |
| **LiveTranscriptBrain** | Yes | Yes | `IntelligenceEngine.ts:32, 802-811` | `liveTranscriptBrain` | OFF | **NO.** Constructed, `getCurrentQuestion(180)` computed, result written to trace with `included: false` and a parity/divergence reason ONLY. Explicit comment "run the brain in SHADOW … ZERO behavior change". Answer uses the inline-extracted question regardless. | `IntelligenceEngine.ts:793-812` | **SHADOW ONLY** |
| **ContextRouter** | Yes | Yes | `ipcHandlers.ts:26, 776-803` (routeContext); `1014` (isBackwardLookingQuery) | `contextRouterV2` (router); recall gate uses `isBackwardLookingQuery` under `hindsightLiveRecall` | OFF | **routeContext = NO** (shadow: only emits `pi_context_policy_applied` telemetry on divergence, comment "never affects the answer", `:804`). **`isBackwardLookingQuery` = YES** but only as the gate for Hindsight recall (counted under Hindsight, not the router flag). | `ipcHandlers.ts:769-804` (shadow); `1009-1014` (gate) | **SHADOW ONLY** (router decision); the exported `isBackwardLookingQuery` helper is LIVE as a Hindsight gate |
| **ContextFusionEngine** | Yes | Yes | `WhatToAnswerLLM.ts:10, 393` | `promptAssemblerV2` | OFF | **NO.** `fuseContext`/`toPromptContextContract` feed only the V2 inclusion report on a shadow trace. The real `packet` is a `const`, never reassigned. Comment "ZERO effect on the real answer". | `WhatToAnswerLLM.ts:373-407` | **SHADOW ONLY** |
| **PromptAssemblerV2** | Yes | Yes | `WhatToAnswerLLM.ts:11, 395-405` | `promptAssemblerV2` | OFF | **NO.** `assemblePromptV2(...)` output drives only `shadowTrace.noteContext(...)` + `commitTrace`. Real prompt unchanged. | `WhatToAnswerLLM.ts:382-407` | **SHADOW ONLY** |
| **OutputShapeNormalizer** | Yes | Yes | `IntelligenceEngine.ts:31, 1496-1499` | `answerDiversityGuard` | OFF | **YES.** When on, `normalizeOutputShape(...)` can set `finalWtaAnswer = shaped.text` (strips empty `*` bullets / scaffold labels), and that normalized text is what gets `addAssistantMessage`'d + emitted (`:1502, :1511`). Flag off → `finalWtaAnswer === fullAnswer`. | `IntelligenceEngine.ts:1494-1516` | **LIVE** (flag-gated, default off) |
| **MeetingMemoryService** | Yes | Yes | `MeetingPersistence.ts:10, 362-380` | `meetingMemoryV2` | OFF | **YES (DB write).** `buildMeetingRecord` output is written into `summaryData.meetingMemory` (`:369`) which is persisted to `meetings.summary_json` (`DatabaseManager.ts:1144`, JSON, no migration). Flag off → `summaryData` byte-for-byte unchanged. Background worker only (never blocks live answer). | `MeetingPersistence.ts:351-384`; `db/DatabaseManager.ts:192-197,1144` | **LIVE** (flag-gated, default off; post-meeting only) |
| **SearchOrchestrator** | Yes | Yes | `ipcHandlers.ts:27, 4085` (global), `4106` (in-meeting) | `globalSearchV2`, `inMeetingSearchV2` | OFF | **global = YES & REAL.** Scans `getRecentMeetings(50)`, builds lexical `SearchCandidate[]` from title/summary/`meetingMemory`, ranks via `globalSearch`. Renderer (`Launcher.tsx:437`) calls it and opens the top meeting; falls back to AI-query only on flag-off/no-match. **in-meeting = YES but NO RENDERER CALLER.** | `ipcHandlers.ts:4003-4091, 4100-4112`; `Launcher.tsx:421-448` | **PARTIALLY LIVE** — global LIVE+wired-to-UI; in-meeting is a real handler with **no UI caller** |
| **ConversationMemoryService** | Yes | Yes | `ipcHandlers.ts:565-566, 836` | `conversationMemoryV2` | OFF | **YES.** On a bare follow-up with no context, `resolveSameSession(...)` injects a "PRIOR EXCHANGE" block into `context` (`:838`), changing the answer from a dead-end clarification to an LLM resolution. Flag off → original clarification path. | `ipcHandlers.ts:827-842` | **LIVE** (flag-gated, default off) |
| **LectureIntelligenceService** | Yes | Yes | `ipcHandlers.ts:4122-4130` (handler `lecture:generate-notes`) | `lectureIntelligenceV2` | OFF | **Handler produces real output**, but **NO RENDERER CALLER** (`generateLectureNotes` exposed in preload `:1437` but never invoked in `src/`). Backend-only contract; no UI. | `ipcHandlers.ts:4119-4136`; preload `:1437`; no `src/` caller | **NOT WIRED** (backend IPC with no UI) |
| **DiagramIntelligenceService** | Yes | Yes | `ipcHandlers.ts:4147-4158` (handler `diagram:generate`) | `diagramIntelligence` | OFF | **Handler produces a validated Mermaid diagram**, but **NO RENDERER CALLER** (`generateDiagram` exposed preload `:1438`, never invoked in `src/`). | `ipcHandlers.ts:4143-4164`; preload `:1438`; no `src/` caller | **NOT WIRED** (backend IPC with no UI) |
| **LongTermMemoryService** | Yes | Yes | `MeetingPersistence.ts:11, 425-431`; `ipcHandlers.ts:1016-1020` (live recall), `4063-4066` (global) | `hindsightMemory` + `hindsightLiveRecall` / `hindsightPostMeetingRetain` | OFF | **YES when fully enabled.** Live recall injects a "RELEVANT LONG-TERM MEMORY" block into `context` (`ipcHandlers.ts:1024-1025`). But **`fromFlags` returns NoopMemoryProvider** unless `hindsightMemory` ON **AND** a `baseUrl` configured **AND** the optional client installed (`LongTermMemoryService.ts:41-45`). Default = Noop = recall returns `[]`. | `LongTermMemoryService.ts:38-49`; `ipcHandlers.ts:997-1033` | **PARTIALLY LIVE** (Noop by default; LIVE only with flags+server+client) |
| **HindsightClientAdapter** | Yes | Yes | `LongTermMemoryService.ts:19, 43`; type-only in `HindsightManager.ts:19` | (via `hindsightMemory`) | OFF | **YES when configured.** Lazy-requires optional `@vectorize-io/hindsight-client` (`:44`); if not installed, `enabled=false` → Noop. Real retain (async queue) + recall (AbortController + 800ms `Promise.race`). | `HindsightClientAdapter.ts:40-49, 58-71, 94-132` | **PARTIALLY LIVE** (Noop unless optional client present + configured) |
| **IntelligenceTrace** | Yes | Yes | `IntelligenceEngine.ts:29`; `ipcHandlers.ts:23`; `WhatToAnswerLLM.ts:12`; `ContextRouter.ts` | `trace` | OFF | **NO.** `beginTrace` returns a NOOP trace unless `trace` flag on (`:277`); `commitTrace` pushes to an in-memory ring buffer (`:293`). Pure observability; never forks an answer. | `IntelligenceTrace.ts:275-296` | **SHADOW ONLY** (telemetry) |
| **IntelligenceMetrics** | Yes | **NO** | — (no non-test importer anywhere) | none | — | **N/A** — `intelligenceMetrics` singleton has zero non-test callers in `electron/` or `src/`. Only self-references + tests. | grep: only `IntelligenceMetrics.ts` self-refs | **DEAD CODE** |
| **SessionTracker.getDurableContext** | Yes | Yes | `IntelligenceEngine.ts:858`; `LiveTranscriptBrain.ts:117` | `durableMemoryWindow` | OFF | **YES.** When on, `memWindowSource = getDurableContext(...)` (reads `fullTranscript`, survives the 120s eviction) instead of `getContext(...)` → long-range follow-up recall actually works (the documented "2h window silently capped to 120s" fix). Flag off → original `getContext` path. | `IntelligenceEngine.ts:850-862`; `SessionTracker.ts:394-411` | **LIVE** (flag-gated, default off) |

### Status tally
- **LIVE (flag-gated, default OFF, behavior fork verified):** ProfileTreeService, OutputShapeNormalizer, MeetingMemoryService (DB), ConversationMemoryService, SessionTracker.getDurableContext, SearchOrchestrator-global.
- **PARTIALLY LIVE:** SearchOrchestrator (global LIVE+UI; in-meeting handler has no UI), LongTermMemoryService + HindsightClientAdapter (Noop default; live only with flags+server+client).
- **SHADOW ONLY (telemetry/trace, no answer change):** LiveTranscriptBrain, ContextRouter (routeContext), ContextFusionEngine, PromptAssemblerV2, IntelligenceTrace.
- **NOT WIRED (backend IPC, no renderer caller):** LectureIntelligenceService, DiagramIntelligenceService, SearchOrchestrator.inMeetingSearch.
- **DEAD CODE:** IntelligenceMetrics.

> **Crucial caveat:** Every "LIVE" module above is LIVE *only if its flag is flipped*. The flags are default OFF and there is **no renderer UI** to toggle them (`getIntelligenceFlags`/`setIntelligenceFlag` are exposed in preload `:1439-1440` but have **zero callers in `src/`**). In the shipped default build, every one of these behaves as if absent. They are LIVE-CAPABLE, not LIVE-BY-DEFAULT.

---

## PART B — LIVE DATA FLOW (real paths present)

### 1. Manual typed question (streaming)
```
Renderer (manual chat input)
  │  IPC: 'gemini-chat-stream'                         [ipcHandlers.ts:582]
  ▼
main handler (the big streaming block)
  ├─ planAnswer(...) → answerPlan                      (PROVEN PI path, not OS)
  ├─[contextRouterV2] routeContext(...) → trace only   [:776-804]  ░SHADOW░
  ├─[conversationMemoryV2] resolveSameSession → context [:833-842] ●FORK●
  ├─[hindsightLiveRecall&&hindsightMemory && isBackwardLookingQuery]
  │      LongTermMemoryService.recallRelevantMemory(800ms)
  │      → prepend "RELEVANT LONG-TERM MEMORY" to context [:997-1033] ●FORK● (Noop→[] by default)
  ├─[profileTreeV2] getCandidatePerspectiveGuard → widen sanitizer [:1339-1344] ●FORK●
  ▼
LLMHelper.streamChat(message, ..., context, ...)        [:1059]
  ▼
provider (Natively gateway → Gemini cascade flash-lite→flash→pro → Groq/OpenAI/Claude)
  ▼
'gemini-stream-token' / 'gemini-stream-done' → Renderer
```
On-path OS modules: ConversationMemoryService, LongTermMemoryService (Noop default), ProfileTreeService — all flag-off by default. Beside-path: ContextRouter (telemetry).

### 2. What-to-Answer (live copilot)
```
Renderer (What-to-Answer button / auto-trigger)
  │  IPC: 'generate-what-to-say'                        [ipcHandlers.ts:4331]
  ▼
intelligenceManager.runWhatShouldISay(...)              [:4444]
  ▼
IntelligenceEngine.runWhatShouldISay()                  [IntelligenceEngine.ts:595]
  ├─ beginTrace(...) (NOOP unless 'trace')              [:595]      ░SHADOW░
  ├─[liveTranscriptBrain] new LiveTranscriptBrain → trace included:false [:802-811] ░SHADOW░
  ├─[durableMemoryWindow] session.getDurableContext vs getContext [:857-859] ●FORK● (memory window)
  ├─ WhatToAnswerLLM.processWhatToAnswer(...)
  │     └─[promptAssemblerV2] fuseContext+assemblePromptV2 → shadow trace [WhatToAnswerLLM.ts:382-407] ░SHADOW░
  ├─[answerDiversityGuard] normalizeOutputShape → finalWtaAnswer [:1496-1499] ●FORK● (output text)
  ▼
provider stream → emit('suggested_answer', finalWtaAnswer) → Renderer
```
On-path OS modules: getDurableContext, OutputShapeNormalizer (flag-off by default). Beside-path: LiveTranscriptBrain, PromptAssemblerV2/ContextFusionEngine, IntelligenceTrace.
> Note: the older `generate-suggestion` IPC (`:459`) goes to `LLMHelper.generateSuggestion` (`:1456`) and bypasses the IntelligenceEngine WTA path entirely — it touches no OS module.

### 3. Post-meeting
```
MeetingPersistence.stopMeeting → processAndSaveMeeting (fire-and-forget background)
  ├─[meetingMemoryV2] MeetingMemoryService.buildMeetingRecord
  │     → summaryData.meetingMemory                     [:361-381] ●DB WRITE●
  ▼
DatabaseManager.saveMeeting → meetings.summary_json (JSON, detailedSummary.meetingMemory)
                                                        [db/DatabaseManager.ts:1144]
  └─[hindsightPostMeetingRetain && hindsightMemory && cfg]
        LongTermMemoryService.retainMeetingSummary(...) [:419-437] ●EXTERNAL● (Noop→no-op by default)
```
On-path OS modules: MeetingMemoryService (DB), LongTermMemoryService (Noop default, async queue, never blocks). HindsightManager lifecycle: `main.ts:879` start / `main.ts:5861` stop.

---

## PART C — ARCHITECTURE VERDICT

**Is Intelligence OS in the live architecture, or beside it?**
Mostly **beside it (shadow)**, with a thin layer of flag-gated forks that are **OFF by default and have no UI switch**. Imports are real; behavior change is gated and dark. The 5 trace/shadow modules (LiveTranscriptBrain, ContextRouter, ContextFusionEngine, PromptAssemblerV2, IntelligenceTrace) never change an answer by design. The 6 "LIVE" modules only act when an env var or a setting (no UI) flips them. **Default shipped build = OS effectively inert.**

**Is the app still local-first? Does it work with Hindsight disabled?**
**Yes, conclusively.** `LongTermMemoryService.fromFlags` returns `NoopMemoryProvider` unless `hindsightMemory` ON + `baseUrl` configured + optional client installed (`LongTermMemoryService.ts:41-45`). NoopMemoryProvider: `retain` no-op, `recall` returns `[]` (`MemoryProvider.ts:66-72`). Recall is bounded (800ms `Promise.race` + AbortController, `HindsightClientAdapter.ts:98-114`) and every call site is wrapped in try/catch that logs "non-fatal" and proceeds — **a Hindsight failure cannot crash a live answer**.

**Is meeting memory actually persisted? Which column/table?**
**Yes** — `meetings.summary_json` (TEXT/JSON; `db/DatabaseManager.ts:192-197`), under `detailedSummary.meetingMemory` (`MeetingPersistence.ts:369-380` → `saveMeeting` → INSERT at `:1144`). No migration; old rows simply lack the key. Gated by `meetingMemoryV2` (default OFF).

**Is search real or fake?**
**Real** for global search (the documented fake AI-passthrough in `Launcher.tsx` is replaced): `onLiteralSearch` calls `searchGlobalMeetings` → real local-DB lexical scan over 50 recent meetings ranked by `SearchOrchestrator.globalSearch` (`ipcHandlers.ts:4017-4085`), opens the top meeting (`Launcher.tsx:437-444`), and only falls back to the AI query when the flag is off or there's no match. Gated by `globalSearchV2` (default OFF).

**Is in-meeting search separate from global search?**
**Yes, architecturally** — distinct handler `search:in-meeting` (`:4100`) over the *current* meeting transcript, local-only, no Hindsight (vs global's `getRecentMeetings(50)` + optional Hindsight merge). **BUT in-meeting search has no renderer caller** — it's a backend handler nothing in `src/` invokes.

**Are lecture/diagram connected to live IPC + a renderer caller?**
**No.** Both have complete backend handlers (`lecture:generate-notes` `:4119`, `diagram:generate` `:4143`) and preload bridges (`generateLectureNotes` `:1437`, `generateDiagram` `:1438`), but **zero renderer callers in `src/`**. They are backend-only contracts with no UI. The handler comments even acknowledge "a separate UI feature".

**Remaining dead-code / library-only modules.**
- **IntelligenceMetrics** — DEAD CODE (no non-test importer anywhere).
- **LectureIntelligenceService, DiagramIntelligenceService, SearchOrchestrator.inMeetingSearch** — reachable backend, no UI caller (orphaned IPC).
- Pure-shadow (run but never affect output): LiveTranscriptBrain, ContextRouter.routeContext, ContextFusionEngine, PromptAssemblerV2, IntelligenceTrace.

**Missing production wiring.**
1. **No renderer UI to flip any flag** — `getIntelligenceFlags`/`setIntelligenceFlag` (preload `:1439-1440`) have no `src/` caller; the entire OS is only enable-able via `NATIVELY_*` env. Nothing can be turned on by a user in a packaged build.
2. **Orphaned IPCs:** lecture-notes panel, diagram view, and in-meeting-search UI don't exist.
3. **Hindsight is documented as fully configured but ships dark:** requires the optional `@vectorize-io/hindsight-client` (lazy-required, not bundled) + a user-provisioned Python/Postgres sidecar; absent all three → Noop. There is also no settings UI shown for `hindsightBaseUrl`/`hindsightApiKey` (HindsightManager reads them, but no renderer writes them — same UI gap as the flags).

**Scale + privacy risks.**
- Global search scans only 50 meetings via in-process JS lexical matching — fine for a single-user desktop DB; does not scale to large histories (no FTS index; `meetings.summary_json` is parsed per row). For real scale, move to SQLite FTS5.
- Hindsight scope is hardcoded `userId: 'local'` everywhere (`ipcHandlers.ts:1020,4066`, `MeetingPersistence.ts:431`) — correct for single-user desktop, but the isolation guarantee (per-scope bank + `tagsMatch:'all_strict'`, `HindsightClientAdapter.ts:96-114`) is only as good as that scope; any future multi-user/cloud sharing must thread a real `userId`/`orgId`.
- Hindsight retain sends meeting summaries off-device to a third-party server when enabled — privacy-material; correctly default-OFF and gated, but the eventual settings UI must make this opt-in explicit.
- `diagram:generate` caps input at 8000 chars to defuse a quadratic-backtrack ReDoS in its sequence generator (`ipcHandlers.ts:4148-4153`) — already mitigated; keep the cap if a UI ever feeds it user text.

**Recommended next PRs (short).**
1. **Settings UI for the flag panel + Hindsight config** — wire `getIntelligenceFlags`/`setIntelligenceFlag` and `hindsightBaseUrl`/`hindsightApiKey` into NativelyProSettings so the OS is reachable without env editing (highest leverage; today it's all dark).
2. **Wire or delete the orphaned IPCs** — add a lecture-notes panel, diagram view, and in-meeting search box, OR remove `lecture:generate-notes` / `diagram:generate` / `search:in-meeting` + their preload bridges to cut dead surface.
3. **Delete IntelligenceMetrics** (dead) or wire it into a real RED-method export; right now it's pure carrying cost.
4. **Promote one shadow module to live** with a parity-gated rollout (ContextRouter or PromptAssemblerV2 already emit divergence telemetry — use it to justify flipping the first non-shadow consumer), so the OS starts earning its keep instead of only shadowing the proven path.
5. **FTS5 index on meeting summaries** before global search history grows.

---

### Notes on lead's brief (corrections)
- The "ZERO live files import intelligence" claim is indeed **STALE** — confirmed 5 non-test importers + the `memory/` sub-importers.
- The brief said `electron/LLMHelper.ts` and `electron/services/HindsightManager.ts` have **uncommitted Hindsight changes** — **not accurate.** `git diff electron/services/HindsightManager.ts` is **empty** (fully committed). `electron/LLMHelper.ts`'s uncommitted diff is the **removal of the flash/flash-lite latency hedge** (serial Gemini cascade) + a `gemini_flash_lite` provider id — **nothing Hindsight/intelligence-related** (`git diff | rg -i 'intelligence|hindsight|memory|recall'` → none). HindsightManager's auto-spawn lifecycle is committed (`537e614`) and wired at `main.ts:879/5861`.
