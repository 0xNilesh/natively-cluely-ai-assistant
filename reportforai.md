# Natively Intelligence OS — Complete Status, Wiring & Test Report

**For:** the next AI/engineer picking this up
**Date:** 2026-06-12
**Repo:** `/Users/evin/natively-main-pi` (git worktree)
**Branch:** `feature/profile-intelligence-v3`
**Commit state:** NOT committed. All work is uncommitted in the working tree.

---

## 0. TL;DR — read this first

A complete, type-safe, fully unit-tested **intelligence component library** was built under
`electron/intelligence/` across the prompt's 20 phases. It compiles, builds, and all its tests
pass with **zero regression** to the existing 1656-test baseline.

**BUT: almost none of it is wired into the running app.** It is a *parallel shelf-ready library*,
not a live feature. Verified by grep: **zero live app files import any `electron/intelligence/*`
module.** Every feature flag defaults OFF, and flipping a flag ON changes nothing today because no
live call site consults these modules.

**Hindsight is interface-only:** the client package is NOT installed, there is NO Postgres/pgvector
server, NO LLM key, NO config. Its adapter falls back to a Noop and its tests use a mock client. It
has never talked to a real Hindsight server.

So: **built + tested ≠ wired + working in production.** This report draws that line precisely.

---

## 1. Test results (re-verified fresh, this session)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck:electron` | ✅ **0 errors** |
| Build | `npm run build:electron` | ✅ **clean** (esbuild → dist-electron) |
| Intelligence suite | `node --test "electron/intelligence/__tests__/**/*.test.mjs"` | ✅ **237 tests · 228 pass · 0 fail · 9 todo** |
| LLM baseline | `node --test "electron/llm/__tests__/**/*.test.mjs" …` | ✅ **1666 tests · 1656 pass · 0 fail · 10 skipped** |
| Services | `node --test electron/services/__tests__/IntelligenceEngine*.test.mjs …` | ✅ **55 / 55** |

### About the "9 todo"
They are **historical Phase-2 placeholder markers** written *before* those systems were built (the
prompt explicitly asked for skipped/TODO tests for not-yet-built systems). Every one of those 9
systems was subsequently built and has its own real passing suite. They are superseded markers, not
gaps. They live in `electron/intelligence/__tests__/baseline/PendingSystemsBaseline.test.mjs`.

### About the "10 skipped"
Pre-existing Go/Java toolchain gates in the LLM suite (code-verification tests that need those
compilers installed). Unrelated to this work.

### Tests are REAL but they test the LIBRARY in isolation
- They import the compiled modules from `dist-electron` and assert behavior directly.
- They do NOT exercise the live IPC → IntelligenceEngine → provider path with these modules in it,
  because that path does not call these modules.
- Hindsight tests use a **mock client object**, never the real `@vectorize-io/hindsight-client`.

---

## 2. Wiring status — the brutally honest table

| Module | Built | Type-safe | Unit-tested | **Imported by live app?** | **Changes user behavior today?** |
|---|---|---|---|---|---|
| intelligenceFlags | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| IntelligenceTrace | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| ProfileTreeService | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| LiveTranscriptBrain | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| ContextRouter | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| OutputShapeNormalizer | ✅ | ✅ | ✅ | ❌ NO* | ❌ NO |
| ContextFusionEngine | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| PromptAssemblerV2 | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| MeetingMemoryService | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| SearchOrchestrator | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| ConversationMemoryService | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| LectureIntelligenceService | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| DiagramIntelligenceService | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| IntelligenceMetrics | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| memory/MemoryProvider (+Noop) | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| memory/HindsightClientAdapter | ✅ | ✅ | ✅ (mock) | ❌ NO | ❌ NO |
| memory/HindsightTagBuilder | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| memory/HindsightRetainQueue | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| memory/LongTermMemoryService | ✅ | ✅ | ✅ | ❌ NO | ❌ NO |
| `SessionTracker.getDurableContext()` (the 1 edit to an existing file) | ✅ | ✅ | ✅ | ❌ NOT CALLED | ❌ NO |

\* `OutputShapeNormalizer` is a *facade over* `answerPolish.ts`. The underlying `answerPolish.ts`
(cleanAnswerArtifacts + AnswerDiversityGuard + compressToSpeakable) IS already wired live in
`ipcHandlers.ts` (~line 1223) — that predates this work. The new facade wrapping it is NOT wired.

### Verification commands (run these yourself to confirm)
```bash
# Returns NOTHING = no live code imports the intelligence layer:
grep -rn "intelligence/" electron --include="*.ts" | grep -v "electron/intelligence/" | grep -v "__tests__"

# Confirms the live engine STILL uses the 120s-capped getContext, not the durable fix:
grep -n "getContext(this.LIVE_MEMORY_WINDOW_SECONDS)\|getDurableContext" electron/IntelligenceEngine.ts
# → line 819 uses getContext(...). getDurableContext is never called by live code.
```

---

## 3. The verified bug — fixed in code, NOT live

**Bug:** `IntelligenceEngine.ts:130` sets `LIVE_MEMORY_WINDOW_SECONDS = 7200` and at line 819 calls
`this.session.getContext(7200)` expecting a 2-hour window. But `SessionTracker.getContext()` reads
`contextItems`, which `evictOldEntries()` hard-filters to **120 seconds** on every transcript
segment. So the "2-hour long-range recall" silently sees at most ~120s — an entity named at minute 1
is gone by minute 3.

**Fix status:**
- ✅ `SessionTracker.getDurableContext()` written (reads the durable `fullTranscript`).
- ✅ Exposed via `LiveTranscriptBrain.getMemoryWindow()` (flag-gated, `durableMemoryWindow`).
- ✅ Proven by a minute-1→minute-62 survival test.
- ❌ **NOT LIVE.** `IntelligenceEngine.ts:819` still calls the buggy `getContext(7200)`. To go live:
  change that one line to call `getDurableContext(...)` behind the flag. **This is the single
  highest-value, lowest-risk wiring step and it is not done.**

---

## 4. Hindsight — your instinct was 100% correct

> "is hindsight configured correctly? if im not wrong it needs a postgres sql on device and llm api key"

Correct on both counts. Current Hindsight state:

| Requirement | State |
|---|---|
| `@vectorize-io/hindsight-client` in package.json | ❌ **NOT present** (0 matches) |
| `@vectorize-io/hindsight-client` in node_modules | ❌ **NOT installed** |
| Postgres 14+ with pgvector running | ❌ **None** |
| LLM API key for Hindsight server | ❌ **None** |
| `HINDSIGHT_*` / `NATIVELY_HINDSIGHT_*` env config | ❌ **None** in `.env` / `.env.example` |
| `baseUrl` configured | ❌ **None** |
| Adapter behavior with all the above missing | ✅ Falls back to **NoopMemoryProvider** (app works, memory disabled) |
| Tests | ✅ Pass — but use a **MOCK client**, never the real one |

### What Hindsight actually requires to run (verified from the cloned repo in Phase 0)
- **PostgreSQL 14+ with a vector extension** (pgvector default). Embedded `pg0` exists for dev only.
- **An LLM provider + API key** for the server (OpenAI/Anthropic/Gemini/Groq/Ollama).
- Run via **Docker** (`ghcr.io/vectorize-io/hindsight:latest`, API on `:8888`, UI on `:9999`) OR
  **Hindsight Cloud** (managed; signup at ui.hindsight.vectorize.io) OR pip/Helm.
- License: **MIT**. Client construct: `new HindsightClient({ baseUrl, apiKey })`.

### To make Hindsight actually work (not done):
```bash
# 1. Install the client (currently absent)
npm install @vectorize-io/hindsight-client

# 2. Stand up a server (Docker example — needs Docker + an LLM key)
docker run -it --pull always --name hindsight --restart unless-stopped \
  -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest

# 3. Add config (no Natively code reads these yet — needs wiring)
#    HINDSIGHT_BASE_URL=http://localhost:8888
#    HINDSIGHT_API_KEY=...   (cloud only)

# 4. Enable flags in order: hindsight_post_meeting_retain → hindsight_memory → hindsight_live_recall (last)
# 5. Wire LongTermMemoryService.fromFlags(config) into a live call site (NOT done)
```

**Bottom line on Hindsight:** it is a correct, isolation-safe, timeout-bounded *adapter design* that
is proven against a mock. It is **not installed, not configured, has no backend, and is not wired**.
The whole point of the Noop default is that Natively works fine without it — which is the only state
it's ever been in.

---

## 5. What WAS delivered (the real, verified value)

19 source modules (~3,500 LOC) + 23 test files (237 tests), all green:

**Source modules** (`electron/intelligence/`):
```
intelligenceFlags.ts          16 feature flags, all default OFF, env+settings, fresh-read
IntelligenceTrace.ts          observe-only per-answer record, sha256 query hash (no PII)
ProfileTreeService.ts         deterministic identity/projects/skills/roleFit + perspective guard
LiveTranscriptBrain.ts        getLiveWindow/getHotWindow/getCurrentQuestion/... + durable-window fix
ContextRouter.ts              one decision object (useProfileTree/useHindsightRecall/... + contract)
OutputShapeNormalizer.ts      facade over the live answerPolish.ts
ContextFusionEngine.ts        priority order + conflict rules + mode contamination + injection guard
PromptAssemblerV2.ts          trust-tagged XML + inclusion report + 9 answer contracts
MeetingMemoryService.ts       entity/topic/decision/action extraction (no-LLM)
SearchOrchestrator.ts         globalSearch (fusion weights + isolation) + inMeetingSearch
ConversationMemoryService.ts  layered memory, strict-timeout cross-session
LectureIntelligenceService.ts notes/concepts/flashcards/exam-Qs/revision + course memory
DiagramIntelligenceService.ts Mermaid gen + validation + exact-vs-reconstructed safety
IntelligenceMetrics.ts        timers(p50/p95)/counters/rates/gauges registry
memory/MemoryProvider.ts      interface + NoopMemoryProvider (default)
memory/HindsightClientAdapter.ts   optional-dep wrapper (lazy require → Noop if absent)
memory/HindsightTagBuilder.ts      per-scope bank + strict isolation tags (hashed PII)
memory/HindsightRetainQueue.ts     async, concurrency-1, backpressure-bounded
memory/LongTermMemoryService.ts    facade, fromFlags() → Noop unless configured
```

**Quality properties that ARE real and tested:**
- Every module is pure/deterministic where claimed, never throws, bounded.
- Privacy/isolation tested (Alice/Bob can't see each other across ProfileTree, search, conversation).
- Latencies measured: LiveTranscriptBrain 0.012ms, inMeetingSearch 0.197ms/1000 chunks (vs 30ms/150ms budgets).
- Mode contamination tested (sales/lecture don't pull candidate profile).
- Diagram safety tested (text-derived never labeled "exact"; no fabricated edges).
- Zero regression: the 1656-test baseline stayed green through all 21 phases.

---

## 6. What is NOT done (the integration gap)

1. **No live wiring.** Nothing in `ipcHandlers.ts` / `IntelligenceEngine.ts` / `LLMHelper.ts` calls
   the intelligence layer. The modules are imported only by their own tests.
2. **The durable-memory bug fix is not live** (IntelligenceEngine:819 still uses the buggy call).
3. **Hindsight is not installed, configured, or connected to any backend.**
4. **No Settings UI** to toggle the 16 flags (they're env/SettingsManager-readable but no UI surfaces them).
5. **Meeting Memory output is not persisted** as DB columns (extraction runs in memory only; the
   real DB still has only `summary_json` + RAG chunks).
6. **The renderer "literal search"** (`Launcher.tsx`) is still the fake AI-query passthrough; the new
   `SearchOrchestrator` is not connected to the renderer/IPC.
7. **Nothing is committed** to git.

---

## 7. Recommended next steps (in priority order)

1. **Wire the durable-memory bug fix live** — change `IntelligenceEngine.ts:819`
   `getContext(LIVE_MEMORY_WINDOW_SECONDS)` → `getDurableContext(...)` behind `durableMemoryWindow`,
   run `npm run benchmark:livememory`, flip default once green. **Smallest real win, fixes an actual bug.**
2. **Adopt `ContextRouter` + `ProfileTreeService`** at the real `ipcHandlers` call sites incrementally,
   each behind its flag, each benchmarked against current behavior.
3. **Wire `IntelligenceTrace` + `IntelligenceMetrics`** into the live manual + WTA paths (observe-only,
   safe) to get production diagnostics first.
4. **Persist `MeetingMemoryService`** output as first-class DB columns.
5. **Replace the fake `Launcher.tsx` literal search** with `SearchOrchestrator` over RAG + local DB.
6. **Hindsight (only if wanted):** `npm install @vectorize-io/hindsight-client`, stand up
   Postgres+pgvector + Docker container + LLM key, add config, wire `LongTermMemoryService.fromFlags`,
   enable flags in order (retain → global recall → live recall last).
7. **Commit** the work to the branch.

---

## 8. Companion docs (already in the repo root)

- `PHASE_STATUS.md` — per-phase status tracker (all 21 marked complete, with files/tests/notes).
- `NATIVELY_EXTERNAL_RESEARCH_NOTES.md` — Hindsight API/tags/deployment research (Phase 0).
- `NATIVELY_INTELLIGENCE_OS_IMPLEMENTATION_PLAN.md` — architecture audit + files-found/NOT-FOUND maps.
- `NATIVELY_INTELLIGENCE_OS_OBSERVABILITY.md` — metrics + perf-investigation checklist.
- `NATIVELY_INTELLIGENCE_OS_ROLLOUT.md` — flag reference + enable order + rollback.
- `NATIVELY_INTELLIGENCE_OS_FINAL_REPORT.md` — full final report.
- `_external_research/hindsight/` — the cloned Hindsight repo (gitignored, NOT vendored, NOT committed).

---

## 9. One-paragraph honest summary

The 20-phase Intelligence OS was built end-to-end as a clean, type-safe, comprehensively unit-tested
component library (237 tests, 0 fail, 0 regression to the 1656-test baseline). It is **shelf-ready
but not shelf-installed**: zero live app code imports it, the one real bug fix it contains is not
called by the live engine, and Hindsight is an interface with a Noop fallback that has never touched
a real server (no client installed, no Postgres/pgvector, no LLM key, no config). The remaining work
is **integration**, not construction — wiring the tested modules into the live request path behind
their flags, one benchmarked step at a time. Everything defaults OFF, so the running app behaves
exactly as it did before this work.
```
```
