# Laurel release notes

What changed in each version, newest first. Laurel shows the newest once
after an update, and Settings > About lists them all; the release puts this
file beside the installers. The app reads it as it is built
(`src/ui_notes.tsx`), so the format is kept simple: a `## version · date`
heading, then one plain sentence per `- ` line (no links or markup: the app
shows them as text). `scripts/check_version.mjs` refuses a version with no
notes of its own.

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
