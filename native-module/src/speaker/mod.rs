// removed unused anyhow::Result

use std::sync::{Arc, Mutex};

/// Slot holding the first fatal error a capture backend reported asynchronously,
/// if any.
///
/// Written by a platform callback thread, taken by the DSP thread, which
/// forwards it to JS through the napi error callback. First-error-wins so a
/// storm of callbacks cannot spam the JS boundary.
///
/// This exists because ScreenCaptureKit's only channel for "your stream is
/// dead" is `SCStreamDelegate.stream:didStopWithError:`, and the stream used to
/// be created with a nil delegate — so when SCK stopped the stream mid-meeting
/// nothing in the process found out. Capture simply went quiet, with no error
/// and no log, until the whole meeting was restarted.
pub type CaptureErrSignal = Arc<Mutex<Option<String>>>;

#[cfg(target_os = "macos")]
mod core_audio;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
mod sck;
#[cfg(target_os = "macos")]
pub use macos::list_output_devices;
#[cfg(target_os = "macos")]
pub use macos::SpeakerInput;
#[cfg(target_os = "macos")]
pub use macos::SpeakerStream;
#[cfg(target_os = "macos")]
pub use sck::default_output_device_uid;

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "windows")]
pub use windows::list_output_devices;
#[cfg(target_os = "windows")]
pub use windows::SpeakerInput;
#[cfg(target_os = "windows")]
pub use windows::SpeakerStream;
#[cfg(target_os = "windows")]
pub use windows::default_output_device_uid;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub mod fallback {
    // Stub implementation for Linux (and any other unsupported platform).
    // The system-audio capture pipeline is macOS/Windows only — `new()` always
    // returns an error, so `stream()` / `pause()` etc. are never reached at
    // runtime. These stubs exist only so the rest of the crate (lib.rs) still
    // type-checks on Linux instead of failing with E0599 on `.stream()` calls.
    // See issue #219.
    use crate::audio_ring::AudioConsumer;
    use anyhow::Result;
    pub struct SpeakerInput;
    pub struct SpeakerStream;
    impl SpeakerInput {
        pub fn new(_device_id: Option<String>) -> Result<Self> {
            Err(anyhow::anyhow!("Unsupported platform: system audio capture is implemented for macOS and Windows only"))
        }
        pub fn stream(self) -> Result<SpeakerStream> {
            Err(anyhow::anyhow!("Unsupported platform"))
        }
        pub fn sample_rate(&self) -> u32 {
            unreachable!("SpeakerInput::new() always errors on this platform")
        }
        pub fn pause(&mut self) -> Result<()> {
            unreachable!("SpeakerInput::new() always errors on this platform")
        }
        pub fn resume(&mut self) -> Result<()> {
            unreachable!("SpeakerInput::new() always errors on this platform")
        }
    }
    impl SpeakerStream {
        pub fn sample_rate(&self) -> u32 {
            unreachable!("SpeakerStream is never constructed on this platform")
        }
        pub fn take_consumer(&mut self) -> Option<AudioConsumer> {
            unreachable!("SpeakerStream is never constructed on this platform")
        }
        pub fn err_signal(&self) -> Option<super::CaptureErrSignal> {
            unreachable!("SpeakerStream is never constructed on this platform")
        }
        pub fn pause(&mut self) {
            unreachable!("SpeakerStream is never constructed on this platform")
        }
        pub fn resume(&mut self) -> Result<()> {
            unreachable!("SpeakerStream is never constructed on this platform")
        }
    }

    pub fn list_output_devices() -> Result<Vec<(String, String)>> {
        Ok(Vec::new())
    }

    pub fn default_output_device_uid() -> String {
        String::new()
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use fallback::list_output_devices;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use fallback::SpeakerInput;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use fallback::SpeakerStream;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use fallback::default_output_device_uid;
