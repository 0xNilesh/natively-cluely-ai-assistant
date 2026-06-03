# PROFILE_INTELLIGENCE_FIX_PLAN

> Phase-1 implementation plan. Source of truth: `REPORT_TO_CHATGPT.md`.
> Every claim below was **re-verified against the current code** (branch
> `fix/overlay-startup-slide`, commit `cd37d0a`) with exact current line numbers,
> because the report's line numbers came from an older commit (`8dcbb4f`). Where the
> report was stale or wrong, this plan says so and uses the verified truth.

## 0. Verification summary — what the report got right, and what changed

A 13-agent ground-truth pass verified the report against the live code. The headline
correction that reshapes the whole effort:

**Most of the deterministic machinery the report asks us to "build" already exists.**
The remaining failures are **wiring and timing bugs**, not missing components.

| Report claim | Verdict | Current truth |
|---|---|---|
| `streamWithNatively` has a `10_000ms` connect timeout | **CONFIRMED** | `LLMHelper.ts:3845-3848` (+ `AbortSignal.timeout(10_000)` at 749/779 in `generateWithNatively`) |
| Text fallback is serial Natively→Groq→Gemini, no TTFT race | **CONFIRMED** | `LLMHelper.ts:3176-3188` plain `for` loop; `yield* provider.execute()`. No first-token timeout. |
| Vision already has a TTFT commit-point race | **CONFIRMED** | `visionStreamFallback.ts` — `runStreamingVisionFallback` (generic, reusable), `ttftTimeoutMs:8_000` |
| WTA streams raw tokens, validates/repairs only after stream | **CONFIRMED** | `IntelligenceEngine.ts:743-762` emit loop; `validateAnswerStructure` at `:781`. Repaired `fullAnswer` is **never re-emitted** when streaming already happened (`:809-814`). |
| Provider temperatures inconsistent (0.3/0.4/0.7/1.0), no seed | **CONFIRMED** | temps at 706,834,855,966,2108,2638,3968,4016,4306,4438,4550; `seed` absent everywhere |
| Coding heading specs conflict across files | **CONFIRMED** | `prompts.ts:144-167` colon labels; `tinyPrompts.ts:9` comma list; `AnswerPlanner.ts:64-103` `##`; `prompts.ts:2332` `### Dry Run`; `AnswerValidator.ts:30` `##` |
| `CodingAnswer` type + renderer + validator + repair must be *created* | **REFUTED — already exist** | `AnswerValidator.ts`: `CodingAnswer` (3-11), `renderCodingAnswerMarkdown` (79-112), `validateCodingMarkdown` (207-232), `repairCodingMarkdown` (181-205), odd/even fallback (141-177) |
| `AnswerPlan` needs new fields | **PARTIAL** | Already has source/speakerPerspective/outputPerspective/required+forbiddenContextLayers/canUseFastPath/requiresLLM. Missing: `shouldShowImmediateScaffold`, `maxFirstUsefulTokenMs` (currently `maxInitialLatencyMs`). |
| AOT intro is precomputed at upload | **CONFIRMED** | `ContextAssembler.generateCandidateIntro` + `AOTPipeline.preComputeIntro` → `db.saveIntro`; served via `db.getIntro` at `KnowledgeOrchestrator.ts:944` |
| `processQuestion` is blocking, no timeout, called pre-stream | **CONFIRMED** | `IntelligenceEngine.ts:663` `await orchestrator.processQuestion(lookupQ)` — no `Promise.race`/timeout |
| Two context pipelines, no unified router | **CONFIRMED** | `PromptAssembler` (WTA) trust-sorts+concats (`:484-493`); premium `KnowledgeOrchestrator`/`ContextAssembler` independent |
| `MODE_POLICY` outranks `TRUSTED_PROFILE` | **CONFIRMED** | `TrustLevels.ts:60-71` index 1 vs 4 |
| 20 PI telemetry events exist | **REFUTED** | None of the 20 are emitted. Several names declared in `TelemetryService` union but never `.track()`ed (`provider_error`, `provider_fallback`, `llm_*`). No span/timer helper. |
| `provider_error`/`provider_fallback` emitted | **REFUTED** | declared, never called |
| Real-UI committed iteration JSON is empty | **REFUTED** | `real-ui-iteration-001.json` is 213 KB, 100 executed / 88 passed |
| Backend eval has coding test cases | **REFUTED** | the 100-case backend set + 100-case real-UI set contain **0** coding cases; coding is only covered by `AnswerPlannerValidator.test.mjs` unit tests |
| Tests use vitest/jest | **REFUTED** | `node --test` (node:test), `*.test.mjs` against compiled `dist-electron` |

### Environment constraints (verified, govern the release gates)
- `NATIVELY_TEST_API_KEY` — **ABSENT**. `.env` has `GEMINI_API_KEY` + `TAVILY_API_KEY` only (no Groq/OpenAI/Anthropic). `.env` is gitignored ✓.
- Build: `npm run build:electron` (esbuild, **skips typecheck**). Real typecheck = `npm run typecheck:electron` (`tsc -p electron/tsconfig.json --noEmit`). Premium edits must be verified with `tsc` explicitly (per project memory).
- Backend tests: `node --test electron/llm/__tests__/**/*.test.mjs` (after build).
- Real API gate: `NATIVELY_TEST_API_KEY=… node intelligence-eval-real-api/run-real-api-e2e.ts` — **cannot run here** (no key).
- Real UI gate: `playwright test --config intelligence-eval-real-ui/playwright.config.ts` — needs Pro key + GUI — **cannot run here** (no key, headless).

**Honest gate position:** per the task's own rule ("Do not claim completion unless real API
and real UI release gates pass"), those two gates are **blocked on credentials/GUI not
present in this environment**. I will make them correct + runnable, add the required coding
regression cases, run a `--dry-run` validation of the harness, run everything that *can*
run here (backend `node --test`, typecheck, build), and document the exact commands + the
block precisely. I will **not** fabricate green real-API/real-UI runs.

---

## 1. Files to change (grouped by phase)

### Telemetry / latency (Phases 2, 4)
- `electron/services/telemetry/TelemetryService.ts` — add ~20 PI event names to the union; add a `startSpan()`/`recordSpan()` timing helper; add optional debug-metadata merge. Keep sanitizer as-is (verified strong).
- `electron/IntelligenceEngine.ts` — emit stage spans in `runWhatShouldISay`/`runManualAnswer`; **bound `processQuestion` with `Promise.race` timeout**; emit scaffold; emit first-useful-token.
- `electron/llm/WhatToAnswerLLM.ts` — convert env-gated `MEASURE_LATENCY` console logs into telemetry spans; record `prompt_built`, `provider_request_started`.
- `electron/LLMHelper.ts` — record `provider_request_started`, `first_response_byte`, `first_useful_token`, `provider_error`, `provider_fallback`, race winner.

### Provider TTFT race + determinism (Phases 3, 11)
- `electron/LLMHelper.ts` —
  - Lower `streamWithNatively` connect timeout 10s → **3s** for the interactive text path (3845-3848). Keep a longer ceiling for the non-interactive/structured-gen path if needed.
  - Build a **text TTFT race** reusing the generic `runStreamingVisionFallback` engine (or a thin text-specific wrapper around the same state machine) so a stalled primary fails over on first-token-timeout instead of blocking the serial loop.
  - **Canonicalize sampling**: a single `interactiveSamplingParams()` helper → `temperature: 0`, `top_p: 1` (where applicable), `seed` where the provider supports it (none of Groq/OpenAI/Gemini/Claude streaming currently does — apply where the SDK accepts it, document where it can't). Replace the scattered literals.
- `electron/llm/visionStreamFallback.ts` — rename internal-neutral exports if needed (the engine is already generic; no behavior change), or add a `runStreamingTextFallback` thin alias with text defaults (`ttftTimeoutMs` ~2500ms for text).

### Deterministic planner + context router (Phases 5, 6)
- `electron/llm/AnswerPlanner.ts` — add `shouldShowImmediateScaffold` + `maxFirstUsefulTokenMs` (alias/replace `maxInitialLatencyMs`); make coding `CODING_TEMPLATE` reference the canonical contract; allow language to be injected (drop hardcoded `typescript`). Keep the deterministic regex ladder.
- `electron/llm/contextRoute.ts` *(new)* — the single `ContextRoute` contract: `{ selectedLayers, excludedLayers, reason: Record<layer,string>, tokenBudget, maxTotalPromptTokens }`, derived deterministically from `AnswerPlan`. Pure, local, no I/O.
- `electron/services/context/PromptAssembler.ts` — accept an optional `route?: ContextRoute`; when present, **honor selected/excluded layers** instead of dumping all blocks; expose the chosen layers for debug metadata.
- `electron/services/context/TrustLevels.ts` — document MODE_POLICY>TRUSTED_PROFILE; add a per-answer-type policy so factual/identity answers demote mode custom_context below profile facts (fixes report hypothesis X2).
- `premium/electron/knowledge/KnowledgeOrchestrator.ts` — fast-path early-return when `fastPathNodes` already deterministic; skip `assemblePromptContext` appends when only cached intro is needed; ensure no live re-embed on hot path (verify `resolveQueryEmbedder` prefers on-device MiniLM).

### Coding contract + WTA scaffold (Phases 7, 8, 9, 12)
- `electron/llm/prompts.ts` — extract one canonical `CODING_CONTRACT` (`##`-heading form), replace `SHARED_CODING_RULES` colon-labels (138-189) and the `### Dry Run` instruction (2332) to use it.
- `electron/llm/tinyPrompts.ts` — line 9 list → same `##` headings (shorter prose, identical contract).
- `electron/llm/AnswerValidator.ts` — keep `##` primary; widen `SECTION_ALIASES` to also accept colon-label legacy output (already partially does); ensure `renderCodingAnswerMarkdown` is the single render path. Add `buildCodingScaffold(answerType, language?)` returning the empty 6-section skeleton.
- `electron/IntelligenceEngine.ts` — **the central fix**: for coding/dsa/system-design/debugging answer types, emit a deterministic scaffold immediately (before the stream), **buffer raw tokens instead of emitting them live** for coding types, then validate→repair→emit the final structured markdown once. Non-coding types keep live streaming. Unify manual (`runManualAnswer`) + WTA (`runWhatShouldISay`) to share the same scaffold/validate/repair/emit helper.
- `src/components/NativelyInterface.tsx` — render the coding scaffold immediately for `intent==='coding'`; do **not** push raw coding tokens through the `marked`+innerHTML path; swap to the validated final via the existing `ReactMarkdown` branch. Single renderer for coding.
- `electron/ipcHandlers.ts` — `gemini-chat-stream` (679-680) already suppresses live coding tokens for manual chat; align its post-stream path to the same scaffold/validate helper; ensure `generate-what-to-say` (3312) path uses the unified emit.

### Tests, regression, cost (Phases 14, 15, 16)
- `electron/llm/__tests__/CodingContract.test.mjs` *(new)* — 50 coding-structure cases (render + validate + repair) incl. the report's required problem list.
- `electron/llm/__tests__/ContextRoute.test.mjs` *(new)* — 30 routing cases (coding excludes resume/JD/negotiation; identity uses stable_identity+resume; negotiation gated; JD-fit uses JD+resume).
- `electron/llm/__tests__/WtaTranscriptExtraction.test.mjs` *(new/extend existing extractor test)* — 20 latest-interviewer-question cases incl. noise/follow-ups.
- `electron/llm/__tests__/LatencyMetadata.test.mjs` *(new)* — 20 cases asserting the span/debug-metadata shape & that sanitizer strips private fields.
- `intelligence-eval-real-api/` — add the 6 release-blocking cases (CODING-ODD-EVEN-MANUAL/WTA, TWO-SUM-WTA, IDENTITY-MANUAL/WTA, CONTEXT-ISOLATION-CODING); cost recording per response.
- `intelligence-eval-real-ui/` — add a **live-DOM-vs-final** coding spec (MutationObserver on `h2` order during stream vs final), scaffold-<500ms assertion, "never starts with code" assertion.

### Reports (Phase 17)
`PROFILE_INTELLIGENCE_FIX_PLAN.md` (this), `LATENCY_ROOT_CAUSE_REPORT.md`,
`PROVIDER_TTFT_RACE_REPORT.md`, `INTELLIGENCE_LATENCY_REPORT.md`,
`PROFILE_INTELLIGENCE_LATENCY_TRACE.md`, `INTELLIGENCE_COST_REPORT.md`,
`ANSWER_QUALITY_EVAL_REPORT.md`, `REAL_API_EVAL_REPORT.md`, `REAL_UI_EVAL_REPORT.md`,
`INTELLIGENCE_FIX_REPORT.md`.

---

## 2. Exact bugs being fixed (with verified evidence)

1. **B1 — Raw coding stream (release-blocking).** `IntelligenceEngine.ts:743-762` emits the raw 160-char prefix buffer to the UI for *every* answer type; coding validation/repair runs only at `:781`; the repaired `fullAnswer` is not re-emitted after streaming (`:809-814`). → user sees code-first/malformed markdown.
2. **B2 — 10s wall.** `streamWithNatively` connect timeout `10_000ms` (`:3845-3848`) + serial fallback loop (`:3176-3188`) with no first-token race → a stalled primary blocks first output up to 10s + DNS retries (~1s, `:3865-3881`).
3. **B3 — Non-determinism.** Temperatures 0.3–1.0 across providers, no `seed`. Same prompt → variable structure.
4. **B4 — Conflicting coding contract.** Four different heading specs across `prompts.ts`/`tinyPrompts.ts`/`AnswerPlanner.ts` + `### Dry Run` vs `## Dry Run`. Model gets mixed instructions.
5. **B5 — Blocking grounding.** `await orchestrator.processQuestion` (`:663`) has no timeout; a slow grounding call delays the provider start.
6. **B6 — Split context routing.** Two pipelines; no shared `ContextRoute`; mode policy can evict profile facts.
7. **B7 — No production telemetry.** None of the 20 PI latency events emitted; declared `provider_error`/`provider_fallback` never fire; no span helper. The 10s path is uninstrumented.
8. **B8 — No coding eval coverage in the suites.** 0 coding cases in either 100-case set; live-DOM-vs-final never asserted.

---

## 3. Expected impact

| Fix | Latency impact | Quality impact |
|---|---|---|
| B1 scaffold + buffered coding emit | scaffold visible <500ms (perceived latency ↓ hugely) | coding answers never code-first; always 6 sections |
| B2 3s timeout + text TTFT race | p95 first-useful-token: removes the 10s tail; stalled primary fails over in ~2.5s | answer style stable (race winner logged; same contract to all) |
| B3 temp 0 + seed-where-supported | negligible | structure variance ↓ |
| B4 single contract | negligible | tiny + large models get one consistent target |
| B5 bounded grounding (2s race) | removes grounding tail from pre-stream | degraded-context flagged, never silent |
| B6 ContextRoute | smaller prompts for coding/identity (fewer tokens) | no context pollution; deterministic include/exclude |
| B7 telemetry | none (non-blocking track) | observability to prove the gates |

Targets (from the task): manual factual p95 < 1500ms FUT; manual coding/WTA p95 < 4500ms FUT;
scaffold < 500ms; coding 100% section contract; identity/project/context-isolation 100%.

---

## 4. Tests to run after each phase

- After every backend phase: `npm run typecheck:electron` then
  `npm run build:electron && node --test electron/llm/__tests__/**/*.test.mjs`.
- After planner/router/validator: the new `CodingContract`, `ContextRoute`,
  `WtaTranscriptExtraction`, `LatencyMetadata` suites + existing `AnswerPlannerValidator`,
  `TranscriptQuestionExtractor`, `IdentityGuard`, `PlannerDecision`, `VisionStreamFallback`.
- After premium edits: explicit `tsc` on the premium module (build skips typecheck).
- After provider work: `VisionStreamFallback.test.mjs` + a new text-race unit test with fake
  providers (deterministic, no network).
- Release gates (document-only here, runnable elsewhere): real-API `--dry-run`, then full with
  key; real-UI playwright with Pro key + GUI.

---

## 5. Risks & mitigations

- **R1 — Lowering Natively timeout to 3s could over-fail-over on a slow-but-alive server.** Mitigation: the TTFT race commits on first *token*, not connect; record race metadata to calibrate; keep a longer ceiling on non-interactive paths.
- **R2 — temp 0 may reduce answer richness for some providers.** Mitigation: gate temp 0 to interview/coding answer types; keep general chat at a low-but-nonzero temp if evals regress; verify via `ANSWER_QUALITY_EVAL_REPORT`.
- **R3 — Buffering coding tokens removes live "typing" feel.** Mitigation: the scaffold appears <500ms and gives immediate structure; only the *code body* fills after validation. Net perceived latency improves.
- **R4 — `NativelyInterface.tsx` is 5113 lines, high-risk.** Mitigation: minimal, localized change behind an `intent==='coding'` branch; no refactor of the streaming engine; verify with real-UI spec.
- **R5 — ContextRoute refactor could regress existing routing.** Mitigation: route is *additive/optional*; `PromptAssembler` keeps current behavior when no route passed; 30 routing tests guard include/exclude.
- **R6 — Premium build skips typecheck → silent breakage.** Mitigation: run `tsc` on premium explicitly; load the compiled class in a smoke test.
- **R7 — Real gates can't run here.** Mitigation: make them correct + dry-run-validated; document the exact rerun commands; never claim a green run that didn't happen.

---

## 6. Execution order

1. Phase 2 telemetry scaffolding (span helper + event names) — unblocks measuring everything.
2. Phase 3 timeout + text TTFT race + determinism.
3. Phase 4 bounded grounding / pre-stream caps.
4. Phase 5/6 planner fields + ContextRoute + PromptAssembler honor + trust policy.
5. Phase 9 unify coding contract (single source) — must precede 7/8 so the scaffold uses it.
6. Phase 7/8/12 coding scaffold + buffered emit + validate/repair-before-visible, unify manual+WTA, UI render.
7. Phase 10 deterministic fast paths for simple facts.
8. Phase 13 WTA transcript behavior hardening.
9. Phase 14/15/16 tests + regression + cost.
10. Phase 17/18/19 reports + audit + acceptance.

Each logical fix: implement → `code-reviewer` agent → `test-engineer` agent (or `node --test`) →
next. `debugger` agent on any confirmed runtime failure.
