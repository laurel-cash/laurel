/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_history.test.ts -- which lines a filter shows, and how days are named

import { describe, expect, it } from "vitest";

import { Com_DayLabel, Com_GroupByDay, Com_Matches, Com_SecsBetween, Com_TxStateView, NO_QUERY } from "./ui_history";
import type { historyQuery_t, period_t } from "./ui_history";
import { Com_FormatDate } from "./ui_local";
import { T } from "./ui_text";
import type { blockEra_t, historyItem_t } from "./bindings";
import { Test_Item } from "./test_engine";

const NOW = Date.UTC( 2026, 8, 26, 15, 0, 0 ) / 1000;
const DAY = 86400;

const Item = ( patch: Partial< historyItem_t > ): historyItem_t => Test_Item( { time: NOW, ...patch } );

describe( "Com_Matches", () => {
	const received	= Item( { kind: "received", memo: "Lunch money" } );
	const sent		= Item( { kind: "sent", from: [ "sapling" ], into: [], counterparty: "utest1abcxyz" } );
	const shield	= Item( { kind: "shield", from: [ "transparent" ] } );
	const move		= Item( { kind: "move", from: [ "orchard" ] } );
	const Q = ( patch: Partial< historyQuery_t > ): historyQuery_t => ( { ...NO_QUERY, ...patch } );
	const Is = ( item: historyItem_t, patch: Partial< historyQuery_t > ) => Com_Matches( item, Q( patch ), NOW );

	it( "filters by what happened; moves include shielding", () => {
		expect( [ received, sent, shield, move ].filter( ( i ) => Is( i, { kind: "moves" } ) ) ).toEqual( [ shield, move ] );
		expect( [ received, sent, shield, move ].filter( ( i ) => Is( i, { kind: "sent" } ) ) ).toEqual( [ sent ] );
	} );

	it( "filters by a pool on either side", () => {
		expect( Is( sent, { pools: [ "sapling" ] } ) ).toBe( true );
		expect( Is( received, { pools: [ "sapling" ] } ) ).toBe( false );
		expect( Is( shield, { pools: [ "transparent" ] } ) ).toBe( true );
	} );

	it( "searches addresses, messages and amounts, ignoring case", () => {
		expect( Is( received, { text: "lunch" } ) ).toBe( true );
		expect( Is( sent, { text: "ABCXYZ" } ) ).toBe( true );
		expect( Is( received, { text: "1.5" } ) ).toBe( true );
		expect( Is( received, { text: "dinner" } ) ).toBe( false );
	} );

	it( "filters by the state the engine gave, never guessed", () => {
		const waiting	= Item( { kind: "sent", state: { kind: "pending", expiresAt: 140 } } );
		const unsent	= Item( { kind: "sent", state: { kind: "unsent" } } );
		const failed	= Item( { kind: "sent", state: { kind: "failed" } } );
		const all		= [ received, waiting, unsent, failed ];
		expect( all.filter( ( i ) => Is( i, { status: "waiting" } ) ) ).toEqual( [ waiting, unsent ] );
		expect( all.filter( ( i ) => Is( i, { status: "failed" } ) ) ).toEqual( [ failed ] );
	} );

	it( "filters by the category the person gave, and finds it by name", () => {
		const rent = Item( { kind: "sent", category: "housing" } );
		const lunch = Item( { kind: "sent", category: "food" } );
		expect( [ rent, lunch, received ].filter( ( i ) => Is( i, { category: "housing" } ) ) ).toEqual( [ rent ] );
		expect( Is( lunch, { text: T.history.categories.food.slice( 0, 4 ) } ) ).toBe( true );
	} );

	it( "filters by period, by the local calendar", () => {
		const local = ( y: number, m: number, d: number ) => new Date( y, m, d, 12 ).getTime() / 1000;
		const now = local( 2026, 8, 26 );
		const thisMonth	= Item( { time: local( 2026, 8, 2 ) } );
		const july		= Item( { time: local( 2026, 6, 15 ) } );
		const lastYear	= Item( { time: local( 2025, 11, 31 ) } );
		const all = [ thisMonth, july, lastYear ];
		const pick = ( period: period_t ) => all.filter( ( i ) => Com_Matches( i, Q( { period } ), now ) );
		expect( pick( "month" ) ).toEqual( [ thisMonth ] );
		expect( pick( "days30" ) ).toEqual( [ thisMonth ] );
		expect( pick( "year" ) ).toEqual( [ thisMonth, july ] );
		expect( pick( "lastYear" ) ).toEqual( [ lastYear ] );
		expect( pick( "any" ) ).toEqual( all );
	} );
} );

describe( "Com_GroupByDay", () => {
	it( "names today and yesterday, dates before that", () => {
		expect( Com_DayLabel( NOW - 60, NOW ) ).toBe( T.history.today );
		expect( Com_DayLabel( NOW - DAY, NOW ) ).toBe( T.history.yesterday );
		expect( Com_DayLabel( NOW - 5 * DAY, NOW ) ).not.toMatch( /Today|Yesterday/ );
	} );

	it( "keeps what waits on the network on top in its own group; a failed one keeps its day", () => {
		const g = Com_GroupByDay( [
			Item( { txid: "p", state: { kind: "pending", expiresAt: 140 } } ),
			Item( { txid: "u", state: { kind: "unsent" } } ),
			Item( { txid: "a", time: NOW } ),
			Item( { txid: "f", time: NOW - 50, state: { kind: "failed" } } ),
			Item( { txid: "c", time: NOW - DAY } ),
		], NOW );
		expect( g.map( ( x ) => [ x.label, x.items.map( ( i ) => i.txid ) ] ) ).toEqual( [
			[ T.history.pending, [ "p", "u" ] ],
			[ T.history.today, [ "a", "f" ] ],
			[ T.history.yesterday, [ "c" ] ],
		] );
	} );
} );

// testnet's eras, as W_BlockEras gives them: genesis, Blossom, NU7
const NU7 = 4_465_026;
const ERAS: blockEra_t[] = [
	{ network: "testnet", from: 0, secs: 150 },
	{ network: "testnet", from: 584_000, secs: 75 },
	{ network: "testnet", from: NU7, secs: 25 },
];

describe( "Com_SecsBetween", () => {
	it( "counts 25 s a block since NU7: a 120-block expiry is 50 minutes", () => {
		expect( Com_SecsBetween( ERAS, NU7 + 1000, NU7 + 1120 ) ).toBe( 120 * 25 );
	} );

	it( "counts 75 s a block before NU7", () => {
		expect( Com_SecsBetween( ERAS, NU7 - 200, NU7 - 160 ) ).toBe( 40 * 75 );
	} );

	it( "splits a span across NU7: each block takes its own era's spacing", () => {
		// (NU7 - 10, NU7 + 10]: 9 blocks before NU7, then NU7 itself and 10 after
		expect( Com_SecsBetween( ERAS, NU7 - 10, NU7 + 10 ) ).toBe( 9 * 75 + 11 * 25 );
		expect( Com_SecsBetween( ERAS, 583_990, 584_010 ) ).toBe( 9 * 150 + 11 * 75 );
	} );

	it( "is nothing for an empty span or no eras", () => {
		expect( Com_SecsBetween( ERAS, NU7 + 5, NU7 + 5 ) ).toBe( 0 );
		expect( Com_SecsBetween( ERAS, NU7 + 5, NU7 ) ).toBe( 0 );
		expect( Com_SecsBetween( [], 0, 100 ) ).toBe( 0 );
	} );
} );

describe( "Com_TxStateView", () => {
	it( "gives a pending payment's expiry as a time, and says not to send it again", () => {
		const v = Com_TxStateView( { kind: "pending", expiresAt: NU7 + 140 }, NU7 + 100, ERAS, NOW );
		expect( v.waiting ).toBe( true );
		expect( v.line( "" ) ).toContain( T.history.expiresBy( Com_FormatDate( NOW + 40 * 25, "time" ) ) );
	} );

	it( "gives a pre-NU7 expiry at 75 s a block", () => {
		const w = Com_TxStateView( { kind: "pending", expiresAt: NU7 - 60 }, NU7 - 100, ERAS, NOW );
		expect( w.line( "" ) ).toContain( T.history.expiresBy( Com_FormatDate( NOW + 40 * 75, "time" ) ) );
	} );

	it( "says when a pending payment is already past its expiry", () => {
		expect( Com_TxStateView( { kind: "pending", expiresAt: 140 }, 141, ERAS, NOW ).line( "" ) ).toContain( T.history.expiresNow );
	} );

	it( "never passes a failed payment off as pending or paid", () => {
		const v = Com_TxStateView( { kind: "failed" }, 100, ERAS, NOW );
		expect( v.waiting ).toBe( false );
		expect( v.pill ).toBe( T.history.failed );
		expect( v.line( "" ) ).toBe( T.history.failedLong );
	} );

	// a pending or unsent one may still go out: sending it again would pay twice
	it( "offers sending again only for a payment that didn't go through", () => {
		expect( Com_TxStateView( { kind: "failed" }, 100, ERAS, NOW ).again ).toBe( true );
		expect( Com_TxStateView( { kind: "pending", expiresAt: 140 }, 100, ERAS, NOW ).again ).toBe( false );
		expect( Com_TxStateView( { kind: "unsent" }, 100, ERAS, NOW ).again ).toBe( false );
		expect( Com_TxStateView( { kind: "confirmed", height: 90 }, 100, ERAS, NOW ).again ).toBe( false );
	} );
} );
