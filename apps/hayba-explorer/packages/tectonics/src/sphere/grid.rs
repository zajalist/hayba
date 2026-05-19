//! Grid topology / adjacency for the Voronoi sphere.
//!
//! Port target: tectonic-explorer's `src/plates-model/grid.ts`.
//! Frozen reference: `docs/research/te-snapshot/plates-model/grid.ts`.
//!
//! Wraps [`VoronoiSphere`] and adds:
//!   - cached neighbour lookup
//!   - cached per-field spherical-cap area (km^2 if `earth_area` is supplied;
//!     otherwise unitless steradians-scaled)
//!   - nearest-field-by-point lookup, accelerated by a coarse lat/lon raster
//!     analogous to TE's `VoronoiSphere` raster (the TE class with that name is
//!     actually a kdTree → raster cache, not the icosahedral sphere itself).
//!
//! The raster here is not bit-identical to TE's: we use an internal raster
//! cache *for nearest-field seeds only*, then hill-climb to exactness on the
//! Voronoi dual, so raster dimensions and seed values may differ from TE while
//! the final `nearest_field` answer is exact.

use glam::Vec3;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::voronoi::VoronoiSphere;

/// Mean Earth surface area in km^2. Used so `Grid::field_area(id)` matches
/// `Field.area` in tectonic-explorer (`c.earthArea / getGrid().size`).
pub const EARTH_AREA_KM2: f64 = 510_072_000.0;

/// Mean Earth radius in km (matches TE `constants.earthRadius`).
pub const EARTH_RADIUS_KM: f64 = 6_371.0;

fn empty_flat_positions() -> Arc<OnceLock<Vec<f32>>> {
    Arc::new(OnceLock::new())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grid {
    sphere: VoronoiSphere,
    /// Mean great-circle distance (in unit-sphere radians) between a field and
    /// its neighbours. Matches TE `grid.fieldDiameter`.
    field_diameter: f32,
    /// `field_diameter * EARTH_RADIUS_KM` — useful for sim code expecting km.
    field_diameter_km: f32,
    /// `EARTH_AREA_KM2 / n_fields` — TE's per-field area.
    field_area_km2: f32,
    /// Coarse lat/lon raster: each cell stores the nearest field id at that
    /// grid centre. Used for O(1) nearest-field lookups.
    raster: NearestRaster,
    #[serde(skip, default = "empty_flat_positions")]
    flat_positions: Arc<OnceLock<Vec<f32>>>,
}

impl Grid {
    pub fn new(divisions: u32) -> Self {
        Self::from_sphere(VoronoiSphere::new(divisions))
    }

    pub fn from_sphere(sphere: VoronoiSphere) -> Self {
        let field_diameter = calc_field_diameter(&sphere);
        let field_diameter_km = field_diameter * EARTH_RADIUS_KM as f32;
        let field_area_km2 = (EARTH_AREA_KM2 / sphere.n_fields() as f64) as f32;
        let raster = NearestRaster::build(&sphere);
        Self {
            sphere,
            field_diameter,
            field_diameter_km,
            field_area_km2,
            raster,
            flat_positions: empty_flat_positions(),
        }
    }

    #[inline]
    pub fn sphere(&self) -> &VoronoiSphere {
        &self.sphere
    }

    #[inline]
    pub fn divisions(&self) -> u32 {
        self.sphere.divisions()
    }

    #[inline]
    pub fn n_fields(&self) -> u32 {
        self.sphere.n_fields()
    }

    #[inline]
    pub fn position(&self, field_id: u32) -> Vec3 {
        self.sphere.position(field_id)
    }

    #[inline]
    pub fn neighbours(&self, field_id: u32) -> &[u32] {
        self.sphere.neighbours(field_id)
    }

    /// Number of adjacent fields (5 for the 12 pentagon fields, 6 otherwise).
    #[inline]
    pub fn neighbour_count(&self, field_id: u32) -> usize {
        self.sphere.neighbours(field_id).len()
    }

    /// Mean spacing between adjacent fields, in unit-sphere distance.
    #[inline]
    pub fn field_diameter(&self) -> f32 {
        self.field_diameter
    }

    #[inline]
    pub fn field_diameter_km(&self) -> f32 {
        self.field_diameter_km
    }

    /// Per-field surface area (km^2), uniform across the sphere — matches TE.
    #[inline]
    pub fn field_area_km2(&self) -> f32 {
        self.field_area_km2
    }

    /// Nearest-field id for a 3D point. The point is normalised; this is
    /// O(1) thanks to the lat/lon raster, with a final refinement step that
    /// walks the cell's candidate field plus its neighbours to ensure that
    /// the returned id is the true closest field.
    pub fn nearest_field(&self, point: Vec3) -> u32 {
        let p = if point.length_squared() > 0.0 {
            point.normalize()
        } else {
            Vec3::Y
        };
        let seed = self.raster.lookup(p);
        // Refine: hill-climb to the actual closest field. Because the raster
        // resolution is comparable to the field spacing, the seed is at most a
        // few hops away from the true nearest.
        self.refine_nearest(seed, p)
    }

    fn refine_nearest(&self, seed: u32, p: Vec3) -> u32 {
        let mut best = seed;
        let mut best_d2 = (self.sphere.position(best) - p).length_squared();
        loop {
            let mut improved = None;
            for &nb in self.sphere.neighbours(best) {
                let d2 = (self.sphere.position(nb) - p).length_squared();
                if d2 < best_d2 {
                    best_d2 = d2;
                    improved = Some(nb);
                }
            }
            match improved {
                Some(nb) => best = nb,
                None => return best,
            }
        }
    }

    /// Lazy flat XYZ position buffer `[x0,y0,z0, x1,y1,z1, …]` built
    /// once per `Grid` instance via `OnceLock`. Reused across IPC calls
    /// when `Grid` is cached by `Grid::for_divisions`. Length = `3 *
    /// n_fields()`.
    pub fn flat_positions(&self) -> &[f32] {
        self.flat_positions.get_or_init(|| {
            let n = self.n_fields();
            let mut v = Vec::with_capacity((n as usize) * 3);
            for fid in 0..n {
                let p = self.position(fid);
                v.push(p.x);
                v.push(p.y);
                v.push(p.z);
            }
            v
        })
    }
}

fn calc_field_diameter(sphere: &VoronoiSphere) -> f32 {
    // TE uses field id 3 and averages distance-to-neighbour. We do the same.
    let field = 3u32;
    let p = sphere.position(field);
    let nbrs = sphere.neighbours(field);
    let mut sum = 0.0_f32;
    for &nb in nbrs {
        sum += (p - sphere.position(nb)).length();
    }
    sum / (nbrs.len() as f32)
}

// ---------------------------------------------------------------------------
// Nearest-field raster (analogous to TE's VoronoiSphere class, which is a
// raster cache over a kd-tree). We build it directly from the icosahedral
// adjacency by hill-climbing from a global seed for each cell.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NearestRaster {
    lat_min: f64,
    lat_range: f64,
    lat_num: u32,
    lon_min: f64,
    lon_range: f64,
    lon_num: u32,
    /// Field ids, row-major: `[i * lon_num + j]`.
    cells: Vec<u32>,
}

impl NearestRaster {
    fn build(sphere: &VoronoiSphere) -> Self {
        use std::f64::consts::PI;
        // Match TE: lat_num = sqrt(n), lon_num = 2 * sqrt(n). Round to int.
        // TE multiplies by 5 in some configs; we follow the un-multiplied form
        // because we hill-climb to refine.
        let n = sphere.n_fields() as f64;
        let size = n.sqrt();
        let lat_num = size.round() as u32;
        let lon_num = (2.0 * size).round() as u32;
        let lat_min = -PI / 2.0;
        let lat_range = PI;
        let lon_min = -PI;
        let lon_range = 2.0 * PI;

        let mut cells = vec![0u32; (lat_num * lon_num) as usize];
        // Seed by hill-climbing from the previous cell's answer along the row,
        // and from the previous row's first cell to start each row. This is
        // deterministic and avoids any RNG.
        let mut row_seed = 0u32;
        for i in 0..lat_num {
            let lat = (i as f64) * lat_range / (lat_num as f64) + lat_min;
            let mut col_seed = row_seed;
            for j in 0..lon_num {
                let lon = (j as f64) * lon_range / (lon_num as f64) + lon_min;
                let pt = lat_lon_to_unit(lat, lon);
                col_seed = hill_climb(sphere, col_seed, pt);
                cells[(i * lon_num + j) as usize] = col_seed;
                if j == 0 {
                    row_seed = col_seed;
                }
            }
        }
        Self {
            lat_min,
            lat_range,
            lat_num,
            lon_min,
            lon_range,
            lon_num,
            cells,
        }
    }

    fn lookup(&self, unit_point: Vec3) -> u32 {
        let y = (unit_point.y as f64).clamp(-1.0, 1.0);
        let lat = y.asin();
        let lon = (unit_point.z as f64).atan2(unit_point.x as f64);
        let mut i = (lat - self.lat_min) * (self.lat_num as f64) / self.lat_range;
        i = i.clamp(0.0, (self.lat_num - 1) as f64);
        let mut j = (lon - self.lon_min) * (self.lon_num as f64) / self.lon_range;
        j = j.clamp(0.0, (self.lon_num - 1) as f64);
        let ii = i.round() as u32;
        let jj = j.round() as u32;
        self.cells[(ii * self.lon_num + jj) as usize]
    }
}

fn lat_lon_to_unit(lat: f64, lon: f64) -> Vec3 {
    let cl = lat.cos();
    Vec3::new(
        (cl * lon.cos()) as f32,
        lat.sin() as f32,
        (cl * lon.sin()) as f32,
    )
}

fn hill_climb(sphere: &VoronoiSphere, seed: u32, target: Vec3) -> u32 {
    let mut best = seed;
    let mut best_d2 = (sphere.position(best) - target).length_squared();
    loop {
        let mut improved = None;
        for &nb in sphere.neighbours(best) {
            let d2 = (sphere.position(nb) - target).length_squared();
            if d2 < best_d2 {
                best_d2 = d2;
                improved = Some(nb);
            }
        }
        match improved {
            Some(nb) => best = nb,
            None => return best,
        }
    }
}

// ---------------------------------------------------------------------------
// Process-global Grid cache
// ---------------------------------------------------------------------------

static GRID_CACHE: OnceLock<Mutex<HashMap<u32, Arc<Grid>>>> = OnceLock::new();

fn grid_cache() -> &'static Mutex<HashMap<u32, Arc<Grid>>> {
    GRID_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

impl Grid {
    /// Cached constructor. Returns the shared `Arc<Grid>` for this
    /// `divisions`, building once via `Grid::new` and memoising for
    /// process lifetime. Thread-safe; the actual `Grid::new` runs
    /// OUTSIDE the cache mutex so concurrent cold requests for
    /// different tiers do not serialise.
    pub fn for_divisions(divisions: u32) -> Arc<Grid> {
        // Fast path: lock, look up, clone the Arc.
        {
            let map = grid_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(g) = map.get(&divisions) {
                return Arc::clone(g);
            }
        }
        // Cold path: build OUTSIDE the lock, then double-checked insert.
        let built = Arc::new(Grid::new(divisions));
        let mut map = grid_cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        Arc::clone(map.entry(divisions).or_insert(built))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_field_has_5_or_6_neighbours() {
        let grid = Grid::new(32);
        let n5 = (0..grid.n_fields())
            .filter(|&i| grid.neighbours(i).len() == 5)
            .count();
        let n6 = (0..grid.n_fields())
            .filter(|&i| grid.neighbours(i).len() == 6)
            .count();
        assert_eq!(n5, 12);
        assert_eq!(n5 + n6, grid.n_fields() as usize);
    }

    #[test]
    fn neighbour_relation_is_symmetric() {
        let grid = Grid::new(8);
        for f in 0..grid.n_fields() {
            for &nb in grid.neighbours(f) {
                assert!(grid.neighbours(nb).iter().any(|&x| x == f));
            }
        }
    }

    #[test]
    fn nearest_field_round_trip() {
        let grid = Grid::new(32);
        let last = grid.n_fields() - 1;
        for f in [0, 100, 5000, last] {
            let pos = grid.position(f);
            let back = grid.nearest_field(pos);
            assert_eq!(back, f, "round-trip failed for field {}", f);
        }
    }

    #[test]
    fn nearest_field_round_trip_all() {
        // Exhaustive at low resolution: every field must round-trip.
        let grid = Grid::new(8);
        for f in 0..grid.n_fields() {
            let back = grid.nearest_field(grid.position(f));
            assert_eq!(back, f, "round-trip failed for field {}", f);
        }
    }

    #[test]
    fn field_diameter_positive_and_reasonable() {
        let grid = Grid::new(32);
        // Field diameter should be on the order of 2π / (sqrt(n_fields)).
        let fd = grid.field_diameter();
        assert!(fd > 0.0);
        assert!(fd < 0.5, "field_diameter unexpectedly large: {}", fd);
    }

    #[test]
    fn field_area_matches_te() {
        let grid = Grid::new(32);
        let expected = (EARTH_AREA_KM2 / grid.n_fields() as f64) as f32;
        assert!((grid.field_area_km2() - expected).abs() < 1e-3);
    }

    #[test]
    #[ignore = "perf/memory benchmark — run with --release --ignored"]
    fn bench_divisions_128_build() {
        let t0 = std::time::Instant::now();
        let grid = Grid::new(128);
        let dt = t0.elapsed();
        assert_eq!(grid.n_fields(), 163_842);
        // Approximate allocation footprint of the heap data the grid owns.
        let sphere = grid.sphere();
        let pos_bytes = sphere.positions().len() * std::mem::size_of::<Vec3>();
        let tri_bytes = sphere.triangles().len() * std::mem::size_of::<u32>();
        let nbr_bytes = (sphere.n_fields() as usize + 1) * 4
            + (sphere.n_fields() as usize * 6) * 4; // upper bound
        let raster_bytes = grid.raster.cells.len() * 4;
        let total = pos_bytes + tri_bytes + nbr_bytes + raster_bytes;
        eprintln!(
            "Grid::new(128): build={:.3}s, positions={}B, triangles={}B, neighbours≈{}B, raster={}B, total≈{:.2}MB",
            dt.as_secs_f64(),
            pos_bytes,
            tri_bytes,
            nbr_bytes,
            raster_bytes,
            total as f64 / 1_048_576.0
        );
    }

    #[test]
    fn pentagon_hexagon_count_at_multiple_divisions() {
        // Peels assumes d>=2, so we skip d=1.
        for &d in &[2u32, 8, 32, 128] {
            let grid = Grid::new(d);
            let n5 = (0..grid.n_fields())
                .filter(|&i| grid.neighbours(i).len() == 5)
                .count();
            assert_eq!(n5, 12, "d={}: expected 12 pentagons, got {}", d, n5);
        }
    }

    #[test]
    fn nearest_field_round_trip_pentagons() {
        let grid = Grid::new(32);
        // The 12 pentagon fields by construction.
        let pentagon_ids: Vec<u32> = (0..grid.n_fields() as u32)
            .filter(|&i| grid.neighbours(i).len() == 5)
            .collect();
        assert_eq!(pentagon_ids.len(), 12);
        for &p in &pentagon_ids {
            let pos = grid.position(p);
            let back = grid.nearest_field(pos);
            assert_eq!(back, p, "pentagon field {} did not round-trip", p);
        }
    }

    #[test]
    fn determinism_two_grids_match() {
        let a = Grid::new(16);
        let b = Grid::new(16);
        for f in 0..a.n_fields() {
            assert_eq!(a.position(f), b.position(f));
            assert_eq!(a.neighbours(f), b.neighbours(f));
        }
        assert_eq!(a.field_diameter(), b.field_diameter());
    }
}
