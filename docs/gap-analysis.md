# Gap Analysis — Natively vs Cluely / Final Round / LockedIn / Verve / Linkjob / Interview Solver / Parakeet

**Date:** 2026-05-11
**Inputs:** [`docs/internal-audit.md`](./internal-audit.md), [`docs/competitor-matrix.md`](./competitor-matrix.md), [`PERF_AUDIT.md`](../PERF_AUDIT.md).
**Severity:** P0 = ship-blocker / quarter-defining; P1 = measurable competitor lead; P2 = hygiene + future-proofing.

The output here is **gaps + fixes**, ranked. Implementation sequencing is in [`docs/improvement-roadmap.md`](./improvement-roadmap.md).

---

## Category A — Latency

### A1 [P0] Renderer re-render storm during streaming kills perceived TTFT
**Where:** `src/components/NativelyInterface.tsx` (2,910-line monolith), all `onIntelligence*Token` handlers (`:776, :799–820, :884–902, :928–946, :983–1007, :1069–1089`).
**Why it matters:** Competitors compete on TTFT in marketing. Natively's `streamWithGroq` / `streamWithGemini` can emit 200–400 tok/s; if each token triggers a full-tree re-render + ReactMarkdown reparse + Prism re-tokenize, the renderer pegs at 100% CPU and tokens visibly stutter. PERF_AUDIT §3.1 establishes that a 400-token answer triggers ~400 full-tree renders + 400 Prism tokenizations.
**Fix:** Per PERF_AUDIT §3.1 + Sprint-1/2 plan:
1. Extract `<MessageRow msg={msg}>` wrapped in `React.memo` with `(prev, next) => prev.msg.id === next.msg.id && prev.msg.text === next.msg.text && prev.msg.isStreaming === next.msg.isStreaming`.
2. Hoist ReactMarkdown `components` objects to module scope or `useMemo` (currently created per-render at `:1819–1832, :1853–1858`).
3. rAF-coalesce streaming `setMessages` — buffer tokens in a ref, flush ≤1×/frame. Cuts ~400 renders to ~42 at 60 Hz.
**Acceptance:** During a 10 s streaming `What-to-answer` response, renderer CPU < 30% on a 2020 i5 (today: 60–100%). DevTools Performance flame graph no longer shows `setMessages → ReactMarkdown → Prism` as top frame.

### A2 [P0] Stop-meeting latency 500–800 ms
**Where:** `electron/main.ts:1782` (hardcoded 250 ms `setTimeout` sleep) + `:1778–1779` (synchronous Rust `capture.stop()` calls).
**Why it matters:** Every stop click feels laggy. Verve / Final Round don't have this problem because they don't run a native audio module on the main process.
**Fix:** Per PERF_AUDIT §2.1/§2.2 — move the 250 ms grace window inside the existing fire-and-forget background IIFE; replace synchronous `.stop()` calls with `Promise.all([setImmediate(...)])` so IPC returns instantly. **Verify whether this is already shipped** — PERF_AUDIT proposes the fix but did not confirm it landed. Read `endMeeting()` (`:2518+`) and validate.
**Acceptance:** `console.time('endMeeting-ipc')` reports < 100 ms (today: 500–800 ms).

### A3 [P0] STT WebSockets are created lazily on start-meeting → first-second-of-meeting transcripts can be dropped
**Where:** `electron/main.ts:1141–1153` (`setupSystemAudioPipeline` constructs `googleSTT` / `googleSTT_User` on first call). Per PERF_AUDIT §1.3.
**Why it matters:** Deepgram/Soniox/NativelyPro WS handshake = 200–800 ms. During that window the Rust capture pumps silence into V8's GC but the *first user words of every meeting* incur a perceived 1-second extra TTFT.
**Fix:** Pre-warm STT WS connections at app launch (eager construct in `initializeApp`) when credentials exist; don't `start()` them, just open the socket. Then `startMeeting` only sends the start signal. `PERF_AUDIT.md` lists this as Sprint-2 #8.
**Acceptance:** First transcript chunk of a fresh meeting arrives ≤ 300 ms after first user audio (today: 600–1400 ms).

### A4 [P1] No sentence-boundary chunker before LLM input
**Where:** Auto-trigger path `IntelligenceEngine.ts:170–175` fires on `SuggestionTrigger` from Rust audio service. There's no JS-side check that the buffered transcript ends at a sentence boundary.
**Why it matters:** Natively can fire an LLM call on `"So my question is what would you do if"` — a mid-sentence partial. The LLM then generates a confidently-wrong answer to a question that wasn't fully asked. Cluely's leaked prompt scaffolds a "headline ≤6 words" output that assumes complete questions; ours can't make the same assumption.
**Fix:** Add a sentence-boundary gate in `IntelligenceEngine.handleSuggestionTrigger`. If the last transcript chunk doesn't end with `[.!?]\s*$` and the trailing transcript hasn't been silent for > 1 s, defer the trigger. Track via the existing Rust `speech_ended` signal (already plumbed for `notifySpeechEnded()` in REST STT paths). Add `triggerOnlyOnSpeechEnd` config flag, default `true`.
**Acceptance:** No LLM call fires on a trigger whose `lastQuestion` ends mid-word (verified via a synthetic transcript replay test).

### A5 [P1] Multi-model routing latency — no parallel race except in `streamWithGeminiParallelRace`
**Where:** `LLMHelper.ts:2589–2773` (fallback waterfall) — sequential, not parallel.
**Why it matters:** When `streamWithGroq` is slow because of regional Groq load, we discover this only after the request errors. Cluely's GPT-4.1+Claude-3.7 dual-stack and Verve's domain-specific copilots both pick a single model up front. Natively could **race two providers** for the first 300 ms and keep the faster one — paying for two API calls only on slow-network days. Already implemented for Gemini Flash vs Pro; not generalised.
**Fix:** Generalise `streamWithGeminiParallelRace` (`:3204`) into a provider-agnostic `racePair(providerA, providerB, raceTimeoutMs=300)`. Race Natively-API vs Groq when both are configured. Abort loser via shared `AbortController`.
**Acceptance:** P95 TTFT on a 4G/regional-Groq-latency simulation drops ≥ 200 ms.

---

## Category B — Cost efficiency / prompt caching

### B1 [P0] CORE_IDENTITY + EXECUTION_CONTRACT are embedded twice in every cloud request
**Where:** `electron/llm/prompts.ts:1010, :1118, :1263, :1362, :1455, :1546, :1638` — every `MODE_*_PROMPT` starts with the identical `${CORE_IDENTITY}\n${EXECUTION_CONTRACT}` prefix. Combined system message in cloud paths = `HARD_SYSTEM_PROMPT (which also has the prefix) + "\n\n## ACTIVE MODE\n" + MODE_*_PROMPT (prefix again)` (see `LLMHelper.ts:2554–2557`).
**Why it matters:** Prior session memory recorded prompt sizes 1700–3700 tokens per static segment. Duplicating CORE_IDENTITY+EXECUTION_CONTRACT costs ~2,000 tokens per request even after cache hit (the cache delta still ships). At 100 requests/day/user × 2k extra prompt tokens × $3/M for Claude Sonnet = $0.60/user/day baseline waste.
**Fix:** Strip the duplicated prefix from every `MODE_*_PROMPT`. The dispatcher already prepends the static base; the mode prompt should contain only mode-specific delta. Add a unit test that the rendered system string contains `CORE_IDENTITY` exactly once.
**Acceptance:** Sent system-prompt size reduced by ~1800 tokens (verify via Claude API `usage.input_tokens` before/after on the same query).

### B2 [P0] OpenAI requests don't set `prompt_cache_key` → unreliable cache routing
**Where:** `LLMHelper.ts:3005–3009, :3059–3071` build messages without `prompt_cache_key` or `user` parameter.
**Why it matters:** OpenAI's automatic prefix caching hashes the leading bytes of `messages[]` but routes through their cache infrastructure based on the `user`/`prompt_cache_key` field. Without it, cache hits across server pools are racy and can be < 50% even when the prompt is byte-identical. Reference: <https://platform.openai.com/docs/guides/prompt-caching>.
**Fix:** Pass `prompt_cache_key: stableHash(mode + modelId + persona)` on every OpenAI request. Use SHA-256 of the static prefix string, truncated to 32 chars. Same approach applies to `streamWithOpenaiMultimodal`.
**Acceptance:** OpenAI dashboard cached-token ratio > 60% during a sustained interview session (today: < 30% expected, verify with logging).

### B3 [P0] Gemini `cachedContent` API not wired despite TODO
**Where:** `LLMHelper.ts:3146–3151` TODO.
**Why it matters:** Gemini's *explicit* cache (`client.caches.create({ contents, ttl })`) hits at ~25% the cost of an uncached input token, vs implicit caching's ~50% — and only triggers above 1024 tokens reliably. Natively's static prompts are 2k+ tokens.
**Fix:**
1. On app launch, for each mode + each user persona, call `caches.create({ model, systemInstruction: STATIC_BLOCK, ttl: '3600s' })` and store the returned `cachedContent.name`.
2. In `streamWithGeminiModel`, pass `config.cachedContent: name` instead of inlining `systemInstruction` when a cache handle exists.
3. Renew TTL on use; LRU-evict on persona change.
Reference: <https://ai.google.dev/gemini-api/docs/caching>.
**Acceptance:** Gemini `usage_metadata.cachedContentTokenCount` non-zero on consecutive same-mode requests.

### B4 [P0] Raw PNGs sent to OpenAI / Claude / Gemini
**Where:** `LLMHelper.ts:3064–3071` (OpenAI), `:3097–3110` (Claude), `:3156–3167` (Gemini). All three pass `image.toPNG()` raw read.
**Why it matters:** A 2560×1440 desktop screenshot = ~3–5 MB PNG. `sharp` JPEG q85 at the same resolution = 250–500 KB (~10× smaller). At image-input-token pricing ($0.005 / image for Gemini, more for Claude/Opus), the larger image consumes proportionally more tokens. Plus upload bandwidth on slow networks adds 1–3 s to TTFT.
**Fix:** Apply the same `sharp` resize-≤1920px + JPEG q85 path that already exists for Natively (`:2814–2837`) to OpenAI / Claude / Gemini multimodal paths. Quality 85 is indistinguishable from raw at the screen-text legibility level. Library: `sharp` (already in `package.json`).
**Acceptance:** Average screenshot upload size < 500 KB; no measurable quality regression in vision-task accuracy on the standard test set.

### B5 [P1] No token cap for cloud LLM transcript window
**Where:** Time-based windows in `IntelligenceEngine.ts` (60–180 s per mode); the full filtered transcript is sent every request. No `maxContextTokens - system - reserved` budgeting like `streamWithOllama` has (`:3303–3314`).
**Why it matters:** A talkative 2-hour meeting with a 180 s window can still produce 6–10 KB of transcript per request. Most of this is repeating what the model already saw on the last turn. Per-mode caching helps but doesn't deduplicate user messages.
**Fix:** Wrap `LLMHelper.streamGenerateWithImages` and similar entry points with a `tokenBudgetUser(userPayload, model, reservedOutput=8192)` function. Use `js-tiktoken` for OpenAI (already a likely transitive dep); approximate-1-token-per-4-chars for Claude/Gemini (good enough). Shift oldest transcript lines until budget fits. Always preserve `[detected question]` plus last 3 turns.
**Acceptance:** Mean input tokens per request capped at 8 K for non-Opus models, 16 K for Opus.

### B6 [P1] Per-mode caching strategy — each persona doesn't have its own cached prefix
**Where:** Implicit in B1–B3. The cache key for Claude/Gemini explicit caches must be `f(mode, model)` or `f(mode, model, persona_id)`, not just `f(model)`.
**Why it matters:** Without per-mode keys, a Tech-mode → Sales-mode switch invalidates the cache and costs full prompt tokens again. Per the audit, the modes are 7 + general = 8 distinct static blocks. Pre-warming 8 cache entries once per hour is cheap.
**Fix:** As part of B3 implementation, key Gemini `cachedContent.name` by `(mode, model)`. For Claude, the prompt-caching layer's `cache_control: {type:'ephemeral'}` is already per-system-block — verify by inspecting cache hit metrics in Anthropic dashboard, but no code change is needed if `buildClaudeSystemBlocks` is invoked with the post-B1 stripped prompts.
**Acceptance:** Cache hit > 70% within a mode-stable 5-minute window; cache rebuild < 5 s on mode switch.

---

## Category C — Quality

### C1 [P0] Glance-first output format — Natively returns prose blocks
**Where:** Mode prompts in `prompts.ts:1010, :1118, :1263, :1362, :1455, :1546, :1638` — none specify a "SAY FIRST: …" opener pattern. Cluely's leaked prompt does (gist links in competitor-matrix.md). Final Round uses STAR scaffolding.
**Why it matters:** The defining UX problem of an interview copilot is that the candidate has < 2 seconds to glance at the screen. A 4-line prose response is unusable; a 6-word opener + 2 ≤15-word bullets is. Cluely figured this out; Natively hasn't.
**Fix:** Update every `MODE_*_PROMPT` (and `TINY_*` counterparts) with a uniform output spec:
```
OUTPUT FORMAT:
SAY FIRST: <≤8-word opener you can speak out loud while reading the rest>
- <bullet 1, ≤15 words>
- <bullet 2, ≤15 words>
[optional ≤3-line code block for coding mode]
```
Make this scaffolding part of `EXECUTION_CONTRACT` so all modes inherit; modes only override the rules for content-type. For coding mode add an explicit "code first, prose-explanation second" override.
**Acceptance:** 20-question manual eval — every response begins with `SAY FIRST: ` and < 50 tokens for the opener+bullets section.

### C2 [P0] Confidence threshold 0.5 lets a lot of garbage through
**Where:** `IntelligenceEngine.ts:170–175` gate: `if (trigger.confidence < 0.5) return;` then `runWhatShouldISay(trigger.lastQuestion, trigger.confidence)`.
**Why it matters:** 0.5 is borderline. Combined with no sentence-boundary check (A4), this triggers low-quality auto-fires that consume tokens and confuse users.
**Fix:** Raise threshold to 0.7 for auto-trigger; pair with A4. Cache the cancelled-trigger transcripts so a user can manually replay the cancelled trigger via hotkey (Cluely-style "let me decide").
**Acceptance:** Auto-fire trigger rate drops ~30%; user-reported false-fires < 5% in dogfood.

### C3 [P1] Multi-model routing per question type (coding → strongest reasoner, behavioral → fastest)
**Where:** `LLMHelper.ts:2589–2773` waterfall is model-based, not question-type-based.
**Why it matters:** Verve's domain-specific copilots and LockedIn's coach-layer architecture both implicitly select a different prompt template per domain. Natively has the prompt templates (7 modes) but doesn't route different *models* per question type within a mode. Coding question → Claude Sonnet / GPT-5.4. Behavioral → Gemini Flash. System design → Claude Opus. Today the user picks one model for the whole session.
**Fix:** Build a `selectModelForQuestion(intent, mode)` policy that runs after `IntentClassifier.classifyIntent` returns. Wire it through `runWhatShouldISay` to override `modelId` per call. Respect user override when present.
**Acceptance:** Auto-routing produces measurably faster TTFT on behavioral (Gemini Flash) and measurably better correctness on coding (Claude Sonnet 4.6) vs single-model baseline.

### C4 [P1] Code-mode prompts not visibly differentiated from behavioral
**Where:** `MODE_TECHNICAL_INTERVIEW_PROMPT` (`prompts.ts:1638`) vs `MODE_LOOKING_FOR_WORK_PROMPT` (`:1118`). Both inherit the same `CORE_IDENTITY` + `EXECUTION_CONTRACT`. The body differences need a code-first output enforcement.
**Why it matters:** Final Round's docs emphasise "real-time coding solutions" — they explicitly differentiate. Natively's tech-interview mode should always lead with the code block.
**Fix:** In `MODE_TECHNICAL_INTERVIEW_PROMPT`, hard-require:
```
For coding tasks: code block FIRST, single sentence of complexity analysis SECOND, no preamble.
For system design: bullet list of components FIRST, then trade-off lines.
```
**Acceptance:** Manual eval of 20 coding questions — code block is the first non-whitespace content in every response.

### C5 [P2] Glance-first STAR scaffolding for behavioral modes
**Where:** `MODE_TEAM_MEET_PROMPT`, `MODE_LOOKING_FOR_WORK_PROMPT`, etc.
**Why it matters:** Final Round's STAR template is *the* recognized framework for behavioral interview answers. Natively's behavioral modes don't enforce one.
**Fix:** In looking-for-work + team-meet modes, add a "When asked a behavioral question, use STAR: Situation (1 line) → Task (1 line) → Action (≤2 lines) → Result (1 line)" override.
**Acceptance:** Manual eval — behavioral answers parse cleanly into 4 STAR slots.

---

## Category D — Stealth

### D1 [P0] Cropper window doesn't get native NSPanel stealth
**Where:** `electron/CropperWindowHelper.ts:427–478`. Comment at `:429–440` declares stealth should be applied but the code only calls `setContentProtection` via `applyOpacityShield` (`:365, :378`). Native `applyStealthToWindow` is **not** invoked.
**Why it matters:** During a screen share, if the user invokes cropper to capture a region, the click that initiates the crop *may* briefly promote Natively to frontmost on macOS due to the missing `_setPreventsActivation:` SPI — exposing the dock icon for ~100 ms. That's enough for a careful interviewer to notice.
**Fix:** Add `nativeModule.applyStealthToWindow(this.cropperWindow.getNativeWindowHandle())` to `CropperWindowHelper.applyOpacityShield` immediately after `setContentProtection`. Match the pattern in `WindowHelper.ts:344–359`.
**Acceptance:** Activity Monitor + a 60 fps screen-recorder test shows zero frontmost-promotion during a cropper invocation on macOS 14/15.

### D2 [P1] Windows: relying on Electron `setContentProtection` only, no direct `SetWindowDisplayAffinity` FFI
**Where:** Audit §6.3. The flag goes through Electron's wrapper which maps to `WDA_EXCLUDEFROMCAPTURE` on Electron ≥ 22.1. We're on 33.2.0, so OK in theory. But Cluely's teardown indicates it calls `SetWindowDisplayAffinity` directly to combine `WDA_EXCLUDEFROMCAPTURE | WDA_MONITOR` flags and to retry on DWM lazy-application.
**Why it matters:** DWM occasionally drops the flag during compositor renegotiation (e.g., monitor hotplug). The blur-handler re-asserts always-on-top (`WindowHelper.ts:467–473`) but doesn't re-assert content protection.
**Fix:** Add `nativeModule.setWindowDisplayAffinity(handle, WDA_EXCLUDEFROMCAPTURE)` via N-API FFI on Windows. Implement in `native-module/src/stealth_window.rs` behind a Windows cfg gate. Re-assert on blur / monitor change.
**Acceptance:** Multi-monitor hotplug stress test: 100 plug-unplug cycles, content protection still applied (verifiable via Win32 `GetWindowDisplayAffinity`).

### D3 [P1] Click-through is overlay-only — launcher has no pass-through
**Where:** `WindowHelper.syncOverlayInteractionPolicy` (`:544–567`) only applies to `overlayWindow`. Audit §6.7.
**Why it matters:** Verve advertises `Cmd+Shift+P` for IDE-aware pass-through. Natively has the hotkey (`Ctrl+Shift+B` per `KeybindManager.ts:16`) but only for the overlay. During a coding interview the candidate often has the launcher open to swap modes — clicking through that to the IDE matters.
**Fix:** Extend `setIgnoreMouseEvents(true, { forward: true })` to `launcherWindow` when the user toggles pass-through globally. Add a small visual indicator (cursor change) so the user knows pass-through is active.
**Acceptance:** Manual test: with launcher open over VS Code, pass-through hotkey enables clicks-through-to-VS-Code without dismissing launcher.

### D4 [P1] No counter-detection mitigations for Truely / Talview / Polygraf process enumeration
**Where:** Process disguise is at `main.ts:3480–3636` (`_applyDisguise`). Runtime-only — binary remains `Natively.app` / `Natively.exe`.
**Why it matters:** Truely "Demon Mirror" enumerates running PIDs and signals Cluely's process name. Talview marketing names Cluely AND Parakeet specifically. If "Natively" appears in a `ps`/Task Manager list, the same playbook applies to us.
**Fix:** Two-tier defense:
1. **Install-time rename option** — during install, prompt user to pick a binary name from the disguise modes (`terminal`, `settings`, `activity`, `none`). Binary file gets renamed; persisted in registry/plist. Avoid `setAppUserModelId` collisions.
2. **Continue runtime `process.title` re-assertion** as today, but also re-assert immediately on `SIGCHLD` / `WM_DEVICECHANGE` so a polling detector sees the disguised name even if it polls every < 1 s.
**Acceptance:** `ps aux | grep -i natively` returns nothing during a meeting in undetectable mode.

### D5 [P2] macOS ScreenCaptureKit + macOS 15 bypass acknowledged but not mitigated
**Where:** `stealth_window.rs:166–178` comment.
**Why it matters:** On macOS 15+, ScreenCaptureKit can choose to ignore `NSWindowSharingNone` for certain capture clients. Zoom and Teams update aggressively; once they switch, Natively's macOS stealth is broken. This is a *strategic* gap with no immediate fix — but worth tracking.
**Fix:** No code fix today. Add monitoring: every release should test against the latest Zoom/Teams/Meet client. Document `SUPPORTED_PLATFORMS.md` with version cutoffs (akin to Interview Solver's "Zoom ≤ 6.16" disclosure — being honest about the bound builds trust vs Parakeet's bust claim).

---

## Category E — Reliability

### E1 [P0] Three STT providers have unbounded reconnect loops → storm risk on network flakiness
**Where:**
- `ElevenLabsStreamingSTT.ts:352–365` — exp 1s→30s, **no cap**.
- `SonioxStreamingSTT.ts` — exp 1s→30s, **no cap**.
- `NativelyProSTT.ts:459, :468` — capped exp + ±20% jitter but **indefinite while `isActive`**.

**Why it matters:** On a flapping Wi-Fi network the WS opens-and-closes once per second indefinitely. Each open hits the upstream API which may rate-limit Natively-the-org's IP. Cluely's breach was downstream of similar "fire indefinitely" patterns.
**Fix:** Apply Deepgram's pattern (cap 10 attempts) to all three. After cap exhausted: emit `'stt-permanently-unavailable'` event + surface a UI notification + transition to REST fallback if available. Reset on user explicit retry.
**Acceptance:** Simulated 5-minute network outage produces no more than 10 reconnect attempts per provider; user gets a clear UI prompt to retry.

### E2 [P0] No client-side STT key pool with backoff
**Where:** Audit §2.8. Only `NativelyProSTT` has any key coordination (server-side pool + client stagger). For Deepgram/Soniox/ElevenLabs/OpenAI a user with multiple keys gets no automatic rotation on rate-limit.
**Why it matters:** Power users with multiple BYOK keys can't survive a per-key rate-limit; their session hard-fails until manual swap.
**Fix:** Add a generic `KeyPool<T>` in `electron/services/`. Round-robin with per-key exponential backoff (1s → 30s, cap 5 attempts before retiring key for the session). Wire into Deepgram/Soniox/ElevenLabs/OpenAI constructors via a `keys: string[]` parameter (today: single `apiKey`). Surface in Settings UI as a comma-separated keys field per provider.
**Acceptance:** When one of 2 configured keys returns 429, next request transparently rotates to the other key within 1 s.

### E3 [P1] Cross-provider failover on STT outage
**Where:** STT layer doesn't fail across providers — if Deepgram dies, the meeting transcript dies.
**Why it matters:** Every competitor faces the same outage risk; the one that survives wins user trust.
**Fix:** Add a `STTFailoverPolicy` config in SettingsManager: ordered list of `[Deepgram, Soniox, NativelyPro, OpenAI-WS]`. When current STT emits `'stt-permanently-unavailable'`, instantiate the next provider. Re-pipe audio. Log degradation.
**Acceptance:** Mocked Deepgram 503 in a live session → transcript continues from Soniox within 3 s of the failure.

### E4 [P2] ElevenLabs debug raw write at `~/elevenlabs_debug.raw` — verify guard against packaged builds
**Where:** `ElevenLabsStreamingSTT.ts:40–48`.
**Fix:** Wrap in `if (!app.isPackaged) { ... }` or remove. Privacy concern: this writes raw user audio to disk. Even dev-only is a risk in dev-build screen recordings.

### E5 [P2] `MeetingPersistence` broadcasts via raw `getAllWindows().forEach`
**Where:** `MeetingPersistence.ts:78–79`.
**Fix:** Use the scoped helper at `main.ts:3640–3655` (`_broadcastToAllWindows`). Trivial.

---

## Category F — UX moats Natively already has (defend + amplify)

### F1 BYOK + local Ollama
**Where:** `LLMHelper.ts:3300` (`streamWithOllama`), `electron/rag/OllamaBootstrap.ts`, `electron/services/OllamaManager.ts`. STT side: 8 providers all BYOK.
**Why it matters:** Every competitor locks you into their cloud. Cluely's 83k-user breach is the textbook lesson on why that's bad — all 83k users had no choice but to entrust meeting transcripts + screen captures to a single closed vendor with a public-repo password.
**Amplify:**
- README must lead with this. Currently it's not the headline (line 1).
- Add a "0 data to Natively servers" badge to settings UI when in pure-Ollama mode.
- Document the offline path explicitly: which features work fully offline (transcript, embedding, RAG, local LLM) vs which need cloud (vision, Claude/GPT).

### F2 Local SQLite RAG with bundled embedding model
**Where:** `electron/rag/`, bundled `Xenova/all-MiniLM-L6-v2` at `resources/models/`. DatabaseManager v14 with sqlite-vec.
**Why it matters:** Cluely had no persistent local meeting memory (and lost everything in the breach). Final Round / LockedIn / Verve / Linkjob / Parakeet all keep meeting transcripts server-side. Natively is the only one of the eight where meeting memory genuinely lives on-disk under the user's control.
**Amplify:**
- Fix the README drift (`bge-small-en-v1.5` → `all-MiniLM-L6-v2`).
- Document the privacy boundary: "your meetings never leave your laptop unless you BYOK a cloud LLM provider."
- Consider upgrading the bundled embedding model to `bge-small-en-v1.5` for real (it's ~33% better on MTEB; 384d matches MiniLM dim).

### F3 Open source AGPL-3.0
**Where:** `LICENSE`.
**Why it matters:** Auditability is the only counter to Cluely's "we lied about ARR" + "admin password in public GitHub" + "DMCA the security researcher" trust collapse. AGPL specifically — not MIT — because a copyleft license forces hostile forks to remain open.
**Amplify:**
- Marketing copy should say "every byte of Natively is auditable on GitHub. Cluely's security researcher got a DMCA. Natively's gets a PR review."
- Pin a `SECURITY.md` link from the README hero.

### F4 BYO-model picker (no auto-routing required)
**Where:** `modelFetcher.ts` discovers live models from each provider; `ModelSelectorWindowHelper.ts` exposes the picker.
**Why it matters:** Final Round picks for you (opaque). Linkjob gates models by tier (you pay for Opus). Natively lets the user pick any model their key has access to.
**Amplify:**
- Add a one-line cost estimate to the model-picker UI per provider+model ("Claude Opus 4.6 ≈ $0.40/answer").
- Surface auto-routing (C3) as an *opt-in*, not a default. Power users want manual control.

### F5 Native Rust audio module + CGEventTap stealth keyboard
**Where:** `native-module/src/{lib,keyboard_tap,stealth_window}.rs`.
**Why it matters:** Cluely is Electron-only with web audio; Parakeet runs as `pmodule` (visible). Natively's native Rust + CGEventTap is genuinely lower-level and a real technical moat against the "interpreted-language process enumeration" detection vector.
**Amplify:** Document this on the website. The phrase "Rust audio core, CGEventTap stealth keyboard, AGPL on GitHub" lands very differently from "AI-powered overlay" marketing.

---

## Category G — Pricing positioning

Competitor pricing (per competitor-matrix.md):
- Cluely $20 Pro / $0 Starter — undermined by 83k breach + ARR fraud
- LockedIn $54.99 / $29.99 quarterly
- Verve $59.50 Pro / $38.25 Standard
- Interview Solver $39 / $30 quarterly
- Linkjob $99.99 / $29.99 yearly / **$699.99 lifetime**
- Parakeet $74.90 credit
- Final Round $148 / $96 / $81

### G1 [P1] Position vs Cluely's $20: trust premium, not price match
Recommended copy:
> "Cluely is $20/month and lost 83,000 users' meeting transcripts. Natively is open-source, runs on your machine, and you control every key. $X/month, BYOK, AGPL."
Don't try to undercut $20 — race-to-zero is a loser when Cluely already raised $20M to subsidise pricing. Compete on *honesty* and *ownership*.

### G2 [P2] Lifetime tier vs Linkjob's $699.99
Linkjob's lifetime offering is structurally different — every other competitor is subscription-only. A Natively lifetime tier ($499–$799) gated to BYOK (so no recurring server-side STT cost falls on us) is a credible structural answer. Bundled with the open-source binary already being free, this works because the paid features are Premium-only (`premium/` submodule).

---

## Cross-cutting summary — top 10 fixes ranked by impact / effort

| Rank | Gap | Category | Effort | Impact |
|---|---|---|---|---|
| 1 | A1 — Memoize message rows + hoist Markdown components | A | 1 day | Eliminates the dominant in-meeting CPU storm |
| 2 | B4 — Compress screenshots before OpenAI/Claude/Gemini | B | 0.5 day | ~10× bandwidth + cost on vision |
| 3 | A2 — Fix endMeeting stop latency (250ms sleep + sync stops) | A | 0.5 day | -500 ms stop UX every time |
| 4 | A3 — Pre-warm STT WebSockets | A | 1 day | First-second-of-meeting TTFT |
| 5 | C1 — Glance-first SAY FIRST output format | C | 1 day | Closes the #1 UX gap vs Cluely/Final Round |
| 6 | B1 — Strip CORE_IDENTITY duplication in mode prompts | B | 0.5 day | -1800 tokens / request |
| 7 | D1 — Cropper native stealth | D | 0.5 day | Closes a real stealth leak |
| 8 | E1 — Cap unbounded STT reconnect loops | E | 0.5 day | Hard reliability win |
| 9 | B2 — OpenAI prompt_cache_key | B | 0.5 day | Reliable prefix caching |
| 10 | B3 — Gemini cachedContent API | B | 2 days | ~25% Gemini cost on cache hit |

These 10 = ~8 days. Phase 4 [`docs/improvement-roadmap.md`](./improvement-roadmap.md) sequences them into a 4-week plan with acceptance criteria.
