/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_sweep.tsx -- moving the money at a single private key (a paper
// wallet, zcashd's dumpprivkey) into this account
//
// Three steps in one sheet: the key (read as it's typed, locally), what
// sweeping would move (asked of the server only on Find), then the
// receipt. Quote, then confirm, as for Shield (w_sweep.rs). The key lives
// only in this sheet's state and is dropped when it closes; the quote's
// cache key counts asks and never holds it.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, Info, KeyRound } from "lucide-react";

import { Com_Abbrev, Com_ErrorOf, Com_FormatZec, commands, keyCheck_t, quoted_t, sweepQuote_t } from "./ui_local";
import { T } from "./ui_text";
import { KEYS, QUERY } from "./ui_query";
import { useConfirm, useLatest, useUncapturable } from "./ui_hooks";
import { useStore } from "./ui_store";
import { SECRET_FIELD, sheetProps_t, UI_Alert, UI_Sheet, UI_SheetButtons, UI_Working, UI_SheetWait } from "./ui_widgets";
import { UI_FeeFact, UI_Flow, UI_OfflineNote, UI_Receipt, UI_ReviewFrom } from "./ui_payment";


/*
==================
UI_SweepSheet
==================
*/
export function UI_SweepSheet( props: sheetProps_t & {
	walletId:		string;
	account:		number;
	accountName:	string;
	offline:		boolean;
} ) {
	const hidden	= useStore( ( s ) => s.hideAmounts );
	const testnet	= useStore( ( s ) => s.network ) === "testnet";
	const latest	= useLatest();

	const [ key, setKey ]			= useState( "" );
	const [ check, setCheck ]		= useState< keyCheck_t >( { kind: "empty" } );
	const [ nudge, setNudge ]		= useState( false );
	const [ asked, setAsked ]		= useState( 0 );		// 0: not asked yet; each Find asks again
	const [ sent, setSent ]			= useState< { txid: string; zats: number } | null >( null );
	const keyRef					= useRef< HTMLTextAreaElement >( null );

	useUncapturable( props.open );		// a private key is typed here

	// a closed sheet forgets the key and everything found with it
	useEffect( () => {
		setKey( "" );
		setCheck( { kind: "empty" } );
		setNudge( false );
		setAsked( 0 );
		setSent( null );
	}, [ props.open, props.walletId, props.account ] );

	// read as it's typed, locally; only the newest answer counts
	useEffect( () => {
		latest( commands.wCheckKeyF( key ), setCheck );
	}, [ key ] );

	const qkey = KEYS.sweepQuote( props.walletId, props.account, asked );
	const quote = useQuery( {
		queryKey:	qkey,
		queryFn:	() => commands.wQuoteSweepF( props.walletId, props.account, key ),
		enabled:	props.open && asked > 0 && !sent,
		staleTime:	0,
		gcTime:		0,
	} );

	const sweep = useConfirm(
		( seen: quoted_t< sweepQuote_t > ) => commands.wSweepNowF( props.walletId, props.account, key, seen.intent, seen.quote ),
		( r, seen ) => {
			setSent( { txid: r.txid, zats: seen.quote.amount } );
			setKey( "" );		// done with it
		},
		( quoted ) => QUERY.setQueryData( qkey, quoted ),
		props.open,
	);

	// never a dead button: an empty or unreadable key says so, where the cursor goes
	function Find() {
		if ( check.kind !== "ok" ) {
			setNudge( true );
			keyRef.current?.focus();
			return;
		}
		sweep.setError( null );
		setAsked( ( n ) => n + 1 );
	}

	function EditKey() {
		setAsked( 0 );
		sweep.setError( null );
	}

	const close = () => props.onOpenChange( false );
	const qd = quote.data;
	const q = qd?.quote;
	let body;

	if ( sent ) {
		body = <UI_Receipt title={T.sweep.doneTitle} zats={sent.zats} text={T.sweep.done} txid={sent.txid} onDone={close} />;
	} else if ( asked === 0 ) {
		const line = check.kind === "ok"
			? { text: T.sweep.controls( Com_Abbrev( check.address ) ), tone: " ok" }
			: check.kind === "bad"
				? { text: check.problem, tone: " bad" }
				: nudge
					? { text: T.sweep.missing, tone: " bad" }
					: { text: T.sweep.hint, tone: "" };
		body = (
			<>
				<label className="label" htmlFor="sweep-key">{T.sweep.label}</label>
				<textarea
					id="sweep-key"
					ref={keyRef}
					className="field viewkey-input"
					rows={2}
					{...SECRET_FIELD}
					autoFocus
					placeholder={T.sweep.placeholder( testnet )}
					value={key}
					onChange={( e ) => { setKey( e.target.value ); setNudge( false ); }}
				/>
				<p className={"phrase-status" + line.tone}>{line.text}</p>
				<UI_SheetButtons busy={false} onCancel={close} action={{ label: T.sweep.find, onRun: Find, icon: <KeyRound aria-hidden="true" /> }} />
			</>
		);
	} else if ( quote.error ) {
		body = (
			<>
				<UI_Alert title={T.sweep.failed} message={Com_ErrorOf( quote.error )} action={T.common.tryAgain} onAction={() => { quote.refetch(); }} />
				<UI_SheetButtons busy={false} onCancel={close} action={{ label: T.sweep.editKey, onRun: EditKey }} />
			</>
		);
	} else if ( !qd || !q ) {
		body = <UI_SheetWait text={T.sweep.finding} retrying={quote.failureReason} onClose={close} />;
	} else {
		body = (
			<>
				<UI_ReviewFrom walletId={props.walletId} account={props.account} />
				<UI_Flow
					working={sweep.busy}
					from={{ kind: "key", icon: <KeyRound aria-hidden="true" />, label: T.sweep.from, zats: q.total }}
					to={{ kind: "public", icon: <Eye aria-hidden="true" />, label: T.sweep.to, zats: q.amount }}
				/>
				{sweep.busy ? <UI_Working since={sweep.since} title={T.sweep.working} hint={T.review.provingHint} /> : (
					<dl className="facts">
						<div className="fact"><dt>{T.sweep.fromAddress}</dt><dd><code className="fact-id">{Com_Abbrev( q.from )}</code></dd></div>
						<div className="fact"><dt>{T.sweep.coins}</dt><dd>{q.coins}</dd></div>
						<UI_FeeFact zats={q.fee} />
					</dl>
				)}
				{!sweep.busy && <div className="info-note"><Info aria-hidden="true" /><span>{T.sweep.arrives}</span></div>}
				{q.left > 0 && !sweep.busy && <div className="info-note"><Info aria-hidden="true" /><span>{T.sweep.left( q.left )}</span></div>}
				{sweep.changed && !sweep.busy && <div className="info-note"><Info aria-hidden="true" /><span>{T.sweep.changed}</span></div>}
				{props.offline && !sweep.busy && <UI_OfflineNote />}
				{sweep.error && <UI_Alert title={T.sweep.failed} message={sweep.error} action={T.common.tryAgain} onAction={() => { sweep.setError( null ); quote.refetch(); }} />}

				{!sweep.busy && (
					<UI_SheetButtons busy={false} onCancel={EditKey} cancel={T.sweep.editKey} action={sweep.error ? null : {
						label:	hidden ? T.sweep.actionHidden : T.sweep.action( Com_FormatZec( q.amount ) ),
						onRun:	() => { sweep.run( qd ); },
						icon:	<KeyRound aria-hidden="true" />,
					}} />
				)}
			</>
		);
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.sweep.title} description={sent ? undefined : T.sweep.lede( props.accountName )} busy={sweep.busy}>
			{body}
		</UI_Sheet>
	);
}
