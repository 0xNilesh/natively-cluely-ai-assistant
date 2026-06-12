# Final Profile Intelligence Product Quality Report (2026-06-12)

> Status snapshot for the manual-regression fix round. Benchmarks below are
> re-run after every fix; this file records the FINAL numbers.

## 1. Identity leaks — FIXED at the routing layer
- Root cause: the manual IPC identity-probe short-circuit answered
  "who are you?" / "what is your name?" / "introduce yourself" with
  "I'm Natively, an AI assistant" BEFORE the profile fast path ran. Benchmarks
  bypassed this gate (they called the fast path directly), which is why they
  passed while the real app leaked.
- Fix: `electron/llm/manualIdentityRouting.ts` (`resolveIdentityProbe`) —
  candidate-ambiguous probes route to the deterministic profile fast path when
  a profile is loaded; assistant-meta probes (Are you an AI? What is Natively?
  Who built Natively? Are you ChatGPT? what model?) keep the canned reply.
- Secondary leak (stress seq_056): behavioral asks whose LLM answer was ALL
  assistant-meta shipped unrepaired (sanitizer flagged needsFallback but the
  backend has no behavioral fast-path) → now falls back to the grounded
  `buildLiveFallbackAnswer` line.
- Verified: 36-test suite + sequential stress gate "no assistant identity
  leak" + "no sales identity leak".

## 2. Generic answer reuse — FIXED
- `AnswerDiversityGuard` (last-20 per-session fingerprints; first-sentence /
  scaffold-signature / near-dup detection; same-ask exemption) at the manual
  render boundary; variant-aware deterministic intro (background-arc /
  working-style / quick / hash-varied default).
- Verified: stress gates "no exact answer reuse" + "no generic intro collapse".

## 3. Visible scaffold — HIDDEN by default
- `isSpeakableOnlyPlan` renders gap/jd-fit/behavioral/project/negotiation
  templates as internal structure → speakable prose; explicit
  detailed/bullets/exam/notes/"use STAR" keep structure; WTA always speakable;
  `compressToSpeakable` final net.
- Verified: stress gate "no visible scaffold (default style)".

## 4. Sales mode — FIXED
- NEW `SALES_TEMPLATE` (seller/product-rep voice, forbids "I'm Natively" /
  "I don't have a product"); sales/lecture contract-injected on manual; the
  active sales-mode suffix is no longer skipped under CHAT_MODE_PROMPT.
- Verified: stress set 17 (12 sales prompts incl. pricing/objections/Cluely
  comparison) gate "no sales identity leak".

## 5. Project tech-stack / source routing — FIXED
- "What is Natively built with?" / "is Natively open source?" →
  `project_about_answer` (regression-pinned); exact-source asks stay
  `source_code_evidence_answer`; GitHub-link asks stay `project_link_answer`.
- The security prompt's refusal scope now explicitly carves out the user's own
  loaded projects sharing the product's name (the "I can't share that" cause).
- Grammar: "is A privacy-first…" → "is a privacy-first…".

## 6. Latency
- See `LATENCY_DEGRADATION_REPORT.md`. Headline fixes: live company research
  bounded to 2s (was the 6.9s processQuestion → 7s provider_timeout), gap
  pivots gated to fit/gap/behavioral types, background drains yield to
  foreground answers (`ForegroundGate`).
- User-log baseline: avg 1755ms / p50 1499ms / p95 3316ms / max 4781ms,
  1 provider_timeout.
- Sequential stress (216 prompts, one session, gemini-3.1-flash-lite):
  **see MANUAL_SEQUENTIAL_STRESS_REPORT.md** — gates: p95 < 2500ms,
  p99 < 3500ms, provider_timeout = 0, heap growth < 20%, event-loop p95 < 250ms.

## 7. Bullets — FIXED
- Marker-only lines removed in `postProcessor.stripMarkdown` + final-boundary
  `cleanAnswerArtifacts` (code blocks preserved). Bullet-style answers keep
  their content bullets.

## 8. Verification matrix (FINAL)
| check | result |
|---|---|
| typecheck (electron + premium + renderer) | clean |
| llm unit suite | **1493/1493** |
| services suite | failures == pre-existing baseline only (better-sqlite3 ABI / audio pins) |
| ManualRealSessionFixes2026_06_12 | **38/38** |
| **sequential stress (216 prompts, ONE session, 18 sets incl. lecture/sales/looking-for-work)** | **216/216, ALL 12 GATES PASS** |
| stress latency | first-useful p50 **747ms** / p90 ~920ms / p95 **1002ms** / p99 **1070ms** (gates: p95<2500, p99<3500) |
| stress runtime health | provider_timeouts **0** · heap growth **-10.3%** (gate <20%) · event-loop p95 **22ms** (gate <250ms) |
| stress quality gates | 0 assistant-identity leaks · 0 sales leaks · 0 visible scaffolds · 0 empty bullets · 0 exact reuse · no intro collapse · 0 stealth advice |
| manual-ui-truth (80-case, exact IPC path) | **100.0%** — 0 leaks, 0 intro-collapse, 0 stalls |
| WTA benchmark (100-case) | **100/100** — 0 leaks/refusals/wrong-voice/empties; first-useful p50 1499ms / p95 1862ms |

### Latency before → after (user log baseline vs sequential stress)
| metric | before (user log) | after (216-prompt stress) |
|---|---|---|
| first-useful p50 | ~1499ms | **747ms** |
| first-useful avg | ~1755ms | ~600ms (47/216 deterministic <1ms) |
| first-useful p95 | ~3316ms | **1002ms** |
| max | ~4781ms | ~1250ms |
| provider_timeout | 1 (7003ms, after 6906ms processQuestion) | **0** (live research now 2s-bounded) |
| long-session feel | lags after ~50 questions | heap stable (-10%), event-loop p95 22ms, background drains pause during answers |

## Remaining / known limitations
- The diversity guard repairs deterministically (compress-to-speakable); it
  does not re-prompt the LLM for a fresh phrasing (kept zero-extra-latency).
- ForegroundGate is advisory — it pauses queue drains between items; a single
  long synchronous DB statement still cannot be interrupted mid-flight.
- Per-mode reference files / sales product facts must be loaded for grounded
  sales pricing specifics; without them the seller voice reframes around value
  (by design — never invents pricing).
