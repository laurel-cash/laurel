/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_terms.tsx -- T-049: v1's first screen. Before any wallet is made or
// opened, the person agrees to the terms of use and the privacy policy,
// once per version of them (w_settings.rs TERMS_VERSION). The engine says
// whether it is due; agreeing is kept only on the phone, nothing is sent.

import { useEffect, useState } from "react";
import type { MouseEvent } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "./bindings";
import { useAction } from "./ui_hooks";
import { T } from "./ui_text";
import { UI_Alert, UI_Waiting } from "./ui_widgets";
import { UI_AppIcon } from "./ui_chrome";

export const TERMS_URL		= "https://laurel.cash/terms";
export const PRIVACY_URL	= "https://laurel.cash/privacy";

export type terms_t = "checking" | "due" | "agreed";

/*
==================
useTerms

Whether the terms stand between the person and their wallets: asked of
the engine once the screen knows it is past the lock. An engine that
can't say asks again: agreeing twice costs nothing, skipping them would.
==================
*/
export function useTerms( known: boolean ) {
	const [ terms, setTerms ] = useState< terms_t >( "checking" );

	useEffect( () => {
		if ( !known ) {
			return;
		}
		let live = true;
		void Promise.resolve()
			.then( () => commands.sTermsDueF() )
			.then( ( due ) => {
				if ( live ) {
					setTerms( due ? "due" : "agreed" );
				}
			} )
			.catch( ( e: unknown ) => {
				console.error( "sTermsDueF", e );
				if ( live ) {
					setTerms( "due" );
				}
			} );
		return () => {
			live = false;
		};
	}, [ known ] );

	return { terms, agreed: () => setTerms( "agreed" ) };
}

// a link opened in the browser, never followed inside Laurel; clicking it
// doesn't tick the box it sits beside
function UI_TermsLink( props: { url: string; text: string } ) {
	function Open( e: MouseEvent ) {
		e.preventDefault();
		e.stopPropagation();
		void Promise.resolve().then( () => openUrl( props.url ) ).catch( ( err: unknown ) => console.error( "openUrl", err ) );
	}
	return <a href={props.url} onClick={Open}>{props.text}</a>;
}

/*
==================
UI_TermsScreen

The terms, a box that starts unticked, and one way on: agreeing, which
stays disabled until the box is ticked
==================
*/
export function UI_TermsScreen( props: { onAgreed: () => void } ) {
	const [ ticked, setTicked ] = useState( false );
	const agree = useAction( async () => {
		await commands.sAcceptTermsF();
		props.onAgreed();
	} );

	return (
		<div className="onboard">
			<div className="onboard-card terms">
				<UI_AppIcon size={64} />
				<h1 className="onboard-title">{T.terms.title}</h1>
				<p className="terms-lede">{T.terms.lede}</p>
				<ul className="terms-points">
					{T.terms.points.map( ( p ) => <li key={p}>{p}</li> )}
				</ul>
				<label className="check-row terms-check">
					<input type="checkbox" checked={ticked} onChange={( e ) => setTicked( e.target.checked )} />
					<span>
						{T.terms.read.before}
						<UI_TermsLink url={TERMS_URL} text={T.terms.termsLink} />
						{T.terms.read.between}
						<UI_TermsLink url={PRIVACY_URL} text={T.terms.privacyLink} />
						{T.terms.read.after}
					</span>
				</label>
				{agree.error && <UI_Alert title={T.terms.failed} message={agree.error} />}
				<div className="onboard-actions">
					<button className="btn primary large" disabled={!ticked || agree.busy} onClick={agree.run}>
						{agree.busy ? <UI_Waiting text={T.terms.agreeing} size={16} /> : T.terms.agree}
					</button>
				</div>
			</div>
		</div>
	);
}
