//! Voronoi sphere built from `peels`-style icosahedral subdivision.
//!
//! Port target: tectonic-explorer's `src/plates-model/voronoi-sphere.ts` plus its
//! underlying `peels` library at `docs/research/te-snapshot/plates-model/peels/`.
//!
//! Field indexing (peels convention):
//!   - id 0: north pole (90° N)
//!   - id 1: south pole (90° S)
//!   - peel s in 0..5, x in 0..2d, y in 0..d:
//!         id = 2 + s * (2*d*d) + x * d + y
//!
//! Field count: `n = 5 * 2 * d * d + 2 = 10*d*d + 2`. For `d = 128` this is
//! `163_842` fields, matching tectonic-explorer's config.
//!
//! Neighbors: every interior field has 6 neighbors (hexagon dual cell); the 12
//! icosahedral vertex fields (2 poles + 5 north-tropical + 5 south-tropical) have
//! 5 neighbors (pentagon).
//!
//! Position convention (matches TE `geo-utils.toCartesian`):
//!   x = cos(lat) * cos(lon)
//!   y = sin(lat)
//!   z = cos(lat) * sin(lon)
//!
//! Determinism note: builds are bit-identical *between Rust runs on the same
//! machine* (no RNG, deterministic iteration order). Positions are produced
//! by truncating f64 spherical interpolation to f32, so they may differ from
//! TE's positions in the last few mantissa bits — TE keeps the values in f64
//! internally. Neighbour ordering and field indexing match peels exactly.
//!
//! Raster note: the higher-level [`crate::sphere::grid::Grid`] keeps an
//! internal raster cache of nearest-field seeds. TE's `voronoi-sphere.ts`
//! raster uses `Uint16Array`, which limits it to ≤65535 fields; ours uses
//! `u32` so it works for `divisions > 90` (≥81 002 fields).

use glam::Vec3;
use serde::{Deserialize, Serialize};

const PEELS: u32 = 5;

/// Spherical arc length between an icosahedral vertex and its neighbour vertex.
/// `L = acos(sqrt(5) / 5)`. Used for placing tropical pentagons.
fn icosahedral_edge_arc() -> f64 {
    (5f64.sqrt() / 5.0).acos()
}

/// Convert (lat, lon) in radians to a unit Vec3 using TE's geo-utils convention.
#[inline]
fn lat_lon_to_unit(lat: f64, lon: f64) -> Vec3 {
    let cl = lat.cos();
    Vec3::new(
        (cl * lon.cos()) as f32,
        lat.sin() as f32,
        (cl * lon.sin()) as f32,
    )
}

/// Icosahedral / geodesic sphere of fields.
///
/// Owns:
///   - per-field positions (unit Vec3)
///   - per-field adjacency (5 or 6 neighbours, CCW-ish ordering matching peels)
///   - triangle index buffer over the dual mesh
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoronoiSphere {
    divisions: u32,
    n_fields: u32,
    positions: Vec<Vec3>,
    /// `neighbour_offsets[i]..neighbour_offsets[i+1]` are the neighbours of field i.
    neighbour_offsets: Vec<u32>,
    neighbours_flat: Vec<u32>,
    /// Triangle index buffer (3 u32 per triangle), built like peels'
    /// `getInterfieldTriangles`. There are `2 * (n_fields - 2)` triangles.
    triangles: Vec<u32>,
}

impl VoronoiSphere {
    /// Build the icosahedral sphere with `divisions` fields along each
    /// icosahedron edge (peels convention; `divisions >= 1`).
    pub fn new(divisions: u32) -> Self {
        assert!(divisions >= 1, "divisions must be >= 1");
        let d = divisions;
        let n = (PEELS * 2 * d * d + 2) as usize;

        // 1. Build adjacency. Each non-polar field gets 5 or 6 entries.
        let mut neighbour_offsets: Vec<u32> = Vec::with_capacity(n + 1);
        let mut neighbours_flat: Vec<u32> = Vec::with_capacity(6 * n);

        for i in 0..(n as u32) {
            neighbour_offsets.push(neighbours_flat.len() as u32);
            let neigh = build_neighbours(i, d);
            neighbours_flat.extend(neigh.iter().copied());
        }
        neighbour_offsets.push(neighbours_flat.len() as u32);

        // 2. Place positions using peels' "interpolate-along-icosahedron-edges,
        //    then column-interpolate" recipe. We work in (lat, lon) radians.
        let mut latlon: Vec<(f64, f64)> = vec![(0.0, 0.0); n];
        populate_positions(&mut latlon, d, &neighbour_offsets, &neighbours_flat);

        let positions: Vec<Vec3> = latlon
            .iter()
            .map(|&(lat, lon)| lat_lon_to_unit(lat, lon))
            .collect();

        // 3. Build triangle index buffer (peels' getInterfieldTriangles).
        //    For each f in 2..n, the first three neighbours form two triangles
        //    [n2, n1, f] and [n3, n2, f].
        let mut triangles = Vec::with_capacity((2 * (n - 2)) * 3);
        for f in 2..n as u32 {
            let off = neighbour_offsets[f as usize] as usize;
            let n1 = neighbours_flat[off];
            let n2 = neighbours_flat[off + 1];
            let n3 = neighbours_flat[off + 2];
            triangles.extend_from_slice(&[n2, n1, f]);
            triangles.extend_from_slice(&[n3, n2, f]);
        }

        Self {
            divisions,
            n_fields: n as u32,
            positions,
            neighbour_offsets,
            neighbours_flat,
            triangles,
        }
    }

    #[inline]
    pub fn divisions(&self) -> u32 {
        self.divisions
    }

    #[inline]
    pub fn n_fields(&self) -> u32 {
        self.n_fields
    }

    #[inline]
    pub fn position(&self, field_id: u32) -> Vec3 {
        self.positions[field_id as usize]
    }

    #[inline]
    pub fn positions(&self) -> &[Vec3] {
        &self.positions
    }

    /// Slice of neighbour ids for `field_id`. Length is 5 or 6.
    #[inline]
    pub fn neighbours(&self, field_id: u32) -> &[u32] {
        let a = self.neighbour_offsets[field_id as usize] as usize;
        let b = self.neighbour_offsets[field_id as usize + 1] as usize;
        &self.neighbours_flat[a..b]
    }

    /// Triangle index buffer (3 * triangle_count entries).
    #[inline]
    pub fn triangles(&self) -> &[u32] {
        &self.triangles
    }
}

// ---------------------------------------------------------------------------
// Peels indexing helpers
// ---------------------------------------------------------------------------

/// peels `get(s, x, y)` → field id.
#[inline]
fn id_of(s: u32, x: u32, y: u32, d: u32) -> u32 {
    s * 2 * d * d + x * d + y + 2
}

/// peels `i2sxy(i, d)`. Returns None for the two poles.
#[inline]
fn sxy_of(i: u32, d: u32) -> Option<(u32, u32, u32)> {
    if i < 2 {
        None
    } else {
        let l = i - 2;
        let x_lim = 2 * d;
        let y_lim = d;
        let s = l / (x_lim * y_lim);
        let rem = l - s * x_lim * y_lim;
        let x = rem / y_lim;
        let y = rem - x * y_lim;
        Some((s, x, y))
    }
}

/// Direct port of `peels/sphere/link.ts`. Returns the adjacency list for field
/// `i` (length 5 for pentagons, 6 for hexagons).
fn build_neighbours(i: u32, d: u32) -> Vec<u32> {
    let max_x = d * 2 - 1;
    let max_y = d - 1;

    if i == 0 {
        return vec![
            id_of(0, 0, 0, d),
            id_of(1, 0, 0, d),
            id_of(2, 0, 0, d),
            id_of(3, 0, 0, d),
            id_of(4, 0, 0, d),
        ];
    }
    if i == 1 {
        return vec![
            id_of(0, max_x, max_y, d),
            id_of(1, max_x, max_y, d),
            id_of(2, max_x, max_y, d),
            id_of(3, max_x, max_y, d),
            id_of(4, max_x, max_y, d),
        ];
    }

    let (s, x, y) = sxy_of(i, d).unwrap();
    let next = (s + 1) % PEELS;
    let prev = (s + PEELS - 1) % PEELS;

    let is_pentagon = (x == d - 1 && y == 0) || (x == max_x && y == 0);

    let mut out: Vec<u32> = Vec::with_capacity(6);

    // 0: northwestern adjacent (x--)
    let a0 = if x > 0 {
        id_of(s, x - 1, y, d)
    } else if y == 0 {
        0 // NORTH
    } else {
        id_of(prev, y - 1, 0, d)
    };
    out.push(a0);

    // 1: western adjacent (x--, y++)
    let a1 = if x == 0 {
        // attach northwestern edge to previous north-northeastern edge
        id_of(prev, y, 0, d)
    } else if y == max_y {
        if x > d {
            id_of(prev, max_x, x - d, d)
        } else {
            id_of(prev, x + d - 1, 0, d)
        }
    } else {
        id_of(s, x - 1, y + 1, d)
    };
    out.push(a1);

    // 2: southwestern adjacent (y++)
    let a2 = if y < max_y {
        id_of(s, x, y + 1, d)
    } else if x == max_x && y == max_y {
        1 // SOUTH
    } else if x >= d {
        id_of(prev, max_x, x - d + 1, d)
    } else {
        id_of(prev, x + d, 0, d)
    };
    out.push(a2);

    if is_pentagon {
        if x == d - 1 {
            // northern tropical pentagon
            out.push(id_of(s, x + 1, 0, d));
            out.push(id_of(next, 0, max_y, d));
        } else if x == max_x {
            // southern tropical pentagon
            out.push(id_of(next, d, max_y, d));
            out.push(id_of(next, d - 1, max_y, d));
        } else {
            unreachable!("pentagon flagged at unexpected sxy");
        }
    } else {
        // 3: southeastern adjacent (x++)
        let a3 = if x == max_x {
            id_of(next, y + d, max_y, d)
        } else {
            id_of(s, x + 1, y, d)
        };
        out.push(a3);

        // 4: eastern adjacent (x++, y--)
        let a4 = if x == max_x {
            id_of(next, y + d - 1, max_y, d)
        } else if y == 0 {
            if x < d {
                id_of(next, 0, x + 1, d)
            } else {
                id_of(next, x - d + 1, max_y, d)
            }
        } else {
            id_of(s, x + 1, y - 1, d)
        };
        out.push(a4);

        // 5: northeastern adjacent (y--)
        let a5 = if y > 0 {
            id_of(s, x, y - 1, d)
        } else if x < d {
            id_of(next, 0, x, d)
        } else {
            id_of(next, x - d, max_y, d)
        };
        out.push(a5);
    }

    out
}

// ---------------------------------------------------------------------------
// Position population (peels/sphere/positions.ts:populate)
// ---------------------------------------------------------------------------

/// Spherical great-circle arc interpolation. Populates `buf` with `d - 1`
/// evenly-spaced (lat, lon) positions strictly between the two endpoints.
/// Matches `interpolate()` in peels.
fn interpolate(p1: (f64, f64), p2: (f64, f64), d: u32, buf: &mut [(f64, f64)]) {
    let (f1_phi, f1_lam) = p1;
    let (f2_phi, f2_lam) = p2;
    let delta = great_circle_distance(f1_phi, f1_lam, f2_phi, f2_lam);
    let sin_delta = delta.sin();
    for i in 1..d {
        let f = i as f64 / d as f64;
        let a_coef = ((1.0 - f) * delta).sin() / sin_delta;
        let b_coef = (f * delta).sin() / sin_delta;
        let x = a_coef * f1_phi.cos() * f1_lam.cos() + b_coef * f2_phi.cos() * f2_lam.cos();
        let z = a_coef * f1_phi.cos() * f1_lam.sin() + b_coef * f2_phi.cos() * f2_lam.sin();
        let y = a_coef * f1_phi.sin() + b_coef * f2_phi.sin();
        let phi = y.atan2((x * x + z * z).sqrt());
        let lam = z.atan2(x);
        buf[(i - 1) as usize] = (phi, lam);
    }
}

fn great_circle_distance(p1: f64, l1: f64, p2: f64, l2: f64) -> f64 {
    let a = ((p1 - p2) / 2.0).sin().powi(2)
        + p1.cos() * p2.cos() * ((l1 - l2) / 2.0).sin().powi(2);
    2.0 * a.sqrt().asin()
}

fn populate_positions(
    latlon: &mut [(f64, f64)],
    d: u32,
    nbr_off: &[u32],
    nbr_flat: &[u32],
) {
    use std::f64::consts::PI;
    let l_arc = icosahedral_edge_arc();
    let max_x = 2 * d - 1;

    // Polar fields.
    latlon[0] = (PI / 2.0, 0.0);
    latlon[1] = (-PI / 2.0, 0.0);

    // Tropical pentagons.
    for s in 0..PEELS {
        let lam_north = (s as f64) * 2.0 / 5.0 * PI;
        let lam_south = (s as f64) * 2.0 / 5.0 * PI + PI / 5.0;
        latlon[id_of(s, d - 1, 0, d) as usize] = (PI / 2.0 - l_arc, lam_north);
        latlon[id_of(s, max_x, 0, d) as usize] = (-PI / 2.0 + l_arc, lam_south);
    }

    // Edge fields (only when d >= 2).
    if d >= 2 {
        let mut buf = vec![(0.0_f64, 0.0_f64); (d - 1) as usize];
        for s in 0..PEELS {
            let p = (s + 4) % PEELS;
            let sn_p = 0u32; // north pole
            let ss_p = 1u32; // south pole
            let cn_t = id_of(s, d - 1, 0, d);
            let pn_t = id_of(p, d - 1, 0, d);
            let cs_t = id_of(s, max_x, 0, d);
            let ps_t = id_of(p, max_x, 0, d);

            // north pole -> current north tropical pentagon
            interpolate(latlon[sn_p as usize], latlon[cn_t as usize], d, &mut buf);
            for i in 1..d {
                latlon[id_of(s, i - 1, 0, d) as usize] = buf[(i - 1) as usize];
            }
            // current north tropical pentagon -> previous north tropical pentagon
            interpolate(latlon[cn_t as usize], latlon[pn_t as usize], d, &mut buf);
            for i in 1..d {
                latlon[id_of(s, d - 1 - i, i, d) as usize] = buf[(i - 1) as usize];
            }
            // current north tropical pentagon -> previous south tropical pentagon
            interpolate(latlon[cn_t as usize], latlon[ps_t as usize], d, &mut buf);
            for i in 1..d {
                latlon[id_of(s, d - 1, i, d) as usize] = buf[(i - 1) as usize];
            }
            // current north tropical pentagon -> current south tropical pentagon
            interpolate(latlon[cn_t as usize], latlon[cs_t as usize], d, &mut buf);
            for i in 1..d {
                latlon[id_of(s, d - 1 + i, 0, d) as usize] = buf[(i - 1) as usize];
            }
            // current south tropical pentagon -> previous south tropical pentagon
            interpolate(latlon[cs_t as usize], latlon[ps_t as usize], d, &mut buf);
            for i in 1..d {
                latlon[id_of(s, max_x - i, i, d) as usize] = buf[(i - 1) as usize];
            }
            // current south tropical pentagon -> south pole
            interpolate(latlon[cs_t as usize], latlon[ss_p as usize], d, &mut buf);
            for i in 1..d {
                latlon[id_of(s, max_x, i, d) as usize] = buf[(i - 1) as usize];
            }
        }
    }

    // Interior fields (only when d >= 3).
    if d >= 3 {
        let mut buf = vec![(0.0_f64, 0.0_f64); (d - 1) as usize];
        for s in 0..PEELS {
            for x in 0..(d * 2) {
                if (x + 1) % d == 0 {
                    continue; // skip columns whose interior is on the diagonal already
                }
                let j = d - ((x + 1) % d);
                let n1 = j - 1; // count of unpositioned fields before j
                let n2 = d - 1 - j; // count of unpositioned fields after j
                let f1 = id_of(s, x, 0, d);
                let f2 = id_of(s, x, j, d);
                // peels uses _adjacentFields[2] of get(s, x, d-1) for the "later edge" endpoint
                let after = id_of(s, x, d - 1, d);
                let after_off = nbr_off[after as usize] as usize;
                let f3 = nbr_flat[after_off + 2];

                interpolate(latlon[f1 as usize], latlon[f2 as usize], n1 + 1, &mut buf);
                for i in 1..j {
                    latlon[id_of(s, x, i, d) as usize] = buf[(i - 1) as usize];
                }
                interpolate(latlon[f2 as usize], latlon[f3 as usize], n2 + 1, &mut buf);
                for i in (j + 1)..d {
                    latlon[id_of(s, x, i, d) as usize] = buf[(i - j - 1) as usize];
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn divisions_128_yields_163842_fields() {
        let sphere = VoronoiSphere::new(128);
        assert_eq!(sphere.n_fields(), 163_842);
    }

    #[test]
    fn divisions_n_yields_10n2_plus_2_fields() {
        for d in [1u32, 2, 4, 8, 16, 32] {
            let s = VoronoiSphere::new(d);
            assert_eq!(s.n_fields(), 10 * d * d + 2);
        }
    }

    #[test]
    fn unit_sphere_positions() {
        let sphere = VoronoiSphere::new(64);
        for f in 0..sphere.n_fields() {
            let p = sphere.position(f);
            let len = p.length();
            assert!(
                (len - 1.0).abs() < 1e-4,
                "field {} at length {}",
                f,
                len
            );
        }
    }

    #[test]
    fn pentagons_have_5_neighbours_hexagons_have_6() {
        let sphere = VoronoiSphere::new(32);
        let n5 = (0..sphere.n_fields())
            .filter(|&i| sphere.neighbours(i).len() == 5)
            .count();
        let n6 = (0..sphere.n_fields())
            .filter(|&i| sphere.neighbours(i).len() == 6)
            .count();
        assert_eq!(n5, 12, "exactly 12 pentagon fields expected");
        assert_eq!(n5 + n6, sphere.n_fields() as usize);
    }

    #[test]
    fn neighbour_relation_is_symmetric() {
        let sphere = VoronoiSphere::new(8);
        for f in 0..sphere.n_fields() {
            for &nb in sphere.neighbours(f) {
                assert!(
                    sphere.neighbours(nb).iter().any(|&x| x == f),
                    "{} -> {} not symmetric",
                    f,
                    nb
                );
            }
        }
    }

    #[test]
    fn triangle_count_matches_dual_mesh_formula() {
        // peels emits 2*(n-2) triangles in `getInterfieldTriangles`.
        let sphere = VoronoiSphere::new(8);
        let n = sphere.n_fields() as usize;
        assert_eq!(sphere.triangles().len(), 2 * (n - 2) * 3);
    }

    #[test]
    fn triangle_indices_in_range() {
        let sphere = VoronoiSphere::new(8);
        let n = sphere.n_fields();
        for &idx in sphere.triangles() {
            assert!(idx < n);
        }
    }

    #[test]
    fn poles_at_y_plus_minus_one() {
        let sphere = VoronoiSphere::new(16);
        let north = sphere.position(0);
        let south = sphere.position(1);
        assert!((north.y - 1.0).abs() < 1e-5, "north y={}", north.y);
        assert!((south.y + 1.0).abs() < 1e-5, "south y={}", south.y);
    }

    #[test]
    fn unique_positions() {
        // Adjacent fields should not coincide.
        let sphere = VoronoiSphere::new(16);
        for f in 0..sphere.n_fields() {
            let p = sphere.position(f);
            for &nb in sphere.neighbours(f) {
                let q = sphere.position(nb);
                assert!((p - q).length() > 1e-3, "{} and {} coincide", f, nb);
            }
        }
    }

    #[test]
    fn determinism_two_runs_match() {
        let a = VoronoiSphere::new(16);
        let b = VoronoiSphere::new(16);
        assert_eq!(a.positions(), b.positions());
        assert_eq!(a.triangles(), b.triangles());
    }
}
