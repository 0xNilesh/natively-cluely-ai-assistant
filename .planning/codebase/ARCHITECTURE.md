# Architecture

**Analysis Date:** 2026-03-22

## Pattern Overview

**Overall:** Electron multi-process desktop application with singleton-based state management

**Key Characteristics:**
- Dual-process Electron architecture (main process + renderer process)
- AppState singleton pattern for centralized main-process state
- Multi-window renderer with URL-param-based routing (same React app, different views)
- Lazy-initialized audio pipeline deferred until meeting start
- Conditional premium module loading with graceful fallback

## Layers

### Main Process (`electron/`)

**Purpose:** All business logic, OS integration, audio capture, LLM orchestration, database, IPC

**Location:** `electron/`

**Contains:**
- `main.ts` — AppState singleton (2191 lines), app lifecycle, audio pipeline, stealth system
- `ipcHandlers.ts` — 100+ IPC handlers (~2137 lines), all renderer ↔ main communication
- `preload.ts` — Context bridge exposing safe IPC methods to renderer

**Depends on:** Node.js, Electron APIs, native modules, external services

**Used by:** Renderer via IPC

### Renderer Process (`src/`)

**Purpose:** UI rendering only — no business logic

**Location:** `src/`

**Contains:** React components, hooks, styling (Tailwind), state for UI rendering

**Depends on:** `window.electronAPI` (preload bridge), React, Tailwind, Radix UI

**Used by:** Electron BrowserWindow instances

### Native Module (`native-module/`)

**Purpose:** Platform-specific audio capture (Rust/napi-rs)

**Location:** `native-module/`

**Contains:** Rust code for low-latency audio capture, VAD, resampling, speaker diarization

**Depends on:** napi-rs, Rust toolchain

**Used by:** Main process audio pipeline

### Premium Module (`premium/`)

**Purpose:** Optional premium features loaded conditionally

**Location:** `premium/electron/` (main process) and `premium/src/` (renderer)

**Contains:** Knowledge orchestration, company research, negotiation engine, license management, ad campaigns

**Depends on:** Core app modules, Tavily API

**Used by:** Main process via `require('../premium/...')` with try/catch

## Data Flow

### Meeting Lifecycle Flow

1. User clicks "Start Meeting" in Launcher → renderer calls `window.electronAPI.startMeeting(metadata)`
2. IPC reaches `ipcHandlers.ts` → calls `AppState.startMeeting()`
3. AppState lazily initializes audio pipeline:
   - `SystemAudioCapture` captures system audio output
   - `MicrophoneCapture` captures microphone input
   - STT provider created per channel (`createSTTProvider('interviewer'|'user')`)
4. Audio chunks flow: Capture → `stt.write(chunk)` → STT emits `transcript` event
5. Transcript events → `IntelligenceManager.handleTranscript()` → LLM analysis
6. AI responses → `win.webContents.send()` → renderer updates UI
7. User clicks "End Meeting" → stops pipeline → saves to SQLite → processes RAG embeddings

### Audio Pipeline Architecture

```
SystemAudioCapture ──data──→ STT(interviewer) ──transcript──→ IntelligenceManager
                                  ↓                                   ↓
MicrophoneCapture  ──data──→ STT(user) ─────transcript──→   Renderer (IPC events)
                                  ↓
                           RAGManager.feedLiveTranscript()
```

**Dual-channel design:** System audio (interviewer) and microphone (user) are separate streams with independent STT instances. Each STT provider implements a common interface with `write(chunk)`, `start()`, `stop()`, `finalize()`, `notifySpeechEnded()`, and `setSampleRate()`.

**STT provider factory** (`createSTTProvider` in `electron/main.ts` lines 691-809):
- Reads provider preference from `CredentialsManager`
- Supports: Google STT, Deepgram, Soniox, ElevenLabs, OpenAI, Groq, Azure, IBM Watson
- Falls back to Google STT if configured provider's API key is missing
- Sample rates synced between capture source and STT provider on init/reconfigure

**Lazy initialization:** Audio pipeline is NOT created in the `AppState` constructor. It is initialized on first `startMeeting()` call via `setupSystemAudioPipeline()`. This prevents audio device enumeration from blocking app launch.

### LLM Flow

1. Transcript arrives at `IntelligenceManager`
2. Intent classification determines action (answer, follow-up, recap, etc.)
3. LLM call routed through `LLMHelper` → provider-specific client (Gemini, Claude, GPT, Groq, Ollama, custom)
4. Streaming responses sent via IPC events: `intelligence-suggested-answer-token`, etc.
5. Model fallback: primary → secondary → tertiary (configured in settings)

### RAG Flow

1. Live transcripts fed to `LiveRAGIndexer` during meetings (JIT indexing)
2. After meeting ends, full transcript processed by `RAGManager.processMeeting()`:
   - `SemanticChunker` splits transcript into semantic chunks
   - `EmbeddingPipeline` generates vector embeddings (OpenAI → Gemini → Ollama → local fallback)
   - `VectorStore` persists to SQLite with sqlite-vec extension
3. Queries route through `RAGRetriever` → vector similarity search → LLM synthesis

## IPC Communication Patterns

### Request/Response (invoke/handle)

All IPC handlers use the `safeHandle()` wrapper pattern defined in `electron/ipcHandlers.ts`:

```typescript
const safeHandle = (channel: string, listener: (...args) => Promise<any>) => {
  ipcMain.removeHandler(channel);  // Prevents duplicate handlers
  ipcMain.handle(channel, listener);
};
```

**Key handler categories:**
- Screenshot management: `take-screenshot`, `get-screenshots`, `delete-screenshot`
- Meeting lifecycle: `start-meeting`, `end-meeting`, `get-recent-meings`
- LLM management: `set-model`, `switch-to-ollama`, `switch-to-gemini`, `test-llm-connection`
- STT management: `set-stt-provider`, `test-stt-connection`, various API key setters
- Window management: `toggle-window`, `show-overlay`, `hide-overlay`, `set-window-mode`
- Settings: `set-undetectable`, `set-disguise`, `set-verbose-logging`
- RAG: `rag:query-meeting`, `rag:query-global`, `rag:get-queue-status`
- Premium: `license:activate`, `profile:upload-resume`, `profile:research-company`

### Event-Based (send/on)

Main → Renderer broadcast pattern via `BrowserWindow.getAllWindows().forEach(win => win.webContents.send(...))`:

- `screenshot-taken`, `screenshot-attached`, `capture-and-process`
- `intelligence-suggested-answer`, `intelligence-suggested-answer-token`, `intelligence-refined-answer-token`
- `native-audio-transcript`, `meeting-state-changed`
- `gemini-stream-token`, `gemini-stream-done`, `gemini-stream-error`
- `rag:stream-chunk`, `rag:stream-complete`, `rag:stream-error`
- `update-available`, `update-downloaded`, `download-progress`
- `undetectable-changed`, `disguise-changed`, `model-changed`
- `global-shortcut` — stealth dispatch: fires actions without focusing window

### Preload Bridge (`electron/preload.ts`)

`contextBridge.exposeInMainWorld('electronAPI', { ... })` exposes ~120+ typed methods. Each `ipcRenderer.invoke()` returns a Promise; each `ipcRenderer.on()` returns an unsubscribe function for cleanup in React `useEffect`.

## Singleton Patterns

### AppState (`electron/main.ts`)

```typescript
export class AppState {
  private static instance: AppState | null = null;
  public static getInstance(): AppState {
    if (!AppState.instance) AppState.instance = new AppState();
    return AppState.instance;
  }
}
```

Central hub for all main-process state. Holds references to:
- `WindowHelper`, `SettingsWindowHelper`, `ModelSelectorWindowHelper`, `CropperWindowHelper`
- `ScreenshotHelper`, `ProcessingHelper`, `IntelligenceManager`, `ThemeManager`
- `RAGManager`, `KnowledgeOrchestrator`
- Audio pipeline: `SystemAudioCapture`, `MicrophoneCapture`, `STTProvider` instances
- Meeting state (`isMeetingActive`), stealth state (`isUndetectable`, `disguiseMode`)

### Service Singletons

All use `getInstance()` pattern with `electron-store` persistence:

- **`CredentialsManager`** (`electron/services/CredentialsManager.ts`) — API key storage (Gemini, OpenAI, Claude, Groq, Deepgram, ElevenLabs, Azure, IBM Watson, Soniox, Tavily). Keys scrubbed from memory on quit.
- **`SettingsManager`** (`electron/services/SettingsManager.ts`) — App settings persistence (undetectable, disguise, verbose logging, STT provider, language). Uses `electron-store`.
- **`KeybindManager`** (`electron/services/KeybindManager.ts`) — Global shortcut registration and customization. Supports configurable accelerators per action.
- **`OllamaManager`** (`electron/services/OllamaManager.ts`) — Local Ollama process lifecycle (start/stop/restart). Auto-discovers and manages local LLM models.
- **`DatabaseManager`** (`electron/db/DatabaseManager.ts`) — SQLite with sqlite-vec. Singleton wraps `better-sqlite3` connection.
- **`ThemeManager`** (`electron/ThemeManager.ts`) — Light/dark/system theme mode management.
- **`RateLimiter`** (`electron/services/RateLimiter.ts`) — Token-bucket rate limiting for free-tier APIs.
- **`LicenseManager`** (`premium/electron/services/LicenseManager.ts`) — Premium license activation/validation.

## Window Architecture

### Multi-Window Design

Same React app (`src/App.tsx`) loaded in multiple BrowserWindows with different `?window=` query params:

| Window | URL Param | Purpose | Properties |
|--------|-----------|---------|------------|
| Launcher | `?window=launcher` | Home screen, meeting history, start meeting | Resizable, 1200x800, title bar, transparent |
| Overlay | `?window=overlay` | In-meeting AI assistant UI | Frameless, always-on-top, transparent, skip taskbar |
| Settings | `?window=settings` | Standalone settings window | Separate window, preloaded |
| ModelSelector | `?window=model-selector` | Quick model switch popup | Positioned near click |
| Cropper | `?window=cropper` | Screenshot region selector (Windows) | Frameless, fullscreen, lazy loaded |

**App.tsx routing logic** (`src/App.tsx` lines 29-36):
```typescript
const isSettingsWindow = new URLSearchParams(window.location.search).get('window') === 'settings';
const isOverlayWindow = new URLSearchParams(window.location.search).get('window') === 'overlay';
// ... conditionally renders Launcher, NativelyInterface, SettingsPopup, ModelSelectorWindow, or Cropper
```

### Window Mode Switching

`WindowHelper` manages two primary states: `launcher` and `overlay`.
- `switchToLauncher()` — shows launcher, hides overlay
- `switchToOverlay()` — hides launcher, shows overlay (always-on-top, frameless)
- `setWindowMode(mode, inactive)` — IPC-driven mode switch
- Window position tracked independently per mode

## Stealth Mode / Process Disguise

### Content Protection

When `isUndetectable = true`:
- `BrowserWindow.setContentProtection(true)` on all windows — prevents screen capture from seeing Natively
- On macOS: `app.dock.hide()` — removes from dock, makes app invisible to screen share
- Tray icon hidden
- Debounced toggling prevents dock show/hide race conditions

### Process Disguise (`_applyDisguise` in `electron/main.ts` lines 1860-2009)

Three disguise modes + none:
- **Terminal** — app name: "Terminal " / "Command Prompt ", fake terminal icon
- **Settings** — app name: "System Settings " / "Settings ", fake settings icon
- **Activity** — app name: "Activity Monitor " / "Task Manager ", fake activity icon
- **None** — normal "Natively" name and icon

Disguise applied via:
1. `process.title` — affects Activity Monitor / Task Manager display
2. `app.setName()` — affects macOS menu bar (skipped when undetectable to prevent dock re-registration)
3. `app.setAppUserModelId()` — Windows taskbar grouping (unique AUMID per disguise)
4. Icon swap on all windows — fake icons in `assets/fakeicon/{mac,win}/`
5. Periodic `process.title` re-assertion (200ms, 1s, 5s) to prevent OS from reverting

## Premium Module Loading Strategy

### Conditional Loading Pattern

Premium modules are loaded via `require()` with try/catch fallback. If the `premium/` directory is absent, the app works without premium features:

```typescript
// electron/main.ts lines 113-120
let KnowledgeOrchestratorClass: any = null;
let KnowledgeDatabaseManagerClass: any = null;
try {
    KnowledgeOrchestratorClass = require('../premium/electron/knowledge/KnowledgeOrchestrator').KnowledgeOrchestrator;
    KnowledgeDatabaseManagerClass = require('../premium/electron/knowledge/KnowledgeDatabaseManager').KnowledgeDatabaseManager;
} catch {
    console.log('[Main] Knowledge modules not available — profile intelligence disabled.');
}
```

### Premium Electron Modules (`premium/electron/`)

- `knowledge/KnowledgeOrchestrator.ts` — Profile intelligence, company research, negotiation coaching
- `knowledge/KnowledgeDatabaseManager.ts` — Separate DB tables for knowledge data
- `knowledge/` — 20+ specialized engines (company research, salary intelligence, gap analysis, mock interviews, STAR stories, culture mapping, etc.)
- `services/LicenseManager.ts` — License activation with hardware ID binding

### Premium Renderer Modules (`premium/src/`)

Exported via barrel file and imported in `src/App.tsx`:
- `PremiumUpgradeModal.tsx`, `PremiumPromoToaster.tsx`
- `ProfileFeatureToaster.tsx`, `ProfileVisualizer.tsx`
- `JDAwarenessToaster.tsx`, `NegotiationCoachingCard.tsx`
- `RemoteCampaignToaster.tsx`, `useAdCampaigns.ts`

These are optional UI components for premium upsells and features. The renderer imports them from `./premium` (an index/barrel), which must exist for the build to succeed.

## Error Handling

**Strategy:** Defensive with graceful degradation

**Main process:**
- `process.on('uncaughtException')` and `process.on('unhandledRejection')` — log to file, prevent crash
- `console.log/warn/error` overridden to write to `natively_debug.log` in addition to stdout
- IPC handlers wrapped in try/catch, returning `{ success: false, error }` objects
- Audio pipeline failures broadcast `meeting-audio-error` to renderer
- STT provider fallback chain: configured provider → Google STT

**Renderer:**
- `ErrorBoundary` component wraps each window type
- IPC call failures handled via returned `{ success: boolean, error?: string }` pattern

## Cross-Cutting Concerns

**Logging:** Custom file logging to `~/Documents/natively_debug.log`. `console.*` overridden globally in `electron/main.ts` lines 24-80. Verbose logging toggle via settings.

**Validation:** Input path validation on IPC handlers (e.g., `delete-screenshot` restricts to `userData` directory). API key sanitization on error messages.

**Authentication:** No user accounts. API keys stored in `electron-store` via `CredentialsManager`. Keys scrubbed from memory on app quit.

**State Persistence:** `electron-store` for settings and credentials. SQLite for meetings, transcripts, and RAG embeddings.

---

*Architecture analysis: 2026-03-22*
