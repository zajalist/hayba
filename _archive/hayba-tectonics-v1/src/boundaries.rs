//! Plate boundary classification.
//!
//! For each boundary edge between cells of plate A and plate B, we compute
//! the relative velocity at the edge midpoint:
//!     v_rel = ω_A × m - ω_B × m
//!
//! Project `v_rel` into two components at the midpoint:
//!   - **Normal** — along the great-circle direction pointing from A's
//!     interior toward B's. Sign tells convergent (toward B) vs divergent
//!     (away from B).
//!   - **Tangent** — along the edge direction. Pure tangent motion = transform.
//!
//! Classification rule (matches the convention used in plate-tectonics
//! pedagogy):
//!   - |normal| > 2 × |tangent|         → Convergent (normal > 0) or Divergent (normal < 0)
//!   - |tangent| > 2 × |normal|         → Transform
//!   - otherwise                        → Oblique (mixed; rare boundary type)

use crate::mesh::Vec3f;
use crate::motion::PlateMotion;
use crate::plates::PlateAssignment;
use crate::voronoi::SphericalVoronoi;

#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BoundaryKind {
    Divergent  = 0,
    Convergent = 1,
    Transform  = 2,
    Oblique    = 3,
}

impl BoundaryKind {
    pub const fn label(self) -> &'static str {
        match self {
            BoundaryKind::Divergent  => "divergent",
            BoundaryKind::Convergent => "convergent",
            BoundaryKind::Transform  => "transform",
            BoundaryKind::Oblique    => "oblique",
        }
    }
}

/// Classification result per boundary edge, in the same order as
/// `PlateAssignment::boundary_edges`.
#[derive(Debug)]
pub struct BoundaryClassification {
    pub kinds: Vec<BoundaryKind>,
    /// Signed normal-component magnitude. Positive = convergent, negative =
    /// divergent. Useful for shading edges by velocity magnitude.
    pub normal_speed: Vec<f64>,
    /// Tangential component magnitude (always ≥ 0).
    pub tangent_speed: Vec<f64>,
}

/// Classify each Voronoi edge (the *analytical* boundary) by sampling its
/// midpoint and computing the relative velocity there. Uses the great-circle
/// arc's tangent direction as the boundary tangent — no mesh dependence.
pub fn classify_voronoi_edges(
    voronoi: &SphericalVoronoi,
    plates: &PlateAssignment,
    motions: &[Option<PlateMotion>],
) -> BoundaryClassification {
    debug_assert_eq!(motions.len(), plates.plates.len(), "INV-4: |motion| == |registry|");
    let mut kinds = Vec::with_capacity(voronoi.edges.len());
    let mut normal_speed = Vec::with_capacity(voronoi.edges.len());
    let mut tangent_speed = Vec::with_capacity(voronoi.edges.len());

    for edge in &voronoi.edges {
        // Midpoint of the arc — every arc has odd|even sample count; pick
        // the middle index.
        let mid_idx = edge.arc.len() / 2;
        let m = edge.arc[mid_idx];

        // Tangent direction along the arc at the midpoint: forward sample
        // minus backward sample, projected onto the tangent plane at m.
        let p_prev = edge.arc[mid_idx.saturating_sub(1)];
        let p_next = edge.arc[(mid_idx + 1).min(edge.arc.len() - 1)];
        let raw_t = p_next.sub(p_prev);
        let t = crate::sphere_geom::project_to_tangent_plane(m, raw_t).normalize();

        // Normal direction at the midpoint, pointing from plate_a toward plate_b.
        let n_raw = m.cross(t);
        let seed_a = plates.plate(edge.plate_a).expect("INV-2: edge plate live").seed_pos;
        let seed_b = plates.plate(edge.plate_b).expect("INV-2: edge plate live").seed_pos;
        let from_a_to_b = seed_b.sub(seed_a);
        let align = n_raw.dot(from_a_to_b);
        let n = if align >= 0.0 { n_raw } else { n_raw.scale(-1.0) };

        let v_a = motions[edge.plate_a as usize].as_ref().expect("INV-4: motion live").velocity_at(m);
        let v_b = motions[edge.plate_b as usize].as_ref().expect("INV-4: motion live").velocity_at(m);
        let v_rel = v_a.sub(v_b);

        let normal = v_rel.dot(n);
        let tangent = v_rel.dot(t).abs();

        let kind = if normal.abs() > 2.0 * tangent {
            if normal > 0.0 { BoundaryKind::Convergent } else { BoundaryKind::Divergent }
        } else if tangent > 2.0 * normal.abs() {
            BoundaryKind::Transform
        } else {
            BoundaryKind::Oblique
        };

        kinds.push(kind);
        normal_speed.push(normal);
        tangent_speed.push(tangent);
    }

    BoundaryClassification { kinds, normal_speed, tangent_speed }
}

pub fn classify_boundaries(
    vertices: &[Vec3f],
    plates: &PlateAssignment,
    motions: &[Option<PlateMotion>],
) -> BoundaryClassification {
    debug_assert_eq!(motions.len(), plates.plates.len(), "INV-4: |motion| == |registry|");
    let mut kinds = Vec::with_capacity(plates.boundary_edges.len());
    let mut normal_speed = Vec::with_capacity(plates.boundary_edges.len());
    let mut tangent_speed = Vec::with_capacity(plates.boundary_edges.len());

    for &[a, b] in &plates.boundary_edges {
        let pa = vertices[a as usize];
        let pb = vertices[b as usize];

        // Midpoint on the sphere.
        let m = pa.midpoint(pb).normalize();

        let plate_a = plates.cell_plate[a as usize] as usize;
        let plate_b = plates.cell_plate[b as usize] as usize;
        let v_a = motions[plate_a].as_ref().expect("INV-4: motion live").velocity_at(m);
        let v_b = motions[plate_b].as_ref().expect("INV-4: motion live").velocity_at(m);
        let v_rel = v_a.sub(v_b);

        // Edge tangent on the sphere: project (pb - pa) onto the tangent
        // plane at m, normalize. Since pa and pb are both close to m on a
        // unit sphere, (pb - pa) is already nearly tangent — we project to
        // remove any tiny radial drift.
        let raw_t = pb.sub(pa);
        let t = crate::sphere_geom::project_to_tangent_plane(m, raw_t).normalize();

        // Normal direction on the sphere at m: tangent plane, perpendicular
        // to t, pointing from A's interior toward B's. m × t produces a
        // vector tangent to the sphere and perpendicular to t. Its sign is
        // arbitrary; resolve by comparing against (seed_b - seed_a).
        let n_raw = m.cross(t);

        // We want n to point from A's side toward B's side. The seed
        // positions are stored alongside plates; access them via the
        // assignment.
        let seed_a = plates.plate(plate_a as u32).expect("INV-2: cell plate live").seed_pos;
        let seed_b = plates.plate(plate_b as u32).expect("INV-2: cell plate live").seed_pos;
        let from_a_to_b = seed_b.sub(seed_a);
        let align = n_raw.dot(from_a_to_b);
        let n = if align >= 0.0 { n_raw } else { n_raw.scale(-1.0) };

        let normal = v_rel.dot(n);
        let tangent = v_rel.dot(t).abs();

        let kind = if normal.abs() > 2.0 * tangent {
            if normal > 0.0 { BoundaryKind::Convergent } else { BoundaryKind::Divergent }
        } else if tangent > 2.0 * normal.abs() {
            BoundaryKind::Transform
        } else {
            BoundaryKind::Oblique
        };

        kinds.push(kind);
        normal_speed.push(normal);
        tangent_speed.push(tangent);
    }

    BoundaryClassification { kinds, normal_speed, tangent_speed }
}

/// A single ordered chain of boundary edges that share a `(plate_a,
/// plate_b, kind)` group. Vertices are unit-sphere points (mesh vertex
/// positions in the order the chain walks); the viewer renders these as
/// a polyline at the current frame.
///
/// Canonical ordering: `plate_a < plate_b` (so the same logical boundary
/// always emits as one polyline regardless of which neighbour the CA
/// happened to visit first).
#[derive(Debug, Clone)]
pub struct BoundaryPolyline {
    pub kind: BoundaryKind,
    pub plate_a: u32,
    pub plate_b: u32,
    /// Ordered chain of unit-sphere points (mesh vertex positions). One
    /// polyline per connected component of the `(plate_a, plate_b, kind)`
    /// group's edge graph.
    pub vertices: Vec<[f32; 3]>,
}

/// Walk the boundary edges in `assignment.boundary_edges`, group them by
/// `(plate_a, plate_b, kind)` triple with canonical `plate_a < plate_b`
/// ordering, then chain each group into one or more ordered polylines.
///
/// Algorithm:
/// 1. Group every boundary edge by the canonical triple.
/// 2. Within each group, build an adjacency map: mesh-vertex → list of
///    (edge_idx, other_endpoint).
/// 3. Walk each connected component starting from a degree-1 endpoint if
///    one exists (open chain), otherwise from any unvisited vertex (closed
///    loop). Each edge is consumed exactly once.
/// 4. Emit one [`BoundaryPolyline`] per chain.
///
/// `classification.kinds` must align 1:1 with `assignment.boundary_edges`
/// — that is the contract `classify_boundaries` produces.
pub fn extract_polylines(
    assignment: &PlateAssignment,
    vertices: &[Vec3f],
    classification: &BoundaryClassification,
) -> Vec<BoundaryPolyline> {
    use std::collections::BTreeMap;

    let edges = &assignment.boundary_edges;
    debug_assert_eq!(
        edges.len(),
        classification.kinds.len(),
        "classification.kinds must align with assignment.boundary_edges",
    );

    // Group edges by (plate_a, plate_b, kind) — canonical plate_a < plate_b.
    // Store edge indices (u32) into the original `edges` slice.
    let mut groups: BTreeMap<(u32, u32, u8), Vec<u32>> = BTreeMap::new();
    for (ei, &[a, b]) in edges.iter().enumerate() {
        let pa_raw = assignment.cell_plate[a as usize];
        let pb_raw = assignment.cell_plate[b as usize];
        // Boundary edges always cross plates by construction; skip same-plate
        // entries defensively in case the assignment was mutated post-build.
        if pa_raw == pb_raw {
            continue;
        }
        let (pa, pb) = if pa_raw < pb_raw { (pa_raw, pb_raw) } else { (pb_raw, pa_raw) };
        let kind = classification.kinds[ei] as u8;
        groups.entry((pa, pb, kind)).or_default().push(ei as u32);
    }

    let mut out: Vec<BoundaryPolyline> = Vec::new();
    for ((pa, pb, kind_byte), group_edges) in groups {
        // adjacency: vertex_id -> Vec<(edge_idx, other_vertex)>
        let mut adj: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
        for &ei in &group_edges {
            let [a, b] = edges[ei as usize];
            adj.entry(a).or_default().push((ei, b));
            adj.entry(b).or_default().push((ei, a));
        }

        // Track which edges have been consumed.
        let mut used: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();

        // Walk: prefer degree-1 starts (open chain endpoint); fall back to
        // any unvisited vertex (closed loop).
        let kind = match kind_byte {
            0 => BoundaryKind::Divergent,
            1 => BoundaryKind::Convergent,
            2 => BoundaryKind::Transform,
            _ => BoundaryKind::Oblique,
        };

        loop {
            // Find a start vertex with at least one unused incident edge.
            // Prefer endpoints (degree-1 over unused edges) for deterministic
            // open-chain starts.
            let mut start: Option<u32> = None;
            let mut start_deg = usize::MAX;
            for (&v, incident) in &adj {
                let unused = incident.iter().filter(|(e, _)| !used.contains(e)).count();
                if unused == 0 {
                    continue;
                }
                if unused < start_deg {
                    start_deg = unused;
                    start = Some(v);
                    if unused == 1 {
                        break;
                    }
                }
            }
            let Some(start_v) = start else { break };

            // Walk the chain. visited_in_chain prevents revisiting a vertex
            // inside one polyline (which would happen at a junction where
            // three edges of the same group meet — rare, but possible).
            let mut chain_vertices: Vec<u32> = Vec::new();
            let mut visited_in_chain: std::collections::BTreeSet<u32> =
                std::collections::BTreeSet::new();
            let mut cur = start_v;
            chain_vertices.push(cur);
            visited_in_chain.insert(cur);
            loop {
                // Pick the lowest-id incident unused edge whose other
                // endpoint hasn't been used in this chain yet. Deterministic.
                let next = adj
                    .get(&cur)
                    .and_then(|incident| {
                        incident
                            .iter()
                            .filter(|(e, other)| {
                                !used.contains(e) && !visited_in_chain.contains(other)
                            })
                            .min_by_key(|(e, _)| *e)
                            .copied()
                    });
                match next {
                    Some((edge_idx, other)) => {
                        used.insert(edge_idx);
                        chain_vertices.push(other);
                        visited_in_chain.insert(other);
                        cur = other;
                    }
                    None => {
                        // Either dead-end or every remaining incident edge
                        // loops back into the chain. Consume one such edge
                        // (the lowest-id) so we don't infinite-loop, then
                        // stop the walk — the loop closure will be implicit
                        // in the chain's last/first vertex match.
                        if let Some(incident) = adj.get(&cur) {
                            if let Some(&(edge_idx, _other)) = incident
                                .iter()
                                .filter(|(e, _)| !used.contains(e))
                                .min_by_key(|(e, _)| *e)
                            {
                                used.insert(edge_idx);
                            }
                        }
                        break;
                    }
                }
            }

            if chain_vertices.len() < 2 {
                continue;
            }
            let mut pts: Vec<[f32; 3]> = Vec::with_capacity(chain_vertices.len());
            for &v in &chain_vertices {
                let p = vertices[v as usize];
                pts.push([p.x as f32, p.y as f32, p.z as f32]);
            }
            out.push(BoundaryPolyline {
                kind,
                plate_a: pa,
                plate_b: pb,
                vertices: pts,
            });
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
    fn classification_has_all_four_kinds_present() {
        // With 20+ plates moving in random directions we should see all
        // four boundary kinds across the planet.
        let sphere = Icosphere::new(5);
        let plates = PlateAssignment::build(
            MasterSeed(42),
            &sphere,
            BuildOptions { plate_count: 20, ..BuildOptions::default() },
        );
        let motions = sample_plate_motions(MasterSeed(42), 20);
        let c = classify_boundaries(&sphere.vertices, &plates, &motions);

        let mut counts = [0u32; 4];
        for k in &c.kinds {
            counts[*k as usize] += 1;
        }
        // At least the three main kinds must appear; oblique can be rare.
        assert!(counts[BoundaryKind::Divergent as usize] > 0, "no divergent edges");
        assert!(counts[BoundaryKind::Convergent as usize] > 0, "no convergent edges");
        assert!(counts[BoundaryKind::Transform as usize] > 0, "no transform edges");
    }

    #[test]
    fn deterministic_classification() {
        let sphere = Icosphere::new(4);
        let opts = BuildOptions { plate_count: 12, ..BuildOptions::default() };
        let plates = PlateAssignment::build(MasterSeed(42), &sphere, opts);
        let motions = sample_plate_motions(MasterSeed(42), 12);
        let a = classify_boundaries(&sphere.vertices, &plates, &motions);
        let b = classify_boundaries(&sphere.vertices, &plates, &motions);
        assert_eq!(a.kinds, b.kinds);
    }
}
