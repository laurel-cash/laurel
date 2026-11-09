/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_loads.mjs -- loads of engine data are keyed queries, never actions
//
// useAction drops a request made while another runs (right for a button,
// wrong for data): a slow answer for account A once landed on screen after
// switching to account B. The shape of that bug is an action that puts an
// engine answer into component state: set...( await commands.... ). Such
// loads must be queries (src/ui_query.ts), keyed by what the data belongs
// to. An action that reads something the person just gave it (not wallet
// data) may say so with a comment on the line above:  // action, not a load
//
//   node scripts/check_loads.mjs

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC		= "src";
const LOAD		= /useAction\(\s*async[^]*?set[A-Z]\w*\(\s*await\s+commands\./;
const EXEMPT	= "// action, not a load";

let bad = 0;
for ( const file of readdirSync( SRC ).filter( ( f ) => f.endsWith( ".tsx" ) && !f.includes( ".test." ) ) ) {
	const lines = readFileSync( join( SRC, file ), "utf8" ).split( "\n" );
	lines.forEach( ( line, i ) => {
		if ( !line.includes( "useAction(" ) ) {
			return;
		}
		// the action's own body: up to its closing "} );"
		let end = i;
		while ( end < lines.length - 1 && !/^\s*\}\s*\);/.test( lines[end] ) && !/\)\s*\);\s*$/.test( lines[end] ) ) {
			end++;
		}
		let body = lines.slice( i, end + 1 ).join( "\n" );

		// an action handed a named function is that function's body: useAction( Fetch )
		// once loaded a phrase into state where this check never looked
		const named = /useAction\(\s*([A-Z]\w*)\s*\)/.exec( line );
		if ( named ) {
			const start = lines.findIndex( ( l ) => new RegExp( `^\\s*(async\\s+)?function\\s+${named[1]}\\b` ).test( l ) );
			const stop = lines.findIndex( ( l, j ) => j > start && /^\t}$/.test( l ) );
			body = start < 0 ? "" : "useAction( async " + lines.slice( start, stop + 1 ).join( "\n" );
		}
		if ( LOAD.test( body ) && !( lines[i - 1] ?? "" ).includes( EXEMPT ) ) {
			console.error( `${file}:${i + 1}: loads engine data in an action; make it a query keyed by what it belongs to (src/ui_query.ts)` );
			bad++;
		}
	} );
}

if ( bad ) {
	process.exit( 1 );
}
console.log( "check_loads: every load is a query" );
