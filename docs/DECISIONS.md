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
