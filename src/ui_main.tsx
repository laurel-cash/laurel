/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_main.tsx -- top level of the ui: starts the store, picks the screen
//
// Wallet data lives in ui_store.ts. This file only decides what is on
// screen; it keeps no copy of anything the engine owns.

import { Component, ErrorInfo, ReactNode, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

import { Com_ErrorOf, Com_Unreachable, commands, created_t, failedWallet_t, recovery_t } from "./ui_local";
import { RUST_WORDS, T } from "./ui_text";
import { useAction, useTextScale } from "./ui_hooks";
import { St_Start, useAppScreen, useStore } from "./ui_store";
import { UI_Alert, UI_Spinner, UI_TipProvider, UI_Waiting } from "./ui_widgets";
import { UI_WhatsNewSheet, useWhatsNew } from "./ui_notes";
import { UI_FailedWallets } from "./ui_wallets";
import { UI_TitleBar } from "./ui_chrome";
import { UI_Welcome } from "./ui_onboard";
import { QUERY } from "./ui_query";
import { UI_Backup } from "./ui_backup";
import { method_t, UI_Restore } from "./ui_restore";
import { UI_Home } from "./ui_home";
import { UI_NameSheet } from "./ui_sheets";
import { UI_Documents } from "./ui_documents";
import { addWalletKind_t } from "./ui_switcher";
import { Com_ShouldOfferPassword, UI_CreatePasswordScreen, UI_LockScreen, UI_PasswordOffer, UI_VaultErrorScreen, useAutoLock } from "./ui_security";

// a flow the user is in the middle of, on top of the app screen.
// backup and restore carry what they need
type visit_t =
	| { kind: "none" }
	| { kind: "backup"; walletId: string; recovery: recovery_t | null }
	| { kind: "restore"; method: method_t }
	| { kind: "passwordOffer" };


/*
==================
UI_App
==================
*/
// Ctrl+L and auto-lock, for the whole app, from inside the query provider
function UI_AutoLock() {
	useAutoLock();
	return null;
}

// the chosen text size, for the whole app
function UI_TextScale() {
	const constants = useStore( ( s ) => s.constants );
	useTextScale( constants?.textScales ?? NO_SCALES );
	return null;
}
const NO_SCALES: number[] = [];

/*
==================
UI_ErrorBoundary

A screen that throws while drawing: without this the whole window went
blank, a wallet with no way on (found drawing the sweep sheet with an
answer it didn't expect). It says what happened, keeps the engine's
words behind Details, and draws again when asked. The engine, its
syncing and its saves run in rust, apart from the page, so nothing is
lost by drawing again.
==================
*/
export class UI_ErrorBoundary extends Component< { children: ReactNode }, { error: unknown } > {
	state = { error: null as unknown };

	static getDerivedStateFromError( error: unknown ) {
		return { error };
	}

	componentDidCatch( error: unknown, info: ErrorInfo ) {
		console.error( "UI_ErrorBoundary", error, info.componentStack );
	}

	render() {
		if ( this.state.error === null ) {
			return this.props.children;
		}
		return (
			<div className="onboard">
				<div className="onboard-card">
					<UI_Alert title={T.chrome.crashTitle} message={{ message: T.chrome.crash, detail: Com_ErrorOf( this.state.error ).message, retry: false }} action={T.chrome.crashRetry} onAction={() => this.setState( { error: null } )} />
				</div>
			</div>
		);
	}
}

/*
==================
UI_Closing

Over everything once the engine says it is closing: the window stays
until each wallet is saved, and a window that went quiet looked hung.
==================
*/
function UI_Closing() {
	const closing = useStore( ( s ) => s.closing );
	if ( !closing ) {
		return null;
	}
	return (
		<div className="closing" role="alertdialog" aria-live="assertive" aria-label={T.chrome.closing}>
			<UI_Spinner size={24} />
			<p className="closing-title">{T.chrome.closing}</p>
			<p className="closing-why">{T.chrome.closingWhy}</p>
		</div>
	);
}

export function UI_App() {
	return (
		<QueryClientProvider client={QUERY}>
			<UI_TipProvider>
				<UI_AutoLock />
				<UI_TextScale />
				<UI_TitleBar />
				<UI_ErrorBoundary><UI_Screen /></UI_ErrorBoundary>
				<UI_Closing />
				<UI_Documents />
			</UI_TipProvider>
		</QueryClientProvider>
	);
}

/*
==================
UI_WalletsFailed

Wallets exist on disk but none could be opened. Never onboarding: that
would look like the money is gone. Each failure is listed with its
reason; restoring from a phrase or making a new wallet stays possible.
==================
*/
function UI_WalletsFailed( props: { failed: failedWallet_t[]; onRestore: () => void } ) {
	return (
		<div className="onboard">
			<div className="onboard-card">
				<UI_FailedWallets failed={props.failed} />
				<div className="onboard-actions">
					<button className="btn primary large" onClick={props.onRestore}>{T.welcome.restore}</button>
				</div>
			</div>
		</div>
	);
}

/*
==================
UI_Screen

The app screen comes from St_Screen, one exhaustive union. A visit
(backup, restore, the password offer) shows on top of it and returns
to it when done.
==================
*/
function UI_Screen() {
	const app		= useAppScreen();
	const vault		= useStore( ( s ) => s.vault );
	const select	= useStore( ( s ) => s.Select );
	const refresh	= useStore( ( s ) => s.Refresh );
	const newName	= useStore( ( s ) => s.constants?.defaultWalletName ?? "" );

	const [ visit, setVisit ]	= useState< visit_t >( { kind: "none" } );
	const [ naming, setNaming ]	= useState( false );
	const retry = useAction( refresh );
	// what's new after an update, once the screen knows whether this is a first run
	const whatsNew = useWhatsNew( app.kind === "firstRun" || app.kind === "wallets" || app.kind === "allFailed", app.kind === "firstRun" );

	// rust's words first (errors, notifications), so even the vault's first error is in this language
	useEffect( () => {
		void Promise.resolve()
			.then( () => commands.wSetWordsF( RUST_WORDS ) )
			.catch( ( e: unknown ) => console.error( "wSetWordsF", e ) )		// rust keeps its English: never a blank message
			.finally( () => St_Start() );
	}, [] );

	useEffect( () => {
		if ( vault?.state !== "unlocked" ) {
			setVisit( { kind: "none" } );
			setNaming( false );
		}
	}, [ vault?.state ] );

	function Created( c: created_t ) {
		select( { walletId: c.id, account: 0 } );
		setVisit( { kind: "backup", walletId: c.id, recovery: c.recovery } );
	}

	// which restore screen each way of adding a wallet opens on
	const RESTORE_METHOD: Record< Exclude< addWalletKind_t, "create" >, method_t > = { restore: "phrase", viewOnly: "viewkey", zcashd: "zcashd" };

	function AddWallet( kind: addWalletKind_t ) {
		if ( kind === "create" ) {
			setNaming( true );
		} else {
			setVisit( { kind: "restore", method: RESTORE_METHOD[kind] } );
		}
	}

	const done = () => setVisit( { kind: "none" } );
	const restore = () => setVisit( { kind: "restore", method: "phrase" } );

	// a first backup finished: offer a password once, if only windows guards the key
	function BackedUp() {
		setVisit( Com_ShouldOfferPassword( vault ) ? { kind: "passwordOffer" } : { kind: "none" } );
	}

	// screens before any wallet is open can't be visited over
	switch ( app.kind ) {
	case "locking":
		return <div className="boot"><UI_Waiting text={T.security.locking} size={24} /></div>;
	case "booting":
		return <div className="boot"><UI_Spinner size={24} /></div>;
	case "vaultError":
		return <UI_VaultErrorScreen message={app.message} />;
	case "locked":
		return <UI_LockScreen />;
	case "needsPassword":
		return <UI_CreatePasswordScreen />;
	case "loadError":
		return (
			<div className="onboard">
				<div className="onboard-card">
					<UI_Alert title={T.home.somethingWrong} message={app.message} action={T.common.tryAgain} onAction={retry.run} />
				</div>
			</div>
		);
	case "firstRun":
	case "allFailed":
	case "wallets":
		break;
	default:
		return Com_Unreachable( app );
	}

	switch ( visit.kind ) {
	case "passwordOffer":
		return <UI_PasswordOffer onDone={done} />;
	case "backup":
		return <UI_Backup walletId={visit.walletId} recovery={visit.recovery} onDone={BackedUp} onLater={done} onMarked={() => setVisit( { kind: "backup", walletId: visit.walletId, recovery: null } )} />;
	case "restore":
		return <UI_Restore method={visit.method} onDone={( id ) => { select( { walletId: id, account: 0 } ); done(); }} onBack={done} />;
	case "none":
		break;
	default:
		return Com_Unreachable( visit );
	}

	if ( app.kind === "firstRun" ) {
		return <UI_Welcome onCreated={Created} onRestore={restore} />;
	}
	if ( app.kind === "allFailed" ) {
		return <UI_WalletsFailed failed={app.failed} onRestore={restore} />;
	}

	return (
		<>
			<UI_Home onAddWallet={AddWallet} onBackup={( id ) => setVisit( { kind: "backup", walletId: id, recovery: null } )} />
			<UI_WhatsNewSheet open={whatsNew.open} onOpenChange={whatsNew.onOpenChange} />
			<UI_NameSheet
				open={naming}
				onOpenChange={setNaming}
				title={T.sheets.newWalletTitle}
				description={T.sheets.newWallet}
				initial={newName}
				action={T.sheets.create}
				save={async ( name ) => {
					const created = await commands.wCreateF( useStore.getState().network, name );
					await refresh();
					Created( created );
				}}
			/>
		</>
	);
}
