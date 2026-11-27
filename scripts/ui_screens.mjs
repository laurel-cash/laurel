/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_screens.mjs -- the screens a check opens, and the phones it opens them on:
// one list, so a screen's way in is written once. check_layout.mjs measures
// some of them in Edge at a computer's sizes and a phone's; ui_kit.mjs
// pictures all of them on the iPhones and iPads.
//
// mock.html opens each: ?pane= Settings on that pane, ?click= presses through
// (several, apart by |, each once it's there); drawn says it's there. A new
// screen is a row here, and both checks have it

export const SCREENS = [
	{ id: "home",			name: "the dashboard",																				drawn: ".home-grid" },
	{ id: "send",			name: "Send",				click: ".nav li:nth-child(2) .nav-item",								drawn: ".sheet" },
	{ id: "receive",		name: "Receive",			click: ".actions .action:nth-child(2)",									drawn: ".tile-grid.three" },
	{ id: "receive-kinds",	name: "Receive's kinds",	click: ".actions .action:nth-child(2)|.tile-grid.three > button:last-child",	drawn: ".kind-list" },
	{ id: "history",		name: "History",			click: ".nav li:nth-child(4) .nav-item",								drawn: ".tx-row" },
	{ id: "transaction",	name: "a transaction",		click: ".nav li:nth-child(4) .nav-item|.tx-row",						drawn: ".tx-route" },
	{ id: "filters",		name: "History's filters",	click: ".nav li:nth-child(4) .nav-item|.filter-btn",					drawn: ".chip-set" },
	{ id: "settings",		name: "Settings",			click: ".nav li:nth-child(5) .nav-item",								drawn: ".settings-nav" },
	{ id: "general",		name: "General",			pane: "general",														drawn: ".pane-head" },
	{ id: "security",		name: "a settings pane",	pane: "security",														drawn: ".pane-head" },
	{ id: "notifications",	name: "Notifications",		pane: "notifications",													drawn: ".pane-head" },
	{ id: "wallets",		name: "Wallets",			pane: "wallets",														drawn: ".pane-head" },
	{ id: "network",		name: "Network",			pane: "network",														drawn: ".pane-head" },
	{ id: "about",			name: "About",				pane: "about",															drawn: ".pane-head" },
	{ id: "whats-new",		name: "What's New",			pane: "about",	click: ".settings-list .set-row:nth-child(1) .btn",		drawn: ".sheet" },
	{ id: "laurel-license",	name: "Laurel's License",	pane: "about",	click: ".settings-list .set-row:nth-child(2) .btn",		drawn: ".sheet" },
	{ id: "licenses",		name: "Open-Source Licenses",	pane: "about",	click: ".settings-list .set-row:nth-child(3) .btn",	drawn: ".sheet" },
	{ id: "pool",			name: "a pool's sheet",		click: ".pools-more .link|.pool-list li:nth-child(2) .pool-row",		drawn: ".pool-hero" },
];

// the screens by id, in the order asked (an id not here is a mistake, said at once)
export function Com_Screens( ids ) {
	return ids.map( ( id ) => SCREENS.find( ( s ) => s.id === id ) ?? ( () => { throw new Error( `ui_screens: no screen "${id}"` ); } )() );
}

// mock.html's address for a screen; flags: the page's own (check, phone, ios...). &drawn
// is what its __layout waits for before measuring: without it, the dashboard's balance,
// which no settings pane shows (a measure that never came, 11-26)
export function Com_ScreenUrl( port, screen, flags ) {
	return `http://127.0.0.1:${port}/mock.html?${flags.join( "&" )}&pane=${screen.pane ?? ""}${screen.click ? `&click=${encodeURIComponent( screen.click )}` : ""}&drawn=${encodeURIComponent( screen.drawn )}`;
}

// the devices a check pictures, by css size, safe areas (portrait) and own pixel
// ratio (a store picture's): the iPhones (the smallest still sold, the common one,
// the largest, the wide one) and the iPads (the smallest; the 13", App Store
// Connect's one iPad slot, upright and on its side; beside and over another app).
// island: the Dynamic Island's box under the status bar (top, width, height); bar:
// "ipad" (time and date left) or "none"; else the SE's plain status bar
export const DEVICES = [
	{ id: "se",		name: "iPhone SE",			w: 375, h: 667, dpr: 2, top: 20, bottom: 0 },
	{ id: "16",		name: "iPhone 16",			w: 393, h: 852, dpr: 3, top: 59, bottom: 34, island: [ 11, 125, 37 ] },
	{ id: "max",	name: "iPhone 16 Pro Max",	w: 440, h: 956, dpr: 3, top: 62, bottom: 34, island: [ 11, 125, 37 ] },
	// the wide one (App Store Connect's "iPhone Duo" slot, 1398x2034 at 3x): its safe areas taken as the 16's
	{ id: "duo",	name: "iPhone Duo",			w: 466, h: 678, dpr: 3, top: 59, bottom: 34, island: [ 11, 125, 37 ] },
	{ id: "mini",	name: "iPad mini",			w: 744, h: 1133, dpr: 2, top: 24, bottom: 20, bar: "ipad" },
	{ id: "ipad13",	name: "iPad Pro 13-inch",	w: 1032, h: 1376, dpr: 2, top: 24, bottom: 20, bar: "ipad" },
	{ id: "land",	name: "iPad Pro 13-inch, on its side",	w: 1376, h: 1032, dpr: 2, top: 24, bottom: 20, bar: "ipad" },
	// beside another app (Split View, half the 13" on its side), and over one (Slide Over:
	// a phone's width, so a phone's layout, with no status bar of its own)
	{ id: "split",	name: "iPad Split View",	w: 678, h: 1032, dpr: 2, top: 24, bottom: 20, bar: "ipad" },
	{ id: "slide",	name: "iPad Slide Over",	w: 375, h: 900, dpr: 2, top: 0, bottom: 0, bar: "none" },
];
