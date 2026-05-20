//! World-scale parameter model (Gaea §10): makes erosion physical by
//! denominating slope/capacity in metres instead of pixels, so a smaller
//! ground window at fixed resolution resolves finer detail (the S3 zoom
//! mechanism) and strength is a real, controllable quantity.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WorldScale {
    /// Ground width the grid spans, metres.
    pub terrain_scale: f32,
    /// What height 1.0 represents, metres.
    pub verticality: f32,
    /// Target erosion feature wavelength, metres.
    pub feature_scale: f32,
}

impl WorldScale {
    /// Whole-planet macro default: circumference of an Earth-ish radius.
    pub fn planet_default() -> Self {
        WorldScale {
            terrain_scale: 2.0 * std::f32::consts::PI * 6_371_000.0,
            verticality: 9_000.0,
            feature_scale: 2_000.0,
        }
    }
    /// Metres per texel.
    pub fn dx(&self, resolution: f32) -> f32 {
        self.terrain_scale / resolution
    }
    /// Real elevation in metres for a normalised height.
    pub fn z_m(&self, h01: f32) -> f32 {
        h01 * self.verticality
    }
    /// Gaea zCoeff = terrainScale / (verticality * resolution).
    pub fn z_coeff(&self, resolution: f32) -> f32 {
        self.terrain_scale / (self.verticality * resolution)
    }
    /// True dimensionless slope from a normalised-height delta over one texel.
    pub fn true_slope(&self, dh01: f32, resolution: f32) -> f32 {
        self.z_m(dh01) / self.dx(resolution)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivations_match_gaea_formulas() {
        // terrain 40_000 m across a 2000-texel grid, 9000 m relief.
        let s = WorldScale { terrain_scale: 40_000.0, verticality: 9_000.0, feature_scale: 2_000.0 };
        let res = 2000.0_f32;
        // dx = terrainScale / resolution
        assert!((s.dx(res) - 20.0).abs() < 1e-3);
        // z_m(h) = h * verticality
        assert!((s.z_m(0.5) - 4_500.0).abs() < 1e-3);
        // zCoeff = terrainScale / (verticality * resolution)
        assert!((s.z_coeff(res) - (40_000.0 / (9_000.0 * 2000.0))).abs() < 1e-9);
        // true slope = Δz_m / dx  (Δh=0.01 over one texel)
        let slope = s.true_slope(0.01, res);
        assert!((slope - (0.01 * 9_000.0 / 20.0)).abs() < 1e-3);
    }

    #[test]
    fn defaults_are_planet_sane() {
        let s = WorldScale::planet_default();
        assert!(s.terrain_scale > 1_000_000.0);   // planet circumference scale
        assert!(s.verticality >= 5_000.0 && s.verticality <= 20_000.0);
        assert!(s.feature_scale > 0.0);
    }
}
