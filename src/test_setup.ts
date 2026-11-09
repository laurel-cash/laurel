/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_setup.ts -- around every ui test: the window, silent (there is no
// Tauri window in the test dom, and a screen that asks it for something,
// hiding from screenshots, would fail every test that shows it; a test
// that watches the window mocks it itself), and after each test, what it
// left on the page checked by axe-core's rules (test_a11y.ts). Every
// sheet, form and state any test reaches is checked, not a chosen few.

import { afterEach, expect, vi } from "vitest";
import { configure } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";

import { Com_A11y } from "./test_a11y";

// no animations: a test that goes screen to screen waited out every entrance
// and exit (measured 2026-10-02: a fifth of all test time). What a test checks
// is what the screen says and does, which an animation doesn't change
// (mock.html's checks the same)
MotionGlobalConfig.skipAnimations = true;

// findBy and waitFor wait 1 s by default: under the gate the tests share the cpu with
// the engine's (vitest.config.ts, testTimeout), and a screen that's right came late
configure( { asyncUtilTimeout: 5_000 } );

// runs before each file's cleanup: hooks run in the order they're added (vitest.config.ts)
afterEach( async () => {
	if ( vi.isFakeTimers() || !document.body.children.length ) {
		return;		// axe waits on real timers; an empty page has nothing to check
	}
	expect( await Com_A11y(), "accessibility of what the test left on the page" ).toEqual( [] );
} );

vi.mock( "@tauri-apps/api/webview", () => ( {
	getCurrentWebview: () => ( { setZoom: () => Promise.resolve() } ),
} ) );

vi.mock( "@tauri-apps/api/window", () => ( {
	getCurrentWindow: () => ( {
		onFocusChanged:			() => Promise.resolve( () => {} ),
		setContentProtected:	() => Promise.resolve(),
		close:					() => Promise.resolve(),
		minimize:				() => Promise.resolve(),
		toggleMaximize:			() => Promise.resolve(),
	} ),
} ) );
