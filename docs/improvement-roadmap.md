# Natively — 4-Week Improvement Roadmap

**Date:** 2026-05-11
**Inputs:** [`docs/internal-audit.md`](./internal-audit.md), [`docs/competitor-matrix.md`](./competitor-matrix.md), [`docs/gap-analysis.md`](./gap-analysis.md), [`PERF_AUDIT.md`](../PERF_AUDIT.md).
**Status:** Proposal, not yet started.

---

## Marketing positioning we can claim after shipping Sprint 1 (items 1–5 here)

> **Natively is the only open-source interview & meeting copilot. We measure response time in milliseconds — not seconds like Cluely (5–90 s) or Final Round (mid-call freezes). Every byte runs on your laptop unless you choose otherwise. Every key is yours. Every line of code is on GitHub under AGPL-3.0.**
>
> **After Sprint 1 (one week from start):**
> - **Streaming answers don't stutter.** A 400-token Groq answer renders smoothly at 60 fps on a 2020 i5 (today: 100% CPU pegged).
> - **Stop button is instant.** Click Stop → UI flips in < 100 ms (today: 500–800 ms).
> - **Vision costs 90% less.** Screenshots are JPEG q85 before they hit OpenAI/Claude/Gemini — same answer quality, ~10× smaller payload.
> - **First word of every meeting transcribes in < 300 ms.** STT WebSockets are pre-warmed at app launch.
> - **Every answer leads with a 6-word headline you can say out loud while reading the bullets.** No more 4-paragraph prose dumps.
>
> Cluely lost 83,000 users' meeting transcripts in 2025. Final Round auto-bills $488 with no refund. LockedIn's "116 ms" was marketing — real users measure 2–4 s. Natively publishes its measurements, its source, and its security disclosures. If you don't trust the binary, run it from source. If you don't trust our cloud, we don't have one — BYOK or Ollama only.

---

## Conventions

- **Each task is a single concrete unit of work** with a file:line entry point, expected change, and verification step.
- **Effort estimates** are eng-days for one engineer familiar with the codebase.
- **Gap-ref** points back to [`gap-analysis.md`](./gap-analysis.md) section.
- **Each sprint ends with a tagged release**; production-stable behaviour over speed.

---

## Sprint 1 — "Stop stuttering, stop bleeding cost" (Week 1, ~5 eng-days)

The five wins that unlock the marketing positioning above. All are isolated, low-risk, and high-impact.

### S1.1 Memoize message rows + hoist ReactMarkdown components (Gap A1, PERF_AUDIT §3.1)
**Files:** `src/components/NativelyInterface.tsx:1816+` (messages.map body), `:1819–1832, :1853–1858` (ReactMarkdown `components` objects).
**Change:**
1. Extract `messages.map(...)` body into a `<MessageRow msg={msg} isLast={...} onCopyCode={...} />` component in a new file `src/components/MessageRow.tsx`.
2. Wrap with `React.memo((prev, next) => prev.msg.id === next.msg.id && prev.msg.text === next.msg.text && prev.msg.isStreaming === next.msg.isStreaming)`.
3. Hoist all `components` map objects passed to `ReactMarkdown` to module scope (or `useMemo` if they close over props).
**Effort:** 1.0 day.
**Acceptance:**
- DevTools Performance: a 10 s streaming `What-to-answer` answer shows renderer CPU < 30% on a 2020 i5 (today: 60–100%).
- Profiler flame graph: `ReactMarkdown` / Prism stack no longer dominates.
- Manual smoke: no regressions in copy-code, code-block fold, code-visibility tween.

### S1.2 Drop the 250 ms blocking sleep + parallel native capture stop (Gap A2, PERF_AUDIT §2.1/§2.2)
**Files:** `electron/main.ts:1782, :1778–1779` (inside `endMeeting`).
**Change:**
1. Move the 250 ms STT-grace `setTimeout` into the existing fire-and-forget background IIFE that already handles RAG cleanup.
2. Replace `this.systemAudioCapture?.stop(); this.microphoneCapture?.stop();` with `Promise.all([new Promise(r => setImmediate(() => { this.systemAudioCapture?.stop(); r(undefined); })), /* same for mic */]).catch(noop);`. IPC handler returns immediately after `isMeetingActive = false`.
3. Confirm `_isDraining` correctly gates trailing transcripts.
**Effort:** 0.5 day.
**Acceptance:**
- `console.time('endMeeting-ipc')` reports < 100 ms (today: 500–800 ms).
- Trailing transcript still lands within 500 ms.

### S1.3 Compress screenshots for OpenAI / Claude / Gemini (Gap B4)
**Files:** `electron/LLMHelper.ts:3064–3071, :3097–3110, :3156–3167`.
**Change:** Apply the same `sharp` `.resize({ width: 1920, withoutEnlargement: true }).jpeg({ quality: 85 })` pipeline that `streamWithNatively` already uses (`:2814–2837`) to OpenAI multimodal, Claude multimodal, and Gemini paths.
- For OpenAI: emit `data:image/jpeg;base64,...` instead of PNG.
- For Claude: `media_type: 'image/jpeg'`.
- For Gemini: `mimeType: 'image/jpeg'`.
**Effort:** 0.5 day.
**Acceptance:**
- Mean screenshot payload < 500 KB (was 3–5 MB).
- Vision-task test set: zero regression in legibility of code, terminal text, slide deck text.

### S1.4 Pre-warm STT WebSockets at app launch (Gap A3, PERF_AUDIT Sprint-2 #8)
**Files:** `electron/main.ts:3711–3768` (`initializeApp`), `electron/main.ts:1141–1153` (`setupSystemAudioPipeline`).
**Change:**
1. After `CredentialsManager` init, eagerly construct (but do not `start()`) the user's configured primary STT provider for both system + mic channels.
2. Constructor opens the WS handshake; `start()` only sends the start signal + first audio.
3. On `startMeeting`, replace lazy construction with a check: if pre-warmed instance exists, use it; else fall through to today's lazy path.
4. Add idle timeout — close pre-warmed sockets after 5 min of no meeting; reopen on next start.
**Effort:** 1.0 day.
**Acceptance:**
- First transcript chunk of a fresh meeting < 300 ms after first user audio (today: 600–1400 ms).
- App-launch time penalty < 100 ms (WS opens async; no blocking).

### S1.5 Glance-first "SAY FIRST" output format (Gap C1)
**Files:** `electron/llm/prompts.ts` — `EXECUTION_CONTRACT` (`:87–103`), all 7 `MODE_*_PROMPT` constants, plus `TINY_*` variants.
**Change:**
1. Add to `EXECUTION_CONTRACT`:
   ```
   OUTPUT FORMAT (default, all modes unless overridden):
   SAY FIRST: <≤8-word opener you can speak out loud while reading the rest>
   - <bullet 1, ≤15 words>
   - <bullet 2, ≤15 words>
   ```
2. Coding-mode override in `MODE_TECHNICAL_INTERVIEW_PROMPT`: "Code FIRST in a fenced block, complexity-analysis SECOND in a single sentence, no SAY FIRST opener for pure-code responses."
3. Behavioral-mode override in `MODE_LOOKING_FOR_WORK_PROMPT` + `MODE_TEAM_MEET_PROMPT`: "STAR scaffolding (Situation 1 line, Task 1 line, Action ≤2 lines, Result 1 line), SAY FIRST opener still required."
4. Mirror the same edits in `electron/llm/tinyPrompts.ts`.
**Effort:** 1.0 day (incl. manual eval).
**Acceptance:**
- Manual eval of 20 mixed questions per mode: every non-coding response opens with `SAY FIRST: <opener>`; every coding response opens with a fenced code block.
- No regression in factual quality.

**Sprint 1 cumulative effort: 4 days. Buffer: 1 day for QA / regression / version bump.**

---

## Sprint 2 — "Stop wasting tokens, stop dropping sessions" (Week 2, ~5 eng-days)

Once Sprint 1 ships the perceived-quality wins, Sprint 2 fixes the cost + reliability layer that determines unit economics.

### S2.1 Strip CORE_IDENTITY duplication from mode prompts (Gap B1)
**Files:** `electron/llm/prompts.ts:1010, :1118, :1263, :1362, :1455, :1546, :1638` (and `tinyPrompts.ts` parallels).
**Change:** Remove the leading `${CORE_IDENTITY}\n${EXECUTION_CONTRACT}\n\n` from every `MODE_*_PROMPT` (and tiny equivalents). The dispatcher already prepends them via `HARD_SYSTEM_PROMPT` + mode suffix at `LLMHelper.ts:2554–2557`.
Add a unit test in `electron/__tests__/promptAssembly.test.ts`:
```ts
test('rendered system prompt contains CORE_IDENTITY exactly once', () => {
  const sys = LLMHelper.buildClaudeSystemBlocks(modeId).map(b => b.text).join('\n');
  expect(sys.match(/You are Natively/g)?.length).toBe(1);
});
```
**Effort:** 0.5 day.
**Acceptance:** Claude API `usage.input_tokens` on the same query drops ~1800 tokens before/after. No regression in answer quality (20-question A/B eval).

### S2.2 Set `prompt_cache_key` on every OpenAI request (Gap B2)
**Files:** `electron/LLMHelper.ts:3005–3009, :3059–3071` (streamWithOpenai + multimodal).
**Change:**
```ts
const cacheKey = createHash('sha256').update(`${modeId}|${modelId}|${personaId ?? 'default'}`).digest('hex').slice(0, 32);
const resp = openai.chat.completions.stream({ model, messages, stream: true, prompt_cache_key: cacheKey, ... });
```
Reference: <https://platform.openai.com/docs/guides/prompt-caching>.
**Effort:** 0.5 day.
**Acceptance:** OpenAI usage dashboard shows `cached_tokens` > 60% of input tokens during a sustained mode-stable session.

### S2.3 Wire Gemini `cachedContent` API for static prompts (Gap B3)
**Files:** `electron/LLMHelper.ts:3146–3179` (the existing TODO + `streamWithGeminiModel`).
**Change:**
1. New module `electron/llm/geminiCache.ts`:
   ```ts
   class GeminiCacheRegistry {
     private cache = new Map<string, { name: string; expiresAt: number }>();
     async getOrCreate(modeId: string, modelId: string, systemPrompt: string): Promise<string> { ... }
     async invalidate(modeId: string, modelId: string): Promise<void> { ... }
   }
   ```
2. On app launch: pre-warm cache entries for the current mode + Gemini Flash + Pro. TTL 3600 s.
3. In `streamWithGeminiModel` (`:3170–3179`), prefer `config.cachedContent: name` over inline `systemInstruction` when registry has a fresh entry.
4. Renew on use (extend TTL when used in last 50% of window).
5. Invalidate on mode change.
Reference: <https://ai.google.dev/gemini-api/docs/caching>.
**Effort:** 2.0 days.
**Acceptance:** Gemini `usage_metadata.cachedContentTokenCount` > 0 on consecutive same-mode requests. Cache rebuild < 5 s on mode switch.

### S2.4 Cap unbounded STT reconnect loops (Gap E1)
**Files:** `electron/audio/ElevenLabsStreamingSTT.ts:352–365`, `electron/audio/SonioxStreamingSTT.ts:344–361`, `electron/audio/NativelyProSTT.ts:459, :468`.
**Change:** Apply Deepgram's pattern uniformly:
```ts
const RECONNECT_MAX_ATTEMPTS = 10;
if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
  this.emit('stt-permanently-unavailable');
  return;
}
```
Add a corresponding renderer-side notification in `NativelyInterface.tsx` to surface the failure.
**Effort:** 0.5 day.
**Acceptance:** Simulated 5-minute network outage → no more than 10 reconnects per provider; user sees a "Reconnect transcription?" toast.

### S2.5 Cropper native stealth (Gap D1)
**Files:** `electron/CropperWindowHelper.ts:362–440`, native module N-API export.
**Change:** In `applyOpacityShield`, after `setContentProtection(true)`, call `nativeModule.applyStealthToWindow(this.cropperWindow.getNativeWindowHandle())` on macOS. Match the pattern at `WindowHelper.ts:344–359`.
**Effort:** 0.5 day.
**Acceptance:** 60 fps screen-recorder test on macOS 14/15: cropper invocation produces zero frontmost-promotion flash.

### S2.6 Compress + cap context budget for cloud LLM (Gap B5)
**Files:** `electron/LLMHelper.ts` — wrap `streamGenerateWithImages` entry; new helper in `electron/llm/contextBudget.ts`.
**Change:**
```ts
function capUserPayloadToBudget(payload, modelId, reservedOutput = 8192) {
  const limit = getModelCapabilities(modelId).maxContextTokens - SYSTEM_TOKEN_ESTIMATE - reservedOutput;
  // shift oldest transcript lines until estimateTokens(payload) < limit
  // always preserve detected-question marker + last 3 turns
}
```
Use `js-tiktoken` for OpenAI; chars-÷-4 for Claude/Gemini (good enough approximation).
**Effort:** 1.0 day.
**Acceptance:** Mean input tokens per request ≤ 8 K (non-Opus) / ≤ 16 K (Opus). No regression in answer relevance (manual eval).

**Sprint 2 cumulative effort: 5 days.**

---

## Sprint 3 — "Auto-route by question type + sentence-boundary gating" (Week 3, ~5 eng-days)

Sprint 3 turns Natively from a "single model picks for the whole session" tool into an intent-aware copilot. This is where we close the differentiation gap vs Verve's domain copilots and Final Round's STAR scaffolding.

### S3.1 Sentence-boundary gate on auto-trigger (Gap A4)
**Files:** `electron/IntelligenceEngine.ts:170–175`.
**Change:**
```ts
async handleSuggestionTrigger(trigger: SuggestionTrigger) {
  if (trigger.confidence < this.confidenceThreshold) return;  // raise to 0.7 (S3.2)
  const last = trigger.lastQuestion.trimEnd();
  const endsSentence = /[.!?]\s*$/.test(last) || trigger.endedOnSpeechEnd === true;
  if (!endsSentence) {
    this.pendingTrigger = trigger;
    setTimeout(() => this.maybeFlushPending(), 1500);
    return;
  }
  await this.runWhatShouldISay(...);
}
```
**Effort:** 1.0 day (incl. tests).
**Acceptance:** No LLM call fires on a `lastQuestion` ending mid-word in a synthetic transcript-replay test.

### S3.2 Raise auto-trigger confidence threshold to 0.7 + add cancelled-trigger replay hotkey (Gap C2)
**Files:** `electron/IntelligenceEngine.ts:170–175`, `electron/services/KeybindManager.ts`, renderer.
**Change:**
1. Raise threshold from 0.5 to 0.7.
2. Store the last cancelled `SuggestionTrigger` in `IntelligenceEngine`.
3. Add hotkey `general:replay-cancelled-trigger` (default `Ctrl+Shift+R`) that calls `runWhatShouldISay(cancelled.lastQuestion, 1.0)`.
4. Surface a small UI affordance: "Last skipped question: 'Tell me about a time...'" with a "Use this" button.
**Effort:** 1.0 day.
**Acceptance:** Auto-fire rate drops ~30% in dogfood. User can manually escalate via hotkey within 1 click.

### S3.3 Multi-model routing per question intent (Gap C3)
**Files:** new `electron/llm/modelRouter.ts`, `electron/IntelligenceEngine.ts:236+` (`runWhatShouldISay`).
**Change:**
```ts
// modelRouter.ts
export function selectModelForQuestion(intent: Intent, mode: ModeId, userOverride: string | null): { modelId: string; provider: Provider } {
  if (userOverride) return resolveOverride(userOverride);
  if (mode === 'technical-interview') {
    if (intent === 'coding') return { modelId: 'claude-sonnet-4-6', provider: 'claude' };
    if (intent === 'system-design') return { modelId: 'claude-opus-4-6', provider: 'claude' };
    return { modelId: 'gemini-3.1-flash-lite-preview', provider: 'gemini' };
  }
  if (intent === 'behavioral') return { modelId: 'gemini-3.1-flash-lite-preview', provider: 'gemini' };
  return { modelId: 'gemini-3.1-flash-lite-preview', provider: 'gemini' };
}
```
Wire into `IntelligenceEngine.runWhatShouldISay` after `IntentClassifier.classifyIntent` (`:305–309`).
Persist a `autoRoutingEnabled` setting; default `false` (opt-in to respect F4).
**Effort:** 2.0 days.
**Acceptance:** With auto-routing on, P50 TTFT on behavioral drops, P50 correctness on coding rises (measured against a fixed test set of 20 coding + 20 behavioral questions).

### S3.4 Code-mode prompt differentiation (Gap C4 — partly delivered via S1.5)
**Files:** `electron/llm/prompts.ts` — `MODE_TECHNICAL_INTERVIEW_PROMPT` (`:1638`).
**Change:** Tighten the code-first override added in S1.5: explicit "no preamble line, no apology line, fenced code block as the first non-whitespace content." Add an example.
**Effort:** 0.5 day.
**Acceptance:** Manual eval: 20 coding questions all produce code as the first non-whitespace content.

### S3.5 STAR scaffolding for behavioral modes (Gap C5)
**Files:** `electron/llm/prompts.ts` — `MODE_LOOKING_FOR_WORK_PROMPT` (`:1118`), `MODE_TEAM_MEET_PROMPT` (`:1455`).
**Change:** Add explicit STAR scaffolding rule (1 line each, action ≤2 lines).
**Effort:** 0.5 day (already partly in S1.5; needs eval iteration).
**Acceptance:** Manual eval — behavioral responses parse cleanly into STAR slots.

**Sprint 3 cumulative effort: 5 days.**

---

## Sprint 4 — "Stealth hardening + key pool + competitor parity" (Week 4, ~5 eng-days)

Sprint 4 hardens the differentiators that take longer to ship but matter to power users + enterprises.

### S4.1 STT key pool with backoff (Gap E2)
**Files:** new `electron/services/KeyPool.ts`, `electron/audio/{Deepgram,Soniox,ElevenLabs,OpenAI}StreamingSTT.ts` constructors.
**Change:**
1. `class KeyPool<T> { constructor(keys: string[]); next(): string; markFailed(key, ttl): void; }` — round-robin with per-key exponential backoff (1 s → 30 s, cap 5 attempts before retirement).
2. Refactor each STT constructor to accept `keys: string[]` (today: single `apiKey`).
3. Settings UI: per-provider "Comma-separated keys (for high-volume use)" field.
**Effort:** 2.0 days.
**Acceptance:** With 2 keys configured for Deepgram, a 429 on key A transparently rotates to key B within 1 s. No transcript drop.

### S4.2 Cross-provider STT failover (Gap E3)
**Files:** new `electron/audio/STTFailoverManager.ts`, `electron/main.ts:1071–1169` (`setupSystemAudioPipeline`).
**Change:** Add `STTFailoverPolicy` config: ordered list `[deepgram, soniox, nativelypro, openai-ws]`. When current STT emits `'stt-permanently-unavailable'` (from S2.4), instantiate next; re-pipe audio. Surface UI degradation badge.
**Effort:** 1.5 days.
**Acceptance:** Mocked Deepgram 503 in live session → transcript resumes from Soniox in ≤ 3 s. UI shows "Switched to Soniox".

### S4.3 Windows direct `SetWindowDisplayAffinity` FFI (Gap D2)
**Files:** `native-module/src/stealth_window.rs` (add Windows cfg-gated module), N-API export, `electron/WindowHelper.ts` blur handler.
**Change:** Call `SetWindowDisplayAffinity(handle, WDA_EXCLUDEFROMCAPTURE)` directly via Win32 FFI. Re-assert on `blur` event + monitor-change event (mirror `setAlwaysOnTop` re-assertion at `:467–473`).
**Effort:** 1.0 day.
**Acceptance:** Multi-monitor hotplug stress (100 plug-unplug cycles) — content protection still applied, verifiable via `GetWindowDisplayAffinity`.

### S4.4 Click-through pass-through extended to launcher (Gap D3)
**Files:** `electron/WindowHelper.ts:544–567` (extend pattern), `electron/services/KeybindManager.ts`.
**Change:** Apply `setIgnoreMouseEvents(true, { forward: true })` to launcher when global pass-through hotkey toggled. Add a brief cursor change (CSS) to signal pass-through is active.
**Effort:** 0.5 day.
**Acceptance:** Manual test: launcher open over VS Code → pass-through hotkey enables clicks-through-to-VS-Code without dismissing launcher.

### S4.5 Fix MeetingPersistence raw broadcast + README drift + dev-only debug raw (Gaps E5, F2 doc-drift, E4)
**Files:** `electron/MeetingPersistence.ts:78–79`, `electron/audio/ElevenLabsStreamingSTT.ts:40–48`, `README.md`.
**Change:**
1. Replace raw `getAllWindows().forEach(...send)` with scoped `_broadcastToAllWindows` helper from `main.ts:3640–3655`.
2. Guard `~/elevenlabs_debug.raw` write behind `!app.isPackaged`.
3. Fix README references: `bge-small-en-v1.5` → `all-MiniLM-L6-v2` (or upgrade the bundled model — defer to S4.6).
**Effort:** 0.5 day.
**Acceptance:** No raw broadcasts. No dev-debug raw writes in packaged builds. README accurate.

### S4.6 Optional: upgrade bundled embedding model to bge-small-en-v1.5
**Files:** `resources/models/`, `scripts/download-models.js`, `electron/rag/providers/LocalEmbeddingProvider.ts:7–8, 57`.
**Change:** Replace `Xenova/all-MiniLM-L6-v2` (384d) with `Xenova/bge-small-en-v1.5` (384d, ~33% better on MTEB retrieval). Both are 384d, so existing `vec_chunks_384` schema is preserved.
Reference: <https://huggingface.co/Xenova/bge-small-en-v1.5>.
**Effort:** 0.5 day + 0.5 day re-embed migration tooling for existing users.
**Acceptance:** Retrieval F1 on internal eval rises by measurable amount. Cold-start migration: existing meetings remain queryable via fallback path; new meetings use bge.

**Sprint 4 cumulative effort: 6 days. Buffer: -1 day; scope S4.6 to the optional bucket.**

---

## Backlog (out of 4-week scope, in priority order)

These didn't fit but are worth tracking:

| ID | Gap | What | Effort |
|---|---|---|---|
| B1 | F1/F3 marketing | Rewrite README hero with "BYOK + open-source + no cloud" positioning per the marketing section above | 0.5 day |
| B2 | D4 | Install-time binary rename (counter Truely/Talview process enumeration) | 2 days |
| B3 | D5 | macOS 15 ScreenCaptureKit testing harness — regression-check against Zoom/Teams/Meet quarterly | 1 day |
| B4 | C3+ | Race two providers for first 300 ms of streaming (`racePair`) | 2 days |
| B5 | F4 | Cost-estimate badge on model-picker UI | 1 day |
| B6 | F1 | Local OCR via Apple Vision FFI (saves cloud cost when user asks "what's on screen?") | 3 days |
| B7 | PERF Sprint 3 | Split NativelyInterface into 5–6 child components (long-term maintainability) | 5 days |
| B8 | PERF §3.9 | Time-batched IPC token sends already shipped per audit — verify + remove dead code | 0.5 day |
| B9 | G2 | Lifetime pricing tier (counter Linkjob's $699.99) — product + billing infra | 5 days |
| B10 | C2+ | Cancelled-trigger UI affordance (small "skipped questions" list pane) | 1 day |

---

## Acceptance / verification framework

Every sprint ends with a fixed verification checklist run on the same hardware (2020 i5 MBP + Windows 11 Surface) against the same test corpus (20 mixed interview questions across 4 modes). Metrics tracked in `docs/perf-baseline.md` (to create):

| Metric | Today baseline (estimated) | Sprint 1 target | Sprint 2 target | Sprint 3 target | Sprint 4 target |
|---|---|---|---|---|---|
| Renderer CPU during 10s stream | 60–100% | < 30% | < 30% | < 30% | < 30% |
| Stop-button → UI flip | 500–800 ms | < 100 ms | < 100 ms | < 100 ms | < 100 ms |
| First-transcript TTFT | 600–1400 ms | < 300 ms | < 300 ms | < 300 ms | < 300 ms |
| Screenshot payload | 3–5 MB | < 500 KB | < 500 KB | < 500 KB | < 500 KB |
| Mean input tokens / cloud request | unknown (full-window) | unknown | ≤ 8 K | ≤ 8 K | ≤ 8 K |
| OpenAI cache hit ratio | < 30% expected | < 30% | > 60% | > 60% | > 60% |
| Gemini cachedContentTokenCount | 0 | 0 | > 0 | > 0 | > 0 |
| Auto-fire false positives (manual judge of 50 triggers) | ~20% | ~20% | ~20% | < 5% | < 5% |
| Output format: "SAY FIRST" opener present | 0% | 100% non-coding / N/A coding | same | same | same |
| STT reconnect storms during simulated 5-min outage | unbounded | unbounded | bounded ≤ 10/provider | same | same |
| Stealth: cropper-induced frontmost flash on macOS 14/15 | flashes | flashes | not visible | not visible | not visible |
| Multi-key 429 failover < 1 s | N/A (no pool) | N/A | N/A | N/A | yes |

---

## Risks + mitigations

1. **S2.3 (Gemini cachedContent) cache invalidation race.** If a user switches mode mid-stream the cache handle may be torn down before the in-flight request finishes. Mitigation: only invalidate after current stream completes; LRU-keep 4 mode handles per model.
2. **S3.3 (Auto-routing) opacity to user.** Users may see the model name in the UI change unexpectedly. Mitigation: default off; surface the routing decision in a small chip next to each answer ("Routed: Claude Sonnet ↔ coding intent detected").
3. **S4.6 (bge-small) breaking existing RAG queries.** Migration must be opt-in or backward-compatible. Mitigation: keep both models bundled, dual-write to `vec_chunks_384_bge` and `vec_chunks_384_minilm` for one release cycle; cut over in v15 schema migration.
4. **S1.5 (SAY FIRST format) breaking existing user expectations.** Power users who like prose may dislike the new format. Mitigation: add a `outputFormat: 'glance-first' | 'prose'` setting; default `glance-first`.
5. **Marketing claim drift.** If we ship Sprint 1 but the README still says "AGPL-3.0" without leading with it, the positioning copy is unsupported. Mitigation: README rewrite is part of the Sprint 1 release-PR checklist, not a separate task.

---

## Done definition for the 4-week roadmap

- All Sprint 1–4 tasks shipped to `main` and tagged in a release.
- `docs/perf-baseline.md` populated with measured numbers vs the targets in the framework above.
- README hero rewritten with the marketing positioning at the top of this doc.
- Each gap in [`gap-analysis.md`](./gap-analysis.md) marked Closed / Partially Closed / Deferred with a one-line explanation.
- One quote-ready paragraph published on the project blog for each of the 5 Sprint-1 wins.
