/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_widgets.tsx -- the small shared pieces every screen uses: spinner,
// waits, alert, switch, copy, info and tip, amount, segmented
// control and sheet. Nothing here knows about wallets or payments.
//
// Radix supplies behaviour (focus, keyboard, screen readers) with no
// styling of its own; the look is all ui.css. Motion supplies the springs.

import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CircleAlert, Copy as CopyIcon, Info, Lightbulb, TriangleAlert } from "lucide-react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import { Com_ErrorOf, Com_FormatZec, errorInfo_t } from "./ui_local";
import { T } from "./ui_text";
import { useStore } from "./ui_store";
import { useAction } from "./ui_hooks";

const COPIED_MSEC	= 1600;		// how long "Copied" shows
const SPINNER_BARS	= 12;

// the one spring every moving thing uses, so they all feel the same
export const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.9 } as const;

// every box a secret is typed into (a phrase, a passphrase, a key, a password, a sync
// code), spread on it: a phone keyboard neither suggests, keeps, corrects nor
// capitalizes what's typed. Written by hand per box, the viewing key's and the backup
// check's passphrase each missed one (a capital first letter fails a passphrase)
export const SECRET_FIELD = { spellCheck: false, autoComplete: "off", autoCapitalize: "off", autoCorrect: "off" } as const;

/*
==================
UI_Slots

A whole sentence with things in it (an amount, a name): the language's
text says where each goes ("{now} can be sent now"), so a translation
puts them where its grammar wants, never in the order a screen glued
pieces together. A slot the sentence doesn't name is a bug in the text;
it shows as its name, so it's seen.
==================
*/
export function UI_Slots( props: { text: string; slots: Record< string, ReactNode > } ) {
	return (
		<>
			{props.text.split( /\{(\w+)\}/ ).map( ( part, i ) => i % 2
				? <span key={i}>{props.slots[part] ?? `{${part}}`}</span>
				: part )}
		</>
	);
}

/*
=========================================================================

INDICATORS

=========================================================================
*/

/*
==================
UI_Spinner

The classic activity indicator: twelve bars fading in turn
==================
*/
export function UI_Spinner( props: { size?: number } ) {
	const size = props.size ?? 16;

	return (
		<span className="spinner" style={{ width: size, height: size }} role="progressbar" aria-label="Working">
			{Array.from( { length: SPINNER_BARS }, ( _, i ) => (
				<span
					key={i}
					style={{
						transform:		`rotate(${i * ( 360 / SPINNER_BARS )}deg)`,
						animationDelay:	`${( i - SPINNER_BARS ) / SPINNER_BARS}s`,
					}}
				/>
			) )}
		</span>
	);
}

/*
==================
UI_Alert

An error the user can act on: what went wrong, and a way to try again
==================
*/
export function UI_Alert( props: {
	title:		string;
	message:	string | errorInfo_t;
	action?:	string;
	onAction?:	() => void;
} ) {
	const [ open, setOpen ] = useState( false );
	const e = typeof props.message === "string" ? { message: props.message, detail: null } : props.message;

	return (
		<div className="alert" role="alert">
			<CircleAlert className="alert-icon" aria-hidden="true" />
			<div className="alert-body">
				<div className="alert-title">{props.title}</div>
				<div className="alert-message">{e.message}</div>
				{e.detail && open && <pre className="alert-detail">{e.detail}</pre>}
				<div className="alert-actions">
					{props.action && props.onAction && (
						<button className="link" onClick={props.onAction}>{props.action}</button>
					)}
					{e.detail && (
						<button className="link quiet" aria-expanded={open} onClick={() => setOpen( !open )}>
							{open ? T.common.hideDetails : T.common.details}
						</button>
					)}
					{e.detail && open && <UI_CopyButton text={e.detail} label={T.common.copyDetails} quiet />}
				</div>
			</div>
		</div>
	);
}

/*
==================
UI_Working

What is happening while a payment is built and sent, where its details
were: in words, how long so far, and why there is no Cancel. Never a
spinner floating alone in an empty sheet.
==================
*/
// how long a wait goes unremarked, and how long before it says why it can be slow
const WAIT_SAY_SECS		= 4;
const WAIT_SLOW_SECS	= 20;

/*
==================
UI_Waiting

Every wait with words ("Getting your address..."): a spinner and the
words, then how long it has been, ticking, so it plainly isn't stuck,
then why it can take a while. A spinner with fixed words looked hung
after twenty seconds. The time counts from when this is drawn: give it
a new key for a new step.
==================
*/
// block: standing on its own under what started it, as a card; else inline, in a button or a line
export function UI_Waiting( props: { text: string; size?: number; block?: boolean } ) {
	const [ since ] = useState( () => Date.now() );
	const [ now, setNow ] = useState( since );
	useEffect( () => {
		const timer = setInterval( () => setNow( Date.now() ), 1000 );
		return () => clearInterval( timer );
	}, [] );
	const secs = Math.floor( ( now - since ) / 1000 );

	return (
		<span className={"waiting" + ( props.block ? " block" : "" )} role="status">
			<UI_Spinner size={props.size ?? 14} />
			<span className="waiting-text">
				{props.text}
				{secs >= WAIT_SAY_SECS && <span className="waiting-time"> · {T.common.waited( secs )}</span>}
				{secs >= WAIT_SLOW_SECS && <span className="waiting-slow">{T.common.stillWorking}</span>}
			</span>
		</span>
	);
}

export function UI_Working( props: { since: number; title: string; hint: ( secs: number ) => string } ) {
	const [ now, setNow ] = useState( () => Date.now() );
	useEffect( () => {
		const timer = setInterval( () => setNow( Date.now() ), 1000 );
		return () => clearInterval( timer );
	}, [] );
	const secs = Math.max( 0, Math.round( ( now - props.since ) / 1000 ) );

	return (
		<div className="work-note" role="status">
			<UI_Spinner size={16} />
			<span className="work-text">
				<span className="work-title">{props.title}</span>
				<span className="work-sub">{props.hint( secs )}</span>
			</span>
		</div>
	);
}

/*
==================
UI_Switch

On or off, said as a switch (role switch), the way system settings do
==================
*/
export function UI_Switch( props: { checked: boolean; onChange: ( on: boolean ) => void; label: string; busy?: boolean } ) {
	return (
		<button
			role="switch"
			aria-checked={props.checked}
			aria-label={props.label}
			className={"switch" + ( props.checked ? " on" : "" )}
			disabled={props.busy}
			onClick={() => props.onChange( !props.checked )}
		>
			<span className="switch-knob" />
		</button>
	);
}

/*
==================
UI_CopyButton

Copies, and says so for a moment. The one place Laurel writes to the
clipboard (scripts/check_owners.mjs). quiet: a link, for inside an alert.
==================
*/
export function UI_CopyButton( props: { text: string; label?: string; quiet?: boolean } ) {
	const [ copied, setCopied ] = useState( false );

	async function Copy() {
		await navigator.clipboard.writeText( props.text );
		setCopied( true );
		setTimeout( () => setCopied( false ), COPIED_MSEC );
	}

	if ( props.quiet ) {
		return <button className="link quiet" onClick={Copy}>{copied ? T.common.copied : props.label ?? T.common.copy}</button>;
	}
	return (
		<button className="btn primary" onClick={Copy}>
			{copied ? <Check aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
			{copied ? T.common.copied : props.label ?? T.receive.copy}
		</button>
	);
}

/*
==================
UI_Empty

A place with nothing to show yet, or nothing it can show: an icon, what
it is, what to do next. Never a red alert: a chart that couldn't be
drawn is a state of the chart (the Value side once said a plain fact,
test coins have no price, as "Couldn't Work Out the Value" in red).
tone: warn for a failure worth another try, quiet for a plain fact.
==================
*/
export function UI_Empty( props: { icon?: ReactNode; tone?: "warn" | "quiet"; title?: string; text?: string; children?: ReactNode } ) {
	return (
		<div className="chart-empty">
			{props.icon && <span className={"chart-empty-icon" + ( props.tone ? " " + props.tone : "" )}>{props.icon}</span>}
			{props.title && <span className="chart-empty-title">{props.title}</span>}
			{props.text && <span className="chart-empty-text">{props.text}</span>}
			{props.children}
		</div>
	);
}

// a read that failed, where its answer would be: what couldn't be read, why, and another try
export function UI_LoadFailed( props: { title: string; error: unknown; onRetry: () => void; icon?: ReactNode } ) {
	return (
		<UI_Empty icon={props.icon ?? <TriangleAlert aria-hidden="true" />} tone="warn" title={props.title} text={Com_ErrorOf( props.error ).message}>
			<button className="btn" onClick={props.onRetry}>{T.common.tryAgain}</button>
		</UI_Empty>
	);
}

/*
==================
UI_Info

The little (i) that opens a short explanation. Explanations stay out of
the way until someone wants them.
==================
*/
export function UI_Info( props: { title: string; children: ReactNode } ) {
	return (
		<Popover.Root>
			<Popover.Trigger className="info-btn" aria-label={props.title}>
				<Info aria-hidden="true" />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content className="popover" side="bottom" sideOffset={10} collisionPadding={16}>
					<div className="popover-badge"><Lightbulb aria-hidden="true" /></div>
					<div className="popover-text">
						<div className="popover-title">{props.title}</div>
						<div className="popover-body">{props.children}</div>
					</div>
					<Popover.Arrow className="popover-arrow" width={16} height={8} />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/*
==================
UI_Tip

A label that appears on hover, for buttons that are only an icon. The
system's own title tooltips look like 1998; these match the app.
The child must be a single element that takes a ref (a button).
==================
*/
export function UI_Tip( props: { label: string; children: ReactNode; side?: "top" | "bottom" } ) {
	return (
		<Tooltip.Root>
			<Tooltip.Trigger asChild>{props.children}</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content className="tip" side={props.side ?? "bottom"} sideOffset={6} collisionPadding={12}>
					{props.label}
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
	);
}

/*
==================
UI_TipProvider

One shared delay for every tip: the first waits, the next ones along a
row show at once, like macOS
==================
*/
export function UI_TipProvider( props: { children: ReactNode } ) {
	return <Tooltip.Provider delayDuration={450} skipDelayDuration={300}>{props.children}</Tooltip.Provider>;
}


/*
==================
UI_Amount

Every ZEC amount on screen goes through here, so "hide balance" can't
miss one. Hidden amounts keep their place with dots, like a password.
==================
*/
export function UI_Amount( props: { zats: number | undefined; unit?: boolean; prefix?: string } ) {
	const hidden = useStore( ( s ) => s.hideAmounts );
	const text = props.zats === undefined ? "–" : hidden ? "••••" : Com_FormatZec( props.zats );

	return (
		<>
			{props.prefix}{text}
			{props.unit && <span className="unit">{T.common.zec}</span>}
		</>
	);
}

/*
=========================================================================

CONTROLS

=========================================================================
*/

/*
==================
UI_Segmented

The pill-shaped segmented control. The white thumb slides between
options on the shared spring.
==================
*/
export function UI_Segmented< V extends string | number >( props: {
	options:	readonly { value: V; label: string; icon?: ReactNode }[];
	value:		V;
	onChange:	( v: V ) => void;
	small?:		boolean;
	full?:		boolean;
	id?:		string;
} ) {
	const box = useRef< HTMLDivElement >( null );
	const [ thumb, setThumb ] = useState< { x: number; w: number } | null >( null );
	const index = props.options.findIndex( ( o ) => o.value === props.value );

	// the thumb sits under the chosen button, measured by offset: offsets
	// ignore transforms, so a control inside a sheet that is still sliding
	// in gets its thumb in place at once, instead of floating after it
	useLayoutEffect( () => {
		const el = box.current;
		if ( !el ) {
			return;
		}
		const Measure = () => {
			const b = el.querySelectorAll< HTMLElement >( ":scope > button" )[index];
			setThumb( b ? { x: b.offsetLeft, w: b.offsetWidth } : null );
		};
		Measure();
		if ( typeof ResizeObserver === "undefined" ) {
			return;
		}
		const ro = new ResizeObserver( Measure );
		ro.observe( el );
		return () => ro.disconnect();
	}, [ index, props.options.length ] );

	return (
		<div ref={box} id={props.id} className={"segmented" + ( props.small ? " small" : "" ) + ( props.full ? " full" : "" )} role="tablist">
			{thumb && <motion.span className="segmented-thumb" initial={false} animate={{ x: thumb.x, width: thumb.w }} transition={SPRING} />}
			{props.options.map( ( o ) => {
				const on = o.value === props.value;
				return (
					<button key={String( o.value )} role="tab" aria-selected={on} className={on ? "on" : ""} onClick={() => props.onChange( o.value )}>
						{o.icon}<span className="segmented-label">{o.label}</span>
					</button>
				);
			} )}
		</div>
	);
}

/*
==================
UI_Choices

One of a few, as one grouped list the way system settings draw one: a
row each, with its coloured icon, a name, a line saying what it means
and a check on the chosen one. What the chosen one needs next (a month,
a number) opens inside its row. A segmented control's words wrapped
letter by letter on a phone once each needed a sentence
==================
*/
export type choice_t< V extends string > = {
	value:		V;
	name:		string;
	sub:		string;
	icon:		ReactNode;
	tone:		"green" | "blue" | "violet";
	badge?:		string;
	more?:		ReactNode;		// shown inside the row while it's chosen
};

export function UI_Choices< V extends string >( props: {
	label:		string;
	options:	readonly choice_t< V >[];
	value:		V;
	onChange:	( v: V ) => void;
} ) {
	return (
		<div className="choice-list" role="radiogroup" aria-label={props.label}>
			{props.options.map( ( o ) => {
				const on = o.value === props.value;
				return (
					<div key={o.value} className={"choice-row" + ( on ? " on" : "" )}>
						<button role="radio" aria-checked={on} className="choice-item" onClick={() => props.onChange( o.value )}>
							<span className={"choice-icon tone-" + o.tone}>{o.icon}</span>
							<span className="choice-text">
								<span className="choice-name">{o.name}{o.badge && <span className="choice-badge">{o.badge}</span>}</span>
								<span className="choice-sub">{o.sub}</span>
							</span>
							<span className="choice-check">{on && <Check aria-hidden="true" />}</span>
						</button>
						{on && o.more && <div className="choice-more">{o.more}</div>}
					</div>
				);
			} )}
		</div>
	);
}

/*
==================
UI_Sheet

A dialog that rises into place, like a sheet on a mac. Escape, the
close button or a click outside all close it, unless it is busy: a sheet
waiting on the engine stays until the engine answers. Closed, it gives
the keyboard's focus back to what had it when it opened: sheets open from
state, not a Radix trigger, and Radix without a trigger dropped focus on
the page's start (ui_keyboard.test.tsx).
==================
*/
const SHEET_FIELD = "input:not( [type=hidden] ):not( [type=checkbox] ):not( [type=radio] ):not( :disabled ), textarea:not( :disabled )";

/*
==================
Com_SheetFocus

Where focus lands as a sheet opens: its first text field, to type into,
or else the sheet itself. Never a button: focused on open, a button drew
the keyboard's focus ring before anyone had touched the keyboard, and
Enter would have pressed it. Tab still reaches every button.
==================
*/
function Com_SheetFocus( e: Event ) {
	e.preventDefault();
	const sheet = e.currentTarget as HTMLElement;
	( sheet.querySelector< HTMLElement >( SHEET_FIELD ) ?? sheet ).focus();
}

export function UI_Sheet( props: {
	open:			boolean;
	onOpenChange:	( open: boolean ) => void;
	title:			string;
	description?:	string;
	busy?:			boolean;
	hero?:			ReactNode;		// above the title: a picture of what the sheet is about
	className?:		string;			// a kind of sheet with its own look
	children:		ReactNode;
} ) {
	function Change( open: boolean ) {
		if ( !open && props.busy ) {
			return;
		}
		props.onOpenChange( open );
	}

	// what had the focus as it opened: a layout effect runs before Radix moves focus inside
	const opener = useRef< HTMLElement | null >( null );
	useLayoutEffect( () => {
		if ( props.open ) {
			opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		}
	}, [ props.open ] );

	return (
		<Dialog.Root open={props.open} onOpenChange={Change}>
			<AnimatePresence>
				{props.open && (
					<Dialog.Portal forceMount>
						<Dialog.Overlay asChild forceMount>
							<motion.div className="sheet-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
						</Dialog.Overlay>
						<Dialog.Content asChild forceMount onOpenAutoFocus={Com_SheetFocus} onCloseAutoFocus={( e ) => { e.preventDefault(); opener.current?.focus(); }}>
							<motion.div
								className={"sheet" + ( props.className ? " " + props.className : "" )}
								initial={{ opacity: 0, y: 24, scale: 0.97 }}
								animate={{ opacity: 1, y: 0, scale: 1 }}
								exit={{ opacity: 0, y: 12, scale: 0.98 }}
								transition={SPRING}
							>
								{props.hero}
								<Dialog.Title className="sheet-title">{props.title}</Dialog.Title>
								{props.description
									? <Dialog.Description className="sheet-desc">{props.description}</Dialog.Description>
									: <Dialog.Description className="sr-only">{props.title}</Dialog.Description>}
								{props.children}
							</motion.div>
						</Dialog.Content>
					</Dialog.Portal>
				)}
			</AnimatePresence>
		</Dialog.Root>
	);
}

// every sheet takes these two, whatever else it needs
export type sheetProps_t = {
	open:			boolean;
	onOpenChange:	( open: boolean ) => void;
};

/*
==================
UI_ChipSet

One group of choices as chips under its name: Pools, Status... The
caller says which are on and what a press does, so one set picks one
value and another toggles many, the chips alike
==================
*/
export type chip_t< V extends string > = { value: V; label: string; icon?: ReactNode; className?: string };

export function UI_ChipSet< V extends string >( props: { label: string; options: readonly chip_t< V >[]; on: ( v: V ) => boolean; onPick: ( v: V ) => void } ) {
	return (
		<div className="chip-set" role="group" aria-label={props.label}>
			<span className="chip-set-label">{props.label}</span>
			<div className="chip-set-chips">
				{props.options.map( ( o ) => (
					<button key={o.value} aria-pressed={props.on( o.value )} className={"filter-chip" + ( o.className ? " " + o.className : "" ) + ( props.on( o.value ) ? " on" : "" )} onClick={() => props.onPick( o.value )}>
						{o.icon}{o.label}
					</button>
				) )}
			</div>
		</div>
	);
}

/*
==================
UI_Popover

A button that opens a panel of controls under it, in the (i)'s popover
look: what's chosen there applies at once, and a click outside closes it
==================
*/
export function UI_Popover( props: { label: string; trigger: ReactNode; className: string; children: ReactNode } ) {
	return (
		<Popover.Root>
			<Popover.Trigger className={props.className}>{props.trigger}</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content className="popover controls" aria-label={props.label} side="bottom" align="end" sideOffset={8} collisionPadding={16}>
					{props.children}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/*
==================
UI_ActionTile

One thing that can be done, as a tile: its icon, a word or two, and a
line saying what it does. One that can't be done right now is still
there, muted and not pressable, its line saying why: an action never
just goes missing, and never sits disabled without a reason. One with
more to say carries an (i) in its corner, beside the tile, not inside it
==================
*/
export function UI_ActionTile( props: { icon: ReactNode; title: string; sub: string; onClick?: () => void; primary?: boolean; info?: { title: string; body: ReactNode } } ) {
	const inner = (
		<>
			<span className="tile-icon">{props.icon}</span>
			<span className="tile-title">{props.title}</span>
			<span className="tile-sub">{props.sub}</span>
		</>
	);
	const tile = props.onClick
		? <button className={"tile" + ( props.primary ? " primary" : "" )} onClick={props.onClick}>{inner}</button>
		: <div className="tile muted">{inner}</div>;
	if ( !props.info ) {
		return tile;
	}
	return (
		<div className="tile-wrap">
			{tile}
			<span className="tile-info"><UI_Info title={props.info.title}>{props.info.body}</UI_Info></span>
		</div>
	);
}

/*
==================
UI_SheetWait

A sheet waiting on something (a quote, coins being found), with a way
out: the wait alone, with no button, once looked like the sheet had
locked up. A wait that's asked again on a passing state says which
(the error's own words), else what it does
==================
*/
export function UI_SheetWait( props: { text: string; retrying: unknown; onClose: () => void } ) {
	return (
		<>
			<div className="sheet-loading"><UI_Waiting text={props.retrying ? Com_ErrorOf( props.retrying ).message : props.text} size={20} /></div>
			<UI_SheetClose onClose={props.onClose} />
		</>
	);
}

/*
==================
UI_SheetClose

The footer of a sheet with nothing to confirm: one button that closes it
==================
*/
export function UI_SheetClose( props: { onClose: () => void; label?: string; primary?: boolean; large?: boolean; children?: ReactNode } ) {
	return (
		<div className="sheet-buttons">
			{props.children}
			<button className={"btn" + ( props.primary ? " primary" : "" ) + ( props.large ? " large" : "" )} onClick={props.onClose}>{props.label ?? T.common.close}</button>
		</div>
	);
}

export type sheetAction_t = {
	label:		string;
	onRun:		() => void;
	running?:	boolean;		// this action's own work: a spinner in place of its icon (default: the sheet's busy)
	icon?:		ReactNode;
	danger?:	boolean;		// it destroys something: red, not the accent
};

/*
==================
UI_SheetButtons

The way back and the action, the same at the bottom of every sheet (the
only place a sheet's footer is drawn: scripts/check_owners.mjs). The
action is never dead: it runs, and the sheet shows why if it can't; with
nothing to do yet (null) it isn't there at all.
==================
*/
export function UI_SheetButtons( props: {
	action:		sheetAction_t | null;
	busy:		boolean;				// any of the sheet's work: nothing starts twice
	onCancel?:	() => void;				// absent: the sheet's own close is the way back
	cancel?:	string;					// default: Cancel
	children?:	ReactNode;				// more buttons, between the two
} ) {
	const a = props.action;
	return (
		<div className="sheet-buttons">
			{props.onCancel && <button className="btn" disabled={props.busy} onClick={props.onCancel}>{props.cancel ?? T.common.cancel}</button>}
			{props.children}
			{a && (
				<button className={"btn " + ( a.danger ? "danger" : "primary" )} disabled={props.busy} onClick={a.onRun}>
					{( a.running ?? props.busy ) ? <UI_Spinner size={13} /> : a.icon}{a.label}
				</button>
			)}
		</div>
	);
}

/*
==================
UI_ConfirmSheet

"Are you sure" for something that can't be taken back: what it does,
why it might fail, and a red button. Stop Syncing, Forget a computer,
and Forget a request were each this sheet written out again.
==================
*/
export function UI_ConfirmSheet( props: sheetProps_t & { title: string; description: string; action: string; failed: string; onConfirm: () => Promise< unknown > } ) {
	const confirm = useAction( async () => {
		await props.onConfirm();
		props.onOpenChange( false );
	}, props.open );
	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={props.title} description={props.description} busy={confirm.busy}>
			{confirm.error && <UI_Alert title={props.failed} message={confirm.error} />}
			<UI_SheetButtons busy={confirm.busy} onCancel={() => props.onOpenChange( false )} action={{ label: props.action, onRun: () => void confirm.run(), danger: true }} />
		</UI_Sheet>
	);
}
