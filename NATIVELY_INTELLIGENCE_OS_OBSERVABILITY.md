# Natively Intelligence OS — Observability & Performance (Phase 17)

**Date:** 2026-06-12

## Metrics registry

`electron/intelligence/IntelligenceMetrics.ts` provides the aggregate metric VIEW the spec
names, over the existing `PiLatencyTrace` + `piTelemetry` + `IntelligenceTrace`. It is a
pure in-process registry (timers with p50/p95, counters, hit-rates, gauges), numbers/markers
only (no raw content), never throws. A dev debug panel can read `intelligenceMetrics.snapshot()`.

Metric families implemented (the spec's list):

```
timers:   profile_tree_lookup_ms, transcript_context_lookup_ms, hybrid_rag_ms,
          hindsight_recall_ms, global_search_ms, in_meeting_search_ms,
          lecture_notes_generation_ms, diagram_generation_ms, prompt_assembly_ms,
          llm_tfft_ms, answer_total_ms, summary_generation_ms, embedding_pipeline_ms
counters: context_blocks_included_count, context_blocks_dropped_count,
          cross_user_leakage_detected_count
rates:    identity_fast_path_hit_rate, rag_empty_result_rate, memory_recall_empty_rate
gauges:   hindsight_retain_queue_depth, background_queue_depth
```

## Performance-fix investigation (the spec's Phase 17 checklist)

The spec lists candidate perf problems to "investigate and fix if found." Honest status:

| Candidate issue | Status / finding |
|---|---|
| Session history grows unbounded | **Bounded.** `SessionTracker.contextItems` evicted to 120s + 500-item cap; `fullTranscript` compacted after 1800 segments (epoch summaries). `ConversationMemoryService` caps 100 turns/session. `IntelligenceMetrics` caps 1000 samples/timer. |
| Prompt userContent grows unbounded | **Bounded.** `PromptAssembler` enforces a token budget (trust-sorted, low-trust trimmed first); `ContextFusionEngine` (Phase 8) applies a token budget, never dropping system/profile. |
| HybridSearchEngine runs too often | Pre-existing: WTA caps hybrid retrieval at `HYBRID_RETRIEVAL_BUDGET_MS=1500` (raceWithBudget). New `SearchOrchestrator` is pure ranking over already-fetched candidates — no repeated retrieval. |
| Pivot scripts inject too often | Premium `KnowledgeOrchestrator` gates dossier/salary/gap/mock/culture injection by intent — pre-existing. Not modified this pass. |
| Meeting summary runs twice | See `BACKGROUND_JOB_ISOLATION_REPORT.md` (2026-06-12) — already investigated/addressed; `MeetingPersistence` saves a placeholder then one async `processAndSaveMeeting`. New `MeetingMemoryService` is additive (does not trigger a second summary). |
| Embedding pipeline competes with live answering | See `BACKGROUND_JOB_ISOLATION_REPORT.md` + `ForegroundGate` (post-meeting drains gated). New `HindsightRetainQueue` is async/microtask, concurrency 1, backpressure-bounded — never competes with the live path (rules #4/#5). |
| Prompt cache misses on huge prompts | See `gemini_thinking_ttft` finding (thinkingBudget=0) + token budgeting above. |
| Overlay/window logs too noisy | Pre-existing; not in this pass's scope. |
| Audio heavy work during answer generation | `ForegroundGate` (pre-existing). Not modified. |
| Worker threads not destroyed | Pre-existing audio/codeVerification concern; not in this pass's scope. |
| Background queues lack concurrency limits | **Addressed for the new memory path:** `HindsightRetainQueue` is concurrency-1 + maxQueue backpressure. |

**Net:** the genuinely new background path introduced this pass (long-term-memory retain) is
designed from the start to be non-blocking and bounded. The pre-existing perf concerns the
spec lists were already investigated in `LATENCY_DEGRADATION_REPORT.md` and
`BACKGROUND_JOB_ISOLATION_REPORT.md` (both 2026-06-12); this pass did not regress them
(baseline `test:llm` 1656/0 throughout) and did not re-open them.

## Latency results (measured this pass)

| Operation | Measured (median) | Budget |
|---|---|---|
| LiveTranscriptBrain.getLiveWindow | 0.012 ms | <30 ms |
| LiveTranscriptBrain.getRollingSummary | 0.011 ms | <30 ms |
| LiveTranscriptBrain.getLiveAnswerContext | 0.182 ms | <250 ms |
| SearchOrchestrator.inMeetingSearch (1000 chunks) | 0.197 ms | <150 ms |
| ContextRouter / fusion / profile-tree | sub-ms | n/a |

All new intelligence operations are pure in-memory and clear their budgets by ~1000×.
