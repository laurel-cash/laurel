/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_import.rs -- a wallet arriving: created, restored from a phrase or a
// viewing key, imported from zcashd keys; another account in one

use std::num::NonZeroU32;
use std::path::{ Path, PathBuf };
use std::sync::atomic::Ordering;

use bip0039::{ English, Mnemonic };
use zingolib::config::{ ClientConfig, WalletConfig };
use zingolib::lightclient::LightClient;
use zingolib::wallet::WalletSettings;
use zeroize::Zeroizing;
use laurel_engine::zcashd::{ read_zcashd_keys, usk_for_sapling_key, ZcashdKeyError };

use crate::w_date::Com_Now;
use crate::w_engine::*;
use crate::w_local::*;
use crate::w_main::{ Com_CleanName, W_AccountNames, W_BuildConfig, W_NetworkDir, W_RestoreSettings };
use crate::w_net::*;
use crate::w_persist::{ W_WriteMeta, W_WriteWallet };
use crate::w_phrase::*;
use crate::w_registry::{ W_Allow, W_Install, W_Recovery, W_Slot, W_Slots };
use crate::w_vault::*;

/*
==================
W_NewWalletDir

Makes a fresh directory for a new wallet. The id is the creation time
in milliseconds, which sorts by age. create_dir fails if the directory
exists, so two callers can never be handed the same one.
==================
*/
pub fn W_NewWalletDir( net: network_t ) -> wresult_t< ( String, PathBuf ) > {
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

pub async fn W_AddWallet< F >( net: network_t, mut meta: meta_t, build: F ) -> wresult_t< String >
where
	F: FnOnce( &Path ) -> wresult_t< ClientConfig >,
{
	meta.network = Some( net );
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
pub async fn W_SameWallet( prints: &std::collections::BTreeSet< Vec< u8 > > ) -> Option< String > {
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
pub async fn W_CheckNetwork( net: network_t ) -> wresult_t< () > {
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

pub fn Com_NetworkIn( net: network_t, offered: &[ network_t ] ) -> wresult_t< () > {
	if ( !offered.contains( &net ) ) {
		return Err( werr_t::WERR_NETWORK_OFF( net.Name() ) );
	}
	Ok( () )
}

pub fn W_NewMeta( name: String, kind: walletKind_t, accounts: u32, backedUp: bool ) -> meta_t {
	meta_t {
		name:		name,
		kind:		kind,
		accounts:	W_AccountNames( accounts ),
		backedUp:	backedUp,
		created:	Com_Now(),
		network:	None,		// W_AddWallet writes the network it adds to
	}
}



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
pub fn Com_BirthdayAhead( birthday: u32, tip: u32 ) -> Option< werr_t > {
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
		E_Fenced( &mut c, fence_t::FENCE_WALLET, async |f| E_Rescan( f, false ).await ).await?;
	} else {
		E_StopAndWait( &mut c ).await;
	}
	Ok( index )
}
