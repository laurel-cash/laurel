/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_alert.test.tsx -- a price alert is set with the price typed exactly,
// and each says whether it's waiting or went off

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { priceAlert_t } from "./bindings";

const engine = vi.hoisted( () => ( {
	alerts:	[] as priceAlert_t[],
	added:	[] as [ boolean, number ][],
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		alListF: async () => engine.alerts,
		alAddF: async ( above: boolean, usd: number ) => {
			engine.added.push( [ above, usd ] );
			return { id: "new", above, usd, fired: null };
		},
		alRemoveF: async () => null,
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.alerts = [
		{ id: "a", above: true, usd: 80, fired: null },
		{ id: "b", above: false, usd: 20, fired: 1_790_000_000 },
	];
	engine.added = [];
} );

afterEach( cleanup );

async function Open() {
	const { UI_PriceAlertSheet } = await import( "./ui_alert" );
	const { QUERY } = await import( "./ui_query" );
	QUERY.clear();
	render( <QueryClientProvider client={QUERY}><UI_PriceAlertSheet open onOpenChange={() => {}} price={42.5} /></QueryClientProvider> );
}

describe( "UI_PriceAlertSheet", () => {
	it( "adds the price as typed, the way asked", async () => {
		await Open();
		fireEvent.click( screen.getByRole( "tab", { name: "Falls below" } ) );
		fireEvent.change( screen.getByLabelText( T.alerts.price ), { target: { value: "35.25" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.alerts.add } ) );
		await vi.waitFor( () => expect( engine.added ).toEqual( [ [ false, 35.25 ] ] ) );
	} );

	it( "says which alerts wait and which went off", async () => {
		await Open();
		expect( await screen.findByText( T.alerts.waiting ) ).toBeTruthy();
		expect( screen.getByText( ( t ) => t.startsWith( "Went off" ) ) ).toBeTruthy();
	} );
} );
