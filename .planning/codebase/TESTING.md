# Testing Patterns

**Analysis Date:** 2026-03-22

## Test Framework

**No formal test framework is configured in this project.**

- No `jest.config.*` found
- No `vitest.config.*` found
- No `.eslintrc` (linting not configured)
- No `.prettierrc` (formatting not configured)

**package.json dependencies related to testing:**
- `tap` (^21.5.0) — listed in `dependencies` (not devDependencies), not used in any scripts
- `@testing-library/react` — NOT installed (causes errors in `renderer/src/App.test.tsx`)

**Run commands (from package.json):**
```bash
npm start           # Dev: Vite + Electron
npm run app:build   # Build: Vite + TypeScript + electron-builder
npm run dist        # Dist: Full distribution build
npm run clean       # Clean: Remove dist/ dist-electron/
```

No test script exists in `package.json`.

## Test File Organization

**Existing test files (ad-hoc, not framework-integrated):**

| File | Purpose | Status |
|------|---------|--------|
| `renderer/src/App.test.tsx` | Legacy CRA boilerplate test | Broken — missing `@testing-library/react` |
| `electron/db/test-db.ts` | Database verification script | Stub — requires electron context, never runs |
| `test-vec.js` | sqlite-vec extension test | Ad-hoc script — manual verification of vector DB |
| `test-worker.js` | Native module worker thread test | Ad-hoc script — tests natively-audio loading |
| `electron/__tests__/` | Empty directory | Placeholder — no tests written |

**Naming patterns observed:**
- Test scripts: `test-*.js` at project root (ad-hoc, not discoverable)
- Test files: `*.test.tsx` in legacy renderer (CRA pattern)
- Test directory: `electron/__tests__/` exists but empty

## Coverage

A `coverage/` directory exists at project root containing:
- `coverage-final.json` — Istanbul coverage data
- `lcov.info` — LCOV format coverage report
- `lcov-report/` — HTML coverage report
- `electron/` — Electron-specific coverage breakdown

**Coverage data covers these modules (from coverage-final.json):**
- `electron/SessionTracker.ts`
- `electron/ThemeManager.ts`
- `electron/audio/` — AudioConfig, BaseSTTProvider, STTProviderFactory, provider implementations
- `electron/config/` — ConfigService, languages
- `electron/core/` — ServiceContainer
- `electron/db/` — DatabaseManager
- `electron/errors/` — ErrorHandler
- `electron/ipc/` — audio, license, llm, meeting, rag, settings, update, validation, window handlers
- `electron/llm/` — LLMProviderFactory, PromptBuilder

**How coverage was generated:** Unknown — no coverage script in package.json. Likely generated manually with Istanbul/nyc or a one-off run.

## Ad-Hoc Testing Scripts

**test-vec.js** — Tests sqlite-vec extension loading:
```javascript
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const db = new Database(':memory:');
db.loadExtension(sqliteVec.getLoadablePath().replace(/\.(dylib|so|dll)$/, ''));
// Verifies float and float[] vector column types work
```

**test-worker.js** — Tests native audio module loading in worker thread:
```javascript
const { Worker, isMainThread, parentPort } = require('worker_threads');
// Verifies natively-audio native module loads without crashing in worker
```

**electron/db/test-db.ts** — Stub for database verification:
```typescript
// Requires electron context — cannot run standalone
// Documents that manual verification via running the app is the current approach
```

## Manual Testing Approach

The project relies on manual testing by running the app:

```bash
npm run app:dev     # Start dev environment (Vite + Electron)
npm run electron:dev # Start Electron only (assumes Vite running)
```

**Verification workflow:**
1. Run `npm run app:dev` to start both Vite dev server and Electron
2. Test features manually in the app window
3. Check `natively_debug.log` in user's Documents folder for errors

## E2E Testing

**Not used.** No E2E testing framework (Playwright, Spectron, etc.) is configured.

## Test Utilities and Helpers

**No test utilities exist.** The following patterns would need to be established:

- No mock utilities for electron APIs
- No test fixtures or factories
- No shared test setup/teardown
- No test database seeding scripts (beyond the stub `test-db.ts`)

## What IS Tested (via coverage data)

The coverage data suggests some form of automated testing was run for:

**Electron IPC handlers** (`electron/ipc/`):
- audio.handlers.ts
- license.handlers.ts
- llm.handlers.ts
- meeting.handlers.ts
- rag.handlers.ts
- settings.handlers.ts
- update.handlers.ts
- validation.ts
- window.handlers.ts

**Core services:**
- DatabaseManager, ServiceContainer, ConfigService
- STT providers (Google, Deepgram, Rest, Soniox)
- LLM provider factory, PromptBuilder
- ErrorHandler, ThemeManager, SessionTracker

**However:** No corresponding test files exist in the repository. The coverage data appears to be from a prior, possibly external or temporary testing session.

## Testing Gaps

**Critical untested areas:**
- React components (no component tests exist)
- Custom hooks (`useShortcuts`, `useStreamBuffer`, `useResolvedTheme`)
- AppState singleton behavior
- ProcessingHelper workflow
- RAG/vector search operations
- Audio pipeline initialization and STT provider switching
- Premium module loading and fallback behavior
- IPC handler error paths
- Settings persistence (atomic write via tmp file)
- Window management and stealth mode

## Recommendations for Adding Tests

**If setting up testing from scratch:**

1. **Framework choice:** Vitest (natural fit with Vite config already present)
2. **Config:** Create `vitest.config.mts` extending vite config
3. **Location:** Place tests alongside source or in `__tests__/` directories
4. **Naming:** `*.test.ts` / `*.test.tsx`
5. **IPC mocking:** Create `window.electronAPI` mock for renderer tests
6. **Electron mocking:** Mock `electron` module for unit testing main process code
7. **Coverage:** Use Vitest's built-in coverage (v8 or istanbul)

---

*Testing analysis: 2026-03-22*
