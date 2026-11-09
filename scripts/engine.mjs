/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// engine.mjs -- the fork of zingolib, kept as one recorded patch
//
// vendor/zingolib is upstream zingolib at UPSTREAM_REV plus Laurel's
// changes, and nothing else. The changes are written down whole in
// vendor/zingolib.patch, and every file they touch is named in
// docs/ENGINE.md, so the fork can't grow by an edit nobody recorded.
// Taking a new upstream is a three-way merge of each file (the old
// upstream its base), not a hunt for what we changed.
//
//   node scripts/engine.mjs fetch           the pinned upstream, once, into vendor/.upstream (ignored)
//   node scripts/engine.mjs check           the gate: vendor == upstream + the recorded patch, all named
//   node scripts/engine.mjs record          write vendor/zingolib.patch from the tree as it is
//   node scripts/engine.mjs status          how far upstream's newest dev is, and what taking it costs (writes nothing)
//   node scripts/engine.mjs rebase <rev>    merge upstream <rev> into vendor/zingolib; lists conflicts

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const UPSTREAM_URL	= "https://github.com/zingolabs/zingolib";
const UPSTREAM_REV	= "81d799775f11e882896e8710e8af12d6d4d29a41";		// the one place it is written; docs/ENGINE.md points here
const UPSTREAM_BRANCH	= "dev";		// where upstream's work lands (status compares against its newest)
const VENDOR		= "vendor/zingolib";
const PATCH			= "vendor/zingolib.patch";
const LEDGER		= "docs/ENGINE.md";
const CACHE			= "vendor/.upstream";

// git over https on Windows: the system's certificate store, as the browser trusts
// (an HTTPS-scanning antivirus re-signs with its own, which git's bundle refuses)
const GIT_TLS = process.platform === "win32" ? [ "-c", "http.sslBackend=schannel" ] : [];

// never part of the copy: build output, the proving keys build.rs fetches, upstream's test binaries
const SKIP = [ /^target(\/|$)/, /(^|\/)zcash-params\//, /^test_binaries\// ];

function Git( args, cwd = "." ) {
	return execFileSync( "git", args, { cwd: cwd, encoding: "utf8", maxBuffer: 256 << 20, windowsHide: true, stdio: [ "ignore", "pipe", "pipe" ] } );
}

function Die( text ) {
	console.error( `engine: ${text}` );
	process.exit( 1 );
}

/*
==================
Fetch

One revision of upstream, shallow, into its own folder of the cache
==================
*/
function Fetch( rev ) {
	const dir = join( CACHE, rev );
	if ( existsSync( join( dir, ".git" ) ) ) {
		return dir;
	}
	mkdirSync( dir, { recursive: true } );
	Git( [ "init", "-q" ], dir );
	Git( [ ...GIT_TLS, "fetch", "-q", "--depth", "1", UPSTREAM_URL, rev ], dir );
	Git( [ "checkout", "-q", "FETCH_HEAD" ], dir );
	return dir;
}

function Upstream( rev ) {
	const dir = join( CACHE, rev );
	if ( !existsSync( join( dir, ".git" ) ) ) {
		Die( `upstream ${rev.slice( 0, 8 )} isn't here yet: run  node scripts/engine.mjs fetch  (once, needs the network)` );
	}
	return dir;
}

// a tree's files as git knows them, less what is never copied
function Files( args, cwd ) {
	return Git( args, cwd ).split( "\n" ).filter( ( f ) => f && !SKIP.some( ( r ) => r.test( f ) ) );
}

const DIRECTORY = Symbol( "directory" );

// a tree's submodules (git mode 160000): their content is another repository's
function Gitlinks( cwd ) {
	return new Set( Git( [ "ls-files", "-s" ], cwd ).split( "\n" ).filter( ( l ) => l.startsWith( "160000 " ) ).map( ( l ) => l.split( "\t" )[1] ) );
}

// text with LF endings, or the bytes of a binary file; null when absent
function Read( path ) {
	if ( !existsSync( path ) ) {
		return null;
	}
	if ( statSync( path ).isDirectory() ) {
		return DIRECTORY;		// a folder (or a submodule's) where the other side has a file
	}
	const raw = readFileSync( path );
	return raw.includes( 0 ) ? raw : raw.toString( "utf8" ).replace( /\r\n/g, "\n" );
}

// the copy's side of a path: only what git tracks, so a file left on this disk
// (ignored, as zingolib's proptest-regressions are) can't hide from the gate a
// difference that every fresh clone has
let m_tracked = null;
function Ours( f ) {
	m_tracked ??= new Set( Git( [ "ls-files", "--", VENDOR ], "." ).split( "\n" ).filter( Boolean ).map( ( p ) => p.slice( VENDOR.length + 1 ) ) );
	return m_tracked.has( f ) ? Read( join( VENDOR, f ) ) : null;
}

function Same( a, b ) {
	return ( a === null || b === null ) ? a === b : ( Buffer.isBuffer( a ) || Buffer.isBuffer( b ) ) ? Buffer.compare( Buffer.from( a ), Buffer.from( b ) ) === 0 : a === b;
}

/*
==================
Changed

Every path where the copy differs from upstream: changed, added, removed
==================
*/
function Changed( base ) {
	const ours = Files( [ "ls-files", "--", VENDOR ], "." ).map( ( f ) => f.slice( VENDOR.length + 1 ) ).filter( ( f ) => !SKIP.some( ( r ) => r.test( f ) ) );
	// a submodule's content is another repository's (upstream's docs/adr): never part of the copy
	const links = Gitlinks( base );
	const theirs = Files( [ "ls-files" ], base ).filter( ( f ) => !links.has( f ) );
	const all = [ ...new Set( [ ...ours, ...theirs ] ) ].sort();
	return all.filter( ( f ) => !Same( Read( join( base, f ) ), Ours( f ) ) );
}

/*
==================
Diff

One unified diff of the whole fork, LF endings, paths from the engine's
root: the patch as a reviewer reads it
==================
*/
function Diff( base, changed ) {
	const tmp = mkdtempSync( join( tmpdir(), "laurel-engine-" ) );
	try {
		let out = "";
		for ( const f of changed ) {
			const a = Read( join( base, f ) ), b = Ours( f );
			if ( Buffer.isBuffer( a ) || Buffer.isBuffer( b ) ) {
				out += `Binary files a/${f} and b/${f} differ\n`;
				continue;
			}
			const pa = join( tmp, "a" ), pb = join( tmp, "b" );
			writeFileSync( pa, a ?? "" );
			writeFileSync( pb, b ?? "" );
			let d;
			try {
				d = Git( [ "diff", "--no-index", "--no-color", "-U3", pa, pb ] );
			} catch ( e ) {
				d = e.stdout;		// exit 1: they differ, as known
			}
			const body = d.split( "\n" ).slice( d.startsWith( "diff --git" ) ? 4 : 0 ).join( "\n" ).replace( /^@@/m, "@@" );
			const hunks = body.slice( body.indexOf( "@@" ) );
			out += `--- ${a === null ? "/dev/null" : "a/" + f}\n+++ ${b === null ? "/dev/null" : "b/" + f}\n${hunks}`;
			if ( !out.endsWith( "\n" ) ) {
				out += "\n";
			}
		}
		return out;
	} finally {
		rmSync( tmp, { recursive: true, force: true } );
	}
}

function Header( changed ) {
	return `# The fork: zingolib ${UPSTREAM_REV} (${UPSTREAM_URL}) to vendor/zingolib.\n# Written by scripts/engine.mjs record; checked by the gate. ${changed.length} files; why each: docs/ENGINE.md.\n`;
}

/*
==================
Check

The gate's step: nothing changed in the engine that the patch doesn't
say, and nothing the patch says that the ledger doesn't name
==================
*/
function Check() {
	const base = Upstream( UPSTREAM_REV );
	const changed = Changed( base );
	const patch = Header( changed ) + Diff( base, changed );
	const recorded = existsSync( PATCH ) ? readFileSync( PATCH, "utf8" ).replace( /\r\n/g, "\n" ) : "";
	const faults = [];
	if ( patch !== recorded ) {
		faults.push( `the engine differs from upstream + ${PATCH}: an edit nobody recorded. Look at it, name it in ${LEDGER}, then  node scripts/engine.mjs record` );
	}
	const ledger = readFileSync( LEDGER, "utf8" );
	for ( const f of changed ) {
		if ( !ledger.includes( "`" + VENDOR + "/" + f + "`" ) ) {
			faults.push( `${f} differs from upstream but ${LEDGER} doesn't name it (\`${VENDOR}/${f}\`), with why` );
		}
	}
	if ( faults.length ) {
		Die( faults.join( "\n" ) );
	}
	console.log( `engine: vendor/zingolib is upstream ${UPSTREAM_REV.slice( 0, 8 )} + ${changed.length} recorded files` );
}

function Record() {
	const base = Upstream( UPSTREAM_REV );
	const changed = Changed( base );
	writeFileSync( PATCH, Header( changed ) + Diff( base, changed ) );
	console.log( `engine: wrote ${PATCH}: ${changed.length} files` );
	for ( const f of changed ) {
		console.log( `  ${f}` );
	}
}

/*
==================
Merge

Each file merged three ways, in memory: the pinned upstream its base,
ours and the new upstream the two sides. A file only one side changed is
taken from it; both, merged by git merge-file, conflicts marked in the
text and listed. Nothing is written here: Rebase writes, Status reports.
==================
*/
function Merge( rev ) {
	const oldBase = Upstream( UPSTREAM_REV );
	const newBase = Fetch( rev );
	const links = new Set( [ ...Gitlinks( oldBase ), ...Gitlinks( newBase ) ] );
	const files = [ ...new Set( [ ...Files( [ "ls-files" ], oldBase ), ...Files( [ "ls-files" ], newBase ), ...Changed( oldBase ) ] ) ].sort();
	const writes = [];		// [ path, content | null ]: what upstream changed, merged with ours
	const both = [];		// files both sides changed: where a merge can go wrong
	const conflicts = [];
	for ( const f of files ) {
		if ( links.has( f ) ) {
			conflicts.push( `${f} (a submodule upstream: its content is another repository's; by hand)` );
			continue;
		}
		const base = Read( join( oldBase, f ) ), ours = Ours( f ), theirs = Read( join( newBase, f ) );
		if ( [ base, ours, theirs ].includes( DIRECTORY ) ) {
			conflicts.push( `${f} (a file on one side, a folder on another; by hand)` );
			continue;
		}
		if ( Same( ours, theirs ) || Same( base, theirs ) ) {
			continue;		// upstream didn't change it, or changed it to ours
		}
		if ( Same( base, ours ) ) {
			writes.push( [ f, theirs ] );		// only upstream changed it
			continue;
		}
		if ( base === null || ours === null || theirs === null || Buffer.isBuffer( ours ) || Buffer.isBuffer( theirs ) ) {
			conflicts.push( `${f} (added, removed or binary on both sides; by hand)` );
			continue;
		}
		both.push( f );
		const tmp = mkdtempSync( join( tmpdir(), "laurel-merge-" ) );
		try {
			const [ pb, po, pt ] = [ "base", "ours", "theirs" ].map( ( n ) => join( tmp, n ) );
			writeFileSync( pb, base );
			writeFileSync( po, ours );
			writeFileSync( pt, theirs );
			try {
				Git( [ "merge-file", "-L", "laurel", "-L", UPSTREAM_REV.slice( 0, 8 ), "-L", rev.slice( 0, 8 ), po, pb, pt ] );
			} catch {
				conflicts.push( f );
			}
			writes.push( [ f, readFileSync( po ) ] );
		} finally {
			rmSync( tmp, { recursive: true, force: true } );
		}
	}
	return { writes: writes, both: both, conflicts: conflicts };
}

function Report( rev, merged ) {
	console.log( `  upstream changed ${merged.writes.length} files since ${UPSTREAM_REV.slice( 0, 8 )}; ${merged.both.length} of them ones we change too${merged.both.length ? ": " + merged.both.join( ", " ) : ""}` );
	if ( merged.conflicts.length ) {
		console.log( `  ${merged.conflicts.length} to resolve by hand:\n    ${merged.conflicts.join( "\n    " )}` );
	} else {
		console.log( "  no conflicts" );
	}
}

/*
==================
Rebase

Merge, then written: everything is worked out first, so a failure
halfway leaves the tree as it was (and the tree is Laurel's git's)
==================
*/
function Rebase( rev ) {
	const merged = Merge( rev );
	for ( const [ f, content ] of merged.writes ) {
		const target = join( VENDOR, f );
		if ( content === null ) {
			rmSync( target, { force: true } );
		} else {
			mkdirSync( dirname( target ), { recursive: true } );
			writeFileSync( target, content );
		}
	}
	console.log( `engine: merged upstream ${rev.slice( 0, 8 )} into ${VENDOR}` );
	Report( rev, merged );
	console.log( `next: resolve, set UPSTREAM_REV in scripts/engine.mjs to ${rev}, node scripts/engine.mjs record, npm run check, then a live testnet run (docs/ENGINE.md)` );
}

/*
==================
Status

How far the fork is from upstream's newest dev, and what taking it would
cost, merged in memory and written nowhere: run it on a schedule, so
catching up stays a small step and never a war
==================
*/
function Status() {
	const head = Git( [ ...GIT_TLS, "ls-remote", UPSTREAM_URL, UPSTREAM_BRANCH ] ).split( "\t" )[0];
	if ( !/^[0-9a-f]{40}$/.test( head ) ) {
		Die( `couldn't read upstream's ${UPSTREAM_BRANCH}` );
	}
	if ( head === UPSTREAM_REV ) {
		console.log( `engine: vendor/zingolib is on upstream's newest ${UPSTREAM_BRANCH} (${head.slice( 0, 8 )})` );
		return;
	}
	console.log( `engine: pinned ${UPSTREAM_REV.slice( 0, 8 )}; upstream's ${UPSTREAM_BRANCH} is ${head.slice( 0, 8 )}. Taking it:` );
	Report( head, Merge( head ) );
	console.log( `to take it:  node scripts/engine.mjs rebase ${head}` );
}

const [ what, arg ] = process.argv.slice( 2 );
switch ( what ) {
	case "fetch":	Fetch( UPSTREAM_REV ); console.log( `engine: upstream ${UPSTREAM_REV.slice( 0, 8 )} in ${CACHE}` ); break;
	case "check":	Check(); break;
	case "record":	Record(); break;
	case "status":	Status(); break;
	case "rebase":	if ( !arg ) Die( "rebase takes the upstream revision to merge" ); Rebase( arg ); break;
	default:		Die( "fetch | check | record | status | rebase <rev>" );
}
