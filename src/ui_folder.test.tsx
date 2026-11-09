/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_folder.test.tsx -- Settings > Sync: starting shows the code once and
// never without a folder, joining says when the code opened nothing, and a
// running sync lists its computers, the unreadable ones as such

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { T } from "./ui_text";
import type { syncStatus_t } from "./bindings";

const OFF: syncStatus_t = { on: false, folder: null, lastSync: null, computers: [], skipped: 0, problem: null };
const CODE = "ABCD-EFGH-IJKL-MNOP";

const engine = vi.hoisted( () => ( {
	status:		null as unknown as syncStatus_t,
	started:	[] as string[],
	joined:		null as unknown as syncStatus_t,
} ) );

vi.mock( "./bindings", async () => ( {
	commands: {
		fStatusF: async () => engine.status,
		fSyncF: async () => engine.status,
		fPickFolderF: async () => ( { path: "D:\\OneDrive\\Laurel", name: "D:\\OneDrive\\Laurel" } ),
		fStartF: async ( folder: string ) => {
			engine.started.push( folder );
			return CODE;
		},
		fJoinF: async () => engine.joined,
		fStopF: async () => null,
		fForgetF: async () => null,
	},
	events: ( await import( "./test_engine" ) ).TEST_EVENTS,
} ) );

beforeEach( () => {
	engine.status = OFF;
	engine.started = [];
} );

afterEach( cleanup );

async function Open() {
	const { UI_FolderSection } = await import( "./ui_folder" );
	const { UI_TipProvider } = await import( "./ui_widgets" );
	const { QUERY } = await import( "./ui_query" );
	QUERY.clear();
	render( <QueryClientProvider client={QUERY}><UI_TipProvider><UI_FolderSection /></UI_TipProvider></QueryClientProvider> );
}

describe( "UI_FolderSection", () => {
	it( "starts only with a folder, and shows the code once", async () => {
		await Open();
		fireEvent.click( await screen.findByRole( "button", { name: T.folder.startButton } ) );
		fireEvent.click( screen.getByRole( "button", { name: T.folder.start } ) );
		expect( screen.getByText( T.folder.needFolder ) ).toBeTruthy();		// never a dead button
		expect( engine.started ).toEqual( [] );

		fireEvent.click( screen.getByRole( "button", { name: T.folder.choose } ) );
		expect( await screen.findByText( "D:\\OneDrive\\Laurel" ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( "button", { name: T.folder.start } ) );
		expect( await screen.findByText( CODE ) ).toBeTruthy();
		expect( screen.getByText( T.folder.codeWarn ) ).toBeTruthy();
		expect( engine.started ).toEqual( [ "D:\\OneDrive\\Laurel" ] );
	} );

	it( "says when a joined code opened no other computer's file", async () => {
		engine.joined = { ...OFF, on: true, folder: "D:\\x", computers: [ { device: "me", name: "Desk", me: true, readable: true }, { device: "b", name: "", me: false, readable: false } ] };
		await Open();
		fireEvent.click( await screen.findByRole( "button", { name: T.folder.joinButton } ) );
		fireEvent.click( screen.getByRole( "button", { name: T.folder.choose } ) );
		await screen.findByText( "D:\\OneDrive\\Laurel" );
		fireEvent.click( screen.getByRole( "button", { name: T.folder.join } ) );
		expect( screen.getByText( T.folder.needCode ) ).toBeTruthy();

		fireEvent.change( screen.getByLabelText( T.folder.code ), { target: { value: "abcd efgh" } } );
		fireEvent.click( screen.getByRole( "button", { name: T.folder.join } ) );
		expect( await screen.findByText( T.folder.joinedNone ) ).toBeTruthy();
	} );

	it( "lists the computers, an unreadable one as such, and why a sync stopped", async () => {
		engine.status = {
			on: true, folder: "D:\\OneDrive\\Laurel", lastSync: Date.now() / 1000 - 60, skipped: 2,
			computers: [ { device: "a", name: "Desk", me: true, readable: true }, { device: "b", name: "Laptop", me: false, readable: false } ],
			problem: { message: T.folder.problem + " detail", detail: null, retry: false },
		};
		await Open();
		expect( await screen.findByText( `Desk · ${T.folder.thisComputer}` ) ).toBeTruthy();
		expect( screen.getByText( T.folder.unreadable ) ).toBeTruthy();
		expect( screen.getByText( T.folder.skipped( 2 ) ) ).toBeTruthy();
		expect( screen.getByText( T.folder.problem ) ).toBeTruthy();
		expect( screen.getAllByRole( "button", { name: T.folder.forget } ).length ).toBe( 1 );		// not this computer
	} );
} );
