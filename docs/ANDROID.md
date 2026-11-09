# Android development

Android support is in progress. The desktop cleanup is committed as `80cbc9a`.
Both ARM64 and x86-64 Rust libraries compile, and the ARM64 library uses 16 KiB
ELF load alignment. Debug APKs package successfully for both architectures.
The x86-64 APK installs and starts in the API 35 emulator.
Do not describe this as a released mobile wallet yet.

The real UI was inspected in a browser at 320, 360, 390 and 412 CSS pixels.
Home amounts fit without clipping. Send, receive and settings were inspected,
including 175% text on the narrow phone. Android uses CSS scaling because the
underlying Android webview's zoom method is a no-op.

The mobile app uses the same Rust wallet engine and command bindings as desktop:
create and restore wallets, sync, send, receive, and history. A password is
required on Android; there is no unprotected-key fallback. Android's activity
`onStop` starts the time Laurel may be away (Security, Lock When You Leave:
right away, 1 minute by default, or 5 minutes; a longer one needs the
password). It locks when that runs out, and on return the page stays covered
until the engine has checked the wall clock (`M_Shown_f`): a frozen app's
timers don't run. A permission dialog's `onPause` starts nothing.
The engine reports a locking state before stopping sync and saving, so wallet
content is hidden while those operations finish. Unlock is refused during that
transition; the key is forgotten after the final saves. Root Back backgrounds
the activity instead of destroying it during native cleanup; the final emulator
build kept its process alive and reopened locked in this test.

When Android does end the activity (swiped from Recents, reclaimed, or the
developer option "Don't keep activities"), Tauri asks to exit: Laurel saves
every wallet (`Sys_Close`), then ends the process as Android ends one
(`Sys_End`, `_exit`). A normal exit ran C++ static destructors under
Android's render threads, which aborted ("pthread_mutex_lock called on a
destroyed mutex": Firebase Test Lab, Pixel 7, 0.1.4; the emulator with "Don't
keep activities" shows it every time). Start Over can't restart its own
process either: `RestartActivity`, in a process of its own (`:restart`), ends
Laurel's and opens Laurel again (`M_Restart`). `check_release.mjs` refuses any
other exit or restart in the engine.

The page needs Chrome 111 in the phone's Android System WebView
(`WEBVIEW_FLOOR`, vite.config.ts): its stylesheet's `color-mix()` over
variables, container queries and `:has()` can't be lowered. On an older one
`index.html` shows "Laurel Needs a Newer Web View", with how to update it,
instead of a blank screen; that screen's own script and styles are old syntax
(Test Lab's Pixel 5 image has WebView 83).
The native activity sets `FLAG_SECURE`; UI hooks do not clear it when a recovery
sheet closes. Android cloud backup and device transfer exclude app data. These
backup settings still require restore testing. The emulator's window manager
reports the activity as `SECURE`. Camera access is declared as an
optional capability and requested only when the scanner needs it.

Android shared-folder sync and offline-signing file transfer now use the system
document picker. A private native adapter resolves granted content URIs instead
of treating them as filesystem paths. Folder access persists across restarts.
Picking a document backgrounds Laurel; back within the time allowed it's still
open, otherwise unlock to resume the action. Results are retained by Rust and shown only while unlocked,
even when the original screen was unmounted. A selected action waits up to five
minutes for unlock; process death requires starting that action again.

Imports enforce a 64 MiB limit while reading, including providers with missing
or incorrect size metadata. Sync writes a temporary document, verifies its bytes,
then replaces its own snapshot, preserving the previous file during publication.
Android providers do not guarantee atomic rename; incomplete snapshots fail
authentication and are retried. Providers must support folder listing, document
creation, reading, writing, renaming and deletion for shared-folder sync.
iOS still reports file actions as unsupported. Camera scanning, notifications,
background interruption during a payment, and password unlock after suspension
also need physical-device validation.

## Validation on this machine

The full project gate passes: 150 frontend tests, 62 engine tests and 134
application Rust tests, plus the existing five desktop layout sizes and clone
checks. Browser phone checks use the real React UI with a simulated engine;
they are visual checks, not evidence of native transactions.

In the native API 35 emulator, password setup reaches onboarding, backgrounding
locks the vault, an incorrect password is rejected, and the correct password
unlocks it after a cold restart. System bars and the keyboard inset the webview
instead of covering it. Native testnet wallet creation now succeeds, and the
new empty wallet reports “Up to date”, Testnet, and 100% sync. Phrase restore,
process death during sync, and unlocking offline were also exercised.

The disposable random test wallet received a confirmed 1 TAZ faucet payment
(`4f90a1179d5370a54d5d01d0b9e94947535e1724012b1c8eb876437a6580c804`).
It then built and broadcast a 0.01 TAZ payment to a second random emulator wallet,
with a 0.0001 TAZ fee. Both histories show that payment confirmed; the recipient
received it in Ironwood. The transaction is
`8557a8a918d9c6ffc9e6f9a250a38a5adf8dbbd45b9b55c69d34526a068d6bd5`.
No funds in the separate public-phrase restore fixture were spent.

The AOSP emulator's native `BarcodeDetector` crashed in Google Play Services.
Scanning now uses the bundled QR worker for both camera frames and pictures.
Camera permission, opening and closing the camera, and the native photo picker
were exercised. Importing a crisp QR picture decoded the second wallet's private
address and offered “Pay This”. Live-camera recognition still needs a physical
device test; the emulator only verifies camera lifecycle and image decoding.
Notification denial returns an error; granting permission delivers the sample
notification without an amount. New mobile installations default system
notifications off and ask permission only on an explicit enable or sample.
`bmgr backupnow` refuses backup, and a native screenshot contains black wallet
content under `FLAG_SECURE`. OEM device-transfer restore remains untested.

The initial certificate failure was traced to Avast HTTPS scanning on the
Windows host. Independent Windows and Android probes both received certificates
issued by “Avast Web/Mail Shield Root”. Android's standard trust manager rejected
them; Laurel's native Windows server-selection test reproduced the failure.
After the user disabled HTTPS scanning, both testnet.zec.rocks and zec.rocks
presented Let's Encrypt chains and passed Android trust and hostname validation.
The Rust server-selection test then passed for both networks, including rejecting
a testnet server selected for mainnet. The same installed Android APK created
and synced the testnet wallet without a code change, added trust root, or disabled
TLS validation. Re-enabling interception can reproduce the original failure.

Debug APKs are under `src-tauri/gen/android/app/build/outputs/apk/`:

- `arm64/debug/app-arm64-debug.apk`: physical ARM64 phones.
- `x86_64/debug/app-x86_64-debug.apk`: the emulator.

The document adapter was exercised with the emulator's external-storage
provider: select a folder, unlock, start sync, write an encrypted snapshot, and
restart the app. The desktop engine authenticated that snapshot and produced a
peer snapshot; Android read and merged the peer after restart using its retained
grant. A malformed signing request was rejected after picker return and unlock.
Canceling the picker returned safely with no stale result. A complete funded
offline-signing round trip and third-party cloud document providers still need
native validation.

The emulator also removed a disposable peer with Forget and removed its own
snapshot with Stop Syncing. Frontend tests cover resumed signing-request and
signed-payment confirmations, their existing guidance, and hiding both while
locked.

The final emulator build also joined the desktop fixture, displayed the folder's
provider name, and replaced its own snapshot after a notification-setting change.
The desktop compatibility probe authenticated the replacement. The disposable
sync setup was then stopped; the wallet data was preserved.

These are development builds, not release-signed distributions. Shared wallet
copy now says “device”; platform-specific Windows protection explanations retain
their platform names.

## This Windows machine

Tools and Android caches are under `D:\Android`:

- `java\jdk-21.0.12.1+1`: Temurin JDK 21, verified against its release checksum.
- `Sdk`: Android command-line tools, platform 36, build tools 36.0.0, NDK
  29.0.14206865, platform tools and emulator.
- `gradle`, `user`, `avd`: Gradle, Android settings and emulator storage.
- `downloads`: resumable vendor downloads, verified before extraction.

Rust targets are `aarch64-linux-android` for phones and `x86_64-linux-android`
for the emulator. Hardware acceleration (Windows Hypervisor Platform) is
available on this machine.

The desktop build caches (`src-tauri/target`, `vendor/zingolib/target`) may be
junctions to another drive. They are build caches, not wallet storage.

## Commands

From the project directory in PowerShell:

```powershell
. .\scripts\windows-env.ps1
npm run check

.\scripts\android.ps1 build --debug --target aarch64
.\scripts\android.ps1 build --debug --target x86_64
.\scripts\android.ps1 dev
```

The scripts load the installed Visual Studio compiler and Android environment
for the current shell. They do not change machine-wide environment variables.
Java uses Windows' trusted certificate store on this host; TLS verification is
kept enabled.

The Android project is checked in. Do not run `tauri android init` over it:
regeneration replaces the native capture and backup protections. The helper
refuses to regenerate an existing project.

On Windows without symbolic-link privileges, the helper recognizes Tauri's
failure after Rust compilation, copies the compiled library into `jniLibs`, and
asks Gradle to assemble that exact ABI without recompiling Rust. Use an explicit
`--target aarch64` or `--target x86_64` for this fallback. It supports APK builds;
live `dev` and app-bundle workflows still need the usual Tauri prerequisites.

Intermittent Java HTTPS failures on this host were recovered by downloading the
same official artifacts with Windows curl, checking their published SHA-1 or
SHA-256, and adding them to Gradle's cache. No certificate checks were disabled.

### The KDF probe

What Argon2 at Laurel's cost does to a phone (W1-06), measured on the phone:
a debug build with `kdf-probe` waits for the window, then derives three times,
one after another, and logs each one's time and the process's peak memory
(`src-tauri/src/w_probe.rs`). Never Play's: a release with it doesn't compile,
and `scripts/play_bundle.mjs` refuses a library built with it.

```powershell
.\scripts\android.ps1 build --debug --target x86_64 --features testnet-only,kdf-probe
adb logcat -v time | Select-String LaurelKdfProbe
```

Every probe line starts `LaurelKdfProbe:` (the log tag is
`laurel_lib::w_probe::probe`, which `adb logcat -s` won't take as a filter).
A run the system killed mid-derive is reported on the next launch.

## Before release

Release signing is optional during local builds and uses four environment
variables: `LAUREL_ANDROID_KEYSTORE` (absolute keystore path),
`LAUREL_ANDROID_STORE_PASSWORD`, `LAUREL_ANDROID_KEY_ALIAS`, and
`LAUREL_ANDROID_KEY_PASSWORD`. Supply all four in the build process to sign, or
leave all four unset for an unsigned release build. Partial configuration fails
with an explanation. Do not commit credentials or replace an existing signing
identity. Build ARM64 release with `scripts/android.ps1 build --target aarch64`.
An unsigned APK cannot be installed until signed; debug keys are not release keys.

The Play beta is built with test coins only, as the app bundle Google Play
takes: `scripts/android.ps1 build --target aarch64 --aab --features
testnet-only` (without `--aab`, an APK). That
build's engine opens testnet alone (`NETWORKS`, `W_NetworkOffered` in
w_main.rs): switching to mainnet, loading it, or creating or restoring a
mainnet wallet is refused, whatever the ui asks. A settings file that chose
mainnet starts on testnet, and Settings > Network says the build is for test
coins instead of offering a switch. It also won't start moving Orchard money
to Ironwood (`W_MigrateOffered`; a part an older build left waiting still goes
out, saved first): the engine's rounds broadcast a part before the
wallet holding it is written (security review T-041 #2), and a new testnet
wallet holds no Orchard. `cargo test --lib --features
testnet-only` runs the test that holds this (`the_testnet_build_never_opens_mainnet`).

A Play upload, start to end (one commit each step, the full gate before each):

    node scripts/bump.mjs 0.1.5 "What changed, as a plain sentence."    # every version, and its notes
    scripts\android.ps1 build --target aarch64 --aab --features testnet-only
    node scripts/play_bundle.mjs

`play_bundle.mjs` checks the bundle is a clean tree's build (android.ps1 records
which) with nothing built into the app changed since (a scripts or docs commit
needs no new build: a release's whole-program optimization takes 10 minutes), its
version code new, its library the testnet build cargo made (stripped, its
symbols in the bundle for Play), the phone's only one, and no Android TV. Then
it copies it to `D:\Android\releases\laurel-testnet-<commit>-unsigned.aab`
and prints the release line for whoever signs it.

An optimized, R8-minified ARM64 release APK built successfully on this machine:
`arm64/release/app-arm64-release-unsigned.apk` under the APK output directory
(about 75 MB). It contains only the ARM64 native library. Its ELF load segments
are aligned to 16 KiB and `zipalign -c -P 16 4` passes. The merged release manifest
disables backup and cleartext traffic and has no debuggable flag; the document
plugin commands and activity callback survive shrinking. The build is unsigned,
as expected with no release credentials. Partial signing configuration was also
tested and correctly refused. This validates packaging, not runtime behavior on
an ARM64 phone.

- Exercise create/restore, sync, send and receive
  on testnet with disposable test wallets.
- Test backgrounding during sync and sending, process death, restarting offline,
  wrong passwords, and recovery after an interrupted save.
- Verify screenshot and Android backup exclusions on the generated activity and
  manifest, including release builds.
- Inspect 320–412 CSS-pixel layouts, keyboard-open sheets, and large text.
- Validate exported-file handling, camera permissions and notifications before
  advertising those features on phones.
- iOS requires a Mac and Xcode; no iOS build has been attempted here.

Setup references: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
and [Android command-line tools](https://developer.android.com/tools).
