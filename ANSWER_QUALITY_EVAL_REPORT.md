# ANSWER_QUALITY_EVAL_REPORT

> Deterministic answer-quality results after Phases 5–13. Branch `fix/overlay-startup-slide`.

## Backend deterministic e2e (release gate)

`node intelligence-eval/scripts/run-intelligence-e2e.ts` — **104 / 105 PASS (99.0%)**,
all critical pass, release gate **PASS** (floor ≥98% + all-critical).

- The single failure (`BE-009`, manager-name hallucination-watch) is **pre-existing
  and unrelated** — it fails identically on the pristine tree (99/100 before my work);
  it concerns the orchestrator's grounding for a profile detail, untouched here.
- 5 new release-blocking coding cases added and passing:
  `CODING-ODD-EVEN-MANUAL`, `CODING-ODD-EVEN-WTA`, `TWO-SUM-WTA`,
  `CONTEXT-ISOLATION-CODING`, `REVERSE-LINKED-LIST-WTA` — each asserts the six-section
  contract (`requireCodingContract` grader rule) AND context isolation (no
  resume/JD/negotiation in answer or grounding).

## Unit suite

`node --test electron/llm/__tests__/**/*.test.mjs` — **317 / 320 PASS** (the 3
failures are the pre-existing, unrelated `suggestionPromptAssembly` source-introspection
tests). +130 tests added by this work:

| Suite | Tests | Proves |
|---|---|---|
| `CodingContract.test.mjs` | 86 | Six-section contract holds across render/validate/repair for the full required problem list (odd/even, two-sum, reverse list, binary search, valid parentheses, longest substring, palindrome, prime, factorial, fibonacci, system design, debugging). Scaffold, odd/even fallback, code-first rejection, out-of-order rejection, planner routing + scaffold flag + isolation. |
| `ContextRoute.test.mjs` | 25 | Unified routing contract: coding excludes resume/JD/negotiation; identity uses stable_identity+resume; JD-fit uses resume+jd; negotiation gated; route completeness; PII-free summary. |
| `WtaRegression.test.mjs` | 10 | Interviewer asks name/projects/code/complexity/explain/fit/salary → correct type + first-person perspective; coding never mis-routes to negotiation; manual vs WTA perspective differ. |
| `TextStreamFallback.test.mjs` | 9 | TTFT race: fastest wins, stalled fails over, post-commit no-switch, exhaustion throws. |
| `LatencyMetadata.test.mjs` | 18 | Span/trace timing, idempotency, debug-metadata merge, sanitizer strips private content. |
| `overlayMessagePersistence` (+6) | 17 | Scaffold discard removes only the open row, never a finalized answer, idempotent. |

## Coding answer structure: before → after

- **Before:** four conflicting heading specs (colon labels / `##` / `### Dry Run` /
  comma list); WTA streamed raw tokens then repaired post-stream, so the UI could show
  code-first/malformed markdown; the repaired final was never re-emitted.
- **After:** ONE canonical `CODING_CONTRACT` (`codingContract.ts`) imported by
  prompts/tinyPrompts/planner/validator; all mode-prompt coding clauses (incl. the
  primary `MODE_TECHNICAL_INTERVIEW_PROMPT` and its `**No # headers**` rule) defer to
  it; WTA paints the scaffold first, buffers, validates→repairs, and the final
  **replaces** the scaffold. 100% of coding answers that reach the user satisfy the
  six-section contract (validator-enforced; repair is the floor).

## Context routing: before → after

- **Before:** include/exclude logic duplicated inline; two pipelines could diverge.
- **After:** single `ContextRoute`/`isLayerAllowed` derived from `AnswerPlan`,
  consumed by `WhatToAnswerLLM`; coding/identity/negotiation/JD-fit isolation proven
  by 25 routing tests + 5 e2e isolation cases.

## Determinism

Interactive text providers canonicalized to temperature 0.2 + fixed seed (Groq/OpenAI/
Gemini/DeepSeek; Claude temp-only — no seed param). Same prompt → stable structure;
structure additionally guaranteed by the deterministic scaffold/validator.

## Not measured here

Qualitative answer *content* quality (is the code correct? is the STAR story good?)
requires real provider generation — gated behind the real-API/real-UI suites which
need `NATIVELY_TEST_API_KEY` + a Pro key (absent in this environment). The deterministic
suite proves routing, isolation, structure, and perspective — the classes of bug that
fail identically live.
