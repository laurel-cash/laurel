/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_query.ts -- every load of data that belongs to a wallet or account
//
// Loads were once buttons (useAction): a second request while the first
// ran was dropped, and a slow answer for account A could land on screen
// after switching to account B (its history, its chart, its address). A
// query's result belongs to its key, so that can't happen by construction.
// Buttons stay useAction; anything that loads data by wallet or account
// is a query with a key from KEYS (scripts/check_loads.mjs enforces it).

import { QueryClient } from "@tanstack/react-query";

import { Com_ErrorOf } from "./ui_local";

// a load that failed on a passing state (the engine mid-step, still
// scanning the newest blocks, a slow server: errorInfo_t.retry, decided in
// rust) is asked again a few times before its reason is shown
const RETRY_TIMES	= 5;
const RETRY_MSEC	= 3000;

// the engine already bounds its waits and retries its sync: any other
// failed load shows its reason at once. Data is refetched when it changes
// (a balance, a sync state), never on a timer or on focus
export const QUERY = new QueryClient( {
	defaultOptions: {
		queries: {
			retry:					( count, error ) => Com_ErrorOf( error ).retry && count < RETRY_TIMES,
			retryDelay:				RETRY_MSEC,
			staleTime:				Infinity,
			refetchOnWindowFocus:	false,
		},
	},
} );

// the one place a key is spelled, so two views can't key the same data apart
export const KEYS = {
	transactions:	( walletId: string, account: number ) => [ "transactions", walletId, account ] as const,
	balanceHistory:	( walletId: string, account: number ) => [ "balanceHistory", walletId, account ] as const,
	receive:		( walletId: string, account: number ) => [ "receive", walletId, account ] as const,
	migrationPlan:	( walletId: string, account: number ) => [ "migrationPlan", walletId, account ] as const,
	migration:		( walletId: string ) => [ "migration", walletId ] as const,
	shieldQuote:	( walletId: string, account: number, publicZats: number ) => [ "shieldQuote", walletId, account, publicZats ] as const,
	moveQuote:		( walletId: string, account: number, saplingZats: number ) => [ "moveQuote", walletId, account, saplingZats ] as const,		// Sapling into Ironwood
	sweepQuote:		( walletId: string, account: number, asked: number ) => [ "sweepQuote", walletId, account, asked ] as const,		// never the key: a count of asks
	maxSend:		( walletId: string, account: number, to: string, from: string | null ) => [ "maxSend", walletId, account, to, from ] as const,
	contacts:		() => [ "contacts" ] as const,		// the network's address book
	settings:		() => [ "settings" ] as const,		// the app's (w_settings.rs)
	devInfo:		() => [ "devInfo" ] as const,
	price:			( range: string ) => [ "price", range ] as const,		// the ZEC price, once the person said yes
	value:			( walletId: string, account: number, range: string, on: boolean ) => [ "value", walletId, account, range, on ] as const,		// what an account was worth; asked again once prices are on
	repeats:		() => [ "repeats" ] as const,		// payments that come back (w_repeat.rs)
	alerts:			() => [ "alerts" ] as const,		// price alerts (w_alert.rs)
	devReport:		() => [ "devReport" ] as const,
	server:			() => [ "server" ] as const,		// the app's, not a wallet's
	storage:		() => [ "storage" ] as const,		// this computer's
	folder:			() => [ "folder" ] as const,		// sync between computers (w_folder.rs)
	offline:		() => [ "offline" ] as const,		// signing requests waiting for their signed payment (w_offline.rs)
	document:		() => [ "document" ] as const,		// a native picker action completed after unlocking
	spendKey:		() => [ "spendKey" ] as const,		// Sapling's spend proving key is here (w_spendkey.rs)
};

// module state (see scripts/check_owners.mjs): a hot update would make a
// second, empty copy that some screens watch and nothing starts; the page
// starts over instead, the way it does in a real launch
import.meta.hot?.accept( () => location.reload() );
