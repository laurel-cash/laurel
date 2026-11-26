/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_main.rs -- where the wallets live and how they're loaded: the data
// folder, the engine's config, loading every wallet at startup. The open
// wallets are w_registry.rs, the disk w_persist.rs, a wallet arriving
// w_import.rs and leaving w_lifecycle.rs; what they hold is w_balance.rs.

use std::path::{ Path, PathBuf };
use std::sync::atomic::Ordering;

use pepper_sync::config::TransparentAddressDiscovery;
use zingolib::config::{ ClientConfig, WalletConfig };
use zingolib::wallet::WalletSettings;

use crate::w_date::Com_Now;
use crate::w_disk::Com_Shred;
use crate::w_engine::*;
use crate::w_import::{ W_NetworkOffered, W_NewWalletDir };
use crate::w_local::*;
use crate::w_net::*;
use crate::w_persist::{ STALE_PLAIN_FILES, W_OpenWallet, W_ReadMeta, W_WriteMeta };
use crate::w_registry::{ W_Install, W_Usable };


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
		pageZoom:			!cfg!( target_os = "android" ),
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
		dustZats:			crate::w_send::DUST_ZATS as u32,
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

pub fn W_AccountNames( count: u32 ) -> Vec< String > {
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
		network:	Some( net ),
	};
	let _ = W_WriteMeta( &dir, &meta );
	let _ = std::fs::remove_file( marker );
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
pub fn W_RestoreSettings() -> WalletSettings {
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
		// its names say the other network: listed, never opened with this one's chain (D-033)
		let names = W_ReadMeta( &dir );
		if let Some( other ) = names.as_ref().and_then( |m| m.network ).filter( |n| *n != net ) {
			w_failed.lock().unwrap().push( failedWallet_t { id: id, error: werr_t::WERR_NETWORK( other.Name(), net.Name() ).Info() } );
			continue;
		}
		let at = dir.clone();
		reading.push( ( id, dir, names, tokio::spawn( async move { W_OpenWallet( net, &at ).await } ) ) );
	}

	for ( id, dir, names, read ) in reading {
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
		let mut meta = names.unwrap_or( meta_t {
			name:		DEFAULT_WALLET_NAME.to_string(),
			kind:		walletKind_t::WK_SEED,
			accounts:	vec![],
			backedUp:	false,
			created:	Com_Now(),
			network:	None,
		} );
		meta.network = Some( net );		// an older wallet's, from its folder (D-033)
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
=========================================================================

TESTS

wallets are built from bip-39's own test vector: valid, holding nothing

=========================================================================
*/

#[cfg( test )]
mod tests {
	use super::*;

	use std::num::NonZeroU32;
	use std::time::Duration;

	use laurel_engine::zcashd::{ read_zcashd_keys, usk_for_sapling_key };
	use zingolib::lightclient::LightClient;
	use zip32::AccountId;

	use crate::w_balance::{ W_AccountBalance, W_Balances };
	use crate::w_import::{ Com_BirthdayAhead, Com_NetworkIn, W_AddAccount, W_NewMeta, W_SameWallet };
	use crate::w_lifecycle::{ W_EraseAll, W_RemoveWallet };
	use crate::w_persist::{ Com_WalletNewer, W_OpenWallet };
	use crate::w_registry::{ W_Allow, W_Can, W_Install, W_List, W_RenameWallet, W_Slot, W_Summary };
	use crate::w_test::TEST_WORDS_24 as TEST_PHRASE;
	use crate::w_vault::*;

	// the tests each build alone has: v1's that testnet is refused, the testnet build's that mainnet
	// is (both call these two), and the testnet build's own wallets
	#[cfg( any( feature = "v1", feature = "testnet-only" ) )]
	use crate::{ w_import::W_CheckNetwork, w_lifecycle::W_SetNetwork };
	#[cfg( not( feature = "v1" ) )]
	use crate::{ w_import::W_AddWallet, w_persist::W_ReadMeta, w_registry::W_TEST_USABLE };

	// the two tests whose wallets live in the shared testnet folder: one at a
	// time, or one's load opens (and rewrites the names of) the other's wallet
	#[cfg( not( feature = "v1" ) )]		// its tests open testnet, which v1 doesn't (D-033)
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
		V_TestUnlock();
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

	Judged by the held lock, not the clock (T-054): a read that waited
	for the send would never answer, as the send is never let go while
	the reads run; a second taker of the client, still waiting once they
	have all answered, shows the send held it the whole time. The limit
	is only so a read that does wait fails the test instead of hanging
	it, and is far past any read's time under a loaded build.
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	async fn ui_answers_while_a_send_holds_the_client() {
		W_TestBase();		// its own data folder and unlock: it once held only after another test's (T-054)
		V_TestUnlock();
		const HUNG: Duration = Duration::from_secs( 60 );
		let dir = Scratch( "sending" );
		let client = TestClient( &dir ).await;
		let slot = W_Install( "sending".to_string(), dir, client, W_NewMeta( "Sending".to_string(), walletKind_t::WK_SEED, 1, false ) ).await.unwrap();

		let handle = slot.read().await.client.clone();
		let sending = E_ClientWhenFree( &handle ).await;		// what a send does, for its whole length
		let next = tokio::spawn( { let h = handle.clone(); async move { drop( E_ClientWhenFree( &h ).await ); } } );		// waits for the send

		let r = tokio::time::timeout( HUNG, crate::w_addr::W_Receive( "sending", 0, None ) ).await;
		assert!( matches!( r, Ok( Ok( _ ) ) ), "receive waited for the send: {r:?}" );

		let sum = tokio::time::timeout( HUNG, W_Summary( "sending" ) ).await;
		assert!( matches!( sum, Ok( Ok( _ ) ) ), "the summary waited for the send" );

		let t = tokio::time::timeout( HUNG, crate::w_history::W_Transactions( "sending", 0 ) ).await;
		assert!( matches!( t, Ok( Ok( _ ) ) ), "history waited for the send" );

		// and a rename, which writes the slot, isn't held up by the send either
		let n = tokio::time::timeout( HUNG, W_RenameWallet( "sending", "Renamed".to_string() ) ).await;
		assert!( matches!( n, Ok( Ok( _ ) ) ), "the rename waited for the send" );

		assert!( !next.is_finished(), "the send didn't hold the client while the reads answered" );
		drop( sending );
		tokio::time::timeout( HUNG, next ).await.expect( "the client was held by something other than the send" ).unwrap();
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
		V_TestUnlock();
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
		V_TestUnlock();
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
		#[cfg( feature = "repeat-payments" )]
		{
			let reminder = crate::w_repeat::repeatInput_t { id: None, walletId: "removed".into(), account: 0, label: "Rent".into(), to: "tmW9T9Xgyog3LQDkC1B1yfuz4ZzXUhTxAdJ".into(), zats: 1, memo: None, every: crate::w_repeat::every_t::EVERY_MONTH, next: 1 };
			crate::w_repeat::Rp_Save( reminder ).await.expect( "a reminder for it" );
		}

		W_RemoveWallet( "removed", &V_Made() ).await.expect( "remove" );
		assert!( !dir.exists(), "the wallet's folder is still on disk" );
		#[cfg( feature = "repeat-payments" )]
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
	// its wallets are testnet's, which v1 never opens (D-033): it runs in every other build
	#[cfg( not( feature = "v1" ) )]
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
		V_TestUnlock();
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
		V_TestUnlock();
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
		V_TestUnlock();
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
		V_TestUnlock();
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
	/*
	==================
	the_real_money_build_never_opens_testnet

	D-033: v1 (cargo test --lib --features v1) opens mainnet alone: every way
	to testnet is refused by the engine, and a first start is on mainnet.
	The beta's test wallets stay on disk, unopened
	==================
	*/
	#[cfg( feature = "v1" )]
	#[tokio::test( flavor = "multi_thread" )]
	async fn the_real_money_build_never_opens_testnet() {
		W_TestBase();
		assert_eq!( NETWORKS, &[ network_t::NET_MAINNET ] );
		assert_eq!( crate::w_settings::appSettings_t::default().network, network_t::NET_MAINNET );
		assert!( matches!( W_SetNetwork( network_t::NET_TESTNET ).await, Err( werr_t::WERR_NETWORK_OFF( _ ) ) ) );
		assert!( matches!( W_Load( network_t::NET_TESTNET ).await, Err( werr_t::WERR_NETWORK_OFF( _ ) ) ) );
		assert!( matches!( W_CheckNetwork( network_t::NET_TESTNET ).await, Err( werr_t::WERR_NETWORK_OFF( _ ) ) ) );
	}

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
	// its wallets are testnet's, which v1 never opens (D-033): it runs in every other build
	#[cfg( not( feature = "v1" ) )]
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

		// the folder is shared: another test's sealed wallet may open here too; and the
		// registry: a load before this one (a_wallet_knows_its_network) would answer none
		w_registry.write().await.loaded = false;
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

	/*
	==================
	a_wallet_knows_its_network

	D-033: a wallet's network was only the folder it sat in, and one moved
	into the other network's folder would have been opened with that
	network's chain. Now each wallet's names say its network: a new one
	writes it, an older one is given its folder's, and one whose names say
	the other network is listed and never opened
	==================
	*/
	// its wallets are testnet's, which v1 never opens (D-033): it runs in every other build
	#[cfg( not( feature = "v1" ) )]
	#[tokio::test( flavor = "multi_thread" )]
	async fn a_wallet_knows_its_network() {
		let _folder = TESTNET_FOLDER.lock().await;
		W_TestBase();
		let key = V_TestUnlock();

		// a new wallet writes its network (its own keys: a passphrase)
		let added = W_AddWallet( network_t::NET_TESTNET, W_NewMeta( "Knows Its Network".to_string(), walletKind_t::WK_SEED, 1, true ), |dir| {
			W_BuildConfig( network_t::NET_TESTNET, dir, WalletConfig::MnemonicPhraseWithPassphrase {
				mnemonic_phrase:	crate::w_test::TEST_WORDS.to_string(),
				passphrase:			"network".to_string(),
				no_of_accounts:		NonZeroU32::MIN,
				birthday:			W_SaplingHeight( network_t::NET_TESTNET ),
				wallet_settings:	WalletSettings::default(),
			} )
		} ).await.unwrap();
		let nets = W_NetworkDir( network_t::NET_TESTNET );
		assert_eq!( W_ReadMeta( &nets.join( &added ) ).unwrap().network, Some( network_t::NET_TESTNET ) );

		// one whose names say mainnet, in testnet's folder; one from before networks were written
		let far = nets.join( "wfar" );
		let old = nets.join( "wold" );
		for ( dir, meta ) in [
			( &far, br#"{"name":"Far","kind":"seed","accounts":["Main"],"backedUp":true,"created":1,"network":"mainnet"}"#.as_slice() ),
			( &old, br#"{"name":"Old","kind":"seed","accounts":["Main"],"backedUp":true,"created":1}"#.as_slice() ),
		] {
			std::fs::create_dir_all( dir ).unwrap();
			std::fs::write( dir.join( WALLET_FILE_NAME ), V_SealWith( &key, purpose_t::PURPOSE_WALLET, &PlainWalletBytes( dir ).await ).unwrap() ).unwrap();
			std::fs::write( dir.join( META_FILE_NAME ), V_SealWith( &key, purpose_t::PURPOSE_META, meta ).unwrap() ).unwrap();
		}
		let farBefore = std::fs::read( far.join( WALLET_FILE_NAME ) ).unwrap();

		w_registry.write().await.loaded = false;		// loaded again, as at a start
		let opened = W_Load( network_t::NET_TESTNET ).await.unwrap();
		assert!( opened.contains( &"wold".to_string() ) && !opened.contains( &"wfar".to_string() ) );
		let list = W_List().await;
		let refused = list.failed.iter().find( |f| f.id == "wfar" ).expect( "the other network's wallet is listed, not hidden" );
		assert_eq!( refused.error.message, werr_t::WERR_NETWORK( "Mainnet", "Testnet" ).Info().message );
		assert_eq!( std::fs::read( far.join( WALLET_FILE_NAME ) ).unwrap(), farBefore, "nothing written to it" );
		assert_eq!( W_ReadMeta( &old ).unwrap().network, Some( network_t::NET_TESTNET ), "an older wallet is given its folder's" );

		// the folder is shared with other tests' loads
		for id in [ added.as_str(), "wold" ] {
			let _ = W_RemoveWallet( id, &V_Made() ).await;
		}
		let _ = std::fs::remove_dir_all( &far );
		w_registry.write().await.loaded = false;		// the next test's load reads the folder again
	}

	#[tokio::test( flavor = "multi_thread" )]
	async fn damaged_wallet_file_is_an_error() {
		let dir = Scratch( "damaged" );
		std::fs::write( dir.join( WALLET_FILE_NAME ), b"not a wallet at all" ).unwrap();
		assert!( W_OpenWallet( network_t::NET_TESTNET, &dir ).await.is_err() );
	}
}
