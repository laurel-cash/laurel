# Security

## The hard rule: non-custodial

Laurel never holds, sees, stores remotely, or can recover a user's keys or funds.
No feature may break this: no cloud backup Laurel can read, no "we'll keep it safe
for you", no pooled balances, no server that signs anything. Beyond being the right
design, custody would make the project a regulated money transmitter.

Laurel itself sends nothing to its publisher: no analytics, no crash
reporter, no accounts. On Android, Google Play shows the publisher crash and
ANR reports (stack traces, phone model, Android version) from phones whose
owners share usage and diagnostics with Google, as for any Play app; Laurel's
bundle carries debug symbols so those can be read. It does talk to a third-party lightwalletd server, which sees the user's
IP. CONTROL-MAP.md lists every data flow; public claims must match it.

## Threat model

Most likely first:

| Threat | What it looks like | Main defenses |
|---|---|---|
| Impersonation and phishing | fake download sites, fake "support" DMs, fake store listings, all after recovery phrases | one official links page; "we never DM first, never ask for your phrase" in the app and on the site; no support in DMs |
| Account takeover | SIM swap, phished email or GitHub, leading to the domain, repo or signing keys | hardware-key 2FA, no SMS, password manager, carrier port-out PIN |
| Supply-chain attack | malicious code slipped into a release, draining every user | protected `main`, required checks, review, signing keys in hardware, signed releases with checksums, later reproducible builds |
| Local theft of wallet files | malware, stolen laptop, synced backup folder copies `%APPDATA%`; malware replaces files under the user's account | encryption at rest (XChaCha20-Poly1305; a plain file in an encrypted file's place is refused), optional password, lock screen |
| Network observation | the server sees the user's IP and which blocks they fetch | server choice setting; later Tor or the Nym mixnet |
| Angry users | people who lost funds (usually their own phrase or a phishing site) harass the developers | clear docs and warnings, public support channels only, moderation |
| Physical ("wrench") attacks | targets people known to hold a lot of crypto | never discuss personal holdings; keep the team's identity separate from the project |

## Checklists

### Identity (the people behind the project)

- [x] The project's assets belong to its publishing company, not to a person.
- [ ] GitHub commits use the account's `@users.noreply.github.com` email, never a personal one. Set it **before the first push**; pushed history is permanent.
- [ ] Role addresses for anything public: `team@`, `security@`, `hello@` on the project domain.
- [ ] A registered-agent or mailbox address everywhere an address is asked (domain, stores, invoices); never a home address.
- [ ] No public talk about personal crypto holdings.
- [x] The publishing company's name appears only where stores and certificates require it.

### Accounts

- [ ] Two hardware security keys (one as backup) on GitHub, email, domain registrar, Cloudflare, and app-store/developer accounts.
- [ ] No SMS two-factor anywhere. Authenticator app at minimum.
- [ ] Carrier SIM / port-out PIN on the project phone number.
- [ ] Password manager (Bitwarden or 1Password), unique passwords everywhere.
- [ ] A separate browser profile, ideally a separate device, for admin work.
- [ ] At least two owners on the GitHub organization, so a lost account can't lock the project out.

### Code and releases

- [ ] `main` is protected: changes arrive by pull request, `npm run check` must pass.
- [ ] A second person reviews changes to the engine layer, crypto, updater and release scripts.
- [ ] Dependencies are pinned (`Cargo.lock`, `package-lock.json` committed); updates are deliberate, reviewed commits.
- [ ] Release signing keys live in hardware or a signing service (e.g. Azure Trusted Signing), never as a file on a laptop.
- [ ] Every release publishes SHA-256 checksums, signed.
- [ ] Later: reproducible builds, so anyone can check a release matches the source.
- [ ] Changes to vendored zingolib follow ENGINE.md: never touch cryptography.

### Users and community

- [ ] One official links page on the project site listing every real channel.
- [ ] In the app and on the site: "Laurel will never ask for your recovery phrase. We never DM first."
- [ ] Support happens in public channels only.
- [ ] `security@` published, with a short disclosure policy (how to report, what we promise in return).

## A lock is not spending protection

An app password or auto-lock doesn't protect the funds: anyone holding the
recovery phrase can restore the wallet elsewhere without it. The lock and help
texts say so plainly, and never imply otherwise.

## Money-loss audit

[SECURITY-TODO.md](SECURITY-TODO.md) walks 100 ways a self-custody wallet loses
funds (theft, payment to the wrong place, fees, unreachable funds, false
confirmations) and records, for each, whether Laurel handles it, which file
does, and what remains to do. Its open items are release blockers before
mainnet, in the order written there.

## Reporting a vulnerability

Email **security@laurel.cash**. Please don't open a public
issue for anything that could put users' funds at risk.
