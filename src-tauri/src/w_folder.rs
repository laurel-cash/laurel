/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_folder.rs -- the person's computers kept alike, through a folder they
// share (docs/SYNC.md): contacts, transaction notes and a few settings
//
// No server: each computer writes its own file into the folder, sealed with
// the sync key, and reads everyone's. Every record carries a stamp (a
// Lamport counter and the device that wrote it); the highest wins, the same
// on every computer, so all converge whatever order files arrive in. What
// changed here is found by comparing with the last merged copy, so the
// contacts and notes code only lends its lock (Ct_Edit, Nt_Edit).
//
// The numbered edge cases are docs/SYNC.md's.

use std::collections::BTreeMap;
use std::path::{ Path, PathBuf };
use std::sync::{ LazyLock, Mutex };

use serde::{ Deserialize, Serialize };
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;
use zeroize::Zeroizing;

use crate::w_contacts::{ contact_t, Ct_Edit };
use crate::w_date::{ Com_Every, Com_Now };
use crate::w_disk::Com_MakeFolderFor;
use crate::w_documents::{ Doc_List, Doc_Read, Doc_RemoveChild, Doc_WriteChild, DOCUMENT_MAX_BYTES };
use crate::w_local::*;
use crate::w_main::Com_CleanName;
use crate::w_notes::{ Com_CleanNote, noteEntry_t, Nt_Edit };
use crate::w_scan::W_ParseScan;
use crate::w_vault::{ purpose_t, Com_RandomHex, Com_RandomKey, V_OpenWith, V_ReadSealed, V_SealWith, V_WriteSealed };

const STATE_FILE_NAME: &str	= "sync-state.json";		// this computer's, sealed with the vault key
const FILE_PREFIX: &str		= "laurel-sync-";
const FILE_SUFFIX: &str		= ".lsync";
const FORMAT: u32			= 1;						// a file of a higher format is a newer Laurel's (10)
const DEVICE_BYTES: usize	= 8;						// 16 hex digits
const KEY_BYTES: usize		= 32;
const CHECK_BYTES: usize	= 3;						// the code's checksum: 32 + 3 bytes are 56 base32 letters
const CODE_GROUP: usize		= 4;
const WATCH_SECS: u64		= 60;						// how often the folder is looked at
const B32: &[ u8; 32 ]		= b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";		// RFC 4648

// which record is newer: the counter first, the device to break a tie
#[derive( Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize )]
struct stamp_t {
	version:	u64,
	device:		String,
}

// a record as it travels: its value, or none for a deletion (a tombstone)
#[derive( Clone, Debug, PartialEq, Serialize, Deserialize )]
struct record_t< T > {
	stamp:	stamp_t,
	value:	Option< T >,
}

// a contact as it travels: its kind is read again from the address on arrival (8)
#[derive( Clone, Debug, PartialEq, Serialize, Deserialize )]
struct syncContact_t {
	name:		String,
	address:	String,
	note:		Option< String >,
	lastPaid:	Option< u64 >,
}

// the settings that travel (docs/SYNC.md says why only these)
#[derive( Clone, Debug, PartialEq, Serialize, Deserialize )]
struct syncSettings_t {
	notifyInApp:	bool,
	notifySystem:	bool,
	showPrice:		bool,
}

// one network's records (7)
#[derive( Clone, Debug, Default, PartialEq, Serialize, Deserialize )]
struct section_t {
	contacts:	BTreeMap< String, record_t< syncContact_t > >,
	notes:		BTreeMap< String, record_t< noteEntry_t > >,
}

// everything merged so far: what each computer's file holds
#[derive( Clone, Debug, Default, PartialEq, Serialize, Deserialize )]
struct known_t {
	clock:		u64,
	nets:		BTreeMap< String, section_t >,
	settings:	Option< record_t< syncSettings_t > >,
}

// a computer's file in the folder
#[derive( Serialize, Deserialize )]
struct syncFile_t {
	format:	u32,
	device:	String,
	name:	String,			// the computer's name, to tell them apart in Settings
	known:	known_t,
}

// this computer's sync, sealed with the vault key
#[derive( Clone, Serialize, Deserialize )]
struct state_t {
	key:		Vec< u8 >,
	folder:		PathBuf,
	#[serde( default )]
	folderName: Option< String >,
	device:		String,
	known:		known_t,
}

// another computer in the folder, as Settings lists it
#[derive( Clone, Debug, Serialize, Type )]
pub struct syncComputer_t {
	pub device:		String,
	pub name:		String,
	pub me:			bool,
	pub readable:	bool,				// false: this code can't open it, or it is still copying (2, 11)
}

// the sync as the ui shows it
#[derive( Clone, Debug, Default, Serialize, Type )]
pub struct syncStatus_t {
	pub on:			bool,
	pub folder:		Option< String >,
	pub lastSync:	Option< u64 >,		// unix seconds of the last sync that finished
	pub computers:	Vec< syncComputer_t >,
	pub skipped:	u32,				// records another computer sent that this Laurel can't keep (8, 9)
	pub problem:	Option< errorInfo_t >,	// why the last sync didn't finish
}

// a sync finished (or failed): the ui reads the status, and contacts, notes and settings, again
#[derive( Clone, Debug, Serialize, Type, Event )]
pub struct folderSyncedEvent_t {}

// one sync at a time; the last one's outcome
static f_running: LazyLock< tokio::sync::Mutex< () > > = LazyLock::new( || tokio::sync::Mutex::new( () ) );
static f_status: LazyLock< Mutex< Option< syncStatus_t > > > = LazyLock::new( || Mutex::new( None ) );


/*
=========================================================================

THE SYNC CODE

=========================================================================
*/

fn Com_Base32( bytes: &[ u8 ] ) -> String {
	let mut out = String::new();
	let ( mut acc, mut bits ) = ( 0u32, 0u32 );
	for b in bytes {
		acc = ( acc << 8 ) | u32::from( *b );
		bits += 8;
		while ( bits >= 5 ) {
			bits -= 5;
			out.push( B32[ ( ( acc >> bits ) & 31 ) as usize ] as char );
		}
	}
	if ( bits > 0 ) {
		out.push( B32[ ( ( acc << ( 5 - bits ) ) & 31 ) as usize ] as char );
	}
	out
}

fn Com_Unbase32( text: &str ) -> Option< Vec< u8 > > {
	let mut out = Vec::new();
	let ( mut acc, mut bits ) = ( 0u32, 0u32 );
	for c in text.bytes() {
		acc = ( acc << 5 ) | B32.iter().position( |x| *x == c )? as u32;
		bits += 5;
		if ( bits >= 8 ) {
			bits -= 8;
			out.push( ( acc >> bits ) as u8 );
		}
	}
	Some( out )
}

fn Com_CodeCheck( key: &[ u8 ] ) -> Vec< u8 > {
	crate::w_vault::Com_Hash( b"Laurel_SyncCode_", CHECK_BYTES, key )
}

/*
==================
Com_SyncCode / Com_ParseSyncCode

The key as the person carries it: 56 letters and digits in groups of
four, the last few a checksum, so a typo is caught before anything is
joined (11). Case, spaces and dashes don't matter. An error never
repeats the code (19).
==================
*/
fn Com_SyncCode( key: &[ u8 ] ) -> String {
	let letters = Com_Base32( &[ key, &Com_CodeCheck( key ) ].concat() );
	letters.as_bytes().chunks( CODE_GROUP ).map( |g| String::from_utf8_lossy( g ).into_owned() ).collect::< Vec< _ > >().join( "-" )
}

fn Com_ParseSyncCode( text: &str ) -> wresult_t< Zeroizing< Vec< u8 > > > {
	let letters: String = text.chars().filter( |c| c.is_ascii_alphanumeric() ).map( |c| c.to_ascii_uppercase() ).collect();
	let bytes = Zeroizing::new( Com_Unbase32( &letters ).ok_or( werr_t::WERR_SYNC_CODE )? );
	if ( bytes.len() != KEY_BYTES + CHECK_BYTES ) {
		return Err( werr_t::WERR_SYNC_CODE );
	}
	let ( key, check ) = bytes.split_at( KEY_BYTES );
	if ( Com_CodeCheck( key ) != check ) {
		return Err( werr_t::WERR_SYNC_CODE );
	}
	Ok( Zeroizing::new( key.to_vec() ) )
}


/*
=========================================================================

MERGING

=========================================================================
*/

/*
==================
Com_Stamp

What changed here since the last merge, stamped as this device's newest.
The counter is already past everything seen in the folder (F_Merge
advances it first), so a change made here before this look wins over
one elsewhere this computer hadn't seen: the person's latest edit isn't
lost to an older one arriving late.
==================
*/
fn Com_Stamp< T: Clone + PartialEq >( known: &mut BTreeMap< String, record_t< T > >, local: &BTreeMap< String, T >, me: &str, clock: &mut u64 ) {
	let ids: Vec< String > = local.keys().chain( known.keys() ).cloned().collect::< std::collections::BTreeSet< _ > >().into_iter().collect();
	for id in ids {
		let now = local.get( &id );
		let was = known.get( &id ).and_then( |r| r.value.as_ref() );
		if ( now != was ) {
			*clock += 1;
			known.insert( id, record_t { stamp: stamp_t { version: *clock, device: me.to_string() }, value: now.cloned() } );
		}
	}
}

/*
==================
Com_Adopt

Every newer record another computer sent (3, 4, 5); one this Laurel
can't keep (valid false, by its id and value) is left out and counted
(8, 9). Only what arrives is judged: what is already here stays as it is.
==================
*/
fn Com_Adopt< T: Clone >( known: &mut BTreeMap< String, record_t< T > >, theirs: &BTreeMap< String, record_t< T > >, valid: impl Fn( &str, &T ) -> bool, skipped: &mut u32 ) {
	for ( id, r ) in theirs {
		if ( known.get( id ).is_some_and( |k| k.stamp >= r.stamp ) ) {
			continue;
		}
		match r.value.as_ref() {
			Some( v ) if !valid( id, v ) => *skipped += 1,
			_ => { known.insert( id.clone(), r.clone() ); }
		}
	}
}

/*
==================
Com_OneNamePerAddress

Two contacts for one address (added on two computers apart): the newer
stays, the other is deleted, by the same rule everywhere (6)
==================
*/
fn Com_OneNamePerAddress( contacts: &mut BTreeMap< String, record_t< syncContact_t > >, me: &str, clock: &mut u64 ) {
	let mut best: BTreeMap< String, ( stamp_t, String ) > = BTreeMap::new();
	for ( id, r ) in contacts.iter() {
		if let Some( c ) = &r.value {
			if ( best.get( &c.address ).is_none_or( |( s, _ )| r.stamp > *s ) ) {
				best.insert( c.address.clone(), ( r.stamp.clone(), id.clone() ) );
			}
		}
	}
	for ( id, r ) in contacts.iter_mut() {
		let loses = r.value.as_ref().is_some_and( |c| best.get( &c.address ).is_some_and( |( _, winner )| winner != id ) );
		if ( loses ) {
			*clock += 1;
			*r = record_t { stamp: stamp_t { version: *clock, device: me.to_string() }, value: None };
		}
	}
}

fn Com_NetKey( net: network_t ) -> &'static str {
	match net {
		network_t::NET_MAINNET => "mainnet",
		network_t::NET_TESTNET => "testnet",
	}
}

fn Com_Traveling( c: &contact_t ) -> syncContact_t {
	syncContact_t { name: c.name.clone(), address: c.address.clone(), note: c.note.clone(), lastPaid: c.lastPaid }
}

// a contact that arrived, as this Laurel would have saved it; none when it can't (8)
fn Com_Arrived( net: network_t, id: &str, c: &syncContact_t ) -> Option< contact_t > {
	let target = W_ParseScan( net, &c.address ).ok()?;
	let name = Com_CleanName( &c.name ).ok()?;
	let note = c.note.as_deref().map( Com_CleanNote ).transpose().ok()?.flatten();
	Some( contact_t { id: id.to_string(), name: name, address: target.address, kind: target.kind, note: note, lastPaid: c.lastPaid } )
}

fn Com_NoteKeeps( n: &noteEntry_t ) -> bool {
	n.text.as_deref().is_none_or( |t| Com_CleanNote( t ).is_ok_and( |kept| kept.as_deref() == Some( t ) ) )
}


/*
=========================================================================

THE FOLDER

=========================================================================
*/

fn Com_FileName( device: &str ) -> String {
	format!( "{FILE_PREFIX}{device}{FILE_SUFFIX}" )
}

// the device a file name says wrote it; none for anything else in the folder (1)
fn Com_DeviceOf( name: &str ) -> Option< &str > {
	let device = name.strip_prefix( FILE_PREFIX )?.strip_suffix( FILE_SUFFIX )?;
	( device.len() == DEVICE_BYTES * 2 && device.bytes().all( |b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() ) ).then_some( device )
}

fn Com_ComputerName() -> String {
	std::env::var( "COMPUTERNAME" ).or_else( |_| std::env::var( "HOSTNAME" ) ).unwrap_or_else( |_| if cfg!( target_os = "android" ) { "Android device" } else { "A computer" }.to_string() )
}

// what one file in the folder gave: its computer, and its records when it could be read
struct read_t {
	computer:	syncComputer_t,
	file:		Option< syncFile_t >,
}

/*
==================
F_ReadFolder

Every computer's file. A file this key can't open, or one still copying,
is listed as unreadable and read again next time (2); one from a newer
Laurel stops the sync, since merging what isn't understood could lose
it (10). A folder that isn't there is an error, and nothing here changes
(13).
==================
*/
fn F_ReadFolder( folder: &Path, key: &[ u8; KEY_BYTES ], me: &str ) -> wresult_t< Vec< read_t > > {
	let entries = Doc_List( folder, FILE_PREFIX )?;
	let mut out = Vec::new();
	for entry in entries {
		let name = entry.name;
		let Some( device ) = Com_DeviceOf( &name ) else {
			continue;
		};
		let opened = Doc_Read( Path::new( &entry.uri ), DOCUMENT_MAX_BYTES ).ok()
			.and_then( |raw| V_OpenWith( key, purpose_t::PURPOSE_SYNC_FILE, &raw ).ok() )
			.and_then( |plain| serde_json::from_slice::< syncFile_t >( &plain ).ok() )
			.filter( |f| f.device == device );		// a renamed copy says another device than its name (1)
		if let Some( f ) = &opened {
			if ( f.format > FORMAT ) {
				return Err( werr_t::WERR_SYNC_NEWER );
			}
		}
		out.push( read_t {
			computer:	syncComputer_t { device: device.to_string(), name: opened.as_ref().map_or_else( String::new, |f| f.name.clone() ), me: device == me, readable: opened.is_some() },
			file:		opened,
		} );
	}
	Ok( out )
}

fn F_StatePath() -> wresult_t< PathBuf > {
	Com_DataPath( STATE_FILE_NAME ).ok_or_else( Com_NoDataFolder )
}

// this computer's sync; none when it isn't syncing. Locked, it can't be read (12)
fn F_ReadState() -> wresult_t< Option< state_t > > {
	V_ReadSealed::< Option< state_t > >( &F_StatePath()?, purpose_t::PURPOSE_SYNC, file_t::FILE_SYNC )
}

fn F_WriteState( state: &state_t ) -> wresult_t< () > {
	V_WriteSealed( &F_StatePath()?, purpose_t::PURPOSE_SYNC, state )
}

fn Com_Key( state: &state_t ) -> wresult_t< Zeroizing< [ u8; KEY_BYTES ] > > {
	let key: [ u8; KEY_BYTES ] = state.key.as_slice().try_into().map_err( |_| werr_t::WERR_CORRUPT( file_t::FILE_SYNC ) )?;
	Ok( Zeroizing::new( key ) )
}


/*
=========================================================================

A SYNC

=========================================================================
*/

/*
==================
F_Sync

One look at the folder: its files read, what changed here stamped, the
newer of everything adopted, contacts and notes written through their
owners (under their locks, 16), settings through S_Set, and this
computer's file written again when anything changed. Not syncing, or
locked: nothing to do.
==================
*/
pub async fn F_Sync() -> wresult_t< syncStatus_t > {
	let _running = f_running.lock().await;
	let Some( mut state ) = F_ReadState()? else {
		return Ok( F_Remember( syncStatus_t::default() ) );
	};
	let outcome = F_SyncWith( &mut state ).await;
	let status = match outcome {
		Ok( s ) => s,
		Err( e ) => {
			let mut s = F_Status()?;
			s.on = true;
			s.folder = Some( F_FolderName( &state ) );
			s.problem = Some( e.Info() );
			s
		}
	};
	Ok( F_Remember( status ) )
}

fn F_Remember( status: syncStatus_t ) -> syncStatus_t {
	*f_status.lock().unwrap() = Some( status.clone() );
	status
}

async fn F_SyncWith( state: &mut state_t ) -> wresult_t< syncStatus_t > {
	let key = Com_Key( state )?;
	let files = F_ReadFolder( &state.folder, &key, &state.device )?;

	// a copied data folder writes as this device too: its file is ahead of what this state wrote (15)
	if files.iter().any( |r| r.computer.me && r.file.as_ref().is_some_and( |f| f.known.clock > state.known.clock ) ) {
		log::warn!( "F_Sync: another copy of this computer's data writes as it; taking a new device id" );
		state.device = Com_RandomHex( DEVICE_BYTES );
	}
	let me = state.device.clone();
	let theirs: Vec< &known_t > = files.iter().filter( |r| !r.computer.me ).filter_map( |r| r.file.as_ref().map( |f| &f.known ) ).collect();

	let before = state.known.clone();
	let mut known = state.known.clone();
	known.clock = theirs.iter().map( |k| k.clock ).chain( [ known.clock ] ).max().unwrap_or( 0 );
	let mut skipped = 0u32;

	for net in [ network_t::NET_MAINNET, network_t::NET_TESTNET ] {
		let key = Com_NetKey( net );
		let mut section = known.nets.remove( key ).unwrap_or_default();
		let mut clock = known.clock;

		// contacts: stamped, adopted, one name per address, written back, all under the book's lock
		section.contacts = Ct_Edit( net, |book| {
			let local: BTreeMap< String, syncContact_t > = book.iter().map( |c| ( c.id.clone(), Com_Traveling( c ) ) ).collect();
			let mut merged = section.contacts.clone();
			Com_Stamp( &mut merged, &local, &me, &mut clock );
			for k in &theirs {
				if let Some( s ) = k.nets.get( key ) {
					Com_Adopt( &mut merged, &s.contacts, |_, c| Com_Arrived( net, "", c ).is_some(), &mut skipped );
				}
			}
			Com_OneNamePerAddress( &mut merged, &me, &mut clock );
			// a contact as it is here stays exactly so (re-reading it could drop one an older
			// Laurel saved); only what arrived becomes a contact through Com_Arrived
			let here: BTreeMap< String, contact_t > = book.drain( .. ).map( |c| ( c.id.clone(), c ) ).collect();
			*book = merged.iter().filter_map( |( id, r )| {
				let c = r.value.as_ref()?;
				match here.get( id ) {
					Some( kept ) if Com_Traveling( kept ) == *c => Some( kept.clone() ),
					_ => Com_Arrived( net, id, c ),
				}
			} ).collect();
			merged
		} ).await?;

		section.notes = Nt_Edit( net, |notes| {
			let mut merged = section.notes.clone();
			Com_Stamp( &mut merged, notes, &me, &mut clock );
			for k in &theirs {
				if let Some( s ) = k.nets.get( key ) {
					Com_Adopt( &mut merged, &s.notes, |id, n| Com_IsTxid( id ) && Com_NoteKeeps( n ), &mut skipped );
				}
			}
			*notes = merged.iter().filter_map( |( id, r )| r.value.clone().map( |n| ( id.clone(), n ) ) ).collect();
			merged
		} ).await?;

		known.clock = clock;
		if ( section != section_t::default() ) {
			known.nets.insert( key.to_string(), section );
		}
	}

	// settings: one record, the same rule
	let now = crate::w_settings::S_Get();
	let local = BTreeMap::from( [ ( String::new(), syncSettings_t { notifyInApp: now.notifyInApp, notifySystem: now.notifySystem, showPrice: now.showPrice } ) ] );
	let mut settings: BTreeMap< String, record_t< syncSettings_t > > = known.settings.take().map( |r| BTreeMap::from( [ ( String::new(), r ) ] ) ).unwrap_or_default();
	Com_Stamp( &mut settings, &local, &me, &mut known.clock );
	for k in &theirs {
		if let Some( r ) = &k.settings {
			Com_Adopt( &mut settings, &BTreeMap::from( [ ( String::new(), r.clone() ) ] ), |_, _| true, &mut skipped );
		}
	}
	known.settings = settings.remove( "" );
	if let Some( s ) = known.settings.as_ref().and_then( |r| r.value.clone() ) {
		if ( s.notifyInApp != now.notifyInApp || s.notifySystem != now.notifySystem || s.showPrice != now.showPrice ) {
			crate::w_settings::S_Set( crate::w_settings::appSettings_t { notifyInApp: s.notifyInApp, notifySystem: s.notifySystem, showPrice: s.showPrice, ..now } )?;
		}
	}

	// this computer's file, when something changed or it isn't there yet (20)
	if ( known != before || !files.iter().any( |r| r.computer.device == me && r.file.is_some() ) ) {
		let file = syncFile_t { format: FORMAT, device: me.clone(), name: Com_ComputerName(), known: known.clone() };
		let sealed = V_SealWith( &key, purpose_t::PURPOSE_SYNC_FILE, &Zeroizing::new( serde_json::to_vec( &file ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )? ) )?;
		Doc_WriteChild( &state.folder, &Com_FileName( &me ), &sealed )?;
	}
	state.known = known;
	F_WriteState( state )?;

	let mut computers: Vec< syncComputer_t > = files.into_iter().map( |r| r.computer ).filter( |c| c.device != me ).collect();
	computers.insert( 0, syncComputer_t { device: me, name: Com_ComputerName(), me: true, readable: true } );
	Ok( syncStatus_t { on: true, folder: Some( F_FolderName( state ) ), lastSync: Some( Com_Now() ), computers: computers, skipped: skipped, problem: None } )
}


/*
=========================================================================

STARTING, JOINING, STOPPING

=========================================================================
*/

/*
==================
F_Start

The first computer: a new sync key, shown once as the code the others
join with. Only one sync at a time on a computer.
==================
*/
pub async fn F_Start( folder: &str ) -> wresult_t< String > {
	let key = Zeroizing::new( Com_RandomKey() );
	F_Begin( folder, &key[..] ).await?;
	Ok( Com_SyncCode( &key[..] ) )
}

/*
==================
F_Join

Another computer, with the code the first one showed: typos are caught
by the code's checksum before anything is kept (11)
==================
*/
pub async fn F_Join( folder: &str, code: &str ) -> wresult_t< syncStatus_t > {
	let key = Com_ParseSyncCode( code )?;
	F_Begin( folder, &key ).await
}

async fn F_Begin( folder: &str, key: &[ u8 ] ) -> wresult_t< syncStatus_t > {
	if ( F_ReadState()?.is_some() ) {
		return Err( werr_t::WERR_SYNC_ON );
	}
	let folder = PathBuf::from( folder.trim() );
	Doc_List( &folder, FILE_PREFIX )?;
	Com_MakeFolderFor( &F_StatePath()? )?;
	let name = crate::w_documents::Doc_Name( &folder )?;
	F_WriteState( &state_t { key: key.to_vec(), folder: folder, folderName: Some( name ), device: Com_RandomHex( DEVICE_BYTES ), known: known_t::default() } )?;
	F_Sync().await
}

/*
==================
F_Stop

This computer forgets the key and takes its own file out of the folder;
the others keep theirs, and contacts and notes stay as they are (17)
==================
*/
pub async fn F_Stop() -> wresult_t< () > {
	let _running = f_running.lock().await;
	if let Some( state ) = F_ReadState()? {
		let _ = Doc_RemoveChild( &state.folder, &Com_FileName( &state.device ) );		// a folder gone: nothing to take out
	}
	crate::w_disk::Com_Shred( &F_StatePath()? );
	*f_status.lock().unwrap() = None;
	Ok( () )
}

/*
==================
F_Forget

A computer that is gone for good: its file leaves the folder; what it
changed stays merged here (18). Not this computer's own: that is Stop.
==================
*/
pub async fn F_Forget( device: &str ) -> wresult_t< () > {
	let _running = f_running.lock().await;
	let state = F_ReadState()?.ok_or( werr_t::WERR_SYNC_FOLDER )?;
	if ( device == state.device || Com_DeviceOf( &Com_FileName( device ) ).is_none() ) {
		return Ok( () );
	}
	Doc_RemoveChild( &state.folder, &Com_FileName( device ) )
}

/*
==================
F_Status

The last sync's outcome; before any this run (Laurel started locked, and
the first look is still to come), what the state says: on, and where.
Never "off" for a computer that is syncing.
==================
*/
fn F_FolderName( state: &state_t ) -> String {
	state.folderName.clone().unwrap_or_else( || state.folder.display().to_string() )
}

pub fn F_Status() -> wresult_t< syncStatus_t > {
	if let Some( s ) = f_status.lock().unwrap().clone() {
		return Ok( s );
	}
	Ok( F_ReadState()?.map_or_else( syncStatus_t::default, |state| syncStatus_t {
		on:		true,
		folder:	Some( F_FolderName( &state ) ),
		..Default::default()
	} ) )
}

/*
==================
F_Watch

A sync every minute while Laurel runs: locked (12), or not syncing,
there is nothing to do; any other failure is in the status for Settings
to say. The ui hears each one.
==================
*/
pub fn F_Watch( app: AppHandle ) {
	Com_Every( "F_Watch", WATCH_SECS, move || {
		let app = app.clone();
		async move {
			if ( !crate::w_vault::V_IsUnlocked() ) {
				return Ok( () );
			}
			F_Sync().await?;
			let _ = folderSyncedEvent_t {}.emit( &app );
			Ok( () )
		}
	} );
}


#[cfg( test )]
mod tests {
	use super::*;

	// Pull an emulator-created .lsync file and its disposable code.txt into this
	// directory. The probe verifies the mobile bytes and writes a desktop peer
	// snapshot to push back; it never opens a wallet or handles a spending key.
	#[test]
	#[ignore = "requires an explicitly supplied disposable Android SAF fixture"]
	fn android_document_snapshot_is_compatible_with_desktop() {
		let folder = PathBuf::from( std::env::var( "LAUREL_SAF_PROBE_DIR" ).expect( "set LAUREL_SAF_PROBE_DIR to the fixture directory" ) );
		let code = std::fs::read_to_string( folder.join( "code.txt" ) ).unwrap();
		let key: [ u8; KEY_BYTES ] = Com_ParseSyncCode( &code ).unwrap().as_slice().try_into().unwrap();
		let files = F_ReadFolder( &folder, &key, "" ).unwrap();
		let mut source = files.into_iter().filter_map( |r| r.file ).find( |f| f.name != "Desktop SAF probe" ).expect( "an authenticated Android snapshot" );
		assert!( source.known.clock > 0 );
		source.device = "00000000000000ab".into();
		source.name = "Desktop SAF probe".into();
		source.known.clock += 1;
		let settings = source.known.settings.as_mut().unwrap();
		settings.value.as_mut().unwrap().notifyInApp = false;
		settings.stamp = stamp_t { version: source.known.clock, device: source.device.clone() };
		let sealed = V_SealWith( &key, purpose_t::PURPOSE_SYNC_FILE, &serde_json::to_vec( &source ).unwrap() ).unwrap();
		Doc_WriteChild( &folder, &Com_FileName( &source.device ), &sealed ).unwrap();
		assert!( F_ReadFolder( &folder, &key, "" ).unwrap().iter().all( |r| r.computer.readable ) );
	}

	fn Stamp( version: u64, device: &str ) -> stamp_t {
		stamp_t { version: version, device: device.into() }
	}

	fn Rec< T >( version: u64, device: &str, value: Option< T > ) -> record_t< T > {
		record_t { stamp: Stamp( version, device ), value: value }
	}

	fn Book( pairs: &[ ( &str, &str ) ] ) -> BTreeMap< String, record_t< syncContact_t > > {
		pairs.iter().enumerate().map( |( i, ( id, address ) )| ( id.to_string(), Rec( i as u64 + 1, "b", Some( syncContact_t { name: id.to_string(), address: address.to_string(), note: None, lastPaid: None } ) ) ) ).collect()
	}

	/*
	==================
	a_code_carries_the_key_and_catches_a_typo

	Read back whatever the case and dashes; one letter off is refused
	before anything is joined, and the error never quotes the code
	==================
	*/
	#[test]
	fn a_code_carries_the_key_and_catches_a_typo() {
		let key = [ 7u8; KEY_BYTES ];
		let code = Com_SyncCode( &key );
		assert_eq!( code.replace( '-', "" ).len(), 56 );
		assert_eq!( &Com_ParseSyncCode( &code.to_lowercase().replace( '-', " " ) ).unwrap()[..], &key[..] );

		let mut typo = code.clone().into_bytes();
		typo[5] = if typo[5] == b'A' { b'B' } else { b'A' };
		let e = Com_ParseSyncCode( std::str::from_utf8( &typo ).unwrap() ).unwrap_err();
		assert!( matches!( e, werr_t::WERR_SYNC_CODE ) );
		assert!( !e.to_string().contains( &code[..8] ) && !e.LogText().contains( &code[..8] ) );
		assert!( Com_ParseSyncCode( "" ).is_err() && Com_ParseSyncCode( "01-89" ).is_err() );
	}

	#[test]
	fn base32_reads_back_what_it_wrote() {
		for n in [ 0usize, 1, 5, 32, 35 ] {
			let bytes: Vec< u8 > = ( 0..n as u8 ).map( |b| b.wrapping_mul( 37 ) ).collect();
			let back = Com_Unbase32( &Com_Base32( &bytes ) ).unwrap();
			assert_eq!( &back[..n], &bytes[..] );
		}
	}

	/*
	==================
	the_newer_stamp_wins_everywhere

	The counter decides, the device breaks a tie: every computer picks the
	same winner (3, 4); a delete travels, and a later edit wins over it (5)
	==================
	*/
	#[test]
	fn the_newer_stamp_wins_everywhere() {
		let mut known = BTreeMap::from( [ ( "x".to_string(), Rec( 3, "a", Some( 1 ) ) ) ] );
		let mut skipped = 0;
		Com_Adopt( &mut known, &BTreeMap::from( [ ( "x".to_string(), Rec( 3, "b", Some( 2 ) ) ) ] ), |_, _| true, &mut skipped );
		assert_eq!( known["x"].value, Some( 2 ), "a tie goes to the higher device" );
		Com_Adopt( &mut known, &BTreeMap::from( [ ( "x".to_string(), Rec( 2, "z", Some( 9 ) ) ) ] ), |_, _| true, &mut skipped );
		assert_eq!( known["x"].value, Some( 2 ), "older loses, whoever wrote it" );
		Com_Adopt( &mut known, &BTreeMap::from( [ ( "x".to_string(), Rec( 4, "a", None ) ) ] ), |_, _| true, &mut skipped );
		assert_eq!( known["x"].value, None, "a delete travels" );
		Com_Adopt( &mut known, &BTreeMap::from( [ ( "x".to_string(), Rec( 5, "b", Some( 3 ) ) ) ] ), |_, _| true, &mut skipped );
		assert_eq!( known["x"].value, Some( 3 ), "an edit after the delete brings it back" );
		assert_eq!( skipped, 0 );
	}

	/*
	==================
	a_local_change_is_stamped_past_all_seen

	Changed, added and removed here: each gets a stamp above the clock, and
	what didn't change keeps its own
	==================
	*/
	#[test]
	fn a_local_change_is_stamped_past_all_seen() {
		let mut known = BTreeMap::from( [ ( "same".to_string(), Rec( 1, "b", Some( 1 ) ) ), ( "edit".to_string(), Rec( 2, "b", Some( 1 ) ) ), ( "gone".to_string(), Rec( 3, "b", Some( 1 ) ) ) ] );
		let local = BTreeMap::from( [ ( "same".to_string(), 1 ), ( "edit".to_string(), 2 ), ( "new".to_string(), 5 ) ] );
		let mut clock = 10;
		Com_Stamp( &mut known, &local, "me", &mut clock );
		assert_eq!( known["same"].stamp, Stamp( 1, "b" ) );
		assert!( known["edit"].stamp.version > 10 && known["edit"].value == Some( 2 ) );
		assert!( known["gone"].stamp.version > 10 && known["gone"].value.is_none() );
		assert_eq!( known["new"].value, Some( 5 ) );
		assert_eq!( clock, 13 );
	}

	// what this Laurel can't keep is left out and counted, never cut (8, 9)
	#[test]
	fn what_cant_be_kept_is_counted_not_kept() {
		let mut known: BTreeMap< String, record_t< i32 > > = BTreeMap::new();
		let mut skipped = 0;
		Com_Adopt( &mut known, &BTreeMap::from( [ ( "bad".to_string(), Rec( 1, "b", Some( -1 ) ) ), ( "ok".to_string(), Rec( 1, "b", Some( 1 ) ) ) ] ), |_, v| *v > 0, &mut skipped );
		assert_eq!( ( known.len(), skipped ), ( 1, 1 ) );
		assert!( !Com_NoteKeeps( &noteEntry_t { text: Some( "x".repeat( NOTE_MAX_CHARS as usize + 1 ) ), category: None } ) );
		assert!( !Com_NoteKeeps( &noteEntry_t { text: Some( "  padded  ".into() ), category: None } ), "kept as sent, or not at all" );
		assert!( Com_NoteKeeps( &noteEntry_t { text: Some( "Rent".into() ), category: None } ) );
	}

	/*
	==================
	one_address_keeps_one_name

	The same address added on two computers: the newer stays, the other
	becomes a delete that beats it everywhere (6)
	==================
	*/
	#[test]
	fn one_address_keeps_one_name() {
		let mut book = Book( &[ ( "older", "t1same" ), ( "newer", "t1same" ), ( "other", "t1else" ) ] );
		let mut clock = 3;
		Com_OneNamePerAddress( &mut book, "me", &mut clock );
		assert!( book["older"].value.is_none() && book["older"].stamp.version > 3 );
		assert!( book["newer"].value.is_some() && book["other"].value.is_some() );
	}

	// only this naming is a sync file, and only with its own device's id inside (1)
	#[test]
	fn only_our_files_are_read() {
		assert_eq!( Com_DeviceOf( "laurel-sync-0123456789abcdef.lsync" ), Some( "0123456789abcdef" ) );
		for name in [ "laurel-sync-0123456789abcdef (1).lsync", "laurel-sync-0123.lsync", "laurel-sync-0123456789ABCDEF.lsync", "notes.txt" ] {
			assert_eq!( Com_DeviceOf( name ), None, "{name}" );
		}
	}

	/*
	==================
	a_sync_brings_in_what_another_computer_wrote

	The whole path, against the real stores: another computer's file is
	read and its contact kept; this computer's file is written and reads
	back with the key; a delete here travels as a delete; a file sealed
	with another key is listed as unreadable, not an error (2, 11); Stop
	takes this computer's file out and forgets the key (17)
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn a_sync_brings_in_what_another_computer_wrote() {
		crate::w_main::W_TestBase();
		let folder = Com_TestDir( "folder" );
		crate::w_vault::V_TestUnlock();

		let key = [ 9u8; KEY_BYTES ];
		use zcash_address::ToAddress;
		let address = zcash_address::ZcashAddress::from_transparent_p2pkh( zcash_protocol::consensus::NetworkType::Test, [ 7u8; 20 ] ).encode();
		let far = "00000000000000aa";
		let mut theirs = known_t { clock: 5, ..Default::default() };
		theirs.nets.insert( "testnet".into(), section_t {
			contacts: BTreeMap::from( [ ( "cfar".to_string(), Rec( 5, far, Some( syncContact_t { name: "Far".into(), address: address.clone(), note: None, lastPaid: None } ) ) ) ] ),
			notes: BTreeMap::new(),
		} );
		let sealed = V_SealWith( &key, purpose_t::PURPOSE_SYNC_FILE, &serde_json::to_vec( &syncFile_t { format: FORMAT, device: far.into(), name: "Far PC".into(), known: theirs } ).unwrap() ).unwrap();
		std::fs::write( folder.join( Com_FileName( far ) ), sealed ).unwrap();
		std::fs::write( folder.join( Com_FileName( "00000000000000cc" ) ), V_SealWith( &[ 1u8; KEY_BYTES ], purpose_t::PURPOSE_SYNC_FILE, b"{}" ).unwrap() ).unwrap();

		let _ = F_Stop().await;
		let status = F_Join( &folder.display().to_string(), &Com_SyncCode( &key ) ).await.unwrap();
		assert!( status.problem.is_none(), "{:?}", status.problem );
		assert_eq!( status.computers.len(), 3 );
		assert!( status.computers.iter().any( |c| c.device == "00000000000000cc" && !c.readable ) );

		let book = Ct_Edit( network_t::NET_TESTNET, |b| b.clone() ).await.unwrap();
		assert!( book.iter().any( |c| c.id == "cfar" && c.name == "Far" && c.address == address ), "another computer's contact arrived" );

		// one saved here that this Laurel wouldn't read again stays, untouched, through a sync
		let odd = contact_t { id: "chere".into(), name: "Here".into(), address: "not an address this Laurel reads".into(), kind: addrKind_t::ADDR_UNIFIED, note: None, lastPaid: None };
		Ct_Edit( network_t::NET_TESTNET, |b| b.push( odd.clone() ) ).await.unwrap();
		F_Sync().await.unwrap();
		assert!( Ct_Edit( network_t::NET_TESTNET, |b| b.clone() ).await.unwrap().contains( &odd ), "a sync never drops what is here" );

		let state = F_ReadState().unwrap().unwrap();
		let mine = std::fs::read( folder.join( Com_FileName( &state.device ) ) ).unwrap();
		let file: syncFile_t = serde_json::from_slice( &V_OpenWith( &key, purpose_t::PURPOSE_SYNC_FILE, &mine ).unwrap() ).unwrap();
		assert!( file.known.nets["testnet"].contacts.contains_key( "cfar" ) );

		Ct_Edit( network_t::NET_TESTNET, |b| b.retain( |c| c.id != "cfar" ) ).await.unwrap();
		F_Sync().await.unwrap();
		let state = F_ReadState().unwrap().unwrap();
		let gone = &state.known.nets["testnet"].contacts["cfar"];
		assert!( gone.value.is_none() && gone.stamp.version > 5, "a delete here beats what it deleted" );

		*f_status.lock().unwrap() = None;		// as after a restart, before any sync
		assert!( F_Status().unwrap().on, "a computer that is syncing never reads as off" );

		F_Stop().await.unwrap();
		assert!( F_ReadState().unwrap().is_none() && !F_Status().unwrap().on );
		assert!( !folder.join( Com_FileName( &state.device ) ).exists() );
		assert!( folder.join( Com_FileName( far ) ).exists(), "the others keep theirs" );
	}

	/*
	==================
	two_computers_converge

	Two computers edit apart, then each reads the other's file: both end
	with the same records, whichever looks first
	==================
	*/
	#[test]
	fn two_computers_converge() {
		let start = BTreeMap::from( [ ( "x".to_string(), Rec( 1, "a", Some( 1 ) ) ), ( "y".to_string(), Rec( 1, "a", Some( 1 ) ) ) ] );
		let ( mut a, mut b ) = ( start.clone(), start.clone() );
		let ( mut ca, mut cb ) = ( 1u64, 1u64 );
		Com_Stamp( &mut a, &BTreeMap::from( [ ( "x".to_string(), 2 ), ( "y".to_string(), 1 ) ] ), "a", &mut ca );
		Com_Stamp( &mut b, &BTreeMap::from( [ ( "x".to_string(), 3 ), ( "z".to_string(), 7 ) ] ), "b", &mut cb );
		let mut skipped = 0;
		let ( a0, b0 ) = ( a.clone(), b.clone() );
		Com_Adopt( &mut a, &b0, |_, _| true, &mut skipped );
		Com_Adopt( &mut b, &a0, |_, _| true, &mut skipped );
		assert_eq!( a, b );
	}
}
