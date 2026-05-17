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

use hayba_tectonics_v2::field::Crust;
use hayba_tectonics_v2::model::Model;

use crate::climate::{compute_climate, ClimateParams};
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
        if let Some(f) = model.fields.get_mut(fid) {
            if cont {
                f.crust = Crust::new_continental();
                f.elevation = elevation.max(0.0);
                f.become_continental_lithosphere(200.0);
            } else {
                f.crust = Crust::new_oceanic();
                f.elevation = elevation.min(-0.0001);
                f.refresh_oceanic_lithosphere();
            }
        }
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
}

/// Rasterize the painted draft + climate precipitation onto one
/// equirectangular `w × h` grid. For each texel, the FIXED convention
/// (row 0 = North pole) gives `(lat, lon)`; that maps to a unit-sphere
/// direction; the nearest painted Goldberg cell (max dot product) supplies
/// `height` (its elevation) and `precip` (its climate precipitation,
/// clamped to `[0, 2]`).
///
/// The nearest-cell lookup is accelerated by a `CellGrid` directional
/// bucket index (≈O(1) per texel) instead of the original O(cells) scan;
/// the SELECTED cell is provably identical to the brute-force result
/// (see `spatial_eq_bruteforce_*` tests) — only the search is pruned, the
/// elevation/precip/ocean-sign semantics are unchanged.
pub fn bake_inputs_equirect_impl(draft: &WizardDraft, w: u32, h: u32) -> EquirectInputs {
    let cells = painted_cells(draft);
    let precip_per_cell = painted_precip(draft, &cells);
    let grid = CellGrid::build(&cells);

    let n = (w as usize) * (h as usize);
    let mut height = vec![0.0f32; n];
    let mut precip = vec![0.0f32; n];

    for ry in 0..h {
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

            // Nearest painted cell by max dot product (spatial-pruned but
            // result-identical to the brute-force scan).
            let (best_idx, _) = grid.nearest(dir, lat);
            let best_elev = cells.get(best_idx).map(|&(_, e)| e).unwrap_or(DEEP_OCEAN_FLOOR);

            let texel = (ry as usize) * (w as usize) + (rx as usize);
            height[texel] = best_elev;
            let p = precip_per_cell.get(best_idx).copied().unwrap_or(0.0);
            precip[texel] = if p.is_finite() { p.clamp(0.0, 2.0) } else { 0.0 };
        }
    }

    EquirectInputs { w, h, height, precip }
}

/// Brute-force reference nearest-cell scan — kept ONLY for the
/// `spatial_eq_bruteforce_*` equivalence tests. Identical math to the
/// pre-optimization rasterizer inner loop.
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

    EquirectInputs { w, h, height, precip }
}

/// Tauri entry point: rasterize the painted draft + climate precip to one
/// equirectangular grid. Mirrors the `Option`/owned-arg conventions of the
/// other wizard bake commands.
#[tauri::command]
pub fn bake_inputs_equirect(draft: WizardDraft, w: u32, h: u32) -> EquirectInputs {
    bake_inputs_equirect_impl(&draft, w, h)
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

    /// SPATIAL-INDEX EQUIVALENCE — the `CellGrid`-pruned nearest-cell
    /// search must return a BYTE-IDENTICAL `EquirectInputs` to the
    /// brute-force O(cells×texels) reference for EVERY texel. Run on a
    /// representative multi-continent draft at a small grid so the
    /// brute-force reference is cheap; if a single texel differs the
    /// pruning is unsound. Also re-asserts the land>0 / ocean<0 /
    /// finite-precip invariants on the spatial result.
    #[test]
    fn spatial_eq_bruteforce_small() {
        let draft = super::test_support::earthish_draft();
        // 96×48 — the size called out in the task spec.
        let fast = bake_inputs_equirect_impl(&draft, 96, 48);
        let slow = bake_inputs_equirect_bruteforce(&draft, 96, 48);
        assert_eq!(fast.w, slow.w);
        assert_eq!(fast.h, slow.h);
        assert_eq!(fast.height.len(), slow.height.len());
        // Byte-identical nearest-cell result (exact f32 equality — the
        // chosen cell, hence its elevation/precip, must be the same).
        for i in 0..fast.height.len() {
            assert_eq!(
                fast.height[i], slow.height[i],
                "height mismatch at texel {i} (ry={}, rx={})",
                i / 96,
                i % 96
            );
            assert_eq!(
                fast.precip[i], slow.precip[i],
                "precip mismatch at texel {i}"
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

    /// Same equivalence check on the `one_continent_draft` (a single
    /// low-index polar-ish cap) at an asymmetric small grid — guards the
    /// pole / lon-wrap handling specifically (the cap straddles a pole
    /// where lon bins converge and the search must widen / full-wrap).
    #[test]
    fn spatial_eq_bruteforce_one_continent() {
        let draft = super::test_support::one_continent_draft();
        let fast = bake_inputs_equirect_impl(&draft, 90, 45);
        let slow = bake_inputs_equirect_bruteforce(&draft, 90, 45);
        for i in 0..fast.height.len() {
            assert_eq!(
                fast.height[i], slow.height[i],
                "height mismatch at texel {i}"
            );
            assert_eq!(fast.precip[i], slow.precip[i]);
        }
    }

    /// Equivalence on the TRUE DEM-like draft (every cell painted, smooth
    /// negative bathymetry) — the exact field shape the user's real
    /// Task-8 bake feeds the GPU. 128×64 keeps the brute-force reference
    /// affordable while covering a dense all-cells-painted partition.
    #[test]
    fn spatial_eq_bruteforce_dem_like() {
        let draft = super::test_support::earth_dem_like_draft();
        let fast = bake_inputs_equirect_impl(&draft, 128, 64);
        let slow = bake_inputs_equirect_bruteforce(&draft, 128, 64);
        for i in 0..fast.height.len() {
            assert_eq!(
                fast.height[i], slow.height[i],
                "height mismatch at texel {i} (ry={}, rx={})",
                i / 128,
                i % 128
            );
            assert_eq!(fast.precip[i], slow.precip[i]);
        }
    }

    /// Rasterizer wall-time at the production 1024×512 grid (the size
    /// that froze the UI for ~5 min — the brute force was ~77s here).
    /// With the spatial index this must complete in well under ~2s.
    /// Prints the measured time so the freeze-gone claim is backed by a
    /// real number from `cargo test --release`.
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
