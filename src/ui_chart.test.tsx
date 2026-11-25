/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_chart.test.tsx -- a range starts with what was already held, in
// all and in each pool; by pool, the layers are the pools that held
// something in the range, Ironwood at the base; the axis in round amounts

import { describe, expect, it } from "vitest";

import type { balancePoint_t, poolZats_t } from "./bindings";
import { Com_AxisZec, Com_Layers, Com_Plot, Com_Ticks } from "./ui_chart";

const DAY = 86400;
const NOW = 1_000 * DAY;
const pools = ( p: Partial< poolZats_t > ): poolZats_t => ( { ironwood: 0, orchard: 0, sapling: 0, transparent: 0, ...p } );
const point = ( time: number, p: Partial< poolZats_t > ): balancePoint_t => {
	const split = pools( p );
	return { time: time, zats: split.ironwood + split.orchard + split.sapling + split.transparent, pools: split };
};

describe( "the balance chart", () => {
	// a month ago there was Sapling money; it moved to Ironwood inside the month
	const history = [
		point( NOW - 60 * DAY, { sapling: 500 } ),
		point( NOW - 10 * DAY, { ironwood: 490 } ),
	];

	it( "starts a range with what was held then, split as it was", () => {
		const plot = Com_Plot( history, "month", NOW );
		expect( plot.steps[0] ).toEqual( { time: NOW - 30 * DAY, zats: 500, pools: pools( { sapling: 500 } ) } );
		expect( plot.steps[1].pools ).toEqual( pools( { ironwood: 490 } ) );
	} );

	it( "stacks the pools that held something in the range, Ironwood first", () => {
		expect( Com_Layers( Com_Plot( history, "month", NOW ) ).map( ( l ) => l.pool ) ).toEqual( [ "ironwood", "sapling" ] );
		// a week: the Sapling money was gone before it began, so no Sapling layer
		expect( Com_Layers( Com_Plot( history, "week", NOW ) ).map( ( l ) => l.pool ) ).toEqual( [ "ironwood" ] );
	} );

	it( "stacks nothing before there is any money", () => {
		expect( Com_Layers( Com_Plot( [], "month", NOW ) ) ).toEqual( [] );
	} );

	// round amounts on the axis, never thirds of the top
	it( "draws its grid at round amounts under the top", () => {
		const ZEC = 100_000_000;
		expect( Com_Ticks( 12.85 * ZEC, 3 ) ).toEqual( [ 5 * ZEC, 10 * ZEC ] );
		expect( Com_Ticks( 3 * ZEC, 3 ) ).toEqual( [ 1 * ZEC, 2 * ZEC, 3 * ZEC ] );
		expect( Com_Ticks( 0.7 * ZEC, 3 ) ).toEqual( [ 0.25 * ZEC, 0.5 * ZEC ] );
		expect( Com_Ticks( 2, 3 ) ).toEqual( [ 1, 2 ] );		// never a fraction of a zatoshi
	} );

	// gate E: a 0.0015 ZEC wallet's axis read 0.000, 0.001, 0.001
	it( "labels each line with the decimals its step needs, so no two read alike", () => {
		const ZEC = 100_000_000;
		const Labels = ( max: number ) => { const g = Com_Ticks( max, 3 ); return g.map( ( z ) => Com_AxisZec( z, g[0] ) ); };
		const small = Labels( 0.0015 * ZEC );
		expect( new Set( small ).size ).toBe( small.length );
		expect( small ).toEqual( [ "0.0005", "0.0010", "0.0015" ] );
		expect( Labels( 3 * ZEC ) ).toEqual( [ "1.00", "2.00", "3.00" ] );
		expect( Labels( 0.7 * ZEC ) ).toEqual( [ "0.25", "0.50" ] );
		expect( Labels( 750 * ZEC ) ).toEqual( [ "250", "500", "750" ] );
	} );
} );
