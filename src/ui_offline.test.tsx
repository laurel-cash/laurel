/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_offline.test.tsx -- offline signing as the person sees it: a view-only
// wallet's review saves a request (never "Send"); the offline screen shows
// the address whole and says when the numbers moved; a signed file is said
// to be a live payment; finishing shows what was sent

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { T } from "./ui_text";
import type { offlinePending_t, offlineReview_t, offlineSaved_t, quoted_t, sendQuote_t, sendRequest_t } from "./bindings";
import { Test_Balance, Test_Can, Test_Summary } from "./test_engine";

const TO	= "utest1" + "q".repeat( 100 );		// long: an abbreviated address would cut it
const TXID	= "cd".repeat( 32 );

const engine = vi.hoisted( () => ( {
	review:		null as unknown as offlineReview_t,
	signed:		[] as string[],
	saved:		[] as sendQuote_t[],
	pending:	[] as offlinePending_t[],
	revealed:	[] as string[],
} ) );

function Quote( amount: number ): sendQuote_t {
	return { to: TO, kind: "unified", amount: amount, fee: 10_000, from: [ "ironwood" ], steps: 1, memo: "rent", feeNote: null, also: [] };
}

vi.mock( "./bindings", async () => ( {
	commands: {
		oOpenF: async () => engine.review,
		oSignF: async ( id: string ) => {
			engine.signed.push( id );
			return "E:\\signed-abc.laurelsigned";
		},
		oCloseF: async () => null,
		dRevealF: async ( folder: string ) => {
			engine.revealed.push( folder );
			return null;
		},
		oPendingF: async () => engine.pending,
		oFinishF: async () => [ TXID ],
		oForgetF: async () => null,
		oSaveRequestF: async ( _w: string, _a: number, _r: sendRequest_t, seen: sendQuote_t ): Promise< offlineSaved_t > => {
			engine.saved.push( seen );
			return { kind: "saved", path: "E:\\payment-abc.laurelreq" };
		},
		wQuoteSendF: async ( _w: string, _a: number, r: sendRequest_t ): Promise< quoted_t< sendQuote_t > > => ( { intent: "i", quote: { ...Quote( r.zats ?? 0 ), to: r.to, kind: "transparent", memo: null } } ),
		wParseScanF: async ( text: string ) => ( await import( "./test_engine" ) ).Test_Scanned( text, "transparent" ),
		ctListF: async () => [],
		wTransactionsF: async () => [],
		wSendNowF: async () => { throw new Error( "a view-only wallet never sends" ); },
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.review = { requestId: "abc123", walletName: "Cold", accountName: "Main", quote: Quote( 500_000 ), changed: true, made: 1_790_000_000, keyFolder: null };
	engine.signed = [];
	engine.saved = [];
	engine.revealed = [];
	engine.pending = [ { id: "abc123", walletId: "w1", account: 0, quote: Quote( 500_000 ), made: 1_790_000_000 } ];
} );

afterEach( cleanup );

async function Wrap( children: React.ReactNode ) {
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
	render( <QueryClientProvider client={client}><UI_TipProvider>{children}</UI_TipProvider></QueryClientProvider> );
}

describe( "offline signing", () => {
	it( "shows the whole address offline, says the numbers moved, and that a signed file is live", async () => {
		const { UI_OfflineSection } = await import( "./ui_offline" );
		await Wrap( <UI_OfflineSection /> );
		fireEvent.click( screen.getByRole( "button", { name: T.offline.openRequest } ) );
		expect( await screen.findByText( TO ) ).toBeTruthy();		// whole, never abbreviated here
		expect( screen.getByText( T.offline.changed ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: T.offline.sign } ) );
		expect( await screen.findByText( T.offline.liveFile ) ).toBeTruthy();
		expect( engine.signed ).toEqual( [ "abc123" ] );
	} );

	// a signer downloads nothing (w_spendkey.rs): it says where Sapling's spend key goes, and shows the folder
	it( "says where to copy Sapling's proving key when a signing needs it", async () => {
		engine.review = { ...engine.review, quote: { ...Quote( 500_000 ), from: [ "sapling" ] }, changed: false, keyFolder: "D:\Laurel" };
		const { UI_OfflineSection } = await import( "./ui_offline" );
		await Wrap( <UI_OfflineSection /> );
		fireEvent.click( screen.getByRole( "button", { name: T.offline.openRequest } ) );
		expect( await screen.findByText( T.offline.keyMissing( "D:\Laurel" ), { exact: false } ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: T.offline.showFolder } ) );
		await vi.waitFor( () => expect( engine.revealed ).toEqual( [ "data" ] ) );
	} );

	it( "lists a waiting request, and finishing shows what was sent", async () => {
		const { UI_OfflineSection } = await import( "./ui_offline" );
		await Wrap( <UI_OfflineSection /> );
		expect( await screen.findByRole( "button", { name: T.offline.forgetButton } ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: T.offline.finish } ) );
		expect( await screen.findByText( T.offline.sentTitle ) ).toBeTruthy();
	} );

	it( "a view-only wallet's review saves a request, never sends", async () => {
		const { useStore } = await import( "./ui_store" );
		const { UI_SendSheet, EMPTY_DRAFT } = await import( "./ui_send" );
		const wallet = Test_Summary( { name: "Cold", kind: "viewOnly", can: Test_Can( { spend: false, moveWithin: false, addAccount: false } ) }, [ { balance: Test_Balance( { ironwood: { confirmed: 100_000_000 } } ) } ] );
		useStore.setState( { network: "testnet", wallets: { w1: wallet } } );
		function Host() {
			const [ draft, setDraft ] = useState( { ...EMPTY_DRAFT, to: "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd", amount: "0.1" } );
			return <UI_SendSheet open onOpenChange={() => {}} walletId="w1" account={0} balance={wallet.accounts[0].balance} offline={false} draft={draft} onDraft={setDraft} onScan={() => {}} onShield={() => {}} />;
		}
		await Wrap( <Host /> );
		fireEvent.click( await screen.findByRole( "button", { name: T.send.review } ) );
		expect( await screen.findByText( T.offline.viewOnlyNote ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: T.offline.saveRequest } ) );
		expect( await screen.findByText( T.offline.savedHold ) ).toBeTruthy();
		expect( engine.saved.length ).toBe( 1 );
	} );
} );
