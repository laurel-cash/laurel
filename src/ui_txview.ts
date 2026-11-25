/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_txview.ts -- how one transaction reads, wherever it shows
//
// Its icon and title, its state in words (Com_TxStateView), and how deep
// it is in the chain (Com_Confirmations): decided once, for History's
// list, the detail sheet, Send's pending note and Home's pending count.

import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { blockEra_t, Com_FormatDate, Com_Unreachable, contact_t, historyItem_t, txKind_t, txState_t } from "./ui_local";
import { Com_PoolName, T } from "./ui_text";

export const KIND_ICON: Record< txKind_t, LucideIcon > = {
	received:	ArrowDownLeft,
	sent:		ArrowUpRight,
	shield:		ShieldCheck,
	move:		ArrowLeftRight,
};

/*
==================
Com_TxTitle
==================
*/
export function Com_TxTitle( it: historyItem_t ): string {
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
Com_TxStateView

How one transaction's state shows, decided once for the list, the
detail and the grouping: waiting ones lead under Pending; a failed one
keeps its day but says it didn't go through. note: the one line the
detail says under it. A pending payment's is its expiry, as a time, from
the blocks left and the network's block times at those heights
(Com_SecsBetween).
==================
*/
export type txStateView_t = { waiting: boolean; failed: boolean; pill: string | null; tone: "" | " pending" | " failed"; note: string | null };

export function Com_TxStateView( state: txState_t, chainHeight: number, eras: blockEra_t[], now: number, incoming = false ): txStateView_t {
	return { waiting: Com_Waiting( state ), failed: state.kind === "failed", ...Com_StateWords( state, chainHeight, eras, now, incoming ) };
}

// what a state says: its pill, its tone, and the line under it
function Com_StateWords( state: txState_t, chainHeight: number, eras: blockEra_t[], now: number, incoming: boolean ): Pick< txStateView_t, "pill" | "tone" | "note" > {
	switch ( state.kind ) {
	case "confirmed":
		return { pill: null, tone: "", note: null };
	case "pending": {
		// money coming in has nothing to send again, and nothing to cancel: its own words
		const words = incoming
			? { by: T.history.arrivesBy, now: T.history.arrivesNow, none: T.history.arrivesNone }
			: { by: T.history.expiresBy, now: T.history.expiresNow, none: T.history.noExpiry };
		let expiry: string = words.none;
		if ( state.expiresAt != null && chainHeight > 0 ) {
			const left = state.expiresAt - chainHeight;
			expiry = left > 0 ? words.by( Com_FormatDate( now + Com_SecsBetween( eras, chainHeight, state.expiresAt ), "time" ) ) : words.now;
		}
		return { pill: T.history.pending, tone: " pending", note: expiry };
	}
	case "unsent":
		return { pill: T.history.unsent, tone: " pending", note: T.history.unsentLong };
	case "failed":
		return { pill: T.history.failed, tone: " failed", note: T.history.failedLong };
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
Com_TxSign / Com_CanSendAgain / Com_CanSaveContact

What a line's amount did to the balance: in, out, or (a move, a shield,
one that didn't go through) neither. And whether to offer paying the
same again: a payment sent to someone, once it no longer waits. A
pending or unsent one may still go out, and sending it again would pay
twice.
==================
*/
export function Com_TxSign( it: historyItem_t ): "+" | "−" | "" {
	if ( it.state.kind === "failed" ) {
		return "";		// nothing moved
	}
	return it.kind === "received" ? "+" : it.kind === "sent" ? "−" : "";
}

export function Com_CanSendAgain( it: historyItem_t ): boolean {
	return it.kind === "sent" && it.counterparty !== null && !Com_Waiting( it.state );
}

// who was paid, kept as a contact: only someone not in the book yet
export function Com_CanSaveContact( it: historyItem_t, contact: contact_t | null ): boolean {
	return it.kind === "sent" && it.counterparty !== null && contact === null;
}

/*
==================
Com_Confirmations

How many blocks deep a confirmed transaction is: its own block counts as
the first. Null when there's nothing to count (not confirmed, or the
chain's height not known yet). A height the sync hasn't reached yet
(the tip seen before the block) is still one.
==================
*/
export function Com_Confirmations( state: txState_t, chainHeight: number ): number | null {
	if ( state.kind !== "confirmed" || chainHeight <= 0 ) {
		return null;
	}
	return Math.max( 1, chainHeight - state.height + 1 );
}

/*
==================
Com_WaitingCount

How many of an account's transactions still wait on the network: Home's
"2 pending"
==================
*/
export function Com_WaitingCount( items: readonly historyItem_t[] ): number {
	return items.filter( ( it ) => Com_Waiting( it.state ) ).length;
}

// still up to the network: it may yet go out, or come in (the view's waiting, without its words)
export function Com_Waiting( state: txState_t ): boolean {
	return state.kind === "pending" || state.kind === "unsent";
}
