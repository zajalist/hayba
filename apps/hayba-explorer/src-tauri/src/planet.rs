//! v0.1 in-process demo bake. Constructs a Model at `divisions=64`, seeds
//! 8 plates (4 continental + 4 oceanic) in the same pattern as the Phase
//! 10.1 audit wizard, runs a short step loop, and dumps a JSON-friendly
//! snapshot the frontend can render directly.
//!
//! This is the v0.1 substitute for the wizard. Real wizard inputs land in
//! v0.2 per `docs/superpowers/specs/2026-05-14-hayba-explorer-design.md`.

use glam::Vec3;
use serde::Serialize;

use hayba_tectonics_v2::model::{Model, MAX_PLATE_SPEED};

const DEMO_DIVISIONS: u32 = 64;
const DEMO_STEPS: u32 = 5;
const DEMO_DT_MA: f32 = 0.5;
const DEMO_SEED: u64 = 42;

#[derive(Debug, Serialize, Default)]
pub struct ClimateDebugWire {
    pub insolation: Vec<f32>,
    pub base_temp: Vec<f32>,
    pub dist_to_ocean: Vec<f32>,
    pub wind: Vec<f32>,
    pub current_dt: Vec<f32>,
    pub orographic: Vec<f32>,
    pub continental_dry: Vec<f32>,
}

#[derive(Serialize)]
pub struct PlanetSnapshot {
    pub divisions: u32,
    pub n_cells: u32,
    pub sim_time_ma: f32,
    /// Flattened unit-sphere positions, length = `n_cells * 3`. Three.js
    /// consumes Float32Array of this shape directly.
    pub cell_positions: Vec<f32>,
    /// Plate id per cell (`-1` = ocean / no plate).
    pub cell_plate_ids: Vec<i32>,
    /// Sim-units elevation per cell.
    pub cell_elevation: Vec<f32>,
    /// 1 = continental crust, 0 = oceanic.
    pub cell_continental: Vec<u8>,
    /// 1 = on a plate boundary, 0 = interior. Matches TE's `field.boundary`
    /// — cells whose neighbour list includes any cell on a different plate.
    pub cell_is_boundary: Vec<u8>,
    /// For each boundary cell, the plate id on the OTHER side (majority of
    /// differing neighbours). `-1` for interior cells. Lets the front-end
    /// look up `boundary_types[pair(me, other)]` per cell — no client-side
    /// neighbour search needed.
    pub cell_neighbor_plate: Vec<i32>,
    /// Maximum absolute neighbour elevation difference, normalized to [0, 1].
    pub cell_slope: Vec<f32>,
    /// Latitude band index: 0=Tropical, 1=Subtropical, 2=Temperate, 3=Subpolar, 4=Polar.
    pub cell_latitude_band: Vec<u8>,
    /// Crust age in simulation units (great-circle distance travelled).
    pub cell_age_ma: Vec<f32>,
    /// Total crust thickness in meters (model units; label "km" is a naming
    /// convention inherited from the spec; values are meters internally).
    pub cell_crust_thickness_km: Vec<f32>,
    /// Volcanic intensity per cell. 1.0 = active volcanic field, 0.0 = none.
    /// (VolcanicActivity is currently a placeholder struct with no scalar field;
    /// presence = 1.0, absence = 0.0.)
    pub cell_volcanic_intensity: Vec<f32>,
    /// Collision kind: 0=none, 1=Subduction, 2=Orogeny, 3=Buffer-kill, 4=Drag.
    pub cell_collision_kind: Vec<u8>,
    /// Subduction progress in [0, 1]. 0.0 for non-subducting cells.
    pub cell_subduction_progress: Vec<f32>,
    /// 1 = is a continent buffer cell, 0 = not.
    pub cell_is_continent_buffer: Vec<u8>,
    /// Recent orogenic uplift rate, normalized to [0, 1].
    pub cell_orogenic_uplift: Vec<f32>,
    /// Steps since this cell was spawned at a mid-ocean ridge.
    pub cell_mor_age_steps: Vec<u16>,
    /// Annual-mean surface temperature (°C). Recomputed every step.
    pub cell_temperature: Vec<f32>,
    /// Annual precipitation, normalized 0..1.
    pub cell_precip: Vec<f32>,
    /// Whittaker biome id (0..9) as f32 for buffer-attribute upload.
    pub cell_biome: Vec<f32>,
    /// Secondary (perturbed) biome id (0..9) for soft 2-way blending.
    pub cell_biome2: Vec<f32>,
    /// Primary→secondary blend weight, 0..0.5.
    pub cell_biome_blend: Vec<f32>,
    /// Per-cell STABLE pseudo-random unit vec3 (length = `n_cells * 3`),
    /// keyed on the immutable cell index. The shader keys its within-biome
    /// surface texture noise on this so the texture rides with the drifting
    /// crust instead of crawling through a world-locked noise field.
    pub cell_seed: Vec<f32>,
    /// Climate debug fields — empty unless `want_climate_debug`.
    #[serde(default)]
    pub climate_debug: ClimateDebugWire,
}

struct DemoPlate {
    id: u32,
    color: u32,
    density: f32,
    /// Center of a single continent blob (None = pure-ocean plate).
    continent_center: Option<Vec3>,
    continent_radius_rad: f32,
    omega: Vec3,
}

fn demo_plates() -> [DemoPlate; 8] {
    [
        DemoPlate { id: 1, color: 0xB56A1D, density: 0.30, continent_center: Some(Vec3::new(1.0, 0.0, 0.0)), continent_radius_rad: 0.7, omega: Vec3::new(0.0, 0.01, 0.0) },
        DemoPlate { id: 2, color: 0x6A9FDC, density: 1.10, continent_center: None, continent_radius_rad: 0.0, omega: Vec3::new(0.0, -0.008, 0.005) },
        DemoPlate { id: 3, color: 0x8A4A8A, density: 0.45, continent_center: Some(Vec3::new(-1.0, 0.0, 0.0)), continent_radius_rad: 0.6, omega: Vec3::new(0.005, 0.0, 0.005) },
        DemoPlate { id: 4, color: 0x3A7A5A, density: 1.05, continent_center: None, continent_radius_rad: 0.0, omega: Vec3::new(0.0, 0.008, -0.005) },
        DemoPlate { id: 5, color: 0xA8843A, density: 0.35, continent_center: Some(Vec3::new(0.0, 1.0, 0.0)), continent_radius_rad: 0.5, omega: Vec3::new(-0.006, 0.0, 0.0) },
        DemoPlate { id: 6, color: 0xA83A3A, density: 1.15, continent_center: None, continent_radius_rad: 0.0, omega: Vec3::new(0.006, 0.0, 0.0) },
        DemoPlate { id: 7, color: 0x5A3A8A, density: 0.40, continent_center: Some(Vec3::new(0.0, 0.0, 1.0)), continent_radius_rad: 0.55, omega: Vec3::new(0.0, 0.0, -0.007) },
        DemoPlate { id: 8, color: 0x3A8A8A, density: 1.00, continent_center: None, continent_radius_rad: 0.0, omega: Vec3::new(0.0, 0.0, 0.007) },
    ]
}

pub fn bake_demo() -> PlanetSnapshot {
    let mut model = Model::new(DEMO_DIVISIONS, DEMO_SEED);

    // Seed plates: assign cells inside each plate's continent blob (if any),
    // first-come first-served by plate id. Pure-ocean plates claim any
    // remaining cells in a deterministic stride.
    let n_cells = model.grid.n_fields();
    let mut claimed: Vec<bool> = vec![false; n_cells as usize];

    for dp in demo_plates().iter() {
        let mut assigned: Vec<u32> = Vec::new();
        let continental = dp.continent_center.is_some();

        if let Some(c) = dp.continent_center {
            let c = c.normalize();
            let cos_r = dp.continent_radius_rad.cos();
            for fid in 0..n_cells {
                if claimed[fid as usize] { continue; }
                let p = model.grid.position(fid);
                if p.dot(c) >= cos_r {
                    assigned.push(fid);
                    claimed[fid as usize] = true;
                }
            }
        }
        // Clamp omega to MAX_PLATE_SPEED.
        let mut omega = dp.omega;
        let len = omega.length();
        if len > MAX_PLATE_SPEED {
            omega *= MAX_PLATE_SPEED / len;
        }
        model.add_plate(dp.id, dp.color, dp.density, &assigned, continental, omega);
    }

    // Ocean: distribute remaining cells across pure-ocean plates (2, 4, 6, 8).
    let ocean_plate_ids: [u32; 4] = [2, 4, 6, 8];
    let mut ocean_buckets: [Vec<u32>; 4] = Default::default();
    let mut k = 0usize;
    for fid in 0..n_cells {
        if claimed[fid as usize] { continue; }
        ocean_buckets[k % 4].push(fid);
        k += 1;
    }
    for (i, &pid) in ocean_plate_ids.iter().enumerate() {
        // Mutate the existing plate's field assignments by re-adding (idempotent for ids).
        for &fid in &ocean_buckets[i] {
            if let Some(f) = model.fields.get_mut(fid as usize) {
                f.plate_id = Some(pid);
                f.crust = hayba_tectonics_v2::field::Crust::new_oceanic();
                f.elevation = -0.3;
                f.refresh_oceanic_lithosphere();
            }
            if let Some(p) = model.plates.iter_mut().find(|p| p.id == pid) {
                p.add_field(fid);
            }
        }
    }

    // Refresh inertia after the ocean fill.
    let area = model.grid.field_area_km2();
    let fields_ref = model.fields.clone();
    for p in model.plates.iter_mut() {
        p.update_inertia_tensor(&fields_ref, area);
    }

    // Run a short step loop so plates start moving.
    for _ in 0..DEMO_STEPS {
        model.step(DEMO_DT_MA);
    }

    let snap = snapshot_model(&model, DEMO_DIVISIONS, true);
    snap
}

/// Maximum absolute neighbour elevation difference, normalized to [0, 1] by
/// an empirical scale factor (the model's elevation rarely produces
/// neighbour deltas > 0.05 in unit-sphere units).
fn compute_slope(model: &hayba_tectonics_v2::model::Model, fid: u32) -> f32 {
    let here = model.fields[fid as usize].elevation;
    let mut max_diff = 0.0_f32;
    for &nb in model.grid.neighbours(fid) {
        let d = (model.fields[nb as usize].elevation - here).abs();
        if d > max_diff { max_diff = d; }
    }
    (max_diff * 20.0).clamp(0.0, 1.0)
}

/// Map a unit-sphere position to a latitude band index.
/// Uses the Y component (sin of latitude) as the proxy.
fn latitude_band(pos: glam::Vec3) -> u8 {
    let abs_lat = pos.y.abs();
    if abs_lat < 0.40 { 0 }      // Tropical (0–23.5°)
    else if abs_lat < 0.60 { 1 } // Subtropical
    else if abs_lat < 0.78 { 2 } // Temperate
    else if abs_lat < 0.93 { 3 } // Subpolar
    else { 4 }                   // Polar
}

/// Encode collision type as a u8: 0=none, 1=Subduction, 2=Orogeny,
/// 3=Buffer-kill, 4=Drag.
fn collision_kind(field: &hayba_tectonics_v2::field::Field) -> u8 {
    if !field.colliding { return 0; }
    if field.subduction.is_some() { return 1; }
    if field.orogenic_uplift > 0.0 { return 2; }
    if field.is_continent_buffer { return 3; }
    4
}

/// Build a `PlanetSnapshot` from a stepped model. Boundary detection matches
/// TE: a cell is on the boundary if any of its neighbours belong to a
/// different plate (see `tectonic-explorer/.../plate.ts` boundary scan).
pub fn snapshot_model(model: &Model, divisions: u32, want_climate_debug: bool) -> PlanetSnapshot {
    let n_cells = model.grid.n_fields();
    let mut cell_positions: Vec<f32> = Vec::with_capacity((n_cells * 3) as usize);
    let mut cell_plate_ids: Vec<i32> = Vec::with_capacity(n_cells as usize);
    let mut cell_elevation: Vec<f32> = Vec::with_capacity(n_cells as usize);
    let mut cell_continental: Vec<u8> = Vec::with_capacity(n_cells as usize);
    let mut cell_is_boundary: Vec<u8> = Vec::with_capacity(n_cells as usize);
    let mut cell_neighbor_plate: Vec<i32> = Vec::with_capacity(n_cells as usize);
    let mut cell_slope: Vec<f32> = Vec::with_capacity(n_cells as usize);
    let mut cell_latitude_band: Vec<u8> = Vec::with_capacity(n_cells as usize);
    let mut cell_age_ma: Vec<f32> = Vec::with_capacity(n_cells as usize);
    let mut cell_crust_thickness_km: Vec<f32> = Vec::with_capacity(n_cells as usize);
    let mut cell_volcanic_intensity: Vec<f32> = Vec::with_capacity(n_cells as usize);
    let mut cell_collision_kind: Vec<u8> = Vec::with_capacity(n_cells as usize);
    let mut cell_subduction_progress: Vec<f32> = Vec::with_capacity(n_cells as usize);
    let mut cell_is_continent_buffer: Vec<u8> = Vec::with_capacity(n_cells as usize);
    let mut cell_orogenic_uplift: Vec<f32> = Vec::with_capacity(n_cells as usize);
    let mut cell_mor_age_steps: Vec<u16> = Vec::with_capacity(n_cells as usize);

    for fid in 0..n_cells {
        let p = model.grid.position(fid);
        cell_positions.push(p.x);
        cell_positions.push(p.y);
        cell_positions.push(p.z);
        let f = &model.fields[fid as usize];
        let my_plate = f.plate_id;
        cell_plate_ids.push(match my_plate { Some(pid) => pid as i32, None => -1 });
        cell_elevation.push(f.elevation);
        cell_continental.push(if f.is_continent_crust() { 1 } else { 0 });

        // For boundary cells, record the majority neighbour plate. Tally each
        // unique neighbour plate id; pick whichever has the most votes.
        let mut on_boundary = false;
        let mut neighbour_counts: [(i32, u32); 6] = [(-1, 0); 6];
        let mut n_neighbour_kinds = 0;
        for &nb in model.grid.neighbours(fid) {
            let np = model.fields[nb as usize].plate_id;
            if np != my_plate {
                on_boundary = true;
                let id = match np { Some(p) => p as i32, None => -1 };
                let mut found = false;
                for i in 0..n_neighbour_kinds {
                    if neighbour_counts[i].0 == id {
                        neighbour_counts[i].1 += 1;
                        found = true;
                        break;
                    }
                }
                if !found && n_neighbour_kinds < 6 {
                    neighbour_counts[n_neighbour_kinds] = (id, 1);
                    n_neighbour_kinds += 1;
                }
            }
        }
        cell_is_boundary.push(if on_boundary { 1 } else { 0 });
        let mut best = -1i32;
        let mut best_count = 0u32;
        for i in 0..n_neighbour_kinds {
            let (id, c) = neighbour_counts[i];
            if c > best_count || (c == best_count && id >= 0 && id < best) {
                best = id;
                best_count = c;
            }
        }
        cell_neighbor_plate.push(best);

        cell_slope.push(compute_slope(model, fid));
        cell_latitude_band.push(latitude_band(p));
        cell_age_ma.push(f.age);
        cell_crust_thickness_km.push(f.crust_thickness());
        cell_volcanic_intensity.push(
            if f.volcanic_activity.is_some() { 1.0 } else { 0.0 }
        );
        cell_collision_kind.push(collision_kind(f));
        cell_subduction_progress.push(
            f.subduction.as_ref().map(|s| s.progress()).unwrap_or(0.0)
        );
        cell_is_continent_buffer.push(if f.is_continent_buffer { 1 } else { 0 });
        cell_orogenic_uplift.push(f.orogenic_uplift);
        cell_mor_age_steps.push(f.mor_age_steps);
    }

    let cf = crate::climate::compute_climate(model, model.master_seed, want_climate_debug);
    let climate_debug = match cf.debug {
        Some(d) => ClimateDebugWire {
            insolation: d.insolation, base_temp: d.base_temp,
            dist_to_ocean: d.dist_to_ocean, wind: d.wind,
            current_dt: d.current_dt, orographic: d.orographic,
            continental_dry: d.continental_dry,
        },
        None => ClimateDebugWire::default(),
    };

    PlanetSnapshot {
        divisions,
        n_cells,
        sim_time_ma: model.sim_time_ma,
        cell_positions,
        cell_plate_ids,
        cell_elevation,
        cell_continental,
        cell_is_boundary,
        cell_neighbor_plate,
        cell_slope,
        cell_latitude_band,
        cell_age_ma,
        cell_crust_thickness_km,
        cell_volcanic_intensity,
        cell_collision_kind,
        cell_subduction_progress,
        cell_is_continent_buffer,
        cell_orogenic_uplift,
        cell_mor_age_steps,
        cell_temperature: cf.temperature,
        cell_precip: cf.precip,
        cell_biome: cf.biome,
        cell_biome2: cf.biome2,
        cell_biome_blend: cf.biome_blend,
        cell_seed: cf.cell_seed,
        climate_debug,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_bake_produces_expected_shape() {
        let snap = bake_demo();
        assert_eq!(snap.n_cells, 40962, "d=64 → 10*64²+2");
        assert_eq!(snap.cell_positions.len() as u32, snap.n_cells * 3);
        assert_eq!(snap.cell_plate_ids.len() as u32, snap.n_cells);

        let mut distinct: Vec<i32> = snap.cell_plate_ids.iter().copied().collect();
        distinct.sort();
        distinct.dedup();
        // Expect at least 4 distinct plate ids (some plates may merge).
        assert!(distinct.iter().filter(|&&x| x >= 0).count() >= 4, "got {:?}", distinct);

        assert_eq!(snap.cell_slope.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_latitude_band.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_age_ma.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_crust_thickness_km.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_volcanic_intensity.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_collision_kind.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_subduction_progress.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_is_continent_buffer.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_orogenic_uplift.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_mor_age_steps.len() as u32, snap.n_cells);
    }

    #[test]
    fn snapshot_has_climate_fields() {
        let snap = bake_demo();
        let n = snap.n_cells as usize;
        assert_eq!(snap.cell_temperature.len(), n);
        assert_eq!(snap.cell_precip.len(), n);
        assert_eq!(snap.cell_biome.len(), n);
        assert_eq!(snap.cell_biome2.len(), n);
        assert_eq!(snap.cell_biome_blend.len(), n);
        assert_eq!(snap.cell_seed.len(), n * 3);
        assert!(snap.cell_biome.iter().all(|&b| (0.0..=9.0).contains(&b)));
    }
}
