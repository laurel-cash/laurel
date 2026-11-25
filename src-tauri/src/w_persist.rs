/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_persist.rs -- the wallet on disk: opening a sealed file, every write,
// the saver that writes unsaved changes, and the last save at shutdown

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use zingolib::config::WalletConfig;
use zingolib::lightclient::LightClient;
use zeroize::Zeroizing;

use crate::w_disk::{ Com_ReadFile, Com_WriteAtomic };
use crate::w_engine::*;
use crate::w_local::*;
use crate::w_main::W_BuildConfig;
use crate::w_net::*;
use crate::w_registry::W_Slots;
use crate::w_vault::*;

// how often each wallet's saver looks for unsaved changes
const SAVE_INTERVAL: Duration = Duration::from_secs( 2 );

// temp files earlier versions (and zingolib's own saver) could leave behind
// in the clear; shredded whenever a wallet is opened
pub const STALE_PLAIN_FILES: [ &str; 2 ] = [ "laurel-wallet.dat.tmp", "laurel.json.tmp" ];

/*
=========================================================================

SAVING

zingolib's own savers write the wallet in the clear; laurel builds it with
no-plaintext-save, which removes them. Every wallet write goes through
W_WriteWallet: serialize under the wallet lock, seal, write atomically.

=========================================================================
*/

/*
==================
W_ReadMeta

Sealed; a plain one is refused like a damaged one (W_OpenWallet says why).
Names are only names: if they can't be read the wallet still opens,
with default names and "not backed up", the safe default.
==================
*/
pub fn W_ReadMeta( dir: &Path ) -> Option< meta_t > {
	V_ReadSealed::< Option< meta_t > >( &dir.join( META_FILE_NAME ), purpose_t::PURPOSE_META, file_t::FILE_META ).ok().flatten()
}

/*
==================
W_WriteMeta

Sealed, written atomically beside the wallet file
==================
*/
pub fn W_WriteMeta( dir: &Path, meta: &meta_t ) -> wresult_t< () > {
	V_WriteSealed( &dir.join( META_FILE_NAME ), purpose_t::PURPOSE_META, meta )
}

/*
==================
W_WriteWallet

Writes the wallet if it has unsaved changes. The flag is cleared under
the same lock that serialized it, so a change arriving during the write
sets it again and the next save picks it up. If the write fails the
flag is set again too, so nothing is ever marked saved that isn't.
Callers hold the wallet's saveLock, so writes never finish out of order.
==================
*/
pub async fn W_WriteWallet( wallet: &walletRef_t, dir: &Path ) -> wresult_t< () > {
	let bytes = {
		let mut wallet = E_WriteWhenFree( wallet ).await;
		match wallet.save().engine()? {
			None => return Ok( () ),
			Some( b ) => {
				wallet.mark_saved();
				Zeroizing::new( b )
			}
		}
	};

	let path = dir.join( WALLET_FILE_NAME );
	let written = tauri::async_runtime::spawn_blocking( move || {
		Com_WriteAtomic( &path, &V_Seal( purpose_t::PURPOSE_WALLET, &bytes )? )
	} ).await.map_err( |e| werr_t::WERR_ENGINE( format!( "saving: {e}" ) ) ).and_then( |r| r );

	if ( written.is_err() ) {
		E_WriteWhenFree( wallet ).await.mark_dirty();
	}
	written
}

/*
==================
W_SaveAfterSend

Right after a payment goes out, while the sender still holds the engine:
a payment the wallet knows only in memory is a payment a crash forgets,
and a wallet that has forgotten one can build it again from other coins.
The saver would write it within seconds; this makes it now. A failure
is shown on the wallet (saveError) until a save works, and the saver
keeps trying.
==================
*/
pub async fn W_SaveAfterSend( slot: &slotRef_t ) {
	if let Err( e ) = W_SaveSlot( slot ).await {
		log::warn!( "W_SaveAfterSend: the payment is out; the wallet couldn't be written yet: {}", e.LogText() );
	}
}

/*
==================
W_SaveSlot

One wallet, now. The outcome is kept for the ui: a wallet that can't be
saved says so on screen until it can.
==================
*/
pub async fn W_SaveSlot( slot: &slotRef_t ) -> wresult_t< () > {
	let ( wallet, dir, one ) = {
		let s = slot.read().await;
		( s.wallet.clone(), s.dir.clone(), s.saveLock.clone() )
	};
	let _one = one.lock().await;
	let result = W_WriteWallet( &wallet, &dir ).await;

	let s = slot.read().await;
	*s.saveError.lock().unwrap() = result.as_ref().err().map( werr_t::Info );
	result
}

/*
==================
W_SaveAll

Every open wallet, now, its engine left running. iOS never says it's
ending an app: one it has suspended is killed without notice, so going
out of sight is the last sure moment to write (M_Hidden). Every wallet at
once, as in W_Shutdown: the system gives a hidden app only seconds. A
failure stays on the wallet (saveError), as from the saver
==================
*/
#[cfg( target_os = "ios" )]
pub async fn W_SaveAll() {
	let mut all = tokio::task::JoinSet::new();
	for ( id, slot ) in W_Slots().await {
		all.spawn( async move {
			if let Err( e ) = W_SaveSlot( &slot ).await {
				log::warn!( "W_SaveAll: {id}: {}", e.LogText() );
			}
		} );
	}
	while ( all.join_next().await.is_some() ) {}
}

/*
==================
W_StartSaver

Every SAVE_INTERVAL, until the app closes; the shutdown does the last save
==================
*/
pub async fn W_StartSaver( id: String, slot: slotRef_t ) {
	let stop = slot.read().await.stop.clone();
	let saving = slot.clone();
	let handle = tauri::async_runtime::spawn( async move {
		let slot = saving;
		loop {
			// W_Close stops it at once: it holds the wallet (keys and all) while it waits
			tokio::select! {
				_ = tokio::time::sleep( SAVE_INTERVAL ) => {}
				_ = stop.notified() => return,
			}
			if ( w_shuttingDown.load( Ordering::SeqCst ) ) {
				return;
			}
			// closed (locked or removed): its last save was W_Close's
			let open = w_registry.read().await.slots.get( &id ).is_some_and( |s| Arc::ptr_eq( s, &slot ) );
			if ( !open ) {
				return;
			}
			let _ = W_SaveSlot( &slot ).await;		// kept in saveError and shown
		}
	} );
	*slot.read().await.saver.lock().unwrap() = Some( handle );
}

/*
==================
Com_WalletNewer

Whether a wallet's bytes were written by a newer Laurel: the engine's
file starts with its version, and one past the newest this build reads
is a file only an update can open
==================
*/
pub fn Com_WalletNewer( bytes: &[u8] ) -> bool {
	bytes.get( ..8 )
		.and_then( |b| <[u8; 8]>::try_from( b ).ok() )
		.is_some_and( |b| u64::from_le_bytes( b ) > zingolib::wallet::LightWallet::serialized_version() )
}

/*
==================
W_OpenWallet

Reads a sealed wallet file. A plain one is refused (WERR_NOT_SEALED):
encryption came before the first release, so no wallet of anyone's is
plain, and one that is was put there. Opened, it would be a wallet from
someone else's words, swapped in without the password.
==================
*/
pub async fn W_OpenWallet( net: network_t, dir: &Path ) -> wresult_t< LightClient > {
	let raw = Com_ReadFile( &dir.join( WALLET_FILE_NAME ), file_t::FILE_WALLET )?;
	let bytes = V_Unseal( purpose_t::PURPOSE_WALLET, &raw )?;
	if ( Com_WalletNewer( &bytes ) ) {
		return Err( werr_t::WERR_VAULT_NEWER );
	}

	LightClient::from_bytes( bytes.to_vec(), W_BuildConfig( net, dir, WalletConfig::Read )? ).await.engine()
}



/*
==================
W_Shutdown

Before the process exits: savers stop, every engine stops, then every
wallet is written one last time. Savers only look every SAVE_INTERVAL,
so without this the last changes (a sync step, a new account) could be
lost. A saver mid-write finishes first: W_SaveSlot waits on saveLock.

Every wallet at once, not one after another: the caller gives the whole
shutdown a few seconds, and one engine waiting out a slow network must
not use them all up before the next wallet gets its save.
==================
*/
pub async fn W_Shutdown() {
	w_shuttingDown.store( true, Ordering::SeqCst );
	let slots = W_Slots().await;

	let mut all = tokio::task::JoinSet::new();
	for ( id, slot ) in slots {
		all.spawn( async move {
			let client = slot.read().await.client.clone();
			E_StopAndWait( &mut *E_ClientWhenFree( &client ).await ).await;
			if let Err( e ) = W_SaveSlot( &slot ).await {
				log::warn!( "W_Shutdown: {id}: {}", e.LogText() );
			}
		} );
	}
	while ( all.join_next().await.is_some() ) {}
}
