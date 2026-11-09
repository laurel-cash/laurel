/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_engine.rs -- the only door to the sync engine's wallet
//
// While it syncs, the engine (pepper-sync) holds its wallet lock across
// network requests: for as long as the network takes. Anything that waits
// on that lock without a limit can wait forever, and did ("Getting your
// address..." that never finished; then showing the recovery phrase,
// shielding and adding an account, all the same bug).
//
// So the lock is reachable only through here, in four forms, each saying
// how it waits:
//
//   E_TryRead			never waits; None while the engine is busy
//   E_Read / E_Write	wait at most ENGINE_WAIT_SECS, then WERR_SYNC_BUSY
//   E_Idle				waits without limit: only while sync isn't running
//   E_WriteWhenFree	waits without limit: background work nobody waits on
//
// and engine calls that take the lock inside themselves (propose, send,
// clear, migrate, rescan) take a fenced_t, which only E_Fenced makes:
// sync paused and its batch over, within ENGINE_WAIT_SECS. The type is the
// limit. A "wait, let go, then call" once raced the next batch, and the
// Shield sheet spun on "Preparing..." for as long as sync kept winning.
//
// clippy.toml bans LightClient::wallet and every engine method that locks
// or drives sync, everywhere else; `npm run check` fails on a new one.
#![allow( clippy::disallowed_methods )]

use std::collections::HashMap;
use std::future::Future;
use std::sync::LazyLock;
use std::time::{ Duration, Instant };

use tokio::sync::{ OwnedMutexGuard, RwLockReadGuard, RwLockWriteGuard };
use zcash_address::ZcashAddress;
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::Zatoshis;
use zcash_protocol::PoolType;
use pepper_sync::sync::{ ScanPriority, SyncStatus };
use pepper_sync::wallet::SyncMode;
use zingolib::data::PollReport;
use zip321::{ Payment, TransactionRequest };
use zingolib::lightclient::LightClient;
use zingolib::wallet::{ LightWallet, RecoveryInfo };
use zip32::AccountId;

use crate::w_local::*;
use crate::w_net::engineResult_t;

// how long a person's request may wait for the engine's current sync step
#[cfg( not( test ) )]
pub const ENGINE_WAIT_SECS: u64 = 15;
#[cfg( test )]
pub const ENGINE_WAIT_SECS: u64 = 2;		// the same limit, without making every test wait it out

// how long stopping the engine may take before the caller moves on
const STOP_WAIT_SECS: u64 = 30;

// closing Laurel: every engine stops (at most STOP_WAIT_SECS, all at once),
// then every wallet is written. The whole is built from its parts: it was
// once a separate 10 s against a 30 s stop, and the last save lost the race
const SHUTDOWN_SAVE_SECS: u64		= 15;
pub const SHUTDOWN_BUDGET_SECS: u64	= STOP_WAIT_SECS + SHUTDOWN_SAVE_SECS;


/*
==================
Com_Within

A wait that ends. What the person asked for happens within the limit or
says why not. Only for futures that are safe to abandon while waiting.
==================
*/
pub async fn Com_Within< T >( secs: u64, fut: impl Future< Output = T > ) -> wresult_t< T > {
	tokio::time::timeout( Duration::from_secs( secs ), fut ).await.map_err( |_| werr_t::WERR_SYNC_BUSY )
}

/*
=========================================================================

THE LOCK

=========================================================================
*/

// the wallet handle, kept in the slot so reads never need the client
pub fn E_WalletOf( c: &LightClient ) -> walletRef_t {
	c.wallet().clone()
}

pub fn E_TryRead( wallet: &walletRef_t ) -> Option< RwLockReadGuard< '_, LightWallet > > {
	wallet.try_read().ok()
}

pub async fn E_Read( wallet: &walletRef_t ) -> wresult_t< RwLockReadGuard< '_, LightWallet > > {
	Com_Within( ENGINE_WAIT_SECS, wallet.read() ).await
}

pub async fn E_Write( wallet: &walletRef_t ) -> wresult_t< RwLockWriteGuard< '_, LightWallet > > {
	Com_Within( ENGINE_WAIT_SECS, wallet.write() ).await
}

/*
==================
E_Idle

For a wallet whose sync hasn't started (opening, creating, tests), when
nothing else can hold the lock
==================
*/
pub async fn E_Idle( wallet: &walletRef_t ) -> RwLockWriteGuard< '_, LightWallet > {
	wallet.write().await
}

/*
==================
E_WriteWhenFree

For the saver: it waits out any batch, and no person waits on it
==================
*/
pub async fn E_WriteWhenFree( wallet: &walletRef_t ) -> RwLockWriteGuard< '_, LightWallet > {
	wallet.write().await
}

/*
=========================================================================

THE CLIENT

=========================================================================
*/

/*
==================
E_Client / E_ClientWhenFree / E_TryClient

The client for an engine call. A person's request waits at most
ENGINE_WAIT_SECS (another send may hold it); background work waits its
turn; a read that only wants a quick look doesn't wait at all.
==================
*/
pub async fn E_Client( c: &clientRef_t ) -> wresult_t< OwnedMutexGuard< LightClient > > {
	Com_Within( ENGINE_WAIT_SECS, c.clone().lock_owned() ).await
}

pub async fn E_ClientWhenFree( c: &clientRef_t ) -> OwnedMutexGuard< LightClient > {
	c.clone().lock_owned().await
}

pub fn E_TryClient( c: &clientRef_t ) -> Option< OwnedMutexGuard< LightClient > > {
	c.clone().try_lock_owned().ok()
}

/*
=========================================================================

ENGINE CALLS THAT TAKE THE LOCK THEMSELVES

=========================================================================
*/

// a client whose wallet nobody else will take: see E_Fenced
pub struct fenced_t< 'a > {
	c:	&'a mut LightClient,
}

// what a fence waits for, besides the wallet itself
#[derive( Clone, Copy, PartialEq, Eq, Debug )]
pub enum fence_t {
	FENCE_WALLET,		// the wallet free: enough for a rescan
	FENCE_SCANNED,		// and every block scanned: the engine spends a coin only when no
						// unscanned range above it could hide its spend (spend_horizon)
}

/*
==================
E_Fenced

Pauses sync (a flag, no lock) and waits for its current batch to let go
of the wallet; with sync paused no batch takes it back, so the engine
calls inside get it at once. For a payment it must also be fully scanned:
paused mid-scan, the newest range stays unscanned and every coin below it
is withheld (a shield once found 0 of 0.10 that way). Then sync is let go
to finish and the fence looks again, all within ENGINE_WAIT_SECS.

Sync resumes when this ends, however it ends (the guard resumes it on
drop); a sync the person paused stays paused.
==================
*/
pub async fn E_Fenced< T >( c: &mut LightClient, need: fence_t, work: impl AsyncFnOnce( &mut fenced_t< '_ > ) -> wresult_t< T > ) -> wresult_t< T > {
	let deadline = tokio::time::Instant::now() + Duration::from_secs( ENGINE_WAIT_SECS );
	let mut status = c.subscribe_sync_status();
	loop {
		let pause = c.pause_sync_scoped().engine()?;
		let scanned = {
			let wallet = tokio::time::timeout_at( deadline, c.wallet().write() ).await.map_err( |_| werr_t::WERR_SYNC_BUSY )?;
			Com_AllScanned( &wallet )
		};
		if ( need == fence_t::FENCE_WALLET || scanned ) {
			let result = work( &mut fenced_t { c: c } ).await;
			drop( pause );
			return result;
		}

		// a block still waits to be scanned: let sync scan it, then look again
		drop( pause );
		if ( c.sync_mode() != SyncMode::Running ) {
			return Err( werr_t::WERR_CATCHING_UP );		// nothing is scanning it
		}
		status.borrow_and_update();
		let finished = tokio::time::timeout_at( deadline, async {
			while ( status.changed().await.is_ok() ) {
				if ( status.borrow().as_ref().is_some_and( SyncStatus::is_complete ) ) {
					return;
				}
			}
		} ).await;
		if ( finished.is_err() ) {
			return Err( werr_t::WERR_CATCHING_UP );
		}
	}
}

// every range of the chain the wallet covers has been scanned
fn Com_AllScanned( wallet: &LightWallet ) -> bool {
	wallet.sync_state.scan_ranges().iter().all( |r| r.priority() == ScanPriority::Scanned )
}

/*
==================
E_WalletFacts

What kind of wallet the engine holds, and how many accounts, from its
keys: a phrase is a seed wallet; spending keys without one are imported
keys (zcashd's); anything else only views. The meta file's words are
never the truth about keys.
==================
*/
pub async fn E_WalletFacts( c: &LightClient ) -> wresult_t< ( walletKind_t, u32 ) > {
	use zingolib::wallet::keys::unified::UnifiedKeyStore;

	let handle = E_WalletOf( c );
	let w = E_Read( &handle ).await?;
	let kind = match ( w.mnemonic_phrase().is_some(), w.unified_key_store.values().next() ) {
		( true, _ )									=> walletKind_t::WK_SEED,
		( false, Some( UnifiedKeyStore::Spend( _ ) ) )	=> walletKind_t::WK_KEY,
		( false, _ )									=> walletKind_t::WK_VIEWONLY,
	};
	Ok( ( kind, ( w.unified_key_store.len() as u32 ).max( 1 ) ) )
}

// the phrase itself: only for someone just asked (V_Confirm)
pub async fn E_RecoveryInfo( c: &LightClient, _present: &crate::w_vault::present_t ) -> wresult_t< Option< RecoveryInfo > > {
	Com_Within( ENGINE_WAIT_SECS, c.recovery_info() ).await
}

/*
==================
E_PhraseMatches / Com_BackupMatches

Whether a backup check's answers are this wallet's: at least a third of
the words, each at its own place, and the passphrase if it has one. The
phrase is read here and never handed out: proof of a backup is knowing
the words, so marking a wallet backed up takes them (W1-01), and nobody
at an unlocked Laurel can mark one, then remove it as safe
==================
*/
#[allow( clippy::disallowed_methods, reason = "reads the phrase to compare it, never returns it" )]
pub async fn E_PhraseMatches( c: &LightClient, words: &[ backupWord_t ], passphrase: Option< &str > ) -> wresult_t< bool > {
	let Some( info ) = Com_Within( ENGINE_WAIT_SECS, c.recovery_info() ).await? else {
		return Ok( false );		// no phrase: a viewing-key or key wallet has nothing to back up this way
	};
	let phrase = zeroize::Zeroizing::new( info.seed_phrase );
	let theirs = zeroize::Zeroizing::new( info.passphrase );
	Ok( Com_BackupMatches( &phrase, &theirs, words, passphrase ) )
}

pub fn Com_BackupMatches( phrase: &str, passphrase: &str, words: &[ backupWord_t ], typed: Option< &str > ) -> bool {
	let all: Vec< &str > = phrase.split_whitespace().collect();
	let mut seen = std::collections::BTreeSet::new();
	!all.is_empty()
		&& words.len() >= all.len().div_ceil( BACKUP_CHECK_SHARE )
		&& words.iter().all( |w| seen.insert( w.pos ) && all.get( w.pos as usize ) == Some( &w.word.as_str() ) )
		&& ( passphrase.is_empty() || typed == Some( passphrase ) )
}

// the account is created in one synchronous step once the lock is had, so abandoning the wait is safe
pub async fn E_CreateAccount( c: &mut LightClient ) -> wresult_t< () > {
	Com_Within( ENGINE_WAIT_SECS, c.create_account() ).await?.engine()
}

/*
==================
E_ProposeShield
==================
*/
pub async fn E_ProposeShield( f: &mut fenced_t< '_ >, account: AccountId ) -> wresult_t< shieldQuote_t > {
	let proposal = f.c.propose_shield( account ).await.engine()?;

	// shielding is always one step; its change is what lands in the private pool
	let step = proposal.steps().first();
	let amount: u64 = step.balance().proposed_change().iter().map( |x| x.value().into_u64() ).sum();
	let fee = step.balance().fee_required().into_u64();
	Ok( shieldQuote_t {
		amount:		amount,
		fee:		fee,
		feeNote:	crate::w_send::Com_FeeNote( fee, amount, step.transparent_inputs().len() as u32 ),
	} )
}

/*
==================
E_ProposeSend

Payments of exact amounts, to one address or several in one transaction,
or everything to one address; from one pool or any. Returns what the
proposal does: amount (every payment together), fee, pools spent, steps.
==================
*/
pub enum sendWhat_t {
	PAY( Vec< ( ZcashAddress, u64, Option< MemoBytes > ) > ),
	ALL( ZcashAddress, Option< MemoBytes > ),
}

pub async fn E_ProposeSend(
	f:			&mut fenced_t< '_ >,
	account:	AccountId,
	what:		sendWhat_t,
	from:		Option< PoolType >,
) -> wresult_t< proposed_t > {
	// what was asked for, when amounts were: the payments themselves, whatever steps pay them
	let mut asked = None;
	let proposal = match what {
		sendWhat_t::PAY( pays ) => {
			asked = Some( pays.iter().map( |( _, z, _ )| *z ).sum::< u64 >() );
			let mut payments = vec![];
			for ( to, z, memo ) in pays {
				let amount = Zatoshis::from_u64( z ).map_err( |_| werr_t::WERR_NO_AMOUNT )?;
				payments.push( Payment::new( to, Some( amount ), memo, None, None, vec![] ).map_err( |_| werr_t::WERR_MEMO_PUBLIC )? );
			}
			let request = TransactionRequest::new( payments ).engine()?;
			f.c.propose_send_from( request, account, from ).await
		}
		sendWhat_t::ALL( to, memo ) => f.c.propose_send_all_from( to, memo, account, from ).await,
	}.engine()?;		// "not enough" in whatever shape: Com_Classify

	let mut pools = std::collections::BTreeSet::new();
	let mut fee = 0;
	let mut coins = 0;
	for step in proposal.steps().iter() {
		fee += step.balance().fee_required().into_u64();
		coins += step.transparent_inputs().len() as u32;
		if ( !step.transparent_inputs().is_empty() ) {
			pools.insert( PoolType::Transparent );
		}
		if let Some( inputs ) = step.shielded_inputs() {
			coins += inputs.notes().len() as u32;
			for note in inputs.notes().iter() {
				pools.insert( PoolType::Shielded( note.note().pool() ) );
			}
		}
	}
	// everything to one: what the last step pays (an exchange-only address takes two steps)
	let amount: u64 = asked.unwrap_or_else( || proposal.steps().last().transaction_request().payments().values()
		.filter_map( |p| p.amount() )
		.map( |z| z.into_u64() )
		.sum() );
	if ( amount == 0 ) {
		// never shown, never sent: a payment of nothing is not what anyone asked for
		return Err( werr_t::WERR_ENGINE( "the engine proposed a payment without an amount".to_string() ) );
	}

	Ok( proposed_t {
		amount:	amount,
		fee:	fee,
		pools:	pools.into_iter().collect(),
		steps:	proposal.steps().len() as u32,
		coins:	coins,
	} )
}

// what a payment's proposal would do
pub struct proposed_t {
	pub amount:	u64,
	pub fee:	u64,
	pub pools:	Vec< PoolType >,
	pub steps:	u32,
	pub coins:	u32,		// notes and coins it spends: each one costs the fee a little
}

/*
==================
E_PlanMigration / E_MigrateNow / E_MigrationStatus

Orchard to Ironwood, all at once (ZIP 318's immediate path). The plan is
pure; the move pauses sync itself for as long as it builds and sends.
==================
*/
pub async fn E_PlanMigration( f: &mut fenced_t< '_ >, account: AccountId ) -> wresult_t< migratePlan_t > {
	let plan = f.c.plan_immediate_migration( account ).await.engine()?;
	if ( plan.is_empty() ) {
		return Err( werr_t::WERR_NOTHING_TO_MIGRATE );
	}
	Ok( migratePlan_t {
		transactions:	plan.transactions.len() as u32,
		amount:			plan.migrated,
		fee:			plan.fee,
		residual:		plan.residual,
	} )
}

pub async fn E_MigrateNow( f: &mut fenced_t< '_ >, account: AccountId ) -> wresult_t< Vec< String > > {
	let done = f.c.quick_immediate_migration( account, true ).await.engine()?;
	Ok( done.txids.iter().map( |t| t.to_string() ).collect() )
}

pub async fn E_MigrationStatus( c: &LightClient ) -> wresult_t< migrationStatus_t > {
	let s = Com_Within( ENGINE_WAIT_SECS, c.migration_status() ).await?.engine()?;
	Ok( migrationStatus_t {
		scheduled:		s.phase.is_some(),
		partsTotal:		s.parts_total,
		partsConfirmed:	s.parts_confirmed,
		valueTotal:		s.value_total,
		valueMigrated:	s.value_migrated,
	} )
}

// what building again found: sent, or different numbers for the person to see
pub enum confirmed_t< Q > {
	SENT( String ),
	CHANGED( Q ),
}

/*
==================
E_Quote / E_SendIfSeen

Quote, then confirm, for any payment (w_shield.rs says why). E_Quote
builds and always clears: nothing is kept while the person reads.
E_SendIfSeen builds again and sends only if the result is what the
person saw; otherwise it clears and returns the new numbers. Once sent,
the wallet is written while the sender still holds the engine
(W_SaveAfterSend): a payment known only in memory could be built again
after a crash.
==================
*/
pub async fn E_Quote< Q >( f: &mut fenced_t< '_ >, build: impl AsyncFnOnce( &mut fenced_t< '_ > ) -> wresult_t< Q > ) -> wresult_t< Q > {
	let quote = build( f ).await;
	E_ClearProposal( f ).await;
	quote
}

pub async fn E_SendIfSeen< Q: PartialEq >( f: &mut fenced_t< '_ >, slot: &slotRef_t, seen: &Q, build: impl AsyncFnOnce( &mut fenced_t< '_ > ) -> wresult_t< Q > ) -> wresult_t< confirmed_t< Q > > {
	let now = match build( f ).await {
		Ok( q ) => q,
		Err( e ) => {
			E_ClearProposal( f ).await;
			return Err( e );
		}
	};
	if ( now != *seen ) {
		E_ClearProposal( f ).await;
		return Ok( confirmed_t::CHANGED( now ) );
	}
	let txid = E_SendProposal( f, slot ).await?;
	crate::w_main::W_SaveAfterSend( slot ).await;
	Ok( confirmed_t::SENT( txid ) )
}

/*
==================
E_SendProposal

The reviewed proposal signed, the wallet written with it, and only then
sent. Signed and sent in one engine call, a stop while the bytes were
leaving lost the signed payment from disk: on the next start its coins
looked free, and a new payment could spend others while the first went
through anyway (security review A-03). A write that fails sends nothing,
and the payment is failed: no byte of it left. A send that may have gone
out stays as it is, Calculated, and goes out again once the wallet has
caught up (Sync_SendUnsent): the same bytes, so never a second payment
==================
*/
pub async fn E_SendProposal( f: &mut fenced_t< '_ >, slot: &slotRef_t ) -> wresult_t< String > {
	let txids = f.c.calculate_stored_proposal().await.engine()?;
	if let Err( e ) = crate::w_main::W_SaveSlot( slot ).await {
		// not sent, and not failed either: on Android and unix a write can land
		// and still report failing (the folder's flush), and the file would then
		// hold it Calculated. It waits, and goes out once a save works
		// (Sync_SendUnsent saves first). Said as that, never as a plain save
		// error: one to try again would pay a second time from other coins
		log::warn!( "E_SendProposal: signed, kept to send once the wallet can be written: {}", e.LogText() );
		E_ResendSoon( slot ).await;
		return Err( werr_t::WERR_SEND_QUEUED( txids.first().to_string() ) );
	}
	let first = txids.first().to_string();
	if let Err( e ) = E_TransmitUnsent( f, txids ).await {
		if ( matches!( e, werr_t::WERR_SENT_UNSURE( _ ) ) ) {
			E_ResendSoon( slot ).await;
		}
		return Err( e );
	}
	Ok( first )
}

// the next catch-up sends what isn't known to be sent, this session too
async fn E_ResendSoon( slot: &slotRef_t ) {
	slot.read().await.cache.lock().unwrap().unsentNext = 0;
}

/*
==================
E_UnsentOf / E_TransmitUnsent

Payments the engine signed and holds as Calculated: not known to be
sent (a stop, or a send that may have gone out). Sending them again is
the only safe end (Sync_SendUnsent).
==================
*/
pub fn E_UnsentOf( w: &LightWallet ) -> Vec< zcash_protocol::TxId > {
	w.wallet_transactions.values()
		.filter( |t| crate::w_history::W_StateOf( t ) == txState_t::UNSENT )
		.map( |t| t.txid() )
		.collect()
}

#[allow( clippy::disallowed_methods, reason = "the one door to transmit_calculated, inside a fence" )]
pub async fn E_TransmitUnsent( f: &mut fenced_t< '_ >, txids: nonempty::NonEmpty< zcash_protocol::TxId > ) -> wresult_t< () > {
	f.c.transmit_calculated( txids ).await.engine().map( |_| () )
}

// a resend: what may already have gone out. A failure frees nothing (this
// call sending nothing proves nothing of an earlier one); they end
// confirmed, or failed by sync past their expiry
#[allow( clippy::disallowed_methods, reason = "the one door to retransmit_calculated, inside a fence" )]
pub async fn E_RetransmitUnsent( f: &mut fenced_t< '_ >, txids: nonempty::NonEmpty< zcash_protocol::TxId > ) -> wresult_t< () > {
	f.c.retransmit_calculated( txids ).await.engine().map( |_| () )
}

/*
==================
E_DroppedOf / E_RebroadcastPending

This wallet's own payments that went out and aren't mined yet, and
aren't past their expiry: what a node restart, a stall or an eviction
can drop from the mempool, after which nothing would send them again
and they'd sit pending until they expire (seen on testnet, 2026-11-06). Sending
the same bytes again is harmless: the txid is the same, so it pays once,
and a server that still holds it answers with a duplicate. Only those
that spend this wallet's coins: a payment someone is sending us shows
as pending too, and isn't ours to send.
==================
*/
pub fn E_DroppedOf( w: &LightWallet ) -> Vec< zcash_protocol::TxId > {
	use pepper_sync::wallet::{ IronwoodNote, OrchardNote, OutputInterface, SaplingNote, TransparentCoin };
	fn spenders< O: OutputInterface >( w: &LightWallet, ours: &mut std::collections::HashSet< zcash_protocol::TxId > ) {
		for t in w.wallet_transactions.values() {
			ours.extend( O::transaction_outputs( t ).iter().filter_map( |o| o.spending_transaction() ) );
		}
	}
	let mut ours = std::collections::HashSet::new();
	spenders::< TransparentCoin >( w, &mut ours );
	spenders::< SaplingNote >( w, &mut ours );
	spenders::< OrchardNote >( w, &mut ours );
	spenders::< IronwoodNote >( w, &mut ours );
	let scanned = w.sync_state.fully_scanned_height().map_or( 0, u32::from );
	w.wallet_transactions.values()
		.filter( |t| ours.contains( &t.txid() ) )
		.filter( |t| match crate::w_history::W_StateOf( t ) {
			txState_t::PENDING { expiresAt } => Com_BeforeExpiry( expiresAt, scanned ),
			_ => false,
		} )
		.map( |t| t.txid() )
		.collect()
}

// nodes refuse a transaction this close to its expiry (zcashd's and zebra's
// "tx-expiring-soon", TX_EXPIRING_SOON_THRESHOLD): sending it then is noise
pub const EXPIRING_SOON_BLOCKS: u32 = 3;

// a transaction with an expiry can be mined up to and at that height, and is
// taken until EXPIRING_SOON_BLOCKS before it; with none (0), it never expires
pub fn Com_BeforeExpiry( expiresAt: Option< u32 >, scanned: u32 ) -> bool {
	expiresAt.is_none_or( |e| scanned.saturating_add( 1 + EXPIRING_SOON_BLOCKS ) <= e )
}

// each on its own: one that can't go doesn't keep the others from going.
// Only logged: a failure here changes nothing, the next round tries again
#[allow( clippy::disallowed_methods, reason = "the one door to rebroadcast_pending, inside a fence" )]
pub async fn E_RebroadcastPending( f: &mut fenced_t< '_ >, txids: nonempty::NonEmpty< zcash_protocol::TxId > ) {
	for ( txid, sent ) in f.c.rebroadcast_pending( txids ).await {
		if let Err( e ) = sent.engine() {
			log::info!( "E_RebroadcastPending: {txid} not sent again: {}", e.LogText() );
		}
	}
}

pub async fn E_ClearProposal( f: &mut fenced_t< '_ > ) {
	f.c.clear_proposal().await;
}

/*
=========================================================================

PAYMENT INTENTS

E_Quote then E_SendIfSeen bind the numbers: what is sent is what was
shown. They don't bind the count. A Send that arrives twice with the
same quote (a click that got past the ui's guard, a call made again
after its answer was lost) finds the first payment's coins spent and
builds the same payment again from other coins, and the numbers match,
so it goes out too. So every quote is handed out under an intent: a
random id kept here until a payment is attempted under it. Sending
hands the intent back first, and takes it out of the table before
anything is built. One intent, one attempt; the second finds it gone
and is refused (WERR_PAYMENT_DONE), whatever else is true.

An intent also names the wallet and account it was quoted for, so an
approval can't be carried to another account.

=========================================================================
*/

const INTENT_MAX_AGE: Duration	= Duration::from_secs( 30 * 60 );	// a review left open longer than this is looked at again
const INTENT_MAX: usize			= 64;								// quotes never sent, before the oldest is forgotten

struct intent_t {
	wallet:		String,
	account:	u32,
	made:		Instant,
}

static e_intents: LazyLock< std::sync::Mutex< HashMap< String, intent_t > > > = LazyLock::new( Default::default );

/*
==================
E_Intend

Hands a quote out under a new intent
==================
*/
pub fn E_Intend< Q >( wallet: &str, account: u32, quote: Q ) -> quoted_t< Q > {
	let intent = crate::w_vault::Com_RandomHex( 16 );

	let mut all = e_intents.lock().unwrap();
	all.retain( |_, i| i.made.elapsed() < INTENT_MAX_AGE );
	while ( all.len() >= INTENT_MAX ) {
		let oldest = all.iter().min_by_key( |( _, i )| i.made ).map( |( k, _ )| k.clone() );
		match oldest {
			Some( k ) => { all.remove( &k ); }
			None => break,
		}
	}
	all.insert( intent.clone(), intent_t { wallet: wallet.to_string(), account: account, made: Instant::now() } );
	quoted_t { intent: intent, quote: quote }
}

/*
==================
E_TakeIntent

Takes an intent out of the table, once. Refused when it isn't there (sent
already, forgotten, or never ours), when it was quoted for another wallet
or account, or when it is too old. A mismatch takes it out too: nothing
may be tried under it afterwards.
==================
*/
pub fn E_TakeIntent( intent: &str, wallet: &str, account: u32 ) -> wresult_t< () > {
	let taken = e_intents.lock().unwrap().remove( intent );
	match taken {
		Some( i ) if i.wallet == wallet && i.account == account && i.made.elapsed() < INTENT_MAX_AGE => Ok( () ),
		_ => Err( werr_t::WERR_PAYMENT_DONE ),
	}
}

/*
==================
E_ForgetIntents

A closed wallet's quotes are void
==================
*/
pub fn E_ForgetIntents( wallet: &str ) {
	e_intents.lock().unwrap().retain( |_, i| i.wallet != wallet );
}

/*
=========================================================================

STARTING AND STOPPING SYNC

=========================================================================
*/

// only when stopped: sync() refuses to run twice
pub async fn E_StartSync( c: &mut LightClient ) -> Result< (), zingolib::lightclient::error::LightClientError > {
	c.sync().await
}

pub async fn E_Rescan( f: &mut fenced_t< '_ > ) -> wresult_t< () > {
	f.c.rescan().await.engine()
}

/*
==================
E_SyncOutcome

Why a finished engine stopped: None while it runs (or never ran),
Some( Err ) when it failed: what went wrong, classified here while the
engine's typed error still exists, and its whole cause chain for the log
==================
*/
pub fn E_SyncOutcome( c: &mut LightClient ) -> Option< Result< (), werr_t > > {
	match c.poll_sync() {
		PollReport::Ready( Ok( _ ) ) => Some( Ok( () ) ),
		PollReport::Ready( Err( e ) ) => Some( Err( crate::w_net::Com_Classify( &e ) ) ),
		// zingolib 8: the sync task panicked; the engine's own fault, never the wallet's data
		PollReport::Panicked( text ) => Some( Err( crate::w_net::Com_Classify( &zingolib::lightclient::error::LightClientError::SyncPanicked( text ) ) ) ),
		PollReport::NotReady | PollReport::NoHandle => None,
	}
}

/*
==================
E_StopAndWait

Asks the engine to stop and waits until it has, or STOP_WAIT_SECS. It
stops after its current batch, and a batch waits on the network; the
callers restart sync anyway, so giving up is safe.
==================
*/
pub async fn E_StopAndWait( c: &mut LightClient ) {
	if ( c.stop_sync().is_err() ) {
		return;		// wasn't running
	}
	let deadline = std::time::Instant::now() + Duration::from_secs( STOP_WAIT_SECS );
	while ( matches!( c.poll_sync(), PollReport::NotReady ) ) {
		if ( std::time::Instant::now() > deadline ) {
			log::warn!( "E_StopAndWait: engine still busy after {STOP_WAIT_SECS} s" );
			return;
		}
		tokio::time::sleep( Duration::from_millis( 200 ) ).await;
	}
}


/*
=========================================================================

OFFLINE SIGNING (w_offline.rs, docs/OFFLINE-SIGNING.md)

=========================================================================
*/

/*
==================
E_SnapshotFenced

The wallet as its file would hold it, now, inside the fence a quote was
just built in: a signing request carries exactly the state that quote
saw to the offline computer (a block scanned in between would have it
plan on other notes). The engine hands out bytes only when it has
unsaved changes, so it is marked so first; the saver writes it again,
harmlessly.
==================
*/
pub async fn E_SnapshotFenced( f: &mut fenced_t< '_ > ) -> wresult_t< zeroize::Zeroizing< Vec< u8 > > > {
	let mut w = f.c.wallet().write().await;
	w.mark_dirty();
	w.save().engine()?.map( zeroize::Zeroizing::new ).ok_or_else( || werr_t::WERR_ENGINE( "the engine gave no wallet bytes".to_string() ) )
}

/*
==================
E_ViewKeyOf / E_SpendKeyOf

An account's viewing key, whatever the wallet holds; its spending key,
only in a wallet that has one
==================
*/
pub fn E_ViewKeyOf( w: &LightWallet, account: AccountId ) -> Option< zcash_keys::keys::UnifiedFullViewingKey > {
	use zingolib::wallet::keys::unified::UnifiedKeyStore;

	match w.unified_key_store.get( &account )? {
		UnifiedKeyStore::Spend( usk )	=> Some( usk.to_unified_full_viewing_key() ),
		UnifiedKeyStore::View( ufvk )	=> Some( ( **ufvk ).clone() ),
		UnifiedKeyStore::Empty			=> None,
	}
}

pub fn E_SpendKeyOf( w: &LightWallet, account: AccountId ) -> Option< zcash_keys::keys::UnifiedSpendingKey > {
	use zingolib::wallet::keys::unified::UnifiedKeyStore;

	match w.unified_key_store.get( &account )? {
		UnifiedKeyStore::Spend( usk )					=> Some( ( **usk ).clone() ),
		UnifiedKeyStore::View( _ ) | UnifiedKeyStore::Empty	=> None,
	}
}

/*
==================
E_Signer

A client made from a signing request's snapshot, with no server (the
engine then calculates for offline signing: its longest expiry), and the
account's spending key put beside the state it belongs to, in memory
only. Nothing about it is ever saved: it is dropped when signing ends.
==================
*/
pub async fn E_Signer( snapshot: &[ u8 ], config: zingolib::config::ClientConfig, account: AccountId, usk: zcash_keys::keys::UnifiedSpendingKey ) -> wresult_t< LightClient > {
	use zingolib::wallet::keys::unified::UnifiedKeyStore;

	let client = LightClient::from_bytes( snapshot.to_vec(), config ).await.engine()?;
	client.wallet().write().await.unified_key_store.insert( account, UnifiedKeyStore::Spend( Box::new( usk ) ) );
	Ok( client )
}

/*
==================
E_Calculate

Builds and signs the stored proposal, and sends nothing: the signed
transactions stay in the (in-memory) wallet as Calculated, and their
bytes come back, in order
==================
*/
pub async fn E_Calculate( f: &mut fenced_t< '_ > ) -> wresult_t< Vec< ( String, Vec< u8 > ) > > {
	let txids = f.c.calculate_stored_proposal().await.engine()?;
	let w = f.c.wallet().read().await;
	txids.iter().map( |txid| {
		let tx = w.wallet_transactions.get( txid ).ok_or_else( || werr_t::WERR_ENGINE( "a calculated transaction is missing".to_string() ) )?;
		let mut raw = Vec::new();
		tx.transaction().write( &mut raw ).engine()?;
		Ok( ( txid.to_string(), raw ) )
	} ).collect()
}

/*
==================
E_SpentOfOurs

What a transaction spends of this wallet, in zatoshis: each note by its
nullifier, each coin by its outpoint. An Orchard or Ironwood action whose
nullifier isn't ours is a padding action's dummy spend (every bundle is
padded to at least two actions) or another's note: not our money either
way, and skipped. It first refused every such payment as foreign, until
a live run built one. A Sapling or transparent input this wallet doesn't
hold is never padding, and is an error.
==================
*/
pub fn E_SpentOfOurs( w: &LightWallet, tx: &zcash_primitives::transaction::Transaction ) -> wresult_t< u64 > {
	use pepper_sync::wallet::OutputInterface;

	let mut sapling = std::collections::BTreeMap::new();
	let mut orchard = std::collections::BTreeMap::new();
	let mut ironwood = std::collections::BTreeMap::new();
	let mut coins = std::collections::BTreeMap::new();
	for t in w.wallet_transactions.values() {
		for n in t.sapling_notes() {
			if let Some( nf ) = n.spend_link() { sapling.insert( nf, n.value() ); }
		}
		for n in t.orchard_notes() {
			if let Some( nf ) = n.spend_link() { orchard.insert( nf, n.value() ); }
		}
		for n in t.ironwood_notes() {
			if let Some( nf ) = n.spend_link() { ironwood.insert( nf, n.value() ); }
		}
		for c in t.transparent_coins() {
			if let Some( op ) = c.spend_link() { coins.insert( op, c.value() ); }
		}
	}

	let unknown = || werr_t::WERR_OFFLINE_FOREIGN_INPUT;
	let mut total = 0u64;
	if let Some( b ) = tx.sapling_bundle() {
		for s in b.shielded_spends() {
			total += sapling.get( s.nullifier() ).ok_or_else( unknown )?;
		}
	}
	if let Some( b ) = tx.orchard_bundle() {
		total += b.actions().iter().filter_map( |a| orchard.get( a.nullifier() ) ).sum::< u64 >();
	}
	if let Some( b ) = tx.ironwood_bundle() {
		total += b.actions().iter().filter_map( |a| ironwood.get( a.nullifier() ) ).sum::< u64 >();
	}
	if let Some( b ) = tx.transparent_bundle() {
		for i in &b.vin {
			total += coins.get( i.prevout() ).ok_or_else( unknown )?;
		}
	}
	Ok( total )
}


#[cfg( test )]
mod tests {
	use super::*;

	/*
	==================
	a_dropped_payment_is_sent_again_only_while_it_can_be_mined

	Pending payments this wallet made (they spend its coins) are what a
	resend sends again, until the chain reaches their expiry; a pending
	payment someone is sending us, an unsent one (the unsent resend's),
	a mined, a failed or an expired one never are
	==================
	*/
	#[test]
	fn a_dropped_payment_is_sent_again_only_while_it_can_be_mined() {
		use pepper_sync::keys::transparent::{ TransparentAddressId, TransparentScope };
		use pepper_sync::wallet::{ OutputId, OutputInterface, TransparentCoin, WalletTransaction };
		use zcash_protocol::consensus::BlockHeight;
		use zcash_protocol::value::Zatoshis;
		use zcash_protocol::TxId;
		use zingo_status::confirmation_status::ConfirmationStatus as S;

		let mut wallet = crate::w_test::Test_Wallet();
		let key = TransparentAddressId::new( zip32::AccountId::ZERO, TransparentScope::External, zcash_transparent::keys::NonHardenedChildIndex::ZERO );
		let h = BlockHeight::from_u32;
		let txid = |n: u8| TxId::from_bytes( [ n; 32 ] );
		// a coin of ours, arrived in transaction n, spent by `by`
		let mut add = |n: u8, status: S, expiry: u32, by: Option< TxId >| {
			let mut coin = TransparentCoin::new_for_test( OutputId::new( txid( n ), 0 ), key, "tm".into(), Default::default(), Zatoshis::from_u64( 1_000 ).unwrap() );
			coin.set_spending_transaction( by );
			let tx = WalletTransaction::new_for_test_with_expiry( txid( n ), status, h( expiry ) ).with_transparent_coins_for_test( vec![ coin ] );
			wallet.wallet_transactions.insert( txid( n ), tx );
		};
		add( 1, S::Confirmed( h( 100 ) ), 0, Some( txid( 10 ) ) );
		add( 2, S::Confirmed( h( 100 ) ), 0, Some( txid( 11 ) ) );
		add( 3, S::Confirmed( h( 100 ) ), 0, Some( txid( 12 ) ) );
		add( 4, S::Confirmed( h( 100 ) ), 0, Some( txid( 13 ) ) );
		add( 5, S::Confirmed( h( 100 ) ), 0, Some( txid( 14 ) ) );
		add( 6, S::Confirmed( h( 100 ) ), 0, Some( txid( 15 ) ) );
		add( 10, S::Transmitted( h( 200 ) ), 320, None );		// ours, sent, never seen: dropped or not yet
		add( 11, S::Mempool( h( 200 ) ), 320, None );			// ours, seen, maybe dropped since
		add( 12, S::Mempool( h( 200 ) ), 0, None );				// ours, no expiry
		add( 13, S::Mempool( h( 100 ) ), 203, None );			// ours, expiring soon: nodes refuse it
		add( 14, S::Calculated( h( 200 ) ), 320, None );		// ours, never known sent: the unsent resend's
		add( 15, S::Failed( h( 200 ) ), 320, None );			// ours, failed
		add( 20, S::Mempool( h( 200 ) ), 320, None );			// someone's payment to us
		use pepper_sync::sync::{ ScanPriority, ScanRange };
		wallet.sync_state = pepper_sync::wallet::SyncState::new_for_test( vec![ ScanRange::from_parts( h( 1 )..h( 201 ), ScanPriority::Scanned ) ] );

		let mut dropped = E_DroppedOf( &wallet );
		dropped.sort();
		assert_eq!( dropped, vec![ txid( 10 ), txid( 11 ), txid( 12 ) ] );
		assert_eq!( E_UnsentOf( &wallet ), vec![ txid( 14 ) ] );
	}

	#[test]
	fn a_payment_can_be_mined_up_to_its_expiry() {
		assert!( Com_BeforeExpiry( Some( 320 ), 316 ), "the next block, 317, is 3 before it: still taken" );
		assert!( !Com_BeforeExpiry( Some( 320 ), 317 ), "the next, 318, is expiring soon: refused" );
		assert!( !Com_BeforeExpiry( Some( 320 ), 320 ), "scanned to its expiry: never" );
		assert!( Com_BeforeExpiry( None, u32::MAX ), "no expiry never expires" );
	}

	/*
	==================
	one_intent_sends_at_most_once

	The same intent handed back twice (a second click, a retried call)
	is taken once; the second is refused, so no payment can be built twice
	from one review
	==================
	*/
	#[test]
	fn one_intent_sends_at_most_once() {
		let q = E_Intend( "w1", 0, 5u64 );
		assert_eq!( q.quote, 5 );
		assert_eq!( q.intent.len(), 32 );

		assert!( E_TakeIntent( &q.intent, "w1", 0 ).is_ok() );
		assert!( matches!( E_TakeIntent( &q.intent, "w1", 0 ), Err( werr_t::WERR_PAYMENT_DONE ) ) );
	}

	#[test]
	fn an_intent_is_bound_to_its_wallet_and_account() {
		let q = E_Intend( "w1", 1, () );
		assert!( matches!( E_TakeIntent( &q.intent, "w2", 1 ), Err( werr_t::WERR_PAYMENT_DONE ) ), "another wallet" );
		assert!( matches!( E_TakeIntent( &q.intent, "w1", 1 ), Err( werr_t::WERR_PAYMENT_DONE ) ), "a mismatch voids it" );

		let q = E_Intend( "w1", 1, () );
		assert!( matches!( E_TakeIntent( &q.intent, "w1", 0 ), Err( werr_t::WERR_PAYMENT_DONE ) ), "another account" );
	}

	#[test]
	fn an_unknown_or_forgotten_intent_is_refused() {
		assert!( matches!( E_TakeIntent( "", "w1", 0 ), Err( werr_t::WERR_PAYMENT_DONE ) ) );
		assert!( matches!( E_TakeIntent( "not one of ours", "w1", 0 ), Err( werr_t::WERR_PAYMENT_DONE ) ) );

		let q = E_Intend( "closing", 0, () );
		E_ForgetIntents( "closing" );
		assert!( matches!( E_TakeIntent( &q.intent, "closing", 0 ), Err( werr_t::WERR_PAYMENT_DONE ) ) );
	}

	#[test]
	fn every_intent_is_different() {
		let a = E_Intend( "w1", 0, () );
		let b = E_Intend( "w1", 0, () );
		assert_ne!( a.intent, b.intent );
		assert!( E_TakeIntent( &a.intent, "w1", 0 ).is_ok() && E_TakeIntent( &b.intent, "w1", 0 ).is_ok(), "each is its own" );
	}

	/*
	==================
	only_what_a_stop_left_unsent_is_sent_again

	What Sync_SendUnsent sends again: only transactions the engine holds as
	signed and not known to be sent (a stop mid-send). Never one pending,
	mined or failed: those are settled or in the network's hands
	==================
	*/
	#[test]
	fn only_what_a_stop_left_unsent_is_sent_again() {
		use pepper_sync::wallet::WalletTransaction;
		use zcash_protocol::consensus::BlockHeight;
		use zcash_protocol::TxId;
		use zingo_status::confirmation_status::ConfirmationStatus as S;

		let mut w = crate::w_test::Test_Wallet();
		let h = BlockHeight::from_u32( 3_000_100 );
		for ( n, status ) in [ ( 1u8, S::Calculated( h ) ), ( 2, S::Transmitted( h ) ), ( 3, S::Mempool( h ) ), ( 4, S::Confirmed( h ) ), ( 5, S::Failed( h ) ) ] {
			let txid = TxId::from_bytes( [ n; 32 ] );
			w.wallet_transactions.insert( txid, WalletTransaction::new_for_test( txid, status ) );
		}
		assert_eq!( E_UnsentOf( &w ), vec![ TxId::from_bytes( [ 1; 32 ] ) ] );
	}
}
