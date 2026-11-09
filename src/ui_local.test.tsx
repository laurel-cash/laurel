/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_local.test.tsx -- the readings the dashboard is built on: sync
// state, the private / public / pending split, and hidden amounts

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Com_Abbrev, Com_AllWallets, Com_DateTicks, Com_ErrorOf, Com_FormatZec, Com_LookAlike, Com_MemoAsksForSecrets, Com_ParseZec, Com_PrivacyNote, Com_Split, Com_SyncState } from "./ui_local";
import type { balance_t, syncProgress_t, walletSummary_t } from "./bindings";
import { useStore } from "./ui_store";
import { Test_Balance, Test_Summary } from "./test_engine";
import { UI_Alert, UI_Amount, UI_TipProvider } from "./ui_widgets";

const PROGRESS: syncProgress_t = { running: true, complete: false, percent: 40, walletHeight: 10, chainHeight: 25, error: null, attempting: false, nextRetryAt: null, paused: false, etaSecs: null, birthdayTime: null, repairing: false };

const ZATS = 100_000_000;		// one ZEC

const HELD = {
	ironwood:		{ confirmed: 2 * ZATS },
	sapling:		{ confirmed: ZATS,		pending: ZATS / 2 },
	transparent:	{ confirmed: ZATS,		pending: ZATS / 4 },
};
const BALANCE: balance_t = Test_Balance( HELD );

afterEach( cleanup );

describe( "Com_SyncState", () => {
	it( "is connecting before the engine has said anything", () => {
		expect( Com_SyncState( undefined ) ).toBe( "connecting" );
	} );

	it( "is offline whenever the engine reports an error, even mid-sync", () => {
		expect( Com_SyncState( { ...PROGRESS, error: { message: "unreachable", detail: null, retry: false } } ) ).toBe( "offline" );
		expect( Com_SyncState( { ...PROGRESS, complete: true, error: { message: "unreachable", detail: null, retry: false } } ) ).toBe( "offline" );
	} );

	it( "is retrying while an attempt runs after a failure, connecting on the first", () => {
		expect( Com_SyncState( { ...PROGRESS, error: { message: "unreachable", detail: null, retry: false }, attempting: true } ) ).toBe( "retrying" );
		expect( Com_SyncState( { ...PROGRESS, attempting: true } ) ).toBe( "connecting" );
		expect( Com_SyncState( { ...PROGRESS, error: { message: "unreachable", detail: null, retry: false }, nextRetryAt: 1 } ) ).toBe( "offline" );
	} );

	it( "is paused when the person paused it, unless the network is the problem", () => {
		expect( Com_SyncState( { ...PROGRESS, paused: true } ) ).toBe( "paused" );
		expect( Com_SyncState( { ...PROGRESS, paused: true, error: { message: "unreachable", detail: null, retry: false } } ) ).toBe( "offline" );
	} );

	it( "is synced only when the engine says complete", () => {
		expect( Com_SyncState( PROGRESS ) ).toBe( "syncing" );
		expect( Com_SyncState( { ...PROGRESS, percent: 100 } ) ).toBe( "syncing" );
		expect( Com_SyncState( { ...PROGRESS, complete: true } ) ).toBe( "synced" );
	} );
} );

describe( "Com_PrivacyNote", () => {
	const B = ( p: Parameters< typeof Test_Balance >[0] ) => Test_Balance( p );

	// public first, arriving public too, then nothing yet, then Orchard (only where it may move);
	// Sapling is private and never a reason to speak up
	it( "says the first thing that matters, and never nags about Sapling", () => {
		expect( Com_PrivacyNote( B( { ironwood: { confirmed: 5 }, transparent: { confirmed: 2 } } ), true ) ).toEqual( { kind: "public", zats: 2 } );
		expect( Com_PrivacyNote( B( { ironwood: { confirmed: 5 }, transparent: { pending: 3 } } ), true ) ).toEqual( { kind: "arriving", zats: 3 } );
		expect( Com_PrivacyNote( B( {} ), true ) ).toEqual( { kind: "empty" } );
		expect( Com_PrivacyNote( B( { ironwood: { confirmed: 5 }, orchard: { confirmed: 4 } } ), true ) ).toEqual( { kind: "retiring", zats: 4 } );
		expect( Com_PrivacyNote( B( { ironwood: { confirmed: 5 }, orchard: { confirmed: 4 } } ), false ) ).toEqual( { kind: "private" } );
		expect( Com_PrivacyNote( B( { sapling: { confirmed: 9 } } ), true ) ).toEqual( { kind: "private" } );
	} );
} );

describe( "Com_Split", () => {
	it( "counts every shielded pool as private and keeps pending apart", () => {
		expect( Com_Split( BALANCE ) ).toEqual( {
			private:	3 * ZATS,
			public:		ZATS,
			pending:	ZATS / 2 + ZATS / 4,
			total:		4 * ZATS + ZATS * 3 / 4,
			checking:	0,
		} );
	} );

	// the balance never promises Send more than it can use: what the engine is still checking is said apart
	it( "says how much of the private money is still being checked, and nothing for a viewing key", () => {
		expect( Com_Split( Test_Balance( HELD, 2 * ZATS ) ).checking ).toBe( ZATS );
		expect( Com_Split( Test_Balance( HELD, null ) ).checking ).toBe( 0 );
		expect( Com_Split( Test_Balance( HELD, 5 * ZATS ) ).checking ).toBe( 0 );		// never below zero
	} );
} );

describe( "UI_Amount", () => {
	it( "shows dots, never digits, while amounts are hidden", () => {
		useStore.setState( { hideAmounts: true } );
		const { container } = render( <UI_Amount zats={123_456_789} unit /> );
		expect( container.textContent ).toContain( "••••" );
		expect( container.textContent ).not.toMatch( /\d/ );
	} );

	it( "shows the amount otherwise", () => {
		useStore.setState( { hideAmounts: false } );
		const { container } = render( <UI_Amount zats={123_456_789} /> );
		expect( container.textContent ).toMatch( /1\.23/ );
	} );
} );

describe( "Com_ParseZec", () => {
	const ok = ( zats: number ) => ( { kind: "ok", zats: zats } );
	const BAD = { kind: "bad" };

	it( "reads amounts exactly, without float rounding", () => {
		expect( Com_ParseZec( "0.1" ) ).toEqual( ok( 10_000_000 ) );
		expect( Com_ParseZec( "1.23456789" ) ).toEqual( ok( 123_456_789 ) );
		expect( Com_ParseZec( "21000000" ) ).toEqual( ok( 2_100_000_000_000_000 ) );
		expect( Com_ParseZec( ".5" ) ).toEqual( ok( 50_000_000 ) );
		expect( Com_ParseZec( "2." ) ).toEqual( ok( 200_000_000 ) );
		expect( Com_ParseZec( " 0,25 " ) ).toEqual( ok( 25_000_000 ) );
	} );

	it( "reads the digits whichever keyboard typed them", () => {
		expect( Com_ParseZec( "١٫٥" ) ).toEqual( ok( 150_000_000 ) );		// Arabic: 1.5
		expect( Com_ParseZec( "۲" ) ).toEqual( ok( 200_000_000 ) );			// Persian: 2
		expect( Com_ParseZec( "０．２５" ) ).toEqual( ok( 25_000_000 ) );		// fullwidth: 0.25
	} );

	it( "refuses what isn't a plain amount", () => {
		for ( const bad of [ "", ".", "1.123456789", "-1", "1e5", "abc", "1.2.3", "0x10" ] ) {
			expect( Com_ParseZec( bad ), bad ).toEqual( BAD );
		}
	} );

	it( "reads a decimal comma, but never guesses a comma that could group thousands", () => {
		expect( Com_ParseZec( "1,5" ) ).toEqual( ok( 150_000_000 ) );
		expect( Com_ParseZec( "0,250" ) ).toEqual( ok( 25_000_000 ) );
		expect( Com_ParseZec( "1,50" ) ).toEqual( ok( 150_000_000 ) );
		// one thousand, or one? both readings go back to the person, neither is taken
		expect( Com_ParseZec( "1,000" ) ).toEqual( { kind: "ambiguous", thousands: "1000", decimal: "1.000" } );
		expect( Com_ParseZec( " 12,500 " ) ).toEqual( { kind: "ambiguous", thousands: "12500", decimal: "12.500" } );
		for ( const grouped of [ "1,000.5", "1.000,5", "1,2,3" ] ) {
			expect( Com_ParseZec( grouped ), grouped ).toEqual( BAD );
		}
	} );
} );

describe( "Com_DateTicks", () => {
	it( "writes as many dates as fit, from both ends", () => {
		expect( Com_DateTicks( 0, 300, 400, false ) ).toEqual( [ 0, 100, 200, 300 ] );
		expect( Com_DateTicks( 0, 300, 160, false ) ).toEqual( [ 0, 300 ] );		// a small phone at 175%
		expect( Com_DateTicks( 0, 300, 250, true ) ).toEqual( [ 0, 300 ] );		// with years, each needs more
	} );
} );

describe( "Com_FormatZec", () => {
	it( "is exact to the last zatoshi, however large the amount", () => {
		expect( Com_FormatZec( 0 ) ).toBe( "0.00" );
		expect( Com_FormatZec( 1 ) ).toBe( "0.00000001" );
		expect( Com_FormatZec( 150_000_000 ) ).toBe( "1.50" );
		expect( Com_FormatZec( 10_000 ) ).toBe( "0.0001" );
		// the whole supply less one zatoshi: a float division rounds this
		expect( Com_FormatZec( 2_099_999_999_999_999 ) ).toBe( "20999999.99999999" );
		expect( Com_FormatZec( 123_456_789_012_345 ) ).toBe( "1234567.89012345" );
	} );

	it( "reads back to the same zatoshis", () => {
		for ( const zats of [ 0, 1, 99, 100, 12_345_678, 100_000_000, 2_099_999_999_999_999 ] ) {
			expect( Com_ParseZec( Com_FormatZec( zats ) ), String( zats ) ).toEqual( { kind: "ok", zats: zats } );
		}
	} );
} );

describe( "Com_Abbrev", () => {
	it( "never shortens a public address: it's short enough to read whole", () => {
		const taddr = "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd";
		expect( Com_Abbrev( taddr ) ).toBe( taddr );
	} );

	it( "keeps both ends of a long one", () => {
		const txid = "a".repeat( 10 ) + "b".repeat( 44 ) + "c".repeat( 10 );
		expect( Com_Abbrev( txid ) ).toBe( "aaaaaaaaaa…cccccccccc" );
		expect( Com_Abbrev( txid, 4 ) ).toBe( "aaaa…cccc" );
	} );
} );

describe( "errors", () => {
	// word for word the shield failure of 2026-09-26, trimmed
	const RAW = 'Send error.: Transmission error.: failed to validate tx: WtxId("private"), transaction::Hash("a80c7d499c617a4fc4d2c0668007ab2d0")';

	it( "reads whatever was thrown as a message and, from the engine, its detail", () => {
		expect( Com_ErrorOf( { message: "Something went wrong inside Laurel's wallet engine.", detail: RAW, retry: false } ) ).toEqual( { message: "Something went wrong inside Laurel's wallet engine.", detail: RAW, retry: false } );
		expect( Com_ErrorOf( "plain" ) ).toEqual( { message: "plain", detail: null, retry: false } );
		expect( Com_ErrorOf( new Error( "js" ) ) ).toEqual( { message: "js", detail: null, retry: false } );
	} );

	it( "shows the words, and the engine's own text only when asked", () => {
		render( <UI_TipProvider><UI_Alert title="Couldn't Shield" message={{ message: "Something went wrong inside Laurel's wallet engine.", detail: RAW, retry: false }} /></UI_TipProvider> );
		expect( screen.getByText( "Something went wrong inside Laurel's wallet engine." ) ).toBeTruthy();
		expect( screen.queryByText( RAW ) ).toBeNull();

		fireEvent.click( screen.getByRole( "button", { name: "Details" } ) );
		expect( screen.getByText( RAW ) ).toBeTruthy();
		expect( screen.getByRole( "button", { name: "Copy Details" } ) ).toBeTruthy();
	} );
} );

describe( "Com_LookAlike", () => {
	const alice = { address: "utest1qqpxw4r9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7kd2", label: "Alice" };
	const known = [ alice, { address: "tmEPjALmEjr5djXhWfwcVfXgG92Ugri9R3n", label: "Bob" } ];

	it( "names the known address a different one imitates by its ends", () => {
		const poison = "utest1qqpxw4r9zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz7kd2";
		expect( Com_LookAlike( poison, known ) ).toEqual( alice );
		expect( Com_LookAlike( "tmEPjALmzzzzzzzzzzzzzzzzzzzzzzzri9R3n", known )?.label ).toBe( "Bob" );
	} );

	it( "stays quiet for the same address, and for one that only shares the fixed prefix", () => {
		expect( Com_LookAlike( alice.address, known ) ).toBeNull();
		expect( Com_LookAlike( "utest1abcdefghzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzwxyz", known ) ).toBeNull();
	} );
} );

describe( "Com_MemoAsksForSecrets", () => {
	it( "notices a memo that asks for a recovery phrase or keys", () => {
		expect( Com_MemoAsksForSecrets( "Support here: send your 24 words to restore access" ) ).toBe( true );
		expect( Com_MemoAsksForSecrets( "Verify your wallet: enter your seed phrase at zcash-help.example" ) ).toBe( true );
		expect( Com_MemoAsksForSecrets( "Your private key is needed to unlock the bonus" ) ).toBe( true );
	} );

	it( "leaves ordinary memos alone", () => {
		expect( Com_MemoAsksForSecrets( "Lunch money, thanks!" ) ).toBe( false );
		expect( Com_MemoAsksForSecrets( "Rent for October" ) ).toBe( false );
	} );
} );

describe( "Com_AllWallets", () => {
	const W = ( id: string, kind: walletSummary_t["kind"], totals: number[] ) =>
		Test_Summary( { id: id, name: id.toUpperCase(), kind: kind }, totals.map( ( t ) => ( { name: "a", balance: Test_Balance( { ironwood: { confirmed: t } } ) } ) ) );

	it( "adds every account of every wallet, and keeps what view-only wallets watch apart", () => {
		const wallets = { s: W( "s", "seed", [ 3 * ZATS, ZATS ] ), v: W( "v", "viewOnly", [ 10 * ZATS ] ), k: W( "k", "key", [ ZATS / 2 ] ) };
		const all = Com_AllWallets( wallets, [ "s", "v", "k", "gone" ] );		// an id with no wallet is skipped
		expect( all.own ).toBe( 4 * ZATS + ZATS / 2 );
		expect( all.watched ).toBe( 10 * ZATS );
		expect( all.rows.map( ( r ) => [ r.name, r.zats, r.viewOnly ] ) ).toEqual( [ [ "S", 4 * ZATS, false ], [ "V", 10 * ZATS, true ], [ "K", ZATS / 2, false ] ] );
	} );
} );
