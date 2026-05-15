//! Global tectonic model orchestrator.
//!
//! Port target: tectonic-explorer's `src/plates-model/model.ts` step loop.
//! See [`model::Model`] for the per-step phase breakdown.

pub mod model;

pub use model::{Model, MAX_PLATE_SPEED};
