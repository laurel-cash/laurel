/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_update.rs -- whether a newer Laurel is out, only when the person asked
//
// Opt-in (appSettings_t.checkUpdates), off by default: the store asked sees
// this phone's IP address and which app it asks about, nothing of its
// wallets. Asked of the store Laurel came from, which knows already that the
// phone has it, never of a server of ours (laurel.cash/privacy: Laurel
// sends us nothing). At most once a day, from rust, as w_price.rs asks.
//
// The App Store's is the one source so far (an iPhone: W_Constants'
// updateCheck). Google Play and the Microsoft Store update their copies
// themselves; a build with no source shows no setting and asks nothing.
// A TestFlight build has none either: Apple lets no app ask TestFlight.

// a build with no store keeps the reading of an answer (its tests run everywhere) unused
#![cfg_attr( not( target_os = "ios" ), allow( dead_code ) )]

use serde::{ Deserialize, Serialize };
use specta::Type;

#[cfg( target_os = "ios" )]
use {
	std::sync::Mutex,
	std::time::Duration,
	crate::w_local::*,
	crate::w_date::Com_Now,
	crate::w_settings::S_Get,
};

// whether this build has a store to ask (W_Constants: the setting is shown only then)
pub const UPDATE_SOURCE: bool = cfg!( target_os = "ios" );

#[cfg( target_os = "ios" )]
const LOOKUP: &str			= "https://itunes.apple.com/lookup";
#[cfg( target_os = "ios" )]
const BUNDLE_ID: &str		= "cash.laurel.wallet";		// tauri.ios.conf.json
// Laurel's page in the App Store, opened by Update: named here, never taken from an answer
#[cfg( target_os = "ios" )]
const STORE_PAGE: &str		= "https://apps.apple.com/app/id6839363562";
#[cfg( target_os = "ios" )]
const LOOKUP_WAIT_SECS: u64	= 15;
#[cfg( target_os = "ios" )]
const DAY_SECS: u64			= 24 * 3600;
// an answer about one app is a few KB: past this it's read no further
#[cfg( target_os = "ios" )]
const LOOKUP_MAX_BYTES: usize	= 256 * 1024;

// a newer Laurel, and where to get it
#[derive( Clone, Debug, PartialEq, Eq, Serialize, Type )]
pub struct update_t {
	pub version:	String,
	pub page:		String,
}

// what the App Store answers, as far as Laurel reads it
#[derive( Deserialize )]
struct lookup_t {
	results:	Vec< lookupApp_t >,
}

#[derive( Deserialize )]
struct lookupApp_t {
	version:	String,
}

// the last answer, and when (unix seconds): one ask a day
#[cfg( target_os = "ios" )]
static u_last: Mutex< Option< ( u64, Option< update_t > ) > > = Mutex::new( None );

/*
==================
Com_Version

"1.2.3" as numbers to compare, a missing part as 0. Not a version at all
(a store's answer can be anything) is none, and never newer
==================
*/
pub fn Com_Version( v: &str ) -> Option< [ u32; 3 ] > {
	let mut parts = [ 0u32; 3 ];
	let mut n = 0;
	for p in v.trim().split( '.' ) {
		if ( n == 3 || p.is_empty() || !p.bytes().all( |b| b.is_ascii_digit() ) ) {
			return None;
		}
		parts[n] = p.parse().ok()?;
		n += 1;
	}
	Some( parts )
}

/*
==================
Com_Newer

What the store says is out, when it is newer than this Laurel: the
store's answer read, and an answer about no app, or no version, is none
==================
*/
pub fn Com_Newer( answer: &[ u8 ], running: &str ) -> Option< String > {
	let found: lookup_t = serde_json::from_slice( answer ).ok()?;
	let out = found.results.into_iter().next()?.version;
	( Com_Version( &out )? > Com_Version( running )? ).then_some( out )
}

/*
==================
U_Newer

A newer Laurel, if the person asked to be told and one is out. Off, or
no store to ask: none, and nothing asked. A failed ask is none too, and
said in the log: it is asked again tomorrow, and no one waits on it
==================
*/
#[cfg( target_os = "ios" )]
pub async fn U_Newer() -> Option< update_t > {
	if ( !S_Get().checkUpdates ) {
		return None;
	}
	if let Some( ( at, last ) ) = u_last.lock().unwrap().clone() {
		if ( Com_Now() < at + DAY_SECS ) {
			return last;
		}
	}
	let newer = match U_Ask().await {
		Ok( v ) => v.map( |version| update_t { version, page: STORE_PAGE.to_string() } ),
		Err( e ) => {
			log::warn!( "U_Newer: the App Store didn't answer: {}", e.LogText() );
			return None;
		}
	};
	*u_last.lock().unwrap() = Some( ( Com_Now(), newer.clone() ) );
	newer
}

#[cfg( not( target_os = "ios" ) )]
pub async fn U_Newer() -> Option< update_t > {
	None
}

#[cfg( target_os = "ios" )]
async fn U_Ask() -> wresult_t< Option< String > > {
	let fail = |e: reqwest::Error| werr_t::WERR_ENGINE( e.to_string() );
	let client = crate::w_net::Com_Https()?
		.timeout( Duration::from_secs( LOOKUP_WAIT_SECS ) )
		.build()
		.map_err( fail )?;
	let mut answer = client.get( LOOKUP ).query( &[ ( "bundleId", BUNDLE_ID ) ] ).send().await.map_err( fail )?
		.error_for_status().map_err( fail )?;
	let mut body = Vec::new();
	while let Some( chunk ) = answer.chunk().await.map_err( fail )? {
		if ( body.len() + chunk.len() > LOOKUP_MAX_BYTES ) {
			return Err( werr_t::WERR_ENGINE( "the App Store's answer was longer than one about an app".to_string() ) );
		}
		body.extend_from_slice( &chunk );
	}
	Ok( Com_Newer( &body, env!( "CARGO_PKG_VERSION" ) ) )
}

#[cfg( test )]
mod tests {
	use super::*;

	#[test]
	fn reads_versions_as_numbers() {
		assert_eq!( Com_Version( "0.3.10" ), Some( [ 0, 3, 10 ] ) );
		assert_eq!( Com_Version( "1.2" ), Some( [ 1, 2, 0 ] ) );
		assert!( Com_Version( "0.3.10" ) > Com_Version( "0.3.9" ) );		// not as words: "0.3.10" < "0.3.9"
		assert_eq!( Com_Version( "1.2.3.4" ), None );
		assert_eq!( Com_Version( "1.2-beta" ), None );
		assert_eq!( Com_Version( "" ), None );
	}

	#[test]
	fn tells_only_of_a_newer_one() {
		let out = |v: &str| format!( r#"{{"resultCount":1,"results":[{{"version":"{v}","trackName":"Laurel"}}]}}"# );
		assert_eq!( Com_Newer( out( "0.3.4" ).as_bytes(), "0.3.3" ), Some( "0.3.4".to_string() ) );
		assert_eq!( Com_Newer( out( "0.3.3" ).as_bytes(), "0.3.3" ), None );
		assert_eq!( Com_Newer( out( "0.3.2" ).as_bytes(), "0.3.3" ), None );		// a TestFlight build ahead of the store
		assert_eq!( Com_Newer( out( "soon" ).as_bytes(), "0.3.3" ), None );
		assert_eq!( Com_Newer( br#"{"resultCount":0,"results":[]}"#, "0.3.3" ), None );		// not in the store yet
		assert_eq!( Com_Newer( b"<html>", "0.3.3" ), None );
	}
}
