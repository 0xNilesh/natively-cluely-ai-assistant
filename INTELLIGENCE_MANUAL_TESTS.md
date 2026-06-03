# INTELLIGENCE_MANUAL_TESTS

Exact manual steps to validate the intelligence layer end-to-end in the running
app. Run after `npm run app:dev` (or a built app) with at least one cloud
provider key configured. For profile/identity and negotiation cases, upload a
resume/JD and set a custom mode so Profile Intelligence (premium) is active.

Each step lists **what to do** and the **expected behaviour**. "WTA" = the
overlay "What to answer?" action (keybind or button). "Manual" = typing a
question into the chat box.

---

## 1. Coding interview — full structure
1. Start a meeting / interview mode. Manual: type **"Solve Two Sum"**.
2. **Expect:** answer streams quickly and renders the six sections **in order** —
   `## Approach`, `## Technique / Data Structure / Algorithm Used`, `## Code`
   (one fenced block, language-tagged), `## Dry Run`, `## Complexity` (Time +
   Space), `## Interviewer Follow-up Points`. The answer must **not** start with
   code, and must **not** contain resume/JD/salary text.

## 2. Coding interview — "code only" override
1. Manual: type **"Just give me the code for Two Sum"**.
2. **Expect:** the model may return primarily code (the explicit code-only ask is
   honoured). The six-section contract is NOT force-applied when the user asked
   for code only.

## 3. Recruiter — "What is your name?"
1. Knowledge mode ON (resume uploaded). In the transcript, the interviewer asks
   **"What is your name?"**. Trigger **WTA**.
2. **Expect:** answers **as the candidate** in first person using the resume
   identity ("I'm <Name>, …"). Never "I am Natively" / "as an AI". No coding
   scaffold, no salary/JD text.

## 4. Recruiter — "Tell me about yourself"
1. Interviewer asks **"Tell me about yourself"**. Trigger **WTA**.
2. **Expect:** a first-person candidate intro grounded in the resume (uses the
   cached AOT intro if available, else a JIT intro). No coding scaffold.

## 5. Recruiter — salary expectation (sensitive gating)
1. Put a salary note in the mode's custom context, e.g. *"My current CTC is 30
   LPA, target 45 LPA."* Interviewer asks **"What salary are you expecting?"**.
   Trigger **WTA**.
2. **Expect:** a negotiation-style answer that **may** use the salary context
   (this is the only answer type allowed to). The tone is collaborative; it
   states a grounded range/expectation.
3. **Contrast:** ask a **behavioral** question ("Tell me about a conflict you
   resolved") with the same salary note present. **Expect:** the answer does
   **NOT** mention the salary/CTC numbers — sensitive custom context is dropped
   for non-negotiation answers.

## 6. Sales — pricing objection
1. Sales mode with pricing reference material. Prospect asks **"Why is this
   product so expensive?"**. Trigger **WTA**.
2. **Expect:** an objection-handling answer that uses the pricing/sales context;
   no resume/coding artifacts.

## 7. Lecture — concept question
1. Lecture mode. Professor asks **"Explain amortized constant time."**.
   Trigger **WTA**.
2. **Expect:** a concise educational explanation. No resume/JD/salary, no coding
   scaffold (unless the question is itself a coding/DSA ask).

## 8. Meeting — action items
1. Team-meeting mode with a few minutes of transcript. Manual/WTA: **"What are
   the action items?"**.
2. **Expect:** a short, structured list of action items derived from the
   transcript; no hallucinated owners/dates beyond what was said.

## 9. Filler handling
1. Interviewer asks a real question (e.g. **"How would you reverse a linked
   list?"**), then says **"okay cool yeah"**. Trigger **WTA**.
2. **Expect:** the app answers the **real question** (reverse a linked list with
   the coding contract), NOT the filler. Filler turns are ignored by the latest-
   question extractor.

## 10. Follow-up handling
1. After any prior answer, the interviewer asks **"why?"** or **"what about
   complexity?"**. Trigger **WTA**.
2. **Expect:** the answer is resolved as a **follow-up** to the previous turn
   (pulls prior context / the named target), not treated as a brand-new
   standalone question.

---

## Latency / streaming spot-checks
- On any WTA/coding answer, confirm **first useful text appears quickly** and the
  answer **streams** (you see it build, not a long freeze then a dump).
- Cold-start a custom mode with reference files and immediately trigger WTA: the
  answer must **not** hang ~30s waiting on the embedder — it falls back to lexical
  retrieval within ~1.5s. (Watch the main-process log for
  `hybrid retrieval exceeded 1500ms — using lexical fallback` if the embedder is cold.)

## Telemetry spot-check (optional, dev)
- With `MEASURE_LATENCY=true`, the WTA pipeline prints a per-stage breakdown.
- The live trace emits milestones incl. `answer_type_selected`, `context_selected`
  (carries the PII-free context-route summary — layer names + counts only),
  `first_useful_token`, `validation_completed`/`repair_used`. Confirm no raw
  resume/JD/transcript/salary text appears in any telemetry line.

## Automated gates (for reference)
```bash
npx tsc -p electron/tsconfig.json --noEmit          # typecheck (clean)
npm run build:electron                               # esbuild
node --test 'electron/llm/__tests__/**/*.test.mjs'   # 387 pass
node --test electron/services/__tests__/Mode*.test.mjs \
            electron/services/__tests__/ModeContextRetriever.test.mjs  # 148 pass
```

---

## Verified Code Execution (2026-06-03 feature) — manual steps

**Prerequisite:** a VALID model API key configured in the app (the keys in
`.env` were expired at build time). Python3 and/or Node must be on PATH for
local execution (g++ for C++). Verification runs in the BACKGROUND after the
answer is shown — watch for the badge/correction a beat after the answer lands.

### VCE-1 — Correct answer gets a ✓ verified badge
1. Ask a coding question with known examples: **"Solve Two Sum"** (chat) or via
   "What to answer?".
2. **Expect:** the six-section answer streams as normal; a second or two later a
   small green **`✓ verified · N/N test cases passed`** badge appears under it.
   The hidden `<verification_spec>` must NOT be visible anywhere in the answer.

### VCE-2 — Wrong answer is caught and corrected
1. Ask something the model sometimes gets subtly wrong, e.g.
   **"First missing positive integer in an array"** (the off-by-one class).
2. **If the model's code is wrong:** the first answer shows, then a NEW message
   appears: **"↻ Corrected answer — the previous code returned X for input Y"**
   with fixed code. **If the model's code is right:** you just get the ✓ badge.
3. Either way, the FINAL code you're shown must compile/run correctly — that's
   the guarantee. (Engine proven against the exact `firstMissingPositive`
   off-by-one in automated tests + a live run on the compiled module.)

### VCE-3 — Syntax error never ships as final
1. (Hard to force from the model now that the dash-corruption bug is fixed.) If a
   coding answer ever contains a syntax error, verification's smoke-run flags it
   (`error`) and a correction is posted. No valid-looking-but-broken code stays
   as the final answer.

### VCE-4 — Language coverage
- **Python / JavaScript / C++**: actually executed locally → real ✓ badge.
- **Java / Go / SQL**: skipped today (no false badge) — they need the gated cloud
  (Piston) runner, which requires a self-hosted `NATIVELY_PISTON_URL` (the public
  API is whitelist-only as of 2026-02-15).

### What was verified WITHOUT the GUI (this session)
The full pipeline was run against the **real compiled module the app loads**
(not mocks): correct Two Sum → pass/badge; the `firstMissingPositive` off-by-one
→ caught + corrected + re-verified; the `, 1` syntax class → caught via smoke
run; C++ Two Sum / firstMissingPositive via real `g++` → pass; wrong C++ → fail;
pointer signatures → safely skipped. The only unexercised link is the GUI click
and the live model-correction network call (model keys were expired in this env).
