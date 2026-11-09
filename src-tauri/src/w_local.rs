/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.

The wallet engine is zingolib, Copyright (C) 2022-present Zingolabs,
used under the MIT License.
===========================================================================
*/
// w_local.rs -- wallet engine definitions shared by all w_ and sync_ files
//
// SINGLE OWNER: every type marked specta::Type, every command in w_cmds.rs
// and every constant in W_Constants is exported to src/bindings.ts. The ui
// never declares its own copy; change it here and the ui stops compiling
// wherever it relied on the old shape.
//
// laurel keeps many wallets, each in its own directory:
//
//   <app data>/wallets/<network>/<wallet id>/laurel-wallet.dat	zingolib's file
//   <app data>/wallets/<network>/<wallet id>/laurel.json			our meta_t
//
// a wallet is one recovery phrase (or one viewing key). it holds one or
// more zip-32 accounts, and each account's money sits in the four pools.
//
// LOCKING: `w` maps wallet ids to per-wallet locks. Hold `w` only long
// enough to find a slot (W_Slot does exactly that), then lock the slot.
// Never lock `w` while holding a slot lock, or a waiting writer on `w`
// deadlocks against us.

use serde::{ Deserialize, Serialize };
use specta::Type;
use std::collections::{ BTreeMap, HashMap };
use std::path::PathBuf;
use std::sync::atomic::{ AtomicBool, AtomicU64 };
use std::sync::{ Arc, LazyLock, OnceLock };
use tokio::sync::{ Mutex, RwLock };
use zingolib::lightclient::LightClient;

pub const WALLET_FILE_NAME: &str		= "laurel-wallet.dat";
pub const META_FILE_NAME: &str			= "laurel.json";
pub const OLD_BACKUP_MARKER: &str		= "laurel-backed-up";	// pre multi-wallet, read once when migrating

pub const SERVER_FILE_NAME: &str		= "server.json";		// per network: the person's own server, if they chose one (w_server.rs)
pub const SERVER_TIMEOUT_SECS: u64		= 30;

// exported to the ui by W_Constants
pub const PHRASE_LENGTHS: [ u32; 5 ]	= [ 12, 15, 18, 21, 24 ];
pub const MAX_ACCOUNTS: u32				= 20;		// per wallet, far more than anyone keeps apart
pub const MAX_NAME_LEN: u32				= 40;
pub const NOTE_MAX_CHARS: u32			= 200;		// a contact's note, and a transaction's (Com_CleanNote)
pub const DEFAULT_WALLET_NAME: &str		= "My Wallet";
pub const DEFAULT_ACCOUNT_NAME: &str	= "Main";

// a birthday found from a date is moved this far back, so a wrong
// guess at the day costs a little scanning instead of missed funds
pub const BIRTHDAY_MARGIN_SECS: u32		= 14 * 24 * 60 * 60;


/*
=========================================================================

TYPES

=========================================================================
*/

#[derive( Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, Type )]
pub enum network_t {
	#[serde( rename = "mainnet" )]
	NET_MAINNET,
	#[serde( rename = "testnet" )]
	NET_TESTNET,
}

// the networks this build opens. The Play beta's (feature testnet-only) opens
// testnet alone: a request for mainnet is refused in the engine
// (W_NetworkOffered), whoever makes it, not only left out of the ui
pub const NETWORKS: &[ network_t ] = if cfg!( feature = "testnet-only" ) {
	&[ network_t::NET_TESTNET ]
} else {
	&[ network_t::NET_TESTNET, network_t::NET_MAINNET ]
};

// the same, as words kept in the engine's library: scripts/play_bundle.mjs reads
// them in the bundle Play gets, which must be the testnet build
pub const NETWORKS_MARK: &str = if cfg!( feature = "testnet-only" ) { "laurel-networks:testnet-only" } else { "laurel-networks:all" };

impl network_t {
	// as the person reads it, in messages
	pub fn Name( self ) -> &'static str {
		match self {
			network_t::NET_MAINNET => "Mainnet",
			network_t::NET_TESTNET => "Testnet",
		}
	}
}

#[derive( Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, Type )]
pub enum walletKind_t {
	#[serde( rename = "seed" )]
	WK_SEED,			// from a recovery phrase: can spend, can add accounts
	#[serde( rename = "viewOnly" )]
	WK_VIEWONLY,		// from a viewing key: sees everything, spends nothing
	#[serde( rename = "key" )]
	WK_KEY,				// zcashd's Sapling keys, an account each: spends, but receives nothing (no phrase backs it up)
}

// errors cross to the ui as errorInfo_t (Info), thrown by the command.
// Display and Debug are for logs and never carry what the person typed or
// who they pay: the specific text for the screen is built only by
// UiMessage. So no way of printing an error can leak it.
#[derive( thiserror::Error, Type )]
#[specta( type = String )]
pub enum werr_t {
	#[error( "That wallet isn't open." )]
	WERR_NO_WALLET,
	#[error( "That account doesn't exist." )]
	WERR_NO_ACCOUNT,
	#[error( "View-only wallets can't have more accounts. Restore the wallet from its recovery phrase to add one." )]
	WERR_VIEWONLY,
	#[error( "A wallet can hold up to {0} accounts." )]
	WERR_TOO_MANY_ACCOUNTS( u32 ),
	#[error( "Names can't be empty." )]
	WERR_EMPTY_NAME,
	#[error( "Another wallet is being added right now. Try again in a moment." )]
	WERR_BUSY,
	#[error( "Word {0} of that recovery phrase isn't a recovery phrase word." )]		// never the word: it's what was typed (Args takes it to the screen only)
	WERR_SEED_WORD( u32, String ),
	#[error( "Recovery phrases have 12, 15, 18, 21 or 24 words." )]
	WERR_SEED_LENGTH,
	#[error( "Every word is valid, but they don't form a recovery phrase together. Check the order, or look for a word swapped for a similar one." )]
	WERR_SEED_CHECKSUM,
	#[error( "That doesn't look like a viewing key for this network. It should start with \"{0}\"." )]
	WERR_VIEWKEY( &'static str ),
	#[error( "Laurel couldn't get an answer from the Zcash server." )]
	WERR_SERVER( String ),
	#[error( "The Zcash server is a moment behind the network. Laurel tries again shortly." )]
	WERR_SERVER_BEHIND,
	#[error( "This Zcash server can't serve everything syncing needs (Ironwood's data, or a current protocol). In automatic mode Laurel moves to another server; if you chose this one, choose another under Server in Settings." )]
	WERR_SERVER_OUTDATED( String ),
	#[error( "The Zcash network has upgraded, and this version of Laurel can't read it yet. Update Laurel to keep syncing. Your money is safe; only syncing waits." )]
	WERR_NETWORK_NEWER,
	#[error( "The Zcash server isn't answering in time. If an antivirus scans secure connections (HTTPS scanning), it can slow them down; otherwise the server may be busy." )]
	WERR_SERVER_SLOW,
	#[error( "Laurel cannot verify the server's certificate issuer. HTTPS scanning by antivirus or a proxy can cause this; the server may also have an incomplete certificate chain." )]
	WERR_INTERCEPTED,
	#[error( "Notifications are not allowed. Enable them for Laurel in your device's notification settings, then try again." )]
	#[cfg_attr( desktop, allow( dead_code ) )]		// asked for on phones only
	WERR_NOTIFICATIONS,
	#[error( "That doesn't look like a server address. It looks like https://example.com:443" )]
	WERR_SERVER_URL,
	#[error( "Laurel talks to a server only over a secure connection (https), unless the server runs on this device." )]
	WERR_SERVER_PLAIN,
	#[error( "That server is for {0}, but Laurel is on {1}." )]
	WERR_SERVER_NETWORK( String, &'static str ),
	#[error( "That address is already in your address book." )]		// the contact's name only in UiMessage
	WERR_CONTACT_EXISTS( String ),
	#[error( "Laurel isn't asking for prices. Turn them on first." )]
	WERR_PRICE_OFF,
	#[error( "CoinGecko is busy right now. Laurel tries again in a moment." )]
	WERR_PRICE_BUSY,
	#[error( "Couldn't get the ZEC price." )]
	WERR_PRICE( String ),
	#[error( "Laurel couldn't fetch Sapling's proving key. Spending Sapling money needs it, once: 48 MB from z.cash, checked before it's used. Check the internet connection, then try again." )]
	WERR_SPEND_KEY_FETCH( String ),
	#[error( "Spending Sapling money needs Sapling's proving key (sapling-spend.params, 48 MB), and it isn't on this device. Copy it from a computer that has Laurel or another Zcash wallet into {0}, then try again." )]
	WERR_SPEND_KEY_MISSING( String ),
	#[error( "Laurel is locked. Enter your password to unlock it." )]
	WERR_LOCKED,
	#[error( "A note holds at most {0} characters." )]
	WERR_NOTE_TOO_LONG( u32 ),
	#[error( "That password isn't right." )]
	WERR_BAD_PASSWORD,
	#[error( "Enter your password to do this." )]
	WERR_CONFIRM,
	#[error( "Use at least {0} characters." )]
	WERR_WEAK_PASSWORD( u32 ),
	#[error( "Laurel can't find the key that unlocks your wallets (laurel-vault.json). If you have a backup of that file, put it back where it was. Otherwise, restore each wallet from its recovery phrase." )]
	WERR_VAULT_MISSING,
	#[error( "Laurel couldn't save its key safely, so it changed nothing. Check that the disk has room, then try again." )]
	WERR_VAULT_WRITE,
	#[error( "These wallets were saved by a newer version of Laurel. Update Laurel to open them." )]
	WERR_VAULT_NEWER,
	#[error( "Windows couldn't unlock Laurel's key ({0}). This happens when Laurel's files are copied from another computer or Windows account. Restore your wallets from their recovery phrases." )]
	#[cfg_attr( not( windows ), allow( dead_code ) )]		// only Windows' key store raises it
	WERR_OS_KEY( String ),
	#[error( "This system has no secure key store Laurel can use yet, so Laurel needs a password." )]
	#[cfg_attr( windows, allow( dead_code ) )]		// only raised where there is no key store
	WERR_NO_OS_PROTECTION,
	#[error( "That isn't a Zcash address or payment request." )]
	WERR_NOT_ZCASH,
	#[error( "That's a {0} address, but Laurel is on {1}. Coins can't move between the two." )]
	WERR_WRONG_NETWORK( &'static str, &'static str ),
	#[error( "{0} addresses can't receive payments any more." )]
	WERR_OLD_ADDRESS( &'static str ),
	#[error( "Laurel is in the middle of a sync step. Try again in a moment." )]
	WERR_SYNC_BUSY,
	#[error( "This wallet's saved sync data has a problem Laurel couldn't repair by checking again. Restoring the wallet from its recovery phrase fixes it." )]
	WERR_SYNC_DATA( String ),
	#[error( "Enter an amount above zero." )]
	WERR_NO_AMOUNT,
	#[error( "Public addresses can't receive a memo. Remove it, or pay a private address." )]
	WERR_MEMO_PUBLIC,
	#[error( "That memo is too long: {0} bytes, and a memo holds 512." )]
	WERR_MEMO_TOO_LONG( usize ),
	#[error( "Public money can't be sent directly. Shield it first, then send it privately." )]
	WERR_FROM_PUBLIC,
	#[error( "There isn't enough money in this account for this amount plus the network fee." )]
	WERR_NOT_ENOUGH,
	#[error( "There isn't enough money in that pool for this amount plus the network fee." )]
	WERR_NOT_ENOUGH_POOL,
	#[error( "The public money here is less than the network fee to shield it. It can be shielded once more arrives." )]
	WERR_SHIELD_BELOW_FEE,
	#[error( "There's no Orchard money in this account to move." )]
	WERR_NOTHING_TO_MIGRATE,
	#[error( "This test version of Laurel doesn't start moving Orchard money to Ironwood yet. Your Orchard money stays where it is, safe." )]
	WERR_MIGRATE_OFF,
	#[error( "There's no Sapling money in this account to move." )]
	WERR_NOTHING_TO_MOVE,
	#[error( "The Sapling money here is less than the network fee to move it. It stays private where it is." )]
	WERR_MOVE_BELOW_FEE,
	#[error( "This wallet only views, so it can't move money. The device with its recovery phrase can." )]
	WERR_VIEWONLY_MOVE,
	#[error( "This wallet only views, so it can't sign a payment. Save a signing request, and sign it on the device with the recovery phrase." )]
	WERR_VIEWONLY_SPEND,
	#[error( "This wallet came from zcashd keys, and its private pool here isn't backed up by any recovery phrase. Send the money to a wallet that has one instead." )]
	WERR_KEY_WALLET_MOVE,
	#[error( "Locking needs a password. Turn one on in Settings first." )]
	WERR_NO_PASSWORD,
	#[error( "Laurel is still checking the newest blocks for your money. Payments can be made as soon as it's done, usually in a moment." )]
	WERR_CATCHING_UP,
	#[error( "There's no public money in this account to shield." )]
	WERR_NOTHING_TO_SHIELD,
	#[error( "This payment was already sent, or what you reviewed is out of date. Review it again before sending." )]
	WERR_PAYMENT_DONE,
	#[error( "That payment request asks for {0} payments without saying how much each one is. Laurel only pays what it can show you exactly." )]
	WERR_MULTI_PAYMENT( u32 ),
	#[error( "One payment can pay at most {0} people. Split it into more than one." )]
	WERR_TOO_MANY_PAYMENTS( u32 ),
	#[error( "Block {0} hasn't been made yet: the newest is {1}. Check the number, or choose a month instead." )]
	WERR_BIRTHDAY_AHEAD( u32, u32 ),
	#[error( "\"Max\" sends everything to one person. With more than one, enter each amount." )]
	WERR_MAX_ONE,
	#[error( "That isn't a private key, or it has a typo. Check it letter by letter: capitals count." )]
	WERR_KEY_TYPO,
	#[error( "That's a {0} private key, but Laurel is on {1}." )]
	WERR_KEY_NETWORK( &'static str, &'static str ),
	#[error( "That's an older, uncompressed private key. Laurel can't sweep those yet." )]
	WERR_KEY_UNCOMPRESSED,
	#[error( "There's no money at this key's address. If you expected some, it may have been moved already." )]
	WERR_KEY_EMPTY,
	#[error( "The money at this key is less than the network fee to move it." )]
	WERR_KEY_TOO_SMALL( u64, u64 ),
	#[error( "This account has no public address to receive into." )]
	WERR_NO_PUBLIC_ADDRESS,
	#[error( "This account has no Sapling address to give: its viewing key has no Sapling part." )]
	WERR_NO_SAPLING_ADDRESS,
	#[error( "This wallet's viewing key has no private part, so it has no private address to give." )]
	WERR_NO_SHIELDED_KEYS,
	#[error( "The Zcash network refused this transaction." )]
	WERR_REJECTED( String ),
	#[error( "Laurel can't tell whether this payment went out. Don't send it again: Laurel sends this same payment once this wallet has caught up, and if it never gets in, the money comes back by itself." )]
	WERR_SENT_UNSURE( String ),
	#[error( "This payment is signed and waiting: Laurel couldn't write the wallet to disk, and sends it once it can (free up disk space, or check your antivirus). Don't send it again: it would be a second payment." )]
	WERR_SEND_QUEUED( String ),		// its txid, for the log; never a Try Again
	#[error( "Laurel can't tell whether the sweep went out. Look at this wallet's history in a few minutes before sweeping again: the same coins can only be swept once." )]
	WERR_SWEEP_UNSURE( String ),
	#[error( "Laurel can't tell whether this signed payment went out. Don't sign another: it shows here once it's in, and you can send this same file again meanwhile. Until it shows up, or its time to be mined has passed, this account makes no new request." )]
	WERR_OFFLINE_SENT_UNSURE( String ),
	#[error( "A payment signed for this account may already have gone out. Laurel makes no new request from it until that payment shows up here, or its time to be mined has passed (about an hour)." )]
	WERR_OFFLINE_UNSURE,
	#[error( "This wallet holds keys imported from zcashd, so it doesn't receive: nothing backs up its new addresses. Receive into a wallet with a recovery phrase, and move this one's money there." )]
	WERR_KEY_WALLET_RECEIVE,
	#[error( "A wallet of imported zcashd keys has one account per key. To add one, import its key." )]
	WERR_KEY_WALLET_ACCOUNTS,
	#[error( "There's no zcashd Sapling key (secret-extended-key…) in what you pasted." )]
	WERR_ZCASHD_NONE,
	#[error( "A key in what you pasted has a typo. Copy it again from zcashd, whole." )]
	WERR_ZCASHD_TYPO,
	#[error( "Those are Sprout keys (SK…). Laurel can't import Sprout: move that money with Zallet first." )]
	WERR_ZCASHD_SPROUT,
	#[error( "That wallet is already on this device." )]		// its name only in UiMessage
	WERR_WALLET_EXISTS( String ),
	#[error( "That was asked for {0}, but Laurel is on {1}." )]
	WERR_NETWORK( &'static str, &'static str ),
	#[error( "This version of Laurel is for test coins only, and doesn't open {0}." )]
	WERR_NETWORK_OFF( &'static str ),
	#[error( "A file Laurel keeps is damaged: {0}." )]
	WERR_CORRUPT( file_t ),
	#[error( "This file isn't a Laurel encrypted file, or it was cut short." )]
	WERR_NOT_SEALED,
	#[error( "This file is damaged, or was encrypted with a different key." )]
	WERR_WRONG_KEY,
	#[error( "That sync code isn't right. Check it against the one your other device showed." )]		// never the code itself
	WERR_SYNC_CODE,
	#[error( "Laurel can't reach the sync folder. If it's on a drive or a USB stick, connect it and try again." )]
	WERR_SYNC_FOLDER,
	#[error( "A device syncing with this one runs a newer Laurel. Update Laurel here to keep syncing." )]
	WERR_SYNC_NEWER,
	#[error( "Sync is already on for this device. Stop it first to start again." )]
	WERR_SYNC_ON,
	#[error( "Opening and saving files isn't available in Laurel for iPhone yet. Use Laurel on a computer or an Android phone for this." )]
	#[cfg_attr( not( target_os = "ios" ), allow( dead_code ) )]		// only iOS has no document picker yet
	WERR_NO_FILES,
	#[error( "This signed payment spends money this wallet doesn't hold. It wasn't sent." )]
	WERR_OFFLINE_FOREIGN_INPUT,
	#[error( "This signed payment doesn't pay what was requested. It wasn't sent. If nothing was changed on purpose, don't use the offline computer until you know why." )]
	WERR_OFFLINE_MISMATCH,
	#[error( "This signed payment moves money the viewing key can't see. It wasn't sent. Don't use the offline computer until you know why." )]
	WERR_OFFLINE_HIDDEN,
	#[error( "This isn't a Laurel signing file, or it was damaged in copying. Copy it again." )]
	WERR_OFFLINE_FILE,
	#[error( "This file was made by a newer Laurel. Update Laurel on this computer to use it." )]
	WERR_OFFLINE_NEWER,
	#[error( "This wallet can send by itself: use Send. Signing on another computer is for wallets added with a viewing key." )]
	WERR_OFFLINE_CAN_SEND,
	#[error( "This payment takes two transactions (an exchange-only address), which can't be signed on another computer yet. Send it from a wallet with its recovery phrase." )]
	WERR_OFFLINE_TWO_STEPS,
	#[error( "This signed payment isn't for a request made on this computer, or that request was already sent or forgotten." )]
	WERR_OFFLINE_NOT_OURS,
	#[error( "No wallet on this computer can sign this request. Restore the wallet from its recovery phrase here first." )]
	WERR_OFFLINE_NO_SIGNER,
	#[error( "The matching wallet on this computer only views. Signing needs the wallet restored from its recovery phrase." )]
	WERR_OFFLINE_SIGNER_VIEWS,
	#[error( "Something went wrong inside Laurel's wallet engine." )]
	WERR_ENGINE( String ),
	// an error from handling what the person typed (a phrase, a viewing key):
	// the engine's words may quote it, so they reach the screen, never the log
	#[error( "{0}" )]
	WERR_TYPED( Box< werr_t > ),
}

impl std::fmt::Debug for werr_t {
	fn fmt( &self, f: &mut std::fmt::Formatter< '_ > ) -> std::fmt::Result {
		f.write_str( &self.LogText() )
	}
}

/*
==================
file_t

Laurel's own files, by what they hold. An error names one by this, and
the screen says it in its language (uiWords_t.files); the log, as Name.
==================
*/
#[derive( Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type )]
pub enum file_t {
	#[serde( rename = "wallet" )]		FILE_WALLET,
	#[serde( rename = "meta" )]			FILE_META,
	#[serde( rename = "vault" )]		FILE_VAULT,
	#[serde( rename = "contacts" )]		FILE_CONTACTS,
	#[serde( rename = "notes" )]		FILE_NOTES,
	#[serde( rename = "repeats" )]		FILE_REPEATS,
	#[serde( rename = "alerts" )]		FILE_ALERTS,
	#[serde( rename = "settings" )]		FILE_SETTINGS,
	#[serde( rename = "server" )]		FILE_SERVER,
	#[serde( rename = "sync" )]			FILE_SYNC,
	#[serde( rename = "requests" )]		FILE_REQUESTS,
}

impl file_t {
	pub fn Name( self ) -> &'static str {
		match self {
			file_t::FILE_WALLET		=> "the wallet file",
			file_t::FILE_META		=> "this wallet's names (laurel.json)",
			file_t::FILE_VAULT		=> "Laurel's key file (laurel-vault.json)",
			file_t::FILE_CONTACTS	=> "Laurel's address book (contacts.json)",
			file_t::FILE_NOTES		=> "Laurel's transaction notes (notes.json)",
			file_t::FILE_REPEATS	=> "Laurel's repeating payments (repeats.json)",
			file_t::FILE_ALERTS		=> "Laurel's price alerts file (price-alerts.json)",
			file_t::FILE_SETTINGS	=> "Laurel's settings (laurel-settings.json)",
			file_t::FILE_SERVER		=> "Laurel's server choice (server.json)",
			file_t::FILE_SYNC		=> "Laurel's sync settings (sync-state.json)",
			file_t::FILE_REQUESTS	=> "Laurel's signing requests (offline-requests.json)",
		}
	}
}

impl std::fmt::Display for file_t {
	fn fmt( &self, f: &mut std::fmt::Formatter< '_ > ) -> std::fmt::Result {
		f.write_str( self.Name() )
	}
}

/*
==================
uiWords_t / W_SetWords / W_Words

Every word the screen shows is the ui's (ui_text.ts), in its language.
What rust says itself, errors and system notifications, it says in those
words: the ui hands them over once, as it starts (W_SetWords_f). Until
then, and for any it lacks, rust's English: the log's words, and never
nothing on the screen.
==================
*/
#[derive( Clone, Debug, Default, Deserialize, Type )]
pub struct uiWords_t {
	pub errors:		HashMap< String, String >,		// werr_t's name (Code) to its sentence; {0}, {1} are its values (Args)
	pub files:		HashMap< file_t, String >,		// what each of Laurel's files is called
	pub notices:	noticeWords_t,
}

// what system notifications and the file pickers say
#[derive( Clone, Debug, Default, Deserialize, Type )]
pub struct noticeWords_t {
	pub received:		String,
	pub sent:			String,
	pub failed:			String,
	pub sample:			String,
	pub due:			String,
	pub rose:			String,		// {0}: the price asked about
	pub fell:			String,		// {0}: the price asked about
	pub priceNow:		String,		// {0}: the price now
	pub requestFile:	String,
	pub signedFile:		String,
}

static w_words: std::sync::RwLock< Option< uiWords_t > > = std::sync::RwLock::new( None );

pub fn W_SetWords( words: uiWords_t ) {
	*w_words.write().unwrap_or_else( |e| e.into_inner() ) = Some( words );
}

pub fn W_Words< R >( pick: impl FnOnce( &uiWords_t ) -> Option< R > ) -> Option< R > {
	w_words.read().unwrap_or_else( |e| e.into_inner() ).as_ref().and_then( pick )
}

// a sentence of the ui's with its values put in: {0}, {1}, ... in one pass, so a
// value holding "{1}" (a server's own chain name, say) is never filled in again
pub fn Com_Fill( template: &str, values: &[ String ] ) -> String {
	let mut out = String::with_capacity( template.len() );
	let mut rest = template;
	while let Some( open ) = rest.find( '{' ) {
		out.push_str( &rest[..open] );
		let after = &rest[open + 1..];
		let index = after.find( '}' ).and_then( |close| after[..close].parse::< usize >().ok().map( |i| ( i, close ) ) );
		match index.and_then( |( i, close )| values.get( i ).map( |v| ( v, close ) ) ) {
			Some( ( v, close ) ) => {
				out.push_str( v );
				rest = &after[close + 1..];
			}
			None => {
				out.push( '{' );
				rest = after;
			}
		}
	}
	out.push_str( rest );
	out
}

// a notice's words, or rust's own before the ui has said them
pub fn W_Notice( pick: impl FnOnce( &noticeWords_t ) -> &String, english: &str ) -> String {
	W_Words( |w| Some( pick( &w.notices ).clone() ) ).filter( |t| !t.is_empty() ).unwrap_or_else( || english.to_string() )
}

// an error as the ui gets it: a message in words, and the engine's or the
// server's own text, if any, for a "Details" disclosure. Never the raw text
// as the message: it was once a wall of Hash(\"a80c...\") in an alert.
#[derive( Clone, Debug, PartialEq, Serialize, Deserialize, Type )]
pub struct errorInfo_t {
	pub message:	String,
	pub detail:		Option< String >,
	pub retry:		bool,		// trying again in a moment can work, so the ui may, on its own
}

impl werr_t {
	/*
	==================
	werr_t::Code / werr_t::Args

	An error as the ui's text knows it: its name, and the values its
	sentence has room for ({0}, {1}), in order. A value that is a detail
	(a server's own words) goes under Details instead, never in a
	sentence. Every kind is decided here, with no default: a new one
	doesn't compile until it is. check_owners holds ui_text.ts's errors
	to these names and to how many values each has.
	==================
	*/
	pub fn Code( &self ) -> &'static str {
		macro_rules! named {
			( $( $v:ident ),* $(,)? ) => { match self { $( werr_t::$v { .. } => stringify!( $v ), )* } };
		}
		named!( WERR_NO_WALLET, WERR_NO_ACCOUNT, WERR_VIEWONLY, WERR_TOO_MANY_ACCOUNTS, WERR_EMPTY_NAME, WERR_BUSY, WERR_SEED_WORD, WERR_SEED_LENGTH, WERR_SEED_CHECKSUM, WERR_VIEWKEY, WERR_SERVER, WERR_SERVER_BEHIND, WERR_SERVER_OUTDATED, WERR_NETWORK_NEWER, WERR_SERVER_SLOW, WERR_INTERCEPTED, WERR_NOTIFICATIONS, WERR_SERVER_URL, WERR_SERVER_PLAIN, WERR_SERVER_NETWORK, WERR_CONTACT_EXISTS, WERR_PRICE_OFF, WERR_PRICE_BUSY, WERR_PRICE, WERR_SPEND_KEY_FETCH, WERR_SPEND_KEY_MISSING, WERR_LOCKED, WERR_NOTE_TOO_LONG, WERR_BAD_PASSWORD, WERR_CONFIRM, WERR_WEAK_PASSWORD, WERR_VAULT_MISSING, WERR_VAULT_WRITE, WERR_VAULT_NEWER, WERR_OS_KEY, WERR_NO_OS_PROTECTION, WERR_NOT_ZCASH, WERR_WRONG_NETWORK, WERR_OLD_ADDRESS, WERR_SYNC_BUSY, WERR_SYNC_DATA, WERR_NO_AMOUNT, WERR_MEMO_PUBLIC, WERR_MEMO_TOO_LONG, WERR_FROM_PUBLIC, WERR_NOT_ENOUGH, WERR_NOT_ENOUGH_POOL, WERR_SHIELD_BELOW_FEE, WERR_NOTHING_TO_MIGRATE, WERR_MIGRATE_OFF, WERR_NOTHING_TO_MOVE, WERR_MOVE_BELOW_FEE, WERR_VIEWONLY_MOVE, WERR_VIEWONLY_SPEND, WERR_KEY_WALLET_MOVE, WERR_NO_PASSWORD, WERR_CATCHING_UP, WERR_NOTHING_TO_SHIELD, WERR_PAYMENT_DONE, WERR_MULTI_PAYMENT, WERR_TOO_MANY_PAYMENTS, WERR_BIRTHDAY_AHEAD, WERR_MAX_ONE, WERR_KEY_TYPO, WERR_KEY_NETWORK, WERR_KEY_UNCOMPRESSED, WERR_KEY_EMPTY, WERR_KEY_TOO_SMALL, WERR_NO_PUBLIC_ADDRESS, WERR_NO_SAPLING_ADDRESS, WERR_NO_SHIELDED_KEYS, WERR_REJECTED, WERR_SENT_UNSURE, WERR_SEND_QUEUED, WERR_SWEEP_UNSURE, WERR_OFFLINE_SENT_UNSURE, WERR_OFFLINE_UNSURE, WERR_KEY_WALLET_RECEIVE, WERR_KEY_WALLET_ACCOUNTS, WERR_ZCASHD_NONE, WERR_ZCASHD_TYPO, WERR_ZCASHD_SPROUT, WERR_WALLET_EXISTS, WERR_NETWORK, WERR_NETWORK_OFF, WERR_CORRUPT, WERR_NOT_SEALED, WERR_WRONG_KEY, WERR_SYNC_CODE, WERR_SYNC_FOLDER, WERR_SYNC_NEWER, WERR_SYNC_ON, WERR_NO_FILES, WERR_OFFLINE_FOREIGN_INPUT, WERR_OFFLINE_MISMATCH, WERR_OFFLINE_HIDDEN, WERR_OFFLINE_FILE, WERR_OFFLINE_NEWER, WERR_OFFLINE_CAN_SEND, WERR_OFFLINE_TWO_STEPS, WERR_OFFLINE_NOT_OURS, WERR_OFFLINE_NO_SIGNER, WERR_OFFLINE_SIGNER_VIEWS, WERR_ENGINE, WERR_TYPED )
	}

	pub fn Args( &self ) -> Vec< String > {
		match self {
			werr_t::WERR_NO_WALLET => vec![],
			werr_t::WERR_NO_ACCOUNT => vec![],
			werr_t::WERR_VIEWONLY => vec![],
			werr_t::WERR_TOO_MANY_ACCOUNTS( a ) => vec![ a.to_string() ],
			werr_t::WERR_EMPTY_NAME => vec![],
			werr_t::WERR_BUSY => vec![],
			werr_t::WERR_SEED_WORD( a, b ) => vec![ a.to_string(), b.clone() ],
			werr_t::WERR_SEED_LENGTH => vec![],
			werr_t::WERR_SEED_CHECKSUM => vec![],
			werr_t::WERR_VIEWKEY( a ) => vec![ a.to_string() ],
			werr_t::WERR_SERVER( _ ) => vec![],
			werr_t::WERR_SERVER_BEHIND => vec![],
			werr_t::WERR_SERVER_OUTDATED( _ ) => vec![],
			werr_t::WERR_NETWORK_NEWER => vec![],
			werr_t::WERR_SERVER_SLOW => vec![],
			werr_t::WERR_INTERCEPTED => vec![],
			werr_t::WERR_NOTIFICATIONS => vec![],
			werr_t::WERR_SERVER_URL => vec![],
			werr_t::WERR_SERVER_PLAIN => vec![],
			werr_t::WERR_SERVER_NETWORK( a, b ) => vec![ a.clone(), b.to_string() ],
			werr_t::WERR_CONTACT_EXISTS( a ) => vec![ a.clone() ],
			werr_t::WERR_PRICE_OFF => vec![],
			werr_t::WERR_PRICE_BUSY => vec![],
			werr_t::WERR_PRICE( _ ) => vec![],
			werr_t::WERR_SPEND_KEY_FETCH( _ ) => vec![],
			werr_t::WERR_SPEND_KEY_MISSING( a ) => vec![ a.clone() ],
			werr_t::WERR_LOCKED => vec![],
			werr_t::WERR_NOTE_TOO_LONG( a ) => vec![ a.to_string() ],
			werr_t::WERR_BAD_PASSWORD => vec![],
			werr_t::WERR_CONFIRM => vec![],
			werr_t::WERR_WEAK_PASSWORD( a ) => vec![ a.to_string() ],
			werr_t::WERR_VAULT_MISSING => vec![],
			werr_t::WERR_VAULT_WRITE => vec![],
			werr_t::WERR_VAULT_NEWER => vec![],
			werr_t::WERR_OS_KEY( a ) => vec![ a.clone() ],
			werr_t::WERR_NO_OS_PROTECTION => vec![],
			werr_t::WERR_NOT_ZCASH => vec![],
			werr_t::WERR_WRONG_NETWORK( a, b ) => vec![ a.to_string(), b.to_string() ],
			werr_t::WERR_OLD_ADDRESS( a ) => vec![ a.to_string() ],
			werr_t::WERR_SYNC_BUSY => vec![],
			werr_t::WERR_SYNC_DATA( _ ) => vec![],
			werr_t::WERR_NO_AMOUNT => vec![],
			werr_t::WERR_MEMO_PUBLIC => vec![],
			werr_t::WERR_MEMO_TOO_LONG( a ) => vec![ a.to_string() ],
			werr_t::WERR_FROM_PUBLIC => vec![],
			werr_t::WERR_NOT_ENOUGH => vec![],
			werr_t::WERR_NOT_ENOUGH_POOL => vec![],
			werr_t::WERR_SHIELD_BELOW_FEE => vec![],
			werr_t::WERR_NOTHING_TO_MIGRATE => vec![],
			werr_t::WERR_MIGRATE_OFF => vec![],
			werr_t::WERR_NOTHING_TO_MOVE => vec![],
			werr_t::WERR_MOVE_BELOW_FEE => vec![],
			werr_t::WERR_VIEWONLY_MOVE => vec![],
			werr_t::WERR_VIEWONLY_SPEND => vec![],
			werr_t::WERR_KEY_WALLET_MOVE => vec![],
			werr_t::WERR_NO_PASSWORD => vec![],
			werr_t::WERR_CATCHING_UP => vec![],
			werr_t::WERR_NOTHING_TO_SHIELD => vec![],
			werr_t::WERR_PAYMENT_DONE => vec![],
			werr_t::WERR_MULTI_PAYMENT( a ) => vec![ a.to_string() ],
			werr_t::WERR_TOO_MANY_PAYMENTS( a ) => vec![ a.to_string() ],
			werr_t::WERR_BIRTHDAY_AHEAD( a, b ) => vec![ a.to_string(), b.to_string() ],
			werr_t::WERR_MAX_ONE => vec![],
			werr_t::WERR_KEY_TYPO => vec![],
			werr_t::WERR_KEY_NETWORK( a, b ) => vec![ a.to_string(), b.to_string() ],
			werr_t::WERR_KEY_UNCOMPRESSED => vec![],
			werr_t::WERR_KEY_EMPTY => vec![],
			werr_t::WERR_KEY_TOO_SMALL( _, _ ) => vec![],
			werr_t::WERR_NO_PUBLIC_ADDRESS => vec![],
			werr_t::WERR_NO_SAPLING_ADDRESS => vec![],
			werr_t::WERR_NO_SHIELDED_KEYS => vec![],
			werr_t::WERR_REJECTED( _ ) => vec![],
			werr_t::WERR_SENT_UNSURE( _ ) => vec![],
			werr_t::WERR_SWEEP_UNSURE( _ ) => vec![],
			werr_t::WERR_SEND_QUEUED( _ ) => vec![],
			werr_t::WERR_OFFLINE_SENT_UNSURE( _ ) => vec![],
			werr_t::WERR_OFFLINE_UNSURE => vec![],
			werr_t::WERR_KEY_WALLET_RECEIVE => vec![],
			werr_t::WERR_KEY_WALLET_ACCOUNTS => vec![],
			werr_t::WERR_ZCASHD_NONE => vec![],
			werr_t::WERR_ZCASHD_TYPO => vec![],
			werr_t::WERR_ZCASHD_SPROUT => vec![],
			werr_t::WERR_WALLET_EXISTS( a ) => vec![ a.clone() ],
			werr_t::WERR_NETWORK( a, b ) => vec![ a.to_string(), b.to_string() ],
			werr_t::WERR_NETWORK_OFF( a ) => vec![ a.to_string() ],
			werr_t::WERR_CORRUPT( a ) => vec![ a.Name().to_string() ],		// named in the screen's words by UiMessageIn
			werr_t::WERR_NOT_SEALED => vec![],
			werr_t::WERR_WRONG_KEY => vec![],
			werr_t::WERR_SYNC_CODE => vec![],
			werr_t::WERR_SYNC_FOLDER => vec![],
			werr_t::WERR_SYNC_NEWER => vec![],
			werr_t::WERR_SYNC_ON => vec![],
			werr_t::WERR_NO_FILES => vec![],
			werr_t::WERR_OFFLINE_FOREIGN_INPUT => vec![],
			werr_t::WERR_OFFLINE_MISMATCH => vec![],
			werr_t::WERR_OFFLINE_HIDDEN => vec![],
			werr_t::WERR_OFFLINE_FILE => vec![],
			werr_t::WERR_OFFLINE_NEWER => vec![],
			werr_t::WERR_OFFLINE_CAN_SEND => vec![],
			werr_t::WERR_OFFLINE_TWO_STEPS => vec![],
			werr_t::WERR_OFFLINE_NOT_OURS => vec![],
			werr_t::WERR_OFFLINE_NO_SIGNER => vec![],
			werr_t::WERR_OFFLINE_SIGNER_VIEWS => vec![],
			werr_t::WERR_ENGINE( _ ) => vec![],
			werr_t::WERR_TYPED( inner ) => inner.Args(),
		}
	}
}

impl werr_t {
	/*
	==================
	werr_t::Typed

	Marks an error from handling typed secrets: shown whole, logged by kind
	==================
	*/
	pub fn Typed( e: werr_t ) -> werr_t {
		werr_t::WERR_TYPED( Box::new( e ) )
	}

	/*
	==================
	werr_t::Detail

	The raw text behind a message that the log may keep, when there is one
	==================
	*/
	pub fn Detail( &self ) -> Option< &str > {
		match self {
			werr_t::WERR_SERVER( d ) | werr_t::WERR_SERVER_OUTDATED( d ) | werr_t::WERR_SYNC_DATA( d ) | werr_t::WERR_PRICE( d ) | werr_t::WERR_SPEND_KEY_FETCH( d ) | werr_t::WERR_ENGINE( d ) | werr_t::WERR_REJECTED( d ) | werr_t::WERR_SENT_UNSURE( d ) | werr_t::WERR_SWEEP_UNSURE( d ) | werr_t::WERR_OFFLINE_SENT_UNSURE( d ) => Some( d ),
			_ => None,		// WERR_TYPED's is for the screen only (UiDetail)
		}
	}

	/*
	==================
	werr_t::UiMessage / werr_t::UiDetail

	What the screen says: the specific words where the person needs them
	(which phrase word to fix, whose address it is). The only place those
	become text.
	==================
	*/
	pub fn UiMessage( &self ) -> String {
		self.UiMessageIn( w_words.read().unwrap_or_else( |e| e.into_inner() ).as_ref() )
	}

	// the same in the words given: the ui's (UiMessage), or a test's own
	pub fn UiMessageIn( &self, words: Option< &uiWords_t > ) -> String {
		if let werr_t::WERR_TYPED( inner ) = self {
			return inner.UiMessageIn( words );
		}
		if let Some( ( sentence, w ) ) = words.and_then( |w| w.errors.get( self.Code() ).map( |s| ( s, w ) ) ) {
			let values = match self {
				werr_t::WERR_CORRUPT( f ) => vec![ w.files.get( f ).cloned().unwrap_or_else( || f.Name().to_string() ) ],
				_ => self.Args(),
			};
			return Com_Fill( sentence, &values );
		}
		// before the ui has said its words (it says them first, as it starts): rust's own
		// English, which never names what was typed
		self.to_string()
	}

	pub fn UiDetail( &self ) -> Option< String > {
		match self {
			werr_t::WERR_TYPED( inner )	=> inner.UiDetail(),
			other						=> other.Detail().map( str::to_string ),
		}
	}

	/*
	==================
	werr_t::Retryable

	Passing states of the engine or the network, not of what was asked:
	the same request, a moment later, can work
	==================
	*/
	pub fn Retryable( &self ) -> bool {
		match self {
			werr_t::WERR_TYPED( inner ) => inner.Retryable(),
			other => matches!( other, werr_t::WERR_SYNC_BUSY | werr_t::WERR_CATCHING_UP | werr_t::WERR_SERVER_SLOW | werr_t::WERR_SERVER_BEHIND | werr_t::WERR_PRICE_BUSY ),
		}
	}

	pub fn Info( &self ) -> errorInfo_t {
		errorInfo_t {
			message:	self.UiMessage(),
			detail:		self.UiDetail(),
			retry:		self.Retryable(),
		}
	}
}

impl werr_t {
	/*
	==================
	werr_t::LogText

	What the log may keep of this error, decided for each kind with no
	default: some are built from what the person typed (a mistyped phrase
	word gives the real one away) or from who they pay, and a log file on
	disk must never hold those. A new kind of error must be decided here.
	Debug prints this too, so {e:?} is safe as well as {e}.
	==================
	*/
	pub fn LogText( &self ) -> String {
		use werr_t::*;

		let whole = || format!( "{self}{}", self.Detail().map_or( String::new(), |d| format!( " ({d})" ) ) );
		match self {
			// what the person typed, or who they pay: the kind, never the words
			WERR_SEED_WORD( n, _ )		=> format!( "WERR_SEED_WORD: word {n} of the recovery phrase isn't a phrase word (the word is not logged)" ),
			WERR_CONTACT_EXISTS( _ )	=> "WERR_CONTACT_EXISTS: that address already has a contact (the name is not logged)".to_string(),
			WERR_WALLET_EXISTS( _ )		=> "WERR_WALLET_EXISTS: that wallet is already on this computer (its name is not logged)".to_string(),
			WERR_TYPED( inner )			=> format!( "{inner} (its detail is not logged: it may quote what was typed)" ),

			// Laurel's own words, the engine's or the server's: nothing the person typed
			WERR_NO_WALLET | WERR_NO_ACCOUNT | WERR_VIEWONLY | WERR_TOO_MANY_ACCOUNTS( _ ) | WERR_EMPTY_NAME | WERR_BUSY
			| WERR_VIEWKEY( _ ) | WERR_SERVER( _ ) | WERR_SERVER_OUTDATED( _ ) | WERR_NETWORK_NEWER | WERR_SERVER_BEHIND | WERR_SERVER_SLOW | WERR_INTERCEPTED | WERR_NOTIFICATIONS | WERR_SERVER_URL
			| WERR_SERVER_PLAIN | WERR_SERVER_NETWORK( _, _ ) | WERR_LOCKED | WERR_BAD_PASSWORD | WERR_CONFIRM | WERR_NOTE_TOO_LONG( _ ) | WERR_WEAK_PASSWORD( _ )
			| WERR_VAULT_MISSING | WERR_VAULT_NEWER | WERR_VAULT_WRITE | WERR_OS_KEY( _ ) | WERR_NO_OS_PROTECTION | WERR_NOT_ZCASH
			| WERR_WRONG_NETWORK( _, _ ) | WERR_OLD_ADDRESS( _ ) | WERR_SYNC_BUSY | WERR_SYNC_DATA( _ ) | WERR_NO_AMOUNT
			| WERR_MEMO_PUBLIC | WERR_MEMO_TOO_LONG( _ ) | WERR_FROM_PUBLIC | WERR_NOT_ENOUGH | WERR_NOT_ENOUGH_POOL | WERR_SEED_LENGTH | WERR_SEED_CHECKSUM | WERR_NOT_SEALED | WERR_WRONG_KEY | WERR_NOTHING_TO_MIGRATE | WERR_MIGRATE_OFF | WERR_NOTHING_TO_MOVE | WERR_MOVE_BELOW_FEE | WERR_VIEWONLY_MOVE | WERR_VIEWONLY_SPEND | WERR_KEY_WALLET_MOVE
			| WERR_NO_PASSWORD | WERR_CATCHING_UP | WERR_NOTHING_TO_SHIELD | WERR_PAYMENT_DONE | WERR_MULTI_PAYMENT( _ ) | WERR_TOO_MANY_PAYMENTS( _ ) | WERR_BIRTHDAY_AHEAD( _, _ ) | WERR_MAX_ONE
			| WERR_NETWORK( _, _ ) | WERR_NETWORK_OFF( _ ) | WERR_PRICE_OFF | WERR_PRICE_BUSY | WERR_PRICE( _ ) | WERR_SPEND_KEY_FETCH( _ ) | WERR_SPEND_KEY_MISSING( _ ) | WERR_CORRUPT( _ ) | WERR_ENGINE( _ )
			| WERR_KEY_TYPO | WERR_KEY_NETWORK( _, _ ) | WERR_KEY_UNCOMPRESSED | WERR_KEY_EMPTY | WERR_KEY_TOO_SMALL( _, _ )
			| WERR_NO_PUBLIC_ADDRESS | WERR_NO_SAPLING_ADDRESS | WERR_NO_SHIELDED_KEYS | WERR_REJECTED( _ ) | WERR_SENT_UNSURE( _ ) | WERR_SEND_QUEUED( _ ) | WERR_SWEEP_UNSURE( _ ) | WERR_OFFLINE_SENT_UNSURE( _ ) | WERR_OFFLINE_UNSURE | WERR_KEY_WALLET_RECEIVE | WERR_KEY_WALLET_ACCOUNTS
			| WERR_ZCASHD_NONE | WERR_ZCASHD_TYPO | WERR_ZCASHD_SPROUT | WERR_SHIELD_BELOW_FEE
			| WERR_NO_FILES | WERR_SYNC_CODE | WERR_SYNC_FOLDER | WERR_SYNC_NEWER | WERR_SYNC_ON | WERR_OFFLINE_FOREIGN_INPUT
			| WERR_OFFLINE_MISMATCH | WERR_OFFLINE_HIDDEN | WERR_OFFLINE_FILE | WERR_OFFLINE_NEWER | WERR_OFFLINE_CAN_SEND | WERR_OFFLINE_TWO_STEPS
			| WERR_OFFLINE_NOT_OURS | WERR_OFFLINE_NO_SIGNER | WERR_OFFLINE_SIGNER_VIEWS => whole(),
		}
	}
}

// every error the ui is given leaves through here, so every one is logged
// here, as much as LogText allows: an error only the screen saw can't be
// looked into
impl Serialize for werr_t {
	fn serialize< S: serde::Serializer >( &self, s: S ) -> Result< S::Ok, S::Error > {
		log::warn!( "to the ui: {}", self.LogText() );
		self.Info().serialize( s )
	}
}

pub type wresult_t< T > = Result< T, werr_t >;

// zatoshi fields are u64 but reach the ui as plain numbers: all the zec
// there will ever be is 2.1e15 zatoshis, well under 2^53 (see Sys_Bindings)
#[derive( Clone, Copy, Default, Debug, Serialize, Deserialize, Type )]
pub struct poolBalance_t {
	pub confirmed:		u64,		// zatoshis, spendable once mature
	pub pending:		u64,		// zatoshis, still waiting on confirmations
}

#[derive( Clone, Copy, Default, Debug, Serialize, Deserialize, Type )]
pub struct balance_t {
	pub ironwood:		poolBalance_t,
	pub orchard:		poolBalance_t,	// legacy, drains to ironwood
	pub sapling:		poolBalance_t,
	pub transparent:	poolBalance_t,
	pub total:			u64,
	pub spendable:		Option< u64 >,	// private money Send can use this moment, by the engine's rule (mined deep enough, its witness built, known unspent); none: the account can't spend (a viewing key)
}

#[derive( Clone, Default, Debug, Serialize, Deserialize, Type )]
pub struct syncProgress_t {
	pub running:		bool,
	pub complete:		bool,
	pub percent:		u8,			// whole percent, 0 - 100: a float could be NaN, which reaches the ui as null
	pub walletHeight:	u32,		// highest block fully scanned
	pub chainHeight:	u32,		// tip as last reported by the server
	pub error:			Option< errorInfo_t >,	// why sync can't run right now (it keeps retrying)
	pub attempting:		bool,				// a connection attempt is in flight right now
	pub nextRetryAt:	Option< u64 >,		// when the next attempt starts, unix ms; none while connected or attempting
	pub paused:			bool,				// the person paused sync this session
	pub etaSecs:		Option< u32 >,		// the engine's own estimate of time left; none until it has a steady rate
	pub birthdayTime:	Option< u32 >,		// when the wallet's first block was mined, unix seconds: where sync starts
	pub repairing:		bool,				// rescanning from the birthday to repair the wallet's sync data
}

// the last known state of a wallet, kept outside the engine's lock. The
// engine holds its wallet lock across network requests while it syncs
// (pepper-sync fetches transactions mid-batch), so anything the ui asks
// for is answered from here when the engine is busy, never by waiting
#[derive( Default )]
pub struct slotCache_t {
	pub balances:		Vec< balance_t >,
	pub walletHeight:	u32,
	pub chainHeight:	u32,
	pub running:		bool,			// the engine's mode, as last read (it can't be read while a send holds the client)
	pub paused:			bool,
	pub percent:		u8,				// the last percent the engine published
	pub engineComplete:	bool,			// ...and whether it said complete
	pub caughtUp:		bool,			// reached the tip this session: a block or two behind is "keeping up"
	pub failedAt:		Option< u8 >,	// the engine stopped with an error at this percent; the error stays until it gets further
	pub failures:		u32,			// engine failures in a row, for the pause before the next try
	pub behind:			u32,			// quiet restarts after the server was a block behind, since the tip was last reached
	pub repaired:		bool,			// a data repair (rescan) was tried this session: never loop on it
	pub repairing:		bool,			// ...and is running now
	pub birthdayHeight:	u32,
	pub etaBase:		Option< ( std::time::Instant, u8 ) >,	// when and at what percent this stretch of syncing began
	pub birthdayTime:	Option< u32 >,
	pub receive:		BTreeMap< u32, receive_t >,			// by account
	pub history:		BTreeMap< u32, Vec< balancePoint_t > >,	// by account
	pub transactions:	BTreeMap< u32, Vec< historyItem_t > >,	// by account
	pub seenTotals:		Vec< ( u64, u64 ) >,	// each account's confirmed and pending at the last look: only a change is worth another (a confirmation moves money from one to the other)
	pub seenTxids:		Option< std::collections::HashMap< String, seen_t > >,	// each payment's state at the last look; None until the first look
	pub unsentNext:		u64,			// unix time the next resend of what isn't known to be sent is due (Sync_SendUnsent); 0 is now
	pub fingerprint:	std::collections::BTreeSet< Vec< u8 > >,	// every account's viewing keys: the same keys added twice share them (W_Fingerprint)
	pub wordsPrint:		Option< [ u8; 32 ] >,		// its recovery words, one-way (W_WordsPrint); none without a phrase
}

impl slotCache_t {
	/*
	==================
	StartOver

	The engine starts again from the birthday (a repair). Everything learned
	about the previous run goes together, so no stale half of it (say, "the
	engine said complete") can make the new run look finished.
	==================
	*/
	pub fn StartOver( &mut self ) {
		self.engineComplete	= false;
		self.caughtUp		= false;
		self.percent		= 0;
		self.etaBase		= None;
		self.walletHeight	= 0;
	}

	/*
	==================
	IsComplete

	The engine said so, or the wallet reached the tip this run and is only
	a few blocks behind it (keeping up, not syncing)
	==================
	*/
	pub fn IsComplete( &self, slack: u32 ) -> bool {
		self.engineComplete || ( self.caughtUp && self.chainHeight > 0 && self.chainHeight.saturating_sub( self.walletHeight ) <= slack )
	}
}

// where a wallet's retry loop stands; lives in its slot, read into
// syncProgress_t so the ui can say "trying" or "next try in 23 s"
#[derive( Clone, Copy, Default, Debug )]
pub struct retry_t {
	pub attempting:		bool,
	pub nextAt:			Option< u64 >,
}

// one step of an account's balance over time
#[derive( Clone, Copy, Debug, Serialize, Deserialize, Type )]
pub struct balancePoint_t {
	pub time:			u32,		// unix seconds
	pub zats:			u64,		// balance right after this moment
	pub pools:			poolZats_t,	// the same balance, by the pool it sat in
}

// an amount in each pool, as balance_t names them
#[derive( Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type )]
pub struct poolZats_t {
	pub ironwood:		u64,
	pub orchard:		u64,
	pub sapling:		u64,
	pub transparent:	u64,
}

// what shielding would do, before it's done: shown for confirmation
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
// shielding public money, or moving Sapling money (w_move.rs): what arrives in the private pool
pub struct shieldQuote_t {
	pub amount:			u64,		// zats arriving in the private pool
	pub fee:			u64,
	pub feeNote:		Option< feeNote_t >,
}

// why a fee is worth a word before sending (w_send.rs, Com_FeeNote)
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
#[serde( tag = "kind" )]
pub enum feeNote_t {
	#[serde( rename = "manyCoins" )]
	MANY_COINS { coins: u32 },		// it gathers this many small coins; each costs a little
	#[serde( rename = "largeShare" )]
	LARGE_SHARE,					// more than a tenth of what moves
	#[serde( rename = "high" )]
	HIGH,							// high for another reason (many outputs)
}

#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub enum addrKind_t {
	#[serde( rename = "unified" )]
	ADDR_UNIFIED,
	#[serde( rename = "sapling" )]
	ADDR_SAPLING,
	#[serde( rename = "transparent" )]
	ADDR_TRANSPARENT,
	#[serde( rename = "tex" )]
	ADDR_TEX,			// transparent, but only accepts payments from transparent funds
}

// a pool, as people choose it: where to pay from, where money sits
#[derive( Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type )]
pub enum pool_t {
	#[serde( rename = "ironwood" )]
	POOL_IRONWOOD,
	#[serde( rename = "orchard" )]
	POOL_ORCHARD,
	#[serde( rename = "sapling" )]
	POOL_SAPLING,
	#[serde( rename = "transparent" )]
	POOL_TRANSPARENT,
}

// what money was for, as the person files it (w_notes.rs); the ui's words are in ui_text.ts
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub enum txCategory_t {
	#[serde( rename = "income" )]		CAT_INCOME,
	#[serde( rename = "housing" )]		CAT_HOUSING,
	#[serde( rename = "food" )]			CAT_FOOD,
	#[serde( rename = "transport" )]	CAT_TRANSPORT,
	#[serde( rename = "shopping" )]		CAT_SHOPPING,
	#[serde( rename = "bills" )]		CAT_BILLS,
	#[serde( rename = "business" )]		CAT_BUSINESS,
	#[serde( rename = "gifts" )]		CAT_GIFTS,
	#[serde( rename = "savings" )]		CAT_SAVINGS,
	#[serde( rename = "taxes" )]		CAT_TAXES,
	#[serde( rename = "other" )]		CAT_OTHER,
}

// every category, in the order menus show them
pub const TX_CATEGORIES: [ txCategory_t; 11 ] = [
	txCategory_t::CAT_INCOME, txCategory_t::CAT_HOUSING, txCategory_t::CAT_FOOD, txCategory_t::CAT_TRANSPORT,
	txCategory_t::CAT_SHOPPING, txCategory_t::CAT_BILLS, txCategory_t::CAT_BUSINESS, txCategory_t::CAT_GIFTS,
	txCategory_t::CAT_SAVINGS, txCategory_t::CAT_TAXES, txCategory_t::CAT_OTHER,
];

// what a transaction did, from one account's point of view
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub enum txKind_t {
	#[serde( rename = "received" )]
	TX_RECEIVED,
	#[serde( rename = "sent" )]
	TX_SENT,
	#[serde( rename = "shield" )]
	TX_SHIELD,				// public money made private, within the account
	#[serde( rename = "move" )]
	TX_MOVE,				// between the account's own pools (to Ironwood, say)
}

// where a transaction stands, as the engine says: every state it has, none
// folded into another (a failed payment once showed as pending forever, and
// its change as money received: Com_TxState, w_history.rs)
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
#[serde( tag = "kind" )]
pub enum txState_t {
	#[serde( rename = "confirmed" )]
	CONFIRMED { height: u32 },
	#[serde( rename = "pending" )]
	PENDING { expiresAt: Option< u32 > },	// sent, not in a block yet; not mined by this height, it fails and its coins come back (None: never expires)
	#[serde( rename = "unsent" )]
	UNSENT,				// signed, not known to be sent (Laurel stopped mid-send): sent again once the wallet catches up
	#[serde( rename = "failed" )]
	FAILED,				// expired or refused: nothing moved, its coins are spendable again
}

impl txState_t {
	// waiting on the network: shown above everything settled
	pub fn Waiting( self ) -> bool {
		match self {
			txState_t::PENDING { .. } | txState_t::UNSENT	=> true,
			txState_t::CONFIRMED { .. } | txState_t::FAILED	=> false,
		}
	}
}

// one line of history
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
pub struct historyItem_t {
	pub txid:		String,
	pub time:		u32,				// unix seconds
	pub kind:		txKind_t,
	pub amount:		u64,				// what arrived, left, or moved (for a failed one, what it tried to); the fee is apart
	pub fee:		Option< u64 >,		// when this account paid it and it's known
	pub state:		txState_t,
	pub from:		Vec< pool_t >,		// pools this account's money came out of
	pub into:		Vec< pool_t >,		// pools it went into, for this account
	pub counterparty:	Option< String >,	// who was paid, when a payment went out
	pub memo:		Option< String >,
	pub note:		Option< String >,	// the person's own words about it, only here (w_notes.rs)
	pub category:	Option< txCategory_t >,	// how they file it (w_notes.rs)
}

// what moving an account's Orchard money into Ironwood at once would do
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub struct migratePlan_t {
	pub transactions:	u32,
	pub amount:			u64,		// zats arriving in Ironwood
	pub fee:			u64,
	pub residual:		u64,		// too little to be worth a transaction's fee: stays in Orchard
}

// a scheduled (private, over days) migration's progress, if one exists
#[derive( Clone, Copy, Debug, Default, Serialize, Deserialize, Type )]
pub struct migrationStatus_t {
	pub scheduled:		bool,
	pub partsTotal:		u32,
	pub partsConfirmed:	u32,
	pub valueTotal:		u64,
	pub valueMigrated:	u64,
}

// what the person asked to send
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
pub struct sendRequest_t {
	pub to:			String,				// an address (a zcash: request is read by Scan first)
	pub zats:		Option< u64 >,		// none: everything the chosen pool(s) can send, minus the fee
	pub memo:		Option< String >,
	pub from:		Option< pool_t >,	// none: let the engine choose
	pub also:		Vec< payTo_t >,		// more payments in the same transaction (a ZIP 321 request can ask for several); never with Max
}

// one more payment in the same transaction, with its exact amount
#[derive( Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub struct payTo_t {
	pub to:			String,
	pub zats:		u64,
	pub memo:		Option< String >,
}

// one more payment as the quote reads it back: the address as Scan reads it, and its kind
#[derive( Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub struct quotedPay_t {
	pub to:			String,
	pub kind:		addrKind_t,
	pub amount:		u64,
	pub memo:		Option< String >,
}

// what sending would do, before it's done: shown for confirmation
#[derive( Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub struct sendQuote_t {
	pub to:			String,
	pub kind:		addrKind_t,
	pub amount:		u64,				// zats every recipient gets, together (the first alone when there's one)
	pub fee:		u64,
	pub from:		Vec< pool_t >,		// the pools the notes come from
	pub steps:		u32,				// transactions it takes (2 when paying an exchange-only address)
	pub memo:		Option< String >,
	pub feeNote:	Option< feeNote_t >,	// the fee is worth a word, and why
	pub also:		Vec< quotedPay_t >,		// the further payments, each as it will be made; the first is to/amount-less-these/memo
}

// a quote (or plan) as the person sees it, with the intent it was made
// under: a random id the engine remembers until that quote is sent or
// dropped (E_TakeIntent, w_engine.rs). Sending hands the intent back, so
// one review can send at most once: a second Send with the same intent,
// however it happens (a second click, a retried call), is refused instead
// of paying again from other coins
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
pub struct quoted_t< Q > {
	pub intent:		String,
	pub quote:		Q,
}

// what pressing Shield did: sent, or the numbers changed since they were
// shown (a new block, money that moved) and the new ones need a look,
// under a new intent
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
#[serde( tag = "kind" )]
pub enum shieldResult_t {
	#[serde( rename = "sent" )]
	SENT { txid: String },
	#[serde( rename = "changed" )]
	CHANGED { quoted: quoted_t< shieldQuote_t > },
}

// what sweeping a private key would move, before it's done (w_sweep.rs)
#[derive( Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub struct sweepQuote_t {
	pub from:		String,		// the key's address
	pub to:			String,		// this account's public address
	pub coins:		u32,		// coins spent
	pub left:		u32,		// coins still at the key, for another sweep
	pub total:		u64,		// zats the spent coins hold
	pub fee:		u64,
	pub amount:		u64,		// zats arriving: total less the fee
}

// what pressing Sweep did
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
#[serde( tag = "kind" )]
pub enum sweepResult_t {
	#[serde( rename = "sent" )]
	SENT { txid: String },
	#[serde( rename = "changed" )]
	CHANGED { quoted: quoted_t< sweepQuote_t > },
}

// pasted zcashd keys, read locally as they're typed
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
#[serde( tag = "kind" )]
pub enum zcashdCheck_t {
	#[serde( rename = "empty" )]
	EMPTY,
	#[serde( rename = "ok" )]
	OK { sapling: u32, sprout: u32, transparent: u32 },		// what can be imported, and what can't (said, not dropped)
	#[serde( rename = "bad" )]
	BAD { problem: String },
}

// a typed private key, read locally before anything is asked of a server
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
#[serde( tag = "kind" )]
pub enum keyCheck_t {
	#[serde( rename = "empty" )]
	EMPTY,
	#[serde( rename = "ok" )]
	OK { address: String },
	#[serde( rename = "bad" )]
	BAD { problem: String },
}

// what pressing Send did, the same way
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
#[serde( tag = "kind" )]
pub enum sendResult_t {
	#[serde( rename = "sent" )]
	SENT { txid: String },
	#[serde( rename = "changed" )]
	CHANGED { quoted: quoted_t< sendQuote_t > },
}

// what pressing Move Now did, the same way: a migration is a payment to
// oneself, and moves only what the person saw planned
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
#[serde( tag = "kind" )]
pub enum migrateResult_t {
	#[serde( rename = "sent" )]
	SENT { txids: Vec< String > },
	#[serde( rename = "changed" )]
	CHANGED { quoted: quoted_t< migratePlan_t > },
}

// a scanned or pasted code, understood: an address, or a payment request
#[derive( Clone, Debug, Serialize, Deserialize, Type )]
pub struct scanned_t {
	pub address:		String,
	pub kind:			addrKind_t,
	pub amount:			Option< u64 >,		// zats, when a payment request asks for an amount
	pub memo:			Option< String >,
	pub label:			Option< String >,	// who is asking, as the request names them
	pub message:		Option< String >,
	pub also:			Vec< payTo_t >,		// a request for several payments: the others, each with its amount
}

// what laurel knows about a wallet that zingolib doesn't: names, backup.
// stays in rust; the ui sees it through walletSummary_t
#[derive( Clone, Debug, Serialize, Deserialize )]
pub struct meta_t {
	pub name:			String,
	pub kind:			walletKind_t,
	pub accounts:		Vec< String >,	// account names, by zip-32 index
	pub backedUp:		bool,			// passed the phrase check, or was restored from the phrase
	pub created:		u64,			// unix time laurel added it; sorts the list
}

#[derive( Clone, Debug, Serialize, Type )]
pub struct accountSummary_t {
	pub index:			u32,
	pub name:			String,
	pub balance:		balance_t,
}

// one row group in the switcher. seq orders snapshots: the ui keeps the
// highest it has seen per wallet and drops anything older
#[derive( Clone, Debug, Serialize, Type )]
pub struct walletSummary_t {
	pub seq:			u64,
	pub id:				String,
	pub name:			String,
	pub kind:			walletKind_t,
	pub can:			walletCan_t,		// what it may do (W_Allow): the ui offers by it, never by the kind
	pub backedUp:		bool,
	pub accounts:		Vec< accountSummary_t >,
	pub progress:		syncProgress_t,
	pub saveError:		Option< errorInfo_t >,	// set while this wallet can't be written to disk
	pub sameWords:		Vec< String >,			// other open wallets from the same recovery words, with another passphrase (W_SameWords)
}

// what a wallet may be asked to do; which kinds may is W_Allow's alone (w_main.rs)
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub enum walletAct_t {
	WA_SPEND,			// sign a payment here
	WA_RECEIVE,			// give out addresses
	WA_MOVE_WITHIN,		// move money between its own pools
	WA_ADD_ACCOUNT,
}

// each act, answered for one wallet (W_Can): what the ui offers
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub struct walletCan_t {
	pub spend:			bool,
	pub receive:		bool,
	pub moveWithin:		bool,
	pub addAccount:		bool,
}

// a wallet on disk that couldn't be opened; listed so it never just vanishes
#[derive( Clone, Debug, Serialize, Type )]
pub struct failedWallet_t {
	pub id:				String,
	pub error:			errorInfo_t,
}

#[derive( Clone, Debug, Serialize, Type )]
pub struct walletList_t {
	pub firstRun:		bool,		// no wallet on disk at all: the only time onboarding shows
	pub wallets:		Vec< walletSummary_t >,
	pub failed:			Vec< failedWallet_t >,
}

// live feedback while a recovery phrase is typed
#[derive( Clone, Debug, Serialize, Type )]
pub struct phraseCheck_t {
	pub words:			u32,
	pub unknown:		Vec< u32 >,	// indexes of words not in the bip-39 list
	pub valid:			bool,		// right length, known words, checksum matches
	pub problem:		String,		// what to tell the user, empty when valid
}

// one word of a backup check, typed back: its place in the phrase (from 0)
// and the word. No Debug: it is part of a phrase
#[derive( Clone, Deserialize, Type )]
pub struct backupWord_t {
	pub pos:	u32,
	pub word:	String,
}

// the check asks about one word in this many (ui_backup.tsx's VERIFY_SHARE)
pub const BACKUP_CHECK_SHARE: usize = 3;

#[derive( Clone, Serialize, Type )]
pub struct recovery_t {
	pub seedPhrase:		String,
	pub passphrase:		Option< String >,	// BIP-39's extra word; None when the wallet has none
	pub birthday:		u64,		// block height
	pub birthdayTime:	Option< u32 >,	// unix time of that block; None when the server couldn't say (never a guess: a restored wallet's is not "today")
}

// never the words: a {:?} in a log line or an error must not print a phrase
impl std::fmt::Debug for recovery_t {
	fn fmt( &self, f: &mut std::fmt::Formatter< '_ > ) -> std::fmt::Result {
		f.debug_struct( "recovery_t" )
			.field( "seedPhrase", &"<redacted>" )
			.field( "passphrase", &self.passphrase.as_ref().map( |_| "<redacted>" ) )
			.field( "birthday", &self.birthday )
			.field( "birthdayTime", &self.birthdayTime )
			.finish()
	}
}

// where an account can be paid
#[derive( Clone, Debug, Serialize, Type )]
pub struct receive_t {
	pub shielded:		String,				// unified address: a receiver for each shielded part the keys have (W_Parts)
	pub shieldedIndex:	u32,				// which one of this account's addresses it is
	pub sapling:		Option< String >,	// Sapling alone, at its own index: for payers that can't pay a unified address
	pub transparent:	Option< String >,	// public address, for exchanges that can't send shielded
}

// which of an account's addresses: to give out (W_Request), or to renew (freshAddress_t)
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub enum addressKind_t {
	#[serde( rename = "private" )]
	AK_PRIVATE,
	#[serde( rename = "sapling" )]
	AK_SAPLING,
	#[serde( rename = "public" )]
	AK_PUBLIC,
}

// the addresses that can be made new; the public one never is (w_addr.rs), so it can't be asked
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type )]
pub enum freshAddress_t {
	#[serde( rename = "private" )]
	FA_PRIVATE,
	#[serde( rename = "sapling" )]
	FA_SAPLING,
}

#[derive( Clone, Debug, Serialize, Type )]
pub struct created_t {
	pub id:				String,
	pub recovery:		recovery_t,
}

// pushed to the ui on every sync step of one wallet; same seq rule as
// walletSummary_t
#[derive( Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event )]
pub struct syncEvent_t {
	pub seq:			u64,
	pub walletId:		String,
	pub progress:		syncProgress_t,
	pub balances:		Vec< balance_t >,	// by account index
}

// Laurel is closing: the window stays up, saying the wallets are being saved
#[derive( Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event )]
pub struct closingEvent_t {}

#[derive( Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event )]
pub struct vaultChangedEvent_t {}

// a payment that just arrived, once per transaction, only once the wallet
// has caught up (what sync finds while catching up is history, not news)
#[derive( Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event )]
pub struct paymentEvent_t {
	pub walletId:		String,
	pub account:		u32,
	pub accountName:	String,
	pub txid:			String,
	pub kind:			txKind_t,		// received: arriving; sent: settled (Com_Look)
	pub amount:			u64,
	pub state:			txState_t,		// received: pending or confirmed; sent: confirmed or failed
}

// what a look remembers of a transaction: enough to tell when it changed
#[derive( Clone, Copy, Debug, PartialEq, Eq )]
pub enum seen_t {
	SEEN_WAITING,
	SEEN_CONFIRMED,
	SEEN_FAILED,
}

// a stretch of one network's chain with one target block spacing, from
// height `from` on, until the network's next; in height order (ZIP 208:
// 150 s, Blossom: 75 s, NU7: 25 s, ZIP 218)
#[derive( Clone, Copy, Debug, PartialEq, Eq, Serialize, Type )]
pub struct blockEra_t {
	pub network:	network_t,
	pub from:		u32,
	pub secs:		u32,
}

// the numbers the ui needs to agree with, from their one owner
#[derive( Clone, Debug, Serialize, Type )]
pub struct constants_t {
	pub mobile:			bool,		// the compiled target, never guessed from the viewport
	pub phraseLengths:		Vec< u32 >,
	pub maxAccounts:		u32,
	pub maxNameLen:			u32,
	pub defaultWalletName:	String,
	pub defaultAccountName:	String,
	pub blockEras:			Vec< blockEra_t >,	// each network's block times by height, to say when a pending payment expires as a time (W_BlockEras)
	pub lockAwayChoices:	Vec< u32 >,		// seconds a phone may be out of sight; 0 is at once
	pub autoLockChoices:	Vec< u32 >,		// minutes; "never" is none (w_settings.rs refuses anything else)
	pub memoMaxBytes:		u32,			// what a memo holds, in UTF-8 bytes (W_CheckMemo)
	pub categories:			Vec< txCategory_t >,	// every category, in menu order (TX_CATEGORIES)
	pub textScales:			Vec< u32 >,		// text sizes in percent (w_settings.rs refuses anything else)
	pub maxPayments:		u32,			// payments one transaction may make (MAX_PAYMENTS, w_send.rs)
	pub noteMaxChars:		u32,			// a note, a contact's or a transaction's (Com_CleanNote)
	pub networks:			Vec< network_t >,	// what this build opens (NETWORKS): the Play beta's, testnet alone
}


/*
=========================================================================

GLOBALS

=========================================================================
*/

// the engine, one call at a time; its own lock, never the slot's, so a
// send that takes twenty seconds doesn't stop anyone reading the slot
pub type clientRef_t = Arc< Mutex< LightClient > >;

// the engine's wallet, read for snapshots without the client
pub type walletRef_t = Arc< RwLock< zingolib::wallet::LightWallet > >;

// the slot's own lock guards names and settings only, and only briefly:
// take the handles out (client, wallet), let the slot go, then do the slow
// part. clippy's await_holding_invalid_type fails the build on a slot or
// wallet guard held across an await (`npm run lint`)
pub struct slot_t {
	pub client:			clientRef_t,
	pub wallet:			walletRef_t,
	pub meta:			meta_t,
	pub dir:			PathBuf,
	pub saveLock:		Arc< Mutex< () > >,					// one write of this wallet at a time, so an older save never lands after a newer one
	pub saveError:		std::sync::Mutex< Option< errorInfo_t > >,	// the last save failure, shown to the user until a save succeeds
	pub syncError:		std::sync::Mutex< Option< errorInfo_t > >,	// why sync can't run (no server, antivirus...); cleared once it does
	pub retry:			std::sync::Mutex< retry_t >,			// where the connection retry loop stands
	pub cache:			Arc< std::sync::Mutex< slotCache_t > >,	// answers while the engine holds its lock
	pub saver:			std::sync::Mutex< Option< tauri::async_runtime::JoinHandle< () > > >,	// W_StartSaver's task, awaited by W_Close
	pub stop:			Arc< tokio::sync::Notify >,				// ends the saver
}

pub type slotRef_t = Arc< RwLock< slot_t > >;

pub struct wallets_t {
	pub network:		network_t,
	pub loaded:			bool,						// every wallet on disk has been opened
	pub slots:			BTreeMap< String, slotRef_t >,	// by wallet id
}

pub static w_registry: LazyLock< RwLock< wallets_t > > = LazyLock::new( || {
	RwLock::new( wallets_t {
		network:	network_t::NET_TESTNET,
		loaded:		false,
		slots:		BTreeMap::new(),
	} )
} );

// Laurel's data folder: set once by W_Init, read only by Com_DataPath
pub static w_baseDir: OnceLock< PathBuf > = OnceLock::new();

pub const WALLETS_DIR_NAME: &str = "wallets";

// a transaction id as text: 64 hex digits (a note's key; a log masks one)
pub fn Com_IsTxid( text: &str ) -> bool {
	text.len() == 64 && text.bytes().all( |b| b.is_ascii_hexdigit() )
}

/*
==================
Com_DataPath / Com_NetworkPath

A file or folder in Laurel's data folder, and a network's wallets
folder. None only before W_Init, which unit tests without a data folder
see; what then follows is each caller's to say (defaults, an error).
Read five ways with three answers to "not set yet" before (check_owners).
==================
*/
pub fn Com_DataPath( name: &str ) -> Option< PathBuf > {
	Some( w_baseDir.get()?.join( name ) )
}

/*
==================
Com_TestDir

A test's own folder, made fresh, in this run's folder under laurel-tests
in the system's temp folder. Named by the process id alone, a folder
outlived its run, and Windows gives an id out again: a later run found an
earlier one's wallet and sync files in it, and failed on files it never
wrote. And none was ever taken away: 3,776 of them, 555 MB. So each run
has a folder of its own, and the first test to ask takes away the runs
an hour old or more (a run going on beside this one is younger)
==================
*/
#[cfg( test )]
pub fn Com_TestDir( name: &str ) -> PathBuf {
	static RUN: OnceLock< PathBuf > = OnceLock::new();
	let run = RUN.get_or_init( || {
		let all = std::env::temp_dir().join( "laurel-tests" );
		let old = crate::w_date::Com_Now().saturating_sub( 3600 );
		for gone in std::fs::read_dir( &all ).into_iter().flatten().flatten() {
			let made = gone.metadata().and_then( |m| m.modified() ).ok().and_then( |t| t.duration_since( std::time::UNIX_EPOCH ).ok() );
			if ( made.is_some_and( |d| d.as_secs() < old ) ) {
				let _ = std::fs::remove_dir_all( gone.path() );
			}
		}
		all.join( format!( "{}-{}", std::process::id(), crate::w_vault::Com_RandomHex( 6 ) ) )
	} );
	// tests run side by side: two with one name empty each other's folder
	static TAKEN: std::sync::Mutex< Vec< String > > = std::sync::Mutex::new( Vec::new() );
	let mut taken = TAKEN.lock().unwrap();
	assert!( !taken.iter().any( |n| n == name ), "Com_TestDir: \"{name}\" is another test's folder" );
	taken.push( name.to_string() );
	let dir = run.join( name );
	let _ = std::fs::remove_dir_all( &dir );
	std::fs::create_dir_all( &dir ).unwrap();
	dir
}

// what a write says before W_Init (unit tests without a data folder): once in three files
pub fn Com_NoDataFolder() -> werr_t {
	werr_t::WERR_ENGINE( "Laurel's data folder isn't known yet.".to_string() )
}

pub fn Com_NetworkPath( net: network_t ) -> Option< PathBuf > {
	Some( Com_DataPath( WALLETS_DIR_NAME )?.join( match net {
		network_t::NET_MAINNET => "mainnet",
		network_t::NET_TESTNET => "testnet",
	} ) )
}

// held for the whole of W_Load, so two callers can never open the same
// wallet file twice (two engines saving one file corrupts it)
pub static w_loadLock: LazyLock< Mutex< () > > = LazyLock::new( || Mutex::new( () ) );

// only one wallet is added at a time: a double click must not make two
pub static w_adding: AtomicBool = AtomicBool::new( false );

// set once the app is closing: savers stop, the shutdown does the last save
pub static w_shuttingDown: AtomicBool = AtomicBool::new( false );

// wallets found on disk that couldn't be opened, by id
pub static w_failed: std::sync::Mutex< Vec< failedWallet_t > > = std::sync::Mutex::new( Vec::new() );

// ever increasing; stamps every snapshot and event
pub static w_seq: AtomicU64 = AtomicU64::new( 1 );
