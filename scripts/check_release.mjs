/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_release.mjs -- what ships is built the release's way
//
// A quicker build for this machine exists ([profile.local], npm run app),
// and the easy mistake is to make the release quicker too: a smaller
// optimization, a panic that unwinds instead of stopping. So the release
// profile is written down here, and release.mjs must build with it (no
// --profile of its own), into target/release/ where its checksums look.
//
//   node scripts/check_release.mjs

import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { Com_CargoProblems } from "./release_rules.mjs";

// Cargo.toml's [profile.release], as it must be
const RELEASE = {
	"codegen-units":	"1",			// the whole program optimized as one
	"lto":				"true",
	"opt-level":		"3",
	"panic":			"\"abort\"",	// a panic stops Laurel; it never runs on in a broken state
	"strip":			"true",
};

// one [section] of a TOML file, as key = value text
function Section( text, name ) {
	const from = text.indexOf( `\n[${name}]` );
	if ( from < 0 ) {
		return null;
	}
	const body = text.slice( from + name.length + 3 ).split( /\n\[/ )[0];
	return Object.fromEntries( [ ...body.matchAll( /^([\w-]+)\s*=\s*(.+?)\s*$/gm ) ].map( ( m ) => [ m[1], m[2] ] ) );
}

let bad = 0;
function Fail( why ) {
	console.error( `check_release: ${why}` );
	bad++;
}

const release = Section( readFileSync( "src-tauri/Cargo.toml", "utf8" ), "profile.release" );
if ( !release ) {
	Fail( "src-tauri/Cargo.toml has no [profile.release]" );
} else {
	for ( const [ key, want ] of Object.entries( RELEASE ) ) {
		if ( release[key] !== want ) {
			Fail( `[profile.release] ${key} is ${release[key] ?? "unset"}, not ${want}: a quicker build belongs in [profile.local] (npm run app)` );
		}
	}
	for ( const key of Object.keys( release ) ) {
		if ( !( key in RELEASE ) ) {
			Fail( `[profile.release] has ${key}, which check_release.mjs doesn't know: say here why a release wants it` );
		}
	}
}
// the engine's mixnet transport and the KDF probe stay out of what ships (release_rules.mjs)
for ( const problem of Com_CargoProblems( readFileSync( "src-tauri/Cargo.toml", "utf8" ) ) ) {
	Fail( problem );
}
// a phone's crash names its function in Play: the Android build keeps the engine's
// symbols, and Gradle strips them out of what phones get, into the bundle
if ( !/CARGO_PROFILE_RELEASE_STRIP = 'false'/.test( readFileSync( "scripts/android.ps1", "utf8" ) ) ) {
	Fail( "scripts/android.ps1 lets [profile.release] strip the Android library: Play's crash reports would show only addresses" );
}
const gradle = readFileSync( "src-tauri/gen/android/app/build.gradle.kts", "utf8" );
if ( !/ndk\.debugSymbolLevel = "(SYMBOL_TABLE|FULL)"/.test( gradle ) ) {
	Fail( "src-tauri/gen/android/app/build.gradle.kts sets no ndk.debugSymbolLevel: the bundle would carry no symbols for Play" );
}
// packaging {} is android-wide wherever it's written: keeping symbols there keeps them in the release
if ( /^\s*packaging\s*\{[^}]*keepDebugSymbols/m.test( gradle ) ) {
	Fail( "src-tauri/gen/android/app/build.gradle.kts keeps debug symbols in packaging {}, which is every build's: keep them per variant (androidComponents, withBuildType(\"debug\"))" );
}
// a phone app: Tauri's template offers Laurel to Android TV (leanback), which Play then
// lists it for and its pre-launch lab can't test
if ( /leanback|LEANBACK/.test( readFileSync( "src-tauri/gen/android/app/src/main/AndroidManifest.xml", "utf8" ) ) ) {
	Fail( "src-tauri/gen/android/app/src/main/AndroidManifest.xml offers Laurel to Android TV (leanback): Laurel is for phones and tablets" );
}
// the engine ends its process in one place (lib.rs Sys_Close, Sys_End on Android) and
// restarts it in one (W_StartOver_f): on Android a normal exit aborts in the render threads
for ( const file of readdirSync( "src-tauri/src" ).filter( ( f ) => f.endsWith( ".rs" ) ) ) {
	const code = readFileSync( `src-tauri/src/${file}`, "utf8" ).split( "\n" ).filter( ( l ) => !/^\s*\/\//.test( l ) ).join( "\n" );
	const ends = ( code.match( /\.exit\(|\.restart\(|\.request_restart\(|process::exit\(/g ) ?? [] ).length;
	const allowed = { "lib.rs": 1, "w_cmds.rs": 1 }[file] ?? 0;
	if ( ends > allowed ) {
		Fail( `src-tauri/src/${file} ends or restarts the process ${ends} times (${allowed} allowed): close through Sys_Close, restart through W_StartOver_f, as Android needs (docs/ANDROID.md)` );
	}
}
// index.html's "update your web view" screen runs where the page can't (WEBVIEW_FLOOR,
// vite.config.ts): its script is ES5, and its CSS has nothing Chrome 83 drops (inset is
// 87, flex gap 84): Test Lab's Pixel 5 has WebView 83
const html = readFileSync( "index.html", "utf8" );
const acorn = createRequire( import.meta.url )( "acorn" );
for ( const [ , script ] of html.matchAll( /<script>([\s\S]*?)<\/script>/g ) ) {
	try {
		acorn.parse( script.replaceAll( "%WEBVIEW_FLOOR%", "111" ), { ecmaVersion: 5 } );
	} catch ( e ) {
		Fail( `index.html's inline script isn't ES5 (${e.message}): a web view below the floor couldn't run it` );
	}
}
for ( const [ , style ] of html.matchAll( /<style>([\s\S]*?)<\/style>/g ) ) {
	const late = style.match( /\binset\s*:|\bgap\s*:|aspect-ratio|:is\(|:where\(|:has\(|color-mix|light-dark|\bvar\(/ );
	if ( late ) {
		Fail( `index.html's inline style uses ${late[0]}, which a web view below the floor drops` );
	}
}
if ( /--profile|--no-bundle/.test( readFileSync( "scripts/release.mjs", "utf8" ) ) ) {
	Fail( "scripts/release.mjs names a --profile or --no-bundle: a release is the release profile, with its installers" );
}

if ( bad ) {
	process.exit( 1 );
}
console.log( "check_release: the release profile is the release's, Android keeps symbols for Play, and the mixnet stays out" );
