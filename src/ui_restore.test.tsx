/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_restore.test.tsx -- the passphrase ("25th word"): off unless asked
// for, never sent empty when on (says so instead), and sent exactly as
// typed, spaces and capitals included (spaces at the ends pointed out)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { T } from "./ui_text";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const engine = vi.hoisted( () => ( { restored: [] as { phrase: string; passphrase: string }[], imported: [] as string[] } ) );

const EXPORT = [ "# Wallet dump created by Zcash", "secret-extended-key-test1aaa 2021-01-01T00:00:00Z", "cVtransparentKey 2021-01-01T00:00:00Z" ].join( "\n" );

vi.mock( "./bindings", async () => ( {
	commands: {
		wWordlistF: async () => [ "abandon", "about" ],
		wCheckPhraseF: async () => ( { valid: true, unknown: [], problem: "" } ),
		wRestoreF: async ( _net: string, _name: string, phrase: string, passphrase: string ) => {
			engine.restored.push( { phrase, passphrase } );
			return "restored";
		},
		wListF: async () => ( { wallets: [], failed: [], firstRun: false } ),
		wCheckZcashdKeysF: async ( text: string ) => text.trim() === "" ? { kind: "empty" } : text.includes( "secret-extended-key-test1" ) ? { kind: "ok", sapling: 1, sprout: 0, transparent: 1 } : { kind: "bad", problem: "There's no zcashd Sapling key (secret-extended-key…) in what you pasted." },
		wImportZcashdKeysF: async ( _net: string, _name: string, text: string ) => {
			engine.imported.push( text );
			return "imported";
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.restored = [];
	engine.imported = [];
} );

afterEach( cleanup );

// the restore screen with words pasted into its first box, waiting for nothing
async function Paste( pasted: string ) {
	const { UI_Restore } = await import( "./ui_restore" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { useStore } = await import( "./ui_store" );
	const constants = { phraseLengths: [ 12, 24 ], defaultWalletName: "" } as unknown as import( "./bindings" ).constants_t;
	useStore.setState( { network: "testnet", constants: constants, Refresh: async () => {} } );
	const done = vi.fn();
	render( <UI_TipProvider><UI_Restore method="phrase" onDone={done} onBack={() => {}} /></UI_TipProvider> );
	fireEvent.change( screen.getByLabelText( "Word 1" ), { target: { value: "x" } } );		// a box to paste into
	fireEvent.paste( screen.getByLabelText( "Word 1" ), { clipboardData: { getData: () => pasted } } );
	return done;
}

async function Open( pasted = PHRASE ) {
	const done = await Paste( pasted );
	fireEvent.change( screen.getByRole( "textbox", { name: T.restore.name } ), { target: { value: "Old" } } );
	await screen.findByText( T.restore.valid );
	return done;
}

// Next, then the start step's action: Next stays put, saying why, when something is missing
function Finish( action: string ) {
	fireEvent.click( screen.getByRole( "button", { name: T.common.next } ) );
	const go = screen.queryByRole( "button", { name: action } );
	if ( go ) {
		fireEvent.click( go );
	}
}

describe( "UI_Restore start step", () => {
	it( "asks when only after the phrase, with Not Sure chosen, and Back keeps the words", async () => {
		await Open();
		expect( screen.queryByRole( "radiogroup", { name: T.restore.whenChoices } ) ).toBeNull();
		fireEvent.click( screen.getByRole( "button", { name: T.common.next } ) );
		expect( screen.getByRole( "radio", { name: new RegExp( T.restore.whenUnknown ) } ).getAttribute( "aria-checked" ) ).toBe( "true" );

		fireEvent.click( screen.getAllByRole( "button", { name: T.common.back } )[0] );
		expect( ( screen.getByLabelText( "Word 1" ) as HTMLInputElement ).value ).toBe( "abandon" );
	} );

	it( "says a block is missing instead of searching from the start", async () => {
		await Open();
		fireEvent.click( screen.getByRole( "button", { name: T.common.next } ) );
		fireEvent.click( screen.getByRole( "radio", { name: new RegExp( T.restore.whenBlock ) } ) );
		fireEvent.click( screen.getByRole( "button", { name: T.restore.action } ) );
		expect( screen.getByText( T.restore.missingBlock ) ).toBeTruthy();
		expect( engine.restored ).toEqual( [] );
	} );
} );

describe( "UI_Restore paste", () => {
	// W1-05: 24 words and a passphrase written as the 25th, a common paper,
	// restored the wallet without it: empty, as if the money were gone
	it( "says so when more words are pasted than a phrase has, and fills in none", async () => {
		const words = Array.from( { length: 24 }, () => "abandon" ).concat( [ "hunter2" ] );
		await Paste( words.join( " " ) );
		expect( await screen.findByText( T.restore.pastedTooMany( 25, [ 12, 24 ] ) ) ).toBeTruthy();
		expect( ( screen.getByLabelText( "Word 1" ) as HTMLInputElement ).value, "the paste was taken in part" ).toBe( "x" );
		expect( ( screen.getByLabelText( "Word 2" ) as HTMLInputElement ).value ).toBe( "" );
	} );

	it( "says how many came when it isn't a phrase's length", async () => {
		await Paste( Array.from( { length: 13 }, () => "abandon" ).join( " " ) );
		expect( await screen.findByText( T.restore.pastedOdd( 13, [ 12, 24 ] ) ) ).toBeTruthy();
		expect( ( screen.getByLabelText( "Word 13" ) as HTMLInputElement ).value ).toBe( "abandon" );
	} );

	it( "reads a phrase pasted as a numbered list", async () => {
		const numbered = PHRASE.split( " " ).map( ( w, i ) => `${i + 1}. ${w}` ).join( "\n" );
		const done = await Open( numbered );
		Finish( T.restore.action );
		await vi.waitFor( () => expect( done ).toHaveBeenCalled() );
		expect( engine.restored ).toEqual( [ { phrase: PHRASE, passphrase: "" } ] );
	} );
} );

describe( "UI_Restore passphrase", () => {
	it( "sends none unless asked for", async () => {
		const done = await Open();
		expect( screen.queryByLabelText( T.backup.passphrase ) ).toBeNull();
		Finish( T.restore.action );
		await vi.waitFor( () => expect( done ).toHaveBeenCalled() );
		expect( engine.restored ).toEqual( [ { phrase: PHRASE, passphrase: "" } ] );
	} );

	it( "says what's missing instead of restoring with an empty one", async () => {
		await Open();
		fireEvent.click( screen.getByRole( "switch", { name: T.restore.passphrase } ) );
		Finish( T.restore.action );
		await screen.findByText( T.restore.missingPassphrase );
		expect( engine.restored ).toEqual( [] );
		expect( document.activeElement ).toBe( screen.getByLabelText( T.backup.passphrase ) );
	} );

	it( "sends it exactly as typed, and points out spaces at the ends", async () => {
		const done = await Open();
		fireEvent.click( screen.getByRole( "switch", { name: T.restore.passphrase } ) );
		fireEvent.change( screen.getByLabelText( T.backup.passphrase ), { target: { value: "Tr ezor " } } );
		await screen.findByText( T.restore.passphraseEdges );
		Finish( T.restore.action );
		await vi.waitFor( () => expect( done ).toHaveBeenCalled() );
		expect( engine.restored ).toEqual( [ { phrase: PHRASE, passphrase: "Tr ezor " } ] );
	} );

	it( "a nudge isn't hidden behind a valid phrase", async () => {
		await Open();
		fireEvent.change( screen.getByRole( "textbox", { name: T.restore.name } ), { target: { value: "" } } );
		Finish( T.restore.action );
		await screen.findByText( T.restore.missingName );
		expect( screen.queryByText( T.restore.valid ) ).toBeNull();
		expect( engine.restored ).toEqual( [] );
	} );

	it( "turned back off, sends none", async () => {
		const done = await Open();
		const toggle = screen.getByRole( "switch", { name: T.restore.passphrase } );
		fireEvent.click( toggle );
		fireEvent.change( screen.getByLabelText( T.backup.passphrase ), { target: { value: "oops" } } );
		fireEvent.click( toggle );
		Finish( T.restore.action );
		await vi.waitFor( () => expect( done ).toHaveBeenCalled() );
		expect( engine.restored[0].passphrase ).toBe( "" );
	} );
} );

describe( "UI_Restore zcashd keys", () => {
	async function OpenZcashd() {
		const { UI_Restore } = await import( "./ui_restore" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		const { useStore } = await import( "./ui_store" );
		useStore.setState( { network: "testnet", constants: ( await import( "./test_engine" ) ).Test_Constants( { phraseLengths: [ 12, 24 ], defaultWalletName: "Old zcashd" } ), Refresh: async () => {} } );
		const done = vi.fn();
		render( <UI_TipProvider><UI_Restore method="zcashd" onDone={done} onBack={() => {}} /></UI_TipProvider> );
		return done;
	}

	it( "says what's missing, and what it can't import", async () => {
		const done = await OpenZcashd();
		Finish( T.restore.actionZcashd );
		await screen.findByText( T.restore.missingZcashd );
		expect( engine.imported ).toEqual( [] );

		fireEvent.change( screen.getByLabelText( T.restore.methodZcashd ), { target: { value: EXPORT } } );
		await screen.findByText( T.restore.zcashdFound( 1 ) );
		expect( screen.getByText( T.restore.zcashdTransparent( 1 ) ) ).toBeTruthy();		// pointed to Sweep, not dropped

		Finish( T.restore.actionZcashd );
		await vi.waitFor( () => expect( done ).toHaveBeenCalledWith( "imported" ) );
		expect( engine.imported ).toEqual( [ EXPORT ] );		// the text whole: Rust finds the keys
	} );
} );
