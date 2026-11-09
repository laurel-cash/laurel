/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_send.tsx -- paying someone, in three steps: compose, review, sent
//
// The address is checked by the engine as it's typed (the same reading as
// Scan), so a wrong network or a public address is said before anything
// is built. Review shows exactly what the engine will do: the amount, the
// fee, and the pools the money comes from. Nothing is sent before that.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BookUser, CalendarClock, ClipboardPaste, Eye, FileOutput, Info, ScanLine, ShieldCheck, TriangleAlert, UserRound, X } from "lucide-react";

import {
	balance_t, commands, payTo_t, Com_Abbrev, Com_ErrorString, Com_FormatZec, Com_LookAlike, sendRequest_t, Com_ParseZec, Com_Split, pool_t, POOLS, quoted_t, sendQuote_t,
} from "./ui_local";
import { Com_PoolName, T } from "./ui_text";
import { Com_List } from "./ui_locale";
import { KEYS, QUERY } from "./ui_query";
import { useAction, useAddressCheck, useConfirm } from "./ui_hooks";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_Alert, UI_Amount, UI_Info, UI_Sheet, UI_SheetButtons, UI_Slots, UI_Spinner, UI_Tip, UI_Waiting } from "./ui_widgets";
import { Com_AmountProblem, UI_AmountHint, UI_FeeFact, UI_FeeNote, UI_FirstPay, UI_MemoField, UI_OfflineNote, UI_Proving, UI_ReviewFrom, UI_Receipt, UI_SpendKeyNote, useSpendKey } from "./ui_payment";
import { UI_CatchingUp, usePayable } from "./ui_sync";
import { UI_AddressLine } from "./ui_receive";
import { UI_PayList, UI_PayListSheet, useRoom } from "./ui_pays";
import { UI_RepeatSheet } from "./ui_repeat";
import { UI_ContactSheet, UI_PayeeMenu, useContacts } from "./ui_contacts";
import { Com_TxStateView, useTransactions } from "./ui_history";
import { UI_SavedFile } from "./ui_offline";

type phase_t = "compose" | "waiting" | "review" | "done" | "saved";		// waiting: Review pressed before the wallet caught up; saved: a view-only wallet's signing request (ui_offline.tsx)

// what the person has typed; kept by the page, so scanning a code and
// coming back doesn't lose it
export type sendDraft_t = {
	to:			string;
	amount:		string;
	max:		boolean;
	memo:		string;
	from:		pool_t | null;		// null: automatic
	toLabel:	string | null;		// who "to" is, when chosen from the person's accounts or contacts
	also:		payTo_t[];			// further payments in the same transaction, from a request for several (Scan)
	repeatId:	string | null;		// a repeating payment this one pays: sent, it moves to its next date
};

export const EMPTY_DRAFT: sendDraft_t = { to: "", amount: "", max: false, memo: "", from: null, toLabel: null, also: [], repeatId: null };

// a pool's own Send (UI_PoolSheet): a fresh payment with that pool chosen, so the quote,
// Max and the review use only its money
export function Com_DraftFrom( from: pool_t ): sendDraft_t {
	return { ...EMPTY_DRAFT, from: from };
}

const PUBLIC_KINDS	= [ "transparent", "tex" ];


/*
==================
Com_MaxHint

Under a Max amount: where it comes from and the fee it leaves out, or
why there's no number yet
==================
*/
function Com_MaxHint( q: sendQuote_t | undefined, error: unknown, hasAddress: boolean, payable: boolean ): string {
	if ( !payable ) {
		return T.catchUp.max;
	}
	if ( error ) {
		return Com_ErrorString( error );
	}
	if ( q ) {
		const pools = Com_List( q.from.map( Com_PoolName ) );
		return T.send.maxAfterFee( pools, Com_FormatZec( q.fee ) );
	}
	return hasAddress ? T.send.maxWorking : T.send.maxNeedsAddress;
}


/*
==================
UI_FromPicker

Automatic, or one pool that holds money. Public money is shown too, as
what it is: a tap offers to shield it, since it can't be sent privately.
==================
*/
function UI_FromPicker( props: { balance: balance_t; value: pool_t | null; onChange: ( p: pool_t | null ) => void; onShield: () => void } ) {
	const held = POOLS.filter( ( p ) => props.balance[p.pool].confirmed > 0 );

	return (
		<div className="from-picker" role="radiogroup" aria-label={T.send.from}>
			<button role="radio" aria-checked={props.value === null} className={"choice" + ( props.value === null ? " on" : "" )} onClick={() => props.onChange( null )}>
				<span className="choice-name">{T.send.auto}</span>
				<span className="choice-sub">{T.send.autoHint}</span>
			</button>
			{held.map( ( p ) => p.shielded ? (
				<button key={p.pool} role="radio" aria-checked={props.value === p.pool} className={"choice pool-" + p.pool + ( props.value === p.pool ? " on" : "" )} onClick={() => props.onChange( p.pool )}>
					<span className="choice-name"><span className="from-dot" />{Com_PoolName( p.pool )}</span>
					<span className="choice-sub"><UI_Amount zats={props.balance[p.pool].confirmed} unit /></span>
				</button>
			) : (
				<button key={p.pool} className="choice public pool-transparent" onClick={props.onShield}>
					<span className="choice-name"><Eye aria-hidden="true" />{T.send.publicTitle}</span>
					<span className="choice-sub">{T.send.publicHint}</span>
				</button>
			) )}
		</div>
	);
}

/*
==================
UI_SendSheet
==================
*/
export function UI_SendSheet( props: sheetProps_t & {
	walletId:		string;
	account:		number;
	balance:		balance_t;
	offline:		boolean;
	draft:			sendDraft_t;
	onDraft:		( d: sendDraft_t ) => void;
	onScan:			() => void;
	onShield:		() => void;
} ) {
	const hidden = useStore( ( s ) => s.hideAmounts );
	const d = props.draft;
	const set = ( patch: Partial< sendDraft_t > ) => props.onDraft( { ...d, ...patch } );

	const [ phase, setPhase ]		= useState< phase_t >( "compose" );
	const [ quoted, setQuoted ]		= useState< quoted_t< sendQuote_t > | null >( null );		// what review shows, under the intent it was quoted with
	const [ contactOpen, setContactOpen ] = useState( false );
	const [ listOpen, setListOpen ]	= useState( false );
	const [ repeatOpen, setRepeatOpen ] = useState( false );
	const room = useRoom( ( d.to.trim() ? 1 : 0 ) + d.also.length );		// payments this one can still take

	// a list added: it fills the first payment when that's still empty, then the rest; Max is for one person
	function AddPays( pays: payTo_t[] ) {
		const empty = !d.to.trim() && !d.amount.trim();
		const [ first, ...rest ] = pays;
		props.onDraft( empty
			? { ...d, to: first.to, amount: Com_FormatZec( first.zats ), memo: first.memo ?? "", max: false, also: [ ...d.also, ...rest ] }
			: { ...d, max: false, also: [ ...d.also, ...pays ] } );
	}
	const [ sentLabel, setSentLabel ]	= useState< string | null >( null );
	const contacts = useContacts();
	const [ request, setRequest ]	= useState< sendRequest_t | null >( null );
	const [ txid, setTxid ]			= useState< string | null >( null );
	// a payment of this account still waiting on the network: sending again is a second payment
	const txs = useTransactions( props.walletId, props.account );
	const waiting = ( txs.data ?? [] ).some( ( t ) => t.kind === "sent" && Com_TxStateView( t.state, 0, [], 0 ).waiting );

	// who this account knows: its contacts, and whoever it has paid (never who paid it: a poisoner can only write that side)
	const known = useMemo( () => [
		...( contacts.data ?? [] ).map( ( c ) => ( { address: c.address, label: c.name } ) ),
		...( txs.data ?? [] ).filter( ( t ) => t.kind === "sent" && t.counterparty ).map( ( t ) => ( { address: t.counterparty!, label: T.send.paidBefore } ) ),
	], [ contacts.data, txs.data ] );

	// ---- the address, checked as typed
	const { checking, target, error: targetError } = useAddressCheck( d.to );

	// a payment request fills in what it asks for, once, if nothing was typed:
	// its memo travels with the payment; its message is for the payer to read
	useEffect( () => {
		if ( target && target.address !== d.to.trim() ) {
			props.onDraft( {
				...d,
				to:		target.address,
				amount:	d.amount || ( target.amount != null ? Com_FormatZec( target.amount ) : "" ),
				memo:	d.memo || target.memo || "",
				also:	d.also.length ? d.also : target.also,
			} );
		}
	}, [ target ] );

	const isPublic	= !!target && PUBLIC_KINDS.includes( target.kind );
	const unspendable = Com_Split( props.balance ).checking;		// private money Send can't use yet (the engine's spendable)
	const amount	= d.max ? null : Com_ParseZec( d.amount );
	const zats		= amount?.kind === "ok" ? amount.zats : null;
	const amountProblem = amount && d.amount.trim() !== "" ? Com_AmountProblem( amount ) : null;

	// ---- the engine's side
	const propose = useAction( async () => {
		if ( !d.max && ( zats === null || zats === 0 ) ) {
			throw amountProblem ?? T.send.badAmount;
		}
		const req: sendRequest_t = {
			to:		d.to,
			zats:	zats,
			memo:	isPublic ? null : d.memo || null,
			from:	d.from,
			also:	d.max ? [] : d.also,
		};
		const q = await commands.wQuoteSendF( props.walletId, props.account, req );		// what it would do; nothing kept open
		setRequest( req );
		setQuoted( q );
		send.setChanged( false );
		setPhase( "review" );
	}, props.open );

	// built again and sent at once, only if it's what the person reviewed, and
	// only once per review: the intent goes back with the quote (w_engine.rs)
	const send = useConfirm(
		// a reminder this pays moves on in the engine (W_SendNow), also when the
		// payment may have gone out: so the list is read again, either way
		( seen: quoted_t< sendQuote_t >, req: sendRequest_t ) => commands.wSendNowF( props.walletId, props.account, req, seen.intent, seen.quote, d.repeatId )
			.finally( () => d.repeatId && QUERY.invalidateQueries( { queryKey: KEYS.repeats() } ) ),
		( r ) => {
			setSentLabel( d.toLabel );
			setTxid( r.txid );
			setPhase( "done" );
			props.onDraft( EMPTY_DRAFT );
		},
		setQuoted,
		props.open,
	);

	function Back() {
		send.setError( null );
		send.setChanged( false );
		setPhase( "compose" );
	}

	function Close() {
		props.onOpenChange( false );
	}

	useEffect( () => {
		if ( props.open ) {
			setPhase( "compose" );
			setQuoted( null );
			setTxid( null );
		}
	}, [ props.open ] );

	async function Paste() {
		try {
			set( { to: ( await navigator.clipboard.readText() ).trim() } );
		} catch {
			// no clipboard access: the field is still there to paste into
		}
	}

	// a payment is built only on a wallet that has caught up (ui_sync.tsx)
	const payable = usePayable( props.walletId );

	// Max, as a number: what the engine would send to this address from this
	// pool, after the fee (which depends on both). Asked again when either changes
	const max = useQuery( {
		queryKey:	KEYS.maxSend( props.walletId, props.account, target?.address ?? "", d.from ),
		queryFn:	() => commands.wQuoteSendF( props.walletId, props.account, { to: target?.address ?? "", zats: null, memo: null, from: d.from, also: [] } ),
		enabled:	props.open && d.max && !!target && payable,
		staleTime:	0,
		gcTime:		0,
	} );

	// a wallet that only views can't sign: its review saves a request for the computer that can
	const viewOnly = useStore( ( s ) => s.wallets[props.walletId]?.can.spend === false );
	const fetchKey = useSpendKey( !viewOnly && ( quoted?.quote.from.includes( "sapling" ) ?? false ) );
	const [ savedPath, setSavedPath ] = useState< string | null >( null );
	const saveRequest = useAction( async ( q: quoted_t< sendQuote_t >, req: sendRequest_t ) => {
		const r = await commands.oSaveRequestF( props.walletId, props.account, req, q.quote );
		switch ( r.kind ) {
		case "saved":
			setSavedPath( r.path );
			setPhase( "saved" );
			void QUERY.invalidateQueries( { queryKey: KEYS.offline() } );
			break;
		case "changed":
			setQuoted( { ...q, quote: r.quote } );		// the numbers moved since the review: shown again
			send.setChanged( true );
			break;
		case "cancelled":
			break;
		}
	}, props.open );

	const busy = propose.busy || send.busy || saveRequest.busy;

	// Review pressed before the wallet caught up: it waits (UI_CatchingUp), then goes on by itself
	function Review() {
		if ( payable ) {
			void propose.run();
		} else {
			setPhase( "waiting" );
		}
	}
	useEffect( () => {
		if ( phase === "waiting" && payable ) {
			setPhase( "compose" );
			void propose.run();
		}
	}, [ phase, payable ] );

	let body;
	switch ( phase ) {
	case "compose":
		body = (
			<div className="send">
				<label className="label" htmlFor="send-to">{T.send.to}</label>
				<div className="send-to">
					<textarea
						id="send-to"
						className="field mono"
						rows={2}
						placeholder={T.send.toHint}
						value={d.to}
						spellCheck={false}
						onChange={( e ) => set( { to: e.target.value.replace( /\s+/g, "" ), toLabel: null } )}
					/>
					<div className="send-to-tools">
						<button className="btn small" onClick={Paste}><ClipboardPaste aria-hidden="true" />{T.send.paste}</button>
						<button className="btn small" onClick={props.onScan}><ScanLine aria-hidden="true" />{T.send.scan}</button>
						<UI_PayeeMenu
							walletId={props.walletId}
							account={props.account}
							onPick={( address, label ) => set( { to: address, toLabel: label } )}
							onManage={() => setContactOpen( true )}
						/>
					</div>
				</div>
				<div className="send-check" aria-live="polite">
					{checking && <UI_Waiting text={T.common.checking} size={11} />}
					{d.toLabel && <span className="send-payee"><UserRound aria-hidden="true" />{d.toLabel}</span>}
					{!checking && target && (
						<span className={"send-kind" + ( isPublic ? " public" : "" )}>
							{isPublic ? <Eye aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
							{T.scan.kinds[target.kind].title}
						</span>
					)}
					{!checking && targetError && <span className="send-bad">{targetError}</span>}
				</div>

				<div className="label">{T.send.from} <UI_Info title={T.send.fromInfoTitle}>{T.send.fromInfo}</UI_Info></div>
				<UI_FromPicker balance={props.balance} value={d.from} onChange={( from ) => set( { from } )} onShield={props.onShield} />

				<label className="label" htmlFor="send-amount">{T.send.amount}</label>
				<div className={"send-amount" + ( amountProblem ? " bad" : "" )}>
					{d.max ? (
						<span className="send-max-on">
							<span className="send-max-amount">
								{max.data ? <UI_Amount zats={max.data.quote.amount} /> : max.isFetching ? <UI_Spinner size={14} /> : T.send.allOf}
							</span>
							<span className="send-max-chip">{T.send.max}</span>
							<button className="icon-btn" aria-label={T.send.maxOff} onClick={() => set( { max: false } )}><X aria-hidden="true" /></button>
						</span>
					) : (
						<input
							id="send-amount"
							inputMode="decimal"
							placeholder="0.00"
							value={d.amount}
							onChange={( e ) => set( { amount: e.target.value } )}
						/>
					)}
					<span className="send-unit">{T.common.zec}</span>
					{!d.max && d.also.length === 0 && (		// Max sends everything to one person
						<UI_Tip label={T.send.maxHint}>
							<button className="btn small" onClick={() => set( { max: true } )}>{T.send.max}</button>
						</UI_Tip>
					)}
				</div>
				<UI_AmountHint text={d.amount} amount={amount} onPick={( text ) => set( { amount: text } )} />
				{!!unspendable && props.balance.spendable !== null && (
					<p className="hint">
						<UI_Slots text={T.checking.sendNowLater} slots={{ now: <UI_Amount zats={props.balance.spendable} unit />, later: <UI_Amount zats={unspendable} unit /> }} />{" "}
						<UI_Info title={T.checking.infoTitle}>{T.checking.info}</UI_Info>
					</p>
				)}
				{d.max && <p className={"hint" + ( max.error ? " bad" : "" )}>{Com_MaxHint( max.data?.quote, max.error, !!target, payable )}</p>}
				<UI_PayList
					pays={d.also.map( ( p ) => ( { to: p.to, amount: p.zats, memo: p.memo } ) )}
					onRemove={( i ) => set( { also: d.also.filter( ( _, j ) => j !== i ) } )}
				/>
				<p className="hint"><button className="link" onClick={() => setListOpen( true )}>{T.pays.open}</button></p>
				<UI_PayListSheet open={listOpen} onOpenChange={setListOpen} room={room} onAdd={AddPays} />

				{isPublic ? (
					<p className="hint">{T.send.memoPublic}</p>
				) : (
					<>
						<UI_MemoField id="send-memo" value={d.memo} placeholder={T.send.memoHint} onChange={( memo ) => set( { memo } )} />
					</>
				)}

				{propose.error && <UI_Alert title={T.send.cantReview} message={propose.error} />}

				<UI_SheetButtons busy={busy} onCancel={Close} action={{
					label:		propose.busy ? T.review.preparing : T.send.review,
					onRun:		Review,
					running:	propose.busy,
				}} />
			</div>
		);
		break;

	case "waiting":
		body = (
			<>
				<UI_CatchingUp walletId={props.walletId} />
				<UI_SheetButtons busy={false} onCancel={() => setPhase( "compose" )} cancel={T.send.back} action={{ label: T.catchUp.later, onRun: Close }} />
			</>
		);
		break;

	case "review": {
		const q = quoted!.quote;
		// every recipient checked alike: look-alikes and public addresses among the further payments too
		const lookAlikes = [ q.to, ...q.also.map( ( p ) => p.to ) ].map( ( a ) => Com_LookAlike( a, known ) ).filter( ( l ): l is NonNullable< typeof l > => !!l );
		const qPublic = [ q.kind, ...q.also.map( ( p ) => p.kind ) ].some( ( k ) => PUBLIC_KINDS.includes( k ) );
		const firstAmount = q.amount - q.also.reduce( ( s, p ) => s + p.amount, 0 );
		body = (
			<div className="send-review">
				<UI_ReviewFrom walletId={props.walletId} account={props.account} />
				<div className="review-amount"><UI_Amount zats={q.amount} unit /></div>
				<div className="review-to">
					<span className="label">{T.send.payTo}</span>
					<UI_AddressLine address={q.to} />
					{q.also.length > 0 && <UI_FirstPay zats={firstAmount} />}
				</div>
				<UI_PayList pays={q.also} />
				<dl className="facts">
					<div className="fact">
						<dt>{T.send.payFrom}</dt>
						<dd className="review-pools">
							{q.from.map( ( p ) => <span key={p} className={"pool-chip pool-" + p}><span className="from-dot" />{Com_PoolName( p )}</span> )}
						</dd>
					</div>
					<UI_FeeFact zats={q.fee} />
					<div className="fact total"><dt>{T.send.total}</dt><dd><UI_Amount zats={q.amount + q.fee} unit /></dd></div>
				</dl>
				{q.memo && <p className="review-memo">“{q.memo}”</p>}
				{q.steps > 1 && <p className="hint">{T.send.twoSteps}</p>}
				{qPublic && <div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.send.publicWarn}</span></div>}
				{props.offline && <UI_OfflineNote />}
				{waiting && <div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.send.stillPending}</span></div>}
				{!viewOnly && !send.busy && <UI_SpendKeyNote fetch={fetchKey} />}
				<UI_FeeNote note={q.feeNote} />
				{lookAlikes.map( ( l ) => <div key={l.address} className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.send.lookAlike( l.label, Com_Abbrev( l.address ) )}</span></div> )}
				{send.changed && !send.busy && <div className="info-note"><Info aria-hidden="true" /><span>{T.send.changed}</span></div>}
				{send.error && <UI_Alert title={T.send.failed} message={send.error} />}
				{viewOnly ? (
					<>
						<div className="info-note"><Info aria-hidden="true" /><span>{T.offline.viewOnlyNote}</span></div>
						{saveRequest.error && <UI_Alert title={T.offline.cantSave} message={saveRequest.error} />}
						<UI_SheetButtons busy={saveRequest.busy} onCancel={Back} cancel={T.send.back} action={{
							label:		T.offline.saveRequest,
							onRun:		() => { if ( request && quoted ) void saveRequest.run( quoted, request ); },
							icon:		<FileOutput aria-hidden="true" />,
						}} />
					</>
				) : send.busy ? <UI_Proving since={send.since} fetch={fetchKey} /> : (
					<UI_SheetButtons busy={false} onCancel={Back} cancel={T.send.back} action={send.error ? null : {
						label:		hidden ? T.send.actionHidden : T.send.action( Com_FormatZec( q.amount ) ),
						onRun:		() => { if ( request && quoted ) send.run( quoted, request ); },
						icon:		<ArrowUpRight aria-hidden="true" />,
					}} />
				)}
			</div>
		);
		break;
	}

	case "saved":
		body = (
			<div className="send-review">
				<UI_SavedFile path={savedPath ?? ""} signed={false} />
				<UI_SheetButtons busy={false} action={{ label: T.receipt.done, onRun: Close }} />
			</div>
		);
		break;

	case "done":
		body = txid && quoted ? (
			<UI_Receipt title={T.send.doneTitle} zats={quoted.quote.amount} text={T.send.done} txid={txid} onDone={() => props.onOpenChange( false )}>
				{!request?.to.startsWith( "zcash:" ) && !contacts.data?.some( ( c ) => c.address === quoted.quote.to ) && !sentLabel && (
					<button className="link receipt-save" onClick={() => setContactOpen( true )}><BookUser aria-hidden="true" />{T.contacts.saveAddress}</button>
				)}
				{quoted.quote.also.length === 0 && (
					<button className="link receipt-save" onClick={() => setRepeatOpen( true )}><CalendarClock aria-hidden="true" />{T.repeat.open}</button>
				)}
			</UI_Receipt>
		) : null;
		break;
	}

	return (
		<UI_Sheet
			open={props.open}
			onOpenChange={( o ) => o ? props.onOpenChange( true ) : Close()}
			title={phase === "review" ? T.send.reviewTitle : phase === "saved" ? T.offline.savedTitle : T.send.title}
			busy={busy}
		>
			{body}
			{quoted && (
				<UI_RepeatSheet
					open={repeatOpen}
					onOpenChange={setRepeatOpen}
					walletId={props.walletId}
					account={props.account}
					to={quoted.quote.to}
					zats={quoted.quote.amount}
					memo={quoted.quote.memo}
					label={sentLabel}
				/>
			)}
			<UI_ContactSheet open={contactOpen} onOpenChange={setContactOpen} contact={null} address={phase === "done" ? quoted?.quote.to : target?.address} />
		</UI_Sheet>
	);
}
