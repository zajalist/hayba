//! Plate registry + initial Voronoi-on-sphere assignment.
//!
//! ## Public interface
//!
//! - [`Plate`] — single plate's identity, seed position, lineage (parent_id,
//!   birth/division step), and viewer color.
//! - [`PlateAssignment`] — slot-map registry of `Vec<Option<Plate>>` plus the
//!   per-cell ownership array. Holds boundary edges, triple junctions, and a
//!   lock-step per-plate baseline composition.
//! - [`BuildOptions`] — knobs for the initial build pass (plate count, Power
//!   Diagram vs Lloyd, Pareto α, junction sweep passes).
//! - [`PlateAssignment::build`] — one-shot constructor invoked by the sim
//!   harness; runs Power Diagram (default) or Lloyd relaxation then sweeps
//!   quad+ junctions.
//! - [`PlateAssignment::allocate`] / [`PlateAssignment::retire`] — atomic
//!   registry mutations. IDs are monotonic `u32` and never reused (M0.1).
//! - [`PlateAssignment::live_plates`] / [`PlateAssignment::plate`] /
//!   [`PlateAssignment::plate_composition`] — read-only lookups that skip
//!   retired slots.
//! - [`PlateAssignment::prune_empty`] — clear out empty-at-init slots while
//!   keeping the motion array lock-step (INV-4).
//! - [`resolve_high_order_junctions`], [`extract_boundary_topology`] —
//!   junction-sweep / boundary-detection helpers reused by tests.
//!
//! ## Build pipeline
//!
//! 1. **Seed placement** — Power Diagram (Fibonacci spiral + Pareto weights,
//!    Bird-2003 bimodal sizes) by default, or random seeds + Lloyd relaxation
//!    on the legacy path.
//! 2. **Junction sweep** — for any mesh vertex whose 1-ring touches 4+ plate
//!    ids, reassign the central cell to its most-common neighbour plate.
//!    Repeated for [`BuildOptions::junction_sweep_passes`] (INV-5).
//! 3. **Topology extraction** — record boundary edges + triple-junction
//!    vertices for the viewer.
//!
//! The downstream [`crate::lifecycle`] module then takes over for spawn /
//! retire / rift fork / passive CC enforcement.

use hayba_seeds::{derive_scope, MasterSeed, Scope, SeedStream};

use crate::adjacency::Adjacency;
use crate::crust_state::Composition;
use crate::mesh::{Icosphere, Vec3f};

/// One plate's identity row. Lives inside [`PlateAssignment::plates`] at
/// index `id`. Retired plates leave a `None` slot — `id` values are
/// monotonic and never reused (M0.1).
#[derive(Debug, Clone)]
pub struct Plate {
    /// Stable monotonic id; equals the slot index inside the registry.
    pub id: u32,
    /// Voronoi seed position on the unit sphere. Refreshed every 8
    /// macro-steps to the live cell centroid.
    pub seed_pos: Vec3f,
    /// RGB viewer color. Children inherit a hue-shifted variant of their
    /// parent's color so genealogy is visible in the rendered timeline.
    pub color: [u8; 3],
    /// Plate this one descended from via rift fork (or passive split).
    /// `None` for plates created at sim init.
    pub parent_id: Option<u32>,
    /// Macro-step at which this plate was born. 0 for init-time plates.
    pub birth_macro_step: u32,
    /// Macro-step at which this plate last underwent rift fork (active or
    /// passive). `None` for plates that have never forked — init-time
    /// plates start here and are immediately eligible. M0.4 onward updates
    /// this on each fork event.
    pub last_division_step: Option<u32>,
    /// **B3 (Wilson cycle) — age (in Ma) since the plate last underwent
    /// a passive split.** Incremented by `dt_ma` every macro-step in
    /// `post_step`; reset to 0 when the plate is the subject of an
    /// age-triggered passive split. Used to enforce the ≥100 Ma split
    /// cooldown so freshly-divided plates aren't immediately re-split.
    pub age_since_last_split: u16,
}

#[derive(Debug, Clone)]
pub struct PlateAssignment {
    /// Slot map of plates indexed by stable monotonic id. `None` slots are
    /// retired plates — their ids are never reused. Cells in `cell_plate`
    /// always reference a `Some` slot (INV-2).
    pub plates: Vec<Option<Plate>>,
    /// Next id to allocate when spawning a new plate. Monotonic; only ever
    /// increases. Equals `plates.len()` immediately after construction.
    pub(crate) next_id_counter: u32,
    pub cell_plate: Vec<u32>,
    /// Edges (a, b) where vertices a and b are adjacent on the mesh AND
    /// belong to different plates. Each edge listed once (a < b).
    pub boundary_edges: Vec<[u32; 2]>,
    /// Mesh vertices that lie at junctions of exactly 3 plates. After the
    /// junction sweep these are the only multi-plate vertices left.
    pub triple_junctions: Vec<u32>,
    /// Diagnostic — should always be 0 after the junction sweep. If
    /// non-zero, the sweep didn't converge and the partition is degenerate.
    pub residual_quad_junctions: u32,
    /// Per-plate baseline composition, indexed lock-step with `plates`. A
    /// retired plate's slot is `None` here too. Initialised by
    /// `CrustState::initial` (per-plate composition roll lives there); kept
    /// in sync with the registry by [`allocate`] and [`retire`].
    pub(crate) plate_composition: Vec<Option<Composition>>,
}

/// Build-time knobs for [`PlateAssignment::build`].
pub struct BuildOptions {
    /// Target number of initial plate seeds. Power Diagram may swallow a few,
    /// so the live count after `prune_empty` is typically slightly lower.
    pub plate_count: u32,
    /// Lloyd-relaxation iterations on the legacy random-seed path. Ignored
    /// when `use_power_diagram` is true.
    pub lloyd_iterations: u32,
    /// Junction-sweep passes — repeats [`resolve_high_order_junctions`] until
    /// no quad+ junctions remain (INV-5) or the budget runs out.
    pub junction_sweep_passes: u32,
    /// If true, initial plate placement uses the Power Diagram (Fibonacci
    /// spiral + Pareto weights) instead of Lloyd-relaxed equal-weight
    /// Voronoi. Produces Bird-2003-like bimodal plate size distribution.
    /// When true, `lloyd_iterations` is ignored — Power Diagram is the
    /// final placement.
    pub use_power_diagram: bool,
    /// Pareto α for the Power Diagram weight distribution (lower α → more
    /// extreme size spread).
    pub pareto_alpha: f64,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            plate_count: 50,
            lloyd_iterations: 8,
            junction_sweep_passes: 4,
            use_power_diagram: true,
            pareto_alpha: 1.0,
        }
    }
}

impl PlateAssignment {
    /// One-shot constructor: place seeds, assign every cell to its owning
    /// plate, and sweep quad+ junctions until INV-5 holds (or the
    /// `junction_sweep_passes` budget runs out). The returned assignment is
    /// the canonical "t=0" partition fed into [`crate::crust_state::CrustState::initial`].
    pub fn build(master: MasterSeed, sphere: &Icosphere, opts: BuildOptions) -> Self {
        let adjacency = Adjacency::build(sphere);

        let (plates, mut cell_plate) = if opts.use_power_diagram {
            // Week-1 path: Power Diagram with Fibonacci spiral + Pareto weights.
            // Produces bimodal plate-size distribution (Pacific-style giants
            // + microplates).
            let pd = crate::power_diagram::PowerAssignment::build(
                master,
                &sphere.vertices,
                crate::power_diagram::PowerOptions {
                    plate_count: opts.plate_count,
                    pareto_alpha: opts.pareto_alpha,
                    jitter_strength: 0.15,
                    domain_warp: 0.80,
                    boundary_noise: 0.85,
                    era_phase: 0.70,  // Default = modern Earth.
                },
            );
            let plates: Vec<Plate> = pd.seeds.into_iter().map(|s| Plate {
                id: s.id,
                seed_pos: s.position,
                color: s.color,
                parent_id: None,
                birth_macro_step: 0,
                last_division_step: None,
                age_since_last_split: 0,
            }).collect();
            let cell_plate: Vec<u32> = pd.cell_plate.into_iter().map(|p| p as u32).collect();
            (plates, cell_plate)
        } else {
            // Legacy path: random seeds + Lloyd-relaxed equal-weight Voronoi.
            let tectonic_seed = derive_scope(master, Scope::Tectonic);
            let mut stream = SeedStream::new(tectonic_seed);
            let mut plates = sample_initial_plates(&mut stream, opts.plate_count, master);
            let mut cell_plate = assign_to_nearest(&sphere.vertices, &plates);
            for _ in 0..opts.lloyd_iterations {
                let centroids = compute_plate_centroids(&sphere.vertices, &cell_plate, plates.len());
                for (i, c) in centroids.iter().enumerate() {
                    if let Some(c) = c {
                        plates[i].seed_pos = c.normalize();
                    }
                }
                cell_plate = assign_to_nearest(&sphere.vertices, &plates);
            }
            (plates, cell_plate)
        };

        // Junction sweep: detect 4+ way junctions and resolve to triples.
        let mut residual = 0u32;
        for _ in 0..opts.junction_sweep_passes {
            residual = resolve_high_order_junctions(&mut cell_plate, &adjacency);
            if residual == 0 { break; }
        }

        let (boundary_edges, triple_junctions) =
            extract_boundary_topology(&cell_plate, &adjacency);

        let next_id_counter = plates.len() as u32;
        let plate_composition = vec![Some(Composition::Oceanic); plates.len()];
        let plates: Vec<Option<Plate>> = plates.into_iter().map(Some).collect();

        Self {
            plates,
            next_id_counter,
            cell_plate,
            boundary_edges,
            triple_junctions,
            residual_quad_junctions: residual,
            plate_composition,
        }
    }

    /// Retire any plate slots whose live cell count is zero, keeping the
    /// motion array aligned (INV-4). Power Diagram occasionally produces
    /// "swallowed microplate" slots at init — call this after sampling
    /// motions so the registry, motion array, and cell ownership all line
    /// up with INV-1 / INV-2 / INV-4.
    pub fn prune_empty<T>(&mut self, motions: &mut Vec<Option<T>>) {
        debug_assert_eq!(self.plates.len(), motions.len(), "INV-4 before prune");
        debug_assert_eq!(self.plates.len(), self.plate_composition.len(), "comp slot lock-step before prune");
        let mut counts = vec![0u32; self.plates.len()];
        for &id in &self.cell_plate { counts[id as usize] += 1; }
        for (i, c) in counts.iter().enumerate() {
            if *c == 0 {
                self.plates[i] = None;
                motions[i] = None;
                self.plate_composition[i] = None;
            }
        }
    }

    /// Number of currently live plates (registry slots that are `Some`).
    /// Differs from `plates.len()` once any plate has retired.
    pub fn live_count(&self) -> usize {
        self.plates.iter().filter(|p| p.is_some()).count()
    }

    /// Allocate a new plate atomically: push the plate and its baseline
    /// composition into the registry, advance the monotonic id counter, and
    /// return the new id. IDs are never reused — once a slot is set to
    /// `None`, that id is gone for the rest of the sim.
    ///
    /// **Invariant:** after this call, `plates.len() == plate_composition.len()`
    /// and the new slot's `Plate.id` equals the returned id.
    pub fn allocate(&mut self, mut plate: Plate, composition: Composition) -> u32 {
        let id = self.next_id_counter;
        plate.id = id;
        debug_assert_eq!(self.plates.len(), self.plate_composition.len(),
            "INV-4: registry / comp lock-step before allocate");
        // Push first, then bump the counter. If a push panics (OOM), the
        // counter stays put so the registry / counter relationship doesn't
        // get permanently desynced.
        self.plates.push(Some(plate));
        self.plate_composition.push(Some(composition));
        debug_assert_eq!(self.plates.len(), self.plate_composition.len(),
            "INV-4: registry / comp lock-step after allocate pushes");
        self.next_id_counter += 1;
        id
    }

    /// Peek at the id that the next call to [`allocate`] will assign. Read-only;
    /// callers that need a prospective id for hue derivation or logging use
    /// this rather than touching the private counter.
    pub fn peek_next_id(&self) -> u32 {
        self.next_id_counter
    }

    /// Borrow the per-plate baseline composition slice. Lock-step with
    /// [`plates`]: `None` slots are retired plates.
    pub fn plate_compositions(&self) -> &[Option<Composition>] {
        &self.plate_composition
    }

    /// Retire a plate: zero its slot in both the plate registry and the
    /// per-plate composition vector. Callers handle the motion array
    /// separately (see [`crate::lifecycle::retire`]).
    pub fn retire(&mut self, id: u32) {
        let i = id as usize;
        debug_assert!(i < self.plates.len(), "retire: id {} out of range", id);
        self.plates[i] = None;
        self.plate_composition[i] = None;
    }

    /// Borrow the per-plate baseline composition by id; `None` if the slot
    /// is retired or out of range.
    pub fn plate_composition(&self, id: u32) -> Option<Composition> {
        self.plate_composition.get(id as usize).copied().flatten()
    }

    /// Iterate over `(id, &Plate)` pairs for all live plates, in id order.
    pub fn live_plates(&self) -> impl Iterator<Item = (u32, &Plate)> {
        self.plates.iter().enumerate().filter_map(|(i, p)| p.as_ref().map(|p| (i as u32, p)))
    }

    /// Borrow a plate by id; returns `None` if the slot is retired or out of range.
    pub fn plate(&self, id: u32) -> Option<&Plate> {
        self.plates.get(id as usize).and_then(|p| p.as_ref())
    }
}

// ── Seeding ──────────────────────────────────────────────────────────────

fn sample_initial_plates(
    stream: &mut SeedStream,
    plate_count: u32,
    _master: MasterSeed,
) -> Vec<Plate> {
    let mut plates = Vec::with_capacity(plate_count as usize);
    for id in 0..plate_count {
        // z uniform in [-1, 1], θ uniform in [0, 2π) — equal-area on sphere.
        let z = u64_to_unit(stream.next_u64()) * 2.0 - 1.0;
        let theta = u64_to_unit(stream.next_u64()) * std::f64::consts::TAU;
        let r = (1.0 - z * z).max(0.0).sqrt();
        let seed_pos = Vec3f::new(r * theta.cos(), r * theta.sin(), z);

        let hue = (id as f64) * 137.508_f64;
        let color = hsv_to_rgb(hue % 360.0, 0.65, 0.92);

        plates.push(Plate { id, seed_pos, color, parent_id: None, birth_macro_step: 0, last_division_step: None, age_since_last_split: 0 });
    }
    plates
}

// ── Assignment ───────────────────────────────────────────────────────────

fn assign_to_nearest(vertices: &[Vec3f], plates: &[Plate]) -> Vec<u32> {
    vertices.iter().map(|v| {
        let mut best = 0u32;
        let mut best_dot = f64::NEG_INFINITY;
        for p in plates {
            let d = v.dot(p.seed_pos);
            if d > best_dot { best_dot = d; best = p.id; }
        }
        best
    }).collect()
}

// ── Lloyd centroids ──────────────────────────────────────────────────────

fn compute_plate_centroids(
    vertices: &[Vec3f],
    cell_plate: &[u32],
    plate_count: usize,
) -> Vec<Option<Vec3f>> {
    let mut sums = vec![Vec3f::default(); plate_count];
    let mut counts = vec![0u32; plate_count];
    for (i, v) in vertices.iter().enumerate() {
        let p = cell_plate[i] as usize;
        sums[p] = Vec3f::new(sums[p].x + v.x, sums[p].y + v.y, sums[p].z + v.z);
        counts[p] += 1;
    }
    sums.into_iter().zip(counts).map(|(s, c)| {
        if c == 0 {
            None  // empty plate — leave seed where it is
        } else {
            let inv = 1.0 / c as f64;
            Some(Vec3f::new(s.x * inv, s.y * inv, s.z * inv))
        }
    }).collect()
}

// ── Junction sweep ───────────────────────────────────────────────────────

/// One sweep of the discrete junction resolver: for every mesh vertex whose
/// 1-ring touches ≥4 distinct plate ids, reassign the central cell to its
/// most-common neighbour plate (tie-break: smallest id). Returns the number
/// of pathological vertices left untouched — callers iterate until this hits
/// zero or the budget runs out (INV-5).
pub fn resolve_high_order_junctions(
    cell_plate: &mut [u32],
    adjacency: &Adjacency,
) -> u32 {
    let n = cell_plate.len() as u32;
    let mut residual = 0u32;

    // Iterate in vertex-id order for determinism. For each vertex, look at
    // its 1-ring neighbors' plate ids. If the central vertex plus its
    // neighbors expose 4+ distinct plates around this vertex, reassign the
    // central vertex to its most-common neighbor plate to absorb it into
    // one of the touching regions.
    for v in 0..n {
        let mut seen = [u32::MAX; 8];
        let mut count = 0usize;
        let center_plate = cell_plate[v as usize];
        seen[count] = center_plate; count += 1;

        let neighbors = adjacency.of(v);
        for &nb in neighbors {
            let p = cell_plate[nb as usize];
            if !seen[..count].contains(&p) {
                if count < seen.len() { seen[count] = p; count += 1; }
            }
        }

        if count >= 4 {
            // Tally how many neighbors belong to each plate id, excluding
            // the central vertex's current plate. We must change the central
            // vertex to a DIFFERENT plate; staying put doesn't reduce the
            // junction order.
            let mut tally = [(u32::MAX, 0u32); 8];
            let mut tally_len = 0usize;
            for &nb in neighbors {
                let p = cell_plate[nb as usize];
                if p == center_plate { continue; }
                let mut found = false;
                for slot in tally.iter_mut().take(tally_len) {
                    if slot.0 == p { slot.1 += 1; found = true; break; }
                }
                if !found && tally_len < tally.len() {
                    tally[tally_len] = (p, 1);
                    tally_len += 1;
                }
            }
            if tally_len > 0 {
                // Pick the most-common neighbor plate (tiebreak: smallest id).
                tally[..tally_len].sort_unstable_by(|a, b| {
                    b.1.cmp(&a.1).then(a.0.cmp(&b.0))
                });
                cell_plate[v as usize] = tally[0].0;
            } else {
                // Pathological: 4+ plates touch this vertex but the center
                // is its own island. Leave it; flag for diagnostic.
                residual += 1;
            }
        }
    }

    residual
}

// ── Boundary extraction ──────────────────────────────────────────────────

/// Walk the mesh once to collect `(boundary_edges, triple_junctions)`:
/// edges `(a,b)` with `a < b` whose endpoints belong to different plates,
/// and mesh vertices whose 1-ring (including self) touches exactly 3 plate
/// ids. Used both during build and after CA-driven cell reassignment.
pub fn extract_boundary_topology(
    cell_plate: &[u32],
    adjacency: &Adjacency,
) -> (Vec<[u32; 2]>, Vec<u32>) {
    let n = cell_plate.len() as u32;
    let mut edges = Vec::new();
    let mut triple = Vec::new();

    for v in 0..n {
        let mut seen = [u32::MAX; 8];
        let mut count = 0usize;
        let cp = cell_plate[v as usize];
        seen[count] = cp; count += 1;

        for &nb in adjacency.of(v) {
            let np = cell_plate[nb as usize];
            if np != cp && v < nb {
                edges.push([v, nb]);
            }
            if !seen[..count].contains(&np) {
                if count < seen.len() { seen[count] = np; count += 1; }
            }
        }

        if count == 3 {
            triple.push(v);
        }
    }

    (edges, triple)
}

// ── Helpers ──────────────────────────────────────────────────────────────

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

    #[test]
    fn every_cell_assigned() {
        let sphere = Icosphere::new(3);
        let assignment = PlateAssignment::build(MasterSeed(42), &sphere, BuildOptions::default());
        assert_eq!(assignment.cell_plate.len(), sphere.vertices.len());
    }

    #[test]
    fn same_seed_same_assignment() {
        let sphere = Icosphere::new(3);
        let opts = BuildOptions::default();
        let a = PlateAssignment::build(MasterSeed(42), &sphere, BuildOptions { ..opts });
        let b = PlateAssignment::build(MasterSeed(42), &sphere, BuildOptions { ..BuildOptions::default() });
        assert_eq!(a.cell_plate, b.cell_plate);
    }

    #[test]
    fn no_residual_quad_junctions() {
        // The whole point: after the sweep, no mesh vertex should still be
        // touching 4+ plates.
        for &seed in &[42u64, 12345, 7, 999, 1_000_001] {
            let sphere = Icosphere::new(5);
            let a = PlateAssignment::build(MasterSeed(seed), &sphere, BuildOptions::default());
            assert_eq!(
                a.residual_quad_junctions, 0,
                "seed {} left {} quad junctions unresolved",
                seed, a.residual_quad_junctions,
            );
        }
    }

    #[test]
    fn triple_junctions_are_actually_triple() {
        let sphere = Icosphere::new(5);
        let a = PlateAssignment::build(MasterSeed(42), &sphere, BuildOptions::default());
        let adj = Adjacency::build(&sphere);

        for &v in &a.triple_junctions {
            let mut seen = [u32::MAX; 8];
            let mut count = 0;
            seen[count] = a.cell_plate[v as usize]; count += 1;
            for &nb in adj.of(v) {
                let p = a.cell_plate[nb as usize];
                if !seen[..count].contains(&p) {
                    seen[count] = p; count += 1;
                }
            }
            assert_eq!(count, 3, "triple junction vertex {} has {} plates", v, count);
        }
    }

    #[test]
    fn lloyd_relaxation_evens_plate_areas_legacy_path() {
        // Legacy property: Lloyd-relaxed equal-weight Voronoi produces
        // near-uniform plate sizes. Pre-Week-1 default behavior.
        let sphere = Icosphere::new(5);
        let a = PlateAssignment::build(
            MasterSeed(42),
            &sphere,
            BuildOptions {
                plate_count: 12,
                use_power_diagram: false,
                ..BuildOptions::default()
            },
        );

        let mut counts = vec![0u32; a.plates.len()];
        for &p in &a.cell_plate {
            counts[p as usize] += 1;
        }
        let max = *counts.iter().max().unwrap();
        let min = *counts.iter().min().unwrap().max(&1);
        let ratio = max as f64 / min as f64;
        assert!(ratio < 3.0, "Lloyd failed to even out plates: ratio {}", ratio);
    }

    #[test]
    fn power_diagram_produces_bimodal_areas() {
        // Week-1 property: Power Diagram with Pareto weights produces a
        // dramatically uneven size distribution — largest plate should be
        // many times the smallest.
        let sphere = Icosphere::new(5);
        let a = PlateAssignment::build(
            MasterSeed(42),
            &sphere,
            BuildOptions {
                plate_count: 24,
                use_power_diagram: true,
                ..BuildOptions::default()
            },
        );
        let mut counts = vec![0u32; a.plates.len()];
        for &p in &a.cell_plate {
            counts[p as usize] += 1;
        }
        let max = *counts.iter().max().unwrap();
        let min = *counts.iter().min().unwrap().max(&1);
        let ratio = max as f64 / min as f64;
        assert!(ratio >= 5.0, "Power Diagram failed to produce bimodal areas: ratio {}", ratio);
    }
}
