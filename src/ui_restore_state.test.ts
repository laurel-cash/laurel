/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_restore_state.test.ts -- the restore screen's rules, one way in at a
// time, with nothing drawn: what each still needs before going on, and
// that a change takes back the nudge that answered the last click.

import { describe, expect, it } from "vitest";

import { T } from "./ui_text";
import { Com_PhraseLine, Com_SecretGap, Com_WhenGap, Restore_Reduce, Restore_Start, restore_t } from "./ui_restore_state";

const NONE = { check: null, zcheck: { kind: "empty" as const } };
const VALID = { words: 24, valid: true, unknown: [], problem: "" };

function Typed( method: restore_t["method"], more: Partial< restore_t > = {} ): restore_t {
	return { ...Restore_Start( method, "Savings" ), ...more };
}

describe( "what each way in still needs", () => {
	it( "a name comes first, whichever way in", () => {
		for ( const m of [ "phrase", "viewkey", "zcashd" ] as const ) {
			expect( Com_SecretGap( Typed( m, { name: "  " } ), NONE ) ).toEqual( { nudge: T.restore.missingName, at: "name" } );
		}
	} );

	it( "a phrase: the first empty box, then a phrase that checks, then the passphrase asked for", () => {
		const words = Array( 24 ).fill( "abandon" );
		words[3] = "";
		words[9] = "";
		expect( Com_SecretGap( Typed( "phrase", { words } ), NONE ) ).toEqual( { nudge: T.restore.missingWords( 2 ), at: "word", word: 3 } );

		const full = Array( 24 ).fill( "abandon" );
		const bad = { check: { words: 24, valid: false, unknown: [ 5 ], problem: "not a word" }, zcheck: NONE.zcheck };
		expect( Com_SecretGap( Typed( "phrase", { words: full } ), bad ) ).toEqual( { nudge: "not a word", at: "word", word: 5 } );

		const seen = { check: VALID, zcheck: NONE.zcheck };
		expect( Com_SecretGap( Typed( "phrase", { words: full, hasPass: true } ), seen ) ).toEqual( { nudge: null, at: "pass" } );
		expect( Com_SecretGap( Typed( "phrase", { words: full, hasPass: true, passphrase: "x" } ), seen ) ).toBeNull();
	} );

	it( "a viewing key: one typed", () => {
		expect( Com_SecretGap( Typed( "viewkey" ), NONE ) ).toEqual( { nudge: T.restore.missingViewKey, at: "viewKey" } );
		expect( Com_SecretGap( Typed( "viewkey", { viewKey: "uview1abc" } ), NONE ) ).toBeNull();
	} );

	it( "zcashd keys: what was found wrong, or that none were pasted", () => {
		expect( Com_SecretGap( Typed( "zcashd" ), NONE ) ).toEqual( { nudge: T.restore.missingZcashd, at: "zcashd" } );
		const bad = { check: null, zcheck: { kind: "bad" as const, problem: "no keys in it" } };
		expect( Com_SecretGap( Typed( "zcashd" ), bad ) ).toEqual( { nudge: "no keys in it", at: "zcashd" } );
		const ok = { check: null, zcheck: { kind: "ok" as const, sapling: 1, sprout: 0, transparent: 0 } };
		expect( Com_SecretGap( Typed( "zcashd" ), ok ) ).toBeNull();
	} );

	it( "the start, given as a block, needs the block", () => {
		expect( Com_WhenGap( Typed( "phrase", { when: "block" } ) ) ).toEqual( { nudge: T.restore.missingBlock, at: "block" } );
		expect( Com_WhenGap( Typed( "phrase", { when: "block", block: "419200" } ) ) ).toBeNull();
		expect( Com_WhenGap( Typed( "phrase", { when: "unknown" } ) ) ).toBeNull();
	} );
} );

describe( "a change to what's typed", () => {
	it( "takes back the nudge, and a gap asks the grid for its box", () => {
		let s = Restore_Reduce( Typed( "phrase" ), { type: "gap", gap: { nudge: "say", at: "word", word: 4 } } );
		expect( s.nudge ).toBe( "say" );
		expect( s.focusWord ).toEqual( { index: 4, serial: 1 } );
		s = Restore_Reduce( s, { type: "name", name: "Other" } );
		expect( s.nudge ).toBeNull();
	} );

	it( "the passphrase asked for and missing is said until it's typed or turned off", () => {
		let s = Restore_Reduce( Typed( "phrase", { hasPass: true } ), { type: "gap", gap: { nudge: null, at: "pass" } } );
		expect( s.passMissing ).toBe( true );
		expect( Restore_Reduce( s, { type: "passphrase", passphrase: "p" } ).passMissing ).toBe( false );
		expect( Restore_Reduce( s, { type: "passOn", on: false } ).passMissing ).toBe( false );
	} );

	it( "a paste is never cut short in silence", () => {
		const lengths = [ 12, 24 ];
		const many = Restore_Reduce( Typed( "phrase" ), { type: "paste", pasted: Array( 25 ).fill( "abandon" ), lengths } );
		expect( many.words.every( ( w ) => !w ) ).toBe( true );
		expect( many.pasteNote ).toBe( T.restore.pastedTooMany( 25, lengths ) );

		const odd = Restore_Reduce( Typed( "phrase" ), { type: "paste", pasted: Array( 15 ).fill( "abandon" ), lengths } );
		expect( odd.words.length ).toBe( 24 );
		expect( odd.pasteNote ).toBe( T.restore.pastedOdd( 15, lengths ) );

		expect( Restore_Reduce( odd, { type: "length", n: 12 } ) ).toMatchObject( { pasteNote: null, words: Array( 12 ).fill( "abandon" ) } );
	} );

	it( "the line under the words: a nudge wins it over Valid", () => {
		const full = Array( 12 ).fill( "abandon" );
		expect( Com_PhraseLine( full, VALID, null ) ).toEqual( { text: T.restore.valid, tone: " ok" } );
		expect( Com_PhraseLine( full, VALID, "why" ) ).toEqual( { text: "why", tone: " bad" } );
		expect( Com_PhraseLine( [ "abandon", "" ], { words: 2, valid: false, unknown: [], problem: "bad checksum" }, null ) ).toEqual( { text: T.restore.wordsOf( 1, 2 ), tone: "" } );
	} );
} );
