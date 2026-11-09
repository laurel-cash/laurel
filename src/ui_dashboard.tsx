/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_dashboard.tsx -- Customize the Dashboard: which cards show beside the
// balance, in what order, and whether the chart shows
//
// Kept per computer (PREF_HOME), like the appearance: the layout is how
// this person reads this screen, not a fact about any wallet. Moving is
// by buttons, not only by dragging, so a keyboard does it too.

import { ArrowDown, ArrowUp } from "lucide-react";

import { Com_MoveCard, Com_ShowCard, HOME_DEFAULT, homeCard_t } from "./ui_local";
import { T } from "./ui_text";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_Sheet, UI_SheetClose, UI_Switch, UI_Tip } from "./ui_widgets";

/*
==================
UI_DashboardSheet
==================
*/
export function UI_DashboardSheet( props: sheetProps_t ) {
	const home		= useStore( ( s ) => s.home );
	const setHome	= useStore( ( s ) => s.SetHome );

	// one card's row: shown or not, and a place earlier or later
	function Row( c: homeCard_t, i: number ) {
		const name = T.dashboard.cards[c];
		return (
			<li key={c} className="set-row">
				<span className="set-text">
					<span className="set-label">{name}</span>
					{c === "repeats" && <span className="set-sub">{T.dashboard.dueAnyway}</span>}
				</span>
				<span className="set-actions">
					<UI_Tip label={T.dashboard.earlier( name )}>
						<button className="icon-btn" aria-label={T.dashboard.earlier( name )} disabled={i === 0} onClick={() => setHome( Com_MoveCard( home, c, -1 ) )}><ArrowUp aria-hidden="true" /></button>
					</UI_Tip>
					<UI_Tip label={T.dashboard.later( name )}>
						<button className="icon-btn" aria-label={T.dashboard.later( name )} disabled={i === home.order.length - 1} onClick={() => setHome( Com_MoveCard( home, c, 1 ) )}><ArrowDown aria-hidden="true" /></button>
					</UI_Tip>
					<UI_Switch label={name} checked={!home.hidden.includes( c )} onChange={( on ) => setHome( Com_ShowCard( home, c, on ) )} />
				</span>
			</li>
		);
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.dashboard.title} description={T.dashboard.lede}>
			<ul className="pool-list settings-list">
				<li className="set-row">
					<span className="set-text"><span className="set-label">{T.dashboard.chart}</span></span>
					<span className="set-actions"><UI_Switch label={T.dashboard.chart} checked={home.chart} onChange={( on ) => setHome( { ...home, chart: on } )} /></span>
				</li>
			</ul>
			<h3 className="section-title">{T.dashboard.side}</h3>
			<ul className="pool-list settings-list">
				{home.order.map( Row )}
			</ul>
			<UI_SheetClose onClose={() => props.onOpenChange( false )} primary>
				<button className="btn" onClick={() => setHome( HOME_DEFAULT )}>{T.dashboard.reset}</button>
			</UI_SheetClose>
		</UI_Sheet>
	);
}
