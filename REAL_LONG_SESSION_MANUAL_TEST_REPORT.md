# Real Long-Session Manual Test Report (2026-06-12)

## Context
Manual testing of ~200 questions across multiple sessions (sets 16/17/18 in
lecture, sales, and looking-for-work modes) surfaced product-feel regressions
that the per-question benchmarks missed: assistant-identity leaks, canned/
repeated answers, visible scaffolds, empty bullets, sales-voice failures, a
"built with" false refusal, and lag after ~50 questions.

## Root causes → fixes (all verified by tests + the sequential stress eval)

| # | symptom (real session) | root cause | fix |
|---|---|---|---|
| 1 | "introduce yourself" / "who are you?" / "what is your name?" answered "I'm Natively, an AI assistant" | the manual IPC handler's identity-probe short-circuit (`IDENTITY_PROBE_RE`) fired BEFORE the candidate-profile fast path — benchmarks bypassed this gate, the real app didn't | NEW `electron/llm/manualIdentityRouting.ts` — assistant-meta probes stay canned; candidate-ambiguous probes route to the profile fast path whenever a profile is loaded (`resolveIdentityProbe`) |
| 2 | sales mode: "why is your product expensive?" → "I'm Natively… I don't have a product or pricing model" | (a) `CHAT_MODE_PROMPT` is on the "universal override" list so the SALES mode suffix was never appended on manual; (b) `sales_answer` had no answer contract and mapped to a neutral GENERAL template with "neutral assistant voice" | NEW `SALES_TEMPLATE` (seller/product-rep voice, forbids assistant identity, value-reframe objection handling); sales/lecture added to manual contract injection; mode injection no longer skipped for mode-scoped answer types |
| 3 | gap/JD-fit/behavioral answers always exposed "The Honest Gap / Short Fit Summary / Direct Answer / STAR" headings | templates said "Use exactly these sections" with no rendering policy for default style | `isSpeakableOnlyPlan` — sections are INTERNAL thinking structure by default; output is speakable prose; explicit detailed/bullets/exam/notes/"use STAR" keep structure; WTA always speakable; final-boundary `compressToSpeakable` as a net |
| 4 | empty bullet markers ("*") in answers | `stripMarkdown`'s bullet regex required trailing content; streaming path had no cleanup at all | marker-only-line removal in `postProcessor` + NEW `cleanAnswerArtifacts` at the manual render boundary (code blocks preserved) |
| 5 | generic intro reused across intro/background/style questions; same answers reappearing late in the session | one fixed `formatIntro` string; NO answer-diversity mechanism existed | variant-aware `formatIntro(profile, question)` (background-arc / working-style / quick / hash-varied default) + NEW `AnswerDiversityGuard` (last-20 fingerprints, same-first-sentence/scaffold/near-dup detection, same-ask exemption, speakable compression on repeat) |
| 6 | "What is Natively built with?" → "I can't share that information." | the security prompt's refusal scope didn't carve out the USER'S OWN loaded project sharing the product's name — the model read tech-stack questions as system-prompt probing | routing verified (`project_about_answer`); both security SCOPE paragraphs now explicitly carve out the user's own loaded projects |
| 7 | "My project Natively is A privacy-first…" grammar | `formatSingleProject` joined "is" + a description starting with a capitalized article | `afterCopula` lowercases the leading article; two-item lists also fixed ("SQL and Python", no Oxford comma) |
| 8 | lecture-mode "why?"/"explain" → generic clarification despite transcript context | bare-followup gate checked only the explicit `context` param, ignoring the rolling transcript snapshot; surface hardcoded 'manual' | gate now respects `autoContextSnapshot`; clarification speaks the active mode's surface (lecture/sales) |
| 9 | one `provider_timeout` at ~7003ms after `processQuestion` took ~6906ms | LIVE company research ran unbounded in the answer hot path | 2s budget (`Promise.race`); research continues in background for the next question |
| 10 | "Injecting pivot script(s)" on unrelated questions; 25–32k prompts | gap pivots injected for ANY candidate-directed question containing a gap-skill token | pivots gated on answer type (jd_fit / gap_analysis / behavioral only) |
| 11 | lag/hang after ~50 questions | meeting-end embedding/RAG drains interleave synchronous better-sqlite3 work with answers on the main process | NEW `ForegroundGate` — drains pause while a manual/WTA answer is in flight (see `BACKGROUND_JOB_ISOLATION_REPORT.md`) |

## Verification artifacts
- `electron/llm/__tests__/ManualRealSessionFixes2026_06_12.test.mjs` — 36 tests
- `npm run benchmark:manual-sequential-stress` — 216 prompts, ONE process/session,
  18 sets (16=lecture, 17=sales, 18=looking-for-work), event-loop + heap
  tracking, background-drain simulation → `MANUAL_SEQUENTIAL_STRESS_REPORT.md`
- Full llm test suite: 1491/1491
- See `LATENCY_DEGRADATION_REPORT.md`, `ANSWER_DIVERSITY_REPORT.md`,
  `BACKGROUND_JOB_ISOLATION_REPORT.md`,
  `FINAL_PROFILE_INTELLIGENCE_PRODUCT_QUALITY_REPORT.md` (results summary).
