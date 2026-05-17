//! Power Diagram (additively-weighted Voronoi) on the unit sphere.
//!
//! Replaces the equal-weight Lloyd-relaxed Voronoi for plate initialization.
//! The cell of seed `i` contains every point `p` for which
//! `|p - s_i|² - w_i` is minimum across all seeds. With non-uniform weights
//! this produces dramatically non-uniform plate areas — the bimodal Bird-2003
//! distribution real Earth exhibits.
//!
//! **Geometric properties preserved by Power Diagrams:**
//! - Cell bisectors are still great-circle arcs (just shifted)
//! - Cells are still convex (the CA in week 3 breaks convexity later)
//! - Triple junctions are still guaranteed
//!
//! **What changes vs equal-weight Voronoi:**
//! - Plate areas can span 3+ orders of magnitude (Pacific-style giants
//!   surrounded by microplates)
//! - Some seeds may be entirely *enclosed* by their neighbor's cell if their
//!   weight is much smaller — naturally producing the "swallowed microplate"
//!   topology we want
//!
//! **Initialization recipe:**
//! 1. Seed positions: Fibonacci spiral on the sphere + small per-seed jitter
//! 2. Weights: Pareto α=1.0 sampling, normalized to [0, target_max]
//! 3. Assignment: for each mesh cell, nearest seed by power-distance

use hayba_seeds::{derive_scope, MasterSeed, Scope, SeedStream};

use crate::mesh::Vec3f;

/// One seed in the Power Diagram.
#[derive(Copy, Clone, Debug)]
pub struct PowerSeed {
    pub id: u32,
    pub position: Vec3f,
    /// Additive weight. Larger weight → larger cell.
    /// Stored as f64 for now; will migrate to fixed-point in the GPU port.
    pub weight: f64,
    /// Stable RGB color derived from id, for visualization.
    pub color: [u8; 3],
}

/// Power-Diagram assignment over a mesh.
#[derive(Debug)]
pub struct PowerAssignment {
    pub seeds: Vec<PowerSeed>,
    /// `cell_plate[i]` = id of the seed owning mesh cell `i`.
    pub cell_plate: Vec<u8>,
}

pub struct PowerOptions {
    pub plate_count: u32,
    /// Pareto distribution parameter. α=1.0 gives heavy long tail.
    /// Larger α → gentler distribution.
    pub pareto_alpha: f64,
    /// How much per-seed jitter to apply on top of the Fibonacci spiral.
    /// 0.0 = pure Fibonacci, 1.0 = essentially random.
    pub jitter_strength: f64,
    /// Low-frequency 3D noise that warps the seed-position field. Breaks the
    /// regular Fibonacci-spiral lattice so the resulting Voronoi cells stop
    /// looking like a polyhedron tiling. 0.0 = disabled, ~0.3 = strong
    /// macro-distortion without scrambling neighbourhood structure.
    pub domain_warp: f64,
    /// **Boundary perturbation noise** — added directly to the power-distance
    /// score for each (cell, seed) pair, with a noise field unique to each
    /// seed. This breaks the convexity guarantee of pure Power Diagrams: a
    /// seed's territory can poke into neighbours where its noise spikes, and
    /// pull back where it dips. Produces peninsulas, embayments, and concave
    /// coastlines naturally at the assignment level (not as a post-hoc
    /// rendering filter). 0.0 = pure convex Power Diagram, ~0.25 = obvious
    /// concavity, >0.4 = chaotic islands.
    pub boundary_noise: f64,
    /// Position along the Wilson Cycle, in [0, 1]:
    /// - **0.00 = supercontinent peak** (Pangaea / Rodinia): one mega-plate
    ///   dominates >30% of the surface; everything else is a fragment.
    /// - **0.35 = early breakup**: 2-3 large rifted continents; many small
    ///   plates emerging from the breakup zones.
    /// - **0.70 = modern Earth** (Bird-2003-style): 7 majors + 15 minors +
    ///   many microplates. **Default.**
    /// - **1.00 = late dispersion / pre-reassembly**: lots of medium plates,
    ///   no clear dominant.
    /// Interpolates the four-tier weights below.
    pub era_phase: f64,
}

impl Default for PowerOptions {
    fn default() -> Self {
        Self {
            plate_count: 50,
            pareto_alpha: 1.0,
            jitter_strength: 0.15,
            domain_warp: 0.80,
            boundary_noise: 0.85,
            era_phase: 0.70,
        }
    }
}

impl PowerAssignment {
    pub fn build(master: MasterSeed, vertices: &[Vec3f], opts: PowerOptions) -> Self {
        let seeds = sample_seeds(
            master,
            opts.plate_count,
            opts.pareto_alpha,
            opts.jitter_strength,
            opts.domain_warp,
            opts.era_phase,
        );

        // Per-seed MACRO-scale "reach" noise. Each seed gets a low-frequency
        // 3D field whose value at point `p` is added to its power-distance
        // score. Where this seed's noise spikes, its territory extends; where
        // it dips, neighbours encroach. Result: peninsulas, embayments, and
        // genuinely concave coastlines from the assignment stage, not as a
        // post-hoc rendering filter.
        let noise_seed = derive_scope(master, Scope::Tectonic).wrapping_add(0xB0_15_E5);
        let mut noise_stream = SeedStream::new(noise_seed);
        let seed_noise: Vec<WarpBasis> = (0..seeds.len())
            .map(|_| make_macro_basis(&mut noise_stream))
            .collect();
        let bnoise = opts.boundary_noise;

        let cell_plate: Vec<u8> = vertices.iter().map(|p| {
            let mut best_id = 0u8;
            let mut best_score = f64::NEG_INFINITY;
            for s in &seeds {
                let n = warp_noise(&seed_noise[s.id as usize], *p);
                let score = 2.0 * p.dot(s.position) + s.weight + n * bnoise;
                if score > best_score {
                    best_score = score;
                    best_id = s.id as u8;
                }
            }
            best_id
        }).collect();

        Self { seeds, cell_plate }
    }
}

/// Generate seeds via Fibonacci spiral + per-seed jitter, with Pareto weights.
fn sample_seeds(
    master: MasterSeed,
    n: u32,
    pareto_alpha: f64,
    jitter: f64,
    domain_warp: f64,
    era_phase: f64,
) -> Vec<PowerSeed> {
    let scope_seed = derive_scope(master, Scope::Tectonic);
    let mut stream = SeedStream::new(scope_seed);
    let mut out = Vec::with_capacity(n as usize);

    // Build a domain-warp basis: three independent low-frequency 3D noise
    // fields (one per output axis). Each is a sum of a few cosines with
    // stream-derived frequencies/phases, so the resulting displacement varies
    // smoothly across the sphere and changes per master seed.
    let warp_x = make_warp_basis(&mut stream, 3);
    let warp_y = make_warp_basis(&mut stream, 3);
    let warp_z = make_warp_basis(&mut stream, 3);

    // Positions: Fibonacci spiral + per-seed jitter + low-freq domain warp.
    // The warp is what breaks the polyhedron-tile feel — Fibonacci alone
    // produces near-regular cells, jitter only adds high-freq noise.
    let positions: Vec<Vec3f> = (0..n).map(|i| {
        let base = fibonacci_sphere(i, n);
        let jx = (u64_to_unit(stream.next_u64()) * 2.0 - 1.0) * jitter;
        let jy = (u64_to_unit(stream.next_u64()) * 2.0 - 1.0) * jitter;
        let jz = (u64_to_unit(stream.next_u64()) * 2.0 - 1.0) * jitter;
        let pre = Vec3f::new(base.x + jx, base.y + jy, base.z + jz);
        let wx = warp_noise(&warp_x, pre) * domain_warp;
        let wy = warp_noise(&warp_y, pre) * domain_warp;
        let wz = warp_noise(&warp_z, pre) * domain_warp;
        Vec3f::new(pre.x + wx, pre.y + wy, pre.z + wz).normalize()
    }).collect();

    // **Bird-2003-style tiered weights.** Pareto-sampled weights (used
    // earlier) clustered too heavily around the median, producing one giant
    // plate and many same-sized neighbors. Instead we explicitly construct
    // three population tiers — major / minor / micro — sized proportional to
    // Bird's 7 / 15 / 30 split. Within each tier we apply small Pareto noise
    // so the tiers aren't perfectly uniform inside, but the macro-distribution
    // is sharply tiered: a few giants, more medium, many small.
    //
    // The weight DIFFERENCE between tiers drives area difference (a Power
    // Diagram bisector between seeds shifts proportional to weight delta).
    // With unit-sphere seed spacing ~0.5, weight delta of ~0.6 makes the
    // bisector move ~60% of the way toward the smaller seed.
    // **Wilson Cycle phase shapes the population.** Four reference eras with
    // piecewise-linear interpolation between them in `era_phase`. We pre-compute
    // (dominant_w, major_w, minor_w, micro_w, n_major_frac, n_minor_frac) at
    // each keyframe and lerp.
    let phase = era_phase.clamp(0.0, 1.0);
    // Keyframes (phase, dominant_w, major_w, minor_w, micro_w, n_major_frac, n_minor_frac):
    let keyframes: [(f64, f64, f64, f64, f64, f64, f64); 4] = [
        // 0.00 supercontinent: 1 mega + 0 majors + 5 minors + rest micros
        (0.00, 1.50, 0.30, 0.0, -0.25, 0.00, 0.10),
        // 0.35 early breakup: 1 dominant + 3 majors + 10 minors + rest micros
        (0.35, 0.70, 0.30, 0.0, -0.20, 0.06, 0.20),
        // 0.70 modern Earth (default): 1 dominant + 6 majors + 15 minors + rest micros
        // Weights pushed harder than v1 — Pacific-scale 20-25% giant.
        (0.70, 0.90, 0.32, 0.0, -0.20, 0.12, 0.30),
        // 1.00 late dispersion: 0 dominant + 6 medium + 18 minors + rest micros
        (1.00, 0.45, 0.32, 0.0, -0.15, 0.12, 0.36),
    ];
    let (a, b) = {
        let mut i = 0;
        while i + 1 < keyframes.len() && phase > keyframes[i + 1].0 { i += 1; }
        (keyframes[i], keyframes[(i + 1).min(keyframes.len() - 1)])
    };
    let t = if b.0 > a.0 { ((phase - a.0) / (b.0 - a.0)).clamp(0.0, 1.0) } else { 0.0 };
    let lerp = |x: f64, y: f64| x * (1.0 - t) + y * t;
    let dominant_w = lerp(a.1, b.1);
    let major_w = lerp(a.2, b.2);
    let minor_w = lerp(a.3, b.3);
    let micro_w = lerp(a.4, b.4);
    let n_major_frac = lerp(a.5, b.5);
    let n_minor_frac = lerp(a.6, b.6);

    let n_dominant: u32 = if phase < 0.95 { 1 } else { 0 };
    let n_major = ((n as f64 * n_major_frac).round() as u32).min(n.saturating_sub(n_dominant));
    let n_minor = ((n as f64 * n_minor_frac).round() as u32)
        .min(n.saturating_sub(n_dominant).saturating_sub(n_major));
    let _n_micro = n - n_dominant - n_major - n_minor;

    // Shuffle tier assignment deterministically so the major plates aren't
    // spatially adjacent on the Fibonacci spiral. Without shuffling, the
    // first 7 indices of the spiral would all become majors and cluster at
    // one pole. With shuffling, majors spread out.
    let mut order: Vec<u32> = (0..n).collect();
    fisher_yates(&mut order, &mut stream);

    let mut weights = vec![0.0_f64; n as usize];
    for (rank, &plate_idx) in order.iter().enumerate() {
        let rank = rank as u32;
        let base_w = if rank < n_dominant { dominant_w }
                     else if rank < n_dominant + n_major { major_w }
                     else if rank < n_dominant + n_major + n_minor { minor_w }
                     else { micro_w };
        // Small Pareto noise within tier so all members of a tier aren't
        // exactly the same weight (gives natural variation among majors).
        // The dominant gets no noise — we want one clearly biggest plate.
        let noise = if rank < n_dominant { 0.0 } else {
            let u = u64_to_unit(stream.next_u64());
            let denom = (1.0 - u).max(1e-9);
            (denom.powf(-1.0 / (pareto_alpha + 2.0)) - 1.0) * 0.05
        };
        weights[plate_idx as usize] = base_w + noise;
    }

    for (id, (pos, w)) in positions.iter().zip(weights.iter()).enumerate() {
        let hue = (id as f64) * 137.508_f64 % 360.0;
        out.push(PowerSeed {
            id: id as u32,
            position: *pos,
            weight: *w,
            color: hsv_to_rgb(hue, 0.65, 0.92),
        });
    }
    out
}

/// Fibonacci spiral on the unit sphere — N near-uniformly distributed points.
/// Deterministic, mesh-independent, no clustering bias.
fn fibonacci_sphere(i: u32, n: u32) -> Vec3f {
    let golden_angle = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
    let theta = golden_angle * i as f64;
    let z = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
    let r = (1.0 - z * z).max(0.0).sqrt();
    Vec3f::new(r * theta.cos(), r * theta.sin(), z)
}

fn fisher_yates(items: &mut [u32], stream: &mut SeedStream) {
    // Deterministic Fisher-Yates shuffle.
    for i in (1..items.len()).rev() {
        let j = stream.next_below((i + 1) as u64) as usize;
        items.swap(i, j);
    }
}

/// Low-frequency 3D scalar noise: sum of cosines `amp_k * cos(f_k · p + phase_k)`,
/// normalized to ~[-1, 1]. Deterministic in the seed stream.
struct WarpBasis {
    octaves: Vec<(Vec3f, f64, f64)>,
    norm: f64,
}

fn make_warp_basis(stream: &mut SeedStream, n_octaves: usize) -> WarpBasis {
    let mut octaves = Vec::with_capacity(n_octaves);
    let mut total_amp = 0.0;
    for k in 0..n_octaves {
        // Frequencies in [-freq_scale, freq_scale]. Low-octave = 1.5 cycles
        // per sphere diameter; higher octaves up to ~4.5. That keeps the warp
        // macro-scale (a few large bulges) rather than tile-scale noise.
        let freq_scale = 1.5 + k as f64 * 1.5;
        let fx = (u64_to_unit(stream.next_u64()) * 2.0 - 1.0) * freq_scale;
        let fy = (u64_to_unit(stream.next_u64()) * 2.0 - 1.0) * freq_scale;
        let fz = (u64_to_unit(stream.next_u64()) * 2.0 - 1.0) * freq_scale;
        let phase = u64_to_unit(stream.next_u64()) * std::f64::consts::TAU;
        let amp = 1.0 / (k as f64 + 1.0);
        total_amp += amp;
        octaves.push((Vec3f::new(fx, fy, fz), phase, amp));
    }
    WarpBasis { octaves, norm: total_amp.max(1e-9) }
}

/// Macro-scale basis for per-seed boundary noise. Two octaves at very low
/// frequency (0.5 + 1.1 cycles per sphere diameter) — features span large
/// fractions of a hemisphere, producing continent-scale concavity rather
/// than coastal wiggle.
fn make_macro_basis(stream: &mut SeedStream) -> WarpBasis {
    let mut octaves = Vec::with_capacity(3);
    let mut total_amp = 0.0;
    // 3 octaves: macro bulge (2.5 cycles), meso modulation (5), and coastline
    // detail (9). Amplitudes decay so the macro shape dominates.
    // Macro shape dominated by low-frequency octave with big amplitude — this
    // creates large angular bulges/indents at plate scale rather than gentle
    // curves. Higher octaves add modulation, not bulk shape.
    let specs = [(1.5_f64, 1.6_f64), (3.5, 0.7), (7.0, 0.35)];
    for &(freq_scale, amp) in specs.iter() {
        let fx = (u64_to_unit(stream.next_u64()) * 2.0 - 1.0) * freq_scale;
        let fy = (u64_to_unit(stream.next_u64()) * 2.0 - 1.0) * freq_scale;
        let fz = (u64_to_unit(stream.next_u64()) * 2.0 - 1.0) * freq_scale;
        let phase = u64_to_unit(stream.next_u64()) * std::f64::consts::TAU;
        total_amp += amp;
        octaves.push((Vec3f::new(fx, fy, fz), phase, amp));
    }
    WarpBasis { octaves, norm: total_amp.max(1e-9) }
}

fn warp_noise(b: &WarpBasis, p: Vec3f) -> f64 {
    let mut s = 0.0;
    for (f, phase, amp) in &b.octaves {
        s += amp * (f.dot(p) + phase).cos();
    }
    s / b.norm
}

fn u64_to_unit(x: u64) -> f64 {
    (x >> 11) as f64 / (1u64 << 53) as f64
}

fn hsv_to_rgb(h: f64, s: f64, v: f64) -> [u8; 3] {
    let c = v * s;
    let hp = h / 60.0;
    let x = c * (1.0 - (hp.rem_euclid(2.0) - 1.0).abs());
    let (r1, g1, b1) = match hp as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    [
        ((r1 + m) * 255.0) as u8,
        ((g1 + m) * 255.0) as u8,
        ((b1 + m) * 255.0) as u8,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Icosphere;

    #[test]
    fn fibonacci_spiral_covers_sphere() {
        // 100 points should span both hemispheres roughly evenly.
        let mut n_north = 0;
        let mut n_south = 0;
        for i in 0..100 {
            let p = fibonacci_sphere(i, 100);
            if p.z > 0.0 { n_north += 1; } else { n_south += 1; }
        }
        assert!((n_north as i32 - n_south as i32).abs() <= 2);
    }

    #[test]
    fn fibonacci_points_on_unit_sphere() {
        for i in 0..50 {
            let p = fibonacci_sphere(i, 50);
            let len = (p.x * p.x + p.y * p.y + p.z * p.z).sqrt();
            assert!((len - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn assignment_covers_every_cell() {
        let sphere = Icosphere::new(5);
        let a = PowerAssignment::build(
            MasterSeed(42), &sphere.vertices, PowerOptions::default(),
        );
        assert_eq!(a.cell_plate.len(), sphere.vertices.len());
        for &p in &a.cell_plate {
            assert!((p as usize) < a.seeds.len());
        }
    }

    #[test]
    fn deterministic_assignment() {
        let sphere = Icosphere::new(4);
        let a = PowerAssignment::build(
            MasterSeed(42), &sphere.vertices, PowerOptions::default(),
        );
        let b = PowerAssignment::build(
            MasterSeed(42), &sphere.vertices, PowerOptions::default(),
        );
        assert_eq!(a.cell_plate, b.cell_plate);
        for (s1, s2) in a.seeds.iter().zip(b.seeds.iter()) {
            assert_eq!(s1.weight, s2.weight);
        }
    }

    #[test]
    fn pareto_produces_non_uniform_areas() {
        // With Pareto weights at α=1.0, the largest plate should be at least
        // 5× the median plate. With equal weights this ratio would be ~1.0.
        let sphere = Icosphere::new(5);
        let a = PowerAssignment::build(
            MasterSeed(42), &sphere.vertices, PowerOptions::default(),
        );

        let mut counts = vec![0u32; a.seeds.len()];
        for &p in &a.cell_plate { counts[p as usize] += 1; }
        counts.sort_unstable_by(|x, y| y.cmp(x));

        let max = counts[0];
        let median = counts[counts.len() / 2];
        let ratio = max as f64 / median.max(1) as f64;
        assert!(ratio >= 5.0, "expected max/median >= 5, got {} ({}/{})", ratio, max, median);
    }

    #[test]
    fn at_least_one_plate_is_pacific_scale() {
        // The largest plate should cover at least 10% of the sphere area
        // when Pareto weights are applied. (Pacific is ~20% on Earth; with
        // randomized weights we accept ≥10%.)
        let sphere = Icosphere::new(5);
        let a = PowerAssignment::build(
            MasterSeed(42), &sphere.vertices, PowerOptions::default(),
        );
        let mut counts = vec![0u32; a.seeds.len()];
        for &p in &a.cell_plate { counts[p as usize] += 1; }
        let max = *counts.iter().max().unwrap();
        let total: u32 = counts.iter().sum();
        let fraction = max as f64 / total as f64;
        assert!(fraction >= 0.10, "largest plate covers only {:.1}% of sphere", fraction * 100.0);
    }
}
