/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_price.test.tsx -- nothing is asked of the price source before a yes;
// the pointer lands on the nearest price; the change is from the range's start

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { appSettings_t } from "./bindings";

const engine = vi.hoisted( () => ( {
	settings:	null as appSettings_t | null,		// set from Test_Settings before each test
	asked:		[] as string[],
	testnet:	false,								// the engine's answer for test coins: no price
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		sGetF: async () => engine.settings,
		sSetF: async ( s: appSettings_t ) => {
			engine.settings = s;
			return s;
		},
		wValueHistoryF: async ( _id: string, _account: number, range: string ) => {
			engine.asked.push( `value ${range}` );
			return engine.testnet
				? { kind: "noPrice" }
				: { kind: "series", series: { range: range, fetchedAt: Math.floor( Date.now() / 1000 ), points: [ { time: 1000, usd: 100 }, { time: 2000, usd: 150 } ] } };
		},
		pSeriesF: async ( range: string ) => {
			engine.asked.push( range );
			return { range: range, fetchedAt: Math.floor( Date.now() / 1000 ), points: [ { time: 1000, usd: 20 }, { time: 2000, usd: 25 } ] };
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( async () => {
	engine.settings = ( await import( "./test_engine" ) ).Test_Settings();
	engine.asked = [];
	engine.testnet = false;
} );

afterEach( cleanup );

describe( "UI_PriceView", () => {
	it( "asks nothing of the price source until the person says yes", async () => {
		const { UI_PriceView } = await import( "./ui_price" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		const { QUERY } = await import( "./ui_query" );		// the app's own cache, which the settings save into
		QUERY.clear();
		render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_PriceView of={{ kind: "price" }} range="1d" width={400} height={200} /></UI_TipProvider></QueryClientProvider> );

		fireEvent.click( await screen.findByRole( "button", { name: T.price.show } ) );
		expect( engine.asked ).toEqual( [] );		// the yes was the only thing sent so far

		await screen.findByText( "+25.00%" );		// 20 to 25 over the range
		expect( engine.settings?.showPrice ).toBe( true );
		expect( engine.asked ).toEqual( [ "1d" ] );
	} );
} );

describe( "price arithmetic", () => {
	it( "lands on the nearest point, and measures change from the first", async () => {
		const { Com_Nearest, Com_Change } = await import( "./ui_price" );
		const points = [ { time: 0, usd: 10 }, { time: 100, usd: 12 }, { time: 200, usd: 9 } ];
		expect( Com_Nearest( points, 40 ).time ).toBe( 0 );
		expect( Com_Nearest( points, 60 ).time ).toBe( 100 );
		expect( Com_Nearest( points, 1e9 ).time ).toBe( 200 );
		expect( Com_Nearest( points, -5 ).time ).toBe( 0 );
		expect( Com_Change( 10, 9 ) ).toBeCloseTo( -10 );
		expect( Com_Change( 0, 9 ) ).toBe( 0 );		// no start price: no made-up change
	} );
} );

describe( "the account's value", () => {
	async function OpenValue( hidden: boolean ) {
		const { UI_PriceView } = await import( "./ui_price" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		const { QUERY } = await import( "./ui_query" );
		const { useStore } = await import( "./ui_store" );
		QUERY.clear();
		engine.settings = ( await import( "./test_engine" ) ).Test_Settings( { showPrice: true } );
		useStore.setState( { hideAmounts: hidden } );
		render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_PriceView of={{ kind: "value", walletId: "w", account: 0 }} range="1m" width={400} height={200} /></UI_TipProvider></QueryClientProvider> );
	}

	it( "shows what the account was worth, and says it moves with money in and out", async () => {
		await OpenValue( false );
		await screen.findByText( "+50.00%" );
		expect( screen.getByText( T.price.valueNote ) ).toBeTruthy();
		expect( engine.asked ).toEqual( [ "value 1m" ] );
	} );

	// a value is the balance in dollars: hidden amounts hide it too
	it( "shows nothing of it while amounts are hidden", async () => {
		await OpenValue( true );
		await screen.findByText( T.chart.hidden );
		expect( screen.queryByText( "+50.00%" ) ).toBeNull();
	} );

	// test coins have no price: a fact said as one, not "Couldn't Work Out the Value"
	it( "says test coins have no price, as a fact and not a failure", async () => {
		engine.testnet = true;
		await OpenValue( false );
		expect( await screen.findByText( T.price.noPriceTitle ) ).toBeTruthy();
		expect( screen.queryByText( T.price.valueFailed ) ).toBeNull();
		expect( screen.queryByRole( "alert" ) ).toBeNull();
	} );
} );
