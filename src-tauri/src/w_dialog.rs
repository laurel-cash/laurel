/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_dialog.rs -- the system's pickers: a folder, a file to open, a place
// to save one
//
// Opened from Rust only, so the ui holds no file access of its own: it asks
// for a pick, and gets back the path the person chose, or none when they
// closed the picker (check_owners: the dialog plugin is used only here).

use std::path::PathBuf;

use tauri::AppHandle;
#[cfg( desktop )]
use tauri_plugin_dialog::{ DialogExt, FilePath };
use crate::w_local::wresult_t;
#[cfg( not( desktop ) )]
use crate::w_local::werr_t;

#[cfg( desktop )]
fn Com_Path( picked: Option< FilePath > ) -> Option< PathBuf > {
	picked.and_then( |p| p.into_path().ok() )
}

#[cfg( desktop )]
pub async fn D_PickFolder( app: &AppHandle ) -> wresult_t< Option< PathBuf > > {
	let ( tx, rx ) = tokio::sync::oneshot::channel();
	app.dialog().file().pick_folder( move |p| { let _ = tx.send( Com_Path( p ) ); } );
	Ok( rx.await.unwrap_or( None ) )
}

// a file of one kind (what: its name in the picker; ext: without the dot)
#[cfg( desktop )]
pub async fn D_PickFile( app: &AppHandle, what: &str, ext: &str ) -> wresult_t< Option< PathBuf > > {
	let ( tx, rx ) = tokio::sync::oneshot::channel();
	app.dialog().file().add_filter( what, &[ ext ] ).pick_file( move |p| { let _ = tx.send( Com_Path( p ) ); } );
	Ok( rx.await.unwrap_or( None ) )
}

// where to save a file, starting from a suggested name
#[cfg( desktop )]
pub async fn D_SaveFile( app: &AppHandle, what: &str, ext: &str, name: &str ) -> wresult_t< Option< PathBuf > > {
	let ( tx, rx ) = tokio::sync::oneshot::channel();
	app.dialog().file().add_filter( what, &[ ext ] ).set_file_name( name ).save_file( move |p| { let _ = tx.send( Com_Path( p ) ); } );
	Ok( rx.await.unwrap_or( None ) )
}

// iOS needs its own document-provider integration (WERR_NO_FILES until then).
#[cfg( target_os = "ios" )]
pub async fn D_PickFolder( _: &AppHandle ) -> wresult_t< Option< PathBuf > > {
	Err( werr_t::WERR_NO_FILES )
}

#[cfg( target_os = "ios" )]
pub async fn D_PickFile( _: &AppHandle, _: &str, _: &str ) -> wresult_t< Option< PathBuf > > {
	Err( werr_t::WERR_NO_FILES )
}

#[cfg( target_os = "ios" )]
pub async fn D_SaveFile( _: &AppHandle, _: &str, _: &str, _: &str ) -> wresult_t< Option< PathBuf > > {
	Err( werr_t::WERR_NO_FILES )
}

// the system picker; the document it grants, or none when closed
#[cfg( target_os = "android" )]
async fn D_NativePick( mode: &str, name: &str ) -> wresult_t< Option< String > > {
	#[derive( serde::Deserialize )]
	struct picked_t { uri: Option< String > }
	let payload = serde_json::json!( { "mode": mode, "name": name } );
	let picked: picked_t = tauri::async_runtime::spawn_blocking( move || crate::w_documents::Doc_Native( "pick", payload ) ).await
		.map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )??;
	Ok( picked.uri )
}

// a pick leaves Laurel, so the caller goes on only once it is back (M_Resume)
#[cfg( target_os = "android" )]
async fn D_AndroidPick( app: &AppHandle, mode: &str, name: &str ) -> wresult_t< Option< PathBuf > > {
	crate::w_documents::Doc_Clear( app );
	let Some( uri ) = D_NativePick( mode, name ).await? else {
		return Ok( None );
	};
	crate::w_mobile::M_Resume( app ).await?;
	Ok( Some( PathBuf::from( uri ) ) )
}

#[cfg( target_os = "android" )]
pub async fn D_PickFolder( app: &AppHandle ) -> wresult_t< Option< PathBuf > > {
	D_AndroidPick( app, "folder", "" ).await
}

#[cfg( target_os = "android" )]
pub async fn D_PickFile( app: &AppHandle, _: &str, _: &str ) -> wresult_t< Option< PathBuf > > {
	D_AndroidPick( app, "read", "" ).await
}

#[cfg( target_os = "android" )]
pub async fn D_SaveFile( app: &AppHandle, _: &str, _: &str, name: &str ) -> wresult_t< Option< PathBuf > > {
	D_AndroidPick( app, "save", name ).await
}
