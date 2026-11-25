# Windows: the Microsoft Store

Laurel for Windows is the v1 build (real ZEC, mainnet alone, no module: D-033),
sold free through the Microsoft Store (decided 2026-11-17). The Store signs the
package and updates it; Laurel has no updater of its own.

- Store ID `9N6RD9DZJ8PQ`, https://apps.microsoft.com/detail/9N6RD9DZJ8PQ
- Identity: `packaging/msix/identity.json` (internal; it names the account's publisher)
- Name reserved 2026-11-17: **the first submission goes in by 2027-02-17**, or the
  reservation lapses.

## Building the package

```
set CARGO_TARGET_DIR=D:\laurel-win-target
set LAUREL_FEATURES=v1,prices
npx tauri build --features v1,prices --no-bundle
node scripts/store_msix.mjs            (or --dev for a local install)
```

`store_msix.mjs` refuses an exe that isn't the v1 build with prices and no other
module (release_rules.mjs, as for the phone's library; prices since 0.3.2, D-035), then packs `D:\laurel-store\<version>\Laurel_<version>_x64.msix`.

Local check before submitting: `--dev`, then with Developer Mode on,
`Add-AppxPackage -Register D:\laurel-store\<version>\layout\AppxManifest.xml`. It
must start, sync mainnet, scan a QR code with the webcam, lock and unlock, and close
saving (Sys_Close).

## Before the first submission

Submitted for certification 2026-11-18 (0.3.0, sha256 `939536E3…5EA08D3A`), then
withdrawn the same day, before it went live, for 0.3.1 with gate E's findings fixed:
certification cancelled and 0.3.1 put in 0.3.0's place (sha256 `7E6B9426…D12A28AC`),
so the first release anyone gets is 0.3.1. Held for **Publish now**: passing
certification does not put it live, so that click is all that's left.

0.3.2 (prices, D-035) is built, `D:\laurel-store\0.3.2\Laurel_0.3.2_x64.msix` (sha256
`54F57860…5410C5503`), for after 0.3.1 is live. Checked 2026-11-18 on the real wallet:
a beta's yes to prices read as off (no dollars, no CoinGecko); turned on, the balance
said ≈ $2.80 at $963.26 (0.00290507 ZEC); turned off, the dollars went at once and
no request followed in three minutes. The gate E fixes held on the same wallet.

0.3.1 passed certification 2026-11-19 and was set publishing 2026-11-20. Its terms
screen asked agreement to laurel.cash's terms of 2026-11-08, which spoke of the
Android testnet build alone; the site's new terms and policy (Windows, Android and
Laurel Testnet, real ZEC; the site repository's branch `site-windows-real-money`) are dated
2026-11-20, and 0.3.2 carries `TERMS_VERSION` 2026-11-20 so everyone agrees again.
**The site goes live before 0.3.2 does**, or 0.3.2 would ask agreement to the old
pages; 0.3.2 was rebuilt for this at 1f2ddda: sha256 `E81DB5CB…D80797E6F`, which
replaces the one above.

2026-11-20: 0.3.1 live in the Store. laurel.cash deployed with the new pages (Pages
7d7ee381, site 5350774). 0.3.2 submitted for certification as Submission 2,
with the CoinGecko listing line, feature and certification note; held for Publish now.
It passed certification and was set publishing the same day.

2026-11-24: 0.3.2 live. 0.3.3 (a first sync says it's getting ready instead of 0%, Home's
split stacks when its amounts don't fit, the log file back; laurel.cash/privacy names the
log, Pages 80a83e5b, site 28ee77e) built at 4f7703d,
`D:\laurel-store\0.3.3\Laurel_0.3.3_x64.msix` (sha256 `46CA8FA5…54868099`); the dev
package started and logged. Submitted for certification as Submission 3, held for
Publish now. It passed certification and was set publishing the same day.

- [x] Gate E on Windows (2026-11-18, 0.3.0, the exe from the MSIX layout): with
      0.00395507 ZEC sent to the public address, then shielded; a private send with a
      memo (arrived intact), a public one (memo blocked, warned), a payment request,
      three presses of Send at once (paid once), a send killed mid-way (paid once, the
      balance exact to the zat), Max (private balance 0), close and reopen. The other
      side was a second wallet in Laurel. Not run: Wi-Fi cut (the kill instead), the
      webcam (the request pasted), a restore from the phrase.
- [x] Release notes: 0.3.0's, written for a phone or a computer alike (one line is
      Windows' own); the first Store release is 0.3.0.
- [x] What the packaged app sees of an earlier install (checked 2026-11-17, 0.3.0 dev
      package): a folder that existed before the package was installed is used **in
      place** (Windows does this since 1903), so `%APPDATA%\com.rptxsoftware.wallet`
      and its vault are shared with the earlier install, and survive uninstalling the
      Store copy. Only on a computer that never had Laurel does its data live in the
      package's folder and leave with it. v1 reads `wallets\mainnet` alone, so an
      earlier install's testnet wallets are never opened (D-033). The listing says
      uninstalling *can* remove the data, which is true either way.
- [x] Screenshots: `D:\laurel-store\0.3.0\screens`, 1920×1080, dark and light, from
      `mock.html?mainnet` (made-up addresses and balances, the v1 page: no module).
- [x] The Store copy and another copy open at once: the Start-menu launch while the
      other ran left one process (the single-instance guard), since two engines over
      one wallet file would damage it.
- [x] For 0.3.1, from gate E, fixed 2026-11-18 (one commit each): a long address ran
      under Send's Paste / Scan / Choose; the review didn't say the recipient is
      private; Max could send a payment that is dust to its recipient (5,000 zat, kept
      out of their balance) without a word, and History didn't say why; the chart's
      axis repeated a label for small amounts (0.000, 0.001, 0.001); a pool's name
      broke in two beside a pending line.
- [x] Age rating (IARC): no purchases, no ads; memos count as users exchanging text,
      so 3+ everywhere but Germany, where USK gives 16+ ("Increased Communication
      Risks").

## Listing (en-us)

**Name:** Laurel

**Short description:**
A private Zcash wallet. Your keys stay on your computer.

**Description:**

Laurel is a Zcash wallet for Windows. It holds your ZEC privately, on your
computer, and nobody else can move it.

Laurel never sees your keys or your money. It keeps no account, no cloud copy and
no server of its own that could lose them. Your wallet is a recovery phrase that
you write down: with it, you can restore your wallet in Laurel or another
up-to-date Zcash wallet, and without it, nobody can, Laurel included.

- Private by default: payments go between private addresses, and money that
  arrives at a public address can be moved into your private balance in one step
- Clear payments: before anything is sent, you see the amount, the fee and where it
  goes, and a payment is never sent twice by mistake
- Payment requests and QR codes, with their memos
- Encrypted on your computer, with an optional password and auto-lock
- No analytics, no tracking, no ads
- Optional: your balance in US dollars, with the ZEC price from CoinGecko, off
  until you turn it on

Laurel connects to public Zcash servers to read the blockchain; those servers see
your IP address. If you turn on prices, Laurel also asks CoinGecko for the ZEC
price, which sees your IP address but nothing about your wallets. Uninstalling Laurel can remove its data from this computer, so
keep your recovery phrase safe before you do.

**Keywords:** Zcash wallet · non-custodial Zcash wallet · shielded ZEC · private
crypto wallet · self-custody wallet · privacy coin

**Product features:** the five bullets above go in the Store's own bulleted list;
the Store's description is the three paragraphs around them.

**Category:** Finance (subcategory: none fits better)

**Privacy policy:** https://laurel.cash/privacy
**Website:** https://laurel.cash
**Support contact:** security@laurel.cash

## Properties and declarations

- Free, all markets that allow crypto wallets; no in-app purchases, no ads.
- `runFullTrust`: Laurel is a Win32 desktop app (Tauri with the system's WebView2).
  It needs no elevation, installs no service or driver, and starts nothing at logon.
- `webcam`: only to scan a payment request's QR code, when the person asks.

## Certification notes (Additional testing information)

Laurel is a non-custodial Zcash wallet. To test: agree to the terms, choose a
password, create a wallet, and open Receive to see its addresses. Sending needs
ZEC; with an empty wallet, Send shows the amount check and refuses for lack of
funds, as it should. The webcam is used only to scan a payment request's QR code,
when the person asks. Laurel connects only to public Zcash lightwalletd servers
(zec.rocks, zec-node.cakewallet.com) over TLS, and, only after the person turns on
prices in Settings > General (off by default), to api.coingecko.com for the ZEC
price. It has no accounts, no sign-in and
no analytics, so no test credentials are needed.
