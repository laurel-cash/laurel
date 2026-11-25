/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_beta.test.tsx -- D-033: v1 tells a phone once that its beta's test
// wallets are kept and not opened, with OK alone, and never again

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { T } from "./ui_text";
import { UI_BetaWalletsSheet, useBetaWallets } from "./ui_notes";

const engine = vi.hoisted( () => ( { due: false, seen: 0 } ) );

vi.mock( "./bindings", async () => ( {
	commands: new Proxy( {
		sBetaWalletsDueF: async () => engine.due,
		sBetaWalletsSeenF: async () => {
			engine.seen++;
			return null;
		},
	} as Record< string, unknown >, { get: ( o, k: string ) => o[k] ?? ( async () => null ) } ),
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.due = false;
	engine.seen = 0;
} );

afterEach( cleanup );

function Screen( props: { known: boolean } ) {
	const beta = useBetaWallets( props.known );
	return <UI_BetaWalletsSheet open={beta.open} onOpenChange={beta.onOpenChange} />;
}

describe( "the beta's test wallets (D-033)", () => {
	it( "says they're kept, with OK alone, and remembers it was said", async () => {
		engine.due = true;
		render( <Screen known /> );
		const dialog = await screen.findByRole( "dialog", { name: T.betaWallets.title } );
		expect( dialog.textContent ).toContain( T.betaWallets.text );
		const buttons = screen.getAllByRole( "button" );
		expect( buttons.map( ( b ) => b.textContent ) ).toEqual( [ T.betaWallets.ok ] );
		await act( async () => fireEvent.click( buttons[0] ) );
		expect( engine.seen ).toBe( 1 );
		expect( screen.queryByRole( "dialog" ) ).toBeNull();
	} );

	it( "says nothing when the engine has nothing to tell, or before the screen knows", async () => {
		render( <Screen known /> );
		await act( async () => {} );
		expect( screen.queryByRole( "dialog" ) ).toBeNull();
		cleanup();

		engine.due = true;
		render( <Screen known={false} /> );
		await act( async () => {} );
		expect( screen.queryByRole( "dialog" ) ).toBeNull();
		expect( engine.seen ).toBe( 0 );
	} );

	it( "uses the words agreed for it", () => {
		expect( `${T.betaWallets.title} ${T.betaWallets.text}` ).toBe( "This version uses real ZEC. Your test wallets from the beta are kept on this device but not opened here. Test coins have no value." );
		expect( T.betaWallets.ok ).toBe( "OK" );
	} );
} );
