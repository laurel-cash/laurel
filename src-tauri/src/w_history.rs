/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_history.rs -- an account's balance over time, for the chart
//
// Built from notes, not from transaction summaries: summaries are per
// wallet, notes know their account. Every note adds its value at the
// moment its transaction happened, and takes it away at the moment the
// transaction that spent it happened. Change comes back as a new note,
// so fees fall out on their own, and the last point always equals the
// account's balance (confirmed plus pending).

use std::collections::{ BTreeMap, BTreeSet, HashMap };

use pepper_sync::wallet::{ IronwoodNote, KeyIdInterface, NoteInterface, OrchardNote, OutgoingNoteInterface, OutputInterface, SaplingNote, TransparentCoin, WalletTransaction };
use zcash_protocol::TxId;
use zcash_protocol::memo::Memo;
use zingo_status::confirmation_status::ConfirmationStatus;
use zingolib::wallet::LightWallet;
use zip32::AccountId;

use crate::w_local::*;
use crate::w_engine::{ E_Read, E_TryRead };
use crate::w_send::Com_PoolOf;
use crate::w_main::{ W_AccountOf, W_Slot };

// (unix seconds, the pool, zats in or out)
type flow_t = ( u32, pool_t, i128 );


/*
==================
Com_TxState

The one reading of the engine's status: all five of its states, each
decided. Reading only "confirmed or not" showed an expired payment as
pending forever, a payment to send again.
==================
*/
pub fn Com_TxState( status: ConfirmationStatus, expiry: u32 ) -> txState_t {
	match status {
		ConfirmationStatus::Confirmed( h )		=> txState_t::CONFIRMED { height: u32::from( h ) },
		ConfirmationStatus::Mempool( _ )
		| ConfirmationStatus::Transmitted( _ )	=> txState_t::PENDING { expiresAt: Some( expiry ).filter( |e| *e > 0 ) },
		ConfirmationStatus::Calculated( _ )		=> txState_t::UNSENT,
		ConfirmationStatus::Failed( _ )			=> txState_t::FAILED,
	}
}

pub fn W_StateOf( tx: &WalletTransaction ) -> txState_t {
	Com_TxState( tx.status(), u32::from( tx.transaction().expiry_height() ) )
}


/*
==================
W_FlowsOf

Every arrival and departure of one pool's outputs for one account. Each
output counts where it sits: a move between pools is a departure from
one and an arrival in the other, and the fee is what arrives nowhere.
==================
*/
fn W_FlowsOf< O: OutputInterface >( wallet: &LightWallet, account: AccountId, pool: pool_t, flows: &mut Vec< flow_t > ) {
	for tx in wallet.wallet_transactions.values() {
		if ( W_StateOf( tx ) == txState_t::FAILED ) {
			continue;		// its outputs never existed, its change included
		}
		for o in O::transaction_outputs( tx ) {
			if ( o.key_id().account_id() != account ) {
				continue;
			}
			flows.push( ( tx.datetime(), pool, o.value() as i128 ) );

			// a spend the wallet no longer knows (expired, dropped) never happened
			if let Some( stx ) = o.spending_transaction().and_then( |t| wallet.wallet_transactions.get( &t ) ) {
				flows.push( ( stx.datetime(), pool, -( o.value() as i128 ) ) );
			}
		}
	}
}

/*
==================
W_Steps

Flows in any order to a running balance, one point per distinct moment:
in each pool, and in all, which is their sum. No pool is ever below
zero (a spend seen before what it spends, by the clock, would be), and
the total is what the pools hold, so the chart's stack and its balance
are one height even then.
==================
*/
fn W_Steps( mut flows: Vec< flow_t > ) -> Vec< balancePoint_t > {
	flows.sort_by_key( |f| f.0 );

	let mut out: Vec< balancePoint_t > = vec![];
	let mut each: [ i128; 4 ] = [ 0; 4 ];		// by W_PoolSlot

	for ( time, pool, delta ) in flows {
		each[W_PoolSlot( pool )] += delta;
		let held = |p: pool_t| each[W_PoolSlot( p )].max( 0 ) as u64;
		let pools = poolZats_t {
			ironwood:		held( pool_t::POOL_IRONWOOD ),
			orchard:		held( pool_t::POOL_ORCHARD ),
			sapling:		held( pool_t::POOL_SAPLING ),
			transparent:	held( pool_t::POOL_TRANSPARENT ),
		};
		let zats = pools.ironwood + pools.orchard + pools.sapling + pools.transparent;

		match out.last_mut() {
			Some( last ) if last.time == time => {
				last.zats = zats;
				last.pools = pools;
			}
			_ => out.push( balancePoint_t { time, zats, pools } ),
		}
	}
	out
}

// a pool's place in W_Steps' running balances
fn W_PoolSlot( pool: pool_t ) -> usize {
	match pool {
		pool_t::POOL_IRONWOOD		=> 0,
		pool_t::POOL_ORCHARD		=> 1,
		pool_t::POOL_SAPLING		=> 2,
		pool_t::POOL_TRANSPARENT	=> 3,
	}
}

/*
==================
W_AccountRead

The one way the ui's per-account reads meet the engine: read the wallet
if it's free; if the engine is mid-batch (holding it across network
requests), the last reading; with none yet, wait for it, but not past
ENGINE_WAIT_SECS. Every fresh reading is kept for next time. The reading
runs inside the map, so no guard lives across an await.
==================
*/
async fn W_AccountRead< T: Clone >(
	id:		&str,
	index:	u32,
	read:	impl Fn( &LightWallet, AccountId ) -> T,
	kept:	impl Fn( &mut slotCache_t ) -> &mut BTreeMap< u32, T >,
) -> wresult_t< T > {
	let slot = W_Slot( id ).await?;
	let ( account, wallet ) = {
		let s = slot.read().await;
		( W_AccountOf( &s, index )?, s.wallet.clone() )
	};

	let value = match E_TryRead( &wallet ).map( |w| read( &w, account ) ) {
		Some( v ) => v,
		None => {
			if let Some( v ) = kept( &mut slot.read().await.cache.lock().unwrap() ).get( &index ).cloned() {
				return Ok( v );
			}
			read( &*E_Read( &wallet ).await?, account )
		}
	};
	kept( &mut slot.read().await.cache.lock().unwrap() ).insert( index, value.clone() );
	Ok( value )
}

fn W_AllFlows( wallet: &LightWallet, account: AccountId ) -> Vec< flow_t > {
	let mut flows = vec![];
	W_FlowsOf::< TransparentCoin >( wallet, account, pool_t::POOL_TRANSPARENT, &mut flows );
	W_FlowsOf::< SaplingNote >( wallet, account, pool_t::POOL_SAPLING, &mut flows );
	W_FlowsOf::< OrchardNote >( wallet, account, pool_t::POOL_ORCHARD, &mut flows );
	W_FlowsOf::< IronwoodNote >( wallet, account, pool_t::POOL_IRONWOOD, &mut flows );
	flows
}

/*
==================
W_BalanceHistory
==================
*/
pub async fn W_BalanceHistory( id: &str, index: u32 ) -> wresult_t< Vec< balancePoint_t > > {
	W_AccountRead( id, index, |w, a| W_Steps( W_AllFlows( w, a ) ), |c| &mut c.history ).await
}


/*
=========================================================================

TRANSACTIONS

=========================================================================
*/

// what one account put into transactions: value spent, and from which pools
type spent_t = HashMap< TxId, ( u64, BTreeSet< pool_t > ) >;

// what one transaction gave one account
#[derive( Default )]
struct received_t {
	value:	u64,
	into:	BTreeSet< pool_t >,
	memo:	Option< String >,
}

fn W_SpentBy< O: OutputInterface >( wallet: &LightWallet, account: AccountId, spent: &mut spent_t ) {
	for tx in wallet.wallet_transactions.values() {
		for o in O::transaction_outputs( tx ) {
			if ( o.key_id().account_id() != account ) {
				continue;
			}
			if let Some( by ) = o.spending_transaction() {
				let e = spent.entry( by ).or_default();
				e.0 += o.value();
				e.1.insert( Com_PoolOf( O::POOL_TYPE ) );
			}
		}
	}
}

fn Com_MemoText( m: &Memo ) -> Option< String > {
	match m {
		Memo::Text( t ) if !t.trim().is_empty() => Some( t.to_string() ),
		_ => None,
	}
}

fn W_ReceivedNotes< N: NoteInterface >( tx: &WalletTransaction, account: AccountId, r: &mut received_t ) {
	for n in N::transaction_outputs( tx ) {
		if ( n.key_id().account_id() == account ) {
			r.value += n.value();
			r.into.insert( Com_PoolOf( N::POOL_TYPE ) );
			if ( r.memo.is_none() ) {
				r.memo = Com_MemoText( n.memo() );
			}
		}
	}
}

fn W_ReceivedCoins( tx: &WalletTransaction, account: AccountId, r: &mut received_t ) {
	for c in tx.transparent_coins() {
		if ( c.key_id().account_id() == account ) {
			r.value += c.value();
			r.into.insert( pool_t::POOL_TRANSPARENT );
		}
	}
}

/*
==================
W_Outgoing

Who this account paid, and the message it sent: the outgoing notes it
can read. Payments to its own addresses aren't "who was paid".
==================
*/
fn W_Outgoing< O: OutgoingNoteInterface >( notes: &[ O ], wallet: &LightWallet, account: AccountId, out: &mut Vec< ( u64, String, Option< String > ) > ) {
	for n in notes {
		if ( n.key_id().account_id() != account ) {
			continue;
		}
		let to = n.encoded_recipient_full_unified_address( &wallet.chain_type() )
			.or_else( || n.encoded_recipient( &wallet.chain_type() ).ok() );
		if let Some( to ) = to {
			out.push( ( n.value(), to, Com_MemoText( n.memo() ) ) );
		}
	}
}

/*
==================
W_Classify

The one rule for what a transaction was, from one account's view:
nothing spent is a receipt; everything back but the fee is a move (a
shield, when public money went private); anything more left is a payment.
Pure, so it's tested on its own.
==================
*/
pub fn W_Classify( spent: u64, received: u64, fee: u64, from: &BTreeSet< pool_t >, into: &BTreeSet< pool_t > ) -> ( txKind_t, u64 ) {
	if ( spent == 0 ) {
		return ( txKind_t::TX_RECEIVED, received );
	}
	let left = spent.saturating_sub( received ).saturating_sub( fee );
	if ( left > 0 ) {
		return ( txKind_t::TX_SENT, left );
	}
	let shield = from.iter().all( |p| *p == pool_t::POOL_TRANSPARENT ) && into.iter().any( |p| *p != pool_t::POOL_TRANSPARENT );
	( if shield { txKind_t::TX_SHIELD } else { txKind_t::TX_MOVE }, received )
}

/*
==================
W_ClassifyFailed

A payment that failed gave its coins back, so what it spent is gone from
the record. What it was: a payment, when it paid anyone else (the amount
it tried to send); a shield, when public coins went in; else a move.
==================
*/
pub fn W_ClassifyFailed( sentToOthers: u64, received: u64, transparentIn: bool ) -> ( txKind_t, u64 ) {
	if ( sentToOthers > 0 ) {
		return ( txKind_t::TX_SENT, sentToOthers );
	}
	( if transparentIn { txKind_t::TX_SHIELD } else { txKind_t::TX_MOVE }, received )
}

pub fn W_ReadTransactions( wallet: &LightWallet, account: AccountId ) -> Vec< historyItem_t > {
	let mut spent = spent_t::new();
	W_SpentBy::< TransparentCoin >( wallet, account, &mut spent );
	W_SpentBy::< SaplingNote >( wallet, account, &mut spent );
	W_SpentBy::< OrchardNote >( wallet, account, &mut spent );
	W_SpentBy::< IronwoodNote >( wallet, account, &mut spent );

	let mut items = vec![];
	for tx in wallet.wallet_transactions.values() {
		let state = W_StateOf( tx );
		let mut r = received_t::default();
		W_ReceivedCoins( tx, account, &mut r );
		W_ReceivedNotes::< SaplingNote >( tx, account, &mut r );
		W_ReceivedNotes::< OrchardNote >( tx, account, &mut r );
		W_ReceivedNotes::< IronwoodNote >( tx, account, &mut r );

		let ( out, from ) = spent.get( &tx.txid() ).cloned().unwrap_or_default();
		if ( out == 0 && r.value == 0 ) {
			continue;		// another account's
		}

		// the fee is this account's only if it paid in
		let fee = if ( out > 0 ) { wallet.calculate_transaction_fee( tx ).ok().map( |z| z.into_u64() ) } else { None };
		let ( kind, amount ) = match state {
			// its spends were given back, so nothing says what it took: what it
			// tried to pay others (the engine's own count), or else what it moved
			txState_t::FAILED => W_ClassifyFailed( tx.total_value_sent(), r.value, tx.transaction().transparent_bundle().is_some_and( |b| !b.vin.is_empty() ) ),
			txState_t::CONFIRMED { .. } | txState_t::PENDING { .. } | txState_t::UNSENT => W_Classify( out, r.value, fee.unwrap_or( 0 ), &from, &r.into ),
		};

		let mut outgoing = vec![];
		if ( kind == txKind_t::TX_SENT ) {
			W_Outgoing( tx.outgoing_sapling_notes(), wallet, account, &mut outgoing );
			W_Outgoing( tx.outgoing_orchard_notes(), wallet, account, &mut outgoing );
			W_Outgoing( tx.outgoing_ironwood_notes(), wallet, account, &mut outgoing );
		}
		// the payment, not the change: the output closest to what left
		outgoing.sort_by_key( |( v, _, _ )| v.abs_diff( amount ) );
		let first = outgoing.into_iter().next();

		items.push( historyItem_t {
			txid:			tx.txid().to_string(),
			time:			tx.datetime(),
			kind:			kind,
			amount:			amount,
			fee:			fee,
			state:			state,
			from:			from.into_iter().collect(),
			into:			r.into.into_iter().collect(),
			counterparty:	first.as_ref().map( |( _, to, _ )| to.clone() ),
			memo:			first.and_then( |( _, _, m )| m ).or( r.memo ),
			note:			None,		// Nt_Attach, when handed out
			category:		None,
		} );
	}

	// newest first, and anything still waiting on the network above everything settled
	items.sort_by( |a, b| b.state.Waiting().cmp( &a.state.Waiting() ).then( b.time.cmp( &a.time ) ) );
	items
}

/*
==================
W_Transactions

An account's transactions, newest first. Like the balance history: the
last reading while the engine is busy, never a wait without a limit.
==================
*/
pub async fn W_Transactions( id: &str, index: u32 ) -> wresult_t< Vec< historyItem_t > > {
	let mut items = W_AccountRead( id, index, W_ReadTransactions, |c| &mut c.transactions ).await?;
	crate::w_notes::Nt_Attach( &mut items ).await;
	Ok( items )
}


#[cfg( test )]
mod tests {
	use super::*;

	const IW: pool_t = pool_t::POOL_IRONWOOD;
	const SAP: pool_t = pool_t::POOL_SAPLING;
	const T: pool_t = pool_t::POOL_TRANSPARENT;

	fn points( p: &[ balancePoint_t ] ) -> Vec< ( u32, u64 ) > {
		p.iter().map( |b| ( b.time, b.zats ) ).collect()
	}

	// the split and the total are one balance: a move shifts the split, the fee alone leaves the total
	#[test]
	fn each_pool_holds_what_sits_in_it() {
		let p = W_Steps( vec![
			( 10, SAP, 1_000 ),							// arrives in Sapling
			( 20, T, 300 ),								// and some in public
			( 30, SAP, -1_000 ), ( 30, IW, 990 ),		// moved to Ironwood, 10 to the fee
			( 40, T, -300 ), ( 40, IW, 290 ),			// shielded, 10 to the fee
		] );
		assert_eq!( points( &p ), vec![ ( 10, 1_000 ), ( 20, 1_300 ), ( 30, 1_290 ), ( 40, 1_280 ) ] );
		assert_eq!( p[1].pools, poolZats_t { sapling: 1_000, transparent: 300, ..Default::default() } );
		assert_eq!( p[2].pools, poolZats_t { ironwood: 990, transparent: 300, ..Default::default() } );
		assert_eq!( p[3].pools, poolZats_t { ironwood: 1_280, ..Default::default() } );
		for b in &p {
			let sum = b.pools.ironwood + b.pools.orchard + b.pools.sapling + b.pools.transparent;
			assert_eq!( sum, b.zats, "at {}: the pools add up to the balance", b.time );
		}
	}

	// a spend seen before what it spends: that pool holds nothing yet, and the total is what the pools hold
	#[test]
	fn no_pool_below_zero() {
		let p = W_Steps( vec![ ( 10, SAP, -5 ), ( 10, IW, 20 ) ] );
		assert_eq!( p[0].pools, poolZats_t { ironwood: 20, ..Default::default() } );
		assert_eq!( p[0].zats, 20 );
	}

	#[test]
	fn nothing_makes_no_points() {
		assert!( W_Steps( vec![] ).is_empty() );
	}

	#[test]
	fn runs_in_time_order_whatever_the_input_order() {
		let p = W_Steps( vec![ ( 30, IW, -40 ), ( 10, IW, 100 ), ( 20, IW, 50 ) ] );
		assert_eq!( points( &p ), vec![ ( 10, 100 ), ( 20, 150 ), ( 30, 110 ) ] );
	}

	#[test]
	fn a_spend_and_its_change_at_one_moment_make_one_point() {
		// 100 spent, 70 back as change, 30 paid out with the fee: one step down
		let p = W_Steps( vec![ ( 10, IW, 100 ), ( 20, IW, -100 ), ( 20, IW, 70 ) ] );
		assert_eq!( points( &p ), vec![ ( 10, 100 ), ( 20, 70 ) ] );
	}

	fn pools( p: &[ pool_t ] ) -> BTreeSet< pool_t > {
		p.iter().copied().collect()
	}

	#[test]
	fn classifies_by_what_left_the_account() {
		let none = pools( &[] );
		let iw = pools( &[ pool_t::POOL_IRONWOOD ] );
		let t = pools( &[ pool_t::POOL_TRANSPARENT ] );
		let sap = pools( &[ pool_t::POOL_SAPLING ] );

		// nothing spent: received
		assert_eq!( W_Classify( 0, 500, 0, &none, &iw ), ( txKind_t::TX_RECEIVED, 500 ) );
		// 1000 in, 300 change back, fee 10: 690 went to someone
		assert_eq!( W_Classify( 1000, 300, 10, &iw, &iw ), ( txKind_t::TX_SENT, 690 ) );
		// public to private, only the fee lost: a shield of what arrived
		assert_eq!( W_Classify( 1000, 990, 10, &t, &iw ), ( txKind_t::TX_SHIELD, 990 ) );
		// Sapling to Ironwood, only the fee lost: a move
		assert_eq!( W_Classify( 1000, 990, 10, &sap, &iw ), ( txKind_t::TX_MOVE, 990 ) );
		// fee unknown (0): the fee counts as sent, never hidden
		assert_eq!( W_Classify( 1000, 990, 0, &sap, &iw ), ( txKind_t::TX_SENT, 10 ) );
	}

	#[test]
	fn never_below_zero() {
		let p = W_Steps( vec![ ( 10, IW, -5 ) ] );
		assert_eq!( points( &p ), vec![ ( 10, 0 ) ] );
	}

	/*
	==================
	every_engine_state_is_its_own

	Each of the engine's five states is read as itself; "not confirmed"
	once covered an expired payment, shown as pending forever
	==================
	*/
	#[test]
	fn every_engine_state_is_its_own() {
		let h = zcash_protocol::consensus::BlockHeight::from_u32( 100 );
		assert_eq!( Com_TxState( ConfirmationStatus::Confirmed( h ), 140 ), txState_t::CONFIRMED { height: 100 } );
		assert_eq!( Com_TxState( ConfirmationStatus::Mempool( h ), 140 ), txState_t::PENDING { expiresAt: Some( 140 ) } );
		assert_eq!( Com_TxState( ConfirmationStatus::Transmitted( h ), 140 ), txState_t::PENDING { expiresAt: Some( 140 ) } );
		assert_eq!( Com_TxState( ConfirmationStatus::Transmitted( h ), 0 ), txState_t::PENDING { expiresAt: None }, "0 never expires" );
		assert_eq!( Com_TxState( ConfirmationStatus::Calculated( h ), 140 ), txState_t::UNSENT );
		assert_eq!( Com_TxState( ConfirmationStatus::Failed( h ), 140 ), txState_t::FAILED );
	}

	#[test]
	fn a_failed_payment_says_what_it_tried() {
		assert_eq!( W_ClassifyFailed( 7_000, 2_000, false ), ( txKind_t::TX_SENT, 7_000 ) );
		assert_eq!( W_ClassifyFailed( 0, 9_000, true ), ( txKind_t::TX_SHIELD, 9_000 ) );
		assert_eq!( W_ClassifyFailed( 0, 9_000, false ), ( txKind_t::TX_MOVE, 9_000 ) );
	}

	/*
	==================
	a_failed_payment_is_failed_everywhere

	On a real wallet: a payment that failed, whose change output never
	existed, next to money received, a payment pending and one a stop left
	unsent. The failed one is failed in history (not money received, not
	pending), out of the chart, and never announced; the waiting ones come
	first.
	==================
	*/
	#[test]
	fn a_failed_payment_is_failed_everywhere() {
		use pepper_sync::keys::transparent::{ TransparentAddressId, TransparentScope };
		use pepper_sync::wallet::{ OutputId, TransparentCoin, WalletTransaction };
		use zcash_protocol::consensus::BlockHeight;
		use zcash_protocol::value::Zatoshis;
		use zingo_status::confirmation_status::ConfirmationStatus as S;

		let mut wallet = crate::w_test::Test_Wallet();

		let account = AccountId::ZERO;
		let key = TransparentAddressId::new( account, TransparentScope::External, zcash_transparent::keys::NonHardenedChildIndex::ZERO );
		let mut add = |n: u8, status: S, expiry: u32, zats: u64| {
			let txid = TxId::from_bytes( [ n; 32 ] );
			let coin = TransparentCoin::new_for_test( OutputId::new( txid, 0 ), key, "tm".into(), Default::default(), Zatoshis::from_u64( zats ).unwrap() );
			let tx = WalletTransaction::new_for_test_with_expiry( txid, status, BlockHeight::from_u32( expiry ) ).with_transparent_coins_for_test( vec![ coin ] );
			wallet.wallet_transactions.insert( txid, tx );
			txid.to_string()
		};
		let received	= add( 1, S::Confirmed( BlockHeight::from_u32( 3_000_010 ) ), 0, 10_000 );
		let failed		= add( 2, S::Failed( BlockHeight::from_u32( 3_000_020 ) ), 3_000_060, 5_000 );
		let pending		= add( 3, S::Mempool( BlockHeight::from_u32( 3_000_030 ) ), 3_000_070, 3_000 );
		let unsent		= add( 4, S::Calculated( BlockHeight::from_u32( 3_000_040 ) ), 3_000_080, 1_000 );

		let items = W_ReadTransactions( &wallet, account );
		let find = |id: &str| items.iter().find( |i| i.txid == id ).unwrap();

		assert_eq!( find( &failed ).state, txState_t::FAILED );
		assert_ne!( find( &failed ).kind, txKind_t::TX_RECEIVED, "a failed payment's change is not money received" );
		assert_eq!( find( &pending ).state, txState_t::PENDING { expiresAt: Some( 3_000_070 ) } );
		assert_eq!( find( &unsent ).state, txState_t::UNSENT );
		assert_eq!( find( &received ).state, txState_t::CONFIRMED { height: 3_000_010 } );
		assert!( items[0].state.Waiting() && items[1].state.Waiting(), "what waits on the network comes first" );

		let balance = W_Steps( W_AllFlows( &wallet, account ) ).last().unwrap().zats;
		assert_eq!( balance, 10_000 + 3_000 + 1_000, "the failed payment's outputs never existed" );
	}
}
