/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_store.test.ts -- every case of St_Screen, the one place that decides
// which top-level screen shows

import { describe, expect, it } from "vitest";

import { St_Screen } from "./ui_store";
import { Com_Error } from "./ui_local";
import type { vaultStatus_t } from "./bindings";

const UNLOCKED: vaultStatus_t	= { state: "unlocked", protection: "os", osProtectionAvailable: true, minPasswordLen: 8 };
const LOCKED: vaultStatus_t		= { ...UNLOCKED, state: "locked", protection: "password" };
const NEEDS: vaultStatus_t		= { ...UNLOCKED, state: "needsPassword", protection: null, osProtectionAvailable: false };

const BASE = {
	vault:		UNLOCKED,
	vaultError:	null,
	loaded:		true,
	loadError:	null,
	firstRun:	false,
	order:		[ "w1" ],
	failed:		[],
};

describe( "St_Screen", () => {
	it( "shows a vault problem before anything else", () => {
		expect( St_Screen( { ...BASE, vaultError: Com_Error( "key missing", "os error 2" ) } ) ).toEqual( { kind: "vaultError", message: Com_Error( "key missing", "os error 2" ) } );
	} );

	it( "waits for the vault, then for the wallets", () => {
		expect( St_Screen( { ...BASE, vault: null } ).kind ).toBe( "booting" );
		expect( St_Screen( { ...BASE, loaded: false } ).kind ).toBe( "booting" );
	} );

	it( "locks and asks for a first password", () => {
		expect( St_Screen( { ...BASE, vault: { ...LOCKED, state: "locking" } } ).kind ).toBe( "locking" );
		expect( St_Screen( { ...BASE, vault: LOCKED } ).kind ).toBe( "locked" );
		expect( St_Screen( { ...BASE, vault: NEEDS } ).kind ).toBe( "needsPassword" );
	} );

	it( "shows onboarding only when the engine says first run", () => {
		expect( St_Screen( { ...BASE, order: [], firstRun: true } ).kind ).toBe( "firstRun" );
	} );

	// the bug that shipped: a wallet that failed to open looked like a first run
	it( "never shows onboarding when wallets failed to open", () => {
		const failed = [ { id: "w1", error: { message: "Laurel couldn't get an answer from the Zcash server.", detail: null, retry: false } } ];
		expect( St_Screen( { ...BASE, order: [], failed } ) ).toEqual( { kind: "allFailed", failed } );
	} );

	it( "never shows onboarding when not told it is a first run, even with nothing listed", () => {
		expect( St_Screen( { ...BASE, order: [], failed: [] } ).kind ).toBe( "allFailed" );
	} );

	it( "shows a load error with nothing open, and the wallets when some are", () => {
		expect( St_Screen( { ...BASE, order: [], loadError: Com_Error( "boom" ) } ) ).toEqual( { kind: "loadError", message: Com_Error( "boom" ) } );
		expect( St_Screen( { ...BASE, loadError: Com_Error( "boom" ) } ).kind ).toBe( "wallets" );
	} );

	it( "shows the wallets", () => {
		expect( St_Screen( BASE ).kind ).toBe( "wallets" );
	} );
} );
