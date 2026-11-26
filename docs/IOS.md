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
| FLAG_SECURE (MainActivity.kt) | no screenshots, no task-switcher preview | iOS can't block screenshots. `w_ios.rs` covers the page while Laurel isn't the active app (the app switcher's picture) and while the screen is recorded or mirrored, deciding in one place (`Ios_Cover`). SECURITY.md says plainly that a screenshot can't be stopped on iPhone. | done (`w_ios.rs`) |
| `filterTouchesWhenObscured` (MainActivity.kt) | tapjacking by overlays | not needed: iOS has no overlays from other apps | none |
| accessibility-sensitive web view (T-055) | other apps reading the screen | not needed: iOS has no third-party accessibility services | none; SECURITY.md line |
| LifecyclePlugin.kt `watch` → `M_Hidden` | lock when the app is hidden for longer than allowed | `w_ios.rs` watches `didEnterBackground` (not tao's Suspended, which is resign-active: Control Center would start the lock timer while Laurel stays on screen) and calls `M_Hidden`; `M_Shown_f` comes from the page as on Android | done (`w_ios.rs`) |
| `Sys_Close` → `Sys_End` (lib.rs) | save every wallet, then end the process | **iOS never says it's ending an app.** A suspended app is killed without notice. A sent payment is already written at once (`W_SaveAfterSend`), and the saver writes the rest within seconds, so a kill loses only the last seconds of sync. Still, on entering the background `Ios_Background` asks for background time (`beginBackgroundTask`) and saves every open wallet (`W_SaveAll`, the engines left running), ending the task when done. An app must not call `exit()` on iOS (App Review). | done (`w_ios.rs`, `w_persist.rs`) |
| RestartActivity + `M_Restart` (Start Over) | open Laurel fresh after wiping | iOS can't relaunch an app. `W_StartOver` ends in `W_ForgetAll` (every platform): each module forgets what it held of the erased files; then `W_StartOver_f` reloads the page. `check_statics` (w_lifecycle.rs) names every static as forgotten or kept, so a new one fails the tests until someone decides. | done; test on a device |
| DocumentsPlugin.kt, `D_*` pickers (w_dialog.rs, w_documents.rs) | files for offline signing and folder sync | both are modules, and v1 has none. The iOS pickers already return WERR_NO_FILES. Nothing to do for v1. | none for v1 |
| `allowBackup="false"` + backup rules (manifest) | the vault never leaves the phone in a cloud backup | iOS backs up the app's data to iCloud by default. `Ios_KeepLocal` marks the data and log folders `isExcludedFromBackupKey` at start; project.yml's entitlement closes every file while the phone is locked (`NSFileProtectionCompleteUnlessOpen`: a save that starts as the phone locks still finishes). | done |
| CAMERA permission (manifest) | QR scanning (qr-scanner, `getUserMedia`) | `NSCameraUsageDescription` in Info.plist; WKWebView allows `getUserMedia` from iOS 14.3. The worker decoder (ui_qr.ts) works as is. | Mac (Info.plist) |
| Back handling (`__laurelBack`, ui_chrome.tsx) | Android's Back button | none on iOS; every screen already has its own back control | none |
| Insets listener (MainActivity.kt) | system bars, cutout, keyboard | the CSS already uses `env(safe-area-inset-*)`; `Ios_EdgeToEdge` stops UIKit insetting the page a second time (a gray band at the bottom). Check the keyboard on a device | done; keyboard to check |
| `deny(warnings)` on Android (lib.rs) | phone builds refuse a warning | the same on iOS: `cfg(mobile)` | done |
| OS key store | | none on Android either: a password is required on both phones (w_vault.rs `os`). The Keychain can come later, as its own reviewed change. | later |

## The release gate for iOS

- `scripts/release_rules.mjs`: an iOS line check like `Com_LibraryProblems`: the static
  library carries `laurel-networks:v1`, no module marks, the probe off, no
  `coingecko.com`.
- `Com_IosProblems` (release_rules.mjs, in check_release.mjs) is `Com_ActivityProblems`'s
  twin: `w_ios.rs` keeps both covers, the backup exclusion and the background task, and
  project.yml the data protection.
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

1. The simulator app (`aarch64-sim`, `--features v1`) from the Xcode project in
   `src-tauri/gen/apple`. That project is `tauri ios init`'s, made on a runner and
   committed as `gen/android` is; `project.yml` is its source (XcodeGen).
2. A first start in a simulator: a screenshot and the app's log, uploaded as the
   run's `first-start` artifact.
3. Run by hand with `testflight` ticked: the device build, signed by Xcode's automatic
   signing with the API key, its build number the run's (`0.3.3.N`), uploaded with
   `altool`. App Store Connect then asks the export-compliance question once per build
   until Info.plist answers it.

`src-tauri/Info.ios.plist` is merged into the app's Info.plist: the camera's purpose
string (QR codes) lives there, not in the generated file.

## Order

1. Done in Rust (`w_ios.rs`, through the objc2 bindings tao and wry already build, so
   it type-checks on Windows with `--target aarch64-apple-ios`): the background save,
   Start Over in place, the backup exclusion, the covers, `cfg(mobile)`, the iOS
   release rules. No Swift.
2. Done on CI: `tauri ios init`, a simulator build and first start, the camera string.
3. Testnet on the simulator, then TestFlight on a real iPhone, then gate E on mainnet,
   then App Store review.
