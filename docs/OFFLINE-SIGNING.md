# Offline signing

The recovery phrase lives on a computer that is never online. Another
computer, online, holds only the viewing key. A payment is prepared online,
signed offline, and sent online; the spending key never touches a computer
that can reach the network.

## How it works

1. **Online, a view-only wallet** (restored from the viewing key) syncs as
   usual. Send, on a view-only wallet, offers **Sign on Another Computer**:
   the payment is reviewed as any other, then saved as a **signing request**
   file: the wallet's synced state as the engine keeps it (no keys: a
   view-only wallet has none), and the payment asked for (address, amount,
   memo, and the fee shown).
2. **Offline, Laurel with the seed wallet** opens the request (Settings >
   Offline Signing > Sign a Request). It finds its own wallet whose viewing
   key is the request's, builds an engine client from the request's state
   with no network (the engine's indexerless mode), puts the spending key in
   it **in memory only**, and plans the same payment. The person reviews it
   **on the offline screen**, the one that can't be tampered with over the
   network. Signed, the transaction goes into a **signed file**; the
   in-memory copy is wiped.
3. **Online again**, Send finishes the payment from the signed file: Laurel
   decodes the transaction and checks it pays what the request asked, with
   the viewing key, before sending it.

No engine change: the engine already builds and signs with no indexer; the
spending key is put beside the synced state it belongs to.

## 20 edge cases, and what Laurel does

1. **The wrong wallet signs** (another phrase, or another account): the offline wallet's viewing key must equal the request's, account by account; otherwise it isn't offered.
2. **The request is for the other network**: refused on open, naming both networks.
3. **The online wallet spends between request and send** (another payment went out meanwhile): the signed transaction spends notes already spent; the network refuses it (WERR_REJECTED), the money stays, and the person makes a new request. The request says to make no other payment from that account until this one is sent.
4. **A signed file is a live payment until it's spent or the network upgrades**: signing with no network, the engine gives the transaction the longest expiry its epoch allows, the next network upgrade (`retarget_for_offline_signing`, zingolib), so days on a USB stick don't expire it. The flip side: a signed file never sent can still be sent by whoever has it, until its notes are spent. The signed-file screen says so, and "Forget this request" online says that only spending from the account (any payment) voids it.
5. **The same request signed twice**: two different transactions spending the same notes; only one can be mined. Online, a request is finished once: its id is recorded and a second signed file for it is refused.
6. **A signed file for a request this computer never made**: refused (the request id isn't one of ours), unless its outputs still match what the person reviews again on this screen.
7. **The signed transaction pays someone else** (a tampered file, a compromised offline machine showing one thing and signing another): online, the outputs are decrypted with the viewing key and must be exactly the request's payments (receiver, amount, memo), plus change to this wallet. And the value is accounted for: what the transaction spends of this wallet's notes and coins, less the fee reviewed, less every output the viewing key sees, must be zero. An output hidden from the viewing key (no outgoing key) would be left over, and is refused; so is a Sapling or transparent input this wallet doesn't own. An Orchard or Ironwood action spending a note that isn't ours is padding (every bundle has at least two actions, a dummy's spend among them) or another's money coming in: never ours going out, so it's left out of what the wallet spent. Anything else is refused before sending.
8. **The fee differs from the one shown**: planned offline from the same state, it must equal the request's fee; a different one is shown as "changed" offline and needs another look.
9. **A transparent recipient** (no memo possible), **a TEX address**, **several payments in one**: the same rules as Send (W_CheckMemo, MAX_PAYMENTS); a TEX payment is two transactions and is refused for offline signing in this version, said plainly.
10. **The offline machine has no proving key for Sapling spends**: Laurel carries the small keys every payment needs, but Sapling's spend key (48 MB) is fetched the first time a payment spends Sapling money, and a signer never downloads. When a request spends Sapling notes and the key isn't there, the Sign screen says so before Sign is pressed: copy `sapling-spend.params` from the online computer's Laurel data folder (or any Zcash wallet's `ZcashParams` folder) into the folder it names, with Show Folder to open it. The copy is checked against the published key's hash before it is used, and again at every use (w_spendkey.rs, zingolib `wallet::sapling_key`).
11. **The request file is huge** (years of history in the state): read in full only on the offline machine; a size cap (64 MB) refuses anything larger with the reason.
12. **A damaged or truncated file** (a USB pulled early): every file carries its own hash; a mismatch is "damaged, copy it again".
13. **The offline computer is not actually offline**: Laurel can't prove it; the Sign screen says, once, that the point is lost if it is online, and never reaches the network itself (the client has no indexer).
14. **The request file is read by someone else** (a lost USB stick): it holds the view-only state: history and balances, no keys, like a CSV export. The screen says so when saving, and to delete it once the payment is sent.
15. **The spending key outlives the signing**: the in-memory client is dropped and the key zeroized when signing ends, succeeds or fails.
16. **The offline wallet is view-only too**: nothing can sign; said plainly, with what is needed (the recovery phrase).
17. **The recipient is in the address book online but not offline**: the request carries the address itself; the offline screen shows the address in full (and the name only when the offline book has it).
18. **A shield or an Orchard→Ironwood move offline**: not in this version: a request is a payment to an address; the others are said to be online-only.
19. **The online wallet is a full seed wallet**: it can send itself; Sign on Another Computer is offered only for view-only wallets, where it is the only way.
20. **Laurel quits between request and signed file**: the request is on disk (the file the person saved) and its id in the wallet's pending requests, so finishing works after a restart.

## Files

Android opens and saves through the system document picker. Leaving Laurel for
the picker locks it; unlock after selecting a file to resume. The review or save
result appears even if the original screen was closed by that lock. Request and
signed-file formats remain identical to desktop, with a streaming 64 MiB import
limit. A canceled picker produces no file result. Native malformed-file import
has been exercised; a complete funded Android offline-signing round trip remains
to be validated. iOS file transfer is not implemented.

`src-tauri/src/w_offline.rs`, `w_engine.rs` (the snapshot, the in-memory
signer, calculating with no indexer), `w_net.rs` (`W_Broadcast`, shared with
sweep), `w_dialog.rs` (the file pickers), `src/ui_offline.tsx`,
`src/ui_send.tsx` (Save Signing Request on a view-only wallet), tests in both.
