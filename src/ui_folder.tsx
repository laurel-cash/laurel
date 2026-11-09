/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_folder.tsx -- Settings > Sync: the person's computers kept alike
// through a folder they share (w_folder.rs, docs/SYNC.md)
//
// The engine does the sync and says how it went (syncStatus_t); this shows
// it, and walks through starting, joining, forgetting and stopping.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, FolderOpen, FolderSync, Laptop, Lock, LogOut, TriangleAlert } from "lucide-react";

import { commands, Com_Ago, Com_ErrorOf, pickedFolder_t, syncComputer_t, syncStatus_t } from "./ui_local";
import { T } from "./ui_text";
import { KEYS, QUERY } from "./ui_query";
import { useAction } from "./ui_hooks";
import { useStore } from "./ui_store";
import { SECRET_FIELD, sheetProps_t, UI_Alert, UI_ConfirmSheet, UI_CopyButton, UI_Info, UI_Sheet, UI_SheetButtons, UI_SheetClose, UI_Spinner, UI_Waiting } from "./ui_widgets";

// what a sync said, kept for everything that shows it; without its word, the status is read again
function Com_Synced( s?: syncStatus_t ) {
	if ( s ) {
		QUERY.setQueryData( KEYS.folder(), s );
	} else {
		void QUERY.invalidateQueries( { queryKey: KEYS.folder() } );
	}
	void QUERY.invalidateQueries( { queryKey: KEYS.contacts() } );
	void QUERY.invalidateQueries( { queryKey: KEYS.settings() } );
	void QUERY.invalidateQueries( { queryKey: [ "transactions" ] } );		// notes ride on history
}

// the folder: picked with the system's picker, and shown as picked
function UI_FolderPick( props: { folder: pickedFolder_t | null; join: boolean; onPick: ( folder: pickedFolder_t ) => void } ) {
	const mobile = useStore( ( s ) => s.constants?.mobile ?? false );
	const pick = useAction( async () => {
		const f = await commands.fPickFolderF( props.join );
		if ( f && !mobile ) {
			props.onPick( f );
		}
	} );
	return (
		<div className="folder-pick">
			<button className="btn" onClick={() => void pick.run()} disabled={pick.busy}><FolderOpen aria-hidden="true" /> {props.folder ? T.folder.change : T.folder.choose}</button>
			<span className={props.folder ? "folder-path" : "hint"}>{props.folder?.name ?? T.folder.chooseHint}</span>
			{pick.error && <UI_Alert title={T.folder.cantChoose} message={pick.error} />}
		</div>
	);
}

/*
==================
UI_StartSheet

The first computer: a folder, then the code, shown once
==================
*/
export function UI_StartSheet( props: sheetProps_t & { initialFolder?: pickedFolder_t } ) {
	const [ folder, setFolder ]	= useState< pickedFolder_t | null >( props.initialFolder ?? null );
	const [ code, setCode ]		= useState< string | null >( null );
	const [ nudge, setNudge ]	= useState( false );

	// action, not a load: the code is what this press made, shown once
	const start = useAction( async ( f: string ) => {
		setCode( await commands.fStartF( f ) );
		Com_Synced();
	}, props.open );

	function Close( open: boolean ) {
		if ( !open ) {
			setFolder( null );
			setCode( null );
			setNudge( false );
		}
		props.onOpenChange( open );
	}

	if ( code ) {
		return (
			<UI_Sheet open={props.open} onOpenChange={Close} title={T.folder.codeTitle} description={T.folder.codeLede}>
				<code className="sync-code">{code}</code>
				<div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.folder.codeWarn}</span></div>
				<UI_SheetClose onClose={() => Close( false )} label={T.folder.codeDone} primary>
					<UI_CopyButton text={code} label={T.folder.copyCode} />
				</UI_SheetClose>
			</UI_Sheet>
		);
	}
	return (
		<UI_Sheet open={props.open} onOpenChange={Close} title={T.folder.startTitle} description={T.folder.startLede} busy={start.busy}>
			<UI_FolderPick folder={folder} join={false} onPick={( f ) => { setFolder( f ); setNudge( false ); }} />
			{nudge && <p className="hint bad" role="alert">{T.folder.needFolder}</p>}
			{start.busy && <UI_Waiting text={T.folder.starting} block />}
			{start.error && <UI_Alert title={T.folder.cantStart} message={start.error} />}
			<UI_SheetButtons busy={start.busy} onCancel={() => Close( false )} action={{ label: T.folder.start, onRun: () => folder ? void start.run( folder.path ) : setNudge( true ) }} />
		</UI_Sheet>
	);
}

/*
==================
UI_JoinSheet

Another computer: the same folder, and the code the first one showed.
Joined with a code that opens no file, it says so (docs/SYNC.md, 11).
==================
*/
export function UI_JoinSheet( props: sheetProps_t & { initialFolder?: pickedFolder_t } ) {
	const [ folder, setFolder ]	= useState< pickedFolder_t | null >( props.initialFolder ?? null );
	const [ code, setCode ]		= useState( "" );
	const [ nudge, setNudge ]	= useState< string | null >( null );
	const [ joined, setJoined ]	= useState< syncStatus_t | null >( null );

	const join = useAction( async ( f: string, c: string ) => {
		const s = await commands.fJoinF( f, c );
		setCode( "" );		// the code leaves the screen once used
		setJoined( s );
		Com_Synced( s );
	}, props.open );

	function Close( open: boolean ) {
		if ( !open ) {
			setFolder( null );
			setCode( "" );
			setNudge( null );
			setJoined( null );
		}
		props.onOpenChange( open );
	}

	function Join() {
		if ( !folder ) {
			setNudge( T.folder.needFolder );
		} else if ( !code.trim() ) {
			setNudge( T.folder.needCode );
		} else {
			void join.run( folder.path, code );
		}
	}

	if ( joined ) {
		const others = joined.computers.filter( ( c ) => !c.me && c.readable ).length;
		return (
			<UI_Sheet open={props.open} onOpenChange={Close} title={T.folder.joinedTitle}>
				{others > 0
					? <p className="lede">{T.folder.joined( others )}</p>
					: <div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.folder.joinedNone}</span></div>}
				<UI_SheetClose onClose={() => Close( false )} primary />
			</UI_Sheet>
		);
	}
	return (
		<UI_Sheet open={props.open} onOpenChange={Close} title={T.folder.joinTitle} description={T.folder.joinLede} busy={join.busy}>
			<UI_FolderPick folder={folder} join onPick={( f ) => { setFolder( f ); setNudge( null ); }} />
			<label className="label" htmlFor="sync-code">{T.folder.code}</label>
			<input id="sync-code" className="field mono" value={code} {...SECRET_FIELD} placeholder={T.folder.codePlaceholder} onChange={( e ) => { setCode( e.target.value ); setNudge( null ); }} />
			{nudge && <p className="hint bad" role="alert">{nudge}</p>}
			{join.busy && <UI_Waiting text={T.folder.joining} block />}
			{join.error && <UI_Alert title={T.folder.cantJoin} message={join.error} />}
			<UI_SheetButtons busy={join.busy} onCancel={() => Close( false )} action={{ label: T.folder.join, onRun: Join }} />
		</UI_Sheet>
	);
}

/*
==================
UI_FolderSection
==================
*/
export function UI_FolderSection() {
	const status = useQuery( { queryKey: KEYS.folder(), queryFn: () => commands.fStatusF() } );
	const [ sheet, setSheet ]		= useState< "none" | "start" | "join" | "stop" | "forget" >( "none" );
	const [ forgetting, setForgetting ] = useState< syncComputer_t | null >( null );
	const syncNow = useAction( async () => Com_Synced( await commands.fSyncF() ) );
	const close = ( open: boolean ) => { if ( !open ) setSheet( "none" ); };

	if ( status.error ) {
		return <UI_Alert title={T.folder.cantLoad} message={Com_ErrorOf( status.error )} action={T.common.tryAgain} onAction={() => void status.refetch()} />;
	}
	const s = status.data;
	if ( !s ) {
		return <div className="sheet-loading"><UI_Spinner size={16} /></div>;
	}

	const sheets = (
		<>
			<UI_StartSheet open={sheet === "start"} onOpenChange={close} />
			<UI_JoinSheet open={sheet === "join"} onOpenChange={close} />
			{/* stopping here: this computer's file leaves the folder; nothing else changes (17) */}
			<UI_ConfirmSheet open={sheet === "stop"} onOpenChange={close} title={T.folder.stopTitle} description={T.folder.stopLede} action={T.folder.stop} failed={T.folder.cantStop}
				onConfirm={async () => { await commands.fStopF(); Com_Synced(); }} />
			{/* a computer gone for good: its file leaves; what it changed stays (18) */}
			<UI_ConfirmSheet open={sheet === "forget"} onOpenChange={close} title={T.folder.forgetTitle( forgetting?.name || T.folder.unnamed )} description={T.folder.forgetLede} action={T.folder.forget} failed={T.folder.cantForget}
				onConfirm={async () => { if ( forgetting ) { await commands.fForgetF( forgetting.device ); Com_Synced( await commands.fSyncF() ); } }} />
		</>
	);

	// off: what sync carries and what it never does, the way Security shows its protection
	if ( !s.on ) {
		return (
			<section className="settings-section">
				<div className="sec-hero">
					<span className="sec-badge"><FolderSync aria-hidden="true" /></span>
					<div className="sec-text">
						<div className="sec-level">
							{T.folder.level}
							<span className="sec-level-name off">{T.folder.off}</span>
							<UI_Info title={T.folder.title}>{T.folder.how}</UI_Info>
						</div>
						<div className="sec-title">{T.folder.heroOff}</div>
						<div className="sec-hint">{T.folder.lede}</div>
						<ul className="sec-steps">
							{T.folder.carried.map( ( c ) => (
								<li key={c} className="on"><span className="sec-step-mark"><Check aria-hidden="true" /></span>{c}</li>
							) )}
							<li className="never"><span className="sec-step-mark"><Lock aria-hidden="true" /></span>{T.folder.never}</li>
						</ul>
						<div className="sec-actions">
							<button className="btn primary" onClick={() => setSheet( "start" )}>{T.folder.startButton}</button>
							<button className="btn" onClick={() => setSheet( "join" )}>{T.folder.joinButton}</button>
						</div>
					</div>
				</div>
				{sheets}
			</section>
		);
	}

	const others = s.computers.filter( ( c ) => !c.me ).length;
	return (
		<section className="settings-section">
			<div className={"sec-hero" + ( s.problem ? "" : " strong" )}>
				<span className="sec-badge"><FolderSync aria-hidden="true" /></span>
				<div className="sec-text">
					<div className="sec-level">
						{T.folder.level}
						{s.problem
							? <span className="sec-level-name warn">{T.folder.stopped}</span>
							: <span className="sec-level-name">{T.folder.on}</span>}
						<UI_Info title={T.folder.title}>{T.folder.how}</UI_Info>
					</div>
					<div className="sec-title">{T.folder.heroOn( others )}</div>
					<div className="sec-hint">{s.lastSync ? T.folder.lastSync( Com_Ago( s.lastSync ) ) : T.folder.firstLook}</div>
					<div className="sec-hint folder-path">{s.folder}</div>
					<div className="sec-actions">
						<button className="btn" disabled={syncNow.busy} onClick={() => void syncNow.run()}>{syncNow.busy ? <UI_Spinner size={12} /> : T.folder.syncNow}</button>
					</div>
				</div>
			</div>
			{s.problem && <UI_Alert title={T.folder.problem} message={s.problem} action={T.common.tryAgain} onAction={() => void syncNow.run()} />}
			{syncNow.error && <UI_Alert title={T.folder.problem} message={syncNow.error} />}

			<h2 className="section-title">{T.folder.devices}</h2>
			<ul className="pool-list settings-list">
				{s.computers.map( ( c ) => (
					<li key={c.device} className="set-row">
						<span className="set-icon"><Laptop aria-hidden="true" /></span>
						<span className="set-text">
							<span className="set-label">{c.name || T.folder.unnamed}{c.me ? ` · ${T.folder.thisComputer}` : ""}</span>
							<span className="set-sub">{c.readable ? ( c.me && s.lastSync ? T.folder.lastSync( Com_Ago( s.lastSync ) ) : T.folder.inSync ) : T.folder.unreadable}</span>
						</span>
						{!c.me && (
							<span className="set-actions">
								<button className="btn" onClick={() => { setForgetting( c ); setSheet( "forget" ); }}>{T.folder.forget}</button>
							</span>
						)}
					</li>
				) )}
				<li className="set-row">
					<span className="set-icon danger"><LogOut aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{T.folder.stopRow}</span>
						<span className="set-sub">{T.folder.stopRowSub}</span>
					</span>
					<span className="set-actions">
						<button className="btn danger-quiet" onClick={() => setSheet( "stop" )}>{T.folder.stopButton}</button>
					</span>
				</li>
			</ul>
			{s.skipped > 0 && <p className="hint">{T.folder.skipped( s.skipped )}</p>}
			{sheets}
		</section>
	);
}
