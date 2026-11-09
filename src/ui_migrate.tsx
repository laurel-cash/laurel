/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_migrate.tsx -- moving an account's Orchard money into Ironwood, all at
// once, after showing what it will do and what it costs in privacy
//
// Plan, then confirm, like Send: the engine moves only the plan the person
// saw, once (w_migrate.rs). If the plan changed meanwhile, the new one is
// shown for another look.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, Info, ShieldCheck } from "lucide-react";

import { Com_ErrorOf, commands, migratePlan_t, quoted_t } from "./ui_local";
import { T } from "./ui_text";
import { useConfirm } from "./ui_hooks";
import { KEYS, QUERY } from "./ui_query";
import { sheetProps_t, UI_Alert, UI_Amount, UI_Sheet, UI_SheetButtons, UI_SheetClose, UI_Waiting } from "./ui_widgets";
import { UI_CatchingUp, usePayable } from "./ui_sync";
import { UI_Flow, UI_ReviewFrom } from "./ui_payment";


/*
==================
UI_MigrateSheet
==================
*/
export function UI_MigrateSheet( props: sheetProps_t & { walletId: string; account: number } ) {
	const [ done, setDone ]			= useState< string[] | null >( null );
	const payable = usePayable( props.walletId );

	// the plan belongs to this wallet and account, and is read fresh each time the sheet opens
	const key = KEYS.migrationPlan( props.walletId, props.account );
	const plan = useQuery( {
		queryKey:	key,
		queryFn:	() => commands.wPlanMigrationF( props.walletId, props.account ),
		enabled:	props.open && !done && payable,		// asked only once the wallet has caught up
		gcTime:		0,
	} );
	const status = useQuery( {
		queryKey:	KEYS.migration( props.walletId ),
		queryFn:	() => commands.wMigrationStatusF( props.walletId ),
		enabled:	props.open,
	} );

	// action, not a load: it moves money; the ids it returns belong to this
	// one press. Once per plan seen: the intent goes back with it. After a
	// failure the plan is read again, so the next press has an intent of its own
	const move = useConfirm(
		async ( seen: quoted_t< migratePlan_t > ) => {
			try {
				return await commands.wMigrateNowF( props.walletId, props.account, seen.intent, seen.quote );
			} catch ( e ) {
				void plan.refetch();
				throw e;
			}
		},
		( r ) => setDone( r.txids ),
		( quoted ) => QUERY.setQueryData( key, quoted ),		// the new plan, under a new intent
		props.open,
	);

	function Close( open: boolean ) {
		if ( !open ) {
			setDone( null );
			move.setChanged( false );
			move.setError( null );
		}
		props.onOpenChange( open );
	}

	const pd = plan.data;
	const p = pd?.quote;
	const scheduled = status.data?.scheduled ? status.data : null;

	let body;
	if ( done ) {
		body = (
			<div className="sheet-state done">
				<span className="sheet-state-icon"><CircleCheck aria-hidden="true" /></span>
				<span className="sheet-state-title">{T.migrate.doneTitle}</span>
				<span className="sheet-state-text">{T.migrate.done}</span>
			</div>
		);
	} else if ( !payable && !p && !move.busy ) {
		body = <UI_CatchingUp walletId={props.walletId} />;
	} else if ( plan.error ) {
		body = <UI_Alert title={T.migrate.failed} message={Com_ErrorOf( plan.error )} action={T.common.tryAgain} onAction={() => void plan.refetch()} />;
	} else if ( !p ) {
		body = <div className="sheet-loading"><UI_Waiting text={T.migrate.planning} size={18} /></div>;
	} else {
		body = (
			<>
				<UI_ReviewFrom walletId={props.walletId} account={props.account} />
				<UI_Flow
					working={move.busy}
					from={{ kind: "pool-orchard", icon: <ShieldCheck aria-hidden="true" />, label: T.migrate.fromPool, zats: p.amount + p.fee }}
					to={{ kind: "private", icon: <ShieldCheck aria-hidden="true" />, label: T.migrate.toPool, zats: p.amount }}
				/>
				<dl className="facts">
					<div className="fact"><dt>{T.migrate.moves}</dt><dd>{T.migrate.transactions( p.transactions )}</dd></div>
					<div className="fact"><dt>{T.migrate.fee}</dt><dd><UI_Amount zats={p.fee} unit /></dd></div>
					{p.residual > 0 && <div className="fact"><dt>{T.migrate.stays}</dt><dd><UI_Amount zats={p.residual} unit /></dd></div>}
				</dl>
				<p className="hint">{T.migrate.tradeoff}</p>
				{move.changed && !move.busy && <div className="info-note"><Info aria-hidden="true" /><span>{T.migrate.changed}</span></div>}
				{move.error && <UI_Alert title={T.migrate.failed} message={move.error} />}
				{move.busy && <div className="sheet-loading"><UI_Waiting text={T.migrate.moving} size={16} /></div>}
			</>
		);
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={Close} title={T.migrate.title} description={T.migrate.lede} busy={move.busy}>
			{scheduled && <p className="hint">{T.migrate.scheduled( scheduled.partsConfirmed, scheduled.partsTotal )}</p>}
			{body}
			{done ? <UI_SheetClose onClose={() => Close( false )} primary /> : (
				<UI_SheetButtons busy={move.busy} onCancel={() => Close( false )} action={!pd || plan.isFetching ? null : {
					label:		T.migrate.action,
					onRun:		() => { move.run( pd ); },
					icon:		<ArrowRight aria-hidden="true" />,
				}} />
			)}
		</UI_Sheet>
	);
}
