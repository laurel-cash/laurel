/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_sync.rs -- connects each wallet to the network, runs its sync engine,
// keeps retrying while it can't, and pushes progress to the ui
//
// Wallets open offline (w_main.rs). Everything that needs the network
// lives here, and a network problem only ever shows up as progress.error
// on a wallet that is still fully there.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::{ LazyLock, Mutex };
use std::time::{ Duration, Instant };

use pepper_sync::error::SyncModeError;
use pepper_sync::sync::SyncStatus;
use pepper_sync::wallet::SyncMode;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::sync::watch;
use zingolib::lightclient::error::LightClientError;
use zingolib::lightclient::LightClient;

use crate::w_engine::{ fence_t, E_Client, E_ClientWhenFree, E_Fenced, E_Read, E_Rescan, E_StartSync, E_StopAndWait, E_SyncOutcome, E_DroppedOf, E_RebroadcastPending, E_RetransmitUnsent, E_TryClient, E_TryRead, E_UnsentOf };
use crate::w_date::Com_NowMsec;
use crate::w_local::*;
use crate::w_balance::W_Balances;
use crate::w_main::{ Com_NextSeq, W_Slot };
use crate::w_net::*;
use crate::w_server::{ Com_ServerOf, W_Connect, W_Server, W_ServerFailed };

// the ui never needs more than this many updates a second, and every
// update costs a balance query per account
const SYNC_PUMP_MSEC: u64 = 250;

// once a wallet has reached the tip this session, this many blocks behind
// is keeping up, not syncing: a new block every 25 s (since NU7) must not
// flash "Syncing". Sized in time: about 12 minutes, as 10 blocks were at
// 75 s, and a quarter of a payment's 120-block expiry, as 10 were of 40
pub const TIP_SLACK_BLOCKS: u32 = 30;

// the engine's time-left estimate waits for this much steady progress
const ETA_MIN_SECS: u64	= 20;

// a load-balanced server's backends can be a block apart at the tip: the
// engine asks for a block the tip said exists and hears "newer than the
// latest". Restarted quietly after this long, this many times in a row
const BEHIND_WAIT_SECS: u64		= 3;
const BEHIND_QUIET_TIMES: u32	= 5;

// waits between attempts while the network can't be reached
const RETRY_FIRST_SECS: u64	= 5;
const RETRY_MAX_SECS: u64	= 60;

// how often, while caught up, a payment not known to be sent is sent again
const RESEND_SECS: u64		= 120;

// per wallet, bumped on every Sync_Start so an older pump notices and exits
static sync_generations: LazyLock< Mutex< BTreeMap< String, u64 > > > = LazyLock::new( || Mutex::new( BTreeMap::new() ) );

// wallets with a retry loop running, so there is never more than one, and
// the bell that wakes it early ("Try Now")
static sync_trying: LazyLock< Mutex< BTreeMap< String, std::sync::Arc< tokio::sync::Notify > > > > = LazyLock::new( || Mutex::new( BTreeMap::new() ) );


/*
=========================================================================

STARTING

=========================================================================
*/

/*
==================
Sync_Connect

Points a wallet at the server it should use (w_server.rs) when it isn't
already. Never under a running engine: it holds its own connection, and
a server change stops it first (Sync_Reconnect). The connection is made
with no lock held: when the network is down that can take the full
connect timeout, and nothing else should wait on it.
==================
*/
async fn Sync_Connect( slot: &slotRef_t ) -> wresult_t< () > {
	let net = w_registry.read().await.network;
	let want = W_Server( net ).await?;
	let client = slot.read().await.client.clone();
	let settled = |c: &LightClient| c.sync_mode() == SyncMode::Running || Com_SameServer( c.indexer_uri(), &want );
	if ( settled( &*E_ClientWhenFree( &client ).await ) ) {
		return Ok( () );
	}
	let indexer = W_Connect( &want ).await.inspect_err( |e| W_ServerFailed( net, Some( &want ), e ) )?;

	let mut c = E_ClientWhenFree( &client ).await;
	if ( !settled( &c ) ) {		// another attempt may have won meanwhile
		c.set_indexer( indexer );
	}
	Ok( () )
}

fn Com_SameServer( has: Option< http::Uri >, want: &str ) -> bool {
	has.is_some_and( |u| Com_ServerOf( &u ).as_deref() == Some( want ) )
}

/*
==================
Sync_Reconnect

After the person changes the server: every wallet's engine stops, and
starts again on the new one
==================
*/
pub async fn Sync_Reconnect( app: &AppHandle ) {
	let slots = crate::w_main::W_Slots().await;
	for ( id, slot ) in slots {
		let client = slot.read().await.client.clone();
		E_StopAndWait( &mut *E_ClientWhenFree( &client ).await ).await;
		Sync_Retry( app, &id );
	}
}

/*
==================
Sync_Detach

Before a wallet is closed: its pump, seeing a newer generation, ends
without starting the engine again. Otherwise an engine that stopped for
the close could be restarted in the moment before the slot is gone, and
run on in memory over a wallet whose file is being shredded or whose key
is being forgotten.
==================
*/
pub fn Sync_Detach( id: &str ) {
	let mut gens = sync_generations.lock().unwrap();
	*gens.entry( id.to_string() ).or_insert( 0 ) += 1;
}

/*
==================
Sync_Start

Connects and starts one wallet's engine. The engine never finishes on its
own: at the tip it keeps watching for new blocks, so a payment shows up as
soon as it is mined. Safe to call on a wallet already syncing; it just
attaches a fresh progress pump.
==================
*/
async fn Sync_Start( app: &AppHandle, id: &str ) -> wresult_t< () > {
	let slot = W_Slot( id ).await?;
	Sync_Connect( &slot ).await?;

	let handle = slot.read().await.client.clone();
	let rx = {
		let mut guard = E_ClientWhenFree( &handle ).await;
		let client = &mut *guard;

		if ( client.sync_mode() == SyncMode::Paused ) {
			client.resume_sync().engine()?;
		} else {
			match E_StartSync( client ).await {
				Ok( () ) => {},
				Err( LightClientError::SyncModeError( SyncModeError::SyncAlreadyRunning ) ) => {},
				Err( e ) => return Err( e ).engine(),
			}
		}
		client.subscribe_sync_status()
	};

	{
		let s = slot.read().await;
		if ( s.cache.lock().unwrap().failedAt.is_none() ) {
			*s.syncError.lock().unwrap() = None;
		}
	}
	Sync_LearnBirthday( &slot ).await;

	let generation = {
		let mut gens = sync_generations.lock().unwrap();
		let g = gens.entry( id.to_string() ).or_insert( 0 );
		*g += 1;
		*g
	};
	tauri::async_runtime::spawn( Sync_Pump( app.clone(), id.to_string(), rx, generation ) );
	Ok( () )
}

/*
==================
Sync_Begin

Starts a wallet syncing without waiting for it: connects in the
background and keeps retrying, with a growing pause, until it works or
the app closes. The error of each failed attempt is shown on the wallet.
==================
*/
pub fn Sync_Begin( app: &AppHandle, id: &str ) {
	Sync_BeginAfter( app, id, 0 );
}

/*
==================
Sync_BeginAfter

Sync_Begin, after a pause: when the engine itself just failed, restarting
at once only fails again, four times a second, saying nothing
==================
*/
fn Sync_BeginAfter( app: &AppHandle, id: &str, pause: u64 ) {
	let wake = {
		let mut trying = sync_trying.lock().unwrap();
		if ( trying.contains_key( id ) ) {
			return;		// already trying
		}
		let wake = std::sync::Arc::new( tokio::sync::Notify::new() );
		trying.insert( id.to_string(), wake.clone() );
		wake
	};
	let app = app.clone();
	let id = id.to_string();

	tauri::async_runtime::spawn( async move {
		if ( pause > 0 ) {
			Sync_SetRetry( &app, &id, retry_t { attempting: false, nextAt: Some( Com_NowMsec() + pause * 1000 ) } ).await;
			tokio::select! {
				_ = tokio::time::sleep( Duration::from_secs( pause ) ) => {}
				_ = wake.notified() => {}
			}
		}

		let mut wait = RETRY_FIRST_SECS;
		loop {
			if ( w_shuttingDown.load( Ordering::SeqCst ) ) {
				break;
			}
			Sync_SetRetry( &app, &id, retry_t { attempting: true, nextAt: None } ).await;

			match Sync_Start( &app, &id ).await {
				Ok( () ) => {
					Sync_SetRetry( &app, &id, retry_t::default() ).await;
					break;
				}
				Err( werr_t::WERR_NO_WALLET ) => break,
				Err( e ) => {
					if let Ok( slot ) = W_Slot( &id ).await {
						*slot.read().await.syncError.lock().unwrap() = Some( e.Info() );
					}
					Sync_SetRetry( &app, &id, retry_t { attempting: false, nextAt: Some( Com_NowMsec() + wait * 1000 ) } ).await;
				}
			}

			// asked to try now: the pause starts short again, the person is here and waiting
			tokio::select! {
				_ = tokio::time::sleep( Duration::from_secs( wait ) ) => { wait = ( wait * 2 ).min( RETRY_MAX_SECS ); }
				_ = wake.notified() => { wait = RETRY_FIRST_SECS; }
			}
		}
		sync_trying.lock().unwrap().remove( &id );
	} );
}

/*
==================
Sync_SetRetry

Records where a wallet's retry loop stands and tells the ui at once,
so "Try Now" answers the moment it's pressed
==================
*/
async fn Sync_SetRetry( app: &AppHandle, id: &str, r: retry_t ) {
	let Ok( slot ) = W_Slot( id ).await else {
		return;
	};
	*slot.read().await.retry.lock().unwrap() = r;
	Sync_Emit( app, id, None ).await;
}

/*
==================
Com_NowMsec
==================
*/

/*
==================
Sync_Retry

Try again now: wakes a waiting retry loop, or starts one
==================
*/
pub fn Sync_Retry( app: &AppHandle, id: &str ) {
	let waiting = sync_trying.lock().unwrap().get( id ).cloned();
	match waiting {
		Some( wake ) => wake.notify_one(),
		None => Sync_Begin( app, id ),
	}
}

/*
==================
Sync_OpenAll

Opens every wallet not open yet, and starts the sync of those it opened:
at start, and again after a lock closed them all
==================
*/
pub async fn Sync_OpenAll( app: &AppHandle, net: network_t ) -> wresult_t< () > {
	let opened = crate::w_main::W_Load( net ).await?;
	Sync_BeginAll( app, &opened );
	Ok( () )
}

fn Sync_BeginAll( app: &AppHandle, ids: &[ String ] ) {
	for id in ids {
		Sync_Begin( app, id );
	}
}


/*
=========================================================================

PROGRESS

=========================================================================
*/

/*
==================
Sync_Emit

Sends one wallet's progress and balances to the ui. The seq is taken
before anything is read (see W_Summary).
==================
*/
#[allow( clippy::await_holding_invalid_type, reason = "the only await under the slot is Sync_ProgressOf, which reads memory, never the network" )]
async fn Sync_Emit( app: &AppHandle, id: &str, status: Option< SyncStatus > ) {
	let Ok( slot ) = W_Slot( id ).await else {
		return;
	};
	let event = {
		let s = slot.read().await;
		let seq = Com_NextSeq();
		syncEvent_t {
			seq:		seq,
			walletId:	id.to_string(),
			progress:	Sync_ProgressOf( &s, status ).await,
			balances:	W_Balances( &s ),
		}
	};
	let _ = event.emit( app );

	// a statement, not the tail: the guard must end before `slot` does
	match slot.try_read() {
		Ok( s ) => crate::w_notice::N_Payments( app, id, &s ),
		Err( _ ) => {},		// busy: the next emit looks again
	};

	// once caught up, what isn't known to be sent goes out: at the first
	// catch-up, then every RESEND_SECS while any is left, and at once after a
	// send that may not have gone out (E_SendProposal)
	let due = {
		let s = slot.read().await;
		let mut c = s.cache.lock().unwrap();
		let now = crate::w_date::Com_Now();
		let due = c.caughtUp && now >= c.unsentNext;
		if ( due ) {
			c.unsentNext = now + RESEND_SECS;
		}
		due
	};
	if ( due ) {
		let id = id.to_string();
		tauri::async_runtime::spawn( async move {
			Sync_SendUnsent( &id ).await;
		} );
	}
}

/*
==================
Sync_SendUnsent

A payment signed but not known to be sent (Laurel stopped mid-send: the
wallet is saved right after signing) is sent again, never forgotten and
never failed by Laurel: failing it would free its coins, and if it did
go out, a second payment would pay twice. Sending the same transaction
again is harmless: the network takes it once. Only once the wallet has
caught up, because sync reads the mempool and the chain first: one that
did go out is by then pending or confirmed, not unsent. What the network
refuses (an expired one), the engine marks failed and gives back.

A payment that did go out and was then dropped by the network (a node
restart, a stall, an eviction) is pending and would stay so until it
expires: its same bytes go out again too (E_DroppedOf), until it is
mined or past its expiry.
==================
*/
async fn Sync_SendUnsent( id: &str ) {
	let Ok( slot ) = W_Slot( id ).await else {
		return;
	};
	let ( client, wallet ) = {
		let s = slot.read().await;
		( s.client.clone(), s.wallet.clone() )
	};
	let ( unsent, dropped ) = match E_Read( &wallet ).await {
		Ok( w ) => ( nonempty::NonEmpty::from_vec( E_UnsentOf( &w ) ), nonempty::NonEmpty::from_vec( E_DroppedOf( &w ) ) ),
		Err( _ ) => return,
	};
	if ( unsent.is_none() && dropped.is_none() ) {
		return;
	}
	// on disk first: a payment goes out only from a wallet just written, so a
	// stop can't lose what was sent (a failed write tries again later)
	if let Err( e ) = crate::w_main::W_SaveSlot( &slot ).await {
		log::warn!( "Sync_SendUnsent: not sending until the wallet can be written: {}", e.LogText() );
		return;
	}
	log::info!( "Sync_SendUnsent: sending {} payment(s) not known to be sent, {} pending one(s) again", unsent.as_ref().map_or( 0, |u| u.len() ), dropped.as_ref().map_or( 0, |d| d.len() ) );
	let sent = match E_Client( &client ).await {
		Ok( mut c ) => E_Fenced( &mut c, fence_t::FENCE_WALLET, async |f| {
			// each on its own: one refused doesn't keep the other from going
			if let Some( d ) = dropped {
				E_RebroadcastPending( f, d ).await;
			}
			match unsent { Some( u ) => E_RetransmitUnsent( f, u ).await, None => Ok( () ) }
		} ).await,
		Err( e ) => Err( e ),
	};
	if let Err( e ) = sent {
		log::warn!( "Sync_SendUnsent: {}", e.LogText() );
	}
	crate::w_main::W_SaveAfterSend( &slot ).await;		// the next progress emit shows the new states
}

/*
==================
Sync_Pump

Forwards one wallet's engine status to the ui, at most once per
SYNC_PUMP_MSEC; statuses arriving meanwhile collapse into the next one.
If the engine stops by itself (the network dropped mid-sync), it is
started again, unless the app is closing or a newer session replaced it.
==================
*/
async fn Sync_Pump( app: AppHandle, id: String, mut rx: watch::Receiver< Option< SyncStatus > >, generation: u64 ) {
	let current = || sync_generations.lock().unwrap().get( &id ).copied() == Some( generation );

	loop {
		if ( rx.changed().await.is_err() ) {
			break;		// engine session ended
		}
		if ( !current() ) {
			return;		// a newer session took over
		}
		let status = rx.borrow_and_update().clone();
		Sync_Emit( &app, &id, status ).await;
		tokio::time::sleep( Duration::from_millis( SYNC_PUMP_MSEC ) ).await;
	}

	if ( current() && !w_shuttingDown.load( Ordering::SeqCst ) ) {
		let mut pause = 0;
		if let Ok( slot ) = W_Slot( &id ).await {
			let client = slot.read().await.client.clone();
			let outcome = E_SyncOutcome( &mut *E_ClientWhenFree( &client ).await );
			if let Some( Err( err ) ) = outcome {
				// LogText, never the engine's raw words: they can quote what they were given (W1-04)
				log::warn!( "Sync_Pump: {id}: engine stopped: {}", err.LogText() );
				let behind = slot.read().await.cache.lock().unwrap().behind;
				match Com_AfterStop( &err, behind ) {
					afterStop_t::AFTER_QUIET => {
						slot.read().await.cache.lock().unwrap().behind += 1;
						Sync_BeginQuietly( &app, &id, BEHIND_WAIT_SECS );
						return;
					}
					afterStop_t::AFTER_REPAIR => {
						if ( Sync_Repair( &slot, &err ).await ) {
							Sync_Begin( &app, &id );		// attaches to the rescan already running
							return;
						}
					}
					afterStop_t::AFTER_BACKOFF => {}
				}
				let server = E_ClientWhenFree( &client ).await.indexer_uri().and_then( |u| Com_ServerOf( &u ) );
				let newer = match ( &err, server.as_deref() ) {
					( werr_t::WERR_SERVER( _ ), Some( uri ) ) => crate::w_server::W_NetworkNewer( uri ).await,
					_ => false,
				};
				let err = if ( newer ) { werr_t::WERR_NETWORK_NEWER } else { err };
				W_ServerFailed( w_registry.read().await.network, server.as_deref(), &err );		// automatic: the retry picks another (not for Laurel's age)
				let s = slot.read().await;
				let mut c = s.cache.lock().unwrap();
				c.failures	+= 1;
				c.failedAt	= Some( c.percent );
				pause		= ( RETRY_FIRST_SECS << ( c.failures - 1 ).min( 4 ) ).min( RETRY_MAX_SECS );
				*s.syncError.lock().unwrap() = Some( err.Info() );
			}
		}
		Sync_BeginAfter( &app, &id, pause );
	}
}

/*
==================
Sync_ProgressOf

The ui's view of one wallet's engine. With no published status (engine
not started yet this session) it is computed from the wallet file, so
the ui can show where the last session left off.
==================
*/
#[allow( clippy::await_holding_invalid_type, reason = "sync_status only reads the wallet it is handed; the guard is a try_read that never waited" )]
pub async fn Sync_ProgressOf( slot: &slot_t, status: Option< SyncStatus > ) -> syncProgress_t {
	let mut status = status;

	// the engine's mode and latest status, when the client is free; while a send
	// holds it, the last reading stands
	if let Some( client ) = E_TryClient( &slot.client ) {
		let mode = client.sync_mode();
		let mut c = slot.cache.lock().unwrap();
		c.running	= mode == SyncMode::Running;
		c.paused	= mode == SyncMode::Paused;
		if ( status.is_none() ) {
			status = client.latest_sync_status();
		}
	}

	// the wallet only when it is free: mid-batch, the engine holds it across network
	// requests, and the last heights are still true enough to show
	if let Some( wallet ) = E_TryRead( &slot.wallet ) {
		if ( status.is_none() ) {
			status = pepper_sync::sync_status( &*wallet ).await.ok();
		}
		let mut c = slot.cache.lock().unwrap();
		c.walletHeight	= wallet.sync_state.fully_scanned_height().map_or( 0, u32::from );
		c.chainHeight	= wallet.sync_state.last_known_chain_height().map_or( 0, u32::from );
	}

	let mut p = syncProgress_t::default();
	{
		let c = slot.cache.lock().unwrap();
		p.running	= c.running;
		p.paused	= c.paused;
	}
	p.error			= slot.syncError.lock().unwrap().clone();
	let retry		= *slot.retry.lock().unwrap();
	p.attempting	= retry.attempting;
	p.nextRetryAt	= retry.nextAt;

	let mut c = slot.cache.lock().unwrap();
	if let Some( s ) = status {
		// zingolib 8: the exact ratio of outputs scanned, none to scan as 0
		let raw				= if ( s.total_outputs > 0 ) { s.total_outputs_scanned as f64 * 100.0 / s.total_outputs as f64 } else { 0.0 };
		c.engineComplete	= s.is_complete();
		c.percent			= raw.clamp( 0.0, 99.0 ).floor() as u8;
	}
	if ( c.engineComplete ) {
		c.caughtUp	= true;
		c.repairing	= false;
		c.behind	= 0;		// reached the tip: the next race starts a fresh count
	}

	// an engine failure stands until the engine gets past where it failed
	if let Some( at ) = c.failedAt {
		if ( c.engineComplete || c.percent > at ) {
			c.failedAt = None;
			c.failures = 0;
			*slot.syncError.lock().unwrap() = None;
			p.error = None;
		}
	}

	p.walletHeight	= c.walletHeight;
	p.chainHeight	= c.chainHeight;
	p.birthdayTime	= c.birthdayTime;
	p.repairing		= c.repairing;

	p.complete	= c.IsComplete( TIP_SLACK_BLOCKS );
	p.percent	= if ( p.complete ) { 100 } else { c.percent };		// 100 only when truly done

	// time left, from this stretch's own pace; none until the pace means something
	if ( p.complete || !p.running ) {
		c.etaBase = None;
	} else {
		match c.etaBase {
			None => c.etaBase = Some( ( Instant::now(), p.percent ) ),
			Some( ( since, from ) ) => {
				let secs	= since.elapsed().as_secs();
				let gained	= p.percent.saturating_sub( from ) as u64;
				if ( secs >= ETA_MIN_SECS && gained >= 1 ) {
					p.etaSecs = Some( ( secs * ( 100 - p.percent as u64 ) / gained ) as u32 );
				}
			}
		}
	}
	p
}

// what Sync_Pump does after the engine stopped on its own
#[derive( Debug, PartialEq, Eq )]
enum afterStop_t {
	AFTER_QUIET,		// a moment's race at the tip: start again shortly, say nothing, keep the server
	AFTER_REPAIR,		// the wallet's own sync data: check again from the birthday
	AFTER_BACKOFF,		// the server or the network: say why, wait longer each time
}

/*
==================
Com_AfterStop

Decided from the classified error (Com_Classify), never its words. A
server that stays behind isn't a race any more: after BEHIND_QUIET_TIMES
it is treated like any failing server, so automatic mode moves on. The
default for every other error is the visible one: say why, back off.
==================
*/
fn Com_AfterStop( err: &werr_t, behindSoFar: u32 ) -> afterStop_t {
	match err {
		werr_t::WERR_SERVER_BEHIND if behindSoFar < BEHIND_QUIET_TIMES => afterStop_t::AFTER_QUIET,
		werr_t::WERR_SYNC_DATA( _ ) => afterStop_t::AFTER_REPAIR,
		_ => afterStop_t::AFTER_BACKOFF,
	}
}

/*
==================
Sync_BeginQuietly

Sync_Begin after a short wait, without a retry countdown on screen: for
a race at the tip that fixes itself
==================
*/
fn Sync_BeginQuietly( app: &AppHandle, id: &str, secs: u64 ) {
	let app = app.clone();
	let id = id.to_string();
	tauri::async_runtime::spawn( async move {
		tokio::time::sleep( Duration::from_secs( secs ) ).await;
		if ( !w_shuttingDown.load( Ordering::SeqCst ) ) {
			Sync_Begin( &app, &id );
		}
	} );
}

/*
==================
Sync_Repair

When the wallet's own sync data is at fault (a commitment tree that no
longer fits together), checking again from the birthday rebuilds it; the
keys and addresses are untouched. Automatic, once per session: a person
shouldn't have to know what a shard tree is. Returns true if it started.
The caller decides it's the data (Com_AfterStop).
==================
*/
async fn Sync_Repair( slot: &slotRef_t, why: &werr_t ) -> bool {
	{
		let s = slot.read().await;
		let mut c = s.cache.lock().unwrap();
		if ( c.repaired ) {
			return false;
		}
		c.repaired = true;
	}
	log::warn!( "Sync_Repair: rescanning from the birthday after: {}", why.LogText() );
	match Sync_Recheck( slot ).await {
		Ok( () ) => true,
		Err( e ) => {
			log::warn!( "Sync_Repair: rescan failed: {}", e.LogText() );
			false
		}
	}
}

/*
==================
Sync_Recheck

Looks through the chain again from the wallet's birthday: what the
automatic repair does, and what Developer settings offers. Keys and
addresses aren't touched; progress starts over and says it's rechecking.
==================
*/
async fn Sync_Recheck( slot: &slotRef_t ) -> wresult_t< () > {
	{
		let s = slot.read().await;
		let mut c = s.cache.lock().unwrap();
		c.repairing = true;
		c.StartOver();
	}
	let client = slot.read().await.client.clone();
	let rescan = E_Fenced( &mut *E_ClientWhenFree( &client ).await, fence_t::FENCE_WALLET, async |f| E_Rescan( f ).await ).await;
	if ( rescan.is_err() ) {
		slot.read().await.cache.lock().unwrap().repairing = false;
	}
	rescan
}

/*
==================
Sync_Rescan

The person asked to check a wallet again from the start
==================
*/
pub async fn Sync_Rescan( app: &AppHandle, id: &str ) -> wresult_t< () > {
	Sync_Recheck( &W_Slot( id ).await? ).await?;
	Sync_Begin( app, id );		// attaches to the rescan now running
	Ok( () )
}

/*
==================
Sync_LearnBirthday

When the wallet's first block was mined, asked of the server once: the
ui shows sync as a stretch of dates, and people know dates, not blocks
==================
*/
async fn Sync_LearnBirthday( slot: &slotRef_t ) {
	let height = {
		let s = slot.read().await;
		let c = s.cache.lock().unwrap();
		if ( c.birthdayTime.is_some() || c.birthdayHeight == 0 ) {
			return;
		}
		c.birthdayHeight
	};
	let net = w_registry.read().await.network;
	let slot = slot.clone();
	tauri::async_runtime::spawn( async move {
		match W_BlockTime( net, height as u64 ).await {
			Ok( t ) => slot.read().await.cache.lock().unwrap().birthdayTime = Some( t ),
			Err( e ) => log::warn!( "Sync_LearnBirthday: {}", e.LogText() ),
		}
	} );
}

/*
==================
Sync_RequireCaughtUp

A payment is built on the wallet's view of the chain and expires 120
blocks past it (40 before NU7): built on an old view, the network refuses
it. So only from a wallet within TIP_SLACK_BLOCKS of the server's tip,
asked now.
==================
*/
pub async fn Sync_RequireCaughtUp( slot: &slotRef_t ) -> wresult_t< () > {
	let net = w_registry.read().await.network;
	let tip = W_ChainHeight( net ).await?;
	let scanned = slot.read().await.cache.lock().unwrap().walletHeight;
	if ( Com_BehindTip( scanned, tip ) ) {
		return Err( werr_t::WERR_CATCHING_UP );
	}
	Ok( () )
}

fn Com_BehindTip( scanned: u32, tip: u32 ) -> bool {
	scanned.saturating_add( TIP_SLACK_BLOCKS ) < tip
}

/*
==================
Sync_Pause / Sync_Resume

For this session only: the next start syncs as usual, so a pause can't
be forgotten into a wallet that silently stopped updating
==================
*/
pub async fn Sync_Pause( app: &AppHandle, id: &str ) -> wresult_t< () > {
	let client = W_Slot( id ).await?.read().await.client.clone();
	E_Client( &client ).await?.pause_sync().engine()?;
	Sync_Emit( app, id, None ).await;
	Ok( () )
}

pub async fn Sync_Resume( app: &AppHandle, id: &str ) -> wresult_t< () > {
	let client = W_Slot( id ).await?.read().await.client.clone();
	E_Client( &client ).await?.resume_sync().engine()?;
	Sync_Emit( app, id, None ).await;
	Ok( () )
}


#[cfg( test )]
mod tests {
	use super::*;

	#[test]
	fn a_payment_waits_for_a_wallet_near_the_tip() {
		assert!( !Com_BehindTip( 1000, 1000 ) );
		assert!( !Com_BehindTip( 1000 - TIP_SLACK_BLOCKS, 1000 ) );
		assert!( Com_BehindTip( 1000 - TIP_SLACK_BLOCKS - 1, 1000 ) );
		assert!( Com_BehindTip( 0, 1000 ) );		// never scanned: never pays
	}

	#[test]
	fn a_race_at_the_tip_is_quiet_until_the_server_stays_behind() {
		for n in 0..BEHIND_QUIET_TIMES {
			assert_eq!( Com_AfterStop( &werr_t::WERR_SERVER_BEHIND, n ), afterStop_t::AFTER_QUIET );
		}
		assert_eq!( Com_AfterStop( &werr_t::WERR_SERVER_BEHIND, BEHIND_QUIET_TIMES ), afterStop_t::AFTER_BACKOFF );
	}

	#[test]
	fn only_the_data_is_repaired_and_everything_else_says_why() {
		assert_eq!( Com_AfterStop( &werr_t::WERR_SYNC_DATA( "tree".into() ), 0 ), afterStop_t::AFTER_REPAIR );
		// a server that can't serve Ironwood: another server, never a rescan
		for e in [ werr_t::WERR_SERVER( "x".into() ), werr_t::WERR_SERVER_OUTDATED( "x".into() ), werr_t::WERR_SERVER_SLOW, werr_t::WERR_INTERCEPTED, werr_t::WERR_ENGINE( "x".into() ) ] {
			assert_eq!( Com_AfterStop( &e, 0 ), afterStop_t::AFTER_BACKOFF );
		}
	}

	#[test]
	fn a_repair_never_looks_finished_before_it_is() {
		let mut c = slotCache_t::default();
		c.engineComplete = true;
		c.caughtUp = true;
		c.chainHeight = 1000;
		c.walletHeight = 1000;
		assert!( c.IsComplete( TIP_SLACK_BLOCKS ) );

		c.StartOver();			// what Sync_Repair does before rescanning
		c.chainHeight = 1000;	// the tip is still known; the wallet is back at its birthday
		assert!( !c.IsComplete( TIP_SLACK_BLOCKS ) );
	}

	#[test]
	fn keeping_up_at_the_tip_is_complete_a_real_gap_is_not() {
		let mut c = slotCache_t::default();
		c.caughtUp = true;
		c.chainHeight = 1000;
		c.walletHeight = 1000 - TIP_SLACK_BLOCKS;
		assert!( c.IsComplete( TIP_SLACK_BLOCKS ) );
		c.walletHeight = 1000 - TIP_SLACK_BLOCKS - 1;
		assert!( !c.IsComplete( TIP_SLACK_BLOCKS ) );
	}

}
