//! Deterministic fBm-noise initial elevation field.
//!
//! At t=0 (before any CA evolution), we want the planet to *look* like a
//! planet — not a flat sphere of uniform composition baselines. This module
//! seeds each cell's elevation with a composition-specific baseline plus a
//! deterministic fBm noise displacement derived from the cell's unit-sphere
//! position and the master seed.
//!
//! The CA in [`crate::ca_evolution`] then evolves this baseline toward its
//! composition-driven targets (trenches, ridges, orogenies) over the run.
//!
//! ## Determinism
//!
//! Same `master_seed` + same `p_unit` → bit-exact same elevation. The hash
//! is a SplitMix64-style avalanche over the lattice integer coordinates and
//! the seed; no `HashMap`, no float noise tables.

use crate::crust_state::Composition;
use crate::mesh::Vec3f;

/// SplitMix64 finalizer — fast, well-distributed avalanche of a u64.
#[inline]
fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Hash four integers (seed + 3D lattice coords) into a u64.
#[inline]
fn hash4(seed: u64, x: i32, y: i32, z: i32) -> u64 {
    let mut h = seed;
    h = splitmix64(h ^ (x as i64 as u64).wrapping_mul(0xA245_8AA0_F4E1_1B3D));
    h = splitmix64(h ^ (y as i64 as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F));
    h = splitmix64(h ^ (z as i64 as u64).wrapping_mul(0x1656_67B1_9E37_79F9));
    splitmix64(h)
}

/// Hashed value-noise sample at integer lattice point, in [-1, 1].
#[inline]
fn lattice_value(seed: u64, x: i32, y: i32, z: i32) -> f32 {
    let h = hash4(seed, x, y, z);
    // Map top 24 bits to [0, 1), then to [-1, 1].
    let u = (h >> 40) as f32 / ((1u32 << 24) as f32);
    u * 2.0 - 1.0
}

/// Smoothstep for trilinear interpolation — gives the noise C¹ continuity
/// at lattice cell boundaries (helps remove the value-noise grid pattern).
#[inline]
fn smoothstep(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// 3D value noise at a real-valued point, in [-1, 1].
fn value_noise3(p: Vec3f, seed: u64) -> f32 {
    let x = p.x as f32;
    let y = p.y as f32;
    let z = p.z as f32;
    let xi = x.floor() as i32;
    let yi = y.floor() as i32;
    let zi = z.floor() as i32;
    let xf = x - xi as f32;
    let yf = y - yi as f32;
    let zf = z - zi as f32;
    let u = smoothstep(xf);
    let v = smoothstep(yf);
    let w = smoothstep(zf);

    let c000 = lattice_value(seed, xi,     yi,     zi);
    let c100 = lattice_value(seed, xi + 1, yi,     zi);
    let c010 = lattice_value(seed, xi,     yi + 1, zi);
    let c110 = lattice_value(seed, xi + 1, yi + 1, zi);
    let c001 = lattice_value(seed, xi,     yi,     zi + 1);
    let c101 = lattice_value(seed, xi + 1, yi,     zi + 1);
    let c011 = lattice_value(seed, xi,     yi + 1, zi + 1);
    let c111 = lattice_value(seed, xi + 1, yi + 1, zi + 1);

    let x00 = c000 + (c100 - c000) * u;
    let x10 = c010 + (c110 - c010) * u;
    let x01 = c001 + (c101 - c001) * u;
    let x11 = c011 + (c111 - c011) * u;
    let y0 = x00 + (x10 - x00) * v;
    let y1 = x01 + (x11 - x01) * v;
    y0 + (y1 - y0) * w
}

/// Fractional Brownian motion over 3D value noise, output approximately
/// in [-1, 1] (clamped). `freq` is the starting frequency, scaled up by
/// `lacunarity` each octave, with amplitude scaled down by `gain`.
pub fn fbm3_unit(p: Vec3f, seed: u64, octaves: u32, lacunarity: f32, gain: f32, freq: f32) -> f32 {
    let mut amp = 1.0_f32;
    let mut f = freq;
    let mut sum = 0.0_f32;
    let mut norm = 0.0_f32;
    for o in 0..octaves {
        // Each octave uses its own derived seed so they don't share the same
        // lattice phase (otherwise low-freq pattern leaks into high-freq).
        let octave_seed = splitmix64(seed ^ ((o as u64).wrapping_mul(0x9E37_79B1_85EB_CA87)));
        let pp = Vec3f::new(p.x * f as f64, p.y * f as f64, p.z * f as f64);
        sum += amp * value_noise3(pp, octave_seed);
        norm += amp;
        amp *= gain;
        f *= lacunarity;
    }
    (sum / norm.max(1e-9)).clamp(-1.0, 1.0)
}

/// Composition-specific baseline elevation (m).
#[inline]
fn baseline_for_composition(comp: Composition) -> f32 {
    match comp {
        Composition::Oceanic     => -4500.0,
        Composition::Island      =>     0.0,
        Composition::Continental =>   400.0,
    }
}

/// Composition-specific noise amplitude (m) — peak swing on top of baseline.
#[inline]
fn noise_amp_for_composition(comp: Composition) -> f32 {
    match comp {
        Composition::Oceanic     => 400.0,
        Composition::Island      => 200.0,
        Composition::Continental => 800.0,
    }
}

/// Pre-tectonic clamp range (m) — keeps initial elevations conservative so
/// the CA has headroom to grow trenches and orogenies on top.
#[inline]
fn clamp_for_composition(comp: Composition) -> (f32, f32) {
    match comp {
        Composition::Oceanic     => (-6000.0, -2500.0),
        Composition::Island      => ( -300.0,   600.0),
        Composition::Continental => ( -200.0,  2200.0),
    }
}

/// Initial elevation in metres for one cell, given its unit-sphere position,
/// composition, and the master seed. Deterministic.
pub fn initial_elevation_m(p_unit: Vec3f, comp: Composition, master_seed: u64) -> i16 {
    let base = baseline_for_composition(comp);
    let amp  = noise_amp_for_composition(comp);
    let n = fbm3_unit(p_unit, master_seed, 4, 2.0, 0.5, 2.5);
    let raw = base + amp * n;
    let (lo, hi) = clamp_for_composition(comp);
    raw.clamp(lo, hi) as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fbm_is_deterministic() {
        let p = Vec3f::new(0.3, 0.4, 0.5).normalize();
        let a = fbm3_unit(p, 12345, 4, 2.0, 0.5, 2.5);
        let b = fbm3_unit(p, 12345, 4, 2.0, 0.5, 2.5);
        assert_eq!(a.to_bits(), b.to_bits());
    }

    #[test]
    fn fbm_in_range() {
        let mut max_abs = 0.0_f32;
        for i in 0..200 {
            let t = i as f64 * 0.1;
            let p = Vec3f::new(t.sin(), t.cos(), (t * 1.7).sin()).normalize();
            let n = fbm3_unit(p, 42, 4, 2.0, 0.5, 2.5);
            assert!(n.abs() <= 1.0 + 1e-5, "fbm out of [-1,1]: {}", n);
            max_abs = max_abs.max(n.abs());
        }
        // Should actually exercise the range somewhat (non-trivial noise).
        assert!(max_abs > 0.1, "fbm output is suspiciously flat: max_abs={}", max_abs);
    }

    #[test]
    fn fbm_varies_across_positions() {
        let p1 = Vec3f::new(1.0, 0.0, 0.0);
        let p2 = Vec3f::new(0.0, 1.0, 0.0);
        let p3 = Vec3f::new(0.0, 0.0, 1.0);
        let a = fbm3_unit(p1, 7, 4, 2.0, 0.5, 2.5);
        let b = fbm3_unit(p2, 7, 4, 2.0, 0.5, 2.5);
        let c = fbm3_unit(p3, 7, 4, 2.0, 0.5, 2.5);
        assert!((a - b).abs() > 1e-3, "fbm at p1 and p2 are suspiciously equal");
        assert!((b - c).abs() > 1e-3, "fbm at p2 and p3 are suspiciously equal");
    }

    #[test]
    fn initial_elevation_respects_clamps() {
        for seed in [1u64, 42, 12345, 999_999] {
            for i in 0..500 {
                let t = i as f64 * 0.013;
                let p = Vec3f::new(t.sin(), (t * 1.3).cos(), (t * 0.7).sin()).normalize();
                for comp in [Composition::Oceanic, Composition::Island, Composition::Continental] {
                    let e = initial_elevation_m(p, comp, seed) as f32;
                    let (lo, hi) = clamp_for_composition(comp);
                    assert!(e >= lo - 0.5 && e <= hi + 0.5,
                        "elev {} out of clamp [{}, {}] for comp {:?}", e, lo, hi, comp);
                }
            }
        }
    }

    #[test]
    fn baselines_match_table() {
        // Sanity: continental > island > oceanic baseline ordering.
        assert!(baseline_for_composition(Composition::Continental)
              > baseline_for_composition(Composition::Island));
        assert!(baseline_for_composition(Composition::Island)
              > baseline_for_composition(Composition::Oceanic));
    }
}
