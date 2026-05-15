//! Lithospheric mantle column + discrete mantle plumes.
//!
//! Hayba extension beyond stock tectonic-explorer. See the submodules for
//! details:
//!
//! * [`column`] — per-field lithospheric column (thickness, density,
//!   buoyancy). Drives slab pull and continental persistence.
//! * [`plume`] — anchored mantle plumes that deposit volcanic material
//!   into the crust above them. Generates plume tracks like Hawaii or
//!   Yellowstone.

pub mod column;
pub mod plume;

pub use column::{
    LithosphericColumn, ASTHENOSPHERE_DENSITY_KG_M3, GRAVITY_M_S2, LAB_TEMPERATURE_K,
    MAX_CONTINENTAL_LITHOSPHERE_KM, MAX_OCEANIC_LITHOSPHERE_KM,
    MIN_CONTINENTAL_LITHOSPHERE_KM, OCEANIC_COOLING_COEFF,
};
pub use plume::{
    MantlePlume, PlumeRegistry, TrackPoint, MAX_PLUME_LIFETIME_MA, MIN_PLUME_LIFETIME_MA,
    PLUME_HEAD_DEPOSIT_M, PLUME_HEAD_DURATION_MA, PLUME_HEAD_RADIUS_RAD,
    PLUME_TAIL_MAX_DEPOSIT_M, PLUME_TAIL_MIN_DEPOSIT_M, PLUME_TAIL_RADIUS_RAD,
};
