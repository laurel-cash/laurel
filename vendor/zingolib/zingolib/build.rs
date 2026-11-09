#![forbid(unsafe_code)]
//! - Downloads the Sapling proving parameters into the user's parameter
//!   cache when they are absent, and hands their paths to rustc through
//!   `SAPLING_SPEND_PARAMS` and `SAPLING_OUTPUT_PARAMS`.
//! - Writes `git_description.txt` and `git_description.rs` into `OUT_DIR`
//!   and prints `cargo:rustc-env=ZINGOLIB_DESCRIPTOR`.
//! - Prints `cargo:rerun-if-changed` for this script and both parameter
//!   files; the package tree itself is never watched and never written.
//!
//! LAUREL PATCH (size): only the output key is embedded in a build that
//! ships; the spend key's path is handed over for the tests and testutils,
//! which alone embed it (src/lib.rs), and the app fetches it when a payment
//! first spends Sapling notes (src/wallet/sapling_key.rs).
//! LAUREL PATCH (integrity): the cached output key is embedded only if it is
//! the published one (`params_verified`).
//! LAUREL PATCH (build speed): the git state behind the descriptor is not
//! watched (`register_rerun_watches`).

#[path = "short_commit.rs"]
mod short_commit;

use std::path::{Path, PathBuf};
use std::{env, io, process::Command};

const BUILD_SCRIPT: &str = "build.rs";
const DESCRIPTOR_TEXT_FILE: &str = "git_description.txt";
const DESCRIPTOR_ENV: &str = "ZINGOLIB_DESCRIPTOR";
const DESCRIPTOR_SOURCE_FILE: &str = "git_description.rs";

/// - Prints `cargo:rerun-if-changed` for this script (the parameter files
///   are watched as they are published).
fn register_rerun_watches() {
    println!("cargo:rerun-if-changed={BUILD_SCRIPT}");
    // LAUREL PATCH (build speed): the git state behind the descriptor is not
    // watched. In Laurel's tree every commit moved HEAD, so each one reran
    // this script, changed `git_description`, and rebuilt zingolib and
    // everything above it: minutes per commit, for a string only zingo-cli
    // prints. It is the state at the last rerun, as `--dirty` always was.
}

/// The trimmed stdout of a git command that succeeded with output, or `None`.
fn git_stdout(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|stdout| stdout.trim_end().to_string())
        .filter(|stdout| !stdout.is_empty())
}

/// Whether a tracked file differs from HEAD, as `git describe --dirty` judges it.
fn dirty() -> bool {
    Command::new("git")
        .args(["diff-index", "--quiet", "HEAD", "--"])
        .status()
        .map(|status| !status.success())
        .unwrap_or(false)
}

/// - Runs `git rev-parse HEAD`.
fn short_head() -> Option<String> {
    git_stdout(&["rev-parse", "HEAD"])
        .and_then(|head| short_commit::abbreviate(&head).map(str::to_string))
}

fn descriptor(crate_version: &str, short_head: Option<&str>, dirty: bool) -> String {
    let formatted = match short_head {
        Some(short_head) => format!("zl_{crate_version}_{short_head}"),
        None => format!("zl_{crate_version}"),
    };
    if dirty {
        format!("{formatted}_dirty")
    } else {
        formatted
    }
}

/// - Runs `git rev-parse HEAD` and `git diff-index`.
/// - Prints `cargo:rustc-env=ZINGOLIB_DESCRIPTOR`.
/// - Writes `git_description.txt` and `git_description.rs` into `OUT_DIR`.
fn git_description() -> Result<(), io::Error> {
    let crate_version = env::var("CARGO_PKG_VERSION").unwrap_or_default();
    let description = descriptor(&crate_version, short_head().as_deref(), dirty());

    println!("cargo:rustc-env={DESCRIPTOR_ENV}={description}");

    let out_dir = PathBuf::from(env::var("OUT_DIR").map_err(io::Error::other)?);
    std::fs::write(out_dir.join(DESCRIPTOR_TEXT_FILE), &description)?;
    std::fs::write(
        out_dir.join(DESCRIPTOR_SOURCE_FILE),
        format!(
            "pub fn git_description() -> &'static str {{\n    \
             include_str!(concat!(env!(\"OUT_DIR\"), \"/{DESCRIPTOR_TEXT_FILE}\"))\n\
             }}\n"
        ),
    )
}

// SAPLING_SPEND_HASH, SAPLING_OUTPUT_HASH: one home, shared with the crate
#[allow(dead_code)]
mod params_hashes {
    include!("src/params_hashes.rs");
}
use params_hashes::SAPLING_OUTPUT_HASH;

/// Whether a file holds exactly the parameters with this BLAKE2b-512 hash.
fn params_verified(path: &Path, hash: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| blake2b_simd::blake2b(&bytes).to_hex().as_str() == hash)
}

/// - Downloads the Sapling parameters into the user's parameter cache
///   when they are absent; a cached pair is reused without any network.
/// - Prints `cargo:rustc-env` and `cargo:rerun-if-changed` for each
///   parameter file, so `include_bytes!` in the crate reads the cache
///   directly and a vanished file reruns this script.
/// - Panics when the download fails, or when the output key is still not
///   the published one after a fresh download.
fn get_zcash_params() {
    println!("Checking if params are available...");

    let params_path = match zcash_proofs::download_sapling_parameters(Some(400)) {
        Ok(p) => {
            println!("Params downloaded!");
            println!("Spend path: {}", p.spend.to_str().unwrap());
            println!("Output path: {}", p.output.to_str().unwrap());
            p
        }
        Err(e) => {
            println!("Error downloading params: {e}");
            panic!();
        }
    };

    // LAUREL PATCH (integrity): the cached output key is what the crate
    // embeds, and zcash_proofs trusts a cached file for existing. Any other
    // copy is removed and fetched again, a download zcash_proofs checks.
    let params_path = if params_verified(&params_path.output, SAPLING_OUTPUT_HASH) {
        params_path
    } else {
        println!("cargo:warning=zcash-params: the cached output key is not the published one; fetching it again");
        std::fs::remove_file(&params_path.output).ok();
        let again = zcash_proofs::download_sapling_parameters(Some(400)).expect("the output key downloads");
        assert!(params_verified(&again.output, SAPLING_OUTPUT_HASH), "the downloaded output key is the published one");
        again
    };

    publish_param_path("SAPLING_SPEND_PARAMS", &params_path.spend);
    publish_param_path("SAPLING_OUTPUT_PARAMS", &params_path.output);
}

/// - Prints `cargo:rustc-env={variable}={path}` and
///   `cargo:rerun-if-changed={path}`.
fn publish_param_path(variable: &str, path: &Path) {
    let path = path.display();
    println!("cargo:rustc-env={variable}={path}");
    println!("cargo:rerun-if-changed={path}");
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    register_rerun_watches();
    get_zcash_params();
    git_description()?;
    Ok(())
}
