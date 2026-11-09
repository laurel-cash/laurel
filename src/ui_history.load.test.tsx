/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_history.load.test.tsx -- the History page with its answers held: a
// slow answer for one account never lands on another, and what arrived
// with a message shows the message only when opened

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { historyItem_t } from "./bindings";
import { Test_Item } from "./test_engine";

// each account's answer is held until the test releases it
const engine = vi.hoisted( () => ( {
	release: {} as Record< number, ( items: historyItem_t[] ) => void >,
	exports: [] as boolean[],		// each export's memos choice
	notes: [] as [ string, string, string | null ][],	// each saved note and category, by txid
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		wTransactionsF: ( _id: string, account: number ) => new Promise( ( resolve ) => {
			engine.release[account] = resolve;
		} ),
		ntSaveF: async ( txid: string, note: string, category: string | null ) => {
			engine.notes.push( [ txid, note, category ] );
			return null;
		},
		wExportCsvF: async ( _id: string, _account: number, memos: boolean ) => {
			engine.exports.push( memos );
			return "Laurel - Wallet - Main - 2026-09-27.csv";
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

// a line told apart by its memo: sent, so the list shows the words (they are this wallet's own)
function Item( memo: string, kind: historyItem_t["kind"] = "sent" ): historyItem_t {
	return Test_Item( { txid: memo, kind: kind, amount: 1, memo: memo } );
}

async function Open() {
	const { UI_History } = await import( "./ui_history" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );

	return ( p: { account: number } ) => (
		<QueryClientProvider client={client}>
			<UI_TipProvider>
				<UI_History walletId="w1" account={p.account} total={0} progress={undefined} onReceive={() => {}} onSendAgain={() => {}} />
			</UI_TipProvider>
		</QueryClientProvider>
	);
}

afterEach( cleanup );

describe( "UI_History loads", () => {
	it( "never shows one account's history under another, whatever order answers come in", async () => {
		const View = await Open();
		const { rerender } = render( <View account={0} /> );
		rerender( <View account={1} /> );			// switched while account 0 is still loading

		await act( async () => engine.release[1]( [ Item( "account one" ) ] ) );
		await screen.findByText( /account one/ );

		await act( async () => engine.release[0]( [ Item( "account zero" ) ] ) );		// the old answer, last
		expect( screen.queryByText( /account zero/ ) ).toBeNull();
		expect( screen.getByText( /account one/ ) ).toBeTruthy();
	} );
} );

describe( "UI_History messages", () => {
	// anyone can write to a received memo: a lure in the list is read by accident
	it( "says a received payment has a message, and shows it only when opened", async () => {
		const View = await Open();
		render( <View account={0} /> );
		await act( async () => engine.release[0]( [ Item( "Claim your prize at scam.example", "received" ) ] ) );

		const row = await screen.findByText( T.history.withMessage, { exact: false } );
		expect( screen.queryByText( /scam\.example/ ) ).toBeNull();

		fireEvent.click( row );
		expect( await screen.findByText( "“Claim your prize at scam.example”" ) ).toBeTruthy();
	} );
} );

describe( "UI_History export", () => {
	// memos are private words: a file for an accountant leaves them out unless asked
	it( "exports without memos unless asked, and says where the file went", async () => {
		engine.exports = [];
		const View = await Open();
		render( <View account={0} /> );
		await act( async () => engine.release[0]( [ Item( "one" ) ] ) );

		fireEvent.click( await screen.findByRole( "button", { name: T.history.export } ) );
		fireEvent.click( screen.getByRole( "button", { name: T.history.exportAction } ) );
		await screen.findByText( T.history.exported( "Laurel - Wallet - Main - 2026-09-27.csv" ) );
		expect( engine.exports ).toEqual( [ false ] );
	} );
} );

describe( "UI_History notes", () => {
	// the person's own words: kept by the engine, read back into the list
	it( "saves a note, and the list shows it once the engine has it", async () => {
		engine.notes = [];
		const TXID = "ab".repeat( 32 );
		const { useStore } = await import( "./ui_store" );
		useStore.setState( { constants: ( await import( "./test_engine" ) ).Test_Constants( { categories: [ "income", "housing", "food" ] } ) } );
		const View = await Open();
		render( <View account={0} /> );
		await act( async () => engine.release[0]( [ Test_Item( { txid: TXID, kind: "sent", counterparty: "utest1someone" } ) ] ) );

		fireEvent.click( await screen.findByText( "utest1someone", { exact: false } ) );
		fireEvent.change( await screen.findByPlaceholderText( T.history.notePlaceholder ), { target: { value: "  Rent, October " } } );
		fireEvent.change( screen.getByRole( "combobox", { name: T.history.category } ), { target: { value: "housing" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.history.saveNote } ) );
		await vi.waitFor( () => expect( engine.notes ).toEqual( [ [ TXID, "  Rent, October ", "housing" ] ] ) );

		await act( async () => engine.release[0]( [ Test_Item( { txid: TXID, kind: "sent", counterparty: "utest1someone", note: "Rent, October", category: "housing" } ) ] ) );
		expect( ( await screen.findAllByText( "Rent, October", { exact: false } ) ).length ).toBeGreaterThan( 0 );
		expect( screen.queryByRole( "button", { name: T.history.saveNote } ) ).toBeNull();		// saved: nothing left to save
	} );
} );

describe( "UI_History filters", () => {
	const NOW = Math.floor( Date.now() / 1000 );
	const DAY = 86400;

	// three lines, each told apart by who it was with, and each caught by a different filter
	async function Show() {
		const { useStore } = await import( "./ui_store" );
		useStore.setState( { constants: ( await import( "./test_engine" ) ).Test_Constants( { categories: [ "income", "housing", "food" ] } ) } );
		const View = await Open();
		render( <View account={0} /> );
		await act( async () => engine.release[0]( [
			Test_Item( { txid: "a", kind: "sent", counterparty: "utest1landlord", category: "housing", from: [ "ironwood" ], into: [], time: NOW - DAY } ),
			Test_Item( { txid: "b", kind: "sent", counterparty: "utest1grocer", category: "food", from: [ "sapling" ], into: [], state: { kind: "failed" }, time: NOW - 400 * DAY } ),
			Test_Item( { txid: "c", kind: "received", counterparty: "utest1boss", into: [ "transparent" ], state: { kind: "pending", expiresAt: null }, time: NOW - 60 } ),
		] ) );
		await screen.findByText( "utest1grocer", { exact: false } );
	}

	// what the list shows, by who each line was with
	function Shown(): string[] {
		return [ "landlord", "grocer", "boss" ].filter( ( who ) => screen.queryByText( "utest1" + who, { exact: false } ) );
	}

	// one chip in one group of the Filters panel, opening the panel when it's shut
	function Pick( group: string, chip: string ) {
		if ( !screen.queryByRole( "group", { name: group } ) ) {
			fireEvent.click( screen.getByRole( "button", { name: new RegExp( "^" + T.history.filterButton ) } ) );
		}
		fireEvent.click( within( screen.getByRole( "group", { name: group } ) ).getByRole( "button", { name: chip } ) );
	}

	function Remove( chip: string ) {
		fireEvent.click( screen.getByRole( "button", { name: T.history.removeFilter( chip ) } ) );
	}

	// every filter of the panel narrows the list, and its chip under the bar takes it off
	it( "narrows by each filter, and each chip takes its own off", async () => {
		await Show();
		const cases: [ string, string, string[] ][] = [
			[ T.history.poolsLabel,		"Sapling",							[ "grocer" ] ],
			[ T.history.statusLabel,	T.history.statuses.waiting,			[ "boss" ] ],
			[ T.history.statusLabel,	T.history.statuses.failed,			[ "grocer" ] ],
			[ T.history.category,		T.history.categories.housing,		[ "landlord" ] ],
			[ T.history.periodLabel,	T.history.periods.days30,			[ "landlord", "boss" ] ],
		];
		for ( const [ group, chip, shown ] of cases ) {
			Pick( group, chip );
			expect( Shown(), chip ).toEqual( shown );
			Remove( chip );
			expect( Shown(), chip ).toEqual( [ "landlord", "grocer", "boss" ] );
		}
	} );

	// the kind and the search are in the bar, in view: no chips for them, and Clear All
	// takes off only what the panel put on
	it( "keeps the bar's kind through Clear All, and shows no chip row for it", async () => {
		await Show();
		fireEvent.click( screen.getByRole( "tab", { name: new RegExp( T.history.filters.sent ) } ) );
		expect( Shown() ).toEqual( [ "landlord", "grocer" ] );
		expect( screen.queryByRole( "button", { name: T.history.clearAll } ) ).toBeNull();

		Pick( T.history.category, T.history.categories.housing );
		expect( Shown() ).toEqual( [ "landlord" ] );
		fireEvent.click( screen.getByRole( "button", { name: T.history.clearAll } ) );
		expect( Shown() ).toEqual( [ "landlord", "grocer" ] );		// still only Sent
		expect( screen.queryByRole( "button", { name: T.history.clearAll } ) ).toBeNull();
	} );
} );
