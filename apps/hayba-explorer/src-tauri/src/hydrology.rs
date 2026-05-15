//! Coarse-graph macro hydrology: Barnes Priority-Flood depression fill,
//! flow routing, drainage-area accumulation, and Cordonnier stream-power
//! fluvial incision on the irregular icosphere cell graph. Pure, O(N log N).

use glam::Vec3;

/// User-tunable erosion constants. Mirrors `climate::ClimateParams`:
/// `#[serde(default)]` so a missing/partial JSON payload yields defaults.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(default)]
pub struct ErosionParams {
    /// Stream-power erodibility K.
    pub erodibility: f32,
    /// Drainage-area exponent m (≈0.5).
    pub area_exp: f32,
    /// Slope exponent n (≈1.0).
    pub slope_exp: f32,
    /// Erosion iterations interleaved with the tectonic bake steps.
    pub iterations: u32,
    /// Per-iteration uplift added to land cells (normalized elev units).
    pub uplift: f32,
    /// Drainage-area fraction (of max) above which a cell is "river".
    pub river_threshold: f32,
}

impl Default for ErosionParams {
    fn default() -> Self {
        Self {
            erodibility: 0.05,
            area_exp: 0.5,
            slope_exp: 1.0,
            iterations: 25,
            uplift: 0.004,
            river_threshold: 0.015,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erosion_params_default_is_sane() {
        let p = ErosionParams::default();
        assert!(p.erodibility > 0.0 && p.iterations > 0);
        assert!((p.area_exp - 0.5).abs() < 1e-6);
    }
}
