//! Macro-step orchestrator.
//!
//! A "macro step" is one geological time tick (~5 Ma) of the tectonic sim.
//! Each step has a fixed three-phase shape so frame emitters, GPU ports,
//! and metric collectors can hook between phases without editing the inner
//! loop.
//!
//! Phases (called in fixed order by `run_step`):
//! 1. `pre_step` — snapshot per-plate state, prepare double-buffers.
//! 2. `ca_inner` — cell-level CA pass + buffer swap + age advance.
//! 3. `post_step` — boundary lifecycle (smoothing, contiguity, rift
//!    propagation, fork, passive CC split, plate death).
//!
//! Phase boundaries are determinism-significant: changing call order
//! changes the per-step output even though the order itself is somewhat
//! arbitrary. Same seed = same output.

use crate::adjacency::Adjacency;
use crate::ca_evolution::{EvolutionOptions, EvolutionStats};
use crate::crust_state::{
    Composition, CrustState, CONTINENT_THRESHOLD, ISLAND_THRESHOLD, RIFT_THRESHOLD,
};
use crate::hotspots::HotspotsState;
use crate::mesh::Vec3f;
use crate::metrics::Metrics;
use crate::motion::{evolve_motion, MotionHistory, PlateMotion};
use crate::plates::PlateAssignment;
use crate::topology::{enforce_contiguity, smooth_majority};

/// Per-step working set. Holds the borrows the three phases share and a
/// workspace allocated once per `evolve_ca` call (not per step).
pub struct StepContext<'a> {
    pub assignment: &'a mut PlateAssignment,
    pub crust: &'a mut CrustState,
    pub motions: &'a mut Vec<Option<PlateMotion>>,
    pub vertices: &'a [Vec3f],
    pub adjacency: &'a Adjacency,
    pub opts: &'a EvolutionOptions,
    pub stats: &'a mut EvolutionStats,
    pub step: u32,

    // Per-step workspace, allocated once per `evolve_ca` call. These are
    // resized on demand if `motions` grows via fork spawns; their contents
    // are reset at the start of every step.
    pub next_plate: &'a mut Vec<u32>,
    pub next_composition: &'a mut Vec<Composition>,
    pub next_age: &'a mut Vec<u16>,
    pub next_elev: &'a mut Vec<i16>,
    pub next_layers: &'a mut Vec<crate::crust_state::CrustLayers>,
    pub next_bending: &'a mut Vec<u8>,
    pub next_volcanic_act: &'a mut Vec<u8>,
    pub next_rift_progress: &'a mut Vec<u8>,
    pub current_motions: &'a mut Vec<PlateMotion>,
    pub convergent_load: &'a mut Vec<u32>,
    pub total_boundary_load: &'a mut Vec<u32>,
    pub mature_rift_this_step: &'a mut Vec<u32>,
    /// Filled by `pre_step`, read by `ca_inner`.
    pub plate_seeds: &'a mut Vec<Vec3f>,
    /// Per-cell rift-propagation accumulator. Reset to 0 at the start of each
    /// rift-propagation phase (every other step), then filled in `post_step`.
    pub rift_boost: &'a mut Vec<u8>,
    /// M0.7 — rolling-average torque history per plate. Persisted across
    /// macro steps so `evolve_motion` can smooth raw torques over a window.
    pub motion_history: &'a mut MotionHistory,
    /// M0.12 — mantle hotspot registry. Drifts across steps and marks the
    /// cell currently overhead each macro-step in `post_step`.
    pub hotspots: &'a mut HotspotsState,
    /// M0.15 — per-macro-step metric collector. Sampled at the end of
    /// `post_step` for the debug-suite Earth-band gate. Read-only with
    /// respect to sim state.
    pub metrics: &'a mut Metrics,
    /// Optional binary delta-stream encoder. When `Some`, `post_step`
    /// emits a frame record at the end of every macro-step. When `None`
    /// the sim runs bit-identically to the pre-A1 baseline.
    pub frame_encoder: Option<&'a mut crate::frame_stream::FrameEncoder>,
    /// Optional MOR registry. **B2:** `post_step` mutates this when
    /// wired in — `age_step` on each live ridge, then `death_check` to
    /// retire ridges whose flanking plates died, axis collapsed, or
    /// divergence rate stayed below threshold for too long. The encoder
    /// also reads it via `write_frame` for MOR diffs.
    pub mor_registry: Option<&'a mut crate::mor::MorRegistry>,
}

impl<'a> StepContext<'a> {
    /// Construct a per-step context from the workspace borrows held by
    /// `evolve_ca`. Centralizes the field wiring so `evolve_ca`'s driver
    /// loop stays short.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        assignment: &'a mut PlateAssignment,
        crust: &'a mut CrustState,
        motions: &'a mut Vec<Option<PlateMotion>>,
        vertices: &'a [Vec3f],
        adjacency: &'a Adjacency,
        opts: &'a EvolutionOptions,
        stats: &'a mut EvolutionStats,
        step: u32,
        next_plate: &'a mut Vec<u32>,
        next_composition: &'a mut Vec<Composition>,
        next_age: &'a mut Vec<u16>,
        next_elev: &'a mut Vec<i16>,
        next_layers: &'a mut Vec<crate::crust_state::CrustLayers>,
        next_bending: &'a mut Vec<u8>,
        next_volcanic_act: &'a mut Vec<u8>,
        next_rift_progress: &'a mut Vec<u8>,
        current_motions: &'a mut Vec<PlateMotion>,
        convergent_load: &'a mut Vec<u32>,
        total_boundary_load: &'a mut Vec<u32>,
        mature_rift_this_step: &'a mut Vec<u32>,
        plate_seeds: &'a mut Vec<Vec3f>,
        rift_boost: &'a mut Vec<u8>,
        motion_history: &'a mut MotionHistory,
        hotspots: &'a mut HotspotsState,
        metrics: &'a mut Metrics,
    ) -> Self {
        Self::new_with_encoder(
            assignment, crust, motions, vertices, adjacency, opts, stats, step,
            next_plate, next_composition, next_age, next_elev, next_layers, next_bending,
            next_volcanic_act, next_rift_progress, current_motions, convergent_load,
            total_boundary_load, mature_rift_this_step, plate_seeds, rift_boost,
            motion_history, hotspots, metrics, None, None,
        )
    }

    /// Variant that also wires the binary-delta-stream encoder + an
    /// optional MOR registry through. Used by `evolve_ca_with_encoder`.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_encoder(
        assignment: &'a mut PlateAssignment,
        crust: &'a mut CrustState,
        motions: &'a mut Vec<Option<PlateMotion>>,
        vertices: &'a [Vec3f],
        adjacency: &'a Adjacency,
        opts: &'a EvolutionOptions,
        stats: &'a mut EvolutionStats,
        step: u32,
        next_plate: &'a mut Vec<u32>,
        next_composition: &'a mut Vec<Composition>,
        next_age: &'a mut Vec<u16>,
        next_elev: &'a mut Vec<i16>,
        next_layers: &'a mut Vec<crate::crust_state::CrustLayers>,
        next_bending: &'a mut Vec<u8>,
        next_volcanic_act: &'a mut Vec<u8>,
        next_rift_progress: &'a mut Vec<u8>,
        current_motions: &'a mut Vec<PlateMotion>,
        convergent_load: &'a mut Vec<u32>,
        total_boundary_load: &'a mut Vec<u32>,
        mature_rift_this_step: &'a mut Vec<u32>,
        plate_seeds: &'a mut Vec<Vec3f>,
        rift_boost: &'a mut Vec<u8>,
        motion_history: &'a mut MotionHistory,
        hotspots: &'a mut HotspotsState,
        metrics: &'a mut Metrics,
        frame_encoder: Option<&'a mut crate::frame_stream::FrameEncoder>,
        mor_registry: Option<&'a mut crate::mor::MorRegistry>,
    ) -> Self {
        Self {
            assignment,
            crust,
            motions,
            vertices,
            adjacency,
            opts,
            stats,
            step,
            next_plate,
            next_composition,
            next_age,
            next_elev,
            next_layers,
            next_bending,
            next_volcanic_act,
            next_rift_progress,
            current_motions,
            convergent_load,
            total_boundary_load,
            mature_rift_this_step,
            plate_seeds,
            rift_boost,
            motion_history,
            hotspots,
            metrics,
            frame_encoder,
            mor_registry,
        }
    }
}

/// Run one macro-step. Top-level controller. Phases run in fixed order:
///   1. `pre_step` — snapshot per-plate state, prepare buffers.
///   2. `ca_inner` — cell-level CA pass + buffer swap + age advance.
///   3. `post_step` — boundary lifecycle (rift propagation, fork, passive
///      split, death).
pub fn run_step(ctx: &mut StepContext) {
    pre_step(ctx);
    ca_inner(ctx);
    post_step(ctx);
}

/// Snapshot per-plate seed positions and reset the double-buffers.
fn pre_step(ctx: &mut StepContext) {
    // Snapshot per-plate seed positions for this step (id → seed_pos,
    // default for None slots). Cheap and dodges borrow conflicts with
    // assignment.cell_plate later in the inner loop.
    ctx.plate_seeds.clear();
    ctx.plate_seeds.extend(
        ctx.assignment
            .plates
            .iter()
            .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()),
    );

    // Resize per-plate workspace to match current registry capacity
    // (motions may have grown via fork spawns last step).
    debug_assert!(
        ctx.motions.len() >= ctx.convergent_load.len(),
        "INV: motions Vec is monotonic — death sets None, never pops"
    );
    // motions is monotonic — only grows on fork; death sets None in place. If this ever changes, this resize-up-only branch breaks.
    if ctx.convergent_load.len() < ctx.motions.len() {
        ctx.convergent_load.resize(ctx.motions.len(), 0);
        ctx.total_boundary_load.resize(ctx.motions.len(), 0);
        ctx.current_motions.resize(
            ctx.motions.len(),
            PlateMotion {
                omega: Vec3f::new(0.0, 0.0, 0.0),
            },
        );
        // Reset to latest motion values (last few entries may be fresh).
        for (i, m) in ctx.motions.iter().enumerate() {
            ctx.current_motions[i] = m.unwrap_or(PlateMotion {
                omega: Vec3f::new(0.0, 0.0, 0.0),
            });
        }
    }

    // Initialize next buffers as a copy of current state.
    ctx.next_plate.copy_from_slice(&ctx.assignment.cell_plate);
    ctx.next_composition.copy_from_slice(&ctx.crust.composition);
    ctx.next_age.copy_from_slice(&ctx.crust.age_ma);
    ctx.next_elev.copy_from_slice(&ctx.crust.elevation_m);
    ctx.next_layers.copy_from_slice(&ctx.crust.layers);
    ctx.next_bending.copy_from_slice(&ctx.crust.bending);
    ctx.next_volcanic_act.copy_from_slice(&ctx.crust.volcanic_act);
    ctx.next_rift_progress.copy_from_slice(&ctx.crust.rift_progress);
    for c in ctx.convergent_load.iter_mut() {
        *c = 0;
    }
    for c in ctx.total_boundary_load.iter_mut() {
        *c = 0;
    }
}

/// Composition-driven elevation baseline (meters). Used as the anchor that
/// boundary-type modulation drifts toward in `relax_elev`, and for interior
/// + transform/sub-threshold cells with no active vertical tectonic signal.
///
/// Calibrated against the boundary-kind elevation table (mid-ocean ridges
/// near -2500, abyssal plains near -4500, continental cratons around +400,
/// island arcs near sea-level once matured).
#[inline]
fn baseline_elev(comp: Composition) -> i32 {
    match comp {
        Composition::Oceanic => -4500,
        Composition::Island => 0,
        Composition::Continental => 400,
    }
}

/// Time-constants for `relax_elev`. Active tectonic boundaries (convergent /
/// divergent) pull elevation toward their target FAST so the geological
/// signal is visible within a few macro-steps. Transform + interior cells
/// drift back SLOWLY so noise-driven initial elevation and prior boundary
/// imprints decay over geological time rather than snapping to baseline.
///
/// k=4   → 25%/step (active boundary).
/// k=20  → 5%/step (transform / interior decay).
const K_ACTIVE: i32 = 4;
const K_DECAY: i32 = 20;

/// Per-step relaxation toward `target`. Returns next elevation given current
/// elevation, a target, and a time-constant `k`. Larger `k` → slower drift
/// (95% of target after ~3k steps). Clamped to the i16 elevation range.
#[inline]
fn relax_elev(current: i16, target: i32, k: i32) -> i16 {
    let cur = current as i32;
    let delta = (target - cur) / k;
    // Ensure non-zero motion when target != current so we don't stall on tiny
    // gaps. Sign-preserving minimum step of 1 m.
    let step = if delta == 0 && target != cur {
        if target > cur { 1 } else { -1 }
    } else {
        delta
    };
    (cur + step).clamp(-11000, 9000) as i16
}

/// Cell-level CA pass + buffer swap + age advance.
fn ca_inner(ctx: &mut StepContext) {
    let n_cells = ctx.assignment.cell_plate.len();
    let assignment = &mut *ctx.assignment;
    let crust = &mut *ctx.crust;
    let vertices = ctx.vertices;
    let adjacency = ctx.adjacency;
    let opts = ctx.opts;
    let stats = &mut *ctx.stats;
    let plate_seeds = &ctx.plate_seeds[..];
    let current_motions = &ctx.current_motions[..];

    for v in 0..n_cells {
        let plate_v = assignment.cell_plate[v] as usize;
        let neighbors = adjacency.of(v as u32);

        // First pass: find the strongest boundary interaction at this
        // cell across ALL cross-plate neighbors. Pick the dominant
        // signal rather than the first-in-id-order one.
        let mut best_normal: f64 = 0.0;
        let mut best_plate: Option<usize> = None;
        for &nb in neighbors {
            let plate_nb = assignment.cell_plate[nb as usize] as usize;
            if plate_v == plate_nb {
                continue;
            }

            let pa = vertices[v];
            let pb = vertices[nb as usize];
            let m = pa.midpoint(pb).normalize();

            let s_a = plate_seeds[plate_v];
            let s_b = plate_seeds[plate_nb];
            let raw_n = s_b.sub(s_a);
            let n_tan = crate::sphere_geom::project_to_tangent_plane(m, raw_n);
            // Skip degenerate (coincident seed) boundaries — preserves the
            // original 1e-18 squared-length cutoff.
            if n_tan.dot(n_tan) < 1e-18 {
                continue;
            }
            let n = n_tan.normalize_or(m);

            let v_a = current_motions[plate_v].velocity_at(m);
            let v_b = current_motions[plate_nb].velocity_at(m);
            let v_rel = v_a.sub(v_b);
            let normal_speed = v_rel.dot(n);

            if normal_speed.abs() > best_normal.abs() {
                best_normal = normal_speed;
                best_plate = Some(plate_nb);
            }
        }

        let Some(target_plate) = best_plate else {
            // Interior cell (no cross-plate neighbor). Without a baseline
            // pull these cells stay locked at whatever value the boundary
            // pump last set them to — which is how 9000m peaks persist
            // long after the convergent boundary that produced them has
            // moved on. Relax toward composition baseline so mountains
            // erode back to baseline once the boundary moves on (~5%/step,
            // half-life ~14 steps = 70 Ma).
            let target = baseline_elev(ctx.next_composition[v]);
            ctx.next_elev[v] = relax_elev(ctx.next_elev[v], target, K_DECAY);
            continue;
        };

        // Per-cell composition is now INDEPENDENT of plate identity.
        // Compare cell-level compositions to dispatch the correct
        // geological behaviour at this boundary.
        let cell_comp = crust.composition[v];
        // Use the dominant neighbor's composition as the "other side."
        // Look up the neighbor cell whose plate matches target_plate
        // and use its composition.
        let neighbor_comp = neighbors
            .iter()
            .find(|&&nb| assignment.cell_plate[nb as usize] as usize == target_plate)
            .map(|&nb| crust.composition[nb as usize])
            .unwrap_or_else(|| {
                assignment
                    .plate_composition(target_plate as u32)
                    .expect("INV: target plate has a baseline composition")
            });

        if best_normal > opts.convergence_threshold {
            // ── CONVERGENT — three composition cases ───────────────
            ctx.convergent_load[plate_v] += 1;
            ctx.total_boundary_load[plate_v] += 1;
            ctx.total_boundary_load[target_plate] += 1;

            let req_neighbors = if best_normal > opts.high_vel_threshold {
                opts.frontier_high_vel
            } else {
                opts.frontier_low_vel
            };
            let same_target_neighbors = neighbors
                .iter()
                .filter(|&&nb| assignment.cell_plate[nb as usize] as usize == target_plate)
                .count();

            match (cell_comp, neighbor_comp) {
                (Composition::Continental, Composition::Continental) => {
                    // **Cont-cont collision (orogeny, Himalayan-class).**
                    // Neither subducts. No plate ownership swap. Both
                    // cells thicken via granite + rhyolite accumulation;
                    // elevation drifts toward +9000 m. This is the ONLY
                    // path to extreme mountain heights in the sim.
                    let elev = crust.elevation_m[v];
                    let elev_factor =
                        (1.0 - (elev as f32 / 9000.0).clamp(0.0, 1.0)).max(0.05);
                    let dgranite = (4.0 * elev_factor) as u8;
                    let drhyolite = (2.0 * elev_factor) as u8;
                    ctx.next_layers[v].granite =
                        ctx.next_layers[v].granite.saturating_add(dgranite);
                    ctx.next_layers[v].rhyolite =
                        ctx.next_layers[v].rhyolite.saturating_add(drhyolite);
                    ctx.next_elev[v] = relax_elev(ctx.next_elev[v], 9000, K_ACTIVE);
                }
                (Composition::Oceanic | Composition::Island, Composition::Continental) => {
                    // **Oce-cont subduction (Mariana-class trench).**
                    // Aggressive: this is the primary driver of continental
                    // growth. Use frontier=2 here so subduction can
                    // produce ribbon-style retreat of oceanic margins —
                    // the macro-organic indenter pattern that gives plate
                    // boundaries their character. Age gate (≥40 Ma)
                    // prevents young oceanic from being eaten.
                    ctx.next_bending[v] = ctx.next_bending[v].saturating_add(20);
                    // Trench: drift toward -8000 m. Composition still oceanic
                    // unless swap fires below (handled by next_composition).
                    ctx.next_elev[v] = relax_elev(ctx.next_elev[v], -8000, K_ACTIVE);
                    let cell_age = crust.age_ma[v];
                    if cell_age >= 40 && same_target_neighbors >= req_neighbors {
                        let density_v = crust.density_kg_per_m3(v);
                        if density_v > 2750.0 {
                            ctx.next_plate[v] = target_plate as u32;
                            ctx.next_composition[v] = Composition::Continental;
                            ctx.next_layers[v].granite =
                                ctx.next_layers[v].granite.saturating_add(8);
                            ctx.next_age[v] = 0;
                            ctx.next_bending[v] = 0;
                            stats.total_swaps += 1;
                        }
                    }
                }
                (Composition::Continental, Composition::Oceanic | Composition::Island) => {
                    // **Continental side at an oce-cont subduction
                    // (Andean orogen).** Continental cell stays; gains
                    // arc magmatism (diorite intrusions) and rises toward
                    // the Andean target (+3500 m). Pre-arc cells (low
                    // volcanic activity) relax toward continental baseline.
                    ctx.next_volcanic_act[v] = ctx.next_volcanic_act[v].saturating_add(12);
                    if ctx.next_volcanic_act[v] > 60 {
                        ctx.next_layers[v].diorite =
                            ctx.next_layers[v].diorite.saturating_add(3);
                    }
                    let target = if ctx.next_volcanic_act[v] > 60 {
                        3500
                    } else {
                        baseline_elev(ctx.next_composition[v])
                    };
                    ctx.next_elev[v] = relax_elev(ctx.next_elev[v], target, K_ACTIVE);
                }
                (
                    Composition::Oceanic | Composition::Island,
                    Composition::Oceanic | Composition::Island,
                ) => {
                    // **Oce-oce subduction.** Older/denser side subducts.
                    // Overriding cell gains volcanic activity → eventually
                    // becomes Island, then Continental (arc maturation).
                    let cell_age = crust.age_ma[v];
                    let density_v = crust.density_kg_per_m3(v);
                    let density_target = crust
                        .layers
                        .get(
                            neighbors
                                .iter()
                                .find(|&&nb| {
                                    assignment.cell_plate[nb as usize] as usize == target_plate
                                })
                                .map(|&nb| nb as usize)
                                .unwrap_or(v),
                        )
                        .map(|l| l.density_kg_per_m3())
                        .unwrap_or(2900.0);
                    if cell_age >= 40
                        && density_v > density_target + 5.0
                        && same_target_neighbors >= req_neighbors
                    {
                        // This cell is the subducting one (trench side).
                        ctx.next_plate[v] = target_plate as u32;
                        ctx.next_bending[v] = ctx.next_bending[v].saturating_add(30);
                        ctx.next_age[v] = 0;
                        stats.total_swaps += 1;
                        // Trench: drift toward -7000 m on the subducting side.
                        ctx.next_elev[v] = relax_elev(ctx.next_elev[v], -7000, K_ACTIVE);
                    } else {
                        // This cell is on the overriding side (island arc).
                        ctx.next_volcanic_act[v] = ctx.next_volcanic_act[v].saturating_add(8);
                        if ctx.next_volcanic_act[v] >= ISLAND_THRESHOLD
                            && cell_comp == Composition::Oceanic
                        {
                            ctx.next_composition[v] = Composition::Island;
                            ctx.next_layers[v].diorite =
                                ctx.next_layers[v].diorite.saturating_add(6);
                        }
                        if ctx.next_volcanic_act[v] >= CONTINENT_THRESHOLD
                            && cell_comp == Composition::Island
                        {
                            ctx.next_composition[v] = Composition::Continental;
                            ctx.next_layers[v].granite =
                                ctx.next_layers[v].granite.saturating_add(8);
                        }
                        // Arc target: +800 m once it has matured into Island
                        // (island arc cap, e.g. Aleutians, Marianas arc).
                        // Cells that have matured all the way to Continental
                        // drift toward a modest +1500 m (post-arc highland);
                        // pre-arc oceanic cells stay near oceanic baseline.
                        let target = match ctx.next_composition[v] {
                            Composition::Island => 800,
                            Composition::Continental => 1500,
                            Composition::Oceanic => baseline_elev(Composition::Oceanic),
                        };
                        ctx.next_elev[v] = relax_elev(ctx.next_elev[v], target, K_ACTIVE);
                    }
                }
            }
        } else if best_normal < -opts.convergence_threshold {
            // ── DIVERGENT — three composition cases ────────────────
            ctx.total_boundary_load[plate_v] += 1;
            ctx.total_boundary_load[target_plate] += 1;

            match (cell_comp, neighbor_comp) {
                (Composition::Oceanic, Composition::Oceanic)
                | (Composition::Oceanic, Composition::Island)
                | (Composition::Island, Composition::Oceanic)
                | (Composition::Island, Composition::Island) => {
                    // **Mid-ocean ridge.** Fresh basalt + gabbro. Cell
                    // rises toward the MOR crest target (-2500 m) — well
                    // above abyssal floor (-4500) but ALWAYS underwater.
                    // Age resets to 0.
                    ctx.next_age[v] = 0;
                    ctx.next_layers[v].basalt =
                        ctx.next_layers[v].basalt.saturating_add(2);
                    ctx.next_layers[v].gabbro =
                        ctx.next_layers[v].gabbro.saturating_add(1);
                    ctx.next_elev[v] = relax_elev(ctx.next_elev[v], -2500, K_ACTIVE);
                    stats.total_divergent_resets += 1;
                }
                (Composition::Continental, Composition::Continental) => {
                    // **Cont-cont rift (East African Rift Valley).** Crust
                    // thins (granite/rhyolite erosion), rift_progress
                    // increments. When fully rifted (progress ≥
                    // RIFT_THRESHOLD), composition flips to Oceanic.
                    // Aulacogen reactivation: cells previously tagged as
                    // failed rifts accumulate at 1.5x rate (Nile,
                    // Mississippi, Amazon).
                    let rate = if crust.failed_rift_age_ma[v] > 0 { 12 } else { 8 };
                    ctx.next_rift_progress[v] = ctx.next_rift_progress[v].saturating_add(rate);
                    ctx.next_layers[v].granite = ctx.next_layers[v].granite.saturating_sub(1);
                    ctx.next_layers[v].rhyolite =
                        ctx.next_layers[v].rhyolite.saturating_sub(1);
                    // Rift valley: slight uplift to +200 m (rift shoulders
                    // bordering a subsided central graben). Stays above
                    // sea level while still continental; flips below once
                    // composition turns oceanic.
                    ctx.next_elev[v] = relax_elev(ctx.next_elev[v], 200, K_ACTIVE);
                    if ctx.next_rift_progress[v] >= RIFT_THRESHOLD {
                        // Mature rifts STAY mature (cap at threshold) so
                        // they accumulate into a severing line over many
                        // steps.
                        ctx.next_rift_progress[v] = RIFT_THRESHOLD;
                    }
                    stats.total_divergent_resets += 1;
                }
                (Composition::Continental, Composition::Oceanic | Composition::Island) => {
                    // **Continental shelf at oce-cont divergent
                    // (continental margin transitioning, e.g. South
                    // Atlantic margins).** Continental crust thins;
                    // composition may flip to Oceanic at threshold.
                    let rate = if crust.failed_rift_age_ma[v] > 0 { 15 } else { 10 };
                    ctx.next_rift_progress[v] =
                        ctx.next_rift_progress[v].saturating_add(rate);
                    ctx.next_layers[v].granite =
                        ctx.next_layers[v].granite.saturating_sub(2);
                    // Continental shelf transitioning: sag toward -1500 m
                    // as the crust thins and subsides below sea level.
                    ctx.next_elev[v] = relax_elev(ctx.next_elev[v], -1500, K_ACTIVE);
                    if ctx.next_rift_progress[v] >= RIFT_THRESHOLD {
                        ctx.next_rift_progress[v] = RIFT_THRESHOLD;
                    }
                    stats.total_divergent_resets += 1;
                }
                (Composition::Oceanic | Composition::Island, Composition::Continental) => {
                    // **Oceanic side at oce-cont divergent (continental
                    // rift transitioning to MOR, e.g. the oceanic flank
                    // of a young passive margin).** No rift_progress —
                    // already oceanic. Fresh-basalt accretion and MOR-class
                    // ridge target so this side doesn't sit at abyssal
                    // baseline while the continental side actively rifts.
                    ctx.next_age[v] = 0;
                    ctx.next_layers[v].basalt =
                        ctx.next_layers[v].basalt.saturating_add(2);
                    ctx.next_layers[v].gabbro =
                        ctx.next_layers[v].gabbro.saturating_add(1);
                    ctx.next_elev[v] = relax_elev(ctx.next_elev[v], -2500, K_ACTIVE);
                    stats.total_divergent_resets += 1;
                }
            }
        } else {
            // **Transform / sub-threshold normal velocity** (San Andreas,
            // Dead Sea, Alpine Fault). No vertical tectonic signal: the
            // boundary is strike-slip, so minimal relief. Without a
            // baseline pull, cells that were once at a convergent boundary
            // would stay locked at +9000 m forever; we relax slowly
            // (~5%/step, half-life ~14 steps = 70 Ma) so prior boundary
            // imprints decay back to the composition baseline as the
            // boundary regime moves on.
            ctx.total_boundary_load[plate_v] += 1;
            ctx.total_boundary_load[target_plate] += 1;
            let target = baseline_elev(ctx.next_composition[v]);
            ctx.next_elev[v] = relax_elev(ctx.next_elev[v], target, K_DECAY);
        }
    }

    // Swap buffers — current becomes next, in-place.
    assignment.cell_plate.copy_from_slice(ctx.next_plate);
    crust.composition.copy_from_slice(ctx.next_composition);
    crust.age_ma.copy_from_slice(ctx.next_age);
    crust.elevation_m.copy_from_slice(ctx.next_elev);
    crust.layers.copy_from_slice(ctx.next_layers);
    crust.bending.copy_from_slice(ctx.next_bending);
    crust.volcanic_act.copy_from_slice(ctx.next_volcanic_act);
    crust.rift_progress.copy_from_slice(ctx.next_rift_progress);

    // Age every cell by dt_ma. Saturating add so we don't overflow u16.
    let dt = opts.dt_ma as u16;
    for age in crust.age_ma.iter_mut() {
        *age = age.saturating_add(dt);
    }
}

/// Boundary lifecycle: smoothing, slab-pull, contiguity, rift propagation,
/// rift fork, periodic CC enforcement, plate death.
fn post_step(ctx: &mut StepContext) {
    let n_cells = ctx.assignment.cell_plate.len();
    let step = ctx.step;
    let opts = ctx.opts;

    // ── Phase 2: erosion pass ──────────────────────────────────────
    // pit-fill → flow_dirs → flow_accum → slope → stream-power +
    // thermal weathering → sediment transport. Runs once per macro-step,
    // BEFORE lifecycle / metrics so the snapshot reflects the eroded
    // surface. Operates on a single working copy of the elevation field;
    // sub-routines mutate it in-place and then we copy back to crust.
    {
        let mut elev = ctx.crust.elevation_m.clone();
        crate::drainage::fill_pits(&mut elev, ctx.adjacency);
        let flow_dirs = crate::drainage::compute_flow_dirs(&elev, ctx.adjacency);
        let flow_accum =
            crate::drainage::compute_flow_accum(&flow_dirs, &elev, ctx.adjacency);
        let slope = crate::erosion::compute_slope(&elev, ctx.adjacency);
        let dt_ma = opts.dt_ma as f32;
        let erosion_amt =
            crate::erosion::erosion_step(&mut elev, &flow_accum, &slope, dt_ma);
        crate::erosion::sediment_transport(&mut elev, &flow_dirs, &erosion_amt);
        ctx.crust.elevation_m = elev;
        // Resize the per-cell auxiliary fields if the registry grew (forks
        // don't add cells but we keep the invariant explicit).
        if ctx.crust.flow_accum.len() != n_cells {
            ctx.crust.flow_accum.resize(n_cells, 0);
        }
        if ctx.crust.lake_mask.len() != n_cells {
            ctx.crust.lake_mask.resize(n_cells, 0);
        }
        ctx.crust.flow_accum.copy_from_slice(&flow_accum);
        // lake_mask: interior sinks at land elevation (no outflow).
        for c in 0..n_cells {
            ctx.crust.lake_mask[c] = if flow_dirs[c] == u32::MAX
                && ctx.crust.elevation_m[c] > crate::drainage::SEA_LEVEL
            {
                1
            } else {
                0
            };
        }
    }

    // Majority-filter smoothing — every Nth step, not every step.
    // Running every step over-regularizes plate shapes into hexagonal
    // Voronoi cells; running every 4 steps lets ribbon-like growth
    // form between smoothing passes.
    if opts.smoothing_interval > 0 && step % opts.smoothing_interval == 0 {
        let _smoothed = smooth_majority(
            &mut ctx.assignment.cell_plate,
            ctx.crust,
            &ctx.assignment.plate_composition,
            ctx.adjacency,
        );
    }

    // Slab-pull feedback: amplify the angular velocity of plates with
    // active subducting boundaries. Total boundary length is the
    // denominator so smaller plates with many subducting edges
    // accelerate proportionally to their immediate-edge load.
    if opts.slab_pull_strength > 0.0 {
        for p in 0..ctx.current_motions.len() {
            let total = ctx.total_boundary_load[p];
            if total == 0 {
                continue;
            }
            let fraction = ctx.convergent_load[p] as f64 / total as f64;
            let boost = 1.0 + opts.slab_pull_strength * fraction;
            let m = &mut ctx.current_motions[p];
            m.omega = Vec3f::new(m.omega.x * boost, m.omega.y * boost, m.omega.z * boost);
        }
    }

    // Contiguity enforcement: absorb non-largest plate components.
    // This is the dominant cure for the "shattered orphan island" problem.
    if step % opts.contiguity_interval == 0 {
        let cstats = enforce_contiguity(
            &mut ctx.assignment.cell_plate,
            ctx.crust,
            &ctx.assignment.plate_composition,
            ctx.adjacency,
            opts.n_min_cells,
        );
        ctx.stats.total_absorbed_components += cstats.absorbed_components;
        ctx.stats.total_absorbed_cells += cstats.absorbed_cells;
    }

    // ── Rift propagation ───────────────────────────────────────────
    // Boundary-only rifting can never sever a plate (the rift sits at
    // the rim, removing it leaves the interior intact). Real continental
    // rifting propagates inward: stress weakens adjacent crust, which
    // then attracts more stress. We model this by giving continental
    // cells adjacent to mature rift cells a small per-step rift_progress
    // boost. Over many steps the rift line grows inland until it
    // severs the plate.
    if step > 0 && step % 2 == 0 {
        // Reuse the workspace rift_boost Vec — sized once in `evolve_ca`.
        ctx.rift_boost.fill(0);
        for v in 0..n_cells {
            if ctx.crust.rift_progress[v] >= RIFT_THRESHOLD / 2 {
                for &nb in ctx.adjacency.of(v as u32) {
                    let i = nb as usize;
                    if ctx.crust.composition[i] == Composition::Continental {
                        ctx.rift_boost[i] = ctx.rift_boost[i].saturating_add(3);
                    }
                }
            }
        }
        for i in 0..n_cells {
            let b = ctx.rift_boost[i];
            if b > 0 {
                ctx.crust.rift_progress[i] = ctx.crust.rift_progress[i].saturating_add(b);
                if ctx.crust.rift_progress[i] > RIFT_THRESHOLD {
                    ctx.crust.rift_progress[i] = RIFT_THRESHOLD;
                }
            }
        }
    }

    // ── M0.4: rift-fork lifecycle pass ─────────────────────────────
    // Snapshot of cells currently at rift maturity (rift_progress capped
    // at threshold). Mature cells accumulate across steps until they
    // form a severing line or the plate's stress regime changes.
    ctx.mature_rift_this_step.clear();
    for (i, &p) in ctx.crust.rift_progress.iter().enumerate() {
        if p >= RIFT_THRESHOLD {
            ctx.mature_rift_this_step.push(i as u32);
        }
    }
    // Group mature rift cells by parent plate, then try a fork on each.
    // Cells whose plate didn't sever get tagged aulacogen (M0.3).
    if !ctx.mature_rift_this_step.is_empty() {
        let mut by_plate: std::collections::BTreeMap<u32, Vec<u32>> =
            std::collections::BTreeMap::new();
        for &c in ctx.mature_rift_this_step.iter() {
            let pid = ctx.assignment.cell_plate[c as usize];
            by_plate.entry(pid).or_default().push(c);
        }
        for (parent_id, rift_cells) in by_plate {
            if ctx.assignment.plate(parent_id).is_none() {
                continue;
            }
            let outcome = crate::lifecycle::try_rift_fork(
                ctx.assignment,
                ctx.motions,
                ctx.crust,
                ctx.adjacency,
                ctx.vertices,
                parent_id,
                &rift_cells,
                step,
                50,
            );
            match outcome {
                crate::lifecycle::RiftForkOutcome::Forked { spawned } => {
                    ctx.stats.total_fork_spawns += spawned.len() as u32;
                    // Rift-fork spawns produce a 0x10 SPAWN record via the
                    // existing registry-diff loop. We do not push a
                    // PASSIVE_SPLIT qualifier here — bare 0x10 means
                    // "rift fork" until paired with 0x15.
                    let _ = spawned;
                }
                crate::lifecycle::RiftForkOutcome::DidNotSever => {
                    // Rift line hasn't grown enough to sever yet —
                    // leave the cells mature so the line accumulates
                    // across subsequent steps. They'll be tested again
                    // next step.
                }
                crate::lifecycle::RiftForkOutcome::Cooldown => {
                    // Aulacogen path. Emit a 0x16 FAILED_RIFT lifecycle
                    // event so the viewer counter ticks up. Use the
                    // lowest-id rift cell as the representative location
                    // (deterministic; rift_cells is already sorted by
                    // its by_plate group walk).
                    if let Some(&rep) = rift_cells.first() {
                        if let Some(enc) = ctx.frame_encoder.as_deref_mut() {
                            enc.push_event(crate::frame_stream::FrameEvent::FailedRift {
                                plate_id: parent_id,
                                representative_cell: rep,
                            });
                        }
                    }
                    // Parent on cooldown from a previous fork. Mark
                    // these cells aulacogen so future reactivation is
                    // 1.5x faster. Reset rift_progress.
                    let current_avg_age: u16 = {
                        let sum: u64 = rift_cells
                            .iter()
                            .map(|&c| ctx.crust.age_ma[c as usize] as u64)
                            .sum();
                        (sum / rift_cells.len().max(1) as u64) as u16
                    };
                    ctx.crust
                        .mark_failed_rift(&rift_cells, current_avg_age.max(1));
                    // One discrete failed-rift incident per cooldown-branch
                    // entry, matching the FrameEvent::FailedRift event
                    // semantics (rising-edge, not per-cell-per-step).
                    ctx.stats.total_failed_rifts += 1;
                }
            }
        }
        ctx.mature_rift_this_step.clear();
    }

    // ── B3: per-step Wilson-cycle age increment on all live plates ─
    // Bump `age_since_last_split` by dt_ma every macro-step. Counter
    // resets to 0 inside `trigger_age_based_splits` when a split fires.
    {
        let dt = opts.dt_ma as u16;
        for slot in ctx.assignment.plates.iter_mut() {
            if let Some(p) = slot.as_mut() {
                p.age_since_last_split = p.age_since_last_split.saturating_add(dt);
            }
        }
    }

    // ── M0.5: periodic CC enforcement (passive splits) ─────────────
    // Every 16 macro-steps, BFS every live plate. Plates that became
    // disconnected (e.g. Anatolia pinched off Eurasia by convergent
    // pressure) fork passively.
    if step > 0 && step % 16 == 0 {
        // Snapshot the plate registry length before the pass so we can
        // attribute any newly-allocated plate ids to passive splits and
        // emit a 0x15 PASSIVE_SPLIT lifecycle event per child. Children
        // also produce a 0x10 SPAWN diff record via the registry-diff loop.
        let plates_len_before = ctx.assignment.plates.len();
        let passive_spawns = crate::lifecycle::enforce_one_cc_per_plate(
            ctx.assignment,
            ctx.motions,
            ctx.adjacency,
            step,
        );
        ctx.stats.total_passive_splits += passive_spawns;
        if let Some(enc) = ctx.frame_encoder.as_deref_mut() {
            for id in plates_len_before..ctx.assignment.plates.len() {
                if let Some(child) = ctx.assignment.plates[id].as_ref() {
                    let parent_id = child.parent_id.unwrap_or(u32::MAX);
                    enc.push_event(crate::frame_stream::FrameEvent::PassiveSplit {
                        parent_id,
                        child_id: id as u32,
                    });
                }
            }
        }
    }

    // ── B3: age-based Wilson-cycle passive split trigger ──────────
    // Runs every macro-step (cheap: skips plates that fail any of the
    // eligibility gates up-front). Fires on a deterministic 1%/step roll
    // per eligible plate. The newly-spawned children produce 0x10 SPAWN
    // diff records via the registry-diff loop; we also emit a 0x15
    // PASSIVE_SPLIT qualifier per child so the viewer can distinguish
    // age-triggered from CC-pinch passive splits.
    {
        let plates_len_before = ctx.assignment.plates.len();
        let _fired = crate::lifecycle::trigger_age_based_splits(
            ctx.assignment,
            ctx.motions,
            ctx.crust,
            ctx.adjacency,
            ctx.vertices,
            opts.master,
            step,
        );
        if let Some(enc) = ctx.frame_encoder.as_deref_mut() {
            for id in plates_len_before..ctx.assignment.plates.len() {
                if let Some(child) = ctx.assignment.plates[id].as_ref() {
                    let parent_id = child.parent_id.unwrap_or(u32::MAX);
                    enc.push_event(crate::frame_stream::FrameEvent::PassiveSplit {
                        parent_id,
                        child_id: id as u32,
                    });
                }
            }
        }
    }

    // ── B4: INV-6 enforcement — no fully-enclosed plates ───────────
    // A plate whose every cross-plate neighbour points to the same
    // single other plate is geologically unphysical. Accrete it into
    // the enclosing plate.
    crate::lifecycle::enforce_inv6(ctx.assignment, ctx.motions, ctx.adjacency);
    #[cfg(debug_assertions)]
    debug_assert!(
        crate::lifecycle::check_inv6(ctx.assignment, ctx.adjacency).is_empty(),
        "INV-6 violated after enforce_inv6",
    );

    // ── M0.6: plate death (hard zero) ──────────────────────────────
    // Any live plate whose cell count dropped to zero this step gets
    // retired. Maintains INV-1 (every live plate has ≥1 cell). Common
    // path: micro-plate gets fully absorbed by convergent neighbors
    // via the CA's swap rules.
    retire_zero_cell_plates(
        ctx.assignment,
        ctx.motions,
        ctx.stats,
        ctx.frame_encoder.as_deref_mut(),
    );

    // ── M0.12: hotspot per-step pass ───────────────────────────────
    // Runs AFTER plate death so volcanic marks land on live plates, and
    // BEFORE motion evolution so the freshly-bumped volcanic_act values
    // could feed any downstream torque heuristics in the future. The
    // step itself filters inactive hotspots cheaply, then for each
    // active one finds the overhead cell and bumps `volcanic_act`.
    ctx.hotspots
        .step(ctx.step, ctx.vertices, &ctx.assignment.cell_plate, ctx.crust);

    // ── M0.7: motion evolution (opt-in) ────────────────────────────
    // Runs AFTER plate death so retired plates aren't integrated, and
    // BEFORE the next macro step starts so the freshly-updated motions
    // drive the next CA pass. Gated by `enable_motion_evolution`; when
    // false the entire block is skipped and behavior is bit-identical
    // to the pre-M0.7 baseline.
    // ── M0.15: per-step metric sample (READ-ONLY) ──────────────────
    // Runs near the end of post_step, AFTER lifecycle/death/hotspot
    // passes so the snapshot reflects the step's final state. Read-only
    // with respect to sim state so determinism is preserved.
    ctx.metrics.sample(
        ctx.step,
        ctx.assignment,
        ctx.crust,
        ctx.motions,
        ctx.vertices,
        ctx.adjacency,
        None,
    );

    if ctx.opts.enable_motion_evolution {
        evolve_motion(
            ctx.assignment,
            ctx.motions,
            ctx.crust,
            ctx.adjacency,
            ctx.vertices,
            &ctx.opts.motion_evolution,
            ctx.motion_history,
            &mut ctx.stats.motion,
        );
        // Refresh the live-motions cache the next step's CA pass reads
        // from. The cache mirrors `motions` slot-for-slot (None → zero ω).
        for (i, m) in ctx.motions.iter().enumerate() {
            if let Some(slot) = ctx.current_motions.get_mut(i) {
                *slot = m.unwrap_or(PlateMotion {
                    omega: Vec3f::new(0.0, 0.0, 0.0),
                });
            }
        }
    }

    // ── M0.10: per-step MOR axis update + age striping ────────────────
    // Cells on/near each live MOR axis get age reset (axis) or striped
    // (within accretion band) based on arc distance × 2 / spreading_rate.
    // Runs before the frame_encoder hook so encoded state reflects ages.
    //
    // **B2:** after `age_step` for each ridge, run `death_check` and flip
    // `is_active=false` on ridges that should retire. Subsequent
    // `live_ridges()` iteration skips them. We borrow the plates slice
    // up-front so the `plate_alive` closure doesn't conflict with the
    // outer `&mut MorRegistry` borrow.
    if let Some(mors) = ctx.mor_registry.as_deref_mut() {
        // Snapshot per-plate liveness (cheap; one Bool per slot). Avoids
        // re-borrowing `ctx.assignment` inside the closure across each
        // `death_check` call.
        let plate_live: Vec<bool> = ctx.assignment.plates.iter().map(|p| p.is_some()).collect();
        for (_, ridge) in mors.ridges_mut() {
            if !ridge.is_active {
                continue;
            }
            ridge.age_step(ctx.vertices, &ctx.assignment.cell_plate, ctx.crust);
            let current_div = ridge.spreading_rate as f32;
            let should_die = ridge.death_check(
                |id| plate_live.get(id as usize).copied().unwrap_or(false),
                current_div,
            );
            if should_die {
                ridge.is_active = false;
            }
        }
    }

    // ── A1: binary frame-stream emission ───────────────────────────────
    // The encoder is READ-ONLY w.r.t. sim state — running with `Some(...)`
    // produces a byte-identical world.bin for the same seed and never
    // perturbs the deterministic sim path.
    if let Some(enc) = ctx.frame_encoder.as_deref_mut() {
        // Task 1.1 — per-frame BOUNDARY_POLYLINES (0x30). Compute the
        // current-frame boundary classification + polylines so the viewer
        // can render boundary lines that match cell ownership at this
        // exact macro-step. Cost: O(|boundary_edges|) per frame. Skipped
        // when the encoder is absent (the only `if Some` branch we're
        // already inside).
        let classification = crate::boundaries::classify_boundaries(
            ctx.vertices,
            ctx.assignment,
            ctx.motions,
        );
        let polylines = crate::boundaries::extract_polylines(
            ctx.assignment,
            ctx.vertices,
            &classification,
        );
        // write_polylines stages the bytes; the next write_frame call
        // drains them into that frame's payload.
        let _ = enc.write_polylines(&polylines);

        // Frame index = the macro-step we just completed. frame 0 is the
        // initial-state block written before the loop, so the first
        // encoder-written frame here is step 0 + 1 = ... actually we use
        // ctx.step + 1 so frame_idx 0 corresponds to the pre-loop snapshot
        // and per-step records start at 1. Keyframe stride still anchors
        // off frame_idx % stride == 0.
        let frame_idx = ctx.step + 1;
        enc.write_frame(
            frame_idx,
            ctx.assignment,
            ctx.crust,
            ctx.motions,
            ctx.mor_registry.as_deref(),
        );
    }
}

/// Retire any live plate whose cell count dropped to zero this step.
/// Maintains INV-1: every live plate has ≥1 cell. Setting the slot to
/// `None` keeps the id permanently retired (ids never reuse).
fn retire_zero_cell_plates(
    assignment: &mut PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    stats: &mut EvolutionStats,
    mut encoder: Option<&mut crate::frame_stream::FrameEncoder>,
) {
    let mut counts = vec![0u32; assignment.plates.len()];
    for &id in &assignment.cell_plate {
        counts[id as usize] += 1;
    }
    for (i, c) in counts.iter().enumerate() {
        if *c == 0 && assignment.plates[i].is_some() {
            assignment.retire(i as u32);
            motions[i] = None;
            stats.total_plate_deaths += 1;
            if let Some(enc) = encoder.as_deref_mut() {
                enc.push_event(crate::frame_stream::FrameEvent::Death {
                    plate_id: i as u32,
                    reason: crate::frame_stream::DeathReason::ZeroCells,
                });
            }
        }
    }
}
