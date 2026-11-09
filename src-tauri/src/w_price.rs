/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_price.rs -- the ZEC price in dollars, only when the person asked for it
//
// Opt-in (appSettings_t.showPrice): the price source sees this computer's
// IP address, and nothing about its wallets. Asked from rust, not the
// browser: one request path, no browser fingerprint, a cache per range,
// and the same trust as the Zcash servers (the webpki roots only), so an
// antivirus that intercepts is caught here the same way, not trusted.

use std::collections::HashMap;
use std::sync::{ LazyLock, Mutex, OnceLock };
use std::time::Duration;

use serde::{ Deserialize, Serialize };
use specta::Type;

use crate::w_date::Com_Now;
use crate::w_local::*;
use crate::w_net::Com_Classify;
use crate::w_settings::S_Get;

const PRICE_SOURCE: &str	= "https://api.coingecko.com/api/v3/coins/zcash/market_chart";
const PRICE_WAIT_SECS: u64	= 15;
const HOUR_SECS: u64		= 3600;

#[derive( Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type )]
pub enum priceRange_t {
	#[serde( rename = "1h" )]	RANGE_1H,
	#[serde( rename = "1d" )]	RANGE_1D,
	#[serde( rename = "1w" )]	RANGE_1W,
	#[serde( rename = "1m" )]	RANGE_1M,
	#[serde( rename = "1y" )]	RANGE_1Y,
	#[serde( rename = "all" )]	RANGE_ALL,
}

#[derive( Clone, Copy, Debug, PartialEq, Serialize, Type )]
pub struct pricePoint_t {
	pub time:	u64,		// unix seconds
	pub usd:	f64,
}

#[derive( Clone, Debug, Serialize, Type )]
pub struct priceSeries_t {
	pub range:		priceRange_t,
	pub points:		Vec< pricePoint_t >,		// oldest first
	pub fetchedAt:	u64,						// unix seconds: "updated 2 minutes ago"
}

// what CoinGecko answers: [ milliseconds, price ] pairs
#[derive( Deserialize )]
struct marketChart_t {
	prices:	Vec< [ f64; 2 ] >,
}

static p_cache: LazyLock< Mutex< HashMap< priceRange_t, priceSeries_t > > > = LazyLock::new( || Mutex::new( HashMap::new() ) );
static p_client: OnceLock< reqwest::Client > = OnceLock::new();

/*
==================
Com_Days / Com_FreshSecs

How much history each range asks for, and how long an answer stays good:
the last hour moves by the minute, a year by the day
==================
*/
fn Com_Days( range: priceRange_t ) -> &'static str {
	match range {
		priceRange_t::RANGE_1H | priceRange_t::RANGE_1D	=> "1",
		priceRange_t::RANGE_1W							=> "7",
		priceRange_t::RANGE_1M							=> "30",
		priceRange_t::RANGE_1Y							=> "365",
		priceRange_t::RANGE_ALL							=> "max",
	}
}

fn Com_FreshSecs( range: priceRange_t ) -> u64 {
	match range {
		priceRange_t::RANGE_1H							=> 120,
		priceRange_t::RANGE_1D							=> 300,
		priceRange_t::RANGE_1W							=> 1800,
		priceRange_t::RANGE_1M							=> HOUR_SECS,
		priceRange_t::RANGE_1Y | priceRange_t::RANGE_ALL	=> 6 * HOUR_SECS,
	}
}


/*
==================
Com_Points

CoinGecko's pairs as points, oldest first; the last hour is cut from a
day's answer. Anything that isn't a price is left out.
==================
*/
fn Com_Points( chart: marketChart_t, range: priceRange_t ) -> Vec< pricePoint_t > {
	let mut points: Vec< pricePoint_t > = chart.prices.iter()
		.filter( |p| p[0].is_finite() && p[0] > 0.0 && p[1].is_finite() && p[1] > 0.0 )
		.map( |p| pricePoint_t { time: ( p[0] / 1000.0 ) as u64, usd: p[1] } )
		.collect();
	points.sort_by_key( |p| p.time );
	if ( range == priceRange_t::RANGE_1H ) {
		let last = points.last().map_or( 0, |p| p.time );
		points.retain( |p| p.time + HOUR_SECS >= last );
	}
	points
}

/*
==================
P_Client

One client, trusting what the Zcash connections trust (Com_Https)
==================
*/
fn P_Client() -> wresult_t< reqwest::Client > {
	if let Some( c ) = p_client.get() {
		return Ok( c.clone() );
	}
	let client = crate::w_net::Com_Https()?
		.timeout( Duration::from_secs( PRICE_WAIT_SECS ) )
		.build()
		.map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
	Ok( p_client.get_or_init( || client ).clone() )
}

/*
==================
P_Series

The price over a range, from the cache while it's fresh. Refused while
prices are off: nothing is asked without the person's yes.
==================
*/
pub async fn P_Series( range: priceRange_t ) -> wresult_t< priceSeries_t > {
	if ( !S_Get().showPrice ) {
		return Err( werr_t::WERR_PRICE_OFF );
	}
	if let Some( s ) = p_cache.lock().unwrap().get( &range ) {
		if ( Com_Now() < s.fetchedAt + Com_FreshSecs( range ) ) {
			return Ok( s.clone() );
		}
	}

	let answer = P_Client()?
		.get( PRICE_SOURCE )
		.query( &[ ( "vs_currency", "usd" ), ( "days", Com_Days( range ) ) ] )
		.send().await
		.map_err( |e| P_Error( &e ) )?;
	if ( answer.status() == reqwest::StatusCode::TOO_MANY_REQUESTS ) {
		return Err( werr_t::WERR_PRICE_BUSY );
	}
	let answer = answer.error_for_status().map_err( |e| P_Error( &e ) )?;
	let chart: marketChart_t = answer.json().await.map_err( |e| werr_t::WERR_PRICE( e.to_string() ) )?;

	let series = priceSeries_t { range: range, points: Com_Points( chart, range ), fetchedAt: Com_Now() };
	if ( series.points.len() < 2 ) {
		return Err( werr_t::WERR_PRICE( "the answer had no prices".to_string() ) );
	}
	p_cache.lock().unwrap().insert( range, series.clone() );
	Ok( series )
}

/*
==================
Com_ValueSeries

What an account was worth at each price point: the balance held at that
moment (the last change at or before it; nothing before the first) times
the price then. The same shape as a price series, its usd the account's
value, so one chart draws both.
==================
*/
pub fn Com_ValueSeries( balance: &[ balancePoint_t ], prices: &[ pricePoint_t ] ) -> Vec< pricePoint_t > {
	let mut at = 0;
	let mut held = 0u64;
	prices.iter().map( |p| {
		while ( at < balance.len() && u64::from( balance[at].time ) <= p.time ) {
			held = balance[at].zats;
			at += 1;
		}
		pricePoint_t { time: p.time, usd: held as f64 / 100_000_000.0 * p.usd }
	} ).collect()
}

/*
==================
accountValue_t

What an account was worth, or that its coins have no price. Test coins
have none: ZEC's price times them would be play money that looks real.
That is a fact of the network, not a failure, and was once shown as one
("Couldn't Work Out the Value", in red).
==================
*/
#[derive( Clone, Debug, Serialize, Type )]
#[serde( tag = "kind" )]
pub enum accountValue_t {
	#[serde( rename = "series" )]
	AV_SERIES { series: priceSeries_t },
	#[serde( rename = "noPrice" )]
	AV_NO_PRICE,
}

/*
==================
W_ValueHistory

An account's worth in dollars over a range: its balance history and the
price series, joined (Com_ValueSeries). No price is said before prices
are asked for (nobody is asked); the series only with prices on, like
every price. It changes with money moved in and out, not the price alone.
==================
*/
pub async fn W_ValueHistory( id: &str, account: u32, range: priceRange_t ) -> wresult_t< accountValue_t > {
	if ( w_registry.read().await.network == network_t::NET_TESTNET ) {
		return Ok( accountValue_t::AV_NO_PRICE );
	}
	let prices = P_Series( range ).await?;
	let balance = crate::w_history::W_BalanceHistory( id, account ).await?;
	Ok( accountValue_t::AV_SERIES { series: priceSeries_t { range: prices.range, points: Com_ValueSeries( &balance, &prices.points ), fetchedAt: prices.fetchedAt } } )
}

// an antivirus in the way and a slow answer say so, as for the Zcash servers
fn P_Error( e: &reqwest::Error ) -> werr_t {
	if ( e.is_timeout() ) {
		return werr_t::WERR_SERVER_SLOW;
	}
	match Com_Classify( e ) {
		werr_t::WERR_INTERCEPTED => werr_t::WERR_INTERCEPTED,
		_ => werr_t::WERR_PRICE( crate::w_net::Com_CauseChain( e ) ),
	}
}


#[cfg( test )]
mod tests {

	/*
	==================
	the_value_is_the_balance_then_times_the_price_then

	Before the first payment the account held nothing; after each, what it
	held then; never a later balance at an earlier price
	==================
	*/
	#[test]
	fn the_value_is_the_balance_then_times_the_price_then() {
		let balance = [ ( 100, 200_000_000 ), ( 300, 50_000_000 ) ].map( |( t, z )| balancePoint_t { time: t, zats: z, pools: poolZats_t::default() } );
		let prices = [ ( 50, 30.0 ), ( 100, 40.0 ), ( 200, 50.0 ), ( 400, 60.0 ) ].map( |( t, usd )| pricePoint_t { time: t, usd: usd } );
		let value: Vec< ( u64, f64 ) > = Com_ValueSeries( &balance, &prices ).iter().map( |p| ( p.time, p.usd ) ).collect();
		assert_eq!( value, vec![ ( 50, 0.0 ), ( 100, 80.0 ), ( 200, 100.0 ), ( 400, 30.0 ) ] );
	}

	use super::*;

	#[test]
	fn points_come_oldest_first_without_nonsense_and_the_hour_is_the_last_hour() {
		let chart = || marketChart_t { prices: vec![
			[ 7_200_000.0, 30.0 ], [ 0.0, 99.0 ], [ 3_600_000.0, 25.0 ], [ 10_800_000.0, f64::NAN ], [ 10_000_000.0, 31.0 ],
		] };
		let day = Com_Points( chart(), priceRange_t::RANGE_1D );
		assert_eq!( day.iter().map( |p| p.time ).collect::< Vec< _ > >(), [ 3600, 7200, 10_000 ] );

		let hour = Com_Points( chart(), priceRange_t::RANGE_1H );
		assert_eq!( hour.iter().map( |p| p.time ).collect::< Vec< _ > >(), [ 7200, 10_000 ] );		// within 3600 s of the last
	}
}
