/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_storage.rs -- how much disk Laurel uses, and keeping it small
//
// Measured on a real install, the wallets were 19 KB and the embedded
// browser's folder was 185 MB: an http cache and a code cache for a ui
// that is already inside the app, plus Edge components (ad-block lists,
// speech, hyphenation) Laurel never uses. So the space goes to the
// browser, not the wallet, and that is where it is fixed:
//
//   1. the browser starts with its disk caches and component downloads
//      off (STO_BROWSER_ARGS), so most of it is never written
//   2. before the window exists, a janitor deletes the named cache
//      folders that remain; the browser holds nothing open yet, and
//      nothing outside the list is touched: Local Storage keeps the ui's
//      preferences, and wallets live in another folder entirely
//   3. the ui shows the real numbers, and warns while the disk the
//      wallets are saved on is nearly full, before a save could fail

use std::path::{ Path, PathBuf };
use std::sync::atomic::{ AtomicU64, Ordering };
use std::sync::OnceLock;

use serde::{ Deserialize, Serialize };
use specta::Type;

// Tauri's own defaults (which setting any args replaces), then ours
#[cfg( windows )]
pub const STO_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
	--disk-cache-size=1048576 \
	--disable-gpu-shader-disk-cache \
	--disable-component-update \
	--disable-background-networking \
	--disable-breakpad \
	--no-pings";

// inside the browser's profile folder; caches only, all rebuilt on demand
#[cfg( windows )]
const STO_JUNK: &[ &str ] = &[
	"Default/Cache",
	"Default/Code Cache",
	"Default/GPUCache",
	"Default/DawnGraphiteCache",
	"Default/DawnWebGPUCache",
	"GrShaderCache",
	"GraphiteDawnCache",
	"ShaderCache",
	"component_crx_cache",
	"Subresource Filter",
	"Speech Recognition",
	"hyphen-data",
	"BrowserMetrics",
	"BrowserMetrics-spare.pma",
	"Crashpad/reports",
];

// below this much free space where wallets are saved, the ui warns
const STO_LOW_SPACE: u64 = 200 * 1024 * 1024;

static sto_cleaned: AtomicU64 = AtomicU64::new( 0 );
static sto_paths: OnceLock< stoPaths_t > = OnceLock::new();

struct stoPaths_t {
	wallets:	PathBuf,		// wallets and the vault
	browser:	PathBuf,		// the embedded browser's profile and caches
	logs:		PathBuf,		// the capped log file (lib.rs, Sys_Logger)
}

#[derive( Clone, Copy, Debug, Default, Serialize, Deserialize, Type )]
pub struct storage_t {
	pub wallets:	u64,		// bytes: every wallet file and the vault
	pub app:		u64,		// the program itself, and Sapling's spend proving key once fetched (w_spendkey.rs)
	pub temporary:	u64,		// the ui's browser profile after this start's cleanup, and the log
	pub cleaned:	u64,		// what the janitor deleted when Laurel started
	pub free:		u64,		// free space on the disk the wallets are saved on
	pub disk:		u64,		// that disk's size
	pub lowSpace:	bool,		// free < STO_LOW_SPACE: a save could soon fail
}


/*
==================
Com_DirSize

Every file under a folder, in bytes. Links are not followed: a link to a
big folder elsewhere isn't Laurel's space.
==================
*/
pub fn Com_DirSize( dir: &Path ) -> u64 {
	let Ok( entries ) = std::fs::read_dir( dir ) else {
		return 0;
	};
	let mut total = 0;
	for e in entries.flatten() {
		let Ok( kind ) = e.file_type() else {
			continue;
		};
		if ( kind.is_dir() ) {
			total += Com_DirSize( &e.path() );
		} else if ( kind.is_file() ) {
			total += e.metadata().map_or( 0, |m| m.len() );
		}
	}
	total
}

/*
==================
Sto_Init

Where things are, decided once at startup
==================
*/
pub fn Sto_Init( wallets: PathBuf, browser: PathBuf, logs: PathBuf ) {
	let _ = sto_paths.set( stoPaths_t { wallets, browser, logs } );
}

/*
==================
Sto_Paths

Where wallets and the vault live, and where the log is written
==================
*/
pub fn Sto_Paths() -> ( PathBuf, PathBuf ) {
	sto_paths.get().map_or( ( PathBuf::new(), PathBuf::new() ), |p| ( p.wallets.clone(), p.logs.clone() ) )
}

/*
==================
Sto_Janitor

Deletes the browser's leftover caches. Must run before the window is
created: while the browser runs, it holds these files open.
==================
*/
#[cfg( windows )]
pub fn Sto_Janitor() {
	let Some( paths ) = sto_paths.get() else {
		return;
	};
	let mut freed = 0;
	for rel in STO_JUNK {
		freed += Sto_Remove( &paths.browser.join( rel ) );
	}
	sto_cleaned.store( freed, Ordering::SeqCst );
	log::info!( "Sto_Janitor: freed {freed} bytes" );
}

#[cfg( not( windows ) )]
pub fn Sto_Janitor() {}

/*
==================
Sto_Remove

A file or folder, and how many bytes that freed. What can't be removed
stays; a cache a live browser still holds is not worth an error.
==================
*/
#[cfg( windows )]
fn Sto_Remove( path: &Path ) -> u64 {
	let Ok( meta ) = std::fs::symlink_metadata( path ) else {
		return 0;
	};
	if ( meta.is_dir() ) {
		let size = Com_DirSize( path );
		let _ = std::fs::remove_dir_all( path );
		size - Com_DirSize( path )		// whatever survived still counts as there
	} else if ( std::fs::remove_file( path ).is_ok() ) {
		meta.len()
	} else {
		0
	}
}

/*
==================
Com_DiskSpace

Free and total bytes of the disk holding path
==================
*/
#[cfg( windows )]
fn Com_DiskSpace( path: &Path ) -> Option< ( u64, u64 ) > {
	use std::os::windows::ffi::OsStrExt;
	use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

	let wide: Vec< u16 > = path.as_os_str().encode_wide().chain( std::iter::once( 0 ) ).collect();
	let ( mut free, mut total ) = ( 0u64, 0u64 );
	// SAFETY: wide is nul-terminated and outlives the call; the out pointers are valid u64s
	let ok = unsafe { GetDiskFreeSpaceExW( wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut() ) };
	( ok != 0 ).then_some( ( free, total ) )
}

#[cfg( unix )]
fn Com_DiskSpace( path: &Path ) -> Option< ( u64, u64 ) > {
	use std::os::unix::ffi::OsStrExt;

	let c = std::ffi::CString::new( path.as_os_str().as_bytes() ).ok()?;
	// SAFETY: c is a valid nul-terminated path; st is written by statvfs before it is read
	let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
	if ( unsafe { libc::statvfs( c.as_ptr(), &mut st ) } != 0 ) {
		return None;
	}
	let unit = st.f_frsize as u64;
	Some( ( st.f_bavail as u64 * unit, st.f_blocks as u64 * unit ) )
}

/*
==================
Sto_Measure
==================
*/
pub fn Sto_Measure() -> storage_t {
	let Some( paths ) = sto_paths.get() else {
		return storage_t::default();
	};
	let ( free, disk ) = Com_DiskSpace( &paths.wallets ).unwrap_or( ( 0, 0 ) );

	storage_t {
		wallets:	Com_DirSize( &paths.wallets ),
		app:		std::env::current_exe().and_then( std::fs::metadata ).map_or( 0, |m| m.len() ) + crate::w_spendkey::Sk_KeptBytes(),
		temporary:	Com_DirSize( &paths.browser ) + Com_DirSize( &paths.logs ),
		cleaned:	sto_cleaned.load( Ordering::SeqCst ),
		free:		free,
		disk:		disk,
		lowSpace:	disk > 0 && free < STO_LOW_SPACE,
	}
}


#[cfg( test )]
mod tests {
	use super::*;
	use crate::w_local::Com_TestDir;

	#[test]
	fn dir_size_counts_nested_files() {
		let dir = Com_TestDir( "sto" );
		std::fs::create_dir_all( dir.join( "a/b" ) ).unwrap();
		std::fs::write( dir.join( "x" ), [ 0u8; 10 ] ).unwrap();
		std::fs::write( dir.join( "a/b/y" ), [ 0u8; 32 ] ).unwrap();
		assert_eq!( Com_DirSize( &dir ), 42 );
		let _ = std::fs::remove_dir_all( &dir );
	}

	#[test]
	fn missing_folder_is_empty() {
		assert_eq!( Com_DirSize( Path::new( "definitely/not/here" ) ), 0 );
	}

	#[cfg( windows )]
	#[test]
	fn janitor_list_never_reaches_saved_state() {
		// what the ui keeps in the browser (preferences) must survive every start
		for keep in [ "Default/Local Storage", "Default/IndexedDB", "Default/Session Storage", "Default/Preferences" ] {
			assert!( !STO_JUNK.iter().any( |j| keep.starts_with( j ) || j.starts_with( keep ) ), "{keep}" );
		}
	}

	#[cfg( windows )]
	#[test]
	fn disk_space_is_known_here() {
		let ( free, total ) = Com_DiskSpace( &std::env::temp_dir() ).unwrap();
		assert!( total > 0 && free <= total );
	}
}
