/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_toast.tsx -- "Received 0.5 ZEC" in the corner when a payment arrives,
// a word when one sent went through or didn't, and a price alert that
// went off. The engine decides what's news (w_notice.rs, Com_Look;
// w_alert.rs); this only shows it.

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownLeft, ArrowUpRight, TrendingDown, TrendingUp, TriangleAlert, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Com_FormatUsd, Com_NewsKey, news_t, paymentEvent_t, priceAlertEvent_t } from "./ui_local";
import { T } from "./ui_text";
import { useStore } from "./ui_store";
import { useAppSettings } from "./ui_hooks";
import { SPRING, UI_Amount } from "./ui_widgets";

const TOAST_MSEC	= 7000;
const TOAST_MAX		= 3;		// more at once would cover the page; the newest win


/*
==================
Com_News

How one piece of news reads, from what the engine said it is: arrived,
went through, or didn't. Nothing else is sent as news (Com_Look).
==================
*/
function Com_News( p: paymentEvent_t ): { icon: LucideIcon; tone: string; title: string; amount: boolean; sub: string | null } | null {
	switch ( p.kind ) {
	case "received":
		return { icon: ArrowDownLeft, tone: "received", title: T.toast.received, amount: true, sub: p.state.kind === "pending" ? T.history.pending : null };
	case "sent":
		return p.state.kind === "failed"
			? { icon: TriangleAlert, tone: "failed", title: T.toast.failed, amount: false, sub: T.toast.failedSub }
			: { icon: ArrowUpRight, tone: "sent", title: T.toast.sent, amount: true, sub: T.toast.wentThrough };
	case "shield":
	case "move":
		return null;
	}
}

/*
==================
UI_ToastFrame

One toast: in, out after a while or when closed. The body is what the
news says; onOpen, if any, makes it a button that goes to it.
==================
*/
function UI_ToastFrame( props: { newsKey: string; onOpen?: () => void; children: ReactNode } ) {
	const dismiss = useStore( ( s ) => s.Dismiss );
	const key = props.newsKey;

	useEffect( () => {
		const timer = setTimeout( () => dismiss( key ), TOAST_MSEC );
		return () => clearTimeout( timer );
	}, [ key ] );

	return (
		<motion.div
			layout
			className="toast"
			role="status"
			initial={{ opacity: 0, y: -12, scale: 0.97 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, x: 24 }}
			transition={SPRING}
		>
			{props.onOpen
				? <button className="toast-body" onClick={() => { props.onOpen?.(); dismiss( key ); }}>{props.children}</button>
				: <div className="toast-body">{props.children}</div>}
			<button className="icon-btn" aria-label={T.common.close} onClick={() => dismiss( key )}><X aria-hidden="true" /></button>
		</motion.div>
	);
}

// a payment: what it is, how much, and where
function UI_PaymentToast( props: { payment: paymentEvent_t; newsKey: string; walletName: string; onOpen: () => void } ) {
	const p = props.payment;
	const news = Com_News( p );
	if ( !news ) {
		return null;
	}
	return (
		<UI_ToastFrame newsKey={props.newsKey} onOpen={props.onOpen}>
			<span className={"tx-icon " + news.tone}><news.icon aria-hidden="true" /></span>
			<span className="toast-text">
				<span className="toast-title">{news.title}{news.amount && <> <UI_Amount zats={p.amount} unit /></>}{news.sub && news.amount ? ` ${news.sub}` : ""}</span>
				<span className="toast-sub">{!news.amount && news.sub ? `${news.sub} ` : ""}{p.accountName} · {props.walletName}</span>
			</span>
		</UI_ToastFrame>
	);
}

// a price alert that went off: which way, and the price now
function UI_PriceToast( props: { alert: priceAlertEvent_t; newsKey: string } ) {
	const a = props.alert;
	const Icon = a.above ? TrendingUp : TrendingDown;
	return (
		<UI_ToastFrame newsKey={props.newsKey}>
			<span className={"tx-icon " + ( a.above ? "received" : "sent" )}><Icon aria-hidden="true" /></span>
			<span className="toast-text">
				<span className="toast-title">{a.above ? T.toast.rose( Com_FormatUsd( a.usd ) ) : T.toast.fell( Com_FormatUsd( a.usd ) )}</span>
				<span className="toast-sub">{T.toast.priceNow( Com_FormatUsd( a.price ) )}</span>
			</span>
		</UI_ToastFrame>
	);
}

// the toast for one piece of news, by its kind
function UI_NewsToast( props: { news: news_t; walletName: ( id: string ) => string; onOpen: ( p: paymentEvent_t ) => void } ) {
	const n = props.news;
	const key = Com_NewsKey( n );
	switch ( n.kind ) {
	case "payment":	return <UI_PaymentToast payment={n.payment} newsKey={key} walletName={props.walletName( n.payment.walletId )} onOpen={() => props.onOpen( n.payment )} />;
	case "price":	return <UI_PriceToast alert={n.alert} newsKey={key} />;
	}
}

/*
==================
UI_Toasts

onOpen gets a payment, so the page can switch to its account and show
its history; a price alert only says itself
==================
*/
export function UI_Toasts( props: { onOpen: ( p: paymentEvent_t ) => void } ) {
	const news		= useStore( ( s ) => s.news );
	const wallets	= useStore( ( s ) => s.wallets );
	const { settings } = useAppSettings();
	const shown		= settings?.notifyInApp === false ? [] : news.slice( -TOAST_MAX ).reverse();

	return (
		<div className="toasts" aria-live="polite">
			<AnimatePresence initial={false}>
				{shown.map( ( n ) => (
					<UI_NewsToast key={Com_NewsKey( n )} news={n} walletName={( id ) => wallets[id]?.name ?? ""} onOpen={props.onOpen} />
				) )}
			</AnimatePresence>
		</div>
	);
}
