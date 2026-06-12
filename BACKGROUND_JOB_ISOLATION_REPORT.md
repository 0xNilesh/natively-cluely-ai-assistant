# Background Job Isolation Report (2026-06-12)

## Problem
After meeting end, three background pipelines run **in the Electron main
process**: meeting summary generation (LLM), RAG chunk persistence, and the
embedding queue drain. better-sqlite3 is synchronous, so each queue item
interleaves blocking DB statements with live manual/WTA answers. Users felt
this as the app "lagging/hanging after ~50 questions."

## Priority model implemented

| priority | work | mechanism |
|---|---|---|
| P0 | UI / manual chat / WTA answer in flight | `ForegroundGate.begin/end` around the request |
| P1 | active STT transcript | unchanged (event-driven, lightweight) |
| P2 | live RAG indexing | `LiveRAGIndexer.tick` awaits `waitUntilIdle()` between chunk embeds |
| P3 | meeting summary | already fire-and-forget; its DB writes are brief; LLM waits yield naturally |
| P4 | embedding queue drain / persistence | `EmbeddingPipeline.processQueue` awaits `waitUntilIdle()` between items |

## Implementation
- **NEW `electron/services/ForegroundGate.ts`** — tiny advisory gate:
  - `begin(kind)` / `end(token)` mark foreground work (manual handler in
    `ipcHandlers.gemini-chat-stream`, live path in
    `IntelligenceEngine.runWhatShouldISay`; both release in `finally`).
  - `waitUntilIdle(maxWaitMs=30s)` — background loops poll every 250ms.
  - Self-healing: a leaked `begin` auto-expires after 60s; the capped wait
    guarantees background work always eventually progresses (no starvation).
- `electron/rag/EmbeddingPipeline.ts` — drain loop yields before each item.
- `electron/rag/LiveRAGIndexer.ts` — per-chunk embed+store yields first.

## Why advisory (not a worker thread)
Moving better-sqlite3 work off-thread is a much larger change (connection
ownership, WAL contention). The gate removes the *user-visible* contention —
during an answer, zero background DB statements run — while keeping the
existing single-connection architecture intact.

## Verification
- `electron/llm/__tests__/ManualRealSessionFixes2026_06_12.test.mjs` pins the
  wiring (gate present in the manual handler, both drain loops yield).
- The sequential stress runner spins a synthetic background drain loop doing
  2ms of sync busy-work per tick that yields to the gate, and reports how many
  ticks ran *during* answers (target: ~0) — see
  `MANUAL_SEQUENTIAL_STRESS_REPORT.md` ("background ticks" row).
- Meeting-end does not block manual questions: `stopMeeting` was already
  fire-and-forget; the gate now also pauses its downstream embedding drain
  while a question is being answered.
