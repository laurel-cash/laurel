/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_vault.rs -- the key that encrypts every wallet on disk, and what
// protects that key
//
// ONE WALLET KEY. A random 256-bit key encrypts every wallet file and its
// names (XChaCha20-Poly1305, a fresh random 24-byte nonce per write, the
// file's purpose bound in as associated data). It never changes, so a new
// password never means re-encrypting wallets.
//
// WHAT PROTECTS IT, in <app data>/laurel-vault.json:
//   os		windows DPAPI, tied to this windows user. The default: no effort
//			for the user, and files copied to another machine or account
//			are useless. Any program running as the same user can unwrap
//			it, so this does NOT stop malware; a password does.
//   password	Argon2id turns the password into a key that wraps the wallet
//			key. RFC 9106's second recommended setting (64 MiB, t=3, p=4)
//			is the floor; laurel uses 256 MiB since it runs once per unlock.
//
// RULES THAT KEEP WALLETS REACHABLE
//   a new wallet key is only ever made when no encrypted wallet exists;
//   otherwise those wallets would silently become unreadable
//   the vault file is only ever replaced atomically (w_disk.rs), and no
//   copy of an old wrapping is kept: after a password change the old
//   password must not open anything
//   anything unexpected in the vault file is refused, never guessed at
//
// References: RFC 9106 (Argon2), OWASP Password Storage Cheat Sheet,
// libsodium's XChaCha20-Poly1305 notes, NCC Group's audit of RustCrypto's
// chacha20poly1305.

use std::path::{ Path, PathBuf };
use std::sync::Mutex;

use argon2::{ Algorithm, Argon2, Params, Version };
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::{ Aead, AeadCore, KeyInit, OsRng, Payload };
use chacha20poly1305::{ XChaCha20Poly1305, XNonce };
use serde::{ Deserialize, Serialize };
use specta::Type;
use zeroize::Zeroizing;

use crate::w_disk::{ Com_MakeFolderFor, Com_ParseJson, Com_ReadIfThere, Com_ReadJson, Com_WriteAtomic, Com_WriteJson };
use crate::w_net::engineResult_t;
use crate::w_local::*;

pub const VAULT_FILE_NAME: &str	= "laurel-vault.json";
pub const MIN_PASSWORD_LEN: u32	= 8;
const MAX_PASSWORD_LEN: usize	= 1024;

const VAULT_VERSION: u32		= 1;
const FILE_MAGIC: &[ u8; 8 ]	= b"LAURELE1";		// every sealed file starts with this
const KEY_LEN: usize			= 32;
const NONCE_LEN: usize			= 24;
const TAG_LEN: usize			= 16;
const SALT_LEN: usize			= 16;
const WRAP_AAD: &[ u8 ]			= b"laurel vault v1: wallet key";
#[cfg( windows )]
const DPAPI_ENTROPY: &[ u8 ]	= b"laurel.cash vault key v1";

// limits on what a vault file may ask for, checked before deriving (W1-06):
// a damaged or tampered one can't make laurel allocate gigabytes or spin
// for minutes, nor open with settings weaker than laurel ever wrote. The
// floor is RFC 9106's second choice (64 MiB, 3 passes); laurel has only
// ever written KDF_DEFAULT, so it strands no one. Tests seal with a cheap
// FAST setting, so their floor is that one; the release limits are tested
// as numbers (the_release_limits_are_rfc_floor_to_a_gigabyte)
const KDF_RELEASE_FLOOR: kdfParams_t	= kdfParams_t { mKib: 64 * 1024, t: 3, p: 1 };
const KDF_RELEASE_CEILING: kdfParams_t	= kdfParams_t { mKib: 1024 * 1024, t: 10, p: 8 };
#[cfg( not( test ) )]
const KDF_FLOOR: kdfParams_t			= KDF_RELEASE_FLOOR;
#[cfg( test )]
const KDF_FLOOR: kdfParams_t			= kdfParams_t { mKib: 8 * 1024, t: 1, p: 1 };
const KDF_CEILING: kdfParams_t			= KDF_RELEASE_CEILING;
const KDF_MIN_SALT: usize				= 16;

pub type key_t = Zeroizing< [ u8; KEY_LEN ] >;


/*
=========================================================================

TYPES

=========================================================================
*/

#[derive( Clone, Copy, PartialEq, Eq, Debug )]
pub struct kdfParams_t {
	pub mKib:	u32,
	pub t:		u32,
	pub p:		u32,
}

pub const KDF_DEFAULT: kdfParams_t = kdfParams_t { mKib: 256 * 1024, t: 3, p: 4 };

/*
==================
Com_KdfAllowed

Whether a key file's Argon2 settings are within floor and ceiling, its
salt long enough: checked before anything is derived
==================
*/
fn Com_KdfAllowed( params: kdfParams_t, saltLen: usize, floor: kdfParams_t, ceiling: kdfParams_t ) -> bool {
	( floor.mKib..=ceiling.mKib ).contains( &params.mKib )
		&& ( floor.t..=ceiling.t ).contains( &params.t )
		&& ( floor.p..=ceiling.p ).contains( &params.p )
		&& saltLen >= KDF_MIN_SALT
}

#[derive( Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, Type )]
pub enum protection_t {
	#[serde( rename = "os" )]
	PROT_OS,
	#[serde( rename = "password" )]
	PROT_PASSWORD,
}

#[derive( Clone, Serialize, Deserialize )]		// no Debug: nothing of the key file is ever formatted (W1-04)
struct kdfFile_t {
	alg:	String,			// always "argon2id"
	mKib:	u32,
	t:		u32,
	p:		u32,
	salt:	String,			// base64
}

// laurel-vault.json
#[derive( Clone, Serialize, Deserialize )]		// no Debug: nothing of the key file is ever formatted (W1-04)
struct vaultFile_t {
	version:	u32,
	protection:	protection_t,
	#[serde( default, skip_serializing_if = "Option::is_none" )]
	kdf:		Option< kdfFile_t >,
	wrapped:	String,		// base64: the wallet key under DPAPI, or nonce + sealed key under the password key
}

#[derive( Clone, Copy, PartialEq, Eq, Debug, Serialize, Type )]
pub enum vaultState_t {
	#[serde( rename = "locking" )]
	VS_LOCKING,
	#[serde( rename = "unlocked" )]
	VS_UNLOCKED,
	#[serde( rename = "locked" )]
	VS_LOCKED,				// a password is set and hasn't been entered yet
	#[serde( rename = "needsPassword" )]
	VS_NEEDS_PASSWORD,		// first run on a system with no key store: a password must be chosen
}

#[derive( Clone, Debug, Serialize, Type )]
pub struct vaultStatus_t {
	pub state:					vaultState_t,
	pub protection:				Option< protection_t >,
	pub osProtectionAvailable:	bool,
	pub minPasswordLen:			u32,
}

// what a sealed file holds; bound into the ciphertext, so a names file
// can never be opened as a wallet file or the other way round
#[derive( Clone, Copy, PartialEq, Eq, Debug )]
pub enum purpose_t {
	PURPOSE_WALLET,
	PURPOSE_META,
	PURPOSE_CONTACTS,
	PURPOSE_NOTES,
	PURPOSE_REPEATS,
	PURPOSE_SYNC,			// this computer's sync state: the sync key among it (w_folder.rs)
	PURPOSE_SYNC_FILE,		// a computer's file in the shared folder, sealed with the sync key
	PURPOSE_OFFLINE,		// signing requests waiting for their signed payment (w_offline.rs)
}

impl purpose_t {
	fn tag( self ) -> &'static [ u8 ] {
		match self {
			purpose_t::PURPOSE_WALLET	=> b"wallet",
			purpose_t::PURPOSE_META		=> b"meta",
			purpose_t::PURPOSE_CONTACTS	=> b"contacts",
			purpose_t::PURPOSE_NOTES	=> b"notes",
			purpose_t::PURPOSE_REPEATS	=> b"repeats",
			purpose_t::PURPOSE_SYNC		=> b"sync",
			purpose_t::PURPOSE_SYNC_FILE	=> b"sync-file",
			purpose_t::PURPOSE_OFFLINE	=> b"offline",
		}
	}
}

// the unlocked wallet key, only while unlocked
static v_key: Mutex< Option< key_t > > = Mutex::new( None );

// vault file changes happen one at a time
static v_fileLock: Mutex< () > = Mutex::new( () );

static v_locking: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new( false );

// woken whenever the vault may have become usable: a key set, a lock ended
static v_usable: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub struct vaultLockGuard_t;
impl Drop for vaultLockGuard_t {
	fn drop( &mut self ) {
		v_locking.store( false, std::sync::atomic::Ordering::SeqCst );
		v_usable.notify_waiters();		// a lock that failed leaves the key in place
	}
}

// hide the wallet before waiting for network work and its final save
pub fn V_BeginLock() -> wresult_t< vaultLockGuard_t > {
	if ( v_locking.swap( true, std::sync::atomic::Ordering::SeqCst ) ) {
		return Err( werr_t::WERR_BUSY );
	}
	Ok( vaultLockGuard_t )
}


/*
=========================================================================

SEALING FILES

format: magic (8) | nonce (24) | ciphertext + tag
associated data: magic | purpose

=========================================================================
*/

fn V_Aad( purpose: purpose_t ) -> Vec< u8 > {
	[ FILE_MAGIC.as_slice(), purpose.tag() ].concat()
}

/*
==================
V_SealWith
==================
*/
pub fn V_SealWith( key: &[ u8; KEY_LEN ], purpose: purpose_t, plain: &[ u8 ] ) -> wresult_t< Vec< u8 > > {
	let cipher = XChaCha20Poly1305::new( key.into() );
	let nonce = XChaCha20Poly1305::generate_nonce( &mut OsRng );
	let sealed = cipher.encrypt( &nonce, Payload { msg: plain, aad: &V_Aad( purpose ) } )
		.map_err( |_| werr_t::WERR_ENGINE( "encrypting failed".to_string() ) )?;

	let mut out = Vec::with_capacity( FILE_MAGIC.len() + NONCE_LEN + sealed.len() );
	out.extend_from_slice( FILE_MAGIC );
	out.extend_from_slice( &nonce );
	out.extend_from_slice( &sealed );
	Ok( out )
}

/*
==================
V_OpenWith

Any change to any byte, or the wrong key or purpose, fails the tag check
==================
*/
pub fn V_OpenWith( key: &[ u8; KEY_LEN ], purpose: purpose_t, data: &[ u8 ] ) -> wresult_t< Zeroizing< Vec< u8 > > > {
	if ( !V_IsSealed( data ) || data.len() < FILE_MAGIC.len() + NONCE_LEN + TAG_LEN ) {
		return Err( werr_t::WERR_NOT_SEALED );
	}
	let nonce = XNonce::from_slice( &data[ FILE_MAGIC.len()..FILE_MAGIC.len() + NONCE_LEN ] );
	let sealed = &data[ FILE_MAGIC.len() + NONCE_LEN.. ];

	XChaCha20Poly1305::new( key.into() )
		.decrypt( nonce, Payload { msg: sealed, aad: &V_Aad( purpose ) } )
		.map( Zeroizing::new )
		.map_err( |_| werr_t::WERR_WRONG_KEY )
}

/*
==================
Com_Hash

A BLAKE2b digest of data, len bytes long; the 16-byte personalization
separates its uses. This is an unkeyed checksum, not authentication.
The one place a hash is made: the recovery words' print, the sync code's
checksum, a signing file's hash.
==================
*/
pub fn Com_Hash( personal: &[ u8; 16 ], len: usize, data: &[ u8 ] ) -> Vec< u8 > {
	blake2b_simd::Params::new().hash_length( len ).personal( personal ).hash( data ).as_bytes().to_vec()
}

// n random bytes as hex, from the system's generator (intents, sync devices)
pub fn Com_RandomHex( n: usize ) -> String {
	let mut bytes = Zeroizing::new( vec![ 0u8; n ] );
	OsRng.fill_bytes( &mut bytes );
	bytes.iter().map( |b| format!( "{b:02x}" ) ).collect()
}

// 32 random bytes, for a key (the sync key)
pub fn Com_RandomKey() -> [ u8; KEY_LEN ] {
	let mut key = [ 0u8; KEY_LEN ];
	OsRng.fill_bytes( &mut key );
	key
}

pub fn V_IsSealed( data: &[ u8 ] ) -> bool {
	data.starts_with( FILE_MAGIC )
}


/*
=========================================================================

PROTECTING THE WALLET KEY

=========================================================================
*/

/*
==================
V_CheckPassword
==================
*/
pub fn V_CheckPassword( password: &str ) -> wresult_t< () > {
	if ( password.chars().count() < MIN_PASSWORD_LEN as usize || password.trim().is_empty() ) {
		return Err( werr_t::WERR_WEAK_PASSWORD( MIN_PASSWORD_LEN ) );
	}
	if ( password.len() > MAX_PASSWORD_LEN ) {
		return Err( werr_t::WERR_WEAK_PASSWORD( MIN_PASSWORD_LEN ) );
	}
	Ok( () )
}

/*
==================
V_DeriveKek

Argon2id, version 0x13, 32-byte output
==================
*/
#[cfg( test )]
thread_local! {
	// how many keys this test's thread derived: a file refused before deriving shows none
	static V_TEST_DERIVED: std::cell::Cell< u32 > = const { std::cell::Cell::new( 0 ) };
}

fn V_DeriveKek( password: &str, salt: &[ u8 ], params: kdfParams_t ) -> wresult_t< key_t > {
	#[cfg( test )]
	V_TEST_DERIVED.with( |n| n.set( n.get() + 1 ) );
	let p = Params::new( params.mKib, params.t, params.p, Some( KEY_LEN ) )
		.map_err( |e| {
			log::warn!( "the key file's settings are invalid: {}", e.to_string() );
			werr_t::WERR_CORRUPT( file_t::FILE_VAULT )
		} )?;
	let mut kek: key_t = Zeroizing::new( [ 0u8; KEY_LEN ] );

	Argon2::new( Algorithm::Argon2id, Version::V0x13, p )
		.hash_password_into( password.as_bytes(), salt, kek.as_mut_slice() )
		.map_err( |e| werr_t::WERR_ENGINE( format!( "deriving the password key failed: {e}" ) ) )?;
	Ok( kek )
}

// the KDF probe's derive and settings (w_probe.rs): KDF_DEFAULT on a throwaway password
#[cfg( feature = "kdf-probe" )]
pub fn V_ProbeDerive() -> bool {
	V_DeriveKek( "kdf probe, not a password", &[ 7u8; SALT_LEN ], KDF_DEFAULT ).is_ok()
}

#[cfg( feature = "kdf-probe" )]
pub fn V_ProbeSettings() -> String {
	format!( "{} MiB, t {}, p {}", KDF_DEFAULT.mKib / 1024, KDF_DEFAULT.t, KDF_DEFAULT.p )
}

/*
==================
V_WrapWithPassword

A fresh salt and nonce every time, so the same password never produces
the same file
==================
*/
fn V_WrapWithPassword( key: &[ u8; KEY_LEN ], password: &str, params: kdfParams_t ) -> wresult_t< vaultFile_t > {
	V_CheckPassword( password )?;

	let mut salt = [ 0u8; SALT_LEN ];
	OsRng.fill_bytes( &mut salt );
	let kek = V_DeriveKek( password, &salt, params )?;

	let nonce = XChaCha20Poly1305::generate_nonce( &mut OsRng );
	let sealed = XChaCha20Poly1305::new( ( &*kek ).into() )
		.encrypt( &nonce, Payload { msg: key, aad: WRAP_AAD } )
		.map_err( |_| werr_t::WERR_ENGINE( "wrapping the wallet key failed".to_string() ) )?;

	Ok( vaultFile_t {
		version:	VAULT_VERSION,
		protection:	protection_t::PROT_PASSWORD,
		kdf:		Some( kdfFile_t {
			alg:	"argon2id".to_string(),
			mKib:	params.mKib,
			t:		params.t,
			p:		params.p,
			salt:	B64.encode( salt ),
		} ),
		wrapped:	B64.encode( [ nonce.as_slice(), &sealed ].concat() ),
	} )
}

/*
==================
V_UnwrapWithPassword

A wrong password and a tampered file look the same: the tag doesn't
verify. Either way the answer is "that password isn't right".
==================
*/
fn V_UnwrapWithPassword( file: &vaultFile_t, password: &str ) -> wresult_t< key_t > {
	let damaged = || werr_t::WERR_CORRUPT( file_t::FILE_VAULT );

	let kdf = file.kdf.as_ref().ok_or_else( damaged )?;
	let params = kdfParams_t { mKib: kdf.mKib, t: kdf.t, p: kdf.p };
	let salt = B64.decode( &kdf.salt ).map_err( |_| damaged() )?;
	let wrapped = Zeroizing::new( B64.decode( &file.wrapped ).map_err( |_| damaged() )? );
	if ( kdf.alg != "argon2id" || !Com_KdfAllowed( params, salt.len(), KDF_FLOOR, KDF_CEILING ) || wrapped.len() != NONCE_LEN + KEY_LEN + TAG_LEN ) {
		return Err( damaged() );
	}

	let kek = V_DeriveKek( password, &salt, params )?;
	let plain = Zeroizing::new( XChaCha20Poly1305::new( ( &*kek ).into() )
		.decrypt( XNonce::from_slice( &wrapped[..NONCE_LEN] ), Payload { msg: &wrapped[NONCE_LEN..], aad: WRAP_AAD } )
		.map_err( |_| werr_t::WERR_BAD_PASSWORD )? );

	let mut key: key_t = Zeroizing::new( [ 0u8; KEY_LEN ] );
	key.copy_from_slice( &plain );
	Ok( key )
}

/*
==================
V_OsProtect / V_OsUnprotect

Windows DPAPI for the current user. Nothing is shown to the user; the
entropy only keeps other apps' DPAPI blobs from being mistaken for ours.
==================
*/
#[cfg( windows )]
mod os {
	use super::*;
	use windows_sys::Win32::Foundation::LocalFree;
	use windows_sys::Win32::Security::Cryptography::{ CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB };

	pub const AVAILABLE: bool = true;

	fn Blob( data: &[ u8 ] ) -> CRYPT_INTEGER_BLOB {
		CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
	}

	/*
	==================
	Take

	Copies DPAPI's output out and frees it; the copy is zeroized on drop
	==================
	*/
	unsafe fn Take( out: CRYPT_INTEGER_BLOB ) -> Zeroizing< Vec< u8 > > {
		let bytes = Zeroizing::new( std::slice::from_raw_parts( out.pbData, out.cbData as usize ).to_vec() );
		std::ptr::write_bytes( out.pbData, 0, out.cbData as usize );
		LocalFree( out.pbData as _ );
		bytes
	}

	pub fn Protect( plain: &[ u8 ] ) -> wresult_t< Vec< u8 > > {
		let input = Blob( plain );
		let entropy = Blob( DPAPI_ENTROPY );
		let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

		// SAFETY: input and entropy point at live slices for the call; out is
		// filled by DPAPI and freed in Take
		let ok = unsafe { CryptProtectData( &input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out ) };
		if ( ok == 0 ) {
			return Err( werr_t::WERR_OS_KEY( std::io::Error::last_os_error().to_string() ) );
		}
		Ok( unsafe { Take( out ) }.to_vec() )
	}

	pub fn Unprotect( blob: &[ u8 ] ) -> wresult_t< Zeroizing< Vec< u8 > > > {
		let input = Blob( blob );
		let entropy = Blob( DPAPI_ENTROPY );
		let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

		// SAFETY: as in Protect
		let ok = unsafe { CryptUnprotectData( &input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out ) };
		if ( ok == 0 ) {
			return Err( werr_t::WERR_OS_KEY( std::io::Error::last_os_error().to_string() ) );
		}
		Ok( unsafe { Take( out ) } )
	}
}

// no key store wired up yet: a password is required (see docs/ROADMAP.md)
#[cfg( not( windows ) )]
mod os {
	use super::*;

	pub const AVAILABLE: bool = false;

	pub fn Protect( _: &[ u8 ] ) -> wresult_t< Vec< u8 > > {
		Err( werr_t::WERR_NO_OS_PROTECTION )
	}

	pub fn Unprotect( _: &[ u8 ] ) -> wresult_t< Zeroizing< Vec< u8 > > > {
		Err( werr_t::WERR_NO_OS_PROTECTION )
	}
}

fn V_WrapWithOs( key: &[ u8; KEY_LEN ] ) -> wresult_t< vaultFile_t > {
	Ok( vaultFile_t {
		version:	VAULT_VERSION,
		protection:	protection_t::PROT_OS,
		kdf:		None,
		wrapped:	B64.encode( os::Protect( key )? ),
	} )
}

fn V_UnwrapWithOs( file: &vaultFile_t ) -> wresult_t< key_t > {
	let blob = B64.decode( &file.wrapped )
		.map_err( |_| werr_t::WERR_CORRUPT( file_t::FILE_VAULT ) )?;
	let plain = os::Unprotect( &blob )?;
	if ( plain.len() != KEY_LEN ) {
		return Err( werr_t::WERR_CORRUPT( file_t::FILE_VAULT ) );
	}
	let mut key: key_t = Zeroizing::new( [ 0u8; KEY_LEN ] );
	key.copy_from_slice( &plain );
	Ok( key )
}

fn V_NewKey() -> key_t {
	let mut key: key_t = Zeroizing::new( [ 0u8; KEY_LEN ] );
	OsRng.fill_bytes( key.as_mut_slice() );
	key
}


/*
=========================================================================

THE VAULT FILE

=========================================================================
*/

fn V_Path() -> PathBuf {
	Com_DataPath( VAULT_FILE_NAME ).expect( "W_Init not called" )
}

/*
==================
V_ReadFile

None when there is no vault yet. A file that exists but can't be read
is an error, never "no vault": treating it as missing would make a new
key and orphan every wallet.
==================
*/
fn V_ReadFile() -> wresult_t< Option< vaultFile_t > > {
	let Some( file ) = Com_ReadJson::< vaultFile_t >( &V_Path(), file_t::FILE_VAULT )? else {
		return Ok( None );
	};
	if ( file.version > VAULT_VERSION ) {
		return Err( werr_t::WERR_VAULT_NEWER );
	}
	Ok( Some( file ) )
}

/*
==================
V_Commit / Com_Commit

The one way the key file is written: then read back from the disk and
opened with its new secret, and only a file that gives back the same
wallet key counts. One that doesn't (a write that landed wrong) is
undone: the previous file goes back, so the old password still opens
it, or on a first run the bad file is removed, so no wallet is ever
sealed with a key its file can't give back. Storage comes in as
arguments so the proof itself is tested.
==================
*/
fn V_Commit( prev: Option< &vaultFile_t >, made: &vaultFile_t, key: &[ u8; KEY_LEN ], reopen: impl FnOnce( &vaultFile_t ) -> wresult_t< key_t > ) -> wresult_t< () > {
	// the file's only writer, inside the only function that proves what it wrote
	let write = |file: &vaultFile_t| {
		Com_WriteJson( &V_Path(), file )
	};
	let forget = || {
		let _ = std::fs::remove_file( V_Path() );
	};
	Com_Commit( write, V_ReadFile, forget, prev, made, key, reopen )
}

fn Com_Commit(
	write:	impl Fn( &vaultFile_t ) -> wresult_t< () >,
	read:	impl Fn() -> wresult_t< Option< vaultFile_t > >,
	forget:	impl Fn(),
	prev:	Option< &vaultFile_t >,
	made:	&vaultFile_t,
	key:	&[ u8; KEY_LEN ],
	reopen:	impl FnOnce( &vaultFile_t ) -> wresult_t< key_t >,
) -> wresult_t< () > {
	write( made )?;
	let proven = match read() {
		Ok( Some( back ) ) => reopen( &back ).is_ok_and( |k| *k == *key ),
		Ok( None ) | Err( _ ) => false,
	};
	if ( proven ) {
		return Ok( () );
	}
	match prev {
		Some( p ) => write( p )?,
		None => forget(),
	}
	Err( werr_t::WERR_VAULT_WRITE )
}

/*
==================
V_AnySealedWallet

Is there any encrypted wallet data on disk, for any network? If so, a
missing vault must not be replaced by a new one.
==================
*/
fn V_AnySealedWallet() -> bool {
	let Some( root ) = Com_DataPath( WALLETS_DIR_NAME ) else {
		return false;
	};
	let Ok( nets ) = std::fs::read_dir( &root ) else {
		return false;
	};

	for net in nets.flatten() {
		let Ok( wallets ) = std::fs::read_dir( net.path() ) else {
			continue;
		};
		for wallet in wallets.flatten() {
			for name in [ WALLET_FILE_NAME, META_FILE_NAME ] {
				if ( Com_StartsSealed( &wallet.path().join( name ) ) ) {
					return true;
				}
			}
		}
	}
	false
}

fn Com_StartsSealed( path: &Path ) -> bool {
	use std::io::Read;

	let mut head = [ 0u8; 8 ];
	std::fs::File::open( path ).and_then( |mut f| f.read_exact( &mut head ) ).is_ok() && V_IsSealed( &head )
}


/*
=========================================================================

THE UNLOCKED KEY

=========================================================================
*/

fn V_SetKey( key: key_t ) {
	*v_key.lock().unwrap() = Some( key );
	v_usable.notify_waiters();
}

// tests elsewhere need an unlocked vault without a vault file. One key
// for the whole test run: tests run in parallel, and a key swapped between
// one test's seal and open would fail it at random
#[cfg( test )]
pub fn V_TestUnlock() -> [ u8; KEY_LEN ] {
	static TEST_KEY: std::sync::OnceLock< [ u8; KEY_LEN ] > = std::sync::OnceLock::new();

	let key = *TEST_KEY.get_or_init( || *V_NewKey() );
	V_SetKey( Zeroizing::new( key ) );
	key
}

/*
==================
V_Key

A copy of the wallet key for one operation; zeroized when dropped
==================
*/
fn V_Key() -> wresult_t< key_t > {
	match v_key.lock().unwrap().as_ref() {
		Some( k ) => Ok( Zeroizing::new( **k ) ),
		None => Err( werr_t::WERR_LOCKED ),
	}
}

pub fn V_Seal( purpose: purpose_t, plain: &[ u8 ] ) -> wresult_t< Vec< u8 > > {
	let key = V_Key()?;
	V_SealWith( &key, purpose, plain )
}

pub fn V_Unseal( purpose: purpose_t, data: &[ u8 ] ) -> wresult_t< Zeroizing< Vec< u8 > > > {
	let key = V_Key()?;
	V_OpenWith( &key, purpose, data )
}

/*
==================
V_ReadSealed

A small file of the person's own (contacts, notes), sealed for purpose.
No file yet is the empty value; a file that can't be opened or read is
an error naming what, never silently empty: saving over it would erase
it. A plain file is refused (WERR_NOT_SEALED): read, it would let anyone
who can write the folder change a saved address without the password.
==================
*/
pub fn V_ReadSealed< T: serde::de::DeserializeOwned + Default >( path: &Path, purpose: purpose_t, what: file_t ) -> wresult_t< T > {
	let Some( raw ) = Com_ReadIfThere( path, what )? else {
		return Ok( T::default() );
	};
	let text = V_Unseal( purpose, &raw )?;
	Com_ParseJson( &text, what )
}

pub fn V_WriteSealed< T: Serialize >( path: &Path, purpose: purpose_t, value: &T ) -> wresult_t< () > {
	Com_MakeFolderFor( path )?;
	let text = Zeroizing::new( serde_json::to_vec( value ).engine()? );
	Com_WriteAtomic( path, &V_Seal( purpose, &text )? )
}

/*
==================
V_EditSealed

One change to a sealed file of the person's own, under its lock: read,
edited and written as one, and written only when the edit changed it.
The edit's answer comes back. Contacts, notes and the signing requests
each had their own copy of this, one writing when nothing changed.
==================
*/
pub async fn V_EditSealed< T, R >( lock: &tokio::sync::Mutex< () >, path: &Path, purpose: purpose_t, what: file_t, edit: impl FnOnce( &mut T ) -> R ) -> wresult_t< R >
where
	T: serde::de::DeserializeOwned + Serialize + Default + Clone + PartialEq,
{
	let _writing = lock.lock().await;
	let mut value: T = V_ReadSealed( path, purpose, what )?;
	let before = value.clone();
	let r = edit( &mut value );
	if ( value != before ) {
		V_WriteSealed( path, purpose, &value )?;
	}
	Ok( r )
}

pub fn V_IsUnlocked() -> bool {
	v_key.lock().unwrap().is_some()
}

// unlocked, and not on its way to locking: what VS_UNLOCKED reports
pub fn V_IsUsable() -> bool {
	V_IsUnlocked() && !v_locking.load( std::sync::atomic::Ordering::SeqCst )
}

/*
==================
V_WhenUsable

Returns once the vault is usable, or WERR_LOCKED after wait. The wake is
armed before the check, so an unlock between the two is never missed.
==================
*/
#[cfg_attr( desktop, allow( dead_code ) )]		// only a mobile picker leaves Laurel
pub async fn V_WhenUsable( wait: std::time::Duration ) -> wresult_t< () > {
	let deadline = tokio::time::Instant::now() + wait;
	loop {
		let woken = v_usable.notified();
		tokio::pin!( woken );
		woken.as_mut().enable();
		if ( V_IsUsable() ) {
			return Ok( () );
		}
		if ( tokio::time::timeout_at( deadline, woken ).await.is_err() ) {
			return Err( werr_t::WERR_LOCKED );
		}
	}
}

/*
==================
V_Forget

The key leaves memory (zeroized as it drops). Only W_Lock calls this,
after every wallet is saved and closed.
==================
*/
pub fn V_Forget() {
	*v_key.lock().unwrap() = None;
}


/*
=========================================================================

OPERATIONS

each takes the file lock, so two can never interleave

=========================================================================
*/

fn V_StatusOf( file: Option< &vaultFile_t > ) -> vaultStatus_t {
	let state = if ( V_IsUsable() ) {
		vaultState_t::VS_UNLOCKED
	} else if ( v_locking.load( std::sync::atomic::Ordering::SeqCst ) ) {
		vaultState_t::VS_LOCKING
	} else if ( file.is_none() ) {
		vaultState_t::VS_NEEDS_PASSWORD
	} else {
		vaultState_t::VS_LOCKED
	};

	vaultStatus_t {
		state:					state,
		protection:				file.map( |f| f.protection ),
		osProtectionAvailable:	os::AVAILABLE,
		minPasswordLen:			MIN_PASSWORD_LEN,
	}
}

/*
==================
V_Open

Called at start. A vault protected by windows unlocks at once. With no
vault yet (first run), one is made, protected by windows, unless
encrypted wallets already exist: then the key is missing and making a
new one would lock them away for good.
==================
*/
pub fn V_Open() -> wresult_t< vaultStatus_t > {
	let _guard = v_fileLock.lock().unwrap();
	let file = V_ReadFile()?;

	if ( V_IsUnlocked() ) {
		return Ok( V_StatusOf( file.as_ref() ) );
	}

	match &file {
		None => {
			if ( V_AnySealedWallet() ) {
				return Err( werr_t::WERR_VAULT_MISSING );
			}
			if ( os::AVAILABLE ) {
				let key = V_NewKey();
				let made = V_WrapWithOs( &key )?;
				V_Commit( None, &made, &key, V_UnwrapWithOs )?;
				V_SetKey( key );
				return Ok( V_StatusOf( Some( &made ) ) );
			}
		}
		Some( f ) if f.protection == protection_t::PROT_OS => {
			V_SetKey( V_UnwrapWithOs( f )? );
		}
		Some( _ ) => {}		// password: stays locked until V_Unlock
	}
	Ok( V_StatusOf( file.as_ref() ) )
}

/*
==================
V_Create

First run with no key store: the user chose a password
==================
*/
pub fn V_Create( password: &str ) -> wresult_t< vaultStatus_t > {
	let _guard = v_fileLock.lock().unwrap();

	if ( V_ReadFile()?.is_some() ) {
		return Err( werr_t::WERR_ENGINE( "Laurel's key already exists.".to_string() ) );
	}
	if ( V_AnySealedWallet() ) {
		return Err( werr_t::WERR_VAULT_MISSING );
	}

	let key = V_NewKey();
	let made = V_WrapWithPassword( &key, password, KDF_DEFAULT )?;
	V_Commit( None, &made, &key, |f| V_UnwrapWithPassword( f, password ) )?;
	V_SetKey( key );
	Ok( V_StatusOf( Some( &made ) ) )
}

/*
==================
V_Unlock
==================
*/
pub fn V_Unlock( password: &str ) -> wresult_t< vaultStatus_t > {
	let _guard = v_fileLock.lock().unwrap();
	if ( v_locking.load( std::sync::atomic::Ordering::SeqCst ) ) {
		return Err( werr_t::WERR_BUSY );
	}
	let file = V_ReadFile()?.ok_or( werr_t::WERR_VAULT_MISSING )?;

	if ( !V_IsUnlocked() ) {
		V_SetKey( match file.protection {
			protection_t::PROT_PASSWORD	=> V_UnwrapWithPassword( &file, password )?,
			protection_t::PROT_OS		=> V_UnwrapWithOs( &file )?,
		} );
	}
	Ok( V_StatusOf( Some( &file ) ) )
}

/*
==================
V_SetPassword

From windows protection to a password. Laurel must be unlocked.
==================
*/
pub fn V_SetPassword( password: &str ) -> wresult_t< vaultStatus_t > {
	let _guard = v_fileLock.lock().unwrap();
	let file = V_ReadFile()?.ok_or( werr_t::WERR_VAULT_MISSING )?;

	if ( file.protection == protection_t::PROT_PASSWORD ) {
		return Err( werr_t::WERR_ENGINE( "A password is already set. Change it instead.".to_string() ) );
	}
	let key = V_Key()?;
	let made = V_WrapWithPassword( &key, password, KDF_DEFAULT )?;
	V_Commit( Some( &file ), &made, &key, |f| V_UnwrapWithPassword( f, password ) )?;
	Ok( V_StatusOf( Some( &made ) ) )
}

/*
==================
V_Rewrap

The one way an existing password is replaced or removed. The current
password is checked against the file, not just the unlocked key in
memory: someone at an unlocked laurel can't change it without it. Then
the same wallet key is protected the new way and written.
==================
*/
fn V_Rewrap< F, R >( current: &str, protect: F, reopen: R ) -> wresult_t< vaultStatus_t >
where
	F: FnOnce( &[ u8; KEY_LEN ] ) -> wresult_t< vaultFile_t >,
	R: FnOnce( &vaultFile_t ) -> wresult_t< key_t >,
{
	let _guard = v_fileLock.lock().unwrap();
	let file = V_ReadFile()?.ok_or( werr_t::WERR_VAULT_MISSING )?;

	if ( file.protection != protection_t::PROT_PASSWORD ) {
		return Err( werr_t::WERR_ENGINE( "No password is set.".to_string() ) );
	}
	let key = V_UnwrapWithPassword( &file, current )?;
	let made = protect( &key )?;
	V_Commit( Some( &file ), &made, &key, reopen )?;
	Ok( V_StatusOf( Some( &made ) ) )
}

pub fn V_ChangePassword( current: &str, password: &str ) -> wresult_t< vaultStatus_t > {
	V_Rewrap( current, |key| V_WrapWithPassword( key, password, KDF_DEFAULT ), |f| V_UnwrapWithPassword( f, password ) )
}

// back to windows protection
pub fn V_RemovePassword( current: &str ) -> wresult_t< vaultStatus_t > {
	V_Rewrap( current, V_WrapWithOs, V_UnwrapWithOs )
}

/*
==================
V_MayStartOver / Com_MayStartOver

Whether Start Over may erase this device's wallets now: while locked,
and when the key can't be had at all (W1-03): its file damaged (it
reads, and isn't a key file), or gone while wallets sealed with it are
still here. A file that only couldn't be read just now is refused: the
key in it may be fine, and erasing would lose wallets never backed up. Never while open (each
wallet has its own Remove) or locking, and never for a newer Laurel's
file: an update opens that. Start Over makes no key; the next start does,
over an empty folder.
==================
*/
pub fn V_MayStartOver() -> wresult_t< () > {
	let _guard = v_fileLock.lock().unwrap();
	let read = V_ReadFile();
	let locking = v_locking.load( std::sync::atomic::Ordering::SeqCst );
	Com_MayStartOver( &read, V_IsUnlocked(), locking, || V_AnySealedWallet() )
}

fn Com_MayStartOver( read: &wresult_t< Option< vaultFile_t > >, unlocked: bool, locking: bool, sealed: impl FnOnce() -> bool ) -> wresult_t< () > {
	if ( unlocked || locking ) {
		return Err( werr_t::WERR_ENGINE( "starting over is for a locked Laurel".to_string() ) );
	}
	match read {
		Ok( Some( _ ) )						=> Ok( () ),
		Ok( None ) if sealed()				=> Ok( () ),
		Ok( None )							=> Err( werr_t::WERR_ENGINE( "there is nothing to start over from".to_string() ) ),
		// damaged for real: it read, and isn't a key file any more
		Err( werr_t::WERR_CORRUPT( file_t::FILE_VAULT ) )	=> Ok( () ),
		Err( werr_t::WERR_VAULT_NEWER )		=> Err( werr_t::WERR_VAULT_NEWER ),
		// only couldn't be read just now (held open, storage not ready): the key may be fine
		Err( _ )							=> Err( werr_t::WERR_ENGINE( "Laurel couldn't read its key file just now. Close Laurel, open it again, and try again.".to_string() ) ),
	}
}

pub fn V_Status() -> wresult_t< vaultStatus_t > {
	let _guard = v_fileLock.lock().unwrap();
	Ok( V_StatusOf( V_ReadFile()?.as_ref() ) )
}

/*
==================
present_t

Proof that the person at the keyboard was just asked who they are. The
things an unlocked Laurel left alone for a minute must not give away (a
recovery phrase, a looser auto-lock) take one, and only V_Confirm and
V_Made can make one: a way around the question doesn't compile.
==================
*/
pub struct present_t {
	_asked:	(),
}

/*
==================
V_Confirm

With a password: that password, checked against the key file (not the
key in memory, which anyone at an unlocked Laurel already has). Without
one there is nobody to ask; Windows already did, and the screens say so.
==================
*/
pub fn V_Confirm( password: Option< &str > ) -> wresult_t< present_t > {
	let _guard = v_fileLock.lock().unwrap();
	V_ConfirmWith( &V_ReadFile()?.ok_or( werr_t::WERR_VAULT_MISSING )?, password )
}

fn V_ConfirmWith( file: &vaultFile_t, password: Option< &str > ) -> wresult_t< present_t > {
	if ( file.protection == protection_t::PROT_PASSWORD ) {
		V_UnwrapWithPassword( file, password.ok_or( werr_t::WERR_CONFIRM )? )?;
	}
	Ok( present_t { _asked: () } )
}

/*
==================
V_Made

A wallet made this moment: the person who made it is the one looking,
and it holds nothing yet. Only W_Create (check_owners).
==================
*/
pub fn V_Made() -> present_t {
	present_t { _asked: () }
}


/*
=========================================================================

TESTS

cheap argon2 settings keep them fast; the default settings are checked
separately against the RFC 9106 floor

=========================================================================
*/

#[cfg( test )]
mod tests {
	use super::*;

	const FAST: kdfParams_t = kdfParams_t { mKib: 8 * 1024, t: 1, p: 1 };

	// and a waiter (a picker's caller) goes on when the lock ends, woken, not
	// by polling or by its time running out; one test, as only one may lock
	#[tokio::test]
	async fn locking_hides_the_vault_and_refuses_a_concurrent_unlock() {
		V_TestUnlock();
		let locking = V_BeginLock().unwrap();
		assert_eq!( V_StatusOf( None ).state, vaultState_t::VS_LOCKING );
		assert!( V_IsUnlocked() && !V_IsUsable(), "usable while locking: a wallet could be installed (W1-02)" );
		assert!( matches!( V_BeginLock(), Err( werr_t::WERR_BUSY ) ) );
		assert!( matches!( V_Unlock( "unused" ), Err( werr_t::WERR_BUSY ) ) );
		assert!( matches!( V_WhenUsable( std::time::Duration::from_millis( 20 ) ).await, Err( werr_t::WERR_LOCKED ) ) );

		let waiter = tokio::spawn( V_WhenUsable( std::time::Duration::from_secs( 30 ) ) );
		tokio::time::sleep( std::time::Duration::from_millis( 20 ) ).await;
		let ended = std::time::Instant::now();
		drop( locking );
		waiter.await.unwrap().unwrap();
		assert!( ended.elapsed() < std::time::Duration::from_secs( 5 ) );
		assert_eq!( V_StatusOf( None ).state, vaultState_t::VS_UNLOCKED );
		assert!( V_IsUsable(), "a lock that ended leaves the vault usable" );
	}

	/*
	==================
	start_over_is_for_a_locked_or_broken_key

	W1-03: a key file missing (wallets sealed with it still there) or
	damaged left a screen with nothing to do, and on Android no folder to
	clear by hand. Start Over is allowed then, as when locked; never while
	open, and never for a newer Laurel's file, which an update opens
	==================
	*/
	#[test]
	fn start_over_is_for_a_locked_or_broken_key() {
		let file = V_WrapWithPassword( &Key(), "correct horse", FAST ).unwrap();
		let may = |read: wresult_t< Option< vaultFile_t > >, unlocked: bool, locking: bool, sealed: bool| Com_MayStartOver( &read, unlocked, locking, || sealed ).is_ok();
		assert!( may( Ok( Some( file.clone() ) ), false, false, true ), "locked" );
		assert!( may( Err( werr_t::WERR_CORRUPT( file_t::FILE_VAULT ) ), false, false, true ), "a damaged key file" );
		assert!( may( Ok( None ), false, false, true ), "the key file gone, its wallets still here" );
		assert!( !may( Ok( Some( file.clone() ) ), true, false, true ), "open: each wallet has its own Remove" );
		assert!( !may( Ok( Some( file.clone() ) ), false, true, true ), "while locking" );
		assert!( !may( Err( werr_t::WERR_VAULT_NEWER ), false, false, true ), "a newer Laurel's key: an update opens it" );
		assert!( !may( Ok( None ), false, false, false ), "nothing here yet: a first run makes its key" );
		// a file that couldn't be read just now (held open, storage not mounted yet) is a key that's fine
		assert!( !may( Err( werr_t::WERR_ENGINE( "reading Laurel's key: access denied".to_string() ) ), false, false, true ), "a read that failed, not a damaged file" );
	}

	/*
	==================
	a_key_file_out_of_bounds_is_damaged_before_deriving

	W1-06: a key file could ask for 4 GiB and 64 passes, all derived before
	the tag said no, and settings weaker than Laurel ever wrote opened
	too. Laurel has only written KDF_DEFAULT (256 MiB, t 3, p 4, a 16-byte
	salt), so the floor strands nobody. Release limits here; the files
	below meet a test floor, as every test's FAST file must open
	==================
	*/
	#[test]
	fn the_release_limits_are_rfc_floor_to_a_gigabyte() {
		let ok = |m: u32, t: u32, p: u32, salt: usize| Com_KdfAllowed( kdfParams_t { mKib: m, t: t, p: p }, salt, KDF_RELEASE_FLOOR, KDF_RELEASE_CEILING );
		assert!( ok( KDF_DEFAULT.mKib, KDF_DEFAULT.t, KDF_DEFAULT.p, SALT_LEN ), "Laurel's own settings" );
		assert!( ok( 64 * 1024, 3, 1, 16 ) && ok( 1024 * 1024, 10, 8, 32 ), "the edges themselves" );
		assert!( !ok( 64 * 1024 - 1, 3, 4, 16 ), "under 64 MiB" );
		assert!( !ok( 8 * 1024, 3, 4, 16 ), "8 MiB" );
		assert!( !ok( 256 * 1024, 2, 4, 16 ), "under 3 passes" );
		assert!( !ok( 256 * 1024, 3, 4, 15 ), "a salt under 16 bytes" );
		assert!( !ok( 1024 * 1024 + 1, 3, 4, 16 ), "over 1 GiB" );
		assert!( !ok( 4 * 1024 * 1024, 3, 4, 16 ), "4 GiB" );
		assert!( !ok( 256 * 1024, 11, 4, 16 ), "over 10 passes" );
		assert!( !ok( 256 * 1024, 3, 9, 16 ), "over 8 lanes" );
		assert!( !ok( 256 * 1024, 3, 0, 16 ), "no lanes" );
	}

	#[test]
	fn a_key_file_out_of_bounds_is_damaged_before_deriving() {
		let good = V_WrapWithPassword( &Key(), "correct horse", FAST ).unwrap();
		let with = |edit: &dyn Fn( &mut kdfFile_t )| {
			let mut file = good.clone();
			edit( file.kdf.as_mut().unwrap() );
			file
		};
		// each is cheap to derive, so the old rules ran Argon2 on it before the tag said no
		let cases = [
			( "a short salt", with( &|k| k.salt = B64.encode( [ 7u8; 15 ] ) ) ),
			( "too many passes", with( &|k| k.t = KDF_CEILING.t + 1 ) ),
			( "too many lanes", with( &|k| k.p = KDF_CEILING.p + 1 ) ),
			( "too little memory", with( &|k| k.mKib = KDF_FLOOR.mKib / 2 ) ),
		];
		for ( what, file ) in cases {
			let before = V_TEST_DERIVED.with( |n| n.get() );
			let opened = V_UnwrapWithPassword( &file, "correct horse" );
			assert!( matches!( opened, Err( werr_t::WERR_CORRUPT( file_t::FILE_VAULT ) ) ), "{what}: not refused as damaged" );
			assert_eq!( V_TEST_DERIVED.with( |n| n.get() ), before, "{what}: derived before refusing" );
		}
		assert!( V_UnwrapWithPassword( &good, "correct horse" ).is_ok(), "the file itself still opens" );
	}

	fn Key() -> key_t {
		V_NewKey()
	}

	// the shared editor must preserve untouched ciphertext, serialize writers,
	// and leave damaged files intact instead of replacing them with defaults
	#[tokio::test]
	async fn sealed_edits_keep_unchanged_bytes_and_serialize_writers() {
		V_TestUnlock();
		let path = std::env::temp_dir().join( format!( "laurel-edit-{}.json", Com_RandomHex( 16 ) ) );
		let lock = tokio::sync::Mutex::new( () );
		let purpose = purpose_t::PURPOSE_CONTACTS;
		V_EditSealed( &lock, &path, purpose, file_t::FILE_NOTES, |v: &mut Vec< u32 >| v.push( 1 ) ).await.unwrap();
		let before = std::fs::read( &path ).unwrap();
		assert!( V_IsSealed( &before ) );
		V_EditSealed( &lock, &path, purpose, file_t::FILE_NOTES, |_: &mut Vec< u32 >| {} ).await.unwrap();
		assert_eq!( std::fs::read( &path ).unwrap(), before );
		let ( a, b ) = tokio::join!(
			V_EditSealed( &lock, &path, purpose, file_t::FILE_NOTES, |v: &mut Vec< u32 >| v.push( 2 ) ),
			V_EditSealed( &lock, &path, purpose, file_t::FILE_NOTES, |v: &mut Vec< u32 >| v.push( 3 ) )
		);
		a.unwrap();
		b.unwrap();
		let mut saved: Vec< u32 > = V_ReadSealed( &path, purpose, file_t::FILE_NOTES ).unwrap();
		saved.sort();
		assert_eq!( saved, vec![ 1, 2, 3 ] );
		let mut damaged = std::fs::read( &path ).unwrap();
		*damaged.last_mut().unwrap() ^= 1;
		std::fs::write( &path, &damaged ).unwrap();
		assert!( V_EditSealed( &lock, &path, purpose, file_t::FILE_NOTES, |v: &mut Vec< u32 >| v.clear() ).await.is_err() );
		assert_eq!( std::fs::read( &path ).unwrap(), damaged );
		std::fs::remove_file( path ).unwrap();
	}

	// a plain file in a sealed file's place (a contact's address changed, put
	// there without the password) is refused, and left as it is, not written over
	#[tokio::test]
	async fn a_plain_file_is_refused_and_left_alone() {
		V_TestUnlock();
		let path = std::env::temp_dir().join( format!( "laurel-plain-{}.json", Com_RandomHex( 16 ) ) );
		let lock = tokio::sync::Mutex::new( () );
		std::fs::write( &path, b"[1,2,3]" ).unwrap();

		assert!( matches!( V_ReadSealed::< Vec< u32 > >( &path, purpose_t::PURPOSE_CONTACTS, file_t::FILE_NOTES ), Err( werr_t::WERR_NOT_SEALED ) ) );
		assert!( V_EditSealed( &lock, &path, purpose_t::PURPOSE_CONTACTS, file_t::FILE_NOTES, |v: &mut Vec< u32 >| v.push( 4 ) ).await.is_err() );
		assert_eq!( std::fs::read( &path ).unwrap(), b"[1,2,3]" );
		std::fs::remove_file( path ).unwrap();
	}

	#[test]
	fn seal_and_open_round_trip() {
		let key = Key();
		let sealed = V_SealWith( &key, purpose_t::PURPOSE_WALLET, b"wallet bytes" ).unwrap();

		assert!( V_IsSealed( &sealed ) );
		assert_eq!( V_OpenWith( &key, purpose_t::PURPOSE_WALLET, &sealed ).unwrap().as_slice(), b"wallet bytes" );
	}

	#[test]
	fn same_plaintext_seals_differently() {
		let key = Key();
		let a = V_SealWith( &key, purpose_t::PURPOSE_META, b"x" ).unwrap();
		let b = V_SealWith( &key, purpose_t::PURPOSE_META, b"x" ).unwrap();
		assert_ne!( a, b );		// fresh nonce each time
	}

	#[test]
	fn every_flipped_byte_is_caught() {
		let key = Key();
		let sealed = V_SealWith( &key, purpose_t::PURPOSE_WALLET, b"the recovery phrase lives in here" ).unwrap();

		for i in 0..sealed.len() {
			let mut bad = sealed.clone();
			bad[i] ^= 0x01;
			assert!( V_OpenWith( &key, purpose_t::PURPOSE_WALLET, &bad ).is_err(), "byte {i} not covered" );
		}
	}

	#[test]
	fn wrong_key_purpose_or_length_fails() {
		let key = Key();
		let sealed = V_SealWith( &key, purpose_t::PURPOSE_WALLET, b"data" ).unwrap();

		assert!( V_OpenWith( &Key(), purpose_t::PURPOSE_WALLET, &sealed ).is_err() );
		assert!( V_OpenWith( &key, purpose_t::PURPOSE_META, &sealed ).is_err() );
		assert!( V_OpenWith( &key, purpose_t::PURPOSE_WALLET, &sealed[..sealed.len() - 1] ).is_err() );
		assert!( V_OpenWith( &key, purpose_t::PURPOSE_WALLET, &sealed[..20] ).is_err() );
		assert!( V_OpenWith( &key, purpose_t::PURPOSE_WALLET, b"plain old file" ).is_err() );
	}

	#[test]
	fn password_wrap_round_trip() {
		let key = Key();
		let file = V_WrapWithPassword( &key, "correct horse", FAST ).unwrap();

		assert_eq!( *V_UnwrapWithPassword( &file, "correct horse" ).unwrap(), *key );
		assert!( matches!( V_UnwrapWithPassword( &file, "correct hors" ), Err( werr_t::WERR_BAD_PASSWORD ) ) );
		assert!( matches!( V_UnwrapWithPassword( &file, "" ), Err( werr_t::WERR_BAD_PASSWORD ) ) );
	}

	/*
	==================
	being_asked_takes_the_password

	With a password, only that password proves someone was asked; none
	is its own answer ("enter your password"), not a wrong one
	==================
	*/
	#[test]
	fn being_asked_takes_the_password() {
		let file = V_WrapWithPassword( &Key(), "correct horse", FAST ).unwrap();

		assert!( V_ConfirmWith( &file, Some( "correct horse" ) ).is_ok() );
		assert!( matches!( V_ConfirmWith( &file, Some( "correct hors" ) ), Err( werr_t::WERR_BAD_PASSWORD ) ) );
		assert!( matches!( V_ConfirmWith( &file, None ), Err( werr_t::WERR_CONFIRM ) ) );
	}

	#[test]
	fn same_password_wraps_differently() {
		let key = Key();
		let a = V_WrapWithPassword( &key, "correct horse", FAST ).unwrap();
		let b = V_WrapWithPassword( &key, "correct horse", FAST ).unwrap();

		assert_ne!( a.kdf.unwrap().salt, b.kdf.unwrap().salt );
		assert_ne!( a.wrapped, b.wrapped );
	}

	#[test]
	fn tampered_vault_settings_are_refused() {
		let key = Key();
		let good = V_WrapWithPassword( &key, "correct horse", FAST ).unwrap();

		let mut huge = good.clone();
		huge.kdf.as_mut().unwrap().mKib = KDF_CEILING.mKib + 1;
		assert!( matches!( V_UnwrapWithPassword( &huge, "correct horse" ), Err( werr_t::WERR_CORRUPT( _ ) ) ) );

		let mut other = good.clone();
		other.kdf.as_mut().unwrap().alg = "pbkdf2".to_string();
		assert!( matches!( V_UnwrapWithPassword( &other, "correct horse" ), Err( werr_t::WERR_CORRUPT( _ ) ) ) );

		let mut weaker = good.clone();
		weaker.kdf.as_mut().unwrap().t = 2;		// a different cost gives a different key
		assert!( V_UnwrapWithPassword( &weaker, "correct horse" ).is_err() );

		let mut cut = good.clone();
		cut.wrapped = B64.encode( &B64.decode( &good.wrapped ).unwrap()[..40] );
		assert!( matches!( V_UnwrapWithPassword( &cut, "correct horse" ), Err( werr_t::WERR_CORRUPT( _ ) ) ) );
	}

	#[test]
	fn short_passwords_are_refused() {
		assert!( V_CheckPassword( "1234567" ).is_err() );
		assert!( V_CheckPassword( "        " ).is_err() );
		assert!( V_CheckPassword( "12345678" ).is_ok() );
		assert!( V_CheckPassword( "pässwörd" ).is_ok() );		// counted in characters, not bytes
	}

	#[test]
	fn default_kdf_meets_rfc_9106_floor() {
		// RFC 9106 section 4, second recommended option: t=3, 64 MiB, p=4
		assert!( KDF_DEFAULT.mKib >= 64 * 1024 );
		assert!( KDF_DEFAULT.t >= 3 );
		assert!( KDF_DEFAULT.p >= 1 );
	}

	#[test]
	fn vault_file_survives_json() {
		let file = V_WrapWithPassword( &Key(), "correct horse", FAST ).unwrap();
		let text = serde_json::to_string( &file ).unwrap();
		let back: vaultFile_t = serde_json::from_str( &text ).unwrap();
		assert_eq!( back.wrapped, file.wrapped );
		assert_eq!( back.protection, protection_t::PROT_PASSWORD );
	}

	/*
	==================
	a_key_file_is_proven_before_it_counts

	Every write of the key file is read back and opened with the new
	secret before Laurel relies on it (Com_Commit). A write that landed
	wrong puts the old file back, so the old password still opens it; on
	a first run, with nothing to go back to, the bad file is removed
	rather than left to lock wallets away later.
	==================
	*/
	#[test]
	fn a_key_file_is_proven_before_it_counts() {
		use std::cell::RefCell;

		let key = Key();
		let old = V_WrapWithPassword( &key, "old password", FAST ).unwrap();
		let new = V_WrapWithPassword( &key, "new password", FAST ).unwrap();
		let reopen = |f: &vaultFile_t| V_UnwrapWithPassword( f, "new password" );

		// the disk keeps what was written
		let disk = RefCell::new( Some( old.clone() ) );
		let write = |f: &vaultFile_t| { *disk.borrow_mut() = Some( f.clone() ); Ok( () ) };
		let read = || Ok( disk.borrow().clone() );
		let forget = || { *disk.borrow_mut() = None; };
		assert!( Com_Commit( write, read, forget, Some( &old ), &new, &key, reopen ).is_ok() );
		assert_eq!( disk.borrow().as_ref().unwrap().wrapped, new.wrapped );

		// the disk keeps something else: the old file comes back, and says so
		let disk = RefCell::new( Some( old.clone() ) );
		let mangled = V_WrapWithPassword( &Key(), "new password", FAST ).unwrap();		// another key
		let write = |f: &vaultFile_t| { *disk.borrow_mut() = Some( if f.wrapped == new.wrapped { mangled.clone() } else { f.clone() } ); Ok( () ) };
		let read = || Ok( disk.borrow().clone() );
		let forget = || { *disk.borrow_mut() = None; };
		assert!( matches!( Com_Commit( write, read, forget, Some( &old ), &new, &key, reopen ), Err( werr_t::WERR_VAULT_WRITE ) ) );
		assert_eq!( disk.borrow().as_ref().unwrap().wrapped, old.wrapped, "the old password still opens it" );
		assert_eq!( *V_UnwrapWithPassword( disk.borrow().as_ref().unwrap(), "old password" ).unwrap(), *key );

		// first run, the write lands wrong: no half-made key file is left
		let disk = RefCell::new( None );
		let write = |_: &vaultFile_t| { *disk.borrow_mut() = Some( mangled.clone() ); Ok( () ) };
		let read = || Ok( disk.borrow().clone() );
		let forget = || { *disk.borrow_mut() = None; };
		assert!( Com_Commit( write, read, forget, None, &new, &key, reopen ).is_err() );
		assert!( disk.borrow().is_none() );
	}

	#[cfg( windows )]
	#[test]
	fn windows_protection_round_trip() {
		let key = Key();
		let file = V_WrapWithOs( &key ).unwrap();
		assert_eq!( *V_UnwrapWithOs( &file ).unwrap(), *key );

		let mut damaged = file.clone();
		let mut blob = B64.decode( &file.wrapped ).unwrap();
		let last = blob.len() - 1;
		blob[last] ^= 0x01;
		damaged.wrapped = B64.encode( blob );
		assert!( V_UnwrapWithOs( &damaged ).is_err() );
	}

	/*
	==================
	default_kdf_timing

	`cargo test --release -- --ignored default_kdf_timing --nocapture`
	shows what an unlock costs on this machine
	==================
	*/
	#[test]
	#[ignore]
	fn default_kdf_timing() {
		let start = std::time::Instant::now();
		V_DeriveKek( "correct horse", &[ 7u8; SALT_LEN ], KDF_DEFAULT ).unwrap();
		println!( "argon2id {:?}: {:?}", KDF_DEFAULT, start.elapsed() );
	}
}
