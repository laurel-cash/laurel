/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// store_msix.mjs -- the Microsoft Store package of the v1 Windows build,
// checked, then packed
//
//   set LAUREL_FEATURES=v1,prices
//   npx tauri build --features v1,prices --no-bundle
//   node scripts/store_msix.mjs [--dev]
//
// The build is v1's, real money, mainnet alone, with prices and no other
// module (D-033, D-035: STORE_MODULES, the ui's LAUREL_FEATURES the same): its exe
// is checked as the phone's library is (release_rules.mjs), since the
// library is linked into it. Then a layout (laurel.exe, the licence and
// notices, the logos, AppxManifest.xml filled in) is packed with makeappx
// into D:\laurel-store\<version>\. The Store signs the package; nothing
// here signs anything.
//
// The identity is packaging/msix/identity.json, copied from Partner Center's
// Product identity. --dev uses a stand-in, for installing the layout on
// this PC with Developer Mode:
//   Add-AppxPackage -Register D:\laurel-store\<version>\layout\AppxManifest.xml
//
// makeappx: MAKEAPPX, or the newest under the SDK build tools unpacked from
// nuget.org's Microsoft.Windows.SDK.BuildTools (SDK_BUILDTOOLS)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Com_LibraryProblems } from "./release_rules.mjs";

const DEV		= { name: "Laurel.Dev", publisher: "CN=Laurel Dev", publisherName: "Laurel", displayName: "Laurel" };
const LOGOS		= [ "Square44x44Logo.png", "Square150x150Logo.png", "StoreLogo.png" ];
const OUT_ROOT	= "D:/laurel-store";
const STORE_MODULES	= [ "prices" ];		// the Store's v1 has these and no other (D-035); off until the person turns each on
const BUILDTOOLS	= process.env.SDK_BUILDTOOLS ?? "sdk-buildtools/bin";

function Die( why ) {
	console.error( `store_msix: ${why}` );
	process.exit( 1 );
}

function Makeappx() {
	if ( process.env.MAKEAPPX ) {
		return process.env.MAKEAPPX;
	}
	const versions = existsSync( BUILDTOOLS ) ? readdirSync( BUILDTOOLS ).filter( ( v ) => existsSync( join( BUILDTOOLS, v, "x64/makeappx.exe" ) ) ).sort() : [];
	if ( !versions.length ) {
		Die( `no makeappx: set MAKEAPPX, or unpack Microsoft.Windows.SDK.BuildTools into ${BUILDTOOLS}` );
	}
	return join( BUILDTOOLS, versions.at( -1 ), "x64/makeappx.exe" );
}

function Identity( dev ) {
	if ( dev ) {
		return DEV;
	}
	const path = "packaging/msix/identity.json";
	if ( !existsSync( path ) ) {
		Die( `no ${path}: copy Product identity from Partner Center into it (name, publisher, publisherName, displayName), or --dev` );
	}
	return JSON.parse( readFileSync( path, "utf8" ) );
}

const dev		= process.argv.includes( "--dev" );
const ident		= Identity( dev );
const version	= JSON.parse( readFileSync( "package.json", "utf8" ) ).version;
const target	= process.env.CARGO_TARGET_DIR ?? "src-tauri/target";
const exe		= join( target, "release", "laurel.exe" );
if ( !existsSync( exe ) ) {
	Die( `no ${exe}: npx tauri build --features v1,${STORE_MODULES.join( "," )} --no-bundle first` );
}

// the exe is the real-money build with the Store's modules, as the phone's library is checked (D-033)
const problems = Com_LibraryProblems( readFileSync( exe ).toString( "latin1" ), "v1", STORE_MODULES );
if ( problems.length ) {
	Die( `${exe} isn't the v1 build:\n  ${problems.join( "\n  " )}` );
}

const out		= join( OUT_ROOT, version );
const layout	= join( out, "layout" );
rmSync( layout, { recursive: true, force: true } );
mkdirSync( join( layout, "Assets" ), { recursive: true } );
copyFileSync( exe, join( layout, "laurel.exe" ) );
copyFileSync( "LICENSE", join( layout, "LICENSE.txt" ) );
copyFileSync( "THIRD_PARTY_NOTICES.md", join( layout, "THIRD_PARTY_NOTICES.md" ) );
for ( const logo of LOGOS ) {
	copyFileSync( join( "src-tauri/icons", logo ), join( layout, "Assets", logo ) );
}

let manifest = readFileSync( "packaging/msix/AppxManifest.xml", "utf8" );
for ( const [ key, value ] of [ [ "{NAME}", ident.name ], [ "{PUBLISHER}", ident.publisher ], [ "{PUBLISHER_NAME}", ident.publisherName ], [ "{DISPLAY_NAME}", ident.displayName ], [ "{VERSION}", `${version}.0` ] ] ) {
	manifest = manifest.replaceAll( key, value );
}
writeFileSync( join( layout, "AppxManifest.xml" ), manifest );

const msix = join( out, `Laurel_${version}_x64${dev ? "_dev" : ""}.msix` );
try {
	execFileSync( Makeappx(), [ "pack", "/o", "/h", "SHA256", "/d", layout, "/p", msix ], { encoding: "utf8" } );
} catch ( e ) {
	Die( ( e.stdout ?? "" ).split( /\r?\n/ ).filter( ( l ) => /error/i.test( l ) ).join( "\n" ) || String( e ) );
}
const sha = createHash( "sha256" ).update( readFileSync( msix ) ).digest( "hex" ).toUpperCase();
console.log( `${msix}  ${Math.round( statSync( msix ).size / 1024 )} KB  ${ident.name} ${version}.0  sha256 ${sha}` );
