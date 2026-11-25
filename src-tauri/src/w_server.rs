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
use zcash_protocol::consensus::{ BlockHeight, NetworkUpgrade, Parameters };
use zingo_netutils::lightwallet_protocol::{ BlockId, TreeState };
use zingo_netutils::{ GrpcIndexer, Indexer };

use crate::w_disk::{ Com_ReadJson, Com_WriteJson };
use crate::w_local::*;
use crate::w_net::{ Com_Classify, W_ChainType, W_StatusError };

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
// (Com_Servers; a_testnet_only_build_offers_no_mainnet_server). Only operators
// Laurel can name (T-052, docs/ENGINE.md says who and why): the census's other
// servers were run by people known only by a forum name, or by no one said
const MAINNET_SERVERS: &[ &str ] = &[
	"https://zec.rocks:443",					// ZecRocks (emersonian)
	"https://na.zec.rocks:443",
	"https://sa.zec.rocks:443",
	"https://eu.zec.rocks:443",
	"https://ap.zec.rocks:443",
	"https://zec-node.cakewallet.com:443",		// Cake Labs (Cake Wallet)
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
	ownChecked:	bool,		// own, as W_CheckServer last found it: set with it, or read back and checked since
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
		_ if !NETWORKS.contains( &net ) => &[],		// testnet-only: no mainnet server; v1: no testnet one (D-033)
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

lightwalletd names its chain "main" or "test"; zaino says "mainnet". Whole
names only (W2-04): one that merely starts like them is another chain
==================
*/
fn Com_ServesNetwork( chainName: &str, net: network_t ) -> bool {
	let served = chainName.to_ascii_lowercase();
	match net {
		network_t::NET_MAINNET => served == "main" || served == "mainnet",
		network_t::NET_TESTNET => served == "test" || served == "testnet",
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
Com_CheckInfo

What a server says of its chain, as a pick or the person's own server must
have it: net's chain, on a consensus branch this build knows (W2-04: past
an upgrade it doesn't, nothing synced from that server could be read)
==================
*/
fn Com_CheckInfo( net: network_t, chainName: &str, branchHex: &str ) -> wresult_t< () > {
	if ( !Com_ServesNetwork( chainName, net ) ) {
		return Err( werr_t::WERR_SERVER_NETWORK( chainName.to_string(), Com_NetName( net ) ) );
	}
	if ( Com_KnowsBranch( branchHex ) == Some( false ) ) {
		return Err( werr_t::WERR_NETWORK_NEWER );
	}
	Ok( () )
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
Com_TreesServed

A server's tree state for a block: every pool active there has a tree, or
sync can't start from it (the engine's TreeStateNotServed). The pool it
leaves out, if any.
==================
*/
fn Com_TreesServed( net: network_t, height: u32, t: &TreeState ) -> Option< &'static str > {
	let chain = W_ChainType( net );
	let at = BlockHeight::from_u32( height );
	// below its activation a server omits a pool's tree; from it on, an empty tree is
	// still a serialized one, so an omitted tree means the pool isn't served
	[ ( "Sapling", &t.sapling_tree, NetworkUpgrade::Sapling ), ( "Orchard", &t.orchard_tree, NetworkUpgrade::Nu5 ), ( "Ironwood", &t.ironwood_tree, NetworkUpgrade::Nu6_3 ) ]
		.into_iter()
		.find( |( _, tree, upgrade )| tree.is_empty() && chain.is_nu_active( *upgrade, at ) )
		.map( |( pool, _, _ )| pool )
}

/*
==================
Com_Benches

The failures a server sits out for: it didn't answer, or answered too late,
too far behind, or without what sync needs
==================
*/
fn Com_Benches( e: &werr_t ) -> bool {
	matches!( e, werr_t::WERR_SERVER( _ ) | werr_t::WERR_SERVER_OUTDATED( _ ) | werr_t::WERR_SERVER_SLOW | werr_t::WERR_SERVER_BEHIND )
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

Asks one server what chain it serves and how far it is, and times it; then
whether it serves the tip's trees, as sync asks for them (W2-01: one that
answers the first but not the second would hold sync up for good)
==================
*/
pub async fn W_CheckServer( net: network_t, uri: String ) -> wresult_t< serverCheck_t > {
	let started = Instant::now();
	let wait = Duration::from_secs( PICK_WAIT_SECS );
	let ask = async {
		let mut indexer = W_Connect( &uri ).await?;
		let info = indexer.get_lightd_info( wait ).await.map_err( W_StatusError )?;
		Ok::< _, werr_t >( ( indexer, info ) )
	};
	let ( mut indexer, info ) = tokio::time::timeout( wait, ask ).await
		.map_err( |_| werr_t::WERR_SERVER_SLOW )??;

	Com_CheckInfo( net, &info.chain_name, &info.consensus_branch_id )?;
	let latencyMs = started.elapsed().as_millis() as u32;

	let tip = BlockId { height: info.block_height, hash: vec![] };
	let trees = tokio::time::timeout( wait, indexer.get_tree_state( tip, wait ) ).await
		.map_err( |_| werr_t::WERR_SERVER_SLOW )?.map_err( W_StatusError )?;
	if let Some( pool ) = Com_TreesServed( net, info.block_height as u32, &trees ) {
		return Err( werr_t::WERR_SERVER_OUTDATED( format!( "{uri} serves no {pool} tree at {}", info.block_height ) ) );
	}
	Ok( serverCheck_t {
		uri:		uri,
		height:		info.block_height as u32,
		latencyMs:	latencyMs,		// its answer's, as before: the trees are a check, not the race
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
		match ( &n.own, n.ownChecked ) {
			( Some( own ), true ) => return Ok( own.clone() ),
			( Some( _ ), false ) => {},
			( None, _ ) => if let Some( current ) = &n.current {
				return Ok( current.clone() );
			},
		}
	}
	let own = w_servers.lock().unwrap()[ Com_NetIndex( net ) ].own.clone();
	let Some( own ) = own else {
		return W_PickServer( net ).await;
	};

	// W2-04: the person's own server, read back from its file, checked as it was when they
	// set it, once a run; failing, it is refused, never swapped for one they didn't choose
	let check = W_CheckServer( net, own.clone() ).await
		.inspect_err( |e| log::warn!( "W_Server: the own server failed its check: {}", e.LogText() ) )?;
	let mut s = w_servers.lock().unwrap();
	let n = &mut s[ Com_NetIndex( net ) ];
	if ( n.own.as_deref() == Some( own.as_str() ) ) {
		n.ownChecked	= true;
		n.latencyMs		= Some( check.latencyMs );
	}
	Ok( own )
}

/*
==================
W_ServerFailed

A server didn't answer: in automatic mode it sits out a while and the
next connection picks again. uri None means the current one.
==================
*/
pub fn W_ServerFailed( net: network_t, uri: Option< &str >, e: &werr_t ) {
	if ( !Com_Benches( e ) ) {
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
	n.ownChecked	= own.is_some();
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
		if ( NETWORKS.contains( &network_t::NET_TESTNET ) ) {		// v1 offers no testnet server (D-033)
			assert_eq!( Com_Candidates( network_t::NET_TESTNET, &BTreeMap::new() ), TESTNET_SERVERS, "testnet.zec.rocks first, the Zaino fail-over second" );
		}
	}

	#[test]
	fn testnet_is_exactly_the_two_servers() {
		assert_eq!( TESTNET_SERVERS, [ "https://testnet.zec.rocks:443", "https://zaino.testnet.unsafe.zec.rocks:443" ] );
	}

	// T-052: mainnet only through operators Laurel can name, each said in docs/ENGINE.md:
	// a server is trusted with this computer's address and every wallet's sync, and an
	// anonymous one can't be asked about it, or held to it
	const KNOWN_OPERATORS: &[ ( &str, &str ) ] = &[
		( "zec.rocks",		"ZecRocks, run by emersonian (who also runs Hosh, the servers' uptime census)" ),
		( "cakewallet.com",	"Cake Labs, Cake Wallet's maker" ),
	];

	#[test]
	fn every_mainnet_server_has_an_operator_we_can_name() {
		for u in MAINNET_SERVERS {
			let host = u.trim_start_matches( "https://" ).split( ':' ).next().unwrap();
			assert!( KNOWN_OPERATORS.iter().any( |( d, _ )| host == *d || host.ends_with( &format!( ".{d}" ) ) ), "{u}: who runs it? (docs/ENGINE.md)" );
		}
	}

	#[test]
	fn no_experimental_server_for_mainnet() {
		assert!( MAINNET_SERVERS.iter().all( |u| !u.contains( ".unsafe." ) ) );
	}

	// D-033: a network the build doesn't open has no server (v1: none for testnet)
	#[test]
	fn a_network_the_build_doesnt_open_has_no_server() {
		for net in [ network_t::NET_TESTNET, network_t::NET_MAINNET ] {
			assert_eq!( Com_Candidates( net, &BTreeMap::new() ).is_empty(), !NETWORKS.contains( &net ), "{net:?}" );
		}
	}

	#[test]
	fn a_testnet_only_build_offers_no_mainnet_server() {
		assert_eq!( Com_Candidates( network_t::NET_MAINNET, &BTreeMap::new() ).is_empty(), cfg!( feature = "testnet-only" ) );
	}

	#[test]
	fn a_server_sits_out_unless_every_one_is() {
		let net = NETWORKS[0];		// the build's own: v1 has no testnet server
		let all = Com_Candidates( net, &BTreeMap::new() );
		let mut benched = BTreeMap::new();
		benched.insert( all[0].clone(), Instant::now() );
		assert!( !Com_Candidates( net, &benched ).contains( &all[0] ) );

		let every: BTreeMap< String, Instant > = all.iter().map( |u| ( u.clone(), Instant::now() ) ).collect();
		assert_eq!( Com_Candidates( net, &every ), all );
	}

	// W2-01: a server that can't serve the tip's trees sits out, as one that fails to answer does
	#[test]
	fn a_server_that_cant_serve_sync_sits_out() {
		assert!( Com_Benches( &werr_t::WERR_SERVER_OUTDATED( "x".into() ) ) );
		assert!( Com_Benches( &werr_t::WERR_SERVER( "x".into() ) ) && Com_Benches( &werr_t::WERR_SERVER_SLOW ) && Com_Benches( &werr_t::WERR_SERVER_BEHIND ) );
		assert!( !Com_Benches( &werr_t::WERR_INTERCEPTED ), "the network's doing, not the server's" );
		assert!( !Com_Benches( &werr_t::WERR_ENGINE( "x".into() ) ) );
	}

	#[test]
	fn a_pool_active_at_the_tip_must_have_a_tree() {
		for net in [ network_t::NET_MAINNET, network_t::NET_TESTNET ] {
			let at = |u: NetworkUpgrade| u32::from( W_ChainType( net ).activation_height( u ).unwrap() );
			let trees = |s: &str, o: &str, i: &str| TreeState { sapling_tree: s.into(), orchard_tree: o.into(), ironwood_tree: i.into(), ..Default::default() };
			let ironwood = at( NetworkUpgrade::Nu6_3 );
			assert_eq!( Com_TreesServed( net, ironwood, &trees( "00", "00", "00" ) ), None, "{net:?}" );
			assert_eq!( Com_TreesServed( net, ironwood, &trees( "00", "00", "" ) ), Some( "Ironwood" ), "{net:?}" );
			assert_eq!( Com_TreesServed( net, ironwood - 1, &trees( "00", "00", "" ) ), None, "before Ironwood: {net:?}" );
			assert_eq!( Com_TreesServed( net, at( NetworkUpgrade::Nu5 ), &trees( "00", "", "" ) ), Some( "Orchard" ), "{net:?}" );
			assert_eq!( Com_TreesServed( net, at( NetworkUpgrade::Sapling ), &trees( "", "", "" ) ), Some( "Sapling" ), "{net:?}" );
			assert_eq!( Com_TreesServed( net, at( NetworkUpgrade::Sapling ) - 1, &trees( "", "", "" ) ), None, "{net:?}" );
		}
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
		// every listed server serves the tip's trees (W2-01): one that didn't would never be picked
		for net in [ network_t::NET_TESTNET, network_t::NET_MAINNET ] {
			for uri in Com_Servers( net ) {
				let check = W_CheckServer( net, uri.to_string() ).await;
				println!( "{net:?} {uri}: {check:?}" );
			}
		}
		let wrong = W_CheckServer( network_t::NET_MAINNET, "https://testnet.zec.rocks:443".into() ).await;
		println!( "testnet server for mainnet: {wrong:?}" );
		assert!( matches!( wrong, Err( werr_t::WERR_SERVER_NETWORK( .. ) ) ) );
	}

	// W2-04: the chain's own names, whole; not a name that starts like one
	#[test]
	fn a_chain_is_named_exactly() {
		for ( name, net ) in [ ( "main", network_t::NET_MAINNET ), ( "mainnet", network_t::NET_MAINNET ), ( "test", network_t::NET_TESTNET ), ( "TestNet", network_t::NET_TESTNET ) ] {
			assert!( Com_ServesNetwork( name, net ), "{name}" );
		}
		for ( name, net ) in [ ( "maintenance", network_t::NET_MAINNET ), ( "main-fork", network_t::NET_MAINNET ), ( "testing", network_t::NET_TESTNET ), ( "regtest", network_t::NET_TESTNET ) ] {
			assert!( !Com_ServesNetwork( name, net ), "{name}" );
		}
	}

	// W2-04: a server past an upgrade this build doesn't know is no pick, and no one's own
	#[test]
	fn a_server_on_an_unknown_branch_is_refused() {
		assert!( Com_CheckInfo( network_t::NET_MAINNET, "main", "37a5165b" ).is_ok() );
		assert!( Com_CheckInfo( network_t::NET_MAINNET, "main", "" ).is_ok(), "nothing said, nothing follows" );
		assert!( matches!( Com_CheckInfo( network_t::NET_MAINNET, "main", "deadbeef" ), Err( werr_t::WERR_NETWORK_NEWER ) ) );
		assert!( matches!( Com_CheckInfo( network_t::NET_MAINNET, "test", "37a5165b" ), Err( werr_t::WERR_SERVER_NETWORK( .. ) ) ) );
	}

	// W2-04: the person's own server, read back from its file, is checked on the first
	// connection as it was when they set it: one that no longer answers is refused, and
	// never quietly replaced by one they didn't choose
	#[tokio::test( flavor = "multi_thread" )]
	async fn a_saved_own_server_is_checked_before_it_is_used() {
		let net = network_t::NET_TESTNET;
		let gone = "https://127.0.0.1:1".to_string();
		{
			let mut s = w_servers.lock().unwrap();
			let n = &mut s[ Com_NetIndex( net ) ];
			n.loaded	= true;		// as Sv_Load leaves it
			n.own		= Some( gone.clone() );
		}
		let used = W_Server( net ).await;
		{
			let mut s = w_servers.lock().unwrap();
			s[ Com_NetIndex( net ) ] = netServer_t::default();
		}
		assert!( used.is_err(), "{used:?}" );
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
