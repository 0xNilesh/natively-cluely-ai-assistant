# Intelligence OS Live-Wiring — Verification Code Review

Reviewer: code-reviewer (verification only — no code changed)
Date: 2026-06-13
Branch: `fix/whisper-external-data-download`
Scope: PRs #311/#312/#313 (Intelligence OS, 16 phases) + 5 Hindsight commits + uncommitted working tree.

## Review baseline (corrected)

The task brief assumed the wiring lived only on this branch. It does NOT. The wiring is
already merged into `main`. The actual merge-base of this branch is `3485d8d`
("live recall on the manual answer path"), so `git diff main...HEAD` shows almost none
of the wiring files. I re-based the review on the real pre-wiring commit `c430097`
(the commit before `27fa08d` "additive component library") and reviewed:

- `git diff c430097..HEAD` for the committed wiring (~10,150 insertions across 70 files), and
- `git diff` for the uncommitted working tree (`LLMHelper.ts`, `WindowHelper.ts`,
  `src/App.tsx`, `src/components/StartupSequence.tsx`, `index.html`,
  `VisionProviderRegistry.ts`).

Verification gates run:
- `tsc -p electron/tsconfig.json --noEmit` on the full working tree → **0 errors**.
- `node --test electron/intelligence/__tests__/**/*.test.mjs` → **442 pass / 0 fail / 9 todo**.
- All 17 intelligence flags resolve **OFF** by default (verified against compiled `intelligenceFlags.js`).
- Empirical execution of compiled modules for the two highest-value findings (OutputShapeNormalizer fence corruption; flag-OFF snapshot).

A passing test suite is NOT treated as proof a path is live; live-path findings below are evidenced by import/consumer tracing, not tests.

---

## BLOCKER

None that block a flags-OFF ship. The one correctness defect (OutputShapeNormalizer) is gated behind a default-OFF flag, so it is HIGH, not BLOCKER. See "Release recommendation".

---

## HIGH

### H1 — OutputShapeNormalizer strips fenced code blocks AND Mermaid diagrams
`electron/intelligence/OutputShapeNormalizer.ts:71-77` → `electron/llm/answerPolish.ts:165-176` (`compressToSpeakable`)

**What's wrong.** `normalizeOutputShape` calls `compressToSpeakable(text)` when a non-coding
answer contains a visible scaffold label and `answerStyle === 'default'`. `compressToSpeakable`
opens with `let out = answer.replace(CODE_FENCE_RE, '')` — it **deletes every ```…``` fenced
block and never restores it** (unlike `cleanAnswerArtifacts`, which placeholder-swaps fences
and restores them). So any fenced code OR ```mermaid diagram embedded in a non-coding answer
is silently destroyed.

**Verified empirically** (compiled module, not a unit test):
```
input:  "Short Fit Summary: …\nMatching Experience: … \n```js\nconst x = computeAggregate(a,b);\n```\nWhy This Role: …"
output: "I am a strong match … I built a high-throughput service. Here is the core: It aligns perfectly …"
JS code preserved? -> false   (applied: ["compressed_to_speakable"])
```

**Why it matters.** This directly violates checklist item #9 ("normalization must not touch
fenced code"). The module's own header and `cleanAnswerArtifacts`' docstring both claim
"code blocks are preserved byte-for-byte" — that guarantee does NOT extend to
`compressToSpeakable`. A WTA answer that mixes a candidate-voice scaffold with an illustrative
snippet or a diagram loses it.

**Mitigation in place.** Reachable only when the `answerDiversityGuard` flag is ON
(default OFF) and only on the WTA path (IntelligenceEngine.ts:1493-1499), gated `!isCoding`.
Coding answers are skipped entirely (`isCoding` short-circuit at OutputShapeNormalizer.ts:59).

**Suggested fix (described).** Make `compressToSpeakable` fence-safe the same way
`cleanAnswerArtifacts` is: extract fences to placeholders before stripping scaffold labels and
restore them at the end; OR have `normalizeOutputShape` refuse to compress when
`CODE_FENCE_RE.test(text)` is true (skip compression for any answer containing a fence).

### H2 — Uncommitted LLMHelper rewrite removes tail-latency hedging on the core LLM path
`electron/LLMHelper.ts` (uncommitted, ~440 lines churned)

**What's wrong.** The uncommitted working-tree change is NOT Hindsight-related (the task
brief mischaracterized it). It rewrites the central Gemini provider path:
- Removes `VISION_HEDGE_ENABLED` / `TEXT_HEDGE_ENABLED` / `GEMINI_TEXT_HEDGE_CONFIG` and all
  flash↔flash-lite tail-latency hedging from BOTH the vision and direct-Gemini text paths
  (LLMHelper.ts ~97-110, ~3641, ~3708, ~4277).
- Replaces `streamWithGeminiParallelRace` + `collectStreamResponse` with a strict serial
  cascade `streamGeminiTextCascade` (flash-lite → flash → pro), LLMHelper.ts:5120.
- Removes `generateWithPro` (LLMHelper.ts ~1080).
- Reorders all provider chains to flash-lite-first (also `VisionProviderRegistry.ts`).

**Why it matters.** This reverses a documented, benchmark-driven latency fix. Prior release
work (2026-06-06) established the direct-Gemini text path NEEDED the flash→flash-lite hedge
because flash p95 TTFT was ~3.1s vs flash-lite ~0.55s, and 79/94 latency failures traced to
the un-hedged path. The new design leads with flash-lite (fast) so the common case is fine,
but a flash-lite STALL now serially waits out `ttftTimeoutMs` before flash starts — the exact
slow-tail the hedge was built to collapse. This is a meaningful product-latency regression
risk on the hot answer path and deserves its own benchmark gate before shipping.

**Status checks (clean).** No dangling references to the removed symbols
(`generateWithPro`, `streamWithGeminiParallelRace`, `collectStreamResponse`,
`VISION_HEDGE_ENABLED`, etc.) remain outside comments. `tsc --noEmit` passes. So the rewrite
COMPILES and is self-consistent — the risk is behavioral (latency), not a build break.

**Suggested fix (described).** Do not bundle this LLM-path rewrite into the Intelligence OS
release. Land it separately behind its own benchmark (`benchmark:wta` / latency p95 gate)
and ideally behind an env kill-switch so the serial-cascade vs hedge choice is reversible,
matching the previous `NATIVELY_TEXT_HEDGE` posture.

---

## MEDIUM

### M1 — IntelligenceMetrics is fully dead code (fake wiring)
`electron/intelligence/IntelligenceMetrics.ts` (exported `intelligenceMetrics`, `timed`)

**What's wrong.** No non-test file imports `IntelligenceMetrics` or `intelligenceMetrics`
(verified: `grep -rln IntelligenceMetrics electron/ | grep -v __tests__ | grep -v IntelligenceMetrics.ts` → empty).
The live timing sites (e.g. Hindsight recall) use `console.log({ ms })` instead of
`intelligenceMetrics.timing(...)`. The named metrics (`hindsight_recall_ms`,
`cross_user_leakage_detected_count`, `global_search_ms`, etc.) are never recorded.

**Why it matters.** The "observability metrics registry" the spec asks for exists and is
unit-tested but is not connected to anything — it cannot surface a leakage counter or a
latency histogram in production. It looks wired (clean API, tests green) but is inert.

**Suggested fix (described).** Either wire `intelligenceMetrics.timing/count/rate` at the
existing instrumented sites (recall, global/in-meeting search, meeting-memory extraction)
or mark the module explicitly as not-yet-wired in the rollout status so it isn't mistaken
for live telemetry.

### M2 — Preload-exposed IPCs with NO renderer consumer (fake end-to-end wiring)
`electron/preload.ts:1432-1442`, `src/types/electron.d.ts:247-252`, `electron/ipcHandlers.ts` (handlers exist)

**What's wrong.** Five IPC surfaces are wired backend → preload → typings but have **zero**
renderer callers (`grep -rn <fn> src/` → only `electron.d.ts`):
- `searchInMeeting` (`search:in-meeting`)
- `generateLectureNotes` (`lecture:generate-notes`)
- `generateDiagram` (`diagram:generate`)
- `getIntelligenceFlags` (`intelligence-flags:get`)
- `setIntelligenceFlag` (`intelligence-flags:set`)

Only `searchGlobalMeetings` is actually consumed (`src/components/Launcher.tsx:437`).

**Why it matters.** Phases 10/12/14 are advertised as "wired" but the user-facing half does
not exist — there is no in-meeting search box, no lecture-notes panel, no diagram button, and
no settings UI for the flag toggle. The backend is reachable only from a dev console. These
are not bugs (handlers are correct, flag-gated, return `{enabled:false}` when off), but they
are dead end-to-end paths. The flag-toggle IPC in particular means flags are env/Settings-only
in practice — there is no shipped UI to flip them.

**Suggested fix (described).** Either land the consuming UI or label these phases
"backend-ready, UI pending" in the rollout doc. Not a ship blocker (all default OFF, no caller
= no behavior).

### M3 — `recall()` Promise.race loser is not cancelled cleanly
`electron/intelligence/memory/HindsightClientAdapter.ts:99-114`

**What's wrong.** `recall` races `client.recall(...)` against a `setTimeout` that resolves
`{results:[]}` at `timeoutMs`. It also fires `controller.abort()` at `timeoutMs`. When the
timeout wins, the answer correctly proceeds with `[]`, but the underlying `client.recall`
HTTP promise may still be in flight; the abort signal is best-effort (depends on the 0.8.2
client honoring `signal`). The `setTimeout` that backs the race is not cleared if the real
call wins first (only the `controller` timer is cleared in `finally`).

**Why it matters.** Bounded and non-blocking (the answer never waits past `timeoutMs`), so
not a correctness/latency hazard for the live answer — but it leaves a dangling timer per
recall and relies on the client honoring abort. On the live path it's gated to backward-looking
queries with both Hindsight flags ON + a configured server, so frequency is low.

**Suggested fix (described).** Track the race timer and `clearTimeout` it in `finally` too;
or use a single shared timer for both the race fallback and the abort.

### M4 — Always-on startup animation is a returning-user behavior change (out of scope, uncommitted)
`src/App.tsx:91` (and removed `natively_seen_startup_v1` / `onboardingGetFlags` suppression), `index.html`, `WindowHelper.ts`

**What's wrong.** The uncommitted `App.tsx` change sets `showStartup` to `true`
unconditionally and deletes the "seen startup once" suppression (localStorage +
`onboarding.seenStartup`). The black-logo launch animation now plays on **every** launch.
Comment says this is intentional ("matching older app behavior from 93ee4a21").

**Why it matters.** This is a deliberate UX change unrelated to Intelligence OS, riding in the
same uncommitted batch as the LLMHelper rewrite. Returning users will see the splash every
launch. Flag-OFF safety for Intelligence OS is unaffected, but this should not be conflated
with the wiring release.

**Suggested fix (described).** Land separately from the Intelligence OS review; confirm the
always-on splash is a product decision.

---

## LOW

### L1 — Flag SettingsManager keys are not in the typed `AppSettings` schema
`electron/intelligence/intelligenceFlags.ts:118,197-198`; `electron/services/SettingsManager.ts:165` (typed `set<K extends keyof AppSettings>`)

The 17 flag setting keys (`intelligenceTraceEnabled`, `profileTreeV2Enabled`,
`hindsightMemoryEnabled`, …) are NOT declared in `AppSettings` (grep count 0).
`intelligenceFlags.ts` reaches SettingsManager via untyped `require()`, so `.get(spec.setting)`
/ `.set(spec.setting, value)` compile despite the `keyof AppSettings` constraint, and persist
dynamically (whole-object serialize). Works at runtime; fragile (no compile-time guard on the
key names, matching the known "SettingsManager untyped-key persistence" gotcha). The
defense-in-depth `hasOwnProperty(FLAGS, key)` guard (flags.ts:193) is good and prevents
prototype-pollution keys reaching `set`.

### L2 — `[HindsightLiveRecall]` console.log on the answer path
`electron/ipcHandlers.ts:1027`

Logs `{ ms, facts, injected }` (counts/timing only — no content, privacy OK) on every
backward-looking question when the recall flags are ON. Low frequency (gated to recall
queries), but it is an info-level log on the answer path. Consider gating behind a debug
flag or downgrading. Privacy is fine (no raw query/facts logged).

### L3 — `RECALL_RE` standalone tokens can over-trigger recall
`electron/intelligence/ContextRouter.ts:85`

`isBackwardLookingQuery` matches bare `\bhistory\b`, `\bbefore\b`, `\bearlier\b`. A coding/general
question like "explain the history of TCP" would match and (with both Hindsight flags ON +
server configured + non-coding) trigger an 800ms recall. Bounded and non-fatal, but a slightly
tighter pattern (require a meeting/conversation noun nearby) would reduce false recalls.
Identity questions do NOT match (verified) so identity stays deterministic.

### L4 — Messy commit hygiene (not a code defect)
`710c957` ("conversation-memory cleanup listener") bundles ~3,270 unrelated insertions (STT
relay docs, IntentClassifier worker, EmbeddingPipeline, browser-extension store assets). The
actual cleanup fix is ~11 lines. Hard to audit; note for future hygiene.

---

## NIT

- `electron/intelligence/SearchOrchestrator.ts:75` `now1e13 = 1e13` magic anchor is fine for
  purity but undocumented as "year ~2286" sentinel; a named const comment would help.
- IPC handler `search:global-meetings` force-labels Hindsight candidates `userId:'local'`
  (ipcHandlers.ts ~947) so the SearchOrchestrator isolation filter passes them unconditionally.
  Safe today (single-user desktop, Hindsight tags scope server-side), but the local isolation
  invariant is effectively a no-op for memory-source candidates — worth a comment that
  isolation for Hindsight relies on the tag builder, not the orchestrator filter.

---

## Checklist findings (item by item, with evidence)

1. **Modules imported by REAL paths vs dead?** Mostly real. Live: `IntelligenceTrace`
   (ipcHandlers + IntelligenceEngine + WhatToAnswerLLM), `ProfileTreeService` (ipcHandlers
   perspective guard), `ContextRouter` (ipcHandlers shadow + recall gate), `SearchOrchestrator`
   (global/in-meeting handlers), `ConversationMemoryService` (manual follow-up), `OutputShapeNormalizer`
   (WTA), `ContextFusionEngine`+`PromptAssemblerV2` (WTA SHADOW), `MeetingMemoryService`
   (MeetingPersistence), Hindsight chain (retain + recall + global search). **DEAD: IntelligenceMetrics (M1).**
   **Dead end-to-end (no UI consumer): searchInMeeting / lecture / diagram / flag-toggle IPCs (M2).**
2. **Flags read on live paths?** Yes — `isIntelligenceFlagEnabled` is read fresh per answer at
   every wiring site (ipcHandlers, IntelligenceEngine, WhatToAnswerLLM, MeetingPersistence,
   HindsightManager). No flag is inert; all 17 default OFF (verified). `durableMemoryWindow`
   is the only one that changes a LIVE answer when ON (points memory at `getDurableContext`,
   SessionTracker.ts:394 — exists and is correct).
3. **Fallbacks safe?** Yes. Every wiring site is wrapped in try/catch with the comment "never
   affects the answer", and the flag-OFF branch preserves the original code path (e.g.
   IntelligenceEngine.ts:857 keeps `getContext` when off; WhatToAnswerLLM `packet` is a `const`
   never reassigned; OutputShapeNormalizer `finalWtaAnswer = fullAnswer` when off). One CAVEAT:
   when the `answerDiversityGuard` flag is ON, H1 can corrupt fenced content — but that's a
   flag-ON defect, not a flag-OFF safety break.
4. **Privacy — query hashed, no raw content logged?** PASS. `IntelligenceTrace` stores
   `sha256(query).slice(0,12)` + length, content-free markers, regex-validated source labels,
   bounded ring buffer (IntelligenceTrace.ts:144-156). `IntelligenceMetrics` is numbers only.
   All new `console.*` log meetingId / counts / ms / provider / error.message — none log
   resume/JD/transcript/query text (verified by diff grep of all new console calls).
5. **Hardcoded user facts?** NONE. Grep for aetherbot/evin/names in intelligence modules → only
   a docstring describing a template (ProfileTreeService.ts:53). Perspective guard is a pure
   mode+identity classifier.
6. **Hidden network calls for identity questions?** NO. Identity probe short-circuits at
   ipcHandlers.ts:628 and returns BEFORE the Hindsight recall block (line 997). `RECALL_RE`
   does not match identity phrasings. Identity stays deterministic/fast-path.
7. **Can Hindsight crash/block a live answer?** NO. retain is enqueued to a background queue
   (HindsightRetainQueue, bounded 500, drops oldest, never awaited by caller, failures swallowed).
   recall is double-bounded (AbortController + Promise.race timeout, 800ms live ceiling),
   returns `[]` on error/timeout, gated to backward-looking non-coding queries with both flags
   ON + a configured+healthy server. Post-meeting retain runs in the already-background
   `processAndSaveMeeting` worker. HindsightManager.start/stop are fire-and-forget at boot/quit
   (main.ts:873,5619). Uncommitted LLMHelper changes are NOT Hindsight (see H2). One minor
   timer-cleanup nit (M3).
8. **Global search cross-user leak?** NO (for the shipped single-user desktop). SearchOrchestrator
   enforces `userId === scope.userId` (and org match) BEFORE ranking (SearchOrchestrator.ts:131).
   All desktop candidates are `userId:'local'`. Tests "Bob never surfaces Alice's data" pass.
   Caveat NIT: Hindsight memory candidates are force-labeled `local`, so their isolation relies
   on the server-side tag builder, not the orchestrator filter.
9. **OutputShapeNormalizer corrupt code/Mermaid?** YES — see H1 (flag-gated, default OFF).
10. **PromptAssemblerV2 / ContextFusion trust boundaries?** PASS. Fusion maps to the existing
    `TrustLevel` vocabulary, neutralizes untrusted injection (defense-in-depth,
    ContextFusionEngine.ts:198-199), suppresses profile in sales/lecture modes, protects
    priority≤4 from budget eviction. AssemblerV2 escapes low-trust content
    (`escapeInjection`+`escapeXml`, PromptAssemblerV2.ts:153) and renders trust attributes.
    Both run SHADOW-only in WTA (never drive the real `packet`).
11. **Background tasks bounded?** YES. Retain queue bounded+concurrency-1; recall timeouts;
    diagram input capped to 8000 chars before the nested-quantifier `SEND_RE`
    (ipcHandlers.ts:4153, DiagramIntelligenceService.ts:101 — ReDoS mitigated); global search
    scans a fixed 50-meeting window; conversation memory bounded 100 turns/session. No unbounded
    loops or unguarded floating promises found (Launcher uses `void (async…)()` deliberately).
12. **Race conditions / listener leaks?** Cleanup fix (710c957) is CORRECT — the `destroyed`
    listener registers once per WebContents via `_convoCleanupRegistered` Set, deletes on
    destroy, clears the session (verified against the diff). No per-call listener growth remains.
13. **Noisy info logs on hot path?** Minor — L2 (`[HindsightLiveRecall]`) and shadow markers,
    all low-frequency/flag-gated. No per-token logging.

---

## Flag-OFF safety verdict

**PASS — the app behaves as before when all intelligence flags are OFF.** Evidence:
- All 17 flags resolve OFF by default (verified against compiled `intelligenceFlags.js`).
- Every live wiring site has an explicit flag-OFF branch that preserves the original behavior:
  - durable memory window: `getContext` path retained (IntelligenceEngine.ts:857-859).
  - WTA output shape: `finalWtaAnswer === fullAnswer` when off (IntelligenceEngine.ts:1493-1499).
  - Fusion/AssemblerV2: shadow-only, `packet` const never reassigned (WhatToAnswerLLM.ts).
  - Context Router / Live Brain: shadow-only, observe markers only.
  - Conversation memory: consumed only when `conversationMemoryV2` is on; recording is harmless.
  - Search / lecture / diagram handlers: return `{enabled:false}` when off.
  - Hindsight retain/recall/global-recall: gated on flags AND a configured server → guaranteed
    Noop with no server (LongTermMemoryService.fromFlags).
- IntelligenceTrace/Metrics are zero-cost NO-OPs when off (shared NOOP singleton).
- **CAVEAT:** flag-OFF safety holds for the COMMITTED wiring. The UNCOMMITTED `LLMHelper.ts`
  rewrite (H2) changes the core LLM path with NO flag gate — it is always-on once committed.
  That is the one thing that breaks "behaves exactly as before."

## Fake wiring / dead code

- `IntelligenceMetrics` (`intelligenceMetrics`, `timed`) — exported, unit-tested, **never imported by any live path** (M1).
- `searchInMeeting`, `generateLectureNotes`, `generateDiagram`, `getIntelligenceFlags`,
  `setIntelligenceFlag` — exposed via preload + typed, handlers exist, **no renderer consumer** (M2).
  Practical effect: no shipped UI to toggle flags (env/Settings file only); no in-meeting search,
  lecture-notes, or diagram UI.
- `ProfileTreeService.identityAnswer` (deterministic identity builder) — built but not consumed on
  the live path; the existing `manualIdentityRouting` fast-path handles identity, so not a regression,
  just unused capability.

## Release recommendation

**SHIP BEHIND FLAGS — with two carve-outs.**

The committed Intelligence OS wiring is safe to ship: it is additive, every flag defaults OFF,
flag-OFF behavior is byte-for-byte preserved, privacy is sound (hashed query, content-free
telemetry), Hindsight cannot block or crash a live answer, identity stays deterministic, and
search isolation holds for the single-user desktop. 442/442 intelligence tests pass; typecheck
is clean.

Two things must NOT ride this release:

1. **FIX-BEFORE-ENABLE (H1):** Do not enable `answerDiversityGuard` in production until
   `compressToSpeakable` is made fence-safe — it currently destroys fenced code and Mermaid
   diagrams in non-coding WTA answers. Keep the flag OFF or fix the fence handling first.

2. **DO-NOT-SHIP-WITH-THIS-RELEASE (H2):** The uncommitted `LLMHelper.ts` rewrite (remove
   tail-latency hedging, serial flash-lite→flash→pro cascade, drop `generateWithPro`) is an
   always-on change to the core answer-latency path that reverses a documented benchmark fix.
   It is unrelated to Intelligence OS and must be landed separately behind its own latency
   benchmark + kill-switch. The uncommitted startup-splash change (M4) is likewise unrelated.

Net: ship the committed flag-gated wiring; hold H1's flag OFF; split out H2/M4.
