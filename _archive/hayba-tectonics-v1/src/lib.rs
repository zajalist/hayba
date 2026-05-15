//! Hayba tectonic simulation core — full Wilson-cycle plate dynamics on a
//! discrete icosphere mesh.
//!
//! ## Modules
//!
//! - [`mesh`] — icosphere subdivision + `Vec3f` math primitives.
//! - [`adjacency`] — vertex 1-ring adjacency used by every cellular pass.
//! - [`sphere_geom`] — shared tangent-plane / spherical helpers.
//! - [`power_diagram`] — Fibonacci-spiral seed placement with Pareto weights
//!   (Bird-2003 bimodal plate-size distribution).
//! - [`voronoi`] — continuous triple-junction extraction for visualization.
//! - [`plates`] — plate registry, Voronoi/Power assignment, junction sweep.
//! - [`crust_state`] — per-cell composition / age / layered-rock thickness.
//! - [`motion`] — Euler-pole plate motion + slab-pull / drag evolution.
//! - [`mor`] — first-class mid-ocean-ridge entities (M0.9).
//! - [`hotspots`] — mantle hotspots leaving volcanic chains (M0.12).
//! - [`lifecycle`] — atomic spawn / retire, rift fork, passive CC split,
//!   invariant assertions.
//! - [`ca_evolution`] — per-step cellular-automaton crust update.
//! - [`macro_step`] — orchestrator that wires CA, lifecycle, and motion.
//! - [`boundaries`] / [`boundary_detail`] — boundary classification + decoration.
//! - [`topology`] — triple-junction topology bookkeeping.
//! - [`output`] — JSON export for the web viewer.
//!
//! ## M0 invariants
//!
//! All five are enforced in debug builds at every macro-step boundary; see
//! [`lifecycle::assert_invariants`], [`lifecycle::assert_inv3_one_cc_per_plate`],
//! and [`lifecycle::detect_quad_junctions`].
//!
//! - **INV-1** every live plate has ≥1 cell
//! - **INV-2** every cell references a live plate slot
//! - **INV-3** no live plate has >1 connected component (post-enforcement)
//! - **INV-4** `|motions| == |plates|` and liveness is lock-step
//! - **INV-5** no mesh vertex sits at a quad+ junction (only triple junctions)
//!
//! ## Determinism contract
//!
//! Bit-exact within a single architecture, given the same `MasterSeed`. The
//! lifecycle / CA paths use `BTreeMap` and `BTreeSet` exclusively (never
//! `HashMap`), iterate sorted slices, and consume per-scope `SeedStream`s
//! derived from the master seed. Float math is allowed in this pass;
//! cross-architecture bit-exactness is deferred to the future fixed-point
//! port. See `tests/determinism.rs` for the regression suite.

pub mod adjacency;
pub mod boundaries;
pub mod boundary_detail;
pub mod ca_evolution;
pub mod crust_state;
pub mod drainage;
pub mod erosion;
pub mod frame_stream;
pub mod hotspots;
pub mod initial_elevation;
pub mod lifecycle;
pub mod macro_step;
pub mod mesh;
pub mod metrics;
pub mod mor;
pub mod motion;
pub mod output;
pub mod plates;
pub mod power_diagram;
pub mod sphere_geom;
pub mod topology;
pub mod voronoi;

pub use mesh::{Icosphere, Vec3f};
pub use plates::{Plate, PlateAssignment};
