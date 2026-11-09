/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_contacts.rs -- the address book: people and places the person pays
//
// A contact list says who someone pays, so it is sealed with the vault
// key like the wallets are (PURPOSE_CONTACTS), and kept per network in
// wallets/<network>/contacts.json: a testnet address means nothing on
// mainnet. Every address is read the way Scan and Send read one
// (W_ParseScan), so a contact can't hold something Send would refuse.

use std::path::PathBuf;
use std::sync::LazyLock;

use serde::{ Deserialize, Serialize };
use specta::Type;
use tokio::sync::Mutex;

use crate::w_local::*;
use crate::w_main::{ Com_CleanName, W_NetworkDir };
use crate::w_notes::Com_CleanNote;
use crate::w_scan::W_ParseScan;
use crate::w_vault::{ purpose_t, V_EditSealed, V_ReadSealed };

const CONTACTS_FILE_NAME: &str	= "contacts.json";
const CONTACTS_WHAT: file_t		= file_t::FILE_CONTACTS;

#[derive( Clone, Debug, PartialEq, Serialize, Deserialize, Type )]
pub struct contact_t {
	pub id:			String,
	pub name:		String,
	pub address:	String,				// as Scan reads it: a payment request's address, not the request
	pub kind:		addrKind_t,
	pub note:		Option< String >,
	pub lastPaid:	Option< u64 >,		// unix time of the last payment Laurel sent there
}

// what the person typed in the contact sheet; id none: a new contact
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
pub struct contactInput_t {
	pub id:			Option< String >,
	pub name:		String,
	pub address:	String,
	pub note:		Option< String >,
}

// one change of the file at a time, so two saves can't lose each other's edit
static ct_writing: LazyLock< Mutex< () > > = LazyLock::new( || Mutex::new( () ) );

fn Ct_Path( net: network_t ) -> PathBuf {
	W_NetworkDir( net ).join( CONTACTS_FILE_NAME )
}

/*
==================
Ct_Read

The address book, sorted: the most recently paid first, then by name.
No file yet is an empty book; a file that can't be opened is an error,
never silently an empty book (saving would then erase it).
==================
*/
fn Ct_Read( net: network_t ) -> wresult_t< Vec< contact_t > > {
	let mut contacts: Vec< contact_t > = V_ReadSealed( &Ct_Path( net ), purpose_t::PURPOSE_CONTACTS, CONTACTS_WHAT )?;
	Com_SortContacts( &mut contacts );
	Ok( contacts )
}

fn Com_SortContacts( contacts: &mut [ contact_t ] ) {
	contacts.sort_by( |a, b| b.lastPaid.cmp( &a.lastPaid ).then_with( || a.name.to_lowercase().cmp( &b.name.to_lowercase() ) ) );
}

/*
==================
Ct_List
==================
*/
pub async fn Ct_List() -> wresult_t< Vec< contact_t > > {
	Ct_Read( w_registry.read().await.network )
}

/*
==================
Ct_Save

Adds a contact, or changes one (input.id). The address is checked for
this network; one address has one name, so a second contact for it is
refused with the name it already has.
==================
*/
pub async fn Ct_Save( input: contactInput_t ) -> wresult_t< contact_t > {
	let net = w_registry.read().await.network;
	let name = Com_CleanName( &input.name )?;
	let target = W_ParseScan( net, &input.address )?;
	let note = input.note.as_deref().map( Com_CleanNote ).transpose()?.flatten();		// too long is said, never cut

	Ct_Edit( net, |contacts| {
		if let Some( other ) = contacts.iter().find( |c| c.address == target.address && Some( &c.id ) != input.id.as_ref() ) {
			return Err( werr_t::WERR_CONTACT_EXISTS( other.name.clone() ) );
		}
		Ok( match input.id.and_then( |id| contacts.iter_mut().find( |c| c.id == id ) ) {
			Some( c ) => {
				c.name		= name;
				c.address	= target.address;
				c.kind		= target.kind;
				c.note		= note;
				c.clone()
			}
			None => {
				let c = contact_t { id: crate::w_date::Com_NewId( 'c' ), name: name, address: target.address, kind: target.kind, note: note, lastPaid: None };
				contacts.push( c.clone() );
				c
			}
		} )
	} ).await?
}

/*
==================
Ct_Remove
==================
*/
pub async fn Ct_Remove( id: &str ) -> wresult_t< () > {
	let net = w_registry.read().await.network;
	Ct_Edit( net, |contacts| contacts.retain( |c| c.id != id ) ).await
}

/*
==================
Ct_Edit

One change to a network's book: read, edit and written under the book's
lock, so a sync (w_folder.rs) and a person's save never lose each other's
edit. The edit's answer comes back.
==================
*/
pub async fn Ct_Edit< R >( net: network_t, edit: impl FnOnce( &mut Vec< contact_t > ) -> R ) -> wresult_t< R > {
	V_EditSealed( &ct_writing, &Ct_Path( net ), purpose_t::PURPOSE_CONTACTS, CONTACTS_WHAT, |contacts: &mut Vec< contact_t >| {
		Com_SortContacts( contacts );
		edit( contacts )
	} ).await
}

/*
==================
Ct_MarkPaid

After a payment to an address in the book: it moves to the top, "paid
recently". Never fails the payment it follows: a note in the log at most.
==================
*/
pub async fn Ct_MarkPaid( address: &str ) {
	let net = w_registry.read().await.network;
	let paid = Ct_Edit( net, |contacts| {
		if let Some( c ) = contacts.iter_mut().find( |c| c.address == address ) {
			c.lastPaid = Some( crate::w_date::Com_Now() );
		}
	} ).await;
	if let Err( e ) = paid {
		log::warn!( "Ct_MarkPaid: {}", e.LogText() );
	}
}


#[cfg( test )]
mod tests {
	use super::*;

	fn Contact( name: &str, lastPaid: Option< u64 > ) -> contact_t {
		contact_t { id: name.into(), name: name.into(), address: name.into(), kind: addrKind_t::ADDR_UNIFIED, note: None, lastPaid: lastPaid }
	}

	#[test]
	fn the_recently_paid_come_first_then_names_in_order() {
		let mut book = vec![ Contact( "zed", None ), Contact( "Amy", None ), Contact( "bob", Some( 5 ) ), Contact( "cat", Some( 9 ) ) ];
		Com_SortContacts( &mut book );
		let names: Vec< &str > = book.iter().map( |c| c.name.as_str() ).collect();
		assert_eq!( names, [ "cat", "bob", "Amy", "zed" ] );
	}
}
