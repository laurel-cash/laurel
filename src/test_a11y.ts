/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_a11y.ts -- what a screen reader or a keyboard would stumble on, by
// axe-core's rules, for the screen a test has on the page
//
// A button with only an icon and no name, a field without a label, two
// elements with one id: each was once found by hand, one screen at a
// time. These rules find every one of them wherever a test renders.
// Colour contrast is left out: the test dom computes no styles.

import axe from "axe-core";

/*
==================
Com_A11y

Every rule the page breaks, one line each ("rule: the element"), so a
failing test says what to fix; empty when it breaks none
==================
*/
export async function Com_A11y( root: Element = document.body ): Promise< string[] > {
	const result = await axe.run( root, {
		rules: {
			"color-contrast":	{ enabled: false },		// no styles in the test dom
			"region":			{ enabled: false },		// a test renders one piece, not the whole page with its landmarks
		},
	} );
	return result.violations.flatMap( ( v ) => v.nodes.map( ( n ) => `${v.id}: ${n.html.slice( 0, 140 )}` ) );
}
