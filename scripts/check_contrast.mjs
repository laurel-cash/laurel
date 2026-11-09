/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_contrast.mjs -- every colour of text is readable on every surface
// it sits on, in both appearances (WCAG 2.2 AA)
//
// The test dom computes no styles, so axe (test_a11y.ts) can't judge
// contrast. Laurel's colours are tokens, each declared once as
// light-dark( light, dark ) on :root (ui.css): the pairs the design uses
// are checked here from those tokens, a translucent colour blended over
// the surface under it as the screen would.
//
//   node scripts/check_contrast.mjs

import { readFileSync } from "node:fs";

const CSS = readFileSync( "src/ui.css", "utf8" );

// WCAG 2.2: 4.5:1 for text, 3:1 for large text and for marks a person must see (icons, dots, borders of controls)
const TEXT	= 4.5;
const MARK	= 3.0;

// where text sits
const SURFACES	= [ "--bg", "--sidebar", "--surface", "--surface-2", "--elevated", "--popover", "--window" ];
const CARD		= [ "--card-a", "--card-b", "--card-c" ];

// what is read, and how much it must stand out
const PAIRS = [
	...[ "--text", "--text-2", "--accent", "--danger", "--warn" ].flatMap( ( fg ) => SURFACES.map( ( bg ) => [ fg, bg, TEXT ] ) ),
	...[ "--ironwood", "--sapling", "--orchard", "--transparent", "--text-3", "--offline" ].flatMap( ( fg ) => SURFACES.map( ( bg ) => [ fg, bg, MARK ] ) ),
	...[ "--card-text", "--card-text-2" ].flatMap( ( fg ) => CARD.map( ( bg ) => [ fg, bg, TEXT ] ) ),
	[ "--card-warn-text", "--card-a", TEXT ], [ "--card-warn-text", "--card-b", TEXT ], [ "--card-warn-text", "--card-c", TEXT ],
	...[ "--card-good", "--card-warn" ].flatMap( ( fg ) => CARD.map( ( bg ) => [ fg, bg, MARK ] ) ),
	[ "--tip-text", "--tip", TEXT ],
	[ "--on-accent", "--accent-fill", TEXT ],
	[ "--on-accent", "--accent-fill-hi", TEXT ],
	[ "--on-danger", "--danger", TEXT ],
];

// a text colour written as a literal escapes the pairs above: only these may, each for its reason
const LITERAL_OK = {
	".caption.close:hover":	"Windows' own close button: its red and white",
	".scan-frame":			"drawn over the camera picture, which has no theme",
	".scan-note":			"drawn over the camera picture, which has no theme",
};

/*
==================
Tokens

Each token's light and dark value; a plain value is both
==================
*/
function Tokens() {
	const root = CSS.slice( CSS.indexOf( ":root" ), CSS.indexOf( "color-scheme: light dark" ) );
	const tokens = new Map();
	for ( const m of root.matchAll( /(--[\w-]+):\s*([^;]+);/g ) ) {
		const value = m[2].replace( /\/\*.*?\*\//g, "" ).trim();
		const both = /^light-dark\(\s*(.+?)\s*,\s*((?:rgba?\([^)]*\)|#[0-9a-fA-F]+))\s*\)$/.exec( value );
		tokens.set( m[1], both ? { light: both[1], dark: both[2] } : { light: value, dark: value } );
	}
	return tokens;
}

// "#rgb", "#rrggbb" or "rgba( r, g, b, a )" as [ r, g, b, a ], 0-255 and 0-1
function Parse( text ) {
	const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec( text );
	if ( hex ) {
		const h = hex[1].length === 3 ? [ ...hex[1] ].map( ( c ) => c + c ).join( "" ) : hex[1];
		return [ 0, 2, 4 ].map( ( i ) => parseInt( h.slice( i, i + 2 ), 16 ) ).concat( 1 );
	}
	const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec( text );
	if ( rgb ) {
		return [ +rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4] ];
	}
	return null;
}

// fg over bg, as the screen shows it
function Blend( fg, bg ) {
	return [ 0, 1, 2 ].map( ( i ) => fg[i] * fg[3] + bg[i] * ( 1 - fg[3] ) ).concat( 1 );
}

function Luminance( c ) {
	const [ r, g, b ] = c.slice( 0, 3 ).map( ( v ) => {
		const s = v / 255;
		return s <= 0.04045 ? s / 12.92 : ( ( s + 0.055 ) / 1.055 ) ** 2.4;
	} );
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function Contrast( a, b ) {
	const [ hi, lo ] = [ Luminance( a ), Luminance( b ) ].sort( ( x, y ) => y - x );
	return ( hi + 0.05 ) / ( lo + 0.05 );
}

const tokens = Tokens();
const opaqueUnder = { light: Parse( tokens.get( "--bg" ).light ), dark: Parse( tokens.get( "--bg" ).dark ) };

let bad = 0;
for ( const [ fgName, bgName, need ] of PAIRS ) {
	for ( const mode of [ "light", "dark" ] ) {
		const fgText = tokens.get( fgName )?.[mode];
		const bgText = tokens.get( bgName )?.[mode];
		const fg = fgText && Parse( fgText );
		const bg0 = bgText && Parse( bgText );
		if ( !fg || !bg0 ) {
			console.error( `check_contrast: ${fgName} on ${bgName} (${mode}) isn't a colour this script reads` );
			bad++;
			continue;
		}
		const bg = Blend( bg0, opaqueUnder[mode] );		// a translucent surface lies on the page
		const ratio = Contrast( Blend( fg, bg ), bg );
		if ( ratio < need ) {
			console.error( `src/ui.css: ${fgName} on ${bgName} in ${mode} is ${ratio.toFixed( 2 )}:1, under ${need}:1` );
			bad++;
		}
	}
}

// every text colour outside :root is a token, or listed with its reason
let selector = "";
CSS.split( "\n" ).forEach( ( line, i ) => {
	const open = /^([^\s{][^{]*?)\s*\{/.exec( line );
	if ( open ) {
		selector = open[1].trim();
	}
	if ( /^\s*color:\s*(#|rgba?\()/.test( line ) && !( selector in LITERAL_OK ) && !line.includes( "--" ) ) {
		console.error( `src/ui.css:${i + 1}: "${selector}" writes its text colour as a literal; make it a token on :root, so it is checked here` );
		bad++;
	}
} );

if ( bad ) {
	process.exit( 1 );
}
console.log( `check_contrast: ${PAIRS.length * 2} pairs readable in both appearances` );
