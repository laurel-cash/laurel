/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_store.ts -- the ui's copy of engine state: wallets, accounts,
// balances, sync, and which account is open
//
// The engine owns all of it; this is a cache that only ever takes the
// newest snapshot. Every summary and sync event carries a seq from rust,
// and anything older than what is already here is dropped, so a slow
// reply can never roll a balance back.

import { create } from "zustand";

import { KEYS, QUERY } from "./ui_query";

import { appearance_t, Com_ApplyTheme, Com_ErrorOf, Com_IsAppearance, Com_IsBool, Com_IsSelection, Com_ReadPref, Com_Unreachable, Com_WritePref, Com_HomeLayout, commands, constants_t, errorInfo_t, events, failedWallet_t, network_t, Com_NewsKey, news_t, PREF_APPEARANCE, PREF_HIDE_AMOUNTS, PREF_HOME, PREF_SELECTION, homeLayout_t, pool_t, selection_t, syncEvent_t, vaultStatus_t, walletList_t, walletSummary_t, HOME_DEFAULT } from "./ui_local";

// the app's pages, and the panes of Settings (ui_settings.tsx)
export type page_t			= "home" | "history" | "settings";
export type settingsPane_t	= "general" | "security" | "notifications" | "wallets" | "contacts" | "folder" | "offline" | "network" | "storage" | "developer" | "help" | "about";

type storeState_t = {
	constants:		constants_t | null;
	vault:			vaultStatus_t | null;			// null until the engine answers
	vaultError:		errorInfo_t | null;				// the key can't be opened at all
	wallets:		Record< string, walletSummary_t >;
	order:			string[];						// wallet ids, oldest first
	failed:			failedWallet_t[];				// on disk, but couldn't be opened
	firstRun:		boolean;						// the engine says: no wallet on disk at all
	loaded:			boolean;
	loadError:		errorInfo_t | null;
	selection:		selection_t | null;
	appearance:		appearance_t;
	hideAmounts:	boolean;
	home:			homeLayout_t;					// the dashboard's cards (Com_HomeLayout), per computer
	news:			news_t[];						// this session's, not dismissed, newest last: payments (arrived, went through, didn't), price alerts
	closing:		boolean;						// the engine says: closing, saving every wallet first (Sys_Close)
	network:		network_t;						// the one open (w_settings.rs); read at start, before any wallet
	page:			page_t;
	settingsPane:	settingsPane_t;
	settingsShown:	"list" | "pane";				// a phone shows one: Settings alone is its list, sent to a pane the pane (Go)
	historyPools:	pool_t[];						// the pools History opens filtered to (GoHistory); none from anywhere else

	Refresh:		() => Promise< void >;
	Dismiss:		( key: string ) => void;			// Com_NewsKey
	Select:			( sel: selection_t ) => void;
	SetAppearance:	( a: appearance_t ) => void;
	SetHome:		( layout: homeLayout_t ) => void;
	ToggleAmounts:	() => void;
	Go:				( page: page_t, pane?: settingsPane_t ) => void;		// a page, and for Settings which pane
	GoHistory:		( pools: pool_t[] ) => void;		// History, showing only these pools
	SetVault:		( v: vaultStatus_t ) => void;
	Lock:			() => Promise< void >;		// only with a password; the title bar, Lock Now, Ctrl+L and auto-lock all use this
};


/*
=========================================================================

STORE

=========================================================================
*/

export const useStore = create< storeState_t >()( ( set ) => ( {
	constants:		null,
	vault:			null,
	vaultError:		null,
	wallets:		{},
	order:			[],
	failed:			[],
	firstRun:		false,
	loaded:			false,
	loadError:		null,
	selection:		Com_ReadPref< selection_t | null >( PREF_SELECTION, null, Com_IsSelection ),
	appearance:		Com_ReadPref< appearance_t >( PREF_APPEARANCE, "system", Com_IsAppearance ),
	news:			[],
	closing:		false,
	network:		"testnet",
	page:			"home",
	settingsPane:	"general",
	settingsShown:	"list",
	historyPools:	[],
	hideAmounts:	Com_ReadPref( PREF_HIDE_AMOUNTS, false, Com_IsBool ),
	home:			Com_HomeLayout( Com_ReadPref< unknown >( PREF_HOME, null, ( _v ): _v is unknown => true ) ),		// any shape: Com_HomeLayout reads it

	/*
	==================
	Refresh

	Asks the engine for every wallet again, after anything that changes
	them (create, restore, add account, rename). Opens the wallets on
	first use. Stale replies are dropped by St_ApplySummary.
	==================
	*/
	Refresh: async () => {
		try {
			const list = await commands.wListF( useStore.getState().network );
			St_ApplyList( list );
			set( { loaded: true, loadError: null } );
		} catch ( e ) {
			set( { loaded: true, loadError: Com_ErrorOf( e ) } );
		}
	},

	Select: ( sel: selection_t ) => {
		Com_WritePref( PREF_SELECTION, sel );
		set( { selection: sel } );
	},

	SetAppearance: ( a: appearance_t ) => {
		Com_WritePref( PREF_APPEARANCE, a );
		Com_ApplyTheme( a );
		set( { appearance: a } );
	},

	Dismiss: ( key: string ) => {
		set( ( s ) => ( { news: s.news.filter( ( n ) => Com_NewsKey( n ) !== key ) } ) );
	},

	Go: ( page: page_t, pane?: settingsPane_t ) => set( ( s ) => ( { page: page, settingsPane: pane ?? s.settingsPane, settingsShown: pane ? "pane" : "list", historyPools: [] } ) ),
	GoHistory: ( pools: pool_t[] ) => set( { page: "history", historyPools: pools } ),

	/*
	==================
	Lock

	The engine forgets the key and closes the wallets; SetVault then clears
	what the screens showed. A lock that fails leaves Laurel as it was.
	==================
	*/
	Lock: async () => {
		try {
			useStore.getState().SetVault( await commands.wLockF() );
		} catch ( e ) {
			console.error( "Lock: failed", e );
		}
	},

	SetHome: ( layout: homeLayout_t ) => {
		Com_WritePref( PREF_HOME, layout );
		set( { home: layout } );
	},

	ToggleAmounts: () => {
		const hide = !useStore.getState().hideAmounts;
		Com_WritePref( PREF_HIDE_AMOUNTS, hide );
		set( { hideAmounts: hide } );
	},

	/*
	==================
	SetVault

	Every vault command answers with the new status. Unlocking for the
	first time is what opens the wallets.
	==================
	*/
	SetVault: ( v: vaultStatus_t ) => {
		const wasUnlocked = useStore.getState().vault?.state === "unlocked";
		set( { vault: v, vaultError: null } );
		if ( v.state === "unlocked" && !wasUnlocked ) {
			useStore.getState().Refresh();
		}
		// locked: what the wallets showed leaves memory too (balances, addresses,
		// history); the selection stays, so unlocking returns to the same place
		if ( v.state !== "unlocked" && wasUnlocked ) {
			set( { wallets: {}, order: [], failed: [], loaded: false, news: [] } );
			QUERY.clear();
		}
	},
} ) );


/*
=========================================================================

APPLYING ENGINE DATA

=========================================================================
*/

/*
==================
St_IsNewer
==================
*/
function St_IsNewer( id: string, seq: number ): boolean {
	const have = useStore.getState().wallets[id];
	return !have || seq >= have.seq;
}

/*
==================
St_ApplyList

A full list is also the truth about which wallets exist and their order
==================
*/
function St_ApplyList( list: walletList_t ) {
	const wallets = { ...useStore.getState().wallets };

	for ( const summary of list.wallets ) {
		if ( St_IsNewer( summary.id, summary.seq ) ) {
			wallets[summary.id] = summary;
		}
	}
	useStore.setState( { wallets, order: list.wallets.map( ( s ) => s.id ), failed: list.failed, firstRun: list.firstRun } );

	// a computer that has never had a wallet starts with one balance and no pool list
	// (the privacy card's See Your Pools brings it back); saved now, so it stays chosen
	if ( list.firstRun && Com_ReadPref< unknown >( PREF_HOME, null, ( _v ): _v is unknown => true ) === null ) {
		useStore.getState().SetHome( { ...HOME_DEFAULT, hidden: [ "pools" ] } );
	}
}

/*
==================
St_ApplyEvent

A sync event carries progress and balances only; names and accounts
come with summaries. An event for an account the store doesn't know yet
(just added) waits for the refresh that follows the add.
==================
*/
function St_ApplyEvent( ev: syncEvent_t ) {
	const have = useStore.getState().wallets[ev.walletId];
	if ( !have || ev.seq < have.seq ) {
		return;
	}

	const next: walletSummary_t = {
		...have,
		seq:		ev.seq,
		progress:	ev.progress,
		accounts:	have.accounts.map( ( a ) => ( { ...a, balance: ev.balances[a.index] ?? a.balance } ) ),
	};
	useStore.setState( { wallets: { ...useStore.getState().wallets, [ev.walletId]: next } } );
}


/*
=========================================================================

STARTUP

=========================================================================
*/

let st_started: Promise< void > | null = null;

// news for the corner (ui_toast.tsx)
function St_Tell( n: news_t ) {
	useStore.setState( ( s ) => ( { news: [ ...s.news, n ] } ) );
}

/*
==================
St_Start

Once per app run, however many times it is called (react runs startup
effects twice in development). The event listener is attached before
the first list is fetched, so no sync event can fall in the gap. The
vault opens first: wallets can only be read once it is unlocked, which
is at once when windows protects the key, or after the password.
==================
*/
export function St_Start(): Promise< void > {
	if ( !st_started ) {
		st_started = ( async () => {
			Com_ApplyTheme( useStore.getState().appearance );
			await events.syncEventT.listen( ( e ) => St_ApplyEvent( e.payload ) );
			await events.vaultChangedEventT.listen( () => {
				void commands.vStatusF().then( ( v ) => useStore.getState().SetVault( v ) )
					.catch( ( e: unknown ) => useStore.setState( { vaultError: Com_ErrorOf( e ) } ) );
			} );
			await events.closingEventT.listen( () => useStore.setState( { closing: true } ) );
			await events.documentChangedEventT.listen( () => {
				void QUERY.invalidateQueries( { queryKey: KEYS.document() } );
				void QUERY.invalidateQueries( { queryKey: KEYS.offline() } );
			} );
			await events.paymentEventT.listen( ( e ) => St_Tell( { kind: "payment", payment: e.payload } ) );
			await events.priceAlertEventT.listen( ( e ) => {
				St_Tell( { kind: "price", alert: e.payload } );
				void QUERY.invalidateQueries( { queryKey: KEYS.alerts() } );
			} );
			await events.repeatDueEventT.listen( () => void QUERY.invalidateQueries( { queryKey: KEYS.repeats() } ) );
			// another computer's changes arrived: what they touch is read again (docs/SYNC.md)
			await events.folderSyncedEventT.listen( () => {
				for ( const key of [ KEYS.folder(), KEYS.contacts(), KEYS.settings(), [ "transactions" ] ] ) {
					void QUERY.invalidateQueries( { queryKey: key } );
				}
			} );
			useStore.setState( { constants: await commands.wConstantsF(), network: ( await commands.sGetF() ).network } );
			try {
				useStore.getState().SetVault( await commands.vOpenF() );
			} catch ( e ) {
				useStore.setState( { vaultError: Com_ErrorOf( e ) } );
			}
		} )();
	}
	return st_started;
}


/*
=========================================================================

SELECTORS

=========================================================================
*/

/*
==================
useCurrent

The wallet and account on screen. A remembered selection that no longer
exists (wallet removed, file lost) falls back to the first account of
the first wallet rather than showing nothing.
==================
*/
export function useCurrent() {
	const wallets	= useStore( ( s ) => s.wallets );
	const order		= useStore( ( s ) => s.order );
	const selection	= useStore( ( s ) => s.selection );

	let wallet = selection ? wallets[selection.walletId] : undefined;
	if ( !wallet && order.length ) {
		wallet = wallets[order[0]];
	}
	const account = wallet?.accounts.find( ( a ) => a.index === selection?.account ) ?? wallet?.accounts[0];

	return { wallet, account };
}


/*
=========================================================================

WHAT IS ON SCREEN

=========================================================================
*/

export type appScreen_t =
	| { kind: "booting" }
	| { kind: "locking" }
	| { kind: "vaultError"; message: errorInfo_t }
	| { kind: "locked" }
	| { kind: "needsPassword" }
	| { kind: "loadError"; message: errorInfo_t }
	| { kind: "firstRun" }
	| { kind: "allFailed"; failed: failedWallet_t[] }
	| { kind: "wallets" };

type screenInputs_t = Pick< storeState_t, "vault" | "vaultError" | "loaded" | "loadError" | "firstRun" | "order" | "failed" >;

/*
==================
St_Screen

The one place that decides which top-level screen shows. Pure, so every
case is tested (ui_store.test.ts), and every consumer switches over the
result exhaustively. Nothing here is guessed: first run is the engine's
answer, never "no wallets loaded", which is also what a wallet that
failed to open looks like.
==================
*/
export function St_Screen( s: screenInputs_t ): appScreen_t {
	if ( s.vaultError ) {
		return { kind: "vaultError", message: s.vaultError };
	}
	if ( !s.vault ) {
		return { kind: "booting" };
	}
	switch ( s.vault.state ) {
	case "locking":
		return { kind: "locking" };
	case "locked":
		return { kind: "locked" };
	case "needsPassword":
		return { kind: "needsPassword" };
	case "unlocked":
		break;
	default:
		return Com_Unreachable( s.vault.state );
	}
	if ( !s.loaded ) {
		return { kind: "booting" };
	}
	if ( s.loadError && !s.order.length ) {
		return { kind: "loadError", message: s.loadError };
	}
	if ( s.firstRun ) {
		return { kind: "firstRun" };
	}
	if ( !s.order.length ) {
		return { kind: "allFailed", failed: s.failed };
	}
	return { kind: "wallets" };
}

export function useAppScreen(): appScreen_t {
	return St_Screen( {
		vault:		useStore( ( s ) => s.vault ),
		vaultError:	useStore( ( s ) => s.vaultError ),
		loaded:		useStore( ( s ) => s.loaded ),
		loadError:	useStore( ( s ) => s.loadError ),
		firstRun:	useStore( ( s ) => s.firstRun ),
		order:		useStore( ( s ) => s.order ),
		failed:		useStore( ( s ) => s.failed ),
	} );
}

// module state (see scripts/check_owners.mjs): a hot update would make a
// second, empty copy that some screens watch and nothing starts; the page
// starts over instead, the way it does in a real launch
import.meta.hot?.accept( () => location.reload() );
