/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_crash.test.tsx -- a screen that throws while drawing never leaves a
// blank window: it says so, and draws again when asked

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { T } from "./ui_text";
import { UI_ErrorBoundary } from "./ui_main";

vi.mock( "./bindings", async () => ( {
	commands: {},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

afterEach( cleanup );

let broken = true;
function UI_Flaky() {
	if ( broken ) {
		throw new Error( "Cannot read properties of null (reading 'kind')" );
	}
	return <p>Drawn</p>;
}

it( "shows what happened instead of a blank window, and draws again", () => {
	vi.spyOn( console, "error" ).mockImplementation( () => {} );		// React reports the throw too
	render( <UI_ErrorBoundary><UI_Flaky /></UI_ErrorBoundary> );
	expect( screen.getByText( T.chrome.crash ) ).toBeTruthy();

	broken = false;
	fireEvent.click( screen.getByRole( "button", { name: T.chrome.crashRetry } ) );
	expect( screen.getByText( "Drawn" ) ).toBeTruthy();
} );
