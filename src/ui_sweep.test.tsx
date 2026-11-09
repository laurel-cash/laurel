/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_sweep.test.tsx -- sweeping a private key: Find never silently does
// nothing, the key never becomes a cache key, what was reviewed is what
// is sent, and new numbers are shown again before anything moves

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { sweepQuote_t } from "./bindings";

const GOOD = "cVgoodTestKeyNeverInACacheKey";

const QUOTE: sweepQuote_t = { from: "tmFromAddressOfTheKey00000000000", to: "tmToAddressOfTheAccount000000000", coins: 2, left: 0, total: 100_000, fee: 10_000, amount: 90_000 };

const engine = vi.hoisted( () => ( {
	quotes:		0,
	sent:		[] as { key: string; intent: string; seen: unknown }[],
	changeOnce:	false,
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		wCheckKeyF: async ( key: string ) => key.trim() === "" ? { kind: "empty" } : key === GOOD ? { kind: "ok", address: QUOTE.from } : { kind: "bad", problem: "That isn't a private key, or it has a typo." },
		wQuoteSweepF: async () => {
			engine.quotes++;
			return { intent: `i${engine.quotes}`, quote: QUOTE };
		},
		wSweepNowF: async ( _id: string, _account: number, key: string, intent: string, seen: sweepQuote_t ) => {
			engine.sent.push( { key, intent, seen } );
			if ( engine.changeOnce ) {
				engine.changeOnce = false;
				return { kind: "changed", quoted: { intent: "i-new", quote: { ...QUOTE, amount: 80_000, total: 90_000 } } };
			}
			return { kind: "sent", txid: "ab".repeat( 32 ) };
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.quotes = 0;
	engine.sent = [];
	engine.changeOnce = false;
} );

afterEach( cleanup );

async function Open() {
	const { UI_SweepSheet } = await import( "./ui_sweep" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { QUERY } = await import( "./ui_query" );
	const { useStore } = await import( "./ui_store" );
	useStore.setState( { network: "testnet", hideAmounts: false } );
	QUERY.clear();
	render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_SweepSheet open onOpenChange={() => {}} walletId="w" account={0} accountName="Main · Savings" offline={false} /></UI_TipProvider></QueryClientProvider> );
	return QUERY;
}

function Type( text: string ) {
	fireEvent.change( screen.getByLabelText( T.sweep.label ), { target: { value: text } } );
}

describe( "UI_SweepSheet", () => {
	it( "says what's missing instead of finding nothing", async () => {
		await Open();
		fireEvent.click( screen.getByRole( "button", { name: T.sweep.find } ) );
		await screen.findByText( T.sweep.missing );
		expect( engine.quotes ).toBe( 0 );

		Type( "not a key" );
		await screen.findByText( "That isn't a private key, or it has a typo." );
		fireEvent.click( screen.getByRole( "button", { name: T.sweep.find } ) );
		expect( engine.quotes ).toBe( 0 );
	} );

	it( "sends what was reviewed, and the key is never a cache key", async () => {
		const query = await Open();
		Type( GOOD );
		await screen.findByText( /Controls/ );
		fireEvent.click( screen.getByRole( "button", { name: T.sweep.find } ) );

		const go = await screen.findByRole( "button", { name: /^Sweep / } );
		for ( const q of query.getQueryCache().getAll() ) {
			expect( JSON.stringify( q.queryKey ) ).not.toContain( GOOD );
		}
		fireEvent.click( go );
		await screen.findByText( T.sweep.doneTitle );
		expect( engine.sent ).toEqual( [ { key: GOOD, intent: "i1", seen: QUOTE } ] );
	} );

	it( "shows new numbers before anything moves", async () => {
		await Open();
		engine.changeOnce = true;
		Type( GOOD );
		await screen.findByText( /Controls/ );
		fireEvent.click( screen.getByRole( "button", { name: T.sweep.find } ) );
		fireEvent.click( await screen.findByRole( "button", { name: /^Sweep / } ) );

		await screen.findByText( T.sweep.changed );
		fireEvent.click( screen.getByRole( "button", { name: /^Sweep / } ) );
		await screen.findByText( T.sweep.doneTitle );
		expect( engine.sent.map( ( s ) => s.intent ) ).toEqual( [ "i1", "i-new" ] );
	} );
} );
