/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_offline.rs -- a payment prepared online, signed on a computer that is
// never online, and sent online (docs/OFFLINE-SIGNING.md)
//
// Online, a view-only wallet saves a signing request: the payment the
// person reviewed, and the wallet's synced state exactly as that review
// was built on (no keys: it has none). Offline, Laurel finds its own wallet
// with the same viewing key, puts the spending key beside that state in
// memory, builds the same payment, and after a second review on the
// offline screen signs it with no network (the engine then gives it the
// longest expiry). Online again, the signed transaction is taken apart with
// the viewing key and sent only if it pays exactly what was asked, and
// nothing else leaves the wallet.
//
// The numbered edge cases are docs/OFFLINE-SIGNING.md's.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{ LazyLock, Mutex };

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{ Deserialize, Serialize };
use specta::Type;
use tauri::AppHandle;
use zcash_address::unified::{ Container, Receiver };
use zcash_address::{ ConversionError, TryFromAddress, ZcashAddress };
use zcash_client_backend::{ decrypt_transaction, TransferType };
use zcash_protocol::consensus::{ BlockHeight, BranchId, NetworkType };
use zcash_protocol::memo::MemoBytes;
use zeroize::Zeroizing;
use zip32::AccountId;

use crate::w_dialog::{ D_PickFile, D_SaveFile };
use crate::w_engine::*;
use crate::w_local::*;
use crate::w_main::{ W_AccountOf, W_Engine, W_Slot, W_Slots };
use crate::w_net::{ W_Broadcast, W_ChainType };
use crate::w_send::{ W_CheckMemo, W_Propose };
use crate::w_spendkey::{ Sk_CopyInto, Sk_EnsureOffline, Sk_Needed };
use crate::w_vault::{ purpose_t, Com_RandomHex, V_EditSealed, V_ReadSealed };

const FORMAT: u32				= 1;
const REQUEST_EXT: &str			= "laurelreq";
const SIGNED_EXT: &str			= "laurelsigned";
const REQUEST_KIND: &str		= "laurel signing request";
const SIGNED_KIND: &str			= "laurel signed payment";
const FILE_MAX_BYTES: u64		= 64 * 1024 * 1024;		// (11)
const PENDING_FILE_NAME: &str	= "offline-requests.json";
const PENDING_WHAT: file_t		= file_t::FILE_REQUESTS;

// the file pickers' names for Laurel's two kinds of file, until the ui has said its words (uiWords_t)
const REQUEST_FILE_NAME: &str	= "Laurel signing request";
const SIGNED_FILE_NAME: &str	= "Laurel signed payment";
const SIGNER_DIR_NAME: &str		= "offline-signing";

// a file between the computers: what it is, its body, and the body's hash (12)
#[derive( Serialize, Deserialize )]
struct envelope_t {
	laurel:	String,
	format:	u32,
	sum:	String,
	body:	String,
}

#[derive( Clone, Serialize, Deserialize )]
struct requestBody_t {
	id:			String,
	network:	network_t,
	account:	u32,
	viewKey:	String,				// the account's, encoded: the offline wallet must have the same (1)
	snapshot:	String,				// the wallet's state, base64, as the quote was built on
	request:	sendRequest_t,
	quote:		sendQuote_t,
	made:		u64,
}

#[derive( Serialize, Deserialize )]
struct signedTx_t {
	txid:	String,
	raw:	String,				// base64
}

#[derive( Serialize, Deserialize )]
struct signedBody_t {
	requestId:	String,
	network:	network_t,
	txs:		Vec< signedTx_t >,
	made:		u64,
}

// a request saved online, until its signed payment comes back or is forgotten (20)
#[derive( Clone, Debug, PartialEq, Serialize, Deserialize, Type )]
pub struct offlinePending_t {
	pub id:			String,
	pub walletId:	String,
	pub account:	u32,
	pub quote:		sendQuote_t,
	pub made:		u64,
	#[serde( default )]
	pub sentUnsure:	Option< unsureSend_t >,		// its signed payment's broadcast may have gone out (O_Finish)
}

// a signed payment whose broadcast may have gone out: the view-only wallet
// reserves nothing for it, so its account makes no new request until it shows
// up here or the chain passes its expiry (O_CheckNoneUnsure)
#[derive( Clone, Debug, PartialEq, Serialize, Deserialize, Type )]
pub struct unsureSend_t {
	pub txid:	String,
	pub expiry:	u32,
}

// what the offline screen shows before signing
#[derive( Clone, Debug, Serialize, Type )]
pub struct offlineReview_t {
	pub requestId:		String,
	pub walletName:		String,
	pub accountName:	String,
	pub quote:			sendQuote_t,		// as built here, now
	pub changed:		bool,				// it differs from what was reviewed online (8)
	pub made:			u64,
	pub keyFolder:		Option< String >,	// it spends Sapling notes and Sapling's spend key isn't here: copy it into this folder
}

// what saving a request did
#[derive( Clone, Debug, Serialize, Type )]
#[serde( tag = "kind" )]
pub enum offlineSaved_t {
	#[serde( rename = "saved" )]
	SAVED { path: String },
	#[serde( rename = "changed" )]
	CHANGED { quote: sendQuote_t },			// the numbers moved since the review: look again
	#[serde( rename = "cancelled" )]
	CANCELLED,
}

// the request open on the offline screen: its body only, never a key (15)
static o_open: LazyLock< Mutex< Option< requestBody_t > > > = LazyLock::new( || Mutex::new( None ) );

// one change of the pending list at a time
static o_writing: LazyLock< tokio::sync::Mutex< () > > = LazyLock::new( || tokio::sync::Mutex::new( () ) );

// one look at an account's signed payments and the change that follows it at
// a time (a new request, a broadcast and its mark, a request given up): two at
// once could each see none perhaps out, and each go ahead
static o_account: LazyLock< tokio::sync::Mutex< () > > = LazyLock::new( || tokio::sync::Mutex::new( () ) );


/*
=========================================================================

FILES

=========================================================================
*/

fn Com_Sum( body: &str ) -> String {
	crate::w_vault::Com_Hash( b"Laurel_Offline__", 32, body.as_bytes() ).iter().map( |b| format!( "{b:02x}" ) ).collect()
}

fn Com_Wrap< T: Serialize >( kind: &str, body: &T ) -> wresult_t< Zeroizing< Vec< u8 > > > {
	let body = serde_json::to_string( body ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
	let env = envelope_t { laurel: kind.to_string(), format: FORMAT, sum: Com_Sum( &body ), body: body };
	Ok( Zeroizing::new( serde_json::to_vec_pretty( &env ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )? ) )
}

/*
==================
Com_Unwrap

A file as one of ours of this kind, whole: too large (11), not ours,
another kind, a newer format, or a body whose hash doesn't match (a copy
cut short, 12) are each refused
==================
*/
fn Com_Unwrap< T: for< 'de > Deserialize< 'de > >( raw: &[ u8 ], kind: &str ) -> wresult_t< T > {
	let env: envelope_t = serde_json::from_slice( raw ).map_err( |_| werr_t::WERR_OFFLINE_FILE )?;
	if ( env.laurel != kind ) {
		return Err( werr_t::WERR_OFFLINE_FILE );
	}
	if ( env.format > FORMAT ) {
		return Err( werr_t::WERR_OFFLINE_NEWER );
	}
	if ( Com_Sum( &env.body ) != env.sum ) {
		return Err( werr_t::WERR_OFFLINE_FILE );
	}
	serde_json::from_str( &env.body ).map_err( |_| werr_t::WERR_OFFLINE_FILE )
}

fn Com_ReadPicked( path: &PathBuf ) -> wresult_t< Zeroizing< Vec< u8 > > > {
	crate::w_documents::Doc_Read( path, FILE_MAX_BYTES )
}

// a key with nothing the unified encoding can carry has no text: the engine's fault, not the user's
fn Com_ViewKeyText( net: network_t, ufvk: &zcash_keys::keys::UnifiedFullViewingKey ) -> wresult_t< String > {
	ufvk.encode( &W_ChainType( net ) ).map_err( |e| werr_t::WERR_ENGINE( format!( "encoding a viewing key: {e}" ) ) )
}


/*
=========================================================================

THE PENDING REQUESTS (online)

=========================================================================
*/

async fn O_PendingPath() -> PathBuf {
	crate::w_main::W_NetworkDir( w_registry.read().await.network ).join( PENDING_FILE_NAME )
}

// this network's requests waiting for their signed payment, oldest first
pub async fn O_Pending() -> wresult_t< Vec< offlinePending_t > > {
	V_ReadSealed( &O_PendingPath().await, purpose_t::PURPOSE_OFFLINE, PENDING_WHAT )
}

async fn O_EditPending< R >( edit: impl FnOnce( &mut Vec< offlinePending_t > ) -> R ) -> wresult_t< R > {
	V_EditSealed( &o_writing, &O_PendingPath().await, purpose_t::PURPOSE_OFFLINE, PENDING_WHAT, edit ).await
}

/*
==================
O_Forget

A request given up. Only spending from the account voids a signed file
made for it (4): the screen says so before this is asked for. One whose
signed payment may have gone out can't be given up while that's unknown:
its record is what holds the account from a second request (A-03)
==================
*/
pub async fn O_Forget( id: &str ) -> wresult_t< () > {
	let _one = o_account.lock().await;
	if let Some( p ) = O_Pending().await?.into_iter().find( |p| p.id == id && p.sentUnsure.is_some() ) {
		O_CheckNoneUnsure( &p.walletId, p.account, None ).await?;		// settles it, or refuses
	}
	O_Remove( id ).await
}

// a request done with: its payment went out, or it was given up (O_Forget)
async fn O_Remove( id: &str ) -> wresult_t< () > {
	O_EditPending( |all| all.retain( |p| p.id != id ) ).await
}

// marks a request's signed payment as perhaps gone out, or clears the mark
async fn O_MarkUnsure( id: &str, unsure: Option< unsureSend_t > ) -> wresult_t< () > {
	O_EditPending( |all| all.iter_mut().filter( |p| p.id == id ).for_each( |p| p.sentUnsure = unsure.clone() ) ).await
}

// settling a mark read a moment ago: only while it is still that payment's,
// never a newer mark made since (T-044)
async fn O_SettleMark( id: &str, txid: &str, done: bool ) -> wresult_t< () > {
	O_EditPending( |all| Com_SettleMark( all, id, txid, done ) ).await
}

fn Com_SettleMark( all: &mut Vec< offlinePending_t >, id: &str, txid: &str, done: bool ) {
	let still = |p: &offlinePending_t| p.id == id && p.sentUnsure.as_ref().is_some_and( |u| u.txid == txid );
	if ( done ) {
		all.retain( |p| !still( p ) );		// it went out: the request is done
	} else {
		all.iter_mut().filter( |p| still( p ) ).for_each( |p| p.sentUnsure = None );		// expired: the mark goes
	}
}


/*
=========================================================================

ONLINE: SAVING A REQUEST

=========================================================================
*/

/*
==================
O_SaveRequest

From Send on a view-only wallet (19): built again now, and saved only if
it is what the person reviewed (else the new numbers go back); the
wallet's state is taken in the same hold of the engine as that build, so
the offline computer plans on exactly it. A payment of two transactions
(an exchange-only address) isn't offered in this version (9).
==================
*/
pub async fn O_SaveRequest( app: &AppHandle, walletId: &str, account: u32, request: sendRequest_t, seen: sendQuote_t ) -> wresult_t< offlineSaved_t > {
	let net = w_registry.read().await.network;
	let slot = W_Slot( walletId ).await?;
	// only a wallet that can't sign here asks another device to
	if ( crate::w_main::W_Can( slot.read().await.meta.kind ).spend ) {
		return Err( werr_t::WERR_OFFLINE_CAN_SEND );
	}
	{
		// under the lock, which ends before the picker opens (checked again after it)
		let _one = o_account.lock().await;
		O_CheckNoneUnsure( walletId, account, None ).await?;
	}
	if ( seen.steps > 1 || seen.kind == addrKind_t::ADDR_TEX || seen.also.iter().any( |p| p.kind == addrKind_t::ADDR_TEX ) ) {
		return Err( werr_t::WERR_OFFLINE_TWO_STEPS );
	}
	crate::w_sync::Sync_RequireCaughtUp( &slot ).await?;
	let ( accountId, client, wallet ) = W_Engine( walletId, account ).await?;

	let built = E_Fenced( &mut *E_Client( &client ).await?, fence_t::FENCE_SCANNED, async |f| {
		let quote = E_Quote( f, async |f| W_Propose( f, accountId, &request ).await ).await?;
		if ( quote != seen ) {
			return Ok( Err( quote ) );
		}
		Ok( Ok( E_SnapshotFenced( f ).await? ) )
	} ).await?;
	let snapshot = match built {
		Ok( s ) => s,
		Err( quote ) => return Ok( offlineSaved_t::CHANGED { quote: quote } ),
	};
	let viewKey = {
		let w = E_Read( &wallet ).await?;
		Com_ViewKeyText( net, &E_ViewKeyOf( &w, accountId ).ok_or( werr_t::WERR_VIEWONLY )? )?
	};

	let id = Com_RandomHex( REQUEST_ID_BYTES );
	let body = requestBody_t { id: id.clone(), network: net, account: account, viewKey: viewKey, snapshot: B64.encode( &*snapshot ), request: request, quote: seen.clone(), made: crate::w_date::Com_Now() };
	let Some( path ) = D_SaveFile( app, &W_Notice( |w| &w.requestFile, REQUEST_FILE_NAME ), REQUEST_EXT, &format!( "payment-{}.{REQUEST_EXT}", &id[..6] ) ).await? else {
		return Ok( offlineSaved_t::CANCELLED );
	};
	// again, now: a signed payment may have gone out while the picker was open
	let _one = o_account.lock().await;
	O_CheckNoneUnsure( walletId, account, None ).await?;
	crate::w_documents::Doc_Write( &path, &Com_Wrap( REQUEST_KIND, &body )? )?;
	O_EditPending( |all| all.push( offlinePending_t { id: id, walletId: walletId.to_string(), account: account, quote: seen, made: body.made, sentUnsure: None } ) ).await?;
	Ok( offlineSaved_t::SAVED { path: path.display().to_string() } )
}


/*
=========================================================================

OFFLINE: OPENING AND SIGNING

=========================================================================
*/

// the wallet here that can sign for a request: its account's viewing key is the request's (1, 16)
struct signer_t {
	walletName:		String,
	accountName:	String,
	account:		AccountId,
	usk:			zcash_keys::keys::UnifiedSpendingKey,
}

async fn O_Signer( body: &requestBody_t ) -> wresult_t< signer_t > {
	let mut viewsOnly = false;
	for ( _, slot ) in W_Slots().await {
		let ( wallet, meta ) = {
			let s = slot.read().await;
			( s.wallet.clone(), s.meta.clone() )
		};
		let Ok( account ) = AccountId::try_from( body.account ) else {
			continue;
		};
		if ( body.account as usize >= meta.accounts.len() ) {
			continue;
		}
		let w = E_Read( &wallet ).await?;
		let Some( ufvk ) = E_ViewKeyOf( &w, account ) else {
			continue;
		};
		if ( Com_ViewKeyText( body.network, &ufvk )? != body.viewKey ) {
			continue;
		}
		match E_SpendKeyOf( &w, account ) {
			Some( usk ) => return Ok( signer_t { walletName: meta.name.clone(), accountName: meta.accounts[ body.account as usize ].clone(), account: account, usk: usk } ),
			None => viewsOnly = true,
		}
	}
	Err( if viewsOnly { werr_t::WERR_OFFLINE_SIGNER_VIEWS } else { werr_t::WERR_OFFLINE_NO_SIGNER } )
}

/*
==================
O_WithSigner

A client from the request's state, with the signer's key in memory, for
one piece of work; its folder (the engine wants one, and writes nothing
to it) is removed after, however the work ends (15)
==================
*/
async fn O_WithSigner< T >( body: &requestBody_t, signer: signer_t, work: impl AsyncFnOnce( &mut fenced_t< '_ > ) -> wresult_t< T > ) -> wresult_t< T > {
	O_CheckId( &body.id )?;
	// a folder of this run's own, never named from the file: the request is
	// untrusted until checked, and this folder is deleted after
	let root = Com_DataPath( SIGNER_DIR_NAME ).ok_or_else( Com_NoDataFolder )?;
	std::fs::create_dir_all( &root ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
	let dir = root.join( Com_RandomHex( REQUEST_ID_BYTES ) );
	std::fs::create_dir( &dir ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
	let result = async {
		let snapshot = Zeroizing::new( B64.decode( &body.snapshot ).map_err( |_| werr_t::WERR_OFFLINE_FILE )? );
		let config = crate::w_main::W_BuildConfig( body.network, &dir, zingolib::config::WalletConfig::Read )?;
		let mut client = E_Signer( &snapshot, config, signer.account, signer.usk ).await?;
		E_Fenced( &mut client, fence_t::FENCE_SCANNED, work ).await
	}.await;
	let _ = std::fs::remove_dir_all( &dir );		// nothing of the key is in it; tidiness
	result
}

/*
==================
O_CheckId

A request's id is what Laurel made it (Com_RandomHex of REQUEST_ID_BYTES):
anything else is a file Laurel didn't write. Checked before the id names
a file or is sliced (security review A-01: "../wallets" as an id once
named the folder deleted after signing).
==================
*/
const REQUEST_ID_BYTES: usize = 8;

fn O_CheckId( id: &str ) -> wresult_t< () > {
	if ( id.len() != REQUEST_ID_BYTES * 2 || !id.bytes().all( |b| b.is_ascii_hexdigit() ) ) {
		return Err( werr_t::WERR_OFFLINE_FILE );
	}
	Ok( () )
}

/*
==================
O_Open

The offline screen's first step: a request picked, checked for this
network (2), matched to a wallet here (1, 16), and the payment built
from its state, to review here. Nothing is signed; none when the person
closed the picker.
==================
*/
pub async fn O_Open( app: &AppHandle ) -> wresult_t< Option< offlineReview_t > > {
	let Some( path ) = D_PickFile( app, &W_Notice( |w| &w.requestFile, REQUEST_FILE_NAME ), REQUEST_EXT ).await? else {
		return Ok( None );
	};
	let body: requestBody_t = Com_Unwrap( &Com_ReadPicked( &path )?, REQUEST_KIND )?;
	O_CheckId( &body.id )?;
	let net = w_registry.read().await.network;
	if ( body.network != net ) {
		return Err( werr_t::WERR_NETWORK( body.network.Name(), net.Name() ) );
	}
	let signer = O_Signer( &body ).await?;
	let ( walletName, accountName, account ) = ( signer.walletName.clone(), signer.accountName.clone(), signer.account );
	let request = body.request.clone();
	let quote = O_WithSigner( &body, signer, async |f| E_Quote( f, async |f| W_Propose( f, account, &request ).await ).await ).await?;

	let keyFolder = Sk_CopyInto( &quote.from ).await;
	let review = offlineReview_t { requestId: body.id.clone(), walletName: walletName, accountName: accountName, changed: quote != body.quote, quote: quote, made: body.made, keyFolder: keyFolder };
	*o_open.lock().unwrap() = Some( body );
	Ok( Some( review ) )
}

/*
==================
O_Sign

Built again and signed, only if it is what the person reviewed here;
the signed file saved where they choose. The signing client is dropped
when this returns (15); the engine's own copies of the keys aren't wiped
as they drop (W1-08), only the phrase and the passphrase are. None when
they closed the picker: nothing signed is kept.
==================
*/
pub async fn O_Sign( app: &AppHandle, requestId: &str, seen: sendQuote_t ) -> wresult_t< Option< String > > {
	let body = o_open.lock().unwrap().clone().filter( |b| b.id == requestId ).ok_or( werr_t::WERR_OFFLINE_FILE )?;
	// a signer downloads nothing: a copy of Sapling's spend key is here, or it says where one goes
	if ( Sk_Needed( &seen.from ) ) {
		Sk_EnsureOffline().await?;
	}
	let signer = O_Signer( &body ).await?;
	let account = signer.account;
	let request = body.request.clone();
	let signed = O_WithSigner( &body, signer, async |f| {
		let quote = W_Propose( f, account, &request ).await?;
		if ( quote != seen ) {
			E_ClearProposal( f ).await;
			return Err( werr_t::WERR_PAYMENT_DONE );		// the review is stale: open the request again
		}
		E_Calculate( f ).await
	} ).await?;

	let out = signedBody_t {
		requestId:	body.id.clone(),
		network:	body.network,
		txs:		signed.into_iter().map( |( txid, raw )| signedTx_t { txid: txid, raw: B64.encode( raw ) } ).collect(),
		made:		crate::w_date::Com_Now(),
	};
	let Some( path ) = D_SaveFile( app, &W_Notice( |w| &w.signedFile, SIGNED_FILE_NAME ), SIGNED_EXT, &format!( "signed-{}.{SIGNED_EXT}", &body.id[..6] ) ).await? else {
		return Ok( None );
	};
	crate::w_documents::Doc_Write( &path, &Com_Wrap( SIGNED_KIND, &out )? )?;
	*o_open.lock().unwrap() = None;
	Ok( Some( path.display().to_string() ) )
}

pub fn O_Close() {
	*o_open.lock().unwrap() = None;
}


/*
=========================================================================

ONLINE: CHECKING AND SENDING

=========================================================================
*/

// an address's receivers, each tagged by kind: a unified address has several
struct receivers_t( Vec< ( char, Vec< u8 > ) > );

impl TryFromAddress for receivers_t {
	type Error = ();

	fn try_from_sapling( _net: NetworkType, data: [ u8; 43 ] ) -> Result< Self, ConversionError< () > > {
		Ok( receivers_t( vec![ ( 's', data.to_vec() ) ] ) )
	}

	fn try_from_unified( _net: NetworkType, ua: zcash_address::unified::Address ) -> Result< Self, ConversionError< () > > {
		Ok( receivers_t( ua.items().into_iter().filter_map( |r| match r {
			Receiver::Orchard( d )	=> Some( ( 'o', d.to_vec() ) ),		// an Ironwood note pays the same receiver
			Receiver::Sapling( d )	=> Some( ( 's', d.to_vec() ) ),
			Receiver::P2pkh( d )	=> Some( ( 'p', d.to_vec() ) ),
			Receiver::P2sh( d )		=> Some( ( 'h', d.to_vec() ) ),
			Receiver::Unknown { .. }	=> None,
		} ).collect() ) )
	}

	fn try_from_transparent_p2pkh( _net: NetworkType, data: [ u8; 20 ] ) -> Result< Self, ConversionError< () > > {
		Ok( receivers_t( vec![ ( 'p', data.to_vec() ) ] ) )
	}

	fn try_from_transparent_p2sh( _net: NetworkType, data: [ u8; 20 ] ) -> Result< Self, ConversionError< () > > {
		Ok( receivers_t( vec![ ( 'h', data.to_vec() ) ] ) )
	}
}

// one payment asked for: who can receive it, how much, and what it says
#[derive( Clone, Debug )]
pub struct asked_t {
	receivers:	Vec< ( char, Vec< u8 > ) >,
	zats:		u64,
	memo:		Option< MemoBytes >,
}

// one output the signed transaction makes, as the viewing key sees it
#[derive( Clone, Debug )]
pub struct found_t {
	receiver:	( char, Vec< u8 > ),
	zats:		u64,
	memo:		Option< MemoBytes >,		// none: transparent, or no memo written
	change:		bool,						// back to this account
}

/*
==================
Com_CheckSigned

A signed transaction against what was asked (7): every output that
isn't change is one of the payments asked for (receiver, amount, memo),
each payment is made exactly once, and the value adds up. What the
transaction spends of this wallet, less the fee reviewed, less every
output the viewing key sees, is zero; an output hidden from it would be
left over.
==================
*/
pub fn Com_CheckSigned( asked: &[ asked_t ], found: &[ found_t ], spent: u64, fee: u64 ) -> wresult_t< () > {
	let mut open: Vec< &asked_t > = asked.iter().collect();
	for f in found.iter().filter( |f| !f.change ) {
		let memo = f.memo.clone().filter( |m| *m != MemoBytes::empty() );
		let i = open.iter().position( |a| a.zats == f.zats && a.memo == memo && a.receivers.contains( &f.receiver ) ).ok_or( werr_t::WERR_OFFLINE_MISMATCH )?;
		open.remove( i );
	}
	if ( !open.is_empty() ) {
		return Err( werr_t::WERR_OFFLINE_MISMATCH );
	}
	let seen: u64 = found.iter().map( |f| f.zats ).sum();
	if ( spent.checked_sub( fee ).and_then( |left| left.checked_sub( seen ) ) != Some( 0 ) ) {
		return Err( werr_t::WERR_OFFLINE_HIDDEN );
	}
	Ok( () )
}

// the payments a quote asked for: the first (the amount less the others), then each further one
fn Com_Asked( q: &sendQuote_t ) -> wresult_t< Vec< asked_t > > {
	let one = |to: &str, zats: u64, memo: &Option< String >, kind: addrKind_t| -> wresult_t< asked_t > {
		let receivers = ZcashAddress::try_from_encoded( to ).ok().and_then( |a| a.convert::< receivers_t >().ok() ).ok_or( werr_t::WERR_OFFLINE_MISMATCH )?;
		Ok( asked_t { receivers: receivers.0, zats: zats, memo: W_CheckMemo( memo, kind )? } )
	};
	let others: u64 = q.also.iter().map( |p| p.amount ).sum();
	let mut all = vec![ one( &q.to, q.amount.saturating_sub( others ), &q.memo, q.kind )? ];
	for p in &q.also {
		all.push( one( &p.to, p.amount, &p.memo, p.kind )? );
	}
	Ok( all )
}

// every output of a signed transaction the viewing key can see, and every transparent one
fn Com_Found( net: network_t, tx: &zcash_primitives::transaction::Transaction, account: AccountId, ufvk: zcash_keys::keys::UnifiedFullViewingKey ) -> Vec< found_t > {
	let params = W_ChainType( net );
	let keys = HashMap::from( [ ( account, ufvk ) ] );
	let d = decrypt_transaction( &params, None, None, tx, &keys );
	let change = |t: TransferType| matches!( t, TransferType::AccountInternal | TransferType::WalletInternal );

	let mut out: Vec< found_t > = d.sapling_outputs().iter().map( |o| found_t {
		receiver:	( 's', o.note().recipient().to_bytes().to_vec() ),
		zats:		o.note().value().inner(),
		memo:		Some( o.memo().clone() ),
		change:		change( o.transfer_type() ),
	} ).collect();
	for o in d.orchard_outputs().iter().chain( d.ironwood_outputs() ) {
		out.push( found_t { receiver: ( 'o', o.note().0.recipient().to_raw_address_bytes().to_vec() ), zats: o.note().0.value().inner(), memo: Some( o.memo().clone() ), change: change( o.transfer_type() ) } );
	}
	if let Some( b ) = tx.transparent_bundle() {
		for v in &b.vout {
			let receiver = match v.recipient_address() {
				Some( zcash_transparent::address::TransparentAddress::PublicKeyHash( h ) )	=> ( 'p', h.to_vec() ),
				Some( zcash_transparent::address::TransparentAddress::ScriptHash( h ) )		=> ( 'h', h.to_vec() ),
				None => ( '?', v.script_pubkey().0.0.clone() ),		// no address: matches nothing asked
			};
			out.push( found_t { receiver: receiver, zats: v.value().into_u64(), memo: None, change: false } );
		}
	}
	out
}

/*
==================
O_Finish

A signed file picked, for a request made here (5, 6), on this network;
each transaction read, its id checked, taken apart with the viewing key
and checked against the request (7); then sent, in order, and the
request is done. None when the person closed the picker.
==================
*/
pub async fn O_Finish( app: &AppHandle ) -> wresult_t< Option< Vec< String > > > {
	let Some( path ) = D_PickFile( app, &W_Notice( |w| &w.signedFile, SIGNED_FILE_NAME ), SIGNED_EXT ).await? else {
		return Ok( None );
	};
	let body: signedBody_t = Com_Unwrap( &Com_ReadPicked( &path )?, SIGNED_KIND )?;
	let net = w_registry.read().await.network;
	if ( body.network != net ) {
		return Err( werr_t::WERR_NETWORK( body.network.Name(), net.Name() ) );
	}
	let _one = o_account.lock().await;
	let pending = O_Pending().await?.into_iter().find( |p| p.id == body.requestId ).ok_or( werr_t::WERR_OFFLINE_NOT_OURS )?;
	// another of this account's signed payments perhaps out: this one waits too
	// (this one itself unsure is fine: the same file again pays once)
	O_CheckNoneUnsure( &pending.walletId, pending.account, Some( &pending.id ) ).await?;
	let ( accountId, _, wallet ) = W_Engine( &pending.walletId, pending.account ).await?;
	let asked = Com_Asked( &pending.quote )?;

	let mut raws = vec![];
	{
		let w = E_Read( &wallet ).await?;
		let ufvk = E_ViewKeyOf( &w, accountId ).ok_or( werr_t::WERR_VIEWONLY )?;
		let tip = BlockHeight::from( w.sync_state.last_known_chain_height().map_or( 0, u32::from ) );
		if ( body.txs.len() != 1 ) {
			return Err( werr_t::WERR_OFFLINE_TWO_STEPS );		// (9): a request is one transaction in this version
		}
		for t in &body.txs {
			let raw = B64.decode( &t.raw ).map_err( |_| werr_t::WERR_OFFLINE_FILE )?;
			let tx = zcash_primitives::transaction::Transaction::read( &raw[..], BranchId::for_height( &W_ChainType( net ), tip ) ).map_err( |_| werr_t::WERR_OFFLINE_FILE )?;
			if ( tx.txid().to_string() != t.txid ) {
				return Err( werr_t::WERR_OFFLINE_FILE );
			}
			let spent = E_SpentOfOurs( &w, &tx )?;
			Com_CheckSigned( &asked, &Com_Found( net, &tx, accountId, ufvk.clone() ), spent, pending.quote.fee )?;
			raws.push( ( t.txid.clone(), raw, u32::from( tx.expiry_height() ) ) );
		}
	}

	let mut sent = vec![];
	for ( txid, raw, expiry ) in raws {
		// a request whose payment may be out is sent again only as that same
		// payment: another signed file would be a second one
		let marked = pending.sentUnsure.is_some();
		if ( !Com_RetryAllowed( pending.sentUnsure.as_ref(), &txid ) ) {
			return Err( werr_t::WERR_OFFLINE_UNSURE );
		}
		// marked before a byte leaves, so a stop mid-broadcast still holds the
		// account from a second request
		if ( !marked ) {
			O_MarkUnsure( &pending.id, Some( unsureSend_t { txid: txid.clone(), expiry: expiry } ) ).await?;
		}
		match W_Broadcast( net, raw ).await {
			Ok( () ) => sent.push( txid ),
			// may have gone out: the request stays, marked, so its account makes no
			// new one meanwhile, and this same file can be sent again
			Err( werr_t::WERR_SENT_UNSURE( d ) ) => return Err( werr_t::WERR_OFFLINE_SENT_UNSURE( d ) ),
			Err( e ) => {
				// refused (3: its notes spent meanwhile), or never reached a server
				if ( Com_ClearsMark( marked, &e ) ) {
					O_MarkUnsure( &pending.id, None ).await?;
				}
				return Err( e );
			}
		}
	}
	O_Remove( &pending.id ).await?;
	for to in std::iter::once( &pending.quote.to ).chain( pending.quote.also.iter().map( |p| &p.to ) ) {
		crate::w_contacts::Ct_MarkPaid( to ).await;
	}
	Ok( Some( sent ) )
}

/*
==================
O_CheckNoneUnsure

Before a new request from an account: none of its signed payments may
have gone out unseen. A view-only wallet reserves nothing for a payment
signed elsewhere, so a new request could plan on other notes while the
first one goes through: two payments (security review A-03). One that
shows up in the wallet went out: its request is done. One whose expiry
the chain has passed never will: the mark goes, the request stays
==================
*/
async fn O_CheckNoneUnsure( walletId: &str, account: u32, except: Option< &str > ) -> wresult_t< () > {
	let unsure: Vec< offlinePending_t > = O_Pending().await?.into_iter()
		.filter( |p| p.walletId == walletId && p.account == account && p.sentUnsure.is_some() && Some( p.id.as_str() ) != except )
		.collect();
	if ( unsure.is_empty() ) {
		return Ok( () );
	}
	// read only from a wallet caught up, and against what it has scanned, not
	// the tip it last heard of: a block not yet scanned may hold the payment.
	// Nothing changes before this
	crate::w_sync::Sync_RequireCaughtUp( &W_Slot( walletId ).await? ).await?;
	let ( _, _, wallet ) = W_Engine( walletId, account ).await?;
	let ( known, scanned ): ( Vec< String >, u32 ) = {
		let w = E_Read( &wallet ).await?;
		( w.wallet_transactions.keys().map( |t| t.to_string() ).collect(), w.sync_state.fully_scanned_height().map_or( 0, u32::from ) )
	};
	let mut waiting = false;
	for p in unsure {
		let Some( u ) = p.sentUnsure.as_ref() else {
			continue;
		};
		match Com_UnsureNow( u, &known, scanned ) {
			unsureNow_t::UNSURE_IN => O_SettleMark( &p.id, &u.txid, true ).await?,
			unsureNow_t::UNSURE_EXPIRED => O_SettleMark( &p.id, &u.txid, false ).await?,
			unsureNow_t::UNSURE_WAITING => waiting = true,
		}
	}
	if ( waiting ) {
		return Err( werr_t::WERR_OFFLINE_UNSURE );
	}
	Ok( () )
}

#[derive( Debug, PartialEq )]
enum unsureNow_t {
	UNSURE_IN,			// the wallet has it: it went out
	UNSURE_EXPIRED,		// the chain is past its expiry: it never will
	UNSURE_WAITING,
}

/*
==================
Com_ClearsMark

Whether a broadcast that failed (other than unsure) lets a request's mark
go. Marked by this attempt, nothing of it can be out: the failure came
before any byte left (no server reached) or was a clean refusal. Marked by
an earlier attempt, only a refusal of these bytes as malformed proves it
never went: a connection that fails now says nothing of the earlier
delivery (T-043)
==================
*/
fn Com_ClearsMark( markedBefore: bool, e: &werr_t ) -> bool {
	!markedBefore || matches!( e, werr_t::WERR_REJECTED( _ ) )
}

// a request already marked is sent again only as the payment marked
fn Com_RetryAllowed( marked: Option< &unsureSend_t >, txid: &str ) -> bool {
	marked.is_none_or( |u| u.txid == txid )
}

// scanned: the wallet's fully scanned height, never only the tip it heard of
fn Com_UnsureNow( u: &unsureSend_t, known: &[ String ], scanned: u32 ) -> unsureNow_t {
	if ( known.contains( &u.txid ) ) {
		return unsureNow_t::UNSURE_IN;
	}
	if ( u.expiry > 0 && scanned >= u.expiry ) {
		return unsureNow_t::UNSURE_EXPIRED;
	}
	unsureNow_t::UNSURE_WAITING
}

// this network's pending requests whose wallet and account are still here
pub async fn O_PendingHere() -> wresult_t< Vec< offlinePending_t > > {
	let mut here = vec![];
	for p in O_Pending().await? {
		let Ok( slot ) = W_Slot( &p.walletId ).await else {
			continue;
		};
		if ( W_AccountOf( &*slot.read().await, p.account ).is_ok() ) {
			here.push( p );
		}
	}
	Ok( here )
}


#[cfg( test )]
mod tests {
	use super::*;

	fn Asked( r: char, zats: u64, memo: Option< &str > ) -> asked_t {
		asked_t { receivers: vec![ ( r, vec![ 1 ] ) ], zats: zats, memo: memo.map( |m| MemoBytes::from_bytes( m.as_bytes() ).unwrap() ) }
	}

	fn Found( r: char, zats: u64, memo: Option< &str >, change: bool ) -> found_t {
		found_t { receiver: ( r, vec![ 1 ] ), zats: zats, memo: Some( memo.map_or_else( MemoBytes::empty, |m| MemoBytes::from_bytes( m.as_bytes() ).unwrap() ) ), change: change }
	}

	/*
	==================
	a_signed_payment_pays_exactly_what_was_asked

	The asked payment and change, adding up with the fee, pass; another
	amount, another receiver, another memo, a payment missing, one more
	output, or value the viewing key can't see (an output hidden from it)
	are each refused (7)
	==================
	*/
	// a request whose signed payment may be out is the record that holds its
	// account: Forget can't drop it unchecked (here its wallet isn't open, so
	// nothing can settle it, and the request stays)
	#[tokio::test( flavor = "multi_thread" )]
	async fn a_request_whose_payment_may_be_out_is_not_forgotten_unchecked() {
		crate::w_main::W_TestBase();
		crate::w_vault::V_TestUnlock();
		let quote = sendQuote_t { to: "t".to_string(), kind: addrKind_t::ADDR_TEX, amount: 1, fee: 1, from: vec![], steps: 1, memo: None, feeNote: None, also: vec![] };
		let unsure = Com_RandomHex( REQUEST_ID_BYTES );
		let plain = Com_RandomHex( REQUEST_ID_BYTES );
		O_EditPending( |all| {
			all.push( offlinePending_t { id: unsure.clone(), walletId: "not-open".to_string(), account: 0, quote: quote.clone(), made: 0, sentUnsure: Some( unsureSend_t { txid: "abc".to_string(), expiry: 100 } ) } );
			all.push( offlinePending_t { id: plain.clone(), walletId: "not-open".to_string(), account: 0, quote: quote, made: 0, sentUnsure: None } );
		} ).await.unwrap();

		assert!( O_Forget( &unsure ).await.is_err(), "forgotten while its payment may be out" );
		assert!( O_Pending().await.unwrap().iter().any( |p| p.id == unsure ) );
		// one never sent is given up as before
		O_Forget( &plain ).await.unwrap();
		assert!( !O_Pending().await.unwrap().iter().any( |p| p.id == plain ) );
		O_Remove( &unsure ).await.unwrap();
	}

	// a lost answer, then a retry that can't reach a server: the mark stays,
	// so Forget and a new request stay refused (T-043)
	#[test]
	fn a_later_failure_never_clears_an_earlier_uncertainty() {
		let offline = werr_t::WERR_SERVER( "connection refused".to_string() );
		let refused = werr_t::WERR_REJECTED( "16: bad-txns-sapling-bundle-invalid".to_string() );
		assert!( !Com_ClearsMark( true, &offline ), "an earlier delivery isn't undone by a failed retry" );
		assert!( Com_ClearsMark( true, &refused ), "malformed bytes were never in" );
		assert!( Com_ClearsMark( false, &offline ), "a first try that reached no server sent nothing" );

		let marked = unsureSend_t { txid: "abc".to_string(), expiry: 100 };
		assert!( Com_RetryAllowed( Some( &marked ), "abc" ), "the same payment again pays once" );
		assert!( !Com_RetryAllowed( Some( &marked ), "def" ), "another file for the request is a second payment" );
		assert!( Com_RetryAllowed( None, "def" ) );
	}

	// a mark read before a wait, settled after: a newer mark made meanwhile stays
	#[test]
	fn a_stale_reading_never_settles_a_newer_mark() {
		let quote = sendQuote_t { to: "t".to_string(), kind: addrKind_t::ADDR_TEX, amount: 1, fee: 1, from: vec![], steps: 1, memo: None, feeNote: None, also: vec![] };
		let mark = |txid: &str| Some( unsureSend_t { txid: txid.to_string(), expiry: 100 } );
		let mut all = vec![ offlinePending_t { id: "r".to_string(), walletId: "w".to_string(), account: 0, quote: quote, made: 0, sentUnsure: mark( "y" ) } ];

		Com_SettleMark( &mut all, "r", "x", false );
		assert_eq!( all[0].sentUnsure, mark( "y" ), "an expired reading of x cleared y" );
		Com_SettleMark( &mut all, "r", "x", true );
		assert_eq!( all.len(), 1, "a reading of x removed the request marked y" );

		Com_SettleMark( &mut all, "r", "y", false );
		assert_eq!( all[0].sentUnsure, None );
	}

	#[test]
	fn an_unsure_signed_payment_holds_its_account_until_it_shows_or_expires() {
		let u = unsureSend_t { txid: "abc".to_string(), expiry: 100 };
		assert_eq!( Com_UnsureNow( &u, &[ "abc".to_string() ], 50 ), unsureNow_t::UNSURE_IN );
		assert_eq!( Com_UnsureNow( &u, &[], 100 ), unsureNow_t::UNSURE_EXPIRED );
		assert_eq!( Com_UnsureNow( &u, &[], 99 ), unsureNow_t::UNSURE_WAITING );
		// no expiry (0) never expires: it waits until it shows
		assert_eq!( Com_UnsureNow( &unsureSend_t { txid: "abc".to_string(), expiry: 0 }, &[], u32::MAX ), unsureNow_t::UNSURE_WAITING );
	}

	#[test]
	fn only_ids_laurel_makes_are_accepted() {
		assert!( O_CheckId( &Com_RandomHex( REQUEST_ID_BYTES ) ).is_ok() );
		for bad in [ "", "../wallets", r"..\wallets", "/etc", r"C:\Users", "0123456789abcdeg", "0123456789abcde", "0123456789abcdef0", "é123456789abcde", "0123456789ab/../" ] {
			assert!( matches!( O_CheckId( bad ), Err( werr_t::WERR_OFFLINE_FILE ) ), "{bad:?} was accepted" );
		}
	}

	#[test]
	fn a_signed_payment_pays_exactly_what_was_asked() {
		let asked = [ Asked( 'o', 500, Some( "rent" ) ) ];
		assert!( Com_CheckSigned( &asked, &[ Found( 'o', 500, Some( "rent" ), false ), Found( 'o', 480, None, true ) ], 1_000, 20 ).is_ok() );

		let refused = |found: &[ found_t ], spent: u64| Com_CheckSigned( &asked, found, spent, 20 ).unwrap_err();
		assert!( matches!( refused( &[ Found( 'o', 501, Some( "rent" ), false ), Found( 'o', 479, None, true ) ], 1_000 ), werr_t::WERR_OFFLINE_MISMATCH ) );
		assert!( matches!( refused( &[ Found( 's', 500, Some( "rent" ), false ), Found( 'o', 480, None, true ) ], 1_000 ), werr_t::WERR_OFFLINE_MISMATCH ), "another receiver" );
		assert!( matches!( refused( &[ Found( 'o', 500, Some( "pay me" ), false ), Found( 'o', 480, None, true ) ], 1_000 ), werr_t::WERR_OFFLINE_MISMATCH ), "another memo" );
		assert!( matches!( refused( &[ Found( 'o', 980, None, true ) ], 1_000 ), werr_t::WERR_OFFLINE_MISMATCH ), "not paid at all" );
		assert!( matches!( refused( &[ Found( 'o', 500, Some( "rent" ), false ), Found( 'p', 100, None, false ), Found( 'o', 380, None, true ) ], 1_000 ), werr_t::WERR_OFFLINE_MISMATCH ), "paid someone more" );
		assert!( matches!( refused( &[ Found( 'o', 500, Some( "rent" ), false ), Found( 'o', 380, None, true ) ], 1_000 ), werr_t::WERR_OFFLINE_HIDDEN ), "100 went where the viewing key can't see" );
		assert!( matches!( refused( &[ Found( 'o', 500, Some( "rent" ), false ), Found( 'o', 480, None, true ) ], 990 ), werr_t::WERR_OFFLINE_HIDDEN ), "a fee other than the one reviewed" );
	}

	// several payments to one address, each once; a payment without a memo matches an empty one
	#[test]
	fn each_payment_is_made_once() {
		let asked = [ Asked( 'o', 5, None ), Asked( 'o', 5, None ) ];
		assert!( Com_CheckSigned( &asked, &[ Found( 'o', 5, None, false ), Found( 'o', 5, None, false ) ], 12, 2 ).is_ok() );
		assert!( Com_CheckSigned( &asked, &[ Found( 'o', 5, None, false ), Found( 'o', 5, None, true ) ], 12, 2 ).is_err(), "one of them is change, not a payment" );
	}

	/*
	==================
	a_file_is_ours_whole_and_of_its_kind

	Read back as written; another kind, a newer format, or a body changed
	in copying (its hash) are refused (12, 10)
	==================
	*/
	#[test]
	fn a_file_is_ours_whole_and_of_its_kind() {
		let raw = Com_Wrap( SIGNED_KIND, &signedBody_t { requestId: "r".into(), network: network_t::NET_TESTNET, txs: vec![], made: 1 } ).unwrap();
		let back: signedBody_t = Com_Unwrap( &raw, SIGNED_KIND ).unwrap();
		assert_eq!( back.requestId, "r" );
		assert!( matches!( Com_Unwrap::< signedBody_t >( &raw, REQUEST_KIND ), Err( werr_t::WERR_OFFLINE_FILE ) ) );

		let mut env: envelope_t = serde_json::from_slice( &raw ).unwrap();
		env.body = env.body.replace( "\"r\"", "\"x\"" );
		assert!( matches!( Com_Unwrap::< signedBody_t >( &serde_json::to_vec( &env ).unwrap(), SIGNED_KIND ), Err( werr_t::WERR_OFFLINE_FILE ) ), "changed after hashing" );
		env.format = FORMAT + 1;
		env.sum = Com_Sum( &env.body );
		assert!( matches!( Com_Unwrap::< signedBody_t >( &serde_json::to_vec( &env ).unwrap(), SIGNED_KIND ), Err( werr_t::WERR_OFFLINE_NEWER ) ) );
		assert!( Com_Unwrap::< signedBody_t >( b"not json", SIGNED_KIND ).is_err() );
	}
}
