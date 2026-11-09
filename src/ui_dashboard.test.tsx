/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_dashboard.test.tsx -- the dashboard's layout survives what was kept
// (a card taken away, a card added since, junk), moves stay in bounds, a
// due payment shows even with its card hidden, and the sheet keeps it all

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Com_HomeLayout, Com_MoveCard, Com_ShowCard, Com_ShownCards, HOME_DEFAULT, PREF_HOME } from "./ui_local";
import { T } from "./ui_text";

vi.mock( "./bindings", async () => ( {
	commands: {},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

describe( "the dashboard's layout", () => {
	it( "reads what was kept, whatever it is", () => {
		expect( Com_HomeLayout( null ) ).toEqual( HOME_DEFAULT );
		expect( Com_HomeLayout( "junk" ) ).toEqual( HOME_DEFAULT );
		const kept = Com_HomeLayout( { order: [ "pools", "gone", "pools", "repeats" ], hidden: [ "privacy", "gone" ], chart: false } );
		expect( kept.order ).toEqual( [ "pools", "repeats", "wallets", "network", "privacy" ] );		// taken away dropped, once each, added since last
		expect( kept.hidden ).toEqual( [ "privacy" ] );
		expect( kept.chart ).toBe( false );
	} );

	it( "moves a card one place, and not past either end", () => {
		const down = Com_MoveCard( HOME_DEFAULT, "repeats", 1 );
		expect( down.order.slice( 0, 2 ) ).toEqual( [ "wallets", "repeats" ] );
		expect( Com_MoveCard( HOME_DEFAULT, "repeats", -1 ) ).toBe( HOME_DEFAULT );
		expect( Com_MoveCard( HOME_DEFAULT, "privacy", 1 ) ).toBe( HOME_DEFAULT );
	} );

	it( "hides what the person hid, except a payment that is due", () => {
		const hidden = Com_ShowCard( HOME_DEFAULT, "repeats", false );
		expect( Com_ShownCards( hidden, [] ) ).not.toContain( "repeats" );
		expect( Com_ShownCards( hidden, [ "repeats" ] ) ).toContain( "repeats" );
		expect( Com_ShownCards( Com_ShowCard( hidden, "repeats", true ), [] ) ).toContain( "repeats" );
	} );
} );

describe( "UI_DashboardSheet", () => {
	beforeEach( async () => {
		localStorage.clear();
		const { useStore } = await import( "./ui_store" );
		useStore.setState( { home: HOME_DEFAULT } );
	} );
	afterEach( cleanup );

	it( "hides a card and moves one, and this computer keeps it", async () => {
		const { UI_DashboardSheet } = await import( "./ui_dashboard" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		const { useStore } = await import( "./ui_store" );
		render( <UI_TipProvider><UI_DashboardSheet open onOpenChange={() => {}} /></UI_TipProvider> );

		fireEvent.click( screen.getByRole( "switch", { name: T.dashboard.cards.pools } ) );
		fireEvent.click( screen.getByRole( "button", { name: T.dashboard.later( T.dashboard.cards.repeats ) } ) );

		expect( useStore.getState().home.hidden ).toEqual( [ "pools" ] );
		expect( useStore.getState().home.order[1] ).toBe( "repeats" );
		expect( Com_HomeLayout( JSON.parse( localStorage.getItem( PREF_HOME ) ?? "null" ) ) ).toEqual( useStore.getState().home );
		expect( ( screen.getByRole( "button", { name: T.dashboard.earlier( T.dashboard.cards.wallets ) } ) as HTMLButtonElement ).disabled ).toBe( true );		// first now
	} );
} );
