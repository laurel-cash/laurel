//! Sweeping a single transparent private key (WIF, as zcashd's
//! `dumpprivkey` and paper wallets give it) into an address of this wallet.
//!
//! The key is never added to the wallet: its coins are spent once, in one
//! transparent-only transaction, to a transparent address the caller
//! chooses (the wallet's own), and the key is dropped. Nothing here touches
//! wallet state, so a sweep cannot corrupt a wallet; the caller finds the
//! coins (a server's `GetAddressUtxos`) and broadcasts the result.
//!
//! Built with the same upstream [`Builder`] configuration as
//! zingolib's `wallet::transparent`, and fee-sized by ZIP 317 from the real inputs.

use secrecy::zeroize::Zeroizing;
use thiserror::Error;

use zcash_primitives::transaction::builder::{BuildConfig, Builder, BundlePadding};
use zcash_primitives::transaction::fees::zip317;
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::consensus::{BlockHeight, BranchId, Parameters as _};
use zcash_protocol::value::Zatoshis;
use zcash_transparent::address::TransparentAddress;
use zcash_transparent::builder::TransparentSigningSet;
use zcash_transparent::bundle::{OutPoint, TxOut};

use zingolib::config::ChainType;

/// Coins spent by one sweep at most. A P2PKH input is about 150 bytes, so
/// this keeps the transaction far below the 100 kB standard size; a key
/// holding more is swept again for the rest.
pub const MAX_SWEEP_COINS: usize = 400;

/// The WIF payload of a compressed key: 32 key bytes and the 0x01 flag.
const COMPRESSED_LEN: usize = 33;
/// The WIF payload of an uncompressed key: the 32 key bytes alone.
const UNCOMPRESSED_LEN: usize = 32;
/// The longest WIF decoded, checksum included: the prefix, a compressed
/// payload and the 4-byte base58check checksum. Longer is not a key.
const WIF_MAX_LEN: usize = 1 + COMPRESSED_LEN + 4;

/// Why a key can't be swept. Carries no key material.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SweepError {
    /// Not base58check at all, or a checksum mismatch: a typo.
    #[error("this isn't a private key, or it has a typo")]
    NotAKey,
    /// A private key for the other network.
    #[error("this private key is for {0}")]
    OtherNetwork(&'static str),
    /// An uncompressed key: its address is a different one, which these
    /// builders never sign for.
    #[error("this is an uncompressed private key, which can't be swept yet")]
    Uncompressed,
    /// The key's address holds nothing.
    #[error("there is no money at this key's address")]
    Empty,
    /// What the key holds doesn't cover the fee.
    #[error("the {total} zatoshis at this key don't cover the {fee} zatoshi fee")]
    TooSmall {
        /// Everything at the key.
        total: u64,
        /// The fee a sweep would pay.
        fee: u64,
    },
    /// The upstream builder refused.
    #[error("the sweep couldn't be built: {0}")]
    Build(String),
}

/// A private key read from WIF. Its secret is erased on drop (`Drop` below):
/// `secp256k1`'s `SecretKey` is `Copy` and doesn't erase itself, and the copy
/// handed to the signer (`add_key`) is the builder's to drop.
pub struct SweepKey {
    secret: secp256k1::SecretKey,
    address: TransparentAddress,
}

impl Drop for SweepKey {
    fn drop(&mut self) {
        // best effort: the compiler may have left other copies (security review A-07)
        self.secret.non_secure_erase();
    }
}

/// Never prints the key: only the address it controls.
impl std::fmt::Debug for SweepKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SweepKey")
            .field("address", &self.address)
            .finish_non_exhaustive()
    }
}

impl SweepKey {
    /// Reads a WIF private key for `chain`. Surrounding whitespace is the
    /// only thing forgiven: base58 is case-sensitive, and any other change
    /// fails the checksum anyway.
    pub fn from_wif(chain: &ChainType, text: &str) -> Result<Self, SweepError> {
        // decoded straight into a buffer wiped when this returns, on every path,
        // a failed checksum too (into_vec drops its Vec unwiped on an error)
        let mut bytes = Zeroizing::new([0u8; WIF_MAX_LEN]);
        let len = bs58::decode(text.trim())
            .with_check(None)
            .onto(&mut bytes[..])
            .map_err(|_| SweepError::NotAKey)?;
        let (prefix, payload) = bytes[..len].split_first().ok_or(SweepError::NotAKey)?;

        if [*prefix] != zcash_keys::constants::b58_secret_key_prefix(chain.network_type()) {
            let mainnet = zcash_keys::constants::mainnet::B58_SECRET_KEY_PREFIX;
            let testnet = zcash_keys::constants::testnet::B58_SECRET_KEY_PREFIX;
            return Err(if [*prefix] == mainnet {
                SweepError::OtherNetwork("Mainnet")
            } else if [*prefix] == testnet {
                SweepError::OtherNetwork("Testnet")
            } else {
                SweepError::NotAKey
            });
        }
        let secret = match payload.len() {
            COMPRESSED_LEN if payload[32] == 1 => &payload[..32],
            UNCOMPRESSED_LEN => return Err(SweepError::Uncompressed),
            _ => return Err(SweepError::NotAKey),
        };
        let secret = <[u8; 32]>::try_from(secret)
            .ok()
            .and_then(|bytes| secp256k1::SecretKey::from_secret_bytes(bytes).ok())
            .ok_or(SweepError::NotAKey)?;
        let pubkey = secret.public_key();

        Ok(Self {
            secret,
            address: TransparentAddress::from_pubkey(&pubkey),
        })
    }

    /// The transparent address this key controls.
    #[must_use]
    pub fn address(&self) -> &TransparentAddress {
        &self.address
    }

    /// The address, as the chain writes it (t1… or tm…).
    #[must_use]
    pub fn encoded_address(&self, chain: &ChainType) -> String {
        pepper_sync::keys::transparent::encode_address(chain, self.address)
    }
}

/// A coin at the key's address: where it is and what it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepCoin {
    /// The output that holds it.
    pub outpoint: OutPoint,
    /// Its value.
    pub value: Zatoshis,
}

impl SweepCoin {
    /// A coin as a server's `GetAddressUtxos` reports it: the txid's 32
    /// bytes, the output index and the value. Anything else is refused,
    /// never guessed at.
    pub fn from_utxo(txid: &[u8], index: i32, value_zat: i64) -> Result<Self, SweepError> {
        let bad = || SweepError::Build("the server reported a malformed coin".into());
        let txid: [u8; 32] = txid.try_into().map_err(|_| bad())?;
        let index = u32::try_from(index).map_err(|_| bad())?;
        let value = u64::try_from(value_zat)
            .ok()
            .and_then(|v| Zatoshis::from_u64(v).ok())
            .ok_or_else(bad)?;
        Ok(Self {
            outpoint: OutPoint::new(txid, index),
            value,
        })
    }
}

/// A transparent address of `chain`, the only kind a sweep pays.
pub fn sweep_destination(chain: &ChainType, text: &str) -> Result<TransparentAddress, SweepError> {
    match zcash_keys::address::Address::decode(chain, text) {
        Some(zcash_keys::address::Address::Transparent(address)) => Ok(address),
        _ => Err(SweepError::Build(
            "a sweep pays a transparent address of this network".into(),
        )),
    }
}

/// What a sweep of these coins moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SweepPlan {
    /// Coins spent (the largest first, at most [`MAX_SWEEP_COINS`]).
    pub coins: usize,
    /// Coins left at the key for another sweep.
    pub left: usize,
    /// Everything the spent coins hold.
    pub total: Zatoshis,
    /// The ZIP 317 fee.
    pub fee: Zatoshis,
    /// What arrives: total less the fee.
    pub amount: Zatoshis,
}

/// A signed sweep, ready to broadcast.
#[derive(Clone, Debug)]
pub struct SweepTx {
    /// The transaction id.
    pub txid: TxId,
    /// The serialized transaction.
    pub raw: Vec<u8>,
    /// What it moves.
    pub plan: SweepPlan,
}

fn build_config() -> BuildConfig {
    BuildConfig::Standard {
        sapling_anchor: None,
        orchard_anchor: None,
        ironwood_anchor: None,
        orchard_padding: BundlePadding::DEFAULT,
        ironwood_padding: BundlePadding::DEFAULT,
    }
}

/// The coins one sweep spends: the largest first, at most [`MAX_SWEEP_COINS`].
fn chosen(coins: &[SweepCoin]) -> Vec<SweepCoin> {
    let mut coins = coins.to_vec();
    coins.sort_by(|a, b| b.value.cmp(&a.value));
    coins.truncate(MAX_SWEEP_COINS);
    coins
}

/// A builder spending `coins` from `key` and paying `amount` to `to`.
fn builder(
    chain: ChainType,
    target_height: BlockHeight,
    key: &SweepKey,
    coins: &[SweepCoin],
    to: &TransparentAddress,
    amount: Zatoshis,
    signing: &mut TransparentSigningSet,
) -> Result<Builder<ChainType, ()>, SweepError> {
    let pubkey = signing.add_key(key.secret);
    let mut builder = Builder::new(chain, target_height, build_config());
    for coin in coins {
        builder
            .add_transparent_p2pkh_input(
                pubkey,
                coin.outpoint.clone(),
                TxOut::new(coin.value, key.address.script().into()),
            )
            .map_err(|e| SweepError::Build(format!("input: {e:?}")))?;
    }
    builder
        .add_transparent_output(to, amount)
        .map_err(|e| SweepError::Build(format!("output: {e:?}")))?;
    Ok(builder)
}

/// What sweeping `coins` would move, before anything is signed.
pub fn plan_sweep(
    chain: ChainType,
    target_height: BlockHeight,
    key: &SweepKey,
    coins: &[SweepCoin],
    to: &TransparentAddress,
) -> Result<SweepPlan, SweepError> {
    let spent = chosen(coins);
    if spent.is_empty() {
        return Err(SweepError::Empty);
    }
    let total = Zatoshis::from_u64(spent.iter().map(|c| c.value.into_u64()).sum())
        .map_err(|_| SweepError::Build("the coins add up past the money supply".into()))?;

    // the fee depends only on the shape (inputs and one output), not the amount
    let sizing = builder(
        chain,
        target_height,
        key,
        &spent,
        to,
        Zatoshis::ZERO,
        &mut TransparentSigningSet::new(),
    )?;
    let fee = sizing
        .get_fee(&zip317::FeeRule::standard())
        .map_err(|e| SweepError::Build(format!("fee: {e:?}")))?;
    let amount = (total - fee)
        .filter(|a| *a > Zatoshis::ZERO)
        .ok_or(SweepError::TooSmall {
            total: total.into_u64(),
            fee: fee.into_u64(),
        })?;

    Ok(SweepPlan {
        coins: spent.len(),
        left: coins.len() - spent.len(),
        total,
        fee,
        amount,
    })
}

/// Builds and signs the sweep of `coins` from `key` to `to`.
pub fn build_sweep(
    chain: ChainType,
    target_height: BlockHeight,
    key: &SweepKey,
    coins: &[SweepCoin],
    to: &TransparentAddress,
) -> Result<SweepTx, SweepError> {
    let plan = plan_sweep(chain, target_height, key, coins, to)?;
    let mut signing = TransparentSigningSet::new();
    let builder = builder(
        chain,
        target_height,
        key,
        &chosen(coins),
        to,
        plan.amount,
        &mut signing,
    )?;

    // transparent coins only: no Sapling spend to prove
    let built = builder
        .build(
            &signing,
            &[],
            &[],
            zingolib::utils::system_rng(),
            &zingolib::wallet::sapling_key::SpendKey::NotNeeded,
            zingolib::wallet::sapling_key::output_prover(),
            &zip317::FeeRule::standard(),
        )
        .map_err(|e| SweepError::Build(format!("{e:?}")))?;

    let mut raw = Vec::new();
    built
        .transaction()
        .write(&mut raw)
        .map_err(|e| SweepError::Build(format!("write: {e}")))?;
    let txid = Transaction::read(raw.as_slice(), BranchId::for_height(&chain, target_height))
        .map_err(|e| SweepError::Build(format!("read back: {e}")))?
        .txid();

    Ok(SweepTx { txid, raw, plan })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A testnet key made for these tests (holds nothing).
    fn test_key_bytes() -> [u8; 32] {
        [0x11; 32]
    }

    fn wif(prefix: [u8; 1], payload: &[u8]) -> String {
        let mut bytes = prefix.to_vec();
        bytes.extend_from_slice(payload);
        bs58::encode(bytes).with_check().into_string()
    }

    fn compressed(prefix: [u8; 1]) -> String {
        let mut payload = test_key_bytes().to_vec();
        payload.push(1);
        wif(prefix, &payload)
    }

    const TESTNET: [u8; 1] = zcash_keys::constants::testnet::B58_SECRET_KEY_PREFIX;
    const MAINNET: [u8; 1] = zcash_keys::constants::mainnet::B58_SECRET_KEY_PREFIX;

    fn coin(n: u8, zats: u64) -> SweepCoin {
        SweepCoin {
            outpoint: OutPoint::new([n; 32], 0),
            value: Zatoshis::from_u64(zats).unwrap(),
        }
    }

    fn height() -> BlockHeight {
        // well past every upgrade on testnet, so the current rules apply
        BlockHeight::from_u32(4_000_000)
    }

    /// The published relation between a key and its address: the same
    /// secret, read through WIF, controls the address its public key hashes to.
    #[test]
    fn a_key_controls_the_address_of_its_public_key() {
        let key = SweepKey::from_wif(&ChainType::Testnet, &compressed(TESTNET)).unwrap();
        let secret = secp256k1::SecretKey::from_secret_bytes(test_key_bytes()).unwrap();
        let pubkey = secret.public_key();
        assert_eq!(key.address(), &TransparentAddress::from_pubkey(&pubkey));
        assert!(key.encoded_address(&ChainType::Testnet).starts_with("tm"));
    }

    /// An outside vector: secret key 1's compressed public key is the
    /// generator point, whose hash160 is the well-known 751e76e8…3bd6.
    #[test]
    fn secret_key_one_controls_the_generators_hash() {
        let mut one = [0u8; 32];
        one[31] = 1;
        let mut payload = one.to_vec();
        payload.push(1);
        let key = SweepKey::from_wif(&ChainType::Mainnet, &wif(MAINNET, &payload)).unwrap();
        let TransparentAddress::PublicKeyHash(hash) = key.address() else {
            panic!("a key controls a P2PKH address");
        };
        assert_eq!(hex::encode(hash), "751e76e8199196d454941c45d1b3a323f1433bd6");
        assert!(key.encoded_address(&ChainType::Mainnet).starts_with("t1"));
    }

    #[test]
    fn surrounding_space_is_forgiven_and_nothing_else() {
        let text = compressed(TESTNET);
        assert!(SweepKey::from_wif(&ChainType::Testnet, &format!("  {text}\n")).is_ok());

        let mut typo = text.clone().into_bytes();
        typo[10] = if typo[10] == b'a' { b'b' } else { b'a' };
        assert_eq!(
            SweepKey::from_wif(&ChainType::Testnet, std::str::from_utf8(&typo).unwrap()).unwrap_err(),
            SweepError::NotAKey
        );
        assert_eq!(
            SweepKey::from_wif(&ChainType::Testnet, &text.to_lowercase()).unwrap_err(),
            SweepError::NotAKey,
            "base58 is case-sensitive"
        );
    }

    #[test]
    fn the_other_network_is_named() {
        assert_eq!(
            SweepKey::from_wif(&ChainType::Testnet, &compressed(MAINNET)).unwrap_err(),
            SweepError::OtherNetwork("Mainnet")
        );
        assert_eq!(
            SweepKey::from_wif(&ChainType::Mainnet, &compressed(TESTNET)).unwrap_err(),
            SweepError::OtherNetwork("Testnet")
        );
    }

    #[test]
    fn longer_than_any_key_is_not_a_key() {
        // one byte past a compressed payload: past the decode buffer, an error, not a panic
        let mut payload = test_key_bytes().to_vec();
        payload.extend_from_slice(&[1, 0]);
        assert_eq!(
            SweepKey::from_wif(&ChainType::Testnet, &wif(TESTNET, &payload)).unwrap_err(),
            SweepError::NotAKey
        );
        assert_eq!(SweepKey::from_wif(&ChainType::Testnet, "").unwrap_err(), SweepError::NotAKey);
    }

    #[test]
    fn an_uncompressed_key_is_refused_by_name() {
        assert_eq!(
            SweepKey::from_wif(&ChainType::Testnet, &wif(TESTNET, &test_key_bytes())).unwrap_err(),
            SweepError::Uncompressed
        );
    }

    #[test]
    fn debug_shows_no_key() {
        let key = SweepKey::from_wif(&ChainType::Testnet, &compressed(TESTNET)).unwrap();
        let text = format!("{key:?}");
        assert!(!text.contains(&hex::encode(test_key_bytes())));
        assert!(!text.to_lowercase().contains("secret"));
    }

    #[test]
    fn a_plan_moves_everything_less_the_zip317_fee() {
        let key = SweepKey::from_wif(&ChainType::Testnet, &compressed(TESTNET)).unwrap();
        let to = *key.address();
        let plan = plan_sweep(
            ChainType::Testnet,
            height(),
            &key,
            &[coin(1, 60_000), coin(2, 40_000), coin(3, 25_000)],
            &to,
        )
        .unwrap();
        assert_eq!(plan.coins, 3);
        assert_eq!(plan.total.into_u64(), 125_000);
        assert_eq!(plan.fee.into_u64(), 15_000, "ZIP 317: 5000 x max(2, 3 inputs)");
        assert_eq!(plan.amount.into_u64(), 110_000);
    }

    #[test]
    fn nothing_or_too_little_is_said_plainly() {
        let key = SweepKey::from_wif(&ChainType::Testnet, &compressed(TESTNET)).unwrap();
        let to = *key.address();
        assert_eq!(
            plan_sweep(ChainType::Testnet, height(), &key, &[], &to).unwrap_err(),
            SweepError::Empty
        );
        assert_eq!(
            plan_sweep(ChainType::Testnet, height(), &key, &[coin(1, 10_000)], &to).unwrap_err(),
            SweepError::TooSmall {
                total: 10_000,
                fee: 10_000
            }
        );
    }

    #[test]
    fn a_key_with_too_many_coins_is_swept_largest_first() {
        let key = SweepKey::from_wif(&ChainType::Testnet, &compressed(TESTNET)).unwrap();
        let to = *key.address();
        let coins: Vec<SweepCoin> = (0..MAX_SWEEP_COINS + 5)
            .map(|i| SweepCoin {
                outpoint: OutPoint::new([(i % 251) as u8; 32], i as u32),
                value: Zatoshis::from_u64(10_000 + i as u64).unwrap(),
            })
            .collect();
        let plan = plan_sweep(ChainType::Testnet, height(), &key, &coins, &to).unwrap();
        assert_eq!(plan.coins, MAX_SWEEP_COINS);
        assert_eq!(plan.left, 5);
        let smallest_left: u64 = (0..5).map(|i| 10_000 + i).sum();
        let all: u64 = coins.iter().map(|c| c.value.into_u64()).sum();
        assert_eq!(plan.total.into_u64(), all - smallest_left);
    }

    #[test]
    fn a_servers_coin_is_read_or_refused() {
        let coin = SweepCoin::from_utxo(&[7; 32], 2, 50_000).unwrap();
        assert_eq!(coin.outpoint, OutPoint::new([7; 32], 2));
        assert_eq!(coin.value.into_u64(), 50_000);
        assert!(SweepCoin::from_utxo(&[7; 31], 2, 50_000).is_err(), "a short txid");
        assert!(SweepCoin::from_utxo(&[7; 32], -1, 50_000).is_err(), "a negative index");
        assert!(SweepCoin::from_utxo(&[7; 32], 2, -5).is_err(), "a negative value");
    }

    #[test]
    fn a_sweep_pays_only_a_transparent_address_of_its_network() {
        let key = SweepKey::from_wif(&ChainType::Testnet, &compressed(TESTNET)).unwrap();
        let text = key.encoded_address(&ChainType::Testnet);
        assert_eq!(sweep_destination(&ChainType::Testnet, &text).unwrap(), *key.address());
        assert!(sweep_destination(&ChainType::Mainnet, &text).is_err());
        assert!(sweep_destination(&ChainType::Testnet, "not an address").is_err());
    }

    /// The signed transaction spends exactly the coins and pays the plan.
    #[test]
    fn the_sweep_signs_what_was_planned() {
        let key = SweepKey::from_wif(&ChainType::Testnet, &compressed(TESTNET)).unwrap();
        let to = *key.address();
        let coins = [coin(1, 60_000), coin(2, 40_000)];
        let swept = build_sweep(ChainType::Testnet, height(), &key, &coins, &to).unwrap();

        let tx = Transaction::read(
            swept.raw.as_slice(),
            BranchId::for_height(&ChainType::Testnet, height()),
        )
        .unwrap();
        assert_eq!(tx.txid(), swept.txid);
        let bundle = tx.transparent_bundle().unwrap();
        assert_eq!(bundle.vin.len(), 2);
        assert_eq!(bundle.vout.len(), 1);
        assert_eq!(bundle.vout[0].value(), swept.plan.amount);
        assert_eq!(swept.plan.amount.into_u64(), 90_000);
        assert!(tx.sapling_bundle().is_none() && tx.orchard_bundle().is_none());
    }
}
