# Codebase Structure

**Analysis Date:** 2026-03-22

## Directory Layout

```
natively-cluely-ai-assistant/
├── electron/                    # Main process (TypeScript, CommonJS)
│   ├── main.ts                  # AppState singleton, app lifecycle, audio pipeline (2191 lines)
│   ├── ipcHandlers.ts           # 100+ IPC handlers (~2137 lines)
│   ├── preload.ts               # Context bridge: 120+ typed IPC methods
│   ├── audio/                   # Audio capture + STT providers
│   ├── llm/                     # LLM provider abstractions
│   ├── rag/                     # RAG system (embeddings, vector search)
│   ├── db/                      # SQLite database layer
│   ├── services/                # Manager singletons (credentials, settings, keybinds)
│   ├── config/                  # Constants (languages)
│   ├── update/                  # Release notes, auto-update
│   ├── utils/                   # Helpers (logging, file ops, model fetching)
│   └── __tests__/               # Electron-side tests
├── src/                         # React renderer (Vite, ESNext, Tailwind)
│   ├── main.tsx                 # React entry point
│   ├── App.tsx                  # Root component (multi-window router)
│   ├── components/              # UI components
│   ├── hooks/                   # Custom React hooks
│   ├── _pages/                  # Page-level components
│   ├── premium/                 # Premium renderer exports (barrel)
│   ├── lib/                     # Utility libraries (analytics, overlay appearance)
│   ├── types/                   # TypeScript type definitions
│   ├── config/                  # Frontend configuration
│   ├── utils/                   # Frontend utilities
│   ├── assets/                  # Static assets (icons, images)
│   ├── font/                    # Font files
│   └── icons/                   # SVG/icon components
├── premium/                     # Premium features (conditionally loaded)
│   ├── electron/                # Premium main process modules
│   │   ├── knowledge/           # Knowledge orchestration (23 files)
│   │   └── services/            # LicenseManager
│   └── src/                     # Premium renderer components (8 files)
├── native-module/               # Rust native audio capture (napi-rs)
│   ├── src/                     # Rust source (8 files)
│   ├── Cargo.toml               # Rust package config
│   └── index.d.ts               # TypeScript declarations
├── assets/                      # App icons, disguise icons, tray icons
├── resources/                   # ML models, build resources
├── scripts/                     # Build scripts (native build, model download, signing)
├── docs/                        # Documentation
├── renderer/                    # Legacy CRA project (NOT actively used)
├── dist/                        # Vite build output (renderer)
├── dist-electron/               # Electron build output (main process)
├── release/                     # electron-builder output
│
├── package.json                 # Root package (Electron + Vite + dependencies)
├── tsconfig.json                # Root TypeScript config (ESNext, bundler)
├── electron/tsconfig.json       # Electron TypeScript config (CommonJS, node)
├── vite.config.mts              # Vite config (React plugin, @/ alias → ./src)
├── tailwind.config.js           # Tailwind CSS config
├── postcss.config.js            # PostCSS config
├── index.html                   # Vite HTML entry point
├── AGENTS.md                    # Project knowledge base
└── opencode.json                # OpenCode tool configuration
```

## Directory Purposes

### `electron/` — Main Process

**Purpose:** All application logic, OS integration, external API communication

**Contains:** Business logic, window management, audio pipelines, LLM orchestration, database, IPC handlers

**Key files:**
- `main.ts` — AppState singleton (central state hub), `initializeApp()` boot sequence, audio pipeline creation, stealth/disguise system, auto-updater
- `ipcHandlers.ts` — All IPC channel registrations via `safeHandle()` wrapper
- `preload.ts` — `contextBridge.exposeInMainWorld('electronAPI', ...)` with 120+ methods
- `WindowHelper.ts` — Creates/manages Launcher + Overlay BrowserWindows
- `SettingsWindowHelper.ts` — Settings popup window
- `ModelSelectorWindowHelper.ts` — Quick model switch popup
- `CropperWindowHelper.ts` — Screenshot region selector (Windows-specific)
- `ScreenshotHelper.ts` — Screenshot capture and queue management
- `ProcessingHelper.ts` — Orchestrates screenshot → LLM processing pipeline
- `IntelligenceManager.ts` — Manages AI insight modes (assist, answer, follow-up, recap)
- `IntelligenceEngine.ts` — Core intelligence processing engine
- `LLMHelper.ts` — LLM client abstraction with provider switching
- `ThemeManager.ts` — Light/dark/system theme management
- `DonationManager.ts` — Donation prompt state management
- `MeetingPersistence.ts` — Meeting save/load operations
- `SessionTracker.ts` — Session state tracking

**Subdirectories:**

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `audio/` | Audio capture + STT | `SystemAudioCapture.ts`, `MicrophoneCapture.ts`, `GoogleSTT.ts`, `DeepgramStreamingSTT.ts`, `SonioxStreamingSTT.ts`, `ElevenLabsStreamingSTT.ts`, `OpenAIStreamingSTT.ts`, `RestSTT.ts`, `AudioDevices.ts` |
| `llm/` | LLM provider abstraction | `AnswerLLM.ts`, `AssistLLM.ts`, `FollowUpLLM.ts`, `RecapLLM.ts`, `WhatToAnswerLLM.ts`, `IntentClassifier.ts`, `index.ts`, `prompts.ts`, `types.ts`, `postProcessor.ts`, `transcriptCleaner.ts`, `TemporalContextBuilder.ts` |
| `rag/` | Retrieval-Augmented Generation | `RAGManager.ts`, `RAGRetriever.ts`, `EmbeddingPipeline.ts`, `EmbeddingProviderResolver.ts`, `VectorStore.ts`, `SemanticChunker.ts`, `LiveRAGIndexer.ts`, `TranscriptPreprocessor.ts`, `OllamaBootstrap.ts`, `vectorSearchWorker.ts`, `providers/` |
| `db/` | Database layer | `DatabaseManager.ts`, `seedDemo.ts`, `test-db.ts` |
| `services/` | Manager singletons | `CredentialsManager.ts`, `SettingsManager.ts`, `KeybindManager.ts`, `OllamaManager.ts`, `CalendarManager.ts`, `RateLimiter.ts`, `InstallPingManager.ts`, `ModelVersionManager.ts` |
| `config/` | Constants | `languages.ts` |
| `update/` | Auto-update | `ReleaseNotesManager.ts` |
| `utils/` | Shared helpers | Logging, file ops, model fetching |

### `src/` — React Renderer

**Purpose:** UI rendering — no business logic. Communicates with main process via `window.electronAPI`.

**Contains:** React components, hooks, styling, frontend utilities

**Key files:**
- `main.tsx` — React DOM entry point
- `App.tsx` — Root component. Routes via `?window=` URL params: renders `Launcher`, `NativelyInterface` (overlay), `SettingsPopup`, `ModelSelectorWindow`, or `Cropper`

**Subdirectories:**

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `components/` | UI components | `NativelyInterface.tsx` (overlay chat), `Launcher.tsx` (home), `SettingsOverlay.tsx`, `SettingsPopup.tsx`, `ModelSelectorWindow.tsx`, `Cropper.tsx`, `UpdateBanner.tsx`, `UpdateModal.tsx`, `StartupSequence.tsx`, `SupportToaster.tsx`, `ErrorBoundary.tsx`, `GlobalChatOverlay.tsx` |
| `components/ui/` | Radix UI primitives | Dialog, toast, TopPill, RollingTranscript |
| `components/settings/` | Settings sub-panels | AIProviders, General, Sidebar |
| `hooks/` | Custom React hooks | `useShortcuts.ts`, `useStreamBuffer.ts` |
| `_pages/` | Page components | Full-page layouts |
| `lib/` | Utility libraries | `analytics/analytics.service.ts`, `overlayAppearance.ts` |
| `types/` | TypeScript types | Type definitions |
| `config/` | Frontend config | UI configuration |
| `utils/` | Frontend utilities | Helper functions |
| `premium/` | Premium exports barrel | Re-exports from `../../premium/src/` |
| `assets/` | Static assets | Images, icons |
| `font/` | Fonts | Web font files |
| `icons/` | SVG icons | React icon components |

### `premium/` — Premium Features

**Purpose:** Optional premium features loaded conditionally. App works without this directory.

**`premium/electron/`** — Main process premium modules:
- `knowledge/KnowledgeOrchestrator.ts` — Central knowledge intelligence hub
- `knowledge/KnowledgeDatabaseManager.ts` — Premium DB tables
- `knowledge/` — 23 specialized engines: `CompanyResearchEngine.ts`, `SalaryIntelligenceEngine.ts`, `NegotiationEngine.ts`, `MockInterviewGenerator.ts`, `StarStoryGenerator.ts`, `GapAnalysisEngine.ts`, `CultureValuesMapper.ts`, `LiveNegotiationAdvisor.ts`, `NegotiationConversationTracker.ts`, `TechnicalDepthScorer.ts`, `TavilySearchProvider.ts`, `HybridSearchEngine.ts`, `DocumentReader.ts`, `DocumentChunker.ts`, `StructuredExtractor.ts`, `ContextAssembler.ts`, `PostProcessor.ts`, `IntentClassifier.ts`, `AOTPipeline.ts`, `llmUtils.ts`, `types.ts`
- `services/LicenseManager.ts` — License activation with hardware ID

**`premium/src/`** — Renderer premium components:
- `PremiumUpgradeModal.tsx` — License activation modal
- `PremiumPromoToaster.tsx` — Premium upsell toast
- `ProfileFeatureToaster.tsx` — Profile setup prompt
- `JDAwarenessToaster.tsx` — Job description awareness prompt
- `RemoteCampaignToaster.tsx` — Remote campaign display
- `ProfileVisualizer.tsx` — Profile data visualization
- `NegotiationCoachingCard.tsx` — Negotiation coaching UI
- `useAdCampaigns.ts` — Ad campaign management hook

### `native-module/` — Rust Native Code

**Purpose:** Low-latency platform-specific audio capture via napi-rs

**Contains:**
- `src/lib.rs` — Main library entry
- `src/audio_config.rs` — Audio configuration
- `src/microphone.rs` — Microphone capture
- `src/resampler.rs` — Audio resampling
- `src/silence_suppression.rs` — VAD/silence detection
- `src/vad.rs` — Voice activity detection
- `src/license.rs` — License checking
- `src/speaker/` — Speaker diarization
- `Cargo.toml` — Rust dependencies
- `index.d.ts` — TypeScript type declarations
- `index.win32-x64-msvc.node` — Compiled Windows binary

**Built via:** `node scripts/build-native.js` or `napi-rs build`

**Used as:** `"natively-audio": "file:./native-module"` in optionalDependencies

## Key File Locations

**Entry Points:**
- `electron/main.ts`: Electron main process entry — `initializeApp()` boot sequence
- `src/main.tsx`: React renderer entry point
- `index.html`: Vite HTML template

**Configuration:**
- `package.json`: Dependencies, scripts, electron-builder config
- `tsconfig.json`: Root TypeScript config (ESNext, bundler mode, `@/` → `./src`)
- `electron/tsconfig.json`: Electron TypeScript config (CommonJS, node resolution)
- `vite.config.mts`: Vite dev server (port 5180), build chunks, `@/` alias
- `tailwind.config.js`: Tailwind CSS configuration
- `postcss.config.js`: PostCSS plugins

**Core Logic:**
- `electron/main.ts`: AppState, audio pipeline, stealth system
- `electron/ipcHandlers.ts`: All IPC channels
- `electron/ProcessingHelper.ts`: Screenshot → AI pipeline
- `electron/IntelligenceManager.ts`: AI insight orchestration
- `electron/LLMHelper.ts`: LLM provider abstraction

**Testing:**
- `electron/__tests__/`: Electron-side tests

## Naming Conventions

**Files:**
- PascalCase for classes/components: `AppState.ts`, `WindowHelper.ts`, `Launcher.tsx`
- camelCase for utilities: `postProcessor.ts`, `transcriptCleaner.ts`
- kebab-case for config: `vite.config.mts`, `tailwind.config.js`

**Directories:**
- camelCase for code dirs: `electron/`, `native-module/`, `premium/`
- PascalCase avoided in directory names (except legacy `UI_comp/`)

## Where to Add New Code

**New IPC Handler:**
- Add `safeHandle("channel-name", ...)` in `electron/ipcHandlers.ts`
- Add corresponding method to `ElectronAPI` interface in `electron/preload.ts`
- Add `ipcRenderer.invoke()` mapping in the `contextBridge.exposeInMainWorld` block

**New LLM Provider:**
- Create file in `electron/llm/` following `AnswerLLM.ts` pattern
- Register in `electron/llm/index.ts`
- Wire into `LLMHelper.ts` provider switch

**New STT Provider:**
- Create file in `electron/audio/` following `RestSTT.ts` (REST) or `DeepgramStreamingSTT.ts` (WebSocket) pattern
- Add to `createSTTProvider()` factory in `electron/main.ts`
- Add provider option to `set-stt-provider` IPC handler in `ipcHandlers.ts`

**New UI Component:**
- Add to `src/components/` (PascalCase filename)
- Use Tailwind for styling, Radix UI primitives for accessibility
- Import via `@/components/...` path alias

**New React Hook:**
- Add to `src/hooks/` with `use` prefix: `useMyHook.ts`

**New Service/Manager:**
- Add to `electron/services/` following singleton `getInstance()` pattern
- Use `electron-store` for persistence if needed

**New Premium Feature:**
- Main process: add to `premium/electron/knowledge/`
- Renderer: add to `premium/src/` and export from barrel
- Wire into `KnowledgeOrchestrator.ts` if knowledge-related

**New Setting:**
- Add IPC handlers in `ipcHandlers.ts`
- Add to `CredentialsManager.ts` or `SettingsManager.ts` depending on sensitivity
- Add preload bridge method in `preload.ts`

## Special Directories

**`dist/`**: Vite build output (renderer). Generated, not committed. Contains compiled React app.

**`dist-electron/`**: TypeScript compilation output for Electron main process. Generated, not committed.

**`release/`**: electron-builder output. Generated, not committed.

**`renderer/`**: Legacy Create React App project. NOT actively used. Contains only a test file.

**`resources/`**: ML models and build-time resources. Included in `extraResources` for electron-builder.

**`assets/`**: App icons (real + disguise variants), tray icons, platform-specific icons.

**`scripts/`**: Build helper scripts: `build-native.js` (Rust), `download-models.js` (ML models), `ensure-sqlite-vec.js` (native module rebuild), `ad-hoc-sign.js` (macOS signing).

**`node_modules/`**: Dependencies. Not committed.

---

*Structure analysis: 2026-03-22*
