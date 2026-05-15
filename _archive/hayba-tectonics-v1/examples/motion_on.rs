use hayba_seeds::MasterSeed;
use hayba_tectonics::{
    adjacency::Adjacency,
    ca_evolution::{evolve_ca, EvolutionOptions},
    crust_state::{CrustOptions, CrustState},
    mesh::Icosphere,
    motion::sample_plate_motions,
    plates::{BuildOptions, PlateAssignment},
};

fn main() {
    let seed = 12345u64;
    let sphere = Icosphere::new_rotated(7, 0.0, 0.0, 0.0);
    let adjacency = Adjacency::build(&sphere);
    let mut plates = PlateAssignment::build(MasterSeed(seed), &sphere,
        BuildOptions { plate_count: 50, ..BuildOptions::default() });
    let mut motions = sample_plate_motions(MasterSeed(seed), 50);
    plates.prune_empty(&mut motions);
    let seeds: Vec<_> = plates.plates.iter().map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default()).collect();
    let mut crust = CrustState::initial(MasterSeed(seed), &sphere.vertices, &mut plates, &seeds, CrustOptions::default());
    let mut opts = EvolutionOptions::default();
    opts.enable_motion_evolution = true;
    let stats = evolve_ca(&mut plates, &mut crust, &sphere.vertices, &adjacency, &mut motions, opts);
    eprintln!("CA: {} convergent · {} divergent · motion updates {} · dω-clamps {} · ω-clamps {}",
        stats.total_swaps, stats.total_divergent_resets,
        stats.motion.updates, stats.motion.d_omega_clamps, stats.motion.omega_clamps);
}
