/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_version.mjs -- Laurel has one version, and its notes
//
// The app shows package.json's (tauri.conf.json reads it); the engine's
// own requests carry Cargo.toml's (CARGO_PKG_VERSION, the price source's
// User-Agent). Both must say the same, and the newest release notes
// (docs/RELEASE-NOTES.md) must be for it: a version bumped without notes
// would show nothing new after the update.
//
//   node scripts/check_version.mjs

import { readFileSync } from "node:fs";

const app	= JSON.parse( readFileSync( "package.json", "utf8" ) ).version;
const engine	= /^version\s*=\s*"([^"]+)"/m.exec( readFileSync( "src-tauri/Cargo.toml", "utf8" ) )?.[1];
const notes	= [ ...readFileSync( "docs/RELEASE-NOTES.md", "utf8" ).matchAll( /^## (\S+) · (\d{4}-\d{2}-\d{2})\s*$/gm ) ];
const items	= ( version ) => {
	const text = readFileSync( "docs/RELEASE-NOTES.md", "utf8" );
	const from = text.indexOf( `## ${version} ` );
	const next = text.indexOf( "\n## ", from + 1 );
	return ( text.slice( from, next < 0 ? undefined : next ).match( /^- \S/gm ) ?? [] ).length;
};

let bad = 0;
function Fail( why ) {
	console.error( `check_version: ${why}` );
	bad++;
}

if ( engine !== app ) {
	Fail( `package.json says ${app}, src-tauri/Cargo.toml says ${engine}: the app and its requests would give two versions` );
}
if ( !notes.length || notes[0][1] !== app ) {
	Fail( `the newest notes in docs/RELEASE-NOTES.md are for ${notes[0]?.[1] ?? "nothing"}, not ${app}: write what ${app} changed first` );
} else if ( items( app ) === 0 ) {
	Fail( `${app}'s notes list no change ("- " lines)` );
}
const versions = notes.map( ( n ) => n[1] );
if ( new Set( versions ).size !== versions.length ) {
	Fail( "a version has two headings in docs/RELEASE-NOTES.md" );
}

if ( bad ) {
	process.exit( 1 );
}
console.log( `check_version: ${app} everywhere, with ${items( app )} notes` );
