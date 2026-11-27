/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_text_room.mjs -- a box with words grows with them. On an iPhone every
// px font size grows with the text size (text_scale.mjs), so a rule that
// sizes words in px and fixes the box's height in px draws them out of it
// at 175% (Settings' rows, the filter chips, the sync pill, 11-27). Such a
// box takes min-height instead; a badge that keeps its shape (a round count,
// initials) says so with line-height: 1, its glyph fitting it at any size.
//
//   node scripts/check_text_room.mjs

import { readFileSync } from "node:fs";

const CSS = readFileSync( "src/ui.css", "utf8" );
const Line = ( at ) => CSS.slice( 0, at ).split( "\n" ).length;

let bad = 0;
for ( const m of CSS.matchAll( /([^{}]+)\{([^{}]*)\}/g ) ) {
	const body = m[2].replace( /\/\*[\s\S]*?\*\//g, "" );
	if ( !/font-size:\s*[\d.]+px/.test( body ) || !/(^|[\s;])height:\s*[\d.]+px/.test( body ) || /line-height:\s*1\s*;/.test( body ) ) {
		continue;
	}
	const sel = m[1].replace( /\/\*[\s\S]*?\*\//g, "" ).trim().split( "\n" ).pop().trim();
	console.error( `check_text_room: src/ui.css:${Line( m.index + m[1].length )}: ${sel} holds px words in a fixed px height; use min-height (or line-height: 1 for a badge's shape)` );
	bad++;
}
if ( bad ) {
	process.exit( 1 );
}
console.log( "check_text_room: every box with words grows with them, or is a badge that keeps its shape" );
