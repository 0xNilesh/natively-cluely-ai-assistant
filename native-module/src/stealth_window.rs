//! Stealth-window attributes for the overlay BrowserWindow on macOS.
//!
//! Electron's `type: 'panel'` sets `NSWindowStyleMaskNonactivatingPanel`,
//! which is necessary but not sufficient for true Spotlight/Alfred-grade
//! stealth. This module applies the additional NSWindow properties Electron
//! does not expose:
//!
//!   • `becomesKeyOnlyIfNeeded = YES` — clicks on the panel only make it the
//!     key window if the click lands on a control that needs key (e.g. a text
//!     input). Clicks on buttons / surfaces do NOT promote the panel to key,
//!     which means the user's foreground app keeps key state and frontmost
//!     status everywhere observable (dock, menu bar, screen-share, focus
//!     followers). This is THE attribute that fixes "clicking any button on
//!     Natively dims my Zoom window."
//!
//!   • `hidesOnDeactivate = NO` — without this, macOS auto-hides the panel
//!     when another app activates. Combined with becomesKeyOnlyIfNeeded,
//!     this keeps the overlay continuously visible while the user types in
//!     other apps.
//!
//!   • `collectionBehavior` — joins all spaces, full-screen aux, ignores
//!     window cycling. The auxiliary flag is what lets the overlay render
//!     above other apps' fullscreen windows without us having to fullscreen.
//!
//! All work happens on the main thread (Electron is calling us from main).
//! No threadsafe-function plumbing needed; this is a one-shot setter.

#![cfg(target_os = "macos")]

use napi::bindgen_prelude::*;
use objc2::msg_send;
use objc2::runtime::{AnyObject, Sel};
use objc2::sel;

/// Apply stealth attributes to the BrowserWindow whose native handle is
/// passed in.
///
/// `handle` is the buffer returned by `BrowserWindow.getNativeWindowHandle()`.
/// On macOS that buffer contains a single pointer to the BrowserWindow's
/// content `NSView`. We dereference to the parent `NSWindow` and apply the
/// stealth attributes on it.
///
/// Returns `Ok(())` on success, `Err(...)` if the handle is malformed or the
/// view has no associated window (e.g. window destroyed mid-call).
#[napi]
pub fn apply_stealth_to_window(handle: Buffer) -> Result<()> {
    let bytes = handle.as_ref();

    // The handle buffer must be exactly one pointer wide. macOS arm64 + x64
    // are both 64-bit; we don't support 32-bit macOS.
    if bytes.len() != std::mem::size_of::<usize>() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "expected NSView handle of {} bytes, got {}",
                std::mem::size_of::<usize>(),
                bytes.len()
            ),
        ));
    }

    let view_ptr = usize::from_ne_bytes(
        bytes
            .try_into()
            .map_err(|_| Error::new(Status::InvalidArg, "handle slice → array conversion failed"))?,
    ) as *mut AnyObject;

    if view_ptr.is_null() {
        return Err(Error::new(Status::InvalidArg, "NSView pointer is null"));
    }

    // SAFETY:
    //   - Electron guarantees the view pointer outlives this call (the
    //     BrowserWindow we were called from owns it).
    //   - All msg_send! calls below dispatch to standard AppKit selectors;
    //     they cannot panic on a valid NSView/NSWindow.
    //   - We drop the raw window pointer immediately after the setters; we
    //     never store or share it across threads.
    unsafe {
        let window: *mut AnyObject = msg_send![view_ptr, window];
        if window.is_null() {
            return Err(Error::new(
                Status::GenericFailure,
                "NSView has no associated NSWindow (window destroyed?)",
            ));
        }

        let sel_set_becomes_key: Sel = sel!(setBecomesKeyOnlyIfNeeded:);
        let responds_to_becomes_key: bool = msg_send![window, respondsToSelector: sel_set_becomes_key];
        if responds_to_becomes_key {
            let _: () = msg_send![window, setBecomesKeyOnlyIfNeeded: true];
        }

        let sel_set_hides: Sel = sel!(setHidesOnDeactivate:);
        let responds_to_hides: bool = msg_send![window, respondsToSelector: sel_set_hides];
        if responds_to_hides {
            let _: () = msg_send![window, setHidesOnDeactivate: false];
        }

        // NSWindowCollectionBehavior bitmask values from
        // <AppKit/NSWindow.h>. Inlined as raw u64 to avoid pulling the full
        // enum binding for three constants.
        const CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
        const STATIONARY: u64 = 1 << 4;
        const FULL_SCREEN_AUXILIARY: u64 = 1 << 8;
        const IGNORES_CYCLE: u64 = 1 << 6;
        let behavior: u64 =
            CAN_JOIN_ALL_SPACES | STATIONARY | FULL_SCREEN_AUXILIARY | IGNORES_CYCLE;
        let _: () = msg_send![window, setCollectionBehavior: behavior];

        // Belt-and-braces: ensure the nonactivating panel style mask is set
        // even if Electron's `type: 'panel'` didn't apply it (defensive — we
        // saw cases where the mask was dropped during window-style updates).
        // NSWindowStyleMaskNonactivatingPanel = 1 << 7
        let current_mask: u64 = msg_send![window, styleMask];
        const NONACTIVATING_PANEL: u64 = 1 << 7;
        if current_mask & NONACTIVATING_PANEL == 0 {
            let _: () = msg_send![window, setStyleMask: current_mask | NONACTIVATING_PANEL];
        }
    }

    Ok(())
}
