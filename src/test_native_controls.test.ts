/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_native_controls.test.ts -- the web view's own controls stay out of
// Laurel's fields: on Windows, WebView2 drew a second eye beside Laurel's
// show/hide on every password field (seen 2026-11-17, the v1 build)
// @ts-expect-error node's types aren't in the ui's tsconfig; vitest runs this in node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// read from disk: vitest hands a stylesheet's ?raw import back empty
const css = readFileSync( "src/ui.css", "utf8" );		// vitest runs from the root

describe( "the web view's own field controls", () => {
	it( "hides WebView2's password eye and clear button", () => {
		const rule = /input::-ms-reveal\s*,\s*input::-ms-clear\s*\{\s*display:\s*none;?\s*\}/;
		expect( rule.test( css ), "ui.css lost the rule that hides WebView2's own eye" ).toBe( true );
	} );
} );
