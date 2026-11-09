/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_log.rs -- what may reach the log file, decided at the one place every
// line passes (Sys_Logger's formatter), for Laurel's lines and the
// engine's alike
//
// The log is a file on disk a person may send to support. Addresses and
// transaction ids tie it to their money on a public chain; keys give the
// money away. Each word of every line is read for what it is (an address
// that parses as one, a 64-digit hex id, a key), and those are masked. A
// log call can't forget: nothing reaches the file another way.
//
// Typed phrase words and contact names are kept out before this, by
// werr_t::LogText (they aren't recognisable by shape).

use std::borrow::Cow;

use zcash_address::ZcashAddress;
use zingolib::config::ChainType;
use laurel_engine::sweep::SweepKey;

// the shortest thing that can be an address or a key: a transparent address is 35
const SHORTEST_SECRET: usize = 26;

// this many phrase words in a row are taken for a phrase, or four-letter
// base32 groups for a sync code (W1-04): fewer turn up in plain sentences
const WORD_RUN: usize = 5;

static PHRASE_WORDS: std::sync::LazyLock< std::collections::HashSet< &'static str > > =
	std::sync::LazyLock::new( || <bip0039::English as bip0039::Language>::words().iter().copied().collect() );

/*
==================
Com_LogSafe

The line with every address, transaction id and key masked
==================
*/
pub fn Com_LogSafe( text: &str ) -> String {
	// words, and each character between them, in order
	let mut tokens: Vec< ( bool, String ) > = Vec::new();
	for ch in text.chars() {
		let isWord = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
		match tokens.last_mut() {
			Some( ( true, t ) ) if isWord => t.push( ch ),
			_ => tokens.push( ( isWord, ch.to_string() ) ),
		}
	}

	let words	= Com_Runs( &tokens, |w| PHRASE_WORDS.contains( w.to_ascii_lowercase().as_str() ) );
	let groups	= Com_Runs( &tokens, Com_IsCodeGroup );
	let mut out = String::with_capacity( text.len() );
	let mut i = 0;
	while ( i < tokens.len() ) {
		let ( isWord, t ) = &tokens[i];
		if let Some( end ) = words[i] {
			out.push_str( "<words>" );
			i = end + 1;
			continue;
		}
		if let Some( end ) = groups[i] {
			out.push_str( "<code>" );
			i = end + 1;
			continue;
		}
		i += 1;
		if ( !isWord ) {
			out.push_str( t );
		} else if ( Com_IsAmount( &tokens, i - 1 ) ) {
			out.push_str( "<amount>" );
		} else {
			out.push_str( &Com_Mask( t ) );
		}
	}
	out
}

/*
==================
Com_Runs / Com_IsCodeGroup

Where each run of at least WORD_RUN words that are all "is" begins, with
the token it ends at. Words in a run are apart by what phrases sit in
when they get into a string: spaces, commas, semicolons, quotes,
brackets, and a list's numbers ("1. abandon 2. ability", "1) …")
==================
*/
fn Com_Runs( tokens: &[ ( bool, String ) ], is: impl Fn( &str ) -> bool ) -> Vec< Option< usize > > {
	let mut runs = vec![ None; tokens.len() ];
	let mut i = 0;
	while ( i < tokens.len() ) {
		if ( !( tokens[i].0 && is( &tokens[i].1 ) ) ) {
			i += 1;
			continue;
		}
		let ( mut end, mut count, mut j ) = ( i, 1, i + 1 );
		loop {
			while ( j < tokens.len() && Com_IsBetweenWords( tokens, j ) ) {
				j += 1;
			}
			if ( j < tokens.len() && tokens[j].0 && is( &tokens[j].1 ) ) {
				end = j;
				count += 1;
				j += 1;
			} else {
				break;
			}
		}
		if ( count >= WORD_RUN ) {
			runs[i] = Some( end );
		}
		i = end + 1;
	}
	runs
}

// a token that may sit between a run's words: a separator, or a list's number before its "." or ")"
fn Com_IsBetweenWords( tokens: &[ ( bool, String ) ], j: usize ) -> bool {
	let ( isWord, t ) = &tokens[j];
	if ( !isWord ) {
		return t.chars().all( |c| c.is_whitespace() || ",;\"'[](){}.".contains( c ) );
	}
	t.bytes().all( |b| b.is_ascii_digit() ) && tokens.get( j + 1 ).is_some_and( |n| n.1 == "." || n.1 == ")" )
}

// four letters of a sync code: RFC 4648 base32, any case (w_folder.rs)
fn Com_IsCodeGroup( word: &str ) -> bool {
	word.len() == 4 && word.bytes().all( |b| b.is_ascii_alphabetic() || ( b'2'..=b'7' ).contains( &b ) )
}

// a whole sync code, its groups dashed: one word to the tokenizer
fn Com_IsSyncCode( word: &str ) -> bool {
	let groups: Vec< &str > = word.split( '-' ).collect();
	groups.len() >= WORD_RUN && groups.iter().all( |g| Com_IsCodeGroup( g ) )
}

/*
==================
Com_IsAmount

A number that is an amount by the unit beside it: "150000 zatoshis",
"2.5 ZEC", "Zatoshis(150000)". The engine's errors say how much a payment
needed. A bare number can't be told from a height, so Laurel's own lines
never log amounts (none do).
==================
*/
fn Com_IsAmount( tokens: &[ ( bool, String ) ], i: usize ) -> bool {
	const UNITS: [ &str; 5 ] = [ "zat", "zats", "zatoshi", "zatoshis", "zec" ];

	let number	= |k: usize| tokens.get( k ).is_some_and( |( w, s )| *w && s.bytes().all( |b| b.is_ascii_digit() ) );
	let unit	= |k: usize| tokens.get( k ).is_some_and( |( w, s )| *w && UNITS.contains( &s.to_ascii_lowercase().as_str() ) );
	let is		= |k: usize, s: &str| tokens.get( k ).is_some_and( |t| t.1 == s );
	if ( !number( i ) ) {
		return false;
	}

	// "2.5 ZEC": the whole part looks past ".5"; the ".5" looks back to the whole part
	let mut next = i + 1;
	if ( is( next, "." ) && number( next + 1 ) ) {
		next += 2;
	}
	let fraction	= i >= 2 && is( i - 1, "." ) && number( i - 2 ) && Com_IsAmount( tokens, i - 2 );
	let unitAfter	= unit( next ) || ( is( next, " " ) && unit( next + 1 ) );
	let unitBefore	= i >= 2 && ( is( i - 1, "(" ) || is( i - 1, " " ) ) && unit( i - 2 );

	fraction || unitAfter || unitBefore
}

fn Com_Mask( word: &str ) -> Cow< '_, str > {
	if ( word.len() < SHORTEST_SECRET ) {
		return Cow::Borrowed( word );
	}
	if ( ZcashAddress::try_from_encoded( word ).is_ok() ) {
		return Cow::Borrowed( "<address>" );
	}
	if ( crate::w_local::Com_IsTxid( word ) ) {
		return Cow::Borrowed( "<txid>" );
	}
	if ( Com_IsSyncCode( word ) ) {
		return Cow::Borrowed( "<code>" );
	}
	let key = [ "secret-extended-key-", "zxviews", "zxivks", "uview", "uivk", "zxsk" ].iter().any( |p| word.starts_with( p ) )
		|| [ ChainType::Mainnet, ChainType::Testnet ].iter().any( |c| SweepKey::from_wif( c, word ).is_ok() );
	if ( key ) {
		return Cow::Borrowed( "<key>" );
	}
	Cow::Borrowed( word )
}


#[cfg( test )]
mod tests {
	use super::*;

	#[test]
	fn addresses_ids_and_keys_are_masked_the_rest_kept() {
		let line = "sending 150000 at height 4401862 to utest1466rzp2xyjemqs4j3an5ghmrxvkczt7z097qvhuxy8m0787am9wvhd2atlh8e8f0p9ut6pfmjal2azmdd22kluecxw234p8cnvmsm29x \
			and tmEPjALmEjr5djXhWfwcVfXgG92Ugri9R3n (textest18v636ga7hsnqq5zhx9slnjcf5zps3vgywh233k): \
			tx 2fa3a6a7649ae93824cb2faf1de4b4ad63f386cf20434acf36cd908a9345d421 failed";
		assert_eq!(
			Com_LogSafe( line ),
			"sending 150000 at height 4401862 to <address> and <address> (<address>): tx <txid> failed"
		);
	}

	#[test]
	fn keys_are_masked_whatever_kind() {
		let sapling = "secret-extended-key-test1qqqqqqqqqqqqqqq5af058f4g99l2rr9yznxwakuaq6n04ywpnl4sdvnzr60eh0c5zl";
		assert_eq!( Com_LogSafe( &format!( "bad key {sapling}." ) ), "bad key <key>." );
		assert_eq!( Com_LogSafe( "uviewtest1q2w3e4r5t6y7u8i9o0pasdfghjklzxcvbnm" ), "<key>" );

		let mut payload = zcash_keys::constants::testnet::B58_SECRET_KEY_PREFIX.to_vec();
		payload.extend_from_slice( &[ 0x11; 32 ] );
		payload.push( 1 );
		let wif = bs58::encode( payload ).with_check().into_string();
		assert_eq!( Com_LogSafe( &format!( "key={wif}" ) ), "key=<key>" );
	}

	/*
	==================
	amounts_by_their_unit_are_masked

	Word for word the engine's refusal of 2026-09-26 (the amount changed),
	and the other shapes; a height stays
	==================
	*/
	#[test]
	fn amounts_by_their_unit_are_masked() {
		assert_eq!(
			Com_LogSafe( "Insufficient funds: required 1250000 zatoshis, but only 0 zatoshis were available." ),
			"Insufficient funds: required <amount> zatoshis, but only <amount> zatoshis were available."
		);
		assert_eq!( Com_LogSafe( "value Zatoshis(150000) at height 4401862" ), "value Zatoshis(<amount>) at height 4401862" );
		assert_eq!( Com_LogSafe( "sent 2.5 ZEC, fee 10000 zats" ), "sent <amount>.<amount> ZEC, fee <amount> zats" );
		assert_eq!( Com_LogSafe( "the 5000 zatoshis at this key don't cover the 10000 zatoshi fee" ), "the <amount> zatoshis at this key don't cover the <amount> zatoshi fee" );
	}

	/*
	==================
	a_phrase_or_a_sync_code_is_masked_by_its_shape

	W1-04: a phrase's words are short, so Com_Mask passed them; one line
	formatting a recovery phrase (the engine's RecoveryInfo printed it
	whole, until W1-04 took its Display and redacted its Debug) would have
	put it in the file. Five or more phrase words in a
	row are taken for a phrase; a run of four-letter base32 groups, dashed
	or spaced, for a sync code
	==================
	*/
	#[test]
	fn a_phrase_or_a_sync_code_is_masked_by_its_shape() {
		let twelve = "abandon ability able about above absent absorb abstract absurd abuse access accident";
		assert_eq!( Com_LogSafe( &format!( "[{twelve}]" ) ), "[<words>]" );
		assert_eq!( Com_LogSafe( &format!( "seed: {}.", crate::w_test::TEST_WORDS_24 ) ), "seed: <words>." );
		assert_eq!( Com_LogSafe( "joined with ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567: ok" ), "joined with <code>: ok" );
		assert_eq!( Com_LogSafe( "the code: abcd efgh ijkl mnop qrst uvwx" ), "the code: <code>" );
		assert_eq!( Com_LogSafe( "abandon ability able about" ), "abandon ability able about", "four words are only words" );

		// as phrases sit in strings: a JSON array, a numbered list
		let words: Vec< &str > = twelve.split( ' ' ).collect();
		let json = format!( "[{}]", words.iter().map( |w| format!( "\"{w}\"" ) ).collect::< Vec< _ > >().join( ", " ) );
		assert_eq!( Com_LogSafe( &json ), "[\"<words>\"]" );
		let numbered = words.iter().enumerate().map( |( i, w )| format!( "{}. {w}", i + 1 ) ).collect::< Vec< _ > >().join( " " );
		assert_eq!( Com_LogSafe( &format!( "words: {numbered}" ) ), "words: 1. <words>" );
		let listed = words.iter().enumerate().map( |( i, w )| format!( "{}) {w};", i + 1 ) ).collect::< Vec< _ > >().join( " " );
		assert_eq!( Com_LogSafe( &listed ), "1) <words>;" );
		assert_eq!( Com_LogSafe( "1. abandon, 2. ability, 3. able, 4. about" ), "1. abandon, 2. ability, 3. able, 4. about", "four, however listed" );
	}

	#[test]
	fn ordinary_words_and_short_ids_pass_untouched() {
		let line = "W_PickServer: https://testnet.zec.rocks:443 (120 ms, of 3 that answered) [laurel_lib::w_server]";
		assert_eq!( Com_LogSafe( line ), line );
	}
}
