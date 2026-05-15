//! Pins peels-style neighbour ordering against a frozen fixture for d=2.
//!
//! The fixture lives at `tests/fixtures/peels_d2_neighbours.json`. Fields
//! 0, 1, 2, 3, and 4 were hand-traced from
//! `docs/research/te-snapshot/plates-model/peels/sphere/link.ts`; the
//! remaining entries were dumped from the Rust implementation and locked in
//! as a regression fixture. If a future refactor changes neighbour ordering
//! and this test fails, the change must be deliberate and the fixture
//! re-verified against `link.ts`.
//!
//! Coverage: 42 fields total. Includes both pole pentagons (ids 0, 1), all
//! 10 tropical pentagons (5-neighbour fields), and many interior hex fields
//! — well over the 12-field minimum.

use std::fs;

use hayba_tectonics_v2::sphere::VoronoiSphere;

#[derive(serde::Deserialize)]
struct Fixture {
    divisions: u32,
    n_fields: u32,
    neighbours: Vec<Vec<u32>>,
}

fn load_fixture() -> Fixture {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/peels_d2_neighbours.json"
    );
    let txt = fs::read_to_string(path).expect("fixture file present");
    serde_json::from_str::<Fixture>(&txt).expect("fixture parses")
}

#[test]
fn d2_neighbour_arrays_match_fixture_exactly() {
    let fx = load_fixture();
    let sphere = VoronoiSphere::new(fx.divisions);
    assert_eq!(sphere.n_fields(), fx.n_fields);
    for i in 0..fx.n_fields {
        let got: &[u32] = sphere.neighbours(i);
        let want = &fx.neighbours[i as usize];
        assert_eq!(
            got,
            want.as_slice(),
            "field {} neighbour order mismatch:\n  got:  {:?}\n  want: {:?}",
            i,
            got,
            want
        );
    }
}

#[test]
fn fixture_covers_pentagons_and_hexagons() {
    let fx = load_fixture();
    let pentagons: Vec<usize> = (0..fx.n_fields as usize)
        .filter(|&i| fx.neighbours[i].len() == 5)
        .collect();
    let hexagons: Vec<usize> = (0..fx.n_fields as usize)
        .filter(|&i| fx.neighbours[i].len() == 6)
        .collect();
    assert_eq!(pentagons.len(), 12, "12 pentagon fields expected");
    assert!(hexagons.len() >= 12, "expect plenty of hex coverage too");
    // Sanity: poles (0,1) must be in the pentagon set.
    assert!(pentagons.contains(&0));
    assert!(pentagons.contains(&1));
}
