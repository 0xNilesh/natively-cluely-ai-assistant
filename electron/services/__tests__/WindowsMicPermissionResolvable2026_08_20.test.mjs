// R-23 regression test — both platform branches.
//
// F-706 made Windows report the real microphone privacy state instead of a
// hardcoded 'granted'. That was right, but it left the resulting state
// unresolvable:
//
//   - onboarding shows the mic step for any status !== 'granted';
//   - its action is permissions:request-mic;
//   - that handler was `if (process.platform !== 'darwin') return true` — a
//     no-op resolving TRUE, so onboarding believed the request had succeeded;
//   - refreshStatus() then re-read the same non-granted value.
//
// A Windows user with the microphone toggle off was parked on that step with no
// way forward. There is no fix via the request API: Electron's
// systemPreferences.askForMediaAccess is macOS-only (per its own docs), so
// Windows has no consent prompt at all. The remedy is the privacy pane.
//
// Also: Electron's win32 getMediaAccessStatus can return 'unknown'
// (ConvertDeviceAccessStatus over GetDeviceAccessStatus(DeviceClass_AudioCapture)),
// which is NOT in the union checkPermissions declares — and is not actionable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ipc = fs.readFileSync(new URL('../../ipcHandlers.ts', import.meta.url), 'utf8');
const full = fs.readFileSync(new URL('../../../src/components/onboarding/PermissionsOnboardingFull.tsx', import.meta.url), 'utf8');
const toast = fs.readFileSync(new URL('../../../src/components/onboarding/PermissionsToaster.tsx', import.meta.url), 'utf8');
const dts = fs.readFileSync(new URL('../../../src/types/electron.d.ts', import.meta.url), 'utf8');

function slice(src, needle, len) {
  const i = src.indexOf(needle);
  assert.notEqual(i, -1, `${needle} not found`);
  return src.slice(i, i + len);
}

test('darwin still prompts for microphone access', () => {
  const body = slice(ipc, "safeHandle('permissions:request-mic'", 500);
  assert.ok(/askForMediaAccess\('microphone'\)/.test(body),
    'the macOS consent prompt must be untouched — it is the only platform that has one');
  assert.ok(/process\.platform !== 'darwin'/.test(body), 'the platform split must remain explicit');
});

test('win32 no longer claims a request it cannot make succeeded', () => {
  const body = slice(ipc, "safeHandle('permissions:request-mic'", 500);
  const guard = body.slice(body.indexOf("process.platform !== 'darwin'"));
  assert.ok(/return false/.test(guard.slice(0, 60)),
    'returning true told onboarding a no-op had granted access, which is what made the step unsatisfiable');
});

test('win32 mic step deep-links to the privacy pane instead', () => {
  for (const [name, src] of [['PermissionsOnboardingFull', full], ['PermissionsToaster', toast]]) {
    assert.ok(/ms-settings:privacy-microphone/.test(src),
      `${name} must send Windows users where the setting actually lives`);
    assert.ok(/platform === 'win32'/.test(src),
      `${name} must branch on the platform explicitly`);
  }
});

test('the ms-settings scheme is allowlisted for win32 only', () => {
  const body = slice(ipc, 'const allowedSystemSettingsUrl', 400);
  assert.ok(/'ms-settings:' && process\.platform === 'win32'/.test(body),
    'ms-settings must be gated to Windows — issue #252 was a renderer handing the wrong platform a scheme it could not resolve');
  assert.ok(/'x-apple\.systempreferences:' && process\.platform === 'darwin'/.test(body),
    'the macOS gate must be preserved');
});

test("'unknown' is normalised rather than surfaced off-contract", () => {
  const body = slice(ipc, "if (process.platform === 'win32')", 1400);
  assert.ok(/=== 'unknown'/.test(body), "Electron's win32 'unknown' must be handled");
  assert.ok(/\? 'granted'/.test(body),
    "'unknown' means the status could not be determined — blocking a working machine on it is the failure mode F-706's own comment warns against");

  assert.ok(!/'unknown'/.test(slice(dts, 'checkPermissions:', 260)),
    'and it must not leak into the declared union — normalising beats widening a type no consumer can act on');
});

test('actionable non-granted states still surface on win32', () => {
  const body = slice(ipc, "if (process.platform === 'win32')", 1400);
  for (const s of ['denied', 'restricted', 'not-determined']) {
    assert.ok(!new RegExp(`=== '${s}'[^\\n]*\\?\\s*'granted'`).test(body),
      `${s} must NOT be normalised away — F-706 exists to surface it`);
  }
  assert.ok(/getMediaAccessStatus\('microphone'\)/.test(body), 'the real query must remain');
});
