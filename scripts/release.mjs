/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// release.mjs -- a release build, made the same way every time, and its
// checksums
//
// Anyone must be able to check that an installer is the one released
// (SHA256SUMS.txt beside it, to be signed when a signing key exists) and,
// in time, that it was built from this source (reproducible builds): so
// what varies from one build to the next is pinned here, not left to the
// machine. The time is the last commit's (SOURCE_DATE_EPOCH); paths on
// this machine are rewritten out of the binary (--remap-path-prefix);
// dependencies are exactly the lockfiles' (--locked, npm ci).
//
// The release notes go beside the installers, in the checksums too.
//
//   node scripts/release.mjs            build, then write the checksums
//   node scripts/release.mjs --sums     only the checksums of the last build

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { constants, homedir, setPriority } from "node:os";
import { join, relative, resolve } from "node:path";

// below normal, as the gate: a release build takes minutes of every core
try {
	setPriority( constants.priority.PRIORITY_BELOW_NORMAL );
} catch {
	// not permitted here: it builds at the priority it was given
}

const ROOT		= resolve( import.meta.dirname, ".." );
const BUNDLE	= join( ROOT, "src-tauri", "target", "release", "bundle" );
const SUMS		= join( BUNDLE, "SHA256SUMS.txt" );
const NOTES		= join( BUNDLE, "RELEASE-NOTES.md" );		// what the app shows after the update, beside the installers
const INSTALLER	= /\.(msi|exe|dmg|AppImage|deb)$/;

/*
==================
Build

npm ci, then tauri build with the pins above
==================
*/
function Build() {
	const epoch = execSync( "git log -1 --format=%ct", { cwd: ROOT } ).toString().trim();
	const cargoHome = process.env.CARGO_HOME ?? join( homedir(), ".cargo" );
	const rustupHome = process.env.RUSTUP_HOME ?? join( homedir(), ".rustup" );
	const flags = [ [ ROOT, "/laurel" ], [ cargoHome, "/cargo" ], [ rustupHome, "/rustup" ] ]
		.map( ( [ from, to ] ) => `--remap-path-prefix=${from}=${to}` );

	// the Windows linker stamps each link with the time and a random PDB GUID (24
	// bytes apart between two builds of one source, 2026-09-27); /Brepro makes
	// both a hash of the content
	if ( process.platform === "win32" ) {
		flags.push( "-Clink-arg=/Brepro" );
	}

	// the encoded form: flags apart by 0x1F, so a path with a space ("Program Files")
	// stays one flag; RUSTFLAGS splits on spaces, and it once broke the build here
	const env = {
		...process.env,
		SOURCE_DATE_EPOCH:			epoch,
		CARGO_INCREMENTAL:			"0",
		CARGO_ENCODED_RUSTFLAGS:	flags.join( "\x1f" ),
	};
	delete env.RUSTFLAGS;		// ignored beside the encoded form: say so by not passing it
	execSync( "npm ci", { cwd: ROOT, stdio: "inherit", env } );
	execSync( "npx tauri build -- --locked", { cwd: ROOT, stdio: "inherit", env } );
}

// every installer under the bundle folder
function Installers( dir ) {
	if ( !existsSync( dir ) ) {
		return [];
	}
	return readdirSync( dir ).flatMap( ( f ) => {
		const p = join( dir, f );
		return statSync( p ).isDirectory() ? Installers( p ) : INSTALLER.test( f ) ? [ p ] : [];
	} );
}

/*
==================
Sums

SHA256SUMS.txt in the format sha256sum -c reads: "<hash>  <path>"
==================
*/
function Sums() {
	// the program itself too: an installer can't be the same bytes twice (each MSI
	// must carry a new package code, NSIS stamps dates), the program in it can
	copyFileSync( join( ROOT, "docs", "RELEASE-NOTES.md" ), NOTES );
	const files = [ ...Installers( BUNDLE ), join( BUNDLE, "..", "laurel.exe" ), NOTES ].filter( existsSync );
	if ( files.length < 3 ) {
		console.error( `release: no installer under ${BUNDLE}; build first` );
		process.exit( 1 );
	}
	const lines = files.map( ( f ) => `${createHash( "sha256" ).update( readFileSync( f ) ).digest( "hex" )}  ${relative( BUNDLE, f ).replaceAll( "\\", "/" )}` );
	writeFileSync( SUMS, lines.join( "\n" ) + "\n" );
	console.log( lines.join( "\n" ) );
	console.log( `release: ${SUMS}` );
}

if ( !process.argv.includes( "--sums" ) ) {
	Build();
}
Sums();
