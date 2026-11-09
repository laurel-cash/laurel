/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_main.test.tsx -- the real app, started against a mocked engine, in
// every startup situation. The engine mock is the only stand-in: stores,
// screens and components are the ones that ship.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { T } from "./ui_text";
import { Com_A11y } from "./test_a11y";
import type { documentResult_t, vaultStatus_t, walletList_t } from "./bindings";

// what the mocked engine answers; set per test before the app starts
const engine = vi.hoisted( () => ( {
	vault:		null as vaultStatus_t | null,
	mobile:		false,
	document:	null as documentResult_t | null,
	textScale:	100,
	vaultChanged: null as ( () => void ) | null,
	vaultError:	null as string | null,
	list:		null as walletList_t | null,
	closing:	null as ( () => void ) | null,	// the app's listener for the engine's closing event
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		wConstantsF: async () => ( await import( "./test_engine" ) ).Test_Constants( { mobile: engine.mobile } ),
		sGetF: async () => ( await import( "./test_engine" ) ).Test_Settings( { textScale: engine.textScale } ),
		vOpenF: async () => {
			if ( engine.vaultError ) {
				throw engine.vaultError;
			}
			return engine.vault;
		},
		wListF: async () => engine.list,
		vStatusF: async () => engine.vault,
		dResultF: async () => engine.document,
		dClearF: async () => { engine.document = null; },
	},
	events: new Proxy( ( await import( "./test_engine" ) ).TEST_EVENTS, {
		get: ( silent, name ) => name !== "closingEventT" && name !== "vaultChangedEventT" ? Reflect.get( silent, name ) : {
			listen: async ( f: () => void ) => {
				if ( name === "closingEventT" ) { engine.closing = f; } else { engine.vaultChanged = f; }
				return () => {};
			},
		},
	} ),
} ) );

const UNLOCKED: vaultStatus_t = { state: "unlocked", protection: "os", osProtectionAvailable: true, minPasswordLen: 8 };


/*
==================
Start

A fresh app, with a fresh store: the store and St_Start live at module
level, so every test re-imports them
==================
*/
async function Start() {
	vi.resetModules();
	const { UI_App } = await import( "./ui_main" );
	render( <UI_App /> );
}

beforeEach( () => {
	engine.mobile = false;
	engine.document = null;
	engine.textScale = 100;
	engine.vaultChanged = null;
	engine.vault		= UNLOCKED;
	engine.vaultError	= null;
	engine.list			= { firstRun: false, wallets: [], failed: [] };
	engine.closing		= null;

	// jsdom has no matchMedia; motion asks it about reduced motion
	window.matchMedia = ( ( query: string ) => ( {
		matches: false, media: query, onchange: null,
		addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
	} ) ) as unknown as typeof window.matchMedia;
} );

afterEach( cleanup );

// every test imports the whole app afresh (Start); the first import also
// compiles every module, which under a full parallel run once took longer
// than a test may, and its screen then drew into the next test. Compiled
// once here, each test only pays for running the modules again.
beforeAll( async () => {
	await import( "./ui_main" );
}, 60_000 );

describe( "startup", () => {
	it( "shows onboarding on a first run", async () => {
		engine.list = { firstRun: true, wallets: [], failed: [] };
		await Start();
		expect( await screen.findByText( T.welcome.title ) ).toBeTruthy();
	} );

	// the bug that shipped: a wallet that couldn't open showed onboarding,
	// as if the user's money were gone
	it( "shows a wallet that failed to open, never onboarding", async () => {
		engine.list = { firstRun: false, wallets: [], failed: [ { id: "w1", error: { message: "Laurel couldn't get an answer from the Zcash server.", detail: "UnknownIssuer", retry: false } } ] };
		await Start();
		expect( await screen.findByText( /couldn't get an answer from the Zcash server/ ) ).toBeTruthy();
		expect( screen.queryByText( T.welcome.title ) ).toBeNull();
	} );

	it( "asks for the password when locked", async () => {
		engine.vault = { ...UNLOCKED, state: "locked", protection: "password" };
		await Start();
		expect( await screen.findByText( T.security.lockedTitle ) ).toBeTruthy();
	} );

	it( "asks for a first password where there is no key store", async () => {
		engine.vault = { ...UNLOCKED, state: "needsPassword", protection: null, osProtectionAvailable: false };
		await Start();
		expect( await screen.findByText( T.security.createTitle ) ).toBeTruthy();
	} );

	it( "explains a vault problem instead of showing anything else", async () => {
		engine.vaultError = "Laurel can't find the key that unlocks your wallets";
		await Start();
		expect( await screen.findByText( /can't find the key/ ) ).toBeTruthy();
		expect( screen.queryByText( T.welcome.title ) ).toBeNull();
	} );
} );

describe( "closing", () => {
	// the window waits for every wallet to be saved; a quiet window looked hung
	it( "says it is saving the wallets once the engine starts closing", async () => {
		engine.list = { firstRun: true, wallets: [], failed: [] };
		await Start();
		await screen.findByText( T.welcome.title );
		expect( screen.queryByText( T.chrome.closing ) ).toBeNull();

		act( () => engine.closing?.() );
		expect( screen.getByRole( "alertdialog", { name: T.chrome.closing } ) ).toBeTruthy();
		expect( screen.getByText( T.chrome.closingWhy ) ).toBeTruthy();
	} );
} );

describe( "accessibility", () => {
	// every screen before a wallet opens, as a keyboard and a screen reader meet it
	it( "breaks no rule on any startup screen", async () => {
		const screens: [ string, () => void ][] = [
			[ T.welcome.title,				() => { engine.list = { firstRun: true, wallets: [], failed: [] }; } ],
			[ T.security.lockedTitle,		() => { engine.vault = { ...UNLOCKED, state: "locked", protection: "password" }; } ],
			[ T.security.createTitle,		() => { engine.vault = { ...UNLOCKED, state: "needsPassword", protection: null, osProtectionAvailable: false }; } ],
		];
		for ( const [ title, set ] of screens ) {
			cleanup();
			engine.vault = UNLOCKED;
			engine.list = { firstRun: false, wallets: [], failed: [] };
			set();
			await Start();
			await screen.findByText( title );
			expect( await Com_A11y(), title ).toEqual( [] );
		}
	} );
} );

// Mobile lifecycle comes from Rust even when browser timers stop in the background.
describe( "mobile", () => {
	it.each( [ false, true ] )( "shows a completed file action only after unlocking (signed: %s)", async ( signed ) => {
		engine.mobile = true;
		engine.document = { kind: "saved", path: signed ? "signed.laurelsig" : "payment.laurelreq", signed: signed };
		engine.vault = { ...UNLOCKED, state: "locked", protection: "password" };
		await Start();
		await screen.findByText( T.security.lockedTitle );
		expect( screen.queryByText( engine.document.path ) ).toBeNull();
		engine.vault = UNLOCKED;
		await act( async () => engine.vaultChanged?.() );
		expect( await screen.findByRole( "dialog", { name: signed ? T.offline.signedTitle : T.offline.savedTitle } ) ).toBeTruthy();
		expect( screen.getByText( engine.document.path ) ).toBeTruthy();
		expect( screen.getByText( signed ? T.offline.liveFile : T.offline.savedHistory ) ).toBeTruthy();
		if ( !signed ) { expect( screen.getByText( T.offline.savedHold ) ).toBeTruthy(); }
	} );
	it( "applies text scaling without the unsupported Android webview zoom call", async () => {
		engine.mobile = true;
		engine.textScale = 175;
		engine.list = { firstRun: true, wallets: [], failed: [] };
		await Start();
		await screen.findByText( T.welcome.title );
		expect( document.documentElement.style.zoom ).toBe( "1.75" );
		cleanup();
		expect( document.documentElement.style.zoom ).toBe( "" );
	} );

	it( "keeps desktop window controls off the phone", async () => {
		engine.mobile = true;
		engine.list = { firstRun: true, wallets: [], failed: [] };
		await Start();
		await screen.findByText( T.welcome.title );
		expect( screen.queryByRole( "button", { name: "Minimize" } ) ).toBeNull();
		expect( screen.queryByRole( "button", { name: "Close" } ) ).toBeNull();
		expect( document.documentElement.dataset.mobile ).toBe( "true" );
	} );

	it( "replaces the open screen when the native background lock finishes", async () => {
		engine.mobile = true;
		engine.list = { firstRun: true, wallets: [], failed: [] };
		await Start();
		await screen.findByText( T.welcome.title );
		engine.vault = { ...UNLOCKED, state: "locked", protection: "password", osProtectionAvailable: false };
		await act( async () => engine.vaultChanged?.() );
		expect( await screen.findByText( T.security.lockedTitle ) ).toBeTruthy();
		expect( screen.queryByText( T.welcome.title ) ).toBeNull();
	} );
} );
