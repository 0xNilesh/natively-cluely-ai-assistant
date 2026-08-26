// ── Window-swap choreography, renderer half ─────────────────────────────────
//
// The main process owns WHEN each surface moves (electron/WindowHelper.ts,
// "WINDOWS MEETING-SWAP CHOREOGRAPHY"); this file owns HOW it looks. The split
// is deliberate: native window opacity and bounds are driven from a Node timer,
// which is not vsync-locked, so anything the user actually watches move belongs
// in the DOM where the compositor runs it. The main process keeps setOpacity
// binary — it is a content-protection shield, not an effect.
//
// Both installers are no-ops off Windows. macOS is untouched by design: it has
// no opacity shield to hide a pre-entrance state behind, and it presents a
// hidden window's last composited frame on show(), so arming an invisible
// state there risks a flash that cannot be verified from a Windows machine.
// The CSS is gated the same way (html[data-platform="win32"] in index.css), so
// this is belt-and-braces rather than the only gate.
//
// Nothing here touches React. These attributes live on <html> and drive #root,
// which exists from parse time — a component effect would arrive after the
// first painted frame, which is the exact frame that has to be right.

const OVERLAY_ATTR = 'data-overlay-enter';
const LAUNCHER_ATTR = 'data-launcher-transition';

// KEEP IN SYNC with src/index.css. Pinned by
// electron/services/__tests__/WindowsMeetingSwapChoreography2026_08_26.test.mjs.
const OVERLAY_ENTER_MS = 300;
const LAUNCHER_RECEDE_MS = 260;

// If 'play' never arrives, the overlay is parked at opacity 0 with nothing on
// screen — so the watchdog is a correctness backstop, not a nicety, and it is
// short on purpose. The real arm→play gap is the main process's 60 ms shield
// plus a sub-millisecond IPC hop; 150 ms is a wide margin over that and a far
// softer failure than staring at an empty overlay.
const PLAY_WATCHDOG_MS = 150;

// After the recede the launcher window is hidden, so this timer's own reset is
// invisible — it exists so the DOM converges on rest even if BOTH restore
// sends are lost. Firing it while the launcher is somehow still visible is
// also the correct outcome: that only happens on a start that never completed.
const RECEDE_SELF_HEAL_MS = LAUNCHER_RECEDE_MS + 500;

const isWindows = (): boolean =>
  document.documentElement.getAttribute('data-platform') === 'win32';

/**
 * Overlay group (shell + pill + toggle). Arms an invisible pre-entrance state
 * while the window is still behind the shield, then plays it the moment the
 * shield lifts.
 */
export function installOverlayEntrance(): void {
  if (!isWindows()) return;
  const root = document.documentElement;
  let watchdog: number | undefined;
  let cleanup: number | undefined;

  const rest = () => {
    window.clearTimeout(watchdog);
    window.clearTimeout(cleanup);
    // Removing the attribute rather than leaving it at "entering" drops the
    // transform, the transition and the will-change together. A lingering
    // transform on #root would keep it a containing block for every
    // position:fixed descendant (dropdowns, toasts) for the rest of the
    // meeting, and would quietly animate any future opacity change.
    root.removeAttribute(OVERLAY_ATTR);
  };

  const arm = () => {
    window.clearTimeout(cleanup);
    root.setAttribute(OVERLAY_ATTR, 'armed');
    // Force the armed state through style recalc NOW. If an arm and a play
    // ever land in the same task, Chromium would coalesce them into a single
    // computed-style change and run no transition at all — the overlay would
    // simply pop in. Reading a layout property makes the armed value the
    // transition's real starting point.
    void root.offsetWidth;
    window.clearTimeout(watchdog);
    watchdog = window.setTimeout(play, PLAY_WATCHDOG_MS);
  };

  const play = () => {
    window.clearTimeout(watchdog);
    // Only armed → entering. A stray play at rest must not restart the
    // animation on an overlay the user is already looking at.
    if (root.getAttribute(OVERLAY_ATTR) !== 'armed') return;
    root.setAttribute(OVERLAY_ATTR, 'entering');
    cleanup = window.setTimeout(rest, OVERLAY_ENTER_MS + 80);
  };

  window.electronAPI?.onOverlayTransition?.((phase) => {
    if (phase === 'arm') arm();
    else play();
  });

  // Second arming route. Not redundancy for a dropped message — the watchdog
  // covers that — but for a BUSY renderer. main.ts sends 'session-reset' to
  // the overlay before the swap begins, and the overlay's own handler for it
  // unmounts the previous meeting's whole React tree, which can hold the main
  // thread long enough that switchToOverlay's arm queues behind it. This
  // listener is registered here, before React mounts, so it runs FIRST in that
  // same dispatch and the pre-entrance state is committed ahead of the
  // teardown rather than behind it.
  //
  // It does not have to survive until the swap: on a slow start the watchdog
  // will have played it back to rest long before, and switchToOverlay's arm
  // re-arms from scratch. Both orderings are correct; this one is just the
  // cheapest insurance against the one moment the renderer is guaranteed busy.
  window.electronAPI?.onSessionReset?.(() => {
    if (root.getAttribute(OVERLAY_ATTR) === 'entering') return;
    arm();
  });
}

/**
 * Launcher. Recedes (scale + fade) so the window can be hidden out from under
 * a surface that is already gone, instead of cut at full opacity.
 */
export function installLauncherRecede(): void {
  if (!isWindows()) return;
  const root = document.documentElement;
  let selfHeal: number | undefined;

  const restore = () => {
    window.clearTimeout(selfHeal);
    // Instantaneous by construction: the CSS puts a transition ONLY on the
    // receding state, so dropping the attribute snaps back in one frame. That
    // matters because the restore usually lands while the window is hidden or
    // one frame before it is shown — an animated un-recede would be visible
    // as a zoom-in on a launcher that is supposed to have been sitting there
    // all along.
    root.removeAttribute(LAUNCHER_ATTR);
  };

  const recede = () => {
    root.setAttribute(LAUNCHER_ATTR, 'receding');
    window.clearTimeout(selfHeal);
    selfHeal = window.setTimeout(restore, RECEDE_SELF_HEAL_MS);
  };

  window.electronAPI?.onLauncherTransition?.((phase) => {
    if (phase === 'recede') recede();
    else restore();
  });
}
