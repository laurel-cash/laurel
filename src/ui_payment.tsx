/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_payment.tsx -- what every payment screen shows alike (Send, Shield,
// Migrate, Sweep, Receive): the amount's hint, the memo field, the fee's
// note, where it's from, the flow from one end to the other, the receipt
// and its transaction id

import { Children, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, CircleCheck, Download, ExternalLink, Wallet as WalletIcon, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { amount_t, Com_Short, Com_ExplorerUrl, Com_Unreachable, commands, feeNote_t, txState_t } from "./ui_local";
import { Com_NetworkName, T } from "./ui_text";
import { useAction } from "./ui_hooks";
import { KEYS } from "./ui_query";
import { useStore } from "./ui_store";
import { UI_Amount, UI_Callout, UI_CopyButton, UI_SheetClose, UI_Slots, UI_Working } from "./ui_widgets";


/*
==================
useSpendKey / UI_SpendKeyNote / UI_Proving

A payment that spends Sapling notes fetches Sapling's spend proving key
the first time (w_spendkey.rs): the review says so before anything
moves, and the working state says so while it happens. Asked each time
a review opens: after the first payment the key is here.
==================
*/
export function useSpendKey( spendsSapling: boolean ): boolean {
	const here = useQuery( { queryKey: KEYS.spendKey(), queryFn: () => commands.skHereF(), enabled: spendsSapling, staleTime: 0 } );
	return spendsSapling && here.data === false;
}

export function UI_SpendKeyNote( props: { fetch: boolean } ) {
	return props.fetch ? <UI_Callout kind="info" icon={Download}>{T.review.fetchKey}</UI_Callout> : null;
}

export function UI_Proving( props: { since: number; fetch: boolean } ) {
	return <UI_Working since={props.since} title={props.fetch ? T.review.fetchingKey : T.review.proving} hint={T.review.provingHint} />;
}


/*
==================
UI_FirstPay

Under the first address of several payments: what it gets, as one sentence
==================
*/
export function UI_FirstPay( props: { zats: number } ) {
	return <span className="hint"><UI_Slots text={T.send.firstPay} slots={{ amount: <UI_Amount zats={props.zats} unit /> }} /></span>;
}

/*
==================
useExplorer / UI_TxidFact

A transaction on a block explorer, in the browser: only when asked (the
explorer sees the IP and the transaction). And a transaction's id as the last row of its facts: shortened on one line,
selectable, and two round buttons beside it: Copy, and the transaction on
a block explorer in the browser (only when asked: the explorer sees the IP
and the transaction)
==================
*/
export function useExplorer() {
	const network	= useStore( ( s ) => s.network );
	const explore	= useAction( ( url: string ) => openUrl( url ) );
	return { open: ( txid: string ) => { explore.run( Com_ExplorerUrl( network, txid ) ); }, busy: explore.busy, error: explore.error };
}

export function UI_TxidFact( props: { txid: string } ) {
	const explore	= useExplorer();
	return (
		<div className="fact">
			<dt>{T.receipt.txid}</dt>
			<dd className="fact-txid">
				<code className="fact-id">{Com_Short( props.txid )}</code>
				<UI_CopyButton text={props.txid} label={T.receipt.copy} icon />
				<button className="icon-btn round" aria-label={T.receipt.explorer} title={T.receipt.explorerHint} disabled={explore.busy} onClick={() => explore.open( props.txid )}>
					<ExternalLink aria-hidden="true" />
				</button>
				{explore.error && <span className="hint" role="alert">{T.receipt.cantOpen}</span>}
			</dd>
		</div>
	);
}

/*
==================
UI_TxProgress

Where a payment is, as three steps: sent (or seen, money coming in), then
confirming while the network takes it, then confirmed. The step it's on
breathes; a payment that didn't go through stops red where it stopped.
note: a quiet line under it (a pending payment's expiry)
==================
*/
export type txStage_t = "confirming" | "confirmed" | "failed";

export function Com_TxStage( state: txState_t | undefined ): txStage_t {
	switch ( state?.kind ) {
	case undefined:
	case "pending":
	case "unsent":		return "confirming";		// undefined: just sent, not in the history yet
	case "confirmed":	return "confirmed";
	case "failed":		return "failed";
	default:			return Com_Unreachable( state );
	}
}

export function UI_TxProgress( props: { stage: txStage_t; incoming?: boolean; note?: string | null } ) {
	const s = props.stage;
	const steps = [
		{ key: "sent",			label: props.incoming ? T.progress.seen : T.progress.sent,	state: "done" },
		{ key: "confirming",	label: T.progress.confirming,								state: s === "confirming" ? "now" : s === "failed" ? "bad" : "done" },
		{ key: "confirmed",		label: T.progress.confirmed,								state: s === "confirmed" ? "done" : "next" },
	];
	const head = s === "confirmed" ? T.progress.doneHead : s === "failed" ? T.progress.failedHead : T.progress.waitHead;
	const sub = s === "confirmed" ? T.progress.doneSub : s === "failed" ? T.progress.failedSub : T.progress.waitSub;
	return (
		<div className={"tx-progress " + s} role="status">
			<ol className="tx-steps">
				{steps.map( ( st ) => (
					<li key={st.key} className={"tx-step " + st.state}>
						<span className="tx-step-dot">{st.state === "done" ? <Check aria-hidden="true" /> : st.state === "bad" ? <X aria-hidden="true" /> : null}</span>
						<span className="tx-step-label">{st.label}</span>
					</li>
				) )}
			</ol>
			<p className="tx-progress-head">{head}</p>
			<p className="tx-progress-sub">{sub}</p>
			{props.note && <p className="tx-progress-note">{props.note}</p>}
		</div>
	);
}

/*
==================
UI_ReviewFrom

On every review, before anything moves: the network, the account and the
wallet it moves from. Mainnet says it's real money. The engine already
refuses the other network and binds a quote to its account; this is the
person seeing it too.
==================
*/
export function UI_ReviewFrom( props: { walletId: string; account: number } ) {
	const network	= useStore( ( s ) => s.network );
	const wallet	= useStore( ( s ) => s.wallets[props.walletId] );
	const account	= wallet?.accounts.find( ( a ) => a.index === props.account );
	return (
		<div className={"review-from " + network}>
			<span className="review-chip net">
				<span className="review-chip-dot" aria-hidden="true" />
				{network === "mainnet" ? T.review.realMoney( Com_NetworkName( network ) ) : Com_NetworkName( network )}
			</span>
			<span className="review-chip">
				<WalletIcon aria-hidden="true" />
				{T.review.where( account?.name ?? "", wallet?.name ?? "" )}
			</span>
		</div>
	);
}

/*
==================
UI_FeeNote

A fee worth a word, said before Send: why it's high, in plain words
(the rule is Rust's, Com_FeeNote). Payments and shielding alike.
==================
*/
export function UI_FeeNote( props: { note: feeNote_t | null } ) {
	const n = props.note;
	if ( !n ) {
		return null;
	}
	let text: string;
	switch ( n.kind ) {
	case "manyCoins":	text = T.fee.manyCoins( n.coins ); break;
	case "largeShare":	text = T.fee.largeShare; break;
	case "high":		text = T.fee.high; break;
	default:			return Com_Unreachable( n );
	}
	return <UI_Callout kind="warn">{text}</UI_Callout>;
}

/*
==================
Com_AmountProblem

What's wrong with a typed amount, in words, or null when it reads
==================
*/
export function Com_AmountProblem( a: amount_t ): string | null {
	switch ( a.kind ) {
	case "ok":			return null;
	case "ambiguous":	return T.send.ambiguousAmount;
	case "bad":			return T.send.badAmount;
	}
}

/*
==================
UI_AmountHint

Under a typed amount, wherever one is typed (Send, a request): why it
doesn't read, and for "1,000" both readings to pick from. Nothing while
it reads, or while nothing is typed.
==================
*/
export function UI_AmountHint( props: { text: string; amount: amount_t | null; onPick: ( text: string ) => void } ) {
	const a = props.amount;
	if ( !a || a.kind === "ok" || !props.text.trim() ) {
		return null;
	}
	if ( a.kind === "bad" ) {
		return <p className="hint bad">{Com_AmountProblem( a )}</p>;
	}
	return (
		<p className="hint bad">
			{Com_AmountProblem( a )}{" "}
			<button className="link" onClick={() => props.onPick( a.thousands )}>{a.thousands}</button>
			{" · "}
			<button className="link" onClick={() => props.onPick( a.decimal )}>{a.decimal}</button>
		</p>
	);
}

const encoder = new TextEncoder();

/*
==================
UI_MemoField

A memo, with what it holds counted in bytes against the engine's limit
(constants_t.memoMaxBytes; the engine refuses more, W_CheckMemo)
==================
*/
export function UI_MemoField( props: { id: string; value: string; placeholder: string; onChange: ( v: string ) => void } ) {
	const max	= useStore( ( s ) => s.constants?.memoMaxBytes ?? 0 );
	const used	= encoder.encode( props.value ).length;
	return (
		<>
			<label className="label" htmlFor={props.id}>{T.send.memo}</label>
			<textarea
				id={props.id}
				className="field"
				rows={2}
				placeholder={props.placeholder}
				value={props.value}
				onChange={( e ) => props.onChange( e.target.value )}
			/>
			<p className={"hint right" + ( max && used > max ? " bad" : "" )}>{T.send.memoCount( used, max )}</p>
		</>
	);
}

/*
==================
UI_Flow

Where money moves from and to, before it moves: two ends and an arrow
that works while it's sent. Shield and Sweep alike.
==================
*/
export type flowEnd_t = { kind: "public" | "private" | "key" | "pool-orchard" | "pool-sapling"; icon: ReactNode; label: string; zats: number };

export function UI_Flow( props: { from: flowEnd_t; to: flowEnd_t; working: boolean } ) {
	const End = ( e: flowEnd_t ) => (
		<div className={"flow-end " + e.kind}>
			<span className="flow-icon">{e.icon}</span>
			<span className="flow-label">{e.label}</span>
			<span className="flow-amount"><UI_Amount zats={e.zats} unit /></span>
		</div>
	);
	return (
		<div className={"shield-flow" + ( props.working ? " working" : "" )}>
			{End( props.from )}
			<span className="flow-arrow"><ArrowRight aria-hidden="true" /></span>
			{End( props.to )}
		</div>
	);
}

/*
==================
UI_Receipt

After a payment is sent: what happened, the amount, what happens next
in one sentence, and the transaction to look it up by. Shield and Send
alike; the only loud button is Done.
==================
*/
export function UI_Receipt( props: { title: string; zats: number; text: string; txid: string; onDone: () => void; stage?: txStage_t; children?: ReactNode } ) {
	return (
		<>
			<div className="receipt" role="status">
				<span className="receipt-icon"><CircleCheck aria-hidden="true" /></span>
				<span className="receipt-title">{props.title}</span>
				<span className="receipt-amount"><UI_Amount zats={props.zats} unit /></span>
				<span className="receipt-text">{props.text}</span>
			</div>
			<UI_TxProgress stage={props.stage ?? "confirming"} />
			<dl className="facts">
				<UI_TxidFact txid={props.txid} />
			</dl>
			{Children.toArray( props.children ).length > 0 && <div className="receipt-more">{props.children}</div>}
			<UI_SheetClose onClose={props.onDone} primary label={T.receipt.done} />
		</>
	);
}

/*
==================
UI_FeeFact / UI_OfflineNote

The fee as a row of a payment's facts (null: the engine doesn't know it,
an old payment received), and why a payment can't go yet while offline.
Send, Shield, Sweep and History each wrote them out.
==================
*/
export function UI_FeeFact( props: { zats: number | null } ) {
	return <div className="fact"><dt>{T.fee.label}</dt><dd>{props.zats != null ? <UI_Amount zats={props.zats} unit /> : T.fee.unknown}</dd></div>;
}

export function UI_OfflineNote() {
	return <UI_Callout kind="warn">{T.review.offline}</UI_Callout>;
}
