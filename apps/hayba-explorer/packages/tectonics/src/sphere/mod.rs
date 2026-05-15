//! Voronoi sphere + grid.
//!
//! Port target: tectonic-explorer's sphere/grid construction in `src/plates-model/`.
//! Frozen reference: `docs/research/te-snapshot/plates-model/`.
//!
//! This module ports the `peels` icosahedral subdivision library into Rust as
//! [`VoronoiSphere`], and wraps it in a [`Grid`] that adds neighbor adjacency
//! and a nearest-field point lookup.

pub mod voronoi;
pub mod grid;

pub use voronoi::VoronoiSphere;
pub use grid::Grid;
