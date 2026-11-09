//! laurel-engine: what Laurel adds to the wallet engine, on its public API.
//!
//! zingolib is vendored with the least change it can carry (Laurel's
//! docs/ENGINE.md); anything that needs only the engine's public API is
//! here, in Laurel's own code, not in the vendored tree.

pub mod sweep;
pub mod zcashd;
