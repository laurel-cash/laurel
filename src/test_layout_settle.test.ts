/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_layout_settle.test.ts -- a layout fault is one the page keeps
// (scripts/layout_settle.mjs): one seen in only one of two measures is a
// moment of the page's drawing, never passed off as none

import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain node module of the check scripts, without types
import { Com_Settled } from "../scripts/layout_settle.mjs";

const OVER = "button.btn.primary.large (Got It) is drawn over span (If the network drops a p)";
const CUT = "span.balance (12.5 ZEC) is cut";

describe( "Com_Settled", () => {
	it( "keeps a fault both measures saw: a real overlap still fails", () => {
		expect( Com_Settled( [ OVER ], [ OVER ] ) ).toEqual( { faults: [ OVER ], unsettled: [] } );
	} );

	it( "calls a fault only the first measure saw unsettled, not an overlap", () => {
		expect( Com_Settled( [ OVER ], [] ) ).toEqual( { faults: [], unsettled: [ OVER ] } );
	} );

	it( "calls a fault only the second measure saw unsettled too", () => {
		expect( Com_Settled( [ CUT ], [ CUT, OVER ] ) ).toEqual( { faults: [ CUT ], unsettled: [ OVER ] } );
	} );

	it( "finds nothing in two clean measures", () => {
		expect( Com_Settled( [], [] ) ).toEqual( { faults: [], unsettled: [] } );
	} );
} );
