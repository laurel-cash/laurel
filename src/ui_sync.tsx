/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_sync.tsx -- what sync is doing, in dates and one sentence
//
// A progress ring, the stretch of time being checked (the wallet's first
// day to today), one sentence, what it keeps on disk, and Pause. Every
// number is the engine's; this file only words them.

import { Pause, Play, ShieldCheck } from "lucide-react";

import { commands, Com_FormatBytes, Com_FormatDate, Com_SyncState, Com_Unreachable, syncProgress_t, syncState_t } from "./ui_local";
import { useStore } from "./ui_store";
import { T } from "./ui_text";
import { useAction } from "./ui_hooks";
import { sheetProps_t, UI_Alert, UI_Info, UI_Sheet, UI_SheetClose, UI_Spinner } from "./ui_widgets";
import { UI_Logo } from "./ui_chrome";
import { useStorage } from "./ui_storage";

const RING_SIZE		= 132;
const RING_STROKE	= 10;


/*
==================
Com_SyncWords

The title and sentence for each state
==================
*/
function Com_SyncWords( state: syncState_t, p: syncProgress_t | undefined ): { title: string; text: string } {
	const from = p?.birthdayTime ? Com_FormatDate( p.birthdayTime ) : T.sync.fromBirthday;

	switch ( state ) {
	case "syncing":		return { title: T.sync.titleSyncing,	text: p?.repairing ? T.sync.repairingText( from ) : T.sync.syncingText( from ) };
	case "synced":		return { title: T.sync.titleSynced,		text: T.sync.syncedText( from ) };
	case "paused":		return { title: T.sync.titlePaused,		text: T.sync.pausedText };
	case "offline":		return { title: T.sync.titleOffline,	text: p?.error?.message ?? T.sync.offlineText };
	case "retrying":	return { title: T.sync.titleOffline,	text: T.sync.retrying };
	case "connecting":	return { title: T.sync.titleConnecting,	text: T.sync.connectingText };
	default:			return Com_Unreachable( state );
	}
}

/*
==================
UI_Ring

A progress ring with the leaf in the middle
==================
*/
function UI_Ring( props: { percent: number; state: syncState_t } ) {
	const r		= ( RING_SIZE - RING_STROKE ) / 2;
	const len	= 2 * Math.PI * r;

	return (
		<div className={"sync-ring " + props.state} style={{ width: RING_SIZE, height: RING_SIZE }}>
			<svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
				<circle className="ring-track" cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={r} strokeWidth={RING_STROKE} />
				<circle
					className="ring-fill"
					cx={RING_SIZE / 2}
					cy={RING_SIZE / 2}
					r={r}
					strokeWidth={RING_STROKE}
					strokeDasharray={len}
					strokeDashoffset={len * ( 1 - props.percent / 100 )}
					transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
				/>
			</svg>
			<span className="ring-center">
				<UI_Logo size={40} />
				<span className="ring-percent">{props.percent}%</span>
			</span>
		</div>
	);
}

/*
==================
usePayable / UI_CatchingUp

A payment is built only on a wallet that has caught up: every block
scanned, and within a few blocks of the server's tip (Sync_RequireCaughtUp,
E_Fenced). The engine states that as its progress's `complete` ("synced"),
so a payment sheet reads it, never the refusal it would get by asking:
until then it asks the engine nothing and shows UI_CatchingUp, the ring and
what it waits for, and says it's safe to close. It goes on by itself once
the wallet has caught up. Asked anyway, sheets once waited behind a spinner
with no button, then called the refusal an error.
==================
*/
export function usePayable( walletId: string ): boolean {
	return useStore( ( s ) => Com_SyncState( s.wallets[walletId]?.progress ) === "synced" );
}

export function UI_CatchingUp( props: { walletId: string } ) {
	const p			= useStore( ( s ) => s.wallets[props.walletId]?.progress );
	const state		= Com_SyncState( p );
	const resume	= useAction( () => commands.syncResumeF( props.walletId ) );

	let text: string;
	switch ( state ) {
	case "syncing":
	case "connecting":
	case "synced":		text = T.catchUp.syncing; break;		// synced: for the moment before the sheet moves on
	case "paused":		text = T.catchUp.paused; break;
	case "offline":
	case "retrying":	text = T.catchUp.offline; break;
	default:			text = Com_Unreachable( state );
	}

	return (
		<div className="sync-sheet">
			<UI_Ring percent={p?.percent ?? 0} state={state} />
			<h3 className="sync-title">{T.catchUp.title}</h3>
			<p className="sync-text">{text}</p>
			{state === "syncing" && p?.etaSecs != null && <p className="sync-eta">{T.sync.eta( p.etaSecs )}</p>}
			{state === "paused" && (
				<button className="btn" disabled={resume.busy} onClick={() => void resume.run()}>
					{resume.busy ? <UI_Spinner size={13} /> : <Play aria-hidden="true" />}{T.catchUp.resume}
				</button>
			)}
			{resume.error && <UI_Alert title={T.sync.failed} message={resume.error} />}
			<div className="info-note"><ShieldCheck aria-hidden="true" /><span>{T.catchUp.safe}</span></div>
		</div>
	);
}

/*
==================
UI_SyncSheet
==================
*/
export function UI_SyncSheet( props: sheetProps_t & { walletId: string; progress: syncProgress_t | undefined } ) {
	const p			= props.progress;
	const state		= Com_SyncState( p );
	const words		= Com_SyncWords( state, p );
	const percent	= p?.percent ?? 0;
	const { storage } = useStorage();

	const toggle = useAction( async () => {
		if ( state === "paused" ) {
			await commands.syncResumeF( props.walletId );
		} else {
			await commands.syncPauseF( props.walletId );
		}
	}, props.open );

	const canToggle = state === "paused" || ( state === "syncing" && p?.running );

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.sync.details}>
			<div className="sync-sheet">
				<UI_Ring percent={percent} state={state} />
				<h3 className="sync-title">{words.title}</h3>
				<p className="sync-text">{words.text}</p>
				{state === "syncing" && p?.etaSecs != null && <p className="sync-eta">{T.sync.eta( p.etaSecs )}</p>}

				<div className="sync-span">
					<div className="sync-span-bar"><span className={"sync-span-fill " + state} style={{ width: `${percent}%` }} /></div>
					<div className="sync-span-ends">
						<span>{p?.birthdayTime ? Com_FormatDate( p.birthdayTime ) : T.sync.start}</span>
						<span>{T.sync.today}</span>
					</div>
				</div>

				<div className="sync-facts">
					<div className="sync-fact">
						<span className="sync-fact-title">
							{storage ? T.sync.stored( Com_FormatBytes( storage.wallets ) ) : <UI_Spinner size={12} />}
						</span>
						<span className="sync-fact-text">{T.sync.storedHint}</span>
					</div>
					<div className="sync-why">
						{T.sync.whyTitle} <UI_Info title={T.sync.whyTitle}>{T.sync.why}</UI_Info>
					</div>
				</div>

				{toggle.error && <UI_Alert title={T.sync.failed} message={toggle.error} />}

				<UI_SheetClose onClose={() => props.onOpenChange( false )} primary>
					{canToggle && (
						<button className="btn" disabled={toggle.busy} onClick={toggle.run}>
							{toggle.busy ? <UI_Spinner size={13} /> : state === "paused" ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
							{state === "paused" ? T.sync.resume : T.sync.pause}
						</button>
					)}
				</UI_SheetClose>
			</div>
		</UI_Sheet>
	);
}
