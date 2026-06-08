# Electron Runtime Test Report — 2026-06-07c

## Test command taxonomy (new)

| script | what it runs | runtime |
|---|---|---|
| `npm run test:llm` | `electron/llm/__tests__` + codeVerification (pure logic) | system Node — deterministic |
| `npm run test:services` | `electron/services/__tests__` (logic + DB/UI/audio integration) | system Node |
| `npm run test:electron` | services suite under the Electron binary | `ELECTRON_RUN_AS_NODE` |

## Electron-runtime smoke (live SessionMemory)

`ELECTRON_RUN_AS_NODE=1 NATIVELY_ENABLE_LIVE_SESSION_MEMORY=on electron /tmp/smoke_livemem.cjs`
→ **6/6 pass**: modules load under the Electron binary; 62-minute recall (ms→seconds);
coding boundary blocks the project; context-free clarification (no identity leak).
`better-sqlite3` loads cleanly in this environment.

## CI-blocker FIXED: OpenAIRealtimeGAProtocol hang

**Before:** the suite passed all subtests but the **process never exited** — the GA STT
class arms a keep-alive `setInterval` / reconnect timer that kept the Node event loop
alive, hanging CI indefinitely.

**Fix (additive, no assertion changed):** an `after()` cleanup hook + `trackStt()`
wrapping every `new OpenAIStreamingSTT(...)` tears down each instance's timers/sockets
after the suite. The suite now **exits cleanly** (no `--test-force-exit` needed — a
clean teardown, not a masked leak). @test-engineer confirmed this is a real fix that
*improves test honesty*.

**Surfaced (not caused):** with the hang gone, the suite now reports its true result —
**34 pass / 4 fail**. The 4 failures are **pre-existing GA-protocol source drift** in
`electron/audio/OpenAIStreamingSTT.ts` (an audio module untouched by this work): the
source sends beta `session.update` (tests assert GA `transcription_session.update`),
lacks `input_audio_format`, and `session.created` falls through to set `isSessionReady`.
These were **hidden by the hang**, are unrelated to Profile Intelligence / SessionMemory,
and are filed as a separate STT bug to fix.

## Service-suite status (hang fixed → suite completes)

Running the full `electron/services/__tests__` now **completes** (1339 tests):

| bucket | count | cause |
|---|---|---|
| **pass** | 1264 | logic suites incl. ProfileGroundingV2 19/19, NegotiationStickiness 25/25 |
| **skipped** | 30 | toolchain/runtime-gated |
| **fail** | 33 | **all pre-existing environment blockers — NONE from this work** |

The 33 failures break down as:
- **`better-sqlite3` Electron-ABI mismatch** under system Node (`ERR_DLOPEN_FAILED
  NODE_MODULE_VERSION`) — 72 DLOPEN errors → the KnowledgeOrchestrator / ingest / RAG /
  categorized-skills DB integration tests. Run under Electron (`test:electron`) to clear.
- **UI tests needing the renderer** (SettingsOverlay, audio-test, open-external IPC).
- **macOS permission tests needing the darwin runtime**.
- **4 OpenAIStreamingSTT GA-protocol source-drift** (above).

**Zero** failures reference the new modules (SessionMemory, liveSessionMemory,
piTelemetry, transcriptEntityExtractor, rollout) — verified by grep. My-area service
suites (ProfileGroundingV2, NegotiationStickiness) pass 44/44 in isolation.

## Verdict

- **No new failures from the SessionMemory / rollout / telemetry wiring.**
- **Electron smoke 6/6.**
- **The CI-blocking hang is fixed** (suite exits cleanly; the WebSocket hang can no
  longer block CI forever).
- Pre-existing ABI / UI / darwin / STT-drift blockers are documented separately and
  require the Electron runtime (`test:electron`) or a darwin GUI; the full GUI app
  launch (window/audio/IPC) needs a display environment unavailable headless.
