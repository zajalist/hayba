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

/// Rasterize the painted draft + climate precipitation onto one
/// equirectangular `w × h` grid. For each texel, the FIXED convention
/// (row 0 = North pole) gives `(lat, lon)`; that maps to a unit-sphere
/// direction; the nearest painted Goldberg cell (max dot product) supplies
/// `height` (its elevation) and `precip` (its climate precipitation,
/// clamped to `[0, 2]`). O(cells) per texel — runs once per bake.
pub fn bake_inputs_equirect_impl(draft: &WizardDraft, w: u32, h: u32) -> EquirectInputs {
    let cells = painted_cells(draft);
    let precip_per_cell = painted_precip(draft, &cells);

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

            // Nearest painted cell by max dot product (both unit vectors).
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
}
