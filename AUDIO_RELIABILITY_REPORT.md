# Audio Reliability Report — macOS

**Status:** Work in progress (this document is updated as fixes land)
**Started:** 2026-05-28
**Goal:** Bring Natively's macOS audio capture and transcription reliability to competitor (Cluely, Final Round AI, Granola) parity.
**User symptom this report addresses:** "I granted Microphone and Screen Recording permissions but my voice / system audio is not being transcribed."

---

## 1. Executive summary

The reported symptom — "permissions granted but no transcription" — has **three distinct root-cause classes stacked**. No single fix covers all reports.

| Cause class | Severity | Fixable in code alone? |
|---|---|---|
| **A. Signing chain (structural)** — Every rebuild invalidates TCC. | CRITICAL | NO — requires Apple Developer Program + Developer ID certificate + hardened runtime + notarization. |
| **B. Code-level surface gaps** — UI lies about ready state; failures silently discarded by renderer; capture init swallows errors; mic recovery never emits terminal IPC. | CRITICAL→HIGH | YES — 11 specific bugs across `electron/main.ts` + renderer. |
| **C. Product UX gaps** — No way to diagnose, validate, or self-repair. No pre-meeting startup validation; no in-app TCC repair button; no audio level meter; no deep-link to System Settings. | HIGH | YES — new components. |

This report documents root causes, exact files changed, manual QA checklist, and competitor-gap analysis.

---

## 2. Why users were still facing issues despite granting permissions

The dominant root cause is structural: **macOS TCC binds Screen Recording / Microphone grants to a binary's "designated requirement" (DR)**. For ad-hoc-signed apps (this codebase's current state: `identity: null`, `--sign -`), the DR resolves to the binary's **cdhash**, which **changes on every rebuild**. After a release or auto-update:

1. System Settings → Privacy & Security → Screen Recording / Microphone shows Natively as ALLOWED (good).
2. `systemPreferences.getMediaAccessStatus('screen')` returns `'granted'` (good).
3. CoreAudio Process Tap allocates, IO proc fires at the correct cadence (looks healthy in logs).
4. **Every sample is zero.** TCC silently zero-fills — Apple does NOT surface this as an OSStatus error.
5. `tccd` Console logs (if checked) show `Failed to copy signing info -67062` and `InvalidCode`.

In parallel, secondary code-level bugs amplify the symptom:
- The renderer **discarded** the mic zero-fill banner under an incorrect assumption (B1, now fixed).
- The UI initialized STT status to `'connected'` (green-ready) before any audio was verified (B2, now fixed).
- Capture construction throws were swallowed by an outer try/catch, leaving null wrappers with no watchdog armed and no UI signal (B3, now fixed).
- Mic recovery exhausted attempts silently with no terminal IPC (B4, now fixed).
- `audio-capture-failed` was sent only to the overlay window; an overlay-destroy race silently dropped the banner (B8, now fixed).

Together, these produced the exact symptom: "permission granted, app shows green ready, no transcript, no banner."

---

## 3. Root causes (full list, from senior-level audit)

### A. Signing chain (structural — requires Apple Developer Program)

| # | Severity | Issue | Evidence |
|---|---|---|---|
| A1 | CRITICAL | No designated requirement stabilization. `identity: null` + `--sign -` = cdhash-based DR that changes on every rebuild. | `package.json:92-93`; `scripts/ad-hoc-sign.js:88` (no `--identifier`, no `-r` requirement) |
| A2 | CRITICAL | `hardenedRuntime: false` makes most entitlements no-ops. `com.apple.security.screen-capture`, `cs.allow-jit`, `cs.disable-library-validation` all require HR. | `package.json:93`; `assets/entitlements.mac.plist:6-13,27` |
| A3 | HIGH | Helper bundles (GPU/Renderer/Plugin) signed by `codesign --deep` WITHOUT entitlements. If SCK runs through a Helper, it has no screen-capture entitlement. | `scripts/ad-hoc-sign.js:88` |
| A4 | HIGH | Generic `appId: "com.electron.meeting-notes"` — electron-builder default placeholder. Collides with other unbranded apps; no migration story for any prior bundle ID. | `package.json:38` |
| A5 | HIGH | `extendInfo` injects NS* keys into packaged Info.plist (works), but `patch-electron-plist.js` patches only the **dev** Electron under `com.github.Electron` — dev users' TCC grants are bound to the wrong bundle ID. | `scripts/patch-electron-plist.js:20-30` |
| A6 | HIGH | Entitlements signed onto `.node` are cosmetic for TCC — `tccd` inspects the **calling process** (Helper or main app), not dlopen'd libraries. | `scripts/ad-hoc-sign.js:100-114` |
| A7 | MEDIUM | No notarization. `@electron/notarize` is installed but not wired. Unnotarized + ad-hoc combo on Sequoia (15.x) requires Gatekeeper override and may attribute capture to the wrong responsible process. | `package.json` devDependencies; no `afterSign` hook anywhere |

### B. Code-level surface gaps (fixable in JS/TSX)

| # | Severity | Issue | File:line | Status |
|---|---|---|---|---|
| B1 | CRITICAL | Renderer dropped mic zero-fill banner under incorrect "STT status surfaces this" assumption. | `src/components/NativelyInterface.tsx:929-948` | ✅ Fixed |
| B2 | CRITICAL | UI initialized STT status to `'connected'` (green) before any audio verified. | `src/components/NativelyInterface.tsx:391-398` + 5 other files | ✅ Fixed |
| B3 | CRITICAL | `setupSystemAudioPipeline` outer try/catch swallowed capture-construction throws → null wrapper, no watchdog armed, STT WS connected, silent forever. | `electron/main.ts:1804-1944` | ✅ Fixed |
| B4 | HIGH | Mic recovery exhausted 3 attempts with only `console.error` — no terminal IPC. Subsequent errors silently dropped by early-return guard. | `electron/main.ts:2858-2880` | ✅ Fixed |
| B5 | HIGH | Dev-mode `getMacScreenCaptureStatus` early-returns `'granted'` unconditionally, masking real TCC denial during testing. | `electron/main.ts:162-165` | Pending |
| B6 | HIGH | `setupSystemAudioPipeline` skips permission re-check when wrapper already exists. 2nd meeting after TCC revoke = silent zero-fill. | `electron/main.ts:1794` | Pending |
| B7 | HIGH | `restartCapturesAfterResume` doesn't reset `_micRecoveryAttempts` / `_systemAudioRecoveryAttempts`. Post-sleep recovery is a no-op if counter was saturated pre-sleep. | `electron/main.ts:1947-2018` | Pending |
| B8 | HIGH | `sendAudioCaptureFailed` routed only to overlay window. Race destroying overlay → banner invisible. | `electron/main.ts:826-836` | ✅ Fixed |
| B8b | HIGH | Same overlay-only race affects `sendSttStatus` and `sendSystemAudioPermissionDenied`. | `electron/main.ts:822, 830` | Pending |
| B9 | MEDIUM | `_audioInitPromise` never cleared on terminal failure — next meeting inherits failed null capture without re-running setup. | `electron/main.ts:3203-3206` | Pending |
| B10 | MEDIUM | Zero-fill detector's stride-sampled `peak > 8` threshold false-latches on DC bias from muted-but-biased mics → detector permanently off. | `electron/main.ts:1636-1660` | Pending |
| B11 | MEDIUM | 8s stuck-watchdog races SCK's 5–7s cold start on slower systems → false stuck banner. | `electron/main.ts:1530` | Pending |

### C. Product UX gaps (competitor parity)

| # | Component | Status |
|---|---|---|
| UX1 | Pre-meeting audio validation (2s probe; classify TCC-blocked / hardware-mute / ready before showing Start). | Pending |
| UX2 | In-app TCC repair button — runs `tccutil reset Microphone <bundleId>` + `tccutil reset ScreenCapture <bundleId>` (capital letters required; lowercase fails with "Invalid Service Name"). | Pending |
| UX3 | Deep-link to System Settings panes (`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` / `…?Privacy_ScreenCapture`). | Pending |
| UX4 | Live audio level meter in onboarding + settings so users see real audio reaching the app. | Pending |

---

## 4. Competitor-level reliability gaps

| Capability | Cluely | Final Round AI | Granola | Natively (today) | Natively (after this work) |
|---|---|---|---|---|---|
| Developer ID signing | ✅ | ✅ | ✅ (native Swift) | ❌ ad-hoc | ⏳ planned |
| Hardened runtime + notarization | ✅ | ✅ | ✅ | ❌ | ⏳ planned |
| TCC-binding stability across updates | ✅ | ✅ | ✅ | ❌ | ⏳ planned |
| Zero-fill / silent-capture detection | unknown | unknown | unknown | ✅ (12s zero-fill detector + 8s no-chunks watchdog) | ✅ (improved DC-bias rejection + SCK race fix) |
| Pre-meeting audio validation | ❌ (public docs show troubleshooting after-the-fact) | ❌ | ✅ (native) | ❌ | ⏳ planned |
| In-app TCC repair button | ❌ (public MDM doc only) | ❌ | ✅ | ❌ | ⏳ planned |
| Deep-link to System Settings | ✅ | ✅ | ✅ | ❌ | ⏳ planned |
| Live audio level meter | ✅ (waveform in onboarding) | ✅ | ✅ | ❌ | ⏳ planned |
| Independent mic/system failure | unknown | unknown | unknown | ✅ (post-B3) | ✅ |
| Sleep/wake recovery | ✅ | ✅ | ✅ (native) | ✅ (May 7 fix) | ✅ (improved counter-reset) |

**Key insight (from research):** Cluely is also Electron and has the same TCC pain. Their public response is documentation, not a fix — see their MDM permissions troubleshooting page. The differentiator competitors fall short on is **proactive diagnostics + self-repair**. That's the wedge for Natively.

---

## 5. Manual QA checklist (run before each macOS release)

Each scenario lists: setup → action → expected behavior → observable artifact.

1. **First-launch TCC mic dialog** — `tccutil reset Microphone com.<bundleId>`; click Start Meeting; macOS prompts; Allow → capture starts within 2s. Log: `macOS microphone permission request during start meeting: granted`.
2. **First-launch TCC screen dialog** — `tccutil reset ScreenCapture com.<bundleId>`; Start meeting; TCC sheet appears (triggered by `desktopCapturer.getSources` warm-up); Allow → chunkCount climbs.
3. **TCC mic denied** — Reset + Deny; Start meeting → `mic-denied` banner, mic never starts, meeting continues system-only.
4. **TCC screen denied** — Reset + Deny screen; Start → `screen-recording-denied` banner, mic still works.
5. **Build cdhash change (rebuild invalidates grant)** — Grant on current build → rebuild → relaunch → Start meeting. Expected: `status==='granted'` BUT chunks zero-filled → after 12s `mac-screen-recording-revoked-rebuild` banner. Log: "chunks all zero-filled for 8s — TCC denial suspected."
6. **macOS sleep mid-meeting** — Active meeting → `pmset sleepnow` → wait 30s → wake. Expected: captures destroyed + recreated; transcript resumes within ~3s. Log: `System resume — restarting captures`.
7. **AirPods connect mid-meeting** — Built-in output → connect AirPods → system auto-switches. Expected: default-output watcher rebinds tap within ~1s; no zero-fill banner. Log: `Output device changed`.
8. **AirPods used for BOTH input AND output** — Set AirPods both ways → Start meeting → banner `mac-same-device-input-output` BEFORE capture starts.
9. **Bluetooth HFP zero-fill** — Pair Sony XM5 or similar BT mic in HFP mode → Start meeting → zero-fill detector trips at ~12s → mic fallback to built-in → transcript resumes.
10. **Output to virtual cable (BlackHole)** — Set BlackHole as output → Start meeting → stuck-watchdog trips (no chunks for 8s) → banner `system-audio-stuck`.
11. **Mic muted at hardware** — Plug muted USB mic → Start meeting → detector trips after 12s → banner `mic-zero-fill`. Latch-once: banner appears exactly once.
12. **Toggle screen permission OFF during active meeting** — System Settings → uncheck Natively. Expected: next route change or restart triggers banner.
13. **Dev-build TCC quirk (pending B5 fix)** — `npm run electron:dev` → currently dev-mode early-returns `'granted'`. After B5: env-flag opt-in `NATIVELY_DEV_BYPASS_SCREEN_TCC=1` required.
14. **Packaged build, restricted by MDM** — MDM-restricted machine → Start meeting → `status==='restricted'` → banner `mac-screen-recording-restricted` ("Contact administrator").
15. **USB mic hot-unplug mid-meeting** — Pull cable → recovery handler swaps to default → transcript continues within ~2s.

---

## 6. What still needs future improvement

After all in-scope fixes land:

1. **Telemetry on silent-capture rate.** Track the ratio of started meetings where peak amplitude stays at 0 for the first N seconds. This is the single most actionable leading indicator and competitors don't have it.
2. **Test infrastructure overhaul.** Extract `setupSystemAudioPipeline` from 4800-line `main.ts` so it's importable; build behavioral fakes (`systemPreferences`, native module, fake clock); write the 15 gap regression tests identified by the test-engineer audit.
3. **macOS 26 ScreenCaptureKit evolution.** Apple's docs hint at API changes in macOS 26 — keep an eye on `MacSckSystemAudioLoopbackOverride` / `MacCatapSystemAudioLoopbackCapture` Chromium flags if we ever migrate to `desktopCapturer` system audio.
4. **VPIO ducking detection.** Some apps' Voice Processing IO can duck system audio to ~−51 dB. Not currently relevant (we don't use VPIO) but worth checking if peak amplitudes look suspiciously low.
5. **Intel Mac compatibility verification.** All testing has been on Apple Silicon. Verify against an Intel host before release.

---

## 7. Files changed in this work (running list, updated as fixes land)

| File | Fix(es) |
|---|---|
| `src/components/NativelyInterface.tsx` | B1 (mic banner), B2 (awaiting-audio state) |
| `electron/main.ts` | B2, B3 (capture-init try/catch), B4 (mic recovery terminal IPC), B8 (broadcast both surfaces) |
| `electron/preload.ts` | B2 (state union widened) |
| `src/types/electron.d.ts` | B2 (state union widened) |
| `src/components/ui/RollingTranscript.tsx` | B2 (awaiting-audio visual) |
| `src/components/ui/ChannelCard.tsx` | B2 (awaiting-audio visual) |
| `electron/services/__tests__/MicChannelAuditBannerSurfaced.test.mjs` | B1 regression (6 tests) |
| `electron/services/__tests__/SttAwaitingAudioInitialState.test.mjs` | B2 regression (8 tests) |
| `electron/services/__tests__/SetupSystemAudioPipelineConstructionGuards.test.mjs` | B3 regression (8 tests) |
| `electron/services/__tests__/MicRecoveryEmitsTerminalIpc.test.mjs` | B4 regression (8 tests) |
| `electron/services/__tests__/AudioCaptureFailedBroadcastBothSurfaces.test.mjs` | B8 regression (in progress) |

Pending fixes will be appended here as they land.

---

## 8. Senior-level review (filled in after all in-scope fixes complete)

_To be written at end of Phase D._
