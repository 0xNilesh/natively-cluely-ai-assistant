import path from 'path';
import { app } from 'electron';

/**
 * Maps platform+arch to the NAPI-RS compiled binary name.
 * These filenames are produced by `npx napi build` in native-module/.
 * Naming convention: index.<platform>-<arch>-<abi>.node
 */
function getNativeBinaryName(): string {
    const { platform, arch } = process;
    const map: Record<string, Record<string, string>> = {
        win32:  { x64: 'index.win32-x64-msvc.node' },
        darwin: { x64: 'index.darwin-x64.node', arm64: 'index.darwin-arm64.node' },
        linux:  { x64: 'index.linux-x64-gnu.node', arm64: 'index.linux-arm64-gnu.node' },
    };
    return map[platform]?.[arch] ?? `index.${platform}-${arch}.node`;
}

// undefined = not yet attempted, null = attempted but failed, object = loaded
let cached: any = undefined;

/**
 * Loads the Rust native module directly from the .node binary file.
 *
 * We bypass `require('natively-audio')` intentionally. That approach relied on
 * npm creating a symlink from node_modules/natively-audio -> native-module/,
 * which breaks on Windows (Git Bash produces POSIX-style symlinks that Node
 * can't resolve). Loading the .node file directly avoids npm entirely.
 *
 * Candidate paths cover three scenarios:
 *   1. Development — app.getAppPath() returns the project root where
 *      native-module/index.*.node lives after `npm run build:native`.
 *   2. Development fallback — one level up, in case the app is launched
 *      from a subdirectory.
 *   3. Production (ASAR) — electron-builder packs the project into app.asar
 *      but unpacks .node files to app.asar.unpacked/ (configured via
 *      asarUnpack in package.json). Node's dlopen can load from there.
 *
 * The function returns null on failure rather than throwing, so the app
 * degrades gracefully (audio device enumeration returns empty arrays).
 */
export function loadNativeModule(): any {
    if (cached !== undefined) return cached;

    // app.getAppPath() works before app.ready, but guard against edge cases
    // (e.g., if this module is imported unusually early in the boot sequence)
    let appPath: string;
    try {
        appPath = app.getAppPath();
    } catch (e) {
        console.error('[nativeModuleLoader] app.getAppPath() not available:', e);
        cached = null;
        return null;
    }

    const binary = getNativeBinaryName();
    const candidates = [
        path.join(appPath, 'native-module', binary),
        path.join(appPath, '..', 'native-module', binary),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'native-module', binary),
    ];

    for (const filePath of candidates) {
        try {
            cached = require(filePath);
            return cached;
        } catch {}
    }

    console.error(`[nativeModuleLoader] Failed to load ${binary} from all paths`);
    cached = null;
    return null;
}
