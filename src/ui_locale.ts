/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_locale.ts -- which language the screens speak, and what every
// language needs besides its words
//
// A language is one object of text_t (ui_text.ts), which the compiler
// holds to English's shape: every key, every message's parameters. What
// English would otherwise bake into its sentences lives here instead:
// plural forms (Intl.PluralRules: English has two, Polish three, Arabic
// six), and the language dates and numbers are written in (ui_local.ts).
// "en-XA" is the pseudo-locale: English made longer and accented, so a
// sentence that isn't in text_t, or a label with no room to grow, shows.

// every language there is text for; ui_text.ts gives each its text_t
export const LOCALES = [ "en", "en-XA" ] as const;
export type locale_t = typeof LOCALES[number];

/*
==================
Com_PickLocale

?locale= first (the layout check, a translator trying one out), then
the system's languages in its order, by exact tag, then by language
alone; English when none is here. The pseudo-locale only when asked.
==================
*/
function Com_PickLocale(): locale_t {
	let asked: string | null = null;
	try {
		asked = new URLSearchParams( window.location.search ).get( "locale" );
	} catch {
		// no window (a unit test's module load): the system's, then English
	}
	const wanted = [ ...( asked ? [ asked ] : [] ), ...( typeof navigator !== "undefined" ? navigator.languages ?? [] : [] ) ];
	const real = LOCALES.filter( ( l ) => l !== "en-XA" || asked === "en-XA" );
	for ( const tag of wanted ) {
		const exact = real.find( ( l ) => l.toLowerCase() === tag.toLowerCase() );
		const base = real.find( ( l ) => l === tag.split( "-" )[0].toLowerCase() );
		if ( exact ?? base ) {
			return ( exact ?? base )!;
		}
	}
	return "en";
}

export const LOCALE: locale_t = Com_PickLocale();

try {
	document.documentElement.lang = LOCALE;		// screen readers pronounce it as this language
} catch {
	// no document (a unit test's module load)
}

/*
==================
Com_Plural

A language's plural chooser: its forms by the categories its own rules
name (Intl.PluralRules), "other" always. English gives one and other;
a language with few or many gives those too.
==================
*/
export type plural_t = { other: string } & Partial< Record< Intl.LDMLPluralRule, string > >;

export function Com_Plural( locale: string ): ( n: number, forms: plural_t ) => string {
	const rules = new Intl.PluralRules( locale );
	return ( n, forms ) => forms[ rules.select( n ) ] ?? forms.other;
}

/*
==================
Com_List

Several names as one phrase, the language's way: "Ironwood and Sapling",
"Ironwood y Sapling" (Intl.ListFormat), never English's comma
==================
*/
export function Com_List( items: readonly string[] ): string {
	return Com_ListIn( LOCALE )( items );
}

// a language's own list joiner, for its text (as Com_Plural is its counting)
export function Com_ListIn( locale: string ): ( items: readonly string[] ) => string {
	const format = new Intl.ListFormat( locale, { style: "long", type: "conjunction" } );
	return ( items ) => format.format( items );
}

/*
==================
Com_Pseudo

The pseudo-locale made from a language: every sentence accented and a
third longer, between ⟦ and ⟧, so text that isn't from text_t reads plain
beside it, and a label with no room to grow overflows where it can be
seen. Links stay links; {slots} stay slots.
==================
*/
const ACCENTS: Record< string, string > = {
	a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", c: "ç", n: "ñ", s: "š", z: "ž",
	A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", Y: "Ý", C: "Ç", N: "Ñ", S: "Š", Z: "Ž",
};

export function Com_PseudoText( text: string ): string {
	if ( /^(https?:|mailto:)/.test( text ) || text.length === 0 ) {
		return text;
	}
	const accented = text.split( /(\{\w+\})/ ).map( ( part, i ) => i % 2 ? part : part.replace( /[a-zA-Z]/g, ( c ) => ACCENTS[c] ?? c ) ).join( "" );
	return `⟦${accented}${"·".repeat( Math.ceil( text.length / 3 ) )}⟧`;
}

export function Com_Pseudo< X >( text: X ): X {
	if ( typeof text === "string" ) {
		return Com_PseudoText( text ) as X;
	}
	if ( typeof text === "function" ) {
		return ( ( ...args: unknown[] ) => Com_Pseudo( ( text as ( ...a: unknown[] ) => unknown )( ...args ) ) ) as X;
	}
	if ( Array.isArray( text ) ) {
		return text.map( ( v ) => Com_Pseudo( v ) ) as X;
	}
	if ( typeof text === "object" && text !== null ) {
		const out = {};
		for ( const key of Object.keys( text ) ) {
			const d = Object.getOwnPropertyDescriptor( text, key )!;
			Object.defineProperty( out, key, d.get
				? { enumerable: true, get: () => Com_Pseudo( d.get!.call( text ) ) }		// a getter asks again each time (the coin's name)
				: { enumerable: true, value: Com_Pseudo( d.value ) } );
		}
		return out as X;
	}
	return text;
}

/*
==================
widen_t

A language's shape from English's: every sentence a string (not English's
own words), every message's parameters kept
==================
*/
export type widen_t< X > =
	X extends string ? string :
	X extends ( ...a: infer A ) => infer R ? ( ...a: A ) => widen_t< R > :
	X extends readonly ( infer E )[] ? readonly widen_t< E >[] :
	X extends object ? { readonly [ K in keyof X ]: widen_t< X[K] > } :
	X;
