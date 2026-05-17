//! CLI: dump a Voronoi-tessellated planet to JSON for the static viewer.
//!
//! Usage:
//!   cargo run -p hayba-tectonics --bin tectonic-preview -- [seed] [subdivisions] [plates]
//! Default: seed=12345 subdivisions=5 plates=12
//!
//! Output: `viz/data/world.json` relative to the workspace root.

use std::fs;
use std::path::PathBuf;

use hayba_seeds::MasterSeed;
use hayba_tectonics::{
    adjacency::Adjacency,
    boundaries::classify_voronoi_edges,
    boundary_detail::perturb_arcs,
    ca_evolution::{evolve_ca_with_encoder, EvolutionOptions},
    frame_stream::FrameEncoder,
    metrics::Metrics,
    crust_state::{CrustOptions, CrustState},
    mesh::{Icosphere, Vec3f},
    motion::sample_plate_motions,
    output::dump_world_json,
    plates::{BuildOptions, PlateAssignment},
    voronoi::SphericalVoronoi,
};

fn main() {
    let raw_args: Vec<String> = std::env::args().collect();
    // Parse out --steps N from the arg list; collect remaining positional args.
    let mut positional: Vec<String> = Vec::with_capacity(raw_args.len());
    let mut steps_override: Option<u32> = None;
    let mut i = 1;
    while i < raw_args.len() {
        let a = &raw_args[i];
        if a == "--steps" {
            if let Some(v) = raw_args.get(i + 1).and_then(|s| s.parse::<u32>().ok()) {
                steps_override = Some(v);
                i += 2;
                continue;
            } else {
                eprintln!("--steps requires an integer argument");
                std::process::exit(2);
            }
        } else if let Some(rest) = a.strip_prefix("--steps=") {
            match rest.parse::<u32>() {
                Ok(v) => { steps_override = Some(v); i += 1; continue; }
                Err(_) => { eprintln!("--steps requires an integer argument"); std::process::exit(2); }
            }
        }
        positional.push(a.clone());
        i += 1;
    }
    let seed = positional.get(0).and_then(|s| s.parse().ok()).unwrap_or(12345u64);
    let subdivisions = positional.get(1).and_then(|s| s.parse().ok()).unwrap_or(7u32);
    let plate_count = positional.get(2).and_then(|s| s.parse().ok()).unwrap_or(50u32);
    // Default 250 for backward-compat; CLI/server may override (recommended 400 = 2000 Ma).
    let macro_steps_override = steps_override.unwrap_or(250u32);

    eprintln!(
        "Generating icosphere: seed={} subdivisions={} plates={} steps={}",
        seed, subdivisions, plate_count, macro_steps_override,
    );
    // Random per-seed rotation so the icosphere's hex pattern doesn't dominate
    // visual character across different worlds.
    let rot_stream_seed = hayba_seeds::derive_scope(
        hayba_seeds::MasterSeed(seed),
        hayba_seeds::Scope::Tectonic,
    ).wrapping_add(0xA0FFE5);
    let mut rot_stream = hayba_seeds::SeedStream::new(rot_stream_seed);
    let to_unit = |x: u64| (x >> 11) as f64 / (1u64 << 53) as f64;
    let rx = to_unit(rot_stream.next_u64()) * std::f64::consts::TAU;
    let ry = to_unit(rot_stream.next_u64()) * std::f64::consts::TAU;
    let rz = to_unit(rot_stream.next_u64()) * std::f64::consts::TAU;
    let sphere = Icosphere::new_rotated(subdivisions, rx, ry, rz);
    eprintln!(
        "Mesh: {} vertices, {} triangles",
        sphere.vertices.len(),
        sphere.triangles.len(),
    );

    let mut plates = PlateAssignment::build(
        MasterSeed(seed),
        &sphere,
        BuildOptions { plate_count, ..BuildOptions::default() },
    );
    eprintln!(
        "Plates: {} · boundary edges: {} · triple junctions: {} · residual quads: {}",
        plates.live_count(),
        plates.boundary_edges.len(),
        plates.triple_junctions.len(),
        plates.residual_quad_junctions,
    );

    let mut motions = sample_plate_motions(MasterSeed(seed), plate_count);
    plates.prune_empty(&mut motions);

    // Analytical spherical Voronoi — smooth great-circle boundary arcs.
    let seed_positions: Vec<Vec3f> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
    let mut voronoi = SphericalVoronoi::build(&seed_positions, 24);
    eprintln!(
        "Voronoi: {} vertices (continuous triple junctions), {} edges",
        voronoi.triangles.len(),
        voronoi.edges.len(),
    );

    let classification = classify_voronoi_edges(&voronoi, &plates, &motions);

    // Inject organic detail — kind-specific fractal noise displaces the
    // arc interior in the tangent plane. Endpoints (triple junctions)
    // stay fixed.
    perturb_arcs(&mut voronoi, &classification, MasterSeed(seed), 64);

    let mut crust = CrustState::initial(
        MasterSeed(seed),
        &sphere.vertices,
        &mut plates,
        &seed_positions,
        CrustOptions::default(),
    );

    // ── Week 3: CA evolution. Plates evolve over 100 macro-steps × 5 Ma
    //     = 500 Ma (one Wilson cycle).
    let adjacency = Adjacency::build(&sphere);
    let ca_opts = EvolutionOptions { macro_steps: macro_steps_override, ..EvolutionOptions::default() };
    eprintln!(
        "Running CA evolution: {} steps × {} Ma = {} Ma elapsed",
        ca_opts.macro_steps, ca_opts.dt_ma, ca_opts.macro_steps * ca_opts.dt_ma,
    );
    let ca_start = std::time::Instant::now();
    let mut metrics = Metrics::new();
    // ── A1: binary delta-stream encoder. Allocate, write header, write
    // initial state BEFORE the loop. The driver emits one per-step frame
    // record at the end of every `post_step`. World.bin is dropped next to
    // world.json.
    // Note: total_frames = macro_steps + 1 (the pre-loop initial-state
    // snapshot counts as frame 0; per-step records start at index 1).
    let total_frames = ca_opts.macro_steps + 1;
    let n_cells = sphere.vertices.len() as u32;
    let mut encoder = FrameEncoder::new(
        total_frames,
        n_cells,
        ca_opts.dt_ma,
        10,                       // keyframe stride (every 10 frames = 50 Ma)
        seed as u32,              // master_seed truncated to u32 for the header
    );
    encoder.write_header();
    encoder.write_initial_state(&plates, &crust, &motions, None);
    let stats = evolve_ca_with_encoder(
        &mut plates,
        &mut crust,
        &sphere.vertices,
        &adjacency,
        &mut motions,
        ca_opts,
        &mut metrics,
        &mut encoder,
    );
    let ca_elapsed = ca_start.elapsed();
    eprintln!(
        "CA: {} convergent · {} divergent · {} fork spawns · {} failed rifts · {:?}",
        stats.total_swaps, stats.total_divergent_resets,
        stats.total_fork_spawns, stats.total_failed_rifts, ca_elapsed,
    );

    // Re-extract boundary edges from the post-CA cell_plate so the viewer
    // renders the actual evolved boundaries (not the pre-CA Power Diagram ones).
    let (new_boundary_edges, new_triple_junctions) =
        hayba_tectonics::plates::extract_boundary_topology(&plates.cell_plate, &adjacency);
    plates.boundary_edges = new_boundary_edges;
    plates.triple_junctions = new_triple_junctions;
    eprintln!(
        "Post-CA boundaries: {} edges · {} triple junctions",
        plates.boundary_edges.len(), plates.triple_junctions.len(),
    );
    let n_oceanic = plates.plate_compositions().iter()
        .filter(|c| matches!(c, Some(hayba_tectonics::crust_state::Composition::Oceanic))).count();
    let n_cont = plates.plate_compositions().iter()
        .filter(|c| matches!(c, Some(hayba_tectonics::crust_state::Composition::Continental | hayba_tectonics::crust_state::Composition::Island))).count();
    let max_age = *crust.age_ma.iter().max().unwrap_or(&0);
    eprintln!(
        "Crust: {} oceanic plates · {} continental plates · max age {} Ma",
        n_oceanic, n_cont, max_age,
    );

    let mut kind_counts = [0u32; 4];
    for k in &classification.kinds { kind_counts[*k as usize] += 1; }
    eprintln!(
        "Boundaries: {} divergent · {} convergent · {} transform · {} oblique",
        kind_counts[0], kind_counts[1], kind_counts[2], kind_counts[3],
    );

    let json = dump_world_json(seed, subdivisions, &sphere, &plates, &motions, &voronoi, &classification, &crust);

    let workspace_root = workspace_root();
    let out_dir = workspace_root.join("viz").join("data");
    fs::create_dir_all(&out_dir).expect("create viz/data dir");
    let out_path = out_dir.join("world.json");
    fs::write(&out_path, &json).expect("write world.json");

    eprintln!("Wrote {} ({} bytes)", out_path.display(), json.len());

    // ── A1: dump world.bin (binary delta stream) alongside world.json ──
    let bin_path = out_dir.join("world.bin");
    let bin_bytes = encoder.finish();
    fs::write(&bin_path, &bin_bytes).expect("write world.bin");
    eprintln!("Wrote {} ({} bytes)", bin_path.display(), bin_bytes.len());

    // ── M0.15 metrics summary (stderr only; viewer integration TBD) ──
    eprintln!();
    eprintln!("metrics summary (final values):");
    eprintln!("  plate_count          : {:.1}", metrics.plate_count.last());
    eprintln!("  spawn_count          : {:.0}", metrics.spawn_count.last());
    eprintln!("  death_count          : {:.0}", metrics.death_count.last());
    eprintln!("  lifespans recorded   : {}",   metrics.plate_lifespans.len());
    eprintln!("  oceanic_fraction     : {:.3}", metrics.oceanic_fraction.last());
    eprintln!("  supercontinent_index : {:.3} (peak {:.3})",
        metrics.supercontinent_index.last(), metrics.supercontinent_index.max());
    eprintln!("  mean_plate_velocity  : {:.3} cm/yr (max {:.3})",
        metrics.mean_plate_velocity.last(), metrics.max_plate_velocity.max());
    eprintln!("  boundary div/conv/tr : {:.1}% / {:.1}% / {:.1}%",
        metrics.boundary_divergent_pct.last(),
        metrics.boundary_convergent_pct.last(),
        metrics.boundary_transform_pct.last());
    eprintln!("  age_p50              : {:.1} Ma", metrics.age_p50.last());
    eprintln!("  pareto_alpha         : {:.3}", metrics.plate_size_pareto_alpha.last());
    eprintln!("  lip_fires_total      : {}",   metrics.lip_fires_total);
    eprintln!("  aulacogen_count      : {:.0}", metrics.aulacogen_count.last());
    eprintln!("  mor_axis_length      : {:.3}", metrics.mor_axis_length.last());
    eprintln!("  transform_segments   : {}",   metrics.transform_segments_total);
}

fn workspace_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut p = manifest.clone();
    loop {
        if p.join("Cargo.toml").exists() && p != manifest {
            return p;
        }
        if !p.pop() { return manifest; }
    }
}
