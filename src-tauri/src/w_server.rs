/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_server.rs -- which Zcash server the wallets talk to
//
// AUTOMATIC, the default: the server that last worked. When it fails,
// Laurel's own list (TESTNET_SERVERS, MAINNET_SERVERS: zingolib 8 dropped
// the census it was copied from, docs/ENGINE.md) is asked a few servers at
// a time, and the fastest one that is up to date wins; the one that failed
// sits out BENCH_SECS. Never after an
// intercepted connection: antivirus breaks every server alike, and asking
// more of them only tells more of them this computer runs a Zcash wallet.
//
// YOUR OWN: a server the person gave, checked before it's taken (it answers
// and serves this network). Never switched away from: if it's down, the
// wallets say so, and the person decides.
//
// Kept in wallets/<network>/server.json. Only a person's own server is
// written; automatic is the absence of one.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{ LazyLock, Mutex };
use std::time::{ Duration, Instant };

use serde::{ Deserialize, Serialize };
use specta::Type;
use zingo_netutils::{ GrpcIndexer, Indexer };

use crate::w_disk::{ Com_ReadJson, Com_WriteJson };
use crate::w_local::*;
use crate::w_net::{ Com_Classify, W_StatusError };

const PICK_BATCH: usize			= 4;		// servers asked at once: few, so few learn of this computer
const PICK_WAIT_SECS: u64		= 8;		// an answer slower than this isn't worth having
const PICK_BEHIND_BLOCKS: u64	= 3;		// further behind the best tip than this is stale
const BENCH_SECS: u64			= 600;		// a server that failed sits out this long

// The servers AUTOMATIC picks from, in order: Laurel's own since zingolib
// 8.0.0 deleted the indexer census (zingo-adrs zingolib/0063) these came
// from, so rechecked at every release (docs/ENGINE.md). Each is https with
// its port.
const TESTNET_SERVERS: &[ &str ] = &[
	"https://testnet.zec.rocks:443",
	"https://zaino.testnet.unsafe.zec.rocks:443",		// the fail-over: experimental Zaino
];
// Unused until mainnet: a testnet-only build offers none of them
// (Com_Servers; a_testnet_only_build_offers_no_mainnet_server).
const MAINNET_SERVERS: &[ &str ] = &[
	"https://zec.rocks:443",
	"https://na.zec.rocks:443",
	"https://sa.zec.rocks:443",
	"https://eu.zec.rocks:443",
	"https://ap.zec.rocks:443",
	"https://zec-node.cakewallet.com:443",
	"https://lwd.zcashexplorer.app:9067",
	"https://us.zec.stardust.rest:443",
	"https://eu.zec.stardust.rest:443",
	"https://l.ombie.cash:443",
	"https://z.ombie.cash:443",
	"https://zec.0xrpc.io:443",
	"https://zec.alexxiy.top:9067",
	"https://zec.alexxiy.top:8137",
	"https://lwd.z0n.jp:443",
	"https://lwd.blakyniica.xyz:443",
	"https://carover0.xyz:9067",
	"https://myzec.cryptover.site:443",
	"https://zcashlw.devshore.ovh:443",
	"https://znode.roamerx.win:443",
	"https://lightwalletd.mainnet.cipherscan.app:443",
	"https://webhighway.website:443",
];

// the ui's view of the choice
#[derive( Clone, Debug, Serialize, Type )]
pub struct serverStatus_t {
	pub own:		Option< String >,		// the person's own server; none: automatic
	pub current:	Option< String >,		// the server in use, once one has answered
	pub latencyMs:	Option< u32 >,			// how long it took to answer, when it was chosen
}

// what asking a server found
#[derive( Clone, Debug, Serialize, Type )]
pub struct serverCheck_t {
	pub uri:		String,					// as Laurel will use it: scheme and port filled in
	pub height:		u32,
	pub latencyMs:	u32,
}

#[derive( Default, Serialize, Deserialize )]
struct serverFile_t {
	own:	Option< String >,
}

#[derive( Default )]
struct netServer_t {
	loaded:		bool,
	own:		Option< String >,
	current:	Option< String >,
	latencyMs:	Option< u32 >,
	benched:	BTreeMap< String, Instant >,
}

// one per network, by Com_NetIndex
static w_servers: LazyLock< Mutex< [ netServer_t; 2 ] > > = LazyLock::new( Default::default );

fn Com_NetIndex( net: network_t ) -> usize {
	match net {
		network_t::NET_MAINNET => 0,
		network_t::NET_TESTNET => 1,
	}
}

fn Com_Servers( net: network_t ) -> &'static [ &'static str ] {
	match net {
		network_t::NET_MAINNET if cfg!( feature = "testnet-only" ) => &[],
		network_t::NET_MAINNET => MAINNET_SERVERS,
		network_t::NET_TESTNET => TESTNET_SERVERS,
	}
}

fn Com_NetName( net: network_t ) -> &'static str {
	match net {
		network_t::NET_MAINNET => "mainnet",
		network_t::NET_TESTNET => "testnet",
	}
}


/*
=========================================================================

WHICH SERVER

=========================================================================
*/

/*
==================
Com_ServerUri

What a person typed, as the uri Laurel dials: https unless said, port 443
for https and 9067 (lightwalletd's own) for http. Plain http only to this
computer: anywhere else, anyone on the way could read and change it.
==================
*/
pub fn Com_ServerUri( text: &str ) -> wresult_t< String > {
	let text = text.trim();		// a trailing / is the empty path, allowed below; trimmed here, "https://" would become a host
	if ( text.is_empty() || text.contains( char::is_whitespace ) ) {
		return Err( werr_t::WERR_SERVER_URL );
	}
	let text = if ( text.contains( "://" ) ) { text.to_string() } else { format!( "https://{text}" ) };
	let uri: http::Uri = text.parse().map_err( |_| werr_t::WERR_SERVER_URL )?;

	// only what the result can say exactly: a login, a path or a query would be dropped
	let host = uri.host().filter( |h| Com_IsHost( h ) ).ok_or( werr_t::WERR_SERVER_URL )?;
	if ( uri.authority().is_some_and( |a| a.as_str().contains( '@' ) ) || ( uri.path() != "/" && !uri.path().is_empty() ) || uri.query().is_some() ) {
		return Err( werr_t::WERR_SERVER_URL );
	}
	let port = match ( uri.scheme_str(), uri.port_u16() ) {
		( Some( "https" ), p ) => p.unwrap_or( 443 ),
		( Some( "http" ), p ) => {
			if ( !matches!( host, "localhost" | "127.0.0.1" | "[::1]" ) ) {
				return Err( werr_t::WERR_SERVER_PLAIN );
			}
			p.unwrap_or( 9067 )
		}
		_ => return Err( werr_t::WERR_SERVER_URL ),
	};
	Ok( format!( "{}://{host}:{port}", uri.scheme_str().unwrap_or( "https" ) ) )
}

// a dns name or ipv4 (letters, digits, - and inner dots), or a bracketed ipv6
fn Com_IsHost( h: &str ) -> bool {
	if let Some( inner ) = h.strip_prefix( '[' ).and_then( |r| r.strip_suffix( ']' ) ) {
		return inner.parse::< std::net::Ipv6Addr >().is_ok();
	}
	!h.is_empty()
		&& h.split( '.' ).all( |label| !label.is_empty() && !label.starts_with( '-' ) && !label.ends_with( '-' ) && label.chars().all( |c| c.is_ascii_alphanumeric() || c == '-' ) )
}

/*
==================
Com_ServerOf

The server a connection uses, in the same form as Com_ServerUri, so two
names for one server compare equal. Never compare uris as text.
==================
*/
pub fn Com_ServerOf( uri: &http::Uri ) -> Option< String > {
	Com_ServerUri( &uri.to_string() ).ok()
}

/*
==================
Com_ServesNetwork

lightwalletd names its chain "main" or "test"; zaino says "mainnet"
==================
*/
fn Com_ServesNetwork( chainName: &str, net: network_t ) -> bool {
	let served = chainName.to_ascii_lowercase();
	match net {
		network_t::NET_MAINNET => served.starts_with( "main" ),
		network_t::NET_TESTNET => served.starts_with( "test" ),
	}
}

/*
==================
Com_KnowsBranch

Whether this build knows the consensus branch a server says the chain is
on (lightwalletd's `consensus_branch_id`, hex). None: it said nothing
readable, so nothing follows from it
==================
*/
fn Com_KnowsBranch( branchHex: &str ) -> Option< bool > {
	let id = u32::from_str_radix( branchHex.trim().trim_start_matches( "0x" ), 16 ).ok()?;
	Some( zcash_protocol::consensus::BranchId::try_from( id ).is_ok() )
}

/*
==================
W_NetworkNewer

Whether the chain has moved to a network upgrade this build doesn't know,
by the server's own word. Asked only after a sync failed on a server's
data: a block from an unknown upgrade reads as an invalid transaction,
which is Laurel's age, not the server's fault
==================
*/
pub async fn W_NetworkNewer( uri: &str ) -> bool {
	let ask = async {
		let mut indexer = W_Connect( uri ).await.ok()?;
		indexer.get_lightd_info( Duration::from_secs( PICK_WAIT_SECS ) ).await.ok()
	};
	let Ok( Some( info ) ) = tokio::time::timeout( Duration::from_secs( PICK_WAIT_SECS ), ask ).await else {
		return false;
	};
	Com_KnowsBranch( &info.consensus_branch_id ) == Some( false )
}

/*
==================
Com_Best

Of the servers that answered, the fastest one that's up to date: a
server stuck behind the others would show a wallet an old balance
==================
*/
fn Com_Best( answers: &[ serverCheck_t ] ) -> Option< &serverCheck_t > {
	let top = answers.iter().map( |a| a.height ).max()?;
	answers.iter()
		.filter( |a| a.height as u64 + PICK_BEHIND_BLOCKS >= top as u64 )
		.min_by_key( |a| a.latencyMs )
}

/*
==================
Com_Candidates

Laurel's servers for a network, in order, less any sitting out. If every one is sitting out, all are tried again:
better a server that failed ten minutes ago than none.
==================
*/
fn Com_Candidates( net: network_t, benched: &BTreeMap< String, Instant > ) -> Vec< String > {
	let all: Vec< String > = Com_Servers( net ).iter()
		.filter_map( |u| Com_ServerUri( u ).ok() )
		.collect();
	let rested = |u: &String| benched.get( u ).map_or( true, |t| t.elapsed() >= Duration::from_secs( BENCH_SECS ) );
	let ready: Vec< String > = all.iter().filter( |u| rested( u ) ).cloned().collect();
	if ( ready.is_empty() ) { all } else { ready }
}

/*
==================
W_Connect

A connection to one server (a uri from Com_ServerUri)
==================
*/
pub async fn W_Connect( uri: &str ) -> wresult_t< GrpcIndexer > {
	let parsed: http::Uri = uri.parse().map_err( |_| werr_t::WERR_SERVER_URL )?;
	GrpcIndexer::new( parsed ).await
		.map_err( |e| Com_Classify( &e ) )
}

/*
==================
W_CheckServer

Asks one server what chain it serves and how far it is, and times it
==================
*/
pub async fn W_CheckServer( net: network_t, uri: String ) -> wresult_t< serverCheck_t > {
	let started = Instant::now();
	let ask = async {
		let mut indexer = W_Connect( &uri ).await?;
		indexer.get_lightd_info( Duration::from_secs( PICK_WAIT_SECS ) ).await.map_err( W_StatusError )
	};
	let info = tokio::time::timeout( Duration::from_secs( PICK_WAIT_SECS ), ask ).await
		.map_err( |_| werr_t::WERR_SERVER_SLOW )??;

	if ( !Com_ServesNetwork( &info.chain_name, net ) ) {
		return Err( werr_t::WERR_SERVER_NETWORK( info.chain_name, Com_NetName( net ) ) );
	}
	Ok( serverCheck_t {
		uri:		uri,
		height:		info.block_height as u32,
		latencyMs:	started.elapsed().as_millis() as u32,
	} )
}

/*
==================
W_PickServer

Asks Laurel's list a batch at a time until a batch answers, and takes the
best of it
==================
*/
async fn W_PickServer( net: network_t ) -> wresult_t< String > {
	let candidates = {
		let s = w_servers.lock().unwrap();
		Com_Candidates( net, &s[ Com_NetIndex( net ) ].benched )
	};

	let mut last = werr_t::WERR_SERVER( format!( "no {} server is known", Com_NetName( net ) ) );
	for batch in candidates.chunks( PICK_BATCH ) {
		let mut asks = tokio::task::JoinSet::new();
		for uri in batch {
			asks.spawn( W_CheckServer( net, uri.clone() ) );
		}
		let mut answers = vec![];
		while let Some( done ) = asks.join_next().await {
			match done {
				Ok( Ok( a ) ) => answers.push( a ),
				Ok( Err( e ) ) => last = e,
				Err( e ) => log::warn!( "W_PickServer: a check panicked: {}", e.to_string() ),
			}
		}

		if let Some( best ) = Com_Best( &answers ) {
			log::info!( "W_PickServer: {} ({} ms, of {} that answered)", best.uri, best.latencyMs, answers.len() );
			let mut s = w_servers.lock().unwrap();
			let n = &mut s[ Com_NetIndex( net ) ];
			n.current	= Some( best.uri.clone() );
			n.latencyMs	= Some( best.latencyMs );
			return Ok( best.uri.clone() );
		}
		if ( matches!( last, werr_t::WERR_INTERCEPTED ) ) {
			break;		// every server will fail the same way; don't tell more of them
		}
	}
	Err( last )
}

fn Sv_Load( net: network_t, n: &mut netServer_t ) {
	if ( n.loaded ) {
		return;
	}
	n.loaded = true;
	let Some( path ) = Sv_Path( net ) else {
		return;		// no data folder (tests): automatic
	};
	match Com_ReadJson::< serverFile_t >( &path, file_t::FILE_SERVER ) {
		Ok( f ) => n.own = f.and_then( |f| f.own ).and_then( |u| Com_ServerUri( &u ).ok() ),
		Err( e ) => log::warn!( "Sv_Load: {}, using automatic", e.LogText() ),
	}
}

fn Sv_Path( net: network_t ) -> Option< PathBuf > {
	Some( Com_NetworkPath( net )?.join( SERVER_FILE_NAME ) )
}

/*
==================
W_Server

The server a wallet on net should use now
==================
*/
pub async fn W_Server( net: network_t ) -> wresult_t< String > {
	{
		let mut s = w_servers.lock().unwrap();
		let n = &mut s[ Com_NetIndex( net ) ];
		Sv_Load( net, n );
		if let Some( own ) = &n.own {
			return Ok( own.clone() );
		}
		if let Some( current ) = &n.current {
			return Ok( current.clone() );
		}
	}
	W_PickServer( net ).await
}

/*
==================
W_ServerFailed

A server didn't answer: in automatic mode it sits out a while and the
next connection picks again. uri None means the current one.
==================
*/
pub fn W_ServerFailed( net: network_t, uri: Option< &str >, e: &werr_t ) {
	if ( !matches!( e, werr_t::WERR_SERVER( _ ) | werr_t::WERR_SERVER_SLOW | werr_t::WERR_SERVER_BEHIND ) ) {
		return;		// intercepted, or not the server's doing
	}
	let mut s = w_servers.lock().unwrap();
	let n = &mut s[ Com_NetIndex( net ) ];
	if ( n.own.is_some() ) {
		return;
	}
	let Some( uri ) = uri.map( str::to_string ).or_else( || n.current.clone() ) else {
		return;
	};
	log::warn!( "W_ServerFailed: {uri} sits out {BENCH_SECS} s: {}", e.LogText() );
	n.benched.insert( uri.clone(), Instant::now() );
	if ( n.current.as_deref() == Some( uri.as_str() ) ) {
		n.current	= None;
		n.latencyMs	= None;
	}
}

/*
==================
W_ServerStatus
==================
*/
pub fn W_ServerStatus( net: network_t ) -> serverStatus_t {
	let mut s = w_servers.lock().unwrap();
	let n = &mut s[ Com_NetIndex( net ) ];
	Sv_Load( net, n );
	serverStatus_t {
		own:		n.own.clone(),
		current:	n.own.clone().or_else( || n.current.clone() ),
		latencyMs:	n.latencyMs,
	}
}

/*
==================
W_SetServer

The person's own server (checked first, and saved), or back to automatic
with None. The caller reconnects the wallets.
==================
*/
pub async fn W_SetServer( net: network_t, own: Option< String > ) -> wresult_t< () > {
	let check = match own {
		Some( text ) => Some( W_CheckServer( net, Com_ServerUri( &text )? ).await? ),
		None => None,
	};
	let own = check.as_ref().map( |c| c.uri.clone() );

	Com_WriteJson( &Sv_Path( net ).ok_or_else( Com_NoDataFolder )?, &serverFile_t { own: own.clone() } )?;

	let mut s = w_servers.lock().unwrap();
	let n = &mut s[ Com_NetIndex( net ) ];
	n.loaded	= true;
	n.own		= own;
	n.current	= check.as_ref().map( |c| c.uri.clone() );
	n.latencyMs	= check.as_ref().map( |c| c.latencyMs );
	n.benched.clear();
	Ok( () )
}


#[cfg( test )]
mod branch_tests {
	use super::*;

	#[test]
	fn a_branch_this_build_knows_and_one_it_doesnt() {
		assert_eq!( Com_KnowsBranch( "37a5165b" ), Some( true ), "NU6.3" );
		assert_eq!( Com_KnowsBranch( "77190ad9" ), Some( true ), "NU7, since ba733671" );
		assert_eq!( Com_KnowsBranch( "0xdeadbeef" ), Some( false ) );
		assert_eq!( Com_KnowsBranch( "" ), None );
		assert_eq!( Com_KnowsBranch( "not hex" ), None );
	}
}

#[cfg( test )]
mod tests {
	use super::*;

	#[test]
	fn a_typed_server_becomes_a_uri_laurel_can_dial() {
		assert_eq!( Com_ServerUri( "zec.rocks" ).unwrap(), "https://zec.rocks:443" );
		assert_eq!( Com_ServerUri( " https://eu.zec.rocks/ " ).unwrap(), "https://eu.zec.rocks:443" );
		assert_eq!( Com_ServerUri( "https://lwd.example:9067" ).unwrap(), "https://lwd.example:9067" );
		assert_eq!( Com_ServerUri( "http://127.0.0.1" ).unwrap(), "http://127.0.0.1:9067" );
		assert_eq!( Com_ServerUri( "http://localhost:8137" ).unwrap(), "http://localhost:8137" );
	}

	#[test]
	fn plain_http_only_to_this_computer_and_nonsense_is_refused() {
		assert!( matches!( Com_ServerUri( "http://zec.rocks" ), Err( werr_t::WERR_SERVER_PLAIN ) ) );
		for bad in [ "", "   ", "not a server", "ftp://zec.rocks", "https://zec.rocks/some/path", "https://" ] {
			assert!( matches!( Com_ServerUri( bad ), Err( werr_t::WERR_SERVER_URL ) ), "{bad:?}" );
		}
	}

	#[test]
	fn every_listed_server_is_dialable() {
		for list in [ TESTNET_SERVERS, MAINNET_SERVERS ] {
			for u in list {
				assert!( matches!( Com_ServerUri( u ), Ok( ref v ) if v == u ), "{u} is https with its port" );
			}
		}
		assert_eq!( Com_Candidates( network_t::NET_TESTNET, &BTreeMap::new() ), TESTNET_SERVERS, "testnet.zec.rocks first, the Zaino fail-over second" );
	}

	#[test]
	fn testnet_is_exactly_the_two_servers() {
		assert_eq!( TESTNET_SERVERS, [ "https://testnet.zec.rocks:443", "https://zaino.testnet.unsafe.zec.rocks:443" ] );
	}

	#[test]
	fn no_experimental_server_for_mainnet() {
		assert!( MAINNET_SERVERS.iter().all( |u| !u.contains( ".unsafe." ) ) );
	}

	#[test]
	fn a_testnet_only_build_offers_no_mainnet_server() {
		assert_eq!( Com_Candidates( network_t::NET_MAINNET, &BTreeMap::new() ).is_empty(), cfg!( feature = "testnet-only" ) );
	}

	#[test]
	fn a_server_sits_out_unless_every_one_is() {
		let all = Com_Candidates( network_t::NET_TESTNET, &BTreeMap::new() );
		let mut benched = BTreeMap::new();
		benched.insert( all[0].clone(), Instant::now() );
		assert!( !Com_Candidates( network_t::NET_TESTNET, &benched ).contains( &all[0] ) );

		let every: BTreeMap< String, Instant > = all.iter().map( |u| ( u.clone(), Instant::now() ) ).collect();
		assert_eq!( Com_Candidates( network_t::NET_TESTNET, &every ), all );
	}

	#[test]
	fn the_fastest_up_to_date_server_wins() {
		let a = |uri: &str, height: u32, latencyMs: u32| serverCheck_t { uri: uri.into(), height, latencyMs };
		let answers = [ a( "stale-but-fast", 900, 10 ), a( "slow", 1000, 300 ), a( "quick", 998, 40 ) ];
		assert_eq!( Com_Best( &answers ).unwrap().uri, "quick" );
		assert!( Com_Best( &[] ).is_none() );
	}

	// typed server addresses: fragments people type, in any order, and noise
	fn Typed() -> impl proptest::strategy::Strategy< Value = String > {
		proptest::string::string_regex( "[ ]?((https?|ftp)(://|:/|:))?([a-z0-9]{0,6}[.:/@\\[\\]]{0,2}){0,4}[ /]?" ).unwrap()
	}

	proptest::proptest! {
		// the bug this was written for: "https://" became a server named "https"
		#[test]
		fn a_named_scheme_is_accepted_only_as_the_uri_parser_reads_it( text in Typed() ) {
			if let ( Ok( ours ), true ) = ( Com_ServerUri( &text ), text.contains( "://" ) ) {
				let theirs: http::Uri = text.trim().parse().expect( "accepted text the parser rejects" );
				let ours: http::Uri = ours.parse().unwrap();
				proptest::prop_assert_eq!( ours.host(), theirs.host() );
			}
		}

		#[test]
		fn normalizing_twice_changes_nothing_and_connections_compare_the_same( text in Typed() ) {
			if let Ok( u ) = Com_ServerUri( &text ) {
				proptest::prop_assert_eq!( Com_ServerUri( &u ).ok(), Some( u.clone() ) );
				proptest::prop_assert_eq!( Com_ServerOf( &u.parse().unwrap() ), Some( u ) );
			}
		}
	}

	/*
	==================
	probe_pick

	Picks a real server for each network and checks the other network's is
	refused. Needs the network, so ignored by default:
	cargo test --lib probe_pick -- --ignored --nocapture
	==================
	*/
	#[tokio::test( flavor = "multi_thread" )]
	#[ignore]
	async fn probe_pick() {
		for net in [ network_t::NET_TESTNET, network_t::NET_MAINNET ] {
			let t = Instant::now();
			let picked = W_PickServer( net ).await;
			println!( "{net:?}: {picked:?} after {:.1} s", t.elapsed().as_secs_f32() );
			assert!( picked.is_ok() );
		}
		let wrong = W_CheckServer( network_t::NET_MAINNET, "https://testnet.zec.rocks:443".into() ).await;
		println!( "testnet server for mainnet: {wrong:?}" );
		assert!( matches!( wrong, Err( werr_t::WERR_SERVER_NETWORK( .. ) ) ) );
	}

	#[test]
	fn a_server_for_the_other_network_is_recognised() {
		assert!( Com_ServesNetwork( "main", network_t::NET_MAINNET ) );
		assert!( Com_ServesNetwork( "Mainnet", network_t::NET_MAINNET ) );
		assert!( Com_ServesNetwork( "test", network_t::NET_TESTNET ) );
		assert!( !Com_ServesNetwork( "test", network_t::NET_MAINNET ) );
		assert!( !Com_ServesNetwork( "", network_t::NET_TESTNET ) );
	}
}
