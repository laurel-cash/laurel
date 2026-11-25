/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_pool.tsx -- one pool, opened from the dashboard: what it holds (ready,
// and arriving), its share of the account, what it is, who can see it, and
// what to do with it: shield public money, move Orchard or Sapling to
// Ironwood, receive into Ironwood or Sapling, and its lines in History.
// The public pool lists its addresses too, each with what it holds

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ArrowDownLeft, ArrowRightLeft, ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, History, Search, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { addressKind_t, balance_t, Com_Abbrev, Com_PoolAddress, Com_Unreachable, commands, pool_t, poolInfo_t, POOLS, publicHeld_t } from "./ui_local";
import { Com_PoolName, T } from "./ui_text";
import { KEYS } from "./ui_query";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_Amount, UI_CopyButton, UI_Sheet, UI_SheetButtons, UI_SheetClose, UI_Spinner } from "./ui_widgets";

/*
==================
Com_PoolShare

A pool's part of the account, in whole percent; under one percent but
not none says "<1", never a misleading 0
==================
*/
export function Com_PoolShare( held: number, total: number ): string {
	if ( held <= 0 || total <= 0 ) {
		return "0";
	}
	const pct = held / total * 100;
	return pct < 1 ? "<1" : String( Math.round( pct ) );
}

/*
==================
Com_PoolActions

Everything that can be done with a pool, in its order, each either ready
or with the reason it can't be right now. One decision for the sheet and
its test:
- Send: from money that's there. Public money is shielded first (Laurel's
  rule: w_send.rs, WERR_FROM_PUBLIC), unless Send From Public Money is on
  (Settings > Advanced), and even then Shield stays first; Orchard's is moved first (since NU6.3
  nothing new arrives there; what's left is migrated, not paid out).
- Receive: into the pools that still take new payments, when the wallet
  receives at all.
- Its own step: shield, migrate, or the move to Ironwood (offered, never
  urged: Sapling is private).
History is always ready, and last.
==================
*/
export type poolAct_t = "send" | "receive" | "shield" | "move" | "migrate" | "history";
export type poolAction_t = { act: poolAct_t; why: string | null };		// why: null when ready

export function Com_PoolActions( pool: pool_t, held: number, canMove: boolean, canReceive: boolean, publicOk = false ): poolAction_t[] {
	const name	= Com_PoolName( pool );
	const empty	= T.pools.tile.nothingIn( name );
	const has	= held > 0;
	const ready	= ( act: poolAct_t ): poolAction_t => ( { act: act, why: null } );
	const not	= ( act: poolAct_t, why: string ): poolAction_t => ( { act: act, why: why } );
	const receive = canReceive ? ready( "receive" ) : not( "receive", T.pools.tile.noReceive );
	const step = ( act: poolAct_t ) => !has ? not( act, empty ) : canMove ? ready( act ) : not( act, T.pools.tile.notThisWallet );

	let acts: poolAction_t[];
	switch ( pool ) {
	case "ironwood":	acts = [ has ? ready( "send" ) : not( "send", empty ), receive ]; break;
	case "sapling":		acts = [ has ? ready( "send" ) : not( "send", empty ), receive, step( "move" ) ]; break;
	case "orchard":		acts = [ step( "migrate" ), not( "send", T.pools.tile.moveFirst ), not( "receive", T.pools.tile.arrivesElsewhere ) ]; break;
	case "transparent":	acts = [ has ? ready( "shield" ) : not( "shield", empty ), !publicOk ? not( "send", T.pools.tile.shieldFirst ) : has ? ready( "send" ) : not( "send", empty ), receive ]; break;
	default:			return Com_Unreachable( pool );
	}
	return [ ...acts, ready( "history" ) ];
}

/*
==================
Com_PoolPrimary

The one action a pool's sheet lights up: the first ready one that takes
money somewhere good. Receiving into Ironwood is; receiving into Sapling
or the public pool never is, since new money belongs in Ironwood (it's
there for a payer who needs it, not urged). An empty Sapling or public
pool lights nothing
==================
*/
export function Com_PoolPrimary( pool: pool_t, actions: poolAction_t[] ): poolAct_t | null {
	const urged = ( a: poolAction_t ) => a.act !== "history" && ( a.act !== "receive" || pool === "ironwood" );
	return actions.find( ( a ) => a.why === null && urged( a ) )?.act ?? null;
}

/*
==================
Com_PoolIcon / UI_PoolBadge

A pool's mark, everywhere it's drawn: a shield for the private pools, an
eye for the public one, in the pool's own colour (pool-<name> in ui.css)
==================
*/
export function Com_PoolIcon( pool: pool_t ): LucideIcon {
	return POOLS.find( ( p ) => p.pool === pool )!.shielded ? ShieldCheck : Eye;
}

export function UI_PoolBadge( props: { pool: pool_t; small?: boolean } ) {
	const Icon = Com_PoolIcon( props.pool );
	return <span className={"pool-badge pool-" + props.pool + ( props.small ? " small" : "" )}><Icon aria-hidden="true" /></span>;
}

/*
==================
UI_PoolGuide

What the pools are, as four short lines, each with the pool's own badge:
the explanation behind every pool's (i). Ending with the one thing a
person needs to know: Laurel puts money where it belongs
==================
*/
export function UI_PoolGuide() {
	return (
		<div className="pool-guide">
			{POOLS.map( ( p ) => (
				<div key={p.pool} className="pool-guide-row">
					<UI_PoolBadge pool={p.pool} small />
					<span className="pool-guide-text">
						<span className="pool-guide-name">{Com_PoolName( p.pool )} <span className="pool-guide-tag">{T.pools[p.pool]}</span></span>
						<span className="pool-guide-fact">{T.pools.guide[p.pool]}</span>
					</span>
				</div>
			) )}
			<p className="pool-guide-end">{T.pools.guide.end}</p>
		</div>
	);
}

/*
==================
usePublicHeld / UI_PublicSpread / UI_PublicAddressesPanel

The public pool's addresses that hold money, each with what it holds.
Most people need none of it: Shield It takes them one at a time on its
own. So the pool says only how many there are (UI_PublicSpread), and the
list is a step away, in the pool's place in the same sheet: the largest
few first, all of them on asking, and a search once there are many. A
row opens to its whole address, Copy, and (with more than one) a Shield
of that address alone. Read again whenever the public balance changes.
==================
*/
const ADDRESSES_SHOWN = 5;

function usePublicHeld( walletId: string, account: number, held: number, enabled: boolean ) {
	return useQuery( {
		queryKey:	KEYS.publicAddresses( walletId, account, held ),
		queryFn:	() => commands.wPublicAddressesF( walletId, account ),
		enabled:	enabled,
	} );
}

/*
==================
Com_AddressHue / UI_AddressMark

A colour of each address's own, the same every time: a glance tells two
apart before their characters do. A picture, not a check: the address
itself is what's compared
==================
*/
export function Com_AddressHue( address: string ): number {
	let h = 2166136261;
	for ( let i = 0; i < address.length; i++ ) {
		h = Math.imul( h ^ address.charCodeAt( i ), 16777619 );
	}
	return ( h >>> 0 ) % 360;
}

export function UI_AddressMark( props: { address: string } ) {
	return <span className="address-mark" aria-hidden="true" style={{ "--hue": Com_AddressHue( props.address ) } as CSSProperties} />;
}

function UI_PublicSpread( props: { rows: publicHeld_t[]; onSee: () => void } ) {
	return (
		<button className="public-spread" onClick={props.onSee}>
			<span className="address-marks">
				{props.rows.slice( 0, 3 ).map( ( r ) => <UI_AddressMark key={r.address} address={r.address} /> )}
			</span>
			<span className="public-spread-text">{T.pools.addresses.spread( props.rows.length )}</span>
			<span className="public-spread-see">{T.pools.addresses.see( props.rows.length )}<ChevronRight aria-hidden="true" /></span>
		</button>
	);
}

function UI_PublicAddressesPanel( props: {
	rows:		publicHeld_t[] | undefined;
	error:		unknown;
	arriving:	boolean;
	onRetry:	() => void;
	onShield:	( from?: string ) => void;
	onBack?:	() => void;		// in the pool's place: back to the pool; its own sheet has its own close
} ) {
	const [ find, setFind ]		= useState( "" );
	const [ all, setAll ]		= useState( false );
	const [ opened, setOpened ]	= useState< string | null >( null );
	const rows		= props.rows ?? [];
	const many		= rows.length > 1;
	const needle	= find.trim().toLowerCase();
	const found		= needle ? rows.filter( ( r ) => r.address.toLowerCase().includes( needle ) ) : rows;
	const shown		= all || needle ? found : found.slice( 0, ADDRESSES_SHOWN );

	let list;
	if ( props.error ) {
		list = <p className="hint" role="alert">{T.pools.addresses.cantRead} <button className="link" onClick={props.onRetry}>{T.common.tryAgain}</button></p>;
	} else if ( !props.rows ) {
		list = <UI_Spinner size={16} />;
	} else {
		list = (
			<>
				{rows.length > ADDRESSES_SHOWN && (
					<label className="history-search public-find">
						<Search aria-hidden="true" />
						<input value={find} placeholder={T.pools.addresses.find} aria-label={T.pools.addresses.find} spellCheck={false} onChange={( e ) => setFind( e.target.value )} />
					</label>
				)}
				<ul className="public-list">
					{shown.map( ( r ) => {
						const open = opened === r.address;
						return (
							<li key={r.address} className={"public-row" + ( open ? " open" : "" )}>
								<button className="public-row-head" aria-expanded={open} onClick={() => setOpened( open ? null : r.address )}>
									<UI_AddressMark address={r.address} />
									<span className="public-row-text">
										<span className="public-row-zats"><UI_Amount zats={r.zats} unit /></span>
										<span className="public-row-code">{Com_Abbrev( r.address, 8 )}</span>
									</span>
									<ChevronDown aria-hidden="true" className="public-row-chevron" />
								</button>
								{open && (
									<div className="public-row-body">
										<p className="public-row-full">{r.address}</p>
										<div className="public-row-actions">
											<UI_CopyButton text={r.address} />
											{many && (
												<button className="btn small" onClick={() => props.onShield( r.address )}>
													<ShieldCheck aria-hidden="true" />{T.pools.addresses.shieldOne}
												</button>
											)}
										</div>
									</div>
								)}
							</li>
						);
					} )}
				</ul>
				{found.length === 0 && <p className="hint">{T.pools.addresses.noMatch}</p>}
				{!all && !needle && found.length > ADDRESSES_SHOWN && (
					<button className="link public-all" onClick={() => setAll( true )}>{T.pools.addresses.showAll( found.length )}</button>
				)}
			</>
		);
	}

	return (
		<div className="public-panel">
			{props.onBack && <button className="nav-back" onClick={props.onBack}><ChevronLeft aria-hidden="true" />{T.pools.addresses.back}</button>}
			{list}
			{props.arriving && <p className="hint">{T.pools.addresses.arriving}</p>}
			<UI_SheetButtons busy={false} action={{ label: T.pools.shield, onRun: () => props.onShield(), icon: <ShieldCheck aria-hidden="true" /> }} />
		</div>
	);
}

// the list's words over it: one address, or several kept apart
function Com_AddressesLede( rows: publicHeld_t[] | undefined ): string {
	return ( rows?.length ?? 0 ) > 1 ? T.pools.addresses.many : T.pools.addresses.one;
}

/*
==================
UI_PublicAddressesSheet

The same list in a sheet of its own, straight from Home (the public
money's card), for whoever never opens the pools
==================
*/
export function UI_PublicAddressesSheet( props: sheetProps_t & { walletId: string; account: number; held: number; arriving: boolean; onShield: ( from?: string ) => void } ) {
	const addresses = usePublicHeld( props.walletId, props.account, props.held, props.open );
	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.pools.addresses.title} description={Com_AddressesLede( addresses.data )}>
			<UI_PublicAddressesPanel
				rows={addresses.data}
				error={addresses.error}
				arriving={props.arriving}
				onRetry={() => void addresses.refetch()}
				onShield={props.onShield}
			/>
		</UI_Sheet>
	);
}

/*
==================
UI_PoolAction

One way to act on a pool: the lit one (main) a wide button, the others a
row of the list. Without onClick it can't be done now, and its line says why
==================
*/
function UI_PoolAction( props: { icon: ReactNode; title: string; sub: string; onClick?: () => void; main?: boolean } ) {
	const kind = props.main ? "pool-main" : "action-row";
	const inner = (
		<>
			<span className="action-icon">{props.icon}</span>
			<span className="action-text">
				<span className="action-title">{props.title}</span>
				<span className="action-sub">{props.sub}</span>
			</span>
			{props.onClick && <ChevronRight aria-hidden="true" className="action-go" />}
		</>
	);
	return props.onClick
		? <button className={kind} onClick={props.onClick}>{inner}</button>
		: <div className={kind + " muted"}>{inner}</div>;
}

/*
==================
UI_PoolSheet
==================
*/
export function UI_PoolSheet( props: sheetProps_t & {
	info:		poolInfo_t | null;
	balance:	balance_t | undefined;
	canMove:	boolean;		// a wallet that can sign and whose private pool is backed up (W_Mover)
	canReceive:	boolean;		// walletCan_t.receive: a zcashd-key wallet doesn't
	publicOk?:	boolean;		// Send From Public Money is on (Settings > Advanced)
	walletId:	string;
	account:	number;
	onSend:		( from: pool_t ) => void;		// Send, paying from this pool only
	onMigrate:	() => void;
	onMove:		() => void;
	onShield:	( from?: string ) => void;		// from: one public address (its row), or Laurel's pick
	onReceive:	( side: addressKind_t ) => void;
} ) {
	const goHistory = useStore( ( s ) => s.GoHistory );
	const info = props.info;

	// the public pool's addresses: counted here, listed in the pool's place
	const [ listing, setListing ] = useState( false );
	const publicHeld	= props.balance?.transparent.confirmed ?? 0;
	const addresses		= usePublicHeld( props.walletId, props.account, publicHeld, props.open && info?.pool === "transparent" && publicHeld > 0 );
	useEffect( () => {
		setListing( false );
	}, [ props.open, info?.pool ] );

	if ( !info ) {
		return null;
	}
	const pb		= props.balance?.[info.pool];
	const held		= pb?.confirmed ?? 0;
	const total		= props.balance?.total ?? 0;
	const share		= Com_PoolShare( held + ( pb?.pending ?? 0 ), total );
	const Badge		= Com_PoolIcon( info.pool );

	// every way to act on this pool: the lit one a wide button of its own, the
	// rest one list under it, however many; ready ones press, the rest say why not
	const actions	= Com_PoolActions( info.pool, held, props.canMove, props.canReceive, props.publicOk === true );
	const primary	= Com_PoolPrimary( info.pool, actions );
	const side		= Com_PoolAddress( info.pool );
	const Describe = ( a: poolAction_t ): { icon: ReactNode; title: string; sub: string; onClick?: () => void } => {
		const run = ( fn: () => void ) => a.why === null ? fn : undefined;
		const sub = ( ready: string ) => a.why ?? ready;
		switch ( a.act ) {
		case "send":	return { icon: <ArrowUpRight aria-hidden="true" />, title: T.pools.sendFrom( Com_PoolName( info.pool ) ), sub: sub( T.pools.tile.send( Com_PoolName( info.pool ) ) ), onClick: run( () => props.onSend( info.pool ) ) };
		case "receive":	return { icon: <ArrowDownLeft aria-hidden="true" />, title: T.pools.receiveTitle, sub: sub( side === "sapling" ? T.pools.tile.receiveSapling : side === "public" ? T.pools.tile.receivePublic : T.pools.tile.receivePrivate ), onClick: side ? run( () => props.onReceive( side ) ) : undefined };
		case "shield":	return { icon: <ShieldCheck aria-hidden="true" />, title: T.pools.shield, sub: sub( T.pools.tile.shield ), onClick: run( () => props.onShield() ) };
		case "move":	return { icon: <ArrowRightLeft aria-hidden="true" />, title: T.pools.moveSapling, sub: sub( T.pools.tile.move ), onClick: run( props.onMove ) };
		case "migrate":	return { icon: <ArrowRightLeft aria-hidden="true" />, title: T.migrate.button, sub: sub( T.pools.tile.move ), onClick: run( props.onMigrate ) };
		case "history":	return { icon: <History aria-hidden="true" />, title: T.pools.history, sub: T.pools.tile.history, onClick: () => { props.onOpenChange( false ); goHistory( { pools: [ info.pool ] } ); } };
		default:		return Com_Unreachable( a.act );
		}
	};
	const lit	= actions.find( ( a ) => a.act === primary );
	const rest	= actions.filter( ( a ) => a.act !== primary );

	return (
		<UI_Sheet
			open={props.open}
			onOpenChange={props.onOpenChange}
			title={listing ? T.pools.addresses.title : Com_PoolName( info.pool )}
			description={listing ? Com_AddressesLede( addresses.data ) : T.pools[info.pool]}
			hero={listing ? undefined : <div className={"pool-hero pool-" + info.pool}><span className="pool-hero-badge"><Badge aria-hidden="true" /></span></div>}
			className="sheet-pool"
		>
			{listing ? (
				<UI_PublicAddressesPanel
					rows={addresses.data}
					error={addresses.error}
					arriving={( pb?.pending ?? 0 ) > 0}
					onRetry={() => void addresses.refetch()}
					onShield={props.onShield}
					onBack={() => setListing( false )}
				/>
			) : <>
			<div className={"pool-sheet-amount pool-" + info.pool}>
				<span className="pool-sheet-total"><UI_Amount zats={held} unit /></span>
				<span className="pool-sheet-sub">
					{pb && pb.pending > 0
						? <><UI_Amount zats={pb.pending} unit /> {T.pools.arriving}</>
						: T.pools.ready}
				</span>
				<span className="pool-share" aria-label={T.pools.shareOf( share )}>
					<span className="pool-share-bar"><span style={{ width: share === "<1" ? "1%" : `${share}%` }} /></span>
					<span className="pool-share-text">{T.pools.shareOf( share )}</span>
				</span>
			</div>

			<p className="pool-about">{T.pools.about[info.pool]}</p>
			<div className={"pool-fact" + ( info.shielded ? "" : " public" )}>
				{info.shielded ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
				<span>{info.shielded ? T.pools.hidden : T.pools.visible}</span>
			</div>

			{info.pool === "transparent" && !!addresses.data?.length && (
				<UI_PublicSpread rows={addresses.data} onSee={() => setListing( true )} />
			)}

			<div className="pool-actions">
				{lit && <UI_PoolAction main {...Describe( lit )} />}
				<ul className="action-list">
					{rest.map( ( a ) => <li key={a.act}><UI_PoolAction {...Describe( a )} /></li> )}
				</ul>
			</div>
			<UI_SheetClose onClose={() => props.onOpenChange( false )} />
			</>}
		</UI_Sheet>
	);
}
