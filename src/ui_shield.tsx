/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_shield.tsx -- money into the private balance, from inside the
// account: public money shielded (w_shield.rs), Sapling money moved into
// Ironwood (w_move.rs). One sheet, said two ways.
//
// Quote, then confirm: the sheet shows what it would do and the engine
// keeps nothing, so sync runs while the person reads. The button builds
// it again and sends it at once if nothing changed; if something did,
// the new numbers are shown for another look.

import { ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, Eye, Info, ShieldCheck } from "lucide-react";

import { Com_ErrorOf, Com_FormatZec, commands, quoted_t, shieldQuote_t, shieldResult_t } from "./ui_local";
import { T } from "./ui_text";
import { KEYS, QUERY } from "./ui_query";
import { useConfirm } from "./ui_hooks";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_Alert, UI_Sheet, UI_SheetButtons, UI_SheetClose, UI_SheetWait } from "./ui_widgets";
import { UI_FeeFact, UI_FeeNote, UI_OfflineNote, UI_Flow, UI_Proving, UI_Receipt, UI_ReviewFrom, UI_SpendKeyNote, flowEnd_t, useSpendKey } from "./ui_payment";
import { UI_CatchingUp, usePayable } from "./ui_sync";

// what each way says: T.shield and T.move, key for key
type intoPrivateText_t = {
	title: string; lede: string; from: string; to: string; action: ( amount: string ) => string; changed: string;
	doneTitle: string; done: string; failed: string; nothingTitle: string; nothing: string; actionHidden: string;
};

type intoPrivateProps_t = sheetProps_t & {
	walletId:		string;
	account:		number;
	heldZats:		number;			// what there is to bring in, as the engine last said
	offline:		boolean;
};

/*
==================
UI_IntoPrivateSheet

The one sheet, and how each way says it: its words (the same keys, in
T.shield and T.move), where the money comes from, the engine's quote
and send, and the key its quote is kept under (the amount held is in
it: new money there changes the quote)
==================
*/
function UI_IntoPrivateSheet( props: intoPrivateProps_t & {
	text:		intoPrivateText_t;
	from:		flowEnd_t["kind"];
	fromIcon:	ReactNode;
	icon:		ReactNode;
	queryKey:	readonly unknown[];
	quote:		() => Promise< quoted_t< shieldQuote_t > >;
	now:		( seen: quoted_t< shieldQuote_t > ) => Promise< shieldResult_t >;
	spendsSapling:	boolean;		// its notes are Sapling's: the first time, the key is fetched (useSpendKey)
} ) {
	const hidden = useStore( ( s ) => s.hideAmounts );
	const [ sent, setSent ]			= useState< { txid: string; zats: number } | null >( null );
	const text = props.text;
	const key = props.queryKey;
	const fetchKey = useSpendKey( props.spendsSapling );
	const payable = usePayable( props.walletId );

	const quote = useQuery( {
		queryKey:	key,
		queryFn:	props.quote,
		enabled:	props.open && props.heldZats > 0 && !sent && payable,		// asked only once the wallet has caught up
		staleTime:	0,		// asked again each time the sheet opens: the chain moves on
		gcTime:		0,
	} );

	// once per quote seen: the intent goes back with it (w_engine.rs)
	const bring = useConfirm(
		props.now,
		( r, seen ) => setSent( { txid: r.txid, zats: seen.quote.amount } ),
		( quoted ) => QUERY.setQueryData( key, quoted ),
		props.open,
	);

	useEffect( () => {
		if ( props.open ) {
			setSent( null );
		}
	}, [ props.open, props.walletId, props.account ] );

	const qd	= quote.data;
	const q		= qd?.quote;
	let body;
	if ( props.heldZats <= 0 && !sent ) {
		body = (
			<>
				<div className="sheet-state">
					<span className="sheet-state-icon">{props.icon}</span>
					<span className="sheet-state-title">{text.nothingTitle}</span>
					<span className="sheet-state-text">{text.nothing}</span>
				</div>
				<UI_SheetClose onClose={() => props.onOpenChange( false )} primary label={T.soon.ok} />
			</>
		);
	} else if ( sent ) {
		body = <UI_Receipt title={text.doneTitle} zats={sent.zats} text={text.done} txid={sent.txid} onDone={() => props.onOpenChange( false )} />;
	} else if ( !payable && !q && !bring.busy ) {
		body = (
			<>
				<UI_CatchingUp walletId={props.walletId} />
				<UI_SheetClose onClose={() => props.onOpenChange( false )} primary label={T.catchUp.later} />
			</>
		);
	} else if ( quote.error ) {
		body = (
			<>
				<UI_Alert title={text.failed} message={Com_ErrorOf( quote.error )} action={T.common.tryAgain} onAction={() => { quote.refetch(); }} />
				<UI_SheetClose onClose={() => props.onOpenChange( false )} />
			</>
		);
	} else if ( !qd || !q ) {
		body = <UI_SheetWait text={T.review.preparing} retrying={quote.failureReason} onClose={() => props.onOpenChange( false )} />;
	} else {
		body = (
			<>
				<UI_ReviewFrom walletId={props.walletId} account={props.account} />
				<UI_Flow
					working={bring.busy}
					from={{ kind: props.from, icon: props.fromIcon, label: text.from, zats: q.amount + q.fee }}
					to={{ kind: "private", icon: <ShieldCheck aria-hidden="true" />, label: text.to, zats: q.amount }}
				/>

				{bring.busy ? <UI_Proving since={bring.since} fetch={fetchKey} /> : (
					<dl className="facts">
						<UI_FeeFact zats={q.fee} />
					</dl>
				)}
				{!bring.busy && <UI_FeeNote note={q.feeNote} />}
				{!bring.busy && <UI_SpendKeyNote fetch={fetchKey} />}
				{bring.changed && !bring.busy && <div className="info-note"><Info aria-hidden="true" /><span>{text.changed}</span></div>}
				{props.offline && !bring.busy && <UI_OfflineNote />}
				{bring.error && <UI_Alert title={text.failed} message={bring.error} action={T.common.tryAgain} onAction={() => { bring.setError( null ); quote.refetch(); }} />}

				{!bring.busy && (
					<UI_SheetButtons busy={false} onCancel={() => props.onOpenChange( false )} action={bring.error ? null : {
						label:	hidden ? text.actionHidden : text.action( Com_FormatZec( q.amount ) ),
						onRun:	() => { bring.run( qd ); },
						icon:	props.icon,
					}} />
				)}
			</>
		);
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={text.title} description={sent ? undefined : text.lede} busy={bring.busy}>
			{body}
		</UI_Sheet>
	);
}

/*
==================
UI_ShieldSheet

Public money into the private balance
==================
*/
export function UI_ShieldSheet( props: intoPrivateProps_t ) {
	return (
		<UI_IntoPrivateSheet
			{...props}
			text={T.shield}
			from="public"
			spendsSapling={false}
			fromIcon={<Eye aria-hidden="true" />}
			icon={<ShieldCheck aria-hidden="true" />}
			queryKey={KEYS.shieldQuote( props.walletId, props.account, props.heldZats )}
			quote={() => commands.wQuoteShieldF( props.walletId, props.account )}
			now={( seen ) => commands.wShieldNowF( props.walletId, props.account, seen.intent, seen.quote )}
		/>
	);
}

/*
==================
UI_MoveSheet

Sapling money into Ironwood: all of it, private all the way
==================
*/
export function UI_MoveSheet( props: intoPrivateProps_t ) {
	return (
		<UI_IntoPrivateSheet
			{...props}
			text={T.move}
			from="pool-sapling"
			spendsSapling
			fromIcon={<ShieldCheck aria-hidden="true" />}
			icon={<ArrowRightLeft aria-hidden="true" />}
			queryKey={KEYS.moveQuote( props.walletId, props.account, props.heldZats )}
			quote={() => commands.wQuoteMoveF( props.walletId, props.account )}
			now={( seen ) => commands.wMoveNowF( props.walletId, props.account, seen.intent, seen.quote )}
		/>
	);
}
