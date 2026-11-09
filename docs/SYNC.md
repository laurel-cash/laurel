# Encrypted sync between computers

Contacts, transaction notes and a few settings, kept the same on each of the
person's computers. Laurel runs no server (CONTROL-MAP.md): the person picks
a folder their computers already share (OneDrive, Dropbox, a NAS, a USB
stick carried between them), and Laurel keeps an encrypted file there.

## How it works

- **The sync key** is 32 random bytes made on the first computer and shown
  once as a **sync code** (words of base32, with a checksum). The other
  computer is joined by typing or pasting that code. The key is kept in the
  vault, sealed like everything else (`PURPOSE_SYNC`). It is not derived from
  any recovery phrase: a leaked sync code reads contacts and notes, never
  money.
- **Each computer writes only its own file**, `laurel-sync-<device>.lsync`,
  and reads everyone's. A file with one writer can't be a cloud conflict
  copy, and two computers never write the same bytes.
- **Each record** (a contact, a transaction's note, a setting) carries a
  version: a Lamport counter, one above the highest this computer has seen,
  and the device that wrote it. The highest (version, device) wins. Clocks
  are never compared: a computer with the wrong date can't win forever.
- **Deleting** writes a tombstone, which travels like any record, so a
  delete on one computer is a delete on all.
- **What changed locally** is found by comparing each record with the last
  synced copy (a hash per record in the sync state). The contacts and notes
  code doesn't change: sync reads and writes them through their owners.

## What is synced, and what never is

| Synced | Never synced (per computer) |
|---|---|
| contacts, per network | the auto-lock time and the password (a "never lock" from another computer must not weaken this one) |
| transaction notes and categories, per network | the network in use |
| notifications (in app, system), prices on or off | appearance and text size (how this screen reads) |
| | wallets, keys, recovery phrases: never, in any form |
| | repeating payments and price alerts (they point at this computer's wallets, whose ids are this computer's own) |

## 20 edge cases, and what Laurel does

1. **The cloud keeps two copies of a file** ("laurel-sync-a (1).lsync"): only files whose name matches `laurel-sync-<16 hex>.lsync` are read, and the device id inside the file must equal the one in its name.
2. **A file is half downloaded** (OneDrive placeholders, a sync in progress): decryption fails the tag check; the file is skipped as "not ready" this round, never reported as an attack, and read next time.
3. **Two computers edit the same contact while apart**: the higher (version, device) wins, the same on every computer, so all converge.
4. **One computer's clock is wrong by a year**: versions are counters, not times; the clock plays no part.
5. **A contact deleted on one computer and edited on another**: the later version wins; an edit made after seeing the delete brings it back. Deterministic either way.
6. **The same address added as two contacts on two computers** (two ids): after merging, one address keeps one name (as Ct_Save demands): the higher version survives, the other becomes a tombstone on every computer.
7. **A record from another network** (a testnet contact on a mainnet computer): each network is its own section; nothing crosses.
8. **A contact whose address doesn't read on this network** (a newer or older Laurel wrote it): it is checked as Scan reads it and skipped, not stored, and the status says how many were skipped.
9. **A note longer than this Laurel allows**: refused through Com_CleanNote, skipped, counted; never cut.
10. **A file from a newer Laurel** (format version higher): not read; the status says "update Laurel on this computer". Nothing is overwritten from it.
11. **The wrong sync code typed on the second computer**: the code's checksum catches a typo before anything is joined; a valid code for another group reads no file ("0 computers found") and says so.
12. **Laurel locked**: the sealed contacts and notes can't be read; sync waits and runs after unlock.
13. **The folder disappears** (a USB stick out, a drive letter gone): the status says the folder can't be reached; nothing is changed or deleted locally.
14. **Someone with access to the folder deletes or rolls back files**: they can't read or forge them (the key's tag); an old file only loses to newer versions; a deleted file only stops that computer's changes arriving until it writes again.
15. **Two Laurels on one computer** (a second copy of the data folder): each has its own device id in its own sync state; a copied data folder is noticed because its device's file shows versions this state never wrote, and it takes a new device id.
16. **A sync while the person is editing a contact**: sync writes contacts through their owner, under their lock, so neither write loses the other.
17. **Stop syncing**: this computer forgets the key and removes its own file; the others keep theirs. Contacts and notes stay as they are.
18. **A computer that is gone for good** (sold, broken): "Forget" removes its file from the folder; its changes stay merged.
19. **The sync code in a log or an error**: never logged; an error about a code never repeats it.
20. **A very large address book** (thousands of contacts, years of notes): one file per computer, written only when something changed; the merge is linear in records.

## Files

Android uses a system-picked folder and retains its document-provider grant.
After selection, unlock Laurel to resume setup. Its snapshots use the same
encrypted format as desktop. The provider must support exact document names and
create/read/write/rename/delete operations. A temporary snapshot is verified
before publication; providers do not promise atomic rename, and incomplete
snapshots are rejected by authentication. Only Laurel's own files are listed
and counted (at most 1,024 of them), so a folder in daily use works; each
snapshot is limited to 64 MiB.

`src-tauri/src/w_folder.rs` (the sync), `w_vault.rs` (`PURPOSE_SYNC`),
`w_contacts.rs` and `w_notes.rs` (read and replace through their owners),
`src/ui_folder.tsx` (Settings > Sync), tests in both.
