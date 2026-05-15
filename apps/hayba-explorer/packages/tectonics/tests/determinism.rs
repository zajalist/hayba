//! Phase 8 — determinism integration test.
//!
//! Two independently-constructed `Model`s seeded identically must produce
//! byte-identical sim state after the same number of steps.

use hayba_tectonics_v2::determinism::{
    check_save_compat, derive_substream, Compat, DeterministicRng, SaveHeader, DETERMINISM_VERSION,
};
use hayba_tectonics_v2::model::Model;

/// Cheap, allocation-free fingerprint of `Model`'s observable state. We hash
/// `bincode::serialize(&model.fields)` plus a few scalar fields so the test
/// covers field-level mutations without depending on the frame-stream
/// encoder being plumbed for arbitrary callers.
fn fingerprint(m: &Model) -> Vec<u8> {
    let mut buf = bincode::serialize(&m.fields).expect("serialize fields");
    buf.extend_from_slice(&m.step_count.to_le_bytes());
    buf.extend_from_slice(&m.sim_time_ma.to_bits().to_le_bytes());
    buf.extend_from_slice(&m.master_seed.to_le_bytes());
    // Plate count + per-plate id/density/angular velocity bits.
    buf.extend_from_slice(&(m.plates.len() as u32).to_le_bytes());
    for p in &m.plates {
        buf.extend_from_slice(&p.id.to_le_bytes());
        buf.extend_from_slice(&p.density.to_bits().to_le_bytes());
        let av = p.angular_velocity;
        buf.extend_from_slice(&av.x.to_bits().to_le_bytes());
        buf.extend_from_slice(&av.y.to_bits().to_le_bytes());
        buf.extend_from_slice(&av.z.to_bits().to_le_bytes());
    }
    buf
}

#[test]
fn two_models_same_seed_byte_identical_after_n_steps() {
    const SEED: u64 = 0xC0FFEE_BADCAFE_u64.wrapping_mul(1);
    const DIVS: u32 = 16; // small grid so the test stays cheap
    const N_STEPS: u32 = 8;

    let mut a = Model::new(DIVS, SEED);
    let mut b = Model::new(DIVS, SEED);

    for _ in 0..N_STEPS {
        a.step_default();
        b.step_default();
    }

    let fa = fingerprint(&a);
    let fb = fingerprint(&b);
    assert_eq!(
        fa, fb,
        "models with identical seeds diverged after {N_STEPS} steps \
         (lengths {} vs {})",
        fa.len(),
        fb.len()
    );
}

#[test]
fn rng_substreams_are_reproducible_across_constructions() {
    let mut r1 = derive_substream(0xABCD_EF01, "erosion");
    let mut r2 = derive_substream(0xABCD_EF01, "erosion");
    for _ in 0..256 {
        assert_eq!(r1.next_u64(), r2.next_u64());
    }
}

#[test]
fn save_header_compat_matrix() {
    let cur = SaveHeader::current(7);
    assert_eq!(check_save_compat(&cur), Compat::Match);
    assert_eq!(cur.determinism_version, DETERMINISM_VERSION);

    let stale = SaveHeader {
        determinism_version: "0000.00-old".into(),
        master_seed: 7,
    };
    matches!(check_save_compat(&stale), Compat::Warn(_));
}

#[test]
fn deterministic_rng_distinct_seeds_diverge() {
    let mut a = DeterministicRng::new(1);
    let mut b = DeterministicRng::new(2);
    assert_ne!(a.next_u64(), b.next_u64());
}
