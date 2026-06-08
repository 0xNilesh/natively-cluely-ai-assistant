# Best-in-Class Profile Intelligence Plan — 2026-06-08

The product bar Natively's Profile Intelligence + What-to-answer must clear to be the
best real-time AI copilot in its category. Each item has a concrete, measurable target
and a current status (✅ met / ◐ partial / ○ not yet / ⧖ provider-bound).

## 1. Latency

| target | status |
|---|---|
| first UI acknowledgement < 100ms | ✅ (thinking-dots / scaffold painted client-side immediately) |
| first useful scaffold < 500ms (coding) | ✅ (deterministic six-section scaffold before any token) |
| first useful answer < 1500ms (common Qs) | ✅ (deterministic fast-path: identity/skills/JD-fit/intro, no LLM) |
| p95 first-useful < 2500ms (all modes) | ✅ measured 2454ms (live multimode, healthy window) |
| p99 first-useful < 3500ms | ✅ measured 3313ms |
| WTA p95 first-useful < 2000ms | ◐ ~2.2–2.7s by provider window; fast-path + clarification are instant |
| no 10s+ waits except provider outage | ✅ 0 in the last run (deadline + live-fallback guards) |

## 2. Answer quality

Measured by the new deterministic `answer_quality_judge` (usefulness / speakability /
grounding / brevity / confidence / overall, 1-5), plus an optional LLM judge.

| target | status |
|---|---|
| speakable, natural, not robotic | ✅ candidate sanitizer + style engine; judged |
| candidate-voice correct | ✅ delivered-voice validation; 0 wrong-voice in multimode |
| right level of detail (adaptive) | ✅ **NEW adaptive style engine** (short/detailed/one-line/STAR/code-only/bullets/beginner/exam/notes) |
| not too generic / overconfident | ✅ judge flags filler/overclaiming/underclaiming |
| no hallucinated metrics / fake facts | ✅ grounding policy + evidence validator + judge flag |
| no repetitive templates | ✅ style engine varies form per request |
| overall human quality ≥ 4.5/5, WTA ≥ 4.6, every mode ≥ 4.2 | ⧖ judge live (4.8–5.0 pillars on scored rows; provider-limited denominator) |

## 3. Context intelligence

| target | status |
|---|---|
| uses the right context, excludes wrong | ✅ answer-type-gated layers; 0 context leaks |
| long-session memory (1h recall) | ✅ SessionMemory (ms→s, 7200s window); replay 100% |
| corrections override | ✅ latest-correction-wins; single/double tested |
| mode switches | ✅ effectiveMemoryMode (coding/comp from intent) |
| old topics revived later | ✅ recency-salience + pinned; competing-entity tested |
| ambiguous follow-ups | ✅ context-free clarification (never self-identify) |

## 4. Multi-mode superiority

| mode | status |
|---|---|
| technical interview | ✅ replay 100% |
| coding interview | ✅ six-section scaffold + verified execution; replay 100% |
| HR / recruiter | ✅ replay 100% |
| sales call | ✅ objection + customer recall; replay 100% |
| lecture | ✅ notes/exam styles; replay 100% |
| team meeting | ✅ action-item recall; replay 100% |
| general assistant | ✅ |
| custom mode | ✅ (ModesManager custom context, sensitivity-gated) |
| what-to-answer / what-to-say | ✅ transcript extract → resolve → plan → speakable |

## 5. Reliability

| target | status |
|---|---|
| provider fallback | ✅ retry-circuit + deterministic profile fallback on stream error |
| deterministic fallback | ✅ no empty answer when route/context can answer |
| graceful provider outage | ✅ classified + quarantined; no blank when avoidable |
| crash-free Electron runtime | ✅ smoke 6/6; CI hang fixed |

## 6. UI experience

| target | status |
|---|---|
| answer appears instantly | ✅ scaffold/thinking painted before tokens |
| scaffold-first, then stream | ✅ coding contract |
| no layout jump / stale answer | ✅ idempotent commit-by-id; superseded-discard |
| right transcript question picked | ✅ deterministic latest-question extractor |
| clear mode behavior | ✅ mode-gated context + voice |

> UI items are verified by the streaming-overlay invariants + the existing
> Playwright/Electron real-UI suite. Full GUI E2E needs a display environment (see
> `REAL_WORLD_E2E_TEST_REPORT.md`).

## 7. Safety / trust

| target | status |
|---|---|
| no stealth/evasion guidance | ✅ ethical_usage safety route; 0 stealth leaks |
| no privacy leaks | ✅ 0 identity/context/salary leaks |
| no raw sensitive logs | ✅ allowlist telemetry; marker-only |
| no fake exact source code | ✅ source-evidence answer (quote-or-decline) |
| no invented links | ✅ project_link answer (loaded-or-"not loaded") |

## Where Natively can WIN (vs the category)

1. **Deterministic answer-type routing + leak prevention** — most copilots send the
   raw transcript to one prompt; Natively routes deterministically and gates context
   by answer type, so coding answers never leak the résumé and salary never crosses
   modes. This is a structural correctness advantage.
2. **Adaptive answer style** — same question, different form on request ("in one line"
   vs "in detail" vs "code only"). Few copilots adapt length/format to the ask.
3. **Long-range session memory with mode boundaries** — 1-hour recall that still can't
   leak the project into a coding answer or salary into a non-comp answer.
4. **Privacy posture** — BYO-key, local profile DB, marker-only telemetry, kill-switch
   rollout. A genuine differentiator vs cloud-only copilots.
5. **Verified code execution** — coding answers are executed against tests and
   corrected; a category-rare reliability feature.

The detailed competitor comparison is in `COMPETITOR_PARITY_AND_SUPERIORITY_REPORT.md`.
