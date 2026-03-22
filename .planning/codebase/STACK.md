# Technology Stack

**Analysis Date:** 2026-03-22

## Languages

**Primary:**
- TypeScript (v5.6.3) — Both Electron main process and React renderer
- Rust (Edition 2021) — Native audio capture module

**Secondary:**
- JavaScript — Configuration files (tailwind.config.js, postcss.config.js)

## Runtime

**Environment:**
- Electron v33.2.0 — Desktop application shell
- Node.js — Electron main process runtime
- Chromium — Electron renderer process

**Package Manager:**
- npm — Standard Node package manager
- Lockfile: `package-lock.json` present

## Frameworks

**Frontend (Renderer):**
- React v18.3.1 — UI framework
- Vite v5.4.11 — Build tool and dev server (config: `vite.config.mts`)
- Tailwind CSS v3.4.15 — Utility-first CSS framework (config: `tailwind.config.js`)
- PostCSS v8.4.49 — CSS processing (config: `postcss.config.js`)
- Framer Motion v12.29.2 — Animations and transitions
- React Query v3.39.3 — Server state management
- React Markdown v10.1.0 — Markdown rendering with remark-gfm, remark-math, rehype-katex

**UI Component Libraries:**
- Radix UI — Headless accessible primitives
  - `@radix-ui/react-dialog` v1.1.2
  - `@radix-ui/react-toast` v1.2.2
- Lucide React v0.460.0 — Icon library
- React Icons v5.3.0 — Additional icons
- Class Variance Authority v0.7.0 — Component variant management
- Tailwind Merge v2.5.4 — Tailwind class merging
- clsx v2.1.1 — Conditional class names

**Main Process (Electron):**
- TypeScript compiled to CommonJS (`electron/tsconfig.json`: `module: "CommonNode"`, `moduleResolution: "node"`)
- Better-SQLite3 v12.6.2 — Embedded database
- electron-store v8.1.0 — Persistent key-value settings
- electron-updater v6.7.3 — Auto-update mechanism

## Build Tools & Bundlers

**Development:**
- Vite v5.4.11 — Frontend bundler (ESNext target, `@vitejs/plugin-react`)
- `vite-plugin-electron` v0.28.8 — Electron integration with Vite
- `vite-plugin-electron-renderer` v0.14.6 — Renderer process support
- `concurrently` v9.1.0 — Parallel process execution (`npm start`)
- `wait-on` v8.0.1 — Wait for dev server readiness
- `cross-env` v7.0.3 — Cross-platform env variables

**Production:**
- electron-builder v25.1.8 — Application packaging and distribution
  - Targets: macOS (zip, dmg, x64/arm64), Windows (nsis, portable, x64/ia32), Linux (AppImage, deb, x64)
  - Publishes to GitHub releases

**TypeScript Configuration:**
- Root (`tsconfig.json`): ESNext target, bundler module resolution, `jsx: "react-jsx"`, includes `src/` and `premium/src/`
- Electron (`electron/tsconfig.json`): ESNext target, CommonJS module, Node module resolution, outputs to `dist-electron/`
- Vite node config (`tsconfig.node.json`): Referenced for Node-related TS

**Path Aliases:**
- `@/` → `./src` (Vite resolve alias in `vite.config.mts`)

## Database & Storage

**Primary Database:**
- SQLite via `better-sqlite3` v12.6.2
  - Location: `{userData}/natively.db`
  - Manager: `electron/db/DatabaseManager.ts` (singleton)
  - Extension: `sqlite-vec` v0.1.7-alpha.2 for vector similarity search

**Vector Search:**
- `sqlite-vec` — SQLite extension for approximate nearest neighbor (ANN) vector search
  - Per-dimension tables: `vec_chunks_768`, `vec_chunks_1536`, `vec_chunks_3072`
  - Worker thread isolation via `vectorSearchWorker.ts`
- `@xenova/transformers` v2.17.2 — Local ML model inference (intent classification via mobilebert-uncased-mnli)

**Configuration Storage:**
- `electron-store` v8.1.0 — JSON file persistence for app settings
- `SettingsManager` (`electron/services/SettingsManager.ts`) — Boot-critical settings in `{userData}/settings.json`
- `CredentialsManager` (`electron/services/CredentialsManager.ts`) — Encrypted credential storage using Electron `safeStorage` API in `{userData}/credentials.enc`

## Native Module

**Rust Audio Capture (`native-module/`):**
- Built with `napi-rs` v2.12.2 — Node.js native addon framework
- Crate type: `cdylib` — C dynamic library
- Key dependencies:
  - `cpal` v0.15.2 — Cross-platform audio I/O
  - `ringbuf` v0.4 — Lock-free ring buffer for audio streaming
  - `rubato` v0.16 — Audio resampling
  - `webrtc-vad` v0.4 — Voice activity detection
  - `cidre` v0.11.10 — macOS Core Audio/CoreMedia integration
  - `wasapi` v0.13.0 — Windows audio API integration
  - `reqwest` v0.12 — HTTP client (blocking) for license validation
  - `machine-uid` v0.5 — Machine identification for licensing
- Packaged as optional dependency `natively-audio: file:./native-module`
- Build script: `scripts/build-native.js`
- Compiled binary: `native-module/index.win32-x64-msvc.node` (Windows)

## Authentication

**Credential Management:**
- Electron `safeStorage` API — OS-level encryption for API keys
- `keytar` v7.9.0 — System keychain integration (legacy/alternative)
- API keys stored encrypted in `{userData}/credentials.enc`

**OAuth:**
- Google OAuth 2.0 — Calendar integration via local loopback server (`http://localhost:11111/auth/callback`)
- Tokens stored encrypted with `safeStorage`

## Key Dependencies Summary

**LLM SDKs:**
- `@google/genai` v1.44.0 — Google Gemini API
- `@anthropic-ai/sdk` v0.74.0 — Claude API
- `openai` v6.22.0 — OpenAI GPT API
- `groq-sdk` v0.37.0 — Groq inference API

**STT SDKs:**
- `@google-cloud/speech` v7.2.1 — Google Cloud Speech-to-Text (gRPC)
- `@grpc/grpc-js` v1.14.3 + `@grpc/proto-loader` v0.8.0 — gRPC support
- `ws` v8.19.0 — WebSocket client for streaming STT providers
- `@elevenlabs/elevenlabs-js` v2.39.0 + `@elevenlabs/client` v0.15.1 — ElevenLabs STT

**Search & Web:**
- `@tavily/core` v0.7.2 — Tavily web search API (premium feature)
- `axios` v1.7.7 — HTTP client for API calls

**Document Processing:**
- `pdf-parse` v2.4.5 — PDF text extraction
- `mammoth` v1.11.0 — DOCX text extraction
- `jspdf` v4.0.0 — PDF generation
- `sharp` v0.33.5 — Image processing
- `tesseract.js` v5.0.5 — OCR (optical character recognition)
- `screenshot-desktop` v1.15.0 — Screen capture

**Media & Math:**
- `katex` v0.16.27 — LaTeX math rendering
- `three` v0.182.0 — 3D rendering (Three.js)
- `diff` v7.0.0 — Text diffing

**Utilities:**
- `uuid` v11.0.3 — UUID generation
- `tree-kill` v1.2.2 — Process tree termination
- `form-data` v4.0.1 — Multipart form construction
- `@bany/curl-to-json` v1.2.10 — cURL command parsing for custom providers

## Environment Variables

**Required (via `.env` or system):**
- `GOOGLE_APPLICATION_CREDENTIALS` — Path to Google service account JSON
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth credentials
- API keys managed via UI: `geminiApiKey`, `groqApiKey`, `openaiApiKey`, `claudeApiKey`, `deepgramApiKey`, `elevenLabsApiKey`, `sonioxApiKey`, `tavilyApiKey`, `azureApiKey`, `ibmWatsonApiKey`

**Build:**
- `NIVELY_BUILD_ALL_MAC_ARCHES=1` — Universal macOS build flag
- `NODE_ENV` — `development` or `production`

---

*Stack analysis: 2026-03-22*
