//! Multi-layer crust state.
//!
//! Port target: tectonic-explorer's `src/plates-model/crust.ts`.
//! Frozen reference: `docs/research/te-snapshot/plates-model/crust.ts`.
//!
//! # Hayba uses SI meters for crust thickness.
//!
//! TE's `crust.ts` uses dimensionless "model units" where 1 unit ≈ ~7–13 km.
//! For example `BASE_OCEANIC_CRUST_THICKNESS = 0.5` model units stands in
//! for ~7 km of real-world oceanic basement. Hayba deliberately departs
//! from that convention to make geology readable and to share units with
//! the rest of the engine (elevation, depth, etc.).
//!
//! When porting downstream TE code that uses thickness or elevation
//! constants, apply the conversions below. Future ports of TE's
//! `addVolcanicRocks`, `addSediment`, `subduct`, and `uplift` MUST
//! multiply / divide TE constants by these factors on the way in.

/// TE model-unit → meters.
///
/// Derivation: TE's `BASE_OCEANIC_CRUST_THICKNESS = 0.5` model units is
/// described in `crust.ts:48` as "in real world: 6-12km, 7-10km on average".
/// Hayba picks 7 km as the canonical oceanic basement thickness
/// (see [`column::DEFAULT_OCEANIC_BASEMENT_THICKNESS_M`]), so
/// 0.5 model units ↔ 7000 m ⇒ 1 model unit ↔ 14 000 m.
pub const TE_UNIT_TO_METERS: f32 = 14_000.0;

/// Hayba's continental isostasy ratio: meters of crust thickness per
/// meter of surface elevation.
///
/// TE uses `CRUST_THICKNESS_TO_ELEVATION_RATIO = 0.6` (`crust.ts:47`) in
/// model units; that ratio is a model-tuning constant and not real
/// isostasy. The Airy isostatic model with continental crust ρ ≈ 2750
/// kg/m³ over mantle ρ ≈ 3300 kg/m³ gives a root depth of about 5.7 m
/// per metre of topography. Hayba uses this real value.
pub const ISOSTASY_CRUST_PER_ELEV_METERS: f32 = 5.7;

pub mod column;

pub use column::{
    CrustColumn, Layer, DEFAULT_CONTINENTAL_BASEMENT_THICKNESS_M,
    DEFAULT_OCEANIC_BASEMENT_THICKNESS_M, MAX_CRUST_THICKNESS_BASE_M,
    MAX_CRUST_THICKNESS_VARIATION_M, SUBDUCTION_UPLIFT_MIN_TIME_MA,
    SUBDUCTION_UPLIFT_TIME_VARIATION_MA,
};
