/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_notes.rs -- the person's own words on transactions: a note ("rent,
// October") and a category (for books and taxes)
//
// A memo travels with a payment and the other side reads it; a note is
// only here. It says what money was for, so it is sealed with the vault
// key (PURPOSE_NOTES) like the address book, per network in
// wallets/<network>/notes.json, keyed by transaction id. History items
// carry theirs (Nt_Attach), so the list, search, the filters and the CSV
// export all read them from one place.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::LazyLock;

use serde::{ Deserialize, Serialize };
use tokio::sync::Mutex;

use crate::w_local::*;
use crate::w_main::W_NetworkDir;
use crate::w_vault::{ purpose_t, V_EditSealed, V_ReadSealed };

const NOTES_FILE_NAME: &str = "notes.json";
const NOTES_WHAT: file_t = file_t::FILE_NOTES;

// what the file keeps per transaction; a plain string is a note from before categories
#[derive( Clone, Debug, Default, PartialEq, Serialize, Deserialize )]
#[serde( untagged )]
enum kept_t {
	#[default]
	None,
	Text( String ),
	Full { text: Option< String >, category: Option< txCategory_t > },
}

impl kept_t {
	fn Parts( &self ) -> ( Option< String >, Option< txCategory_t > ) {
		match self {
			kept_t::None								=> ( None, None ),
			kept_t::Text( t )							=> ( Some( t.clone() ), None ),
			kept_t::Full { text, category }			=> ( text.clone(), *category ),
		}
	}
}

// one change of the file at a time, so two saves can't lose each other's note
static nt_writing: LazyLock< Mutex< () > > = LazyLock::new( || Mutex::new( () ) );

// a transaction's note and category as sync sees them (w_folder.rs)
#[derive( Clone, Debug, PartialEq, Serialize, Deserialize )]
pub struct noteEntry_t {
	pub text:		Option< String >,
	pub category:	Option< txCategory_t >,
}

/*
==================
Nt_Edit

Every note of a network, by transaction id, to change under the notes'
lock: read, edited and written as one, like Ct_Edit. An entry with
neither text nor category is forgotten.
==================
*/
pub async fn Nt_Edit< R >( net: network_t, edit: impl FnOnce( &mut BTreeMap< String, noteEntry_t > ) -> R ) -> wresult_t< R > {
	V_EditSealed( &nt_writing, &Nt_Path( net ), purpose_t::PURPOSE_NOTES, NOTES_WHAT, |kept: &mut BTreeMap< String, kept_t >| {
		let mut all: BTreeMap< String, noteEntry_t > = kept.iter().map( |( id, k )| {
			let ( text, category ) = k.Parts();
			( id.clone(), noteEntry_t { text, category } )
		} ).collect();
		let before = all.clone();
		let r = edit( &mut all );
		if ( all != before ) {		// unchanged, an older file keeps its shape: nothing is written
			*kept = all.into_iter()
				.filter( |( _, e )| e.text.is_some() || e.category.is_some() )
				.map( |( id, e )| ( id, kept_t::Full { text: e.text, category: e.category } ) )
				.collect();
		}
		r
	} ).await
}

fn Nt_Path( net: network_t ) -> PathBuf {
	W_NetworkDir( net ).join( NOTES_FILE_NAME )
}

fn Nt_Read( net: network_t ) -> wresult_t< BTreeMap< String, kept_t > > {
	V_ReadSealed( &Nt_Path( net ), purpose_t::PURPOSE_NOTES, NOTES_WHAT )
}

/*
==================
Com_CleanNote

A note as kept: trimmed, at most NOTE_MAX_CHARS characters (counted as
characters, not bytes); empty is no note
==================
*/
pub fn Com_CleanNote( text: &str ) -> wresult_t< Option< String > > {
	let text = text.trim();
	if ( text.chars().count() > NOTE_MAX_CHARS as usize ) {
		return Err( werr_t::WERR_NOTE_TOO_LONG( NOTE_MAX_CHARS ) );
	}
	Ok( Some( text.to_string() ).filter( |t| !t.is_empty() ) )
}

/*
==================
Nt_Save

Sets a transaction's note and category; empty text and no category
forget it. The id must be a transaction id: 64 hex digits.
==================
*/
pub async fn Nt_Save( txid: &str, text: &str, category: Option< txCategory_t > ) -> wresult_t< () > {
	if ( !Com_IsTxid( txid ) ) {
		return Err( werr_t::WERR_ENGINE( "That isn't a transaction id.".to_string() ) );
	}
	let text = Com_CleanNote( text )?;
	let net = w_registry.read().await.network;

	let key = txid.to_ascii_lowercase();
	Nt_Edit( net, |notes| match ( text, category ) {
		( None, None )		=> { notes.remove( &key ); }
		( text, category )	=> { notes.insert( key, noteEntry_t { text, category } ); }
	} ).await
}

/*
==================
Nt_Attach

Each item's note and category, from the one file. A file that can't be
read leaves them off and says so in the log: history still shows.
==================
*/
pub async fn Nt_Attach( items: &mut [ historyItem_t ] ) {
	let net = w_registry.read().await.network;
	match Nt_Read( net ) {
		Ok( notes ) => {
			for it in items {
				( it.note, it.category ) = notes.get( &it.txid ).map_or( ( None, None ), kept_t::Parts );
			}
		}
		Err( e ) => log::warn!( "Nt_Attach: {}", e.LogText() ),
	}
}


#[cfg( test )]
mod tests {
	use super::*;

	#[test]
	fn a_note_is_trimmed_bounded_and_empty_is_none() {
		assert_eq!( Com_CleanNote( "  Rent, October  " ).unwrap().as_deref(), Some( "Rent, October" ) );
		assert_eq!( Com_CleanNote( "   " ).unwrap(), None );
		assert_eq!( Com_CleanNote( &"é".repeat( NOTE_MAX_CHARS as usize ) ).unwrap().map( |n| n.chars().count() ), Some( NOTE_MAX_CHARS as usize ), "characters, not bytes" );
		assert!( matches!( Com_CleanNote( &"a".repeat( NOTE_MAX_CHARS as usize + 1 ) ), Err( werr_t::WERR_NOTE_TOO_LONG( _ ) ) ) );
	}

	// a note saved before categories existed reads back, with none
	#[test]
	fn an_older_note_still_reads() {
		let file: BTreeMap< String, kept_t > = serde_json::from_str( r#"{ "aa": "Rent", "bb": { "text": null, "category": "food" } }"# ).unwrap();
		assert_eq!( file["aa"].Parts(), ( Some( "Rent".to_string() ), None ) );
		assert_eq!( file["bb"].Parts(), ( None, Some( txCategory_t::CAT_FOOD ) ) );
	}
}
