/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_alert.tsx -- price alerts (w_alert.rs): set from the price chart,
// each going off once, when the price crosses it

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";

import { commands, Com_ErrorOf, Com_FormatDate, Com_FormatUsd, Com_Options, Com_ParseZec } from "./ui_local";
import { T } from "./ui_text";
import { KEYS, QUERY } from "./ui_query";
import { useAction } from "./ui_hooks";
import { sheetProps_t, UI_Alert, UI_Segmented, UI_Sheet, UI_SheetClose } from "./ui_widgets";
import { UI_AmountHint } from "./ui_payment";

// a dollar amount, typed as any amount is (Com_ParseZec: exact, a comma asked about); 100_000_000 is a dollar
const DOLLAR = 100_000_000;

/*
==================
usePriceAlerts

The alerts, read again when the engine says one went off (St_Start)
==================
*/
export function usePriceAlerts() {
	return useQuery( { queryKey: KEYS.alerts(), queryFn: () => commands.alListF() } );
}

/*
==================
UI_PriceAlertSheet

A new alert, and the ones there are: waiting, or gone off (when)
==================
*/
export function UI_PriceAlertSheet( props: sheetProps_t & { price: number } ) {
	const list = usePriceAlerts();
	const [ above, setAbove ]	= useState( true );
	const [ text, setText ]		= useState( "" );
	const [ nudge, setNudge ]	= useState( false );
	const amount = text.trim() ? Com_ParseZec( text ) : null;

	useEffect( () => {
		if ( props.open ) {
			setText( "" );
			setNudge( false );
		}
	}, [ props.open ] );

	const add = useAction( async ( usd: number ) => {
		await commands.alAddF( above, usd );
		setText( "" );
		await QUERY.invalidateQueries( { queryKey: KEYS.alerts() } );
	}, props.open );
	const remove = useAction( async ( id: string ) => {
		await commands.alRemoveF( id );
		await QUERY.invalidateQueries( { queryKey: KEYS.alerts() } );
	}, props.open );

	function Add() {
		setNudge( amount?.kind !== "ok" || amount.zats === 0 );
		if ( amount?.kind === "ok" && amount.zats > 0 ) {
			void add.run( amount.zats / DOLLAR );
		}
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.alerts.title} description={T.alerts.lede( Com_FormatUsd( props.price ) )} busy={add.busy}>
			<UI_Segmented full id="alert-way" value={above ? "above" : "below"} onChange={( v ) => setAbove( v === "above" )} options={Com_Options( [ "above", "below" ] as const, T.alerts.ways )} />
			<label className="label" htmlFor="alert-usd">{T.alerts.price}</label>
			<div className={"send-amount" + ( nudge ? " bad" : "" )}>
				<input id="alert-usd" inputMode="decimal" placeholder="0.00" value={text} onChange={( e ) => { setText( e.target.value ); setNudge( false ); }} onKeyDown={( e ) => { if ( e.key === "Enter" ) Add(); }} />
				<span className="send-unit">USD</span>
			</div>
			<UI_AmountHint text={text} amount={amount} onPick={setText} />
			{nudge && !amount && <p className="hint bad">{T.alerts.noPrice}</p>}
			<div className="request-actions">
				<button className="btn primary" disabled={add.busy} onClick={Add}>{T.alerts.add}</button>
			</div>

			{!!list.data?.length && (
				<ul className="repeat-list">
					{list.data.map( ( a ) => (
						<li key={a.id} className="repeat-item">
							<span className="repeat-text">
								<span className="repeat-label">{a.above ? T.alerts.whenAbove( Com_FormatUsd( a.usd ) ) : T.alerts.whenBelow( Com_FormatUsd( a.usd ) )}</span>
								<span className="repeat-when">{a.fired != null ? T.alerts.went( Com_FormatDate( a.fired ) ) : T.alerts.waiting}</span>
							</span>
							<button className="icon-btn" aria-label={T.alerts.remove} disabled={remove.busy} onClick={() => void remove.run( a.id )}><X aria-hidden="true" /></button>
						</li>
					) )}
				</ul>
			)}
			{list.error && <UI_Alert title={T.alerts.failed} message={Com_ErrorOf( list.error )} />}
			{( add.error ?? remove.error ) && <UI_Alert title={T.alerts.failed} message={( add.error ?? remove.error )!} />}
			<UI_SheetClose onClose={() => props.onOpenChange( false )} />
		</UI_Sheet>
	);
}
