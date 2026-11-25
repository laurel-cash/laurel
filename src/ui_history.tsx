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
import { ArrowDownLeft, Calendar, CircleX, Clock, Download, History, List, Search, SearchX, SlidersHorizontal, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Com_Abbrev, Com_FormatDate, Com_FormatZec, Com_Options, Com_SyncState, Com_Unreachable, commands, historyItem_t, pool_t, POOLS, syncProgress_t, txCategory_t } from "./ui_local";
import { useStore } from "./ui_store";
import { Com_PoolName, T } from "./ui_text";
import { Com_List } from "./ui_locale";
import { useQuery } from "@tanstack/react-query";
import { Com_TxSign, Com_TxStateView, Com_TxTitle, Com_Waiting, KIND_ICON } from "./ui_txview";
import { UI_TxSheet } from "./ui_txsheet";
import { KEYS } from "./ui_query";
import { sheetProps_t, UI_Alert, UI_Amount, UI_ChipSet, UI_Empty, UI_LoadFailed, UI_Popover, UI_Segmented, UI_Sheet, UI_SheetButtons, UI_SheetClose, UI_Spinner, UI_Switch } from "./ui_widgets";
import { useAction } from "./ui_hooks";

export type historyFilter_t = "all" | "received" | "sent" | "moves";
export type statusFilter_t = "any" | "waiting" | "failed";
export type period_t = "any" | "month" | "days30" | "year" | "lastYear";

// every filter of the page, together: a new one is one more field, not one more argument everywhere
export type historyQuery_t = { kind: historyFilter_t; status: statusFilter_t; period: period_t; category: txCategory_t | "any"; pools: pool_t[]; text: string };
export const NO_QUERY: historyQuery_t = { kind: "all", status: "any", period: "any", category: "any", pools: [], text: "" };

const DAY_SECS = 86400;

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
Com_GroupByDay

Lines already newest first, in runs of one day each. What waits on the
network has no day yet and leads, under Pending.
==================
*/
export function Com_GroupByDay( items: historyItem_t[], now: number ): { label: string; items: historyItem_t[] }[] {
	const groups: { label: string; items: historyItem_t[] }[] = [];
	for ( const it of items ) {
		const label = Com_Waiting( it.state ) ? T.history.pending : Com_DayLabel( it.time, now );
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
UI_TxRow
==================
*/
function UI_TxRow( props: { item: historyItem_t; onOpen: () => void } ) {
	const it = props.item;
	const Icon = KIND_ICON[it.kind];
	const view = Com_TxStateView( it.state, 0, [], 0 );
	const sign = Com_TxSign( it );
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

// the Filters panel's own filters, all off; the kind and the search are the
// bar's own, in plain view, and Clear All leaves them as they are
const PANEL_OFF: Partial< historyQuery_t > = { pools: [], status: "any", category: "any", period: "any" };

/*
==================
UI_HistoryFilters

The bar over the list: the search, the kind, and the Filters panel; then
the panel's filters that are on, each a chip that takes itself off, and
Clear All for all of them
==================
*/
function UI_HistoryFilters( props: { query: historyQuery_t; set: ( patch: Partial< historyQuery_t > ) => void } ) {
	const { query, set }	= props;
	const categories		= useStore( ( s ) => s.constants )?.categories ?? [];

	function TogglePool( p: pool_t ) {
		set( { pools: query.pools.includes( p ) ? query.pools.filter( ( x ) => x !== p ) : [ ...query.pools, p ] } );
	}

	const active: { key: string; label: string; className?: string; remove: () => void }[] = [
		...query.pools.map( ( p ) => ( { key: p, label: Com_PoolName( p ), className: "chip-pool pool-" + p, remove: () => TogglePool( p ) } ) ),
		...( query.status !== "any" ? [ { key: "status", label: T.history.statuses[query.status], remove: () => set( { status: "any" } ) } ] : [] ),
		...( query.category !== "any" ? [ { key: "category", label: T.history.categories[query.category], remove: () => set( { category: "any" } ) } ] : [] ),
		...( query.period !== "any" ? [ { key: "period", label: T.history.periods[query.period], remove: () => set( { period: "any" } ) } ] : [] ),
	];

	return (
		<>
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
		</>
	);
}

/*
==================
UI_HistoryList

What the list shows: why it can't load, that it's loading, that there
is nothing yet (and how to receive), that nothing matches (and how to
clear), or the lines, by day
==================
*/
function UI_HistoryList( props: {
	items:		historyItem_t[] | null;
	shown:		historyItem_t[];
	error:		unknown;
	onRetry:	() => void;
	onReceive:	() => void;
	onClear:	() => void;
	onOpen:		( it: historyItem_t ) => void;
} ) {
	const groups = useMemo( () => Com_GroupByDay( props.shown, Math.floor( Date.now() / 1000 ) ), [ props.shown ] );

	if ( props.error ) {
		return <UI_LoadFailed title={T.history.cantLoad} error={props.error} onRetry={props.onRetry} />;
	}
	if ( !props.items ) {
		return <UI_Empty><UI_Spinner size={18} /></UI_Empty>;
	}
	if ( !props.items.length ) {
		return (
			<UI_Empty icon={<History aria-hidden="true" />} title={T.history.emptyTitle} text={T.history.empty}>
				<button className="btn primary" onClick={props.onReceive}><ArrowDownLeft aria-hidden="true" />{T.privacy.emptyAction}</button>
			</UI_Empty>
		);
	}
	if ( !props.shown.length ) {
		return (
			<UI_Empty icon={<SearchX aria-hidden="true" />} tone="quiet" title={T.history.noMatchTitle} text={T.history.noMatch}>
				<button className="btn" onClick={props.onClear}>{T.history.clear}</button>
			</UI_Empty>
		);
	}
	return groups.map( ( g ) => (
		<section key={g.label} className="tx-group">
			<h2 className="tx-day">{g.label}</h2>
			<ul className="pool-list tx-list">
				{g.items.map( ( it ) => <UI_TxRow key={it.txid} item={it} onOpen={() => props.onOpen( it )} /> )}
			</ul>
		</section>
	) );
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

	const start						= useStore( ( s ) => s.historyStart );		// opened from a pool, or from what waits: those lines only
	const [ query, setQuery ]		= useState< historyQuery_t >( () => ( { ...NO_QUERY, ...start } ) );
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

	return (
		<div className="history">
			<div className="history-head">
				<h1 className="page-title">{T.history.title}</h1>
				{!!items?.length && <button className="btn small" onClick={() => setExporting( true )}><Download aria-hidden="true" />{T.history.export}</button>}
			</div>
			{state !== "synced" && <p className="chart-note">{T.history.syncing}</p>}

			{!!items?.length && <UI_HistoryFilters query={query} set={set} />}

			<div>
				<UI_HistoryList
					items={items}
					shown={shown}
					error={load.error}
					onRetry={() => void load.refetch()}
					onReceive={props.onReceive}
					onClear={() => setQuery( NO_QUERY )}
					onOpen={( it ) => { setOpen( it ); setSheetOpen( true ); }}
				/>
			</div>

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
