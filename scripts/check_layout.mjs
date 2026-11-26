/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_layout.mjs -- the real screens, drawn by a real browser at every
// size that matters, measured: no amount cut, no page wider than its window
//
// Tests draw pieces in a dom that computes no layout, so a layout fault
// passes them all. A change for large text once stacked the balance at
// the default size too, because only the zoomed sizes were looked at.
// Every size is measured here, every time, by mock.html's ?check mode.
//
// One browser, one page load, then each size set exactly (the DevTools
// protocol's device metrics) and measured in place. A browser per size,
// each loading the dev server's hundred modules into an empty cache,
// took 15 seconds; a window frame once shrank the size asked for, which
// setting the page's own size can't.
//
//   npm run layout        (Windows with Edge; starts its own dev server)

import { existsSync } from "node:fs";
import { Com_Settled, SETTLE_AGAIN_MS } from "./layout_settle.mjs";
import { Com_DevServer, Com_Edge, Com_Within, EDGE, FRAMES } from "./layout_tools.mjs";
import { Com_ScreenUrl, Com_Screens } from "./ui_screens.mjs";

const PORT	= 1433;
// the longest any one step may take before the check says so; LAUREL_LAYOUT_WAIT_MS for a
// machine busy with other work (a first draw at 100% cpu took past 30s), said in the last line
const WAIT_MS = Number( process.env.LAUREL_LAYOUT_WAIT_MS ) || 30_000;
// a first draw compiles the page's modules on a cold dev server: beside the gate's cargo
// builds it took past 30s (twice on 2026-11-08, 71s alone and passing), each later draw
// a fraction of it. Only the first draws wait longer; every other step keeps WAIT_MS
const FIRST_DRAW_MS = WAIT_MS * 4;

// the default window, and the smallest at the largest text size (175%), and between
// (a taller one too: the action hints only show above 880px, and were cut there unseen)
const SIZES	= [ [ 1100, 720 ], [ 1100, 900 ], [ 900, 600 ], [ 629, 411 ], [ 514, 343 ] ];

// the screens opened over the dashboard (ui_screens.mjs), measured at every size too: the
// sheets whose rows of tiles and cards, and the popover of chips, are where a narrow window
// pushes something out of its box
const SCREENS = Com_Screens( [ "pool", "receive", "receive-kinds", "transaction", "filters", "settings", "security" ] );

// the pseudo-locale's longer words, at the default size and the smallest
const PSEUDO_SIZES = [ SIZES[0], SIZES[SIZES.length - 1] ];

// a phone, from the largest common width to the smallest: none was drawn until "99.6%"
// sat over "Public" on every phone and History's Filters hung off the screen. Each page
// above becomes a phone's in place (mock.html's __phone: its own layout, the bar at the
// bottom), then takes a phone's text size as useTextScale sets it: css zoom, so 175% on
// 390px lays out like a 223px page. In place: a page loaded for each took the step past
// its minute beside the others
const PHONE_SIZES		= [ [ 412, 915 ], [ 390, 844 ], [ 360, 800 ], [ 320, 640 ] ];
const PHONE_BIG_SIZES	= [ [ 390, 844 ], [ 320, 640 ] ];
const PHONE_ZOOM		= 1.75;

// words on screen that aren't Laurel's to translate: the sample wallet's own data,
// the names a person gave (mock.html's engine: its wallets, accounts and payments)
const PLAIN_OK = [ /^(Main|Everyday|Rent|Gym|Business)$/ ];

if ( !existsSync( EDGE ) ) {
	console.log( "check_layout: no Edge here; skipped" );
	process.exit( 0 );
}

// a promise, or the reason it never came: by WAIT_MS unless said
const Within = ( what, promise, ms = WAIT_MS ) => Com_Within( what, promise, ms );


let server = null;
let edge = null;
let bad = 0;
let unsettledCount = 0;		// faults seen in one of two measures (layout_settle.mjs): said, not counted
try {
	server = await Com_DevServer( PORT, WAIT_MS );
	edge = await Com_Edge( "check_layout", WAIT_MS );
	// a tab at a url, opened at the first size: at the browser's own (800 x 600, under the
	// smallest window) the balance isn't drawn as it is in Laurel, and the first draw waited 7s
	const Tab = async ( url ) => {
		const { Send, Eval } = await edge.Tab( url );
		const tab = {
			Size:		( [ w, h ], phone = false ) => Send( "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: phone } ),
			// in front, as Laurel's window always is: a tab behind others gets an animation
			// frame about once a second, and a popover placed in a frame stays where it was
			Front:		() => Send( "Page.bringToFront" ),
			// a phone's text size, as useTextScale sets it: css zoom, and --app-zoom for what's sized by the screen
			// each then two frames on: the page re-laid out at its new size before it's measured
			Phone:		( on ) => Eval( `window.__phone( ${on} ); ${FRAMES}` ),
			Zoom:		( z ) => Eval( `document.documentElement.style.zoom = "${z}"; document.documentElement.style.setProperty( "--app-zoom", "${z}" ); ${FRAMES}` ),
			Look:		() => Eval( "window.__layout ? window.__layout() : null", 0 ),		// no deadline of its own: Measure's caller's
			// faults the page keeps (layout_settle.mjs): a measure that finds any is taken again
			// a moment on, and one in only one of them is said, not counted
			Measure:	async ( what ) => {
				const first = await tab.Look();
				if ( !first?.faults.length ) return first;
				await new Promise( ( ok ) => setTimeout( ok, SETTLE_AGAIN_MS ) );
				const second = await tab.Look();
				const { faults, unsettled } = Com_Settled( first.faults, second.faults );
				unsettledCount += unsettled.length;
				for ( const f of unsettled ) console.warn( `check_layout: ${what}: unsettled (in one of two measures ${SETTLE_AGAIN_MS} ms apart, not counted): ${f}` );
				return { ...second, faults };
			},
		};
		await tab.Size( SIZES[0] );
		await Send( "Page.navigate", { url } );
		return tab;
	};
	const Drawn = ( tab, what, ms = WAIT_MS ) => Within( what, ( async () => { while ( !await tab.Look() ) await new Promise( ( ok ) => setTimeout( ok, 50 ) ); } )(), ms );

	// the dashboard and the pseudo-locale load together; the screens only once the dev
	// server has made its modules, and while the dashboard is measured. All six at once,
	// each asking for the same hundred modules from a cold server, took 10s to a first draw.
	// Each tab comes to the front before it's waited on: behind others, its timers and
	// frames come about once a second
	const [ main, pseudo ] = await Promise.all( [
		Tab( `http://127.0.0.1:${PORT}/mock.html?check&history` ),
		Tab( `http://127.0.0.1:${PORT}/mock.html?check&pane=&locale=en-XA` ),
	] );
	await main.Front();
	await Drawn( main, "the first draw", FIRST_DRAW_MS );
	const screens = await Promise.all( SCREENS.map( ( s ) => Tab( Com_ScreenUrl( PORT, s, [ "check" ] ) ) ) );
	await main.Front();
	for ( const [ w, h ] of SIZES ) {
		await main.Size( [ w, h ] );
		const seen = await Within( `${w}x${h}`, main.Measure( `${w}x${h}` ) );
		// drawn at the first size, gone at this one (an error screen, say): nothing here to pass
		if ( !seen.drawn ) {
			console.error( `check_layout: ${w}x${h}: the dashboard isn't drawn (its balance doesn't show); a page not drawn is a page not checked` );
			bad++;
			continue;
		}
		if ( seen.width !== w || seen.height !== h ) {
			console.error( `check_layout: ${w}x${h}: measured at ${seen.width}x${seen.height} instead; a size not drawn is a size not checked` );
			bad++;
			continue;
		}
		for ( const f of seen.faults ) {
			console.error( `check_layout: ${w}x${h}: ${f}` );
			bad++;
		}
	}

	// each screen, opened at the first size, then at every size
	for ( const [ i, screen ] of SCREENS.entries() ) {
		await screens[i].Front();
		await Drawn( screens[i], screen.name );
		for ( const [ w, h ] of SIZES ) {
			await screens[i].Size( [ w, h ] );
			const seen = await Within( `${screen.name} ${w}x${h}`, screens[i].Measure( `${screen.name} ${w}x${h}` ) );
			for ( const f of seen.faults ) {
				console.error( `check_layout: ${screen.name} ${w}x${h}: ${f}` );
				bad++;
			}
		}
	}

	// each again as a phone's, at each phone size, then at the largest text size
	for ( const [ name, tab ] of [ [ "the dashboard", main ], ...SCREENS.map( ( s, i ) => [ s.name, screens[i] ] ) ] ) {
		await tab.Front();
		await tab.Phone( true );
		for ( const [ zoom, sizes ] of [ [ 1, PHONE_SIZES ], [ PHONE_ZOOM, PHONE_BIG_SIZES ] ] ) {
			await tab.Zoom( zoom );
			for ( const [ w, h ] of sizes ) {
				await tab.Size( [ w, h ], true );
				const seen = await Within( `phone at ${zoom * 100}%: ${name} ${w}x${h}`, tab.Measure( `phone at ${zoom * 100}%: ${name} ${w}x${h}` ) );
				for ( const f of seen.faults ) {
					console.error( `check_layout: phone at ${zoom * 100}%: ${name} ${w}x${h}: ${f}` );
					bad++;
				}
			}
		}
	}

	// again in the pseudo-locale (ui_locale.ts), what's new already seen (&pane=): every
	// sentence a third longer, so a label with no room to grow shows here before a
	// translation does; and words on screen that aren't from the language's text (not ⟦
	// between ⟧) are a sentence no translation would reach. The sample data's are
	// expected: PLAIN_OK
	await pseudo.Front();
	await Drawn( pseudo, "the pseudo-locale's first draw", FIRST_DRAW_MS );
	const plain = new Set();
	for ( const [ w, h ] of PSEUDO_SIZES ) {
		await pseudo.Size( [ w, h ] );
		const seen = await Within( `pseudo ${w}x${h}`, pseudo.Measure( `pseudo-locale ${w}x${h}` ) );
		for ( const f of seen.faults ) {
			console.error( `check_layout: pseudo-locale ${w}x${h}: ${f}` );
			bad++;
		}
		seen.plain.filter( ( t ) => !PLAIN_OK.some( ( ok ) => ok.test( t ) ) ).forEach( ( t ) => plain.add( t ) );
	}
	for ( const text of plain ) {
		console.error( `check_layout: pseudo-locale: "${text}" isn't from the language's text (ui_text.ts); no translation would reach it` );
		bad++;
	}
} catch ( e ) {
	console.error( `check_layout: ${e.message}` );
	bad++;
} finally {
	// closed only now, everything measured: a slow exit (a loaded machine: twice in one day)
	// is killed and said, never a fault of the layout
	await edge?.Close();
	server?.kill();
}

// what wasn't counted, and the limit it ran with, in the line the gate shows
const tally = `${unsettledCount} unsettled, each step within ${WAIT_MS / 1000}s`;
if ( bad ) {
	console.error( `check_layout: ${bad} faults; ${tally}` );
} else {
	console.log( `check_layout: ${SIZES.length} sizes, the dashboard and ${SCREENS.length} screens over it, nothing cut, nothing wider than its window or sticking out of its sheet, no words over words or broken in two; on a phone the same at ${PHONE_SIZES.length} sizes and at 175%, nothing past the screen's edge or under its bar; in the pseudo-locale at ${PSEUDO_SIZES.length}, the same, and every word on screen from the language's text; ${tally}` );
}
process.exit( bad ? 1 : 0 );		// said, not waited for: the dev server's and the socket's handles would keep it running
