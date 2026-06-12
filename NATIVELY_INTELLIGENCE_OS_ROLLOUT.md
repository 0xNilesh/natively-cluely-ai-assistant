# Natively Intelligence OS — Rollout & Backward Compatibility (Phase 19)

**Date:** 2026-06-12
**Posture:** Every Intelligence OS capability ships behind a flag that **defaults OFF**. With all flags off, the app behaves exactly as before (verified: `test:llm` 1656/0 throughout, services 55/55). Each flag is independently gated (verified by `RolloutFallback.test.mjs`) — enabling one never enables another.

## Flag reference

All flags follow the repo convention: `process.env.NATIVELY_*` (read fresh) → `SettingsManager` opt-in → default. An explicit `off` (env or settings) always wins → **instant rollback, no redeploy**.

| Flag (key) | Env var | Setting key | Default | Disable / fallback |
|---|---|---|---|---|
| trace | `NATIVELY_INTELLIGENCE_TRACE` | `intelligenceTraceEnabled` | OFF | off → no trace collection (zero-cost no-op) |
| profileTreeV2 | `NATIVELY_PROFILE_TREE_V2` | `profileTreeV2Enabled` | OFF | off → existing identity fast-path |
| answerDiversityGuard | `NATIVELY_ANSWER_DIVERSITY_GUARD` | `answerDiversityGuardEnabled` | OFF | off → existing answerPolish (already live) |
| contextRouterV2 | `NATIVELY_CONTEXT_ROUTER_V2` | `contextRouterV2Enabled` | OFF | off → existing scattered routing |
| liveTranscriptBrain | `NATIVELY_LIVE_TRANSCRIPT_BRAIN` | `liveTranscriptBrainEnabled` | OFF | off → existing IntelligenceEngine inline windows |
| promptAssemblerV2 | `NATIVELY_PROMPT_ASSEMBLER_V2` | `promptAssemblerV2Enabled` | OFF | off → existing PromptAssembler (WTA) |
| meetingMemoryV2 | `NATIVELY_MEETING_MEMORY_V2` | `meetingMemoryV2Enabled` | OFF | off → existing MeetingPersistence + PostCallWorkflow |
| globalSearchV2 | `NATIVELY_GLOBAL_SEARCH_V2` | `globalSearchV2Enabled` | OFF | off → existing rag:query-global |
| inMeetingSearchV2 | `NATIVELY_IN_MEETING_SEARCH_V2` | `inMeetingSearchV2Enabled` | OFF | off → existing rag:query-live |
| lectureIntelligenceV2 | `NATIVELY_LECTURE_INTELLIGENCE_V2` | `lectureIntelligenceV2Enabled` | OFF | off → existing lecture mode prompt |
| diagramIntelligence | `NATIVELY_DIAGRAM_INTELLIGENCE` | `diagramIntelligenceEnabled` | OFF | off → no diagram generation |
| durableMemoryWindow | `NATIVELY_DURABLE_MEMORY_WINDOW` | `intelligenceDurableMemoryWindow` | OFF | off → 120s window (the verified bug stays dormant; fix is opt-in) |
| hindsightPostMeetingRetain | `NATIVELY_HINDSIGHT_POST_MEETING_RETAIN` | `hindsightPostMeetingRetainEnabled` | OFF | off → no retain |
| hindsightMemory | `NATIVELY_HINDSIGHT_MEMORY` | `hindsightMemoryEnabled` | OFF | off → NoopMemoryProvider (app works fully) |
| hindsightLiveRecall | `NATIVELY_HINDSIGHT_LIVE_RECALL` | `hindsightLiveRecallEnabled` | OFF | off → no live recall (last to enable) |
| intelligenceOsEnabled | `NATIVELY_INTELLIGENCE_OS` | `intelligenceOsEnabled` | OFF | umbrella master switch |

## Recommended enable order (lowest risk first)

```
1.  intelligence_trace_enabled          (observe-only; zero behavior change)
2.  profile_tree_v2_enabled             (identity — 100% test-backed)
3.  answer_diversity_guard_enabled      (already live in manual path)
4.  context_router_v2_enabled           (pure decision; consult-only)
5.  live_transcript_brain_enabled       (read facade)
6.  prompt_assembler_v2_enabled
7.  meeting_memory_v2_enabled           (post-meeting background only)
8.  global_search_v2_enabled
9.  in_meeting_search_v2_enabled
10. lecture_intelligence_v2_enabled
11. diagram_intelligence_enabled
12. durable_memory_window_enabled       (after a live-session-memory benchmark)
13. hindsight_post_meeting_retain_enabled (requires a running Hindsight + config)
14. hindsight_global_recall  (via hindsight_memory)
15. hindsight_live_recall_enabled       (LAST — only after live-latency benchmarks pass)
```

## Rollback

- **Per feature:** set its env var to `off` (or its `SettingsManager` key to `false`) → instant, no redeploy.
- **Whole layer:** delete `electron/intelligence/` + revert the single `SessionTracker.getDurableContext` method → exact prior state. No DB migrations, no schema changes, no provider/streaming changes were made.
- **Hindsight:** if a configured Hindsight service is unavailable, the adapter constructs to `enabled=false` → Noop → live answers, global search (local DB), and meeting summaries all keep working; retain jobs are simply skipped.

## Backward-compatibility guarantees (verified)

- All flags OFF → `test:llm` 1656/0, services 55/55, no behavior change.
- The app **works with Hindsight disabled or unavailable** (Noop default; tested).
- No existing live answer path was rewired; the new modules are a consult-only layer beside them.
