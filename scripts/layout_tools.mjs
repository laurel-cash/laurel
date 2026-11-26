/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// layout_tools.mjs -- what both layout checks need to draw the real screens:
// the dev server (mock.html on it), a child's line awaited, a wait that says
// what never came. check_layout.mjs draws them in Edge, check_layout_ios.mjs
// in the iPhone's own WebKit

import { spawn } from "node:child_process";

// a promise, or the reason it never came
export const Com_Within = ( what, promise, ms ) => Promise.race( [ promise, new Promise( ( _, fail ) => setTimeout( () => fail( new Error( `${what} took over ${ms / 1000}s` ) ), ms ) ) ] );

// the first line of a child's output matching re
export const Com_Line = ( stream, re ) => new Promise( ( ok ) => {
	let text = "";
	stream.on( "data", ( d ) => {
		text += d;
		const m = re.exec( text );
		if ( m ) {
			ok( m );
		}
	} );
} );

/*
==================
Com_DevServer

The page with every module a build may leave out (D-031), as the testnet
line ships it, unless the run names its own (LAUREL_FEATURES), on port.
Resolves once it serves; kill() ends it
==================
*/
export async function Com_DevServer( port, ms ) {
	const server = spawn( process.execPath, [ "node_modules/vite/bin/vite.js", "--port", String( port ), "--strictPort" ], { stdio: "pipe", windowsHide: true, env: { ...process.env, LAUREL_FEATURES: process.env.LAUREL_FEATURES ?? "full" } } );
	await Com_Within( "the dev server", Com_Line( server.stdout, /Local/ ), ms );
	return server;
}
