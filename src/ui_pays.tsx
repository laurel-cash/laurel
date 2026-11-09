/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_pays.tsx -- several payments in one: shown the same way wherever they
// are (Scan, Send, review), and typed or pasted as a list (bulk payouts).
// Every one is shown whole: its address, its amount, its memo.

import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { amount_t, Com_ErrorOf, Com_ParseZec, commands, payTo_t } from "./ui_local";
import { T } from "./ui_text";
import { useAction } from "./ui_hooks";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_Alert, UI_Amount, UI_Sheet, UI_SheetButtons } from "./ui_widgets";
import { Com_AmountProblem } from "./ui_payment";
import { UI_AddressLine } from "./ui_receive";

export type pay_t = { to: string; amount: number; memo: string | null };

// one line of a pasted list, as read: what it says, before the engine checks the address
export type listLine_t = { n: number; to: string; amount: amount_t; memo: string | null };

/*
==================
Com_ReadPayList

A list of payments, one a line: address, amount, and a memo if any.
Tab or semicolon separate when either is there, else a comma: an amount
may use a decimal comma ("1,5"), which only a tab or a semicolon leaves
whole. Empty lines and lines starting with # are skipped; every other
line is read, its amount the way Send reads one (Com_ParseZec).
==================
*/
export function Com_ReadPayList( text: string ): listLine_t[] {
	const lines = text.split( /\r?\n/ ).map( ( l, i ) => ( { n: i + 1, l: l.trim() } ) ).filter( ( x ) => x.l && !x.l.startsWith( "#" ) );
	return lines.map( ( { n, l } ) => {
		const sep = l.includes( "\t" ) ? "\t" : l.includes( ";" ) ? ";" : ",";
		// two fields, then the note exactly as typed: its own commas and spaces are its words
		const a = l.indexOf( sep );
		const b = a < 0 ? -1 : l.indexOf( sep, a + 1 );
		const to		= ( a < 0 ? l : l.slice( 0, a ) ).trim();
		const amount	= a < 0 ? "" : ( b < 0 ? l.slice( a + 1 ) : l.slice( a + 1, b ) ).trim();
		const memo		= b < 0 ? "" : l.slice( b + 1 ).trim();
		return { n, to, amount: Com_ParseZec( amount ), memo: memo || null };
	} );
}

// a checked line: what will be paid, or why not
type checkedLine_t = { n: number; pay: payTo_t | null; problem: string | null };

/*
==================
UI_PayListSheet

Pay several people: a list typed or pasted, each line checked (the
address by the engine, the way Scan reads one; the amount the way Send
reads one), every problem said by its line, nothing dropped quietly.
room: how many more payments this one can hold.
==================
*/
export function UI_PayListSheet( props: sheetProps_t & { room: number; onAdd: ( pays: payTo_t[] ) => void } ) {
	const [ text, setText ]			= useState( "" );
	const [ checked, setChecked ]	= useState< checkedLine_t[] | null >( null );
	const [ nudge, setNudge ]		= useState< string | null >( null );

	useEffect( () => {
		if ( props.open ) {
			setText( "" );
			setChecked( null );
			setNudge( null );
		}
	}, [ props.open ] );

	// action, not a load: it reads what was just typed
	const check = useAction( async () => {
		const out: checkedLine_t[] = [];
		for ( const line of Com_ReadPayList( text ) ) {
			let problem: string | null = null;
			let to = line.to;
			try {
				const scanned = await commands.wParseScanF( line.to );
				to = scanned.address;
				if ( line.memo && ( scanned.kind === "transparent" || scanned.kind === "tex" ) ) {
					problem = T.send.memoPublic;
				}
			} catch ( e ) {
				problem = Com_ErrorOf( e ).message;		// the engine's words: wrong network, not Zcash, too old
			}
			if ( !problem && line.amount.kind !== "ok" ) {
				problem = Com_AmountProblem( line.amount );
			}
			const zats = line.amount.kind === "ok" ? line.amount.zats : 0;
			if ( !problem && zats === 0 ) {
				problem = T.send.badAmount;
			}
			out.push( { n: line.n, pay: problem ? null : { to, zats, memo: line.memo }, problem } );
		}
		setChecked( out );
		setNudge( null );
	}, props.open );

	function Add() {
		if ( !checked || !checked.length ) {
			setNudge( T.pays.nothing );
		} else if ( checked.some( ( c ) => c.problem ) ) {
			setNudge( T.pays.fixFirst );
		} else if ( checked.length > props.room ) {
			setNudge( T.pays.tooMany( props.room ) );
		} else {
			props.onAdd( checked.map( ( c ) => c.pay! ) );
			props.onOpenChange( false );
		}
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.pays.title} description={T.pays.lede} busy={check.busy}>
			<label className="label" htmlFor="pay-list">{T.pays.label}</label>
			<textarea
				id="pay-list"
				className="field pay-list-text"
				rows={6}
				spellCheck={false}
				placeholder={T.pays.placeholder}
				value={text}
				onChange={( e ) => { setText( e.target.value ); setChecked( null ); }}
			/>
			{checked && (
				<ul className="pay-check">
					{checked.map( ( c ) => (
						<li key={c.n} className={c.problem ? "bad" : ""}>
							<span className="pay-check-n">{T.pays.line( c.n )}</span>
							{c.pay ? <><UI_AddressLine address={c.pay.to} /><UI_Amount zats={c.pay.zats} unit /></> : <span>{c.problem}</span>}
						</li>
					) )}
				</ul>
			)}
			{check.error && <UI_Alert title={T.pays.cantCheck} message={check.error} />}
			{nudge && <p className="hint bad">{nudge}</p>}
			<UI_SheetButtons
				busy={check.busy}
				onCancel={() => props.onOpenChange( false )}
				action={checked ? { label: T.pays.add( checked.length ), onRun: Add } : { label: T.pays.check, onRun: () => void check.run() }}
			/>
		</UI_Sheet>
	);
}

// how many more payments fit, from the engine's cap
export function useRoom( current: number ): number {
	const max = useStore( ( s ) => s.constants )?.maxPayments ?? 0;
	return Math.max( 0, max - current );
}

/*
==================
UI_PayList

onRemove: each can be taken out (while composing); absent, the list is
only read (Scan, review)
==================
*/
export function UI_PayList( props: { pays: pay_t[]; onRemove?: ( i: number ) => void } ) {
	if ( !props.pays.length ) {
		return null;
	}
	return (
		<div className="pay-list">
			<div className="label">{T.send.alsoPays( props.pays.length )}</div>
			<ul>
				{props.pays.map( ( p, i ) => (
					<li key={i} className="pay-item">
						<span className="pay-main">
							<UI_AddressLine address={p.to} />
							{p.memo && <span className="pay-memo">“{p.memo}”</span>}
						</span>
						<span className="pay-amount"><UI_Amount zats={p.amount} unit /></span>
						{props.onRemove && (
							<button className="icon-btn" aria-label={T.send.removePay} onClick={() => props.onRemove?.( i )}><X aria-hidden="true" /></button>
						)}
					</li>
				) )}
			</ul>
		</div>
	);
}
