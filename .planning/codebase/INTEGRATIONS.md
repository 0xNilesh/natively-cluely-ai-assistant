# External Integrations

**Analysis Date:** 2026-03-22

## LLM Providers

The app implements a 3-tier model rotation system: Primary → Secondary → Tertiary fallback. All LLM calls route through `LLMHelper` (`electron/LLMHelper.ts`) with automatic failover.

**Google Gemini:**
- SDK: `@google/genai` v1.44.0
- Models: `gemini-3.1-flash-lite-preview` (default), `gemini-3.1-pro-preview`
- Usage: Answer generation, intent classification, vision analysis, RAG embeddings
- Auth: `geminiApiKey` in credentials
- Files: `electron/LLMHelper.ts`, `electron/rag/providers/GeminiEmbeddingProvider.ts`
- Embedding model: `models/gemini-embedding-001` (768 dimensions, symmetric)

**Anthropic Claude:**
- SDK: `@anthropic-ai/sdk` v0.74.0
- Model: `claude-sonnet-4-6`
- Usage: Answer generation, assist mode, follow-up mode
- Auth: `claudeApiKey` in credentials
- Files: `electron/LLMHelper.ts`
- Max output tokens: 64,000

**OpenAI GPT:**
- SDK: `openai` v6.22.0
- Model: `gpt-5.4`
- Usage: Answer generation, assist mode, follow-up mode
- Auth: `openaiApiKey` in credentials
- Files: `electron/LLMHelper.ts`
- Max output tokens: 65,536

**Groq:**
- SDK: `groq-sdk` v0.37.0
- Model: `llama-3.3-70b-versatile`
- Usage: Answer generation, title generation, summary JSON, follow-up emails
- Auth: `groqApiKey` in credentials
- Files: `electron/LLMHelper.ts`

**Ollama (Local):**
- No SDK — direct REST API to `http://localhost:11434`
- Default model: `llama3.2` (configurable)
- Usage: Local LLM inference, embedding generation
- Auth: None (local)
- Files: `electron/LLMHelper.ts`, `electron/services/OllamaManager.ts`, `electron/rag/providers/OllamaEmbeddingProvider.ts`
- Embedding model: `nomic-embed-text` (768 dimensions, **asymmetric** — documents use `search_document:` prefix, queries use `search_query:`)
- Lifecycle: `OllamaManager` auto-starts `ollama serve` if not running

**Custom / cURL Providers:**
- User-defined via cURL command parsing (`@bany/curl-to-json`)
- Configured in `CredentialsManager.customProviders` / `CredentialsManager.curlProviders`
- Response extraction via configurable JSON path (`responsePath`)

## STT (Speech-to-Text) Providers

All STT providers implement a unified EventEmitter interface (`electron/audio/`):
- Events: `transcript({ text, isFinal, confidence })`, `error`, `start`, `stop`, `speech_ended`
- Methods: `start()`, `stop()`, `write(Buffer)`, `setSampleRate()`, `setRecognitionLanguage()`, `notifySpeechEnded()`

**Google Cloud Speech-to-Text:**
- SDK: `@google-cloud/speech` v7.2.1 (gRPC streaming)
- Connection: Bi-directional streaming via `SpeechClient`
- Auth: `GOOGLE_APPLICATION_CREDENTIALS` env var (service account JSON path)
- Features: Server-side VAD, interim results, alternative language codes
- File: `electron/audio/GoogleSTT.ts`

**Deepgram:**
- Connection: WebSocket streaming to Deepgram API
- Auth: `deepgramApiKey` in credentials
- Features: Exponential backoff reconnect, KeepAlive JSON messages
- File: `electron/audio/DeepgramStreamingSTT.ts`

**Soniox:**
- Connection: WebSocket streaming to `wss://stt-rt.soniox.com/transcribe-websocket`
- Auth: `sonioxApiKey` in credentials
- Features: 60+ language auto-detection, endpoint detection, structured context (up to 8000 tokens)
- File: `electron/audio/SonioxStreamingSTT.ts`

**ElevenLabs:**
- Streaming: WebSocket to `wss://api.elevenlabs.io/v1/speech-to-text/realtime` (Scribe v2)
- REST: Batch upload via ElevenLabs API
- Auth: `elevenLabsApiKey` in credentials
- Features: PCM accumulation with 250ms buffering, 48kHz→16kHz downsampling
- File: `electron/audio/ElevenLabsStreamingSTT.ts`, `electron/audio/RestSTT.ts`

**OpenAI Whisper:**
- Streaming: WebSocket Realtime API (`wss://api.openai.com/v1/realtime?intent=transcription`)
  - Models: `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` (priority order)
- REST: `whisper-1` (fallback)
- Auth: `openAiSttApiKey` in credentials
- Features: Ring buffer pre-buffering (~30s), auto-downsampling, REST fallback with client VAD
- File: `electron/audio/OpenAIStreamingSTT.ts`

**Groq Whisper (REST):**
- Endpoint: `https://api.groq.com/openai/v1/audio/transcriptions`
- Model: `whisper-large-v3-turbo`
- Auth: `groqSttApiKey` in credentials
- File: `electron/audio/RestSTT.ts`

**Azure Speech Services (REST):**
- Endpoint: Azure Speech API
- Auth: `azureApiKey` + `azureRegion` in credentials
- File: `electron/audio/RestSTT.ts`

**IBM Watson (REST):**
- Endpoint: IBM Watson Speech-to-Text API
- Auth: `ibmWatsonApiKey` + `ibmWatsonRegion` in credentials
- File: `electron/audio/RestSTT.ts`

## RAG Embedding Providers

Provider cascade: OpenAI → Gemini → Ollama → Local (always available fallback)

**OpenAI Embeddings:**
- Model: `text-embedding-3-small` (1536 dimensions, symmetric)
- Auth: `openaiApiKey`
- File: `electron/rag/providers/OpenAIEmbeddingProvider.ts`

**Gemini Embeddings:**
- Model: `models/gemini-embedding-001` (768 dimensions via `outputDimensionality`)
- Auth: `geminiApiKey`
- File: `electron/rag/providers/GeminiEmbeddingProvider.ts`

**Ollama Embeddings:**
- Model: `nomic-embed-text` (768 dimensions, **asymmetric**)
- Auth: None (local)
- File: `electron/rag/providers/OllamaEmbeddingProvider.ts`

**Local Embeddings:**
- Always available fallback
- File: `electron/rag/providers/LocalEmbeddingProvider.ts`

## Web Search

**Tavily:**
- SDK: `@tavily/core` v0.7.2
- Auth: `tavilyApiKey` in credentials
- Usage: Web search for knowledge augmentation (premium feature)
- Integration: Loaded dynamically via `require('../premium/electron/knowledge/TavilySearchProvider')`
- File: Referenced in `electron/ipcHandlers.ts` (line 2104)

## Google Calendar

**Google Calendar API:**
- SDK: Direct REST via `axios` to `https://www.googleapis.com/auth/calendar.readonly`
- Auth: OAuth 2.0 (local loopback server at `http://localhost:11111/auth/callback`)
- Credentials: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars
- Tokens: Encrypted with Electron `safeStorage` in `{userData}/calendar_tokens.enc`
- Usage: Fetch upcoming meetings, auto-associate with calendar events
- File: `electron/services/CalendarManager.ts`

## Auto-Update

**electron-updater:**
- SDK: `electron-updater` v6.7.3
- Provider: GitHub Releases (`evinjohnn/natively-cluely-ai-assistant`)
- Usage: Automatic app updates with release notes
- File: Referenced in `electron/main.ts`

## Audio Capture (Native)

**natively-audio (Rust native module):**
- Framework: `napi-rs` v2.12.2
- System audio capture via platform APIs:
  - macOS: `cidre` (CoreAudio/CoreMedia/ScreenCaptureKit)
  - Windows: `wasapi` v0.13.0 (Windows Audio Session API)
- Microphone capture via `cpal` v0.15.2
- Voice activity detection: `webrtc-vad` v0.4
- Audio resampling: `rubato` v0.16
- Output format: Int16LE PCM
- Files: `native-module/src/` (Rust source), `electron/audio/SystemAudioCapture.ts`, `electron/audio/MicrophoneCapture.ts`

## OCR & Image Processing

**Tesseract.js:**
- SDK: `tesseract.js` v5.0.5
- Usage: Optical character recognition for screenshots
- File: Referenced in `electron/ScreenshotHelper.ts`

**Sharp:**
- SDK: `sharp` v0.33.5
- Usage: Image processing and manipulation
- File: Referenced in `electron/LLMHelper.ts`

## Data Storage

**SQLite (Local):**
- Client: `better-sqlite3` v12.6.2
- Extension: `sqlite-vec` v0.1.7-alpha.2 (vector search)
- Location: `{userData}/natively.db`
- Content: Meetings, transcripts, embeddings, embedding queue
- File: `electron/db/DatabaseManager.ts`

**Settings (Local JSON):**
- Client: `electron-store` v8.1.0 + custom `SettingsManager`
- Location: `{userData}/settings.json`
- Content: Boot-critical settings (disguise mode, verbose logging)
- File: `electron/services/SettingsManager.ts`

**Credentials (Encrypted):**
- Client: Electron `safeStorage` API
- Location: `{userData}/credentials.enc`
- Content: All API keys, OAuth tokens
- File: `electron/services/CredentialsManager.ts`

## CI/CD & Distribution

**Build & Publish:**
- Builder: `electron-builder` v25.1.8
- Publish target: GitHub Releases
- Signing: macOS ad-hoc signing via `scripts/ad-hoc-sign.js`
- Notarization: `@electron/notarize` v3.1.1 (available but `hardenedRuntime: false`)
- Platforms: macOS (x64 + arm64), Windows (x64 + ia32), Linux (x64)

---

*Integration audit: 2026-03-22*
