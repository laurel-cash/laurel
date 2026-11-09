/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_export.rs -- an account's history as a CSV file, for taxes and books
//
// Each line is one transaction with what it did to the balance, so the
// column adds up: money in, money out with its fee, a fee alone for a
// move, nothing for one that didn't go through. Memos are the person's
// choice, off by default: they are private words.
//
// A memo or an address is anyone's text, and a spreadsheet runs a cell
// that starts with "=" as a formula ("=HYPERLINK(...)" on opening). Every
// text cell is written so it can only ever be read as text.

use std::path::{ Path, PathBuf };

use tauri::{ AppHandle, Manager };

use crate::w_date::{ Com_IsoTime, Com_Now };
use crate::w_disk::Com_WriteAtomic;
use crate::w_local::*;

const ZATS_PER_ZEC: u64 = 100_000_000;

/*
==================
Com_Zec

Exact, from whole numbers: 150000000 is "1.50000000"
==================
*/
fn Com_Zec( zats: u64 ) -> String {
	format!( "{}.{:08}", zats / ZATS_PER_ZEC, zats % ZATS_PER_ZEC )
}

/*
==================
Com_CsvCell

Text that stays text: a cell a spreadsheet would run (=, +, -, @, a tab
or a return first) starts with an apostrophe, and a comma, quote or line
break is quoted (RFC 4180)
==================
*/
fn Com_CsvCell( text: &str ) -> String {
	let text = match text.starts_with( [ '=', '+', '-', '@', '\t', '\r' ] ) {
		true	=> format!( "'{text}" ),
		false	=> text.to_string(),
	};
	match text.contains( [ ',', '"', '\n', '\r' ] ) {
		true	=> format!( "\"{}\"", text.replace( '"', "\"\"" ) ),
		false	=> text,
	}
}

/*
==================
Com_NetChange

What one transaction did to the balance, signed, in zats: in is plus,
out is minus with its fee, a move costs its fee, and one that didn't go
through did nothing
==================
*/
fn Com_NetChange( it: &historyItem_t ) -> i128 {
	let fee = i128::from( it.fee.unwrap_or( 0 ) );
	match ( &it.state, it.kind ) {
		( txState_t::FAILED, _ )				=> 0,
		( _, txKind_t::TX_RECEIVED )			=> i128::from( it.amount ),
		( _, txKind_t::TX_SENT )				=> -( i128::from( it.amount ) + fee ),
		( _, txKind_t::TX_SHIELD | txKind_t::TX_MOVE )	=> -fee,
	}
}

fn Com_Signed( zats: i128 ) -> String {
	let sign = if zats < 0 { "-" } else { "" };
	format!( "{sign}{}", Com_Zec( zats.unsigned_abs() as u64 ) )
}

/*
==================
Com_Csv

The history, newest first as the screen shows it, one line each
==================
*/
pub fn Com_Csv( items: &[ historyItem_t ], memos: bool ) -> String {
	let mut out = String::from( "time,type,status,amount,fee,balance change,from,into,counterparty,txid,category" );
	if ( memos ) {
		out.push_str( ",memo,note" );
	}
	out.push_str( "\r\n" );

	for it in items {
		let kind = match it.kind {
			txKind_t::TX_RECEIVED	=> "received",
			txKind_t::TX_SENT		=> "sent",
			txKind_t::TX_SHIELD		=> "shield",
			txKind_t::TX_MOVE		=> "move",
		};
		let status = match it.state {
			txState_t::CONFIRMED { .. }	=> "confirmed",
			txState_t::PENDING { .. }	=> "pending",
			txState_t::UNSENT			=> "not sent yet",
			txState_t::FAILED			=> "didn't go through",
		};
		let pools = |p: &[ pool_t ]| p.iter().map( |x| match x {
			pool_t::POOL_IRONWOOD		=> "ironwood",
			pool_t::POOL_ORCHARD		=> "orchard",
			pool_t::POOL_SAPLING		=> "sapling",
			pool_t::POOL_TRANSPARENT	=> "transparent",
		} ).collect::< Vec< _ > >().join( " " );

		let mut cells = vec![
			Com_IsoTime( it.time ),
			kind.to_string(),
			Com_CsvCell( status ),
			Com_Zec( it.amount ),
			it.fee.map_or( String::new(), Com_Zec ),
			Com_Signed( Com_NetChange( it ) ),
			pools( &it.from ),
			pools( &it.into ),
			Com_CsvCell( it.counterparty.as_deref().unwrap_or( "" ) ),
			it.txid.clone(),
			it.category.map_or( String::new(), |c| Com_CsvCell( &serde_json::to_value( c ).ok().and_then( |v| v.as_str().map( str::to_string ) ).unwrap_or_default() ) ),
		];
		if ( memos ) {
			cells.push( Com_CsvCell( it.memo.as_deref().unwrap_or( "" ) ) );
			cells.push( Com_CsvCell( it.note.as_deref().unwrap_or( "" ) ) );
		}
		out.push_str( &cells.join( "," ) );
		out.push_str( "\r\n" );
	}
	out
}

/*
==================
Com_FreeName

dir/stem.csv, or "stem (2).csv" and on if taken: an export never
replaces an earlier one
==================
*/
fn Com_FreeName( dir: &Path, stem: &str ) -> PathBuf {
	let mut path = dir.join( format!( "{stem}.csv" ) );
	let mut n = 2;
	while ( path.exists() ) {
		path = dir.join( format!( "{stem} ({n}).csv" ) );
		n += 1;
	}
	path
}

/*
==================
W_ExportCsv

The account's history into Downloads, shown in its folder. Returns the
file's name.
==================
*/
pub async fn W_ExportCsv( app: &AppHandle, id: &str, account: u32, memos: bool ) -> wresult_t< String > {
	let items = crate::w_history::W_Transactions( id, account ).await?;
	let ( wallet, accountName ) = {
		let slot = crate::w_main::W_Slot( id ).await?;
		let s = slot.read().await;
		( s.meta.name.clone(), s.meta.accounts.get( account as usize ).cloned().unwrap_or_default() )
	};

	// a name any file system takes
	let clean = |t: &str| t.chars().filter( |c| c.is_alphanumeric() || *c == ' ' || *c == '-' ).collect::< String >().trim().to_string();
	let today = Com_IsoTime( Com_Now() as u32 );
	let stem = format!( "Laurel - {} - {} - {}", clean( &wallet ), clean( &accountName ), &today[..10] );

	let dir = app.path().download_dir().map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
	let path = Com_FreeName( &dir, &stem );
	Com_WriteAtomic( &path, Com_Csv( &items, memos ).as_bytes() )?;
	if let Err( e ) = tauri_plugin_opener::reveal_item_in_dir( &path ) {
		log::warn!( "W_ExportCsv: couldn't show the file: {}", e.to_string() );
	}
	Ok( path.file_name().map( |n| n.to_string_lossy().into_owned() ).unwrap_or_default() )
}


#[cfg( test )]
mod tests {
	use super::*;

	fn Item( kind: txKind_t, state: txState_t, amount: u64, fee: Option< u64 >, memo: Option< &str > ) -> historyItem_t {
		historyItem_t {
			txid:			"ab".repeat( 32 ),
			time:			1_790_000_000,
			kind:			kind,
			amount:			amount,
			fee:			fee,
			state:			state,
			from:			vec![],
			into:			vec![ pool_t::POOL_ORCHARD ],
			counterparty:	None,
			memo:			memo.map( str::to_string ),
			note:			None,
			category:		None,
		}
	}

	#[test]
	fn times_and_amounts_are_exact() {
		assert_eq!( Com_IsoTime( 0 ), "1970-01-01T00:00:00Z" );
		assert_eq!( Com_IsoTime( 1_790_000_000 ), "2026-09-21T14:13:20Z" );
		assert_eq!( Com_IsoTime( 951_782_400 ), "2000-02-29T00:00:00Z" );		// a leap day
		assert_eq!( Com_Zec( 150_000_000 ), "1.50000000" );
		assert_eq!( Com_Zec( 2_099_999_999_999_999 ), "20999999.99999999" );
	}

	/*
	==================
	a_memo_is_never_a_formula

	Anyone can write a memo; "=HYPERLINK(...)" in a cell would run when
	the file is opened
	==================
	*/
	#[test]
	fn a_memo_is_never_a_formula() {
		assert_eq!( Com_CsvCell( "=HYPERLINK(\"http://x\",\"click\")" ), "\"'=HYPERLINK(\"\"http://x\"\",\"\"click\"\")\"" );
		assert_eq!( Com_CsvCell( "+1" ), "'+1" );
		assert_eq!( Com_CsvCell( "@SUM(A1)" ), "'@SUM(A1)" );
		assert_eq!( Com_CsvCell( "Rent, October" ), "\"Rent, October\"" );
		assert_eq!( Com_CsvCell( "Lunch" ), "Lunch" );
	}

	#[test]
	fn the_balance_column_adds_up_and_memos_are_asked_for() {
		let items = [
			Item( txKind_t::TX_RECEIVED, txState_t::CONFIRMED { height: 1 }, 300_000_000, None, Some( "=cmd" ) ),
			Item( txKind_t::TX_SENT, txState_t::CONFIRMED { height: 2 }, 100_000_000, Some( 10_000 ), None ),
			Item( txKind_t::TX_SENT, txState_t::FAILED, 50_000_000, Some( 10_000 ), None ),
			Item( txKind_t::TX_MOVE, txState_t::CONFIRMED { height: 3 }, 199_990_000, Some( 15_000 ), None ),
		];
		let total: i128 = items.iter().map( Com_NetChange ).sum();
		assert_eq!( total, 300_000_000 - 100_010_000 - 15_000, "a failed payment changed nothing" );

		let without = Com_Csv( &items, false );
		assert!( !without.contains( "memo" ) && !without.contains( "=cmd" ) );
		let with = Com_Csv( &items, true );
		assert!( with.contains( ",'=cmd,\r\n" ), "a memo, then an empty note" );
		assert!( with.lines().nth( 2 ).unwrap().contains( ",-1.00010000," ) );
	}
}
