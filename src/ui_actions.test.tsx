/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_actions.test.tsx -- Home's quick actions say the open network's coin
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { T } from "./ui_text";
import { UI_Actions } from "./ui_home";
import { useStore } from "./ui_store";

afterEach( cleanup );

describe( "UI_Actions", () => {
	// the store starts on testnet and learns the network after this file has loaded:
	// a hint read as the file loaded said TAZ on mainnet
	it( "names the coin of the network open when drawn", () => {
		useStore.setState( { network: "mainnet" } );
		render( <UI_Actions onSheet={() => {}} split={undefined} /> );
		expect( screen.getByText( "Add ZEC" ) ).toBeTruthy();
		cleanup();
		useStore.setState( { network: "testnet" } );
		render( <UI_Actions onSheet={() => {}} split={undefined} /> );
		expect( screen.getByText( T.actions.fundHintTest ) ).toBeTruthy();
	} );
} );
