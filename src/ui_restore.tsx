/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_restore.tsx -- add an existing wallet from a recovery phrase or a
// viewing key. What it holds and its rules are ui_restore_state.ts

import { ClipboardEvent, Dispatch, KeyboardEvent, ReactNode, RefObject, useEffect, useReducer, useRef, useState } from "react";
import { Blocks, CalendarDays, ChevronLeft, ScanSearch } from "lucide-react";

import { commands, Com_AsciiDigits, errorInfo_t, phraseCheck_t, zcashdCheck_t } from "./ui_local";
import { Com_PhraseLine, Com_SecretGap, Com_WhenGap, DEFAULT_LENGTH, gap_t, METHODS, method_t, Restore_Reduce, Restore_Start, restore_t, restoreAction_t, when_t } from "./ui_restore_state";
import { T } from "./ui_text";
import { useAction, useLatest, useUncapturable } from "./ui_hooks";
import { useStore } from "./ui_store";
import { SECRET_FIELD, UI_Alert, UI_Choices, UI_Info, UI_Segmented, UI_Switch, UI_Waiting } from "./ui_widgets";
import { UI_ArtRestore, UI_ArtWhen } from "./ui_art";
import { UI_ExplainBirthday, UI_ExplainPhrase } from "./ui_backup";
import { UI_NameField } from "./ui_sheets";

const FIRST_YEAR		= 2018;		// sapling, the oldest a restorable wallet can be
const RESTORE_ACCOUNTS	= [ 1, 2, 3, 4, 5 ];


/*
=========================================================================

PHRASE GRID

=========================================================================
*/

/*
==================
Com_Complete

The only word in the list that starts with prefix, or the first of
several. bip-39 words are unique by their first four letters, so four
letters always complete.
==================
*/
function Com_Complete( wordlist: string[], prefix: string ): string {
	if ( !prefix ) {
		return "";
	}
	return wordlist.find( ( word ) => word.startsWith( prefix ) ) ?? "";
}

/*
==================
UI_PhraseGrid

One box per word. Typing shows the rest of the word in grey; Tab,
Enter or Space takes it and moves on. Pasting a whole phrase into any
box fills them all, and picks the right length.
==================
*/
function UI_PhraseGrid( props: {
	words:			string[];
	unknown:		number[];
	wordlist:		string[];
	focusRequest:	{ index: number; serial: number };
	onChange:		( words: string[] ) => void;
	onPasteAll:		( words: string[] ) => void;
} ) {
	const refs = useRef< ( HTMLInputElement | null )[] >( [] );
	const [ focus, setFocus ] = useState( -1 );

	// the screen asks for a box to be focused: the first empty or wrong one
	useEffect( () => {
		if ( props.focusRequest.serial ) {
			refs.current[props.focusRequest.index]?.focus();
		}
	}, [ props.focusRequest.serial ] );

	function Set( i: number, value: string ) {
		const next = props.words.slice();
		next[i] = value.toLowerCase().replace( /[^a-z]/g, "" );
		props.onChange( next );
	}

	function Accept( i: number ): boolean {
		const guess = Com_Complete( props.wordlist, props.words[i] );
		if ( guess && guess !== props.words[i] ) {
			Set( i, guess );
		}
		const next = refs.current[i + 1];
		if ( next ) {
			next.focus();
			return true;
		}
		return false;
	}

	function KeyDown( i: number, e: KeyboardEvent< HTMLInputElement > ) {
		if ( e.key === " " || e.key === "Enter" || ( e.key === "Tab" && !e.shiftKey ) ) {
			if ( props.words[i] ) {
				if ( Accept( i ) || e.key !== "Tab" ) {
					e.preventDefault();
				}
			} else if ( e.key === " " ) {
				e.preventDefault();
			}
		} else if ( e.key === "Backspace" && !props.words[i] && i > 0 ) {
			e.preventDefault();
			refs.current[i - 1]?.focus();
		}
	}

	// recovery words are letters only, so numbers and punctuation between
	// them go: a list copied as "1. abandon 2. ability" reads as its words
	function Paste( e: ClipboardEvent< HTMLInputElement > ) {
		const words = e.clipboardData.getData( "text" ).toLowerCase().split( /[^a-z]+/ ).filter( Boolean );
		if ( words.length > 1 ) {
			e.preventDefault();
			props.onPasteAll( words );
		}
	}

	return (
		<ol className="phrase-grid">
			{props.words.map( ( word, i ) => {
				const guess	= focus === i ? Com_Complete( props.wordlist, word ) : "";
				const bad	= props.unknown.includes( i ) && focus !== i;

				return (
					<li key={i} className={"phrase-cell" + ( bad ? " bad" : "" ) + ( focus === i ? " focused" : "" )}>
						<span className="phrase-num">{i + 1}</span>
						<span className="phrase-field">
							<span className="ghost" aria-hidden="true">
								<span className="ghost-typed">{word}</span>{guess.slice( word.length )}
							</span>
							<input
								ref={( el ) => { refs.current[i] = el; }}
								value={word}
								{...SECRET_FIELD}
								aria-label={`Word ${i + 1}`}
								onChange={( e ) => Set( i, e.target.value )}
								onKeyDown={( e ) => KeyDown( i, e )}
								onPaste={Paste}
								onFocus={() => setFocus( i )}
								onBlur={() => setFocus( -1 )}
							/>
						</span>
					</li>
				);
			} )}
		</ol>
	);
}


/*
==================
UI_PassphraseField

The optional "25th word". Off unless asked for: most phrases have none,
and a passphrase set by mistake opens a different, empty wallet. Shown
in the clear like the words above it, since a typo here fails silently;
spaces at either end are pointed out, never trimmed.
==================
*/
function UI_PassphraseField( props: {
	on:			boolean;
	value:		string;
	missing:	boolean;		// Restore was clicked with it on and empty
	inputRef:	RefObject< HTMLInputElement | null >;
	onOn:		( on: boolean ) => void;
	onChange:	( v: string ) => void;
} ) {
	const edges = props.value !== props.value.trim();
	const hint = props.missing
		? { text: T.restore.missingPassphrase, tone: " bad" }
		: edges
			? { text: T.restore.passphraseEdges, tone: " warn" }
			: { text: T.restore.passphraseHint, tone: "" };

	return (
		<div>
			<div className="group-row accounts-row">
				<span className="group-title">
					{T.restore.passphrase} <UI_Info title={T.explain.passphraseTitle}>{T.explain.passphrase}</UI_Info>
				</span>
				<UI_Switch label={T.restore.passphrase} checked={props.on} onChange={props.onOn} />
			</div>
			{props.on && (
				<>
					<input
						ref={props.inputRef}
						className="field passphrase-input"
						value={props.value}
						{...SECRET_FIELD}
						autoFocus
						placeholder={T.restore.passphrasePlaceholder}
						aria-label={T.backup.passphrase}
						onChange={( e ) => props.onChange( e.target.value )}
					/>
					<p className={"hint" + hint.tone}>{hint.text}</p>
				</>
			)}
		</div>
	);
}


/*
==================
UI_ZcashdLine

What the pasted zcashd text holds: the keys to import, and what was
found but can't be (said, never silently dropped). A nudge wins the line.
==================
*/
function UI_ZcashdLine( props: { check: zcashdCheck_t; nudge: string | null } ) {
	const c = props.check;
	let line;
	if ( props.nudge ) {
		line = { text: props.nudge, tone: " bad" };
	} else {
		switch ( c.kind ) {
		case "empty":	line = { text: T.restore.zcashdHint, tone: "" }; break;
		case "ok":		line = { text: T.restore.zcashdFound( c.sapling ), tone: " ok" }; break;
		case "bad":		line = { text: c.problem, tone: " bad" }; break;
		}
	}
	return (
		<>
			<p className={"phrase-status" + line.tone}>{line.text}</p>
			{c.kind === "ok" && c.transparent > 0 && <p className="hint">{T.restore.zcashdTransparent( c.transparent )}</p>}
			{c.kind === "ok" && c.sprout > 0 && <p className="hint warn">{T.restore.zcashdSprout( c.sprout )}</p>}
		</>
	);
}


/*
=========================================================================

BIRTHDAY

=========================================================================
*/

/*
==================
UI_Birthday

When the wallet was made, a step of its own after the phrase or key.
Not Sure comes first and is chosen: it always finds everything, and a
month or a block only makes the search shorter
==================
*/
function UI_Birthday( props: {
	when:		when_t;
	month:		number;
	year:		number;
	block:		string;
	blockRef:	RefObject< HTMLInputElement | null >;
	onWhen:		( w: when_t ) => void;
	onMonth:	( m: number ) => void;
	onYear:		( y: number ) => void;
	onBlock:	( b: string ) => void;
} ) {
	const years: number[] = [];
	for ( let y = new Date().getFullYear(); y >= FIRST_YEAR; y-- ) {
		years.push( y );
	}

	const monthFields = (
		<div className="group-row">
			<select className="field select" aria-label={T.restore.whenMonth} value={props.month} onChange={( e ) => props.onMonth( Number( e.target.value ) )}>
				{T.restore.months.map( ( m, i ) => <option key={m} value={i}>{m}</option> )}
			</select>
			<select className="field select" aria-label={T.restore.whenMonth} value={props.year} onChange={( e ) => props.onYear( Number( e.target.value ) )}>
				{years.map( ( y ) => <option key={y} value={y}>{y}</option> )}
			</select>
		</div>
	);
	const blockField = (
		<input
			ref={props.blockRef}
			className="field"
			inputMode="numeric"
			aria-label={T.restore.whenBlock}
			placeholder={T.restore.blockPlaceholder}
			value={props.block}
			onChange={( e ) => props.onBlock( Com_AsciiDigits( e.target.value ).replace( /[^0-9]/g, "" ) )}
		/>
	);

	return (
		<div className="restore-when">
			<UI_Choices
				label={T.restore.whenChoices}
				value={props.when}
				onChange={props.onWhen}
				options={[
					{ value: "unknown",	name: T.restore.whenUnknown,	sub: T.restore.hintUnknown,	icon: <ScanSearch />,	tone: "green",	badge: T.restore.recommended },
					{ value: "date",	name: T.restore.whenMonth,		sub: T.restore.hintMonth,	icon: <CalendarDays />,	tone: "blue",	more: monthFields },
					{ value: "block",	name: T.restore.whenBlock,		sub: T.restore.hintBlock,	icon: <Blocks />,		tone: "violet",	more: blockField },
				]}
			/>
		</div>
	);
}


/*
=========================================================================

EACH WAY IN

=========================================================================
*/

function UI_RestorePhrase( props: {
	s:			restore_t;
	check:		phraseCheck_t | null;
	lengths:	number[];
	passRef:	RefObject< HTMLInputElement | null >;
	dispatch:	Dispatch< restoreAction_t >;
} ) {
	const { s, dispatch } = props;
	const [ wordlist, setWordlist ] = useState< string[] >( [] );
	const line = Com_PhraseLine( s.words, props.check, s.nudge );

	useEffect( () => {
		commands.wWordlistF().then( setWordlist ).catch( () => {} );
	}, [] );

	return (
		<>
			<div className="group-head">
				<p className="lede">{T.restore.phraseLede} <UI_ExplainPhrase /></p>
				<UI_Segmented
					small
					id="length"
					value={s.words.length}
					onChange={( n ) => dispatch( { type: "length", n } )}
					options={props.lengths.map( ( n ) => ( { value: n, label: String( n ) } ) )}
				/>
			</div>

			<UI_PhraseGrid
				words={s.words}
				unknown={props.check?.unknown ?? []}
				wordlist={wordlist}
				focusRequest={s.focusWord}
				onChange={( words ) => dispatch( { type: "words", words } )}
				onPasteAll={( pasted ) => dispatch( { type: "paste", pasted, lengths: props.lengths } )}
			/>
			{s.pasteNote && <p className="phrase-status bad" role="alert">{s.pasteNote}</p>}

			<p className={"phrase-status" + line.tone}>{line.text}</p>
			<p className="hint">{T.restore.otherWallets}</p>

			<UI_PassphraseField
				on={s.hasPass}
				value={s.passphrase}
				missing={s.passMissing}
				inputRef={props.passRef}
				onOn={( on ) => dispatch( { type: "passOn", on } )}
				onChange={( passphrase ) => dispatch( { type: "passphrase", passphrase } )}
			/>

			<div className="group-row accounts-row">
				<span className="group-title">
					{T.restore.accounts} <UI_Info title={T.explain.restoreAccountsTitle}>{T.explain.restoreAccounts}</UI_Info>
				</span>
				<UI_Segmented
					small
					id="accounts"
					value={s.accounts}
					onChange={( accounts ) => dispatch( { type: "accounts", accounts } )}
					options={RESTORE_ACCOUNTS.map( ( n ) => ( { value: n, label: String( n ) } ) )}
				/>
			</div>
			<p className="hint">{T.restore.accountsLater}</p>
		</>
	);
}

function UI_RestoreViewKey( props: { value: string; nudge: string | null; inputRef: RefObject< HTMLTextAreaElement | null >; onChange: ( v: string ) => void } ) {
	return (
		<>
			<p className="lede">
				{T.restore.viewKeyLede} <UI_Info title={T.explain.viewKeyTitle}>{T.explain.viewKey}</UI_Info>
			</p>
			<textarea
				ref={props.inputRef}
				className="field viewkey-input"
				rows={4}
				{...SECRET_FIELD}
				placeholder={useStore.getState().network === "testnet" ? "uviewtest1…" : "uview1…"}
				value={props.value}
				onChange={( e ) => props.onChange( e.target.value.trim() )}
			/>
			{props.nudge && <p className="phrase-status bad">{props.nudge}</p>}
		</>
	);
}

function UI_RestoreZcashd( props: { value: string; check: zcashdCheck_t; nudge: string | null; inputRef: RefObject< HTMLTextAreaElement | null >; onChange: ( v: string ) => void } ) {
	return (
		<>
			<p className="lede">
				{T.restore.zcashdLede} <UI_Info title={T.explain.zcashdTitle}>{T.explain.zcashd}</UI_Info>
			</p>
			<textarea
				ref={props.inputRef}
				className="field viewkey-input"
				rows={5}
				{...SECRET_FIELD}
				aria-label={T.restore.methodZcashd}
				placeholder={useStore.getState().network === "testnet" ? "secret-extended-key-test1…" : "secret-extended-key-main1…"}
				value={props.value}
				onChange={( e ) => props.onChange( e.target.value )}
			/>
			<UI_ZcashdLine check={props.check} nudge={props.nudge} />
		</>
	);
}


/*
=========================================================================

RESTORE SCREEN

=========================================================================
*/

/*
==================
UI_RestoreSecretStep

The first step: which way in, the wallet's name, and the way in's own
fields (children).
==================
*/
function UI_RestoreSecretStep( props: {
	s:			restore_t;
	nameRef:	RefObject< HTMLDivElement | null >;
	dispatch:	Dispatch< restoreAction_t >;
	onBack:		() => void;
	onNext:		() => void;
	children:	ReactNode;
} ) {
	const { s, dispatch } = props;
	return (
		<>
			<div className="restore-head">
				<UI_ArtRestore />
				<h1 className="onboard-title">{METHODS[s.method].title}</h1>
				<p className="lede center">{T.restore.lede}</p>
			</div>

			<div className="restore-method">
				<UI_Segmented
					full
					id="method"
					value={s.method}
					onChange={( method ) => dispatch( { type: "method", method } )}
					options={( Object.keys( METHODS ) as method_t[] ).map( ( m ) => ( { value: m, label: METHODS[m].label } ) )}
				/>
			</div>

			<div className="field-row" ref={props.nameRef}>
				<label className="label" htmlFor="restore-name">{T.restore.name}</label>
				<UI_NameField id="restore-name" value={s.name} onChange={( name ) => dispatch( { type: "name", name } )} />
			</div>

			{props.children}

			<div className="row">
				<button className="btn" onClick={props.onBack}>{T.common.back}</button>
				<button className="btn primary" onClick={props.onNext}>{T.common.next}</button>
			</div>

			<p className="footnote">{T.restore.unsupported}</p>
		</>
	);
}

/*
==================
UI_RestoreWhenStep

The second step: when the wallet was made, and the action that restores
it.
==================
*/
function UI_RestoreWhenStep( props: {
	s:			restore_t;
	blockRef:	RefObject< HTMLInputElement | null >;
	busy:		boolean;
	error:		errorInfo_t | null;
	status:		string;
	dispatch:	Dispatch< restoreAction_t >;
	onBack:		() => void;
	onSubmit:	() => void;
} ) {
	const { s, dispatch } = props;
	return (
		<>
			<div className="restore-head">
				<UI_ArtWhen />
				<h1 className="onboard-title">{T.restore.whenTitle} <UI_ExplainBirthday /></h1>
				<p className="lede center">{T.restore.whenLede}</p>
			</div>

			<UI_Birthday
				when={s.when} month={s.month} year={s.year} block={s.block} blockRef={props.blockRef}
				onWhen={( when ) => dispatch( { type: "when", when } )}
				onMonth={( month ) => dispatch( { type: "month", month } )}
				onYear={( year ) => dispatch( { type: "year", year } )}
				onBlock={( block ) => dispatch( { type: "block", block } )}
			/>
			{s.nudge && <p className="phrase-status bad">{s.nudge}</p>}

			{props.error && <UI_Alert title={T.restore.failed} message={props.error} />}

			<div className="row">
				<button className="btn" disabled={props.busy} onClick={props.onBack}>{T.common.back}</button>
				<button className="btn primary" disabled={props.busy} onClick={props.onSubmit}>
					{props.busy
						? <><UI_Waiting text={T.restore.restoring} size={14} /></>
						: METHODS[s.method].action}
				</button>
			</div>
			<p className="status right">{props.busy ? <UI_Waiting key={props.status} text={props.status} /> : " "}</p>
		</>
	);
}

/*
==================
UI_Restore

Adds an existing wallet, in two steps: the phrase or key, then when the
wallet was made. Next and the action are never dead: clicked too early,
they say what is still needed and put the cursor there.
==================
*/
export function UI_Restore( props: { method: method_t; onDone: ( id: string ) => void; onBack: () => void } ) {
	const constants	= useStore( ( st ) => st.constants );
	const refresh	= useStore( ( st ) => st.Refresh );
	const lengths	= constants?.phraseLengths ?? [ DEFAULT_LENGTH ];
	const latest	= useLatest();

	useUncapturable( true );		// every way in is typed secrets: words, keys

	const [ s, dispatch ]			= useReducer( Restore_Reduce, null, () => Restore_Start( props.method, constants?.defaultWalletName ?? "" ) );
	const [ check, setCheck ]		= useState< phraseCheck_t | null >( null );
	const [ zcheck, setZcheck ]		= useState< zcashdCheck_t >( { kind: "empty" } );
	const [ status, setStatus ]		= useState( "" );
	const nameRef					= useRef< HTMLDivElement >( null );
	const viewKeyRef				= useRef< HTMLTextAreaElement >( null );
	const zcashdRef					= useRef< HTMLTextAreaElement >( null );
	const passRef					= useRef< HTMLInputElement >( null );
	const blockRef					= useRef< HTMLInputElement >( null );

	// checked as the user types; only the newest answer counts
	useEffect( () => {
		if ( s.words.every( ( w ) => !w ) ) {
			setCheck( null );
			return;
		}
		latest( commands.wCheckPhraseF( s.words.join( " " ) ), setCheck );
	}, [ s.words ] );

	// zcashd's keys, read locally as they're pasted
	useEffect( () => {
		latest( commands.wCheckZcashdKeysF( s.zcashd ), setZcheck );
	}, [ s.zcashd ] );

	// what is still needed, said plainly, with the cursor moved there
	function Show( gap: gap_t | null ): boolean {
		dispatch( { type: "gap", gap } );
		switch ( gap?.at ) {
		case "name":	nameRef.current?.querySelector( "input" )?.focus(); break;
		case "viewKey":	viewKeyRef.current?.focus(); break;
		case "zcashd":	zcashdRef.current?.focus(); break;
		case "pass":	passRef.current?.focus(); break;
		case "block":	blockRef.current?.focus(); break;
		case "word":	break;		// the grid focuses its own box (focusWord)
		case undefined:	break;
		}
		return gap !== null;
	}

	async function Birthday(): Promise< number > {
		if ( s.when === "block" ) {
			return Number( s.block ) || 0;
		}
		if ( s.when === "date" ) {
			setStatus( T.restore.findingStart );
			return commands.wHeightForDateF( useStore.getState().network, Math.floor( new Date( s.year, s.month, 1 ).getTime() / 1000 ) );
		}
		return 0;
	}

	const restore = useAction( async () => {
		const birthday = await Birthday();
		setStatus( T.restore.restoringStatus );
		const id = await METHODS[s.method].restore( useStore.getState().network, s.name.trim(), s, birthday );
		await refresh();
		props.onDone( id );
	} );

	function Next() {
		if ( !Show( Com_SecretGap( s, { check, zcheck } ) ) ) {
			dispatch( { type: "step", step: "when" } );
		}
	}

	function Submit() {
		if ( !Show( Com_WhenGap( s ) ) ) {
			restore.run().finally( () => setStatus( "" ) );
		}
	}

	function Back() {
		if ( s.step === "when" ) {
			dispatch( { type: "step", step: "secret" } );
		} else {
			props.onBack();
		}
	}

	let fields: ReactNode;
	switch ( s.method ) {
	case "phrase":	fields = <UI_RestorePhrase s={s} check={check} lengths={lengths} passRef={passRef} dispatch={dispatch} />; break;
	case "viewkey":	fields = <UI_RestoreViewKey value={s.viewKey} nudge={s.nudge} inputRef={viewKeyRef} onChange={( viewKey ) => dispatch( { type: "viewKey", viewKey } )} />; break;
	case "zcashd":	fields = <UI_RestoreZcashd value={s.zcashd} check={zcheck} nudge={s.nudge} inputRef={zcashdRef} onChange={( zcashd ) => dispatch( { type: "zcashd", zcashd } )} />; break;
	}

	return (
		<div className="onboard">
			<div className="onboard-card wide restore">
				<div className="flow-nav">
					<div>
						<button className="nav-back" disabled={restore.busy} onClick={Back}>
							<ChevronLeft aria-hidden="true" />{T.common.back}
						</button>
					</div>
					<div className="step-dots" role="img" aria-label={T.common.step( s.step === "secret" ? 1 : 2, 2 )}>
						<span className={s.step === "secret" ? "on" : "past"} />
						<span className={s.step === "when" ? "on" : ""} />
					</div>
					<div />
				</div>

				{s.step === "when"
					? <UI_RestoreWhenStep s={s} blockRef={blockRef} busy={restore.busy} error={restore.error} status={status} dispatch={dispatch} onBack={Back} onSubmit={Submit} />
					: <UI_RestoreSecretStep s={s} nameRef={nameRef} dispatch={dispatch} onBack={Back} onNext={Next}>{fields}</UI_RestoreSecretStep>}
			</div>
		</div>
	);
}
