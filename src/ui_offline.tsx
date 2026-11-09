/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_offline.tsx -- Settings > Offline Signing: a payment signed on a
// computer that is never online (w_offline.rs, docs/OFFLINE-SIGNING.md)
//
// Online, Send on a view-only wallet saves a signing request; the requests
// wait here until their signed payment comes back, is checked and sent.
// Offline, a request is opened here, reviewed on this screen, and signed.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCheck2, FileClock, FileOutput, FileSignature, FolderOpen, Inbox, Info, Send, TriangleAlert } from "lucide-react";

import { commands, Com_Abbrev, Com_ErrorOf, Com_FormatDate, folder_t, offlinePending_t, offlineReview_t, sendQuote_t } from "./ui_local";
import { T } from "./ui_text";
import { KEYS, QUERY } from "./ui_query";
import { useAction } from "./ui_hooks";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_Alert, UI_Amount, UI_ConfirmSheet, UI_Info, UI_Sheet, UI_SheetButtons, UI_SheetClose, UI_Spinner, UI_Waiting } from "./ui_widgets";
import { UI_FeeFact, UI_FirstPay, UI_TxidFact } from "./ui_payment";
import { UI_PayList } from "./ui_pays";

/*
==================
UI_OfflinePayment

A payment as the offline screen must show it: every address whole (the
one screen that can't be tampered with over the network is where it is
checked, docs/OFFLINE-SIGNING.md 17), each amount, the memo, the fee
==================
*/
export function UI_OfflinePayment( props: { quote: sendQuote_t } ) {
	const q = props.quote;
	const first = q.amount - q.also.reduce( ( s, p ) => s + p.amount, 0 );
	return (
		<div className="send-review">
			<div className="review-amount"><UI_Amount zats={q.amount} unit /></div>
			<div className="review-to">
				<span className="label">{T.send.payTo}</span>
				<span className="address-text whole">{q.to}</span>
				{q.also.length > 0 && <UI_FirstPay zats={first} />}
			</div>
			<UI_PayList pays={q.also} />
			<dl className="facts">
				<UI_FeeFact zats={q.fee} />
				<div className="fact total"><dt>{T.send.total}</dt><dd><UI_Amount zats={q.amount + q.fee} unit /></dd></div>
			</dl>
			{q.memo && <p className="review-memo">“{q.memo}”</p>}
		</div>
	);
}

/*
==================
UI_SavedFile

Where a signing request or a signed payment was saved, and what holding
that file means: one view for Send, the offline sheet, and a phone's
result resumed after the picker locked Laurel
==================
*/
export function UI_SavedFile( props: { path: string; signed: boolean } ) {
	return (
		<>
			<p className="lede">{props.signed ? T.offline.signed : T.offline.saved}</p>
			<p className="hint folder-path">{props.path}</p>
			{props.signed ? (
				<div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.offline.liveFile}</span></div>
			) : (
				<>
					<div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.offline.savedHold}</span></div>
					<div className="info-note"><Info aria-hidden="true" /><span>{T.offline.savedHistory}</span></div>
				</>
			)}
		</>
	);
}

/*
==================
UI_SignSheet

Offline: the request as built here, reviewed here, then signed and saved.
Different numbers than online (the online wallet moved on) are said (8).
==================
*/
export function UI_SignSheet( props: sheetProps_t & { review: offlineReview_t | null } ) {
	const [ saved, setSaved ] = useState< string | null >( null );
	const r = props.review;

	// action, not a load: the path is where this press saved the signed file
	const sign = useAction( async ( review: offlineReview_t ) => {
		const path = await commands.oSignF( review.requestId, review.quote );
		if ( path ) {
			setSaved( path );
		}
	}, props.open );
	const reveal = useAction( ( folder: folder_t ) => commands.dRevealF( folder ), props.open );

	function Close( open: boolean ) {
		if ( !open ) {
			setSaved( null );
			void commands.oCloseF();		// the request leaves memory
		}
		props.onOpenChange( open );
	}

	if ( saved ) {
		return (
			<UI_Sheet open={props.open} onOpenChange={Close} title={T.offline.signedTitle}>
				<UI_SavedFile path={saved} signed />
				<UI_SheetClose onClose={() => Close( false )} primary />
			</UI_Sheet>
		);
	}
	return (
		<UI_Sheet open={props.open} onOpenChange={Close} title={T.offline.signTitle} description={r ? T.offline.signFrom( r.accountName, r.walletName ) : undefined} busy={sign.busy}>
			{r && <UI_OfflinePayment quote={r.quote} />}
			{r?.changed && <div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.offline.changed}</span></div>}
			{r?.keyFolder && (
				<div className="warn-note">
					<TriangleAlert aria-hidden="true" />
					<span>
						{T.offline.keyMissing( r.keyFolder )}{" "}
						<button className="link quiet" onClick={() => { void reveal.run( "data" ); }}><FolderOpen aria-hidden="true" />{T.offline.showFolder}</button>
					</span>
				</div>
			)}
			{reveal.error && <UI_Alert title={T.developer.cantShow} message={reveal.error} />}
			<div className="info-note"><span>{T.offline.stayOffline}</span></div>
			{sign.busy && <UI_Waiting text={T.offline.signing} block />}
			{sign.error && <UI_Alert title={T.offline.cantSign} message={sign.error} />}
			<UI_SheetButtons busy={sign.busy} onCancel={() => Close( false )} action={r ? { label: T.offline.sign, onRun: () => void sign.run( r ), icon: <FileSignature aria-hidden="true" /> } : null} />
		</UI_Sheet>
	);
}

// online: the signed payment checked and sent
export function UI_SentSheet( props: sheetProps_t & { txids: string[] } ) {
	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.offline.sentTitle} description={T.offline.sent}>
			<dl className="facts">
				{props.txids.map( ( t ) => <UI_TxidFact key={t} txid={t} /> )}
			</dl>
			<UI_SheetClose onClose={() => props.onOpenChange( false )} primary />
		</UI_Sheet>
	);
}

/*
==================
UI_OfflineSection
==================
*/
export function UI_OfflineSection() {
	const mobile = useStore( ( s ) => s.constants?.mobile ?? false );
	const wallets	= useStore( ( s ) => s.wallets );
	const pending	= useQuery( { queryKey: KEYS.offline(), queryFn: () => commands.oPendingF() } );
	const [ sheet, setSheet ]		= useState< "none" | "sign" | "forget" | "sent" >( "none" );
	const [ review, setReview ]		= useState< offlineReview_t | null >( null );
	const [ forgetting, setForgetting ] = useState< offlinePending_t | null >( null );
	const [ txids, setTxids ]		= useState< string[] >( [] );
	const close = ( open: boolean ) => { if ( !open ) setSheet( "none" ); };

	// action, not a load: the request is the file this press picked
	const open = useAction( async () => {
		const r = await commands.oOpenF();
		if ( r && !mobile ) {
			setReview( r );
			setSheet( "sign" );
		}
	} );
	// action, not a load: the ids are what this press sent
	const finish = useAction( async () => {
		const sent = await commands.oFinishF();
		if ( sent && !mobile ) {
			setTxids( sent );
			setSheet( "sent" );
			await QUERY.invalidateQueries( { queryKey: KEYS.offline() } );
		}
	} );

	return (
		<section className="settings-section">
			<div className="sec-hero">
				<span className="sec-badge"><FileSignature aria-hidden="true" /></span>
				<div className="sec-text">
					<div className="sec-level">
						{T.offline.title}
						<UI_Info title={T.offline.title}>{T.offline.how}</UI_Info>
					</div>
					<div className="sec-title">{T.offline.heroTitle}</div>
					<div className="sec-hint">{T.offline.lede}</div>
					<ol className="handoff">
						<li><span className="handoff-icon"><FileOutput aria-hidden="true" /></span><span className="handoff-label">{T.offline.stepPrepare}</span><span className="handoff-where">{T.offline.stepPrepareWhere}</span></li>
						<li className="away"><span className="handoff-icon"><FileSignature aria-hidden="true" /></span><span className="handoff-label">{T.offline.stepSign}</span><span className="handoff-where">{T.offline.stepSignWhere}</span></li>
						<li><span className="handoff-icon"><Send aria-hidden="true" /></span><span className="handoff-label">{T.offline.stepSend}</span><span className="handoff-where">{T.offline.stepSendWhere}</span></li>
					</ol>
				</div>
			</div>

			<h2 className="section-title">{T.offline.onlineSide}</h2>
			{pending.error && <UI_Alert title={T.offline.cantLoad} message={Com_ErrorOf( pending.error )} action={T.common.tryAgain} onAction={() => void pending.refetch()} />}
			<ul className="pool-list settings-list">
				{pending.data?.length === 0 && (
					<li className="set-row empty">
						<span className="set-icon"><Inbox aria-hidden="true" /></span>
						<span className="set-text"><span className="set-sub">{T.offline.noPending}</span></span>
					</li>
				)}
				{pending.data?.map( ( p ) => (
					<li key={p.id} className="set-row">
						<span className="set-icon"><FileClock aria-hidden="true" /></span>
						<span className="set-text">
							<span className="set-label"><UI_Amount zats={p.quote.amount} unit /> → {Com_Abbrev( p.quote.to )}</span>
							<span className="set-sub">{T.offline.pendingSub( wallets[p.walletId]?.name ?? "", Com_FormatDate( p.made ) )}</span>
						</span>
						<span className="set-actions">
							<button className="btn" onClick={() => { setForgetting( p ); setSheet( "forget" ); }}>{T.offline.forgetButton}</button>
						</span>
					</li>
				) )}
				<li className="set-row">
					<span className="set-icon"><FileCheck2 aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{T.offline.finishRow}</span>
						<span className="set-sub">{T.offline.onlineSideHint}</span>
					</span>
					<span className="set-actions">
						<button className="btn primary" disabled={finish.busy} onClick={() => void finish.run()}>{finish.busy ? <UI_Spinner size={12} /> : T.offline.finish}</button>
					</span>
				</li>
			</ul>
			{finish.busy && <UI_Waiting text={T.offline.finishing} block />}
			{finish.error && <UI_Alert title={T.offline.cantFinish} message={finish.error} />}

			<h2 className="section-title">{T.offline.offlineSide}</h2>
			<ul className="pool-list settings-list">
				<li className="set-row">
					<span className="set-icon away"><FileSignature aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{T.offline.signRow}</span>
						<span className="set-sub">{T.offline.offlineSideHint}</span>
					</span>
					<span className="set-actions">
						<button className="btn" disabled={open.busy} onClick={() => void open.run()}>{open.busy ? <UI_Spinner size={12} /> : T.offline.openRequest}</button>
					</span>
				</li>
			</ul>
			{open.busy && <UI_Waiting text={T.offline.opening} block />}
			{open.error && <UI_Alert title={T.offline.cantOpen} message={open.error} />}

			<UI_SignSheet open={sheet === "sign"} onOpenChange={close} review={review} />
			{/* a request given up; a signed file made for it stays sendable (4) */}
			<UI_ConfirmSheet open={sheet === "forget"} onOpenChange={close} title={T.offline.forgetTitle} description={T.offline.forgetLede} action={T.offline.forget} failed={T.offline.cantForget}
				onConfirm={async () => { if ( forgetting ) { await commands.oForgetF( forgetting.id ); await QUERY.invalidateQueries( { queryKey: KEYS.offline() } ); } }} />
			<UI_SentSheet open={sheet === "sent"} onOpenChange={close} txids={txids} />
		</section>
	);
}
