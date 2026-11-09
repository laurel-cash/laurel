/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_release.test.ts -- what may never ship (scripts/release_rules.mjs):
// the engine's mixnet path, and the KDF probe, a test build's only

import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain node module of the release scripts, without types
import { Com_CargoProblems, Com_LibraryProblems, Com_PublicPath, Com_WordProblems, Com_WordRules, EXPORT_SETTINGS } from "../scripts/release_rules.mjs";

const CARGO = "[features]\ntestnet-only = []\nkdf-probe = []\n";

describe( "release rules", () => {
	it( "refuse a Cargo.toml that turns on nym, or the probe by default", () => {
		expect( Com_CargoProblems( CARGO ) ).toEqual( [] );
		expect( Com_CargoProblems( CARGO + "default = [ \"kdf-probe\" ]\n" ).length ).toBe( 1 );
		expect( Com_CargoProblems( "zingolib = { path = \"x\", features = [ \"nym\" ] }\n" ).length ).toBe( 1 );
	} );

	it( "refuse a library built with the KDF probe", () => {
		expect( Com_LibraryProblems( "…laurel-networks:testnet-only…laurel-kdf-probe:off…" ) ).toEqual( [] );
		expect( Com_LibraryProblems( "…laurel-networks:testnet-only…laurel-kdf-probe:on…" ).length ).toBe( 1 );
		expect( Com_LibraryProblems( "…laurel-networks:all…laurel-kdf-probe:off…" ).length, "not the testnet build" ).toBe( 1 );
	} );
} );

// the public tree (scripts/public_export.mjs), with settings made up for the test: the
// internal files stay out, the public ones take their places, and a public file holds
// none of the words, as the settings say each is found
describe( "the public tree", () => {
	const SETTINGS = {
		files:	[ "notes/plan.md", "README.md" ],
		dirs:	[ "scratch/" ],
		words:	[ { text: "Acme", as: "any" }, { text: "big_box", as: "word" }, { text: "Cloudy", as: "path" } ],
		allow:	[ "org\\.acme\\.app" ],
	};
	const RULES = Com_WordRules( SETTINGS );

	it( "leaves the internal files out, and puts the public ones in their place", () => {
		for ( const p of [ "notes/plan.md", "scratch/x.txt", EXPORT_SETTINGS, "README.md" ] ) {
			expect( Com_PublicPath( p, SETTINGS ), p ).toBeNull();
		}
		expect( Com_PublicPath( "src/ui_main.tsx", SETTINGS ) ).toBe( "src/ui_main.tsx" );
		expect( Com_PublicPath( "public/README.md", SETTINGS ), "the public README, at the root" ).toBe( "README.md" );
	} );

	it( "finds each word as the settings say, and none in allowed text", () => {
		expect( Com_WordProblems( "a.md", "nothing\nhere", RULES ) ).toEqual( [] );
		expect( Com_WordProblems( "a.md", "one\n(C) acme Inc", RULES ) ).toEqual( [ "a.md:2: acme" ] );
		expect( Com_WordProblems( "a.kt", "package org.acme.app", RULES ), "allowed" ).toEqual( [] );
		expect( Com_WordProblems( "a.md", "in /work/big_box/docs and the big-box notes", RULES ).length, "a word, either spelling" ).toBe( 2 );
		expect( Com_WordProblems( "a.kts", "BIG_BOX_PASSWORD", RULES ), "not part of a longer word" ).toEqual( [] );
		expect( Com_WordProblems( "a.md", "a share (Cloudy, a NAS)", RULES ), "a path's folder only" ).toEqual( [] );
		expect( Com_WordProblems( "a.md", "see H:\\Cloudy\\x and H:/Cloudy/y", RULES ).length ).toBe( 2 );
	} );

	it( "checks nothing without its settings", () => {
		expect( Com_WordProblems( "a.md", "anything at all", Com_WordRules() ) ).toEqual( [] );
		expect( Com_PublicPath( "notes/plan.md" ) ).toBe( "notes/plan.md" );
	} );
} );
