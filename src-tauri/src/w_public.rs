/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_public.rs -- which public coins a payment or a shield spends
//
// Every public address a transaction spends from is tied to the others on
// the chain, for good. So Laurel spends from one address whenever one can
// do it, and from several only when nothing else works, saying so in the
// review (w_engine.rs counts them). These are Laurel's rules, and they live
// here, not in the engine: the engine builds a proposal from the coins it is
// told it may spend (create_send_proposal_with, create_shield_proposal_from)
// and keeps no rule of its own about which.
//
// The coins are read the way the proposal will read them (the backend's own
// coin gather, with the wallet's confirmations), so what is chosen here is
// what the proposal finds. Only this account's coins: the engine would take
// any address it is named, of any account.
//
// These work on the wallet itself; w_engine.rs calls them with the engine
// held (E_ProposeSend, E_ProposeShield), which is also where a proposal is
// stored and sent.

use std::collections::BTreeMap;

use pepper_sync::wallet::KeyIdInterface as _;
use zcash_address::ZcashAddress;
use zcash_client_backend::data_api::error::Error;
use zcash_client_backend::data_api::locking::LockFilter;
use zcash_client_backend::data_api::wallet::input_selection::{ LockedInputPolicy, SpendPolicy, TransparentSpendPolicy };
use zcash_client_backend::data_api::wallet::{ ConfirmationsPolicy, TargetHeight };
use zcash_client_backend::data_api::{ CoinbaseFilter, InputSource as _, MaxSpendMode, TargetValue };
use zcash_client_backend::fees::StandardFeeRule;
use zcash_client_backend::wallet::WalletTransparentOutput;
use zcash_protocol::consensus::Parameters as _;
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::{ BalanceError, Zatoshis };
use zcash_transparent::address::TransparentAddress;
use zingolib::data::proposal::{ ProportionalFeeProposal, ProportionalFeeShieldProposal };
use zingolib::data::receivers::{ transaction_request_from_receivers, Receiver };
use zingolib::wallet::error::{ ProposeSendError, ProposeShieldError, WalletError };
use zingolib::wallet::keys::transparent_address_from_encoded;
use zingolib::wallet::LightWallet;
use zip32::AccountId;
use zip321::TransactionRequest;
use zcash_keys::encoding::AddressCodec as _;

use crate::w_local::{ publicHeld_t, werr_t, wresult_t };
use crate::w_net::engineResult_t;

// how many times everything-from-public is asked for, the first included:
// the fee is priced after the amount, so each answer of "short by this
// much" lowers the amount once (the engine's own send-all does the same)
const SEND_ALL_ATTEMPTS: u32 = 4;

/*
==================
W_PublicCoins

The account's spendable public coins, as a proposal would gather them:
confirmed as deep as the wallet asks, not locked, on its own addresses.
None before the chain's height is known.
==================
*/
fn W_PublicCoins( wallet: &LightWallet, account: AccountId, which: CoinbaseFilter ) -> Result< Vec< WalletTransparentOutput< AccountId > >, WalletError > {
	let Some( tip ) = wallet.sync_state.last_known_chain_height() else {
		return Ok( vec![] );
	};
	wallet.select_spendable_transparent_outputs(
		account,
		TargetHeight::from( tip + 1 ),
		ConfirmationsPolicy::new_symmetrical( wallet.wallet_settings.min_confirmations, false ),
		which,
		None,
		TargetValue::AllFunds( MaxSpendMode::MaxSpendable ),
		usize::MAX,
		&StandardFeeRule::Zip317,
		LockFilter::Policy( &LockedInputPolicy::Exclude ),
	)
}

/*
==================
W_PublicBalances

The account's public addresses that hold spendable coins, with what each
holds, most first
==================
*/
pub fn W_PublicBalances( wallet: &LightWallet, account: AccountId ) -> Result< Vec< ( TransparentAddress, u64 ) >, WalletError > {
	let mut held: BTreeMap< TransparentAddress, u64 > = BTreeMap::new();
	for coin in W_PublicCoins( wallet, account, CoinbaseFilter::AllTransparentOutputs )? {
		let sum = held.entry( *coin.recipient_address() ).or_default();
		*sum = sum.saturating_add( u64::from( coin.value() ) );		// a lying server can't overflow it
	}
	let mut held: Vec< _ > = held.into_iter().collect();
	held.sort_by( |( a, x ), ( b, y )| y.cmp( x ).then( a.cmp( b ) ) );
	Ok( held )
}

/*
==================
W_PublicHeld / Com_HeldAt

What W_PublicBalances says, as the ui shows it: each address written
out. And the other way: an address the ui names, read back, if this
account holds money there now
==================
*/
pub fn W_PublicHeld( wallet: &LightWallet, account: AccountId ) -> wresult_t< Vec< publicHeld_t > > {
	let chain = wallet.chain_type();
	Ok( W_PublicBalances( wallet, account ).engine()?
		.into_iter()
		.map( |( address, zats )| publicHeld_t { address: address.encode( &chain ), zats: zats } )
		.collect() )
}

pub fn Com_HeldAt( wallet: &LightWallet, account: AccountId, address: &str ) -> wresult_t< TransparentAddress > {
	let net = wallet.chain_type().network_type();
	let address = transparent_address_from_encoded( net, address ).map_err( |_| werr_t::WERR_NOT_HELD_HERE )?;
	let held = W_PublicBalances( wallet, account ).engine()?;
	if ( !held.iter().any( |( a, _ )| *a == address ) ) {
		return Err( werr_t::WERR_NOT_HELD_HERE );
	}
	Ok( address )
}

/*
==================
Com_PaysUnified

Whether any payment is to a unified address: the only kind the change's
memo records, for the wallet's own history. A public payment to none (a
public or an exchange-only address) has nothing to record, and the memo
alone would keep an empty private output in the transaction: a fee for
nothing, and a mark of this wallet on a public payment.
==================
*/
fn Com_PaysUnified( wallet: &LightWallet, request: &TransactionRequest ) -> bool {
	let net = wallet.chain_type().network_type();
	request.payments().values().any( |payment| matches!(
		payment.recipient_address().clone().convert_if_network::< zcash_keys::address::Address >( net ),
		Ok( zcash_keys::address::Address::Unified( _ ) )
	) )
}

/*
==================
W_PayFromPublic

A payment from public money alone, tying together as few of the account's
public addresses as it can. Each address that alone holds the amount is
tried, smallest first (the fee may still fall short on one); only when
none can pay it alone are coins gathered across addresses.
==================
*/
pub fn W_PayFromPublic( wallet: &mut LightWallet, request: TransactionRequest, account: AccountId ) -> Result< ProportionalFeeProposal, ProposeSendError > {
	let held = W_PublicBalances( wallet, account ).map_err( |e| ProposeSendError::Proposal( Error::DataSource( e ) ) )?;
	let wanted = request.total().ok().flatten().map_or( 0, u64::from );
	let record = Com_PaysUnified( wallet, &request );

	let mut alone: Vec< _ > = held.into_iter().filter( |( _, sum )| *sum >= wanted ).collect();
	alone.sort_by_key( |( address, sum )| ( *sum, *address ) );
	for ( address, _ ) in alone {
		let one = SpendPolicy::shielded_pools( [] ).with_transparent( TransparentSpendPolicy::from_one_address( address ) );
		match wallet.create_send_proposal_with( request.clone(), account, &one, record ) {
			Err( ProposeSendError::Proposal( Error::InsufficientFunds { .. } ) ) => continue,
			result => return result,
		}
	}
	let any = SpendPolicy::shielded_pools( [] ).with_transparent( TransparentSpendPolicy::any_account_addr() );
	wallet.create_send_proposal_with( request, account, &any, record )
}

/*
==================
W_PayAllFromPublic

Everything public, less the fee, to one address. The backend's own
"send everything" is for private money only, so this asks for every
public coin's worth and lets each "short by this much" lower the amount.
It spends every address that holds anything: that is what was asked.
==================
*/
pub fn W_PayAllFromPublic( wallet: &mut LightWallet, to: ZcashAddress, memo: Option< MemoBytes >, account: AccountId ) -> Result< ProportionalFeeProposal, ProposeSendError > {
	if ( wallet.sync_state.last_known_chain_height().is_none() ) {
		return Err( ProposeSendError::Proposal( Error::ScanRequired ) );
	}
	// a coinbase coin can only be shielded, never paid out
	let coins = W_PublicCoins( wallet, account, CoinbaseFilter::NonCoinbaseOnly ).map_err( |e| ProposeSendError::Proposal( Error::DataSource( e ) ) )?;
	// coins a server reported past all the money there is are an error, never a crash
	let mut amount = coins.iter().try_fold( Zatoshis::ZERO, |sum, coin| sum + coin.value() )
		.ok_or( ProposeSendError::Proposal( Error::BalanceError( BalanceError::Overflow ) ) )?;

	let request = |amount: Zatoshis| transaction_request_from_receivers( vec![ Receiver { recipient_address: to.clone(), amount: amount, memo: memo.clone() } ] );
	let mut attempt = W_PayFromPublic( wallet, request( amount )?, account );
	for _ in 0..SEND_ALL_ATTEMPTS {
		let Err( ProposeSendError::Proposal( Error::InsufficientFunds { required, available } ) ) = &attempt else {
			return attempt;
		};
		// short by the fee: ask for that much less. Nothing short, or nothing left to ask for: the refusal stands
		let short = ( *required - *available ).filter( |short| *short > Zatoshis::ZERO );
		let Some( less ) = short.and_then( |short| amount - short ).filter( |less| *less > Zatoshis::ZERO ) else {
			return attempt;
		};
		amount = less;
		attempt = W_PayFromPublic( wallet, request( amount )?, account );
	}
	attempt
}

/*
==================
W_ShieldPublic

A shield of one public address: the one holding the most, or the next if
its coins don't cover the fee; the others wait for a shield of their own.
When no address pays its own fee they go together, so small amounts
aren't stuck (the review says it ties them).

When none of the account's own receiving addresses holds anything the
coin gather offers (money left at a one-time address of a two-step
payment, say), every address of this account is asked together. Never
another account's: the engine's own shield takes every address in the
wallet, and would move a second account's public money into this one.
==================
*/
pub fn W_ShieldPublic( wallet: &mut LightWallet, account: AccountId ) -> Result< ProportionalFeeShieldProposal, ProposeShieldError > {
	let holding: Vec< TransparentAddress > = W_PublicBalances( wallet, account ).map_err( |e| ProposeShieldError::Component( Error::DataSource( e ) ) )?
		.into_iter().map( |( address, _ )| address ).collect();
	for address in &holding {
		if let Ok( proposal ) = wallet.create_shield_proposal_from( account, &[ *address ] ) {
			return Ok( proposal );
		}
	}
	if ( !holding.is_empty() ) {
		return wallet.create_shield_proposal_from( account, &holding );
	}

	let net = wallet.chain_type().network_type();
	let mine = wallet.transparent_addresses().iter()
		.filter( |( id, _ )| id.account_id() == account )
		.map( |( _, address )| transparent_address_from_encoded( net, address ) )
		.collect::< Result< Vec< _ >, _ > >()?;
	wallet.create_shield_proposal_from( account, &mine )
}

#[cfg( test )]
mod tests {
	use super::*;

	use std::collections::BTreeSet;

	use zingolib::config::{ ChainType, WalletConfig };
	use zingolib::wallet::WalletSettings;

	use crate::w_test::Test_PublicWallet;

	const A: AccountId = AccountId::ZERO;

	/*
	==================
	Test_OutsideAddress / Test_OutsideUnified

	Somebody else's addresses to pay, public and unified: the 24-word test
	phrase's, a wallet that isn't the one under test
	==================
	*/
	fn Test_Outsider() -> LightWallet {
		LightWallet::new( ChainType::Testnet, WalletConfig::MnemonicPhrase {
			mnemonic_phrase:	crate::w_test::TEST_WORDS_24.to_string(),
			no_of_accounts:		std::num::NonZeroU32::MIN,
			birthday:			3_000_000,
			wallet_settings:	WalletSettings::default(),
		} ).unwrap()
	}

	fn Test_OutsideAddress() -> zcash_address::ZcashAddress {
		let mut outsider = Test_Outsider();
		if ( outsider.transparent_addresses().is_empty() ) {
			outsider.generate_transparent_address( zip32::AccountId::ZERO, false ).unwrap();
		}
		zcash_address::ZcashAddress::try_from_encoded( outsider.transparent_addresses().values().next().unwrap() ).unwrap()
	}

	fn Test_OutsideUnified() -> zcash_address::ZcashAddress {
		let mut outsider = Test_Outsider();
		let ( _, unified ) = outsider.generate_unified_address( zingolib::wallet::keys::unified::ReceiverSelection::all_shielded(), zip32::AccountId::ZERO ).unwrap();
		zcash_address::ZcashAddress::try_from_encoded( &unified.encode( &outsider.chain_type() ) ).unwrap()
	}

	fn Pay( zats: u64 ) -> TransactionRequest {
		transaction_request_from_receivers( vec![ Receiver { recipient_address: Test_OutsideAddress(), amount: Zatoshis::const_from_u64( zats ), memo: None } ] ).unwrap()
	}

	fn Addresses< N >( coins: &[ WalletTransparentOutput< N > ] ) -> BTreeSet< TransparentAddress > {
		coins.iter().map( |c| *c.recipient_address() ).collect()
	}

	fn Sum< N >( coins: &[ WalletTransparentOutput< N > ] ) -> u64 {
		coins.iter().map( |c| u64::from( c.value() ) ).sum()
	}

	// when one public address holds the whole payment, only that address is
	// spent: the payment doesn't tie the account's addresses together
	#[test]
	fn a_payment_from_public_spends_one_address_when_one_is_enough() {
		let mut wallet = Test_PublicWallet( 1, &[ ( 0, 0, 200_000 ), ( 0, 1, 300_000 ), ( 0, 1, 50_000 ) ] );
		let proposal = W_PayFromPublic( &mut wallet, Pay( 100_000 ), A ).unwrap();
		let inputs = proposal.steps().first().transparent_inputs();
		assert_eq!( Addresses( inputs ).len(), 1, "one address pays it alone" );
		assert_eq!( Sum( inputs ), 200_000, "the smallest address that covers it" );
		assert!( proposal.steps().first().shielded_inputs().is_none(), "nothing private spent" );
	}

	#[test]
	fn a_payment_from_public_gathers_across_addresses_only_when_it_must() {
		let mut wallet = Test_PublicWallet( 1, &[ ( 0, 0, 200_000 ), ( 0, 1, 300_000 ) ] );
		let proposal = W_PayFromPublic( &mut wallet, Pay( 400_000 ), A ).unwrap();
		assert_eq!( Addresses( proposal.steps().first().transparent_inputs() ).len(), 2 );
	}

	// everything public: every coin less the fee, nothing left over, and no
	// empty private output paid for (a public payment to a public address
	// carries no change memo)
	#[test]
	fn everything_from_public_empties_it() {
		let mut wallet = Test_PublicWallet( 1, &[ ( 0, 0, 200_000 ), ( 0, 0, 300_000 ) ] );
		let proposal = W_PayAllFromPublic( &mut wallet, Test_OutsideAddress(), None, A ).unwrap();
		let step = proposal.steps().first();
		let paid: u64 = step.transaction_request().payments().values().filter_map( |p| p.amount() ).map( u64::from ).sum();
		let fee = u64::from( step.balance().fee_required() );
		assert_eq!( paid + fee, 500_000, "every public coin, less the fee" );
		assert!( step.balance().proposed_change().is_empty(), "nothing left over" );
		assert_eq!( fee, 10_000, "two public inputs, one public output: ZIP 317's two grace actions" );
		assert!( step.shielded_inputs().is_none(), "nothing private spent" );
	}

	#[test]
	fn only_a_unified_recipient_is_recorded_in_the_change() {
		let wallet = Test_PublicWallet( 1, &[] );
		assert!( !Com_PaysUnified( &wallet, &Pay( 1_000 ) ), "a public address: nothing to record" );
		let unified = Test_OutsideUnified();
		let request = transaction_request_from_receivers( vec![ Receiver { recipient_address: unified, amount: Zatoshis::const_from_u64( 1_000 ), memo: None } ] ).unwrap();
		assert!( Com_PaysUnified( &wallet, &request ) );
	}

	// a shield takes one public address, the one holding the most, so a
	// shield never ties the account's addresses together; the other waits
	#[test]
	fn a_shield_takes_one_public_address_at_a_time() {
		let mut wallet = Test_PublicWallet( 1, &[ ( 0, 0, 200_000 ), ( 0, 1, 300_000 ), ( 0, 1, 100_000 ) ] );
		let held = W_PublicBalances( &wallet, A ).unwrap();
		assert_eq!( held.iter().map( |( _, sum )| *sum ).collect::< Vec< _ > >(), vec![ 400_000, 200_000 ], "most first" );

		let proposal = W_ShieldPublic( &mut wallet, A ).unwrap();
		let inputs = proposal.steps().first().transparent_inputs();
		assert_eq!( Addresses( inputs ), BTreeSet::from( [ held[0].0 ] ), "one address per shield: the one holding the most" );
		assert_eq!( Sum( inputs ), 400_000, "all of it" );
	}

	// addresses that can't each pay their own fee are shielded together
	// rather than left stuck: a one-coin shield's fee is 15_000, a two-coin
	// shield's 20_000
	#[test]
	fn a_shield_gathers_addresses_only_when_none_pays_its_fee_alone() {
		let mut wallet = Test_PublicWallet( 1, &[ ( 0, 0, 12_000 ), ( 0, 1, 12_000 ) ] );
		let proposal = W_ShieldPublic( &mut wallet, A ).unwrap();
		assert_eq!( Addresses( proposal.steps().first().transparent_inputs() ).len(), 2, "both, since neither pays its fee alone" );
	}

	// a second account's public money is its own: shielding the first never
	// takes it, though the engine, named that address, would
	#[test]
	fn a_shield_never_takes_another_accounts_public_money() {
		let second = AccountId::try_from( 1 ).unwrap();
		let mut wallet = Test_PublicWallet( 2, &[ ( 1, 0, 300_000 ) ] );
		assert!( W_PublicBalances( &wallet, A ).unwrap().is_empty() );
		assert!( W_ShieldPublic( &mut wallet, A ).is_err(), "the first account has nothing to shield" );

		let theirs = W_PublicBalances( &wallet, second ).unwrap()[0].0;
		assert!( wallet.create_shield_proposal_from( A, &[ theirs ] ).is_ok(), "the engine takes any address it is named: keeping accounts apart is this file's" );

		let proposal = W_ShieldPublic( &mut wallet, second ).unwrap();
		assert_eq!( Sum( proposal.steps().first().transparent_inputs() ), 300_000, "the second account shields its own" );
	}

	// what the ui lists is each address written out, most first; an address
	// it names back is taken only if this account holds money there now:
	// the engine itself would shield any address named (above)
	#[test]
	fn a_named_address_is_taken_only_if_this_account_holds_money_there() {
		let second = AccountId::try_from( 1 ).unwrap();
		let wallet = Test_PublicWallet( 2, &[ ( 0, 0, 200_000 ), ( 0, 1, 300_000 ), ( 1, 0, 50_000 ) ] );
		let listed = W_PublicHeld( &wallet, A ).unwrap();
		assert_eq!( listed.iter().map( |h| h.zats ).collect::< Vec< _ > >(), vec![ 300_000, 200_000 ], "this account's, most first" );

		let held = W_PublicBalances( &wallet, A ).unwrap();
		assert_eq!( Com_HeldAt( &wallet, A, &listed[1].address ).unwrap(), held[1].0, "read back as the address it was" );

		let theirs = &W_PublicHeld( &wallet, second ).unwrap()[0].address;
		assert!( matches!( Com_HeldAt( &wallet, A, theirs ), Err( werr_t::WERR_NOT_HELD_HERE ) ), "another account's" );
		assert!( matches!( Com_HeldAt( &wallet, A, "t1notanaddress" ), Err( werr_t::WERR_NOT_HELD_HERE ) ), "not an address" );

		let empty = Test_PublicWallet( 1, &[ ( 0, 0, 200_000 ) ] );
		let unused = &W_PublicHeld( &wallet, A ).unwrap()[0].address;
		assert!( matches!( Com_HeldAt( &empty, A, unused ), Err( werr_t::WERR_NOT_HELD_HERE ) ), "one of this account's, holding nothing" );
	}

	#[test]
	fn a_payment_from_public_never_spends_another_accounts_coins() {
		let mut wallet = Test_PublicWallet( 2, &[ ( 1, 0, 300_000 ) ] );
		assert!( W_PayFromPublic( &mut wallet, Pay( 100_000 ), A ).is_err() );
		assert!( W_PayAllFromPublic( &mut wallet, Test_OutsideAddress(), None, A ).is_err() );
	}
}
