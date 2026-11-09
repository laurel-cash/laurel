/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_contacts.test.tsx -- the address book against a mocked engine: add,
// a refused duplicate says whose address it is, delete asks once more

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { contact_t, contactInput_t, scanned_t } from "./bindings";

const ADDRESS = "utest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

const engine = vi.hoisted( () => ( {
	book:		[] as contact_t[],
	saved:		[] as contactInput_t[],
	removed:	[] as string[],
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		ctListF: async () => engine.book,
		ctSaveF: async ( c: contactInput_t ) => {
			engine.saved.push( c );
			const other = engine.book.find( ( b ) => b.address === c.address && b.id !== c.id );
			if ( other ) {
				throw { message: `That address is already in your address book, as ${other.name}.`, detail: null, retry: false };
			}
			const saved: contact_t = { id: c.id ?? "c1", name: c.name, address: c.address, kind: "unified", note: c.note, lastPaid: null };
			engine.book = [ ...engine.book.filter( ( b ) => b.id !== saved.id ), saved ];
			return saved;
		},
		ctRemoveF: async ( id: string ) => {
			engine.removed.push( id );
			engine.book = engine.book.filter( ( b ) => b.id !== id );
			return null;
		},
		wParseScanF: async ( text: string ): Promise< scanned_t > => ( await import( "./test_engine" ) ).Test_Scanned( text, "unified" ),
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

async function Open() {
	const { UI_ContactsSection } = await import( "./ui_contacts" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { QUERY } = await import( "./ui_query" );
	QUERY.clear();
	render(
		<QueryClientProvider client={QUERY}>
			<UI_TipProvider><UI_ContactsSection /></UI_TipProvider>
		</QueryClientProvider>
	);
}

async function AddContact( name: string ) {
	fireEvent.click( screen.getByRole( "button", { name: T.contacts.add } ) );
	fireEvent.change( await screen.findByLabelText( T.contacts.name ), { target: { value: name } } );
	fireEvent.change( screen.getByLabelText( T.contacts.address ), { target: { value: ADDRESS } } );
	fireEvent.click( screen.getByRole( "button", { name: T.contacts.save } ) );
}

beforeEach( () => {
	engine.book = [];
	engine.saved = [];
	engine.removed = [];
} );

afterEach( cleanup );

describe( "UI_ContactsSection", () => {
	it( "starts empty, adds a contact, and lists it", async () => {
		await Open();
		await screen.findByText( T.contacts.emptyTitle );

		await AddContact( "Alice" );
		await screen.findByText( "Alice" );
		expect( engine.saved ).toEqual( [ { id: null, name: "Alice", address: ADDRESS, note: null } ] );
	} );

	it( "refuses a second contact for one address, saying whose it is", async () => {
		engine.book = [ { id: "c0", name: "Alice", address: ADDRESS, kind: "unified", note: null, lastPaid: null } ];
		await Open();
		await screen.findByText( "Alice" );

		await AddContact( "Bob" );
		await screen.findByText( /already in your address book, as Alice/ );
		expect( screen.getByRole( "dialog" ) ).toBeTruthy();		// still open, to fix it
	} );

	it( "asks once more before deleting, in place", async () => {
		engine.book = [ { id: "c0", name: "Alice", address: ADDRESS, kind: "unified", note: "rent", lastPaid: null } ];
		await Open();
		fireEvent.click( await screen.findByText( "Alice" ) );

		fireEvent.click( await screen.findByRole( "button", { name: T.contacts.deleteContact } ) );
		expect( engine.removed ).toEqual( [] );
		await screen.findByText( T.contacts.deleteSure( "Alice" ) );

		fireEvent.click( screen.getByRole( "button", { name: T.contacts.delete } ) );
		await screen.findByText( T.contacts.emptyTitle );
		expect( engine.removed ).toEqual( [ "c0" ] );
	} );

	it( "shows a changed address in full, old and new, before it counts", async () => {
		engine.book = [ { id: "c0", name: "Alice", address: ADDRESS, kind: "unified", note: null, lastPaid: null } ];
		const changed = ADDRESS.slice( 0, -4 ) + "zzzz";
		await Open();
		fireEvent.click( await screen.findByText( "Alice" ) );
		fireEvent.change( await screen.findByLabelText( T.contacts.address ), { target: { value: changed } } );
		fireEvent.click( screen.getByRole( "button", { name: T.contacts.save } ) );

		await screen.findByText( T.contacts.changeWarn( "Alice" ) );
		expect( engine.saved ).toEqual( [] );		// not yet
		expect( screen.getByText( T.contacts.before ) ).toBeTruthy();

		fireEvent.click( screen.getByRole( "button", { name: T.contacts.changeAction } ) );
		await vi.waitFor( () => expect( engine.saved.map( ( s ) => s.address ) ).toEqual( [ changed ] ) );
	} );

	it( "saves a renamed contact at once when its address stays", async () => {
		engine.book = [ { id: "c0", name: "Alice", address: ADDRESS, kind: "unified", note: null, lastPaid: null } ];
		await Open();
		fireEvent.click( await screen.findByText( "Alice" ) );
		fireEvent.change( await screen.findByLabelText( T.contacts.name ), { target: { value: "Alice B" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.contacts.save } ) );
		await vi.waitFor( () => expect( engine.saved.map( ( s ) => s.name ) ).toEqual( [ "Alice B" ] ) );
	} );
} );
