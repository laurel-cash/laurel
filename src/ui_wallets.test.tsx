/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_wallets.test.tsx -- Manage Wallets says what one paper covers: every
// account of a wallet, and the other wallets made from the same words,
// each with its own passphrase

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { walletSummary_t } from "./bindings";
import { Test_Balance, Test_Can, Test_Summary, Test_Vault } from "./test_engine";

const engine = vi.hoisted( () => ( { removed: [] as ( string | null )[] } ) );		// the password each remove was sent with

vi.mock( "./bindings", async () => ( {
	commands: {
		wRemoveWalletF: async ( _id: string, password: string | null ) => {
			engine.removed.push( password );
			return null;
		},
		wReceiveF: async ( id: string ) => ( { shielded: `utest1of${id}`, shieldedIndex: 0, sapling: null, transparent: null } ),
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

afterEach( cleanup );

// a seed wallet, as the engine sums it up
function Wallet( id: string, name: string, accounts: string[], sameWords: string[], more: Partial< walletSummary_t > = {}, total = 0 ): walletSummary_t {
	return Test_Summary( { id: id, name: name, sameWords: sameWords, ...more }, accounts.map( ( a ) => ( { name: a, balance: Test_Balance( { ironwood: { confirmed: total } } ) } ) ) );
}

async function Open( wallets: walletSummary_t[], actions = { onBackup: vi.fn(), onAddWallet: vi.fn(), onSendAll: vi.fn() } ) {
	const { UI_WalletsSection } = await import( "./ui_wallets" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { QUERY } = await import( "./ui_query" );
	const { useStore } = await import( "./ui_store" );
	useStore.setState( { wallets: Object.fromEntries( wallets.map( ( w ) => [ w.id, w ] ) ), order: wallets.map( ( w ) => w.id ) } );
	QUERY.clear();
	render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_WalletsSection actions={actions} /></UI_TipProvider></QueryClientProvider> );
	return actions;
}

// opens the move sheet of the first wallet
function Move() {
	fireEvent.click( screen.getAllByRole( "button", { name: T.wallets.moveAll } )[0] );
}

describe( "UI_WalletsSection", () => {
	it( "names the wallets made from the same words, each on the other's card", async () => {
		await Open( [ Wallet( "a", "Everyday", [ "Main" ], [ "b" ] ), Wallet( "b", "Vault", [ "Main" ], [ "a" ] ) ] );
		expect( screen.getByText( T.wallets.sameWords( [ "Vault" ] ) ) ).toBeTruthy();
		expect( screen.getByText( T.wallets.sameWords( [ "Everyday" ] ) ) ).toBeTruthy();
	} );

	it( "says one backup covers every account, and nothing for one account", async () => {
		await Open( [ Wallet( "a", "Everyday", [ "Main", "Savings" ], [] ), Wallet( "b", "Solo", [ "Main" ], [] ) ] );
		expect( screen.getAllByText( T.wallets.oneBackup( 2 ) ).length ).toBe( 1 );
		expect( screen.queryByText( /same recovery words/ ) ).toBeNull();
	} );
} );

describe( "moving everything out", () => {
	it( "with nowhere safe to go, offers to make a wallet first", async () => {
		const actions = await Open( [ Wallet( "old", "Leaked", [ "Main" ], [], {}, 5 ) ] );
		Move();
		fireEvent.click( await screen.findByRole( "button", { name: T.wallets.moveCreate } ) );
		expect( actions.onAddWallet ).toHaveBeenCalledWith( "create" );
	} );

	it( "never into a wallet that isn't backed up: that is backed up first", async () => {
		const actions = await Open( [ Wallet( "old", "Leaked", [ "Main" ], [], {}, 5 ), Wallet( "new", "Fresh", [ "Main" ], [], { backedUp: false } ) ] );
		Move();
		expect( await screen.findByText( T.wallets.moveBackUp( "Fresh" ) ) ).toBeTruthy();
		expect( screen.queryByRole( "button", { name: T.wallets.moveSend } ) ).toBeNull();
		fireEvent.click( screen.getByRole( "button", { name: T.wallets.backUpNow } ) );
		expect( actions.onBackup ).toHaveBeenCalledWith( "new" );
	} );

	it( "sends each account's all to the new wallet's own address, through Send", async () => {
		const actions = await Open( [ Wallet( "old", "Leaked", [ "Main", "Savings" ], [], {}, 5 ), Wallet( "new", "Fresh", [ "Main" ], [] ), Wallet( "watch", "Watched", [ "Main" ], [], { kind: "viewOnly", can: Test_Can( { spend: false, moveWithin: false, addAccount: false } ) } ) ] );
		Move();
		expect( screen.queryByRole( "option", { name: "Watched" } ) ).toBeNull();		// a view-only wallet can't spend what arrives
		fireEvent.click( ( await screen.findAllByRole( "button", { name: T.wallets.moveSend } ) )[1] );
		await vi.waitFor( () => expect( actions.onSendAll ).toHaveBeenCalledWith( "old", 1, "utest1ofnew" ) );
	} );

	it( "once empty, says so and offers removing it", async () => {
		const wallets = [ Wallet( "old", "Leaked", [ "Main" ], [], {}, 5 ), Wallet( "new", "Fresh", [ "Main" ], [] ) ];
		await Open( wallets );
		Move();
		const { useStore } = await import( "./ui_store" );
		useStore.setState( { wallets: { old: Wallet( "old", "Leaked", [ "Main" ], [], {}, 0 ), new: wallets[1] } } );
		expect( await screen.findByText( T.wallets.moveDone ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: T.wallets.moveRemove } ) );
		expect( await screen.findByRole( "dialog", { name: T.wallets.removeTitle( "Leaked" ) } ) ).toBeTruthy();
	} );
} );

describe( "removing a wallet", () => {
	// W1-01: the engine removes a wallet only for someone just asked (V_Confirm)
	async function Remove( protection: "password" | "os" ) {
		const { useStore } = await import( "./ui_store" );
		engine.removed = [];
		await Open( [ Wallet( "w", "Savings", [ "Main" ], [], { backedUp: true } ) ] );
		useStore.setState( { vault: Test_Vault( { protection: protection } ), Refresh: async () => {} } );
		fireEvent.click( screen.getByRole( "button", { name: T.wallets.remove } ) );
		fireEvent.click( await screen.findByRole( "button", { name: T.wallets.action } ) );
	}

	it( "asks for the password and sends it along", async () => {
		await Remove( "password" );
		fireEvent.change( await screen.findByLabelText( T.security.password ), { target: { value: "correct horse" } } );
		fireEvent.click( screen.getAllByRole( "button", { name: T.wallets.action } ).slice( -1 )[0] );
		await vi.waitFor( () => expect( engine.removed ).toEqual( [ "correct horse" ] ) );
	} );

	it( "asks nothing when Windows protects the key", async () => {
		await Remove( "os" );
		await vi.waitFor( () => expect( engine.removed ).toEqual( [ null ] ) );
		expect( screen.queryByLabelText( T.security.password ) ).toBeNull();
	} );
} );

describe( "a wallet that can't be saved", () => {
	const error = { message: "The disk is full.", detail: null, retry: false };

	async function Show( more: Partial< walletSummary_t > ) {
		const { UI_SaveFailed } = await import( "./ui_wallets" );
		render( <UI_SaveFailed wallet={Wallet( "w", "Savings", [ "Main" ], [], more )} error={error} /> );
	}

	it( "says it's safe in memory", async () => {
		await Show( {} );
		expect( await screen.findByText( ( t ) => t.includes( T.security.saveFailedHint ) ) ).toBeTruthy();
	} );
} );
