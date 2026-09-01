// electron/services/__tests__/ModelSelectorContentProtection.test.mjs
//
// Regression tests for the model-picker capture leak: with undetectable mode
// ON, the picker window was fully visible in macOS screenshots and screen
// shares even though the overlay it hangs off was correctly invisible.
//
// ROOT CAUSE the assertions below pin down:
//
//   ModelSelectorWindowHelper is the only window helper that calls
//   setVisibleOnAllWorkspaces() on every SHOW rather than once at creation. On
//   macOS Electron implements that by calling TransformProcessType() between
//   UIElementApplication and ForegroundApplication — the same activation-policy
//   flip as app.dock.hide()/show(), which WindowHelper.reassertContentProtection
//   already documents as making WindowServer re-evaluate each NSWindow and
//   silently reset its sharingType. Every open of the picker therefore threw
//   away the NSWindowSharingNone that setContentProtection(true) had installed.
//
// What is testable here is the ORDERING and STATE logic — the OS flag itself
// obviously is not. So we drive the helper against a fake BrowserWindow that
// records the exact call sequence and assert:
//
//   1. skipTransformProcessType is passed on EVERY setVisibleOnAllWorkspaces,
//      so the picker can never move the app's activation policy.
//   2. Content protection is applied AFTER the collection-behavior call at
//      creation (the SettingsWindowHelper ordering) and again after show.
//   3. A LAZILY created window inherits the undetectable state that was set
//      before it existed — the picker is preloaded/created on demand, so the
//      toggle routinely lands first.
//   4. Show/hide cycles re-assert, so protection cannot be lost across reopens.
//   5. An overlay-anchored picker is protected unconditionally, like the
//      overlay body / pill / toggle chrome it visually belongs to.
//
// Run: `ELECTRON_RUN_AS_NODE=1 electron --test`

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILED = path.resolve(__dirname, '../../../dist-electron/electron/ModelSelectorWindowHelper.js');

const REASSERT_WAIT_MS = 150; // > CONTENT_PROTECTION_REASSERT_MS (60)

// ---- Fake window --------------------------------------------------------------

// Every call the helper makes on its BrowserWindow lands in `calls` as
// [method, ...args], so a test can assert on ORDER as well as on values.
function makeFakeWindow(calls) {
  const readyToShow = [];
  const listeners = new Map();
  const win = {
    id: 1,
    _visible: false,
    _destroyed: false,
    isDestroyed: () => win._destroyed,
    isVisible: () => win._visible,
    isAlwaysOnTop: () => false,
    getBounds: () => ({ x: 10, y: 20, width: 140, height: 200 }),
    getNativeWindowHandle: () => Buffer.alloc(8),
    setContentProtection: (v) => calls.push(['setContentProtection', v]),
    setVisibleOnAllWorkspaces: (v, opts) => calls.push(['setVisibleOnAllWorkspaces', v, opts]),
    setHiddenInMissionControl: (v) => calls.push(['setHiddenInMissionControl', v]),
    setAlwaysOnTop: (v, level) => calls.push(['setAlwaysOnTop', v, level]),
    setParentWindow: (p) => calls.push(['setParentWindow', p ? 'parent' : null]),
    setPosition: (x, y) => calls.push(['setPosition', x, y]),
    setOpacity: (v) => calls.push(['setOpacity', v]),
    setFocusable: () => {},
    focus: () => calls.push(['focus']),
    show: () => { win._visible = true; calls.push(['show']); win._emit('show'); },
    showInactive: () => { win._visible = true; calls.push(['showInactive']); win._emit('show'); },
    hide: () => { win._visible = false; calls.push(['hide']); },
    close: () => {},
    destroy: () => { win._destroyed = true; },
    loadURL: () => Promise.resolve(),
    webContents: { send: () => {}, on: () => {} },
    once: (event, fn) => { if (event === 'ready-to-show') readyToShow.push(fn); },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    _emit: (event) => { for (const fn of listeners.get(event) || []) fn(); },
    // Fire the deferred ready-to-show the helper registered at creation.
    _ready: () => { for (const fn of readyToShow.splice(0)) fn(); },
  };
  return win;
}

// Minimal WindowHelper stand-in. `overlay` decides whether showWindow() treats
// the open as overlay-anchored (meeting chrome) or launcher-anchored.
function makeFakeWindowHelper(overlay) {
  const overlayWindow = { id: 2, isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 732, height: 300 }) };
  const launcherWindow = { id: 3, isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 600, height: 300 }) };
  return {
    getMainWindow: () => (overlay ? overlayWindow : launcherWindow),
    getOverlayWindow: () => overlayWindow,
    getOverlayPanelLeftMargin: () => 0,
    notifyOverlayPopover: () => {},
  };
}

// ---- Harness ------------------------------------------------------------------

let ModelSelectorWindowHelper;
let originalLoad;
let originalPlatform;
let createdWindows;
let calls;

before(async () => {
  // The interesting branches are macOS-only (the process-type transform, the
  // NSPanel stealth pass). Pin the platform so this suite is meaningful when
  // run from CI on any host.
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

  createdWindows = [];
  calls = [];

  const fakeElectron = {
    app: { isPackaged: false, getAppPath: () => '/tmp', on: () => {}, removeListener: () => {} },
    screen: {
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    },
    BrowserWindow: function BrowserWindow() {
      const win = makeFakeWindow(calls);
      createdWindows.push(win);
      return win;
    },
  };

  originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.apply(this, arguments);
  };

  const mod = await import('file://' + COMPILED.replace(/\\/g, '/'));
  ModelSelectorWindowHelper = mod.ModelSelectorWindowHelper;
  assert.equal(
    typeof ModelSelectorWindowHelper,
    'function',
    'compiled ModelSelectorWindowHelper class must be importable',
  );
});

after(() => {
  if (originalLoad) Module._load = originalLoad;
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
});

beforeEach(() => {
  createdWindows = [];
  calls.length = 0;
});

const protectionCalls = () => calls.filter(([m]) => m === 'setContentProtection').map(([, v]) => v);
const workspaceCalls = () => calls.filter(([m]) => m === 'setVisibleOnAllWorkspaces');
const indexOfCall = (method) => calls.findIndex(([m]) => m === method);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Helper with a window already created and realized, ready to be shown. */
function makeReadyHelper({ undetectable, overlay }) {
  const helper = new ModelSelectorWindowHelper();
  helper.setWindowHelper(makeFakeWindowHelper(overlay));
  helper.setContentProtection(undetectable);
  helper.preloadWindow();
  createdWindows[0]._ready();
  return helper;
}

// ---- Tests --------------------------------------------------------------------

describe('ModelSelectorWindowHelper content protection', () => {
  test('a lazily created window inherits the undetectable state set before it existed', () => {
    const helper = new ModelSelectorWindowHelper();

    // Undetectable is toggled on while the picker does not exist yet — the
    // normal case, because the window is preloaded after AppState's startup
    // broadcast and re-created on demand after a destroy.
    helper.setContentProtection(true);
    assert.equal(createdWindows.length, 0, 'no window should exist yet');

    helper.preloadWindow();

    assert.equal(createdWindows.length, 1);
    assert.deepEqual(
      protectionCalls(),
      [true],
      'the freshly created window must be born protected, not with the field default',
    );
  });

  test('the dedupe guard does not swallow a pre-creation toggle', () => {
    const helper = new ModelSelectorWindowHelper();

    // Two identical calls before the window exists: the guard must not treat
    // the second as a no-op in a way that loses the state for createWindow().
    helper.setContentProtection(true);
    helper.setContentProtection(true);
    helper.preloadWindow();

    assert.deepEqual(protectionCalls(), [true]);
  });

  test('creation applies protection AFTER the collection-behavior call', () => {
    const helper = new ModelSelectorWindowHelper();
    helper.setContentProtection(true);
    helper.preloadWindow();

    const workspaceIdx = indexOfCall('setVisibleOnAllWorkspaces');
    const protectIdx = indexOfCall('setContentProtection');
    assert.ok(workspaceIdx >= 0, 'creation must set the collection behavior');
    assert.ok(
      protectIdx > workspaceIdx,
      'setContentProtection must come after setVisibleOnAllWorkspaces — the transform ' +
      'the latter performs resets sharingType, so protection applied first is lost',
    );
  });

  test('ready-to-show re-asserts protection on the preloaded window', () => {
    const helper = new ModelSelectorWindowHelper();
    helper.setContentProtection(true);
    helper.preloadWindow();
    calls.length = 0;

    // A preloaded window never reaches showWindow(), so ready-to-show is its
    // only chance to re-apply the flag on a window the compositor has actually
    // realized. (CropperWindowHelper.applyOpacityShield documents the hazard.)
    createdWindows[0]._ready();

    assert.deepEqual(protectionCalls(), [true]);
  });

  test('showWindow never transforms the app process type', async () => {
    for (const overlay of [true, false]) {
      calls.length = 0;
      createdWindows = [];
      const helper = makeReadyHelper({ undetectable: true, overlay });
      calls.length = 0;

      helper.showWindow(100, 200);

      const workspace = workspaceCalls();
      assert.ok(workspace.length > 0, 'showWindow must set the collection behavior');
      for (const [, , opts] of workspace) {
        assert.equal(
          opts?.skipTransformProcessType,
          true,
          `overlay=${overlay}: setVisibleOnAllWorkspaces must skip the process-type transform — ` +
          'it is the activation-policy flip that resets sharingType (and, launcher-anchored, ' +
          'puts the app back in the Dock while undetectable mode is on)',
        );
      }
      await sleep(REASSERT_WAIT_MS);
    }
  });

  test('protection is applied before the show and re-asserted after it', async () => {
    const helper = makeReadyHelper({ undetectable: true, overlay: false });
    calls.length = 0;

    helper.showWindow(100, 200);

    const showIdx = calls.findIndex(([m]) => m === 'show' || m === 'showInactive');
    const beforeShow = calls.slice(0, showIdx).filter(([m]) => m === 'setContentProtection');
    assert.deepEqual(
      beforeShow.map(([, v]) => v),
      [true],
      'the window must already be protected at the instant it becomes visible',
    );

    await sleep(REASSERT_WAIT_MS);
    assert.deepEqual(
      protectionCalls().at(-1),
      true,
      'and re-asserted once the OS has digested the show',
    );
  });

  test('protection survives a hide/show cycle', async () => {
    const helper = makeReadyHelper({ undetectable: true, overlay: false });
    helper.showWindow(100, 200);
    await sleep(REASSERT_WAIT_MS);

    helper.hideWindow();
    calls.length = 0;

    helper.showWindow(300, 400);
    await sleep(REASSERT_WAIT_MS);

    const applied = protectionCalls();
    assert.ok(applied.length > 0, 'reopening must re-apply the flag');
    assert.ok(
      applied.every((v) => v === true),
      `reopening must never push an unprotected state, got ${JSON.stringify(applied)}`,
    );
  });

  test('an overlay-anchored picker is protected even with undetectable mode off', async () => {
    const helper = makeReadyHelper({ undetectable: false, overlay: true });
    calls.length = 0;

    helper.showWindow(100, 200);
    await sleep(REASSERT_WAIT_MS);

    const applied = protectionCalls();
    assert.ok(applied.length > 0);
    assert.ok(
      applied.every((v) => v === true),
      'the picker is meeting chrome while it hangs off the overlay, and the overlay body / ' +
      'pill / toggle are protected unconditionally — a capturable dropdown on an ' +
      `uncapturable overlay is the same leak in a smaller window; got ${JSON.stringify(applied)}`,
    );
  });

  test('a launcher-anchored picker follows the undetectable toggle', async () => {
    const helper = makeReadyHelper({ undetectable: false, overlay: false });
    calls.length = 0;

    helper.showWindow(100, 200);
    await sleep(REASSERT_WAIT_MS);

    const applied = protectionCalls();
    assert.ok(applied.length > 0, 'showWindow must still push a state');
    assert.ok(
      applied.every((v) => v === false),
      'outside a meeting the picker follows the launcher, which follows the toggle',
    );
  });

  test('reassertContentProtection pushes the current state without a toggle', () => {
    const helper = makeReadyHelper({ undetectable: true, overlay: false });
    calls.length = 0;

    // Called by AppState after app.dock.hide()/show(), where the in-memory flag
    // is unchanged but the OS has dropped it.
    helper.reassertContentProtection();

    assert.deepEqual(protectionCalls(), [true]);
  });
});
