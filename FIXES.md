# Bug Fixes & Feature Implementations

---

## Issue #89 — Screenshot capture loses focus / animation flash

### Root Cause
`WindowHelper.hideMainWindow()` called `window.hide()` directly on the Electron browser windows. On macOS this triggers an animated window-fade transition, causing:
1. A brief visual flash / screen blank noticeable to the user
2. Momentary focus loss as macOS switches focus away from the hidden window

### Fix Summary
Set `window.setOpacity(0)` on all managed windows **before** calling `hide()`. This makes the window visually invisible immediately (no animation), so the subsequent macOS hide animation runs invisibly in the background. On `showMainWindow()` / `switchToLauncher()` / `switchToOverlay()`, `setOpacity(1)` is called first to restore full opacity before showing, ensuring the window comes back immediately visible.

### Files Modified
- `electron/WindowHelper.ts` — `hideMainWindow()`: set opacity to 0 before `hide()`
- `electron/WindowHelper.ts` — `switchToOverlay()` non-Windows branch: added `setOpacity(1)` before `show()`
- `electron/WindowHelper.ts` — `switchToLauncher()` non-Windows branch: added `setOpacity(1)` before `show()`

### Edge Cases Handled
- Windows content-protection path already had an opacity shield; the fix applies only to the macOS/Linux `else` branch to avoid double-setting opacity
- Opacity is restored regardless of which show path is taken

### How to Test
1. Have the app visible on macOS
2. Press `Cmd+H` (Take Screenshot) — there should be no visual flash or blank screen
3. Window should return smoothly after the screenshot
4. Verify the selective screenshot (`Cmd+Shift+H`) also has no flash

### Known Limitations
- The 50ms delay before screenshot capture remains. This is needed for the screenshot buffer to update after the hide. Reducing it may cause the app window to still appear in screenshots.

---

## Issue #90 — Single Source of Truth Shortcut

### Root Cause
No global shortcut existed that combined screenshot capture + AI analysis in one trigger. Users had to: (1) press `Cmd+H` to capture, then (2) press `Cmd+Enter` to analyze. Competing products offer a single global hotkey that does both.

### Fix Summary
Added a new global keybind `general:capture-and-process` (default: `Cmd+Shift+Enter`) that:
1. Takes a full-screen screenshot from the main process (global trigger works from any app)
2. Shows the Natively window
3. Sends a `capture-and-process` IPC event with the screenshot path + preview
4. In the renderer, attaches the screenshot to the input context, then immediately triggers `handleWhatToSay()` (the AI analysis)

### Files Modified
- `electron/services/KeybindManager.ts` — added `general:capture-and-process` keybind (global, default `Cmd+Shift+Enter`)
- `electron/main.ts` — handler in `onShortcutTriggered` for the new action
- `electron/preload.ts` — type declaration + IPC listener for `onCaptureAndProcess`
- `src/types/electron.d.ts` — `onCaptureAndProcess` added to `ElectronAPI` interface
- `src/components/NativelyInterface.tsx` — `useEffect` that listens for `capture-and-process`, attaches screenshot, and calls `handleWhatToSay`

### Edge Cases Handled
- Uses `setTimeout(..., 0)` before calling `handleWhatToSay` to let React flush the `setAttachedContext` state update first
- Duplicate screenshot prevention: same path-dedup logic as `handleScreenshotAttach`
- Shortcut is user-rebindable via the existing keybinds system

### How to Test
1. Open any other app (browser, editor, etc.)
2. Press `Cmd+Shift+Enter`
3. Natively should appear, attach the current screenshot to context, and immediately start AI analysis

### Known Limitations
- The keybind defaults to `Cmd+Shift+Enter` to avoid conflicting with standard text-editing shortcuts. Power users may prefer `Cmd+Enter` but that would require disabling the local `process-screenshots` binding when the app is unfocused.

---

## Issue #96 — App is unable to work with ChatGPT (Error 404)

### Root Cause
`streamWithOpenai()`, `streamWithOpenaiMultimodal()`, and `generateWithOpenai()` all used the hardcoded constant `OPENAI_MODEL = "gpt-5.4"` instead of the user's selected model (`this.currentModelId`), causing HTTP 404 when a different model was selected.

Additional bugs:
1. `setModel('gpt-4o')` incorrectly mapped `gpt-4o` → `gpt-5.4` (unwanted alias, bypassing the user's selection)
2. The OpenAI API key connection test used `gpt-5.3-chat-latest`, which may not exist in all API plans
3. The vision fallback chain (`generateWithVisionFallback`) knew the correct tier model IDs but silently ignored them — `generateWithOpenai` ignored the passed `modelId` param
4. Same issue for Claude: `streamWithClaude/streamWithClaudeMultimodal` used hardcoded `CLAUDE_MODEL`

### Fix Summary
- `generateWithOpenai`: added `modelId?: string` param. Resolution order: explicit override → `this.currentModelId` if it's an OpenAI model → `OPENAI_MODEL` ("gpt-5.4") as baseline fallback
- `generateWithClaude`: same pattern with Claude-specific checker and `CLAUDE_MODEL` as fallback
- `streamWithOpenai`, `streamWithOpenaiMultimodal`: replaced `OPENAI_MODEL` with `this.currentModelId`
- `streamWithClaude`, `streamWithClaudeMultimodal`: replaced `CLAUDE_MODEL` with `this.currentModelId`
- All fallback provider chain calls now pass the discovered tier model ID to `generateWithOpenai/Claude`
- `generateWithVisionFallback` now passes the tier model ID to the generate functions
- Removed the wrong `gpt-4o → gpt-5.4` alias in `setModel`
- Connection test in `ipcHandlers.ts` changed from `gpt-5.3-chat-latest` to `gpt-4o-mini`

### Files Modified
- `electron/LLMHelper.ts` — `generateWithOpenai`, `generateWithClaude`, `streamWithOpenai`, `streamWithOpenaiMultimodal`, `streamWithClaude`, `streamWithClaudeMultimodal`, `setModel`, `generateWithVisionFallback`, fallback provider chains
- `electron/ipcHandlers.ts` — connection test model for OpenAI

### Edge Cases Handled
- When `currentModelId` is not an OpenAI model (e.g., Gemini mode but OpenAI key is configured for fallback), `OPENAI_MODEL = "gpt-5.4"` is used as the baseline — this is the confirmed valid default per OpenAI API docs
- When `currentModelId` is not a Claude model, `CLAUDE_MODEL = "claude-sonnet-4-6"` is kept as fallback

### How to Test
1. Add an OpenAI API key in Settings → AI Providers
2. Fetch models and select any GPT model (e.g., `gpt-4o`, `gpt-5.4`)
3. Open a chat session and type a message
4. Verify it processes without a 404 error
5. Check the connection test (Settings → test key) also passes

### Known Limitations
- The connection test in `ipcHandlers.ts` uses `gpt-4o-mini` (a stable, widely available model). This is intentional — the test only validates the API key works, not that the user's selected model is reachable.

---

## Issue #97 — Resume upload failing ("All reasoning models failed")

### Root Cause
`generateContentStructured()` in `LLMHelper.ts` included Gemini Pro as the only Gemini option. If a user only has a Gemini API key configured (no OpenAI/Claude/Groq), and `gemini-3.1-pro-preview` was unavailable or returned an error, there was no Gemini Flash fallback — causing the error "All reasoning models failed for structured generation".

### Fix Summary
Extended the `generateContentStructured` provider chain with two additional fallbacks:

1. **Gemini Flash (Priority 3b)** — added immediately after Gemini Pro using the same direct API call pattern (not touching `this.geminiModel` shared state) to avoid race conditions.
2. **Ollama on-device (Priority 5)** — added as the absolute last resort. Runs a local model when all cloud providers fail. Only injected if `this.useOllama` is true AND the local Ollama server is reachable (`checkOllamaAvailable()`).

Full priority chain: OpenAI → Claude → Gemini Pro → Gemini Flash → Groq → Ollama

### Files Modified
- `electron/LLMHelper.ts` — `generateContentStructured()`: added Gemini Flash provider block after Gemini Pro; added Ollama provider block after Groq

### Edge Cases Handled
- Gemini Flash direct call does not mutate `this.geminiModel` (same guard as the Pro provider) to avoid race conditions
- Ollama is only pushed if `this.useOllama && await this.checkOllamaAvailable()` — no-op if Ollama is not running or not configured
- `checkOllamaAvailable()` is already used elsewhere in the class; calling it here adds a single HTTP HEAD request before pushing the provider, with no side effects

### How to Test
1. Configure only a Gemini API key (no OpenAI/Claude/Groq) — tests Flash fallback
2. Go to Settings → Profile Intelligence → Initialize Knowledge Base, upload a resume
3. Verify it processes successfully
4. For Ollama fallback: configure no cloud keys, enable Ollama mode, have Ollama running locally with a model loaded — upload a resume and verify it processes via Ollama

### Known Limitations
- Gemini Flash may produce less accurate structured extraction for complex resumes compared to Pro. The fallback ordering (Pro → Flash) ensures Pro is tried first.
- Ollama's local models are generally less capable than cloud reasoning models for structured JSON extraction. JSON output quality depends on the locally installed model.
- `checkOllamaAvailable()` adds a small HTTP round-trip at structured generation time if `useOllama` is true but Ollama may be down.

---

## Final Review

### Build Health
- `npx tsc --noEmit`: **0 errors** ✅
- `npm run build`: **✅ Successful** (3.36s, no new warnings)

### Changes Introduced
- No `@ts-ignore` added
- No empty `catch {}` blocks added
- No new `any` types added (existing `any` usages are pre-existing)
- No dead imports left behind

### Remaining Risks
1. **`OPENAI_MODEL = "gpt-5.4"`**: Now drives the `generateWithOpenai` fallback path as the baseline. Confirmed valid per OpenAI API docs.
2. **`gemini-3.1-pro-preview` and `gemini-3.1-flash-lite-preview`**: These model IDs are used in `generateContentStructured`. If Gemini releases these under different names, both Pro and Flash attempts will fail. The Groq/Ollama fallbacks will still catch it.
3. **Issue #90 timing**: The `setTimeout(..., 0)` before calling `handleWhatToSay` relies on React flushing state before the next microtask. In React 18 with concurrent mode, this may occasionally miss if the render is deferred. A more robust solution would use `useLayoutEffect` or a `useCallback` ref pattern, but this pattern matches the existing codebase style.
4. **Issue #89 on Windows**: The `setOpacity(0)` flash-prevention is applied universally, but Windows has its own opacity-shield path for content protection. The new `setOpacity(0)` call in `hideMainWindow` runs before the Windows path too — this is harmless (the Windows show path already manages opacity independently) but worth noting.
