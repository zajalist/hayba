//! Annual-mean scientific climate model. Pure function of (grid topology,
//! per-cell elevation/ocean, seed). Recomputed every sim step inside
//! `snapshot_model`, so every algorithm here is strictly O(cells).
//! Grounded in the worldbuildingpasta simplified climate model.

use glam::Vec3;

/// Sea-level equatorial mean temperature (°C).
const T_EQUATOR: f32 = 30.0;
/// Equator→pole annual-mean cooling (°C) at sea level.
const T_LAT_DROP: f32 = 50.0;
/// Environmental lapse rate (°C per km) — worldbuildingpasta.
const LAPSE_C_PER_KM: f32 = 4.46;
/// vElevation 1.0 ≈ this many km (matches the shader's elevKm scaling).
const ELEV_KM_SCALE: f32 = 8.0;

/// Latitude in radians from a unit-sphere position (Y-up). 0 = equator,
/// ±π/2 = poles.
pub fn latitude_rad(p: Vec3) -> f32 {
    p.y.clamp(-1.0, 1.0).asin()
}

/// Annual-mean base surface temperature (°C) before continentality /
/// currents. Latitude falloff uses sin²(lat) (smooth, peaks at equator),
/// minus the elevation lapse.
pub fn base_temperature_c(p: Vec3, elevation: f32) -> f32 {
    let s = p.y.clamp(-1.0, 1.0); // sin(lat)
    let elev_km = elevation.max(0.0) * ELEV_KM_SCALE;
    T_EQUATOR - T_LAT_DROP * (s * s) - LAPSE_C_PER_KM * elev_km
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equator_warmer_than_pole() {
        let eq = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 0.0);
        let pole = base_temperature_c(Vec3::new(0.0, 1.0, 0.0), 0.0);
        assert!(eq > 25.0, "equator should be warm, got {}", eq);
        assert!(pole < 0.0, "pole should be freezing, got {}", pole);
        assert!(eq - pole > 40.0, "equator-pole gradient too small");
    }

    #[test]
    fn mountains_are_colder() {
        let lowland = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 0.0);
        let peak = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 1.0);
        assert!(lowland - peak > 30.0, "8km peak should be ~35°C colder");
    }
}
