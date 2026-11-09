//! Laurel's live testnet checks of its engine patches, run by hand (in a
//! Linux container on machines whose antivirus intercepts TLS):
//!
//!   birthdays                      the public test wallets' birthdays
//!   balance <wallet>               restore (or reopen) and sync, then say what it holds
//!   send <from> <to-address> <zats>   pay from a wallet, and wait for it to be mined
//!
//! Wallets: `shuffle` and `glory` (zingolib's public testnet test seeds),
//! `pass` (the shuffle words with a passphrase), and any `key:<n>` made by
//! `zcashd` below. State lives in $LIVE_DIR (one folder per wallet), so a
//! second run only syncs what's new.
//!
//!   zcashd <n> <birthday>          a wallet of one fresh zcashd Sapling key; prints its address
//!   wif <n>                        a fresh transparent key; prints its WIF and address
//!   sweep <wif> <to-wallet>        sweep that key's coins into the wallet's transparent address
//!
//!   killsend <from> <to> <zats> calculated|broadcast   die mid-send (release gate E.2)
//!   resume <wallet>                what Laurel's next start does: catch up, send what's unsent
//!   count <wallet> <zats>          how many payments of exactly zats arrived
//!   rebroadcast <wallet>           its own pending payments sent again, as Laurel does (E_DroppedOf)
//!   audit <wallet>                 every paid transaction, decoded from the chain, balances (release gate E.1)
//!   migrate <wallet>               its Orchard into Ironwood, Laurel's way (release gate E.3)
//!   movesapling <wallet>           its Sapling into Ironwood, Laurel's way (w_move.rs), and what the chain made of it
//!   offline <wallet> <to|self> <zats>  offline signing, the engine's half (Laurel's w_offline.rs)
//!   bench <new> <from> [back]      restore <from>'s phrase and birthday as <new>, timed (ROADMAP: speed);
//!                                  with [back], only the newest that many blocks: seconds, for trying a change
//!
//! Nothing here is used by Laurel; it exists to show the patches work
//! against the real network, not only in unit tests.

use std::num::NonZeroU32;
use std::path::PathBuf;
use std::time::Duration;

use pepper_sync::config::{PerformanceLevel, SyncConfig, TransparentAddressDiscovery};
use zcash_protocol::value::Zatoshis;
use zingolib::config::{ChainType, ClientConfig, WalletConfig};
use zingolib::lightclient::LightClient;
use zingolib::wallet::WalletSettings;

const SERVER: &str = "https://testnet.zec.rocks:443";
const SHUFFLE: &str = "mobile shuffle keen mother globe desk bless hub oil town begin potato explain table crawl just wild click spring pottery gasp often pill plug";
const GLORY: &str = "glory goddess cargo action guilt ball coral employ phone baby oxygen flavor solid climb situate frequent blade pet enough milk access try swift benefit";
const PASSPHRASE: &str = "Laurel live test 25th word";

fn settings() -> WalletSettings {
    WalletSettings {
        sync_config: SyncConfig {
            transparent_address_discovery: TransparentAddressDiscovery::recovery(),
            performance_level: PerformanceLevel::High,
            shutdown_on_completion: true,
        },
        min_confirmations: NonZeroU32::new(1).unwrap(),
    }
}

/// Sapling's spend proving key, as Laurel has it (src-tauri/src/w_spendkey.rs):
/// the published file, fetched once into $LIVE_DIR, then named to the engine,
/// which checks its hash (and again at every use). Without it no Sapling note
/// can be spent here since the key stopped being compiled in.
fn spend_key() {
    let base = PathBuf::from(std::env::var("LIVE_DIR").unwrap_or_else(|_| "/live".to_string()));
    let path = base.join(zingolib::wallet::sapling_key::SPEND_PARAMS_NAME);
    if !path.is_file() {
        let partial = path.with_extension("part");
        let got = std::process::Command::new("curl")
            .args(["-sSfL", "--retry", "3", "-o"])
            .arg(&partial)
            .arg(zingolib::wallet::sapling_key::SPEND_PARAMS_URL)
            .status()
            .expect("curl, in the harness's image");
        assert!(got.success(), "fetching the spend key failed");
        std::fs::rename(&partial, &path).unwrap();
    }
    zingolib::wallet::sapling_key::use_spend_params(&path).expect("the published spend key");
}

fn dir(name: &str) -> PathBuf {
    let base = std::env::var("LIVE_DIR").unwrap_or_else(|_| "/live".to_string());
    let d = PathBuf::from(base).join(name.replace(':', "-"));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn birthday_arg(name: &str) -> u32 {
    std::fs::read_to_string(dir(name).join("birthday")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(3_900_000)
}

/// The wallet at `name`: read when its file exists, made from its seed otherwise.
async fn open(name: &str) -> LightClient {
    let d = dir(name);
    let exists = d.join("zingo-wallet.dat").exists();
    let wallet_config = if exists {
        WalletConfig::Read
    } else {
        let birthday = birthday_arg(name);
        match name {
            "shuffle" => WalletConfig::MnemonicPhrase { mnemonic_phrase: SHUFFLE.into(), no_of_accounts: NonZeroU32::MIN, birthday, wallet_settings: settings() },
            "glory" => WalletConfig::MnemonicPhrase { mnemonic_phrase: GLORY.into(), no_of_accounts: NonZeroU32::MIN, birthday, wallet_settings: settings() },
            "pass" => WalletConfig::MnemonicPhraseWithPassphrase { mnemonic_phrase: SHUFFLE.into(), passphrase: PASSPHRASE.into(), no_of_accounts: NonZeroU32::MIN, birthday, wallet_settings: settings() },
            // what a person keeps on paper: the phrase and the birthday (newseed, restore)
            other => match std::fs::read_to_string(d.join("phrase.txt")) {
                Ok(phrase) => WalletConfig::MnemonicPhrase { mnemonic_phrase: phrase.trim().into(), no_of_accounts: NonZeroU32::MIN, birthday, wallet_settings: settings() },
                Err(_) => panic!("no wallet {other} yet (newseed, zcashd or restore make one)"),
            },
        }
    };
    let config = ClientConfig::builder()
        .set_indexer_uri(SERVER.parse().unwrap())
        .set_chain_type(ChainType::Testnet)
        .set_wallet_dir(d)
        .set_wallet_config(wallet_config)
        .build()
        .unwrap();
    LightClient::new(config, true).await.unwrap()
}

/// Saved the way Laurel saves (w_main.rs, W_WriteWallet): the engine hands
/// over the wallet's bytes and the caller writes them. The engine's own
/// savers don't exist in Laurel's build (zingolib's `no-plaintext-save`);
/// Laurel seals the bytes, this writes them plain: public test seeds only.
async fn save(c: &mut LightClient) {
    let path = c.wallet_path();
    let mut w = c.wallet().write().await;
    w.mark_dirty();
    let bytes = w.save().unwrap().expect("marked dirty: there is something to save");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &bytes).unwrap();
    std::fs::rename(&tmp, &path).unwrap();
    w.mark_saved();
}

async fn synced(name: &str) -> LightClient {
    let mut c = open(name).await;
    let started = std::time::Instant::now();
    let result = c.sync_and_await().await;
    println!("[{name}] sync: {:?} in {:?}", result.map(|r| format!("{}..{}: {} blocks, {} of {} outputs", r.sync_start_height, r.sync_end_height, r.blocks_scanned, r.total_outputs_scanned, r.total_outputs)), started.elapsed());
    save(&mut c).await;
    c
}

async fn describe(name: &str, c: &LightClient) {
    for account in c.wallet().read().await.unified_key_store.keys().copied().collect::<Vec<_>>() {
        match c.account_balance(account).await {
            Ok(b) => println!("[{name}] account {} balance: {b}", u32::from(account)),
            Err(e) => println!("[{name}] account {} balance error: {e}", u32::from(account)),
        }
    }
    println!("[{name}] addresses: {}", c.unified_addresses_json().await.pretty(1));
    println!("[{name}] transparent: {}", c.transparent_addresses_json().await.pretty(1));
}

/// The address Laurel gives out as the wallet's private one (w_addr.rs, W_Unified): the
/// newest with an Orchard receiver, one that holds Sapling too first
fn own_address(w: &zingolib::wallet::LightWallet) -> String {
    w.unified_addresses().iter()
        .filter(|(aid, ua)| aid.account_id == zip32::AccountId::ZERO && ua.has_orchard())
        .max_by_key(|(aid, ua)| (ua.sapling().is_some(), aid.address_index))
        .map(|(_, ua)| ua.encode(&ChainType::Testnet))
        .expect("a private address")
}

/// Syncs every 30 seconds until `txid` is mined, at most 15 minutes, saying each state
async fn mined(name: &str, c: &mut LightClient, txid: zcash_protocol::TxId) {
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let _ = c.sync_and_await().await;
        let status = c.wallet().read().await.wallet_transactions.get(&txid).map(|t| format!("{:?}", t.status()));
        println!("[{name}] {txid}: {status:?}");
        if status.as_deref().is_some_and(|s| s.starts_with("Confirmed")) {
            return;
        }
    }
}

/// Everything a balance holds, every pool, confirmed or not
fn total(b: &zingolib::wallet::balance::AccountBalance) -> u64 {
    [b.total_ironwood_balance, b.total_orchard_balance, b.total_sapling_balance, b.total_transparent_balance].into_iter().flatten().map(u64::from).sum()
}

/// What `txid` spent of this wallet's outputs in one pool
fn spent_by<N: pepper_sync::wallet::OutputInterface>(w: &zingolib::wallet::LightWallet, txid: zcash_protocol::TxId) -> u64 {
    w.wallet_transactions.values().flat_map(|t| N::transaction_outputs(t)).filter(|o| o.spending_transaction() == Some(txid)).map(|o| o.value()).sum()
}

/// What arrived in one pool in a transaction
fn arrived<N: pepper_sync::wallet::OutputInterface>(tx: &pepper_sync::wallet::WalletTransaction) -> u64 {
    N::transaction_outputs(tx).iter().map(|o| o.value()).sum()
}

#[tokio::main]
async fn main() {
    zingo_netutils::ensure_default_crypto_provider();
    spend_key();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("birthdays") => {
            for (name, path) in [
                ("shuffle", "src/wallet/disk/testing/examples/testnet/mskmgdbhotbpetcjwcspgopp/latest/zingo-wallet.dat"),
                ("glory", "src/wallet/disk/testing/examples/testnet/glory_goddess/latest/zingo-wallet.dat"),
            ] {
                let bytes = std::fs::read(path).unwrap();
                let wallet = zingolib::wallet::LightWallet::read(bytes.as_slice(), ChainType::Testnet).unwrap();
                let birthday = u32::from(wallet.birthday());
                println!("{name}: birthday {birthday}");
                std::fs::write(dir(name).join("birthday"), birthday.to_string()).unwrap();
            }
        }
        Some("balance") => {
            let name = &args[1];
            let c = synced(name).await;
            describe(name, &c).await;
        }
        Some("send") => {
            // exactly Laurel's path (E_ProposeSend): one payment, or everything ("all")
            let (from, to, amount) = (&args[1], &args[2], &args[3]);
            let account = args.get(4).map_or(0, |a| a.parse::<u32>().unwrap());
            let account = zip32::AccountId::try_from(account).unwrap();
            let mut c = synced(from).await;
            let to = zcash_address::ZcashAddress::try_from_encoded(to).unwrap();
            let proposal = if amount == "all" {
                c.propose_send_all_from(to, None, account, None).await.map(|p| p.steps().len())
            } else {
                let payment = zcash_client_backend::zip321::Payment::new(to, Some(Zatoshis::from_u64(amount.parse().unwrap()).unwrap()), None, None, None, vec![]).unwrap();
                c.propose_send_from(zcash_client_backend::zip321::TransactionRequest::new(vec![payment]).unwrap(), account, None).await.map(|p| p.steps().len())
            };
            println!("[{from}] proposal: {:?}", proposal.map_err(|e| e.to_string()));
            let sent = c.send_stored_proposal(true).await;
            println!("[{from}] sent: {:?}", sent.map(|t| t.first().to_string()).map_err(|e| e.to_string()));
            save(&mut c).await;
        }
        Some("zcashd") => {
            let (n, birthday) = (&args[1], args[2].parse::<u32>().unwrap());
            let mut seed = [0u8; 32];
            rand::Rng::fill_bytes(&mut zingolib::utils::system_rng(), &mut seed);
            let key = sapling_crypto::zip32::ExtendedSpendingKey::master(&seed).expect("a 32-byte seed makes a master key");
            let text = zcash_keys::encoding::encode_extended_spending_key(zcash_protocol::constants::testnet::HRP_SAPLING_EXTENDED_SPENDING_KEY, &key);
            std::fs::write(dir(&format!("key:{n}")).join("exported-key.txt"), &text).unwrap();
            // exactly Laurel's path: read the text, then an account per key
            let keys = laurel_engine::zcashd::read_zcashd_keys(&ChainType::Testnet, &text).unwrap();
            let usks = keys.sapling.iter().map(|k| laurel_engine::zcashd::usk_for_sapling_key(&ChainType::Testnet, k).unwrap()).collect();
            let config = ClientConfig::builder()
                .set_indexer_uri(SERVER.parse().unwrap())
                .set_chain_type(ChainType::Testnet)
                .set_wallet_dir(dir(&format!("key:{n}")))
                .set_wallet_config(WalletConfig::Usks { usks, birthday, wallet_settings: settings() })
                .build()
                .unwrap();
            let mut c = LightClient::new(config, true).await.unwrap();
            let sapling = zcash_keys::encoding::encode_payment_address(zcash_protocol::constants::testnet::HRP_SAPLING_PAYMENT_ADDRESS, &key.default_address().1);
            println!("[key:{n}] the key's own Sapling address (what zcashd showed): {sapling}");
            save(&mut c).await;
        }
        Some("wif") => {
            let n = &args[1];
            let mut secret = [0u8; 32];
            rand::Rng::fill_bytes(&mut zingolib::utils::system_rng(), &mut secret);
            let mut payload = zcash_protocol::constants::testnet::B58_SECRET_KEY_PREFIX.to_vec();
            payload.extend_from_slice(&secret);
            payload.push(1);
            let wif = bs58::encode(payload).with_check().into_string();
            let key = laurel_engine::sweep::SweepKey::from_wif(&ChainType::Testnet, &wif).unwrap();
            std::fs::write(dir(&format!("wif-{n}")).join("wif.txt"), &wif).unwrap();
            println!("[wif-{n}] address {} (the key is in {}/wif.txt)", key.encoded_address(&ChainType::Testnet), dir(&format!("wif-{n}")).display());
        }
        Some("sweep") => {
            // exactly Laurel's path (w_sweep.rs): coins from the server, plan, build, broadcast
            use zingo_netutils::{Indexer, TransparentIndexer};
            let (wif_file, to_wallet) = (&args[1], &args[2]);
            let wif = std::fs::read_to_string(wif_file).unwrap();
            let key = laurel_engine::sweep::SweepKey::from_wif(&ChainType::Testnet, wif.trim()).unwrap();
            let c = open(to_wallet).await;
            let to_text = c.transparent_addresses_json().await[0]["encoded_address"].as_str().map(str::to_string).unwrap_or_default();
            println!("[sweep] into {to_wallet}'s {to_text}");
            let to = laurel_engine::sweep::sweep_destination(&ChainType::Testnet, &to_text).unwrap();
            let mut indexer = zingo_netutils::GrpcIndexer::new(SERVER.parse().unwrap()).await.unwrap();
            let t = Duration::from_secs(30);
            let tip = indexer.get_latest_block(t).await.unwrap();
            let found = indexer
                .get_address_utxos(
                    zingo_netutils::lightwallet_protocol::GetAddressUtxosArg { addresses: vec![key.encoded_address(&ChainType::Testnet)], start_height: 0, max_entries: 0 },
                    t,
                )
                .await
                .unwrap();
            let coins: Vec<_> = found.address_utxos.iter().map(|u| laurel_engine::sweep::SweepCoin::from_utxo(&u.txid, u.index, u.value_zat).unwrap()).collect();
            let height = zcash_protocol::consensus::BlockHeight::from_u32(tip.height as u32 + 1);
            let plan = laurel_engine::sweep::plan_sweep(ChainType::Testnet, height, &key, &coins, &to);
            println!("[sweep] plan: {plan:?}");
            let signed = laurel_engine::sweep::build_sweep(ChainType::Testnet, height, &key, &coins, &to).unwrap();
            let sent = indexer.send_transaction(zingo_netutils::lightwallet_protocol::RawTransaction { data: signed.raw, height: 0 }, t).await;
            println!("[sweep] txid {} broadcast: {sent:?}", signed.txid);
        }
        // the fast way to test coins: a public seed's transparent coins need no
        // history scan (one server call per address); each is spent by its own
        // key through the WIF sweep, which is itself under test
        Some("tkeys") => {
            let seed_words = match args[1].as_str() { "shuffle" => SHUFFLE, "glory" => GLORY, other => panic!("{other}") };
            let seed = zingolib::wallet::keys::seed::WalletSeed::new(bip0039::Mnemonic::<bip0039::English>::from_phrase(seed_words).unwrap(), String::new());
            let usk = zcash_keys::keys::UnifiedSpendingKey::from_seed(&ChainType::Testnet, &seed.to_seed(), zip32::AccountId::ZERO).unwrap();
            use zingo_netutils::TransparentIndexer;
            let mut indexer = zingo_netutils::GrpcIndexer::new(SERVER.parse().unwrap()).await.unwrap();
            for (scope_name, scope) in [("external", zcash_transparent::keys::TransparentKeyScope::EXTERNAL), ("internal", zcash_transparent::keys::TransparentKeyScope::INTERNAL)] {
                for i in 0..10u32 {
                    let index = zcash_transparent::keys::NonHardenedChildIndex::from_index(i).unwrap();
                    let sk = usk.transparent().derive_secret_key(scope, index).unwrap();
                    let mut payload = zcash_protocol::constants::testnet::B58_SECRET_KEY_PREFIX.to_vec();
                    payload.extend_from_slice(&sk.to_secret_bytes());
                    payload.push(1);
                    let wif = bs58::encode(payload).with_check().into_string();
                    let key = laurel_engine::sweep::SweepKey::from_wif(&ChainType::Testnet, &wif).unwrap();
                    let address = key.encoded_address(&ChainType::Testnet);
                    let found = indexer
                        .get_address_utxos(
                            zingo_netutils::lightwallet_protocol::GetAddressUtxosArg { addresses: vec![address.clone()], start_height: 0, max_entries: 0 },
                            Duration::from_secs(30),
                        )
                        .await
                        .unwrap();
                    let zats: i64 = found.address_utxos.iter().map(|u| u.value_zat).sum();
                    if zats > 0 {
                        let file = dir(&format!("tkey-{}-{scope_name}-{i}", args[1])).join("wif.txt");
                        std::fs::write(&file, &wif).unwrap();
                        println!("{address} ({scope_name} {i}): {zats} zats in {} coins -> {}", found.address_utxos.len(), file.display());
                    }
                }
            }
            println!("done");
        }
        // one transaction paying several addresses: sendmany <from> <addr>=<zats> ...
        Some("sendmany") => {
            let from = &args[1];
            let mut c = synced(from).await;
            let payments = args[2..]
                .iter()
                .map(|pair| {
                    let (to, zats) = pair.split_once('=').unwrap();
                    zcash_client_backend::zip321::Payment::new(
                        zcash_address::ZcashAddress::try_from_encoded(to).unwrap(),
                        Some(Zatoshis::from_u64(zats.parse().unwrap()).unwrap()),
                        None, None, None, vec![],
                    )
                    .unwrap()
                })
                .collect();
            let request = zcash_client_backend::zip321::TransactionRequest::new(payments).unwrap();
            let proposal = c.propose_send_from(request, zip32::AccountId::ZERO, None).await;
            // each step and what it pays: with an exchange-only (TEX) recipient the
            // last step pays only it, so a total read from the last step alone is short
            if let Ok(p) = &proposal {
                for (i, step) in p.steps().iter().enumerate() {
                    let pays: Vec<String> = step.transaction_request().payments().values()
                        .map(|x| format!("{}…={}", &x.recipient_address().encode()[..12], x.amount().map_or(0, |z| z.into_u64())))
                        .collect();
                    println!("[{from}] step {i}: fee {} pays {pays:?}", step.balance().fee_required().into_u64());
                }
            }
            println!("[{from}] proposal: {:?}", proposal.map(|p| p.steps().len()).map_err(|e| e.to_string()));
            let sent = c.send_stored_proposal(true).await;
            println!("[{from}] sent: {:?}", sent.map(|t| t.iter().map(|x| x.to_string()).collect::<Vec<_>>()).map_err(|e| e.to_string()));
            save(&mut c).await;
        }
        // the chain's tip, written as the birthday of each wallet named: a new
        // wallet needs to scan nothing before it existed
        Some("tip") => {
            let mut indexer = zingo_netutils::GrpcIndexer::new(SERVER.parse().unwrap()).await.unwrap();
            let tip = zingo_netutils::Indexer::get_latest_block(&mut indexer, Duration::from_secs(30)).await.unwrap().height;
            for name in &args[1..] {
                std::fs::write(dir(name).join("birthday"), (tip - 10).to_string()).unwrap();
            }
            println!("tip {tip}");
        }
        // the restore gate (docs/DEVELOPMENT.md): a fresh wallet whose phrase and
        // birthday are kept beside it, as a person keeps them on paper
        Some("newseed") => {
            let name = &args[1];
            // a new phrase beside an old wallet would be paper for a different wallet
            assert!(!dir(name).join("zingo-wallet.dat").exists(), "{name} already has a wallet: choose a new name");
            let mut indexer = zingo_netutils::GrpcIndexer::new(SERVER.parse().unwrap()).await.unwrap();
            let tip = zingo_netutils::Indexer::get_latest_block(&mut indexer, Duration::from_secs(30)).await.unwrap().height as u32;
            let phrase = bip0039::Mnemonic::<bip0039::English>::generate(bip0039::Count::Words24).into_phrase();
            std::fs::write(dir(name).join("phrase.txt"), &phrase).unwrap();
            std::fs::write(dir(name).join("birthday"), (tip - 10).to_string()).unwrap();
            let mut c = open(name).await;
            save(&mut c).await;
            println!("[{name}] made at {}", tip - 10);
        }
        // only the paper: the phrase and the birthday, in an empty folder
        Some("restore") => {
            let (name, from) = (&args[1], &args[2]);
            // glory's paper is the public test phrase itself
            if from == "glory" {
                std::fs::write(dir(from).join("phrase.txt"), GLORY).unwrap();
            }
            for file in ["phrase.txt", "birthday"] {
                std::fs::copy(dir(from).join(file), dir(name).join(file)).unwrap();
            }
            assert!(!dir(name).join("zingo-wallet.dat").exists(), "{name} must start empty");
            let c = synced(name).await;
            describe(name, &c).await;
        }
        Some("bench") => {
            // restore, timed (ROADMAP: speed): when a balance first shows, how fast
            // blocks scan, and how long a reader waits on the wallet lock meanwhile
            // (ARCHITECTURE.md, "The engine's lock"); a reader asks every half second
            let (name, from) = (&args[1], &args[2]);
            if from == "glory" {
                std::fs::write(dir(from).join("phrase.txt"), GLORY).unwrap();
            }
            for file in ["phrase.txt", "birthday"] {
                std::fs::copy(dir(from).join(file), dir(name).join(file)).unwrap();
            }
            // a quick run: only the newest <back> blocks, for trying a change; whole runs give the numbers
            if let Some(back) = args.get(3).map(|b| b.parse::<u32>().unwrap()) {
                use zingo_netutils::Indexer;
                let mut indexer = zingo_netutils::GrpcIndexer::new(SERVER.parse().unwrap()).await.unwrap();
                let tip = indexer.get_latest_block(Duration::from_secs(30)).await.unwrap().height as u32;
                std::fs::write(dir(name).join("birthday"), (tip - back).to_string()).unwrap();
            }
            assert!(!dir(name).join("zingo-wallet.dat").exists(), "{name} must start empty");
            let mut c = open(name).await;
            let started = std::time::Instant::now();
            c.sync().await.unwrap();
            let wallet = c.wallet().clone();
            let mut progress = c.subscribe_sync_status();
            let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let reader = {
                let done = done.clone();
                tokio::spawn(async move {
                    let (mut first, mut waits, mut last, mut said) = (None, Vec::new(), None, std::time::Instant::now());
                    while !done.load(std::sync::atomic::Ordering::Acquire) {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        let asked = std::time::Instant::now();
                        let held = wallet.read().await.account_balance(zip32::AccountId::ZERO).ok().map(|b| total(&b));
                        waits.push(asked.elapsed());
                        if first.is_none() && held.is_some_and(|z| z > 0) {
                            first = Some(started.elapsed());
                            println!("[bench] first balance {} after {:?}", held.unwrap(), started.elapsed());
                        }
                        if let Some(s) = progress.borrow_and_update().clone() {
                            last = Some(s);
                        }
                        if said.elapsed() >= Duration::from_secs(60) {
                            said = std::time::Instant::now();
                            if let Some(s) = &last {
                                println!("[bench] {:?}: {} blocks, {:.1}%", started.elapsed(), s.session_blocks_scanned, if s.total_outputs > 0 { s.total_outputs_scanned as f64 * 100.0 / s.total_outputs as f64 } else { 0.0 });
                            }
                        }
                    }
                    (first, waits, last)
                })
            };
            let result = c.await_sync().await;
            let took = started.elapsed();
            done.store(true, std::sync::atomic::Ordering::Release);
            let (first, mut waits, last) = reader.await.unwrap();
            println!("[bench] sync: {:?}", result.map(|r| format!("{}..{}: {} blocks, {} of {} outputs", r.sync_start_height, r.sync_end_height, r.blocks_scanned, r.total_outputs_scanned, r.total_outputs)).map_err(|e| e.to_string()));
            save(&mut c).await;
            let blocks = last.as_ref().map_or(0, |s| s.session_blocks_scanned);
            let outputs = last.as_ref().map_or(0, |s| s.session_sapling_outputs_scanned + s.session_orchard_outputs_scanned + s.session_ironwood_outputs_scanned);
            waits.sort();
            let at = |q: f64| waits.get(((waits.len() as f64 - 1.0) * q).round() as usize).copied().unwrap_or_default();
            println!("[bench] {name}: {took:?} in all; first balance after {first:?}");
            println!("[bench] {blocks} blocks ({:.1}/s), {outputs} shielded outputs ({:.0}/s)", blocks as f64 / took.as_secs_f64(), outputs as f64 / took.as_secs_f64());
            println!("[bench] a reader waited on the wallet lock: median {:?}, 95% {:?}, longest {:?} ({} reads)", at(0.5), at(0.95), at(1.0), waits.len());
        }
        Some("addresses") => {
            let name = &args[1];
            let mut c = open(name).await;
            {
                let mut w = c.wallet().write().await;
                let sapling_only = zingolib::wallet::keys::unified::ReceiverSelection { orchard: false, sapling: true };
                let (_, ua) = w.generate_unified_address(sapling_only, zip32::AccountId::ZERO).unwrap();
                println!("[{name}] sapling-only {}", ua.encode(&ChainType::Testnet));
            }
            save(&mut c).await;
            describe(name, &c).await;
        }
        // pay from one pool only: sendfrom <wallet> <to> <zats> <ironwood|orchard|sapling|transparent>
        Some("sendfrom") => {
            use zcash_protocol::{PoolType, ShieldedPool};
            let (from, to, zats, pool) = (&args[1], &args[2], args[3].parse::<u64>().unwrap(), args[4].as_str());
            let pool = match pool {
                "ironwood" => PoolType::IRONWOOD,
                "orchard" => PoolType::Shielded(ShieldedPool::Orchard),
                "sapling" => PoolType::Shielded(ShieldedPool::Sapling),
                "transparent" => PoolType::Transparent,
                other => panic!("{other}"),
            };
            let mut c = synced(from).await;
            let payment = zcash_client_backend::zip321::Payment::new(zcash_address::ZcashAddress::try_from_encoded(to).unwrap(), Some(Zatoshis::from_u64(zats).unwrap()), None, None, None, vec![]).unwrap();
            let proposal = c.propose_send_from(zcash_client_backend::zip321::TransactionRequest::new(vec![payment]).unwrap(), zip32::AccountId::ZERO, Some(pool)).await;
            println!("[{from}] proposal from {pool:?}: {:?}", proposal.map(|p| p.steps().len()).map_err(|e| e.to_string()));
            let sent = c.send_stored_proposal(true).await;
            println!("[{from}] sent: {:?}", sent.map(|t| t.iter().map(|x| x.to_string()).collect::<Vec<_>>()).map_err(|e| e.to_string()));
            save(&mut c).await;
        }
        // public coins into the private pool, as Laurel's Shield does
        Some("shield") => {
            let name = &args[1];
            let mut c = synced(name).await;
            let proposal = c.propose_shield(zip32::AccountId::ZERO).await;
            println!("[{name}] shield proposal: {:?}", proposal.map(|p| p.steps().len()).map_err(|e| e.to_string()));
            let sent = c.send_stored_proposal(true).await;
            println!("[{name}] shielded: {:?}", sent.map(|t| t.first().to_string()).map_err(|e| e.to_string()));
            save(&mut c).await;
        }
        // the TEX form (ZIP 320) of a transparent address
        Some("tex") => {
            use zcash_address::ToAddress;
            let t = laurel_engine::sweep::sweep_destination(&ChainType::Testnet, &args[1]).unwrap();
            let zcash_transparent::address::TransparentAddress::PublicKeyHash(hash) = t else { panic!("a P2PKH address") };
            println!("{}", zcash_address::ZcashAddress::from_tex(zcash_protocol::consensus::NetworkType::Test, hash).encode());
        }
        // release gate E.2: the process dies mid-send
        //   calculated  signed, and a save tick caught it, but never sent
        //   broadcast   sent, and the process died before anything was saved
        Some("killsend") => {
            let (from, to, zats, stage) = (&args[1], &args[2], args[3].parse::<u64>().unwrap(), args[4].as_str());
            let mut c = synced(from).await;
            let payment = zcash_client_backend::zip321::Payment::new(zcash_address::ZcashAddress::try_from_encoded(to).unwrap(), Some(Zatoshis::from_u64(zats).unwrap()), None, None, None, vec![]).unwrap();
            let proposal = c.propose_send_from(zcash_client_backend::zip321::TransactionRequest::new(vec![payment]).unwrap(), zip32::AccountId::ZERO, None).await;
            println!("[{from}] proposal: {:?}", proposal.map(|p| p.steps().len()).map_err(|e| e.to_string()));
            match stage {
                "calculated" => {
                    let made = c.calculate_stored_proposal().await;
                    println!("[{from}] calculated: {:?}", made.map(|t| t.first().to_string()).map_err(|e| e.to_string()));
                    save(&mut c).await;
                }
                "broadcast" => {
                    let sent = c.send_stored_proposal(true).await;
                    println!("[{from}] sent: {:?}", sent.map(|t| t.first().to_string()).map_err(|e| e.to_string()));
                }
                other => panic!("{other}"),
            }
            println!("[{from}] killed at {stage}");
            std::process::exit(9);
        }
        // what Laurel does on the next start (Sync_SendUnsent): catch up, then
        // send once what a stop left signed but unsent
        Some("resume") => {
            use zingo_status::confirmation_status::ConfirmationStatus;
            let name = &args[1];
            let mut c = synced(name).await;
            let unsent: Vec<_> = c.wallet().read().await.wallet_transactions.values().filter(|t| matches!(t.status(), ConfirmationStatus::Calculated(_))).map(|t| t.txid()).collect();
            println!("[{name}] unsent after catching up: {}", unsent.len());
            if let Some(txids) = nonempty::NonEmpty::from_vec(unsent) {
                println!("[{name}] sent again: {:?}", c.transmit_calculated(txids).await.map(|t| t.len()).map_err(|e| e.to_string()));
            }
            for t in c.wallet().read().await.wallet_transactions.values() {
                println!("[{name}] {} {:?} sent {}", t.txid(), t.status(), t.total_value_sent());
            }
            save(&mut c).await;
        }
        // count <wallet> <zats>: payments of exactly zats that arrived, pending or mined
        // Orchard out, the only way it leaves since NU6.3: Laurel's Move to
        // Ironwood (E_PlanMigration, then E_MigrateNow)
        // offline signing, Laurel's way (w_offline.rs, docs/OFFLINE-SIGNING.md): a
        // view-only copy of the synced state proposes; a signer made from the same
        // snapshot with no server, the spending key put beside it in memory,
        // calculates; the viewing key takes the signed bytes apart and accounts for
        // every zatoshi; then it is broadcast and waited for
        Some("offline") => {
            use std::collections::{BTreeMap, HashMap};
            use pepper_sync::wallet::OutputInterface;
            use zcash_client_backend::TransferType;
            use zcash_primitives::transaction::Transaction;
            use zcash_protocol::consensus::BranchId;
            use zingolib::wallet::keys::unified::UnifiedKeyStore;

            let (name, to, zats) = (&args[1], &args[2], args[3].parse::<u64>().unwrap());
            let account = zip32::AccountId::ZERO;
            let mut c = synced(name).await;
            let (snapshot, usk, ufvk, to, tip) = {
                let mut w = c.wallet().write().await;
                w.mark_dirty();
                let bytes = w.save().unwrap().unwrap();
                let UnifiedKeyStore::Spend(usk) = w.unified_key_store.get(&account).unwrap() else { panic!("{name} must hold its spending key") };
                let usk = (**usk).clone();
                let ufvk = usk.to_unified_full_viewing_key();
                let to = if to == "self" { own_address(&w) } else { to.clone() };
                let tip = w.sync_state.last_known_chain_height().map_or(0, u32::from);
                (bytes, usk, ufvk, to, tip)
            };
            println!("[{name}] snapshot {} bytes at {tip}; paying {zats} to {}…", snapshot.len(), &to[..20]);
            let request = || {
                let payment = zcash_client_backend::zip321::Payment::new(zcash_address::ZcashAddress::try_from_encoded(&to).unwrap(), Some(Zatoshis::from_u64(zats).unwrap()), None, None, None, vec![]).unwrap();
                zcash_client_backend::zip321::TransactionRequest::new(vec![payment]).unwrap()
            };
            let offline = |d: PathBuf| ClientConfig::builder().set_chain_type(ChainType::Testnet).set_wallet_dir(d).set_wallet_config(WalletConfig::Read).build().unwrap();
            let fee_of = |p: &zcash_client_backend::proposal::Proposal<_, _>| p.steps().iter().map(|s| s.balance().fee_required().into_u64()).sum::<u64>();

            // online: the view-only copy proposes (Save Signing Request)
            let mut viewer = LightClient::from_bytes(snapshot.clone(), offline(dir("offline-viewer"))).await.unwrap();
            viewer.wallet().write().await.unified_key_store.insert(account, UnifiedKeyStore::View(Box::new(ufvk.clone())));
            let viewed = viewer.propose_send_from(request(), account, None).await.map(|p| fee_of(&p));
            println!("[{name}] view-only proposal fee: {:?}", viewed.as_ref().map_err(|e| e.to_string()));
            viewer.clear_proposal().await;

            // offline: the signer, with the spending key in memory only
            let mut signer = LightClient::from_bytes(snapshot, offline(dir("offline-signer"))).await.unwrap();
            signer.wallet().write().await.unified_key_store.insert(account, UnifiedKeyStore::Spend(Box::new(usk)));
            let proposal = signer.propose_send_from(request(), account, None).await.unwrap();
            let fee = fee_of(&proposal);
            println!("[{name}] signer proposal fee: {fee}; same as viewed: {}", viewed.as_ref().ok() == Some(&fee));
            let txids = signer.calculate_stored_proposal().await.unwrap();
            let txid = *txids.first();
            let raw = {
                let w = signer.wallet().read().await;
                let mut raw = Vec::new();
                w.wallet_transactions.get(&txid).unwrap().transaction().write(&mut raw).unwrap();
                raw
            };
            drop(signer);

            // online: taken apart with the viewing key, every zatoshi accounted for
            let tx = Transaction::read(&raw[..], BranchId::for_height(&ChainType::Testnet, tip.into())).unwrap();
            println!("[{name}] signed {txid}: {} bytes, expiry {} ({} blocks past the tip)", raw.len(), u32::from(tx.expiry_height()), u32::from(tx.expiry_height()).saturating_sub(tip));
            let d = zcash_client_backend::decrypt_transaction(&ChainType::Testnet, None, None, &tx, &HashMap::from([(account, ufvk)]));
            let mut seen = 0u64;
            for o in d.sapling_outputs() {
                seen += o.note().value().inner();
                println!("[{name}]   sapling {:?} {}", o.transfer_type(), o.note().value().inner());
            }
            for o in d.orchard_outputs().iter().chain(d.ironwood_outputs()) {
                seen += o.note().0.value().inner();
                println!("[{name}]   {:?} {:?} {} to {}", o.note().1, o.transfer_type(), o.note().0.value().inner(), if o.transfer_type() == TransferType::AccountInternal { "change" } else { "the payee" });
            }
            if let Some(b) = tx.transparent_bundle() {
                for v in &b.vout {
                    seen += v.value().into_u64();
                    println!("[{name}]   transparent {}", v.value().into_u64());
                }
            }
            let spent = {
                let w = c.wallet().read().await;
                let (mut sapling, mut orchard, mut ironwood, mut coins) = (BTreeMap::new(), BTreeMap::new(), BTreeMap::new(), BTreeMap::new());
                for t in w.wallet_transactions.values() {
                    for n in t.sapling_notes() { if let Some(nf) = n.spend_link() { sapling.insert(nf, n.value()); } }
                    for n in t.orchard_notes() { if let Some(nf) = n.spend_link() { orchard.insert(nf, n.value()); } }
                    for n in t.ironwood_notes() { if let Some(nf) = n.spend_link() { ironwood.insert(nf, n.value()); } }
                    for k in t.transparent_coins() { if let Some(op) = k.spend_link() { coins.insert(op, k.value()); } }
                }
                let mut total = 0u64;
                if let Some(b) = tx.sapling_bundle() { for s in b.shielded_spends() { total += sapling[s.nullifier()]; } }
                // an action whose nullifier isn't ours is padding's dummy spend: not our money
                if let Some(b) = tx.orchard_bundle() { for a in b.actions() { total += orchard.get(a.nullifier()).copied().unwrap_or(0); } }
                if let Some(b) = tx.ironwood_bundle() { for a in b.actions() { total += ironwood.get(a.nullifier()).copied().unwrap_or(0); } }
                if let Some(b) = tx.transparent_bundle() { for i in &b.vin { total += coins[i.prevout()]; } }
                total
            };
            println!("[{name}] spent {spent} - fee {fee} - seen {seen} = {} (must be 0)", spent as i128 - fee as i128 - seen as i128);

            // online: sent, and waited for
            let mut indexer = zingo_netutils::GrpcIndexer::new(SERVER.parse().unwrap()).await.unwrap();
            let sent = zingo_netutils::Indexer::send_transaction(&mut indexer, zingo_netutils::lightwallet_protocol::RawTransaction { data: raw, height: 0 }, Duration::from_secs(60)).await;
            println!("[{name}] broadcast: {:?}", sent.map_err(|e| e.to_string()));
            mined(name, &mut c, txid).await;
            save(&mut c).await;
        }
        // Laurel's Sapling move (w_move.rs, W_ProposeMove): everything in Sapling, from Sapling
        // only, to the wallet's own newest private address; then, once mined, what it spent
        // and where it arrived: Sapling spent, the rest (all but the fee) in Ironwood
        Some("movesapling") => {
            use pepper_sync::wallet::{IronwoodNote, OrchardNote, SaplingNote};
            use zcash_protocol::{PoolType, ShieldedPool};
            let name = &args[1];
            let mut c = synced(name).await;
            println!("[{name}] before: {}", c.account_balance(zip32::AccountId::ZERO).await.unwrap());
            let own = own_address(&*c.wallet().read().await);
            println!("[{name}] to its own {own}");
            let to = zcash_address::ZcashAddress::try_from_encoded(&own).unwrap();
            let proposal = c.propose_send_all_from(to, None, zip32::AccountId::ZERO, Some(PoolType::Shielded(ShieldedPool::Sapling))).await;
            println!("[{name}] proposal: {:?}", proposal.as_ref().map(|p| {
                let s = p.steps().first();
                (p.steps().len(), s.balance().fee_required().into_u64(), s.transaction_request().payments().values().filter_map(|x| x.amount()).map(|z| z.into_u64()).sum::<u64>())
            }).map_err(|e| e.to_string()));
            if proposal.is_err() {
                return;		// refused (less than the fee, say): nothing was built or sent
            }
            let sent = c.send_stored_proposal(true).await;
            println!("[{name}] sent: {:?}", sent.as_ref().map(|t| t.first().to_string()).map_err(|e| e.to_string()));
            let txid = *sent.unwrap().first();
            save(&mut c).await;
            mined(name, &mut c, txid).await;
            {
                let w = c.wallet().read().await;
                let spent_sapling = spent_by::<SaplingNote>(&w, txid);
                let spent_other = spent_by::<IronwoodNote>(&w, txid) + spent_by::<OrchardNote>(&w, txid);
                let tx = w.wallet_transactions.get(&txid).expect("the move, in the wallet");
                let (ironwood, orchard, sapling) = (arrived::<IronwoodNote>(tx), arrived::<OrchardNote>(tx), arrived::<SaplingNote>(tx));
                println!("[{name}] spent: sapling {spent_sapling}, any other shielded pool {spent_other} (must be 0)");
                println!("[{name}] arrived: ironwood {ironwood}, orchard {orchard}, sapling {sapling}");
                println!("[{name}] fee: {}", spent_sapling as i128 - (ironwood + orchard + sapling) as i128);
            }
            println!("[{name}] after: {}", c.account_balance(zip32::AccountId::ZERO).await.unwrap());
            save(&mut c).await;
        }
        Some("migrate") => {
            let name = &args[1];
            let mut c = synced(name).await;
            let plan = c.plan_immediate_migration(zip32::AccountId::ZERO).await;
            println!("[{name}] plan: {:?}", plan.map(|p| (p.transactions.len(), p.migrated, p.fee)).map_err(|e| e.to_string()));
            let done = c.quick_immediate_migration(zip32::AccountId::ZERO, true).await;
            println!("[{name}] migrated: {:?}", done.map(|d| d.txids.iter().map(|t| t.to_string()).collect::<Vec<_>>()).map_err(|e| e.to_string()));
            save(&mut c).await;
        }
        Some("count") => {
            let (name, zats) = (&args[1], args[2].parse::<u64>().unwrap());
            let c = synced(name).await;
            let n = c.wallet().read().await.wallet_transactions.values().filter(|t| t.total_value_received() == zats).count();
            println!("[{name}] payments of {zats}: {n}");
        }
        // what Laurel does while caught up (w_engine.rs E_DroppedOf): its own payments
        // sent and not yet mined, not within 3 blocks of expiry, sent again, the
        // same bytes. One still held answers as a duplicate: delivered
        Some("rebroadcast") => {
            use pepper_sync::wallet::OutputInterface;
            use zingo_status::confirmation_status::ConfirmationStatus as S;
            let name = &args[1];
            let mut c = synced(name).await;
            let pending: Vec<zcash_protocol::TxId> = {
                let w = c.wallet().read().await;
                let mut ours = std::collections::HashSet::new();
                for t in w.wallet_transactions.values() {
                    ours.extend(t.transparent_coins().iter().filter_map(|o| o.spending_transaction()));
                    ours.extend(t.sapling_notes().iter().filter_map(|o| o.spending_transaction()));
                    ours.extend(t.orchard_notes().iter().filter_map(|o| o.spending_transaction()));
                    ours.extend(t.ironwood_notes().iter().filter_map(|o| o.spending_transaction()));
                }
                let scanned = w.sync_state.fully_scanned_height().map_or(0, u32::from);
                w.wallet_transactions.values()
                    .filter(|t| ours.contains(&t.txid()) && matches!(t.status(), S::Transmitted(_) | S::Mempool(_)))
                    .filter(|t| { let e = u32::from(t.transaction().expiry_height()); e == 0 || scanned + 4 <= e })
                    .map(|t| t.txid())
                    .collect()
            };
            println!("[{name}] pending of ours: {}", pending.len());
            if let Some(pending) = nonempty::NonEmpty::from_vec(pending) {
                for (txid, sent) in c.rebroadcast_pending(pending).await {
                    println!("[{name}] {txid} sent again: {:?}", sent.map_err(|e| e.to_string()));
                }
            }
        }
        // release gate E.1: every transaction this wallet paid for, fetched raw from
        // the server and decoded here, must balance: what it spent = what it paid
        // others + its change + the fee in its own bytes, and that fee is ZIP 317's
        Some("audit") => {
            use pepper_sync::wallet::OutputInterface;
            use std::collections::HashMap;
            use zcash_protocol::consensus::BranchId;
            let name = &args[1];
            let c = synced(name).await;
            let w = c.wallet().read().await;

            // every coin and note the wallet ever held: what each spend took, and the transparent prevouts
            let mut spent: HashMap<zcash_protocol::TxId, u64> = HashMap::new();
            let mut prevouts: HashMap<(zcash_protocol::TxId, u32), u64> = HashMap::new();
            for t in w.wallet_transactions.values() {
                let mut take = |by: Option<zcash_protocol::TxId>, v: u64| if let Some(by) = by { *spent.entry(by).or_default() += v; };
                for o in t.transparent_coins() {
                    take(o.spending_transaction(), o.value());
                    prevouts.insert((o.output_id().txid(), o.output_id().output_index()), o.value());
                }
                for o in t.sapling_notes() { take(o.spending_transaction(), o.value()); }
                for o in t.orchard_notes() { take(o.spending_transaction(), o.value()); }
                for o in t.ironwood_notes() { take(o.spending_transaction(), o.value()); }
            }

            let mut indexer = zingo_netutils::GrpcIndexer::new(SERVER.parse().unwrap()).await.unwrap();
            let (mut checked, mut bad) = (0, 0);
            for (txid, took) in &spent {
                let Some(t) = w.wallet_transactions.get(txid) else { continue };
                let filter = zingo_netutils::lightwallet_protocol::TxFilter { hash: txid.as_ref().to_vec(), ..Default::default() };
                let raw = match zingo_netutils::Indexer::get_transaction(&mut indexer, filter, Duration::from_secs(30)).await {
                    Ok(raw) if raw.height > 0 => raw,
                    other => { println!("[{name}] {txid} not mined or not found: {:?}", other.map(|r| r.height)); continue; }
                };
                let branch = BranchId::for_height(&ChainType::Testnet, zcash_protocol::consensus::BlockHeight::from(raw.height as u32));
                let tx = zcash_primitives::transaction::Transaction::read(raw.data.as_slice(), branch).unwrap();
                let fee = tx.fee_paid(|op| Ok::<_, zcash_protocol::value::BalanceError>(prevouts.get(&(*op.txid(), op.n())).map(|v| Zatoshis::from_u64(*v).unwrap()))).unwrap().map(|z| z.into_u64());

                // ZIP 317: 5,000 per logical action, at least 2
                let t_actions = tx.transparent_bundle().map_or(0, |b| b.vin.len().max(b.vout.len()));
                let s_actions = tx.sapling_bundle().map_or(0, |b| b.shielded_spends().len().max(b.shielded_outputs().len()));
                let o_actions = tx.orchard_bundle().map_or(0, |b| b.actions().len());
                let i_actions = tx.ironwood_bundle().map_or(0, |b| b.actions().len());
                let zip317 = 5_000 * (t_actions + s_actions + o_actions + i_actions).max(2) as u64;

                let (paid, change) = (t.total_value_sent(), t.total_value_received());
                let balanced = fee.is_some_and(|f| *took == paid + change + f);
                let fair = fee == Some(zip317);
                checked += 1;
                if !(balanced && fair) { bad += 1; }
                println!("[{name}] {txid} at {}: spent {took} = paid {paid} + change {change} + fee {fee:?} {} ; fee {} ZIP 317 ({zip317})", raw.height, if balanced { "OK" } else { "MISMATCH" }, if fair { "=" } else { "!=" });
            }
            println!("[{name}] audited {checked} transactions, {bad} wrong");
        }
        _ => println!("see the top of src-tauri/engine/examples/live.rs"),
    }
}
