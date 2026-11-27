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
export const V1_MARK		= "laurel-networks:v1";		// the real-money build, mainnet alone (D-033)
export const PROBE_ON		= "laurel-kdf-probe:on";

// the modules a build may leave out (D-031), each a Cargo feature of that name,
// off unless named; `full` names all four. A module's code carries its mark,
// in the library (its MODULE_MARK, logged where it starts) and in the ui
// bundle (its screen's data-module): where the mark is, the code is
export const MODULES	= [ "offline-signing", "folder-sync", "prices", "repeat-payments" ];
export const Com_ModuleMark = ( module ) => `laurel-module:${module}`;
// the modules a v1 build may name, each after its own audit (lib.rs's compile_error
// says the same): prices, 2026-11-18 (D-035). The rest stay out of real money
export const V1_AUDITED	= [ "prices" ];

// the modules a feature list turns on, as Cargo reads it ("testnet-only,full")
export function Com_Features( list ) {
	const named = new Set( ( list ?? "" ).split( /[\s,]+/ ).filter( Boolean ) );
	return new Set( MODULES.filter( ( m ) => named.has( m ) || named.has( "full" ) ) );
}

// a module's code where its feature is off, or none where it is on: of every
// module, or of those named (the ui's, as each is cut: vite.config.ts UI_MODULES)
// A module's hosts: a build without it never names them (the site's promise for
// prices: no request to the price source, not even one that can't be made). The
// host, not the name: the ui's words may say "CoinGecko"
export const MODULE_HOSTS = { "prices": [ "coingecko.com" ] };

export function Com_ModuleProblems( text, on, where, modules = MODULES ) {
	const problems = [];
	for ( const module of modules ) {
		const has = text.includes( Com_ModuleMark( module ) );
		if ( has && !on.has( module ) ) {
			problems.push( `${where} has ${module}'s code, and this build leaves it out (D-031)` );
		}
		for ( const host of on.has( module ) ? [] : MODULE_HOSTS[module] ?? [] ) {
			if ( text.includes( host ) ) {
				problems.push( `${where} names ${host}, ${module}'s host, and this build leaves ${module} out (D-031)` );
			}
		}
		if ( !has && on.has( module ) ) {
			problems.push( `${where} has no ${module} code, and this build turns it on: the feature didn't reach it` );
		}
	}
	return problems;
}

// Cargo.toml: the engine's mixnet transport stays out (standing
// constraints), and neither the KDF probe nor a module is on by default
export function Com_CargoProblems( cargo ) {
	const problems = [];
	if ( /["']nym["']|zingolib\/nym/.test( cargo ) ) {
		problems.push( "src-tauri/Cargo.toml turns on zingolib's nym feature: the mixnet path stays off without a new legal review" );
	}
	const byDefault = /^\s*default\s*=\s*\[([^\]]*)\]/m.exec( cargo )?.[1] ?? "";
	if ( /["']kdf-probe["']/.test( byDefault ) ) {
		problems.push( "src-tauri/Cargo.toml turns the kdf-probe feature on by default: it is a test build's only (w_probe.rs)" );
	}
	if ( [ "full", ...MODULES ].some( ( m ) => byDefault.includes( `"${m}"` ) || byDefault.includes( `'${m}'` ) ) ) {
		problems.push( "src-tauri/Cargo.toml turns a module on by default: a build gets one only by naming it (D-031)" );
	}
	if ( /["']v1["']/.test( byDefault ) ) {
		problems.push( "src-tauri/Cargo.toml makes v1 the default build: real money is built only by naming it (D-033)" );
	}
	return problems;
}

// Play's two lines, each one build (D-033): the beta's test coins with every module for
// its testers (testnet-only,full), and v1, real money, mainnet alone and no module. A
// build with neither is the desktop's two networks, never Play's; a line must be named
export const LINES = [ "testnet", "v1" ];

export function Com_LineProblems( line, features ) {
	const named = new Set( ( features ?? "" ).split( /[\s,]+/ ).filter( Boolean ) );
	const modules = Com_Features( features );
	if ( !LINES.includes( line ) ) {
		return [ `name the line: --line ${LINES.join( " or --line " )}` ];
	}
	const problems = [];
	if ( line === "testnet" ) {
		if ( !named.has( "testnet-only" ) || named.has( "v1" ) ) {
			problems.push( `the testnet line is the testnet-only build, and this is --features ${features || "(none)"}: build with --features testnet-only,full` );
		}
		if ( modules.size !== MODULES.length ) {
			problems.push( `the testnet line has every module (${MODULES.filter( ( m ) => !modules.has( m ) ).join( ", " )} missing): build with --features testnet-only,full` );
		}
	}
	if ( line === "v1" ) {
		if ( !named.has( "v1" ) || named.has( "testnet-only" ) ) {
			problems.push( `the v1 line is the v1 build, and this is --features ${features || "(none)"}: build with --features v1` );
		} else if ( modules.size ) {
			problems.push( `v1 ships no module until its own audit (${[ ...modules ].join( ", " )}): build with --features v1` );
		}
	}
	return problems;
}

/*
==================
Com_ActivityProblems

The Android activity (MainActivity.kt) keeps screenshots and the task
switcher's preview out (FLAG_SECURE), and from Android 14 marks Laurel's
web view sensitive to accessibility (T-055): WebView hands a password
field's typed text to every accessibility service, and a sensitive view
is closed to all but declared accessibility tools (TalkBack still reads
it). Below 14 there's no such mark: SECURITY.md says so. Code in comments
doesn't count, and the mark must sit behind its API check
==================
*/
export function Com_ActivityProblems( activity ) {
	const code = Com_Uncommented( activity );
	const problems = [];
	if ( !/addFlags\(\s*WindowManager\.LayoutParams\.FLAG_SECURE\s*\)/.test( code ) ) {
		problems.push( "MainActivity.kt doesn't set FLAG_SECURE: screenshots and the task switcher would show recovery phrases and balances" );
	}
	const guarded = /SDK_INT\s*>=\s*(Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE|34)\b[^}]*?(setAccessibilityDataSensitive\(\s*View\.ACCESSIBILITY_DATA_SENSITIVE_YES\s*\)|accessibilityDataSensitive\s*=\s*View\.ACCESSIBILITY_DATA_SENSITIVE_YES)/;
	if ( !guarded.test( code ) ) {
		problems.push( "MainActivity.kt doesn't mark the web view accessibility-data-sensitive behind SDK_INT >= UPSIDE_DOWN_CAKE (T-055): any accessibility app could read what's typed in Laurel" );
	}
	return problems;
}

// source without its // comment lines: a rule never counts code that's commented out
export function Com_Uncommented( text ) {
	return text.split( "\n" ).filter( ( l ) => !/^\s*\/\//.test( l ) ).join( "\n" );
}

/*
==================
Com_IosProblems

The iPhone's twin of Com_ActivityProblems (docs/IOS.md). iOS can't refuse
a screenshot, so w_ios.rs covers the page while Laurel isn't the active
app (the app switcher's picture) and while the screen is captured; it
keeps the data folders out of backups, saves in a background task, and
answers for its own notifications.
project.yml closes the app's files while the phone is locked, and makes
an iPhone app (no iPad layout was ever looked at). Code in comments
doesn't count
==================
*/
const IOS_NEEDS = [
	[ /UIApplicationWillResignActiveNotification/,	"doesn't cover the page when Laurel leaves the foreground: the app switcher's picture would show balances and phrases" ],
	[ /UIScreenCapturedDidChangeNotification/,		"doesn't cover the page while the screen is recorded or mirrored" ],
	[ /NSURLIsExcludedFromBackupKey/,				"doesn't keep the data folders out of iCloud backups: the vault would leave the phone" ],
	[ /beginBackgroundTask/,						"doesn't ask for time to save in the background: iOS may end Laurel mid-write" ],
	[ /UNUserNotificationCenterDelegate/,			"leaves its notifications to the plugin: a tap after iOS ended Laurel stops the app (Ios_Notices)" ],
];

export function Com_IosProblems( ios, project ) {
	const code = Com_Uncommented( ios );
	const problems = IOS_NEEDS.filter( ( [ shape ] ) => !shape.test( code ) ).map( ( [ , why ] ) => `w_ios.rs ${why}` );
	if ( !/^\s*com\.apple\.developer\.default-data-protection:\s*NSFileProtectionComplete(UnlessOpen)?\s*$/m.test( project ) ) {
		problems.push( "project.yml doesn't protect the app's files (default-data-protection): they'd be readable while the phone is locked" );
	}
	if ( !/^\s*TARGETED_DEVICE_FAMILY:\s*"1,2"\s*$/m.test( project ) ) {
		problems.push( "project.yml doesn't make an iPhone and iPad app (TARGETED_DEVICE_FAMILY: \"1,2\"): the kit pictures iPads, and the App Store has iPad screenshots" );
	}
	const ipad = project.match( /UISupportedInterfaceOrientations~ipad:\n((?:[ \t]+- \S+\n)+)/ )?.[1] ?? "";
	if ( [ "Portrait", "PortraitUpsideDown", "LandscapeLeft", "LandscapeRight" ].some( ( o ) => !new RegExp( `- UIInterfaceOrientation${o}\n` ).test( ipad ) ) ) {
		problems.push( "project.yml doesn't turn an iPad every way (UISupportedInterfaceOrientations~ipad): Split View and Slide Over need all four" );
	}
	return problems;
}

/*
==================
Com_IosIconProblems

The home screen's icon (the 1024 point one, AppIcon-512@2x.png, and its
SHA-256): not Tauri's placeholder, which `tauri ios init` leaves in place
(build 0.3.3 (8) went to TestFlight with it), and opaque: App Store
Connect refuses an alpha channel. Laurel's is full bleed: iOS rounds the
corners itself
==================
*/
const TAURI_ICON = "00badc78c2ecb7460bbe02aeeca1e8848724ee133391bb3025df561007187eaf";

export function Com_IosIconProblems( png, sha256 ) {
	const PNG = [ 0x89, 0x50, 0x4e, 0x47 ];
	if ( png.length < 26 || PNG.some( ( b, i ) => png[ i ] !== b ) ) {
		return [ "AppIcon-512@2x.png isn't a PNG" ];
	}
	const problems = [];
	if ( sha256 === TAURI_ICON ) {
		problems.push( "AppIcon-512@2x.png is Tauri's placeholder, not Laurel's icon" );
	}
	const RGB = 2;		// IHDR colour type: 6 is RGBA
	if ( png[ 25 ] !== RGB ) {
		problems.push( "AppIcon-512@2x.png has an alpha channel: App Store Connect refuses it" );
	}
	return problems;
}

/*
==================
Com_ViewportProblems

index.html's viewport: the page to the screen's edges (viewport-fit, the
safe areas), and no zoom of its own (maximum-scale): iOS zooms into a
field under 16px as it takes focus and stays zoomed. Laurel's text size
is its setting (useTextScale)
==================
*/
export function Com_ViewportProblems( html ) {
	const viewport = html.match( /<meta\s+name="viewport"\s+content="([^"]*)"/ )?.[ 1 ];
	if ( viewport === undefined ) {
		return [ "index.html has no viewport" ];
	}
	const problems = [];
	if ( !/\bmaximum-scale=1(\.0)?\b/.test( viewport ) ) {
		problems.push( "index.html's viewport lets the page zoom: iOS zooms into a small field when it takes focus" );
	}
	if ( !/\bviewport-fit=cover\b/.test( viewport ) ) {
		problems.push( "index.html's viewport doesn't reach the screen's edges (viewport-fit=cover): the safe areas go unpadded" );
	}
	return problems;
}

// the phone's library, or the Store's exe. The testnet line (the Play beta): the
// testnet build, with all four modules for its testers. v1: the v1 build, with
// exactly the audited modules its build names (`modules`, none unless named: D-033,
// D-035). Neither the KDF probe's
export function Com_LibraryProblems( library, line = "testnet", modules = [] ) {
	if ( !LINES.includes( line ) ) {
		return [ `no line ${line}: ${LINES.join( " or " )}` ];
	}
	const problems = [];
	const unaudited = modules.filter( ( m ) => !V1_AUDITED.includes( m ) );
	if ( line === "v1" && unaudited.length ) {
		return [ `v1 ships no module until its own audit (${unaudited.join( ", " )}): only ${V1_AUDITED.join( ", " )} has had one` ];
	}
	if ( line === "testnet" && !library.includes( TESTNET_MARK ) ) {
		problems.push( "the library isn't the testnet build (NETWORKS_MARK): build with --features testnet-only,full" );
	}
	if ( line === "v1" && !library.includes( V1_MARK ) ) {
		problems.push( "the library isn't the v1 build, mainnet alone (NETWORKS_MARK): build with --features v1" );
	}
	if ( library.includes( PROBE_ON ) ) {
		problems.push( "the library is a KDF probe build (kdf-probe): a test build's only, never Play's" );
	}
	problems.push( ...Com_ModuleProblems( library, line === "testnet" ? new Set( MODULES ) : new Set( modules ), "the library" ) );
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
