# Answer Diversity Report (2026-06-12)

## Problem (real ~200-question session)
- The same generic intro returned for intro/background/style questions.
- Gap answers always rendered the same four-section scaffold.
- JD-fit answers exposed "Short Fit Summary / Matching Experience / Speakable
  Final Answer" labels.
- Identical answers reappeared across unrelated prompts late in the session.
- No per-session repetition mechanism existed at all (only a 10-item
  prompt-context "previousResponses" hint).

## What was built

### 1. `AnswerDiversityGuard` (`electron/llm/answerPolish.ts`)
- Keeps the last **20 answer fingerprints per app session** (first sentence,
  content-token set, visible scaffold-label signature, question).
- `check()` classifies a new answer as repeated when, against a DIFFERENT ask:
  - same first sentence (≥12 chars), or
  - same scaffold-label signature with ≥0.45 token overlap, or
  - ≥0.72 token-Jaccard near-duplicate.
- **`isSameAsk`** exempts synonymous phrasings ("main skills" vs "technical
  skills", ≥0.6 question-token overlap) — a factual answer legitimately repeats
  for the same ask; only cross-ask reuse is flagged.
- On repeat: the render boundary compresses the answer to speakable prose
  (`compressToSpeakable` — prefers the "Speakable Final Answer" body, strips
  labels); accepted only if the compressed form is itself not a repeat.
- Wired at the manual render boundary in `ipcHandlers.gemini-chat-stream`
  (after the candidate sanitizer, before `gemini-stream-done`).

### 2. Variant-aware deterministic intro (`manualProfileIntelligence.formatIntro`)
- The QUESTION now selects the intro shape (same grounded facts):
  - background/journey phrasing → experience-arc intro,
  - describe-yourself phrasing → working-style intro,
  - quick/brief → one-sentence intro,
  - default → hash-varied ordering across distinct phrasings.
- Deterministic: same question → same intro (testable, no RNG).

### 3. Scaffold hidden by default (`AnswerPlanner`)
- `isSpeakableOnlyPlan()`: gap/jd-fit/behavioral/project/negotiation templates
  become INTERNAL thinking structure; the rendered answer is natural prose
  unless the user explicitly asked for structure (detailed/bullets/exam/notes
  or an explicit "use STAR"). WTA is ALWAYS speakable.
- Plus a final-boundary `compressToSpeakable` net for any scaffold that still
  slips through.

### 4. Artifact cleanup (`cleanAnswerArtifacts`)
- Empty bullet markers ("*", "- ", "•") and dangling tail markers removed;
  blank-line runs collapsed; code blocks preserved byte-for-byte.
- Also fixed at the source: `postProcessor.stripMarkdown` now removes
  marker-only lines, and `formatSingleProject` no longer produces
  "is A privacy-first…" (article lowercased after the copula).

## Verification
- `ManualRealSessionFixes2026_06_12.test.mjs` — 36 tests covering the guard
  semantics, intro variants (3 distinct intros for intro/background/style),
  scaffold suppression matrix, bullet cleanup, and wiring pins.
- Sequential stress (216 prompts, one session) gates on: no exact answer reuse
  across unrelated prompts, no generic intro collapse, no visible scaffold on
  default style, no empty bullets — see `MANUAL_SEQUENTIAL_STRESS_REPORT.md`.
