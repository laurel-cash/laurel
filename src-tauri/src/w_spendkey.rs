/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_spendkey.rs -- Sapling's spend proving key, fetched the first time a
// payment spends Sapling money
//
// It was compiled in: 48 MB, two thirds of the download, for money most
// wallets no longer hold (Orchard and Ironwood prove with keys of their
// own; paying a Sapling address needs only the small output key, still
// compiled in). Now a payment that spends Sapling notes first makes sure
// the key is here: a copy already on this device (Laurel's, or the one
// every Zcash wallet shares), or else one download from where Zcash
// publishes it. What is downloaded is kept only if it is the published
// key, byte for byte (its BLAKE2b hash), and the engine checks it again at
// every use, so the server is trusted for nothing. The offline signer
// never downloads: it says where to put a copy.

use std::path::PathBuf;
use std::time::Duration;

use zingolib::wallet::sapling_key::{ is_spend_key, spend_params_ready, use_spend_params, SPEND_PARAMS_BYTES, SPEND_PARAMS_NAME, SPEND_PARAMS_URL };

use crate::w_disk::Com_WriteAtomic;
use crate::w_local::*;

// a stalled connection gives up; a slow one keeps going (48 MB is a minute at 6 Mbit/s)
const SK_CONNECT_SECS: u64	= 15;
const SK_READ_SECS: u64		= 30;

// one fetch at a time: two payments at once wait for the same key
static sk_fetching: tokio::sync::Mutex< () > = tokio::sync::Mutex::const_new( () );

/*
==================
Sk_Kept

Where Laurel keeps its own copy, in its data folder
==================
*/
fn Sk_Kept() -> Option< PathBuf > {
	Com_DataPath( SPEND_PARAMS_NAME )
}

/*
==================
Sk_Places

Every copy that may already be here: Laurel's own, then the folder every
Zcash wallet shares (zcashd's fetch-params, zingo's, and others)
==================
*/
fn Sk_Places() -> Vec< PathBuf > {
	let shared = zingolib::wallet::utils::get_zcash_params_path().ok().map( |d| d.join( SPEND_PARAMS_NAME ) );
	Sk_Kept().into_iter().chain( shared ).filter( |p| p.is_file() ).collect()
}

/*
==================
Sk_Here

Whether the key is here, naming the first copy that is the published
key to the engine; a wrong or damaged one is passed over. Nothing is
fetched. Hashing 48 MB takes a moment: off the async threads.
==================
*/
pub async fn Sk_Here() -> bool {
	if ( spend_params_ready() ) {
		return true;
	}
	tokio::task::spawn_blocking( || Sk_Places().iter().any( |p| use_spend_params( p ).is_ok() ) ).await.unwrap_or( false )
}

// an antivirus in the way says so, as for the Zcash servers and prices; anything else is the fetch's
fn Sk_NetError( e: &reqwest::Error ) -> werr_t {
	match crate::w_net::Com_Classify( e ) {
		werr_t::WERR_INTERCEPTED => werr_t::WERR_INTERCEPTED,
		_ => werr_t::WERR_SPEND_KEY_FETCH( crate::w_net::Com_CauseChain( e ) ),
	}
}

/*
==================
Sk_Fetch

The published key, downloaded whole into memory (never past its size),
checked, and only then written, atomically, where Laurel keeps it
==================
*/
async fn Sk_Fetch( to: PathBuf ) -> wresult_t< () > {
	let failed = |why: String| werr_t::WERR_SPEND_KEY_FETCH( why );
	let client = crate::w_net::Com_Https()?
		.connect_timeout( Duration::from_secs( SK_CONNECT_SECS ) )
		.read_timeout( Duration::from_secs( SK_READ_SECS ) )
		.build()
		.map_err( |e| failed( e.to_string() ) )?;
	let mut answer = client.get( SPEND_PARAMS_URL ).send().await
		.and_then( reqwest::Response::error_for_status )
		.map_err( |e| Sk_NetError( &e ) )?;

	let mut bytes = Vec::with_capacity( SPEND_PARAMS_BYTES as usize );
	while let Some( chunk ) = answer.chunk().await.map_err( |e| Sk_NetError( &e ) )? {
		if ( ( bytes.len() + chunk.len() ) as u64 > SPEND_PARAMS_BYTES ) {
			return Err( failed( "the download is longer than the published key".to_string() ) );
		}
		bytes.extend_from_slice( &chunk );
	}

	tokio::task::spawn_blocking( move || {
		if ( !is_spend_key( &bytes ) ) {
			return Err( failed( "the download isn't the published key".to_string() ) );
		}
		Com_WriteAtomic( &to, &bytes )?;
		use_spend_params( &to ).map_err( |e| failed( e.to_string() ) )
	} ).await.map_err( |e| failed( e.to_string() ) )?
}

/*
==================
Sk_Ensure

Before a payment that spends Sapling notes: the key is here, or fetched
now. Nothing is asked of the network when it is already here.
==================
*/
pub async fn Sk_Ensure() -> wresult_t< () > {
	let _one = sk_fetching.lock().await;
	if ( Sk_Here().await ) {
		return Ok( () );
	}
	let to = Sk_Kept().ok_or_else( Com_NoDataFolder )?;
	log::info!( "fetching Sapling's spend proving key from {SPEND_PARAMS_URL}" );
	Sk_Fetch( to ).await
}

/*
==================
Sk_EnsureOffline

The offline signer's Sk_Ensure: a copy here or a clear word on where to
put one, never a download
==================
*/
pub async fn Sk_EnsureOffline() -> wresult_t< () > {
	if ( Sk_Here().await ) {
		return Ok( () );
	}
	Err( Sk_Missing() )
}

// the bytes Laurel's own copy takes (Storage counts it with the app), 0 before it's fetched
pub fn Sk_KeptBytes() -> u64 {
	Sk_Kept().and_then( |p| std::fs::metadata( p ).ok() ).map_or( 0, |m| m.len() )
}

// where a copy goes, to be found (Laurel's data folder), and the error that says so
pub fn Sk_Folder() -> String {
	Sk_Kept().and_then( |p| p.parent().map( |d| d.display().to_string() ) ).unwrap_or_default()
}

pub fn Sk_Missing() -> werr_t {
	werr_t::WERR_SPEND_KEY_MISSING( Sk_Folder() )
}

/*
==================
Sk_CopyInto

For a signer about to spend Sapling notes: where to copy the key, when
it isn't here yet (the review says so before Sign is pressed)
==================
*/
pub async fn Sk_CopyInto( from: &[ pool_t ] ) -> Option< String > {
	( Sk_Needed( from ) && !Sk_Here().await ).then( Sk_Folder )
}

// whether a payment from these pools spends Sapling notes
pub fn Sk_Needed( from: &[ pool_t ] ) -> bool {
	from.contains( &pool_t::POOL_SAPLING )
}

#[cfg( test )]
mod tests {
	use super::*;

	/*
	==================
	probe_spend_key_fetch

	Laurel's own download of the key, from where Zcash publishes it, into a
	folder of its own: what a first Sapling spend does on a device with no
	copy. A device that has one (zcashd's, zingo's) never fetches, so using
	the app there doesn't run this. Needs the network, so ignored by default:
	cargo test --lib probe_spend_key_fetch -- --ignored --nocapture
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	#[ignore]
	async fn probe_spend_key_fetch() {
		let dir = Com_TestDir( "spendkey" );
		let to = dir.join( SPEND_PARAMS_NAME );
		let t = std::time::Instant::now();
		let fetched = Sk_Fetch( to.clone() ).await;
		let bytes = std::fs::metadata( &to ).map( |m| m.len() );
		let _ = std::fs::remove_dir_all( &dir );
		println!( "fetch: {:?}, {:?} bytes, {:.1} s", fetched, bytes, t.elapsed().as_secs_f32() );
		fetched.expect( "the published key, checked" );
		assert_eq!( bytes.expect( "written" ), SPEND_PARAMS_BYTES );
	}
}
