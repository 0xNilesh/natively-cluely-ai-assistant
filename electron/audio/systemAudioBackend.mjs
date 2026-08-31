/**
 * Pure system-audio backend selection, shared by the main-process audio
 * pipeline (main.ts), the settings IPC handlers and the node:test suite.
 *
 * Authored as .mjs + .d.mts (same pattern as audioDeviceSelection.mjs /
 * systemAudioHealthClassifier.mjs) so the tests import the REAL implementation
 * instead of asserting on main.ts source text.
 *
 * WHY THIS MODULE EXISTS
 *
 * The choice between the CoreAudio process tap and ScreenCaptureKit used to be
 * made in the RENDERER, from a `useExperimentalSckBackend` key in
 * `localStorage`, and was handed to main only as an `outputDeviceId` of "sck".
 * Two things were wrong with that:
 *
 *   1. Chromium flushes localStorage lazily. This app takes `render-process-gone`
 *      often enough that "enable SCK → crash → flag is gone" was reproducible,
 *      and the revert is SILENT: the CoreAudio tap then returns zero-filled
 *      buffers on Bluetooth A2DP output and on the built-in speaker device
 *      (macOS 14.7.4), so capture looks healthy and transcribes nothing.
 *      The decision now lives in settings.json via SettingsManager, which is
 *      written with write+fsync+rename and survives an unclean exit.
 *   2. The two `console.log` lines announcing the choice were renderer-side, so
 *      the main-process log — the one you get from stdout while debugging a
 *      live session — never said which backend was running.
 *
 * CROSS-PLATFORM: ScreenCaptureKit is macOS-only. It lives in the Rust speaker
 * module under `#[cfg(target_os = "macos")]`; Windows system audio runs through
 * WASAPI loopback, where "sck" is not a device id at all and routing it hands
 * the Windows backend an unknown device and silently breaks system audio
 * (issue #252 audit / F-003). Every entry point here therefore hard-gates on
 * `platform === 'darwin'` — there is no Windows branch to write, and none is
 * wanted.
 */

/** The three persisted values of the `systemAudioBackend` setting. */
export const SYSTEM_AUDIO_BACKEND_SETTINGS = Object.freeze(['auto', 'sck', 'coreaudio']);

/** Default when the setting is absent or unrecognised. */
export const DEFAULT_SYSTEM_AUDIO_BACKEND_SETTING = 'auto';

/**
 * Sentinel device id that tells the Rust speaker module to skip the CoreAudio
 * tap and go straight to ScreenCaptureKit. Matches the `force_sck` check in
 * native-module/src/speaker/macos.rs — keep the two in sync.
 */
export const SCK_DEVICE_ID = 'sck';

/**
 * The renderer localStorage key this setting was migrated OUT of. Read exactly
 * once per install by the migration below; see migrateLegacySckFlag().
 */
export const LEGACY_SCK_LOCAL_STORAGE_KEY = 'useExperimentalSckBackend';

/**
 * Darwin 22 === macOS 13 Ventura, the first release with
 * SCStreamConfiguration.capturesAudio. Below it, sck::SpeakerInput::new()
 * fails clean by design (see the OS gate in native-module/src/speaker/sck.rs),
 * so asking for SCK there only buys a failed construction and a fallback.
 *
 * Same constant, same derivation as the macOS 13 gates in
 * audio/whisper/modelManager.ts and services/LocalModelDownloadService.ts.
 */
export const SCK_MIN_DARWIN_MAJOR = 22;

/** Coerce anything to one of SYSTEM_AUDIO_BACKEND_SETTINGS. */
export function normalizeSystemAudioBackendSetting(value) {
  return SYSTEM_AUDIO_BACKEND_SETTINGS.includes(value)
    ? value
    : DEFAULT_SYSTEM_AUDIO_BACKEND_SETTING;
}

/**
 * Translate the legacy renderer flag into a setting value.
 *
 * Returns null for anything that is not a decision the user actually made —
 * absent key, empty string, junk — so the caller can tell "user had no
 * preference" apart from "user chose CoreAudio". Only 'true'/'false' are
 * produced by the old toggle; both are honoured verbatim, because a user who
 * deliberately left SCK OFF must not be flipped ON by the new default.
 */
export function legacySckFlagToSetting(raw) {
  if (raw === true || raw === 'true') return 'sck';
  if (raw === false || raw === 'false') return 'coreaudio';
  return null;
}

/** Darwin major version from os.release() ("23.6.0" → 23), or 0 if unparseable. */
export function darwinMajorFromRelease(osRelease) {
  const major = parseInt(String(osRelease ?? '').split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? 0 : major;
}

/** True when ScreenCaptureKit audio capture can work on this machine. */
export function isSckSupported({ platform, osRelease } = {}) {
  if (platform !== 'darwin') return false;
  return darwinMajorFromRelease(osRelease) >= SCK_MIN_DARWIN_MAJOR;
}

/**
 * Resolve the system-audio backend for one capture.
 *
 * @param setting                 persisted `systemAudioBackend` value
 * @param platform                process.platform
 * @param osRelease               os.release()
 * @param requestedOutputDeviceId the user's output-device choice, ALREADY
 *                                normalized (undefined === "system default")
 *
 * @returns {{ backend: 'sck'|'coreaudio', outputDeviceId: string|undefined, reason: string }}
 *   `outputDeviceId` is what to hand SystemAudioCapture: the SCK sentinel, or
 *   the caller's device id unchanged.
 *
 * PRECEDENCE
 *   1. Not macOS                         → coreaudio (SCK does not exist there).
 *   2. requestedOutputDeviceId === 'sck' → sck. Defensive: several internal
 *      callers re-enter reconfigureAudio with `_lastRequestedOutputDeviceId`,
 *      which is already the sentinel. Without this, "the user picked a device"
 *      would read true and the HFP mic auto-switch would silently drop a live
 *      meeting back onto CoreAudio mid-call.
 *   3. Explicit 'sck' / 'coreaudio'      → obeyed (SCK downgraded on macOS <13,
 *      where it cannot start at all).
 *   4. 'auto'                            → sck on macOS 13+, coreaudio below.
 *
 * WHY 'auto' IGNORES THE OUTPUT-DEVICE SELECTION
 * ScreenCaptureKit captures GLOBAL system audio and cannot tap one device (see
 * the device_id warning in sck.rs), so an earlier draft kept CoreAudio whenever
 * the user had explicitly picked an output device. That is backwards: macOS has
 * ONE active output route, so global capture is a superset of the device tap in
 * every ordinary setup — while the user who explicitly selects "MacBook Pro
 * Speakers" or their AirPods is precisely the user the CoreAudio tap returns
 * silence for. Protecting the rare virtual-cable case would have re-created the
 * silent-capture bug for the common one. Turning the toggle OFF is the explicit,
 * discoverable way to get a device-targeted tap back.
 */
export function resolveSystemAudioBackend({
  setting,
  platform,
  osRelease,
  requestedOutputDeviceId,
} = {}) {
  const coreAudio = (reason) => ({
    backend: 'coreaudio',
    outputDeviceId: requestedOutputDeviceId,
    reason,
  });
  const sck = (reason) => ({ backend: 'sck', outputDeviceId: SCK_DEVICE_ID, reason });

  if (platform !== 'darwin') return coreAudio('not-macos');

  if (requestedOutputDeviceId === SCK_DEVICE_ID) return sck('sck-device-id-requested');

  const supported = isSckSupported({ platform, osRelease });
  const normalized = normalizeSystemAudioBackendSetting(setting);

  if (normalized === 'coreaudio') return coreAudio('user-selected-coreaudio');
  if (normalized === 'sck') {
    return supported ? sck('user-selected-sck') : coreAudio('user-selected-sck-unsupported-macos');
  }

  if (!supported) return coreAudio('auto-unsupported-macos');
  return sck('auto-default-on-macos13+');
}

/**
 * Human-readable one-liner for the main-process log. The renderer used to print
 * this and nothing reached stdout; `[SpeakerInput] SCK backend explicitly
 * requested.` in macos.rs is the other half of the same story.
 */
export function describeSystemAudioBackend(decision) {
  const backend = decision?.backend === 'sck' ? 'ScreenCaptureKit' : 'CoreAudio Tap';
  return `${backend} (${decision?.reason ?? 'unknown'})`;
}

/**
 * One-shot migration of the legacy renderer flag into settings.json.
 *
 * IDEMPOTENT BY CONSTRUCTION: the presence of `systemAudioBackend` in
 * settings.json IS the marker. Once anything has written it — this migration,
 * or the user touching the toggle — every later run is a no-op, so a
 * localStorage value that outlives the migration (the renderer's removeItem is
 * subject to exactly the lazy-flush loss that motivated this whole change)
 * cannot resurrect a stale choice.
 *
 * A missing legacy value is also terminal for the migration in the sense that
 * matters: nothing is written, and the user simply gets the 'auto' default.
 * Re-running then is still a no-op, just a cheaper one.
 *
 * @param currentSetting the raw `systemAudioBackend` from settings.json
 * @param legacyValue    the raw localStorage value ('true' | 'false' | null)
 * @returns {{ action: 'write', setting: 'sck'|'coreaudio' } | { action: 'skip', reason: string }}
 */
export function planLegacySckFlagMigration(currentSetting, legacyValue) {
  if (currentSetting !== undefined && currentSetting !== null) {
    return { action: 'skip', reason: 'already-migrated' };
  }
  const setting = legacySckFlagToSetting(legacyValue);
  if (!setting) return { action: 'skip', reason: 'no-legacy-value' };
  return { action: 'write', setting };
}
