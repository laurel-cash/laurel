/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_textscale.test.tsx -- the text size is one number: the setting zooms
// the window, and Ctrl +, Ctrl − and Ctrl 0 step through the engine's own
// choices and save them, never past the ends

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import type { appSettings_t } from "./bindings";

const SCALES = [ 100, 115, 130, 150, 175 ];

const engine = vi.hoisted( () => ( {
	scale:	100,
	zooms:	[] as number[],
} ) );

vi.mock( "@tauri-apps/api/webview", () => ( {
	getCurrentWebview: () => ( {
		setZoom: async ( z: number ) => {
			engine.zooms.push( z );
		},
	} ),
} ) );

vi.mock( "./bindings", async () => {
	const settings = async (): Promise< appSettings_t > => ( await import( "./test_engine" ) ).Test_Settings( { textScale: engine.scale } );
	return {
		commands: {
			sGetF: async () => settings(),
			sSetF: async ( s: appSettings_t ) => {
				engine.scale = s.textScale;
				return settings();
			},
		},
		events: ( await import( "./test_engine" ) ).TEST_EVENTS,
	};
} );

beforeEach( () => {
	engine.scale = 115;
	engine.zooms = [];
} );

afterEach( cleanup );

async function Mount() {
	const { useTextScale } = await import( "./ui_hooks" );
	const { QUERY } = await import( "./ui_query" );
	const { useStore } = await import( "./ui_store" );
	const { Test_Constants } = await import( "./test_engine" );
	useStore.setState( { constants: Test_Constants() } );
	QUERY.clear();
	function Scaled() {
		useTextScale( SCALES );
		return null;
	}
	render( <QueryClientProvider client={QUERY}><Scaled /></QueryClientProvider> );
	await vi.waitFor( () => expect( engine.zooms ).toEqual( [ 1.15 ] ) );
}

async function Press( key: string ) {
	await act( async () => {
		fireEvent.keyDown( window, { key, ctrlKey: true } );
	} );
}

describe( "text size", () => {
	it( "zooms the window to the saved size, and the keys step and save", async () => {
		await Mount();
		await Press( "=" );
		await vi.waitFor( () => expect( engine.scale ).toBe( 130 ) );
		await vi.waitFor( () => expect( engine.zooms[engine.zooms.length - 1] ).toBe( 1.3 ) );
		await Press( "-" );
		await vi.waitFor( () => expect( engine.scale ).toBe( 115 ) );
		await Press( "0" );
		await vi.waitFor( () => expect( engine.scale ).toBe( 100 ) );
	} );

	it( "stops at the ends instead of going past the choices", async () => {
		await Mount();
		await Press( "0" );
		await vi.waitFor( () => expect( engine.scale ).toBe( 100 ) );
		await Press( "-" );
		await new Promise( ( r ) => setTimeout( r, 50 ) );
		expect( engine.scale ).toBe( 100 );
	} );
} );
