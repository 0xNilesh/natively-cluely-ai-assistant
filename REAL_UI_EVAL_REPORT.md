# REAL_UI_EVAL_REPORT

> Status of the real-UI Playwright/Electron release gate. Branch `fix/overlay-startup-slide`.

## Gate status: FAIL (actual app run with provided key)

I attempted the targeted Playwright spec first, then used the repo's real UI runner after the spec path failed before app launch.

## Attempt 1: targeted Playwright spec — blocked before app launch

Command:

```bash
NATIVELY_TEST_API_KEY=<redacted> npx playwright test \
  intelligence-eval-real-ui/tests/real-ui-manual-input.spec.ts \
  --config intelligence-eval-real-ui/playwright.config.ts \
  -g "MANUAL-PI real UI regression"
```

It failed loading the TS Playwright config before reaching the app:

```txt
ReferenceError: exports is not defined in ES module scope
at intelligence-eval-real-ui/playwright.config.ts:3:23
```

Evidence path:

```txt
/private/tmp/claude-501/-Users-evin-natively-cluely-ai-assistant/646ad8e7-dc81-4b5a-8c5e-bd6b1df70e88/tasks/bld0j04fo.output
```

Because this did not launch the app, it is a harness/config issue, not a runtime product verdict.

## Attempt 2: real UI runner — FAIL at runtime

Command:

```bash
NATIVELY_TEST_API_KEY=<redacted> npm run eval:intelligence:ui -- --profiles=data-analyst --max=10
```

This launched the real Electron app and drove profile loading through the UI. Runtime observations:

```txt
=== Profile data-analyst: fresh app launch + load through UI ===
[profile-loader] resume upload fired for .../fixtures/data-analyst/resume.txt
[profile-loader] waiting for hasProfile status
[waitForStatus] t=0s hasProfile=false
...
[waitForStatus] t=169s hasProfile=false
[profile-loader] resumeLoaded=false
[profile-loader] JD upload fired for .../fixtures/data-analyst/jd.txt
[profile-loader] jdLoaded=false
[profile-loader] profileSetMode(true): {"success":true}
[real-ui-eval] loadProfileThroughUI completed for data-analyst
  resumeLoaded=false jdLoaded=false custom=true persona=true
```

The app then asked the real UI/manual cases. Result:

```txt
DA-001 [identity_manual] FAIL — missing_required_fact:Chen Wei,forbidden_fact_in_answer:Natively
DA-002 [interviewer_intro] FAIL — missing_required_fact:Chen Wei
DA-003 [projects_manual] FAIL — missing_required_fact:ABTest-Framework,missing_any_of_facts:ABTest-Framework|SQL-Copilot
DA-004 [skill] PASS
DA-005 [jd_alignment] PASS
DA-006 [followup] PASS
DA-007 [metrics_manual] PASS
DA-008 [negotiation] PASS
DA-009 [unknown] FAIL — missing_not_admitted:exact revenue increase
DA-010 [regression_projects] FAIL — missing_required_fact:ABTest-Framework,missing_required_fact:SQL-Copilot

=== REAL UI E2E: 5/10 passed (executed) | 0 infra-skipped | critical 0/2 | gate FAIL ===
```

Evidence path:

```txt
/private/tmp/claude-501/-Users-evin-natively-cluely-ai-assistant/646ad8e7-dc81-4b5a-8c5e-bd6b1df70e88/tasks/bkno58s40.output
```

## Interpretation

The real UI path still fails the user-facing acceptance criteria because profile ingestion never becomes ready through the UI (`resumeLoaded=false`, `jdLoaded=false`). As a result, the manual identity/project questions still answer without the loaded resume/JD facts and can fall back to assistant identity.

This is distinct from the backend deterministic helper passing: the UI run proves the end-to-end seam from UI upload → profile status/readiness → manual input is still broken.

## Verdict

Real UI: **FAIL**.

The manual Profile Intelligence backend route is improved, but the full user flow is not fixed until the real UI can successfully ingest/load the resume/JD and manual questions answer from those newly uploaded facts.
