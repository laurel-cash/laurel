/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_move.test.tsx -- Sapling into Ironwood: the move is reviewed, then
// sent once with what was seen; new numbers are shown again, not sent;
// nothing to move asks the engine nothing; a refusal says its reason.
// Shield is the same sheet: it still asks its own engine calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import { Com_FormatZec } from "./ui_local";
import type { quoted_t, shieldQuote_t, shieldResult_t } from "./bindings";

const Z = 100_000_000;
const quote = ( amount: number, intent = "i1" ): quoted_t< shieldQuote_t > => ( { intent: intent, quote: { amount: amount, fee: 10_000, feeNote: null } } );

const engine = vi.hoisted( () => ( {
	quoted:		[] as string[],
	sent:		[] as { intent: string; amount: number }[],
	next:		null as unknown as quoted_t< shieldQuote_t > | Error,
	answers:	[] as shieldResult_t[],
	keyHere:	true,
	keyAsked:	0,
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		wQuoteMoveF: async () => {
			engine.quoted.push( "move" );
			if ( engine.next instanceof Error ) {
				throw engine.next;
			}
			return engine.next;
		},
		wMoveNowF: async ( _id: string, _account: number, intent: string, seen: shieldQuote_t ) => {
			engine.sent.push( { intent: intent, amount: seen.amount } );
			return engine.answers.shift();
		},
		skHereF: async () => {
			engine.keyAsked++;
			return engine.keyHere;
		},
		wQuoteShieldF: async () => {
			engine.quoted.push( "shield" );
			return quote( 5 * Z );
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.quoted = [];
	engine.sent = [];
	engine.next = quote( 2 * Z );
	engine.answers = [];
	engine.keyHere = true;
	engine.keyAsked = 0;
} );

afterEach( cleanup );

async function Open( which: "move" | "shield", held: number, synced = true ) {
	const { UI_MoveSheet, UI_ShieldSheet } = await import( "./ui_shield" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { QUERY } = await import( "./ui_query" );
	const { useStore } = await import( "./ui_store" );
	const { Test_Summary } = await import( "./test_engine" );
	QUERY.clear();
	const summary = Test_Summary( { id: "w" } );
	useStore.setState( { wallets: { w: synced ? summary : { ...summary, progress: { ...summary.progress, complete: false, running: true, percent: 40 } } } } );
	const Sheet = which === "move" ? UI_MoveSheet : UI_ShieldSheet;
	render( <QueryClientProvider client={QUERY}><UI_TipProvider><Sheet open onOpenChange={() => {}} walletId="w" account={0} heldZats={held} offline={false} /></UI_TipProvider></QueryClientProvider> );
}

describe( "moving Sapling into Ironwood", () => {
	it( "shows the move, then sends it once, with what was seen", async () => {
		engine.answers = [ { kind: "sent", txid: "ab".repeat( 32 ) } ];
		await Open( "move", 2 * Z );
		expect( await screen.findByText( T.move.from ) ).toBeTruthy();
		expect( screen.getByText( T.move.to ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: T.move.action( Com_FormatZec( 2 * Z ) ) } ) );
		expect( await screen.findByText( T.move.doneTitle ) ).toBeTruthy();
		expect( engine.sent ).toEqual( [ { intent: "i1", amount: 2 * Z } ] );
	} );

	// new Sapling money arrived meanwhile: the new numbers are shown, and only a second press sends them
	it( "shows new numbers again instead of sending them", async () => {
		engine.answers = [ { kind: "changed", quoted: quote( 3 * Z, "i2" ) }, { kind: "sent", txid: "cd".repeat( 32 ) } ];
		await Open( "move", 2 * Z );
		fireEvent.click( await screen.findByRole( "button", { name: T.move.action( Com_FormatZec( 2 * Z ) ) } ) );
		expect( await screen.findByText( T.move.changed ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: T.move.action( Com_FormatZec( 3 * Z ) ) } ) );
		expect( await screen.findByText( T.move.doneTitle ) ).toBeTruthy();
		expect( engine.sent ).toEqual( [ { intent: "i1", amount: 2 * Z }, { intent: "i2", amount: 3 * Z } ] );
	} );

	it( "asks the engine nothing when there is nothing in Sapling", async () => {
		await Open( "move", 0 );
		expect( await screen.findByText( T.move.nothingTitle ) ).toBeTruthy();
		expect( engine.quoted ).toEqual( [] );
	} );

	it( "says why it can't, in the engine's words", async () => {
		engine.next = Object.assign( new Error( "below" ), { message: "The Sapling money here is less than the network fee to move it." } );
		await Open( "move", 1 );
		expect( await screen.findByText( T.move.failed ) ).toBeTruthy();
		expect( screen.queryByRole( "button", { name: T.move.actionHidden } ) ).toBeNull();
	} );

	it( "leaves Shield asking its own quote", async () => {
		await Open( "shield", 5 * Z );
		expect( await screen.findByText( T.shield.from ) ).toBeTruthy();
		expect( engine.quoted ).toEqual( [ "shield" ] );
	} );

	// Sapling's spend key is fetched the first time (w_spendkey.rs): the review says so first
	it( "says the first move fetches Sapling's proving key, and only then", async () => {
		engine.keyHere = false;
		await Open( "move", 2 * Z );
		expect( await screen.findByText( T.review.fetchKey ) ).toBeTruthy();

		cleanup();
		engine.keyHere = true;
		await Open( "move", 2 * Z );
		expect( await screen.findByText( T.move.from ) ).toBeTruthy();
		await vi.waitFor( () => expect( engine.keyAsked ).toBe( 2 ) );
		expect( screen.queryByText( T.review.fetchKey ) ).toBeNull();
	} );

	// a payment is built only on a wallet that has caught up: until then the sheet says so, with a
	// way out, and asks the engine nothing; once caught up it goes on by itself (ui_sync.tsx)
	it( "waits for the wallet to catch up, closable, asking nothing, then goes on by itself", async () => {
		await Open( "move", 2 * Z, false );
		expect( await screen.findByText( T.catchUp.title ) ).toBeTruthy();
		expect( screen.getByText( T.catchUp.safe ) ).toBeTruthy();
		expect( screen.getByRole( "button", { name: T.catchUp.later } ) ).toBeTruthy();
		expect( engine.quoted ).toEqual( [] );

		const { useStore } = await import( "./ui_store" );
		const { Test_Summary } = await import( "./test_engine" );
		act( () => useStore.setState( { wallets: { w: Test_Summary( { id: "w" } ) } } ) );
		expect( await screen.findByText( T.move.from ) ).toBeTruthy();
		expect( engine.quoted ).toEqual( [ "move" ] );
	} );

	it( "never asks about Sapling's key for Shield: it spends no Sapling notes", async () => {
		engine.keyHere = false;
		await Open( "shield", 5 * Z );
		expect( await screen.findByText( T.shield.from ) ).toBeTruthy();
		expect( engine.keyAsked ).toBe( 0 );
		expect( screen.queryByText( T.review.fetchKey ) ).toBeNull();
	} );
} );
