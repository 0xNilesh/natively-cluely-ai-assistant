// src/lib/__tests__/WindowsOverlayPermissionPane2026_08_26.test.mjs
//
// Regression: the meeting overlay's audio/permission banner derived its
// "open the pane that fixes this" deep link as `!isMac ? null : …`, so on
// Windows EVERY reason fell through to the internal-Settings action — the one
// that opens Natively's own Settings window.
//
// That contradicted the banner's own body text. formatPermissionMessage's
// win32 branch for both microphone faults reads "Enable Natively under
// Settings → Privacy → Microphone", i.e. the WINDOWS privacy panel, while the
// button next to it opened Natively's settings, where there is nothing to
// grant. Reported as: "it shows go to settings, whereas in windows there is
// nothing to do in settings."
//
// Both microphone reasons genuinely reach Windows users:
//   - mic-zero-fill  — the peak-to-peak silence detector in main.ts is not
//                      platform-gated.
//   - mic-denied     — startup getMediaAccessStatus('microphone'), queryable
//                      on win32 since F-706.
//
// The mapping now lives in a pure, platform-injectable helper so BOTH branches
// are testable without mutating process.platform (CLAUDE.md).

import test from 'node:test';
import assert from 'node:assert/strict';

import { permissionPaneUri, micSettingsUri, openExternalAllows, classifyMicStatus } from '../micPermissionPolicy.mjs';

const MAC_MIC = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const MAC_SCREEN = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const WIN_MIC = 'ms-settings:privacy-microphone';

// ─── Windows ──────────────────────────────────────────────────────

test('win32 microphone fault deep-links to the Windows privacy panel', () => {
  // The actual regression: this returned null, so the banner opened Natively's
  // own Settings window instead of the panel its body told the user to open.
  assert.equal(permissionPaneUri('win32', 'microphone'), WIN_MIC);
});

test('win32 microphone pane agrees with permissions:open-mic-settings', () => {
  // The overlay banner and the onboarding card must not disagree about where a
  // blocked mic is fixed — both resolve through micSettingsUri.
  assert.equal(permissionPaneUri('win32', 'microphone'), micSettingsUri('win32'));
});

test('win32 screen-capture fault has no pane and falls back to internal Settings', () => {
  // Windows has no screen-recording permission gate (permissions:check returns
  // a constant screen:'granted'), so there is nothing to open. null is the
  // signal for the internal-Settings action.
  assert.equal(permissionPaneUri('win32', 'screen'), null);
});

test('win32 never returns a macOS URI scheme', () => {
  // Handing Windows shell an x-apple.systempreferences: URI was the original
  // issue #252 failure. Nothing on win32 may produce one.
  for (const pane of ['microphone', 'screen', null, undefined]) {
    const uri = permissionPaneUri('win32', pane);
    assert.ok(
      uri === null || !uri.startsWith('x-apple'),
      `win32 + ${String(pane)} produced a macOS URI: ${uri}`,
    );
  }
});

// ─── macOS (unchanged) ────────────────────────────────────────────

test('darwin microphone fault still opens the macOS Microphone pane', () => {
  assert.equal(permissionPaneUri('darwin', 'microphone'), MAC_MIC);
});

test('darwin screen-capture fault still opens the Screen Recording pane', () => {
  assert.equal(permissionPaneUri('darwin', 'screen'), MAC_SCREEN);
});

// ─── Neither pane / no panel ──────────────────────────────────────

test('a fault with no pane falls back to internal Settings on every platform', () => {
  // e.g. "Input and Output Are the Same Device" — a device-config fault that no
  // privacy pane fixes. It must not be routed to one.
  for (const p of ['darwin', 'win32', 'linux']) {
    assert.equal(permissionPaneUri(p, null), null);
    assert.equal(permissionPaneUri(p, undefined), null);
  }
});

test('linux has no panel for either pane', () => {
  assert.equal(permissionPaneUri('linux', 'microphone'), null);
  assert.equal(permissionPaneUri('linux', 'screen'), null);
});

// ─── Contract with the open-external allowlist ────────────────────
//
// ipcHandlers' 'open-external' handler accepts ONLY https: and, on darwin,
// x-apple.systempreferences: — deliberately tight since issue #252, when an
// unknown scheme reached Windows shell and raised a Microsoft Store popup.
//
// So a URI this helper produces may be passed to openExternal ONLY if that
// allowlist would accept it on that platform. 'ms-settings:' is NOT on it:
// the Windows microphone link must therefore go through the dedicated
// permissions:open-mic-settings IPC instead, or the click is silently dropped
// and the button does nothing — strictly worse than opening the wrong window.
//
// This pins the routing rule so a future edit cannot quietly send a
// non-allowlisted scheme back through open-external.

// openExternalAllows IS the allowlist ipcHandlers' safeHandle('open-external')
// now calls — imported, not mirrored, so changing the boundary changes these
// assertions instead of leaving a stale copy green.
const openExternalWouldAccept = openExternalAllows;

test('the Windows mic URI is NOT accepted by open-external — it must use its own IPC', () => {
  const uri = permissionPaneUri('win32', 'microphone');
  assert.equal(uri, WIN_MIC);
  assert.equal(
    openExternalWouldAccept('win32', uri),
    false,
    'if this ever becomes true the allowlist changed — revisit the banner routing',
  );
});

test('the macOS screen URI IS accepted by open-external, so that path may use it', () => {
  const uri = permissionPaneUri('darwin', 'screen');
  assert.equal(openExternalWouldAccept('darwin', uri), true);
});

test('no pane URI is ever accepted by open-external on win32', () => {
  // The banner must never hand Windows shell a scheme the allowlist rejects.
  for (const pane of ['microphone', 'screen', null]) {
    const uri = permissionPaneUri('win32', pane);
    if (uri === null) continue;
    assert.equal(
      openExternalWouldAccept('win32', uri),
      false,
      `win32 ${pane} URI ${uri} would be blocked by open-external — route it elsewhere`,
    );
  }
});

// ─── The 'policy' dead end, ported from the deleted PermissionsOnboardingFull ──
//
// A mic blocked by MDM / parental controls cannot be fixed from any privacy
// panel. The live card used to offer "Open Settings" anyway — the same false
// promise CR-03 removed on the Windows side. classifyMicStatus already
// distinguishes it; these pin WHICH platform/status combinations reach it, so
// the card's dead-end branch can never widen to a case a user could fix.

test("darwin 'restricted' is a policy dead end — no panel can fix it", () => {
  const plan = classifyMicStatus('darwin', 'restricted');
  assert.equal(plan.usable, false);
  assert.equal(plan.remedy, 'policy');
});

test("win32 'restricted' is NOT policy — it is the device switch, and the panel fixes it", () => {
  // Electron maps win32 DeniedBySystem to 'restricted'. Calling that "blocked by
  // your organization" would tell the user something false and leave them stuck.
  const plan = classifyMicStatus('win32', 'restricted');
  assert.equal(plan.usable, false);
  assert.equal(plan.remedy, 'settings');
  assert.equal(permissionPaneUri('win32', 'microphone'), WIN_MIC);
});

test("'unknown' is usable on every platform — the query failed open, not closed", () => {
  // The card gates on micPlan.usable, not a literal 'granted'. Gating on the
  // literal stranded an unresolvable machine in onboarding forever.
  for (const p of ['darwin', 'win32', 'linux']) {
    assert.equal(classifyMicStatus(p, 'unknown').usable, true, `${p} must not lock out on 'unknown'`);
  }
});
