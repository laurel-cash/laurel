/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_repeat.test.tsx -- a repeating payment is a reminder: due says so and
// offers Send, filled in; skipping moves it on; nothing is ever sent here

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { repeat_t } from "./bindings";
import { Com_NoonOf } from "./ui_repeat";

const engine = vi.hoisted( () => ( {
	list:	[] as repeat_t[],
	done:	[] as string[],
	removed:	[] as string[],
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		rpListF: async () => engine.list,
		rpDoneF: async ( id: string ) => {
			engine.done.push( id );
			return null;
		},
		rpRemoveF: async ( id: string ) => {
			engine.removed.push( id );
			return null;
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

function Repeat( id: string, due: boolean ): repeat_t {
	return { id, walletId: "w", account: 0, label: id === "rent" ? "Rent" : "Gym", to: "utest1x", zats: 50_000_000, memo: null, every: "month", next: 1_800_000_000, day: 15, due };
}

beforeEach( () => {
	engine.list = [ Repeat( "rent", true ), Repeat( "gym", false ) ];
	engine.done = [];
	engine.removed = [];
} );

// a row's ⋯ menu, opened as a keyboard opens it (Radix opens on pointerdown, which jsdom's click isn't)
async function More( label: string ) {
	fireEvent.keyDown( screen.getByRole( "button", { name: T.repeat.more( label ) } ), { key: "Enter" } );
	return screen.findByRole( "menu" );
}

afterEach( cleanup );

async function Show() {
	const { UI_Repeats } = await import( "./ui_repeat" );
	const { QUERY } = await import( "./ui_query" );
	QUERY.clear();
	const onPay = vi.fn();
	render( <QueryClientProvider client={QUERY}><UI_Repeats onPay={onPay} /></QueryClientProvider> );
	await screen.findByText( "Rent" );
	return onPay;
}

describe( "UI_Repeats", () => {
	it( "offers what's due for review, and skipping only moves it on", async () => {
		const onPay = await Show();
		expect( screen.getByText( T.repeat.due ) ).toBeTruthy();
		expect( screen.getAllByRole( "button", { name: T.repeat.pay } ).length ).toBe( 1 );		// only the due one

		fireEvent.click( screen.getByRole( "button", { name: T.repeat.pay } ) );
		expect( onPay ).toHaveBeenCalledWith( engine.list[0] );

		expect( screen.queryByRole( "button", { name: T.repeat.skip } ) ).toBeNull();		// one button a row: the rest in its menu
		await More( "Rent" );
		fireEvent.click( screen.getByRole( "menuitem", { name: T.repeat.skip } ) );
		await vi.waitFor( () => expect( engine.done ).toEqual( [ "rent" ] ) );
		expect( engine.removed ).toEqual( [] );
	} );

	it( "removes one only from its menu, never from a link in the row", async () => {
		await Show();
		expect( screen.queryByRole( "button", { name: T.repeat.remove } ) ).toBeNull();
		await More( "Gym" );
		expect( screen.queryByRole( "menuitem", { name: T.repeat.skip } ) ).toBeNull();		// not due: nothing to skip
		fireEvent.click( screen.getByRole( "menuitem", { name: T.repeat.remove } ) );
		await vi.waitFor( () => expect( engine.removed ).toEqual( [ "gym" ] ) );
	} );
} );

describe( "Com_NoonOf", () => {
	it( "is noon on the picked day, where the person is", () => {
		const d = new Date( Com_NoonOf( "2026-10-01" ) * 1000 );
		expect( [ d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours() ] ).toEqual( [ 2026, 10, 1, 12 ] );
	} );
} );
