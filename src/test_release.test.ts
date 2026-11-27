/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_release.test.ts -- what may never ship (scripts/release_rules.mjs):
// the engine's mixnet path, the KDF probe, a test build's only, and a
// module a build left out (D-031) that is in it anyway

import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain node module of the release scripts, without types
import { Com_ActivityProblems, Com_CargoProblems, Com_IosIconProblems, Com_IosProblems, Com_ViewportProblems, Com_Features, Com_LibraryProblems, Com_LineProblems, Com_ModuleMark, Com_ModuleProblems, Com_PublicPath, Com_WordProblems, Com_WordRules, EXPORT_SETTINGS, MODULES } from "../scripts/release_rules.mjs";
import MAIN_ACTIVITY from "../src-tauri/gen/android/app/src/main/java/com/rptxsoftware/wallet/MainActivity.kt?raw";
import W_IOS from "../src-tauri/src/w_ios.rs?raw";
import IOS_PROJECT from "../src-tauri/gen/apple/project.yml?raw";

const CARGO = "[features]\ntestnet-only = []\nkdf-probe = []\n";
const ALL_MARKS = ( MODULES as string[] ).map( ( m ) => Com_ModuleMark( m ) ).join( "…" );
const TESTNET = "…laurel-networks:testnet-only…laurel-kdf-probe:off…";
const V1 = "…laurel-networks:v1…laurel-kdf-probe:off…";

describe( "release rules", () => {
	it( "refuse a Cargo.toml that turns on nym, or the probe by default", () => {
		expect( Com_CargoProblems( CARGO ) ).toEqual( [] );
		expect( Com_CargoProblems( CARGO + "default = [ \"kdf-probe\" ]\n" ).length ).toBe( 1 );
		expect( Com_CargoProblems( "zingolib = { path = \"x\", features = [ \"nym\" ] }\n" ).length ).toBe( 1 );
	} );

	it( "refuse a Cargo.toml that turns a module on by default: a build gets one only by naming it", () => {
		expect( Com_CargoProblems( CARGO + "default = []\n" ) ).toEqual( [] );
		expect( Com_CargoProblems( CARGO + "default = [ \"full\" ]\n" ).length ).toBe( 1 );
		expect( Com_CargoProblems( CARGO + "default = [ \"prices\" ]\n" ).length ).toBe( 1 );
	} );

	it( "refuse a library built with the KDF probe", () => {
		expect( Com_LibraryProblems( `${TESTNET}${ALL_MARKS}` ) ).toEqual( [] );
		expect( Com_LibraryProblems( `…laurel-networks:testnet-only…laurel-kdf-probe:on…${ALL_MARKS}` ).length ).toBe( 1 );
		expect( Com_LibraryProblems( `…laurel-networks:all…laurel-kdf-probe:off…${ALL_MARKS}` ).length, "not the testnet build" ).toBe( 1 );
	} );

	it( "name the four modules, and read a feature list as the build does", () => {
		expect( MODULES ).toEqual( [ "offline-signing", "folder-sync", "prices", "repeat-payments" ] );
		expect( [ ...Com_Features( "testnet-only,full" ) ] ).toEqual( MODULES );
		expect( [ ...Com_Features( "testnet-only, prices" ) ] ).toEqual( [ "prices" ] );
		expect( [ ...Com_Features( "" ) ] ).toEqual( [] );
		expect( [ ...Com_Features( undefined ) ] ).toEqual( [] );
	} );

	it( "refuse a module's code where its feature is off, and miss none where it is on", () => {
		const repeats = Com_ModuleMark( "repeat-payments" );
		expect( Com_ModuleProblems( "…nothing…", new Set(), "the library" ) ).toEqual( [] );
		expect( Com_ModuleProblems( ALL_MARKS, new Set( MODULES ), "the library" ) ).toEqual( [] );
		const leaked = Com_ModuleProblems( `…${repeats}…`, new Set(), "the ui bundle" );
		expect( leaked.length ).toBe( 1 );
		expect( leaked[0] ).toContain( "repeat-payments" );
		expect( leaked[0] ).toContain( "the ui bundle" );
		expect( Com_ModuleProblems( "…", new Set( [ "prices" ] ), "the library" ).length, "on, and its code missing" ).toBe( 1 );
		expect( Com_ModuleProblems( "…", new Set( MODULES ), "the ui bundle", [ "repeat-payments" ] ).length, "only the modules named" ).toBe( 1 );
	} );

	// the site's promise: a build without prices never names their source, let alone asks it
	it( "refuse the price source's host where prices are off, in the library and the ui bundle", () => {
		const host = "https://api.coingecko.com/api/v3/coins/zcash/market_chart";
		expect( Com_ModuleProblems( `…${host}…`, new Set(), "the library" ).length ).toBe( 1 );
		expect( Com_ModuleProblems( `…${host}…`, new Set(), "the ui bundle", [ "repeat-payments" ] ), "only the modules named" ).toEqual( [] );
		expect( Com_ModuleProblems( `…${host}…${ALL_MARKS}`, new Set( MODULES ), "the library" ), "prices on: asked, as the person allows" ).toEqual( [] );
		expect( Com_ModuleProblems( "…Prices from CoinGecko…", new Set(), "the ui bundle" ), "the name in the ui's words isn't a request" ).toEqual( [] );
		expect( Com_LibraryProblems( `${V1}…coingecko.com…`, "v1" ).length ).toBe( 1 );
	} );

	it( "hold a testnet library to all four modules, and a v1 one to none", () => {
		expect( Com_LibraryProblems( TESTNET ).length, "a testnet build without `full` loses its testers' features" ).toBe( MODULES.length );
		expect( Com_LibraryProblems( V1 + ALL_MARKS, "v1" ).length, "v1 ships none of them" ).toBe( MODULES.length );
		expect( Com_LibraryProblems( V1, "v1" ) ).toEqual( [] );
	} );

	// D-035: prices passed its audit; a v1 exe has it only where its build names it (the Store's), and nothing else
	it( "let a v1 library carry an audited module its build names, and no other", () => {
		const prices = `${V1}${Com_ModuleMark( "prices" )}…api.coingecko.com…`;
		expect( Com_LibraryProblems( prices, "v1", [ "prices" ] ), "the Store's: named and there" ).toEqual( [] );
		expect( Com_LibraryProblems( prices, "v1" ).length, "Play's v1 names none: prices in it is refused" ).toBeGreaterThan( 0 );
		expect( Com_LibraryProblems( V1, "v1", [ "prices" ] ).length, "named and missing" ).toBe( 1 );
		expect( Com_LibraryProblems( `${V1}${Com_ModuleMark( "folder-sync" )}`, "v1", [ "folder-sync" ] ).length, "no audit, no way in" ).toBe( 1 );
	} );

	// D-033: v1 is the real-money build, mainnet alone: a beta library never goes out as it
	it( "hold a v1 library to the v1 build, and refuse a line that isn't one", () => {
		expect( Com_LibraryProblems( TESTNET, "v1" ).length, "the beta's library as v1" ).toBe( 1 );
		expect( Com_LibraryProblems( "…laurel-networks:all…laurel-kdf-probe:off…", "v1" ).length, "the desktop's two networks" ).toBe( 1 );
		expect( Com_LibraryProblems( V1 + ALL_MARKS, "testnet" ).length, "v1's library as the beta's" ).toBe( 1 );
		expect( Com_LibraryProblems( V1, "beta" ).length, "no such line" ).toBe( 1 );
	} );

	it( "say which build each Play line is, from the build's feature list", () => {
		expect( Com_LineProblems( "testnet", "testnet-only,full" ) ).toEqual( [] );
		expect( Com_LineProblems( "v1", "v1" ) ).toEqual( [] );
		expect( Com_LineProblems( "testnet", "testnet-only" ).length, "the beta without its modules" ).toBe( 1 );
		expect( Com_LineProblems( "v1", "v1,prices" ).length, "v1 with a module" ).toBe( 1 );
		expect( Com_LineProblems( "v1", "testnet-only" ).length, "the beta's build as v1" ).toBe( 1 );
		expect( Com_LineProblems( "testnet", "v1" ).length, "v1's build as the beta" ).toBeGreaterThan( 0 );
		expect( Com_LineProblems( "v1", "" ).length, "neither v1 nor testnet-only: the desktop's two networks" ).toBe( 1 );
		expect( Com_LineProblems( undefined, "v1" ).length, "a line must be named" ).toBe( 1 );
	} );

	it( "refuse a Cargo.toml that makes v1 the default build", () => {
		expect( Com_CargoProblems( CARGO + "default = [ \"v1\" ]\n" ).length ).toBe( 1 );
	} );
} );

// the public tree (scripts/public_export.mjs), with settings made up for the test: the
// internal files stay out, the public ones take their places, and a public file holds
// none of the words, as the settings say each is found
describe( "the public tree", () => {
	const SETTINGS = {
		files:	[ "notes/plan.md", "README.md" ],
		dirs:	[ "scratch/" ],
		words:	[ { text: "Acme", as: "any" }, { text: "big_box", as: "word" }, { text: "Cloudy", as: "path" } ],
		allow:	[ "org\\.acme\\.app" ],
	};
	const RULES = Com_WordRules( SETTINGS );

	it( "leaves the internal files out, and puts the public ones in their place", () => {
		for ( const p of [ "notes/plan.md", "scratch/x.txt", EXPORT_SETTINGS, "README.md" ] ) {
			expect( Com_PublicPath( p, SETTINGS ), p ).toBeNull();
		}
		expect( Com_PublicPath( "src/ui_main.tsx", SETTINGS ) ).toBe( "src/ui_main.tsx" );
		expect( Com_PublicPath( "public/README.md", SETTINGS ), "the public README, at the root" ).toBe( "README.md" );
	} );

	it( "finds each word as the settings say, and none in allowed text", () => {
		expect( Com_WordProblems( "a.md", "nothing\nhere", RULES ) ).toEqual( [] );
		expect( Com_WordProblems( "a.md", "one\n(C) acme Inc", RULES ) ).toEqual( [ "a.md:2: acme" ] );
		expect( Com_WordProblems( "a.kt", "package org.acme.app", RULES ), "allowed" ).toEqual( [] );
		expect( Com_WordProblems( "a.md", "in /work/big_box/docs and the big-box notes", RULES ).length, "a word, either spelling" ).toBe( 2 );
		expect( Com_WordProblems( "a.kts", "BIG_BOX_PASSWORD", RULES ), "not part of a longer word" ).toEqual( [] );
		expect( Com_WordProblems( "a.md", "a share (Cloudy, a NAS)", RULES ), "a path's folder only" ).toEqual( [] );
		expect( Com_WordProblems( "a.md", "see H:\\Cloudy\\x and H:/Cloudy/y", RULES ).length ).toBe( 2 );
	} );

	it( "checks nothing without its settings", () => {
		expect( Com_WordProblems( "a.md", "anything at all", Com_WordRules() ) ).toEqual( [] );
		expect( Com_PublicPath( "notes/plan.md" ) ).toBe( "notes/plan.md" );
	} );
} );

// T-055: WebView hands a password field's typed text to accessibility services, masked
// or not by the system's "Show passwords" setting (seen on API 35, WebView 124). From
// Android 14 a view marked accessibility-data-sensitive is closed to every accessibility
// app that isn't a declared accessibility tool; TalkBack still reads it
describe( "the Android activity", () => {
	it( "marks Laurel's web view sensitive to accessibility from Android 14, and keeps screenshots out", () => {
		expect( Com_ActivityProblems( MAIN_ACTIVITY ) ).toEqual( [] );
	} );

	it( "refuses an activity without either, and a commented-out or unguarded one", () => {
		const secure = "window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)\n";
		const marked = "if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {\n  webView.setAccessibilityDataSensitive(View.ACCESSIBILITY_DATA_SENSITIVE_YES)\n}\n";
		expect( Com_ActivityProblems( secure + marked ) ).toEqual( [] );
		expect( Com_ActivityProblems( secure ) ).toHaveLength( 1 );
		expect( Com_ActivityProblems( marked ) ).toHaveLength( 1 );
		expect( Com_ActivityProblems( secure + marked.split( "\n" ).map( ( l ) => `// ${l}` ).join( "\n" ) ) ).toHaveLength( 1 );
		expect( Com_ActivityProblems( secure + "webView.setAccessibilityDataSensitive(View.ACCESSIBILITY_DATA_SENSITIVE_YES)\n" ) ).toHaveLength( 1 );
	} );
} );

// docs/IOS.md: what iOS can't refuse (a screenshot) is covered instead, and the vault
// stays on the phone, saved before iOS ends Laurel, closed while the phone is locked
describe( "the iPhone's own side", () => {
	it( "covers, keeps out of backups, saves in the background, answers for its notifications and closes the files", () => {
		expect( Com_IosProblems( W_IOS, IOS_PROJECT ) ).toEqual( [] );
	} );

	it( "refuses one missing any of them, or with one commented out", () => {
		const ios = "UIApplicationWillResignActiveNotification\nUIScreenCapturedDidChangeNotification\nNSURLIsExcludedFromBackupKey\nbeginBackgroundTask\nUNUserNotificationCenterDelegate\n";
		const project = "      properties:\n        com.apple.developer.default-data-protection: NSFileProtectionCompleteUnlessOpen\n      base:\n        TARGETED_DEVICE_FAMILY: 1\n";
		expect( Com_IosProblems( ios, project ) ).toEqual( [] );
		expect( Com_IosProblems( ios.replace( "NSURLIsExcludedFromBackupKey", "" ), project ) ).toHaveLength( 1 );
		expect( Com_IosProblems( ios.replace( "\nNSURL", "\n// NSURL" ), project ) ).toHaveLength( 1 );
		expect( Com_IosProblems( ios, "" ) ).toHaveLength( 2 );
		expect( Com_IosProblems( ios, project.replace( "TARGETED_DEVICE_FAMILY: 1", "TARGETED_DEVICE_FAMILY: \"1,2\"" ) ) ).toHaveLength( 1 );
		expect( Com_IosProblems( ios, project.replace( "        com", "        # com" ) ) ).toHaveLength( 1 );
	} );

	it( "keeps the page from zooming into a field, out to the screen's edges", () => {
		const tag = ( content: string ) => `<meta name="viewport" content="${content}" />`;
		expect( Com_ViewportProblems( tag( "width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover" ) ) ).toEqual( [] );
		expect( Com_ViewportProblems( tag( "width=device-width, initial-scale=1.0, viewport-fit=cover" ) ) ).toHaveLength( 1 );
		expect( Com_ViewportProblems( tag( "width=device-width, maximum-scale=1" ) ) ).toHaveLength( 1 );
		expect( Com_ViewportProblems( "<title>Laurel</title>" ) ).toHaveLength( 1 );
	} );

	it( "takes only Laurel's opaque home screen icon", () => {
		const header = ( colour: number ) => Uint8Array.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 4, 0, 8, colour, 0, 0, 0 ] );
		const laurel = "0".repeat( 64 ), tauri = "00badc78c2ecb7460bbe02aeeca1e8848724ee133391bb3025df561007187eaf";
		expect( Com_IosIconProblems( header( 2 ), laurel ) ).toEqual( [] );
		expect( Com_IosIconProblems( header( 6 ), laurel ) ).toHaveLength( 1 );
		expect( Com_IosIconProblems( header( 2 ), tauri ) ).toHaveLength( 1 );
		expect( Com_IosIconProblems( new Uint8Array( 8 ), laurel ) ).toHaveLength( 1 );
	} );
} );
