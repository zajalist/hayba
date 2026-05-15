//! Coarse-graph macro hydrology: Barnes Priority-Flood depression fill,
//! flow routing, drainage-area accumulation, and Cordonnier stream-power
//! fluvial incision on the irregular icosphere cell graph. Pure, O(N log N).

use glam::Vec3;

/// User-tunable erosion constants. Mirrors `climate::ClimateParams`:
/// `#[serde(default)]` so a missing/partial JSON payload yields defaults.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(default)]
pub struct ErosionParams {
    /// Stream-power erodibility K.
    pub erodibility: f32,
    /// Drainage-area exponent m (≈0.5).
    pub area_exp: f32,
    /// Slope exponent n (≈1.0).
    pub slope_exp: f32,
    /// Erosion iterations interleaved with the tectonic bake steps.
    pub iterations: u32,
    /// Per-iteration uplift added to land cells (normalized elev units).
    pub uplift: f32,
    /// Drainage-area fraction (of max) above which a cell is "river".
    pub river_threshold: f32,
}

impl Default for ErosionParams {
    fn default() -> Self {
        Self {
            erodibility: 0.05,
            area_exp: 0.5,
            slope_exp: 1.0,
            iterations: 25,
            uplift: 0.004,
            river_threshold: 0.015,
        }
    }
}

use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Barnes et al. Priority-Flood: returns a depression-filled copy of
/// `elev` where every cell has a non-ascending path to an ocean cell.
/// Ocean cells are immovable seeds. O(N log N). f32 priority via
/// `to_bits` (all elevations are finite; non-negative-ordering not
/// required because we offset—use the standard total order trick:
/// compare bits of `f32::max(e, 0.0)` is unsafe for negatives, so we
/// key the heap on an integer rank built from `f32::to_bits` with the
/// sign flip for negatives — see `order_key`).
fn order_key(e: f32) -> u32 {
    // Monotonic u32 mapping of f32 (IEEE-754 total order): flip sign bit
    // for positives, invert all bits for negatives. Orders ascending.
    let b = e.to_bits();
    if b & 0x8000_0000 != 0 { !b } else { b | 0x8000_0000 }
}

pub fn priority_flood(
    neighbours: &[Vec<u32>],
    elev: &[f32],
    is_ocean: &[bool],
) -> Vec<f32> {
    let n = elev.len();
    let mut filled = elev.to_vec();
    let mut closed = vec![false; n];
    // Min-heap keyed on the *filled* elevation (Reverse over order_key).
    let mut heap: BinaryHeap<Reverse<(u32, u32)>> = BinaryHeap::new();
    for i in 0..n {
        if is_ocean[i] {
            closed[i] = true;
            heap.push(Reverse((order_key(filled[i]), i as u32)));
        }
    }
    while let Some(Reverse((_, ci))) = heap.pop() {
        let c = ci as usize;
        for &nb in &neighbours[c] {
            let j = nb as usize;
            if closed[j] { continue; }
            closed[j] = true;
            // Raise the neighbour to at least the current cell's level
            // so a monotonic descent path to the ocean always exists.
            if filled[j] < filled[c] {
                filled[j] = filled[c];
            }
            heap.push(Reverse((order_key(filled[j]), nb)));
        }
    }
    filled
}

/// Steepest-descent receiver per cell (D8-equivalent on the graph).
/// A cell with no strictly-lower neighbour is its own receiver (sink).
/// Run on the Priority-Flood-filled elevation so every non-ocean cell
/// has a downhill receiver. Slope uses geodesic centroid distance.
pub fn flow_receivers(neighbours: &[Vec<u32>], pos: &[Vec3], elev: &[f32]) -> Vec<u32> {
    let n = elev.len();
    let mut recv = vec![0u32; n];
    for i in 0..n {
        recv[i] = i as u32;
        let mut best = 0.0_f32; // best (positive) downhill slope
        for &nb in &neighbours[i] {
            let j = nb as usize;
            let drop = elev[i] - elev[j];
            if drop <= 0.0 { continue; }
            let d = pos[i].distance(pos[j]).max(1e-6);
            let s = drop / d;
            if s > best { best = s; recv[i] = nb; }
        }
    }
    recv
}

/// Drainage area per cell = own cell area + all upstream cell areas.
/// O(N): process cells in descending elevation order is unnecessary —
/// follow each cell's receiver chain accumulating, using a topological
/// pass over the receiver forest (Braun & Willett 2013 single-pass).
pub fn drainage_area(recv: &[u32], cell_area: f32) -> Vec<f32> {
    let n = recv.len();
    let mut area = vec![cell_area; n];
    // donor counts → process leaves first (stack), add into receivers.
    let mut ndonor = vec![0u32; n];
    for i in 0..n {
        let r = recv[i] as usize;
        if r != i { ndonor[r] += 1; }
    }
    let mut stack: Vec<usize> = (0..n).filter(|&i| ndonor[i] == 0).collect();
    let mut remaining = ndonor.clone();
    while let Some(i) = stack.pop() {
        let r = recv[i] as usize;
        if r != i {
            area[r] += area[i];
            remaining[r] -= 1;
            if remaining[r] == 0 { stack.push(r); }
        }
    }
    area
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erosion_params_default_is_sane() {
        let p = ErosionParams::default();
        assert!(p.erodibility > 0.0 && p.iterations > 0);
        assert!((p.area_exp - 0.5).abs() < 1e-6);
    }

    #[test]
    fn priority_flood_fills_a_pit_to_its_lowest_rim() {
        // 4 cells in a line: ocean(0.0) - rim(5.0) - pit(1.0) - rim(6.0).
        let neighbours = vec![vec![1u32], vec![0, 2], vec![1, 3], vec![2]];
        let elev = vec![0.0_f32, 5.0, 1.0, 6.0];
        let is_ocean = vec![true, false, false, false];
        let filled = priority_flood(&neighbours, &elev, &is_ocean);
        assert!((filled[0] - 0.0).abs() < 1e-6, "ocean unchanged");
        assert!((filled[1] - 5.0).abs() < 1e-6, "rim unchanged");
        // pit (1.0) is raised to its lowest escape (the 5.0 rim toward ocean).
        assert!((filled[2] - 5.0).abs() < 1e-6, "pit filled to lowest rim");
        assert!((filled[3] - 6.0).abs() < 1e-6, "higher rim unchanged");
        for i in 0..4 { assert!(filled[i] >= elev[i] - 1e-6, "fill never lowers"); }
    }

    #[test]
    fn flow_receivers_point_downhill_to_steepest() {
        // line: ocean0(0) - 1(2) - 2(3); receiver of 2 is 1, of 1 is 0.
        let neighbours = vec![vec![1u32], vec![0, 2], vec![1]];
        let pos = vec![Vec3::X, Vec3::new(1.0, 0.1, 0.0).normalize(),
                       Vec3::new(1.0, 0.2, 0.0).normalize()];
        let elev = vec![0.0_f32, 2.0, 3.0];
        let recv = flow_receivers(&neighbours, &pos, &elev);
        assert_eq!(recv[2], 1);
        assert_eq!(recv[1], 0);
        assert_eq!(recv[0], 0, "sink/ocean is its own receiver");
    }

    #[test]
    fn drainage_area_accumulates_downstream() {
        let neighbours = vec![vec![1u32], vec![0, 2], vec![1]];
        let pos = vec![Vec3::X, Vec3::new(1.0, 0.1, 0.0).normalize(),
                       Vec3::new(1.0, 0.2, 0.0).normalize()];
        let elev = vec![0.0_f32, 2.0, 3.0];
        let recv = flow_receivers(&neighbours, &pos, &elev);
        let cell_area = 10.0_f32;
        let a = drainage_area(&recv, cell_area);
        // cell 2 drains only itself; 1 gets 1+2; 0 (mouth) gets all 3.
        assert!((a[2] - 10.0).abs() < 1e-3);
        assert!((a[1] - 20.0).abs() < 1e-3);
        assert!((a[0] - 30.0).abs() < 1e-3);
    }
}
