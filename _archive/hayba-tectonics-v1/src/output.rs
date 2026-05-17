//! JSON dump for the static viewer. Hand-rolled — keep zero-dependency.

use std::fmt::Write;

use crate::boundaries::BoundaryClassification;
use crate::crust_state::CrustState;
use crate::mesh::Icosphere;
use crate::motion::PlateMotion;
use crate::plates::PlateAssignment;
use crate::voronoi::SphericalVoronoi;

pub fn dump_world_json(
    seed: u64,
    subdivisions: u32,
    sphere: &Icosphere,
    plates: &PlateAssignment,
    motions: &[Option<PlateMotion>],
    voronoi: &SphericalVoronoi,
    classification: &BoundaryClassification,
    crust: &CrustState,
) -> String {
    debug_assert_eq!(motions.len(), plates.plates.len(), "INV-4: |motion| == |registry|");
    let mut s = String::new();

    write!(s, "{{\n").unwrap();
    write!(s, "  \"seed\": {},\n", seed).unwrap();
    write!(s, "  \"subdivisions\": {},\n", subdivisions).unwrap();
    write!(s, "  \"vertex_count\": {},\n", sphere.vertices.len()).unwrap();
    write!(s, "  \"triangle_count\": {},\n", sphere.triangles.len()).unwrap();
    write!(s, "  \"plate_count\": {},\n", plates.live_count()).unwrap();
    write!(s, "  \"world_age_ma\": {},\n", crust.age_ma.iter().max().copied().unwrap_or(0)).unwrap();
    write!(s, "  \"boundary_edge_count\": {},\n", plates.boundary_edges.len()).unwrap();
    write!(s, "  \"triple_junction_count\": {},\n", plates.triple_junctions.len()).unwrap();
    write!(s, "  \"residual_quad_junctions\": {},\n", plates.residual_quad_junctions).unwrap();

    write!(s, "  \"vertices\": [").unwrap();
    for (i, v) in sphere.vertices.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{:.7},{:.7},{:.7}", v.x, v.y, v.z).unwrap();
    }
    write!(s, "],\n").unwrap();

    write!(s, "  \"triangles\": [").unwrap();
    for (i, t) in sphere.triangles.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{},{},{}", t[0], t[1], t[2]).unwrap();
    }
    write!(s, "],\n").unwrap();

    write!(s, "  \"cell_plate\": [").unwrap();
    for (i, p) in plates.cell_plate.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", p).unwrap();
    }
    write!(s, "],\n").unwrap();

    // Boundary edges (flat pairs): rendered as bright line segments.
    write!(s, "  \"boundary_edges\": [").unwrap();
    for (i, e) in plates.boundary_edges.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{},{}", e[0], e[1]).unwrap();
    }
    write!(s, "],\n").unwrap();

    // Triple junctions: rendered as small markers.
    write!(s, "  \"triple_junctions\": [").unwrap();
    for (i, &v) in plates.triple_junctions.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", v).unwrap();
    }
    write!(s, "],\n").unwrap();

    // ── Analytical spherical Voronoi edges ─────────────────────────────
    // Each edge is a smooth great-circle arc on the sphere — independent
    // of the icosphere mesh. The viewer renders these as polylines.
    write!(s, "  \"voronoi_edge_count\": {},\n", voronoi.edges.len()).unwrap();
    write!(s, "  \"voronoi_edges\": [\n").unwrap();
    for (i, e) in voronoi.edges.iter().enumerate() {
        if i > 0 { write!(s, ",\n").unwrap(); }
        let kind = classification.kinds[i] as u8;
        let nspeed = classification.normal_speed[i];
        write!(
            s,
            "    {{\"a\":{},\"b\":{},\"kind\":{},\"normal_speed\":{:.6e},\"arc\":[",
            e.plate_a, e.plate_b, kind, nspeed,
        ).unwrap();
        for (j, p) in e.arc.iter().enumerate() {
            if j > 0 { write!(s, ",").unwrap(); }
            write!(s, "{:.7},{:.7},{:.7}", p.x, p.y, p.z).unwrap();
        }
        write!(s, "]}}").unwrap();
    }
    write!(s, "\n  ],\n").unwrap();

    // ── Voronoi vertices (= true continuous triple junctions) ──────────
    write!(s, "  \"voronoi_vertex_count\": {},\n", voronoi.triangles.len()).unwrap();
    write!(s, "  \"voronoi_vertices\": [").unwrap();
    for (i, t) in voronoi.triangles.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{:.7},{:.7},{:.7}", t.circumcenter.x, t.circumcenter.y, t.circumcenter.z).unwrap();
    }
    write!(s, "],\n").unwrap();

    // ── Per-plate spherical polygons ───────────────────────────────────
    // Closed boundary polyline per plate, in CCW order in the seed's local
    // tangent plane. The viewer fan-tessellates from each plate's seed_pos.
    let polygons = crate::voronoi::build_plate_polygons(
        voronoi,
        &plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect::<Vec<_>>(),
    );
    write!(s, "  \"plate_polygons\": [\n").unwrap();
    for (i, p) in polygons.iter().enumerate() {
        if i > 0 { write!(s, ",\n").unwrap(); }
        write!(s, "    {{\"id\":{},\"boundary\":[", p.plate_id).unwrap();
        for (j, v) in p.boundary.iter().enumerate() {
            if j > 0 { write!(s, ",").unwrap(); }
            write!(s, "{:.7},{:.7},{:.7}", v.x, v.y, v.z).unwrap();
        }
        write!(s, "]}}").unwrap();
    }
    write!(s, "\n  ],\n").unwrap();

    // ── Crust state: per-cell composition + age ────────────────────────
    // composition: flat u8 array, 0 = oceanic, 1 = continental.
    write!(s, "  \"cell_composition\": [").unwrap();
    for (i, c) in crust.composition.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", *c as u8).unwrap();
    }
    write!(s, "],\n").unwrap();

    // age_ma: flat u16 array.
    write!(s, "  \"cell_age_ma\": [").unwrap();
    for (i, a) in crust.age_ma.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", a).unwrap();
    }
    write!(s, "],\n").unwrap();

    // Rift maturity 0..255 — viewer renders as a heat overlay so the user
    // can see where lifecycle events are accumulating, even if no fork
    // has fired yet.
    write!(s, "  \"cell_rift_progress\": [").unwrap();
    for (i, r) in crust.rift_progress.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", r).unwrap();
    }
    write!(s, "],\n").unwrap();

    // Per-cell elevation in metres (signed i16). Drives the viewer's
    // elevation map-mode.
    write!(s, "  \"cell_elevation_m\": [").unwrap();
    for (i, e) in crust.elevation_m.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", e).unwrap();
    }
    write!(s, "],\n").unwrap();

    // Per-cell volcanic activity intensity 0..255.
    write!(s, "  \"cell_volcanic_act\": [").unwrap();
    for (i, v) in crust.volcanic_act.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", v).unwrap();
    }
    write!(s, "],\n").unwrap();

    // Per-cell total crust thickness in km (sum of all rock layers).
    write!(s, "  \"cell_layer_thickness\": [").unwrap();
    for (i, l) in crust.layers.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", l.total_thickness()).unwrap();
    }
    write!(s, "],\n").unwrap();

    // Failed-rift (aulacogen) age tags. Non-zero = this cell was once a
    // rift line that didn't sever the parent plate. M5 hydrology will use
    // these as preferred river paths.
    write!(s, "  \"cell_failed_rift_age_ma\": [").unwrap();
    for (i, a) in crust.failed_rift_age_ma.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", a).unwrap();
    }
    write!(s, "],\n").unwrap();

    // Large Igneous Province age tags. Non-zero = this cell sits on a LIP
    // plateau (Deccan-Traps-like flood-basalt event). Viewer renders this
    // as a mask/overlay.
    write!(s, "  \"cell_lip_age_ma\": [").unwrap();
    for (i, a) in crust.lip_age_ma.iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        write!(s, "{}", a).unwrap();
    }
    write!(s, "],\n").unwrap();

    // Per-plate baseline composition (so the viewer can stripe plate seeds).
    // Retired slots emit 0 (oceanic) as a stable placeholder — the viewer
    // ignores them via the live-plate filter on `plates`.
    write!(s, "  \"plate_composition\": [").unwrap();
    for (i, slot) in plates.plate_compositions().iter().enumerate() {
        if i > 0 { write!(s, ",").unwrap(); }
        let c = slot.map(|c| c as u8).unwrap_or(0);
        write!(s, "{}", c).unwrap();
    }
    write!(s, "],\n").unwrap();

    write!(s, "  \"plates\": [\n").unwrap();
    let mut first = true;
    for (i, slot) in plates.plates.iter().enumerate() {
        let Some(p) = slot else { continue; };
        let m = motions[i].as_ref().expect("INV-4: motion live");
        if !first { write!(s, ",\n").unwrap(); }
        first = false;
        write!(
            s,
            "    {{\"id\":{},\"color\":[{},{},{}],\"seed_pos\":[{:.7},{:.7},{:.7}],\"omega\":[{:.6e},{:.6e},{:.6e}],\"parent_id\":{},\"birth_step\":{}}}",
            p.id, p.color[0], p.color[1], p.color[2],
            p.seed_pos.x, p.seed_pos.y, p.seed_pos.z,
            m.omega.x, m.omega.y, m.omega.z,
            p.parent_id.map(|i| i as i64).unwrap_or(-1),
            p.birth_macro_step,
        ).unwrap();
    }
    write!(s, "\n  ]\n").unwrap();
    write!(s, "}}\n").unwrap();

    s
}
