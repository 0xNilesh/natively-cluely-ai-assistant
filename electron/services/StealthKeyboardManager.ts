import { BrowserWindow, shell, systemPreferences } from 'electron';
import type { CapturedKey } from '../audio/nativeModuleLoader';

/**
 * Lifecycle owner for the macOS CGEventTap. JS-side state machine for the
 * "stealth typing mode" that lets the user type into Natively without their
 * foreground app (Zoom, browser, etc.) ever losing key/frontmost status at
 * the OS level.
 *
 * # Activation
 *
 * `toggle()` flips between active and inactive. The activation hotkey
 * (Cmd/Ctrl+Shift+Space, registered via globalShortcut) calls toggle().
 * Carbon hotkey processing happens BEFORE the session event tap, so the
 * hotkey itself is consumed by globalShortcut and never reaches our tap —
 * meaning toggle() works cleanly without us special-casing the hotkey
 * keycode in the captured stream.
 *
 * # Captured-event flow
 *
 * Worker thread (in Rust) → ThreadsafeFunction → this manager's `onKey`
 * callback → broadcast `stealth-key-captured` IPC to the overlay window.
 * The renderer accumulates `chars` into the chat input value programmatically
 * (no DOM keyboard event ever fires on the panel — the input never has to
 * become focused).
 *
 * # Esc / Enter handling
 *
 * Esc (keyCode 53) and Cmd+Enter inside the captured stream auto-stop the
 * tap. We handle this in main rather than relying on the renderer to call
 * stop() because the renderer might be slow / unmounted, and a stuck tap
 * means the user's keystrokes vanish into the void.
 *
 * # Permission failure
 *
 * `start()` returns false if Accessibility is not granted. We surface this
 * to the renderer via `stealth-tap-state` ({active:false, error:'permission'})
 * and offer to open System Settings via the helper below.
 */
export class StealthKeyboardManager {
    private static instance: StealthKeyboardManager | null = null;

    private tap: any | null = null; // StealthKeyboardTap instance from native module
    private active = false;
    private nativeAvailable = false;

    private constructor() {
        this.tap = this.createTapInstance();
        this.nativeAvailable = this.tap !== null;
    }

    public static getInstance(): StealthKeyboardManager {
        if (!StealthKeyboardManager.instance) {
            StealthKeyboardManager.instance = new StealthKeyboardManager();
        }
        return StealthKeyboardManager.instance;
    }

    /** True if the native module shipped with stealth-tap support. */
    public isAvailable(): boolean {
        return this.nativeAvailable;
    }

    /** True if Accessibility is granted right now. */
    public isPermissionGranted(): boolean {
        if (process.platform !== 'darwin') return false;
        // Prefer Electron's systemPreferences (well-supported, no rebuild
        // required). Fall back to the native module's check if Electron's
        // API is unavailable in this version.
        try {
            return systemPreferences.isTrustedAccessibilityClient(false);
        } catch {
            return this.callNativePermissionCheck();
        }
    }

    /**
     * Trigger the macOS Accessibility prompt. Returns the current trust state
     * (almost always false on first call — user needs to grant in System
     * Settings, then restart the app for the tap to bind).
     */
    public requestPermission(): boolean {
        if (process.platform !== 'darwin') return false;
        try {
            // Pass true to surface the prompt. macOS shows the standard
            // "App would like to control your computer" dialog.
            return systemPreferences.isTrustedAccessibilityClient(true);
        } catch {
            return false;
        }
    }

    /** Open System Settings → Privacy & Security → Accessibility directly. */
    public openSettings(): void {
        if (process.platform !== 'darwin') return;
        // x-apple.systempreferences URL scheme: documented (mostly) and
        // stable across recent macOS versions. Falls back to the general
        // privacy pane if the deep link fails.
        Promise.resolve(
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
        ).catch(() =>
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security')
        );
    }

    /** True while the tap is engaged and capturing keystrokes. */
    public isActive(): boolean {
        return this.active;
    }

    /**
     * Engage the tap. Returns false if the native module isn't available
     * or Accessibility isn't granted; the renderer should drive the user
     * through the permission flow in that case.
     */
    public start(): boolean {
        if (!this.tap) return false;
        if (this.active) return true;

        const ok: boolean = this.tap.start((err: Error | null, ev: CapturedKey) => {
            if (err) {
                console.error('[StealthKeyboardManager] tap callback error:', err);
                return;
            }
            this.handleCapturedKey(ev);
        });

        if (!ok) {
            this.broadcastState({ active: false, reason: 'permission' });
            return false;
        }

        this.active = true;
        this.broadcastState({ active: true });
        return true;
    }

    /** Disengage the tap. Safe to call when inactive. */
    public stop(): void {
        if (!this.tap) return;
        if (!this.active) return;
        this.tap.stop();
        this.active = false;
        this.broadcastState({ active: false });
    }

    /** Toggle active state. Bound to the activation hotkey. */
    public toggle(): boolean {
        if (this.active) {
            this.stop();
            return false;
        }
        return this.start();
    }

    // ─── internals ───────────────────────────────────────────────────────

    private createTapInstance(): any | null {
        if (process.platform !== 'darwin') return null;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { loadNativeModule } = require('../audio/nativeModuleLoader');
            const native = loadNativeModule();
            if (!native) return null;
            const Ctor = native.StealthKeyboardTap;
            if (typeof Ctor !== 'function') {
                console.warn(
                    '[StealthKeyboardManager] StealthKeyboardTap constructor missing from native binary — rebuild with `npm run build:native` for stealth typing'
                );
                return null;
            }
            return new Ctor();
        } catch (e) {
            console.error('[StealthKeyboardManager] failed to instantiate native tap:', e);
            return null;
        }
    }

    private callNativePermissionCheck(): boolean {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { loadNativeModule } = require('../audio/nativeModuleLoader');
            const native = loadNativeModule();
            return typeof native?.isAccessibilityGranted === 'function'
                ? native.isAccessibilityGranted()
                : false;
        } catch {
            return false;
        }
    }

    private handleCapturedKey(ev: CapturedKey): void {
        // Auto-exit on Esc — even if the renderer is slow / unmounted, we
        // never want a stuck tap eating the user's keystrokes into the void.
        if (ev.isKeyDown && ev.keyCode === 53) {
            this.stop();
            this.broadcast('stealth-key-captured', ev); // let renderer also see it for UX
            return;
        }
        this.broadcast('stealth-key-captured', ev);
    }

    private broadcastState(state: { active: boolean; reason?: string }): void {
        this.broadcast('stealth-tap-state', state);
    }

    private broadcast(channel: string, payload: unknown): void {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send(channel, payload);
            }
        }
    }
}
