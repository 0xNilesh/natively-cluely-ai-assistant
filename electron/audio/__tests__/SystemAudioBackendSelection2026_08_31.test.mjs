// Regression tests for the SCK backend flag that did not survive a restart
// (2026-08-31, v2.8.8).
//
// Chain: the CoreAudio-vs-ScreenCaptureKit choice lived in renderer
// localStorage as `useExperimentalSckBackend` and was handed to main only as an
// outputDeviceId of "sck". Chromium flushes localStorage lazily and this app
// takes `render-process-gone` often enough that "enable SCK → crash → flag
// gone" was reproducible. The revert is SILENT: the CoreAudio process tap
// returns zero-filled buffers on Bluetooth A2DP output and on the built-in
// speaker device (macOS 14.7.4), so capture looks healthy and transcribes
// nothing.
//
// These are behavioural tests against the real module — no source assertions.
// electron/audio/systemAudioBackend.mjs is the single choke point that
// main.ts's decideSystemAudioBackend(), the settings IPC handlers and the
// one-shot localStorage migration all share.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SYSTEM_AUDIO_BACKEND_SETTING,
  LEGACY_SCK_LOCAL_STORAGE_KEY,
  SCK_DEVICE_ID,
  SCK_MIN_DARWIN_MAJOR,
  SYSTEM_AUDIO_BACKEND_SETTINGS,
  darwinMajorFromRelease,
  describeSystemAudioBackend,
  isSckSupported,
  legacySckFlagToSetting,
  normalizeSystemAudioBackendSetting,
  planLegacySckFlagMigration,
  resolveSystemAudioBackend,
} from '../systemAudioBackend.mjs';

// The machine the silent-capture session was debugged on: macOS 14.7.4 is
// Darwin 23. macOS 13 Ventura (the first release with
// SCStreamConfiguration.capturesAudio) is Darwin 22; macOS 12 Monterey is 21.
const VENTURA = '22.6.0';
const SONOMA_14_7_4 = '23.6.0';
const MONTEREY = '21.6.0';

const onMac = (overrides = {}) => ({
  platform: 'darwin',
  osRelease: SONOMA_14_7_4,
  ...overrides,
});

describe('backend selection for each flag value', () => {
  test('an untouched install defaults to ScreenCaptureKit on macOS 13+', () => {
    const decision = resolveSystemAudioBackend(onMac({ setting: undefined }));
    assert.equal(decision.backend, 'sck');
    assert.equal(decision.outputDeviceId, SCK_DEVICE_ID,
      'the Rust speaker module only skips the CoreAudio tap when it is handed the "sck" sentinel');
  });

  test("'auto' resolves to ScreenCaptureKit on macOS 13+", () => {
    assert.equal(resolveSystemAudioBackend(onMac({ setting: 'auto' })).backend, 'sck');
    assert.equal(
      resolveSystemAudioBackend(onMac({ setting: 'auto', osRelease: VENTURA })).backend,
      'sck',
      'Ventura is the first release with SCStreamConfiguration.capturesAudio',
    );
  });

  test("'sck' forces ScreenCaptureKit and overrides an explicit output device", () => {
    const decision = resolveSystemAudioBackend(
      onMac({ setting: 'sck', requestedOutputDeviceId: 'BlackHole 2ch' }),
    );
    assert.equal(decision.backend, 'sck');
    assert.equal(decision.outputDeviceId, SCK_DEVICE_ID);
  });

  test("'coreaudio' forces the CoreAudio tap and preserves the device id", () => {
    const decision = resolveSystemAudioBackend(
      onMac({ setting: 'coreaudio', requestedOutputDeviceId: 'BlackHole 2ch' }),
    );
    assert.equal(decision.backend, 'coreaudio');
    assert.equal(decision.outputDeviceId, 'BlackHole 2ch');
  });

  test("'coreaudio' with no device selection stays on the default route", () => {
    const decision = resolveSystemAudioBackend(onMac({ setting: 'coreaudio' }));
    assert.equal(decision.backend, 'coreaudio');
    assert.equal(decision.outputDeviceId, undefined,
      'undefined is what main.normalizeDeviceId() means by "system default"; a literal '
      + '"default" string defeats the default-output watcher guard');
  });

  test('a junk persisted value falls back to the default rather than throwing', () => {
    const decision = resolveSystemAudioBackend(onMac({ setting: 'screencapturekit' }));
    assert.equal(decision.backend, 'sck', 'junk must resolve like "auto"');
    assert.equal(normalizeSystemAudioBackendSetting('screencapturekit'), DEFAULT_SYSTEM_AUDIO_BACKEND_SETTING);
    assert.equal(normalizeSystemAudioBackendSetting(undefined), 'auto');
    assert.equal(normalizeSystemAudioBackendSetting(null), 'auto');
    assert.equal(normalizeSystemAudioBackendSetting(true), 'auto');
  });
});

describe('the carve-outs that keep the new default honest', () => {
  test("'auto' still picks ScreenCaptureKit when an output device is selected", () => {
    // SCK captures GLOBAL system audio and cannot tap one device, so it is
    // tempting to keep CoreAudio here. That is backwards: macOS has ONE active
    // output route, so global capture is a superset in every ordinary setup —
    // while the user who explicitly selects their built-in speakers or AirPods
    // is exactly the user the CoreAudio tap returns silence for. Turning the
    // toggle OFF is the explicit way back to a device-targeted tap.
    const decision = resolveSystemAudioBackend(
      onMac({ setting: 'auto', requestedOutputDeviceId: 'BuiltInSpeakerDevice' }),
    );
    assert.equal(decision.backend, 'sck');
    assert.equal(decision.outputDeviceId, SCK_DEVICE_ID);
  });

  test('macOS 12 never gets ScreenCaptureKit, even when explicitly asked', () => {
    // sck::SpeakerInput::new() hard-errors below macOS 13 by design; asking for
    // it there buys a failed construction and a fallback, not a working capture.
    assert.equal(isSckSupported({ platform: 'darwin', osRelease: MONTEREY }), false);
    for (const setting of ['auto', 'sck']) {
      const decision = resolveSystemAudioBackend(
        onMac({ setting, osRelease: MONTEREY }),
      );
      assert.equal(decision.backend, 'coreaudio', `setting=${setting} on macOS 12`);
    }
  });

  test('Windows never gets ScreenCaptureKit, whatever the setting says', () => {
    // F-003 / issue #252: SCK lives under #[cfg(target_os = "macos")]. Routing
    // "sck" as an outputDeviceId hands the WASAPI backend an unknown device id
    // and silently breaks system audio. A settings.json copied across machines
    // is a real way for 'sck' to show up on Windows.
    for (const setting of ['auto', 'sck', 'coreaudio']) {
      const decision = resolveSystemAudioBackend({
        setting,
        platform: 'win32',
        osRelease: '10.0.22631',
        requestedOutputDeviceId: 'Speakers (Realtek)',
      });
      assert.equal(decision.backend, 'coreaudio', `setting=${setting} on win32`);
      assert.notEqual(decision.outputDeviceId, SCK_DEVICE_ID);
    }
    assert.equal(isSckSupported({ platform: 'win32', osRelease: '10.0.22631' }), false);
  });

  test('an already-resolved "sck" device id is honoured on re-entry', () => {
    // main.ts re-enters reconfigureAudio with _lastRequestedOutputDeviceId — the
    // sentinel — from the HFP mic auto-switch. Treating that as "user picked a
    // device" would drop a live meeting back onto CoreAudio mid-call, which is
    // the silent-capture failure all over again.
    const decision = resolveSystemAudioBackend(
      onMac({ setting: 'auto', requestedOutputDeviceId: SCK_DEVICE_ID }),
    );
    assert.equal(decision.backend, 'sck');
    assert.equal(decision.reason, 'sck-device-id-requested');
  });

  test('an unparseable os.release() is treated as unsupported, not as macOS 13+', () => {
    assert.equal(darwinMajorFromRelease(undefined), 0);
    assert.equal(darwinMajorFromRelease('not-a-version'), 0);
    assert.equal(darwinMajorFromRelease(SONOMA_14_7_4), 23);
    assert.equal(darwinMajorFromRelease(VENTURA), SCK_MIN_DARWIN_MAJOR);
    assert.equal(
      resolveSystemAudioBackend({ setting: 'auto', platform: 'darwin', osRelease: '' }).backend,
      'coreaudio',
    );
  });
});

describe('the localStorage → settings.json migration', () => {
  test('the legacy key name is preserved verbatim', () => {
    assert.equal(LEGACY_SCK_LOCAL_STORAGE_KEY, 'useExperimentalSckBackend',
      'renaming this orphans every existing user’s stored preference');
  });

  test('an explicit OFF is carried over as OFF, not silently flipped by the new default', () => {
    assert.equal(legacySckFlagToSetting('false'), 'coreaudio');
    assert.deepEqual(planLegacySckFlagMigration(undefined, 'false'), {
      action: 'write',
      setting: 'coreaudio',
    });
  });

  test('an explicit ON is carried over as ON', () => {
    assert.equal(legacySckFlagToSetting('true'), 'sck');
    assert.deepEqual(planLegacySckFlagMigration(undefined, 'true'), {
      action: 'write',
      setting: 'sck',
    });
  });

  test('no legacy value means nothing is written', () => {
    for (const legacy of [null, undefined, '', 'yes', '1']) {
      assert.equal(legacySckFlagToSetting(legacy), null, `legacy=${JSON.stringify(legacy)}`);
      assert.deepEqual(planLegacySckFlagMigration(undefined, legacy), {
        action: 'skip',
        reason: 'no-legacy-value',
      });
    }
  });

  test('it is idempotent: a second run cannot overwrite the stored value', () => {
    // The presence of `systemAudioBackend` in settings.json IS the marker.
    for (const stored of ['auto', 'sck', 'coreaudio']) {
      assert.deepEqual(planLegacySckFlagMigration(stored, 'true'), {
        action: 'skip',
        reason: 'already-migrated',
      });
    }
  });

  test('a stale localStorage value cannot overturn a later user choice', () => {
    // The renderer's removeItem is subject to the exact lazy flush being fixed,
    // so a leftover 'true' after the user turned SCK off must stay inert.
    assert.deepEqual(planLegacySckFlagMigration('coreaudio', 'true'), {
      action: 'skip',
      reason: 'already-migrated',
    });
  });
});

describe('the main-process log line', () => {
  test('names the backend and why it was chosen', () => {
    // The two console.log lines that announced this were renderer-side, so
    // stdout never said which backend was running while a live session was
    // being debugged.
    const sck = describeSystemAudioBackend(resolveSystemAudioBackend(onMac({ setting: 'auto' })));
    assert.match(sck, /ScreenCaptureKit/);
    assert.match(sck, /auto-default-on-macos13\+/);

    const coreaudio = describeSystemAudioBackend(
      resolveSystemAudioBackend(onMac({ setting: 'coreaudio' })),
    );
    assert.match(coreaudio, /CoreAudio Tap/);
    assert.match(coreaudio, /user-selected-coreaudio/);
  });
});

test('the persisted setting vocabulary is exactly the three documented values', () => {
  assert.deepEqual([...SYSTEM_AUDIO_BACKEND_SETTINGS], ['auto', 'sck', 'coreaudio']);
});
