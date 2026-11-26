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
// what never came, and a headless Edge with its tabs. check_layout.mjs
// measures the screens, ui_kit.mjs pictures them

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

// a page's next two frames: re-laid out after a change, before it's measured or pictured
export const FRAMES = "new Promise( ( ok ) => requestAnimationFrame( () => requestAnimationFrame( ok ) ) )";

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
On host when said (vite's own choice may be IPv6 alone). Resolves once it
serves; kill() ends it
==================
*/
export async function Com_DevServer( port, ms, host ) {
	const server = spawn( process.execPath, [ "node_modules/vite/bin/vite.js", "--port", String( port ), "--strictPort", ...( host ? [ "--host", host ] : [] ) ], { stdio: "pipe", windowsHide: true, env: { ...process.env, LAUREL_FEATURES: process.env.LAUREL_FEATURES ?? "full" } } );
	await Com_Within( "the dev server", Com_Line( server.stdout, /Local/ ), ms );
	return server;
}

/*
==================
Com_Cdp

The DevTools protocol over the browser's socket: send( method, params,
session ) answers with the result, or throws the browser's error
==================
*/
export async function Com_Cdp( url ) {
	const socket = new WebSocket( url );
	await new Promise( ( ok, fail ) => { socket.onopen = ok; socket.onerror = () => fail( new Error( "no DevTools socket" ) ); } );
	let next = 0;
	const waiting = new Map();
	socket.onmessage = ( e ) => {
		const m = JSON.parse( e.data );
		const w = waiting.get( m.id );
		if ( w ) {
			waiting.delete( m.id );
			m.error ? w.fail( new Error( m.error.message ) ) : w.ok( m.result );
		}
	};
	const send = ( method, params = {}, sessionId ) => new Promise( ( ok, fail ) => {
		const id = ++next;
		waiting.set( id, { ok, fail } );
		socket.send( JSON.stringify( { id, method, params, sessionId } ) );
	} );
	return { send, close: () => socket.close() };
}

/*
==================
Com_Edge

A headless Edge of its own (a fresh profile, removed after), every tab at
full speed: tabs draw side by side and none is the one in front. ms: the
longest any one call may take, said by name. Tab( name ) is a new tab:
Send( method, params ) to it, Eval( expression ) on its page (awaited, by
value), Close(). Close() ends Edge: closed, not killed, so its helpers let
go of the profile; a slow exit is killed and said, never a fault
==================
*/
export async function Com_Edge( name, ms ) {
	const profile = mkdtempSync( join( tmpdir(), `laurel-${name}-` ) );
	const edge = spawn( EDGE, [ `--user-data-dir=${profile}`, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--remote-debugging-port=0", "about:blank" ], { windowsHide: true } );
	const exited = new Promise( ( ok ) => edge.on( "exit", ok ) );
	const Close = async () => {
		await cdp?.send( "Browser.close" ).catch( () => {} );
		if ( !await Com_Within( "Edge closing", exited, ms ).then( () => true, () => false ) ) {
			console.warn( `${name}: Edge took over ${ms / 1000}s to close: killed it` );
		}
		cdp?.close();
		edge.kill();
		try {
			rmSync( profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } );
		} catch {
			// a browser helper still holding a file: the system's temp folder is cleared anyway
		}
	};
	let cdp = null;
	try {
		const [ , ws ] = await Com_Within( "Edge", Com_Line( edge.stderr, /DevTools listening on (ws:\/\/\S+)/ ), ms );
		cdp = await Com_Cdp( ws );
	} catch ( e ) {
		await Close();
		throw e;
	}
	const Tab = async ( tab ) => {
		const { targetId } = await cdp.send( "Target.createTarget", { url: "about:blank" } );
		const { sessionId } = await cdp.send( "Target.attachToTarget", { targetId, flatten: true } );
		const Send = ( method, params = {} ) => cdp.send( method, params, sessionId );
		await Send( "Emulation.setFocusEmulationEnabled", { enabled: true } );		// focused, as Laurel's window is
		return {
			Send,
			// wait 0: no deadline of its own, its caller's
			Eval:	async ( expression, wait = ms ) => {
				const answer = Send( "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true } );
				return ( await ( wait ? Com_Within( `${tab}: the page`, answer, wait ) : answer ) ).result?.value;
			},
			Close:	() => cdp.send( "Target.closeTarget", { targetId } ),
		};
	};
	return { Tab, Close };
}
