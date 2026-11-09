/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_send.rs -- paying someone: from an account, from one pool or any
//
// Quote, then confirm, as shielding (w_shield.rs says why): W_QuoteSend
// checks what the person typed (the same reading as Scan, so a wrong
// network or a memo to a public address is caught before anything is
// built) and says what the payment would do, keeping nothing. W_SendNow
// builds it again and sends it at once, only if it matches what the
// person saw: the amount, the fee and the pools it spends.

use zcash_address::ZcashAddress;
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::{ PoolType, ShieldedPool };

use crate::w_engine::{ confirmed_t, fence_t, fenced_t, sendWhat_t, E_Client, E_Fenced, E_Intend, E_ProposeSend, E_Quote, E_SendIfSeen };
use crate::w_local::*;
use crate::w_spendkey::{ Sk_Ensure, Sk_Needed };
use crate::w_main::{ W_Engine, W_Paying };
use crate::w_scan::W_ParseScan;

pub const MEMO_MAX_BYTES: usize = 512;

// payments in one transaction: past this, a list is better split (and a
// transaction grows with each; the network has a size limit)
pub const MAX_PAYMENTS: usize = 20;


/*
==================
Com_PoolOf / Com_PoolFrom

Laurel's pool names and the protocol's, both ways
==================
*/
pub fn Com_PoolOf( p: PoolType ) -> pool_t {
	match p {
		PoolType::Transparent						=> pool_t::POOL_TRANSPARENT,
		PoolType::Shielded( ShieldedPool::Sapling )	=> pool_t::POOL_SAPLING,
		PoolType::Shielded( ShieldedPool::Orchard )	=> pool_t::POOL_ORCHARD,
		PoolType::Shielded( ShieldedPool::Ironwood )	=> pool_t::POOL_IRONWOOD,
	}
}

fn Com_PoolFrom( p: pool_t ) -> wresult_t< PoolType > {
	match p {
		pool_t::POOL_TRANSPARENT	=> Err( werr_t::WERR_FROM_PUBLIC ),
		pool_t::POOL_SAPLING		=> Ok( PoolType::Shielded( ShieldedPool::Sapling ) ),
		pool_t::POOL_ORCHARD		=> Ok( PoolType::Shielded( ShieldedPool::Orchard ) ),
		pool_t::POOL_IRONWOOD		=> Ok( PoolType::Shielded( ShieldedPool::Ironwood ) ),
	}
}

/*
==================
W_CheckMemo

A memo only reaches a private address, and holds 512 bytes; the one rule
for a memo sent and a memo asked for (W_RequestUri)
==================
*/
pub fn W_CheckMemo( memo: &Option< String >, kind: addrKind_t ) -> wresult_t< Option< MemoBytes > > {
	let Some( text ) = memo.as_ref().filter( |m| !m.trim().is_empty() ) else {
		return Ok( None );
	};
	if ( matches!( kind, addrKind_t::ADDR_TRANSPARENT | addrKind_t::ADDR_TEX ) ) {
		return Err( werr_t::WERR_MEMO_PUBLIC );
	}
	if ( text.len() > MEMO_MAX_BYTES ) {
		return Err( werr_t::WERR_MEMO_TOO_LONG( text.len() ) );
	}
	MemoBytes::from_bytes( text.as_bytes() ).map( Some ).map_err( |_| werr_t::WERR_MEMO_TOO_LONG( text.len() ) )
}

/*
==================
W_Payee

One recipient as the engine will pay it: the address read the way Scan
reads one (kind and network, or why not), and its memo checked for it
==================
*/
fn W_Payee( net: network_t, to: &str, memo: &Option< String > ) -> wresult_t< ( scanned_t, ZcashAddress, Option< MemoBytes > ) > {
	let target = W_ParseScan( net, to )?;
	let addr = ZcashAddress::try_from_encoded( &target.address ).map_err( |_| werr_t::WERR_NOT_ZCASH )?;
	let memo = W_CheckMemo( memo, target.kind )?;
	Ok( ( target, addr, memo ) )
}

/*
==================
Com_CheckPays

What a request for several payments must be, before anything is built:
not too many, an amount on every one (Max sends everything to one only)
==================
*/
fn Com_CheckPays( req: &sendRequest_t ) -> wresult_t< () > {
	if ( 1 + req.also.len() > MAX_PAYMENTS ) {
		return Err( werr_t::WERR_TOO_MANY_PAYMENTS( MAX_PAYMENTS as u32 ) );
	}
	if ( req.zats.is_none() && !req.also.is_empty() ) {
		return Err( werr_t::WERR_MAX_ONE );
	}
	if ( req.zats == Some( 0 ) || req.also.iter().any( |p| p.zats == 0 ) ) {
		return Err( werr_t::WERR_NO_AMOUNT );
	}
	Ok( () )
}

/*
==================
W_Propose

Checks the request and has the engine build it; the proposal is left in
the engine for the caller to send or clear. Every payment is checked
alike, and all of them come back in the quote: the review shows each,
and sending compares all of them with what was reviewed (E_SendIfSeen).
==================
*/
pub async fn W_Propose( f: &mut fenced_t< '_ >, account: zip32::AccountId, req: &sendRequest_t ) -> wresult_t< sendQuote_t > {
	let net = w_registry.read().await.network;
	Com_CheckPays( req )?;
	let ( target, to, memo ) = W_Payee( net, &req.to, &req.memo )?;
	let from = req.from.map( Com_PoolFrom ).transpose()?;

	let mut also = vec![];
	let mut pays = vec![];
	for p in &req.also {
		let ( t, addr, m ) = W_Payee( net, &p.to, &p.memo )?;
		also.push( quotedPay_t { to: t.address, kind: t.kind, amount: p.zats, memo: p.memo.clone().filter( |m| !m.trim().is_empty() ) } );
		pays.push( ( addr, p.zats, m ) );
	}
	let what = match req.zats {
		Some( z ) => sendWhat_t::PAY( std::iter::once( ( to, z, memo ) ).chain( pays ).collect() ),
		None => sendWhat_t::ALL( to, memo ),
	};

	let p = E_ProposeSend( f, account, what, from ).await
		.map_err( |e| match ( e, req.from ) {
			( werr_t::WERR_NOT_ENOUGH, Some( _ ) ) => werr_t::WERR_NOT_ENOUGH_POOL,
			( e, _ ) => e,
		} )?;

	Ok( sendQuote_t {
		to:		target.address,
		kind:	target.kind,
		amount:	p.amount,
		fee:	p.fee,
		from:	p.pools.into_iter().map( Com_PoolOf ).collect(),
		steps:	p.steps,
		memo:	req.memo.clone().filter( |m| !m.trim().is_empty() ),
		feeNote:	Com_FeeNote( p.fee, p.amount, p.coins ),
		also:	also,
	} )
}

// a fee is worth a word from this much (ten spending actions under ZIP 317),
// or when it's more than a tenth of what moves
const HIGH_FEE_ZATS: u64	= 50_000;
const MANY_COINS: u32		= 10;

/*
==================
Com_FeeNote

When a fee is high enough to be worth a word before Send, and why. ZIP 317
sets it by rule, so it's never wrong, only surprising: many small coins
each cost a little, and a small payment pays the same minimum as a large
one. The one owner of the rule, for payments and shielding alike.
==================
*/
pub fn Com_FeeNote( fee: u64, amount: u64, coins: u32 ) -> Option< feeNote_t > {
	let large = fee >= HIGH_FEE_ZATS;
	let share = fee.saturating_mul( 10 ) > amount;
	if ( !large && !share ) {
		return None;
	}
	Some( if coins >= MANY_COINS {
		feeNote_t::MANY_COINS { coins: coins }
	} else if share {
		feeNote_t::LARGE_SHARE
	} else {
		feeNote_t::HIGH
	} )
}

/*
==================
W_QuoteSend

What a payment would do, under a new intent. The engine's proposal is
dropped at once, so sync keeps running while the person reads.
==================
*/
pub async fn W_QuoteSend( id: &str, account: u32, req: sendRequest_t ) -> wresult_t< quoted_t< sendQuote_t > > {
	let ( accountId, client, _ ) = W_Engine( id, account ).await?;
	let quote = E_Fenced( &mut *E_Client( &client ).await?, fence_t::FENCE_SCANNED, async |f| E_Quote( f, async |f| W_Propose( f, accountId, &req ).await ).await ).await?;
	Ok( E_Intend( id, account, quote ) )
}

/*
==================
W_SendNow

Takes the intent first (one review, one attempt, whatever happens next:
W_Paying), then builds the payment again, on the chain as it is now, and
sends it in the same hold of the engine, if it is what the person saw.
Sapling's spend key comes before all that: a download that fails leaves
the review as it was, to send again.
==================
*/
pub async fn W_SendNow( id: &str, account: u32, req: sendRequest_t, intent: String, seen: sendQuote_t, repeatId: Option< &str > ) -> wresult_t< sendResult_t > {
	if ( Sk_Needed( &seen.from ) ) {
		crate::w_main::W_Allowed( id, walletAct_t::WA_SPEND ).await?;		// a wallet that can't sign fetches nothing
		Sk_Ensure().await?;
	}
	let ( slot, accountId, client ) = W_Paying( id, account, &intent ).await?;

	let done = E_Fenced( &mut *E_Client( &client ).await?, fence_t::FENCE_SCANNED, async |f| E_SendIfSeen( f, &slot, &seen, async |f| W_Propose( f, accountId, &req ).await ).await ).await;
	// a reminder this pays moves to its next date once the payment is out, or
	// may be: one still due after an unsure send invites paying it twice
	if let Some( r ) = repeatId.filter( |_| Com_PaysReminder( &done ) ) {
		if let Err( e ) = crate::w_repeat::Rp_Done( r ).await {
			log::warn!( "W_SendNow: the reminder stays due: {}", e.LogText() );
		}
	}
	Ok( match done? {
		confirmed_t::SENT( txid ) => {
			// "paid recently" in the address book, for everyone paid
			for to in std::iter::once( &seen.to ).chain( seen.also.iter().map( |p| &p.to ) ) {
				crate::w_contacts::Ct_MarkPaid( to ).await;
			}
			sendResult_t::SENT { txid: txid }
		}
		confirmed_t::CHANGED( quote ) => sendResult_t::CHANGED { quoted: E_Intend( id, account, quote ) },
	} )
}

// whether a send's outcome pays its reminder: sent, perhaps sent, or signed
// and waiting to be sent
fn Com_PaysReminder< Q >( done: &wresult_t< confirmed_t< Q > > ) -> bool {
	matches!( done, Ok( confirmed_t::SENT( _ ) ) | Err( werr_t::WERR_SENT_UNSURE( _ ) | werr_t::WERR_SEND_QUEUED( _ ) ) )
}


#[cfg( test )]
mod tests {
	use super::*;

	#[test]
	fn a_reminder_moves_on_when_its_payment_is_out_or_may_be() {
		assert!( Com_PaysReminder::< () >( &Ok( confirmed_t::SENT( "t".to_string() ) ) ) );
		assert!( Com_PaysReminder::< () >( &Err( werr_t::WERR_SENT_UNSURE( "timeout".to_string() ) ) ) );
		assert!( Com_PaysReminder::< () >( &Err( werr_t::WERR_SEND_QUEUED( "t".to_string() ) ) ) );
		// waiting to be sent is never a Try Again: that would be a second payment
		assert!( !werr_t::WERR_SEND_QUEUED( "t".to_string() ).Info().retry );
		assert!( !werr_t::WERR_SENT_UNSURE( "t".to_string() ).Info().retry );
		assert!( !Com_PaysReminder::< () >( &Ok( confirmed_t::CHANGED( () ) ) ) );
		assert!( !Com_PaysReminder::< () >( &Err( werr_t::WERR_REJECTED( "bad".to_string() ) ) ) );
		assert!( !Com_PaysReminder::< () >( &Err( werr_t::WERR_NOT_ENOUGH ) ) );
	}

	#[test]
	fn memos_only_go_to_private_addresses() {
		assert!( W_CheckMemo( &None, addrKind_t::ADDR_TRANSPARENT ).unwrap().is_none() );
		assert!( W_CheckMemo( &Some( "  ".into() ), addrKind_t::ADDR_TRANSPARENT ).unwrap().is_none() );
		assert!( matches!( W_CheckMemo( &Some( "hi".into() ), addrKind_t::ADDR_TRANSPARENT ), Err( werr_t::WERR_MEMO_PUBLIC ) ) );
		assert!( matches!( W_CheckMemo( &Some( "hi".into() ), addrKind_t::ADDR_TEX ), Err( werr_t::WERR_MEMO_PUBLIC ) ) );
		assert!( W_CheckMemo( &Some( "hi".into() ), addrKind_t::ADDR_UNIFIED ).unwrap().is_some() );
	}

	#[test]
	fn memos_hold_512_bytes() {
		assert!( W_CheckMemo( &Some( "a".repeat( 512 ) ), addrKind_t::ADDR_SAPLING ).is_ok() );
		assert!( matches!( W_CheckMemo( &Some( "a".repeat( 513 ) ), addrKind_t::ADDR_SAPLING ), Err( werr_t::WERR_MEMO_TOO_LONG( 513 ) ) ) );
		// bytes, not characters: 171 three-byte characters are 513 bytes
		assert!( W_CheckMemo( &Some( "€".repeat( 171 ) ), addrKind_t::ADDR_SAPLING ).is_err() );
	}

	#[test]
	fn several_payments_each_have_an_amount_and_max_is_for_one() {
		let pay = |zats: u64| payTo_t { to: "t".into(), zats: zats, memo: None };
		let req = |zats: Option< u64 >, also: Vec< payTo_t >| sendRequest_t { to: "t".into(), zats: zats, memo: None, from: None, also: also };
		assert!( Com_CheckPays( &req( Some( 5 ), vec![ pay( 1 ), pay( 2 ) ] ) ).is_ok() );
		assert!( Com_CheckPays( &req( None, vec![] ) ).is_ok(), "Max to one" );
		assert!( matches!( Com_CheckPays( &req( None, vec![ pay( 1 ) ] ) ), Err( werr_t::WERR_MAX_ONE ) ) );
		assert!( matches!( Com_CheckPays( &req( Some( 5 ), vec![ pay( 0 ) ] ) ), Err( werr_t::WERR_NO_AMOUNT ) ) );
		assert!( matches!( Com_CheckPays( &req( Some( 5 ), vec![ pay( 1 ); MAX_PAYMENTS ] ) ), Err( werr_t::WERR_TOO_MANY_PAYMENTS( _ ) ) ) );
		assert!( Com_CheckPays( &req( Some( 5 ), vec![ pay( 1 ); MAX_PAYMENTS - 1 ] ) ).is_ok(), "exactly the cap" );
	}

	#[test]
	fn public_money_is_shielded_first() {
		assert!( matches!( Com_PoolFrom( pool_t::POOL_TRANSPARENT ), Err( werr_t::WERR_FROM_PUBLIC ) ) );
		for p in [ pool_t::POOL_IRONWOOD, pool_t::POOL_ORCHARD, pool_t::POOL_SAPLING ] {
			assert_eq!( Com_PoolOf( Com_PoolFrom( p ).unwrap() ), p );
		}
	}

	/*
	==================
	a_fee_is_worth_a_word_only_when_it_is

	ZIP 317 sets fees by rule: most are the minimum and say nothing. Many
	small coins, or a fee that's a big share of what moves, get a word
	==================
	*/
	#[test]
	fn a_fee_is_worth_a_word_only_when_it_is() {
		assert_eq!( Com_FeeNote( 10_000, 1_000_000, 1 ), None, "the minimum, on a normal payment" );
		assert_eq!( Com_FeeNote( 60_000, 10_000_000, 12 ), Some( feeNote_t::MANY_COINS { coins: 12 } ) );
		assert_eq!( Com_FeeNote( 10_000, 50_000, 1 ), Some( feeNote_t::LARGE_SHARE ), "a fifth of a small payment" );
		assert_eq!( Com_FeeNote( 50_000, 100_000_000, 2 ), Some( feeNote_t::HIGH ) );
		assert_eq!( Com_FeeNote( 10_000, 100_000, 1 ), None, "exactly a tenth is not more than a tenth" );
	}
}
