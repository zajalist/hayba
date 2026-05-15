//! Determinism: version contract + RNG seeding.
//!
//! Hayba Phase 8. Guarantees bit-identical runs across machines for a given
//! (seed, version) pair. Provides:
//!
//! * [`DETERMINISM_VERSION`] — semver-ish string burned into save headers so
//!   loaders can warn (but not refuse) on a contract change.
//! * [`split_mix_64`] — the canonical SplitMix64 step (Steele/Vigna).
//! * [`DeterministicRng`] — thin SplitMix64 wrapper with `next_u64`,
//!   `next_f64`, and `gen_range` for `f64`.
//! * [`derive_substream`] — label → independent substream via FNV-1a mix,
//!   so different sim phases get uncorrelated sequences from one master seed.
//! * [`SaveHeader`] + [`check_save_compat`] — versioned save framing.
//!
//! Determinism audit (phase 8): the crate contains **no** `thread_rng`,
//! `OsRng`, `rand::random`, or `SystemTime::now` call sites in sim state.
//! `Instant::now` appears once in `sphere::grid` inside a `#[ignore]`-d
//! benchmark test, not in production. Internal collections use `Vec` or
//! id-sorted `Vec` (see e.g. `Model::add_plate`); no `HashMap`/`HashSet`
//! is iterated over sim state. `rand`/`rand_pcg` are declared dependencies
//! but currently unused.

use serde::{Deserialize, Serialize};

/// Save-format / determinism contract version. Bump when the byte layout of
/// frames, the RNG substream derivation, or the per-step order changes in a
/// way that breaks reproducibility against prior saves.
pub const DETERMINISM_VERSION: &str = "2026.05-v2-phase8";

// ─────────────────────────────────────────────────────────────────────────
// SplitMix64
// ─────────────────────────────────────────────────────────────────────────

/// One step of the canonical SplitMix64 generator
/// (Steele, Lea, Flood, 2014; constants per Vigna's reference impl).
///
/// `state` is advanced in place; the mixed output is returned.
#[inline]
pub fn split_mix_64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

// ─────────────────────────────────────────────────────────────────────────
// DeterministicRng
// ─────────────────────────────────────────────────────────────────────────

/// SplitMix64-backed deterministic RNG. Cheap to construct, cheap to clone,
/// fully reproducible across machines for the same seed.
#[derive(Debug, Clone)]
pub struct DeterministicRng {
    state: u64,
}

impl DeterministicRng {
    /// Construct from a master seed. The seed is used verbatim — no further
    /// mixing — so callers wanting independent streams should go through
    /// [`derive_substream`].
    #[inline]
    pub fn new(master_seed: u64) -> Self {
        Self { state: master_seed }
    }

    /// Next raw 64-bit sample.
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        split_mix_64(&mut self.state)
    }

    /// Next `f64` in `[0.0, 1.0)` with 53 bits of precision (standard
    /// IEEE-754 mantissa width).
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        // Take the top 53 bits to avoid the rounding bias of the bottom bits.
        let bits = self.next_u64() >> 11;
        (bits as f64) * (1.0 / ((1u64 << 53) as f64))
    }

    /// Uniform `f64` in `[low, high)`. Panics if `low >= high` or either
    /// bound is non-finite.
    #[inline]
    pub fn gen_range(&mut self, range: std::ops::Range<f64>) -> f64 {
        let std::ops::Range { start: low, end: high } = range;
        assert!(low.is_finite() && high.is_finite(), "gen_range: non-finite bounds");
        assert!(low < high, "gen_range: empty or inverted range {low}..{high}");
        low + (high - low) * self.next_f64()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Substream derivation
// ─────────────────────────────────────────────────────────────────────────

/// FNV-1a 64 of `label`. Deterministic, no allocations, no platform deps.
#[inline]
fn fnv1a_64(label: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xCBF2_9CE4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01B3;
    let mut h = FNV_OFFSET;
    for b in label.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// Derive an independent RNG substream from `master` and a textual `label`.
/// Same `(master, label)` → same substream, on any machine, on any run.
#[inline]
pub fn derive_substream(master: u64, label: &str) -> DeterministicRng {
    // Mix the label hash into the master via one SplitMix64 step so two
    // labels that hash close don't yield trivially-correlated streams.
    let mut s = master ^ fnv1a_64(label);
    let _ = split_mix_64(&mut s);
    DeterministicRng::new(s)
}

// ─────────────────────────────────────────────────────────────────────────
// Versioned save framing
// ─────────────────────────────────────────────────────────────────────────

/// Header burned into every save artifact so a loader can verify the
/// determinism contract before replaying.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveHeader {
    pub determinism_version: String,
    pub master_seed: u64,
}

impl SaveHeader {
    pub fn current(master_seed: u64) -> Self {
        Self {
            determinism_version: DETERMINISM_VERSION.to_string(),
            master_seed,
        }
    }
}

/// Result of a save-compat check. We never refuse a load — the spec says
/// warn-and-replay so old saves remain inspectable after a version bump.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Compat {
    Match,
    Warn(String),
}

/// Compare `header.determinism_version` against [`DETERMINISM_VERSION`].
pub fn check_save_compat(header: &SaveHeader) -> Compat {
    if header.determinism_version == DETERMINISM_VERSION {
        Compat::Match
    } else {
        Compat::Warn(format!(
            "save determinism_version {:?} != runtime {:?}; replay may diverge",
            header.determinism_version, DETERMINISM_VERSION
        ))
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Published SplitMix64 reference vector. Seed = 0 — the first ten
    /// outputs match the C reference implementation by Vigna
    /// (`http://prng.di.unimi.it/splitmix64.c`).
    #[test]
    fn split_mix_64_known_vector_seed_zero() {
        let expected: [u64; 5] = [
            0xE220_A839_7B1D_CDAF,
            0x6E78_9E6A_A1B9_65F4,
            0x06C4_5D18_8009_454F,
            0xF88B_B8A8_724C_81EC,
            0x1B39_896A_51A8_749B,
        ];
        let mut state: u64 = 0;
        for (i, want) in expected.iter().enumerate() {
            let got = split_mix_64(&mut state);
            assert_eq!(got, *want, "splitmix64 mismatch at index {i}: {got:#x} vs {want:#x}");
        }
    }

    #[test]
    fn same_seed_same_sequence() {
        let mut a = DeterministicRng::new(0xDEAD_BEEF_CAFE_F00D);
        let mut b = DeterministicRng::new(0xDEAD_BEEF_CAFE_F00D);
        for _ in 0..1024 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn different_labels_diverge() {
        let master = 42;
        let mut a = derive_substream(master, "plumes");
        let mut b = derive_substream(master, "erosion");
        // First samples must differ (probability of equality vanishingly low).
        let s_a: Vec<u64> = (0..8).map(|_| a.next_u64()).collect();
        let s_b: Vec<u64> = (0..8).map(|_| b.next_u64()).collect();
        assert_ne!(s_a, s_b);
    }

    #[test]
    fn same_label_same_substream() {
        let mut a = derive_substream(7, "erosion");
        let mut b = derive_substream(7, "erosion");
        for _ in 0..64 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn next_f64_unit_interval() {
        let mut r = DeterministicRng::new(1);
        for _ in 0..10_000 {
            let x = r.next_f64();
            assert!((0.0..1.0).contains(&x), "f64 out of [0,1): {x}");
        }
    }

    #[test]
    fn gen_range_is_within_bounds() {
        let mut r = DeterministicRng::new(99);
        for _ in 0..10_000 {
            let x = r.gen_range(-3.0..7.5);
            assert!(x >= -3.0 && x < 7.5);
        }
    }

    #[test]
    fn save_header_roundtrip_and_compat() {
        let h = SaveHeader::current(12345);
        let s = serde_json::to_string(&h).unwrap();
        let back: SaveHeader = serde_json::from_str(&s).unwrap();
        assert_eq!(back.master_seed, 12345);
        assert_eq!(check_save_compat(&back), Compat::Match);

        let stale = SaveHeader {
            determinism_version: "1999.01-prehistoric".into(),
            master_seed: 1,
        };
        match check_save_compat(&stale) {
            Compat::Warn(msg) => assert!(msg.contains("1999.01-prehistoric")),
            Compat::Match => panic!("expected Warn for stale version"),
        }
    }
}
