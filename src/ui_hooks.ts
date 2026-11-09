/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_hooks.ts -- the async patterns every screen shares, written once

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "./ui_store";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { appSettings_t, commands, Com_ErrorOf, Com_ErrorString, errorInfo_t, quoted_t, scanned_t } from "./ui_local";
import { KEYS, QUERY } from "./ui_query";


/*
==================
useAction

Every button that calls the engine goes through this. It owns:
  busy		for the spinner
  error		the engine's errorInfo_t, for an alert (message and details)
  the guard	a second click while the first is running does nothing.
			it is a ref, set before any await, so even two clicks in
			the same frame can't both get through

run() resolves to the result, or undefined if it failed or was ignored.

A sheet's action is given the sheet's open: its error is then this
opening's, never one from before. Nineteen sheets cleared their actions'
errors by hand or not at all, and ten showed a failure from the last time
(check_owners now asks every sheet's action for its open).
==================
*/
export function useAction< A extends unknown[], R >( fn: ( ...args: A ) => Promise< R >, open?: boolean ) {
	const [ busy, setBusy ]		= useState( false );
	const [ error, setError ]	= useState< errorInfo_t | null >( null );
	const running				= useRef( false );
	const mounted				= useRef( true );
	const latest				= useRef( fn );

	latest.current = fn;		// always call the newest closure, never a stale one

	useEffect( () => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, [] );

	useEffect( () => {
		if ( open ) {
			setError( null );
		}
	}, [ open ] );

	const run = useCallback( async ( ...args: A ): Promise< R | undefined > => {
		if ( running.current ) {
			return undefined;
		}
		running.current = true;
		setBusy( true );
		setError( null );
		try {
			return await latest.current( ...args );
		} catch ( e ) {
			if ( mounted.current ) {
				setError( Com_ErrorOf( e ) );
			}
			return undefined;
		} finally {
			running.current = false;
			if ( mounted.current ) {
				setBusy( false );
			}
		}
	}, [] );

	return { run, busy, error, setError };
}

/*
==================
useConfirm

Pressing the button under a quote (Shield, Send, Sweep, Move): the
quote goes back with its intent, and the engine either sent it or found
the numbers changed. The one owner of that answer: "changed" is shown
until the next press, and when it started is kept for the working line.
What sent means is each sheet's own (onSent); new numbers go wherever
that sheet keeps its quote (onChanged).
==================
*/
export type confirmed_t< Q, S > = ( { kind: "sent" } & S ) | { kind: "changed"; quoted: quoted_t< Q > };

export function useConfirm< Q, S, X extends unknown[] = [] >(
	send:		( seen: quoted_t< Q >, ...more: X ) => Promise< confirmed_t< Q, S > >,		// more: what else the press sends (Send's request)
	onSent:		( sent: S, seen: quoted_t< Q > ) => void,
	onChanged:	( quoted: quoted_t< Q > ) => void,
	open?:		boolean,			// the sheet's: each opening starts with no error and nothing "changed"
) {
	const [ changed, setChanged ]	= useState( false );
	const [ since, setSince ]		= useState( 0 );

	useEffect( () => {
		if ( open ) {
			setChanged( false );
		}
	}, [ open ] );

	const action = useAction( async ( seen: quoted_t< Q >, ...more: X ) => {
		setChanged( false );
		setSince( Date.now() );
		const r = await send( seen, ...more );
		switch ( r.kind ) {
		case "sent":
			onSent( r, seen );
			break;
		case "changed":
			onChanged( r.quoted );		// new numbers, under a new intent
			setChanged( true );
			break;
		}
	}, open );

	return { ...action, changed, since, setChanged };
}

/*
==================
useLatest

For requests fired as the user types: only the newest answer is
applied. An older request that happens to finish last is dropped, so a
phrase that is now valid can't be shown as invalid.
==================
*/
export function useLatest() {
	const serial = useRef( 0 );

	return useCallback( < T >( request: Promise< T >, apply: ( value: T ) => void ) => {
		const mine = ++serial.current;
		request.then( ( value ) => {
			if ( mine === serial.current ) {
				apply( value );
			}
		} ).catch( () => {
			// a failed check just leaves the last good answer on screen
		} );
	}, [] );
}

const ADDRESS_CHECK_MSEC = 250;		// an address is checked once typing pauses this long

/*
==================
useAddressCheck

An address as it's typed, read the way Scan reads one (W_ParseScan):
what it is, or why it isn't one. Checked once typing pauses; only the
newest answer counts. Send and the address book both use it.
==================
*/
export function useAddressCheck( text: string ) {
	const latest = useLatest();
	const [ checking, setChecking ]	= useState( false );
	const [ target, setTarget ]		= useState< scanned_t | null >( null );
	const [ error, setError ]		= useState< string | null >( null );

	useEffect( () => {
		setTarget( null );
		setError( null );
		if ( !text.trim() ) {
			setChecking( false );
			return;
		}
		setChecking( true );
		const timer = setTimeout( () => {
			latest(
				commands.wParseScanF( text ).then( ( t ) => ( { t: t, e: null } ), ( e: unknown ) => ( { t: null, e: Com_ErrorString( e ) } ) ),
				( r ) => {
					setChecking( false );
					setTarget( r.t );
					setError( r.e );
				},
			);
		}, ADDRESS_CHECK_MSEC );
		return () => clearTimeout( timer );
	}, [ text ] );

	return { checking, target, error };
}

/*
==================
useAppSettings

The person's choices for the whole app (w_settings.rs), and a save that
changes some of them and keeps the rest
==================
*/
export function useAppSettings() {
	const settings = useQuery( { queryKey: KEYS.settings(), queryFn: () => commands.sGetF() } );

	const save = useAction( async ( patch: Partial< appSettings_t > ) => {
		const now = settings.data;
		if ( now ) {
			QUERY.setQueryData( KEYS.settings(), await commands.sSetF( { ...now, ...patch } ) );
		}
	} );

	return { settings: settings.data, error: settings.error, save: save };
}

/*
==================
useUncapturable

While on, screenshots, screen recordings and shared screens show this
window blank (Windows' capture exclusion). The words on screen say
"don't take a screenshot"; this makes one show nothing, and keeps a
screen-sharing "support agent" from reading along.
==================
*/
export function useUncapturable( on: boolean ) {
	const mobile = useStore( ( s ) => s.constants?.mobile );
	useEffect( () => {
		if ( !on || mobile !== false ) {
			return;
		}
		const win = getCurrentWindow();
		win.setContentProtected( true ).catch( ( e: unknown ) => console.error( "useUncapturable: on", e ) );
		return () => {
			win.setContentProtected( false ).catch( ( e: unknown ) => console.error( "useUncapturable: off", e ) );
		};
	}, [ on, mobile ] );
}

/*
==================
useTextScale

The chosen text size (w_settings.rs, TEXT_SCALES) applied to the whole
window, and Ctrl +, Ctrl − and Ctrl 0 stepping through the same choices
and saving them: the keys and the setting are one number, never two
==================
*/
export function useTextScale( scales: number[] ) {
	const { settings, save } = useAppSettings();
	const scale = settings?.textScale;
	const mobile = useStore( ( s ) => s.constants?.mobile );

	useEffect( () => {
		if ( scale && mobile ) {
			// wry's android zoom method is a no-op; css zoom also scales touch targets
			document.documentElement.style.zoom = String( scale / 100 );
			document.documentElement.style.setProperty( "--app-zoom", String( scale / 100 ) );
			return () => {
				document.documentElement.style.zoom = "";
				document.documentElement.style.removeProperty( "--app-zoom" );
			};
		} else if ( scale && mobile === false ) {
			getCurrentWebview().setZoom( scale / 100 ).catch( ( e: unknown ) => console.error( "useTextScale", e ) );
		}
	}, [ scale, mobile ] );

	useEffect( () => {
		function Key( e: KeyboardEvent ) {
			if ( !e.ctrlKey || !scale || !scales.length ) {
				return;
			}
			const at = scales.indexOf( scale );
			let next: number | null = null;
			if ( e.key === "=" || e.key === "+" ) {
				next = scales[Math.min( at + 1, scales.length - 1 )];
			} else if ( e.key === "-" ) {
				next = scales[Math.max( at - 1, 0 )];
			} else if ( e.key === "0" ) {
				next = scales[0];
			}
			if ( next !== null ) {
				e.preventDefault();
				if ( next !== scale ) {
					void save.run( { textScale: next } );
				}
			}
		}
		window.addEventListener( "keydown", Key );
		return () => window.removeEventListener( "keydown", Key );
	}, [ scale, scales ] );
}

/*
==================
useNow

The time, updated every intervalMsec while mounted: for countdowns
==================
*/
export function useNow( intervalMsec: number ): number {
	const [ now, setNow ] = useState( () => Date.now() );

	useEffect( () => {
		const timer = setInterval( () => setNow( Date.now() ), intervalMsec );
		return () => clearInterval( timer );
	}, [ intervalMsec ] );

	return now;
}

/*
==================
useSize

An element's size, kept current as it resizes: for drawing to fit. The
element must be there from the first render (it is looked for once): a
part that comes and goes stays in the page, empty, as the chart's legend
does, or it is never measured.
==================
*/
export function useSize< E extends HTMLElement >() {
	const ref = useRef< E >( null );
	const [ size, setSize ] = useState( { width: 0, height: 0 } );

	useEffect( () => {
		const el = ref.current;
		if ( !el || typeof ResizeObserver === "undefined" ) {
			return;
		}
		const ro = new ResizeObserver( ( entries ) => {
			const r = entries[0].contentRect;
			setSize( { width: r.width, height: r.height } );
		} );
		ro.observe( el );
		return () => ro.disconnect();
	}, [] );

	return { ref, ...size };
}

