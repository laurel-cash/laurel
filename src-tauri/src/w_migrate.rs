/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_migrate.rs -- moving an account's Orchard money into Ironwood
//
// ZIP 318 offers two ways. All at once (here): one planned set of
// transactions, shown for consent first; honest about the trade-off, since
// the moves are linkable on chain. The private, spread-over-days schedule
// needs a background driver verified against a funded testnet wallet
// before it moves anyone's money; until then its progress is only read
// (W_MigrationStatus), so a migration started elsewhere still shows.
//
// Sapling has its own way in (w_move.rs); both ask W_Allow first.
//
// Plan, then confirm, like a payment (w_shield.rs says why): the move
// happens only if the plan built now is the plan the person saw, and
// only once per plan they saw (the intent).

use crate::w_engine::{ fence_t, E_Client, E_Fenced, E_Intend, E_MigrateNow, E_MigrationStatus, E_PlanMigration };
use crate::w_local::*;
use crate::w_main::{ W_Engine, W_Paying, W_SaveAfterSend, W_Slot };


/*
==================
W_MigrateOffered

The Play beta's build (testnet-only) starts no Orchard move: the
engine's rounds broadcast a part before the wallet holding it is written,
so a stop between the two loses the part and its reserved notes (security
review T-041 #2, open before mainnet). A new testnet wallet holds no
Orchard since NU6.3, so the beta loses little. Refused here, in words,
for the plan and the move alike
==================
*/
fn W_MigrateOffered() -> wresult_t< () > {
	if ( cfg!( feature = "testnet-only" ) ) {
		return Err( werr_t::WERR_MIGRATE_OFF );
	}
	Ok( () )
}

/*
==================
W_PlanMigration

What moving everything now would do, under a new intent: nothing is
signed or sent
==================
*/
pub async fn W_PlanMigration( id: &str, account: u32 ) -> wresult_t< quoted_t< migratePlan_t > > {
	W_MigrateOffered()?;
	crate::w_main::W_Allowed( id, walletAct_t::WA_MOVE_WITHIN ).await?;
	let ( accountId, client, _ ) = W_Engine( id, account ).await?;
	let plan = E_Fenced( &mut *E_Client( &client ).await?, fence_t::FENCE_SCANNED, async |f| E_PlanMigration( f, accountId ).await ).await?;
	Ok( E_Intend( id, account, plan ) )
}

/*
==================
W_MigrateNow

Takes the intent first (one plan seen, one attempt: W_Paying), plans
again in the same hold of the engine, and moves only if the plan is the
one the person saw; otherwise the new plan comes back to be looked at.
The wallet is written before the hold ends (W_SaveAfterSend).
==================
*/
pub async fn W_MigrateNow( id: &str, account: u32, intent: String, seen: migratePlan_t ) -> wresult_t< migrateResult_t > {
	W_MigrateOffered()?;
	let ( slot, accountId, client ) = W_Paying( id, account, &intent ).await?;
	crate::w_main::W_Allowed( id, walletAct_t::WA_MOVE_WITHIN ).await?;

	E_Fenced( &mut *E_Client( &client ).await?, fence_t::FENCE_SCANNED, async |f| {
		let now = E_PlanMigration( f, accountId ).await?;
		if ( now != seen ) {
			return Ok( migrateResult_t::CHANGED { quoted: E_Intend( id, account, now ) } );
		}
		let txids = E_MigrateNow( f, accountId ).await?;
		W_SaveAfterSend( &slot ).await;
		Ok( migrateResult_t::SENT { txids: txids } )
	} ).await
}

/*
==================
W_MigrationStatus
==================
*/
pub async fn W_MigrationStatus( id: &str ) -> wresult_t< migrationStatus_t > {
	let client = W_Slot( id ).await?.read().await.client.clone();
	E_MigrationStatus( &*E_Client( &client ).await? ).await
}


#[cfg( test )]
mod beta_tests {
	use super::*;

	// the Play beta's build starts no Orchard move (cargo test --lib --features testnet-only); a part an older build left waiting still goes out, saved first
	#[test]
	fn the_beta_build_starts_no_orchard_move() {
		assert_eq!( W_MigrateOffered().is_err(), cfg!( feature = "testnet-only" ) );
	}
}
