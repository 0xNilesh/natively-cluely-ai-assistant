# Manual UI Truth Test Report — 2026-06-08

## Why this exists

The prior benchmarks scored `planAnswer()` routing and backend wrappers — they were
green while the **real manual-send path** returned "I'm Natively" for identity and the
generic intro for everything. The benchmark was not faithful to the path the chat
button actually runs. This test fixes that.

## What it tests — the EXACT manual path

`benchmarks/profile-intelligence/run_manual_ui_truth_eval.ts` replays the precise
`ipcHandlers.gemini-chat-stream` sequence (no mocks, real backend):

```
planAnswer(manual_input)
→ context-free bare-followup clarification
→ fast-path eligibility (skip coding / assistant-meta / stealth / contract types)
→ buildManualProfileBackendAnswer (deterministic profile fast-path)
→ candidate-contract injection (answerType + STYLE directive + template) for
   profile-required candidate types + styled questions
→ streamChat (real LLM, gemini-3.1-flash-lite)
→ candidate sanitizer
→ final answer the user sees
```

It does **NOT** call `planAnswer()` alone or `buildManualProfileBackendAnswer()` alone.

## Scoring — generic-intro-collapse detector + voice/style/depth

Per case:
1. candidate identity/profile answers must NOT contain "I'm Natively / AI assistant".
2. **mustNotBeIntro**: a non-intro question must NOT return the generic self-intro
   (similarity vs the captured intro answers > 0.7 → fail).
3. **cross-case collapse**: if 5+ different answer types produce near-identical output
   (first 60 chars match), the whole group fails.
4. stall guard ("Let me come back to that") → fail.
5. style shape: one_liner = one sentence; bullets = a bulleted list.
6. skill-rating must contain a number.
7. mustInclude / mustNotInclude substring rules (e.g. forbid "one of the skills I work with").

Provider-empty rows are quarantined (rate-limit, not a logic defect).

## Dataset — the 27 exact user cases

`manual_ui_truth_dataset.json`: introduce yourself (+typo/greeting variants), who are
you, what is your name, what should I call you, why should we hire you (+brief / one
sentence / bullets / in detail / confident-but-honest), rate Python out of 10, Python
out of 10?, how strong in SQL, and what about Python, how/where have you used
Python/FastAPI, how would you use Python, why fit for Data Analyst, full-stack-vs-
analyst bridge, how does Natively prove data analysis, what gap, strongest JD match.

## Results

| metric | result | gate |
|---|---|---|
| pass rate | **100.0%** (27/27 scored) | 100% ✅ |
| assistant-identity leaks | **0** | 0 ✅ |
| generic-intro collapse | **0** | 0 ✅ |
| stalls ("come back to that") | **0** | 0 ✅ |
| style compliance (one-liner/bullets shape) | ✅ | ≥95% ✅ |
| skill-experience depth (no "X is a skill") | ✅ | ≥95% ✅ |

Sample of the fixed answers (real backend):
- "who are you?" → **"My name is Evin John."**
- "Why should we hire you in one sentence." → **one-sentence** jd_fit answer
- "why should we hire you in bullet points." → **bulleted** jd_fit answer
- "Rate your Python skills out of 10." → **"I would rate my Python a 9/10, as I…"**
- "How have you used Python?" → **"I've used Python hands-on in my work as an … Engineer at …"**
- "What is your strongest match for the JD?" → **"My strongest match is my experience building…"** (no stall)

## Run it

```bash
npm run benchmark:manual-ui-truth
```

Artifacts: `manual_ui_truth_results.json`, `manual_ui_truth_failures.json`.

## Verdict

The exact user failure log **fails before the fix and passes after** — through the real
manual path, with a scorer that permanently catches assistant-identity leaks, generic-
intro collapse, stalls, weak skill answers, and missing style shape. This is the gate
the benchmark was missing.
