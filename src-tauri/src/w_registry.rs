/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_registry.rs -- the open wallets: finding one, installing one, its names
// and what each kind of wallet may do

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::RwLock;
use zingolib::lightclient::LightClient;
use zip32::AccountId;

use crate::w_balance::W_Balances;
use crate::w_engine::*;
use crate::w_local::*;
use crate::w_main::{ Com_CleanName, Com_NextSeq };
use crate::w_net::*;
use crate::w_persist::{ W_StartSaver, W_WriteMeta };
use crate::w_vault::*;

/*
==================
W_Slot

Finds a wallet and lets go of the registry at once, so a slow wallet
never holds up the others
==================
*/
pub async fn W_Slot( id: &str ) -> wresult_t< slotRef_t > {
	w_registry.read().await.slots.get( id ).cloned().ok_or( werr_t::WERR_NO_WALLET )
}

/*
==================
W_Slots

Every open wallet's id and slot, the registry let go at once: whatever
is read from each slot next waits on that slot only
==================
*/
pub async fn W_Slots() -> Vec< ( String, slotRef_t ) > {
	w_registry.read().await.slots.iter().map( |( id, s )| ( id.clone(), s.clone() ) ).collect()
}

/*
==================
W_Forget

Start Over (W_ForgetAll): every wallet is closed by now; the registry as
at start, network and all, and the ones that couldn't be opened
==================
*/
pub async fn W_Forget() {
	*w_registry.write().await = W_NoWallets();
	w_failed.lock().unwrap().clear();
}

/*
==================
W_Ids

Every open wallet, oldest first
==================
*/
pub async fn W_Ids() -> Vec< String > {
	let slots = W_Slots().await;
	let mut dated = vec![];

	for ( id, slot ) in slots {
		dated.push( ( slot.read().await.meta.created, id ) );
	}
	dated.sort();
	dated.into_iter().map( |( _, id )| id ).collect()
}

/*
==================
W_Install

Adds an opened wallet to the registry and starts its saver. Refused once
a lock has begun (W1-02): the check and the insert happen under the
registry's write lock, and W_Lock lists the wallets to close only after
V_BeginLock, so a wallet is either refused here or closed by the lock.
Its sealed files stay: the next unlock opens it.
==================
*/
pub async fn W_Install( id: String, dir: PathBuf, client: LightClient, meta: meta_t ) -> wresult_t< slotRef_t > {
	let wallet = E_WalletOf( &client );
	let cache = Arc::new( std::sync::Mutex::new( slotCache_t::default() ) );

	// its sync hasn't started: the one moment the engine's lock is surely free
	crate::w_addr::W_PrimeCache( &cache, meta.accounts.len() as u32, &mut *E_Idle( &wallet ).await );

	let slot = Arc::new( RwLock::new( slot_t {
		client:		Arc::new( tokio::sync::Mutex::new( client ) ),
		wallet:		wallet.clone(),
		meta:		meta,
		dir:		dir,
		saveLock:	Arc::new( tokio::sync::Mutex::new( () ) ),
		saveError:	std::sync::Mutex::new( None ),
		syncError:	std::sync::Mutex::new( None ),
		retry:		std::sync::Mutex::new( retry_t::default() ),
		cache:		cache,
		saver:		std::sync::Mutex::new( None ),
		stop:		Arc::new( tokio::sync::Notify::new() ),
	} ) );

	{
		let mut wl = w_registry.write().await;
		if ( !W_Usable() ) {
			return Err( werr_t::WERR_LOCKED );		// the client drops here, never synced
		}
		wl.slots.insert( id.clone(), slot.clone() );
	}
	W_StartSaver( id, slot.clone() ).await;
	Ok( slot )
}

#[cfg( test )]
tokio::task_local! {
	// a test's own answer to "is the vault usable": the real one is global, and a
	// lock begun by one test would refuse every other test's wallets
	pub static W_TEST_USABLE: bool;
}

pub fn W_Usable() -> bool {
	// in tests a lock is one test's own: the vault's lock test must not refuse another test's wallet
	#[cfg( test )]
	return W_TEST_USABLE.try_with( |u| *u ).unwrap_or_else( |_| V_IsUnlocked() );
	#[cfg( not( test ) )]
	V_IsUsable()
}



/*
==================
W_UpdateMeta

The one way a wallet's names or flags change: edit, then save
==================
*/
async fn W_UpdateMeta< F >( id: &str, edit: F ) -> wresult_t< () >
where
	F: FnOnce( &mut meta_t ) -> wresult_t< () >,
{
	let slot = W_Slot( id ).await?;
	let mut s = slot.write().await;

	edit( &mut s.meta )?;
	W_WriteMeta( &s.dir, &s.meta )
}

pub async fn W_RenameWallet( id: &str, name: String ) -> wresult_t< () > {
	let name = Com_CleanName( &name )?;
	W_UpdateMeta( id, |meta| { meta.name = name; Ok( () ) } ).await
}

pub async fn W_RenameAccount( id: &str, index: u32, name: String ) -> wresult_t< () > {
	let name = Com_CleanName( &name )?;
	W_UpdateMeta( id, |meta| {
		*meta.accounts.get_mut( index as usize ).ok_or( werr_t::WERR_NO_ACCOUNT )? = name;
		Ok( () )
	} ).await
}

pub async fn W_MarkBackedUp( id: &str, words: &[ backupWord_t ], passphrase: Option< &str > ) -> wresult_t< () > {
	// marked only for someone who has the words: a wallet marked backed up is then removed as safe (W1-01)
	let client = W_Slot( id ).await?.read().await.client.clone();
	if ( !E_PhraseMatches( &*E_Client( &client ).await?, words, passphrase ).await? ) {
		return Err( werr_t::WERR_CONFIRM );
	}
	W_UpdateMeta( id, |meta| { meta.backedUp = true; Ok( () ) } ).await
}



/*
==================
W_Recovery

The phrase, its passphrase and the birthday needed to rebuild a wallet
anywhere, for someone just asked who they are (present_t)
==================
*/
pub async fn W_Recovery( id: &str, present: &present_t ) -> wresult_t< recovery_t > {
	let net = w_registry.read().await.network;
	let info = {
		let client = W_Slot( id ).await?.read().await.client.clone();
		E_RecoveryInfo( &*E_Client( &client ).await?, present ).await?.ok_or_else( || {
			werr_t::WERR_ENGINE( "This wallet was added with a viewing key, so it has no recovery phrase.".to_string() )
		} )?
	};

	// people remember dates, not block heights; unknown stays unknown (a
	// restored wallet's birthday is not "today" because the server is down)
	let birthdayTime = W_BlockTime( net, info.birthday ).await.ok();

	Ok( recovery_t {
		seedPhrase:		info.seed_phrase,
		passphrase:		Some( info.passphrase ).filter( |p| !p.is_empty() ),		// BIP-39: empty is none
		birthday:		info.birthday,
		birthdayTime:	birthdayTime,
	} )
}

/*
==================
W_Engine

A wallet's account and its engine handles, with the slot let go: the
slow part that follows (a proposal, a send) holds nothing anyone reads
==================
*/
pub async fn W_Engine( id: &str, account: u32 ) -> wresult_t< ( AccountId, clientRef_t, walletRef_t ) > {
	let slot = W_Slot( id ).await?;
	let s = slot.read().await;
	Ok( ( W_AccountOf( &s, account )?, s.client.clone(), s.wallet.clone() ) )
}

/*
==================
W_Paying

Everything a payment (a send, a shield, a move) needs before anything is
built, in one order: the intent taken first, so one review can be
attempted once whatever happens next; the wallet near the tip, so the
payment can't be built on an old view of the chain; then the account and
its engine handles, and the quote the intent was made for (Com_StillSeen)
==================
*/
pub async fn W_Paying( id: &str, account: u32, intent: &str ) -> wresult_t< ( slotRef_t, AccountId, clientRef_t, String ) > {
	let quoted = E_TakeIntent( intent, id, account )?;
	let slot = W_Slot( id ).await?;
	W_Allow( slot.read().await.meta.kind, walletAct_t::WA_SPEND )?;		// signed here; a view-only wallet's payment is signed elsewhere
	crate::w_sync::Sync_RequireCaughtUp( &slot ).await?;
	let ( accountId, client, _ ) = W_Engine( id, account ).await?;
	Ok( ( slot, accountId, client, quoted ) )
}

/*
==================
W_Allow

What each kind of wallet may be asked to do, decided here and nowhere
else, with the reason when not. A phrase wallet does everything. One
that only views receives, and nothing more (its payments are signed on
another device: w_offline.rs). One from zcashd keys spends its money
out, but receives nothing and moves nothing within: its private pool
here is backed by no phrase. The engine refuses by this; the ui offers
by W_Can, the same answers, so no button offers what would be refused.
==================
*/
pub fn W_Allow( kind: walletKind_t, act: walletAct_t ) -> wresult_t< () > {
	use walletAct_t::*;
	use walletKind_t::*;
	match ( kind, act ) {
		( WK_SEED, _ )							=> Ok( () ),
		( WK_VIEWONLY, WA_RECEIVE )				=> Ok( () ),
		( WK_VIEWONLY, WA_SPEND )				=> Err( werr_t::WERR_VIEWONLY_SPEND ),
		( WK_VIEWONLY, WA_MOVE_WITHIN )			=> Err( werr_t::WERR_VIEWONLY_MOVE ),
		( WK_VIEWONLY, WA_ADD_ACCOUNT )			=> Err( werr_t::WERR_VIEWONLY ),
		( WK_KEY, WA_SPEND )					=> Ok( () ),
		( WK_KEY, WA_RECEIVE )					=> Err( werr_t::WERR_KEY_WALLET_RECEIVE ),
		( WK_KEY, WA_MOVE_WITHIN )				=> Err( werr_t::WERR_KEY_WALLET_MOVE ),
		( WK_KEY, WA_ADD_ACCOUNT )				=> Err( werr_t::WERR_KEY_WALLET_ACCOUNTS ),
	}
}

pub fn W_Can( kind: walletKind_t ) -> walletCan_t {
	walletCan_t {
		spend:		W_Allow( kind, walletAct_t::WA_SPEND ).is_ok(),
		receive:	W_Allow( kind, walletAct_t::WA_RECEIVE ).is_ok(),
		moveWithin:	W_Allow( kind, walletAct_t::WA_MOVE_WITHIN ).is_ok(),
		addAccount:	W_Allow( kind, walletAct_t::WA_ADD_ACCOUNT ).is_ok(),
	}
}

// W_Allow, for an open wallet by its id
pub async fn W_Allowed( id: &str, act: walletAct_t ) -> wresult_t< () > {
	W_Allow( W_Slot( id ).await?.read().await.meta.kind, act )
}

/*
==================
W_AccountOf

A wallet's account by index, if it has one
==================
*/
pub fn W_AccountOf( s: &slot_t, account: u32 ) -> wresult_t< AccountId > {
	if ( account as usize >= s.meta.accounts.len() ) {
		return Err( werr_t::WERR_NO_ACCOUNT );
	}
	AccountId::try_from( account ).map_err( |_| werr_t::WERR_NO_ACCOUNT )
}

/*
==================
W_Summary

One wallet as the switcher shows it. The seq is taken before anything
is read: a snapshot that started later is never older than this one.
==================
*/
#[allow( clippy::await_holding_invalid_type, reason = "the only await under the slot is Sync_ProgressOf, which reads memory, never the network" )]
pub async fn W_Summary( id: &str ) -> wresult_t< walletSummary_t > {
	let slot = W_Slot( id ).await?;
	let words = slot.read().await.cache.lock().unwrap().wordsPrint;
	let sameWords = W_SameWords( id, words ).await;
	let s = slot.read().await;
	let seq = Com_NextSeq();
	let balances = W_Balances( &s );
	let saveError = s.saveError.lock().unwrap().clone();

	Ok( walletSummary_t {
		seq:		seq,
		id:			id.to_string(),
		name:		s.meta.name.clone(),
		kind:		s.meta.kind,
		can:		W_Can( s.meta.kind ),
		backedUp:	s.meta.backedUp,
		accounts:	s.meta.accounts.iter().enumerate().map( |( i, name )| accountSummary_t {
			index:		i as u32,
			name:		name.clone(),
			balance:	balances.get( i ).copied().unwrap_or_default(),
		} ).collect(),
		progress:	crate::w_sync::Sync_ProgressOf( &s, None ).await,
		saveError:	saveError,
		sameWords:	sameWords,
	} )
}

/*
==================
W_SameWords

The other open wallets made from these recovery words (W_WordsPrint):
one paper holds the words of all of them, and each passphrase is its
own. Manage Wallets says so, so neither backup is thought of as spare.
==================
*/
async fn W_SameWords( id: &str, words: Option< [ u8; 32 ] > ) -> Vec< String > {
	let Some( words ) = words else {
		return Vec::new();
	};
	let slots = W_Slots().await;
	let mut same = Vec::new();
	for ( other, slot ) in slots {
		if ( other != id && slot.read().await.cache.lock().unwrap().wordsPrint == Some( words ) ) {
			same.push( other );
		}
	}
	same
}

/*
==================
W_List

Every open wallet, oldest first, and every wallet on disk that couldn't
be opened, with the reason
==================
*/
pub async fn W_List() -> walletList_t {
	let mut wallets = vec![];

	for id in W_Ids().await {
		if let Ok( summary ) = W_Summary( &id ).await {
			wallets.push( summary );
		}
	}
	let failed = w_failed.lock().unwrap().clone();

	// every wallet folder on disk either opened or failed, so nothing in
	// either list means there is no wallet at all: the only first run
	walletList_t {
		firstRun:	wallets.is_empty() && failed.is_empty(),
		wallets:	wallets,
		failed:		failed,
	}
}
