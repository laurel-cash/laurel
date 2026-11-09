/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_shield.rs -- moving an account's public (transparent) money into
// its private balance
//
// Quote, then confirm. W_QuoteShield says what shielding would do and
// keeps nothing. W_ShieldNow builds it again and sends it at once, but
// only if it matches what the person saw; otherwise it returns the new
// numbers to look at.
//
// Never a proposal kept open while a person reads: the engine pauses sync
// while one waits, and a transaction expires 120 blocks (about 50 minutes;
// 40 of the slower blocks before NU7) after the height it was built for. One kept open once expired before
// Shield was pressed, and the network refused it.

use zcash_protocol::value::Zatoshis;

use crate::w_local::*;
use crate::w_engine::*;
use crate::w_main::{ W_Engine, W_Paying };
use crate::w_net::engineResult_t;


/*
==================
W_ShieldAccount

The engine's hold on an account with public money to shield, or why not
==================
*/
async fn W_ShieldAccount( id: &str, account: u32 ) -> wresult_t< ( zip32::AccountId, clientRef_t ) > {
	let ( account, client, wallet ) = W_Engine( id, account ).await?;
	let transparent = E_Write( &wallet ).await?.account_balance( account ).engine()?.confirmed_transparent_balance;
	if ( transparent.map_or( true, |z| z == Zatoshis::ZERO ) ) {
		return Err( werr_t::WERR_NOTHING_TO_SHIELD );
	}
	Ok( ( account, client ) )
}

/*
==================
W_QuoteShield

What shielding would do, under a new intent. The engine's proposal is
dropped at once, so sync keeps running while the person reads.
==================
*/
pub async fn W_QuoteShield( id: &str, account: u32 ) -> wresult_t< quoted_t< shieldQuote_t > > {
	let ( accountId, client ) = W_ShieldAccount( id, account ).await?;
	let quote = E_Fenced( &mut *E_Client( &client ).await?, fence_t::FENCE_SCANNED, async |f| E_Quote( f, async |f| E_ProposeShield( f, accountId ).await ).await ).await?;
	Ok( E_Intend( id, account, quote ) )
}

/*
==================
W_ShieldNow

Takes the intent first (one review, one attempt: W_Paying), then builds
the shield again, on the chain as it is now, and sends it in the same
hold of the engine, if it is what the person saw
==================
*/
pub async fn W_ShieldNow( id: &str, account: u32, intent: String, seen: shieldQuote_t ) -> wresult_t< shieldResult_t > {
	let ( slot, _, _ ) = W_Paying( id, account, &intent ).await?;
	let ( accountId, client ) = W_ShieldAccount( id, account ).await?;

	let done = E_Fenced( &mut *E_Client( &client ).await?, fence_t::FENCE_SCANNED, async |f| E_SendIfSeen( f, &slot, &seen, async |f| E_ProposeShield( f, accountId ).await ).await ).await?;
	Ok( W_Answer( id, account, done ) )
}

/*
==================
W_Answer

What pressing Shield (or Move, w_move.rs) came to: sent, or new numbers
to look at, under a new intent
==================
*/
pub fn W_Answer( id: &str, account: u32, done: confirmed_t< shieldQuote_t > ) -> shieldResult_t {
	match done {
		confirmed_t::SENT( txid )		=> shieldResult_t::SENT { txid: txid },
		confirmed_t::CHANGED( quote )	=> shieldResult_t::CHANGED { quoted: E_Intend( id, account, quote ) },
	}
}
