/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_lifecycle.rs -- a wallet leaving: closed, locked, removed, every one
// erased (Start Over), or all closed for another network

use std::path::Path;

use crate::w_disk::Com_ShredTree;
use crate::w_engine::*;
use crate::w_import::W_NetworkOffered;
use crate::w_local::*;
use crate::w_net::*;
use crate::w_persist::W_SaveSlot;
use crate::w_registry::{ W_Ids, W_Slot };
use crate::w_vault::*;

/*
==================
W_Close

Stops a wallet's engine, saves it one last time and takes it out of the
registry. Its saver and sync loops see it gone and end on their own.
==================
*/
async fn W_Close( id: &str ) -> wresult_t< slotRef_t > {
	let slot = W_Slot( id ).await?;
	crate::w_sync::Sync_Detach( id );		// nothing restarts the engine behind the close
	E_ForgetIntents( id );					// a quote from a closed wallet can't be sent
	let client = slot.read().await.client.clone();
	E_StopAndWait( &mut *E_ClientWhenFree( &client ).await ).await;
	let saved = W_SaveSlot( &slot ).await;
	w_registry.write().await.slots.remove( id );
	// its saver ended before W_Lock forgets the key, not up to SAVE_INTERVAL later
	let ( stop, saver ) = {
		let s = slot.read().await;
		let saver = s.saver.lock().unwrap().take();
		( s.stop.clone(), saver )
	};
	stop.notify_one();
	if let Some( saver ) = saver {
		let _ = saver.await;
	}
	saved?;
	Ok( slot )
}

/*
==================
W_Lock

Every wallet saved and closed, its saver ended (W_Close), then the key
forgotten: nothing new can be opened or unsealed. A wallet's engine stays
in memory only while a helper already running on it (a send, a sync
step) finishes. An add still running is refused at W_Install, its sealed
files kept. Unlocking loads them all again, as at start.
Only with a password: a key the system unlocks by itself would simply
open again.
==================
*/
pub async fn W_Lock( app: &tauri::AppHandle ) -> wresult_t< vaultStatus_t > {
	use tauri_specta::Event;
	if ( V_Status()?.protection != Some( protection_t::PROT_PASSWORD ) ) {
		return Err( werr_t::WERR_NO_PASSWORD );
	}
	let locking = V_BeginLock()?;
	let _ = vaultChangedEvent_t {}.emit( app );
	W_CloseAll().await;
	V_Forget();
	drop( locking );
	V_Status()
}

/*
==================
W_StartOver

The way back from a forgotten password. Every file Laurel keeps on this
device goes: the wallets (overwritten first, Com_Shred), the key file,
contacts, notes, settings. The money isn't in them but on the chain, and
each wallet's recovery phrase brings it back. Only while locked, or with
a key that can't be had at all (V_MayStartOver): then no wallet is open
to write a file back, and unlocked, each wallet has its own Remove. A
reinstall can't do this: an installer keeps the data folder
==================
*/
pub async fn W_StartOver() -> wresult_t< () > {
	V_MayStartOver()?;
	W_CloseAll().await;
	let base = Com_DataPath( "" ).expect( "W_Init not called" );
	W_EraseAll( &base, &crate::w_storage::Sto_Paths().1 )
}

/*
==================
W_EraseAll

What Start Over erases: the data folder, then the logs (W1-03), a record
of what was done when. A log file the logger still holds open is
overwritten, not removed, and the new process starts it again; that
never stops the erase. The browser's own storage is the ui's to clear
(Com_ClearPrefs), as it does before asking.
==================
*/
pub fn W_EraseAll( data: &Path, logs: &Path ) -> wresult_t< () > {
	crate::w_disk::Com_ShredTree( data ).engine()?;
	if ( !logs.as_os_str().is_empty() && logs.exists() ) {
		if let Err( e ) = crate::w_disk::Com_ShredTree( logs ) {
			log::warn!( "W_EraseAll: some logs stayed: {}", e.to_string() );
		}
	}
	Ok( () )
}

/*
==================
W_CloseAll

Every wallet saved and closed, and the registry emptied: the next W_Load
opens them again (or another network's). Locking and switching networks
both start here.
==================
*/
async fn W_CloseAll() {
	let _loading = w_loadLock.lock().await;
	for id in W_Ids().await {
		if let Err( e ) = W_Close( &id ).await {
			log::warn!( "W_CloseAll: {id}: {}", e.LogText() );		// closed anyway; the save error was shown before
		}
	}
	w_registry.write().await.loaded = false;
}

/*
==================
W_SetNetwork

Mainnet or testnet. One network is open at a time: every wallet of this
one is saved and closed, the choice is kept (w_settings.rs), and the ui
starts over, opening the other network's wallets, address book and
server choice, each kept apart under wallets/<network>/.
==================
*/
pub async fn W_SetNetwork( net: network_t ) -> wresult_t< () > {
	W_NetworkOffered( net )?;
	let settings = crate::w_settings::S_Get();
	if ( settings.network == net && w_registry.read().await.network == net ) {
		return Ok( () );
	}
	W_CloseAll().await;
	w_registry.write().await.network = net;
	crate::w_settings::S_Set( crate::w_settings::appSettings_t { network: net, ..settings } )?;
	Ok( () )
}

/*
==================
W_RemoveWallet

Takes a wallet off this computer: its engine stopped, its files shredded
and deleted. The money stays on the blockchain; its recovery phrase (or
viewing key) brings it back. Never offered without saying that first.
==================
*/
pub async fn W_RemoveWallet( id: &str, _present: &present_t ) -> wresult_t< () > {
	let slot = W_Close( id ).await?;
	let dir = slot.read().await.dir.clone();
	// every file in it shredded, not only the two Laurel names: the engine's own files hold keys too
	Com_ShredTree( &dir ).engine()?;
	std::fs::remove_dir( &dir ).engine()?;
	// the wallet is gone whatever happens here: a reminder left behind is only a reminder, and said in the log
	if let Err( e ) = crate::w_repeat::Rp_ForgetWallet( id ).await {
		log::warn!( "W_RemoveWallet: kept the repeating payments of {id}: {}", e.Info().message );
	}
	Ok( () )
}
