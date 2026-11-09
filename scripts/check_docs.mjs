/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_docs.mjs -- every file the docs and comments name exists
//
// A comment sent readers to a ui_test file long after it was gone;
// docs named files that had moved. Words about the code drift when the
// code moves, and a path is the one part of them a script can check. A
// path is either from the repository root (src/ui_main.tsx) or from the
// folder of the file naming it (a crate's clippy.toml names its own
// src/...), or a bare Laurel file name (w_main.rs, ui_send.tsx), looked
// up where Laurel's files live.
//
//   node scripts/check_docs.mjs

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// where words about the code are written
const READ_DIRS		= [ "docs", "src", "src-tauri/src", "scripts" ];
const READ_FILES	= [ "README.md", "vitest.config.ts", "vite.config.ts", "package.json", "src-tauri/Cargo.toml", "src-tauri/clippy.toml", "vendor/zingolib/clippy.toml" ];
const READ_EXT		= /\.(md|ts|tsx|rs|mjs|css|toml|json)$/;

// a full path, and a bare Laurel file name
// (a path starts at a boundary: "src/..." inside "zingolib/src/..." is not a path from the root)
const FULL			= /(?<![\w/.-])((?:src-tauri|src|scripts|docs|vendor|public|zingolib)\/[\w./-]*\w\.(?:tsx?|rs|mjs|md|json|toml|css|html|png|svg|ico))\b/g;
const BARE			= /(?<![\w/.-])((?:ui|w|test)_[a-z0-9_]+\.(?:tsx?|rs))\b/g;
const BARE_HOMES	= [ "src", "src-tauri/src" ];

// files named on purpose though they don't exist here: generated, or someone else's
const ELSEWHERE		= new Set( [ "src-tauri/gen/schemas/desktop-schema.json" ] );

function Files() {
	const out = [ ...READ_FILES.filter( existsSync ) ];
	for ( const dir of READ_DIRS ) {
		for ( const f of readdirSync( dir ) ) {
			const p = join( dir, f ).replaceAll( "\\", "/" );
			if ( statSync( p ).isFile() && READ_EXT.test( f ) && f !== "bindings.ts" && f !== "THIRD_PARTY_NOTICES.md" ) {
				out.push( p );
			}
		}
	}
	return out;
}

let bad = 0;
for ( const file of Files() ) {
	readFileSync( file, "utf8" ).split( "\n" ).forEach( ( line, i ) => {
		for ( const m of line.matchAll( FULL ) ) {
			const path = m[1];
			if ( !ELSEWHERE.has( path ) && !existsSync( path ) && !existsSync( join( dirname( file ), path ) ) ) {
				console.error( `${file}:${i + 1}: names ${path}, which doesn't exist; point it at the file that does` );
				bad++;
			}
		}
		for ( const m of line.matchAll( BARE ) ) {
			const name = m[1];
			if ( !BARE_HOMES.some( ( d ) => existsSync( join( d, name ) ) ) ) {
				console.error( `${file}:${i + 1}: names ${name}, which isn't in ${BARE_HOMES.join( " or " )}` );
				bad++;
			}
		}
	} );
}

if ( bad ) {
	process.exit( 1 );
}
console.log( "check_docs: every file named exists" );
