//! Lithospheric column: thickness, thermal state, density.
//!
//! Hayba extension. No direct tectonic-explorer counterpart — TE models the
//! mantle only as an abstract force-generating `HotSpot` per plate. Hayba
//! models the lithospheric mantle (rigid uppermost mantle, below the crust
//! and above the asthenosphere) as a per-field column.
//!
//! ## References
//!
//! * Stein & Stein (1992), "A model for the global variation in oceanic
//!   depth and heat flow with lithospheric age", *Nature* 359, 123–129 —
//!   the half-space cooling model that gives `thickness ∝ √age`.
//! * Artemieva (2009), "The continental lithosphere: reconciling thermal,
//!   seismic, and petrologic data", *Lithos* 109, 23–46 — continental
//!   lithospheric mantle thickness distribution (~150–250 km).
//!
//! Densities and the LAB temperature anchor are from standard mantle
//! reference values: asthenosphere ≈ 3300 kg/m³, MORB-source mantle
//! ≈ 3300 kg/m³, sub-continental lithospheric mantle ≈ 3250 kg/m³, with
//! LAB roughly tracking the 1300 °C (1573 K) isotherm.

use serde::{Deserialize, Serialize};

/// Density of the asthenosphere (kg/m³). Reference value used as the
/// buoyancy datum: a column with this density floats neutrally.
pub const ASTHENOSPHERE_DENSITY_KG_M3: f32 = 3300.0;

/// Standard gravity (m/s²).
pub const GRAVITY_M_S2: f32 = 9.81;

/// Stein-Stein 1992 cooling coefficient. Tuned so that 100 Ma oceanic
/// lithosphere has thickness ≈ 110 km (matches observed Pacific basin
/// thickness within the half-space-cooling regime).
pub const OCEANIC_COOLING_COEFF: f32 = 11.0;

/// Maximum oceanic lithospheric mantle thickness (km). The half-space
/// cooling solution diverges at large ages; observations show saturation
/// near 125–150 km as the plate model takes over from half-space
/// cooling. We cap at 150 km.
pub const MAX_OCEANIC_LITHOSPHERE_KM: f32 = 150.0;

/// Continental lithospheric mantle thickness bounds (km). Artemieva 2009.
pub const MIN_CONTINENTAL_LITHOSPHERE_KM: f32 = 150.0;
pub const MAX_CONTINENTAL_LITHOSPHERE_KM: f32 = 250.0;

/// LAB temperature anchor (K). ≈ 1300 °C.
pub const LAB_TEMPERATURE_K: f32 = 1573.0;

/// Per-field lithospheric mantle column. Lives *under* the crust column
/// and *above* the asthenosphere.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LithosphericColumn {
    /// Thickness of the lithospheric mantle (km), below the crust.
    pub mantle_thickness_km: f32,
    /// Temperature at the lithosphere-asthenosphere boundary (K).
    pub lab_temperature_k: f32,
    /// Mean density (kg/m³). Drives buoyancy / slab pull.
    pub density_kg_m3: f32,
}

impl LithosphericColumn {
    /// Stein-Stein 1992 half-space cooling: oceanic lithospheric mantle
    /// thickness grows as √age.
    ///
    /// `thickness_km = OCEANIC_COOLING_COEFF * sqrt(age_ma)`, capped at
    /// [`MAX_OCEANIC_LITHOSPHERE_KM`]. Density rises with thickness
    /// (and therefore mean coldness) from ~3300 kg/m³ at the ridge to
    /// ~3330 kg/m³ for the oldest slabs — the gradient that makes old
    /// oceanic lithosphere negatively buoyant and drives slab pull.
    pub fn oceanic_from_age(age_ma: f32) -> Self {
        let thickness = (OCEANIC_COOLING_COEFF * age_ma.max(0.0).sqrt())
            .min(MAX_OCEANIC_LITHOSPHERE_KM);
        // Density ramp 3300→3330 kg/m³ as the column ages.
        // Hayba interpolation, NOT from Stein-Stein (their paper only
        // models thermal thickness). The qualitative direction matches
        // real Δρ ~30 kg/m³ over the lithospheric age range.
        let density = ASTHENOSPHERE_DENSITY_KG_M3
            + (thickness / MAX_OCEANIC_LITHOSPHERE_KM) * 30.0;
        Self {
            mantle_thickness_km: thickness,
            lab_temperature_k: LAB_TEMPERATURE_K,
            density_kg_m3: density,
        }
    }

    /// Continental lithospheric mantle is generally thicker (150–250 km,
    /// Artemieva 2009) and doesn't depend on age the same way. Density
    /// is set slightly below asthenosphere (≈3250 kg/m³) reflecting the
    /// depleted, less-fertile composition of cratonic mantle (which is
    /// why continents persist for billions of years).
    pub fn continental(thickness_km: f32) -> Self {
        Self {
            mantle_thickness_km: thickness_km
                .clamp(MIN_CONTINENTAL_LITHOSPHERE_KM, MAX_CONTINENTAL_LITHOSPHERE_KM),
            lab_temperature_k: LAB_TEMPERATURE_K,
            density_kg_m3: 3250.0,
        }
    }

    /// Net buoyancy of the column relative to asthenosphere, expressed
    /// as a pressure (N/m² = kg / (m·s²)) using
    /// `(ρ_astheno − ρ_col) * thickness * g`.
    ///
    /// Positive = buoyant (floats), negative = sinks. Old oceanic
    /// lithosphere becomes negatively buoyant — this is the driver of
    /// slab pull and one of the dominant forces in plate tectonics.
    pub fn buoyancy_kgm2(&self) -> f32 {
        (ASTHENOSPHERE_DENSITY_KG_M3 - self.density_kg_m3)
            * self.mantle_thickness_km
            * 1000.0
            * GRAVITY_M_S2
    }
}

impl Default for LithosphericColumn {
    /// Default to a young oceanic column (age 0 ⇒ thickness 0, density
    /// equal to asthenosphere ⇒ neutral buoyancy).
    fn default() -> Self {
        Self::oceanic_from_age(0.0)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oceanic_thickness_grows_with_age() {
        let young = LithosphericColumn::oceanic_from_age(10.0);
        let old = LithosphericColumn::oceanic_from_age(100.0);
        assert!(old.mantle_thickness_km > young.mantle_thickness_km);
    }

    #[test]
    fn oceanic_thickness_saturates_at_old_age() {
        let extremely_old = LithosphericColumn::oceanic_from_age(1_000.0);
        assert!(extremely_old.mantle_thickness_km <= MAX_OCEANIC_LITHOSPHERE_KM);
    }

    #[test]
    fn old_oceanic_lithosphere_becomes_negatively_buoyant() {
        let old = LithosphericColumn::oceanic_from_age(150.0);
        assert!(
            old.buoyancy_kgm2() <= 0.0,
            "old oceanic lithosphere should sink, got buoyancy {}",
            old.buoyancy_kgm2()
        );
    }

    #[test]
    fn continental_stays_buoyant() {
        let cont = LithosphericColumn::continental(200.0);
        assert!(
            cont.buoyancy_kgm2() > 0.0,
            "continental lithosphere should be buoyant, got {}",
            cont.buoyancy_kgm2()
        );
    }

    #[test]
    fn continental_thickness_clamps_to_realistic_range() {
        let too_thin = LithosphericColumn::continental(50.0);
        assert_eq!(too_thin.mantle_thickness_km, MIN_CONTINENTAL_LITHOSPHERE_KM);
        let too_thick = LithosphericColumn::continental(400.0);
        assert_eq!(too_thick.mantle_thickness_km, MAX_CONTINENTAL_LITHOSPHERE_KM);
    }

    #[test]
    fn oceanic_age_zero_has_zero_thickness_and_neutral_buoyancy() {
        let ridge = LithosphericColumn::oceanic_from_age(0.0);
        assert_eq!(ridge.mantle_thickness_km, 0.0);
        assert!(ridge.buoyancy_kgm2().abs() < 1e-3);
    }

    #[test]
    fn oceanic_100ma_thickness_about_110km() {
        // Sanity check that the cooling coefficient is tuned to real data.
        let mature = LithosphericColumn::oceanic_from_age(100.0);
        assert!(
            (mature.mantle_thickness_km - 110.0).abs() < 5.0,
            "100 Ma oceanic lithosphere should be ~110 km, got {}",
            mature.mantle_thickness_km
        );
    }

    #[test]
    fn serializes_round_trip() {
        let c = LithosphericColumn::oceanic_from_age(75.0);
        let bytes = bincode::serialize(&c).unwrap();
        let d: LithosphericColumn = bincode::deserialize(&bytes).unwrap();
        assert_eq!(c, d);
    }
}
