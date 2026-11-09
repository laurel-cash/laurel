/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// release_rules.mjs -- what may never ship, as text checks the release
// scripts share (check_release.mjs on Cargo.toml, play_bundle.mjs on the
// phone's library), tested in src/test_release.test.ts

// the library says how it was built (w_local.rs NETWORKS_MARK, w_probe.rs PROBE_MARK)
export const TESTNET_MARK	= "laurel-networks:testnet-only";
export const PROBE_ON		= "laurel-kdf-probe:on";

// Cargo.toml: the engine's mixnet transport stays out (standing
// constraints), and the KDF probe is never on by default
export function Com_CargoProblems( cargo ) {
	const problems = [];
	if ( /["']nym["']|zingolib\/nym/.test( cargo ) ) {
		problems.push( "src-tauri/Cargo.toml turns on zingolib's nym feature: the mixnet path stays off without a new legal review" );
	}
	if ( /^\s*default\s*=\s*\[[^\]]*["']kdf-probe["']/m.test( cargo ) ) {
		problems.push( "src-tauri/Cargo.toml turns the kdf-probe feature on by default: it is a test build's only (w_probe.rs)" );
	}
	return problems;
}

// the phone's library: the testnet build, and never the KDF probe's
export function Com_LibraryProblems( library ) {
	const problems = [];
	if ( !library.includes( TESTNET_MARK ) ) {
		problems.push( "the library isn't the testnet build (NETWORKS_MARK): build with --features testnet-only" );
	}
	if ( library.includes( PROBE_ON ) ) {
		problems.push( "the library is a KDF probe build (kdf-probe): a test build's only, never Play's" );
	}
	return problems;
}

/*
==================
The public tree (scripts/public_export.mjs)

The public repository is a commit's tree less what stays internal, with
the files under public/ at the root in their place. What stays internal,
and the words a public file may not hold, are this tree's own settings
(EXPORT_SETTINGS, never exported themselves): without them, nothing is
left out but them, and nothing is checked.
==================
*/
export const EXPORT_SETTINGS	= "scripts/export.private.json";
const PUBLIC_DIR				= "public/";
export const NO_SETTINGS		= { files: [], dirs: [], words: [], allow: [] };

// where a path goes in the public tree; null: it stays internal
export function Com_PublicPath( path, settings = NO_SETTINGS ) {
	if ( path.startsWith( PUBLIC_DIR ) ) {
		return path.slice( PUBLIC_DIR.length );
	}
	if ( path === EXPORT_SETTINGS || settings.files.includes( path ) || settings.dirs.some( ( d ) => path.startsWith( d ) ) ) {
		return null;
	}
	return path;
}

// the settings' words as one pattern, any case: "any" anywhere, "word" as a whole
// word (- or _ between its parts alike), "path" only as a folder in a path; text
// that matches an "allow" pattern holds none
export function Com_WordRules( settings = NO_SETTINGS ) {
	const Escape = ( s ) => s.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
	const parts = settings.words.map( ( w ) => {
		const text = Escape( w.text ).replace( /[-_]/g, "[-_]" );
		return w.as === "path" ? `\\b${text}[\\\\/]` : w.as === "word" ? `\\b${text}\\b` : text;
	} );
	return {
		words:	parts.length ? new RegExp( parts.join( "|" ), "gi" ) : null,
		allow:	settings.allow.map( ( a ) => new RegExp( a, "gi" ) ),
	};
}

// every line of a public file holding one of the words, as "path:line: word"
export function Com_WordProblems( path, text, rules ) {
	const problems = [];
	if ( !rules.words ) {
		return problems;
	}
	text.split( /\r?\n/ ).forEach( ( line, i ) => {
		const rest = rules.allow.reduce( ( l, a ) => l.replace( a, "" ), line );
		for ( const m of rest.matchAll( rules.words ) ) {
			problems.push( `${path}:${i + 1}: ${m[0]}` );
		}
	} );
	return problems;
}
