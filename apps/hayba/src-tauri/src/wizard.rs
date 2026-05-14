//! v0.2 wizard — TE-faithful port of plate partitioning + continent paint.
//!
//! Mechanics ported from TE's `generatePlates.ts` (`tectonic-explorer/.../
//! plates-model/generate-plates.ts`):
//!
//!   1. The user picks a plate count (2/3/4/5/5-Uneven). Each choice maps
//!      to a pre-baked equirectangular PNG that encodes plate identity via
//!      HSV hue (rounded to the nearest 10°) and base elevation via HSV
//!      value. These are TE's actual preset rasters, copied verbatim.
//!   2. Each cell on the icosphere is sampled by projecting its 3D position
//!      to (latitude, longitude) → equirectangular pixel → HSV → plate.
//!      Single-pixel sampling rather than TE's polygon-weighted version;
//!      visually indistinguishable for plate regions.
//!   3. The user paints continental crust over the resulting partition.
//!      Painted cells override the preset's elevation and get a continental
//!      crust column; un-painted cells keep whatever the preset gave them.

use glam::Vec3;
use serde::{Deserialize, Serialize};

use hayba_tectonics_v2::determinism::split_mix_64;
use hayba_tectonics_v2::field::Crust;
use hayba_tectonics_v2::model::{Model, MAX_PLATE_SPEED};
use hayba_tectonics_v2::sphere::Grid;

use crate::planet::PlanetSnapshot;

#[derive(Debug, Deserialize)]
pub struct WizardDraft {
    pub divisions: u32,
    pub seed: u64,
    /// One of "plates2" / "plates3" / "plates4" / "plates5" / "plates5Uneven".
    pub preset: String,
    pub brush_radius_rad: f32,
    pub continental_cells: Vec<u32>,
    pub run_length_steps: u32,
    pub dt_ma: f32,
}

#[derive(Debug, Serialize)]
pub struct WizardInit {
    pub divisions: u32,
    pub n_cells: u32,
    pub cell_positions: Vec<f32>,
}

#[tauri::command]
pub fn start_wizard(divisions: u32) -> WizardInit {
    let grid = Grid::new(divisions);
    let n = grid.n_fields();
    let mut cell_positions = Vec::with_capacity((n * 3) as usize);
    for fid in 0..n {
        let p = grid.position(fid);
        cell_positions.push(p.x);
        cell_positions.push(p.y);
        cell_positions.push(p.z);
    }
    WizardInit { divisions, n_cells: n, cell_positions }
}

#[tauri::command]
pub fn roll_seed() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut state = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xDEAD_BEEF_CAFE_F00D);
    split_mix_64(&mut state);
    split_mix_64(&mut state)
}

#[tauri::command]
pub fn bake_from_wizard(draft: WizardDraft) -> PlanetSnapshot {
    bake_impl(&draft)
}

// ── Preset rasters, embedded at compile time ─────────────────────────────
const PRESET_PLATES2:        &[u8] = include_bytes!("../presets/plates2.png");
const PRESET_PLATES3:        &[u8] = include_bytes!("../presets/plates3.png");
const PRESET_PLATES4:        &[u8] = include_bytes!("../presets/plates4.png");
const PRESET_PLATES5:        &[u8] = include_bytes!("../presets/plates5.png");
const PRESET_PLATES5_UNEVEN: &[u8] = include_bytes!("../presets/plates5Uneven.png");

fn preset_bytes(name: &str) -> &'static [u8] {
    match name {
        "plates2"        => PRESET_PLATES2,
        "plates3"        => PRESET_PLATES3,
        "plates4"        => PRESET_PLATES4,
        "plates5Uneven"  => PRESET_PLATES5_UNEVEN,
        _                => PRESET_PLATES5, // default fallback
    }
}

// ── HSV math, ported from d3-hsv via TE's generatePlates ─────────────────
// HSV value scale matches TE: BASE_OCEAN_HSV_V=0.4 maps to "ocean floor"
// elevation, value=1.0 maps to mountain peaks. We pass raw value through to
// the elevation field, which the sim treats as already-normalised units.
const BASE_OCEAN_HSV_V: f32 = 0.4;

fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let rf = r as f32 / 255.0;
    let gf = g as f32 / 255.0;
    let bf = b as f32 / 255.0;
    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let v = max;
    let d = max - min;
    let s = if max == 0.0 { 0.0 } else { d / max };
    let mut h = if d == 0.0 {
        0.0
    } else if max == rf {
        ((gf - bf) / d) % 6.0
    } else if max == gf {
        (bf - rf) / d + 2.0
    } else {
        (rf - gf) / d + 4.0
    };
    h *= 60.0;
    if h < 0.0 { h += 360.0; }
    (h, s, v)
}

/// Convert HSV value into TE's normalised sim-elevation. Matches
/// `generate-plates.ts:getElevation` exactly.
fn hsv_value_to_elevation(value: f32) -> f32 {
    // TE: ((v - 0.4) / 0.6) * (HIGHEST_MOUNTAIN_ELEVATION - BASE_OCEAN_ELEVATION) + BASE_OCEAN_ELEVATION
    // Our sim uses normalised units where +1 ≈ mountain peak, -0.3 ≈ ocean floor.
    // Map [0.4, 1.0] → [-0.3, 1.0].
    let t = ((value - BASE_OCEAN_HSV_V) / (1.0 - BASE_OCEAN_HSV_V)).clamp(0.0, 1.0);
    -0.3 + t * 1.3
}

fn is_continental(elevation: f32) -> bool {
    // Matches TE: > BASE_OCEAN_ELEVATION + HIGHEST_MOUNTAIN_ELEVATION * 0.05
    // In our normalised range: > -0.3 + 1.0 * 0.05 = -0.25. But we want a
    // stricter threshold so only meaningfully elevated cells become land.
    elevation > 0.0
}

// ── Project unit-sphere position → equirectangular pixel ─────────────────
// Convention matches the rest of this app: Y-up, North pole at (0, 1, 0).
fn sample_preset(image: &image::RgbaImage, pos: Vec3) -> (u8, u8, u8) {
    let w = image.width() as f32;
    let h = image.height() as f32;
    // phi = latitude (-π/2 at south pole .. π/2 at north pole)
    // lambda = longitude (-π .. π)
    let phi = pos.y.clamp(-1.0, 1.0).asin();
    let lambda = pos.z.atan2(pos.x);
    let u = (lambda + std::f32::consts::PI) / (2.0 * std::f32::consts::PI);
    let v = 1.0 - (phi + std::f32::consts::FRAC_PI_2) / std::f32::consts::PI;
    let x = ((u * w) as i32).clamp(0, image.width() as i32 - 1) as u32;
    let y = ((v * h) as i32).clamp(0, image.height() as i32 - 1) as u32;
    let px = image.get_pixel(x, y);
    (px[0], px[1], px[2])
}

// ── Palette for plate-id rendering (used by the renderer; sim doesn't care)
const PALETTE: &[[u8; 3]] = &[
    [181, 106,  29],
    [138,  74, 138],
    [ 90,  58, 138],
    [ 58, 122,  90],
    [168, 132,  58],
    [168,  58,  58],
    [ 58, 138, 138],
    [106, 159, 220],
];

fn omega_for_plate(plate_id: u32, seed: u64) -> Vec3 {
    let mut state = seed ^ ((plate_id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let r1 = (split_mix_64(&mut state) as f64 / u64::MAX as f64) * 2.0 - 1.0;
    let r2 = (split_mix_64(&mut state) as f64 / u64::MAX as f64) * 2.0 - 1.0;
    let r3 = (split_mix_64(&mut state) as f64 / u64::MAX as f64) * 2.0 - 1.0;
    Vec3::new(r1 as f32, r2 as f32, r3 as f32).normalize_or_zero() * 0.01
}

fn bake_impl(draft: &WizardDraft) -> PlanetSnapshot {
    let preset = image::load_from_memory(preset_bytes(&draft.preset))
        .expect("preset PNG should decode")
        .to_rgba8();

    let mut model = Model::new(draft.divisions, draft.seed);
    let n_cells = model.grid.n_fields();

    // Continental override mask from the user's brush.
    let mut user_continental = vec![false; n_cells as usize];
    for &fid in &draft.continental_cells {
        if fid < n_cells {
            user_continental[fid as usize] = true;
        }
    }

    // ── Step 1: bucket cells by HSV-hue (rounded to nearest 10°), TE-style.
    // Each bucket becomes a plate. Also retain per-cell elevation from HSV.
    struct CellInfo {
        hue_bucket: u32,
        preset_elevation: f32,
    }
    let mut infos: Vec<CellInfo> = Vec::with_capacity(n_cells as usize);
    let mut hue_to_plate: std::collections::BTreeMap<u32, u32> = std::collections::BTreeMap::new();
    let mut plate_id_counter: u32 = 1;
    for fid in 0..n_cells {
        let pos = model.grid.position(fid);
        let (r, g, b) = sample_preset(&preset, pos);
        let (h, _s, v) = rgb_to_hsv(r, g, b);
        let hue_bucket = ((h / 10.0).round() as u32) * 10;
        infos.push(CellInfo { hue_bucket, preset_elevation: hsv_value_to_elevation(v) });
        hue_to_plate.entry(hue_bucket).or_insert_with(|| {
            let pid = plate_id_counter;
            plate_id_counter += 1;
            pid
        });
    }

    // ── Step 2: build per-plate cell buckets in plate-id order.
    let plate_count = hue_to_plate.len() as u32;
    let mut buckets: Vec<Vec<u32>> = (0..plate_count).map(|_| Vec::new()).collect();
    let mut plate_continental: Vec<bool> = vec![false; plate_count as usize];
    for fid in 0..n_cells {
        let pid = hue_to_plate[&infos[fid as usize].hue_bucket];
        buckets[(pid - 1) as usize].push(fid);
        // User's brush wins; otherwise fall back to the preset's elevation.
        let cont = if user_continental[fid as usize] {
            true
        } else {
            is_continental(infos[fid as usize].preset_elevation)
        };
        if cont {
            plate_continental[(pid - 1) as usize] = true;
        }
    }

    // ── Step 3: register plates with the model.
    for (i, cells) in buckets.iter().enumerate() {
        let pid = (i + 1) as u32;
        let color_arr = PALETTE[i % PALETTE.len()];
        let packed = ((color_arr[0] as u32) << 16) | ((color_arr[1] as u32) << 8) | (color_arr[2] as u32);
        let density = if plate_continental[i] { 0.35 } else { 1.05 };
        let mut omega = omega_for_plate(pid, draft.seed);
        let len = omega.length();
        if len > MAX_PLATE_SPEED {
            omega *= MAX_PLATE_SPEED / len;
        }
        model.add_plate(pid, packed, density, cells, plate_continental[i], omega);
    }

    // ── Step 4: per-cell crust override. User brush + preset elevation
    // both feed in; brush wins where they conflict.
    for fid in 0..n_cells {
        let info = &infos[fid as usize];
        let painted = user_continental[fid as usize];
        let cont = painted || is_continental(info.preset_elevation);
        if let Some(f) = model.fields.get_mut(fid as usize) {
            if cont {
                f.crust = Crust::new_continental();
                f.elevation = if painted { 0.5 } else { info.preset_elevation.max(0.05) };
                f.become_continental_lithosphere(200.0);
            } else {
                f.crust = Crust::new_oceanic();
                f.elevation = info.preset_elevation.min(-0.1);
                f.refresh_oceanic_lithosphere();
            }
        }
    }

    let area = model.grid.field_area_km2();
    let fields_ref = model.fields.clone();
    for p in model.plates.iter_mut() {
        p.update_inertia_tensor(&fields_ref, area);
    }

    for _ in 0..draft.run_length_steps {
        model.step(draft.dt_ma);
    }

    let mut cell_positions = Vec::with_capacity((n_cells * 3) as usize);
    let mut cell_plate_ids = Vec::with_capacity(n_cells as usize);
    let mut cell_elevation = Vec::with_capacity(n_cells as usize);
    let mut cell_continental = Vec::with_capacity(n_cells as usize);
    for fid in 0..n_cells {
        let p = model.grid.position(fid);
        cell_positions.push(p.x);
        cell_positions.push(p.y);
        cell_positions.push(p.z);
        let f = &model.fields[fid as usize];
        cell_plate_ids.push(match f.plate_id { Some(pid) => pid as i32, None => -1 });
        cell_elevation.push(f.elevation);
        cell_continental.push(if f.is_continent_crust() { 1 } else { 0 });
    }

    PlanetSnapshot {
        divisions: draft.divisions,
        n_cells,
        sim_time_ma: model.sim_time_ma,
        cell_positions,
        cell_plate_ids,
        cell_elevation,
        cell_continental,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft_for(preset: &str) -> WizardDraft {
        WizardDraft {
            divisions: 32,
            seed: 7,
            preset: preset.into(),
            brush_radius_rad: 0.1,
            continental_cells: vec![],
            run_length_steps: 1,
            dt_ma: 0.5,
        }
    }

    #[test]
    fn plates2_partitions_into_two_plates() {
        let snap = bake_impl(&draft_for("plates2"));
        let mut ids: Vec<i32> = snap.cell_plate_ids.iter().copied().filter(|&p| p >= 0).collect();
        ids.sort();
        ids.dedup();
        assert!(ids.len() >= 2 && ids.len() <= 3, "plates2 → {} plates ({:?})", ids.len(), ids);
    }

    #[test]
    fn plates4_partitions_into_about_four_plates() {
        let snap = bake_impl(&draft_for("plates4"));
        let mut ids: Vec<i32> = snap.cell_plate_ids.iter().copied().filter(|&p| p >= 0).collect();
        ids.sort();
        ids.dedup();
        // ±1 tolerance because hue-rounding can fall on a 10° boundary.
        assert!(ids.len() >= 3 && ids.len() <= 5, "plates4 → {} plates ({:?})", ids.len(), ids);
    }

    #[test]
    fn user_brush_wins_over_preset() {
        let mut draft = draft_for("plates2");
        draft.continental_cells = (0..200).collect();
        let snap = bake_impl(&draft);
        let cont: u32 = snap.cell_continental.iter().take(200).map(|&c| c as u32).sum();
        assert!(cont >= 180, "expected >=180 painted-continental cells, got {}", cont);
    }
}
