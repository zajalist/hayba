//! Hierarchical seed derivation for the Hayba planetary simulation.
//!
//! The contract is simple: a single user-facing `MasterSeed(u64)` deterministically
//! derives every random quantity in the sim. Same master seed →  byte-identical
//! world, on any machine, forever.
//!
//! The hierarchy:
//!   master
//!     ├── stellar    (orbit n-body integration jitter)
//!     ├── tectonic   (plate generation, initial positions)
//!     │   ├── region(lat, lon)   (regional LEM seeds)
//!     │   │   └── local(lat, lon, scale)  (local detail synthesis)
//!     │   └── ...
//!     ├── climate    (initial atmospheric noise)
//!     └── biome      (species placement noise)
//!
//! Implementation: SplitMix64. It is:
//! - Bit-exact deterministic (pure integer math, no platform intrinsics)
//! - Fast (a handful of XOR + multiply + shift per draw)
//! - Well-distributed (passes BigCrush)
//! - The same algorithm used to seed `std::rand` in Rust itself
//!
//! This crate does NOT provide a general PRNG interface; it specifically
//! provides *deterministic key derivation*. Use it to turn a high-level
//! identifier (master seed + scope name + coordinate) into a fresh `u64`
//! you can feed to whatever downstream sampler your sim needs.

/// User-facing root seed. The user picks this integer once.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct MasterSeed(pub u64);

/// One stable scope identifier per simulation pillar.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    Stellar,
    Tectonic,
    Climate,
    Hydrology,
    Biome,
    Local,
}

impl Scope {
    /// Stable integer tags. Never reorder — these go into the bit-exact
    /// derivation and reshuffling them would invalidate every world that
    /// was ever generated.
    #[inline]
    pub const fn tag(self) -> u64 {
        match self {
            Scope::Stellar   => 0x0000_0001_0000_0001,
            Scope::Tectonic  => 0x0000_0001_0000_0002,
            Scope::Climate   => 0x0000_0001_0000_0003,
            Scope::Hydrology => 0x0000_0001_0000_0004,
            Scope::Biome     => 0x0000_0001_0000_0005,
            Scope::Local     => 0x0000_0001_0000_0006,
        }
    }
}

/// SplitMix64 — bit-exact deterministic PRNG step.
/// Magic constants are fixed by the algorithm spec.
#[inline]
pub const fn splitmix64(state: u64) -> u64 {
    let mut z = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Derive a child seed for a given scope. Pure function — no internal state.
#[inline]
pub const fn derive_scope(master: MasterSeed, scope: Scope) -> u64 {
    let mut state = master.0;
    state = splitmix64(state ^ scope.tag());
    state
}

/// Derive a child seed for a specific cell or region within a scope, keyed
/// by integer coordinates. Two coords are enough for lat/lon, plate-id, or
/// region-index addressing.
#[inline]
pub const fn derive_coord(master: MasterSeed, scope: Scope, a: i64, b: i64) -> u64 {
    let mut state = derive_scope(master, scope);
    // Fold each coord in via splitmix to spread bits before final mix.
    state = splitmix64(state ^ (a as u64));
    state = splitmix64(state ^ (b as u64));
    state
}

/// Derive a seed for a refinement at a deeper scale tier within a region.
/// `parent_seed` is the seed produced by `derive_coord` at the region scale;
/// `tile_x` / `tile_y` are the tile coordinates within that region.
#[inline]
pub const fn derive_subtile(parent_seed: u64, tile_x: i64, tile_y: i64) -> u64 {
    let mut state = parent_seed;
    state = splitmix64(state ^ (tile_x as u64));
    state = splitmix64(state ^ (tile_y as u64));
    state
}

/// Convenience PRNG built on top: keep drawing fresh `u64`s from a seed.
/// Not a full BigCrush-passing generator — for that we'd point users at
/// rand_xoshiro or similar. This is just for the sim to seed its own
/// downstream noise generators deterministically.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct SeedStream {
    state: u64,
}

impl SeedStream {
    #[inline]
    pub const fn new(seed: u64) -> Self { Self { state: seed } }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform integer in `[0, max)`. Rejection-sampled to remove modulo
    /// bias — same result on every architecture.
    pub fn next_below(&mut self, max: u64) -> u64 {
        if max == 0 { return 0; }
        let threshold = u64::MAX - (u64::MAX % max);
        loop {
            let v = self.next_u64();
            if v < threshold { return v % max; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_master_same_scope_same_seed() {
        let m = MasterSeed(42);
        assert_eq!(derive_scope(m, Scope::Tectonic), derive_scope(m, Scope::Tectonic));
    }

    #[test]
    fn different_scopes_yield_different_seeds() {
        let m = MasterSeed(42);
        let a = derive_scope(m, Scope::Tectonic);
        let b = derive_scope(m, Scope::Climate);
        assert_ne!(a, b);
    }

    #[test]
    fn coord_derivation_is_position_sensitive() {
        let m = MasterSeed(42);
        let a = derive_coord(m, Scope::Tectonic, 100, 200);
        let b = derive_coord(m, Scope::Tectonic, 200, 100);
        assert_ne!(a, b, "swapped coords must produce different seeds");
    }

    #[test]
    fn subtile_derivation_is_independent_across_regions() {
        let m = MasterSeed(42);
        let region_a = derive_coord(m, Scope::Tectonic, 0, 0);
        let region_b = derive_coord(m, Scope::Tectonic, 1, 0);
        assert_ne!(
            derive_subtile(region_a, 5, 7),
            derive_subtile(region_b, 5, 7),
        );
    }

    #[test]
    fn frozen_outputs_lock_the_contract() {
        // CRITICAL: these constants are part of our public determinism
        // contract. Any change to SplitMix64 or scope tags will break
        // every world that was ever generated. Do NOT update these
        // numbers — if a test starts failing, the algorithm changed and
        // the change must be reverted.
        let m = MasterSeed(12345);
        assert_eq!(splitmix64(0),                              0xE220_A839_7B1D_CDAF);
        assert_eq!(derive_scope(m, Scope::Tectonic),           0xC929_9E5E_DC6A_1828);
        assert_eq!(derive_coord(m, Scope::Tectonic, 0, 0),     0x62E1_8A89_6EA2_5057);
        assert_eq!(derive_coord(m, Scope::Climate, 42, -42),   0xF132_1308_EAB9_D2A8);
    }

    #[test]
    fn seedstream_is_deterministic() {
        let mut a = SeedStream::new(0xDEADBEEF);
        let mut b = SeedStream::new(0xDEADBEEF);
        for _ in 0..1000 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn seedstream_below_respects_bounds() {
        let mut s = SeedStream::new(7);
        for _ in 0..10_000 {
            let v = s.next_below(13);
            assert!(v < 13);
        }
    }
}
