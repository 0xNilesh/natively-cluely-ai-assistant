## Summary

Version 2.6.0, the **"Massive Integration & Intelligence Update"**, brings revolutionary workflow capabilities to Natively. This release introduces Phone Link companion support, the specialized TinyPrompts™ engine for local AI, and native Codex CLI automation, making Natively the most powerful open-source meeting assistant available.

## What's New

- **Phone Link Integration**: Connect your iOS or Android device to use it as a wireless remote microphone or a companion screen. Keep your meeting notes and AI suggestions on your phone while maintaining a clean desktop for screen sharing.
- **TinyPrompts™ Engine**: A ground-up redesign of our prompt architecture specifically for "Lower Tier" Small Language Models (SLMs) like Qwen 2.5:4B and Llama 3.2. These prompts are under 800 tokens, use a strict imperative voice, and eliminate XML overhead to ensure high-performance reasoning on local consumer-grade hardware.
- **Codex CLI Integration**: Native support for the Codex terminal-based automation system. Harness the power of `gpt-5.3-codex` for sandboxed code execution, local workspace tasks, and complex automation directly from the assistant.
- **Auto-Calendar Sync**: Natively now securely connects to Google Calendar and Outlook to automatically prepared context, participant details, and agendas before your calls begin.
- **Speaker Identification (Diarization)**: Advanced real-time speaker tagging automatically identifies and labels individual speakers throughout your meeting transcripts.
- **Smart Task Sync**: Precision auto-extraction of action items with direct export support for Jira, Linear, and Asana boards.

## STT & Reliability Upgrades

- **Deepgram SDK v3 & Nova-3**: Complete migration to the latest Deepgram engine, resolving persistent 1006 connection loops and EPIPE errors.
- **Intelligent Failure Detection**: Introduced ElevenLabs "shadow probes" and a new STT silence watchdog that detects and recovers from silent provider failures in real-time.
- **Deepgram VAD Integration**: Leverages `SpeechStarted` events to eliminate false-positive silence detections during rapid conversations.

## Improvements

- **macOS Audio Capture**: Fixed CoreAudio Tap capture to correctly handle mono/stereo buffers, resolving the "pitched up" system audio bug.
- **Streaming Resilience**: Added `AbortController` propagation and 15s SSE heartbeats to prevent proxy timeouts during long AI reasoning tasks.
- **Expanded Offline Mode**: Now supports 100% offline transcription and note generation using specialized on-device SLMs.
- **Language Detection Tuning**: Improved batch detection confidence thresholds (0.65 min) to ignore background noise and silence.

## Fixes

- **STT Failover Logic**: Fixed cascading failures where session teardown codes were incorrectly counted as health strikes.
- **Trial System Persistence**: Resolved a bug where the "Start Trial" card would reappear after expiry.
- **Memory Optimization**: Fixed exponential pre-buffer growth during STT key rotations that previously caused SSL/TLS parameter errors.
- **Mic Activation**: Prevented the microphone from eagerly activating in settings, which triggered the macOS orange mic indicator unnecessarily.

## Technical

- **New `CodexCliService`**: Supports multiple sandbox modes (read-only, workspace-write, danger-full-access).
- **Optimized `tinyPrompts.ts`**: Imperative, context-efficient prompts designed for 4B-8B parameter local models.
- **Diarization Pipeline**: Real-time speaker mapping and session-scoped identity persistence.

## ⚠️macOS Installation (Unsigned Build)

Download the correct architecture .zip or .dmg file for your device (Apple Silicon or Intel).

If you see "App is damaged":
1. Move the app to your Applications folder.
2. Open Terminal and run: `xattr -cr /Applications/Natively.app`

- **For .dmg downloads:**
  1. Open Terminal and run:
     ```bash
     xattr -cr ~/Downloads/Natively-2.6.0-arm64.dmg
     # Or for Intel Macs:
     xattr -cr ~/Downloads/Natively-2.6.0-x64.dmg
     ```
  2. Install the natively.dmg
  3. Open Terminal and run: `xattr -cr /Applications/Natively.app`

## ⚠️Windows Installation (Unsigned Build)

When running the installer on Windows, you might see a "Windows protected your PC" warning. This is expected for unsigned builds. Click **More info** and then **Run anyway**.
