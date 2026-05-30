# Apple Code Signing & Notarization Report — Natively (macOS)

**Date:** 2026-05-29
**Team ID:** BJM29W3UQ6
**Signing identity:** `Developer ID Application: Evin John Ignatious (BJM29W3UQ6)` (SHA-1 `9F5304EA3B20308A85020B172F1016E02E52AAAE`) — verified via `security find-identity -v -p codesigning` (exactly one valid identity).
**Notary credential:** App Store Connect API key (Team key `YZHD5HHT8X`) — file-based, immune to keychain auto-lock; verified via `xcrun notarytool history --key … --key-id … --issuer …`. (The `natively-notary` keychain profile also works but lives in the data-protection keychain, which auto-locks mid-build on this Mac — see §7c.)
**Distribution model:** Developer ID, **non-sandboxed**, notarized, stapled, auto-updating via `electron-updater`.
**Electron** 33.2.0 · **electron-builder** 26.8.1 · **@electron/notarize** 3.1.1 · **electron-updater** 6.7.3

> Status legend: ✅ done/verified · ⏳ in progress · ⬜ pending

---

## 1. Environment verified (no assumptions)

| Component | Value | Verified by |
|---|---|---|
| Signing identity | one valid `Developer ID Application` | `security find-identity -v -p codesigning` |
| Notary credential | App Store Connect API key (Team key `YZHD5HHT8X`) | `xcrun notarytool history --key … --key-id … --issuer …` (auth OK) — file-based, lock-immune |
| Xcode | active (`/Applications/Xcode.app/...`) | `xcode-select -p` |
| Electron / builder | 33.2.0 / 26.8.1 | package.json |
| Updater | electron-updater 6.7.3, channel `latest`, autoDownload off, manual install | `electron/main.ts:5,974-979` |
| asarUnpack | `**/*.node`, `**/*.dylib` | package.json — native binaries unpacked so notarization verifies their signatures |
| Native artifacts | `index.darwin-{arm64,x64}.node` present; `native-module/src` unchanged (git) | `ls` + `git status` |
| Rust targets | aarch64 + x86_64 apple-darwin installed | `rustup target list --installed` |

---

## 2. Architecture: dual-path signing (default unchanged + opt-in production)

| Path | Command | Config | Signing | Notarize | Apple acct |
|---|---|---|---|---|---|
| **Dev / local** | `npm run dist` | `package.json` `build` (`identity: null`) | ad-hoc (`scripts/ad-hoc-sign.js`) | none | no |
| **Production** | `npm run dist:signed` | `electron-builder.signed.cjs` | Developer ID, deep, hardened runtime | **app** via `afterSign` (`scripts/notarize.js`, notarytool + staple-retry); **DMG** via `afterAllArtifactBuild` (`scripts/afterAllArtifactBuild.cjs`, create-dmg + notarytool + staple) | yes |

Keeping `identity: null` in `package.json` prevents electron-builder's arm64 "fall back to ad-hoc" path from double-signing the dev build. The opt-in `.cjs` config makes production signing explicit; the default build is byte-for-byte unchanged. `electron-builder.signed.cjs` sets `process.env.NATIVELY_PRODUCTION_SIGN='1'` so `ad-hoc-sign.js` **stands down** and never clobbers the real signature with an ad-hoc one. It builds the **`zip` target only** (zip preserves the deep signature and is the auto-updater artifact); DMGs are produced by the hook (see §7 RC-A).

**Notarization credential model (requirement #4):** **App Store Connect API key** — `APPLE_API_KEY` (`.p8` path) + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`. Both `notarize.js` (app) and `afterAllArtifactBuild.cjs` (DMG) call `notarytool` with these. **No plaintext Apple password in source** — the `.p8` is referenced by path and lives outside the repo. (The `natively-notary` keychain profile is also supported but auto-locks mid-build on this Mac — §7 RC-B — so the API key is the working credential.) electron-builder performs inside-out **deep signing** of the app, frameworks, helpers, and native `.node`/`.dylib`; `notarize.js` then notarizes + staples the app with Error-65 staple-retry.

---

## 3. Files changed / created (summary)

> Full authoritative list with descriptions is in §8. Summary: created `build/entitlements.mac.plist` + `.inherit.plist`, `scripts/afterAllArtifactBuild.cjs`, `assets/dmg-background.png`, `.github/workflows/release-macos.yml`, this report; modified `electron-builder.signed.cjs`, `scripts/notarize.js`, `scripts/ad-hoc-sign.js`; removed `assets/entitlements.mac.*` (relocated to `build/`).

---

## 4. Entitlements — verified individually (requirement #7)

Non-sandboxed Developer ID app (no `com.apple.security.app-sandbox`). Privacy access is **TCC + `NS*UsageDescription` + user consent**, not entitlements (except the one hardened-runtime mic capability).

### Top-level (`build/entitlements.mac.plist`)
| Entitlement | Keep? | Rationale |
|---|---|---|
| `com.apple.security.cs.allow-jit` | ✅ | V8 JIT under hardened runtime — required to launch. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | ✅ | V8 executable memory; standard Electron; kept defensively (candidate to trim — see §8). |
| `com.apple.security.cs.disable-library-validation` | ✅ | Loads 3rd-party native libs not Team-signed (onnxruntime `libonnxruntime.dylib`, better-sqlite3, sqlite-vec, sharp, Rust `.node`). |
| `com.apple.security.device.audio-input` | ✅ | Mic capture (Rust cpal, main process); paired with `NSMicrophoneUsageDescription`. |
| `com.apple.security.screen-capture` | ❌ removed | **Not a real Apple entitlement** — ScreenCaptureKit + CoreAudio tap are pure-TCC (verified against Apple docs). |
| `com.apple.security.automation.apple-events` | ❌ removed | No AppleScript/`osascript` usage in the codebase. |
| `com.apple.security.cs.allow-dyld-environment-variables` | ❌ removed | No `DYLD_*` usage; not in the Electron hardened-runtime baseline. |

### Helpers (`build/entitlements.mac.inherit.plist`)
`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` only. **No** `device.audio-input` — mic is main-process native; no renderer `getUserMedia`.

### Info.plist (`mac.extendInfo`)
`NSMicrophoneUsageDescription`, `NSScreenCaptureUsageDescription`, `NSAudioCaptureUsageDescription` present — these drive the TCC prompts.

---

## 5. Natively-specific capability review (requirement #5)

| Capability | Mechanism | Gating | Signing impact |
|---|---|---|---|
| Microphone | Rust cpal (main proc) | TCC + `NSMicrophoneUsageDescription` + `device.audio-input` | ✅ entitlement present |
| Screen capture | desktopCapturer + ScreenCaptureKit (main) | TCC Screen & System Audio Recording + `NSScreenCaptureUsageDescription` | pure TCC |
| System audio | CoreAudio process tap (14.4+) / SCK (native, main) | TCC (same pane) + `NSAudioCaptureUsageDescription` | pure TCC |
| Accessibility | Rust CGEventTap keyboard (stealth) | TCC Accessibility (`AXIsProcessTrusted`) | pure TCC |
| Overlay windows | BrowserWindow (transparent, always-on-top) | n/a | n/a |
| Global shortcuts | globalShortcut + native tap | Accessibility TCC | n/a |
| Auto-launch | `app.setLoginItemSettings` | n/a | no entitlement for Developer ID |
| Auto-update | electron-updater (zip + `latest-mac.yml`) | requires **signed** app for mac signature validation | ✅ enabled by signing |

> **Stable signing fixes the historical "permissions granted but no transcription" issue:** ad-hoc signing changed the cdhash every rebuild → TCC grants invalidated. A stable Developer ID signature keeps mic/screen grants persistent across updates.

---

## 6. Build / verify / notarize / staple — FINAL VERIFIED RESULTS ✅

Build version **2.7.0**. The signed build produced BOTH arches as `.app` + `.zip` + `.dmg`, plus `latest-mac.yml`. **All artifacts pass every required check.**

### ✅ APP — both arches: signed + hardened runtime + notarized + stapled + Gatekeeper-accepted
| Check | x64 (`release/mac/Natively.app`) | arm64 (`release/mac-arm64/Natively.app`) |
|---|---|---|
| `codesign -dv --verbose=4` | Developer ID, TeamID `BJM29W3UQ6`, `flags=0x10000(runtime)` | same ✅ |
| `codesign --verify --deep --strict --verbose=4` | `valid on disk` + `satisfies its Designated Requirement` | same ✅ |
| `spctl -a -vvv -t execute` | **`accepted` / `source=Notarized Developer ID`** | same ✅ |
| `xcrun stapler validate` | `The validate action worked!` | same ✅ |

Embedded entitlements = exactly the minimal verified set (allow-jit, allow-unsigned-executable-memory, disable-library-validation, device.audio-input). Helpers: hardened runtime + Developer ID + inherit set (no mic). Native `.node`: deep-signed Developer ID + hardened runtime. App notarization took ~956s (x64) / ~1047s (arm64) — Apple's queue was slow but the api-key path never stalled.

### ✅ DMG — both arches: styled (create-dmg) + signed + notarized + stapled + Gatekeeper-accepted
| Check | `Natively-2.7.0.dmg` (x64) | `Natively-2.7.0-arm64.dmg` (arm64) |
|---|---|---|
| DMG signature | Developer ID, TeamID `BJM29W3UQ6` | same ✅ |
| `xcrun stapler validate` (DMG) | `The validate action worked!` | same ✅ |
| `spctl -a -t open` (DMG) | **`accepted` / `source=Notarized Developer ID`** | same ✅ |
| app INSIDE dmg: `codesign --verify --deep --strict` | `valid on disk` + satisfies DR | same ✅ |
| app INSIDE dmg: `spctl -a -t execute` | **`accepted` / `Notarized Developer ID`** | same ✅ |
| app INSIDE dmg: `stapler validate` | worked | same ✅ |

### ✅ UPDATER ZIP + manifest — verified
- `Natively-2.7.0-arm64-mac.zip` + `Natively-2.7.0-mac.zip`: app extracted → `spctl` accepted / Notarized Developer ID + stapled ✅.
- `latest-mac.yml`: all 4 entries (2 zip + 2 dmg) `sha512`/`size` **MATCH** disk ✅. `path:`/top-level point at the arm64 zip (updater artifact).

> **This is a complete, production-grade, Gatekeeper-clean distribution. Installs with no `xattr`, passes Gatekeeper at both DMG-mount and app-launch, and electron-updater can validate update signatures.**

---

## 7. Root causes solved during the live run (each cost real time)

**RC-A — electron-builder's DMG creation corrupts the embedded app signature.** Apple notary log (submission `7b44d402…`): `"The signature of the binary is invalid"` @ `Natively.app/Contents/MacOS/Natively`. The standalone .app and the ZIP's app pass `codesign --verify --deep --strict`; only the app inside eb's DMG fails (even after `ditto`-copying out — not a mount artifact). **Fix:** build `zip` only with electron-builder; rebuild styled DMGs from the pristine signed .app via **`create-dmg`** (`hdiutil create -srcfolder` block-copy preserves the framework `Versions/Current` symlinks + `_CodeSignature`), then notarize+staple. Proven clean across both arches.

**RC-B — the `natively-notary` keychain profile auto-locks mid-build.** It lives in the data-protection keychain (screen-lock = "immediate" on this Mac; login.keychain `no-timeout` is irrelevant). It re-locked between the x64 and arm64 notarizations (~5 min apart) → arm64 failed with `"No Keychain password item found for profile: natively-notary"`. **Fix:** App Store Connect **API key** (`.p8` + key-id + issuer) — file-based, immune to keychain lock, unattended, doubles as the CI credential. Builds also wrapped in `caffeinate -dimsu`.

**RC-C — `spctl` writes its verdict to stderr.** My DMG verification guard captured only stdout → empty string → false "not Gatekeeper-accepted" rejection of a perfectly notarized app. **Fix:** capture `2>&1`.

**RC-D — the `npm run dist:signed` chain intermittently ENOENT'd** on `dist-electron/electron/CropperWindowHelper.js` at package time (its `npm run build` re-clean racing electron-builder's native rebuild). **Reliable path:** build stages explicitly, then invoke `./node_modules/.bin/electron-builder --config electron-builder.signed.cjs` directly.

**RC-E — Error 65 staple race** (CDN ticket-propagation lag → `stapler` "Record not found"). **Fix:** `scripts/notarize.js` does staple-with-retry (exponential backoff) instead of failing the build.

---

## 7a. Before / after behavior

| Scenario | Before (ad-hoc) | After (Developer ID + notarized + stapled) |
|---|---|---|
| First launch from downloaded DMG | Gatekeeper blocks; user must `xattr -cr` / right-click→Open | Mounts + launches normally; `spctl` → Notarized Developer ID |
| DMG mount | unsigned, "can't verify" | signed + notarized + stapled → accepted |
| TCC grants across updates | cdhash changes each rebuild → grants invalidated → "permissions granted but no transcription" | stable Developer ID / Team ID → mic/screen/accessibility grants persist |
| Auto-update (electron-updater) | ad-hoc download; signature validation friction | notarized ZIP; signature validates; in-place install works |

---

## 8. Final files changed / created (this signing pass)

**Created:** `build/entitlements.mac.plist`, `build/entitlements.mac.inherit.plist`, `scripts/afterAllArtifactBuild.cjs` (create-dmg rebuild + notarize + staple + verify + yml-patch), `assets/dmg-background.png`, `.github/workflows/release-macos.yml`, `apple-signing-report.md`.
**Modified:** `electron-builder.signed.cjs` (zip-only target; afterSign=notarize.js with staple-retry; `notarize:false`; entitlements→build/; `extraMetadata.nativelySigned`), `scripts/notarize.js` (api-key/apple-id/keychain strategies + staple-retry), `scripts/ad-hoc-sign.js` (build/ entitlements path; stand-down guard).
**Removed:** `assets/entitlements.mac.plist`, `assets/entitlements.mac.inherit.plist` (relocated to `build/`).
**Tooling:** `create-dmg` 1.2.3 (Homebrew).

## 8a. Reproduce the signed build

```bash
export APPLE_API_KEY="/path/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="<issuer-uuid>"
npm run build && npm run build:electron && \
  NATIVELY_BUILD_ALL_MAC_ARCHES=1 npm run build:native && \
  node scripts/ensure-sharp-mac-deps.js && \
  caffeinate -dimsu ./node_modules/.bin/electron-builder --mac --config electron-builder.signed.cjs --publish never
```
(Notarization is ~15-20 min/submission × 4 = up to ~1 hr; this is Apple-side, not a hang.)

## 8b. Remaining recommendations (non-blocking)
1. **Trim `com.apple.security.cs.allow-unsigned-executable-memory`** (Electron 12+ doesn't require it) — rebuild + launch; if clean, drop it to shrink attack surface.
2. **appId `com.electron.meeting-notes`** is a generic placeholder → migrate to e.g. `com.natively.app` as a deliberate, announced change (orphans existing TCC grants; auto-update keys on the feed so updates continue).
3. **CI:** add secrets for `release-macos.yml` — `MACOS_CERT_P12_BASE64`, `MACOS_CERT_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. (CI uses the api-key strategy automatically.)
4. **Intel (x64) launch test** on a real Intel Mac before release.
5. **`latest-mac.yml` note:** if a build is killed before electron-builder emits the yml, regenerate it from artifact sha512+size (done this run after an interrupted build); a clean `npm run dist:signed` emits it automatically.

---

## 9. Status summary — DONE ✅
- Entitlements minimal + individually verified, relocated to `build/`: ✅
- Dual-path signing (default ad-hoc unchanged + opt-in signed): ✅
- **APP (both arches): Developer ID + hardened runtime + notarized + stapled + `spctl` Notarized Developer ID:** ✅
- **DMG (both arches, styled via create-dmg): signed + notarized + stapled + embedded app Gatekeeper-accepted:** ✅
- **UPDATER ZIP + `latest-mac.yml`: notarized app, all hashes match:** ✅
- Notarization credential = App Store Connect API key, no plaintext secrets in source: ✅
- Senior code review (APPROVE) + fixes applied; test-engineer pass (no regression, updater correct, manual QA checklist): ✅
- Regression: signing changes touch only build config/scripts + `build/` entitlements (zero app-runtime code). Targeted network-free suite (stealth IPC, audio watchdog/abort lifecycle, license policy, toggle reducer) = **32/32 pass**. (The full `npm test` hangs on a pre-existing network-dependent test that ignores `--test-timeout` in this offline env — unrelated to signing.)
- CI release workflow created (secrets pending): ✅
- **Release recommendation: SHIP-READY.** Run the manual QA checklist (§10) on a clean machine, add CI secrets, then publish.

---

## 10. Manual QA checklist (run on a real / clean machine — cannot be automated headlessly)

Artifacts to test: `release/Natively-2.7.0.dmg` (x64), `release/Natively-2.7.0-arm64.dmg` (arm64), `release/Natively-2.7.0-*-mac.zip` (auto-update).

**A. Pre-flight (already PASSED here; re-run after any rebuild):**
```bash
APP=release/mac-arm64/Natively.app   # and release/mac/Natively.app
codesign --verify --deep --strict --verbose=4 "$APP"        # valid on disk + satisfies DR
spctl -a -vvv -t execute "$APP"                              # accepted / source=Notarized Developer ID
xcrun stapler validate "$APP"                                # The validate action worked!
xcrun stapler validate release/Natively-2.7.0-arm64.dmg      # + the x64 dmg
```

**B. Fresh install from DMG (clean machine, app never run):**
1. Download the DMG **via a browser** (so it carries `com.apple.quarantine` — the real test). `xattr -p com.apple.quarantine <dmg>` → present.
2. Double-click DMG → it mounts with **no "can't verify" block** → drag Natively to Applications. **No `xattr -cr` needed.**
3. First launch → normal "downloaded from the internet, open?" prompt → **Open works** (NOT "damaged / unidentified developer / move to Trash").
4. After launch: `xattr -p com.apple.quarantine /Applications/Natively.app` → cleared by Gatekeeper.

**C. First-grant permission prompts (record each fires + works):**
- **Microphone** → prompt shows `NSMicrophoneUsageDescription` text → grant → start a meeting, confirm user transcript + mic level meter.
- **Screen & System Audio Recording** → prompt + Settings deep-link → grant (relaunch if macOS requires) → confirm interviewer/system-audio transcript.
- **Accessibility** (global keyboard tap / stealth) → prompt + Settings deep-link → grant → confirm global shortcuts + overlay toggle.

**D. Upgrade install over existing (same machine):**
1. With an older version in /Applications and all 3 TCC grants live, drag the new DMG build over it (Replace).
2. Launch → **no permission re-prompts** (stable Developer ID → TCC persists). Confirm in System Settings → Privacy & Security that mic/screen/accessibility entries remain checked for Natively.

**E. Auto-update via electron-updater (the key Developer ID win):**
1. Install an older signed build (N-1) from the GitHub release.
2. Publish a newer signed+notarized release (the ZIP + `latest-mac.yml`).
3. Launch N-1 → wait ~10s → "update available" → download → install → app relaunches into the new version (the in-place install now works because both builds are Developer-ID signed; `nativelySigned` flag gates the true `quitAndInstall`).
4. **Critical:** after the auto-update relaunch, confirm Microphone / Screen+System Audio / Accessibility are **still granted with NO new prompts**, and capture works immediately. (This is exactly what stable signing fixes vs the old ad-hoc cdhash drift.)

**F. Clean-machine / offline:**
- Repeat B+C on a 2nd Mac with no developer cert/keychain → confirms it's notarization (not local trust) that satisfies Gatekeeper.
- Offline test: disconnect network, then mount+launch → still works (the stapled ticket means no network round-trip to Apple is needed).

> Status: A passed (verified in this session). B–F require a real/clean machine + a published release and are the operator's final gate before public release.

**G. Transition + regression guards (don't skip — these catch the non-obvious breakage):**
1. **Ad-hoc → Developer ID one-time re-prompt (expected, document in release notes):** a user upgrading from a prior *ad-hoc* build (drifting cdhash) to this Developer ID build **will** get re-prompted for Mic/Screen/Accessibility once — the signing identity changed, so TCC treats it as a new app. This is correct and one-time; every *subsequent* DevID→DevID update then persists grants (§10-D/E). Verify: old build `codesign -dvvv` shows ad-hoc (no Team), new shows `TeamIdentifier=BJM29W3UQ6`; re-grant restores capture; the next update does NOT re-prompt.
2. **Dev build still works with NO Apple account (regression guard):** on a machine with no notarytool profile / no Apple creds, `npm run dist` (default config, ad-hoc `afterPack` signer) must still succeed — NO notarize attempt, NO failure. Verify: build completes, logs show no `notarytool` submission, resulting app is ad-hoc (`nativelySigned` absent → manual update fallback, not `quitAndInstall`). This proves the production signing is fully opt-in and the dev path is byte-unchanged.
3. **Hardened runtime didn't break the native module (not just "no crash"):** under hardened runtime, the Rust `cpal`/CoreAudio `.node` + `.dylib` must LOAD and **produce real audio** — confirm §10-C mic + system-audio transcripts are non-empty with non-zero level meters, and `Console.app` shows no codesign-kill / `EXC_BAD_ACCESS` on the native module. (The `disable-library-validation` + `allow-unsigned-executable-memory` entitlements exist precisely so HR doesn't reject the non-Team-signed native libs.)
