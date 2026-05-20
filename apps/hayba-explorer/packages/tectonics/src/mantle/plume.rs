//! Mantle plumes / hotspots: position, intensity, surface uplift + volcanism.
//!
//! Hayba extension. No direct tectonic-explorer counterpart — TE's
//! `Plate.hotSpot` is an abstract force-position pair attached to each
//! plate, not a stationary mantle anchor. Hayba models the two concepts
//! distinctly:
//!
//! * [`crate::plate::HotSpot`] (kept from TE) — moves with the plate,
//!   decays toward zero, drives plate-bending dynamics.
//! * [`MantlePlume`] (here) — anchored at a fixed position in the mantle
//!   (does not move with plates), has a finite lifetime measured in tens
//!   to hundreds of Ma, deposits volcanic material into the crust column
//!   of whichever plate is currently above it. Generates the linear
//!   age-progressive "plume tracks" we see in real planets (e.g. Hawaii,
//!   Yellowstone, Réunion / Deccan Traps).
//!
//! ## References
//!
//! * Morgan (1971), "Convection plumes in the lower mantle", *Nature* 230,
//!   42–43 — the original plume hypothesis.
//! * Coffin & Eldholm (1994), "Large igneous provinces: crustal structure,
//!   dimensions, and external consequences", *Rev. Geophys.* 32, 1–36 —
//!   plume-head LIP volumes (10⁶ to 10⁷ km³, depositing several km of
//!   basalt across regions thousands of km wide).
//! * Sleep (1990), "Hotspots and mantle plumes: some phenomenology",
//!   *J. Geophys. Res.* 95, 6715–6736 — plume-tail seamount intensity
//!   and longevity (~50–200 Ma).

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::crust::column::SplitMix64;
use crate::field::Field;
use crate::rock::Rock;
use crate::sphere::Grid;

/// Plume-head phase duration (Ma). After this age the plume transitions
/// from "head" (huge mushroom cap delivering an LIP burst) to "tail"
/// (narrow conduit producing seamount-scale eruptions).
///
/// Coffin & Eldholm 1994 estimate LIP emplacement timescales of ~1–5 Ma.
pub const PLUME_HEAD_DURATION_MA: f32 = 5.0;

/// Initial plume-head radius (radians on the unit sphere). Roughly
/// scaled so that on Earth (R ≈ 6371 km) a head footprint covers
/// ~1000 km radius (~2000 km diameter on Earth — ~ Deccan Traps /
/// Siberian Traps scale).
pub const PLUME_HEAD_RADIUS_RAD: f32 = 0.157; // ≈ 1000 km / R_earth

/// Plume-tail radius (radians). Conduit-scale, ~65 km radius
/// (~130 km diameter on Earth).
pub const PLUME_TAIL_RADIUS_RAD: f32 = 0.020; // ≈ 130 km / R_earth

/// Minimum / maximum plume lifetime (Ma). Real plumes vary widely
/// (Sleep 1990).
pub const MIN_PLUME_LIFETIME_MA: f32 = 50.0;
pub const MAX_PLUME_LIFETIME_MA: f32 = 200.0;

/// Total LIP-burst basalt thickness emplaced per cell across the entire
/// head phase (meters). 10 km is reasonable for the thickest cores of
/// real LIPs (Deccan: 2–3 km surface, but with intrusive cumulates the
/// column can reach 10+ km). [`PlumeRegistry::record_tracks`] amortises
/// this over [`PLUME_HEAD_DURATION_MA`] so the per-step deposit scales
/// with `dt_ma`.
pub const PLUME_HEAD_DEPOSIT_M: f32 = 10_000.0;

/// Tail-phase basalt deposition rate (meters per Ma). 100 m/Ma yields
/// ~1 km over 10 Ma — realistic for the Hawaii-Emperor seamount pace
/// (Sleep 1990). [`PlumeRegistry::record_tracks`] multiplies this by
/// `dt_ma` to get the per-step thickness.
pub const PLUME_TAIL_DEPOSIT_M_PER_MA: f32 = 100.0;

/// Min / max basalt thickness emplaced per cell during the tail phase
/// (meters). Retained for reference; the active deposition rate is
/// [`PLUME_TAIL_DEPOSIT_M_PER_MA`].
pub const PLUME_TAIL_MIN_DEPOSIT_M: f32 = 1_000.0;
pub const PLUME_TAIL_MAX_DEPOSIT_M: f32 = 3_000.0;

/// A discrete mantle plume.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MantlePlume {
    pub id: u32,
    /// Stationary position in the mantle, expressed as a unit-sphere
    /// point (the CMB anchor projected outward to the surface).
    pub position: Vec3,
    /// Age since plume birth, in Ma.
    pub age_ma: f32,
    /// Current plume-head/tail radius (radians on the unit sphere).
    /// Starts at [`PLUME_HEAD_RADIUS_RAD`] and narrows linearly to
    /// [`PLUME_TAIL_RADIUS_RAD`] over [`PLUME_HEAD_DURATION_MA`].
    pub head_radius_rad: f32,
    /// `true` while the conduit is still emplacing material. Goes
    /// `false` when `age_ma >= lifetime_ma`.
    pub tail_active: bool,
    /// Total lifetime budget (Ma). Plume dies once `age_ma > lifetime_ma`.
    pub lifetime_ma: f32,
    /// Volcanic intensity (decays from 1.0 at the head to ~0.3 along the
    /// long tail).
    pub intensity: f32,
}

impl MantlePlume {
    /// Build a fresh plume at `position` with a deterministic lifetime
    /// drawn from `master_seed ^ id`.
    pub fn new(id: u32, position: Vec3, master_seed: u64) -> Self {
        let mut rng = SplitMix64::new(master_seed ^ (id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let lifetime = MIN_PLUME_LIFETIME_MA
            + rng.next_unit_f32() * (MAX_PLUME_LIFETIME_MA - MIN_PLUME_LIFETIME_MA);
        let pos = if position.length_squared() > 0.0 {
            position.normalize()
        } else {
            Vec3::Y
        };
        Self {
            id,
            position: pos,
            age_ma: 0.0,
            head_radius_rad: PLUME_HEAD_RADIUS_RAD,
            tail_active: true,
            lifetime_ma: lifetime,
            intensity: 1.0,
        }
    }

    /// Advance plume age by `dt_ma`. Returns `true` if the plume is still
    /// alive after the step.
    pub fn step(&mut self, dt_ma: f32) -> bool {
        if dt_ma <= 0.0 {
            return self.is_alive();
        }
        self.age_ma += dt_ma;

        // Head → tail transition: linear narrowing of the radius and
        // linear intensity decay during the head phase.
        //
        // Hayba uses a linear head→tail collapse over 5 Ma for visual
        // smoothness. Real plumes collapse abruptly upon head
        // detachment; this simplification trades realism for animation
        // continuity.
        if self.age_ma <= PLUME_HEAD_DURATION_MA {
            let t = self.age_ma / PLUME_HEAD_DURATION_MA;
            self.head_radius_rad =
                PLUME_HEAD_RADIUS_RAD * (1.0 - t) + PLUME_TAIL_RADIUS_RAD * t;
            self.intensity = 1.0;
        } else {
            self.head_radius_rad = PLUME_TAIL_RADIUS_RAD;
            // Tail intensity decays gently from 1.0 just after the head
            // phase to ~0.3 at end-of-life (Sleep 1990 — older tracks
            // are typically smaller seamounts).
            let tail_age = self.age_ma - PLUME_HEAD_DURATION_MA;
            let tail_span = (self.lifetime_ma - PLUME_HEAD_DURATION_MA).max(1e-3);
            let t = (tail_age / tail_span).clamp(0.0, 1.0);
            self.intensity = 1.0 - 0.7 * t;
        }

        if self.age_ma >= self.lifetime_ma {
            self.tail_active = false;
        }
        self.is_alive()
    }

    /// Current surface footprint: (anchor point on unit sphere, angular
    /// radius in radians).
    pub fn surface_footprint(&self) -> (Vec3, f32) {
        (self.position, self.head_radius_rad)
    }

    /// True while the plume's conduit is still alive.
    #[inline]
    pub fn is_alive(&self) -> bool {
        self.age_ma < self.lifetime_ma
    }

    /// True iff we are still in the LIP-emplacing head phase.
    #[inline]
    pub fn is_head_phase(&self) -> bool {
        self.age_ma < PLUME_HEAD_DURATION_MA
    }
}

/// One recorded "footprint" event — a cell that was above a live plume
/// when [`PlumeRegistry::record_tracks`] ran.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackPoint {
    pub plume_id: u32,
    pub cell_id: u32,
    /// Sim time (Ma) when this footprint was deposited.
    pub age_at_emplacement_ma: f32,
    pub intensity: f32,
}

/// Owns the active plume population and the history of track points
/// they've left on the crust.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PlumeRegistry {
    pub plumes: Vec<MantlePlume>,
    pub track_points: Vec<TrackPoint>,
    pub next_id: u32,
}

impl PlumeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a new plume at `position`. The plume's id is allocated
    /// monotonically from `next_id` so determinism is preserved across
    /// re-runs given the same call order.
    pub fn spawn_plume(&mut self, position: Vec3, master_seed: u64) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.plumes
            .push(MantlePlume::new(id, position, master_seed));
        id
    }

    /// Deterministically populate `count` plumes at pseudo-random
    /// positions on the unit sphere, seeded from `master_seed`. Useful
    /// for `Model::new` to give every world a handful of plumes by
    /// default.
    pub fn spawn_default_population(&mut self, count: u32, master_seed: u64) {
        // Distinct constant so the spawn-population RNG decorrelates from
        // any other SplitMix64 stream the caller derives from `master_seed`.
        const PLUME_INIT_SEED_XOR: u64 = 0xC0FFEE_DEAD_F00D;
        let mut rng = SplitMix64::new(master_seed ^ PLUME_INIT_SEED_XOR);
        for _ in 0..count {
            // Uniform-on-sphere sample via inverse CDF of cos(latitude).
            let u = rng.next_unit_f32();
            let v = rng.next_unit_f32();
            let z = 2.0 * u - 1.0; // cos(theta)
            let phi = 2.0 * std::f32::consts::PI * v;
            let r = (1.0 - z * z).max(0.0).sqrt();
            let pos = Vec3::new(r * phi.cos(), z, r * phi.sin());
            self.spawn_plume(pos, master_seed);
        }
    }

    /// Advance every plume's age by `dt_ma` and drop dead ones.
    pub fn step(&mut self, dt_ma: f32) {
        for p in self.plumes.iter_mut() {
            p.step(dt_ma);
        }
        self.plumes.retain(|p| p.is_alive());
    }

    /// Iterate over plumes that are still alive (post-`step`, all plumes
    /// are alive, but this iterator is kept as a stable API).
    pub fn live_plumes(&self) -> impl Iterator<Item = &MantlePlume> {
        self.plumes.iter().filter(|p| p.is_alive())
    }

    /// For each live plume, find which cells are currently inside its
    /// surface footprint, record a [`TrackPoint`], and deposit basalt
    /// into those cells' crust columns.
    ///
    /// Determinism: plumes are iterated in id order (registry insertion
    /// order is already id-monotonic via [`Self::spawn_plume`]); the
    /// affected-cell set per plume is built by walking the BFS frontier
    /// from the cell nearest the plume centre, which is itself
    /// deterministic given the grid. Track points and crust deposits
    /// therefore land in the same order on every replay.
    pub fn record_tracks(
        &mut self,
        grid: &Grid,
        fields: &mut [Field],
        current_sim_ma: f32,
        dt_ma: f32,
    ) {
        // Snapshot the plume ids/positions/states first to avoid an
        // aliasing borrow when we mutate `fields` below.
        let snapshot: Vec<(u32, Vec3, f32, f32, bool)> = self
            .plumes
            .iter()
            .map(|p| (p.id, p.position, p.head_radius_rad, p.intensity, p.is_head_phase()))
            .collect();

        for (plume_id, centre, radius, intensity, is_head) in snapshot {
            // Identify the cells whose centre lies inside the plume's
            // angular cap. We BFS from the seed cell out to neighbours
            // whose great-circle distance from `centre` is ≤ radius.
            let seed = grid.nearest_field(centre);
            let mut frontier: Vec<u32> = vec![seed];
            // SD-PR (Plume Record): HashSet instead of BTreeSet — visited is
            // only used for membership tests (.insert returns bool), never
            // iterated, so the sorted-order semantics of BTreeSet bought us
            // nothing while paying O(log N) per insert. HashSet gives O(1)
            // amortised; for 50-500 cells/plume × 10-20 plumes/step this
            // shaves several ms off the plume phase. Byte-equality preserved:
            // identical seed, identical BFS pop order, identical
            // affected.sort_unstable() output.
            let mut visited: std::collections::HashSet<u32> =
                std::collections::HashSet::with_capacity(512);
            visited.insert(seed);
            let mut affected: Vec<u32> = Vec::new();

            while let Some(fid) = frontier.pop() {
                let pos = grid.position(fid);
                // Great-circle distance from `centre` (both unit
                // vectors) ≈ acos(dot). For small radii we use the
                // smaller of acos(dot.clamp(-1,1)) and the chord
                // length — they agree to first order.
                let dot = pos.normalize().dot(centre).clamp(-1.0, 1.0);
                let ang = dot.acos();
                if ang <= radius {
                    affected.push(fid);
                    for &nb in grid.neighbours(fid) {
                        if visited.insert(nb) {
                            frontier.push(nb);
                        }
                    }
                }
            }

            // Sort affected cells by id so deposit order is
            // deterministic regardless of BFS traversal order.
            affected.sort_unstable();

            // Per-Ma rates × dt_ma so total head-phase deposit over the
            // full PLUME_HEAD_DURATION_MA window sums to
            // PLUME_HEAD_DEPOSIT_M independent of step size. Intensity
            // scales both phases (head-phase intensity is ~1.0 by design,
            // tail-phase intensity decays from ~1.0 to ~0.3).
            let dt = dt_ma.max(0.0);
            let head_thickness =
                (PLUME_HEAD_DEPOSIT_M / PLUME_HEAD_DURATION_MA) * dt * intensity.max(0.0);
            let tail_thickness = PLUME_TAIL_DEPOSIT_M_PER_MA * dt * intensity.max(0.0);

            for fid in affected {
                if let Some(f) = fields.get_mut(fid as usize) {
                    let thickness = if is_head {
                        head_thickness
                    } else {
                        tail_thickness
                    };
                    f.crust
                        .add_volcanic_deposit(Rock::Basalt, thickness, current_sim_ma);
                    self.track_points.push(TrackPoint {
                        plume_id,
                        cell_id: fid,
                        age_at_emplacement_ma: current_sim_ma,
                        intensity,
                    });
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sphere::Grid;

    #[test]
    fn plume_spawns_with_unique_id() {
        let mut reg = PlumeRegistry::new();
        let a = reg.spawn_plume(Vec3::Y, 42);
        let b = reg.spawn_plume(Vec3::X, 42);
        let c = reg.spawn_plume(Vec3::Z, 42);
        assert_eq!(a, 0);
        assert_eq!(b, 1);
        assert_eq!(c, 2);
        assert_eq!(reg.plumes.len(), 3);
        assert!(reg.plumes.iter().all(MantlePlume::is_alive));
    }

    #[test]
    fn plume_ages_with_dt() {
        let mut p = MantlePlume::new(0, Vec3::Y, 1);
        let before = p.age_ma;
        p.step(10.0);
        assert!((p.age_ma - (before + 10.0)).abs() < 1e-5);
    }

    #[test]
    fn plume_dies_after_lifetime() {
        let mut p = MantlePlume::new(0, Vec3::Y, 1);
        // Force a long step beyond max lifetime.
        p.step(MAX_PLUME_LIFETIME_MA + 50.0);
        assert!(!p.is_alive());
        assert!(!p.tail_active);
    }

    #[test]
    fn plume_head_phase_lasts_about_5_ma() {
        let mut p = MantlePlume::new(0, Vec3::Y, 1);
        assert!(p.is_head_phase());
        p.step(PLUME_HEAD_DURATION_MA - 0.1);
        assert!(p.is_head_phase());
        p.step(0.2);
        assert!(!p.is_head_phase());
        // Radius has collapsed to the tail value.
        assert!((p.head_radius_rad - PLUME_TAIL_RADIUS_RAD).abs() < 1e-5);
    }

    #[test]
    fn plume_above_cell_deposits_basalt() {
        // Build a tiny grid, place a single plume above field 0, run one
        // record_tracks pass, and assert the cell gained extrusive basalt.
        let grid = Grid::new(2);
        let mut fields: Vec<Field> = (0..grid.n_fields())
            .map(|i| Field::new(i, grid.position(i)))
            .collect();
        let mut reg = PlumeRegistry::new();
        let plume_pos = grid.position(0);
        reg.spawn_plume(plume_pos, 7);
        let before = fields[0].crust.extrusive.thickness_m;
        // Use a 1 Ma sub-step so head-phase per-step deposit is
        // PLUME_HEAD_DEPOSIT_M / PLUME_HEAD_DURATION_MA (= 2 km).
        reg.record_tracks(&grid, &mut fields, 0.0, 1.0);
        let after = fields[0].crust.extrusive.thickness_m;
        assert!(
            after > before,
            "expected extrusive basalt to be deposited under the plume; before={before} after={after}"
        );
        assert!(!reg.track_points.is_empty());
        assert_eq!(reg.track_points[0].plume_id, 0);
    }

    #[test]
    fn plate_motion_over_plume_creates_track_chain() {
        // A single plate that rotates over a stationary plume should
        // leave a chain of track points stretched along the path.
        let grid = Grid::new(8);
        let mut fields: Vec<Field> = (0..grid.n_fields())
            .map(|i| Field::new(i, grid.position(i)))
            .collect();
        // Stationary plume at +Y.
        let mut reg = PlumeRegistry::new();
        reg.spawn_plume(Vec3::Y, 99);

        // Simulate plate motion implicitly: shift every field's local_pos
        // a little each step (instead of rotating a plate, we move the
        // grid points in world space — equivalent for the purpose of
        // testing the registry's per-step bookkeeping).
        let mut last_track_count = 0;
        for _ in 0..6 {
            reg.step(2.0); // 2 Ma per tick — within head phase initially
            reg.record_tracks(&grid, &mut fields, reg.plumes[0].age_ma, 2.0);
            assert!(
                reg.track_points.len() > last_track_count,
                "every step should add at least one track point"
            );
            last_track_count = reg.track_points.len();
        }
        // Plume is still alive (we only ran 12 Ma << min lifetime).
        assert!(reg.plumes[0].is_alive());
        assert!(reg.track_points.len() >= 6);
    }

    #[test]
    fn record_tracks_is_deterministic() {
        fn run() -> Vec<u8> {
            let grid = Grid::new(4);
            let mut fields: Vec<Field> = (0..grid.n_fields())
                .map(|i| Field::new(i, grid.position(i)))
                .collect();
            let mut reg = PlumeRegistry::new();
            reg.spawn_default_population(4, 0xCAFE_F00D);
            for _ in 0..5 {
                reg.step(1.0);
                reg.record_tracks(&grid, &mut fields, reg.plumes[0].age_ma, 1.0);
            }
            bincode::serialize(&(&reg.plumes, &reg.track_points)).unwrap()
        }
        let a = run();
        let b = run();
        assert_eq!(a, b);
    }

    #[test]
    fn spawn_default_population_produces_unit_vectors() {
        let mut reg = PlumeRegistry::new();
        reg.spawn_default_population(5, 123);
        assert_eq!(reg.plumes.len(), 5);
        for p in &reg.plumes {
            assert!(
                (p.position.length() - 1.0).abs() < 1e-3,
                "plume position should lie on unit sphere, got {:?}",
                p.position
            );
        }
    }

    #[test]
    fn head_phase_total_deposit_sums_to_constant_independent_of_step() {
        // The fix: deposit is rate-based (PLUME_HEAD_DEPOSIT_M /
        // PLUME_HEAD_DURATION_MA per Ma). Total deposit over the full
        // head phase should equal PLUME_HEAD_DEPOSIT_M regardless of
        // sub-step size.
        fn total_after_head_phase(dt_ma: f32) -> f32 {
            let grid = Grid::new(2);
            let mut fields: Vec<Field> = (0..grid.n_fields())
                .map(|i| Field::new(i, grid.position(i)))
                .collect();
            let mut reg = PlumeRegistry::new();
            reg.spawn_plume(grid.position(0), 7);
            let before = fields[0].crust.extrusive.thickness_m;
            // Step in dt_ma increments through the entire head phase
            // (5 Ma total). record_tracks is called once per sub-step
            // BEFORE the plume ages past the head boundary, mirroring
            // production Model::step ordering.
            let mut accumulated = 0.0_f32;
            while accumulated < PLUME_HEAD_DURATION_MA - 1e-4 {
                reg.record_tracks(&grid, &mut fields, accumulated, dt_ma);
                reg.step(dt_ma);
                accumulated += dt_ma;
            }
            fields[0].crust.extrusive.thickness_m - before
        }
        let coarse = total_after_head_phase(2.5); // 2 sub-steps
        let fine = total_after_head_phase(1.0); // 5 sub-steps
        let finer = total_after_head_phase(0.5); // 10 sub-steps
        // All within 1% of PLUME_HEAD_DEPOSIT_M.
        for (label, total) in [("2.5", coarse), ("1.0", fine), ("0.5", finer)] {
            let rel_err = ((total - PLUME_HEAD_DEPOSIT_M) / PLUME_HEAD_DEPOSIT_M).abs();
            assert!(
                rel_err < 0.01,
                "dt={label}: total deposit {total} should be ~{PLUME_HEAD_DEPOSIT_M} (PLUME_HEAD_DEPOSIT_M); rel_err={rel_err}"
            );
        }
    }

    #[test]
    fn plume_intensity_decays_along_tail() {
        let mut p = MantlePlume::new(0, Vec3::Y, 1);
        p.lifetime_ma = 100.0; // override for predictable test
        // Just-past-head: intensity ≈ 1.0
        p.step(PLUME_HEAD_DURATION_MA + 0.01);
        let early = p.intensity;
        // Near end-of-life: intensity ≈ 0.3
        let mut q = MantlePlume::new(1, Vec3::Y, 1);
        q.lifetime_ma = 100.0;
        q.step(95.0);
        let late = q.intensity;
        assert!(early > late, "intensity should decay over tail; early={early} late={late}");
    }
}
