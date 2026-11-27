/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_frame.mjs -- a phone's frame is sized in one place: ui.css's frame
// block (A PHONE'S FRAME, in :root) names the safe areas and the bars' sizes,
// and every other rule takes them from there. Patched one number at a time,
// the bars' spacing went back and forth across builds (11-26/27)
//
//   node scripts/check_frame.mjs

import { readFileSync } from "node:fs";

const CSS = readFileSync( "src/ui.css", "utf8" );
const START = CSS.indexOf( "A PHONE'S FRAME" );
const END = CSS.indexOf( "--frame-tool:", START );
// the bars' rules: the account, the tabs, the title bar's own (Back, the screen's name,
// the lock), and a sheet's Back. Their words keep their size at any text size, so never px (text_scale.mjs grows
// px); Back's 17px grew to 30 at 175% while only the account's was looked at (11-27)
const BARS = /^[^{}]*(\.sidebar \.(switcher|nav)|\.titlebar-(back|title|tools|btn)|\.sheet-back)[^{]*\{[^}]*\}/gm;

let bad = 0;
const Say = ( text ) => { console.error( `check_frame: ${text}` ); bad++; };
const Line = ( at ) => CSS.slice( 0, at ).split( "\n" ).length;

if ( START < 0 || END < 0 ) {
	Say( "ui.css has no frame block (A PHONE'S FRAME ... --frame-tool)" );
} else {
	// the device's own lengths, read once: elsewhere a rule uses --safe-top / --safe-bottom
	for ( const m of CSS.matchAll( /env\(/g ) ) {
		if ( m.index < START || m.index > END ) Say( `src/ui.css:${Line( m.index )}: env() outside the frame block; use --safe-top / --safe-bottom` );
	}
	for ( const m of CSS.matchAll( BARS ) ) {
		for ( const f of m[0].matchAll( /font-size:\s*([^;]+);/g ) ) {
			if ( !/^var\( --frame-/.test( f[1].trim() ) ) Say( `src/ui.css:${Line( m.index )}: a bar's words are ${f[1].trim()}; use the frame's --frame-* (they keep their size)` );
		}
	}
}
if ( bad ) {
	process.exit( 1 );
}
console.log( "check_frame: the phone's frame is sized in one place, and its bars' words keep their size" );
