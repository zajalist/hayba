//! Boundary-kind elevation differentiation.
//!
//! Asserts the spec from the elevation-targets table:
//!   - Divergent boundary cells: all sub-sea-level (no peaks) except
//!     continental rift valleys which sit just above sea (≤ +500 m).
//!   - Transform / sub-threshold boundary cells: stay within a window of
//!     their composition baseline (no spurious peaks from prior boundary
//!     imprints, modulo initial noise that decays at 5%/step).
//!   - Oceanic-oceanic convergent subducting cells: max elev < 1500 m so
//!     only proper arc cells exceed sea level; trench cells dive deep.

use hayba_seeds::MasterSeed;
use hayba_tectonics::{
    adjacency::Adjacency,
    ca_evolution::{evolve_ca, EvolutionOptions},
    crust_state::{Composition, CrustOptions, CrustState},
    mesh::{Icosphere, Vec3f},
    motion::{sample_plate_motions, PlateMotion},
    plates::{BuildOptions, PlateAssignment},
    sphere_geom,
};

/// Classifies every cell into one of four buckets by recomputing the
/// dominant cross-plate normal velocity (mirroring the logic in
/// `macro_step::ca_inner`). Returns (kind, neighbor_composition).
///   0 — interior (no cross-plate neighbor)
///   1 — divergent
///   2 — convergent
///   3 — transform / sub-threshold
#[allow(clippy::type_complexity)]
fn classify_cells(
    plates: &PlateAssignment,
    crust: &CrustState,
    motions: &[Option<PlateMotion>],
    vertices: &[Vec3f],
    adjacency: &Adjacency,
    threshold: f64,
) -> Vec<(u8, Option<Composition>)> {
    let n = plates.cell_plate.len();
    let seeds: Vec<Vec3f> = plates
        .plates
        .iter()
        .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default())
        .collect();
    let current_motions: Vec<PlateMotion> = motions
        .iter()
        .map(|m| {
            m.unwrap_or(PlateMotion {
                omega: Vec3f::new(0.0, 0.0, 0.0),
            })
        })
        .collect();

    let mut out = vec![(0u8, None); n];
    for v in 0..n {
        let plate_v = plates.cell_plate[v] as usize;
        let mut best_normal: f64 = 0.0;
        let mut best_plate: Option<usize> = None;

        for &nb in adjacency.of(v as u32) {
            let plate_nb = plates.cell_plate[nb as usize] as usize;
            if plate_v == plate_nb {
                continue;
            }
            let pa = vertices[v];
            let pb = vertices[nb as usize];
            let m = pa.midpoint(pb).normalize();
            let s_a = seeds[plate_v];
            let s_b = seeds[plate_nb];
            let raw_n = s_b.sub(s_a);
            let n_tan = sphere_geom::project_to_tangent_plane(m, raw_n);
            if n_tan.dot(n_tan) < 1e-18 {
                continue;
            }
            let n = n_tan.normalize_or(m);
            let v_a = current_motions[plate_v].velocity_at(m);
            let v_b = current_motions[plate_nb].velocity_at(m);
            let normal_speed = v_a.sub(v_b).dot(n);
            if normal_speed.abs() > best_normal.abs() {
                best_normal = normal_speed;
                best_plate = Some(plate_nb);
            }
        }

        let Some(target_plate) = best_plate else {
            out[v] = (0, None);
            continue;
        };

        // Dominant neighbor cell's composition.
        let nb_comp = adjacency
            .of(v as u32)
            .iter()
            .find(|&&nb| plates.cell_plate[nb as usize] as usize == target_plate)
            .map(|&nb| crust.composition[nb as usize]);

        let kind = if best_normal > threshold {
            2
        } else if best_normal < -threshold {
            1
        } else {
            3
        };
        out[v] = (kind, nb_comp);
    }
    out
}

/// Diagnostic: prints per-(kind, own_comp, neighbor_comp) elevation
/// percentiles. Ignored in regular test runs; invoke with
/// `cargo test -p hayba-tectonics --test elevation_by_boundary_kind --
/// --ignored --nocapture` to inspect the histogram.
#[test]
#[ignore]
fn report_elevation_histogram() {
    let seed = 12345u64;
    let macro_steps = 250u32;
    let sphere = Icosphere::new(5);
    let adjacency = Adjacency::build(&sphere);
    let mut plates = PlateAssignment::build(
        MasterSeed(seed),
        &sphere,
        BuildOptions { plate_count: 20, ..BuildOptions::default() },
    );
    let mut motions = sample_plate_motions(MasterSeed(seed), 20);
    plates.prune_empty(&mut motions);
    let seed_positions: Vec<_> = plates
        .plates
        .iter()
        .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default())
        .collect();
    let mut crust = CrustState::initial(
        MasterSeed(seed),
        &sphere.vertices,
        &mut plates,
        &seed_positions,
        CrustOptions::default(),
    );
    let opts = EvolutionOptions { macro_steps, ..Default::default() };
    let threshold = opts.convergence_threshold;
    evolve_ca(&mut plates, &mut crust, &sphere.vertices, &adjacency, &mut motions, opts);

    let class = classify_cells(&plates, &crust, &motions, &sphere.vertices, &adjacency, threshold);
    let kind_name = |k: u8| match k { 0 => "interior", 1 => "divergent", 2 => "convergent", _ => "transform" };
    let comp_name = |c: Composition| match c { Composition::Oceanic => "Oce", Composition::Island => "Isl", Composition::Continental => "Cont" };
    let mut buckets: std::collections::BTreeMap<(u8, &'static str, &'static str), Vec<i32>> =
        std::collections::BTreeMap::new();
    for v in 0..crust.elevation_m.len() {
        let (k, nb) = class[v];
        let oc = comp_name(crust.composition[v]);
        let nc = nb.map(comp_name).unwrap_or("—");
        buckets.entry((k, oc, nc)).or_default().push(crust.elevation_m[v] as i32);
    }
    println!("\n=== Elevation histogram by (kind, own_comp, nb_comp) at step {} ===", macro_steps);
    println!("{:<10} {:>5} {:>5} {:>7}   {:>7} {:>7} {:>7} {:>7} {:>7}",
        "kind", "own", "nb", "n", "min", "p25", "p50", "p75", "max");
    for ((k, oc, nc), mut vs) in buckets {
        vs.sort();
        let n = vs.len();
        let pct = |p: f64| vs[((n - 1) as f64 * p) as usize];
        println!("{:<10} {:>5} {:>5} {:>7}   {:>7} {:>7} {:>7} {:>7} {:>7}",
            kind_name(k), oc, nc, n, vs[0], pct(0.25), pct(0.50), pct(0.75), vs[n - 1]);
    }
}

#[test]
fn elevation_respects_boundary_kind() {
    let seed = 12345u64;
    // Level 5 ≈ 10k cells; 120 macro-steps is enough for the relaxation
    // targets to dominate over the noise-driven initial field
    // (K_ACTIVE=4 → 25%/step ≈ saturation in ~12 steps).
    let macro_steps = 120u32;

    let sphere = Icosphere::new(5);
    let adjacency = Adjacency::build(&sphere);
    let mut plates = PlateAssignment::build(
        MasterSeed(seed),
        &sphere,
        BuildOptions {
            plate_count: 20,
            ..BuildOptions::default()
        },
    );
    let mut motions = sample_plate_motions(MasterSeed(seed), 20);
    plates.prune_empty(&mut motions);
    let seed_positions: Vec<_> = plates
        .plates
        .iter()
        .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default())
        .collect();
    let mut crust = CrustState::initial(
        MasterSeed(seed),
        &sphere.vertices,
        &mut plates,
        &seed_positions,
        CrustOptions::default(),
    );
    let opts = EvolutionOptions {
        macro_steps,
        ..Default::default()
    };
    let threshold = opts.convergence_threshold;
    evolve_ca(
        &mut plates,
        &mut crust,
        &sphere.vertices,
        &adjacency,
        &mut motions,
        opts,
    );

    let class = classify_cells(
        &plates,
        &crust,
        &motions,
        &sphere.vertices,
        &adjacency,
        threshold,
    );

    // ── Divergent boundary cells: NO subaerial peaks ────────────────
    // Per spec: oce/oce → -2500, oce/cont → -2500, cont/oce → -1500
    // (sub-sea), cont/cont → +200 (rift valley, just above sea).
    // Allow +500 m headroom for cont/cont rifts; everything else must
    // stay underwater.
    let mut div_oce_max: i32 = i32::MIN;
    let mut div_cont_max: i32 = i32::MIN;
    let mut div_count = 0u32;
    for v in 0..crust.elevation_m.len() {
        if class[v].0 != 1 {
            continue;
        }
        div_count += 1;
        let elev = crust.elevation_m[v] as i32;
        match crust.composition[v] {
            Composition::Continental => div_cont_max = div_cont_max.max(elev),
            _ => div_oce_max = div_oce_max.max(elev),
        }
    }
    assert!(div_count > 0, "no divergent cells classified — test setup broke");
    assert!(
        div_oce_max <= 0,
        "divergent oceanic cell breached sea level: max={} m (expected ≤ 0)",
        div_oce_max
    );
    if div_cont_max != i32::MIN {
        assert!(
            div_cont_max <= 500,
            "divergent continental rift exceeded +500 m: max={} m (expected ≤ 500)",
            div_cont_max
        );
    }

    // ── Transform / sub-threshold cells: bounded relief ─────────────
    // Per spec: |elev - baseline| < 1500 m. K_DECAY=20 (5%/step) means
    // a prior +9000 m imprint decays ~99% in 120 steps, so this is
    // comfortable. Per composition: oce → -4500, island → 0, cont → +400.
    let mut tf_violations = 0u32;
    let mut tf_max_dev: i32 = 0;
    let mut tf_count = 0u32;
    for v in 0..crust.elevation_m.len() {
        if class[v].0 != 3 {
            continue;
        }
        tf_count += 1;
        let baseline = match crust.composition[v] {
            Composition::Oceanic => -4500,
            Composition::Island => 0,
            Composition::Continental => 400,
        };
        let dev = (crust.elevation_m[v] as i32 - baseline).abs();
        tf_max_dev = tf_max_dev.max(dev);
        if dev >= 1500 {
            tf_violations += 1;
        }
    }
    assert!(tf_count > 0, "no transform cells classified — test setup broke");
    // Allow up to 1% of transform cells to be in transit from a recently
    // ex-convergent imprint. Anything more means the boundary classifier
    // isn't dispatching correctly.
    let allowed = (tf_count / 100).max(1);
    assert!(
        tf_violations <= allowed,
        "{} transform cells deviate ≥1500 m from baseline (allowed: {}). max_dev={} m",
        tf_violations,
        allowed,
        tf_max_dev
    );

    // ── Oceanic-oceanic convergent: trenches go deep, arcs cap low ──
    // The subducting (oceanic) side targets -7000 m; only arc cells
    // (matured to Island/Continental composition) may exceed sea level,
    // capped at +800 / +1500 m. Filter to cells whose composition is
    // still Oceanic (the trench side) and assert max < 1500.
    let mut ococ_oce_max: i32 = i32::MIN;
    let mut ococ_count = 0u32;
    for v in 0..crust.elevation_m.len() {
        if class[v].0 != 2 {
            continue;
        }
        // Restrict to oce-oce: this cell oceanic AND best neighbor oceanic/island.
        if crust.composition[v] != Composition::Oceanic {
            continue;
        }
        match class[v].1 {
            Some(Composition::Oceanic) | Some(Composition::Island) => {}
            _ => continue,
        }
        ococ_count += 1;
        ococ_oce_max = ococ_oce_max.max(crust.elevation_m[v] as i32);
    }
    if ococ_count > 0 {
        assert!(
            ococ_oce_max < 1500,
            "oce-oce convergent (subducting side, still oceanic) breached +1500 m: max={} m",
            ococ_oce_max
        );
    }
}
