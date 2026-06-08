# Live Session Replay Report — 2026-06-08

## What this is

50 full live sessions (20–90 turns each) replayed through the **REAL**
`resolveLiveFollowup` orchestrator — the exact code the live IntelligenceEngine calls
when `NATIVELY_ENABLE_LIVE_SESSION_MEMORY` is on. The runner mirrors the engine's
**ms→seconds timestamp adapter** (epoch-based, so the seconds magnitude matches
production) and the **effectiveMemoryMode** intent derivation, so a unit/window/boundary
regression is caught here, not in the field.

`npm run benchmark:live-replay:50` · dataset
`live_session_replay_dataset.json` · runner `run_live_session_replay_eval.ts`.

## Coverage (50 sessions, 132 checks)

| type | sessions | what it tests |
|---|---|---|
| tech_interview | 10 | 1h project revisit + skill recall; coding stays profile-forbidden |
| hr_interview | 10 | salary on its own channel; weakness follow-up doesn't leak comp |
| coding_interview | 8 | coding follow-ups never pull the profile |
| sales_call | 8 | objection + customer recall; no résumé/comp leak |
| lecture | 6 | concept recall 45 min later; notes/exam styles |
| team_meeting | 6 | action-item owner recall 40 min later |
| mixed_chaos | 2 | corrections + mode switches + coding/salary boundaries + ambiguous follow-up |

Includes the directive's scenario phrasings: "Coming back to that project…", "What
about the second one?", "Actually, use this project instead", "Who owns the migration?",
"What were they worried about again?", "And SQL?", "why?", "how strong are you in that?".

## Results

| metric | result | gate |
|---|---|---|
| session pass rate | **100.0%** (50/50) | ≥ 98% ✅ |
| check pass rate | **100.0%** (132/132) | — ✅ |
| context-leak checks | **0** | 0 ✅ |
| long-range recall (1h project / 40-45min meeting & lecture) | **100%** | ≥ 95% ✅ |
| correction handling (single + double + mid-session switch) | **100%** | ≥ 98% ✅ |
| cross-mode leaks (coding/salary boundaries) | **0** | 0 ✅ |
| context-free clarification ("why?") | **100%** | 100% ✅ |

By type: tech_interview 100% · hr_interview 100% · coding_interview 100% · sales_call
100% · lecture 100% · team_meeting 100% · mixed_chaos 100%.

## A real bug this eval caught

The first replay run scored tech_interview 0/10: "And how strong are you in that?"
asked right after a 1-hour project revisit recalled the **project** (Natively) instead
of the **skill** (Python/SQL) — the most-recent salient entity won over the question's
intent. Fixed by adding a skill-proficiency probe rule to `inferKind` ("how strong/good/
proficient are you in/at that") that wins over the project rules. tech_interview →
100%. No regression in followup-500 / long-session-100 / livememory (all stayed 100%).

## Verdict

The live session replay proves the wired long-session memory path end-to-end on
realistic multi-turn sessions: **100% pass, 0 leaks, 1h recall, corrections, and mode
boundaries all hold** — with the engine's real ms→seconds adapter and intent-derived
mode boundary exercised (not bypassed). This is the strongest reproducible evidence
that the long-session memory works as a product, not just in a unit test.
