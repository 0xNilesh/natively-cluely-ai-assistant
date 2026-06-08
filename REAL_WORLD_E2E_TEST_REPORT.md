# Real-World E2E Test Report — 2026-06-08

## What exists

Natively already has a real-UI E2E harness (it predates this pass):

- **`intelligence-eval-real-ui/`** — Playwright-driven Electron app E2E: drives the
  REAL app UI (startup screen, profile/JD load, Pro gating, manual chat, WTA hotkey),
  100-case dataset over 10 profiles, with a grader. Scripts:
  `test:intelligence:ui`, `eval:intelligence:ui`, `test:intelligence:ui:grader`.
- **`tests/e2e/`** — Playwright specs (`basic-smoke.spec.ts`,
  `parity-gaps-evidence.spec.ts`). Scripts: `test:e2e`, `test:e2e:parity`.
- **Electron-runtime module smoke** (this pass) — loads the compiled engine + runs
  resolution under the actual Electron binary.

## What was verified in THIS environment (headless)

Full GUI E2E (window, audio capture, IPC, renderer) requires a **display + GUI
environment** not available in this headless session. What WAS verifiable here:

| surface | check | result |
|---|---|---|
| Electron binary loads the engine modules | `ELECTRON_RUN_AS_NODE` smoke | ✅ 6/6 |
| live SessionMemory resolves under Electron | 62-min recall, coding boundary, clarification | ✅ |
| `better-sqlite3` native DB opens | require under Electron | ✅ |
| manual path logic (plan → fast-path → sanitizer → clarification) | unit + multimode runner mirroring `ipcHandlers` | ✅ |
| WTA path logic (extract → resolve → plan → stream) | livememory + replay benchmarks driving the real orchestrator | ✅ 100% |
| no sensitive content logged | allowlist telemetry adversarial tests | ✅ |
| feature flag + kill switch | rollout unit tests | ✅ 21/21 |

## Test matrix (covered by the existing harness + new benchmarks)

### Manual send
- "introduce yourself" → deterministic first-person intro (no LLM) ✅ fast-path
- "why should we hire you" → jd_fit, speakable ✅ (quality judge)
- "solve two sum" → six-section coding scaffold, profile-forbidden ✅
- "what about SQL?" after Python → SQL skill (follow-up) ✅ (replay/followup)
- "how did you build that?" after project → project_followup ✅

### What-to-answer
- transcript with filler after a question → latest-question extractor picks the question ✅
- multiple questions → most-recent meaningful interviewer question ✅
- interviewer follow-up after 30 min → SessionMemory recall ✅ (replay 100%)
- candidate identity ask → first-person, never "I'm Natively" ✅
- salary ask → negotiation only, gated ✅
- coding ask → profile-forbidden ✅
- meeting action item → general_meeting, recall ✅ (replay)

### UI (streaming invariants — covered by `intelligence-eval-real-ui` + overlay invariants)
- button click acknowledged immediately (thinking-dots) — UI harness
- scaffold appears quickly (coding contract) — `shouldShowImmediateScaffold`
- stream starts, final replaces/continues scaffold by id — idempotent commit-by-id
- no empty final answer — deterministic fallback
- no stale previous answer — superseded-discard
- no crash — Electron smoke 6/6
- telemetry emitted — marker-only (verified)
- sensitive content not logged — allowlist (verified)

## How to run the full GUI E2E (requires display)

```bash
npm run test:intelligence:ui      # Playwright-Electron real-UI, needs a Pro key + GUI
npm run eval:intelligence:ui      # 100-case real-UI eval
npm run test:e2e:parity           # parity evidence specs
```

## Honest status

- **Backend + logic surfaces of the manual and WTA paths are verified** end-to-end via
  the real-orchestrator benchmarks (no mocks) and the Electron-runtime smoke.
- **Full GUI E2E (rendered window, live audio/STT, IPC streaming to the renderer) was
  NOT run in this headless environment** — it requires the existing
  `intelligence-eval-real-ui` harness on a machine with a display + a Pro key. The
  harness exists and is documented; running it is a release-machine step.
- No UI regressions are introduced by this pass: the changes are in the answer-planning
  / memory / telemetry layers, behind a default-OFF flag for the new live memory path;
  the streaming-overlay invariants (sync ref, idempotent commit-by-id, idempotent
  mount) are unchanged.

## Verdict

The product-logic E2E (manual + WTA, real orchestrator) is verified and green. The
rendered-GUI E2E is covered by an existing harness that must run on a display machine —
documented here as the release-machine gate, not claimed as run headless.
