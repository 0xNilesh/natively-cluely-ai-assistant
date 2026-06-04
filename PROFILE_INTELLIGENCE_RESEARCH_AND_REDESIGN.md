# Profile Intelligence — Research, Audit & Redesign

> Date: 2026-06-04 · Branch: `main` · Commit baseline: `1a394b3`
> Scope: research the *current* Profile Intelligence (PI) system, root-cause the
> live failures, redesign toward a deterministic, consent-aware copilot, and
> implement the real fixes. This is an **audit-and-complete** effort, not a
> rewrite: most of the deterministic machinery the spec asks us to "build"
> already exists and is well-tested (319 PI unit tests green at baseline). The
> failures are **wiring and ingestion** bugs, not missing components.

---

## 0. TL;DR — what is actually wrong

The PI **decision layer** (answer-type classifier, context router, output
validator, deterministic fast-path) is excellent and well-tested. Two real,
verified defects sit *around* it:

| # | Defect | Where | User-visible symptom | Eval evidence |
|---|--------|-------|----------------------|---------------|
| **D1** | **Decision not authoritative on the execution path.** `LLMHelper.streamChat`/`_streamChatInner` never receives the `AnswerPlan`, so the two in-stream context-injection sites (knowledge intercept + active-mode injection) do **not** consult `forbiddenContextLayers`/`isLayerAllowed`. Exclusion depends entirely on each *caller* remembering to set the `ignoreKnowledgeMode`/`skipModeInjection` booleans, and the mode-injection site passes a **hardcoded `'general_meeting_answer'`** answer type that defeats custom-context sensitivity scoping. | `electron/LLMHelper.ts:3496-3645` | Sensitive custom-context (salary/pricing) can be retrieved into non-negotiation answers; coding/identity exclusion is fragile (one missed flag = leak). | `REAL_API_EVAL_REPORT.md`: `forbidden_context_layer_selected:resume` on `TWO-SUM-WTA`, `REVERSE-LINKED-LIST-WTA`. |
| **D2** | **Ingestion has no deterministic fallback.** `StructuredExtractor.extractStructuredData` is 100% LLM-dependent. When the extraction LLM is down/billing-blocked/timed-out, it throws → `ingestDocument` returns `{success:false}` → `activeResume` is never saved → `profileFactsReady` is **false forever**. The profile never becomes usable, so identity/project questions fall back to the bare chat prompt and the assistant answers as "Natively". | `premium/electron/knowledge/StructuredExtractor.ts:151-231`, `KnowledgeOrchestrator.ts:440-543` | Resume "uploaded" but `What is my name?` answers "I am Natively" / "I don't have access". | `REAL_UI_EVAL_REPORT.md`: `resumeLoaded=false`, `jdLoaded=false` after 169s; `DA-001/002/003/010 FAIL missing_required_fact`. |

A third, smaller correctness gap (**D3**) is a **type mismatch**: the renderer's
`profileGetStatus` type (`electron.d.ts:418`) declares only `hasProfile`, so the
UI cannot see the `resume_profile_facts_ready` / `profileFactsReady` readiness
fields the backend actually returns, and polls the wrong signal.

The redesign makes the existing **`ProfileIntelligenceRouter` authoritative on
the execution path** (D1), gives **ingestion a deterministic heuristic
extractor** so the profile is usable even when the extraction LLM is down (D2),
and **fixes the status contract** (D3) — without removing the multi-mode
architecture, the model-specific (tiny/cloud) prompts, or breaking
no-profile/non-premium users.

---

## 1. Current data ingestion flow

Upload → IPC → orchestrator → structured extraction (LLM) → post-process →
persist → embed → AOT. Verified path:

```
src/components/ProfileIntelligenceSettings.tsx
  → window.electronAPI.profileUploadResume(path)        (preload.ts)
  → IPC 'profile:upload-resume'                          (ipcHandlers.ts:4388)
  → orchestrator.ingestDocument(path, DocType.RESUME)    (KnowledgeOrchestrator.ts:440)
       1. extractDocumentText(path)                      (DocumentReader.ts — pdf/docx/txt)
       2. extractStructuredData(rawText, type, genFn)    (StructuredExtractor.ts:151)  ← LLM
       3. processResume(structured)                       (PostProcessor.ts — deterministic)
       4. db.deleteDocumentsByType(type)
       5. db.saveDocument({type, structured_data})        ← sets the row activeResume reads
       6. chunkAndEmbedDocument(...)                      (DocumentChunker.ts — LLM embed)
       7. db.saveNodes(...)
       8. generateStarStoryNodes(...)  (resume only)      ← LLM, non-fatal
       9. refreshCache()  → loads activeResume/activeJD from DB
      10. AOT (JD only) runForJD(...) fire-and-forget
      11. salaryEngine.estimateFromResume(...) fire-and-forget
  → auto-enable knowledgeMode on success                 (ipcHandlers.ts:4419-4425)
```

Readiness is then polled by the UI via `profile:get-status`
(`ipcHandlers.ts:4447`), which reports
`profileFactsReady = profileFactsReady(orchestrator.activeResume.structured_data)`
(`manualProfileIntelligence.ts:325` — true if name **or** experience **or**
projects **or** skills **or** education is non-empty). Per the inline comment at
`ipcHandlers.ts:4454`, this is intentionally **not** gated on embeddings or AOT.

**Failure point (D2):** step 2 (LLM extraction) is the only producer of
`structured_data`. If it throws (LLM down / 45 s × 2 timeout / unparseable JSON
at `StructuredExtractor.ts:230`), the outer catch (`KnowledgeOrchestrator.ts:539`)
returns `{success:false}` **before step 5**, so `activeResume` is never set and
readiness is false forever. There is no deterministic text-parse fallback.

## 2. Current resume parsing flow

`StructuredExtractor.extractStructuredData` (RESUME): builds a strict-parser
prompt with a fixed JSON schema (`identity`, categorized `skills` 7-bucket,
`experience`, `projects`, `education`, `achievements`, `certifications`,
`leadership`), one `callWithRetry(..., 45000)` LLM call, `cleanJsonResponse`,
`JSON.parse`, then **partial-result** fallbacks (missing name →
`'Unknown Candidate'`, `coerceSkills`/`flattenSkills` normalize the skills shape,
arrays defaulted to `[]`). `processResume` (`PostProcessor.ts`) then
deterministically normalizes the timeline, computes total experience, and builds
the skill→experience map.

The partial fallbacks only cover an LLM that *answers but omits fields*. They do
**not** cover the LLM call *failing*. → D2.

## 3. Current JD parsing flow

Same pipeline with `DocType.JD` and `JD_SCHEMA` (`title`, `company`, `location`,
`level`, `employment_type`, `requirements`, `nice_to_haves`, `responsibilities`,
`technologies`, `keywords`, `compensation_hint`). Normalizes `level`/`employment_type`
to enums; `role`→`title` fallback; defaults. JD upload additionally triggers the
AOT pipeline (`runForJD`). Same D2 fragility on extraction failure.

## 4. Current company research flow

`CompanyResearchEngine.researchCompany` (`CompanyResearchEngine.ts:131`) — AOT,
triggered by JD upload via `AOTPipeline.runForJD` Phase 1 (blocking for phases
2–4). Up to ~8 web fetches (5 s timeout each) → falls back to an LLM-only dossier
on any failure. Result cached in SQLite (`saveDossier`/`getDossier`, 24 h TTL).
Consumed at query time as `<company_research>` (`HybridSearchEngine.formatDossierBlock`)
for `Why this company?` / negotiation answers. Stale-cache returns on stale-check
failure.

## 5. Current AOT precomputation flow

`AOTPipeline.runForJD` (`AOTPipeline.ts:65`): Phase 1 company research (sequential,
required) → Phase 2 parallel (negotiation script, gap analysis, JD-tailored intro)
→ Phase 3 mock questions → Phase 4 culture-values STAR mapping. Fire-and-forget
from `ingestDocument` (non-blocking for ingestion readiness). Results stored in
`aot_results` keyed by JD doc id; query path falls back to JIT when a precompute
is absent. STAR stories are generated at **resume** ingestion
(`generateStarStoryNodes`) and stored as `ContextNode`s (`category='star_story'`)
with embeddings — i.e. the episodic-STAR memory layer (spec §5.4) is real storage.

## 6. Current context assembly flow

Two coexisting mechanisms inside the premium orchestrator:

- **V2 deterministic grounding (default ON).** `ProfileContextBuilder.buildGroundingBlock`
  renders the full typed resume + JD into a single always-present
  `<candidate_profile>`/`<target_job>` block with authorization + completeness
  rules (kills the "I don't have access" refusal). Answer-type scoping comes from
  the **caller**: `KnowledgeOrchestrator.applyFullProfileGrounding` /
  `maybeGroundedOnlyResult` call `profileGroundingPlan(question)`
  (`KnowledgeOrchestrator.ts:1194`) which **reuses `planAnswer`** and returns
  `{useResume:false,useJD:false}` for coding/technical/sales/lecture. This path
  is correctly answer-type gated.
- **Legacy RAG retrieval.** `ContextAssembler.assemblePromptContext` →
  `HybridSearchEngine.getRelevantNodes` (cosine 60 % + tag 20 % + duration/recency
  + JD/category/title boosts, **0.55 threshold**). This path is **not**
  answer-type aware — it assembles a context blob from whatever scores ≥ 0.55. If
  everything scores below threshold the block is empty (a "void" the bare prompt
  used to fill with a refusal — the reason V2 exists).

App-layer assembly is `PromptAssembler.assemble` (`electron/services/context/PromptAssembler.ts`),
which builds trust-ordered typed blocks (intent, assistant-history,
`candidate_profile` @ `TRUSTED_PROFILE`, screen, transcript, mode custom-instructions,
reference files, custom context) and enforces a token budget.

## 7. Current `candidateProfile` injection path

There are **three** distinct live entry points, each with its own grounding
gate — this multiplicity is the source of D1:

1. **WhatToAnswer (interviewer / transcript).** `IntelligenceEngine.runWhatShouldISay`
   (`IntelligenceEngine.ts:696-804`) grounds **only** when
   `extracted.questionType ∈ {identity, profile_detail, behavioral, follow_up}`
   and `!question` (no manual override), bounded by a 2 s budget. The facts go to
   `WhatToAnswerLLM.generateStream` as `candidateProfile`. `WhatToAnswerLLM:240`
   then **drops** `candidateProfile` when `!isLayerAllowed(plan,'resume')` and
   calls `streamChat(..., ignoreKnowledgeMode=true, skipModeInjection=true)`
   (`:317`). → **This path honors the route.** (The eval leak predates these
   guards; it is closed on current `main`.)
2. **Manual chat.** `ipcHandlers.ts` `gemini-chat-stream` (`:656-695`): deterministic
   `buildManualProfileBackendAnswer` fast-path first (answers name/experience/
   projects/skills/education/role with **no provider**), else falls through to
   `streamChat`. Coding sets `ignoreKnowledgeMode=true` + `skipModeInjection=true`
   (`:757-758`). → Coding honors the route by *flag*, not by plan.
3. **Generic `streamChat` knowledge intercept.** `_streamChatInner:3530-3589`:
   when knowledge mode is on and not ignored, calls `processQuestion(message)` and
   injects `knowledgeResult.contextBlock` gated on
   `factualRecall || isPremiumKnowledgeInterceptAllowed()`. → **Does not see the
   `AnswerPlan`.** This is D1's core: the decision is computed by the caller and
   *not threaded in*, so enforcement here is indirect (the orchestrator
   self-gates via `applyFullProfileGrounding`, but the in-stream mode injection at
   `:3624` uses a hardcoded answer type — see §8).

## 8. Current custom context handling

`customContextClassifier.ts` classifies custom context into
`pinned` / `searchable` / `sensitive` (spec §5.7). `ModeContextRetriever.ts`
(`:17-24`) scopes which classes are eligible per `answerType` (sensitive chunks
require a negotiation-class answer). `ModesManager.buildRetrievedActiveModeContextBlock(query, transcript, budget, answerType)`
takes the answer type to drive that gate.

**Failure point (D1):** the generic `_streamChatInner` mode-injection site
(`LLMHelper.ts:3624`) calls this with a **hardcoded `'general_meeting_answer'`**
instead of the real answer type. The intent (per the code comment) is "be
conservative — sensitive chunks dropped on this generic path." In practice it
means the gate is *always* `general_meeting_answer` here, so this path can never
correctly surface sensitive context **and** silently mis-scopes for every other
answer type. The same hardcoding exists at `LLMHelper.ts:1325` (suggestion path).

## 9. Current AI persona handling

Persona is **style, not truth** by construction. There is no persisted persona
store; `ContextAssembler.buildIdentityHeader` computes a voice header from
resume+JD at query time, and the system prompts (`prompts.ts` cloud, `tinyPrompts.ts`
local) own the voice rules. The `IDENTITY GUARD` (`tinyPrompts.ts:17`,
mirrored in cloud prompts) forbids the assistant from claiming to be the
candidate ("never introduce yourself as 'I'm Evin John'… if the speaker's real
name is not in grounded context, open WITHOUT a name"). Resume/JD/transcript/salary
facts dominate persona by recency and by the anti-fabrication rules. This matches
spec §5.8 (persona must not override facts) and needs no change.

## 10. Current negotiation context handling

Three separate objects (spec §5.6 implies one; reality is split):

- **AOT `NegotiationScript`** (`NegotiationEngine.ts`) — precomputed, stored in
  `aot_results`, serves salary/comp questions.
- **`NegotiationConversationTracker`** (`:79`) — live in-memory state machine
  (phase, offer history, pushback counts). Not persisted.
- **`LiveNegotiationAdvisor`** (`:20`) — on-the-fly LLM coaching using tracker
  state; 12 s timeout → generic fallback.

Negotiation/salary context is gated to `negotiation_answer` everywhere
(`AnswerPlanner.forbiddenLayersFor`, `ProfileIntelligenceRouter.sensitiveContextAllowed`,
`ProfileOutputValidator` salary-leak checks). Coaching travels on a dedicated
`negotiation_coaching` event channel, never the token stream.

## 11. Current active-mode gating

`ModesManager` holds the active mode (general / sales / team-meet /
technical-interview / lecture / custom) and produces a system-prompt suffix +
retrieved mode context. `IntelligenceManager.clearSessionContext` clears
mode-specific transient context on mode switch to prevent bleed. Trust ordering
(`TrustLevels.ts`) sorts `MODE_POLICY` above `TRUSTED_PROFILE`; the V2 grounding
block sets `factualRecall=true` so the user's own facts survive the mode gate.
The multi-mode architecture is load-bearing and **must be preserved** (task
constraint).

## 12. Current failure points (consolidated)

| Code | Location | Description | Severity |
|------|----------|-------------|----------|
| **D1a** | `LLMHelper.ts:3530-3589` | Knowledge intercept injects profile `contextBlock` without the `AnswerPlan`; relies on caller flags. | High (architecture) |
| **D1b** | `LLMHelper.ts:3624`, `:1325` | Active-mode injection passes hardcoded `'general_meeting_answer'`; custom-context sensitivity gate mis-scoped. | Medium (real leak vector) |
| **D2** | `StructuredExtractor.ts:162,230`; `KnowledgeOrchestrator.ts:452,539` | Extraction is LLM-only; failure → profile never ready. | **Critical (user-facing)** |
| **D3** | `electron.d.ts:418`; `ipcHandlers.ts:4460` | `profileGetStatus` type omits readiness fields; UI polls `hasProfile` not `resume_profile_facts_ready`. | Medium |
| F4 | `HybridSearchEngine.ts:221` | 0.55 cosine threshold can return empty RAG block (mitigated by V2 always-on grounding). | Low (mitigated) |
| F5 | `AOTPipeline.ts:65` | `runForJD` fire-and-forget, no escape hatch; AOT failures silent. | Low |
| F6 | premium engines | In-memory caches lost on restart; silent LLM-failure fallbacks. | Low |

## 13. Current latency risks

- **Extraction:** `callWithRetry(..., 45000)` × 2 attempts ≈ up to ~91 s on a
  failing LLM — the dominant ingestion latency and the cause of the 169 s
  real-UI stall.
- **WTA grounding:** bounded to 2 s (`GROUNDING_BUDGET_MS`), good.
- **Hybrid retrieval:** bounded to 1.5 s (`HYBRID_RETRIEVAL_BUDGET_MS`), good.
- **Provider TTFT:** historical 10 s stalls were a billing-dead Gemini key +
  un-streamed default thinking budget; `thinkingBudget:0` on the interactive path
  is the fix (already applied). Real-API p95 first-useful was 23–53 s under the
  dead key — an *environment* problem, not a code path, but it interacts with D2
  (a dead key also kills extraction).

## 14. Current tests

- **319 PI-specific deterministic unit tests, all green at baseline**
  (`AnswerPlannerValidator`, `ProfileIntelligenceSpec` (35 §11 cases),
  `ProfileAnswerTypeRouting`, `ProfileOutputValidator`, `ContextRoute`,
  `CodingContract`, `CustomContextClassifier`, `manualProfileIntelligence`,
  `profileAnswerBackend`, `WhatToAnswerProfileGrounding`, `WtaRegression`,
  `modePrompts`).
- **Gaps:** no test exercises the `_streamChatInner` decision→execution seam
  (D1); no test for `ingestDocument` extraction-failure readiness (D2); no test
  for the `profile:get-status` response shape (D3); no tests at all for the
  premium knowledge engines.

---

## 15. Redesign — make the decision authoritative, make ingestion resilient

The spec's target architecture is already ~70 % built. The redesign is three
surgical changes that close D1/D2/D3 and one consolidation, all **additive and
flag-guarded** so existing behavior is preserved.

### R1 — Thread the routing decision into `streamChat` (fixes D1)

**Principle (spec §4):** "The Profile Intelligence Router must run before final
prompt assembly. The model should receive a structured packet containing only the
context that is allowed and relevant."

Add an optional trailing `routeOptions?: { answerType?: AnswerType; forbiddenContextLayers?: ContextLayer[] }`
to `_streamChatInner` (and surface through `streamChat`'s variadic args). At the
two in-stream injection sites:

- **Knowledge intercept (`:3584`):** before injecting `knowledgeResult.contextBlock`,
  if `forbiddenContextLayers` includes `resume`/`jd`/`negotiation`/`custom_context`,
  **skip** the injection (defence-in-depth on top of the orchestrator's own
  `applyFullProfileGrounding` gate). This makes exclusion hold even if a future
  caller forgets `ignoreKnowledgeMode`.
- **Active-mode injection (`:3624`, `:1325`):** pass the **real** `answerType`
  (from `routeOptions`, default `'general_meeting_answer'` when absent) into
  `buildRetrievedActiveModeContextBlock`, so custom-context sensitivity scoping is
  correct on every path.

Callers that already have the plan (`ipcHandlers gemini-chat-stream`,
`IntelligenceEngine`) pass `routeOptions`. Callers that don't (legacy) get the
identical current behavior (default answer type, no forbidden layers). **No
existing call signature breaks** — the parameter is optional and last.

### R2 — Deterministic heuristic extractor fallback (fixes D2)

Add `heuristicResumeExtract(rawText)` / `heuristicJDExtract(rawText)` — pure,
LLM-free parsers that populate the *minimum* structured shape needed for
`profileFactsReady` and the deterministic fast-path:

- **name** — first non-empty line that looks like a name (≤ 5 tokens, no `@`, not
  all-caps section header) or the local-part of an email.
- **email / phone / links** — regex.
- **skills** — lines under a `Skills/Technologies/Tech Stack` heading, comma/•
  split, run through the existing `categorizeFlatSkills` (skillsUtil).
- **experience / projects / education** — section-header detection
  (`Experience|Work|Employment`, `Projects`, `Education`) → bullet/line grouping
  into `{role/company}` / `{name}` / `{institution/degree}` shells.

Wire it into `ingestDocument`: wrap step 2 so that if `extractStructuredData`
**throws** (or times out), fall back to `heuristicResumeExtract(rawText)`, stamp
`_extraction_mode='heuristic'`, and **continue** to step 5 (save) so
`activeResume` is set and `profileFactsReady` becomes true. Embedding (step 6)
remains best-effort; if it also fails, the rollback still leaves the *answerable*
facts because we save the doc first and degrade embeddings gracefully (see R2b).
The richer LLM extraction is retried opportunistically when the LLM recovers
(re-upload or an explicit `profile:re-extract`).

**R2b — don't let a storage hiccup erase answerable facts.** Note: a *dead
embedder* already degrades gracefully — `chunkAndEmbedDocument`
(`DocumentChunker.ts:213-275`) uses `Promise.allSettled` + one retry and stores
nodes **without** embeddings rather than throwing, so embed-down does **not**
reach the orchestrator's rollback catch. That catch only fires on the rarer
`saveNodes`/`createDocumentNodes` throw. For that case we change the rollback to
**keep the saved document** (so `profileFactsReady` stays true and the fast-path
+ V2 grounding work — neither needs embeddings). Any nodes persisted without
embeddings cosine-score 0 in `HybridSearchEngine`, so RAG degrades to nothing
without polluting results — no extra gating flag needed. Lower-impact than R2,
but it removes the last path where a transient storage error could destroy an
answerable profile. Gated by the same `PI_HEURISTIC_EXTRACTION` kill-switch.

### R3 — Fix the status contract (fixes D3)

Extend the `profileGetStatus` return type in `src/types/electron.d.ts` to include
`resume_structured_extraction_complete`, `resume_profile_facts_ready`,
`profileFactsReady`, `jd_structured_extraction_complete`, `jdFactsReady`,
`aot_pipeline_running`, and add an `extractionMode: 'llm' | 'heuristic' | 'none'`
to the backend status handler so the UI can hint that a heuristic (LLM-down)
profile may be re-extracted.

Renderer change is intentionally **minimal**: post-D2, `hasProfile`
(`= activeResume !== null`) is true as soon as the resume is saved (including via
the heuristic fallback), so the existing `profileStatus.hasProfile` gating in the
1000-line `ProfileIntelligenceSettings.tsx` is already correct for the common
case — we only widen its local state type so the readiness fields are typed and
available, without altering gating logic (lower regression risk). The explicit
readiness fields are now on the IPC contract for any future precise polling and
for the eval harness.

### R4 — (consolidation, optional) single grounding gate

`ProfileIntelligenceRouter.decideProfileIntelligence` already composes
`planAnswer` + `buildContextRoute` into the spec's `ProfileIntelligenceDecision`.
Have `KnowledgeOrchestrator.profileGroundingPlan` and the WTA grounding gate both
derive from the **same** router decision object (they already both call
`planAnswer`; this just names the shared contract) so there is one auditable
decision per question. Telemetry (spec §13) emits the decision's
`profileContextTypes` / `excludedContextTypes` (names only, no content).

### Memory model mapping (spec §5)

| Spec layer | Status today | Action |
|------------|--------------|--------|
| §5.1 Identity | Real storage (`StructuredResume.identity`) | keep; heuristic fallback populates it (R2) |
| §5.2 Resume-semantic | Real storage (`ContextNode`s + embeddings) | keep |
| §5.4 Episodic STAR | Real storage (`category='star_story'`) | keep |
| §5.5 JD | Real storage (`StructuredJD`) | keep |
| §5.6 Company | Real storage (SQLite dossier cache) | keep |
| §5.7 Negotiation | AOT script (stored) + live tracker (in-mem) | keep; documented split |
| §5.3 Custom context | pinned/searchable/sensitive classifier; no named store | keep; honored via R1 answerType fix |
| §5.8 Persona | Computed at query time; style-only | keep (already correct) |

The memory layers exist; the redesign does not add new stores, it makes the
**routing** that selects from them authoritative and the **ingestion** that fills
them resilient.

---

## 16. Files changed (planned)

| File | Change | Defect |
|------|--------|--------|
| `electron/LLMHelper.ts` | optional `routeOptions` on `_streamChatInner`; honor `forbiddenContextLayers` at knowledge-intercept; real `answerType` at mode-injection (`:3624`,`:1325`) | D1 |
| `electron/ipcHandlers.ts` | pass `routeOptions` (answerType + forbidden layers) into `streamChat` from `gemini-chat-stream` | D1 |
| `premium/electron/knowledge/HeuristicExtractor.ts` *(new)* | LLM-free resume/JD parser | D2 |
| `premium/electron/knowledge/KnowledgeOrchestrator.ts` | extraction-failure fallback to heuristic; keep-document-on-embed-failure | D2 |
| `electron/electron.d.ts` | full `profileGetStatus` return type | D3 |
| `src/components/ProfileIntelligenceSettings.tsx` | poll `resume_profile_facts_ready` | D3 |
| `electron/llm/__tests__/StreamChatRouteEnforcement.test.mjs` *(new)* | D1 seam tests | tests |
| `electron/services/__tests__/HeuristicExtractor.test.mjs` *(new)* | D2 extraction-fallback tests | tests |
| `electron/services/__tests__/ProfileStatusContract.test.mjs` *(new)* | D3 status-shape tests | tests |

## 17. Before / after

| Question / event | Before | After |
|------------------|--------|-------|
| Resume uploaded, extraction LLM down | `resumeLoaded=false` forever; `What is my name?` → "I am Natively" | heuristic fallback sets `profileFactsReady=true`; `My name is <Name>` from the deterministic fast path |
| Coding Q via a caller that forgot `ignoreKnowledgeMode` | resume could be injected | `forbiddenContextLayers` skips the intercept regardless of the flag |
| Non-negotiation Q with sensitive custom context, generic path | gate hardcoded to `general_meeting_answer` (accidentally safe but mis-scoped) | gate uses the real answer type; sensitive chunks correctly excluded; correctly *included* only for negotiation |
| `What is your name?` (interviewer) | first-person from grounded name | unchanged (already correct) |
| No profile / non-premium user | bare chat | unchanged (all PI paths no-op when `activeResume` is null) |

## 18. Remaining risks

- **R-A** `LLMHelper.ts` is 266 KB and central. R1 is additive (optional last
  param) and guarded; mitigated by the new seam tests + full `node --test`.
- **R-B** Heuristic extraction is lower-fidelity than the LLM. Mitigation: it is
  a *fallback only* (LLM remains primary), clearly stamped `_extraction_mode`, and
  the profile is re-extractable when the LLM recovers; never fabricates (empty
  sections stay empty).
- **R-C** Real-API / real-UI release gates need a working `NATIVELY_TEST_API_KEY`
  + GUI, absent here. We make them runnable and document exact commands; we do not
  fabricate green runs (see `PROFILE_INTELLIGENCE_TEST_PLAN.md`).
- **R-D** Premium build skips typecheck (esbuild). New premium code is verified
  with explicit `tsc -p` per project convention.

## 19. Rollback plan

- **R1** behind the existing PI grounding behavior; revert is removing the
  `routeOptions` plumbing (the defaults reproduce current behavior exactly). The
  `PROFILE_GROUNDING_V2` kill-switch (`PROFILE_GROUNDING_V2=off`) remains the
  master revert for all V2 grounding.
- **R2** the heuristic fallback only runs on LLM-extraction failure; disable by
  env `PI_HEURISTIC_EXTRACTION=off` → restores throw-on-failure behavior.
- **R3** type-only + a renderer poll field; trivially revertible.
- Per-commit: `git revert <sha>`; all changes are isolated, test-guarded commits.
