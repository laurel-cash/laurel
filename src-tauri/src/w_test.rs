/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_test.rs -- what several modules' tests build the same way, built once

use zingolib::config::{ ChainType, WalletConfig };
use zingolib::wallet::{ LightWallet, WalletSettings };

// bip-39's test vectors, 12 and 24 words: wallets that hold nothing
pub const TEST_WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
pub const TEST_WORDS_24: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
	abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

/*
==================
Test_Wallet

An engine wallet in memory, on testnet, with no file and no server: for
tests that put transactions into it and read them back
==================
*/
/*
==================
Test_ViewWallet

A view-only wallet of the test phrase's first account, with only the
shielded parts asked for: an older viewing key (Sapling alone), or a
newer one without Sapling. Its keys are the test phrase's, re-encoded.
==================
*/
pub fn Test_ViewWallet( orchard: bool, sapling: bool ) -> LightWallet {
	use zcash_address::unified::{ Encoding, Fvk, Revision, Ufvk, Uitem };
	let full = crate::w_engine::E_ViewKeyOf( &Test_Wallet(), zip32::AccountId::ZERO ).unwrap();
	let mut items = vec![];
	if ( orchard ) {
		items.push( Uitem::Data( Fvk::Orchard( full.orchard().unwrap().to_bytes() ) ) );
	}
	if ( sapling ) {
		items.push( Uitem::Data( Fvk::Sapling( full.sapling().unwrap().to_bytes() ) ) );
	}
	let ufvk = Ufvk::try_from_items( Revision::R0, items ).unwrap().encode( &zcash_protocol::consensus::NetworkType::Test );
	LightWallet::new( ChainType::Testnet, WalletConfig::Ufvk {
		ufvk:				ufvk,
		birthday:			3_000_000,
		wallet_settings:	WalletSettings::default(),
	} ).unwrap()
}

pub fn Test_Wallet() -> LightWallet {
	LightWallet::new( ChainType::Testnet, WalletConfig::MnemonicPhrase {
		mnemonic_phrase:	TEST_WORDS.to_string(),
		no_of_accounts:		std::num::NonZeroU32::MIN,
		birthday:			3_000_000,
		wallet_settings:	WalletSettings::default(),
	} ).unwrap()
}

/*
==================
Test_PublicWallet

A wallet of the test phrase with public coins in it, each ( account,
which of its receiving addresses, zatoshis ), confirmed and scanned as a
synced wallet's are: enough to propose a payment or a shield from them
with no server. Proposing wants the chain's height, an anchor (a
checkpoint in each note tree, empty here) and coins confirmed below it.
==================
*/
pub fn Test_PublicWallet( accounts: u32, coins: &[ ( u32, u32, u64 ) ] ) -> LightWallet {
	use pepper_sync::keys::transparent::TransparentScope;
	use pepper_sync::sync::{ ScanPriority, ScanRange };
	use pepper_sync::wallet::{ KeyIdInterface as _, OutputId, SyncState, TransparentCoin, WalletTransaction };
	use shardtree::store::{ Checkpoint, ShardStore as _ };
	use zcash_protocol::consensus::{ BlockHeight, Parameters as _ };
	use zingo_status::confirmation_status::ConfirmationStatus;

	const BIRTHDAY: u32 = 3_000_000;
	let tip = BlockHeight::from_u32( BIRTHDAY + 100 );
	let mut wallet = LightWallet::new( ChainType::Testnet, WalletConfig::MnemonicPhrase {
		mnemonic_phrase:	crate::w_test::TEST_WORDS.to_string(),
		no_of_accounts:		std::num::NonZeroU32::new( accounts ).unwrap(),
		birthday:			BIRTHDAY,
		wallet_settings:	WalletSettings::default(),
	} ).unwrap();
	wallet.sync_state = SyncState::new_for_test( vec![ ScanRange::from_parts( BlockHeight::from_u32( BIRTHDAY )..tip + 1, ScanPriority::Scanned ) ] );
	// a synced wallet has a checkpoint at each recent block: the anchor is a few below the tip (the wallet's confirmations)
	for below in 0..10 {
		wallet.shard_trees.sapling.store_mut().add_checkpoint( tip - below, Checkpoint::tree_empty() ).unwrap();
		wallet.shard_trees.orchard.store_mut().add_checkpoint( tip - below, Checkpoint::tree_empty() ).unwrap();
		wallet.shard_trees.ironwood.store_mut().add_checkpoint( tip - below, Checkpoint::tree_empty() ).unwrap();
	}

	for ( n, ( account, at, zats ) ) in coins.iter().enumerate() {
		let account = zip32::AccountId::try_from( *account ).unwrap();
		// the account's receiving address number `at`, made if it isn't there yet
		let ( key, address ) = loop {
			let have = wallet.transparent_addresses().iter()
				.find( |( id, _ )| id.account_id() == account && id.scope() == TransparentScope::External && id.address_index().index() == *at )
				.map( |( id, address )| ( *id, address.clone() ) );
			match have {
				Some( found )	=> break found,
				None			=> { wallet.generate_transparent_address( account, false ).unwrap(); }
			}
		};
		let script = zingolib::wallet::keys::transparent_address_from_encoded( wallet.chain_type().network_type(), &address ).unwrap().script().into();
		let txid = zcash_protocol::TxId::from_bytes( [ 0xC0 + n as u8; 32 ] );
		let coin = TransparentCoin::new_for_test( OutputId::new( txid, 0 ), key, address, script, zcash_protocol::value::Zatoshis::from_u64( *zats ).unwrap() );
		let mined = ConfirmationStatus::Confirmed( BlockHeight::from_u32( BIRTHDAY + 1 + n as u32 ) );
		wallet.wallet_transactions.insert( txid, WalletTransaction::new_for_test( txid, mined ).with_transparent_coins_for_test( vec![ coin ] ) );
	}
	wallet
}
