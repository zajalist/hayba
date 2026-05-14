//! v0.2 wizard. Mirrors TE's flow:
//!   1. User picks plate count + paints continental crust on the sphere.
//!   2. The sim auto-partitions the sphere into N plates by Voronoi-nearest
//!      to a deterministic seed-point set (Fibonacci spiral on the unit
//!      sphere, rotated by the draft's seed for variety).
//!   3. Cells the user painted are upgraded to continental crust.
//!   4. Step the model briefly so plates settle.

use glam::Vec3;
use serde::{Deserialize, Serialize};

use hayba_tectonics_v2::determinism::{split_mix_64, DeterministicRng};
use hayba_tectonics_v2::field::Crust;
use hayba_tectonics_v2::model::{Model, MAX_PLATE_SPEED};
use hayba_tectonics_v2::sphere::Grid;

use crate::planet::PlanetSnapshot;

#[derive(Debug, Deserialize)]
pub struct WizardDraft {
    pub divisions: u32,
    pub seed: u64,
    pub plate_count: u32,
    /// Brush radius in radians (≈ great-circle angular radius). Stored on
    /// the draft so re-bakes from the same draft produce the same world.
    pub brush_radius_rad: f32,
    /// Cells the user painted as continental crust. Set semantics; order
    /// doesn't matter and duplicates are tolerated.
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

/// Fibonacci spiral on the unit sphere — gives well-spread plate seed
/// positions for any plate_count. Rotation derived from the draft's seed
/// so different seeds produce different partitions of the same sphere.
fn plate_seed_positions(count: u32, seed: u64) -> Vec<Vec3> {
    let mut rng = DeterministicRng::new(seed);
    // Two random rotations (azimuth + tilt) so seed varies output.
    let azimuth_offset = (rng.next_u64() as f64 / u64::MAX as f64) * std::f64::consts::TAU;
    let tilt = (rng.next_u64() as f64 / u64::MAX as f64) * std::f64::consts::PI - std::f64::consts::FRAC_PI_2;
    let golden = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt()); // golden angle
    let n = count.max(1) as f64;
    let cos_t = tilt.cos();
    let sin_t = tilt.sin();
    (0..count.max(1))
        .map(|i| {
            let y = 1.0 - (i as f64 / (n - 1.0).max(1.0)) * 2.0;
            let r = (1.0 - y * y).sqrt();
            let theta = golden * i as f64 + azimuth_offset;
            // Initial position around the y-axis spiral.
            let x = theta.cos() * r;
            let z = theta.sin() * r;
            // Rotate around the x-axis by `tilt` so seeds vary per seed value.
            let yt = y * cos_t - z * sin_t;
            let zt = y * sin_t + z * cos_t;
            Vec3::new(x as f32, yt as f32, zt as f32).normalize()
        })
        .collect()
}

/// Deterministic initial omega per plate id — opposing pairs so they push
/// against each other rather than co-rotating.
fn omega_for_plate(plate_id: u32, seed: u64) -> Vec3 {
    let mut state = seed ^ ((plate_id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let r1 = (split_mix_64(&mut state) as f64 / u64::MAX as f64) * 2.0 - 1.0;
    let r2 = (split_mix_64(&mut state) as f64 / u64::MAX as f64) * 2.0 - 1.0;
    let r3 = (split_mix_64(&mut state) as f64 / u64::MAX as f64) * 2.0 - 1.0;
    let raw = Vec3::new(r1 as f32, r2 as f32, r3 as f32).normalize_or_zero();
    raw * 0.01
}

/// Curated palette — same plate-color hues across the app.
const PALETTE: &[[u8; 3]] = &[
    [181, 106,  29],
    [138,  74, 138],
    [ 90,  58, 138],
    [ 58, 122,  90],
    [168, 132,  58],
    [168,  58,  58],
    [ 58, 138, 138],
    [106, 159, 220],
    [212, 159, 102],
    [128, 102,  76],
    [ 91, 116,  74],
    [156,  92, 108],
    [ 76,  98, 142],
    [188, 150,  98],
    [114,  74,  58],
    [ 90, 140, 105],
];

fn bake_impl(draft: &WizardDraft) -> PlanetSnapshot {
    let mut model = Model::new(draft.divisions, draft.seed);
    let n_cells = model.grid.n_fields();
    let plate_count = draft.plate_count.max(1);

    // Continental cell lookup — O(1) check during plate assignment.
    let mut is_continental = vec![false; n_cells as usize];
    for &fid in &draft.continental_cells {
        if (fid as u32) < n_cells {
            is_continental[fid as usize] = true;
        }
    }

    // Step 1: auto-partition the sphere — Voronoi-nearest to plate seeds.
    let seeds = plate_seed_positions(plate_count, draft.seed);
    let mut buckets: Vec<Vec<u32>> = (0..plate_count).map(|_| Vec::new()).collect();
    let mut continental_buckets: Vec<bool> = vec![false; plate_count as usize];

    for fid in 0..n_cells {
        let p = model.grid.position(fid);
        let mut best = 0u32;
        let mut best_d = f32::INFINITY;
        for (i, s) in seeds.iter().enumerate() {
            let d = (p - *s).length_squared();
            if d < best_d {
                best_d = d;
                best = i as u32;
            }
        }
        buckets[best as usize].push(fid);
        if is_continental[fid as usize] {
            continental_buckets[best as usize] = true;
        }
    }

    // Step 2: register plates with the model. Each plate's `continental`
    // flag is set if ANY of its cells were painted continental; that
    // controls the default crust the sim seeds. Per-cell continental
    // override happens in step 3.
    for (i, cells) in buckets.iter().enumerate() {
        let pid = (i + 1) as u32;
        let color = PALETTE[i % PALETTE.len()];
        let packed = ((color[0] as u32) << 16) | ((color[1] as u32) << 8) | (color[2] as u32);
        let density = if continental_buckets[i] { 0.35 } else { 1.05 };
        let mut omega = omega_for_plate(pid, draft.seed);
        let len = omega.length();
        if len > MAX_PLATE_SPEED {
            omega *= MAX_PLATE_SPEED / len;
        }
        model.add_plate(pid, packed, density, cells, continental_buckets[i], omega);
    }

    // Step 3: override per-cell crust so the user's continent stroke wins
    // regardless of the plate-wide default. Cells the user did NOT paint
    // stay oceanic; cells they painted become continental crust.
    for fid in 0..n_cells {
        let cont = is_continental[fid as usize];
        if let Some(f) = model.fields.get_mut(fid as usize) {
            if cont {
                f.crust = Crust::new_continental();
                f.elevation = 0.5;
                f.become_continental_lithosphere(200.0);
            } else {
                f.crust = Crust::new_oceanic();
                f.elevation = -0.3;
                f.refresh_oceanic_lithosphere();
            }
        }
    }

    // Refresh inertia tensors after the crust override pass.
    let area = model.grid.field_area_km2();
    let fields_ref = model.fields.clone();
    for p in model.plates.iter_mut() {
        p.update_inertia_tensor(&fields_ref, area);
    }

    // Step 4: run a brief step loop.
    for _ in 0..draft.run_length_steps {
        model.step(draft.dt_ma);
    }

    // Snapshot.
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
        cell_plate_ids.push(match f.plate_id {
            Some(pid) => pid as i32,
            None => -1,
        });
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

    #[test]
    fn bake_partitions_into_requested_plate_count() {
        let draft = WizardDraft {
            divisions: 32,
            seed: 7,
            plate_count: 5,
            brush_radius_rad: 0.2,
            continental_cells: (0..500).collect(),
            run_length_steps: 1,
            dt_ma: 0.5,
        };
        let snap = bake_impl(&draft);
        assert_eq!(snap.n_cells, 10242);
        let mut plate_ids: Vec<i32> = snap.cell_plate_ids.iter().copied().filter(|&p| p >= 0).collect();
        plate_ids.sort();
        plate_ids.dedup();
        assert_eq!(plate_ids.len(), 5, "expected 5 plates, got {:?}", plate_ids);
        let cont: u32 = snap.cell_continental.iter().map(|&c| c as u32).sum();
        assert!(cont >= 450, "user-painted continental cells should survive bake, got {}", cont);
    }
}
