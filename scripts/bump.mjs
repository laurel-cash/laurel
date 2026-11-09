/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// bump.mjs -- Laurel's next version, everywhere it's written, with its notes
//
// package.json (the app, and Android's versionCode: 0.1.5 is 1005),
// package-lock.json, src-tauri/Cargo.toml and Cargo.lock (the engine's
// requests), and a new heading in docs/RELEASE-NOTES.md, dated today.
// Each was once bumped by hand, and one missed would ship two versions.
//
//   node scripts/bump.mjs 0.1.5 "One plain sentence per change." ["Another."]

import { readFileSync, writeFileSync } from "node:fs";

const [ version, ...notes ] = process.argv.slice( 2 );

function Die( why ) {
	console.error( `bump: ${why}` );
	process.exit( 1 );
}

// a.b.c as numbers, to compare
function Parts( v ) {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec( v ?? "" );
	return m ? m.slice( 1 ).map( Number ) : null;
}

const pkg = JSON.parse( readFileSync( "package.json", "utf8" ) );
const now = Parts( pkg.version );
const next = Parts( version );
if ( !next ) {
	Die( `give the new version as a.b.c, then its notes (now ${pkg.version})` );
}
// the first part that differs decides
const differs = next.findIndex( ( n, i ) => n !== now[i] );
if ( differs < 0 || next[differs] < now[differs] ) {
	Die( `${version} isn't after ${pkg.version}: Play refuses a version code it has had` );
}
if ( !notes.length || notes.some( ( n ) => !/^[A-Z].*\.$/.test( n ) || /\n/.test( n ) ) ) {
	Die( "say what changed, as plain sentences (a capital, a full stop), one argument each: the app shows them after the update" );
}

// the JSON files as npm writes them: two spaces, a newline at the end
function Json( path, change ) {
	const json = JSON.parse( readFileSync( path, "utf8" ) );
	change( json );
	writeFileSync( path, JSON.stringify( json, null, 2 ) + "\n" );
}
Json( "package.json", ( j ) => { j.version = version; } );
Json( "package-lock.json", ( j ) => { j.version = version; j.packages[""].version = version; } );

// the [package] version, the first one in the file
const toml = readFileSync( "src-tauri/Cargo.toml", "utf8" );
const tomlNext = toml.replace( /^version = "[^"]+"$/m, `version = "${version}"` );
if ( tomlNext === toml && !toml.includes( `version = "${version}"` ) ) {
	Die( "src-tauri/Cargo.toml has no version line" );
}
writeFileSync( "src-tauri/Cargo.toml", tomlNext );

const lock = readFileSync( "src-tauri/Cargo.lock", "utf8" );
const lockNext = lock.replace( /(\[\[package\]\]\r?\nname = "laurel"\r?\nversion = )"[^"]+"/, `$1"${version}"` );
if ( lockNext === lock ) {
	Die( "src-tauri/Cargo.lock has no laurel package" );
}
writeFileSync( "src-tauri/Cargo.lock", lockNext );

// the newest notes first, under the first version heading
const NOTES = "docs/RELEASE-NOTES.md";
const text = readFileSync( NOTES, "utf8" );
const top = text.indexOf( "\n## " ) + 1;
if ( top === 0 ) {
	Die( `${NOTES} has no version heading to go above` );
}
const today = new Date().toLocaleDateString( "sv-SE" );		// yyyy-mm-dd, on this machine's clock
writeFileSync( NOTES, text.slice( 0, top ) + `## ${version} · ${today}\n\n` + notes.map( ( n ) => `- ${n}\n` ).join( "" ) + "\n" + text.slice( top ) );

console.log( `bump: ${pkg.version} -> ${version} (Android versionCode ${next[0] * 1000000 + next[1] * 1000 + next[2]}), ${notes.length} note(s) dated ${today}` );
