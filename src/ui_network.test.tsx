/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_network.test.tsx -- moving to mainnet: asks first, won't move until
// "real money" is acknowledged (and says so, never a silent grey button),
// then switches and starts over

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { network_t } from "./bindings";
import { Test_Constants } from "./test_engine";

const engine = vi.hoisted( () => ( { switched: [] as string[] } ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		wSetNetworkF: async ( net: string ) => {
			engine.switched.push( net );
			return null;
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

const reload = vi.fn();

beforeEach( () => {
	engine.switched = [];
	reload.mockReset();
	Object.defineProperty( window, "location", { value: { ...window.location, reload: reload }, writable: true, configurable: true } );
} );

afterEach( cleanup );

async function Open( networks: network_t[] = [ "testnet", "mainnet" ] ) {
	const { UI_NetworkChoice } = await import( "./ui_server" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { useStore } = await import( "./ui_store" );
	useStore.setState( { network: "testnet", constants: Test_Constants( { networks: networks } ) } );
	const client = new QueryClient();
	render( <QueryClientProvider client={client}><UI_TipProvider><UI_NetworkChoice /></UI_TipProvider></QueryClientProvider> );
}

describe( "UI_NetworkChoice", () => {
	// the Play beta's build opens testnet alone: no choice offered, and it says why
	it( "says a build that opens testnet alone is for test coins, and offers no switch", async () => {
		await Open( [ "testnet" ] );
		expect( await screen.findByText( T.network.testOnly ) ).toBeTruthy();
		expect( screen.queryByRole( "tab", { name: "Mainnet" } ) ).toBeNull();
	} );

	it( "moves to mainnet only once real money is acknowledged, then starts over", async () => {
		await Open();
		fireEvent.click( screen.getByRole( "tab", { name: "Mainnet" } ) );
		await screen.findByText( T.network.toMainnet );

		const go = screen.getByRole( "button", { name: T.network.switchAction( "Mainnet" ) } );
		fireEvent.click( go );
		await screen.findByText( T.network.understandFirst );		// says why, doesn't move
		expect( engine.switched ).toEqual( [] );

		fireEvent.click( screen.getByLabelText( T.network.understand ) );
		fireEvent.click( go );
		await vi.waitFor( () => expect( reload ).toHaveBeenCalled() );
		expect( engine.switched ).toEqual( [ "mainnet" ] );
	} );

	it( "stays put when the person thinks again", async () => {
		await Open();
		fireEvent.click( screen.getByRole( "tab", { name: "Mainnet" } ) );
		fireEvent.click( await screen.findByRole( "button", { name: T.common.cancel } ) );
		expect( engine.switched ).toEqual( [] );
	} );
} );
