import { BrowserWindow, screen, app } from "electron"
import path from "node:path"
import { attachNoActivate } from "./utils/windowsFocusPolicy"

const isDev = process.env.NODE_ENV === "development"

const startUrl = isDev
    ? "http://localhost:5180"
    : `file://${path.join(app.getAppPath(), "dist/index.html")}`

import type { WindowHelper } from "./WindowHelper"

type WindowActivationOptions = {
    activate?: boolean
}

// Delay before the post-show re-assert of setContentProtection(). Matched to
// the 60ms the Windows opacity shield already waits for DWM in this file and in
// WindowHelper — long enough for WindowServer/DWM to have digested the show and
// any collection-behavior change, short enough that no realistic capture can
// land in the gap (a screenshot's own shutter latency is an order of magnitude
// larger). The pre-show apply is still the primary defence; this only catches
// the case where the OS re-evaluated the window after it.
const CONTENT_PROTECTION_REASSERT_MS = 60;

export class ModelSelectorWindowHelper {
    private window: BrowserWindow | null = null
    private contentProtection: boolean = false
    private opacityTimeout: NodeJS.Timeout | null = null;
    // Deferred re-assert of the sharingType flag. macOS applies several of the
    // window operations in showWindow() (collection-behavior changes, parenting,
    // the show itself) by handing them to WindowServer, which re-evaluates the
    // NSWindow on a LATER turn of the run loop — after the synchronous block
    // that called setContentProtection(). Pushing the flag a second time once
    // that settles is the same defence CropperWindowHelper's opacity shield
    // applies on Windows and AppState._enforceDockState applies after a
    // dock/activation-policy flip.
    private reassertTimeout: NodeJS.Timeout | null = null;

    constructor() { }

    private windowHelper: WindowHelper | null = null;

    // When opened from the MEETING OVERLAY: anchor stored relative to the
    // PANEL's left edge (the panel animates 600↔732 centered inside the
    // fixed overlay window) and the overlay's bottom edge, so the dropdown
    // follows drags, content-height growth, and the width spring. Driven by
    // WindowHelper.repositionOverlayPopovers().
    private overlayAnchor: { offsetXFromPanel: number; offsetY: number } | null = null;

    public setWindowHelper(wh: WindowHelper): void {
        this.windowHelper = wh;
    }

    public getWindow(): BrowserWindow | null {
        return this.window
    }

    public preloadWindow(): void {
        if (!this.window || this.window.isDestroyed()) {
            this.createWindow(-10000, -10000, false);
        }
    }

    public showWindow(x: number, y: number, options: WindowActivationOptions = {}): void {
        if (!this.window || this.window.isDestroyed()) {
            this.createWindow(x, y, true, options)
            return
        }

        const activate = options.activate ?? true;

        // Set parent and align window settings
        const mainWin = this.windowHelper?.getMainWindow();
        const isOverlay = mainWin === this.windowHelper?.getOverlayWindow();

        if (mainWin && !mainWin.isDestroyed()) {
            this.window.setParentWindow(mainWin);
        }

        if (process.platform === "darwin") {
            // Align with parent window behavior.
            //
            // skipTransformProcessType is LOAD-BEARING FOR STEALTH, not a
            // micro-optimisation. Without it Electron's macOS implementation
            // calls TransformProcessType() between UIElementApplication and
            // ForegroundApplication on EVERY call ("this will hide the window
            // and dock for a short time every time it is called" — Electron's
            // own docs for this option). That is the exact same
            // activation-policy flip as app.dock.hide()/show(), which
            // WindowHelper.reassertContentProtection() already documents as
            // making WindowServer re-evaluate each NSWindow and silently reset
            // its sharingType — dropping the NSWindowSharingNone that
            // setContentProtection(true) installed. Since this helper is the
            // only one that calls setVisibleOnAllWorkspaces on every SHOW
            // rather than once at creation, the picker was the one window that
            // reliably lost its capture exclusion and showed up in screenshots
            // while undetectable mode was on.
            //
            // Second, independent leak it closes: opening the picker from the
            // LAUNCHER passes visibleOnFullScreen=false, i.e.
            // kProcessTransformToForegroundApplication — which puts the app
            // back in the Dock even though undetectable mode had hidden it.
            //
            // The app's activation policy belongs to AppState's
            // undetectable/dock logic; a dropdown must never move it. Skipping
            // the transform still applies both collection-behavior bits
            // (CanJoinAllSpaces / FullScreenAuxiliary), which is the part that
            // actually governs over-fullscreen floating.
            this.window.setVisibleOnAllWorkspaces(isOverlay, {
                visibleOnFullScreen: isOverlay,
                skipTransformProcessType: true,
            });
            // Only set alwaysOnTop if the value is actually changing — calling it unnecessarily
            // triggers NSApp activation on macOS, stealing focus from other apps.
            const currentAlwaysOnTop = this.window.isAlwaysOnTop();
            if (currentAlwaysOnTop !== isOverlay) {
                this.window.setAlwaysOnTop(isOverlay, "floating");
            }
            // Always hide from MC as it's a dropdown
            this.window.setHiddenInMissionControl(true);
        }

        // Standard dropdown positioning
        this.window.setPosition(Math.round(x), Math.round(y))
        this.ensureVisibleOnScreen();

        // Overlay-anchored open: remember the panel-relative offset (see field
        // comment) and arm the click-outside catcher.
        if (isOverlay && mainWin && !mainWin.isDestroyed()) {
            const bounds = mainWin.getBounds();
            const margin = this.windowHelper?.getOverlayPanelLeftMargin?.() ?? 0;
            this.overlayAnchor = {
                offsetXFromPanel: x - bounds.x - margin,
                offsetY: y - (bounds.y + bounds.height),
            };
        } else {
            this.overlayAnchor = null;
        }
        this.windowHelper?.notifyOverlayPopover?.('model', this.overlayAnchor !== null);

        // Recomputed AFTER the overlayAnchor assignment above, so an
        // overlay-anchored open is already known to be protected chrome.
        const protect = this.resolveContentProtection();

        if (process.platform === 'win32' && protect) {
            this.window.setOpacity(0);
            if (activate) this.window.show(); else this.window.showInactive();
            this.window.setContentProtection(true);

            if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
            this.opacityTimeout = setTimeout(() => {
                if (this.window && !this.window.isDestroyed()) {
                    this.window.setOpacity(1);
                    if (activate) this.window.focus();
                }
            }, 60);
        } else {
            this.applyContentProtection();
            if (activate) this.window.show(); else this.window.showInactive();
            if (activate) this.window.focus();
        }

        // The window is on screen now. Push the flag once more after the
        // compositor has settled — see reassertTimeout for why a single
        // synchronous call before show() is not enough on macOS.
        this.scheduleContentProtectionReassert();
    }

    public hideWindow(): void {
        if (this.window && !this.window.isDestroyed()) {
            this.window.setParentWindow(null);
            this.window.hide();
            // Do NOT call mainWin.focus() here — the model selector is a floating dropdown.
            // Explicitly focusing the main window steals OS focus from whatever the user
            // had active (Zoom, browser, etc.) before opening the selector.
        }
        this.windowHelper?.notifyOverlayPopover?.('model', false);
    }

    // Overlay-anchored variant of positioning: x tracks the PANEL's left edge
    // (overlay.x + live margin), y tracks the overlay's bottom edge.
    public repositionForOverlay(overlayBounds: Electron.Rectangle, panelLeftMargin: number): void {
        if (!this.overlayAnchor) return;
        if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return;
        this.window.setPosition(
            Math.round(overlayBounds.x + panelLeftMargin + this.overlayAnchor.offsetXFromPanel),
            Math.round(overlayBounds.y + overlayBounds.height + this.overlayAnchor.offsetY),
        );
    }

    public toggleWindow(x: number, y: number, options: WindowActivationOptions = {}): void {
        if (this.window && !this.window.isDestroyed()) {
            if (this.window.isVisible()) {
                this.hideWindow()
            } else {
                this.showWindow(x, y, options)
            }
        } else {
            this.createWindow(x, y, true, options)
        }
    }

    public closeWindow(): void {
        this.hideWindow();
    }

    private createWindow(
        x?: number,
        y?: number,
        showWhenReady: boolean = true,
        showOptions: WindowActivationOptions = {},
    ): void {
        const isMac = process.platform === 'darwin';
        const windowSettings: Electron.BrowserWindowConstructorOptions = {
            width: 140,
            height: 200,
            frame: false,
            transparent: true,
            resizable: false,
            fullscreenable: false,
            hasShadow: false,
            alwaysOnTop: true,
            backgroundColor: "#00000000",
            show: false,
            skipTaskbar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, "preload.js"),
                backgroundThrottling: false
            },
            // ROUND 3 FIX: type:'panel' makes this an NSPanel rather than a
            // regular NSWindow. Required for becomesKeyOnlyIfNeeded and
            // _setPreventsActivation: SPI calls in applyStealthToWindow to
            // actually take effect (those are NSPanel-only properties).
            // Without this, the previous applyStealthToWindow call was a
            // no-op and clicking the model selector still stole focus from
            // the user's foreground app.
            //
            // Close-on-outside is handled by the renderer's mousedown
            // capture handler (NativelyInterface.tsx) dispatching the
            // `model-selector:close-if-open` IPC, guarded against the
            // toggle button via `data-model-selector-toggle`.
            ...(isMac ? { type: 'panel' as const } : {}),
        }

        if (x !== undefined && y !== undefined) {
            windowSettings.x = Math.round(x)
            windowSettings.y = Math.round(y)
        }

        this.window = new BrowserWindow(windowSettings)
        // Windows counterpart of the NSPanel stealth attributes applied below
        // on macOS: WS_EX_NOACTIVATE so clicking the model selector mid-meeting
        // never steals foreground focus from the meeting app. Dismissal is the
        // overlay popover click-catcher (blur-close is intentionally not wired
        // here). No-op on macOS/Linux.
        attachNoActivate(this.window)

        if (process.platform === "darwin") {
            // Initial defaults - will be updated in showWindow.
            // Same skipTransformProcessType reasoning as showWindow: this runs
            // during startup preload, when the launcher window already exists,
            // so a process-type transform here would reset ITS sharingType too.
            this.window.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
                skipTransformProcessType: true,
            })
            this.window.setHiddenInMissionControl(true)
        }

        // Apply content protection for Undetectable Mode. Ordered AFTER the
        // collection-behavior call above, matching SettingsWindowHelper — the
        // flag must be the LAST capture-relevant thing applied, never something
        // a later window-attribute change can invalidate.
        console.log(`[ModelSelectorWindowHelper] Creating window with Content Protection: ${this.resolveContentProtection()}`);
        this.applyContentProtection()

        // Load with query param for routing
        const url = isDev
            ? `${startUrl}?window=model-selector`
            : `${startUrl}?window=model-selector`

        this.window.loadURL(url).catch(e => {
            console.error('[ModelSelectorWindowHelper] Failed to load URL:', e);
        });

        this.window.once('ready-to-show', () => {
            // Apply NSPanel stealth attributes BEFORE any show() so clicking
            // the model selector on the Natively overlay doesn't activate
            // Natively and dim the user's foreground app (Zoom/browser) mid
            // meeting. Without this, model-switch was a regular focusable
            // window and every interaction stole focus. Failure non-fatal.
            //
            // NOTE: model selector also uses `on('blur')` to auto-close
            // (line below). With panel-nonactivating + becomesKeyOnlyIfNeeded,
            // blur semantics are subtle — the window may not become key on
            // click and therefore never receives blur. If that proves
            // problematic, the close-on-blur handler should switch to a
            // click-outside listener registered on the parent overlay.
            if (process.platform === 'darwin' && this.window && !this.window.isDestroyed()) {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const { loadNativeModule } = require('./audio/nativeModuleLoader');
                    const native = loadNativeModule();
                    if (native && typeof native.applyStealthToWindow === 'function') {
                        native.applyStealthToWindow(this.window.getNativeWindowHandle());
                    }
                } catch (e) {
                    console.error('[ModelSelectorWindowHelper] applyStealthToWindow failed:', e);
                }
            }
            // Re-assert now that the window is actually realized. The flag set
            // in createWindow() lands on a window the compositor has not seen
            // yet — the ordering hazard CropperWindowHelper.applyOpacityShield
            // documents ("if setContentProtection(true) is applied before the
            // window is fully 'ready' ... may ignore the flag"). This covers
            // the PRELOADED window, which never reaches showWindow() below.
            this.applyContentProtection();
            if (showWhenReady) {
                this.showWindow(
                    this.window?.getBounds().x || 0,
                    this.window?.getBounds().y || 0,
                    showOptions,
                )
            }
        })

        // Close-on-blur is intentionally NOT wired up here. A per-window
        // blur listener fires on intra-app focus transfers (overlay ↔ panel),
        // which races with the toggle button's open path and produced the
        // historical "first click does nothing, second click opens" bug.
        // Three orthogonal close paths cover the legitimate cases instead:
        //   • renderer mousedown capture handler in NativelyInterface.tsx
        //     dispatches `model-selector:close-if-open` for overlay-internal
        //     outside clicks (guarded by data-model-selector-toggle).
        //   • main.ts subscribes to app.on('did-resign-active') (macOS) /
        //     'browser-window-blur' + getFocusedWindow()===null (win/linux)
        //     to auto-close when the user clicks any other application.
        //   • clicking a model in the list explicitly hides the panel via
        //     the set-active-model IPC.

        // ROUND 3 FIX (#1): stop the stealth tap when Model Selector shows,
        // mirroring the Settings handler. While brief (model selector is a
        // dropdown), interaction with the dropdown still requires keystrokes
        // to reach this window's React tree, which the tap would otherwise
        // intercept at OS level.
        this.window.on('show', () => {
            // Belt-and-braces for show/hide cycles that do NOT come through
            // showWindow() (a parent-driven re-show, a restore after the
            // screenshot path hid us). Cheap, idempotent, and the alternative
            // is a visible dropdown with no capture exclusion.
            this.scheduleContentProtectionReassert();
            if (process.platform !== 'darwin') return;
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { StealthKeyboardManager } = require('./services/StealthKeyboardManager');
                StealthKeyboardManager.getInstance().stop();
            } catch (e) {
                console.error('[ModelSelectorWindowHelper] failed to stop stealth tap on show:', e);
            }
        });
    }

    private ensureVisibleOnScreen() {
        if (!this.window) return;
        const { x, y, width, height } = this.window.getBounds();
        const display = screen.getDisplayNearestPoint({ x, y });
        const bounds = display.workArea;

        let newX = x;
        let newY = y;

        // Keep within horizontal bounds
        if (x + width > bounds.x + bounds.width) {
            newX = bounds.x + bounds.width - width;
        }
        if (x < bounds.x) {
            newX = bounds.x;
        }

        // Keep within vertical bounds
        if (y + height > bounds.y + bounds.height) {
            newY = bounds.y + bounds.height - height;
        }
        if (y < bounds.y) {
            newY = bounds.y;
        }

        this.window.setPosition(newX, newY);
    }

    public setContentProtection(enable: boolean): void {
        // Dedupe: see WindowHelper.setContentProtection rationale — repeated
        // identical calls are common (toggle IPC fans out across helpers) and
        // produce DWM affinity churn on Windows.
        //
        // The guard deliberately does NOT short-circuit when the window is
        // absent: the picker is created lazily (preloadWindow / first open), so
        // a toggle that arrives before creation must still land on the field
        // for createWindow() to pick up.
        if (this.contentProtection === enable && this.window && !this.window.isDestroyed()) return;
        console.log(`[ModelSelectorWindowHelper] Setting content protection to: ${enable}`);
        this.contentProtection = enable;
        this.applyContentProtection();
    }

    // Force-reapply the current content-protection state, bypassing the dedupe
    // guard above. Called after app.dock.hide()/show() flips the macOS
    // activation policy, which can reset the window's sharingType even though
    // our in-memory flag is unchanged.
    public reassertContentProtection(): void {
        this.applyContentProtection();
    }

    public syncActivationPolicy(): void {
        if (process.platform !== 'win32') return;
        if (!this.window || this.window.isDestroyed()) return;
        this.applyContentProtection();
        if (this.window.isVisible()) {
            this.window.setOpacity(1);
        }
    }

    /**
     * The sharingType this window must have RIGHT NOW.
     *
     * `contentProtection` mirrors undetectable mode, but the picker is a
     * dropdown of whichever shell opened it. While it hangs off the MEETING
     * OVERLAY it IS overlay chrome — a ghost surface that must never appear in
     * a capture regardless of undetectable/dock mode, exactly like the overlay
     * body, pill and toggle (see WindowHelper.applyContentProtection for that
     * rule and why coupling it to undetectable mode was wrong there too).
     * Leaving the dropdown capturable while the overlay it visibly belongs to
     * is not is the same leak in a smaller window.
     *
     * Launcher-anchored, it follows the undetectable toggle like the launcher.
     */
    private resolveContentProtection(): boolean {
        return this.contentProtection || this.overlayAnchor !== null;
    }

    /** Push the resolved state to the OS. Safe to call with no window. */
    private applyContentProtection(): void {
        if (!this.window || this.window.isDestroyed()) return;
        this.window.setContentProtection(this.resolveContentProtection());
    }

    /**
     * Re-apply the flag once the current batch of window operations has been
     * digested by WindowServer/DWM. See the reassertTimeout field comment.
     * Idempotent and self-cancelling, so callers can fire it freely.
     */
    private scheduleContentProtectionReassert(): void {
        if (this.reassertTimeout) clearTimeout(this.reassertTimeout);
        this.reassertTimeout = setTimeout(() => {
            this.reassertTimeout = null;
            this.applyContentProtection();
        }, CONTENT_PROTECTION_REASSERT_MS);
    }
}
