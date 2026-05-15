//! Zonal-mean temperature / humidity / biome assignment.
//!
//! Hayba extension. No direct tectonic-explorer counterpart. Implements:
//!   * latitude from unit-sphere position (TE convention: `y = sin(lat)`)
//!   * annual-mean surface temperature from insolation + lapse rate
//!   * Hadley-cell-shaped humidity profile, modulated by ocean proximity
//!     and orographic rain shadow
//!   * Köppen-ish biome lookup over (temp, humidity, elevation)
//!
//! Phase 6 Task 6.1. Pure functions + a bulk helper — no wiring into
//! `Model::step` yet.

use crate::sphere::VoronoiSphere;
use crate::wizard::OrbitalParams;
use glam::Vec3;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

/// Convert a unit-sphere position to geographic latitude (radians).
///
/// Sphere convention (see `src/sphere/voronoi.rs`):
///   `x = cos(lat) * cos(lon)`,
///   `y = sin(lat)`,
///   `z = cos(lat) * sin(lon)`.
#[inline]
pub fn cell_latitude_rad(pos: Vec3) -> f64 {
    let y = (pos.y as f64).clamp(-1.0, 1.0);
    y.asin()
}

/// Annual-mean surface temperature (K) for a cell at the given latitude and
/// elevation, parameterised by orbital insolation.
///
/// Model (deliberately simple, see plan):
///   * Annual-mean TOA insolation `S = S0 / 4 * max(0.1, cos(lat))` (the 0.1
///     floor stops polar cells from going to absolute zero).
///   * Linear greenhouse fudge around Earth (255 + 33 + (S-340) * 0.05),
///     clamped to [180, 340] K.
///   * Dry adiabatic-ish lapse 6.5 K / km.
pub fn temperature_k(lat_rad: f64, elev_m: f64, orbital: &OrbitalParams) -> f64 {
    let cos_lat = lat_rad.cos().max(0.1);
    let s = orbital.solar_constant_w_m2 / 4.0 * cos_lat;
    let t_base = 255.0 + 33.0 + (s - 340.0) * 0.05;
    let t_surface = t_base.clamp(180.0, 340.0);
    let t = t_surface - elev_m * 0.0065;
    t.clamp(150.0, 360.0)
}

/// Normalised relative humidity in [0, 1] for a Hadley-cell latitude profile,
/// damped by distance from ocean and by orographic rain-shadow factor.
///
/// Zonal anchors (matching the Köppen-ish chart in the plan):
///   * |lat| ≈  0°  → 1.00  (ITCZ rainforest band)
///   * |lat| ≈ 30°  → 0.15  (subtropical deserts)
///   * |lat| ≈ 50°  → 0.60  (mid-latitude westerlies)
///   * |lat| ≥ 70°  → 0.20  (polar deserts)
/// Piecewise cosine interpolation between anchors.
///
/// * `ocean_distance_km` — great-circle distance to nearest ocean cell.
/// * `rain_shadow_factor` — 1.0 unshadowed, 0.0 fully blocked. Multiplicative.
pub fn humidity_norm(lat_rad: f64, ocean_distance_km: f64, rain_shadow_factor: f64) -> f64 {
    let abs_lat_deg = lat_rad.to_degrees().abs().min(90.0);

    // Piecewise cosine between anchors; smooth C1 transitions.
    fn blend(t: f64, a: f64, b: f64) -> f64 {
        let s = 0.5 - 0.5 * (PI * t).cos();
        a * (1.0 - s) + b * s
    }

    let zonal = if abs_lat_deg <= 30.0 {
        let t = abs_lat_deg / 30.0;
        blend(t, 1.0, 0.15)
    } else if abs_lat_deg <= 50.0 {
        let t = (abs_lat_deg - 30.0) / 20.0;
        blend(t, 0.15, 0.60)
    } else if abs_lat_deg <= 70.0 {
        let t = (abs_lat_deg - 50.0) / 20.0;
        blend(t, 0.60, 0.20)
    } else {
        0.20
    };

    // Ocean-proximity scaling: e-folding length ~1500 km matches the typical
    // continental-interior dryness scale. Damp to [0.25, 1.0] of zonal so
    // coastal/stub cells don't collapse to zero when distance is unknown.
    let ocean_term = (-ocean_distance_km / 1500.0).exp();
    let h = zonal * (0.25 + 0.75 * ocean_term) * rain_shadow_factor.clamp(0.0, 1.0);
    h.clamp(0.0, 1.0)
}

/// Köppen-ish biome categories used by the renderer + frame stream.
///
/// Repr is `u8` so it can be cast cheaply for `0x4x` frame-stream tags. Order
/// is API: do not renumber once shipped without bumping the frame-stream
/// schema version.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BiomeId {
    Ocean = 0,
    Ice = 1,
    Tundra = 2,
    BorealForest = 3,
    TemperateForest = 4,
    TemperateGrassland = 5,
    Desert = 6,
    Savanna = 7,
    TropicalRainforest = 8,
    Wetland = 9,
    Alpine = 10,
    Mediterranean = 11,
    IceShelf = 12,
    RockBarren = 13,
    IceSheet = 14,
}

impl BiomeId {
    #[inline]
    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// Classify a single cell into a [`BiomeId`].
pub fn biome_for(temp_k: f64, humidity: f64, elev_m: f64, is_ocean: bool) -> BiomeId {
    if is_ocean {
        if temp_k < 263.0 {
            return BiomeId::IceShelf;
        }
        return BiomeId::Ocean;
    }

    // Land cells. Glacier / barren rock take precedence over alpine.
    if elev_m > 3500.0 && temp_k < 260.0 {
        return BiomeId::IceSheet;
    }
    if elev_m > 4500.0 {
        return BiomeId::RockBarren;
    }
    if elev_m > 2500.0 {
        return BiomeId::Alpine;
    }

    if temp_k < 248.0 {
        return BiomeId::Ice;
    }
    if temp_k < 268.0 {
        return BiomeId::Tundra;
    }
    if temp_k < 278.0 {
        if humidity > 0.35 {
            return BiomeId::BorealForest;
        }
        return BiomeId::Tundra;
    }

    if temp_k < 287.0 {
        return match humidity {
            h if h > 0.85 => BiomeId::Wetland,
            h if h > 0.55 => BiomeId::TemperateForest,
            h if h > 0.30 => BiomeId::Mediterranean,
            h if h > 0.15 => BiomeId::TemperateGrassland,
            _ => BiomeId::Desert,
        };
    }

    // Tropical zone.
    match humidity {
        h if h > 0.75 => BiomeId::TropicalRainforest,
        h if h > 0.40 => BiomeId::Savanna,
        _ => BiomeId::Desert,
    }
}

/// Bulk per-cell climate output. Sized to `sphere.n_fields()`.
#[derive(Debug, Clone)]
pub struct CellClimate {
    pub temp_k: Vec<f32>,
    pub humidity: Vec<f32>,
    pub biome: Vec<u8>,
}

/// Compute per-cell climate over the whole sphere.
///
/// `ocean_dist_km` and `rain_shadow` may be empty stubs — Phase 6.1 only
/// needs the zonal + lapse contribution. When empty, neutral defaults
/// (0 km / 1.0) are substituted.
pub fn compute_cell_climate(
    sphere: &VoronoiSphere,
    elev: &[f32],
    is_ocean: &[bool],
    ocean_dist_km: &[f32],
    rain_shadow: &[f32],
    orbital: &OrbitalParams,
) -> CellClimate {
    let n = sphere.n_fields() as usize;
    assert_eq!(elev.len(), n, "elev length must match n_fields");
    assert_eq!(is_ocean.len(), n, "is_ocean length must match n_fields");
    let have_dist = ocean_dist_km.len() == n;
    let have_shadow = rain_shadow.len() == n;

    let mut temp = Vec::with_capacity(n);
    let mut hum = Vec::with_capacity(n);
    let mut biome = Vec::with_capacity(n);

    for i in 0..n {
        let pos = sphere.position(i as u32);
        let lat = cell_latitude_rad(pos);
        let e = elev[i] as f64;
        let t = temperature_k(lat, e.max(0.0), orbital);
        let d = if have_dist { ocean_dist_km[i] as f64 } else { 0.0 };
        let rs = if have_shadow { rain_shadow[i] as f64 } else { 1.0 };
        let h = humidity_norm(lat, d, rs);
        let b = biome_for(t, h, e, is_ocean[i]);
        temp.push(t as f32);
        hum.push(h as f32);
        biome.push(b.as_u8());
    }

    CellClimate { temp_k: temp, humidity: hum, biome }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latitude_from_poles_and_equator() {
        let north = Vec3::new(0.0, 1.0, 0.0);
        let south = Vec3::new(0.0, -1.0, 0.0);
        let equator = Vec3::new(1.0, 0.0, 0.0);
        assert!((cell_latitude_rad(north) - std::f64::consts::FRAC_PI_2).abs() < 1e-6);
        assert!((cell_latitude_rad(south) + std::f64::consts::FRAC_PI_2).abs() < 1e-6);
        assert!(cell_latitude_rad(equator).abs() < 1e-6);
    }

    #[test]
    fn polar_temperature_below_equatorial_temperature() {
        let orbital = OrbitalParams::earth();
        let eq = temperature_k(0.0, 0.0, &orbital);
        let pole = temperature_k(std::f64::consts::FRAC_PI_2, 0.0, &orbital);
        assert!(eq > pole, "equator {} should exceed pole {}", eq, pole);
    }

    #[test]
    fn lapse_rate_cools_with_elevation() {
        let orbital = OrbitalParams::earth();
        let sea = temperature_k(0.0, 0.0, &orbital);
        let mountain = temperature_k(0.0, 4000.0, &orbital);
        assert!(sea - mountain > 20.0, "{} vs {}", sea, mountain);
    }

    #[test]
    fn itcz_more_humid_than_sahara_band() {
        let h_itcz = humidity_norm(0.0, 0.0, 1.0);
        let sahara_lat = (25f64).to_radians();
        let h_sahara = humidity_norm(sahara_lat, 0.0, 1.0);
        assert!(h_itcz > h_sahara, "ITCZ {} should exceed sahara {}", h_itcz, h_sahara);
    }

    #[test]
    fn westerlies_more_humid_than_subtropical_desert() {
        let h_desert = humidity_norm((30f64).to_radians(), 0.0, 1.0);
        let h_west = humidity_norm((50f64).to_radians(), 0.0, 1.0);
        assert!(h_west > h_desert);
    }

    #[test]
    fn ocean_distance_dries_interior() {
        let coast = humidity_norm(0.0, 0.0, 1.0);
        let interior = humidity_norm(0.0, 3000.0, 1.0);
        assert!(coast > interior);
    }

    #[test]
    fn rain_shadow_dries_lee_side() {
        let unshadow = humidity_norm((45f64).to_radians(), 0.0, 1.0);
        let shadow = humidity_norm((45f64).to_radians(), 0.0, 0.1);
        assert!(unshadow > shadow);
    }

    #[test]
    fn humidity_clamped_to_unit_interval() {
        for lat_deg in [-90.0, -45.0, 0.0, 30.0, 60.0, 90.0] {
            for dist in [0.0, 500.0, 5000.0, 20000.0] {
                for rs in [0.0, 0.5, 1.0] {
                    let h = humidity_norm((lat_deg as f64).to_radians(), dist, rs);
                    assert!((0.0..=1.0).contains(&h),
                        "lat={} dist={} rs={} -> {}", lat_deg, dist, rs, h);
                }
            }
        }
    }

    #[test]
    fn sea_level_tropical_is_rainforest() {
        let orbital = OrbitalParams::earth();
        let t = temperature_k(0.0, 0.0, &orbital);
        let h = humidity_norm(0.0, 0.0, 1.0);
        let b = biome_for(t, h, 0.0, false);
        assert_eq!(b, BiomeId::TropicalRainforest, "t={} h={}", t, h);
    }

    #[test]
    fn high_elev_tropical_is_alpine() {
        let orbital = OrbitalParams::earth();
        let t = temperature_k(0.0, 3000.0, &orbital);
        let h = humidity_norm(0.0, 0.0, 1.0);
        let b = biome_for(t, h, 3000.0, false);
        assert_eq!(b, BiomeId::Alpine);
    }

    #[test]
    fn ocean_cells_classify_as_ocean_unless_frozen() {
        let b = biome_for(290.0, 0.5, -3000.0, true);
        assert_eq!(b, BiomeId::Ocean);
        let b_cold = biome_for(250.0, 0.5, -3000.0, true);
        assert_eq!(b_cold, BiomeId::IceShelf);
    }

    #[test]
    fn polar_land_is_ice_or_tundra() {
        let orbital = OrbitalParams::earth();
        let t = temperature_k(std::f64::consts::FRAC_PI_2, 0.0, &orbital);
        let h = humidity_norm(std::f64::consts::FRAC_PI_2, 0.0, 1.0);
        let b = biome_for(t, h, 0.0, false);
        assert!(matches!(b, BiomeId::Ice | BiomeId::Tundra | BiomeId::IceSheet),
            "got {:?}", b);
    }

    #[test]
    fn compute_cell_climate_round_trip_small_sphere() {
        let sphere = VoronoiSphere::new(4);
        let n = sphere.n_fields() as usize;
        let elev = vec![0.0f32; n];
        let is_ocean = vec![true; n];
        let orbital = OrbitalParams::earth();
        let cc = compute_cell_climate(&sphere, &elev, &is_ocean, &[], &[], &orbital);
        assert_eq!(cc.temp_k.len(), n);
        assert_eq!(cc.humidity.len(), n);
        assert_eq!(cc.biome.len(), n);
        for &b in &cc.biome {
            assert!(b == BiomeId::Ocean.as_u8() || b == BiomeId::IceShelf.as_u8());
        }
        let north_t = cc.temp_k[0];
        let mut hottest = f32::MIN;
        for i in 0..n {
            let lat = cell_latitude_rad(sphere.position(i as u32));
            if lat.abs() < 0.05 {
                hottest = hottest.max(cc.temp_k[i]);
            }
        }
        assert!(hottest > north_t, "equator {} vs north {}", hottest, north_t);
    }

    #[test]
    fn biome_repr_is_stable_u8() {
        assert_eq!(BiomeId::Ocean.as_u8(), 0);
        assert_eq!(BiomeId::TropicalRainforest.as_u8(), 8);
        assert_eq!(BiomeId::IceSheet.as_u8(), 14);
    }
}
