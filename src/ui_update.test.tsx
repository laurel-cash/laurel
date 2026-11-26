/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_update.test.tsx -- a newer Laurel, told only to whoever asked: the switch
// only where a store can be asked, nothing asked while it's off

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { Test_Constants, Test_Settings } from "./test_engine";

const asked = vi.hoisted( () => ( { count: 0 } ) );

vi.mock( "./bindings", async () => {
	const { TEST_EVENTS } = await import( "./test_engine" );
	return {
		events:		TEST_EVENTS,
		commands:	new Proxy( {}, { get: ( _, name ) => name === "uNewerF"
			? async () => { asked.count++; return { version: "9.9.9", page: "https://apps.apple.com/app/id6839363562" }; }
			: async () => null } ),
	};
} );

afterEach( cleanup );

beforeEach( () => {
	asked.count = 0;
} );

async function Shown( offered: boolean, on: boolean ) {
	const { useStore } = await import( "./ui_store" );
	const { KEYS, QUERY } = await import( "./ui_query" );
	const { useNewerLaurel, UI_UpdateSetting } = await import( "./ui_update" );
	useStore.setState( { constants: Test_Constants( { mobile: true, updateCheck: offered } ) } );
	const client = QUERY;
	client.clear();
	client.setQueryData( KEYS.settings(), Test_Settings( { checkUpdates: on } ) );
	function Newer() {
		const n = useNewerLaurel();
		return <p>{n ? `newer ${n.version}` : "none"}</p>;
	}
	render( <QueryClientProvider client={client}><UI_UpdateSetting /><Newer /></QueryClientProvider> );
}

describe( "Check for Updates", () => {
	it( "tells of a newer Laurel once the person turned it on", async () => {
		const { T } = await import( "./ui_text" );
		await Shown( true, true );
		expect( await screen.findByText( "newer 9.9.9" ) ).toBeTruthy();
		expect( screen.getByText( T.update.settingLabel ) ).toBeTruthy();
	} );

	it( "asks nothing while it's off", async () => {
		await Shown( true, false );
		await waitFor( () => expect( screen.getByText( "none" ) ).toBeTruthy() );
		expect( asked.count ).toBe( 0 );
	} );

	it( "isn't offered where there's no store to ask, and asks nothing there", async () => {
		const { T } = await import( "./ui_text" );
		await Shown( false, true );
		expect( screen.queryByText( T.update.settingLabel ) ).toBeNull();
		expect( asked.count ).toBe( 0 );
	} );
} );
