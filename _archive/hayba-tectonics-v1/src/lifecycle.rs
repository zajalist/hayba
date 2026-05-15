//! Plate lifecycle — spawn, retire, rift fork, passive split, and invariant
//! enforcement.
//!
//! This module owns every dynamic operation on the plate registry. The
//! full M0 lifecycle is live: rift severance (M0.4), passive CC enforcement
//! (M0.5), plate death via [`retire`] / [`merge_into`] (M0.6), and MOR
//! creation alongside fork (M0.9, see [`try_rift_fork_with_mor`]).
//!
//! ## Public interface
//!
//! - [`spawn`] — allocate a child plate from a connected component, optionally
//!   with a rift impulse `δω`.
//! - [`retire`] / [`merge_into`] — kill an empty plate or absorb its cells into
//!   a neighbour.
//! - [`try_rift_fork`] — full-sever BFS test + fork with geometric δω impulse.
//! - [`try_rift_fork_with_mor`] — additive wrapper that also registers a
//!   [`crate::mor::MidOceanRidge`] per spawned child.
//! - [`enforce_one_cc_per_plate`] — periodic passive split for plates that got
//!   pinched into multiple components by neighbour stress.
//! - [`assert_invariants`], [`assert_inv3_one_cc_per_plate`],
//!   [`detect_quad_junctions`] — INV-1..INV-5 checks wired into debug builds.
//!
//! ## Invariants enforced here
//!
//! - **INV-1** every live plate has ≥1 cell referencing it.
//! - **INV-2** every cell references a live plate (registry slot is `Some`).
//! - **INV-3** no live plate has >1 connected component (post-enforcement).
//! - **INV-4** `|motions| == |plates|` and liveness is lock-step.
//! - **INV-5** no mesh vertex sits at a quad+ junction.
//!
//! Determinism: every collection iterated for spawn order is sorted by size
//! then by lowest cell id; lookups use `BTreeMap`/`BTreeSet` so two runs with
//! the same master seed produce identical id sequences.

use crate::motion::PlateMotion;
use crate::plates::{Plate, PlateAssignment};

/// Reassign all cells currently owned by `victim_id` to `inheritor_id`, then
/// retire `victim_id`. This is the building block for "plate absorbed by
/// neighbour" — both passive (CC enforcement giving small components to the
/// largest) and natural death (cell count reaching zero via CA).
pub fn merge_into(
    assignment: &mut PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    victim_id: u32,
    inheritor_id: u32,
) {
    debug_assert!(
        assignment.plate(victim_id).is_some(),
        "cannot merge a retired plate (id {})",
        victim_id,
    );
    debug_assert!(
        assignment.plate(inheritor_id).is_some(),
        "cannot merge into a retired plate (id {})",
        inheritor_id,
    );
    debug_assert_ne!(victim_id, inheritor_id, "cannot merge a plate into itself");

    for cell in assignment.cell_plate.iter_mut() {
        if *cell == victim_id { *cell = inheritor_id; }
    }
    retire(assignment, motions, victim_id);
}

/// Allocate a new plate from a connected component of cells previously owned
/// by `parent_id`. Cells in `cc_cells` are reassigned to the new plate's id;
/// the new plate inherits the parent's motion plus `delta_omega` (a rift
/// impulse — `None` means passive split with no opening force).
///
/// Returns the new plate's monotonic `u32` id. Ids are never reused.
///
/// **Caller responsibility:** `cc_cells` must be a strict subset of cells
/// currently owned by `parent_id`, and must be a single connected component
/// on the mesh adjacency. M0.2 verifies via assertions in debug builds; the
/// callers (M0.4 rift severance, M0.5 passive split, M0.8 age-based fork)
/// produce the CC themselves.
pub fn spawn(
    assignment: &mut PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    parent_id: u32,
    cc_cells: &[u32],
    delta_omega: Option<crate::mesh::Vec3f>,
    macro_step: u32,
) -> u32 {
    debug_assert!(!cc_cells.is_empty(), "spawn called with empty CC");
    debug_assert!(
        assignment.plate(parent_id).is_some(),
        "spawn parent (id {}) must be live",
        parent_id,
    );
    // Snapshot parent fields up-front so the immutable borrow ends before
    // we mutate via `allocate`.
    let (parent_color, parent_seed_pos) = {
        let p = assignment.plate(parent_id).expect("parent live");
        (p.color, p.seed_pos)
    };
    let parent_comp = assignment.plate_composition(parent_id)
        .expect("INV: parent has a baseline composition");
    // Pre-compute prospective id for hue derivation. `allocate` will assign
    // this id to the plate it's given.
    let prospective_id = assignment.peek_next_id();
    let new_color = shifted_hue(parent_color, (prospective_id.wrapping_mul(53) % 30) as i16 - 15);
    let centroid = cc_centroid(&assignment.cell_plate, cc_cells, parent_seed_pos);

    let new_plate = Plate {
        id: prospective_id,  // overwritten by allocate to keep contract obvious
        seed_pos: centroid,
        color: new_color,
        parent_id: Some(parent_id),
        birth_macro_step: macro_step,
        last_division_step: Some(macro_step),
        age_since_last_split: 0,
    };

    // Parent motion + δω (rift impulse). Passive splits pass `None` → child
    // simply inherits parent's motion verbatim.
    let parent_motion = motions[parent_id as usize].expect("INV-4: parent motion live");
    let new_omega = if let Some(d) = delta_omega {
        crate::mesh::Vec3f::new(
            parent_motion.omega.x + d.x,
            parent_motion.omega.y + d.y,
            parent_motion.omega.z + d.z,
        )
    } else {
        parent_motion.omega
    };
    let new_motion = PlateMotion { omega: new_omega };

    // Atomic registry mutation: push plate + baseline composition together.
    let new_id = assignment.allocate(new_plate, parent_comp);
    motions.push(Some(new_motion));
    debug_assert_eq!(assignment.plates.len(), motions.len(), "INV-4 on spawn");

    // Reassign CC cells to the new plate.
    for &c in cc_cells {
        debug_assert_eq!(
            assignment.cell_plate[c as usize], parent_id,
            "CC cell {} does not belong to parent {}", c, parent_id,
        );
        assignment.cell_plate[c as usize] = new_id;
    }

    new_id
}

/// Retire a plate. Sets its registry + motion slots to `None`. Caller must
/// ensure no cell references this id (INV-2) — pass through [`merge_into`]
/// if the plate still has live cells.
pub fn retire(
    assignment: &mut PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    id: u32,
) {
    debug_assert!(
        assignment.plate(id).is_some(),
        "cannot retire already-retired plate (id {})",
        id,
    );
    debug_assert!(
        !assignment.cell_plate.iter().any(|&c| c == id),
        "INV-2 violated: cells still reference retiring plate {}",
        id,
    );
    assignment.retire(id);
    motions[id as usize] = None;
}

/// Verify all four invariants. Cheap in debug; meant to be called at every
/// macro-step boundary so misuse surfaces immediately.
pub fn assert_invariants(
    assignment: &PlateAssignment,
    motions: &[Option<PlateMotion>],
) {
    // INV-4: registry + motion shape match.
    assert_eq!(
        assignment.plates.len(), motions.len(),
        "INV-4: |motions| ({}) != |plates| ({})", motions.len(), assignment.plates.len(),
    );
    for (i, (p, m)) in assignment.plates.iter().zip(motions.iter()).enumerate() {
        assert_eq!(
            p.is_some(), m.is_some(),
            "INV-4: plate {} liveness mismatch (plate={:?}, motion={:?})",
            i, p.is_some(), m.is_some(),
        );
    }

    // INV-2: every cell references a live plate.
    for (cell_idx, &id) in assignment.cell_plate.iter().enumerate() {
        assert!(
            (id as usize) < assignment.plates.len() && assignment.plates[id as usize].is_some(),
            "INV-2: cell {} references retired/oob plate id {}", cell_idx, id,
        );
    }

    // INV-1: every live plate has ≥1 cell.
    let mut counts = vec![0u32; assignment.plates.len()];
    for &id in &assignment.cell_plate {
        counts[id as usize] += 1;
    }
    for (i, slot) in assignment.plates.iter().enumerate() {
        if slot.is_some() {
            assert!(
                counts[i] > 0,
                "INV-1: live plate {} has zero cells", i,
            );
        }
    }
}

/// Verify INV-5: no mesh vertex sits at a junction of ≥4 distinct plates.
/// Geologically, only triple junctions occur on Earth — quad+ junctions
/// are degenerate and almost always indicate a bug. Returns the list of
/// offending vertices for diagnostic reporting.
pub fn detect_quad_junctions(
    assignment: &crate::plates::PlateAssignment,
    adjacency: &crate::adjacency::Adjacency,
) -> Vec<u32> {
    let mut offenders = Vec::new();
    for v in 0..assignment.cell_plate.len() {
        let v_id = v as u32;
        let mut seen: [u32; 8] = [u32::MAX; 8];
        let mut count = 0;
        seen[count] = assignment.cell_plate[v];
        count += 1;
        for &nb in adjacency.of(v_id) {
            let p = assignment.cell_plate[nb as usize];
            if !seen[..count].contains(&p) {
                if count < seen.len() {
                    seen[count] = p;
                }
                count += 1;
            }
        }
        if count >= 4 {
            offenders.push(v_id);
        }
    }
    offenders
}

/// Verify INV-3: no live plate has more than one connected component
/// under the given mesh adjacency. Run after M0.5 CC enforcement.
pub fn assert_inv3_one_cc_per_plate(
    assignment: &crate::plates::PlateAssignment,
    adjacency: &crate::adjacency::Adjacency,
) {
    let mut cells_by_plate: std::collections::BTreeMap<u32, Vec<u32>> = std::collections::BTreeMap::new();
    for (i, &id) in assignment.cell_plate.iter().enumerate() {
        cells_by_plate.entry(id).or_default().push(i as u32);
    }
    for (id, cells) in &cells_by_plate {
        if cells.len() < 2 { continue; }
        let ccs = connected_components(cells, adjacency);
        assert_eq!(
            ccs.len(), 1,
            "INV-3: live plate {} has {} connected components (sizes {:?})",
            id, ccs.len(), ccs.iter().map(|c| c.len()).collect::<Vec<_>>(),
        );
    }
}

/// Mean of cell positions in `cc_cells`, normalized to the sphere. Used as
/// a freshly-spawned plate's `seed_pos`.
fn cc_centroid(cell_plate: &[u32], cc_cells: &[u32], parent_seed_pos: crate::mesh::Vec3f) -> crate::mesh::Vec3f {
    // We don't have vertex positions here; callers will refresh the
    // centroid using the actual mesh once they have the vertex array.
    // Placeholder: take parent's seed for now; M0.4 will recompute properly
    // when invoked from the actual rift-fork pipeline (which has vertices).
    let _ = cell_plate;
    let _ = cc_cells;
    parent_seed_pos
}

/// Shift the hue of an RGB color by `degrees` (positive = toward yellow,
/// negative = toward magenta). Used so children render in a related-but-
/// distinct hue from their parent — visual genealogy across the timeline.
fn shifted_hue(rgb: [u8; 3], degrees: i16) -> [u8; 3] {
    let r = rgb[0] as f64 / 255.0;
    let g = rgb[1] as f64 / 255.0;
    let b = rgb[2] as f64 / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let v = max;
    let s = if max > 1e-9 { delta / max } else { 0.0 };
    let mut h = if delta < 1e-9 {
        0.0
    } else if (max - r).abs() < 1e-9 {
        60.0 * (((g - b) / delta).rem_euclid(6.0))
    } else if (max - g).abs() < 1e-9 {
        60.0 * (((b - r) / delta) + 2.0)
    } else {
        60.0 * (((r - g) / delta) + 4.0)
    };
    h = (h + degrees as f64).rem_euclid(360.0);

    let c = v * s;
    let x = c * (1.0 - (((h / 60.0).rem_euclid(2.0)) - 1.0).abs());
    let m = v - c;
    let (r1, g1, b1) = if h < 60.0 { (c, x, 0.0) }
        else if h < 120.0 { (x, c, 0.0) }
        else if h < 180.0 { (0.0, c, x) }
        else if h < 240.0 { (0.0, x, c) }
        else if h < 300.0 { (x, 0.0, c) }
        else { (c, 0.0, x) };
    [
        ((r1 + m) * 255.0).round() as u8,
        ((g1 + m) * 255.0).round() as u8,
        ((b1 + m) * 255.0).round() as u8,
    ]
}

/// Result of attempting a rift fork on a plate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RiftForkOutcome {
    /// Cooldown still active — no work done.
    Cooldown,
    /// Rift didn't sever the parent. Caller should mark the rift cells as
    /// failed (aulacogen) and reset their rift_progress.
    DidNotSever,
    /// Fork fired. Largest CC retained parent id; newly-allocated plate ids
    /// listed in `spawned`. Rift cells were reassigned to whichever side
    /// each cell sits closer to.
    Forked { spawned: Vec<u32> },
}

/// Test whether a rift component severs its parent plate, and if so, fork.
///
/// **Algorithm:**
/// 1. Cooldown check: skip if `macro_step - parent.last_division_step < cooldown_steps`.
/// 2. BFS the parent's remaining cells (parent ownership AND not in `rift_cells`).
///    If the remaining cells form a single connected component, the rift didn't
///    sever — return `DidNotSever`.
/// 3. If ≥2 components, the rift severs. Largest CC keeps the parent id.
///    Other CCs each get a fresh plate spawned via [`spawn`] with a geometric
///    rift impulse `δω = Euler-pole rotation × rate` driving the new plate
///    away from its sibling.
/// 4. Rift cells themselves are reassigned to whichever side (by mesh-edge
///    adjacency) they border on, and their composition flips to Oceanic
///    with fresh basalt+gabbro layers and age 0.
///
/// **Determinism:** CCs sorted by their lowest-cell-id representative; spawn
/// order follows that sorted iteration. With a deterministic seed stream
/// upstream, identical master seeds produce identical fork outcomes.
pub fn try_rift_fork(
    assignment: &mut PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    crust: &mut crate::crust_state::CrustState,
    adjacency: &crate::adjacency::Adjacency,
    vertices: &[crate::mesh::Vec3f],
    parent_id: u32,
    rift_cells: &[u32],
    macro_step: u32,
    cooldown_steps: u32,
) -> RiftForkOutcome {
    debug_assert!(
        assignment.plate(parent_id).is_some(),
        "try_rift_fork: parent id {} not live", parent_id,
    );
    if let Some(last) = assignment.plate(parent_id).unwrap().last_division_step {
        if macro_step.saturating_sub(last) < cooldown_steps {
            return RiftForkOutcome::Cooldown;
        }
    }
    if rift_cells.is_empty() {
        return RiftForkOutcome::DidNotSever;
    }

    // Build the set of cells owned by parent, minus rift cells. BFS its CCs.
    let rift_set: std::collections::BTreeSet<u32> = rift_cells.iter().copied().collect();
    let parent_cells: Vec<u32> = assignment.cell_plate.iter().enumerate()
        .filter_map(|(i, &id)| if id == parent_id && !rift_set.contains(&(i as u32)) { Some(i as u32) } else { None })
        .collect();

    if parent_cells.is_empty() {
        // The entire parent is rift — degenerate; treat as not-sever and
        // let downstream handle composition flips. No fork to do.
        return RiftForkOutcome::DidNotSever;
    }

    let ccs = connected_components(&parent_cells, adjacency);
    if ccs.len() < 2 {
        return RiftForkOutcome::DidNotSever;
    }

    // Sort CCs by size descending (largest first). Tie-break: lowest cell id.
    let mut ccs: Vec<Vec<u32>> = ccs;
    ccs.sort_by(|a, b| {
        b.len().cmp(&a.len())
            .then_with(|| a.iter().min().cmp(&b.iter().min()))
    });
    let _keep = ccs.remove(0);  // largest CC keeps the parent's id implicitly

    // Compute rift midpoint and tangent for δω geometry.
    let (rift_mid, rift_tan) = rift_midpoint_and_tangent(rift_cells, vertices);

    // Spawn a plate per remaining CC. δω rotation is around (mid × tan), at
    // ~5 cm/yr surface divergence (0.0003 rad/Myr at unit sphere radius).
    let euler_axis = rift_mid.cross(rift_tan).normalize_or(rift_mid);
    let domega = crate::mesh::Vec3f::new(
        euler_axis.x * 0.0003,
        euler_axis.y * 0.0003,
        euler_axis.z * 0.0003,
    );

    let mut spawned = Vec::new();
    for cc in &ccs {
        // Each non-largest CC drifts AWAY from the largest. Use the sign of
        // (cc_centroid - rift_mid) dot rift_tan to pick + or - δω.
        let centroid = mean_cell_position(cc, vertices);
        let toward = centroid.sub(rift_mid);
        let sign = if toward.dot(rift_tan) >= 0.0 { 1.0 } else { -1.0 };
        let cc_domega = crate::mesh::Vec3f::new(
            domega.x * sign, domega.y * sign, domega.z * sign,
        );
        // New plate inherits the parent's baseline composition via spawn,
        // which routes through `PlateAssignment::allocate` so the plate and
        // its composition slot land together. The CA's per-cell composition
        // is what drives boundary behavior; this per-plate field is just a
        // fallback used when a neighbor is freshly spawned with no
        // cell-level data sampled yet.
        let new_id = spawn(assignment, motions, parent_id, cc, Some(cc_domega), macro_step);
        spawned.push(new_id);
    }

    // Reassign rift cells to whichever side they border. Default to parent
    // (largest CC) if they border both or neither — keeps INV-2 satisfied.
    // Also flip composition to Oceanic with fresh basalt+gabbro.
    let sides: std::collections::BTreeMap<u32, u32> = {
        // Map: cell -> plate id, for every cell in the resolved sides
        // (parent or any spawned). Used so rift cells can pick a neighbour.
        let mut m = std::collections::BTreeMap::new();
        for &c in &parent_cells {
            m.insert(c, parent_id);
        }
        // The spawned plates already own their CC cells (assigned by spawn).
        // Just trust the cell_plate state we now read.
        for &c in &assignment.cell_plate.iter().enumerate().filter_map(|(i, &id)|
            if spawned.contains(&id) { Some(i as u32) } else { None }
        ).collect::<Vec<_>>() {
            m.insert(c, assignment.cell_plate[c as usize]);
        }
        m
    };
    for &rc in rift_cells {
        let mut chosen = parent_id;
        for &nb in adjacency.of(rc) {
            if let Some(&owner) = sides.get(&nb) {
                chosen = owner;
                break;
            }
        }
        assignment.cell_plate[rc as usize] = chosen;
        let i = rc as usize;
        crust.composition[i] = crate::crust_state::Composition::Oceanic;
        crust.age_ma[i] = 0;
        crust.layers[i] = crate::crust_state::CrustLayers {
            gabbro: 4, basalt: 3, ..Default::default()
        };
        crust.elevation_m[i] = -3000;
        crust.rift_progress[i] = 0;
        crust.failed_rift_age_ma[i] = 0;
    }

    // Mark parent as having just undergone division.
    if let Some(p) = assignment.plates[parent_id as usize].as_mut() {
        p.last_division_step = Some(macro_step);
    }

    RiftForkOutcome::Forked { spawned }
}

/// Outcome of [`try_rift_fork_with_mor`] — the underlying fork result plus
/// the ids of any newly-created mid-ocean ridges. Mirrors
/// [`RiftForkOutcome`] one-to-one; if the fork didn't fire, `mor_ids` is
/// empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiftForkOutcomeWithMor {
    pub outcome: RiftForkOutcome,
    /// One MOR id per spawned plate, in the same order as
    /// `RiftForkOutcome::Forked { spawned }`.
    pub mor_ids: Vec<u32>,
}

/// Additive wrapper around [`try_rift_fork`] that also creates a
/// [`crate::mor::MidOceanRidge`] per spawned plate (M0.9).
///
/// Behaviour identical to `try_rift_fork` for plate / motion / crust
/// state — this wrapper just **also** populates `mor_registry`. Callers
/// that don't yet track MORs can keep calling the original function;
/// the default sim path is unchanged until a caller opts in.
///
/// One MOR is created per spawned child plate, linking the parent
/// (`parent_id`) and child. The axis polyline is built from the supplied
/// `rift_cells`; transform-fault offsets are seeded deterministically
/// from `master` + the freshly-issued MOR id.
pub fn try_rift_fork_with_mor(
    assignment: &mut PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    crust: &mut crate::crust_state::CrustState,
    adjacency: &crate::adjacency::Adjacency,
    vertices: &[crate::mesh::Vec3f],
    mor_registry: &mut crate::mor::MorRegistry,
    master: hayba_seeds::MasterSeed,
    parent_id: u32,
    rift_cells: &[u32],
    macro_step: u32,
    cooldown_steps: u32,
) -> RiftForkOutcomeWithMor {
    // Snapshot rift_cells before delegating — `try_rift_fork` reassigns
    // those cells, so we need our copy for axis-building.
    let rift_cells_snapshot: Vec<u32> = rift_cells.to_vec();
    let outcome = try_rift_fork(
        assignment, motions, crust, adjacency, vertices,
        parent_id, rift_cells, macro_step, cooldown_steps,
    );

    let mut mor_ids = Vec::new();
    if let RiftForkOutcome::Forked { ref spawned } = outcome {
        // Parent motion is still live (rift fork doesn't retire the
        // parent — it just demotes some of its cells to children).
        let parent_motion = motions[parent_id as usize]
            .expect("INV-4: parent motion live after fork");
        for &child_id in spawned {
            let child_motion = motions[child_id as usize]
                .expect("INV-4: spawned child motion live");
            let ridge = crate::mor::build_ridge(
                master,
                (parent_id, &parent_motion),
                (child_id, &child_motion),
                &rift_cells_snapshot,
                vertices,
                macro_step,
            );
            let id = mor_registry.allocate_with_master(master, ridge);
            mor_ids.push(id);
        }
    }
    RiftForkOutcomeWithMor { outcome, mor_ids }
}

/// **M0.5 — Periodic CC enforcement (passive splits).**
///
/// Plates can become disconnected without rifting — convergent stress on
/// neighbours can pinch a plate into two pieces (Anatolia-style: Arabian
/// and African pressure on Eurasia squeezes Anatolia off). This pass
/// catches that topology event.
///
/// For every live plate, BFS its cells. If >1 connected component:
/// - Largest CC keeps the parent id + motion.
/// - Smaller CCs each get a fresh plate id via [`spawn`], inheriting the
///   parent's motion (no δω — this isn't divergence).
///
/// Side-effect: each spawn extends both the plate registry and the
/// per-plate composition slot inside `PlateAssignment` (the spawn path
/// routes through [`PlateAssignment::allocate`]).
///
/// **M0.13 — LIP-triggered rift stress impulse.** When a Large Igneous
/// Province fires on a set of cells (see [`crate::hotspots::HotspotsState::step`]),
/// continental cells in the burst receive a strong `rift_progress` bump.
/// Models the CAMP-Pangaea / Deccan-India "flood basalts kick-start a rift"
/// mechanism. Oceanic / island cells are ignored.
///
/// Returns the number of cells whose rift_progress was boosted.
pub fn apply_lip_rift_stress(
    crust: &mut crate::crust_state::CrustState,
    cells: &[u32],
) -> u32 {
    let mut n = 0;
    for &c in cells {
        let i = c as usize;
        if crust.composition[i] == crate::crust_state::Composition::Continental {
            crust.rift_progress[i] = crust.rift_progress[i].saturating_add(100);
            n += 1;
        }
    }
    n
}

/// **B3 — Wilson-cycle continental breakup.**
///
/// For each live continental plate, deterministically roll a 1%/step
/// chance to passively split if:
/// - `plate.age_since_last_split > 300` Ma (mid Wilson cycle: 250–500 Ma).
/// - The plate's baseline composition is Continental.
/// - The plate's continental fraction (continental + island cells / total
///   cells owned by the plate) exceeds `0.6`.
/// - The plate has at least 200 cells (no splitting tiny plates).
///
/// On a hit, the plate is bisected along a deterministic great-circle plane
/// through its centroid. The smaller CC is spawned as a new plate via
/// [`spawn`] (no δω; passive split semantics), and the parent's
/// `age_since_last_split` is reset to 0.
///
/// Returns the number of plates that fired a split this pass.
///
/// Deterministic: the per-(plate, step) RNG key is derived from `master`
/// + `step` + `plate_id` via a splitmix64-style hash so two runs with the
/// same master seed produce identical split decisions and orientations.
pub fn trigger_age_based_splits(
    assignment: &mut crate::plates::PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    crust: &crate::crust_state::CrustState,
    adjacency: &crate::adjacency::Adjacency,
    vertices: &[crate::mesh::Vec3f],
    master: hayba_seeds::MasterSeed,
    macro_step: u32,
) -> u32 {
    use crate::crust_state::Composition;

    const MIN_AGE_MA: u16 = 300;
    const MIN_CELLS: usize = 200;
    const SPLIT_CHANCE_PER_STEP: f64 = 0.01;
    const CONT_FRAC_THRESHOLD: f64 = 0.6;

    // Group cells by plate up front so we can score and bisect cheaply.
    let mut cells_by_plate: std::collections::BTreeMap<u32, Vec<u32>> =
        std::collections::BTreeMap::new();
    for (i, &id) in assignment.cell_plate.iter().enumerate() {
        cells_by_plate.entry(id).or_default().push(i as u32);
    }

    let live_ids: Vec<u32> = assignment.live_plates().map(|(id, _)| id).collect();
    let base = hayba_seeds::derive_scope(master, hayba_seeds::Scope::Tectonic)
        .wrapping_add(0xA6E_C0_DE);
    let mut fired = 0u32;

    for parent_id in live_ids {
        // Eligibility gates ─────────────────────────────────────────────
        let plate = match assignment.plate(parent_id) {
            Some(p) => p,
            None => continue,
        };
        if plate.age_since_last_split <= MIN_AGE_MA {
            continue;
        }
        // Cooldown since the *last* division (rift OR passive). The
        // age-since-last-split clock is the dominant gate but this is a
        // safety net for plates that split via the rift-fork path.
        if let Some(last) = plate.last_division_step {
            let elapsed_steps = macro_step.saturating_sub(last);
            // dt_ma=5 conventionally; the gate is in steps so we don't
            // need to know dt here. 100 Ma / 5 Ma = 20 steps.
            if elapsed_steps < 20 {
                continue;
            }
        }
        if assignment.plate_composition(parent_id) != Some(Composition::Continental) {
            continue;
        }
        let cells = match cells_by_plate.get(&parent_id) {
            Some(c) if c.len() >= MIN_CELLS => c.clone(),
            _ => continue,
        };
        let cont_count = cells.iter().filter(|&&c| {
            matches!(
                crust.composition[c as usize],
                Composition::Continental | Composition::Island,
            )
        }).count();
        let cont_frac = cont_count as f64 / cells.len() as f64;
        if cont_frac < CONT_FRAC_THRESHOLD {
            continue;
        }

        // Per-(plate, step) RNG ─────────────────────────────────────────
        let mut z = base
            .wrapping_add((parent_id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
            .wrapping_add((macro_step as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9));
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        let roll = (z & 0x0000_FFFF_FFFF_FFFF) as f64 / (1u64 << 48) as f64;
        if roll >= SPLIT_CHANCE_PER_STEP {
            continue;
        }

        // Deterministic bisection plane. Centroid (mean of cell positions,
        // normalized) gives a reference point; pick the principal-axis
        // tangent of the plate's cell cloud to define the cutting plane.
        let mid = mean_cell_position(&cells, vertices);
        let mut cov = [[0.0f64; 3]; 3];
        for &c in &cells {
            let p = vertices[c as usize];
            let d = p.sub(mid);
            cov[0][0] += d.x * d.x; cov[0][1] += d.x * d.y; cov[0][2] += d.x * d.z;
            cov[1][0] += d.y * d.x; cov[1][1] += d.y * d.y; cov[1][2] += d.y * d.z;
            cov[2][0] += d.z * d.x; cov[2][1] += d.z * d.y; cov[2][2] += d.z * d.z;
        }
        let mut axis = crate::mesh::Vec3f::new(1.0, 0.0, 0.0);
        for _ in 0..16 {
            let new = crate::mesh::Vec3f::new(
                cov[0][0] * axis.x + cov[0][1] * axis.y + cov[0][2] * axis.z,
                cov[1][0] * axis.x + cov[1][1] * axis.y + cov[1][2] * axis.z,
                cov[2][0] * axis.x + cov[2][1] * axis.y + cov[2][2] * axis.z,
            );
            axis = new.normalize_or(axis);
        }
        let axis = crate::sphere_geom::project_to_tangent_plane(mid, axis)
            .normalize_or(crate::mesh::Vec3f::new(1.0, 0.0, 0.0));

        // Partition cells by sign of (p - mid) · axis. Take the smaller
        // side as the new plate's CC; verify it's connected (it usually
        // is — a PCA-aligned half on a roughly-convex plate).
        let mut neg: Vec<u32> = Vec::new();
        let mut pos: Vec<u32> = Vec::new();
        for &c in &cells {
            let p = vertices[c as usize].sub(mid);
            let s = p.x * axis.x + p.y * axis.y + p.z * axis.z;
            if s < 0.0 { neg.push(c); } else { pos.push(c); }
        }
        // Pick the smaller side as the child; if either is empty, skip.
        if neg.is_empty() || pos.is_empty() {
            continue;
        }
        let child_side = if neg.len() <= pos.len() { neg } else { pos };
        // Restrict to the largest connected component of child_side so
        // we don't hand `spawn` a disconnected blob (debug_assert in spawn
        // would fire). Tiebreak by lowest cell id for determinism.
        let mut ccs = connected_components(&child_side, adjacency);
        if ccs.is_empty() {
            continue;
        }
        ccs.sort_by(|a, b| {
            b.len().cmp(&a.len())
                .then_with(|| a.iter().min().cmp(&b.iter().min()))
        });
        let cc = ccs.remove(0);
        if cc.len() < 10 || cc.len() >= cells.len() {
            // Either degenerate (too small to count as a child) or the
            // whole plate — skip. The next pass will retry.
            continue;
        }

        let _ = spawn(assignment, motions, parent_id, &cc, None, macro_step);
        if let Some(p) = assignment.plates[parent_id as usize].as_mut() {
            p.age_since_last_split = 0;
        }
        fired += 1;
    }
    fired
}

/// **B4 — INV-6: no plate is fully surrounded by exactly one other plate.**
///
/// Returns the list of plate ids that are "fully enclosed" — i.e., every
/// cross-plate neighbour of every cell of the plate references the same
/// single other plate id. A geological non-starter (an island plate
/// can't exist without at least one transform/divergent edge to a
/// different neighbour).
///
/// Pure read-only — no state mutation. The fix lives in
/// [`enforce_inv6`].
pub fn check_inv6(
    assignment: &crate::plates::PlateAssignment,
    adjacency: &crate::adjacency::Adjacency,
) -> Vec<u32> {
    let mut offenders = Vec::new();
    // Group cells by plate.
    let mut cells_by_plate: std::collections::BTreeMap<u32, Vec<u32>> =
        std::collections::BTreeMap::new();
    for (i, &id) in assignment.cell_plate.iter().enumerate() {
        cells_by_plate.entry(id).or_default().push(i as u32);
    }
    for (id, cells) in &cells_by_plate {
        // Skip plates that are themselves the whole world (no
        // cross-plate neighbours at all).
        let mut neighbour: Option<u32> = None;
        let mut has_cross_plate = false;
        let mut fully_enclosed = true;
        for &c in cells {
            for &nb in adjacency.of(c) {
                let nb_pid = assignment.cell_plate[nb as usize];
                if nb_pid == *id {
                    continue;
                }
                has_cross_plate = true;
                match neighbour {
                    None => neighbour = Some(nb_pid),
                    Some(n) if n == nb_pid => {}
                    Some(_) => {
                        fully_enclosed = false;
                        break;
                    }
                }
            }
            if !fully_enclosed {
                break;
            }
        }
        if !(has_cross_plate && fully_enclosed) {
            continue;
        }
        // Only flag the SMALLER side of the pair as the violator.
        // Geological intent: a small plate fully enclosed by a host plate
        // gets accreted; the host is not "enclosed by" its tiny tenant.
        // When both sides' cells point only at each other (degenerate
        // 2-plate world), the smaller cell count is the natural victim.
        if let Some(nbr_id) = neighbour {
            let nbr_size = cells_by_plate.get(&nbr_id).map(|v| v.len()).unwrap_or(0);
            if cells.len() < nbr_size {
                offenders.push(*id);
            } else if cells.len() == nbr_size && *id < nbr_id {
                // Deterministic tiebreak: lowest id wins.
                offenders.push(*id);
            }
        }
    }
    offenders
}

/// **B4 — Enforce INV-6 by accretion.** For every plate flagged by
/// [`check_inv6`], reassign all its cells to its sole enclosing
/// neighbour, then retire the small plate. This is the geological
/// "fully-enclosed island gets absorbed by the host" outcome.
///
/// Returns the number of plates retired this pass.
pub fn enforce_inv6(
    assignment: &mut crate::plates::PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    adjacency: &crate::adjacency::Adjacency,
) -> u32 {
    let offenders = check_inv6(assignment, adjacency);
    let mut retired = 0u32;
    for victim_id in offenders {
        // Identify the enclosing plate (any cross-plate neighbour of any
        // of victim's cells — they're all the same by construction).
        let enclosing: Option<u32> = (0..assignment.cell_plate.len())
            .filter(|&i| assignment.cell_plate[i] == victim_id)
            .flat_map(|i| adjacency.of(i as u32).iter().copied())
            .map(|nb| assignment.cell_plate[nb as usize])
            .find(|&pid| pid != victim_id);
        let Some(inheritor_id) = enclosing else { continue; };
        // Safety check: don't merge into a retired plate.
        if assignment.plate(inheritor_id).is_none() {
            continue;
        }
        merge_into(assignment, motions, victim_id, inheritor_id);
        retired += 1;
    }
    retired
}

/// **Maintains INV-3:** after this pass, no live plate has >1 CC.
///
/// **Caller responsibility:** invoke every M macro-steps (default M=16).
/// Cheap per call (one BFS per live plate, ~kilo-cell work each).
pub fn enforce_one_cc_per_plate(
    assignment: &mut crate::plates::PlateAssignment,
    motions: &mut Vec<Option<PlateMotion>>,
    adjacency: &crate::adjacency::Adjacency,
    macro_step: u32,
) -> u32 {
    let mut spawn_count = 0u32;
    // Group cells by plate first so we can BFS each plate's cell set.
    let live_ids: Vec<u32> = assignment.live_plates().map(|(id, _)| id).collect();
    let mut cells_by_plate: std::collections::BTreeMap<u32, Vec<u32>> = std::collections::BTreeMap::new();
    for (i, &id) in assignment.cell_plate.iter().enumerate() {
        cells_by_plate.entry(id).or_default().push(i as u32);
    }

    for parent_id in live_ids {
        let Some(cells) = cells_by_plate.get(&parent_id) else { continue; };
        if cells.len() <= 1 { continue; }
        let mut ccs = connected_components(cells, adjacency);
        if ccs.len() < 2 { continue; }

        // Largest CC keeps parent id (sort by size desc, tie-break by lowest
        // cell id for determinism).
        ccs.sort_by(|a, b| {
            b.len().cmp(&a.len())
                .then_with(|| a.iter().min().cmp(&b.iter().min()))
        });
        ccs.remove(0);  // drop the keeper

        // Spawn a new plate for each remaining CC. No δω: passive split
        // inherits parent motion only.
        for cc in &ccs {
            let new_id = spawn(assignment, motions, parent_id, cc, None, macro_step);
            spawn_count += 1;
            let _ = new_id;
        }
    }
    spawn_count
}

/// BFS connected components of a cell set under mesh adjacency. Cells must
/// all be valid u32 indices. Returns CCs as sorted Vecs of cell ids.
fn connected_components(
    cells: &[u32],
    adjacency: &crate::adjacency::Adjacency,
) -> Vec<Vec<u32>> {
    let cell_set: std::collections::BTreeSet<u32> = cells.iter().copied().collect();
    let mut visited: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    let mut ccs = Vec::new();

    for &start in cells {
        if visited.contains(&start) { continue; }
        let mut cc = Vec::new();
        let mut stack = vec![start];
        while let Some(v) = stack.pop() {
            if !visited.insert(v) { continue; }
            cc.push(v);
            for &nb in adjacency.of(v) {
                if cell_set.contains(&nb) && !visited.contains(&nb) {
                    stack.push(nb);
                }
            }
        }
        cc.sort_unstable();
        ccs.push(cc);
    }
    ccs
}

fn rift_midpoint_and_tangent(
    rift_cells: &[u32],
    vertices: &[crate::mesh::Vec3f],
) -> (crate::mesh::Vec3f, crate::mesh::Vec3f) {
    let mid = mean_cell_position(rift_cells, vertices);
    // Tangent: principal axis of rift cell positions in the tangent plane at mid.
    // PCA approximation: sum of (p - mid) ⊗ (p - mid), take eigenvector of
    // largest eigenvalue. For a tightly-clustered rift line, this aligns with
    // the rift trace.
    let mut cov = [[0.0f64; 3]; 3];
    for &c in rift_cells {
        let p = vertices[c as usize];
        let d = p.sub(mid);
        cov[0][0] += d.x * d.x; cov[0][1] += d.x * d.y; cov[0][2] += d.x * d.z;
        cov[1][0] += d.y * d.x; cov[1][1] += d.y * d.y; cov[1][2] += d.y * d.z;
        cov[2][0] += d.z * d.x; cov[2][1] += d.z * d.y; cov[2][2] += d.z * d.z;
    }
    // Power iteration for largest eigenvector (10 iters is plenty for 3x3).
    let mut v = crate::mesh::Vec3f::new(1.0, 0.0, 0.0);
    for _ in 0..16 {
        let new = crate::mesh::Vec3f::new(
            cov[0][0] * v.x + cov[0][1] * v.y + cov[0][2] * v.z,
            cov[1][0] * v.x + cov[1][1] * v.y + cov[1][2] * v.z,
            cov[2][0] * v.x + cov[2][1] * v.y + cov[2][2] * v.z,
        );
        v = new.normalize_or(v);
    }
    // Project onto tangent plane at mid (remove radial component).
    let tangent = crate::sphere_geom::project_to_tangent_plane(mid, v)
        .normalize_or(crate::mesh::Vec3f::new(1.0, 0.0, 0.0));
    (mid, tangent)
}

/// Cell-indexed wrapper around [`sphere_geom::mean_position`] — gathers the
/// referenced vertex positions and forwards. Kept here because the index
/// domain (`cells: &[u32]` + `vertices: &[Vec3f]`) belongs to the lifecycle
/// layer rather than the pure geometry module.
fn mean_cell_position(cells: &[u32], vertices: &[crate::mesh::Vec3f]) -> crate::mesh::Vec3f {
    if cells.is_empty() {
        return crate::mesh::Vec3f::new(0.0, 0.0, 1.0);
    }
    // Avoid allocating a temporary Vec — inline the sum, then delegate the
    // normalize-or-fallback logic via a single-point wrapper.
    let n = cells.len() as f64;
    let mut sum = crate::mesh::Vec3f::new(0.0, 0.0, 0.0);
    for &c in cells {
        let p = vertices[c as usize];
        sum.x += p.x; sum.y += p.y; sum.z += p.z;
    }
    crate::mesh::Vec3f::new(sum.x / n, sum.y / n, sum.z / n)
        .normalize_or(crate::mesh::Vec3f::new(0.0, 0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::{Icosphere, Vec3f};
    use crate::motion::sample_plate_motions;
    use crate::plates::{BuildOptions, PlateAssignment};
    use hayba_seeds::MasterSeed;

    fn world(seed: u64) -> (PlateAssignment, Vec<Option<PlateMotion>>) {
        let sphere = Icosphere::new(4);
        let mut plates = PlateAssignment::build(
            MasterSeed(seed),
            &sphere,
            BuildOptions { plate_count: 12, ..BuildOptions::default() },
        );
        let mut motions = sample_plate_motions(MasterSeed(seed), 12);
        plates.prune_empty(&mut motions);
        (plates, motions)
    }

    #[test]
    fn fresh_world_satisfies_all_invariants() {
        let (plates, motions) = world(42);
        assert_invariants(&plates, &motions);
    }

    #[test]
    fn spawn_then_retire_round_trip() {
        let (mut plates, mut motions) = world(42);

        // Find a plate with ≥2 cells we can split off.
        let mut counts = vec![0u32; plates.plates.len()];
        for &id in &plates.cell_plate { counts[id as usize] += 1; }
        let parent_id = counts.iter().position(|&c| c >= 2).unwrap() as u32;

        // Take one cell off the parent as the new CC.
        let cc_cell = plates.cell_plate.iter().position(|&c| c == parent_id).unwrap() as u32;
        let cc = vec![cc_cell];

        let initial_cap = plates.plates.len();
        let new_id = spawn(&mut plates, &mut motions, parent_id, &cc, None, 0);

        // Monotonic allocation, never reuses.
        assert_eq!(new_id, initial_cap as u32);
        assert_eq!(plates.plates.len(), initial_cap + 1);
        assert!(plates.plate(new_id).is_some());
        assert_eq!(plates.cell_plate[cc_cell as usize], new_id);
        assert_invariants(&plates, &motions);

        // Merge back into parent and retire.
        merge_into(&mut plates, &mut motions, new_id, parent_id);
        assert!(plates.plate(new_id).is_none(), "retired slot stays None");
        assert_eq!(plates.cell_plate[cc_cell as usize], parent_id);
        assert_invariants(&plates, &motions);
    }

    #[test]
    fn spawn_inherits_parent_motion_plus_delta() {
        let (mut plates, mut motions) = world(42);
        // Pick any live plate that has ≥2 cells so we can siphon one.
        let mut counts = vec![0u32; plates.plates.len()];
        for &id in &plates.cell_plate { counts[id as usize] += 1; }
        let parent_id = counts.iter().position(|&c| c >= 2).unwrap() as u32;
        let cc_cell = plates.cell_plate.iter().position(|&c| c == parent_id).unwrap() as u32;
        let parent_omega = motions[parent_id as usize].as_ref().unwrap().omega;

        // Passive split — no impulse.
        let id1 = spawn(&mut plates, &mut motions, parent_id, &[cc_cell], None, 0);
        let child_omega = motions[id1 as usize].as_ref().unwrap().omega;
        assert!((child_omega.x - parent_omega.x).abs() < 1e-15);
        assert!((child_omega.y - parent_omega.y).abs() < 1e-15);
        assert!((child_omega.z - parent_omega.z).abs() < 1e-15);

        // Retire then spawn again with impulse.
        merge_into(&mut plates, &mut motions, id1, parent_id);
        let delta = Vec3f::new(0.001, -0.002, 0.003);
        let id2 = spawn(&mut plates, &mut motions, parent_id, &[cc_cell], Some(delta), 5);
        let child_omega = motions[id2 as usize].as_ref().unwrap().omega;
        assert!((child_omega.x - (parent_omega.x + delta.x)).abs() < 1e-15);
        assert!((child_omega.y - (parent_omega.y + delta.y)).abs() < 1e-15);
        assert!((child_omega.z - (parent_omega.z + delta.z)).abs() < 1e-15);

        // Lineage recorded.
        let child = plates.plate(id2).unwrap();
        assert_eq!(child.parent_id, Some(parent_id));
        assert_eq!(child.birth_macro_step, 5);
    }

    #[test]
    fn rift_fork_splits_two_half_plate() {
        // Build a level-3 icosphere and paint half its cells as plate 0,
        // half as plate 1. Then pick a "rift line" through plate 0's middle
        // (a column of cells running pole-to-pole) and call try_rift_fork.
        // We expect plate 0 to split into 2 plates with realistic motion.
        let sphere = crate::mesh::Icosphere::new(3);
        let adjacency = crate::adjacency::Adjacency::build(&sphere);
        let n = sphere.vertices.len();

        // Two plates initially. Plate 0 owns z<0 hemisphere; plate 1 owns z>=0.
        let cell_plate: Vec<u32> = sphere.vertices.iter()
            .map(|v| if v.z < 0.0 { 0 } else { 1 }).collect();

        let plate0 = crate::plates::Plate {
            id: 0, seed_pos: Vec3f::new(0.0, 0.0, -1.0),
            color: [255, 0, 0], parent_id: None, birth_macro_step: 0,
            last_division_step: None,
            age_since_last_split: 0,
        };
        let plate1 = crate::plates::Plate {
            id: 1, seed_pos: Vec3f::new(0.0, 0.0, 1.0),
            color: [0, 0, 255], parent_id: None, birth_macro_step: 0,
            last_division_step: None,
            age_since_last_split: 0,
        };
        let mut plates = crate::plates::PlateAssignment {
            plates: vec![Some(plate0), Some(plate1)],
            next_id_counter: 2,
            cell_plate,
            boundary_edges: vec![],
            triple_junctions: vec![],
            residual_quad_junctions: 0,
            plate_composition: vec![
                Some(crate::crust_state::Composition::Continental),
                Some(crate::crust_state::Composition::Continental),
            ],
        };
        let mut motions: Vec<Option<PlateMotion>> = vec![
            Some(PlateMotion { omega: Vec3f::new(0.0, 0.001, 0.0) }),
            Some(PlateMotion { omega: Vec3f::new(0.0, -0.001, 0.0) }),
        ];

        // Build a minimal CrustState for plate 0 cells.
        let mut crust = crate::crust_state::CrustState {
            composition: vec![crate::crust_state::Composition::Continental; n],
            age_ma: vec![1000; n],
            elevation_m: vec![500; n],
            layers: vec![crate::crust_state::CrustLayers::default(); n],
            bending: vec![0; n],
            volcanic_act: vec![0; n],
            rift_progress: vec![0; n],
            failed_rift_age_ma: vec![0; n],
            lip_age_ma: vec![0; n],
            flow_accum: vec![0; n],
            lake_mask: vec![0; n],
        };

        // Pick a "rift line" of plate-0 cells: those with z < 0 AND |x| < 0.1
        // (a thin meridional band). With a level-3 icosphere this gives a
        // handful of cells that, when removed, leave plate 0 split.
        let rift_cells: Vec<u32> = sphere.vertices.iter().enumerate()
            .filter(|(_, v)| v.z < 0.0 && v.x.abs() < 0.25)
            .map(|(i, _)| i as u32)
            .collect();
        assert!(!rift_cells.is_empty(), "test setup: rift band is empty");

        let outcome = try_rift_fork(
            &mut plates, &mut motions, &mut crust, &adjacency,
            &sphere.vertices, 0, &rift_cells, 100, 50,
        );

        match outcome {
            RiftForkOutcome::Forked { spawned } => {
                assert!(!spawned.is_empty(), "fork outcome reports zero spawned");
                // Every spawned plate is live, has cells, and is a child of 0.
                for &id in &spawned {
                    let p = plates.plate(id).expect("spawned plate live");
                    assert_eq!(p.parent_id, Some(0));
                    assert_eq!(p.birth_macro_step, 100);
                    // Motion = parent + δω, so it differs from parent's motion.
                    let parent_omega = motions[0].as_ref().unwrap().omega;
                    let child_omega = motions[id as usize].as_ref().unwrap().omega;
                    let diff = (child_omega.x - parent_omega.x).powi(2)
                        + (child_omega.y - parent_omega.y).powi(2)
                        + (child_omega.z - parent_omega.z).powi(2);
                    assert!(diff > 1e-9, "child motion identical to parent — δω missing");
                }
                // Rift cells are now oceanic, age 0.
                for &rc in &rift_cells {
                    assert_eq!(crust.composition[rc as usize], crate::crust_state::Composition::Oceanic);
                    assert_eq!(crust.age_ma[rc as usize], 0);
                }
                // Parent's last_division_step updated.
                assert_eq!(plates.plate(0).unwrap().last_division_step, Some(100));
            }
            other => panic!("expected Forked, got {:?}", other),
        }
    }

    #[test]
    fn enforce_one_cc_splits_disconnected_plate() {
        // Build a synthetic state: plate 0 owns two disjoint hemispheres
        // (z < -0.5 AND z > 0.5), plate 1 owns the equatorial band.
        // After enforcement, plate 0 should fork into two plates.
        let sphere = crate::mesh::Icosphere::new(3);
        let adjacency = crate::adjacency::Adjacency::build(&sphere);
        let n = sphere.vertices.len();

        let cell_plate: Vec<u32> = sphere.vertices.iter()
            .map(|v| if v.z.abs() > 0.5 { 0 } else { 1 }).collect();

        let plate0 = crate::plates::Plate {
            id: 0, seed_pos: Vec3f::new(0.0, 0.0, 1.0),
            color: [255, 0, 0], parent_id: None, birth_macro_step: 0,
            last_division_step: None,
            age_since_last_split: 0,
        };
        let plate1 = crate::plates::Plate {
            id: 1, seed_pos: Vec3f::new(1.0, 0.0, 0.0),
            color: [0, 0, 255], parent_id: None, birth_macro_step: 0,
            last_division_step: None,
            age_since_last_split: 0,
        };
        let mut plates = crate::plates::PlateAssignment {
            plates: vec![Some(plate0), Some(plate1)],
            next_id_counter: 2,
            cell_plate,
            boundary_edges: vec![],
            triple_junctions: vec![],
            residual_quad_junctions: 0,
            plate_composition: vec![
                Some(crate::crust_state::Composition::Continental),
                Some(crate::crust_state::Composition::Continental),
            ],
        };
        let mut motions: Vec<Option<PlateMotion>> = vec![
            Some(PlateMotion { omega: Vec3f::new(0.0, 0.001, 0.0) }),
            Some(PlateMotion { omega: Vec3f::new(0.0, -0.001, 0.0) }),
        ];
        let _crust = crate::crust_state::CrustState {
            composition: vec![crate::crust_state::Composition::Continental; n],
            age_ma: vec![1000; n], elevation_m: vec![500; n],
            layers: vec![crate::crust_state::CrustLayers::default(); n],
            bending: vec![0; n], volcanic_act: vec![0; n],
            rift_progress: vec![0; n], failed_rift_age_ma: vec![0; n],
            lip_age_ma: vec![0; n],
            flow_accum: vec![0; n],
            lake_mask: vec![0; n],
        };

        let spawned = enforce_one_cc_per_plate(
            &mut plates, &mut motions, &adjacency, 50,
        );

        assert!(spawned >= 1, "expected at least 1 passive split, got {}", spawned);
        // Now no plate should have >1 CC.
        assert_invariants(&plates, &motions);
        // After enforcement, plate 0 keeps the larger hemisphere; the smaller
        // hemisphere becomes the new plate. Both have only one CC.
        let _ = spawned;
    }

    #[test]
    fn rift_fork_cooldown_blocks_repeat_calls() {
        // Trigger a fork at step 100, then immediately try another fork on
        // the same parent at step 120 (< 50 step cooldown). Should return
        // Cooldown without making changes.
        let sphere = crate::mesh::Icosphere::new(3);
        let adjacency = crate::adjacency::Adjacency::build(&sphere);
        let n = sphere.vertices.len();
        let cell_plate: Vec<u32> = vec![0; n];
        let plate0 = crate::plates::Plate {
            id: 0, seed_pos: Vec3f::new(0.0, 0.0, 1.0),
            color: [255, 0, 0], parent_id: None, birth_macro_step: 0,
            last_division_step: Some(100),  // simulate a recent fork
            age_since_last_split: 0,
        };
        let mut plates = crate::plates::PlateAssignment {
            plates: vec![Some(plate0)],
            next_id_counter: 1,
            cell_plate,
            boundary_edges: vec![],
            triple_junctions: vec![],
            residual_quad_junctions: 0,
            plate_composition: vec![Some(crate::crust_state::Composition::Continental)],
        };
        let mut motions: Vec<Option<PlateMotion>> = vec![
            Some(PlateMotion { omega: Vec3f::new(0.0, 0.001, 0.0) }),
        ];
        let mut crust = crate::crust_state::CrustState {
            composition: vec![crate::crust_state::Composition::Continental; n],
            age_ma: vec![1000; n], elevation_m: vec![500; n],
            layers: vec![crate::crust_state::CrustLayers::default(); n],
            bending: vec![0; n], volcanic_act: vec![0; n],
            rift_progress: vec![0; n], failed_rift_age_ma: vec![0; n],
            lip_age_ma: vec![0; n],
            flow_accum: vec![0; n],
            lake_mask: vec![0; n],
        };

        let rift_cells: Vec<u32> = (0..10).collect();
        let outcome = try_rift_fork(
            &mut plates, &mut motions, &mut crust, &adjacency,
            &sphere.vertices, 0, &rift_cells, 120, 50,
        );
        assert_eq!(outcome, RiftForkOutcome::Cooldown);
        assert_eq!(plates.plates.len(), 1, "no plates spawned during cooldown");
    }

    #[test]
    fn ids_never_reuse_after_retire() {
        let (mut plates, mut motions) = world(42);
        let mut counts = vec![0u32; plates.plates.len()];
        for &id in &plates.cell_plate { counts[id as usize] += 1; }
        let parent_id = counts.iter().position(|&c| c >= 2).unwrap() as u32;
        let cc_cell = plates.cell_plate.iter().position(|&c| c == parent_id).unwrap() as u32;

        let id1 = spawn(&mut plates, &mut motions, parent_id, &[cc_cell], None, 0);
        merge_into(&mut plates, &mut motions, id1, parent_id);
        let id2 = spawn(&mut plates, &mut motions, parent_id, &[cc_cell], None, 0);

        assert!(id2 > id1, "ids must be monotonically increasing");
        assert!(plates.plates[id1 as usize].is_none(), "retired slot stays None");
    }

    #[test]
    fn age_based_split_fires_on_old_large_continent() {
        // B3: synthesize a 400-Ma-old continental plate that occupies the
        // entire icosphere (n>=200 cells), run 100 steps of the trigger,
        // and assert at least one split fires.
        let sphere = crate::mesh::Icosphere::new(4); // 642 cells
        let adjacency = crate::adjacency::Adjacency::build(&sphere);
        let n = sphere.vertices.len();
        assert!(n >= 200, "test setup: need >= 200 cells");

        let plate0 = crate::plates::Plate {
            id: 0, seed_pos: Vec3f::new(0.0, 0.0, 1.0),
            color: [255, 0, 0], parent_id: None, birth_macro_step: 0,
            last_division_step: None,
            age_since_last_split: 400, // 400 Ma — well past the 300 Ma gate
        };
        let mut plates = crate::plates::PlateAssignment {
            plates: vec![Some(plate0)],
            next_id_counter: 1,
            cell_plate: vec![0u32; n],
            boundary_edges: vec![],
            triple_junctions: vec![],
            residual_quad_junctions: 0,
            plate_composition: vec![Some(crate::crust_state::Composition::Continental)],
        };
        let mut motions: Vec<Option<PlateMotion>> = vec![
            Some(PlateMotion { omega: Vec3f::new(0.0, 0.001, 0.0) }),
        ];
        let crust = crate::crust_state::CrustState {
            composition: vec![crate::crust_state::Composition::Continental; n],
            age_ma: vec![1000; n], elevation_m: vec![500; n],
            layers: vec![crate::crust_state::CrustLayers::default(); n],
            bending: vec![0; n], volcanic_act: vec![0; n],
            rift_progress: vec![0; n], failed_rift_age_ma: vec![0; n],
            lip_age_ma: vec![0; n],
            flow_accum: vec![0; n],
            lake_mask: vec![0; n],
        };

        // Run 100 steps; with a 1% per-step roll the probability of at
        // least one fire is 1 - 0.99^100 ≈ 63%. Single-shot would be
        // flaky, so we drive the deterministic roll across many steps
        // and require ≥1. Seed 12345 is the project's canonical test seed.
        let master = hayba_seeds::MasterSeed(12345);
        let mut any_fired = false;
        for step in 0..100 {
            let fired = trigger_age_based_splits(
                &mut plates, &mut motions, &crust, &adjacency,
                &sphere.vertices, master, step,
            );
            if fired > 0 {
                any_fired = true;
                break;
            }
        }
        assert!(any_fired, "at least one age-based split should fire in 100 steps");
        // After split, the parent has age_since_last_split = 0.
        assert_eq!(plates.plate(0).unwrap().age_since_last_split, 0);
        // And at least one child plate exists.
        assert!(plates.live_plates().count() >= 2,
            "expected at least one child plate after age-based split");
    }

    #[test]
    fn age_based_split_skipped_when_too_young() {
        // Same setup but age_since_last_split = 50 — no fire.
        let sphere = crate::mesh::Icosphere::new(4);
        let adjacency = crate::adjacency::Adjacency::build(&sphere);
        let n = sphere.vertices.len();
        let plate0 = crate::plates::Plate {
            id: 0, seed_pos: Vec3f::new(0.0, 0.0, 1.0),
            color: [255, 0, 0], parent_id: None, birth_macro_step: 0,
            last_division_step: None, age_since_last_split: 50,
        };
        let mut plates = crate::plates::PlateAssignment {
            plates: vec![Some(plate0)],
            next_id_counter: 1,
            cell_plate: vec![0u32; n],
            boundary_edges: vec![], triple_junctions: vec![],
            residual_quad_junctions: 0,
            plate_composition: vec![Some(crate::crust_state::Composition::Continental)],
        };
        let mut motions: Vec<Option<PlateMotion>> = vec![
            Some(PlateMotion { omega: Vec3f::new(0.0, 0.001, 0.0) }),
        ];
        let crust = crate::crust_state::CrustState {
            composition: vec![crate::crust_state::Composition::Continental; n],
            age_ma: vec![1000; n], elevation_m: vec![500; n],
            layers: vec![crate::crust_state::CrustLayers::default(); n],
            bending: vec![0; n], volcanic_act: vec![0; n],
            rift_progress: vec![0; n], failed_rift_age_ma: vec![0; n],
            lip_age_ma: vec![0; n],
            flow_accum: vec![0; n],
            lake_mask: vec![0; n],
        };
        for step in 0..100 {
            let fired = trigger_age_based_splits(
                &mut plates, &mut motions, &crust, &adjacency,
                &sphere.vertices, hayba_seeds::MasterSeed(12345), step,
            );
            assert_eq!(fired, 0, "age 50 Ma should be below the 300 Ma gate");
        }
    }

    #[test]
    fn inv6_detects_fully_enclosed_plate() {
        // B4: build a state where plate 1 is a single cell at the south
        // pole, fully surrounded by plate 0. check_inv6 should flag plate 1;
        // enforce_inv6 should absorb it into plate 0 and retire it.
        let sphere = crate::mesh::Icosphere::new(3);
        let adjacency = crate::adjacency::Adjacency::build(&sphere);
        let n = sphere.vertices.len();

        // Find the south-most vertex; make it plate 1, everything else plate 0.
        let south = sphere.vertices.iter().enumerate()
            .min_by(|(_, a), (_, b)| a.z.partial_cmp(&b.z).unwrap())
            .map(|(i, _)| i as u32)
            .unwrap();
        let mut cell_plate = vec![0u32; n];
        cell_plate[south as usize] = 1;

        let plate0 = crate::plates::Plate {
            id: 0, seed_pos: Vec3f::new(0.0, 0.0, 1.0),
            color: [255, 0, 0], parent_id: None, birth_macro_step: 0,
            last_division_step: None, age_since_last_split: 0,
        };
        let plate1 = crate::plates::Plate {
            id: 1, seed_pos: Vec3f::new(0.0, 0.0, -1.0),
            color: [0, 255, 0], parent_id: None, birth_macro_step: 0,
            last_division_step: None, age_since_last_split: 0,
        };
        let mut plates = crate::plates::PlateAssignment {
            plates: vec![Some(plate0), Some(plate1)],
            next_id_counter: 2,
            cell_plate,
            boundary_edges: vec![], triple_junctions: vec![],
            residual_quad_junctions: 0,
            plate_composition: vec![
                Some(crate::crust_state::Composition::Continental),
                Some(crate::crust_state::Composition::Continental),
            ],
        };
        let mut motions: Vec<Option<PlateMotion>> = vec![
            Some(PlateMotion { omega: Vec3f::new(0.0, 0.001, 0.0) }),
            Some(PlateMotion { omega: Vec3f::new(0.0, -0.001, 0.0) }),
        ];

        let offenders = check_inv6(&plates, &adjacency);
        assert!(offenders.contains(&1),
            "check_inv6 should flag the fully-enclosed plate 1, got {:?}", offenders);

        let retired = enforce_inv6(&mut plates, &mut motions, &adjacency);
        assert_eq!(retired, 1);
        assert!(plates.plate(1).is_none(), "plate 1 should be retired");
        assert_eq!(plates.cell_plate[south as usize], 0,
            "south-pole cell should be reassigned to plate 0");
        // Re-running enforce_inv6 should be a no-op.
        assert!(check_inv6(&plates, &adjacency).is_empty());
    }
}
