export type MicStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export function classifyMicStatus(
  platform: string | undefined | null,
  status: MicStatus | string | undefined | null,
): { usable: boolean; remedy: 'none' | 'request' | 'settings' | 'policy' };

export function micSettingsUri(platform: string | undefined | null): string | null;

export function permissionPaneUri(
  platform: string | undefined | null,
  pane: 'microphone' | 'screen' | null | undefined,
): string | null;

export function permissionsNeedAttention(
  platform: string | undefined | null,
  microphone: string | undefined | null,
  screen: string | undefined | null,
): boolean;

export function openExternalAllows(
  platform: string | undefined | null,
  url: unknown,
): boolean;
