/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_bundle.mjs -- the ui bundle of the build that leaves every module out
//
// vite.config.ts refuses a bundle holding a module its build leaves out
// (D-031), but only when one is made: two constants of ui_price.tsx once
// reached the real-money bundle, and the refusal came three minutes into
// an app build. The v1 bundle (mainnet, no module) is made here, in a
// throwaway folder, so a leak fails the checks instead.
//
//   node scripts/check_bundle.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync( join( tmpdir(), "laurel-bundle-" ) );
try {
	const run = spawnSync( process.execPath, [ "node_modules/vite/bin/vite.js", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error" ], {
		env:		{ ...process.env, LAUREL_FEATURES: "v1" },
		stdio:		"inherit",
		windowsHide: true,
	} );
	if ( run.status !== 0 ) {
		console.error( "check_bundle: the v1 ui bundle didn't build (above)" );
		process.exit( 1 );
	}
	console.log( "check_bundle: the v1 ui bundle builds, holding no module it leaves out" );
} finally {
	rmSync( out, { recursive: true, force: true } );
}
