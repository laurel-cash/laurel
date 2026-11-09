/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_disk.rs -- writing files so a crash, a power cut or an antivirus scan
// can never leave half a file, or no file, behind
//
// Every file laurel writes goes through Com_WriteAtomic (w_server.rs once
// wrote its own, without the flush), and every file it reads through
// Com_ReadIfThere. The rules:
//   the new bytes go to a temp file beside the target, flushed to disk
//   the temp file then replaces the target in one step
//   the target is never deleted or truncated first: until the replace
//   succeeds, the old file is still whole
//   on windows, antivirus often holds a file open for a moment while it
//   scans; the replace is retried rather than giving up (or, worse,
//   falling back to a copy, which is not atomic)

use std::io::Write;
use std::path::{ Path, PathBuf };
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::w_local::*;
use crate::w_net::engineResult_t;

// how long an antivirus hold is waited out, in total about 3 seconds
const REPLACE_RETRIES: u32		= 15;
const REPLACE_BACKOFF_MS: u64	= 200;


/*
==================
Com_ReadIfThere

A file's bytes, or none when there is no file yet. A file that is there
but can't be read is an error naming what, never "none": a caller that
took it for missing would write a fresh one over it.
==================
*/
pub fn Com_ReadIfThere( path: &Path, what: file_t ) -> wresult_t< Option< Vec< u8 > > > {
	match std::fs::read( path ) {
		Ok( raw ) => Ok( Some( raw ) ),
		Err( e ) if e.kind() == std::io::ErrorKind::NotFound => Ok( None ),
		Err( e ) => Err( werr_t::WERR_ENGINE( format!( "reading {what}: {}", e.to_string() ) ) ),
	}
}

// a text file that isn't one of Laurel's (the system's /proc, the KDF probe's
// marker): none if it can't be read, which the probe only reports
#[cfg( feature = "kdf-probe" )]
pub fn Com_ReadText( path: &Path ) -> Option< String > {
	std::fs::read_to_string( path ).ok()
}

// a file that must be there: missing is an error naming what
pub fn Com_ReadFile( path: &Path, what: file_t ) -> wresult_t< Vec< u8 > > {
	Com_ReadIfThere( path, what )?.ok_or_else( || werr_t::WERR_ENGINE( format!( "{what} is missing." ) ) )
}

// json that doesn't parse is damaged, said so by which file it is (the screen names it in its language)
pub fn Com_ParseJson< T: DeserializeOwned >( raw: &[ u8 ], what: file_t ) -> wresult_t< T > {
	serde_json::from_slice( raw ).map_err( |_| werr_t::WERR_CORRUPT( what ) )
}

/*
==================
Com_ReadJson / Com_WriteJson

A plain (unsealed) json file of Laurel's: none when there is none yet.
Four files read theirs by hand, three ways.
==================
*/
pub fn Com_ReadJson< T: DeserializeOwned >( path: &Path, what: file_t ) -> wresult_t< Option< T > > {
	Com_ReadIfThere( path, what )?.map( |raw| Com_ParseJson( &raw, what ) ).transpose()
}

pub fn Com_WriteJson< T: Serialize >( path: &Path, value: &T ) -> wresult_t< () > {
	Com_MakeFolderFor( path )?;
	Com_WriteAtomic( path, &serde_json::to_vec_pretty( value ).engine()? )
}

// the folder a file goes in, made if it isn't there yet
pub fn Com_MakeFolderFor( path: &Path ) -> wresult_t< () > {
	match path.parent() {
		Some( dir ) => std::fs::create_dir_all( dir ).engine(),
		None => Ok( () ),
	}
}

/*
==================
Com_TempPath

The temp file sits in the same directory, so the replace never crosses
volumes (a cross-volume move is a copy, and not atomic). Its name ends in
random hex and it is created new (Com_WriteVia): a fixed name could be a
link someone left there, and writing through it would overwrite whatever
it points at (security review A-05)
==================
*/
const TEMP_MARK: &str = ".laurel-tmp";			// every temp file's name has it, old fixed ones too
const TEMP_SUFFIX: &str = ".laurel-tmp-";
const TEMP_RANDOM_BYTES: usize = 8;

fn Com_TempPath( target: &Path ) -> PathBuf {
	let mut name = target.file_name().map( |n| n.to_os_string() ).unwrap_or_default();
	name.push( TEMP_SUFFIX );
	name.push( crate::w_vault::Com_RandomHex( TEMP_RANDOM_BYTES ) );
	target.with_file_name( name )
}

// a file of our own, or nothing: never one that's there already, nor through a link
fn Com_CreateNew( path: &Path ) -> std::io::Result< std::fs::File > {
	let mut options = std::fs::OpenOptions::new();
	options.write( true ).create_new( true );
	#[cfg( unix )]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.mode( 0o600 );			// the owner only, whatever the umask
	}
	options.open( path )
}

/*
==================
Com_Replace

Moves tmp over target in one step, writing through to the disk
==================
*/
#[cfg( windows )]
fn Com_Replace( tmp: &Path, target: &Path ) -> std::io::Result< () > {
	use std::os::windows::ffi::OsStrExt;
	use windows_sys::Win32::Storage::FileSystem::{ MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH };

	let wide = |p: &Path| -> Vec< u16 > { p.as_os_str().encode_wide().chain( std::iter::once( 0 ) ).collect() };
	let from = wide( tmp );
	let to = wide( target );

	// SAFETY: both arguments are valid, nul-terminated utf-16 paths that
	// outlive the call
	let ok = unsafe { MoveFileExW( from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH ) };
	if ( ok == 0 ) {
		return Err( std::io::Error::last_os_error() );
	}
	Ok( () )
}

#[cfg( not( windows ) )]
fn Com_Replace( tmp: &Path, target: &Path ) -> std::io::Result< () > {
	std::fs::rename( tmp, target )?;
	// the rename itself must reach the disk too
	if let Some( dir ) = target.parent() {
		std::fs::File::open( dir )?.sync_all()?;
	}
	Ok( () )
}

/*
==================
Com_IsTransient

Errors an antivirus or indexer causes by holding the file for a moment
==================
*/
fn Com_IsTransient( e: &std::io::Error ) -> bool {
	const ERROR_ACCESS_DENIED: i32		= 5;
	const ERROR_SHARING_VIOLATION: i32	= 32;
	const ERROR_LOCK_VIOLATION: i32		= 33;

	cfg!( windows ) && matches!( e.raw_os_error(), Some( ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION ) )
}

/*
==================
Com_WriteAtomic

See the top of this file. On any failure the target is untouched and the
temp file is removed.
==================
*/
pub fn Com_WriteAtomic( target: &Path, bytes: &[ u8 ] ) -> wresult_t< () > {
	Com_WriteVia( target, &Com_TempPath( target ), bytes )
}

fn Com_WriteVia( target: &Path, tmp: &Path, bytes: &[ u8 ] ) -> wresult_t< () > {
	let mut f = Com_CreateNew( tmp ).engine()?;		// not ours if it fails: nothing to remove
	let written = ( || -> std::io::Result< () > {
		f.write_all( bytes )?;
		f.sync_all()					// the bytes are on disk before they replace anything
	} )();
	drop( f );
	if let Err( e ) = written {
		let _ = std::fs::remove_file( tmp );
		return Err( e ).engine();
	}

	let mut attempt = 0;
	loop {
		match Com_Replace( tmp, target ) {
			Ok( () ) => return Ok( () ),
			Err( e ) if Com_IsTransient( &e ) && attempt < REPLACE_RETRIES => {
				attempt += 1;
				std::thread::sleep( Duration::from_millis( REPLACE_BACKOFF_MS ) );
			}
			Err( e ) => {
				let _ = std::fs::remove_file( tmp );
				return Err( e ).engine();
			}
		}
	}
}

/*
==================
Com_SweepTemps

The temp files a stop left under dir, in any folder below it: a write cut
off between its temp file and the replace. Each now has a name of its own,
so none is ever written over again; shredded, as what they hold may be a
wallet's. Run once at startup (W_Init), before anything writes. A link to
a folder is not walked (file_type doesn't follow it)
==================
*/
pub fn Com_SweepTemps( dir: &Path ) {
	let Ok( entries ) = std::fs::read_dir( dir ) else {
		return;
	};
	for entry in entries.flatten() {
		let Ok( kind ) = entry.file_type() else {
			continue;
		};
		if ( kind.is_dir() ) {
			Com_SweepTemps( &entry.path() );
		} else if ( entry.file_name().to_string_lossy().contains( TEMP_MARK ) ) {
			Com_Shred( &entry.path() );
		}
	}
}

/*
==================
Com_Shred

Best effort for a file that held secrets in the clear: overwrite, flush,
remove. On an SSD the old blocks may survive in the drive's own spare
area; no program can reach them, which is why wallets are encrypted
before they are ever written.
==================
*/
pub fn Com_Shred( path: &Path ) {
	// the checks are on the open handle, not the path, so nothing can be
	// swapped in between (security review A-05, T-035)
	if let Some( mut f ) = Com_OpenOwnFile( path ) {
		if let Ok( meta ) = f.metadata() {
			let zeros = vec![ 0u8; 64 * 1024 ];
			let mut left = meta.len();
			while ( left > 0 ) {
				let n = left.min( zeros.len() as u64 ) as usize;
				if ( f.write_all( &zeros[..n] ).is_err() ) {
					break;
				}
				left -= n as u64;
			}
			let _ = f.sync_all();
		}
	}
	let _ = std::fs::remove_file( path );		// a link or a shared file is only unlinked
}

/*
==================
Com_ShredTree

Everything under dir, shredded file by file (Com_Shred) and its folders
removed; dir itself stays, empty. A link is removed, never followed
==================
*/
pub fn Com_ShredTree( dir: &Path ) -> std::io::Result< () > {
	for entry in std::fs::read_dir( dir )? {
		let entry = entry?;
		let path = entry.path();
		if ( entry.file_type()?.is_dir() ) {
			Com_ShredTree( &path )?;
			std::fs::remove_dir( &path )?;
		} else {
			Com_Shred( &path );
		}
	}
	Ok( () )
}

/*
==================
Com_OpenOwnFile

The file at path opened for writing, only if it is the file itself: never
through a link or reparse point (opened without following one), and never
one with other names (a hard link: writing would change their content).
None otherwise. Laurel's data folder is the user's own, so the folders above
it are trusted; this guards the last step only.
==================
*/
#[cfg( unix )]
fn Com_OpenOwnFile( path: &Path ) -> Option< std::fs::File > {
	use std::os::unix::fs::{ MetadataExt, OpenOptionsExt };

	let f = std::fs::OpenOptions::new().write( true ).custom_flags( libc::O_NOFOLLOW ).open( path ).ok()?;
	let meta = f.metadata().ok()?;
	( meta.file_type().is_file() && meta.nlink() == 1 ).then_some( f )
}

#[cfg( windows )]
fn Com_OpenOwnFile( path: &Path ) -> Option< std::fs::File > {
	use std::os::windows::fs::OpenOptionsExt;
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::Storage::FileSystem::{ GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT };

	let f = std::fs::OpenOptions::new().write( true ).custom_flags( FILE_FLAG_OPEN_REPARSE_POINT ).open( path ).ok()?;
	// SAFETY: a zeroed BY_HANDLE_FILE_INFORMATION is a valid out value, and
	// the handle is open for the whole call
	let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
	let ok = unsafe { GetFileInformationByHandle( f.as_raw_handle() as _, &mut info ) };
	let plain = info.dwFileAttributes & ( FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY ) == 0;
	( ok != 0 && plain && info.nNumberOfLinks == 1 ).then_some( f )
}

#[cfg( not( any( unix, windows ) ) )]
fn Com_OpenOwnFile( _path: &Path ) -> Option< std::fs::File > {
	None		// no way to check here: only unlink
}


/*
=========================================================================

TESTS

=========================================================================
*/

/*
==================
Com_MoveInto

Everything in from moved into to, by rename (same disk: nothing copied).
whole: all of it or none of it, never over a name already in to; a
rename that fails puts back the ones already moved. Not whole: what's in
the way, or won't move, stays behind (a cache, a log). from goes once
empty
==================
*/
pub fn Com_MoveInto( from: &Path, to: &Path, whole: bool ) -> std::io::Result< () > {
	std::fs::create_dir_all( to )?;
	let names: Vec< std::ffi::OsString > = std::fs::read_dir( from )?.map( |e| e.map( |e| e.file_name() ) ).collect::< std::io::Result< _ > >()?;
	if ( whole ) {
		if let Some( n ) = names.iter().find( |n| to.join( n ).exists() ) {
			return Err( std::io::Error::new( std::io::ErrorKind::AlreadyExists, format!( "{} is in both", n.to_string_lossy() ) ) );
		}
	}
	let mut moved: Vec< &std::ffi::OsString > = vec![];
	for n in &names {
		if ( to.join( n ).exists() ) {
			continue;		// not whole: it stays behind
		}
		match std::fs::rename( from.join( n ), to.join( n ) ) {
			Ok( () ) => moved.push( n ),
			Err( e ) if whole => {
				for back in moved {
					let _ = std::fs::rename( to.join( back ), from.join( back ) );
				}
				return Err( e );
			}
			Err( _ ) => {}
		}
	}
	let _ = std::fs::remove_dir( from );		// only once empty
	Ok( () )
}

#[cfg( test )]
mod tests {
	use super::*;

	fn Scratch( name: &str ) -> PathBuf {
		Com_TestDir( &format!( "disk-{name}" ) )
	}

	// starting over leaves the data folder itself, with nothing in it
	#[test]
	fn a_shredded_tree_leaves_an_empty_folder() {
		let dir = Scratch( "tree" );
		std::fs::create_dir_all( dir.join( "wallets/testnet/w1" ) ).unwrap();
		std::fs::write( dir.join( "laurel-vault.json" ), b"vault" ).unwrap();
		std::fs::write( dir.join( "wallets/testnet/w1/laurel-wallet.dat" ), b"wallet" ).unwrap();

		Com_ShredTree( &dir ).unwrap();
		assert!( dir.is_dir() );
		assert_eq!( std::fs::read_dir( &dir ).unwrap().count(), 0 );
	}

	// the old identifier's folder, moved whole into the new one: its wallets and key file
	#[test]
	fn a_data_folder_moves_whole() {
		let dir = Scratch( "move" );
		let ( old, new ) = ( dir.join( "cash.laurel.wallet" ), dir.join( "com.rptxsoftware.wallet" ) );
		std::fs::create_dir_all( old.join( "wallets/testnet/w1" ) ).unwrap();
		std::fs::write( old.join( "laurel-vault.json" ), b"vault" ).unwrap();
		std::fs::write( old.join( "wallets/testnet/w1/laurel-wallet.dat" ), b"wallet" ).unwrap();

		Com_MoveInto( &old, &new, true ).unwrap();
		assert_eq!( std::fs::read( new.join( "laurel-vault.json" ) ).unwrap(), b"vault" );
		assert_eq!( std::fs::read( new.join( "wallets/testnet/w1/laurel-wallet.dat" ) ).unwrap(), b"wallet" );
		assert!( !old.exists(), "the emptied old folder goes" );
	}

	// one name already in the new folder: nothing moves, nothing is overwritten
	#[test]
	fn a_whole_move_never_overwrites() {
		let dir = Scratch( "move-clash" );
		let ( old, new ) = ( dir.join( "old" ), dir.join( "new" ) );
		std::fs::create_dir_all( &old ).unwrap();
		std::fs::create_dir_all( &new ).unwrap();
		std::fs::write( old.join( "laurel-vault.json" ), b"old vault" ).unwrap();
		std::fs::write( old.join( "settings.json" ), b"old settings" ).unwrap();
		std::fs::write( new.join( "laurel-vault.json" ), b"new vault" ).unwrap();

		assert!( Com_MoveInto( &old, &new, true ).is_err() );
		assert_eq!( std::fs::read( old.join( "laurel-vault.json" ) ).unwrap(), b"old vault" );
		assert_eq!( std::fs::read( old.join( "settings.json" ) ).unwrap(), b"old settings", "nothing moved" );
		assert_eq!( std::fs::read( new.join( "laurel-vault.json" ) ).unwrap(), b"new vault" );
	}

	// a cache folder: what's in the way stays behind, the rest moves
	#[test]
	fn a_partial_move_leaves_what_is_in_the_way() {
		let dir = Scratch( "move-partial" );
		let ( old, new ) = ( dir.join( "old" ), dir.join( "new" ) );
		std::fs::create_dir_all( old.join( "logs" ) ).unwrap();
		std::fs::create_dir_all( new.join( "logs" ) ).unwrap();
		std::fs::write( old.join( "prefs" ), b"p" ).unwrap();

		Com_MoveInto( &old, &new, false ).unwrap();
		assert!( new.join( "prefs" ).exists() );
		assert!( old.join( "logs" ).exists(), "in the way: left behind" );
	}

	/*
	==================
	a_json_file_is_there_missing_or_damaged

	Missing is none, never an error; damaged is an error naming the file,
	never none (the caller would write a fresh one over it); and what is
	written, in a folder not made yet, reads back the same
	==================
	*/
	#[test]
	fn a_json_file_is_there_missing_or_damaged() {
		let dir = Scratch( "json" );
		let target = dir.join( "later" ).join( "list.json" );

		assert_eq!( Com_ReadJson::< Vec< u32 > >( &target, file_t::FILE_NOTES ).unwrap(), None );
		Com_WriteJson( &target, &vec![ 1u32, 2 ] ).unwrap();
		assert_eq!( Com_ReadJson::< Vec< u32 > >( &target, file_t::FILE_NOTES ).unwrap(), Some( vec![ 1, 2 ] ) );

		Com_WriteAtomic( &target, b"{ half" ).unwrap();
		assert!( matches!( Com_ReadJson::< Vec< u32 > >( &target, file_t::FILE_NOTES ), Err( werr_t::WERR_CORRUPT( file_t::FILE_NOTES ) ) ) );
		assert!( Com_ReadFile( &dir.join( "none" ), file_t::FILE_WALLET ).is_err(), "a file that must be there" );
	}

	#[test]
	fn writes_and_replaces_leaving_no_temp() {
		let dir = Scratch( "replace" );
		let target = dir.join( "file.dat" );

		Com_WriteAtomic( &target, b"first" ).unwrap();
		Com_WriteAtomic( &target, b"second, longer" ).unwrap();

		assert_eq!( std::fs::read( &target ).unwrap(), b"second, longer" );
		let left: Vec< _ > = std::fs::read_dir( &dir ).unwrap().flatten().map( |e| e.file_name() ).filter( |n| n.to_string_lossy().contains( TEMP_SUFFIX ) ).collect();
		assert!( left.is_empty(), "temp files left: {left:?}" );
	}

	#[test]
	fn a_stops_leftover_temps_are_swept() {
		let dir = Scratch( "sweep" );
		std::fs::create_dir_all( dir.join( "wallets/testnet/w1" ) ).unwrap();
		let left = [ dir.join( "settings.json.laurel-tmp-0011223344556677" ), dir.join( "wallets/testnet/w1/laurel-wallet.dat.laurel-tmp" ) ];
		let kept = [ dir.join( "settings.json" ), dir.join( "wallets/testnet/w1/laurel-wallet.dat" ) ];
		for p in left.iter().chain( kept.iter() ) {
			std::fs::write( p, b"bytes" ).unwrap();
		}

		Com_SweepTemps( &dir );
		assert!( left.iter().all( |p| !p.exists() ), "a leftover temp file stayed" );
		assert!( kept.iter().all( |p| p.exists() ), "a real file was swept" );
	}

	#[test]
	fn temp_names_are_new_each_time() {
		let target = Scratch( "names" ).join( "file.dat" );
		assert_ne!( Com_TempPath( &target ), Com_TempPath( &target ) );
	}

	#[test]
	fn a_temp_name_already_there_is_never_written_through() {
		let dir = Scratch( "planted" );
		let target = dir.join( "file.dat" );
		let other = dir.join( "someone-elses.dat" );
		let tmp = dir.join( "planted.tmp" );
		Com_WriteAtomic( &target, b"good" ).unwrap();
		std::fs::write( &other, b"theirs" ).unwrap();
		std::fs::write( &tmp, b"there first" ).unwrap();

		assert!( Com_WriteVia( &target, &tmp, b"never lands" ).is_err() );
		assert_eq!( std::fs::read( &target ).unwrap(), b"good" );
		assert_eq!( std::fs::read( &tmp ).unwrap(), b"there first", "a file that wasn't ours was truncated or removed" );
		assert_eq!( std::fs::read( &other ).unwrap(), b"theirs" );
	}

	// the tests below pass just as well if the checks refused every file:
	// a plain file of one name must pass them, or shredding only unlinks
	#[test]
	fn shred_opens_a_file_of_its_own() {
		let path = Scratch( "shred-own" ).join( "own.dat" );
		std::fs::write( &path, b"secret" ).unwrap();
		assert!( Com_OpenOwnFile( &path ).is_some(), "a plain file of one name was refused: shred would only unlink" );
	}

	#[test]
	fn shred_never_writes_through_a_hard_link() {
		let dir = Scratch( "shred-hard" );
		let real = dir.join( "real.dat" );
		let other = dir.join( "other-name.dat" );
		std::fs::write( &real, b"keep me" ).unwrap();
		std::fs::hard_link( &real, &other ).unwrap();

		Com_Shred( &other );
		assert!( !other.exists(), "the name is removed" );
		assert_eq!( std::fs::read( &real ).unwrap(), b"keep me" );
	}

	#[cfg( windows )]
	#[test]
	fn shred_never_follows_a_windows_link() {
		let dir = Scratch( "shred-winlink" );
		let real = dir.join( "real.dat" );
		let link = dir.join( "link.dat" );
		std::fs::write( &real, b"keep me" ).unwrap();
		// creating a symlink needs developer mode or admin; without it there is nothing to test
		if ( std::os::windows::fs::symlink_file( &real, &link ).is_err() ) {
			return;
		}
		Com_Shred( &link );
		assert!( std::fs::symlink_metadata( &link ).is_err(), "the link is removed" );
		assert_eq!( std::fs::read( &real ).unwrap(), b"keep me" );
	}

	#[cfg( unix )]
	#[test]
	fn shred_never_follows_a_link() {
		let dir = Scratch( "shred-link" );
		let real = dir.join( "real.dat" );
		let link = dir.join( "link.dat" );
		std::fs::write( &real, b"keep me" ).unwrap();
		std::os::unix::fs::symlink( &real, &link ).unwrap();

		Com_Shred( &link );
		assert!( std::fs::symlink_metadata( &link ).is_err(), "the link is removed" );
		assert_eq!( std::fs::read( &real ).unwrap(), b"keep me" );
	}

	#[test]
	fn failed_write_keeps_the_old_file() {
		let dir = Scratch( "keep" );
		let target = dir.join( "file.dat" );
		Com_WriteAtomic( &target, b"good" ).unwrap();

		// a directory where the temp file must go makes the write fail
		let tmp = Com_TempPath( &target );
		std::fs::create_dir( &tmp ).unwrap();
		assert!( Com_WriteVia( &target, &tmp, b"never lands" ).is_err() );

		assert_eq!( std::fs::read( &target ).unwrap(), b"good" );
	}

	#[test]
	fn shred_removes_the_file() {
		let dir = Scratch( "shred" );
		let path = dir.join( "secret.dat" );
		std::fs::write( &path, b"seed words" ).unwrap();

		Com_Shred( &path );
		assert!( !path.exists() );
	}
}
