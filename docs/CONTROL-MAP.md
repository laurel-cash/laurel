# Key and control map

What Laurel (the software), its publisher, and each third party can authorize,
block, recover, redirect or access. Written for legal review: counsel asked for
exactly this. **Keep it true:** update it in the same change as any feature that
alters who can do what (recovery, servers, fees, swaps, telemetry, updates).

Status: testnet software, September 2026. Only what exists today is listed as
fact; planned features are marked.

## Who is involved

| Party | Role |
|---|---|
| The user | runs Laurel on their own computer |
| Laurel (the software) | open-source program on the user's computer, under the MIT License (github.com/laurel-cash/laurel) |
| The publisher | writes and distributes the software; runs **no servers** today |
| Lightwalletd server (today `zec.rocks`, run by a third party) | serves public blockchain data and relays transactions the user already signed |
| Zcash network | settles transactions |

## Keys

| Secret | Generated | Stored | Who can use it |
|---|---|---|---|
| Recovery phrase (BIP-39) and the spending keys derived from it | on the user's computer, from the OS random generator: 32 bytes straight from it into BIP 39, by Laurel itself (`W_NewPhrase`, w_phrase.rs) | only on the user's computer, inside the wallet file, encrypted (see below); and on paper, by the user | the user only |
| Wallet key (encrypts wallet files) | on the user's computer, OS random generator | `laurel-vault.json` on the user's computer, protected by Windows DPAPI (default) or wrapped by the user's password (Argon2id) | the user only |
| Passphrase ("25th word", optional) | chosen by the user in their earlier wallet; typed in on restore | inside the wallet file with the phrase, encrypted the same way; and on paper, by the user | the user only |
| Password (optional) | chosen by the user | nowhere: only a key derived from it is used, in memory, to unwrap the wallet key | the user only |
| zcashd Sapling keys (optional, imported) | by zcashd, in the user's old wallet | inside the wallet file, encrypted like any other; the fresh Orchard and transparent keys paired with them exist only there, so that wallet receives nothing | the user only |
| A single private key being swept (optional) | elsewhere (a paper wallet, zcashd) | nowhere: typed into the Sweep sheet, used once in memory to sign, then wiped (w_sweep.rs, `Zeroizing`) | the user only |
| Viewing key (view-only wallets) | imported by the user from another wallet | on the user's computer, encrypted like wallet files | the user only |

The publisher never receives, stores, escrows or can reconstruct any of these.
There is no account, no cloud backup, no recovery service and no co-signing key.

## Actions

| Action | Who can do it | Who can stop it |
|---|---|---|
| Create, restore, or delete a wallet | the user, locally | nobody else |
| Sign a transaction | the user, locally; or, for a view-only wallet, on the user's own offline computer, from a request the user carries there | nobody else |
| Broadcast a signed transaction | the user's Laurel, through the lightwalletd server | the server could refuse to relay it; the user can switch servers (planned) and the transaction stays valid for any other relay |
| Redirect funds, reverse, freeze or recover a payment | **nobody** (not the publisher, not the server) | n/a |
| Recover a lost recovery phrase or password | **nobody**. The phrase restores everything; a lost password is overcome with the phrase. | n/a |
| Change the software on the user's computer | the user, by installing an update. There is no auto-update today. | the user |

## Data that leaves the user's computer

| Data | Goes to | Why |
|---|---|---|
| IP address, request timing | lightwalletd server | network connection |
| Which server: automatic (default) or the user's own | Automatic keeps the server that last worked. Only when it fails does Laurel ask zingolib's census 4 servers at a time (w_server.rs), so each of those learns this IP runs a Zcash wallet. It never retries on an intercepted connection. The user's own server is the only one contacted. | availability without a Laurel-run server |
| Which blocks and transactions are fetched | lightwalletd server | syncing (Zcash's compact-block design means the server does not learn which payments are the user's) |
| The wallet's **transparent** addresses | lightwalletd server | public-pool balances are looked up by address, so the server can link those addresses to this IP. Shielded (Ironwood/Orchard/Sapling) money is not looked up this way. |
| Approximate wallet creation date (block-height lookups) | lightwalletd server | converting "created in March 2025" to a block height, only when the user chooses a date on restore; the birthday block's time, to show sync as dates |
| Signed transactions | lightwalletd server, then the public network | sending, shielding, migrating, sweeping |
| The address of a private key being swept | lightwalletd server | finding its coins, only when the user presses Find. The sweep itself then links that address to this account's public address on the public chain. |
| Opening the testnet faucet | the user's browser | only when the user clicks it |
| IP address, the range asked for (1H to ALL), and that the asker is Laurel (its version, as the User-Agent CoinGecko requires) | api.coingecko.com | the ZEC price, **only after the user turns it on** (off by default; Settings > General turns it off). Asked by Laurel's Rust side, not the browser, cached per range (minutes to hours); nothing about wallets is sent (w_price.rs). **With a price alert waiting**, the hour's prices are asked about every two minutes for as long as Laurel runs, whether or not the chart is open; none when prices are off or every alert has gone off (w_alert.rs) |
| Opening a Help link | the user's browser | only when the user clicks it (Zcash forum, docs, zingolib) |
| A signing request: a view-only wallet's synced state (history, balances; no key) and the payment asked for | a file the user saves and carries to their offline computer, only when they choose Offline Signing | signing on a computer that is never online (docs/OFFLINE-SIGNING.md). The signed file that comes back is a payment: whoever holds it can send it until its money is spent |
| Contacts, transaction notes, notification choices, encrypted with the sync key | a folder the user picks (their own cloud drive, NAS or USB stick), only after they turn Sync on | keeping the user's computers alike (docs/SYNC.md). Laurel's publisher runs no sync server; whoever hosts the folder sees file sizes and times, never contents. The sync code never leaves the user's computers except as the user carries it |
| The Sapling proving parameters download | download.z.cash, at build time only | building the software |
| IP address, and that the asker is Laurel (its version, as the User-Agent) | download.z.cash | Sapling's spend proving key (48 MB), **once**, the first time the user sends or moves money held in Sapling, and only if no copy is already on the computer (Laurel's data folder, or the `ZcashParams` folder other Zcash wallets share). The review says it will happen before anything moves. The download is kept only if it is the published key byte for byte (BLAKE2b); nothing about wallets is sent. The offline signer never downloads it (w_spendkey.rs) |

Laurel itself sends nothing to the publisher: no analytics, no crash
reporter, no accounts. On Android, Google Play shows the publisher crash and
ANR reports (stack traces, phone model, Android version) from phones whose
owners share usage and diagnostics with Google, as for any Play app; Laurel's
bundle carries debug symbols so those can be read. Before any public statement like "we collect nothing", re-audit this
table against the shipped build (FTC rules on deceptive claims apply).

## Planned features that change this map (each re-opens legal review)

| Planned | What changes |
|---|---|
| Tor or Nym mixnet | what the server sees |
| Swaps through a third-party provider | a provider receives funds and instructions; fees; sanctions questions |
| Auto-update | the publisher can change code on users' machines; signing becomes critical |
| Any fee | compensation affects several legal exclusions (a legal review comes first) |
