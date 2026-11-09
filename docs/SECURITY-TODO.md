# Security todo: the money-loss audit

**In short:** an outside list of 100 ways a self-custody wallet loses money,
mapped onto Laurel. Each case is handled in Laurel's code (with the file that
does it), owned by the engine (librustzcash, zingolib), or doesn't apply (no
tokens, dApps, swaps or hardware wallets). What is still open comes first:
section F (a broadcast that may have gone out) and E (the release gate), both
before mainnet.

Status as of 2026-09-27. The source is an outside list of 100 money-loss test
cases for self-custody wallets. This maps each onto Laurel (a Zcash-only
desktop wallet on zingolib: no tokens, no dApps, no hardware wallets, no
swaps) and records what was fixed, what the engine owns, and what is still
open, with the file that owns each.

"Loss" here means theft, payment to the wrong place, an unintended fee, funds
nobody can reach any more, or acting on a confirmation that never happened. A
refused payment or a rescan is not a loss; paying twice or deleting keys is.

Legend: **Fixed** (this pass; see "What changed") · **Done** (already handled)
· **Engine** (librustzcash / zingolib own it; Laurel must not re-implement it,
but must test it end to end before mainnet) · **Todo** (open, with its file)
· **N/A** (no such feature in Laurel)

## Open todos, in order

Release blockers before mainnet come first. Each names its files.

### A. Payments that could happen twice

Done 2026-09-27 (see "What changed"). Left for the release gate (E): a
kill-mid-send run on testnet, counting payments on chain.

- [x] **Pending payments shown as what they are, and expired ones as expired**
      (cases 64, 68). A payment that isn't mined for 120 blocks (40 before NU7) expires and its
      coins come back; until then it shows as pending. A person who sends
      again meanwhile has made a second payment, and both can confirm.
      Show expiry (height and a countdown) on a pending line, say plainly
      that a pending payment can't be cancelled, and show expired and failed
      transactions as such. Files: `src-tauri/src/w_history.rs`
      (`W_ReadTransactions`: read `ConfirmationStatus` fully, not just
      `is_confirmed`), `src/ui_history.tsx`, `src/ui_text.ts` (`T.history`),
      `src/ui_send.tsx` (a note on review when this account has a pending
      send).
- [x] **A signed payment the process died on** (case 66). zingolib records a
      transaction as `Calculated` before it transmits it; the wallet is now
      written right after a send (`W_SaveAfterSend`), so a crash mid-send
      leaves a `Calculated` transaction on disk. Decide, on load, what
      happens to one: transmit it, or mark it failed and free its coins.
      Never silently forget it. Files: `src-tauri/src/w_main.rs` (`W_Load`),
      `src-tauri/src/w_engine.rs` (an `E_` form over
      `LightClient::transmit_calculated`), a kill-mid-send test in
      `src-tauri/src/w_main.rs`.
- [x] **A server that lies about a broadcast** (case 68). The receipt shows
      the txid the engine computed, not one the server returned, which is
      right. What's missing is the follow-through: a pending line that never
      gets mined must become "expired" (above), never stay "pending" forever.
      Same files as the first item.

### B. Recovery must be proven, not assumed

Done 2026-09-27. The restore gate is in DEVELOPMENT.md and was run live.

- [x] **Clean-device restore from the phrase alone, as a release gate**
      (cases 11, 16, 75, 81, 89). On testnet: fund a wallet in every pool,
      spend from each (so change exists in each), pay a `tex1` address (so
      an ephemeral transparent address was used), then remove the wallet
      and restore it from only the phrase and the birthday. Everything
      spends again, including change and a refund sent later to the
      ephemeral address. Write the procedure into `docs/DEVELOPMENT.md` and
      run it before every release. Owner of the engine side:
      `vendor/zingolib` (`TransparentAddressDiscovery::recovery()` in
      `W_RestoreSettings`, `src-tauri/src/w_main.rs`).
- [x] **Account discovery on restore** (case 16). Chosen: say it, where it
      matters (restore screen, Add Account "used before", Help "money is
      missing after I restored"). Scanning ahead for accounts would cost a
      full scan per account; a transparent-only probe would miss shielded
      ones and wrongly reassure. Restore asks how many
      accounts the wallet used (1 to 5). Guess low and the rest looks like
      it's gone. Either discover accounts by scanning ahead (engine) or say
      on the restored wallet that more accounts can be added under
      "used before" and are rescanned. Files: `src/ui_restore.tsx`,
      `src/ui_sheets.tsx` (`UI_AddAccountSheet`), `src/ui_text.ts`.
- [x] **Backup check strength** (cases 6, 12). A third of the words; any
      wrong pick starts over (a free retry per row let 12 clicks pass it with
      no paper); a passphrase is typed back exactly. Three words of four choices
      pass a backup that is 12 words short. Consider asking for every word
      once, or at least a random third of them, before the wallet is marked
      backed up. The engine checks the answers too: `W_MarkBackedUp` marks a
      wallet only when they are a third of its words at their places, and its
      passphrase (`E_PhraseMatches`), so a wallet can't be marked, then removed
      as safe, by a call that skips the check. Removing one asks who is there
      (`V_Confirm`) and shreds its whole folder (`Com_ShredTree`). Files:
      `src/ui_backup.tsx` (`VERIFY_SHARE`), `src/ui_wallets.tsx`
      (`UI_RemoveSheet`), `src-tauri/src/w_main.rs` (`W_MarkBackedUp` stays
      the only writer, `W_RemoveWallet`).
- [x] **Vault rewrap read-back** (case 22). Every key-file write, the
      first-run ones too, through `V_Commit`: written, read back, opened with
      the new secret, else undone. After a password change the new
      file is written atomically; add a read-back that unwraps the just
      written file with the new password before returning, so a write that
      landed wrong is caught while the old password is still known. File:
      `src-tauri/src/w_vault.rs` (`V_Rewrap`, `V_SetPassword`).

### C. What the screen says

- [x] **The log audit for engine text** (case 26). Decided at the sink, not
      per path: every line, Laurel's and the engine's crates' alike, passes
      `Com_LogSafe` (w_log.rs, the log plugin's formatter), which masks each
      word that parses as an address, a transaction id or a key. `WERR_ENGINE( detail )` is
      logged whole. The engine's proposal and send errors can quote amounts
      and, in principle, a recipient. Decide per path whether the detail is
      logged, the way `WERR_TYPED` already withholds typed input. Files:
      `src-tauri/src/w_local.rs` (`LogText`), `src-tauri/src/w_engine.rs`
      (`E_SendProposal`), `src-tauri/src/w_net.rs` (`Com_Classify`, the one
      place engine errors become Laurel's, and `Com_CauseChain`).
- [x] **Network and account on the review screen** (cases 25, 31).
      `UI_ReviewFrom` on Send, Shield, Sweep and Move ("Testnet · Main ·
      Savings"; mainnet in the warning colour). The
      engine now refuses a request for the other network (`W_CheckNetwork`)
      and binds a quote to its account (the intent), but the person doesn't
      see either. Show "Testnet · Main · My Wallet" on review. Files:
      `src/ui_send.tsx`, `src/ui_shield.tsx`, `src/ui_text.ts`.
- [x] **A fee that looks wrong** (cases 45, 46). `Com_FeeNote` (Rust, one
      owner): at 50,000 zatoshis or more, or over a tenth of the amount, the
      review says why (many small coins, a small payment, or high). ZIP 317 fixes the fee by
      rule, and review shows it, but a wallet of a thousand dust notes can
      pay a fee larger than most people expect. Above a threshold, say so
      in words on review ("this fee is high because …") before Send is
      enabled. Files: `src-tauri/src/w_engine.rs` (`E_ProposeSend`),
      `src/ui_send.tsx`.
- [x] **Look-alike addresses** (case 35). Review names the contact or past
      recipient (sent side only) whose ends a new address copies
      (`Com_LookAlike`); a saved contact's changed address is shown whole,
      old and new, before it counts. When History gains "pay again",
      offer it only from payments this account *sent*, never from received
      ones (a poisoner can only write to the received side). When contacts
      gain address editing, confirm the change against the old address in
      full. Files: `src/ui_history.tsx`, `src/ui_contacts.tsx`.
- [x] **Untrusted text stays inert** (case 27). Text nodes only
      (check_owners refuses `dangerouslySetInnerHTML`); a memo, label or
      message that asks for a phrase or key gets a warning
      (`Com_MemoAsksForSecrets`); rows clip long memos. Memos, ZIP 321 labels and
      messages are rendered as text nodes (React escapes them) and nothing
      in them is clickable. Keep it that way; cap the length shown; never
      turn a memo's URL into a link. Files: `src/ui_history.tsx`,
      `src/ui_scan.tsx`.

### D. Shutdown, storage, engines

Done in this pass (see the table below): the shutdown budget, the
transparent gap, duplicate wallets by any account.

### F. A broadcast that may have gone out: open before mainnet

From the security reviews of A-03 (T-036, T-041).
T-043's offline retry/Forget condition was closed in c8c55a7 (T-045).
The following also remain open before mainnet:

- [ ] **The migration's rounds broadcast before the wallet is written**
      (`build_and_transmit`, vendor/zingolib migrate.rs): a stop between
      the two loses a part and its reserved notes. Save between build and
      broadcast in the engine's round loop. The testnet-only build refuses
      the move meanwhile (`W_MigrateOffered`).
- [ ] **Mixnet: a later stage can hide an earlier delivery.** Only a last
      `RemoteRejected` is downgraded; a later `LocalProxyConnect` still
      passes `proves_unsent`. Carry "may have delivered" across attempts
      apart from the last stage. nym is off in Laurel.
- [ ] **A reminder's link to its payment isn't kept.** It moves on in
      `W_SendNow` after the send; if `Rp_Done` fails it only logs. Persist
      the link with the waiting payment and settle it after a restart.
- [ ] **No expiry (0) never ends.** Such a payment waits, and holds its
      offline account, forever. Not a timed release: say it on screen.
- [ ] **Tests still to write:** a save that replaces the file then fails,
      and a restart after it; the automatic send after a failed save; a
      mixnet attempt that may have delivered, then a connect failure; a
      migration stopped between broadcast and save; a stop between an
      offline broadcast and its mark; a scan gap at expiry; a reminder
      whose save fails; the offline workflow end to end (a lost answer, a
      retry that can't connect, then Forget and a new request both
      refused; a stale reading settling a newer mark), where today only
      its parts are tested (`w_offline.rs`).

### Known limit: a signed payment lives in the wallet file

A payment Laurel signed but can't yet see on the chain (unsent after a
stop, or unsure after a broadcast) is kept only in that wallet's file,
Calculated, and its coins reserved there. Restoring the wallet from its
phrase on another computer, or putting back an older copy of its files,
starts without it: those coins look free until the payment shows up on
the chain. If it had gone out, a new payment from them can be the second
of two. Before restoring a wallet that has a payment waiting ("Not sent
yet" in History), wait until it shows as sent or as "Didn't go through".
Nothing in the phrase can carry it; say it where restoring is offered
(Help, "money is missing after I restored").

### E. The release gate

Before any mainnet build, run each applicable case below against the real
engine on testnet, not a mock:

1. Decode every transaction Laurel sends and check: inputs = payment +
   change + the fee that was shown. Check the recipient received it. Run
   2026-09-27 on testnet (`audit`, DEVELOPMENT.md): all 117 transactions
   the glory test wallet ever paid for, fetched raw from the server and
   decoded apart from the wallet's records: each spent exactly its payment
   + change + the fee in its own bytes, and every fee (10,000 to 40,000,
   by shape) was ZIP 317's. The recipient side is E.2's count.
2. Kill Laurel at each step of a send (after Review, during proving, right
   after broadcast, before the saver's next tick) and restart. Count the
   payments on chain: exactly one. Run 2026-09-27 on testnet with the
   harness (`killsend`, `resume`, `count`; DEVELOPMENT.md): signed and
   saved but never sent, then killed: the restart found 1 unsent, sent it
   once, mined at 4402638. Sent, then killed before any save: the restart
   found 0 unsent and the payment already in the mempool from the chain,
   mined at 4402639. The recipient counted each amount exactly once.
   Killed after Review or during proving nothing is signed or kept, so
   nothing can go out. Run again before release.
3. The clean-device restore in B, ending in a spend from every pool. Run
   2026-09-27: the restore gate (DEVELOPMENT.md) for Ironwood, Sapling,
   transparent and TEX refunds; and for Orchard, which only the migration
   spends since NU6.3: the public glory wallet restored from its phrase
   alone matched in every pool to the zatoshi (Orchard 3,995,298,000),
   then moved its Orchard through Laurel's own path (2 transactions,
   3,994,689,000 moved, 140,000 fee, 469,000 left as too small to move),
   and its 119 paid transactions all balanced (`audit`).
4. Open the log file after a session of typos, failed restores and failed
   sends: no phrase words, no addresses, no amounts. Run 2026-09-27 on a
   real two-day log (609 lines, scanned for phrase runs, every address
   kind, keys, amounts, txids; counts only): no words, addresses or keys;
   64-hex hits were block hashes (public); one amount, inside an engine
   error, now masked. Lines written before 2026-09-27 are not masked and
   stay until the log rotates (`LOG_MAX_BYTES`, one file kept). Run again
   before release.

## What changed in this pass

| Fix | Cases | Files |
|---|---|---|
| **Recovery proven live**: the restore gate (every pool funded and spent, a TEX payment, restore from phrase and birthday in an empty folder, a later refund to the ephemeral address found, everything spent). | 11, 75, 81, 89 | `src-tauri/engine/examples/live.rs`, `docs/DEVELOPMENT.md` |
| **The key file is proven on every write** (`V_Commit`, the only writer): read back and opened with the new secret; a bad write is undone. | 22, 30 | `src-tauri/src/w_vault.rs` |
| **The backup check proves the paper**: a third of the words, a wrong pick starts over, the passphrase typed back. | 6, 12 | `src/ui_backup.tsx`, `ui_backup.test.tsx` |
| **Missed accounts are explained where they're missed** (restore, Add Account, Help). | 16 | `src/ui_restore.tsx`, `ui_text.ts` |
| **Every engine transaction state is read as itself** (`txState_t`: confirmed, pending with its expiry height, unsent, failed; `Com_TxState` has no default). "Not confirmed" once covered an expired payment, shown as pending forever. A failed payment's change also showed as money *received*, in History, the balance chart and payment notices. Now it's "Didn't go through" (nothing was paid, the money is back), out of the chart, and never announced. | 64, 68 | `src-tauri/src/w_history.rs` (`Com_TxState`, `W_ClassifyFailed`, `W_FlowsOf`), `w_local.rs` (`txState_t`), `w_sync.rs` (`Com_Look`); `src/ui_history.tsx` (`Com_TxStateView`), `ui_toast.tsx` |
| **A pending payment says when it expires**, as a time, and that it can't be cancelled ("don't send it again"). **Send's review warns** when this account already has a payment waiting: sending is a second payment, not a retry. | 64, 68, 61 | `src/ui_history.tsx`, `ui_send.tsx`, `ui_text.ts`; `constants_t.blockEras` |
| **A payment a stop left unsent is sent again**, once the wallet has caught up (sync reads the mempool and the chain first, so one that did go out is by then pending or confirmed, not unsent). It is never failed by Laurel: failing it frees its coins, and if it had gone out, a second payment would pay twice. Sending the same transaction again is harmless. `transmit_calculated` is reachable only through `E_TransmitUnsent` (clippy). | 66, 62 | `src-tauri/src/w_sync.rs` (`Sync_SendUnsent`), `w_engine.rs` (`E_UnsentOf`, `E_TransmitUnsent`), `clippy.toml` |
| Every quote is handed out under an **intent**; a confirm hands it back and it is taken before anything is built. One review, one attempt: a second Send/Shield/Move with the same intent is refused (`WERR_PAYMENT_DONE`) instead of paying again from other coins. The intent names its wallet and account. | 25, 61, 62, 67, 96 | `src-tauri/src/w_engine.rs` (`E_Intend`, `E_TakeIntent`, `E_ForgetIntents`), `w_local.rs` (`quoted_t`, `sendResult_t`, `shieldResult_t`, `migrateResult_t`), `w_main.rs` (`W_Paying`), `w_send.rs`, `w_shield.rs`, `w_migrate.rs`, `w_cmds.rs`; `src/ui_send.tsx`, `ui_shield.tsx`, `ui_migrate.tsx`, `ui_send.test.tsx` |
| The Orchard→Ironwood move is **planned again and compared** with the plan the person saw before anything moves; a changed plan comes back for another look. It also waits for a wallet near the tip, like a send. | 53, 88 | `src-tauri/src/w_migrate.rs`, `src/ui_migrate.tsx` |
| The wallet is **written to disk right after a payment goes out**, still inside the engine hold, instead of at the saver's next tick. | 62, 66 | `src-tauri/src/w_main.rs` (`W_SaveAfterSend`), `w_engine.rs` (`E_SendIfSeen`) |
| **A broadcast that may have gone out keeps its coins** (2026-10, security review A-03). Every failed broadcast freed its notes, also a timeout after the bytes left or an answer that wasn't about the transaction, and History said the money was back: a new payment could spend other coins while the first went through. The engine now frees them only when nothing went out (the bytes never left, or a server refused the transaction itself); otherwise it stays Calculated, Laurel says "may have gone out, don't send it again", and sends the same payment again once caught up, or it expires and the coins come back. The signed payment is also **written to disk before a byte leaves**; a write that fails sends nothing. | 62, 64, 66, 68 | `vendor/zingolib` (`TransmitError::proves_unsent`, `transmit::invalid_on_its_own`; ENGINE.md), `src-tauri/src/w_engine.rs` (`E_SendProposal`), `w_net.rs` (`WERR_SENT_UNSURE`), `w_sync.rs` |
| **Price alerts ask nothing while prices are off**, and say what they do ask: with one waiting, the hour's prices every two minutes (CONTROL-MAP.md). They go off on a crossing between two looks, once each, never on the first look after starting. Kept apart from the settings, which the ui saves whole and would bring back an alert the engine marked gone off. | 30 | `src-tauri/src/w_alert.rs`, `src/ui_alert.tsx`, `docs/CONTROL-MAP.md` |
| **A repeating payment never pays by itself**: it is a reminder, sealed (PURPOSE_REPEATS); when due the engine says so (the app, and the system's notice without the amount), Send is filled in and the person reviews and sends. Paid or skipped, it moves one period on; periods missed while Laurel was closed stay due, never skipped quietly. | 61, 84 | `src-tauri/src/w_repeat.rs`, `w_date.rs`; `src/ui_repeat.tsx`, `ui_send.tsx` |
| **One clock and one calendar** (`w_date.rs`): seven places read the clock, three through helpers of their own; check_owners now allows it nowhere else. A month on keeps the day it was set for (the 31st comes back after February). | — | `src-tauri/src/w_date.rs`, `scripts/check_owners.mjs` |
| **No number is ever cut on screen**: the layout check flags any cut-off text holding a digit, at five exact sizes. It found "0.05 T..." in a Quick Actions hint above 880px tall, a height the check had never drawn: its window's frame shrank every size, silently; it now fails unless the page reports the size asked for. | 42 | `mock.html`, `scripts/check_layout.mjs`, `src/ui.css` |
| **No dollar value for test coins**: the price is real ZEC's, so an account's value on testnet would have been a real-looking number for play money; the engine refuses it (`WERR_TEST_COINS`). A value is hidden with the amounts. | 30 | `src-tauri/src/w_price.rs` (`W_ValueHistory`, `Com_ValueSeries`), `src/ui_price.tsx` |
| **Test values come from one builder each**: six hand-written settings objects had gone stale, four of them missing fields that a cast or an untyped mock hid from the compiler; check_owners now refuses a value's telltale fields in any test but `test_engine.ts`. | — | `src/test_engine.ts`, `scripts/check_owners.mjs`, `docs/DECISIONS.md` |
| **The total of several payments is what was asked**, not what the last step pays: with an exchange-only (TEX) recipient the proposal takes two steps and the last pays only it; read from there, review would have said 133,333 for a payment of 277,777 (live, testnet, 2026-09-28). A **pasted list** of payments (bulk payouts) is read line by line, every problem said by its line. | 41, 39 | `src-tauri/src/w_engine.rs` (`E_ProposeSend`), `src/ui_pays.tsx` (`Com_ReadPayList`, `UI_PayListSheet`) |
| A ZIP 321 request with **several payments is paid whole or refused whole**: read with every payment (each address on this network, each with its amount, at most 20), shown in Scan, Send and review, sent in one transaction whose quote holds every payment, so sending compares all of them with what was reviewed. Without an amount for each it is refused (`WERR_MULTI_PAYMENT`); Max is for one recipient (`WERR_MAX_ONE`). It was once refused outright, not to pay only its first. | 37, 39 | `src-tauri/src/w_scan.rs`, `w_send.rs` (`Com_CheckPays`, `W_Propose`), `w_engine.rs` (`sendWhat_t`); `src/ui_pays.tsx`, `ui_send.tsx`, `ui_scan.tsx` |
| A request's **message is no longer sent back as the memo**; only its memo is. | 38 | `src/ui_send.tsx`, `src/ui_home.tsx` |
| A proposal **without an amount is refused** before it can be shown as 0 or sent. | 41, 51 | `src-tauri/src/w_engine.rs` (`E_ProposeSend`) |
| ZEC amounts are formatted with **whole-number arithmetic**, exact to the last zatoshi; a float division could round the last digit of a large amount. | 41, 42 | `src/ui_local.ts` (`Com_FormatZec`), `ui_local.test.tsx` |
| A wallet's **birthday date is "not known" when the server can't say**, never "Today" for a restored wallet. | 81 | `src-tauri/src/w_local.rs` (`recovery_t`), `w_main.rs` (`W_Recovery`), `src/ui_backup.tsx`, `ui_text.ts` |
| Create and restore **refuse a request for the other network** (`W_CheckNetwork`). | 31 | `src-tauri/src/w_main.rs` |
| The **same phrase or viewing key is refused a second time** (`WERR_WALLET_EXISTS`): two engines over one set of coins would each spend what the other doesn't know is spent, and show the money twice. Wallets are compared by **every account's viewing keys, each part apart** (Orchard, Sapling, transparent), no longer by the first account's addresses: a viewing key exported from a second account is the first account of the wallet made from it, and slipped past. | 2, 67 | `src-tauri/src/w_addr.rs` (`W_Fingerprint`), `w_main.rs` (`W_SameWallet`, test `a_viewing_key_of_any_account_is_that_wallet`), `w_local.rs` (`slotCache_t.fingerprint`) |
| **The balance never promises Send more than it can use**: private money the engine is still checking (mined deep enough, its witness, known unspent) is said apart, on the card and in Send, from the engine's `shielded_spendable_balance`; none for a viewing key. | 41, 51 | `src-tauri/src/w_main.rs` (`W_AccountBalance`), `src/ui_local.ts` (`Com_Split`), `ui_home.tsx`, `ui_send.tsx` |
| **A wait never looks hung**: every spinner with words is `UI_Waiting`, which after 4 s says how long (ticking) and after 20 s why it can be slow; check_owners refuses a spinner with words anywhere else. Fourteen waits had fixed words; six were only found by that rule. | 30 | `src/ui_widgets.tsx` (`UI_Waiting`), `scripts/check_owners.mjs` |
| **Every screen is measured at every size that matters** (`npm run layout`, in the gate): a real browser draws `mock.html` at four sizes and fails on any amount cut or page wider than its window. It exists because a fix for large text stacked the balance at the default size, unseen. | 42 | `scripts/check_layout.mjs`, `mock.html` |
| **A payment that didn't go through is said, not only shown**: the engine announces a sent payment when it settles, either way ("the money is back"), besides arrivals. It looks when confirmed or pending money changes, not only the total, which a confirmation leaves the same. | 64, 68 | `src-tauri/src/w_sync.rs` (`Com_Look`), `src/ui_toast.tsx` |
| **A closed sheet gives the keyboard's focus back** to what opened it; Radix without a trigger dropped it on the page's start, for every sheet. Found by a keyboard test. | 21 | `src/ui_widgets.tsx` (`UI_Sheet`), `ui_keyboard.test.tsx` |
| **A screen that throws can't blank the window**: a boundary says so and draws again (the engine and its saves run apart). Found by rendering the real screens outside Tauri (`mock.html`). | 30 | `src/ui_main.tsx` (`UI_ErrorBoundary`) |
| **An amount is never cut**: at a large text size the balance split showed "12..." for 12.80; it stacks instead, and check_owners refuses a rule that could cut an amount. | 42 | `src/ui.css`, `scripts/check_owners.mjs` |
| **Checksums for every release**, and a build that pins what varies (time, paths, lockfiles); `CARGO_ENCODED_RUSTFLAGS`, because the repository's path has a space. | 29 | `scripts/release.mjs` |
| **A payment signed offline is checked before it is sent**: the viewing key takes the signed transaction apart; every output that isn't change must be one of the payments asked for (receiver, amount, memo), and what it spends of the wallet, less the reviewed fee, less every output the key sees, must be zero, so an output hidden from the viewing key is refused; so is an input the wallet doesn't own. The request's state is taken in the same hold of the engine as its quote. | 31, 36, 47 | `src-tauri/src/w_offline.rs` (`Com_CheckSigned`), `w_engine.rs` (`E_SpentOfOurs`, `E_SnapshotFenced`) |
| **One version, with its notes**: the app showed `package.json`'s version and the price request's User-Agent `Cargo.toml`'s, two manifests nothing kept equal; a bump of one would have made Laurel say two versions. `check_version.mjs` requires both and the newest release notes to agree. The notes go beside the installers, in the checksums, and show once after an update. | 29 | `scripts/check_version.mjs`, `docs/RELEASE-NOTES.md`, `src/ui_notes.tsx` |
| **The program builds to the same bytes twice** (reproducible): two clean builds of one commit, in two folders, gave one `laurel.exe`, once `/Brepro` made the linker's stamps come from the content. | 29 | `scripts/release.mjs`, `docs/DEVELOPMENT.md` |
| **Orchard restored and spent** (release gate E.3): a wallet holding legacy Orchard, restored from its phrase alone, matched in every pool, and its Orchard moved out through Laurel's migration path. | 11, 53, 75 | `src-tauri/engine/examples/live.rs` (`restore`, `migrate`) |
| **Every text colour is readable** (WCAG AA, both appearances): checked from the tokens on every surface it sits on (`check_contrast.mjs`); 40 pairs were under, among them the amount on a highlighted menu row at 1.97:1 and the dark danger button's text at 2.9:1. A text colour written as a literal fails unless listed with its reason. | 21 | `scripts/check_contrast.mjs`, `src/ui.css` |
| **Every paid transaction audited from the chain** (release gate E.1): spent = paid + change + the fee in the transaction's own bytes, and that fee is ZIP 317's; 117 of 117 on testnet. | 41, 42, 49 | `src-tauri/engine/examples/live.rs` (`audit`) |
| **Transaction notes are sealed** (PURPOSE_NOTES) like the address book, through one sealed-file reader and writer (`V_ReadSealed`, `V_WriteSealed`) that contacts now use too. | 30 | `src-tauri/src/w_notes.rs`, `w_vault.rs`, `w_contacts.rs` |
| **Killed mid-send, paid once** (release gate E.2, live on testnet): a signed transaction a stop left unsent goes out once on the next start; one that went out before any save is found on the chain and not sent again. | 62, 66 | `src-tauri/engine/examples/live.rs` (`killsend`, `resume`, `count`), `docs/DEVELOPMENT.md` |
| **The balance split uses the engine's total**, the number the balance shows, instead of adding the pools up again in the ui. | 42 | `src/ui_local.ts` (`Com_Split`) |
| **Amounts are masked in the log** where a unit says what they are ("1250000 zatoshis", "Zatoshis(…)", "2.5 ZEC"): the engine's own errors carried a payment's size. A bare number can't be told from a height, so Laurel's own log lines may not name an amount at all (check_owners). | 3 | `src-tauri/src/w_log.rs` (`Com_IsAmount`), `scripts/check_owners.mjs` |
| **A phrase or a sync code is masked by its shape**: five or more phrase words in a row are `<words>`, a run of four-letter base32 groups (dashed or spaced) is `<code>`, whatever line formats them. Sync stops log `LogText`, not the engine's raw cause chain; the terminal target is on only in debug builds (a release's stdout is a phone's logcat); the key file's types have no `Debug`. | W1-04 | `src-tauri/src/w_log.rs` (`Com_Runs`, `Com_IsSyncCode`), `w_sync.rs`, `w_engine.rs` (`E_SyncOutcome`), `lib.rs` (`Sys_Logger`), `w_vault.rs` |
| **An exported memo can't run.** CSV cells that a spreadsheet would treat as a formula (=, +, -, @) start with an apostrophe; memos are left out unless asked for. | 22, 38 | `src-tauri/src/w_export.rs` (`Com_CsvCell`) |
| **Words about the code are checked too:** every file a doc or comment names must exist (`check_docs.mjs`); a class written in full on an element must have a rule it matches, not only a compound with another class; an action handed a named function is read through it (`check_loads`). | — | `scripts/check_docs.mjs`, `check_owners.mjs`, `check_loads.mjs` |
| **A phrase is shown only to someone just asked.** Reading a recovery phrase takes a `present_t`, which only `V_Confirm` makes (the password, checked against the key file, not the key in memory) and `V_Made` for the wallet `W_Create` just made (check_owners). A way around the question doesn't compile. Without a password the backup screen says anyone using this Windows account can show the words. The phrase is fetched when asked for, no longer when the screen opens. | 21, 29 | `src-tauri/src/w_vault.rs` (`present_t`, `V_Confirm`), `w_engine.rs` (`E_RecoveryInfo`), `w_main.rs` (`W_Recovery`), `w_cmds.rs`; `src/ui_backup.tsx`, `ui_security.tsx` (`UI_AskPassword`), `ui_backup.test.tsx` |
| **A Laurel left unlocked can't be set to stay unlocked.** A later auto-lock (or never) needs the password; a sooner one never asks. The engine decides (`S_LocksLater`) and answers `askPassword`; the generic settings save can't touch the auto-lock at all. Nor can the file: a wait it holds that isn't offered reads as the nearest offered below it, and a damaged file locks at the shortest waits, not never (W1-07, `S_Settle`). | 21, 29 | `src-tauri/src/w_settings.rs` (`S_SetAutoLock`), `w_cmds.rs`; `src/ui_security.tsx`, `ui_security.test.tsx` |
| **Secrets on screen can't be captured.** While a recovery phrase shows, and on screens where one or a key is typed (restore, sweep), the window is excluded from screenshots, recordings and shared screens (`useUncapturable`). | 21 | `src/ui_hooks.ts`, `ui_backup.tsx`, `ui_restore.tsx`, `ui_sweep.tsx`, `src-tauri/capabilities/default.json` |
| **Closing waits for the saves, and says so.** The budget is built from its parts (`SHUTDOWN_BUDGET_SECS` = the 30 s engine stop + 15 s to write), where a separate 10 s once lost the race to a 30 s stop. The window's close is held too, not only the app's exit, and the window shows "Saving your wallets…" until Laurel exits; a budget overrun is logged. | 66 | `src-tauri/src/lib.rs` (`Sys_Close`), `w_engine.rs`, `w_local.rs` (`closingEvent_t`); `src/ui_main.tsx` (`UI_Closing`), `ui_main.test.tsx` |
| **Transparent gaps**: each Laurel account gives out one transparent address, never a second, so Laurel leaves no gap for another wallet to stop at. A phrase restored into Laurel is searched in every scope (receive, change, refund) until 20 addresses in a row are unused, the count starting over at each used one (pepper-sync); pinned by a test. A wallet that left more than 20 unused addresses in a row is past what any wallet looks for. | 33, 89 | `src-tauri/src/w_main.rs` (`W_RestoreSettings`, test `a_restore_looks_past_gaps`), `w_addr.rs` |
| **Closing a wallet detaches its sync** first (`Sync_Detach`) and forgets its intents, so nothing restarts an engine over a file being shredded or a key being forgotten. `W_Load` never installs a second engine over a wallet already open. | 17, 30 | `src-tauri/src/w_sync.rs`, `w_main.rs` (`W_Close`, `W_Load`) |
| **Start Over erases what it says, and is there when the key isn't.** The logs go with the data folder (`W_EraseAll`), and the browser's prefs are cleared first (`Com_ClearPrefs`); the sheet names what stays: copies on other devices or in the sync folder, and saved files. A key file missing (its wallets still here) or damaged (it reads, and isn't a key file) offers Start Over too, asked first as on the lock screen, the sheet saying a wallet never backed up is lost for good (`V_MayStartOver`); never while open or locking, nor for a file that only couldn't be read just now, nor for a newer Laurel's key, which an update opens. | W1-03 | `src-tauri/src/w_vault.rs` (`Com_MayStartOver`), `w_main.rs` (`W_StartOver`, `W_EraseAll`); `src/ui_security.tsx` (`UI_VaultErrorScreen`), `ui_local.ts`, `ui_text.ts`, `ui_security.test.tsx` |
| **Shutdown stops and saves every wallet at once**, so one slow engine can't use up the budget before the next wallet is saved. | 66 | `src-tauri/src/w_main.rs` (`W_Shutdown`) |

## The 100 cases

### A. Key generation, cryptography, wallet identity

| # | Case | Status | Where / what |
|---|---|---|---|
| 1 | RNG failure at creation | Done | Laurel makes the phrase itself: 32 bytes from `OsRng` (getrandom, the OS generator) → BIP 39 (`W_NewPhrase`, `w_phrase.rs`); `OsRng` panics on failure, never a fallback. Until 2026-10 the engine's `NewSeed` made it through `bip0039`'s `rand::rng()` (ChaCha12 seeded from the OS: secure, but one generator more than this row claimed). A build that overrides getrandom's backend fails to compile (`lib.rs`). Tests: 24 valid words, 256 bits, 1,000 phrases with no shared 4-word prefix and every entropy bit balanced (`w_phrase.rs`). Spend randomness and vault nonces use `OsRng` too (`w_engine.rs`, `w_vault.rs`, engine `sweep.rs`, zingolib `send.rs`) |
| 2 | Duplicate seeds after cloning | Fixed | Fresh OS entropy per wallet (`W_NewPhrase`). The same phrase added twice is now refused (`W_Fingerprint`) |
| 3 | Invalid-key derivation branches | Engine | ZIP 32 in librustzcash |
| 4 | Wrong derivation paths | Engine / Done | Standard ZIP 32 accounts; restore uses the same engine that created (`W_Restore`) |
| 5 | Key serialization boundaries | Engine | zingolib's wallet file format; `MAX_ACCOUNTS` (20) caps the index |
| 6 | Mnemonic shown differs from the seed | Done | The phrase shown is the engine's own (`W_Recovery` → `recovery_info`), never re-derived |
| 7 | Passphrase normalization | Done | A restore can take a BIP 39 passphrase, kept with the wallet and shown with the words at backup. `W_NormalizePhrase` lowercases and single-spaces the phrase, which BIP 39 English permits; the passphrase is used as typed, and bip0039's `to_seed` NFKD-normalizes it as BIP 39 says, so other wallets derive the same seed |
| 8 | Signature nonce reuse | Engine | RedPallas / RedJubjub in librustzcash |
| 9 | Secret caches cross wallets | Done | Every read is keyed by wallet id (`KEYS.recovery`, `W_Slot`); the phrase query has `gcTime: 0` (`ui_backup.tsx`) |
| 10 | xpub + child key exposure | N/A | No key export |

### B. Backups, restoration, recovery

| # | Case | Status | Where / what |
|---|---|---|---|
| 11 | Backup verifies but can't spend | Done | The restore gate, run live |
| 12 | Partial backup reported ok | Fixed | A third of the words, no free retry, the passphrase checked; every vault write proven (`V_Commit`) |
| 13 | Imported keys missing from seed backup | Done | Imported zcashd keys are a wallet of their own (`WK_KEY`), never mixed into a phrase wallet; removing one says the same keys bring it back. Its new Orchard and transparent keys exist only in its file, so it receives nothing on them (CONTROL-MAP) |
| 14 | Multisig policy | N/A | |
| 15 | Threshold shares | N/A | |
| 16 | Old backup misses later accounts | Done | Asked on restore, and said where a missed one is added (not scanned for: see B) |
| 17 | Restore overwrites another wallet | Fixed / Done | Each wallet has its own directory (`W_NewWalletDir`, `create_dir` fails if it exists); a failed add removes only its own directory; `W_Load` never opens a wallet twice |
| 18 | Cloud backup conflict | N/A | No cloud backup, by rule (SECURITY.md) |
| 19 | Watch-only mistaken for a backup | Done | `WK_VIEWONLY` wallets say "View only" everywhere and never "backed up" (`ui_wallets.tsx`, `ui_switcher.tsx`); `W_Recovery` refuses them |
| 20 | Stale channel state | N/A | |

### C. Secret storage, authentication, lifecycle

| # | Case | Status | Where / what |
|---|---|---|---|
| 21 | Crash between address shown and key stored | Done | The sealed wallet file is written before the wallet is installed or any address shown (`W_AddWallet`); shielded funds to any diversified address are found by the account's viewing key regardless |
| 22 | Interrupted password change | Fixed | Every key-file write read back and proven, else undone (`V_Commit`) |
| 23 | Broken keystore handling | Done | Every byte is under the AEAD tag (`every_flipped_byte_is_caught`); corruption is an error, never "no vault" (`V_ReadFile`); KDF parameters are bounded |
| 24 | PIN only cosmetic | Done | The password wraps the wallet key (Argon2id, 256 MiB); a key file's settings are bounded before deriving, 64 MiB / 3 passes / 16-byte salt to 1 GiB / 10 passes / 8 lanes (W1-06, `Com_KdfAllowed`); DPAPI mode is documented as not stopping same-user malware (`w_vault.rs`) |
| 25 | Stale authorization reused | Fixed | An intent is bound to its wallet and account and taken once (`W_Paying`) |
| 26 | Secrets in logs | Done / Todo (C) | `LogText` withholds typed input and contact names; `Debug` prints through it. Todo: engine detail text |
| 27 | Untrusted content executes | Done / Todo (C) | Text nodes only; CSP `default-src 'self'` (`tauri.conf.json`); no `withGlobalTauri` |
| 28 | Unauthorized inter-app calls | Done | No deep links, no browser extension surface; Tauri capabilities are the window controls and the opener only (`capabilities/default.json`) |
| 29 | Tampered update | Todo (before mainnet) | No updater yet; signed releases and checksums are release blockers |
| 30 | Unavailable key store treated as new install | Done / Fixed | DPAPI failure is `WERR_OS_KEY`, shown, never regenerated (`V_Open`); a missing vault with sealed wallets present is `WERR_VAULT_MISSING`; closing detaches sync |

### D. Addresses, recipients, payment requests

| # | Case | Status | Where / what |
|---|---|---|---|
| 31 | Wrong network | Done / Fixed | Every address is checked against the network (`W_KindOf`, `WERR_WRONG_NETWORK`); wallets and contacts live per network; create/restore refuse the other network (`W_CheckNetwork`). Todo (C): show the network on review |
| 32 | Malformed address repaired | Done | `ZcashAddress::try_from_encoded` is strict; the UI strips whitespace only (`ui_send.tsx`) |
| 33 | Receive address differs by surface | Done | One string feeds the QR, the text and Copy (`UI_AddressCard`); keyed by wallet and account (`KEYS.receive`) |
| 34 | Recipient substitution after paste | Done | The quote carries the exact address; the confirm compares it (`E_SendIfSeen` on `sendQuote_t.to`); review shows it |
| 35 | Address poisoning | Done / Todo (C) | Contacts are only what the person saved; no "pay again" yet |
| 36 | Name resolution | N/A | |
| 37 | Ambiguous payment URI | Fixed | `zip321` parses; several payments are read whole, each with its amount, or refused whole |
| 38 | Required memo lost | Done / Fixed | A memo to a public address is refused, never dropped (`W_CheckMemo`); the request's message is no longer sent as the memo |
| 39 | Batch mapping changes | Fixed | A batch is quoted with every payment; sending compares every one with what was reviewed (`E_SendIfSeen`) |
| 40 | Address to wrong script | Engine | zcash_address / librustzcash |

### E. Amounts, accounting, fees

| # | Case | Status | Where / what |
|---|---|---|---|
| 41 | Decimal conversion drift | Done / Fixed | `Com_ParseZec` parses from the string, never a float; `Com_FormatZec` is now integer arithmetic; ZIP 321 amounts are parsed by `zip321` to `Zatoshis` |
| 42 | Overflow / float loss | Done | Zatoshis are `u64` in Rust and under 2^53 on the wire; `Number.isSafeInteger` in `Com_ParseZec` |
| 43 | Locale numbers | Done | A comma that could group thousands is refused (`AMBIGUOUS_COMMA`); grouping is never accepted |
| 44 | Fiat drift | N/A | No fiat entry |
| 45 | Fee units | Engine / Done | ZIP 317 from the engine; shown in zatoshis as ZEC. Todo (C): a word when high |
| 46 | Broken fee estimate | N/A | No fee service |
| 47 | Send-max fee timing | Done | Max is a real `propose_send_all` quote; the confirm builds it again and compares (`W_SendNow`) |
| 48 | Change dropped as dust | Engine | zcash_client_backend's change strategy |
| 49 | Fee subtraction | N/A | No subtract-fee option |
| 50 | Maintenance drains fees | Done | No automation moves money; the scheduled migration is read-only (`W_MigrationStatus`); every `LightClient` method that could is banned by `clippy.toml` |

### F. Construction, signing, spending policies

| # | Case | Status | Where / what |
|---|---|---|---|
| 51 | Final tx violates accounting | Engine / Fixed | The builder balances by construction; Laurel refuses a proposal without an amount. Release gate: decode and check |
| 52 | Attacker output as change | Engine | Change is the engine's own derivation; no external proposals |
| 53 | Tx changes after confirmation | Fixed / Done | Quote-then-confirm for send and shield; now for the migration too |
| 54 | False previous-output data | Done | The offline signer signs v5/v6 transactions, whose signature hash commits to every transparent input's amount and script (ZIP 244): a false one makes the signature invalid, not the fee larger. Shielded inputs' values are proven in the proofs. Online, what the transaction spends must equal the payments, change and reviewed fee (OFFLINE-SIGNING.md, 7) |
| 55 | Unsafe sighash mode | Engine | |
| 56 | PSBT disagreement | N/A | |
| 57 | Blind-signing fallback | N/A | |
| 58 | Multisig setup | N/A | |
| 59 | Timelocks | N/A | |
| 60 | Cross-chain replay | Engine | Consensus branch id in every signature |

### G. Submission, sync, status, refunds

| # | Case | Status | Where / what |
|---|---|---|---|
| 61 | Double click, two payments | Fixed | `useAction`'s guard in the UI, and now the intent in the engine |
| 62 | Broadcast ok, answer lost | Fixed | A retry with the same intent is refused; the wallet is saved right after the send |
| 63 | Local cancel shown as chain cancel | Done | A busy sheet can't be closed (`UI_Sheet`); the working note says it can't be stopped halfway (`T.send.workingHint`) |
| 64 | Expiry handled wrongly | Fixed | The expiry height is shown as a time; an expired payment is "Didn't go through"; nothing retries a payment on its own |
| 65 | Fee bump changes more | N/A | |
| 66 | Crash loses in-flight record | Fixed | Saved right after the send; shutdown saves every wallet at once; an unsent one is sent again once caught up (`Sync_SendUnsent`). Release gate: kill mid-send |
| 67 | Concurrent workers | Fixed / Done | One process (single instance), one client mutex per wallet, one intent per review, no second engine over one wallet |
| 68 | Server fabricates success | Fixed | The txid is the engine's; a payment never mined expires (the engine, once scanned past its expiry height) and shows as not gone through |
| 69 | Reorg leaves stale state | Engine | pepper-sync rolls back; nothing in Laurel acts on "confirmed" |
| 70 | Refund to inferred sender | N/A | No refund feature |

### H. Zcash addresses, keys, notes, fees

| # | Case | Status | Where / what |
|---|---|---|---|
| 71 | Unified Address decoding | Engine | `zcash_address` |
| 72 | UA with an uncontrolled receiver | Engine / Done | Receivers come from the account's own keys (`generate_unified_address( { orchard, sapling } )`) |
| 73 | UA paid as several destinations | Engine | One payment per request; the engine picks the receiver |
| 74 | Sapling/Orchard derivation | Engine | |
| 75 | Shielded change not recoverable | Engine / Done | Proven by the restore gate: change came back to the zatoshi |
| 76 | Note commitment vs ciphertext | Engine | |
| 77 | Real value in a dummy output | Engine | |
| 78 | Viewing-key export leaks spending | N/A / Done | No export; `W_Recovery` shows only the phrase, only for seed wallets |
| 79 | TEX restriction ignored | Engine / Done | Two-step proposal (`steps: 2`), said on review (`T.send.twoSteps`) |
| 80 | ZIP 317 fee from the wrong structure | Engine | Shown and bound by the confirm |

### I. Zcash scanning, recovery, proving, migration

| # | Case | Status | Where / what |
|---|---|---|---|
| 81 | Wrong birthday hides funds | Done / Fixed | A date is moved back 14 days (`BIRTHDAY_MARGIN_SECS`); "unknown" scans from Sapling; the backup screen never says "Today" when the date isn't known |
| 82 | Incomplete scan reported complete | Done | Payments wait for every range scanned (`FENCE_SCANNED`, `Com_AllScanned`) and a wallet within 30 blocks (about 12 minutes) of the tip (`Sync_RequireCaughtUp`) |
| 83 | Tree corruption, destructive repair | Done | `Sync_Repair` rescans; keys and the file's addresses are untouched; once per session |
| 84 | External spend not tracked | Engine / Fixed | Nullifiers from the chain; a second Laurel over the same phrase is now refused |
| 85 | Upgrade strands legacy funds | Engine | Orchard is spendable and migrates to Ironwood; Sapling spends |
| 86 | Cross-pool sign error | Engine | The confirm shows every pool spent (`sendQuote_t.from`) |
| 87 | Proving fallback leaks | Done | Local proving only (`LocalTxProver`); no remote prover |
| 88 | Partial migration treated as finished | Fixed / Done | The immediate migration re-plans and compares; a failure leaves the remainder in Orchard, spendable; the scheduled one is only read |
| 89 | Temporary transparent address loses refunds | Engine / Done | Proven by the restore gate: the ephemeral address was found, and a refund sent to it later arrived |
| 90 | Missing outgoing history read as failed | Done | Nothing retries a payment on its own |

### J. Tokens, contracts, dApps, swaps, bridges

| # | Case | Status |
|---|---|---|
| 91–100 | Tokens, contract calls, approvals, sign-in permits, dApp sessions, nonces, reverts, swaps, bridges, smart accounts | N/A: none of these exist in Laurel, and none may be added without reopening this list |

## The one rule

The wallet keeps two things whole: what the person authorized (exactly that
payment, once), and their ability to get every remaining coin back from the
recovery phrase alone. Every item above is one of the two.
