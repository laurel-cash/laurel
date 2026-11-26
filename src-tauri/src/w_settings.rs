/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_settings.rs -- the person's choices for the whole app: when to lock,
// how to be told about payments. Not secret, so a plain file beside the
// vault (<app data>/laurel-settings.json); read once, kept in memory.
//
// A damaged or missing file is the defaults, logged: a choice lost is
// better than an app that won't start.

use std::path::{ Path, PathBuf };
use std::sync::{ LazyLock, Mutex };

use serde::{ Deserialize, Serialize };
use specta::Type;

use crate::w_disk::{ Com_ReadJson, Com_WriteJson };
use crate::w_local::*;
use crate::w_vault::present_t;

const SETTINGS_FILE_NAME: &str = "laurel-settings.json";

// the waits a person can choose before Laurel locks itself; none is never
pub const AUTO_LOCK_CHOICES: [ u32; 6 ] = [ 1, 5, 10, 15, 30, 60 ];

// on a phone, how long Laurel may be out of sight before it locks, in
// seconds; 0 is the moment it's left (w_mobile.rs)
pub const LOCK_AWAY_CHOICES: [ u32; 3 ] = [ 0, 60, 300 ];
const LOCK_AWAY_DEFAULT: u32 = 60;

// text size, percent of Laurel's own: the whole window scales, layout and all
pub const TEXT_SCALES: [ u32; 5 ] = [ 100, 115, 130, 150, 175 ];

// the terms of use and privacy policy v1 asks agreement to (laurel.cash/terms,
// /privacy), by the day they were set; a newer day asks again (T-049).
// 2026-11-20: the terms and policy that name Laurel for Windows and real ZEC
pub const TERMS_VERSION: &str = "2026-11-20";

// v1's first start: which terms this device agreed to, and when (unix
// seconds). Kept only here, never sent anywhere.
#[derive( Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub struct termsAccepted_t {
	pub version:	String,
	pub at:			u32,
}

// choosing an auto-lock: saved, or it locks later than now and the
// password is asked first (S_LocksLater); the ui never works that out
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
#[serde( tag = "kind" )]
pub enum autoLockResult_t {
	#[serde( rename = "saved" )]
	SAVED { settings: appSettings_t },
	#[serde( rename = "askPassword" )]
	ASK_PASSWORD,
}

// every field always there: what the ui gets and sends
#[derive( Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub struct appSettings_t {
	pub autoLockMinutes:	Option< u32 >,		// idle this long, then lock (with a password only); none: never
	pub lockAwaySecs:		u32,				// a phone: out of sight this long, then lock; one of LOCK_AWAY_CHOICES
	pub notifyInApp:		bool,				// a note in the corner when a payment arrives
	pub notifySystem:		bool,				// and the system's notification while Laurel is in the background
	pub network:			network_t,			// the one network open (W_SetNetwork); each keeps its own wallets
	pub showPrice:			bool,				// the person said yes to asking CoinGecko for the ZEC price (w_price.rs)
	pub textScale:			u32,				// percent, one of TEXT_SCALES
	pub betaWalletsSeen:	bool,				// v1 told this device its beta's test wallets are kept, not opened (D-033)
	pub termsAccepted:		Option< termsAccepted_t >,	// v1's terms agreed to on this device (T-049); none: not yet
	pub sendFromPublic:		bool,				// Advanced: public money may be sent as it is, not shielded first (w_send.rs)
	pub priceYesRealMoney:	bool,				// showPrice's yes was given in a real-money build (D-035): a beta's isn't carried into v1
	pub checkUpdates:		bool,				// the person said yes to asking the store, once a day, whether a newer Laurel is out (w_update.rs)
}

impl Default for appSettings_t {
	fn default() -> Self {
		appSettings_t {
			autoLockMinutes:	None,
			lockAwaySecs:		LOCK_AWAY_DEFAULT,
			notifyInApp:		true,
			notifySystem:		!cfg!( mobile ),
			network:			NETWORKS[0],		// a first start: test coins until the audit, then mainnet in v1 (D-033)
			showPrice:			false,						// nothing is asked of a price source without a yes
			textScale:			100,
			betaWalletsSeen:	false,
			termsAccepted:		None,
			sendFromPublic:		false,			// public money is shielded first unless the person turns this on
			priceYesRealMoney:	false,
			checkUpdates:		false,			// nothing is asked of a store without a yes
		}
	}
}

/*
==================
S_FromFile / S_Offered

The settings a file holds. An older file lacks newer fields, and they
read as their defaults: the file's fields are laid over the defaults, by
name, so a new setting is its field and its default and nothing here.
(Only here: what the ui gets and sends has every field, always.) A field
this version doesn't know is left out, and one written as nothing where
a value belongs reads as its default. Anything else that doesn't fit its
field is a damaged file (S_Settle).

Then what the file says is held to what the screens offer: a wait, a
size or a network they couldn't have chosen reads as one they could
(Com_OfferedLock; the default otherwise). Only a setting with such a
rule is named in S_Offered.
==================
*/
fn S_FromFile( file: serde_json::Value ) -> wresult_t< appSettings_t > {
	let damaged = || werr_t::WERR_CORRUPT( file_t::FILE_SETTINGS );
	let serde_json::Value::Object( file ) = file else {
		return Err( damaged() );
	};
	let serde_json::Value::Object( mut all ) = serde_json::to_value( appSettings_t::default() ).map_err( |_| damaged() )? else {
		return Err( damaged() );
	};
	for ( name, value ) in file {
		let Some( default ) = all.get( &name ) else {
			continue;
		};
		if ( value.is_null() && !default.is_null() ) {
			continue;
		}
		all.insert( name, value );
	}
	let read: appSettings_t = serde_json::from_value( serde_json::Value::Object( all ) ).map_err( |_| damaged() )?;
	Ok( S_Offered( read ) )
}

fn S_Offered( read: appSettings_t ) -> appSettings_t {
	let d = appSettings_t::default();
	appSettings_t {
		showPrice:			Com_PriceYes( cfg!( feature = "v1" ), read.showPrice, read.priceYesRealMoney ),
		autoLockMinutes:	read.autoLockMinutes.map( Com_OfferedLock ),
		lockAwaySecs:		if ( LOCK_AWAY_CHOICES.contains( &read.lockAwaySecs ) ) { read.lockAwaySecs } else { d.lockAwaySecs },
		network:			if ( NETWORKS.contains( &read.network ) ) { read.network } else { d.network },
		textScale:			if ( TEXT_SCALES.contains( &read.textScale ) ) { read.textScale } else { d.textScale },
		..read
	}
}

static s_settings: LazyLock< Mutex< Option< appSettings_t > > > = LazyLock::new( || Mutex::new( None ) );

// Start Over (W_ForgetAll): read again, from a file that's gone: the defaults
pub fn S_Forget() {
	*s_settings.lock().unwrap() = None;
}

fn S_Path() -> Option< PathBuf > {
	Com_DataPath( SETTINGS_FILE_NAME )
}

fn S_Load() -> appSettings_t {
	let Some( path ) = S_Path() else {
		return appSettings_t::default();		// no data folder (tests)
	};
	S_Settle( Com_ReadJson::< serde_json::Value >( &path, file_t::FILE_SETTINGS ).and_then( |file| file.map( S_FromFile ).transpose() ) )
}

/*
==================
S_Settle / Com_OfferedLock

The settings a read of the file gives: none yet is the defaults. A
damaged file is the defaults too, but locking as soon as any choice does
(W1-07): the default auto-lock is never, and a file the screens didn't
write must not loosen what they guard with the password.

A wait the screens don't offer reads as the nearest offered below it
(the shortest, under all of them): never longer than what was there.
==================
*/
fn S_Settle( read: wresult_t< Option< appSettings_t > > ) -> appSettings_t {
	match read {
		Ok( f ) => f.unwrap_or_default(),
		Err( e ) => {
			log::warn!( "S_Load: {}, using the defaults, locking at the shortest wait", e.LogText() );
			appSettings_t { autoLockMinutes: Some( AUTO_LOCK_CHOICES[0] ), lockAwaySecs: LOCK_AWAY_CHOICES[0], ..appSettings_t::default() }
		}
	}
}

fn Com_OfferedLock( minutes: u32 ) -> u32 {
	AUTO_LOCK_CHOICES.iter().copied().filter( |&c| c <= minutes ).max().unwrap_or( AUTO_LOCK_CHOICES[0] )
}

/*
==================
S_Get

The settings as they stand; read from disk the first time
==================
*/
pub fn S_Get() -> appSettings_t {
	let mut s = s_settings.lock().unwrap();
	s.get_or_insert_with( S_Load ).clone()
}

/*
==================
S_Set

Checks, saves and keeps the person's choices. The locks are not among
them here: each changes through its own setter (S_SetAutoLock,
S_SetLockAway), which asks for the password before a later one.
==================
*/
pub fn S_Set( settings: appSettings_t ) -> wresult_t< appSettings_t > {
	let now = S_Get();
	if ( settings.autoLockMinutes != now.autoLockMinutes || settings.lockAwaySecs != now.lockAwaySecs ) {
		return Err( werr_t::WERR_ENGINE( "The locks are changed on their own (S_SetAutoLock, S_SetLockAway).".to_string() ) );
	}
	if ( !TEXT_SCALES.contains( &settings.textScale ) ) {
		return Err( werr_t::WERR_ENGINE( format!( "{}% isn't one of the text sizes", settings.textScale ) ) );
	}
	// told and agreed, only by their own (S_BetaWalletsSeen, S_AcceptTerms); the price's yes
	// in real money only by this build saying yes, never by the ui's copy
	let priceYesRealMoney = now.priceYesRealMoney || ( cfg!( feature = "v1" ) && settings.showPrice );
	S_Write( appSettings_t { betaWalletsSeen: now.betaWalletsSeen, termsAccepted: now.termsAccepted, priceYesRealMoney, ..settings } )
}

/*
==================
Com_PriceYes

D-035: prices on, as this build reads the file. A beta said yes to a price
beside play money; real money asks again, so v1 counts only a yes given
in a real-money build. Any other build reads the yes as it is.
==================
*/
fn Com_PriceYes( v1: bool, showPrice: bool, yesInRealMoney: bool ) -> bool {
	showPrice && ( !v1 || yesInRealMoney )
}

/*
==================
S_LocksLater

Whether the auto-lock would wait longer than now; never is the longest
==================
*/
pub fn S_LocksLater( from: Option< u32 >, to: Option< u32 > ) -> bool {
	to.unwrap_or( u32::MAX ) > from.unwrap_or( u32::MAX )
}

/*
==================
S_SetAutoLock

Sooner needs nothing. Later, or never, needs someone just asked
(present_t): a Laurel left unlocked for a minute must not be set to
stay unlocked for good.
==================
*/
pub fn S_SetAutoLock( minutes: Option< u32 >, present: Option< &present_t > ) -> wresult_t< appSettings_t > {
	if let Some( m ) = minutes {
		if ( !AUTO_LOCK_CHOICES.contains( &m ) ) {
			return Err( werr_t::WERR_ENGINE( format!( "{m} minutes isn't one of the auto-lock choices" ) ) );
		}
	}
	let now = S_Get();
	if ( S_LocksLater( now.autoLockMinutes, minutes ) && present.is_none() ) {
		return Err( werr_t::WERR_CONFIRM );
	}
	S_Write( appSettings_t { autoLockMinutes: minutes, ..now } )
}

/*
==================
S_SetLockAway

How long a phone may be out of sight before Laurel locks. Sooner needs
nothing; later needs someone just asked, as with the auto-lock.
==================
*/
pub fn S_SetLockAway( secs: u32, present: Option< &present_t > ) -> wresult_t< appSettings_t > {
	if ( !LOCK_AWAY_CHOICES.contains( &secs ) ) {
		return Err( werr_t::WERR_ENGINE( format!( "{secs} seconds isn't one of the choices for locking when Laurel is left" ) ) );
	}
	let now = S_Get();
	if ( secs > now.lockAwaySecs && present.is_none() ) {
		return Err( werr_t::WERR_CONFIRM );
	}
	S_Write( appSettings_t { lockAwaySecs: secs, ..now } )
}

/*
==================
S_AwayTooLong

Whether a phone was out of sight longer than the person allows. A clock
that ran backwards (no elapsed time) counts as too long. A phone's only
(w_mobile.rs): the computer's build has no use for it but its test
==================
*/
#[cfg_attr( not( mobile ), allow( dead_code ) )]
pub fn S_AwayTooLong( away: Option< std::time::Duration >, allowed: u32 ) -> bool {
	away.is_none_or( |d| d >= std::time::Duration::from_secs( allowed as u64 ) )
}

fn S_Write( settings: appSettings_t ) -> wresult_t< appSettings_t > {
	Com_WriteJson( &S_Path().ok_or_else( Com_NoDataFolder )?, &settings )?;
	*s_settings.lock().unwrap() = Some( settings.clone() );
	Ok( settings )
}


/*
==================
S_BetaWalletsDue / S_BetaWalletsSeen

D-033: v1 opens mainnet alone. A phone that ran the beta keeps its test
wallets (wallets/testnet, never moved or deleted), unopened; v1 says so
once, when that folder holds a wallet, and remembers it was said. A
fresh install, or any other build, says nothing.
==================
*/
pub fn S_BetaWalletsDue() -> bool {
	Com_BetaWalletsDue( cfg!( feature = "v1" ), S_Get().betaWalletsSeen, Com_NetworkPath( network_t::NET_TESTNET ).as_deref() )
}

fn Com_BetaWalletsDue( v1: bool, seen: bool, testnet: Option< &Path > ) -> bool {
	if ( !v1 || seen ) {
		return false;
	}
	let Some( dir ) = testnet else {
		return false;
	};
	std::fs::read_dir( dir ).into_iter().flatten().flatten().any( |e| e.path().join( WALLET_FILE_NAME ).exists() )
}

pub fn S_BetaWalletsSeen() -> wresult_t< appSettings_t > {
	S_Write( appSettings_t { betaWalletsSeen: true, ..S_Get() } )
}

/*
==================
S_TermsDue / S_AcceptTerms

T-049: v1 asks agreement to its terms before anything else, once per
TERMS_VERSION; a phone that agreed to older terms is asked again. Any
other build asks nothing. Agreeing is kept only in the settings file.
==================
*/
pub fn S_TermsDue() -> bool {
	Com_TermsDue( cfg!( feature = "v1" ), S_Get().termsAccepted.as_ref() )
}

fn Com_TermsDue( v1: bool, accepted: Option< &termsAccepted_t > ) -> bool {
	v1 && accepted.is_none_or( |a| a.version != TERMS_VERSION )
}

pub fn S_AcceptTerms() -> wresult_t< appSettings_t > {
	let at = u32::try_from( crate::w_date::Com_Now() ).unwrap_or( u32::MAX );
	S_Write( appSettings_t { termsAccepted: Some( termsAccepted_t { version: TERMS_VERSION.to_string(), at } ), ..S_Get() } )
}


#[cfg( test )]
mod tests {
	use super::*;

	// a settings file from a build that opened mainnet, read by the Play beta's: it starts
	// on testnet, never on a network it would then refuse to open
	#[test]
	fn a_network_this_build_doesnt_open_reads_as_the_default() {
		// D-033: whatever the build, a saved network it doesn't open reads as its first, and
		// its first start is on that one (v1: a beta's saved testnet is mainnet)
		for net in [ network_t::NET_TESTNET, network_t::NET_MAINNET ] {
			let saved = format!( r#"{{ "network": "{}" }}"#, if net == network_t::NET_MAINNET { "mainnet" } else { "testnet" } );
			let read = S_FromFile( serde_json::from_str( &saved ).unwrap() ).unwrap().network;
			assert_eq!( read, if NETWORKS.contains( &net ) { net } else { NETWORKS[0] }, "{saved}" );
		}
		assert_eq!( appSettings_t::default().network, NETWORKS[0] );
		let read = S_FromFile( serde_json::from_str( r#"{ "network": "mainnet" }"# ).unwrap() ).unwrap();
		let want = if ( NETWORKS.contains( &network_t::NET_MAINNET ) ) { network_t::NET_MAINNET } else { network_t::NET_TESTNET };
		assert_eq!( read.network, want );
	}

	// D-033: v1 tells a phone once that its beta's test wallets are kept, not opened; never
	// a fresh install, never once told, never another build
	#[test]
	fn v1_tells_of_the_betas_test_wallets_once() {
		let testnet = Com_TestDir( "beta-wallets" );
		assert!( !Com_BetaWalletsDue( true, false, None ), "no data folder" );
		assert!( !Com_BetaWalletsDue( true, false, Some( &testnet.join( "none" ) ) ), "a fresh install: no testnet folder" );
		std::fs::create_dir_all( testnet.join( "w1" ) ).unwrap();
		assert!( !Com_BetaWalletsDue( true, false, Some( &testnet ) ), "a folder without a wallet file" );
		std::fs::write( testnet.join( "w1" ).join( WALLET_FILE_NAME ), b"x" ).unwrap();
		assert!( Com_BetaWalletsDue( true, false, Some( &testnet ) ), "the beta's wallet, kept" );
		assert!( !Com_BetaWalletsDue( true, true, Some( &testnet ) ), "told once" );
		assert!( !Com_BetaWalletsDue( false, false, Some( &testnet ) ), "only v1 says it" );

		let read = |text: &str| S_FromFile( serde_json::from_str( text ).unwrap() ).unwrap();
		assert!( !read( "{}" ).betaWalletsSeen );
		assert!( read( r#"{ "betaWalletsSeen": true }"# ).betaWalletsSeen );
	}

	// T-049: v1 asks for its terms until these are agreed to, and again for newer ones;
	// no other build asks, and a file without them reads as never agreed
	#[test]
	fn v1_asks_for_its_terms_until_agreed() {
		let agreed = |version: &str| termsAccepted_t { version: version.to_string(), at: 1_793_000_000 };
		assert!( Com_TermsDue( true, None ), "never agreed" );
		assert!( Com_TermsDue( true, Some( &agreed( "2026-01-01" ) ) ), "older terms" );
		assert!( Com_TermsDue( true, Some( &agreed( "2026-11-08" ) ) ), "the testnet-only terms 0.3.1 asked for" );
		assert!( !Com_TermsDue( true, Some( &agreed( TERMS_VERSION ) ) ), "these terms" );
		assert!( !Com_TermsDue( false, None ), "only v1 asks" );
		assert_eq!( TERMS_VERSION, "2026-11-20" );

		let read = |text: &str| S_FromFile( serde_json::from_str( text ).unwrap() ).unwrap();
		assert_eq!( read( "{}" ).termsAccepted, None );
		assert_eq!( read( r#"{ "termsAccepted": { "version": "2026-11-20", "at": 1793000000 } }"# ).termsAccepted, Some( agreed( TERMS_VERSION ) ) );
	}

	// D-035: a beta's yes to prices isn't carried into real money; v1 asks again, and
	// keeps the yes it is given; any other build reads the yes as it is
	#[test]
	fn a_betas_yes_to_prices_isnt_carried_into_real_money() {
		assert!( !Com_PriceYes( true, true, false ), "the beta's yes, read by v1" );
		assert!( Com_PriceYes( true, true, true ), "a yes given in v1" );
		assert!( !Com_PriceYes( true, false, true ), "turned off since" );
		assert!( Com_PriceYes( false, true, false ), "the beta reads its own yes" );

		let read = |text: &str| S_FromFile( serde_json::from_str( text ).unwrap() ).unwrap();
		assert_eq!( read( r#"{ "showPrice": true }"# ).showPrice, !cfg!( feature = "v1" ), "a file from before D-035" );
		assert!( read( r#"{ "showPrice": true, "priceYesRealMoney": true }"# ).showPrice );
	}

	// back within the time allowed stays open; at it or past it, or with a
	// clock that ran backwards, it locks
	#[test]
	fn away_too_long_is_by_the_clock() {
		use std::time::Duration;
		assert!( !S_AwayTooLong( Some( Duration::from_secs( 59 ) ), 60 ) );
		assert!( S_AwayTooLong( Some( Duration::from_secs( 60 ) ), 60 ) );
		assert!( S_AwayTooLong( Some( Duration::from_secs( 3600 ) ), 300 ) );
		assert!( S_AwayTooLong( None, 60 ) );
	}

	#[test]
	fn an_old_or_partial_file_fills_in_the_defaults() {
		let read = |text: &str| S_FromFile( serde_json::from_str( text ).unwrap() ).unwrap();
		assert_eq!( read( r#"{ "autoLockMinutes": 5 }"# ), appSettings_t { autoLockMinutes: Some( 5 ), ..appSettings_t::default() } );
		assert_eq!( read( "{}" ), appSettings_t::default() );
		assert_eq!( read( r#"{ "notifySystem": false }"# ).notifySystem, false );
		assert_eq!( read( r#"{ "textScale": 130 }"# ).textScale, 130 );
		assert_eq!( read( r#"{ "textScale": 999 }"# ).textScale, 100, "a size that isn't offered reads as the default" );
		assert_eq!( read( r#"{ "lockAwaySecs": 0 }"# ).lockAwaySecs, 0 );
		assert_eq!( read( r#"{ "lockAwaySecs": 999 }"# ).lockAwaySecs, 60, "a wait that isn't offered reads as the default" );
	}

	// a setting is its field and its default: every one written is read back as
	// it was, with no list of fields to keep in step (the file's reading was one)
	#[test]
	fn every_setting_written_is_read_back() {
		let chosen = appSettings_t {
			autoLockMinutes:	Some( AUTO_LOCK_CHOICES[2] ),
			lockAwaySecs:		LOCK_AWAY_CHOICES[2],
			notifyInApp:		false,
			notifySystem:		!appSettings_t::default().notifySystem,
			network:			NETWORKS[ NETWORKS.len() - 1 ],
			showPrice:			true,
			textScale:			TEXT_SCALES[3],
			betaWalletsSeen:	true,
			termsAccepted:		Some( termsAccepted_t { version: TERMS_VERSION.to_string(), at: 1_793_000_000 } ),
			sendFromPublic:		true,
			priceYesRealMoney:	true,
			checkUpdates:		true,
		};
		assert_eq!( S_FromFile( serde_json::to_value( &chosen ).unwrap() ).unwrap(), chosen );
		let first = appSettings_t::default();
		assert_eq!( S_FromFile( serde_json::to_value( &first ).unwrap() ).unwrap(), first );
	}

	// what isn't a setting is left out; what doesn't fit its setting is a damaged
	// file, not a guess; nothing written where a value belongs is the default
	#[test]
	fn a_file_that_doesnt_fit_is_damaged_not_guessed() {
		let read = |text: &str| S_FromFile( serde_json::from_str( text ).unwrap() );
		assert_eq!( read( r#"{ "fromALaterLaurel": 7 }"# ).unwrap(), appSettings_t::default(), "a field this version doesn't know" );
		assert_eq!( read( r#"{ "notifyInApp": null, "textScale": null }"# ).unwrap(), appSettings_t::default(), "nothing written" );
		assert!( matches!( read( r#"{ "textScale": "big" }"# ), Err( werr_t::WERR_CORRUPT( file_t::FILE_SETTINGS ) ) ) );
		assert!( matches!( read( r#"{ "network": "somewhere" }"# ), Err( werr_t::WERR_CORRUPT( file_t::FILE_SETTINGS ) ) ) );
		assert!( matches!( read( "[]" ), Err( werr_t::WERR_CORRUPT( file_t::FILE_SETTINGS ) ) ), "not settings at all" );
	}

	/*
	==================
	the_file_cant_loosen_the_lock

	W1-07: the auto-lock was read from the file unchecked, where the
	screens ask for the password to lengthen it, and a damaged file read
	as "never". A wait that isn't offered reads as the nearest one offered
	below it; a damaged file locks as soon as any choice does
	==================
	*/
	#[test]
	fn the_file_cant_loosen_the_lock() {
		let read = |text: &str| S_FromFile( serde_json::from_str( text ).unwrap() ).unwrap();
		assert_eq!( read( r#"{ "autoLockMinutes": 99999 }"# ).autoLockMinutes, Some( 60 ), "a wait that isn't offered" );
		assert_eq!( read( r#"{ "autoLockMinutes": 7 }"# ).autoLockMinutes, Some( 5 ) );
		assert_eq!( read( r#"{ "autoLockMinutes": 0 }"# ).autoLockMinutes, Some( 1 ) );
		assert_eq!( read( r#"{ "autoLockMinutes": 15 }"# ).autoLockMinutes, Some( 15 ), "a choice stays itself" );
		assert_eq!( read( r#"{ "autoLockMinutes": null }"# ).autoLockMinutes, None, "never, chosen with the password" );

		let damaged = S_Settle( Err( werr_t::WERR_CORRUPT( file_t::FILE_SETTINGS ) ) );
		assert_eq!( damaged.autoLockMinutes, Some( AUTO_LOCK_CHOICES[0] ), "a damaged file never locks" );
		assert_eq!( damaged.lockAwaySecs, LOCK_AWAY_CHOICES[0] );
		assert_eq!( S_Settle( Ok( None ) ), appSettings_t::default(), "no file yet: a first start" );
	}

	/*
	==================
	a_later_lock_needs_someone_asked

	Sooner is free; later or never is refused without the proof, and
	the generic save can't change the auto-lock at all
	==================
	*/
	#[test]
	fn a_later_lock_needs_someone_asked() {
		*s_settings.lock().unwrap() = Some( appSettings_t { autoLockMinutes: Some( 5 ), ..appSettings_t::default() } );

		assert!( S_LocksLater( Some( 5 ), Some( 10 ) ) && S_LocksLater( Some( 60 ), None ) );
		assert!( !S_LocksLater( Some( 5 ), Some( 1 ) ) && !S_LocksLater( None, Some( 60 ) ) && !S_LocksLater( None, None ) );

		assert!( matches!( S_SetAutoLock( Some( 30 ), None ), Err( werr_t::WERR_CONFIRM ) ) );
		assert!( matches!( S_SetAutoLock( None, None ), Err( werr_t::WERR_CONFIRM ) ) );
		assert!( matches!( S_Set( appSettings_t { autoLockMinutes: None, ..S_Get() } ), Err( werr_t::WERR_ENGINE( _ ) ) ) );
		assert_eq!( S_Get().autoLockMinutes, Some( 5 ), "refused, and still unchanged" );

		// the same for how long a phone may be out of sight
		assert_eq!( S_Get().lockAwaySecs, 60 );
		assert!( matches!( S_SetLockAway( 300, None ), Err( werr_t::WERR_CONFIRM ) ) );
		assert!( matches!( S_SetLockAway( 45, None ), Err( werr_t::WERR_ENGINE( _ ) ) ), "only the offered choices" );
		assert!( matches!( S_Set( appSettings_t { lockAwaySecs: 300, ..S_Get() } ), Err( werr_t::WERR_ENGINE( _ ) ) ) );
		assert_eq!( S_Get().lockAwaySecs, 60, "refused, and still unchanged" );
	}
}
