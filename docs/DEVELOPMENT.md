# Development

## Prerequisites

| Tool | Notes |
|---|---|
| Rust (stable, MSVC toolchain on Windows) | `rustup` |
| Node.js 22+ and npm | the UI and the Tauri CLI |
| Visual Studio 2022 Build Tools, "Desktop development with C++" | MSVC compiler and linker (Windows) |
| **Windows 11 SDK** (10.0.26100 or newer) | without it linking fails with `cannot open input file 'kernel32.lib'` |
| protoc (Protocol Buffers compiler) | needed by zingolib's build |
| WebView2 | ships with Windows 10/11 |

Linux: the usual Tauri 2 system packages (webkit2gtk, libsoup, etc.), see the
Tauri docs.

## Everyday commands

```
npm install                 # once
npm run tauri dev           # run the app; UI edits reload live, Rust edits rebuild (~15 s)
npm run app                 # a double-clickable laurel.exe for this machine (never shipped; see below)
npm run check               # every check, side by side, each timed (scripts/check.mjs). Run before every commit.
node scripts/check.mjs lint test-ui   # only those steps (it lists them all when given a wrong one)
node scripts/check.mjs --cold          # once, after a change that rebuilds the engine: each step may take 15 min, not 60 s
npm run bindings            # regenerate src/bindings.ts after changing Rust types or commands
npm run dupes               # just the copy-paste scan
```

A warm `npm run check` takes about 30 seconds. Much longer means something
is rebuilding that shouldn't: a Rust edit rebuilds only what changed, and
a commit rebuilds nothing (zingolib's build script no longer watches git).
An edit inside `vendor/zingolib` does rebuild the engine whole: its tests
are built optimized and not incrementally, a few minutes.

Debug builds also rewrite `src/bindings.ts` on start. The Rust test
`bindings_are_fresh` fails if it is out of date, so a stale file can't slip in.

The first full Rust build compiles about 680 crates (the Zcash cryptography is
large): expect 5 to 10 minutes. After that, rebuilds take seconds.

## How fast a wallet opens

Wallets open side by side at start (`W_Load`), so several take about as long as
the largest. `a_wallet_with_history_opens_fast` (w_main.rs) holds the whole path
under a budget in every check. The 8 to 10 s once seen in zingolib's tests is its
one-time import of a v27 zingo 1.x file (`read_v0`), a path Laurel never takes:
it has only ever saved the current format. To measure again:

```
cargo test -q --profile local --lib a_wallet_with_history_opens_fast -- --nocapture    # in src-tauri
```

## Where things live on disk

| Path | What |
|---|---|
| `%APPDATA%\com.rptxsoftware.wallet\wallets\<network>\<wallet id>\` | one wallet: `laurel-wallet.dat` (zingolib) and `laurel.json` (names, backup flag) |
| `%APPDATA%\com.rptxsoftware.wallet\sapling-spend.params` | Sapling's spend proving key (48 MB), fetched by the app the first time a payment spends Sapling money (`w_spendkey.rs`); not compiled in |
| `%APPDATA%\ZcashParams\` | Sapling proving parameters (about 50 MB), downloaded by zingolib's build. Only the output key (3.6 MB) is compiled in; the app also uses the spend key here when it finds one |
| `src-tauri/target/` | Rust build output (about 4.5 GB in debug) |

Laurel currently runs on **testnet** only (`NETWORK` in `src/ui_local.ts`).
Testnet coins come from a Zcash testnet faucet.

## Build problems we already hit, and the fixes

**Linker errors like `link: extra operand ...`**
Git for Windows / MSYS2 ships a GNU `link.exe` that shadows the MSVC linker on
PATH. Point cargo at the MSVC one:
```
CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=<VS>\VC\Tools\MSVC\<ver>\bin\Hostx64\x64\link.exe
```
and load the Visual Studio environment (`vcvars64.bat`) so `LIB` and `INCLUDE`
point at the Windows SDK. Running from a "Developer PowerShell for VS" does both.

**The build sits at 0% CPU on a `build-script-build.exe`**
Antivirus (Avast CyberCapture, Malwarebytes) holds every freshly compiled build
script for analysis. Add exclusions for the project folder, `%USERPROFILE%\.cargo`
and `%USERPROFILE%\.rustup`. Programs already held need killing; exclusions only
apply to new ones.

**`InvalidCertificate(UnknownIssuer)` from cargo, zingolib's build, or the app**
HTTPS-scanning antivirus (Avast Web Shield) re-signs every connection with its own
root, which Rust's TLS doesn't trust. Turn off HTTPS scanning. The app shows a
plain message for this case (`WERR_INTERCEPTED`). For git only,
`git -c http.sslBackend=schannel` uses the Windows certificate store instead.

**The Sapling parameters fail to download during the build**
Same cause as above. Workaround: download `sapling-spend.params` and
`sapling-output.params` from `https://download.z.cash/downloads/` into
`%APPDATA%\ZcashParams\`. The build checks the output key against its published
BLAKE2b hash (`vendor/zingolib/zingolib/src/params_hashes.rs`) and replaces a wrong one.

**The UI tests time out while the machine is busy**
Their work is CPU: on a quiet machine the slowest test takes about 2.5 s of its
5 s (the first test of each file most: it draws a screen for the first time), and
a full compile alongside makes that 5 s or more, a different handful each time.
A cold run (`--cold`) runs them after its builds, and animations are off in tests
(`test_setup.ts`: a fifth of all test time). Something else compiling at the same
time (the live harness's container) can still do it: run
`node scripts/check.mjs test-ui` again once it's done. Measured and not taken:
vitest's `vmThreads` pool (3 s faster, but two tests that redefine
`window.location` fail under it).

**`cargo test` dies with `STATUS_ENTRYPOINT_NOT_FOUND`**
Test binaries lacked the Windows Common-Controls v6 manifest that Tauri's webview
needs. `src-tauri/build.rs` now embeds `windows-app-manifest.xml` into every
binary through `windows-manifest.rc`. Don't remove it.

**`tauri dev` waits forever for `http://localhost:1420`**
`localhost` resolves to IPv6 `::1` on Windows while Tauri polls IPv4. The dev
server and `devUrl` are pinned to `127.0.0.1`; keep them matching.

**`Port 1420 is already in use`**
A dev server from an earlier run is still alive. Stop the `node ... vite` process
holding the port.

**`There is not enough space on the disk`**
The debug build no longer keeps debug info for dependencies
(`[profile.dev.package."*"] debug = false`), which roughly halved `target/`. Build
output belongs on an SSD; spinning disks make Rust builds several times slower.

## Seeing the screens

Tests render pieces in a dom without styles; `mock.html` shows the real
screens, styled, with fixed answers in place of the engine. With the dev
server running (`npm run tauri dev`, or `npx vite`), take a screenshot
at any size without touching the desktop:

    msedge --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=8000       --window-size=514,343 --screenshot=home.png http://localhost:1420/mock.html

A larger text size is a smaller window in CSS pixels: the smallest window
(900 x 600) at 175% is 514 x 343. That is how the balance split was found
cutting amounts ("12..."), and a sheet's crash blanking the whole window.
Add answers to the `FIX` table in `mock.html` for the screen you need.
`?pane=folder` opens Settings on that pane, `?pane=` the dashboard (What's New already seen either way);
`&welcome` a first run with no wallets (the welcome screen), `&locked` the lock screen (any password opens it), `&sync` shows a running sync, `&pending` a signing request waiting, `&sapling` money in Sapling, `&history` a balance history in every pool;
`&click=<selector>` presses that once drawn (a pool, a tab; several apart by `|`);
`&phone` draws a phone's layout (the bar at the bottom), `&scale=175` a text size as the
app sets it (on a phone, css zoom).

A headless window is never narrower than about 500px, so a phone's width can't be
asked of `--window-size`: it draws the desktop layout cut to the width. Set the page's
own size over the DevTools protocol (`Emulation.setDeviceMetricsOverride`, `mobile:
true`), as `scripts/check_layout.mjs` does.

`npm run layout` (part of `npm run check`) does this without looking:
it starts its own dev server, draws `mock.html?check` in headless Edge at
1100 x 720, 1100 x 900, 900 x 600, 629 x 411 and 514 x 343, and fails on
any amount cut or wider than its box, any cut-off text holding a number,
words drawn over other words, a word broken in two, and a page wider than
its window. Then a phone (`?phone`) at 412, 390, 360 and 320 px wide, and
the screens where large text bites at 175%: the same faults, and nothing past
the screen's edge or left under the bottom bar. The page must report the exact size
asked for: a headless window's frame once shrank 1100 x 900 to 1076 x 808,
below the height where the action hints show, and they went unmeasured.

## Two kinds of build, never mixed

| | `npm run app` (local) | `npm run release` |
|---|---|---|
| For | trying Laurel on this machine | what people install |
| Cargo profile | `[profile.local]`: no LTO, 16 units, incremental | `[profile.release]`: whole-program LTO, 1 unit |
| Time on this machine (2026-09-30) | about 5 min from nothing, then about 17 s after any edit | longer: every build is from nothing |
| Output | `src-tauri/target/local/laurel.exe`, no installer | installers, `SHA256SUMS.txt` under `target/release/bundle/` |
| Pinned (time, paths, lockfiles) | no | yes: reproducible |

The rules, and what holds each one:

- **Never make the release quicker to build.** `check_release.mjs` (in the
  gate) fails if `[profile.release]` changes. A quicker build goes in
  `[profile.local]`.
- **Never ship a local build.** It lands in `target/local/`, where
  `release.mjs` doesn't look, and `check_release.mjs` refuses a
  `--profile` or `--no-bundle` in `release.mjs`.
- **Test the installer you'll publish, not the dev build.** A release
  panics by stopping (`panic = "abort"`) and is optimized differently; the
  tests run neither way. Install it, then run the "before every release"
  checks below against it.
- **Build releases from a clean checkout of a tagged commit.** Build them on
  a clean machine or in CI, not in a working copy with local changes.
- **Sign what ships** once the signing key exists (the LLC decision):
  unsigned Windows installers meet SmartScreen warnings.

## Releases

`npm run release` builds with what varies between builds pinned: the
time is the last commit's (`SOURCE_DATE_EPOCH`), this machine's paths are
rewritten out of the binary (`--remap-path-prefix`), and dependencies are
exactly the lockfiles' (`npm ci`, `--locked`). It writes
`src-tauri/target/release/bundle/SHA256SUMS.txt` beside the installers
(`sha256sum -c` reads it); `--sums` rewrites only the checksums. Signing
waits on a signing key (the LLC decision).

Each version has its notes in `docs/RELEASE-NOTES.md`, newest first: a
`## version · date` heading and a plain `- ` sentence per change. The
release copies the file beside the installers (in the checksums too), and
the app, built with it, shows the newest once after an update and all of
them in Settings > About. `check_version.mjs` (in the gate) refuses a
`package.json` version that `src-tauri/Cargo.toml` doesn't share, or that
has no notes: to release, bump both and write the notes first
(`node scripts/bump.mjs 0.1.5 "A sentence."` does all of it; a Play upload is
in docs/ANDROID.md, "Before release").

The program is reproducible: on 2026-09-27 two builds from scratch, from
one commit, in two target folders, gave the same `laurel.exe` (sha256
`c8b26f14...`). It took `/Brepro` (the linker's timestamp and PDB GUID
were the only 24 bytes apart). The installers can't match (an MSI must
carry a new package code each build; NSIS stamps dates): to check a
release, compare the `laurel.exe` inside it with the one in the sums.

## Live testnet checks

Unit tests can't show that a key derivation or a signed transaction is
accepted by the real network. `src-tauri/engine/examples/live.rs`
drives the engine patches against testnet: receiving and spending with a
passphrase wallet, importing a zcashd Sapling key and moving its money,
and sweeping a WIF key. Each step follows Laurel's own code path.

Antivirus HTTPS scanning (Avast) re-signs TLS for every Windows process
except the app, so run the harness in a Linux container:

    docker build -t laurel-live -f scripts/live.Dockerfile scripts    # once: Rust and protoc
    # the volumes keep what each run would fetch again: crates, and the Rust
    # version (a run without laurel-rustup downloads it every time); the source
    # is read-only (:ro) and the lockfile binding (--locked): what runs in the
    # container can't change what Laurel ships. It builds laurel-engine alone,
    # from the app's workspace (the versions Laurel ships), never the app
    docker run --rm -v "<repo>:/src:ro" -v laurel-target:/target \
      -v laurel-live:/live -v laurel-cargo:/usr/local/cargo/registry \
      -v laurel-rustup:/usr/local/rustup \
      -e CARGO_TARGET_DIR=/target -e LIVE_DIR=/live -w /src/src-tauri laurel-live \
      cargo run -q --locked --release -p laurel-engine --example live -- tip pass

Test coins: zingolib's public `glory` test seed held about 40 TAZ in
September 2026 (its history syncs in about 2 minutes). Faucets work too:
fauzec.com has a plain API, and zcashfaucet.jinolabs.xyz uses proof of
work. For a script with no browser, the `zcash-faucet` npm CLI (MIT) gives
0.1 TAZ per address per 24 h behind an Argon2id proof of work (about 5
minutes; Node 24.7+ for `crypto.argon2`): `npm pack zcash-faucet`, read
`bin/zcash-faucet.js`, then `node bin/zcash-faucet.js <utest1...>` in the
background with its output in a file (it buffers). Make every test wallet at the tip (`tip <wallet>`), so each sync
takes seconds.

This file says how to run them.

### Sapling into Ironwood (run before every release)

`movesapling <wallet>` is w_move.rs's path: everything in Sapling, from
Sapling only, to the wallet's own newest private address; once mined, it
says what was spent and where it arrived. Put money into Sapling first
(`addresses glory` prints a Sapling-only address; `send glory` to it).
Less than the fee in Sapling must be refused as WERR_MOVE_BELOW_FEE, not
"not enough money". The harness fetches Sapling's spend key into $LIVE_DIR
as Laurel does (w_spendkey.rs).

### Several payments in one, one of them exchange-only

`sendmany glory <textest1...>=133333 <utest1...>=144444` prints each step
of the proposal and what it pays. It must be two steps, each payment
arriving once (`count`), and the total what was asked, summed over the steps
(`E_ProposeSend`), never the last step's alone.

### Killed mid-send (run before every release)

SECURITY-TODO.md, E.2. With a fresh recipient (`newseed killto`, then its
address from `balance killto`):

    killsend glory <address> 111111 calculated   # signed and saved, never sent; the process dies
    resume glory                                 # Laurel's next start: catch up, send what's unsent
    killsend glory <address> 122222 broadcast    # sent; the process dies before any save
    resume glory                                 # must find it on the chain, not send it again
    count killto 111111                          # after a few blocks: 1
    count killto 122222                          # 1

Scripts that call the runner from Git Bash need `MSYS_NO_PATHCONV=1`, or
the container's working directory is rewritten into a Windows path.

### Offline signing, the engine's half (run before every release)

`offline glory self 50000` walks the engine through w_offline.rs's path:
a view-only copy of the synced state proposes; a signer made from the same
snapshot with no server, the spending key put beside it in memory,
calculates; the viewing key takes the signed bytes apart and accounts for
every zatoshi; then it is broadcast and waited for. Spent less fee less
every output seen must be 0.

### Every paid transaction balances (run before every release)

SECURITY-TODO.md, E.1: `audit <wallet>` fetches every transaction the
wallet paid for, raw, from the server, decodes it apart from the wallet's
own records, and checks spent = paid + change + fee, with the fee from the
transaction's bytes equal to ZIP 317's. It ends with "audited N
transactions, 0 wrong".

### The restore gate (run before every release)

Recovery is proven, not assumed (SECURITY-TODO.md, B). With the harness:

1. `newseed gate`: a fresh wallet at the tip; its phrase and birthday are
   kept beside it, as on paper.
2. `addresses gate`, then fund it in every pool from one wallet:
   `sendmany glory <UA>=500000 <sapling-only UA>=500000 <t-address>=500000`.
3. Spend from each pool: `sendfrom gate <addr> 100000 ironwood`, the same
   from `sapling`, and `shield gate` for the transparent coins (the engine
   pays nothing straight out of transparent, like Laurel).
4. Pay a TEX address (`tex <t-address>` gives one): `send gate <tex> 50000`,
   a two-step payment through an ephemeral transparent address.
5. Note the balance and the `refund`-scope (ephemeral) address:
   `balance gate`.
6. `restore gate2 gate`: only the phrase and the birthday, in an empty
   folder. The balance must match to the zatoshi and the ephemeral
   address must be found.
7. Send a refund to that ephemeral address later; `gate2` must see it.
   Then `shield gate2` and `send gate2 <addr> all`: everything spends.

Orchard (new payments go to Ironwood since NU6.3; Orchard is spent only
by the migration): `restore glory2 glory` (the public test wallet, which
holds legacy Orchard), compare every pool with `balance glory`, then
`migrate glory2` and `audit glory2`. Every pool must match to the zatoshi.

## How changes are made

Measured 2026-09-30: 113 commits in five days, 50 in one of them; +57,000 lines.
`scripts/check_owners.mjs` changed in 30 of those commits, one rule per bug that
got through. The same kinds of bug kept coming back (duplicated rules, casts
hiding fields, decisions guessed from errors), many added that week. The checks
were keeping up with the churn, and the churn wasn't slowing down. Until the
first release, these rules hold:

1. **Settle before building.** Nothing new until the funded testnet pass
   (ROADMAP.md, "Next") is done: fixes only, and only ones that come from using
   the app or from a failing test. A review or critique that finds something
   writes it down (ROADMAP.md or SECURITY-TODO.md). It doesn't start a change today.
2. **One change, one commit.** Plan it, make it whole, read its diff, run the
   gate, commit once. A change that needs a second commit the same day to fix
   the first wasn't finished; take the time to finish it next time. Look at the
   churn when asked:
   `git log --since=7.days --name-only --format= | sort | uniq -c | sort -rn | head`.
   A file changed in more than five commits that week gets read whole before
   it gets patched again.
3. **Make the bug impossible, not caught.** When a class of bug comes back,
   change the shape first: a type, one function that owns it, a value the
   compiler checks (as text_t did for languages). A new lint or gate step is the
   last resort, added only on a class's second appearance, and in its own commit,
   never in the one that fixes the bug.
4. **A guard earns its place.** Each rule says the bug it stops. At every release,
   a rule that caught nothing since the last one is either removed or
   rewritten as a type.

## Before you commit

1. `npm run check` passes.
2. You searched for every sibling of what you changed: the same pattern
   elsewhere, the other side of the Rust/TypeScript line (see STYLE.md).
3. The commit message says what changed and why.
