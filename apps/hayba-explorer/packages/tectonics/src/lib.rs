//! `hayba-tectonics-v2`
//!
//! High-fidelity Rust port of Concord Consortium's tectonic-explorer simulation,
//! plus Hayba climate / biome / mantle / erosion extensions.
//!
//! Phase 0 scaffold — module skeleton only. Each submodule will be filled in
//! during later phases. See the megasprint plan for details.

pub mod sphere;
pub use sphere::{Grid, VoronoiSphere};
pub mod field;
pub mod plate;
pub mod subduction;
pub mod crust;
pub mod rock;
pub mod erosion;
pub mod climate;
pub mod milankovitch;
pub mod mantle;
pub mod time;
pub mod frame_stream;
pub mod export;
pub mod determinism;
pub mod wizard;
pub mod model;
pub mod save;
