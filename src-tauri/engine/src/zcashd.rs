//! Sapling spending keys exported from zcashd (`z_exportkey`, or every
//! key at once in a `z_exportwallet` file), made into spending accounts.
//!
//! zcashd shut down before NU6.3, and people hold its keys as text:
//! `secret-extended-key-main1…`. A Unified Spending Key needs Orchard and
//! transparent parts too, so each Sapling key is paired with fresh random
//! ones: the account finds and spends the Sapling key's money as any
//! other, while the fresh parts back nothing up. A wallet made this way is
//! for moving that money into a wallet with a recovery phrase, not for
//! receiving (Laurel refuses Receive on it).

use rand::Rng;
use secrecy::ExposeSecret;
use secrecy::zeroize::Zeroize;
use thiserror::Error;

use sapling_crypto::zip32::ExtendedSpendingKey;
use zcash_address::unified::Typecode;
use zcash_encoding::CompactSize;
use zcash_keys::keys::{Era, UnifiedSpendingKey};
use zcash_protocol::consensus::Parameters as _;

use zingolib::config::ChainType;

use crate::sweep::SweepKey;

/// Why text holds no key that can be imported. Carries no key material.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ZcashdKeyError {
    /// Nothing in the text looks like a Sapling spending key.
    #[error("there's no zcashd Sapling key (secret-extended-key…) in this text")]
    NoKey,
    /// A key with the right beginning that doesn't decode: a typo.
    #[error("a Sapling key in this text has a typo")]
    Typo,
    /// A Sapling key of the other network.
    #[error("this key is for {0}")]
    OtherNetwork(&'static str),
    /// Only Sprout keys: that pool can't be spent from here.
    #[error("these are Sprout keys, which can't be imported")]
    SproutOnly,
    /// A fresh key couldn't be made (never expected).
    #[error("the account couldn't be made: {0}")]
    Build(String),
}

/// What a pasted text holds: the Sapling keys to import, and what else was
/// recognised so it can be pointed elsewhere, never silently dropped.
#[derive(Clone)]
pub struct ZcashdKeys {
    /// The Sapling spending keys, each once, in the order found.
    pub sapling: Vec<ExtendedSpendingKey>,
    /// Sprout keys seen (SK… / ST…): not importable.
    pub sprout: usize,
    /// Transparent private keys seen: swept, not imported.
    pub transparent: usize,
}

/// Never prints a key: only how many of each kind.
impl std::fmt::Debug for ZcashdKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZcashdKeys")
            .field("sapling", &self.sapling.len())
            .field("sprout", &self.sprout)
            .field("transparent", &self.transparent)
            .finish()
    }
}

const MAINNET_HRP: &str = zcash_keys::constants::mainnet::HRP_SAPLING_EXTENDED_SPENDING_KEY;
const TESTNET_HRP: &str = zcash_keys::constants::testnet::HRP_SAPLING_EXTENDED_SPENDING_KEY;

/// The keys in `text`: one pasted key, zcashd's JSON answer, or a whole
/// `z_exportwallet` file (a key, a date and a comment per line).
pub fn read_zcashd_keys(chain: &ChainType, text: &str) -> Result<ZcashdKeys, ZcashdKeyError> {
    let ours = zcash_keys::constants::hrp_sapling_extended_spending_key(chain.network_type());
    let mut found = ZcashdKeys {
        sapling: Vec::new(),
        sprout: 0,
        transparent: 0,
    };
    let mut other_network = None;

    for token in text.split_whitespace() {
        let token = token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
        if let Some((hrp, _)) = token.split_once('1').filter(|(h, _)| h.starts_with("secret-extended-key-")) {
            if hrp != ours {
                other_network = Some(match hrp {
                    MAINNET_HRP => "Mainnet",
                    TESTNET_HRP => "Testnet",
                    _ => return Err(ZcashdKeyError::Typo),
                });
                continue;
            }
            let key = zcash_keys::encoding::decode_extended_spending_key(ours, token)
                .map_err(|_| ZcashdKeyError::Typo)?;
            if !found.sapling.contains(&key) {
                found.sapling.push(key);
            }
        } else if (token.starts_with("SK") || token.starts_with("ST")) && token.len() > 50 {
            found.sprout += 1;
        } else if SweepKey::from_wif(chain, token).is_ok() {
            found.transparent += 1;
        }
    }

    match (found.sapling.is_empty(), other_network, found.sprout) {
        (false, _, _) => Ok(found),
        (true, Some(net), _) => Err(ZcashdKeyError::OtherNetwork(net)),
        (true, None, 0) => Err(ZcashdKeyError::NoKey),
        (true, None, _) => Err(ZcashdKeyError::SproutOnly),
    }
}

/// A Unified Spending Key (the encoding `UnifiedKeyStore::new_from_usk`
/// reads) that spends with `sapling`, and fresh Orchard and transparent
/// keys from a random seed that is dropped at once.
pub fn usk_for_sapling_key(chain: &ChainType, sapling: &ExtendedSpendingKey) -> Result<Vec<u8>, ZcashdKeyError> {
    let mut seed = [0u8; 32];
    zingolib::utils::system_rng().fill_bytes(&mut seed);
    let fresh = UnifiedSpendingKey::from_seed(chain, &seed, zip32::AccountId::ZERO);
    seed.zeroize();
    let fresh = fresh.map_err(|e| ZcashdKeyError::Build(format!("{e:?}")))?;

    let mut bytes = Vec::new();
    let mut part = |typecode: Typecode, key: &[u8]| {
        CompactSize::write(&mut bytes, usize::try_from(typecode).expect("a typecode fits")).expect("writes to a vec");
        CompactSize::write(&mut bytes, key.len()).expect("writes to a vec");
        bytes.extend_from_slice(key);
    };
    // the era word, as the encoding writes it (Era's id is private)
    let era = fresh.to_bytes(Era::Orchard).expose_secret()[..4].to_vec();
    part(Typecode::ORCHARD, fresh.orchard().to_bytes());
    part(Typecode::SAPLING, &sapling.to_bytes());
    part(Typecode::P2PKH, &fresh.transparent().to_bytes());

    let mut usk = era;
    usk.append(&mut bytes);

    // what the wallet will read back, checked here, once
    let back = UnifiedSpendingKey::from_bytes(Era::Orchard, &usk).map_err(|e| ZcashdKeyError::Build(format!("{e:?}")))?;
    if back.sapling() != sapling {
        return Err(ZcashdKeyError::Build("the Sapling key didn't survive the encoding".into()));
    }
    Ok(usk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_keys::encoding::encode_extended_spending_key;

    fn key(n: u8) -> ExtendedSpendingKey {
        ExtendedSpendingKey::master(&[n; 32]).expect("a 32-byte seed makes a master key")
    }

    fn encoded(hrp: &str, n: u8) -> String {
        encode_extended_spending_key(hrp, &key(n))
    }

    #[test]
    fn one_pasted_key_is_read() {
        let found = read_zcashd_keys(&ChainType::Testnet, &format!("  {}\n", encoded(TESTNET_HRP, 1))).unwrap();
        assert_eq!(found.sapling, vec![key(1)]);
    }

    /// A `z_exportwallet` file: comments, dates, zaddr notes, a Sprout
    /// key and transparent keys among the Sapling ones.
    #[test]
    fn a_whole_export_file_is_read_and_the_rest_is_counted() {
        let sweep = {
            let mut payload = [0x11u8; 32].to_vec();
            payload.push(1);
            let mut b = zcash_keys::constants::testnet::B58_SECRET_KEY_PREFIX.to_vec();
            b.extend_from_slice(&payload);
            bs58::encode(b).with_check().into_string()
        };
        let file = format!(
            "# Wallet dump created by Zcash v5.0.0\n# * Created on 2022-01-01T00:00:00Z\n\n\
             {sweep} 2021-05-01T10:00:00Z label= # addr=tmXXXX\n\
             # Sapling keys\n\
             {} 2021-05-01T10:00:00Z # zaddr=ztestsapling1aaa\n\
             {} 2021-06-01T10:00:00Z # zaddr=ztestsapling1bbb\n\
             {} 2021-06-01T10:00:00Z # zaddr=ztestsapling1bbb (again)\n\
             # Sprout keys\n\
             ST{} 2019-01-01T00:00:00Z # zaddr=ztXXX\n\
             # End of dump\n",
            encoded(TESTNET_HRP, 1),
            encoded(TESTNET_HRP, 2),
            encoded(TESTNET_HRP, 2),
            "x".repeat(60),
        );
        let found = read_zcashd_keys(&ChainType::Testnet, &file).unwrap();
        assert_eq!(found.sapling, vec![key(1), key(2)], "each key once, in order");
        assert_eq!(found.sprout, 1);
        assert_eq!(found.transparent, 1);
        assert!(!format!("{found:?}").contains("secret-extended"), "Debug holds no key");
    }

    #[test]
    fn zcashds_json_answer_is_read() {
        let json = format!("\"{}\"", encoded(TESTNET_HRP, 3));
        assert_eq!(read_zcashd_keys(&ChainType::Testnet, &json).unwrap().sapling, vec![key(3)]);
    }

    #[test]
    fn nothing_the_other_network_a_typo_or_sprout_is_said_plainly() {
        assert_eq!(read_zcashd_keys(&ChainType::Testnet, "hello").unwrap_err(), ZcashdKeyError::NoKey);
        assert_eq!(
            read_zcashd_keys(&ChainType::Testnet, &encoded(MAINNET_HRP, 1)).unwrap_err(),
            ZcashdKeyError::OtherNetwork("Mainnet")
        );
        let mut typo = encoded(TESTNET_HRP, 1);
        typo.pop();
        typo.push(if typo.ends_with('q') { 'p' } else { 'q' });
        assert_eq!(read_zcashd_keys(&ChainType::Testnet, &typo).unwrap_err(), ZcashdKeyError::Typo);
        assert_eq!(
            read_zcashd_keys(&ChainType::Testnet, &format!("SK{}", "x".repeat(60))).unwrap_err(),
            ZcashdKeyError::SproutOnly
        );
    }

    /// The account spends with the imported key: its Sapling part is that
    /// key, and two imports of one key differ only in the fresh parts.
    #[test]
    fn the_account_spends_with_the_imported_key() {
        let usk = usk_for_sapling_key(&ChainType::Testnet, &key(4)).unwrap();
        let read = UnifiedSpendingKey::from_bytes(Era::Orchard, &usk).unwrap();
        assert_eq!(read.sapling(), &key(4));

        let again = UnifiedSpendingKey::from_bytes(Era::Orchard, &usk_for_sapling_key(&ChainType::Testnet, &key(4)).unwrap()).unwrap();
        assert_ne!(read.orchard().to_bytes(), again.orchard().to_bytes(), "fresh parts are fresh");

        let wallet_keys = zingolib::wallet::keys::unified::UnifiedKeyStore::new_from_usk(&usk).unwrap();
        assert!(matches!(wallet_keys, zingolib::wallet::keys::unified::UnifiedKeyStore::Spend(_)));
    }

    /// A wallet of imported keys: an account per key, in order, and the
    /// same keys after the wallet file is written and read.
    #[test]
    fn a_wallet_of_imported_keys_survives_its_file() {
        use zingolib::config::WalletConfig;
        use zingolib::wallet::keys::unified::UnifiedKeyStore;
        use zingolib::wallet::{LightWallet, WalletSettings};

        let usks = [key(5), key(6)].iter().map(|k| usk_for_sapling_key(&ChainType::Testnet, k).unwrap()).collect();
        let mut wallet = LightWallet::new(
            ChainType::Testnet,
            WalletConfig::Usks { usks, birthday: 3_000_000, wallet_settings: WalletSettings::default() },
        )
        .unwrap();
        wallet.mark_dirty();
        let bytes = wallet.save().unwrap().unwrap();
        let read = LightWallet::read(bytes.as_slice(), ChainType::Testnet).unwrap();

        for (account, expected) in [(0u32, key(5)), (1, key(6))] {
            let UnifiedKeyStore::Spend(usk) = &read.unified_key_store[&zip32::AccountId::try_from(account).unwrap()] else {
                panic!("account {account} can spend");
            };
            assert_eq!(usk.sapling(), &expected);
        }
        assert!(read.recovery_info().is_none(), "no phrase: nothing to call a backup");
    }
}
