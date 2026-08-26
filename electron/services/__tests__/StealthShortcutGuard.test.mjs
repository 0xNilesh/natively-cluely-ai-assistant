import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');

// The opt-in shortcut-guard shares the single native hook with full stealth
// typing (ACTIVE_HOOK is one global slot), so its lifecycle must be coordinated:
// free the tap before full typing engages, restore it after, and dispatch chords
// while it runs. StealthKeyboardManager imports electron at module scope so it
// can't load under node --test; these pin the coordination invariants in source.

const SKM = 'electron/services/StealthKeyboardManager.ts';

test('full stealth start() frees the guard first; stop() restores it', () => {
  const src = read(SKM);
  const start = src.slice(src.indexOf('public start(): boolean {'), src.indexOf('private hideAuxWindowsForStealth'));
  assert.match(start, /this\.stopGuard\(\)/, 'start() must stop the guard before engaging the full typing tap (one shared hook).');
  const stopStart = src.indexOf('public stop(): void {');
  const stop = src.slice(stopStart, src.indexOf('public setShortcutGuardEnabled(', stopStart));
  assert.match(stop, /this\.maybeStartGuard\(\)/, 'stop() must restore the guard after full stealth typing ends.');
});

test('the guard starts the tap in shortcut-only mode with no overlay bounds', () => {
  const src = read(SKM);
  const fn = src.slice(src.indexOf('private maybeStartGuard('), src.indexOf('private stopGuard('));
  assert.ok(fn.length > 0, 'maybeStartGuard() not found');
  assert.match(fn, /process\.platform !== 'win32'/, 'guard must be Windows-only.');
  assert.match(fn, /if \(!this\.shortcutGuardEnabled\) return/, 'guard must respect the opt-in flag.');
  assert.match(fn, /if \(this\.active\) return/, 'guard must not run while full stealth typing owns the tap.');
  assert.match(fn, /\/\* shortcutOnly \*\/ true, \/\* overlayBounds \*\/ null/, 'guard must start the tap in shortcut-only mode with null bounds.');
});

test('app-chord events dispatch in guard mode (active is false then)', () => {
  const src = read(SKM);
  const h = src.slice(src.indexOf('private handleCapturedKey('), src.indexOf('private sendKeyToOverlay('));
  assert.match(h, /if \(!this\.active && !this\.guardRunning\) return/, 'app-chord branch must dispatch when the guard is running, not only when active.');
  assert.match(h, /if \(this\.active\) this\.armIdleTimer\(\)/, 'idle auto-stop applies to full mode only, not the guard.');
});

test('full stealth start() passes shortcutOnly=false (existing behaviour preserved)', () => {
  const src = read(SKM);
  assert.match(src, /\}, appChords, \/\* shortcutOnly \*\/ false, overlayBounds\)/, 'the full typing tap must start with shortcutOnly=false.');
});

test('the guard defaults ON (opt-out) on Windows', () => {
  const settings = read('electron/services/SettingsManager.ts');
  assert.match(settings, /stealthShortcutGuard\?: boolean/, 'the persisted setting must exist.');
  // Boot wiring enables it UNLESS the setting is explicitly false (default ON).
  const main = read('electron/main.ts');
  assert.match(
    main,
    /get\('stealthShortcutGuard'\) !== false/,
    'boot must enable the guard unless the setting is explicitly false (default ON).',
  );
  // The AppState getter reports the same opt-out default (unset ⟹ enabled).
  assert.match(
    main,
    /public getStealthShortcutGuardEnabled\(\): boolean \{[\s\S]*?!== false/,
    'getStealthShortcutGuardEnabled must treat an unset setting as enabled (default ON).',
  );
  // The runtime field is the pre-boot fail-safe and still starts false, but the
  // POLICY is default-ON via boot — so the old "defaults OFF" assertion is gone.
  const src = read(SKM);
  assert.match(
    src,
    /private shortcutGuardEnabled = false/,
    'the runtime mirror starts false as a fail-safe; boot drives the default-ON policy.',
  );
});

test('the guard default-ON is Windows-only (macOS no-op branch)', () => {
  // Cross-platform contract: the default-ON policy must never engage a hook off
  // Windows. Three independent gates enforce the macOS/Linux no-op:
  const main = read('electron/main.ts');
  // 1. Boot only touches the guard inside a win32 branch.
  assert.match(
    main,
    /if \(process\.platform === 'win32'\) \{[\s\S]*?stealthShortcutGuard[\s\S]*?setShortcutGuardEnabled\(true\)/,
    'boot must gate the guard enable behind process.platform === "win32".',
  );
  // 2. AppState.setStealthShortcutGuardEnabled only drives the runtime on win32.
  assert.match(
    main,
    /public setStealthShortcutGuardEnabled\(enabled: boolean\): void \{[\s\S]*?if \(process\.platform === 'win32'\)[\s\S]*?setShortcutGuardEnabled\(enabled\)/,
    'setStealthShortcutGuardEnabled must apply the runtime guard only on win32.',
  );
  // 3. The manager itself short-circuits off win32 before starting any hook.
  const skm = read(SKM);
  const fn = skm.slice(skm.indexOf('private maybeStartGuard('), skm.indexOf('private stopGuard('));
  assert.match(
    fn,
    /if \(process\.platform !== 'win32'\) return/,
    'maybeStartGuard must return early off Windows so the default-ON policy never starts a hook there.',
  );
});

test('a rebind re-arms a running guard with the new chords', () => {
  const km = read('electron/services/KeybindManager.ts');
  const setBlock = km.slice(km.indexOf("ipcMain.handle('keybinds:set'"), km.indexOf("ipcMain.handle('keybinds:get-registration-failures'"));
  assert.match(setBlock, /this\.notifyChordsChanged\(\)/, 'a rebind must notify the guard so it re-arms with the new chord table.');
  const fn = km.slice(km.indexOf('private notifyChordsChanged('));
  assert.match(fn, /refreshShortcutGuard\(\)/, 'notifyChordsChanged must call refreshShortcutGuard.');
});

test('a failed arm can RECOVER — setShortcutGuardEnabled does not early-return on unchanged value', () => {
  // Open-1 fix: if the guard is enabled but a prior arm failed (empty table at
  // boot, transient hook-install failure), guardRunning stays false. An early
  // `if (shortcutGuardEnabled === enabled) return` would block every retry,
  // leaving the bypass-hotkey protection off for the whole session.
  const src = read(SKM);
  const fn = src.slice(src.indexOf('public setShortcutGuardEnabled('), src.indexOf('public refreshShortcutGuard('));
  assert.ok(fn.length > 0, 'setShortcutGuardEnabled not found');
  assert.doesNotMatch(
    fn,
    /if \(this\.shortcutGuardEnabled === enabled\) return/,
    'must NOT early-return on unchanged value — that blocks retry after a failed arm.',
  );
  assert.match(fn, /if \(enabled\) this\.maybeStartGuard\(\)/, 'enabling must (re)attempt maybeStartGuard (idempotent retry).');
});

test('refreshShortcutGuard recovers a guard that never armed (gates on enabled, not guardRunning)', () => {
  // Open-2 fix: a rebind must be a recovery point — attempt a start when the
  // feature is enabled even if guardRunning is currently false, instead of the
  // old `if (!this.guardRunning) return` which stranded a boot-time failure.
  const src = read(SKM);
  const fn = src.slice(src.indexOf('public refreshShortcutGuard('), src.indexOf('private maybeStartGuard('));
  assert.ok(fn.length > 0, 'refreshShortcutGuard not found');
  assert.doesNotMatch(fn, /if \(!this\.guardRunning\) return/, 'must not bail when not running — a rebind should recover a failed arm.');
  assert.match(fn, /if \(!this\.shortcutGuardEnabled\) return/, 'must no-op when the feature is disabled.');
  assert.match(fn, /this\.maybeStartGuard\(\)/, 'must attempt a (re)start.');
});

test('the app-chord swallow suppresses auto-repeat (no dispatch storm)', () => {
  // Open-3 fix: holding a bound chord must fire its action ONCE, not per repeat.
  // The hook consults swallowed_ups (down-swallowed, up-pending) as a repeat
  // detector and swallows the repeat without re-dispatching.
  const hook = read('native-module/src/keyboard_hook_windows.rs');
  const block = hook.slice(hook.indexOf('if let Some(id) = matched {'), hook.indexOf('// Shortcut-guard mode: the app-chord swallow above'));
  assert.ok(block.length > 0, 'app-chord swallow block not found');
  assert.match(block, /AUTO-REPEAT GUARD/, 'the auto-repeat guard comment must anchor the fix.');
  // The repeat check (contains) must appear BEFORE the dispatch (send_payload).
  const containsIdx = block.indexOf('.contains(&vk)');
  const dispatchIdx = block.indexOf('send_payload(&state');
  assert.ok(containsIdx > -1 && dispatchIdx > -1, 'both the repeat check and the dispatch must be present.');
  assert.ok(containsIdx < dispatchIdx, 'the auto-repeat check must run BEFORE dispatch so a held chord is not re-dispatched.');
});
