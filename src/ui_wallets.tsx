/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_wallets.tsx -- the wallets on this computer: their backup state, the
// recovery phrase, and taking one off this computer, safely

import { useEffect, useState } from "react";
import { ArrowRightLeft, Eye, FileKey, KeyRound, Pencil, Plus, ShieldAlert, Trash2, WalletCards } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { commands, Com_Error, errorInfo_t, failedWallet_t, walletKind_t, walletSummary_t } from "./ui_local";
import { T } from "./ui_text";
import { useAction } from "./ui_hooks";
import { useStore } from "./ui_store";
import { KEYS, QUERY } from "./ui_query";
import type { addWalletKind_t } from "./ui_switcher";
import { UI_AddAccountSheet, UI_NameSheet } from "./ui_sheets";
import { UI_AskPassword } from "./ui_security";
import { sheetProps_t, UI_Alert, UI_Amount, UI_Sheet, UI_SheetButtons, UI_SheetClose } from "./ui_widgets";


/*
==================
UI_RemoveSheet

A backed-up wallet: say what stays true, confirm. One that isn't: lead
with backing it up, and remove only after its name is typed.
==================
*/
/*
==================
KINDS

How each kind of wallet shows itself, decided once for every screen: a
new kind must say all of it here
==================
*/
export const KINDS: Record< walletKind_t, { icon: LucideIcon; badge: string | null; status: string | null; remove: string } > = {
	seed:		{ icon: WalletCards,	badge: null,				status: null,						remove: T.wallets.removeSafe },		// its status is its backup
	viewOnly:	{ icon: Eye,			badge: T.common.viewOnly,	status: T.wallets.viewOnly,			remove: T.wallets.removeViewOnly },
	key:		{ icon: FileKey,		badge: T.common.zcashd,		status: T.wallets.importedKeys,		remove: T.wallets.removeKey },
};

// what a wallet's card can start elsewhere in the app (ui_home.tsx carries them out)
export type walletActions_t = {
	onBackup:		( walletId: string ) => void;
	onAddWallet:	( kind: addWalletKind_t ) => void;
	onSendAll:		( walletId: string, account: number, to: string ) => void;		// Send, with Max, to this address
};

/*
==================
UI_MoveSheet

Everything out of a wallet whose phrase may have leaked: into a wallet
only the person holds (one with a phrase, backed up), one account at a
time through Send (reviewed like any payment), then the old one removed.
Each step is what the engine says: kinds, backups, balances.
==================
*/
function UI_MoveSheet( props: sheetProps_t & { wallet: walletSummary_t; actions: walletActions_t; onRemove: () => void } ) {
	const wallets	= useStore( ( s ) => s.wallets );
	const order		= useStore( ( s ) => s.order );
	const w			= props.wallet;
	// a home for the money: a wallet that receives it and can spend it again here
	const targets	= order.map( ( id ) => wallets[id] ).filter( ( t ): t is walletSummary_t => !!t && t.id !== w.id && t.can.receive && t.can.spend );
	const [ to, setTo ] = useState< string | null >( null );
	const target	= targets.find( ( t ) => t.id === to ) ?? targets.find( ( t ) => t.backedUp ) ?? targets[0] ?? null;
	const empty		= w.accounts.every( ( a ) => a.balance.total === 0 );

	// the target's address, from the same cache Receive fills
	const send = useAction( async ( account: number ) => {
		if ( !target ) {
			return;
		}
		const r = await QUERY.fetchQuery( { queryKey: KEYS.receive( target.id, 0 ), queryFn: () => commands.wReceiveF( target.id, 0, null ) } );
		props.onOpenChange( false );
		props.actions.onSendAll( w.id, account, r.shielded );
	}, props.open );

	let body;
	if ( empty ) {
		body = (
			<>
				<p className="hint">{T.wallets.moveDone}</p>
				<UI_SheetButtons action={{ label: T.wallets.moveRemove, danger: true, onRun: () => { props.onOpenChange( false ); props.onRemove(); } }} busy={false} onCancel={() => props.onOpenChange( false )} cancel={T.common.close} />
			</>
		);
	} else if ( !target ) {
		body = (
			<>
				<p className="hint">{T.wallets.moveNoTarget}</p>
				<UI_SheetButtons action={{ label: T.wallets.moveCreate, onRun: () => { props.onOpenChange( false ); props.actions.onAddWallet( "create" ); } }} busy={false} onCancel={() => props.onOpenChange( false )} />
			</>
		);
	} else {
		body = (
			<>
				<label className="label" htmlFor="move-to">{T.wallets.moveTo}</label>
				<select id="move-to" className="field-select" value={target.id} onChange={( e ) => setTo( e.target.value )}>
					{targets.map( ( t ) => <option key={t.id} value={t.id}>{t.name}</option> )}
				</select>
				{!target.backedUp ? (
					<>
						<p className="hint bad">{T.wallets.moveBackUp( target.name )}</p>
						<UI_SheetButtons action={{ label: T.wallets.backUpNow, onRun: () => { props.onOpenChange( false ); props.actions.onBackup( target.id ); } }} busy={false} onCancel={() => props.onOpenChange( false )} />
					</>
				) : (
					<>
						<ul className="wallet-accounts">
							{w.accounts.map( ( a ) => (
								<li key={a.index} className="wallet-account">
									<span className="wallet-account-name">{a.name}</span>
									<span className="wallet-account-amount"><UI_Amount zats={a.balance.total} unit /></span>
									{a.balance.total > 0
										? <button className="btn small primary" disabled={send.busy} onClick={() => void send.run( a.index )}>{T.wallets.moveSend}</button>
										: <span className="hint">{T.wallets.moveEmpty}</span>}
								</li>
							) )}
						</ul>
						{send.error && <UI_Alert title={T.receive.failed} message={send.error} />}
						<UI_SheetClose onClose={() => props.onOpenChange( false )} />
					</>
				)}
			</>
		);
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.wallets.moveTitle( w.name )} description={T.wallets.moveLede} busy={send.busy}>
			{body}
		</UI_Sheet>
	);
}

function UI_RemoveSheet( props: sheetProps_t & { wallet: walletSummary_t; onBackup: () => void } ) {
	const refresh = useStore( ( s ) => s.Refresh );
	const [ typed, setTyped ] = useState( "" );
	const w = props.wallet;
	const risky = w.kind === "seed" && !w.backedUp;
	const ready = !risky || typed.trim() === w.name;

	const usesPassword = useStore( ( s ) => s.vault?.protection === "password" );
	const [ asking, setAsking ] = useState( false );

	// Laurel removes a wallet only for someone just asked: the password when there is one
	const remove = useAction( async ( password: string | null ) => {
		await commands.wRemoveWalletF( w.id, password );
		await refresh();
		props.onOpenChange( false );
	}, props.open );

	function Remove() {
		if ( usesPassword ) {
			setAsking( true );
		} else {
			remove.run( null );
		}
	}

	useEffect( () => {
		if ( props.open ) {
			setTyped( "" );
		}
	}, [ props.open ] );

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.wallets.removeTitle( w.name )} busy={remove.busy}>
			{risky ? (
				<>
					<div className="warn-note"><ShieldAlert aria-hidden="true" /><span>{T.wallets.removeUnsafe}</span></div>
					<button className="btn primary wide" onClick={() => { props.onOpenChange( false ); props.onBackup(); }}>
						<KeyRound aria-hidden="true" />{T.wallets.backUpFirst}
					</button>
					<label className="label" htmlFor="remove-name">{T.wallets.typeName( w.name )}</label>
					<input id="remove-name" className="field" value={typed} spellCheck={false} onChange={( e ) => setTyped( e.target.value )} />
				</>
			) : (
				<p className="sheet-desc">{KINDS[w.kind].remove}</p>
			)}
			{remove.error && <UI_Alert title={T.wallets.failed} message={remove.error} />}
			<UI_SheetButtons busy={remove.busy} onCancel={() => props.onOpenChange( false )} action={!ready ? null : {
				label:		remove.busy ? T.wallets.removing : T.wallets.action,
				onRun:		Remove,
				icon:		<Trash2 aria-hidden="true" />,
				danger:		true,
			}} />
			<UI_AskPassword
				open={asking}
				onOpenChange={setAsking}
				title={T.wallets.removeTitle( w.name )}
				why={T.wallets.askWhy}
				action={T.wallets.action}
				onConfirm={( password ) => remove.run( password )}
			/>
		</UI_Sheet>
	);
}

/*
==================
UI_WalletsSection
==================
*/
export function UI_WalletsSection( props: { actions: walletActions_t } ) {
	const wallets	= useStore( ( s ) => s.wallets );
	const order		= useStore( ( s ) => s.order );
	const refresh	= useStore( ( s ) => s.Refresh );
	const [ removing, setRemoving ]	= useState< walletSummary_t | null >( null );
	const [ open, setOpen ]			= useState( false );
	const [ naming, setNaming ]		= useState< naming_t | null >( null );
	const [ nameOpen, setNameOpen ]	= useState( false );
	const [ adding, setAdding ]		= useState< walletSummary_t | null >( null );
	const [ addOpen, setAddOpen ]	= useState( false );
	const [ moving, setMoving ]		= useState< walletSummary_t | null >( null );
	const [ moveOpen, setMoveOpen ]	= useState( false );

	function Rename( n: naming_t ) {
		setNaming( n );
		setNameOpen( true );
	}

	return (
		<section className="settings-section">
			{order.map( ( id ) => wallets[id] ).filter( ( w ): w is walletSummary_t => !!w ).map( ( w ) => {
				const seed		= w.kind === "seed";
				const unsafe	= seed && !w.backedUp;
				const Icon		= KINDS[w.kind].icon;
				const sameWords	= w.sameWords.map( ( id ) => wallets[id]?.name ).filter( ( n ): n is string => !!n );
				return (
					<div key={w.id} className={"wallet-card" + ( unsafe ? " unsafe" : "" )}>
						<div className="wallet-card-head">
							<span className="set-icon"><Icon aria-hidden="true" /></span>
							<span className="set-text">
								<span className="set-label">{w.name}</span>
								<span className={"set-sub" + ( unsafe ? " warn" : "" )}>
									{T.wallets.accounts( w.accounts.length )} · {KINDS[w.kind].status ?? ( w.backedUp ? T.wallets.backedUp : T.wallets.notBackedUp )}
								</span>
							</span>
							<span className="wallet-total"><UI_Amount zats={w.accounts.reduce( ( sum, a ) => sum + a.balance.total, 0 )} unit /></span>
						</div>

						{seed && w.accounts.length > 1 && <p className="wallet-note">{T.wallets.oneBackup( w.accounts.length )}</p>}
						{sameWords.length > 0 && <p className="wallet-note">{T.wallets.sameWords( sameWords )}</p>}

						<ul className="wallet-accounts">
							{w.accounts.map( ( a ) => (
								<li key={a.index} className="wallet-account">
									<span className="wallet-account-name">{a.name}</span>
									<span className="wallet-account-amount"><UI_Amount zats={a.balance.total} unit /></span>
									<button
										className="link quiet"
										onClick={() => Rename( { title: T.sheets.renameAccountTitle, initial: a.name, save: async ( name ) => { await commands.wRenameAccountF( w.id, a.index, name ); await refresh(); } } )}
									>
										{T.wallets.rename}
									</button>
								</li>
							) )}
						</ul>

						<div className="wallet-actions">
							{unsafe && <button className="btn primary small" onClick={() => props.actions.onBackup( w.id )}><KeyRound aria-hidden="true" />{T.wallets.backUpNow}</button>}
							<button className="btn small" onClick={() => Rename( { title: T.sheets.renameWalletTitle, initial: w.name, save: async ( name ) => { await commands.wRenameWalletF( w.id, name ); await refresh(); } } )}>
								<Pencil aria-hidden="true" />{T.wallets.renameWallet}
							</button>
							{w.can.addAccount && <button className="btn small" onClick={() => { setAdding( w ); setAddOpen( true ); }}><Plus aria-hidden="true" />{T.wallets.addAccount}</button>}
							{seed && !unsafe && <button className="btn small" onClick={() => props.actions.onBackup( w.id )}><KeyRound aria-hidden="true" />{T.wallets.show}</button>}
							{w.can.spend && w.accounts.some( ( a ) => a.balance.total > 0 ) && (
								<button className="btn small" onClick={() => { setMoving( w ); setMoveOpen( true ); }}><ArrowRightLeft aria-hidden="true" />{T.wallets.moveAll}</button>
							)}
							<button className="btn small danger-quiet" onClick={() => { setRemoving( w ); setOpen( true ); }}><Trash2 aria-hidden="true" />{T.wallets.remove}</button>
						</div>
					</div>
				);
			} )}
			{removing && <UI_RemoveSheet open={open} onOpenChange={setOpen} wallet={removing} onBackup={() => props.actions.onBackup( removing.id )} />}
			{moving && <UI_MoveSheet open={moveOpen} onOpenChange={setMoveOpen} wallet={wallets[moving.id] ?? moving} actions={props.actions} onRemove={() => { setRemoving( moving ); setOpen( true ); }} />}
			{naming && <UI_NameSheet open={nameOpen} onOpenChange={setNameOpen} title={naming.title} initial={naming.initial} action={T.common.save} save={naming.save} />}
			{adding && <UI_AddAccountSheet open={addOpen} onOpenChange={setAddOpen} wallet={adding} onAdded={() => {}} />}
		</section>
	);
}

// what the one rename sheet renames: a wallet, or one of its accounts
type naming_t = { title: string; initial: string; save: ( name: string ) => Promise< unknown > };

/*
==================
UI_FailedWallets

Every wallet that couldn't be opened, as one alert: each distinct reason
in words, and each wallet's engine text behind Details
==================
*/
export function UI_FailedWallets( props: { failed: failedWallet_t[] } ) {
	const message	= [ ...new Set( props.failed.map( ( f ) => f.error.message ) ) ].join( " " );
	const detail	= props.failed.filter( ( f ) => f.error.detail ).map( ( f ) => `${f.id}: ${f.error.detail ?? ""}` ).join( "\n" );
	return <UI_Alert title={T.security.failedWallets( props.failed.length )} message={Com_Error( message, detail || null )} />;
}

/*
==================
UI_SaveFailed

A wallet that can't be written to disk: why, and that it's safe in memory
==================
*/
export function UI_SaveFailed( props: { wallet: walletSummary_t; error: errorInfo_t } ) {
	const message = [ props.error.message, T.security.saveFailedHint ].join( " " );
	return <UI_Alert title={T.security.saveFailed( props.wallet.name )} message={Com_Error( message, props.error.detail )} />;
}
