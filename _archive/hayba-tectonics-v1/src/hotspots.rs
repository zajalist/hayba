//! Mantle hotspots — fixed plumes in the mantle frame that punch through
//! overlying plates and leave volcanic chains (Hawaii-Emperor, Yellowstone,
//! Iceland). Created at sim init; drift slowly (~1 cm/yr) over the
//! lifetime; activate only inside each one's life window.
//!
//! **Model.** The mantle frame is treated as fixed for CA-bookkeeping
//! purposes: every macro-step we move each hotspot a tiny tangential step
//! and look up the surface cell currently directly above it. That cell's
//! `volcanic_act` is bumped. Because plates drift independently across
//! many steps, sequential bumps land on different cells of the overhead
//! plate — a chain.
//!
//! Each hotspot has a birth and a finite lifespan (M0 default: 100–200
//! Ma, i.e. 20–40 macro-steps at dt=5). Hotspots outside their active
//! window are completely skipped (cheap fast-path).
//!
//! LIP (Large Igneous Province) flagging is set at init — `is_lip = true`
//! for a small fraction of hotspots (default 7 %). LIPs don't change
//! behaviour in M0.12; the flag is consumed downstream in M0.13.

use crate::mesh::Vec3f;
use crate::sphere_geom::project_to_tangent_plane;
use hayba_seeds::{derive_scope, MasterSeed, Scope, SeedStream};

/// Stream offset for the hotspots sub-scope inside `Scope::Tectonic`.
/// Picked once; never renumber — it's part of the determinism contract.
const HOTSPOTS_STREAM_SALT: u64 = 0x40_70_5E_07;

/// Stream offset for the M0.13 LIP burst sub-scope. Mixed with the hotspot
/// id so each LIP draws its own deterministic radius. Never renumber.
const LIP_BURST_STREAM_SALT: u64 = 0x1_19_E0;

/// LIP burst constants — kept here next to the burst code so the semantics
/// stay self-contained.
const LIP_BURST_VOLCANIC_BUMP: u8 = 200;
const LIP_BURST_ELEVATION_BUMP: i32 = 600;
const LIP_BURST_RADIUS_LO: f64 = 0.10;
const LIP_BURST_RADIUS_HI: f64 = 0.25;

#[derive(Debug, Clone)]
pub struct Hotspot {
    pub id: u32,
    /// Position in the mantle reference frame (unit sphere). Drifts slowly.
    pub mantle_position: Vec3f,
    /// Per-step mantle drift, scale ~1e-7 rad/Myr (≈ 1 cm/yr).
    pub drift_velocity: Vec3f,
    /// First macro-step this hotspot becomes active.
    pub birth_macro_step: u32,
    /// Lifespan in macro-steps after birth. Outside this window, dormant.
    pub lifespan_steps: u32,
    /// LIP flag — 7% chance set at init.
    pub is_lip: bool,
}

#[derive(Debug)]
pub struct HotspotsState {
    pub hotspots: Vec<Hotspot>,
    /// World master seed — threaded through to per-LIP radius derivation so
    /// two worlds with different master seeds get different burst radii even
    /// when hotspot ids collide.
    pub master: MasterSeed,
}

#[derive(Debug, Clone)]
pub struct HotspotsOptions {
    /// Default 30; can be overridden via config.
    pub count: u32,
    /// 0.0..1.0 fraction of hotspots that are flagged LIP. Default 0.07.
    pub lip_fraction: f64,
    /// Mantle drift magnitude per macro-step (rad). Default 5e-8 (~1 cm/yr
    /// at one step = 5 Ma).
    pub drift_per_step: f64,
    /// Lifespan range in macro-steps (inclusive low, exclusive high).
    /// Default (20, 40) → 100-200 Ma at dt=5.
    pub lifespan_steps_range: (u32, u32),
    /// Window over which birth_macro_step is sampled uniformly. Defaults
    /// to the standard 250-step macro horizon.
    pub total_macro_steps: u32,
    /// Per-step volcanic-activity bump applied to the cell currently above
    /// an active hotspot. Saturates at 255.
    pub per_step_intensity: u8,
}

impl Default for HotspotsOptions {
    fn default() -> Self {
        Self {
            count: 30,
            lip_fraction: 0.07,
            drift_per_step: 5e-8,
            lifespan_steps_range: (20, 40),
            total_macro_steps: 250,
            per_step_intensity: 4,
        }
    }
}

/// Uniform `f64` in `[0, 1)` from a SeedStream draw.
#[inline]
fn next_unit(s: &mut SeedStream) -> f64 {
    // 53-bit mantissa-uniform; matches the conventional rand crate path.
    (s.next_u64() >> 11) as f64 * (1.0 / ((1u64 << 53) as f64))
}

/// Sample a point uniformly on the unit sphere.
fn sample_unit_sphere(s: &mut SeedStream) -> Vec3f {
    let z = next_unit(s) * 2.0 - 1.0;
    let theta = next_unit(s) * std::f64::consts::TAU;
    let r = (1.0 - z * z).max(0.0).sqrt();
    Vec3f::new(r * theta.cos(), r * theta.sin(), z)
}

/// Sample a unit tangent vector at `at` (on the unit sphere) and scale by
/// `magnitude`. Used to give each hotspot a slow random mantle drift.
fn sample_tangent(at: Vec3f, magnitude: f64, s: &mut SeedStream) -> Vec3f {
    // Draw a generic free vector, project to the tangent plane, normalize.
    // Retry once (deterministically) if the projection is degenerate; the
    // probability is astronomically low but the fallback keeps the seed
    // path total.
    for _ in 0..4 {
        let raw = Vec3f::new(
            next_unit(s) * 2.0 - 1.0,
            next_unit(s) * 2.0 - 1.0,
            next_unit(s) * 2.0 - 1.0,
        );
        let tan = project_to_tangent_plane(at, raw);
        if tan.dot(tan) > 1e-12 {
            let unit = tan.normalize_or(Vec3f::new(0.0, 0.0, 0.0));
            return unit.scale(magnitude);
        }
    }
    Vec3f::new(0.0, 0.0, 0.0)
}

impl HotspotsState {
    pub fn new(master: MasterSeed, opts: &HotspotsOptions) -> Self {
        let seed = derive_scope(master, Scope::Tectonic).wrapping_add(HOTSPOTS_STREAM_SALT);
        let mut stream = SeedStream::new(seed);

        let mut hotspots = Vec::with_capacity(opts.count as usize);
        let (lo, hi) = opts.lifespan_steps_range;
        let life_span_width = hi.saturating_sub(lo).max(1);
        let birth_window = opts.total_macro_steps.max(1);

        for id in 0..opts.count {
            // Order here is the determinism contract — never reorder these
            // draws or seed-identical worlds will diverge.
            let mantle_position = sample_unit_sphere(&mut stream);
            let drift_velocity = sample_tangent(mantle_position, opts.drift_per_step, &mut stream);
            let birth_macro_step = (stream.next_below(birth_window as u64)) as u32;
            let lifespan_steps = lo + (stream.next_below(life_span_width as u64)) as u32;
            let is_lip = next_unit(&mut stream) < opts.lip_fraction;
            hotspots.push(Hotspot {
                id,
                mantle_position,
                drift_velocity,
                birth_macro_step,
                lifespan_steps,
                is_lip,
            });
        }

        Self { hotspots, master }
    }

    /// Apply one macro-step: drift each active hotspot, find the cell on
    /// the plate currently overhead, mark it with volcanic activity.
    /// Active = `birth_macro_step <= macro_step < birth_macro_step +
    /// lifespan_steps`.
    pub fn step(
        &mut self,
        macro_step: u32,
        vertices: &[Vec3f],
        _cell_plate: &[u32],
        crust: &mut crate::crust_state::CrustState,
    ) {
        if vertices.is_empty() {
            return;
        }
        // Sane per-step intensity. Kept here (not threaded via opts) so the
        // step path stays cheap and the constant lives next to the
        // semantics.
        const BUMP: u8 = 4;

        for h in self.hotspots.iter_mut() {
            // Cheap fast-path: skip inactive hotspots before touching the
            // O(N) nearest-cell scan.
            let active = macro_step >= h.birth_macro_step
                && macro_step < h.birth_macro_step.saturating_add(h.lifespan_steps);
            if !active {
                continue;
            }

            // Nearest vertex on the unit sphere by max dot product.
            let pos = h.mantle_position;
            let mut best_dot = f64::MIN;
            let mut best_idx: usize = 0;
            for (i, v) in vertices.iter().enumerate() {
                let d = v.x * pos.x + v.y * pos.y + v.z * pos.z;
                if d > best_dot {
                    best_dot = d;
                    best_idx = i;
                }
            }

            // M0.13: LIP burst at birth. Fires once, on the first active
            // macro_step (== birth_macro_step). Marks a wide patch (50-200
            // cells) of volcanic + uplift + LIP-tagged crust, then primes
            // the rift-progress counter on continental cells in the patch.
            // Non-LIP hotspots and post-birth LIP steps fall through to the
            // normal one-cell volcanic bump below.
            let is_lip_birth = h.is_lip && macro_step == h.birth_macro_step;
            if is_lip_birth {
                lip_burst(self.master, h.id, macro_step, best_idx, vertices, crust);
            } else {
                // Bump volcanic activity at the overhead cell (saturating).
                let cur = crust.volcanic_act[best_idx];
                crust.volcanic_act[best_idx] = cur.saturating_add(BUMP);
            }

            // Drift in the mantle frame. Project the velocity onto the
            // tangent plane at the current position so we stay on the
            // sphere over many steps.
            let prev = h.mantle_position;
            let tan_drift = project_to_tangent_plane(prev, h.drift_velocity);
            let stepped = Vec3f::new(
                prev.x + tan_drift.x,
                prev.y + tan_drift.y,
                prev.z + tan_drift.z,
            );
            h.mantle_position = stepped.normalize_or(prev);
        }
    }
}

/// Fire a single LIP flood-basalt burst centered on `center_idx`. Marks all
/// cells within a deterministic per-LIP radius `r ∈ [0.10, 0.25]` rad with
/// a huge volcanic_act bump, +600 m elevation, the LIP age tag, and primes
/// continental cells in the patch with a rift_progress boost (the CAMP /
/// Deccan rift-trigger coupling).
///
/// Determinism: radius is drawn from a SeedStream seeded with
/// `Scope::Tectonic + 0x1_19_E0 + hotspot_id` so two seed-identical worlds
/// pick the same radii in the same order.
fn lip_burst(
    master: MasterSeed,
    hotspot_id: u32,
    macro_step: u32,
    center_idx: usize,
    vertices: &[Vec3f],
    crust: &mut crate::crust_state::CrustState,
) {
    // Per-LIP deterministic radius. The seed mixes the world master seed,
    // the Tectonic scope salt, the LIP burst sub-scope salt, and the hotspot
    // id so each LIP picks the same radius across reruns of the same world,
    // but different worlds (different master seeds) get different radii.
    let seed = derive_scope(master, Scope::Tectonic)
        .wrapping_add(LIP_BURST_STREAM_SALT)
        .wrapping_add(hotspot_id as u64);
    let mut s = SeedStream::new(seed);
    let u = next_unit(&mut s);
    let r = LIP_BURST_RADIUS_LO + u * (LIP_BURST_RADIUS_HI - LIP_BURST_RADIUS_LO);
    // Convert to a dot-product threshold: arc_distance < r iff cos(arc) > cos(r).
    let cos_r = r.cos();
    let center = vertices[center_idx];

    // World-age stamp for lip_age_ma. Use macro_step (Ma-equivalent under
    // dt_ma=5: macro_step*5 is the world age) clamped to u16. macro_step
    // alone (without dt) is fine — we just need a deterministic monotonic
    // tag that's > 0 for "burst happened".
    let lip_age: u16 = (macro_step as u32).saturating_add(1).min(u16::MAX as u32) as u16;

    // Collect burst cells in a single pass (no BFS / adjacency needed —
    // the icosphere is reasonably uniform, so arc-distance is a clean
    // patch). Cells with dot >= cos_r are inside the cap.
    let mut burst_cells: Vec<u32> = Vec::with_capacity(64);
    for (i, v) in vertices.iter().enumerate() {
        let d = v.x * center.x + v.y * center.y + v.z * center.z;
        if d >= cos_r {
            burst_cells.push(i as u32);
        }
    }
    // Center is always included even on very small radii / coarse meshes.
    if !burst_cells.iter().any(|&c| c as usize == center_idx) {
        burst_cells.push(center_idx as u32);
    }

    // Apply bumps to every burst cell.
    for &c in &burst_cells {
        let i = c as usize;
        crust.volcanic_act[i] = crust.volcanic_act[i].saturating_add(LIP_BURST_VOLCANIC_BUMP);
        let new_elev = (crust.elevation_m[i] as i32 + LIP_BURST_ELEVATION_BUMP)
            .clamp(-11000, 9000);
        crust.elevation_m[i] = new_elev as i16;
        crust.lip_age_ma[i] = lip_age;
    }

    // Prime continental cells with a rift_progress impulse — CAMP-Pangaea /
    // Deccan-India "flood basalts kick-start a rift" mechanism. Delegated
    // to the lifecycle helper so the impulse magnitude lives in one place.
    let _ = crate::lifecycle::apply_lip_rift_stress(crust, &burst_cells);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crust_state::{CrustOptions, CrustState};
    use crate::mesh::Icosphere;
    use crate::plates::{BuildOptions, PlateAssignment};

    fn tiny_world(seed: u64, level: u32) -> (Icosphere, CrustState) {
        let sphere = Icosphere::new(level);
        let mut plates = PlateAssignment::build(
            MasterSeed(seed),
            &sphere,
            BuildOptions {
                plate_count: 8,
                ..BuildOptions::default()
            },
        );
        let seed_positions: Vec<Vec3f> = plates
            .plates
            .iter()
            .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default())
            .collect();
        let crust = CrustState::initial(
            MasterSeed(seed),
            &sphere.vertices,
            &mut plates,
            &seed_positions,
            CrustOptions::default(),
        );
        (sphere, crust)
    }

    #[test]
    fn default_count_is_30() {
        let h = HotspotsState::new(MasterSeed(42), &HotspotsOptions::default());
        assert_eq!(h.hotspots.len(), 30);
    }

    #[test]
    fn drift_is_deterministic() {
        let a = HotspotsState::new(MasterSeed(1234), &HotspotsOptions::default());
        let b = HotspotsState::new(MasterSeed(1234), &HotspotsOptions::default());
        assert_eq!(a.hotspots.len(), b.hotspots.len());
        for (ha, hb) in a.hotspots.iter().zip(b.hotspots.iter()) {
            assert_eq!(ha.mantle_position.x.to_bits(), hb.mantle_position.x.to_bits());
            assert_eq!(ha.mantle_position.y.to_bits(), hb.mantle_position.y.to_bits());
            assert_eq!(ha.mantle_position.z.to_bits(), hb.mantle_position.z.to_bits());
            assert_eq!(ha.drift_velocity.x.to_bits(), hb.drift_velocity.x.to_bits());
            assert_eq!(ha.drift_velocity.y.to_bits(), hb.drift_velocity.y.to_bits());
            assert_eq!(ha.drift_velocity.z.to_bits(), hb.drift_velocity.z.to_bits());
            assert_eq!(ha.birth_macro_step, hb.birth_macro_step);
            assert_eq!(ha.lifespan_steps, hb.lifespan_steps);
            assert_eq!(ha.is_lip, hb.is_lip);
        }
    }

    #[test]
    fn lip_fraction_roughly_correct() {
        let opts = HotspotsOptions {
            count: 1000,
            ..HotspotsOptions::default()
        };
        let h = HotspotsState::new(MasterSeed(7), &opts);
        let n_lip = h.hotspots.iter().filter(|h| h.is_lip).count();
        assert!(
            (50..=90).contains(&n_lip),
            "lip count {} outside [50, 90] for lip_fraction=0.07 of 1000",
            n_lip
        );
    }

    #[test]
    fn dormant_outside_life_window() {
        let (sphere, mut crust) = tiny_world(42, 3);
        // Hand-roll a single hotspot with known birth/lifespan.
        let pos = sphere.vertices[0];
        let mut state = HotspotsState {
            hotspots: vec![Hotspot {
                id: 0,
                mantle_position: pos,
                drift_velocity: Vec3f::new(0.0, 0.0, 0.0),
                birth_macro_step: 10,
                lifespan_steps: 5,
                is_lip: false,
            }],
            master: MasterSeed(42),
        };
        let cell_plate = vec![0u32; sphere.vertices.len()];
        let baseline: u64 = crust.volcanic_act.iter().map(|&x| x as u64).sum();

        // Step 4: before birth — no mark.
        state.step(4, &sphere.vertices, &cell_plate, &mut crust);
        let after_4: u64 = crust.volcanic_act.iter().map(|&x| x as u64).sum();
        assert_eq!(after_4, baseline, "step 4 (before birth) must not mark");

        // Step 12: inside window — should mark.
        state.step(12, &sphere.vertices, &cell_plate, &mut crust);
        let after_12: u64 = crust.volcanic_act.iter().map(|&x| x as u64).sum();
        assert!(after_12 > baseline, "step 12 (active) must mark");

        // Step 20: past death — must not mark further.
        let pre_20 = after_12;
        state.step(20, &sphere.vertices, &cell_plate, &mut crust);
        let after_20: u64 = crust.volcanic_act.iter().map(|&x| x as u64).sum();
        assert_eq!(after_20, pre_20, "step 20 (past death) must not mark");
    }

    #[test]
    fn lip_fires_burst_at_birth() {
        // Use level 6 (~40k vertices) so even the smallest LIP radius
        // (0.10 rad) covers ≥50 cells.
        let (sphere, mut crust) = tiny_world(42, 6);
        let pos = sphere.vertices[0];
        let mut state = HotspotsState {
            hotspots: vec![Hotspot {
                id: 0,
                mantle_position: pos,
                drift_velocity: Vec3f::new(0.0, 0.0, 0.0),
                birth_macro_step: 5,
                lifespan_steps: 10,
                is_lip: true,
            }],
            master: MasterSeed(42),
        };
        let cell_plate = vec![0u32; sphere.vertices.len()];
        let baseline_elev = crust.elevation_m.clone();

        state.step(5, &sphere.vertices, &cell_plate, &mut crust);

        // Count cells whose volcanic_act got the burst bump (≥200, the LIP
        // intensity floor — far above the per-step BUMP of 4).
        let n_burst = crust.volcanic_act.iter().filter(|&&v| v >= 200).count();
        assert!(
            n_burst >= 50,
            "LIP burst should mark >= 50 cells, got {}",
            n_burst
        );
        // Elevation bumped on at least some cells (saturating clamp may
        // hide pure equality, so just check any positive delta).
        let n_uplift = crust
            .elevation_m
            .iter()
            .zip(baseline_elev.iter())
            .filter(|(a, b)| **a > **b)
            .count();
        assert!(n_uplift > 0, "LIP burst should uplift cells");
    }

    #[test]
    fn non_lip_does_not_burst() {
        let (sphere, mut crust) = tiny_world(42, 6);
        let pos = sphere.vertices[0];
        let mut state = HotspotsState {
            hotspots: vec![Hotspot {
                id: 0,
                mantle_position: pos,
                drift_velocity: Vec3f::new(0.0, 0.0, 0.0),
                birth_macro_step: 5,
                lifespan_steps: 10,
                is_lip: false,
            }],
            master: MasterSeed(42),
        };
        let cell_plate = vec![0u32; sphere.vertices.len()];

        state.step(5, &sphere.vertices, &cell_plate, &mut crust);

        // No cell should reach the burst threshold; only the single
        // overhead cell got a tiny BUMP of 4.
        let n_burst = crust.volcanic_act.iter().filter(|&&v| v >= 200).count();
        assert_eq!(n_burst, 0, "non-LIP hotspot must not produce a burst");
        let n_marked = crust.volcanic_act.iter().filter(|&&v| v > 0).count();
        assert!(
            n_marked <= 2,
            "non-LIP hotspot should mark ~1 cell, got {}",
            n_marked
        );
    }

    #[test]
    fn lip_burst_sets_lip_age_ma() {
        let (sphere, mut crust) = tiny_world(42, 6);
        let pos = sphere.vertices[0];
        let mut state = HotspotsState {
            hotspots: vec![Hotspot {
                id: 0,
                mantle_position: pos,
                drift_velocity: Vec3f::new(0.0, 0.0, 0.0),
                birth_macro_step: 5,
                lifespan_steps: 10,
                is_lip: true,
            }],
            master: MasterSeed(42),
        };
        let cell_plate = vec![0u32; sphere.vertices.len()];

        state.step(5, &sphere.vertices, &cell_plate, &mut crust);

        let n_tagged = crust.lip_age_ma.iter().filter(|&&v| v > 0).count();
        assert!(n_tagged >= 50, "LIP burst should tag >= 50 cells with lip_age_ma, got {}", n_tagged);
    }

    #[test]
    fn lip_on_continental_crust_boosts_rift_progress() {
        let (sphere, mut crust) = tiny_world(42, 6);
        let n = sphere.vertices.len();
        // Force every cell continental with zero rift_progress so we can
        // see the +100 impulse cleanly.
        for i in 0..n {
            crust.composition[i] = crate::crust_state::Composition::Continental;
            crust.rift_progress[i] = 0;
        }
        let pos = sphere.vertices[0];
        let mut state = HotspotsState {
            hotspots: vec![Hotspot {
                id: 0,
                mantle_position: pos,
                drift_velocity: Vec3f::new(0.0, 0.0, 0.0),
                birth_macro_step: 5,
                lifespan_steps: 10,
                is_lip: true,
            }],
            master: MasterSeed(42),
        };
        let cell_plate = vec![0u32; n];

        state.step(5, &sphere.vertices, &cell_plate, &mut crust);

        let n_boosted = crust.rift_progress.iter().filter(|&&p| p >= 100).count();
        assert!(
            n_boosted >= 50,
            "LIP on continental crust should boost rift_progress on >= 50 cells, got {}",
            n_boosted
        );
    }

    #[test]
    fn lip_on_oceanic_crust_does_not_boost_rift_progress() {
        let (sphere, mut crust) = tiny_world(42, 6);
        let n = sphere.vertices.len();
        // Force every cell oceanic.
        for i in 0..n {
            crust.composition[i] = crate::crust_state::Composition::Oceanic;
            crust.rift_progress[i] = 0;
        }
        let pos = sphere.vertices[0];
        let mut state = HotspotsState {
            hotspots: vec![Hotspot {
                id: 0,
                mantle_position: pos,
                drift_velocity: Vec3f::new(0.0, 0.0, 0.0),
                birth_macro_step: 5,
                lifespan_steps: 10,
                is_lip: true,
            }],
            master: MasterSeed(42),
        };
        let cell_plate = vec![0u32; n];

        state.step(5, &sphere.vertices, &cell_plate, &mut crust);

        // The LIP fires (volcanic bump should be visible) but rift_progress
        // must stay zero everywhere — oceanic cells don't get the impulse.
        let n_burst = crust.volcanic_act.iter().filter(|&&v| v >= 200).count();
        assert!(n_burst >= 50, "LIP should still fire burst on oceanic crust");
        let any_rift = crust.rift_progress.iter().any(|&p| p > 0);
        assert!(!any_rift, "LIP on oceanic crust must not bump rift_progress");
    }

    #[test]
    fn stationary_hotspot_leaves_a_chain() {
        // Synthetic plate "drift": instead of moving the plate, we move
        // the hotspot tangentially each step, which is geometrically
        // equivalent. The test confirms the chain mechanic: many steps
        // produce many distinct cells marked.
        let (sphere, mut crust) = tiny_world(7, 4);
        let vertices = &sphere.vertices;
        let n = vertices.len();

        let pos0 = vertices[0];
        // Pick a tangent direction strong enough to walk to a new cell
        // each step. 0.05 rad ≈ 3°, well above the per-cell angular
        // spacing at level 4.
        let raw = Vec3f::new(0.0, 1.0, 0.0);
        let drift = project_to_tangent_plane(pos0, raw)
            .normalize_or(Vec3f::new(0.0, 1.0, 0.0))
            .scale(0.05);

        let mut state = HotspotsState {
            hotspots: vec![Hotspot {
                id: 0,
                mantle_position: pos0,
                drift_velocity: drift,
                birth_macro_step: 0,
                lifespan_steps: 1000,
                is_lip: false,
            }],
            master: MasterSeed(42),
        };
        let cell_plate = vec![0u32; n];
        let baseline = crust.volcanic_act.clone();
        for s in 0..20 {
            state.step(s, vertices, &cell_plate, &mut crust);
        }
        let n_marked = crust
            .volcanic_act
            .iter()
            .zip(baseline.iter())
            .filter(|(a, b)| **a > **b)
            .count();
        assert!(
            n_marked >= 5,
            "drifting hotspot should mark >= 5 distinct cells, got {}",
            n_marked
        );
    }
}
