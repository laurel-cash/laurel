/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_mobile.rs -- lock when Android hides the app for longer than the person
// allows, not when a permission dialog pauses it
use std::sync::Mutex;
use std::time::Duration;

use crate::w_date::Com_Now;

use tauri_specta::Event;

// the native side (LifecyclePlugin.kt), once M_Plugin has registered it
#[cfg( target_os = "android" )]
static m_native: std::sync::OnceLock< tauri::plugin::PluginHandle< tauri::Wry > > = std::sync::OnceLock::new();

// when Laurel went out of sight, and which hiding it was (a timer from an
// earlier one must not lock a later visit)
static m_hidden: Mutex< ( Option< u64 >, u64 ) > = Mutex::new( ( None, 0 ) );		// unix seconds, and the visit

/*
==================
M_Hidden

Android reports the app no longer visible. At once, if the person chose
so; otherwise when the time they allow runs out. Android may freeze a
hidden app and its timers, so M_Shown checks the clock again on return.
==================
*/
pub fn M_Hidden( app: tauri::AppHandle ) {
	log::info!( "M_Hidden: activity hidden" );
	if ( !crate::w_vault::V_IsUnlocked() ) {
		return;
	}
	let away = crate::w_settings::S_Get().lockAwaySecs;
	if ( away == 0 ) {
		tauri::async_runtime::spawn( async move { M_Lock( &app ).await } );
		return;
	}
	let visit = {
		let mut h = m_hidden.lock().unwrap();
		h.1 += 1;
		*h = ( Some( Com_Now() ), h.1 );
		h.1
	};
	tauri::async_runtime::spawn( async move {
		tokio::time::sleep( Duration::from_secs( away as u64 ) ).await;
		let still = { let h = m_hidden.lock().unwrap(); h.0.is_some() && h.1 == visit };
		if ( still ) {
			M_Lock( &app ).await;
		}
	} );
}

/*
==================
M_Shown

Laurel is visible again: locked first if it was away longer than the
person allows, by the wall clock (a frozen or sleeping phone's timers
don't run). A clock that went backwards counts as too long
==================
*/
pub async fn M_Shown( app: &tauri::AppHandle ) {
	// the one report of a return (M_Shown_f): the page waits on it
	let since = m_hidden.lock().unwrap().0.take();
	let Some( since ) = since else {
		return;
	};
	if ( crate::w_settings::S_AwayTooLong( Com_Now().checked_sub( since ).map( Duration::from_secs ), crate::w_settings::S_Get().lockAwaySecs ) ) {
		M_Lock( app ).await;
	}
}

// the vault event follows the actual lock result, including a failed save
async fn M_Lock( app: &tauri::AppHandle ) {
	if ( crate::w_vault::V_IsUnlocked() ) {
		if let Err( e ) = crate::w_main::W_Lock( app ).await {
			log::warn!( "M_Lock: {}", e.LogText() );
		}
		let _ = crate::w_local::vaultChangedEvent_t {}.emit( app );
		log::info!( "M_Lock: lock finished" );
	}
}

const RESUME_WAIT: std::time::Duration = std::time::Duration::from_secs( 300 );

/*
==================
M_Resume

Leaving Laurel for a system picker may lock it (M_Hidden), closing every
wallet. What was picked is used only after the person unlocks, never
because they picked, and with the wallets open again. WERR_LOCKED if
nobody unlocks within RESUME_WAIT.
==================
*/
#[cfg( target_os = "android" )]
pub async fn M_Resume( app: &tauri::AppHandle ) -> crate::w_local::wresult_t< () > {
	crate::w_vault::V_WhenUsable( RESUME_WAIT ).await?;
	crate::w_sync::Sync_OpenAll( app, crate::w_settings::S_Get().network ).await
}

/*
==================
M_Restart

Laurel opens again in a new process (Start Over). A process of its own
(RestartActivity, ":restart") ends this one, then opens Laurel: this one
can't open itself after it's gone. The process ends without exit
handlers (Sys_End), so Android's render threads never see one run
==================
*/
#[cfg( target_os = "android" )]
pub fn M_Restart() -> crate::w_local::wresult_t< () > {
	let native = m_native.get().ok_or_else( || crate::w_local::werr_t::WERR_ENGINE( "the lifecycle plugin isn't ready".to_string() ) )?;
	native.run_mobile_plugin::< serde_json::Value >( "restart", serde_json::json!( {} ) ).map_err( |e| crate::w_local::werr_t::WERR_ENGINE( e.to_string() ) )?;
	Ok( () )
}

/*
==================
M_Plugin

The native channel is private to Rust; page scripts cannot invoke it.
==================
*/
#[cfg( target_os = "android" )]
pub fn M_Plugin() -> tauri::plugin::TauriPlugin< tauri::Wry > {
	tauri::plugin::Builder::new( "laurel-lifecycle" )
		.setup( |app, api| {
			let native = api.register_android_plugin( "com.rptxsoftware.wallet", "LifecyclePlugin" )?;
			let app = app.clone();
			// Android hid the activity; its return is the page's to report (M_Shown_f), which
			// keeps the wallets covered until the answer: two reports raced, and the second
			// said "fine" while the first was still locking
			let channel = tauri::ipc::Channel::< () >::new( move |_| {
				M_Hidden( app.clone() );
				Ok( () )
			} );
			native.run_mobile_plugin::< serde_json::Value >( "watch", serde_json::json!( { "channel": channel } ) )?;
			let _ = m_native.set( native );
			Ok( () )
		} )
		.build()
}

