/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_security.test.tsx -- a Laurel left unlocked for a minute can't be set
// to stay unlocked: a later auto-lock waits for the password, whenever the
// engine says so, and a sooner one never asks

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { appSettings_t, autoLockResult_t } from "./bindings";
import { Test_Settings } from "./test_engine";

// the settings as the engine holds them
function Settings(): appSettings_t {
	return Test_Settings( { autoLockMinutes: engine.minutes, lockAwaySecs: engine.away } );
}

const engine = vi.hoisted( () => ( {
	startedOver:	0,
	away:		60,
	minutes:	5 as number | null,
	calls:		[] as { minutes: number | null; password: string | null }[],
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		wStartOverF: async () => { engine.startedOver++; return null; },
		sGetF: async (): Promise< appSettings_t > => Settings(),
		// S_SetLockAway: later than now needs the password, as the auto-lock does
		sSetLockAwayF: async ( secs: number, password: string | null ): Promise< autoLockResult_t > => {
			if ( secs > engine.away && password === null ) {
				return { kind: "askPassword" };
			}
			engine.away = secs;
			return { kind: "saved", settings: Settings() };
		},
		// the engine's rule, S_LocksLater with V_Confirm: later needs the password
		sSetAutoLockF: async ( minutes: number | null, password: string | null ): Promise< autoLockResult_t > => {
			engine.calls.push( { minutes, password } );
			const later = ( minutes ?? Infinity ) > ( engine.minutes ?? Infinity );
			if ( later && password === null ) {
				return { kind: "askPassword" };
			}
			if ( later && password !== "correct horse" ) {
				throw { message: "That password isn't right.", detail: null, retry: false };
			}
			engine.minutes = minutes;
			return { kind: "saved", settings: Settings() };
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.startedOver	= 0;
	engine.away			= 60;
	engine.minutes	= 5;
	engine.calls	= [];
} );

afterEach( cleanup );

async function Open( mobile = false ) {
	const { UI_SecuritySection } = await import( "./ui_security" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { QUERY } = await import( "./ui_query" );
	const { useStore } = await import( "./ui_store" );
	QUERY.clear();
	useStore.setState( {
		vault:		( await import( "./test_engine" ) ).Test_Vault( { protection: "password" } ),
		constants:	( await import( "./test_engine" ) ).Test_Constants( { autoLockChoices: [ 1, 5, 10, 15, 30, 60 ], mobile: mobile } ),
	} );
	render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_SecuritySection /></UI_TipProvider></QueryClientProvider> );
	return await screen.findByRole( "combobox", { name: T.security.autoLock } );
}

// a forgotten password has a way out on the lock screen itself, asked twice
describe( "lock screen", () => {
	it( "starts over only once it's confirmed", async () => {
		const { UI_LockScreen } = await import( "./ui_security" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		render( <UI_TipProvider><UI_LockScreen /></UI_TipProvider> );
		fireEvent.click( screen.getByRole( "button", { name: T.security.forgotTitle } ) );
		expect( engine.startedOver ).toBe( 0 );
		localStorage.setItem( "laurel.selection", "\"w1\"" );
		fireEvent.click( await screen.findByRole( "button", { name: T.security.startOverAction } ) );
		await vi.waitFor( () => expect( engine.startedOver ).toBe( 1 ) );
		expect( localStorage.length, "the browser's prefs outlived Start Over (W1-03)" ).toBe( 0 );
	} );

	// W1-03: a key that can't be had left a screen with nothing to do
	it( "offers Start Over when the key can't be opened", async () => {
		const { UI_VaultErrorScreen } = await import( "./ui_security" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		render( <UI_TipProvider><UI_VaultErrorScreen message={{ message: "Laurel can't find the key", detail: null, retry: false }} /></UI_TipProvider> );
		fireEvent.click( screen.getByRole( "button", { name: T.security.startOverBroken } ) );
		expect( engine.startedOver ).toBe( 0 );
		fireEvent.click( await screen.findByRole( "button", { name: T.security.startOverAction } ) );
		await vi.waitFor( () => expect( engine.startedOver ).toBe( 1 ) );
	} );
} );

describe( "auto-lock", () => {
	it( "locks sooner without asking", async () => {
		const select = await Open();
		fireEvent.change( select, { target: { value: "1" } } );
		await vi.waitFor( () => expect( engine.minutes ).toBe( 1 ) );
		expect( engine.calls ).toEqual( [ { minutes: 1, password: null } ] );
		expect( screen.queryByLabelText( T.security.password ) ).toBeNull();
	} );

	it( "asks for the password before never locking, and keeps the old time until it's right", async () => {
		const select = await Open();
		fireEvent.change( select, { target: { value: "0" } } );		// never

		await screen.findByText( T.security.laterNever );
		const field = screen.getByLabelText( T.security.password );
		fireEvent.change( field, { target: { value: "wrong" } } );
		fireEvent.keyDown( field, { key: "Enter" } );
		await screen.findByText( "That password isn't right." );
		expect( engine.minutes ).toBe( 5 );

		fireEvent.change( field, { target: { value: "correct horse" } } );
		fireEvent.keyDown( field, { key: "Enter" } );
		await vi.waitFor( () => expect( engine.minutes ).toBeNull() );
		expect( engine.calls.map( ( c ) => c.password ) ).toEqual( [ null, "wrong", "correct horse" ] );
	} );
} );

describe( "lock when you leave (a phone)", () => {
	it( "is offered on a phone only", async () => {
		await Open();
		expect( screen.queryByRole( "combobox", { name: T.security.lockAway } ) ).toBeNull();
	} );

	it( "locks sooner without asking, and asks for the password before staying open longer", async () => {
		await Open( true );
		const select = await screen.findByRole( "combobox", { name: T.security.lockAway } );
		fireEvent.change( select, { target: { value: "0" } } );
		await vi.waitFor( () => expect( engine.away ).toBe( 0 ) );
		await vi.waitFor( () => expect( ( select as HTMLSelectElement ).disabled ).toBe( false ) );		// saved, ready for the next

		fireEvent.change( select, { target: { value: "300" } } );
		await screen.findByText( T.security.awayLater( 300 ) );
		expect( engine.away ).toBe( 0 );
	} );
} );

// a local hint, never a rule: the engine's only rule is the length (V_CheckPassword)
describe( "password strength hint", () => {
	it( "calls common and short passwords weak, and a few words strong", async () => {
		const { Com_PasswordStrength } = await import( "./ui_security" );
		expect( Com_PasswordStrength( "password1" ) ).toBe( "weak" );
		expect( Com_PasswordStrength( "12345678" ) ).toBe( "weak" );
		expect( Com_PasswordStrength( "aaaaaaaaaaaa" ) ).toBe( "weak" );
		expect( Com_PasswordStrength( "qwertyuiop" ) ).toBe( "weak" );
		expect( Com_PasswordStrength( "Tr0ub4dor&3" ) ).toBe( "fair" );
		expect( Com_PasswordStrength( "correct horse battery staple" ) ).toBe( "strong" );
		expect( Com_PasswordStrength( "k8#Lw2!qPz9@xR4m" ) ).toBe( "strong" );
	} );

	it( "says how strong as the password is typed, without stopping a weak one", async () => {
		const { UI_CreatePasswordScreen } = await import( "./ui_security" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		render( <UI_TipProvider><UI_CreatePasswordScreen /></UI_TipProvider> );
		fireEvent.change( screen.getByLabelText( T.security.newPassword ), { target: { value: "password1" } } );
		expect( screen.getByText( T.security.strength.weak ) ).toBeTruthy();
		fireEvent.change( screen.getByLabelText( T.security.newPassword ), { target: { value: "correct horse battery staple" } } );
		expect( screen.getByText( T.security.strength.strong ) ).toBeTruthy();
	} );
} );
