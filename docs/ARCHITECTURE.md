# Architecture

```
 React UI (src/)                      Rust engine (src-tauri/src/)            zingolib (vendor/)
 ─────────────────                    ────────────────────────────            ──────────────────
 ui_main.tsx   picks the screen       lib.rs     Sys_: startup, bindings,     LightClient per wallet:
 ui_home.tsx   switcher, balances                shutdown                     keys, sync (pepper-sync),
 ui_backup.tsx backup flow            w_cmds.rs  W_*_f: the commands          balances, transactions
 ui_restore    restore flow           w_main.rs  wallet registry, accounts
 ui_sheets     dialogs                w_sync.rs  one engine per wallet,
 ui_store.ts   cache of engine state             progress events
 ui_text.ts    every sentence         w_net.rs   server, block times, errors
 bindings.ts ◄── generated ────────── w_phrase.rs recovery phrases
               (tauri-specta)         w_local.rs types, constants, globals
```

## The one line between UI and engine

Every type, command, event and constant the UI uses is declared in Rust and
exported to `src/bindings.ts` by tauri-specta (`Sys_Specta` in `lib.rs`). The UI
calls `commands.wCreateF(...)` and listens with `events.syncEventT.listen(...)`.
Nothing on the UI side declares its own copy. See STYLE.md for the rules.

Errors: every command returns `wresult_t<T>`; a failure is thrown in the UI as the
plain-language message written in `werr_t` (`w_local.rs`).

## Wallets, accounts, pools

- A **wallet** is one recovery phrase (`WK_SEED`) or one viewing key
  (`WK_VIEWONLY`). It lives in its own directory with zingolib's file and our
  `laurel.json` (`meta_t`: names, backup flag, creation time).
- A wallet holds one or more **accounts** (ZIP-32 indexes). Accounts are the
  privacy boundary: nobody on chain can link them. One backup covers them all.
- Each account's money sits in four **pools**: Ironwood, Sapling, Orchard (legacy,
  drains to Ironwood), Transparent. Pools are a breakdown, not a place you open.

Adding an account restarts that wallet's sync engine so it learns the new keys.
An account "used before" (in another app) triggers a rescan from the birthday,
since its old payments are only found by scanning history.

## Concurrency (Rust)

- `w_registry` (`w_local.rs`) maps wallet ids to slots. Take it only to find a
  wallet (`W_Slot`), then let go. (It was once named `w`, which collided with
  the most natural short name for a wallet three times.)
- **A slot's own `RwLock` guards names and settings only, briefly.** The engine
  has its own handles in the slot:
  - `client`: an `Arc<Mutex<LightClient>>`, so engine calls run one at a time;
  - `wallet`: the engine's `Arc<RwLock<LightWallet>>`, for snapshot reads.

  Take the handles out, drop the slot guard, then do the slow part. A send
  that takes twenty seconds holds only the client, and every read of that
  wallet (Receive, summary, History, a rename) still answers. Test:
  `ui_answers_while_a_send_holds_the_client`.
- **Enforced:** `npm run lint` fails on:
  - a tokio `RwLock` guard (slot or wallet) held across an `.await`
    (`await_holding_invalid_type`, configured in `clippy.toml`);
  - a std mutex guard held across an `.await` (`await_holding_lock`).

  The two places where holding is harmless (the only await reads memory) carry
  an explicit `allow` with the reason.
- `W_Load` runs under `w_loadLock`, so two callers can't open one wallet file twice
  (two engines saving one file would corrupt it).
- `w_adding` lets only one wallet be added at a time.
- Every snapshot (`walletSummary_t`) and sync event (`syncEvent_t`) carries a `seq`
  from `w_seq`, taken before the data is read.

### The engine's lock: never wait on it without a limit

While it syncs, pepper-sync holds its wallet **write** lock across network
requests: it fetches transactions and tree states mid-batch. On a slow link a
batch takes seconds, then the next batch starts. Anything that waits on that lock
without a limit can wait for the whole sync. That's how "Getting your address…"
never finished. The same bug was in showing the recovery phrase, shielding,
adding an account and stopping sync.

The rule is enforced, not remembered:

- `w_engine.rs` is the only code that can reach the lock. It offers four forms:
  - `E_TryRead` never waits.
  - `E_Read` and `E_Write` wait at most 15 s, then return `WERR_SYNC_BUSY`
    ("Laurel is in the middle of a sync step").
  - `E_Idle` is for when sync isn't running.
  - `E_WriteWhenFree` is for the background saver.
- `src-tauri/clippy.toml` bans `LightClient::wallet` everywhere else, along with
  every engine method that locks inside or drives sync. `npm run lint` is part of
  `npm run check`, so a new unbounded wait fails the build.
- Each slot keeps a `slotCache_t` outside the engine's lock:
  - balances, heights, addresses and balance history;
  - the "caught up this session" fact;
  - the ETA baseline;
  - the birthday.

  Reads fall back to it when the engine is busy. Addresses are filled when a
  wallet opens, before sync starts, so Receive never waits.
- Test: `ui_answers_while_the_engine_holds_its_lock` holds the lock the way a
  batch does and requires Receive, balances, history and progress to answer
  within 1 s. It was mutation-tested: without the address cache it fails with
  `Elapsed`.

The real fix is in the engine (fetch outside the lock, then lock to apply): ours
to make in the fork when the workaround stops being enough. See ENGINE.md.

### Payments: quote, intent, confirm

Every payment (send, shield, Orchard→Ironwood move) is built twice:

1. **Quote** (`W_QuoteSend`, `W_QuoteShield`, `W_PlanMigration`): the engine
   builds the proposal inside a fence, Laurel reads the numbers, and the
   proposal is cleared at once. Nothing stays open while the person reads,
   so sync keeps running and nothing can expire under them.
2. **Confirm** (`W_SendNow`, `W_ShieldNow`, `W_MigrateNow`): built again in one
   hold of the engine and sent only if the result equals what was shown
   (`E_SendIfSeen`); otherwise the new numbers come back as `CHANGED` for
   another look.

The numbers alone don't bind the *count*. The same confirm arriving twice
(a click past the UI's guard, a call retried after its answer was lost)
finds the first payment's coins spent, builds the same payment from other
coins, and the numbers match. So every quote is handed out under an
**intent** (`quoted_t { intent, quote }`): a random id kept in
`w_engine.rs` until a confirm hands it back. `W_Paying` takes the intent out
of the table before anything else, so one review can be attempted once; a
second attempt is refused (`WERR_PAYMENT_DONE`). An intent also names its
wallet and account, so an approval can't be carried to another one, and a
closed wallet's intents are forgotten (`W_Close`).

Right after a payment goes out, still inside the hold, the wallet is written
to disk (`W_SaveAfterSend`): a payment the wallet knew only in memory is one
a crash forgets, and a wallet that forgot a payment can build it again.

## Sync

Each wallet runs a zingolib sync engine that never finishes: after reaching the
tip it keeps watching for new blocks. `Sync_Pump` (`w_sync.rs`) forwards its status
and every account's balance to the UI at most every 250 ms as `syncEvent_t`.
Statuses arriving meanwhile collapse into the next event.

What the UI is told, all computed in Rust (`Sync_ProgressOf`), never guessed in
TypeScript:

- **Complete**: the engine said so. Once it has said so this session, a wallet up
  to 30 blocks (about 12 minutes) behind is *keeping up*, not syncing. Otherwise
  every new block (every 25 s since NU7; 10 blocks at 75 s before) flashed
  "Syncing 99%". A real gap, like waking from sleep, shows
  "Syncing" again.
- **ETA**: from this stretch's own pace. None until 20 s of steady progress,
  because no estimate beats a wrong one.
- **Paused**: this session only (`Sync_Pause_f` / `Sync_Resume_f`), so a
  forgotten pause can't leave a wallet silently out of date.
- **Retry**: an attempt in flight (`attempting`) and when the next one starts
  (`nextRetryAt`). "Try Now" answers at once with "Trying…", then either
  connects or says "Still offline".
- **Birthday date**: asked of the server once, so sync reads as dates ("since
  March 3, 2025"), not block heights.

The sync sheet (`ui_sync.tsx`, opened from the status capsule) shows:

- a progress ring, the stretch of dates being checked, and one sentence;
- what is stored on disk;
- Pause/Resume;
- one (i) explaining why a private wallet syncs at all.

## Disk space

Measured on a real install:

| What | Size |
|---|---|
| Wallets + vault | 19 KB |
| WebView2 profile | 185 MB |
| … of which HTTP cache | 101 MB |
| … JS code cache | 50 MB |
| … Edge components (ad-block lists, speech, hyphenation) | 25 MB |

The space was the embedded browser's, so that is where it's fixed (`w_storage.rs`):

- The main window is created in code (`Sys_MainWindow`, `"create": false` in
  tauri.conf.json). It launches the browser with its disk caches and component
  downloads off (`STO_BROWSER_ARGS`).
- Before the window exists, `Sto_Janitor` deletes a named list of cache folders.
  It never touches Local Storage (the UI's preferences), and a test checks that.
- `tauri-plugin-single-instance` is registered first. A second launch focuses
  the first window, so no second engine can write the same wallet file, and no
  cleanup can race a live browser.
- Settings → Storage shows what the engine measured: wallets, app, temporary
  files, and free space. Home warns below 200 MB free on the wallet disk,
  before a save could fail.

The result is 185 MB down to 12 MB, with preferences kept.

The wallet file itself stays small by design: pepper-sync keeps only the
wallet's own notes and the commitment-tree shards it needs, never blocks.
Compressing a 19 KB file would complicate the encrypted format for nothing, so
we don't.

## UI state

`ui_store.ts` (Zustand) is the UI's only copy of engine state. `St_Start` attaches
the event listener **before** the first `W_List_f`, so nothing falls in the gap,
and runs once however many times it is called. Updates older than the stored
`seq` are dropped, so a slow reply can't roll a balance back.

Screens call the engine through `useAction()` (busy state, error, double-click
guard) and, for requests fired while typing, `useLatest()` (newest answer wins).

## Startup and shutdown

- Start: `Sys_Run` writes the bindings (debug only), mounts events, and
  `W_Init`s the data directory. The UI's first `W_List_f` opens every wallet on
  disk (migrating the old single-wallet layout if found) and starts their sync.
- Exit: closing the window or the app goes through `Sys_Close`, once. The window
  shows "Saving your wallets…" (`closingEvent_t`) while `W_Shutdown` stops every
  engine and saves every wallet, all at once, within `SHUTDOWN_BUDGET_SECS`
  (the engine stop plus the writes), then the app exits.

## Encryption at rest

`w_vault.rs` holds the one random **wallet key** that encrypts every wallet file
and `laurel.json` (XChaCha20-Poly1305, fresh 24-byte nonce per write, the file's
purpose bound as associated data). `laurel-vault.json` stores that key protected
by Windows DPAPI (default; stops copies on other machines, not same-user malware)
or wrapped by a password key (Argon2id, 256 MiB, t=3, p=4; about 0.4 s on a
desktop CPU). A file asking for less than 64 MiB, 3 passes or a 16-byte salt,
or more than 1 GiB, 10 passes or 8 lanes, is refused as damaged before
anything is derived. Changing the password re-wraps only the key.

Saving: zingolib is built with `no-plaintext-save`, which removes its own savers.
Each wallet has a saver (`W_StartSaver`, every 2 s) writing through
`W_WriteWallet`: serialize and `mark_saved` under the wallet lock, seal, write
atomically (`w_disk.rs`), `mark_dirty` again on failure. A per-wallet `saveLock`
keeps writes in order. A plain wallet or names, contacts, notes, reminders or
signing-requests file is refused (`WERR_NOT_SEALED`), never read: encryption
came before the first release, so a plain one was put there.

Rules that keep wallets reachable: a new key is only made when no encrypted
wallet exists; the vault file is only replaced atomically; nothing unexpected in
it is guessed at.

## Offline first

`W_BuildConfig` never sets a server, so opening a wallet is purely local.
`w_sync.rs` connects each wallet (`Sync_Connect`, outside any lock), starts its
engine, and keeps retrying with backoff (5 s up to 60 s) while the network is
unreachable, recording the reason in `progress.error`. An engine that stops on
its own is restarted, except during shutdown.
