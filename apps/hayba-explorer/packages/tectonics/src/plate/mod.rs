//! Plate + PlateGroup + Verlet motion.
//!
//! Port target: tectonic-explorer's `src/plates-model/plate.ts` and `plate-group.ts`.
//! Frozen reference: `docs/research/te-snapshot/plates-model/`.
//!
pub mod plate;
pub mod plate_group;

pub use plate::{
    Forces, HotSpot, Plate, SubPlate, BASIC_DRAG_FORCE_MOD, CONTINENT_DENSITY,
    HOT_SPOT_TORQUE_DECREASE, MASS_MODIFIER, OCEAN_DENSITY,
};
pub use plate_group::{AngularMotion, PlateGroup};
