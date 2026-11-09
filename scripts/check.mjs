/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check.mjs -- the gate (npm run check): every check, at once where they
// can be, each timed
//
// The checks once ran one after another, each through a new npm (npx
// alone took 15 seconds to find tsc): minutes, most of them waiting. Now
// the ui's checks run side by side, beside the Rust ones: the engine's
// and the app's each in order (cargo builds a target folder under one
// lock), the two apart, as their target folders are. Each tool is
// started directly.
// A step's output is shown only when it fails; the times always. The
// steps are written here only: package.json's lint, dupes, layout and
// the rest name them.
//
// Every step has a deadline, and the gate always ends with its "check:"
// line: a hung step once left the gate, and a wait on it, running for
// fifty minutes. Warm, every step takes under 30 seconds; one past
// STEP_LIMIT_SECS is stopped, its whole process tree, and failed. A change
// that rebuilds the engine (its build script, Cargo.toml) makes one cold
// run of minutes: say so with --cold.
//
//   node scripts/check.mjs                  every step
//   node scripts/check.mjs lint test-ui     those steps
//   node scripts/check.mjs --cold [steps]   once, after a change that rebuilds

import { spawn, spawnSync } from "node:child_process";
import { constants, setPriority } from "node:os";

// below normal, and every step it starts with it (Windows hands a process's priority
// on): the gate uses idle cpu, and the person's own work comes first
try {
	setPriority( constants.priority.PRIORITY_BELOW_NORMAL );
} catch {
	// not permitted here: the gate runs at the priority it was given
}

const NODE = process.execPath;
const APP = "src-tauri";
const ENGINE = "vendor/zingolib";

// the ui's checks: independent of each other and of Rust
const UI = [
	[ "types",		NODE, [ "node_modules/typescript/bin/tsc", "--noEmit" ] ],
	[ "lint-ui",	NODE, [ "node_modules/eslint/bin/eslint.js", "src" ] ],
	[ "dupes",		NODE, [ "node_modules/jscpd/run-jscpd.js", "src", "src-tauri/src" ] ],
	[ "loads",		NODE, [ "scripts/check_loads.mjs" ] ],
	[ "owners",		NODE, [ "scripts/check_owners.mjs" ] ],
	[ "docs",		NODE, [ "scripts/check_docs.mjs" ] ],
	[ "contrast",	NODE, [ "scripts/check_contrast.mjs" ] ],
	[ "version",	NODE, [ "scripts/check_version.mjs" ] ],
	[ "release",	NODE, [ "scripts/check_release.mjs" ] ],
	[ "public",		NODE, [ "scripts/public_export.mjs", "--check" ] ],		// the public tree, as the export settings say (release_rules.mjs)
	[ "eol",		NODE, [ "scripts/check_eol.mjs" ] ],		// the bytes checked are the bytes committed
	[ "fork",		NODE, [ "scripts/engine.mjs", "check" ] ],		// vendor/zingolib is upstream + the recorded patch (docs/ENGINE.md)
	[ "notices",	NODE, [ "scripts/make_notices.mjs", "--check" ] ],
	[ "test-ui",	NODE, [ "node_modules/vitest/vitest.mjs", "run" ] ],
	[ "layout",		NODE, [ "scripts/check_layout.mjs" ] ],
];

// the Rust checks: each workspace's in order (one build lock, and each builds on the last)
const CLIPPY_APP = [ "-A", "clippy::all", "-D", "clippy::disallowed_methods", "-D", "clippy::await_holding_invalid_type", "-D", "clippy::await_holding_lock", "-D", "clippy::await_holding_refcell_ref" ];
const ENGINE_STEPS = [
	[ "lint-engine",	"cargo", [ "clippy", "-q", "-p", "zingolib", "--lib", "--tests", "--", "-A", "clippy::all", "-D", "clippy::disallowed_methods" ], ENGINE ],
	[ "test-engine",	"cargo", [ "test", "-q", "-p", "zingolib", "--lib", "--", "wallet::disk", "wallet::keys::seed", "wallet::utils", "wallet::sapling_key", "transmit_verdict" ], ENGINE ],
];
const APP_STEPS = [
	[ "lint",			"cargo", [ "clippy", "-q", "--workspace", "--lib", "--tests", "--examples", "--", ...CLIPPY_APP ], APP ],
	[ "test",			"cargo", [ "test", "-q", "--workspace", "--lib" ], APP ],
	// the build that ships to Play: a test that held only without it once failed unseen
	[ "test-testnet",	"cargo", [ "test", "-q", "--workspace", "--lib", "--features", "testnet-only" ], APP ],
];
const RUST = [ ...ENGINE_STEPS, ...APP_STEPS ];

const COLD = process.argv.includes( "--cold" );
const STEP_LIMIT_SECS = Number( process.env.CHECK_STEP_SECS ) || ( COLD ? 900 : 60 );		// the env only to test the deadline itself

// the step and everything it started (cargo's rustc, vitest's workers, Edge)
function Stop( child ) {
	if ( process.platform === "win32" ) {
		spawnSync( "taskkill", [ "/pid", String( child.pid ), "/t", "/f" ], { windowsHide: true, stdio: "ignore" } );
	} else {
		child.kill( "SIGKILL" );
	}
}

// one step: its time, and its output kept for a failure; stopped at its deadline
function Run( [ name, cmd, args, cwd ] ) {
	const started = Date.now();
	return new Promise( ( done ) => {
		const child = spawn( cmd, args, { cwd: cwd ?? ".", windowsHide: true, shell: false } );
		let out = "";
		let late = false;
		const deadline = setTimeout( () => {
			late = true;
			out += `
stopped after ${STEP_LIMIT_SECS}s. Warm, no step takes 30s: something is stuck or rebuilding. After a change that rebuilds the engine, run once with --cold.`;
			Stop( child );
		}, STEP_LIMIT_SECS * 1000 );
		child.stdout.on( "data", ( d ) => { out += d; } );
		child.stderr.on( "data", ( d ) => { out += d; } );
		child.on( "error", ( e ) => { out += String( e ); } );
		child.on( "close", ( code ) => {
			clearTimeout( deadline );
			done( { name: name, ok: code === 0 && !late, secs: ( Date.now() - started ) / 1000, out: out } );
		} );
	} );
}

async function InOrder( steps ) {
	const results = [];
	for ( const step of steps ) {
		const r = await Run( step );
		results.push( r );
		if ( !r.ok ) {
			break;		// a later step builds on this one: its failure would only repeat
		}
	}
	return results;
}

// by name, when some are named; a name that is no step is refused, never run as nothing
const asked = process.argv.slice( 2 ).filter( ( a ) => a !== "--cold" );
const unknown = asked.filter( ( n ) => ![ ...UI, ...RUST ].some( ( s ) => s[0] === n ) );
if ( unknown.length ) {
	console.error( `check: no step ${unknown.join( ", " )}; the steps are ${[ ...UI, ...RUST ].map( ( s ) => s[0] ).join( ", " )}` );
	process.exit( 2 );
}
const chosen = ( steps ) => asked.length ? steps.filter( ( s ) => asked.includes( s[0] ) ) : steps;

const started = Date.now();
// a cold run compiles on every core, and the UI tests' 5 s limits ran out under it (four
// times on 2026-09-30, a different handful each time): cold, they wait for the builds.
// Warm, everything runs at once
const LATE = COLD ? [ "test-ui" ] : [];
const early = ( await Promise.all( [ ...chosen( UI ).filter( ( s ) => !LATE.includes( s[0] ) ).map( Run ), InOrder( chosen( ENGINE_STEPS ) ), InOrder( chosen( APP_STEPS ) ) ] ) ).flat();
const late = await InOrder( chosen( UI ).filter( ( s ) => LATE.includes( s[0] ) ) );
const results = [ ...early, ...late ];

let failed = 0;
for ( const r of results ) {
	console.log( `${r.ok ? "ok  " : "FAIL"} ${r.secs.toFixed( 1 ).padStart( 6 )}s  ${r.name}` );
}
for ( const r of results.filter( ( r ) => !r.ok ) ) {
	failed++;
	console.error( `\n---- ${r.name} ----\n${r.out.trim()}` );
}
console.log( `\ncheck: ${results.length - failed} of ${results.length} passed in ${( ( Date.now() - started ) / 1000 ).toFixed( 1 )}s` );
process.exit( failed ? 1 : 0 );
