//! GC — verifies `Grid::for_divisions` cache behaviour + `flat_positions`.

use hayba_tectonics_v2::Grid;
use std::sync::Arc;

#[test]
fn for_divisions_returns_same_arc_on_repeat_call() {
    let a = Grid::for_divisions(4);
    let b = Grid::for_divisions(4);
    assert!(Arc::ptr_eq(&a, &b), "repeat call must return same Arc");
}

#[test]
fn for_divisions_matches_new_field_count() {
    let cached = Grid::for_divisions(4);
    let fresh = Grid::new(4);
    assert_eq!(cached.n_fields(), fresh.n_fields());
}

#[test]
fn flat_positions_length_is_3n() {
    let g = Grid::for_divisions(4);
    let fp = g.flat_positions();
    let n = g.n_fields() as usize;
    assert_eq!(fp.len(), n * 3);
}

#[test]
fn flat_positions_is_cached_within_arc() {
    let g = Grid::for_divisions(4);
    let p1 = g.flat_positions().as_ptr();
    let p2 = g.flat_positions().as_ptr();
    assert_eq!(p1, p2, "flat_positions slice pointer must be stable across calls");
}
