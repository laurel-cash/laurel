/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_security.tsx -- the lock screen, choosing a password, the password
// offer after backup, and the security settings
//
// The engine owns every rule (length, what protects the key); the checks
// here only say early what the engine would say anyway. Passwords live in
// component state for as short a time as possible and are cleared after
// use; javascript gives no stronger guarantee than that.

import { useEffect, useRef, useState } from "react";
import { Check, DoorOpen, Eye, EyeOff, KeyRound, Lock, LockKeyhole, ShieldCheck, TimerReset } from "lucide-react";

import { commands, errorInfo_t, vaultStatus_t, PREF_OFFERED, Com_IsBool, Com_ClearPrefs, Com_ReadPref, Com_WritePref } from "./ui_local";
import { T } from "./ui_text";
import { useAction, useAppSettings } from "./ui_hooks";
import { KEYS, QUERY } from "./ui_query";
import { useStore } from "./ui_store";
import { SECRET_FIELD, sheetProps_t, UI_Alert, UI_ConfirmSheet, UI_Info, UI_Sheet, UI_SheetButtons, UI_Spinner, UI_Waiting } from "./ui_widgets";
import { UI_AppIcon } from "./ui_chrome";

type passwordMode_t = "set" | "change" | "remove";



/*
=========================================================================

PIECES

=========================================================================
*/

/*
==================
UI_PasswordField

With a show/hide eye. Never autocompleted or spell-checked: neither the
browser engine nor a dictionary should see it.
==================
*/
function UI_PasswordField( props: {
	id:			string;
	label:		string;
	value:		string;
	onChange:	( v: string ) => void;
	onSubmit?:	() => void;
	autoFocus?:	boolean;
	fieldRef?:	React.RefObject< HTMLInputElement | null >;
} ) {
	const [ shown, setShown ] = useState( false );

	return (
		<div className="password-row">
			<label className="label" htmlFor={props.id}>{props.label}</label>
			<div className="password-field">
				<input
					ref={props.fieldRef}
					id={props.id}
					className="field"
					type={shown ? "text" : "password"}
					value={props.value}
					autoFocus={props.autoFocus}
					{...SECRET_FIELD}
					onChange={( e ) => props.onChange( e.target.value )}
					onKeyDown={( e ) => { if ( e.key === "Enter" ) props.onSubmit?.(); }}
				/>
				<button type="button" className="icon-btn" aria-label={shown ? T.security.hide : T.security.show} onClick={() => setShown( !shown )}>
					{shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
				</button>
			</div>
		</div>
	);
}

/*
==================
Com_NewPasswordProblem

What is wrong with a new password and its confirmation, or null
==================
*/
function Com_NewPasswordProblem( password: string, confirm: string, minLen: number ): string | null {
	if ( [ ...password ].length < minLen || !password.trim() ) {
		return T.security.tooShort( minLen );
	}
	if ( password !== confirm ) {
		return T.security.mismatch;
	}
	return null;
}

/*
==================
Com_PasswordStrength / Com_PasswordHint

A hint, never a rule: the engine's one rule is the length (V_CheckPassword),
and a weak password is still the person's choice. Weak: few different
characters, or little left once the most common passwords are taken out.
Strong: four or more words, or long and mixed. Worked out here, on this
device: the password goes nowhere to be judged
==================
*/
export type strength_t = "weak" | "fair" | "strong";

const COMMON_PASSWORDS = [ "password", "passw0rd", "12345678", "123456", "qwertyuiop", "qwerty", "letmein", "iloveyou", "welcome", "admin", "monkey", "dragon", "abc123", "111111", "laurel", "zcash", "bitcoin" ];

export function Com_PasswordStrength( password: string ): strength_t {
	const chars		= [ ...password ];
	const left		= COMMON_PASSWORDS.reduce( ( s, c ) => s.split( c ).join( "" ), password.toLowerCase() );
	const words		= password.trim().split( /\s+/ ).filter( ( w ) => [ ...w ].length >= 3 );
	const kinds		= [ /[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9\s]/ ].filter( ( r ) => r.test( password ) ).length;

	if ( new Set( chars ).size < 5 || [ ...left ].length < 4 ) {
		return "weak";
	}
	if ( words.length >= 4 || ( chars.length >= 16 && kinds >= 2 ) || chars.length >= 20 ) {
		return "strong";
	}
	return chars.length >= 12 || kinds >= 3 ? "fair" : "weak";
}

// the line under a new password: the length until it's long enough, then how strong
function Com_PasswordHint( password: string, minLen: number ): { text: string; tone: string } {
	if ( [ ...password ].length < minLen ) {
		return { text: T.security.minLength( minLen ), tone: "" };
	}
	const strength = Com_PasswordStrength( password );
	return { text: T.security.strength[strength], tone: strength === "weak" ? " warn" : "" };
}

// lost storage only means the offer shows once more, which is harmless
const Com_Offered		= () => Com_ReadPref( PREF_OFFERED, false, Com_IsBool );
export const Com_MarkOffered	= () => Com_WritePref( PREF_OFFERED, true );

/*
==================
Com_ShouldOfferPassword

After a first backup, when only windows protects the key and the offer
hasn't been made yet on this computer
==================
*/
export function Com_ShouldOfferPassword( vault: vaultStatus_t | null ): boolean {
	return !!vault && vault.protection === "os" && !Com_Offered();
}


/*
=========================================================================

FULL SCREENS

=========================================================================
*/

/*
==================
Com_StartOver

Start Over (W_StartOver): this browser's prefs first (Com_ClearPrefs),
then the engine erases its files and opens Laurel again. If the engine
refuses, only defaults were lost
==================
*/
async function Com_StartOver() {
	Com_ClearPrefs();
	await commands.wStartOverF();
}

/*
==================
UI_LockScreen

A forgotten password ends in Start Over: a reinstall keeps the data
folder, and with it the same lock screen (W_StartOver)
==================
*/
export function UI_LockScreen() {
	const setVault = useStore( ( s ) => s.SetVault );
	const [ password, setPassword ] = useState( "" );
	const [ nudge, setNudge ] = useState< string | null >( null );
	const [ startOver, setStartOver ] = useState( false );
	const field = useRef< HTMLInputElement >( null );

	const unlock = useAction( async () => {
		const status = await commands.vUnlockF( password );
		setPassword( "" );
		setVault( status );
	} );

	function Submit() {
		if ( !password ) {
			setNudge( T.security.missingCurrent );
			field.current?.focus();
			return;
		}
		setNudge( null );
		unlock.run().then( () => {
			if ( !useStore.getState().vault || useStore.getState().vault?.state !== "unlocked" ) {
				field.current?.select();		// wrong password: ready to retype
			}
		} );
	}

	return (
		<div className="onboard">
			<div className="onboard-card">
				<UI_AppIcon size={72} />
				<h1 className="onboard-title">{T.security.lockedTitle}</h1>
				<p className="lede center">{T.security.locked}</p>

				<div className="lock-form">
					<UI_PasswordField id="unlock" label={T.security.password} value={password} onChange={setPassword} onSubmit={Submit} autoFocus fieldRef={field} />
					{( nudge || unlock.error ) && <p className="phrase-status bad">{nudge ?? unlock.error?.message}</p>}
				</div>

				<div className="onboard-actions">
					<button className="btn primary large" disabled={unlock.busy} onClick={Submit}>
						{unlock.busy ? <><UI_Waiting text={T.security.unlocking} size={16} /></> : T.security.unlock}
					</button>
					<button className="link" onClick={() => setStartOver( true )}>{T.security.forgotTitle}</button>
				</div>
			</div>
			<UI_ConfirmSheet
				open={startOver}
				onOpenChange={setStartOver}
				title={T.security.forgotTitle}
				description={T.security.startOverText}
				action={T.security.startOverAction}
				failed={T.security.startOverFailed}
				onConfirm={Com_StartOver}
			/>
		</div>
	);
}

/*
==================
UI_CreatePasswordScreen

First run on a system with no key store: a password is the only
protection available, so it isn't optional here
==================
*/
export function UI_CreatePasswordScreen() {
	const setVault	= useStore( ( s ) => s.SetVault );
	const minLen	= useStore( ( s ) => s.vault?.minPasswordLen ?? 8 );
	const [ password, setPassword ]	= useState( "" );
	const [ confirm, setConfirm ]	= useState( "" );
	const [ nudge, setNudge ]		= useState< string | null >( null );

	const create = useAction( async () => {
		const status = await commands.vCreateF( password );
		setPassword( "" );
		setConfirm( "" );
		setVault( status );
	} );

	const hint = Com_PasswordHint( password, minLen );

	function Submit() {
		const problem = Com_NewPasswordProblem( password, confirm, minLen );
		setNudge( problem );
		if ( !problem ) {
			create.run();
		}
	}

	return (
		<div className="onboard">
			<div className="onboard-card">
				<div className="security-art"><LockKeyhole aria-hidden="true" /></div>
				<h1 className="onboard-title">{T.security.createTitle}</h1>
				<p className="lede center">{T.security.create}</p>

				<div className="lock-form">
					<UI_PasswordField id="create-pw" label={T.security.newPassword} value={password} onChange={setPassword} autoFocus />
					<UI_PasswordField id="create-confirm" label={T.security.confirm} value={confirm} onChange={setConfirm} onSubmit={Submit} />
					<p className={"hint" + ( nudge || create.error ? " bad" : hint.tone )}>{nudge ?? create.error?.message ?? hint.text}</p>
				</div>

				<div className="onboard-actions">
					<button className="btn primary large" disabled={create.busy} onClick={Submit}>
						{create.busy ? <UI_Spinner size={16} /> : null}{T.common.save}
					</button>
				</div>
			</div>
		</div>
	);
}

/*
==================
UI_VaultErrorScreen

The key can't be opened at all. The engine's message says why and what
to do. The one way on, if the key can't come back, is Start Over, asked
first as on the lock screen: on Android there is no folder to put a
backed-up key back into, nor one to clear by hand (W1-03). The engine
decides whether it may: never for a newer Laurel's key, which an update opens.
==================
*/
export function UI_VaultErrorScreen( props: { message: errorInfo_t } ) {
	const [ startOver, setStartOver ] = useState( false );

	return (
		<div className="onboard">
			<div className="onboard-card">
				<div className="security-art warn"><KeyRound aria-hidden="true" /></div>
				<UI_Alert title={T.security.vaultProblem} message={props.message} />
				<div className="onboard-actions">
					<button className="link" onClick={() => setStartOver( true )}>{T.security.startOverBroken}</button>
				</div>
			</div>
			<UI_ConfirmSheet
				open={startOver}
				onOpenChange={setStartOver}
				title={T.security.startOverBroken}
				description={T.security.startOverBrokenText}
				action={T.security.startOverAction}
				failed={T.security.startOverFailed}
				onConfirm={Com_StartOver}
			/>
		</div>
	);
}

/*
==================
UI_PasswordOffer

Once, after a first backup. Skipping is a real choice, not a failure.
==================
*/
export function UI_PasswordOffer( props: { onDone: () => void } ) {
	const [ setting, setSetting ] = useState( false );

	function Done() {
		Com_MarkOffered();
		props.onDone();
	}

	return (
		<div className="onboard">
			<div className="onboard-card">
				<div className="security-art"><ShieldCheck aria-hidden="true" /></div>
				<h1 className="onboard-title">{T.security.offerTitle}</h1>
				<p className="lede center">{T.security.offer}</p>

				<div className="onboard-actions">
					<button className="btn primary large" onClick={() => setSetting( true )}>{T.security.offerSet}</button>
					<button className="link" onClick={Done}>{T.security.offerSkip}</button>
				</div>
				<p className="status">{T.security.offerLater}</p>
			</div>

			<UI_PasswordSheet mode="set" open={setting} onOpenChange={setSetting} onDone={Done} />
		</div>
	);
}


/*
=========================================================================

SHEETS AND SETTINGS

=========================================================================
*/

/*
==================
UI_PasswordSheet

Turn on, change, or turn off the password. Each asks for exactly what
the engine needs; the engine checks the current password against the
file, not against the unlocked key in memory.
==================
*/
export function UI_PasswordSheet( props: sheetProps_t & {
	mode:			passwordMode_t;
	onDone?:		() => void;
} ) {
	const setVault	= useStore( ( s ) => s.SetVault );
	const minLen	= useStore( ( s ) => s.vault?.minPasswordLen ?? 8 );
	const [ current, setCurrent ]	= useState( "" );
	const [ password, setPassword ]	= useState( "" );
	const [ confirm, setConfirm ]	= useState( "" );
	const [ nudge, setNudge ]		= useState< string | null >( null );

	const needsCurrent	= props.mode !== "set";
	const needsNew		= props.mode !== "remove";

	function Clear() {
		setCurrent( "" );
		setPassword( "" );
		setConfirm( "" );
		setNudge( null );
	}

	useEffect( () => {
		Clear();
		act.setError( null );
	}, [ props.open ] );

	const act = useAction( async () => {
		let status: vaultStatus_t;
		if ( props.mode === "set" ) {
			status = await commands.vSetPasswordF( password );
		} else if ( props.mode === "change" ) {
			status = await commands.vChangePasswordF( current, password );
		} else {
			status = await commands.vRemovePasswordF( current );
		}
		Clear();
		setVault( status );
		props.onOpenChange( false );
		props.onDone?.();
	}, props.open );

	function Submit() {
		let problem: string | null = null;
		if ( needsCurrent && !current ) {
			problem = T.security.missingCurrent;
		} else if ( needsNew ) {
			problem = Com_NewPasswordProblem( password, confirm, minLen );
		}
		setNudge( problem );
		if ( !problem ) {
			act.run();
		}
	}

	const hint = Com_PasswordHint( password, minLen );
	const title = { set: T.security.setTitle, change: T.security.changeTitle, remove: T.security.removeTitle }[props.mode];
	const desc = { set: T.security.setDesc, change: undefined, remove: T.security.removeDesc }[props.mode];

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={title} description={desc} busy={act.busy}>
			{needsCurrent && (
				<UI_PasswordField id="pw-current" label={T.security.current} value={current} onChange={setCurrent} onSubmit={Submit} autoFocus />
			)}
			{needsNew && (
				<>
					<UI_PasswordField id="pw-new" label={T.security.newPassword} value={password} onChange={setPassword} autoFocus={!needsCurrent} />
					<UI_PasswordField id="pw-confirm" label={T.security.confirm} value={confirm} onChange={setConfirm} onSubmit={Submit} />
				</>
			)}
			<p className={"hint" + ( nudge || act.error ? " bad" : needsNew ? hint.tone : "" )}>
				{nudge ?? act.error?.message ?? ( needsNew ? hint.text : "\u00a0" /* a line's height kept, empty: a no-break space, written as its code */ )}
			</p>
			<UI_SheetButtons action={{ label: title, onRun: Submit }} busy={act.busy} onCancel={() => props.onOpenChange( false )} />
		</UI_Sheet>
	);
}

/*
==================
UI_AskPassword

The password again, before something an unlocked Laurel left alone
must not give away: a recovery phrase, a later auto-lock. onConfirm
does the thing with it; the engine checks it against the key file
(V_Confirm), so a wrong one comes back here as the engine's words.
==================
*/
export function UI_AskPassword( props: sheetProps_t & {
	title:		string;
	why:		string;
	action:		string;
	onConfirm:	( password: string ) => Promise< void >;
} ) {
	const [ password, setPassword ]	= useState( "" );
	const [ nudge, setNudge ]		= useState< string | null >( null );

	const act = useAction( async () => {
		await props.onConfirm( password );
		setPassword( "" );
		props.onOpenChange( false );
	}, props.open );

	useEffect( () => {
		setPassword( "" );
		setNudge( null );
		act.setError( null );
	}, [ props.open ] );

	function Submit() {
		setNudge( password ? null : T.security.missingCurrent );
		if ( password ) {
			act.run();
		}
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={props.title} description={props.why} busy={act.busy}>
			<UI_PasswordField id="ask-pw" label={T.security.password} value={password} onChange={setPassword} onSubmit={Submit} autoFocus />
			<p className={"hint" + ( nudge || act.error ? " bad" : "" )}>{nudge ?? act.error?.message ?? " "}</p>
			<UI_SheetButtons action={{ label: props.action, onRun: Submit }} busy={act.busy} onCancel={() => props.onOpenChange( false )} />
		</UI_Sheet>
	);
}

// the select's value for "never": the setting itself is none (null)
const AUTO_LOCK_NEVER = 0;

// how often the auto-lock looks at the clock
const AUTO_LOCK_TICK_MSEC = 15_000;

/*
==================
useCoverWhileAway

A phone: Laurel may lock while it's in the background (w_mobile.rs).
The page covers itself the moment it's hidden, and uncovers only once
the engine has answered whether it was away too long (M_Shown_f): coming
back after the time ran out, the wallets never show for a moment before
the lock lands
==================
*/
function useCoverWhileAway() {
	const mobile = useStore( ( s ) => s.constants?.mobile === true );

	useEffect( () => {
		if ( !mobile ) {
			return;
		}
		const root = document.documentElement;
		const Changed = () => {
			if ( document.hidden ) {
				root.classList.add( "away" );
				return;
			}
			void commands.mShownF().finally( () => root.classList.remove( "away" ) );
		};
		document.addEventListener( "visibilitychange", Changed );
		return () => {
			document.removeEventListener( "visibilitychange", Changed );
			root.classList.remove( "away" );
		};
	}, [ mobile ] );
}

/*
==================
useAutoLock

While a password guards the key: Ctrl+L locks, and so does the chosen
time without using Laurel (a click, a key, the mouse, the wheel). The
clock keeps running while Laurel is minimized or the computer sleeps,
so coming back after long enough finds it locked.
==================
*/
export function useAutoLock() {
	useCoverWhileAway();
	const vault		= useStore( ( s ) => s.vault );
	const lock		= useStore( ( s ) => s.Lock );
	const { settings } = useAppSettings();
	const armed		= vault?.protection === "password" && vault.state === "unlocked";
	const minutes	= armed ? settings?.autoLockMinutes ?? null : null;

	useEffect( () => {
		if ( !armed ) {
			return;
		}
		const onKey = ( e: KeyboardEvent ) => {
			if ( ( e.ctrlKey || e.metaKey ) && e.key.toLowerCase() === "l" ) {
				e.preventDefault();
				lock();
			}
		};
		window.addEventListener( "keydown", onKey );
		return () => window.removeEventListener( "keydown", onKey );
	}, [ armed ] );

	useEffect( () => {
		if ( minutes == null ) {
			return;
		}
		let last = Date.now();
		const due = () => Date.now() - last >= minutes * 60_000;
		// activity after the time ran out locks rather than starts again: asleep,
		// the clock moves on but the tick doesn't, and waking the mouse moves first
		const touch = () => {
			if ( due() ) {
				lock();
				return;
			}
			last = Date.now();
		};
		const events = [ "pointerdown", "pointermove", "keydown", "wheel" ] as const;
		events.forEach( ( ev ) => window.addEventListener( ev, touch, { passive: true } ) );
		const check = () => {
			if ( due() ) {
				lock();
			}
		};
		// a phone back from the background is shown before the next tick
		document.addEventListener( "visibilitychange", check );
		const timer = setInterval( check, AUTO_LOCK_TICK_MSEC );
		return () => {
			document.removeEventListener( "visibilitychange", check );
			events.forEach( ( ev ) => window.removeEventListener( ev, touch ) );
			clearInterval( timer );
		};
	}, [ minutes ] );
}

// a lock setting the person picked: the auto-lock, or how long a phone may be away
type laterLock_t = { kind: "auto"; minutes: number | null } | { kind: "away"; secs: number };

function Com_SaveLock( choice: laterLock_t, password: string | null ) {
	switch ( choice.kind ) {
	case "auto":	return commands.sSetAutoLockF( choice.minutes, password );
	case "away":	return commands.sSetLockAwayF( choice.secs, password );
	}
}

/*
==================
UI_SecuritySection

How the key is protected, as a level, and the password
==================
*/
export function UI_SecuritySection() {
	const vault			= useStore( ( s ) => s.vault );
	const constants		= useStore( ( s ) => s.constants );
	const [ mode, setMode ] = useState< passwordMode_t | null >( null );
	const [ open, setOpen ] = useState( false );

	function Open( m: passwordMode_t ) {
		setMode( m );
		setOpen( true );
	}

	const usesPassword = vault?.protection === "password";
	const lock = useStore( ( s ) => s.Lock );
	const { settings } = useAppSettings();
	const [ later, setLater ] = useState< laterLock_t | null >( null );	// a lock the engine wants the password for

	// the engine saves it, or says the password comes first (a later lock: S_LocksLater)
	const setLock = useAction( async ( choice: laterLock_t, password: string | null ) => {
		const r = await Com_SaveLock( choice, password );
		switch ( r.kind ) {
		case "saved":
			QUERY.setQueryData( KEYS.settings(), r.settings );
			return true;
		case "askPassword":
			setLater( choice );
			return false;
		}
	} );

	// the steps are facts of the vault: encryption always, then who can open it
	const steps: { label: string; on: boolean }[] = [
		{ label: T.security.stepEncrypted,	on: true },
		...( vault?.osProtectionAvailable ? [ { label: T.security.stepWindows, on: true } ] : [] ),
		{ label: T.security.stepPassword,	on: usesPassword },
	];

	return (
		<>
			<section className="settings-section">
				<div className={"sec-hero" + ( usesPassword ? " strong" : "" )}>
					<span className="sec-badge">{usesPassword ? <LockKeyhole aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}</span>
					<div className="sec-text">
						<div className="sec-level">
							{T.security.levelTitle}
							<span className="sec-level-name">{usesPassword ? T.security.levelStrong : T.security.levelGood}</span>
						</div>
						<div className="sec-title">{usesPassword ? T.security.protectionPw : T.security.protectionOs}</div>
						<div className="sec-hint">{usesPassword ? T.security.protectionPwHint : T.security.protectionOsHint}</div>
						<ul className="sec-steps">
							{steps.map( ( s ) => (
								<li key={s.label} className={s.on ? "on" : ""}>
									<span className="sec-step-mark">{s.on ? <Check aria-hidden="true" /> : null}</span>
									{s.label}
								</li>
							) )}
						</ul>
					</div>
				</div>

				<ul className="pool-list settings-list">
					<li className="set-row">
						<span className="set-icon"><KeyRound aria-hidden="true" /></span>
						<span className="set-text">
							<span className="set-label">{T.security.passwordRow}</span>
							<span className="set-sub">{usesPassword ? T.security.passwordOn : T.security.passwordOff}</span>
						</span>
						<span className="set-actions">
							{usesPassword ? (
								<>
									{vault?.osProtectionAvailable && <button className="btn" onClick={() => Open( "remove" )}>{T.security.turnOff}</button>}
									<button className="btn" onClick={() => Open( "change" )}>{T.security.change}</button>
								</>
							) : (
								<button className="btn primary" onClick={() => Open( "set" )}>{T.security.turnOn}</button>
							)}
						</span>
					</li>
					{/* without a password there's nothing to lock behind: said once, quietly, and the one way on is Turn On above */}
					<li className={"set-row" + ( usesPassword ? "" : " needs" )}>
						<span className="set-icon"><Lock aria-hidden="true" /></span>
						<span className="set-text">
							<span className="set-label">{T.security.lockRow} <UI_Info title={T.security.lockWhatTitle}>{T.security.lockWhat}</UI_Info></span>
							<span className="set-sub">{usesPassword ? T.security.lockOn : T.security.lockAbout}</span>
						</span>
						<span className="set-actions">
							{usesPassword
								? <button className="btn" onClick={() => { lock(); }}>{T.security.lockNow}</button>
								: <span className="needs-pill">{T.security.needsPassword}</span>}
						</span>
					</li>
					<li className={"set-row" + ( usesPassword ? "" : " needs" )}>
						<span className="set-icon"><TimerReset aria-hidden="true" /></span>
						<span className="set-text">
							<span className="set-label">{T.security.autoLock}</span>
							<span className="set-sub">{usesPassword ? T.security.autoLockHint : T.security.autoLockAbout}</span>
						</span>
						{!usesPassword && <span className="set-actions"><span className="needs-pill">{T.security.needsPassword}</span></span>}
						{usesPassword && settings && (
							<span className="set-actions">
								<select
									className="field-select"
									aria-label={T.security.autoLock}
									value={settings.autoLockMinutes ?? AUTO_LOCK_NEVER}
									disabled={setLock.busy}
									onChange={( e ) => { const m = Number( e.target.value ); void setLock.run( { kind: "auto", minutes: m === AUTO_LOCK_NEVER ? null : m }, null ); }}
								>
									<option value={AUTO_LOCK_NEVER}>{T.security.never}</option>
									{( constants?.autoLockChoices ?? [] ).map( ( m ) => <option key={m} value={m}>{T.security.after( m )}</option> )}
								</select>
							</span>
						)}
					</li>
					{/* a phone only: a computer's window doesn't go away when another is used */}
					{constants?.mobile && usesPassword && settings && (
						<li className="set-row">
							<span className="set-icon"><DoorOpen aria-hidden="true" /></span>
							<span className="set-text">
								<span className="set-label">{T.security.lockAway}</span>
								<span className="set-sub">{T.security.lockAwayHint}</span>
							</span>
							<span className="set-actions">
								<select
									className="field-select"
									aria-label={T.security.lockAway}
									value={settings.lockAwaySecs}
									disabled={setLock.busy}
									onChange={( e ) => void setLock.run( { kind: "away", secs: Number( e.target.value ) }, null )}
								>
									{constants.lockAwayChoices.map( ( s ) => <option key={s} value={s}>{T.security.away( s )}</option> )}
								</select>
							</span>
						</li>
					)}
				</ul>
				{setLock.error && <UI_Alert title={T.common.cantSaveSetting} message={setLock.error} />}
			</section>

			{mode && <UI_PasswordSheet mode={mode} open={open} onOpenChange={setOpen} />}
			<UI_AskPassword
				open={later !== null}
				onOpenChange={( o ) => { if ( !o ) setLater( null ); }}
				title={later?.kind === "away" ? T.security.lockAway : T.security.autoLock}
				why={later === null ? "" : later.kind === "away" ? T.security.awayLater( later.secs ) : later.minutes === null ? T.security.laterNever : T.security.later( later.minutes )}
				action={T.common.save}
				onConfirm={async ( password ) => {
					const r = later && await Com_SaveLock( later, password );
					if ( r?.kind === "saved" ) {
						QUERY.setQueryData( KEYS.settings(), r.settings );
					}
				}}
			/>
		</>
	);
}
