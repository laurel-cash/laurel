/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_probe.rs -- the KDF probe (W1-06): what Argon2 at KDF_DEFAULT costs a
// phone, measured where it runs, with the window and engine resident
//
// Only in a build with the kdf-probe feature, and only a debug one: a
// release with it doesn't compile, and play_bundle.mjs refuses a library
// carrying PROBE_ON (release_rules.mjs). Launched, it waits for the window,
// then derives three times, one after another, as an unlock, a confirm and
// a password change would: each its wall time and the process's peak
// memory (VmHWM) to logcat (tag laurel_lib::w_probe, lines "LaurelKdfProbe:").
// A derive the system killed shows as begun and not finished, and the next
// launch says so, from a file left in the data folder.

// words kept in the library, read by play_bundle.mjs
pub const PROBE_MARK: &str = if cfg!( feature = "kdf-probe" ) { "laurel-kdf-probe:on" } else { "laurel-kdf-probe:off" };

#[cfg( all( feature = "kdf-probe", not( debug_assertions ) ) )]
compile_error!( "kdf-probe is a test build's only: build it with --debug, never for Play" );

#[cfg( feature = "kdf-probe" )]
mod probe {
	use std::time::{ Duration, Instant };

	const WAIT_FOR_WINDOW: Duration	= Duration::from_secs( 15 );
	const BEGUN_FILE: &str			= "kdf-probe-begun.txt";
	const STEPS: [ &str; 3 ]		= [ "unlock", "confirm", "change" ];

	// a number from /proc (kB), by its label: "VmHWM:   123456 kB"
	fn Com_ProcKb( file: &str, label: &str ) -> u64 {
		crate::w_disk::Com_ReadText( std::path::Path::new( file ) )
			.and_then( |t| t.lines().find( |l| l.starts_with( label ) ).map( str::to_string ) )
			.and_then( |l| l.split_whitespace().nth( 1 ).and_then( |n| n.parse().ok() ) )
			.unwrap_or( 0 )
	}

	pub fn P_Start() {
		std::thread::spawn( || {
			let begun = crate::w_local::Com_DataPath( BEGUN_FILE );
			if let Some( left ) = begun.as_ref().and_then( |p| crate::w_disk::Com_ReadText( p ) ) {
				log::warn!( "LaurelKdfProbe: the last run was killed during derive {}", left.trim() );
			}
			std::thread::sleep( WAIT_FOR_WINDOW );
			log::info!( "LaurelKdfProbe: start, MemTotal {} kB, MemAvailable {} kB, VmRSS {} kB, settings {}",
				Com_ProcKb( "/proc/meminfo", "MemTotal:" ), Com_ProcKb( "/proc/meminfo", "MemAvailable:" ),
				Com_ProcKb( "/proc/self/status", "VmRSS:" ), crate::w_vault::V_ProbeSettings() );

			for ( i, step ) in STEPS.iter().enumerate() {
				let what = format!( "{} ({step})", i + 1 );
				if let Some( p ) = &begun {
					let _ = crate::w_disk::Com_WriteAtomic( p, what.as_bytes() );
				}
				log::info!( "LaurelKdfProbe: derive {what} begins" );
				let start = Instant::now();
				let ok = crate::w_vault::V_ProbeDerive();
				log::info!( "LaurelKdfProbe: derive {what} finished in {} ms, ok {ok}, VmHWM {} kB, VmRSS {} kB, MemAvailable {} kB",
					start.elapsed().as_millis(), Com_ProcKb( "/proc/self/status", "VmHWM:" ), Com_ProcKb( "/proc/self/status", "VmRSS:" ),
					Com_ProcKb( "/proc/meminfo", "MemAvailable:" ) );
			}
			if let Some( p ) = &begun {
				let _ = std::fs::remove_file( p );
			}
			log::info!( "LaurelKdfProbe: done, all {} finished", STEPS.len() );
		} );
	}
}

#[cfg( feature = "kdf-probe" )]
pub use probe::P_Start;
