//! Session-wide stealth keyboard interception via CGEventTap.
//!
//! # What this is
//!
//! A CGEventTap is the macOS mechanism for sitting in the OS keyboard event
//! pipeline BEFORE events reach the foreground app. We use the session-level
//! tap (`kCGSessionEventTap`) so we see every keystroke routed through the
//! login session, regardless of which app would otherwise receive it. While
//! the tap is active, our callback decides whether to swallow each event
//! (return null → event is destroyed and never delivered) or pass it through
//! (return the event → normal delivery).
//!
//! # Why we want this on top of NSPanel-nonactivating
//!
//! NSPanel + becomesKeyOnlyIfNeeded already prevents Natively from activating
//! the app when buttons are clicked or the input is focused. But for keystrokes
//! to reach our text input via the normal DOM pipeline, the panel still has to
//! become the OS-level "key window" — which causes a window-level focus shift
//! that some screen-share / focus-follower tools can detect. With CGEventTap,
//! Natively NEVER becomes the key window for keyboard input. The user's Zoom
//! call stays the key window of the frontmost app; we silently siphon
//! keystrokes off the wire and present them in the renderer.
//!
//! # Activation model
//!
//! The tap is opt-in per session. Caller pattern:
//!
//!   1. User presses an activation hotkey (handled at the JS layer via
//!      globalShortcut, which fires before the session event tap so the
//!      hotkey itself is consumed by Carbon and not seen by us).
//!   2. JS calls `StealthKeyboardTap.start(callback)` to engage the tap.
//!   3. Every key event fires the callback with `{keyCode, chars, flags,
//!      isKeyDown}`. The event is SWALLOWED — the foreground app does not
//!      receive it.
//!   4. JS calls `stop()` to disengage (typically on Esc, hotkey-again, or
//!      blur-by-mouse).
//!
//! Swallowing is unconditional while the tap is active. Pass-through mode
//! defeats the purpose (foreground app would still receive everything; this
//! would just be a keylogger). Simpler and safer to gate the tap's lifetime
//! at the JS layer than to negotiate per-event suppression.
//!
//! # Permission requirements
//!
//! `CGEventTapCreate` returns NULL unless the process has Accessibility
//! trust (System Settings → Privacy & Security → Accessibility). On first
//! `start()` without permission, we surface a `false` return; the caller
//! should invoke `request_accessibility_permission()` to show the system
//! prompt. After the user grants in System Settings, the app must be
//! restarted (macOS does not retroactively grant tap rights to a running
//! process).
//!
//! # Threading
//!
//! `CFRunLoopRun` blocks the calling thread. We spawn a dedicated worker
//! thread, create the tap inside it, attach to that thread's runloop, and
//! block on `CFRunLoopRun()` until `stop()` is called. `stop()` calls
//! `CFRunLoopStop` from the main thread (CFRunLoop is documented as
//! thread-safe for stop), the worker thread unblocks, releases the tap,
//! and exits.
//!
//! Callbacks land on the worker thread; we use napi-rs's
//! `ThreadsafeFunction` to marshal each captured event back to V8.

#![cfg(target_os = "macos")]

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

use core_foundation::base::CFRelease;
use core_foundation::mach_port::{CFMachPortInvalidate, CFMachPortRef};
use core_foundation::runloop::{
    kCFRunLoopCommonModes, CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRef, CFRunLoopRun,
    CFRunLoopSourceRef, CFRunLoopStop,
};

// ─── ApplicationServices FFI for Accessibility permission ────────────────
//
// These are not exposed by core-graphics or objc2-app-kit. Smallest possible
// FFI surface: the `kAXTrustedCheckOptionPrompt` constant is a CFStringRef,
// but we use the prompt-less variant by passing NULL options and check first,
// then call once with `prompt: true` if untrusted. The `prompt: true` path
// requires building a CFDictionary, which we skip for simplicity by using the
// well-known undocumented behavior: passing NULL is equivalent to "check, do
// not prompt." For the actual prompt we use the system-wide preference URL
// scheme via NSWorkspace from the JS side (cleaner and doesn't require us to
// own a CFDictionary just for one bool).
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

// ─── Public N-API: permission helpers ────────────────────────────────────

/// True if this process has Accessibility trust (required for CGEventTap).
/// Cheap; safe to poll from JS to drive UI state.
#[napi]
pub fn is_accessibility_granted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

// ─── CGEvent FFI extras core-graphics doesn't wrap nicely ────────────────
//
// CGEventKeyboardGetUnicodeString is the One True Way to get the typed
// character for a key event (handles dead keys, IME composition pre-edit
// state, layout-dependent characters). core-graphics 0.24 exposes it as
// `CGEvent::keyboard_get_unicode_string` but the method allocates and copies;
// we call the C entrypoint directly to avoid the per-event Vec churn.
#[repr(C)]
#[derive(Copy, Clone)]
struct UniChar(u16);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventKeyboardGetUnicodeString(
        event: *mut c_void,
        max_string_length: usize,
        actual_string_length: *mut usize,
        unicode_string: *mut UniChar,
    );

    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void,
        user_info: *mut c_void,
    ) -> CFMachPortRef;

    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);

    fn CFMachPortCreateRunLoopSource(
        allocator: *mut c_void,
        port: CFMachPortRef,
        order: isize,
    ) -> CFRunLoopSourceRef;
}

// ─── Tap state shared across worker thread + JS handle ───────────────────

/// Wrapper around CFRunLoopRef so we can stash it in shared state. CFRunLoop
/// pointers are thread-safe for `CFRunLoopStop` per Apple documentation; we
/// only ever read this field from the JS thread to call stop, never to
/// drive the runloop.
struct RunLoopHandle(CFRunLoopRef);
unsafe impl Send for RunLoopHandle {}
unsafe impl Sync for RunLoopHandle {}

struct TapState {
    /// True while the worker thread is alive and the tap is engaged.
    active: AtomicBool,
    /// Set by the worker thread once the tap is created and the runloop is
    /// running. Cleared on stop. JS-thread reads this to call CFRunLoopStop.
    runloop: Mutex<Option<RunLoopHandle>>,
    /// Threadsafe callback into V8. Set on start(), cleared on stop(). The
    /// option indirection lets stop() drop the tsfn handle so JS can GC the
    /// closure without keeping the worker thread's strong ref alive past
    /// stop.
    callback: Mutex<Option<Arc<ThreadsafeFunction<CapturedKey>>>>,
}

/// Event payload delivered to the JS callback. Crossing the V8 boundary is
/// not free, so we keep this struct flat (no nested objects) and only include
/// fields the renderer actually needs.
#[napi(object)]
pub struct CapturedKey {
    /// HID virtual keycode (e.g. 36 = Return, 51 = Delete, 53 = Esc). Stable
    /// across keyboard layouts; use for shortcut detection (Esc → exit mode).
    pub key_code: u32,
    /// The characters this key would type, given the active keyboard layout
    /// and any held dead keys. Empty string for non-printable keys (Esc,
    /// arrows, modifiers alone). Multi-char for IME composition or
    /// surrogate pairs.
    pub chars: String,
    /// Raw CGEventFlags bitmask (cmd=1<<20, opt=1<<19, ctrl=1<<18,
    /// shift=1<<17, capsLock=1<<16, fn=1<<23). Renderer can decode without
    /// us pre-splitting into bools.
    pub flags: u32,
    /// True for keyDown, false for keyUp. flagsChanged events are converted
    /// to keyDown=true (modifier press) or keyDown=false (modifier release)
    /// by the worker.
    pub is_key_down: bool,
}

// ─── The C callback CGEventTap calls for every keystroke ─────────────────

/// CGEventTap callback. Called from the worker thread's runloop for every
/// key event. We:
///   1. Re-check the active flag (defensive — tap may fire one more event
///      after stop() invalidates the port).
///   2. Extract the keycode, modifier flags, and unicode chars.
///   3. Marshal to JS via the threadsafe function.
///   4. Return null to swallow the event (kCGEventTapOptionDefault honors
///      the null-return convention for deletion).
///
/// SAFETY:
///   - `user_info` is the `*const TapState` we passed to CGEventTapCreate;
///     CFMachPort retains it for the tap's lifetime, so it outlives every
///     callback invocation.
///   - `event` is owned by the runloop; we MUST NOT release it. Returning
///     a non-null pointer hands it back; returning null deletes it.
///   - We never block in this callback (no synchronous JS calls); the tsfn
///     queues onto the V8 thread and returns immediately.
extern "C" fn tap_callback(
    _proxy: *mut c_void,
    event_type: u32,
    event: *mut c_void,
    user_info: *mut c_void,
) -> *mut c_void {
    // CGEventType values: 10 = keyDown, 11 = keyUp, 12 = flagsChanged,
    // 0xFFFFFFFE = tapDisabledByTimeout, 0xFFFFFFFF = tapDisabledByUserInput.
    // The "disabled by timeout" event fires if our callback was too slow on a
    // prior call (>1s); we just re-enable and pass through.
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFFFFFF;

    if event_type == TAP_DISABLED_BY_TIMEOUT || event_type == TAP_DISABLED_BY_USER_INPUT {
        // The OS disabled our tap (most commonly: callback exceeded 1s budget).
        // Re-enable on the next loop iteration. We can't re-enable from inside
        // the callback synchronously without a port handle, but the next user
        // keystroke will go through anyway because the tap is disabled.
        // Returning the event is correct here — it means "pass through."
        return event;
    }

    // Re-check active flag to guard against post-stop callback fires.
    let state = unsafe { &*(user_info as *const TapState) };
    if !state.active.load(Ordering::Acquire) {
        // Pass the event through if we're shutting down — better to leak a
        // keystroke into the foreground app than to swallow one after the
        // user thinks stealth mode is off.
        return event;
    }

    // Extract keystroke metadata. CGEventField::KEYBOARD_EVENT_KEYCODE = 9.
    let key_code = unsafe { core_graphics_get_int_field(event, 9) } as u32;
    let flags = unsafe { core_graphics_get_flags(event) };

    // Pull unicode chars (handles layout, dead keys, IME). 8 UniChars is
    // enough for any single keystroke including surrogate pairs and IME
    // composition fragments; longer compositions would be unusual.
    let mut buf: [UniChar; 8] = [UniChar(0); 8];
    let mut actual_len: usize = 0;
    unsafe {
        CGEventKeyboardGetUnicodeString(event, buf.len(), &mut actual_len, buf.as_mut_ptr());
    }
    let chars: String = if actual_len == 0 {
        String::new()
    } else {
        let u16_slice: &[u16] =
            unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u16, actual_len) };
        String::from_utf16_lossy(u16_slice)
    };

    let is_key_down = match event_type {
        10 => true,                 // keyDown
        11 => false,                // keyUp
        12 => (flags & 0xFF00_0000) != 0, // flagsChanged → infer from flags presence
        _ => true,
    };

    let payload = CapturedKey {
        key_code,
        chars,
        flags,
        is_key_down,
    };

    // Forward to JS. Non-blocking; if the JS thread is overloaded, events
    // queue up. We deliberately do NOT drop events on backpressure — losing
    // a keystroke mid-typing is worse than a brief latency spike.
    if let Some(tsfn) = state.callback.lock().unwrap().as_ref() {
        tsfn.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
    }

    // Return null → swallow. Foreground app does not see this keystroke.
    ptr::null_mut()
}

// Tiny FFI shims for CGEvent accessors that core-graphics 0.24 wraps in
// types we can't easily use from inside an extern "C" callback without
// taking ownership. Pulling them in via `core-graphics-sys` would also work
// but adds a dep we don't need elsewhere.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    #[link_name = "CGEventGetIntegerValueField"]
    fn cge_get_int_field(event: *mut c_void, field: u32) -> i64;
    #[link_name = "CGEventGetFlags"]
    fn cge_get_flags(event: *mut c_void) -> u64;
}

#[inline]
unsafe fn core_graphics_get_int_field(event: *mut c_void, field: u32) -> i64 {
    cge_get_int_field(event, field)
}

#[inline]
unsafe fn core_graphics_get_flags(event: *mut c_void) -> u32 {
    // Flags fit in u32 in practice; high bits are reserved.
    cge_get_flags(event) as u32
}

// ─── Worker thread: owns the runloop while the tap is alive ──────────────

fn tap_worker(state: Arc<TapState>) {
    // Event mask: keyDown | keyUp | flagsChanged. CGEventMaskBit(t) = 1 << t.
    const EVENT_MASK: u64 = (1u64 << 10) | (1u64 << 11) | (1u64 << 12);

    // tap=kCGSessionEventTap(1), place=kCGHeadInsertEventTap(0),
    // options=kCGEventTapOptionDefault(0).
    let user_info = Arc::into_raw(state.clone()) as *mut c_void;
    let port: CFMachPortRef =
        unsafe { CGEventTapCreate(1, 0, 0, EVENT_MASK, tap_callback, user_info) };

    if port.is_null() {
        // CGEventTapCreate returned NULL → almost always Accessibility not
        // granted. Reclaim the Arc we leaked into user_info; the JS-side
        // active flag stays false, JS can re-poll.
        unsafe { Arc::from_raw(user_info as *const TapState) };
        state.active.store(false, Ordering::Release);
        eprintln!(
            "[keyboard_tap] CGEventTapCreate returned NULL — Accessibility \
             permission likely missing"
        );
        return;
    }

    // Attach the tap to this thread's runloop and enable it.
    let source: CFRunLoopSourceRef =
        unsafe { CFMachPortCreateRunLoopSource(ptr::null_mut(), port, 0) };
    let current_loop: CFRunLoopRef = unsafe { CFRunLoopGetCurrent() };
    unsafe { CFRunLoopAddSource(current_loop, source, kCFRunLoopCommonModes) };
    unsafe { CGEventTapEnable(port, true) };

    // Stash the runloop so stop() can wake us.
    *state.runloop.lock().unwrap() = Some(RunLoopHandle(current_loop));

    // Block until stop() calls CFRunLoopStop. CFRunLoopRun is the canonical
    // blocking call for this pattern; returns when the runloop is stopped.
    unsafe { CFRunLoopRun() };

    // ─── Cleanup: invalidate the port, release CF resources, drop our Arc.
    unsafe { CGEventTapEnable(port, false) };
    unsafe { CFMachPortInvalidate(port) };
    unsafe { CFRelease(source as *const c_void) };
    unsafe { CFRelease(port as *const c_void) };

    // Reclaim the Arc we leaked into the C user_info. If the active flag
    // was still true at this point (unusual — would mean the runloop exited
    // for another reason), we still flip it false so JS can re-start cleanly.
    state.runloop.lock().unwrap().take();
    state.active.store(false, Ordering::Release);
    drop(unsafe { Arc::from_raw(user_info as *const TapState) });
}

// ─── Public N-API: the tap handle JS holds ───────────────────────────────

#[napi]
pub struct StealthKeyboardTap {
    state: Arc<TapState>,
}

#[napi]
impl StealthKeyboardTap {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: Arc::new(TapState {
                active: AtomicBool::new(false),
                runloop: Mutex::new(None),
                callback: Mutex::new(None),
            }),
        }
    }

    /// Engage the tap. Every keystroke fires `callback` with the captured
    /// metadata; the foreground app does NOT receive the event.
    ///
    /// Returns:
    ///   - `true` if the tap engaged.
    ///   - `false` if Accessibility permission is missing. Call
    ///     `is_accessibility_granted()` and `request_accessibility_permission()`
    ///     to drive the user through System Settings, then restart the app.
    ///
    /// Idempotent: repeated `start()` calls while active are no-ops.
    #[napi]
    pub fn start(&self, callback: ThreadsafeFunction<CapturedKey>) -> Result<bool> {
        if !is_accessibility_granted() {
            return Ok(false);
        }
        if self.state.active.swap(true, Ordering::AcqRel) {
            return Ok(true);
        }
        *self.state.callback.lock().unwrap() = Some(Arc::new(callback));

        let state = self.state.clone();
        thread::Builder::new()
            .name("natively-keyboard-tap".into())
            .spawn(move || tap_worker(state))
            .map_err(|e| {
                self.state.active.store(false, Ordering::Release);
                Error::new(
                    Status::GenericFailure,
                    format!("failed to spawn tap worker thread: {e}"),
                )
            })?;

        Ok(true)
    }

    /// Disengage the tap. After this returns, the next keystroke will
    /// reach the foreground app normally. Safe to call multiple times.
    #[napi]
    pub fn stop(&self) {
        if !self.state.active.swap(false, Ordering::AcqRel) {
            return;
        }
        // Wake the worker thread out of CFRunLoopRun. CFRunLoopStop is
        // safe to call from any thread per Apple docs.
        if let Some(handle) = self.state.runloop.lock().unwrap().as_ref() {
            unsafe { CFRunLoopStop(handle.0) };
        }
        // Drop the JS callback handle so V8 can GC its closure.
        *self.state.callback.lock().unwrap() = None;
    }

    /// True while the tap is engaged. Use to drive UI state ("stealth
    /// typing" badge, mode indicator, etc.).
    #[napi(getter)]
    pub fn is_active(&self) -> bool {
        self.state.active.load(Ordering::Acquire)
    }
}

impl Default for StealthKeyboardTap {
    fn default() -> Self {
        Self::new()
    }
}
