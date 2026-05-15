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

use crate::planet::{snapshot_model, PlanetSnapshot};
use crate::sim_state::{ManagedSim, SimState};
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct WizardDraft {
    pub divisions: u32,
    pub seed: u64,
    /// One of "plates2" / "plates3" / "plates4" / "plates5" / "plates5Uneven".
    pub preset: String,
    pub brush_radius_rad: f32,
    pub continental_cells: Vec<u32>,
    /// Per-boundary type assignment. Key = "min_id-max_id" (sorted plate
    /// pair, e.g. "1-3"). Value = "convergent" or "divergent". Missing
    /// pairs are left to the sim's default initial-omega.
    #[serde(default)]
    pub boundary_types: std::collections::HashMap<String, String>,
    pub run_length_steps: u32,
    pub dt_ma: f32,
}

#[derive(Debug, Serialize)]
pub struct PartitionResult {
    pub n_cells: u32,
    /// Plate id per cell (`-1` cannot happen here — every cell falls in one
    /// preset bucket). Use u32 since 0xFFFF_FFFF would also be unreachable.
    pub cell_plate_ids: Vec<u32>,
    /// Ordered, deterministic list of (plate_a, plate_b, boundary_cells)
    /// triples. plate_a < plate_b always; cells listed are those that sit on
    /// the seam between the pair. Cells on three-plate junctions appear in
    /// multiple entries.
    pub boundaries: Vec<BoundaryPair>,
    /// Per-plate seed centroid in 3D — used by the front-end to position
    /// arrow indicators / force-direction previews.
    pub plate_centroids: Vec<[f32; 3]>,
    /// Plate ids parallel to `plate_centroids`.
    pub plate_ids: Vec<u32>,
}

#[derive(Debug, Serialize)]
pub struct BoundaryPair {
    pub plate_a: u32,
    pub plate_b: u32,
    pub cells: Vec<u32>,
}

/// Run the preset → cell-plate-id partition without baking the planet so the
/// front-end can highlight boundaries during the force step. Deterministic
/// for any (divisions, preset, seed) triple.
#[tauri::command]
pub fn compute_partition(divisions: u32, preset: String, seed: u64) -> PartitionResult {
    use std::collections::BTreeMap;

    let img = image::load_from_memory(preset_bytes(&preset))
        .expect("preset PNG should decode")
        .to_rgba8();
    let grid = Grid::new(divisions);
    let n_cells = grid.n_fields();

    let mut hue_to_plate: BTreeMap<u32, u32> = BTreeMap::new();
    let mut next_id: u32 = 1;
    let mut cell_plate_ids: Vec<u32> = Vec::with_capacity(n_cells as usize);

    let mut cell_hue: Vec<u32> = Vec::with_capacity(n_cells as usize);
    for fid in 0..n_cells {
        let pos = grid.position(fid);
        let (r, g, b) = sample_preset(&img, pos);
        let (h, _s, _v) = rgb_to_hsv(r, g, b);
        cell_hue.push(((h / 10.0).round() as u32) * 10);
        hue_to_plate.entry(cell_hue[fid as usize]).or_insert_with(|| {
            let pid = next_id; next_id += 1; pid
        });
    }
    for fid in 0..n_cells {
        cell_plate_ids.push(hue_to_plate[&cell_hue[fid as usize]]);
    }

    // Denoise: anti-aliased pixels at the PNG's plate-color edges can drop
    // single cells into the wrong hue bucket, producing phantom boundary
    // speckles mid-plate. Two-pass majority filter: if a cell disagrees with
    // strictly more than half its neighbours, snap it to the neighbour
    // majority. Repeat once to absorb adjacent speckle clusters.
    cell_plate_ids = majority_smooth(&grid, cell_plate_ids);
    cell_plate_ids = majority_smooth(&grid, cell_plate_ids);

    // Boundary discovery — pairs keyed (min, max) so we don't double-count.
    let mut pair_cells: BTreeMap<(u32, u32), Vec<u32>> = BTreeMap::new();
    for fid in 0..n_cells {
        let my = cell_plate_ids[fid as usize];
        let mut emitted_pairs: Vec<(u32, u32)> = Vec::new();
        for &nb in grid.neighbours(fid) {
            let theirs = cell_plate_ids[nb as usize];
            if theirs == my { continue; }
            let pair = if my < theirs { (my, theirs) } else { (theirs, my) };
            if emitted_pairs.contains(&pair) { continue; }
            emitted_pairs.push(pair);
            pair_cells.entry(pair).or_insert_with(Vec::new).push(fid);
        }
    }

    let boundaries: Vec<BoundaryPair> = pair_cells
        .into_iter()
        .map(|((a, b), cells)| BoundaryPair { plate_a: a, plate_b: b, cells })
        .collect();

    // Plate centroids — average unit-sphere position of all member cells,
    // then renormalised so it lives on the sphere.
    let n_plates = next_id - 1;
    let mut sums = vec![Vec3::ZERO; n_plates as usize];
    let mut counts = vec![0u32; n_plates as usize];
    for fid in 0..n_cells {
        let pid = cell_plate_ids[fid as usize];
        sums[(pid - 1) as usize] += grid.position(fid);
        counts[(pid - 1) as usize] += 1;
    }
    let mut plate_centroids: Vec<[f32; 3]> = Vec::with_capacity(n_plates as usize);
    let mut plate_ids: Vec<u32> = Vec::with_capacity(n_plates as usize);
    for i in 0..n_plates {
        let c = sums[i as usize].normalize_or_zero();
        plate_centroids.push([c.x, c.y, c.z]);
        plate_ids.push(i + 1);
    }

    PartitionResult {
        n_cells,
        cell_plate_ids,
        boundaries,
        plate_centroids,
        plate_ids,
    }
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
pub fn bake_from_wizard(
    draft: WizardDraft,
    sim: State<'_, ManagedSim>,
) -> PlanetSnapshot {
    let model = bake_model(&draft);
    let snap = snapshot_model(&model, draft.divisions);
    let mut guard = sim.0.lock().expect("sim mutex poisoned");
    *guard = Some(SimState {
        model,
        divisions: draft.divisions,
        dt_ma: draft.dt_ma,
    });
    snap
}

/// Advance the persisted sim by `n_steps` and return a fresh snapshot.
#[tauri::command]
pub fn step_planet(
    n_steps: u32,
    sim: State<'_, ManagedSim>,
) -> Result<PlanetSnapshot, String> {
    let mut guard = sim.0.lock().map_err(|_| "sim mutex poisoned".to_string())?;
    let state = guard.as_mut().ok_or_else(|| "no baked planet".to_string())?;
    for _ in 0..n_steps {
        state.model.step(state.dt_ma);
    }
    Ok(snapshot_model(&state.model, state.divisions))
}

/// Drop the persisted model — called on edit-wizard / new bake.
#[tauri::command]
pub fn reset_sim(sim: State<'_, ManagedSim>) {
    let mut guard = sim.0.lock().expect("sim mutex poisoned");
    *guard = None;
}

/// Reapply the user's boundary-type assignments to the running model without
/// re-baking from scratch. Each plate's angular velocity is rewritten from
/// its *current* centroid + the assigned types — so the sim instantly
/// reflects the edit at the play head.
#[tauri::command]
pub fn apply_boundary_types(
    boundary_types: std::collections::HashMap<String, String>,
    sim: State<'_, ManagedSim>,
) -> Result<PlanetSnapshot, String> {
    let mut guard = sim.0.lock().map_err(|_| "sim mutex poisoned".to_string())?;
    let state = guard.as_mut().ok_or_else(|| "no baked planet".to_string())?;

    let n_cells = state.model.grid.n_fields();
    let mut sums: std::collections::HashMap<u32, Vec3> = std::collections::HashMap::new();
    let mut counts: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    for fid in 0..n_cells {
        if let Some(pid) = state.model.fields[fid as usize].plate_id {
            *sums.entry(pid).or_insert(Vec3::ZERO) += state.model.grid.position(fid);
            *counts.entry(pid).or_insert(0) += 1;
        }
    }
    let mut centroids: std::collections::HashMap<u32, Vec3> = std::collections::HashMap::new();
    for (pid, sum) in sums {
        centroids.insert(pid, sum.normalize_or_zero());
    }

    let mut force_dir: std::collections::HashMap<u32, Vec3> = std::collections::HashMap::new();
    for (key, ty) in &boundary_types {
        let mut it = key.split('-');
        let a: u32 = match it.next().and_then(|s| s.parse().ok()) { Some(v) => v, None => continue };
        let b: u32 = match it.next().and_then(|s| s.parse().ok()) { Some(v) => v, None => continue };
        let (ca, cb) = match (centroids.get(&a), centroids.get(&b)) {
            (Some(ca), Some(cb)) => (*ca, *cb),
            _ => continue,
        };
        let dir_ab = (cb - ca).normalize_or_zero();
        if dir_ab.length_squared() < 1e-6 { continue; }
        let sign = match ty.as_str() {
            "convergent" =>  1.0_f32,
            "divergent"  => -1.0_f32,
            _            =>  0.0_f32,
        };
        *force_dir.entry(a).or_insert(Vec3::ZERO) += dir_ab * sign;
        *force_dir.entry(b).or_insert(Vec3::ZERO) -= dir_ab * sign;
    }

    let seed = state.model.master_seed;
    for plate in state.model.plates.iter_mut() {
        let pid = plate.id;
        let pos = match centroids.get(&pid) { Some(p) => *p, None => continue };
        let f = force_dir.get(&pid).copied().unwrap_or(Vec3::ZERO);
        let mut omega = if f.length_squared() > 1e-6 {
            let v = f.normalize() * 0.01;
            let tangent = v - pos * v.dot(pos);
            if tangent.length_squared() > 1e-6 {
                pos.cross(tangent)
            } else {
                omega_for_plate(pid, seed)
            }
        } else {
            omega_for_plate(pid, seed)
        };
        let len = omega.length();
        if len > MAX_PLATE_SPEED {
            omega *= MAX_PLATE_SPEED / len;
        }
        plate.angular_velocity = omega;
    }

    let _ = counts; // silence unused; kept for future inertia recompute
    Ok(snapshot_model(&state.model, state.divisions))
}

/// Apply a plate density rank to the running model. The frontend ships a
/// list of plate ids ordered lightest → densest; we map that onto a linear
/// density spread and write each plate's `density` in place.
#[tauri::command]
pub fn apply_density_rank(
    order: Vec<u32>,
    sim: State<'_, ManagedSim>,
) -> Result<PlanetSnapshot, String> {
    const MIN_DENSITY: f32 = 0.30;
    const MAX_DENSITY: f32 = 1.20;
    let mut guard = sim.0.lock().map_err(|_| "sim mutex poisoned".to_string())?;
    let state = guard.as_mut().ok_or_else(|| "no baked planet".to_string())?;
    let n = order.len().max(1) as f32;
    for (i, pid) in order.iter().enumerate() {
        let t = if n <= 1.0 { 0.5 } else { i as f32 / (n - 1.0) };
        let d = MIN_DENSITY + t * (MAX_DENSITY - MIN_DENSITY);
        if let Some(plate) = state.model.plates.iter_mut().find(|p| p.id == *pid) {
            plate.density = d;
        }
    }
    Ok(snapshot_model(&state.model, state.divisions))
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

/// One pass of cellular majority filtering. A cell whose plate id is strictly
/// outnumbered by a different neighbour plate id gets snapped to that
/// majority. Cleans up anti-aliased PNG edges that would otherwise produce
/// phantom boundary cells mid-plate. Deterministic — visits cells in id
/// order and consumes its input array (the read view is frozen).
fn majority_smooth(grid: &Grid, cells: Vec<u32>) -> Vec<u32> {
    use std::collections::HashMap;
    let mut out = cells.clone();
    for fid in 0..grid.n_fields() {
        let mut counts: HashMap<u32, u32> = HashMap::new();
        let mut total = 0u32;
        for &nb in grid.neighbours(fid) {
            *counts.entry(cells[nb as usize]).or_insert(0) += 1;
            total += 1;
        }
        let me = cells[fid as usize];
        let mut best = me;
        let mut best_count = *counts.get(&me).unwrap_or(&0);
        for (&pid, &count) in &counts {
            // Prefer the neighbour-majority. Tie-break favours the smaller
            // plate id for determinism.
            if count > best_count || (count == best_count && pid < best) {
                best = pid;
                best_count = count;
            }
        }
        // Only flip if the majority is strictly larger than half the neighbour
        // count — leaves legitimate boundary cells (≈ 50/50) untouched.
        if best != me && best_count * 2 > total {
            out[fid as usize] = best;
        }
    }
    out
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

fn bake_model(draft: &WizardDraft) -> Model {
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

    // ── Step 1b: denoise — anti-aliased PNG edges create speckle cells in
    // the wrong hue bucket; majority-filter twice so the bake matches what
    // the user sees in the partition preview.
    let mut cell_plate_ids: Vec<u32> = infos
        .iter()
        .map(|i| hue_to_plate[&i.hue_bucket])
        .collect();
    cell_plate_ids = majority_smooth(&model.grid, cell_plate_ids);
    cell_plate_ids = majority_smooth(&model.grid, cell_plate_ids);

    // ── Step 2: build per-plate cell buckets in plate-id order.
    let plate_count = hue_to_plate.len() as u32;
    let mut buckets: Vec<Vec<u32>> = (0..plate_count).map(|_| Vec::new()).collect();
    let mut plate_continental: Vec<bool> = vec![false; plate_count as usize];
    for fid in 0..n_cells {
        let pid = cell_plate_ids[fid as usize];
        buckets[(pid - 1) as usize].push(fid);
        let cont = if user_continental[fid as usize] {
            true
        } else {
            is_continental(infos[fid as usize].preset_elevation)
        };
        if cont {
            plate_continental[(pid - 1) as usize] = true;
        }
    }

    // ── Step 3a: compute plate centroids so we can bias initial omega from
    // the user-assigned boundary types (convergent/divergent).
    let n_plates = buckets.len();
    let mut plate_centroids: Vec<Vec3> = vec![Vec3::ZERO; n_plates];
    let mut plate_counts: Vec<u32> = vec![0; n_plates];
    for (i, cells) in buckets.iter().enumerate() {
        for &fid in cells {
            plate_centroids[i] += model.grid.position(fid);
            plate_counts[i] += 1;
        }
        if plate_counts[i] > 0 {
            plate_centroids[i] = plate_centroids[i].normalize_or_zero();
        }
    }

    // ── Step 3b: per-plate force accumulator from the user's boundary types.
    // For each (a, b) assignment:
    //   convergent — plate a wants to move toward b, plate b toward a
    //   divergent  — plate a wants to move away from b, plate b away from a
    // Translate "movement toward direction d" into an angular velocity around
    // axis (d × position) so the rotation actually drifts the plate that way.
    let mut force_dir: Vec<Vec3> = vec![Vec3::ZERO; n_plates];
    for (pair_key, ty) in &draft.boundary_types {
        let mut it = pair_key.split('-');
        let a: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let b: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        if a == 0 || b == 0 || a as usize > n_plates || b as usize > n_plates {
            continue;
        }
        let ia = (a - 1) as usize;
        let ib = (b - 1) as usize;
        let dir_ab = (plate_centroids[ib] - plate_centroids[ia]).normalize_or_zero();
        if dir_ab.length_squared() < 1e-6 { continue; }
        let sign: f32 = match ty.as_str() {
            "convergent" => 1.0,
            "divergent"  => -1.0,
            _ => 0.0,
        };
        force_dir[ia] += dir_ab * sign;
        force_dir[ib] -= dir_ab * sign;
    }

    // ── Step 3c: register plates with the model.
    for (i, cells) in buckets.iter().enumerate() {
        let pid = (i + 1) as u32;
        let color_arr = PALETTE[i % PALETTE.len()];
        let packed = ((color_arr[0] as u32) << 16) | ((color_arr[1] as u32) << 8) | (color_arr[2] as u32);
        let density = if plate_continental[i] { 0.35 } else { 1.05 };
        let mut omega = omega_for_plate(pid, draft.seed);

        // If the user assigned any boundaries to this plate, override the
        // random omega with one that points the plate along the user's force
        // direction. Translate desired linear velocity at the centroid into
        // an angular velocity: omega = pos × velocity / |pos|^2.
        let f = force_dir[i];
        if f.length_squared() > 1e-6 {
            let v = f.normalize() * 0.01; // target tangential speed
            // Project v onto the tangent plane of plate_centroids[i].
            let p = plate_centroids[i];
            let tangent = v - p * v.dot(p);
            if tangent.length_squared() > 1e-6 {
                omega = p.cross(tangent);
            }
        }

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

    let _ = n_cells;
    model
}

/// Return the triangle index list for the icosphere at the given divisions.
/// Each consecutive triple of u32s is one triangle, indexing into the
/// per-cell position list. Used by the renderer to build the planet mesh.
#[tauri::command]
pub fn get_grid_triangles(divisions: u32) -> Vec<u32> {
    let grid = Grid::new(divisions);
    grid.sphere().triangles().to_vec()
}

#[cfg(test)]
pub fn bake_impl(draft: &WizardDraft) -> PlanetSnapshot {
    let model = bake_model(draft);
    snapshot_model(&model, draft.divisions)
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
            boundary_types: std::collections::HashMap::new(),
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
