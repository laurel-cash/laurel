/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// layout_settle.mjs -- a layout fault is one the page still has a moment later
//
// A busy machine once caught the What's New sheet mid-draw at 175% on a phone:
// "Got It" over a line of the notes, in three runs of four, and never in a
// settled page (2026-11-07). check_layout.mjs measures a size again 500 ms on
// when the first measure finds faults; a fault in both is the page's, one in
// only one of them a moment of its drawing.

export const SETTLE_AGAIN_MS = 500;

// the faults of two measures of one size: those in both, and those in only one
export function Com_Settled( first, second ) {
	const again = new Set( second );
	const once = new Set( first );
	return {
		faults:		first.filter( ( f ) => again.has( f ) ),
		unsettled:	[ ...first.filter( ( f ) => !again.has( f ) ), ...second.filter( ( f ) => !once.has( f ) ) ],
	};
}
