# Roadmap

Status as of 2026-09-26.

## Done

- Onboarding: create a wallet, four-step backup (why, reveal, check, done).
- Restore from a 12–24 word phrase (autocomplete, paste, live checking, date as
  birthday) or a viewing key (view-only wallet).
- Many wallets with named accounts; sidebar switcher; add account (new or used
  before), rename, back up from the menu.
- Home: current account's balance, per-pool breakdown, live sync.
- Engine groundwork: generated bindings, per-wallet locks, single-flight loading,
  stale-update protection, save on exit.
- Encryption at rest (Windows-protected key by default), optional password, lock
  screen, Settings → Security. Linux still needs a key store (secret-service) and
  meanwhile requires a password.
- Offline-first: wallets open without the network; sync connects and retries.
- UI tests (Vitest) and wallet-loading tests.
- Receive: private and public addresses, QR code, fresh address, faucet link.
- Send: compose, review with fee, send; spend from a chosen pool (zingolib patch,
  ENGINE.md); memos; scan a QR code or image.
- Shield public money; move Orchard to Ironwood (immediate).
- History with search and day groups; balance chart; payment toasts and system
  notifications (never with the amount).
- Sync that explains itself: dates, not blocks; time left; pause; offline countdown
  and Try Now; automatic repair of damaged sync data, once per session.
- The engine can't freeze the UI: every wallet-lock access goes through
  w_engine.rs, enforced by clippy (`npm run lint`).
- Storage: browser caches off, a janitor before the window opens, Settings >
  Storage shows what is kept and warns when the disk is nearly full.
- Server choice: automatic with failover, or your own (checked first).
- Lock Now, remove a wallet safely, Laurel's icon, light and dark themes.
- About, with every open-source license (`npm run notices`).
- Guards in `npm run check`: duplicate code, loads are keyed queries, shared UI
  shapes have one owner, notices are current, clippy lock rules.

## Next, in order

1. **Funded testnet pass.** Done 2026-10-10 for send, shield, Sapling into
   Ironwood and History, funded from `glory`, no faucet needed.
   Migration waits for a wallet with real Orchard notes, which NU6.3 stopped
   making: test it against a restored older wallet.
2. **Scheduled (private) migration**, once step 1 can verify it (w_migrate.rs).
3. **Speed:** benchmark harness, then the pepper-sync change that fetches outside
   the wallet lock (ENGINE.md), in our fork.
4. **CSS Modules**, so class names can't collide across screens (three did).
5. **Privacy:** Tor or the Nym mixnet (zingolib has Nym support behind a feature).

## Before mainnet

- Linux key store for the default (no-password) protection.
- Re-evaluate librustzcash vs our zingolib fork.
- Lawyer review, Terms of Service, Privacy Policy.
- Security checklists done (SECURITY.md).
- Code signing, signed releases with checksums, release notes, an update check.
- An independent security audit, published with its findings.
- A security notice channel in the app (engine or Laurel advisories).
- An accessibility audit: keyboard only, screen reader, contrast, text scaling.
- Private beta on testnet with 10–20 people.

## Later

- Windows Hello unlock, auto-lock.
- "Share with my accountant" (export viewing key), tax CSV export.
- Swaps, only after counsel reviews the specific model. Until then, revenue from grants, donations or paid software rather than transaction fees.
- Fiat prices.
- Translations and right-to-left layout.
- Hardware wallet: Keystone (PCZT), once the engine supports it.
- Multisig (FROST).
- Mac.
- **iPhone, only after the Android launch succeeds** (decided 2026-10-11). Tauri and
  zingolib both run on iOS; what it takes:
  - a Mac to build on: GitHub's macOS runners (free minutes are few on a private repo),
    or a rented one;
  - Apple's developer program ($99 a year);
  - an iOS side for the 22 Android-only spots in src-tauri/src (the Keychain for key
    storage, file actions, screenshot blocking, the camera);
  - syncing when the app is open, since iOS limits background work.
  Order: a free simulator build first, then the port, then TestFlight.
