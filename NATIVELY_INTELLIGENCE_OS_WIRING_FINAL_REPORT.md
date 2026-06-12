# Natively Intelligence OS — Live-Wiring Final Report

**Date:** 2026-06-13
**Branch:** `feature/intelligence-os-live-wiring` (off `main`, pushed to origin)
**Commits:** 16 · **Diff:** 32 files, +6,798 / −19

---

## Executive summary

The prior effort built a complete, tested `electron/intelligence/` component library but, per its own
status report, **almost none of it was wired into the running app**. This effort wired it in —
**phase by phase, every phase behind a feature flag (all default OFF), each independently verified by
a `test-engineer` agent, with the existing test baseline held green throughout (1656 LLM tests, 0
fail, across all 14 phases).** Nothing changes for a user until a flag is turned on.

**16 commits, one per phase.** 12 production files touched, 14 new wiring test suites added.

---

## What is now live (by phase)

| # | Phase | Flag (env, default OFF) | Type | What it does when enabled |
|---|---|---|---|---|
| 1 | IntelligenceTrace | `NATIVELY_INTELLIGENCE_TRACE` | observe-only | Per-answer trace on manual + WTA (hashed query, no PII) |
| 2 | **Durable memory fix** | `NATIVELY_DURABLE_MEMORY_WINDOW` | **real fix** | WTA long-range memory reads the durable transcript (fixes the 7200s-capped-to-120s bug) |
| 3 | ProfileTree guard | `NATIVELY_PROFILE_TREE_V2` | safety | Widens the assistant-identity sanitizer by mode (catches misclassified candidate-identity asks) |
| 4 | **OutputShapeNormalizer** | `NATIVELY_ANSWER_DIVERSITY_GUARD` | **real capability** | Cleans WTA answers (empty bullets, scaffold labels) — WTA had no polish before |
| 5 | ContextRouter | `NATIVELY_CONTEXT_ROUTER_V2` | shadow | Records routing-divergence telemetry vs the live path |
| 6 | LiveTranscriptBrain | `NATIVELY_LIVE_TRANSCRIPT_BRAIN` | shadow | Records question-parity vs the inline WTA window |
| 7 | PromptAssemblerV2 | `NATIVELY_PROMPT_ASSEMBLER_V2` | shadow | Builds the context-inclusion report over real WTA inputs (real prompt untouched) |
| 8 | **Meeting Memory** | `NATIVELY_MEETING_MEMORY_V2` | **real capability** | Persists structured meeting memory (entities/topics/decisions/…) into `summary_json` (no migration) |
| 9 | **Global search** | `NATIVELY_GLOBAL_SEARCH_V2` | **real capability** | Replaces the fake Launcher "literal search" with real local-DB search |
| 10 | **In-meeting search** | `NATIVELY_IN_MEETING_SEARCH_V2` | **real capability** | Fast local lexical search over the current transcript (timestamped) |
| 11 | **Conversation memory** | `NATIVELY_CONVERSATION_MEMORY_V2` | **real capability** | Manual bare follow-ups resolve against the prior turn |
| 12 | **Lecture + Diagram** | `NATIVELY_LECTURE_INTELLIGENCE_V2`, `NATIVELY_DIAGRAM_INTELLIGENCE` | **real capability** | IPCs: structured lecture notes + validated Mermaid diagrams from the transcript |
| 13 | Hindsight retain | `NATIVELY_HINDSIGHT_POST_MEETING_RETAIN` (+`NATIVELY_HINDSIGHT_MEMORY`) | wiring + safe-disabled | Async-retains meeting summaries IF a Hindsight server + client are present (Noop otherwise) |
| 14 | Flag toggle contract | — | infra | `intelligence-flags:get/set` IPC so flags can be toggled without editing env |

## Honest live-vs-shadow-vs-disabled map

- **Real flag-gated capability** (changes the answer/result): Phases 2, 3, 4, 8, 9, 10, 11, 12.
- **Observe-only / shadow** (telemetry only, de-risks a future cutover): Phases 1, 5, 6, 7.
- **Wiring + safe-disabled path** (no working feature without external setup): Phase 13 (Hindsight).
- **Backend contract, renderer UI deferred:** lecture/diagram panels (12), in-meeting search box (10),
  flag settings panel (14). Phase 9's literal-search reroute IS wired into `Launcher.tsx`.

## Files changed (production)

`electron/ipcHandlers.ts`, `electron/IntelligenceEngine.ts`, `electron/IntelligenceManager.ts`,
`electron/MeetingPersistence.ts`, `electron/llm/WhatToAnswerLLM.ts`, `electron/preload.ts`,
`electron/intelligence/intelligenceFlags.ts`, `electron/intelligence/SearchOrchestrator.ts`,
`electron/intelligence/ConversationMemoryService.ts`, `src/components/Launcher.tsx`,
`src/types/electron.d.ts`, `electron/main.ts` (the last only removed a pre-existing duplicate method
to get a clean typecheck baseline).

## Tests

- **14 new wiring test suites** (one per phase), all green.
- Intelligence suite: **435 pass / 0 fail / 9 todo** (was ~228 before; +~200 from wiring tests).
- **LLM baseline held at 1656 pass / 0 fail** through every phase — zero regression.
- Services: IntelligenceEngine 33/0, meeting pipeline 15/0. (The full services suite's 41 failures are
  pre-existing/environmental — identical with and without this work, 0 intelligence/meeting-related.)

## Improvements the test-engineer caught and we fixed mid-flight

1. **Phase 5** — divergence proxy ignored profile availability (false-fired) → AND'd `profileAvailable`.
2. **Phase 9** — handler scanned 200 meetings but the renderer holds 50 (top hit silently un-openable) → aligned to 50.
3. **Phase 10** — `inMeetingSearch` scoring clamped the phrase bonus to invisibility → rebalanced to `0.7·coverage + 0.3·phrase` so phrase matches outrank scattered (improves global + in-meeting ranking).
4. **Phase 11** — recency fallback too narrow (`why?`/`how?`/`go on` dead-ended) → widened to content-free continuation verbs.
5. **Phase 9** — a floating Promise in the async renderer handler → made the handler synchronous with a voided IIFE (React-Doctor hook).
6. **Phase 0** — removed a pre-existing duplicate `applyInitialDisguise()` in `main.ts` (2 pre-existing typecheck errors) to establish a clean gate.

## Non-negotiables honored

- Hindsight never required; works disabled (Noop default, proven). Never blocks live answers (async
  retain, post-save, background worker). Never on the live current-question path. Isolation by bank +
  strict tags, not metadata. Recall not wired (correctly deferred — last to enable).
- Deterministic identity routing untouched (Phase 3 only adds a defense-in-depth net).
- No partial-STT synchronous retain. No stealth/evasion features. Every phase flag-gated + tested.
- Existing fallback paths preserved everywhere (flag OFF = byte-for-byte original behavior, verified
  per phase).

## Hindsight status

Researched (Phase 0, MIT, `@vectorize-io/hindsight-client`) and the retain path is wired, but the
client is **not installed**, there is **no server/Postgres**, and recall is **not wired**. The adapter
falls back to Noop, so the app works fully without it. To enable: see `docs/HINDSIGHT_LOCAL_SETUP.md`
(install client → run server → set `HINDSIGHT_BASE_URL` → enable flags in order: post-meeting retain →
global recall → live recall last).

## Rollback

- **Per feature:** unset its `NATIVELY_*` env var (or set the `SettingsManager` key false) → instant,
  no redeploy. All flags default OFF, so the merged branch changes no behavior until a flag is on.
- **Whole effort:** the branch is 16 isolated, per-phase commits — revert any subset. No DB migrations,
  no schema changes, no provider/streaming changes were made.

## Known limitations

- Several phases ship a **backend IPC + typed preload contract** but not the renderer panel
  (lecture notes view, in-meeting search box, flag settings UI) — clean separate-feature boundaries.
- Phases 5/6/7 are **shadow/observe-only** — they ship no user-visible behavior (intentionally).
- Phase 13 Hindsight **cannot be exercised end-to-end** without installing the client + running a
  server — this effort ships the wiring + safe-disabled path, not a working memory feature.
- The deterministic (no-LLM) meeting/lecture/diagram/search extraction is a solid v1 **structural
  floor** but coarse on messy real-world input (calibrated tradeoff for zero-latency + never-hallucinate).
- Verification was **headless** — the interactive GUI walk-through
  (`NATIVELY_INTELLIGENCE_OS_LIVE_VERIFICATION.md` §C) is the one remaining human step.

## Recommended next PR(s)

1. **Enable + soak the real-capability flags** (2, 4, 8, 9, 10, 11) in dev, run the GUI script, then
   stage to production one at a time. Start with Phase 2 (the durable-memory bug fix) — highest value,
   lowest risk.
2. **Build the deferred renderer panels** against the typed IPC contracts (lecture notes, in-meeting
   search box, flag settings UI).
3. **Promote the shadow phases (5/6/7) to driving** once their divergence/parity telemetry is clean in
   production.
4. **Stand up Hindsight** (optional, power-user) per the setup doc; enable retain → global recall →
   live recall in order.
5. Optionally: a separate cleanup PR for the pre-existing React-Doctor findings in `Launcher.tsx`
   (unrelated to this work; out of scope here).

---

*16 phases, 16 commits, every phase flag-gated and test-engineer-verified, baseline green throughout.
The tested Intelligence OS library is now wired into the real app — safely, incrementally, and
reversibly — with the existing answer path unchanged until a flag is turned on.*
