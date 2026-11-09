/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_eol.mjs -- the files as they are here, byte for byte, as git keeps them
//
// .gitattributes keeps every text file LF, but a machine with
// core.autocrlf, or an editor, can leave the working copy CRLF: git hides
// it, and every check then reads other bytes than the ones committed. It
// cost a day's false alarm: jscpd strips comments by a pattern CRLF
// defeats, and "found" a clone the committed file doesn't have. A file
// here that differs from its committed endings fails.
//
//   node scripts/check_eol.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// the engine's copy is checked by engine.mjs, which reads either ending; a batch file stays CRLF
const SKIP = [ /^vendor\//, /\.bat$/ ];

const wrong = execFileSync( "git", [ "ls-files", "--eol" ], { encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true } )
	.split( "\n" )
	.map( ( l ) => l.split( /\s+/ ) )
	.filter( ( f ) => f[0] === "i/lf" && f[1] === "w/crlf" )
	.map( ( f ) => f[f.length - 1] )
	.filter( ( path ) => !SKIP.some( ( r ) => r.test( path ) ) );

// text encoded twice (UTF-8 read as Windows-1252 and saved again): an ellipsis
// showed as three letters of garbage in two zcashd errors, and a no-break space as
// a capital A with a circumflex in a hint, all on screen. The marks, as escapes so
// this file doesn't carry them: U+00E2 U+20AC, or U+00C2/U+00C3 before U+0080..U+00BF
const TWICE = new RegExp( "\\u00e2\\u20ac|[\\u00c2\\u00c3][\\u0080-\\u00bf]" );
const texts = execFileSync( "git", [ "ls-files", "src", "src-tauri/src", "src-tauri/engine", "scripts", "docs", "mock.html" ], { encoding: "utf8", windowsHide: true } )
	.split( "\n" )
	.filter( ( p ) => /\.(ts|tsx|rs|mjs|md|html|css|toml|json)$/.test( p ) );
const garbled = [];
for ( const path of texts ) {
	readFileSync( path, "utf8" ).split( "\n" ).forEach( ( line, i ) => {
		if ( TWICE.test( line ) ) {
			garbled.push( `${path}:${i + 1}` );
		}
	} );
}

if ( wrong.length || garbled.length ) {
	for ( const path of wrong ) {
		console.error( `check_eol: ${path} is CRLF here but LF in git: the checks read other bytes than are committed. Make it LF (git add --renormalize won't touch the working copy)` );
	}
	for ( const at of garbled ) {
		console.error( `check_eol: ${at}: text encoded twice (a character's bytes read as other characters): it shows as garbage on screen. Write the character again, or its \\u escape` );
	}
	process.exit( 1 );
}
console.log( `check_eol: every file here has the endings git keeps; ${texts.length} text files, none encoded twice` );
