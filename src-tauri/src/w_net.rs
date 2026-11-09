/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_net.rs -- talking to the lightwalletd server: chain tip, block times,
// and errors a person can understand

use std::time::Duration;

use zcash_protocol::consensus::{ NetworkUpgrade, Parameters };
use zingo_netutils::lightwallet_protocol::BlockId;
use zingo_netutils::{ GrpcIndexer, Indexer };
use zingolib::config::ChainType;

use crate::w_local::*;
use crate::w_server::{ W_Connect, W_Server, W_ServerFailed };

type tonic_status_t = zingo_netutils::Status;


/*
==================
W_BlockEras

Every network's target block spacing by height: one era from genesis,
and one from each upgrade that changed the spacing, at the height the
engine's consensus rules give it. A height past them all is in the last;
an upgrade with no height on a network adds none (mainnet is refused by
the testnet-only build). The spacings are the ZIPs', the same as
zcash_protocol's own (a test holds them to it).
==================
*/
pub const PRE_BLOSSOM_BLOCK_SECS: u32	= 150;		// ZIP 208
pub const POST_BLOSSOM_BLOCK_SECS: u32	= 75;		// ZIP 208
pub const POST_NU7_BLOCK_SECS: u32		= 25;		// ZIP 218

pub fn W_BlockEras() -> Vec< blockEra_t > {
	let mut eras = vec![];
	for net in [ network_t::NET_MAINNET, network_t::NET_TESTNET ] {
		let chain = W_ChainType( net );
		eras.push( blockEra_t { network: net, from: 0, secs: PRE_BLOSSOM_BLOCK_SECS } );
		for ( nu, secs ) in [ ( NetworkUpgrade::Blossom, POST_BLOSSOM_BLOCK_SECS ), ( NetworkUpgrade::Nu7, POST_NU7_BLOCK_SECS ) ] {
			if let Some( from ) = chain.activation_height( nu ) {
				eras.push( blockEra_t { network: net, from: u32::from( from ), secs: secs } );
			}
		}
	}
	eras
}

/*
==================
W_ChainType
==================
*/
pub fn W_ChainType( net: network_t ) -> ChainType {
	match net {
		network_t::NET_MAINNET => ChainType::Mainnet,
		network_t::NET_TESTNET => ChainType::Testnet,
	}
}

/*
==================
W_Indexer

A fresh connection to the server net's wallets use (w_server.rs)
==================
*/
pub async fn W_Indexer( net: network_t ) -> wresult_t< GrpcIndexer > {
	let uri = W_Server( net ).await?;
	W_Connect( &uri ).await.inspect_err( |e| W_ServerFailed( net, Some( &uri ), e ) )
}

pub fn W_StatusError( e: tonic_status_t ) -> werr_t {
	Com_Classify( &e )
}

/*
==================
W_Broadcast

A signed transaction's bytes to the network, through net's server: a
sweep, or a payment signed on another computer (w_offline.rs)
==================
*/
pub async fn W_Broadcast( net: network_t, raw: Vec< u8 > ) -> wresult_t< () > {
	let mut indexer = W_Indexer( net ).await?;
	match indexer.send_transaction( zingo_netutils::lightwallet_protocol::RawTransaction { data: raw, height: 0 }, Duration::from_secs( SERVER_TIMEOUT_SECS ) ).await {
		Ok( _ ) => Ok( () ),
		// in its mempool or a block already: delivered, earlier or by anyone
		Err( e ) if e.code() == tonic::Code::Unknown && zingolib::lightclient::send::already_has_it( e.message() ) => Ok( () ),
		Err( e ) => Err( Com_SendError( e ) ),
	}
}

/*
==================
Com_SendError

A broadcast that failed. Only a server's refusal of the transaction itself
(its reason comes back as Unknown, zingo-netutils' send_transaction, and
reads as malformed bytes: the engine's own reading) says it went nowhere;
any other answer, a timeout or a dropped connection may hide a delivery,
and is unsure (security review A-03). Every server once answering Unknown
read as refused, whatever its words: a payment already in could be signed
again from other coins
==================
*/
fn Com_SendError( e: tonic::Status ) -> werr_t {
	if ( e.code() == tonic::Code::Unknown && zingolib::lightclient::send::refused_on_its_own( e.message() ) ) {
		return werr_t::WERR_REJECTED( e.message().to_string() );
	}
	werr_t::WERR_SENT_UNSURE( Com_CauseChain( &e ) )
}

// a request the server failed: in automatic mode the next connection picks another
fn Com_Failed( net: network_t ) -> impl Fn( tonic_status_t ) -> werr_t {
	move |e| {
		let e = W_StatusError( e );
		W_ServerFailed( net, None, &e );
		e
	}
}

/*
==================
W_ChainHeight

Asks the server for the current tip. A new wallet's birthday is
derived from it, so the wallet never scans blocks from before it existed.
==================
*/
pub async fn W_ChainHeight( net: network_t ) -> wresult_t< u32 > {
	let mut indexer = W_Indexer( net ).await?;

	let block = indexer.get_latest_block( Duration::from_secs( SERVER_TIMEOUT_SECS ) ).await
		.map_err( Com_Failed( net ) )?;

	Ok( block.height as u32 )
}

/*
==================
W_SaplingHeight

No wallet can hold anything shielded from before sapling, so it is the
earliest birthday worth scanning from
==================
*/
pub fn W_SaplingHeight( net: network_t ) -> u32 {
	W_ChainType( net )
		.activation_height( NetworkUpgrade::Sapling )
		.map_or( 0, u32::from )
}

/*
==================
W_HeightForDate

Turns "when did you make this wallet" into a block height, so nobody has
to know what a block height is. Binary search over block times: about
22 requests however long the chain gets. The answer is moved back by
BIRTHDAY_MARGIN_SECS, since people misremember dates.
==================
*/
pub async fn W_HeightForDate( net: network_t, unixTime: u32 ) -> wresult_t< u32 > {
	let target	= unixTime.saturating_sub( BIRTHDAY_MARGIN_SECS );
	let timeout	= Duration::from_secs( SERVER_TIMEOUT_SECS );

	let mut indexer = W_Indexer( net ).await?;
	let tip = indexer.get_latest_block( timeout ).await.map_err( Com_Failed( net ) )?.height;

	let mut lo = W_SaplingHeight( net ) as u64;
	let mut hi = tip;

	// find the last block mined before target
	while ( lo < hi ) {
		let mid = lo + ( hi - lo + 1 ) / 2;
		let block = indexer.get_block( BlockId { height: mid, hash: vec![] }, timeout ).await
			.map_err( Com_Failed( net ) )?;

		if ( block.time <= target ) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	Ok( lo as u32 )
}

/*
==================
W_BlockTime

When a block was mined, as unix time
==================
*/
pub async fn W_BlockTime( net: network_t, height: u64 ) -> wresult_t< u32 > {
	let mut indexer = W_Indexer( net ).await?;
	let block = indexer.get_block( BlockId { height: height, hash: vec![] }, Duration::from_secs( SERVER_TIMEOUT_SECS ) ).await
		.map_err( Com_Failed( net ) )?;

	Ok( block.time )
}


/*
=========================================================================

ERRORS

=========================================================================
*/

/*
==================
Com_Find

The first error of type T in e's cause chain. io::Error hides the error
it wraps from source(), so that is looked into too.
==================
*/
fn Com_Find< 'a, T: std::error::Error + 'static >( e: &'a ( dyn std::error::Error + 'static ) ) -> Option< &'a T > {
	let mut cur = Some( e );
	while let Some( x ) = cur {
		if let Some( t ) = x.downcast_ref::< T >() {
			return Some( t );
		}
		if let Some( inner ) = x.downcast_ref::< std::io::Error >().and_then( |io| io.get_ref() ) {
			if let Some( t ) = Com_Find::< T >( inner ) {
				return Some( t );
			}
		}
		cur = x.source();
	}
	None
}

/*
==================
Com_Classify

What went wrong, decided once, from the types in the error, never its
words: the words were once all Laurel looked at, and a server one block
behind at the tip read as "could not reach the server".

Antivirus https scanning (avast, kaspersky, eset...) re-signs every
connection with its own root; the engine trusts only the real roots, so
the certificate's issuer is unknown. Said plainly.
==================
*/
fn Com_Short< DE, CE, SE, FE, CF, N >( e: &zcash_client_backend::data_api::error::Error< DE, CE, SE, FE, CF, N > ) -> bool {
	use zcash_client_backend::data_api::error::Error as BackendError;
	use zcash_client_backend::fees::ChangeError;

	matches!( e, BackendError::InsufficientFunds { .. } | BackendError::Change( ChangeError::InsufficientFunds { .. } ) )
}

pub fn Com_Classify( e: &( dyn std::error::Error + 'static ) ) -> werr_t {
	use pepper_sync::error::ServerError;
	use rustls::{ CertificateError, Error as TlsError };
	use zingolib::lightclient::error::{ TransmissionError, TransmitVerdict };
	use zingolib::wallet::error::{ ProposeSendError, ProposeShieldError };

	let why = Com_CauseChain( e );
	// a Sapling spend with no usable proving key (none, or one changed since it was
	// checked): where a good one goes (w_spendkey.rs); online, the next try fetches it
	if ( Com_Find::< zingolib::wallet::sapling_key::SaplingKeyError >( e ).is_some() ) {
		return crate::w_spendkey::Sk_Missing();
	}
	// not enough money: the backend says it as its own error or inside a change error
	if let Some( ProposeSendError::Proposal( p ) ) = Com_Find::< ProposeSendError >( e ) {
		if ( Com_Short( p ) ) {
			return werr_t::WERR_NOT_ENOUGH;
		}
	}
	if let Some( s ) = Com_Find::< ProposeShieldError >( e ) {
		let short = match s {
			ProposeShieldError::InsufficientFunds		=> true,
			ProposeShieldError::Component( p )			=> Com_Short( p ),
			ProposeShieldError::AddressParseError( _ )	=> false,
		};
		if ( short ) {
			return werr_t::WERR_SHIELD_BELOW_FEE;
		}
	}
	// a broadcast: refused, never sent, or perhaps sent (the engine says which)
	if let Some( TransmissionError::TransmissionFailed { text, verdict } ) = Com_Find::< TransmissionError >( e ) {
		return match verdict {
			TransmitVerdict::Refused		=> werr_t::WERR_REJECTED( text.clone() ),
			TransmitVerdict::Unreachable	=> werr_t::WERR_SERVER( text.clone() ),
			TransmitVerdict::Unsure			=> werr_t::WERR_SENT_UNSURE( text.clone() ),		// may have gone out: kept, sent again
		};
	}
	// zingolib 8: a send with no server is refused before anything is built (where an
	// empty draw of servers once failed the broadcast): no server, as that was
	if let Some( zingolib::lightclient::error::LightClientError::Offline ) = Com_Find::< zingolib::lightclient::error::LightClientError >( e ) {
		return werr_t::WERR_SERVER( why );
	}
	if let Some( TlsError::InvalidCertificate( CertificateError::UnknownIssuer ) ) = Com_Find::< TlsError >( e ) {
		return werr_t::WERR_INTERCEPTED;
	}
	if ( Com_Find::< tonic::TimeoutExpired >( e ).is_some() || Com_Find::< tokio::time::error::Elapsed >( e ).is_some() ) {
		return werr_t::WERR_SERVER_SLOW;
	}
	if let Some( s ) = Com_Find::< ServerError >( e ) {
		return match s {
			ServerError::RequestFailed( status ) => Com_StatusError( status.code(), why ),
			// the engine cleared the damaged sync data itself: checking again rebuilds it
			ServerError::ChainVerificationError => werr_t::WERR_SYNC_DATA( why ),
			ServerError::InvalidFrontier( _ ) | ServerError::InvalidTransaction( _ ) | ServerError::InvalidSubtreeRoot
			| ServerError::GenesisBlockOnly => werr_t::WERR_SERVER( why ),
			// it can't serve what sync needs (Ironwood's tree, a current protocol): another server can
			ServerError::TreeStateNotServed { .. } | ServerError::UnsupportedProtocolVersion { .. } => werr_t::WERR_SERVER_OUTDATED( why ),
			ServerError::FetcherDropped => werr_t::WERR_ENGINE( why ),
			// a re-org lowered the tip, or this server is behind it: the next sync starts from its height
			ServerError::ChainHeightBelowScanRange { .. } => werr_t::WERR_SERVER( why ),
		};
	}
	if let Some( status ) = Com_Find::< tonic::Status >( e ) {
		return Com_StatusError( status.code(), why );
	}
	if ( Com_Find::< tonic::transport::Error >( e ).is_some() ) {
		return werr_t::WERR_SERVER( why );
	}
	// connecting: the engine's wrapper hands the transport error's cause on transparently,
	// so the transport error itself is never in the chain; the wrapper says what failed
	if let Some( c ) = Com_Find::< zingo_netutils::GetClientError >( e ) {
		return match c {
			zingo_netutils::GetClientError::InvalidScheme | zingo_netutils::GetClientError::InvalidAuthority => werr_t::WERR_SERVER_URL,
			zingo_netutils::GetClientError::Transport( _ ) => werr_t::WERR_SERVER( why ),
		};
	}
	// the server reports no size for a pool's tree (it doesn't serve Ironwood): the server's
	// fault, not the wallet's data, so another server, never a rescan from the birthday
	if let Some( pepper_sync::error::ScanError::TreeSizeNotReported { .. } ) = Com_Find::< pepper_sync::error::ScanError >( e ) {
		return werr_t::WERR_SERVER_OUTDATED( why );
	}
	if ( Com_Find::< pepper_sync::error::SyncError< zingolib::wallet::error::WalletError > >( e ).is_some() ) {
		return werr_t::WERR_SYNC_DATA( why );		// the engine's own: the wallet's sync data
	}
	werr_t::WERR_ENGINE( why )
}

/*
==================
Com_StatusError

Every answer a server can give, each decided. No wildcard: a new code
must be thought about, not fall into "server error".
==================
*/
fn Com_StatusError( code: tonic::Code, why: String ) -> werr_t {
	use tonic::Code;

	match code {
		// the server hasn't got the block the network's tip says exists: one
		// backend of a load-balanced server behind another, for a moment
		Code::OutOfRange => werr_t::WERR_SERVER_BEHIND,
		// tonic reports its own request timeout as Cancelled
		Code::DeadlineExceeded | Code::Cancelled => werr_t::WERR_SERVER_SLOW,
		Code::Unavailable | Code::ResourceExhausted | Code::Unknown | Code::Internal | Code::Aborted
		| Code::Unimplemented | Code::InvalidArgument | Code::NotFound | Code::AlreadyExists
		| Code::PermissionDenied | Code::Unauthenticated | Code::FailedPrecondition | Code::DataLoss
		| Code::Ok => werr_t::WERR_SERVER( why ),
	}
}

/*
==================
engineResult_t::engine

The one way an engine error becomes a laurel error: `.engine()?`
instead of repeating the map_err at every call. Classified by type
(Com_Classify), so a server's refusal or a dropped connection inside an
engine call says so instead of "something went wrong inside Laurel".
==================
*/
pub trait engineResult_t< T > {
	fn engine( self ) -> wresult_t< T >;
}

impl< T, E: std::error::Error + 'static > engineResult_t< T > for Result< T, E > {
	fn engine( self ) -> wresult_t< T > {
		self.map_err( |e| Com_Classify( &e ) )
	}
}

/*
==================
Com_Https

An https client to build on, trusting what the Zcash connections trust
(the webpki roots only), so an antivirus that intercepts is caught, not
trusted, and saying what asks (CoinGecko refuses, 403, a request that
doesn't; reqwest says nothing unless told). Each caller sets its waits.
==================
*/
const HTTPS_USER_AGENT: &str = concat!( "Laurel/", env!( "CARGO_PKG_VERSION" ) );

pub fn Com_Https() -> wresult_t< reqwest::ClientBuilder > {
	zingo_netutils::ensure_default_crypto_provider();
	let provider = rustls::crypto::CryptoProvider::get_default().cloned()
		.ok_or_else( || werr_t::WERR_ENGINE( "no TLS crypto provider is installed".to_string() ) )?;
	let mut roots = rustls::RootCertStore::empty();
	roots.extend( webpki_roots::TLS_SERVER_ROOTS.iter().cloned() );
	let tls = rustls::ClientConfig::builder_with_provider( provider )
		.with_safe_default_protocol_versions()
		.map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?
		.with_root_certificates( roots )
		.with_no_client_auth();
	Ok( reqwest::Client::builder().tls_backend_preconfigured( tls ).user_agent( HTTPS_USER_AGENT ) )
}

/*
==================
Com_CauseChain

Engine errors often say only "transport error"; the part that names
what actually failed is further down the source() chain
==================
*/
pub fn Com_CauseChain( err: &dyn std::error::Error ) -> String {
	let mut s = err.to_string();
	let mut cur = err.source();

	while let Some( e ) = cur {
		let msg = e.to_string();
		if ( !s.contains( &msg ) ) {
			s.push_str( ": " );
			s.push_str( &msg );
		}
		cur = e.source();
	}
	s
}


#[cfg( test )]
mod tests {
	use super::*;

	/*
	==================
	block_eras_follow_the_consensus_rules

	The eras are in height order and start where the engine's consensus
	rules put each upgrade: on testnet, 150 s from genesis, 75 s from
	Blossom (584,000), 25 s from NU7 (4,465,026), so a payment's 120-block
	expiry is 50 minutes. On mainnet, NU7 at 3,543,405: librustzcash's
	releases of 2026-10-21 (zcash_protocol 0.11.0, zingolib 8.0.0)
	==================
	*/
	#[test]
	fn block_eras_follow_the_consensus_rules() {
		let eras = W_BlockEras();
		let of = |net: network_t| eras.iter().filter( |e| e.network == net ).map( |e| ( e.from, e.secs ) ).collect::< Vec< _ > >();
		assert_eq!( of( network_t::NET_TESTNET ), [ ( 0, 150 ), ( 584_000, 75 ), ( 4_465_026, 25 ) ] );
		assert_eq!( of( network_t::NET_MAINNET ), [ ( 0, 150 ), ( 653_600, 75 ), ( 3_543_405, 25 ) ] );

		use zcash_protocol::consensus::{ POST_BLOSSOM_POW_TARGET_SPACING, POST_NU7_POW_TARGET_SPACING, PRE_BLOSSOM_POW_TARGET_SPACING };
		assert_eq!( u64::from( PRE_BLOSSOM_BLOCK_SECS ), PRE_BLOSSOM_POW_TARGET_SPACING.as_secs() );
		assert_eq!( u64::from( POST_BLOSSOM_BLOCK_SECS ), POST_BLOSSOM_POW_TARGET_SPACING.as_secs() );
		assert_eq!( u64::from( POST_NU7_BLOCK_SECS ), POST_NU7_POW_TARGET_SPACING.as_secs() );
	}

	/*
	==================
	a_broadcast_reads_its_answer_as_the_engine_does

	A server that refused the bytes as malformed refused the transaction:
	it went nowhere. Any other answer may hide a delivery ("inputs spent" is
	what an earlier copy of ours already in gets), and so may a dropped
	connection: unsure, never "refused" (security review A-03)
	==================
	*/
	#[test]
	fn a_broadcast_reads_its_answer_as_the_engine_does() {
		let refused = Com_SendError( tonic::Status::new( tonic::Code::Unknown, "16: bad-txns-sapling-bundle-invalid" ) );
		assert!( matches!( &refused, werr_t::WERR_REJECTED( why ) if why.contains( "bundle-invalid" ) ) );
		assert_eq!( refused.UiDetail().as_deref(), Some( "16: bad-txns-sapling-bundle-invalid" ) );

		for maybe in [ tonic::Status::new( tonic::Code::Unknown, "18: bad-txns-inputs-spent" ), tonic::Status::new( tonic::Code::Unavailable, "connection refused" ), tonic::Status::new( tonic::Code::Internal, "16: bad-txns-sapling-bundle-invalid" ) ] {
			assert!( matches!( Com_SendError( maybe.clone() ), werr_t::WERR_SENT_UNSURE( _ ) ), "{maybe:?}" );
		}
	}
	use pepper_sync::error::{ ServerError, SyncError };
	use zingolib::wallet::error::WalletError;

	// what the engine hands back when a sync stops on a server's answer
	fn Stopped( status: tonic::Status ) -> SyncError< WalletError > {
		SyncError::ServerError( ServerError::RequestFailed( status ) )
	}

	// no answer at all (no address for the name, a refused or dropped connection) is
	// the server out of reach, never "inside Laurel": the engine's wrapper hands its
	// cause on transparently, so the transport error itself is never in the chain.
	// A refused port, not a name that can't resolve: some networks' DNS answers every
	// name (the build machine's did), the connection then hangs, and that is rightly "slow"
	#[tokio::test]
	async fn a_server_out_of_reach_is_the_servers_not_the_engines() {
		let e = zingo_netutils::GrpcIndexer::new( "https://127.0.0.1:1".parse().unwrap() ).await.err().expect( "nothing listens on port 1" );
		assert!( matches!( Com_Classify( &e ), werr_t::WERR_SERVER( _ ) ), "{:?}", Com_Classify( &e ) );
		assert!( matches!( Com_Classify( &zingo_netutils::GetClientError::InvalidAuthority ), werr_t::WERR_SERVER_URL ) );
	}

	#[test]
	fn a_block_behind_at_the_tip_is_a_race_not_an_outage() {
		// word for word what testnet.zec.rocks answered on 2026-09-26
		let e = Stopped( tonic::Status::out_of_range( "GetBlock: block 4397548 is newer than the latest block" ) );
		assert!( matches!( Com_Classify( &e ), werr_t::WERR_SERVER_BEHIND ) );
	}

	#[test]
	fn timeouts_are_slow_whoever_timed_out() {
		assert!( matches!( Com_Classify( &Stopped( tonic::Status::deadline_exceeded( "stream message timeout" ) ) ), werr_t::WERR_SERVER_SLOW ) );
		assert!( matches!( Com_Classify( &Stopped( tonic::Status::cancelled( "Timeout expired" ) ) ), werr_t::WERR_SERVER_SLOW ) );
		assert!( matches!( Com_Classify( &tonic::TimeoutExpired( () ) ), werr_t::WERR_SERVER_SLOW ) );
	}

	#[test]
	fn an_antivirus_certificate_is_named_wherever_it_hides() {
		let tls = rustls::Error::InvalidCertificate( rustls::CertificateError::UnknownIssuer );
		let io = std::io::Error::new( std::io::ErrorKind::Other, tls );		// io::Error hides it from source()
		let status = tonic::Status::from_error( Box::new( io ) );
		assert!( matches!( Com_Classify( &Stopped( status ) ), werr_t::WERR_INTERCEPTED ) );
	}

	/*
	==================
	a_refused_broadcast_says_so_through_the_engine_door

	A send the network refused once read "something went wrong inside
	Laurel's wallet engine" (every engine error did). Through .engine()
	it is now a refusal, with the server's reason as the detail, or, when
	no server answered, the connection's problem.
	==================
	*/
	#[test]
	fn a_refused_broadcast_says_so_through_the_engine_door() {
		use zingolib::lightclient::error::{ LightClientError, SendError, TransmissionError, TransmitVerdict };

		let failed = |verdict| -> Result< (), LightClientError > {
			Err( SendError::TransmissionError( TransmissionError::TransmissionFailed { text: "18: bad-txns-inputs-spent".into(), verdict: verdict } ).into() )
		};
		let refused = failed( TransmitVerdict::Refused ).engine().unwrap_err();
		assert!( matches!( refused, werr_t::WERR_REJECTED( _ ) ) );
		assert_eq!( refused.Info().detail.as_deref(), Some( "18: bad-txns-inputs-spent" ) );
		assert!( matches!( failed( TransmitVerdict::Unreachable ).engine(), Err( werr_t::WERR_SERVER( _ ) ) ) );

		// perhaps sent: never "try again", and the wallet keeps it to send again (E_SendProposal)
		let unsure = failed( TransmitVerdict::Unsure ).engine().unwrap_err();
		assert!( matches!( unsure, werr_t::WERR_SENT_UNSURE( _ ) ) );
		assert!( !unsure.Info().retry );
	}

	/*
	==================
	not_enough_money_says_so_whatever_shape_it_comes_in

	The backend says "insufficient funds" as its own error or inside a
	change error, for a payment and for shielding. Every shape once read
	"something went wrong inside Laurel's wallet engine (… Insufficient
	funds …)": seen in the log for a shield of public money below the fee.
	==================
	*/
	#[test]
	fn not_enough_money_says_so_whatever_shape_it_comes_in() {
		use zcash_client_backend::data_api::error::Error as BackendError;
		use zcash_client_backend::fees::ChangeError;
		use zcash_protocol::value::Zatoshis;
		use zingolib::lightclient::error::{ LightClientError, SendError };
		use zingolib::wallet::error::{ ProposeSendError, ProposeShieldError };

		fn short< E, N >() -> ChangeError< E, N > {
			ChangeError::InsufficientFunds { available: Zatoshis::ZERO, required: Zatoshis::const_from_u64( 10_000 ) }
		}

		let shield: Result< (), LightClientError > = Err( SendError::ProposeShieldError( ProposeShieldError::Component( BackendError::Change( short() ) ) ).into() );
		assert!( matches!( shield.engine(), Err( werr_t::WERR_SHIELD_BELOW_FEE ) ) );
		let shield: Result< (), LightClientError > = Err( SendError::ProposeShieldError( ProposeShieldError::InsufficientFunds ).into() );
		assert!( matches!( shield.engine(), Err( werr_t::WERR_SHIELD_BELOW_FEE ) ) );

		let send: Result< (), ProposeSendError > = Err( ProposeSendError::Proposal( BackendError::Change( short() ) ) );
		assert!( matches!( send.engine(), Err( werr_t::WERR_NOT_ENOUGH ) ) );
		let send: Result< (), ProposeSendError > = Err( ProposeSendError::Proposal( BackendError::InsufficientFunds { available: Zatoshis::ZERO, required: Zatoshis::const_from_u64( 1 ) } ) );
		assert!( matches!( send.engine(), Err( werr_t::WERR_NOT_ENOUGH ) ) );
	}

	#[test]
	fn the_engine_text_is_the_detail_never_the_message() {
		let raw = r#"Transmission error.: transaction::Hash("a80c7d499c617a4f")"#;
		let sent = serde_json::to_value( werr_t::WERR_ENGINE( raw.into() ) ).unwrap();
		assert_eq!( sent[ "message" ], "Something went wrong inside Laurel's wallet engine." );
		assert_eq!( sent[ "detail" ], raw );

		let plain = serde_json::to_value( werr_t::WERR_NO_AMOUNT ).unwrap();
		assert_eq!( plain[ "detail" ], serde_json::Value::Null );
	}

	/*
	==================
	rust_speaks_the_uis_words

	The ui hands rust its words (W_SetWords_f); an error says them, with
	its values in, and a file by the name the language gives it. Before
	the words arrive, rust's English, whole: never a blank or a {0}.
	==================
	*/
	#[test]
	fn rust_speaks_the_uis_words() {
		let mut words = uiWords_t::default();
		words.errors.insert( "WERR_TOO_MANY_ACCOUNTS".into(), "Una cartera tiene como máximo {0} cuentas.".into() );
		words.errors.insert( "WERR_SEED_WORD".into(), "La palabra {0} («{1}») no es de una frase de recuperación.".into() );
		words.errors.insert( "WERR_CORRUPT".into(), "Un archivo de Laurel está dañado: {0}.".into() );
		words.files.insert( file_t::FILE_CONTACTS, "la libreta de direcciones".into() );

		assert_eq!( werr_t::WERR_TOO_MANY_ACCOUNTS( 50 ).UiMessageIn( Some( &words ) ), "Una cartera tiene como máximo 50 cuentas." );
		assert_eq!( werr_t::Typed( werr_t::WERR_SEED_WORD( 3, "abandom".into() ) ).UiMessageIn( Some( &words ) ), "La palabra 3 («abandom») no es de una frase de recuperación." );
		assert_eq!( werr_t::WERR_CORRUPT( file_t::FILE_CONTACTS ).UiMessageIn( Some( &words ) ), "Un archivo de Laurel está dañado: la libreta de direcciones." );

		// a kind the words lack, and no words at all: English
		assert_eq!( werr_t::WERR_NO_AMOUNT.UiMessageIn( Some( &words ) ), "Enter an amount above zero." );
		assert_eq!( werr_t::WERR_TOO_MANY_ACCOUNTS( 50 ).UiMessageIn( None ), "A wallet can hold up to 50 accounts." );
		assert!( !werr_t::WERR_SEED_WORD( 3, "abandom".into() ).UiMessageIn( None ).contains( "abandom" ), "rust's own English never names what was typed" );

		// one pass: a value holding "{1}" (a server's own chain name) stays as it came, and a slot with no value shows
		assert_eq!( Com_Fill( "For {0}, not {1}.", &[ "main{1}".into(), "test".into() ] ), "For main{1}, not test." );
		assert_eq!( Com_Fill( "{0} {9} {x} {", &[ "a".into() ] ), "a {9} {x} {" );
	}

	#[test]
	fn the_log_never_keeps_what_was_typed_or_who_is_paid() {
		// the check's own words for a misspelled phrase word, which name the word
		let typed = werr_t::WERR_SEED_WORD( 3, "abandom".into() );
		assert!( !typed.LogText().contains( "abandom" ) );
		// the person sees which word in the ui's sentence ({1}: rust_speaks_the_uis_words); rust's own never names it
		assert!( !typed.Info().message.contains( "abandom" ) );

		let contact = werr_t::WERR_CONTACT_EXISTS( "Alice".into() );
		assert!( !contact.LogText().contains( "Alice" ) );

		// however it's printed: Display and Debug are log text too
		for e in [ &typed, &contact ] {
			let shown = format!( "{e} {e:?}" );
			assert!( !shown.contains( "abandom" ) && !shown.contains( "Alice" ), "{shown}" );
		}

		// the engine's words about a typed key reach the screen, not the log
		let key = werr_t::Typed( werr_t::WERR_ENGINE( "invalid ufvk uviewtest1secret".into() ) );
		assert!( !key.LogText().contains( "uviewtest1secret" ) && !format!( "{key:?}" ).contains( "uviewtest1secret" ) );
		assert_eq!( key.Info().detail.as_deref(), Some( "invalid ufvk uviewtest1secret" ) );

		// everything else is logged whole, detail included, to be looked into
		assert!( werr_t::WERR_ENGINE( "raw".into() ).LogText().contains( "raw" ) );
	}

	#[test]
	fn only_passing_states_are_retried_on_their_own() {
		for passing in [ werr_t::WERR_SYNC_BUSY, werr_t::WERR_CATCHING_UP, werr_t::WERR_SERVER_SLOW, werr_t::WERR_SERVER_BEHIND ] {
			assert!( passing.Info().retry, "{passing:?}" );
		}
		// what was asked is wrong, or needs a person: asking again changes nothing
		for lasting in [ werr_t::WERR_NOTHING_TO_SHIELD, werr_t::WERR_NO_AMOUNT, werr_t::WERR_INTERCEPTED, werr_t::WERR_ENGINE( "x".into() ) ] {
			assert!( !lasting.Info().retry, "{lasting:?}" );
		}
	}

	#[test]
	fn the_server_or_the_data() {
		assert!( matches!( Com_Classify( &Stopped( tonic::Status::unavailable( "down" ) ) ), werr_t::WERR_SERVER( _ ) ) );
		assert!( matches!( Com_Classify( &SyncError::< WalletError >::ServerError( ServerError::InvalidSubtreeRoot ) ), werr_t::WERR_SERVER( _ ) ) );
		// the engine says it cleared the data and a rescan is needed: that's the data's repair
		assert!( matches!( Com_Classify( &SyncError::< WalletError >::ServerError( ServerError::ChainVerificationError ) ), werr_t::WERR_SYNC_DATA( _ ) ) );
		// zingolib 8's own: a send with no server is no server; a sync task that panicked is the
		// engine's fault, never the data's (no rescan)
		use zingolib::lightclient::error::LightClientError;
		assert!( matches!( Com_Classify( &LightClientError::Offline ), werr_t::WERR_SERVER( _ ) ) );
		assert!( matches!( Com_Classify( &LightClientError::SyncPanicked( "boom".into() ) ), werr_t::WERR_ENGINE( _ ) ) );
	}

	/*
	==================
	a_server_without_ironwood_is_the_servers_fault

	Upstream zingolib (271af68e) refuses a server that can't serve what sync
	needs: no Ironwood tree state, an old protocol, a pool's tree size not
	reported. Each is the server's, so another server fixes it; the last
	arrives inside a scan error, which once read as damaged sync data and
	would have rescanned the wallet from its birthday for a server's fault.
	==================
	*/
	#[test]
	fn a_server_without_ironwood_is_the_servers_fault() {
		use pepper_sync::error::ScanError;
		use zcash_protocol::consensus::BlockHeight;
		use zcash_protocol::{ PoolType, ShieldedPool };

		let ironwood = PoolType::Shielded( ShieldedPool::Ironwood );
		let not_served = SyncError::< WalletError >::ServerError( ServerError::TreeStateNotServed { pool: ironwood, height: BlockHeight::from_u32( 4_400_000 ) } );
		let too_old = SyncError::< WalletError >::ServerError( ServerError::UnsupportedProtocolVersion { version: "0.4.0".into() } );
		let no_size = SyncError::< WalletError >::ScanError( ScanError::TreeSizeNotReported { shielded_protocol: ironwood, height: BlockHeight::from_u32( 4_400_000 ), calculated_size: 12 } );
		for e in [ &not_served, &too_old, &no_size ] {
			assert!( matches!( Com_Classify( e ), werr_t::WERR_SERVER_OUTDATED( _ ) ), "{:?}", Com_Classify( e ) );
		}
	}

	/*
	==================
	probe_tree_state_speed

	How long the testnet server takes to answer the tree-state request
	the engine's shard-tree update makes, with a generous limit. Needs the
	network, so ignored by default:
	cargo test --lib probe_tree_state_speed -- --ignored --nocapture
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	#[ignore]
	async fn probe_tree_state_speed() {
		let mut indexer = W_Indexer( network_t::NET_TESTNET ).await.expect( "connect" );
		let tip = indexer.get_latest_block( Duration::from_secs( 20 ) ).await.expect( "tip" ).height;
		println!( "tip {tip}" );
		for height in [ 4396316u64, 4396320, tip - 5 ] {
			let t = std::time::Instant::now();
			let r = indexer.get_tree_state( BlockId { height, hash: vec![] }, Duration::from_secs( 90 ) ).await;
			println!( "tree state at {height}: {:?} after {:.1} s", r.as_ref().map( |_| "ok" ).map_err( |e| e.message().to_string() ), t.elapsed().as_secs_f32() );
		}
	}
}
