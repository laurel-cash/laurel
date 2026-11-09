/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_settings.test.tsx -- on a phone Settings is a list first, and a pane
// opens over it with a way back; a computer shows the list beside the pane

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import { Test_Constants } from "./test_engine";
import type { walletActions_t } from "./ui_wallets";

// every engine command answers nothing: these tests are about which of list and pane show
vi.mock( "./bindings", async () => ( await import( "./test_engine" ) ).TEST_NULL_BINDINGS );

afterEach( cleanup );

const ACTIONS: walletActions_t = { onBackup: vi.fn(), onAddWallet: vi.fn(), onSendAll: vi.fn() };

async function Open( mobile: boolean ) {
	const { UI_Settings } = await import( "./ui_settings" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { useStore } = await import( "./ui_store" );
	useStore.setState( { constants: Test_Constants( { mobile: mobile } ), settingsPane: "general" } );
	useStore.getState().Go( "settings" );
	render( <QueryClientProvider client={new QueryClient()}><UI_TipProvider><UI_Settings actions={ACTIONS} /></UI_TipProvider></QueryClientProvider> );
	return useStore;
}

describe( "UI_Settings", () => {
	it( "on a phone opens on the list, a pane over it, and Back to the list", async () => {
		await Open( true );
		expect( screen.getByRole( "button", { name: T.settings.help } ) ).toBeTruthy();
		expect( screen.queryByRole( "heading", { name: T.settings.help } ) ).toBeNull();		// no pane under the list

		fireEvent.click( screen.getByRole( "button", { name: T.settings.help } ) );
		expect( screen.getByRole( "heading", { name: T.settings.help } ) ).toBeTruthy();
		expect( screen.queryByRole( "button", { name: T.settings.about } ) ).toBeNull();		// the pane alone

		fireEvent.click( screen.getByRole( "button", { name: T.settings.title } ) );
		expect( screen.getByRole( "button", { name: T.settings.about } ) ).toBeTruthy();
		expect( screen.queryByRole( "heading", { name: T.settings.help } ) ).toBeNull();
	} );

	it( "on a phone opens straight on a pane it's sent to (Manage Wallets)", async () => {
		const store = await Open( true );
		store.getState().Go( "settings", "help" );
		expect( await screen.findByRole( "heading", { name: T.settings.help } ) ).toBeTruthy();
		expect( screen.getByRole( "button", { name: T.settings.title } ) ).toBeTruthy();
	} );

	it( "on a computer shows the list beside the pane, with no Back", async () => {
		await Open( false );
		expect( screen.getByRole( "button", { name: T.settings.help } ) ).toBeTruthy();
		expect( screen.getByRole( "heading", { level: 1, name: T.settings.general } ) ).toBeTruthy();
		expect( screen.queryByRole( "button", { name: T.settings.title } ) ).toBeNull();
	} );
} );
