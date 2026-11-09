/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_history.tsx -- what happened to an account's money, in words
//
// The engine says what each transaction was for this account (w_history.rs:
// received, sent, shielded, moved) and the amounts; this file groups the
// lines by day, filters them, and shows one in detail.

import { useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Calendar, CircleX, Clock, Download, History, List, Search, SearchX, ShieldCheck, SlidersHorizontal, TriangleAlert, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { blockEra_t, Com_Abbrev, Com_FormatDate, Com_FormatZec, Com_MemoAsksForSecrets, Com_Options, Com_SyncState, Com_Unreachable, commands, historyItem_t, pool_t, POOLS, syncProgress_t, txCategory_t, txKind_t, txState_t } from "./ui_local";
import { useStore } from "./ui_store";
import { Com_PoolName, T } from "./ui_text";
import { Com_List } from "./ui_locale";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "./ui_query";
import { sheetProps_t, UI_Alert, UI_Amount, UI_ChipSet, UI_Empty, UI_Info, UI_LoadFailed, UI_Popover, UI_Segmented, UI_Sheet, UI_SheetButtons, UI_SheetClose, UI_Spinner, UI_Switch } from "./ui_widgets";
import { UI_FeeFact, UI_TxidFact } from "./ui_payment";
import { useAction } from "./ui_hooks";
import { UI_AddressLine } from "./ui_receive";

export type historyFilter_t = "all" | "received" | "sent" | "moves";
export type statusFilter_t = "any" | "waiting" | "failed";
export type period_t = "any" | "month" | "days30" | "year" | "lastYear";

// every filter of the page, together: a new one is one more field, not one more argument everywhere
export type historyQuery_t = { kind: historyFilter_t; status: statusFilter_t; period: period_t; category: txCategory_t | "any"; pools: pool_t[]; text: string };
export const NO_QUERY: historyQuery_t = { kind: "all", status: "any", period: "any", category: "any", pools: [], text: "" };

const DAY_SECS = 86400;

const KIND_ICON: Record< txKind_t, LucideIcon > = {
	received:	ArrowDownLeft,
	sent:		ArrowUpRight,
	shield:		ShieldCheck,
	move:		ArrowLeftRight,
};

// the filter bar's icons: a kind by its line's own icon, a status by what it says
const FILTER_ICON: Record< historyFilter_t, LucideIcon > = { all: List, received: KIND_ICON.received, sent: KIND_ICON.sent, moves: KIND_ICON.move };
const STATUS_ICON: Record< statusFilter_t, LucideIcon | null > = { any: null, waiting: Clock, failed: CircleX };

// an icon or none, for an option
function UI_IconOf( I: LucideIcon | null ) {
	return I ? <I aria-hidden="true" /> : undefined;
}


/*
==================
Com_Period

A period as [since, until) in unix seconds, by the local calendar: a
month or a year is the one people file taxes and books by
==================
*/
export function Com_Period( period: period_t, now: number ): [ number, number ] {
	const d = new Date( now * 1000 );
	const at = ( y: number, m: number, day = 1 ) => Math.floor( new Date( y, m, day ).getTime() / 1000 );
	switch ( period ) {
	case "any":			return [ 0, Infinity ];
	case "month":		return [ at( d.getFullYear(), d.getMonth() ), Infinity ];
	case "days30":		return [ now - 30 * 86_400, Infinity ];
	case "year":		return [ at( d.getFullYear(), 0 ), Infinity ];
	case "lastYear":	return [ at( d.getFullYear() - 1, 0 ), at( d.getFullYear(), 0 ) ];
	default:			return Com_Unreachable( period );
	}
}

/*
==================
Com_Matches

Whether a line passes the filters: its kind, its state (as
Com_TxStateView reads it), its time, any of the chosen pools (where the
money came from or went), and the search text
==================
*/
export function Com_Matches( item: historyItem_t, q: historyQuery_t, now: number ): boolean {
	const view = Com_TxStateView( item.state, 0, [], now );
	switch ( q.status ) {
	case "any":			break;
	case "waiting":		if ( !view.waiting ) return false; break;
	case "failed":		if ( !view.failed ) return false; break;
	default:			Com_Unreachable( q.status );
	}

	if ( q.category !== "any" && item.category !== q.category ) {
		return false;
	}

	const [ since, until ] = Com_Period( q.period, now );
	if ( item.time < since || item.time >= until ) {
		return false;
	}

	switch ( q.kind ) {
	case "all":			break;
	case "received":	if ( item.kind !== "received" ) return false; break;
	case "sent":		if ( item.kind !== "sent" ) return false; break;
	case "moves":		if ( item.kind !== "shield" && item.kind !== "move" ) return false; break;
	default:			Com_Unreachable( q.kind );
	}

	if ( q.pools.length && !q.pools.some( ( p ) => item.from.includes( p ) || item.into.includes( p ) ) ) {
		return false;
	}

	const text = q.text.trim().toLowerCase();
	if ( !text ) {
		return true;
	}
	return [ item.note, item.category && T.history.categories[item.category], item.counterparty, item.memo, item.txid, Com_FormatZec( item.amount ) ]
		.some( ( s ) => s?.toLowerCase().includes( text ) );
}

/*
==================
Com_DayLabel

Today, Yesterday, or the date: how people think about when
==================
*/
export function Com_DayLabel( time: number, now: number ): string {
	const day = ( t: number ) => {
		const d = new Date( t * 1000 );
		return new Date( d.getFullYear(), d.getMonth(), d.getDate() ).getTime() / 1000;
	};
	const diff = Math.round( ( day( now ) - day( time ) ) / DAY_SECS );
	if ( diff === 0 ) {
		return T.history.today;
	}
	if ( diff === 1 ) {
		return T.history.yesterday;
	}
	return Com_FormatDate( time );
}

/*
==================
useTransactions

An account's transactions: one query, one key, for every screen that
reads them (History, and Send's "a payment is still pending" note)
==================
*/
export function useTransactions( walletId: string, account: number ) {
	return useQuery( {
		queryKey:	KEYS.transactions( walletId, account ),
		queryFn:	() => commands.wTransactionsF( walletId, account ),
	} );
}

/*
==================
Com_TxStateView

How one transaction's state shows, decided once for the list, the
detail and the grouping: waiting ones lead under Pending; a failed one
keeps its day but says it didn't go through, and only it can be sent
again: its money is back and nothing was paid. A pending payment's
expiry is a time, from the blocks left and the network's block times
at those heights (Com_SecsBetween).
==================
*/
export type txStateView_t = { waiting: boolean; failed: boolean; again: boolean; pill: string | null; tone: "" | " pending" | " failed"; line: ( when: string ) => string };

export function Com_TxStateView( state: txState_t, chainHeight: number, eras: blockEra_t[], now: number ): txStateView_t {
	switch ( state.kind ) {
	case "confirmed":
		return { waiting: false, failed: false, again: false, pill: null, tone: "", line: T.history.confirmed };
	case "pending": {
		let expiry: string = T.history.noExpiry;
		if ( state.expiresAt != null && chainHeight > 0 ) {
			const left = state.expiresAt - chainHeight;
			expiry = left > 0 ? T.history.expiresBy( Com_FormatDate( now + Com_SecsBetween( eras, chainHeight, state.expiresAt ), "time" ) ) : T.history.expiresNow;
		}
		return { waiting: true, failed: false, again: false, pill: T.history.pending, tone: " pending", line: () => `${T.history.pendingLong} ${expiry}` };
	}
	case "unsent":
		return { waiting: true, failed: false, again: false, pill: T.history.unsent, tone: " pending", line: () => T.history.unsentLong };
	case "failed":
		return { waiting: false, failed: true, again: true, pill: T.history.failed, tone: " failed", line: () => T.history.failedLong };
	default:
		return Com_Unreachable( state );
	}
}

/*
==================
Com_SecsBetween

The target time from the block at height `from` to the one at `to`, over
one network's eras (W_BlockEras, in height order): each block in
(from, to] takes the spacing of the era it falls in. Since NU7 that is
25 s; a constant 75 s said a pending payment had 2.5 hours, not 50 minutes.
==================
*/
export function Com_SecsBetween( eras: readonly blockEra_t[], from: number, to: number ): number {
	let secs = 0;
	eras.forEach( ( era, i ) => {
		const first = Math.max( era.from, from + 1 );
		const last = i + 1 < eras.length ? Math.min( eras[i + 1].from - 1, to ) : to;
		if ( last >= first ) {
			secs += ( last - first + 1 ) * era.secs;
		}
	} );
	return secs;
}

/*
==================
Com_GroupByDay

Lines already newest first, in runs of one day each. What waits on the
network has no day yet and leads, under Pending.
==================
*/
export function Com_GroupByDay( items: historyItem_t[], now: number ): { label: string; items: historyItem_t[] }[] {
	const groups: { label: string; items: historyItem_t[] }[] = [];
	for ( const it of items ) {
		const label = Com_TxStateView( it.state, 0, [], now ).waiting ? T.history.pending : Com_DayLabel( it.time, now );
		const last = groups[groups.length - 1];
		if ( last && last.label === label ) {
			last.items.push( it );
		} else {
			groups.push( { label, items: [ it ] } );
		}
	}
	return groups;
}


/*
==================
Com_TxTitle
==================
*/
function Com_TxTitle( it: historyItem_t ): string {
	switch ( it.kind ) {
	case "received":	return T.history.received;
	case "sent":		return T.history.sent;
	case "shield":		return T.history.shield;
	case "move":		return it.into.length === 1 ? T.history.move( Com_PoolName( it.into[0] ) ) : T.history.moveAny;
	default:			return Com_Unreachable( it.kind );
	}
}


/*
==================
UI_TxRow
==================
*/
function UI_TxRow( props: { item: historyItem_t; onOpen: () => void } ) {
	const it = props.item;
	const Icon = KIND_ICON[it.kind];
	const view = Com_TxStateView( it.state, 0, [], 0 );
	const sign = view.tone === " failed" ? "" : it.kind === "received" ? "+" : it.kind === "sent" ? "−" : "";		// a failed one moved nothing
	// a memo that arrived is anyone's words (spam, a lure): the list says one is there,
	// and it is read only in the transaction, opened on purpose, with its warnings
	const memo = it.memo && it.kind === "received" ? T.history.withMessage : it.memo;
	// the person's own note first: their words for it
	const sub = it.note ?? ( it.counterparty ? Com_Abbrev( it.counterparty ) : memo ?? Com_List( it.into.map( Com_PoolName ) ) );

	return (
		<li>
			<button className={"tx-row " + it.kind + view.tone} onClick={props.onOpen}>
				<span className="tx-icon"><Icon aria-hidden="true" /></span>
				<span className="tx-text">
					<span className="tx-title">{Com_TxTitle( it )}</span>
					<span className="tx-sub">{Com_FormatDate( it.time, "time" )}{sub ? ` · ${sub}` : ""}</span>
				</span>
				<span className="tx-amount">
					<span className="tx-amount-value"><UI_Amount zats={it.amount} prefix={sign} unit /></span>
					{view.pill && <span className={"tx-pending" + view.tone}>{view.pill}</span>}
				</span>
			</button>
		</li>
	);
}

/*
==================
UI_TxSheet

One transaction, whole
==================
*/
/*
==================
UI_TxNote

The person's own note on a transaction (w_notes.rs): saved when changed,
and the history read again so the list and search have it
==================
*/
function UI_TxNote( props: { item: historyItem_t; onSaved: () => void } ) {
	const categories	= useStore( ( s ) => s.constants )?.categories ?? [];
	const saved			= props.item.note ?? "";
	const savedCategory	= props.item.category;
	const [ text, setText ]			= useState( saved );
	const [ category, setCategory ]	= useState< txCategory_t | null >( savedCategory );

	useEffect( () => {
		setText( saved );
		setCategory( savedCategory );
	}, [ props.item.txid, saved, savedCategory ] );

	const maxChars = useStore( ( s ) => s.constants?.noteMaxChars );
	const save = useAction( async () => {
		await commands.ntSaveF( props.item.txid, text, category );
		props.onSaved();
	} );

	return (
		<div className="tx-note">
			<label className="label" htmlFor="tx-note">{T.history.note} <UI_Info title={T.history.note}>{T.history.noteHint}</UI_Info></label>
			<textarea id="tx-note" className="field" rows={2} maxLength={maxChars} placeholder={T.history.notePlaceholder} value={text} onChange={( e ) => setText( e.target.value )} />
			<label className="label" htmlFor="tx-category">{T.history.category}</label>
			<select id="tx-category" className="field-select" value={category ?? ""} onChange={( e ) => setCategory( ( e.target.value || null ) as txCategory_t | null )}>
				<option value="">{T.history.noCategory}</option>
				{categories.map( ( c ) => <option key={c} value={c}>{T.history.categories[c]}</option> )}
			</select>
			{save.error && <UI_Alert title={T.history.noteFailed} message={save.error} />}
			{( text.trim() !== saved || category !== savedCategory ) && (
				<div className="request-actions">
					<button className="btn small" disabled={save.busy} onClick={() => void save.run()}>{save.busy ? <UI_Spinner size={12} /> : null}{T.history.saveNote}</button>
				</div>
			)}
		</div>
	);
}

export function UI_TxSheet( props: sheetProps_t & { item: historyItem_t | null; chainHeight: number; onSendAgain: ( it: historyItem_t ) => void; onNoteSaved: () => void } ) {
	const allEras = useStore( ( s ) => s.constants?.blockEras );
	const network = useStore( ( s ) => s.network );
	const eras = useMemo( () => ( allEras ?? [] ).filter( ( e ) => e.network === network ), [ allEras, network ] );
	const it = props.item;
	if ( !it ) {
		return null;
	}
	const Icon = KIND_ICON[it.kind];
	const view = Com_TxStateView( it.state, props.chainHeight, eras, Math.floor( Date.now() / 1000 ) );
	const sign = view.tone === " failed" ? "" : it.kind === "received" ? "+" : it.kind === "sent" ? "−" : "";
	const when = `${Com_FormatDate( it.time )}, ${Com_FormatDate( it.time, "time" )}`;

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={Com_TxTitle( it )}>
			<div className="tx-detail">
				<span className={"tx-icon big " + it.kind}><Icon aria-hidden="true" /></span>
				<div className="review-amount"><UI_Amount zats={it.amount} prefix={sign} unit /></div>
				<p className={"tx-status" + view.tone}>{view.line( when )}</p>

				{it.counterparty && (
					<div className="review-to">
						<span className="label">{T.history.to}</span>
						<UI_AddressLine address={it.counterparty} />
					</div>
				)}
				<dl className="facts">
					{it.from.length > 0 && <div className="fact"><dt>{T.history.from}</dt><dd>{Com_List( it.from.map( Com_PoolName ) )}</dd></div>}
					{it.into.length > 0 && <div className="fact"><dt>{T.history.into}</dt><dd>{Com_List( it.into.map( Com_PoolName ) )}</dd></div>}
					{it.kind !== "received" && view.tone !== " failed" && (
						<UI_FeeFact zats={it.fee} />
					)}
					<UI_TxidFact txid={it.txid} />
				</dl>
				{it.memo && <p className="review-memo">“{it.memo}”</p>}
				<UI_TxNote item={it} onSaved={props.onNoteSaved} />
				{it.memo && Com_MemoAsksForSecrets( it.memo ) && <div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.memo.asksForSecrets}</span></div>}
				{view.again && it.kind === "sent" && it.counterparty
					? <UI_SheetButtons action={{ label: T.history.sendAgain, onRun: () => { props.onOpenChange( false ); props.onSendAgain( it ); } }} busy={false} onCancel={() => props.onOpenChange( false )} cancel={T.common.close} />
					: <UI_SheetClose onClose={() => props.onOpenChange( false )} primary />}
			</div>
		</UI_Sheet>
	);
}

/*
==================
UI_ExportSheet

The account's history as a CSV file (W_ExportCsv): memos only when
asked for, and where the file went said once it's there
==================
*/
function UI_ExportSheet( props: sheetProps_t & { walletId: string; account: number } ) {
	const [ memos, setMemos ]	= useState( false );
	const [ saved, setSaved ]	= useState< string | null >( null );

	// action, not a load: it writes a file
	const save = useAction( async () => {
		setSaved( await commands.wExportCsvF( props.walletId, props.account, memos ) );
	}, props.open );

	useEffect( () => {
		setMemos( false );
		setSaved( null );
		save.setError( null );
	}, [ props.open ] );

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.history.exportTitle} description={T.history.exportLede} busy={save.busy}>
			<div className="set-row">
				<span className="set-text">
					<span className="set-label">{T.history.exportMemos}</span>
					<span className="set-sub">{T.history.exportMemosHint}</span>
				</span>
				<UI_Switch checked={memos} onChange={setMemos} label={T.history.exportMemos} />
			</div>
			{saved && <p className="hint">{T.history.exported( saved )}</p>}
			{save.error && <UI_Alert title={T.history.exportFailed} message={save.error} />}
			{saved
				? <UI_SheetClose onClose={() => props.onOpenChange( false )} primary />
				: <UI_SheetButtons action={{ label: T.history.exportAction, onRun: () => void save.run() }} busy={save.busy} onCancel={() => props.onOpenChange( false )} />}
		</UI_Sheet>
	);
}

/*
==================
UI_History

The page. Reloads when the balance or sync state changes, so it never
disagrees with the balance above it.
==================
*/
export function UI_History( props: { walletId: string; account: number; total: number; progress: syncProgress_t | undefined; onReceive: () => void; onSendAgain: ( it: historyItem_t ) => void } ) {
	const state = Com_SyncState( props.progress );

	const startPools				= useStore( ( s ) => s.historyPools );		// opened from a pool: its lines only
	const [ query, setQuery ]		= useState< historyQuery_t >( () => ( { ...NO_QUERY, pools: startPools } ) );
	const categories				= useStore( ( s ) => s.constants )?.categories ?? [];
	const set = ( patch: Partial< historyQuery_t > ) => setQuery( { ...query, ...patch } );
	const [ open, setOpen ]			= useState< historyItem_t | null >( null );
	const [ sheetOpen, setSheetOpen ] = useState( false );
	const [ exporting, setExporting ] = useState( false );

	const load = useTransactions( props.walletId, props.account );
	const items = load.data ?? null;

	// a new balance or sync state: read again, for this same key
	useEffect( () => {
		void load.refetch();
	}, [ props.total, state ] );

	const shown = useMemo( () => ( items ?? [] ).filter( ( it ) => Com_Matches( it, query, Math.floor( Date.now() / 1000 ) ) ), [ items, query ] );
	const groups = useMemo( () => Com_GroupByDay( shown, Math.floor( Date.now() / 1000 ) ), [ shown ] );

	function TogglePool( p: pool_t ) {
		set( { pools: query.pools.includes( p ) ? query.pools.filter( ( x ) => x !== p ) : [ ...query.pools, p ] } );
	}

	// the filters in the Filters panel that are on, each a chip that takes itself off, and
	// Clear All for all of them; the kind and the search are the bar's own, in plain view,
	// and stay as they are
	const PANEL_OFF: Partial< historyQuery_t > = { pools: [], status: "any", category: "any", period: "any" };
	const active: { key: string; label: string; className?: string; remove: () => void }[] = [
		...query.pools.map( ( p ) => ( { key: p, label: Com_PoolName( p ), className: "chip-pool pool-" + p, remove: () => TogglePool( p ) } ) ),
		...( query.status !== "any" ? [ { key: "status", label: T.history.statuses[query.status], remove: () => set( { status: "any" } ) } ] : [] ),
		...( query.category !== "any" ? [ { key: "category", label: T.history.categories[query.category], remove: () => set( { category: "any" } ) } ] : [] ),
		...( query.period !== "any" ? [ { key: "period", label: T.history.periods[query.period], remove: () => set( { period: "any" } ) } ] : [] ),
	];

	let body;
	if ( load.error ) {
		body = <UI_LoadFailed title={T.history.cantLoad} error={load.error} onRetry={() => void load.refetch()} />;
	} else if ( !items ) {
		body = <UI_Empty><UI_Spinner size={18} /></UI_Empty>;
	} else if ( !items.length ) {
		body = (
			<UI_Empty icon={<History aria-hidden="true" />} title={T.history.emptyTitle} text={T.history.empty}>
				<button className="btn primary" onClick={props.onReceive}><ArrowDownLeft aria-hidden="true" />{T.privacy.emptyAction}</button>
			</UI_Empty>
		);
	} else if ( !shown.length ) {
		body = (
			<UI_Empty icon={<SearchX aria-hidden="true" />} tone="quiet" title={T.history.noMatchTitle} text={T.history.noMatch}>
				<button className="btn" onClick={() => setQuery( NO_QUERY )}>{T.history.clear}</button>
			</UI_Empty>
		);
	} else {
		body = groups.map( ( g ) => (
			<section key={g.label} className="tx-group">
				<h2 className="tx-day">{g.label}</h2>
				<ul className="pool-list tx-list">
					{g.items.map( ( it ) => <UI_TxRow key={it.txid} item={it} onOpen={() => { setOpen( it ); setSheetOpen( true ); }} /> )}
				</ul>
			</section>
		) );
	}

	return (
		<div className="history">
			<div className="history-head">
				<h1 className="page-title">{T.history.title}</h1>
				{!!items?.length && <button className="btn small" onClick={() => setExporting( true )}><Download aria-hidden="true" />{T.history.export}</button>}
			</div>
			{state !== "synced" && <p className="chart-note">{T.history.syncing}</p>}

			{!!items?.length && <>
			<div className="history-tools">
				<label className="history-search">
					<Search aria-hidden="true" />
					<input value={query.text} placeholder={T.history.search} spellCheck={false} onChange={( e ) => set( { text: e.target.value } )} />
					{query.text && <button className="icon-btn" aria-label={T.common.cancel} onClick={() => set( { text: "" } )}><X aria-hidden="true" /></button>}
				</label>
				<div className="history-tools-end">
					<UI_Segmented
						small
						id="history-filter"
						value={query.kind}
						onChange={( kind ) => set( { kind } )}
						options={Com_Options( [ "all", "received", "sent", "moves" ] as const, T.history.filters ).map( ( o ) => ( { ...o, icon: UI_IconOf( FILTER_ICON[o.value] ) } ) )}
					/>
					<UI_Popover
						label={T.history.filterButton}
						className={"btn small filter-btn" + ( active.length ? " on" : "" )}
						trigger={<><SlidersHorizontal aria-hidden="true" />{T.history.filterButton}{active.length > 0 && <span className="filter-count">{active.length}</span>}</>}
					>
						<UI_ChipSet
							label={T.history.poolsLabel}
							options={POOLS.map( ( p ) => ( { value: p.pool, label: Com_PoolName( p.pool ), icon: <span className="from-dot" />, className: "chip-pool pool-" + p.pool } ) )}
							on={( p ) => query.pools.includes( p )}
							onPick={TogglePool}
						/>
						<UI_ChipSet
							label={T.history.statusLabel}
							options={Com_Options( [ "any", "waiting", "failed" ] as const, T.history.statuses ).map( ( o ) => ( { ...o, icon: UI_IconOf( STATUS_ICON[o.value] ) } ) )}
							on={( v ) => query.status === v}
							onPick={( status ) => set( { status } )}
						/>
						<UI_ChipSet
							label={T.history.category}
							options={[ { value: "any" as const, label: T.history.anyCategory }, ...categories.map( ( c ) => ( { value: c, label: T.history.categories[c] } ) ) ]}
							on={( v ) => query.category === v}
							onPick={( category ) => set( { category } )}
						/>
						<UI_ChipSet
							label={T.history.periodLabel}
							options={Com_Options( [ "any", "month", "days30", "year", "lastYear" ] as const, T.history.periods ).map( ( o ) => ( { ...o, icon: o.value === "any" ? undefined : <Calendar aria-hidden="true" /> } ) )}
							on={( v ) => query.period === v}
							onPick={( period ) => set( { period } )}
						/>
					</UI_Popover>
				</div>
			</div>
			{active.length > 0 && (
				<div className="history-active">
					{active.map( ( f ) => (
						<button key={f.key} className={"filter-chip on" + ( f.className ? " " + f.className : "" )} aria-label={T.history.removeFilter( f.label )} onClick={f.remove}>
							{f.label}<X aria-hidden="true" />
						</button>
					) )}
					<button className="link small" onClick={() => set( PANEL_OFF )}>{T.history.clearAll}</button>
				</div>
			)}
			</>}

			<div>{body}</div>

			<UI_TxSheet
				open={sheetOpen}
				onOpenChange={setSheetOpen}
				item={open && ( items?.find( ( i ) => i.txid === open.txid ) ?? open )}
				chainHeight={props.progress?.chainHeight ?? 0}
				onSendAgain={props.onSendAgain}
				onNoteSaved={() => void load.refetch()}
			/>
			<UI_ExportSheet open={exporting} onOpenChange={setExporting} walletId={props.walletId} account={props.account} />
		</div>
	);
}
