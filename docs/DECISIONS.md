# Decisions

Newest last. Each entry: what was decided, and why. Add one whenever a choice
would make a future developer ask "why is it like this?".

### 2026-09-26: Build a new app instead of reskinning zingo-pc
zingo-pc is Electron and its UI was judged ugly and hard to use. A new app gives a
smaller, faster binary (Tauri uses the system webview) and a clean codebase under
our own brand. zingo-pc stays a reference for how to drive zingolib.

### 2026-09-26: Tauri 2 + Rust engine + React/TypeScript UI
Small installer, fast start, and the engine calls zingolib directly from Rust with
no Node native addon in between.

### 2026-09-26: Name "Laurel", domain laurel.cash
Zcash pools are named after trees (Sprout, Sapling, Orchard, Ironwood). Laurel
is evergreen and means victory. Checked free as a crypto wallet name.

### 2026-09-26: Windows and Linux first, testnet first
The target market lacks a good desktop wallet on those platforms. Testnet until
sending, restoring and encryption are proven.

### 2026-09-26: Code in id Software (Quake III) style
Requested by the project owner. Rules in STYLE.md; rustfmt disabled.

### 2026-09-26: Apple-style design
System-like type (Inter, since SF Pro can't ship on Windows), graphite dark mode,
one accent, soft depth, custom title bar with traffic lights. Illustrations are
inline SVG so they follow light/dark.

### 2026-09-26: Wallet > Account > Pools
A wallet is one phrase or viewing key and is backed up once. Accounts (ZIP-32)
keep money apart and can't be linked on chain. Pools are a balance breakdown.
The switcher lives at the top of the sidebar; Home shows the current account only.

### 2026-09-26: Radix UI primitives + Motion + Lucide, plain CSS, no Tailwind
Radix gives correct keyboard/focus/screen-reader behaviour with no styling.
Motion gives the spring animations that make it feel Apple-like. Lucide replaces
SF Symbols (which can't ship on Windows). Tailwind was rejected: class lists in
every component fight the id-style readability, and our CSS variables already
provide design tokens.

### 2026-09-26: Single ownership, enforced by tools
Rust owns types, commands, events and constants; tauri-specta generates
`src/bindings.ts`; a test fails if it is stale; jscpd fails on copy-paste. Added
after hand-mirrored types and copy-pasted code had already crept in.

### 2026-09-26: Zustand for UI state
Engine data is pushed (sync events), not fetched, so a small store updated by the
event listener fits better than a fetch cache (TanStack Query) and is far lighter
than Redux. Snapshots carry a `seq`; older ones are dropped.

### 2026-09-26: Stay on zingolib, as our own fork
Only complete engine with Ironwood support today, MIT licensed. Vendored and
patched ourselves (see ENGINE.md) so sync speed is in our hands while upstream
work can still be pulled in. Re-evaluate librustzcash before mainnet.

### 2026-09-26: No dead ends in the UI
After a user hit two silently disabled buttons: every button does something
(performs the missing step, or says what is missing), every flow has a way back.

### 2026-09-26: Encrypt wallets at rest, optional password on top
zingolib stores the recovery phrase unencrypted. Default protection by the OS
credential store (no user effort); optional password (Argon2id +
XChaCha20-Poly1305) protecting one random data key, so changing the password
only re-wraps that key.

### 2026-09-28: Test values from one builder each, not generated from Rust
Tests had built the engine's values by hand, many times over; each new field
broke several, and casts or untyped mocks hid missing ones (six settings
objects, four of them stale). Generating test defaults from the Rust types
was considered and not taken: one typed builder per value in
`src/test_engine.ts` (`Test_Item`, `Test_Balance`, `Test_Scanned`,
`Test_Settings`) makes a new field one compile error in one place, without
another build step. check_owners refuses a value's telltale fields written
in any other test. Revisit if the builders grow past a handful.

### 2026-09-30: Our engine changes stay in our fork
We don't send Laurel's changes to zingolabs as pull requests: the fork is ours
to keep. What that costs is keeping up with upstream, so it's kept small and
mechanical instead: only what can't be done on the public API is inside
(the rest is `laurel-engine`), the whole difference is one recorded patch the
gate holds, and upstream is taken often (`engine.mjs status`, then `rebase`).
Measured the day it was decided: three weeks of upstream (85 files) merged with
no conflict in our code. See ENGINE.md.

### 2026-09-30: Settle before building
Five days made 113 commits, 50 in one day, and the checks grew to chase the bugs the
pace let through (check_owners changed in 30 commits). Until the first release:
nothing new until the funded testnet pass is done; one change, one commit; a
bug class that comes back is made impossible by construction before it gets a
rule; a rule that catches nothing by a release is removed. DEVELOPMENT.md, "How
changes are made". The owner can lift it; the default is to settle.

### 2026-11-08: Real money as its own build (D-031, D-033)
Four modules (prices, offline signing, folder sync, repeat payments) became Cargo
features a build may leave out. `v1`, the real-money build, opens mainnet alone and
has no module until each has its own audit; `testnet-only` opens testnet alone. The
two can't be combined, and the release scripts check every bundle for its line
(release_rules.mjs). The Play beta stayed on test coins; v1 went to Play first, and
the computer stayed on test coins until it had its own release path.

### 2026-11-17: Windows through the Microsoft Store
The computer's real-money release is the same `v1` build, packaged as an MSIX and
sold free through the Microsoft Store (the store-windows branch). The Store signs and
updates it, so there is no certificate to buy and no updater of Laurel's own. The
listing uses the publisher's existing Store account, whose name it shows; the owner
accepted that.

### 2026-11-17: iPhone after Windows, on a rented Mac
iOS follows the same `v1` build. The port is prepared here (the ios-prep branch) and built
and tested on a rented Mac, since iOS can only be built on macOS.

### 2026-11-17: Public money can be sent as it is, when turned on
Laurel shielded public money before sending it, always. Exchanges such as Kraken
take deposits at transparent addresses and may want a transparent sender, so
Settings > Advanced > Send From Public Money (off by default) lets Send spend public
coins as they are. The engine checks the setting, not just the screen. A payment
spends from one public address when one holds enough; otherwise it spends across
addresses, and the review says how many it ties together. Change goes to the private
balance. Automatic never picks public money.

### 2026-11-17: A new public address on request, shielded one at a time
Each account still gives out one public address at a time, but Receive > New Address
now makes another, only after the current one has received money, so no restore
ever stops at a gap. Rotating on every payment was declined: the server sees every
public address Laurel looks up, and a shield of all of them at once tied them
together on the chain (the Zashi team declined it for the same reasons). So each
shield now takes one address, and the review says how many wait. For phrases from
wallets that left gaps, Check Again can look further, once, up to 100 unused
addresses in a row; there is no standing setting for it.

### 2026-11-17: The engine holds no rule of Laurel's about which coins to spend
The rules for public money (one address when one can pay, one address per shield,
how far Look Further looks) were written inside the engine fork, where every
upstream update re-applies them and nobody upstream reads them. They moved to
`w_public.rs` and `w_engine.rs`, built on the backend's own spend policy. The fork
keeps one fix (it couldn't gather public coins for a payment at all) and openings
that take the app's choice. Moving it showed the engine's own shield takes every
account's addresses at once; Laurel's shield now names only the account's own.

### 2026-11-18: Prices in the Store's real-money build, after their audit (D-035)
The price module (`w_price.rs`, `w_alert.rs`) is the first to pass the audit D-033
asks of a module before real money. It asks CoinGecko only once the person turns
prices on (off by default; every request checks the setting in Rust, not the
screen), sends nothing about a wallet (a fixed URL; CoinGecko sees the IP address
and Laurel's version), trusts what the Zcash connections trust (webpki roots, an
intercepting antivirus caught), and reads an answer only up to 4 MB, which the
audit added. A price that isn't a number is dropped; test coins have none. A price
is only ever shown: no amount sent, fee or check reads it. Alerts ask nothing while
prices are off, go off once on a crossing, and their notices name a price, never a
balance. Home's balance in dollars hides with the amounts and says nothing once the
price is over an hour old. The Store's v1 names `prices` (store_msix.mjs); Play's
v1 names none, so the phone is unchanged until that is decided for it. The other
three modules stay out (lib.rs, release_rules.mjs V1_AUDITED).
