/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_pays.test.tsx -- a pasted list of payments: every line read, every
// problem said by its line, nothing added while one is left

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { T } from "./ui_text";
import { Com_ReadPayList } from "./ui_pays";

vi.mock( "./bindings", async () => ( {
	commands: {
		// the engine's reading of an address: known shapes, or its refusal in words
		wParseScanF: async ( text: string ) => {
			if ( text.startsWith( "utest1" ) ) return ( await import( "./test_engine" ) ).Test_Scanned( text, "unified" );
			if ( text.startsWith( "tm" ) ) return ( await import( "./test_engine" ) ).Test_Scanned( text, "transparent" );
			throw { message: "That isn't a Zcash address.", detail: null, retry: false };
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

afterEach( cleanup );

describe( "Com_ReadPayList", () => {
	it( "reads address, amount and note; a tab or semicolon keeps a decimal comma whole", () => {
		const read = Com_ReadPayList( "# payroll\n\nutest1aaa, 0.5, Rent, October\ntmBBB;1,25\ntmCCC\t2" );
		expect( read.map( ( l ) => [ l.n, l.to, l.amount, l.memo ] ) ).toEqual( [
			[ 3, "utest1aaa", { kind: "ok", zats: 50_000_000 }, "Rent, October" ],
			[ 4, "tmBBB", { kind: "ok", zats: 125_000_000 }, null ],
			[ 5, "tmCCC", { kind: "ok", zats: 200_000_000 }, null ],
		] );
	} );
} );

async function Open() {
	const { UI_PayListSheet } = await import( "./ui_pays" );
	const onAdd = vi.fn();
	render( <UI_PayListSheet open onOpenChange={() => {}} room={5} onAdd={onAdd} /> );
	return onAdd;
}

describe( "UI_PayListSheet", () => {
	it( "says each problem by its line and adds nothing until they're fixed", async () => {
		const onAdd = await Open();
		fireEvent.change( screen.getByLabelText( T.pays.label ), { target: { value: "utest1aaa, 0.5\nnonsense, 1\ntmBBB, 1, hello" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.pays.check } ) );

		expect( await screen.findByText( "That isn't a Zcash address." ) ).toBeTruthy();		// line 2
		expect( screen.getByText( T.send.memoPublic ) ).toBeTruthy();						// line 3: a note to a public address
		fireEvent.click( screen.getByRole( "button", { name: T.pays.add( 3 ) } ) );
		expect( screen.getByText( T.pays.fixFirst ) ).toBeTruthy();
		expect( onAdd ).not.toHaveBeenCalled();
	} );

	it( "adds a clean list, every line as typed", async () => {
		const onAdd = await Open();
		fireEvent.change( screen.getByLabelText( T.pays.label ), { target: { value: "utest1aaa, 0.5, Rent\ntmBBB; 1,25" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.pays.check } ) );
		fireEvent.click( await screen.findByRole( "button", { name: T.pays.add( 2 ) } ) );
		expect( onAdd ).toHaveBeenCalledWith( [
			{ to: "utest1aaa", zats: 50_000_000, memo: "Rent" },
			{ to: "tmBBB", zats: 125_000_000, memo: null },
		] );
	} );
} );
