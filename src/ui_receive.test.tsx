/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_receive.test.tsx -- asking for an amount: the engine builds the
// request for this account's own address, the amount is read exactly as
// Send reads it, and a public request carries no memo. The Sapling side:
// its own address, renewed alone, and said plainly when there is none.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { addressKind_t, freshAddress_t, receive_t } from "./bindings";

const engine = vi.hoisted( () => ( {
	asked:		[] as { to: string; zats: number; memo: string | null }[],
	renewed:	[] as ( string | null )[],
	sapling:	"ztestsapling1first" as string | null,		// null: a viewing key without a Sapling part
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		wReceiveF: async ( _id: string, _account: number, fresh: freshAddress_t | null ): Promise< receive_t > => {
			engine.renewed.push( fresh );
			if ( fresh === "sapling" ) {
				engine.sapling = "ztestsapling1second";
			}
			return { shielded: "utest1private", shieldedIndex: 0, sapling: engine.sapling, transparent: "tmPublic" };
		},
		wRequestF: async ( _id: string, _account: number, to: addressKind_t, zats: number, memo: string | null ) => {
			engine.asked.push( { to, zats, memo } );
			return `zcash:${to}?amount=${zats}`;
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.asked = [];
	engine.renewed = [];
	engine.sapling = "ztestsapling1first";
} );

afterEach( cleanup );

async function Show( side?: addressKind_t ) {
	const { UI_ReceiveSheet } = await import( "./ui_receive" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { QUERY } = await import( "./ui_query" );
	const { useStore } = await import( "./ui_store" );
	QUERY.clear();
	useStore.setState( { constants: ( await import( "./test_engine" ) ).Test_Constants( { memoMaxBytes: 512 } ) } );
	render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_ReceiveSheet open onOpenChange={() => {}} walletId="w" account={0} accountName="Main" side={side} onSweep={() => {}} /></UI_TipProvider></QueryClientProvider> );
}

// a footer tile, by its title (its line follows the title in its name)
function Tile( title: string ) {
	return screen.findByRole( "button", { name: new RegExp( "^" + title ) } );
}

// another kind, from the chooser
async function Pick( kind: addressKind_t ) {
	fireEvent.click( await Tile( T.receive.others ) );
	fireEvent.click( screen.getByRole( "button", { name: new RegExp( "^" + T.receive[kind] ) } ) );
}

async function Open() {
	await Show();
	fireEvent.click( await Tile( T.receive.request ) );
	return screen.getByLabelText( T.send.amount );
}

describe( "requesting an amount", () => {
	// the private address first, alone: a beginner never meets the pools here; the other
	// kinds are one tap away for a payer that can't pay it
	it( "opens on the private address alone, the other kinds one tap away", async () => {
		await Show();
		expect( await Tile( T.receive.newAddress ) ).toBeTruthy();
		expect( screen.queryByText( T.receive.kinds.sapling ) ).toBeNull();

		// the chooser: three cards, each a short tag, the private one recommended
		fireEvent.click( await Tile( T.receive.others ) );
		for ( const kind of [ "private", "sapling", "public" ] as const ) {
			expect( screen.getByText( T.receive.kinds[kind] ) ).toBeTruthy();
		}
		expect( screen.getByText( T.receive.recommended ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: T.common.back } ) );
		expect( await Tile( T.receive.newAddress ) ).toBeTruthy();
	} );

	it( "shows the public address when it's picked, warned, and never made new", async () => {
		await Show();
		await Pick( "public" );
		expect( screen.getAllByText( /tmPublic/ ).length ).toBeGreaterThan( 0 );
		expect( screen.getByText( T.receive.publicWarn ) ).toBeTruthy();
		expect( screen.queryByRole( "button", { name: new RegExp( "^" + T.receive.newAddress ) } ) ).toBeNull();
		expect( await Tile( T.receive.tile.sweep ) ).toBeTruthy();
	} );

	it( "asks the engine for this account's request, with the memo, and shows it", async () => {
		const field = await Open();
		fireEvent.change( field, { target: { value: "1.5" } } );
		fireEvent.change( screen.getByLabelText( T.send.memo ), { target: { value: "Rent" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.receive.makeRequest } ) );

		await screen.findByRole( "button", { name: T.receive.copyRequest } );
		expect( engine.asked ).toEqual( [ { to: "private", zats: 150_000_000, memo: "Rent" } ] );
	} );

	it( "never guesses \"1,000\", and says what's missing instead of doing nothing", async () => {
		const field = await Open();
		fireEvent.click( screen.getByRole( "button", { name: T.receive.makeRequest } ) );
		expect( screen.getByText( T.receive.noAmount ) ).toBeTruthy();

		fireEvent.change( field, { target: { value: "1,000" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.receive.makeRequest } ) );
		expect( engine.asked ).toEqual( [] );
		fireEvent.click( screen.getByRole( "button", { name: "1000" } ) );		// the person picks the reading
		fireEvent.click( screen.getByRole( "button", { name: T.receive.makeRequest } ) );
		await screen.findByRole( "button", { name: T.receive.copyRequest } );
		expect( engine.asked[0].zats ).toBe( 100_000_000_000 );
	} );

	it( "on the public side, asks with no memo field at all", async () => {
		await Show( "public" );		// as the public pool opens it
		fireEvent.click( await Tile( T.receive.request ) );
		expect( screen.queryByLabelText( T.send.memo ) ).toBeNull();
		fireEvent.change( screen.getByLabelText( T.send.amount ), { target: { value: "2" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.receive.makeRequest } ) );
		await screen.findByRole( "button", { name: T.receive.copyRequest } );
		expect( engine.asked ).toEqual( [ { to: "public", zats: 200_000_000, memo: null } ] );
	} );
} );

describe( "the Sapling side", () => {
	it( "gives its own address, and a request for it keeps the memo", async () => {
		await Show();
		await Pick( "sapling" );
		expect( await screen.findByText( T.receive.kinds.sapling ) ).toBeTruthy();
		expect( screen.getAllByText( /ztestsapling1first/ ).length ).toBeGreaterThan( 0 );

		fireEvent.click( await Tile( T.receive.request ) );
		fireEvent.change( screen.getByLabelText( T.send.amount ), { target: { value: "3" } } );
		fireEvent.change( screen.getByLabelText( T.send.memo ), { target: { value: "Invoice 7" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.receive.makeRequest } ) );
		await screen.findByRole( "button", { name: T.receive.copyRequest } );
		expect( engine.asked ).toEqual( [ { to: "sapling", zats: 300_000_000, memo: "Invoice 7" } ] );
	} );

	// a pool opens Receive on its own side; New Address there makes a Sapling one, nothing else
	it( "opens where it is asked to, and renews only its own address", async () => {
		await Show( "sapling" );
		expect( await screen.findByText( T.receive.kinds.sapling ) ).toBeTruthy();
		fireEvent.click( await Tile( T.receive.newAddress ) );
		expect( ( await screen.findAllByText( /ztestsapling1second/ ) ).length ).toBeGreaterThan( 0 );
		expect( engine.renewed ).toEqual( [ null, "sapling" ] );
	} );

	it( "says so when the wallet has no Sapling address to give", async () => {
		engine.sapling = null;
		await Show( "sapling" );
		expect( await screen.findByText( T.receive.noSapling ) ).toBeTruthy();
		expect( screen.queryByRole( "button", { name: new RegExp( "^" + T.receive.request ) } ) ).toBeNull();
		expect( await Tile( T.receive.others ) ).toBeTruthy();		// never a dead end: the other kinds are there
	} );
} );
