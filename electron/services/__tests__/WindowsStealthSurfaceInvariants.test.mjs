import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');

// Source-invariant pins for the Windows stealth surface items #4, #5, #6 from
// the platform review. StealthKeyboardManager / main.ts import electron at module
// scope so they can't load under `node --test`; these assert the contracts in
// source, matching the existing StealthShortcutGuard.test.mjs approach.

// ─── #4: the CONSUMED native type is the source of truth ──────────────────────
//
// The Electron code consumes the hand-maintained `NativeModule` interface (what
// loadNativeModule() returns), NOT the NAPI-RS generated native-module/index.d.ts
// (which is built on the macOS host and omits the Windows-only, cfg-gated
// exports). If a Windows-only export is dropped from THIS interface, win32
// callers silently go untyped — pin the ones the stealth path depends on.
test('#4 NativeModule interface declares the Windows stealth exports', () => {
  const loader = read('electron/audio/nativeModuleLoader.ts');
  assert.match(loader, /isImeKeyboardActive\?: \(\) => boolean/, 'isImeKeyboardActive must stay declared (CJK gate).');
  assert.match(loader, /isAccessibilityGranted\?: \(\) => boolean/, 'isAccessibilityGranted must stay declared (permission probe).');
  assert.match(loader, /StealthKeyboardTap\?: new \(\) => \{/, 'StealthKeyboardTap constructor must stay declared.');
  // The app-chord id the Windows hook self-dispatches must survive on CapturedKey.
  assert.match(loader, /appChordId\?: string/, 'CapturedKey.appChordId must stay declared (Windows hotkey-leak swallow).');
});

// ─── #5: stealth availability is IME-aware end to end ─────────────────────────
//
// A CJK IME user must be routed to the focusable-overlay fallback (real DOM
// typing) rather than a dead WS_EX_NOACTIVATE window or mojibake. Every gate
// that decides "is stealth usable" must go through isAvailable(), which folds in
// the native isImeKeyboardActive() probe — NOT isNativeTapPresent() (which
// ignores the IME).
test('#5 the no-activate window policy provider is IME-aware (isAvailable, not isNativeTapPresent)', () => {
  const main = read('electron/main.ts');
  const block = main.slice(
    main.indexOf('setStealthHookAvailabilityProvider(() => {'),
    main.indexOf('setStealthHookAvailabilityProvider(() => {') + 400,
  );
  assert.ok(block.length > 0, 'setStealthHookAvailabilityProvider wiring not found');
  assert.match(block, /isAvailable\(\)/, 'the focus-policy provider must gate on isAvailable() so a CJK IME keeps the overlay focusable.');
  assert.doesNotMatch(block, /isNativeTapPresent\(\)/, 'the provider must NOT bypass the IME gate via isNativeTapPresent().');
});

test('#5 StealthKeyboardManager.isAvailable folds in the CJK-IME probe on win32', () => {
  const skm = read('electron/services/StealthKeyboardManager.ts');
  const fn = skm.slice(skm.indexOf('public isAvailable(): boolean {'), skm.indexOf('public isNativeTapPresent('));
  assert.ok(fn.length > 0, 'isAvailable() not found');
  assert.match(fn, /process\.platform === 'win32' && this\.isImeActive\(\)/, 'isAvailable() must return false for a CJK IME on win32.');
});

test('#5 renderer auto-engage gates route through isAvailable()', () => {
  const main = read('electron/main.ts');
  // The auto-engage / IME-refresh IPC gates the renderer consults must all
  // return the IME-aware availability, so switching layouts is reflected.
  assert.match(main, /'stealth-tap:should-auto-engage', \(\) => stealth\.isAvailable\(\)/, 'should-auto-engage must return isAvailable().');
  assert.match(main, /'stealth-tap:refresh-ime', \(\) => stealth\.isAvailable\(\)/, 'refresh-ime must return isAvailable().');
});

// ─── #6: the threat model is documented at the hook, and stays honest ─────────
test('#6 the hook header documents what stealth does NOT hide', () => {
  const hook = read('native-module/src/keyboard_hook_windows.rs');
  assert.match(hook, /Threat model — what this does and does NOT hide/, 'the threat-model section must stay in the hook header.');
  assert.match(hook, /Raw Input|WM_INPUT/, 'must state Raw Input is not hidden.');
  assert.match(hook, /[Kk]ernel-level monitoring|keyboard filter\s+driver/, 'must state kernel-level monitoring is not hidden.');
  assert.match(hook, /not hide typing/, 'must state plainly that it does not hide typing.');
});
