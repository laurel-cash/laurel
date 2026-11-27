/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_phone_layout.test.ts -- a layout goes by the page's width in its own text
// (usePageLayout's PAGE_LAYOUTS, named on the root), never a px @media: a 678px
// iPad Split View at 175% was laid out as a computer's (11-27)

// @ts-expect-error node's types aren't in the ui's tsconfig; vitest runs this in node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Com_PageLayouts, PAGE_LAYOUTS } from "./ui_hooks";

// read from disk: vitest hands a stylesheet's ?raw import back empty
const css = readFileSync( "src/ui.css", "utf8" ).replace( /\/\*[\s\S]*?\*\//g, "" );		// vitest runs from the root; its rules, not its words about them

describe( "the layout's widths", () => {
	it( "are the page's, by its width in its text, never a px @media", () => {
		expect( css.match( /@media[^{]*\b(min|max)-width/g ) ?? [] ).toEqual( [] );
	} );

	it( "are each one of PAGE_LAYOUTS, the one place a width is written", () => {
		const used = new Set( [ ...css.matchAll( /data-page~="([a-z]+)"/g ) ].map( ( m ) => m[1] ) );
		expect( [ ...used ].sort() ).toEqual( PAGE_LAYOUTS.map( ( [ name ] ) => name ).sort() );
	} );

	it( "lay a 678px iPad Split View at 175% out as a phone, and the 13\" at 100% as a computer", () => {
		expect( Com_PageLayouts( 678 / 1.75 ).split( " " ) ).toContain( "phone" );
		expect( Com_PageLayouts( 1032 ).split( " " ) ).toEqual( [ "roomy", "stacked" ] );
		expect( Com_PageLayouts( 1376 ).split( " " ) ).toEqual( [ "roomy" ] );
	} );

	it( "are each a named container's, in its text, in one syntax", () => {
		const queries = [ ...css.matchAll( /@container ([^{]*)\{/g ) ].map( ( m ) => m[1].trim() );
		expect( queries.length ).toBeGreaterThan( 10 );
		for ( const q of queries ) {
			expect( q, "named, as ( width <= ... ): an unnamed one takes whichever box is nearest" ).toMatch( /^[a-z-]+ \( [^()]*width[^()]* \)$/ );
			expect( q, "a width in em; px only where what's measured keeps its size" ).not.toMatch( /(min|max)-width/ );
		}
		// px: the tab bar (its words keep their size) and the balance card (its leaf, a picture)
		expect( queries.filter( ( q ) => /px/.test( q ) ).map( ( q ) => q.split( " " )[0] ).sort() ).toEqual( [ "card", "phone-nav" ] );
	} );

	it( "style a phone's bar by its layout, not its build: an iPad has a mobile build", () => {
		for ( const rule of [ ".titlebar-back {", ".titlebar-tools {", ".nav-back:not(" ] ) {
			expect( css, rule ).not.toContain( `:root[data-mobile="true"] ${rule}` );
		}
	} );
} );
