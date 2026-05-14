//! v0.2 wizard data model + bake command. Replaces the hardcoded demo from
//! v0.1. The frontend ships a fully-populated `WizardDraft` (resolution,
//! seed, per-plate data including hand-painted cell ids), the Rust side
//! consumes it and produces a `PlanetSnapshot`.
//!
//! Determinism: the draft's `seed` flows into `Model::new(divisions, seed)`,
//! so the same draft always produces the same baked planet.

use glam::Vec3;
use serde::{Deserialize, Serialize};

use hayba_tectonics_v2::field::Crust;
use hayba_tectonics_v2::model::{Model, MAX_PLATE_SPEED};
use hayba_tectonics_v2::sphere::Grid;

use crate::planet::PlanetSnapshot;

#[derive(Debug, Deserialize)]
pub struct WizardDraft {
    pub divisions: u32,
    pub seed: u64,
    pub plates: Vec<WizardPlate>,
    pub run_length_steps: u32,
    pub dt_ma: f32,
}

#[derive(Debug, Deserialize)]
pub struct WizardPlate {
    pub id: u32,
    pub color_rgb: [u8; 3],
    pub density: f32,
    pub continental: bool,
    pub initial_omega: [f32; 3],
    /// Cells the user explicitly painted for this plate. Empty for plates
    /// that should auto-fill from the leftover ocean cell pool.
    pub cell_ids: Vec<u32>,
}

#[derive(Debug, Serialize)]
pub struct WizardInit {
    pub divisions: u32,
    pub n_cells: u32,
    /// Flattened unit-sphere positions, length = `n_cells * 3`. Frontend
    /// uses these to build a kd-tree for nearest-cell lookups during paint.
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
    use hayba_tectonics_v2::determinism::split_mix_64;
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

fn pack_color(rgb: [u8; 3]) -> u32 {
    ((rgb[0] as u32) << 16) | ((rgb[1] as u32) << 8) | (rgb[2] as u32)
}

fn bake_impl(draft: &WizardDraft) -> PlanetSnapshot {
    let mut model = Model::new(draft.divisions, draft.seed);
    let n_cells = model.grid.n_fields();
    let mut claimed: Vec<bool> = vec![false; n_cells as usize];

    // First pass: plates with painted cells. First-come, first-served by
    // plate iteration order (frontend can re-order to control priority).
    for wp in &draft.plates {
        let assigned: Vec<u32> = wp
            .cell_ids
            .iter()
            .copied()
            .filter(|&fid| fid < n_cells && !claimed[fid as usize])
            .collect();
        for &fid in &assigned {
            claimed[fid as usize] = true;
        }
        let mut omega = Vec3::from(wp.initial_omega);
        let len = omega.length();
        if len > MAX_PLATE_SPEED {
            omega *= MAX_PLATE_SPEED / len;
        }
        model.add_plate(wp.id, pack_color(wp.color_rgb), wp.density, &assigned, wp.continental, omega);
    }

    // Second pass: distribute remaining (unclaimed) cells across oceanic
    // plates with no painted cells. Round-robin for even coverage.
    let ocean_plates: Vec<u32> = draft
        .plates
        .iter()
        .filter(|p| !p.continental && p.cell_ids.is_empty())
        .map(|p| p.id)
        .collect();

    if !ocean_plates.is_empty() {
        let mut idx = 0usize;
        for fid in 0..n_cells {
            if claimed[fid as usize] {
                continue;
            }
            let pid = ocean_plates[idx % ocean_plates.len()];
            idx += 1;
            if let Some(f) = model.fields.get_mut(fid as usize) {
                f.plate_id = Some(pid);
                f.crust = Crust::new_oceanic();
                f.elevation = -0.3;
                f.refresh_oceanic_lithosphere();
            }
            if let Some(p) = model.plates.iter_mut().find(|p| p.id == pid) {
                p.add_field(fid);
            }
        }
        let area = model.grid.field_area_km2();
        let fields_ref = model.fields.clone();
        for p in model.plates.iter_mut() {
            p.update_inertia_tensor(&fields_ref, area);
        }
    }

    // Step the sim a bit so things settle.
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
    fn bake_from_wizard_honors_painted_cells() {
        let draft = WizardDraft {
            divisions: 32,
            seed: 7,
            run_length_steps: 2,
            dt_ma: 0.5,
            plates: vec![
                WizardPlate {
                    id: 1,
                    color_rgb: [181, 106, 29],
                    density: 0.30,
                    continental: true,
                    initial_omega: [0.0, 0.005, 0.0],
                    cell_ids: (0..100).collect(),
                },
                WizardPlate {
                    id: 2,
                    color_rgb: [106, 159, 220],
                    density: 1.10,
                    continental: false,
                    initial_omega: [0.0, -0.004, 0.0],
                    cell_ids: vec![],
                },
            ],
        };
        let snap = bake_impl(&draft);
        assert_eq!(snap.n_cells, 10242);
        let continental: u32 = snap.cell_continental.iter().map(|&c| c as u32).sum();
        assert!(continental >= 90, "expected >=90 continental cells, got {}", continental);
        let plate_1: usize = snap.cell_plate_ids.iter().filter(|&&p| p == 1).count();
        let plate_2: usize = snap.cell_plate_ids.iter().filter(|&&p| p == 2).count();
        assert!(plate_1 >= 90, "plate 1 cell count low: {}", plate_1);
        assert!(plate_2 > 0, "plate 2 should auto-fill with ocean cells");
    }
}
