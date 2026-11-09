# Laurel

> **Testnet only. Not audited. Never use a real recovery phrase.**
> This build works only with Zcash test coins (TAZ), which have no value.

Laurel is a self-custodial Zcash wallet for Android, Windows and Linux, built
with Tauri 2, a Rust engine on [zingolib](https://github.com/zingolabs/zingolib)
and a React UI. Keys are made and kept on the user's device; nobody else can
see, freeze, reverse or recover a payment.

The Google Play testnet build **0.1.6 (version code 1006)** is built from
this repository's first commit.

## What it talks to

Laurel itself sends nothing to its publisher: no account, no analytics, no crash
reporter. On Android, Google Play shows the publisher crash reports from phones
that share diagnostics with Google, as for any Play app.
[docs/CONTROL-MAP.md](docs/CONTROL-MAP.md) lists every connection Laurel makes
and what each party can see; the main one is the lightwalletd server
(`testnet.zec.rocks` by default), which sees the device's IP address.

## Building

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) sets up a machine and builds the
desktop app; [docs/ANDROID.md](docs/ANDROID.md) builds for Android. The gate is
`npm run check` (`node scripts/check.mjs`); [STYLE.md](STYLE.md) is the code
style. [docs/README.md](docs/README.md) indexes the rest.

## How Laurel is built

Laurel is testnet-only and unaudited; the code is public so you can
check it.

What holds it together, all in this repository:

- [STYLE.md](STYLE.md): one code style, one owner for every fact, and the
  `npm run check` gate (types, lint, tests, generated bindings, notices).
- About 205 Rust tests and 208 UI tests, run by that gate.
- A clippy ban on `bip0039::Mnemonic::to_seed`, which would drop the BIP-39
  passphrase: keys only come from the engine (`src-tauri/clippy.toml`).
- A build that refuses to compile if anything overrides getrandom's random
  source (`src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`).
- The `testnet-only` feature: the Play build can't reach mainnet, and tests
  hold it to that (`src-tauri/src/w_local.rs`, `src-tauri/src/w_main.rs`).

## Security

Report a vulnerability to **security@laurel.cash**, not in a public issue.
See [SECURITY.md](SECURITY.md).

## License

MIT ([LICENSE](LICENSE)). Third-party licenses:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The vendored zingolib
(`vendor/zingolib`) is MIT, by Zingolabs; MPL-2.0 dependencies are used
unmodified.
