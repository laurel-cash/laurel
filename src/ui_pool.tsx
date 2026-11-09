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
// Ironwood, receive into Ironwood or Sapling, and its lines in History

import { ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Eye, EyeOff, History, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { addressKind_t, balance_t, Com_PoolAddress, Com_Unreachable, pool_t, poolInfo_t, POOLS } from "./ui_local";
import { Com_PoolName, T } from "./ui_text";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_ActionTile, UI_Amount, UI_Sheet, UI_SheetClose } from "./ui_widgets";

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
  rule: w_send.rs, WERR_FROM_PUBLIC); Orchard's is moved first (since NU6.3
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

export function Com_PoolActions( pool: pool_t, held: number, canMove: boolean, canReceive: boolean ): poolAction_t[] {
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
	case "transparent":	acts = [ has ? ready( "shield" ) : not( "shield", empty ), not( "send", T.pools.tile.shieldFirst ), receive ]; break;
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
UI_PoolSheet
==================
*/
export function UI_PoolSheet( props: sheetProps_t & {
	info:		poolInfo_t | null;
	balance:	balance_t | undefined;
	canMove:	boolean;		// a wallet that can sign and whose private pool is backed up (W_Mover)
	canReceive:	boolean;		// walletCan_t.receive: a zcashd-key wallet doesn't
	onSend:		( from: pool_t ) => void;		// Send, paying from this pool only
	onMigrate:	() => void;
	onMove:		() => void;
	onShield:	() => void;
	onReceive:	( side: addressKind_t ) => void;
} ) {
	const goHistory = useStore( ( s ) => s.GoHistory );
	const info = props.info;
	if ( !info ) {
		return null;
	}
	const pb		= props.balance?.[info.pool];
	const held		= pb?.confirmed ?? 0;
	const total		= props.balance?.total ?? 0;
	const share		= Com_PoolShare( held + ( pb?.pending ?? 0 ), total );
	const Badge		= Com_PoolIcon( info.pool );

	// every way to act on this pool, as tiles: ready ones press, the rest say why not
	const actions	= Com_PoolActions( info.pool, held, props.canMove, props.canReceive );
	const primary	= Com_PoolPrimary( info.pool, actions );
	const side		= Com_PoolAddress( info.pool );
	const Tile = ( a: poolAction_t ) => {
		const run = ( fn: () => void ) => a.why === null ? fn : undefined;
		const sub = ( ready: string ) => a.why ?? ready;
		const common = { key: a.act, primary: a.act === primary };
		switch ( a.act ) {
		case "send":	return <UI_ActionTile {...common} icon={<ArrowUpRight aria-hidden="true" />} title={T.pools.sendFrom( Com_PoolName( info.pool ) )} sub={sub( T.pools.tile.send( Com_PoolName( info.pool ) ) )} onClick={run( () => props.onSend( info.pool ) )} />;
		case "receive":	return <UI_ActionTile {...common} icon={<ArrowDownLeft aria-hidden="true" />} title={T.pools.receiveTitle} sub={sub( side === "sapling" ? T.pools.tile.receiveSapling : side === "public" ? T.pools.tile.receivePublic : T.pools.tile.receivePrivate )} onClick={side ? run( () => props.onReceive( side ) ) : undefined} />;
		case "shield":	return <UI_ActionTile {...common} icon={<ShieldCheck aria-hidden="true" />} title={T.pools.shield} sub={sub( T.pools.tile.shield )} onClick={run( props.onShield )} />;
		case "move":	return <UI_ActionTile {...common} icon={<ArrowRightLeft aria-hidden="true" />} title={T.pools.moveSapling} sub={sub( T.pools.tile.move )} onClick={run( props.onMove )} />;
		case "migrate":	return <UI_ActionTile {...common} icon={<ArrowRightLeft aria-hidden="true" />} title={T.migrate.button} sub={sub( T.pools.tile.move )} onClick={run( props.onMigrate )} />;
		case "history":	return <UI_ActionTile {...common} icon={<History aria-hidden="true" />} title={T.pools.history} sub={T.pools.tile.history} onClick={() => { props.onOpenChange( false ); goHistory( [ info.pool ] ); }} />;
		default:		return Com_Unreachable( a.act );
		}
	};

	return (
		<UI_Sheet
			open={props.open}
			onOpenChange={props.onOpenChange}
			title={Com_PoolName( info.pool )}
			description={T.pools[info.pool]}
			hero={<div className={"pool-hero pool-" + info.pool}><span className="pool-hero-badge"><Badge aria-hidden="true" /></span></div>}
			className="sheet-pool"
		>
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

			<div className="tile-grid">
				{actions.map( Tile )}
			</div>
			<UI_SheetClose onClose={() => props.onOpenChange( false )} />
		</UI_Sheet>
	);
}
