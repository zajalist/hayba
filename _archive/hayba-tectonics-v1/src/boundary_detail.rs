//! Inject organic detail onto analytical Voronoi arcs.
//!
//! Pure spherical Voronoi gives perfectly smooth great-circle arcs — which
//! is mathematically correct but visually wrong: real plate boundaries
//! have fractal-like irregularity, with bends, transform-fault offsets,
//! and small-scale roughness driven by crustal heterogeneity.
//!
//! Strategy: keep the analytical arc as the **trend** (it sets where the
//! boundary lies and where the triple junctions are), then displace the
//! interior arc points laterally (in the tangent plane) by deterministic
//! multi-octave value noise. Endpoints stay fixed — triple junctions are
//! geophysical invariants, not artistic choices.
//!
//! Amplitude and frequency vary by boundary kind. Divergent boundaries get
//! the most segmented appearance (mimicking ridge-transform offsets);
//! transform faults stay closest to straight; convergent and oblique sit
//! in between.

use hayba_seeds::{derive_scope, MasterSeed, Scope, SeedStream};

use crate::boundaries::{BoundaryClassification, BoundaryKind};
use crate::mesh::Vec3f;
use crate::voronoi::{sample_great_circle_arc, SphericalVoronoi};

/// Noise control points per octave (more = higher frequency detail).
const BASE_CONTROL_POINTS: u32 = 6;
/// How many octaves to stack. Each doubles the frequency and halves the amplitude.
const OCTAVES: u32 = 3;

/// Per-kind amplitude (how far the boundary can deviate from the great-circle arc).
/// On a unit sphere; values are tangent-space displacements at peak.
fn amplitude_for(kind: BoundaryKind) -> f64 {
    match kind {
        BoundaryKind::Divergent  => 0.045,  // segmented ridges
        BoundaryKind::Convergent => 0.035,  // broad bends along subduction arcs
        BoundaryKind::Transform  => 0.012,  // nearly straight
        BoundaryKind::Oblique    => 0.030,
    }
}

/// Per-kind frequency multiplier (higher = more wiggle along the arc).
fn frequency_multiplier(kind: BoundaryKind) -> f64 {
    match kind {
        BoundaryKind::Divergent  => 1.7,
        BoundaryKind::Convergent => 0.9,
        BoundaryKind::Transform  => 0.6,
        BoundaryKind::Oblique    => 1.1,
    }
}

/// Resample each Voronoi arc with `samples` points, displaced by structured
/// noise in the tangent plane. Mutates `voronoi.edges[*].arc` in place.
pub fn perturb_arcs(
    voronoi: &mut SphericalVoronoi,
    classification: &BoundaryClassification,
    master: MasterSeed,
    samples: u32,
) {
    let base_seed = derive_scope(master, Scope::Tectonic).wrapping_add(0xB0_5A_DA_F1);

    for (idx, edge) in voronoi.edges.iter_mut().enumerate() {
        let kind = classification.kinds[idx];
        let amp = amplitude_for(kind);
        let freq_mult = frequency_multiplier(kind);

        // Fresh analytical arc with the requested sample count — overrides
        // the build-time sample count so we have enough resolution to
        // express the displacement smoothly.
        let arc = sample_great_circle_arc(edge.start, edge.end, samples);

        // Per-edge deterministic noise stream.
        let edge_seed = base_seed.wrapping_add(
            (idx as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15),
        );

        let n = arc.len();
        let mut perturbed = Vec::with_capacity(n);
        perturbed.push(arc[0]);

        for i in 1..n - 1 {
            let p = arc[i];
            let p_prev = arc[i - 1];
            let p_next = arc[i + 1];

            // Tangent along arc, projected onto sphere tangent plane at p.
            let raw_t = Vec3f::new(
                p_next.x - p_prev.x,
                p_next.y - p_prev.y,
                p_next.z - p_prev.z,
            );
            let t_dot_p = raw_t.x * p.x + raw_t.y * p.y + raw_t.z * p.z;
            let tangent = Vec3f::new(
                raw_t.x - t_dot_p * p.x,
                raw_t.y - t_dot_p * p.y,
                raw_t.z - t_dot_p * p.z,
            ).normalize();

            // Lateral normal: p × tangent, on the sphere. Sign is arbitrary
            // (noise produces ± values either way) so we just take it.
            let lateral = Vec3f::new(
                p.y * tangent.z - p.z * tangent.y,
                p.z * tangent.x - p.x * tangent.z,
                p.x * tangent.y - p.y * tangent.x,
            );

            let s = i as f64 / (n - 1) as f64;
            // Hann window — zero at endpoints so triple junctions stay put.
            let window = (std::f64::consts::PI * s).sin().powi(2);
            let noise = fractal_value_noise(edge_seed, s * freq_mult);

            let displacement = amp * window * noise;
            let new_p = Vec3f::new(
                p.x + lateral.x * displacement,
                p.y + lateral.y * displacement,
                p.z + lateral.z * displacement,
            ).normalize();
            perturbed.push(new_p);
        }
        perturbed.push(arc[n - 1]);

        edge.arc = perturbed;
    }
}

/// 1D fractal value noise — sum of `OCTAVES` smoothstep-interpolated random
/// fields, each at higher frequency and lower amplitude. Deterministic given
/// the seed and the input parameter.
fn fractal_value_noise(seed: u64, x: f64) -> f64 {
    let mut total = 0.0;
    let mut amp = 1.0;
    let mut freq = 1.0;
    let mut norm = 0.0;
    for o in 0..OCTAVES {
        let octave_seed = seed.wrapping_add(
            (o as u64).wrapping_mul(0xDEAD_BEEF_CAFE_BABE),
        );
        let n_control = BASE_CONTROL_POINTS << o;  // doubles each octave
        total += amp * value_noise_1d(octave_seed, x * freq, n_control);
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    total / norm
}

/// Single-octave 1D value noise: pick `n_control` random values in [-1, 1]
/// from the seed, then smoothstep-interpolate at input `x` (treated mod 1).
fn value_noise_1d(seed: u64, x: f64, n_control: u32) -> f64 {
    let mut stream = SeedStream::new(seed);
    let mut control = Vec::with_capacity(n_control as usize + 1);
    for _ in 0..=n_control {
        let r = stream.next_u64();
        control.push((r as f64 / u64::MAX as f64) * 2.0 - 1.0);
    }
    // Wrap x into [0, n_control) so noise is periodic but the arc covers
    // at most one period.
    let scaled = x.rem_euclid(1.0) * n_control as f64;
    let i = scaled.floor() as usize;
    let frac = scaled - i as f64;
    let a = control[i];
    let b = control[i + 1];
    // smoothstep blend
    let t = frac * frac * (3.0 - 2.0 * frac);
    a * (1.0 - t) + b * t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boundaries::classify_voronoi_edges;
    use crate::mesh::Icosphere;
    use crate::motion::sample_plate_motions;
    use crate::plates::{BuildOptions, PlateAssignment};

    #[test]
    fn endpoints_preserved_after_perturbation() {
        let sphere = Icosphere::new(3);
        let plates = PlateAssignment::build(
            MasterSeed(42), &sphere,
            BuildOptions { plate_count: 12, ..BuildOptions::default() },
        );
        let motions = sample_plate_motions(MasterSeed(42), 12);
        let seeds: Vec<Vec3f> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
        let mut voronoi = SphericalVoronoi::build(&seeds, 24);
        let cls = classify_voronoi_edges(&voronoi, &plates, &motions);

        let originals: Vec<(Vec3f, Vec3f)> =
            voronoi.edges.iter().map(|e| (e.start, e.end)).collect();
        perturb_arcs(&mut voronoi, &cls, MasterSeed(42), 48);

        for (edge, (s, e)) in voronoi.edges.iter().zip(originals.iter()) {
            // First arc point should equal stored start; last == end.
            let first = edge.arc[0];
            let last = edge.arc[edge.arc.len() - 1];
            assert!((first.x - s.x).abs() < 1e-9, "start drifted");
            assert!((first.y - s.y).abs() < 1e-9, "start drifted");
            assert!((first.z - s.z).abs() < 1e-9, "start drifted");
            assert!((last.x - e.x).abs() < 1e-9, "end drifted");
            assert!((last.y - e.y).abs() < 1e-9, "end drifted");
            assert!((last.z - e.z).abs() < 1e-9, "end drifted");
        }
    }

    #[test]
    fn all_perturbed_points_on_unit_sphere() {
        let sphere = Icosphere::new(3);
        let plates = PlateAssignment::build(
            MasterSeed(42), &sphere,
            BuildOptions { plate_count: 12, ..BuildOptions::default() },
        );
        let motions = sample_plate_motions(MasterSeed(42), 12);
        let seeds: Vec<Vec3f> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
        let mut voronoi = SphericalVoronoi::build(&seeds, 24);
        let cls = classify_voronoi_edges(&voronoi, &plates, &motions);
        perturb_arcs(&mut voronoi, &cls, MasterSeed(42), 48);

        for edge in &voronoi.edges {
            for p in &edge.arc {
                let r = (p.x * p.x + p.y * p.y + p.z * p.z).sqrt();
                assert!((r - 1.0).abs() < 1e-9, "off-sphere: {}", r);
            }
        }
    }

    #[test]
    fn perturbation_is_deterministic() {
        let sphere = Icosphere::new(3);
        let plates = PlateAssignment::build(
            MasterSeed(42), &sphere,
            BuildOptions { plate_count: 12, ..BuildOptions::default() },
        );
        let motions = sample_plate_motions(MasterSeed(42), 12);
        let seeds: Vec<Vec3f> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
        let mut a = SphericalVoronoi::build(&seeds, 24);
        let mut b = SphericalVoronoi::build(&seeds, 24);
        let cls = classify_voronoi_edges(&a, &plates, &motions);
        perturb_arcs(&mut a, &cls, MasterSeed(42), 48);
        perturb_arcs(&mut b, &cls, MasterSeed(42), 48);
        for (e1, e2) in a.edges.iter().zip(b.edges.iter()) {
            for (p1, p2) in e1.arc.iter().zip(e2.arc.iter()) {
                assert_eq!(p1.x, p2.x);
                assert_eq!(p1.y, p2.y);
                assert_eq!(p1.z, p2.z);
            }
        }
    }
}
