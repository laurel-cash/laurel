/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_addr.rs -- addresses to receive money at, per account
//
// The shielded address is a unified address with a receiver for each
// shielded part the keys have (W_Parts): Orchard and Sapling, so a payer
// that can pay only one of them still can. What lands on the Orchard
// receiver is carried into Ironwood by the protocol. zingolib's own first
// address holds Orchard alone, so it is never the one given out. Which
// parts the keys have is read from them, never guessed from a failure:
// a key with Orchard alone gives Orchard alone, and one with Sapling
// alone (an older viewing key) has one shielded address, its Sapling
// one, on both sides. A fresh one can be made at any time, so each payer
// can get their own and payments can't be linked by address.
//
// The Sapling address is Sapling alone, for the wallets and exchanges
// that can't pay a unified address yet. It has its own index, so its
// receiver is not the one inside the unified address: whoever is given one
// can't link it to the other. It can be made fresh too.
//
// The transparent address is public, like a bitcoin address, for the
// exchanges that can't send to shielded ones. Each account has one, given
// out every time and never replaced: Laurel leaves no gap of unused
// addresses for a wallet restored elsewhere to stop at (W_RestoreSettings
// is how far Laurel itself looks when a phrase comes from elsewhere).

use std::collections::BTreeSet;

use pepper_sync::keys::transparent::TransparentScope;
use pepper_sync::wallet::KeyIdInterface;
use zcash_keys::address::UnifiedAddress;
use zcash_protocol::consensus::Parameters;
use zingolib::wallet::keys::unified::ReceiverSelection;
use zingolib::wallet::LightWallet;
use zip32::AccountId;

use crate::w_local::*;
use crate::w_engine::{ E_ViewKeyOf, E_Write };
use crate::w_main::{ W_AccountOf, W_Slot };
use crate::w_net::engineResult_t;

const SAPLING_RECEIVERS: ReceiverSelection = ReceiverSelection { orchard: false, sapling: true };


/*
==================
W_Receive

The account's current addresses, making any that don't exist yet.
fresh makes that address new even if one exists.
==================
*/
pub async fn W_Receive( id: &str, account: u32, fresh: Option< freshAddress_t > ) -> wresult_t< receive_t > {
	let slot = W_Slot( id ).await?;
	let ( accountId, wallet ) = {
		let s = slot.read().await;
		crate::w_main::W_Allow( s.meta.kind, walletAct_t::WA_RECEIVE )?;
		let accountId = W_AccountOf( &s, account )?;
		if ( fresh.is_none() ) {
			if let Some( r ) = s.cache.lock().unwrap().receive.get( &account ) {
				return Ok( r.clone() );
			}
		}
		( accountId, s.wallet.clone() )
	};

	let r = W_Addresses( &mut *E_Write( &wallet ).await?, accountId, fresh )?;
	slot.read().await.cache.lock().unwrap().receive.insert( account, r.clone() );
	Ok( r )
}

/*
==================
W_Request

A payment request for this account: its own current address, private,
Sapling or public, with the amount and an optional memo (W_RequestUri).
The ui never hands in an address, so a request can't point anywhere else.
==================
*/
pub async fn W_Request( id: &str, account: u32, to: addressKind_t, amount: u64, memo: Option< String > ) -> wresult_t< String > {
	let net = w_registry.read().await.network;
	let r = W_Receive( id, account, None ).await?;
	let address = match to {
		addressKind_t::AK_PRIVATE	=> r.shielded,
		addressKind_t::AK_SAPLING	=> r.sapling.ok_or( werr_t::WERR_NO_SAPLING_ADDRESS )?,
		addressKind_t::AK_PUBLIC	=> r.transparent.ok_or( werr_t::WERR_NO_PUBLIC_ADDRESS )?,
	};
	crate::w_scan::W_RequestUri( net, &address, amount, memo )
}

/*
==================
W_PrimeCache

Fills the cache with what never needs a network: every account's
addresses, and where the wallet begins. The caller brings the wallet:
when it opens, before sync starts, or after adding an account.
==================
*/
pub fn W_PrimeCache( cache: &std::sync::Mutex< slotCache_t >, accounts: u32, wallet: &mut LightWallet ) {
	{
		let mut c = cache.lock().unwrap();
		c.birthdayHeight	= u32::from( wallet.birthday() );
		c.fingerprint		= W_Fingerprint( wallet );
		c.wordsPrint		= W_WordsPrint( wallet );
	}
	for i in 0..accounts {
		let Ok( accountId ) = AccountId::try_from( i ) else {
			continue;
		};
		match W_Addresses( wallet, accountId, None ) {
			Ok( r ) => { cache.lock().unwrap().receive.insert( i, r ); }
			Err( e ) => log::warn!( "W_PrimeCache: account {i}: {}", e.LogText() ),
		}
	}
}

/*
==================
W_Fingerprint

Every account's viewing keys, each part apart (Orchard, Sapling,
transparent). The same keys added twice would run two engines over one
set of coins, each spending what the other doesn't know is spent, and
show the money twice. Two wallets that share any part are one wallet
(W_SameWallet): the same phrase, a viewing key of any of its accounts
(a viewing key's first account is whichever account it was exported
from), or a zcashd key already in it.
==================
*/
pub fn W_Fingerprint( wallet: &LightWallet ) -> BTreeSet< Vec< u8 > > {
	let mut prints = BTreeSet::new();
	for account in wallet.unified_key_store.keys() {
		let Some( ufvk ) = E_ViewKeyOf( wallet, *account ) else {
			continue;		// no keys to see with: nothing to share
		};
		if let Some( k ) = ufvk.orchard() {
			prints.insert( [ b"orchard".as_slice(), &k.to_bytes() ].concat() );
		}
		if let Some( k ) = ufvk.sapling() {
			prints.insert( [ b"sapling".as_slice(), &k.to_bytes() ].concat() );
		}
		if let Some( k ) = ufvk.p2pkh() {
			prints.insert( [ b"transparent".as_slice(), &k.serialize() ].concat() );
		}
	}
	prints
}

/*
==================
W_WordsPrint

The recovery words alone, hashed one way: two wallets with the same
print were made from the same words, with different passphrases (the
same passphrase too would be the same wallet, W_Fingerprint). The words
hold at least 128 bits, so the print can't be walked back to them.
==================
*/
pub fn W_WordsPrint( wallet: &LightWallet ) -> Option< [ u8; 32 ] > {
	let words = zeroize::Zeroizing::new( wallet.mnemonic_phrase()? );
	crate::w_vault::Com_Hash( b"LaurelWordsPrint", 32, words.as_bytes() ).try_into().ok()
}

/*
==================
W_Parts

The shielded parts this account's keys have, read from its viewing key:
what its addresses can hold a receiver for
==================
*/
fn W_Parts( wallet: &LightWallet, accountId: AccountId ) -> ReceiverSelection {
	let key = E_ViewKeyOf( wallet, accountId );
	ReceiverSelection {
		orchard:	key.as_ref().is_some_and( |k| k.orchard().is_some() ),
		sapling:	key.as_ref().is_some_and( |k| k.sapling().is_some() ),
	}
}

/*
==================
W_Unified

The account's newest unified address holding exactly these receivers,
or a new one when there is none, or when renew. zingolib's first address
(Orchard alone) is never the one for Orchard and Sapling.
==================
*/
fn W_Unified( wallet: &mut LightWallet, accountId: AccountId, want: ReceiverSelection, renew: bool ) -> wresult_t< ( u32, UnifiedAddress ) > {
	let newest = wallet.unified_addresses().iter()
		.filter( |( aid, ua )| aid.account_id == accountId && ua.has_orchard() == want.orchard && ua.sapling().is_some() == want.sapling )
		.max_by_key( |( aid, _ )| aid.address_index )
		.map( |( aid, ua )| ( aid.address_index, ua.clone() ) );
	match newest.filter( |_| !renew ) {
		Some( found ) => Ok( found ),
		None => wallet.generate_unified_address( want, accountId ).engine().map( |( aid, ua )| ( aid.address_index, ua ) ),
	}
}

// a unified address's Sapling receiver, written as a Sapling address ("zs..."): what a payer
// that can't pay a unified address reads
fn W_SaplingText( wallet: &LightWallet, ua: &UnifiedAddress ) -> Option< String > {
	let hrp = zcash_address::constants::hrp_sapling_payment_address( wallet.chain_type().network_type() );
	ua.sapling().map( |pa| zcash_keys::encoding::encode_payment_address( hrp, pa ) )
}

/*
==================
W_Addresses

The account's current addresses, making any that don't exist yet.
fresh makes that address new even if one exists.
==================
*/
fn W_Addresses( wallet: &mut LightWallet, accountId: AccountId, fresh: Option< freshAddress_t > ) -> wresult_t< receive_t > {
	let chain = wallet.chain_type();
	let parts = W_Parts( wallet, accountId );

	// the Sapling address: Sapling alone, at its own index; with no Orchard it is
	// also the private one, so making either new makes it new
	let saplingNew = fresh == Some( freshAddress_t::FA_SAPLING ) || ( fresh == Some( freshAddress_t::FA_PRIVATE ) && !parts.orchard );
	let sapling = match parts.sapling {
		true	=> Some( W_Unified( wallet, accountId, SAPLING_RECEIVERS, saplingNew )? ),
		false	=> None,
	};
	if ( fresh == Some( freshAddress_t::FA_SAPLING ) && sapling.is_none() ) {
		return Err( werr_t::WERR_NO_SAPLING_ADDRESS );
	}

	// the private address: every shielded part the keys have
	let ( index, private ) = match ( parts.orchard, &sapling ) {
		( true, _ )				=> W_Unified( wallet, accountId, parts, fresh == Some( freshAddress_t::FA_PRIVATE ) )?,
		( false, Some( s ) )	=> s.clone(),
		( false, None )			=> return Err( werr_t::WERR_NO_SHIELDED_KEYS ),
	};
	let sapling = sapling.and_then( |( _, ua )| W_SaplingText( wallet, &ua ) );

	// the newest external transparent address, or the first one
	let mut transparent = wallet.transparent_addresses().iter()
		.filter( |( tid, _ )| tid.account_id() == accountId && tid.scope() == TransparentScope::External )
		.max_by_key( |( tid, _ )| tid.address_index() )
		.map( |( _, a )| a.clone() );

	if ( transparent.is_none() ) {
		// a viewing key without transparent keys has none to give; that's fine
		transparent = wallet.generate_transparent_address( accountId, false ).ok()
			.and_then( |( tid, _ )| wallet.transparent_addresses().get( &tid ).cloned() );
	}

	Ok( receive_t {
		shielded:		private.encode( &chain ),
		shieldedIndex:	index,
		sapling:		sapling,
		transparent:	transparent,
	} )
}


#[cfg( test )]
mod tests {
	use super::*;
	use crate::w_test::{ Test_ViewWallet, Test_Wallet };

	fn Account0() -> AccountId {
		AccountId::try_from( 0 ).unwrap()
	}

	// the Sapling receiver inside a unified address, if it has one, written as a Sapling address
	fn SaplingOf( wallet: &LightWallet, unified: &str ) -> Option< String > {
		let chain = wallet.chain_type();
		wallet.unified_addresses().values()
			.find( |ua| ua.encode( &chain ) == unified )
			.and_then( |ua| W_SaplingText( wallet, ua ) )
	}

	// zingolib's first address has Orchard alone; the one shown holds Sapling too,
	// so a payer that can pay only Sapling can pay it
	#[test]
	fn the_private_address_holds_both_receivers() {
		let mut wallet = Test_Wallet();
		let first = W_Addresses( &mut wallet, Account0(), None ).unwrap();
		assert!( SaplingOf( &wallet, &first.shielded ).is_some(), "the private address has a Sapling receiver" );
		let again = W_Addresses( &mut wallet, Account0(), None ).unwrap();
		assert_eq!( again.shielded, first.shielded, "made once, then kept" );
	}

	// a Sapling address a payer can read, kept until asked anew, and not the
	// receiver of any private address (that would link the two)
	#[test]
	fn the_sapling_address_is_its_own() {
		let mut wallet = Test_Wallet();
		let first = W_Addresses( &mut wallet, Account0(), None ).unwrap();
		let sapling = first.sapling.clone().expect( "a seed wallet has a Sapling address" );
		assert!( sapling.starts_with( "ztestsapling1" ), "{sapling}" );

		let again = W_Addresses( &mut wallet, Account0(), None ).unwrap();
		assert_eq!( again.sapling, first.sapling );
		assert_eq!( again.shielded, first.shielded );

		let private = W_Addresses( &mut wallet, Account0(), Some( freshAddress_t::FA_PRIVATE ) ).unwrap();
		for shown in [ &first.shielded, &private.shielded ] {
			let inside = SaplingOf( &wallet, shown ).expect( "a private address holds a Sapling receiver" );
			assert_ne!( inside, sapling );
		}
	}

	// renewing one address leaves the other as it was
	#[test]
	fn a_fresh_address_is_only_the_one_asked_for() {
		let mut wallet = Test_Wallet();
		let first = W_Addresses( &mut wallet, Account0(), None ).unwrap();

		let sapling = W_Addresses( &mut wallet, Account0(), Some( freshAddress_t::FA_SAPLING ) ).unwrap();
		assert_ne!( sapling.sapling, first.sapling );
		assert_eq!( sapling.shielded, first.shielded, "a Sapling-only address is never the newest private one" );

		let private = W_Addresses( &mut wallet, Account0(), Some( freshAddress_t::FA_PRIVATE ) ).unwrap();
		assert_ne!( private.shielded, first.shielded );
		assert_eq!( private.sapling, sapling.sapling );
		assert_eq!( private.transparent, first.transparent, "the public address is never replaced" );
	}

	// an older viewing key with Sapling alone: it can receive, and its one shielded
	// address is the same receiver on both sides, never two linked copies
	#[test]
	fn a_sapling_only_key_still_receives() {
		let mut wallet = Test_ViewWallet( false, true );
		let r = W_Addresses( &mut wallet, Account0(), None ).unwrap();
		let sapling = r.sapling.clone().expect( "its Sapling address" );
		assert_eq!( SaplingOf( &wallet, &r.shielded ), Some( sapling.clone() ) );
		assert_eq!( W_Addresses( &mut wallet, Account0(), None ).unwrap().shielded, r.shielded, "kept" );

		let renewed = W_Addresses( &mut wallet, Account0(), Some( freshAddress_t::FA_PRIVATE ) ).unwrap();
		assert_ne!( renewed.sapling, Some( sapling ), "renewing its one address renews it on both sides" );
		assert_eq!( SaplingOf( &wallet, &renewed.shielded ), renewed.sapling );
	}

	// a key with Orchard alone: an Orchard address, no Sapling one, and asking for one says why
	#[test]
	fn an_orchard_only_key_has_no_sapling_address() {
		let mut wallet = Test_ViewWallet( true, false );
		let r = W_Addresses( &mut wallet, Account0(), None ).unwrap();
		assert_eq!( r.sapling, None );
		assert_eq!( SaplingOf( &wallet, &r.shielded ), None );
		assert!( matches!( W_Addresses( &mut wallet, Account0(), Some( freshAddress_t::FA_SAPLING ) ), Err( werr_t::WERR_NO_SAPLING_ADDRESS ) ) );
	}
}
