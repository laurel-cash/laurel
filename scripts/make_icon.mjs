/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// make_icon.mjs -- renders the app icon to app-icon.png; then
// `npx tauri icon app-icon.png` makes every size each system needs.
// The leaf is the brand artwork (docs/design/leaf-double-clean.png) on
// the deep teal of the palette (docs/design/ui-kit-mockup.png).
//
//   node scripts/make_icon.mjs && npx tauri icon app-icon.png

import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const SIZE		= 1024;
const LEAF_SRC	= "docs/design/leaf-double-clean.png";
const LEAF_W	= 1097;			// the clean artwork's pixel size
const LEAF_H	= 987;

// the leaf spans 68% of the icon, centred, nudged up a little so it
// sits optically centred (its weight is at the bottom)
const W = SIZE * 0.68;
const H = W * LEAF_H / LEAF_W;
const X = ( SIZE - W ) / 2;
const Y = ( SIZE - H ) / 2 - SIZE * 0.015;

const leaf = "data:image/png;base64," + readFileSync( LEAF_SRC ).toString( "base64" );

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
	<defs>
		<linearGradient id="bg" x1="0.2" y1="0" x2="0.8" y2="1">
			<stop offset="0" stop-color="#15474f"/>
			<stop offset="0.6" stop-color="#0c2b36"/>
			<stop offset="1" stop-color="#071a24"/>
		</linearGradient>
		<radialGradient id="glow" cx="0.5" cy="0.42" r="0.5">
			<stop offset="0" stop-color="#64d18a" stop-opacity="0.22"/>
			<stop offset="1" stop-color="#64d18a" stop-opacity="0"/>
		</radialGradient>
	</defs>
	<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${SIZE * 0.225}" fill="url(#bg)"/>
	<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${SIZE * 0.225}" fill="url(#glow)"/>
	<image x="${X}" y="${Y}" width="${W}" height="${H}" xlink:href="${leaf}"/>
</svg>`;

const png = new Resvg( svg, { fitTo: { mode: "width", value: SIZE } } ).render().asPng();
writeFileSync( "app-icon.png", png );
console.log( `app-icon.png: ${SIZE}x${SIZE}, ${png.length} bytes` );
