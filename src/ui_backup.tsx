/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_backup.tsx -- backing up a wallet's recovery phrase: why it matters,
// the words themselves, a quick check that they were written down, done

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, Eye } from "lucide-react";

import { backupWord_t, Com_FormatDate, commands, recovery_t } from "./ui_local";
import { T } from "./ui_text";
import { useAction, useUncapturable } from "./ui_hooks";
import { UI_AskPassword } from "./ui_security";
import { useStore } from "./ui_store";
import { SECRET_FIELD, SPRING, UI_Alert, UI_Info, UI_Spinner } from "./ui_widgets";
import { UI_ArtBackup, UI_ArtDone, UI_ArtRule } from "./ui_art";

// the phrase's rules, in order, each with its picture; their words are T.backup.rules
const RULES = [ "paper", "secret", "noscreen" ] as const;

type step_t = "intro" | "reveal" | "verify" | "done";

// what the check answered: the words at their places, and the passphrase typed back
type backupProof_t = { words: backupWord_t[]; passphrase: string | null };

const STEP_ORDER: step_t[]	= [ "intro", "reveal", "verify", "done" ];
const VERIFY_SHARE			= 3;		// the check asks about one word in this many: 4 of 12, 8 of 24
const VERIFY_CHOICES		= 4;		// options offered for each


/*
=========================================================================

EXPLANATIONS

shared with the restore screen, so both say the same thing

=========================================================================
*/

export function UI_ExplainPhrase() {
	return <UI_Info title={T.explain.phraseTitle}>{T.explain.phrase}</UI_Info>;
}

export function UI_ExplainBirthday() {
	return <UI_Info title={T.explain.birthdayTitle}>{T.explain.birthday}</UI_Info>;
}

/*
==================
Com_Shuffle
==================
*/
function Com_Shuffle< V >( list: V[] ): V[] {
	const out = list.slice();

	for ( let i = out.length - 1; i > 0; i-- ) {
		const j = Com_RandomBelow( i + 1 );
		[ out[i], out[j] ] = [ out[j], out[i] ];
	}
	return out;
}

/*
==================
Com_RandomBelow

A uniform integer in [0, n) from the system's generator, not Math.random:
which words the check asks for stays unguessable. Rejection sampling, so
no value is likelier than another.
==================
*/
function Com_RandomBelow( n: number ): number {
	const limit = Math.floor( 0x100000000 / n ) * n;
	const draw = new Uint32Array( 1 );

	for ( ;; ) {
		crypto.getRandomValues( draw );
		if ( draw[0] < limit ) {
			return draw[0] % n;
		}
	}
}


/*
=========================================================================

STEPS

=========================================================================
*/

/*
==================
UI_FlowNav

The bar above every step: a way back on the left, where you are in the
middle. Nobody should ever be stuck on a screen.
==================
*/
function UI_FlowNav( props: { step: step_t; onBack: ( () => void ) | null; backLabel: string } ) {
	const at = STEP_ORDER.indexOf( props.step );

	return (
		<div className="flow-nav">
			<div>
				{props.onBack && (
					<button className="nav-back" onClick={props.onBack}>
						<ChevronLeft aria-hidden="true" />{props.backLabel}
					</button>
				)}
			</div>
			<div className="step-dots" role="img" aria-label={T.common.step( at + 1, STEP_ORDER.length )}>
				{STEP_ORDER.map( ( s, i ) => <span key={s} className={i === at ? "on" : i < at ? "past" : ""} /> )}
			</div>
			<div />
		</div>
	);
}

function UI_BackupIntro( props: { onNext: () => void; onLater: () => void; busy: boolean; note: string | null } ) {
	return (
		<>
			<UI_ArtBackup />
			<h1 className="onboard-title">{T.backup.introTitle}</h1>
			<p className="lede center">{T.backup.intro}</p>

			<ul className="rules">
				{RULES.map( ( rule ) => (
					<li key={rule}><UI_ArtRule kind={rule} /><span><b>{T.backup.rules[rule].strong}</b> {T.backup.rules[rule].text}</span></li>
				) )}
			</ul>

			<div className="onboard-actions">
				<button className="btn primary large" onClick={props.onNext} disabled={props.busy}>{props.busy ? <UI_Spinner size={16} /> : T.backup.show}</button>
				<button className="link" onClick={props.onLater}>{T.backup.later}</button>
			</div>
			{props.note && <p className="hint center">{props.note}</p>}
		</>
	);
}

// what a covered word shows: the blur hides the layout, and the words themselves
// aren't in the page (or the accessibility tree) until they're asked for
const HIDDEN_WORD = "•••••";

/*
==================
UI_BackupReveal

The words stay blurred, and out of the page, until asked for, so they
can't be read over a shoulder by accident, nor by anything reading the
page. The main button reveals them first, then moves on: it always does
something.
==================
*/
function UI_BackupReveal( props: { recovery: recovery_t; onNext: () => void } ) {
	const [ shown, setShown ] = useState( false );
	const words = props.recovery.seedPhrase.split( " " );
	const passphrase = props.recovery.passphrase;

	return (
		<>
			<h1 className="onboard-title">{T.backup.phraseTitle} <UI_ExplainPhrase /></h1>
			<p className="lede center">{T.backup.writeDown( words.length, passphrase != null )}</p>

			<div className={"phrase-card" + ( shown ? "" : " hidden" )}>
				<ol className="phrase">
					{words.map( ( word, i ) => (
						<li key={i}><span className="phrase-num">{i + 1}</span>{shown ? word : HIDDEN_WORD}</li>
					) )}
				</ol>
				{passphrase != null && (
					<div className="phrase-passphrase">
						<span className="phrase-passphrase-label">
							{T.backup.passphrase} <UI_Info title={T.explain.passphraseTitle}>{T.explain.passphrase}</UI_Info>
						</span>
						<span className="phrase-passphrase-value">{shown ? passphrase : HIDDEN_WORD}</span>
						{shown && passphrase !== passphrase.trim() && <span className="phrase-passphrase-edges">{T.backup.passphraseEdges}</span>}
					</div>
				)}
				{!shown && (
					<button className="phrase-cover" onClick={() => setShown( true )}>
						<Eye aria-hidden="true" />
						<span>{T.backup.revealHint}</span>
						<span className="phrase-cover-hint">{T.backup.watching}</span>
					</button>
				)}
			</div>

			<div className="birthday-card">
				<div className="birthday-label">{T.backup.birthday} <UI_ExplainBirthday /></div>
				<div className="birthday-date">
					{props.recovery.birthdayTime != null ? Com_FormatDate( props.recovery.birthdayTime ) : T.backup.dateUnknown}
				</div>
				<div className="birthday-block">{T.backup.block( props.recovery.birthday )}</div>
			</div>

			<div className="onboard-actions">
				{shown
					? <button className="btn primary large" onClick={props.onNext}>{T.backup.written}</button>
					: <button className="btn primary large" onClick={() => setShown( true )}>{T.backup.reveal}</button>}
			</div>
		</>
	);
}

/*
==================
UI_BackupVerify

A third of the words, four choices each, and then the passphrase if
there is one, typed back exactly. A wrong pick starts the check over
with other words: with a free retry per row, clicking through the
choices once passed it with no paper at all.
==================
*/
function UI_BackupVerify( props: { recovery: recovery_t; onDone: ( proof: backupProof_t ) => void } ) {
	const words = props.recovery.seedPhrase.split( " " );
	const passphrase = props.recovery.passphrase;
	const [ round, setRound ] = useState( 0 );		// each wrong pick is a new round, with new questions

	const questions = useMemo( () => {
		const count = Math.ceil( words.length / VERIFY_SHARE );
		const positions = Com_Shuffle( words.map( ( _, i ) => i ) ).slice( 0, count ).sort( ( a, b ) => a - b );

		return positions.map( ( pos ) => {
			const others = Array.from( new Set( words.filter( ( w ) => w !== words[pos] ) ) );
			const choices = Com_Shuffle( [ words[pos], ...Com_Shuffle( others ).slice( 0, VERIFY_CHOICES - 1 ) ] );
			return { pos, choices };
		} );
	}, [ props.recovery.seedPhrase, round ] );

	const [ answers, setAnswers ]	= useState< ( string | null )[] >( questions.map( () => null ) );
	const [ wrong, setWrong ]		= useState< { word: string; pos: number } | null >( null );
	const [ typed, setTyped ]		= useState( "" );
	const wordsRight				= answers.length === questions.length && answers.every( ( a ) => a !== null );
	const allRight					= wordsRight && ( passphrase == null || typed === passphrase );

	function Pick( q: number, word: string ) {
		if ( word !== words[questions[q].pos] ) {
			// said, then over again: nothing answered so far counts
			setWrong( { word, pos: questions[q].pos } );
			setRound( ( r ) => r + 1 );
			setAnswers( Array.from( { length: Math.ceil( words.length / VERIFY_SHARE ) }, () => null ) );
			return;
		}
		setAnswers( ( old ) => old.map( ( a, i ) => ( i === q ? word : a ) ) );
	}

	useEffect( () => {
		if ( allRight ) {
			// the answers go along: Laurel marks the wallet only when they match its phrase
			const proof = { words: questions.map( ( q, i ) => ( { pos: q.pos, word: answers[i] ?? "" } ) ), passphrase: passphrase == null ? null : typed };
			const t = setTimeout( () => props.onDone( proof ), 500 );		// let the last green land first
			return () => clearTimeout( t );
		}
	}, [ allRight ] );

	return (
		<>
			<h1 className="onboard-title">{T.backup.checkTitle}</h1>
			<p className="lede center">{T.backup.check}</p>

			<div className="verify">
				{questions.map( ( question, q ) => (
					<div key={question.pos} className={"verify-row" + ( answers[q] ? " right" : "" )}>
						<div className="verify-label">{T.backup.wordNumber( question.pos + 1 )}</div>
						<div className="verify-choices">
							{question.choices.map( ( word ) => (
								<button
									key={word}
									className={"chip" + ( answers[q] === word ? " right" : "" )}
									disabled={answers[q] !== null}
									onClick={() => Pick( q, word )}
								>
									{word}
								</button>
							) )}
						</div>
					</div>
				) )}
			</div>

			{wordsRight && passphrase != null && (
				<div className="field-row">
					<label className="label" htmlFor="verify-passphrase">{T.backup.passphrase}</label>
					<input
						id="verify-passphrase"
						className="field passphrase-input"
						value={typed}
						{...SECRET_FIELD}
						autoFocus
						onChange={( e ) => setTyped( e.target.value )}
					/>
					<p className="hint">{T.backup.passphraseCheck}</p>
				</div>
			)}

			<p className={"verify-status" + ( wrong ? " bad" : "" )}>
				{wrong ? `${T.backup.wrongWord( wrong.word, wrong.pos + 1 )} ${T.backup.startOver}` : " "}
			</p>
		</>
	);
}

function UI_BackupDone( props: { onDone: () => void } ) {
	return (
		<>
			<UI_ArtDone />
			<h1 className="onboard-title">{T.backup.doneTitle}</h1>
			<p className="lede center">{T.backup.done}</p>
			<div className="onboard-actions">
				<button className="btn primary large" onClick={props.onDone}>{T.backup.open}</button>
			</div>
		</>
	);
}


/*
=========================================================================

FLOW

=========================================================================
*/

/*
==================
UI_Backup

Backs up one wallet. recovery is passed straight after creating a
wallet; from the banner or the switcher it is fetched here. Once the
engine has it marked, the words are let go of here, and onMarked tells
the screen that passed them to let go of its copy (W1-08).
==================
*/
export function UI_Backup( props: {
	walletId:	string;
	recovery:	recovery_t | null;
	onDone:		() => void;
	onLater:	() => void;
	onMarked?:	() => void;
} ) {
	const refresh		= useStore( ( s ) => s.Refresh );
	const usesPassword	= useStore( ( s ) => s.vault?.protection === "password" );

	const [ step, setStep ]			= useState< step_t >( "intro" );
	const [ asking, setAsking ]		= useState( false );

	// held by this screen only, and only once asked for: the engine gives the
	// phrase to someone who just typed the password (V_Confirm), and it is
	// gone when the screen closes
	const [ recovery, setRecovery ]	= useState< recovery_t | null >( props.recovery );
	async function Fetch( password: string | null ) {
		setRecovery( await commands.wRecoveryF( props.walletId, password ) );
		setStep( "reveal" );
	}
	// action, not a load
	const fetch = useAction( Fetch );
	function Show() {
		if ( recovery ) {
			setStep( "reveal" );
		} else if ( usesPassword ) {
			setAsking( true );
		} else {
			void fetch.run( null );
		}
	}

	// while the words are on screen, a screenshot or a shared screen shows nothing
	useUncapturable( recovery !== null && ( step === "reveal" || step === "verify" ) );

	const [ proof, setProof ] = useState< backupProof_t | null >( null );
	const mark = useAction( async ( given?: backupProof_t ) => {
		const p = given ?? proof;
		if ( !p ) {
			return;
		}
		setProof( p );
		await commands.wMarkBackedUpF( props.walletId, p.words, p.passphrase );
		// marked: nothing here needs the words again (the done screen shows none of them)
		setRecovery( null );
		setProof( null );
		props.onMarked?.();
		await refresh();
		setStep( "done" );
	} );

	// back goes one step; from the first step it leaves the flow
	const back: Record< step_t, ( () => void ) | null > = {
		intro:	props.onLater,
		reveal:	() => setStep( "intro" ),
		verify:	() => setStep( "reveal" ),
		done:	null,
	};

	let body;
	if ( step === "done" ) {
		body = <UI_BackupDone onDone={props.onDone} />;
	} else if ( step === "intro" || !recovery ) {
		body = (
			<>
				<UI_BackupIntro onNext={Show} onLater={props.onLater} busy={fetch.busy} note={recovery || usesPassword ? null : T.backup.noPassword} />
				{fetch.error && <UI_Alert title={T.backup.loadFailed} message={fetch.error} action={T.common.tryAgain} onAction={Show} />}
			</>
		);
	} else if ( step === "reveal" ) {
		body = <UI_BackupReveal recovery={recovery} onNext={() => setStep( "verify" )} />;
	} else if ( step === "verify" ) {
		body = (
			<>
				<UI_BackupVerify recovery={recovery} onDone={( p ) => mark.run( p )} />
				{mark.error && <UI_Alert title={T.backup.loadFailed} message={mark.error} action={T.common.tryAgain} onAction={() => mark.run()} />}
			</>
		);
	}

	return (
		<div className="onboard">
			<div className="onboard-card backup">
				<UI_FlowNav
					step={step}
					onBack={back[step]}
					backLabel={step === "intro" ? T.common.close : T.common.back}
				/>
				<AnimatePresence mode="wait" initial={false}>
					<motion.div
						key={step}
						className="flow-body"
						initial={{ opacity: 0, x: 24 }}
						animate={{ opacity: 1, x: 0 }}
						exit={{ opacity: 0, x: -24 }}
						transition={SPRING}
					>
						{body}
					</motion.div>
				</AnimatePresence>
			</div>
			<UI_AskPassword
				open={asking}
				onOpenChange={setAsking}
				title={T.backup.show}
				why={T.backup.askWhy}
				action={T.backup.show}
				onConfirm={Fetch}
			/>
		</div>
	);
}
