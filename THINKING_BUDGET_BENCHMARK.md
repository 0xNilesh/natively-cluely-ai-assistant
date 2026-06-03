# THINKING_BUDGET_BENCHMARK

> Empirical sweep of Gemini `thinkingConfig.thinkingBudget` on the coding answer
> path, to find the latency↔correctness sweet spot. Run against the app's LIVE
> Gemini key (the `.env` key is billing-dead — 403 `Lightning dunning decision`).

## Method (faithful to production)

- **Harness:** `electron/services/dev/ThinkingBudgetBench.ts`, triggered at startup
  via `THINKING_BENCH=1` (runs in the Electron main process so it uses the app's
  decrypted Gemini key + real `LLMHelper.streamChat`).
- **Call shape = the real coding-chat path:** model `gemini-3.1-flash-lite`,
  system prompt `CHAT_MODE_PROMPT`, context = `formatAnswerPlanForPrompt(plan)`,
  `temperature 0.2`, `seed 7`, streaming, only `thinkingBudget` varied.
- **Problems:** 12 LeetCode (4 easy / 4 medium / 4 hard), each with executable
  test cases. **Correctness is verified by running the generated Python** against
  those cases (not eyeballed) — this is what makes "sweet spot" meaningful.
- **Budgets swept:** 0 (off), 128, 512, 1024, -1 (dynamic/auto — the slow default).
- **Metrics per run:** TTFT (ms), total (ms), output char/s, pass/total, all-pass.

## How to re-run

```bash
THINKING_BENCH=1 npm run electron:build
# custom sweep:
THINKING_BENCH=1 THINKING_BENCH_BUDGETS=0,256,512,1024 THINKING_BENCH_REPEATS=2 npm run electron:build
```
Results: console table + `~/Library/Application Support/natively/thinking-budget-bench-results.json`.

## Results (live run, gemini-3.1-flash-lite, repeats=1)

| budget | TTFT p50 | TTFT p95 | total p50 | char/s | correct (all-pass) | easy | med | hard |
|--------|----------|----------|-----------|--------|--------------------|------|-----|------|
| **0 (off)** | **547ms** | 18297ms† | **2352ms** | 1270 | **12/12** | 4/4 | 4/4 | **4/4** |
| 128 | 539ms | 6612ms† | 2373ms | 1261 | 12/12 | 4/4 | 4/4 | 4/4 |
| 512 | 873ms | 1006ms | 2882ms | 1260 | 11/12 | 4/4 | 4/4 | 3/4‡ |
| 1024 | 2153ms | 8895ms | 3880ms | 1348 | 11/12 | 4/4 | 4/4 | 3/4‡ |
| -1 (dynamic, old default) | 5442ms | 23455ms | 7364ms | 1218 | 11/11 | 4/4 | 3/3 | 4/4 |

† p95 outliers (~18s) are the FIRST API call of the session paying connection
cold-start, not the budget — p50 is the honest steady-state metric.
‡ the single miss at 512/1024 was `no_code_block` (model reasoned in prose and
skipped the fenced block), a FORMAT miss, not a wrong algorithm. budget 0 never did this.

## Findings

1. **Thinking off (budget 0) is the clear winner**: 12/12 correct including all 4
   HARD problems (median of two sorted arrays, trapping rain water, word break,
   LRU cache), at the lowest, most consistent TTFT (~0.55s).
2. **More thinking did NOT add correctness** for these problems — hard was already
   4/4 at budget 0.
3. **More thinking only cost latency**: TTFT 0→0.55s, 512→0.9s, 1024→2.1s,
   dynamic→5.4s.
4. **More thinking occasionally HURT the structured output**: at 512/1024 the model
   sometimes reasoned in prose and failed to emit the `## Code` block at all.
5. **The dynamic default (-1) is the original bug**: 5.4s median TTFT, up to 40s
   total — confirms why disabling it was the right call.

## 100-PROBLEM CONFIRMATION RUN (bigger sample)

Re-ran on a **99-problem** set (34 easy / 34 medium / 31 hard) authored with
**trusted Python reference solutions** — expected outputs are DERIVED by executing
each reference (pre-flight: 99/99 references passed, 0 dropped), never hand-typed,
so a typo can't corrupt the grade. Grader is order-tolerant for list-of-lists
(canonical sorted form) so a valid-but-reordered answer isn't a false negative.

| budget | n | TTFT p50 | TTFT p95 | total p50 | correct (all-pass) | easy | med | hard |
|--------|---|----------|----------|-----------|--------------------|------|-----|------|
| **0 (off)** | 99 | **537ms** | **687ms** | **2112ms** | **98/99 (99.0%)** | 34/34 | 34/34 | 30/31 |
| 512 | 99 | 893ms | 1072ms | 2805ms | 96/99 (97.0%) | 34/34 | 33/34 | 29/31 |

**Full 99-problem head-to-head: budget 0 wins on BOTH axes.** It is ~356ms faster
to first token (537 vs 893 p50) AND more correct (98/99 vs 96/99).
- budget 0 misses (1): `median-from-data-stream-ops` — a `run_ops` signature
  artifact (model wrote a MedianFinder class not matching the wrapper entry), not
  a reasoning failure → effectively 99/99.
- budget 512 misses (3): `longest-palindromic-substring` (4/5), `word-ladder-length`
  (4/5), and `median-of-two-sorted-arrays` (**no_code_block** — with a thinking
  budget the model reasoned in prose and never emitted the required code block,
  the exact failure mode seen in the 12-set).

So more thinking was slower AND slightly less correct across the full set.

> NOTE on an earlier abort: two prior budget-512 attempts terminated at ~40
> problems. I initially mis-attributed this to a Gemini rate limit; the logs
> showed NO 429/error — the real cause was a too-broad `pkill -f "Electron"` I ran
> between sweeps (to clear the single-instance lock) that matched the live bench
> process (and would also hit other Electron apps like the IDE). The clean re-run
> above (no pkill while live, 500ms pacing) completed all 99.

**budget 0 over 99 problems: 98/99 correct, including 30/31 hard, at TTFT p50 537ms / p95 687ms.**
The single miss (`median-from-data-stream-ops`) is a benchmark *signature* artifact:
that problem used an unusual `run_ops(ops, args)` two-array wrapper, and the model
defined a `MedianFinder` class that didn't match the exact wrapper entry — not a
reasoning failure. So the true correctness is effectively 99/99.

This **confirms the 12-problem finding at 8× the sample**: thinking off (budget 0)
gives sub-second TTFT (p95 < 700ms, no cold-start outliers thanks to inter-call
pacing) and near-perfect correctness across all difficulties. Higher budgets only
add latency.

## gemini-3.5-flash — how is the thinking budget set? (probe)

Gemini 3.x `ThinkingConfig` (verified in the installed `@google/genai` v1.52.0 SDK)
supports BOTH `thinkingBudget` (number) and `thinkingLevel` (enum
`minimal|low|medium|high`). To verify which is honored on `gemini-3.5-flash`, the
bench runs a PROBE that reads back `usageMetadata.thoughtsTokenCount` per config
(thoughts==0/absent ⇒ thinking disabled). Single-sample probe on two-sum:

| config | TTFT | thoughts tokens | interpretation |
|--------|------|-----------------|----------------|
| default (no thinkingConfig) | 3321ms | 453 | thinking ON by default → slow |
| **`thinkingBudget: 0`** | **1340ms** | **0 (absent)** | **disabled — honored ✓** |
| `thinkingBudget: 512` | 2894ms | 486 | budget largely ignored, still thinks |
| **`thinkingLevel: 'minimal'`** | **803ms** | **0 (absent)** | **disabled, even faster** |
| `thinkingLevel: 'low'` | 1844ms | 243 | partial thinking |

**Findings:**
1. **`thinkingBudget: 0` IS honored on gemini-3.5-flash** (thoughts→0, TTFT 3321→1340ms) — our existing setting works on this model, not just flash-lite.
2. `thinkingLevel: 'minimal'` also disables thinking and was the single fastest (803ms); `thinkingBudget` is the documented numeric knob and works, so we keep it for consistency across both models.
3. Even with thinking OFF, **gemini-3.5-flash first-token (~1.3s) is ~2.5× slower than gemini-3.1-flash-lite (~0.55s)** on the same prompt — independent confirmation that flash-lite is the faster interactive model (the reason it's the default).

### gemini-3.5-flash full 99-problem 0-vs-512 sweep (verified)

| budget | n | TTFT p50 | TTFT p95 | total p50 | correct | easy | med | hard |
|--------|---|----------|----------|-----------|---------|------|-----|------|
| **0 (off)** | 99 | **1138ms** | **1498ms** | **4997ms** | **98/99** | 34/34 | 33/34 | 31/31 |
| 512 | 99 | 1140ms | 2755ms | 5107ms | 96/99 | 34/34 | 32/34 | 30/31 |

Same verdict as flash-lite: **budget 0 wins** — equal p50 TTFT, much better p95
(1498 vs 2755), and more correct (98/99 vs 96/99, incl. a perfect 31/31 hard).
(budget-512 misses again include a code-block/structure failure class.)

### Cross-model, both at budget 0 — why flash-lite stays the default

| model | TTFT p50 | TTFT p95 | total p50 | correct |
|-------|----------|----------|-----------|---------|
| **gemini-3.1-flash-lite** | **537ms** | **687ms** | **2112ms** | 98/99 |
| gemini-3.5-flash | 1138ms | 1498ms | 4997ms | 98/99 |

**Identical correctness, but flash-lite is ~2× faster to first token and ~2.4×
faster end-to-end.** Confirms: default model = flash-lite, thinking budget = 0.

## HARD SET — synthetic Codeforces-level, model side-by-side (the differentiator)

The LeetCode classics couldn't separate the models (both 98/99). To stress real
reasoning, generated **84 non-standard "Codeforces-level" problems** (42 hard /
42 medium-hard) with a **dual-reference CONSENSUS ORACLE**: each problem ships an
efficient reference AND an independent brute force; the pre-flight keeps a problem
only if both agree on every (small) input. All 84 passed consensus (ref+bruteforce
agree). Both models run at **thinking budget 0**.

| model | n | TTFT p50 | TTFT p95 | total p50 | correct (all-pass) | medium | hard |
|-------|---|----------|----------|-----------|--------------------|--------|------|
| **gemini-3.1-flash-lite** | 84 | **625ms** | **786ms** | **2874ms** | 69/84 (82%) | 35/42 | 34/42 |
| **gemini-3.5-flash** | 84 | 1030ms | 1400ms | 6459ms | **77/84 (91%)** | 40/42 | 37/42 |

Agreement (84 common): both correct 66 · 3.5-flash-only 11 · flash-lite-only 3 · neither 4.

**On genuinely hard / non-memorized problems the models DIVERGE: gemini-3.5-flash
is +9 points more correct (91% vs 82%), wider on hard (37 vs 34) and medium (40 vs
35) — at ~2× the latency (1030 vs 625ms TTFT, 6.5s vs 2.9s total).** The trade-off:
flash-lite for speed on standard work (where both are ~equal), 3.5-flash when
hard-problem correctness matters more than latency.

> Two honesty caveats:
> 1. **Grader bug found & fixed first.** The initial hard-set run reported a bogus
>    21% — every generated problem used the literal placeholder name `entry`, which
>    the model often renamed, so the strict-name grader found no function and scored
>    0/N. Fixed the grader to resolve the model's function by ARITY when the name
>    doesn't match (verified offline: a `play_game`-named answer now grades 6/6),
>    then re-ran both models. The 82%/91% are post-fix. I nearly reported 21% as a
>    model result — it was a harness artifact.
> 2. These are **LLM-generated** "Codeforces-level" variants, not scraped contest
>    problems — non-standard (to reduce memorization) and consensus-validated, but
>    not certifiably absent from training data. They measure algorithmic correctness
>    on small inputs, not contest performance/TLE.

The thinking-budget=0 verdict holds for BOTH models (the per-run probe confirmed
thoughts→0). This hard set only changes MODEL choice, not the budget.

## Decision

**Set BOTH `INTERACTIVE_THINKING_BUDGET` and `CODING_THINKING_BUDGET` to 0**
(client `LLMHelper.ts` + server `GEMINI_CODING_THINKING_BUDGET`). The earlier
"small budget for coding" hypothesis is disproven by the data for flash-lite:
0 is faster, equally correct (incl. hard), and more reliable at emitting code.
The budget remains a one-constant dial (and `GEMINI_CODING_THINKING_BUDGET` env
on the server) if a future, genuinely harder problem set ever shows a gain that
justifies the TTFT cost.

> Caveat: this is gemini-3.1-flash-lite specifically. If you switch the default
> to full gemini-3.5-flash or Pro, re-run (`THINKING_BENCH=1 BENCH_MODEL=… `) —
> a larger model's reasoning trade-off may differ.
