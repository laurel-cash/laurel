/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_developer.test.tsx -- Settings > Advanced: checking a wallet again from
// its birthday, and looking much further for public addresses only when
// the person ticks it

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";

const engine = vi.hoisted( () => ( {
	rescans:	[] as { id: string; further: boolean }[],
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		sGetF: async () => ( await import( "./test_engine" ) ).Test_Settings(),
		dInfoF: async () => ( { version: "0.2.0", network: "mainnet", server: null, ownServer: false } ),
		dReportF: async () => "report",
		syncRescanF: async ( id: string, further: boolean ) => {
			engine.rescans.push( { id, further } );
			return null;
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.rescans = [];
} );

afterEach( cleanup );

async function Open() {
	const { UI_DeveloperSection } = await import( "./ui_developer" );
	const { useStore } = await import( "./ui_store" );
	const { Test_Summary } = await import( "./test_engine" );
	useStore.setState( { wallets: { w1: Test_Summary( { id: "w1", name: "Daily" } ) }, order: [ "w1" ] } );
	const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
	render( <QueryClientProvider client={client}><UI_DeveloperSection /></QueryClientProvider> );
	fireEvent.click( await screen.findByRole( "button", { name: T.developer.recheckAsk } ) );
}

describe( "checking a wallet again", () => {
	it( "checks again as before when nothing is ticked", async () => {
		await Open();
		fireEvent.click( screen.getByRole( "button", { name: T.developer.recheck } ) );
		expect( await screen.findByText( T.developer.recheckStarted ) ).toBeTruthy();
		expect( engine.rescans ).toEqual( [ { id: "w1", further: false } ] );
	} );

	it( "looks further for public addresses only when ticked", async () => {
		await Open();
		fireEvent.click( screen.getByRole( "checkbox", { name: T.developer.lookFurther } ) );
		fireEvent.click( screen.getByRole( "button", { name: T.developer.recheck } ) );
		expect( await screen.findByText( T.developer.recheckStarted ) ).toBeTruthy();
		expect( engine.rescans ).toEqual( [ { id: "w1", further: true } ] );
	} );
} );
