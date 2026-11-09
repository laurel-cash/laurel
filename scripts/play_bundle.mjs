/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// play_bundle.mjs -- the Play bundle android.ps1 just built, checked, then put
// where it's signed from
//
// Every check here was once done by hand, once, and then forgotten: the
// bundle is a commit's (android.ps1's built-from.txt: a clean tree, and
// nothing built into the app changed since, so a later scripts or docs
// commit needs no new 10-minute build), its version code Play hasn't had, the testnet
// build, its library the one cargo built (stripped, its symbols beside it
// for Play's crash reports), and no Android TV (Play's device lab can't
// test one). Then it's copied to D:\Android\releases\ under the commit,
// and the line to run is printed.
//
//   scripts\android.ps1 build --target aarch64 --aab --features testnet-only
//   node scripts/play_bundle.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Com_LibraryProblems } from "./release_rules.mjs";

// what android.ps1 wrote once its build succeeded: the commit, clean or dirty, the bundle's hash and path
const STAMP		= "src-tauri/gen/android/app/build/outputs/bundle/built-from.txt";
const LIBRARY	= "src-tauri/target-android/aarch64-linux-android/release/liblaurel_lib.so";
const RELEASES	= "D:/Android/releases";
const PHONE_LIB	= "base/lib/arm64-v8a/liblaurel_lib.so";
const SYMBOLS	= "BUNDLE-METADATA/com.android.tools.build.debugsymbols/arm64-v8a/liblaurel_lib.so.sym";

let bad = 0;
function Fail( why ) {
	console.error( `play_bundle: ${why}` );
	bad++;
}
function Sha256( path ) {
	return createHash( "sha256" ).update( readFileSync( path ) ).digest( "hex" ).toUpperCase();
}
const Git = ( ...args ) => execFileSync( "git", args, { encoding: "utf8" } ).trim();

// what in the tree isn't built into the app: a change to it needs no new bundle. Of docs/,
// what the page imports (as ui_notes.tsx does RELEASE-NOTES.md) is built in
const IMPORTED = new Set( readdirSync( "src" ).filter( ( f ) => /\.tsx?$/.test( f ) ).flatMap( ( f ) =>
	[ ...readFileSync( `src/${f}`, "utf8" ).matchAll( /from "\.\.\/(docs\/[^"?]+)/g ) ].map( ( m ) => m[1] ) ) );
const NOT_BUILT = ( path ) => path.startsWith( "scripts/" ) || ( path.startsWith( "docs/" ) && !IMPORTED.has( path ) );

if ( Git( "status", "--porcelain", "--untracked-files=no" ) ) {
	Fail( "the tree has uncommitted changes: commit them first" );
}
// the bundle android.ps1 built, unchanged since; the commit it was built from, whole; and
// nothing built into the app changed since
const [ from, state, built, AAB ] = existsSync( STAMP ) ? readFileSync( STAMP, "utf8" ).trim().split( " " ) : [];
if ( !AAB || !existsSync( AAB ) || Sha256( AAB ) !== built ) {
	console.error( `play_bundle: no bundle that scripts/android.ps1 built and recorded (${STAMP}): build it (see the top of this file)` );
	process.exit( 1 );
}
if ( state !== "clean" ) {
	Fail( `it was built from ${from.slice( 0, 7 )} with uncommitted changes: commit, then build again` );
}
const since = Git( "diff", "--name-only", from, "HEAD" ).split( "\n" ).filter( ( p ) => p && !NOT_BUILT( p ) );
if ( since.length ) {
	Fail( `since it was built (${from.slice( 0, 7 )}), what goes into the app changed: ${since.slice( 0, 5 ).join( ", " )}${since.length > 5 ? ", ..." : ""}: build again` );
}
const sha = from.slice( 0, 7 );

// the version Play gets: package.json's, as Tauri turns it into Android's
const version = JSON.parse( readFileSync( "package.json", "utf8" ) ).version;
const [ a, b, c ] = version.split( "." ).map( Number );
const props = Object.fromEntries( readFileSync( "src-tauri/gen/android/app/tauri.properties", "utf8" ).split( /\r?\n/ ).filter( ( l ) => l.includes( "=" ) ).map( ( l ) => l.split( "=" ) ) );
if ( props["tauri.android.versionName"] !== version || Number( props["tauri.android.versionCode"] ) !== a * 1000000 + b * 1000 + c ) {
	Fail( `the build says ${props["tauri.android.versionName"]} (${props["tauri.android.versionCode"]}), package.json ${version}: build it again` );
}

// inside the bundle (Windows' own tar reads zip files)
const dir = mkdtempSync( join( tmpdir(), "play-bundle-" ) );
const TAR = join( process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe" );
const entries = execFileSync( TAR, [ "-tf", AAB ], { encoding: "utf8" } ).split( /\r?\n/ );
execFileSync( TAR, [ "-xf", AAB, "-C", dir, PHONE_LIB, "base/manifest/AndroidManifest.xml" ] );

const libs = entries.filter( ( e ) => /^base\/lib\/.+\.so$/.test( e ) );
if ( libs.join() !== PHONE_LIB ) {
	Fail( `the bundle's libraries are ${libs.join( ", " ) || "none"}, not ${PHONE_LIB} alone (a stale one from src/main/jniLibs?)` );
}
if ( !entries.includes( SYMBOLS ) ) {
	Fail( `no ${SYMBOLS}: Play's crash reports would show addresses (ndk.debugSymbolLevel, CARGO_PROFILE_RELEASE_STRIP)` );
}

// the phone's library is cargo's, stripped as Gradle strips it, with the NDK the app names
const ndk = /ndkVersion = "([^"]+)"/.exec( readFileSync( "src-tauri/gen/android/app/build.gradle.kts", "utf8" ) )?.[1];
const strip = `D:/Android/Sdk/ndk/${ndk}/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe`;
execFileSync( strip, [ "--strip-unneeded", "-o", join( dir, "cargo.so" ), LIBRARY ] );
if ( Sha256( join( dir, "cargo.so" ) ) !== Sha256( join( dir, PHONE_LIB ) ) ) {
	Fail( `${PHONE_LIB} isn't ${LIBRARY} stripped: the bundle holds another build's library` );
}
const library = readFileSync( join( dir, PHONE_LIB ) ).toString( "latin1" );
for ( const problem of Com_LibraryProblems( library ) ) {
	Fail( problem );		// the testnet build, never the KDF probe's (release_rules.mjs)
}

// the manifest, as Play reads it (protobuf, its strings plain)
const manifest = readFileSync( join( dir, "base/manifest/AndroidManifest.xml" ) ).toString( "latin1" );
for ( const need of [ "android.intent.action.MAIN", "android.intent.category.LAUNCHER", "com.rptxsoftware.wallet" ] ) {
	if ( !manifest.includes( need ) ) {
		Fail( `the manifest has no ${need}` );
	}
}
if ( /leanback/i.test( manifest ) ) {
	Fail( "the manifest offers Laurel to Android TV (leanback)" );
}
rmSync( dir, { recursive: true, force: true } );

if ( bad ) {
	process.exit( 1 );
}
const out = `${RELEASES}/laurel-testnet-${sha}-unsigned.aab`;
copyFileSync( AAB, out );
const hash = Sha256( out );
const others = readdirSync( RELEASES ).filter( ( f ) => f.endsWith( "-unsigned.aab" ) ).length;
console.log( `play_bundle: ${version} (${a * 1000000 + b * 1000 + c}), ${sha}, checked; ${others} unsigned bundles in ${RELEASES}` );
console.log( `  ${out.replaceAll( "/", "\\" )}` );
console.log( `  unsigned SHA-256 ${hash}` );
console.log( `  .\\scripts\\laurel-release.ps1 -Sha ${sha} -Sha256 ${hash} -Track alpha` );
