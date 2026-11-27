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
//   npm run kit -- --store               (the App Store's: below)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Com_DevServer, Com_Edge, Com_Within, FRAMES } from "./layout_tools.mjs";
import { Com_ScreenUrl, DEVICES, SCREENS } from "./ui_screens.mjs";

const PORT		= 1435;
const OUT		= "out/kit";		// out/store, with --store (below)
const WAIT_MS	= 60_000;
const FIRST_MS	= WAIT_MS * 4;		// the first draw compiles the page's modules on a cold dev server (as check_layout.mjs's)
const POLL_MS	= 3_000;		// one ask of a loading page
const SCALE		= 2;		// device pixels per css pixel: sharp enough to read, small enough to look over (the store's: the phone's own 3)

const FRAME_SCREEN	= "home";		// where the bars are pictured up close
const BAR_ROOM		= 72;		// css px past the safe area pictured: a bar and what's next to it
const ZOOM			= 2;		// the bars' pictures: times the screen's own
const SCALES = [ 100, 130, 175 ];		// of TEXT_SCALES (w_settings.rs): the default, the middle, the largest


// --only=a,b --scales=175 --phones=se
const ARGS = Object.fromEntries( process.argv.slice( 2 ).map( ( a ) => a.replace( /^--/, "" ).split( "=" ) ) );
// --store: the App Store's screenshots, out/store/*.png: each of its iPhone slots at the
// phone's own 3x (the 16, 1179x2556: 6.1"/6.3", which refused 1320x2868; the Duo,
// 1398x2034), the real-money build's look (?mainnet), the default
// text size, each screen's top. What iOS draws itself is the status bar's time alone:
// a screenshot holds no island, no home bar
const STORE = "store" in ARGS;
if ( STORE ) {
	ARGS.phones ??= "16,duo,ipad13";
	ARGS.scales ??= "100";
	ARGS.only ??= "home,send,receive,history,transaction";
}
const Pick = ( all, key, by ) => ( ARGS[key] ? all.filter( ( x ) => ARGS[key].split( "," ).includes( String( by( x ) ) ) ) : all );
const DIR		= STORE ? "out/store" : OUT;
const EXT		= STORE ? "png" : "jpg";
const phones	= Pick( DEVICES, "phones", ( p ) => p.id );
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
// the right side of an iPhone's status bar: signal, Wi-Fi and a full battery, as a real
// screenshot shows them (without them a store picture's top read as a broken bar, 11-27)
const STATUS_ICONS = [
	`<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>`,
	`<svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.2c2.4 0 4.6.9 6.3 2.4l1.2-1.3C13.5 1.4 10.9.4 8 .4S2.5 1.4.5 3.3l1.2 1.3C3.4 3.1 5.6 2.2 8 2.2z"/><path d="M8 5.6c1.5 0 2.8.5 3.9 1.4l1.2-1.3C11.7 4.5 9.9 3.8 8 3.8s-3.7.7-5.1 1.9L4.1 7C5.2 6.1 6.5 5.6 8 5.6z"/><path d="M8 9c.7 0 1.3.2 1.8.6L8 11.6 6.2 9.6C6.7 9.2 7.3 9 8 9z"/></svg>`,
	`<svg width="27" height="13" viewBox="0 0 27 13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" opacity="0.5"/></svg>`,
].join( "" );
// the status bar as each draws it: an island's time and icons either side of it; an
// iPad's time and date on the left, icons on the right (24px); the SE's time in the
// middle. None in a window that has none (Slide Over: bar "none")
const STATUS_BAR = ( p ) => {
	const icons = ( top, right ) => `<span style="position: absolute; top: ${top}px; right: ${right}px; display: flex; gap: 6px; align-items: center">${STATUS_ICONS}</span>`;
	const time = ( style, words = "9:41" ) => `<span style="position: absolute; line-height: 18px; ${style}">${words}</span>`;
	if ( p.bar === "none" ) {
		return "";
	}
	if ( p.island ) {
		return time( `top: ${p.island[0] + p.island[2] / 2 - 9}px; left: 32px; font-size: 15px` ) + icons( p.island[0] + p.island[2] / 2 - 6, 30 );
	}
	if ( p.bar === "ipad" ) {
		return time( "top: 3px; left: 20px; font-size: 13px", "9:41&nbsp;&nbsp;Mon Jun 9" ) + icons( 6, 18 );
	}
	return time( "top: 1px; left: calc( 50% - 16px ); font-size: 12px" ) + icons( 4, 6 );
};
const PHONE_SELF = ( p ) => `
	document.getElementById( "kit-phone" )?.remove();
	const self = document.createElement( "div" );
	self.id = "kit-phone";
	self.setAttribute( "aria-hidden", "true" );
	self.style.cssText = "position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font: 600 15px -apple-system, system-ui, sans-serif; color: CanvasText;";
	self.innerHTML = \`
		${STATUS_BAR( p )}
		${p.island && !STORE ? `<span style="position: absolute; top: ${p.island[0]}px; left: calc( 50% - ${p.island[1] / 2}px ); width: ${p.island[1]}px; height: ${p.island[2]}px; border-radius: ${p.island[2] / 2}px; background: #000"></span>` : ""}
		${p.bottom && !STORE ? `<span style="position: absolute; bottom: 8px; left: calc( 50% - 67px ); width: 134px; height: 5px; border-radius: 3px; background: CanvasText; opacity: 0.8"></span>` : ""}
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

mkdirSync( DIR, { recursive: true } );
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
		return { ...tab, Shot: async ( file, params = {} ) => writeFileSync( join( DIR, file ), Buffer.from( ( await tab.Send( "Page.captureScreenshot", params ) ).data, "base64" ) ) };
	};

	// one tab per phone, all at once (Edge started not to slow a tab it thinks is behind
	// another); each loads the page once and opens every screen in it (mock.html's __screen)
	const PICTURE = STORE ? { format: "png" } : { format: "jpeg", quality: 85, optimizeForSpeed: true };		// a png took ~170ms each
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
		await Send( "Emulation.setDeviceMetricsOverride", { width: p.w, height: p.h, deviceScaleFactor: STORE ? p.dpr : SCALE, mobile: true } );
		await Timed( "load", ( async () => {
			await Send( "Page.navigate", { url: Com_ScreenUrl( PORT, SCREENS[0], [ "check", "phone", "ios", "still", "password", ...( STORE ? [ "mainnet" ] : [] ) ] ) } );
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
				await Timed( "shot", Shot( `${base}-top.${EXT}` ) );
				if ( STORE ) {
					shots.push( { phone: p, scale, screen: s.id, at: "top", file: `${base}-top.${EXT}`, faults: look?.faults ?? [] } );
					continue;
				}
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
	if ( STORE ) {
		const faults = shots.flatMap( ( x ) => x.faults.map( ( f ) => `${x.file}: ${f}` ) );
		faults.forEach( ( f ) => console.error( `ui_kit: ${f}` ) );
		console.log( `ui_kit: ${shots.length} store screenshots, ${faults.length} layout faults: ${DIR}/*.${EXT}` );
		process.exitCode = faults.length ? 1 : 0;
	} else {
		const order = ( x ) => phones.indexOf( x.phone ) * 1e6 + scales.indexOf( x.scale ) * 1e4 + screens.findIndex( ( s ) => s.id === x.screen ) * 2 + ( x.at === "end" ? 1 : 0 );
		shots.sort( ( a, b ) => order( a ) - order( b ) );

		// the pictures, with their faults: one page of all, and one picture per phone and size
		const Card = ( x ) => `<figure><img src="${x.file}" width="${x.phone.w * 0.5}"><figcaption><b>${x.screen}</b> ${x.at}${x.scroll ? ` · scrolled ${x.scroll.top} of ${x.scroll.height - x.scroll.client}` : ""}${x.faults.map( ( f ) => `<div class="f">${f.replace( /</g, "&lt;" )}</div>` ).join( "" )}</figcaption></figure>`;
		const Page = ( list, title ) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>
			body { margin: 12px; font: 11px system-ui; background: #ddd; } h2 { font-size: 14px; margin: 18px 0 6px; }
			.row { display: flex; flex-wrap: wrap; gap: 8px; } figure { margin: 0; background: #fff; padding: 4px; }
			img { display: block; border: 1px solid #999; } figcaption { max-width: ${Math.max( ...DEVICES.map( ( p ) => p.w ) ) * 0.5}px; } .f { color: #c00; }
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
	}
} catch ( e ) {
	console.error( `ui_kit: ${e.message}` );
	process.exitCode = 1;
} finally {
	await edge?.Close();
	server?.kill();
}
process.exit();
