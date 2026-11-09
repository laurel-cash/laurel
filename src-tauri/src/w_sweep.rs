/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_sweep.rs -- moving the money at a single private key (a paper wallet,
// zcashd's dumpprivkey) into an account of this wallet
//
// A key is not a wallet: it is never kept. Its coins are found through the
// server, spent in one transparent transaction to the account's public
// address (the engine's wallet/sweep.rs builds and signs it), and the key
// is dropped. The money then shows as public, ready to shield.
//
// Quote, then confirm, like shielding: W_QuoteSweep says what would move
// and keeps nothing but the intent; W_SweepNow finds the coins again and
// sends only if the numbers are still the ones the person saw.
//
// The key is typed in, so it is a typed secret: no error built here holds
// it, and nothing here logs it.

use std::time::Duration;

use zcash_protocol::consensus::BlockHeight;
use zingo_netutils::lightwallet_protocol::GetAddressUtxosArg;
use zingo_netutils::{ Indexer, TransparentIndexer };
use laurel_engine::sweep::{ build_sweep, plan_sweep, sweep_destination, SweepCoin, SweepError, SweepKey };

use crate::w_addr::W_Receive;
use crate::w_engine::{ E_Intend, E_TakeIntent };
use crate::w_local::*;
use crate::w_net::{ W_Broadcast, W_ChainType, W_Indexer, W_StatusError };


/*
==================
Com_SweepError

What the engine's refusal means to the person. Its words never hold the
key, so they may be shown and logged.
==================
*/
fn Com_SweepError( e: SweepError, net: network_t ) -> werr_t {
	match e {
		SweepError::NotAKey						=> werr_t::WERR_KEY_TYPO,
		SweepError::OtherNetwork( theirs )		=> werr_t::WERR_KEY_NETWORK( theirs, net.Name() ),
		SweepError::Uncompressed				=> werr_t::WERR_KEY_UNCOMPRESSED,
		SweepError::Empty						=> werr_t::WERR_KEY_EMPTY,
		SweepError::TooSmall { total, fee }		=> werr_t::WERR_KEY_TOO_SMALL( total, fee ),
		SweepError::Build( why )				=> werr_t::WERR_ENGINE( why ),
	}
}

/*
==================
W_CheckKey

What a typed key is, before anything is asked of a server: the address
it controls, or what is wrong with it
==================
*/
pub async fn W_CheckKey( text: &str ) -> keyCheck_t {
	if ( text.trim().is_empty() ) {
		return keyCheck_t::EMPTY;
	}
	let net = w_registry.read().await.network;
	let chain = W_ChainType( net );
	match SweepKey::from_wif( &chain, text ) {
		Ok( key )	=> keyCheck_t::OK { address: key.encoded_address( &chain ) },
		Err( e )	=> keyCheck_t::BAD { problem: Com_SweepError( e, net ).UiMessage() },
	}
}

/*
==================
W_Sweep

The sweep as it stands now: the key, the coins at its address, the
account's public address to pay, and the height to build for
==================
*/
struct sweep_t {
	key:		SweepKey,
	coins:		Vec< SweepCoin >,
	to:			String,
	height:		BlockHeight,
	quote:		sweepQuote_t,
}

async fn W_Sweep( id: &str, account: u32, text: &str ) -> wresult_t< sweep_t > {
	let net = w_registry.read().await.network;
	let chain = W_ChainType( net );
	let key = SweepKey::from_wif( &chain, text ).map_err( |e| Com_SweepError( e, net ) )?;
	let from = key.encoded_address( &chain );

	let to = W_Receive( id, account, None ).await?.transparent.ok_or( werr_t::WERR_NO_PUBLIC_ADDRESS )?;
	let toAddr = sweep_destination( &chain, &to ).map_err( |e| Com_SweepError( e, net ) )?;

	let timeout = Duration::from_secs( SERVER_TIMEOUT_SECS );
	let mut indexer = W_Indexer( net ).await?;
	let tip = indexer.get_latest_block( timeout ).await.map_err( W_StatusError )?;
	let found = indexer.get_address_utxos( GetAddressUtxosArg { addresses: vec![ from.clone() ], start_height: 0, max_entries: 0 }, timeout ).await
		.map_err( W_StatusError )?;
	let coins = found.address_utxos.iter()
		.map( |u| SweepCoin::from_utxo( &u.txid, u.index, u.value_zat ) )
		.collect::< Result< Vec< _ >, _ > >()
		.map_err( |e| Com_SweepError( e, net ) )?;

	let height = BlockHeight::from_u32( u32::try_from( tip.height + 1 ).map_err( |_| werr_t::WERR_SERVER( "a tip past u32".to_string() ) )? );
	let plan = plan_sweep( chain, height, &key, &coins, &toAddr ).map_err( |e| Com_SweepError( e, net ) )?;

	Ok( sweep_t {
		key:	key,
		coins:	coins,
		to:		to.clone(),
		height:	height,
		quote:	sweepQuote_t {
			from:	from,
			to:		to,
			coins:	plan.coins as u32,
			left:	plan.left as u32,
			total:	plan.total.into_u64(),
			fee:	plan.fee.into_u64(),
			amount:	plan.amount.into_u64(),
		},
	} )
}

/*
==================
W_QuoteSweep

What sweeping the key would move, under a new intent
==================
*/
pub async fn W_QuoteSweep( id: &str, account: u32, key: &str ) -> wresult_t< quoted_t< sweepQuote_t > > {
	let sweep = W_Sweep( id, account, key ).await?;
	Ok( E_Intend( id, account, sweep.quote ) )
}

/*
==================
W_SweepNow

Takes the intent first (one review, one attempt), finds the coins again,
and sends only what the person saw; new numbers go back for a look
==================
*/
pub async fn W_SweepNow( id: &str, account: u32, key: &str, intent: &str, seen: sweepQuote_t ) -> wresult_t< sweepResult_t > {
	E_TakeIntent( intent, id, account )?;
	let net = w_registry.read().await.network;
	let sweep = W_Sweep( id, account, key ).await?;
	if ( sweep.quote != seen ) {
		return Ok( sweepResult_t::CHANGED { quoted: E_Intend( id, account, sweep.quote ) } );
	}

	let chain = W_ChainType( net );
	let toAddr = sweep_destination( &chain, &sweep.to ).map_err( |e| Com_SweepError( e, net ) )?;
	let signed = build_sweep( chain, sweep.height, &sweep.key, &sweep.coins, &toAddr ).map_err( |e| Com_SweepError( e, net ) )?;

	// unsure: a sweep isn't kept to be sent again, and the coins can be swept only once
	W_Broadcast( net, signed.raw ).await.map_err( |e| match e {
		werr_t::WERR_SENT_UNSURE( d ) => werr_t::WERR_SWEEP_UNSURE( d ),
		other => other,
	} )?;
	Ok( sweepResult_t::SENT { txid: signed.txid.to_string() } )
}

#[cfg( test )]
mod tests {
	use super::*;

	/*
	==================
	no_word_of_a_key_reaches_a_message_or_the_log

	Every refusal of a typed key, as the screen and the log would get it,
	holds nothing of what was typed
	==================
	*/
	#[tokio::test]
	async fn no_word_of_a_key_reaches_a_message_or_the_log() {
		let typed = "cVwrongKeyTextThatShouldNeverBeRepeated1234567890abcdef";
		match W_CheckKey( typed ).await {
			keyCheck_t::BAD { problem } => assert!( !problem.contains( typed ) && !problem.contains( "cVwrong" ), "{problem}" ),
			other => panic!( "a typo was read as {other:?}" ),
		}
		for e in [ SweepError::NotAKey, SweepError::Uncompressed, SweepError::Empty, SweepError::OtherNetwork( "Mainnet" ), SweepError::TooSmall { total: 1, fee: 2 } ] {
			let e = Com_SweepError( e, network_t::NET_TESTNET );
			assert!( !e.UiMessage().contains( "cVwrong" ) && !e.LogText().contains( "cVwrong" ) );
		}
	}

	#[tokio::test]
	async fn nothing_typed_is_not_a_problem_yet() {
		assert!( matches!( W_CheckKey( "  " ).await, keyCheck_t::EMPTY ) );
	}
}
