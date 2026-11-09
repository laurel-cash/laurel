// LAUREL PATCH (integrity): the published Sapling parameters' BLAKE2b-512
// hashes, as zcash_proofs knows them (SAPLING_SPEND_HASH and
// SAPLING_OUTPUT_HASH, private there) and zcashd's fetch-params.sh checks
// them. One home: build.rs includes this file to verify the output key it
// embeds, a test verifies what was embedded, and wallet::sapling_key
// verifies the spend key the app fetches, at every use. A proving key that
// isn't the published one can make proofs that give away what they should
// hide, so nothing else is ever proven with.

pub const SAPLING_SPEND_HASH: &str = "8270785a1a0d0bc77196f000ee6d221c9c9894f55307bd9357c3f0105d31ca63991ab91324160d8f53e2bbd3c2633a6eb8bdf5205d822e7f3f73edac51b2b70c";
pub const SAPLING_OUTPUT_HASH: &str = "657e3d38dbb5cb5e7dd2970e8b03d69b4787dd907285b5a7f0790dcc8072f60bf593b32cc2d1c030e00ff5ae64bf84c5c3beb84ddc841d48264b4a171744d028";
