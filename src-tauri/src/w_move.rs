/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_move.rs -- moving an account's Sapling money into Ironwood
//
// A payment to itself: everything in Sapling, to the account's own
// private address, whose Orchard receiver the protocol carries into
// Ironwood. History reads it as a move (W_Classify: spent from Sapling,
// received into Ironwood). Sapling stays private; moving is a choice,
// never forced, and only all of it at once (a part left behind would be
// a small note that costs its own fee to move later).
//
// Quote, then confirm, as a shield is (w_shield.rs says why): the quote
// keeps nothing, and the move is sent only if it is what the person saw,
// once per quote seen. It is quoted and answered in a shield's shapes
// (shieldQuote_t, shieldResult_t): money arriving in the private pool,
// its fee, and sent or changed.
//
// Orchard has its own way into Ironwood (w_migrate.rs, ZIP 318). Both
// ask W_Allow first (WA_MOVE_WITHIN): who may move money within at all.

use zcash_address::ZcashAddress;
use zcash_protocol::value::Zatoshis;
use zcash_protocol::PoolType;

use crate::w_engine::*;
use crate::w_local::*;
use crate::w_main::{ W_Allowed, W_Engine, W_Paying };
use crate::w_net::engineResult_t;


/*
==================
W_MoveAccount

The engine's hold on an account with Sapling money to move, and where
it goes: the account's own current private address. Or why not.
==================
*/
async fn W_MoveAccount( id: &str, account: u32 ) -> wresult_t< ( zip32::AccountId, clientRef_t, ZcashAddress ) > {
	W_Allowed( id, walletAct_t::WA_MOVE_WITHIN ).await?;
	let ( accountId, client, wallet ) = W_Engine( id, account ).await?;
	let sapling = E_Write( &wallet ).await?.account_balance( accountId ).engine()?.confirmed_sapling_balance;
	if ( sapling.map_or( true, |z| z == Zatoshis::ZERO ) ) {
		return Err( werr_t::WERR_NOTHING_TO_MOVE );
	}
	let own = crate::w_addr::W_Receive( id, account, None ).await?.shielded;
	let to = ZcashAddress::try_from_encoded( &own ).map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?;
	Ok( ( accountId, client, to ) )
}

/*
==================
W_ProposeMove

Everything in Sapling, to the account's own address; less than the fee
to move it is said as that, not as "not enough money"
==================
*/
async fn W_ProposeMove( f: &mut fenced_t< '_ >, account: zip32::AccountId, to: &ZcashAddress ) -> wresult_t< shieldQuote_t > {
	let p = E_ProposeSend( f, account, sendWhat_t::ALL( to.clone(), None ), Some( PoolType::SAPLING ) ).await
		.map_err( |e| match e {
			werr_t::WERR_NOT_ENOUGH => werr_t::WERR_MOVE_BELOW_FEE,
			e => e,
		} )?;
	Ok( shieldQuote_t {
		amount:		p.amount,
		fee:		p.fee,
		feeNote:	crate::w_send::Com_FeeNote( p.fee, p.amount, p.coins ),
	} )
}

/*
==================
W_QuoteMove

What moving would do, under a new intent. The engine's proposal is
dropped at once, so sync keeps running while the person reads.
==================
*/
pub async fn W_QuoteMove( id: &str, account: u32 ) -> wresult_t< quoted_t< shieldQuote_t > > {
	let ( accountId, client, to ) = W_MoveAccount( id, account ).await?;
	let quote = E_Fenced( &mut *E_Client( &client ).await?, fence_t::FENCE_SCANNED, async |f| E_Quote( f, async |f| W_ProposeMove( f, accountId, &to ).await ).await ).await?;
	Ok( E_Intend( id, account, quote ) )
}

/*
==================
W_MoveNow

Takes the intent first (one review, one attempt: W_Paying), then builds
the move again, on the chain as it is now, and sends it in the same
hold of the engine, if it is what the person saw. It spends Sapling
notes, so Sapling's spend key comes first (W_SendNow).
==================
*/
pub async fn W_MoveNow( id: &str, account: u32, intent: String, seen: shieldQuote_t ) -> wresult_t< shieldResult_t > {
	let ( accountId, client, to ) = W_MoveAccount( id, account ).await?;		// its refusals before a download
	crate::w_spendkey::Sk_Ensure().await?;
	let ( slot, _, _ ) = W_Paying( id, account, &intent ).await?;

	let done = E_Fenced( &mut *E_Client( &client ).await?, fence_t::FENCE_SCANNED, async |f| E_SendIfSeen( f, &slot, &seen, async |f| W_ProposeMove( f, accountId, &to ).await ).await ).await?;
	Ok( crate::w_shield::W_Answer( id, account, done ) )
}
