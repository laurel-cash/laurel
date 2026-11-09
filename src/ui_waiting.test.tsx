/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_waiting.test.tsx -- a wait never looks hung: the words, then how
// long it has been, ticking, then why it can take a while

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { T } from "./ui_text";
import { UI_Waiting } from "./ui_widgets";

beforeEach( () => {
	vi.useFakeTimers();
} );

afterEach( () => {
	cleanup();
	vi.useRealTimers();
} );

async function Pass( msec: number ) {
	await act( async () => { await vi.advanceTimersByTimeAsync( msec ); } );
}

describe( "UI_Waiting", () => {
	it( "says how long, then why, and never stays still", async () => {
		render( <UI_Waiting text="Getting your address…" /> );
		expect( screen.getByRole( "status" ).textContent ).toBe( "Getting your address…" );

		await Pass( 5000 );
		expect( screen.getByRole( "status" ).textContent ).toContain( T.common.waited( 5 ) );
		expect( screen.queryByText( T.common.stillWorking ) ).toBeNull();

		await Pass( 1000 );
		expect( screen.getByRole( "status" ).textContent ).toContain( T.common.waited( 6 ) );		// ticking: it plainly isn't stuck

		await Pass( 15_000 );
		expect( screen.getByText( T.common.stillWorking ) ).toBeTruthy();
	} );
} );
