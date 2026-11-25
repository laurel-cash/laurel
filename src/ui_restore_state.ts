/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_restore_state.ts -- what the restore screen holds and its rules:
// each change to it (Restore_Reduce), what each way in still needs before
// going on (Com_SecretGap, Com_WhenGap) and how it restores (METHODS).
// No drawing here: ui_restore.tsx shows it.

import { commands, network_t, phraseCheck_t, zcashdCheck_t } from "./ui_local";
import { T } from "./ui_text";

export type method_t	= "phrase" | "viewkey" | "zcashd";
export type when_t		= "date" | "block" | "unknown";

export const DEFAULT_LENGTH	= 24;


/*
=========================================================================

RESTORE STATE

=========================================================================
*/

export type step_t = "secret" | "when";

// what the screen holds: what was typed for each way in, and which step
// it's on. Each change is typed by the user, so it takes back the nudge
// that answered the last click (Restore_Reduce)
export type restore_t = {
	method:			method_t;
	step:			step_t;
	name:			string;
	words:			string[];
	pasteNote:		string | null;		// a paste that wasn't a phrase's length (Restore_Paste)
	hasPass:		boolean;
	passphrase:		string;
	passMissing:	boolean;			// Next was clicked with it on and empty
	accounts:		number;
	viewKey:		string;
	zcashd:			string;
	when:			when_t;
	month:			number;
	year:			number;
	block:			string;
	nudge:			string | null;		// what a click found still needed
	focusWord:		{ index: number; serial: number };		// the grid's box to focus
};

export type restoreAction_t =
	| { type: "method";		method: method_t }
	| { type: "name";		name: string }
	| { type: "words";		words: string[] }
	| { type: "length";		n: number }
	| { type: "paste";		pasted: string[]; lengths: number[] }
	| { type: "passOn";		on: boolean }
	| { type: "passphrase";	passphrase: string }
	| { type: "accounts";	accounts: number }
	| { type: "viewKey";	viewKey: string }
	| { type: "zcashd";		zcashd: string }
	| { type: "when";		when: when_t }
	| { type: "month";		month: number }
	| { type: "year";		year: number }
	| { type: "block";		block: string }
	| { type: "step";		step: step_t }
	| { type: "gap";		gap: gap_t | null };

// what a click found still needed: the words that say so (none when the
// field says it itself), and where the cursor goes
export type gap_t = {
	nudge:	string | null;
	at:		"name" | "viewKey" | "zcashd" | "word" | "pass" | "block";
	word?:	number;		// at "word": the box, when there is one to point at
};

// what the screen reads, not types: the phrase and zcashd text, checked
export type seen_t = { check: phraseCheck_t | null; zcheck: zcashdCheck_t };

export function Restore_Start( method: method_t, name: string ): restore_t {
	const now = new Date();
	return {
		method, name,
		step:			"secret",
		words:			Array( DEFAULT_LENGTH ).fill( "" ),
		pasteNote:		null,
		hasPass:		false,
		passphrase:		"",
		passMissing:	false,
		accounts:		1,
		viewKey:		"",
		zcashd:			"",
		when:			"unknown",
		month:			now.getMonth(),
		year:			now.getFullYear(),
		block:			"",
		nudge:			null,
		focusWord:		{ index: 0, serial: 0 },
	};
}

/*
==================
Restore_Paste

A paste is never cut short in silence (W1-05): 24 words and a passphrase
written as the 25th, a common paper, restored the wallet without it,
empty. More words than any phrase has fill in none; a count no phrase
has fills the next length up, and says how many came.
==================
*/
function Restore_Paste( s: restore_t, pasted: string[], lengths: number[] ): restore_t {
	const most = Math.max( ...lengths );
	if ( pasted.length > most ) {
		return { ...s, pasteNote: T.restore.pastedTooMany( pasted.length, lengths ) };
	}
	const n = lengths.find( ( l ) => l >= pasted.length ) ?? most;
	return {
		...s,
		words:		Array.from( { length: n }, ( _, i ) => pasted[i] ?? "" ),
		pasteNote:	lengths.includes( pasted.length ) ? null : T.restore.pastedOdd( pasted.length, lengths ),
	};
}

export function Restore_Reduce( s: restore_t, a: restoreAction_t ): restore_t {
	if ( a.type === "gap" ) {
		if ( !a.gap ) {
			return { ...s, nudge: null };
		}
		const word = a.gap.word;
		return {
			...s,
			nudge:			a.gap.nudge,
			passMissing:	a.gap.at === "pass",
			focusWord:		word === undefined ? s.focusWord : { index: word, serial: s.focusWord.serial + 1 },
		};
	}
	const t = { ...s, nudge: null };
	switch ( a.type ) {
	case "method":		return { ...t, method: a.method };
	case "name":		return { ...t, name: a.name };
	case "words":		return { ...t, words: a.words, pasteNote: null };
	case "length":		return { ...t, words: Array.from( { length: a.n }, ( _, i ) => s.words[i] ?? "" ), pasteNote: null };
	case "paste":		return Restore_Paste( t, a.pasted, a.lengths );
	case "passOn":		return { ...t, hasPass: a.on, passMissing: false };
	case "passphrase":	return { ...t, passphrase: a.passphrase, passMissing: false };
	case "accounts":	return { ...t, accounts: a.accounts };
	case "viewKey":		return { ...t, viewKey: a.viewKey };
	case "zcashd":		return { ...t, zcashd: a.zcashd };
	case "when":		return { ...t, when: a.when };
	case "month":		return { ...t, month: a.month };
	case "year":		return { ...t, year: a.year };
	case "block":		return { ...t, block: a.block };
	case "step":		return { ...t, step: a.step };
	}
}


/*
=========================================================================

EACH WAY IN

=========================================================================
*/

/*
==================
Com_PhraseGap / Com_WhenGap

What the phrase still needs before the next step: a word in every box,
a phrase that checks, and the passphrase when it was asked for. Then the
block, when the wallet's start is given as one.
==================
*/
function Com_PhraseGap( s: restore_t, check: phraseCheck_t | null ): gap_t | null {
	const empty = s.words.findIndex( ( w ) => !w );
	if ( empty >= 0 ) {
		return { nudge: T.restore.missingWords( s.words.filter( ( w ) => !w ).length ), at: "word", word: empty };
	}
	if ( check && !check.valid ) {
		return { nudge: check.problem, at: "word", word: check.unknown[0] };
	}
	if ( s.hasPass && !s.passphrase ) {
		return { nudge: null, at: "pass" };		// said under the field, where the cursor goes
	}
	return null;
}

export function Com_WhenGap( s: restore_t ): gap_t | null {
	return s.when === "block" && !s.block ? { nudge: T.restore.missingBlock, at: "block" } : null;
}

// each way in, named once: its words, what it needs, and how it restores.
// A new method is an entry here and its fields below
export const METHODS: Record< method_t, {
	title:		string;
	action:		string;
	label:		string;
	gap:		( s: restore_t, seen: seen_t ) => gap_t | null;
	restore:	( net: network_t, name: string, s: restore_t, birthday: number ) => Promise< string >;
} > = {
	phrase: {
		title: T.restore.title, action: T.restore.action, label: T.restore.methodPhrase,
		gap:		( s, seen ) => Com_PhraseGap( s, seen.check ),
		restore:	( net, name, s, birthday ) => commands.wRestoreF( net, name, s.words.join( " " ), s.hasPass ? s.passphrase : "", birthday, s.accounts ),
	},
	viewkey: {
		title: T.restore.viewOnlyTitle, action: T.restore.actionViewKey, label: T.restore.methodViewKey,
		gap:		( s ) => s.viewKey.trim() ? null : { nudge: T.restore.missingViewKey, at: "viewKey" },
		restore:	( net, name, s, birthday ) => commands.wRestoreViewKeyF( net, name, s.viewKey, birthday ),
	},
	zcashd: {
		title: T.restore.zcashdTitle, action: T.restore.actionZcashd, label: T.restore.methodZcashd,
		gap:		( _, seen ) => seen.zcheck.kind === "ok" ? null : { nudge: seen.zcheck.kind === "bad" ? seen.zcheck.problem : T.restore.missingZcashd, at: "zcashd" },
		restore:	( net, name, s, birthday ) => commands.wImportZcashdKeysF( net, name, s.zcashd, birthday ),
	},
};

// what Next finds still needed: a name, then what the way in needs
export function Com_SecretGap( s: restore_t, seen: seen_t ): gap_t | null {
	if ( !s.name.trim() ) {
		return { nudge: T.restore.missingName, at: "name" };
	}
	return METHODS[s.method].gap( s, seen );
}

/*
==================
Com_PhraseLine

The line under the words. Unknown words show at once; other problems
wait until every box has a word. A nudge answers a click, so it wins the
line: "✓ Valid" must never hide why the button just moved the cursor
instead of going on.
==================
*/
export function Com_PhraseLine( words: string[], check: phraseCheck_t | null, nudge: string | null ): { text: string; tone: string } {
	const filled = words.filter( Boolean ).length;
	if ( nudge ) {
		return { text: nudge, tone: " bad" };
	}
	if ( filled === words.length && check?.valid ) {
		return { text: T.restore.valid, tone: " ok" };
	}
	const problem = check && ( check.unknown.length || filled === words.length ) ? check.problem : "";
	return { text: problem || T.restore.wordsOf( filled, words.length ), tone: problem ? " bad" : "" };
}
