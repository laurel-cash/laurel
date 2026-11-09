/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_split.test.tsx -- the figures under the balance: private and public
// always (none public is worth seeing), pending only while something is

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { T } from "./ui_text";
import { UI_Split } from "./ui_home";
import { UI_TipProvider } from "./ui_widgets";
import { Test_Balance } from "./test_engine";

afterEach( cleanup );

const Z = 100_000_000;

function Show( balance: Parameters< typeof UI_Split >[0]["balance"], synced = true ) {
	render( <UI_TipProvider><UI_Split balance={balance} synced={synced} /></UI_TipProvider> );
}

describe( "the balance's figures", () => {
	it( "leave pending out when nothing is arriving", () => {
		Show( Test_Balance( { ironwood: { confirmed: 2 * Z } } ) );
		expect( screen.getByText( T.card.private ) ).toBeTruthy();
		expect( screen.getByText( T.card.public ) ).toBeTruthy();		// 0 public is a fact worth seeing
		expect( screen.queryByText( T.card.pending ) ).toBeNull();
	} );

	it( "show pending while money is arriving, in any pool", () => {
		Show( Test_Balance( { ironwood: { confirmed: 2 * Z }, transparent: { pending: Z / 2 } } ) );
		expect( screen.getByText( T.card.pending ) ).toBeTruthy();
	} );

	it( "say money still being checked may change until the sync reaches today", () => {
		// a restore found 39.96 TAZ before the payments that spent part of it (docs/ENGINE.md)
		const balance = Test_Balance( { ironwood: { confirmed: 2 * Z } }, Z );
		Show( balance, false );
		expect( screen.getByText( ( _, el ) => el?.className === "split-checking" && !!el.textContent?.includes( "may change" ) ) ).toBeTruthy();
		cleanup();
		Show( balance, true );
		expect( screen.getByText( ( _, el ) => el?.className === "split-checking" && !!el.textContent?.includes( "can be sent in a moment" ) ) ).toBeTruthy();
	} );

	it( "show no pending before the balance is known", () => {
		Show( undefined );
		expect( screen.queryByText( T.card.pending ) ).toBeNull();
	} );
} );
