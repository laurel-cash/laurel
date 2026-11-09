/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_server.test.tsx -- choosing the server: where the wallets connect is
// said plainly, a server Laurel refuses keeps the sheet open with the
// reason, and Automatic is asked for as no server at all

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import type { serverStatus_t } from "./bindings";

const engine = vi.hoisted( () => ( {
	status:	{ own: null as string | null, current: "https://eu.zec.rocks:443" as string | null, latencyMs: 48 as number | null } satisfies serverStatus_t,
	set:	[] as ( string | null )[],
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		wServerStatusF: async () => engine.status,
		wSetServerF: async ( own: string | null ) => {
			engine.set.push( own );
			if ( own?.startsWith( "http://" ) ) {
				throw "Laurel talks to a server only over a secure connection (https), unless the server runs on this computer.";
			}
			return { own: null, current: null, latencyMs: null };
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

afterEach( cleanup );

describe( "UI_ServerSection", () => {
	it( "says where the wallets connect, refuses with the reason, and asks for Automatic as none", async () => {
		const { UI_ServerSection } = await import( "./ui_server" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		const { QUERY } = await import( "./ui_query" );

		render(
			<QueryClientProvider client={QUERY}>
				<UI_TipProvider><UI_ServerSection /></UI_TipProvider>
			</QueryClientProvider>
		);
		await screen.findByText( "eu.zec.rocks · answered in 48 ms" );

		fireEvent.click( screen.getByRole( "button", { name: "Change" } ) );
		fireEvent.click( await screen.findByRole( "tab", { name: "Your Own" } ) );
		fireEvent.change( screen.getByLabelText( "Server address" ), { target: { value: "http://zec.rocks" } } );
		fireEvent.click( screen.getByRole( "button", { name: "Check and Use" } ) );

		await screen.findByText( /only over a secure connection/ );
		expect( screen.getByRole( "dialog" ) ).toBeTruthy();		// still open, to fix it

		fireEvent.click( screen.getByRole( "tab", { name: "Automatic" } ) );
		fireEvent.click( screen.getByRole( "button", { name: "Use Automatic" } ) );
		await vi.waitFor( () => expect( engine.set ).toEqual( [ "http://zec.rocks", null ] ) );
	} );
} );
