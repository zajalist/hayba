//! Erosion-rework Task 1 — rasterize the painted draft + climate
//! precipitation onto ONE equirectangular grid for the GPU hydraulic
//! simulation.
//!
//! Coordinate convention (FIXED — identical in the GLSL passes and
//! `debugMaterial.ts`): equirect texel `(rx, ry)`, `rx ∈ [0, w)`,
//! `ry ∈ [0, h)`, **row `ry = 0` is the North-pole row**.
//!   `lat = 90 - (ry + 0.5)/h * 180`  (degrees)
//!   `lon = (rx + 0.5)/w * 360 - 180` (degrees)
//!
//! Elevation/ocean sign convention mirrors `wizard.rs::bake_impl` Step 4
//! exactly: painter override > continental-brush floor (`0.05`) >
//! deep-ocean floor (`-1.0`). Land is `> 0`, ocean is `< 0`, unpainted is
//! the `-1.0` deep-ocean floor.

use glam::Vec3;
use rayon::prelude::*;

use hayba_tectonics_v2::model::Model;

use crate::climate::{compute_climate, ClimateParams};
use crate::scale::WorldScale;
use crate::wizard::WizardDraft;

/// Equirectangular bake inputs handed to the TS hydraulic pipeline.
/// `height`/`precip` are row-major (`ry*w + rx`, `ry = 0` = North pole),
/// length `w*h`.
#[derive(serde::Serialize)]
pub struct EquirectInputs {
    pub w: u32,
    pub h: u32,
    /// Per-texel painted elevation. Continents `> 0`, deep ocean `< 0`,
    /// unpainted = the wizard's deep-ocean-floor value (`-1.0`).
    pub height: Vec<f32>,
    /// Per-texel climate precipitation, normalized and clamped to `[0, 2]`.
    pub precip: Vec<f32>,
    /// Metre-denominated world scale for the GPU hydraulic sim (Gaea §10).
    /// Planet macro default here; S3 overrides per zoom-tile.
    pub scale: WorldScale,
}

// Painter precedence floors — these MUST mirror `wizard.rs::bake_impl`
// Step 4 (and `painted_cells_from_draft`): painter override >
// continental-brush floor > deep-ocean floor. Kept in lockstep with the
// wizard's own constants (which are documented there with the identical
// note); if those change, change these too.
const CONTINENTAL_BRUSH_FLOOR: f32 = 0.05;
const DEEP_OCEAN_FLOOR: f32 = -1.0;

/// Per-cell painted elevation derived from the draft using the EXACT
/// precedence `wizard.rs::bake_impl` Step 4 uses (painter override >
/// continental-brush floor > deep-ocean floor). Returns the icosphere
/// per-cell unit-sphere position alongside the elevation. This mirrors
/// `wizard.rs::painted_cells_from_draft` (kept separate so wizard.rs is
/// untouched in this task — the rework deletes the v2 path later anyway).
fn painted_cells(draft: &WizardDraft) -> Vec<(Vec3, f32)> {
    // `Model::new` gives the icosphere grid + per-cell unit-sphere
    // positions without stepping the sim — identical geometry to the path
    // `bake_impl` uses, just no tectonics/erosion.
    let model = Model::new(draft.divisions, draft.seed);
    let n_cells = model.grid.n_fields();

    let mut user_continental = vec![false; n_cells as usize];
    for &fid in &draft.continental_cells {
        if fid < n_cells {
            user_continental[fid as usize] = true;
        }
    }

    let mut cells: Vec<(Vec3, f32)> = Vec::with_capacity(n_cells as usize);
    for fid in 0..n_cells {
        let painted = draft
            .painted_mask
            .get(fid as usize)
            .copied()
            .unwrap_or(0)
            == 1;
        let elevation = if painted {
            draft
                .painted_elevations
                .get(fid as usize)
                .copied()
                .unwrap_or(0.0)
                .clamp(-1.0, 1.0)
        } else if user_continental[fid as usize] {
            CONTINENTAL_BRUSH_FLOOR
        } else {
            DEEP_OCEAN_FLOOR
        };
        cells.push((model.grid.position(fid).normalize_or_zero(), elevation));
    }
    cells
}

/// Build a `Model` whose per-cell elevations/crust reflect the painted
/// draft (NO tectonic stepping), then run the existing `compute_climate`
/// to get the per-cell precipitation field (normalized 0..1). The crust
/// assignment mirrors `wizard.rs::bake_impl` Step 4 so the climate model
/// sees the same land/ocean partition the renderer does.
fn painted_precip(draft: &WizardDraft, cells: &[(Vec3, f32)]) -> Vec<f32> {
    let mut model = Model::new(draft.divisions, draft.seed);
    let n_cells = model.grid.n_fields() as usize;
    for (fid, &(_, elevation)) in cells.iter().enumerate().take(n_cells) {
        let cont = elevation > 0.0;
        model.apply_field_initial_state(fid, elevation, cont);
    }
    let params = ClimateParams::default();
    compute_climate(&model, draft.seed, false, &params).precip
}

/// A directional bucket grid over the cells' unit-direction vectors so
/// the per-texel nearest-cell query is ~O(1) instead of O(cells).
///
/// Binning: cell direction → geographic `(lat, lon)` (`lat = asin(y)`,
/// `lon = atan2(z, x)` — the SAME Y-up convention the rasterizer texel
/// loop uses), then
///   `lat_band = floor((lat + π/2) / π     * n_lat)`  clamped `[0,n_lat)`
///   `lon_bin  = floor((lon + π)  / (2π)   * n_lon)`  mod   `n_lon`
/// Both axes are sized `≈ √(n_cells)` so a quasi-uniform Goldberg grid
/// averages ~1 cell per bucket.
///
/// Query correctness (must be byte-IDENTICAL to brute force): the true
/// nearest cell lies within a small angular cap around the texel
/// direction. We scan the texel's `lat_band ± 1` (3 bands — one band is
/// `π/n_lat ≈ π/√n` rad tall, ≥ the Goldberg cell spacing, so the nearest
/// cell's band is always within ±1). Longitude bins CONVERGE toward the
/// poles (a fixed lon-bin count spans a shrinking arc as `cos(lat)→0`),
/// so the lon half-width in BINS is widened by `1/cos(lat)` (clamped to a
/// full wrap at the poles) and the lon scan WRAPS at ±π. This only prunes
/// the candidate set — the winner is still the exact global max dot
/// product, proven equal to brute force by `spatial_eq_bruteforce_*`.
struct CellGrid<'a> {
    cells: &'a [(Vec3, f32)],
    n_lat: usize,
    n_lon: usize,
    /// `buckets[band * n_lon + bin]` = indices of cells in that bucket.
    buckets: Vec<Vec<u32>>,
}

impl<'a> CellGrid<'a> {
    fn build(cells: &'a [(Vec3, f32)]) -> Self {
        // ≈ √(n_cells) per axis; at least 1 so tiny drafts still work.
        let n = cells.len().max(1);
        let axis = (n as f64).sqrt().ceil() as usize;
        let n_lat = axis.max(1);
        let n_lon = axis.max(1);
        let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); n_lat * n_lon];
        for (i, &(p, _)) in cells.iter().enumerate() {
            let (band, bin) = Self::bucket_of(p, n_lat, n_lon);
            buckets[band * n_lon + bin].push(i as u32);
        }
        CellGrid { cells, n_lat, n_lon, buckets }
    }

    /// Map a unit direction to its `(lat_band, lon_bin)`.
    #[inline]
    fn bucket_of(p: Vec3, n_lat: usize, n_lon: usize) -> (usize, usize) {
        use std::f32::consts::PI;
        let lat = p.y.clamp(-1.0, 1.0).asin(); // [-π/2, π/2]
        let lon = p.z.atan2(p.x); // [-π, π]
        let bf = ((lat + PI * 0.5) / PI) * n_lat as f32;
        let band = (bf.floor() as isize).clamp(0, n_lat as isize - 1) as usize;
        let lf = ((lon + PI) / (2.0 * PI)) * n_lon as f32;
        let mut bin = lf.floor() as isize;
        // Wrap (lon == +π lands exactly at n_lon).
        bin = bin.rem_euclid(n_lon as isize);
        (band, bin as usize)
    }

    /// Exact nearest cell (max dot product) to `dir` — identical result
    /// to a brute-force scan over all cells, just pruned to the relevant
    /// bucket neighborhood.
    #[inline]
    fn nearest(&self, dir: Vec3, lat: f32) -> (usize, f32) {
        // Texel's own bucket (reuse bucket_of via the dir vector).
        let (band0, bin0) = Self::bucket_of(dir, self.n_lat, self.n_lon);

        // Lon half-width in BINS: one bin spans `2π/n_lon` rad of lon,
        // which is `cos(lat) * 2π/n_lon` rad of GREAT-CIRCLE arc. To
        // cover the same arc as one lat band (`π/n_lat` rad) plus the ±1
        // band slack, widen by `1/cos(lat)`. Clamp at the poles so we
        // simply scan every lon bin (a full wrap) where `cos(lat)→0`.
        let cos_lat = lat.cos().abs().max(1e-4);
        // Base ±2 bins of slack, scaled by the polar lon convergence.
        let lon_half = (((2.0 / cos_lat).ceil()) as isize)
            .clamp(1, self.n_lon as isize);
        let full_lon = lon_half * 2 + 1 >= self.n_lon as isize;

        let mut best_dot = f32::NEG_INFINITY;
        let mut best_idx = 0usize;

        let band_lo = (band0 as isize - 1).max(0) as usize;
        let band_hi = ((band0 as isize + 1).min(self.n_lat as isize - 1)) as usize;

        for band in band_lo..=band_hi {
            if full_lon {
                // Polar row: every lon bin in this band is in range.
                let row = band * self.n_lon;
                for bin in 0..self.n_lon {
                    for &ci in &self.buckets[row + bin] {
                        let cpos = self.cells[ci as usize].0;
                        let d = cpos.dot(dir);
                        if d > best_dot {
                            best_dot = d;
                            best_idx = ci as usize;
                        }
                    }
                }
            } else {
                let row = band * self.n_lon;
                for off in -lon_half..=lon_half {
                    let bin = (bin0 as isize + off)
                        .rem_euclid(self.n_lon as isize)
                        as usize;
                    for &ci in &self.buckets[row + bin] {
                        let cpos = self.cells[ci as usize].0;
                        let d = cpos.dot(dir);
                        if d > best_dot {
                            best_dot = d;
                            best_idx = ci as usize;
                        }
                    }
                }
            }
        }
        (best_idx, best_dot)
    }

    /// The `k` nearest cells to `dir` (smallest angular distance), each as
    /// `(cell_idx, angular_dist)` where `angular_dist = 1 - dot` (a
    /// monotonic, cheap proxy for the great-circle angle — exact ordering,
    /// no `acos`). Generalizes `nearest`: it uses the SAME ring-expanding
    /// `lat_band ± 1` / polar-convergence-widened lon scan that `nearest`
    /// proves is sufficient to contain the global single-NN. Since the true
    /// k-nearest all lie no farther than progressively-farther cells in the
    /// same neighborhood, and that neighborhood already provably contains
    /// the #1 NN within ±1 lat band, we widen the lat scan to `±2` bands
    /// here (one extra band of slack beyond `nearest`'s ±1) so the first
    /// `k` (k ≤ 6 ≪ cells/band) closest are guaranteed captured for a
    /// quasi-uniform Goldberg grid. The result is sorted ascending by
    /// distance and truncated to `k`.
    #[inline]
    fn k_nearest(&self, dir: Vec3, lat: f32, k: usize) -> Vec<(usize, f32)> {
        let (band0, bin0) = Self::bucket_of(dir, self.n_lat, self.n_lon);

        let cos_lat = lat.cos().abs().max(1e-4);
        // One extra bin of lon slack vs `nearest` (3/cos_lat instead of
        // 2/cos_lat) to match the widened ±2 lat scan.
        let lon_half = (((3.0 / cos_lat).ceil()) as isize)
            .clamp(1, self.n_lon as isize);
        let full_lon = lon_half * 2 + 1 >= self.n_lon as isize;

        // ±2 bands (one more than `nearest`'s ±1) so the k-th nearest is
        // safely inside the scanned neighborhood for a Goldberg grid.
        let band_lo = (band0 as isize - 2).max(0) as usize;
        let band_hi = ((band0 as isize + 2).min(self.n_lat as isize - 1)) as usize;

        // Collect candidates; k is tiny so a sort of the (modest) candidate
        // set is cheaper than maintaining a heap and keeps determinism
        // trivial (stable sort by (dist, idx)).
        let mut cand: Vec<(usize, f32)> = Vec::new();
        for band in band_lo..=band_hi {
            let row = band * self.n_lon;
            if full_lon {
                for bin in 0..self.n_lon {
                    for &ci in &self.buckets[row + bin] {
                        let cpos = self.cells[ci as usize].0;
                        let d = 1.0 - cpos.dot(dir);
                        cand.push((ci as usize, d));
                    }
                }
            } else {
                for off in -lon_half..=lon_half {
                    let bin = (bin0 as isize + off)
                        .rem_euclid(self.n_lon as isize)
                        as usize;
                    for &ci in &self.buckets[row + bin] {
                        let cpos = self.cells[ci as usize].0;
                        let d = 1.0 - cpos.dot(dir);
                        cand.push((ci as usize, d));
                    }
                }
            }
        }
        // Deterministic order: by distance, tie-break by cell index.
        cand.sort_by(|a, b| {
            a.1
                .partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.cmp(&b.0))
        });
        cand.truncate(k);
        cand
    }
}

/// Deterministic 4-octave fractal Brownian motion built on
/// `crate::climate::value_noise` (kept LOCAL so climate.rs is untouched —
/// `climate::fbm3` is private and this task must not widen its API).
/// Returns roughly `[0, 1]` (mean ~0.5). `value_noise` floors its input,
/// so callers must pre-scale `p` by a frequency. Mirrors `climate::fbm3`'s
/// octave/lacunarity/gain pattern (freq ×2.03, amp ×0.5) with an extra
/// 5th octave for finer sub-cell detail.
#[inline]
fn fbm(p: Vec3, seed: u64) -> f32 {
    let mut f = 0.0f32;
    let mut amp = 0.5f32;
    let mut freq = 1.0f32;
    for o in 0..5u64 {
        f += amp * crate::climate::value_noise(p * freq, seed.wrapping_add(o * 1013));
        freq *= 2.03;
        amp *= 0.5;
    }
    f
}

// ── Continuous-bake tuning constants ───────────────────────────────────
// All judgement calls; tunable, visually validated next on the real GPU.
//
/// k-nearest cells used for the inverse-distance macro blend. 6 ≈ the
/// Goldberg 1-ring (hexagonal) — enough to smooth the per-cell plateau
/// without washing out the painted macro shape.
const IDW_K: usize = 6;
/// IDW weight epsilon — guards the `1/d²` singularity when a texel sits
/// exactly on a cell centre. Small so off-centre weighting is unaffected.
const IDW_EPS: f32 = 1e-6;
/// Fixed relief seed → byte-deterministic output (no RNG, no threads).
const RELIEF_SEED: u64 = 0x4159_BA00_5EED_0001;
/// Domain-warp seed (decorrelated low-freq vector offset → less
/// grid-aligned ridges).
const WARP_SEED: u64 = 0x4159_BA00_5EED_0002;
/// Base 3D noise frequency (on the unit `dir` sphere). ~12 reads as
/// crisp sub-cell detail at 1024–2048 equirect width.
const RELIEF_FREQ: f32 = 12.0;
/// Low-frequency domain-warp scale and displacement magnitude.
const WARP_FREQ: f32 = 2.5;
const WARP_AMP: f32 = 0.15;
/// Baseline relief amplitude added EVERYWHERE (flat plains / Tibet /
/// ocean floor) so the sim always has erodable micro-slope. A few % of
/// the painted land range (~[0,1]).
const RELIEF_BASE_AMP: f32 = 0.018;
/// Extra amplitude scaled by |elevation| — mountains get richer dendritic
/// carving (up to ~+18% of range at |elev|≈1).
const RELIEF_ELEV_AMP: f32 = 0.18;
/// Sign-preserving clamp epsilons — final land ≥ +LAND_EPS, ocean ≤
/// −OCEAN_EPS, so blend+relief can NEVER move a texel across 0 (the GPU
/// sim's `base.r < 0` ocean flag is load-bearing). LAND_EPS is well below
/// `CONTINENTAL_BRUSH_FLOOR` (0.05) so it never lifts a coast visibly.
const LAND_EPS: f32 = 1e-3;
const OCEAN_EPS: f32 = 1e-3;

/// Rasterize the painted draft + climate precipitation onto one
/// equirectangular `w × h` grid. For each texel, the FIXED convention
/// (row 0 = North pole) gives `(lat, lon)` → a unit-sphere direction
/// `dir`. Then, per texel:
///
/// 1. **Class from nearest** — the single nearest cell (`grid.nearest`)
///    decides the texel CLASS (land if `nearest_elev >= 0`, else ocean).
///    The land/ocean boundary stays EXACTLY where nearest-cell
///    classification puts it (the GPU sim derives ocean from `base.r < 0`).
/// 2. **Continuous macro elevation** — inverse-distance-weighted mean of
///    the `IDW_K` nearest cells whose elevation sign matches the class
///    (opposite-class neighbors skipped so the coast stays crisp and
///    ocean depth never bleeds into land). `precip` blended the same way.
/// 3. **Seeded fractal sub-cell relief** — 5-octave `fbm` of `dir`
///    (3D ⇒ seamless across the ±180° wrap and at the poles), with a cheap
///    low-freq domain warp, elevation-modulated amplitude (baseline
///    everywhere + more on high ground). Added to the blended elevation.
/// 4. **Sign-preserving clamp** — land → `max(+LAND_EPS)`, ocean →
///    `min(-OCEAN_EPS)`; non-finite → class-appropriate fallback.
///
/// The nearest-cell lookup is accelerated by a `CellGrid` directional
/// bucket index. Output is byte-deterministic for identical `(draft,w,h)`
/// (fixed seed, no RNG, single-threaded). The land/ocean MASK is
/// byte-identical to the old nearest-cell reference (see
/// `spatial_eq_bruteforce_*` / `ocean_coast_sign_invariant_*` tests).
pub fn bake_inputs_equirect_impl(draft: &WizardDraft, w: u32, h: u32) -> EquirectInputs {
    let cells = painted_cells(draft);
    let precip_per_cell = painted_precip(draft, &cells);
    let grid = CellGrid::build(&cells);

    let n = (w as usize) * (h as usize);
    let mut height = vec![0.0f32; n];
    let mut precip = vec![0.0f32; n];

    // Parallelise over latitude ROWS: each row writes a DISJOINT
    // `w`-length slice and the per-texel math (`fill_equirect_row`) is
    // pure — immutable `&grid`/`&cells`, fixed-seed `fbm`, no RNG — so the
    // output is byte-identical to the serial oracle regardless of thread
    // scheduling (asserted by `parallel_rasterise_is_byte_identical_to_serial`).
    // This is the freeze fix: the old single-threaded IDW+FBM loop pegged
    // one core for tens of seconds at 2048×1024.
    height
        .par_chunks_mut(w as usize)
        .zip(precip.par_chunks_mut(w as usize))
        .enumerate()
        .for_each(|(ry, (hrow, prow))| {
            fill_equirect_row(
                ry as u32, w, h, &grid, &cells, &precip_per_cell, hrow, prow,
            );
        });

    EquirectInputs { w, h, height, precip, scale: WorldScale::planet_default() }
}

/// Fill ONE equirect row `ry` into the disjoint `hrow`/`prow` slices (each
/// length `w`). Pure given `(grid, cells, precip_per_cell, w, h, ry)` — no
/// shared mutable state, no RNG, fixed-seed `fbm` — so invoking it per row
/// in parallel is byte-identical to invoking it serially. This is the
/// SINGLE source of the rasterise math, shared by the parallel
/// `bake_inputs_equirect_impl` and the `#[cfg(test)]` serial oracle, so the
/// two can never numerically diverge.
fn fill_equirect_row(
    ry: u32,
    w: u32,
    h: u32,
    grid: &CellGrid,
    cells: &[(Vec3, f32)],
    precip_per_cell: &[f32],
    hrow: &mut [f32],
    prow: &mut [f32],
) {
    // Row 0 = North pole. lat in degrees, then radians.
    let lat_deg = 90.0 - (ry as f32 + 0.5) / h as f32 * 180.0;
    let lat = lat_deg.to_radians();
    let (sin_lat, cos_lat) = lat.sin_cos();
    for rx in 0..w {
        let lon_deg = (rx as f32 + 0.5) / w as f32 * 360.0 - 180.0;
        let lon = lon_deg.to_radians();
        // Y-up, North pole at (0, 1, 0); matches `wizard.rs`'s
        // sphere convention (lat→y, lon→atan2(z, x)).
        let (sin_lon, cos_lon) = lon.sin_cos();
        let dir = Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);

        // (1) CLASS from the single nearest cell — load-bearing: the
        // GPU sim's ocean flag is `base.r < 0`, so the land/ocean
        // boundary must stay EXACTLY where nearest-cell puts it.
        let (best_idx, _) = grid.nearest(dir, lat);
        let nearest_elev =
            cells.get(best_idx).map(|&(_, e)| e).unwrap_or(DEEP_OCEAN_FLOOR);
        let is_land = nearest_elev >= 0.0;

        // (2) CONTINUOUS macro elevation — IDW over the k-nearest
        // SAME-CLASS cells only (skip opposite-class so the coast stays
        // crisp and ocean depth never bleeds into land or vice-versa).
        let knn = grid.k_nearest(dir, lat, IDW_K);
        let mut wsum = 0.0f32;
        let mut elev_acc = 0.0f32;
        let mut precip_acc = 0.0f32;
        for &(ci, d) in &knn {
            let (_, ce) = cells[ci];
            if (ce >= 0.0) != is_land {
                continue; // opposite class — preserve crisp coast
            }
            let wt = 1.0 / (d * d + IDW_EPS);
            wsum += wt;
            elev_acc += wt * ce;
            precip_acc += wt * precip_per_cell.get(ci).copied().unwrap_or(0.0);
        }
        let (mut macro_elev, blended_precip) = if wsum > 0.0 {
            (elev_acc / wsum, precip_acc / wsum)
        } else {
            // Degenerate: no same-class neighbor in k → fall back to
            // the nearest cell exactly.
            (
                nearest_elev,
                precip_per_cell.get(best_idx).copied().unwrap_or(0.0),
            )
        };
        if !macro_elev.is_finite() {
            macro_elev = nearest_elev;
        }

        // (3) SEEDED FRACTAL SUB-CELL RELIEF — sampled in 3D on `dir`
        // (seamless across the ±180° wrap and continuous at the poles;
        // a uv-space seam would become a visible erosion seam). Cheap
        // low-freq domain warp for less grid-aligned ridges.
        let warp = Vec3::new(
            fbm(dir * WARP_FREQ, WARP_SEED) - 0.5,
            fbm(dir * WARP_FREQ, WARP_SEED ^ 0xA5A5) - 0.5,
            fbm(dir * WARP_FREQ, WARP_SEED ^ 0x5A5A) - 0.5,
        ) * WARP_AMP;
        // fbm ≈ [0,1]; centre to ≈[-0.5,0.5] so relief is signed.
        let n = fbm((dir + warp) * RELIEF_FREQ, RELIEF_SEED) - 0.5;
        // Baseline everywhere + more amplitude on high ground so flat
        // plains/ocean floor still get erodable micro-slope while
        // mountains get richer dendritic carving.
        let amp = RELIEF_BASE_AMP + RELIEF_ELEV_AMP * macro_elev.abs().min(1.0);
        let mut final_elev = macro_elev + n * amp;

        // (4) SIGN-PRESERVING CLAMP — class is NEVER violated; deep
        // ocean stays ≤ its floor sign; result is finite.
        if !final_elev.is_finite() {
            final_elev = if is_land { LAND_EPS } else { -OCEAN_EPS };
        }
        final_elev = if is_land {
            final_elev.max(LAND_EPS)
        } else {
            final_elev.min(-OCEAN_EPS)
        };

        hrow[rx as usize] = final_elev;
        prow[rx as usize] = if blended_precip.is_finite() {
            blended_precip.clamp(0.0, 2.0)
        } else {
            0.0
        };
    }
}

/// Serial reference rasteriser — the byte-equal oracle for
/// `parallel_rasterise_is_byte_identical_to_serial`. Identical
/// `fill_equirect_row` math as the production parallel path, plain row
/// loop, no rayon.
#[cfg(test)]
pub(crate) fn bake_inputs_equirect_serial(
    draft: &WizardDraft,
    w: u32,
    h: u32,
) -> EquirectInputs {
    let cells = painted_cells(draft);
    let precip_per_cell = painted_precip(draft, &cells);
    let grid = CellGrid::build(&cells);

    let n = (w as usize) * (h as usize);
    let mut height = vec![0.0f32; n];
    let mut precip = vec![0.0f32; n];

    for ry in 0..h {
        let lo = (ry as usize) * (w as usize);
        let hi = lo + (w as usize);
        fill_equirect_row(
            ry,
            w,
            h,
            &grid,
            &cells,
            &precip_per_cell,
            &mut height[lo..hi],
            &mut precip[lo..hi],
        );
    }

    EquirectInputs { w, h, height, precip, scale: WorldScale::planet_default() }
}

/// Brute-force reference nearest-cell scan — kept ONLY for the
/// `spatial_eq_bruteforce_*` equivalence tests. Identical math to the
/// pre-optimization rasterizer inner loop. NOTE: this is the OLD
/// nearest-cell semantic (one flat constant per cell). The production
/// `bake_inputs_equirect_impl` no longer matches it byte-for-byte — it now
/// IDW-blends + adds fractal relief. The equivalence the tests assert is
/// CLASSIFICATION equivalence: `sign(fast.height) == sign(slow.height)`
/// for every texel (the land/ocean mask is byte-identical to this
/// nearest-cell reference — a load-bearing invariant for the GPU sim's
/// `base.r < 0` ocean flag).
#[cfg(test)]
fn bake_inputs_equirect_bruteforce(draft: &WizardDraft, w: u32, h: u32) -> EquirectInputs {
    let cells = painted_cells(draft);
    let precip_per_cell = painted_precip(draft, &cells);

    let n = (w as usize) * (h as usize);
    let mut height = vec![0.0f32; n];
    let mut precip = vec![0.0f32; n];

    for ry in 0..h {
        let lat_deg = 90.0 - (ry as f32 + 0.5) / h as f32 * 180.0;
        let lat = lat_deg.to_radians();
        let (sin_lat, cos_lat) = lat.sin_cos();
        for rx in 0..w {
            let lon_deg = (rx as f32 + 0.5) / w as f32 * 360.0 - 180.0;
            let lon = lon_deg.to_radians();
            let (sin_lon, cos_lon) = lon.sin_cos();
            let dir = Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);

            let mut best_dot = f32::NEG_INFINITY;
            let mut best_elev = DEEP_OCEAN_FLOOR;
            let mut best_idx = 0usize;
            for (i, &(cpos, elev)) in cells.iter().enumerate() {
                let d = cpos.dot(dir);
                if d > best_dot {
                    best_dot = d;
                    best_elev = elev;
                    best_idx = i;
                }
            }

            let texel = (ry as usize) * (w as usize) + (rx as usize);
            height[texel] = best_elev;
            let p = precip_per_cell.get(best_idx).copied().unwrap_or(0.0);
            precip[texel] = if p.is_finite() { p.clamp(0.0, 2.0) } else { 0.0 };
        }
    }

    EquirectInputs { w, h, height, precip, scale: WorldScale::planet_default() }
}

/// Tauri entry point: rasterize the painted draft + climate precip to one
/// equirectangular grid. Mirrors the `Option`/owned-arg conventions of the
/// other wizard bake commands.
/// Async so the (now rayon-parallel but still CPU-heavy) rasterise runs on
/// a blocking worker via `spawn_blocking` instead of the Tauri main thread
/// — the webview UI stays responsive while it bakes (the JS side already
/// `await`s this invoke, so async is transparent to the frontend).
#[tauri::command]
pub async fn bake_inputs_equirect(draft: WizardDraft, w: u32, h: u32) -> EquirectInputs {
    tauri::async_runtime::spawn_blocking(move || bake_inputs_equirect_impl(&draft, w, h))
        .await
        .expect("bake_inputs_equirect rasterise task panicked")
}

#[cfg(test)]
mod test_support {
    use super::WizardDraft;
    use hayba_tectonics_v2::model::Model;

    /// A minimal draft with ONE painted elevated cap (the first ~600
    /// cells of the div=16 icosphere painted to land) plus the painter
    /// mask. Everything unpainted falls to the deep-ocean floor, so the
    /// rasterizer yields both land (`>0`) and ocean (`<0`).
    pub fn one_continent_draft() -> WizardDraft {
        let divisions: u32 = 16;
        // div=16 icosphere → 2562 cells. Paint a contiguous low-index cap.
        let n_cells: usize = 2562;
        let land = 600usize.min(n_cells);
        let mut painted_elevations = vec![0.0f32; n_cells];
        let mut painted_mask = vec![0u8; n_cells];
        for elev in painted_elevations.iter_mut().take(land) {
            *elev = 0.8;
        }
        for m in painted_mask.iter_mut().take(land) {
            *m = 1;
        }
        WizardDraft {
            divisions,
            seed: 7,
            preset: "plates2".into(),
            brush_radius_rad: 0.1,
            continental_cells: vec![],
            boundary_types: std::collections::HashMap::new(),
            run_length_steps: 0,
            dt_ma: 0.5,
            painted_elevations,
            painted_mask,
        }
    }

    /// A REPRESENTATIVE Earth-ish draft: SEVERAL painted continents at
    /// VARIED elevations spread over the globe, with everything else
    /// falling to the deep-ocean floor. Built so the equirect rasterizer
    /// + climate model see a realistic land/ocean partition (substantial
    /// land AND substantial ocean), not a single trivial dome — i.e. the
    /// kind of field the user's real Task-8 bake produces.
    ///
    /// Painting is keyed by each icosphere cell's GEOGRAPHIC position
    /// (lat/lon derived from `Model::new`'s grid — the SAME grid + Y-up
    /// sphere convention `bake_inputs_equirect_impl` uses), so the
    /// painted continents land at recognizable places on the equirect
    /// grid. Higher divisions (=32) give finer coastlines for the bake.
    pub fn earthish_draft() -> WizardDraft {
        let divisions: u32 = 32;
        let seed: u64 = 7;
        // Same geometry the rasterizer walks (no sim stepping).
        let model = Model::new(divisions, seed);
        let n_cells = model.grid.n_fields() as usize;

        let mut painted_elevations = vec![0.0f32; n_cells];
        let mut painted_mask = vec![0u8; n_cells];

        // (center_lon_deg, center_lat_deg, lon_radius_deg, lat_radius_deg,
        //  peak_elevation) — a deliberately varied set of "continents"
        // and a couple of island arcs at different elevations. Elevation
        // ramps from a coastal floor up to the peak toward the center, so
        // each landmass carries a realistic interior gradient (not a
        // flat plateau) for the hydraulic sim to incise.
        let continents: &[(f32, f32, f32, f32, f32)] = &[
            // Big mid-latitude northern continent (high interior — Eurasia-ish).
            (40.0, 45.0, 70.0, 32.0, 0.92),
            // Equatorial broad continent (lower, humid — Africa/S.America-ish).
            (-55.0, 5.0, 38.0, 45.0, 0.70),
            // Southern mid-latitude continent (moderate — Australia-ish).
            (135.0, -28.0, 30.0, 20.0, 0.55),
            // North-American-ish wedge (high relief).
            (-110.0, 42.0, 32.0, 26.0, 0.85),
            // A high, compact upland (Tibet/Antarctic-peninsula-ish).
            (95.0, -68.0, 26.0, 14.0, 0.97),
            // A low island arc (barely-land, tests the coast/ocean seam).
            (160.0, 18.0, 12.0, 9.0, 0.30),
        ];

        for fid in 0..n_cells as u32 {
            let p = model.grid.position(fid).normalize_or_zero();
            // Y-up sphere; mirror bake_inputs_equirect_impl's convention:
            //   lat = asin(y), lon = atan2(z, x).
            let lat = p.y.clamp(-1.0, 1.0).asin().to_degrees();
            let lon = p.z.atan2(p.x).to_degrees();

            let mut best_elev: f32 = 0.0;
            for &(clon, clat, rlon, rlat, peak) in continents {
                // Shortest signed longitude delta (wrap at ±180).
                let mut dlon = lon - clon;
                while dlon > 180.0 {
                    dlon -= 360.0;
                }
                while dlon < -180.0 {
                    dlon += 360.0;
                }
                let dlat = lat - clat;
                let d = ((dlon / rlon).powi(2) + (dlat / rlat).powi(2)).sqrt();
                if d < 1.0 {
                    // Cosine dome: coastal ~0.06 floor up to `peak` at center,
                    // plus a low-amplitude ripple so the interior is not a
                    // perfectly smooth bowl (gives the sim sub-features).
                    let dome = peak * (0.5 + 0.5 * (d * std::f32::consts::PI).cos());
                    let ripple = 0.05
                        * (lon * 0.13).sin()
                        * (lat * 0.17).cos();
                    let e = (dome + ripple).max(0.06).min(1.0);
                    if e > best_elev {
                        best_elev = e;
                    }
                }
            }

            if best_elev > 0.0 {
                painted_elevations[fid as usize] = best_elev;
                painted_mask[fid as usize] = 1;
            }
        }

        WizardDraft {
            divisions,
            seed,
            preset: "plates5".into(),
            brush_radius_rad: 0.1,
            continental_cells: vec![],
            boundary_types: std::collections::HashMap::new(),
            run_length_steps: 0,
            dt_ma: 0.5,
            painted_elevations,
            painted_mask,
        }
    }

    /// The TRUE representative input: mirrors the real app's "Load Earth"
    /// path (`earth-template.ts::earthElevationsFromImage` ->
    /// `HeightPainter.loadField` -> `toDraftFields`). That path paints
    /// EVERY cell (`painted_mask` all 1) with a CONTINUOUS elevation:
    ///   - land   in (0, 0.85]   (power-curved DEM grey above sea)
    ///   - ocean  in (-1, 0)     CONTINUOUS sea floor — shallow shelf is
    ///                           a tiny negative (≈ -0.02), deep abyss ≈ -1
    /// This is the crucial difference from `earthish_draft`/the synthetic
    /// dome, both of which only ever emit ocean as the `-1.0` DEEP_OCEAN
    /// sentinel (unpainted cells). The real DEM ocean is a smooth negative
    /// field, NOT a single sentinel — exactly the user's Task-8 input.
    ///
    /// Continents are placed by geographic lat/lon (same Y-up convention
    /// the rasterizer uses) with a cosine dome + ripple for interior
    /// relief; everything outside a continent gets a smooth negative
    /// bathymetry that deepens away from the coasts.
    pub fn earth_dem_like_draft() -> WizardDraft {
        let divisions: u32 = 32;
        let seed: u64 = 7;
        let model = Model::new(divisions, seed);
        let n_cells = model.grid.n_fields() as usize;

        let mut painted_elevations = vec![0.0f32; n_cells];
        // EVERY cell painted — exactly what HeightPainter.loadField does
        // (it `this.touched.fill(1)`), so `painted_cells` uses the
        // per-cell painted value for ALL cells (no DEEP_OCEAN sentinel).
        let painted_mask = vec![1u8; n_cells];

        let continents: &[(f32, f32, f32, f32, f32)] = &[
            (40.0, 45.0, 70.0, 32.0, 0.92),
            (-55.0, 5.0, 38.0, 45.0, 0.70),
            (135.0, -28.0, 30.0, 20.0, 0.55),
            (-110.0, 42.0, 32.0, 26.0, 0.85),
            (95.0, -68.0, 26.0, 14.0, 0.97),
            (160.0, 18.0, 12.0, 9.0, 0.30),
        ];

        for fid in 0..n_cells as u32 {
            let p = model.grid.position(fid).normalize_or_zero();
            let lat = p.y.clamp(-1.0, 1.0).asin().to_degrees();
            let lon = p.z.atan2(p.x).to_degrees();

            // Nearest-continent normalized distance (min over continents).
            let mut best_land: f32 = 0.0;
            let mut min_norm_d: f32 = f32::INFINITY;
            for &(clon, clat, rlon, rlat, peak) in continents {
                let mut dlon = lon - clon;
                while dlon > 180.0 {
                    dlon -= 360.0;
                }
                while dlon < -180.0 {
                    dlon += 360.0;
                }
                let dlat = lat - clat;
                let d = ((dlon / rlon).powi(2) + (dlat / rlat).powi(2)).sqrt();
                if d < min_norm_d {
                    min_norm_d = d;
                }
                if d < 1.0 {
                    let dome = peak * (0.5 + 0.5 * (d * std::f32::consts::PI).cos());
                    let ripple = 0.05 * (lon * 0.13).sin() * (lat * 0.17).cos();
                    let e = (dome + ripple).max(0.06).min(1.0);
                    if e > best_land {
                        best_land = e;
                    }
                }
            }

            let elev = if best_land > 0.0 {
                // Land: power-curved like the DEM path's LAND_EXP/GAIN.
                best_land
            } else {
                // Ocean: CONTINUOUS negative bathymetry. Just past the
                // coast (min_norm_d ~1) it's a tiny negative; far from any
                // continent it deepens toward -1. This is the smooth
                // sea-floor field the real DEM produces (NOT a -1 sentinel).
                let depth_t = ((min_norm_d - 1.0) * 0.6).clamp(0.0, 1.0);
                let bathy = -(0.02 + 0.98 * depth_t);
                bathy.clamp(-1.0, 1.0)
            };
            painted_elevations[fid as usize] = elev;
        }

        WizardDraft {
            divisions,
            seed,
            preset: "plates5".into(),
            brush_radius_rad: 0.1,
            continental_cells: vec![],
            boundary_types: std::collections::HashMap::new(),
            run_length_steps: 0,
            dt_ma: 0.5,
            painted_elevations,
            painted_mask,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equirect_inputs_have_land_and_ocean_and_finite_precip() {
        // A draft with at least one painted continent (use the same
        // test-draft helper the wizard tests use; if none, construct a
        // minimal WizardDraft with one painted high-elevation region).
        let draft = super::test_support::one_continent_draft();
        let out = bake_inputs_equirect_impl(&draft, 64, 32);
        assert_eq!(out.w, 64);
        assert_eq!(out.h, 32);
        assert_eq!(out.height.len(), 64 * 32);
        assert_eq!(out.precip.len(), 64 * 32);
        // Some land (>0) and some ocean (<0) must exist.
        assert!(out.height.iter().any(|&v| v > 0.0), "expected some land");
        assert!(out.height.iter().any(|&v| v < 0.0), "expected some ocean");
        // Precip finite and within a sane normalized band.
        assert!(out
            .precip
            .iter()
            .all(|&v| v.is_finite() && (0.0..=2.0).contains(&v)));
        // North-pole row (ry=0) exists and is finite.
        assert!(out.height[..64].iter().all(|v| v.is_finite()));
    }

    #[test]
    fn equirect_inputs_carry_world_scale() {
        // Reuse the same draft the `spatial_eq_bruteforce_small` test
        // constructs (no new fixture).
        let draft = super::test_support::earthish_draft();
        let out = bake_inputs_equirect_impl(&draft, 64, 32);
        // planet macro default until S3 overrides per-tile
        assert!(out.scale.terrain_scale > 1_000_000.0);
        assert!((out.scale.dx(64.0) - out.scale.terrain_scale / 64.0).abs() < 1e-1);
    }

    /// Sign class of an elevation: the load-bearing invariant the GPU sim
    /// derives its ocean flag from (`base.r < 0` ⇒ ocean). `>= 0.0` ⇒ land.
    #[inline]
    fn is_land(v: f32) -> bool {
        v >= 0.0
    }

    /// CLASSIFICATION EQUIVALENCE — the IDW+relief `bake_inputs_equirect_impl`
    /// no longer matches the nearest-cell brute force byte-for-byte (that
    /// semantic is intentionally GONE). What MUST still hold byte-for-byte
    /// is the land/ocean MASK: for every texel `sign(fast.height)` ==
    /// `sign(slow.height)` (nearest-cell classification). The GPU hydraulic
    /// sim flags ocean from `base.r < 0`, so a single flipped texel would
    /// move the coast / mis-flag a cell. Run on a representative
    /// multi-continent draft at a small grid so the reference is cheap.
    #[test]
    fn spatial_eq_bruteforce_small() {
        let draft = super::test_support::earthish_draft();
        // 96×48 — the size called out in the task spec.
        let fast = bake_inputs_equirect_impl(&draft, 96, 48);
        let slow = bake_inputs_equirect_bruteforce(&draft, 96, 48);
        assert_eq!(fast.w, slow.w);
        assert_eq!(fast.h, slow.h);
        assert_eq!(fast.height.len(), slow.height.len());
        // Land/ocean mask must be byte-identical to the nearest-cell
        // reference (the coast/ocean-flag invariant).
        for i in 0..fast.height.len() {
            assert_eq!(
                is_land(fast.height[i]),
                is_land(slow.height[i]),
                "class mismatch at texel {i} (ry={}, rx={}): fast={} slow={}",
                i / 96,
                i % 96,
                fast.height[i],
                slow.height[i]
            );
        }
        // Invariants still hold on the spatial result.
        assert!(fast.height.iter().any(|&v| v > 0.0), "expected some land");
        assert!(fast.height.iter().any(|&v| v < 0.0), "expected some ocean");
        assert!(fast
            .precip
            .iter()
            .all(|&v| v.is_finite() && (0.0..=2.0).contains(&v)));
    }

    /// Same classification-equivalence check on the `one_continent_draft`
    /// (a single low-index polar-ish cap) at an asymmetric small grid —
    /// guards the pole / lon-wrap handling specifically (the cap straddles
    /// a pole where lon bins converge and the search must widen / wrap).
    #[test]
    fn spatial_eq_bruteforce_one_continent() {
        let draft = super::test_support::one_continent_draft();
        let fast = bake_inputs_equirect_impl(&draft, 90, 45);
        let slow = bake_inputs_equirect_bruteforce(&draft, 90, 45);
        for i in 0..fast.height.len() {
            assert_eq!(
                is_land(fast.height[i]),
                is_land(slow.height[i]),
                "class mismatch at texel {i}: fast={} slow={}",
                fast.height[i],
                slow.height[i]
            );
        }
    }

    /// Classification equivalence on the TRUE DEM-like draft (every cell
    /// painted, smooth negative bathymetry) — the exact field shape the
    /// user's real Task-8 bake feeds the GPU. 128×64 keeps the reference
    /// affordable while covering a dense all-cells-painted partition.
    #[test]
    fn spatial_eq_bruteforce_dem_like() {
        let draft = super::test_support::earth_dem_like_draft();
        let fast = bake_inputs_equirect_impl(&draft, 128, 64);
        let slow = bake_inputs_equirect_bruteforce(&draft, 128, 64);
        for i in 0..fast.height.len() {
            assert_eq!(
                is_land(fast.height[i]),
                is_land(slow.height[i]),
                "class mismatch at texel {i} (ry={}, rx={}): fast={} slow={}",
                i / 128,
                i % 128,
                fast.height[i],
                slow.height[i]
            );
        }
    }

    /// CONTINUITY — the whole point of the rework. Old nearest-cell output
    /// was ~94% bit-identical between horizontally-adjacent land texels
    /// (each Goldberg cell = one flat constant → blocky hex plateau). After
    /// IDW blend + fractal relief the field must be CONTINUOUS: very few
    /// adjacent land pairs are bit-equal, AND no single-texel jump inside a
    /// land region is a hard cliff. Prints the measured bit-equal fraction.
    #[test]
    fn continuity_land_field_is_not_piecewise_constant() {
        let draft = super::test_support::earth_dem_like_draft();
        let w = 512usize;
        let h = 256usize;
        let out = bake_inputs_equirect_impl(&draft, w as u32, h as u32);

        let mut pairs = 0usize;
        let mut bit_equal = 0usize;
        let mut max_jump = 0.0f32;
        for ry in 0..h {
            for rx in 0..(w - 1) {
                let a = out.height[ry * w + rx];
                let b = out.height[ry * w + rx + 1];
                // Only consider adjacent pairs that are BOTH land (the old
                // failure mode was flat land hexes; coast steps are fine).
                if a > 0.0 && b > 0.0 {
                    pairs += 1;
                    if a.to_bits() == b.to_bits() {
                        bit_equal += 1;
                    }
                    let j = (a - b).abs();
                    if j > max_jump {
                        max_jump = j;
                    }
                }
            }
        }
        assert!(pairs > 1000, "need a substantial land sample, got {pairs}");
        let frac = bit_equal as f64 / pairs as f64;
        eprintln!(
            "[continuity] adjacent-land bit-equal fraction = {:.4} \
             ({bit_equal}/{pairs}) | max single-texel land jump = {max_jump:.5} \
             (old nearest-cell intent ≈ 0.94)",
            frac
        );
        assert!(
            frac < 0.20,
            "land field still piecewise-constant: {:.4} of adjacent land \
             pairs are bit-equal (expected < 0.20 after IDW+relief)",
            frac
        );
        // Continuity, not cliffs: the land elevation range is ~[0,1]; a
        // single-texel jump should stay well under a fraction of that.
        assert!(
            max_jump < 0.30,
            "hard cliff inside land region: max adjacent jump {max_jump:.4} \
             (expected continuous, < 0.30)"
        );
    }

    /// PARALLELISM SAFETY — the production `bake_inputs_equirect_impl` is
    /// rayon-parallelised across the outer latitude-row loop. The per-texel
    /// function is pure (reads `&CellGrid`/`&cells` immutably, fixed seed,
    /// no RNG) and each row writes a DISJOINT output slice, so the parallel
    /// output MUST be BYTE-IDENTICAL to a serial reference regardless of
    /// thread scheduling. `bake_inputs_equirect_serial` is the kept
    /// `#[cfg(test)]` serial oracle (the exact same math, plain row loop).
    #[test]
    fn parallel_rasterise_is_byte_identical_to_serial() {
        let d = test_support::earthish_draft();
        let par = bake_inputs_equirect_impl(&d, 256, 128);
        let ser = bake_inputs_equirect_serial(&d, 256, 128);
        assert_eq!(par.w, ser.w);
        assert_eq!(par.h, ser.h);
        assert_eq!(par.height.len(), ser.height.len());
        assert_eq!(par.precip.len(), ser.precip.len());
        for i in 0..par.height.len() {
            assert_eq!(
                par.height[i].to_bits(),
                ser.height[i].to_bits(),
                "height differs at texel {i} (ry={}, rx={}): par={} ser={}",
                i / 256,
                i % 256,
                par.height[i],
                ser.height[i]
            );
            assert_eq!(
                par.precip[i].to_bits(),
                ser.precip[i].to_bits(),
                "precip differs at texel {i} (ry={}, rx={}): par={} ser={}",
                i / 256,
                i % 256,
                par.precip[i],
                ser.precip[i]
            );
        }
        // Sanity: a representative draft yields both classes.
        assert_eq!(par.height, ser.height);
        assert_eq!(par.precip, ser.precip);
    }

    /// DETERMINISM — fixed seed, no RNG, single-threaded loop ⇒ two calls
    /// with identical args must be byte-identical in BOTH channels.
    #[test]
    fn determinism_byte_identical_repeat() {
        let draft = super::test_support::earth_dem_like_draft();
        let a = bake_inputs_equirect_impl(&draft, 200, 100);
        let b = bake_inputs_equirect_impl(&draft, 200, 100);
        assert_eq!(a.height.len(), b.height.len());
        for i in 0..a.height.len() {
            assert_eq!(
                a.height[i].to_bits(),
                b.height[i].to_bits(),
                "height nondeterministic at texel {i}"
            );
            assert_eq!(
                a.precip[i].to_bits(),
                b.precip[i].to_bits(),
                "precip nondeterministic at texel {i}"
            );
        }
    }

    /// OCEAN/COAST INVARIANT — blend + relief must NEVER flip a texel
    /// across the 0 boundary set by nearest-cell classification. Every
    /// texel the nearest-cell reference calls ocean (sign < 0) is `< 0`
    /// here, every land texel is `> 0`; the mask is byte-identical and
    /// strictly non-zero (no exactly-0.0 texels that `base.r < 0` would
    /// ambiguously class). Also a finite / precip-range check.
    #[test]
    fn ocean_coast_sign_invariant_and_finite() {
        let draft = super::test_support::earth_dem_like_draft();
        let w = 256u32;
        let h = 128u32;
        let fast = bake_inputs_equirect_impl(&draft, w, h);
        let slow = bake_inputs_equirect_bruteforce(&draft, w, h);
        for i in 0..fast.height.len() {
            let v = fast.height[i];
            assert!(v.is_finite(), "non-finite height at texel {i}: {v}");
            assert_ne!(v, 0.0, "exactly-0.0 height at texel {i} (ambiguous class)");
            if slow.height[i] >= 0.0 {
                assert!(
                    v > 0.0,
                    "land texel {i} went non-positive: {v} (nearest={})",
                    slow.height[i]
                );
            } else {
                assert!(
                    v < 0.0,
                    "ocean texel {i} went non-negative: {v} (nearest={}) — \
                     would mis-flag as land",
                    slow.height[i]
                );
            }
        }
        assert!(
            fast.precip.iter().all(|&p| p.is_finite() && (0.0..=2.0).contains(&p)),
            "precip must be finite and within [0,2]"
        );
        assert!(fast.height.iter().any(|&v| v > 0.0), "expected some land");
        assert!(fast.height.iter().any(|&v| v < 0.0), "expected some ocean");
    }

    /// Rasterizer wall-time at the production 1024×512 grid. The IDW
    /// k-nearest blend + 4-octave fractal relief is heavier per texel than
    /// the old single nearest-cell pick, so the budget is set generously
    /// vs the ~77s brute force this replaced. Prints the measured time so
    /// the freeze-gone claim is backed by a real number; the assertion is
    /// a non-flaky ceiling, not a tight target.
    #[test]
    fn rasterizer_walltime_1024x512() {
        use std::time::Instant;
        let draft = super::test_support::earth_dem_like_draft();
        // Warm (build cells/climate once is part of the bake; time the
        // whole `bake_inputs_equirect_impl` exactly as the Tauri command
        // calls it).
        let t0 = Instant::now();
        let out = bake_inputs_equirect_impl(&draft, 1024, 512);
        let dt = t0.elapsed();
        assert_eq!(out.height.len(), 1024 * 512);
        eprintln!(
            "[walltime] bake_inputs_equirect_impl @ 1024x512 = {:.3} s \
             ({} ms) [build=release? check cargo profile]",
            dt.as_secs_f64(),
            dt.as_millis()
        );
        // Generous ceiling vs the ~77s brute force; the spatial index
        // should land far under this even in a debug build.
        assert!(
            dt.as_secs_f64() < 30.0,
            "rasterizer @1024x512 took {:.3}s — spatial index regressed",
            dt.as_secs_f64()
        );
    }

    /// FREEZE-FIX WALLTIME — the production debug-bake resolution. Times
    /// the rayon-parallel `bake_inputs_equirect_impl` AND the serial oracle
    /// at 2048×1024 and prints both + the speedup so the "no longer pegs
    /// one core for tens of seconds" claim is backed by a real number.
    /// Assertion is a non-flaky ceiling (passes even in a slow debug build
    /// on a modest core count); run with `cargo test --release -- --nocapture`
    /// to see the real ~sub-second production figure.
    #[test]
    fn rasterizer_walltime_2048x1024_parallel_vs_serial() {
        use std::time::Instant;
        let draft = super::test_support::earth_dem_like_draft();

        let t0 = Instant::now();
        let par = bake_inputs_equirect_impl(&draft, 2048, 1024);
        let par_dt = t0.elapsed();

        let t1 = Instant::now();
        let ser = bake_inputs_equirect_serial(&draft, 2048, 1024);
        let ser_dt = t1.elapsed();

        assert_eq!(par.height.len(), 2048 * 1024);
        assert_eq!(par.height, ser.height);
        assert_eq!(par.precip, ser.precip);
        eprintln!(
            "[walltime] bake_inputs_equirect @ 2048x1024  parallel = {:.3}s \
             ({} ms)  |  serial = {:.3}s ({} ms)  |  speedup = {:.2}x",
            par_dt.as_secs_f64(),
            par_dt.as_millis(),
            ser_dt.as_secs_f64(),
            ser_dt.as_millis(),
            ser_dt.as_secs_f64() / par_dt.as_secs_f64().max(1e-6),
        );
        // Non-flaky ceiling: even a slow debug build on a low core count
        // must beat this; release lands well under a second (reported via
        // --nocapture). The freeze was tens of seconds single-threaded.
        assert!(
            par_dt.as_secs_f64() < 20.0,
            "parallel rasterizer @2048x1024 took {:.3}s — regressed",
            par_dt.as_secs_f64()
        );
    }

    /// DEV / END-TO-END VERIFICATION FIXTURE — not a unit assertion of
    /// the math, but the bridge that closes the Rust→GPU-sim seam: it
    /// runs the REAL `bake_inputs_equirect_impl` (real icosphere
    /// rasterizer + real `compute_climate`) on a representative
    /// multi-continent draft at the production 256×128 grid, then
    /// serializes the result EXACTLY as serde/Tauri would
    /// (`serde_json::to_string` of `EquirectInputs{w,h,height,precip}`)
    /// to disk. The headless WebGL harness
    /// (`__headless_harness__.ts`) fetches this byte-for-byte JSON and
    /// feeds it to the real `runHydraulicBake` — only the literal Tauri
    /// IPC wire (generic transport, field names already spec-verified)
    /// is skipped. Sanity asserts guard a *useful* fixture (substantial
    /// land AND ocean, finite precip) so a degenerate file never silently
    /// passes downstream.
    ///
    /// Output paths (BOTH written so the harness can `fetch` it over
    /// Vite without a copy step, and the spec'd src-tauri/target path
    /// exists too):
    ///   - `<src-tauri>/target/erosion_real_inputs.json`
    ///   - `<repo>/apps/hayba-explorer/public/erosion_real_inputs.json`
    #[test]
    fn write_real_equirect_inputs_fixture() {
        use std::path::PathBuf;

        // Use the TRUE representative draft — the real "Load Earth" DEM
        // path paints EVERY cell with a CONTINUOUS elevation (ocean is a
        // smooth negative bathymetry field, NOT the -1.0 sentinel that
        // `earthish_draft` / the synthetic dome emit). This is what the
        // user's Task-8 bake actually feeds the GPU.
        let draft = super::test_support::earth_dem_like_draft();
        // Default 256x128 (fast harness loop); override to the real app
        // config (1024x512) via EROSION_FIXTURE_WH=1024x512 to reproduce
        // the user's exact Task-8 run on the real GPU.
        let (w, h) = match std::env::var("EROSION_FIXTURE_WH") {
            Ok(s) => {
                let mut it = s.split('x');
                let pw = it.next().and_then(|v| v.parse::<u32>().ok());
                let ph = it.next().and_then(|v| v.parse::<u32>().ok());
                match (pw, ph) {
                    (Some(a), Some(b)) if a > 0 && b > 0 => (a, b),
                    _ => (256u32, 128u32),
                }
            }
            Err(_) => (256u32, 128u32),
        };
        let out = bake_inputs_equirect_impl(&draft, w, h);

        // Guard: the fixture must be representative, not degenerate.
        assert_eq!(out.w, w);
        assert_eq!(out.h, h);
        assert_eq!(out.height.len() as u32, w * h);
        assert_eq!(out.precip.len() as u32, w * h);
        let n_land = out.height.iter().filter(|&&v| v > 0.0).count();
        let n_ocean = out.height.iter().filter(|&&v| v < 0.0).count();
        let total = (w * h) as usize;

        // ── HYPOTHESIS PROBE: the ocean/land value distribution the REAL
        //    rasterizer produces. The SEED predicate is `b < 0.0 -> ocean`.
        //    Print exactly where ocean sits relative to 0 and whether ANY
        //    ocean texel is >= 0 (which SEED would mis-flag as land).
        let mut min_all = f32::INFINITY;
        let mut max_all = f32::NEG_INFINITY;
        let mut min_land = f32::INFINITY;
        let mut max_ocean = f32::NEG_INFINITY; // closest-to-zero ocean
        let mut min_ocean = f32::INFINITY; // deepest ocean
        let mut n_zero = 0usize;
        let mut n_ocean_ge0 = 0usize; // ocean-by-bathymetry but value >= 0
        let mut n_shallow_ocean = 0usize; // ocean in (-0.02, 0): near-zero
        for &v in &out.height {
            if v < min_all {
                min_all = v;
            }
            if v > max_all {
                max_all = v;
            }
            if v > 0.0 {
                if v < min_land {
                    min_land = v;
                }
            } else if v < 0.0 {
                if v > max_ocean {
                    max_ocean = v;
                }
                if v < min_ocean {
                    min_ocean = v;
                }
                if v > -0.02 {
                    n_shallow_ocean += 1;
                }
            } else {
                n_zero += 1;
                n_ocean_ge0 += 1;
            }
        }
        eprintln!(
            "[hypothesis] REAL rasterizer height stats @ {w}x{h}:\n  \
             all: min={min_all:.6} max={max_all:.6}\n  \
             land(>0): n={n_land} min={min_land:.6} max={max_all:.6}\n  \
             ocean(<0): n={n_ocean} closest-to-0={max_ocean:.6} deepest={min_ocean:.6}\n  \
             EXACTLY-zero texels (==0): {n_zero}\n  \
             ocean-but-value>=0 (SEED would MIS-flag as LAND): {n_ocean_ge0}\n  \
             very-shallow ocean in (-0.02,0): {n_shallow_ocean}\n  \
             => SEED `b<0.0`: ALL {n_ocean} ocean texels {} flagged as ocean",
            if n_ocean_ge0 == 0 {
                "CORRECTLY"
            } else {
                "NOT ALL"
            }
        );
        // Substantial land AND ocean — Earth-ish, not a trivial dome.
        assert!(
            n_land as f32 / total as f32 > 0.12,
            "expected substantial land, got {n_land}/{total}"
        );
        assert!(
            n_ocean as f32 / total as f32 > 0.30,
            "expected substantial ocean, got {n_ocean}/{total}"
        );
        // Varied land elevations (not a single flat value).
        let land_max = out.height.iter().cloned().fold(f32::MIN, f32::max);
        assert!(land_max > 0.5, "expected high terrain, got max {land_max}");
        assert!(
            out.precip.iter().all(|&v| v.is_finite() && (0.0..=2.0).contains(&v)),
            "precip must be finite and in [0,2]"
        );

        // EXACT serde/Tauri serialization shape (struct field order:
        // w,h,height,precip — same `#[derive(serde::Serialize)]` the
        // `bake_inputs_equirect` Tauri command emits).
        let json = serde_json::to_string(&out).expect("serialize EquirectInputs");

        // CARGO_MANIFEST_DIR == .../apps/hayba-explorer/src-tauri
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

        let target_path = manifest.join("target").join("erosion_real_inputs.json");
        if let Some(dir) = target_path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        std::fs::write(&target_path, &json).expect("write src-tauri/target fixture");

        // Vite serves apps/hayba-explorer/public/* at the web root.
        let public_path = manifest
            .join("..")
            .join("public")
            .join("erosion_real_inputs.json");
        if let Some(dir) = public_path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        std::fs::write(&public_path, &json).expect("write public fixture");

        eprintln!(
            "[fixture] wrote {} bytes — land={n_land} ocean={n_ocean} \
             land_max={land_max:.3} -> {} | {}",
            json.len(),
            target_path.display(),
            public_path.display()
        );
    }
}
