/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_back.test.tsx -- Android's Back, as a phone means it: it closes what's
// open, then goes up a level, and leaves Laurel only from Home (it once
// left from anywhere, a sheet open or not, and leaving locks)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Test_Constants } from "./test_engine";

vi.mock( "./bindings", async () => ( await import( "./test_engine" ) ).TEST_NULL_BINDINGS );

afterEach( cleanup );

beforeEach( async () => {
	const { useStore } = await import( "./ui_store" );
	useStore.setState( { constants: Test_Constants( { mobile: true } ), page: "home", settingsPane: "general", settingsShown: "list" } );
} );

describe( "Com_Back", () => {
	it( "closes an open sheet first, and stays in Laurel", async () => {
		const { Com_Back } = await import( "./ui_chrome" );
		const { UI_Sheet } = await import( "./ui_widgets" );
		const closed = vi.fn();
		render( <UI_Sheet open={true} onOpenChange={closed} title="A sheet"><p>inside</p></UI_Sheet> );
		expect( screen.getByRole( "dialog" ) ).toBeTruthy();
		expect( Com_Back() ).toBe( true );
		expect( closed ).toHaveBeenCalledWith( false );
	} );

	it( "presses the screen's own Back where there is one (a step, a settings pane)", async () => {
		const { Com_Back } = await import( "./ui_chrome" );
		const back = vi.fn();
		render( <button className="nav-back" onClick={back}>Back</button> );
		expect( Com_Back() ).toBe( true );
		expect( back ).toHaveBeenCalled();
	} );

	it( "goes Home from another page, and leaves only from Home", async () => {
		const { Com_Back } = await import( "./ui_chrome" );
		const { useStore } = await import( "./ui_store" );
		useStore.setState( { page: "history" } );
		expect( Com_Back() ).toBe( true );
		expect( useStore.getState().page ).toBe( "home" );
		expect( Com_Back() ).toBe( false );		// Home, nothing open: Android may leave
	} );
} );
