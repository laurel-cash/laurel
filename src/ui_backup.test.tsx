/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_backup.test.tsx -- the backup check proves the paper: a third of the
// words, a wrong pick starts it over (clicking through the choices once
// passed it with no paper at all), and a passphrase is typed back exactly

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { recovery_t } from "./bindings";

// twelve different words, so every choice is its own button
const WORDS = [ "zoo", "yard", "wing", "vast", "used", "toss", "sun", "rich", "quit", "pony", "oval", "nest" ];

const engine = vi.hoisted( () => ( {
	marked:		0,
	passphrase:	null as string | null,			// the wallet's, as the check was opened with
	asked:		[] as ( string | null )[],		// the passwords the phrase was asked for with
	password:	"correct horse" as string | null,	// null: windows protects the key
	protected:	[] as boolean[],				// every capture-exclusion change, in order
} ) );

vi.mock( "@tauri-apps/api/window", () => ( {
	getCurrentWindow: () => ( {
		setContentProtected: async ( on: boolean ) => {
			engine.protected.push( on );
		},
	} ),
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		// the engine's rule (E_PhraseMatches): a third of the words at their places, and the passphrase
		wMarkBackedUpF: async ( _id: string, words: { pos: number; word: string }[], passphrase: string | null ) => {
			const seen = new Set( words.map( ( w ) => w.pos ) );
			if ( words.length < WORDS.length / 3 || seen.size !== words.length || words.some( ( w ) => WORDS[w.pos] !== w.word ) || passphrase !== engine.passphrase ) {
				throw { message: "Those aren't this wallet's words.", detail: null, retry: false };
			}
			engine.marked++;
			return null;
		},
		// the engine's rule (V_Confirm): with a password, only that password
		wRecoveryF: async ( _id: string, password: string | null ) => {
			engine.asked.push( password );
			if ( engine.password !== null && password !== engine.password ) {
				throw { message: password === null ? "Enter your password to do this." : "That password isn't right.", detail: null, retry: false };
			}
			return { seedPhrase: WORDS.join( " " ), passphrase: null, birthday: 3_000_000, birthdayTime: null };
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( async () => {
	const { useStore } = await import( "./ui_store" );
	const { Test_Constants } = await import( "./test_engine" );
	useStore.setState( { constants: Test_Constants() } );
	engine.marked		= 0;
	engine.asked		= [];
	engine.password		= "correct horse";
	engine.protected	= [];
} );

afterEach( cleanup );

async function OpenCheck( passphrase: string | null, onMarked: () => void = () => {} ) {
	const { UI_Backup } = await import( "./ui_backup" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { QUERY } = await import( "./ui_query" );
	QUERY.clear();
	engine.passphrase = passphrase;
	const recovery: recovery_t = { seedPhrase: WORDS.join( " " ), passphrase: passphrase, birthday: 3_000_000, birthdayTime: null };
	const done = vi.fn();
	render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_Backup walletId="w" recovery={recovery} onDone={done} onLater={() => {}} onMarked={onMarked} /></UI_TipProvider></QueryClientProvider> );
	fireEvent.click( await screen.findByRole( "button", { name: T.backup.show } ) );
	fireEvent.click( await screen.findByRole( "button", { name: T.backup.reveal } ) );
	fireEvent.click( await screen.findByRole( "button", { name: T.backup.written } ) );
	await screen.findByText( T.backup.checkTitle );
	return done;
}

describe( "the covered phrase", () => {
	it( "isn't in the page until it's revealed", async () => {
		const { UI_Backup } = await import( "./ui_backup" );
		const { UI_TipProvider } = await import( "./ui_widgets" );
		const { QUERY } = await import( "./ui_query" );
		QUERY.clear();
		const recovery: recovery_t = { seedPhrase: WORDS.join( " " ), passphrase: "open sesame", birthday: 3_000_000, birthdayTime: null };
		const { container } = render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_Backup walletId="w" recovery={recovery} onDone={() => {}} onLater={() => {}} /></UI_TipProvider></QueryClientProvider> );
		fireEvent.click( await screen.findByRole( "button", { name: T.backup.show } ) );
		await screen.findByRole( "button", { name: T.backup.reveal } );
		// blurred is not enough: a screen reader or anything reading the page would still get the words
		// each row is its number, then its word
		const shownWords = () => Array.from( container.querySelectorAll( ".phrase li" ) ).map( ( li ) => li.textContent?.replace( /^\d+/, "" ) );
		expect( shownWords().some( ( w ) => WORDS.includes( w ?? "" ) ) ).toBe( false );
		expect( container.textContent ).not.toContain( "open sesame" );

		fireEvent.click( await screen.findByRole( "button", { name: T.backup.reveal } ) );
		await screen.findByRole( "button", { name: T.backup.written } );
		expect( shownWords() ).toEqual( WORDS );
		expect( container.textContent ).toContain( "open sesame" );
	} );
} );

// the asked positions, as the screen shows them
function Asked(): number[] {
	return screen.getAllByText( /^Word #\d+$/ ).map( ( e ) => Number( e.textContent?.slice( 6 ) ) );
}

// a word can be offered in several rows: answer inside the row asked
function AnswerRight( position: number ) {
	const row = screen.getByText( `Word #${position}` ).parentElement!;
	fireEvent.click( Array.from( row.querySelectorAll( "button" ) ).find( ( b ) => b.textContent === WORDS[position - 1] )! );
}

describe( "UI_BackupVerify", () => {
	it( "asks about a third of the words", async () => {
		await OpenCheck( null );
		expect( Asked().length ).toBe( 4 );
	} );

	it( "starts over after a wrong pick: guessing through the choices proves nothing", async () => {
		await OpenCheck( null );
		const [ first, second ] = Asked();
		AnswerRight( first );
		expect( document.querySelectorAll( ".verify-row.right" ).length ).toBe( 1 );

		const row = screen.getByText( `Word #${second}` ).parentElement!;
		const wrong = Array.from( row.querySelectorAll( "button" ) ).find( ( b ) => b.textContent !== WORDS[second - 1] )!;
		fireEvent.click( wrong );

		await screen.findByText( T.backup.startOver, { exact: false } );
		expect( document.querySelectorAll( ".verify-row.right" ).length ).toBe( 0 );		// nothing kept
	} );

	it( "with a passphrase, isn't done until it's typed back exactly", async () => {
		const done = await OpenCheck( "Tr ezor " );
		for ( const p of Asked() ) {
			AnswerRight( p );
		}
		const field = await screen.findByLabelText( T.backup.passphrase );
		fireEvent.change( field, { target: { value: "Tr ezor" } } );		// the trailing space is part of it
		await new Promise( ( ok ) => setTimeout( ok, 700 ) );
		expect( done ).not.toHaveBeenCalled();
		expect( engine.marked ).toBe( 0 );

		fireEvent.change( field, { target: { value: "Tr ezor " } } );
		await screen.findByText( T.backup.doneTitle, {}, { timeout: 2000 } );
	} );

	// W1-08: once the engine has it marked, nothing here holds the words any longer, and the
	// screen that brought them (ui_main's visit) is told to let go of its copy
	it( "lets go of the phrase once the check passes, and still says it's done", async () => {
		const marked = vi.fn();
		await OpenCheck( null, marked );
		const [ first, second ] = Asked();
		AnswerRight( first );
		const row = screen.getByText( `Word #${second}` ).parentElement!;
		fireEvent.click( Array.from( row.querySelectorAll( "button" ) ).find( ( b ) => b.textContent !== WORDS[second - 1] )! );
		await screen.findByText( T.backup.startOver, { exact: false } );
		expect( marked ).not.toHaveBeenCalled();		// a wrong pick marks nothing

		for ( const p of Asked() ) {
			AnswerRight( p );
		}
		await screen.findByText( T.backup.doneTitle, {}, { timeout: 2000 } );
		expect( engine.marked ).toBe( 1 );
		expect( marked ).toHaveBeenCalledTimes( 1 );
	} );
} );

/*
==================
OpenLater

The backup of a wallet made earlier, from the banner: nothing is fetched
until the person asks
==================
*/
async function OpenLater( protection: "password" | "os" ) {
	const { UI_Backup } = await import( "./ui_backup" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { QUERY } = await import( "./ui_query" );
	const { useStore } = await import( "./ui_store" );
	QUERY.clear();
	useStore.setState( { vault: { state: "unlocked", protection: protection, osProtectionAvailable: true, minPasswordLen: 8 } } );
	const leave = vi.fn();
	const view = render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_Backup walletId="w" recovery={null} onDone={() => {}} onLater={leave} /></UI_TipProvider></QueryClientProvider> );
	return { view, leave };
}

describe( "showing a phrase later", () => {
	it( "asks for the password first, and a wrong one shows nothing", async () => {
		await OpenLater( "password" );
		expect( engine.asked ).toEqual( [] );

		fireEvent.click( await screen.findByRole( "button", { name: T.backup.show } ) );
		const field = await screen.findByLabelText( T.security.password );
		fireEvent.change( field, { target: { value: "wrong horse" } } );
		fireEvent.keyDown( field, { key: "Enter" } );
		await screen.findByText( "That password isn't right." );
		expect( screen.queryByRole( "button", { name: T.backup.reveal } ) ).toBeNull();

		fireEvent.change( field, { target: { value: "correct horse" } } );
		fireEvent.keyDown( field, { key: "Enter" } );
		await screen.findByRole( "button", { name: T.backup.reveal } );
		expect( engine.asked ).toEqual( [ "wrong horse", "correct horse" ] );
	} );

	it.each( [ false, true ] )( "keeps capture protection owned by the platform (mobile: %s)", async ( mobile ) => {
		const { useStore } = await import( "./ui_store" );
		const { Test_Constants } = await import( "./test_engine" );
		useStore.setState( { constants: Test_Constants( { mobile } ) } );
		const { view } = await OpenLater( "password" );
		fireEvent.click( await screen.findByRole( "button", { name: T.backup.show } ) );
		const field = await screen.findByLabelText( T.security.password );
		fireEvent.change( field, { target: { value: "correct horse" } } );
		fireEvent.keyDown( field, { key: "Enter" } );
		await screen.findByRole( "button", { name: T.backup.reveal } );
		expect( engine.protected ).toEqual( mobile ? [] : [ true ] );

		view.unmount();
		expect( engine.protected ).toEqual( mobile ? [] : [ true, false ] );
	} );

	it( "without a password, says who else could show it", async () => {
		engine.password = null;
		await OpenLater( "os" );
		expect( screen.getByText( T.backup.noPassword ) ).toBeTruthy();

		fireEvent.click( await screen.findByRole( "button", { name: T.backup.show } ) );
		await screen.findByRole( "button", { name: T.backup.reveal } );
		expect( engine.asked ).toEqual( [ null ] );
	} );
} );
