# Real Manual Path Regression Report — 2026-06-08 (+ Round I polish 2026-06-09)

> **Round I update (2026-06-09):** the Round-H "remaining issue" (a `What gap` question
> leaned toward a fit-summary) is FIXED — a dedicated `gap_analysis_answer` now produces
> an honest gap + mitigation (first-person, no fit-summary, no stall). The manual UI
> truth eval was expanded to **80 cases** (gap/jd-fit/skill/coding/safety/source/meeting/
> lecture/sales) and passes **100%** on the real ipcHandlers path (0 leaks/collapse/
> stalls). WTA-100 100% (19/19 identity), all memory benchmarks 100%, 1578 tests, route
> 1000/1000. Multimode clean rows 100% with 0 real failures (denominator
> provider-limited this window — see `FINAL_MANUAL_PATH_POLISH_REPORT.md`). Senior review
> APPROVE WITH SUGGESTIONS (0 CRITICAL/HIGH; the one LOW — length-gate the benchmark
> outage classifier — was applied). NOT committed pending a clean multimode rerun.

---

# Real Manual Path Regression Report — 2026-06-08

## Stale build vs real logic bug?

**Both — but the real logic was genuinely broken.** Diagnosis:

- The user's "who are you? → I'm Natively, an AI assistant" came from a **partly stale
  build** (the current source returned "Your name is Evin John", not "I'm Natively").
- BUT the current source (rebuilt clean from `daa4655`) reproduced the OTHER reported
  bugs exactly: identity in **2nd person** ("Your name is…"), skill questions →
  **"Yes, X is one of the skills I work with."**, and JD-fit/skill-rating/gap/strongest
  -match → the **generic self-intro** (or "Let me come back to that").

So this was a **real logic bug**, fixed in the product code — not just a rebuild.

## Root cause

The manual fast-path keyed candidate **voice** off `source` alone:
`firstPerson = source === 'what_to_answer' || source === 'transcript'`. In manual mode
(`source='manual_input'`) `firstPerson` was always FALSE, so:

1. **Identity** answered 2nd-person ("Your name is…") — and where the profile wasn't
   ready or the question tripped the assistant guard, it fell to the LLM which said
   "I'm Natively, an AI assistant."
2. **Skill experience** had a weak fallback ("Yes, X is one of the skills I work with.")
   when no project linked the skill.
3. **JD-fit / skill-rating / gap / strongest-match** didn't fast-path → reached the
   LLM, which received the profile facts as **raw context with no answer-type
   instruction**, so it recited the **generic self-intro** for every one of them
   (the "everything collapses to one intro" symptom). The adaptive **style** never
   reached the model either (no contract in the manual non-fast-path).

## Files changed

| file | fix |
|---|---|
| `electron/llm/manualProfileIntelligence.ts` | candidate **first-person voice** when a profile is loaded AND the question addresses the candidate ("who are you", "your name", intro, "why hire you") — second-person kept only for self-queries ("what is MY name"); assistant-meta ("are you an AI / what is Natively") always bails to the assistant path. Skill-experience rewritten to give **where/how evidence** (project or role/company), honest fallback instead of "X is one of the skills". `a`/`an` article fix. |
| `electron/ipcHandlers.ts` | **candidate-contract injection**: for any profile-required candidate answer type (jd_fit/skill/behavioral/project/identity/negotiation) OR any styled question, ADDITIVELY prepend the answer-contract (answerType + STYLE directive + template) to the context — so the LLM produces the RIGHT answer type AND honors the requested style, instead of collapsing to the intro. |
| `electron/llm/__tests__/manualProfileIntelligence.test.mjs` | updated to assert the NEW correct first-person behavior (the old tests encoded the buggy 2nd-person behavior). |

## Manual UI path verified — YES

A new eval, `run_manual_ui_truth_eval.ts`, replays the **EXACT `ipcHandlers`
manual-send sequence** (plan → clarification → fast-path eligibility →
buildManualProfileBackendAnswer → candidate-contract injection → streamChat →
sanitizer), NOT `planAnswer` alone, NOT a backend wrapper. It runs the 27 exact
user-reported cases and scores with a **generic-intro-collapse detector** +
voice/style/depth rules. `npm run benchmark:manual-ui-truth`.

## Exact user failure log — before / after

| input | BEFORE (user-reported) | AFTER (this fix, real path) | type | via |
|---|---|---|---|---|
| `who are you?` | I'm Natively, an AI assistant. | **My name is Evin John.** | identity | fast_path |
| `what is your name?` | I'm Natively, an AI assistant. | **My name is Evin John.** | identity | fast_path |
| `what should I call you?` | Your name is Evin John. | **My name is Evin John.** | identity | fast_path |
| `Why should we hire you?` | generic intro | **real jd_fit answer** (backend/data bridge) | jd_fit | llm (contract) |
| `…in one sentence.` | generic intro | **one-sentence** jd_fit | jd_fit (style=one_liner) | llm |
| `…in bullet points.` | generic intro | **bulleted** jd_fit | jd_fit (style=bullets) | llm |
| `…in detail.` | generic intro | **structured detailed** jd_fit | jd_fit (style=detailed) | llm |
| `Rate your Python skills out of 10.` | generic intro | **"I would rate my Python a 9/10, as I…"** | skill_experience | llm |
| `How strong are you in SQL?` | generic intro | **"I'd rate my SQL an 8/10, as I…"** | skill_experience | llm |
| `How have you used Python?` | (would be) "Yes, python is one of the skills…" | **"I've used Python hands-on in my work as an … Engineer at …"** | skill_experience | fast_path |
| `Have you used FastAPI?` | "Yes, fastapi is one of the skills…" | **"Yes — I've used FastAPI in my work at …"** | skill_experience | fast_path |
| `Why are you fit for this Data Analyst role?` | generic intro | **real jd_fit** | jd_fit | llm |
| `What gap do you have for this role?` | generic intro | **real jd_fit answer** (honest, not the intro) | jd_fit | llm |
| `What is your strongest match for the JD?` | Let me come back to that. | **"My strongest match is my experience building…"** | (unknown→jd) | llm |
| `are you an AI?` | — | (LLM, answers about the app) | — | assistant-meta |
| `what is Natively?` | — | (LLM, answers about the app) | — | assistant-meta |

## Tests run

- **Manual UI truth eval: 100% pass** (27/27 scored, 0 assistant-leaks, 0 intro-collapse, 0 stalls).
- **14 new manual-regression unit tests** + updated existing manual tests.
- **Full llm suite: 1399 pass / 0 fail.**
- **Route: residual 50/50, multimode 1000/1000** (routing unchanged).
- **No regression**: WTA first-person preserved; long-session / livememory / replay all 100%.
- **Multimode-1000 (manual + WTA) live regression: pass 100.0%, route 100%, safety
  100%** (clean=773), **0** idLeak / refusal / stealth / codingLeak / ctxLeak / invented
  / hallucinated / wrong-voice. The manual fix did not regress WTA, routing, or any
  safety/leak gate.

## Remaining issues

- "What gap do you have for this role?" returns a real jd_fit answer but leans toward a
  fit-summary rather than an explicit gap — a quality polish (not the regression; it is
  NOT the intro). A gap-specific template instruction is a low-risk follow-up.
- Answer-quality full numbers are provider-bound (flash-lite rate-limits).

## Senior review (@code-reviewer)

**APPROVE WITH SUGGESTIONS, 0 CRITICAL.** Confirmed the security/leak axes are sound:
assistant-identity no longer leaks, meta-questions still bail, WTA voice preserved,
self-queries stay second-person, contract injection can't leak profile into coding
(it's self-protecting via the plan's own `profileContextPolicy` line). Found and FIXED:
- **HIGH** — my first skill-experience rewrite asserted "I've used X … where it was
  central to what I built" at a role even when nothing linked the skill to it (a
  falsifiable resume hallucination). FIXED: `where` is now only project-grounded OR an
  experience entry whose role/tech/description actually mentions the skill; an
  ungrounded skill gets the honest "part of my toolkit, a specific project isn't
  highlighted" fallback (never a fabricated role claim). Regression-tested.
- **MEDIUM** — the fast-path `asksAboutSelf` voice heuristic diverged from the planner.
  Tightened: the second-person exclusion is scoped to genuine candidate-address ("your
  X", "are/have/did you", "yourself"), and "have i"/"do i" added to the self-signal.

## Production verdict

**The release-blocking manual regression is fixed.** Identity answers as the candidate
(never "I'm Natively"), different answer types produce different content (no intro
collapse), skill answers give real evidence, and adaptive style reaches the model in the
manual path — all verified through the EXACT ipcHandlers manual sequence, not a backend
wrapper. WTA and routing are unbroken.
