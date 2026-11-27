/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_kit.mjs -- every phone screen, seen: pictures to look at, not only numbers
//
// Each screen and sheet of the phone's layout (mock.html, the iPhone's v1 build
// unless LAUREL_FEATURES says), on iPhones' sizes with their notch and home bar
// (--safe-top, --safe-bottom), at text sizes as the iPhone draws them
// (--text-scale: text_scale.mjs), at its top and scrolled to its end. Edge draws
// them: the iPhone's text size and safe areas are css variables, drawn alike in
// any browser. The layout faults check_layout.mjs looks for are listed beside.
//
// Out: out/kit/index.html, every picture with its faults; out/kit/sheet-*.jpg,
// one picture per phone and size, to look over at once.
//
//   npm run kit                          (all; Windows with Edge)
//   npm run kit -- --only=about,whats-new --scales=175 --phones=se

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Com_DevServer, Com_Edge, Com_Within, FRAMES } from "./layout_tools.mjs";
import { Com_ScreenUrl, IPHONES, SCREENS } from "./ui_screens.mjs";

const PORT		= 1435;
const OUT		= "out/kit";
const WAIT_MS	= 60_000;
const FIRST_MS	= WAIT_MS * 4;		// the first draw compiles the page's modules on a cold dev server (as check_layout.mjs's)
const POLL_MS	= 3_000;		// one ask of a loading page
const SCALE		= 2;		// device pixels per css pixel: sharp enough to read, small enough to look over

const FRAME_SCREEN	= "home";		// where the bars are pictured up close
const BAR_ROOM		= 72;		// css px past the safe area pictured: a bar and what's next to it
const ZOOM			= 2;		// the bars' pictures: times the screen's own
const SCALES = [ 100, 130, 175 ];		// of TEXT_SCALES (w_settings.rs): the default, the middle, the largest


// --only=a,b --scales=175 --phones=se
const ARGS = Object.fromEntries( process.argv.slice( 2 ).map( ( a ) => a.replace( /^--/, "" ).split( "=" ) ) );
const Pick = ( all, key, by ) => ( ARGS[key] ? all.filter( ( x ) => ARGS[key].split( "," ).includes( String( by( x ) ) ) ) : all );
const phones	= Pick( IPHONES, "phones", ( p ) => p.id );
const scales	= Pick( SCALES, "scales", ( s ) => s ).map( Number );
const screens	= Pick( SCREENS, "only", ( s ) => s.id );

// the page, as a phone's at that size: the notch and home bar, the text size, and then
// what scrolls: the open sheet, else the page's own scroller
// a block: one page runs it at each text size, and a second top-level const is an error
const SET = ( p, scale ) => `{
	const root = document.documentElement.style;
	root.setProperty( "--safe-top", "${p.top}px" );
	root.setProperty( "--safe-bottom", "${p.bottom}px" );
	${PHONE_SELF( p )}
}; await window.__setting( { textScale: ${scale} } )`;		// as Settings sets it: the Text Size control shows it

// what the phone draws over the page itself, drawn into each picture so the bars' room is
// seen as on the phone (an empty band hid how much there was, 11-27): the status bar's
// time and the island, and the home bar's line. Not the page's: aria-hidden, so no check
// reads it, and pointer-events none
const PHONE_SELF = ( p ) => `
	document.getElementById( "kit-phone" )?.remove();
	const self = document.createElement( "div" );
	self.id = "kit-phone";
	self.setAttribute( "aria-hidden", "true" );
	self.style.cssText = "position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font: 600 15px -apple-system, system-ui, sans-serif; color: CanvasText;";
	self.innerHTML = \`
		<span style="position: absolute; top: ${p.island ? p.island[0] + p.island[2] / 2 - 9 : 1}px; left: ${p.island ? 32 : 6}px; line-height: 18px; font-size: ${p.island ? 15 : 12}px">9:41</span>
		${p.island ? `<span style="position: absolute; top: ${p.island[0]}px; left: calc( 50% - ${p.island[1] / 2}px ); width: ${p.island[1]}px; height: ${p.island[2]}px; border-radius: ${p.island[2] / 2}px; background: #000"></span>` : ""}
		${p.bottom ? `<span style="position: absolute; bottom: 8px; left: calc( 50% - 67px ); width: 134px; height: 5px; border-radius: 3px; background: CanvasText; opacity: 0.8"></span>` : ""}
	\`;
	document.body.append( self );
`;
// what a finger scrolls: an open sheet, else the page (the document, on a phone)
const SCROLLER = `
	( () => {
		const sheet = document.querySelector( ".sheet" );
		if ( sheet ) return sheet;
		const page = document.scrollingElement;
		return page.scrollHeight > page.clientHeight + 1 ? page : null;
	} )()
`;
const Sleep = ( ms ) => new Promise( ( ok ) => setTimeout( ok, ms ) );

// where the time goes: each phase's total, said at the end
const SPENT = new Map();
async function Timed( phase, work ) {
	const t = performance.now();
	try {
		return await work;
	} finally {
		SPENT.set( phase, ( SPENT.get( phase ) ?? 0 ) + performance.now() - t );
	}
}

mkdirSync( OUT, { recursive: true } );
const T0 = performance.now();
process.env.LAUREL_FEATURES ??= "v1";		// the iPhone's build: what it leaves out isn't drawn
let server = null;
let edge = null;
const shots = [];		// { phone, scale, screen, at, file, faults, scroll }
try {
	server = await Timed( "start", Com_DevServer( PORT, WAIT_MS, "127.0.0.1" ) );
	edge = await Com_Edge( "ui_kit", WAIT_MS );
	// a tab's pictures, as files here
	const Tab = async ( name ) => {
		const tab = await edge.Tab( name );
		return { ...tab, Shot: async ( file, params = {} ) => writeFileSync( join( OUT, file ), Buffer.from( ( await tab.Send( "Page.captureScreenshot", params ) ).data, "base64" ) ) };
	};

	// one tab per phone, all at once (Edge started not to slow a tab it thinks is behind
	// another); each loads the page once and opens every screen in it (mock.html's __screen)
	const PICTURE = { format: "jpeg", quality: 85, optimizeForSpeed: true };		// a png took ~170ms each
	// the phone's bars up close, once per phone and size: the top bar under the status bar,
	// the tab bar over the home bar line. Whole-screen pictures shrunk to a sheet hid how
	// much room they took (11-27); these are drawn ZOOM times larger to read at a glance
	const Bars = async ( Picture, p, base ) => {
		await Picture( `${base}-bar-top.jpg`, { ...PICTURE, clip: { x: 0, y: 0, width: p.w, height: p.top + BAR_ROOM, scale: ZOOM } } );
		await Picture( `${base}-bar-tab.jpg`, { ...PICTURE, clip: { x: 0, y: p.h - p.bottom - BAR_ROOM, width: p.w, height: p.bottom + BAR_ROOM, scale: ZOOM } } );
	};
	const Phone = async ( p ) => {
		const { Send, Eval, Shot: Picture, Close } = await Tab( p.name );
		const Shot = ( file ) => Picture( file, PICTURE );
		await Send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 } );
		await Send( "Emulation.setDeviceMetricsOverride", { width: p.w, height: p.h, deviceScaleFactor: SCALE, mobile: true } );
		await Timed( "load", ( async () => {
			await Send( "Page.navigate", { url: Com_ScreenUrl( PORT, SCREENS[0], [ "check", "phone", "ios", "still", "password" ] ) } );
			const Ask = ( expression ) => Eval( expression, POLL_MS ).catch( () => false );
			// asked again until it's ready, each ask on its own short clock: one sent as the page
			// loads may never be answered
			await Com_Within( `${p.name}: the first draw`, ( async () => { while ( !await Ask( "!!window.__screen && !!document.querySelector( '.home-grid' )" ) ) await Sleep( 100 ); } )(), FIRST_MS );
		} )() );
		for ( const s of screens ) {
			await Timed( "screen", Eval( `window.__screen( ${JSON.stringify( s )} )` ) );
			for ( const scale of scales ) {
				// at its top before it's looked at, or what scrolls under the bar reads as drawn over it
				const top = await Timed( "set", Eval( `( async () => { ${SET( p, scale )}; const e = ${SCROLLER}; e?.scrollTo( { top: 0, behavior: "instant" } ); return e ? e.scrollTop : 0; } )()` ) );
				if ( top !== 0 ) {
					throw new Error( `${p.name}: ${s.id} at ${scale}%: didn't go back to its top (${top})` );
				}
				const look = await Timed( "faults", Eval( "window.__layout()" ) );
				const base = `${p.id}-${scale}-${s.id}`;
				await Timed( "frames", Eval( FRAMES ) );		// the fixed bars drawn again after the scroll back up (one picture lost its tab bar, 11-27)
				await Timed( "shot", Shot( `${base}-top.jpg` ) );
				if ( s.id === FRAME_SCREEN ) {
					await Timed( "shot", Bars( Picture, p, `${p.id}-${scale}` ) );
				}
				shots.push( { phone: p, scale, screen: s.id, at: "top", file: `${base}-top.jpg`, faults: look?.faults ?? [] } );
				const scroll = await Timed( "set", Eval( `( () => { const e = ${SCROLLER}; if ( !e ) return null; e.scrollTo( { top: e.scrollHeight, behavior: "instant" } ); return { top: Math.round( e.scrollTop ), height: e.scrollHeight, client: e.clientHeight }; } )()` ) );
				if ( scroll ) {
					await Timed( "frames", Eval( FRAMES ) );
					await Timed( "shot", Shot( `${base}-end.jpg` ) );
					shots.push( { phone: p, scale, screen: s.id, at: "end", file: `${base}-end.jpg`, faults: [], scroll } );
				}
			}
		}
		await Close();
	};
	await Timed( "phones", Promise.all( phones.map( Phone ) ) );
	const order = ( x ) => phones.indexOf( x.phone ) * 1e6 + scales.indexOf( x.scale ) * 1e4 + screens.findIndex( ( s ) => s.id === x.screen ) * 2 + ( x.at === "end" ? 1 : 0 );
	shots.sort( ( a, b ) => order( a ) - order( b ) );

	// the pictures, with their faults: one page of all, and one picture per phone and size
	const Card = ( x ) => `<figure><img src="${x.file}" width="${x.phone.w * 0.5}"><figcaption><b>${x.screen}</b> ${x.at}${x.scroll ? ` · scrolled ${x.scroll.top} of ${x.scroll.height - x.scroll.client}` : ""}${x.faults.map( ( f ) => `<div class="f">${f.replace( /</g, "&lt;" )}</div>` ).join( "" )}</figcaption></figure>`;
	const Page = ( list, title ) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>
		body { margin: 12px; font: 11px system-ui; background: #ddd; } h2 { font-size: 14px; margin: 18px 0 6px; }
		.row { display: flex; flex-wrap: wrap; gap: 8px; } figure { margin: 0; background: #fff; padding: 4px; }
		img { display: block; border: 1px solid #999; } figcaption { max-width: ${IPHONES[2].w * 0.5}px; } .f { color: #c00; }
	</style><h2>${title}</h2><div class="row">${list.map( Card ).join( "" )}</div>`;
	const groups = [];
	for ( const p of phones ) for ( const scale of scales ) groups.push( { p, scale, list: shots.filter( ( x ) => x.phone === p && x.scale === scale ) } );
	const BarsRow = ( g ) => `<h2>${g.p.name}, text ${g.scale}%: the bars up close</h2><div class="row">${[ "top", "tab" ].map( ( b ) => `<img src="${g.p.id}-${g.scale}-bar-${b}.jpg" width="${g.p.w}">` ).join( "" )}</div>`;
	writeFileSync( join( OUT, "index.html" ), groups.map( ( g ) => BarsRow( g ) + Page( g.list, `${g.p.name} ${g.p.w}x${g.p.h}, text ${g.scale}%` ) ).join( "" ) );
	await Timed( "sheets", Promise.all( groups.map( async ( g ) => {
		const file = `sheet-${g.p.id}-${g.scale}.html`;
		writeFileSync( join( OUT, file ), Page( g.list, `${g.p.name} ${g.p.w}x${g.p.h}, text ${g.scale}%` ) );
		const { Send, Eval, Shot, Close } = await Tab( file );
		await Send( "Emulation.setDeviceMetricsOverride", { width: 1800, height: 1000, deviceScaleFactor: 1, mobile: false } );
		await Send( "Page.navigate", { url: "file:///" + join( process.cwd(), OUT, file ).replace( /\\/g, "/" ) } );
		await Eval( "new Promise( ( ok ) => document.readyState === 'complete' ? ok() : addEventListener( 'load', ok ) )" );
		const { cssContentSize } = await Send( "Page.getLayoutMetrics" );
		await Shot( file.replace( ".html", ".jpg" ), { ...PICTURE, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1800, height: Math.ceil( cssContentSize.height ), scale: 1 } } );
		await Close();
	} ) ) );
	console.log( `ui_kit: ${( ( performance.now() - T0 ) / 1000 ).toFixed( 1 )}s in all;`, [ ...SPENT ].map( ( [ k, ms ] ) => `${k} ${( ms / 1000 ).toFixed( 1 )}s` ).join( ", " ) );
	const faults = shots.reduce( ( n, x ) => n + x.faults.length, 0 );
	console.log( `ui_kit: ${shots.length} pictures, ${faults} layout faults: ${OUT}/index.html, ${OUT}/sheet-*.jpg` );
} catch ( e ) {
	console.error( `ui_kit: ${e.message}` );
	process.exitCode = 1;
} finally {
	await edge?.Close();
	server?.kill();
}
process.exit();
