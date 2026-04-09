## Summary

Major update introducing Auto-Language Detection for STT, a revamped automated email ecosystem, and massive production hardening for the Natively API.

## What's New

- Auto-Language Detection feature for seamless on-the-fly language identification and transcription routing
- Three new premium HTML automated email templates for transaction and marketing events
- Complete visual redesign of emails featuring a "Vivid Editorial" theme with soft glass gradients

## Improvements

- The interface now accurately remembers the overlay window position and handles multi-monitor environments
- Screenshots are now dynamically compressed via sharp before API transmission to prevent 413 Payload Too Large limits
- Hardcoded Railway URLs were replaced with the primary canonical domain for maximal uptime

## Fixes

- Fixed a race condition that could cause double-billing on Deepgram failover reconnects
- Eradicated critical server bugs ranging from ungraceful Railway restarts to Groq rate-limit memory leaks
- Resolved multiple security vulnerabilities including cross-user session theft and input validation flaws

## Technical

- Shipped a comprehensive autonomous stress-testing suite simulating 30+ concurrent WebSocket connections
- Replaced Webhook logging arrays with optimized pre-allocated circular buffers to prevent memory exhaustion

## ⚠️macOS Installation (Unsigned Build)

Download the correct architecture .zip or .dmg file for your device (Apple Silicon or Intel).

If you see "App is damaged":

- **For .zip downloads:**
  1. Move the app to your Applications folder.
  2. Open Terminal and run: `xattr -cr /Applications/Natively.app`

- **For .dmg downloads:**
  1. Open Terminal and run:
     ```bash
     xattr -cr ~/Downloads/Natively-2.0.2-arm64.dmg
     # Or for Intel Macs:
     xattr -cr ~/Downloads/Natively-2.0.2-x64.dmg
     ```
  2. Install the natively.dmg
  3. Open Terminal and run: `xattr -cr /Applications/Natively.app`

## ⚠️Windows Installation (Unsigned Build)

When running the installer on Windows, you might see a "Windows protected your PC" warning from Microsoft Defender SmartScreen saying it prevented an unrecognized app from starting. 

Since this is an unsigned build, this is expected. You can safely ignore it by clicking **More info** and then **Run anyway**.

\ refer to changes.md for detailed changes
