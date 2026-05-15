//! Topological contiguity enforcement.
//!
//! After every CA step, plate ownership may have changed in ways that fracture
//! a plate into disconnected components (orphan single cells, isolated
//! peninsulas, etc.). Without intervention, the mesh shatters into thousands
//! of microplates — exactly what the dossier warned about.
//!
//! This module runs a BFS-based connected-component analysis per plate and
//! resolves any fragments below `n_min_cells` by absorbing them into their
//! dominant adjacent plate. Larger fragments could be spawned as new plate
//! IDs (Wilson Cycle rifting), but for Week 4 simplicity we absorb
//! everything that isn't the largest component per plate. True spawning
//! gets added in a later pass if needed.

use std::collections::BTreeMap;

use crate::adjacency::Adjacency;
use crate::crust_state::{Composition, CrustState};

/// Majority-filter pass: any cell whose 1-ring has strict majority of a
/// plate other than its own gets reassigned to that majority plate. This
/// is the cheap-but-effective cure for checkerboard alternation between
/// adjacent plates in tight zones.
///
/// Runs in O(N · degree). Returns the number of cells changed.
pub fn smooth_majority(
    cell_plate: &mut [u32],
    crust: &mut CrustState,
    plate_composition: &[Option<Composition>],
    adjacency: &Adjacency,
) -> u32 {
    let n = cell_plate.len();
    let mut next = cell_plate.to_vec();
    let mut changed = 0u32;
    let mut tally: [(u32, u32); 8] = [(u32::MAX, 0); 8];

    for v in 0..n {
        let current = cell_plate[v];
        let mut tally_len = 0usize;
        let mut current_count = 0u32;
        for &nb in adjacency.of(v as u32) {
            let p = cell_plate[nb as usize];
            if p == current {
                current_count += 1;
            }
            let mut found = false;
            for slot in tally.iter_mut().take(tally_len) {
                if slot.0 == p { slot.1 += 1; found = true; break; }
            }
            if !found && tally_len < tally.len() {
                tally[tally_len] = (p, 1);
                tally_len += 1;
            }
        }
        // Find dominant plate among neighbors, with deterministic tiebreak
        // (highest count, then smallest plate id).
        let mut best: Option<(u32, u32)> = None;
        for slot in tally.iter().take(tally_len) {
            best = match best {
                None => Some(*slot),
                Some(b) => {
                    if slot.1 > b.1 || (slot.1 == b.1 && slot.0 < b.0) {
                        Some(*slot)
                    } else {
                        Some(b)
                    }
                }
            };
        }
        // Reset tally for next iteration.
        for slot in tally.iter_mut().take(tally_len) { *slot = (u32::MAX, 0); }

        if let Some((plate, count)) = best {
            if plate != current && count > current_count {
                next[v] = plate;
                changed += 1;
            }
        }
    }

    // Apply changes + propagate composition (age preserved).
    for (v, &new_plate) in next.iter().enumerate() {
        if new_plate != cell_plate[v] {
            if let Some(c) = plate_composition[new_plate as usize] {
                crust.composition[v] = c;
            }
        }
        cell_plate[v] = new_plate;
    }
    changed
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ContiguityStats {
    pub components_found: u32,
    pub absorbed_components: u32,
    pub absorbed_cells: u32,
}

/// Detect non-largest plate components and absorb them into their dominant
/// adjacent plate. Mutates `cell_plate` and `crust` to reflect absorptions.
pub fn enforce_contiguity(
    cell_plate: &mut [u32],
    crust: &mut CrustState,
    plate_composition: &[Option<Composition>],
    adjacency: &Adjacency,
    n_min_cells: usize,
) -> ContiguityStats {
    let n = cell_plate.len();
    let mut visited = vec![false; n];
    let mut stats = ContiguityStats::default();

    // ── Pass 1: BFS-based connected component discovery per plate. ─────
    // Each component is one contiguous run of cells sharing a plate id.
    // For deterministic ordering we always seed BFS from the lowest-index
    // unvisited cell.
    let mut components: Vec<(u32, Vec<u32>)> = Vec::new();  // (plate_id, cells)
    let mut frontier: Vec<u32> = Vec::new();

    for start in 0..n {
        if visited[start] { continue; }
        let plate = cell_plate[start];
        let mut cells = vec![start as u32];
        visited[start] = true;
        frontier.clear();
        frontier.push(start as u32);
        while let Some(v) = frontier.pop() {
            for &nb in adjacency.of(v) {
                if visited[nb as usize] { continue; }
                if cell_plate[nb as usize] != plate { continue; }
                visited[nb as usize] = true;
                cells.push(nb);
                frontier.push(nb);
            }
        }
        components.push((plate, cells));
    }
    stats.components_found = components.len() as u32;

    // ── Pass 2: identify the largest component per plate. ─────────────
    // Map plate_id → (index into `components`, size). On ties, prefer the
    // earlier-seen component for determinism.
    // BTreeMap (not HashMap) — iteration order matters because we feed
    // results into the absorb pass below, and HashMap iteration is
    // non-deterministic across runs (M0.14 determinism audit).
    let mut largest_per_plate: BTreeMap<u32, (usize, usize)> = BTreeMap::new();
    for (i, (plate, cells)) in components.iter().enumerate() {
        let entry = largest_per_plate.entry(*plate).or_insert((i, cells.len()));
        if cells.len() > entry.1 {
            *entry = (i, cells.len());
        }
    }

    // ── Pass 3: absorb every non-largest component into its dominant
    //     adjacent plate (the one bordering the most of its cells). ────
    for (i, (plate_id, cells)) in components.iter().enumerate() {
        let is_largest = largest_per_plate.get(plate_id).map(|&(idx, _)| idx) == Some(i);
        // Absorb if: NOT the largest component for this plate, OR even if
        // largest, the entire plate is below the microplate threshold.
        let below_min = cells.len() < n_min_cells;
        if is_largest && !below_min { continue; }

        // Tally neighbor plate counts across all cells in this component.
        // BTreeMap (not HashMap) — we iterate it via `.iter().max_by(...)`
        // below; with HashMap the iteration order is non-deterministic,
        // which on ties would pick different "dominant" plates across
        // identical runs. M0.14 determinism audit.
        let mut tally: BTreeMap<u32, u32> = BTreeMap::new();
        for &v in cells {
            for &nb in adjacency.of(v) {
                let np = cell_plate[nb as usize];
                if np != *plate_id {
                    *tally.entry(np).or_insert(0) += 1;
                }
            }
        }

        // Pick dominant (max count, tiebreak on smallest plate id).
        let dominant = tally.iter()
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .map(|(&p, _)| p);

        if let Some(new_plate) = dominant {
            for &v in cells {
                cell_plate[v as usize] = new_plate;
                if let Some(c) = plate_composition[new_plate as usize] {
                    crust.composition[v as usize] = c;
                }
                // Age preserved — absorbed cells keep their geological history.
            }
            stats.absorbed_components += 1;
            stats.absorbed_cells += cells.len() as u32;
        }
        // If dominant is None, the component is fully isolated (no neighbors
        // outside itself — only possible for a whole-sphere plate, which is
        // also the only plate). Skip; topologically impossible here anyway.
    }

    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crust_state::Composition;
    use crate::mesh::Icosphere;

    fn synthetic_crust(n: usize) -> CrustState {
        CrustState {
            composition: vec![Composition::Oceanic; n],
            age_ma: vec![0; n],
            elevation_m: vec![0; n],
            layers: vec![crate::crust_state::CrustLayers::default(); n],
            bending: vec![0; n],
            volcanic_act: vec![0; n],
            rift_progress: vec![0; n],
            failed_rift_age_ma: vec![0; n],
            lip_age_ma: vec![0; n],
            flow_accum: vec![0; n],
            lake_mask: vec![0; n],
        }
    }

    fn synthetic_plate_comp() -> Vec<Option<Composition>> {
        vec![Some(Composition::Oceanic); 4]
    }

    #[test]
    fn single_orphan_gets_absorbed() {
        // Build a small icosphere; manually place a single-cell orphan of
        // plate 1 in the middle of plate 0's territory. The orphan should
        // be absorbed by plate 0.
        let sphere = Icosphere::new(2);
        let adjacency = Adjacency::build(&sphere);
        let mut cell_plate = vec![0u32; sphere.vertices.len()];
        // Pick a vertex with neighbors all-zero, flip it to plate 1.
        cell_plate[10] = 1;
        let mut crust = synthetic_crust(sphere.vertices.len());
        let pcomp = synthetic_plate_comp();
        let stats = enforce_contiguity(&mut cell_plate, &mut crust, &pcomp, &adjacency, 32);
        assert!(stats.absorbed_cells >= 1, "orphan was not absorbed");
        // After absorption the orphan should be back to plate 0.
        assert_eq!(cell_plate[10], 0, "orphan still has its own plate id");
    }

    #[test]
    fn intact_plate_survives() {
        let sphere = Icosphere::new(2);
        let adjacency = Adjacency::build(&sphere);
        let cell_plate = vec![0u32; sphere.vertices.len()];
        let mut cp = cell_plate.clone();
        let mut crust = synthetic_crust(sphere.vertices.len());
        let pcomp = synthetic_plate_comp();
        let _ = enforce_contiguity(&mut cp, &mut crust, &pcomp, &adjacency, 32);
        assert_eq!(cp, cell_plate, "unbroken plate should not change");
    }
}
