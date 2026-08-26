function normalizePlatform(p: string): string {
  if (p === 'darwin' || p.startsWith('mac')) return 'darwin';
  if (p === 'win32' || p.startsWith('win')) return 'win32';
  if (p.includes('linux')) return 'linux';
  return p;
}

const platform = normalizePlatform(
  window.electronAPI?.platform ?? navigator.platform?.toLowerCase() ?? ''
);

/**
 * The normalized NodeJS.Platform-style string for this renderer ('darwin' |
 * 'win32' | 'linux' | raw). Exported so callers that must pass a platform to a
 * shared policy helper (e.g. micSettingsUri in lib/micPermissionPolicy) use the
 * SAME detection as isMac/isWindows instead of re-deriving it from those
 * booleans with their own ternary — two spellings of one fact drift.
 */
export const currentPlatform = platform;

export const isMac = platform === 'darwin';
export const isWindows = platform === 'win32';
export const isLinux = platform === 'linux';

export function getModifierSymbol(modifier: 'commandorcontrol' | 'ctrl' | 'control' | 'cmd' | 'command' | 'meta' | 'alt' | 'option' | 'shift'): string {
    const m = modifier.toLowerCase();
    if (m === 'commandorcontrol' || m === 'cmd' || m === 'command' || m === 'meta' || m === 'ctrl' || m === 'control') {
        return isMac ? '⌘' : 'Ctrl';
    }
    if (m === 'alt' || m === 'option') {
        return isMac ? '⌥' : 'Alt';
    }
    if (m === 'shift') {
        return isMac ? '⇧' : 'Shift';
    }
    return modifier;
}

export function getPlatformShortcut(keys: string[]): string[] {
    return keys.map(key => {
        const k = key.toLowerCase();
        if (k === '⌘' || k === 'command' || k === 'meta' || k === 'cmd') {
            return isMac ? '⌘' : 'Ctrl';
        }
        if (k === '⌃' || k === 'control' || k === 'ctrl') {
            return isMac ? '⌃' : 'Ctrl';
        }
        if (k === '⌥' || k === 'option' || k === 'alt') {
            return isMac ? '⌥' : 'Alt';
        }
        if (k === '⇧' || k === 'shift') {
            return isMac ? '⇧' : 'Shift';
        }
        return key;
    });
}
