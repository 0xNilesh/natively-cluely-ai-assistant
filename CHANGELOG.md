    # Changelog

    ## [Unreleased]

    ### What's New

    - **LiteLLM AI Gateway**: Added LiteLLM as a built-in provider, giving access to 100+ LLM providers (AWS Bedrock, Google Vertex AI, Azure, Cohere, and more) through a single OpenAI-compatible proxy. Configure the proxy URL and optional virtual key under Settings → AI Providers → LiteLLM Proxy; models are auto-discovered from the proxy and listed with a `litellm/` prefix. Max output tokens default to **Auto** — each model's real output budget is read from the proxy's `/model/info` registry (fallback 8,192) — with a manual dropdown override (4K–1M). Routes through the same data-scope gating, rate-limiting, and abort-aware streaming as every other cloud provider.

    ### Improvements & Fixes

    - **Close Settings on outside click + Escape, matching Modes/Profile**: `SettingsOverlay` now closes when you click the dimmed area around the card, mirroring the `e.target === e.currentTarget` backdrop pattern that Modes Manager and Profile Intelligence already used (App.tsx:774/807). Pressing **Escape** closes whichever of the three center overlays is open (top-most-wins order: Settings > Modes > Profile) via a shared listener in App.tsx, plus an internal listener inside `SettingsOverlay` and `ProfileIntelligenceSettings` for consistency. The opacity-slider preview is guarded both with a JS early-return and `pointer-events: none` on the backdrop so dragging the slider can never dismiss Settings mid-drag. (`2299895` — 3 files, +121/-9.)

    - **Prompt caching for Claude Opus 4.8**: `getClaudeCacheMinChars` now matches the whole `claude-opus-4-` family instead of enumerating point releases, so `claude-opus-4-8` uses the correct 4,096-token (16,384-char) cache minimum. It previously fell through to the generic 1,024-token floor, which silently disabled prompt caching for prompts between those two sizes.

    ### Code Review Fixes (2026-07-06)

Hardening pass from a launch-log code review on the `hardening/v2.7.0` branch. Eight items: two CRITICAL, two HIGH, two MEDIUM, two LOW.

#### Critical

- **Native module rebuild for Apple Silicon (better-sqlite3, keytar)**: Resolved `ERR_DLOPEN_FAILED` from an x86_64 `.node` binary on arm64 hardware (Rosetta-drift during a prior install). Rebuilt both modules from source against the real hardware arch via `scripts/rebuild-native-electron.js`. Verified arm64 via `file` + `lipo -info`. Smoke load test + `ReferenceFilePageCountPersistence.test.mjs` (5/5) green under `ELECTRON_RUN_AS_NODE`. Required version bump `better-sqlite3` 12.6.2 → 12.11.1 to compile against the current Electron V8 headers.
- **PhoneMirror LAN-bind confirmation dialog + bind-address UI**: Closing the plaintext-HTTP-on-LAN attack surface on `0.0.0.0:4123`. The first `phone-mirror:set-lan` flip to ON per session now triggers a native `dialog.showMessageBoxSync` ("Allow LAN access? This will bind Natively to 0.0.0.0:4123 so any device on this Wi-Fi network can connect with the pairing token. Continue?" — Cancel is the default button). On Cancel the toggle stays off and the UI does not flip optimistically. Phone token is regenerated on every `exposeOnLan` transition (already in place; now documented). Settings now surfaces the live bind address in the Enable row — `On — port 4123 · bound to 0.0.0.0 (LAN) · 0 phones connected` vs `bound to 127.0.0.1 (loopback only)`.

#### High

- **Vite dynamic-import warnings resolved**: Two modules were both statically AND dynamically imported, defeating code-splitting. Dropped the dead dynamic import of `analytics.service` in `ConnectCalendarButton.tsx` (use the static import — calendar button cannot render before the app shell). Dropped the dead dynamic import of `orchestrator` in `App.tsx` (already statically imported by both `App.tsx` itself and `OrchestratedToasterHost.tsx`). Vite build is now clean of dynamic-import warnings for these two modules.
- **Renderer bundle vendor split**: Added `build.rollupOptions.output.manualChunks` to `vite.config.mts`, partitioning deps into seven vendor buckets (`react-vendor`, `animation-vendor`, `icon-vendor`, `radix-vendor`, `markdown-vendor`, `media-vendor`, `data-vendor`). Renderer main entry dropped from **2.38 MB raw / 662 kB gzip** to **1.32 MB raw / 328 kB gzip**. Largest single chunk is now `markdown-vendor` at 628 kB (dominated by `react-syntax-highlighter` — orthogonal follow-up).

#### Medium

- **`ModelVersionManager` tier label split**: Operator-facing summary was collapsing T2 and T3 into a single slot (`T1=… | T2/T3=…`), which silently drops `tier3` from telemetry if a third tier is populated. Reformatted both the Vision and Text summaries to `T1=… | T2=… | T3=…`.
- **Whisper Apple Silicon dtype default**: Default per-module dtype on Apple Silicon flipped from uniform `fp32` to `WHISPER_SAFE_DTYPE` (fp32 encoder + q8 decoders) — ~4× size and latency win on CoreML-backed inference with negligible WER impact. New `whisperAppleSiliconDtype` setting (`fp32` / `q8` / `q4` / `int8` / `mixed`) lets users opt back to fp32 if a particular model's quantized variant regresses on their hardware.

#### Low / Verified

- **`HindsightManager` round-4 `isAppManaged` fix verified intact**: The debounced-Settings-save clobbering bug (orphan server tree, held port 8888) stays fixed. Guards at line 573 (`if (!isAppManaged) broadcastStatus('ready')`) and line 935 (`stopSync` bail-out) are present and correct.

### Crash & Launch Fixes (2026-07-06)

Black-screen and silent-crash debugging pass on the `hardening/v2.7.0` branch, traced from the user's `MEASURE_LATENCY=true npm start` log. Three distinct root causes, all fixed and verified via Chrome DevTools Protocol.

#### Critical

- **`electron:dev` npm script was missing the `build:electron` step**: A prior onboarding commit silently dropped `node scripts/build-electron.js` from the dev script, replacing it with `npm run build` (which only compiles the renderer). Without `build:electron`, `dist-electron/electron/main.js` was never produced, Electron's Node bootstrap threw `Cannot find module ...` on `require()` of the missing entry, and the process exited with code 1 and zero stdout/stderr — manifesting as "the app crashed with no error message." Script restored to `npm run build && npm run build:electron && cross-env NODE_ENV=development electron .` so both bundles are always present.

- **Black-screen from `.mjs`/`.ts` module-shadowing (Vite extension precedence)**: Latent module-resolution landmine that surfaced the instant the renderer was actually reachable. Vite's default extension order (`['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']`) silently resolves any unqualified import (no extension) to the `.mjs`/`.js` twin of a `.ts`/`.tsx` basename — including no-op test stubs and stale manually-compiled copies. The actual trigger was `src/lib/onboarding/orchestrator.mjs` (a no-op test stub with a non-referentially-stable `getSnapshot()`) being picked over `orchestrator.ts` (the real `OnboardingOrchestrator`); feeding the unstable snapshot into React's `useSyncExternalStore` triggered "Maximum update depth exceeded" during the commit phase, unmounting the entire React tree, and leaving the window blank while the main-process log stayed completely green. Fixed all current instances and closed the whole bug class:
  - `src/App.tsx`, `src/components/onboarding/OrchestratedToasterHost.tsx`, `src/lib/onboarding/orchestrator.ts` — unqualified orchestrator / persistence imports now use explicit `.ts` extensions.
  - `src/components/NativelyInterface.tsx` — explicit `.ts` on the `rollingTranscriptState` import (was silently resolving to a stale hand-compiled `.js` sibling instead of the live `.ts` source).
  - `premium/src/RemoteCampaignToaster.tsx` — explicit `.ts` on the `useAdCampaigns` import.
  - `electron/utils/rollingTranscriptState.js` — deleted (stale committed build artifact; its only test consumer reads from `dist-electron/` output).
  - 11 stale `.js` build artifacts in `premium/src/` deleted (`JDAwarenessToaster.js`, `MaxUltraUpgradeToaster.js`, `ModesSettings.js`, `NativelyApiPromoToaster.js`, `NegotiationCoachingCard.js`, `PremiumPromoToaster.js`, `PremiumUpgradeModal.js`, `ProfileFeatureToaster.js`, `ProfileVisualizer.js`, `RemoteCampaignToaster.js`, `useAdCampaigns.js`) — zero live consumers; all references in `src/premium/index.tsx` already use fully-qualified `.tsx`/`.ts` globs.
  - `vite.config.mts` — added `resolve.extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json']` so `.ts`/`.tsx` always win over `.js`/`.mjs` project-wide as one-line defense-in-depth.
  - `src/lib/onboarding/orchestrator.mjs` — hardened the no-op stub's `getSnapshot()` to return a single cached module-level snapshot (referentially stable across calls) so any future unqualified import that still hits the stub cannot trigger the React infinite-render cycle.

- **`src/main.tsx` referenced the undeclared global `process`**: `document.documentElement.setAttribute('data-platform', window.electronAPI?.platform ?? process?.platform ?? '')` ran at module top-level inside the renderer (`contextIsolation: true` / `nodeIntegration: false`). `process` isn't `undefined` here — it's literally undeclared — and optional chaining `?.` does not protect against referencing an undeclared identifier, so the line threw `ReferenceError: process is not defined` synchronously, aborted the module before `ReactDOM.createRoot(...).render(<App/>)`, and produced a black window with no renderer-side diagnostics. Replaced with `typeof process !== 'undefined' ? process.platform : ''` (the only safe check). Repo-wide sweep confirmed no other unguarded `process` / `require` / `__dirname` / `__filename` / `global` / `Buffer` references in `src/` or `premium/src/` (`process.env.NODE_ENV` hits are safe — Vite inlines them at build time).

#### Side effect (silent dead-code surfaced)

- **Onboarding orchestrator was silently `no-op`'d in the running app**: Before the module-shadowing fix, every `getOrchestrator()` call resolved to the `.mjs` stub, meaning the entire onboarding feature (permissions toaster, browser-extension toaster, profile/modes onboarding gates, trial promo, support/donation toaster, ad rotation gating, review prompt) had been wired up correctly in source but produced zero effects in the running app for weeks. It only became visible once `useSyncExternalStore` was introduced, which is why this "hardening" branch's headline onboarding feature had appeared to land cleanly while users never actually saw any of the toaster flows. Explicit-extension fix restores the real orchestrator in production.

### Known Follow-ups (not fixed in this pass)

The review surfaced pre-existing structural issues that this commit intentionally does **not** change. Flagged for a follow-up commit:

- `package.json` at repo root has no `devDependencies` block. `electron`, `@electron/rebuild`, `@types/electron`, `@types/ws`, `@types/better-sqlite3` are all missing, so `npm ci` does not install them and `tsc --noEmit` produces hundreds of phantom module-not-found errors. A fresh clone will break the rebuild step.
- No `preinstall` guard against running `npm install` under Rosetta on Apple Silicon — a future contributor would silently regress the native module ABI mismatch fixed here.
- No `scripts.build` at repo root. Build is invoked via `scripts/build-electron.js` + `vite build` directly. Worth adding for CI parity.

## [2.7.0] - 2026-06-05

    ### What's New

    - **Profile Intelligence Router (v2)**: Advanced domain classification (Coding, System Design, Behavioral, Negotiation) propagating constraints directly to LLM streaming paths.
    - **DeepSeek AI Support**: Native integration of DeepSeek's advanced reasoning models via custom cURL OpenAI-compatible API providers.
    - **Two New Meeting UI Themes**: Beautiful Liquid Glass and Modern Dark themes to completely redefine the real-time overlay visual experience.
    - **Answer-Type Constraints & Follow-Up Resolver**: Context-aware follow-up resolution with strict output formatting layout constraints (short, detailed, bulleted, code-only).
    - **Eager Code UI Expansion**: Growth-holds CSS elements to eagerly size overlays before React code-block mounting to prevent layout shifts.
    - **PI Latency Tracer (`PiLatencyTracer`)**: Telemetry to track reasoning, validation, and routing latencies to guarantee sub-500ms responsiveness.
    - **Evidence Validator & Live Deadlines**: Cross-validates claims made in meetings and displays real-time countdowns for live assessment deadlines.
    - **Single-Click In-App Updates**: Seamless update loops directly inside the desktop application.

    ### Improvements & Fixes

    - **Audio Stack & TCC Permission Hardening**: Hardened credentials management by eliminating racing set-provider IPCs and resolved macOS system audio process tapping/TCC permission gates to guarantee robust capture streams.
    - **Production-Grade API Audit (server.js)**:
      - Resolved ElevenLabs open -> session_started audio gap on failover/reconnect.
      - Fixed mic-only billing bypass with active/recent system presence checks.
      - Fixed stream-abort billing leaks by moving billing triggers to the stream `finally` block.
      - Patched language regex prompt injection security vulnerablities on `/v1/chat/completions`.
      - Implemented webhook processing retries with 3-attempt exponential backoff.
      - Fixed fallback-seconds double counting on STT reconnect-after-failover.
      - Integrated HTTP keep-alive connection pooling via undici agent.
      - Resolved DNS lookup cache thrashing during key-rotation reconnect storms.
      - Sanitized admin endpoint `provider-health` key leak.
      - Added a 34-unit test suite (`unit-fixes.test.mjs`) to verify server logic.

    ## [2.6.0] - 2026-05-15

    ### What's New

    - **Phone Link Integration**: Connect iOS or Android devices as remote mics or companion screens.
    - **TinyPrompts™ Engine**: System prompts optimized for local SLMs (Ollama, Qwen 2.5:4B, Llama 3.2).
    - **Codex CLI Integration**: Sandboxed code execution and terminal tasks via `gpt-5.3-codex`.
    - **Auto-Calendar Sync**: Calendar connectors (Google Calendar, Outlook) for prep context.
    - **Smart Task Sync**: Auto-extract action items and export to Jira, Linear, or Asana.
    - **Speaker Identification**: Real-time speaker diarization tagging transcript names.

    ### Improvements & Fixes

    - **Advanced Stealth Features**: Activity Monitor evasion, process name disguising, and strict timeout management.
    - **Scroll & Layout**: Scroll keybinds for mouse-free navigation and horizontal layout code line rendering fixes.
    - **OpenAI Realtime GA**: Upgraded OpenAI realtime streaming STT connection to the new GA session schema.

    ## [2.5.0] - 2026-04-25

    ### What's New

    - **Modes Manager**: Toggle between 7 tailored personas (General, Technical Interview, Looking for Work, Sales, Recruiting, Team Meet, and Lecture) with custom templates.
    - **Custom Context & Notes**: Paste up to 8,000 characters of instructions, crib sheets, or credentials, auto-injected as XML blocks.
    - **10-Minute Free Trial**: Free trial system with HWID+IP anti-abuse protections.
    - **Permissions Onboarding Toaster**: macOS/Windows onboarding toaster for TCC permissions.

    ### Improvements & Fixes

    - **STT Connection Pools & Key Pools**: Round-robin pools (up to 6 keys for Deepgram and ElevenLabs), failover logic, and shadow-probe watchdogs.
    - **Bluetooth/AirPods Conflict Resolution**: Autodetects macOS CoreAudio conflicts and switches to built-in mic.
    - **Reliable Screenshot Capture**: Hardened multi-screenshot capture with `Cmd+Shift+Enter` single-trigger analysis.
    - **Dodo Webhook Billing Hardening**: Refactored payment processing webhook endpoints, splitting them into `/webhooks/dodo/api` and `/webhooks/dodo/pro`.

    ## [2.4.0] - 2026-04-10

    ### What's New & Improvements

    - **Permissions Check IPC**: IPC bridges for TCC and audio check.
    - **Log Forwarding**: Added `open-log-file` and console logging forwarding to `~/Documents/natively_debug.log`.
    - **Tavily Multi-Key Search Pool**: Tavily search key pool supporting up to 11 keys with round-robin rotation, automatic credit tracking, and exhaustion alerts.
    - **Ad Campaigns Engine**: Cooldown logic and targeting for Pro upgrade campaigns.

    ## [2.0.7] - 2026-03-20

    ### What's New
    
    - **Single-Trigger Analysis**: Added a new global keybind (`Cmd+Shift+Enter`) for "Capture and Process" to instantly take a screenshot and run AI analysis.
    - **Tavily Search Integration**: Replaced Google Custom Search Engine with the Tavily Search API. Features advanced depth and raw content extraction for vastly improved RAG and Company Research.
    - **Enhanced Company Dossiers**: Massively expanded the Premium Profile Intelligence UI. Now includes interview difficulty badges, a 5-star work culture grid with sub-dimensions, employee reviews with sentiment analysis, critics/complaints tracking, and core benefits pills.

    ### Improvements
    
    - **AI Language Strict Enforcement**: Rewrote the AI language enforcement pipeline. Native languages (Spanish, French, etc.) are now strongly prioritized over system prompt defaults using a triple-layer strict injection, guaranteeing the AI never incorrectly defaults back to English.
    - **Model Selection Accuracy**: Rewrote `LLMHelper` routing logic to guarantee your specifically selected cloud provider model (e.g., `gpt-4o`, `claude-3-5-sonnet`) is rigorously respected during vision fallbacks, multimodal processing, and streaming.
    - **Robust AI Fallbacks**: Added Gemini Flash and local Ollama models to the structured generation fallback chains, ensuring features like resume parsing work continuously even when primary models face rate limits or outages.
    - **Smoother Animations**: Mac window transitions now utilize zero-opacity pre-hiding to eliminate jarring animation flashes during rapid screenshot captures.
    
    ### Fixes
    
    - Fixed a bug where custom cURL endpoints and the "What to Say" auto-suggestion path would occasionally bypass the user's language preferences.
    - Fixed the OpenAI API validation ping by upgrading the deprecated connection test model to `gpt-4o-mini`.
    - Fixed UI sync issues where the AI response language dropdown could fall out of sync with the backend upon an IPC failure via a new optimistic playback system.
    - Removed unused dead user interface components and completely sanitized legacy template variables from core system prompts.

    ## [2.0.5] - 2026-03-15

    ### Improvements

    - **Stealth Mode UI**: The Process Disguise selector is now visually disabled and locked while Undetectable mode is active, preventing accidental state mismatches.
    - **State Synchronization**: Greatly improved internal state synchronization across all application windows (Settings, Launcher, Overlay).

    ### Fixes

    - **Infinite Feedback Loops**: Completely eliminated the bug where toggling Undetectable mode would sometimes cause the app to rapidly toggle itself on and off.
    - **Delayed Dock Reappearance**: Fixed a regression where the macOS dock icon would mysteriously reappear several seconds after entering stealth mode if a disguise had recently been changed.
    - **Initial State Loading**: Fixed an issue where the Settings UI would briefly show incorrect toggle states when first opened.
    - **macOS OS-level Events**: Hardened the app against macOS `activate` events (like clicking the app in Finder) accidentally breaking stealth mode.

    ### Technical

    - Refactored IPC (Inter-Process Communication) listeners for `SettingsPopup` and `SettingsOverlay` to use a strict one-way (receive-only) data binding pattern.
    - Added strict management and cancellation of `forceUpdate` timeouts during stealth mode transitions.
    - Added explicit type safety for the new getters in `electron.d.ts`.

    ## [2.0.4] - 2026-03-14

    ### Summary

    Version 2.0.4 introduces a massive architectural overhaul to the native audio pipeline, guaranteeing production-ready stability, true zero-allocation data transfer, and instantaneous STT responsiveness with WebRTC ML-based VAD.

    ### What's New

    - **Two-Stage Silence Processing**: Replaced basic RMS noise gating with a two-stage pipeline combining an adaptive RMS threshold and WebRTC Machine Learning VAD. Rejects typing, fan noise, and non-speech sounds before they bill STT APIs.
    - **Zero-Copy ABI Transfers**: Transitioned the `ThreadsafeFunction` bridging to direct `napi::Buffer` (Uint8Array) allocations, completely eliminating V8 garbage collection pressure during continuous capture.
    - **Sliding-Window RAG**: Implemented a 50-token semantic overlap in `SemanticChunker.ts` to prevent conversational context loss across chunk boundaries.

    ### Improvements

    - **Latency & Responsiveness Tuning**: Stripped redundant TS debouncing, slashed `MIN_BUFFER_BYTES`, and reduced native hangover, achieving a ~300ms reduction in end-to-end transcription latency. short utterances ("Yes", "Stop") no longer sit trapped in the buffer.
    - Removed floating-point division truncation for superior downsampling from 44.1kHz external microphones.

    ### Fixes

    - Fixed a critical bug where the native Rust monitor returned a hardcoded `16000Hz` while actually streaming 48kHz audio. Now syncs true hardware sample rates.
    - Resolved the "Input missing" silent crash bug on microphone restarts by properly recreating the CPAL stream.
    - Restored the 10s continuous speech backstop for REST APIs to prevent unbounded buffer growth.
    - Added missing `notifySpeechEnded()` properties and cleaned up dangerous type casts.

    ### Technical

    - Audio processing transitioned entirely to strict ABI memory bridging (`napi::Buffer`)
    - Re-architected native silence_suppression state machine around WebRTC VAD inputs.

    ## [2.0.3] - 2026-03-13

    ### What's New

    - **Dynamic AI Model Selection:** Replaced static model lists with dynamic dropdowns. Your preferred models synced from providers (like OpenAI, Anthropic, Google) now automatically appear across the entire app.
    - **Multimodal Resilience:** Added a "Smart Dynamic Fallback" using Groq Llama 4 Scout. If default vision models fail or get rate-limited during screen analysis, Natively instantly reroutes the image to ensure uninterrupted performance.
    - **Multiple Screenshot Support:** The Natively Interface can now handle and process multiple attached screenshots simultaneously instead of just one.
    - **Improved Settings UX:** API keys now auto-save after 5 seconds of inactivity, and selecting a preferred model immediately updates the rest of the application without requiring a page reload.

    ### Architecture & Fixes

    - **Better Embeddings:** Migrated from Gemini Embedding to a completely new and more robust embedding architecture.
    - **Claude Fixes:** Resolved max_tokens and context limits issues specific to Anthropic Claude interactions.
    - **DRY Refactoring:** Centralized model configuration strings across the codebase to ensure easier future updates.

    ## [2.0.2] - 2026-03-10

    ### Summary

    v2.0.2 focuses on fixing Windows system audio capture, improving RAG stability, and resolving critical Soniox STT configuration issues.

    ### What's New

    - Fully functional system audio capture for Windows
    - Introduced system for manual transcript finalization and interim/final bridging during recordings

    ### Improvements

    - Migrated to `app.getAppPath()` for reliable cross-platform resource discovery
    - Ensured `sqlite-vec` compatibility and fixed embedding queue management
    - Upgraded `@google/genai` and optimized embedding dimensionality for lower latency

    ### Fixes

    - Improved Soniox STT streaming reliability, manual flushing, and configuration persistence
    - Resolved application entry point and module resolution issues in production builds
    - Fixed transcript bridging for manual recording mode
    - Corrected stealth activation and window focus inconsistencies

    ### Technical

    - Dependency updates for `@google/genai`
    - Cleaned up native compiler warnings for Windows
    - Fixed module resolution for internal Electron paths

    ## [2.0.1] - 2026-03-06

    ### New Features

    - **Premium Profile Intelligence**: Job Description (JD) and Resume context awareness, company research, and negotiation assistance.
    - **Live Meeting RAG**: Instant intelligent retrieval of context directly during a live meeting using local vectors.
    - **Soniox Speech Provider**: Added support for ultra-fast and highly accurate streaming STT with Soniox.
    - **Multilingual Support**: Choose from various response languages, set speech recognition matching specific accents and dialects.

    ### Improvements & Fixes

    - Fixed numerous issues and merged 3 community pull requests to improve overall stability.

    ## [1.1.8] - 2026-02-23

    ### Summary

    Patch update addressing OpenAI GPT 5.x compatibility and increasing token output limits for all providers.

    ### What's New

    - Replaced deprecated `max_tokens` parameter with `max_completion_tokens` required by GPT 5.x models.
    - Increased max output tokens for OpenAI (GPT 5.2) and Claude (Sonnet 4.5) to 65,536.
    - Increased max output tokens for Groq (Llama 3.3 70B) to 32,768.

    ### Improvements

    - Improved response length capabilities across all text-generation AI models.
    - Updated connection test model to use `gpt-5.2-chat-latest` instead of the deprecated `gpt-3.5-turbo`.

    ### Fixes

    - Fixed 400 error when using OpenAI GPT 5.x models for text queries and toggle actions.

    ### Technical

    - Replaced `max_tokens` with `max_completion_tokens` in `LLMHelper.ts` and `ipcHandlers.ts`.

    ## [1.1.7] - 2026-02-20

    ### Summary

    Security hardening, memory optimization, and stability improvements for a more robust and reliable experience.

    ### What's New

    - API rate limiting to prevent 429 errors on free-tier plans (Gemini, Groq, OpenAI, Claude)
    - Cross-platform screenshot support (macOS, Linux, Windows)
    - Official website link added to the About section

    ### Improvements

    - Smarter transcript memory management with epoch summarization instead of hard truncation — no more losing early meeting context
    - API keys are now scrubbed from memory on app quit to minimize exposure window
    - Credentials manager now overwrites key data before disposal for enhanced security
    - Helper process renaming for improved stealth in Activity Monitor

    ### Fixes

    - Fixed V8/Electron entitlements crash on Intel Macs by including entitlements.mac.plist during ad-hoc signing
    - Fixed process disguise not applying correctly when undetectable mode is toggled on
    - Fixed usage array capping with dedicated helper method to prevent unbounded growth

    ### Technical

    - Added `RateLimiter` service (token bucket algorithm with configurable burst and refill rates)
    - Added `PRIVACY.md` and `SECURITY.md` policy documents
    - Refactored ad-hoc signing script with helper renaming and proper entitlements flow
    - Version bump to 1.1.7

    ## [1.1.6] - 2026-02-15

    ### New Features

    - **Speech Providers**: Added support for multiple speech providers including Google, Groq, OpenAI, Deepgram, ElevenLabs, Azure, and IBM Watson.
    - **Fast Response Mode**: Introduced ultra-fast text responses using Groq Llama 3.
    - **Local RAG & Memory**: Full offline vector retrieval for past meetings using SQLite.
    - **Custom Key Bindings**: Added ability to customize global shortcuts for easier control.
    - **Stealth Mode Improvements**: Enhanced disguise modes (Terminal, Settings, Activity Monitor) for better privacy.
    - **Markdown Support**: Improved Markdown rendering in the Usage section for better readability of AI responses.
    - **Image Processing**: Integrated `sharp` for optimized image handling and faster analysis.

    ### Improvements & Fixes

    - Fixed various UI bugs and focus stealing issues.
    - Improved application stability and performance.

    ## [1.1.5] - 2026-02-13

    ### Summary

    The Stealth & Intelligence Update: Enhances stealth capabilities, expands AI provider support, and improves local AI integration.

    ### What's New

    - **Native Speech Provider Support:** Added Deepgram, Groq, and OpenAI speech providers.
    - **Custom LLM Providers:** Connect to any OpenAI-compatible API including OpenRouter and DeepSeek.
    - **Smart Local AI:** Auto-detection of available Ollama models for local AI.
    - **Global Spotlight Search:** Toggle chat overlay with Cmd+K (macOS) and Ctrl+K (Windows/Linux).
    - **Masquerading Mode:** Appear as system processes like Terminal or Activity Monitor.
    - **Improved Stealth Mode:** Enhanced activation and window focus transitions.

    ### Improvements

    - **Natural Responses:** Updated system prompts for more concise and natural responses.
    - **Conversational Logic:** Reduced robotic preambles and unnecessary explanations.
    - **Performance:** Improved UI scaling and reduced speech-to-text latency.

    ### Fixes

    - No critical fixes reported in this release.

    ### Technical

    - Internal logic refinements for improved conversational flow.
    - Updater and background process stability improvements.

    #### macOS Installation (Unsigned Build)

    If you see "App is damaged":

    1. Move the app to your Applications folder.
    2. Open Terminal and run: `xattr -cr /Applications/Natively.app`

    ## [1.1.4] - 2026-02-12

    ### What's New in v1.1.4

    - **Custom LLM Providers:** Connect to any OpenAI-compatible API (OpenRouter, DeepSeek, commercial endpoints) simply by pasting a cURL command.
    - **Smart Local AI:** Enhanced Ollama integration that automatically detects and lists your available local models—no configuration required.
    - **Refined Human Persona:** Major updates to system prompts (`prompts.ts`) to ensure responses are concise, conversational, and indistinguishable from a real candidate.
    - **Anti-Chatbot Logic:** Specific negative constraints to prevent "AI-like" lectures, distinct "robot" preambles, and over-explanation.
    - **Global Spotlight Search:** Access AI chat instantly with `Cmd+K` / `Ctrl+K`.
    - **Masquerading (Undetectable Mode):** Stealth capability to disguise the app as common utility processes (Terminal, Activity Monitor) for discreet usage.
