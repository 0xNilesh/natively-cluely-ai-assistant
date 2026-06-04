# Natively Real UI Intelligence E2E Report

Run metadata:
- Date: 2026-06-03
- App version: 2.7.0
- Platform: darwin-arm64
- Provider/model: natively /v1/chat
- Real UI used: yes
- Real API used: yes
- Mock responses detected: 0

Accuracy:
- Total cases: 10
- Executed (ran against a live app): 10
- Infra-skipped (backend flap / app crash — NOT logic failures): 0
- Passed: 5
- Failed: 5
- Accuracy over executed: 50.0%
- Critical tests: 0/2 (failed: DA-001, DA-010)

Latency (real UI-observed, ms):
- Avg first useful token: 0
- p50 / p95 / p99 / max first useful token: 0 / 0 / 0 / 0
- Manual p50/p95 first useful token: 0 / 0
- What-to-answer p50/p95 first useful token: 0 / 0
- p50 / p95 / max total response: 5802.668 / 6297.34 / 6297.34

Cost:
- Total eval cost: $0.002
- Average cost/test: $0
- Cost wasted on failed tests: $0.001

Slowest tests:
1. DA-001 — 0ms
2. DA-002 — 0ms
3. DA-003 — 0ms
4. DA-004 — 0ms
5. DA-005 — 0ms

Most expensive tests:
1. DA-010 — $0
2. DA-009 — $0
3. DA-007 — $0
4. DA-005 — $0
5. DA-003 — $0

Failed tests:
1. DA-001 [identity_manual] — missing_required_fact:Chen Wei, forbidden_fact_in_answer:Natively
2. DA-002 [interviewer_intro] — missing_required_fact:Chen Wei
3. DA-003 [projects_manual] — missing_required_fact:ABTest-Framework, missing_any_of_facts:ABTest-Framework|SQL-Copilot
4. DA-009 [unknown] — missing_not_admitted:exact revenue increase
5. DA-010 [regression_projects] — missing_required_fact:ABTest-Framework, missing_required_fact:SQL-Copilot

Release gate: FAIL
