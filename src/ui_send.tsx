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
import { ArrowUpRight, BookUser, CalendarClock, ClipboardPaste, Eye, FileOutput, ScanLine, ShieldCheck, UserRound, X } from "lucide-react";

import {
	balance_t, commands, payTo_t, Com_Abbrev, Com_ErrorString, Com_FormatZec, Com_IsPublicKind, Com_LookAlike, sendRequest_t, Com_ParseZec, Com_Split, pool_t, POOLS, quoted_t, scanned_t, sendQuote_t,
} from "./ui_local";
import { Com_PoolName, T } from "./ui_text";
import { Com_List } from "./ui_locale";
import { KEYS, QUERY } from "./ui_query";
import { useAction, useAddressCheck, useAppSettings, useConfirm } from "./ui_hooks";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_Alert, UI_Amount, UI_Callout, UI_Info, UI_Sheet, UI_SheetButtons, UI_Slots, UI_Spinner, UI_Tip, UI_Waiting } from "./ui_widgets";
import { Com_AmountProblem, Com_TxStage, UI_AmountHint, UI_FeeFact, UI_FeeNote, UI_FirstPay, UI_MemoField, UI_OfflineNote, UI_Proving, UI_ReviewFrom, UI_Receipt, UI_SpendKeyNote, useSpendKey } from "./ui_payment";
import { UI_CatchingUp, usePayable } from "./ui_sync";
import { UI_AddressLine } from "./ui_receive";
import { UI_PayList, UI_PayListPanel, useRoom } from "./ui_pays";
import { UI_RepeatSheet } from "./ui_repeat";
import { UI_ContactSheet, UI_KindChip, UI_PayeeMenu, useContacts } from "./ui_contacts";
import { useTransactions } from "./ui_history";
import { Com_Waiting } from "./ui_txview";
import { UI_SavedFile } from "./ui_offline";
import { UI_Usd } from "./ui_price";

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

/*
==================
Com_DraftFromScan

A scanned request in the draft: the request's memo travels with the payment;
its message is for the payer to read, not to send back. A scan for another
address starts afresh (W2-05): the draft's amount, Max, memo, name and the
repeat it paid were someone else's. Its pool stays: that was the person's choice
==================
*/
export function Com_DraftFromScan( draft: sendDraft_t, r: scanned_t ): sendDraft_t {
	const base = r.address === draft.to ? draft : { ...EMPTY_DRAFT, from: draft.from };
	return { ...base, to: r.address, amount: r.amount != null ? Com_FormatZec( r.amount ) : base.amount, memo: r.memo ?? base.memo, also: r.also, max: r.also.length ? false : base.max };
}


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
		return hasAddress ? T.send.maxAfterFee( pools, Com_FormatZec( q.fee ) ) : T.send.maxAbout( pools, Com_FormatZec( q.fee ) );
	}
	return T.send.maxWorking;
}


/*
==================
UI_FromPicker

Automatic, or one pool that holds money. Public money is shown too, as
what it is: a tap offers to shield it, since it can't be sent privately;
with Send From Public Money on (Settings > Advanced) it's a choice like the
others, said to be public. Automatic never picks it.
==================
*/
function UI_FromPicker( props: { balance: balance_t; value: pool_t | null; onChange: ( p: pool_t | null ) => void; onShield: () => void } ) {
	const held		= POOLS.filter( ( p ) => props.balance[p.pool].confirmed > 0 );
	const publicOk	= useAppSettings().settings?.sendFromPublic === true;
	// Automatic spends private money only: with all of it public, said here,
	// before an amount, with the two ways on (W_Propose says it too)
	const onlyPublic = props.value === null && held.length > 0 && held.every( ( p ) => !p.shielded );

	return (
		<>
		<div className="from-picker" role="radiogroup" aria-label={T.send.from}>
			<button role="radio" aria-checked={props.value === null} className={"choice" + ( props.value === null ? " on" : "" )} onClick={() => props.onChange( null )}>
				<span className="choice-name">{T.send.auto}</span>
				<span className="choice-sub">{T.send.autoHint}</span>
			</button>
			{held.map( ( p ) => p.shielded || publicOk ? (
				<button key={p.pool} role="radio" aria-checked={props.value === p.pool} className={"choice pool-" + p.pool + ( props.value === p.pool ? " on" : "" )} onClick={() => props.onChange( p.pool )}>
					<span className="choice-name">{p.shielded ? <span className="from-dot" /> : <Eye aria-hidden="true" />}{Com_PoolName( p.pool )}</span>
					<span className="choice-sub"><UI_Amount zats={props.balance[p.pool].confirmed} unit />{!p.shielded && <> · {T.send.publicSend}</>}</span>
				</button>
			) : (
				<button key={p.pool} className="choice public pool-transparent" onClick={props.onShield}>
					<span className="choice-name"><Eye aria-hidden="true" />{T.send.publicTitle}</span>
					<span className="choice-sub">{T.send.publicHint}</span>
				</button>
			) )}
		</div>
		{onlyPublic && (
			<UI_Callout kind="info" icon={Eye}>
				{T.send.onlyPublic}
				<span className="callout-actions">
					<button className="btn small primary" onClick={props.onShield}><ShieldCheck aria-hidden="true" />{T.send.shieldFirst}</button>
					{publicOk && <button className="btn small" onClick={() => props.onChange( "transparent" )}>{T.send.useTransparent}</button>}
				</span>
			</UI_Callout>
		)}
		{props.value === "transparent" && <p className="hint from-how">{T.send.publicHow}</p>}
		</>
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
	const waiting = ( txs.data ?? [] ).some( ( t ) => t.kind === "sent" && Com_Waiting( t.state ) );

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

	const isPublic	= !!target && Com_IsPublicKind( target.kind );
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
			setListOpen( false );
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
	// pool, after the fee (which depends on both). Asked again when either
	// changes. With no address yet, priced to this account's own private
	// address (what paying most people costs), and said to be close, not exact
	const own = useQuery( {
		queryKey:	KEYS.receive( props.walletId, props.account ),
		queryFn:	() => commands.wReceiveF( props.walletId, props.account, null ),
		enabled:	props.open && d.max && !target,
	} );
	const maxTo = target?.address ?? own.data?.shielded ?? "";
	const max = useQuery( {
		queryKey:	KEYS.maxSend( props.walletId, props.account, maxTo, d.from ),
		queryFn:	() => commands.wPreviewSendF( props.walletId, props.account, { to: maxTo, zats: null, memo: null, from: d.from, also: [] } ),		// a preview: no intent (W2-08)
		enabled:	props.open && d.max && !!maxTo && payable,
		staleTime:	0,
		gcTime:		0,
	} );

	// a wallet that only views can't sign: its review saves a request for the computer that can
	const viewOnly = useStore( ( s ) => s.wallets[props.walletId]?.can.spend === false );
	const dustZats = useStore( ( s ) => s.constants?.dustZats ?? 0 );
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
		body = listOpen ? (
			<UI_PayListPanel open={props.open} room={room} onAdd={( pays ) => { AddPays( pays ); setListOpen( false ); }} onBack={() => setListOpen( false )} />
		) : (
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
						<UI_KindChip kind={target.kind} title={T.scan.kinds[target.kind].title} />
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
								{max.data
									? <><UI_Amount zats={max.data.amount} />{__LAUREL_PRICES__ && <UI_Usd zats={max.data.amount} />}</>
									: max.error || own.error || !payable ? T.send.maxNone : <UI_Spinner size={14} />}
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
				{d.max && <p className={"hint" + ( max.error ? " bad" : "" )}>{Com_MaxHint( max.data, max.error, !!target, payable )}</p>}
				<UI_PayList
					pays={d.also.map( ( p ) => ( { to: p.to, amount: p.zats, memo: p.memo } ) )}
					onRemove={( i ) => set( { also: d.also.filter( ( _, j ) => j !== i ) } )}
				/>
				<p className="hint"><button className="link" onClick={() => setListOpen( true )}>{T.pays.open}</button></p>

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
		const qPublic = [ q.kind, ...q.also.map( ( p ) => p.kind ) ].some( Com_IsPublicKind );
		const firstAmount = q.amount - q.also.reduce( ( s, p ) => s + p.amount, 0 );
		// a payment of dust arrives as nothing its recipient can spend (Max on a small balance, too)
		const dust = [ firstAmount, ...q.also.map( ( p ) => p.amount ) ].filter( ( z ) => z <= dustZats );
		body = (
			<div className="send-review">
				<UI_ReviewFrom walletId={props.walletId} account={props.account} />
				<div className="review-amount"><UI_Amount zats={q.amount} unit /></div>
				<div className="review-to">
					<span className="label">{T.send.payTo}</span>
					<UI_AddressLine address={q.to} />
					<UI_KindChip kind={q.kind} title={T.scan.kinds[q.kind].title} />
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
				{qPublic && <UI_Callout kind="warn">{T.send.publicWarn}</UI_Callout>}
				{dust.length > 0 && <UI_Callout kind="warn">{T.send.dust( Com_FormatZec( Math.max( ...dust ) ) )}</UI_Callout>}
				{q.from.includes( "transparent" ) && !d.max && <UI_Callout kind="info">{T.send.publicChange}</UI_Callout>}
				{q.publicAddresses > 1 && <UI_Callout kind="warn">{T.send.linksAddresses( q.publicAddresses )}</UI_Callout>}
				{props.offline && <UI_OfflineNote />}
				{waiting && <UI_Callout kind="warn">{T.send.stillPending}</UI_Callout>}
				{!viewOnly && !send.busy && <UI_SpendKeyNote fetch={fetchKey} />}
				<UI_FeeNote note={q.feeNote} />
				{lookAlikes.map( ( l ) => <UI_Callout key={l.address} kind="warn">{T.send.lookAlike( l.label, Com_Abbrev( l.address ) )}</UI_Callout> )}
				{send.changed && !send.busy && <UI_Callout kind="info">{T.send.changed}</UI_Callout>}
				{send.error && <UI_Alert title={T.send.failed} message={send.error} />}
				{viewOnly && !__LAUREL_OFFLINE_SIGNING__ ? (		// nothing to save a request with (D-031)
					<>
						<UI_Callout kind="info">{T.send.viewOnlyCant}</UI_Callout>
						<UI_SheetButtons busy={false} onCancel={Back} cancel={T.send.back} action={null} />
					</>
				) : viewOnly ? (
					<>
						<UI_Callout kind="info">{T.offline.viewOnlyNote}</UI_Callout>
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

	case "saved":		// a view-only wallet's request, saved: only with offline signing (D-031)
		body = __LAUREL_OFFLINE_SIGNING__ && (
			<div className="send-review">
				<UI_SavedFile path={savedPath ?? ""} signed={false} />
				<UI_SheetButtons busy={false} action={{ label: T.receipt.done, onRun: Close }} />
			</div>
		);
		break;

	case "done":
		body = txid && quoted ? (
			<UI_Receipt title={T.send.doneTitle} zats={quoted.quote.amount} text={T.send.done} txid={txid} stage={Com_TxStage( txs.data?.find( ( t ) => t.txid === txid )?.state )} onDone={() => props.onOpenChange( false )}>
				{!request?.to.startsWith( "zcash:" ) && !contacts.data?.some( ( c ) => c.address === quoted.quote.to ) && !sentLabel && (
					<button className="link receipt-save" onClick={() => setContactOpen( true )}><BookUser aria-hidden="true" />{T.contacts.saveAddress}</button>
				)}
				{__LAUREL_REPEAT_PAYMENTS__ && quoted.quote.also.length === 0 && (
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
			{__LAUREL_REPEAT_PAYMENTS__ && quoted && (		// a build without repeat payments has no sheet for one (D-031)
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
