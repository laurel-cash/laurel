/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// check_owners.mjs -- each shared shape is written in one file, and some
// shapes in none
//
// A sheet footer, a date, a shortened address: each had one owner, and
// was still written again by hand in the next screen, a little different
// each time (a public address cut short in History after Receive learned
// not to). jscpd finds copies only when they're long; these are one line.
// So the shape itself is owned: only its file may write it.
//
// Deciding what an error means from its words has no owner at all: a
// server a block behind at the tip once read as "could not reach the
// server" because its gRPC code was flattened into text first. Errors are
// classified by type, once, in Com_Classify (src-tauri/src/w_net.rs).
//
// State at module level has two owners, and each must start the page over
// on a hot update (RELOADS): a hot update once made a second, empty store
// that the screens watched while nothing started it, a spinner forever.
//
//   node scripts/check_owners.mjs

import { readdirSync, readFileSync } from "node:fs";
import { Com_ErrorsEn, Com_ErrorsFile } from "./make_errors.mjs";
import { join } from "node:path";

const UI		= "src";
const APP_SRC	= "src-tauri/src";		// rust, where the errors are (w_local.rs)
const ENGINE	= "src-tauri/src";

const OWNERS = [
	{ dir: UI,		shape: /className="chart-empty"/,								owner: "ui_widgets.tsx",		use: "UI_Empty" },
	{ dir: UI,		shape: /className="sheet-buttons"/,							owner: "ui_widgets.tsx",		use: "UI_SheetButtons or UI_SheetClose" },
	{ dir: UI,		shape: /\b(Dialog|Popover|Tooltip)\.Root\b/,				owner: "ui_widgets.tsx",		use: "UI_Sheet, UI_Info or UI_Tip" },
	{ dir: UI,		shape: /toLocale(Date|Time)String|Intl\.(DateTimeFormat|RelativeTimeFormat)/,	owner: "ui_local.ts",		use: "Com_FormatDate( unix, style )" },
	{ dir: UI,		shape: /style:\s*"currency"/,								owner: "ui_local.ts",		use: "Com_FormatUsd: the chart and the alerts each made their own" },
	{ dir: UI,		shape: /…\$?\{/,											owner: "ui_local.ts",		use: "Com_Abbrev" },
	{ dir: UI,		shape: /\bparse(Float|Int)\s*\(|\.replace\(\s*["'][,.]["']/,	owner: "ui_local.ts",		use: "Com_ParseZec: typed amounts are parsed exactly, from the string, never rewritten first (\"1,000\" once became 1 ZEC)" },
	{ dir: UI,		shape: /\bauto(Complete|Capitalize|Correct)=/,					owner: "ui_widgets.tsx",		use: "{...SECRET_FIELD}: written by hand per box, the viewing key's and the backup check's passphrase each missed one" },
	{ dir: UI,		shape: /\b(anonymous|untraceable|hide from|vpns?)\b/i,					owner: null,				use: "plain words: no evasion wording and no way around a country's restrictions (standing constraints: an exchange's support to sanctioned users cost it $3.1M)" },
	{ dir: ENGINE,	shape: /\b(anonymous|untraceable|hide from|vpns?)\b/i,					owner: null,				use: "plain words: no evasion wording and no way around a country's restrictions (standing constraints)" },
	{ dir: UI,		shape: /Math\.random\s*\(/,									owner: null,				use: "crypto.getRandomValues (Com_RandomBelow, ui_backup.tsx): which phrase words the backup check asked for came from Math.random, a generator anyone can predict" },
	{ dir: UI,		shape: /dangerouslySetInnerHTML|\.innerHTML\s*=/,				owner: null,				use: "text nodes: memos, labels and messages are anyone's words and stay inert (never markup, never a link)" },
	{ dir: UI,		shape: /useStore\(\s*\(\s*s\s*\)\s*=>[^;)]*(\?\?\s*[[{]|\.(map|filter|slice|concat)\(|=>\s*\(\s*\{|=>\s*\[)/,
																				owner: null,				use: "select what the store holds and derive after: a selector that builds a new array or object each call re-renders forever (\"?? []\" once looped History)" },
	// (the sync capsule's label is its own live progress, "Syncing 45%": not a fixed wait)
	{ dir: UI,		shape: /<UI_Spinner[^>]*\/>\s*\{(?!\s*Com_SyncLabel)/,		owner: "ui_widgets.tsx",		use: "UI_Waiting: a spinner with fixed words looked hung after twenty seconds; UI_Waiting says how long and why" },
	{ dir: UI,		shape: /clipboard\.writeText/,								owner: "ui_widgets.tsx",		use: "UI_CopyButton" },
	{ dir: UI,		shape: /\bcreate\s*[<(]/,									owner: "ui_store.ts",		use: "a slice of the store, or a query (ui_query.ts) for engine data" },
	{ dir: UI,		shape: /\bevents\.\w+\.listen\s*\(/,								owner: "ui_store.ts",		use: "St_Start: every engine event is heard once, for the app's life; a hook that listened on each mount heard it once per copy" },
	{ dir: UI,		shape: /[eE]rror\s*[:=][^;]*Com_ErrorString/,						owner: null,				use: "Com_ErrorOf: an error kept for an alert keeps its detail (the key file's and the wallet list's once lost theirs)" },
	{ dir: UI,		shape: /^(?!\s*--).*rgba\(\s*(100,\s*209,\s*138|245,\s*196,\s*81|231,\s*244,\s*239|167,\s*227,\s*184|8,\s*30,\s*42)\s*,/,
																				owner: null,				use: "color-mix( in srgb, var( --token ) N%, transparent ): 35 places wrote a token's colour out as numbers, and a change to the token would have missed them" },
	{ dir: UI,		shape: /maxLength=\{\s*[0-9]/,								owner: null,				use: "the engine's limit (constants_t): the contact sheet copied 40 and 200, and History's note had none" },
	{ dir: UI,		shape: /\bnew QueryClient\b/,									owner: "ui_query.ts",		use: "QUERY" },
	{ dir: UI,		shape: /^let\s/,											owner: "ui_store.ts",		use: "component state, or the store" },
	{ dir: UI,		shape: /font-size:\s*(?:(?:[0-9]|10)(?:\.\d+)?px|[0-9.]+r?em)\s*;/,
																				owner: null,				use: "var( --text-min ) or larger; a relative size only as max( var( --text-min ), ... ): a unit at 0.42em once read at 5 px next to a small amount" },
	{ dir: ENGINE,	shape: /log::\w+!\(.*(\{(e|err|error|why)\}|",(.*,)?\s*(e|err|error)\s*[,)])/,
																				owner: null,				use: "an explicit conversion: e.LogText() for a werr_t (it keeps typed phrase words and contact names out of the log), e.to_string() for anything else" },
	{ dir: ENGINE,	shape: /log::\w+!\(.*\b(zats|amount|fee|balance|total|value)\b/,
																				owner: null,				use: "no amount in a log line: a bare number can't be masked (Com_LogSafe masks only one with its unit), and how much someone holds or pays is theirs" },
	{ dir: ENGINE,	shape: /\bw_baseDir\s*\.\s*get\b/,							owner: "w_local.rs",		use: "Com_DataPath or Com_NetworkPath: the data folder was read five ways, with three answers to \"not set yet\" (a panic, none, an error)" },
	{ dir: ENGINE,	shape: /NotificationExt|\.notification\s*\(\s*\)/,				owner: "w_notice.rs",		use: "N_System: one gate (Laurel not in front, Settings on); the ungated one once let a price alert speak with notifications off" },
	{ dir: ENGINE,	shape: /\b[A-Z][a-z]*_\w+\([^()]*\)\s*\.unwrap_or_default\s*\(\s*\)/,
																				owner: null,				use: "a failed engine read is not zero: keep the last known and log why (an unreadable account once showed 0 ZEC)" },
	{ dir: ENGINE,	shape: /std::fs::(read|read_to_string|write)\s*\(|ErrorKind::NotFound/,
																				owner: "w_disk.rs",			use: "Com_ReadIfThere, Com_ReadJson or Com_WriteJson: four files were read by hand three ways, and one written without the flush" },
	{ dir: ENGINE,	shape: /format!\([^;]*Com_NowMsec/,								owner: "w_date.rs",			use: "Com_NewId: an id from the clock alone is shared by two made in one millisecond" },
	{ dir: ENGINE,	shape: /DialogExt|\.dialog\s*\(\s*\)/,							owner: "w_dialog.rs",		use: "D_PickFolder, D_PickFile or D_SaveFile: the pickers open from one place, and the ui gets paths, never file access" },
	{ dir: ENGINE,	shape: /blake2b_simd::/,									owner: "w_vault.rs",		use: "Com_Hash( personal, len, data ): three places built a personalized digest by hand" },
	{ dir: ENGINE,	shape: /WalletConfig::NewSeed\b|Mnemonic::\s*<\s*English\s*>::generate\b/,	owner: null,		use: "W_NewPhrase (w_phrase.rs): a new phrase's 256 bits straight from OsRng; the engine's NewSeed went through bip0039's rand::rng(), one generator more (security review 2026-10)" },
	{ dir: ENGINE,	shape: /SystemTime::now\s*\(/,								owner: "w_date.rs",			use: "Com_Now or Com_NowMsec: seven places read the clock, three through helpers of their own" },
	{ dir: ENGINE,	shape: /\bConfirmationStatus\b|\.is_confirmed\s*\(/,
																				owner: "w_history.rs",		use: "Com_TxState: the engine's transaction states are read in one place, each as itself (\"not confirmed\" once hid an expired payment, and its change read as money received)" },
	{ dir: ENGINE,	shape: /(?<!fn )\bV_Made\s*\(/,									owner: "w_main.rs",			use: "V_Confirm: a phrase or a looser lock is for someone just asked; V_Made is only for the wallet W_Create has just made" },
	{ dir: ENGINE,	shape: /\b(why|msg|message|chain|cause|err|error|e)\s*\.\s*(contains|starts_with|ends_with|find)\s*\(/,
																				owner: null,				use: "Com_Classify in w_net.rs: decide from the error's type, never its words" },
];

// a file's lines outside its tests (rust: from "#[cfg( test )]" on)
function Lines( dir, file ) {
	const lines = readFileSync( join( dir, file ), "utf8" ).split( "\n" );
	// the test module is "#[cfg( test )]" with "mod tests" under it: any other
	// test-only item (a shorter timeout, say) once hid the rest of the file,
	// most of w_engine.rs, from every rule here
	const tests = lines.findIndex( ( l, i ) => /^#\[cfg\(\s*test\s*\)\]/.test( l ) && /^mod tests\b/.test( lines[i + 1] ?? "" ) );
	return tests < 0 ? lines : lines.slice( 0, tests );
}

// the files that hold module state, and the line that makes them restart the page
const RELOADS = [ "ui_store.ts", "ui_query.ts" ];
const RELOAD_LINE = "import.meta.hot?.accept( () => location.reload() );";

let bad = 0;

// no control characters in source: an edit script once wrote a backspace
// where a regex said \b, and a guard silently matched nothing
for ( const dir of [ UI, ENGINE, "scripts" ] ) {
	for ( const file of readdirSync( dir ).filter( ( f ) => /\.(tsx?|rs|mjs|css)$/.test( f ) ) ) {
		readFileSync( join( dir, file ), "utf8" ).split( "\n" ).forEach( ( line, i ) => {
			if ( /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test( line ) ) {
				console.error( `${dir}/${file}:${i + 1}: a control character; write the escape (\\b, \\t...) itself` );
				bad++;
			}
		} );
	}
}

// rules written exactly once: a copy per place is how the places without
// one were missed (an error's long Hash(...) pushed out of its alert)
const ONCE = [
	{ file: join( UI, "ui.css" ),	shape: /overflow-wrap:/g,	why: "text wraps from the one rule on body" },
];
for ( const o of ONCE ) {
	const n = ( readFileSync( o.file, "utf8" ).match( o.shape ) ?? [] ).length;
	if ( n !== 1 ) {
		console.error( `${o.file}: ${o.shape.source} written ${n} times; ${o.why}` );
		bad++;
	}
}

// each animation defined once: a second @keyframes shake silently replaced
// the first, and the sync capsule's gentle shake became another one
const names = [ ...readFileSync( join( UI, "ui.css" ), "utf8" ).matchAll( /@keyframes\s+([\w-]+)/g ) ].map( ( m ) => m[1] );
for ( const name of new Set( names.filter( ( n, i ) => names.indexOf( n ) !== i ) ) ) {
	console.error( `${UI}/ui.css: @keyframes ${name} is defined more than once; the last one silently wins` );
	bad++;
}

/*
==================
CSS_Rules

Every style rule in css with the at-rules around it (its context) and
its line. @keyframes steps are not selectors and are left out.
==================
*/
function CSS_Rules( css ) {
	const rules = [];
	const stack = [];
	let prelude = "";
	let line = 1;
	for ( let i = 0; i < css.length; i++ ) {
		const ch = css[i];
		if ( css.startsWith( "/*", i ) ) {
			const end = css.indexOf( "*/", i + 2 );
			line += ( css.slice( i, end ).match( /\n/g ) ?? [] ).length;
			i = end + 1;
		} else if ( ch === "{" ) {
			const head = prelude.trim().replace( /\s+/g, " " );
			const inKeyframes = stack.some( ( s ) => s.startsWith( "@keyframes" ) );
			if ( !head.startsWith( "@" ) && !inKeyframes ) {
				rules.push( { context: stack.join( " " ), selectors: head.split( "," ).map( ( s ) => s.trim() ), line: line } );
			}
			stack.push( head );
			prelude = "";
		} else if ( ch === "}" ) {
			stack.pop();
			prelude = "";
		} else if ( ch === ";" ) {
			prelude = "";
		} else {
			if ( ch === "\n" ) {
				line++;
			}
			prelude += ch;
		}
	}
	return rules;
}

// an amount is never cut: "12.80" once showed as "12..." at a large text
// size. A rule for an amount may not hide what doesn't fit; the layout
// must make room (the balance split stacks when its card is narrow)
{
	let selector = "";
	readFileSync( join( UI, "ui.css" ), "utf8" ).split( "\n" ).forEach( ( line, i ) => {
		const open = /^\s*([^\s{@][^{]*?)\s*\{/.exec( line );
		if ( open ) {
			selector = open[1];
		}
		if ( /(amount|total|balance)/.test( selector ) && /^\s*(text-overflow:|overflow:\s*hidden)/.test( line ) ) {
			console.error( `${UI}/ui.css:${i + 1}: "${selector}" can cut an amount; let it show whole and make room in the layout` );
			bad++;
		}
	} );
}

// each selector has one rule of its own per context: a second
// ".home-grid {" silently overrode the first, whose 300px column was dead
// and misled every reader (a selector in a shared group rule and in its
// own rule is fine: that is how shared styles are written)
const seen = new Map();
for ( const r of CSS_Rules( readFileSync( join( UI, "ui.css" ), "utf8" ) ) ) {
	const key = `${r.context}|${r.selectors.join( ", " )}`;
	if ( seen.has( key ) ) {
		console.error( `${UI}/ui.css:${r.line}: "${r.selectors.join( ", " )}" already has a rule at line ${seen.get( key )}${r.context ? ` in ${r.context}` : ""}; merge them, or the later one silently wins` );
		bad++;
	} else {
		seen.set( key, r.line );
	}
}

// every class the markup names has a rule: .section-title sat on fifteen
// headings with none, so each was a bare browser heading, and only one
// place had been patched. A class ending in "-" is a prefix the markup
// completes ("pane-" + id); some rule must start with it. A wrapper that
// needs no style carries no class.
//
// A class only in a compound with another (".center" only as ".lede.center")
// styles nothing on an element without that other class: "hint center"
// once passed, centred by no rule. When the markup writes the whole class
// list, some compound holding the class must hold nothing the list lacks.
const cssText = readFileSync( join( UI, "ui.css" ), "utf8" ).replace( /\/\*[\s\S]*?\*\//g, "" );
const definedClasses = new Set( [ ...cssText.matchAll( /\.([a-zA-Z][\w-]*)/g ) ].map( ( m ) => m[1] ) );
const compounds = CSS_Rules( cssText ).flatMap( ( r ) => r.selectors )
	.flatMap( ( s ) => s.split( /[\s>+~]+/ ) )
	.map( ( c ) => [ ...c.replace( /:[\w-]+(\([^)]*\))?/g, "" ).matchAll( /\.([a-zA-Z][\w-]*)/g ) ].map( ( m ) => m[1] ) )
	.filter( ( c ) => c.length > 0 );
for ( const file of readdirSync( UI ).filter( ( f ) => f.endsWith( ".tsx" ) && !f.includes( ".test." ) ) ) {
	Lines( UI, file ).forEach( ( line, i ) => {
		for ( const m of line.matchAll( /className=(\{\s*)?"([^"]*)"(\s*\})?/g ) ) {
			const list = m[2].split( /\s+/ ).filter( Boolean );
			const whole = !m[1] || !!m[3];		// "..." or {"..."}: nothing is added to the list at run time
			for ( const name of list ) {
				const known = name.endsWith( "-" )
					? [ ...definedClasses ].some( ( d ) => d.startsWith( name ) )
					: whole
						? compounds.some( ( c ) => c.includes( name ) && c.every( ( x ) => list.includes( x ) ) )
						: definedClasses.has( name );
				if ( !known ) {
					console.error( `${UI}/${file}:${i + 1}: class "${name}" has no rule in ui.css; style it, or leave the class off` );
					bad++;
				}
			}
		}
	} );
}

// A class made from a value ("pane-" + pane) passes above when any "pane-"
// rule exists, so each value is checked here: Sync and Offline Signing
// were added without a tile colour, and their icons drew bare.
const PANE_TYPE = /type settingsPane_t\s*=([^;]+);/.exec( readFileSync( join( UI, "ui_store.ts" ), "utf8" ) );
for ( const pane of [ ...( PANE_TYPE?.[1] ?? "" ).matchAll( /"([\w-]+)"/g ) ].map( ( m ) => m[1] ) ) {
	if ( !definedClasses.has( `pane-${pane}` ) ) {
		console.error( `${UI}/ui.css: settings pane "${pane}" has no .pane-${pane} tile colour` );
		bad++;
	}
}
if ( !PANE_TYPE ) {
	console.error( `${UI}/ui_store.ts: settingsPane_t not found; check_owners reads the panes from it` );
	bad++;
}

for ( const file of RELOADS ) {
	if ( !readFileSync( join( UI, file ), "utf8" ).includes( RELOAD_LINE ) ) {
		console.error( `${UI}/${file}: holds module state; it must end with ${RELOAD_LINE}` );
		bad++;
	}
}
for ( const dir of [ UI, ENGINE ] ) {
	const files = readdirSync( dir ).filter( ( f ) => /\.(tsx?|rs|css)$/.test( f ) && !f.includes( ".test." ) && f !== "bindings.ts" );
	for ( const file of files ) {
		Lines( dir, file ).forEach( ( line, i ) => {
			for ( const o of OWNERS.filter( ( o ) => o.dir === dir ) ) {
				if ( file !== o.owner && o.shape.test( line ) ) {
					console.error( `${dir}/${file}:${i + 1}: ${o.owner ? `${o.owner} owns this` : "not written anywhere"}; use ${o.use}` );
					bad++;
				}
			}
		} );
	}
}

// tests build the engine's values with one builder each (test_engine.ts): six
// hand-written settings objects had gone stale, four missing fields a cast or
// an untyped mock hid from the compiler. A value's telltale fields, written
// in a test anywhere else, are refused.
const TEST_OWNED = [
	{ shape: /notifyInApp:\s/,							use: "Test_Settings" },
	{ shape: /maxNameLen:\s/,							use: "Test_Constants" },
	{ shape: /\bas never\b/,							use: "a builder, typed whole: five tests cast a part of an engine value through, hiding every field added since" },
	{ shape: /\}\s*as (unknown as )?[a-zA-Z]+_t\b/,		use: "a builder (Test_*), or the value typed whole: an object cast as an engine type hides every field it lacks (a wallet summary once lacked what it may do)" },
	{ shape: /\bspendable:\s/,							use: "Test_Balance" },		// a whole balance names it; the builder's pools don't
	{ shape: /label:\s*null,\s*message:\s*null/,		use: "Test_Scanned" },
	{ shape: /memo:\s*(null|\w+),\s*note:\s/,			use: "Test_Item" },
];
for ( const file of readdirSync( UI ).filter( ( f ) => f.includes( ".test." ) ) ) {
	readFileSync( join( UI, file ), "utf8" ).split( "\n" ).forEach( ( line, i ) => {
		for ( const o of TEST_OWNED ) {
			if ( o.shape.test( line ) ) {
				console.error( `${UI}/${file}:${i + 1}: test_engine.ts builds this; use ${o.use}` );
				bad++;
			}
		}
	} );
}

// a sheet's actions are given its open (useAction, useConfirm): each opening
// then starts with no error. Nineteen sheets cleared theirs by hand or not
// at all, and ten showed a failure from the last time on a fresh sheet.
function Close( text, open ) {
	let depth = 0;
	for ( let i = open; i < text.length; i++ ) {
		if ( text.startsWith( "//", i ) ) {
			i = text.indexOf( "\n", i );
			continue;
		}
		const c = text[i];
		if ( c === "\"" || c === "`" ) {
			i = text.indexOf( c, i + 1 );
		} else if ( "([{".includes( c ) ) {
			depth++;
		} else if ( ")]}".includes( c ) && --depth === 0 ) {
			return i;
		}
	}
	return -1;
}
let sheetActions = 0;
for ( const file of readdirSync( UI ).filter( ( f ) => f.endsWith( ".tsx" ) && !f.includes( ".test." ) ) ) {
	const text = readFileSync( join( UI, file ), "utf8" );
	for ( const part of text.split( /\n(?=(?:export )?function UI_)/ ) ) {
		if ( !part.includes( "<UI_Sheet" ) ) {
			continue;
		}
		for ( const m of part.matchAll( /\buse(Action|Confirm)\s*(?:<[^>]*>)?\(/g ) ) {
			const close = Close( part, m.index + m[0].length - 1 );
			sheetActions++;
			if ( !/props\.open,?\s*$/.test( part.slice( 0, close ) ) ) {
				const line = text.slice( 0, text.indexOf( part ) + m.index ).split( "\n" ).length;
				console.error( `${UI}/${file}:${line}: a sheet's action; give it props.open, so each opening starts with no error from the last` );
				bad++;
			}
		}
	}
}

// a sentence is said once (ui_text.ts): Send and Shield each had the same
// four, and Sweep borrowed Shield's ("T.shield.offline"). A short label may
// repeat, as each place's own word; a sentence has one key.
const SENTENCE_MIN = 25;
const said = new Map();
readFileSync( join( UI, "ui_text.ts" ), "utf8" ).split( "\n" ).forEach( ( line, i ) => {
	const m = /^\t\t\w+:\s+"([^"]+)"/.exec( line );
	if ( !m || m[1].length < SENTENCE_MIN ) {
		return;
	}
	if ( said.has( m[1] ) ) {
		console.error( `${UI}/ui_text.ts:${i + 1}: said already at line ${said.get( m[1] )}; share that key` );
		bad++;
	}
	said.set( m[1], i + 1 );
} );

// counting is each language's own (ui_locale.ts, Com_Plural): "n === 1 ?"
// is English's two forms, and wrong for a language with three or six. It
// also said "About 1 minutes left". Every language's text is held to it.
let counted = 0;
for ( const file of readdirSync( UI ).filter( ( f ) => /^ui_text.*\.ts$/.test( f ) ) ) {
	readFileSync( join( UI, file ), "utf8" ).split( "\n" ).forEach( ( line, i ) => {
		const code = line.replace( /\/\/.*$/, "" );
		if ( /[!=]==?\s*1\s*\?|\b\w+\s*>\s*1\s*\?/.test( code ) ) {
			console.error( `${UI}/${file}:${i + 1}: a plural chosen by "=== 1": use plural( n, { one, other } ), the language's own forms` );
			bad++;
		}
		counted += ( code.match( /\bplural\(/g ) ?? [] ).length;
	} );
}

// rust's errors in the ui's words (ui_text.ts errors, w_local.rs werr_t):
// one sentence for every kind and none for a kind that's gone, and no
// sentence asking for a value ({1}) its kind doesn't send (werr_t::Args)
const RUST_LOCAL = readFileSync( join( APP_SRC, "w_local.rs" ), "utf8" ).replace( /\r\n/g, "\n" );
const kinds = new Map();		// name -> how many values Args sends
const argsFn = RUST_LOCAL.slice( RUST_LOCAL.indexOf( "pub fn Args( &self )" ) );
for ( const m of argsFn.slice( 0, argsFn.indexOf( "\n\t}\n" ) ).matchAll( /werr_t::(WERR_\w+)[^=\n]*=> (vec!\[([^\]]*)\]|inner\.Args\(\))/g ) ) {
	kinds.set( m[1], m[3] === undefined ? -1 : m[3].trim() === "" ? 0 : m[3].split( "," ).length );
}
// English is Rust's own (make_errors.mjs), with the screen's few wordings of its own over it
if ( Com_ErrorsFile() !== readFileSync( join( UI, "generated", "errors.ts" ), "utf8" ).replace( /\r\n/g, "\n" ) ) {
	console.error( `${UI}/generated/errors.ts is out of date with w_local.rs werr_t: run npm run bindings` );
	bad++;
}
const TEXT = readFileSync( join( UI, "ui_text.ts" ), "utf8" ).replace( /\r\n/g, "\n" );
const errorsBlock = TEXT.slice( TEXT.indexOf( "\terrors: {" ), TEXT.indexOf( "\n\t},", TEXT.indexOf( "\terrors: {" ) ) );
const worded = new Map( [ ...Com_ErrorsEn(), ...[ ...errorsBlock.matchAll( /^\t\t(WERR_\w+):\s+"((?:[^"\\]|\\.)*)"/gm ) ].map( ( m ) => [ m[1], m[2] ] ) ] );
for ( const [ kind, values ] of kinds ) {
	if ( values < 0 ) {
		continue;		// WERR_TYPED: the kind it wraps is the one said
	}
	if ( !worded.has( kind ) ) {
		console.error( `${UI}/ui_text.ts errors: no sentence for ${kind} (w_local.rs werr_t): the screen would fall back to rust's English` );
		bad++;
		continue;
	}
	const asked = Math.max( -1, ...[ ...worded.get( kind ).matchAll( /\{(\d+)\}/g ) ].map( ( m ) => Number( m[1] ) ) );
	if ( asked >= values ) {
		console.error( `${UI}/ui_text.ts errors.${kind}: asks for {${asked}}, but werr_t::Args sends ${values} value(s)` );
		bad++;
	}
}
for ( const kind of worded.keys() ) {
	if ( !kinds.has( kind ) ) {
		console.error( `${UI}/ui_text.ts errors.${kind}: no such error in w_local.rs werr_t any more` );
		bad++;
	}
}

if ( bad ) {
	process.exit( 1 );
}
console.log( `check_owners: ${OWNERS.length} shapes, each in its own file or none; ${TEST_OWNED.length} test values, each from its builder; ${sheetActions} sheet actions, each given its open; ${said.size} sentences, each said once; ${counted} plurals, each by its language's rules; ${worded.size} of rust's errors, one English each, every value sent` );
