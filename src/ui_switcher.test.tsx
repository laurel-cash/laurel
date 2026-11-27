/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_switcher.test.tsx -- the account's name is shown in one place, the
// switcher, so it is renamed there: the account on screen, not another

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import { Test_Summary } from "./test_engine";

const engine = vi.hoisted( () => ( { renamed: [] as [ string, number, string ][] } ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		wRenameAccountF: async ( id: string, account: number, name: string ) => {
			engine.renamed.push( [ id, account, name ] );
			return null;
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

afterEach( cleanup );

describe( "UI_Switcher", () => {
	it( "renames the account on screen", async () => {
		const { UI_Switcher } = await import( "./ui_switcher" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		const { QUERY } = await import( "./ui_query" );
		const { useStore } = await import( "./ui_store" );
		const w = Test_Summary( { id: "w", name: "Everyday" }, [ { name: "Main" }, { name: "Savings" } ] );
		useStore.setState( { wallets: { w }, order: [ "w" ], selection: { walletId: "w", account: 1 } } );
		QUERY.clear();
		render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_Switcher onAddWallet={vi.fn()} onBackup={vi.fn()} onSweep={vi.fn()} /></UI_TipProvider></QueryClientProvider> );

		// opened as a keyboard opens it (Radix opens on pointerdown, which jsdom's click isn't)
		fireEvent.keyDown( screen.getByRole( "button", { name: /Savings/ } ), { key: "Enter" } );
		fireEvent.click( await screen.findByRole( "menuitem", { name: T.switcher.renameAccount } ) );

		const field = await screen.findByLabelText( T.sheets.name );
		expect( ( field as HTMLInputElement ).value ).toBe( "Savings" );
		fireEvent.change( field, { target: { value: "Rainy Day" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.common.save } ) );
		await waitFor( () => expect( engine.renamed ).toEqual( [ [ "w", 1, "Rainy Day" ] ] ) );
	} );
} );
