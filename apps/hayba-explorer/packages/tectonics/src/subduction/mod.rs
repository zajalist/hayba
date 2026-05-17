//! Collision + subduction detection and dynamics.
//!
//! Port target: tectonic-explorer's `src/plates-model/subduction.ts` and collision logic.
//! Frozen reference: `docs/research/te-snapshot/plates-model/`.
//!
pub mod collision;
pub mod subduction;

pub use collision::{
    detect_field_collisions, detect_field_collisions_opt, resolve_field_collision, CollisionKind,
    FieldCollision,
};
pub use subduction::{
    DetachDecision, Subduction, MAX_SUBDUCTION_DIST, MIN_ANGLE_TO_DETACH,
    MIN_PROGRESS_TO_DETACH, MIN_SPEED_TO_DETACH, REVERT_SUBDUCTION_VEL, SUBDUCTION_WIDTH_KM,
};
