# Natively Intelligence OS — Implementation Plan (Phase 0)

**Date:** 2026-06-12
**Branch:** `feature/profile-intelligence-v3`
**Author:** Architecture Auditor pass (read-only reverse-engineering of the live code paths)

---

## 0. Honest preface — what the prompt assumed vs. what is real

The build prompt told me to read `natively_context_rag_memory_audit.md` "fully before modifying anything."

> **`natively_context_rag_memory_audit.md` is NOT FOUND.** It does not exist anywhere in the
> repo (searched by filename, by content reference, and across `docs/`). I reconstructed the
> current architecture directly from the source instead, via six parallel read-only sweeps of
> the real code paths. Everything below is grounded in `file:line` evidence, not the missing audit.

The prompt also names a set of target files as if they were "likely areas" to modify
(`ProfileTreeService.ts`, `LiveTranscriptBrain`, `ContextRouter`, `ContextFusionEngine`,
`MeetingMemoryService`, `SearchOrchestrator`, `LongTermMemoryService`, `IntelligenceTrace`).

> **None of those named modules exist yet.** They are the *target* architecture, not the current
> one. But ~80% of the *behavior* they describe is already implemented — just scattered across
> 8+ files with duplicated routing. The honest job here is **consolidation + hardening + one real
> bug fix**, NOT a greenfield rebuild. Rebuilding would be the single most dangerous thing I could
> do to a system that currently passes WTA 75/75 and 1240+ LLM tests.

---

## 1. Current architecture summary (verified)

### 1.1 Profile Intelligence (deterministic identity/profile answers) — REAL, GOOD

The closest thing to a "Profile Tree" already exists, split across:

| Concern | Where it lives | Status |
|---|---|---|
| Deterministic identity/name/intro/projects/experience/skills/education/JD-fit formatting | `electron/llm/manualProfileIntelligence.ts` (`tryBuildManualProfileFastPathAnswer` @645, `buildLiveFallbackAnswer` @822) | **Live, wired into both manual + WTA fallback** |
| Answer-type classification + context route | `electron/llm/AnswerPlanner.ts` (`planAnswer` @1669, `AnswerType` @7, `profileContextPolicyFor` @1501) | **Live** |
| Spec-level profile decision facade | `electron/llm/ProfileIntelligenceRouter.ts` (`decideProfileIntelligence` @177 → `ProfileIntelligenceDecision` @50) | **Live, already a near-perfect ContextRouter core** |
| Premium structured packs / grounding | `premium/electron/knowledge/KnowledgeOrchestrator.ts` (`processQuestion` @616), `ContextAssembler.ts` (`assemblePromptContext` @253) | **Live (premium-gated)** |
| Profile Grounding V2 flag | `electron/llm/profileGroundingV2.ts` (default ON, kill-switch) | **Live** |

**Brutal note:** there are *three* overlapping classifiers (`AnswerPlanner`, `manualProfileIntelligence` regexes, `KnowledgeOrchestrator` intent). This is real duplication, but each is independently tested and benchmark-green. I will **not** merge them tonight (too risky); I will put a **read-only facade** (`ProfileTreeService`) over the deterministic formatters so callers have one canonical entry, and leave the existing routing untouched.

### 1.2 Live transcript / "What to answer?" — REAL, with ONE REAL BUG

- Physical transcript store: `electron/SessionTracker.ts`
  - `contextItems` (final-only rolling window, **evicted to 120s** by `evictOldEntries()` @555, called on every `addTranscript` @232)
  - `fullTranscript` (durable full session, compacted only after 1800 segments)
  - `lastInterimInterviewer` (the only partial-STT state)
- Hot-window accessors: `getContext(s)` @364, `getContextWithInterim(s)` @385, `getLastInterviewerTurn()` @434
- Orchestration: `IntelligenceEngine.runWhatShouldISay()` @584 → `WhatToAnswerLLM.generateStream()` @94
- Latency guardrails: `electron/llm/liveDeadlines.ts` (`raceStreamWithDeadline` @89) — **excellent, keep as-is**
- Follow-up memory: `electron/llm/liveSessionMemory.ts` (`resolveLiveFollowup` @102), flag-gated by `liveSessionMemoryConfig.ts`

> ### 🐛 VERIFIED BUG (high impact, low risk to fix)
> `IntelligenceEngine.ts:130` declares `LIVE_MEMORY_WINDOW_SECONDS = 7200` with a comment claiming
> a "2h memory window … Capped by SessionTracker.maxContextItems (500)." At `:819` it builds the
> long-range follow-up memory from `this.session.getContext(7200)`.
>
> **But `getContext()` reads `contextItems`, which `evictOldEntries()` hard-filters to
> `contextWindowDuration = 120` seconds on every single final segment (`SessionTracker.ts:232,555-557`).**
> So the "2-hour" window can only ever return ~120 seconds. The long-range entity recall this feature
> was built for (project named at minute 1, recalled at minute 62) **silently cannot work** — the
> data has already been evicted. The durable store that *does* hold it (`fullTranscript`) is never
> read by this path.
>
> This is the one genuine code defect surfaced by the audit. Fix = give `SessionTracker` a
> long-window accessor backed by `fullTranscript` (which already survives) and point the
> live-memory path at it. Gated behind a flag, default matching current behavior, with a test that
> proves an entity at minute 1 survives to minute 62.

### 1.3 RAG / Knowledge / Vector — REAL

- `electron/rag/` (`RAGManager`, `VectorStore`, `EmbeddingPipeline`, `RAGRetriever`, `LiveRAGIndexer`, `TranscriptPreprocessor`)
- `premium/electron/knowledge/HybridSearchEngine.ts` (lexical+vector fusion)
- DB: `meetings`, `transcripts`, `ai_interactions`, `chunks`, `chunk_summaries`, `embedding_queue`, `vec_chunks_{768,1536,3072}`, `vec_summaries_{...}` — real sqlite-vec tables with `embedding_space` identity (v16 migration) preventing vector-space contamination.
- Global RAG search: `rag:query-global` IPC → `RAGManager.queryGlobal()`. In-meeting/live: `rag:query-live`, `rag:query-meeting`. **All real and wired.**

### 1.4 Meeting memory / summary / search — REAL but PARTIAL

- Post-meeting: `MeetingPersistence.stopMeeting()` @27 → async `processAndSaveMeeting()` @138 → `PostCallWorkflow.buildPostCallEnhancements()` (heuristic action items / follow-up / coaching).
- **Missing / weak (honest):** no first-class tables for entities/topics/decisions; "clean transcript" exists only as RAG `chunks.cleaned_text`; the UI "literal search" in `Launcher.tsx:421` is **fake** — it just re-runs the AI/global query (explicit `// For now, also use AI query` comment).

### 1.5 Prompt assembly / routing / observability

- `electron/services/context/PromptAssembler.ts` — typed, trust-leveled, sanitized XML blocks. **Good infra, but only used on the WTA path.** Manual chat still builds context as strings in `ipcHandlers.ts` + `LLMHelper._streamChatInner`.
- Trust order: `SYSTEM_POLICY > MODE_POLICY > DEVELOPER_POLICY > USER_PREFERENCES > TRUSTED_PROFILE > ASSISTANT_HISTORY > UNTRUSTED_{SCREEN,TRANSCRIPT,REFERENCE,MEETING_HISTORY}` (`TrustLevels.ts`).
- **No single `ContextRouter`.** Routing is scattered across ipcHandlers, WhatToAnswerLLM, LLMHelper, streamContextPolicy, KnowledgeOrchestrator.
- **No `IntelligenceTrace`.** Observability today = fragmented `PiLatencyTrace` + `piTelemetry` + ad-hoc `console.log`. There is **no structured "which context sources were included and why" record**.
- **Browser DOM context:** the memory index references a PR #292 `/dom` companion extension, but the searched main-process code shows **no live DOM context merge today** in this worktree. Marked `NOT WIRED` until confirmed.

### 1.6 Tests / flags / build (verified commands)

- Build electron (esbuild, transpile-only, **no typecheck**): `npm run build:electron`
- Typecheck electron: `npm run typecheck:electron` (`tsc -p electron/tsconfig.json --noEmit`)
- LLM unit tests (node:test, against `dist-electron`): `npm run test:llm`
- Services tests: `npm run test:services`
- Profile benchmark (real backend, needs live DB + keys): `npm run benchmark:profile:build`
- Flag convention: small per-feature modules reading `process.env.NATIVELY_*` + `SettingsManager`, defensive (never throw), with a `__reset*Cache()` test hook. Examples: `profileGroundingV2.ts`, `liveSessionMemoryConfig.ts`, `verificationEnabled.ts`. **New flags MUST follow this exact pattern.**

---

## 2. Scope decision — what I WILL and WILL NOT do tonight

The full 18-phase spec is multi-week work. Doing it all in one pass would mean shipping a lot of
half-built, under-tested surface area into a system that is currently green. That violates
non-negotiable rules #1 and #9 ("do not break existing working systems"). So I am scoping to a
**safe, high-impact, fully-tested vertical slice** that delivers the spec's stated "must finish
first" priority list and nothing speculative.

### ✅ IN SCOPE (this pass) — all additive, flag-gated, tested

1. **`electron/intelligence/intelligenceFlags.ts`** — central flag module (spec Phase 15), following the existing `NATIVELY_*` convention. Every new behavior default-OFF except observe-only tracing. Instant rollback.
2. **`electron/intelligence/IntelligenceTrace.ts`** — the missing structured per-answer trace + **context-inclusion report** (spec Phase 12/13). Observe-only; wired into manual + WTA paths behind `intelligence_trace_enabled` (default off). Zero behavior change, zero added latency when off.
3. **`electron/intelligence/ProfileTreeService.ts`** — read-only facade (spec Phase 2) exposing `getIdentity/getProjects/getExperience/getSkills/getEducation/getRoleFit/getCompactIdentityBlock/getInterviewIntro` over the **existing** deterministic formatters. No new answer logic; it delegates. Gives the spec's canonical API without disturbing routing.
4. **`electron/intelligence/LiveTranscriptBrain.ts`** — read-only facade (spec Phase 3) exposing `getLiveWindow/getHotWindow/getCurrentQuestion/getRollingSummary/getLiveAnswerContext` over `SessionTracker`. **Includes the real bug fix**: a new `SessionTracker.getDurableContext(seconds)` backed by `fullTranscript` so long-range recall actually works, plus a test proving minute-1→minute-62 survival. Live wiring of the fix is flag-gated (`intelligence_durable_memory_window`, default OFF → current behavior unchanged).
5. **`electron/intelligence/ContextRouter.ts`** — single queryable router facade (spec Phase 8) that composes `planAnswer` + `decideProfileIntelligence` + `streamContextPolicy` into the spec's exact output shape (`useProfileTree/useLiveTranscript/useHybridRag/useHindsightRecall/useMeetingSummary/useBrowserDom/useReferenceFiles + answerContract + maxLatencyMs + reason`). Pure decision function; emits a trace. **Does not replace** existing routing — it's a consultable, testable consolidation that the existing paths can adopt incrementally.
6. **Tests** under `electron/intelligence/__tests__/*.test.mjs` (node:test) for all of the above, including the spec's required profile-identity and latency-budget categories and the privacy/isolation (Alice/Bob no-leak) case for `ProfileTreeService`.
7. **`NATIVELY_INTELLIGENCE_OS_FINAL_REPORT.md`** — honest final report.

### ⛔ OUT OF SCOPE (this pass) — deferred, marked NOT DONE in the final report

- **Hindsight long-term memory (Phases 4, 16)** — does not exist in repo; spec explicitly says "Do not start with Hindsight." Deferred entirely. The `ContextRouter` will emit `useHindsightRecall` as a *decision* (always paired with a strict-timeout contract) so the integration point is defined, but no client is built.
- **Meeting Memory structured extraction / first-class entity-topic-decision tables (Phase 5)** — real schema migration; too invasive for one safe pass.
- **Global Search V2 fusion formula + real literal search (Phase 6/7)** — the fake `Launcher.tsx` literal search is documented as a known defect; replacing it touches renderer + IPC + ranking and is deferred.
- **Prompt Assembler V2 rollout to the manual path (Phase 10)** — `PromptAssembler` is good but only on WTA; migrating manual chat off string-concat is a large, separately-benchmarked change.
- **ConversationMemoryService cross-session (Phase 11)** — depends on Hindsight + meeting memory.

Marking these honestly is required by non-negotiable rule #11 (`NOT FOUND` / `NOT DONE` rather than fake).

---

## 3. Files to modify vs. not modify

### Will CREATE (all new, additive)
- `electron/intelligence/intelligenceFlags.ts`
- `electron/intelligence/IntelligenceTrace.ts`
- `electron/intelligence/ProfileTreeService.ts`
- `electron/intelligence/LiveTranscriptBrain.ts`
- `electron/intelligence/ContextRouter.ts`
- `electron/intelligence/__tests__/*.test.mjs`

### Will EDIT (minimal, surgical, additive-only)
- `electron/SessionTracker.ts` — add `getDurableContext(seconds)` accessor (new method, no change to existing ones). This is the only edit to a hot-path file, and it adds a method without altering any existing behavior.

### Will NOT modify (too risky / out of scope this pass)
- `electron/IntelligenceEngine.ts` runWhatShouldISay orchestration (read by facades, not rewritten). *Exception:* if the durable-memory flag wiring is done, it's a one-line guarded swap of `getContext(7200)` → `getDurableContext(7200)` behind the flag — deferred to a follow-up if it can't be made provably safe tonight.
- `electron/llm/{AnswerPlanner,ProfileIntelligenceRouter,manualProfileIntelligence,streamContextPolicy}.ts` — consumed by facades, not edited.
- `premium/electron/knowledge/*` — premium, esbuild skips typecheck; consumed read-only.
- All RAG, audio, DB-migration code.

---

## 4. Data flows (current, verified)

```
MANUAL CHAT:
  renderer → ipc 'gemini-chat-stream' (ipcHandlers.ts:561)
    → identity probe short-circuit (:588)
    → planAnswer() (:697)  ──► AnswerPlan
    → buildManualProfileBackendAnswer() deterministic fast-path (:750)
    → [else] LLMHelper.streamChat(routeOptions) (:896)
        → KnowledgeOrchestrator.processQuestion() [premium] (LLMHelper:3610)
        → active-mode + pinned-instruction injection (:3669)
        → provider stream, raceStreamWithDeadline (ipcHandlers:947)

LIVE "WHAT TO ANSWER":
  shortcut → ipc 'generate-what-to-say' (ipcHandlers.ts:3881)
    → IntelligenceManager.runWhatShouldISay (:3993)
    → IntelligenceEngine.runWhatShouldISay (:584)
        → session.getContext(180)  ── hot window (:707)
        → extractLatestQuestion (:781)
        → planAnswer + resolveLiveFollowup [flag] (:830)
        → WhatToAnswerLLM.generateStream (:1101)
            → PromptAssembler.assemble (WhatToAnswerLLM:326)
        → raceStreamWithDeadline + buildLiveFallbackAnswer (:1162)
```

The facades sit **beside** these flows as a canonical read/decision layer; they do not interpose.

---

## 5. Risk areas

| Risk | Mitigation |
|---|---|
| Breaking the green WTA / 1240-test baseline | Facades are additive + read-only. Only structural edit is one new `SessionTracker` method. Run `test:llm` before/after. |
| esbuild skips typecheck → silent type breaks | Run `npm run typecheck:electron` explicitly after edits. |
| Duplicated classifiers drifting | Not merging them; facade delegates to the single source already used live. |
| Latency regression from tracing | Trace is a no-op object when flag off; all collection guarded. |
| The 7200s "fix" changing live answers | Fix lands behind a default-OFF flag; current path byte-for-byte unchanged unless explicitly enabled. |
| Privacy / cross-user leak | `ProfileTreeService` reads only the single loaded profile; isolation test (Alice/Bob) proves no cross-profile bleed. |

---

## 6. Test plan

All tests are `node:test` `.mjs` against `dist-electron` (matching repo convention), under
`electron/intelligence/__tests__/`:

- `intelligenceFlags.test.mjs` — default states, env overrides, kill switch, settings precedence, `__reset` hook.
- `intelligenceTrace.test.mjs` — no-op when off; structured record + inclusion report when on; never throws; zero collection when off.
- `profileTree.test.mjs` — identity/projects/experience/skills/education/intro/role-fit deterministic; **no "I am Natively"**; **no "I don't know" when profile exists**; Alice/Bob isolation.
- `liveTranscriptBrain.test.mjs` — hot/live window correctness; **durable window survives minute-1→minute-62** (the bug-fix proof); current-question extraction.
- `contextRouter.test.mjs` — spec's routing examples ("what is my name?" → ProfileTree only; "what should I answer?" → LiveTranscript+ProfileTree; "what did we discuss last time?" → Hindsight+MeetingMemory decision; coding → no profile); `maxLatencyMs` budgets present; `reason` populated.

**Acceptance gate:** `npm run typecheck:electron` clean for new files + new tests green + **existing `npm run test:llm` still green** (no regression).

---

## 7. Rollback plan

- Every new module is additive and behind `intelligenceFlags` (default OFF / observe-only). Deleting the `electron/intelligence/` directory + reverting the one `SessionTracker` method returns the system to its exact current state.
- No DB migrations, no schema changes, no changes to provider/streaming behavior.
- Flags give instant runtime rollback without redeploy (env or `SettingsManager`).

---

## 8. Implementation phases (this pass, ordered)

1. `intelligenceFlags.ts` (+ test) — foundation, everything gates on it.
2. `IntelligenceTrace.ts` (+ test) — observability primitive.
3. `ProfileTreeService.ts` (+ test) — canonical profile read API.
4. `SessionTracker.getDurableContext()` + `LiveTranscriptBrain.ts` (+ test) — live read API + bug fix proof.
5. `ContextRouter.ts` (+ test) — consolidated decision API.
6. `typecheck:electron` + full `test:llm` regression gate.
7. `NATIVELY_INTELLIGENCE_OS_FINAL_REPORT.md`.

---

*Plan written. Proceeding to implementation of the in-scope slice only, with the deferred phases honestly recorded for the final report.*

---

# Phase 1 Addendum (2026-06-12) — full 20-phase audit map

The sections above were written for the first single-pass slice. This addendum re-frames the audit for the **20-phase** prompt (`# Natively Intelligence OS — Phase-by-Ph.md`) and adds the two required sections the original lacked: an **actual-files-found vs expected-not-found** map, and a consolidated **feature-flags** plan.

## A. Actual files found (by subsystem) — verified `file:line` anchors

| Subsystem | Real file(s) | Status |
|---|---|---|
| Profile fast-path (deterministic) | `electron/llm/manualProfileIntelligence.ts` (`tryBuildManualProfileFastPathAnswer:645`, `buildLiveFallbackAnswer:822`), `electron/llm/profileAnswerBackend.ts` (`buildManualProfileBackendAnswer:43`) | REAL, live |
| Answer planning / classification | `electron/llm/AnswerPlanner.ts` (`planAnswer:1669`, `AnswerType:7`, `profileContextPolicyFor:1501`) | REAL, live |
| Profile decision facade | `electron/llm/ProfileIntelligenceRouter.ts` (`decideProfileIntelligence:177`) | REAL, live |
| Premium grounding | `premium/electron/knowledge/{KnowledgeOrchestrator,ContextAssembler,HybridSearchEngine,DocumentReader,StructuredExtractor,DocumentChunker,AOTPipeline,StarStoryGenerator}.ts` | REAL, premium-gated |
| Profile Grounding V2 flag | `electron/llm/profileGroundingV2.ts` | REAL (default ON) |
| Live transcript store | `electron/SessionTracker.ts` (`contextItems` 120s-evicted, `fullTranscript` durable, `getDurableContext` NEW) | REAL |
| Live answer orchestration | `electron/IntelligenceEngine.ts` (`runWhatShouldISay:584`), `electron/llm/WhatToAnswerLLM.ts` (`generateStream:94`) | REAL, live |
| Live deadlines | `electron/llm/liveDeadlines.ts` (`raceStreamWithDeadline:89`) | REAL, live |
| Follow-up / session memory | `electron/llm/{liveSessionMemory,SessionMemory,FollowUpResolver,sessionFollowupResolver}.ts`, `liveSessionMemoryConfig.ts` | REAL, flag-gated |
| RAG / vector | `electron/rag/{RAGManager,VectorStore,EmbeddingPipeline,RAGRetriever,LiveRAGIndexer,TranscriptPreprocessor}.ts`, `electron/db/DatabaseManager.ts` | REAL |
| Meeting persistence / summary | `electron/MeetingPersistence.ts` (`processAndSaveMeeting:138`), `electron/services/post-call/PostCallWorkflow.ts` | REAL (heuristic extraction) |
| Prompt assembly | `electron/services/context/PromptAssembler.ts`, `TrustLevels.ts`, `ContextPacket.ts` | REAL (WTA path only) |
| Prompts / contracts | `electron/llm/prompts.ts`, `codingContract.ts` | REAL |
| Answer polish / diversity | `electron/llm/answerPolish.ts` | REAL (check coverage in Phase 5) |
| Observability | `electron/llm/{PiLatencyTrace,piTelemetry}.ts` | REAL |
| Modes | `electron/services/ModesManager.ts`, `electron/services/modes/ModeHybridRetriever.ts`, `electron/llm/modeProfiles.ts` | REAL |
| **NEW (prior session)** | `electron/intelligence/{intelligenceFlags,IntelligenceTrace,ProfileTreeService,LiveTranscriptBrain,ContextRouter}.ts` | REAL, additive, flag-gated |

## B. Expected-but-NOT-FOUND (vs the prompt's wish list)

| Expected by prompt | Status |
|---|---|
| `natively_context_rag_memory_audit.md` | **NOT FOUND** (does not exist; reconstructed from code) |
| `ContextFusionEngine` / `PromptContextContract` | **NOT FOUND** (Phase 8 — fusion logic is implicit in PromptAssembler trust-sort) |
| `MeetingMemoryService` / `MeetingInsightExtractor` / `MeetingSearchIndex` first-class | **NOT FOUND** (Phase 10 — only MeetingPersistence + RAG chunks) |
| First-class `entities` / `topics` / `decisions` / `action_items` tables | **NOT FOUND** (live only inside `summary_json`; `TranscriptPreprocessor` computes `isQuestion/isDecision/isActionItem` flags but they're not persisted structurally) |
| Real literal global/in-meeting search | **NOT FOUND / FAKE** (`src/components/Launcher.tsx:421` literal search re-runs the AI query — explicit `// For now, also use AI query` comment) |
| `SearchOrchestrator` (fusion-ranked) | **NOT FOUND** (Phase 11/12 — only `rag:query-global` / `rag:query-live` RAG paths) |
| `LectureIntelligenceService` / `CourseMemoryService` | **NOT FOUND** (Phase 14 — lecture is just a meeting mode + `MODE_LECTURE_PROMPT`) |
| `DiagramIntelligenceService` | **NOT FOUND** (Phase 15 — no diagram generation in repo) |
| `ConversationMemoryService` (cross-session) | **NOT FOUND** (Phase 13 — same-session via liveSessionMemory only) |
| Hindsight / `LongTermMemoryService` / `MemoryProvider` | **NOT FOUND** in repo (Phase 16 — researched in Phase 0, adapter to be built) |
| Browser DOM live context merge | **NOT FOUND** in this worktree's main-process answer path (memory references a `/dom` companion extension on another branch) |
| `lint` npm script | **NOT FOUND** (typecheck is the static gate) |

## C. Feature flags (consolidated plan — implemented incrementally)

All flags follow the repo convention: `process.env.NATIVELY_*` + `SettingsManager` opt-in, read defensively, **env read fresh** (esbuild inline-bundling gotcha — a per-bundle cache can't be reset consistently). Default OFF/observe-only unless noted. Existing `electron/intelligence/intelligenceFlags.ts` holds `trace` + `durableMemoryWindow`; Phase 3 extends it to the full set:

```
intelligence_os_enabled            (umbrella, default OFF)
profile_tree_v2_enabled            (Phase 4)
context_router_v2_enabled          (Phase 6)
live_transcript_brain_enabled      (Phase 7)
prompt_assembler_v2_enabled        (Phase 9)
answer_diversity_guard_enabled     (Phase 5)
meeting_memory_v2_enabled          (Phase 10)
global_search_v2_enabled           (Phase 11)
in_meeting_search_v2_enabled       (Phase 12)
lecture_intelligence_v2_enabled    (Phase 14)
diagram_intelligence_enabled       (Phase 15)
hindsight_memory_enabled           (Phase 16)
hindsight_live_recall_enabled      (Phase 16, last to enable)
hindsight_post_meeting_retain_enabled (Phase 16)
intelligence_trace_enabled         (Phase 3, exists as `trace`)
durable_memory_window_enabled      (exists, fixes the 120s bug)
```

## D. Phase-to-existing-asset map (what to harden vs build)

- **Harden (exists):** Phase 3 flags/trace, Phase 4 ProfileTree, Phase 5 answerPolish, Phase 6 ContextRouter, Phase 7 LiveTranscriptBrain, Phase 9 PromptAssembler, Phase 10 MeetingPersistence, Phase 13 liveSessionMemory, Phase 17 PiLatencyTrace/piTelemetry, Phase 18 benchmarks/.
- **Build new (NOT FOUND):** Phase 8 ContextFusionEngine, Phase 11/12 SearchOrchestrator + real literal search, Phase 14 Lecture, Phase 15 Diagram, Phase 16 Hindsight adapter.

## E. Phase 1 baseline (recorded)

`typecheck:electron` = **0 errors** · `build:electron` = **clean** · `test:llm` = **1656 pass / 0 fail / 10 skipped** (skips = pre-existing Go/Java toolchain gates) · intelligence tests = **45 pass**. This is the green baseline every subsequent phase must preserve.

