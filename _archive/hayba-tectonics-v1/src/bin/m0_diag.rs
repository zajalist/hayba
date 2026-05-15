//! M0 lifecycle diagnostic — verifies invariants AND prints per-plate area
//! distribution + lifecycle event counts after a full default sim run.
//!
//! Usage:
//!     cargo run -p hayba-tectonics --bin m0-diag --release [seed]

use hayba_seeds::MasterSeed;
use hayba_tectonics::{
    adjacency::Adjacency,
    ca_evolution::{evolve_ca, EvolutionOptions},
    crust_state::{Composition, CrustOptions, CrustState},
    lifecycle::{assert_invariants, detect_quad_junctions, assert_inv3_one_cc_per_plate},
    mesh::Icosphere,
    motion::sample_plate_motions,
    plates::{BuildOptions, PlateAssignment},
};

fn main() {
    let seed: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(12345);

    eprintln!("=== M0 diagnostic: seed = {} ===", seed);

    let sphere = Icosphere::new_rotated(7,
        (seed as f64).sin() * 0.5,
        (seed as f64 * 1.7).cos() * 0.5,
        (seed as f64 * 2.3).sin() * 0.5,
    );
    let adjacency = Adjacency::build(&sphere);
    let mut plates = PlateAssignment::build(
        MasterSeed(seed), &sphere,
        BuildOptions { plate_count: 50, ..BuildOptions::default() },
    );
    let mut motions = sample_plate_motions(MasterSeed(seed), 50);
    plates.prune_empty(&mut motions);

    let plate_seeds: Vec<_> = plates.plates.iter()
        .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
    let mut crust = CrustState::initial(
        MasterSeed(seed), &sphere.vertices, &mut plates,
        &plate_seeds, CrustOptions::default(),
    );

    // Initial state check.
    assert_invariants(&plates, &motions);
    eprintln!("init: registry={} live={} cells={}",
        plates.plates.len(), plates.live_count(), plates.cell_plate.len());
    print_area_distribution(&plates, "init");

    // Run the full CA loop.
    let stats = evolve_ca(
        &mut plates, &mut crust, &sphere.vertices, &adjacency,
        &mut motions, EvolutionOptions::default(),
    );

    // Post-sim invariant + area check.
    assert_invariants(&plates, &motions);
    assert_inv3_one_cc_per_plate(&plates, &adjacency);
    let quad_junctions = detect_quad_junctions(&plates, &adjacency);
    if !quad_junctions.is_empty() {
        eprintln!();
        eprintln!("⚠️  INV-5 VIOLATION — found {} quad+ junctions", quad_junctions.len());
        for &v in quad_junctions.iter().take(10) {
            let p_v = plates.cell_plate[v as usize];
            let neighbors: Vec<u32> = adjacency.of(v).iter().map(|&nb| plates.cell_plate[nb as usize]).collect();
            eprintln!("  vertex {} plate={} neighbour plates={:?}", v, p_v, neighbors);
        }
        if quad_junctions.len() > 10 {
            eprintln!("  ... and {} more", quad_junctions.len() - 10);
        }
    } else {
        eprintln!();
        eprintln!("INV-5 OK — no quad+ junctions");
    }
    eprintln!();
    eprintln!("post-CA: registry={} live={} (spawns={} failed_rifts={})",
        plates.plates.len(), plates.live_count(),
        stats.total_fork_spawns, stats.total_failed_rifts);

    print_area_distribution(&plates, "post-CA");

    // Lineage report.
    let mut by_parent: std::collections::BTreeMap<u32, Vec<u32>> = Default::default();
    for (id, p) in plates.live_plates() {
        if let Some(pid) = p.parent_id {
            by_parent.entry(pid).or_default().push(id);
        }
    }
    if !by_parent.is_empty() {
        eprintln!();
        eprintln!("lineage: {} parent plates produced {} children",
            by_parent.len(),
            by_parent.values().map(|v| v.len()).sum::<usize>());
        for (parent, children) in &by_parent {
            eprintln!("  plate {} -> {:?}", parent, children);
        }
    }

    // Rift / aulacogen report.
    let mature_rift: usize = crust.rift_progress.iter().filter(|&&p| p >= 180).count();
    let aulacogen: usize = crust.failed_rift_age_ma.iter().filter(|&&a| a > 0).count();
    eprintln!();
    eprintln!("rift state: mature cells={} aulacogen cells={}", mature_rift, aulacogen);

    // Composition report.
    let n_oceanic = crust.composition.iter().filter(|&&c| c == Composition::Oceanic).count();
    let n_island = crust.composition.iter().filter(|&&c| c == Composition::Island).count();
    let n_cont = crust.composition.iter().filter(|&&c| c == Composition::Continental).count();
    let total = crust.composition.len();
    eprintln!("composition: oceanic={:.1}% island={:.1}% continental={:.1}%",
        100.0 * n_oceanic as f64 / total as f64,
        100.0 * n_island as f64 / total as f64,
        100.0 * n_cont as f64 / total as f64);

    eprintln!();
    eprintln!("=== invariants HOLD ===");
}

fn print_area_distribution(plates: &PlateAssignment, label: &str) {
    let mut counts = vec![0u32; plates.plates.len()];
    for &id in &plates.cell_plate { counts[id as usize] += 1; }
    let mut live_counts: Vec<(u32, u32)> = counts.iter().enumerate()
        .filter(|(i, _)| plates.plates[*i].is_some())
        .map(|(i, &c)| (i as u32, c)).collect();
    live_counts.sort_by(|a, b| b.1.cmp(&a.1));

    let total: u32 = live_counts.iter().map(|(_, c)| c).sum();
    eprintln!();
    eprintln!("[{}] area distribution ({} live plates, {} cells total):", label, live_counts.len(), total);
    eprintln!("  rank  id      cells    %area");
    for (rank, (id, c)) in live_counts.iter().enumerate().take(20) {
        let pct = 100.0 * *c as f64 / total as f64;
        eprintln!("  {:4}  {:4}  {:8}  {:6.2}%", rank + 1, id, c, pct);
    }
    if live_counts.len() > 20 {
        let tail: u32 = live_counts.iter().skip(20).map(|(_, c)| c).sum();
        eprintln!("  +{} plates totaling {} cells ({:.2}%)",
            live_counts.len() - 20, tail, 100.0 * tail as f64 / total as f64);
    }

    let largest = live_counts.first().map(|(_, c)| *c).unwrap_or(0);
    let smallest = live_counts.last().map(|(_, c)| *c).unwrap_or(0);
    eprintln!("  largest: {} cells ({:.1}%)  smallest: {} cells ({:.3}%)",
        largest, 100.0 * largest as f64 / total as f64,
        smallest, 100.0 * smallest as f64 / total as f64);
}
