/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_home.tsx -- main window: sidebar with the switcher, and the open
// account's balance card, quick actions, pools, network and privacy

import { Fragment, ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownLeft, ArrowUpRight, Check, ChevronRight, Clock, Eye, EyeOff, FileKey, History, House, Lock, Pause, Pencil, Plus, ScanLine, Settings, ShieldAlert, ShieldCheck, SlidersHorizontal, WifiOff, ArrowRightLeft } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { KINDS, UI_FailedWallets, UI_SaveFailed } from "./ui_wallets";

import { addressKind_t, APP_VERSION, balance_t, Com_AllWallets, Com_FormatZec, Com_Split, Com_SyncState, Com_Unreachable, Com_ShownCards, commands, historyItem_t, homeCard_t, poolInfo_t, repeat_t, split_t, syncProgress_t, pool_t, Com_ShowCard, Com_PrivacyNote, Com_PoolsShown, Com_ReadPref, Com_WritePref, Com_IsBool, PREF_ALL_POOLS } from "./ui_local";
import { Com_NetworkName, Com_PoolName, T } from "./ui_text";
import { Com_List } from "./ui_locale";
import { useNow } from "./ui_hooks";
import { page_t, useCurrent, useStore } from "./ui_store";
import { SPRING, UI_Alert, UI_Amount, UI_Info, UI_Slots, UI_Spinner, UI_Tip, UI_Waiting } from "./ui_widgets";
import { Com_SyncLabel, UI_Logo, UI_SyncDot } from "./ui_chrome";
import { UI_BalanceChart } from "./ui_chart";
import { UI_DashboardSheet } from "./ui_dashboard";
import { UI_MoveSheet, UI_ShieldSheet } from "./ui_shield";
import { UI_SweepSheet } from "./ui_sweep";
import { UI_ScanSheet } from "./ui_scan";
import { UI_SyncSheet } from "./ui_sync";
import { UI_History } from "./ui_history";
import { UI_Toasts } from "./ui_toast";
import { UI_MigrateSheet } from "./ui_migrate";
import { UI_PoolBadge, UI_PoolGuide, UI_PoolSheet } from "./ui_pool";
import { Com_DraftFrom, EMPTY_DRAFT, sendDraft_t, UI_SendSheet } from "./ui_send";
import { UI_LowSpaceAlert } from "./ui_storage";
import { UI_Repeats, useRepeats } from "./ui_repeat";
import LEAF_SINGLE_SRC from "./assets/leaf-single-320.webp";
import { UI_NameSheet } from "./ui_sheets";
import { addWalletKind_t, UI_Switcher } from "./ui_switcher";
import { UI_Settings } from "./ui_settings";
import { UI_FundSheet, UI_ReceiveSheet } from "./ui_receive";

type sheet_t	= "none" | "receive" | "fund" | "send" | "shield" | "move" | "scan" | "sync" | "migrate" | "sweep";

type navItem_t = {
	label:		string;
	icon:		LucideIcon;
	page?:		page_t;			// opens a page
	sheet?:		sheet_t;		// or opens a sheet
	soon?:		boolean;		// or isn't built yet, and says so
};

const NAV: navItem_t[] = [
	{ label: T.nav.home,		icon: House,			page: "home" },
	{ label: T.nav.send,		icon: ArrowUpRight,		sheet: "send" },
	{ label: T.nav.receive,		icon: ArrowDownLeft,	sheet: "receive" },
	{ label: T.nav.history,		icon: History,			page: "history" },
	{ label: T.nav.settings,	icon: Settings,			page: "settings" },
];

type action_t = {
	label:		string;
	hint:		string;
	icon:		LucideIcon;
	sheet:		sheet_t;
};

const ACTIONS: action_t[] = [
	{ label: T.actions.send,	hint: T.actions.sendHint,		icon: ArrowUpRight,		sheet: "send" },
	{ label: T.actions.receive,	hint: T.actions.receiveHint,	icon: ArrowDownLeft,	sheet: "receive" },
	{ label: T.actions.shield,	hint: T.actions.shieldHint,		icon: ShieldCheck,		sheet: "shield" },
	{ label: T.actions.scan,	hint: T.actions.scanHint,		icon: ScanLine,			sheet: "scan" },
	{ label: T.actions.fund,	hint: T.actions.fundHint,		icon: Plus,				sheet: "fund" },		// on testnet, the faucet (UI_Actions)
];

const TRY_MIN_MSEC		= 900;		// "Trying…" stays at least this long, so a fast failure is still seen
const STILL_MSEC		= 2600;		// how long "Still offline" answers a try that failed


/*
==================
UI_Sidebar
==================
*/
function UI_Sidebar( props: {
	page:			page_t;
	onPage:			( p: page_t ) => void;
	onSheet:		( s: sheet_t ) => void;
	onAddWallet:	( kind: addWalletKind_t ) => void;
	onBackup:		( walletId: string ) => void;
} ) {
	const { wallet }	= useCurrent();
	const state			= Com_SyncState( wallet?.progress );
	const network		= useStore( ( s ) => s.network );

	return (
		<nav className="sidebar">
			<UI_Switcher onAddWallet={props.onAddWallet} onBackup={props.onBackup} onSweep={() => props.onSheet( "sweep" )} />

			<ul className="nav">
				{NAV.map( ( item ) => (
					<li key={item.label}>
						<button
							className={"nav-item" + ( item.page && item.page === props.page ? " active" : "" ) + ( item.soon ? " soon-item" : "" )}
							title={item.label}		// a narrow window shows only the icon
							disabled={item.soon && !item.sheet}
							onClick={() => item.page ? props.onPage( item.page ) : item.sheet && props.onSheet( item.sheet )}
						>
							<item.icon className="nav-icon" aria-hidden="true" />
							<span className="nav-label">{item.label}</span>
							{item.soon && <span className="soon">{T.common.soon}</span>}
						</button>
					</li>
				) )}
			</ul>

			<div className="sidebar-foot">
				{wallet && (
					<div className="foot-status">
						<UI_SyncDot state={state} />
						<span className="foot-text">
							<span className="foot-title">{Com_SyncLabel( state, wallet.progress )}</span>
							<span className="foot-sub">{T.sync.network( Com_NetworkName( network ) )}</span>
						</span>
					</div>
				)}
				<div className="foot-version">{T.common.version( APP_VERSION )}</div>
			</div>
		</nav>
	);
}

/*
==================
UI_SyncStatus

A capsule in the corner of the balance card. Offline, it says when the
next try is, and Try Now answers at once: "Trying…" while the engine
attempts, then either the wallet connects or it says "Still offline".
==================
*/
function UI_SyncStatus( props: { walletId: string; progress: syncProgress_t | undefined; onDetails: () => void } ) {
	const p		= props.progress;
	const state	= Com_SyncState( p );
	const now	= useNow( 1000 );

	const [ pressed, setPressed ]	= useState( false );
	const [ still, setStill ]		= useState( false );
	const pressedAt	= useRef( 0 );
	const latest	= useRef( state );
	latest.current	= state;

	// a press ends when the engine is no longer attempting, and not before TRY_MIN_MSEC
	useEffect( () => {
		if ( !pressed || p?.attempting ) {
			return;
		}
		const timer = setTimeout( () => {
			setPressed( false );
			setStill( latest.current === "offline" );
		}, Math.max( 0, TRY_MIN_MSEC - ( Date.now() - pressedAt.current ) ) );
		return () => clearTimeout( timer );
	}, [ pressed, p?.attempting ] );

	useEffect( () => {
		if ( !still ) {
			return;
		}
		const timer = setTimeout( () => setStill( false ), STILL_MSEC );
		return () => clearTimeout( timer );
	}, [ still ] );

	function TryNow() {
		pressedAt.current = Date.now();
		setStill( false );
		setPressed( true );
		commands.syncRetryF( props.walletId );
	}

	const trying = pressed || state === "retrying";

	switch ( state ) {
	case "offline":
	case "retrying": {
		const secs = p?.nextRetryAt ? Math.max( 0, Math.ceil( ( p.nextRetryAt - now ) / 1000 ) ) : 0;
		let detail;
		if ( trying ) {
			detail = <><UI_Waiting text={T.home.trying} size={11} /></>;
		} else if ( still ) {
			detail = T.home.stillOffline;
		} else {
			detail = T.home.nextTry( secs );
		}
		return (
			<div className="sync-status offline" role="status">
				<button className={"sync-status-cap" + ( still ? " shake" : "" )} onClick={props.onDetails}>
					<WifiOff className="sync-status-icon" aria-hidden="true" />
					{T.sync.offline}
					<span className="sync-status-sep" />
					<span className="sync-status-detail">{detail}</span>
				</button>
				<UI_Tip label={T.home.tryNowTip}>
					<button className="sync-status-btn" disabled={trying} onClick={TryNow}>
						{trying ? <UI_Spinner size={11} /> : null}{T.home.tryNow}
					</button>
				</UI_Tip>
				<UI_Info title={T.home.offlineTitle}>{T.home.offlineHint} {p?.error?.message}</UI_Info>
			</div>
		);
	}
	case "paused":
		return (
			<div className="sync-status paused" role="status">
				<button className="sync-status-cap" onClick={props.onDetails}><Pause className="sync-status-icon" aria-hidden="true" />{Com_SyncLabel( state, p )}</button>
				<button className="sync-status-btn" onClick={() => commands.syncResumeF( props.walletId )}>{T.sync.resume}</button>
			</div>
		);
	case "synced":
		return (
			<div className="sync-status done" role="status">
				<button className="sync-status-cap" onClick={props.onDetails}><Check className="sync-status-icon" aria-hidden="true" />{Com_SyncLabel( state, p )}</button>
			</div>
		);
	case "connecting":
	case "syncing":
		return (
			<div className="sync-status" role="status">
				<button className="sync-status-cap" onClick={props.onDetails}><UI_Spinner size={11} />{Com_SyncLabel( state, p )}</button>
			</div>
		);
	default:
		return Com_Unreachable( state );
	}
}

/*
==================
UI_Split

Under the total: private, public and pending, each with its share, so
where the money sits is plain at a glance. Shares hide with amounts.
Pending shows only while something is: "0.00 · 0.0%" pending said
nothing, and took a third of the card saying it. Private and public
stay at zero too: how much is public is a fact worth seeing. Until
the sync reaches today (synced false), money still being checked may
have been spent by a payment not found yet, and says so
==================
*/
export function UI_Split( props: { balance: balance_t | undefined; synced: boolean } ) {
	const hidden	= useStore( ( s ) => s.hideAmounts );
	const split		= props.balance ? Com_Split( props.balance ) : undefined;

	const share = ( n: number ) => {
		if ( !split || hidden ) {
			return "••";
		}
		return split.total > 0 ? `${( n / split.total * 100 ).toFixed( 1 )}%` : "0%";
	};

	const cols: { label: string; icon: LucideIcon; zats: number | undefined; arriving?: boolean }[] = [
		{ label: T.card.private,	icon: Lock,		zats: split?.private },
		{ label: T.card.public,		icon: Eye,		zats: split?.public },
		...( split && split.pending > 0 ? [ { label: T.card.pending, icon: Clock, zats: split.pending, arriving: true } ] : [] ),
	];

	return (
		<>
			<div className="split">
				{cols.map( ( c ) => (
					<div key={c.label} className={"split-col" + ( c.arriving ? " arriving" : "" )}>
						<div className="split-label"><c.icon aria-hidden="true" />{c.label}</div>
						<div className="split-amount"><UI_Amount zats={c.zats} unit /></div>
						<div className="split-share">{share( c.zats ?? 0 )}</div>
					</div>
				) )}
			</div>
			{!!split?.checking && (
				<p className="split-checking">
					<UI_Slots text={props.synced ? T.checking.card : T.checking.cardSyncing} slots={{ amount: <UI_Amount zats={split.checking} unit /> }} /> <UI_Info title={T.checking.infoTitle}>{props.synced ? T.checking.info : T.checking.infoSyncing}</UI_Info>
				</p>
			)}
		</>
	);
}

/*
==================
UI_Actions

The four things people come to a wallet to do, all the same shape. Ones
not built yet still answer when pressed, with what's coming.
==================
*/
function UI_Actions( props: { onSheet: ( s: sheet_t ) => void; split: split_t | undefined } ) {
	const network = useStore( ( s ) => s.network );
	const hidden = useStore( ( s ) => s.hideAmounts );

	const hint = ( a: action_t ) => {
		if ( a.sheet === "shield" && props.split && props.split.public > 0 && !hidden ) {
			return T.actions.shieldHintSome( Com_FormatZec( props.split.public ) );
		}
		return a.hint;
	};

	return (
		<section className="panel">
			<h2 className="panel-title">{T.actions.quick}</h2>
			<div className="actions">
				{ACTIONS.map( ( a ) => ( { ...a, hint: a.sheet === "fund" && network === "testnet" ? T.actions.fundHintTest : a.hint } ) ).map( ( a ) => (
					<button key={a.label} className="action" onClick={() => props.onSheet( a.sheet )}>
						<span className="action-circle"><a.icon aria-hidden="true" /></span>
						<span className="action-label">{a.label}</span>
						<span className="action-hint">{hint( a )}</span>
					</button>
				) )}
			</div>
		</section>
	);
}

/*
==================
UI_PoolRow

A pool, and the way into it (UI_PoolSheet): what it holds, what it is,
what can be done with it
==================
*/
function UI_PoolRow( props: { info: poolInfo_t; balance: balance_t | undefined; onOpen: () => void } ) {
	const info	= props.info;
	const pb	= props.balance?.[info.pool];
	const empty	= !pb || pb.confirmed + pb.pending === 0;

	return (
		<li>
			<button className={"pool-row pool-" + info.pool + ( empty ? " empty" : "" )} onClick={props.onOpen}>
				<UI_PoolBadge pool={info.pool} />
				<span className="pool-text">
					<span className="pool-name">{Com_PoolName( info.pool )}</span>
					<span className="pool-sub">{T.pools[info.pool]}</span>
				</span>
				<span className="pool-figures">
					<span className="pool-amount"><UI_Amount zats={pb?.confirmed} unit /></span>
					{pb && pb.pending > 0 && <span className="pool-pending"><UI_Amount zats={pb.pending} prefix="+" /> {T.home.pending}</span>}
				</span>
				<ChevronRight className="pool-go" aria-hidden="true" />
			</button>
		</li>
	);
}

/*
==================
UI_Pools

The pools that hold money, Ironwood always, in one grouped list; the
empty ones are named in a line, and Show All Pools lists them too (kept on
this computer). Its (i) is the guide to what pools are (UI_PoolGuide).
Each opens its toolbox (UI_PoolSheet).
==================
*/
function UI_Pools( props: { balance: balance_t | undefined; canMove: boolean; canReceive: boolean; onSend: ( from: pool_t ) => void; onMigrate: () => void; onMove: () => void; onShield: () => void; onReceive: ( side: addressKind_t ) => void } ) {
	const [ open, setOpen ] = useState< poolInfo_t | null >( null );
	const [ all, setAll ]	= useState( () => Com_ReadPref( PREF_ALL_POOLS, false, Com_IsBool ) );
	const pools = Com_PoolsShown( props.balance, all );

	function ShowAll( on: boolean ) {
		Com_WritePref( PREF_ALL_POOLS, on );
		setAll( on );
	}

	return (
		<section className="panel">
			<h2 className="panel-title">
				{T.home.pools} <UI_Info title={T.pools.guide.title}><UI_PoolGuide /></UI_Info>
			</h2>
			<ul className="pool-list">
				{pools.shown.map( ( info ) => <UI_PoolRow key={info.pool} info={info} balance={props.balance} onOpen={() => setOpen( info )} /> )}
			</ul>
			{pools.hidden.length > 0 && (
				<p className="hint pools-more">
					{T.pools.emptyHidden( Com_List( pools.hidden.map( ( p ) => Com_PoolName( p.pool ) ) ) )}{" · "}
					<button className="link" onClick={() => ShowAll( true )}>{T.pools.showAll}</button>
				</p>
			)}
			{all && <p className="hint pools-more"><button className="link" onClick={() => ShowAll( false )}>{T.pools.showFewer}</button></p>}
			<UI_PoolSheet
				open={open !== null}
				onOpenChange={( o ) => { if ( !o ) setOpen( null ); }}
				info={open}
				balance={props.balance}
				canMove={props.canMove}
				canReceive={props.canReceive}
				onSend={( from ) => { setOpen( null ); props.onSend( from ); }}
				onMigrate={() => { setOpen( null ); props.onMigrate(); }}
				onMove={() => { setOpen( null ); props.onMove(); }}
				onShield={() => { setOpen( null ); props.onShield(); }}
				onReceive={( side ) => { setOpen( null ); props.onReceive( side ); }}
			/>
		</section>
	);
}

/*
==================
UI_AllWallets

What every wallet holds, when there's more than one account to add up;
a row opens that wallet
==================
*/
function UI_AllWallets() {
	const wallets	= useStore( ( s ) => s.wallets );
	const order		= useStore( ( s ) => s.order );
	const select	= useStore( ( s ) => s.Select );
	const all		= Com_AllWallets( wallets, order );

	if ( order.reduce( ( n, id ) => n + ( wallets[id]?.accounts.length ?? 0 ), 0 ) < 2 ) {
		return null;
	}
	return (
		<section className="panel">
			<h2 className="panel-title">{T.home.allWallets} <UI_Info title={T.home.allWallets}>{T.home.allWalletsInfo}</UI_Info></h2>
			<div className="all-total">
				<span className="all-label">{T.home.yours}</span>
				<span className="all-amount"><UI_Amount zats={all.own} unit /></span>
			</div>
			{all.rows.some( ( r ) => r.viewOnly ) && (
				<div className="all-total">
					<span className="all-label">{T.home.watched}</span>
					<span className="all-row-amount"><UI_Amount zats={all.watched} unit /></span>
				</div>
			)}
			<ul className="pool-list">
				{all.rows.map( ( r ) => (
					<li key={r.id}>
						<button className="all-row" onClick={() => select( { walletId: r.id, account: 0 } )}>
							<span className="all-name">{r.name}{r.viewOnly && <span className="pill">{T.home.watched}</span>}</span>
							<span className="all-row-amount"><UI_Amount zats={r.zats} unit /></span>
						</button>
					</li>
				) )}
			</ul>
		</section>
	);
}

/*
==================
UI_NetworkPanel

Where this wallet stands with the Zcash network, in plain words
==================
*/
function UI_NetworkPanel( props: { progress: syncProgress_t | undefined; onDetails: () => void } ) {
	const network = useStore( ( s ) => s.network );
	const p		= props.progress;
	const state	= Com_SyncState( p );
	const pct	= state === "synced" ? 100 : p?.percent ?? 0;

	return (
		<section className="panel">
			<div className="panel-head">
				<h2 className="panel-title">{T.network.title}</h2>
				<button className="link small" onClick={props.onDetails}>{T.sync.details}</button>
			</div>
			<dl className="facts">
				<div className="fact">
					<dt>{T.network.status}</dt>
					<dd className={"fact-status " + state}><UI_SyncDot state={state} />{Com_SyncLabel( state, p )}</dd>
				</div>
				<div className="fact">
					<dt>{T.network.network}</dt>
					<dd>{Com_NetworkName( network )}</dd>
				</div>
				<div className="fact">
					<dt>{T.network.progress}</dt>
					<dd className="fact-progress">
						<span className="meter"><span className="meter-fill" style={{ width: `${pct}%` }} /></span>
						<span className="meter-num">{pct}%</span>
					</dd>
				</div>
			</dl>
			{state === "offline" && p?.error && <p className="network-why">{p.error.message}</p>}
		</section>
	);
}

/*
==================
UI_PrivacyCard

A word about this account's privacy, read from its balances, and the one
step it asks for: money in public view (Shield It), money arriving there
(shield it once it's here), nothing yet (an address), money in a retiring
pool (the move to Ironwood), or all private. Sapling is private: never
asked to move. Pools are one tap away (See Your Pools turns their card on)
==================
*/
function UI_PrivacyCard( props: { balance: balance_t | undefined; canMove: boolean; poolsShown: boolean; onSheet: ( s: sheet_t ) => void } ) {
	const setHome	= useStore( ( s ) => s.SetHome );
	const home		= useStore( ( s ) => s.home );
	if ( !props.balance ) {
		return null;
	}
	const note = Com_PrivacyNote( props.balance, props.canMove );

	let title, text, action = null, tone = "";
	switch ( note.kind ) {
	case "public":
		tone	= " warn";
		title	= T.privacy.publicTitle;
		text	= T.privacy.public( Com_FormatZec( note.zats ) );
		action	= <button className="btn primary" onClick={() => props.onSheet( "shield" )}><ShieldCheck aria-hidden="true" />{T.privacy.publicAction}</button>;
		break;
	case "arriving":
		tone	= " warn";
		title	= T.privacy.publicTitle;
		text	= T.privacy.arriving( Com_FormatZec( note.zats ) );
		break;
	case "empty":
		title	= T.privacy.emptyTitle;
		text	= T.privacy.empty;
		action	= <button className="btn primary" onClick={() => props.onSheet( "receive" )}><ArrowDownLeft aria-hidden="true" />{T.privacy.emptyAction}</button>;
		break;
	case "retiring":
		title	= T.privacy.retiringTitle;
		text	= T.privacy.retiring( Com_FormatZec( note.zats ) );
		action	= <button className="btn primary" onClick={() => props.onSheet( "migrate" )}><ArrowRightLeft aria-hidden="true" />{T.privacy.retiringAction}</button>;
		break;
	case "private":
		title	= T.privacy.allTitle;
		text	= T.privacy.all;
		break;
	default:
		return Com_Unreachable( note );
	}

	return (
		<section className={"privacy-card" + tone}>
			<img className="privacy-leaf" src={LEAF_SINGLE_SRC} alt="" draggable={false} />
			<div>
				<h2 className="privacy-title">{title}</h2>
				<p className="privacy-body">{text}</p>
				{action}
				{!props.poolsShown && <p className="hint"><button className="link" onClick={() => setHome( Com_ShowCard( home, "pools", true ) )}>{T.privacy.seePools}</button></p>}
			</div>
		</section>
	);
}

/*
==================
UI_Banner

Something the wallet needs from the person, above everything, with the
one button that does it. Stays until it's done.
==================
*/
function UI_Banner( props: { icon: ReactNode; title: string; body: string; action: string; onAction: () => void } ) {
	return (
		<div className="banner">
			<span className="banner-icon">{props.icon}</span>
			<div className="banner-text">
				<div className="banner-title">{props.title}</div>
				<div className="banner-body">{props.body}</div>
			</div>
			<button className="btn primary" onClick={props.onAction}>{props.action}</button>
		</div>
	);
}

/*
==================
UI_Home

Shows the account the switcher points at. Changing account slides the
numbers across, so it is obvious the view changed.
==================
*/
export function UI_Home( props: { onAddWallet: ( kind: addWalletKind_t ) => void; onBackup: ( walletId: string ) => void } ) {
	const { wallet, account }	= useCurrent();
	const loadError				= useStore( ( s ) => s.loadError );
	const failed				= useStore( ( s ) => s.failed );
	const refresh				= useStore( ( s ) => s.Refresh );
	const hidden				= useStore( ( s ) => s.hideAmounts );
	const toggleAmounts			= useStore( ( s ) => s.ToggleAmounts );
	const select				= useStore( ( s ) => s.Select );

	const [ renaming, setRenaming ]	= useState( false );
	const page		= useStore( ( s ) => s.page );
	const setPage	= useStore( ( s ) => s.Go );
	const [ sheet, setSheet ]		= useState< sheet_t >( "none" );
	const [ draft, setDraft ]		= useState< sendDraft_t >( EMPTY_DRAFT );		// survives a trip to Scan and back

	const home						= useStore( ( s ) => s.home );
	const repeatDue					= useRepeats().data?.some( ( r ) => r.due ) ?? false;
	const [ customizing, setCustomizing ] = useState( false );

	const [ receiveSide, setReceiveSide ] = useState< addressKind_t >( "private" );		// a pool opens Receive on its own side

	const key = `${wallet?.id}:${account?.index}`;
	// closed, every sheet leaves the next Receive on the private side, whichever way it opens
	const close = ( open: boolean ) => {
		if ( !open ) {
			setSheet( "none" );
			setReceiveSide( "private" );
		}
	};

	// each side card, by its name in the dashboard's layout
	function Card( c: homeCard_t ): ReactNode {
		switch ( c ) {
		case "repeats":	return <UI_Repeats onPay={PayRepeat} />;
		case "wallets":	return <UI_AllWallets />;
		case "network":	return wallet && <UI_NetworkPanel progress={wallet.progress} onDetails={() => setSheet( "sync" )} />;
		case "pools":	return <UI_Pools balance={account?.balance} canMove={wallet?.can.moveWithin ?? false} canReceive={wallet?.can.receive ?? false} onSend={SendFrom} onMigrate={() => setSheet( "migrate" )} onMove={() => setSheet( "move" )} onShield={() => setSheet( "shield" )} onReceive={( side ) => { setReceiveSide( side ); setSheet( "receive" ); }} />;
		case "privacy":	return <UI_PrivacyCard balance={account?.balance} canMove={wallet?.can.moveWithin ?? false} poolsShown={!home.hidden.includes( "pools" )} onSheet={setSheet} />;
		default:		return Com_Unreachable( c );
		}
	}

	// everything an account holds, to an address (moving out of a wallet): that
	// account becomes the current one, and Send opens with Max, to be reviewed
	// a repeating payment that's due: its account, and Send filled in, to be reviewed
	function PayRepeat( r: repeat_t ) {
		select( { walletId: r.walletId, account: r.account } );
		setDraft( { ...EMPTY_DRAFT, to: r.to, amount: Com_FormatZec( r.zats ), memo: r.memo ?? "", toLabel: r.label, repeatId: r.id } );
		setSheet( "send" );
	}

	function SendAll( walletId: string, index: number, to: string ) {
		select( { walletId: walletId, account: index } );
		setDraft( { ...EMPTY_DRAFT, to: to, max: true } );
		setSheet( "send" );
	}

	// a payment that didn't go through, as a new one to review: same person,
	// amount and memo, and a fresh quote (the fee and coins of today)
	function SendAgain( it: historyItem_t ) {
		setDraft( { ...EMPTY_DRAFT, to: it.counterparty ?? "", amount: Com_FormatZec( it.amount ), memo: it.memo ?? "" } );
		setSheet( "send" );
	}

	// a pool's own Send (UI_PoolSheet): Send with that pool chosen, so Max and the review use only it
	function SendFrom( from: pool_t ) {
		setDraft( Com_DraftFrom( from ) );
		setSheet( "send" );
	}

	let sheets = null;
	if ( wallet && account ) {
		sheets = (
			<>
				<UI_ReceiveSheet open={sheet === "receive"} onOpenChange={close} side={receiveSide} walletId={wallet.id} account={account.index} accountName={`${account.name} · ${wallet.name}`} onSweep={() => setSheet( "sweep" )} />
				<UI_FundSheet open={sheet === "fund"} onOpenChange={close} onReceive={() => setSheet( "receive" )} />
				<UI_SendSheet
					open={sheet === "send"}
					onOpenChange={close}
					walletId={wallet.id}
					account={account.index}
					balance={account.balance}
					offline={Com_SyncState( wallet.progress ) === "offline"}
					draft={draft}
					onDraft={setDraft}
					onScan={() => setSheet( "scan" )}
					onShield={() => setSheet( "shield" )}
				/>
				<UI_ShieldSheet
					open={sheet === "shield"}
					onOpenChange={close}
					walletId={wallet.id}
					account={account.index}
					heldZats={account.balance.transparent.confirmed}
					offline={Com_SyncState( wallet.progress ) === "offline"}
				/>
				<UI_MoveSheet
					open={sheet === "move"}
					onOpenChange={close}
					walletId={wallet.id}
					account={account.index}
					heldZats={account.balance.sapling.confirmed}
					offline={Com_SyncState( wallet.progress ) === "offline"}
				/>
				<UI_SweepSheet
					open={sheet === "sweep"}
					onOpenChange={close}
					walletId={wallet.id}
					account={account.index}
					accountName={`${account.name} · ${wallet.name}`}
					offline={Com_SyncState( wallet.progress ) === "offline"}
				/>
				<UI_ScanSheet
					open={sheet === "scan"}
					onOpenChange={close}
					onPay={( r ) => {
						// the request's memo travels with the payment; its message is for the payer to read, not to send back
						setDraft( { ...draft, to: r.address, amount: r.amount != null ? Com_FormatZec( r.amount ) : draft.amount, memo: r.memo ?? draft.memo, also: r.also, max: r.also.length ? false : draft.max } );
						setSheet( "send" );
					}}
				/>
				<UI_SyncSheet open={sheet === "sync"} onOpenChange={close} walletId={wallet.id} progress={wallet.progress} />
				<UI_MigrateSheet open={sheet === "migrate"} onOpenChange={close} walletId={wallet.id} account={account.index} />
				<UI_NameSheet
					open={renaming}
					onOpenChange={setRenaming}
					title={T.sheets.renameAccountTitle}
					initial={account.name}
					action={T.common.save}
					save={async ( name ) => { await commands.wRenameAccountF( wallet.id, account.index, name ); await refresh(); }}
				/>
			</>
		);
	}

	let body;
	switch ( page ) {
	case "settings":
		body = <UI_Settings actions={{ onBackup: props.onBackup, onAddWallet: props.onAddWallet, onSendAll: SendAll }} />;
		break;
	case "history":
		body = wallet && account
			? <UI_History walletId={wallet.id} account={account.index} total={account.balance.total} progress={wallet.progress} onReceive={() => setSheet( "receive" )} onSendAgain={SendAgain} />
			: null;
		break;
	case "home":
		body = (
			<div className="home">
				<UI_LowSpaceAlert />
				{/* a phrase nobody backed up is one broken disk from gone */}
				{wallet?.kind === "seed" && !wallet.backedUp && (
					<UI_Banner icon={<ShieldAlert aria-hidden="true" />} title={T.backup.bannerTitle} body={T.backup.banner} action={T.backup.bannerAction} onAction={() => props.onBackup( wallet.id )} />
				)}
				{/* zcashd keys hold money, but receive nothing: it's meant to move on */}
				{wallet?.kind === "key" && account && account.balance.total > 0 && (
					<UI_Banner icon={<FileKey aria-hidden="true" />} title={T.home.keyBannerTitle} body={T.home.keyBanner} action={T.home.keyBannerAction} onAction={() => setSheet( "send" )} />
				)}
				<AnimatePresence mode="wait" initial={false}>
					<motion.div key={key} className="home-grid" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={SPRING}>
						<div className="home-main">
							<section className="card-hero">
								<UI_Logo size={190} className="card-leaf" />
								<div className="card-top">
									<div className="card-who">
										<div className="account-head">
											<h1 className="account-name">{account?.name ?? "—"}</h1>
											{account && (
												<UI_Tip label={T.home.rename}>
													<button className="icon-btn" aria-label={T.home.rename} onClick={() => setRenaming( true )}>
														<Pencil aria-hidden="true" />
													</button>
												</UI_Tip>
											)}
											{wallet && KINDS[wallet.kind].badge && <span className="pill">{KINDS[wallet.kind].badge}</span>}
										</div>
										<p className="card-wallet">{wallet?.name}</p>
									</div>
									{wallet && <UI_SyncStatus walletId={wallet.id} progress={wallet.progress} onDetails={() => setSheet( "sync" )} />}
								</div>

								<div className="total-row">
									<h2 className="total"><UI_Amount zats={account?.balance.total} unit /></h2>
									<UI_Tip label={hidden ? T.actions.show : T.actions.hide}>
										<button className="icon-btn eye" aria-label={hidden ? T.actions.show : T.actions.hide} onClick={toggleAmounts}>
											{hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
										</button>
									</UI_Tip>
								</div>
								<UI_Split balance={account?.balance} synced={!!wallet?.progress?.complete} />
							</section>

							{wallet && <UI_Actions onSheet={setSheet} split={account ? Com_Split( account.balance ) : undefined} />}
							{wallet && account && home.chart && <UI_BalanceChart walletId={wallet.id} account={account.index} total={account.balance.total} progress={wallet.progress} />}
						</div>

						<aside className="home-side">
							{Com_ShownCards( home, repeatDue ? [ "repeats" ] : [] ).map( ( c ) => <Fragment key={c}>{Card( c )}</Fragment> )}
							<button className="link home-customize" onClick={() => setCustomizing( true )}>
								<SlidersHorizontal aria-hidden="true" /> {T.dashboard.customize}
							</button>
						</aside>
					</motion.div>
				</AnimatePresence>
			</div>
		);
		break;
	default:
		body = Com_Unreachable( page );
	}

	return (
		<div className="app">
			<UI_Sidebar page={page} onPage={setPage} onSheet={setSheet} onAddWallet={props.onAddWallet} onBackup={props.onBackup} />

			<main className="content">
				{loadError && <UI_Alert title={T.home.somethingWrong} message={loadError} action={T.common.tryAgain} onAction={refresh} />}
				{failed.length > 0 && <UI_FailedWallets failed={failed} />}
				{wallet?.saveError && <UI_SaveFailed wallet={wallet} error={wallet.saveError} />}
				{body}
			</main>
			<UI_DashboardSheet open={customizing} onOpenChange={setCustomizing} />

			{sheets}
			<UI_Toasts onOpen={( p ) => { select( { walletId: p.walletId, account: p.account } ); setPage( "history" ); }} />
		</div>
	);
}
