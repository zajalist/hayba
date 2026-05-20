//! Coarse-graph macro hydrology: Barnes Priority-Flood depression fill,
//! flow routing, drainage-area accumulation, and Cordonnier stream-power
//! fluvial incision on the irregular icosphere cell graph. Pure, O(N log N).

use glam::Vec3;

/// User-tunable erosion constants. Mirrors `climate::ClimateParams`:
/// `#[serde(default)]` so a missing/partial JSON payload yields defaults.
///
/// IMPORTANT — algorithm class: this CARVES an already-final input DEM
/// (painted, or sampled from real Earth). It is deliberately *not* an
/// uplift-driven landscape-evolution model: a stream-power law with a
/// uniform `uplift` term relaxes toward a steady state
/// `S = (U/K)^(1/n)·A^(-m/n)` that is independent of the initial
/// elevation — i.e. it ERASES the real heightmap (the
/// "distance-into-continent" artefact). So there is no uplift here;
/// instead incision is hard-clamped per step, balanced by hillslope
/// diffusion, and the final field is blended back toward the original
/// DEM by `strength` so the macro relief always survives.
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
    /// Max elevation a single incision step may remove (normalized
    /// units). Caps stream power so erosion can only etch fine detail,
    /// never bulldoze macro relief.
    pub max_incision_per_step: f32,
    /// Hillslope (thermal) diffusion coefficient D for the per-step
    /// Laplacian smoothing — talus, valley infill, ridge softening.
    pub hillslope_diffusion: f32,
    /// Final blend toward the eroded field: `h = lerp(h0, eroded, s)`.
    /// `0` = original DEM untouched, `1` = full erosion. Guarantees the
    /// real Earth/painted macro shape is preserved at any K/iterations.
    pub strength: f32,
    /// Drainage-area fraction (of max) above which a cell is "river".
    pub river_threshold: f32,
}

impl Default for ErosionParams {
    fn default() -> Self {
        Self {
            erodibility: 0.04,
            area_exp: 0.5,
            slope_exp: 1.0,
            iterations: 15,
            max_incision_per_step: 0.0015,
            hillslope_diffusion: 0.08,
            strength: 0.55,
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

/// Barnes Priority-Flood depression fill, writing the filled elevation
/// into the reused `filled` buffer (cleared and refilled from `elev`).
/// Splitting the body out of `priority_flood` lets `erode`'s iteration
/// loop reuse one allocation instead of `elev.to_vec()` every pass.
fn priority_flood_into(
    neighbours: &[Vec<u32>],
    elev: &[f32],
    is_ocean: &[bool],
    filled: &mut Vec<f32>,
) {
    let n = elev.len();
    filled.clear();
    filled.extend_from_slice(elev);
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
}

/// Allocating wrapper preserving the original public API. Hot callers
/// (`erode`) should call `priority_flood_into` with a reused buffer.
pub fn priority_flood(
    neighbours: &[Vec<u32>],
    elev: &[f32],
    is_ocean: &[bool],
) -> Vec<f32> {
    let mut filled = Vec::new();
    priority_flood_into(neighbours, elev, is_ocean, &mut filled);
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

/// One explicit stream-power incision pass (Cordonnier / Braun-Willett):
/// for each land cell, dz = -K * A^m * S^n * dt, where A is drainage
/// area, S the slope to its receiver. Ocean cells are fixed base level.
/// Clamped so a single step cannot punch a land cell below sea level
/// (prevents fluvial from manufacturing oceans; that is tectonics' job).
fn stream_power_step(
    recv: &[u32],
    pos: &[Vec3],
    area: &[f32],
    elev: &mut [f32],
    is_ocean: &[bool],
    dt: f32,
    p: &ErosionParams,
) {
    let n = elev.len();
    for i in 0..n {
        if is_ocean[i] { continue; }
        let r = recv[i] as usize;
        if r == i { continue; } // sink: no incision this pass
        let d = pos[i].distance(pos[r]).max(1e-6);
        let s = ((elev[i] - elev[r]) / d).max(0.0);
        let incision = (p.erodibility * area[i].powf(p.area_exp)
            * s.powf(p.slope_exp) * dt)
            .min(p.max_incision_per_step);
        let next = elev[i] - incision;
        // never erode a land cell below its receiver (no inversions) or
        // below sea level via fluvial alone.
        elev[i] = next.max(elev[r]).max(0.0);
    }
}

/// One explicit hillslope-diffusion (thermal creep) pass:
/// `dh = D * Σ_j (h_j - h_i)/d_ij²` averaged over neighbours, ocean
/// fixed. Smooths ridges, fills valley floors / talus, and balances
/// fluvial incision so the result is not pure cut-to-flat. The
/// per-cell weight is normalized by neighbour count and `D` is
/// clamped <0.5 so the explicit step is unconditionally stable.
fn hillslope_diffuse(
    neighbours: &[Vec<u32>],
    pos: &[Vec3],
    elev: &mut [f32],
    is_ocean: &[bool],
    d: f32,
    prev: &mut Vec<f32>,
) {
    if d <= 0.0 { return; }
    let k = d.min(0.45);
    prev.clear();
    prev.extend_from_slice(elev);
    for i in 0..elev.len() {
        if is_ocean[i] { continue; }
        let nbs = &neighbours[i];
        if nbs.is_empty() { continue; }
        let mut acc = 0.0_f32;
        for &nb in nbs {
            let j = nb as usize;
            acc += prev[j] - prev[i];
        }
        elev[i] = (prev[i] + k * acc / nbs.len() as f32).max(0.0);
    }
}

/// Full erosion driver. CARVES the input DEM `elev`: per iteration it
/// runs Priority-Flood → receivers → drainage → clamped stream-power
/// incision → hillslope diffusion. There is **no uplift** — that would
/// drive a steady state independent of the input and erase the real
/// heightmap. Finally the eroded field is blended back toward the
/// original DEM by `strength` so the macro relief (continents, mountain
/// belts) always survives; only sub-relief detail (valleys, channels,
/// talus) is added. Mutates `elev` in place. `cell_area` is the mean
/// cell area (km²) from the grid.
pub fn erode(
    neighbours: &[Vec<u32>],
    pos: &[Vec3],
    elev: &mut [f32],
    is_ocean: &[bool],
    cell_area: f32,
    p: &ErosionParams,
) {
    if p.iterations == 0 || p.strength <= 0.0 { return; }
    let h0: Vec<f32> = elev.to_vec(); // fixed reference DEM (macro shape)
    let dt = 1.0_f32;
    // Reused across iterations — replaces a per-pass `elev.to_vec()` in
    // both priority_flood and hillslope_diffuse (~2·iterations ~6 MB
    // allocations/bake at N≈1.5M). Algorithm output is bit-identical;
    // only the buffers' lifetime changes (per-call → per-erode).
    let mut pf_filled: Vec<f32> = Vec::new();
    let mut hs_prev: Vec<f32> = Vec::new();
    for _ in 0..p.iterations {
        priority_flood_into(neighbours, elev, is_ocean, &mut pf_filled);
        let recv = flow_receivers(neighbours, pos, &pf_filled);
        let area = drainage_area(&recv, cell_area);
        stream_power_step(&recv, pos, &area, elev, is_ocean, dt, p);
        hillslope_diffuse(
            neighbours, pos, elev, is_ocean, p.hillslope_diffusion, &mut hs_prev,
        );
    }
    // Macro-preserving blend: the carried detail is (eroded - h0); add
    // back only `strength` of it so the real DEM dominates.
    let s = p.strength.clamp(0.0, 1.0);
    for i in 0..elev.len() {
        if is_ocean[i] { continue; }
        elev[i] = (h0[i] + s * (elev[i] - h0[i])).max(0.0);
    }
}

/// River mask in [0,1]: 1 where drainage area exceeds
/// `threshold_frac * max_area`, with a soft edge.
pub fn river_mask(area: &[f32], threshold_frac: f32) -> Vec<f32> {
    let max_a = area.iter().cloned().fold(0.0_f32, f32::max).max(1e-6);
    let thr = threshold_frac * max_a;
    area.iter()
        .map(|&a| {
            let t = (a - thr * 0.5) / (thr * 0.5).max(1e-6);
            t.clamp(0.0, 1.0)
        })
        .collect()
}

/// Final hydrology fields shipped to the renderer.
pub struct HydrologyFields {
    /// Drainage area per cell (km²), normalized 0..1 by global max.
    pub drainage: Vec<f32>,
    /// River mask 0..1.
    pub river: Vec<f32>,
}

/// Erode `elev` in place, then return the drainage (normalized) + river
/// fields for the final post-erosion state. One call per bake.
pub fn compute_hydrology(
    neighbours: &[Vec<u32>],
    pos: &[Vec3],
    elev: &mut [f32],
    is_ocean: &[bool],
    cell_area: f32,
    p: &ErosionParams,
) -> HydrologyFields {
    erode(neighbours, pos, elev, is_ocean, cell_area, p);
    let filled = priority_flood(neighbours, elev, is_ocean);
    let recv = flow_receivers(neighbours, pos, &filled);
    let raw = drainage_area(&recv, cell_area);
    let max_a = raw.iter().cloned().fold(0.0_f32, f32::max).max(1e-6);
    let drainage = raw.iter().map(|&a| (a / max_a).clamp(0.0, 1.0)).collect();
    let river = river_mask(&raw, p.river_threshold);
    HydrologyFields { drainage, river }
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

    #[test]
    fn erode_lowers_land_toward_base_level_and_conserves_ocean() {
        // 3 cells: ocean(0.0) - 1(1.0) - 2(1.0). Erosion must lower land,
        // never touch ocean, never invert order, stay finite.
        let neighbours = vec![vec![1u32], vec![0, 2], vec![1]];
        let pos = vec![Vec3::X, Vec3::new(1.0,0.1,0.0).normalize(),
                       Vec3::new(1.0,0.2,0.0).normalize()];
        let mut elev = vec![0.0_f32, 1.0, 1.0];
        let is_ocean = vec![true, false, false];
        let p = ErosionParams::default();
        erode(&neighbours, &pos, &mut elev, &is_ocean, 1.0, &p);
        assert!((elev[0]).abs() < 1e-6, "ocean cell untouched");
        assert!(elev[1].is_finite() && elev[2].is_finite());
        assert!(elev[1] <= 1.0 + 1e-6 && elev[2] <= 1.0 + 1e-6,
                "land not raised above start by net erosion");
        assert!(elev[1] >= 0.0, "land not eroded below sea level by fluvial");
    }

    #[test]
    fn priority_flood_into_reused_buffer_is_bit_identical_to_fresh() {
        // Same pit fixture as priority_flood_fills_a_pit_to_its_lowest_rim.
        let neighbours = vec![vec![1u32], vec![0, 2], vec![1, 3], vec![2]];
        let elev = vec![0.0_f32, 5.0, 1.0, 6.0];
        let is_ocean = vec![true, false, false, false];
        let fresh = priority_flood(&neighbours, &elev, &is_ocean);
        // Pre-seed the reused buffer with garbage AND a different length to
        // prove clear()+extend_from_slice fully overwrites it.
        let mut reused: Vec<f32> =
            vec![f32::NAN, -1.0, 12345.6, 7.0, 8.0, 9.0, 10.0];
        priority_flood_into(&neighbours, &elev, &is_ocean, &mut reused);
        assert_eq!(reused.len(), fresh.len(), "length must match fresh alloc");
        for (a, b) in reused.iter().zip(fresh.iter()) {
            assert_eq!(a.to_bits(), b.to_bits(), "bit-identical to fresh");
        }
    }

    #[test]
    fn hillslope_diffuse_output_independent_of_incoming_buffer() {
        let neighbours = vec![vec![1u32], vec![0, 2], vec![1, 3], vec![2]];
        // pos is unused by hillslope_diffuse; any vec of the right length.
        let pos = vec![Vec3::X, Vec3::X, Vec3::X, Vec3::X];
        let is_ocean = vec![true, false, false, false];
        let base = vec![0.0_f32, 4.0, 1.0, 6.0];
        let mut e1 = base.clone();
        let mut fresh_buf: Vec<f32> = Vec::new();
        hillslope_diffuse(&neighbours, &pos, &mut e1, &is_ocean, 0.3, &mut fresh_buf);
        let mut e2 = base.clone();
        let mut dirty_buf: Vec<f32> = vec![f32::NAN; 2];
        hillslope_diffuse(&neighbours, &pos, &mut e2, &is_ocean, 0.3, &mut dirty_buf);
        assert_eq!(e1.len(), e2.len());
        for (x, y) in e1.iter().zip(e2.iter()) {
            assert_eq!(x.to_bits(), y.to_bits(),
                       "hillslope result must not depend on buffer residue");
        }
    }

    #[test]
    fn erode_is_bit_identical_across_independent_runs() {
        // ErosionParams::default().iterations is large (>3) so the reused
        // pf_filled / hs_prev buffers are exercised across many passes.
        let neighbours = vec![vec![1u32], vec![0, 2], vec![1, 3], vec![2]];
        let pos = vec![
            Vec3::X,
            Vec3::new(1.0, 0.1, 0.0).normalize(),
            Vec3::new(1.0, 0.2, 0.0).normalize(),
            Vec3::new(1.0, 0.3, 0.0).normalize(),
        ];
        let start = vec![0.0_f32, 3.0, 5.0, 2.0];
        let is_ocean = vec![true, false, false, false];
        let p = ErosionParams::default();
        let mut a = start.clone();
        erode(&neighbours, &pos, &mut a, &is_ocean, 1.0, &p);
        let mut b = start.clone();
        erode(&neighbours, &pos, &mut b, &is_ocean, 1.0, &p);
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(b.iter()) {
            assert_eq!(x.to_bits(), y.to_bits(),
                       "buffer reuse must not perturb erosion output");
        }
    }

    #[test]
    fn river_mask_marks_high_drainage_cells() {
        let area = vec![100.0_f32, 5.0, 1.0];
        let m = river_mask(&area, 0.1); // threshold = 0.1 * max(=100) = 10
        assert!(m[0] > 0.5, "big drainage = river");
        assert!(m[1] < 0.5 && m[2] < 0.5, "small drainage = not river");
    }

    #[test]
    fn compute_hydrology_returns_aligned_finite_fields() {
        let neighbours = vec![vec![1u32], vec![0, 2], vec![1]];
        let pos = vec![Vec3::X, Vec3::new(1.0,0.1,0.0).normalize(),
                       Vec3::new(1.0,0.2,0.0).normalize()];
        let mut elev = vec![0.0_f32, 1.0, 2.0];
        let is_ocean = vec![true, false, false];
        let h = compute_hydrology(&neighbours, &pos, &mut elev, &is_ocean,
                                  10.0, &ErosionParams::default());
        assert_eq!(h.drainage.len(), 3);
        assert_eq!(h.river.len(), 3);
        assert!(h.drainage.iter().all(|v| v.is_finite() && *v >= 0.0));
        assert!(h.river.iter().all(|v| (0.0..=1.0).contains(v)));
        assert!(elev.iter().all(|v| v.is_finite()), "elevation eroded in place");
    }
}
