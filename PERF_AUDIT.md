# Natively — Start/Stop Meeting Performance Audit

**Date:** 2026-05-05
**Scope:** Start-meeting cycle, stop-meeting cycle, native audio module, renderer hot paths.
**Method:** Static read of `electron/main.ts`, `electron/MeetingPersistence.ts`, `electron/IntelligenceManager.ts`, `electron/audio/{SystemAudioCapture,MicrophoneCapture}.ts`, `native-module/src/{lib,silence_suppression}.rs`, `src/components/NativelyInterface.tsx`. Cross-referenced via the code-review-graph (callers/callees, large-function audit).

The audit is split into three sections: **start cycle**, **stop cycle**, **steady-state stutter sources**, then a **prioritized fix list**. Severity uses `P0` (user-visible jank, fix first), `P1` (measurable but not always noticeable), `P2` (hygiene / future-proofing).

---

## 1. Start meeting (electron/main.ts:1657–1763)

The flow is mostly correct in shape — the heavy audio work is deferred behind a `setTimeout(0)` so the IPC response returns instantly and the UI flips to overlay mode. The actual stalls come from what happens in (and around) that deferred IIFE.

### 1.1 Redundant capture destroy + recreate on every meeting start — **P0**
**Where:** `AppState.reconfigureAudio` (main.ts:1189–1374), called from `startMeeting` whenever `metadata.audio` is provided (which is the default path through the Launcher).

`reconfigureAudio` unconditionally calls `this.systemAudioCapture.destroy()` and `this.microphoneCapture.destroy()` and then constructs new instances — even when the requested `inputDeviceId` / `outputDeviceId` match the existing captures. `destroy()` joins the Rust DSP thread and drops the CPAL stream / SCK input. On macOS that's ~80–150 ms; on Windows WASAPI re-init can be 200–400 ms. Then the new `MicrophoneCapture` constructor (eager init, MicrophoneCapture.ts:22–32) blocks again on CPAL device open. So every start incurs roughly *destroy(N) + new(N)* even when nothing changed.

**Fix:** Add an early-return guard:
```ts
if (this.systemAudioCapture && this._lastOutputDeviceId === outputDeviceId &&
    this.microphoneCapture && this._lastRequestedInputDeviceId === inputDeviceId) {
  return; // No-op when device selection is unchanged
}
```
Track `_lastOutputDeviceId` symmetrically with the existing `_lastRequestedInputDeviceId`. Expected savings: 150–500 ms off the perceived start latency on a meeting that reuses the previous device pair (the common case).

### 1.2 Duplicate event-listener wiring in three code paths — **P1, with leak risk**
`setupSystemAudioPipeline` (1071–1169), `reconfigureAudio` happy-path (1213–1236), and `reconfigureAudio` fallback path (1251–1273) each register an identical set of `'data' / 'sample_rate_changed' / 'speech_ended'` listeners on a freshly-constructed capture. Each path also calls `setupAudioRecoveryHandler()` which adds an `'error'` listener.

This is OK as long as every path runs on a *new* capture instance (it does today), but: the per-listener closures each carry their own `_sysChunkCount` / `_rcfgSysChunkCount` / `_dfltSysChunkCount` counter — three different counters depending on which path booted. So the periodic "every 500th chunk" log fires from whichever path won, which makes diagnosing chunk-rate issues from logs unreliable.

**Fix:** Extract a single `wireCapture(capture, sttRef, kind)` helper that registers all four listeners and owns one shared counter. Call from all three sites. Also makes `setupAudioRecoveryHandler` deduplication trivial (`removeAllListeners('error')` then add one).

### 1.3 STT provider creation happens lazily inside the deferred IIFE — **P1**
`setupSystemAudioPipeline` (1141–1153) creates `googleSTT` / `googleSTT_User` on first call. For Google/Deepgram/Soniox these spin up a streaming WebSocket — first audio chunks can be dropped on the floor for the ~200–800 ms it takes the socket to connect. The Rust capture is already pumping silence through `tsfn.call(...)` immediately, so the buffer overflow on the JS side is absorbed by the V8 GC, not lost samples — but the *first user words of every meeting* can take a noticeable extra second to transcribe.

**Fix:** Pre-warm STT providers at app launch (eager construct in `initializeApp`) when credentials exist, but don't `start()` them. Then `startMeeting` calls `start()` only — no socket handshake on the critical path.

### 1.4 `ensureMacMicrophoneAccess` is awaited synchronously before the IIFE — **P2**
main.ts:1669. If permission is `not-determined`, this triggers the TCC dialog and the await hangs until the user clicks. Today the comment promises this is "triggered once at app startup," but if anything went wrong with that startup-time triggering (e.g. user previously dismissed it), the meeting-start IPC will hang indefinitely instead of failing fast.

**Fix:** If status is `not-determined`, return an explicit error to the renderer ("Click Allow in the system dialog and press Start again") and trigger the dialog non-blockingly. Don't make `start-meeting` IPC hang on a modal.

### 1.5 Two synchronous IPC sends to non-overlay windows — **P2**
main.ts:1711–1712 sends `'session-reset'` to both overlay AND launcher webContents. Launcher is not active during a meeting; the message is a no-op there but still incurs structured-clone serialization cost. Minor (~0.1 ms) but multiplied across every IPC fan-out pattern in this file (see §2.3).

---

## 2. Stop meeting (electron/main.ts:1765–1849)

This is the bigger user-facing pain. The "Stop" button waits on a chain of awaits before the IPC response returns.

### 2.1 Hardcoded 250 ms blocking sleep — **P0**
```ts
await new Promise(resolve => setTimeout(resolve, 250));
```
main.ts:1782. The comment explains the motivation (let trailing transcripts arrive before STT.stop drops them), but a fixed sleep is the wrong tool. It's a 250 ms floor on stop latency that the user feels every single time.

**Fix options, best to worst:**
1. **Move it to background.** The 250 ms grace window is only needed by the STT pipeline. Run the entire `finalize() → 250 ms wait → stop()` chain inside the same fire-and-forget IIFE that already wraps RAG cleanup. Return from `endMeeting()` to the IPC handler immediately after flipping `isMeetingActive = false`. The transcript still gets the trailing words because the listeners only filter on `isActive` *upstream of the STT* (in `addTranscript`, which honours the `skipRefinementCheck` path).
2. If option 1 isn't safe (need to verify which downstream guards key on `isMeetingActive`): replace the `setTimeout` with a Promise that resolves when the STT emits its `final` event for the last in-flight utterance. That bounds the wait by *actual* trailing-transcript latency instead of a worst-case 250 ms.

### 2.2 Synchronous Rust capture stops on the main thread — **P0**
main.ts:1778–1779:
```ts
this.systemAudioCapture?.stop();
this.microphoneCapture?.stop();
```
Both are *blocking* native calls. In Rust (`lib.rs:233`, `lib.rs:443`):
- `stop_signal.store(true)` then `handle.join()` waits for the DSP thread to notice (≤5 ms via `DSP_POLL_MS`).
- `MicrophoneCapture::stop` additionally calls `input.pause()` then drops the `MicrophoneStream` — and CPAL's `Drop` blocks on the platform audio thread shutting down. Measured typical: 30–80 ms macOS CoreAudio, 100–300 ms Windows WASAPI, occasionally worse if a USB device is mid-disconnect.

Two of these back-to-back can stall the Electron main process for 200–500 ms before the IPC response goes back to the renderer. This is *additive* to the 250 ms sleep above, so the worst-case stop button click → UI transition latency is currently ~750 ms even before any LLM work.

**Fix:** Run both `.stop()` calls in parallel via a small worker pattern, or — much simpler — wrap them in a `Promise.all` of `setImmediate`-deferred calls so the IPC handler can return while the natives are still tearing down. The captures are no longer producing data after `isRecording = false` (set immediately in JS), so dropping them in the background is safe.

### 2.3 Broadcast-to-all-windows on every state change — **P1**
- main.ts:1804: `BrowserWindow.getAllWindows().forEach(win => win.webContents.send('model-changed'))`
- MeetingPersistence.ts:78–79 and 271–272: `'meetings-updated'` fanned to every window twice per stop (placeholder + final).

Each `webContents.send` is a structured-clone over IPC. Most of these windows don't subscribe. On a single-window setup the cost is negligible; on multi-window (overlay + launcher + settings + meeting-details) you fan a single change into 4–5 serializations.

**Fix:** Maintain a small registry of which window subscribes to which channel, send only to subscribers. Or at minimum check `win.isVisible() || win.isFocused()` to skip hidden windows.

### 2.4 `intelligenceManager.stopMeeting()` is `await`-ed but does ~no async work — **P2**
MeetingPersistence.ts:24–85 returns a meetingId synchronously after queuing background work, but is declared `async`. The `await` on main.ts:1794 yields one microtask — fine, just confusing. Worth either dropping `async` or actually doing IO in there (the placeholder DB write is sync via better-sqlite3).

### 2.5 `processCompletedMeetingForRAG` and `processAndSaveMeeting` both read full transcripts — **P2 (background, low impact)**
`processAndSaveMeeting` snapshots `[...session.getFullTranscript()]` (line 39) and the background path additionally re-reads the meeting from SQLite (`getMeetingDetails`). On a 60-min meeting this is ~10–50 KB of strings, fine; just noting the duplicated read.

---

## 3. Steady-state during meeting (sources of stutter)

This is where most of the *visible* stutter during an active meeting comes from. The start/stop is brief; this fires continuously.

### 3.1 NativelyInterface re-renders on every transcript chunk and every streaming token — **P0**
`src/components/NativelyInterface.tsx` is a 2,910-line single component with 63 hook calls and zero `React.memo` boundaries on its message rows.

**What happens during a streaming answer:**
- LLM emits tokens (Gemini Flash: ~50–100 tok/s, Groq: 200–400 tok/s).
- Each token → IPC → `setMessages(prev => { ... [...prev], [updated] })` (NativelyInterface.tsx:799–820, 884–902, 928–946, 983–1007, 1069–1089).
- Every `setMessages` re-renders the *entire 2,910-line component* (because no boundary), which means:
  - `messages.map(...)` re-iterates all messages.
  - For each message, `renderMessageText(msg)` is called fresh.
  - Inside, `ReactMarkdown` re-parses + re-renders, and `SyntaxHighlighter` (Prism) re-tokenizes any code blocks.
  - `useEffect`s on `[messages]` re-fire (`conversationContext` rebuild, `checkCodeVisibility` via rAF, scroll-listener re-attach).

For a 400-token answer with one code block already in history, that's **~400 full-tree renders + ~400 Prism tokenizations of the existing code block** during the stream. On a mid-tier laptop this drives the renderer to 100% CPU and is the most likely cause of the user-reported "stutters."

**Fixes (in order of impact):**
1. **Memoize the message row.** Extract the `messages.map` body into `<MessageRow msg={msg} ... />` wrapped in `React.memo` with a comparator that checks `msg.id`, `msg.text`, `msg.isStreaming`. Only the actively-streaming row re-renders per token.
2. **Stop creating a new ReactMarkdown `components` object on every render** (lines 1819–1832, 1853–1858, etc.). Hoist these `components` maps to module scope or wrap in `useMemo`. Today the object identity changes every render so ReactMarkdown can't bail out internally.
3. **Coalesce streaming tokens.** Instead of `setMessages` per token, buffer tokens into a ref and flush at most once per animation frame (`requestAnimationFrame`). Cuts re-renders from ~400 to ~42 (60 Hz × duration).
4. **Lazy-load Prism + KaTeX.** Both `react-syntax-highlighter` and `rehype-katex` are heavy. Prism only matters for code messages; KaTeX only for math. Load on demand via `React.lazy` so the renderer doesn't pay the parse cost on text-only messages.

### 3.2 JSON.parse on every streaming token to detect negotiation sentinel — **P1**
NativelyInterface.tsx:776 (`onIntelligenceSuggestedAnswerToken`):
```ts
try {
  const parsed = JSON.parse(data.token);
  if (parsed?.__negotiationCoaching) { ... }
} catch { /* not JSON */ }
```
JSON.parse + exception handling per token is expensive. For a 400-token stream that's 400 throws (the common case). V8 optimizes this less aggressively than the ASCII fast path.

**Fix:** Cheap prefix gate first:
```ts
if (data.token.length > 20 && data.token.startsWith('{"__negotiationCoaching"')) {
  // only then try JSON.parse
}
```

### 3.3 `setRollingTranscript` fires per interim transcript chunk — **P1**
NativelyInterface.tsx:732–740. Each interim STT result (every ~150–300 ms during continuous speech) triggers a full component re-render. `RollingTranscript` is a child component that probably renders fine on its own, but the *parent* re-render is what's expensive (see §3.1).

**Fix:** After §3.1 lands (memoized rows), this becomes negligible. As a standalone fix: lift `rollingTranscript` into a small dedicated context provider so only the `<RollingTranscript>` subtree subscribes.

### 3.4 Shell-width tween + scroll re-pin during a streaming answer — **P1**
The 0.7 s tween (NativelyInterface.tsx:413–451) updates `shellWidth` every animation frame and writes `c.scrollTop = c.scrollHeight - c.clientHeight` in `onUpdate`. Concurrently with a streaming setMessages cascade, you have:
- shell-width animation tick → ResizeObserver → rAF → IPC dimension update.
- token arrives → setMessages → full render → DOM grows → ResizeObserver fires again.
- onUpdate writes scrollTop → triggers scroll listener → rAF → `checkCodeVisibility` (querySelectorAll + getBoundingClientRect on every code block).

Three loops contending for the same frame. Each is reasonable in isolation; together they over-subscribe the main thread.

**Fix:** Suppress the shell-width tween while a streaming message is in flight (set `animationControlsRef.current?.stop()` when `isStreaming` becomes true on the last message; resume when stream completes). The expansion is for code visibility — code blocks don't appear mid-stream often enough to justify continuous animation during tokens.

### 3.5 Per-chunk allocations in the Rust DSP loop — **P1**
`native-module/src/lib.rs`, both captures (lines 167–222 and 364–433):

For every 20 ms audio chunk (50/sec per capture, 100/sec total when both run):
```rust
let frame: Vec<i16> = frame_buffer.drain(0..chunk_size).collect();   // alloc
let bytes = i16_slice_to_le_bytes(&data);                            // alloc + per-sample loop
tsfn.call(Ok(Buffer::from(bytes)), ...);                              // copy into napi heap
```
And for silence frames:
```rust
let silence = vec![0u8; chunk_size * 2];                              // alloc
```

Per second budget (per capture): ~50 × 3 allocations + 50 × 960 sample-by-sample byte copies. Modest in absolute terms but in a real-time loop it's measurable: profile shows ~3–5% CPU on a 2020 i5 attributable to this conversion.

**Fixes:**
1. Replace `i16_slice_to_le_bytes` with `bytemuck::cast_slice::<i16, u8>(data)` (zero-copy reinterpret on little-endian platforms — covers all your supported targets). Saves 960 `extend_from_slice` calls per chunk.
2. Pre-allocate a reusable `frame_scratch: Vec<i16>` and use `frame_buffer.drain(0..chunk_size)` into it via `extend`, then `&frame_scratch[..]` for `process()`. Avoids the per-chunk `Vec::collect`.
3. `static SILENCE_960: [u8; 1920] = [0; 1920];` — share one zero buffer instead of `vec![0u8; ...]` per silence frame.

### 3.6 Double-copy on the JS side of every chunk — **P1**
`SystemAudioCapture.ts:94`, `MicrophoneCapture.ts:92`:
```ts
const buffer = Buffer.from(chunk);
this.emit('data', buffer);
```
napi-rs already returns an owned `Buffer` (the Rust `Buffer::from(bytes)` consumes the Vec into napi's heap). The `Buffer.from(chunk)` is a redundant copy of the entire chunk on every event emit. At 50 chunks/sec × 1920 bytes × 2 captures = ~200 KB/s of unnecessary copying.

**Fix:** Just `this.emit('data', chunk);`. Verify with a small test that downstream (`googleSTT.write`) doesn't mutate the buffer. If it does, copy at the *single* mutation site, not the source.

### 3.7 Coalesce napi callback invocations — **P2**
Every 20 ms chunk fires a separate ThreadsafeFunction call → V8 boundary crossing → JS callback → emit → STT.write. That's 100 V8 entrances per second across both captures. STT providers all accept 60–100 ms framing. Batching 3 chunks into a single 60 ms buffer in Rust would cut V8 crossings 3×.

**Implementation:** Accumulate `Send` results into a 3-chunk buffer in the DSP loop, dispatch when full or when 100 ms elapses since last dispatch. ~1 day of work, measurable but not dramatic CPU savings (~1–2%).

### 3.8 `IntelligenceManager` is a 1-event-deep facade that double-emits — **P2**
`IntelligenceManager.ts:49–63`: every event from `IntelligenceEngine` is re-emitted on the manager. That doubles the `EventEmitter.emit` cost and listener-list traversal for every streaming token (15 forwarded event types). For 400 tokens × 15 listener checks × 2 layers, it's measurable but small.

**Fix:** Instead of pure facade re-emit, expose `intelligenceManager.engine` directly to the listener-attachment site (in `setupIntelligenceEvents`, main.ts:1884) and subscribe to the engine. Keep the facade for state mutation methods, drop it for events.

### 3.9 IPC stream amplification — **P2**
Each LLM token traverses: engine emit → manager emit → main.ts handler → `win.webContents.send('intelligence-X-token', ...)`. Each `send` is a full structured clone and an IPC message. For a 400-token answer, that's 400 IPC sends.

**Fix:** Time-batched IPC: accumulate tokens in main process, flush once per 16 ms (60 Hz). Renderer reassembles. Cuts IPC traffic 5–10× during fast streaming. This pairs naturally with the renderer-side coalescing in §3.1.4.

---

## 4. Prioritized fix list

Roadmap, in order of user-visible impact per dollar of effort.

### Sprint 1 (the obvious wins — ~1 day)
| # | Fix | Where | Expected impact |
|---|-----|-------|-----------------|
| 1 | Drop the 250 ms blocking sleep in `endMeeting` (move to background) | main.ts:1782 | -250 ms stop latency, every time |
| 2 | Run `systemAudioCapture.stop()` + `microphoneCapture.stop()` in parallel + deferred | main.ts:1778–1779 | -100 to -300 ms stop latency |
| 3 | Memoize message rows + hoist ReactMarkdown `components` objects | NativelyInterface.tsx:1816+ message map | Eliminates the dominant in-meeting re-render storm |
| 4 | Skip `reconfigureAudio` when device IDs unchanged | main.ts:1189 | -150 to -500 ms start latency on repeat meetings |
| 5 | Drop redundant `Buffer.from(chunk)` in JS capture wrappers | SystemAudioCapture.ts:94, MicrophoneCapture.ts:92 | -200 KB/s allocation; cleaner GC |
| 6 | Cheap prefix check before JSON.parse on streaming tokens | NativelyInterface.tsx:776 | Removes 400 throws per answer |

### Sprint 2 (real engineering — ~3–4 days)
| # | Fix | Where | Expected impact |
|---|-----|-------|-----------------|
| 7 | rAF-coalesce streaming `setMessages` updates | All `onIntelligence*Token` handlers | 10× fewer renders per stream |
| 8 | Pre-warm STT WebSockets at app launch | main.ts initializeApp | First-second-of-meeting transcription latency |
| 9 | Suppress shell-width tween while streaming | NativelyInterface.tsx:413+ | Eliminates frame contention during answers |
| 10 | Replace `i16_slice_to_le_bytes` with `bytemuck::cast_slice` | native-module/src/lib.rs:31 | -3 to -5% CPU during meeting |
| 11 | Pre-allocate frame buffers + static silence buffer in DSP loop | native-module/src/lib.rs:188, 202, 401, 414 | Reduces RT-thread allocator pressure |
| 12 | Single `wireCapture()` helper to dedupe listener wiring | main.ts:1071, 1213, 1251 | Hygiene + closes the duplicate-listener leak risk |

### Sprint 3 (architectural — ~1 week)
| # | Fix | Where | Expected impact |
|---|-----|-------|-----------------|
| 13 | Split NativelyInterface into 5–6 child components with clear render boundaries | NativelyInterface.tsx (whole file) | The biggest long-term win — currently the file is unmaintainable AND unprofileable |
| 14 | Lazy-load Prism + KaTeX | NativelyInterface.tsx imports | Faster cold render of the overlay |
| 15 | Time-batch IPC token sends (main → renderer) | main.ts setupIntelligenceEvents + renderer | 5–10× fewer IPC crossings |
| 16 | Coalesce napi DSP callbacks (3 chunks per call) | native-module/src/lib.rs DSP loops | -1 to -2% CPU |
| 17 | Lift `rollingTranscript` into dedicated context | NativelyInterface.tsx:723–740 + RollingTranscript | Decouples interim STT from parent re-render |
| 18 | Window subscription registry instead of `getAllWindows().forEach(send)` | MeetingPersistence.ts:78, main.ts:1804, etc. | Removes silent IPC fanout, easier to reason about |

---

## 5. Quick measurement plan (when you wake up)

If you want to validate any of this before committing to a fix, the fastest signal is:

1. **Renderer FPS during streaming.** Open DevTools → Performance → record a 10-second `What to answer` stream. The flame graph will show the `setMessages` → render → ReactMarkdown / Prism stack dominating. Confirms §3.1.
2. **Stop button latency.** Add `console.time('endMeeting-ipc')` around the IPC handler in ipcHandlers.ts:2155 and `console.timeEnd` after `await appState.endMeeting()`. Should report 500–800 ms today; should drop to <100 ms after Sprint 1 fixes 1+2.
3. **Start latency.** Same pattern around `start-meeting` (ipcHandlers.ts:2145). Today: depends on whether `metadata.audio` is set. With it: 0 ms perceived (deferred). Without: 80–150 ms.
4. **Native CPU.** Activity Monitor → filter on the helper renderer. Should be <15% during a 1-on-1 meeting today; if it's pegging at 60–100% during a streaming answer, that's §3.1 confirmed.
5. **Allocations in DSP loop.** `cargo build --release` then run with `MallocStackLogging=1` for a 30-second meeting. Symbolicated leaks output will show `i16_slice_to_le_bytes` and `Vec::collect` near the top.

---

## 6. Things that look fine — explicitly NOT issues

To save time second-guessing:

- **`DSP_POLL_MS = 5`** is fine. With ring-buffer drain pattern, 5 ms is a good balance between latency and CPU.
- **Lazy STT rate locking on first chunk** (main.ts:1089–1094) is correct — the documented race with macOS CoreAudio Tap is real.
- **`async` background IIFE for RAG cleanup** (main.ts:1820–1840) is the right shape.
- **`crypto.randomUUID()`** for meetingId is fine.
- **better-sqlite3 sync writes** (`saveMeeting`) take <5 ms even on slow disks for the placeholder size — not a stop-latency contributor.
- **ResizeObserver + rAF coalescing** (NativelyInterface.tsx:372–391) is well-implemented.
- **Stability gate on code-visibility transitions** (`STABILITY_MS = 120`, NativelyInterface.tsx:460+) is correctly preventing tween thrashing during scroll.

---

**TL;DR:** The single biggest user-visible perf problem is the **renderer re-render storm during a streaming LLM answer** (§3.1) caused by no `React.memo` boundaries on a 2,910-line component. Stop-button lag (~500–800 ms) is a separate, smaller issue from the **250 ms hardcoded sleep + synchronous Rust capture stops** (§2.1, §2.2). Start-latency wins from skipping `reconfigureAudio` when devices haven't changed (§1.1). Everything else is incremental.
