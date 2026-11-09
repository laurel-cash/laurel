/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_repeat.rs -- payments that come back: rent every month, a weekly one
//
// Laurel never sends money by itself. A repeating payment is a reminder:
// when it is due, Laurel says so (in the app, and the system's notice when
// Laurel isn't in front), and "Review and Send" opens Send filled in, to
// be reviewed like any payment. Sent, or skipped, it moves to the next
// date, one period at a time: months missed while Laurel was closed show
// as still due, never skipped quietly.
//
// What someone pays regularly, and to whom, is private: sealed with the
// vault key (PURPOSE_REPEATS), per network in wallets/<network>/repeats.json.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{ LazyLock, Mutex };

use serde::{ Deserialize, Serialize };
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::w_date::{ Com_AddMonths, Com_DayOfMonth, Com_Every, Com_NewId, Com_Now };
use crate::w_local::*;
use crate::w_main::{ Com_CleanName, W_NetworkDir };
use crate::w_scan::W_ParseScan;
use crate::w_send::W_CheckMemo;
use crate::w_vault::{ purpose_t, V_ReadSealed, V_WriteSealed };

const REPEATS_FILE_NAME: &str	= "repeats.json";
const WATCH_SECS: u64			= 300;		// how often due payments are looked for
const WEEK_SECS: u32			= 7 * 86_400;

#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub enum every_t {
	#[serde( rename = "week" )]		EVERY_WEEK,
	#[serde( rename = "month" )]	EVERY_MONTH,
}

#[derive( Clone, Debug, PartialEq, Serialize, Deserialize, Type )]
pub struct repeat_t {
	pub id:			String,
	pub walletId:	String,
	pub account:	u32,
	pub label:		String,				// what it is for: "Rent"
	pub to:			String,				// as Scan reads it
	pub zats:		u64,
	pub memo:		Option< String >,
	pub every:		every_t,
	pub next:		u32,				// unix seconds: when it is next due
	pub day:		u32,				// the day of the month it was set for: a 31st stays the 31st where a month has one
	#[serde( default )]
	pub due:		bool,				// next has come: said by the engine's clock (Rp_List), never kept
}

// what the person set up: id none is a new one
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
pub struct repeatInput_t {
	pub id:			Option< String >,
	pub walletId:	String,
	pub account:	u32,
	pub label:		String,
	pub to:			String,
	pub zats:		u64,
	pub memo:		Option< String >,
	pub every:		every_t,
	pub next:		u32,
}

// a payment came due (the watcher, once per payment and session): the ui reads the list again
#[derive( Clone, Debug, Serialize, Type, Event )]
pub struct repeatDueEvent_t {
	pub id:			String,
	pub label:		String,
}

// one change of the file at a time; payments already announced this session
static rp_writing: LazyLock< tokio::sync::Mutex< () > > = LazyLock::new( || tokio::sync::Mutex::new( () ) );
static rp_announced: LazyLock< Mutex< HashSet< String > > > = LazyLock::new( || Mutex::new( HashSet::new() ) );

fn Rp_Path( net: network_t ) -> PathBuf {
	W_NetworkDir( net ).join( REPEATS_FILE_NAME )
}

fn Rp_Read( net: network_t ) -> wresult_t< Vec< repeat_t > > {
	V_ReadSealed( &Rp_Path( net ), purpose_t::PURPOSE_REPEATS, file_t::FILE_REPEATS )
}

fn Rp_Write( net: network_t, all: &[ repeat_t ] ) -> wresult_t< () > {
	let kept: Vec< repeat_t > = all.iter().map( |r| repeat_t { due: false, ..r.clone() } ).collect();
	V_WriteSealed( &Rp_Path( net ), purpose_t::PURPOSE_REPEATS, &kept )
}

/*
==================
Com_Following

The date after next: a week on, or a month on from the day it was set for
==================
*/
pub fn Com_Following( r: &repeat_t ) -> u32 {
	match r.every {
		every_t::EVERY_WEEK		=> r.next.saturating_add( WEEK_SECS ),
		every_t::EVERY_MONTH	=> Com_AddMonths( r.next, 1, r.day ),
	}
}

/*
==================
Rp_List

Every repeating payment, soonest first, each saying whether it is due now
==================
*/
pub async fn Rp_List() -> wresult_t< Vec< repeat_t > > {
	let net = w_registry.read().await.network;
	let now = Com_Now();
	let mut all = Rp_Read( net )?;
	for r in &mut all {
		r.due = u64::from( r.next ) <= now;
	}
	all.sort_by_key( |r| r.next );
	Ok( all )
}

/*
==================
Rp_Save

Adds one or changes it. The address is read the way Scan reads one, and
the memo checked for it, so a reminder never fills Send with a payment
Send would refuse.
==================
*/
pub async fn Rp_Save( input: repeatInput_t ) -> wresult_t< repeat_t > {
	let net = w_registry.read().await.network;
	let label = Com_CleanName( &input.label )?;
	let target = W_ParseScan( net, &input.to )?;
	W_CheckMemo( &input.memo, target.kind )?;
	if ( input.zats == 0 ) {
		return Err( werr_t::WERR_NO_AMOUNT );
	}

	let _writing = rp_writing.lock().await;
	let mut all = Rp_Read( net )?;
	let made = repeat_t {
		id:			input.id.clone().unwrap_or_else( || Com_NewId( 'r' ) ),
		walletId:	input.walletId,
		account:	input.account,
		label:		label,
		to:			target.address,
		zats:		input.zats,
		memo:		input.memo.filter( |m| !m.trim().is_empty() ),
		every:		input.every,
		next:		input.next,
		day:		Com_DayOfMonth( input.next ),
		due:		false,
	};
	match all.iter_mut().find( |r| Some( &r.id ) == input.id.as_ref() ) {
		Some( r )	=> *r = made.clone(),
		None		=> all.push( made.clone() ),
	}
	Rp_Write( net, &all )?;
	rp_announced.lock().unwrap().remove( &made.id );
	Ok( made )
}

pub async fn Rp_Remove( id: &str ) -> wresult_t< () > {
	let net = w_registry.read().await.network;
	let _writing = rp_writing.lock().await;
	let mut all = Rp_Read( net )?;
	all.retain( |r| r.id != id );
	Rp_Write( net, &all )
}

/*
==================
Rp_ForgetWallet

A removed wallet's repeating payments go with it: they came due forever,
each with a notice, and paying one chose a wallet that wasn't there.
A restored wallet is a new one (a new id), so nothing could take them up
==================
*/
pub async fn Rp_ForgetWallet( walletId: &str ) -> wresult_t< () > {
	let net = w_registry.read().await.network;
	let _writing = rp_writing.lock().await;
	let mut all = Rp_Read( net )?;
	all.retain( |r| r.walletId != walletId );
	Rp_Write( net, &all )
}

/*
==================
Rp_Done

Paid, or skipped: on to the following date, one period only. Still due
after that (months missed while Laurel was closed), it says so again.
==================
*/
pub async fn Rp_Done( id: &str ) -> wresult_t< () > {
	let net = w_registry.read().await.network;
	let _writing = rp_writing.lock().await;
	let mut all = Rp_Read( net )?;
	let r = all.iter_mut().find( |r| r.id == id ).ok_or_else( || werr_t::WERR_ENGINE( "That repeating payment is gone.".to_string() ) )?;
	r.next = Com_Following( r );
	Rp_Write( net, &all )?;
	rp_announced.lock().unwrap().remove( id );
	Ok( () )
}

/*
==================
Rp_Watch

Every few minutes, for as long as Laurel runs: each payment that has come
due is said once this session (the ui's list, and the system's notice,
without the amount). Nothing is read while Laurel is locked: the file is
sealed, and the next look finds it.
==================
*/
pub fn Rp_Watch( app: AppHandle ) {
	Com_Every( "Rp_Watch", WATCH_SECS, move || {
		let app = app.clone();
		async move {
			// locked, the sealed file can't be read: not a fault, the next look finds it
			let Ok( all ) = Rp_List().await else {
				return Ok( () );
			};
			for r in all.into_iter().filter( |r| r.due ) {
				if ( rp_announced.lock().unwrap().insert( r.id.clone() ) ) {
					crate::w_notice::N_System( &app, &W_Notice( |w| &w.due, "A payment is due" ), &r.label );
					let _ = repeatDueEvent_t { id: r.id, label: r.label }.emit( &app );
				}
			}
			Ok( () )
		}
	} );
}


#[cfg( test )]
mod tests {
	use super::*;
	use crate::w_date::{ Com_DaysFromCivil, Com_IsoTime };

	fn At( y: i64, m: u32, d: u32 ) -> u32 {
		( Com_DaysFromCivil( y, m, d ) * 86_400 + 12 * 3_600 ) as u32
	}

	fn Repeat( every: every_t, next: u32 ) -> repeat_t {
		repeat_t { id: "r".into(), walletId: "w".into(), account: 0, label: "Rent".into(), to: "t".into(), zats: 1, memo: None, every: every, next: next, day: Com_DayOfMonth( next ), due: false }
	}

	// a month on keeps the day it was set for; a week on is seven days
	#[test]
	fn the_following_date_is_one_period_on() {
		let mut r = Repeat( every_t::EVERY_MONTH, At( 2027, 1, 31 ) );
		r.next = Com_Following( &r );
		assert_eq!( Com_IsoTime( r.next ), "2027-02-28T12:00:00Z" );
		r.next = Com_Following( &r );
		assert_eq!( Com_IsoTime( r.next ), "2027-03-31T12:00:00Z", "back to the 31st it was set for" );

		let w = Repeat( every_t::EVERY_WEEK, At( 2027, 12, 29 ) );
		assert_eq!( Com_IsoTime( Com_Following( &w ) ), "2028-01-05T12:00:00Z" );
	}
}
