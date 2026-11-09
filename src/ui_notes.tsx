/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_notes.tsx -- what's new: the release notes (docs/RELEASE-NOTES.md, read
// as the app is built), shown once after an update and always in About
//
// Nothing is fetched: the notes are the ones this build was made with.
// Which version was last seen is a per-computer preference; losing it only
// shows the newest notes once more.

import { useEffect, useState } from "react";

import { Check } from "lucide-react";
import { APP_VERSION, Com_FormatDate, Com_ReadPref, Com_ReleaseNotes, Com_WritePref, PREF_NOTES_SEEN, releaseNote_t } from "./ui_local";
import { T } from "./ui_text";
import { sheetProps_t, UI_Sheet, UI_SheetClose } from "./ui_widgets";
import { UI_AppIcon } from "./ui_chrome";

import NOTES_TEXT from "../docs/RELEASE-NOTES.md?raw";



// versions and days (data); what each says is the language's (T.releaseNotes)
export const RELEASE_NOTES = Com_ReleaseNotes( NOTES_TEXT );

// a version's changes in the screen's language; English where a translation has none yet
function Com_NoteItems( note: releaseNote_t ): readonly string[] {
	return T.releaseNotes[note.version] ?? note.items;
}

// a note's day as dates read everywhere else (September 28, 2026): a day
// on the calendar, not a moment, so local midnight, never UTC's
export function Com_NoteDate( date: string ): string {
	const [ y, m, d ] = date.split( "-" ).map( Number );
	return Com_FormatDate( new Date( y, m - 1, d ).getTime() / 1000 );
}

/*
==================
Com_NotesToShow

Whether this start shows what's new: after an update, once. A fresh
install has nothing new to tell (it is all new) and only remembers the
version; a computer that never saw any notes but has wallets was updated
from before there were notes, and is told.
==================
*/
export function Com_NotesToShow( seen: string | null, current: string, firstRun: boolean ): "show" | "remember" | "none" {
	if ( seen === current ) {
		return "none";
	}
	return firstRun ? "remember" : "show";
}

/*
==================
useWhatsNew

open: the newest notes should show now. Decided once the screen knows
whether this is a first run; closing remembers the version.
==================
*/
export function useWhatsNew( known: boolean, firstRun: boolean ) {
	const [ open, setOpen ] = useState( false );

	useEffect( () => {
		if ( !known ) {
			return;
		}
		const seen = Com_ReadPref< string | null >( PREF_NOTES_SEEN, null, ( v ): v is string => typeof v === "string" );
		switch ( Com_NotesToShow( seen, APP_VERSION, firstRun ) ) {
		case "show":
			setOpen( true );
			break;
		case "remember":
			Com_WritePref( PREF_NOTES_SEEN, APP_VERSION );
			break;
		case "none":
			break;
		}
	}, [ known, firstRun ] );

	function OnOpenChange( next: boolean ) {
		if ( !next ) {
			Com_WritePref( PREF_NOTES_SEEN, APP_VERSION );
		}
		setOpen( next );
	}
	return { open, onOpenChange: OnOpenChange };
}

// one version's changes, each beside its mark
function UI_NoteItems( props: { items: readonly string[] } ) {
	return (
		<ul className="release-items">
			{props.items.map( ( item ) => (
				<li key={item}>
					<span className="release-mark" aria-hidden="true"><Check /></span>
					<span>{item}</span>
				</li>
			) )}
		</ul>
	);
}

// a version under its name and day, in the list of every version
function UI_Note( props: { note: releaseNote_t } ) {
	return (
		<section>
			<h3 className="release-title">
				<span className="release-version">{T.notes.version( props.note.version )}</span>
				<span>{Com_NoteDate( props.note.date )}</span>
			</h3>
			<UI_NoteItems items={Com_NoteItems( props.note )} />
		</section>
	);
}

/*
==================
UI_WhatsNewSheet / UI_ReleaseNotesSheet

The newest version's notes after an update; every version's from About
==================
*/
export function UI_WhatsNewSheet( props: sheetProps_t ) {
	const newest = RELEASE_NOTES.find( ( n ) => n.version === APP_VERSION );
	if ( !newest ) {
		return null;		// check_version.mjs refuses a build without them
	}
	return (
		<UI_Sheet
			open={props.open}
			onOpenChange={props.onOpenChange}
			title={T.notes.whatsNew( APP_VERSION )}
			description={T.notes.released( Com_NoteDate( newest.date ) )}
			hero={<div className="notes-hero"><UI_AppIcon size={64} /></div>}
			className="sheet-notes"
		>
			<UI_NoteItems items={Com_NoteItems( newest )} />
			<UI_SheetClose onClose={() => props.onOpenChange( false )} label={T.notes.gotIt} primary large />
		</UI_Sheet>
	);
}

export function UI_ReleaseNotesSheet( props: sheetProps_t ) {
	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.notes.title}>
			<div className="release-notes">
				{RELEASE_NOTES.map( ( n ) => <UI_Note key={n.version} note={n} /> )}
			</div>
			<UI_SheetClose onClose={() => props.onOpenChange( false )} primary />
		</UI_Sheet>
	);
}
