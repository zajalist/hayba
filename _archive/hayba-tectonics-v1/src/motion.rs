//! Plate motion as angular velocity vectors.
//!
//! Each plate has an Euler pole — an axis through the planet center about
//! which the plate rotates rigidly. The angular velocity vector `ω` (the
//! axis scaled by the rate in rad/Myr) entirely defines the plate's motion.
//! Velocity of any point `p` on that plate's surface is `v = ω × p`.
//!
//! This first pass picks Euler poles **stochastically from the seed**. The
//! real slab-pull-driven motion (issue P12 full scope) comes once we have
//! crust age + subduction-zone identification. The visualization and
//! boundary-classification logic are identical either way, so we wire them
//! up now and swap the velocity source later.

use hayba_seeds::{derive_scope, MasterSeed, Scope, SeedStream};

use crate::adjacency::Adjacency;
use crate::crust_state::CrustState;
use crate::mesh::Vec3f;
use crate::plates::PlateAssignment;

#[derive(Copy, Clone, Debug)]
pub struct PlateMotion {
    /// Angular velocity vector — axis × rate (rad/Myr).
    pub omega: Vec3f,
}

impl PlateMotion {
    /// Linear velocity at a point on the planet surface.
    #[inline]
    pub fn velocity_at(&self, p: Vec3f) -> Vec3f {
        Vec3f::new(
            self.omega.y * p.z - self.omega.z * p.y,
            self.omega.z * p.x - self.omega.x * p.z,
            self.omega.x * p.y - self.omega.y * p.x,
        )
    }
}

/// Generate one angular velocity per plate, deterministically from the seed.
/// Rates are randomized within the typical real-Earth range (1-15 cm/yr at
/// equatorial distances, ≈ 0.0001 to 0.0015 rad/Myr).
pub fn sample_plate_motions(master: MasterSeed, plate_count: u32) -> Vec<Option<PlateMotion>> {
    // Use a distinct scope so plate motion seeds don't collide with plate
    // assignment seeds — different runs of the assignment with the same
    // master will share the same motions, which is what we want.
    //
    // Returns an Option-wrapped vector mirroring the plate registry shape
    // (INV-4). At init time every slot is `Some`; retiring a plate later
    // sets its motion slot to `None` in lockstep.
    let motion_seed = derive_scope(master, Scope::Tectonic).wrapping_add(0xDEADBEEF);
    let mut stream = SeedStream::new(motion_seed);

    let mut out = Vec::with_capacity(plate_count as usize);
    for _ in 0..plate_count {
        // Axis: uniform on the sphere.
        let z = u64_to_unit(stream.next_u64()) * 2.0 - 1.0;
        let theta = u64_to_unit(stream.next_u64()) * std::f64::consts::TAU;
        let r = (1.0 - z * z).max(0.0).sqrt();
        let axis = Vec3f::new(r * theta.cos(), r * theta.sin(), z);

        // Rate: heavy-tailed Pareto. Most plates are slow (≈1-3 cm/yr);
        // a few are dramatically fast (15+ cm/yr → Indian-plate-style
        // indenters). The asymmetry creates real macro-organic boundary
        // patterns — fast plates carve into slow ones, producing peninsulas
        // and embayments.
        let u = u64_to_unit(stream.next_u64()).clamp(0.001, 0.999);
        // Pareto inverse-CDF with α=2.0: median ≈ 1.4x base, 95th ≈ 4.5x,
        // max occasional 10x+. Base rate 0.00008 rad/Myr.
        let pareto_factor = (1.0 / (1.0 - u)).powf(1.0 / 2.0);
        let rate = 0.00008_f64 * pareto_factor.min(35.0);

        let omega = Vec3f::new(axis.x * rate, axis.y * rate, axis.z * rate);
        out.push(Some(PlateMotion { omega }));
    }
    out
}

fn u64_to_unit(x: u64) -> f64 {
    (x >> 11) as f64 / (1u64 << 53) as f64
}

// ───────────────────────────────────────────────────────────────────────
// M0.7 — Motion evolution: slab pull + drag + stability clamps.
// ───────────────────────────────────────────────────────────────────────

/// Tuning constants for per-step torque integration. Defaults are calibrated
/// so a "typical" plate sees ~1% velocity change per macro-step under slab
/// pull (no explosion, no collapse to zero).
#[derive(Copy, Clone, Debug)]
pub struct MotionEvolutionOptions {
    /// Slab-pull torque coefficient. Multiplies (age_ma × boundary_normal)
    /// per convergent boundary cell. Tiny — full sim integration would
    /// otherwise saturate the velocity clamp in a few steps.
    pub k_slab: f64,
    /// Drag torque coefficient. Multiplies (-ω × plate_area_cells). Just
    /// enough to keep ω bounded in the absence of slab forcing.
    pub k_drag: f64,
    /// Max plate angular speed (rad/Myr). ω_max ≈ 0.002 corresponds to
    /// roughly 25 cm/yr surface velocity, slightly above Earth's fastest.
    pub omega_max: f64,
    /// Per-step change cap on |Δω|. Set to `omega_max / 50` so a plate
    /// needs at least 50 macro-steps to reach top speed.
    pub d_omega_max: f64,
    /// Rolling-average window for torque smoothing, in macro-steps.
    /// Damps single-step CA spikes that would otherwise jolt motion.
    pub torque_window: usize,
}

impl Default for MotionEvolutionOptions {
    fn default() -> Self {
        let omega_max = 0.002;
        Self {
            k_slab: 1.0e-9,
            k_drag: 1.0e-3,
            omega_max,
            d_omega_max: omega_max / 50.0,
            torque_window: 4,
        }
    }
}

/// Rolling-window torque history per plate. Index 0 = oldest sample. New
/// samples are pushed at the back; entries beyond `window` are dropped.
/// Kept as a single flat Vec keyed by `plate_id * window + slot` so we
/// don't need a HashMap inside the integration hot loop.
#[derive(Clone, Debug, Default)]
pub struct MotionHistory {
    /// Flat [plate * window + slot] storage. `Vec3f::default()` is zero.
    pub torque_samples: Vec<Vec3f>,
    /// Per-plate ring-buffer write head (mod window).
    pub heads: Vec<u8>,
    /// Per-plate count of valid samples (0..=window). Once a plate has
    /// `window` samples its rolling average uses the whole window.
    pub fill: Vec<u8>,
    pub window: usize,
}

impl MotionHistory {
    pub fn new(plate_count: usize, window: usize) -> Self {
        Self {
            torque_samples: vec![Vec3f::default(); plate_count * window],
            heads: vec![0u8; plate_count],
            fill: vec![0u8; plate_count],
            window,
        }
    }

    /// Resize-up to fit new plates spawned via fork. Existing plates'
    /// rolling state is preserved.
    pub fn resize_to(&mut self, plate_count: usize) {
        let w = self.window;
        if self.heads.len() >= plate_count {
            return;
        }
        self.torque_samples.resize(plate_count * w, Vec3f::default());
        self.heads.resize(plate_count, 0);
        self.fill.resize(plate_count, 0);
    }

    /// Append a torque sample to plate p's history and return the
    /// rolling-window average torque.
    pub fn push_and_average(&mut self, p: usize, sample: Vec3f) -> Vec3f {
        let w = self.window.max(1);
        let head = self.heads[p] as usize;
        let slot = p * w + head;
        self.torque_samples[slot] = sample;
        self.heads[p] = ((head + 1) % w) as u8;
        if (self.fill[p] as usize) < w {
            self.fill[p] += 1;
        }
        let n = self.fill[p] as usize;
        let mut acc = Vec3f::new(0.0, 0.0, 0.0);
        for i in 0..n {
            let s = self.torque_samples[p * w + i];
            acc.x += s.x;
            acc.y += s.y;
            acc.z += s.z;
        }
        let inv = 1.0 / n as f64;
        Vec3f::new(acc.x * inv, acc.y * inv, acc.z * inv)
    }
}

/// Per-step motion-evolution diagnostics, accumulated across all steps.
#[derive(Debug, Default, Clone, Copy)]
pub struct MotionEvolutionStats {
    /// Total Δω application events across all plates / steps.
    pub updates: u64,
    /// Times the |Δω| cap fired.
    pub d_omega_clamps: u64,
    /// Times the |ω| cap fired.
    pub omega_clamps: u64,
}

/// Apply one macro-step of torque integration to every live plate.
///
/// Forces modelled:
///  - **Slab pull** (emergent): a torque on each plate from its convergent
///    boundary cells. Per cell, force magnitude scales with crust age
///    (denser slab pulls harder) and points from the plate seed toward the
///    boundary midpoint. Torque = r × F integrated over those cells.
///  - **Drag** (damping): -k_drag · ω · area_cells. Keeps motion bounded.
///
/// Stability stack:
///  - 4-step rolling-average torque (avoids per-step CA flip spikes).
///  - Per-step |Δω| ≤ d_omega_max (default ω_max/50).
///  - |ω| ≤ ω_max (default 0.002 rad/Myr ≈ 25 cm/yr).
///
/// Determinism: iterates plates in monotonic id order, cells in mesh order.
/// No HashMap; all per-plate state lives in flat Vecs indexed by plate id.
#[allow(clippy::too_many_arguments)]
pub fn evolve_motion(
    assignment: &PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    crust: &CrustState,
    adjacency: &Adjacency,
    vertices: &[Vec3f],
    opts: &MotionEvolutionOptions,
    history: &mut MotionHistory,
    stats: &mut MotionEvolutionStats,
) {
    let n_plates = motions.len();
    history.resize_to(n_plates);

    // ── 1. Accumulate raw torque + cell counts per plate from the
    //       current crust / cell_plate state. Single pass over all cells.
    let mut raw_torque: Vec<Vec3f> = vec![Vec3f::default(); n_plates];
    let mut area_cells: Vec<u32> = vec![0u32; n_plates];

    let n_cells = assignment.cell_plate.len();
    for v in 0..n_cells {
        let p = assignment.cell_plate[v] as usize;
        if p >= n_plates {
            continue;
        }
        area_cells[p] += 1;

        // Identify whether this cell sits on a convergent boundary owned by
        // plate p. Use the same dominant-neighbor test as the CA pass,
        // simplified to a sign check.
        let neighbors = adjacency.of(v as u32);
        let mut best_dot: f64 = 0.0;
        let mut best_dir = Vec3f::new(0.0, 0.0, 0.0);
        let pa = vertices[v];

        // Seed positions for direction calc.
        let seed_p = assignment
            .plates
            .get(p)
            .and_then(|s| s.as_ref())
            .map(|pl| pl.seed_pos)
            .unwrap_or(pa);

        for &nb in neighbors {
            let q = assignment.cell_plate[nb as usize] as usize;
            if q == p {
                continue;
            }
            // Boundary midpoint on sphere.
            let pb = vertices[nb as usize];
            let m = pa.midpoint(pb).normalize();

            // Direction from this plate's seed toward the boundary.
            let raw = m.sub(seed_p);
            let n_tan = crate::sphere_geom::project_to_tangent_plane(m, raw);
            if n_tan.dot(n_tan) < 1e-18 {
                continue;
            }
            let dir = n_tan.normalize_or(m);

            // Use relative motion sign to detect convergence (matches
            // ca_inner). If approaching, treat this cell as subducting
            // edge for plate p.
            let v_a = motions[p]
                .map(|m| m.velocity_at(pa))
                .unwrap_or_default();
            let v_b = motions[q]
                .map(|m| m.velocity_at(pa))
                .unwrap_or_default();
            let v_rel = v_a.sub(v_b);
            // Boundary normal (seed-to-seed projection, like CA).
            let s_a = assignment
                .plates
                .get(p)
                .and_then(|s| s.as_ref())
                .map(|pl| pl.seed_pos)
                .unwrap_or(pa);
            let s_b = assignment
                .plates
                .get(q)
                .and_then(|s| s.as_ref())
                .map(|pl| pl.seed_pos)
                .unwrap_or(pb);
            let nrm = crate::sphere_geom::project_to_tangent_plane(m, s_b.sub(s_a));
            if nrm.dot(nrm) < 1e-18 {
                continue;
            }
            let nrm = nrm.normalize_or(m);
            let normal_speed = v_rel.dot(nrm);

            // Cell v is "the overriding cell" iff normal_speed > 0 (its
            // neighbor approaches). We pull the plate toward the trench.
            if normal_speed > best_dot {
                best_dot = normal_speed;
                best_dir = dir;
            }
        }

        if best_dot > 0.0 {
            // Slab pull magnitude ∝ age × force_per_cell. Use age + 1
            // so very-young cells still contribute a token amount.
            let age = crust.age_ma[v] as f64;
            let mag = (age + 1.0) * opts.k_slab;
            let force = best_dir.scale(mag);
            // Torque = r × F where r = boundary midpoint on unit sphere.
            // Approximate r ≈ pa for cheap; same order of magnitude.
            let r = pa;
            let tau = r.cross(force);
            let acc = &mut raw_torque[p];
            acc.x += tau.x;
            acc.y += tau.y;
            acc.z += tau.z;
        }
    }

    // ── 2. For each live plate (sorted iteration = monotonic id), push
    //       the raw torque into the rolling-average history, add drag,
    //       integrate ω with the clamps.
    for p in 0..n_plates {
        let Some(motion) = motions[p] else {
            continue;
        };
        let avg_tau = history.push_and_average(p, raw_torque[p]);

        // Drag torque: -k_drag · ω · area_cells.
        let area = area_cells[p] as f64;
        let drag = motion.omega.scale(-opts.k_drag * area);

        let net = Vec3f::new(
            avg_tau.x + drag.x,
            avg_tau.y + drag.y,
            avg_tau.z + drag.z,
        );

        // Δω = net torque this step (treat dt and moment-of-inertia as
        // folded into k_slab / k_drag — the per-step coefficients).
        let mut d_omega = net;

        // Clamp |Δω|.
        let d_mag = d_omega.length();
        if d_mag > opts.d_omega_max && d_mag > 0.0 {
            let s = opts.d_omega_max / d_mag;
            d_omega = d_omega.scale(s);
            stats.d_omega_clamps += 1;
        }

        let mut new_omega = Vec3f::new(
            motion.omega.x + d_omega.x,
            motion.omega.y + d_omega.y,
            motion.omega.z + d_omega.z,
        );

        // Clamp |ω|.
        let w_mag = new_omega.length();
        if w_mag > opts.omega_max && w_mag > 0.0 {
            let s = opts.omega_max / w_mag;
            new_omega = new_omega.scale(s);
            stats.omega_clamps += 1;
        }

        motions[p] = Some(PlateMotion { omega: new_omega });
        stats.updates += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn velocity_perpendicular_to_position() {
        // ω × p is always perpendicular to p on a sphere, so a plate
        // rotating around any axis produces purely tangential motion.
        let m = PlateMotion { omega: Vec3f::new(0.1, 0.2, 0.3) };
        let p = Vec3f::new(1.0, 0.0, 0.0);
        let v = m.velocity_at(p);
        let dot = v.x * p.x + v.y * p.y + v.z * p.z;
        assert!(dot.abs() < 1e-12, "velocity not tangent: dot = {}", dot);
    }

    #[test]
    fn same_seed_same_motions() {
        let a = sample_plate_motions(MasterSeed(42), 12);
        let b = sample_plate_motions(MasterSeed(42), 12);
        for (m1, m2) in a.iter().zip(b.iter()) {
            let m1 = m1.as_ref().unwrap();
            let m2 = m2.as_ref().unwrap();
            assert_eq!(m1.omega.x, m2.omega.x);
            assert_eq!(m1.omega.y, m2.omega.y);
            assert_eq!(m1.omega.z, m2.omega.z);
        }
    }

    // ── M0.7: motion evolution tests ──────────────────────────────────
    use crate::adjacency::Adjacency;
    use crate::crust_state::{CrustOptions, CrustState};
    use crate::mesh::Icosphere;
    use crate::plates::{BuildOptions, PlateAssignment};

    fn build_motion_world(
        seed: u64,
        level: u32,
        plate_count: u32,
    ) -> (Icosphere, PlateAssignment, Vec<Option<PlateMotion>>, CrustState, Adjacency) {
        let sphere = Icosphere::new(level);
        let mut plates = PlateAssignment::build(
            MasterSeed(seed),
            &sphere,
            BuildOptions { plate_count, ..BuildOptions::default() },
        );
        let mut motions = sample_plate_motions(MasterSeed(seed), plate_count);
        plates.prune_empty(&mut motions);
        let seeds: Vec<Vec3f> = plates
            .plates
            .iter()
            .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default())
            .collect();
        let crust = CrustState::initial(
            MasterSeed(seed),
            &sphere.vertices,
            &mut plates,
            &seeds,
            CrustOptions::default(),
        );
        let adjacency = Adjacency::build(&sphere);
        (sphere, plates, motions, crust, adjacency)
    }

    #[test]
    fn stationary_plate_stays_still() {
        // Construct a 1-plate world (whole sphere is one plate, no boundaries)
        // and zero its motion. Under drag-only forcing the plate must
        // remain at rest.
        let (sphere, plates, _motions, crust, adjacency) = build_motion_world(7, 3, 1);
        let mut motions: Vec<Option<PlateMotion>> = vec![Some(PlateMotion {
            omega: Vec3f::new(0.0, 0.0, 0.0),
        })];
        let opts = MotionEvolutionOptions::default();
        let mut history = MotionHistory::new(motions.len(), opts.torque_window);
        let mut stats = MotionEvolutionStats::default();
        for _ in 0..20 {
            evolve_motion(
                &plates,
                &mut motions,
                &crust,
                &adjacency,
                &sphere.vertices,
                &opts,
                &mut history,
                &mut stats,
            );
        }
        let w = motions[0].unwrap().omega;
        assert!(
            w.length() < 1e-15,
            "stationary plate drifted: |ω| = {}",
            w.length()
        );
    }

    #[test]
    fn convergent_plate_accelerates() {
        // Build a 2-plate world. Plate 0 starts at rest; the other plate
        // is moving toward it. After several macro steps the rest plate
        // should have gained some ω from slab pull.
        let (sphere, plates, mut motions, crust, adjacency) = build_motion_world(13, 4, 2);
        // Force plate 0 to rest, leave plate 1 with its sampled motion.
        if let Some(m) = motions.get_mut(0) {
            *m = Some(PlateMotion { omega: Vec3f::new(0.0, 0.0, 0.0) });
        }
        // Boost plate 1's motion magnitude so the relative velocity is
        // unambiguously convergent on most shared edges.
        if let Some(Some(m)) = motions.get_mut(1) {
            m.omega = m.omega.scale(5.0);
        }
        let opts = MotionEvolutionOptions::default();
        let mut history = MotionHistory::new(motions.len(), opts.torque_window);
        let mut stats = MotionEvolutionStats::default();
        for _ in 0..50 {
            evolve_motion(
                &plates,
                &mut motions,
                &crust,
                &adjacency,
                &sphere.vertices,
                &opts,
                &mut history,
                &mut stats,
            );
        }
        let w = motions[0].unwrap().omega.length();
        assert!(
            w > 0.0,
            "convergent plate did not gain motion: |ω| = {} (updates {}, dω-clamps {})",
            w, stats.updates, stats.d_omega_clamps,
        );
    }

    #[test]
    fn velocity_clamp_holds() {
        // Force a plate to extreme initial ω. After 100 steps |ω| must
        // not exceed ω_max.
        let (sphere, plates, mut motions, crust, adjacency) = build_motion_world(99, 3, 3);
        // Slam plate 0 to 10x the clamp.
        if let Some(m) = motions.get_mut(0) {
            *m = Some(PlateMotion {
                omega: Vec3f::new(0.1, 0.1, 0.1),
            });
        }
        let opts = MotionEvolutionOptions::default();
        let mut history = MotionHistory::new(motions.len(), opts.torque_window);
        let mut stats = MotionEvolutionStats::default();
        for _ in 0..100 {
            evolve_motion(
                &plates,
                &mut motions,
                &crust,
                &adjacency,
                &sphere.vertices,
                &opts,
                &mut history,
                &mut stats,
            );
            // Invariant must hold after every step, not just at end.
            for slot in motions.iter().flatten() {
                assert!(
                    slot.omega.length() <= opts.omega_max + 1e-12,
                    "|ω| = {} exceeded ω_max = {}",
                    slot.omega.length(), opts.omega_max,
                );
            }
        }
    }

    #[test]
    fn rates_are_in_realistic_range() {
        // |omega| should fall in the heavy-tailed band: median ≈ 1e-4,
        // 95th percentile around 5e-4, max around 2-3e-3 (Indian-plate-fast).
        let motions = sample_plate_motions(MasterSeed(42), 50);
        let mags: Vec<f64> = motions.iter().map(|m| {
            let m = m.as_ref().unwrap();
            (m.omega.x * m.omega.x + m.omega.y * m.omega.y + m.omega.z * m.omega.z).sqrt()
        }).collect();
        for &mag in &mags {
            assert!(mag >= 0.00005 && mag <= 0.005,
                "rate {} outside heavy-tailed band", mag);
        }
        // Sanity: max should be at least 3× median.
        let mut sorted = mags.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = sorted[sorted.len() / 2];
        let max = sorted[sorted.len() - 1];
        assert!(max / median >= 3.0, "heavy-tail not heavy enough: max/median = {}", max / median);
    }
}
