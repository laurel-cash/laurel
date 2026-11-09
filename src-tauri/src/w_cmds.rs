/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_cmds.rs -- commands the ui can invoke, one _f function per command

use tauri::AppHandle;
use zeroize::{ Zeroize, Zeroizing };

use crate::w_addr::*;
use crate::w_contacts::*;
use crate::w_dev::*;
use crate::w_history::*;
use crate::w_local::*;
use crate::w_main::*;
use crate::w_migrate::*;
use crate::w_move::*;
use crate::w_net::*;
use crate::w_phrase::*;
use crate::w_price::*;
use crate::w_scan::*;
use crate::w_send::*;
use crate::w_server::*;
use crate::w_settings::*;
use crate::w_shield::*;
use crate::w_storage::*;
use crate::w_sweep::*;
use crate::w_sync::*;
use crate::w_vault::*;


/*
==================
Com_Blocking

Runs slow synchronous work (argon2 on purpose takes about a second, disk
writes can wait on antivirus) off the async threads
==================
*/
async fn Com_Blocking< T, F >( work: F ) -> wresult_t< T >
where
	T: Send + 'static,
	F: FnOnce() -> wresult_t< T > + Send + 'static,
{
	tauri::async_runtime::spawn_blocking( work ).await.map_err( |e| werr_t::WERR_ENGINE( e.to_string() ) )?
}


/*
=========================================================================

VAULT

passwords are wrapped for zeroizing the moment they arrive

=========================================================================
*/

/*
==================
V_Open_f

At start: unlocks at once when windows protects the key, makes the key
on first run
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn V_Open_f() -> wresult_t< vaultStatus_t > {
	Com_Blocking( V_Open ).await
}

/*
==================
V_Status_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn V_Status_f() -> wresult_t< vaultStatus_t > {
	Com_Blocking( V_Status ).await
}

/*
==================
V_Unlock_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn V_Unlock_f( password: String ) -> wresult_t< vaultStatus_t > {
	let password = Zeroizing::new( password );
	Com_Blocking( move || V_Unlock( &password ) ).await
}

/*
==================
V_Create_f

First run on a system with no key store
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn V_Create_f( password: String ) -> wresult_t< vaultStatus_t > {
	let password = Zeroizing::new( password );
	Com_Blocking( move || V_Create( &password ) ).await
}

/*
==================
V_SetPassword_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn V_SetPassword_f( password: String ) -> wresult_t< vaultStatus_t > {
	let password = Zeroizing::new( password );
	Com_Blocking( move || V_SetPassword( &password ) ).await
}

/*
==================
V_ChangePassword_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn V_ChangePassword_f( current: String, password: String ) -> wresult_t< vaultStatus_t > {
	let current = Zeroizing::new( current );
	let password = Zeroizing::new( password );
	Com_Blocking( move || V_ChangePassword( &current, &password ) ).await
}

/*
==================
V_RemovePassword_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn V_RemovePassword_f( current: String ) -> wresult_t< vaultStatus_t > {
	let current = Zeroizing::new( current );
	Com_Blocking( move || V_RemovePassword( &current ) ).await
}


/*
=========================================================================

WALLETS

=========================================================================
*/

/*
==================
W_Constants_f

The numbers and names the ui must agree with, from their one owner
==================
*/
#[tauri::command]
#[specta::specta]
pub fn W_Constants_f() -> constants_t {
	W_Constants()
}

/*
==================
W_List_f

Opens every wallet on first call and starts their sync, then lists them,
and any that couldn't be opened
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_List_f( app: AppHandle, net: network_t ) -> wresult_t< walletList_t > {
	Sync_OpenAll( &app, net ).await?;
	Ok( W_List().await )
}

/*
==================
W_Create_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_Create_f( app: AppHandle, net: network_t, name: String ) -> wresult_t< created_t > {
	let created = W_Create( net, name ).await?;
	Sync_Begin( &app, &created.id );
	Ok( created )
}

/*
==================
W_Restore_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_Restore_f( app: AppHandle, net: network_t, name: String, phrase: String, passphrase: String, birthday: u32, accounts: u32 ) -> wresult_t< String > {
	let id = W_Restore( net, name, phrase, passphrase, birthday, accounts ).await?;
	Sync_Begin( &app, &id );
	Ok( id )
}

/*
==================
W_RestoreViewKey_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_RestoreViewKey_f( app: AppHandle, net: network_t, name: String, key: String, birthday: u32 ) -> wresult_t< String > {
	let id = W_RestoreViewKey( net, name, key, birthday ).await?;
	Sync_Begin( &app, &id );
	Ok( id )
}

/*
==================
W_RenameWallet_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_RenameWallet_f( id: String, name: String ) -> wresult_t< () > {
	W_RenameWallet( &id, name ).await
}

/*
==================
W_Recovery_f

password: none when Windows protects the key (V_Confirm)
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_Recovery_f( id: String, password: Option< String > ) -> wresult_t< recovery_t > {
	let password = Zeroizing::new( password );
	let present = Com_Blocking( move || V_Confirm( password.as_deref() ) ).await?;
	W_Recovery( &id, &present ).await
}

/*
==================
W_MarkBackedUp_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_MarkBackedUp_f( id: String, words: Vec< backupWord_t >, passphrase: Option< String > ) -> wresult_t< () > {
	let passphrase = Zeroizing::new( passphrase );
	let result = W_MarkBackedUp( &id, &words, passphrase.as_deref() ).await;
	for mut w in words {
		w.word.zeroize();
	}
	result
}


/*
=========================================================================

ACCOUNTS

=========================================================================
*/

/*
==================
W_AddAccount_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_AddAccount_f( app: AppHandle, id: String, name: String, usedBefore: bool ) -> wresult_t< u32 > {
	let index = W_AddAccount( &id, name, usedBefore ).await?;
	Sync_Begin( &app, &id );		// picks up the new keys
	Ok( index )
}

/*
==================
W_Receive_f

The account's addresses; fresh makes that one new
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_Receive_f( id: String, account: u32, fresh: Option< freshAddress_t > ) -> wresult_t< receive_t > {
	W_Receive( &id, account, fresh ).await
}

/*
==================
Sync_Retry_f

"Try Now": stops waiting out the pause between connection attempts
==================
*/
#[tauri::command]
#[specta::specta]
pub fn Sync_Retry_f( app: AppHandle, id: String ) {
	Sync_Retry( &app, &id );
}

/*
==================
Sync_Pause_f / Sync_Resume_f

Pause lasts until resumed or until Laurel restarts
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn Sync_Pause_f( app: AppHandle, id: String ) -> wresult_t< () > {
	Sync_Pause( &app, &id ).await
}

#[tauri::command]
#[specta::specta]
pub async fn Sync_Resume_f( app: AppHandle, id: String ) -> wresult_t< () > {
	Sync_Resume( &app, &id ).await
}

/*
==================
W_Transactions_f

An account's transactions, newest first, pending on top
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_Transactions_f( id: String, account: u32 ) -> wresult_t< Vec< historyItem_t > > {
	W_Transactions( &id, account ).await
}

/*
==================
W_BalanceHistory_f

An account's balance over time, oldest first
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_BalanceHistory_f( id: String, account: u32 ) -> wresult_t< Vec< balancePoint_t > > {
	W_BalanceHistory( &id, account ).await
}

/*
==================
W_QuoteShield_f / W_ShieldNow_f

What shielding would do, then doing it if nothing changed since (the
new numbers if something did). Nothing is kept open in between.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_QuoteShield_f( id: String, account: u32 ) -> wresult_t< quoted_t< shieldQuote_t > > {
	W_QuoteShield( &id, account ).await
}

#[tauri::command]
#[specta::specta]
pub async fn W_ShieldNow_f( id: String, account: u32, intent: String, seen: shieldQuote_t ) -> wresult_t< shieldResult_t > {
	W_ShieldNow( &id, account, intent, seen ).await
}

/*
==================
W_QuoteMove_f / W_MoveNow_f

Sapling to Ironwood, the same way: what moving would do, then doing it
if nothing changed since (the new numbers if something did)
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_QuoteMove_f( id: String, account: u32 ) -> wresult_t< quoted_t< shieldQuote_t > > {
	W_QuoteMove( &id, account ).await
}

#[tauri::command]
#[specta::specta]
pub async fn W_MoveNow_f( id: String, account: u32, intent: String, seen: shieldQuote_t ) -> wresult_t< shieldResult_t > {
	W_MoveNow( &id, account, intent, seen ).await
}

/*
==================
W_CheckZcashdKeys_f / W_ImportZcashdKeys_f

zcashd's Sapling keys: read as they're pasted, then made into a wallet
that syncs like any other. The text is wiped when each call is done.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_CheckZcashdKeys_f( text: String ) -> zcashdCheck_t {
	let text = Zeroizing::new( text );
	W_CheckZcashdKeys( &text ).await
}

#[tauri::command]
#[specta::specta]
pub async fn W_ImportZcashdKeys_f( app: AppHandle, net: network_t, name: String, text: String, birthday: u32 ) -> wresult_t< String > {
	let text = Zeroizing::new( text );
	let id = W_ImportZcashdKeys( net, name, &text, birthday ).await?;
	Sync_Begin( &app, &id );
	Ok( id )
}

/*
==================
W_CheckKey_f / W_QuoteSweep_f / W_SweepNow_f

A single private key: read as it's typed, then what sweeping it into
this account would move, then sweeping it if nothing changed. The key is
wiped from memory when each call is done; Laurel never keeps it.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_CheckKey_f( key: String ) -> keyCheck_t {
	let key = Zeroizing::new( key );
	W_CheckKey( &key ).await
}

#[tauri::command]
#[specta::specta]
pub async fn W_QuoteSweep_f( id: String, account: u32, key: String ) -> wresult_t< quoted_t< sweepQuote_t > > {
	let key = Zeroizing::new( key );
	W_QuoteSweep( &id, account, &key ).await
}

#[tauri::command]
#[specta::specta]
pub async fn W_SweepNow_f( id: String, account: u32, key: String, intent: String, seen: sweepQuote_t ) -> wresult_t< sweepResult_t > {
	let key = Zeroizing::new( key );
	W_SweepNow( &id, account, &key, &intent, seen ).await
}

/*
==================
W_QuoteSend_f / W_SendNow_f

The same for a payment. The intent came with the quote; it sends once.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_QuoteSend_f( id: String, account: u32, request: sendRequest_t ) -> wresult_t< quoted_t< sendQuote_t > > {
	W_QuoteSend( &id, account, request ).await
}

#[tauri::command]
#[specta::specta]
pub async fn W_SendNow_f( id: String, account: u32, request: sendRequest_t, intent: String, seen: sendQuote_t, repeatId: Option< String > ) -> wresult_t< sendResult_t > {
	W_SendNow( &id, account, request, intent, seen, repeatId.as_deref() ).await
}

/*
==================
Sto_Measure_f

What Laurel keeps on this computer, and the space left on its disk
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn Sto_Measure_f() -> wresult_t< storage_t > {
	Com_Blocking( || Ok( Sto_Measure() ) ).await
}

/*
==================
S_Get_f / S_Set_f

The person's choices for the whole app: auto-lock, notifications
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn S_Get_f() -> wresult_t< appSettings_t > {
	Ok( S_Get() )
}

#[tauri::command]
#[specta::specta]
pub async fn S_Set_f( app: AppHandle, settings: appSettings_t ) -> wresult_t< appSettings_t > {
	if ( settings.notifySystem && !S_Get().notifySystem ) {
		crate::w_notice::N_Allow( &app )?;
	}
	Com_Blocking( move || S_Set( settings ) ).await
}

/*
==================
S_SetAutoLock_f

A lock that comes later than now needs the password (S_LocksLater):
without one the answer is ASK_PASSWORD, and the ui asks and comes back
with it. None is right when Windows protects the key (V_Confirm).
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn S_SetAutoLock_f( minutes: Option< u32 >, password: Option< String > ) -> wresult_t< autoLockResult_t > {
	Com_SetLock( S_LocksLater( S_Get().autoLockMinutes, minutes ), password, move |present| S_SetAutoLock( minutes, present ) ).await
}

/*
==================
S_SetLockAway_f

On a phone, how long Laurel may be out of sight before it locks: later
than now needs the password, as with the auto-lock
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn S_SetLockAway_f( secs: u32, password: Option< String > ) -> wresult_t< autoLockResult_t > {
	Com_SetLock( secs > S_Get().lockAwaySecs, password, move |present| S_SetLockAway( secs, present ) ).await
}

/*
==================
Com_SetLock

A lock setting saved, the password confirmed first when it locks later
than now (the answer is ASK_PASSWORD without one)
==================
*/
async fn Com_SetLock( later: bool, password: Option< String >, save: impl FnOnce( Option< &present_t > ) -> wresult_t< appSettings_t > + Send + 'static ) -> wresult_t< autoLockResult_t > {
	let password = Zeroizing::new( password );
	Com_Blocking( move || {
		let present = match later {
			true	=> match V_Confirm( password.as_deref() ) {
				Err( werr_t::WERR_CONFIRM )	=> return Ok( autoLockResult_t::ASK_PASSWORD ),
				proof						=> Some( proof? ),
			},
			false	=> None,
		};
		Ok( autoLockResult_t::SAVED { settings: save( present.as_ref() )? } )
	} ).await
}

/*
==================
M_Shown_f

The page is shown again: on a phone, Laurel locks first if it was out of
sight longer than the person allows (w_mobile.rs), and only then does
the page show the wallets again
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn M_Shown_f( app: AppHandle ) -> wresult_t< () > {
	#[cfg( mobile )]
	crate::w_mobile::M_Shown( &app ).await;
	#[cfg( not( mobile ) )]
	let _ = app;		// a computer's window has no hiding to answer for
	Ok( () )
}

/*
==================
W_SetNetwork_f

Mainnet or testnet: every wallet of this network saved and closed, the
choice kept. The ui then starts over on the other network.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_SetNetwork_f( net: network_t ) -> wresult_t< () > {
	W_SetNetwork( net ).await
}

/*
==================
D_Info_f / D_Reveal_f / D_Report_f

Developer settings: the facts, a folder shown in the file manager (named,
never a path), and a report to share that holds nothing private
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn D_Info_f( app: AppHandle ) -> wresult_t< devInfo_t > {
	Ok( D_Info( &app ).await )
}

#[tauri::command]
#[specta::specta]
pub async fn D_Reveal_f( folder: folder_t ) -> wresult_t< () > {
	Com_Blocking( move || D_Reveal( folder ) ).await
}

#[tauri::command]
#[specta::specta]
pub async fn D_Report_f( app: AppHandle ) -> wresult_t< String > {
	Ok( D_Report( &app ).await )
}

/*
==================
Sync_Rescan_f

Checks a wallet again from its birthday, at the person's asking
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn Sync_Rescan_f( app: AppHandle, id: String ) -> wresult_t< () > {
	Sync_Rescan( &app, &id ).await
}

/*
==================
Al_List_f / Al_Add_f / Al_Remove_f

Price alerts: above or below a price in dollars, each going off once
(w_alert.rs)
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn Al_List_f() -> wresult_t< Vec< crate::w_alert::priceAlert_t > > {
	crate::w_alert::Al_List()
}

#[tauri::command]
#[specta::specta]
pub async fn Al_Add_f( above: bool, usd: f64 ) -> wresult_t< crate::w_alert::priceAlert_t > {
	crate::w_alert::Al_Add( above, usd ).await
}

#[tauri::command]
#[specta::specta]
pub async fn Al_Remove_f( id: String ) -> wresult_t< () > {
	crate::w_alert::Al_Remove( &id ).await
}

/*
==================
F_Status_f / F_Sync_f / F_Start_f / F_Join_f / F_Stop_f / F_Forget_f

Sync between the person's computers (w_folder.rs, docs/SYNC.md). Start
gives the code, shown once; Join takes it.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn F_Status_f() -> wresult_t< crate::w_folder::syncStatus_t > {
	crate::w_folder::F_Status()
}

#[tauri::command]
#[specta::specta]
pub async fn F_Sync_f() -> wresult_t< crate::w_folder::syncStatus_t > {
	crate::w_folder::F_Sync().await
}

#[tauri::command]
#[specta::specta]
pub async fn F_Start_f( folder: String ) -> wresult_t< String > {
	crate::w_folder::F_Start( &folder ).await
}

#[tauri::command]
#[specta::specta]
pub async fn F_Join_f( folder: String, code: String ) -> wresult_t< crate::w_folder::syncStatus_t > {
	crate::w_folder::F_Join( &folder, &code ).await
}

#[tauri::command]
#[specta::specta]
pub async fn F_Stop_f() -> wresult_t< () > {
	crate::w_folder::F_Stop().await
}

#[tauri::command]
#[specta::specta]
pub async fn F_Forget_f( device: String ) -> wresult_t< () > {
	crate::w_folder::F_Forget( &device ).await
}

/*
==================
F_PickFolder_f

The system's folder picker, for the sync folder; none when the person
closed it
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn F_PickFolder_f( app: AppHandle, join: bool ) -> wresult_t< Option< crate::w_documents::pickedFolder_t > > {
	let result = crate::w_dialog::D_PickFolder( &app ).await.and_then( |p| p.map( |p| {
		Ok( crate::w_documents::pickedFolder_t { name: crate::w_documents::Doc_Name( &p )?, path: p.display().to_string() } )
	} ).transpose() );
	crate::w_documents::Doc_Report( &app, &result, |r| r.as_ref().map( |folder| crate::w_documents::documentResult_t::FOLDER { folder: folder.clone(), join: join } ) );
	result
}

#[tauri::command]
#[specta::specta]
pub async fn D_Result_f() -> wresult_t< Option< crate::w_documents::documentResult_t > > {
	crate::w_documents::Doc_Result()
}

#[tauri::command]
#[specta::specta]
pub async fn D_Clear_f( app: AppHandle ) -> wresult_t< () > {
	crate::w_documents::Doc_Clear( &app );
	Ok( () )
}

/*
==================
O_Pending_f / O_SaveRequest_f / O_Forget_f / O_Finish_f

Online: a view-only wallet's signing requests (w_offline.rs,
docs/OFFLINE-SIGNING.md). Save and Finish open the system's picker; none
when the person closed it.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn O_Pending_f() -> wresult_t< Vec< crate::w_offline::offlinePending_t > > {
	crate::w_offline::O_PendingHere().await
}

#[tauri::command]
#[specta::specta]
pub async fn O_SaveRequest_f( app: AppHandle, walletId: String, account: u32, request: sendRequest_t, seen: sendQuote_t ) -> wresult_t< crate::w_offline::offlineSaved_t > {
	let result = crate::w_offline::O_SaveRequest( &app, &walletId, account, request, seen ).await;
	crate::w_documents::Doc_Report( &app, &result, |r| match r {
		crate::w_offline::offlineSaved_t::SAVED { path } => Some( crate::w_documents::Doc_Saved( path, false ) ),
		_ => None,
	} );
	result
}

#[tauri::command]
#[specta::specta]
pub async fn O_Forget_f( id: String ) -> wresult_t< () > {
	crate::w_offline::O_Forget( &id ).await
}

#[tauri::command]
#[specta::specta]
pub async fn O_Finish_f( app: AppHandle ) -> wresult_t< Option< Vec< String > > > {
	let result = crate::w_offline::O_Finish( &app ).await;
	crate::w_documents::Doc_Report( &app, &result, |r| r.as_ref().map( |txids| crate::w_documents::documentResult_t::SENT { txids: txids.clone() } ) );
	result
}

/*
==================
O_Open_f / O_Sign_f / O_Close_f

Offline: a request opened and reviewed, then signed and saved
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn O_Open_f( app: AppHandle ) -> wresult_t< Option< crate::w_offline::offlineReview_t > > {
	let result = crate::w_offline::O_Open( &app ).await;
	crate::w_documents::Doc_Report( &app, &result, |r| r.as_ref().map( |review| crate::w_documents::documentResult_t::REVIEW { review: review.clone() } ) );
	result
}

#[tauri::command]
#[specta::specta]
pub async fn O_Sign_f( app: AppHandle, requestId: String, seen: sendQuote_t ) -> wresult_t< Option< String > > {
	let result = crate::w_offline::O_Sign( &app, &requestId, seen ).await;
	crate::w_documents::Doc_Report( &app, &result, |r| r.as_ref().map( |path| crate::w_documents::Doc_Saved( path, true ) ) );
	result
}

#[tauri::command]
#[specta::specta]
pub async fn O_Close_f() -> wresult_t< () > {
	crate::w_offline::O_Close();
	Ok( () )
}

/*
==================
Rp_List_f / Rp_Save_f / Rp_Remove_f / Rp_Done_f

Repeating payments: reminders, never sent by themselves (w_repeat.rs).
Done is paid or skipped: on to the following date.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn Rp_List_f() -> wresult_t< Vec< crate::w_repeat::repeat_t > > {
	crate::w_repeat::Rp_List().await
}

#[tauri::command]
#[specta::specta]
pub async fn Rp_Save_f( input: crate::w_repeat::repeatInput_t ) -> wresult_t< crate::w_repeat::repeat_t > {
	crate::w_repeat::Rp_Save( input ).await
}

#[tauri::command]
#[specta::specta]
pub async fn Rp_Remove_f( id: String ) -> wresult_t< () > {
	crate::w_repeat::Rp_Remove( &id ).await
}

#[tauri::command]
#[specta::specta]
pub async fn Rp_Done_f( id: String ) -> wresult_t< () > {
	crate::w_repeat::Rp_Done( &id ).await
}

/*
==================
W_ValueHistory_f

An account's worth in dollars over a range, only once the person turned
prices on
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_ValueHistory_f( id: String, account: u32, range: priceRange_t ) -> wresult_t< accountValue_t > {
	W_ValueHistory( &id, account, range ).await
}

/*
==================
W_SetWords_f

The ui's words for what rust says itself (errors, system notifications,
file pickers), in the ui's language, handed over once as it starts
==================
*/
#[tauri::command]
#[specta::specta]
pub fn W_SetWords_f( words: uiWords_t ) {
	W_SetWords( words );
}

/*
==================
Sk_Here_f

Whether Sapling's spend key is here, so a payment spending Sapling notes
needn't fetch it first (the review says when it will)
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn Sk_Here_f() -> bool {
	crate::w_spendkey::Sk_Here().await
}

/*
==================
P_Series_f

The ZEC price over a range, only once the person turned prices on
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn P_Series_f( range: priceRange_t ) -> wresult_t< priceSeries_t > {
	P_Series( range ).await
}

/*
==================
S_TestNotice_f

A sample notification, so the person sees what one looks like and that
the system lets Laurel show it
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn S_TestNotice_f( app: AppHandle ) -> wresult_t< () > {
	crate::w_notice::N_Sample( &app )
}

/*
==================
Ct_List_f / Ct_Save_f / Ct_Remove_f

The address book of the network Laurel is on: the most recently paid
first. Save adds (no id) or changes a contact, checking its address.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn Ct_List_f() -> wresult_t< Vec< contact_t > > {
	Ct_List().await
}

#[tauri::command]
#[specta::specta]
pub async fn Ct_Save_f( contact: contactInput_t ) -> wresult_t< contact_t > {
	Ct_Save( contact ).await
}

#[tauri::command]
#[specta::specta]
pub async fn Ct_Remove_f( id: String ) -> wresult_t< () > {
	Ct_Remove( &id ).await
}

/*
==================
W_ServerStatus_f

Automatic or the person's own, and the server the wallets use now
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_ServerStatus_f() -> wresult_t< serverStatus_t > {
	Ok( W_ServerStatus( w_registry.read().await.network ) )
}

/*
==================
W_SetServer_f

own: a server the person typed, checked before it's taken; None:
automatic. Every wallet reconnects.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_SetServer_f( app: AppHandle, own: Option< String > ) -> wresult_t< serverStatus_t > {
	let net = w_registry.read().await.network;
	W_SetServer( net, own ).await?;
	Sync_Reconnect( &app ).await;
	Ok( W_ServerStatus( net ) )
}

/*
==================
W_PlanMigration_f / W_MigrateNow_f / W_MigrationStatus_f

Orchard to Ironwood: what moving everything now would do, doing it if
that is still the plan (the new plan if not), and the progress of a
scheduled migration if the wallet has one
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_PlanMigration_f( id: String, account: u32 ) -> wresult_t< quoted_t< migratePlan_t > > {
	W_PlanMigration( &id, account ).await
}

#[tauri::command]
#[specta::specta]
pub async fn W_MigrateNow_f( id: String, account: u32, intent: String, seen: migratePlan_t ) -> wresult_t< migrateResult_t > {
	W_MigrateNow( &id, account, intent, seen ).await
}

#[tauri::command]
#[specta::specta]
pub async fn W_MigrationStatus_f( id: String ) -> wresult_t< migrationStatus_t > {
	W_MigrationStatus( &id ).await
}

/*
==================
W_Lock_f / W_RemoveWallet_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_Lock_f( app: AppHandle ) -> wresult_t< vaultStatus_t > {
	W_Lock( &app ).await
}

#[tauri::command]
#[specta::specta]
pub async fn W_RemoveWallet_f( id: String, password: Option< String > ) -> wresult_t< () > {
	let password = Zeroizing::new( password );
	let present = Com_Blocking( move || V_Confirm( password.as_deref() ) ).await?;
	W_RemoveWallet( &id, &present ).await
}

/*
==================
W_StartOver_f

Everything on this device erased, then Laurel opens again as on its
first run: a new process, so nothing kept in memory outlives the files.
Android can't restart a process (app.restart spawns the binary, then
exits as Sys_End explains): M_Restart asks the system to
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_StartOver_f( app: AppHandle ) -> wresult_t< () > {
	W_StartOver().await?;
	#[cfg( target_os = "android" )]
	{
		let _ = app;		// the system opens Laurel again, not this process
		crate::w_mobile::M_Restart()
	}
	#[cfg( not( target_os = "android" ) )]
	app.restart();
}

/*
==================
W_ParseScan_f

A scanned or pasted code: which address it is, and what it asks for
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_ParseScan_f( text: String ) -> wresult_t< scanned_t > {
	let net = w_registry.read().await.network;
	W_ParseScan( net, &text )
}

/*
==================
Nt_Save_f

A transaction's private note and category; empty text and none clear them
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn Nt_Save_f( txid: String, note: String, category: Option< txCategory_t > ) -> wresult_t< () > {
	crate::w_notes::Nt_Save( &txid, &note, category ).await
}

/*
==================
W_ExportCsv_f

An account's history as a CSV file in Downloads, shown in its folder;
memos only when asked for. Answers the file's name.
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_ExportCsv_f( app: AppHandle, id: String, account: u32, memos: bool ) -> wresult_t< String > {
	crate::w_export::W_ExportCsv( &app, &id, account, memos ).await
}

/*
==================
W_Request_f

A payment request (ZIP-321) for this account's own address
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_Request_f( id: String, account: u32, to: addressKind_t, zats: u64, memo: Option< String > ) -> wresult_t< String > {
	W_Request( &id, account, to, zats, memo ).await
}

/*
==================
W_RenameAccount_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_RenameAccount_f( id: String, index: u32, name: String ) -> wresult_t< () > {
	W_RenameAccount( &id, index, name ).await
}


/*
=========================================================================

RECOVERY PHRASES AND DATES

=========================================================================
*/

/*
==================
W_CheckPhrase_f

Called as each word is typed: every copy of the phrase so far is wiped as
it drops, like the password commands' (W1-08)
==================
*/
#[tauri::command]
#[specta::specta]
pub fn W_CheckPhrase_f( phrase: String ) -> phraseCheck_t {
	let phrase = Zeroizing::new( phrase );
	W_CheckPhrase( &phrase )
}

/*
==================
W_Wordlist_f
==================
*/
#[tauri::command]
#[specta::specta]
pub fn W_Wordlist_f() -> Vec< &'static str > {
	W_Wordlist()
}

/*
==================
W_HeightForDate_f
==================
*/
#[tauri::command]
#[specta::specta]
pub async fn W_HeightForDate_f( net: network_t, unixTime: u32 ) -> wresult_t< u32 > {
	W_HeightForDate( net, unixTime ).await
}
