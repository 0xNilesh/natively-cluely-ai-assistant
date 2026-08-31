// The SCK backend flag must survive a restart — and an unclean one (2026-08-31).
//
// It used to live in renderer localStorage under `useExperimentalSckBackend`.
// Chromium flushes localStorage lazily and Natively takes `render-process-gone`
// often enough that "enable SCK → crash → flag is gone" was reproducible in a
// single session. The revert is SILENT: the app falls back to the CoreAudio
// process tap, which returns zero-filled buffers on Bluetooth A2DP output and
// on the built-in speaker device (macOS 14.7.4), so capture looks perfectly
// healthy and transcribes nothing.
//
// These tests use a REAL settings.json in a temp userData dir and a REAL
// SettingsManager, restarted by dropping the process-wide singleton so the next
// getInstance() re-reads disk. Nothing about the persistence path is stubbed —
// including the atomic write+fsync+rename that is the reason settings.json
// survives what localStorage did not.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = (p) => path.join(__dirname, '../../../dist-electron/electron', p);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sck-backend-'));
const settingsPath = path.join(userData, 'settings.json');

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { isReady: () => true, getPath: () => userData, getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { SettingsManager } = require(dist('services/SettingsManager.js'));
// From source: .mjs helpers are bundled INTO their consumers by
// scripts/build-electron.js (esbuild entry points are .ts only), so there is no
// dist copy to import. Same convention as the audioDeviceSelection.mjs suite.
const {
  SCK_DEVICE_ID,
  planLegacySckFlagMigration,
  resolveSystemAudioBackend,
} = await import('../../audio/systemAudioBackend.mjs');

const SLOT = '__nativelySettingsManagerV1__';

/**
 * A restart. The singleton is anchored on globalThis (esbuild inlines this
 * module into 53 dist bundles); dropping it forces the next getInstance() to
 * construct fresh and re-read settings.json from disk — the same thing a
 * relaunch does.
 */
const restart = () => {
  delete globalThis[SLOT];
  SettingsManager.instance = undefined;
  return SettingsManager.getInstance();
};

const diskNow = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

beforeEach(() => { try { fs.rmSync(settingsPath, { force: true }); } catch { /* first run */ } });
after(() => { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('the setting survives a restart', () => {
  test('ScreenCaptureKit stays selected across a relaunch', () => {
    assert.equal(restart().setSystemAudioBackend('sck'), true);
    assert.equal(restart().getSystemAudioBackend(), 'sck',
      'this is the whole bug: the choice must still be there on the next launch');
  });

  test('CoreAudio stays selected across a relaunch', () => {
    // The opposite direction matters just as much — a user who deliberately
    // turned SCK off must not be flipped back on by the macOS 13+ default.
    assert.equal(restart().setSystemAudioBackend('coreaudio'), true);
    assert.equal(restart().getSystemAudioBackend(), 'coreaudio');
  });

  test('the value is on disk BEFORE the process could crash', () => {
    // localStorage lost writes because the flush was deferred. set() goes
    // through saveSettings(), which is write + fsync + rename — durable by the
    // time it returns, with no "clean shutdown" to wait for.
    restart().setSystemAudioBackend('sck');
    assert.equal(diskNow().systemAudioBackend, 'sck');
  });

  test('a hand-edited settings.json is honoured on the next launch', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ systemAudioBackend: 'sck' }, null, 2));
    assert.equal(restart().getSystemAudioBackend(), 'sck');
  });

  test('an untouched install reads as auto without writing anything', () => {
    const sm = restart();
    assert.equal(sm.getSystemAudioBackend(), 'auto');
    assert.equal(sm.getRawSystemAudioBackend(), undefined,
      'the key\'s absence is what makes the localStorage migration one-shot — '
      + 'nothing may write it speculatively');
    assert.equal(fs.existsSync(settingsPath), false);
  });

  test('unrelated settings are not disturbed', () => {
    const sm = restart();
    sm.set('localWhisperPerChannelEnabled', true);
    sm.setSystemAudioBackend('sck');
    const after = restart();
    assert.equal(after.get('localWhisperPerChannelEnabled'), true);
    assert.equal(after.getSystemAudioBackend(), 'sck');
  });

  test('an invalid backend is rejected instead of being persisted', () => {
    const sm = restart();
    assert.throws(() => sm.setSystemAudioBackend('screencapturekit'), /Invalid systemAudioBackend/);
    assert.equal(restart().getRawSystemAudioBackend(), undefined);
  });
});

describe('the localStorage → settings.json migration runs once', () => {
  // Mirrors the 'migrate-legacy-sck-flag' IPC handler: plan, then write through
  // the real SettingsManager. Running the real pair is the point — the plan
  // alone cannot show that the marker it depends on is actually persisted.
  const migrate = (legacyValue) => {
    const sm = SettingsManager.getInstance();
    const plan = planLegacySckFlagMigration(sm.getRawSystemAudioBackend(), legacyValue);
    if (plan.action === 'skip') return { migrated: false, reason: plan.reason };
    assert.equal(sm.setSystemAudioBackend(plan.setting), true);
    return { migrated: true, setting: plan.setting };
  };

  test('an existing SCK user keeps SCK', () => {
    restart();
    assert.deepEqual(migrate('true'), { migrated: true, setting: 'sck' });
    assert.equal(restart().getSystemAudioBackend(), 'sck');
  });

  test('an existing CoreAudio user keeps CoreAudio', () => {
    restart();
    assert.deepEqual(migrate('false'), { migrated: true, setting: 'coreaudio' });
    assert.equal(restart().getSystemAudioBackend(), 'coreaudio');
  });

  test('it is idempotent across restarts', () => {
    restart();
    assert.equal(migrate('true').migrated, true);
    // Re-run in the same session, then again after a relaunch. The renderer
    // clears the localStorage key on success, but that removeItem is subject to
    // the same lazy flush being fixed — so a leftover value must stay inert.
    assert.deepEqual(migrate('true'), { migrated: false, reason: 'already-migrated' });
    restart();
    assert.deepEqual(migrate('true'), { migrated: false, reason: 'already-migrated' });
    assert.equal(diskNow().systemAudioBackend, 'sck');
  });

  test('a stale legacy value cannot overturn a choice the user made later', () => {
    restart();
    migrate('true');
    restart().setSystemAudioBackend('coreaudio');
    restart();
    assert.deepEqual(migrate('true'), { migrated: false, reason: 'already-migrated' });
    assert.equal(restart().getSystemAudioBackend(), 'coreaudio');
  });

  test('a fresh install with no legacy key writes nothing and stays on auto', () => {
    restart();
    assert.deepEqual(migrate(null), { migrated: false, reason: 'no-legacy-value' });
    assert.equal(fs.existsSync(settingsPath), false);
    assert.equal(restart().getSystemAudioBackend(), 'auto');
  });
});

describe('the persisted setting picks the backend main actually uses', () => {
  const decide = (requestedOutputDeviceId) => resolveSystemAudioBackend({
    setting: SettingsManager.getInstance().getSystemAudioBackend(),
    platform: 'darwin',
    osRelease: '23.6.0',            // macOS 14.7.4 — the machine this was debugged on
    requestedOutputDeviceId,
  });

  test('a persisted "sck" reaches the Rust speaker module as the sentinel id', () => {
    restart().setSystemAudioBackend('sck');
    restart();
    const decision = decide(undefined);
    assert.equal(decision.backend, 'sck');
    assert.equal(decision.outputDeviceId, SCK_DEVICE_ID,
      'macos.rs only skips the CoreAudio tap when device_id === "sck"');
  });

  test('a persisted "coreaudio" leaves the output device untouched', () => {
    restart().setSystemAudioBackend('coreaudio');
    restart();
    const decision = decide('BlackHole 2ch');
    assert.equal(decision.backend, 'coreaudio');
    assert.equal(decision.outputDeviceId, 'BlackHole 2ch');
  });

  test('the default install resolves to ScreenCaptureKit on macOS 13+', () => {
    restart();
    assert.equal(decide(undefined).backend, 'sck');
  });
});

// The failure this whole change exists to end is a write that LOOKS like it
// worked. If settings.json cannot be written, the toggle must be told — the IPC
// handler turns a false return into 'settings_store_degraded' and the switch
// rolls back instead of showing a state disk never received.
//
// Its own userData dir: the permissions below make the directory unwritable,
// which the file-level beforeEach must not have to work around. Unix-only —
// chmod 0o000 does not produce EACCES on Windows, the same limitation as the
// existing SettingsDegradedStoreMutators suite.
describe('a degraded settings store is reported, not silently swallowed', {
  skip: process.platform === 'win32'
    ? 'chmod-based EACCES is not reproducible on Windows'
    : false,
}, () => {
  const degradedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'sck-degraded-'));
  const degradedSettingsPath = path.join(degradedUserData, 'settings.json');

  before(() => {
    fs.writeFileSync(degradedSettingsPath, '{ this is not json');
    fs.chmodSync(degradedSettingsPath, 0o000);   // real EACCES on read
    fs.chmodSync(degradedUserData, 0o500);       // no rename → quarantine fails too
    require.cache[electronPath].exports.app.getPath = () => degradedUserData;
  });
  after(() => {
    require.cache[electronPath].exports.app.getPath = () => userData;
    try { fs.chmodSync(degradedUserData, 0o700); } catch { /* best effort */ }
    try { fs.chmodSync(degradedSettingsPath, 0o600); } catch { /* best effort */ }
    try { fs.rmSync(degradedUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('setSystemAudioBackend returns false instead of a false success', () => {
    const sm = restart();
    assert.equal(sm.isDegraded(), true, 'precondition: the store really is degraded');
    assert.equal(sm.setSystemAudioBackend('sck'), false,
      'a refused write reported as success is how a setting silently reverts');
  });
});
