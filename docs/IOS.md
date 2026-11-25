# iPhone

The iPhone build is the Android v1 build on iOS: mainnet alone, no module (D-033),
the same Rust library and the same page. This file maps everything Android does
natively to what iOS does instead, and says which side of the line each part is on:
**here** (doable on Windows, without a Mac) or **Mac** (needs Xcode).

Builds and tests run on GitHub's macOS runners, from the public repository's `ios`
branch (`.github/workflows/ios.yml`, exported from `public/`); a Mac is rented by
the day only for something that has to be seen and touched. Nothing here may change
what the Android build does: every change is behind `target_os = "ios"`, or is the
same on both phones and is checked by the Android gate first.

## What Android does natively, and the iOS answer

| Android (where) | What it's for | iOS | Side |
|---|---|---|---|
| FLAG_SECURE (MainActivity.kt) | no screenshots, no task-switcher preview | iOS can't block screenshots. Cover the window when the app resigns active, so the app-switcher snapshot shows a blank; watch `UIScreen.capturedDidChangeNotification` and cover the screen while it's recorded or mirrored. SECURITY.md says plainly that a screenshot can't be stopped on iPhone. | Mac (Swift) |
| `filterTouchesWhenObscured` (MainActivity.kt) | tapjacking by overlays | not needed: iOS has no overlays from other apps | none |
| accessibility-sensitive web view (T-055) | other apps reading the screen | not needed: iOS has no third-party accessibility services | none; SECURITY.md line |
| LifecyclePlugin.kt `watch` → `M_Hidden` | lock when the app is hidden for longer than allowed | a Swift plugin observing `UIApplication.didEnterBackgroundNotification` calls the same channel; `M_Shown_f` comes from the page as on Android | Mac (Swift); Rust side here |
| `Sys_Close` → `Sys_End` (lib.rs) | save every wallet, then end the process | **iOS never says it's ending an app.** A suspended app is killed without notice. A sent payment is already written at once (`W_SaveAfterSend`), and the saver writes the rest within seconds, so a kill loses only the last seconds of sync. Still, on entering the background the plugin asks for background time (`beginBackgroundTask`) and Rust saves every open wallet (`W_SaveSlot` for each, the engines left running). An app must not call `exit()` on iOS (App Review). | Rust here, Swift on Mac |
| RestartActivity + `M_Restart` (Start Over) | open Laurel fresh after wiping | iOS can't relaunch an app. After `W_StartOver`, reset the process's state in place and reload the page to the first screen. Needs a check that `W_StartOver` leaves nothing behind in memory (vault key, slots, sync tasks). | here (design + Rust), test on Mac |
| DocumentsPlugin.kt, `D_*` pickers (w_dialog.rs, w_documents.rs) | files for offline signing and folder sync | both are modules, and v1 has none. The iOS pickers already return WERR_NO_FILES. Nothing to do for v1. | none for v1 |
| `allowBackup="false"` + backup rules (manifest) | the vault never leaves the phone in a cloud backup | iOS backs up the app's data to iCloud by default. Set `isExcludedFromBackupKey` on the data folder at start, and write the files with `NSFileProtectionComplete`. | Rust here (one call via objc2 or a Swift hook), Mac to test |
| CAMERA permission (manifest) | QR scanning (qr-scanner, `getUserMedia`) | `NSCameraUsageDescription` in Info.plist; WKWebView allows `getUserMedia` from iOS 14.3. The worker decoder (ui_qr.ts) works as is. | Mac (Info.plist) |
| Back handling (`__laurelBack`, ui_chrome.tsx) | Android's Back button | none on iOS; every screen already has its own back control | none |
| Insets listener (MainActivity.kt) | system bars, cutout, keyboard | the CSS already uses `env(safe-area-inset-*)`; check the keyboard on the Mac | Mac (check) |
| `deny(warnings)` on Android (lib.rs) | phone builds refuse a warning | the same on iOS: `cfg(mobile)` | here |
| OS key store | | none on Android either: a password is required on both phones (w_vault.rs `os`). The Keychain can come later, as its own reviewed change. | later |

## The release gate for iOS

- `scripts/release_rules.mjs`: an iOS line check like `Com_LibraryProblems`: the static
  library carries `laurel-networks:v1`, no module marks, the probe off, no
  `coingecko.com`.
- `Com_ActivityProblems` has an iOS twin: the Swift side keeps the app-switcher cover
  and the background save.
- Gate E again on a real iPhone (TestFlight), with the same steps as
  `gate-e-mainnet.md`.

## Decided

- **Bundle id** `cash.laurel.wallet` (Android keeps `com.rptxsoftware.wallet`), in
  `src-tauri/tauri.ios.conf.json`; registered on the Apple team, with its App Store
  Connect record.
- **Developer name** on the App Store: the legal entity's name, as on Google Play.
- **Minimum iOS** 15: `getUserMedia` in WKWebView, and almost every iPhone in use.
- **Signing and upload** with an App Store Connect API key held as the repository's
  Actions secrets `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8`, never in the tree.

## What CI does, step by step

1. `rust`: the library for the simulator (`aarch64-apple-ios-sim`, `--features v1`).
   The first thing to learn: does the engine build for iOS at all.
2. `app`: `tauri ios init` makes `src-tauri/gen/apple` on the runner (uploaded, then
   committed here once it builds), then a simulator build.
3. Later: a signed device build to TestFlight, with the API key.

## Order

1. Here: the Rust side of the background save, Start Over in place, the backup
   exclusion, `cfg(mobile)` where Android and iOS agree, the iOS release rules.
   Each lands with its test, checked by the Android gate.
2. On the Mac: `tauri ios init`, a simulator build, then the Swift plugin (cover,
   background time, lifecycle), then Info.plist.
3. Testnet on the simulator, then TestFlight on a real iPhone, then gate E on mainnet,
   then App Store review.
