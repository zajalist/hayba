//! Phase 10.1 audit harness — dumps Rust peels per-cell (id, xyz, neighbors).
//!
//! Usage: `cargo run --release --bin dump_peels -- 32 > out.json`

use std::env;

use hayba_tectonics_v2::sphere::Grid;

fn main() {
    let div: u32 = env::args().nth(1).unwrap_or_else(|| "32".into()).parse().expect("divisions");
    let grid = Grid::new(div);
    let n = grid.n_fields();

    print!("{{\"divisions\":{},\"n_cells\":{},\"cells\":[", div, n);
    let mut first = true;
    for id in 0..n {
        if !first { print!(","); } else { first = false; }
        let p = grid.position(id);
        let nbs = grid.neighbours(id);
        let mut nb_padded: Vec<String> = nbs.iter().map(|i| i.to_string()).collect();
        // Pad pentagons to length 6 with null so the JSON shape matches TS.
        while nb_padded.len() < 6 {
            nb_padded.push("null".into());
        }
        print!(
            "{{\"id\":{},\"xyz\":[{},{},{}],\"neighbors\":[{}]}}",
            id,
            p.x,
            p.y,
            p.z,
            nb_padded.join(",")
        );
    }
    println!("]}}");

    eprintln!("wrote {} cells, divisions={}", n, div);
}
