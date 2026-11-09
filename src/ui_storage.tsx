/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_storage.tsx -- what Laurel keeps on this computer, measured by the
// engine (w_storage.rs), and the warning before a full disk stops saves

import { useQuery } from "@tanstack/react-query";
import { AppWindow, HardDrive, Sparkles, WalletCards } from "lucide-react";

import { commands, Com_ErrorOf, Com_FormatBytes } from "./ui_local";
import { T } from "./ui_text";
import { KEYS } from "./ui_query";
import { UI_Alert, UI_Waiting } from "./ui_widgets";

const REMEASURE_MSEC = 5 * 60 * 1000;


/*
==================
useStorage

The latest measurement, shared by every view that shows it: a query, like
every load of engine data, so no view holds a copy of its own. Taken when
first shown and every few minutes after.
==================
*/
export function useStorage() {
	const q = useQuery( {
		queryKey:			KEYS.storage(),
		queryFn:			() => commands.stoMeasureF(),
		staleTime:			REMEASURE_MSEC,
		refetchInterval:	REMEASURE_MSEC,
	} );

	return {
		storage:	q.data ?? null,
		error:		q.error ? Com_ErrorOf( q.error ) : null,
		Measure:	() => { q.refetch(); },
	};
}

/*
==================
UI_LowSpaceAlert

On Home, only while the disk the wallets live on is nearly full
==================
*/
export function UI_LowSpaceAlert() {
	const { storage } = useStorage();

	if ( !storage?.lowSpace ) {
		return null;
	}
	return <UI_Alert title={T.storage.lowTitle} message={T.storage.low( Com_FormatBytes( storage.free ) )} />;
}

/*
==================
UI_StorageSection

For Settings: one bar of the disk, then each part Laurel uses
==================
*/
export function UI_StorageSection() {
	const { storage, error, Measure } = useStorage();

	let body;
	if ( error ) {
		body = <UI_Alert title={T.storage.failed} message={error} action={T.common.tryAgain} onAction={Measure} />;
	} else if ( !storage ) {
		body = <div className="sheet-loading"><UI_Waiting text={T.storage.measuring} size={16} /></div>;
	} else {
		const used	= storage.wallets + storage.app + storage.temporary;
		const disk	= Math.max( storage.disk, 1 );
		const share	= ( n: number ) => `${Math.max( n / disk * 100, n > 0 ? 0.6 : 0 )}%`;		// a sliver stays visible

		const rows = [
			{ icon: WalletCards,	cls: "wallets",	label: T.storage.wallets,	hint: T.storage.walletsHint,	size: storage.wallets },
			{ icon: AppWindow,		cls: "app",		label: T.storage.app,		hint: T.storage.appHint,		size: storage.app },
			{ icon: Sparkles,		cls: "cache",	label: T.storage.cache,		hint: T.storage.cacheHint( Com_FormatBytes( storage.cleaned ) ), size: storage.temporary },
		];

		body = (
			<>
				<div className="sto-head">
					<span className="sto-total">{Com_FormatBytes( used )}</span>
					<span className="sto-free"><HardDrive aria-hidden="true" />{T.storage.free( Com_FormatBytes( storage.free ), Com_FormatBytes( storage.disk ) )}</span>
				</div>
				<div className="sto-bar" role="img" aria-label={T.storage.title}>
					{rows.map( ( r ) => <span key={r.cls} className={"sto-part " + r.cls} style={{ width: share( r.size ) }} /> )}
					<span className="sto-part other" style={{ width: share( storage.disk - storage.free - used ) }} />
				</div>
				<ul className="pool-list settings-list">
					{rows.map( ( r ) => (
						<li key={r.cls} className="set-row">
							<span className={"set-icon sto-" + r.cls}><r.icon aria-hidden="true" /></span>
							<span className="set-text">
								<span className="set-label">{r.label}</span>
								<span className="set-sub">{r.hint}</span>
							</span>
							<span className="set-value">{Com_FormatBytes( r.size )}</span>
						</li>
					) )}
				</ul>
			</>
		);
	}

	return (
		<section className="settings-section">
			{body}
		</section>
	);
}
