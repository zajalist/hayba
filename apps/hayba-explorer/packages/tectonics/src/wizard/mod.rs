//! User-drawn continent input parsing (the "wizard" intake step).
//!
//! Hayba extension. Accepts a stylized continent sketch -> initial plate seed positions.
//!
//! Phase 7 Task 7.1 — orbital parameter schema + presets.

use serde::{Deserialize, Serialize};

/// Orbital / insolation parameters fed to the climate + Milankovitch subsystems.
///
/// All angles in degrees, distances in AU, irradiance in W/m^2, periods in
/// kiloyears (ka). Period fields drive long-term Milankovitch-style forcing;
/// for bodies where a cycle is physically meaningless (e.g. tidally-locked
/// worlds) the corresponding period is set to `0.0` and treated as inert by
/// downstream code.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct OrbitalParams {
    pub axial_tilt_deg: f64,
    pub eccentricity: f64,
    pub semi_major_axis_au: f64,
    pub solar_constant_w_m2: f64,
    pub axial_precession_period_ka: f64,
    pub eccentricity_period_ka: f64,
    pub obliquity_period_ka: f64,
}

impl OrbitalParams {
    /// Present-day Earth.
    pub fn earth() -> Self {
        Self {
            axial_tilt_deg: 23.44,
            eccentricity: 0.0167,
            semi_major_axis_au: 1.0,
            solar_constant_w_m2: 1361.0,
            axial_precession_period_ka: 26.0,
            eccentricity_period_ka: 100.0,
            obliquity_period_ka: 41.0,
        }
    }

    /// Mars-like cold desert world.
    pub fn mars_like() -> Self {
        Self {
            axial_tilt_deg: 25.0,
            eccentricity: 0.093,
            semi_major_axis_au: 1.52,
            solar_constant_w_m2: 589.0,
            axial_precession_period_ka: 170.0,
            eccentricity_period_ka: 95.0,
            obliquity_period_ka: 120.0,
        }
    }

    /// Venus-like hot retrograde world (tilt > 90° => retrograde rotation).
    pub fn venus_like() -> Self {
        Self {
            axial_tilt_deg: 177.0,
            eccentricity: 0.007,
            semi_major_axis_au: 0.72,
            solar_constant_w_m2: 2601.0,
            axial_precession_period_ka: 26.0,
            eccentricity_period_ka: 100.0,
            obliquity_period_ka: 41.0,
        }
    }

    /// Tidally-heated moon orbiting a hot Jupiter at ~5.2 AU.
    pub fn hot_jupiter_moon() -> Self {
        Self {
            axial_tilt_deg: 0.0,
            eccentricity: 0.01,
            semi_major_axis_au: 5.2,
            solar_constant_w_m2: 50.0,
            axial_precession_period_ka: 100.0,
            eccentricity_period_ka: 100.0,
            obliquity_period_ka: 100.0,
        }
    }

    /// Glacial / "snowball" Earth variant: reduced insolation, lower tilt.
    pub fn glacial() -> Self {
        Self {
            axial_tilt_deg: 22.0,
            eccentricity: 0.0167,
            semi_major_axis_au: 1.0,
            solar_constant_w_m2: 1280.0,
            axial_precession_period_ka: 26.0,
            eccentricity_period_ka: 100.0,
            obliquity_period_ka: 41.0,
        }
    }

    /// Tidally-locked close-in world. All Milankovitch periods are inert
    /// (set to 0.0) because the rotation/orbit configuration removes the
    /// underlying cycles.
    pub fn tidally_locked() -> Self {
        Self {
            axial_tilt_deg: 0.0,
            eccentricity: 0.0,
            semi_major_axis_au: 0.05,
            solar_constant_w_m2: 1361.0,
            axial_precession_period_ka: 0.0,
            eccentricity_period_ka: 0.0,
            obliquity_period_ka: 0.0,
        }
    }
}

impl Default for OrbitalParams {
    fn default() -> Self {
        Self::earth()
    }
}

/// Top-level wizard input (library-side scaffold).
///
/// The `te-port` binary currently parses its own richer `WizardInput`; this
/// library-side struct hosts the orbital params for future consolidation.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WizardInput {
    #[serde(default)]
    pub orbital: OrbitalParams,
}

impl Default for WizardInput {
    fn default() -> Self {
        Self {
            orbital: OrbitalParams::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(p: &OrbitalParams) {
        let s = serde_json::to_string(p).expect("serialize");
        let back: OrbitalParams = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(p, &back);
    }

    #[test]
    fn earth_preset_roundtrips() {
        let p = OrbitalParams::earth();
        roundtrip(&p);
        assert!((p.eccentricity - 0.0167).abs() < 1e-9);
        assert!((p.axial_tilt_deg - 23.44).abs() < 1e-9);
    }

    #[test]
    fn mars_preset_roundtrips() {
        roundtrip(&OrbitalParams::mars_like());
    }

    #[test]
    fn venus_preset_roundtrips() {
        let p = OrbitalParams::venus_like();
        roundtrip(&p);
        assert!(p.axial_tilt_deg > 90.0, "venus is retrograde");
    }

    #[test]
    fn hot_jupiter_moon_preset_roundtrips() {
        roundtrip(&OrbitalParams::hot_jupiter_moon());
    }

    #[test]
    fn glacial_preset_roundtrips() {
        let p = OrbitalParams::glacial();
        roundtrip(&p);
        assert!(p.solar_constant_w_m2 < OrbitalParams::earth().solar_constant_w_m2);
    }

    #[test]
    fn tidally_locked_has_zero_periods() {
        let p = OrbitalParams::tidally_locked();
        roundtrip(&p);
        assert_eq!(p.axial_precession_period_ka, 0.0);
        assert_eq!(p.eccentricity_period_ka, 0.0);
        assert_eq!(p.obliquity_period_ka, 0.0);
    }

    #[test]
    fn wizard_input_defaults_to_earth() {
        let w = WizardInput::default();
        assert_eq!(w.orbital, OrbitalParams::earth());
        let s = serde_json::to_string(&w).expect("serialize");
        let back: WizardInput = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(w, back);
    }
}
