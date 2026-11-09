/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_chrome.tsx -- the window itself: the title bar Laurel draws, its
// lights, lock and theme buttons, the resize edges, and Laurel's marks
// (the leaf, the app icon, the sync dot and its words, the QR code with
// the leaf in it)
//
// Was also every shared widget and the payment pieces: 1,000 lines with
// three reasons to change. Widgets are ui_widgets.tsx; what a payment
// shows is ui_payment.tsx.

import { ReactNode, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { encode as QR_Encode } from "uqr";
import { Lock, Moon, Sun } from "lucide-react";
import { Com_Unreachable, syncProgress_t, syncState_t } from "./ui_local";
import { T } from "./ui_text";
import { useStore } from "./ui_store";
import { UI_Spinner, UI_Tip } from "./ui_widgets";

import LOGO_SMALL_SRC from "./assets/leaf-double-160.webp";
import LOGO_LARGE_SRC from "./assets/leaf-double-640.webp";

const LOGO_SMALL	= 80;				// up to this many css pixels wide, the 160 px file is sharp at 2x
const LOGO_ASPECT	= 987 / 1097;		// height / width of the leaf artwork

/*
=========================================================================

TITLE BAR

=========================================================================
*/

// windows gets its own caption buttons, on the right, the way every windows
// app has them; the rest of the window keeps the apple look
const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/.test( navigator.userAgent );

type resizeEdge_t = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

const RESIZE_EDGES: resizeEdge_t[] = [ "North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest" ];

/*
==================
Com_Back

Android's Back, as a phone means it: whatever is open on top (a sheet, a
popover, a menu) closes, as Escape closes it; else the screen's own Back
(a step, a settings pane) is pressed; else another page goes Home. True
when it did one; false at Home with nothing open, where Android may leave
(and leaving locks). It once left from anywhere, a sheet open or not
==================
*/
export function Com_Back(): boolean {
	const open = document.querySelector( "[role='dialog'][data-state='open'], [role='menu'][data-state='open'], [data-radix-popper-content-wrapper]" );
	if ( open ) {
		( document.activeElement ?? document.body ).dispatchEvent( new KeyboardEvent( "keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true } ) );
		return true;
	}
	const back = [ ...document.querySelectorAll< HTMLButtonElement >( "button.nav-back" ) ].find( ( b ) => !b.disabled && !b.closest( "[hidden], [aria-hidden='true'], [inert]" ) );
	if ( back ) {
		back.click();
		return true;
	}
	const store = useStore.getState();
	if ( store.page !== "home" ) {
		store.Go( "home" );
		return true;
	}
	return false;
}

/*
==================
UI_TitleBar

Laurel draws its own title bar. The whole strip drags the window; double
click zooms. Mac-style lights everywhere but windows, where users expect
minimize, maximize and close on the right. The controls go grey when the
window loses focus, as both systems do.
==================
*/
export function UI_TitleBar() {
	const [ focused, setFocused ] = useState( true );
	const mobile = useStore( ( s ) => s.constants?.mobile );
	useEffect( () => {
		document.documentElement.dataset.mobile = String( mobile );
	}, [ mobile ] );

	// Android's Back asks here first (MainActivity): leaving is only for Home
	useEffect( () => {
		if ( !mobile ) { return; }
		const w = window as unknown as { __laurelBack?: () => boolean };
		w.__laurelBack = Com_Back;
		return () => { delete w.__laurelBack; };
	}, [ mobile ] );

	useEffect( () => {
		if ( mobile !== false ) { return; }
		let unlisten: ( () => void ) | null = null;
		let dead = false;

		getCurrentWindow().onFocusChanged( ( e ) => setFocused( e.payload ) ).then( ( fn ) => {
			if ( dead ) {
				fn();
			} else {
				unlisten = fn;
			}
		} );
		return () => {
			dead = true;
			if ( unlisten ) {
				unlisten();
			}
		};
	}, [ mobile ] );

	const win = getCurrentWindow();

	const brand = (
		<div className="titlebar-brand">
			<UI_Logo size={18} />
			<span>{T.common.appName}</span>
		</div>
	);

	return (
		<>
			<div className={"titlebar" + ( focused ? "" : " blurred" ) + ( IS_WINDOWS ? " windows" : "" )} data-tauri-drag-region={!mobile || undefined}>
				{!mobile && !IS_WINDOWS && UI_Lights( win )}
				{brand}
				<div className="titlebar-tools">
					<UI_LockButton />
					{!mobile && <UI_ThemeButton />}{/* a phone's is in Settings > General: its bar holds the account */}
				</div>
				{!mobile && IS_WINDOWS && (
					<div className="captions">
						<button className="caption" aria-label="Minimize" onClick={() => win.minimize()}>
							<svg viewBox="0 0 10 10"><path d="M0 5h10" /></svg>
						</button>
						<button className="caption" aria-label="Maximize" onClick={() => win.toggleMaximize()}>
							<svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
						</button>
						<button className="caption close" aria-label="Close" onClick={() => win.close()}>
							<svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" /></svg>
						</button>
					</div>
				)}
			</div>
			{!mobile && <UI_ResizeEdges />}
		</>
	);
}

/*
==================
UI_Lights

The macOS traffic lights, for every system but Windows
==================
*/
function UI_Lights( win: ReturnType< typeof getCurrentWindow > ) {
	return (
		<div className="lights">
			<button className="light close" aria-label="Close" onClick={() => win.close()}>
				<svg viewBox="0 0 12 12"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" /></svg>
			</button>
			<button className="light minimize" aria-label="Minimize" onClick={() => win.minimize()}>
				<svg viewBox="0 0 12 12"><path d="M3 6h6" /></svg>
			</button>
			<button className="light zoom" aria-label="Zoom" onClick={() => win.toggleMaximize()}>
				<svg viewBox="0 0 12 12"><path d="M3.5 5.5v-2h2M8.5 6.5v2h-2" /></svg>
			</button>
		</div>
	);
}

/*
==================
UI_LockButton

Only when a password guards the key (a key the system unlocks would just
open again) and only while unlocked
==================
*/
function UI_LockButton() {
	const vault	= useStore( ( s ) => s.vault );
	const lock	= useStore( ( s ) => s.Lock );
	const [ busy, setBusy ] = useState( false );

	if ( vault?.protection !== "password" || vault.state !== "unlocked" ) {
		return null;
	}

	async function LockNow() {
		setBusy( true );
		await lock();
		setBusy( false );
	}

	return (
		<UI_Tip label={T.chrome.lock}>
			<button className="titlebar-btn" aria-label={T.chrome.lock} disabled={busy} onClick={LockNow}>
				{busy ? <UI_Spinner size={13} /> : <Lock aria-hidden="true" />}
			</button>
		</UI_Tip>
	);
}

/*
==================
UI_ThemeButton

Flips between light and dark in one click. Which one is showing is read
from the page, so "Auto" is handled too: it pins the opposite of what
the system chose. Settings has the full choice, Auto included.
==================
*/
function UI_ThemeButton() {
	const setAppearance	= useStore( ( s ) => s.SetAppearance );
	const appearance	= useStore( ( s ) => s.appearance );
	const dark			= appearance === "dark" || ( appearance === "system" && Com_SystemIsDark() );
	const label			= dark ? T.chrome.toLight : T.chrome.toDark;

	return (
		<UI_Tip label={label}>
			<button className="titlebar-btn" aria-label={label} onClick={() => setAppearance( dark ? "light" : "dark" )}>
				{dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
			</button>
		</UI_Tip>
	);
}

/*
==================
Com_SystemIsDark
==================
*/
function Com_SystemIsDark(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia( "(prefers-color-scheme: dark)" ).matches;
}

/*
==================
UI_ResizeEdges

A frameless window has no system border to grab, so thin invisible
strips along each edge and corner start a resize
==================
*/
function UI_ResizeEdges() {
	const win = getCurrentWindow();

	return (
		<>
			{RESIZE_EDGES.map( ( edge ) => (
				// eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the window's edges are for the mouse; a keyboard resizes with Windows' own keys (Win+arrows)
				<div
					key={edge}
					className={"resize resize-" + edge.toLowerCase()}
					onMouseDown={( e ) => { if ( e.button === 0 ) win.startResizeDragging( edge ); }}
				/>
			) )}
		</>
	);
}


/*
=========================================================================

MARKS

=========================================================================
*/

/*
==================
Com_SyncLabel

What each sync state says, in one place
==================
*/
export function Com_SyncLabel( state: syncState_t, p: syncProgress_t | undefined ): string {
	switch ( state ) {
	case "connecting":	return T.sync.connecting;
	case "retrying":	return T.sync.retrying;
	case "syncing":		return p?.repairing ? T.sync.repairing : T.sync.syncing( p?.percent ?? 0 );
	case "synced":		return T.sync.synced;
	case "offline":		return T.sync.offline;
	case "paused":		return T.sync.paused;
	default:			return Com_Unreachable( state );
	}
}

/*
==================
UI_SyncDot

A small light: green when up to date, amber offline, pulsing while it works
==================
*/
export function UI_SyncDot( props: { state: syncState_t } ) {
	return <span className={"sync-dot " + props.state} aria-hidden="true" />;
}

/*
==================
UI_Logo

The brand leaves (docs/design). Small sizes load the small file, so
the sidebar never decodes the big one.
==================
*/
export function UI_Logo( props: { size: number; className?: string } ) {
	return (
		<img
			className={props.className}
			src={props.size > LOGO_SMALL ? LOGO_LARGE_SRC : LOGO_SMALL_SRC}
			width={props.size}
			height={Math.round( props.size * LOGO_ASPECT )}
			alt=""
			draggable={false}
		/>
	);
}

/*
==================
UI_AppIcon

The rounded-square app icon used on first run
==================
*/
export function UI_AppIcon( props: { size: number } ) {
	return (
		<div className="app-icon" style={{ width: props.size, height: props.size }}>
			<UI_Logo size={Math.round( props.size * 0.68 )} />
		</div>
	);
}

/*
==================
UI_QR

A QR code drawn as rounded dots with rounded finder squares and the leaf
in the middle, the way apple draws them. High error correction keeps it
readable with the centre covered: level Q restores a quarter of the
code, far more than the leaf hides, with fewer and bigger dots than H.
==================
*/
export function UI_QR( props: { text: string; size: number } ) {
	const qr = useMemo( () => QR_Encode( props.text, { ecc: "Q", border: 0 } ), [ props.text ] );
	const n = qr.size;
	const finder = ( x: number, y: number ) => ( x < 7 && y < 7 ) || ( x >= n - 7 && y < 7 ) || ( x < 7 && y >= n - 7 );
	const hole = ( x: number, y: number ) => Math.abs( x - ( n - 1 ) / 2 ) < n * 0.1 && Math.abs( y - ( n - 1 ) / 2 ) < n * 0.1;

	const dots: ReactNode[] = [];
	qr.data.forEach( ( row, y ) => row.forEach( ( on, x ) => {
		if ( on && !finder( x, y ) && !hole( x, y ) ) {
			dots.push( <circle key={`${x}-${y}`} cx={x + 0.5} cy={y + 0.5} r={0.42} /> );
		}
	} ) );

	const eye = ( x: number, y: number ) => (
		<g key={`eye-${x}-${y}`}>
			<rect x={x + 0.5} y={y + 0.5} width={6} height={6} rx={1.8} className="qr-eye-ring" />
			<rect x={x + 2} y={y + 2} width={3} height={3} rx={0.9} />
		</g>
	);
	const leaf = n * 0.16;

	return (
		<svg className="qr" width={props.size} height={props.size} viewBox={`-1 -1 ${n + 2} ${n + 2}`} role="img" aria-label="QR code">
			{dots}
			{eye( 0, 0 )}{eye( n - 7, 0 )}{eye( 0, n - 7 )}
			<image href={LOGO_SMALL_SRC} x={( n - leaf ) / 2} y={( n - leaf * LOGO_ASPECT ) / 2} width={leaf} height={leaf * LOGO_ASPECT} />
		</svg>
	);
}
