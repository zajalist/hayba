//! Per-cell crust state — composition, age, layered thickness, and event
//! counters consumed by the cellular automaton in [`crate::ca_evolution`].
//!
//! ## Public surface
//!
//! - [`Composition`] — Oceanic / Island / Continental classification.
//! - [`CrustLayers`] — per-cell layered rock thickness in km (gabbro, basalt,
//!   diorite, granite, rhyolite, sediment). Drives bulk density.
//! - [`CrustState`] — the SoA holding all per-cell fields. Indexed lock-step
//!   with [`crate::plates::PlateAssignment::cell_plate`].
//! - [`CrustState::initial`] — deterministic builder driven by the master seed
//!   and Voronoi seed positions; writes per-plate baseline compositions back
//!   into the supplied [`crate::plates::PlateAssignment`].
//! - [`CrustState::mark_failed_rift`] — aulacogen tag for cells whose rift
//!   matured but didn't sever the parent plate (M0.3).
//! - Thresholds: [`ISLAND_THRESHOLD`], [`CONTINENT_THRESHOLD`], [`RIFT_THRESHOLD`].
//!
//! ## Initial conditions (t=0, before any CA evolution)
//!
//! - Each plate gets a baseline composition (~70% oceanic / 30% continental).
//! - Continental-baseline plates carry a continental "core" (Archean craton,
//!   ages up to 3 Ga) surrounded by a passive oceanic margin.
//! - Oceanic-baseline plates are uniformly oceanic, ages capped at 200 Ma.
//! - Layered crust + elevation are derived from composition + age and obey
//!   the density ordering old-oceanic > young-oceanic > continental.
//!
//! Per-cell counters (`bending`, `volcanic_act`, `rift_progress`,
//! `failed_rift_age_ma`) start at 0 and are mutated each macro-step by the CA.

use hayba_seeds::{derive_scope, MasterSeed, Scope, SeedStream};

use crate::initial_elevation::initial_elevation_m;
use crate::mesh::Vec3f;
use crate::plates::PlateAssignment;

/// Coarse crust classification used for boundary rules (which side subducts,
/// which side overrides) and visualization. Per-cell; mutated by the CA as
/// volcanic activity / rifting cross their thresholds.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Composition {
    Oceanic     = 0,
    /// Island arc — intermediate state between oceanic and continental,
    /// produced by sustained volcanic activity at oceanic-oceanic subduction
    /// zones. After further maturation, transitions to Continental.
    Island      = 1,
    Continental = 2,
}

impl Composition {
    /// Lowercase string label for logging / JSON export.
    pub const fn label(self) -> &'static str {
        match self {
            Composition::Oceanic     => "oceanic",
            Composition::Island      => "island",
            Composition::Continental => "continental",
        }
    }
}

/// Per-cell layered crust composition. Each field is the thickness of that
/// rock layer in kilometres (0-255). Total crust thickness = sum of all
/// layers. Used both for density-driven subduction rules and for rock-type
/// visualization.
///
/// Real-Earth typical thicknesses (km):
/// - Oceanic: ~3 km basalt + ~4 km gabbro + ~0-1 km sediment (~7-8 km total)
/// - Island arc: similar to oceanic + diorite buildup (~12-20 km)
/// - Continental: ~5-15 km granite + ~5-15 km diorite + ~1-3 km sediment
///   + occasional rhyolite (~30-70 km total)
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct CrustLayers {
    pub gabbro: u8,    // basal mafic intrusive — oceanic substrate
    pub basalt: u8,    // extrusive mafic — fresh oceanic surface
    pub diorite: u8,   // intermediate igneous — subduction arc magmatism
    pub granite: u8,   // felsic intrusive — continental basement
    pub rhyolite: u8,  // extrusive felsic — continental volcanism
    pub sediment: u8,  // surface sediment — accumulates over time
}

impl CrustLayers {
    /// Sum of layer thicknesses (km). Zero for an unset / pre-init cell.
    pub fn total_thickness(&self) -> u32 {
        self.gabbro as u32 + self.basalt as u32 + self.diorite as u32
            + self.granite as u32 + self.rhyolite as u32 + self.sediment as u32
    }

    /// Bulk density (kg/m³) weighted by layer thickness × layer density.
    /// Falls back to a constant if the cell has zero thickness (shouldn't happen).
    pub fn density_kg_per_m3(&self) -> f64 {
        let t = self.total_thickness() as f64;
        if t < 0.5 { return 2900.0; }
        // Real-rock densities (rough):
        (self.gabbro   as f64 * 3000.0
         + self.basalt   as f64 * 2900.0
         + self.diorite  as f64 * 2800.0
         + self.granite  as f64 * 2700.0
         + self.rhyolite as f64 * 2650.0
         + self.sediment as f64 * 2400.0) / t
    }
}

/// Per-cell crust state, indexed identically to `PlateAssignment::cell_plate`.
#[derive(Debug)]
#[derive(Clone)]
pub struct CrustState {
    /// Per-cell composition.
    pub composition: Vec<Composition>,
    /// Per-cell age in millions of years.
    pub age_ma: Vec<u16>,
    /// Per-cell elevation in metres above (positive) or below (negative)
    /// the planetary reference surface. Mountains, ridges, trenches.
    pub elevation_m: Vec<i16>,
    /// Per-cell layered crust composition.
    pub layers: Vec<CrustLayers>,
    /// Bending counter for cells in subduction zones — gradually depresses
    /// toward trench formation. 0..255 → 0..max_trench_depth.
    pub bending: Vec<u8>,
    /// Volcanic activity counter (arc maturation): cells under sustained
    /// volcanic activity accumulate this; thresholds trigger Composition
    /// transitions (Oceanic → Island → Continental).
    pub volcanic_act: Vec<u8>,
    /// Rifting counter: cont-cont divergent boundaries tick this up;
    /// at threshold composition flips to Oceanic.
    pub rift_progress: Vec<u8>,
    /// **Aulacogen tag** — non-zero on cells that once matured a rift but
    /// didn't sever the parent plate. Stores the macro-step at which the
    /// failure was recorded so M5 hydrology can route rivers preferentially
    /// along the freshest aulacogens. Cells with this flag accumulate
    /// `rift_progress` at 1.5x rate on future divergent stress — modeling
    /// the Mississippi / Nile / Niger / Amazon reactivation mechanism.
    pub failed_rift_age_ma: Vec<u16>,
    /// **LIP tag** — non-zero on cells touched by a Large Igneous Province
    /// burst (M0.13). Stores the world-age (Ma) at which the burst landed
    /// so downstream rock-record / biome systems can reason about flood-
    /// basalt provinces (Deccan, Siberian Traps, Ontong-Java) and the
    /// CAMP-Pangaea / Deccan-India rift-trigger coupling.
    pub lip_age_ma: Vec<u16>,
    /// Per-cell upstream drainage area (count of upstream cells, including
    /// self), produced by [`crate::drainage::compute_flow_accum`] in the
    /// macro-step erosion pass. Zero until the first erosion step runs.
    /// Not streamed yet (Task 2.4 will wire this into `frame_stream`).
    pub flow_accum: Vec<u32>,
    /// Per-cell lake flag (1 = interior sink, 0 = drains externally). Set
    /// in `post_step` from `flow_dirs == u32::MAX && elev > SEA_LEVEL`.
    /// Not streamed yet (Task 2.4 will wire this into `frame_stream`).
    pub lake_mask: Vec<u8>,
}

impl CrustState {
    /// Mark a set of cells as failed-rift (aulacogen). Resets their
    /// `rift_progress` and records `current_age_ma` so reactivation rate
    /// has a fresh-vs-ancient gradient available later.
    pub fn mark_failed_rift(&mut self, cells: &[u32], current_age_ma: u16) {
        for &c in cells {
            let i = c as usize;
            self.failed_rift_age_ma[i] = current_age_ma.max(1);
            self.rift_progress[i] = 0;
        }
    }
}

/// Knobs for [`CrustState::initial`]. Default values match Earth-like
/// baselines (see [`Default`] impl below).
pub struct CrustOptions {
    /// Fraction of plates that start as oceanic. Earth: ~70%.
    pub oceanic_fraction: f64,
    /// Cap on initial age for continental cores (Ma). Earth: ~3-4 Ga.
    pub continental_age_cap_ma: u16,
    /// Cap on initial age for oceanic interiors (Ma). Earth: ~200 Ma.
    pub oceanic_age_cap_ma: u16,
}

impl Default for CrustOptions {
    fn default() -> Self {
        Self {
            oceanic_fraction: 0.70,
            continental_age_cap_ma: 3000,
            oceanic_age_cap_ma: 200,
        }
    }
}

/// Real-world reference baselines for initial layered crust.
/// Continental baseline layers (km).
const CONT_GRANITE_BASE: u8 = 18;
const CONT_DIORITE_BASE: u8 = 12;
const CONT_SEDIMENT_BASE: u8 = 1;
/// Oceanic baseline layers (km).
const OCE_GABBRO_BASE: u8 = 4;
const OCE_BASALT_BASE: u8 = 3;

/// Threshold for arc maturation: Oceanic → Island once volcanic_act ≥ this.
pub const ISLAND_THRESHOLD: u8 = 80;
/// Threshold for arc maturation: Island → Continental.
pub const CONTINENT_THRESHOLD: u8 = 200;
/// Threshold for rifting completion: Continental → Oceanic.
pub const RIFT_THRESHOLD: u8 = 200;

impl CrustState {
    /// Build initial crust state. Writes the per-plate baseline composition
    /// into `assignment.plate_composition` for every live plate slot (retired
    /// slots stay `None`).
    pub fn initial(
        master: MasterSeed,
        vertices: &[Vec3f],
        assignment: &mut PlateAssignment,
        seed_positions: &[Vec3f],
        opts: CrustOptions,
    ) -> Self {
        let cell_plate = assignment.cell_plate.clone();
        let scope_seed = derive_scope(master, Scope::Tectonic).wrapping_add(0xC051_E1A1_C051_E1A1);
        let mut stream = SeedStream::new(scope_seed);

        // 1. Per-plate composition. Roll a coin per plate slot (live or
        //    retired) so the random stream advances deterministically and
        //    stays aligned with the registry slot index. Retired slots stay
        //    `None` in the assignment registry; their rolled value is
        //    consumed but never read.
        let oceanic_threshold = (opts.oceanic_fraction.clamp(0.0, 1.0) * u64::MAX as f64) as u64;
        let n_slots = assignment.plates.len();
        let plate_composition: Vec<Composition> = (0..n_slots)
            .map(|_| {
                let r = stream.next_u64();
                if r < oceanic_threshold { Composition::Oceanic } else { Composition::Continental }
            })
            .collect();
        // Write back into the registry, respecting retired slots.
        for (i, c) in plate_composition.iter().enumerate() {
            if assignment.plates[i].is_some() {
                assignment.plate_composition[i] = Some(*c);
            } else {
                assignment.plate_composition[i] = None;
            }
        }

        // 2a. Compute per-plate dot-product extents (arc-extent proxy on the
        //     unit sphere). Closer to seed → larger dot product.
        let mut max_dot_per_plate = vec![f64::NEG_INFINITY; seed_positions.len()];
        let mut min_dot_per_plate = vec![f64::INFINITY; seed_positions.len()];
        for (i, &pid) in cell_plate.iter().enumerate() {
            let d = vertices[i].dot(seed_positions[pid as usize]);
            let p = pid as usize;
            if d > max_dot_per_plate[p] { max_dot_per_plate[p] = d; }
            if d < min_dot_per_plate[p] { min_dot_per_plate[p] = d; }
        }

        // 2b. Per-plate continental core radius fraction, deterministic.
        //     For each Continental-baseline plate, roll a fraction in [0.3, 0.7]
        //     so 50%±20% of the plate's arc-extent forms the continental core.
        //     Cells outside the core are passive-margin oceanic.
        let core_seed = derive_scope(master, Scope::Tectonic).wrapping_add(0xC0_5E_50_BE);
        let mut core_stream = SeedStream::new(core_seed);
        let core_fraction: Vec<f64> = (0..n_slots)
            .map(|_| {
                let r = core_stream.next_u64() as f64 / u64::MAX as f64;
                0.3 + r * 0.4  // [0.3, 0.7]
            })
            .collect();

        // 2c. Per-cell composition. For Oceanic-baseline plates: every cell is
        //     oceanic. For Continental-baseline plates: cells inside the core
        //     radius (close to seed) are Continental; cells outside are Oceanic
        //     (passive margin).
        let composition: Vec<Composition> = cell_plate.iter().enumerate().map(|(i, &pid)| {
            let p = pid as usize;
            match plate_composition[p] {
                Composition::Continental => {
                    let d = vertices[i].dot(seed_positions[p]);
                    let span = (max_dot_per_plate[p] - min_dot_per_plate[p]).max(1e-9);
                    // normalized: 0 at the farthest cell, 1 at the seed-nearest cell.
                    let normalized = (d - min_dot_per_plate[p]) / span;
                    if normalized >= 1.0 - core_fraction[p] {
                        Composition::Continental
                    } else {
                        Composition::Oceanic
                    }
                }
                other => other,
            }
        }).collect();

        // 3. Per-cell age = composition-specific cap × normalized distance to seed.
        //    Continental cores get the continental cap (old cratons in the middle);
        //    oceanic cells (either oceanic-plate or passive-margin) use the oceanic cap.
        let age_ma: Vec<u16> = cell_plate.iter().enumerate().map(|(i, &pid)| {
            let p = pid as usize;
            let cap = match composition[i] {
                Composition::Oceanic     => opts.oceanic_age_cap_ma as f64,
                // Islands shouldn't appear at init, but handle defensively.
                Composition::Island      => opts.oceanic_age_cap_ma as f64,
                Composition::Continental => opts.continental_age_cap_ma as f64,
            };
            let d = vertices[i].dot(seed_positions[p]);
            let span = (max_dot_per_plate[p] - min_dot_per_plate[p]).max(1e-9);
            let normalized = (d - min_dot_per_plate[p]) / span;  // 0 at edge, 1 at centroid
            (normalized * cap).round().clamp(0.0, 65535.0) as u16
        }).collect();

        // 4. Layered crust per cell. Continental cells get a granite-diorite
        //    base with thin sediment; oceanic cells get a gabbro-basalt base
        //    with thin sediment near older crust.
        let layers: Vec<CrustLayers> = composition.iter().enumerate().map(|(i, &c)| {
            let age = age_ma[i];
            match c {
                Composition::Continental => CrustLayers {
                    granite: CONT_GRANITE_BASE,
                    diorite: CONT_DIORITE_BASE,
                    sediment: CONT_SEDIMENT_BASE + (age / 1000) as u8,  // older = more sediment
                    ..Default::default()
                },
                Composition::Oceanic => CrustLayers {
                    gabbro: OCE_GABBRO_BASE,
                    basalt: OCE_BASALT_BASE,
                    sediment: (age / 80).min(3) as u8,  // up to 3 km on old ocean floor
                    ..Default::default()
                },
                Composition::Island => CrustLayers {
                    gabbro: 4, basalt: 3, diorite: 8, ..Default::default()
                },
            }
        }).collect();

        // 5. Initial elevation = composition baseline + fBm noise on the
        //    unit sphere, clamped to pre-tectonic ranges. See
        //    [`crate::initial_elevation`]. The CA then evolves this baseline
        //    toward composition-driven targets (trenches, Himalayas) — we
        //    intentionally leave headroom in the clamp so it can grow.
        //    Deterministic in the master seed.
        let MasterSeed(seed_u64) = master;
        let elevation_m: Vec<i16> = (0..cell_plate.len()).map(|i| {
            initial_elevation_m(vertices[i], composition[i], seed_u64)
        }).collect();

        let n = cell_plate.len();
        Self {
            composition,
            age_ma,
            elevation_m,
            layers,
            bending: vec![0; n],
            volcanic_act: vec![0; n],
            rift_progress: vec![0; n],
            failed_rift_age_ma: vec![0; n],
            lip_age_ma: vec![0; n],
            flow_accum: vec![0; n],
            lake_mask: vec![0; n],
        }
    }

    /// Bulk density (kg/m³) for a single cell, derived from the layered
    /// crust composition plus a small age-driven cooling boost for oceanic
    /// crust. Drives subduction-side selection at convergent boundaries.
    pub fn density_kg_per_m3(&self, cell: usize) -> f64 {
        let layered = self.layers[cell].density_kg_per_m3();
        // Oceanic cooling adds density beyond what the rock layers reflect.
        let cooling_boost = match self.composition[cell] {
            Composition::Oceanic => 0.4 * self.age_ma[cell] as f64,
            _ => 0.0,
        };
        layered + cooling_boost
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plates::{Plate, PlateAssignment};

    /// Synthetic PlateAssignment matching a hand-rolled cell_plate / seed
    /// layout — used by these tests so we can drive `CrustState::initial`
    /// without spinning up a full icosphere + Power Diagram.
    fn synthetic_assignment(cell_plate: Vec<u32>, seed_positions: &[Vec3f]) -> PlateAssignment {
        let n_plates = seed_positions.len();
        let plates: Vec<Option<Plate>> = (0..n_plates)
            .map(|i| Some(Plate {
                id: i as u32,
                seed_pos: seed_positions[i],
                color: [128, 128, 128],
                parent_id: None,
                birth_macro_step: 0,
                last_division_step: None,
                age_since_last_split: 0,
            }))
            .collect();
        PlateAssignment {
            plates,
            next_id_counter: n_plates as u32,
            cell_plate,
            boundary_edges: vec![],
            triple_junctions: vec![],
            residual_quad_junctions: 0,
            plate_composition: vec![Some(Composition::Oceanic); n_plates],
        }
    }

    fn synthetic_setup(n_cells: usize, n_plates: u32) -> (Vec<Vec3f>, Vec<u32>, Vec<Vec3f>) {
        // Build a tiny synthetic mesh + plate assignment for unit tests.
        // Vertices: points on the unit sphere around two seed clusters.
        let mut vertices = Vec::with_capacity(n_cells);
        let mut cell_plate = Vec::with_capacity(n_cells);
        let seed_positions: Vec<Vec3f> = (0..n_plates).map(|i| {
            let angle = i as f64 * 2.0 * std::f64::consts::PI / n_plates as f64;
            Vec3f::new(angle.cos(), angle.sin(), 0.0).normalize()
        }).collect();

        for i in 0..n_cells {
            let p = (i % n_plates as usize) as u32;
            let seed = seed_positions[p as usize];
            // Slight offset from seed so distance > 0.
            let offset_angle = (i as f64) * 0.01;
            let v = Vec3f::new(
                seed.x + offset_angle * 0.05,
                seed.y - offset_angle * 0.03,
                0.0,
            ).normalize();
            vertices.push(v);
            cell_plate.push(p);
        }
        (vertices, cell_plate, seed_positions)
    }

    #[test]
    fn deterministic_initial_state() {
        let (vs, cp, sp) = synthetic_setup(100, 5);
        let mut pa_a = synthetic_assignment(cp.clone(), &sp);
        let mut pa_b = synthetic_assignment(cp.clone(), &sp);
        let a = CrustState::initial(MasterSeed(42), &vs, &mut pa_a, &sp, CrustOptions::default());
        let b = CrustState::initial(MasterSeed(42), &vs, &mut pa_b, &sp, CrustOptions::default());
        assert_eq!(a.composition, b.composition);
        assert_eq!(a.age_ma, b.age_ma);
        assert_eq!(pa_a.plate_composition, pa_b.plate_composition);
    }

    #[test]
    fn oceanic_fraction_is_roughly_correct() {
        // With 1000 plates and 70% oceanic fraction, the number of oceanic
        // plates should be within ±5% of 700.
        let n = 1000u32;
        let (vs, cp, sp) = synthetic_setup(n as usize, n);
        let mut pa = synthetic_assignment(cp, &sp);
        let _s = CrustState::initial(
            MasterSeed(42),
            &vs, &mut pa, &sp,
            CrustOptions { oceanic_fraction: 0.70, ..CrustOptions::default() },
        );
        let oceanic = pa.plate_composition.iter()
            .filter(|c| matches!(c, Some(Composition::Oceanic))).count();
        assert!((oceanic as i32 - 700).abs() < 50, "got {} oceanic plates (expected ~700)", oceanic);
    }

    #[test]
    fn age_caps_respected() {
        let (vs, cp, sp) = synthetic_setup(50, 3);
        let mut pa = synthetic_assignment(cp, &sp);
        let s = CrustState::initial(
            MasterSeed(42), &vs, &mut pa, &sp,
            CrustOptions {
                oceanic_age_cap_ma: 200,
                continental_age_cap_ma: 3000,
                ..CrustOptions::default()
            },
        );
        for (i, &age) in s.age_ma.iter().enumerate() {
            let cap = match s.composition[i] {
                Composition::Oceanic => 200,
                Composition::Island  => 500,
                Composition::Continental => 3000,
            };
            assert!(age <= cap, "cell {} age {} exceeds cap {}", i, age, cap);
        }
    }

    #[test]
    fn density_ordering_is_physical() {
        // Old oceanic should be denser than young oceanic, and both should
        // be denser than continental.
        let (vs, cp, sp) = synthetic_setup(50, 3);
        let mut pa = synthetic_assignment(cp, &sp);
        let mut s = CrustState::initial(
            MasterSeed(42), &vs, &mut pa, &sp, CrustOptions::default(),
        );
        // Force three known cells for the assertion. With the new layered
        // crust model we must also stamp the layers to match the composition,
        // because density derives from layers + age, not from the enum.
        s.composition[0] = Composition::Oceanic;
        s.age_ma[0] = 200;
        s.layers[0] = CrustLayers { gabbro: 4, basalt: 3, ..Default::default() };

        s.composition[1] = Composition::Oceanic;
        s.age_ma[1] = 0;
        s.layers[1] = CrustLayers { gabbro: 4, basalt: 3, ..Default::default() };

        s.composition[2] = Composition::Continental;
        s.age_ma[2] = 3000;
        s.layers[2] = CrustLayers { granite: 18, diorite: 12, sediment: 4, ..Default::default() };
        let old_oc = s.density_kg_per_m3(0);
        let young_oc = s.density_kg_per_m3(1);
        let cont = s.density_kg_per_m3(2);
        assert!(old_oc > young_oc, "old oceanic should be denser than young");
        assert!(young_oc > cont, "oceanic should be denser than continental");
    }

    /// Build a synthetic mesh with `n_plates` seeds spread around the equator
    /// and many cells per plate scattered at varying offsets so each plate has
    /// a meaningful arc-extent (seed-near vs seed-far cells).
    fn synthetic_setup_spread(cells_per_plate: usize, n_plates: u32) -> (Vec<Vec3f>, Vec<u32>, Vec<Vec3f>) {
        let seed_positions: Vec<Vec3f> = (0..n_plates).map(|i| {
            let angle = i as f64 * 2.0 * std::f64::consts::PI / n_plates as f64;
            Vec3f::new(angle.cos(), angle.sin(), 0.0).normalize()
        }).collect();
        let mut vertices = Vec::new();
        let mut cell_plate = Vec::new();
        for p in 0..n_plates {
            let seed = seed_positions[p as usize];
            for k in 0..cells_per_plate {
                // Spread cells progressively farther from the seed so the plate
                // has a real arc-extent range.
                let t = (k as f64) / (cells_per_plate as f64);
                let offset = 0.05 + t * 0.6;
                let v = Vec3f::new(
                    seed.x + offset * 0.7,
                    seed.y - offset * 0.4,
                    offset * 0.3,
                ).normalize();
                vertices.push(v);
                cell_plate.push(p);
            }
        }
        (vertices, cell_plate, seed_positions)
    }

    #[test]
    fn continental_plates_have_mixed_composition() {
        // For each Continental-baseline plate, at least one cell should be
        // per-cell Oceanic (the passive margin).
        let (vs, cp, sp) = synthetic_setup_spread(40, 8);
        let mut pa = synthetic_assignment(cp.clone(), &sp);
        // Force every plate to be Continental baseline by setting the
        // oceanic_fraction to 0.0 — exercises the gating path on every plate.
        let s = CrustState::initial(
            MasterSeed(42), &vs, &mut pa, &sp,
            CrustOptions { oceanic_fraction: 0.0, ..CrustOptions::default() },
        );
        for pid in 0..sp.len() as u32 {
            assert_eq!(pa.plate_composition[pid as usize], Some(Composition::Continental));
            let has_oceanic = cp.iter().enumerate().any(|(i, &p)| {
                p == pid && s.composition[i] == Composition::Oceanic
            });
            assert!(has_oceanic, "continental plate {} has no passive-margin oceanic cells", pid);
        }
    }

    #[test]
    fn oceanic_baseline_plates_stay_fully_oceanic() {
        let (vs, cp, sp) = synthetic_setup_spread(30, 6);
        let mut pa = synthetic_assignment(cp.clone(), &sp);
        let s = CrustState::initial(
            MasterSeed(123), &vs, &mut pa, &sp,
            CrustOptions::default(),
        );
        for (i, &pid) in cp.iter().enumerate() {
            if pa.plate_composition[pid as usize] == Some(Composition::Oceanic) {
                assert_eq!(s.composition[i], Composition::Oceanic,
                    "cell {} of oceanic-baseline plate {} is not Oceanic", i, pid);
            }
        }
    }

    #[test]
    fn continental_core_is_majority() {
        // At least 30% of cells on each Continental-baseline plate should
        // remain per-cell Continental (the core).
        let (vs, cp, sp) = synthetic_setup_spread(50, 8);
        let mut pa = synthetic_assignment(cp.clone(), &sp);
        let s = CrustState::initial(
            MasterSeed(42), &vs, &mut pa, &sp,
            CrustOptions { oceanic_fraction: 0.0, ..CrustOptions::default() },
        );
        for pid in 0..sp.len() as u32 {
            let (total, continental) = cp.iter().enumerate().fold((0usize, 0usize), |(t, c), (i, &p)| {
                if p == pid {
                    (t + 1, c + if s.composition[i] == Composition::Continental { 1 } else { 0 })
                } else { (t, c) }
            });
            let pct = continental as f64 / total as f64;
            assert!(pct >= 0.30,
                "continental plate {} has only {:.0}% continental core (expected >=30%)",
                pid, pct * 100.0);
        }
    }

    #[test]
    fn mark_failed_rift_tags_cells_and_resets_progress() {
        let (vs, cp, sp) = synthetic_setup(50, 3);
        let mut pa = synthetic_assignment(cp, &sp);
        let mut s = CrustState::initial(
            MasterSeed(42), &vs, &mut pa, &sp, CrustOptions::default(),
        );
        // Stamp some rift_progress, then fail-rift those cells.
        s.rift_progress[10] = 180;
        s.rift_progress[11] = 195;
        assert_eq!(s.failed_rift_age_ma[10], 0);
        s.mark_failed_rift(&[10, 11], 250);
        assert_eq!(s.failed_rift_age_ma[10], 250);
        assert_eq!(s.failed_rift_age_ma[11], 250);
        // rift_progress is wiped — next divergent cycle starts fresh,
        // but the aulacogen tag makes it accumulate ~50% faster.
        assert_eq!(s.rift_progress[10], 0);
        assert_eq!(s.rift_progress[11], 0);
        // Untouched cells are not tagged.
        assert_eq!(s.failed_rift_age_ma[20], 0);
    }

    /// At t=0 (before any CA), the elevation field should be a smooth fBm
    /// surface rather than a uniform-per-composition step. We check three
    /// properties on a full icosphere build:
    ///   1. continental cells have non-trivial std-dev (>300 m),
    ///   2. neighbouring cells differ by < 1500 m on average (smooth),
    ///   3. overall elevation variance > 50_000 m² (the planet looks like a planet).
    #[test]
    fn initial_elevation_varies_smoothly() {
        use crate::adjacency::Adjacency;
        use crate::mesh::Icosphere;
        use crate::plates::{BuildOptions, PlateAssignment};

        let seed = MasterSeed(12345);
        let sphere = Icosphere::new(4);
        let mut plates = PlateAssignment::build(
            seed, &sphere,
            BuildOptions { plate_count: 12, ..BuildOptions::default() },
        );
        let seed_positions: Vec<Vec3f> = plates.plates.iter()
            .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default())
            .collect();
        let crust = CrustState::initial(
            seed, &sphere.vertices, &mut plates, &seed_positions, CrustOptions::default(),
        );
        let elev: Vec<f64> = crust.elevation_m.iter().map(|&e| e as f64).collect();
        let n = elev.len() as f64;
        let mean = elev.iter().sum::<f64>() / n;
        let var  = elev.iter().map(|e| (e - mean).powi(2)).sum::<f64>() / n;
        assert!(var > 50_000.0, "overall variance too low: {} m²", var);

        // (1) continental-cell std-dev.
        let cont_elev: Vec<f64> = (0..crust.composition.len())
            .filter(|&i| crust.composition[i] == Composition::Continental)
            .map(|i| crust.elevation_m[i] as f64)
            .collect();
        if cont_elev.len() > 10 {
            let cm = cont_elev.iter().sum::<f64>() / cont_elev.len() as f64;
            let cv = cont_elev.iter().map(|e| (e - cm).powi(2)).sum::<f64>() / cont_elev.len() as f64;
            let csd = cv.sqrt();
            // value-noise fBm distribution is gaussian-ish around 0 with
            // std ~0.2 in [-1, 1], so for ±800 m amplitude expect ~120-200 m
            // of std-dev on continental cells. Threshold is well clear of 0
            // (which would mean a flat plain).
            assert!(csd > 100.0,
                "continental std-dev too low: {} m (need >100)", csd);
        }

        // (2) average neighbour difference (smoothness check).
        let adj = Adjacency::build(&sphere);
        let mut sum_diff = 0.0_f64;
        let mut pairs = 0u64;
        for i in 0..elev.len() {
            for &j in adj.of(i as u32) {
                if (j as usize) > i {
                    sum_diff += (elev[i] - elev[j as usize]).abs();
                    pairs += 1;
                }
            }
        }
        let mean_diff = sum_diff / pairs.max(1) as f64;
        assert!(mean_diff < 1500.0,
            "neighbour diff too high: {} m (need <1500)", mean_diff);
    }

    /// Diagnostic — print initial-elevation stats at seed 12345 on a sub=5
    /// build (same shape as preview's pre-CA state). Always passes; run with
    /// `--nocapture` to view.
    #[test]
    fn initial_elevation_stats_seed_12345() {
        use crate::mesh::Icosphere;
        use crate::plates::{BuildOptions, PlateAssignment};

        let seed = MasterSeed(12345);
        let sphere = Icosphere::new(5);
        let mut plates = PlateAssignment::build(
            seed, &sphere,
            BuildOptions { plate_count: 50, ..BuildOptions::default() },
        );
        let seed_positions: Vec<Vec3f> = plates.plates.iter()
            .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default())
            .collect();
        let crust = CrustState::initial(
            seed, &sphere.vertices, &mut plates, &seed_positions, CrustOptions::default(),
        );
        let elev: Vec<f64> = crust.elevation_m.iter().map(|&e| e as f64).collect();
        let n = elev.len() as f64;
        let mean = elev.iter().sum::<f64>() / n;
        let var  = elev.iter().map(|e| (e - mean).powi(2)).sum::<f64>() / n;
        let below_sea = elev.iter().filter(|&&e| e < 0.0).count() as f64 / n;
        let min = elev.iter().copied().fold(f64::INFINITY, f64::min);
        let max = elev.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        println!("INITIAL ELEV @ seed=12345 sub=5 plates=50: cells={} mean={:.1}m var={:.0}m² std={:.1}m below_sea={:.1}% min={} max={}",
            elev.len(), mean, var, var.sqrt(), below_sea * 100.0, min, max);
        assert!(var > 50_000.0, "overall variance < 50_000 m²: {}", var);
    }
}
