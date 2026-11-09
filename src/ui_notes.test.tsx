/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_notes.test.tsx -- the notes the build carries are this version's, an
// update shows them once, a fresh install doesn't, and About lists them

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { APP_VERSION, Com_ReleaseNotes } from "./ui_local";
import { T } from "./ui_text";
import { Com_NoteDate, Com_NotesToShow, RELEASE_NOTES, UI_ReleaseNotesSheet, UI_WhatsNewSheet } from "./ui_notes";

afterEach( cleanup );

describe( "release notes", () => {
	it( "reads the file as written: headings and their changes, not its preface", () => {
		const notes = Com_ReleaseNotes( "# Notes\n\n- not a note\n\n## 0.2.0 · 2026-10-01\n\n- One.\n- Two.\n\n## 0.1.0 · 2026-09-28\n\n- First.\n" );
		expect( notes ).toEqual( [
			{ version: "0.2.0", date: "2026-10-01", items: [ "One.", "Two." ] },
			{ version: "0.1.0", date: "2026-09-28", items: [ "First." ] },
		] );
	} );

	it( "carries notes for the version it is", () => {
		expect( RELEASE_NOTES[0].version ).toBe( APP_VERSION );
		expect( RELEASE_NOTES[0].items.length ).toBeGreaterThan( 0 );
	} );

	it( "shows them once after an update, never on a fresh install", () => {
		expect( Com_NotesToShow( "0.1.0", "0.2.0", false ) ).toBe( "show" );
		expect( Com_NotesToShow( null, "0.2.0", false ) ).toBe( "show" );		// updated from before there were notes
		expect( Com_NotesToShow( null, "0.2.0", true ) ).toBe( "remember" );	// all of it is new
		expect( Com_NotesToShow( "0.2.0", "0.2.0", false ) ).toBe( "none" );
	} );

	it( "lists every version in About, as plain text", () => {
		render( <UI_ReleaseNotesSheet open onOpenChange={() => {}} /> );
		expect( screen.getByText( T.notes.version( RELEASE_NOTES[0].version ) ) ).toBeTruthy();
		expect( screen.getByText( Com_NoteDate( RELEASE_NOTES[0].date ) ) ).toBeTruthy();
		expect( screen.getByText( RELEASE_NOTES[0].items[0] ) ).toBeTruthy();
	} );

	// a day on the calendar: the same day in every time zone, never the one before
	it( "says a note's day as a date, not as the file writes it", () => {
		expect( Com_NoteDate( "2026-09-28" ) ).toBe( new Date( 2026, 8, 28 ).toLocaleString( undefined, { year: "numeric", month: "long", day: "numeric" } ) );
		expect( Com_NoteDate( "2026-09-28" ) ).not.toContain( "2026-09-28" );
	} );

	it( "opens what's new on the sheet itself, not on its button", async () => {
		render( <UI_WhatsNewSheet open onOpenChange={() => {}} /> );
		const dialog = await screen.findByRole( "dialog", { name: T.notes.whatsNew( APP_VERSION ) } );
		expect( document.activeElement ).toBe( dialog );		// no focus ring on Got It before a key is pressed
		expect( screen.getByRole( "button", { name: T.notes.gotIt } ) ).toBeTruthy();
	} );
} );
