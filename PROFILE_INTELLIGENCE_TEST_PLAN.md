# Profile Intelligence — Test Plan

> Companion to `PROFILE_INTELLIGENCE_RESEARCH_AND_REDESIGN.md`.
> Goal: prove, deterministically, that the system (a) routes profile context
> correctly — **inclusion AND exclusion** (spec §12), (b) recovers ingestion when
> the extraction LLM is down (D2), (c) makes the routing decision authoritative on
> the execution path (D1), and (d) exposes readiness correctly (D3) — while
> preserving the multi-mode architecture, model-specific prompts, and
> no-profile/non-premium users.

## 0. How tests run (environment notes)

- Backend suites: **`node --test`** against compiled `dist-electron`
  (`*.test.mjs`). Build first: `npm run build:electron`.
- **Electron-ABI gotcha:** `better-sqlite3` is built for Electron 33 (Node ABI
  130). DB-backed `services/__tests__` need a `better-sqlite3` matching the
  *runner's* node. To run them under system node: `npm rebuild better-sqlite3`,
  run, then restore for the app with `npm run rebuild:native`. Pure
  `llm/__tests__` need no rebuild.
- Premium build skips typecheck (esbuild). Verify premium edits with
  `npx tsc -p electron/tsconfig.json --noEmit` (it includes
  `../premium/electron/**/*.ts`).
- Live gates (real API / real UI) need `NATIVELY_TEST_API_KEY` + GUI — see §5.

## 1. Commands

```bash
# Build + typecheck
npm run build:electron
npx tsc -p electron/tsconfig.json --noEmit        # electron + premium, expect 0 errors
npx tsc --noEmit -p tsconfig.json                 # renderer, expect 0 errors

# New + regression PI suites (pure, no rebuild needed)
node --test electron/llm/__tests__/StreamContextPolicy.test.mjs        # D1
node --test 'electron/llm/__tests__/**/*.test.mjs'                     # 545 pass

# DB-backed (needs better-sqlite3 for node — rebuild first, restore after)
npm rebuild better-sqlite3
node --test electron/services/__tests__/HeuristicExtractor.test.mjs    # D2
node --test electron/services/__tests__/IngestResilience.test.mjs      # D2
node --test electron/services/__tests__/KnowledgeOrchestratorIngest.test.mjs  # regression
npm run rebuild:native                                                 # restore Electron ABI

# Full suite (canonical)
npm test
```

## 2. Test matrix — by spec §12 case

| Spec §12 group | Case | Expectation | Covered by |
|----------------|------|-------------|------------|
| Identity | "What is my name?" / "What is your name?" / "Who are you?" / "Tell me about yourself" / "Walk me through your background" | first person, uses identity, never "Natively", never generic-AI | `ProfileIntelligenceSpec`, `manualProfileIntelligence`, `ProfileOutputValidator`, `StreamContextPolicy` (intercept allowed) |
| Resume/projects | "What projects have you done?" / "Tell me about your WebRTC experience" / "Have you used AWS?" / "strongest project" | uses resume/project facts, first person, no hallucination | `ProfileAnswerTypeRouting`, `manualProfileIntelligence`, `WhatToAnswerProfileGrounding` |
| JD/company | "Why this role?" / "Why this company?" / "How are you a fit?" | uses JD+resume, concise alignment; JD included | `ProfileIntelligenceSpec`, `ContextRoute`, `StreamContextPolicy` |
| Behavioral | "time you handled a crisis" / "conflict" / "leadership" | STAR, real facts, first person; STAR memory selected | `AnswerPlannerValidator`, `ProfileIntelligenceSpec` |
| Negotiation | "What salary are you expecting?" / "Can you accept this offer?" / "budget is lower" | negotiation context included, **sensitive allowed**, no leakage elsewhere | `ProfileIntelligenceSpec`, `CustomContextClassifier`, `StreamContextPolicy` (`modeAnswerType` → negotiation surfaces sensitive) |
| **Coding exclusion** | "Solve Two Sum" / "Explain BFS" / "Write LRU Cache" | profile **excluded**, JD excluded, salary excluded, coding contract used | `CodingContract`, `ContextRoute`, **`StreamContextPolicy` (intercept denied)** |
| Sales | "Why is your product expensive?" / "reduce pricing?" / "compare to X" | sales/product/pricing only; resume/JD **excluded** | `AnswerPlannerValidator` (sales forbids resume/jd/negotiation), `StreamContextPolicy` |
| Lecture/meeting | "Explain this slide" / "action items?" / "what did they decide?" | transcript/reference context; profile excluded unless about the user | `modePrompts`, `AnswerPlannerValidator` (lecture forbids resume/jd) |

## 3. New tests added in this change

### D1 — decision authoritative on execution (`StreamContextPolicy.test.mjs`, 12 cases)
- `profileInterceptAllowedByRoute`: **excludes** profile for coding / technical-concept
  / sales / lecture; **includes** for identity / projects / jd-fit / behavioral;
  legacy (no route) → allowed.
- `modeAnswerType`: defaults to `general_meeting_answer` (prior hardcoded value)
  when no route; uses the **real** answer type otherwise — so a real negotiation
  answer can surface sensitive custom context (impossible when hardcoded), and
  every other type is scoped correctly.

### D2 — ingestion resilience (`HeuristicExtractor.test.mjs` 16, `IngestResilience.test.mjs` 3)
- Heuristic extractor: name (incl. ALL-CAPS-header rejection, name-only resume,
  email-derived), contact regex, 7-bucket skills, experience role/company,
  project names, education; satisfies the **production** `profileFactsReady`
  predicate; never fabricates (empty → not-ready); JD title/requirements/enum
  defaults.
- Orchestrator: **extraction-LLM failure → heuristic fallback → ingest SUCCEEDS,
  profile READY** (the live real-UI failure, now fixed); embed-endpoint failure
  does not break the answerable profile; `PI_HEURISTIC_EXTRACTION=off` restores
  throw behavior.

### D3 — status contract
- IPC type (`src/types/electron.d.ts`) now declares all readiness fields +
  `extractionMode`; backend handler returns `extractionMode`. (Type-level;
  verified by `tsc` on both projects.)

## 4. Regression guards (must stay green)

- `electron/llm/__tests__/**` — **545 pass** (full router/validator/coding/
  custom-context/mode-prompt deterministic suite, incl. the 35 spec §11 cases).
- `electron/services/__tests__/KnowledgeOrchestratorIngest.test.mjs` — ingest
  pipeline still produces correct identity/experience/skill blocks (proves the
  LLM-primary path is untouched).
- No-profile / non-premium: all PI grounding paths no-op when `activeResume` is
  null (existing behavior; `processQuestion` returns null, fast-path returns
  null, V2 grounding returns empty block).
- Kill-switches verified: `PROFILE_GROUNDING_V2=off` (existing),
  `PI_HEURISTIC_EXTRACTION=off` (new).

## 5. Live release gates (blocked on credentials/GUI here — do not fabricate)

These prove the end-to-end seam against the real API/UI and are the true
acceptance gate. They could not be run in this environment (no working
`NATIVELY_TEST_API_KEY`; the project's Gemini key was billing-blocked, which is
itself what triggers the D2 path). Run when a key + GUI are available:

```bash
# Real API
NATIVELY_TEST_API_KEY=<key> node --experimental-strip-types \
  intelligence-eval-real-api/run-real-api-e2e.ts

# Real UI (Playwright + Electron)
NATIVELY_TEST_API_KEY=<key> npm run eval:intelligence:ui -- --profiles=data-analyst --max=10
```

Expected deltas from the prior FAIL runs:
- **Real UI:** `resumeLoaded`/`jdLoaded` should become **true** even with a
  dead extraction LLM (D2 heuristic fallback) → `DA-001/002/003/010` (identity /
  projects) should PASS where they previously failed `missing_required_fact`.
- **Real API:** no `forbidden_context_layer_selected:resume` on coding WTA
  (D1 makes the execution path honor the route; the candidate-profile gate +
  `ignoreKnowledgeMode` already closed the WTA case, this adds defence-in-depth
  on the general path). Latency stalls were a billing-dead key (environment), not
  this code; re-measure with a live key.

## 6. Acceptance-criteria → evidence map (spec §15)

| Criterion | Evidence |
|-----------|----------|
| 1. identity answered from profile | `manualProfileIntelligence`, `ProfileIntelligenceSpec`; D2 makes facts ready even LLM-down |
| 2. candidate answers in first person | `ProfileOutputValidator`, `ProfileIntelligenceSpec` |
| 3. never answers profile Qs as Natively | `ProfileOutputValidator` (`assistant_identity_leak`), `IdentityGuard` |
| 4. no profile in generic coding | `ContextRoute`, `CodingContract`, **`StreamContextPolicy`** (intercept denied) |
| 5. JD only when relevant | `ContextRoute`, `ProfileIntelligenceSpec` |
| 6. negotiation context only for negotiation | `StreamContextPolicy` (`modeAnswerType`), `CustomContextClassifier` |
| 7. sales context only for sales | `AnswerPlannerValidator` (sales forbids resume/jd/negotiation) |
| 8. persona is style not facts | unchanged-by-design (IDENTITY GUARD in prompts) |
| 9. validates/repairs wrong perspective | `ProfileOutputValidator` (+ repair instruction) |
| 10. fast enough for live | fast-path < 5ms; bounded grounding 2s; hybrid 1.5s; D2 removes the ~91s extraction stall when LLM down |
| 11. no-profile/non-premium still work | regression: PI paths no-op when no profile |
| 12. premium optional loading still works | `KnowledgeOrchestratorIngest` |
| 13. tests prove inclusion AND exclusion | `StreamContextPolicy` (both), `ContextRoute`, this matrix |

## 7. Results (this environment, 2026-06-04)

```
npm run build:electron            → OK
tsc -p electron/tsconfig.json     → 0 errors
tsc -p tsconfig.json (renderer)   → 0 errors
electron/llm/__tests__/**         → 545 pass / 0 fail
StreamContextPolicy.test.mjs      → 12 pass / 0 fail   (D1)
HeuristicExtractor.test.mjs       → 16 pass / 0 fail   (D2)
IngestResilience.test.mjs         →  3 pass / 0 fail   (D2)
KnowledgeOrchestratorIngest       →  6 pass / 0 fail   (regression)
Combined PI + new                 → 350 pass / 0 fail
Real API / Real UI gates          → NOT RUN (no key / GUI) — commands in §5
```
