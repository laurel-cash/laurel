/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_alert.rs -- "tell me when ZEC goes above $60": price alerts
//
// Only with prices on (w_price.rs): the watcher reads the price the chart
// already keeps fresh, and asks nothing of its own while prices are off.
// An alert goes off when the price crosses it between two looks, never
// because it already stands past it: the first look after starting only
// learns the price, or every start would announce "above $30" again. Each
// goes off once and says so; setting it again is the person's choice.
//
// Kept apart from the settings on purpose: the settings are saved whole
// from the ui's copy, which would bring back an alert the engine had
// just marked as gone off.

use std::path::PathBuf;
use std::sync::{ LazyLock, Mutex };

use serde::{ Deserialize, Serialize };
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::w_date::{ Com_Every, Com_NewId, Com_Now };
use crate::w_disk::{ Com_ReadJson, Com_WriteJson };
use crate::w_local::*;
use crate::w_price::{ priceRange_t, P_Series };

const ALERTS_FILE_NAME: &str	= "price-alerts.json";
const WATCH_SECS: u64			= 120;		// as often as the hour's prices are kept fresh

#[derive( Clone, Debug, PartialEq, Serialize, Deserialize, Type )]
pub struct priceAlert_t {
	pub id:		String,
	pub above:	bool,				// true: when it rises to usd; false: when it falls to it
	pub usd:	f64,
	pub fired:	Option< u64 >,		// unix seconds it went off; none: still waiting
}

// an alert went off: the ui reads the list again
#[derive( Clone, Debug, Serialize, Type, Event )]
pub struct priceAlertEvent_t {
	pub id:		String,
	pub above:	bool,
	pub usd:	f64,
	pub price:	f64,
}

// one change of the file at a time; the price at the last look
static al_writing: LazyLock< tokio::sync::Mutex< () > > = LazyLock::new( || tokio::sync::Mutex::new( () ) );
static al_last: LazyLock< Mutex< Option< f64 > > > = LazyLock::new( || Mutex::new( None ) );

fn Al_Path() -> wresult_t< PathBuf > {
	Com_DataPath( ALERTS_FILE_NAME ).ok_or_else( Com_NoDataFolder )
}

fn Al_Read() -> wresult_t< Vec< priceAlert_t > > {
	Ok( Com_ReadJson( &Al_Path()?, file_t::FILE_ALERTS )?.unwrap_or_default() )
}

fn Al_Write( all: &[ priceAlert_t ] ) -> wresult_t< () > {
	Com_WriteJson( &Al_Path()?, &all )
}

/*
==================
Com_Crossed

Whether the price went past a waiting alert between two looks: up
through it for "above", down through it for "below"
==================
*/
pub fn Com_Crossed( before: f64, now: f64, a: &priceAlert_t ) -> bool {
	a.fired.is_none() && match a.above {
		true	=> before < a.usd && now >= a.usd,
		false	=> before > a.usd && now <= a.usd,
	}
}

pub fn Al_List() -> wresult_t< Vec< priceAlert_t > > {
	Al_Read()
}

/*
==================
Al_Add

A new alert: above or below a price in dollars, more than nothing
==================
*/
pub async fn Al_Add( above: bool, usd: f64 ) -> wresult_t< priceAlert_t > {
	if ( !usd.is_finite() || usd <= 0.0 ) {
		return Err( werr_t::WERR_NO_AMOUNT );
	}
	let _writing = al_writing.lock().await;
	let mut all = Al_Read()?;
	let made = priceAlert_t { id: Com_NewId( 'a' ), above: above, usd: usd, fired: None };
	all.push( made.clone() );
	Al_Write( &all )?;
	Ok( made )
}

pub async fn Al_Remove( id: &str ) -> wresult_t< () > {
	let _writing = al_writing.lock().await;
	let mut all = Al_Read()?;
	all.retain( |a| a.id != id );
	Al_Write( &all )
}

/*
==================
Al_Look

One look at the price: every waiting alert it crossed since the last
look goes off, once. The first look only learns the price.
==================
*/
async fn Al_Look( app: &AppHandle ) -> wresult_t< () > {
	let all = Al_Read()?;
	if ( !crate::w_settings::S_Get().showPrice || all.iter().all( |a| a.fired.is_some() ) ) {
		return Ok( () );		// nothing asked of the price source for nothing
	}
	let series = P_Series( priceRange_t::RANGE_1H ).await?;
	let Some( now ) = series.points.last().map( |p| p.usd ).filter( |p| p.is_finite() ) else {
		return Ok( () );
	};
	let before = al_last.lock().unwrap().replace( now );
	let Some( before ) = before else {
		return Ok( () );
	};

	let _writing = al_writing.lock().await;
	let mut all = Al_Read()?;
	let mut went = vec![];
	for a in &mut all {
		if ( Com_Crossed( before, now, a ) ) {
			a.fired = Some( Com_Now() );
			went.push( a.clone() );
		}
	}
	if ( went.is_empty() ) {
		return Ok( () );
	}
	Al_Write( &all )?;
	for a in went {
		// the ui's words; the price as dollars, as Rust writes them (no Intl here)
		let asked = format!( "${:.2}", a.usd );
		let title = if a.above { Com_Fill( &W_Notice( |w| &w.rose, "ZEC rose above {0}" ), &[ asked ] ) } else { Com_Fill( &W_Notice( |w| &w.fell, "ZEC fell below {0}" ), &[ asked ] ) };
		crate::w_notice::N_System( app, &title, &Com_Fill( &W_Notice( |w| &w.priceNow, "It is {0} now." ), &[ format!( "${now:.2}" ) ] ) );
		let _ = priceAlertEvent_t { id: a.id, above: a.above, usd: a.usd, price: now }.emit( app );
	}
	Ok( () )
}

/*
==================
Al_Watch

A look every couple of minutes, for as long as Laurel runs
==================
*/
pub fn Al_Watch( app: AppHandle ) {
	Com_Every( "Al_Watch", WATCH_SECS, move || {
		let app = app.clone();
		async move { Al_Look( &app ).await }
	} );
}


#[cfg( test )]
mod tests {
	use super::*;

	fn Alert( above: bool, usd: f64 ) -> priceAlert_t {
		priceAlert_t { id: "a".into(), above: above, usd: usd, fired: None }
	}

	/*
	==================
	an_alert_goes_off_when_the_price_crosses_it

	Crossing it, either way, as asked; standing past it is not news, and
	one that went off stays quiet
	==================
	*/
	#[test]
	fn an_alert_goes_off_when_the_price_crosses_it() {
		let up = Alert( true, 60.0 );
		assert!( Com_Crossed( 59.0, 60.0, &up ), "reaching it counts" );
		assert!( Com_Crossed( 50.0, 70.0, &up ) );
		assert!( !Com_Crossed( 61.0, 65.0, &up ), "already above: not news" );
		assert!( !Com_Crossed( 70.0, 50.0, &up ), "the other way" );

		let down = Alert( false, 40.0 );
		assert!( Com_Crossed( 41.0, 39.5, &down ) );
		assert!( !Com_Crossed( 39.0, 38.0, &down ) );

		let gone = priceAlert_t { fired: Some( 1 ), ..up };
		assert!( !Com_Crossed( 59.0, 61.0, &gone ), "once" );
	}
}
