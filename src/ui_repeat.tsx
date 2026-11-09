/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_repeat.tsx -- payments that come back (w_repeat.rs): set up after a
// payment, listed on the dashboard, and when one is due, sent through Send
// like any payment. Nothing is ever sent by itself.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { CalendarClock, Ellipsis, SkipForward, Trash2 } from "lucide-react";

import { commands, Com_FormatDate, Com_Options, every_t, repeat_t } from "./ui_local";
import { T } from "./ui_text";
import { KEYS, QUERY } from "./ui_query";
import { useAction } from "./ui_hooks";
import { sheetProps_t, UI_Alert, UI_Amount, UI_Info, UI_Segmented, UI_Sheet, UI_SheetButtons } from "./ui_widgets";

/*
==================
useRepeats

Every repeating payment, with the engine's word on which are due. Read
again when the engine says one came due (St_Start), and every minute
besides.
==================
*/
export function useRepeats() {
	return useQuery( { queryKey: KEYS.repeats(), queryFn: () => commands.rpListF(), refetchInterval: 60_000 } );
}

/*
==================
Com_NoonOf

A date picked in the calendar ("2026-10-01"), as noon there, in unix
seconds: noon keeps its day the same across every time zone's edge
==================
*/
export function Com_NoonOf( date: string ): number {
	const [ y, m, d ] = date.split( "-" ).map( Number );
	return Math.floor( new Date( y, m - 1, d, 12 ).getTime() / 1000 );
}

// the date picker's value for a unix time, in local time
function Com_DateInput( unix: number ): string {
	const d = new Date( unix * 1000 );
	return `${d.getFullYear()}-${String( d.getMonth() + 1 ).padStart( 2, "0" )}-${String( d.getDate() ).padStart( 2, "0" )}`;
}

/*
==================
UI_RepeatSheet

Pay this again: every week or month, from a date. Only a reminder: when
it comes, it's reviewed and sent like any payment.
==================
*/
export function UI_RepeatSheet( props: sheetProps_t & { walletId: string; account: number; to: string; zats: number; memo: string | null; label: string | null } ) {
	const [ label, setLabel ]	= useState( "" );
	const [ every, setEvery ]	= useState< every_t >( "month" );
	const [ first, setFirst ]	= useState( "" );

	useEffect( () => {
		if ( props.open ) {
			setLabel( props.label ?? "" );
			setEvery( "month" );
			const inAMonth = new Date();
			inAMonth.setMonth( inAMonth.getMonth() + 1 );
			setFirst( Com_DateInput( inAMonth.getTime() / 1000 ) );
		}
	}, [ props.open ] );

	const save = useAction( async () => {
		await commands.rpSaveF( { id: null, walletId: props.walletId, account: props.account, label: label, to: props.to, zats: props.zats, memo: props.memo, every: every, next: Com_NoonOf( first ) } );
		await QUERY.invalidateQueries( { queryKey: KEYS.repeats() } );
		props.onOpenChange( false );
	}, props.open );

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.repeat.title} description={T.repeat.lede} busy={save.busy}>
			<div className="review-amount"><UI_Amount zats={props.zats} unit /></div>
			<label className="label" htmlFor="repeat-label">{T.repeat.label}</label>
			<input id="repeat-label" className="field" value={label} placeholder={T.repeat.labelHint} onChange={( e ) => setLabel( e.target.value )} />
			<div className="label">{T.repeat.every}</div>
			<UI_Segmented id="repeat-every" value={every} onChange={setEvery} options={Com_Options( [ "month", "week" ] as const, T.repeat.everyOptions )} />
			<label className="label" htmlFor="repeat-first">{T.repeat.first}</label>
			<input id="repeat-first" className="field" type="date" value={first} onChange={( e ) => setFirst( e.target.value )} />
			{save.error && <UI_Alert title={T.repeat.cantSave} message={save.error} />}
			<UI_SheetButtons busy={save.busy} onCancel={() => props.onOpenChange( false )} action={{ label: T.repeat.save, onRun: () => void save.run() }} />
		</UI_Sheet>
	);
}

/*
==================
UI_Repeats

The dashboard's "Coming up": what's due says so, with Review and Send
(onPay, which opens Send filled in) and Skip This Time; the rest show
their date. Nothing when there are none.
==================
*/
export function UI_Repeats( props: { onPay: ( r: repeat_t ) => void } ) {
	const list = useRepeats();
	const skip = useAction( async ( r: repeat_t ) => {
		await commands.rpDoneF( r.id );
		await QUERY.invalidateQueries( { queryKey: KEYS.repeats() } );
	} );
	const remove = useAction( async ( r: repeat_t ) => {
		await commands.rpRemoveF( r.id );
		await QUERY.invalidateQueries( { queryKey: KEYS.repeats() } );
	} );

	if ( !list.data?.length ) {
		return null;
	}
	return (
		<section className="panel">
			<h2 className="panel-title">{T.repeat.comingUp} <UI_Info title={T.repeat.comingUp}>{T.repeat.info}</UI_Info></h2>
			<ul className="repeat-list">
				{list.data.map( ( r ) => (
					<li key={r.id} className={"repeat-item" + ( r.due ? " due" : "" )}>
						<span className="repeat-icon"><CalendarClock aria-hidden="true" /></span>
						<span className="repeat-text">
							<span className="repeat-label">{r.label}</span>
							<span className="repeat-when">{r.due ? T.repeat.due : T.repeat.next( Com_FormatDate( r.next ), r.every )}</span>
						</span>
						<span className="repeat-amount"><UI_Amount zats={r.zats} unit /></span>
						{/* skipping and removing in the row's menu, never a link beside its one button */}
						<Menu.Root>
							<Menu.Trigger className="icon-btn" aria-label={T.repeat.more( r.label )} disabled={skip.busy || remove.busy}><Ellipsis aria-hidden="true" /></Menu.Trigger>
							<Menu.Portal>
								<Menu.Content className="menu" align="end" sideOffset={6} collisionPadding={12}>
									{r.due && <Menu.Item className="menu-item" onSelect={() => void skip.run( r )}><SkipForward aria-hidden="true" />{T.repeat.skip}</Menu.Item>}
									<Menu.Item className="menu-item danger" onSelect={() => void remove.run( r )}><Trash2 aria-hidden="true" />{T.repeat.remove}</Menu.Item>
								</Menu.Content>
							</Menu.Portal>
						</Menu.Root>
						{r.due && (
							<span className="repeat-actions">
								<button className="btn small primary" onClick={() => props.onPay( r )}>{T.repeat.pay}</button>
							</span>
						)}
					</li>
				) )}
			</ul>
			{( skip.error ?? remove.error ) && <UI_Alert title={T.repeat.cantSave} message={( skip.error ?? remove.error )!} />}
		</section>
	);
}
