/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_textscale_css.test.ts -- an iPhone's text size reaches every font size
// ui.css writes in px (scripts/text_scale.mjs, run by vite.config.ts), and nothing else

import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain node module of the build, without types
import { Com_TextScaled } from "../scripts/text_scale.mjs";

describe( "laurel-text-scale", () => {
	it( "scales a font size in px, and the smallest one", () => {
		expect( Com_TextScaled( "13px" ) ).toBe( "calc( 13px * var( --text-scale, 1 ) )" );
		expect( Com_TextScaled( "12.5px" ) ).toBe( "calc( 12.5px * var( --text-scale, 1 ) )" );
		expect( Com_TextScaled( "var( --text-min )" ) ).toBe( "calc( var( --text-min ) * var( --text-scale, 1 ) )" );
	} );

	it( "leaves what already follows the text (em, %) or the screen (clamp of cqw) as it is", () => {
		for ( const v of [ "0.42em", "inherit", "100%", "clamp( 20px, 16cqw, 32px )", "max( var( --text-min ), 0.42em )" ] ) {
			expect( Com_TextScaled( v ) ).toBe( v );
		}
	} );
} );
