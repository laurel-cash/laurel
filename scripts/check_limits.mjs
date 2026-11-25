/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_limits.mjs -- how long each of the gate's steps (check.mjs) may run
// before it is stopped and failed

// warm, every step takes under 30 seconds; cold, the builds take minutes
export const STEP_LIMIT_SECS = { warm: 60, cold: 900 };

// a step that takes longer than the others even warm has its own deadline, never shorter
// than theirs: layout draws every screen in Edge, in two languages and at every width,
// and took 70-95 s warm on the laptop (T-053, 2026-11-08), so a warm gate always failed it
export const STEP_OWN_SECS = { layout: 180 };

/*
==================
Com_StepLimit

A step's deadline in seconds. forced: CHECK_STEP_SECS, set only to test
the deadline itself, is every step's.
==================
*/
export function Com_StepLimit( name, cold, forced ) {
	if ( forced > 0 ) {
		return forced;
	}
	const all = cold ? STEP_LIMIT_SECS.cold : STEP_LIMIT_SECS.warm;
	return Math.max( all, STEP_OWN_SECS[name] ?? 0 );
}
