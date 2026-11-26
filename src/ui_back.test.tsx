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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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

// an iPhone has no Back key: the way back is top left, as its own apps have it
describe( "a phone's Back on screen", () => {
	it( "shows the screen's own Back top left, with its words, and presses it", async () => {
		const { UI_TitleBar } = await import( "./ui_chrome" );
		const back = vi.fn();
		render( <><UI_TitleBar /><button className="nav-back" onClick={back}>Settings</button></> );
		await act( async () => {} );
		const bar = document.querySelector( ".titlebar .titlebar-back" ) as HTMLButtonElement;
		expect( bar.textContent ).toBe( "Settings" );
		expect( document.documentElement.dataset.back ).toBe( "true" );
		fireEvent.click( bar );
		expect( back ).toHaveBeenCalledTimes( 1 );
	} );

	it( "isn't there on a tab's own screen, where there's nowhere back to go", async () => {
		const { UI_TitleBar } = await import( "./ui_chrome" );
		render( <UI_TitleBar /> );
		await act( async () => {} );
		expect( document.querySelector( ".titlebar-back" ) ).toBeNull();
		expect( document.documentElement.dataset.back ).toBe( "false" );
	} );

	it( "follows the screen's Back: gone when it goes, greyed while it is", async () => {
		const { UI_TitleBar } = await import( "./ui_chrome" );
		const view = render( <><UI_TitleBar /><button className="nav-back" disabled>Back</button></> );
		await act( async () => {} );
		expect( ( document.querySelector( ".titlebar-back" ) as HTMLButtonElement ).disabled ).toBe( true );
		view.rerender( <UI_TitleBar /> );
		await act( async () => {} );
		expect( document.querySelector( ".titlebar-back" ) ).toBeNull();
	} );

	it( "puts Back at the top of a sheet, which closes it, unless it's busy", async () => {
		const { UI_Sheet } = await import( "./ui_widgets" );
		const closed = vi.fn();
		const view = render( <UI_Sheet open={true} onOpenChange={closed} title="What's New"><p>notes</p></UI_Sheet> );
		const top = document.querySelector( ".sheet > .sheet-back" ) as HTMLButtonElement;
		expect( top.textContent ).toBe( "Back" );
		expect( top ).toBe( document.querySelector( ".sheet" )?.firstElementChild );
		fireEvent.click( top );
		expect( closed ).toHaveBeenCalledWith( false );
		view.rerender( <UI_Sheet open={true} onOpenChange={closed} title="What's New" busy><p>notes</p></UI_Sheet> );
		expect( ( document.querySelector( ".sheet-back" ) as HTMLButtonElement ).disabled ).toBe( true );
	} );

	it( "leaves a computer's sheets as they were", async () => {
		const { useStore } = await import( "./ui_store" );
		const { UI_Sheet } = await import( "./ui_widgets" );
		useStore.setState( { constants: Test_Constants( { mobile: false } ) } );
		render( <UI_Sheet open={true} onOpenChange={() => {}} title="What's New"><p>notes</p></UI_Sheet> );
		expect( document.querySelector( ".sheet-back" ) ).toBeNull();
	} );
} );
