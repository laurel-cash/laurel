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

use std::path::PathBuf;
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
}

impl Default for appSettings_t {
	fn default() -> Self {
		appSettings_t {
			autoLockMinutes:	None,
			lockAwaySecs:		LOCK_AWAY_DEFAULT,
			notifyInApp:		true,
			notifySystem:		!cfg!( mobile ),
			network:			network_t::NET_TESTNET,		// until an audit, a first start is on test coins
			showPrice:			false,						// nothing is asked of a price source without a yes
			textScale:			100,
		}
	}
}

// the file as it may be: an older one lacks newer fields, which read as
// their defaults (only here; the wire type above has no optional fields)
#[derive( Deserialize )]
struct settingsFile_t {
	#[serde( default )]
	autoLockMinutes:	Option< u32 >,
	lockAwaySecs:		Option< u32 >,
	notifyInApp:		Option< bool >,
	notifySystem:		Option< bool >,
	network:			Option< network_t >,
	showPrice:			Option< bool >,
	textScale:			Option< u32 >,
}

impl From< settingsFile_t > for appSettings_t {
	fn from( f: settingsFile_t ) -> Self {
		let d = appSettings_t::default();
		appSettings_t {
			autoLockMinutes:	f.autoLockMinutes.map( Com_OfferedLock ),
			lockAwaySecs:		f.lockAwaySecs.filter( |s| LOCK_AWAY_CHOICES.contains( s ) ).unwrap_or( d.lockAwaySecs ),
			notifyInApp:		f.notifyInApp.unwrap_or( d.notifyInApp ),
			notifySystem:		f.notifySystem.unwrap_or( d.notifySystem ),
			network:			f.network.filter( |n| NETWORKS.contains( n ) ).unwrap_or( d.network ),
			showPrice:			f.showPrice.unwrap_or( d.showPrice ),
			textScale:			f.textScale.filter( |s| TEXT_SCALES.contains( s ) ).unwrap_or( d.textScale ),
		}
	}
}

static s_settings: LazyLock< Mutex< Option< appSettings_t > > > = LazyLock::new( || Mutex::new( None ) );

fn S_Path() -> Option< PathBuf > {
	Com_DataPath( SETTINGS_FILE_NAME )
}

fn S_Load() -> appSettings_t {
	let Some( path ) = S_Path() else {
		return appSettings_t::default();		// no data folder (tests)
	};
	S_Settle( Com_ReadJson::< settingsFile_t >( &path, file_t::FILE_SETTINGS ) )
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
fn S_Settle( read: wresult_t< Option< settingsFile_t > > ) -> appSettings_t {
	match read {
		Ok( f ) => f.map( appSettings_t::from ).unwrap_or_default(),
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
	S_Write( settings )
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
that ran backwards (no elapsed time) counts as too long
==================
*/
pub fn S_AwayTooLong( away: Option< std::time::Duration >, allowed: u32 ) -> bool {
	away.is_none_or( |d| d >= std::time::Duration::from_secs( allowed as u64 ) )
}

fn S_Write( settings: appSettings_t ) -> wresult_t< appSettings_t > {
	Com_WriteJson( &S_Path().ok_or_else( Com_NoDataFolder )?, &settings )?;
	*s_settings.lock().unwrap() = Some( settings.clone() );
	Ok( settings )
}


#[cfg( test )]
mod tests {
	use super::*;

	// a settings file from a build that opened mainnet, read by the Play beta's: it starts
	// on testnet, never on a network it would then refuse to open
	#[test]
	fn a_network_this_build_doesnt_open_reads_as_the_default() {
		let read = serde_json::from_str::< settingsFile_t >( r#"{ "network": "mainnet" }"# ).unwrap();
		let want = if ( NETWORKS.contains( &network_t::NET_MAINNET ) ) { network_t::NET_MAINNET } else { network_t::NET_TESTNET };
		assert_eq!( appSettings_t::from( read ).network, want );
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
		let read = |text: &str| appSettings_t::from( serde_json::from_str::< settingsFile_t >( text ).unwrap() );
		assert_eq!( read( r#"{ "autoLockMinutes": 5 }"# ), appSettings_t { autoLockMinutes: Some( 5 ), ..appSettings_t::default() } );
		assert_eq!( read( "{}" ), appSettings_t::default() );
		assert_eq!( read( r#"{ "notifySystem": false }"# ).notifySystem, false );
		assert_eq!( read( r#"{ "textScale": 130 }"# ).textScale, 130 );
		assert_eq!( read( r#"{ "textScale": 999 }"# ).textScale, 100, "a size that isn't offered reads as the default" );
		assert_eq!( read( r#"{ "lockAwaySecs": 0 }"# ).lockAwaySecs, 0 );
		assert_eq!( read( r#"{ "lockAwaySecs": 999 }"# ).lockAwaySecs, 60, "a wait that isn't offered reads as the default" );
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
		let read = |text: &str| appSettings_t::from( serde_json::from_str::< settingsFile_t >( text ).unwrap() );
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
