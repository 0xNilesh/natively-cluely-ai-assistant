// electron/services/__tests__/WindowsMicDeniedCopyNoRestart2026_08_26.test.mjs
//
// Regression: formatPermissionMessage's win32 branch for 'mic-denied' ended
// "…then restart." — a macOS instruction shown to Windows users.
//
// On macOS the restart is real: a TCC grant is read at process launch, so a
// fresh Microphone grant never reaches the running app. The overlay banner
// promotes a "Restart Now" button for exactly that, and NativelyInterface
// gates it on `isMac`. Windows applies the privacy toggle live AND gets no
// Restart button — so the copy asked for a step the UI never offered and the
// OS never required.
//
// Source-level assertion, following the WindowsMicPermissionQueried2026_08_18
// precedent: formatPermissionMessage is module-private in main.ts, so the
// platform branches cannot be invoked directly from a test without booting
// Electron. Reading the branch text is what is available, and it is enough to
// stop the macOS wording from creeping back into a non-darwin arm.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAIN_TS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'main.ts');
const src = readFileSync(MAIN_TS, 'utf8');

/** The body of `case '<reason>':` inside formatPermissionMessage. */
function messageCase(reason) {
  const fnAt = src.indexOf('function formatPermissionMessage');
  assert.notEqual(fnAt, -1, 'formatPermissionMessage not found in main.ts');
  const caseAt = src.indexOf(`case '${reason}':`, fnAt);
  assert.notEqual(caseAt, -1, `case '${reason}' not found in formatPermissionMessage`);
  const nextAt = src.indexOf('    case ', caseAt + 10);
  return src.slice(caseAt, nextAt === -1 ? caseAt + 2000 : nextAt);
}

test("win32 mic-denied does not tell the user to restart the app", () => {
  const body = messageCase('mic-denied');

  // Split the ternary: the isMac arm may keep "then restart", the other must not.
  const arms = body.split('\n').filter((l) => l.trim().startsWith('?') || l.trim().startsWith(':'));
  assert.equal(arms.length, 2, 'expected a two-arm isMac ternary for mic-denied');

  const macArm = arms.find((l) => l.trim().startsWith('?'));
  const otherArm = arms.find((l) => l.trim().startsWith(':'));

  assert.match(macArm, /then restart\./, 'macOS keeps its TCC restart instruction');
  assert.doesNotMatch(
    otherArm,
    /then restart\./,
    'the non-darwin arm must not ask for an app restart — Windows applies the ' +
      'mic toggle live and the banner offers no Restart button off darwin',
  );
});

test('win32 mic-denied points at the Windows privacy panel and a concrete next step', () => {
  const body = messageCase('mic-denied');
  const otherArm = body.split('\n').find((l) => l.trim().startsWith(':'));
  assert.match(otherArm, /Settings → Privacy → Microphone/, 'names the Windows panel');
  assert.match(otherArm, /start the meeting again/, 'gives a next step that actually applies');
});

test('the macOS-only Screen Recording reasons never reach a win32 reader', () => {
  // Defense-in-depth for the sibling bug: every mac- prefixed reason degrades to
  // system-audio-stuck off darwin, so none of their Privacy & Security wording
  // can surface on Windows.
  for (const reason of [
    'mac-screen-recording-restricted',
    'mac-screen-recording-revoked-rebuild',
    'mac-same-device-input-output',
  ]) {
    const body = messageCase(reason);
    assert.match(
      body,
      /if \(!isMac\) return formatPermissionMessage\('system-audio-stuck'\)/,
      `${reason} must degrade to system-audio-stuck off darwin`,
    );
  }
});
