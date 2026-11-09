/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_dev.rs -- Developer settings: where Laurel keeps things, a report to
// share when asking for help, and checking a wallet again from the start.
//
// The report holds facts about the software and its sync, never a wallet's
// name, address, balance or key: it is meant to be pasted in public. The
// ui shows it whole before it is copied.

use serde::{ Deserialize, Serialize };
use specta::Type;
use tauri::AppHandle;

use crate::w_local::*;
use crate::w_main::{ W_Ids, W_Slot };
use crate::w_server::W_ServerStatus;
use crate::w_storage::{ Sto_Measure, Sto_Paths };

// which of Laurel's folders to show in the file manager: the ui names one,
// it never passes a path
#[derive( Clone, Copy, Debug, Serialize, Deserialize, Type )]
pub enum folder_t {
	#[serde( rename = "data" )]
	FOLDER_DATA,
	#[serde( rename = "logs" )]
	FOLDER_LOGS,
}

#[derive( Clone, Debug, Serialize, Type )]
pub struct devInfo_t {
	pub version:	String,
	pub network:	network_t,
	pub server:		Option< String >,		// the server in use, once one has answered
	pub ownServer:	bool,
	pub dataDir:	String,
	pub logDir:		String,
}

/*
==================
D_Info
==================
*/
pub async fn D_Info( app: &AppHandle ) -> devInfo_t {
	let net = w_registry.read().await.network;
	let server = W_ServerStatus( net );
	let ( data, logs ) = Sto_Paths();
	devInfo_t {
		version:	app.package_info().version.to_string(),
		network:	net,
		server:		server.current,
		ownServer:	server.own.is_some(),
		dataDir:	data.display().to_string(),
		logDir:		logs.display().to_string(),
	}
}

/*
==================
D_Reveal

Shows one of Laurel's folders in the file manager
==================
*/
pub fn D_Reveal( folder: folder_t ) -> wresult_t< () > {
	let ( data, logs ) = Sto_Paths();
	let path = match folder {
		folder_t::FOLDER_DATA => data,
		folder_t::FOLDER_LOGS => logs,
	};
	tauri_plugin_opener::reveal_item_in_dir( &path ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )
}

/*
==================
D_Report

A plain report for support: the software, the network, the server, and
each wallet's sync, by number. No name, address, balance or key.
==================
*/
pub async fn D_Report( app: &AppHandle ) -> String {
	D_ReportOf( &app.package_info().version.to_string() ).await
}

pub async fn D_ReportOf( version: &str ) -> String {
	let net = w_registry.read().await.network;
	let server = W_ServerStatus( net );
	let storage = Sto_Measure();
	let mut lines = vec![
		format!( "Laurel {} on {} {}", version, std::env::consts::OS, std::env::consts::ARCH ),
		format!( "network: {:?}", net ),
		format!( "server: {} ({})", server.current.as_deref().unwrap_or( "not chosen yet" ), if ( server.own.is_some() ) { "own" } else { "automatic" } ),
		format!( "storage: wallets {} KB, free {} MB", storage.wallets / 1024, storage.free / ( 1024 * 1024 ) ),
	];

	let ids = W_Ids().await;
	lines.push( format!( "wallets open: {}, not opened: {}", ids.len(), w_failed.lock().unwrap().len() ) );
	for ( n, id ) in ids.iter().enumerate() {
		let Ok( slot ) = W_Slot( id ).await else {
			continue;
		};
		let ( line, error ) = {
			let s = slot.read().await;
			let kind = match s.meta.kind {
				walletKind_t::WK_SEED		=> "phrase",
				walletKind_t::WK_VIEWONLY	=> "view-only",
				walletKind_t::WK_KEY		=> "imported keys",
			};
			let line = {
				let c = s.cache.lock().unwrap();
				format!(
					"wallet {}: {kind}, {} account(s), scanned to {} of {}, {}{}",
					n + 1, s.meta.accounts.len(), c.walletHeight, c.chainHeight,
					if ( c.running ) { "running" } else if ( c.paused ) { "paused" } else { "stopped" },
					if ( c.repairing ) { ", rechecking from the birthday" } else { "" },
				)
			};
			let error = s.syncError.lock().unwrap().as_ref().map( |e| e.message.clone() );		// the words for people; never the detail
			( line, error )
		};
		lines.push( line );
		if let Some( e ) = error {
			lines.push( format!( "  last sync error: {e}" ) );
		}
	}
	lines.join( "\n" )
}
