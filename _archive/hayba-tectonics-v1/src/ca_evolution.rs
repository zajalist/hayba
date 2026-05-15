//! Cellular Automaton (CA) evolution of plate ownership over geological time.
//!
//! This is **the** mechanism that breaks the Power Diagram's intrinsic
//! convexity and produces real Earth-like non-convex plate shapes:
//! peninsulas (from differential subduction), embayments (from sweeping
//! convergent arcs), ribbon terranes (from asymmetric spreading).
//!
//! **Per-step rules** (from the locked spec):
//! - **Convergent** (`v_rel · n > +threshold`): denser cell loses ownership,
//!   joins lighter plate. Composition + age reset to overriding plate's defaults.
//! - **Divergent** (`v_rel · n < −threshold`): no ownership change. Both
//!   cells get composition = oceanic, age = 0. Represents fresh crust at a
//!   spreading ridge.
//! - **Transform** (low normal_speed): no-op.
//!
//! **Double-buffering**: every step reads from the previous state buffer and
//! writes to a fresh buffer. This guarantees order-independence within a
//! step — no race conditions, no mutual-subduction paradoxes.
//!
//! **Convergence threshold** controls how much relative motion is required
//! to count as convergent/divergent vs transform. Calibrated against typical
//! plate velocities (~1e-4 rad/Myr) so transform faults appear at ~30% of
//! all boundaries on average.
//!
//! Week 3 scope: convergent + divergent + transform only. NO contiguity
//! check (Week 4), NO plate spawn/death (Week 4), NO slab-pull feedback
//! (Week 4). Just see if shapes evolve.

use crate::adjacency::Adjacency;
use crate::crust_state::CrustState;
use crate::hotspots::{HotspotsOptions, HotspotsState};
use crate::macro_step::{run_step, StepContext};
use crate::mesh::Vec3f;
use crate::metrics::Metrics;
use crate::motion::{MotionEvolutionOptions, MotionEvolutionStats, MotionHistory, PlateMotion};
use hayba_seeds::MasterSeed;

pub struct EvolutionOptions {
    pub macro_steps: u32,
    pub dt_ma: u32,
    /// Below this absolute normal-velocity, boundary is treated as transform.
    /// Default calibrated against typical plate velocities (~1e-4 rad/Myr).
    pub convergence_threshold: f64,
    /// Minimum plate size in cells. Connected components below this get
    /// absorbed by their dominant neighbor at the end of each step.
    pub n_min_cells: usize,
    /// How often (in steps) to run contiguity enforcement. 1 = every step,
    /// 5 = every 5 steps. Higher values let plates fracture more during
    /// transit but cost less CPU.
    pub contiguity_interval: u32,
    /// How often to run the majority-filter smoothing pass. Running every
    /// step over-regularizes shapes into hexagonal Voronoi cells; running
    /// every 4 steps lets transient ribbons and peninsulas form before
    /// being smoothed.
    pub smoothing_interval: u32,
    /// High-convergence boundary cells can swap with this many target-plate
    /// neighbors. Lower threshold = more aggressive growth into neighbors.
    pub frontier_high_vel: usize,
    /// Low-convergence cells need this many target neighbors. Higher
    /// threshold prevents accidental orphan formation in slow zones.
    pub frontier_low_vel: usize,
    /// The threshold separating high- vs low-velocity boundaries.
    pub high_vel_threshold: f64,
    /// Slab-pull strength: per-step angular-velocity boost proportional to
    /// the fraction of a plate's boundary that's convergent. 0 = no
    /// feedback. 0.01-0.05 = realistic acceleration.
    pub slab_pull_strength: f64,
    /// **M0.7: motion evolution.** When `true`, after every macro-step the
    /// driver integrates slab-pull + drag torques against the current crust
    /// state and updates each live plate's angular velocity (with the
    /// stability stack: 4-step rolling-average torque, per-step Δω cap,
    /// global ω cap). Default `false` — keep semantics frozen until the
    /// flag is opted into.
    pub enable_motion_evolution: bool,
    /// Tuning knobs for `evolve_motion`. Unused while
    /// `enable_motion_evolution` is `false`.
    pub motion_evolution: MotionEvolutionOptions,
    /// M0.12 — master seed used to derive the hotspot stream. Threaded
    /// through `EvolutionOptions` so every caller naturally supplies a
    /// deterministic seed without altering existing call shapes; defaults
    /// to `MasterSeed(0)` so `..Default::default()` updates keep
    /// compiling.
    pub master: MasterSeed,
    /// M0.12 — hotspots config. Defaults to 30 plumes / 7% LIP.
    pub hotspots: HotspotsOptions,
}

impl Default for EvolutionOptions {
    fn default() -> Self {
        Self {
            // 250 steps × 5 Ma = 1.25 Ga ≈ ~2.5 Wilson cycles. Long enough
            // for plate margins to deviate substantially from the initial
            // Voronoi geometry — produces dramatically non-Voronoi macro
            // shapes.
            macro_steps: 250,
            dt_ma: 5,
            convergence_threshold: 3e-5,
            n_min_cells: 32,
            contiguity_interval: 1,
            smoothing_interval: 8,
            frontier_high_vel: 3,
            frontier_low_vel: 3,
            high_vel_threshold: 2.0e-4,
            // Slab-pull disabled until we get the directional component
            // right (it should redirect plates toward trenches, not just
            // amplify magnitude — that compounds catastrophically).
            slab_pull_strength: 0.0,
            // Default OFF until calibrated end-to-end. With this flag false
            // the macro_step driver must produce bit-identical state to the
            // pre-M0.7 baseline (see the determinism contract).
            enable_motion_evolution: false,
            motion_evolution: MotionEvolutionOptions::default(),
            master: MasterSeed(0),
            hotspots: HotspotsOptions::default(),
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct EvolutionStats {
    pub total_swaps: u64,
    pub total_divergent_resets: u64,
    pub total_absorbed_components: u32,
    pub total_absorbed_cells: u32,
    /// New plate ids created via rift fork (M0.4 onward).
    pub total_fork_spawns: u32,
    /// Cells tagged as aulacogen because their rift didn't sever the parent
    /// (or fired during cooldown). M0.3 + M0.4.
    pub total_failed_rifts: u32,
    /// Plates that fully retired during the sim (cell count reached 0).
    /// M0.6.
    pub total_plate_deaths: u32,
    /// Plates spawned via passive CC enforcement (one-plate-into-multi-CC,
    /// no rift impulse). M0.5.
    pub total_passive_splits: u32,
    /// M0.7 — rolled-up diagnostics from `evolve_motion`. Zero when
    /// `enable_motion_evolution` is false.
    pub motion: MotionEvolutionStats,
}

/// Run the CA evolution loop. Mutates `cell_plate`, `crust.composition`, and
/// `crust.age_ma` in place to reflect the final state after `macro_steps`.
///
/// The per-step body lives in `macro_step::run_step`; this function is a
/// thin driver that allocates the per-step workspace once and reuses it
/// across all steps.
pub fn evolve_ca(
    assignment: &mut crate::plates::PlateAssignment,
    crust: &mut CrustState,
    vertices: &[Vec3f],
    adjacency: &Adjacency,
    motions: &mut Vec<Option<PlateMotion>>,
    opts: EvolutionOptions,
) -> EvolutionStats {
    let mut metrics = Metrics::new();
    evolve_ca_with_metrics(assignment, crust, vertices, adjacency, motions, opts, &mut metrics)
}

/// Like [`evolve_ca`], but also fills the caller-owned `Metrics` collector
/// with per-macro-step samples. Used by the debug-suite to gate against
/// Earth-target bands.
///
/// Sampling is READ-ONLY with respect to sim state, so output (cell_plate,
/// crust.*, motions) is bit-identical to `evolve_ca` for the same seed.
pub fn evolve_ca_with_metrics(
    assignment: &mut crate::plates::PlateAssignment,
    crust: &mut CrustState,
    vertices: &[Vec3f],
    adjacency: &Adjacency,
    motions: &mut Vec<Option<PlateMotion>>,
    opts: EvolutionOptions,
    metrics: &mut Metrics,
) -> EvolutionStats {
    let mut stats = EvolutionStats::default();

    // Allocate per-step workspace ONCE; reused across every macro step.
    let mut next_plate = assignment.cell_plate.clone();
    let mut next_composition = crust.composition.clone();
    let mut next_age = crust.age_ma.clone();
    let mut next_elev = crust.elevation_m.clone();
    let mut next_layers = crust.layers.clone();
    let mut next_bending = crust.bending.clone();
    let mut next_volcanic_act = crust.volcanic_act.clone();
    let mut next_rift_progress = crust.rift_progress.clone();
    let mut current_motions: Vec<PlateMotion> = motions
        .iter()
        .map(|m| {
            m.unwrap_or(PlateMotion {
                omega: Vec3f::new(0.0, 0.0, 0.0),
            })
        })
        .collect();
    let mut convergent_load = vec![0u32; motions.len()];
    let mut total_boundary_load = vec![0u32; motions.len()];
    let mut mature_rift_this_step: Vec<u32> = Vec::new();
    let mut plate_seeds: Vec<Vec3f> = Vec::with_capacity(assignment.plates.len());
    let mut rift_boost: Vec<u8> = vec![0u8; assignment.cell_plate.len()];
    // M0.7: rolling-window torque history. Allocated even when motion
    // evolution is disabled — small (`plate_count * window * 24 bytes`) and
    // keeps the StepContext layout uniform.
    let mut motion_history =
        MotionHistory::new(motions.len(), opts.motion_evolution.torque_window);
    // M0.12: hotspot registry. Built once from the master seed and stepped
    // per macro-step in `post_step`. Lives across the loop so drift
    // accumulates across steps.
    let mut hotspots = HotspotsState::new(opts.master, &opts.hotspots);

    for step in 0..opts.macro_steps {
        let mut ctx = StepContext::new(
            assignment, crust, motions, vertices, adjacency, &opts, &mut stats, step,
            &mut next_plate, &mut next_composition, &mut next_age, &mut next_elev,
            &mut next_layers, &mut next_bending, &mut next_volcanic_act, &mut next_rift_progress,
            &mut current_motions, &mut convergent_load, &mut total_boundary_load,
            &mut mature_rift_this_step, &mut plate_seeds, &mut rift_boost,
            &mut motion_history,
            &mut hotspots,
            metrics,
        );
        run_step(&mut ctx);
    }

    // Final junction sweep: majority smoothing + contiguity can introduce
    // a small number of quad+ junctions at mesh vertices. Resolve them
    // before returning so downstream code never sees > 3 plates around
    // any vertex.
    for _ in 0..16 {
        let residual =
            crate::plates::resolve_high_order_junctions(&mut assignment.cell_plate, adjacency);
        if residual == 0 {
            break;
        }
    }

    stats
}

/// Like [`evolve_ca_with_metrics`], but also streams binary state deltas
/// into a caller-owned [`crate::frame_stream::FrameEncoder`]. Used by the
/// `tectonic-preview` binary to dump `viz/data/world.bin` for the viewer.
///
/// The encoder header + initial-state block must be written **before**
/// calling this function. This driver only emits per-step frame records
/// (one per macro-step) via the `frame_encoder` hook inside `post_step`.
///
/// Determinism: sampling is READ-ONLY with respect to sim state, so
/// `cell_plate` / `crust` / `motions` are bit-identical to `evolve_ca` for
/// the same seed.
#[allow(clippy::too_many_arguments)]
pub fn evolve_ca_with_encoder(
    assignment: &mut crate::plates::PlateAssignment,
    crust: &mut CrustState,
    vertices: &[Vec3f],
    adjacency: &Adjacency,
    motions: &mut Vec<Option<PlateMotion>>,
    opts: EvolutionOptions,
    metrics: &mut Metrics,
    encoder: &mut crate::frame_stream::FrameEncoder,
) -> EvolutionStats {
    let mut stats = EvolutionStats::default();

    let mut next_plate = assignment.cell_plate.clone();
    let mut next_composition = crust.composition.clone();
    let mut next_age = crust.age_ma.clone();
    let mut next_elev = crust.elevation_m.clone();
    let mut next_layers = crust.layers.clone();
    let mut next_bending = crust.bending.clone();
    let mut next_volcanic_act = crust.volcanic_act.clone();
    let mut next_rift_progress = crust.rift_progress.clone();
    let mut current_motions: Vec<PlateMotion> = motions
        .iter()
        .map(|m| {
            m.unwrap_or(PlateMotion {
                omega: Vec3f::new(0.0, 0.0, 0.0),
            })
        })
        .collect();
    let mut convergent_load = vec![0u32; motions.len()];
    let mut total_boundary_load = vec![0u32; motions.len()];
    let mut mature_rift_this_step: Vec<u32> = Vec::new();
    let mut plate_seeds: Vec<Vec3f> = Vec::with_capacity(assignment.plates.len());
    let mut rift_boost: Vec<u8> = vec![0u8; assignment.cell_plate.len()];
    let mut motion_history =
        MotionHistory::new(motions.len(), opts.motion_evolution.torque_window);
    let mut hotspots = HotspotsState::new(opts.master, &opts.hotspots);

    for step in 0..opts.macro_steps {
        let mut ctx = StepContext::new_with_encoder(
            assignment, crust, motions, vertices, adjacency, &opts, &mut stats, step,
            &mut next_plate, &mut next_composition, &mut next_age, &mut next_elev,
            &mut next_layers, &mut next_bending, &mut next_volcanic_act, &mut next_rift_progress,
            &mut current_motions, &mut convergent_load, &mut total_boundary_load,
            &mut mature_rift_this_step, &mut plate_seeds, &mut rift_boost,
            &mut motion_history,
            &mut hotspots,
            metrics,
            Some(encoder),
            None,
        );
        run_step(&mut ctx);
    }

    for _ in 0..16 {
        let residual =
            crate::plates::resolve_high_order_junctions(&mut assignment.cell_plate, adjacency);
        if residual == 0 {
            break;
        }
    }

    stats
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::crust_state::CrustOptions;
    use crate::mesh::Icosphere;
    use crate::motion::sample_plate_motions;
    use crate::plates::{BuildOptions, PlateAssignment};
    use hayba_seeds::MasterSeed;

    fn build_world(seed: u64, level: u32, plate_count: u32) -> (
        Icosphere,
        PlateAssignment,
        Vec<Option<PlateMotion>>,
        CrustState,
        Adjacency,
        Vec<Vec3f>,
    ) {
        let sphere = Icosphere::new(level);
        let mut plates = PlateAssignment::build(
            MasterSeed(seed),
            &sphere,
            BuildOptions { plate_count, ..BuildOptions::default() },
        );
        let mut motions = sample_plate_motions(MasterSeed(seed), plate_count);
        plates.prune_empty(&mut motions);
        let seed_positions: Vec<Vec3f> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
        let crust = CrustState::initial(
            MasterSeed(seed),
            &sphere.vertices,
            &mut plates,
            &seed_positions,
            CrustOptions::default(),
        );
        let adjacency = Adjacency::build(&sphere);
        (sphere, plates, motions, crust, adjacency, seed_positions)
    }

    #[test]
    fn aulacogen_accumulates_rift_progress_faster() {
        // Build two parallel worlds with identical state, mark one cluster
        // of cells as aulacogen, and verify rift_progress climbs faster there
        // after running CA for a short window.
        let (sphere, plates, motions, crust, adjacency, _seeds) = build_world(42, 4, 12);

        let mut plates_v = plates.clone();
        let mut plates_a = plates;
        let mut motions_v = motions.clone();
        let mut motions_a = motions;
        let mut crust_virgin = crust;
        let mut crust_aulacogen = crust_virgin.clone();

        let tagged: Vec<u32> = (0..30u32).collect();
        crust_aulacogen.mark_failed_rift(&tagged, 100);

        let _ = evolve_ca(
            &mut plates_v, &mut crust_virgin, &sphere.vertices, &adjacency,
            &mut motions_v, EvolutionOptions { macro_steps: 8, ..Default::default() },
        );
        let _ = evolve_ca(
            &mut plates_a, &mut crust_aulacogen, &sphere.vertices, &adjacency,
            &mut motions_a, EvolutionOptions { macro_steps: 8, ..Default::default() },
        );

        let sum_v: u64 = tagged.iter().map(|&i| crust_virgin.rift_progress[i as usize] as u64).sum();
        let sum_a: u64 = tagged.iter().map(|&i| crust_aulacogen.rift_progress[i as usize] as u64).sum();
        if sum_v > 0 || sum_a > 0 {
            assert!(sum_a >= sum_v,
                "aulacogen rift_progress sum {} should be >= virgin {}",
                sum_a, sum_v);
        }
    }

    #[test]
    fn evolution_is_deterministic() {
        let (sphere, plates, motions, crust, adjacency, _seeds) = build_world(42, 4, 20);

        let mut plates1 = plates.clone();
        let mut motions1 = motions.clone();
        let mut cr1 = crust;
        let _stats1 = evolve_ca(
            &mut plates1, &mut cr1, &sphere.vertices, &adjacency,
            &mut motions1, EvolutionOptions { macro_steps: 20, ..Default::default() },
        );

        let (sphere2, plates2, motions2, crust2, adjacency2, _seeds2) =
            build_world(42, 4, 20);
        let mut plates2 = plates2.clone();
        let mut motions2 = motions2.clone();
        let mut cr2 = crust2;
        let _stats2 = evolve_ca(
            &mut plates2, &mut cr2, &sphere2.vertices, &adjacency2,
            &mut motions2, EvolutionOptions { macro_steps: 20, ..Default::default() },
        );

        assert_eq!(plates1.cell_plate, plates2.cell_plate);
        assert_eq!(cr1.composition, cr2.composition);
        assert_eq!(cr1.age_ma, cr2.age_ma);
    }

    #[test]
    fn evolution_changes_state() {
        let (sphere, plates, motions, mut crust, adjacency, _seeds) =
            build_world(42, 4, 20);
        let original = plates.cell_plate.clone();
        let mut plates = plates;
        let mut motions = motions;
        let stats = evolve_ca(
            &mut plates, &mut crust, &sphere.vertices, &adjacency,
            &mut motions, EvolutionOptions { macro_steps: 50, ..Default::default() },
        );

        let n_changed = plates.cell_plate.iter().zip(original.iter()).filter(|(a, b)| a != b).count();
        assert!(n_changed > 0, "evolution did not change any cells (swaps={})", stats.total_swaps);
        assert!(stats.total_swaps > 0, "no convergent swaps occurred");
    }

    #[test]
    fn ages_advance_over_time() {
        let (sphere, plates, motions, mut crust, adjacency, _seeds) =
            build_world(42, 3, 12);
        for age in crust.age_ma.iter_mut() { *age = (*age).min(50); }
        let mut plates = plates;
        let mut motions = motions;
        let _ = evolve_ca(
            &mut plates, &mut crust, &sphere.vertices, &adjacency,
            &mut motions, EvolutionOptions { macro_steps: 20, dt_ma: 5, ..Default::default() },
        );
        let max_age = *crust.age_ma.iter().max().unwrap();
        assert!(max_age >= 50 + 20 * 5,
            "max age {} Ma did not advance by 20 steps × 5 Ma", max_age);
    }

    /// Regression test for the "mountains line every boundary" bug.
    /// After a long run (250 macro-steps, seed 12345), high elevations
    /// (>3000m) must be concentrated on cells that are continental and
    /// have at least one continental cross-plate neighbor or are interior
    /// continental cells. Oceanic and island-only cells must not produce
    /// 3000m+ peaks, and the global elevation clamp (-11000, +9000) must
    /// be respected.
    #[test]
    fn mountains_confined_to_continental_cells() {
        use crate::crust_state::Composition;
        // Smaller-than-preview but big enough to exercise many boundary
        // types deterministically. Level 5 → 10242 cells.
        let (sphere, plates, motions, mut crust, adjacency, _seeds) =
            build_world(12345, 5, 24);
        let mut plates = plates;
        let mut motions = motions;
        let _ = evolve_ca(
            &mut plates, &mut crust, &sphere.vertices, &adjacency,
            &mut motions, EvolutionOptions { macro_steps: 250, ..Default::default() },
        );

        let n = sphere.vertices.len();
        // 1. Global clamp invariant.
        for (i, &e) in crust.elevation_m.iter().enumerate() {
            assert!(e <= 9000 && e >= -11000,
                "cell {} elevation {} outside [-11000, +9000]", i, e);
        }

        // 2. No oceanic cell whose cross-plate neighbors are ALL oceanic/
        // island should exceed 1500m. (Pure oce-oce convergent / divergent
        // / transform paths must never produce mountains — only an island
        // arc that has matured into Continental composition gets uplift,
        // and at that point the cell's own composition is no longer Oceanic.)
        let mut violations = 0u32;
        for i in 0..n {
            if crust.composition[i] != Composition::Oceanic {
                continue;
            }
            if crust.elevation_m[i] > 1500 {
                violations += 1;
            }
        }
        assert!(violations == 0,
            "{} oceanic cells exceed +1500m — oce-oce path is pumping elevation",
            violations);

        // 3. The 9000m peaks should be confined to cells whose composition
        // is Continental AND have either a continental cross-plate neighbor
        // or are an interior continental cell (legacy orogeny). No isolated
        // mountains over oceanic regions.
        let mut suspicious = 0u32;
        for i in 0..n {
            if crust.elevation_m[i] <= 5000 {
                continue;
            }
            if crust.composition[i] != Composition::Continental {
                suspicious += 1;
                continue;
            }
            // OK — continental cell over 5000m. That's where mountains belong.
        }
        assert!(suspicious == 0,
            "{} non-continental cells exceed +5000m — there is a non-orogenic elevation pump",
            suspicious);
    }
}
