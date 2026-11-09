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
