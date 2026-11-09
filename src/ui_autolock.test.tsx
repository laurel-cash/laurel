/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_autolock.test.tsx -- auto-lock on a fake clock: not before the chosen
// time, activity starts the wait again, a full idle stretch locks, and
// without a password there is nothing to lock behind

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";


const engine = vi.hoisted( () => ( { locks: 0, minutes: 1 as number | null, shown: null as null | ( () => void ) } ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		sGetF: async () => ( await import( "./test_engine" ) ).Test_Settings( { autoLockMinutes: engine.minutes } ),
		// the engine's answer to "back": held until the test lets it go
		mShownF: () => new Promise< null >( ( ok ) => { engine.shown = () => ok( null ); } ),
		wLockF: async () => {
			engine.locks++;
			return ( await import( "./test_engine" ) ).Test_Vault( { state: "locked", protection: "password" } );
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

const MINUTE = 60_000;

async function Mount( protection: "password" | "os", mobile = false ) {
	const { useAutoLock } = await import( "./ui_security" );
	const { useStore } = await import( "./ui_store" );
	const { Test_Constants, Test_Vault } = await import( "./test_engine" );
	useStore.setState( { vault: Test_Vault( { protection: protection } ), constants: Test_Constants( { mobile: mobile } ) } );

	function Guard() {
		useAutoLock();
		return null;
	}
	const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
	render( <QueryClientProvider client={client}><Guard /></QueryClientProvider> );
	await act( async () => { await vi.advanceTimersByTimeAsync( 0 ); } );		// the settings arrive
}

async function Pass( msec: number ) {
	await act( async () => { await vi.advanceTimersByTimeAsync( msec ); } );
}

beforeEach( () => {
	vi.useFakeTimers();
	engine.locks = 0;
	engine.minutes = 1;
} );

afterEach( () => {
	cleanup();
	vi.useRealTimers();
} );

// what the page says about being seen (jsdom's document.hidden is fixed)
function Seen( visible: boolean ) {
	Object.defineProperty( document, "hidden", { configurable: true, get: () => !visible } );
	fireEvent( document, new Event( "visibilitychange" ) );
}

describe( "a phone in the background", () => {
	it( "covers the wallets at once, and shows them again only once the engine answers", async () => {
		await Mount( "password", true );
		Seen( false );
		expect( document.documentElement.classList.contains( "away" ) ).toBe( true );

		Seen( true );
		await Pass( 0 );
		expect( document.documentElement.classList.contains( "away" ) ).toBe( true );		// asked, no answer yet
		engine.shown?.();
		await Pass( 0 );
		expect( document.documentElement.classList.contains( "away" ) ).toBe( false );
	} );

	it( "never covers on a computer", async () => {
		await Mount( "password" );
		Seen( false );
		expect( document.documentElement.classList.contains( "away" ) ).toBe( false );
		Seen( true );
	} );
} );

describe( "useAutoLock", () => {
	it( "waits the chosen time, starts again on activity, then locks", async () => {
		await Mount( "password" );

		await Pass( 0.75 * MINUTE );
		expect( engine.locks ).toBe( 0 );

		fireEvent.pointerDown( window );		// the person is here
		await Pass( 0.75 * MINUTE );
		expect( engine.locks ).toBe( 0 );		// 1.5 minutes since mounting, 0.75 since the click

		await Pass( 0.5 * MINUTE );
		expect( engine.locks ).toBe( 1 );
	} );

	// asleep, the clock moves on and the timers don't; waking, the mouse moves first
	it( "locks after sleep, though the first thing on waking is the mouse", async () => {
		await Mount( "password" );
		vi.setSystemTime( Date.now() + 2 * MINUTE );
		fireEvent.pointerMove( window );
		await Pass( 0 );
		expect( engine.locks ).toBe( 1 );
	} );

	it( "locks when shown again after the time ran out, before any tick", async () => {
		await Mount( "password" );
		vi.setSystemTime( Date.now() + 2 * MINUTE );
		fireEvent( document, new Event( "visibilitychange" ) );
		await Pass( 0 );
		expect( engine.locks ).toBe( 1 );
	} );

	it( "locks on Ctrl+L at once", async () => {
		await Mount( "password" );
		fireEvent.keyDown( window, { key: "l", ctrlKey: true } );
		await Pass( 0 );
		expect( engine.locks ).toBe( 1 );
	} );

	it( "never locks without a password: there's nothing to lock behind", async () => {
		await Mount( "os" );
		fireEvent.keyDown( window, { key: "l", ctrlKey: true } );
		await Pass( 10 * MINUTE );
		expect( engine.locks ).toBe( 0 );
	} );

	it( "never locks when set to Never", async () => {
		engine.minutes = null;
		await Mount( "password" );
		await Pass( 120 * MINUTE );
		expect( engine.locks ).toBe( 0 );
	} );
} );
