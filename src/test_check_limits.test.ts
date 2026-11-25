/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_check_limits.test.ts -- T-053: the gate's deadlines (check_limits.mjs).
// Layout takes longer than 60 s warm on a slower computer, and a warm gate
// then always failed it; it has its own, and no step's is shorter than all's.

import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain node module of the gate, without types
import { Com_StepLimit, STEP_LIMIT_SECS, STEP_OWN_SECS } from "../scripts/check_limits.mjs";

describe( "the gate's deadlines", () => {
	it( "gives layout its own, warm, past what it took on the laptop", () => {
		expect( Com_StepLimit( "layout", false, 0 ) ).toBeGreaterThanOrEqual( 95 * 1.5 );
		expect( Com_StepLimit( "lint", false, 0 ) ).toBe( STEP_LIMIT_SECS.warm );
	} );

	it( "never shortens a step below every step's, warm or cold", () => {
		for ( const name of Object.keys( STEP_OWN_SECS ) ) {
			expect( Com_StepLimit( name, false, 0 ) ).toBeGreaterThanOrEqual( STEP_LIMIT_SECS.warm );
			expect( Com_StepLimit( name, true, 0 ) ).toBeGreaterThanOrEqual( STEP_LIMIT_SECS.cold );
		}
		expect( Com_StepLimit( "test", true, 0 ) ).toBe( STEP_LIMIT_SECS.cold );
	} );

	it( "uses the forced deadline for every step, to test the deadline itself", () => {
		expect( Com_StepLimit( "layout", false, 1 ) ).toBe( 1 );
		expect( Com_StepLimit( "test", true, 1 ) ).toBe( 1 );
	} );
} );
