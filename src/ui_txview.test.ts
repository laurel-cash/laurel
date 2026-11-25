/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_txview.test.ts -- how deep a transaction is, how many wait, and what it was worth then

import { describe, expect, it } from "vitest";

import { Com_CanSendAgain, Com_Confirmations, Com_TxSign, Com_TxStateView, Com_WaitingCount } from "./ui_txview";
import { Com_NowPrice, Com_RangeFor, Com_UsdAt } from "./ui_price";
import { Test_Item } from "./test_engine";
import { T } from "./ui_text";

describe( "Com_Confirmations", () => {
	// its own block is the first; the count follows the chain up
	it( "counts from the transaction's own block", () => {
		expect( Com_Confirmations( { kind: "confirmed", height: 100 }, 100 ) ).toBe( 1 );
		expect( Com_Confirmations( { kind: "confirmed", height: 100 }, 113 ) ).toBe( 14 );
	} );

	// a tip not known yet, or one the sync hasn't caught up to: never zero or less
	it( "says nothing without a height, and never less than one", () => {
		expect( Com_Confirmations( { kind: "confirmed", height: 100 }, 0 ) ).toBeNull();
		expect( Com_Confirmations( { kind: "confirmed", height: 100 }, 90 ) ).toBe( 1 );
		expect( Com_Confirmations( { kind: "pending", expiresAt: 140 }, 120 ) ).toBeNull();
	} );
} );

describe( "Com_TxSign / Com_CanSendAgain", () => {
	const sent = Test_Item( { kind: "sent", counterparty: "tmtheirs" } );

	it( "signs what moved the balance, and nothing that didn't", () => {
		expect( Com_TxSign( Test_Item() ) ).toBe( "+" );
		expect( Com_TxSign( sent ) ).toBe( "−" );
		const failed = { ...sent, state: { kind: "failed" } } as const;
		expect( Com_TxSign( failed ) ).toBe( "" );
		const move = Test_Item( { kind: "move" } );
		expect( Com_TxSign( move ) ).toBe( "" );
	} );

	// a pending or unsent one may still go out: sending it again would pay twice
	it( "offers paying again only once a payment no longer waits, and only to someone", () => {
		expect( Com_CanSendAgain( sent ) ).toBe( true );
		for ( const state of [ { kind: "pending", expiresAt: 140 }, { kind: "unsent" } ] as const ) {
			expect( Com_CanSendAgain( { ...sent, state } ) ).toBe( false );
		}
		const failed = { ...sent, state: { kind: "failed" } } as const;
		expect( Com_CanSendAgain( failed ) ).toBe( true );
		const received = Test_Item();
		expect( Com_CanSendAgain( received ) ).toBe( false );
	} );
} );

describe( "Com_TxStateView, money coming in", () => {
	// nothing to send again or cancel: the sender's words were shown on money arriving
	it( "says what happens to the money arriving, not to a payment sent", () => {
		const waiting = Com_TxStateView( { kind: "pending", expiresAt: null }, 0, [], 0, true );
		expect( waiting.note ).toBe( T.history.arrivesNone );
		expect( Com_TxStateView( { kind: "pending", expiresAt: 140 }, 141, [], 0, true ).note ).toBe( T.history.arrivesNow );
		expect( Com_TxStateView( { kind: "pending", expiresAt: 140 }, 141, [], 0 ).note ).toBe( T.history.expiresNow );
	} );
} );

describe( "Com_WaitingCount", () => {
	it( "counts what still waits on the network, not what failed", () => {
		const items = [
			Test_Item( { txid: "a" } ),
			Test_Item( { txid: "b", state: { kind: "pending", expiresAt: null } } ),
			Test_Item( { txid: "c", state: { kind: "unsent" } } ),
			Test_Item( { txid: "d", state: { kind: "failed" } } ),
		];
		expect( Com_WaitingCount( items ) ).toBe( 2 );
		expect( Com_WaitingCount( [] ) ).toBe( 0 );
	} );
} );

describe( "Com_UsdAt", () => {
	const DAY = 86400;
	const points = [ { time: 0, usd: 30 }, { time: DAY, usd: 40 }, { time: 2 * DAY, usd: null } ];

	// the nearest priced point; a gap in the prices isn't a price
	it( "takes the price nearest the time", () => {
		expect( Com_UsdAt( points, DAY - 100 ) ).toBe( 40 );
		expect( Com_UsdAt( points, 2 * DAY ) ).toBe( 40 );
	} );

	// a price days away isn't that day's
	it( "says nothing when no price is near", () => {
		expect( Com_UsdAt( points, 10 * DAY ) ).toBeNull();
		expect( Com_UsdAt( [], 0 ) ).toBeNull();
	} );

	it( "asks the shortest range that reaches back", () => {
		expect( Com_RangeFor( 3600 ) ).toBe( "1d" );
		expect( Com_RangeFor( 3 * DAY ) ).toBe( "1w" );
		expect( Com_RangeFor( 20 * DAY ) ).toBe( "1m" );
		expect( Com_RangeFor( 200 * DAY ) ).toBe( "1y" );
		expect( Com_RangeFor( 900 * DAY ) ).toBe( "all" );
	} );
} );

// the balance in dollars on Home: today's price or none, never an old one as today's
describe( "Com_NowPrice", () => {
	it( "takes the newest price while it's under an hour old", () => {
		expect( Com_NowPrice( [ { time: 0, usd: 30 }, { time: 600, usd: 41 } ], 600 + 3600 ) ).toBe( 41 );
	} );

	it( "says nothing for a price over an hour old, a gap, or none", () => {
		expect( Com_NowPrice( [ { time: 600, usd: 41 } ], 600 + 3601 ), "a failed refresh keeps the last answer" ).toBeNull();
		expect( Com_NowPrice( [ { time: 0, usd: 41 }, { time: 600, usd: null as unknown as number } ], 700 ), "the newest isn't a price: the one before is" ).toBe( 41 );
		expect( Com_NowPrice( [], 0 ) ).toBeNull();
	} );
} );
