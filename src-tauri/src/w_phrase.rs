/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_phrase.rs -- recovery phrases: the word list and checking a phrase

use bip0039::{ English, Language, Mnemonic };
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::OsRng;
use zeroize::Zeroizing;

use crate::w_local::*;

// a new phrase is 24 words: 256 bits of entropy
pub const NEW_PHRASE_ENTROPY: usize = 32;


/*
==================
W_NormalizePhrase

Whatever was pasted, from wherever: one space between words, lowercase
==================
*/
pub fn W_NormalizePhrase( phrase: &str ) -> Zeroizing< String > {
	// one buffer, sized up front so it never moves (a move leaves the old
	// bytes behind), and wiped on drop: no per-word copies of a phrase (F-02).
	// Lowercasing at most triples a character's bytes
	let mut out = Zeroizing::new( String::with_capacity( phrase.len() * 3 ) );
	for word in phrase.split_whitespace() {
		if ( !out.is_empty() ) {
			out.push( ' ' );
		}
		for c in word.chars() {
			out.extend( c.to_lowercase() );
		}
	}
	out
}

/*
==================
W_NewPhrase

A brand new 24-word recovery phrase. The 256 bits come straight from the
operating system's generator (OsRng: getrandom), the same source as the
vault's keys, with no user-space generator between. OsRng panics if the
system can't supply them; there is no fallback to a time, a counter or a
serial (the Coldcard failure of July 2026).
==================
*/
pub fn W_NewPhrase() -> Zeroizing< String > {
	let mut entropy = Zeroizing::new( [ 0u8; NEW_PHRASE_ENTROPY ] );
	OsRng.fill_bytes( entropy.as_mut_slice() );
	// the copy is the mnemonic's own from here, wiped with it as it drops (bip0039 0.14 keeps
	// its entropy and phrase in Zeroizing; W1-08), and the array above is wiped as it drops
	let mnemonic = Mnemonic::< English >::from_entropy( entropy.to_vec() )
		.expect( "32 bytes is a valid bip-39 entropy length" );
	Zeroizing::new( mnemonic.phrase().to_string() )
}

/*
==================
W_Wordlist

The 2048 bip-39 english words, for autocomplete in the ui
==================
*/
pub fn W_Wordlist() -> Vec< &'static str > {
	English::words().to_vec()
}

/*
==================
W_CheckPhrase / W_PhraseProblem

Checks a phrase as it is typed, and says what is wrong in words a
person can act on (the ui's, by the error's code: uiWords_t). Every
zcash wallet that shows a phrase uses bip-39, at 12, 15, 18, 21 or 24
words. Restoring asks the same question (W_PhraseProblem), so what the
check says and what Restore refuses are one decision.
==================
*/
pub fn W_CheckPhrase( phrase: &str ) -> phraseCheck_t {
	let normalized = W_NormalizePhrase( phrase );
	let words: Vec< &str > = normalized.split( ' ' ).filter( |s| !s.is_empty() ).collect();
	let unknown = words.iter().enumerate().filter( |( _, w )| English::index_of( w ).is_none() ).map( |( i, _ )| i as u32 ).collect();
	let problem = W_PhraseProblem( phrase );
	phraseCheck_t {
		words:		words.len() as u32,
		unknown:	unknown,
		valid:		problem.is_none(),
		problem:	problem.map_or( String::new(), |e| e.UiMessage() ),
	}
}

pub fn W_PhraseProblem( phrase: &str ) -> Option< werr_t > {
	let normalized = W_NormalizePhrase( phrase );
	let words: Vec< &str > = normalized.split( ' ' ).filter( |s| !s.is_empty() ).collect();
	if let Some( first ) = words.iter().position( |w| English::index_of( w ).is_none() ) {
		return Some( werr_t::WERR_SEED_WORD( first as u32 + 1, words[first].to_string() ) );
	}
	if ( !PHRASE_LENGTHS.contains( &( words.len() as u32 ) ) ) {
		return Some( werr_t::WERR_SEED_LENGTH );
	}
	if ( Mnemonic::< English >::from_phrase( normalized.as_str() ).is_err() ) {
		return Some( werr_t::WERR_SEED_CHECKSUM );
	}
	None
}


/*
=========================================================================

TESTS

the phrases are bip-39's own test vectors: valid, and holding nothing

=========================================================================
*/

#[cfg( test )]
mod tests {
	use super::*;

	use crate::w_test::{ TEST_WORDS as VALID_12, TEST_WORDS_24 as VALID_24 };

	#[test]
	fn accepts_12_and_24_words() {
		assert!( W_CheckPhrase( VALID_12 ).valid );
		assert!( W_CheckPhrase( VALID_24 ).valid );
	}

	#[test]
	fn forgives_spacing_and_capitals() {
		let messy = format!( "  {}  ", VALID_12.to_uppercase().replace( ' ', "   " ) );
		assert!( W_CheckPhrase( &messy ).valid );
		assert_eq!( W_NormalizePhrase( &messy ).as_str(), VALID_12 );
	}

	#[test]
	fn names_the_unknown_word() {
		let check = W_CheckPhrase( &VALID_12.replacen( "abandon", "abandn", 1 ) );
		assert!( !check.valid );
		assert_eq!( check.unknown, vec![ 0 ] );
		assert!( check.problem.contains( "Word 1" ) );
	}

	#[test]
	fn rejects_a_bad_checksum() {
		// every word valid, last one wrong
		let check = W_CheckPhrase( &VALID_12.replace( "about", "abandon" ) );
		assert!( !check.valid );
		assert!( check.unknown.is_empty() );
		assert!( check.problem.contains( "don't form a recovery phrase" ) );
	}

	#[test]
	fn rejects_odd_lengths() {
		let check = W_CheckPhrase( "abandon abandon abandon" );
		assert!( !check.valid );
		assert!( check.problem.contains( "12, 15, 18, 21 or 24" ) );
	}

	#[test]
	fn new_phrases_are_24_valid_words() {
		let phrase = W_NewPhrase();
		assert_eq!( phrase.split( ' ' ).count(), 24 );
		assert!( W_CheckPhrase( &phrase ).valid );
		// the words decode back to 256 bits of entropy
		let mnemonic = Mnemonic::< English >::from_phrase( phrase.as_str() ).unwrap();
		assert_eq!( mnemonic.entropy().len(), NEW_PHRASE_ENTROPY );
	}

	#[test]
	fn new_phrases_never_repeat() {
		// a weak or fixed generator shows up here as a repeat, a shared prefix or a stuck byte
		let mut seen = std::collections::HashSet::new();
		let mut ones = [ 0u32; NEW_PHRASE_ENTROPY * 8 ];
		const N: u32 = 1000;
		for _ in 0..N {
			let phrase = W_NewPhrase();
			let mnemonic = Mnemonic::< English >::from_phrase( phrase.as_str() ).unwrap();
			for ( i, byte ) in mnemonic.entropy().iter().enumerate() {
				for bit in 0..8 {
					ones[ i * 8 + bit ] += u32::from( ( byte >> bit ) & 1 );
				}
			}
			assert!( seen.insert( phrase.split( ' ' ).take( 4 ).collect::< Vec< _ > >().join( " " ) ), "two new phrases share their first 4 words" );
		}
		// each bit is set about half the time: 500 ± 6 sigma (sigma ≈ 15.8). At
		// 5 sigma one of 256 bits strayed by chance about once in 7,000 runs
		for ( i, n ) in ones.iter().enumerate() {
			assert!( ( 405..=595 ).contains( n ), "entropy bit {i} was set {n} times in {N}" );
		}
	}

	#[test]
	fn recovery_debug_never_prints_the_words() {
		let recovery = recovery_t { seedPhrase: VALID_24.to_string(), passphrase: Some( "open sesame".into() ), birthday: 1, birthdayTime: None };
		let printed = format!( "{recovery:?}" );
		assert!( !printed.contains( "abandon" ) && !printed.contains( "sesame" ), "{printed}" );
	}

	#[test]
	fn wordlist_is_complete() {
		assert_eq!( W_Wordlist().len(), 2048 );
	}
}
