/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// public_export.mjs -- the public repository's tree, made from a commit of
// this one the same way every time: the export leaves internal notes and
// local paths out, and puts public/'s files at the root (release_rules.mjs,
// from this tree's own export settings; without them it checks nothing)
//
//   node scripts/public_export.mjs --check [rev]            the gate: would rev's export be clean?
//                                                           (no rev: the working tree, as it would be
//                                                           committed, through an index of its own)
//   node scripts/public_export.mjs [rev]                    rev's public tree, as a git tree id
//   node scripts/public_export.mjs [rev] --no-words         the same without the words check: to
//                                                           compare an old commit's export only
//   node scripts/public_export.mjs [rev] --root <bundle> "<message>"
//                                                           that tree as a root commit (Laurel's
//                                                           identity, now in UTC), bundled
//
// An export is a commit's, as a release is: only --check reads the working
// tree, so the gate refuses a word before it's committed. rev defaults to HEAD.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Com_PublicPath, Com_WordProblems, Com_WordRules, EXPORT_SETTINGS, NO_SETTINGS } from "./release_rules.mjs";

const IDENTITY = { GIT_AUTHOR_NAME: "Laurel", GIT_AUTHOR_EMAIL: "security@laurel.cash", GIT_COMMITTER_NAME: "Laurel", GIT_COMMITTER_EMAIL: "security@laurel.cash" };

const Git = ( args, opts = {} ) => execFileSync( "git", args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts } );

const argv = process.argv.slice( 2 );
const check = argv.includes( "--check" );
const rootAt = argv.indexOf( "--root" );
const positional = argv.filter( ( a, i ) => !a.startsWith( "--" ) && ( rootAt < 0 || ( i !== rootAt + 1 && i !== rootAt + 2 ) ) );

// the export's settings: this tree's own, never exported; without them nothing is checked
const settings = existsSync( EXPORT_SETTINGS ) ? JSON.parse( readFileSync( EXPORT_SETTINGS, "utf8" ) ) : null;
if ( !settings ) {
	if ( check ) {
		console.log( `public_export: no ${EXPORT_SETTINGS} here, so nothing to check` );
		process.exit( 0 );
	}
	console.error( `public_export: no ${EXPORT_SETTINGS}: an export needs its settings` );
	process.exit( 1 );
}
const rules = Com_WordRules( settings ?? NO_SETTINGS );

// --check with no rev: the working tree as it would be committed, without touching this index
function Com_WorkingTree() {
	const dir = mkdtempSync( join( tmpdir(), "laurel-check-" ) );
	const env = { ...process.env, GIT_INDEX_FILE: join( dir, "index" ) };
	try {
		Git( [ "read-tree", "HEAD" ], { env } );
		Git( [ "add", "-A", "--", "." ], { env } );
		return Git( [ "write-tree" ], { env } ).trim();
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
}
const rev = positional[0] ?? ( check ? Com_WorkingTree() : "HEAD" );
const label = positional[0] ?? ( check ? "the working tree" : "HEAD" );

// every file of rev, where it goes in the public tree
const entries = Git( [ "ls-tree", "-r", "-z", "--full-tree", rev ] ).split( "\0" ).filter( Boolean ).map( ( line ) => {
	const [ meta, path ] = line.split( "\t" );
	const [ mode, type, id ] = meta.split( " " );
	return { mode, type, id, path, to: Com_PublicPath( path, settings ) };
} ).filter( ( e ) => e.to !== null );

// public/'s files take the internal ones' places
const places = new Map();
for ( const e of entries ) {
	if ( places.has( e.to ) && !e.path.startsWith( "public/" ) ) {
		continue;		// the internal file a public one replaces (Com_PublicPath already keeps it out)
	}
	places.set( e.to, e );
}

// the words, file by file (text only), every file's bytes read at once (git cat-file
// --batch: id, type, size, then the bytes)
const problems = [];
const scanned = argv.includes( "--no-words" ) ? [] : [ ...places ].filter( ( [ , e ] ) => e.type === "blob" );
const all = execFileSync( "git", [ "cat-file", "--batch" ], { input: scanned.map( ( [ , e ] ) => e.id ).join( "\n" ) + "\n", maxBuffer: 1 << 30 } );
let at = 0;
for ( const [ to ] of scanned ) {
	const head = all.indexOf( 10, at );
	const size = Number( all.subarray( at, head ).toString( "latin1" ).split( " " )[2] );
	const bytes = all.subarray( head + 1, head + 1 + size );
	at = head + 1 + size + 1;
	if ( !bytes.includes( 0 ) ) {		// text; binary (icons, images) has no words to search
		problems.push( ...Com_WordProblems( to, bytes.toString( "utf8" ), rules ) );
	}
}
for ( const p of problems.slice( 0, 40 ) ) {
	console.error( `public_export: ${p}` );
}
if ( problems.length ) {
	console.error( `public_export: ${problems.length} line(s) of ${label}'s public tree hold a word the export settings keep out (${EXPORT_SETTINGS})` );
	process.exit( 1 );
}
if ( check ) {
	console.log( `public_export: ${label}'s public tree, ${places.size} files, holds none of the settings' words` );
	process.exit( 0 );
}

// the tree, through an index of its own (this repository's index stays as it is)
const dir = mkdtempSync( join( tmpdir(), "laurel-public-" ) );
const env = { ...process.env, GIT_INDEX_FILE: join( dir, "index" ) };
try {
	Git( [ "update-index", "--index-info" ], { env, input: [ ...places.values() ].map( ( e ) => `${e.mode} ${e.id}\t${e.to}` ).join( "\n" ) + "\n" } );
	const tree = Git( [ "write-tree" ], { env } ).trim();
	if ( rootAt < 0 ) {
		console.log( tree );
		process.exit( 0 );
	}
	const [ bundle, message ] = [ argv[rootAt + 1], argv[rootAt + 2] ];
	if ( !bundle || !message ) {
		console.error( "public_export: --root takes a bundle path and a message" );
		process.exit( 2 );
	}
	const now = new Date().toISOString().replace( /\.\d+Z$/, "+0000" );
	const commit = Git( [ "commit-tree", tree, "-m", message ], { env: { ...process.env, ...IDENTITY, GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now } } ).trim();
	Git( [ "update-ref", "refs/public/root", commit ] );
	Git( [ "bundle", "create", bundle, "refs/public/root" ], { stdio: [ "ignore", "ignore", "ignore" ] } );
	console.log( `public_export: ${rev} -> root ${commit.slice( 0, 7 )} (tree ${tree.slice( 0, 7 )}), ${places.size} files, bundled to ${bundle}` );
} finally {
	rmSync( dir, { recursive: true, force: true } );
}
