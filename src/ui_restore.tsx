/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_restore.tsx -- add an existing wallet from a recovery phrase or a
// viewing key

import { ClipboardEvent, KeyboardEvent, RefObject, useEffect, useRef, useState } from "react";
import { Blocks, CalendarDays, ChevronLeft, ScanSearch } from "lucide-react";

import { commands, Com_AsciiDigits, phraseCheck_t, zcashdCheck_t } from "./ui_local";
import { T } from "./ui_text";
import { useAction, useLatest, useUncapturable } from "./ui_hooks";
import { useStore } from "./ui_store";
import { SECRET_FIELD, UI_Alert, UI_Choices, UI_Info, UI_Segmented, UI_Switch, UI_Waiting } from "./ui_widgets";
import { UI_ArtRestore, UI_ArtWhen } from "./ui_art";
import { UI_ExplainBirthday, UI_ExplainPhrase } from "./ui_backup";
import { UI_NameField } from "./ui_sheets";

export type method_t	= "phrase" | "viewkey" | "zcashd";
type when_t				= "date" | "block" | "unknown";

const DEFAULT_LENGTH	= 24;
const FIRST_YEAR		= 2018;		// sapling, the oldest a restorable wallet can be
const RESTORE_ACCOUNTS	= [ 1, 2, 3, 4, 5 ];

// each way in, named once: a new method must say its title and its button
const METHOD_TEXT: Record< method_t, { title: string; action: string } > = {
	phrase:		{ title: T.restore.title,			action: T.restore.action },
	viewkey:	{ title: T.restore.viewOnlyTitle,	action: T.restore.actionViewKey },
	zcashd:		{ title: T.restore.zcashdTitle,		action: T.restore.actionZcashd },
};


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

RESTORE SCREEN

=========================================================================
*/

/*
==================
UI_Restore

Adds an existing wallet, in two steps: the phrase or key, then when the
wallet was made. Next and the action are never dead: clicked too early,
they say what is still needed and put the cursor there.
==================
*/
export function UI_Restore( props: { method: method_t; onDone: ( id: string ) => void; onBack: () => void } ) {
	const now		= new Date();
	const constants	= useStore( ( s ) => s.constants );
	const refresh	= useStore( ( s ) => s.Refresh );
	const lengths	= constants?.phraseLengths ?? [ DEFAULT_LENGTH ];
	const latest	= useLatest();

	useUncapturable( true );		// every way in is typed secrets: words, keys

	const [ method, setMethod ]		= useState< method_t >( props.method );
	const [ name, setName ]			= useState( constants?.defaultWalletName ?? "" );
	const [ accounts, setAccounts ]	= useState( 1 );
	const [ words, setWords ]		= useState< string[] >( Array( DEFAULT_LENGTH ).fill( "" ) );
	const [ check, setCheck ]		= useState< phraseCheck_t | null >( null );
	const [ wordlist, setWordlist ]	= useState< string[] >( [] );
	const [ viewKey, setViewKey ]	= useState( "" );
	const [ zcashd, setZcashd ]		= useState( "" );
	const [ zcheck, setZcheck ]		= useState< zcashdCheck_t >( { kind: "empty" } );
	const [ hasPass, setHasPass ]	= useState( false );
	const [ passphrase, setPass ]	= useState( "" );
	const [ passMissing, setPassMissing ] = useState( false );

	const [ step, setStep ]			= useState< "secret" | "when" >( "secret" );
	const [ when, setWhen ]			= useState< when_t >( "unknown" );
	const [ month, setMonth ]		= useState( now.getMonth() );
	const [ year, setYear ]			= useState( now.getFullYear() );
	const [ block, setBlock ]		= useState( "" );

	const [ status, setStatus ]		= useState( "" );
	const [ nudge, setNudge ]		= useState< string | null >( null );
	const [ pasteNote, setPasteNote ]	= useState< string | null >( null );		// a paste that wasn't a phrase's length (PasteAll)
	const [ focusReq, setFocusReq ]	= useState( { index: 0, serial: 0 } );
	const nameRef					= useRef< HTMLDivElement >( null );
	const viewKeyRef				= useRef< HTMLTextAreaElement >( null );
	const zcashdRef					= useRef< HTMLTextAreaElement >( null );
	const passRef					= useRef< HTMLInputElement >( null );
	const blockRef					= useRef< HTMLInputElement >( null );

	useEffect( () => {
		commands.wWordlistF().then( setWordlist ).catch( () => {} );
	}, [] );

	// checked as the user types; only the newest answer counts
	useEffect( () => {
		setNudge( null );
		if ( words.every( ( w ) => !w ) ) {
			setCheck( null );
			return;
		}
		latest( commands.wCheckPhraseF( words.join( " " ) ), setCheck );
	}, [ words ] );

	// zcashd's keys, read locally as they're pasted
	useEffect( () => {
		latest( commands.wCheckZcashdKeysF( zcashd ), setZcheck );
	}, [ zcashd ] );

	function ChangeLength( n: number ) {
		setPasteNote( null );
		setWords( ( old ) => Array.from( { length: n }, ( _, i ) => old[i] ?? "" ) );
	}

	// a paste is never cut short in silence (W1-05): 24 words and a passphrase
	// written as the 25th, a common paper, restored the wallet without it,
	// empty. More words than any phrase has fill in none; a count no phrase
	// has fills the next length up, and says how many came
	function PasteAll( pasted: string[] ) {
		const most = Math.max( ...lengths );
		if ( pasted.length > most ) {
			setPasteNote( T.restore.pastedTooMany( pasted.length, lengths ) );
			return;
		}
		const n = lengths.find( ( l ) => l >= pasted.length ) ?? most;
		setWords( Array.from( { length: n }, ( _, i ) => pasted[i] ?? "" ) );
		setPasteNote( lengths.includes( pasted.length ) ? null : T.restore.pastedOdd( pasted.length, lengths ) );
	}

	const filled		= words.filter( Boolean ).length;
	const phraseReady	= filled === words.length && !!check?.valid;

	// unknown words show at once; other problems wait until every box has a word
	let problem = "";
	if ( check && ( check.unknown.length || filled === words.length ) ) {
		problem = check.problem;
	}

	// a nudge answers a click, so it wins the line: "✓ Valid" must never hide
	// why the button just moved the cursor instead of restoring
	const phraseLine = nudge
		? { text: nudge, tone: " bad" }
		: phraseReady
			? { text: T.restore.valid, tone: " ok" }
			: { text: problem || T.restore.wordsOf( filled, words.length ), tone: problem ? " bad" : "" };

	/*
	==================
	Missing

	What is still needed, said plainly, with the cursor moved there
	==================
	*/
	function Missing(): boolean {
		if ( !name.trim() ) {
			setNudge( T.restore.missingName );
			nameRef.current?.querySelector( "input" )?.focus();
			return true;
		}
		switch ( method ) {
		case "viewkey":
			if ( !viewKey.trim() ) {
				setNudge( T.restore.missingViewKey );
				viewKeyRef.current?.focus();
				return true;
			}
			return false;
		case "zcashd":
			if ( zcheck.kind !== "ok" ) {
				setNudge( zcheck.kind === "bad" ? zcheck.problem : T.restore.missingZcashd );
				zcashdRef.current?.focus();
				return true;
			}
			return false;
		case "phrase":
			break;
		}

		const empty = words.findIndex( ( w ) => !w );
		if ( empty >= 0 ) {
			setNudge( T.restore.missingWords( words.length - filled ) );
			setFocusReq( ( r ) => ( { index: empty, serial: r.serial + 1 } ) );
			return true;
		}
		if ( check && !check.valid ) {
			setNudge( check.problem );
			if ( check.unknown.length ) {
				setFocusReq( ( r ) => ( { index: check.unknown[0], serial: r.serial + 1 } ) );
			}
			return true;
		}
		if ( hasPass && !passphrase ) {
			setPassMissing( true );		// said under the field, where the cursor goes
			passRef.current?.focus();
			return true;
		}
		return false;
	}

	async function Birthday(): Promise< number > {
		if ( when === "block" ) {
			return Number( block ) || 0;
		}
		if ( when === "date" ) {
			setStatus( T.restore.findingStart );
			return commands.wHeightForDateF( useStore.getState().network, Math.floor( new Date( year, month, 1 ).getTime() / 1000 ) );
		}
		return 0;
	}

	const restore = useAction( async () => {
		const birthday = await Birthday();
		setStatus( T.restore.restoringStatus );
		const net = useStore.getState().network;
		let id: string;
		switch ( method ) {
		case "phrase":	id = await commands.wRestoreF( net, name.trim(), words.join( " " ), hasPass ? passphrase : "", birthday, accounts ); break;
		case "viewkey":	id = await commands.wRestoreViewKeyF( net, name.trim(), viewKey, birthday ); break;
		case "zcashd":	id = await commands.wImportZcashdKeysF( net, name.trim(), zcashd, birthday ); break;
		}
		await refresh();
		props.onDone( id );
	} );

	function Next() {
		if ( !Missing() ) {
			setNudge( null );
			setStep( "when" );
		}
	}

	function Submit() {
		if ( when === "block" && !block ) {
			setNudge( T.restore.missingBlock );
			blockRef.current?.focus();
			return;
		}
		setNudge( null );
		restore.run().finally( () => setStatus( "" ) );
	}

	function Back() {
		if ( step === "when" ) {
			setNudge( null );
			setStep( "secret" );
		} else {
			props.onBack();
		}
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
					<div className="step-dots" role="img" aria-label={T.common.step( step === "secret" ? 1 : 2, 2 )}>
						<span className={step === "secret" ? "on" : "past"} />
						<span className={step === "when" ? "on" : ""} />
					</div>
					<div />
				</div>

				{step === "when" && (
					<>
						<div className="restore-head">
							<UI_ArtWhen />
							<h1 className="onboard-title">{T.restore.whenTitle} <UI_ExplainBirthday /></h1>
							<p className="lede center">{T.restore.whenLede}</p>
						</div>

						<UI_Birthday
							when={when} month={month} year={year} block={block} blockRef={blockRef}
							onWhen={( w ) => { setWhen( w ); setNudge( null ); }} onMonth={setMonth} onYear={setYear} onBlock={( b ) => { setBlock( b ); setNudge( null ); }}
						/>
						{nudge && <p className="phrase-status bad">{nudge}</p>}

						{restore.error && <UI_Alert title={T.restore.failed} message={restore.error} />}

						<div className="row">
							<button className="btn" disabled={restore.busy} onClick={Back}>{T.common.back}</button>
							<button className="btn primary" disabled={restore.busy} onClick={Submit}>
								{restore.busy
									? <><UI_Waiting text={T.restore.restoring} size={14} /></>
									: METHOD_TEXT[method].action}
							</button>
						</div>
						<p className="status right">{restore.busy ? <UI_Waiting key={status} text={status} /> : " "}</p>
					</>
				)}

				{step === "secret" && (
					<>
						<div className="restore-head">
							<UI_ArtRestore />
							<h1 className="onboard-title">{METHOD_TEXT[method].title}</h1>
							<p className="lede center">{T.restore.lede}</p>
						</div>

						<div className="restore-method">
							<UI_Segmented
								full
								id="method"
								value={method}
								onChange={( m ) => { setMethod( m ); setNudge( null ); }}
								options={[
									{ value: "phrase",	label: T.restore.methodPhrase },
									{ value: "viewkey",	label: T.restore.methodViewKey },
									{ value: "zcashd",	label: T.restore.methodZcashd },
								]}
							/>
						</div>

						<div className="field-row" ref={nameRef}>
							<label className="label" htmlFor="restore-name">{T.restore.name}</label>
							<UI_NameField id="restore-name" value={name} onChange={( v ) => { setName( v ); setNudge( null ); }} />
						</div>

						{method === "phrase" && (
							<>
								<div className="group-head">
									<p className="lede">{T.restore.phraseLede} <UI_ExplainPhrase /></p>
									<UI_Segmented
										small
										id="length"
										value={words.length}
										onChange={ChangeLength}
										options={lengths.map( ( n ) => ( { value: n, label: String( n ) } ) )}
									/>
								</div>

								<UI_PhraseGrid
									words={words}
									unknown={check?.unknown ?? []}
									wordlist={wordlist}
									focusRequest={focusReq}
									onChange={( w ) => { setWords( w ); setPasteNote( null ); }}
									onPasteAll={PasteAll}
								/>
								{pasteNote && <p className="phrase-status bad" role="alert">{pasteNote}</p>}

								<p className={"phrase-status" + phraseLine.tone}>{phraseLine.text}</p>
								<p className="hint">{T.restore.otherWallets}</p>

								<UI_PassphraseField
									on={hasPass}
									value={passphrase}
									missing={passMissing}
									inputRef={passRef}
									onOn={( on ) => { setHasPass( on ); setPassMissing( false ); }}
									onChange={( v ) => { setPass( v ); setPassMissing( false ); }}
								/>

								<div className="group-row accounts-row">
									<span className="group-title">
										{T.restore.accounts} <UI_Info title={T.explain.restoreAccountsTitle}>{T.explain.restoreAccounts}</UI_Info>
									</span>
									<UI_Segmented
										small
										id="accounts"
										value={accounts}
										onChange={setAccounts}
										options={RESTORE_ACCOUNTS.map( ( n ) => ( { value: n, label: String( n ) } ) )}
									/>
								</div>
								<p className="hint">{T.restore.accountsLater}</p>
							</>
						)}

						{method === "viewkey" && (
							<>
								<p className="lede">
									{T.restore.viewKeyLede} <UI_Info title={T.explain.viewKeyTitle}>{T.explain.viewKey}</UI_Info>
								</p>
								<textarea
									ref={viewKeyRef}
									className="field viewkey-input"
									rows={4}
									{...SECRET_FIELD}
									placeholder={useStore.getState().network === "testnet" ? "uviewtest1…" : "uview1…"}
									value={viewKey}
									onChange={( e ) => { setViewKey( e.target.value.trim() ); setNudge( null ); }}
								/>
								{nudge && <p className="phrase-status bad">{nudge}</p>}
							</>
						)}

						{method === "zcashd" && (
							<>
								<p className="lede">
									{T.restore.zcashdLede} <UI_Info title={T.explain.zcashdTitle}>{T.explain.zcashd}</UI_Info>
								</p>
								<textarea
									ref={zcashdRef}
									className="field viewkey-input"
									rows={5}
									{...SECRET_FIELD}
									aria-label={T.restore.methodZcashd}
									placeholder={useStore.getState().network === "testnet" ? "secret-extended-key-test1…" : "secret-extended-key-main1…"}
									value={zcashd}
									onChange={( e ) => { setZcashd( e.target.value ); setNudge( null ); }}
								/>
								<UI_ZcashdLine check={zcheck} nudge={nudge} />
							</>
						)}

						<div className="row">
							<button className="btn" onClick={Back}>{T.common.back}</button>
							<button className="btn primary" onClick={Next}>{T.common.next}</button>
						</div>

						<p className="footnote">{T.restore.unsupported}</p>
					</>
				)}
			</div>
		</div>
	);
}
