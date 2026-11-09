# Languages

Laurel speaks English today. Adding a language is one file of text, with the
compiler holding it to English's shape. It is never a rewrite.

## How it's built

- **Every word the screen shows is in one language object.** English is `EN` in
  `src/ui_text.ts`; its shape, widened to plain strings, is `text_t`. A translation
  is an object of type `text_t`, so the compiler refuses a missing key, or a message
  whose parameters differ from English's.
- **Words only.** The text holds no values the code depends on. A choice's options
  are `{ value: label }` maps, with the order kept in the screen (`Com_Options`).
  Icons, links and sample data stay in the code. A translator can't break a value.
- **Sentences are whole.** Anything inside a sentence is a parameter, or a `{slot}`
  that `UI_Slots` fills with a component (`"{now} can be sent now; {later} is still
  being checked."`). A language puts the slots where its grammar wants them.
- **Counting is each language's own.** `plural( n, { one, few, many, other } )` uses
  `Intl.PluralRules`: English has two forms, Polish three, Arabic six. check_owners
  refuses `n === 1 ?` in any text file.
- **Lists, dates, numbers and amounts** follow the language: `Com_List`
  (`Intl.ListFormat`), `Intl` dates and relative times, and ZEC amounts written with
  the language's decimal mark ("1,50"). Amounts stay exact strings, never floats.
- **Rust says things in the UI's words.** Errors, system notifications and file
  pickers come from Rust. The UI hands Rust its words as it starts (`RUST_WORDS`,
  `W_SetWords_f`): each error's sentence by its code (`errors`), file names
  (`files`), notification titles (`native`). Rust fills in the values; its own
  English is only for the log, and a fallback before the words arrive.
  English's error sentences are Rust's own, written once in `werr_t` and generated
  into `src/generated/errors.ts` (`npm run bindings`); a translation writes all of
  them. check_owners holds them to `werr_t`: none asking for a value its kind
  doesn't send.
- **Zcash's names** (Ironwood, Sapling, Orchard, Transparent, Mainnet, Testnet) are
  in the text too (`poolNames`, `networks`). Keeping, transliterating or translating
  them is the translator's call.

## Adding a language

1. Add its tag to `LOCALES` in `src/ui_locale.ts` (for example `"es"`).
2. Make a new file beside `src/ui_text.ts`, named ui_text_ and the tag, exporting `ES: text_t`, starting from a copy of `EN`
   with `const plural = Com_Plural( "es" )`. The compiler lists every key still
   missing, with its parameters.
3. Register it in `LANGUAGES` in `src/ui_text.ts`. The compiler asks for every
   tag in `LOCALES`.
4. Release notes: `releaseNotes` maps each version to its lines. A version the
   translation lacks shows in English.
5. Try it: `npm run dev`, then open the mock with `?locale=es`. Laurel otherwise
   follows the system's language order.

## Proof, every check

`npm run layout` draws the dashboard a second time in the pseudo-locale `en-XA`,
which is English made a third longer, accented, and marked ⟦ ⟧. The check
fails if:

- a label has no room to grow (text a third longer is about what German or
  Spanish need), or
- any word on screen isn't from the language's text, because no translation
  would reach it. The mock's own sample names are the only exceptions, listed in
  `scripts/check_layout.mjs`.

The first run found the release notes, the pool and network names, and an
English list comma. All of them are in the text now.

## Not yet

- **Not every screen is checked this way.** The pseudo-locale pass covers the
  dashboard; sheets and settings are only held by the compiler and the rules above.
- **Alert prices are written by Rust as `$123.45`.** Rust has no `Intl`; every other
  price on screen is the UI's.
- **Technical details stay as they come.** A server's or the engine's own text
  under "Details" isn't Laurel's to translate.
