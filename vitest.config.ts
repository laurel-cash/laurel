/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// vitest.config.ts -- ui tests: a browser-like dom, the engine mocked in
// each test (its events by src/test_engine.ts), the window by
// src/test_setup.ts

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig( {
	plugins: [ react() ],
	test: {
		environment:	"jsdom",
		include:		[ "src/**/*.test.{ts,tsx}" ],
		restoreMocks:	true,
		setupFiles:		[ "src/test_setup.ts" ],
		sequence:		{ hooks: "list" },		// the setup's accessibility check runs before each file's cleanup
		// still a deadline, at three times the slowest test on a quiet machine
		// (2.5 s): under the gate the ui tests share the cpu with the
		// engine's build and tests, and vitest's 5 s timed out keyboard and
		// restore tests that had changed nothing, three gates in one day. Every
		// deadline a test meets, not one: each test's accessibility check
		// (test_setup.ts, axe) is a hook, and ran out at vitest's 10 s; a
		// findBy's 1 s is test_setup.ts's (2026-10-27: one ran out, the page
		// was left behind, and the next test found two of everything)
		testTimeout:	15_000,
		hookTimeout:	15_000,
	},
} );
