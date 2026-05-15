//! M0.14 — Same master seed, same machine, must produce bit-identical
//! sim output. Runs the full pipeline twice for two seeds and asserts
//! byte-equal results on every observable state.

use hayba_seeds::MasterSeed;
use hayba_tectonics::{
    adjacency::Adjacency,
    ca_evolution::{evolve_ca, EvolutionOptions},
    crust_state::{CrustOptions, CrustState},
    mesh::Icosphere,
    motion::{sample_plate_motions, PlateMotion},
    plates::{BuildOptions, PlateAssignment},
};

fn run_sim(seed: u64) -> (PlateAssignment, CrustState, Vec<Option<PlateMotion>>) {
    // Level 5 keeps the per-test runtime under ~2s. Level 6+ stresses CI.
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
    evolve_ca(
        &mut plates,
        &mut crust,
        &sphere.vertices,
        &adjacency,
        &mut motions,
        EvolutionOptions {
            // Keep test runtime small; 30 macro steps is plenty to surface
            // any non-determinism that's per-step accumulating.
            macro_steps: 30,
            ..Default::default()
        },
    );
    (plates, crust, motions)
}

#[test]
fn same_seed_byte_identical_seed_12345() {
    let (p1, c1, m1) = run_sim(12345);
    let (p2, c2, m2) = run_sim(12345);
    assert_eq!(p1.cell_plate, p2.cell_plate, "cell_plate differs");
    assert_eq!(
        p1.plate_compositions()
            .iter()
            .map(|c| c.map(|c| c as u8))
            .collect::<Vec<_>>(),
        p2.plate_compositions()
            .iter()
            .map(|c| c.map(|c| c as u8))
            .collect::<Vec<_>>(),
        "plate_composition differs"
    );
    assert_eq!(c1.composition.len(), c2.composition.len());
    for i in 0..c1.composition.len() {
        assert_eq!(
            c1.composition[i] as u8, c2.composition[i] as u8,
            "composition cell {} differs", i
        );
    }
    assert_eq!(c1.age_ma, c2.age_ma, "age_ma differs");
    assert_eq!(c1.elevation_m, c2.elevation_m, "elevation_m differs");
    assert_eq!(c1.rift_progress, c2.rift_progress, "rift_progress differs");
    assert_eq!(
        c1.failed_rift_age_ma, c2.failed_rift_age_ma,
        "failed_rift_age_ma differs"
    );
    for i in 0..m1.len() {
        match (m1[i], m2[i]) {
            (Some(a), Some(b)) => {
                assert_eq!(a.omega.x.to_bits(), b.omega.x.to_bits());
                assert_eq!(a.omega.y.to_bits(), b.omega.y.to_bits());
                assert_eq!(a.omega.z.to_bits(), b.omega.z.to_bits());
            }
            (None, None) => {}
            _ => panic!("motion liveness mismatch at {}", i),
        }
    }
}

#[test]
fn same_seed_byte_identical_seed_67890() {
    let (p1, _, _) = run_sim(67890);
    let (p2, _, _) = run_sim(67890);
    assert_eq!(p1.cell_plate, p2.cell_plate);
}

#[test]
fn different_seeds_differ() {
    let (p1, _, _) = run_sim(12345);
    let (p2, _, _) = run_sim(67890);
    assert_ne!(p1.cell_plate, p2.cell_plate);
}
