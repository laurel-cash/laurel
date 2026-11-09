/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_local.ts -- ui-only definitions and formatting
//
// Engine types, commands, events and constants come from ./bindings,
// generated from rust. Nothing here may mirror them.

import type { addressKind_t, balance_t, errorInfo_t, network_t, paymentEvent_t, pool_t, priceAlertEvent_t, syncProgress_t, walletSummary_t } from "./bindings";
import PACKAGE from "../package.json";
import { LOCALE } from "./ui_locale";

export * from "./bindings";

// testnet until sending and restoring have been proven on it

// package.json owns the version; tauri.conf.json points at it
export const APP_VERSION = PACKAGE.version;

export const ZATS_PER_ZEC = 100000000;
const ZEC_DECIMALS = 8;


/*
=========================================================================

TYPES

=========================================================================
*/

// which account the user is looking at
export type selection_t = {
	walletId:		string;
	account:		number;
};


export type poolInfo_t = {
	pool:			pool_t;			// its name is the language's: Com_PoolName (ui_text.ts)
	shielded:		boolean;
	legacy:			boolean;
};

// which address a pool takes new payments at (Receive's side); none for Orchard: since
// NU6.3 a payment to an Orchard receiver arrives in Ironwood
export function Com_PoolAddress( pool: pool_t ): addressKind_t | null {
	switch ( pool ) {
	case "ironwood":	return "private";
	case "sapling":		return "sapling";
	case "transparent":	return "public";
	case "orchard":		return null;
	default:			return Com_Unreachable( pool );
	}
}

// the pool an address kind pays into: Com_PoolAddress read backwards, so the two
// can't disagree (every kind is some pool's: ui_pool.test.tsx)
export function Com_AddressPool( kind: addressKind_t ): pool_t {
	return POOLS.find( ( p ) => Com_PoolAddress( p.pool ) === kind )!.pool;
}

// display order: where money should live first. pool_t comes from the
// engine's balance_t, so a pool added in rust fails to compile here
export const POOLS: poolInfo_t[] = [
	{ pool: "ironwood",		shielded: true,		legacy: false },
	{ pool: "sapling",		shielded: true,		legacy: false },
	{ pool: "orchard",		shielded: true,		legacy: true },
	{ pool: "transparent",	shielded: false,	legacy: false },
];


/*
=========================================================================

FORMATTING

=========================================================================
*/

/*
==================
Com_FormatZec

Zatoshis to a ZEC string. Trailing zeros are trimmed, but never below
two decimals, so 1.5 ZEC reads "1.50" and dust still shows every digit.
Whole-number arithmetic only: every zatoshi count is an exact integer
(the whole supply is under 2^53), and a division into a float could round
the last digit of a large amount before it reached the screen.
==================
*/
export function Com_FormatZec( zats: number ): string {
	const whole	= Math.floor( zats / ZATS_PER_ZEC );
	const frac	= String( zats - whole * ZATS_PER_ZEC ).padStart( ZEC_DECIMALS, "0" ).replace( /0+$/, "" );

	return `${whole}${DECIMAL}${frac.padEnd( 2, "0" )}`;
}

// the language's decimal mark ("1.50", "1,50"); amounts stay exact strings, never floats.
// Com_ParseZec reads either mark, and asks when "1,500" could be both
const DECIMAL = ( 1.5 ).toLocaleString( LOCALE ).charAt( 1 );

// every way Laurel writes a time, in the language the screens speak (ui_locale.ts)
export type dateStyle_t = "day" | "shortDay" | "monthDay" | "month" | "time";

const DATE_STYLES: Record< dateStyle_t, Intl.DateTimeFormatOptions > = {
	day:		{ year: "numeric", month: "long", day: "numeric" },		// March 4, 2026
	shortDay:	{ year: "numeric", month: "short", day: "numeric" },	// Mar 4, 2026
	monthDay:	{ month: "short", day: "numeric" },						// Mar 4
	month:		{ month: "short", year: "numeric" },					// Mar 2026
	time:		{ hour: "numeric", minute: "2-digit" },					// 3:07 PM
};

/*
==================
Com_Unit

The coin's name on a network (testnet coins are TAZ, as the faucet and
explorers say); the network's own name is the language's (Com_NetworkName)
==================
*/
export function Com_Unit( net: network_t ): string {
	return net === "mainnet" ? "ZEC" : "TAZ";
}


/*
==================
Com_FormatUsd

A price in dollars, "$58.20"; Rust's f64 arrives as null when it isn't a
number (JSON has no NaN). Was made twice, by the chart and the alerts.
==================
*/
const USD = new Intl.NumberFormat( LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 } );

export function Com_FormatUsd( usd: number | null ): string {
	return usd == null ? "—" : USD.format( usd );
}

/*
==================
Com_FormatDate
==================
*/
export function Com_FormatDate( unixTime: number, style: dateStyle_t = "day" ): string {
	return new Date( unixTime * 1000 ).toLocaleString( LOCALE, DATE_STYLES[style] );
}

const AGO_STEPS: [ Intl.RelativeTimeFormatUnit, number ][] = [
	[ "minute", 60 ], [ "hour", 3600 ], [ "day", 86400 ], [ "week", 604800 ], [ "month", 2629800 ], [ "year", 31557600 ],
];

/*
==================
Com_Ago

How long ago, as a person says it: "just now", "3 days ago"
==================
*/
export function Com_Ago( unixTime: number, now = Date.now() / 1000 ): string {
	const secs = Math.max( 0, now - unixTime );
	if ( secs < 60 ) {
		return new Intl.RelativeTimeFormat( LOCALE, { numeric: "auto" } ).format( 0, "second" );
	}
	let unit = AGO_STEPS[0];
	for ( const step of AGO_STEPS ) {
		if ( secs >= step[1] ) {
			unit = step;
		}
	}
	return new Intl.RelativeTimeFormat( LOCALE, { numeric: "auto" } ).format( -Math.floor( secs / unit[1] ), unit[0] );
}

const ABBREV_OVER = 48;		// only longer is shortened: a public address (35) always shows whole

/*
==================
Com_Abbrev

The one way a long identifier (a private address, a transaction id) is
shortened: its start and its end, the parts a person compares by eye.
==================
*/
export function Com_Abbrev( s: string, edge = 10 ): string {
	return s.length <= ABBREV_OVER ? s : `${s.slice( 0, edge )}…${s.slice( -edge )}`;
}

/*
==================
Com_LookAlike

The known address (a contact, someone this account paid) that a
different one imitates, if any. Poisoners make an address whose ends
match one you've used, because the ends are what people compare. The
fixed prefix every address of a kind shares ("utest1", "tm") says
nothing, so the ends after it are compared; a genuine different address
matches them by chance about once in a trillion.
==================
*/
const ADDRESS_PREFIXES	= [ "utest1", "u1", "ztestsapling1", "zs1", "textest1", "tex1", "tm", "t1", "t2", "t3" ];
const LOOK_EDGE			= 4;

function Com_AddressBody( address: string ): string {
	const prefix = ADDRESS_PREFIXES.find( ( p ) => address.startsWith( p ) );
	return prefix ? address.slice( prefix.length ) : address;
}

export function Com_LookAlike< K extends { address: string } >( to: string, known: K[] ): K | null {
	const body = Com_AddressBody( to );
	if ( body.length < 2 * LOOK_EDGE ) {
		return null;
	}
	return known.find( ( k ) => {
		const kb = Com_AddressBody( k.address );
		return k.address !== to && kb.slice( 0, LOOK_EDGE ) === body.slice( 0, LOOK_EDGE ) && kb.slice( -LOOK_EDGE ) === body.slice( -LOOK_EDGE );
	} ) ?? null;
}

/*
==================
Com_MemoAsksForSecrets

A memo is anyone's words: the scam kind asks for a recovery phrase or a
key ("support needs your 24 words"). Only ever a reason to warn, never to
hide or trust anything.
==================
*/
const SECRET_ASKS = /\b(seed|recovery|mnemonic|secret)\s+(phrase|words?)\b|\b(12|24|twelve|twenty-four)\s+words\b|\b(private|spending|viewing)\s+key\b|\bwallet\.dat\b/i;

export function Com_MemoAsksForSecrets( memo: string ): boolean {
	return SECRET_ASKS.test( memo );
}

/*
==================
Com_AsciiDigits

Digits and marks as 0-9, "." and ",". A phone set to Arabic or Persian
types ٠-٩ or ۰-۹ on its number pad, Chinese and Japanese input fullwidth
０-９: as typed, every amount read as bad, and none could be entered
==================
*/
const DIGIT_ZEROS = [ 0x0660, 0x06F0, 0xFF10 ];		// Arabic-Indic, Extended Arabic-Indic (Persian, Urdu), fullwidth
const MARKS: Record< string, string > = { "\u066B": ".", "\u066C": ",", "\uFF0E": ".", "\uFF0C": "," };

export function Com_AsciiDigits( text: string ): string {
	return Array.from( text, ( c ) => {
		const code = c.codePointAt( 0 ) ?? 0;
		const zero = DIGIT_ZEROS.find( ( z ) => code >= z && code <= z + 9 );
		return zero !== undefined ? String( code - zero ) : MARKS[c] ?? c;
	} ).join( "" );
}

/*
==================
Com_ParseZec

Typed ZEC to zatoshis, from the string, never through a float: "0.1"
is exactly 10,000,000. A comma is taken as the decimal point, unless it
could as well group thousands: then both readings come back, for the
person to choose, never one guessed. Anything else that isn't a plain
amount with at most 8 decimals is bad. Digits are read whichever the
keyboard typed (Com_AsciiDigits)
==================
*/
export type amount_t =
	| { kind: "ok"; zats: number }
	| { kind: "ambiguous"; thousands: string; decimal: string }		// "1,000": as 1000, or as 1.000
	| { kind: "bad" };

// "1,000" could be one thousand (a grouping comma) or one (a decimal comma);
// "0,250" or "1,5" can only be decimals. The mark in doubt is the language's
// grouping one: where amounts are written "1,50" (DECIMAL), "1.000" is in doubt,
// and "1,000" is its own "1.000", never asked about
const GROUP = DECIMAL === "," ? "." : ",";
const AMBIGUOUS = new RegExp( `^[1-9]\\d{0,2}\\${GROUP}\\d{3}$` );

export function Com_ParseZec( text: string ): amount_t {
	const raw = Com_AsciiDigits( text ).trim();
	if ( AMBIGUOUS.test( raw ) ) {
		return { kind: "ambiguous", thousands: raw.replace( GROUP, "" ), decimal: raw.replace( GROUP, "." ) };
	}
	const t = raw.replace( ",", "." );
	const m = /^(\d*)(?:\.(\d*))?$/.exec( t );
	if ( !m || ( m[1] === "" && !m[2] ) ) {
		return { kind: "bad" };
	}
	const frac = m[2] ?? "";
	if ( frac.length > ZEC_DECIMALS ) {
		return { kind: "bad" };
	}
	const zats = Number( m[1] || "0" ) * ZATS_PER_ZEC + Number( frac.padEnd( ZEC_DECIMALS, "0" ) );
	return Number.isSafeInteger( zats ) ? { kind: "ok", zats: zats } : { kind: "bad" };
}

/*
==================
Com_DateTicks

The times a chart writes under itself, first and last at its ends: as
many as its width has room for, two to four. Four always, a small phone
at the largest text size laid "Sep 21" over "Oct 1". long: a date with
its month and year, which needs more room
==================
*/
const DATE_TICKS_MAX	= 4;
const DATE_TICK_ROOM	= 72;		// px a short date ("Oct 11") needs beside the next

export function Com_DateTicks( first: number, last: number, width: number, long: boolean ): number[] {
	const n = Math.max( 2, Math.min( DATE_TICKS_MAX, Math.floor( width / ( DATE_TICK_ROOM * ( long ? 1.5 : 1 ) ) ) ) );
	return Array.from( { length: n }, ( _, i ) => first + ( last - first ) * i / ( n - 1 ) );
}

/*
==================
Com_FormatBytes

Sizes the way a Mac shows them: powers of 1000, one decimal when small
==================
*/
const BYTE_UNITS = [ "bytes", "KB", "MB", "GB", "TB" ];

export function Com_FormatBytes( n: number ): string {
	let i = 0;
	while ( n >= 1000 && i < BYTE_UNITS.length - 1 ) {
		n /= 1000;
		i++;
	}
	const digits = i === 0 || n >= 10 ? 0 : 1;
	return `${n.toFixed( digits )} ${BYTE_UNITS[i]}`;
}

/*
==================
Com_ErrorString

Engine errors arrive as strings; anything else is a bug worth seeing
==================
*/
export function Com_ErrorString( err: unknown ): string {
	return Com_ErrorOf( err ).message;
}

/*
==================
Com_ErrorOf

Whatever was thrown, as the engine's errorInfo_t: a message in words and
the raw text behind it, if any (w_local.rs). A javascript error has no
detail of its own.
==================
*/
export function Com_ErrorOf( err: unknown ): errorInfo_t {
	if ( typeof err === "object" && err !== null && "message" in err && typeof ( err as errorInfo_t ).message === "string" && !( err instanceof Error ) ) {
		const e = err as errorInfo_t;
		return { message: e.message, detail: e.detail ?? null, retry: e.retry === true };
	}
	if ( err instanceof Error ) {
		return Com_Error( err.message );
	}
	return Com_Error( typeof err === "string" ? err : JSON.stringify( err ) );
}

// a version's release notes (docs/RELEASE-NOTES.md): its day, and what changed
export type releaseNote_t = { version: string; date: string; items: string[] };

/*
==================
Com_ReleaseNotes

The notes as the file writes them: "## 0.1.0 · 2026-09-28" and a "- "
line per change, newest first. Anything else (the file's own preface) is
not a note.
==================
*/
export function Com_ReleaseNotes( text: string ): releaseNote_t[] {
	const notes: releaseNote_t[] = [];
	for ( const line of text.split( /\r?\n/ ) ) {
		const head = /^## (\S+) · (\d{4}-\d{2}-\d{2})\s*$/.exec( line );
		if ( head ) {
			notes.push( { version: head[1], date: head[2], items: [] } );
		} else if ( line.startsWith( "- " ) && notes.length ) {
			notes[notes.length - 1].items.push( line.slice( 2 ).trim() );
		}
	}
	return notes;
}

/*
==================
Com_Options

A choice's options: the values in the screen's order, each with its label
from the language's text. The text holds only words ({ value: label }),
so a translation can't change what a value is; the compiler asks for a
label for every value.
==================
*/
export function Com_Options< V extends string >( order: readonly V[], labels: Readonly< Record< V, string > > ): { value: V; label: string }[] {
	return order.map( ( v ) => ( { value: v, label: labels[v] } ) );
}

/*
==================
Com_Error

The one way the ui makes an error of its own: the same shape the engine
sends, and never one to retry on its own
==================
*/
export function Com_Error( message: string, detail: string | null = null ): errorInfo_t {
	return { message: message, detail: detail, retry: false };
}


/*
=========================================================================

PREFERENCES

per computer, per viewer: which account was open, the appearance, hidden
amounts. Losing one only means a default, so storage failures (private
mode, cleared data) are ignored. The one place that touches localStorage.

=========================================================================
*/

export type appearance_t = "system" | "light" | "dark";

export const PREF_SELECTION		= "laurel.selection";
export const PREF_OFFERED		= "laurel.passwordOffered";
export const PREF_APPEARANCE	= "laurel.appearance";
export const PREF_HIDE_AMOUNTS	= "laurel.hideAmounts";
export const PREF_NOTES_SEEN	= "laurel.notesSeen";		// the version whose notes were last shown (ui_notes.tsx)
export const PREF_HOME			= "laurel.home";			// the dashboard's cards: order and which show (Com_HomeLayout)
export const PREF_CHART_POOLS	= "laurel.chartPools";		// the balance chart split by pool (ui_chart.tsx)
export const PREF_ALL_POOLS		= "laurel.allPools";		// the pool list shows empty pools too (ui_home.tsx, UI_Pools)

// which pools the pool list shows: Ironwood always, any other while it holds money
// (confirmed or arriving); all of them when asked for. A person whose money is all in
// Ironwood never meets the word Sapling
export function Com_PoolsShown( b: balance_t | undefined, all: boolean ): { shown: poolInfo_t[]; hidden: poolInfo_t[] } {
	const inUse = ( p: poolInfo_t ) => all || p.pool === "ironwood" || ( !!b && b[p.pool].confirmed + b[p.pool].pending > 0 );
	return { shown: POOLS.filter( inUse ), hidden: POOLS.filter( ( p ) => !inUse( p ) ) };
}

/*
==================
Com_ReadPref

valid decides whether what was stored still has the right shape; if
not, the fallback is used
==================
*/
export function Com_ReadPref< V >( key: string, fallback: V, valid: ( v: unknown ) => v is V ): V {
	try {
		const v: unknown = JSON.parse( localStorage.getItem( key ) ?? "null" );
		return valid( v ) ? v : fallback;
	} catch {
		return fallback;
	}
}

export function Com_WritePref( key: string, value: unknown ) {
	try {
		localStorage.setItem( key, JSON.stringify( value ) );
	} catch {
		// see Com_ReadPref
	}
}

/*
==================
Com_ClearPrefs

Every pref of this browser gone: Start Over's part the engine can't reach
==================
*/
export function Com_ClearPrefs() {
	try {
		localStorage.clear();
		sessionStorage.clear();
	} catch {
		// see Com_ReadPref
	}
}

export const Com_IsSelection	= ( v: unknown ): v is selection_t =>
	!!v && typeof ( v as selection_t ).walletId === "string" && typeof ( v as selection_t ).account === "number";
export const Com_IsAppearance	= ( v: unknown ): v is appearance_t => v === "system" || v === "light" || v === "dark";
export const Com_IsBool			= ( v: unknown ): v is boolean => typeof v === "boolean";

/*
=========================================================================

THE DASHBOARD

the side column's cards, in the order the person chose, each shown or
not, and the balance chart shown or not (ui_dashboard.tsx)

=========================================================================
*/

export const HOME_CARDS = [ "repeats", "wallets", "network", "pools", "privacy" ] as const;
export type homeCard_t = typeof HOME_CARDS[number];
export type homeLayout_t = { order: homeCard_t[]; hidden: homeCard_t[]; chart: boolean };

export const HOME_DEFAULT: homeLayout_t = { order: [ ...HOME_CARDS ], hidden: [], chart: true };

const Com_IsHomeCard = ( v: unknown ): v is homeCard_t => HOME_CARDS.includes( v as homeCard_t );

/*
==================
Com_HomeLayout

Whatever was kept, as a layout: unknown cards (one a later version took
away) are dropped, each card is listed once, and a card this version has
that the kept order doesn't (one added since) comes last, shown. Anything
unreadable is the default.
==================
*/
export function Com_HomeLayout( kept: unknown ): homeLayout_t {
	if ( typeof kept !== "object" || kept === null ) {
		return HOME_DEFAULT;
	}
	const k = kept as Partial< Record< keyof homeLayout_t, unknown > >;
	const listed = Array.isArray( k.order ) ? k.order.filter( Com_IsHomeCard ) : [];
	const order = [ ...new Set( [ ...listed, ...HOME_CARDS ] ) ];
	const hidden = Array.isArray( k.hidden ) ? [ ...new Set( k.hidden.filter( Com_IsHomeCard ) ) ] : [];
	return { order: order, hidden: hidden, chart: typeof k.chart === "boolean" ? k.chart : true };
}

// a card one place earlier (-1) or later (+1); at an end it stays
export function Com_MoveCard( layout: homeLayout_t, card: homeCard_t, by: -1 | 1 ): homeLayout_t {
	const order = [ ...layout.order ];
	const from = order.indexOf( card );
	const to = from + by;
	if ( from < 0 || to < 0 || to >= order.length ) {
		return layout;
	}
	[ order[from], order[to] ] = [ order[to], order[from] ];
	return { ...layout, order: order };
}

/*
==================
Com_ShownCards

The side cards to draw, in order. A hidden card that has something due
shows anyway: hiding "Coming up" is about the page, and must not hide a
payment that is due now (the engine says which, Rp_List).
==================
*/
export function Com_ShownCards( layout: homeLayout_t, due: homeCard_t[] ): homeCard_t[] {
	return layout.order.filter( ( c ) => !layout.hidden.includes( c ) || due.includes( c ) );
}

export function Com_ShowCard( layout: homeLayout_t, card: homeCard_t, on: boolean ): homeLayout_t {
	const hidden = layout.hidden.filter( ( c ) => c !== card );
	return { ...layout, hidden: on ? hidden : [ ...hidden, card ] };
}

/*
==================
Com_ApplyTheme

"system" follows the OS; the others pin it (see color-scheme in ui.css)
==================
*/
export function Com_ApplyTheme( a: appearance_t ) {
	if ( a === "system" ) {
		delete document.documentElement.dataset.theme;
	} else {
		document.documentElement.dataset.theme = a;
	}
}


/*
==================
Com_SyncState

The one reading of the engine's sync progress into what the ui shows.
Every place that shows sync state switches on this, so they can't
disagree. The engine states each fact; nothing here is guessed.
==================
*/
export type syncState_t = "connecting" | "syncing" | "synced" | "offline" | "retrying" | "paused";

export function Com_SyncState( p: syncProgress_t | undefined ): syncState_t {
	if ( !p ) {
		return "connecting";
	}
	if ( p.attempting ) {
		return p.error ? "retrying" : "connecting";
	}
	if ( p.error ) {
		return "offline";
	}
	if ( p.paused ) {
		return "paused";
	}
	return p.complete ? "synced" : "syncing";
}

/*
==================
Com_Split

A balance summed the way people think of it: private, public, pending
==================
*/
export type split_t = { private: number; public: number; pending: number; total: number; checking: number };

export function Com_Split( b: balance_t ): split_t {
	const priv = b.ironwood.confirmed + b.sapling.confirmed + b.orchard.confirmed;
	const pend = b.ironwood.pending + b.sapling.pending + b.orchard.pending + b.transparent.pending;

	// the total is the engine's (W_AccountBalance), the same number the balance shows: a sum
	// redone here would drift from it the day a pool is added. Checking: private money
	// Send can't use yet (the engine's spendable), so the card never promises more than Send
	const checking = b.spendable === null ? 0 : Math.max( 0, priv - b.spendable );
	return { private: priv, public: b.transparent.confirmed, pending: pend, total: b.total, checking: checking };
}

/*
==================
Com_PrivacyNote

What the privacy card says about an account, first that applies: money in
public view (it can be shielded), public money still arriving (shielded
once it's here), nothing yet, money in a retiring pool the wallet may move,
or all private. Sapling is private: never a reason to speak up
==================
*/
export type privacyNote_t =
	| { kind: "public"; zats: number }
	| { kind: "arriving"; zats: number }
	| { kind: "empty" }
	| { kind: "retiring"; zats: number }
	| { kind: "private" };

export function Com_PrivacyNote( b: balance_t, canMove: boolean ): privacyNote_t {
	const split = Com_Split( b );
	if ( split.public > 0 ) {
		return { kind: "public", zats: split.public };
	}
	if ( b.transparent.pending > 0 ) {
		return { kind: "arriving", zats: b.transparent.pending };
	}
	if ( split.total === 0 ) {
		return { kind: "empty" };
	}
	if ( b.orchard.confirmed > 0 && canMove ) {
		return { kind: "retiring", zats: b.orchard.confirmed };
	}
	return { kind: "private" };
}

/*
==================
Com_AllWallets

Every open wallet's total (the engine's, per account, summed), and the
sum of the ones that hold money. A view-only wallet only watches: its
money is counted apart, never as the person's own.
==================
*/
export type allWallets_t = { own: number; watched: number; rows: { id: string; name: string; zats: number; viewOnly: boolean }[] };

export function Com_AllWallets( wallets: Record< string, walletSummary_t >, order: string[] ): allWallets_t {
	const rows = order.map( ( id ) => wallets[id] ).filter( ( w ): w is walletSummary_t => !!w ).map( ( w ) => ( {
		id:			w.id,
		name:		w.name,
		zats:		w.accounts.reduce( ( sum, a ) => sum + a.balance.total, 0 ),
		viewOnly:	w.kind === "viewOnly",
	} ) );
	const sum = ( list: typeof rows ) => list.reduce( ( s, r ) => s + r.zats, 0 );
	return { own: sum( rows.filter( ( r ) => !r.viewOnly ) ), watched: sum( rows.filter( ( r ) => r.viewOnly ) ), rows: rows };
}

/*
==================
Com_PaymentKey

One piece of payment news: a payment between two of the person's
accounts is two (sent from one, received in the other), so the id alone
is not enough
==================
*/
export function Com_PaymentKey( p: paymentEvent_t ): string {
	return `${p.walletId}:${p.account}:${p.txid}`;
}

// one piece of news in the corner: a payment (w_notice.rs), or a price alert that went off (w_alert.rs)
export type news_t =
	| { kind: "payment"; payment: paymentEvent_t }
	| { kind: "price"; alert: priceAlertEvent_t };

export function Com_NewsKey( n: news_t ): string {
	switch ( n.kind ) {
	case "payment":	return Com_PaymentKey( n.payment );
	case "price":	return `price:${n.alert.id}`;
	}
}

/*
==================
Com_Unreachable

The last line of an exhaustive switch. If a new case is added to a union
and some switch doesn't handle it, the call no longer type-checks: the
compiler finds every place that forgot, instead of a user finding one.
==================
*/
export function Com_Unreachable( value: never ): never {
	throw new Error( `unhandled case: ${JSON.stringify( value )}` );
}
