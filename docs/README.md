# Laurel docs

Laurel is a self-custodial Zcash wallet for Android, Windows and Linux: Tauri 2,
a Rust engine on zingolib, and a React UI. Testnet only for now.

## Start here

| Document | Read it when |
|---|---|
| [DEVELOPMENT.md](DEVELOPMENT.md) | setting up a machine, building and running the desktop app, and the build problems already solved |
| [ANDROID.md](ANDROID.md) | building, testing and releasing for Android |
| [ARCHITECTURE.md](ARCHITECTURE.md) | you need to know how the engine, bindings, store and UI fit together |
| [../STYLE.md](../STYLE.md) | before writing code: the style, single ownership, the `npm run check` gate |

## Security and privacy

| Document | What it is |
|---|---|
| [SECURITY.md](SECURITY.md) | the threat model, the non-custodial rule, the security checklists |
| [CONTROL-MAP.md](CONTROL-MAP.md) | who can authorize, block, recover or see what; every connection Laurel makes |
| [SECURITY-TODO.md](SECURITY-TODO.md) | 100 ways a wallet loses money, where Laurel stands on each, and what's still open before mainnet |

## How parts work

| Document | What it is |
|---|---|
| [ENGINE.md](ENGINE.md) | zingolib, our fork of it, pulling upstream, sync speed (`npm run check` reads its fork ledger) |
| [SYNC.md](SYNC.md) | encrypted sync of contacts and notes through a folder the person's computers share |
| [OFFLINE-SIGNING.md](OFFLINE-SIGNING.md) | signing on a computer that never goes online |
| [LOCALIZATION.md](LOCALIZATION.md) | adding a language |

## History and plans

| Document | What it is |
|---|---|
| [DECISIONS.md](DECISIONS.md) | why things are done the way they are |
| [ROADMAP.md](ROADMAP.md) | what's next, what blocks mainnet, what's later |
| [RELEASE-NOTES.md](RELEASE-NOTES.md) | what changed in each version (the app shows these) |

Three rules that override everything else:

1. **Laurel is non-custodial, always.** Laurel never holds, sees or can recover a
   user's keys or funds. No feature may change that. See [SECURITY.md](SECURITY.md).
2. **Every fact has one owner.** Rust owns types, commands and constants; the UI
   uses the generated `src/bindings.ts`. See [../STYLE.md](../STYLE.md).
3. **No dead ends in the UI.** No button that silently does nothing; every flow
   has a way back; unfamiliar ideas get an (i) explanation.
