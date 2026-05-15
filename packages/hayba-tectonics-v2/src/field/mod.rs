//! Field state.
//!
//! Port target: tectonic-explorer's `src/plates-model/field.ts` +
//! `field-base.ts`. The TS class hierarchy is flattened to a single struct.
//!
//! Frozen reference: `docs/research/te-snapshot/plates-model/`.

pub mod field;

pub use field::{Crust, Field, Subduction, VolcanicActivity};
