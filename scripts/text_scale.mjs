/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// text_scale.mjs -- the text size where only text grows (an iPhone: textZoom
// "text", useTextScale): each font size ui.css writes in px is drawn times
// --text-scale (1 unless set), so a phone's text grows as its own apps' does,
// and any browser draws it as the iPhone does (scripts/ui_kit.mjs). Written once
// here, not in each of ui.css's two hundred: a new rule scales without a
// thought. vite.config.ts runs it on the stylesheet

const TEXT_SCALED = /^(\d+(\.\d+)?px|var\( --text-min \))$/;

// a font size as drawn: px (and the smallest, --text-min) times the text size; what
// already follows the text (em, %) or the screen (clamp of cqw) as it is
export const Com_TextScaled = ( value ) => ( TEXT_SCALED.test( value.trim() ) ? `calc( ${value.trim()} * var( --text-scale, 1 ) )` : value );

// the postcss plugin: every font-size declaration through Com_TextScaled
export const TEXT_SCALE = {
	postcssPlugin:	"laurel-text-scale",
	Declaration:	{ "font-size": ( d ) => { d.value = Com_TextScaled( d.value ); } },
};
