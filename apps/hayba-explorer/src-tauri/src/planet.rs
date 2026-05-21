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

use crate::climate::ClimateParams;

const DEMO_DIVISIONS: u32 = 64;
const DEMO_STEPS: u32 = 5;
const DEMO_DT_MA: f32 = 0.5;
const DEMO_SEED: u64 = 42;

/// Per-tick minimal snapshot — the ONLY data that meaningfully changes each
/// sim step at the visual level: where each cell is (positions rotate with
/// the plate) and how high it is (elevation changes via orogeny/subduction).
/// Skips the full ~17-array PlanetSnapshot + the entire `compute_climate`
/// pass which dominates per-tick cost.
#[derive(Serialize)]
pub struct TickSnapshot {
    pub sim_time_ma: f32,
    pub n_cells: u32,
    pub cell_positions: Vec<f32>,
    pub cell_elevation: Vec<f32>,
}

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
    /// Per-cell 10-wide biome weight vector (length `n_cells * 10`,
    /// row-major). Neighbour-diffused so the GPU interpolates fixed biome
    /// SLOTS' weights across each triangle → no hexagonal biome facets.
    pub cell_biome_weights: Vec<f32>,
    /// Coarse, smoothed SIGNED geodesic distance to the land/sea boundary,
    /// normalized so ~1.0 ≈ one cell spacing. Positive on land, negative in
    /// ocean (length = `n_cells`). The shader displaces this smooth field
    /// with multi-octave noise to produce a sub-cell organic coastline that
    /// no longer traces the hexagonal cell tessellation.
    pub cell_coast_sdf: Vec<f32>,
    /// Per-cell STABLE pseudo-random unit vec3 (length = `n_cells * 3`),
    /// keyed on the immutable cell index. The shader keys its within-biome
    /// surface texture noise on this so the texture rides with the drifting
    /// crust instead of crawling through a world-locked noise field.
    pub cell_seed: Vec<f32>,
    /// Coarse-graph drainage area per cell, normalized 0..1 by global max.
    /// Computed from the (already-eroded) bake elevation — the snapshot does
    /// NOT re-erode the persistent model; it only routes flow on the final
    /// surface (iterations:0).
    pub cell_drainage: Vec<f32>,
    /// River mask 0..1: 1 where drainage area exceeds the erosion-params
    /// `river_threshold` fraction of the global max, with a soft edge.
    pub cell_river: Vec<f32>,
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
            model.apply_field_initial_state(fid as usize, -0.3, false);
            model.assign_field_to_plate(fid as usize, pid);
        }
    }

    // Refresh inertia after the ocean fill.
    model.refresh_plate_inertias();

    // Run a short step loop so plates start moving.
    for _ in 0..DEMO_STEPS {
        model.step(DEMO_DT_MA);
    }

    let snap = snapshot_model(&model, DEMO_DIVISIONS, true, &ClimateParams::default());
    snap
}

// 1.0 normalized elevation unit ≈ 8 km of real relief — matches the
// shader/climate `elev_km_scale` so slope is in true terrain units.
const ELEV_KM: f32 = 8.0;
// Sphere radius used to turn the unit-sphere chord between cell centroids
// into a real horizontal run (km).
const EARTH_RADIUS_KM: f32 = 6371.0;
// Maps the dimensionless mean rise/run gradient into [0, 1]. Calibration:
// at div-64 the cell run is ~111 km; a full 1.0-elevation (≈8 km) drop
// across one cell is ≈ 0.072 rise/run, so ×7 ≈ 0.5 — genuine mountain
// relief lands mid/high while gentle plains stay low. Graded, not binary.
const SLOPE_GAIN: f32 = 7.0;

/// Pure mapping from a mean rise/run gradient to a graded [0, 1] slope.
/// Linear-with-gain then clamped (not a hard clamp of a huge number), so
/// the output is monotonic in the gradient and spans ~0..1 across
/// plains→mountains instead of saturating at 1.
fn grade_slope(mean_g: f32) -> f32 {
    (mean_g * SLOPE_GAIN).clamp(0.0, 1.0)
}

/// True tangential surface-gradient (rise-over-run) slope, normalized to
/// [0, 1]. For each same-side neighbour the vertical rise (km) is divided
/// by the horizontal run (km, the great-circle chord between cell centroids
/// scaled by Earth's radius); the MEAN of those per-neighbour gradients is
/// mapped through `grade_slope`. Mean (not max) avoids the spiky saturation
/// of the old max-delta×20 heuristic and yields a smooth graded field.
/// Neighbour pairs that straddle sea level are skipped so a land/ocean step
/// (a coastline) does not manufacture a false steep cliff — slope reflects
/// terrain steepness within land (or within ocean), not the shoreline jump.
fn compute_slope(model: &hayba_tectonics_v2::model::Model, fid: u32) -> f32 {
    // Sea level is 0.0; elevation sign distinguishes land from ocean.
    fn same_side(a: f32, b: f32) -> bool { (a >= 0.0) == (b >= 0.0) }
    let here = model.fields[fid as usize].elevation;
    let here_pos = model.grid.position(fid);
    let mut sum_g = 0.0_f32;
    let mut count = 0u32;
    for &nb in model.grid.neighbours(fid) {
        let there = model.fields[nb as usize].elevation;
        if !same_side(here, there) { continue; } // skip the coastline cliff
        // Vertical rise in real km (sign-free: steepness, not aspect).
        let dh_km = (there - here).abs() * ELEV_KM;
        // Horizontal run in km: unit-sphere chord × Earth radius.
        let run_km = here_pos.distance(model.grid.position(nb)) * EARTH_RADIUS_KM;
        if run_km <= 1e-4 { continue; }
        sum_g += dh_km / run_km; // dimensionless rise/run
        count += 1;
    }
    if count == 0 { return 0.0; }
    grade_slope(sum_g / count as f32)
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

/// Build a minimal `TickSnapshot` — positions + elevation only. Used per
/// rAF frame during the simulate loop. Climate/biomes/slope/age don't
/// change visibly tick-to-tick; they refresh from the full `snapshot_model`
/// path on pause/stop or panel changes.
pub fn tick_snapshot_model(model: &Model) -> TickSnapshot {
    let n_cells = model.grid.n_fields();
    let mut cell_positions: Vec<f32> = Vec::with_capacity((n_cells * 3) as usize);
    let mut cell_elevation: Vec<f32> = Vec::with_capacity(n_cells as usize);
    // Build a plate-id → quaternion lookup once, so per-cell rotation is an
    // O(1) hashmap probe instead of an O(P) linear scan. P is small (≤16
    // typically) but n_cells can be 1.5M, so the saving matters.
    let plate_q: std::collections::HashMap<u32, glam::Quat> = model
        .plates
        .iter()
        .map(|p| (p.id, p.quaternion))
        .collect();
    let identity = glam::Quat::IDENTITY;
    for fid in 0..n_cells {
        let local = model.grid.position(fid);
        // Apply the cell's plate's accumulated rotation. Cells with no plate
        // (None) stay at their base icosphere position. Without this step
        // model.step() advanced sim_time + plate quaternions but the rendered
        // cell positions never moved → plates appeared frozen.
        let f = &model.fields[fid as usize];
        let q = match f.plate_id {
            Some(pid) => plate_q.get(&pid).copied().unwrap_or(identity),
            None => identity,
        };
        let world = q * local;
        cell_positions.push(world.x);
        cell_positions.push(world.y);
        cell_positions.push(world.z);
        cell_elevation.push(f.elevation);
    }
    TickSnapshot {
        sim_time_ma: model.sim_time_ma,
        n_cells,
        cell_positions,
        cell_elevation,
    }
}

/// Build a `PlanetSnapshot` from a stepped model. Boundary detection matches
/// TE: a cell is on the boundary if any of its neighbours belong to a
/// different plate (see `tectonic-explorer/.../plate.ts` boundary scan).
pub fn snapshot_model(
    model: &Model,
    divisions: u32,
    want_climate_debug: bool,
    climate_params: &ClimateParams,
) -> PlanetSnapshot {
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

    // Plate-id → quaternion lookup. Required to map each cell's BASE icosphere
    // position into its current WORLD position (i.e. rotated by the plate's
    // accumulated quaternion from sim time = 0 to now). Without applying this
    // rotation, `cell_positions` stays at the bake-time icosphere coordinates
    // forever and plates appear motionless in the simulate phase.
    let plate_q: std::collections::HashMap<u32, glam::Quat> = model
        .plates
        .iter()
        .map(|p| (p.id, p.quaternion))
        .collect();
    let identity = glam::Quat::IDENTITY;

    for fid in 0..n_cells {
        let local = model.grid.position(fid);
        let f = &model.fields[fid as usize];
        let my_plate = f.plate_id;
        let q = match my_plate {
            Some(pid) => plate_q.get(&pid).copied().unwrap_or(identity),
            None => identity,
        };
        let p = q * local;
        cell_positions.push(p.x);
        cell_positions.push(p.y);
        cell_positions.push(p.z);
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

    // Relax the per-cell slope so the Slope map mode / rock mask read as a
    // smooth field instead of tracing the hexagonal cell tessellation.
    for _ in 0..2 {
        let prev = cell_slope.clone();
        for fid in 0..n_cells {
            let nbs = model.grid.neighbours(fid);
            if nbs.is_empty() { continue; }
            let mut acc = 0.0_f32;
            for &nb in nbs { acc += prev[nb as usize]; }
            let mean = acc / nbs.len() as f32;
            cell_slope[fid as usize] = 0.5 * prev[fid as usize] + 0.5 * mean;
        }
    }

    // Coarse signed coastline distance field. Multi-source Dijkstra of
    // geodesic (chord-summed) distance from every land/sea-boundary cell,
    // then sign by side, smooth the zero-crossing, and normalize to cell
    // units. The shader displaces this smooth field with fbm to give a
    // sub-cell organic shoreline instead of the hex tessellation.
    let cell_coast_sdf: Vec<f32> = {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;

        let n = n_cells as usize;
        let is_ocean: Vec<bool> = (0..n_cells)
            .map(|fid| model.fields[fid as usize].elevation < 0.0)
            .collect();

        // Dijkstra: a cell is a source (dist 0) if any neighbour sits on the
        // opposite side of sea level. Edge weight = Cartesian centroid
        // distance. f32 ordered via to_bits (valid: all weights are
        // non-negative finite, so the bit pattern orders numerically).
        let mut dist = vec![f32::INFINITY; n];
        let mut heap: BinaryHeap<Reverse<(u32, u32)>> = BinaryHeap::new();
        for fid in 0..n_cells {
            let i = fid as usize;
            let is_source = model
                .grid
                .neighbours(fid)
                .iter()
                .any(|&nb| is_ocean[nb as usize] != is_ocean[i]);
            if is_source {
                dist[i] = 0.0;
                heap.push(Reverse((0.0_f32.to_bits(), fid)));
            }
        }
        while let Some(Reverse((d_bits, fid))) = heap.pop() {
            let i = fid as usize;
            let d = f32::from_bits(d_bits);
            if d > dist[i] {
                continue; // stale heap entry
            }
            let p = model.grid.position(fid);
            for &nb in model.grid.neighbours(fid) {
                let j = nb as usize;
                let w = p.distance(model.grid.position(nb));
                let nd = d + w;
                if nd < dist[j] {
                    dist[j] = nd;
                    heap.push(Reverse((nd.to_bits(), nb)));
                }
            }
        }

        // Sign it: ocean negative, land positive. (Isolated all-one-side
        // models leave dist = INFINITY; guard to keep values finite.)
        let mut sdf: Vec<f32> = (0..n)
            .map(|i| {
                let d = if dist[i].is_finite() { dist[i] } else { 0.0 };
                if is_ocean[i] { -d } else { d }
            })
            .collect();

        // Smooth the zero-crossing — 4 Laplacian passes, mirroring the
        // slope-relaxation block above.
        for _ in 0..4 {
            let prev = sdf.clone();
            for fid in 0..n_cells {
                let nbs = model.grid.neighbours(fid);
                if nbs.is_empty() {
                    continue;
                }
                let mut acc = 0.0_f32;
                for &nb in nbs {
                    acc += prev[nb as usize];
                }
                let mean = acc / nbs.len() as f32;
                sdf[fid as usize] = 0.5 * prev[fid as usize] + 0.5 * mean;
            }
        }

        // Normalize to cell units: divide by the average per-cell mean
        // neighbour spacing so ~1.0 ≈ one cell.
        let mut spacing_acc = 0.0_f64;
        let mut spacing_n = 0u64;
        for fid in 0..n_cells {
            let p = model.grid.position(fid);
            let nbs = model.grid.neighbours(fid);
            if nbs.is_empty() {
                continue;
            }
            let mut acc = 0.0_f32;
            for &nb in nbs {
                acc += p.distance(model.grid.position(nb));
            }
            spacing_acc += (acc / nbs.len() as f32) as f64;
            spacing_n += 1;
        }
        let cell_spacing = if spacing_n > 0 {
            (spacing_acc / spacing_n as f64) as f32
        } else {
            1.0
        };
        let inv = if cell_spacing > 0.0 { 1.0 / cell_spacing } else { 1.0 };
        for v in sdf.iter_mut() {
            *v *= inv;
        }
        sdf
    };

    // ── Coarse-graph macro hydrology (drainage + river of the FINAL surface)
    // Bake already eroded `model.fields[i].elevation`; we must NOT erode the
    // persistent model again here. Clone the current elevation into a
    // throwaway buffer and route flow with iterations:0 — `compute_hydrology`
    // then only depression-fills + accumulates drainage / river on that final
    // surface, leaving the model untouched.
    let (cell_drainage, cell_river) = {
        let neighbours: Vec<Vec<u32>> = (0..n_cells)
            .map(|fid| model.grid.neighbours(fid).to_vec())
            .collect();
        let pos: Vec<Vec3> = (0..n_cells).map(|fid| model.grid.position(fid)).collect();
        let elev_vec: Vec<f32> = (0..n_cells)
            .map(|fid| model.fields[fid as usize].elevation)
            .collect();
        let is_ocean: Vec<bool> = elev_vec.iter().map(|&e| e < 0.0).collect();
        let mut e = elev_vec.clone();
        let hyd = crate::hydrology::compute_hydrology(
            &neighbours,
            &pos,
            &mut e,
            &is_ocean,
            model.grid.field_area_km2(),
            &crate::hydrology::ErosionParams {
                iterations: 0,
                ..Default::default()
            },
        );
        (hyd.drainage, hyd.river)
    };

    let cf = crate::climate::compute_climate(
        model,
        model.master_seed,
        want_climate_debug,
        climate_params,
    );
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
        cell_biome_weights: cf.biome_weights,
        cell_coast_sdf,
        cell_seed: cf.cell_seed,
        cell_drainage,
        cell_river,
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
        assert_eq!(snap.cell_biome_weights.len(), n * 10);
        assert_eq!(snap.cell_coast_sdf.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_seed.len(), n * 3);
        assert!(snap.cell_biome.iter().all(|&b| (0.0..=9.0).contains(&b)));
    }

    #[test]
    fn snapshot_has_hydrology_fields() {
        let snap = bake_demo();
        assert_eq!(snap.cell_drainage.len() as u32, snap.n_cells);
        assert_eq!(snap.cell_river.len() as u32, snap.n_cells);
        assert!(
            snap.cell_drainage.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)),
            "drainage must be finite and in [0,1]"
        );
        assert!(
            snap.cell_river.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)),
            "river mask must be finite and in [0,1]"
        );
    }

    #[test]
    fn coast_sdf_signed_and_finite() {
        let snap = bake_demo();
        let n = snap.n_cells as usize;
        assert_eq!(snap.cell_coast_sdf.len(), n);
        assert!(
            snap.cell_coast_sdf.iter().all(|&v| v.is_finite()),
            "coast SDF must be finite everywhere"
        );
        // The demo model seeds continental blobs (land) AND oceanic fill
        // (elevation -0.3), so a real coastline exists: expect both a
        // negative (ocean) and a positive (land) signed value. If the demo
        // were ever all-ocean, fall back to "all finite & all <= 0".
        let has_neg = snap.cell_coast_sdf.iter().any(|&v| v < 0.0);
        let has_pos = snap.cell_coast_sdf.iter().any(|&v| v > 0.0);
        if has_pos {
            assert!(
                has_neg,
                "land present → ocean must be too (signed coastline)"
            );
        } else {
            assert!(
                snap.cell_coast_sdf.iter().all(|&v| v <= 0.0),
                "all-ocean model → every SDF value must be <= 0"
            );
        }
    }

    #[test]
    fn slope_field_is_smooth_and_bounded() {
        let snap = bake_demo();
        let n = snap.n_cells as usize;
        // Length matches the cell count.
        assert_eq!(snap.cell_slope.len(), n);
        // Every value is finite and in [0, 1].
        assert!(
            snap.cell_slope.iter().all(|&s| s.is_finite() && (0.0..=1.0).contains(&s)),
            "slope must be finite and in [0,1]"
        );
        // Sanity: with the coastline cliff suppressed the field is no longer
        // pinned to 1.0 everywhere (old bug saturated every coastal cell), so
        // the global max stays well under 1.0 on the demo model and the mean
        // never exceeds it.
        let max = snap.cell_slope.iter().copied().fold(0.0_f32, f32::max);
        let mean = snap.cell_slope.iter().sum::<f32>() / n as f32;
        assert!(max < 1.0, "global max {max} must not be pinned to 1.0");
        assert!(mean <= max, "mean {mean} should not exceed global max {max}");
    }

    #[test]
    fn slope_is_graded_not_saturated() {
        // Demo snapshot: every value finite and in [0, 1], and the field is
        // not pinned to 1.0 (no binary saturation).
        let snap = bake_demo();
        assert!(
            snap.cell_slope.iter().all(|&s| s.is_finite() && (0.0..=1.0).contains(&s)),
            "slope must be finite and in [0,1]"
        );
        let max = snap.cell_slope.iter().copied().fold(0.0_f32, f32::max);
        assert!(max < 1.0, "graded slope must not saturate at 1.0 (got {max})");

        // The gradient→slope mapping is graded/monotonic, not pinned to 1:
        // a gentle gradient yields a strictly smaller slope than a steep one,
        // and both stay within bounds.
        let gentle = grade_slope(0.005); // ~0.04 rise/run-ish, gentle plain
        let steep = grade_slope(0.072); // ~1.0 elev over one div-64 cell
        let steeper = grade_slope(0.5); // beyond mountain relief → clamps
        assert!(
            gentle < steep,
            "gentle gradient ({gentle}) must be < steep ({steep}) — graded"
        );
        assert!(
            (0.0..=1.0).contains(&gentle) && (0.0..=1.0).contains(&steep),
            "mapped slopes must stay in [0,1]"
        );
        assert!(gentle > 0.0, "a real gradient must lift slope above 0");
        assert!(steep < 1.0, "mid mountain relief must not be pinned to 1.0");
        assert!(
            (steeper - 1.0).abs() < 1e-6,
            "extreme gradient clamps to 1.0 (got {steeper})"
        );
    }

    /// Regression test for the plate-rotation bug: model.step() advances
    /// each plate's quaternion, but if tick_snapshot_model returns
    /// grid.position(fid) directly (the immutable icosphere coordinate),
    /// the JS side never sees plates move. The fix applies
    /// plate.quaternion to each cell's grid.position before serializing.
    ///
    /// Uses bake_demo() as the fixture (real plates, real omegas) then
    /// steps it and verifies snapshot positions move.
    #[test]
    fn tick_snapshot_positions_move_with_plate_rotation() {
        // Build the same model bake_demo builds, but keep a handle so we
        // can call tick_snapshot_model + step. Inline the minimal subset:
        let mut model = hayba_tectonics_v2::model::Model::new(DEMO_DIVISIONS, DEMO_SEED);
        // Mirror bake_demo's plate seeding (omitting elevation/painting
        // detail since we only care about position rotation).
        for pid in 0..4u32 {
            let centre_fid = (pid as usize * 7919) % (model.grid.n_fields() as usize);
            let mut members: Vec<u32> = Vec::new();
            members.push(centre_fid as u32);
            for &n in model.grid.neighbours(centre_fid as u32) {
                members.push(n);
            }
            let omega = Vec3::new(
                (pid as f32 * 0.7).sin() * 0.02,
                ((pid + 1) as f32 * 0.5).cos() * 0.02,
                (pid as f32 * 1.1).sin() * 0.02,
            );
            // Mark members as plate-assigned in the fields vec.
            for &fid in &members {
                model.fields[fid as usize].plate_id = Some(pid);
            }
            model.add_plate(pid, pid, 3.0, &members, pid % 2 == 0, omega);
        }

        let snap_before = tick_snapshot_model(&model);
        for _ in 0..DEMO_STEPS {
            model.step(DEMO_DT_MA);
        }
        let snap_after = tick_snapshot_model(&model);

        // At least one cell on a non-zero-omega plate must have moved.
        let mut max_dx: f32 = 0.0;
        let n_pos = (snap_before.cell_positions.len() / 3) as u32;
        for i in 0..n_pos {
            let dx = snap_after.cell_positions[(i * 3) as usize]
                - snap_before.cell_positions[(i * 3) as usize];
            let dy = snap_after.cell_positions[(i * 3 + 1) as usize]
                - snap_before.cell_positions[(i * 3 + 1) as usize];
            let dz = snap_after.cell_positions[(i * 3 + 2) as usize]
                - snap_before.cell_positions[(i * 3 + 2) as usize];
            let d = (dx * dx + dy * dy + dz * dz).sqrt();
            if d > max_dx { max_dx = d; }
        }
        assert!(
            max_dx > 1e-4,
            "expected at least one cell to drift after plate rotation, got max_dx = {max_dx}"
        );
    }
}
