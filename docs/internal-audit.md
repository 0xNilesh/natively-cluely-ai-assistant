# Natively — Internal Architecture & Performance Audit

**Date:** 2026-05-11
**Scope:** Audio capture, STT, LLM pipeline, trigger logic, RAG, stealth, vision, state/persistence.
**Method:** Static read of repo (236 files, 2353 graph nodes, last graph build 2026-05-11). Every claim references `file:line`.
**Companion:** [`PERF_AUDIT.md`](../PERF_AUDIT.md) covers start/stop cycle and renderer hot-paths. This doc covers everything else.

---

## 0. Repo orientation

| Subsystem | Location | Lines (approx) |
|---|---|---|
| Audio capture (Rust native) | `native-module/src/{lib,microphone,vad,silence_suppression,resampler,audio_config,stealth_window,keyboard_tap}.rs` | ~3.5 kLoC Rust |
| Audio capture (TS wrappers) | `electron/audio/{SystemAudioCapture,MicrophoneCapture,nativeModuleLoader}.ts` | ~600 |
| STT providers | `electron/audio/{Deepgram,ElevenLabs,Google,NativelyPro,OpenAI,Rest,Soniox}*STT.ts` | ~3.3 kLoC |
| LLM orchestrator | `electron/LLMHelper.ts` (+ `electron/llm/*`) | ~3.5 + 4.4 kLoC |
| Prompts | `electron/llm/prompts.ts` (2,175), `tinyPrompts.ts` (170) | ~2.3 kLoC |
| Intent / trigger | `electron/llm/IntentClassifier.ts`, `electron/IntelligenceEngine.ts`, `electron/IntelligenceManager.ts` | ~1.5 kLoC |
| RAG | `electron/rag/*` (`RAGManager`, `RAGRetriever`, `VectorStore`, `EmbeddingPipeline`, `SemanticChunker`, `LiveRAGIndexer`, `vectorSearchWorker`, providers/) | ~3 kLoC |
| Persistence | `electron/db/DatabaseManager.ts` (v14 schema, 1,471 lines), `electron/MeetingPersistence.ts`, `electron/SessionTracker.ts` | ~2.4 kLoC |
| Stealth runtime | `electron/main.ts:3480-3636` (`_applyDisguise`), `electron/WindowHelper.ts`, `native-module/src/{stealth_window,keyboard_tap}.rs` | crosscut |
| IPC surface | `electron/ipcHandlers.ts` (3,484 lines), `electron/preload.ts` (1,335 lines) | ~4.8 kLoC |
| Renderer | `src/components/NativelyInterface.tsx` (2,910 lines — monolith, see PERF_AUDIT §3.1) | — |

---

## 1. Audio capture pipeline

### 1.1 Rust native module (`native-module/src/lib.rs`)

Two `#[napi]` classes: `SystemAudioCapture` (lib.rs:115–321) and `MicrophoneCapture` (lib.rs:337–541), plus device enumeration (`get_input_devices`, `get_output_devices`, `get_default_output_device_id` — lib.rs:553–593).

- **Output framing:** mono `i16` LE; 20 ms chunks at native rate (= 960 samples @ 48 kHz). `chunk_size = (native_rate / 1000) * 20` (lib.rs:235, 440).
- **Ring buffer:** 32,768 `f32` samples (`RING_BUFFER_SAMPLES`, `audio_config.rs:39`) — ~680 ms at 48 kHz.
- **DSP poll:** 5 ms thread sleep (`DSP_POLL_MS`, `audio_config.rs:34`).
- **Coalescing into JS:** `BatchEmitter` (lib.rs:62–109) bundles up to 3 frames per `tsfn.call`. Flushes on capacity, 100 ms timeout (`CHUNK_BATCH_TIMEOUT_MS`), `speech_ended`, or DSP exit. This is the post-Sprint-3 coalescing fix.
- **Byte conversion:** `bytemuck::cast_slice<i16, u8>` zero-copy view + single `to_vec` (lib.rs:45–48). This is the post-Sprint-2 fix that removed the per-sample LE loop.
- **Sample rate signalling:** `Arc<AtomicU32>` (lib.rs:121–122, 342–343). System cap defaults to 48000 until ScreenCaptureKit reports back ~5–7 s later (lib.rs:136). Mic uses CPAL native rate eagerly at construct (line 360).
- **Mic restart:** CPAL stream is torn down on every `stop()` (lib.rs:530–540) and recreated in `start()` — the "one-shot `take_consumer()`" pattern.

### 1.2 macOS vs Windows system audio

- **macOS:** ScreenCaptureKit / CoreAudio Tap via `crate::speaker::SpeakerInput` (lib.rs:169). Init runs on a background thread (5–7 s) so `start()` returns instantly (lib.rs:165–227). Sample rate = whatever SCK reports (typically 48 kHz).
- **Windows:** WASAPI loopback (same `crate::speaker::SpeakerInput` abstraction, platform code under `native-module/src/speaker/`). Teardown is the 100–300 ms blocking path that motivated the deferred-stop pattern in `SystemAudioCapture.ts:151–186`.
- **Default-output watcher:** `get_default_output_device_id()` (lib.rs:590–593) used by main.ts:2098–2169 to detect output route changes and recreate only `SystemAudioCapture` (cheaper than full reconfigure).

### 1.3 VAD / silence-suppression

Two independent VAD systems in Rust:

- **`vad.rs` — UI-only "speaking" indicator.** States Idle→Speech→Hangover→Idle. Thresholds `VAD_START_RMS=185`, `VAD_END_RMS=100`, `VAD_HANGOVER_MS=500` (`audio_config.rs:22–29`). Does **not** gate STT audio. Header comment makes this explicit (`vad.rs:1–10`).
- **`silence_suppression.rs` — actual STT gate.** Two stages: adaptive RMS + WebRTC VAD (`webrtc_vad` crate, mode `Quality` at 16 kHz). Both must pass for `FrameAction::Send`. Per-stream configs:
  - `for_microphone()` (silence_suppression.rs:92–104): RMS=100, hangover=500 ms, `use_vad=true`. Hangover bumped 150→500 ms (issue #?) to preserve trailing consonants.
  - `for_system_audio()` (silence_suppression.rs:75–87): RMS=30, hangover=600 ms, `use_vad=false`. WebRTC VAD disabled for system audio per issue #127 (over-suppressed non-speech like games/YouTube).
- **Adaptive threshold:** EMA over noise floor, `adaptive_multiplier=3.0`, `ema_alpha=0.02` (silence_suppression.rs:60–63, 258–263). Only updated during confirmed silence.
- **`speech_ended` edge:** Fires once when hangover expires post-speech (silence_suppression.rs:234–244). Drives `RestSTT.notifySpeechEnded()` flush.

### 1.4 JS wrappers

- **`MicrophoneCapture.ts:22–32`** — eager Rust init in constructor so device errors surface synchronously (allows fallback to default device).
- **`MicrophoneCapture.ts:79`** — napi-rs ThreadsafeFunction `(err, chunk: Buffer)`. Post-stop guard at line 91 drops late chunks. **No `Buffer.from` copy** — the napi-owned buffer is passed through (lines 95–98). This is the post-Sprint-1 fix.
- **`MicrophoneCapture.ts:129–143`** — `stop()` sets `isRecording=false` synchronously and defers blocking `monitor.stop()` to `setImmediate` so IPC isn't blocked by 30–80 ms (macOS) / 100–300 ms (Windows) CPAL teardown.
- **`SystemAudioCapture.ts:62–73`** — lazy init in `start()` (avoids 1 s mute at app launch).
- **`SystemAudioCapture.ts:119–137`** — polls `monitor.getSampleRate()` at +1 s and +8 s post-start because SCK publishes real rate ~5–7 s in. Emits `'sample_rate_changed'` (line 128) — trigger for STT providers' mid-stream `setSampleRate()`.
- **Recovery pattern:** `destroy + new` (not `stop + start`) because Rust DSP thread lifecycle is per-instance. Sites: `setupAudioRecoveryHandler` (main.ts:2042–2064), sleep/wake (main.ts:1635, 1662), output-device-change (main.ts:2098–2169), mic CPAL-callback error (main.ts:2232–2235).

---

## 2. STT layer — provider-by-provider matrix

All providers live in `electron/audio/`. The matrix below summarises per-provider behaviour. Full per-provider detail follows.

| Provider | File | Transport | Rate / encoding | Interim | Server VAD | Reconnect cap | Multi-key pool | Pre-warm |
|---|---|---|---|---|---|---|---|---|
| Deepgram | `DeepgramStreamingSTT.ts` | SDK WS (nova-3) | 16k linear16 | yes | yes (endpointing 300) | **10 attempts** | no | yes |
| ElevenLabs | `ElevenLabsStreamingSTT.ts` | WS (scribe_v2_realtime) | 16k pcm16 b64 | yes | yes | **NONE** | no | yes |
| Google | `GoogleSTT.ts` | gRPC bidi | 16k LINEAR16 | yes | yes | none (proactive 270 s restart) | n/a (creds JSON) | partial |
| NativelyPro | `NativelyProSTT.ts` | WS (server proxy) | 16k linear16 | yes | yes (server) | **NONE** (indef) | server-side; client staggers same-key | yes |
| OpenAI WS | `OpenAIStreamingSTT.ts` | Realtime WS (gpt-4o-transcribe) | **24k** pcm16 b64 | yes | yes (server_vad) | per-model 3 → REST fallback | no | yes |
| OpenAI REST | `OpenAIStreamingSTT.ts` | Whisper-1 multipart | 16k WAV | no | Rust VAD flush | n/a | no | trivial |
| RestSTT (Groq/OpenAI/EL/Azure/IBM) | `RestSTT.ts` | REST multipart/binary | 16k WAV | no | Rust VAD flush | n/a | no | trivial |
| Soniox | `SonioxStreamingSTT.ts` | WS (stt-rt-v4) | 16k pcm_s16le | yes (tokens) | yes (endpoint detection) | **NONE** | no | yes |

### 2.1 Deepgram (`DeepgramStreamingSTT.ts`)
- `@deepgram/sdk` `listen.live`, model `nova-3` (line 148). `encoding:'linear16'`, sample rate from capture, `interim_results:true`, `endpointing:300`, `utterance_end_ms:1000`, `vad_events:true` (lines 151–157).
- Reconnect: 1 s → 30 s, **cap 10 attempts** (lines 13–15). 5 s stable connection resets attempts (line 200). Buffered audio **discarded** on reconnect (line 236).
- Keep-alive 8 s (`KEEPALIVE_INTERVAL_MS=8000`, lines 16, 193–197).
- Error close ≠ 1000 → `scheduleReconnect` (lines 219–222). Auth/quota errors via SDK `Error` (lines 205–208).
- `notifySpeechEnded()` not wired — Deepgram does its own server VAD.

### 2.2 ElevenLabs (`ElevenLabsStreamingSTT.ts`)
- `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model=scribe_v2_realtime`, auth `xi-api-key` header (lines 9, 227, 239–241).
- Sends `{message_type:'input_audio_chunk', audio_base_64}` JSON at 250 ms chunks (4000 samples @ 16 k, line 31). Naïve decimation downsample (line 177).
- **Reconnect: 1 s → 30 s, NO cap** (lines 352–365). Auth errors stop reconnect (line 312). Buffer cap 500 chunks (lines 144–147).
- Partial = `partial_transcript`, final = `committed_transcript` (lines 288–306).
- Dev-only debug raw file at `~/elevenlabs_debug.raw` (lines 40–48). **Should not ship to packaged builds.**

### 2.3 Google (`GoogleSTT.ts`)
- `@google-cloud/speech` `streamingRecognize` (line 277). `LINEAR16`, default 16 k, `model:'latest_long'`, `useEnhanced:true`, `interimResults:true`, up to 3 `alternativeLanguageCodes` (lines 284–289).
- **No fixed backoff** — `write()` lazy reconnect throttled ≥ 1000 ms between attempts (lines 209, 225).
- **Proactive restart every 270 s** (`PROACTIVE_RESTART_MS`, lines 192, 374–386) — pre-empts Google's 305 s hard limit.
- gRPC code 11 "Audio Timeout Error" is treated benign (warn-not-emit, lines 307–312).
- gRPC codes 3/7/16 (INVALID_ARGUMENT/PERMISSION_DENIED/UNAUTHENTICATED) → `isFatalError=true`, stops retry forever (lines 28, 316–330; issue #171).
- `notifySpeechEnded()` is deliberate no-op (lines 80–82). Single service-account JSON, no key rotation.

### 2.4 NativelyPro (`NativelyProSTT.ts`)
- `wss://api.natively.software/v1/transcribe` (line 65) — Natively's own proxy.
- First message JSON `{key, sample_rate, language, language_alternates, audio_channels, channel}` (lines 303–320). `channel` disambiguates `system` vs `mic` (constructor arg).
- Trial mode swaps `key` for `trial_token` (lines 310–318).
- Reconnect: capped exp 1.5 s → 30 s, ±20 % jitter, **indefinite while `isActive`**. Warning emit at 5 attempts (lines 49, 54, 58, 459, 468).
- DNS failure (ENOTFOUND/EAI_AGAIN) → fixed 10 s retry (lines 59–60, 441–449).
- **Static stagger map `nextSlotByKey`** delays concurrent same-key opens by `SLOT_INTERVAL_MS=3000` (lines 69–70, 250–268). The ONLY client-side key-coordination logic in the STT layer.
- Server `language_detected` → reconnect with detected BCP-47 (lines 372–385).
- Fatal errors: `auth_timeout`, `invalid_key_format`, `transcription_quota_exceeded` stop forever (lines 335–339). Buffer-overflow event at 500 chunks.

### 2.5 OpenAI (`OpenAIStreamingSTT.ts` — 859 lines, the most complex)
- **Tier 1 WS:** `wss://api.openai.com/v1/realtime?intent=transcription`, tries `gpt-4o-transcribe` then `gpt-4o-mini-transcribe` (`WS_MODELS`, lines 39–40). **24 kHz pcm16 b64** (line 69). Sends every 250 ms (6000 samples, line 63). Server VAD `{type:'server_vad', threshold:0.5, prefix_padding_ms:300, silence_duration_ms:500}` (lines 384–389). `noise_reduction:'near_field'` (lines 391–393).
- **Tier 2 REST fallback:** `https://api.openai.com/v1/audio/transcriptions`, `whisper-1`, 16 k WAV (lines 26, 752–771). Flushes at 4000 bytes or every 10 s safety-net (lines 60, 57). Always `isFinal:true`. Uses Rust VAD via `notifySpeechEnded()` for immediate flush (lines 268–275). Silence skip RMS < 50 (line 65).
- Per-model `MAX_WS_FAILURES_PER_MODEL=3` (line 43) advances model, then falls through to REST (lines 438–456). 10 s connection timeout, 5 s session-setup timeout.
- Keep-alive: 8-byte silent PCM frame every 20 s (lines 50, 600–615).
- Custom `baseUrl` → REST-only path (lines 131–141).

### 2.6 RestSTT (`RestSTT.ts`, 499 lines — 5 providers in one file)
Endpoints (lines 25, 344–399):
- **Groq:** `https://api.groq.com/openai/v1/audio/transcriptions`, model `whisper-large-v3-turbo`.
- **OpenAI:** `https://api.openai.com/v1/audio/transcriptions`, model `whisper-1`.
- **ElevenLabs:** `https://api.elevenlabs.io/v1/speech-to-text`, model `scribe_v2`, form field `model_id`.
- **Azure:** `https://${region}.stt.speech.microsoft.com/...`, header `Ocp-Apim-Subscription-Key`.
- **IBM Watson:** `https://api.${region}.speech-to-text.watson.cloud.ibm.com/...`, basic auth.
All resample to 16 k mono, WAV-wrapped. `MIN_BUFFER_BYTES=4000`, safety-net 10 s, RMS-silence skip <50 (lines 119, 124, 127). 30 s HTTP timeout.

### 2.7 Soniox (`SonioxStreamingSTT.ts`)
- `wss://stt-rt.soniox.com/transcribe-websocket`. Config JSON with `api_key` in payload (lines 24, 208–225). Model `stt-rt-v4`. `enable_endpoint_detection:true`, `enable_language_identification:true`.
- Token-level partial/final; markers `<fin>` (manual finalize ack), `<end>` (endpoint detected). `finalize()` sends `{type:'finalize'}` (lines 164–175).
- **Reconnect: 1 s → 30 s, NO cap.** Keep-alive 5 s (lines 25–27, 367–377).

### 2.8 Cross-provider observations
- **Three providers have unbounded reconnect loops** (ElevenLabs, Soniox, NativelyPro). Storm risk during network flakiness.
- **No usage/billing tracker is called from the audio layer.** All metering lives upstream (server-side for NativelyPro; absent for direct-BYOK paths).
- **Only NativelyPro coordinates concurrent key use** (static `nextSlotByKey`). For Deepgram/Soniox/ElevenLabs/OpenAI a user with multiple keys gets no automatic rotation on rate-limit.
- **Two providers can pre-warm WS sockets** (Deepgram, NativelyPro, Soniox, ElevenLabs, OpenAI all expose `start()` without `write()` — but in practice `setupSystemAudioPipeline` constructs them lazily inside the start-meeting IIFE; see PERF_AUDIT §1.3).

---

## 3. LLM request pipeline (`electron/LLMHelper.ts` + `electron/llm/*`)

### 3.1 Provider methods

Defaults: `LLMHelper.ts:41–46` — `GEMINI_FLASH_MODEL="gemini-3.1-flash-lite-preview"`, `GEMINI_PRO_MODEL="gemini-3.1-pro-preview"`, `GROQ_MODEL="llama-3.3-70b-versatile"`, `OPENAI_MODEL="gpt-5.4"`, `CLAUDE_MODEL="claude-sonnet-4-6"`, `MAX_OUTPUT_TOKENS=65536`, `CLAUDE_MAX_OUTPUT_TOKENS=64000`.

| Method | File:line | Auth / transport | Notes |
|---|---|---|---|
| `streamWithNatively` | `LLMHelper.ts:2787` | `POST api.natively.software/v1/chat` SSE, `x-natively-key`/`x-trial-token` | 10 s connect AbortController |
| `streamWithGroq` | `:2925` | `groq-sdk` | temp 0.4, `max_tokens:8192` |
| `streamWithGroqMultimodal` | `:2954` | `groq-sdk` | hard-coded `llama-4-scout-17b-16e-instruct` |
| `streamWithOpenai` | `:2999` | OpenAI SDK | `max_completion_tokens` model-dependent |
| `streamWithOpenaiMultimodal` | `:3053` | OpenAI SDK | `image_url` data URI |
| `streamWithClaude` | `:3029` | Anthropic SDK `messages.stream` | `cache_control` on system block 0 (see §3.3) |
| `streamWithClaudeMultimodal` | `:3091` | Anthropic SDK | base64 PNG `{type:"image",source:...}` |
| `streamWithGeminiModel` | `:3152` | `@google/genai` `generateContentStream` | `systemInstruction` channel used; `cachedContent` API **NOT** wired (TODO :3146–3151) |
| `streamWithGeminiParallelRace` | `:3204` | races Flash vs Pro | shared `AbortController` (post-Sprint-3 fix that prevented loser-compute waste) |
| `streamWithOllama` | `:3300` | `${ollamaUrl}/api/chat` NDJSON | only path with **explicit token budget** (`maxContextTokens - system - 2000`, :3303–3314) |
| `streamWithCodexCli` | `:345` | spawned CLI | — |
| `streamWithCustom` | `:3398` | `curl2Json` user template | 30 s AbortController |

### 3.2 System prompt assembly (`prompts.ts` 2175 lines)

- **Static cores:** `CORE_IDENTITY` (`prompts.ts:9–44`), `EXECUTION_CONTRACT` (`:87–103`), `CONTEXT_INTELLIGENCE_LAYER` (`:49`), `SHARED_CODING_RULES` (`:61`).
- **Per-provider variants** concatenate `${CORE_IDENTITY}\n${EXECUTION_CONTRACT}` at the top: `OPENAI_SYSTEM_PROMPT` (`:812`), `CLAUDE_SYSTEM_PROMPT` (`:898`), `GROQ_SYSTEM_PROMPT` (`:376`), `UNIVERSAL_SYSTEM_PROMPT` (`:2047`), `CUSTOM_SYSTEM_PROMPT` (`:1893`).
- **Seven modes** (`MODE_*_PROMPT` constants):
  - `MODE_GENERAL_PROMPT` (`:1010`)
  - `MODE_LOOKING_FOR_WORK_PROMPT` (`:1118`)
  - `MODE_SALES_PROMPT` (`:1263`)
  - `MODE_RECRUITING_PROMPT` (`:1362`)
  - `MODE_TEAM_MEET_PROMPT` (`:1455`)
  - `MODE_LECTURE_PROMPT` (`:1546`)
  - `MODE_TECHNICAL_INTERVIEW_PROMPT` (`:1638`)
  Registered in `ModesManager.ts:114–121`. Each mode prompt starts with the **identical** `${CORE_IDENTITY}\n${EXECUTION_CONTRACT}` prefix (e.g. `prompts.ts:1010–1011`, `:1118–1119`, etc.).
- **Parallel TINY prompt family** in `tinyPrompts.ts` for Ollama/tiny-model tier (`selectPromptTier`).
- **Mode injection** is suffix: `LLMHelper.ts:2547–2574` appends `\n\n## ACTIVE MODE\n${ModesManager.getActiveModeSystemPromptSuffix()}` below the static base. `modeContextBlock` prepended to user-side context, 60 000-char cap (`:2561–2569`).
- **Language injection** is suffix (`buildLanguageInstructionSuffix`, `:1003–1023`; `injectLanguageInstruction`, `:1035–1037`). Sites: `:2582, :2615, :2679, :2691, :2705, :2711`. This is the post-prompt-caching refactor — was previously prepended (cache-killing).

**Token-waste observation:** because each mode prompt begins with its own `${CORE_IDENTITY}\n${EXECUTION_CONTRACT}` AND the mode suffix is appended **below** `HARD_SYSTEM_PROMPT` (which also starts with that prefix), the cloud-bound system message embeds CORE_IDENTITY+EXECUTION_CONTRACT **twice**. Static prefix sizes per prior memory observation: 1700–3700 tokens — so the duplicate may cost ~2k tokens per request.

### 3.3 Prompt caching state per provider

- **Claude:** `cache_control:{type:'ephemeral'}` is set on system block 0 in `buildClaudeSystemBlocks` (`LLMHelper.ts:1058–1072`). Block 0 = static prompt (cached). Block 1 = language suffix (uncached). Both `streamWithClaude` (`:3039`) and `streamWithClaudeMultimodal` (`:3116`) pass the two-element array via `messages.stream({ system })`. Comment at `:1040–1057` documents intent. **Working.** Ref: <https://docs.claude.com/en/docs/build-with-claude/prompt-caching>.
- **OpenAI:** messages built `[{role:'system',content:systemPrompt},{role:'user',content:userContent}]` (`:3005–3009, :3059–3071`). System content is byte-identical across requests (language is suffix, user content is in user message). **Automatic prefix caching should fire** — but `prompt_cache_key` / `user` field is NOT set, which means cache routing relies on hash matching across server pools (less reliable). Ref: <https://platform.openai.com/docs/guides/prompt-caching>.
- **Gemini:** in `streamWithGeminiModel` when `systemInstruction` is supplied, it's passed via `config.systemInstruction:{parts:[{text}]}` (`:3170–3179`). Implicit caching applies. **Explicit `cachedContent` API NOT wired** — TODO at `:3146–3151`. Legacy single-string callers still concat system into `fullMessage` (cache-defeating). Ref: <https://ai.google.dev/gemini-api/docs/caching>.
- **Groq:** real `system` role first, then `user` (`:2929–2933, :2957–2970`). Comment at `:2930` labels it `"CACHE-CACHEABLE PREFIX: must be byte-identical across turns"`. Streaming dispatch passes `groqSystem` separately (`:2615, :2705, :2711`).
- **Natively API:** `system` top-level body field + `messages:[{role:'user',content}]` (`:2800–2805`). Server-side caching opaque to client.

Cache-boundary markers in code: `:1805, :3038, :3115, :3176, :3278`. CACHE annotations: `:2321, :2323, :2365, :2372, :2397, :2619, :2712`.

### 3.4 Transcript window / token budget

- Window is **time-based, not token-based.** `SessionTracker.getContext(lastSeconds=120)` filters by `Date.now() - windowSeconds*1000` (`SessionTracker.ts:341–344`).
- Per-mode hard-coded windows in `IntelligenceEngine.ts`:
  - assist 60 s (`:203`)
  - follow-up 60 s (`:387`)
  - recap 120 s (`:459`)
  - follow-up-questions 120 s (`:589`)
  - manual answer 120 s (`:652`)
  - clarify / code-hint / brainstorm 180 s (`:525, :708, :772`)
  - what-to-say uses `getContext(180)` (`:270`) then `buildTemporalContext(..., 180)` (`:298–302`)
- `prepareTranscriptForWhatToAnswer(turns, 12)` caps to last 12 turns (`:296`).
- `TemporalContextBuilder.buildTemporalContext` (`TemporalContextBuilder.ts:160–178`) re-filters by same cutoff; caps assistant-history to last 3 (`:121–134`).
- Epoch summarization: `compactTranscriptIfNeeded` (`SessionTracker.ts:506–554`), `MAX_EPOCH_SUMMARIES=5` (`:61, :553`). Used by MeetingPersistence, NOT the live mode windows.
- **Combined context+mode cap: 60 000 chars** in `LLMHelper.ts:2561–2566`.
- **No token cap for cloud providers** — only Ollama's `streamWithOllama` enforces `maxContextTokens - system - 2000` (`:3303–3314`).
- No sentence-boundary chunker — `transcriptCleaner.ts` only does whitespace/dedupe.

### 3.5 Trigger logic

- **Manual hotkey path:** renderer-issued IPC, not Electron `globalShortcut`. `ipcHandlers.ts:2358` (`runWhatShouldISay(question, 0.8, imagePaths)`) and `:2486` (`runManualAnswer(question)`). No `KeybindManager` registers a global shortcut for this — accelerators live in the renderer.
- **Auto question detection:** native audio module emits `SuggestionTrigger` → `IntelligenceManager.handleSuggestionTrigger` (`IntelligenceManager.ts:133–135`) → `IntelligenceEngine.handleSuggestionTrigger` (`IntelligenceEngine.ts:170–175`). Gate: `if (trigger.confidence < 0.5) return;` then `runWhatShouldISay(trigger.lastQuestion, trigger.confidence)`. **The question detector itself lives in the Rust audio service**, not the TS layer.
- **Cooldown:** `triggerCooldown=3000` ms (`IntelligenceEngine.ts:94`), applied at `:242` (bypassed if `imagePaths` present).
- **Intent classification** (post-trigger, not a trigger itself): `classifyIntent` (`IntentClassifier.ts:268–291`) — three tiers:
  1. Regex `detectIntentByPattern` (`:186–225`)
  2. Zero-shot SLM (`Xenova/mobilebert-uncased-mnli`, threshold `SLM_CONFIDENCE_THRESHOLD=0.35` at `:65`)
  3. Context heuristic (`:235–254`)
  Called once from `IntelligenceEngine.ts:305–309`.
- **Refinement intent:** regex in `IntelligenceEngine.ts:19–38`, invoked on user transcripts at `:153–164`.
- No periodic chunk-threshold timer — all triggers are event-driven.

### 3.6 Streaming to UI

LLM tokens emit from `IntelligenceEngine` via `emit('suggested_answer_token', ...)` etc. (`:329, :406, :478, :541, :608, :727, :800`).

**IPC forwarding is batched on `setImmediate`, not per-token.** `main.ts:2675` `setupIntelligenceEvents` builds a `tokenBatches Map<BatchKind, any[]>` (`:2696`); `scheduleBatchFlush` via `setImmediate` (`:2708–2715`). Per-token handlers push to batch (`:2745, :2764, :2786, :2799, :2812`) and fire one `webContents.send('intelligence-token-batch', { kind, items })` per libuv tick. Non-token finals call `flushBatchesBeforeFinal()` first to preserve order. This is the post-Sprint-3 fix.

Generation-ID guard: `currentGenerationId` increments per run; mid-stream `stream.return(undefined)` cancels superseded generations (`IntelligenceEngine.ts:313–326`).

### 3.7 Tool / function calls

**None.** No `tools`, `tool_use`, `tool_choice`, `function_call`, or `functionDeclarations` anywhere in `LLMHelper.ts`. All providers are invoked in pure text-completion mode. The "negotiation coaching" feature uses **in-band string sentinel** — the model is prompted to emit `{"__negotiationCoaching":...}` JSON and the parser sniffs for it in plain text output (`IntelligenceEngine.ts:103–107`, `main.ts:2754–2762`).

### 3.8 Fallback chain

`streamGenerateWithImages` (`LLMHelper.ts:2589–2773`):
- Fast-text mode: Codex CLI → local Groq → Natively (`:2601–2641`)
- Ollama early-return (`:2643–2647`)
- Custom provider early-return (`:2654–2672`)
- Model-based routing: OpenAI → Claude → Groq → Gemini → Natively, with multimodal fall-through to Groq Llama-4-Scout at `:2734–2740`

`generateRollingScript` etc. builds a provider array (`:2356–2399`) and iterates Natively → Codex → OpenAI → Gemini Flash → Claude → Gemini Pro → Groq until one succeeds.

Local Groq 401 disables the path for the session (`_groqLocalDisabled=true` at `:2625`).

**No automatic in-call retries** — only the fallback waterfall. AbortControllers: Natively 10 s, Ollama 120 s, Custom 30 s, Gemini race shared (`:2860, :3354, :3443, :3214`).

### 3.9 Vision pipeline

Per-provider image handling in `LLMHelper.ts`:
- **Natively:** `sharp` resize ≤1920 px + JPEG q85 (`:2814–2837`). Raw fallback only if compressed > 500 KB.
- **Groq multimodal:** `processImage` resizes ≤1536 px JPEG q80 (`:2965–2967`).
- **OpenAI multimodal:** raw PNG, base64 in `data:image/png;base64,...` URL — **no compression** (`:3064–3071`).
- **Claude multimodal:** raw PNG, base64 — **no compression** (`:3097–3110`).
- **Gemini:** raw PNG `inlineData` — **no compression** (`:3156–3167`).
- **Ollama:** raw read, base64 `images:[]` (`:3316–3331`).

**Three of the most expensive providers receive uncompressed PNGs.** A typical 2560×1440 desktop screenshot is ~3–5 MB PNG; compressed JPEG q85 would be ~250–500 KB.

Vision entry points: `runCodeHint` (`IntelligenceEngine.ts:685–752`), `runBrainstorm` (`:758–830`), `runWhatShouldISay` with imagePaths (`:236–364`), `ProcessingHelper.processScreenshots` (`:143–196`).

### 3.10 Model auto-discovery (`electron/utils/modelFetcher.ts`)

On-demand `fetchProviderModels(provider, apiKey)` (`:19–35`):
- OpenAI: `GET /v1/models`, filters `gpt-4o*`, `gpt-[5-9]*`, `o[134]*` (no audio/realtime). 15 s axios timeout. (`:39–62`)
- Groq: `GET /openai/v1/models`, excludes `whisper|distil|guard|tool-use|vision-preview|tts|playai|speech` (`:66–88`).
- Anthropic: `GET /v1/models`, header `anthropic-version:2023-06-01`, filters Claude ≥3.5 (`:92–124`).
- Gemini: `GET /v1beta/models?key=...`, keeps `generateContent`-capable + `gemini-2.5+`/`gemini-[3-9]`; drops `nano|custom|computer-use|banana|tts|embedding|aqa|vision` (`:128–164`).

No background refresh; no cache layer. Baseline IDs in `LLMHelper.ts:41–46` are fallbacks when discovery isn't invoked.

---

## 4. RAG / embedding pipeline

### 4.1 Provider cascade (`EmbeddingProviderResolver.ts:19–44`)

Order: OpenAI (if key) → Gemini (if key) → Ollama (always tried at `localhost:11434`) → Local (unconditional final fallback `:30`; only fails if bundled model corrupt `:43`).

Models:
- OpenAI: `text-embedding-3-small`, 1536d (`OpenAIEmbeddingProvider.ts:7`)
- Gemini: `models/gemini-embedding-001`, 768d (`GeminiEmbeddingProvider.ts:7`)
- Ollama: `nomic-embed-text`, 768d, asymmetric (`OllamaEmbeddingProvider.ts:5,9`)
- Local: **`Xenova/all-MiniLM-L6-v2`, 384d** (`LocalEmbeddingProvider.ts:7–8,57`) — `@xenova/transformers` dynamic import, `local_files_only:true`, `env.allowRemoteModels=false`

**Documentation drift:** README references `bge-small-en-v1.5`. Code bundles and uses `all-MiniLM-L6-v2`. Bundled model paths: `resources/models/Xenova/all-MiniLM-L6-v2`, `resources/models/Xenova/mobilebert-uncased-mnli` (classification, not RAG). Resolved via `process.resourcesPath` in prod, `../../../../resources` in dev (`LocalEmbeddingProvider.ts:18–21`).

Per-dim vec0 tables (`vec_chunks_{dim}`, `vec_summaries_{dim}`) handle cross-provider re-embed (DatabaseManager v8/v9).

### 4.2 Pipeline init (`EmbeddingPipeline.ts`)
- `_doInitialize` `:81–`: step 1 eagerly inits local fallback `:86–95`, step 2 resolves primary `:99`, step 3 backfills provider metadata.
- `MAX_RETRIES=3`, `RETRY_DELAY_BASE_MS=2000`, `EMBED_TIMEOUT_MS=30_000` (`:13–19`).
- `fallbackMeetings` tracks meetings downgraded to local (`:35`).

### 4.3 Chunking (`SemanticChunker.ts`)
- `TARGET=300, MAX=400, MIN=100` (`:19–24`), `OVERLAP_TARGET_TOKENS=50`.
- Turn-based by speaker: split on speaker change OR `MAX` exceeded (`:103–106`), `MIN` floor.
- Overlap only within same speaker, max 2 segments (`:63, :115–122`).

### 4.4 Retrieval (`RAGRetriever.ts`)
- Defaults: `maxTokens=1500, topK=8` (over-fetched 2× for rerank `:89`), `recencyWeight=0.3, minSimilarity=0.25` (`:60–63, :91`).
- Intent: regex into `decision_recall | speaker_lookup | action_items | summary | open_question` (`:9–14`).
- Embeds query `:72`, searches `VectorStore.searchSimilar` `:87`, reranks by relevance+recency `:106–112`, token-budget cap `:114–`.
- On embed failure: empty context (`:75–83`).

### 4.5 VectorStore + worker (`VectorStore.ts` 710 lines, `vectorSearchWorker.ts` 299 lines)
- sqlite-vec extension preferred; JS fallback via dedicated worker thread (`:25–26`).
- `WORKER_TIMEOUT_MS=30_000` deadman switch (`:37`).
- Worker is lazy (`getWorker:50–83`), reused; rejects pending promises on `error`/`exit`.
- Worker actually used. Embeddings sent via `transferList` (zero-copy).
- Two strategies per worker call: `nativeVecSearch[Summaries]` (own read-only DB connection + sqlite-vec) or `searchChunks[Summaries]` (JS cosine on transferred Float32Array).

### 4.6 Indexing cadence
- Live JIT: `LiveRAGIndexer.ts` — `INDEXING_INTERVAL_MS=30_000, MIN_NEW_SEGMENTS=3` (`:15–16`). Fed by SessionTracker (`feedSegments:66–69`). Started at `main.ts:2490–2492` (`ragManager.startLiveIndexing('live-meeting-current')`).
- Post-meeting batch: `RAGManager.processMeeting`.
- Retrieval-time embedding: on-demand per query (`RAGRetriever.retrieve:72`).

---

## 5. Vision pipeline

### 5.1 ScreenshotHelper (`ScreenshotHelper.ts` 811 lines)
- `desktopCapturer.getSources({types:['screen'], thumbnailSize})` (`:472–480`). `thumbnailSize` uses logical resolution (not `width × scaleFactor`) to skip 50–200 ms decode overhead (`:466–471`).
- **Output = PNG** via `image.toPNG()` (`:267, :563`). **No JPEG codec used; no quality knob; no pre-send resize except multi-display stitching.**
- Stitching: `captureStitchedDesktopArea:574–579`; `sharp` resize `fit:'fill'` + composite for multi-monitor (`:336–380`).
- Permission gating: `assertScreenRecordingPermission:31–60`. Dev-mode bypass (`:35`).
- File output: `screenshotDir`/`extraScreenshotDir`, UUID filenames (`:420–426`).

### 5.2 CropperWindowHelper (`CropperWindowHelper.ts` 634 lines)
- Full-screen multi-monitor transparent panel for region selection. Uses `getCombinedDisplayBounds:391`. Windows `enableLargerThanScreen=true:421–422`. macOS `CROPPER_CONFIG.WINDOW_TYPE` panel `:424`.
- `showCropper(timeout=30000):277`. 30 s selection timeout.
- **GAP — `applyStealthToWindow` not called.** Comment at `:429–440` says it should be, but `applyOpacityShield` only calls `setContentProtection(true)` (`:365, :378`). The NSPanel SPIs that overlay/settings/model-selector get (`_setPreventsActivation:`, `becomesKeyOnlyIfNeeded`) are **missing on the cropper**. Click on the hairline UI during screen share may briefly promote Natively to frontmost.

### 5.3 OCR
**None local.** Grep for `tesseract|Tesseract|VNRecognize|extractText` across `electron/` + `native-module/` returns only `CodexCliService.extractText` (JSON event-stream parser, unrelated). All screenshot interpretation is shipped to a vision-capable LLM in raw PNG form — no Apple Vision FFI in `native-module/src`, no Tesseract.js dep.

### 5.4 Vision model rotation
See §3.10 — `modelFetcher.ts` keeps Gemini-2.5+ models that support `generateContent`. Explicit `*-vision` SKUs are filtered out; vision capability is inferred from base modern models that natively accept images.

---

## 6. Stealth implementation

### 6.1 BrowserWindow `setContentProtection(true)` coverage

Electron version `^33.2.0` (`package.json`). Above 22.1 → maps to `WDA_EXCLUDEFROMCAPTURE` on Windows (excludes from capture, not merely monitor-mirror).

| Window | File:line | Protection applied | Native stealth applied? |
|---|---|---|---|
| `WindowHelper.launcherWindow` | `WindowHelper.ts:242` | `:249` | yes (`:344–359`) |
| `WindowHelper.overlayWindow` | `:303` | `:304` | yes |
| `SettingsWindowHelper.settingsWindow` | `SettingsWindowHelper.ts:186` | `:195, :109, :119` | yes (`:214–225`) |
| `ModelSelectorWindowHelper.window` | `ModelSelectorWindowHelper.ts:171` | `:180` | yes (`:204–215`) |
| `CropperWindowHelper.cropperWindow` | `CropperWindowHelper.ts:427` | `:365, :378` via `applyOpacityShield` | **NO — gap, see §5.2** |

Initial fan-out from `AppState` constructor at `main.ts:319–322`; re-asserted on toggle at `:3339–3342`.

### 6.2 macOS NSWindow stealth (native — `native-module/src/stealth_window.rs`)

`apply_stealth_to_window`:
- `setBecomesKeyOnlyIfNeeded: YES` (`:107, :151`) — clicks don't promote to key window
- `setHidesOnDeactivate: NO` (`:114, :154`)
- `setCollectionBehavior` = CanJoinAllSpaces | FullScreenAuxiliary | IgnoresCycle (`:129–134`); `Stationary` intentionally removed
- `NSWindowStyleMaskNonactivatingPanel` re-assertion (`:140–158`)
- `setSharingType: NSWindowSharingNone` (`:184–186`) — belt-and-braces over Electron's flag
- Private `_setPreventsActivation:` SPI (`:213–217`) — writes CGS WindowServer tag directly, closes the AppKit↔WindowServer desync window
- Comment at `:166–178` acknowledges ScreenCaptureKit on macOS 15+ can bypass `NSWindowSharingNone` (this is the inherent OS limitation)

### 6.3 Windows stealth

- Relies on Electron `setContentProtection(true)` → `WDA_EXCLUDEFROMCAPTURE`. **No direct `SetWindowDisplayAffinity` FFI.**
- "Opacity Shield" sequence works around DWM flag-application race: `WindowHelper.ts:681–696`, `SettingsWindowHelper.ts:106–117`, `ModelSelectorWindowHelper.ts:80–91`, `CropperWindowHelper.ts:362–376`.
- `setAlwaysOnTop(true, 'screen-saver')` re-asserted on blur (`WindowHelper.ts:467–473`) to survive DWM demotion by Zoom/Teams.

### 6.4 Process disguise (`main.ts:3480–3636` `_applyDisguise(mode)`)

- `process.title = appName` (`:3559`), periodically re-asserted (`:3628, :3634–3636`)
- `app.setName(appName)` (`:3565`) — skipped when `isUndetectable` to avoid macOS re-registering the dock icon
- macOS `process.env.CFBundleName` (`:3569`)
- Windows `app.setAppUserModelId('com.natively.assistant.<mode>')` (`:3575`) — separate AUMID per mode so Taskbar doesn't group with real app
- Disguise icons swapped: `app.dock.setIcon` / per-window `setIcon` (`:3585, :3589–3591`)
- Window titles: `setTitle` (`:3600, :3606, :3612`)
- Modes: `'terminal' | 'settings' | 'activity' | 'none'` (`:237, :3501–3554`)

**All at runtime — no install-time binary renaming.** Binary remains `Natively.app` / `Natively.exe`. Survives reboots only via persisted `disguiseMode` (`:3482`) re-applied at startup (`:3491, :3731`).

### 6.5 Dock/menu-bar hiding

`app.dock.hide()` sites:
- Pre-emptive at startup before any BrowserWindow: `main.ts:3702–3704`
- Inside debounced `setUndetectable`: `:3404–3405` (150 ms debounce, `:3371, :3429`)
- Inside global `capture-and-process` shortcut: `:393–395`

`app.dock.show()`: `:3418` (leaving stealth), `:3919`, `:3585`. Comment at `:3993`: `// app.dock?.hide() // REMOVED: User wants Dock icon visible` — confirms dock is only hidden under explicit `isUndetectable`.

`_disguiseTimers` cancelled in `setUndetectable` (`:3349–3354`) to stop the timer at `:3634–3636` from re-asserting `process.title`/icon.

### 6.6 Native CGEventTap (invisible keyboard) — `native-module/src/keyboard_tap.rs`

- Session-level `kCGSessionEventTap` (`:6–10`) inserted before foreground app
- Swallows keystrokes (`:33–41`) — callback returns NULL to destroy event
- Worker thread + `CFRunLoopRun` blocking model (`:55–64`); marshalled to V8 via `ThreadsafeFunction`
- Requires Accessibility trust (`AXIsProcessTrusted` `:96, :104`); helpers `is_accessibility_granted` exposed via N-API
- `CGEventKeyboardGetUnicodeString` direct (`:108–120`)
- JS wrapper: `StealthKeyboardManager.ts` — singleton, idle-timeout 10 s `:68`, overlay-only broadcasts `:48–114`, token-based registration handles WebContents reuse on reload
- Activation hotkey `chat:focusInput` (`main.ts:407–437`) calls `mgr.toggle()`

### 6.7 Click-through (mouse pass-through)

- Default accelerator `CommandOrControl+Shift+B` registered as `general:toggle-mouse-passthrough` (`electron/services/KeybindManager.ts:16`)
- Implementation: `WindowHelper.syncOverlayInteractionPolicy` (`:544–567`) → `setIgnoreMouseEvents(true, { forward: true })` (`:559`)
- Comment `:550–558` explicitly avoids `setFocusable(false)` to keep Carbon/IOKit hotkeys alive
- Driven by `AppState.setOverlayMousePassthrough` (`main.ts:3440–3465`); `KeybindManager.revalidateShortcuts()` re-registers after policy change
- **Overlay only — launcher has no passthrough toggle**

### 6.8 Z-order survival

- Windows: `setAlwaysOnTop(true, 'screen-saver')` (`WindowHelper.ts:366, :471, :581, :693, :708`)
- macOS: `'floating'` + `setVisibleOnAllWorkspaces` + `setHiddenInMissionControl` (`:320–322`)

---

## 7. State management & persistence

### 7.1 DatabaseManager (`DatabaseManager.ts` 1471 lines, schema v14)

Singleton, `better-sqlite3`. PRAGMA `user_version` migration system (`:114–123`).

Migrations:
- v1: meetings, transcripts, ai_interactions, chunks, chunk_summaries, embedding_queue, user_profile, resume_nodes (`:127–220`)
- v2: ALTER `meetings` add `calendar_event_id`, `source`, `is_processed` (`:224`)
- v3: sqlite-vec `vec0` virtual tables, dynamic dim (`:240`)
- v4: drop strict-dim vec0 tables (`:271`)
- v5: chunks add `provider`/`dimensions` cols (`:300`)
- v6: `app_state` k/v (`:313`)
- v7: indices `idx_transcripts_meeting`, `idx_ai_interactions_meeting(meeting_id,timestamp)` (`:326`)
- v8: per-dimension `vec_chunks_{dim}` tables (`:341`)
- v9: defensive recreation of per-dim vec0 tables (`:357`)
- v10: UNIQUE on `embedding_queue` via rename transaction (`:387–433`)
- v11: `modes`, `mode_reference_files`, `mode_note_sections` + seed General (`:437–475`)
- v12: seed General mode note sections (`:478–499`)
- v13: backfill note sections for 7 mode templates (`:502–571`)
- **v14: `profile_custom_notes` singleton row** (`:574–585`)

### 7.2 MeetingPersistence (`MeetingPersistence.ts` 330 lines)

`stopMeeting()` (`:24–85`):
1. Force-flush interim transcript (`:28`)
2. Snapshot transcript/usage/context (`:38–44`) + metadata (`:48`) BEFORE `session.reset()` (`:51`)
3. UUID for `meetingId` (`:53`); schedule background `processAndSaveMeeting` (`:54`)
4. Write "Processing…" placeholder row (`:63–76`) and emit `meetings-updated` (`:79`)

`processAndSaveMeeting` (`:90+`) — background LLM title (GROQ_TITLE_PROMPT) + summary.

**Bug:** emits `BrowserWindow.getAllWindows().forEach(...send('meetings-updated'))` (`:78–79`) — bypasses the scoped `_broadcastToAllWindows` helper in `AppState` (`main.ts:3640–3655`).

### 7.3 SessionTracker (`SessionTracker.ts` 563 lines)

In-memory session state:
- `contextItems` 120 s / max 500 (`:39–40`)
- `fullTranscript: TranscriptSegment[]`, `fullUsage: any[]`, `sessionStartTime` (`:56–58`)
- Rolling epoch summarization, max 5 epochs (`:61–63`), via injected `RecapLLM` (`:80`)
- `currentMeetingMetadata` with `{title, calendarEventId, source}` (`:49–53`) — calendar integration
- Sticky coding-question state (`:69–77, setCodingQuestion:114–150`): screenshot source > transcript unless screenshot stale > 3 min
- Interviewer buffer 5-min window (`:74–75`)

### 7.4 AppState (in `main.ts` `:240+`)

Singleton owning windowHelper, settingsWindowHelper, modelSelectorWindowHelper, cropperWindowHelper, screenshotHelper, processingHelper (created `:310–317`), intelligenceManager, ragManager, audio captures, STT instances.

Boot-critical flags `:241–279`: `isUndetectable, disguiseMode, _verboseLogging, isMeetingActive, _isDraining, _pendingTeardown, _lastRequestedInputDeviceId/OutputDeviceId, _micSttRateApplied/_sysSttRateApplied, _disguiseTimers, _dockDebounceTimer, _dockReassertTimers, _ollamaBootstrapPromise, screenshotCaptureInProgress`.

`initializeApp()` (`:3664–3779`): single-instance lock → pre-emptive `app.dock.hide()` → CredentialsManager → AppState singleton → Modes seed → IPC handlers → disguise → OllamaManager → install ping → Google service account → STT pre-warm → `createWindow()`.

**State distinctions to be careful about:**
- `isMeetingActive` (`:252`) — synchronous UX truth
- `_isDraining` (`:259`) — transcript-handler-only acceptance window for trailing finals
- `_pendingTeardown` (`:267`) — promise gate that next start awaits
- Only the transcript handler reads `isMeetingActive || _isDraining`; all other paths read `isMeetingActive` alone

### 7.5 IPC surface (`ipcHandlers.ts` 3484 lines)

`safeHandle(channel, listener)` helper (`:21–24`) calls `removeHandler` then `handle`. One `ipcMain.on` at `:762` (log forwarding).

Channel namespaces by count:
- `get-*` (34) / `set-*` (34): settings, credentials, providers, languages, STT, models, license
- `profile:*` (14): resume/JD/company research
- `modes:*` (14): mode CRUD + reference files + note sections
- `generate-*` (10): suggestion/chat/brainstorm endpoints
- `rag:*` (8): index/query/reprocess/status
- `trial:*` (6), `license:*` (6), `phone:*` (5), `window-*` (4), `calendar:*` (3), `theme:*` (2), `gemini-chat*` (2), `permissions:*` (2)
- Singletons: take-screenshot, set-window-mode, set-undetectable, set-disguise, etc.
- Separately in `main.ts:343–358`: `stealth-tap:*` (no-op stubs on non-darwin)

### 7.6 Preload (`preload.ts` 1335 lines)

`contextBridge.exposeInMainWorld("electronAPI", { ... })` at `:370`. 301 `ipcRenderer.invoke/send/on` references. `nodeIntegration:false, contextIsolation:true` enforced at every BrowserWindow webPreferences (`WindowHelper.ts:186–188`, `SettingsWindowHelper.ts:165–167`, `ModelSelectorWindowHelper.ts:144–146`, `CropperWindowHelper.ts:413–415`).

---

## 8. Session lifecycle

Two concepts:
- **"Session"** = `SessionTracker` in-memory state. Reset by `MeetingPersistence.stopMeeting → session.reset()`.
- **"Meeting"** = persisted DB row. Created at stop as `Processing…` placeholder, promoted by background LLM title+summary.

`AppState.startMeeting(metadata?)` (`main.ts:2379–2516`):
1. Await `_pendingTeardown` (`:2387–2394`)
2. Reset audio recovery state (`:2397–2403`)
3. Mac mic permission check (`:2405–2409`)
4. Screen-recording status check (warning-only, mic-only fallback `:2417–2433`)
5. `windowHelper.resetOverlayPosition()` (`:2439`), `setWindowMode('overlay')` BEFORE state flip (`:2448`) to avoid CTA-pill flash
6. `isMeetingActive=true` (`:2450`), `broadcastMeetingState()` (`:2451`)
7. Apply metadata to IntelligenceManager (`:2452–2454`)
8. `session-reset` to overlay+launcher (`:2457–2458`)
9. `setTimeout(0)` → deferred audio init (`:2464`) — IPC returns instantly

Inside deferred IIFE (`:2466–2515`): guard `isMeetingActive` → `reconfigureAudio` → `setupSystemAudioPipeline` → start captures+STTs → `ragManager.startLiveIndexing('live-meeting-current')` → `startDefaultOutputWatcher()`.

`endMeeting()` (`:2518+`): sync flag flip + broadcast first (`:2533`), `_isDraining=true` (`:259`), STT stop, `intelligenceManager.stopMeeting()` returns `meetingId` (`:2612`), RAG `processMeeting` if still inactive (`:2621–2624`).

Live RAG meeting ID: hardcoded sentinel `'live-meeting-current'` at start, rebound to real UUID by MeetingPersistence at stop.

---

## 9. Notable existing gaps (summary)

These are inventory observations; the gap-analysis doc prioritises and prescribes fixes.

1. **CropperWindow** missing `applyStealthToWindow` despite comment claim (`CropperWindowHelper.ts:429–440`).
2. **README references `bge-small-en-v1.5`** but code uses `all-MiniLM-L6-v2` (384d).
3. **`MeetingPersistence` broadcasts via raw `getAllWindows().forEach`** (`:78–79`) — bypasses scoped helper.
4. **No local OCR** anywhere. All screenshot interpretation routes to vision-capable LLM in **raw PNG**.
5. **OpenAI/Claude/Gemini receive uncompressed PNG screenshots** — 5–20× bandwidth/cost vs JPEG q85.
6. **No client-side STT key rotation** except NativelyPro's server-side pool + client stagger.
7. **Three STT providers have unbounded reconnect loops** (ElevenLabs, Soniox, NativelyPro).
8. **No token cap for cloud LLM providers** — only Ollama enforces one.
9. **CORE_IDENTITY + EXECUTION_CONTRACT appear twice** in cloud system messages (in HARD_SYSTEM_PROMPT + in each MODE_*_PROMPT). ~2k duplicated tokens per request.
10. **No `prompt_cache_key` on OpenAI requests** — automatic prefix caching is unreliable across server pools.
11. **Gemini explicit `cachedContent` API not wired** — TODO at `LLMHelper.ts:3146–3151`.
12. **No tool/function calling.** Negotiation coaching uses in-band string-sentinel JSON.
13. **No sentence-boundary chunker** before LLM input. Partial transcripts can mid-sentence trigger.
14. **`elevenlabs_debug.raw`** dev-only debug write at `~/elevenlabs_debug.raw` (lines 40–48) — verify guard against packaged builds.
15. **Pre-Sprint-2 perf items** (already addressed): `bytemuck::cast_slice`, `BatchEmitter` coalescing, `setImmediate` IPC batching, `setTimeout(0)` start-deferred. **Pre-Sprint-1/2 still pending** per PERF_AUDIT: NativelyInterface 2,910-line monolith re-render storm (§3.1), 250 ms blocking sleep in `endMeeting` (§2.1), synchronous captures stop on main thread (§2.2).
