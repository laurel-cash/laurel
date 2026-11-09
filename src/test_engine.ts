/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// test_engine.ts -- what tests that mock ./bindings share: the engine's
// events, silent, and a history line. One owner each: a new event or a new
// field added in Rust needs no edit in every test.

import type { accountSummary_t, appSettings_t, balance_t, constants_t, historyItem_t, poolBalance_t, scanned_t, syncProgress_t, vaultStatus_t, walletCan_t, walletSummary_t } from "./bindings";

const silent = { listen: async () => () => {}, once: async () => () => {} };

export const TEST_EVENTS = new Proxy( {}, { get: () => silent } );

// bindings whose every command answers nothing, for a test about what shows, not what
// the engine says: vi.mock( "./bindings", async () => ( await import( "./test_engine" ) ).TEST_NULL_BINDINGS )
export const TEST_NULL_BINDINGS = {
	commands:	new Proxy( {}, { get: () => async () => null } ),
	events:		TEST_EVENTS,
};

/*
==================
Test_Item

A history line as the engine hands it out: received and confirmed, with
what the test cares about on top
==================
*/
export function Test_Item( patch: Partial< historyItem_t > = {} ): historyItem_t {
	return {
		txid: "aa", time: 1_790_000_000, kind: "received", amount: 150_000_000, fee: null, state: { kind: "confirmed", height: 100 },
		from: [], into: [ "ironwood" ], counterparty: null, memo: null, note: null, category: null, ...patch,
	};
}

/*
==================
Test_Balance

An account's balance as the engine hands it out, from what each pool
holds; the total is the engine's sum, spendable all the private money
unless the test says otherwise
==================
*/
export function Test_Balance( pools: Partial< Record< "ironwood" | "orchard" | "sapling" | "transparent", Partial< poolBalance_t > > >, spendable?: number | null ): balance_t {
	const pool = ( p: Partial< poolBalance_t > | undefined ): poolBalance_t => ( { confirmed: 0, pending: 0, ...p } );
	const b = { ironwood: pool( pools.ironwood ), orchard: pool( pools.orchard ), sapling: pool( pools.sapling ), transparent: pool( pools.transparent ) };
	const all = [ b.ironwood, b.orchard, b.sapling, b.transparent ];
	return {
		...b,
		total:		all.reduce( ( s, p ) => s + p.confirmed + p.pending, 0 ),
		spendable:	spendable === undefined ? b.ironwood.confirmed + b.orchard.confirmed + b.sapling.confirmed : spendable,
	};
}

/*
==================
Test_Scanned

What Scan reads from a plain address: no amount, no memo, no further payments
==================
*/
export function Test_Scanned( address: string, kind: scanned_t["kind"], patch: Partial< scanned_t > = {} ): scanned_t {
	return { address, kind, amount: null, memo: null, label: null, message: null, also: [], ...patch };
}

/*
==================
Test_Summary

A wallet as the switcher gets it: one account, synced, with what the
test cares about on top. Two tests once wrote a part of one and cast it
through ("as never"), which hides every field added since.
==================
*/
/*
==================
Test_Vault

The vault as the engine reports it: unlocked, protected by the system,
unless a test says otherwise
==================
*/
export function Test_Vault( patch: Partial< vaultStatus_t > = {} ): vaultStatus_t {
	return { state: "unlocked", protection: "os", osProtectionAvailable: true, minPasswordLen: 8, ...patch };
}

/*
==================
Test_Can

What the engine says a wallet may do (W_Allow): a phrase wallet's, all
of it, unless a test says otherwise. A test of another kind states its
answers; the rule itself lives in the engine alone.
==================
*/
export function Test_Can( patch: Partial< walletCan_t > = {} ): walletCan_t {
	return { spend: true, receive: true, moveWithin: true, addAccount: true, ...patch };
}

export function Test_Summary( patch: Partial< walletSummary_t > = {}, accounts: Partial< accountSummary_t >[] = [ {} ] ): walletSummary_t {
	const progress: syncProgress_t = {
		running: false, complete: true, percent: 100, walletHeight: 100, chainHeight: 100, error: null, attempting: false,
		nextRetryAt: null, paused: false, etaSecs: null, birthdayTime: null, repairing: false,
	};
	return {
		seq: 1, id: "w1", name: "Savings", kind: "seed", can: Test_Can(), backedUp: true, progress: progress, saveError: null, sameWords: [],
		accounts: accounts.map( ( a, i ) => ( { index: i, name: "Main", balance: Test_Balance( {} ), ...a } ) ),
		...patch,
	};
}

/*
==================
Test_Constants

The engine's constants (W_Constants), whole: a test once wrote five of
the eleven by hand
==================
*/
export function Test_Constants( patch: Partial< constants_t > = {} ): constants_t {
	return {
		mobile: false, phraseLengths: [ 12, 15, 18, 21, 24 ], maxAccounts: 20, maxNameLen: 40, defaultWalletName: "My Wallet", defaultAccountName: "Main",
		blockEras: [ { network: "testnet", from: 0, secs: 150 }, { network: "testnet", from: 584000, secs: 75 }, { network: "testnet", from: 4465026, secs: 25 } ], autoLockChoices: [ 5, 15, 60 ], lockAwayChoices: [ 0, 60, 300 ], memoMaxBytes: 512, categories: [], textScales: [ 100, 115, 130 ], maxPayments: 50, noteMaxChars: 200, networks: [ "testnet", "mainnet" ], ...patch,
	};
}

/*
==================
Test_Settings

The app's settings as the engine hands them out (w_settings.rs defaults),
with what the test cares about on top. Typed whole: a field added in
Rust is a compile error here, once, not an undefined in six tests.
==================
*/
export function Test_Settings( patch: Partial< appSettings_t > = {} ): appSettings_t {
	return { autoLockMinutes: null, lockAwaySecs: 60, notifyInApp: true, notifySystem: true, network: "testnet", showPrice: false, textScale: 100, ...patch };
}
