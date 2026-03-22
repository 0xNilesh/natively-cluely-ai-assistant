# Codebase Concerns

**Analysis Date:** 2026-03-22

## Tech Debt

### 1. Massive LLMHelper God Class (2,948 lines)
- **Issue:** `electron/LLMHelper.ts` handles ALL LLM provider logic — Gemini, Groq, OpenAI, Claude, Ollama, custom/curl providers, vision analysis, streaming, model rotation — in a single 2,948-line class.
- **Files:** `electron/LLMHelper.ts`
- **Impact:** Extreme coupling, difficult to test, error-prone modifications. Adding a new provider means touching this monolithic file.
- **Fix approach:** Extract each provider into its own class implementing a common `LLMProvider` interface. Move vision/model rotation into separate modules. The newer `electron/llm/` directory has started this (AnswerLLM, RecapLLM, etc.) but the old LLMHelper remains the primary entry point.

### 2. AppState Singleton — 2,191 Lines, 103 Members
- **Issue:** `electron/main.ts` `AppState` class contains 103+ public/private members. It owns window management, audio pipeline, tray, disguise mode, view state, screenshot coordination, meeting lifecycle, and more.
- **Files:** `electron/main.ts`
- **Impact:** Any change to app state risks breaking unrelated functionality. Hard to reason about state transitions.
- **Fix approach:** Extract subsystem managers (WindowSubsystem, AudioSubsystem, MeetingLifecycle, StealthMode) that receive AppState reference but own their own logic.

### 3. ipcHandlers.ts — 2,218 Lines, 109 `any` Types
- **Issue:** `electron/ipcHandlers.ts` has 2,218 lines with 109 uses of the `any` type. The `safeHandle` wrapper parameter type is `(event: any, ...args: any[])`, defeating TypeScript safety entirely.
- **Files:** `electron/ipcHandlers.ts`
- **Impact:** No compile-time safety on IPC handler arguments. Runtime errors only surface when a handler receives unexpected data.
- **Fix approach:** Define typed IPC channel map, type `safeHandle` generics, split handlers into domain-specific modules.

### 4. Legacy renderer/ Directory
- **Issue:** `renderer/` contains a full CRA (Create React App) project with its own `package.json`, `tsconfig.json`, and test setup. AGENTS.md says it's "NOT used" but it's committed and adds confusion.
- **Files:** `renderer/` (entire directory)
- **Impact:** Confusing for contributors. npm install may install duplicate dependencies. Increases repository size.
- **Fix approach:** Remove `renderer/` from the repository or move to an `archive/` branch.

## Security Considerations

### 1. webSecurity Disabled in Development
- **Issue:** `electron/WindowHelper.ts:139` sets `webSecurity: !isDev` — disabled in dev mode. While noted as DEBUG, this is a common forgetting-to-re-enable scenario.
- **Files:** `electron/WindowHelper.ts`
- **Risk:** If `NODE_ENV` is accidentally set to "development" in production, web security is disabled, allowing cross-origin requests from the renderer.
- **Recommendation:** Always keep `webSecurity: true`. Use `webPreferences.allowRunningInsecureContent` with explicit localhost origin if needed.

### 2. Curl Command Execution via User Input
- **Issue:** `electron/LLMHelper.ts` uses `@bany/curl-to-json` to parse user-provided curl commands (`CustomProvider.curlCommand`, `CurlProvider.curlCommand`). These are stored in `CredentialsManager` and used to construct HTTP requests.
- **Files:** `electron/LLMHelper.ts`, `electron/services/CredentialsManager.ts`
- **Risk:** While curl commands are parsed to JSON (not shell-executed), the parsed values (URL, headers, body) are used directly in `fetch()` calls. A malicious curl command could target internal network services.
- **Recommendation:** Validate parsed URL against a whitelist or require explicit user confirmation for non-standard domains.

### 3. Stealth Mode — Process Disguise
- **Issue:** The app disguises itself as Terminal/Settings/Activity Monitor via `app.setName()`. `electron/main.ts` coordinates `setContentProtection(true)`, dock hiding, and process name changes.
- **Files:** `electron/main.ts`, `electron/WindowHelper.ts`, `electron/CropperWindowHelper.ts`
- **Risk:** macOS and Windows security tools (EDR, Screen Recording detection) may flag this behavior. The `skipTaskbar: true` + `setContentProtection` combination is used by screen-sharing malware.
- **Recommendation:** Document this clearly in privacy policy. Consider requiring explicit user opt-in with clear explanation.

### 4. Unbounded Debug Log File
- **Issue:** `electron/main.ts:30` appends to `natively_debug.log` via `fs.appendFileSync()` with no rotation or size limit. Every `console.log/warn/error` is mirrored to this file.
- **Files:** `electron/main.ts`
- **Risk:** Log file grows indefinitely. Could fill disk on long-running machines. May contain sensitive data (API responses, transcript content).
- **Recommendation:** Implement log rotation (max size, compress old logs). Add option to disable file logging.

### 5. API Keys in Memory
- **Issue:** `electron/LLMHelper.ts` stores API keys as instance properties (`this.apiKey`, `this.groqApiKey`, etc.) in plain strings. While `CredentialsManager` encrypts at rest via `safeStorage`, keys are held in memory for the app lifetime.
- **Files:** `electron/LLMHelper.ts`, `electron/services/CredentialsManager.ts`
- **Risk:** Memory dumps would expose API keys. Low risk for desktop app but worth noting.
- **Recommendation:** Acceptable for desktop app. Document the trade-off.

### 6. No Sandbox Flag
- **Issue:** No `sandbox: true` in any `BrowserWindow` webPreferences. Electron's sandboxing is not enabled.
- **Files:** `electron/WindowHelper.ts`, `electron/CropperWindowHelper.ts`, `electron/SettingsWindowHelper.ts`, `electron/ModelSelectorWindowHelper.ts`
- **Risk:** Renderer process has full Node.js access via preload. If XSS occurs, attacker gains full system access.
- **Recommendation:** Consider enabling `sandbox: true` in webPreferences. All Node.js access should go through preload contextBridge only.

## Platform-Specific Issues

### 1. Hardcoded Windows Icon Paths
- **Issue:** `electron/WindowHelper.ts` and `electron/CropperWindowHelper.ts` contain platform-specific icon path resolution with hardcoded directory names (`assets/icons/win/icon.ico`, `assets/fakeicon/`).
- **Files:** `electron/WindowHelper.ts:153-183`, `electron/CropperWindowHelper.ts`
- **Impact:** Adding a new disguise mode or changing icon structure requires modifying multiple files. Path resolution from `__dirname` is fragile (depends on build output structure).

### 2. macOS-Specific Dock Logic
- **Issue:** `electron/main.ts` has extensive macOS-specific dock management (`app.dock.hide()`, `app.dock.show()`) with debounce timers and re-assert logic. This logic doesn't apply to Windows/Linux.
- **Files:** `electron/main.ts:1777-1850`
- **Impact:** Stealth mode behavior is inconsistent across platforms. Windows uses `skipTaskbar` while macOS uses dock hiding — different detection surfaces.

### 3. Windows Multi-Monitor Cropper
- **Issue:** `electron/CpperWindowHelper.ts:421-438` has Windows-specific `enableLargerThanScreen` workaround for multi-monitor support.
- **Files:** `electron/CropperWindowHelper.ts`
- **Impact:** Complex platform branching in window creation. `enableLargerThanScreen` is a non-standard Electron property cast via `(windowSettings as any)`.

### 4. Native Module Platform Dependencies
- **Issue:** `natively-audio` (Rust native module) is only listed for `darwin-arm64` and `darwin-x64` in optional dependencies. No Windows equivalent in `package.json`.
- **Files:** `package.json:223-227`
- **Impact:** System audio capture may not work on Windows without additional build steps.

## Performance Concerns

### 1. Synchronous File Logging
- **Issue:** `electron/main.ts:30` uses `fs.appendFileSync()` for every log message. This blocks the event loop.
- **Files:** `electron/main.ts`
- **Impact:** Under heavy logging (e.g., during audio streaming), this could cause UI stutter and audio glitches.
- **Fix approach:** Use async `fs.appendFile()` or a buffered write stream.

### 2. RateLimiter Timer Leak
- **Issue:** `electron/services/RateLimiter.ts:25` creates `setInterval(…, 1000)` per instance. `createProviderRateLimiters()` creates 4 instances (groq, gemini, openai, claude). These timers run for the app lifetime.
- **Files:** `electron/services/RateLimiter.ts`
- **Impact:** 4 timer ticks per second even when no API calls are being made. Minor but unnecessary CPU usage.
- **Fix approach:** Only start refill timer when there are waiters, or use a single shared timer.

### 3. SQLite Vector Search Fallback
- **Issue:** `electron/db/DatabaseManager.ts:97-99` falls back to JavaScript cosine similarity if sqlite-vec fails to load. No warning to user about degraded performance.
- **Files:** `electron/db/DatabaseManager.ts`
- **Impact:** RAG search could be 10-100x slower without native vector search.
- **Fix approach:** Surface a user-visible warning. Log the fallback prominently.

### 4. Large Screenshot Processing
- **Issue:** `electron/ScreenshotHelper.ts` (755 lines) handles screenshot capture and processing. Screenshots are taken at full resolution, then processed with `sharp`.
- **Files:** `electron/ScreenshotHelper.ts`
- **Impact:** On high-DPI displays (4K, Retina), screenshot files are large. Processing pipeline could cause memory pressure.

## Scaling & Maintenance Challenges

### 1. Premium Module Loading Pattern
- **Issue:** Premium features use `require('../premium/electron/...')` wrapped in try/catch blocks. This pattern is repeated ~20 times across `electron/ipcHandlers.ts` and `electron/main.ts`.
- **Files:** `electron/ipcHandlers.ts`, `electron/main.ts`, `electron/premium/featureGate.ts`
- **Impact:** If premium module API changes, every require site must be updated. The `any` types on loaded modules eliminate type safety.
- **Fix approach:** Centralize premium module loading through `featureGate.ts`. Return typed interfaces, not raw require results.

### 2. No Test Suite
- **Issue:** No test files exist for the electron/ directory. The only test is `renderer/src/App.test.tsx` (legacy CRA boilerplate). Zero test coverage for all business logic.
- **Files:** `electron/` (entire directory — no tests)
- **Impact:** Every change is a regression risk. Audio pipeline, LLM integration, database migrations, IPC handlers — all untested.
- **Fix approach:** Start with unit tests for pure functions (model rotation, transcript parsing, database queries). Use Electron's `mock-require` for integration tests.

### 3. Database Migration Fragility
- **Issue:** `electron/db/DatabaseManager.ts` has 10+ migration versions using `if (version < N)` blocks. Some migrations use `try { this.db.exec(sql); } catch (e) { /* Column already exists */ }` to handle idempotency.
- **Files:** `electron/db/DatabaseManager.ts:116-570`
- **Impact:** Migration failures are silently caught. If a migration partially applies (e.g., creates table but not index), the schema could be inconsistent.
- **Fix approach:** Wrap each migration version in a transaction. Add migration validation queries post-apply.

### 4. Dependency on Deprecated/Unmaintained Packages
- **Issue:**
  - `keytar` (v7.9.0) — deprecated in favor of Electron's `safeStorage`. Still in dependencies but not imported in source (dead dependency).
  - `react-query` v3 (v3.39.3) — two major versions behind (current is v5/TanStack Query).
  - `@types/electron` (v1.4.38) — deprecated; Electron ships its own types.
  - `@types/keytar` (v4.4.0) — dead dependency.
- **Files:** `package.json`
- **Fix approach:** Remove `keytar`, `@types/keytar`, `@types/electron`. Migrate to TanStack Query v5.

### 5. `@ts-ignore` and `as any` Escape Hatches
- **Issue:** Multiple `@ts-ignore` comments and `as any` casts, particularly in streaming code (`electron/LLMHelper.ts:2293`, `electron/CropperWindowHelper.ts:422`).
- **Files:** `electron/LLMHelper.ts`, `electron/CropperWindowHelper.ts`
- **Impact:** Type errors are silenced rather than fixed. Future refactors may break at runtime.

## Missing Critical Features

### 1. No Graceful Shutdown / Cleanup
- **Issue:** No explicit cleanup of: RateLimiter timers, WebSocket connections (STT providers), SQLite database connections, native audio monitors, worker threads.
- **Files:** `electron/main.ts`, `electron/services/RateLimiter.ts`, `electron/rag/VectorStore.ts`
- **Risk:** Resource leaks on app quit. Potential data corruption if SQLite writes are interrupted.

### 2. No Error Boundary in React
- **Issue:** No React error boundaries found in `src/components/`. An unhandled render error crashes the entire renderer.
- **Files:** `src/components/` (all files)
- **Risk:** White screen of death if any component throws.

### 3. No Offline Degradation
- **Issue:** No graceful handling when network is unavailable. LLM and STT calls fail silently or show generic errors.
- **Files:** `electron/LLMHelper.ts`, `electron/audio/*`
- **Risk:** App appears broken when offline. No user-facing indication of network status.

---

*Concerns audit: 2026-03-22*
