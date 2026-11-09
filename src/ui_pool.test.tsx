/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_pool.test.tsx -- a pool, opened: its share said honestly, everything
// that can be done with it (send from it, receive into it, its own step),
// the reason where something can't, and its lines in History

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { T } from "./ui_text";
import { Com_AddressPool, Com_PoolAddress, Com_PoolsShown, POOLS, poolInfo_t } from "./ui_local";
import { Com_PoolActions, Com_PoolPrimary, Com_PoolShare, UI_PoolSheet } from "./ui_pool";
import { useStore } from "./ui_store";
import { Test_Balance } from "./test_engine";

afterEach( cleanup );

const Z = 100_000_000;
const pool = ( p: poolInfo_t["pool"] ) => POOLS.find( ( i ) => i.pool === p )!;
const BALANCE = Test_Balance( { ironwood: { confirmed: 12 * Z }, orchard: { confirmed: 0.3 * Z }, transparent: { confirmed: 0.05 * Z } } );

function Acts( patch: { canMove?: boolean; canReceive?: boolean } = {} ) {
	return { canMove: true, canReceive: true, onSend: vi.fn(), onMigrate: vi.fn(), onMove: vi.fn(), onShield: vi.fn(), onReceive: vi.fn(), ...patch };
}

function Open( p: poolInfo_t["pool"], balance = BALANCE, patch: { canMove?: boolean; canReceive?: boolean } = {} ) {
	const acts = Acts( patch );
	render( <UI_PoolSheet open onOpenChange={() => {}} info={pool( p )} balance={balance} {...acts} /> );
	return acts;
}

describe( "a pool, opened", () => {
	it( "says a small share as under one percent, never as none", () => {
		expect( Com_PoolShare( 0.05 * Z, 12.35 * Z ) ).toBe( "<1" );
		expect( Com_PoolShare( 0, 10 ) ).toBe( "0" );
		expect( Com_PoolShare( 12 * Z, 12.35 * Z ) ).toBe( "97" );
	} );

	// every action is there for every pool, ready or saying why not: the ready ones in order
	it( "offers everything each pool can do, its own step first", () => {
		const ready = ( pool: poolInfo_t["pool"], held: number ) => Com_PoolActions( pool, held, true, true ).filter( ( a ) => a.why === null ).map( ( a ) => a.act );
		expect( ready( "ironwood", Z ) ).toEqual( [ "send", "receive", "history" ] );
		expect( ready( "sapling", Z ) ).toEqual( [ "send", "receive", "move", "history" ] );
		expect( ready( "orchard", Z ) ).toEqual( [ "migrate", "history" ] );
		expect( ready( "transparent", Z ) ).toEqual( [ "shield", "receive", "history" ] );
	} );

	// the lit tile takes money somewhere good: never an invitation into Sapling or the public pool
	it( "lights only an action that takes money somewhere good", () => {
		const lit = ( pool: poolInfo_t["pool"], held: number, canMove = true ) => Com_PoolPrimary( pool, Com_PoolActions( pool, held, canMove, true ) );
		expect( [ lit( "ironwood", Z ), lit( "ironwood", 0 ) ] ).toEqual( [ "send", "receive" ] );
		expect( [ lit( "sapling", Z ), lit( "sapling", 0 ) ] ).toEqual( [ "send", null ] );
		expect( [ lit( "orchard", Z ), lit( "orchard", 0 ), lit( "orchard", Z, false ) ] ).toEqual( [ "migrate", null, null ] );
		expect( [ lit( "transparent", Z ), lit( "transparent", 0 ) ] ).toEqual( [ "shield", null ] );
	} );

	it( "sends from this pool only, and receives at this pool's own address", () => {
		const sapling = Open( "sapling", Test_Balance( { sapling: { confirmed: 2 * Z } } ) );
		fireEvent.click( screen.getByRole( "button", { name: new RegExp( T.pools.sendFrom( "Sapling" ) ) } ) );
		expect( sapling.onSend ).toHaveBeenCalledWith( "sapling" );
		fireEvent.click( screen.getByRole( "button", { name: new RegExp( T.pools.tile.receiveSapling ) } ) );
		expect( sapling.onReceive ).toHaveBeenCalledWith( "sapling" );
		fireEvent.click( screen.getByRole( "button", { name: new RegExp( T.pools.moveSapling ) } ) );
		expect( sapling.onMove ).toHaveBeenCalledOnce();
		cleanup();

		const ironwood = Open( "ironwood" );
		fireEvent.click( screen.getByRole( "button", { name: new RegExp( T.pools.tile.receivePrivate ) } ) );
		expect( ironwood.onReceive ).toHaveBeenCalledWith( "private" );
		cleanup();

		const pub = Open( "transparent" );
		fireEvent.click( screen.getByRole( "button", { name: new RegExp( T.pools.tile.receivePublic ) } ) );
		expect( pub.onReceive ).toHaveBeenCalledWith( "public" );
	} );

	// an empty Sapling still shows its Send, muted, with the reason in it: once it was a grey
	// line under the buttons, and it read as the button missing
	it( "keeps every action in view, saying why where it can't be done", () => {
		Open( "sapling", Test_Balance( { ironwood: { confirmed: Z } } ) );
		expect( screen.queryByRole( "button", { name: new RegExp( T.pools.sendFrom( "Sapling" ) ) } ) ).toBeNull();
		expect( screen.getByText( T.pools.sendFrom( "Sapling" ) ) ).toBeTruthy();
		expect( screen.getAllByText( T.pools.tile.nothingIn( "Sapling" ) ).length ).toBe( 2 );		// Send, Move
		cleanup();

		const pub = Open( "transparent" );
		expect( screen.getByText( T.pools.tile.shieldFirst ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: new RegExp( T.pools.shield ) } ) );
		expect( pub.onShield ).toHaveBeenCalledOnce();
		cleanup();

		const orchard = Open( "orchard" );
		expect( screen.getByText( T.pools.tile.moveFirst ) ).toBeTruthy();
		expect( screen.getByText( T.pools.tile.arrivesElsewhere ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: new RegExp( T.migrate.button ) } ) );
		expect( orchard.onMigrate ).toHaveBeenCalledOnce();
	} );

	it( "follows what the wallet can do", () => {
		Open( "sapling", Test_Balance( { sapling: { confirmed: 2 * Z } } ), { canMove: false } );
		expect( screen.queryByRole( "button", { name: new RegExp( T.pools.moveSapling ) } ) ).toBeNull();
		expect( screen.getByText( T.pools.tile.notThisWallet ) ).toBeTruthy();
		expect( screen.getByRole( "button", { name: new RegExp( T.pools.sendFrom( "Sapling" ) ) } ) ).toBeTruthy();		// a view-only wallet's Send saves a signing request
		cleanup();

		Open( "ironwood", BALANCE, { canReceive: false } );		// zcashd keys: no receiving, said why
		expect( screen.getByText( T.pools.tile.noReceive ) ).toBeTruthy();
	} );

	// the pool list: Ironwood always, others while they hold money, all when asked
	it( "lists only the pools in use, unless asked for all", () => {
		const names = ( r: { shown: poolInfo_t[] } ) => r.shown.map( ( p ) => p.pool );
		expect( names( Com_PoolsShown( Test_Balance( { ironwood: { confirmed: Z } } ), false ) ) ).toEqual( [ "ironwood" ] );
		expect( names( Com_PoolsShown( Test_Balance( { sapling: { pending: 5 } } ), false ) ) ).toEqual( [ "ironwood", "sapling" ] );
		expect( names( Com_PoolsShown( Test_Balance( {} ), true ) ) ).toEqual( POOLS.map( ( p ) => p.pool ) );
	} );

	// Receive's kinds and the pools are one mapping read both ways: every kind is some pool's
	it( "maps every address kind to the pool it pays into, and back", () => {
		for ( const kind of [ "private", "sapling", "public" ] as const ) {
			expect( Com_PoolAddress( Com_AddressPool( kind ) ) ).toBe( kind );
		}
		expect( Com_AddressPool( "public" ) ).toBe( "transparent" );
	} );

	it( "opens History on this pool's lines only", () => {
		Open( "orchard" );
		fireEvent.click( screen.getByRole( "button", { name: new RegExp( T.pools.history ) } ) );
		expect( useStore.getState().page ).toBe( "history" );
		expect( useStore.getState().historyPools ).toEqual( [ "orchard" ] );

		useStore.getState().Go( "home" );		// anywhere else opens History unfiltered
		expect( useStore.getState().historyPools ).toEqual( [] );
	} );
} );
