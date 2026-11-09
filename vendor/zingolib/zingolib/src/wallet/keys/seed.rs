//! A wallet's seed: its BIP-39 mnemonic together with the optional
//! passphrase (the "25th word").
//!
//! BIP-39 derives the seed from both. Deriving from the mnemonic alone
//! gives a different wallet whenever a passphrase was set, so keys come
//! only from [`WalletSeed::to_seed`], which cannot forget it
//! (`clippy.toml` bans `Mnemonic::to_seed` everywhere else).

use bip0039::Mnemonic;
use secrecy::zeroize::Zeroize;

/// A mnemonic and the passphrase that goes with it. An empty passphrase is
/// BIP-39's "no passphrase": both derive the same seed.
#[derive(Clone, PartialEq)]
pub struct WalletSeed {
    mnemonic: Mnemonic,
    passphrase: String,
}

impl WalletSeed {
    /// A seed from a mnemonic and its passphrase (empty for none).
    #[must_use]
    pub fn new(mnemonic: Mnemonic, passphrase: String) -> Self {
        Self {
            mnemonic,
            passphrase,
        }
    }

    /// The mnemonic.
    #[must_use]
    pub fn mnemonic(&self) -> &Mnemonic {
        &self.mnemonic
    }

    /// The passphrase; empty when none was set.
    #[must_use]
    pub fn passphrase(&self) -> &str {
        &self.passphrase
    }

    /// The 64-byte BIP-39 seed, from the mnemonic and its passphrase.
    #[must_use]
    #[allow(clippy::disallowed_methods)] // the one place allowed to: it passes the passphrase
    pub fn to_seed(&self) -> [u8; 64] {
        self.mnemonic.to_seed(&self.passphrase)
    }
}

/// The passphrase is wiped here; the mnemonic wipes its own words and
/// entropy as it drops (bip0039 0.14 keeps them in `Zeroizing`; W1-08).
impl Drop for WalletSeed {
    fn drop(&mut self) {
        self.passphrase.zeroize();
    }
}

/// Never prints the words or the passphrase: only whether there is one.
impl std::fmt::Debug for WalletSeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalletSeed")
            .field("words", &self.mnemonic.phrase().split(' ').count())
            .field("has_passphrase", &!self.passphrase.is_empty())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn seed(passphrase: &str) -> WalletSeed {
        WalletSeed::new(
            Mnemonic::from_phrase(PHRASE).unwrap(),
            passphrase.to_string(),
        )
    }

    /// BIP-39's published vector for this phrase with passphrase "TREZOR".
    #[test]
    fn the_passphrase_reaches_the_seed() {
        let with = seed("TREZOR").to_seed();
        assert_eq!(
            hex::encode(&with[..8]),
            "c55257c360c07c72",
            "BIP-39 test vector"
        );
        assert_ne!(with, seed("").to_seed());
    }

    #[test]
    fn debug_shows_neither_words_nor_passphrase() {
        let text = format!("{:?}", seed("hunter2"));
        assert!(!text.contains("abandon"));
        assert!(!text.contains("hunter2"));
        assert!(text.contains("has_passphrase: true"));
    }

    // W1-04: the phrase as the wallet hands it out to be shown is never formatted either
    const WORDS_24: [&str; 24] = [
        "zebra", "violin", "oxygen", "walnut", "yellow", "kitten", "lobster", "marble",
        "nephew", "pepper", "quarter", "rabbit", "salmon", "tomato", "umbrella", "velvet",
        "wagon", "yogurt", "anchor", "bamboo", "cactus", "dolphin", "eagle", "falcon",
    ];

    fn recovery_info() -> crate::wallet::RecoveryInfo {
        crate::wallet::RecoveryInfo {
            seed_phrase: WORDS_24.join(" "),
            passphrase: "hunter2".to_string(),
            birthday: 419_200,
            no_of_accounts: 2,
            birthday_adjusted_from: None,
        }
    }

    #[test]
    fn recovery_info_debug_shows_neither_words_nor_passphrase() {
        let text = format!("{:?}", recovery_info());
        let tokens: Vec<&str> = text.split(|c: char| !c.is_ascii_alphanumeric()).collect();
        for word in WORDS_24 {
            assert!(!tokens.contains(&word), "{word} in {text}");
        }
        assert!(!text.contains("hunter2"));
        assert!(text.contains("419200"), "{text}");
        assert!(text.contains("has_passphrase: true"), "{text}");
    }

    // Whether a type implements Display, with no dependency: the inherent const exists
    // only where T: Display, and a path to it falls back to the trait's otherwise
    struct Shows<T: ?Sized>(std::marker::PhantomData<T>);
    trait NotShown {
        const SHOWN: bool = false;
    }
    impl<T: ?Sized> NotShown for Shows<T> {}
    impl<T: ?Sized + std::fmt::Display> Shows<T> {
        #[allow(dead_code)]
        const SHOWN: bool = true;
    }

    #[test]
    fn recovery_info_has_no_display() {
        assert!(Shows::<String>::SHOWN, "the probe itself sees Display");
        assert!(!Shows::<crate::wallet::RecoveryInfo>::SHOWN);
    }
}

// Moved from wallet/disk/testing/tests.rs: the passphrase's file tests live
// with the passphrase, in Laurel's own file, not inside an upstream one.
#[cfg(test)]
/// Current bytes as upstream's layout (before version 45, and upstream's
/// 45): the same, less the passphrase after the birthday (which must be
/// empty to drop).
pub(crate) fn without_passphrase_field(current: &[u8]) -> Vec<u8> {
    const VERSION_AND_CHAIN: usize = 9;
    let seed_len = usize::from(current[VERSION_AND_CHAIN]);
    assert!(seed_len < 253, "a one-byte CompactSize");
    let passphrase_at = VERSION_AND_CHAIN + 1 + seed_len + 4;
    assert_eq!(
        current[passphrase_at..passphrase_at + 8],
        0u64.to_le_bytes(),
        "an empty passphrase"
    );
    let mut bytes = current[..passphrase_at].to_vec();
    bytes.extend_from_slice(&current[passphrase_at + 8..]);
    bytes
}

/// The passphrase ("25th word") is part of the seed: it changes every key,
/// survives the wallet file, reaches recovery info and the salvage reader,
/// and a file from before version 45 reads as having none.
#[cfg(test)]
mod passphrase_file {
    use crate::config::{ChainType, WalletConfig};
    use crate::wallet::{LightWallet, WalletSettings};

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn wallet(passphrase: &str) -> LightWallet {
        LightWallet::new(
            ChainType::Mainnet,
            WalletConfig::MnemonicPhraseWithPassphrase {
                mnemonic_phrase: PHRASE.to_string(),
                passphrase: passphrase.to_string(),
                no_of_accounts: 1.try_into().unwrap(),
                birthday: 2_000_000,
                wallet_settings: WalletSettings::default(),
            },
        )
        .unwrap()
    }

    fn first_address(wallet: &LightWallet) -> String {
        wallet.transparent_addresses().values().next().unwrap().clone()
    }

    fn saved(wallet: &mut LightWallet) -> Vec<u8> {
        wallet.save_required = true;
        wallet.save().unwrap().expect("save required")
    }

    #[test]
    fn the_passphrase_changes_every_key() {
        let plain = wallet("");
        let with = wallet("Correct Horse");
        assert_ne!(first_address(&plain), first_address(&with));
        assert_ne!(first_address(&with), first_address(&wallet("correct horse")), "case counts");
    }

    #[test]
    fn an_empty_passphrase_is_the_plain_phrase() {
        let plain = LightWallet::new(
            ChainType::Mainnet,
            WalletConfig::MnemonicPhrase {
                mnemonic_phrase: PHRASE.to_string(),
                no_of_accounts: 1.try_into().unwrap(),
                birthday: 2_000_000,
                wallet_settings: WalletSettings::default(),
            },
        )
        .unwrap();
        assert_eq!(first_address(&plain), first_address(&wallet("")));
    }

    #[test]
    fn the_passphrase_survives_the_wallet_file() {
        let mut original = wallet("Correct Horse");
        let bytes = saved(&mut original);
        let read = LightWallet::read(bytes.as_slice(), ChainType::Mainnet).unwrap();

        assert_eq!(read.recovery_info().unwrap().passphrase, "Correct Horse");
        assert_eq!(first_address(&read), first_address(&original));

        let salvaged = LightWallet::read_recovery_info(bytes.as_slice()).unwrap();
        assert_eq!(salvaged, original.recovery_info().unwrap());
    }

    #[test]
    fn a_new_account_derives_with_the_passphrase() {
        let mut with = wallet("Correct Horse");
        with.create_new_account().unwrap();
        let mut plain = wallet("");
        plain.create_new_account().unwrap();
        let account = zip32::AccountId::try_from(1).unwrap();
        let ufvk = |w: &LightWallet| {
            zcash_keys::keys::UnifiedFullViewingKey::try_from(&w.unified_key_store[&account])
                .unwrap()
                .encode(&w.chain_type())
        };
        assert_ne!(ufvk(&with), ufvk(&plain));
    }

    #[test]
    fn a_file_before_version_45_has_no_passphrase() {
        let bytes = super::without_passphrase_field(&saved(&mut wallet("")));
        let mut v44 = bytes.clone();
        v44[..8].copy_from_slice(&44u64.to_le_bytes());
        let read = LightWallet::read(v44.as_slice(), ChainType::Mainnet).unwrap();
        assert_eq!(read.recovery_info().unwrap().passphrase, "");
        assert_eq!(read.read_version(), 44);
    }

    /// Laurel wrote the passphrase as version 45 before upstream gave 45 to
    /// the sync state: such a file still opens, passphrase and all.
    #[test]
    fn laurels_version_45_keeps_its_passphrase() {
        let mut original = wallet("Correct Horse");
        let mut bytes = saved(&mut original);
        bytes[..8].copy_from_slice(&45u64.to_le_bytes());
        let read = LightWallet::read(bytes.as_slice(), ChainType::Mainnet).unwrap();
        assert_eq!(read.recovery_info().unwrap().passphrase, "Correct Horse");
        assert_eq!(first_address(&read), first_address(&original));
        let salvaged = LightWallet::read_recovery_info(bytes.as_slice()).unwrap();
        assert_eq!(salvaged.passphrase, "Correct Horse");
    }

    /// Upstream's version 45 has no passphrase field: it opens as none.
    #[test]
    fn upstreams_version_45_has_no_passphrase() {
        let mut original = wallet("");
        let mut bytes = super::without_passphrase_field(&saved(&mut original));
        bytes[..8].copy_from_slice(&45u64.to_le_bytes());
        let read = LightWallet::read(bytes.as_slice(), ChainType::Mainnet).unwrap();
        assert_eq!(read.recovery_info().unwrap().passphrase, "");
        assert_eq!(first_address(&read), first_address(&original));
        let salvaged = LightWallet::read_recovery_info(bytes.as_slice()).unwrap();
        assert_eq!(salvaged, original.recovery_info().unwrap());
    }

    #[test]
    fn a_passphrase_with_no_seed_is_refused() {
        let mut bytes = LightWallet::serialized_version().to_le_bytes().to_vec();
        bytes.push(0); // mainnet
        bytes.push(0); // no seed
        bytes.extend_from_slice(&2_000_000u32.to_le_bytes());
        bytes.extend_from_slice(&1u64.to_le_bytes());
        bytes.push(b'x');
        bytes.push(0); // no accounts
        let error = LightWallet::read(bytes.as_slice(), ChainType::Mainnet).unwrap_err();
        assert!(error.to_string().contains("passphrase but no seed"), "{error}");
    }
}
