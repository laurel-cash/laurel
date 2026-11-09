/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_a11y.test.tsx -- the accessibility check can fail: a check that
// never fails proves nothing (a first probe of it printed to a console
// the tests don't show, and looked like a pass)

import { expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Com_A11y } from "./test_a11y";

it( "names a button with no name, a field with no label and an image with no text", async () => {
	// eslint-disable-next-line jsx-a11y/alt-text -- the violations are the point
	render( <div><button><svg /></button><input id="x" /><img src="a.png" /></div> );
	expect( ( await Com_A11y() ).map( ( l ) => l.split( ":" )[0] ).sort() ).toEqual( [ "button-name", "image-alt", "label" ] );
	document.body.innerHTML = "";		// what's left isn't checked again after this test
} );
