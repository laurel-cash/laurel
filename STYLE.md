# Laurel code style

All Laurel code (Rust, TypeScript, CSS) follows id Software's style, as in the
Quake III Arena source (`code/client/cl_parse.c` is a good reference).

- Every file opens with the license banner, then `// file.ext -- what it is for`.
- Group code under section dividers:

  ```
  /*
  =========================================================================

  SECTION NAME

  =========================================================================
  */
  ```

- Every non-trivial function gets a header block with its name and, when it
  is not obvious, *why* it works the way it does:

  ```
  /*
  ==================
  W_Load

  Opens every wallet of net on disk, once
  ==================
  */
  ```

- Tabs for indentation, spaces inside parentheses: `if ( x ) {`, `W_Load( net )`.
  Opening brace on the same line. Align related assignments and fields with tabs.
- Names:
  - functions: subsystem prefix + CamelCase: `W_Balances`, `Sync_Start`, `Com_FormatZec`, `UI_Home`
  - commands the UI can invoke: `_f` suffix, like Quake console commands: `W_Create_f`
  - types: lowerCamel + `_t`: `walletSummary_t`, `balance_t`
  - enum values: ALL_CAPS with a prefix: `NET_MAINNET`, `WERR_NO_WALLET`
  - fields and locals: camelCase: `walletHeight`
  - constants: ALL_CAPS: `WALLET_FILE_NAME`
- Comments are short and lowercase unless they are a header block. Trailing
  comments after a statement explain the one thing that is not obvious.
- Never run rustfmt or prettier: `src-tauri/rustfmt.toml` disables rustfmt,
  and `lib.rs` allows the lints that id naming would trip.
- `src/bindings.ts` is generated and exempt: its command names are camelCase
  (`commands.wCreateF`) because the generator decides them.

Subsystem prefixes:

| Prefix | Where | What |
|---|---|---|
| `Sys_` | `lib.rs` | process setup, bindings, shutdown |
| `W_` | `w_main.rs`, `w_net.rs`, `w_phrase.rs`, `w_cmds.rs` | the wallet registry, server, phrases, commands |
| `Sync_` | `w_sync.rs` | the sync engines and their progress events |
| `St_` | `src/ui_store.ts` | the UI's copy of engine state |
| `Com_` | anywhere | small shared helpers |
| `UI_` | `src/ui_*.tsx` | screens and components |

# Single ownership

Every fact has exactly one owner. Everything else is generated from it or
reads it; nothing keeps a hand-made copy.

| Fact | Owner | Everyone else |
|---|---|---|
| Types, commands, events, constants | Rust: `w_local.rs`, `w_cmds.rs`, `Sys_Specta` in `lib.rs` | `src/bindings.ts`, generated. Import from it (or `ui_local.ts`, which re-exports it). Never write an `invoke("…")` or a mirror type. |
| Wallet state: balances, accounts, sync | the engine | `ui_store.ts` holds the newest snapshot only, dropping anything with an older `seq` |
| Words the user reads | `src/ui_text.ts` | screens say `T.backup.title`. Engine errors are written in `werr_t`. |
| Colors, spacing, radii, the spring | `ui.css` variables, `SPRING` in `ui_widgets.tsx` | no literal colors or ad-hoc animations in components |

One helper per repeated pattern:

- Rust: `.engine()?` turns any engine error into a Laurel error; every new
  wallet goes through `W_AddWallet`; every meta change through `W_UpdateMeta`.
- UI: every engine call from a button goes through `useAction()` (busy, error,
  double-click guard); requests fired while typing go through `useLatest()`.

Locking (Rust): hold the registry lock `w` only to find a wallet (`W_Slot`),
then lock that wallet. Never lock `w` while holding a wallet's lock.

State rules:

- **The UI never infers a fact the engine owns.** If a screen branches on
  something ("is this a first run?", "is the vault locked?"), the engine states
  it explicitly. `order.length === 0` once stood in for "first run" and showed
  onboarding when a wallet merely failed to open.
- **Every multi-way state is a union, handled exhaustively.** Switches end in
  `Com_Unreachable( x )`, so adding a case makes every switch that forgot it a
  compile error. The top-level screen is decided in one pure function,
  `St_Screen` (`ui_store.ts`), and each of its cases has a test.
- **Opening local data never depends on the network.** Wallets open offline;
  connecting is sync's job, and a network problem shows as `progress.error` on
  a wallet that is still fully there.
- **Nothing fails silently.** A wallet that can't open is listed with its
  reason; a wallet that can't be saved says so until it can.

UI rules: no button that silently does nothing; every step of a flow has a way
back; unfamiliar ideas get an (i) explanation.

# Checks

`npm run check` runs all of these; run it before every commit.

- `tsc --noEmit`: the UI against the generated types. Change a Rust type and
  every place that relied on the old shape fails here.
- `npm run dupes` (jscpd): copy-pasted code over 1% fails. Block comments are
  ignored, since id-style banners repeat on purpose.
- `vitest run`: UI tests. `ui_store.test.ts` covers every case of `St_Screen`;
  `ui_main.test.tsx` starts the real app against a mocked engine in each startup
  situation. When fixing a bug, first write the test that fails because of it.
- `cargo test --lib`: engine tests, plus `bindings_are_fresh`, which fails if
  `src/bindings.ts` doesn't match the Rust. `npm run bindings` regenerates it
  (debug builds do too).
