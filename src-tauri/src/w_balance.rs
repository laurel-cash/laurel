/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_balance.rs -- what each account holds, per pool, as the engine says
//
// Lived in w_main.rs, the registry, which is about which wallets are open
// and where they are kept, not what is in them.

use zcash_protocol::value::Zatoshis;
use zingolib::wallet::LightWallet;
use zip32::AccountId;

use crate::w_engine::E_TryRead;
use crate::w_local::*;
use crate::w_net::engineResult_t;

fn W_Zats( z: Option< Zatoshis > ) -> u64 {
	z.map_or( 0, |v| v.into_u64() )
}

/*
==================
W_AccountBalance

Per-pool balance of one account. Pending is what the engine reports as
unconfirmed: received, but not yet spendable. Spendable is what Send can
use right now: confirmed money the engine is still checking (a few more
blocks, its witness, the wallet catching up) is in the balance but not
in it, and the screen says so instead of contradicting Send.
==================
*/
pub fn W_AccountBalance( wallet: &LightWallet, index: u32 ) -> wresult_t< balance_t > {
	let account = AccountId::try_from( index ).map_err( |_| werr_t::WERR_NO_ACCOUNT )?;
	let b = wallet.account_balance( account ).engine()?;

	let mut bal = balance_t::default();

	bal.ironwood.confirmed		= W_Zats( b.confirmed_ironwood_balance );
	bal.ironwood.pending		= W_Zats( b.unconfirmed_ironwood_balance );
	bal.orchard.confirmed		= W_Zats( b.confirmed_orchard_balance );
	bal.orchard.pending			= W_Zats( b.unconfirmed_orchard_balance );
	bal.sapling.confirmed		= W_Zats( b.confirmed_sapling_balance );
	bal.sapling.pending			= W_Zats( b.unconfirmed_sapling_balance );
	bal.transparent.confirmed	= W_Zats( b.confirmed_transparent_balance );
	bal.transparent.pending		= W_Zats( b.unconfirmed_transparent_balance );

	for pool in [ bal.ironwood, bal.orchard, bal.sapling, bal.transparent ] {
		bal.total += pool.confirmed + pool.pending;
	}

	// only with a spending key: a viewing key's notes would count, and it spends nothing
	bal.spendable = match wallet.unified_key_store.get( &account ) {
		Some( zingolib::wallet::keys::unified::UnifiedKeyStore::Spend( _ ) )	=> Some( wallet.shielded_spendable_balance( account, false ).engine()?.into_u64() ),
		_																	=> None,
	};
	Ok( bal )
}

/*
==================
W_Balances

Every account of a wallet, by index. If the engine is mid-batch the
last balances are returned: a balance a moment old beats a frozen ui.
An account the engine can't read keeps its last one too, and the log
says why: it once read as 0 ZEC, a failure shown as a fact.
==================
*/
pub fn W_Balances( slot: &slot_t ) -> Vec< balance_t > {
	let last = slot.cache.lock().unwrap().balances.clone();
	let Some( wallet ) = E_TryRead( &slot.wallet ) else {
		return last;
	};
	let out: Vec< balance_t > = ( 0..slot.meta.accounts.len() as u32 )
		.map( |i| W_AccountBalance( &wallet, i ).unwrap_or_else( |e| {
			log::warn!( "W_Balances: account {i}: {}", e.LogText() );
			last.get( i as usize ).copied().unwrap_or_default()		// never read yet: nothing better to show
		} ) )
		.collect();
	slot.cache.lock().unwrap().balances = out.clone();
	out
}
