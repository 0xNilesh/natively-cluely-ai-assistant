> **STATUS (2026-06-01): harness built + EVERY real-UI selector verified working; full 100-case keyed run NOT executed here (no Pro key).**
> Vertical-slice probes against the live app confirm the complete UI-driving chain:
> launch → all 5 windows render → seed clean state (dismiss startup) → click the
> real "Profile Intelligence" button (found:1) → resume upload btn (1), JD upload
> btn (1), custom-context textarea (1), persona textarea (1) all present → overlay
> chat input (1) + real "What to answer?" button (1) found → real transcript
> injection returns {success:true} via the shipped test IPC → all preload bridges
> functional → grader passes good answers / hard-fails "I'm Natively". The full
> run needs (a) NATIVELY_TEST_API_KEY (Pro-entitled — Profile Intelligence is
> genuinely Pro-gated, no bypass) + (b) a GUI session. iteration-001 = 0 executed
> cases (no key); NOT a real 0/0 pass. Run with the key to populate.
> A test-engineer review found + drove fixes to 4 selector/navigation defects
> (profile-open mechanism, license bridge, chat-input selector, WTA button
> disambiguation) + observer false-pass gating + grader follow-up strictness.

# Natively Real UI Intelligence E2E Report

Run metadata:
- Date: 2026-05-31
- App version: 2.7.0
- Platform: darwin-arm64
- Provider/model: natively /v1/chat (gemini-3.5-flash)
- Real UI used: yes
- Real API used: NO (precondition failed)
- Mock responses detected: 0

Accuracy:
- Total tests: 0
- Passed: 0
- Failed: 0
- Overall accuracy: 0.0%
- Critical tests: 0/0

Latency (real UI-observed, ms):
- Avg first useful token: 0
- p50 / p95 / p99 / max first useful token: 0 / 0 / 0 / 0
- Manual p50/p95 first useful token: 0 / 0
- What-to-answer p50/p95 first useful token: 0 / 0
- p50 / p95 / max total response: 0 / 0 / 0

Cost:
- Total eval cost: $0
- Average cost/test: $0
- Cost wasted on failed tests: $0

Slowest tests:


Most expensive tests:


Failed tests:
none

Release gate: FAIL
