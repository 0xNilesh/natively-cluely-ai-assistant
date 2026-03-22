# Coding Conventions

**Analysis Date:** 2026-03-22

## TypeScript Configuration (Dual tsconfig Approach)

This project uses **two separate TypeScript configurations** with different module systems:

**Root tsconfig (`tsconfig.json`) — React renderer:**
- Target: `ESNext`
- Module: `ESNext` with `bundler` module resolution
- JSX: `react-jsx`
- `strict: true`, `noUnusedParameters: true`, `noUnusedLocals: false`
- Includes: `src/`, `premium/src/`
- No emit (Vite handles building)

**Electron tsconfig (`electron/tsconfig.json`) — Main process:**
- Target: `ESNext`
- Module: `CommonJS` with `node` module resolution
- `esModuleInterop: true`, `noImplicitAny: true`
- Output: `../dist-electron`
- Includes: `electron/**/*.ts`, `premium/electron/**/*.ts`

**When adding new code:**
- Renderer code (`src/`) uses ES modules — use `import`/`export`
- Electron code (`electron/`) compiles to CommonJS — still write with `import`/`export` syntax (TypeScript compiles it down)

## Path Aliases

**`@/` alias:**
- Defined in `vite.config.mts` line 15: `"@": path.resolve(__dirname, "./src")`
- Only available in renderer code (`src/`), NOT in `electron/`
- Usage: `import { cn } from "@/lib/utils"`

**Electron code has NO path aliases** — use relative imports:
```typescript
import { AppState } from "./main"
import { CredentialsManager } from "./services/CredentialsManager"
import { DatabaseManager } from "./db/DatabaseManager"
```

## IPC Handler Patterns

**ALWAYS use `safeHandle()` wrapper** — never call `ipcMain.handle()` directly.

The `safeHandle` function is defined in `electron/ipcHandlers.ts` line 14:
```typescript
const safeHandle = (channel: string, listener: (event: any, ...args: any[]) => Promise<any> | any) => {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
};
```

This prevents duplicate handler registration errors during hot reload or re-initialization.

**Channel naming convention:** kebab-case or colon-separated:
- `"test-release-fetch"` — kebab-case for general actions
- `"license:activate"` — colon-separated for namespaced actions
- `"set-ai-response-language"` — kebab-case for settings
- `"get-recognition-languages"` — kebab-case for getters

**IPC handler structure:**
```typescript
safeHandle("channel-name", async (event, arg1: Type1, arg2: Type2) => {
  try {
    // ... handler logic
    return { success: true, data: result };
  } catch (err: any) {
    console.error('[IPC] channel-name failed:', err);
    return { success: false, error: err.message };
  }
});
```

**Preload bridge:** `electron/preload.ts` exposes `window.electronAPI` via `contextBridge.exposeInMainWorld`. All renderer-to-main communication goes through typed `electronAPI` methods.

## State Management

**Main process (Electron):**
- `AppState` singleton in `electron/main.ts` — centralizes all app state and window/helpers
- Manager singletons with `getInstance()`: `SettingsManager`, `CredentialsManager`, `KeybindManager`, `OllamaManager`, `ThemeManager`, `ReleaseNotesManager`
- Pattern: `private static instance: ClassName; public static getInstance(): ClassName`

**Renderer (React):**
- React Query (`QueryClient`) for server/async state
- `useState` + `useRef` for component state
- `localStorage` for UI persistence (opacity, transcript visibility, device preferences)
- `useRef` pattern for avoiding stale closures in async callbacks (e.g., `isRecordingRef`, `manualTranscriptRef`)

**IPC state sync:**
- Main → Renderer: `webContents.send(channel, data)` → renderer listens via `window.electronAPI.on*` callbacks
- Cleanup: IPC listeners return removal functions; collect in `useEffect` cleanup array

## Error Handling

**Main process:**
- Global: `process.on('uncaughtException')` and `process.on('unhandledRejection')` in `electron/main.ts` — log to file, never crash
- Per-handler: try/catch blocks returning `{ success: false, error: message }`
- Logging: All `console.log/warn/error` calls are intercepted and written to `natively_debug.log` in user's Documents folder

**Renderer:**
- `ErrorBoundary` component (`src/components/ErrorBoundary.tsx`) wraps each window type
- Provides "Try to recover" (state reset) and "Reload UI" (hard reload) buttons
- Reports errors to main process via `window.electronAPI.logErrorToMain`

**Premium module loading:**
```typescript
try {
    const { LicenseManager } = require('../premium/electron/services/LicenseManager');
    // use LicenseManager
} catch {
    // Graceful fallback — premium not available
    return { success: false, error: 'Premium features not available in this build.' };
}
```

## Naming Conventions

**Files:**
- PascalCase for classes/components: `AppState.ts`, `NativelyInterface.tsx`, `CredentialsManager.ts`
- camelCase for utilities: `curlUtils.ts`, `keyboardUtils.ts`, `verboseLog.ts`
- Hooks: `use` prefix + PascalCase: `useShortcuts.ts`, `useStreamBuffer.ts`

**Classes:**
- PascalCase: `AppState`, `ProcessingHelper`, `DatabaseManager`
- Singleton pattern: `getInstance()` static method

**Functions:**
- camelCase: `getMainWindow()`, `startMeeting()`, `toggleMainWindow()`
- IPC channels: kebab-case strings: `"start-meeting"`, `"get-screenshots"`

**Variables:**
- camelCase: `isUndetectable`, `processingHelper`, `currentProcessingAbortController`
- Private members: underscore prefix: `_isQuitting`, `_verboseLogging`, `_ollamaBootstrapPromise`
- Constants: UPPER_SNAKE_CASE: `MOCK_API_WAIT_TIME`, `OVERLAY_OPACITY_DEFAULT`

**Types/Interfaces:**
- PascalCase: `AppSettings`, `StoredCredentials`, `ShortcutConfig`, `Message`

**Components (React):**
- PascalCase: `NativelyInterface`, `SettingsOverlay`, `ErrorBoundary`
- Props interfaces: defined at top of file, same name or `ComponentNameProps`

## Code Style

**Formatting:**
- No `.eslintrc` or `.prettierrc` detected — no enforced formatter
- Consistent style observed: 2-space indentation, single quotes in electron/, double quotes in src/
- Semicolons used inconsistently (mostly present)

**Import order (observed):**
1. Electron/Node builtins: `import { app, BrowserWindow } from "electron"`, `import path from "path"`
2. External packages: `import { motion } from "framer-motion"`
3. Internal modules: `import { AppState } from "./main"`

**CSS/Styling:**
- Tailwind CSS with custom semantic tokens: `text-text-primary`, `bg-bg-sidebar`, `border-border-subtle`
- `cn()` utility in `src/lib/utils.ts` for class merging (filter + join)
- CSS custom properties for theming: `data-theme` attribute on `<html>`

**Premium loading pattern:**
```typescript
import { PremiumComponent } from './premium'; // barrel export with fallbacks
// OR in electron:
try {
  const { PremiumModule } = require('../premium/electron/...');
} catch { /* graceful fallback */ }
```

## Anti-PATTERNS (Do NOT Do These)

1. **DO NOT** use `ipcMain.handle()` directly — always use `safeHandle()` wrapper
2. **DO NOT** modify `dist-electron/` — it is compiled output
3. **DO NOT** put business logic in renderer — main process only
4. **NEVER** commit API keys — use `.env` and `CredentialsManager`
5. **NEVER** modify `renderer/` package.json — legacy CRA project, not actively used
6. **DO NOT** use `@/` path alias in electron code — relative imports only
7. **DO NOT** forget IPC listener cleanup in React `useEffect` — causes memory leaks

---

*Convention analysis: 2026-03-22*
