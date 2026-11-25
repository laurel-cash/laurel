/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_scan.rs -- understanding a scanned or pasted code: a Zcash address,
// or a ZIP-321 payment request ("zcash:<address>?amount=..."). The ui
// decodes the QR image; everything about what the text means is here.

use zcash_address::{ ConversionError, TryFromAddress, ZcashAddress };
use zcash_protocol::consensus::NetworkType;
use zcash_protocol::memo::Memo;
use zcash_protocol::value::Zatoshis;
use zip321::{ Payment, TransactionRequest, Zip321Error };

use crate::w_local::*;
use crate::w_net::engineResult_t;

const URI_SCHEME: &str = "zcash:";


// what convert_if_network finds: only the kind is kept
impl TryFromAddress for addrKind_t {
	type Error = ();

	fn try_from_sapling( _: NetworkType, _: [ u8; 43 ] ) -> Result< Self, ConversionError< () > > {
		Ok( addrKind_t::ADDR_SAPLING )
	}

	// by its receivers, not its encoding (W2-02): without a shielded one this wallet can
	// pay, it is paid in public, as a t-address is
	fn try_from_unified( _: NetworkType, ua: zcash_address::unified::Address ) -> Result< Self, ConversionError< () > > {
		Ok( if ( ua.can_receive_memo() ) { addrKind_t::ADDR_UNIFIED } else { addrKind_t::ADDR_TRANSPARENT } )
	}

	fn try_from_transparent_p2pkh( _: NetworkType, _: [ u8; 20 ] ) -> Result< Self, ConversionError< () > > {
		Ok( addrKind_t::ADDR_TRANSPARENT )
	}

	fn try_from_transparent_p2sh( _: NetworkType, _: [ u8; 20 ] ) -> Result< Self, ConversionError< () > > {
		Ok( addrKind_t::ADDR_TRANSPARENT )
	}

	fn try_from_tex( _: NetworkType, _: [ u8; 20 ] ) -> Result< Self, ConversionError< () > > {
		Ok( addrKind_t::ADDR_TEX )
	}
}

/*
==================
Com_NetName
==================
*/
fn Com_NetName( n: NetworkType ) -> &'static str {
	match n {
		NetworkType::Main		=> "Mainnet",
		NetworkType::Test		=> "Testnet",
		NetworkType::Regtest	=> "Regtest",
	}
}

/*
==================
W_KindOf

The address's kind, if it belongs to this network and can still be paid
==================
*/
fn W_KindOf( addr: &ZcashAddress, net: network_t ) -> wresult_t< addrKind_t > {
	let want = match net {
		network_t::NET_MAINNET => NetworkType::Main,
		network_t::NET_TESTNET => NetworkType::Test,
	};

	match addr.clone().convert_if_network::< addrKind_t >( want ) {
		Ok( kind ) => Ok( kind ),
		Err( ConversionError::IncorrectNetwork { expected, actual } ) => Err( werr_t::WERR_WRONG_NETWORK( Com_NetName( actual ), Com_NetName( expected ) ) ),
		Err( ConversionError::Unsupported( _ ) ) => Err( werr_t::WERR_OLD_ADDRESS( "Sprout" ) ),
		Err( ConversionError::User( () ) ) => Err( werr_t::WERR_NOT_ZCASH ),
	}
}

/*
==================
W_RequestUri

A ZIP-321 request for one payment of amount to address, and a memo the
payer's wallet fills in for them (a private address only: W_CheckMemo).
The same parser that reads a scanned request reads it back.
==================
*/
pub fn W_RequestUri( net: network_t, address: &str, amount: u64, memo: Option< String > ) -> wresult_t< String > {
	let addr = ZcashAddress::try_from_encoded( address ).map_err( |_| werr_t::WERR_NOT_ZCASH )?;
	let kind = W_KindOf( &addr, net )?;
	let zats = Zatoshis::from_u64( amount ).map_err( |_| werr_t::WERR_MORE_THAN_EXISTS )?;
	if ( zats.is_zero() ) {
		return Err( werr_t::WERR_NO_AMOUNT );
	}
	let memo = crate::w_send::W_CheckMemo( &memo, kind )?;
	let payment = Payment::new( addr, Some( zats ), memo, None, None, vec![] ).map_err( |_| werr_t::WERR_MEMO_PUBLIC )?;
	Ok( TransactionRequest::new( vec![ payment ] ).engine()?.to_uri() )
}

/*
==================
Com_Unwrap

An address or a key as pasted, put back together: none holds a space or
a line break, and a long one copied from an email or a PDF arrives in
pieces where it wrapped
==================
*/
pub fn Com_Unwrap( text: &str ) -> String {
	text.chars().filter( |c| !c.is_whitespace() ).collect()
}

/*
==================
Com_Uncapital

An address in capitals, as some apps put it in a QR code (capitals make
it smaller), back in the small letters it is read in. Only all-capital
text changes: a public address mixes cases and is read exactly
==================
*/
fn Com_Uncapital( text: &str ) -> String {
	if ( text.chars().any( |c| c.is_ascii_lowercase() ) ) {
		return text.to_string();
	}
	text.to_ascii_lowercase()
}

/*
==================
W_ParseScan

What was scanned, typed or pasted. A bare address is unwrapped
(Com_Unwrap); a payment request keeps its text, as its message is words
==================
*/
pub fn W_ParseScan( net: network_t, text: &str ) -> wresult_t< scanned_t > {
	let text = text.trim();

	if ( !text.get( ..URI_SCHEME.len() ).is_some_and( |p| p.eq_ignore_ascii_case( URI_SCHEME ) ) ) {
		let addr = ZcashAddress::try_from_encoded( &Com_Uncapital( &Com_Unwrap( text ) ) ).map_err( |_| werr_t::WERR_NOT_ZCASH )?;
		return Ok( scanned_t {
			address:	addr.encode(),
			kind:		W_KindOf( &addr, net )?,
			amount:		None,
			memo:		None,
			label:		None,
			message:	None,
			also:		vec![],
		} );
	}

	// the scheme and address may be in capitals; what follows them never is
	let ( head, rest ) = text.split_at( text.find( '?' ).unwrap_or( text.len() ) );
	let request = TransactionRequest::from_uri( &( Com_Uncapital( head ) + rest ) ).map_err( |e| match e {
		Zip321Error::TransparentMemo( _ ) => werr_t::WERR_MEMO_PUBLIC,		// a request, just not one Laurel can pay as asked
		_ => werr_t::WERR_NOT_ZCASH,
	} )?;
	let payments = request.payments();
	let Some( first ) = payments.values().next() else {
		return Err( werr_t::WERR_NOT_ZCASH );
	};
	// a request for several payments is read whole, or refused whole: paying
	// some would be payments nobody asked for, and each needs its amount, as
	// nothing but an exact number can be shown for review
	if ( payments.len() > crate::w_send::MAX_PAYMENTS ) {
		return Err( werr_t::WERR_TOO_MANY_PAYMENTS( crate::w_send::MAX_PAYMENTS as u32 ) );
	}
	if ( payments.len() > 1 && payments.values().any( |p| p.amount().is_none_or( |z| z.is_zero() ) ) ) {
		return Err( werr_t::WERR_MULTI_PAYMENT( payments.len() as u32 ) );
	}
	let addr = first.recipient_address();

	// W2-03: a memo that isn't text can be neither shown nor sent, and whoever asked may
	// need it (an exchange, to credit a deposit): the request is refused, never paid without
	let text = |p: &zip321::Payment| -> wresult_t< Option< String > > {
		match p.memo().map( |m| Memo::try_from( m.clone() ) ) {
			None | Some( Ok( Memo::Empty ) ) => Ok( None ),
			Some( Ok( Memo::Text( t ) ) ) => Ok( Some( t.to_string() ) ),
			Some( _ ) => Err( werr_t::WERR_MEMO_NOT_TEXT ),
		}
	};
	let memo = text( first )?;
	let mut also = vec![];
	for p in payments.values().skip( 1 ) {
		W_KindOf( p.recipient_address(), net )?;		// every one on this network, or the whole request is refused
		also.push( payTo_t { to: p.recipient_address().encode(), zats: p.amount().map_or( 0, |z| z.into_u64() ), memo: text( p )? } );
	}

	Ok( scanned_t {
		address:	addr.encode(),
		kind:		W_KindOf( addr, net )?,
		amount:		first.amount().map( |z| z.into_u64() ),
		memo:		memo,
		label:		first.label().map( |t| crate::w_main::Com_CleanText( t ) ),		// shown as who is paid: only what shows as itself
		message:	first.message().map( |t| crate::w_main::Com_CleanText( t ) ),
		also:		also,
	} )
}


#[cfg( test )]
mod tests {
	use super::*;

	// the ZIP-321 specification's own example addresses
	const MAIN_SAPLING: &str = "zs1qqqqqqqqqqqqqqqqqqcguyvaw2vjk4sdyeg0lc970u659lvhqq7t0np6hlup5lusxle75c8v35z";
	const MAIN_T: &str = "t1PKtYdJJHhc3Pxowmznkg7vdTwnhEsCvR4";

	/*
	==================
	a_unified_address_without_a_shielded_receiver_is_public

	W2-02: ZIP 316 Revision 2 lets a unified address (tu1...) hold a public
	receiver alone, and Revision 0 one beside a receiver this wallet can't
	pay. Paid, either is public: shown so, with no memo, and warned of
	==================
	*/
	#[test]
	fn a_unified_address_without_a_shielded_receiver_is_public() {
		use zcash_address::unified::{ self, Encoding, Receiver, Revision, Uitem };
		let ua = |rev: Revision, items: Vec< Receiver >| unified::Address::try_from_items( rev, items.into_iter().map( Uitem::Data ).collect() ).unwrap().encode( &NetworkType::Main );
		let unknown = || Receiver::Unknown { typecode: 0x30, data: vec![ 7; 32 ] };

		let alone = ua( Revision::R2, vec![ Receiver::P2pkh( [ 1; 20 ] ) ] );
		assert!( alone.starts_with( "tu1" ), "{alone}" );
		for public in [ alone, ua( Revision::R0, vec![ Receiver::P2pkh( [ 1; 20 ] ), unknown() ] ) ] {
			let s = W_ParseScan( network_t::NET_MAINNET, &public ).unwrap();
			assert_eq!( s.kind, addrKind_t::ADDR_TRANSPARENT, "{public}" );
			assert!( matches!( crate::w_send::W_CheckMemo( &Some( "hi".into() ), s.kind ), Err( werr_t::WERR_MEMO_PUBLIC ) ) );
		}

		for private in [ ua( Revision::R0, vec![ Receiver::Orchard( [ 0; 43 ] ), Receiver::P2pkh( [ 1; 20 ] ) ] ), ua( Revision::R0, vec![ Receiver::Sapling( [ 0; 43 ] ) ] ) ] {
			assert_eq!( W_ParseScan( network_t::NET_MAINNET, &private ).map( |s| s.kind ).ok(), Some( addrKind_t::ADDR_UNIFIED ), "{private}" );
		}
	}

	// W2-02: and the engine pays one, in public: it reads it as a unified address with a
	// public receiver alone, which its input selection pays with a transparent output
	// (zcash_client_backend 0.25, input_selection.rs), as it pays the t-address
	#[test]
	fn the_engine_reads_a_unified_address_without_a_shielded_receiver_as_public() {
		#[allow( deprecated )]		// zcash_keys's, as the engine has it
		use zcash_client_backend::address::Address;
		use zcash_address::unified::{ self, Encoding, Receiver, Revision, Uitem };

		let tu = unified::Address::try_from_items( Revision::R2, vec![ Uitem::Data( Receiver::P2pkh( [ 1; 20 ] ) ) ] ).unwrap().encode( &NetworkType::Main );
		let read = Address::try_from_zcash_address( &zcash_protocol::consensus::MAIN_NETWORK, ZcashAddress::try_from_encoded( &tu ).unwrap() );
		let Ok( Address::Unified( ua ) ) = read else {
			panic!( "{tu}: {read:?}" );
		};
		assert!( ua.has_transparent() && !ua.has_sapling() && !ua.has_orchard() );
	}

	/*
	==================
	a_request_keeps_its_memo_or_is_refused

	W2-03: a memo that isn't text (ZIP 302's arbitrary bytes, or a kind not
	yet defined) can't be shown or sent, and an exchange may need it to
	credit the deposit: the request is refused, never paid without it. An
	empty memo is no memo. A memo for a public address is refused as that,
	not as a code that isn't Zcash's
	==================
	*/
	#[test]
	fn a_request_keeps_its_memo_or_is_refused() {
		let bytes = |b: &[ u8 ]| base64::Engine::encode( &base64::engine::general_purpose::URL_SAFE_NO_PAD, b );
		let first = |memo: &str| W_ParseScan( network_t::NET_MAINNET, &format!( "zcash:{MAIN_SAPLING}?amount=1&memo={memo}" ) );
		let second = |memo: &str| W_ParseScan( network_t::NET_MAINNET, &format!( "zcash:?address={MAIN_SAPLING}&amount=1&address.1={MAIN_SAPLING}&amount.1=1&memo.1={memo}" ) );

		for memo in [ bytes( &[ 0xFF, 1, 2, 3 ] ), bytes( &[ 0xF5, 9 ] ) ] {
			assert!( matches!( first( &memo ), Err( werr_t::WERR_MEMO_NOT_TEXT ) ), "{memo}: {:?}", first( &memo ) );
			assert!( matches!( second( &memo ), Err( werr_t::WERR_MEMO_NOT_TEXT ) ), "{memo}: {:?}", second( &memo ) );
		}
		assert_eq!( first( &bytes( &[ 0xF6 ] ) ).unwrap().memo, None, "the empty memo" );
		assert_eq!( first( &bytes( b"Order 42" ) ).unwrap().memo.as_deref(), Some( "Order 42" ) );

		let public = format!( "zcash:{MAIN_T}?amount=1&memo={}", bytes( b"hi" ) );
		assert!( matches!( W_ParseScan( network_t::NET_MAINNET, &public ), Err( werr_t::WERR_MEMO_PUBLIC ) ), "{:?}", W_ParseScan( network_t::NET_MAINNET, &public ) );
		let publicSecond = format!( "zcash:?address={MAIN_SAPLING}&amount=1&address.1={MAIN_T}&amount.1=1&memo.1={}", bytes( b"hi" ) );
		assert!( matches!( W_ParseScan( network_t::NET_MAINNET, &publicSecond ), Err( werr_t::WERR_MEMO_PUBLIC ) ) );
	}

	// W2-10: a request for more than exists says so; for nothing, that
	#[test]
	fn a_request_for_more_than_exists_says_so() {
		let max = zcash_protocol::value::MAX_MONEY;
		assert!( W_RequestUri( network_t::NET_MAINNET, MAIN_SAPLING, max, None ).is_ok() );
		assert!( matches!( W_RequestUri( network_t::NET_MAINNET, MAIN_SAPLING, max + 1, None ), Err( werr_t::WERR_MORE_THAN_EXISTS ) ) );
		assert!( matches!( W_RequestUri( network_t::NET_MAINNET, MAIN_SAPLING, 0, None ), Err( werr_t::WERR_NO_AMOUNT ) ) );
	}

	#[test]
	fn reads_a_plain_address() {
		let s = W_ParseScan( network_t::NET_MAINNET, MAIN_T ).unwrap();
		assert_eq!( s.kind, addrKind_t::ADDR_TRANSPARENT );
		assert_eq!( s.address, MAIN_T );
		assert_eq!( s.amount, None );
	}

	// QR codes are smaller in capitals, so some apps show addresses that way
	#[test]
	fn reads_an_address_in_capitals() {
		let upper = MAIN_SAPLING.to_uppercase();
		assert_eq!( W_ParseScan( network_t::NET_MAINNET, &upper ).unwrap().address, MAIN_SAPLING );
		assert_eq!( W_ParseScan( network_t::NET_MAINNET, &format!( "ZCASH:{upper}" ) ).unwrap().address, MAIN_SAPLING );
	}

	#[test]
	fn reads_a_payment_request() {
		let uri = format!( "zcash:{MAIN_SAPLING}?amount=1.25&message=Thanks%20for%20lunch" );
		let s = W_ParseScan( network_t::NET_MAINNET, &uri ).unwrap();
		assert_eq!( s.kind, addrKind_t::ADDR_SAPLING );
		assert_eq!( s.amount, Some( 125_000_000 ) );
		assert_eq!( s.message.as_deref(), Some( "Thanks for lunch" ) );

		let spoofed = format!( "zcash:{MAIN_SAPLING}?amount=1&label=Mo%E2%80%AEm" );
		assert_eq!( W_ParseScan( network_t::NET_MAINNET, &spoofed ).unwrap().label.as_deref(), Some( "Mom" ), "a direction override never reaches the screen" );
	}

	/*
	==================
	reads_a_request_for_several_payments_whole

	ZIP 321's own two-payment example, read whole: every payment with its
	amount, so the review can show each. Without an amount for each, or
	past the cap, the whole request is refused: paying some of it would pay
	what nobody asked for
	==================
	*/
	#[test]
	fn reads_a_request_for_several_payments_whole() {
		let uri = format!( "zcash:?address={MAIN_T}&amount=123.456&address.1={MAIN_SAPLING}&amount.1=0.789&memo.1=VGhhbmsgeW91" );
		let read = W_ParseScan( network_t::NET_MAINNET, &uri ).unwrap();
		assert_eq!( ( read.address.as_str(), read.amount ), ( MAIN_T, Some( 12_345_600_000 ) ) );
		assert_eq!( read.also, vec![ payTo_t { to: MAIN_SAPLING.to_string(), zats: 78_900_000, memo: Some( "Thank you".to_string() ) } ] );

		let unpriced = format!( "zcash:?address={MAIN_T}&amount=1&address.1={MAIN_SAPLING}" );
		assert!( matches!( W_ParseScan( network_t::NET_MAINNET, &unpriced ), Err( werr_t::WERR_MULTI_PAYMENT( 2 ) ) ) );

		let many = ( 1..=crate::w_send::MAX_PAYMENTS ).map( |i| format!( "&address.{i}={MAIN_T}&amount.{i}=1" ) ).collect::< String >();
		let too_many = format!( "zcash:?address={MAIN_T}&amount=1{many}" );
		assert!( matches!( W_ParseScan( network_t::NET_MAINNET, &too_many ), Err( werr_t::WERR_TOO_MANY_PAYMENTS( _ ) ) ) );
	}

	/*
	==================
	an_address_split_across_lines_reads_whole

	A long address copied from an email or a PDF arrives in pieces, with
	line breaks and spaces where it wrapped; no Zcash address holds any.
	Typed into Send it was already joined, but the Paste button gave it to
	this as it came, and it read as "not a Zcash address". A viewing key
	only lost the spaces at its ends
	==================
	*/
	#[test]
	fn an_address_split_across_lines_reads_whole() {
		let wrapped = format!( "  {}
{} 
", &MAIN_SAPLING[..40], &MAIN_SAPLING[40..] );
		let read = W_ParseScan( network_t::NET_MAINNET, &wrapped ).unwrap();
		assert_eq!( read.address, MAIN_SAPLING );
		assert_eq!( Com_Unwrap( "uviewtest1qqq
  rrr	sss " ), "uviewtest1qqqrrrsss", "a viewing key too (W_RestoreViewKey)" );
	}

	#[test]
	fn says_when_the_network_is_wrong() {
		let e = W_ParseScan( network_t::NET_TESTNET, MAIN_T ).unwrap_err();
		assert!( matches!( e, werr_t::WERR_WRONG_NETWORK( "Mainnet", "Testnet" ) ), "{e:?}" );
	}

	#[test]
	fn refuses_what_isnt_zcash() {
		for junk in [ "", "hello", "bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT", "zcash:", "https://example.com" ] {
			assert!( matches!( W_ParseScan( network_t::NET_MAINNET, junk ), Err( werr_t::WERR_NOT_ZCASH ) ), "{junk}" );
		}
	}

	/*
	==================
	a_request_reads_back_as_asked

	What Receive asks for, Scan reads back exactly; a memo is refused for a
	public address and nothing is asked for zero
	==================
	*/
	#[test]
	fn a_request_reads_back_as_asked() {
		let uri = W_RequestUri( network_t::NET_MAINNET, MAIN_SAPLING, 123_456_789, Some( "Rent, October".to_string() ) ).unwrap();
		let read = W_ParseScan( network_t::NET_MAINNET, &uri ).unwrap();
		assert_eq!( ( read.address.as_str(), read.amount, read.memo.as_deref() ), ( MAIN_SAPLING, Some( 123_456_789 ), Some( "Rent, October" ) ) );

		let plain = W_RequestUri( network_t::NET_MAINNET, MAIN_T, 1, None ).unwrap();
		assert_eq!( W_ParseScan( network_t::NET_MAINNET, &plain ).unwrap().amount, Some( 1 ) );

		assert!( matches!( W_RequestUri( network_t::NET_MAINNET, MAIN_T, 1, Some( "hi".into() ) ), Err( werr_t::WERR_MEMO_PUBLIC ) ) );
		assert!( matches!( W_RequestUri( network_t::NET_MAINNET, MAIN_SAPLING, 0, None ), Err( werr_t::WERR_NO_AMOUNT ) ) );
		assert!( matches!( W_RequestUri( network_t::NET_TESTNET, MAIN_SAPLING, 1, None ), Err( werr_t::WERR_WRONG_NETWORK( _, _ ) ) ) );
	}
}
