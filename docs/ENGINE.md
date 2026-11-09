# The wallet engine: zingolib

## Why zingolib

Evaluated September 2026:

| Engine | License | Notes |
|---|---|---|
| **zingolib** (chosen) | MIT | Complete: sync, send, shielding, Orchard→Ironwood migration. Supports Ironwood (NU6.3) now. Built on librustzcash's crates, so their crypto improvements arrive with version bumps. |
| librustzcash (`zcash_client_backend` + `zcash_client_sqlite`) | MIT / Apache-2.0 | The official libraries behind the Zcash SDKs (Zodl, formerly Zashi). Lower level: Laurel would write its own sync driver and send pipeline. SQLite storage could be encrypted with SQLCipher. Ironwood support was still landing upstream. **Re-evaluate before mainnet.** |
| Slipstream (ZODL) | AGPL-3.0 (commercial license available) | Sync only, early. ~24–70× faster sync than the official iOS SDK in its own benchmarks. AGPL would make all of Laurel AGPL. |
| Warp / Zkool | MIT | Fast and mature, one maintainer, engine not a clean reusable crate. |

Writing our own engine was ruled out: zero-knowledge proofs, commitment trees,
transaction formats and a network upgrade roughly every year are years of work,
and bugs lose people's money.

The UI never talks to zingolib: only the `w_*.rs` layer does. Swapping engines
means rewriting that layer, not the app.

## Our copy (fork)

`vendor/zingolib` is upstream zingolib at one pinned revision plus Laurel's
changes, and nothing else. The revision is written in one place,
`UPSTREAM_REV` in `scripts/engine.mjs`: since Laurel 0.1.8, upstream's
`zingolib_v8.0.0` release tag (`81d79977`, 2026-10-29), on librustzcash's
releases of 2026-10-21: `zcash_primitives` and `zcash_proofs` 0.31.0,
`zcash_protocol` and `zcash_transparent` 0.11.0, `zcash_address` 0.14.0,
`zcash_keys` 0.17.0, `zcash_client_backend` 0.25.0, `orchard` 0.16.0,
`sapling-crypto` 0.9.0. `zcash_protocol` 0.11.0 carries mainnet's NU7
activation height, 3,543,405 (its `consensus.rs`; Laurel's `w_net.rs` tests it). The changes are written down whole in `vendor/zingolib.patch`, one diff a
reviewer reads top to bottom, and every file it touches is named below with
why. The gate (`npm run check`, step `fork`) fails if the engine differs from
upstream plus that patch, or if a changed file isn't named here: the fork can't
grow by an edit nobody recorded.

    node scripts/engine.mjs fetch           # once per machine: the pinned upstream, into vendor/.upstream (ignored)
    node scripts/engine.mjs record          # after changing the engine: rewrite vendor/zingolib.patch
    node scripts/engine.mjs status          # how far upstream's newest dev is, and what taking it costs (writes nothing)
    node scripts/engine.mjs rebase <rev>    # take a new upstream: a three-way merge of every file

Excluded from the copy: git history, `test_binaries/`, and `zingolib/zcash-params`
(the proving keys' copy builds before 8.0.0 made; ignored by git). The build now
embeds the keys from the user's parameter cache.

### What is not in it

Anything that needs only the engine's public API lives in Laurel's own crate,
`src-tauri/engine` (`laurel-engine`), not in someone else's tree: sweeping a
private key (`sweep.rs`), importing zcashd keys (`zcashd.rs`), and the live
testnet harness (`examples/live.rs`). It is a member of the app's workspace, so
it builds with the app's lockfile: the versions Laurel ships.

Nor is the list of servers Laurel picks from. zingolib 8.0.0 deleted its indexer
census (`zingo_netutils::indexers`, zingo-adrs zingolib/0063) and keeps one default
server, none for testnet. Laurel's list is its own now (`TESTNET_SERVERS`,
`MAINNET_SERVERS` in `src-tauri/src/w_server.rs`), copied from that census, and
rechecked at every release: a server that's gone or no longer serves its network
comes off. The mainnet entries are unused until mainnet; a testnet-only build
offers none of them. One change from the census days, on purpose: Laurel then
dropped every experimental (`.unsafe.`) server, and testnet's list now has one,
Zaino (`zaino.testnet.unsafe.zec.rocks`), second, as the fail-over when
testnet.zec.rocks is down. Mainnet's list still has none
(`no_experimental_server_for_mainnet`).

### Rules for changing it

1. **Never change cryptography.** Performance work goes in the pipeline only:
   networking, scheduling, parallelism, storage.
2. **Public API first.** If it can be done from outside, it goes in `laurel-engine`.
3. **New files over edits.** A new file never conflicts in a merge; an edit to an
   upstream file can. Mark each edit `LAUREL PATCH (<why>)`.
4. **Record it.** `node scripts/engine.mjs record`, and name every newly touched
   file in the list below. The gate holds both.
5. **It stays ours.** We don't send our changes to zingolabs; the fork is
   Laurel's to keep. What keeps it cheap is taking upstream often (below) and
   keeping rule 3.

### Pulling upstream

**The model.** We use zingolib; we don't contribute to it. It is our fork: upstream
at a pinned revision, plus our patch (`vendor/zingolib.patch`), and nothing else.
zingolabs keeps fixing and upgrading it, and we take that work in batches, the way
a Linux distribution takes a package from upstream. Freezing isn't an option: a
Zcash network upgrade stops an old engine making valid transactions after its
activation height, and upstream's fixes land where our money moves. Following
every commit isn't either: half of upstream's commits are docs.

**When.** Take upstream:

- at once, for a network upgrade (a new consensus branch, activation heights) or a
  fix to anything that spends, signs, or reads a wallet file;
- when a bug we hit is fixed there (check its commits before fixing it ourselves);
- otherwise once a month, and before every release, as one batch.

Before every release, also recheck Laurel's own server list (above).

`node scripts/engine.mjs status` says whether there is anything to take and what
it would cost: files changed, which of ours they touch, conflicts. It writes nothing.

**What gets read, and what doesn't.** Nobody reviews all of upstream. Their commits
since our pin, and which touched the paths where money moves:

    git -C vendor/.upstream/<rev> log --oneline --no-merges <pinned>..<rev>
    git -C vendor/.upstream/<rev> log --oneline --no-merges <pinned>..<rev> -- \
      zingolib/src/wallet zingolib/src/lightclient pepper-sync/src

- **Read the diff** of what touches those paths: keys and seeds, proposing and
  sending, the wallet file's format, and pepper-sync's scanning (what counts as
  our money). A change there that looks wrong isn't taken until it is understood.
- **Don't read** docs, CI, tests, examples, the CLI. The gate and the live testnet
  runs judge them, together with everything else.

**Taking it.**

1. `node scripts/engine.mjs rebase <rev>`: every file merged three ways, the
   pinned revision its base. Files only upstream changed are taken; files only we
   changed are kept; files both changed are merged, conflicts marked and listed.
2. Resolve the conflicts, set `UPSTREAM_REV` to `<rev>`, `node scripts/engine.mjs record`.
3. `npm run check`, then the live testnet runs (DEVELOPMENT.md, "Live testnet checks").
   Those decide, not the reading.
4. When upstream fixed something we patched, keep theirs and drop ours: it leaves
   `vendor/zingolib.patch` by itself; delete its row below.
5. Check that Laurel names every new error of the engine's (`Com_Classify`,
   w_net.rs). One it doesn't know reads as damaged sync data, and a server's
   fault would rescan the wallet from its birthday (it nearly did at `271af68e`).
6. One commit: `zingolib: upstream <rev>`, listing the fixes it brings.

## Patches we carry

How much the patch carries is its own header (`vendor/zingolib.patch`). What each is for:

| Patch | Why |
|---|---|
| `no-plaintext-save` feature | Removes zingolib's savers (`save_task`, `flush`, `check_save_error`, `shutdown_save_task`, `backup_wallet_file`), which write the wallet unencrypted. Laurel turns it on, so calling one by mistake doesn't compile. |
| `LightWallet::mark_saved()` | Laurel writes wallet files itself (encrypted), so it must clear the private `save_required` flag. |
| `LightClient::set_indexer()` | Install a server connection made elsewhere, so wallets open offline and connect later without holding the client during a connection attempt. |
| Passphrase ("25th word"): `WalletSeed`, `WalletConfig::MnemonicPhraseWithPassphrase`, wallet file **version 46** | BIP-39 derives keys from the phrase *and* an optional passphrase; zingolib always used an empty one, so a wallet with a passphrase restored as a different, empty wallet. `WalletSeed` (`wallet/keys/seed.rs`, with its file tests) pairs the mnemonic with its passphrase and is the only way to a seed: `vendor/zingolib/clippy.toml` bans `Mnemonic::to_seed` elsewhere. Version 46 writes the passphrase after the birthday. Laurel wrote the same field as 45 until upstream gave 45 to the sync state (taken at `ba733671`), so a version-45 file is read as Laurel's layout first, then upstream's (`read_by_passphrase` in `wallet/disk.rs`); earlier versions read as none. **If upstream assigns 46 to a different layout, a merge must renumber ours again and keep every one readable (ADR 0015).** |
| `WalletConfig::Usks` | A wallet made from spending keys, one account each: zcashd keys (`laurel_engine::zcashd` makes them). |
| A recovery phrase is shown only by name (`RecoveryInfo::reveal`) | `RecoveryInfo` derived `Debug` and had a `Display`, both printing the words and the passphrase whole, and the log's masking can't tell short phrase words from others: one `{}` or `{:?}` of it in a log line would have written the phrase to the file (W1-04). Its `Debug` now shows the word count, whether there is a passphrase, the birthday and the accounts; it has no `Display` (a test holds both, `wallet/keys/seed.rs`). zingo-cli, which shows them to its user on purpose, calls `reveal` (`zingo-cli/src/commands.rs`, `zingo-cli/src/lib.rs`). |
| Transmit verdict (`TransmissionError::TransmissionFailed { text, verdict }`) | A failed broadcast was only prose; the verdict says `Refused`, `Unreachable` or `Unsure`, so Laurel can say which. |
| A failed broadcast frees its notes only when nothing went out (`TransmitError::proves_unsent`, `transmit::invalid_on_its_own`, `NetOpStage::RemoteRejected`) | Every failure freed the notes, also a timeout after the bytes left or an answer that wasn't a verdict on the transaction: a retry could then pay twice from other notes (security review A-03). Now only attempts that never sent the bytes, or a server's refusal of the transaction itself (a bad proof, too low a fee, expired; typed as `RemoteRejected` on the direct (nakednet) path), free them, and only when no earlier attempt of the same transmit may have delivered it (`TransmitFailed`'s earlier attempts, `TransmitError::may_have_delivered`; W1-09: a queued answer, then a dead connection, once freed them). Anything else is `Unsure`: the transaction stays Calculated, to be sent again or to expire. A resend (`retransmit_calculated`) never frees anything, nor does the migration after an unsure failure (`may_have_delivered`). |
| Rebroadcast a dropped payment (`rebroadcast_pending`, `transmit_stored`) | Only Calculated transactions could be sent again; one that went out and was then dropped by the network (a node restart, a stall, an eviction: seen on testnet, 2026-11-06) sat pending until it expired. The same loop now also takes Transmitted and Mempool ones and sends their same bytes, leaving their status alone and freeing nothing; the txid is the same, so it pays once, and a duplicate answer counts as delivered. Each goes on its own, with its own result, so one that can't go doesn't hold back the rest. Laurel picks which (`E_DroppedOf`: its own, not within 3 blocks of expiry). The mock chain's `drop_mempool` is its test's (`a_dropped_payment_is_rebroadcast_past_one_that_fails`). |
| Spend pool (`SpendPoolScope`, `propose_send_from`, `propose_send_all_from`) | "Pay from this pool". A thread-local scope around one proposal limits note selection to one pool, gated in `LightWallet::spendable_notes`, which every selection path goes through. |
| Sapling spend key fetched, not embedded (`wallet/sapling_key.rs`, `lib.rs`) | The 48 MB spend key was compiled in; now only the 3.6 MB output key is (`SaplingParams::SPEND` exists only for the tests and testutils, whose mock chain proves spends; upstream's `LazySaplingProver` is not used). A payment that spends Sapling notes proves with a copy the app names, checked against the published hash at every use; other payments need none. |
| Proving key integrity (`params_hashes.rs`, `build.rs`) | The embedded key was trusted for existing. Since 8.0.0 the build embeds it straight from the user's parameter cache, which zcash_proofs trusts once a file is there: the build checks it against the published BLAKE2b hash first, fetches a wrong one again, and stops if it is still wrong; a test checks what was embedded. |
| Build speed (`build.rs`) | The git state behind `git describe` isn't watched: each commit rebuilt zingolib and everything above it, for a string only zingo-cli prints. |
| Lock waits (`client/fetch.rs` `select_fetch_request`, `wallet/traits.rs` `determine_checkpoint`) | While a batch of scan results is applied, the sync holds the wallet's write lock, and waits on the server for tree states. Every request went through one fetcher, first come first served, so each wait queued behind the scanners' block streams, and each height was asked for three times, once per pool. Now a single request goes before the streams, and a height is asked for once. Measured under "Speed work". |
| Parallel fixture validation (`wallet/disk/testing*`) | The format tests validated the example wallets one by one; now in parallel, in seconds. (Loading them offline, which this patch also did, is upstream's own since 8.0.0.) |

Files the patch touches, each for a row above (the gate checks this list):
`vendor/zingolib/Cargo.toml`, `vendor/zingolib/Cargo.lock` (bls12_381 for the spend prover, blake2b_simd for the
build), `vendor/zingolib/clippy.toml` (the passphrase's seed ban), `vendor/zingolib/zingolib/Cargo.toml`,
`vendor/zingolib/zingolib/build.rs`, `vendor/zingolib/zingolib/src/lib.rs`, `vendor/zingolib/zingolib/src/config.rs`,
`vendor/zingolib/zingolib/src/lightclient.rs`, `vendor/zingolib/zingolib/src/lightclient/error.rs`,
`vendor/zingolib/zingolib/src/lightclient/propose.rs`, `vendor/zingolib/zingolib/src/lightclient/save.rs`,
`vendor/zingolib/zingolib/src/lightclient/send.rs`, `vendor/zingolib/zingolib/src/lightclient/transmit.rs`,
`vendor/zingolib/zingolib/src/lightclient/indexer_history.rs` (a refusal is the server's fault), `vendor/zingolib/zingolib/src/mixnet/driver.rs`,
`vendor/zingolib/zingo-net-diag/src/lib.rs`, `vendor/zingolib/zingolib/src/lightclient/mock_chain_tests.rs`, `vendor/zingolib/zingolib/src/testutils/mock_indexer.rs` (a dropped mempool), `vendor/zingolib/zingolib/src/lightclient/migrate.rs` (the failed broadcast), `vendor/zingolib/zingolib/src/params_hashes.rs`,
`vendor/zingolib/zingo-cli/src/commands.rs`, `vendor/zingolib/zingo-cli/src/lib.rs` (the phrase shown by name), `vendor/zingolib/zingolib/src/wallet.rs`, `vendor/zingolib/zingolib/src/wallet/disk.rs`,
`vendor/zingolib/zingolib/src/wallet/disk/testing.rs`,
`vendor/zingolib/zingolib/src/wallet/disk/testing/tests.rs`, `vendor/zingolib/zingolib/src/wallet/error.rs`,
`vendor/zingolib/zingolib/src/wallet/keys.rs`, `vendor/zingolib/zingolib/src/wallet/keys/seed.rs`,
`vendor/zingolib/zingolib/src/wallet/keys/unified.rs`, `vendor/zingolib/zingolib/src/wallet/migration/parts.rs`,
`vendor/zingolib/zingolib/src/wallet/migration/split.rs`, `vendor/zingolib/zingolib/src/wallet/output.rs`,
`vendor/zingolib/zingolib/src/wallet/sapling_key.rs`, `vendor/zingolib/zingolib/src/wallet/send.rs`,
`vendor/zingolib/zingolib/src/wallet/transparent.rs`, `vendor/zingolib/zingolib/src/wallet/utils.rs`,
`vendor/zingolib/pepper-sync/src/client/fetch.rs`, `vendor/zingolib/pepper-sync/src/wallet/traits.rs`,
`vendor/zingolib/pepper-sync/src/sync.rs` (the lock waits' test).

### Candidates

| Change | Why |
|---|---|
| Fetch outside the wallet lock | pepper-sync's `process_scan_results`, `set_initial_state` and `update_wallet_tree_bounds` hold the wallet write lock across network requests. Laurel works around it (ARCHITECTURE.md, "The engine's lock"). The fix is to fetch first, then lock to apply. Ours to make if the workaround stops being enough; a pipeline change, not cryptography (rule 1). |

## Speed work (planned)

Measure first: `live bench <new> <from>` restores a wallet's phrase and birthday
fresh and times it, while a reader asks for the balance every half second, as
Laurel's screens do.

### Measured 2026-10-11 (glory, testnet.zec.rocks, about 1.43 million blocks)

| Run | Whole sync | First balance | Reader waited on the lock |
|---|---|---|---|
| 1 | 7 min 52 s, 3,023 blocks/s | 2 min 35 s | 95%: 3.8 s; longest: 10.8 s |
| 2 | 4 min 13 s, 5,652 blocks/s | 1 min 33 s | 95%: 1.5 s; longest: 6.5 s |
| 3 (slow server; stopped with "Sync error." at 7 min 54 s) | 827 blocks/s | 4 min 56 s | 95%: 10.3 s; longest: 15.4 s |

Where the lock goes (timed by hand in runs 2 and 3, not left in the fork):
- Applying a batch's results holds the wallet's write lock: 144 s of run 2, 418 s of run 3.
- Almost all of that is `update_shard_trees`. Finding spends takes microseconds.
- Inside it, in run 3:
  - `determine_checkpoint` took 310 s. It asks the server for a tree state (`get_frontiers`), one height at a time, while holding the lock. It asks again for each of the three pools, though one answer covers all three.
  - `insert_tree` took 103 s of computing.
- So the lock waits are mostly network waits, and they grow with the server's latency.

Whatever a batch held money from showed first, before the spends that used it.
The first balance was 39.96 TAZ; the wallet holds 34.9.

Why they queued: every server request goes through one fetcher, first come first served, so a
tree state asked for under the lock waited behind the block streams the scanners had queued.

Done (patch "Lock waits"): a single request goes before the streams, and a height is asked for
once for all three pools. Quick runs (`bench <new> glory 20000`, back to back, same server):

| | Whole sync | Reader waited, 95% | Longest |
|---|---|---|---|
| Before (2 runs) | 61 s, 68 s | 5.9 s, 5.7 s | 11.0 s, 10.4 s |
| After (3 runs) | 39 s, 38 s, 48 s | 0.8 s, 0.9 s, 2.6 s | 2.7 s, 3.0 s, 3.1 s |

A whole run after it, alone on the machine (timed by hand, not left in the fork):

| | Whole sync | Reader waited, 95% | Longest | Lock held: checkpoints | Lock held: inserting trees |
|---|---|---|---|---|---|
| Run 3, before (slow server) | stopped at 7 min 54 s | 10.3 s | 15.4 s | 310 s | 103 s (only calls over 300 ms counted) |
| After | 6 min 55 s, 3,440 blocks/s | 3.7 s | 7.9 s | 3.4 s | 250 s |

The server waits are gone. What still holds the lock is computing: `insert_tree` (shardtree),
2-3.7 s for each batch of the older history. Fetching the tree states before the lock is taken
is no longer worth making: 3.4 s in all.

Tested and rejected: the scans make a checkpoint for every block with outputs (403,218 in a
whole glory restore), and `insert_tree` prunes all but the newest at once. Passing in only the
checkpoints the wallet keeps made inserting 4.5× slower (576 s against 127 s; longest wait 35 s
against 3.1 s): pruning a checkpoint is what frees the leaves it held, so without it the trees
grow. Back to back, the unchanged run was the day's best whole restore: 4 min 19 s, longest
wait 3.1 s, 95% 1.5 s. Inserting varies from run to run (127-250 s) with the server and the
batch sizes.

Where speed work stops for now: a day-to-day sync covers far fewer blocks than the quick runs
(the newest 20,000 blocks, longest wait about 3 s); a restore or a long catch-up meets 3-8 s waits, and Laurel's
screens answer from their cache meanwhile (ARCHITECTURE.md, "The engine's lock"). Upstream's
`TODO: use batch_insert_trees` is the next lead, when a measurement asks for it.

Further targets, none touching cryptographic correctness:

1. Time to first balance: scan recent blocks first (pepper-sync already has scan
   priorities).
2. Download from several servers in parallel.
3. Trial decryption across every core, with better batching.
4. Incremental storage instead of rewriting the whole wallet file on every save.
