/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_txsheet.tsx -- one transaction, whole
//
// Opened from a line in History. Each part is its own piece, top to
// bottom, one story in one column: who and how much, with its status and confirmations (UI_TxHead);
// where the money went, address to address (UI_TxRoute); the message, as
// it was said (UI_TxMemo); the facts; the person's own note, tucked away
// until wanted (UI_TxNote); and what can be done with it (UI_TxActions).

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowRight, Banknote, Briefcase, Car, Check, CircleX, ExternalLink, Gift, House, Landmark, Lock, MessageSquare, NotebookPen, PiggyBank, Receipt, Repeat, ShieldQuestion, ShoppingBag, Tag, UserPlus, UserRound, Utensils, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Com_Short, Com_FormatDate, Com_MemoAsksForSecrets, commands, contact_t, historyItem_t, txCategory_t } from "./ui_local";
import { useStore } from "./ui_store";
import { Com_PoolName, T } from "./ui_text";
import { Com_List, LOCALE } from "./ui_locale";
import { useAction } from "./ui_hooks";
import { sheetProps_t, UI_RoundAction, UI_Alert, UI_Amount, UI_Callout, UI_ChipSet, UI_CopyButton, UI_Info, UI_Sheet, UI_SheetClose, UI_Spinner } from "./ui_widgets";
import { UI_FeeFact, UI_TxProgress, useExplorer } from "./ui_payment";
import { Com_AddressHue, UI_AddressMark } from "./ui_pool";
import { Com_Initials, UI_ContactSheet, useContacts } from "./ui_contacts";
import { UI_UsdThen } from "./ui_price";
import { Com_CanSaveContact, Com_CanSendAgain, Com_Confirmations, Com_TxSign, Com_TxStateView, Com_TxTitle, KIND_ICON, txStateView_t } from "./ui_txview";

const CATEGORY_ICON: Record< txCategory_t, LucideIcon > = {
	income: Banknote, housing: House, food: Utensils, transport: Car, shopping: ShoppingBag, bills: Receipt,
	business: Briefcase, gifts: Gift, savings: PiggyBank, taxes: Landmark, other: Tag,
};

const MARKS_SHOWN = 3;		// a payment from many public addresses shows a few marks, and how many more

/*
==================
UI_TxSheet

The sheet, and the contact sheet Save Contact opens in its place (two
sheets stacked read as one too many)
==================
*/
export function UI_TxSheet( props: sheetProps_t & { item: historyItem_t | null; chainHeight: number; onSendAgain: ( it: historyItem_t ) => void; onNoteSaved: () => void } ) {
	const allEras				= useStore( ( s ) => s.constants?.blockEras );
	const network				= useStore( ( s ) => s.network );
	const eras					= useMemo( () => ( allEras ?? [] ).filter( ( e ) => e.network === network ), [ allEras, network ] );
	const contacts				= useContacts();
	const dustZats				= useStore( ( s ) => s.constants?.dustZats ?? 0 );
	const [ saving, setSaving ]	= useState( false );
	const it = props.item;
	if ( !it ) {
		return null;
	}
	const view			= Com_TxStateView( it.state, props.chainHeight, eras, Math.floor( Date.now() / 1000 ), it.kind === "received" );
	const contact		= it.counterparty ? contacts.data?.find( ( c ) => c.address === it.counterparty ) ?? null : null;
	const close			= () => props.onOpenChange( false );

	return (
		<>
			<UI_Sheet
				open={props.open && !saving}
				onOpenChange={props.onOpenChange}
				className="sheet-tx"
				hero={<UI_TxAvatar item={it} contact={contact} />}
				title={contact && it.kind === "sent" ? T.history.sentTo( contact.name ) : Com_TxTitle( it )}
			>
				<UI_TxHead item={it} view={view} confirmations={Com_Confirmations( it.state, props.chainHeight )} />
				<UI_TxRoute item={it} contact={contact} />
				{view.waiting && <UI_TxProgress stage="confirming" incoming={it.kind === "received"} note={view.note} />}
				{view.failed && <p className="tx-status failed">{view.note}</p>}
				{it.memo && <UI_TxMemo memo={it.memo} incoming={it.kind === "received"} />}
				{it.kind === "received" && it.amount > 0 && it.amount <= dustZats && <UI_Callout kind="info">{T.history.dust}</UI_Callout>}
				<UI_TxFacts item={it} view={view} />
				<UI_TxNote item={it} onSaved={props.onNoteSaved} />
				<div className="tx-foot">
					<UI_TxActions
						item={it}
						again={Com_CanSendAgain( it )}
						canSave={Com_CanSaveContact( it, contact )}
						onSendAgain={() => { close(); props.onSendAgain( it ); }}
						onSaveContact={() => setSaving( true )}
					/>
					<UI_SheetClose onClose={close} />
				</div>
			</UI_Sheet>
			{it.counterparty && <UI_ContactSheet open={saving} onOpenChange={setSaving} contact={null} address={it.counterparty} />}
		</>
	);
}

/*
==================
UI_TxAvatar

Who, as a picture: a contact's initials, an address's own colour (the
same as its mark), or the kind of transaction when there's no one to name
==================
*/
function UI_TxAvatar( props: { item: historyItem_t; contact: contact_t | null } ) {
	const it = props.item;
	const Icon = KIND_ICON[it.kind];
	const hue = it.counterparty ? { "--hue": Com_AddressHue( it.counterparty ) } as CSSProperties : undefined;
	return (
		<div className={"tx-avatar " + it.kind + ( hue ? " addressed" : "" )} style={hue} aria-hidden="true">
			<span className="tx-avatar-face">{props.contact ? Com_Initials( props.contact.name ) : <Icon />}</span>
			{props.contact && <span className="tx-avatar-badge"><Icon /></span>}
		</div>
	);
}

/*
==================
UI_TxHead

How much, what it was worth then (with prices), and where it stands. A
confirmed one counts its confirmations as blocks arrive: the number
changes with the chain's height, each new one landing with a small lift.
==================
*/
function UI_TxHead( props: { item: historyItem_t; view: txStateView_t; confirmations: number | null } ) {
	const it = props.item;
	const sign = Com_TxSign( it );
	return (
		<div className="tx-head">
			<div className={"tx-head-amount " + it.kind + props.view.tone}><UI_Amount zats={it.amount} prefix={sign} unit /></div>
			{__LAUREL_PRICES__ && !props.view.failed && <UI_UsdThen zats={it.amount} time={it.time} />}{/* none without prices (D-031) */}
			<UI_TxStatusChip view={props.view} confirmations={props.confirmations} />
		</div>
	);
}

function UI_TxStatusChip( props: { view: txStateView_t; confirmations: number | null } ) {
	const v = props.view;
	if ( v.waiting ) {
		return <span className="tx-chip pending"><span className="tx-chip-dot" />{v.pill}</span>;
	}
	if ( v.failed ) {
		return <span className="tx-chip failed"><CircleX aria-hidden="true" />{v.pill}</span>;
	}
	const n = props.confirmations;
	return (
		<span className="tx-chip confirmed" role="status">
			<Check aria-hidden="true" />
			{/* one run of words: as the chip's own items, " · " wrapped alone onto a line (175%) */}
			<span>{T.history.confirmedChip}{n !== null && <> · <span key={n} className="tx-count">{T.history.confirmations( n )}</span></>}</span>
		</span>
	);
}

/*
==================
UI_TxRoute

Where the money went, end to end. A public address shows as itself, with
its mark; private money has no address to show, so its end is the wallet
and its pools. A payment received privately doesn't say who sent it.
==================
*/
function UI_TxRoute( props: { item: historyItem_t; contact: contact_t | null } ) {
	const it = props.item;
	return (
		<div className={"tx-route " + it.kind}>
			{it.kind === "received" ? <UI_RouteSender item={it} /> : <UI_RouteFrom item={it} />}
			<div className="tx-route-link" aria-hidden="true">
				<span className="tx-route-line" />
				<span className="tx-route-arrow"><ArrowRight /></span>
			</div>
			<UI_RouteTo item={it} contact={props.contact} />
		</div>
	);
}

// who sent money in: a private payment doesn't say; a public one does, but Laurel doesn't keep it
function UI_RouteSender( props: { item: historyItem_t } ) {
	const publicOnly = props.item.into.length > 0 && props.item.into.every( ( p ) => p === "transparent" );
	return publicOnly
		? <UI_RouteEnd label={T.history.from} icon={UserRound} name={T.history.publicSender} sub={T.history.publicSenderSub} />
		: <UI_RouteEnd label={T.history.from} icon={ShieldQuestion} name={T.history.hiddenSender} sub={T.history.hiddenSenderSub} />;
}

// who was paid: the address (a contact's name over it), or, when the wallet couldn't read it, so; else the wallet itself
function UI_RouteTo( props: { item: historyItem_t; contact: contact_t | null } ) {
	const it = props.item;
	if ( it.kind !== "sent" ) {
		return <UI_RouteEnd label={T.history.to} icon={Wallet} name={T.history.yourWallet} sub={Com_List( it.into.map( Com_PoolName ) )} />;
	}
	if ( !it.counterparty ) {
		return <UI_RouteEnd label={T.history.to} icon={UserRound} name={T.history.unknownRecipient} sub={T.history.unknownRecipientSub} />;
	}
	const short = Com_Short( it.counterparty );
	return <UI_RouteEnd label={T.history.to} addresses={[ it.counterparty ]} name={props.contact?.name ?? short} address={!props.contact} sub={props.contact ? short : T.history.theirAddress} title={it.counterparty} />;
}

function UI_RouteFrom( props: { item: historyItem_t } ) {
	const it = props.item;
	const pools = Com_List( it.from.map( Com_PoolName ) );
	const addresses = it.fromAddresses;
	if ( addresses.length === 0 ) {
		return <UI_RouteEnd label={T.history.from} icon={Lock} name={T.history.yourWallet} sub={pools} />;
	}
	const name = addresses.length > 1 ? T.history.publicAddresses( addresses.length ) : Com_Short( addresses[0] );
	return <UI_RouteEnd label={T.history.from} addresses={addresses} name={name} address={addresses.length === 1} sub={pools} title={addresses.join( "\n" )} />;
}

// address: the name is an address, in type that tells its characters apart, wrapping rather than cut (a public one shows whole)
function UI_RouteEnd( props: { label: string; name: string; sub: string; icon?: LucideIcon; addresses?: string[]; address?: boolean; title?: string } ) {
	const shown = props.addresses?.slice( 0, MARKS_SHOWN ) ?? [];
	const more = ( props.addresses?.length ?? 0 ) - shown.length;
	return (
		<div className="tx-route-end" title={props.title}>
			<span className="tx-route-label">{props.label}</span>
			<span className="tx-route-mark">
				{props.icon
					? <span className="tx-route-icon"><props.icon aria-hidden="true" /></span>
					: <span className="address-marks">{shown.map( ( a ) => <UI_AddressMark key={a} address={a} /> )}{more > 0 && <span className="address-more">+{more}</span>}</span>}
			</span>
			<span className={"tx-route-name" + ( props.address ? " address" : "" )}>{props.name}</span>
			{props.sub && <span className="tx-route-sub">{props.sub}</span>}
		</div>
	);
}

/*
==================
UI_TxMemo

The message, as a speech bubble: theirs from the left, this wallet's
own from the right. One that asks for a phrase or a key says what it is.
==================
*/
function UI_TxMemo( props: { memo: string; incoming: boolean } ) {
	return (
		<>
			<figure className={"tx-memo " + ( props.incoming ? "in" : "out" )}>
				<figcaption className="tx-memo-label"><MessageSquare aria-hidden="true" />{T.history.message}</figcaption>
				<blockquote className="tx-bubble">{props.memo}</blockquote>
			</figure>
			{Com_MemoAsksForSecrets( props.memo ) && <UI_Callout kind="warn">{T.memo.asksForSecrets}</UI_Callout>}
		</>
	);
}

/*
==================
UI_TxFacts

The rest, plainly: when, the block, the fee, and the transaction's id
==================
*/
function UI_TxFacts( props: { item: historyItem_t; view: txStateView_t } ) {
	const it = props.item;
	return (
		<dl className="facts tx-facts">
			<div className="fact"><dt>{T.history.when}</dt><dd>{Com_FormatDate( it.time, "moment" )}</dd></div>
			{it.state.kind === "confirmed" && <div className="fact"><dt>{T.history.block}</dt><dd>{it.state.height.toLocaleString( LOCALE )}</dd></div>}
			{it.kind !== "received" && !props.view.failed && <UI_FeeFact zats={it.fee} />}
			<div className="fact"><dt>{T.receipt.txid}</dt><dd><code className="fact-id">{Com_Short( it.txid )}</code></dd></div>
		</dl>
	);
}

/*
==================
UI_TxNote

The person's own note on a transaction (w_notes.rs). Behind "Add note"
until wanted, open once there's one; saved when changed, and the history
read again so the list and search have it.
==================
*/
function UI_TxNote( props: { item: historyItem_t; onSaved: () => void } ) {
	const categories	= useStore( ( s ) => s.constants )?.categories ?? [];
	const maxChars		= useStore( ( s ) => s.constants?.noteMaxChars );
	const saved			= props.item.note ?? "";
	const savedCategory	= props.item.category;
	const [ text, setText ]			= useState( saved );
	const [ category, setCategory ]	= useState< txCategory_t | null >( savedCategory );
	const [ open, setOpen ]			= useState( false );

	useEffect( () => {
		setText( saved );
		setCategory( savedCategory );
		setOpen( false );
	}, [ props.item.txid, saved, savedCategory ] );

	const save = useAction( async () => {
		await commands.ntSaveF( props.item.txid, text, category );
		props.onSaved();
	} );

	if ( !open && !saved && !savedCategory ) {
		return (
			<button className="link tx-add-note" onClick={() => setOpen( true )}>
				<NotebookPen aria-hidden="true" />{T.history.addNote}
			</button>
		);
	}

	return (
		<div className="tx-note">
			<label className="label" htmlFor="tx-note">{T.history.note} <UI_Info title={T.history.note}>{T.history.noteHint}</UI_Info></label>
			<textarea id="tx-note" className="field" rows={2} maxLength={maxChars} placeholder={T.history.notePlaceholder} value={text} onChange={( e ) => setText( e.target.value )} />
			<UI_ChipSet
				label={T.history.category}
				options={categories.map( ( c ) => { const I = CATEGORY_ICON[c]; return { value: c, label: T.history.categories[c], icon: <I aria-hidden="true" /> }; } )}
				on={( c ) => c === category}
				onPick={( c ) => setCategory( c === category ? null : c )}
			/>
			{save.error && <UI_Alert title={T.history.noteFailed} message={save.error} />}
			{( text.trim() !== saved || category !== savedCategory ) && (
				<div className="request-actions">
					<button className="btn small primary" disabled={save.busy} onClick={() => void save.run()}>{save.busy ? <UI_Spinner size={12} /> : null}{T.history.saveNote}</button>
				</div>
			)}
		</div>
	);
}

/*
==================
UI_TxActions

What can be done with it, in one row: pay the same again, copy its id,
see it on an explorer, keep who was paid as a contact
==================
*/
function UI_TxActions( props: { item: historyItem_t; again: boolean; canSave: boolean; onSendAgain: () => void; onSaveContact: () => void } ) {
	const explorer = useExplorer();
	return (
		<div className="tx-actions" role="group" aria-label={T.history.actions}>
			{props.again && <UI_RoundAction icon={<Repeat aria-hidden="true" />} label={T.history.sendAgainShort} onClick={props.onSendAgain} main />}
			<UI_CopyButton text={props.item.txid} label={T.receipt.copy} tile />
			<UI_RoundAction icon={explorer.busy ? <UI_Spinner size={16} /> : <ExternalLink aria-hidden="true" />} label={T.history.explorer} title={T.receipt.explorerHint} onClick={() => explorer.open( props.item.txid )} />
			{props.canSave && <UI_RoundAction icon={<UserPlus aria-hidden="true" />} label={T.history.saveContact} onClick={props.onSaveContact} />}
			{explorer.error && <p className="hint tx-actions-error" role="alert">{T.receipt.cantOpen}</p>}
		</div>
	);
}
