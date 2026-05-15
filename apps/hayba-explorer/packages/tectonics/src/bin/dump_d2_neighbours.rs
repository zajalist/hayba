//! One-shot helper: dumps d=2 neighbour arrays to stdout as JSON.
//! Used to bootstrap the peels_neighbor_fixture test; not part of the runtime.
use hayba_tectonics_v2::sphere::VoronoiSphere;

fn main() {
    let s = VoronoiSphere::new(2);
    println!("[");
    let n = s.n_fields();
    for i in 0..n {
        let nb = s.neighbours(i);
        let arr: Vec<String> = nb.iter().map(|x| x.to_string()).collect();
        let comma = if i + 1 < n { "," } else { "" };
        println!("  [{}]{}", arr.join(", "), comma);
    }
    println!("]");
}
