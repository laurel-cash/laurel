//! LAUREL PATCH (size): Sapling's two proving keys, kept apart.
//!
//! The output key (3.6 MB) is compiled in: any payment to a Sapling address
//! proves with it. The spend key (48 MB) is not: only a payment that spends
//! Sapling notes proves with it, and compiled in it was two thirds of the
//! app's download, for money most wallets no longer hold. The app says
//! where a copy is ([`use_spend_params`]); every use reads the file again
//! and checks it is the published key, so a file changed after it was
//! checked is refused, never proven with.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use sapling_crypto::bundle::GrothProofBytes;
use sapling_crypto::circuit::{OutputParameters, SpendParameters};
use sapling_crypto::prover::SpendProver;

use crate::params_hashes::{SAPLING_OUTPUT_HASH, SAPLING_SPEND_HASH};

/// The spend key's file name, as Zcash publishes it and wallets keep it.
pub const SPEND_PARAMS_NAME: &str = "sapling-spend.params";
/// Its size: anything longer is not it, so a download stops there.
pub const SPEND_PARAMS_BYTES: u64 = 47_958_396;
/// Where Zcash publishes it, whole or in parts `.part.1`, `.part.2`
/// (zcash_proofs' own source: its hash is checked, not the server).
pub const SPEND_PARAMS_URL: &str = "https://download.z.cash/downloads/sapling-spend.params";

// the checked copy the app named, if any
static SPEND_PATH: Mutex<Option<(PathBuf, Stamp)>> = Mutex::new(None);

// a file as it was when checked: its size and when it last changed. A copy
// put over it since, or cut short, is not ready until it is checked again
type Stamp = (u64, Option<std::time::SystemTime>);

fn stamp(path: &Path) -> Option<Stamp> {
    std::fs::metadata(path).ok().map(|m| (m.len(), m.modified().ok()))
}
// the compiled-in output key, read once
static OUTPUT: OnceLock<OutputParameters> = OnceLock::new();

/// Why the spend key can't be used.
#[derive(Debug, thiserror::Error)]
pub enum SaplingKeyError {
    /// No copy was named, or the named one is gone.
    #[error("Sapling's spend proving key ({SPEND_PARAMS_NAME}) is not on this device")]
    Missing,
    /// A file that is not the published key: damaged, cut short, or swapped.
    #[error("{0} is not Sapling's published spend proving key")]
    NotPublished(PathBuf),
    /// The file couldn't be read.
    #[error("reading {0}: {1}")]
    Read(PathBuf, std::io::Error),
}

/// Whether these bytes are the published spend key (a download, before it is kept).
pub fn is_spend_key(bytes: &[u8]) -> bool {
    bytes.len() as u64 == SPEND_PARAMS_BYTES
        && blake2b_simd::blake2b(bytes).to_hex().as_str() == SAPLING_SPEND_HASH
}

/// The file's bytes, if they are the published spend key.
fn read_published(path: &Path) -> Result<Vec<u8>, SaplingKeyError> {
    let len = std::fs::metadata(path)
        .map_err(|e| SaplingKeyError::Read(path.to_path_buf(), e))?
        .len();
    // the size first: a wrong file of any length is refused without reading it all
    if len != SPEND_PARAMS_BYTES {
        return Err(SaplingKeyError::NotPublished(path.to_path_buf()));
    }
    let bytes = std::fs::read(path).map_err(|e| SaplingKeyError::Read(path.to_path_buf(), e))?;
    if !is_spend_key(&bytes) {
        return Err(SaplingKeyError::NotPublished(path.to_path_buf()));
    }
    Ok(bytes)
}

/// Names the copy of the spend key to prove with, once it checks out.
pub fn use_spend_params(path: &Path) -> Result<(), SaplingKeyError> {
    read_published(path)?;
    let checked = stamp(path).ok_or(SaplingKeyError::Missing)?;
    *SPEND_PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some((path.to_path_buf(), checked));
    Ok(())
}

/// Whether a named copy is still there, unchanged since it was checked (it
/// is checked again when used besides).
pub fn spend_params_ready() -> bool {
    SPEND_PATH
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|(p, checked)| stamp(p).as_ref() == Some(checked))
}

/// The compiled-in output key.
pub fn output_prover() -> &'static OutputParameters {
    OUTPUT.get_or_init(|| {
        let bytes = crate::SaplingParams::OUTPUT;
        // build.rs embeds only the published key; checked once more here, as
        // the spend key is at every use, for the price of hashing 3.6 MB once
        assert_eq!(
            blake2b_simd::blake2b(bytes).to_hex().as_str(),
            SAPLING_OUTPUT_HASH,
            "the embedded output key is the published one"
        );
        OutputParameters::read(bytes, false).expect("the embedded output key parses")
    })
}

/// What proves Sapling spends: the key, read and checked now, when the
/// transaction spends Sapling notes; nothing when it doesn't, as a builder
/// with no Sapling spends asks for no spend proof (sapling-crypto's
/// `BundleType::num_spends`: none requested, none padded).
pub enum SpendKey {
    /// The published key, read and checked for this transaction.
    Loaded(Box<SpendParameters>),
    /// The transaction spends no Sapling notes.
    NotNeeded,
}

#[cfg(test)]
thread_local! {
    static SPEND_LOADS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many times this thread went for the spend key (a test's witness that
/// a build without Sapling spends never does).
#[cfg(test)]
pub(crate) fn spend_key_loads() -> usize {
    SPEND_LOADS.with(std::cell::Cell::get)
}

impl SpendKey {
    pub(crate) fn for_spends(spends_sapling: bool) -> Result<Self, SaplingKeyError> {
        if !spends_sapling {
            return Ok(Self::NotNeeded);
        }
        #[cfg(test)]
        SPEND_LOADS.with(|loads| loads.set(loads.get() + 1));
        let path = SPEND_PATH
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|(p, _)| p.clone())
            .ok_or(SaplingKeyError::Missing)?;
        if !path.is_file() {
            return Err(SaplingKeyError::Missing);
        }
        let bytes = read_published(&path)?;
        let params = SpendParameters::read(&bytes[..], false)
            .map_err(|e| SaplingKeyError::Read(path, e))?;
        Ok(Self::Loaded(Box::new(params)))
    }
}

impl SpendProver for SpendKey {
    type Proof = <SpendParameters as SpendProver>::Proof;

    fn prepare_circuit(
        proof_generation_key: sapling_crypto::ProofGenerationKey,
        diversifier: sapling_crypto::Diversifier,
        rseed: sapling_crypto::Rseed,
        value: sapling_crypto::value::NoteValue,
        alpha: jubjub::Fr,
        rcv: sapling_crypto::value::ValueCommitTrapdoor,
        anchor: bls12_381::Scalar,
        merkle_path: sapling_crypto::MerklePath,
    ) -> Option<sapling_crypto::circuit::Spend> {
        SpendParameters::prepare_circuit(
            proof_generation_key,
            diversifier,
            rseed,
            value,
            alpha,
            rcv,
            anchor,
            merkle_path,
        )
    }

    fn create_proof<R: rand::Rng>(
        &self,
        circuit: sapling_crypto::circuit::Spend,
        rng: &mut R,
    ) -> Self::Proof {
        match self {
            Self::Loaded(params) => params.create_proof(circuit, rng),
            // for_spends(false) only where the transaction has no Sapling spend
            Self::NotNeeded => unreachable!("a Sapling spend proof for a transaction said to have none"),
        }
    }

    fn encode_proof(proof: Self::Proof) -> GrothProofBytes {
        SpendParameters::encode_proof(proof)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HYPOTHESIS: what was compiled in is the published output key.
    /// Falsified by a changed output blob. (A shipped build has no spend
    /// key to look for: `SaplingParams::SPEND` exists only for the tests
    /// and testutils, whose mock chain proves spends without a fetch.)
    #[test]
    fn the_published_output_key_is_embedded() {
        let _ = output_prover(); // checks the output key's hash
    }

    /// HYPOTHESIS: a file is refused unless it is the published spend key,
    /// whatever its size, and a transaction without Sapling spends needs
    /// none. Falsified by a same-size impostor or a short file accepted.
    #[test]
    fn a_spend_key_is_the_published_one_or_refused() {
        let dir = tempfile::tempdir().unwrap();
        let short = dir.path().join("short.params");
        std::fs::write(&short, b"not a key").unwrap();
        assert!(matches!(use_spend_params(&short), Err(SaplingKeyError::NotPublished(_))));

        let impostor = vec![0u8; SPEND_PARAMS_BYTES as usize];
        assert!(!is_spend_key(&impostor));
        let at = dir.path().join("impostor.params");
        std::fs::write(&at, &impostor).unwrap();
        assert!(matches!(use_spend_params(&at), Err(SaplingKeyError::NotPublished(_))));

        assert!(matches!(use_spend_params(&dir.path().join("absent")), Err(SaplingKeyError::Read(..))));
        assert!(!spend_params_ready(), "nothing refused is named");
        assert!(matches!(SpendKey::for_spends(false), Ok(SpendKey::NotNeeded)));
        assert!(matches!(SpendKey::for_spends(true), Err(SaplingKeyError::Missing)));

        // the published key, named: ready. Changed after (a copy put over it, cut
        // short): not ready, and refused at use. One test, as the name is the process's
        let published = crate::wallet::utils::get_zcash_params_path().unwrap().join(SPEND_PARAMS_NAME);
        if !published.is_file() {
            return;		// the build fetches it (build.rs); a machine without it can't say more
        }
        let copy = dir.path().join(SPEND_PARAMS_NAME);
        std::fs::copy(&published, &copy).unwrap();
        use_spend_params(&copy).unwrap();
        assert!(spend_params_ready());
        assert!(matches!(SpendKey::for_spends(true), Ok(SpendKey::Loaded(_))));
        let mut bytes = std::fs::read(&copy).unwrap();
        bytes[1000] ^= 1;
        std::fs::write(&copy, &bytes).unwrap();
        assert!(!spend_params_ready(), "a key changed since it was checked is checked again");
        assert!(matches!(SpendKey::for_spends(true), Err(SaplingKeyError::NotPublished(_))));
    }
}
