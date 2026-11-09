/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_developer.tsx -- Developer settings: the facts about this Laurel, a
// report for support (shown whole before it's copied: nothing private is
// in it), and checking a wallet again from the start (w_dev.rs)

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, RefreshCw, RotateCcw } from "lucide-react";

import { commands, Com_ErrorOf, folder_t, walletSummary_t } from "./ui_local";
import { Com_NetworkName, T } from "./ui_text";
import { KEYS } from "./ui_query";
import { useAction } from "./ui_hooks";
import { useStore } from "./ui_store";
import { UI_Alert, UI_CopyButton, UI_Spinner } from "./ui_widgets";

/*
==================
UI_RecheckRow

One wallet, and checking it again from its birthday, asked once more in
place: it takes as long as a restore
==================
*/
function UI_RecheckRow( props: { wallet: walletSummary_t } ) {
	const [ sure, setSure ]		= useState( false );
	const [ started, setStarted ]	= useState( false );
	const recheck = useAction( async () => {
		await commands.syncRescanF( props.wallet.id );
		setSure( false );
		setStarted( true );
	} );

	return (
		<li className="set-row dev-recheck">
			<span className="set-text">
				<span className="set-label">{props.wallet.name}</span>
				<span className="set-sub">{started ? T.developer.recheckStarted : sure ? T.developer.recheckSure : T.developer.recheckHint}</span>
				{recheck.error && <UI_Alert title={T.developer.cantRecheck} message={recheck.error} />}
			</span>
			<span className="set-actions">
				{sure ? (
					<>
						<button className="btn" disabled={recheck.busy} onClick={() => setSure( false )}>{T.common.cancel}</button>
						<button className="btn primary" disabled={recheck.busy} onClick={() => { recheck.run(); }}>
							{recheck.busy ? <UI_Spinner size={13} /> : <RotateCcw aria-hidden="true" />}{T.developer.recheck}
						</button>
					</>
				) : (
					!started && <button className="btn" onClick={() => setSure( true )}>{T.developer.recheckAsk}</button>
				)}
			</span>
		</li>
	);
}

/*
==================
UI_DeveloperSection
==================
*/
export function UI_DeveloperSection() {
	const wallets	= useStore( ( s ) => s.wallets );
	const order		= useStore( ( s ) => s.order );
	const mobile	= useStore( ( s ) => s.constants?.mobile );
	const info		= useQuery( { queryKey: KEYS.devInfo(), queryFn: () => commands.dInfoF(), staleTime: 0 } );
	const report	= useQuery( { queryKey: KEYS.devReport(), queryFn: () => commands.dReportF(), staleTime: 0, gcTime: 0 } );
	const reveal	= useAction( ( folder: folder_t ) => commands.dRevealF( folder ) );

	const i = info.data;
	return (
		<>
			<section className="settings-section">
				{info.error && <UI_Alert title={T.developer.cantRead} message={Com_ErrorOf( info.error )} />}
				{i && (
					<dl className="facts">
						<div className="fact"><dt>{T.developer.version}</dt><dd>{i.version}</dd></div>
						<div className="fact"><dt>{T.developer.network}</dt><dd>{Com_NetworkName( i.network )}</dd></div>
						<div className="fact"><dt>{T.developer.server}</dt><dd className="fact-id">{i.server ?? T.developer.noServer}{i.ownServer ? ` · ${T.developer.own}` : ""}</dd></div>
						{/* a phone has no file manager to show Laurel's folders in: they're its own, private */}
						{mobile === false && <div className="fact">
							<dt>{T.developer.data}</dt>
							<dd><button className="link quiet" onClick={() => { reveal.run( "data" ); }}><FolderOpen aria-hidden="true" />{T.developer.show}</button></dd>
						</div>}
						{mobile === false && <div className="fact">
							<dt>{T.developer.logs}</dt>
							<dd><button className="link quiet" onClick={() => { reveal.run( "logs" ); }}><FolderOpen aria-hidden="true" />{T.developer.show}</button></dd>
						</div>}
					</dl>
				)}
				{reveal.error && <UI_Alert title={T.developer.cantShow} message={reveal.error} />}
			</section>

			<section className="settings-section">
				<h2 className="section-title">{T.developer.reportTitle}</h2>
				<p className="hint section-lede">{T.developer.reportHint}</p>
				{report.error && <UI_Alert title={T.developer.cantRead} message={Com_ErrorOf( report.error )} />}
				<pre className="dev-report">{report.data ?? T.developer.gathering}</pre>
				<div className="wallet-actions">
					{report.data && <UI_CopyButton text={report.data} label={T.developer.copyReport} />}
					<button className="btn" disabled={report.isFetching} onClick={() => { report.refetch(); }}><RefreshCw aria-hidden="true" />{T.developer.refresh}</button>
				</div>
			</section>

			<section className="settings-section">
				<h2 className="section-title">{T.developer.recheckTitle}</h2>
				<p className="hint section-lede">{T.developer.recheckLede}</p>
				<ul className="pool-list settings-list">
					{order.map( ( id ) => wallets[id] ).filter( ( w ): w is walletSummary_t => !!w ).map( ( w ) => <UI_RecheckRow key={w.id} wallet={w} /> )}
				</ul>
			</section>
		</>
	);
}
