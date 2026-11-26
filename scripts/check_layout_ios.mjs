/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_layout_ios.mjs -- the phone's screens in the iPhone's own WebKit: Mobile
// Safari in the simulator, driven by safaridriver, with the home bar's safe area
// and a finger's swipe. What Edge's check (check_layout.mjs) can't see: on an
// iPhone (TestFlight 0.3.3, 11-26) About ended at Terms of Use and wouldn't
// scroll, while Edge and desktop WebKit scrolled it to the end.
//
// For each pane and sheet: swiped up until it stops, the last thing in it must be
// above the bottom bar, and a sheet's Close on screen. Pictures and numbers to
// out/web either way.
//
//   node scripts/check_layout_ios.mjs      (macOS with Xcode; CI: ios.yml's Web job)

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Com_DevServer } from "./layout_tools.mjs";

const PORT		= 1434;
const DRIVER	= 4444;
const OUT		= "out/web";
const WAIT_MS	= 120_000;		// a cold dev server and a simulator booting
const HOST		= "127.0.0.1";	// never "localhost": node took it for IPv6, and safaridriver listens on IPv4 alone (11-26)

// the screens: a pane (?pane=), or a sheet a pane's button opens. last: the thing that
// must end above the bottom bar once swiped to the end
const PANES = [
	{ name: "about",	pane: "about",		last: ".settings-list .set-row:last-child .btn" },
	{ name: "general",	pane: "general",	last: ".settings-section:last-of-type" },
	{ name: "security",	pane: "security",	last: ".settings-section:last-of-type" },
];
const SHEETS = [
	{ name: "whats-new",		pane: "about",	open: ".settings-list .set-row:nth-child(1) .btn" },
	{ name: "laurel-license",	pane: "about",	open: ".settings-list .set-row:nth-child(2) .btn" },
	{ name: "licenses",			pane: "about",	open: ".settings-list .set-row:nth-child(3) .btn" },
];

const Sleep = ( ms ) => new Promise( ( ok ) => setTimeout( ok, ms ) );

// the W3C WebDriver protocol, one session
async function Wd( method, path, body ) {
	const r = await fetch( `http://${HOST}:${DRIVER}${path}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify( body ) } );
	const j = await r.json();
	if ( j.value?.error ) {
		throw new Error( `${method} ${path}: ${j.value.error}: ${j.value.message}` );
	}
	return j.value;
}

// the page's numbers: the bottom bar's top, and for sel its box and its scroller's
const MEASURE = `
	const [ sel ] = arguments;
	const box = ( e ) => e && ( ( r ) => ( { top: Math.round( r.top ), bottom: Math.round( r.bottom ) } ) )( e.getBoundingClientRect() );
	const scroller = ( e ) => { for ( ; e; e = e.parentElement ) { const s = getComputedStyle( e ); if ( /auto|scroll/.test( s.overflowY ) && e.scrollHeight > e.clientHeight ) return e; } return null; };
	const it = document.querySelector( sel );
	const sc = scroller( it );
	const probe = Object.assign( document.createElement( "div" ), { style: "position:fixed;bottom:0;padding-bottom:env(safe-area-inset-bottom)" } );
	document.body.append( probe );
	const safe = probe.getBoundingClientRect().height;
	probe.remove();
	return { innerHeight, visual: Math.round( visualViewport.height ), safe, bar: box( document.querySelector( ".sidebar .nav" ) ), it: box( it ),
		scroller: sc && { cls: sc.className, top: sc.scrollTop, height: sc.scrollHeight, client: sc.clientHeight } };
`;

async function Look( session, sel ) {
	return Wd( "POST", `/session/${session}/execute/sync`, { script: MEASURE, args: [ sel ] } );
}

// a finger from low on the screen to high, slowly: what a person does to see more
async function Swipe( session, x, from, to ) {
	await Wd( "POST", `/session/${session}/actions`, { actions: [ { type: "pointer", id: "finger", parameters: { pointerType: "touch" }, actions: [
		{ type: "pointerMove", duration: 0, x, y: from }, { type: "pointerDown", button: 0 },
		{ type: "pointerMove", duration: 500, x, y: to }, { type: "pointerUp", button: 0 } ] } ] } );
	await Wd( "DELETE", `/session/${session}/actions` );
	await Sleep( 900 );		// the momentum, run out
}

async function Shot( session, name ) {
	writeFileSync( `${OUT}/${name}.png`, Buffer.from( await Wd( "GET", `/session/${session}/screenshot` ), "base64" ) );
}

// swiped up until it stops moving (or six times), then looked at
async function SwipedToEnd( session, sel ) {
	let seen = await Look( session, sel );
	const before = seen;
	for ( let i = 0; i < 6; i++ ) {
		const h = seen.innerHeight;
		await Swipe( session, 180, Math.round( h * 0.75 ), Math.round( h * 0.25 ) );
		const now = await Look( session, sel );
		const moved = now.scroller?.top !== seen.scroller?.top;
		seen = now;
		if ( !moved ) {
			break;
		}
	}
	return { before, after: seen };
}

mkdirSync( OUT, { recursive: true } );
let server = null;
let driver = null;
let session = null;
const faults = [];
try {
	server = await Com_DevServer( PORT, WAIT_MS, HOST );
	driver = spawn( "safaridriver", [ "-p", String( DRIVER ) ], { stdio: "inherit" } );
	for ( let i = 0; i < 40; i++ ) {		// until it answers, not a guessed wait
		if ( await fetch( `http://${HOST}:${DRIVER}/status` ).then( ( r ) => r.ok, () => false ) ) {
			break;
		}
		await Sleep( 500 );
	}
	( { sessionId: session } = await Wd( "POST", "/session", { capabilities: { alwaysMatch: {
		browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceType": "iPhone",
		...( process.env.IOS_UDID ? { "safari:deviceUDID": process.env.IOS_UDID } : {} ) } } } ) );		// the one booted for it (ios.yml)

	const Open = async ( pane ) => {
		await Wd( "POST", `/session/${session}/url`, { url: `http://${HOST}:${PORT}/mock.html?check&phone&pane=${pane}` } );
		await Sleep( 5000 );		// the pane, opened 1.5s after the dashboard draws
	};

	for ( const p of PANES ) {
		await Open( p.pane );
		await Shot( session, `${p.name}-top` );
		const { before, after } = await SwipedToEnd( session, p.last );
		await Shot( session, `${p.name}-end` );
		console.log( p.name, JSON.stringify( { before, after } ) );
		if ( !after.it || !after.bar || after.it.bottom > after.bar.top ) {
			faults.push( `${p.name}: its end (${p.last}) stays under the bottom bar after swiping: ${JSON.stringify( after )}` );
		}
	}

	for ( const s of SHEETS ) {
		await Open( s.pane );
		await Wd( "POST", `/session/${session}/execute/sync`, { script: "document.querySelector( arguments[0] ).click()", args: [ s.open ] } );
		await Sleep( 1500 );
		await Shot( session, `${s.name}-open` );
		const { before, after } = await SwipedToEnd( session, ".sheet .sheet-buttons .btn:last-child" );
		await Shot( session, `${s.name}-end` );
		console.log( s.name, JSON.stringify( { before, after } ) );
		if ( !after.it || after.it.bottom > after.visual - after.safe ) {
			faults.push( `${s.name}: its Close isn't on screen after swiping: ${JSON.stringify( after )}` );
		}
	}
} catch ( e ) {
	faults.push( `check_layout_ios: ${e.message}` );
} finally {
	if ( session ) {
		await Wd( "DELETE", `/session/${session}` ).catch( () => {} );
	}
	driver?.kill();
	server?.kill();
}
for ( const f of faults ) {
	console.error( f );
}
console.log( faults.length ? `check_layout_ios: ${faults.length} faults (pictures in ${OUT})` : `check_layout_ios: every pane and sheet reaches its end on the iPhone (pictures in ${OUT})` );
process.exit( faults.length ? 1 : 0 );
