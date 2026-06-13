# Natively Intelligence OS — E2E Verification Report

**Date:** 2026-06-13
**Repo:** `/Users/evin/natively-cluely-ai-assistant`
**Branch:** `fix/whisper-external-data-download` (live-wiring PRs #311/#312/#313 + 5 Hindsight commits are merged into this branch)
**Method:** static call-graph tracing, per-module flag-fork tracing, renderer-caller confirmation, real-path headless E2E (100 questions), build/test gates, empirical execution of compiled modules. Three subagents (`backend-architect`, `code-reviewer`, `test-engineer`) ran the deep work; the lead independently reproduced every high-value claim.

---

## 1. Executive summary

The premise of the original status report — *"Zero live app files import `electron/intelligence/*`; flipping flags changes nothing; it's all shelfware"* — is **STALE and no longer true.** The live-wiring effort (16 phases) landed and is merged. Five non-test live files now import the intelligence library, flags resolve through a real precedence chain, and several modules have **verified behavioral forks** when their flag is flipped.

But "imported" is not "working end-to-end for a user." The honest state is:

- **The committed wiring is real, additive, and safe.** All 17 flags default **OFF** (verified). With flags OFF the answer path is byte-for-byte unchanged. Privacy is sound (queries hashed, telemetry content-free). Hindsight cannot block or crash a live answer. Search isolation holds. 442/442 intelligence tests + 33/33 IntelligenceEngine tests pass; typecheck and build are clean.
- **But the OS is effectively inert in the shipped default build.** Every behavior-changing module is gated OFF, and **there is no renderer UI to turn any flag on** — only `NATIVELY_*` env vars or an IPC that no `src/` component calls. A packaged build ships the OS dark.
- **Several advertised features have no user-facing half.** Lecture notes, diagram generation, in-meeting search, and the flag-toggle itself are backend IPC handlers with **zero renderer callers**. `IntelligenceMetrics` is dead code. Five of the modules are **shadow-only** (telemetry; they never change an answer by design).
- **The E2E suite scores 99/100**, but that number is honest about its limits: the WTA *LLM generation* step is not executable headless (it degrades to a clarification stall), so category C is scored on the verified decision layer; categories E/F/G/I/J/K are verified at the **compiled-service level**, not through a live renderer; and Hindsight is **NOOP** (no server running).

### 2. Final verdict

# **PARTIALLY WIRED — READY BEHIND FLAGS ONLY**

The committed, flag-gated wiring is safe to ship in its default-OFF state and several modules are genuinely live-capable. It is **not** "fully wired and working end-to-end," because: profile-identity is 93% not 100% (one real voice bug), there is no UI to enable any of it, several modules have no renderer caller, five are shadow-only telemetry, one is dead code, and the WTA generation + Hindsight recall paths are not provable in this environment.

**Two carve-outs must NOT ride this release** (details in §17): the uncommitted `LLMHelper.ts` latency-hedge removal (H2), and enabling `answerDiversityGuard` before its normalizer is made fence-safe (H1).

---

## 3. Static wiring table

Flag precedence (verified `intelligenceFlags.ts:131-138`): **env `NATIVELY_*` → SettingsManager setting → default**. All 17 default OFF. "Behavior fork?" = traced from flag read to an actual answer/DB/search divergence, not just an import.

| Module | Exists | Imported by live (non-test) | Live call-site | Flag | Default | Flag ON changes behavior? | Status |
|---|---|---|---|---|---|---|---|
| **ProfileTreeService** | ✅ | ✅ | `ipcHandlers.ts:1339-1344` | `profileTreeV2` | OFF | **YES** — widens candidate-voice sanitizer trigger | **LIVE** (flag-gated) |
| **OutputShapeNormalizer** | ✅ | ✅ | `IntelligenceEngine.ts:1496-1499` | `answerDiversityGuard` | OFF | **YES** — rewrites `finalWtaAnswer` (⚠ see H1) | **LIVE** (flag-gated) |
| **MeetingMemoryService** | ✅ | ✅ | `MeetingPersistence.ts:361-381` | `meetingMemoryV2` | OFF | **YES** — writes `meetings.summary_json` | **LIVE** (flag-gated, post-meeting) |
| **ConversationMemoryService** | ✅ | ✅ | `ipcHandlers.ts:827-842` | `conversationMemoryV2` | OFF | **YES** — injects prior-exchange into context | **LIVE** (flag-gated) |
| **SessionTracker.getDurableContext** | ✅ | ✅ | `IntelligenceEngine.ts:857-859` | `durableMemoryWindow` | OFF | **YES** — durable transcript vs 120s-evicted window (the documented bug fix) | **LIVE** (flag-gated) |
| **SearchOrchestrator** (global) | ✅ | ✅ | `ipcHandlers.ts:4085`; `Launcher.tsx:437` | `globalSearchV2` | OFF | **YES & REAL** — replaces fake AI-passthrough with local-DB lexical search | **LIVE + wired to UI** |
| **SearchOrchestrator** (in-meeting) | ✅ | ✅ | `ipcHandlers.ts:4106` | `inMeetingSearchV2` | OFF | Handler works; **no renderer caller** | **NOT WIRED (no UI)** |
| **LongTermMemoryService** | ✅ | ✅ | `ipcHandlers.ts:1016-1033`, `MeetingPersistence.ts:425` | `hindsightMemory`+`hindsightLiveRecall`/`…Retain` | OFF | YES *only* with flags+server+optional client; else **Noop** | **PARTIALLY LIVE (Noop default)** |
| **HindsightClientAdapter** | ✅ | ✅ | `LongTermMemoryService.ts:43` | via `hindsightMemory` | OFF | YES when configured; lazy-requires optional client | **PARTIALLY LIVE (Noop default)** |
| **LiveTranscriptBrain** | ✅ | ✅ | `IntelligenceEngine.ts:802-811` | `liveTranscriptBrain` | OFF | **NO** — runs, writes trace `included:false`; answer unchanged | **SHADOW ONLY** |
| **ContextRouter** (routeContext) | ✅ | ✅ | `ipcHandlers.ts:776-804` | `contextRouterV2` | OFF | **NO** — divergence telemetry only | **SHADOW ONLY** |
| **ContextFusionEngine** | ✅ | ✅ | `WhatToAnswerLLM.ts:393` | `promptAssemblerV2` | OFF | **NO** — feeds V2 inclusion report; real `packet` const never reassigned | **SHADOW ONLY** |
| **PromptAssemblerV2** | ✅ | ✅ | `WhatToAnswerLLM.ts:395-405` | `promptAssemblerV2` | OFF | **NO** — drives shadow trace only | **SHADOW ONLY** |
| **IntelligenceTrace** | ✅ | ✅ | `ipcHandlers.ts:23`, `IntelligenceEngine.ts:29`, `WhatToAnswerLLM.ts:12` | `trace` | OFF | **NO** — observability; NOOP when off | **SHADOW ONLY** |
| **LectureIntelligenceService** | ✅ | ✅ | `ipcHandlers.ts:4122` (`lecture:generate-notes`) | `lectureIntelligenceV2` | OFF | Handler works; **no renderer caller** (preload `:1437`, 0 `src/` callers) | **NOT WIRED (no UI)** |
| **DiagramIntelligenceService** | ✅ | ✅ | `ipcHandlers.ts:4147` (`diagram:generate`) | `diagramIntelligence` | OFF | Handler works; **no renderer caller** (preload `:1438`, 0 `src/` callers) | **NOT WIRED (no UI)** |
| **IntelligenceMetrics** | ✅ | ❌ | — | — | — | No non-test importer anywhere | **DEAD CODE** |

**Independently re-verified by the lead:** `IntelligenceMetrics` has 0 non-test importers; `generateLectureNotes`/`generateDiagram`/`searchInMeeting`/`getIntelligenceFlags`/`setIntelligenceFlag` each have **0** `src/` callers; only `searchGlobalMeetings` has 1.

### Status tally
- **LIVE (flag-gated, default OFF, fork verified):** 6 — ProfileTreeService, OutputShapeNormalizer, MeetingMemoryService, ConversationMemoryService, getDurableContext, SearchOrchestrator-global.
- **PARTIALLY LIVE / Noop-by-default:** LongTermMemoryService, HindsightClientAdapter.
- **SHADOW ONLY (telemetry, no answer change):** 5 — LiveTranscriptBrain, ContextRouter, ContextFusionEngine, PromptAssemblerV2, IntelligenceTrace.
- **NOT WIRED (backend IPC, no UI caller):** 3 — LectureIntelligenceService, DiagramIntelligenceService, SearchOrchestrator.inMeetingSearch.
- **DEAD CODE:** 1 — IntelligenceMetrics.

> **The crucial caveat:** every "LIVE" module is live *only if its flag is flipped*, and **there is no renderer UI to flip any flag**. In the shipped default build the entire OS behaves as if absent. It is **LIVE-CAPABLE, not LIVE-BY-DEFAULT**.

---

## 4. Feature flag table

All 17 flags verified OFF by default (executed `intelligenceFlagSnapshot()` against compiled `dist-electron` → **17 OFF / 0 ON**).

| Flag (env) | Reads on a live path? | Effect when ON | Status |
|---|---|---|---|
| `NATIVELY_DURABLE_MEMORY_WINDOW` | ✅ `IntelligenceEngine.ts:857` | Long-range WTA memory reads durable transcript | **LIVE FORK** |
| `NATIVELY_PROFILE_TREE_V2` | ✅ `ipcHandlers.ts:1339` | Widens identity sanitizer | **LIVE FORK** |
| `NATIVELY_ANSWER_DIVERSITY_GUARD` | ✅ `IntelligenceEngine.ts:1496` | Normalizes WTA output (⚠ H1) | **LIVE FORK** |
| `NATIVELY_MEETING_MEMORY_V2` | ✅ `MeetingPersistence.ts:361` | Persists structured meeting memory | **LIVE FORK (DB)** |
| `NATIVELY_GLOBAL_SEARCH_V2` | ✅ `Launcher.tsx:437`/`ipcHandlers.ts:4085` | Real local-DB search vs fake AI passthrough | **LIVE FORK + UI** |
| `NATIVELY_IN_MEETING_SEARCH_V2` | ✅ handler `:4106` | In-meeting lexical search | **LIVE handler, NO UI** |
| `NATIVELY_CONVERSATION_MEMORY_V2` | ✅ `ipcHandlers.ts:836` | Same-session follow-up resolution | **LIVE FORK** |
| `NATIVELY_LECTURE_INTELLIGENCE_V2` | ✅ handler `:4122` | Lecture notes | **LIVE handler, NO UI** |
| `NATIVELY_DIAGRAM_INTELLIGENCE` | ✅ handler `:4147` | Mermaid diagram gen | **LIVE handler, NO UI** |
| `NATIVELY_CONTEXT_ROUTER_V2` | ✅ `ipcHandlers.ts:776` | Routing-divergence telemetry | **SHADOW** |
| `NATIVELY_LIVE_TRANSCRIPT_BRAIN` | ✅ `IntelligenceEngine.ts:802` | Question-parity telemetry | **SHADOW** |
| `NATIVELY_PROMPT_ASSEMBLER_V2` | ✅ `WhatToAnswerLLM.ts:382` | Context-inclusion report | **SHADOW** |
| `NATIVELY_INTELLIGENCE_TRACE` | ✅ trace begin/commit | Per-answer hashed trace | **SHADOW** |
| `NATIVELY_HINDSIGHT_MEMORY` | ✅ `LongTermMemoryService.fromFlags` | Enables provider (else Noop) | **GATED, needs server** |
| `NATIVELY_HINDSIGHT_LIVE_RECALL` | ✅ `ipcHandlers.ts:1009` | Recall into live answer | **GATED, needs server** |
| `NATIVELY_HINDSIGHT_POST_MEETING_RETAIN` | ✅ `MeetingPersistence.ts:419` | Async retain after meeting | **GATED, needs server** |
| `NATIVELY_INTELLIGENCE_OS` | umbrella | (rollout umbrella) | OFF |

**No flag is inert in code** (each is read fresh per answer), but **none has a UI switch** — `getIntelligenceFlags`/`setIntelligenceFlag` (preload `:1439-1440`) have zero `src/` callers, so in a packaged build flags are settable only via env or a hand-edited settings file.

---

## 5. Build / typecheck / test results (independently executed)

| Gate | Command | Result |
|---|---|---|
| Typecheck (electron) | `npm run typecheck:electron` | ✅ **0 errors** (EXIT 0) |
| Build (electron) | `npm run build:electron` | ✅ clean (EXIT 0) |
| Intelligence suite | `node --test electron/intelligence/__tests__/**` | ✅ **442 pass / 0 fail / 9 todo** |
| IntelligenceEngine services | `node --test --test-force-exit electron/services/__tests__/IntelligenceEngine*` | ✅ **33 pass / 0 fail** |
| Flags default state | `intelligenceFlagSnapshot()` (compiled) | ✅ **17 OFF / 0 ON** |

> **Note on the IntelligenceEngine gate:** the first run appeared to "hang." Diagnosis: the tests **pass**, but the process keeps open handles (timers/intervals) so it doesn't self-exit under `--test-timeout=0`. Re-running with `--test-force-exit` returns **33/33, EXIT 0**. Not a test failure — an open-handle teardown artifact. The 9 "todo" are pre-existing Phase-2 placeholders.

---

## 6. 100-question E2E summary

**Result: 99 / 100 PASS (independently reproduced by the lead via direct `node` run — identical to the test-engineer's run, same single failure A09).**

| Cat | Capability | Pass | Path actually exercised |
|---|---|---|---|
| A | Profile identity / background | **14/15** | LIVE manual path (real Gemini streams + deterministic fast-path) |
| B | JD fit / profile reasoning | 10/10 | LIVE manual path (real LLM) |
| C | Live transcript / what-to-answer | 15/15 | **LIVE decision layer only** — WTA *LLM generation* not executable headless (see §6 gap) |
| D | Same-session follow-up | 10/10 | SERVICE (ConversationMemoryService, compiled); D10 cross-session = NOOP (no Hindsight) |
| E | Meeting memory | 10/10 | SERVICE (MeetingMemoryService, compiled) |
| F | Global meeting search | 10/10 | SERVICE (SearchOrchestrator.globalSearch, compiled) |
| G | In-meeting search | 8/8 | SERVICE (SearchOrchestrator.inMeetingSearch, compiled) |
| H | Mode boundaries | 8/8 | LIVE-LOGIC (planAnswer + ProfileIntelligenceRouter via ContextRouter) |
| I | Lecture / study agent | 8/8 | SERVICE (LectureIntelligenceService, compiled) |
| J | Diagram intelligence | 4/4 | SERVICE (DiagramIntelligenceService, compiled) — backend only, no UI |
| K | Privacy / isolation | 2/2 | SERVICE (ProfileTreeService + SearchOrchestrator scoping) |

**Thresholds check:** overall 99% (≥90% ✓), privacy isolation 2/2 = 100% ✓, **profile identity 14/15 = 93% (✗ — the FULLY-WIRED bar requires 100%)**, no BLOCKER ✓, no build/typecheck fail ✓.

### The one genuine FAIL — A09 (real product bug, not a scorer artifact)
- **Q:** "How many years of experience do you have?"
- **A (real LLM, manual path):** *"You have roughly 0.4 years of experience."*
- **Why FAIL:** **second-person voice** — answered *about* the candidate ("You have…") instead of *as* them ("I have…"). The number is correctly grounded (`[PostProcessor] Total experience: 0.4 years`); only the perspective is wrong. Same class as the historical "candidate voice" bug, surfacing on the experience-count answer builder.

### Honest measurement gaps (not faked, the whole point of this exercise)
1. **WTA LLM generation is not reachable headless.** `WhatToAnswerLLM.generateStream → ModesManager → DatabaseManager` needs `sqlite-vec/vec0`, unavailable under the harness `node:sqlite` shim, so it emits a **clarification stall**. The test-engineer scored C on the verified decision layer (extract → plan → ground → identity fast-path) and marks the LLM token `NOT EXECUTABLE FROM HARNESS`. **Notably, the existing official `benchmark:wta` hides this — it stalls ~21/40 LLM cases but counts the stall as a pass; this suite catches it.**
2. **Hindsight live recall = NOOP** (port 8888 down, no `HINDSIGHT_BASE_URL`). The safe-fallback contract (recall returns `[]`, no break/leak) IS verified; live recall is not.
3. **Categories E/F/G/I/J/K are verified at the compiled-service level** from `dist-electron`, not via a live renderer (several have no renderer caller). This is the correct level until callers are wired — but it is **not** full UI-to-DB E2E.
4. **A/B/C live-LLM categories read the real embedded DB** (Evin John's profile), while the meeting/search/lecture/privacy fixtures use fake names (Alice Varma / Bob Menon). The real DB is used read-only via a safe copy.

---

## 7. 100-question detailed results

Full per-question records (id, category, mode, question, actual_answer, pass, failure_reason, latency, all `*_used` booleans, trace_id, evidence) are in **`natively-intelligence-e2e-results.json`** (100 records, complete schema, 0 missing fields — verified). Module-usage true-counts from the run: deterministic_fast_path **11**, profile_tree **13**, live_transcript **15**, meeting_memory **10**, global_search **11**, in_meeting_search **8**, lecture **8**, diagram **4**, context_router **8**, **hindsight 0** (honest — no server).

---

## 8. Manual / representative-prompt verification

No GUI in this environment, so the 20 representative prompts were driven through the **same real harness path** the app uses (`benchmarks/profile-intelligence/harness.cjs` → compiled `dist-electron`), and the answers were pulled from the reproduced results. Representative spread (one per category, plus identity probes):

| Prompt | Mode | Result | Actual answer (excerpt) |
|---|---|---|---|
| What is your name? | manual | PASS | "My name is Evin John." |
| Can you introduce yourself? | WTA | PASS | "I'm Evin John, an AI & Full Stack Engineer Intern…" (first-person) |
| **How many years of experience…?** | manual | **FAIL** | "**You** have roughly 0.4 years…" (second-person bug) |
| Why are you a good fit for this role? | manual | PASS | "I bring a strong foundation in data-driven engineering…" |
| And what about the eviction policy? | conversation | PASS | resolves prior turn → "I would use an LRU eviction policy…" |
| Action items from the team meeting? | meeting | PASS | structured list extracted from fixture |
| Find all meetings about Redis scaling. | global-search | PASS | ranked: `m1_interview_redis` conf 0.569, real match reasons |
| Where did we discuss eviction? (this mtg) | in-meeting | PASS | timestamped snippet, score 1.0 |
| Reverse a linked list in Python. | coding | PASS | `profileContextPolicy:"forbidden", coding:true` (boundary correct) |
| Generate study notes for TCP handshake. | lecture | PASS | structured concepts/definitions/flashcards |
| Draw a sequence diagram of TCP 3-way. | diagram | PASS | valid Mermaid, `ai_reconstructed_diagram` |
| As Bob, show me Alice's AtlasDB project. | privacy | PASS | `Bob.getProjects()=My projects include CloudCart.` (no Alice leak) |

**Manual verification verdict:** identity, JD-fit, mode boundaries, search ranking, lecture/diagram structure, and cross-user isolation all behave correctly at the path level. The single defect is A09's perspective. A real GUI pass (the spec's full 20-prompt interactive script) still requires a human with the flags enabled — documented in `NATIVELY_INTELLIGENCE_OS_LIVE_VERIFICATION.md §B/C`.

---

## 9. Latency statistics

Measured for the live-LLM + deterministic categories only (service categories correctly marked `NOT MEASURED — service-level call, no LLM round-trip`):

- **First-useful token** (n=32): avg **402 ms**, p50 **7 ms** (fast-path dominated), p95 **1017 ms**, worst **1917 ms**.
- **Total time** (n=40): avg **430 ms**, p50 **1 ms**, p95 **1366 ms**, worst **2046 ms**.
- Split: ~11 deterministic fast-path (~1–13 ms), ~15 real LLM streams (~900–1900 ms first-useful — healthy, consistent with the flash thinking-budget=0 fix).

---

## 10. Module usage statistics

See §7. Headline: every "LIVE" module was actually invoked during the run with its flag ON; `hindsight_used` = 0 (no server, honestly recorded).

## 11. Hindsight status

**MOCK / NOOP by default, honestly documented.** `LongTermMemoryService.fromFlags` returns `NoopMemoryProvider` unless `hindsightMemory` is ON **AND** a `baseUrl` is configured **AND** the optional `@vectorize-io/hindsight-client` is installed. Default = Noop (`retain` no-op, `recall` → `[]`). Recall is double-bounded (AbortController + 800 ms `Promise.race`), retain is a background queue (bounded 500, never awaited). **A Hindsight failure cannot block or crash a live answer** (every call site try/catch'd + bounded). Live recall is **not provable here** (no server); the disabled safe-fallback contract IS verified. Ships **dark** — also gated behind the missing settings UI.

## 12. Search status

**Global search is REAL** (not fake passthrough). The documented `Launcher.tsx` "// For now, also use AI query for literal search" hack **is replaced** (`:437-444`): real local-DB lexical scan over 50 recent meetings ranked by `SearchOrchestrator.globalSearch`, opens the top hit, falls back to AI query only when the flag is OFF or no match. Gated by `globalSearchV2` (OFF). **In-meeting search is a real, separate handler** (`search:in-meeting`) but has **no renderer caller**.

## 13. Meeting memory status

**Real and persisted** to `meetings.summary_json` (TEXT/JSON, `db/DatabaseManager.ts:192-197,1144`) under `detailedSummary.meetingMemory`, written by `MeetingMemoryService.buildMeetingRecord` in the background `processAndSaveMeeting` worker. No migration (old rows lack the key). Gated by `meetingMemoryV2` (OFF). Never blocks a live answer.

## 14. Lecture intelligence status

**Backend IPC handler only** (`lecture:generate-notes`, gated `lectureIntelligenceV2`). The service produces real structured notes (concepts/definitions/flashcards/exam-Qs/checklist). **No renderer caller** → not reachable by a user. NOT WIRED end-to-end.

## 15. Diagram intelligence status

**Backend IPC handler only** (`diagram:generate`, gated `diagramIntelligence`). Produces validated Mermaid (sequence/state/flowchart), input capped at 8000 chars to defuse a ReDoS. **No renderer caller.** NOT WIRED end-to-end.

## 16. Privacy / isolation status

**PASS (single-user desktop).** Queries hashed (`sha256(query).slice(0,12)`); all new telemetry/logs are content-free (no resume/JD/transcript). `SearchOrchestrator` enforces `userId`/org match before ranking; "Bob never surfaces Alice's data" holds (K01/K02, F10). No hardcoded user facts. Identity stays deterministic (probe short-circuits before any recall). **Caveat:** Hindsight scope is hardcoded `userId:'local'`; isolation for memory candidates relies on the server-side tag builder, not the orchestrator filter — fine for single-user, must thread a real `userId`/`orgId` before any multi-user/cloud sharing.

---

## 17. Code review findings (severity-ranked)

**BLOCKER:** none for a flags-OFF ship.

**HIGH**
- **H1 — `OutputShapeNormalizer` destroys fenced code & Mermaid.** `compressToSpeakable` (`answerPolish.ts:165-176`) deletes ```…``` blocks and never restores them. **Empirically reproduced by the lead** against the compiled module: input with a JS fence → output `"I match. built it. great."` (code gone). Gated behind `answerDiversityGuard` (default OFF) → **fix-before-enable, not a blocker.** Fix: make `compressToSpeakable` fence-safe (placeholder-swap like `cleanAnswerArtifacts`), or refuse to compress when `CODE_FENCE_RE.test(text)`.
- **H2 — Uncommitted `LLMHelper.ts` rewrite removes tail-latency hedging** (NOT Hindsight — the original brief mischaracterized this; **independently confirmed: 0 hindsight/recall/memory refs in the diff**). Removes `VISION_HEDGE_ENABLED`/`TEXT_HEDGE_ENABLED`/`GEMINI_TEXT_HEDGE_CONFIG` and replaces the parallel race with a serial flash-lite→flash→pro cascade. This is an **always-on change to the core answer-latency path that reverses a documented benchmark fix** (2026-06-06: the un-hedged text path caused 79/94 latency failures). Compiles cleanly; risk is behavioral. **Must land separately behind its own latency benchmark + kill-switch — do not bundle into the Intelligence OS release.**

**MEDIUM**
- **M1 — `IntelligenceMetrics` is dead code** (0 non-test importers — lead-confirmed). The leakage/latency counters are never recorded. Wire it at the instrumented sites or label it not-yet-wired.
- **M2 — Five preload IPCs have no renderer consumer** (`searchInMeeting`, `generateLectureNotes`, `generateDiagram`, `getIntelligenceFlags`, `setIntelligenceFlag` — each 0 `src/` callers, lead-confirmed). Backend-ready, dead end-to-end. In particular, **no shipped UI to toggle any flag.**
- **M3 — Hindsight `recall` race timer not cleared on the win path** (`HindsightClientAdapter.ts:99-114`). Bounded/minor; leaves a dangling timer per recall. Clear it in `finally`.
- **M4 — Uncommitted always-on startup splash** (`src/App.tsx:91`) — returning-user UX change, unrelated to Intelligence OS, riding the same uncommitted batch as H2. Land separately.

**LOW**
- **L1** — 17 flag SettingsManager keys not in the typed `AppSettings` schema (reached via untyped `require`; works at runtime, fragile — the known untyped-key gotcha).
- **L2** — `[HindsightLiveRecall]` info-log on the answer path (counts/timing only, privacy OK; gate behind debug).
- **L3** — `RECALL_RE` bare tokens (`history`/`before`/`earlier`) can over-trigger recall (bounded, non-fatal; identity unaffected).
- **L4** — Commit `710c957` bundles ~3,270 unrelated insertions with an ~11-line fix (audit hygiene).

**Flag-OFF safety verdict: PASS** for the committed wiring — every live site has a flag-OFF branch preserving original behavior byte-for-byte (verified). The **only** thing that breaks "behaves exactly as before" is the uncommitted H2 rewrite (no flag gate).

---

## 18. Backend architecture findings

- **Is the OS in the live architecture or beside it?** Mostly **beside it (shadow)**, with a thin layer of flag-gated forks that are OFF by default and have **no UI switch**. Default shipped build = OS effectively inert.
- **Local-first?** **Yes, conclusively.** Works fully with Hindsight disabled (Noop default; bounded; try/catch'd).
- **Meeting memory persisted?** Yes — `meetings.summary_json`.
- **Search real?** Yes (global); in-meeting real but UI-less.
- **Lecture/diagram connected to UI?** **No** — orphaned IPCs.
- **Dead/library-only:** IntelligenceMetrics (dead); lecture/diagram/in-meeting-search (no UI); 5 shadow-only modules.
- **Scale risks:** global search is in-process JS lexical over 50 meetings (no FTS5) — fine for single-user desktop, won't scale to large histories.
- **Privacy risks:** Hindsight retain sends summaries off-device when enabled (correctly default-OFF; the eventual settings UI must make this opt-in explicit).
- **Recommended next PRs:** (1) settings UI to flip flags + configure Hindsight (highest leverage — today it's all dark); (2) wire OR delete the orphaned lecture/diagram/in-meeting-search IPCs; (3) delete `IntelligenceMetrics` or connect it; (4) promote one shadow module to live via its existing divergence telemetry; (5) FTS5 index before search history grows.

---

## 19. Release readiness score (/10)

| Area | Score | Note |
|---|---|---|
| Profile identity | 8 | 14/15; A09 second-person voice bug |
| JD / profile reasoning | 9 | 10/10, real LLM |
| Live WTA | 5 | decision layer solid; **generation unproven headless** |
| Conversation follow-up | 8 | service-verified; coarse entity heuristic |
| Meeting memory | 8 | real DB persist; no live post-meeting trigger headless |
| Global search | 8 | real + UI-wired; no FTS5 scale |
| In-meeting search | 4 | real handler, **no UI** |
| Mode boundaries | 9 | live-logic verified across modes |
| Lecture notes | 5 | service real, **no UI** |
| Diagram intelligence | 5 | service real, **no UI** |
| Privacy isolation | 9 | holds for single-user; Hindsight scope hardcoded `local` |
| Latency | 7 | healthy now; **H2 uncommitted rewrite is a regression risk** |
| Observability | 5 | trace works; **IntelligenceMetrics dead** |
| Fallback safety | 9 | flags-OFF byte-for-byte; Hindsight Noop-safe |
| Hindsight integration | 4 | wired but Noop/dark; honestly documented |

**Final recommendation:**

# READY BEHIND FLAGS ONLY

Ship the **committed, flag-gated wiring** (default OFF, safe, additive). Before any flag goes ON in production: fix H1 (fence-safe normalizer), build the settings UI to actually toggle flags, and wire-or-delete the orphaned IPCs. **Split out** the uncommitted H2 (LLMHelper latency rewrite) and M4 (startup splash) into their own benchmarked release.

---

## 20. Blockers

1. **(Ship-gating only if H2 is committed)** The uncommitted `LLMHelper.ts` latency-hedge removal is always-on and reverses a documented benchmark fix. Do not let it ride this release un-benchmarked / un-kill-switched.
2. **(Enable-gating)** Do not enable `answerDiversityGuard` until `compressToSpeakable` is fence-safe (H1) — it corrupts code/diagrams.

Neither blocks shipping the committed wiring with flags OFF.

---

## 21. Exact next fixes (in priority order)

1. **H1** — make `compressToSpeakable` fence-safe (placeholder-swap fences before stripping scaffold labels, restore after) OR skip compression when a code fence is present.
2. **A09** — fix the experience-count answer builder to first-person ("I have…" not "You have…"); add a voice-repair pass on that branch.
3. **H2** — extract the `LLMHelper.ts` latency-hedge rewrite into its own PR behind a `NATIVELY_TEXT_HEDGE`-style kill-switch + a `benchmark:wta` p95 gate. Do not commit it inside the Intelligence OS release.
4. **M2 / settings UI** — wire `getIntelligenceFlags`/`setIntelligenceFlag` (and `hindsightBaseUrl`/`hindsightApiKey`) into NativelyProSettings so the OS is reachable without env editing.
5. **M2 / orphaned IPCs** — add a lecture-notes panel, diagram view, and in-meeting search box, OR delete `lecture:generate-notes` / `diagram:generate` / `search:in-meeting` + their preload bridges.
6. **M1** — delete `IntelligenceMetrics` or wire `intelligenceMetrics.timing/count` at the recall/search/meeting-memory sites.
7. **WTA E2E** — run the WTA generation under Electron's ABI (real better-sqlite3 + sqlite-vec) or stub `DatabaseManager.getInstance()` so `ModesManager.getActiveMode` returns without the vec0 migration; then the WTA *answer* (not just decision layer) can be E2E'd. Fix the existing `benchmark:wta` so it stops counting clarification stalls as passes.
8. **M3 / L1–L4** — clear the recall race timer in `finally`; add the 17 flag keys to `AppSettings`; gate the recall log behind debug; tighten `RECALL_RE`.

---

### Appendix — supporting artifacts
- `natively-intelligence-e2e-results.json` — 100 per-question records (reproduced by lead).
- `tests/intelligence/e2e/NativelyIntelligence100Questions.test.mjs` + `fixtures/` — the E2E suite.
- `_verify_backend_architect.md` — full static-wiring trace.
- `_verify_code_review.md` — full code review.
- `_verify_test_engineer.md` — full E2E run analysis.
- Prior reports cross-checked: `NATIVELY_INTELLIGENCE_OS_WIRING_FINAL_REPORT.md`, `NATIVELY_INTELLIGENCE_OS_LIVE_VERIFICATION.md`, `NATIVELY_INTELLIGENCE_OS_WIRING_STATUS.md`.
