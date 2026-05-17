//! Analytical spherical Voronoi diagram of the plate seeds.
//!
//! Method:
//!   1. Find every Delaunay triangle: a triple of seeds whose spherical
//!      circumcircle contains no other seed.
//!   2. Each Delaunay triangle's spherical circumcenter is a Voronoi
//!      vertex (a triple junction).
//!   3. Two Delaunay triangles sharing an edge produce one Voronoi edge:
//!      a great-circle arc between their circumcenters.
//!   4. Sample each arc into N small segments for rendering.
//!
//! Why this gives smooth boundaries: Voronoi edges are *actual* great-circle
//! arcs on the sphere, completely independent of the icosphere mesh. They
//! pass through whatever portion of the sphere is equidistant from two
//! adjacent seeds. No more zigzag.
//!
//! Complexity: O(N⁴) — we test every triple against every other seed for
//! the Delaunay property. For the typical N=12 to N=30 plate counts this
//! is a few thousand to a million ops, sub-millisecond. We'll swap to an
//! incremental convex hull (O(N log N)) when we go past ~100 plates.

use crate::mesh::Vec3f;

/// One Delaunay triangle of seed indices, with its spherical circumcenter
/// (= a Voronoi vertex / triple junction).
#[derive(Copy, Clone, Debug)]
pub struct DelaunayTriangle {
    /// Sorted seed indices (i < j < k).
    pub seeds: [u32; 3],
    /// Spherical circumcenter — unit vector on the sphere equidistant from
    /// the three seeds, on the side where the triangle "wraps around" it.
    pub circumcenter: Vec3f,
}

/// The boundary polyline of a single plate, walked in CCW order around its
/// seed in the local tangent plane. The polyline closes on itself
/// (`boundary[0] == boundary[last]`) so a renderer can emit a triangle fan
/// from the plate's seed without special-casing the wrap-around segment.
#[derive(Clone, Debug)]
pub struct PlatePolygon {
    pub plate_id: u32,
    pub boundary: Vec<Vec3f>,
}

/// One Voronoi edge: a great-circle arc between two circumcenters, dividing
/// two adjacent plates.
#[derive(Clone, Debug)]
pub struct VoronoiEdge {
    /// Seed indices for the two plates this edge separates.
    pub plate_a: u32,
    pub plate_b: u32,
    /// Endpoints (Voronoi vertices / triple junctions).
    pub start: Vec3f,
    pub end: Vec3f,
    /// Sampled points along the great-circle arc, INCLUDING both endpoints.
    /// `arc[0] == start`, `arc[last] == end`. Used directly by the viewer
    /// to render the edge as a smooth polyline.
    pub arc: Vec<Vec3f>,
}

/// Top-level Voronoi diagram output.
#[derive(Debug)]
pub struct SphericalVoronoi {
    pub triangles: Vec<DelaunayTriangle>,
    pub edges: Vec<VoronoiEdge>,
}

impl SphericalVoronoi {
    pub fn build(seeds: &[Vec3f], arc_samples: u32) -> Self {
        let n = seeds.len();
        let mut triangles: Vec<DelaunayTriangle> = Vec::new();

        // Find all Delaunay triangles by brute force. For each ordered
        // triple (i < j < k), compute the spherical circumcenter; verify
        // that no other seed is strictly closer to it than seeds[i] is.
        // Equality (cocircular case) is handled by tiebreaking on indices.
        const EPS: f64 = 1e-10;

        for i in 0..n {
            for j in (i + 1)..n {
                for k in (j + 1)..n {
                    let a = seeds[i]; let b = seeds[j]; let c = seeds[k];
                    let Some(center) = spherical_circumcenter(a, b, c) else { continue; };

                    // Reference dot — same for all three triangle vertices
                    // by construction. Larger dot = smaller angular distance.
                    let ref_dot = a.dot(center);

                    // Delaunay test: no seed outside {i, j, k} should be
                    // *closer* (larger dot) to center than the triangle
                    // vertices are.
                    let mut ok = true;
                    for l in 0..n {
                        if l == i || l == j || l == k { continue; }
                        let d = seeds[l].dot(center);
                        if d > ref_dot + EPS { ok = false; break; }
                        if d > ref_dot - EPS && l < i {
                            // Tiebreaker: cocircular case, prefer the
                            // triangle with the lowest index trio.
                            ok = false; break;
                        }
                    }
                    if !ok { continue; }

                    triangles.push(DelaunayTriangle {
                        seeds: [i as u32, j as u32, k as u32],
                        circumcenter: center,
                    });
                }
            }
        }

        // Build Voronoi edges. Each Delaunay edge (a pair of seeds shared
        // by two Delaunay triangles) yields one Voronoi edge between the
        // two triangles' circumcenters.
        let mut edges: Vec<VoronoiEdge> = Vec::new();
        for ti in 0..triangles.len() {
            for ei in 0..3 {
                let a = triangles[ti].seeds[ei];
                let b = triangles[ti].seeds[(ei + 1) % 3];
                let (pa, pb) = if a < b { (a, b) } else { (b, a) };
                // Find the OTHER triangle sharing this edge — and avoid
                // emitting the same Voronoi edge twice.
                let mut partner: Option<usize> = None;
                for tj in (ti + 1)..triangles.len() {
                    let s = triangles[tj].seeds;
                    let has_a = s.contains(&pa);
                    let has_b = s.contains(&pb);
                    if has_a && has_b { partner = Some(tj); break; }
                }
                if let Some(tj) = partner {
                    let start = triangles[ti].circumcenter;
                    let end = triangles[tj].circumcenter;
                    let arc = sample_great_circle_arc(start, end, arc_samples);
                    edges.push(VoronoiEdge {
                        plate_a: pa, plate_b: pb,
                        start, end, arc,
                    });
                }
            }
        }

        Self { triangles, edges }
    }
}

/// Build closed boundary polygons for every plate. Walks the Voronoi
/// vertices around each seed in CCW order in the seed's tangent plane,
/// concatenating the arc points of the connecting Voronoi edges in the
/// correct direction. The resulting polyline can be tessellated by a
/// simple fan from the seed.
pub fn build_plate_polygons(
    voronoi: &SphericalVoronoi,
    seeds: &[Vec3f],
) -> Vec<PlatePolygon> {
    let mut out = Vec::with_capacity(seeds.len());

    for (plate_id, &seed) in seeds.iter().enumerate() {
        // Voronoi vertices around this plate = Delaunay triangles that contain it.
        let mut vertices: Vec<usize> = voronoi.triangles.iter().enumerate()
            .filter(|(_, t)| t.seeds.contains(&(plate_id as u32)))
            .map(|(i, _)| i)
            .collect();

        if vertices.len() < 3 { continue; }  // Degenerate — shouldn't happen for valid Voronoi.

        // Local 2D basis in the tangent plane at the seed. e_u = any
        // tangent direction; e_v = seed × e_u (also tangent, orthogonal).
        let e_u = pick_tangent(seed);
        let e_v = Vec3f::new(
            seed.y * e_u.z - seed.z * e_u.y,
            seed.z * e_u.x - seed.x * e_u.z,
            seed.x * e_u.y - seed.y * e_u.x,
        );

        // Sort by angle around seed. atan2 gives CCW order in the (e_u, e_v) basis.
        vertices.sort_by(|&a, &b| {
            let ca = voronoi.triangles[a].circumcenter;
            let cb = voronoi.triangles[b].circumcenter;
            let aa = (ca.dot(e_v)).atan2(ca.dot(e_u));
            let ab = (cb.dot(e_v)).atan2(cb.dot(e_u));
            aa.partial_cmp(&ab).unwrap()
        });

        // Concatenate arc points of edges connecting consecutive Voronoi vertices.
        let mut boundary = Vec::new();
        let m = vertices.len();
        for i in 0..m {
            let t1 = vertices[i];
            let t2 = vertices[(i + 1) % m];

            // The edge between t1 and t2 separates `plate_id` from the
            // OTHER plate they share.
            let s1 = voronoi.triangles[t1].seeds;
            let s2 = voronoi.triangles[t2].seeds;
            let Some(&other) = s1.iter().find(|&&s| s != plate_id as u32 && s2.contains(&s)) else {
                continue;
            };
            let (a, b) = if (plate_id as u32) < other {
                (plate_id as u32, other)
            } else {
                (other, plate_id as u32)
            };
            let Some(edge) = voronoi.edges.iter().find(|e| e.plate_a == a && e.plate_b == b) else {
                continue;
            };

            // Determine arc direction: start should be at t1's circumcenter,
            // end at t2's (or reverse). Compare to circumcenters directly
            // since the perturbation can shift interior points but endpoints
            // stay locked to the Voronoi vertices.
            let c1 = voronoi.triangles[t1].circumcenter;
            let forward = distance_sq(edge.start, c1) < distance_sq(edge.end, c1);

            if forward {
                for j in 0..(edge.arc.len() - 1) {
                    boundary.push(edge.arc[j]);
                }
            } else {
                for j in (1..edge.arc.len()).rev() {
                    boundary.push(edge.arc[j]);
                }
            }
        }

        // Close the loop so a fan renderer doesn't need a wrap-around case.
        if let Some(&first) = boundary.first() {
            boundary.push(first);
        }

        out.push(PlatePolygon {
            plate_id: plate_id as u32,
            boundary,
        });
    }

    out
}

/// Pick any unit tangent to the sphere at `p`. Avoids the singularity when
/// the canonical reference axis is collinear with `p` by switching axes.
fn pick_tangent(p: Vec3f) -> Vec3f {
    let candidate = if p.x.abs() < 0.9 {
        Vec3f::new(1.0, 0.0, 0.0)
    } else {
        Vec3f::new(0.0, 1.0, 0.0)
    };
    // Project candidate onto the tangent plane at p, normalize.
    let dot = candidate.x * p.x + candidate.y * p.y + candidate.z * p.z;
    Vec3f::new(
        candidate.x - dot * p.x,
        candidate.y - dot * p.y,
        candidate.z - dot * p.z,
    ).normalize()
}

fn distance_sq(a: Vec3f, b: Vec3f) -> f64 {
    let dx = a.x - b.x; let dy = a.y - b.y; let dz = a.z - b.z;
    dx * dx + dy * dy + dz * dz
}

/// Spherical circumcenter of triangle (a, b, c) where a, b, c are on the
/// unit sphere. Returns None for degenerate / nearly-collinear input.
///
/// The circumcenter is the point on the sphere equidistant (in spherical
/// distance) from a, b, c. It lies on the line through the origin
/// perpendicular to the plane (a, b, c). Two candidates exist (±); we
/// pick the side where the triangle wraps around — equivalent to the side
/// closer to the triangle's centroid.
pub fn spherical_circumcenter(a: Vec3f, b: Vec3f, c: Vec3f) -> Option<Vec3f> {
    // Normal to the plane (a, b, c).
    let ab = Vec3f::new(b.x - a.x, b.y - a.y, b.z - a.z);
    let ac = Vec3f::new(c.x - a.x, c.y - a.y, c.z - a.z);
    let n = Vec3f::new(
        ab.y * ac.z - ab.z * ac.y,
        ab.z * ac.x - ab.x * ac.z,
        ab.x * ac.y - ab.y * ac.x,
    );
    let len = (n.x * n.x + n.y * n.y + n.z * n.z).sqrt();
    if len < 1e-12 { return None; }
    let n = Vec3f::new(n.x / len, n.y / len, n.z / len);

    // Pick the side where the triangle centroid sits.
    let centroid = Vec3f::new(
        (a.x + b.x + c.x) / 3.0,
        (a.y + b.y + c.y) / 3.0,
        (a.z + b.z + c.z) / 3.0,
    );
    let sign = if n.dot(centroid) >= 0.0 { 1.0 } else { -1.0 };
    Some(Vec3f::new(n.x * sign, n.y * sign, n.z * sign))
}

/// Sample a great-circle arc from `a` to `b` (both on the unit sphere) into
/// `samples` equally-spaced points, INCLUDING both endpoints. Uses spherical
/// linear interpolation (slerp). Returns at least 2 points.
pub fn sample_great_circle_arc(a: Vec3f, b: Vec3f, samples: u32) -> Vec<Vec3f> {
    let samples = samples.max(2);
    let dot = a.dot(b).clamp(-1.0, 1.0);
    let theta = dot.acos();
    let sin_theta = theta.sin();

    let mut out = Vec::with_capacity(samples as usize);
    if sin_theta.abs() < 1e-9 {
        // Nearly identical endpoints — just lerp linearly, normalize.
        for i in 0..samples {
            let t = i as f64 / (samples - 1) as f64;
            let p = Vec3f::new(
                a.x * (1.0 - t) + b.x * t,
                a.y * (1.0 - t) + b.y * t,
                a.z * (1.0 - t) + b.z * t,
            );
            out.push(p.normalize());
        }
    } else {
        for i in 0..samples {
            let t = i as f64 / (samples - 1) as f64;
            let s1 = ((1.0 - t) * theta).sin() / sin_theta;
            let s2 = (t * theta).sin() / sin_theta;
            out.push(Vec3f::new(
                s1 * a.x + s2 * b.x,
                s1 * a.y + s2 * b.y,
                s1 * a.z + s2 * b.z,
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Icosphere;
    use crate::motion::sample_plate_motions;
    use crate::plates::{BuildOptions, PlateAssignment};
    use hayba_seeds::MasterSeed;

    #[test]
    fn circumcenter_is_equidistant() {
        // Three arbitrary points on the sphere; the spherical circumcenter
        // should be equidistant from all three.
        let a = Vec3f::new(1.0, 0.0, 0.0);
        let b = Vec3f::new(0.0, 1.0, 0.0);
        let c = Vec3f::new(0.0, 0.0, 1.0);
        let center = spherical_circumcenter(a, b, c).unwrap();
        let da = a.dot(center);
        let db = b.dot(center);
        let dc = c.dot(center);
        assert!((da - db).abs() < 1e-12);
        assert!((db - dc).abs() < 1e-12);
    }

    #[test]
    fn arc_endpoints_match() {
        let a = Vec3f::new(1.0, 0.0, 0.0);
        let b = Vec3f::new(0.0, 1.0, 0.0);
        let arc = sample_great_circle_arc(a, b, 10);
        assert!((arc[0].x - a.x).abs() < 1e-12);
        assert!((arc[arc.len() - 1].y - b.y).abs() < 1e-12);
        // All sampled points on unit sphere.
        for p in &arc {
            let len = (p.x * p.x + p.y * p.y + p.z * p.z).sqrt();
            assert!((len - 1.0).abs() < 1e-9, "off-sphere: {}", len);
        }
    }

    #[test]
    fn voronoi_diagram_has_expected_topology() {
        // For N seeds on a sphere with generic position, the spherical
        // Voronoi diagram has 2N - 4 vertices and 3N - 6 edges (Euler).
        let sphere = Icosphere::new(4);
        let plates = PlateAssignment::build(
            MasterSeed(42),
            &sphere,
            BuildOptions { plate_count: 12, ..BuildOptions::default() },
        );
        let seeds: Vec<Vec3f> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
        let voronoi = SphericalVoronoi::build(&seeds, 8);
        let n = plates.plates.len() as i32;
        let expected_v = 2 * n - 4;
        let expected_e = 3 * n - 6;
        assert_eq!(voronoi.triangles.len() as i32, expected_v,
            "vertex count {} != expected {}", voronoi.triangles.len(), expected_v);
        assert_eq!(voronoi.edges.len() as i32, expected_e,
            "edge count {} != expected {}", voronoi.edges.len(), expected_e);
    }

    #[test]
    fn voronoi_is_deterministic() {
        let sphere = Icosphere::new(3);
        let plates = PlateAssignment::build(
            MasterSeed(42), &sphere, BuildOptions::default(),
        );
        let seeds: Vec<Vec3f> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
        let a = SphericalVoronoi::build(&seeds, 6);
        let b = SphericalVoronoi::build(&seeds, 6);
        assert_eq!(a.edges.len(), b.edges.len());
        for (e1, e2) in a.edges.iter().zip(b.edges.iter()) {
            assert_eq!(e1.plate_a, e2.plate_a);
            assert_eq!(e1.plate_b, e2.plate_b);
        }
    }

    #[test]
    fn plate_polygons_close_and_cover() {
        let sphere = Icosphere::new(3);
        let plates = PlateAssignment::build(
            MasterSeed(42),
            &sphere,
            BuildOptions { plate_count: 12, ..BuildOptions::default() },
        );
        let seeds: Vec<Vec3f> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
        let voronoi = SphericalVoronoi::build(&seeds, 8);
        let polys = build_plate_polygons(&voronoi, &seeds);

        // One polygon per plate.
        assert_eq!(polys.len(), 12);

        for poly in &polys {
            // Polygon closes on itself.
            let first = poly.boundary.first().unwrap();
            let last = poly.boundary.last().unwrap();
            assert!((first.x - last.x).abs() < 1e-9);
            assert!((first.y - last.y).abs() < 1e-9);
            assert!((first.z - last.z).abs() < 1e-9);
            // Plate must have at least 3 distinct vertices on its boundary.
            assert!(poly.boundary.len() >= 4);  // 3 + the closing duplicate
        }
    }

    #[test]
    fn arc_midpoint_is_equidistant_from_seeds() {
        // A Voronoi edge between plates A and B must be equidistant from
        // both seeds at every point on the arc. Spot-check at midpoint.
        let sphere = Icosphere::new(3);
        let plates = PlateAssignment::build(
            MasterSeed(42), &sphere, BuildOptions::default(),
        );
        let seeds: Vec<Vec3f> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
        let voronoi = SphericalVoronoi::build(&seeds, 5);
        for edge in &voronoi.edges {
            let mid = edge.arc[edge.arc.len() / 2];
            let da = seeds[edge.plate_a as usize].dot(mid);
            let db = seeds[edge.plate_b as usize].dot(mid);
            assert!((da - db).abs() < 1e-9,
                "edge {}-{} not equidistant at midpoint: da={} db={}",
                edge.plate_a, edge.plate_b, da, db);
        }
    }
}
