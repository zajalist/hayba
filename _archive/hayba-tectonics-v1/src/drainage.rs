//! Drainage network on the icosphere.
//!
//! Pipeline: [`fill_pits`] → [`compute_flow_dirs`] → [`compute_flow_accum`].
//! All functions deterministic and single-threaded. Operates on a flat
//! per-cell elevation slice plus a CSR adjacency (the icosphere 1-ring).
//!
//! ## Why these algorithms
//!
//! - **fill_pits** (Planchon–Darboux 2001 variant) raises interior
//!   depressions until every land cell has a downstream escape route.
//!   This is required before [`compute_flow_dirs`] / [`compute_flow_accum`]
//!   so the resulting flow network has no closed sinks except at sea level.
//! - **compute_flow_dirs** assigns each land cell the steepest-descent
//!   neighbour (single-flow-direction, D8 in spirit).
//! - **compute_flow_accum** sums "1 per cell" downstream via a topological
//!   sort by elevation (high → low). Linear in cells; no recursion.

use crate::adjacency::Adjacency;

/// Sea-level reference in metres. Cells at or below this are treated as
/// global sinks (ocean), regardless of where their neighbours sit.
pub const SEA_LEVEL: i16 = 0;

/// Compute per-cell flow direction (index of the steepest-descent neighbour).
/// Cells at or below sea level get `u32::MAX` (sink marker — ocean drains
/// nowhere). Cells with no lower neighbour after `fill_pits` are an
/// internal-pit indicator; they too get `u32::MAX` so the caller can tag
/// them as lakes.
pub fn compute_flow_dirs(elev: &[i16], adj: &Adjacency) -> Vec<u32> {
    let n = elev.len();
    let mut out = vec![u32::MAX; n];
    for c in 0..n {
        if elev[c] <= SEA_LEVEL {
            continue;
        }
        let mut best = u32::MAX;
        let mut best_elev = elev[c];
        for &nb in adj.of(c as u32) {
            if elev[nb as usize] < best_elev {
                best_elev = elev[nb as usize];
                best = nb;
            }
        }
        out[c] = best;
    }
    out
}

/// Topological sort of cells by elevation (descending), then accumulate
/// "1 per cell" along `flow_dirs`. Resulting array gives the number of
/// upstream cells (including self) draining through each cell — proxy for
/// discharge in the stream-power law.
pub fn compute_flow_accum(flow_dirs: &[u32], elev: &[i16], _adj: &Adjacency) -> Vec<u32> {
    let n = flow_dirs.len();
    let mut accum = vec![1u32; n];
    let mut order: Vec<u32> = (0..n as u32).collect();
    // Stable sort by (elev DESC, idx ASC) for determinism.
    order.sort_by(|&a, &b| {
        elev[b as usize]
            .cmp(&elev[a as usize])
            .then_with(|| a.cmp(&b))
    });
    for &c in &order {
        let fd = flow_dirs[c as usize];
        if fd != u32::MAX {
            accum[fd as usize] = accum[fd as usize].saturating_add(accum[c as usize]);
        }
    }
    accum
}

/// Planchon–Darboux algorithm: raise interior depressions until they
/// overflow toward sea level. Operates in-place on `elev`. Returns
/// `true` if any cell was raised.
///
/// EPSILON (1 m) is the minimum gradient enforced between a filled pit
/// and its overflow neighbour — keeps the flow_dirs step from finding a
/// flat tie. Small enough not to perturb visible elevation, large enough
/// to be representable in i16.
pub fn fill_pits(elev: &mut [i16], adj: &Adjacency) -> bool {
    const EPSILON: i16 = 1;
    let n = elev.len();
    // Working buffer: start "high" everywhere except ocean cells which are
    // pinned to their current value (they are the global drainage outlet).
    let mut w = vec![i16::MAX; n];
    for c in 0..n {
        if elev[c] <= SEA_LEVEL {
            w[c] = elev[c];
        }
    }
    let mut changed = true;
    while changed {
        changed = false;
        for c in 0..n {
            if w[c] == elev[c] {
                continue; // already locked at its true elevation
            }
            // Find a neighbour through which c can drain.
            for &nb in adj.of(c as u32) {
                let candidate = (w[nb as usize] as i32 + EPSILON as i32)
                    .clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                if elev[c] >= candidate {
                    // c can drain directly through nb at its true elevation.
                    if w[c] != elev[c] {
                        w[c] = elev[c];
                        changed = true;
                    }
                    break;
                }
                // Otherwise c must be raised at least to candidate to drain.
                if w[c] > candidate {
                    w[c] = candidate;
                    changed = true;
                }
            }
        }
    }
    // Apply w back to elev where it lifted the surface.
    let mut any_lifted = false;
    for c in 0..n {
        if w[c] > elev[c] {
            elev[c] = w[c];
            any_lifted = true;
        }
    }
    any_lifted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adjacency::Adjacency;
    use crate::mesh::Icosphere;

    /// Build elevation = max-peak height − great-circle-angle to north-pole.
    /// Produces a single global peak at the north pole and a smooth gradient
    /// downward, so every land cell has at least one strictly-lower neighbour.
    fn single_peak_elev(sphere: &Icosphere, peak_m: i16) -> Vec<i16> {
        sphere
            .vertices
            .iter()
            .map(|v| {
                // v.z ∈ [-1, 1]; map to elevation centred a bit above sea so
                // the bottom hemisphere is ocean (elev < 0).
                let h = (v.z * peak_m as f64) as i32;
                h.clamp(-3000, peak_m as i32) as i16
            })
            .collect()
    }

    #[test]
    fn flow_dirs_point_downhill() {
        let sphere = Icosphere::new(3);
        let adj = Adjacency::build(&sphere);
        let mut elev = single_peak_elev(&sphere, 4000);
        fill_pits(&mut elev, &adj);
        let dirs = compute_flow_dirs(&elev, &adj);
        for c in 0..elev.len() {
            if elev[c] <= SEA_LEVEL {
                continue;
            }
            let fd = dirs[c];
            if fd == u32::MAX {
                // Acceptable only if c truly has no lower neighbour — but
                // since fill_pits ran, every land cell should have one.
                // Surface this as a failure.
                panic!("land cell {} has no flow dir post fill_pits", c);
            }
            assert!(
                elev[fd as usize] < elev[c],
                "flow_dirs[{}]={} elev {} >= self elev {}",
                c,
                fd,
                elev[fd as usize],
                elev[c],
            );
        }
    }

    #[test]
    fn flow_accum_total_equals_land_cell_count() {
        let sphere = Icosphere::new(3);
        let adj = Adjacency::build(&sphere);
        let mut elev = single_peak_elev(&sphere, 4000);
        fill_pits(&mut elev, &adj);
        let dirs = compute_flow_dirs(&elev, &adj);
        let accum = compute_flow_accum(&dirs, &elev, &adj);

        let land_cells: u32 = elev.iter().filter(|&&e| e > SEA_LEVEL).count() as u32;
        // Sum of accum entering ocean cells = land_cell_count (every land
        // cell contributes 1, and every flow path ends at an ocean cell).
        let mut entering_ocean: u32 = 0;
        for c in 0..elev.len() {
            if elev[c] <= SEA_LEVEL {
                continue;
            }
            let fd = dirs[c];
            if fd != u32::MAX && elev[fd as usize] <= SEA_LEVEL {
                entering_ocean = entering_ocean.saturating_add(accum[c]);
            }
        }
        assert_eq!(
            entering_ocean, land_cells,
            "flow accumulation entering ocean should equal land cell count"
        );
    }

    #[test]
    fn fill_pits_removes_local_minima() {
        let sphere = Icosphere::new(3);
        let adj = Adjacency::build(&sphere);
        // Start from the single-peak field, then dig a synthetic bowl: pick
        // a land cell and push its elevation BELOW all neighbours.
        let mut elev = single_peak_elev(&sphere, 4000);
        // Find a land cell whose neighbours are all > 100 m.
        let mut bowl_cell = None;
        for c in 0..elev.len() {
            if elev[c] < 500 || elev[c] > 3000 {
                continue;
            }
            if adj.of(c as u32).iter().all(|&n| elev[n as usize] > 500) {
                bowl_cell = Some(c);
                break;
            }
        }
        let bowl_cell = bowl_cell.expect("expected to find a candidate cell");
        elev[bowl_cell] = 100; // below all neighbours
        // Pre-fill: bowl_cell is a strict local minimum.
        let pre_is_min = adj
            .of(bowl_cell as u32)
            .iter()
            .all(|&n| elev[n as usize] > elev[bowl_cell]);
        assert!(pre_is_min, "test setup didn't create a local min");

        fill_pits(&mut elev, &adj);

        // Post-fill: no land cell is a strict local minimum (every land
        // cell has at least one neighbour at strictly-lower elevation).
        for c in 0..elev.len() {
            if elev[c] <= SEA_LEVEL {
                continue;
            }
            let has_lower = adj
                .of(c as u32)
                .iter()
                .any(|&n| elev[n as usize] < elev[c]);
            assert!(
                has_lower,
                "cell {} (elev {}) is still a local minimum after fill_pits",
                c, elev[c]
            );
        }
    }
}
