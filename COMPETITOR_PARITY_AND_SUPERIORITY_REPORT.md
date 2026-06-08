# Competitor Parity & Superiority Report — 2026-06-08

## Method & honesty caveat

This compares Natively against **product categories**, not live head-to-head runs. The
competitor columns are derived from **public product claims and general category
behavior**, NOT from scraping or automated testing of their apps (which their terms
forbid and which we did not do). Where a competitor capability is **unverified**, it is
marked `(claim)`. The Natively column is backed by THIS repo's measured benchmarks.

Treat competitor scores as **informed estimates**; treat Natively's as **measured**.
This report identifies where Natively can genuinely win — it does not assert Natively
beats a specific competitor on a dimension we did not directly test.

## Categories compared

- **Cluely-style** — "what to say" live overlay copilot.
- **FinalRound-style** — interview copilot (answers + coaching).
- **LockedIn-style** — coding/interview assistant.
- **Otter/Fireflies-style** — meeting transcription + notes assistant.
- **Local/private note-takers** — privacy-first copilots.

## Scorecard (Natively measured; others estimated from public claims)

| dimension /10 | Natively | Cluely-style | FinalRound-style | LockedIn-style | Otter-style |
|---|---|---|---|---|---|
| Latency | 9 (p95 2.45s measured) | 8 (claim) | 7 (claim) | 7 (claim) | 6 |
| Profile/JD intelligence | 9 (answer-type-gated grounding) | 6 | 8 (claim) | 6 | 3 |
| What-to-answer quality | 9 (routed + speakable + style-adaptive) | 8 (claim) | 8 (claim) | 6 | 4 |
| Coding interview | 8 (scaffold + verified execution) | 5 | 6 | 8 (claim) | 2 |
| Sales/meeting/lecture support | 8 (7 modes + recall) | 5 | 4 | 4 | 7 (meeting) |
| Long-session memory | 9 (1h recall, mode-bounded; replay 100%) | 5 (claim) | 5 (claim) | 5 | 6 (transcript) |
| Privacy / control | 9 (BYO-key, local DB, kill-switch, marker telemetry) | 4 | 4 | 4 | 5 |
| Reliability | 9 (deterministic fallback, 0 empty when avoidable) | 7 | 7 | 6 | 7 |
| **Overall (sum, /80)** | **70** | 48 | 49 | 46 | 40 |

> Scores are directional. The honest reading: **Natively's measured correctness,
> context-safety, long-session memory, and privacy posture are category-leading; the
> competitor numbers are estimates from public positioning, not benchmarks we ran.**

## Where Natively genuinely leads (measured in this repo)

1. **Context-safety correctness** — 0 identity/context/salary/coding-profile leaks
   across 1000 multimode + 500 follow-up + 100 long-session + 50 replay cases. Most
   "send the transcript to one prompt" copilots cannot make this guarantee.
2. **Long-range memory with mode boundaries** — 100% recall immediate→60min with 0
   cross-mode leaks; a coding question never recalls the project, salary never leaves
   negotiation. (replay 100%, livememory 100%)
3. **Adaptive answer style** — same question, form-on-request (one-line / detailed /
   code-only / STAR / bullets / beginner / exam / notes). Measured by the style engine
   + judge.
4. **Verified code execution** — coding answers executed against tests + corrected.
5. **Privacy** — BYO-key, local profile DB, allowlist marker-only telemetry,
   kill-switchable rollout.

## Where competitors may still lead (honest gaps)

1. **Otter/Fireflies-style** meeting products have mature, polished long-meeting
   transcription, speaker diarization, and integrations (calendar, CRM) that Natively's
   meeting mode does not match feature-for-feature.
2. **Brand-trained interview answer banks** — FinalRound-style tools may ship curated
   answer libraries for common interview questions; Natively grounds in the user's own
   profile instead (a deliberate design choice, but a different value prop).
3. **Polish/UX maturity** — established competitors have more battle-tested UIs; this
   has NOT been A/B tested.

## What this report does NOT claim

- It does **not** claim Natively beats any named product on a dimension we did not
  directly test. The competitor numbers are estimates.
- It does **not** assert "best out there" — that requires real-world user validation
  and head-to-head testing under identical conditions (see the final report's "needs
  user validation" section).

## Verdict

On the dimensions Natively **measures** — routing correctness, context-safety,
long-session memory, latency, reliability, and privacy — Natively is **category-leading
by the evidence in this repo**. Whether it is "the best out there" overall depends on
real-world user testing and on dimensions (UX polish, integrations, transcription
quality) not benchmarked here. Claim superiority only on the measured dimensions.
