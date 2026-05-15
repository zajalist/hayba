//! Drainage network on the v2 Voronoi sphere.
//!
//! Port of v1 `hayba-tectonics::drainage` adapted to the f32 elevation
//! convention used by v2 fields and the spherical adjacency exposed by
//! [`crate::sphere::VoronoiSphere`].
//!
//! Pipeline: [`fill_pits`] -> [`compute_flow_dirs`] -> [`compute_flow_accum`].
//! All three are deterministic and single-threaded.
//!
//! ## Algorithms (recap of v1 docs)
//!
//! - **fill_pits** (Planchon-Darboux 2001 variant) raises interior depressions
//!   until every land cell has a downstream escape route.
//! - **compute_flow_dirs** assigns each land cell the steepest-descent neighbour
//!   (single-flow-direction, D8 in spirit).
//! - **compute_flow_accum** sums "1 per cell" downstream via a topological sort
//!   by elevation (high -> low). Linear in cells; no recursion.

use crate::sphere::VoronoiSphere;

/// Sea-level reference in v2 units. Cells at or below this are treated as
/// global sinks (ocean) regardless of where their neighbours sit. Matches
/// `crate::field::field::SEA_LEVEL_ELEVATION`.
pub const SEA_LEVEL: f32 = 0.0;

/// Minimum gradient enforced between a filled pit and its overflow neighbour.
/// 1e-3 in v2 units — well below visible terrain noise and large enough to
/// escape f32 rounding when comparing neighbour elevations.
pub const FILL_EPSILON: f32 = 1.0e-3;

/// Sentinel "no downstream neighbour" (ocean or unresolved sink).
pub const NO_FLOW: u32 = u32::MAX;

/// Planchon-Darboux pit fill on the spherical adjacency. Reads `elev` and
/// returns the filled elevation array; the input is left unchanged.
///
/// Interior depressions get raised by at least `FILL_EPSILON` above their
/// lowest neighbour so [`compute_flow_dirs`] always finds a strictly-lower
/// neighbour for land cells.
pub fn fill_pits(elev: &[f32], sphere: &VoronoiSphere) -> Vec<f32> {
    let n = elev.len();
    assert_eq!(
        n,
        sphere.n_fields() as usize,
        "elev length must match sphere n_fields"
    );

    // Working buffer: ocean cells pinned to their true elevation (global
    // outlet); land cells start at +inf and get progressively pulled down.
    let mut w = vec![f32::INFINITY; n];
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
                continue;
            }
            for &nb in sphere.neighbours(c as u32) {
                let candidate = w[nb as usize] + FILL_EPSILON;
                if elev[c] >= candidate {
                    if w[c] != elev[c] {
                        w[c] = elev[c];
                        changed = true;
                    }
                    break;
                }
                if w[c] > candidate {
                    w[c] = candidate;
                    changed = true;
                }
            }
        }
    }

    let mut out = vec![0.0f32; n];
    for c in 0..n {
        out[c] = if w[c] > elev[c] { w[c] } else { elev[c] };
    }
    out
}

/// For each cell, pick the steepest-descent neighbour. Cells at or below sea
/// level get [`NO_FLOW`] (ocean drains nowhere). Cells with no strictly-lower
/// neighbour also get [`NO_FLOW`] — after `fill_pits` this should only happen
/// for ocean cells.
pub fn compute_flow_dirs(elev: &[f32], sphere: &VoronoiSphere) -> Vec<u32> {
    let n = elev.len();
    assert_eq!(n, sphere.n_fields() as usize);
    let mut out = vec![NO_FLOW; n];
    for c in 0..n {
        if elev[c] <= SEA_LEVEL {
            continue;
        }
        let mut best = NO_FLOW;
        let mut best_elev = elev[c];
        for &nb in sphere.neighbours(c as u32) {
            let ne = elev[nb as usize];
            if ne < best_elev {
                best_elev = ne;
                best = nb;
            }
        }
        out[c] = best;
    }
    out
}

/// Topological accumulation along `flow_dirs`. Each cell contributes 1 unit
/// and pushes its running total to its downstream receiver. Cells are
/// processed in descending-elevation order so dependencies are always
/// resolved before consumption.
pub fn compute_flow_accum(flow_dirs: &[u32], elev: &[f32]) -> Vec<u32> {
    let n = flow_dirs.len();
    assert_eq!(elev.len(), n);
    let mut accum = vec![1u32; n];
    let mut order: Vec<u32> = (0..n as u32).collect();
    // Sort by (elev DESC, idx ASC) for determinism.
    order.sort_by(|&a, &b| {
        elev[b as usize]
            .partial_cmp(&elev[a as usize])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.cmp(&b))
    });
    for &c in &order {
        let fd = flow_dirs[c as usize];
        if fd != NO_FLOW {
            accum[fd as usize] = accum[fd as usize].saturating_add(accum[c as usize]);
        }
    }
    accum
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sphere::VoronoiSphere;

    /// Single global peak at the north pole, smooth gradient toward south.
    /// Lower hemisphere is ocean (elev < 0).
    pub(crate) fn single_peak_elev(sphere: &VoronoiSphere, peak: f32) -> Vec<f32> {
        sphere
            .positions()
            .iter()
            .map(|p| {
                let h = p.y * peak;
                h.max(-peak * 0.5)
            })
            .collect()
    }

    #[test]
    fn fill_pits_is_idempotent_on_smooth_field() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let filled = fill_pits(&elev, &sphere);
        for (i, (&a, &b)) in elev.iter().zip(filled.iter()).enumerate() {
            assert!((a - b).abs() < 1e-3, "cell {} differs: {} vs {}", i, a, b);
        }
    }

    #[test]
    fn fill_pits_removes_local_minima() {
        let sphere = VoronoiSphere::new(8);
        let mut elev = single_peak_elev(&sphere, 4000.0);
        let mut bowl = None;
        for c in 0..elev.len() {
            if elev[c] < 800.0 || elev[c] > 3000.0 {
                continue;
            }
            if sphere
                .neighbours(c as u32)
                .iter()
                .all(|&n| elev[n as usize] > 500.0)
            {
                bowl = Some(c);
                break;
            }
        }
        let bowl = bowl.expect("expected a candidate bowl cell");
        elev[bowl] = 50.0;
        let pre_is_min = sphere
            .neighbours(bowl as u32)
            .iter()
            .all(|&n| elev[n as usize] > elev[bowl]);
        assert!(pre_is_min, "test setup failed to create a local min");

        let filled = fill_pits(&elev, &sphere);
        for c in 0..filled.len() {
            if filled[c] <= SEA_LEVEL {
                continue;
            }
            let has_lower = sphere
                .neighbours(c as u32)
                .iter()
                .any(|&n| filled[n as usize] < filled[c]);
            assert!(
                has_lower,
                "cell {} (elev {}) is still a local minimum after fill_pits",
                c, filled[c]
            );
        }
    }

    #[test]
    fn flow_dirs_point_downhill() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let filled = fill_pits(&elev, &sphere);
        let dirs = compute_flow_dirs(&filled, &sphere);
        for c in 0..filled.len() {
            if filled[c] <= SEA_LEVEL {
                continue;
            }
            let fd = dirs[c];
            assert!(
                fd != NO_FLOW,
                "land cell {} has no flow dir post fill_pits",
                c
            );
            assert!(
                filled[fd as usize] < filled[c],
                "flow_dirs[{}]={} elev {} >= self elev {}",
                c,
                fd,
                filled[fd as usize],
                filled[c],
            );
        }
    }

    #[test]
    fn flow_accum_total_equals_land_cell_count() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let filled = fill_pits(&elev, &sphere);
        let dirs = compute_flow_dirs(&filled, &sphere);
        let accum = compute_flow_accum(&dirs, &filled);

        let land_cells: u32 = filled.iter().filter(|&&e| e > SEA_LEVEL).count() as u32;
        let mut entering_ocean: u32 = 0;
        for c in 0..filled.len() {
            if filled[c] <= SEA_LEVEL {
                continue;
            }
            let fd = dirs[c];
            if fd != NO_FLOW && filled[fd as usize] <= SEA_LEVEL {
                entering_ocean = entering_ocean.saturating_add(accum[c]);
            }
        }
        assert_eq!(
            entering_ocean, land_cells,
            "flow accumulation entering ocean should equal land cell count"
        );
    }

    #[test]
    fn flow_accum_monotonic_non_decreasing_downstream() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let filled = fill_pits(&elev, &sphere);
        let dirs = compute_flow_dirs(&filled, &sphere);
        let accum = compute_flow_accum(&dirs, &filled);
        for c in 0..filled.len() {
            let fd = dirs[c];
            if fd == NO_FLOW {
                continue;
            }
            assert!(
                accum[fd as usize] >= accum[c],
                "downstream accum decreased: cell {} -> {} ({} -> {})",
                c,
                fd,
                accum[c],
                accum[fd as usize],
            );
        }
    }
}
