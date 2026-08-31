export type SystemAudioBackendSetting = 'auto' | 'sck' | 'coreaudio';
export type SystemAudioBackend = 'sck' | 'coreaudio';

export interface SystemAudioBackendDecision {
  backend: SystemAudioBackend;
  /** What to pass to SystemAudioCapture: the SCK sentinel, or the caller's id. */
  outputDeviceId: string | undefined;
  reason: string;
}

export type LegacySckFlagMigrationPlan =
  | { action: 'write'; setting: Exclude<SystemAudioBackendSetting, 'auto'> }
  | { action: 'skip'; reason: string };

export const SYSTEM_AUDIO_BACKEND_SETTINGS: readonly SystemAudioBackendSetting[];
export const DEFAULT_SYSTEM_AUDIO_BACKEND_SETTING: SystemAudioBackendSetting;
export const SCK_DEVICE_ID: 'sck';
export const LEGACY_SCK_LOCAL_STORAGE_KEY: 'useExperimentalSckBackend';
export const SCK_MIN_DARWIN_MAJOR: number;

export function normalizeSystemAudioBackendSetting(value: unknown): SystemAudioBackendSetting;

export function legacySckFlagToSetting(
  raw: string | boolean | null | undefined,
): Exclude<SystemAudioBackendSetting, 'auto'> | null;

export function darwinMajorFromRelease(osRelease: string | null | undefined): number;

export function isSckSupported(input?: {
  platform?: string;
  osRelease?: string | null;
}): boolean;

export function resolveSystemAudioBackend(input?: {
  setting?: unknown;
  platform?: string;
  osRelease?: string | null;
  requestedOutputDeviceId?: string | undefined;
}): SystemAudioBackendDecision;

export function describeSystemAudioBackend(
  decision: SystemAudioBackendDecision | null | undefined,
): string;

export function planLegacySckFlagMigration(
  currentSetting: unknown,
  legacyValue: string | boolean | null | undefined,
): LegacySckFlagMigrationPlan;
