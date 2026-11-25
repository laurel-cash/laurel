# Laurel release notes

What changed in each version, newest first. Laurel shows the newest once
after an update, and Settings > About lists them all; the release puts this
file beside the installers. The app reads it as it is built
(`src/ui_notes.tsx`), so the format is kept simple: a `## version · date`
heading, then one plain sentence per `- ` line (no links or markup: the app
shows them as text). `scripts/check_version.mjs` refuses a version with no
notes of its own.

## 0.3.3 · 2026-11-24

- A restored wallet says it's getting ready while Laurel sets up its first sync, instead of sitting at 0%.
- On Home, the private, public and pending amounts go one per line when they don't fit side by side.
- Laurel keeps its small log file again, so a problem can be looked into afterwards.

## 0.3.2 · 2026-11-20

- Laurel's terms of use and privacy policy now cover Laurel for Windows and real ZEC, so Laurel asks you to agree to them once more.
- [prices] Laurel can show your balance in US dollars under it, with the ZEC price from CoinGecko. It's off until you turn it on in Settings > General, and CoinGecko sees your IP address, never anything about your wallets.
- [prices] The chart can show what your account was worth in dollars over time, and the ZEC price itself, once prices are on.

## 0.3.1 · 2026-11-18

- Before you send, the review says whether the address you're paying is private or public.
- Laurel warns before sending a payment so small that it costs its recipient as much in fees as it holds, and History explains one you received.
- A long address in Send is shown in full, above the Paste, Scan and Choose buttons.
- The balance chart labels small amounts clearly, and pool names on Home no longer break in two.

## 0.3.0 · 2026-11-17

- Each payment in History opens its own page: who was paid and from where, its confirmations, your note and category, and Send Again, Copy ID and View in Explorer.
- Home says how many payments are still on their way, and opens History on them.
- Settings > Advanced > Send From Public Money pays from public money as it is, for exchanges that ask for it. It's off unless you turn it on.
- Receive > New Address gives another public address once the current one has received money.
- Public money is shielded one address at a time, and the review says when a payment would tie public addresses together.
- The public balance lists each address and what it holds, each with its own Shield.
- [windows] Notifications on Windows show under Laurel's name.

## 0.2.0 · 2026-11-10

- Laurel now uses real ZEC on the Zcash network.
- Before you start, Laurel asks you to agree to its terms of use and privacy policy.
- Your test wallets from the beta stay on this device but aren't opened. Test coins have no value.
- Payments are checked more strictly before they're sent. If Laurel can't tell whether a payment went out, it holds those coins until it knows.
- Laurel only uses servers that are on the right network and up to date.
- View-only wallets can't send in this version.

## 0.1.8 · 2026-11-08

- Updated to the latest Zcash libraries, with the final settings for the network's recent upgrade.
- If Laurel can't tell whether a payment went out, its coins stay reserved until the payment is mined or expires.
- Removing a wallet asks for your password, if you set one.
- Start Over also erases Laurel's logs, and is offered when Laurel's key file is damaged or missing.
- When you choose a new password, Laurel says how strong it is.

## 0.1.7 · 2026-11-06

- Times shown for pending payments now match the network's faster blocks since its recent upgrade.
- If the network drops a payment before it is mined, Laurel sends it again until it expires.

## 0.1.6 · 2026-10-29

- Laurel refuses a wallet or contacts file that isn't encrypted, instead of opening it.
- Settings > About shows Laurel's own license text.

## 0.1.5 · 2026-10-27

- Laurel no longer stops with an error when Android closes it in the background.
- Start Over on a phone opens Laurel again as new, instead of closing it.
- On a phone whose Android System WebView is too old, Laurel says how to update it instead of showing a blank screen.

## 0.1.4 · 2026-10-25

- Laurel is offered for phones and tablets only, no longer for Android TV.

## 0.1.3 · 2026-10-24

- Another maintenance build for testing on more phones; nothing changes in how Laurel works.

## 0.1.2 · 2026-10-21

- A maintenance build, so Laurel can be tested on more phones; nothing changes in how it works.

## 0.1.1 · 2026-10-21

- On a phone, switch to another app and come back within a minute, and Laurel is still open; Settings > Security > Lock When You Leave sets how long.
- Coming back after that time, Laurel is locked before any of your wallets show.

## 0.1.0 · 2026-09-28

- The first preview of Laurel, for Zcash's test network only: its coins have no value.
- Create a wallet or restore one from its recovery phrase, a viewing key, or a zcashd wallet's keys; several wallets and accounts side by side.
- Send, receive, and shield public money, with every payment reviewed before it goes, and a pending payment shown as pending until the network settles it.
- Move Orchard money into Ironwood, Zcash's newest private pool, and sweep a single private key such as a paper wallet.
- History with notes, categories and a CSV export; an address book; repeating payments that remind you and never send by themselves.
- The ZEC price and price alerts, only when you turn prices on.
- Wallets are encrypted on your device, with your own password or, on Windows, your Windows account, and Laurel locks itself after the time you choose.
