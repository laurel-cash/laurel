/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_send.test.tsx -- the send flow against a mocked engine: what is
// asked of the engine, what review shows, that Send sends exactly what
// was reviewed under the intent it was quoted with, and that changed
// numbers are shown, never sent unseen

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { balance_t, pool_t, contact_t, feeNote_t, historyItem_t, payTo_t, quoted_t, scanned_t, sendQuote_t, sendRequest_t, sendResult_t } from "./bindings";
import { Test_Balance, Test_Item, Test_Summary } from "./test_engine";

const PUBLIC_ADDR	= "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd";
const ZATS			= 100_000_000;
const FEE			= 10_000;

const engine = vi.hoisted( () => ( {
	quoted:		[] as sendRequest_t[],
	seen:		[] as sendQuote_t[],		// what each Send said the person had reviewed
	intents:	[] as string[],				// the intent each Send handed back
	open:		new Set< string >(),		// intents handed out and not yet taken, as the engine keeps them
	made:		0,
	sent:		0,
	moveOn:		false,						// the chain moved: the next build costs more
	history:	[] as historyItem_t[],		// the account's transactions
	feeNote:	null as feeNote_t | null,	// what Rust says about the fee
	contacts:	[] as contact_t[],
	repeatsDone: [] as string[],			// reminders moved on after their payment
} ) );

// zats null is Max: everything in the account, less the fee
function Quote( request: sendRequest_t, fee: number ): sendQuote_t {
	const also = request.also.map( ( p ) => ( { to: p.to, kind: "transparent" as const, amount: p.zats, memo: p.memo } ) );
	const first = request.zats ?? 2 * ZATS - fee;
	return { to: request.to, kind: "transparent", amount: first + also.reduce( ( s, p ) => s + p.amount, 0 ), fee: fee, from: [ "ironwood" ], steps: 1, memo: null, feeNote: engine.feeNote, also: also };
}

function Intend( quote: sendQuote_t ): quoted_t< sendQuote_t > {
	const intent = `intent-${++engine.made}`;
	engine.open.add( intent );
	return { intent, quote };
}

vi.mock( "./bindings", async () => ( {
	commands: {
		wParseScanF: async ( text: string ): Promise< scanned_t > => ( await import( "./test_engine" ) ).Test_Scanned( text, "transparent" ),
		ctListF: async () => engine.contacts,
		wTransactionsF: async () => engine.history,
		wQuoteSendF: async ( _id: string, _account: number, request: sendRequest_t ): Promise< quoted_t< sendQuote_t > > => {
			engine.quoted.push( request );
			return Intend( Quote( request, FEE ) );
		},
		wSendNowF: async ( _id: string, _account: number, request: sendRequest_t, intent: string, seen: sendQuote_t, repeatId: string | null ): Promise< sendResult_t > => {
			engine.intents.push( intent );
			if ( !engine.open.delete( intent ) ) {
				throw { message: "This payment was already sent, or what you reviewed is out of date. Review it again before sending.", detail: null, retry: false };
			}
			engine.seen.push( seen );
			const now = Quote( request, engine.moveOn ? FEE * 2 : FEE );
			if ( now.fee !== seen.fee ) {
				return { kind: "changed", quoted: Intend( now ) };
			}
			engine.sent++;
			if ( repeatId ) {
				engine.repeatsDone.push( repeatId );		// the engine moves the reminder on with the payment (W_SendNow)
			}
			return { kind: "sent", txid: "ab".repeat( 32 ) };
		},
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

const BALANCE: balance_t = Test_Balance( { ironwood: { confirmed: 2 * ZATS } } );

/*
==================
Open

The sheet as the dashboard holds it: the draft lives outside
==================
*/
async function Open( balance: balance_t = BALANCE, also: payTo_t[] = [], repeatId: string | null = null, from: pool_t | null = null ) {
	const { UI_SendSheet, EMPTY_DRAFT, Com_DraftFrom } = await import( "./ui_send" );
	const { UI_TipProvider } = await import( "./ui_widgets" );

	const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
	const { useStore } = await import( "./ui_store" );
	useStore.setState( { network: "testnet", wallets: { w1: Test_Summary() } } );

	function Host() {
		const [ draft, setDraft ] = useState( { ...( from ? Com_DraftFrom( from ) : EMPTY_DRAFT ), to: PUBLIC_ADDR, amount: "0.1", also: also, repeatId: repeatId } );
		return (
			<QueryClientProvider client={client}><UI_TipProvider>
				<UI_SendSheet
					open
					onOpenChange={() => {}}
					walletId="w1"
					account={0}
					balance={balance}
					offline={false}
					draft={draft}
					onDraft={setDraft}
					onScan={() => {}}
					onShield={() => {}}
				/>
			</UI_TipProvider></QueryClientProvider>
		);
	}
	render( <Host /> );
	await screen.findByText( T.scan.kinds.transparent.title );		// the address was checked
}

async function Review() {
	fireEvent.click( screen.getByText( T.send.review ) );
	await screen.findByText( T.send.payFrom );
}

beforeEach( () => {
	engine.quoted = [];
	engine.seen = [];
	engine.intents = [];
	engine.open = new Set();
	engine.made = 0;
	engine.sent = 0;
	engine.moveOn = false;
	engine.history = [];
	engine.repeatsDone = [];
	engine.feeNote = null;
	engine.contacts = [];
} );

afterEach( cleanup );

describe( "UI_SendSheet", () => {
	it( "asks the engine for exactly what was typed, with no memo to a public address", async () => {
		await Open();
		await Review();
		expect( engine.quoted ).toEqual( [ { to: PUBLIC_ADDR, zats: 10_000_000, memo: null, from: null, also: [] } ] );
	} );

	// a pool's own Send (UI_PoolSheet's Send from Sapling, Com_DraftFrom): the engine is
	// asked to pay from that pool and no other, the same request the testnet run proved
	it( "asks the engine to pay from the pool it was opened from", async () => {
		await Open( Test_Balance( { ironwood: { confirmed: 2 * ZATS }, sapling: { confirmed: ZATS } } ), [], null, "sapling" );
		await Review();
		expect( engine.quoted ).toEqual( [ { to: PUBLIC_ADDR, zats: 10_000_000, memo: null, from: "sapling", also: [] } ] );
	} );

	it( "reviews the fee, the total and that the address is public, then sends exactly what was reviewed", async () => {
		await Open();
		await Review();

		expect( screen.getByText( T.send.publicWarn ) ).toBeTruthy();
		expect( screen.getByText( T.review.from( "Testnet", "Main", "Savings" ) ) ).toBeTruthy();		// where it moves from, seen
		expect( screen.getByText( T.fee.label ) ).toBeTruthy();
		expect( document.body.textContent ).toContain( "0.1001" );		// amount plus fee

		fireEvent.click( screen.getByText( T.send.action( "0.10" ) ) );
		await screen.findByText( T.send.doneTitle );
		expect( engine.sent ).toBe( 1 );
		expect( engine.seen ).toEqual( [ Quote( engine.quoted[0], FEE ) ] );
		expect( engine.intents ).toEqual( [ "intent-1" ] );		// the quote's own intent, handed back
	} );

	it( "shows new numbers instead of sending them unseen, and sends once they've been seen, under their new intent", async () => {
		await Open();
		await Review();
		engine.moveOn = true;		// a block arrives while the person reads

		fireEvent.click( screen.getByText( T.send.action( "0.10" ) ) );
		await screen.findByText( T.send.changed );
		expect( engine.sent ).toBe( 0 );
		expect( document.body.textContent ).toContain( "0.1002" );		// the new fee is what's on screen now

		fireEvent.click( screen.getByText( T.send.action( "0.10" ) ) );
		await screen.findByText( T.send.doneTitle );
		expect( engine.sent ).toBe( 1 );
		expect( engine.intents ).toEqual( [ "intent-1", "intent-2" ] );		// never the first one twice
		expect( engine.open.size ).toBe( 0 );
	} );

	it( "goes back to editing without asking the engine anything: nothing was kept open", async () => {
		await Open();
		await Review();
		fireEvent.click( screen.getByText( T.send.back ) );
		await screen.findByText( T.send.review );
		expect( engine.quoted.length ).toBe( 1 );
		expect( engine.seen ).toEqual( [] );
	} );

	it( "shows Max as the number it will send, with the fee it leaves out", async () => {
		await Open();
		fireEvent.click( screen.getByText( T.send.max ) );
		await screen.findByText( T.send.maxAfterFee( "Ironwood", "0.0001" ) );
		expect( document.body.textContent ).toContain( "1.9999" );		// 2 less the fee, before review
	} );

	it( "refuses an amount that isn't one, without asking the engine", async () => {
		await Open();
		fireEvent.change( screen.getByPlaceholderText( "0.00" ), { target: { value: "1.123456789" } } );
		expect( screen.getByText( T.send.badAmount ) ).toBeTruthy();
		fireEvent.click( screen.getByText( T.send.review ) );
		await screen.findAllByText( T.send.badAmount );
		expect( engine.quoted ).toEqual( [] );
	} );

	it( "asks which a thousands-or-decimal comma means, and takes the pick", async () => {
		await Open();
		fireEvent.change( screen.getByPlaceholderText( "0.00" ), { target: { value: "1,000" } } );
		expect( screen.getByText( T.send.ambiguousAmount, { exact: false } ) ).toBeTruthy();
		fireEvent.click( screen.getByText( T.send.review ) );
		await screen.findByText( T.send.cantReview );		// Review says why, instead of guessing
		expect( engine.quoted ).toEqual( [] );		// never sent as either

		fireEvent.click( screen.getByRole( "button", { name: "1.000" } ) );
		expect( screen.queryByRole( "button", { name: "1000" } ) ).toBeNull();		// asked and answered
		await Review();
		expect( engine.quoted[0].zats ).toBe( 100_000_000 );		// one, as picked
	} );

	it( "names the contact a look-alike address imitates, on review", async () => {
		engine.contacts = [ { id: "c0", name: "Bob", address: PUBLIC_ADDR.slice( 0, 8 ) + "z".repeat( PUBLIC_ADDR.length - 14 ) + PUBLIC_ADDR.slice( -6 ), kind: "transparent", note: null, lastPaid: null } ];
		await Open();
		await Review();
		expect( await screen.findByText( /looks like Bob's/ ) ).toBeTruthy();
	} );

	it( "says why a fee is high when Rust says it is, and nothing otherwise", async () => {
		await Open();
		await Review();
		expect( screen.queryByText( T.fee.manyCoins( 14 ) ) ).toBeNull();
		cleanup();

		engine.feeNote = { kind: "manyCoins", coins: 14 };
		await Open();
		await Review();
		expect( screen.getByText( T.fee.manyCoins( 14 ) ) ).toBeTruthy();
	} );

	it( "says a payment still pending makes this one a second payment, and only then", async () => {
		const sent = ( state: historyItem_t["state"] ): historyItem_t => Test_Item( {
			txid: "old", time: 0, kind: "sent", amount: ZATS, fee: FEE, state: state, from: [ "ironwood" ], into: [], counterparty: PUBLIC_ADDR,
		} );

		engine.history = [ sent( { kind: "confirmed", height: 1 } ), sent( { kind: "failed" } ) ];
		await Open();
		await Review();
		expect( screen.queryByText( T.send.stillPending ) ).toBeNull();		// settled or failed: nothing waits
		cleanup();

		engine.history = [ sent( { kind: "pending", expiresAt: 140 } ) ];
		await Open();
		await Review();
		expect( await screen.findByText( T.send.stillPending ) ).toBeTruthy();
	} );
} );

/*
==================
TabTo

Tab until el has the focus: a control a keyboard can't reach within a
page's worth of stops fails here
==================
*/
async function TabTo( user: ReturnType< typeof userEvent.setup >, el: HTMLElement ) {
	for ( let i = 0; i < 40 && document.activeElement !== el; i++ ) {
		await user.tab();
	}
	expect( document.activeElement, "reached by Tab" ).toBe( el );
}

describe( "keyboard only", () => {
	// no mouse at all: the amount typed, Review and Send reached by Tab and pressed with Enter
	it( "sends a payment with the keyboard alone", async () => {
		const user = userEvent.setup();
		await Open();

		const amount = screen.getByLabelText( T.send.amount );
		await TabTo( user, amount );
		await user.clear( amount );
		await user.keyboard( "0.2" );

		await TabTo( user, screen.getByRole( "button", { name: T.send.review } ) );
		await user.keyboard( "{Enter}" );
		await screen.findByText( T.send.payFrom );

		await TabTo( user, screen.getByRole( "button", { name: T.send.action( "0.20" ) } ) );
		await user.keyboard( "{Enter}" );
		await screen.findByText( T.send.doneTitle );
		expect( engine.sent ).toBe( 1 );
		expect( engine.quoted[0].zats ).toBe( 20_000_000 );
	} );
} );

describe( "a wallet still catching up", () => {
	// Review pressed before the wallet caught up: it waits, says why, can be backed out of, and
	// asks the engine nothing; then it reviews by itself (ui_sync.tsx). It was an error alert
	it( "waits instead of failing, then reviews by itself", async () => {
		await Open();
		const { useStore } = await import( "./ui_store" );
		const behind = Test_Summary();
		act( () => useStore.setState( { wallets: { w1: { ...behind, progress: { ...behind.progress, complete: false, running: true } } } } ) );
		fireEvent.click( screen.getByText( T.send.review ) );
		expect( await screen.findByText( T.catchUp.title ) ).toBeTruthy();
		expect( screen.getByRole( "button", { name: T.catchUp.later } ) ).toBeTruthy();
		expect( screen.getByRole( "button", { name: T.send.back } ) ).toBeTruthy();
		expect( engine.quoted ).toEqual( [] );

		act( () => useStore.setState( { wallets: { w1: Test_Summary() } } ) );
		expect( await screen.findByText( T.send.payFrom ) ).toBeTruthy();
		expect( engine.quoted.length ).toBe( 1 );
	} );
} );

describe( "money still being checked", () => {
	// the sentence's own words between its two amounts (UI_Slots puts the amounts in)
	const NOW_WORDS = T.checking.sendNowLater.split( /\{\w+\}/ )[1].trim();

	// the engine's spendable, said where the amount is typed: Send never meets a surprise "not enough"
	it( "says how much can be sent now and how much is still being checked", async () => {
		await Open( Test_Balance( { ironwood: { confirmed: 2 * ZATS } }, ZATS / 2 ) );
		expect( screen.getByText( NOW_WORDS, { exact: false } ) ).toBeTruthy();
		expect( document.body.textContent ).toContain( "0.50" );
		expect( document.body.textContent ).toContain( "1.50" );
	} );

	it( "says nothing when everything can be sent", async () => {
		await Open();
		expect( screen.queryByText( NOW_WORDS, { exact: false } ) ).toBeNull();
	} );
} );

describe( "several payments", () => {
	const SECOND = "tmSecondPayeeXXXXXXXXXXXXXXXXXXXXXX";

	// a request for several (Scan): every one reviewed and sent together, the total covering all
	it( "reviews every payment and sends them all at once", async () => {
		await Open( BALANCE, [ { to: SECOND, zats: 5_000_000, memo: null } ] );
		expect( screen.queryByRole( "button", { name: T.send.max } ) ).toBeNull();		// Max is for one person

		await Review();
		expect( screen.getByText( T.send.alsoPays( 1 ) ) ).toBeTruthy();
		expect( screen.getAllByText( SECOND, { exact: false } ).length ).toBeGreaterThan( 0 );
		expect( document.body.textContent ).toContain( "0.1501" );		// 0.10 + 0.05 + the fee

		fireEvent.click( screen.getByText( T.send.action( "0.15" ) ) );
		await screen.findByText( T.send.doneTitle );
		expect( engine.quoted[0].also ).toEqual( [ { to: SECOND, zats: 5_000_000, memo: null } ] );
		expect( engine.sent ).toBe( 1 );
	} );

	it( "can take one out before review, leaving a single payment", async () => {
		await Open( BALANCE, [ { to: SECOND, zats: 5_000_000, memo: null } ] );
		fireEvent.click( screen.getByRole( "button", { name: T.send.removePay } ) );
		await Review();
		expect( screen.queryByText( T.send.alsoPays( 1 ) ) ).toBeNull();
		expect( engine.quoted[0].also ).toEqual( [] );
	} );
} );

describe( "a reminder's payment", () => {
	// paid through Send, reviewed like any payment; then the reminder moves to its next date
	it( "moves the reminder on once the payment is sent, and not before", async () => {
		await Open( BALANCE, [], "rent" );
		await Review();
		expect( engine.repeatsDone ).toEqual( [] );
		fireEvent.click( screen.getByText( T.send.action( "0.10" ) ) );
		await screen.findByText( T.send.doneTitle );
		await vi.waitFor( () => expect( engine.repeatsDone ).toEqual( [ "rent" ] ) );
	} );
} );
