/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_documents.rs -- bounded document I/O, including Android's granted content URIs
use std::io::Read;
#[cfg( target_os = "android" )]
use std::io::Write;
use std::path::Path;
use serde::Deserialize;
use crate::w_local::*;

pub const DOCUMENT_MAX_BYTES: u64 = 64 * 1024 * 1024;
const LIST_MAX: usize = 1024;		// of a prefix's files; DocumentsPlugin.kt is told it

#[derive( Clone, serde::Serialize, serde::Deserialize, specta::Type )]
pub struct pickedFolder_t {
	pub path: String,
	pub name: String,
}

#[derive( Clone, serde::Serialize, specta::Type )]
#[serde( tag = "kind", rename_all = "camelCase" )]
pub enum documentResult_t {
	#[serde( rename = "folder" )]
	FOLDER { folder: pickedFolder_t, join: bool },
	#[serde( rename = "review" )]
	REVIEW { review: crate::w_offline::offlineReview_t },
	#[serde( rename = "saved" )]
	SAVED { path: String, signed: bool },
	#[serde( rename = "sent" )]
	SENT { txids: Vec< String > },
	#[serde( rename = "failed" )]
	#[cfg_attr( not( target_os = "android" ), allow( dead_code ) )]		// reported only where a picker can lock Laurel
	FAILED { error: errorInfo_t },
}

#[derive( Clone, serde::Serialize, specta::Type, tauri_specta::Event )]
pub struct documentChangedEvent_t {}

static d_result: std::sync::Mutex< Option< documentResult_t > > = std::sync::Mutex::new( None );

// The original screen may have unmounted when the picker caused a lock.
// The result has no spending key and is only returned after an explicit unlock.
pub fn Doc_Result() -> wresult_t< Option< documentResult_t > > {
	if ( !crate::w_vault::V_IsUsable() ) {
		return Err( werr_t::WERR_LOCKED );
	}
	Ok( d_result.lock().unwrap().clone() )
}

pub fn Doc_Clear( app: &tauri::AppHandle ) {
	use tauri_specta::Event;
	*d_result.lock().unwrap() = None;
	let _ = documentChangedEvent_t {}.emit( app );
}

pub fn Doc_Saved( path: &str, signed: bool ) -> documentResult_t {
	documentResult_t::SAVED { path: Doc_Name( Path::new( path ) ).unwrap_or_else( |_| path.to_string() ), signed: signed }
}

pub fn Doc_Report< T >( _app: &tauri::AppHandle, _result: &wresult_t< T >, _map: impl FnOnce( &T ) -> Option< documentResult_t > ) {
	#[cfg( target_os = "android" )]
	{
		use tauri_specta::Event;
		let result = match _result {
			Ok( v ) => _map( v ),
			Err( e ) => Some( documentResult_t::FAILED { error: e.Info() } ),
		};
		*d_result.lock().unwrap() = result;
		let _ = documentChangedEvent_t {}.emit( _app );
	}
}

#[derive( Deserialize )]
pub struct documentEntry_t {
	pub name: String,
	pub uri: String,
}

/*
==================
Doc_ReadBounded

Provider metadata can be absent or wrong. Enforce the limit while reading,
including pipes and a file that grows after selection.
==================
*/
pub fn Doc_ReadBounded( reader: impl Read, limit: u64 ) -> wresult_t< zeroize::Zeroizing< Vec< u8 > > > {
	let mut bytes = zeroize::Zeroizing::new( Vec::new() );
	reader.take( limit.saturating_add( 1 ) ).read_to_end( &mut bytes ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
	if ( bytes.len() as u64 > limit ) {
		return Err( werr_t::WERR_OFFLINE_FILE );
	}
	Ok( bytes )
}

pub fn Doc_Read( path: &Path, limit: u64 ) -> wresult_t< zeroize::Zeroizing< Vec< u8 > > > {
	Doc_ReadBounded( Doc_Open( path, false )?, limit )
}

// a document provider's URI, which only DocumentsPlugin.kt can open
#[cfg( target_os = "android" )]
fn Doc_IsProvided( path: &Path ) -> bool {
	path.to_string_lossy().starts_with( "content://" )
}

fn Doc_Open( path: &Path, write: bool ) -> wresult_t< std::fs::File > {
	#[cfg( target_os = "android" )]
	if ( Doc_IsProvided( path ) ) {
		use std::os::fd::FromRawFd;
		#[derive( Deserialize )]
		struct opened_t { fd: i32 }
		let opened: opened_t = Doc_Native( "open", serde_json::json!( { "uri": path, "mode": if write { "wt" } else { "r" } } ) )?;
		if ( opened.fd < 0 ) { return Err( werr_t::WERR_OFFLINE_FILE ); }
		// the native side detached this descriptor; this File is its sole owner
		return Ok( unsafe { std::fs::File::from_raw_fd( opened.fd ) } );
	}
	std::fs::OpenOptions::new().read( !write ).write( write ).open( path ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )
}

pub fn Doc_Write( path: &Path, bytes: &[ u8 ] ) -> wresult_t< () > {
	if ( bytes.len() as u64 > DOCUMENT_MAX_BYTES ) { return Err( werr_t::WERR_OFFLINE_FILE ); }
	#[cfg( target_os = "android" )]
	if ( Doc_IsProvided( path ) ) {
		let mut file = Doc_Open( path, true )?;
		file.write_all( bytes ).and_then( |_| file.flush() ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
		if ( file.metadata().is_ok_and( |m| m.is_file() ) ) {
			file.sync_all().map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
		}
		// cloud providers may return a pipe, for which fsync is not supported
		return Ok( () );
	}
	crate::w_disk::Com_WriteAtomic( path, bytes )
}

/*
==================
Doc_List

The documents in a folder whose names start with prefix, at most
LIST_MAX of them. Everything else in the folder is neither read nor
counted: a sync folder is often one the person already uses (a cloud
drive's root, with thousands of files), and a limit over every entry
once failed sync there as "can't reach the folder".
==================
*/
pub fn Doc_List( folder: &Path, prefix: &str ) -> wresult_t< Vec< documentEntry_t > > {
	let listed = Doc_ListUpTo( folder, prefix, LIST_MAX + 1 )?;
	if ( listed.len() > LIST_MAX ) {
		return Err( werr_t::WERR_SYNC_FOLDER );
	}
	Ok( listed )
}

// at most max of them, the provider's or the file system's; one past
// LIST_MAX is how Doc_List knows there were too many, on either
fn Doc_ListUpTo( folder: &Path, prefix: &str, max: usize ) -> wresult_t< Vec< documentEntry_t > > {
	#[cfg( target_os = "android" )]
	if ( Doc_IsProvided( folder ) ) {
		#[derive( Deserialize )]
		struct listed_t { entries: Vec< documentEntry_t > }
		return Doc_Native::< listed_t >( "list", serde_json::json!( { "uri": folder, "name": prefix, "max": max } ) ).map( |v| v.entries );
	}
	let mut out = Vec::new();
	for entry in std::fs::read_dir( folder ).map_err( |_| werr_t::WERR_SYNC_FOLDER )? {
		let entry = entry.map_err( |_| werr_t::WERR_SYNC_FOLDER )?;
		let name = entry.file_name().to_string_lossy().into_owned();
		if ( !name.starts_with( prefix ) ) {
			continue;
		}
		if ( out.len() >= max ) {
			break;
		}
		out.push( documentEntry_t { name: name, uri: entry.path().to_string_lossy().into_owned() } );
	}
	Ok( out )
}

pub fn Doc_Name( path: &Path ) -> wresult_t< String > {
	#[cfg( target_os = "android" )]
	if ( Doc_IsProvided( path ) ) {
		#[derive( Deserialize )]
		struct named_t { name: String }
		return Doc_Native::< named_t >( "name", serde_json::json!( { "uri": path } ) ).map( |v| v.name );
	}
	Ok( path.display().to_string() )
}

pub fn Doc_RemoveChild( folder: &Path, name: &str ) -> wresult_t< () > {
	#[cfg( target_os = "android" )]
	if ( Doc_IsProvided( folder ) ) {
		Doc_Native::< serde_json::Value >( "remove", serde_json::json!( { "uri": folder, "name": name } ) )?;
		return Ok( () );
	}
	std::fs::remove_file( folder.join( name ) ).map_err( |_| werr_t::WERR_SYNC_FOLDER )
}

/*
==================
Doc_WriteChild

Sync readers only accept authenticated complete snapshots. On Android a new
temporary document is fully written before it replaces this device's snapshot.
SAF providers do not promise atomic rename, so a failed publication is retried.
==================
*/
pub fn Doc_WriteChild( folder: &Path, name: &str, bytes: &[ u8 ] ) -> wresult_t< () > {
	if ( bytes.len() as u64 > DOCUMENT_MAX_BYTES ) { return Err( werr_t::WERR_SYNC_FOLDER ); }
	#[cfg( target_os = "android" )]
	if ( Doc_IsProvided( folder ) ) {
		#[derive( Deserialize )]
		struct created_t { uri: String }
		let temp = format!( ".laurel-{}.tmp", crate::w_vault::Com_RandomHex( 8 ) );
		let created: created_t = Doc_Native( "create", serde_json::json!( { "uri": folder, "name": temp } ) )?;
		let outcome = Doc_Write( Path::new( &created.uri ), bytes ).and_then( |_| {
			if ( Doc_Read( Path::new( &created.uri ), DOCUMENT_MAX_BYTES )?.as_slice() != bytes ) {
				return Err( werr_t::WERR_SYNC_FOLDER );
			}
			Doc_Native::< serde_json::Value >( "publish", serde_json::json!( { "uri": folder, "source": created.uri, "name": name } ) ).map( |_| () )
		} );
		if ( outcome.is_err() ) { let _ = Doc_RemoveChild( folder, &temp ); }
		return outcome;
	}
	crate::w_disk::Com_WriteAtomic( &folder.join( name ), bytes )
}

#[cfg( target_os = "android" )]
static d_native: std::sync::OnceLock< tauri::plugin::PluginHandle< tauri::Wry > > = std::sync::OnceLock::new();

#[cfg( target_os = "android" )]
pub fn Doc_Native< T: serde::de::DeserializeOwned >( command: &str, payload: serde_json::Value ) -> wresult_t< T > {
	d_native.get().ok_or( werr_t::WERR_SYNC_FOLDER )?.run_mobile_plugin( command, payload ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )
}

#[cfg( target_os = "android" )]
pub fn Doc_Plugin() -> tauri::plugin::TauriPlugin< tauri::Wry > {
	tauri::plugin::Builder::new( "laurel-documents" ).setup( |_app, api| {
		let native = api.register_android_plugin( "com.rptxsoftware.wallet", "DocumentsPlugin" )?;
		let _ = d_native.set( native );
		Ok( () )
	} ).build()
}

#[cfg( test )]
mod tests {
	use super::*;
	// a folder in daily use: its other files are neither read nor counted
	#[test]
	fn a_busy_folder_still_lists_its_own_files() {
		let dir = Com_TestDir( "list" );
		for i in 0..LIST_MAX + 100 {
			std::fs::write( dir.join( format!( "photo-{i}.jpg" ) ), b"" ).unwrap();
		}
		std::fs::write( dir.join( "laurel-sync-0123456789abcdef.lsync" ), b"x" ).unwrap();
		let listed = Doc_List( &dir, "laurel-sync-" ).unwrap();
		assert_eq!( listed.len(), 1 );
		assert_eq!( listed[0].name, "laurel-sync-0123456789abcdef.lsync" );
		for i in 0..LIST_MAX {
			std::fs::write( dir.join( format!( "laurel-sync-{i:016x}.lsync" ) ), b"" ).unwrap();
		}
		assert!( matches!( Doc_List( &dir, "laurel-sync-" ), Err( werr_t::WERR_SYNC_FOLDER ) ) );		// but not without end
		std::fs::remove_dir_all( &dir ).unwrap();
	}

	#[test]
	fn reads_are_bounded_even_without_file_metadata() {
		assert_eq!( &**Doc_ReadBounded( &b"1234"[..], 4 ).unwrap(), b"1234" );
		assert!( Doc_ReadBounded( &b"12345"[..], 4 ).is_err() );
		assert!( Doc_ReadBounded( std::io::repeat( 42 ), 16 ).is_err() );
	}
}
