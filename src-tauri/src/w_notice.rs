/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_notice.rs -- news, and telling it: payments that arrived or settled
// (found by sync), and the system's notification for every kind of news
// (payments, a repeating payment come due, a price alert)
//
// Lived inside w_sync.rs, which made the gated notice sync's own and left
// the ungated one public for everyone else.

use tauri::AppHandle;
use tauri_specta::Event;

use crate::w_history::W_ReadTransactions;
use crate::w_local::*;

// the system notification's titles, until the ui has said its words (uiWords_t); the amount stays inside the app
const RECEIVED_TITLE: &str	= "Payment received";
const SENT_TITLE: &str		= "Payment went through";
const FAILED_TITLE: &str	= "A payment didn't go through";

// the sample (N_Sample): what a payment's looks like, without one
const SAMPLE_BODY: &str		= "This is how Laurel tells you. The amount stays inside the app.";

/*
==================
N_Payments

Tells the ui (and the system, if Laurel isn't in front) about payments
that just arrived, and payments sent that went through or didn't. Looks
only when a balance changed (confirmed or pending); the first look after
opening only learns what's there; and while the wallet is still catching
up, what sync finds is history, so it's learned, not announced.
==================
*/
pub fn N_Payments( app: &AppHandle, id: &str, s: &slot_t ) {
	let pending = |b: &balance_t| b.ironwood.pending + b.orchard.pending + b.sapling.pending + b.transparent.pending;
	let totals: Vec< ( u64, u64 ) > = s.cache.lock().unwrap().balances.iter().map( |b| ( b.total - pending( b ), pending( b ) ) ).collect();
	if ( s.cache.lock().unwrap().seenTotals == totals ) {
		return;
	}
	let Some( wallet ) = crate::w_engine::E_TryRead( &s.wallet ) else {
		return;		// busy: the next emit looks again, totals still differ
	};

	let accounts: Vec< Vec< historyItem_t > > = ( 0..s.meta.accounts.len() as u32 )
		.map( |i| zip32::AccountId::try_from( i ).map_or( vec![], |a| W_ReadTransactions( &wallet, a ) ) )
		.collect();

	let news = {
		let mut c = s.cache.lock().unwrap();
		c.seenTotals = totals;
		let caughtUp = c.caughtUp;
		Com_Look( &mut c.seenTxids, caughtUp, accounts )
	};
	let news: Vec< paymentEvent_t > = news.into_iter().map( |( i, it )| paymentEvent_t {
		walletId:		id.to_string(),
		account:		i as u32,
		accountName:	s.meta.accounts.get( i ).cloned().unwrap_or_default(),
		txid:			it.txid,
		kind:			it.kind,
		amount:			it.amount,
		state:			it.state,
	} ).collect();

	for n in news {
		N_PaymentNotice( app, &n, &s.meta.name );
		let _ = n.emit( app );
	}
}

/*
==================
Com_Look

One look at every account's transactions: what is news. A payment that
arrives is news once, when first seen coming or come (a failed or unsent
line is not an arrival). A payment sent is news when it settles: went
through, or didn't (the person sent it; that it left is not news). All
are learned; none is news on the first look (it was already there) or
while catching up (it's history being found). The whole look is decided
here, once, so no account can see another account's half-finished state.
==================
*/
fn Com_Look( known: &mut Option< std::collections::HashMap< String, seen_t > >, caughtUp: bool, accounts: Vec< Vec< historyItem_t > > ) -> Vec< ( usize, historyItem_t ) > {
	let announce = known.is_some() && caughtUp;
	let seen = known.get_or_insert_with( Default::default );

	let mut news = vec![];
	for ( i, items ) in accounts.into_iter().enumerate() {
		for it in items {
			let now = match it.state {
				txState_t::PENDING { .. } | txState_t::UNSENT	=> seen_t::SEEN_WAITING,
				txState_t::CONFIRMED { .. }						=> seen_t::SEEN_CONFIRMED,
				txState_t::FAILED								=> seen_t::SEEN_FAILED,
			};
			// one line per account: a payment between two of them is two lines, each its own news
			let before = seen.insert( format!( "{i}:{}", it.txid ), now );
			let isNews = match it.kind {
				txKind_t::TX_RECEIVED	=> before.is_none() && now != seen_t::SEEN_FAILED && it.state != txState_t::UNSENT,
				txKind_t::TX_SENT		=> before != Some( now ) && now != seen_t::SEEN_WAITING,
				txKind_t::TX_SHIELD | txKind_t::TX_MOVE	=> false,		// within the account: nothing arrived, nothing left
			};
			if ( isNews && announce ) {
				news.push( ( i, it ) );
			}
		}
	}
	news
}

/*
==================
N_PaymentNotice

What a payment's system notification says: its word and where, no amount.
Every kind and state is named: a catch-all once said "Payment received"
for anything not sent, and a new kind would have been announced so too.
==================
*/
fn N_PaymentNotice( app: &AppHandle, n: &paymentEvent_t, walletName: &str ) {
	let title = match ( n.kind, &n.state ) {
		( txKind_t::TX_RECEIVED, _ )								=> W_Notice( |w| &w.received, RECEIVED_TITLE ),
		( txKind_t::TX_SENT, txState_t::FAILED )					=> W_Notice( |w| &w.failed, FAILED_TITLE ),
		( txKind_t::TX_SENT, txState_t::CONFIRMED { .. } )			=> W_Notice( |w| &w.sent, SENT_TITLE ),
		// never news (Com_Look): a payment sent is news once it settles, a move never
		( txKind_t::TX_SENT, txState_t::PENDING { .. } | txState_t::UNSENT ) | ( txKind_t::TX_SHIELD | txKind_t::TX_MOVE, _ ) => return,
	};
	N_System( app, &title, &format!( "{} · {}", n.accountName, walletName ) );
}

/*
==================
N_System

The system's notification, the one way Laurel shows one: only while
Laurel isn't the window in front (it says so itself then), only when
Settings > Notifications leaves them on, and never with an amount (a
lock screen is not the place for a private balance). A repeating
payment and a price alert once called the ungated one and spoke up with
notifications turned off (check_owners: the plugin is used only here).
==================
*/
pub fn N_System( app: &AppHandle, title: &str, body: &str ) {
	use tauri::Manager;

	let inFront = app.get_webview_window( "main" ).and_then( |win| win.is_focused().ok() ).unwrap_or( false );
	if ( Com_MaySpeak( inFront, crate::w_settings::S_Get().notifySystem ) ) {
		if let Err( e ) = N_Show( app, title, body ) {
			log::warn!( "N_System: {}", e.LogText() );
		}
	}
}

/*
==================
N_Sample

The sample the person asked for (Settings > Notifications): shown with
Laurel in front, since that is where they pressed it, and whether the
setting is on, since they are deciding
==================
*/
pub fn N_Sample( app: &AppHandle ) -> wresult_t< () > {
	N_Allow( app )?;
	N_Show( app, &W_Notice( |w| &w.received, RECEIVED_TITLE ), &W_Notice( |w| &w.sample, SAMPLE_BODY ) )
}

// only an explicit enable or sample asks for permission, never a background event
pub fn N_Allow( _app: &AppHandle ) -> wresult_t< () > {
	#[cfg( mobile )]
	{
		use tauri_plugin_notification::{ NotificationExt, PermissionState };
		let notices = _app.notification();
		let state = notices.permission_state().map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
		if ( state != PermissionState::Granted ) {
			let state = notices.request_permission().map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
			if ( state != PermissionState::Granted ) {
				return Err( werr_t::WERR_NOTIFICATIONS );
			}
		}
	}
	Ok( () )
}

fn N_Show( app: &AppHandle, title: &str, body: &str ) -> wresult_t< () > {
	use tauri_plugin_notification::NotificationExt;

	app.notification().builder().title( title ).body( body ).show()
		.map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )
}

fn Com_MaySpeak( inFront: bool, systemOn: bool ) -> bool {
	!inFront && systemOn
}


#[cfg( test )]
mod tests {
	use super::*;
	use proptest::prelude::*;

	fn Paid( txid: &str ) -> historyItem_t {
		historyItem_t {
			txid: txid.into(), time: 0, kind: txKind_t::TX_RECEIVED, amount: 1, fee: None, state: txState_t::CONFIRMED { height: 1 },
			from: vec![], into: vec![], counterparty: None, memo: None, note: None, category: None,
		}
	}

	fn Ids( v: Vec< ( usize, historyItem_t ) > ) -> Vec< String > {
		v.into_iter().map( |( _, i )| i.txid ).collect()
	}

	#[test]
	fn the_first_look_is_quiet_in_every_account() {
		let mut known = None;
		assert!( Com_Look( &mut known, true, vec![ vec![ Paid( "a0" ) ], vec![ Paid( "a1" ) ] ] ).is_empty() );
		assert_eq!( Ids( Com_Look( &mut known, true, vec![ vec![ Paid( "a0" ), Paid( "n0" ) ], vec![ Paid( "a1" ), Paid( "n1" ) ] ] ) ), vec![ "n0", "n1" ] );
	}

	#[test]
	fn catching_up_is_history_not_news() {
		let mut known = Some( Default::default() );
		assert!( Com_Look( &mut known, false, vec![ vec![ Paid( "old" ) ] ] ).is_empty() );
		assert_eq!( Ids( Com_Look( &mut known, true, vec![ vec![ Paid( "old" ), Paid( "new" ) ] ] ) ), vec![ "new" ] );
	}

	#[test]
	fn an_arrival_is_news_once() {
		let mut known = Some( Default::default() );
		let mut coming = Paid( "r" );
		coming.state = txState_t::PENDING { expiresAt: None };
		assert_eq!( Ids( Com_Look( &mut known, true, vec![ vec![ coming ] ] ) ), vec![ "r" ] );
		assert!( Com_Look( &mut known, true, vec![ vec![ Paid( "r" ) ] ] ).is_empty() );		// pending, then confirmed: once
	}

	// a payment sent: not when it leaves (the person just sent it), but when it
	// settles, either way; a move within the account is never news
	#[test]
	fn a_payment_sent_is_news_when_it_settles() {
		let sent = |id: &str, state: txState_t| {
			let mut s = Paid( id );
			s.kind = txKind_t::TX_SENT;
			s.state = state;
			s
		};
		let mut known = Some( Default::default() );
		let waiting = txState_t::PENDING { expiresAt: Some( 10 ) };
		assert!( Com_Look( &mut known, true, vec![ vec![ sent( "ok", waiting.clone() ), sent( "no", waiting.clone() ) ] ] ).is_empty() );
		assert_eq!( Ids( Com_Look( &mut known, true, vec![ vec![ sent( "ok", txState_t::CONFIRMED { height: 5 } ), sent( "no", txState_t::FAILED ) ] ] ) ), vec![ "ok", "no" ] );
		assert!( Com_Look( &mut known, true, vec![ vec![ sent( "ok", txState_t::CONFIRMED { height: 5 } ), sent( "no", txState_t::FAILED ) ] ] ).is_empty(), "once" );

		let mut moved = Paid( "m" );
		moved.kind = txKind_t::TX_MOVE;
		assert!( Com_Look( &mut known, true, vec![ vec![ moved ] ] ).is_empty() );
	}

	// one payment between two of the person's accounts: sent from one, received in the other
	#[test]
	fn a_payment_between_accounts_is_news_in_each() {
		let mut known = Some( Default::default() );
		let mut out = Paid( "x" );
		out.kind = txKind_t::TX_SENT;
		assert_eq!( Com_Look( &mut known, true, vec![ vec![ out ], vec![ Paid( "x" ) ] ] ).len(), 2 );
	}

	// what never arrived is never news: a failed or unsent line, even one that
	// reads as received (a failed payment's change once did)
	#[test]
	fn nothing_that_failed_or_is_unsent_is_announced() {
		let mut known = Some( Default::default() );
		let mut failed = Paid( "f" );
		failed.state = txState_t::FAILED;
		let mut unsent = Paid( "u" );
		unsent.state = txState_t::UNSENT;
		let mut pending = Paid( "p" );
		pending.state = txState_t::PENDING { expiresAt: Some( 10 ) };
		assert_eq!( Ids( Com_Look( &mut known, true, vec![ vec![ failed, unsent, pending ] ] ) ), vec![ "p" ] );
	}

	// any set of payments, split any way across 1 to 5 accounts
	fn Split() -> impl Strategy< Value = Vec< Vec< historyItem_t > > > {
		prop::collection::vec( prop::collection::vec( "[a-f]{1,3}", 0..6 ), 1..6 )
			.prop_map( |accounts| accounts.into_iter().map( |ids| ids.iter().map( |t| Paid( t ) ).collect() ).collect() )
	}

	// the app in front says it itself; turned off is off
	#[test]
	fn the_system_is_told_only_from_the_background_and_when_on() {
		assert!( Com_MaySpeak( false, true ) );
		assert!( !Com_MaySpeak( true, true ) );
		assert!( !Com_MaySpeak( false, false ) );
	}

	proptest! {
		#[test]
		fn no_first_look_announces_anything( accounts in Split() ) {
			let mut known = None;
			prop_assert!( Com_Look( &mut known, true, accounts ).is_empty() );
		}

		#[test]
		fn a_second_look_at_the_same_payments_is_quiet( accounts in Split(), caughtUp in any::< bool >() ) {
			let mut known = Some( Default::default() );
			Com_Look( &mut known, caughtUp, accounts.clone() );
			prop_assert!( Com_Look( &mut known, true, accounts ).is_empty() );
		}
	}
}
