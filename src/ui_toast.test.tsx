/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_toast.test.tsx -- news reads as what the engine said it is: arrived,
// went through, or didn't; and a payment between two of the person's
// accounts is two pieces of news, each dismissed on its own

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { paymentEvent_t, priceAlertEvent_t } from "./bindings";

vi.mock( "./bindings", async () => ( {
	commands: {
		sGetF: async () => ( await import( "./test_engine" ) ).Test_Settings(),
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

const TXID = "ab".repeat( 32 );

function News( patch: Partial< paymentEvent_t > ): paymentEvent_t {
	return { walletId: "w", account: 0, accountName: "Main", txid: TXID, kind: "received", amount: 150_000_000, state: { kind: "confirmed", height: 1 }, ...patch };
}

beforeEach( async () => {
	const { useStore } = await import( "./ui_store" );
	useStore.setState( { hideAmounts: false, wallets: {}, news: [] } );
} );

afterEach( cleanup );

async function Show( payments: paymentEvent_t[], alerts: priceAlertEvent_t[] = [] ) {
	const { UI_Toasts } = await import( "./ui_toast" );
	const { QUERY } = await import( "./ui_query" );
	const { useStore } = await import( "./ui_store" );
	QUERY.clear();
	useStore.setState( { news: [ ...payments.map( ( p ) => ( { kind: "payment" as const, payment: p } ) ), ...alerts.map( ( a ) => ( { kind: "price" as const, alert: a } ) ) ] } );
	render( <QueryClientProvider client={QUERY}><UI_Toasts onOpen={() => {}} /></QueryClientProvider> );
}

describe( "UI_Toasts", () => {
	it( "says a payment sent went through, or didn't and the money is back", async () => {
		await Show( [
			News( { txid: "aa".repeat( 32 ), kind: "sent" } ),
			News( { txid: "cc".repeat( 32 ), kind: "sent", state: { kind: "failed" } } ),
		] );
		expect( await screen.findByText( T.toast.wentThrough, { exact: false } ) ).toBeTruthy();
		expect( screen.getByText( T.toast.failed ) ).toBeTruthy();
		expect( screen.getByText( T.toast.failedSub, { exact: false } ) ).toBeTruthy();
	} );

	it( "shows a payment between two accounts twice, and dismisses each alone", async () => {
		await Show( [ News( { kind: "sent", account: 0, accountName: "Main" } ), News( { account: 1, accountName: "Savings" } ) ] );
		expect( ( await screen.findAllByRole( "button", { name: T.common.close } ) ).length ).toBe( 2 );
		fireEvent.click( screen.getAllByRole( "button", { name: T.common.close } )[0] );
		await vi.waitFor( () => expect( screen.getAllByRole( "button", { name: T.common.close } ).length ).toBe( 1 ) );		// once it has animated out
	} );

	// with Laurel in front the system says nothing (w_notice.rs, N_System): the corner does
	it( "says a price alert went off, and the price now", async () => {
		await Show( [], [ { id: "a1", above: true, usd: 60, price: 61.25 } ] );
		const title = await screen.findByText( T.toast.rose( "$60.00" ) );
		expect( title ).toBeTruthy();
		expect( screen.getByText( T.toast.priceNow( "$61.25" ) ) ).toBeTruthy();
	} );
} );
