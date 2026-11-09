/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_main.rs -- the wallet registry: every wallet on disk, their accounts
// and names (what they hold is w_balance.rs). creating, restoring, adding
// accounts, shutting down.

use std::num::NonZeroU32;
use std::path::{ Path, PathBuf };
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use bip0039::{ English, Mnemonic };
use pepper_sync::config::TransparentAddressDiscovery;
use tokio::sync::RwLock;
use zingolib::config::{ ClientConfig, WalletConfig };
use zingolib::lightclient::LightClient;
use zingolib::wallet::WalletSettings;
use zeroize::Zeroizing;
use zip32::AccountId;
use laurel_engine::zcashd::{ read_zcashd_keys, usk_for_sapling_key, ZcashdKeyError };

use crate::w_balance::W_Balances;
use crate::w_date::Com_Now;
use crate::w_disk::{ Com_ReadFile, Com_Shred, Com_ShredTree, Com_WriteAtomic };
use crate::w_engine::*;
use crate::w_local::*;
use crate::w_net::*;
use crate::w_phrase::*;
use crate::w_vault::*;

// how often each wallet's saver looks for unsaved changes
const SAVE_INTERVAL: Duration = Duration::from_secs( 2 );

// temp files earlier versions (and zingolib's own saver) could leave behind
// in the clear; shredded whenever a wallet is opened
const STALE_PLAIN_FILES: [ &str; 2 ] = [ "laurel-wallet.dat.tmp", "laurel.json.tmp" ];


/*
=========================================================================

DISK

=========================================================================
*/

/*
==================
W_Init

Called once at startup with the per-user app data directory. The folder
is kept for the process: a second call naming another was dropped without
a word, and two tests each naming their own wrote into whichever came
first. Tests share one (W_TestBase); a different second one stops a test
build here
==================
*/
pub fn W_Init( baseDir: PathBuf ) {
	let kept = w_baseDir.get_or_init( || baseDir.clone() );
	debug_assert!( *kept == baseDir, "W_Init: the data folder is {} already, not {}", kept.display(), baseDir.display() );
	crate::w_disk::Com_SweepTemps( kept );		// before anything writes: what a stop left
}

/*
==================
W_TestBase

The data folder every test in this process shares, set once: a test's
own files go in folders of its own under it
==================
*/
#[cfg( test )]
pub fn W_TestBase() -> PathBuf {
	static BASE: std::sync::OnceLock< PathBuf > = std::sync::OnceLock::new();
	BASE.get_or_init( || {
		let dir = Com_TestDir( "data" );
		W_Init( dir.clone() );
		dir
	} ).clone()
}

/*
==================
W_Constants
==================
*/
pub fn W_Constants() -> constants_t {
	constants_t {
		mobile:				cfg!( mobile ),
		phraseLengths:		PHRASE_LENGTHS.to_vec(),
		maxAccounts:		MAX_ACCOUNTS,
		maxNameLen:			MAX_NAME_LEN,
		defaultWalletName:	DEFAULT_WALLET_NAME.to_string(),
		defaultAccountName:	DEFAULT_ACCOUNT_NAME.to_string(),
		autoLockChoices:	crate::w_settings::AUTO_LOCK_CHOICES.to_vec(),
		lockAwayChoices:	crate::w_settings::LOCK_AWAY_CHOICES.to_vec(),
		blockEras:			crate::w_net::W_BlockEras(),
		memoMaxBytes:		crate::w_send::MEMO_MAX_BYTES as u32,
		categories:			TX_CATEGORIES.to_vec(),
		textScales:			crate::w_settings::TEXT_SCALES.to_vec(),
		maxPayments:		crate::w_send::MAX_PAYMENTS as u32,
		noteMaxChars:		NOTE_MAX_CHARS,
		networks:			NETWORKS.to_vec(),
	}
}

/*
==================
W_NetworkDir

Each network keeps its wallets apart, so a testnet wallet can never be
mistaken for a mainnet one
==================
*/
pub fn W_NetworkDir( net: network_t ) -> PathBuf {
	Com_NetworkPath( net ).expect( "W_Init not called" )
}


pub fn Com_NextSeq() -> u64 {
	w_seq.fetch_add( 1, Ordering::SeqCst )
}

/*
==================
W_NewWalletDir

Makes a fresh directory for a new wallet. The id is the creation time
in milliseconds, which sorts by age. create_dir fails if the directory
exists, so two callers can never be handed the same one.
==================
*/
fn W_NewWalletDir( net: network_t ) -> wresult_t< ( String, PathBuf ) > {
	let root = W_NetworkDir( net );
	let mut ms = u128::from( crate::w_date::Com_NowMsec() );

	std::fs::create_dir_all( &root ).engine()?;
	loop {
		let id = format!( "w{:x}", ms );
		let dir = root.join( &id );
		match std::fs::create_dir( &dir ) {
			Ok( () ) => return Ok( ( id, dir ) ),
			Err( e ) if e.kind() == std::io::ErrorKind::AlreadyExists => ms += 1,
			Err( e ) => return Err( e ).engine(),
		}
	}
}

/*
==================
W_ReadMeta

Sealed; a plain one is refused like a damaged one (W_OpenWallet says why).
Names are only names: if they can't be read the wallet still opens,
with default names and "not backed up", the safe default.
==================
*/
fn W_ReadMeta( dir: &Path ) -> Option< meta_t > {
	V_ReadSealed::< Option< meta_t > >( &dir.join( META_FILE_NAME ), purpose_t::PURPOSE_META, file_t::FILE_META ).ok().flatten()
}

/*
==================
W_WriteMeta

Sealed, written atomically beside the wallet file
==================
*/
fn W_WriteMeta( dir: &Path, meta: &meta_t ) -> wresult_t< () > {
	V_WriteSealed( &dir.join( META_FILE_NAME ), purpose_t::PURPOSE_META, meta )
}

/*
==================
Com_CleanText

A name or a label as shown, without the characters that change how the
rest is shown: control characters (a line break in a name), direction
overrides and isolates (U+202A-U+202E, U+2066-U+2069: "Mom" written so it
reads as something else) and invisible ones (zero width space, the
direction marks, word joiner, BOM). Names arrive from other devices and
labels from payment requests, not only from the person's own typing.
The zero width joiner and non-joiner stay: emoji and scripts need them
==================
*/
pub fn Com_CleanText( text: &str ) -> String {
	text.chars()
		.filter( |&c| !c.is_control() && !matches!( c, '\u{200B}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' ) )
		.collect()
}

/*
==================
Com_CleanName

Trimmed, not empty, not absurdly long, and only characters that show
as themselves (Com_CleanText)
==================
*/
pub fn Com_CleanName( name: &str ) -> wresult_t< String > {
	let name: String = Com_CleanText( name ).trim().chars().take( MAX_NAME_LEN as usize ).collect();

	if ( name.is_empty() ) {
		return Err( werr_t::WERR_EMPTY_NAME );
	}
	Ok( name )
}

fn W_AccountNames( count: u32 ) -> Vec< String > {
	( 0..count.max( 1 ) ).map( |n| {
		if ( n == 0 ) { DEFAULT_ACCOUNT_NAME.to_string() } else { format!( "Account {}", n + 1 ) }
	} ).collect()
}

/*
==================
W_Migrate

Before laurel held many wallets, the one wallet lived directly in the
network directory. Move it into a directory of its own.
==================
*/
fn W_Migrate( net: network_t ) {
	let root = W_NetworkDir( net );
	let old = root.join( WALLET_FILE_NAME );

	if ( !old.exists() ) {
		return;
	}
	let Ok( ( _, dir ) ) = W_NewWalletDir( net ) else {
		return;		// leave it where it is; the next start tries again
	};
	if ( std::fs::rename( &old, dir.join( WALLET_FILE_NAME ) ).is_err() ) {
		let _ = std::fs::remove_dir( &dir );
		return;
	}

	let marker = root.join( OLD_BACKUP_MARKER );
	let meta = meta_t {
		name:		DEFAULT_WALLET_NAME.to_string(),
		kind:		walletKind_t::WK_SEED,		// corrected when it is opened
		accounts:	W_AccountNames( 1 ),
		backedUp:	marker.exists(),
		created:	Com_Now(),
	};
	let _ = W_WriteMeta( &dir, &meta );
	let _ = std::fs::remove_file( marker );
}


/*
=========================================================================

REGISTRY

=========================================================================
*/

/*
==================
W_Slot

Finds a wallet and lets go of the registry at once, so a slow wallet
never holds up the others
==================
*/
pub async fn W_Slot( id: &str ) -> wresult_t< slotRef_t > {
	w_registry.read().await.slots.get( id ).cloned().ok_or( werr_t::WERR_NO_WALLET )
}

/*
==================
W_Slots

Every open wallet's id and slot, the registry let go at once: whatever
is read from each slot next waits on that slot only
==================
*/
pub async fn W_Slots() -> Vec< ( String, slotRef_t ) > {
	w_registry.read().await.slots.iter().map( |( id, s )| ( id.clone(), s.clone() ) ).collect()
}

/*
==================
W_Ids

Every open wallet, oldest first
==================
*/
pub async fn W_Ids() -> Vec< String > {
	let slots = W_Slots().await;
	let mut dated = vec![];

	for ( id, slot ) in slots {
		dated.push( ( slot.read().await.meta.created, id ) );
	}
	dated.sort();
	dated.into_iter().map( |( _, id )| id ).collect()
}

/*
==================
W_Install

Adds an opened wallet to the registry and starts its saver. Refused once
a lock has begun (W1-02): the check and the insert happen under the
registry's write lock, and W_Lock lists the wallets to close only after
V_BeginLock, so a wallet is either refused here or closed by the lock.
Its sealed files stay: the next unlock opens it.
==================
*/
async fn W_Install( id: String, dir: PathBuf, client: LightClient, meta: meta_t ) -> wresult_t< slotRef_t > {
	let wallet = E_WalletOf( &client );
	let cache = Arc::new( std::sync::Mutex::new( slotCache_t::default() ) );

	// its sync hasn't started: the one moment the engine's lock is surely free
	crate::w_addr::W_PrimeCache( &cache, meta.accounts.len() as u32, &mut *E_Idle( &wallet ).await );

	let slot = Arc::new( RwLock::new( slot_t {
		client:		Arc::new( tokio::sync::Mutex::new( client ) ),
		wallet:		wallet.clone(),
		meta:		meta,
		dir:		dir,
		saveLock:	Arc::new( tokio::sync::Mutex::new( () ) ),
		saveError:	std::sync::Mutex::new( None ),
		syncError:	std::sync::Mutex::new( None ),
		retry:		std::sync::Mutex::new( retry_t::default() ),
		cache:		cache,
		saver:		std::sync::Mutex::new( None ),
		stop:		Arc::new( tokio::sync::Notify::new() ),
	} ) );

	{
		let mut wl = w_registry.write().await;
		if ( !W_Usable() ) {
			return Err( werr_t::WERR_LOCKED );		// the client drops here, never synced
		}
		wl.slots.insert( id.clone(), slot.clone() );
	}
	W_StartSaver( id, slot.clone() ).await;
	Ok( slot )
}

#[cfg( test )]
tokio::task_local! {
	// a test's own answer to "is the vault usable": the real one is global, and a
	// lock begun by one test would refuse every other test's wallets
	static W_TEST_USABLE: bool;
}

fn W_Usable() -> bool {
	// in tests a lock is one test's own: the vault's lock test must not refuse another test's wallet
	#[cfg( test )]
	return W_TEST_USABLE.try_with( |u| *u ).unwrap_or_else( |_| V_IsUnlocked() );
	#[cfg( not( test ) )]
	V_IsUsable()
}


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
W_WriteWallet

Writes the wallet if it has unsaved changes. The flag is cleared under
the same lock that serialized it, so a change arriving during the write
sets it again and the next save picks it up. If the write fails the
flag is set again too, so nothing is ever marked saved that isn't.
Callers hold the wallet's saveLock, so writes never finish out of order.
==================
*/
async fn W_WriteWallet( wallet: &walletRef_t, dir: &Path ) -> wresult_t< () > {
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
W_StartSaver

Every SAVE_INTERVAL, until the app closes; the shutdown does the last save
==================
*/
async fn W_StartSaver( id: String, slot: slotRef_t ) {
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
fn Com_WalletNewer( bytes: &[u8] ) -> bool {
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
async fn W_OpenWallet( net: network_t, dir: &Path ) -> wresult_t< LightClient > {
	let raw = Com_ReadFile( &dir.join( WALLET_FILE_NAME ), file_t::FILE_WALLET )?;
	let bytes = V_Unseal( purpose_t::PURPOSE_WALLET, &raw )?;
	if ( Com_WalletNewer( &bytes ) ) {
		return Err( werr_t::WERR_VAULT_NEWER );
	}

	LightClient::from_bytes( bytes.to_vec(), W_BuildConfig( net, dir, WalletConfig::Read )? ).await.engine()
}


/*
=========================================================================

ENGINE

=========================================================================
*/

/*
==================
W_BuildConfig
==================
*/
pub fn W_BuildConfig( net: network_t, dir: &Path, walletConfig: WalletConfig ) -> wresult_t< ClientConfig > {
	// no server here on purpose: opening a wallet is purely local, so no
	// network problem can ever make a wallet fail to open. Sync connects
	// it afterwards (Sync_Connect) and keeps retrying if it can't.
	ClientConfig::builder()
		.set_chain_type( W_ChainType( net ) )
		.set_wallet_dir( dir.to_path_buf() )
		.set_wallet_name( WALLET_FILE_NAME.to_string() )
		.set_wallet_config( walletConfig )
		.build()
		.engine()
}

/*
==================
W_RestoreSettings

A restored wallet may come from anywhere. Transparent-only wallets
(exodus, trust, ledger) hand out a change address on every send, so
look through change addresses too, and further past the last one used.
==================
*/
fn W_RestoreSettings() -> WalletSettings {
	let mut settings = WalletSettings::default();

	settings.sync_config.transparent_address_discovery = TransparentAddressDiscovery::recovery();
	settings
}


/*
==================
W_Load

Opens every wallet of net on disk, once. The load lock is held the whole
time: a second caller waits, then finds the work done. Returns the ids
this call opened, so the caller can start syncing them.
==================
*/
pub async fn W_Load( net: network_t ) -> wresult_t< Vec< String > > {
	W_NetworkOffered( net )?;
	let _loading = w_loadLock.lock().await;

	if ( !W_Usable() ) {
		return Err( werr_t::WERR_LOCKED );		// locked, or on its way (W1-02)
	}

	{
		let mut wl = w_registry.write().await;
		if ( wl.loaded && wl.network == net ) {
			return Ok( vec![] );
		}
		wl.network = net;
	}

	W_Migrate( net );
	w_failed.lock().unwrap().clear();

	let mut opened = vec![];
	let entries: Vec< _ > = match std::fs::read_dir( W_NetworkDir( net ) ) {
		Ok( e ) => e.flatten().collect(),
		Err( _ ) => vec![],		// no directory yet: no wallets yet
	};

	// every wallet read at once (file, unseal, parse), each on a thread of
	// its own: startup waits for the slowest wallet, not for all of them
	// one after another. They are installed below in the order found.
	let mut reading = vec![];
	for entry in entries {
		let dir = entry.path();
		if ( !dir.join( WALLET_FILE_NAME ).exists() ) {
			continue;
		}
		let id = entry.file_name().to_string_lossy().to_string();
		if ( w_registry.read().await.slots.contains_key( &id ) ) {
			continue;		// already open: a second engine over one file would corrupt it
		}

		for stale in STALE_PLAIN_FILES {
			Com_Shred( &dir.join( stale ) );
		}
		let at = dir.clone();
		reading.push( ( id, dir, tokio::spawn( async move { W_OpenWallet( net, &at ).await } ) ) );
	}

	for ( id, dir, read ) in reading {
		// one unreadable wallet must not hide the others, nor vanish: it is listed
		let read = read.await.unwrap_or_else( |e| Err( werr_t::WERR_ENGINE( format!( "reading the wallet stopped: {e}" ) ) ) );
		let client = match read {
			Ok( opened ) => opened,
			Err( e ) => {
				w_failed.lock().unwrap().push( failedWallet_t { id: id, error: e.Info() } );
				continue;
			}
		};

		// meta can be missing or stale; the engine is the truth about keys
		let mut meta = W_ReadMeta( &dir ).unwrap_or( meta_t {
			name:		DEFAULT_WALLET_NAME.to_string(),
			kind:		walletKind_t::WK_SEED,
			accounts:	vec![],
			backedUp:	false,
			created:	Com_Now(),
		} );
		let ( kind, count ) = E_WalletFacts( &client ).await.unwrap_or( ( meta.kind, 1 ) );
		meta.kind = kind;
		let count = count as usize;
		let defaults = W_AccountNames( count as u32 );
		while ( meta.accounts.len() < count ) {
			meta.accounts.push( defaults[meta.accounts.len()].clone() );
		}
		meta.accounts.truncate( count );
		let _ = W_WriteMeta( &dir, &meta );		// the names as worked out above, sealed

		// a lock begun meanwhile: the rest stay closed, and the lock closes these
		W_Install( id.clone(), dir, client, meta ).await?;
		opened.push( id );
	}

	w_registry.write().await.loaded = true;
	Ok( opened )
}

/*
==================
W_AddWallet

The one path every new wallet takes, however it was made: claim the
single adding slot, make its directory, build the engine, write the
sealed wallet and its names, install it. It only counts as added once
the sealed wallet file is on disk. On any failure the directory is
removed again. build turns the new directory into an engine config.
==================
*/
struct addingGuard_t;

impl Drop for addingGuard_t {
	fn drop( &mut self ) {
		w_adding.store( false, Ordering::SeqCst );
	}
}

async fn W_AddWallet< F >( net: network_t, meta: meta_t, build: F ) -> wresult_t< String >
where
	F: FnOnce( &Path ) -> wresult_t< ClientConfig >,
{
	if ( w_adding.swap( true, Ordering::SeqCst ) ) {
		return Err( werr_t::WERR_BUSY );
	}
	let _adding = addingGuard_t;

	let ( id, dir ) = W_NewWalletDir( net )?;
	let made = async {
		let client = LightClient::new( build( &dir )?, false ).await.engine()?;
		let wallet = E_WalletOf( &client );

		// the same keys as a wallet already open: one wallet, not two
		let prints = crate::w_addr::W_Fingerprint( &*E_Idle( &wallet ).await );
		if let Some( name ) = W_SameWallet( &prints ).await {
			return Err( werr_t::WERR_WALLET_EXISTS( name ) );
		}

		E_Idle( &wallet ).await.mark_dirty();		// so the first write happens now
		W_WriteWallet( &wallet, &dir ).await?;
		W_WriteMeta( &dir, &meta )?;
		Ok::< _, werr_t >( client )
	}.await;

	match made {
		// refused by a lock: written and sealed, so it opens at the next unlock
		Ok( client ) => W_Install( id.clone(), dir, client, meta ).await.map( |_| id ),
		Err( e ) => {
			let _ = std::fs::remove_dir_all( &dir );
			Err( e )
		}
	}
}

/*
==================
W_SameWallet

The name of an open wallet that shares a viewing key part with these
prints (W_Fingerprint), if any: the same keys, already here
==================
*/
async fn W_SameWallet( prints: &std::collections::BTreeSet< Vec< u8 > > ) -> Option< String > {
	for ( _, slot ) in W_Slots().await {
		let s = slot.read().await;
		let shared = s.cache.lock().unwrap().fingerprint.intersection( prints ).next().is_some();
		if ( shared ) {
			return Some( s.meta.name.clone() );
		}
	}
	None
}

/*
==================
W_CheckNetwork

Every wallet Laurel holds is on one network (W_Load's). A request for
the other one is a mistake somewhere, never something to act on: a
wallet made on the wrong network would be listed among the right one's.
==================
*/
async fn W_CheckNetwork( net: network_t ) -> wresult_t< () > {
	W_NetworkOffered( net )?;
	let w = w_registry.read().await;
	if ( w.loaded && w.network != net ) {
		return Err( werr_t::WERR_NETWORK( net.Name(), w.network.Name() ) );
	}
	Ok( () )
}

/*
==================
W_NetworkOffered

Whether this build opens net at all (NETWORKS): the Play beta's refuses
mainnet here, for every way in (W_Load, W_SetNetwork, W_CheckNetwork),
whatever the ui asks
==================
*/
pub fn W_NetworkOffered( net: network_t ) -> wresult_t< () > {
	Com_NetworkIn( net, NETWORKS )
}

fn Com_NetworkIn( net: network_t, offered: &[ network_t ] ) -> wresult_t< () > {
	if ( !offered.contains( &net ) ) {
		return Err( werr_t::WERR_NETWORK_OFF( net.Name() ) );
	}
	Ok( () )
}

fn W_NewMeta( name: String, kind: walletKind_t, accounts: u32, backedUp: bool ) -> meta_t {
	meta_t {
		name:		name,
		kind:		kind,
		accounts:	W_AccountNames( accounts ),
		backedUp:	backedUp,
		created:	Com_Now(),
	}
}


/*
=========================================================================

CREATE / RESTORE

=========================================================================
*/

/*
==================
W_Create

Makes a brand new wallet and returns its recovery phrase. Its birthday
is the current tip, so it never scans blocks from before it existed.
==================
*/
pub async fn W_Create( net: network_t, name: String ) -> wresult_t< created_t > {
	W_CheckNetwork( net ).await?;
	let name = Com_CleanName( &name )?;
	let chainHeight = W_ChainHeight( net ).await?;

	// Laurel makes the phrase itself, from the system's generator (W_NewPhrase),
	// instead of the engine's NewSeed. The birthday is NewSeed's: 100 blocks
	// before the tip, never before Sapling
	let phrase = W_NewPhrase();
	let birthday = chainHeight.saturating_sub( 100 ).max( W_SaplingHeight( net ) );
	let id = W_AddWallet( net, W_NewMeta( name, walletKind_t::WK_SEED, 1, false ), |dir| {
		W_BuildConfig( net, dir, WalletConfig::MnemonicPhrase {
			mnemonic_phrase:	phrase.to_string(),
			no_of_accounts:		NonZeroU32::MIN,
			birthday:			birthday,
			wallet_settings:	WalletSettings::default(),
		} )
	} ).await?;

	let recovery = W_Recovery( &id, &V_Made() ).await?;
	Ok( created_t { id, recovery } )
}

/*
==================
W_CheckBirthday / Com_BirthdayAhead

A start block typed above the newest one: the wallet would never sync,
every try failing with "wallet height is ahead of the chain", and the
only way out would be removing it. Asked of the server when one answers;
offline the restore goes ahead and the sync says so when it runs
==================
*/
fn Com_BirthdayAhead( birthday: u32, tip: u32 ) -> Option< werr_t > {
	( birthday > tip ).then_some( werr_t::WERR_BIRTHDAY_AHEAD( birthday, tip ) )
}

async fn W_CheckBirthday( net: network_t, birthday: u32 ) -> wresult_t< () > {
	if ( birthday <= W_SaplingHeight( net ) ) {
		return Ok( () );
	}
	match W_ChainHeight( net ).await {
		Ok( tip ) => Com_BirthdayAhead( birthday, tip ).map_or( Ok( () ), Err ),
		Err( _ ) => Ok( () ),
	}
}

/*
==================
W_Restore

Rebuilds a wallet from its recovery phrase. birthday is the block the
wallet was made at; scanning starts there, so an early guess is safe
but slow and a late guess misses funds. 0 scans from sapling.
accounts is how many accounts the old wallet used.

passphrase is BIP-39's optional extra word, empty for none. It is used
exactly as typed: unlike the phrase it is never normalized, because
case and spaces are part of it and a changed one is a different wallet.
==================
*/
pub async fn W_Restore( net: network_t, name: String, phrase: String, passphrase: String, birthday: u32, accounts: u32 ) -> wresult_t< String > {
	// wiped when this returns, on every path: the engine keeps its own copy
	let phrase = Zeroizing::new( phrase );
	let passphrase = Zeroizing::new( passphrase );
	W_CheckNetwork( net ).await?;
	let name = Com_CleanName( &name )?;

	// catch typos before anything touches the disk
	if let Some( problem ) = crate::w_phrase::W_PhraseProblem( &phrase ) {
		return Err( problem );
	}
	W_CheckBirthday( net, birthday ).await?;
	let normalized = W_NormalizePhrase( &phrase );
	let mnemonic = Mnemonic::< English >::from_phrase( normalized.as_str() )
		.map_err( |_| werr_t::WERR_SEED_CHECKSUM )?;
	let accounts = accounts.clamp( 1, MAX_ACCOUNTS );

	// they just typed the phrase in, so it counts as backed up
	W_AddWallet( net, W_NewMeta( name, walletKind_t::WK_SEED, accounts, true ), |dir| {
		W_BuildConfig( net, dir, WalletConfig::MnemonicPhraseWithPassphrase {
			mnemonic_phrase:	mnemonic.phrase().to_string(),
			passphrase:			passphrase.to_string(),
			no_of_accounts:		NonZeroU32::new( accounts ).unwrap_or( NonZeroU32::MIN ),
			birthday:			birthday.max( W_SaplingHeight( net ) ),
			wallet_settings:	W_RestoreSettings(),
		} )
	} ).await.map_err( werr_t::Typed )		// the engine's words may quote what was typed
}

/*
==================
W_RestoreViewKey

A view-only wallet from a unified full viewing key: it sees balances
and history but holds nothing that can spend, so nothing to back up.
The key is unwrapped first (Com_Unwrap): at about 500 characters, a
copied one usually arrives in pieces
==================
*/
pub async fn W_RestoreViewKey( net: network_t, name: String, key: String, birthday: u32 ) -> wresult_t< String > {
	W_CheckNetwork( net ).await?;
	let name = Com_CleanName( &name )?;
	W_CheckBirthday( net, birthday ).await?;
	let key = crate::w_scan::Com_Unwrap( &key );
	let prefix = match net {
		network_t::NET_MAINNET => "uview1",
		network_t::NET_TESTNET => "uviewtest1",
	};
	if ( !key.starts_with( prefix ) ) {
		return Err( werr_t::WERR_VIEWKEY( prefix ) );
	}

	W_AddWallet( net, W_NewMeta( name, walletKind_t::WK_VIEWONLY, 1, true ), |dir| {
		W_BuildConfig( net, dir, WalletConfig::Ufvk {
			ufvk:				key,
			birthday:			birthday.max( W_SaplingHeight( net ) ),
			wallet_settings:	W_RestoreSettings(),
		} )
	} ).await.map_err( werr_t::Typed )		// the engine's words may quote what was typed
}

/*
==================
Com_ZcashdError

What the engine's refusal of pasted zcashd keys means. Its words never
hold a key.
==================
*/
fn Com_ZcashdError( e: ZcashdKeyError, net: network_t ) -> werr_t {
	match e {
		ZcashdKeyError::NoKey					=> werr_t::WERR_ZCASHD_NONE,
		ZcashdKeyError::Typo					=> werr_t::WERR_ZCASHD_TYPO,
		ZcashdKeyError::OtherNetwork( theirs )	=> werr_t::WERR_KEY_NETWORK( theirs, net.Name() ),
		ZcashdKeyError::SproutOnly				=> werr_t::WERR_ZCASHD_SPROUT,
		ZcashdKeyError::Build( why )			=> werr_t::WERR_ENGINE( why ),
	}
}

/*
==================
W_CheckZcashdKeys

What pasted zcashd text holds, read locally as it's typed: how many
Sapling keys, and the Sprout and transparent keys it can't import
==================
*/
pub async fn W_CheckZcashdKeys( text: &str ) -> zcashdCheck_t {
	if ( text.trim().is_empty() ) {
		return zcashdCheck_t::EMPTY;
	}
	let net = w_registry.read().await.network;
	match read_zcashd_keys( &W_ChainType( net ), text ) {
		Ok( k )		=> zcashdCheck_t::OK { sapling: k.sapling.len() as u32, sprout: k.sprout as u32, transparent: k.transparent as u32 },
		Err( e )	=> zcashdCheck_t::BAD { problem: Com_ZcashdError( e, net ).UiMessage() },
	}
}

/*
==================
W_ImportZcashdKeys

A wallet of zcashd's Sapling keys (z_exportkey, or a z_exportwallet
file pasted whole), one account per key. zcashd is gone since NU6.3;
this is how its money comes home. The wallet spends but never receives
(W_Receive): the rest of each account's keys are fresh and backed up
nowhere, so the money is meant to move on to a wallet with a phrase.
The keys themselves are the backup, so it counts as backed up.
==================
*/
pub async fn W_ImportZcashdKeys( net: network_t, name: String, text: &str, birthday: u32 ) -> wresult_t< String > {
	W_CheckNetwork( net ).await?;
	let name = Com_CleanName( &name )?;
	let chain = W_ChainType( net );
	let keys = read_zcashd_keys( &chain, text ).map_err( |e| Com_ZcashdError( e, net ) )?;
	W_CheckBirthday( net, birthday ).await?;
	let count = keys.sapling.len() as u32;
	if ( count > MAX_ACCOUNTS ) {
		return Err( werr_t::WERR_TOO_MANY_ACCOUNTS( MAX_ACCOUNTS ) );
	}
	let usks = keys.sapling.iter()
		.map( |k| usk_for_sapling_key( &chain, k ) )
		.collect::< Result< Vec< _ >, _ > >()
		.map_err( |e| Com_ZcashdError( e, net ) )?;

	W_AddWallet( net, W_NewMeta( name, walletKind_t::WK_KEY, count, true ), |dir| {
		W_BuildConfig( net, dir, WalletConfig::Usks {
			usks:				usks.clone(),
			birthday:			birthday.max( W_SaplingHeight( net ) ),
			wallet_settings:	W_RestoreSettings(),
		} )
	} ).await.map_err( werr_t::Typed )
}


/*
=========================================================================

ACCOUNTS AND NAMES

=========================================================================
*/


/*
==================
W_AddAccount

Adds the next zip-32 account to a wallet. It comes from the same
recovery phrase, so it needs no new backup.

A running sync engine doesn't know the new keys, so it is stopped here
and the caller starts it again. An account used before (in another
wallet app) may have old payments, so then the whole history is
scanned again from the birthday; a brand new one only needs the chain
from now on.

Only this wallet is locked while its engine winds down; the others
keep syncing and answering.
==================
*/
pub async fn W_AddAccount( id: &str, name: String, usedBefore: bool ) -> wresult_t< u32 > {
	let name = Com_CleanName( &name )?;
	let slot = W_Slot( id ).await?;
	let ( client, wallet ) = {
		let s = slot.read().await;
		W_Allow( s.meta.kind, walletAct_t::WA_ADD_ACCOUNT )?;
		if ( s.meta.accounts.len() as u32 >= MAX_ACCOUNTS ) {
			return Err( werr_t::WERR_TOO_MANY_ACCOUNTS( MAX_ACCOUNTS ) );
		}
		( s.client.clone(), s.wallet.clone() )
	};

	let mut c = E_Client( &client ).await?;
	E_CreateAccount( &mut c ).await?;
	let ( index, cache ) = {
		let mut s = slot.write().await;
		s.meta.accounts.push( name );
		W_WriteMeta( &s.dir, &s.meta )?;
		( s.meta.accounts.len() as u32 - 1, s.cache.clone() )
	};
	if let Ok( mut guard ) = E_Write( &wallet ).await {
		crate::w_addr::W_PrimeCache( &cache, index + 1, &mut guard );
	}

	if ( usedBefore ) {
		E_Fenced( &mut c, fence_t::FENCE_WALLET, async |f| E_Rescan( f ).await ).await?;
	} else {
		E_StopAndWait( &mut c ).await;
	}
	Ok( index )
}

/*
==================
W_UpdateMeta

The one way a wallet's names or flags change: edit, then save
==================
*/
async fn W_UpdateMeta< F >( id: &str, edit: F ) -> wresult_t< () >
where
	F: FnOnce( &mut meta_t ) -> wresult_t< () >,
{
	let slot = W_Slot( id ).await?;
	let mut s = slot.write().await;

	edit( &mut s.meta )?;
	W_WriteMeta( &s.dir, &s.meta )
}

pub async fn W_RenameWallet( id: &str, name: String ) -> wresult_t< () > {
	let name = Com_CleanName( &name )?;
	W_UpdateMeta( id, |meta| { meta.name = name; Ok( () ) } ).await
}

pub async fn W_RenameAccount( id: &str, index: u32, name: String ) -> wresult_t< () > {
	let name = Com_CleanName( &name )?;
	W_UpdateMeta( id, |meta| {
		*meta.accounts.get_mut( index as usize ).ok_or( werr_t::WERR_NO_ACCOUNT )? = name;
		Ok( () )
	} ).await
}

pub async fn W_MarkBackedUp( id: &str, words: &[ backupWord_t ], passphrase: Option< &str > ) -> wresult_t< () > {
	// marked only for someone who has the words: a wallet marked backed up is then removed as safe (W1-01)
	let client = W_Slot( id ).await?.read().await.client.clone();
	if ( !E_PhraseMatches( &*E_Client( &client ).await?, words, passphrase ).await? ) {
		return Err( werr_t::WERR_CONFIRM );
	}
	W_UpdateMeta( id, |meta| { meta.backedUp = true; Ok( () ) } ).await
}


/*
=========================================================================

QUERIES

=========================================================================
*/

/*
==================
W_Recovery

The phrase, its passphrase and the birthday needed to rebuild a wallet
anywhere, for someone just asked who they are (present_t)
==================
*/
pub async fn W_Recovery( id: &str, present: &present_t ) -> wresult_t< recovery_t > {
	let net = w_registry.read().await.network;
	let info = {
		let client = W_Slot( id ).await?.read().await.client.clone();
		E_RecoveryInfo( &*E_Client( &client ).await?, present ).await?.ok_or_else( || {
			werr_t::WERR_ENGINE( "This wallet was added with a viewing key, so it has no recovery phrase.".to_string() )
		} )?
	};

	// people remember dates, not block heights; unknown stays unknown (a
	// restored wallet's birthday is not "today" because the server is down)
	let birthdayTime = W_BlockTime( net, info.birthday ).await.ok();

	Ok( recovery_t {
		seedPhrase:		info.seed_phrase,
		passphrase:		Some( info.passphrase ).filter( |p| !p.is_empty() ),		// BIP-39: empty is none
		birthday:		info.birthday,
		birthdayTime:	birthdayTime,
	} )
}

/*
==================
W_Engine

A wallet's account and its engine handles, with the slot let go: the
slow part that follows (a proposal, a send) holds nothing anyone reads
==================
*/
pub async fn W_Engine( id: &str, account: u32 ) -> wresult_t< ( AccountId, clientRef_t, walletRef_t ) > {
	let slot = W_Slot( id ).await?;
	let s = slot.read().await;
	Ok( ( W_AccountOf( &s, account )?, s.client.clone(), s.wallet.clone() ) )
}

/*
==================
W_Paying

Everything a payment (a send, a shield, a move) needs before anything is
built, in one order: the intent taken first, so one review can be
attempted once whatever happens next; the wallet near the tip, so the
payment can't be built on an old view of the chain; then the account and
its engine handles
==================
*/
pub async fn W_Paying( id: &str, account: u32, intent: &str ) -> wresult_t< ( slotRef_t, AccountId, clientRef_t ) > {
	E_TakeIntent( intent, id, account )?;
	let slot = W_Slot( id ).await?;
	W_Allow( slot.read().await.meta.kind, walletAct_t::WA_SPEND )?;		// signed here; a view-only wallet's payment is signed elsewhere
	crate::w_sync::Sync_RequireCaughtUp( &slot ).await?;
	let ( accountId, client, _ ) = W_Engine( id, account ).await?;
	Ok( ( slot, accountId, client ) )
}

/*
==================
W_Allow

What each kind of wallet may be asked to do, decided here and nowhere
else, with the reason when not. A phrase wallet does everything. One
that only views receives, and nothing more (its payments are signed on
another device: w_offline.rs). One from zcashd keys spends its money
out, but receives nothing and moves nothing within: its private pool
here is backed by no phrase. The engine refuses by this; the ui offers
by W_Can, the same answers, so no button offers what would be refused.
==================
*/
pub fn W_Allow( kind: walletKind_t, act: walletAct_t ) -> wresult_t< () > {
	use walletAct_t::*;
	use walletKind_t::*;
	match ( kind, act ) {
		( WK_SEED, _ )							=> Ok( () ),
		( WK_VIEWONLY, WA_RECEIVE )				=> Ok( () ),
		( WK_VIEWONLY, WA_SPEND )				=> Err( werr_t::WERR_VIEWONLY_SPEND ),
		( WK_VIEWONLY, WA_MOVE_WITHIN )			=> Err( werr_t::WERR_VIEWONLY_MOVE ),
		( WK_VIEWONLY, WA_ADD_ACCOUNT )			=> Err( werr_t::WERR_VIEWONLY ),
		( WK_KEY, WA_SPEND )					=> Ok( () ),
		( WK_KEY, WA_RECEIVE )					=> Err( werr_t::WERR_KEY_WALLET_RECEIVE ),
		( WK_KEY, WA_MOVE_WITHIN )				=> Err( werr_t::WERR_KEY_WALLET_MOVE ),
		( WK_KEY, WA_ADD_ACCOUNT )				=> Err( werr_t::WERR_KEY_WALLET_ACCOUNTS ),
	}
}

pub fn W_Can( kind: walletKind_t ) -> walletCan_t {
	walletCan_t {
		spend:		W_Allow( kind, walletAct_t::WA_SPEND ).is_ok(),
		receive:	W_Allow( kind, walletAct_t::WA_RECEIVE ).is_ok(),
		moveWithin:	W_Allow( kind, walletAct_t::WA_MOVE_WITHIN ).is_ok(),
		addAccount:	W_Allow( kind, walletAct_t::WA_ADD_ACCOUNT ).is_ok(),
	}
}

// W_Allow, for an open wallet by its id
pub async fn W_Allowed( id: &str, act: walletAct_t ) -> wresult_t< () > {
	W_Allow( W_Slot( id ).await?.read().await.meta.kind, act )
}

/*
==================
W_AccountOf

A wallet's account by index, if it has one
==================
*/
pub fn W_AccountOf( s: &slot_t, account: u32 ) -> wresult_t< AccountId > {
	if ( account as usize >= s.meta.accounts.len() ) {
		return Err( werr_t::WERR_NO_ACCOUNT );
	}
	AccountId::try_from( account ).map_err( |_| werr_t::WERR_NO_ACCOUNT )
}

/*
==================
W_Summary

One wallet as the switcher shows it. The seq is taken before anything
is read: a snapshot that started later is never older than this one.
==================
*/
#[allow( clippy::await_holding_invalid_type, reason = "the only await under the slot is Sync_ProgressOf, which reads memory, never the network" )]
pub async fn W_Summary( id: &str ) -> wresult_t< walletSummary_t > {
	let slot = W_Slot( id ).await?;
	let words = slot.read().await.cache.lock().unwrap().wordsPrint;
	let sameWords = W_SameWords( id, words ).await;
	let s = slot.read().await;
	let seq = Com_NextSeq();
	let balances = W_Balances( &s );
	let saveError = s.saveError.lock().unwrap().clone();

	Ok( walletSummary_t {
		seq:		seq,
		id:			id.to_string(),
		name:		s.meta.name.clone(),
		kind:		s.meta.kind,
		can:		W_Can( s.meta.kind ),
		backedUp:	s.meta.backedUp,
		accounts:	s.meta.accounts.iter().enumerate().map( |( i, name )| accountSummary_t {
			index:		i as u32,
			name:		name.clone(),
			balance:	balances.get( i ).copied().unwrap_or_default(),
		} ).collect(),
		progress:	crate::w_sync::Sync_ProgressOf( &s, None ).await,
		saveError:	saveError,
		sameWords:	sameWords,
	} )
}

/*
==================
W_SameWords

The other open wallets made from these recovery words (W_WordsPrint):
one paper holds the words of all of them, and each passphrase is its
own. Manage Wallets says so, so neither backup is thought of as spare.
==================
*/
async fn W_SameWords( id: &str, words: Option< [ u8; 32 ] > ) -> Vec< String > {
	let Some( words ) = words else {
		return Vec::new();
	};
	let slots = W_Slots().await;
	let mut same = Vec::new();
	for ( other, slot ) in slots {
		if ( other != id && slot.read().await.cache.lock().unwrap().wordsPrint == Some( words ) ) {
			same.push( other );
		}
	}
	same
}

/*
==================
W_List

Every open wallet, oldest first, and every wallet on disk that couldn't
be opened, with the reason
==================
*/
pub async fn W_List() -> walletList_t {
	let mut wallets = vec![];

	for id in W_Ids().await {
		if let Ok( summary ) = W_Summary( &id ).await {
			wallets.push( summary );
		}
	}
	let failed = w_failed.lock().unwrap().clone();

	// every wallet folder on disk either opened or failed, so nothing in
	// either list means there is no wallet at all: the only first run
	walletList_t {
		firstRun:	wallets.is_empty() && failed.is_empty(),
		wallets:	wallets,
		failed:		failed,
	}
}


/*
=========================================================================

CLOSING, LOCKING, REMOVING

=========================================================================
*/

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
fn W_EraseAll( data: &Path, logs: &Path ) -> wresult_t< () > {
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


/*
=========================================================================

SHUTDOWN

=========================================================================
*/

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


/*
=========================================================================

TESTS

wallets are built from bip-39's own test vector: valid, holding nothing

=========================================================================
*/

#[cfg( test )]
mod tests {
	use super::*;

	use crate::w_balance::W_AccountBalance;
	use crate::w_test::TEST_WORDS_24 as TEST_PHRASE;

	// the two tests whose wallets live in the shared testnet folder: one at a
	// time, or one's load opens (and rewrites the names of) the other's wallet
	static TESTNET_FOLDER: tokio::sync::Mutex< () > = tokio::sync::Mutex::const_new( () );

	fn Scratch( name: &str ) -> PathBuf {
		Com_TestDir( &format!( "main-{name}" ) )
	}

	/*
	==================
	a_name_shows_as_itself

	A name kept the characters that change how text shows: a direction
	override made "Mom" out of other letters, a line break split it
	==================
	*/
	#[test]
	fn a_name_shows_as_itself() {
		assert_eq!( Com_CleanName( "Mo\u{202E}m\n\u{200B} " ).unwrap(), "Mom" );
		assert_eq!( Com_CleanName( "Family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}" ).unwrap(), "Family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", "emoji keep their joiners" );
		assert!( matches!( Com_CleanName( "\u{202E}\u{2066}" ), Err( werr_t::WERR_EMPTY_NAME ) ), "nothing left is no name" );
	}

	// a start block one digit too long never syncs; the newest itself is fine
	#[test]
	fn a_start_block_above_the_newest_is_refused() {
		assert!( matches!( Com_BirthdayAhead( 30_000_000, 3_100_000 ), Some( werr_t::WERR_BIRTHDAY_AHEAD( 30_000_000, 3_100_000 ) ) ) );
		assert!( Com_BirthdayAhead( 3_100_000, 3_100_000 ).is_none() );
	}

	/*
	==================
	a_wallet_from_a_newer_laurel_says_so

	A wallet file saved by a newer Laurel read as the engine failing ("Failed to
	read wallet version 47"), which says nothing about what to do: update
	==================
	*/
	#[test]
	fn a_wallet_from_a_newer_laurel_says_so() {
		let newest = zingolib::wallet::LightWallet::serialized_version();
		let file = |version: u64| [ &version.to_le_bytes()[..], &[ 0u8; 32 ] ].concat();
		assert!( Com_WalletNewer( &file( newest + 1 ) ) );
		assert!( !Com_WalletNewer( &file( newest ) ) );
		assert!( !Com_WalletNewer( &file( 32 ) ) );
		assert!( !Com_WalletNewer( &[ 1, 2, 3 ] ), "too short to say: the engine's own error stands" );
	}

	/*
	==================
	TestClient

	An offline testnet wallet from the test phrase
	==================
	*/
	async fn TestClient( dir: &Path ) -> LightClient {
		TestClientFrom( dir, TEST_PHRASE ).await
	}

	async fn TestClientFrom( dir: &Path, phrase: &str ) -> LightClient {
		TestClientWith( dir, phrase, "" ).await
	}

	async fn TestClientWith( dir: &Path, phrase: &str, passphrase: &str ) -> LightClient {
		let config = W_BuildConfig( network_t::NET_TESTNET, dir, WalletConfig::MnemonicPhraseWithPassphrase {
			mnemonic_phrase:	phrase.to_string(),
			passphrase:			passphrase.to_string(),
			no_of_accounts:		NonZeroU32::MIN,
			birthday:			W_SaplingHeight( network_t::NET_TESTNET ),
			wallet_settings:	WalletSettings::default(),
		} ).unwrap();
		LightClient::new( config, false ).await.unwrap()
	}

	/*
	==================
	PlainWalletBytes

	A wallet serialized the way zingolib wrote files before encryption
	==================
	*/
	async fn PlainWalletBytes( dir: &Path ) -> Vec< u8 > {
		let client = TestClient( dir ).await;
		let handle = E_WalletOf( &client );
		let mut wallet = E_Idle( &handle ).await;
		wallet.mark_dirty();
		wallet.save().unwrap().unwrap()
	}

	/*
	==================
	ui_answers_while_the_engine_holds_its_lock

	A sync batch holds the wallet's write lock across network requests
	(pepper-sync fetches transactions mid-batch), for as long as the
	network takes. The ui's reads must still answer: Receive from the
	address cache, balances and history from the last snapshot. This is
	the "Getting your address..." that never finished.
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	#[allow( clippy::await_holding_invalid_type, reason = "the test holds the lock on purpose, the way a sync batch does" )]
	async fn ui_answers_while_the_engine_holds_its_lock() {
		const QUICK: Duration = Duration::from_secs( 1 );
		let dir = Scratch( "busy" );
		let client = TestClient( &dir ).await;
		let slot = W_Install( "busy".to_string(), dir, client, W_NewMeta( "Busy".to_string(), walletKind_t::WK_SEED, 1, false ) ).await.unwrap();

		// one full read first, so there is a snapshot to fall back on
		let before = crate::w_history::W_BalanceHistory( "busy", 0 ).await.unwrap();
		W_Balances( &*slot.read().await );

		let s = slot.read().await;
		let _batch = E_Idle( &s.wallet ).await;		// holds the lock the way a sync batch does

		let r = tokio::time::timeout( QUICK, crate::w_addr::W_Receive( "busy", 0, None ) ).await;
		assert!( matches!( r, Ok( Ok( _ ) ) ), "receive waited on the engine: {r:?}" );

		assert_eq!( W_Balances( &s ).len(), 1, "balances read" );		// a plain function now: it can't wait

		let h = tokio::time::timeout( QUICK, crate::w_history::W_BalanceHistory( "busy", 0 ) ).await;
		assert!( h.is_ok_and( |h| h.is_ok_and( |h| h.len() == before.len() ) ), "history waited on the engine" );

		let p = tokio::time::timeout( QUICK, crate::w_sync::Sync_ProgressOf( &s, None ) ).await;
		assert!( p.is_ok(), "progress waited on the engine" );
	}

	/*
	==================
	a_fenced_call_answers_while_a_batch_holds_the_wallet

	Engine calls that take the wallet inside themselves (propose, clear,
	send, migrate, rescan) run only in a fence. With a batch holding the
	wallet, the fence answers "busy" within the limit and never starts the
	work; once the batch lets go, the work runs at once. This was a quote
	for Shield that waited, unbounded, behind every batch.
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	#[allow( clippy::await_holding_invalid_type, reason = "the test holds the lock on purpose, the way a sync batch does" )]
	async fn a_fenced_call_answers_while_a_batch_holds_the_wallet() {
		let limit = Duration::from_secs( ENGINE_WAIT_SECS + 2 );
		let dir = Scratch( "fence" );
		let mut client = TestClient( &dir ).await;
		let wallet = E_WalletOf( &client );

		let batch = E_Idle( &wallet ).await;		// a batch that doesn't let go
		let mut ran = false;
		let r = tokio::time::timeout( limit, E_Fenced( &mut client, fence_t::FENCE_WALLET, async |f| { ran = true; E_ClearProposal( f ).await; Ok( () ) } ) ).await;
		assert!( matches!( r, Ok( Err( werr_t::WERR_SYNC_BUSY ) ) ), "the fence waited past its limit: {r:?}" );
		assert!( !ran, "the work started without the wallet" );

		drop( batch );
		let r = tokio::time::timeout( Duration::from_secs( 1 ), E_Fenced( &mut client, fence_t::FENCE_WALLET, async |f| { E_ClearProposal( f ).await; Ok( () ) } ) ).await;
		assert!( matches!( r, Ok( Ok( () ) ) ), "the fence didn't run once the wallet was free: {r:?}" );
	}

	/*
	==================
	ui_answers_while_a_send_holds_the_client

	A send holds the engine's client for as long as proving and
	broadcasting take (seconds). Nothing the ui reads may wait for it:
	Receive, the wallet's summary, its history. This was the slot's own
	lock held across a send, freezing every read of that wallet.
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn ui_answers_while_a_send_holds_the_client() {
		const QUICK: Duration = Duration::from_secs( 1 );
		let dir = Scratch( "sending" );
		let client = TestClient( &dir ).await;
		let slot = W_Install( "sending".to_string(), dir, client, W_NewMeta( "Sending".to_string(), walletKind_t::WK_SEED, 1, false ) ).await.unwrap();

		let handle = slot.read().await.client.clone();
		let _sending = E_ClientWhenFree( &handle ).await;		// what a send does, for its whole length

		let r = tokio::time::timeout( QUICK, crate::w_addr::W_Receive( "sending", 0, None ) ).await;
		assert!( matches!( r, Ok( Ok( _ ) ) ), "receive waited for the send: {r:?}" );

		let sum = tokio::time::timeout( QUICK, W_Summary( "sending" ) ).await;
		assert!( matches!( sum, Ok( Ok( _ ) ) ), "the summary waited for the send" );

		let t = tokio::time::timeout( QUICK, crate::w_history::W_Transactions( "sending", 0 ) ).await;
		assert!( matches!( t, Ok( Ok( _ ) ) ), "history waited for the send" );

		// and a rename, which writes the slot, isn't held up by the send either
		let n = tokio::time::timeout( QUICK, W_RenameWallet( "sending", "Renamed".to_string() ) ).await;
		assert!( matches!( n, Ok( Ok( _ ) ) ), "the rename waited for the send" );
	}

	/*
	==================
	the_support_report_holds_nothing_private

	The report is meant to be pasted in public: a wallet's name, account
	names and addresses never appear in it, while its sync state does
	==================
	*/
	// every kind, every act: what the ui is told (W_Can) is what the engine allows (W_Allow)
	#[test]
	fn what_each_kind_of_wallet_may_do() {
		let can = |spend, receive, moveWithin, addAccount| walletCan_t { spend, receive, moveWithin, addAccount };
		assert_eq!( W_Can( walletKind_t::WK_SEED ), can( true, true, true, true ) );
		assert_eq!( W_Can( walletKind_t::WK_VIEWONLY ), can( false, true, false, false ) );
		assert_eq!( W_Can( walletKind_t::WK_KEY ), can( true, false, false, false ) );
		assert!( matches!( W_Allow( walletKind_t::WK_VIEWONLY, walletAct_t::WA_SPEND ), Err( werr_t::WERR_VIEWONLY_SPEND ) ) );
		assert!( matches!( W_Allow( walletKind_t::WK_KEY, walletAct_t::WA_RECEIVE ), Err( werr_t::WERR_KEY_WALLET_RECEIVE ) ) );
	}

	/*
	==================
	moving_asks_who_and_how_much_first

	A move between the account's own pools (w_move.rs, w_migrate.rs):
	a wallet that only views can't sign one, and one with nothing in
	Sapling is told so before anything is proposed
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn moving_asks_who_and_how_much_first() {
		let dir = Scratch( "mover" );
		let client = TestClient( &dir ).await;
		W_Install( "mover".to_string(), dir, client, W_NewMeta( "Mover".to_string(), walletKind_t::WK_SEED, 1, true ) ).await.unwrap();
		assert!( matches!( crate::w_move::W_QuoteMove( "mover", 0 ).await, Err( werr_t::WERR_NOTHING_TO_MOVE ) ) );

		let dir = Scratch( "viewer" );
		let client = TestClient( &dir ).await;
		W_Install( "viewer".to_string(), dir, client, W_NewMeta( "Viewer".to_string(), walletKind_t::WK_VIEWONLY, 1, true ) ).await.unwrap();
		assert!( matches!( crate::w_move::W_QuoteMove( "viewer", 0 ).await, Err( werr_t::WERR_VIEWONLY_MOVE ) ) );
		// a testnet-only build offers no migration at all (W_MigrateOffered), and says that first
		let plan = crate::w_migrate::W_PlanMigration( "viewer", 0 ).await;
		if ( cfg!( feature = "testnet-only" ) ) {
			assert!( matches!( plan, Err( werr_t::WERR_MIGRATE_OFF ) ) );
		} else {
			assert!( matches!( plan, Err( werr_t::WERR_VIEWONLY_MOVE ) ) );
		}
	}

	#[tokio::test( flavor = "multi_thread" )]
	async fn the_support_report_holds_nothing_private() {
		let dir = Scratch( "reported" );
		let client = TestClient( &dir ).await;
		let mut meta = W_NewMeta( "Grandma's Savings".to_string(), walletKind_t::WK_SEED, 1, true );
		meta.accounts = vec![ "Rent money".to_string() ];
		W_Install( "reported".to_string(), dir, client, meta ).await.unwrap();
		let address = crate::w_addr::W_Receive( "reported", 0, None ).await.expect( "an address" ).shielded;

		let report = crate::w_dev::D_ReportOf( "test" ).await;
		for private in [ "Grandma", "Rent money", address.as_str(), "reported" ] {
			assert!( !report.contains( private ), "the report shows {private:?}:\n{report}" );
		}
		assert!( report.contains( "account(s), scanned to" ), "the wallet's sync state is in it:\n{report}" );
	}

	/*
	==================
	removing_a_wallet_leaves_nothing_behind

	Its folder is gone from disk and it is gone from the registry, and
	removing it again says it isn't there
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn removing_a_wallet_leaves_nothing_behind() {
		let _key = V_TestUnlock();
		let dir = Scratch( "removed" );
		std::fs::write( dir.join( META_FILE_NAME ), b"names" ).unwrap();
		let client = TestClient( &dir ).await;
		W_Install( "removed".to_string(), dir.clone(), client, W_NewMeta( "Gone".to_string(), walletKind_t::WK_SEED, 1, true ) ).await.unwrap();
		W_TestBase();		// the reminders' file lives in the data folder
		let reminder = crate::w_repeat::repeatInput_t { id: None, walletId: "removed".into(), account: 0, label: "Rent".into(), to: "tmW9T9Xgyog3LQDkC1B1yfuz4ZzXUhTxAdJ".into(), zats: 1, memo: None, every: crate::w_repeat::every_t::EVERY_MONTH, next: 1 };
		crate::w_repeat::Rp_Save( reminder ).await.expect( "a reminder for it" );

		W_RemoveWallet( "removed", &V_Made() ).await.expect( "remove" );
		assert!( !dir.exists(), "the wallet's folder is still on disk" );
		assert!( !crate::w_repeat::Rp_List().await.unwrap().iter().any( |r| r.walletId == "removed" ), "its repeating payment still comes due" );
		assert!( W_Slot( "removed" ).await.is_err(), "the wallet is still in the registry" );
		assert!( matches!( W_RemoveWallet( "removed", &V_Made() ).await, Err( werr_t::WERR_NO_WALLET ) ) );
	}

	/*
	==================
	removing_or_marking_a_wallet_needs_proof

	W1-01: a wallet removed with no one asked who they are, or marked
	backed up without its words, could first be marked, then removed as
	safe: the only copy of its keys gone. Without proof neither happens;
	with the right third of its words, marking does
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn removing_or_marking_a_wallet_needs_proof() {
		use crate::w_cmds::{ W_MarkBackedUp_f, W_RemoveWallet_f };
		let _key = V_TestUnlock();
		W_TestBase();
		let dir = Scratch( "unasked" );
		let client = TestClient( &dir ).await;
		W_Install( "unasked".to_string(), dir.clone(), client, W_NewMeta( "Unasked".to_string(), walletKind_t::WK_SEED, 1, false ) ).await.unwrap();
		let backed = || async { W_List().await.wallets.iter().find( |w| w.id == "unasked" ).unwrap().backedUp };

		// marking: wrong words, too few, and none are refused
		let words: Vec< &str > = TEST_PHRASE.split_whitespace().collect();
		let need = words.len().div_ceil( BACKUP_CHECK_SHARE );
		let right: Vec< backupWord_t > = ( 0..need ).map( |i| backupWord_t { pos: i as u32, word: words[i].to_string() } ).collect();
		let mut wrong = right.clone();
		wrong[0].word = "art".to_string();		// a word of the phrase, at the wrong place
		for answers in [ vec![], right[..need - 1].to_vec(), wrong ] {
			assert!( W_MarkBackedUp_f( "unasked".into(), answers, None ).await.is_err(), "marked backed up without its words" );
			assert!( !backed().await );
		}

		// removing with nobody asked (no password, and no vault to ask against here)
		assert!( W_RemoveWallet_f( "unasked".into(), None ).await.is_err(), "removed with nobody asked" );
		assert!( dir.exists() && W_Slot( "unasked" ).await.is_ok(), "the wallet is gone" );

		// the words themselves mark it
		W_MarkBackedUp_f( "unasked".into(), right, None ).await.expect( "its own words mark it" );
		assert!( backed().await );
	}

	/*
	==================
	a_wallet_finished_while_locking_stays_closed

	W1-02: a restore still running when the lock fires (an Android app away
	for its minute) installed a live engine, syncing and able to spend,
	while the vault said locked. Now it is refused, its sealed files kept
	for the next unlock, and a load waits for the lock too. The lock is this
	test's own (W_TEST_USABLE): the real one is shared by every test
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn a_wallet_finished_while_locking_stays_closed() {
		let _folder = TESTNET_FOLDER.lock().await;
		let _key = V_TestUnlock();
		W_TestBase();
		let name = "Parked While Locking".to_string();
		W_TEST_USABLE.scope( false, async {
			// its own keys (a passphrase): not refused as the same wallet as another test's
			let made = W_AddWallet( network_t::NET_TESTNET, W_NewMeta( name.clone(), walletKind_t::WK_SEED, 1, true ), |dir| {
				W_BuildConfig( network_t::NET_TESTNET, dir, WalletConfig::MnemonicPhraseWithPassphrase {
					mnemonic_phrase:	crate::w_test::TEST_WORDS.to_string(),
					passphrase:			"parked".to_string(),
					no_of_accounts:		NonZeroU32::MIN,
					birthday:			W_SaplingHeight( network_t::NET_TESTNET ),
					wallet_settings:	WalletSettings::default(),
				} )
			} ).await;
			assert!( matches!( made, Err( werr_t::WERR_LOCKED ) ), "a wallet was installed while locking" );
			assert!( matches!( W_Load( network_t::NET_TESTNET ).await, Err( werr_t::WERR_LOCKED ) ), "wallets were loaded while locking" );
		} ).await;

		// the add answered WERR_LOCKED from W_Install itself: refused there, not removed after
		let kept: Vec< _ > = std::fs::read_dir( W_NetworkDir( network_t::NET_TESTNET ) ).unwrap().flatten()
			.filter( |e| e.path().join( WALLET_FILE_NAME ).exists() && W_ReadMeta( &e.path() ).is_some_and( |m| m.name == name ) ).collect();
		assert_eq!( kept.len(), 1, "its sealed files are gone: the next unlock can't open it" );

		// the folder is shared with other tests' loads: gone again, closed first if one opened it
		let id = kept[0].file_name().to_string_lossy().to_string();
		if ( W_RemoveWallet( &id, &V_Made() ).await.is_err() ) {
			std::fs::remove_dir_all( kept[0].path() ).unwrap();
		}
	}

	/*
	==================
	starting_over_erases_the_logs_too

	W1-03: Start Over said it erased everything on this device; the logs,
	a record of what was done when, stayed behind
	==================
	*/
	#[test]
	fn starting_over_erases_the_logs_too() {
		let data = Scratch( "over-data" );
		let logs = Scratch( "over-logs" );
		std::fs::create_dir_all( data.join( "wallets" ).join( "w1" ) ).unwrap();
		std::fs::write( data.join( "wallets" ).join( "w1" ).join( WALLET_FILE_NAME ), b"sealed" ).unwrap();
		std::fs::create_dir_all( logs.join( "old" ) ).unwrap();
		std::fs::write( logs.join( "Laurel.log" ), b"sent 1 TAZ" ).unwrap();
		std::fs::write( logs.join( "old" ).join( "Laurel.1.log" ), b"synced" ).unwrap();

		W_EraseAll( &data, &logs ).unwrap();
		assert_eq!( std::fs::read_dir( &data ).unwrap().count(), 0, "the data folder isn't empty" );
		assert_eq!( std::fs::read_dir( &logs ).unwrap().count(), 0, "the logs are still there" );
	}

	#[test]
	fn a_backup_check_is_a_third_of_the_words_at_their_places() {
		use crate::w_engine::Com_BackupMatches;
		let phrase = "a b c d e f g h i j k l";
		let w = |pos: u32, word: &str| backupWord_t { pos: pos, word: word.to_string() };
		let four = vec![ w( 0, "a" ), w( 5, "f" ), w( 7, "h" ), w( 11, "l" ) ];
		assert!( Com_BackupMatches( phrase, "", &four, None ) );
		assert!( !Com_BackupMatches( phrase, "", &four[..3], None ), "fewer than a third" );
		assert!( !Com_BackupMatches( phrase, "", &[ w( 0, "a" ), w( 0, "a" ), w( 0, "a" ), w( 0, "a" ) ], None ), "one word four times" );
		assert!( !Com_BackupMatches( phrase, "", &[ w( 0, "a" ), w( 5, "f" ), w( 7, "h" ), w( 12, "l" ) ], None ), "a place past the end" );
		assert!( !Com_BackupMatches( phrase, "", &[ w( 0, "a" ), w( 5, "f" ), w( 7, "h" ), w( 11, "k" ) ], None ), "a wrong word" );
		assert!( Com_BackupMatches( phrase, "pass", &four, Some( "pass" ) ) );
		assert!( !Com_BackupMatches( phrase, "pass", &four, None ), "its passphrase not typed" );
		assert!( !Com_BackupMatches( phrase, "pass", &four, Some( "Pass" ) ) );
		assert!( !Com_BackupMatches( "", "", &[], None ), "no phrase: nothing to back up" );
	}

	/*
	==================
	the_same_phrase_is_one_wallet

	A second wallet from the phrase of an open one is recognised by the
	addresses they share, whatever it is named (every test wallet in this
	process shares TEST_PHRASE, so any of them is the right answer); a
	wallet from another phrase shares nothing
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn the_same_phrase_is_one_wallet() {
		const OTHER_PHRASE: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";		// bip-39's second test vector

		let dir = Scratch( "same" );
		let client = TestClient( &dir ).await;
		W_Install( "same".to_string(), dir, client, W_NewMeta( "First".to_string(), walletKind_t::WK_SEED, 1, true ) ).await.unwrap();

		let again = TestClient( &Scratch( "same-again" ) ).await;
		let prints = crate::w_addr::W_Fingerprint( &*E_Idle( &E_WalletOf( &again ) ).await );
		assert!( !prints.is_empty(), "a wallet always has a first address" );
		assert!( W_SameWallet( &prints ).await.is_some(), "the same phrase again wasn't recognised" );

		let other = TestClientFrom( &Scratch( "other" ), OTHER_PHRASE ).await;
		let prints = crate::w_addr::W_Fingerprint( &*E_Idle( &E_WalletOf( &other ) ).await );
		assert_eq!( W_SameWallet( &prints ).await, None, "a different phrase was taken for an open wallet" );
	}

	/*
	==================
	a_restore_looks_past_gaps

	A phrase from another wallet may have used any transparent address:
	a restore looks through every scope (change and refund addresses
	too) until twenty in a row are unused, the most wallets leave. The
	engine starts the count over at each one in use (pepper-sync
	sync/transparent.rs), and keeps these settings in the wallet file.
	==================
	*/
	#[test]
	fn a_restore_looks_past_gaps() {
		let found = W_RestoreSettings().sync_config.transparent_address_discovery;
		assert!( found.gap_limit >= 20, "a gap limit of {} misses a used address past it", found.gap_limit );
		assert!( found.scopes.external && found.scopes.internal && found.scopes.refund, "a restore skipped a scope" );
	}

	/*
	==================
	a_viewing_key_of_any_account_is_that_wallet

	A viewing key exported from a wallet's second account becomes the
	first account of the view-only wallet made from it. Matching only
	first accounts let that one in beside its own wallet, the money
	counted twice.
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn a_viewing_key_of_any_account_is_that_wallet() {
		const PHRASE: &str = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";		// bip-39's third test vector: no other test's wallet
		let chain = W_ChainType( network_t::NET_TESTNET );

		let dir = Scratch( "two-accounts" );
		let config = W_BuildConfig( network_t::NET_TESTNET, &dir, WalletConfig::MnemonicPhraseWithPassphrase {
			mnemonic_phrase:	PHRASE.to_string(),
			passphrase:			String::new(),
			no_of_accounts:		NonZeroU32::new( 2 ).unwrap(),
			birthday:			W_SaplingHeight( network_t::NET_TESTNET ),
			wallet_settings:	WalletSettings::default(),
		} ).unwrap();
		let client = LightClient::new( config, false ).await.unwrap();
		let second = {
			let wallet = E_WalletOf( &client );
			let w = E_Idle( &wallet ).await;
			let store = w.unified_key_store.get( &AccountId::try_from( 1 ).unwrap() ).unwrap();
			zcash_client_backend::keys::UnifiedFullViewingKey::try_from( store ).unwrap().encode( &chain ).unwrap()
		};
		W_Install( "two-accounts".to_string(), dir, client, W_NewMeta( "Two Accounts".to_string(), walletKind_t::WK_SEED, 2, true ) ).await.unwrap();

		let viewDir = Scratch( "second-view" );
		let config = W_BuildConfig( network_t::NET_TESTNET, &viewDir, WalletConfig::Ufvk {
			ufvk:				second,
			birthday:			W_SaplingHeight( network_t::NET_TESTNET ),
			wallet_settings:	WalletSettings::default(),
		} ).unwrap();
		let view = LightClient::new( config, false ).await.unwrap();
		let prints = crate::w_addr::W_Fingerprint( &*E_Idle( &E_WalletOf( &view ) ).await );
		assert_eq!( W_SameWallet( &prints ).await.as_deref(), Some( "Two Accounts" ), "the second account's viewing key was taken for a new wallet" );

		// what can be spent is only said where something can be: a viewing key spends nothing
		assert_eq!( W_AccountBalance( &*E_Idle( &E_WalletOf( &view ) ).await, 0 ).unwrap().spendable, None );
		let seed = TestClient( &Scratch( "spendable-seed" ) ).await;
		assert_eq!( W_AccountBalance( &*E_Idle( &E_WalletOf( &seed ) ).await, 0 ).unwrap().spendable, Some( 0 ) );
	}

	// two testnet Sapling keys as zcashd's z_exportwallet writes them (made
	// for this test from fixed bytes; they hold nothing)
	const ZCASHD_EXPORT: &str = "# Wallet dump created by Zcash v5.0.0
secret-extended-key-test1qqqqqqqqqqqqqqq5af058f4g99l2rr9yznxwakuaq6n04ywpnl4sdvnzr60eh0c5zlcrr869xzpay5hm6gwq3snalajwwcj30czwcltt8lr6nelp8yfszl3cc8vclje76ayuwaazx60r2l7tmm6t9s82cqaf45y32egmussdx24mnssqut6mxmg85jxwxnd0z54tk9ua54zc5j3ehr06dr74vjwwcn7w37580dh6faf49pyp3x5ywql8rcxnt7v77uzfa3vhxg0vhsq3sjf5q 2021-05-01T10:00:00Z # zaddr=ztestsapling1a
secret-extended-key-test1qqqqqqqqqqqqqqqdrw8476xntx4xvcpknd0jvz05cmzweeq4vugc4eanxwz86fjn3wyq833x2zvz6wqfy52tlyk78pkhpadrrul3hd7hehaa42kre9sq8dtv82w6qaj45rgcryy9ggk8jpv449egxymlxaepjyxcvsmd5lcxrj4q7zf7ltj0nu9ycwy5s5xxd82qyxyyy5z3r9a4lg2hc09p6p669lkqmg2rtrk4egqk90jzg557qf5ytd43uznf2xeptyrhr45mh8c57sa0u 2021-06-01T10:00:00Z # zaddr=ztestsapling1b
# End of dump";

	/*
	==================
	imported_zcashd_keys_spend_but_never_receive

	A wallet of zcashd keys is what its keys say it is (not a seed wallet,
	not view-only), has an account per key, and refuses to hand out an
	address nothing backs up, or to grow an account it has no key for
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn imported_zcashd_keys_spend_but_never_receive() {
		let chain = W_ChainType( network_t::NET_TESTNET );
		let keys = read_zcashd_keys( &chain, ZCASHD_EXPORT ).unwrap();
		let usks = keys.sapling.iter().map( |k| usk_for_sapling_key( &chain, k ).unwrap() ).collect();
		let dir = Scratch( "zcashd" );
		let config = W_BuildConfig( network_t::NET_TESTNET, &dir, WalletConfig::Usks {
			usks:				usks,
			birthday:			W_SaplingHeight( network_t::NET_TESTNET ),
			wallet_settings:	WalletSettings::default(),
		} ).unwrap();
		let client = LightClient::new( config, false ).await.unwrap();
		assert_eq!( E_WalletFacts( &client ).await.unwrap(), ( walletKind_t::WK_KEY, 2 ) );

		W_Install( "zcashd".to_string(), dir, client, W_NewMeta( "Old zcashd".to_string(), walletKind_t::WK_KEY, 2, true ) ).await.unwrap();
		assert!( matches!( crate::w_addr::W_Receive( "zcashd", 0, None ).await, Err( werr_t::WERR_KEY_WALLET_RECEIVE ) ) );
		assert!( matches!( W_AddAccount( "zcashd", "More".to_string(), false ).await, Err( werr_t::WERR_KEY_WALLET_ACCOUNTS ) ) );
		// its private pool here is backed up nowhere: its Sapling money leaves by Send, never into it
		assert!( matches!( crate::w_move::W_QuoteMove( "zcashd", 0 ).await, Err( werr_t::WERR_KEY_WALLET_MOVE ) ) );

		let seed = TestClient( &Scratch( "zcashd-seed" ) ).await;
		assert_eq!( E_WalletFacts( &seed ).await.unwrap(), ( walletKind_t::WK_SEED, 1 ) );
	}

	/*
	==================
	a_passphrase_is_another_wallet

	The same words with a passphrase ("25th word") are a different
	wallet, and its backup gives the passphrase back exactly as typed
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn a_passphrase_is_another_wallet() {
		let dir = Scratch( "pass-plain" );
		W_Install( "pass-plain".to_string(), dir.clone(), TestClient( &dir ).await, W_NewMeta( "Plain".to_string(), walletKind_t::WK_SEED, 1, true ) ).await.unwrap();

		let withDir = Scratch( "pass-with" );
		let with = TestClientWith( &withDir, TEST_PHRASE, " Tr ezor" ).await;
		let prints = crate::w_addr::W_Fingerprint( &*E_Idle( &E_WalletOf( &with ) ).await );
		assert_eq!( W_SameWallet( &prints ).await, None, "a passphrase wallet was taken for the plain one" );

		let info = E_RecoveryInfo( &with, &V_Made() ).await.unwrap().unwrap();
		assert_eq!( info.passphrase, " Tr ezor", "spaces and case are part of it" );

		// two wallets, one paper: each says the other shares its words
		W_Install( "pass-with".to_string(), withDir, with, W_NewMeta( "With".to_string(), walletKind_t::WK_SEED, 1, true ) ).await.unwrap();
		assert!( W_Summary( "pass-with" ).await.unwrap().sameWords.contains( &"pass-plain".to_string() ) );
		assert!( W_Summary( "pass-plain" ).await.unwrap().sameWords.contains( &"pass-with".to_string() ) );
		assert!( !W_Summary( "pass-with" ).await.unwrap().sameWords.contains( &"pass-with".to_string() ), "a wallet shares its words with itself" );
	}

	// a_wallet_with_history_opens_fast's budget. Measured 2026-09-30 on the
	// 9 MB wallet: 157 ms in an optimized build (read 4, unseal 9, parse 125),
	// what a person waits; 1.2-1.4 s here, where Laurel's own crate isn't
	// optimized and the cipher and the parser, generic, are compiled into it.
	// The gate runs suites side by side, which can double that; past 5 s is
	// an order of magnitude lost (a key derived per open, say), not load.
	const OPEN_BUDGET_MS: u64 = 5_000;

	#[tokio::test( flavor = "multi_thread" )]
	async fn plain_wallet_file_is_refused() {
		let dir = Scratch( "plain" );
		V_TestUnlock();
		std::fs::write( dir.join( WALLET_FILE_NAME ), PlainWalletBytes( &dir ).await ).unwrap();

		assert!( matches!( W_OpenWallet( network_t::NET_TESTNET, &dir ).await, Err( werr_t::WERR_NOT_SEALED ) ) );
	}

	#[test]
	fn a_network_this_build_doesnt_open_is_refused() {
		let testnetOnly = [ network_t::NET_TESTNET ];
		assert!( Com_NetworkIn( network_t::NET_TESTNET, &testnetOnly ).is_ok() );
		assert!( matches!( Com_NetworkIn( network_t::NET_MAINNET, &testnetOnly ), Err( werr_t::WERR_NETWORK_OFF( "Mainnet" ) ) ) );
		assert!( Com_NetworkIn( network_t::NET_MAINNET, &[ network_t::NET_TESTNET, network_t::NET_MAINNET ] ).is_ok() );
	}

	/*
	==================
	the_testnet_build_never_opens_mainnet

	The Play beta's build (cargo test --lib --features testnet-only): every
	way to mainnet is refused by the engine, whatever the ui asks
	==================
	*/
	#[cfg( feature = "testnet-only" )]
	#[tokio::test( flavor = "multi_thread" )]
	async fn the_testnet_build_never_opens_mainnet() {
		assert_eq!( NETWORKS, &[ network_t::NET_TESTNET ] );
		assert!( matches!( W_SetNetwork( network_t::NET_MAINNET ).await, Err( werr_t::WERR_NETWORK_OFF( _ ) ) ) );
		assert!( matches!( W_Load( network_t::NET_MAINNET ).await, Err( werr_t::WERR_NETWORK_OFF( _ ) ) ) );
		assert!( matches!( W_CheckNetwork( network_t::NET_MAINNET ).await, Err( werr_t::WERR_NETWORK_OFF( _ ) ) ) );
		assert_eq!( W_Constants().networks, vec![ network_t::NET_TESTNET ] );
	}

	#[tokio::test( flavor = "multi_thread" )]
	async fn sealed_wallet_file_opens() {
		let dir = Scratch( "sealed" );
		let key = V_TestUnlock();
		let sealed = V_SealWith( &key, purpose_t::PURPOSE_WALLET, &PlainWalletBytes( &dir ).await ).unwrap();
		std::fs::write( dir.join( WALLET_FILE_NAME ), sealed ).unwrap();

		W_OpenWallet( network_t::NET_TESTNET, &dir ).await.expect( "sealed wallet should open" );
	}

	/*
	==================
	a_wallet_with_history_opens_fast

	Opening is the first thing anyone sees. The engine's example wallet
	with the most history (9 MB: its blocks, notes and trees), sealed as
	Laurel keeps it, read the whole way W_Load reads it: file, unseal,
	parse. Measured, and held under a budget (OPEN_BUDGET_MS), so a slower
	open is a failed check, not a spinner someone notices months later.
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn a_wallet_with_history_opens_fast() {
		let fixture = std::path::Path::new( env!( "CARGO_MANIFEST_DIR" ) ).join( "../vendor/zingolib/zingolib/src/wallet/disk/testing/examples/testnet/glory_goddess/latest/zingo-wallet.dat" );
		let plain = std::fs::read( &fixture ).expect( "the engine's example wallets are checked in" );
		let dir = Scratch( "history" );
		let key = V_TestUnlock();
		std::fs::write( dir.join( WALLET_FILE_NAME ), V_SealWith( &key, purpose_t::PURPOSE_WALLET, &plain ).unwrap() ).unwrap();

		let started = std::time::Instant::now();
		W_OpenWallet( network_t::NET_TESTNET, &dir ).await.expect( "the wallet opens" );
		let took = started.elapsed();
		eprintln!( "a {} MB wallet opened in {took:?}", plain.len() / 1_000_000 );
		assert!( took < std::time::Duration::from_millis( OPEN_BUDGET_MS ), "a {} MB wallet took {took:?} to open; the budget is {OPEN_BUDGET_MS} ms", plain.len() / 1_000_000 );
	}

	/*
	==================
	load_refuses_plain_files_and_lists_broken_ones

	The whole of W_Load on a scratch data directory: a sealed wallet opens;
	a plain one (no wallet of anyone's is: it was put there) and a damaged
	one are listed as failed, never silently dropped. A plain names file is
	not read either: the wallet opens with default names, then seals them
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn load_refuses_plain_files_and_lists_broken_ones() {
		let _folder = TESTNET_FOLDER.lock().await;
		W_TestBase();
		let key = V_TestUnlock();

		let nets = W_NetworkDir( network_t::NET_TESTNET );
		let good = nets.join( "wgood" );
		let plain = nets.join( "wplain" );
		let bad = nets.join( "wbad" );
		for dir in [ &good, &plain, &bad ] {
			std::fs::create_dir_all( dir ).unwrap();
		}
		std::fs::write( good.join( WALLET_FILE_NAME ), V_SealWith( &key, purpose_t::PURPOSE_WALLET, &PlainWalletBytes( &good ).await ).unwrap() ).unwrap();
		std::fs::write( good.join( META_FILE_NAME ), br#"{"name":"Swapped","kind":"seed","accounts":["Main"],"backedUp":true,"created":1}"# ).unwrap();
		std::fs::write( plain.join( WALLET_FILE_NAME ), PlainWalletBytes( &plain ).await ).unwrap();
		std::fs::write( bad.join( WALLET_FILE_NAME ), b"garbage" ).unwrap();

		// the folder is shared: another test's sealed wallet may open here too
		let mut opened = W_Load( network_t::NET_TESTNET ).await.unwrap();
		opened.retain( |id| [ "wgood", "wplain", "wbad" ].contains( &id.as_str() ) );
		assert_eq!( opened, vec![ "wgood".to_string() ] );

		// the registry is shared by every test in this process: look only at this test's wallets
		let list = W_List().await;
		assert!( !list.firstRun );
		let mine: Vec< _ > = list.wallets.iter().filter( |x| [ "wgood", "wplain", "wbad" ].contains( &x.id.as_str() ) ).collect();
		assert_eq!( mine.len(), 1 );
		assert_eq!( mine[0].name, DEFAULT_WALLET_NAME, "a plain names file was read" );
		assert!( !mine[0].backedUp );
		let mut failed: Vec< _ > = list.failed.iter().map( |f| f.id.as_str() ).collect();
		failed.sort();
		assert_eq!( failed, vec![ "wbad", "wplain" ] );

		// the names are sealed now, and the plain wallet is left as it was, unread
		assert!( V_IsSealed( &std::fs::read( good.join( META_FILE_NAME ) ).unwrap() ) );
		assert!( !V_IsSealed( &std::fs::read( plain.join( WALLET_FILE_NAME ) ).unwrap() ) );
		assert!( !good.join( "laurel-wallet.dat.tmp" ).exists() );
	}

	#[tokio::test( flavor = "multi_thread" )]
	async fn damaged_wallet_file_is_an_error() {
		let dir = Scratch( "damaged" );
		std::fs::write( dir.join( WALLET_FILE_NAME ), b"not a wallet at all" ).unwrap();
		assert!( W_OpenWallet( network_t::NET_TESTNET, &dir ).await.is_err() );
	}
}
