//! Equal-area cube-sphere erosion subsystem (spec §5).

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ErosionConfig {
    pub base_face_res: u32,     // coarsest face res (e.g. 64)
    pub pyramid_levels: u32,    // ×2 steps to target (64→…→2048)
    pub k_iters_per_level: u32, // erosion iters/level (~16)
    pub erodibility: f32,       // stream-power K
    pub area_exp: f32,          // m ≈ 0.5
    pub slope_exp: f32,         // n = 1.0
    pub incision_clamp: f32,    // ε per-step (normalized)
    pub thermal_d: f32,         // hillslope diffusion
    pub talus_angle: f32,       // critical slope as dh/dx in normalized units (~0.6 ≈ 31°); thermal creep only acts above it
    /// Run thermal every Nth K-iter; throttles thermal so it can't out-diffuse
    /// the injected detail band — spec §5.4.
    pub thermal_cadence: u32,
    pub deposition_g: f32,      // Davy-Lague G (~1.6)
    pub beta: f32,              // §5.5 detail-restoration GAIN (≥1; >1 amplify, <1 mute — sub-unity net-smooths)
    pub uplift: f32,            // MUST be 0.0
    /// RNG seed for deterministic sphere-domain noise (spec §5.4).
    pub seed: u64,
}

impl Default for ErosionConfig {
    fn default() -> Self {
        Self {
            base_face_res: 64,
            pyramid_levels: 5,
            k_iters_per_level: 16,
            erodibility: 5e-5,
            area_exp: 0.5,
            slope_exp: 1.0,
            incision_clamp: 3e-4,
            thermal_d: 0.08,
            talus_angle: 0.6,
            // smallest cadence where pre-blend injected-variance retention >=0.5
            // (measured: 4->.348, 6->.421, 8->.538 plateau) — spec §5.4
            // thermal-vs-detail contract.
            thermal_cadence: 8,
            deposition_g: 1.6,
            beta: 1.5,
            uplift: 0.0,
            seed: 0x9E37_79B9,
        }
    }
}

pub mod cubesphere;
pub mod noise;
pub mod pyramid;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_defaults_are_sane() {
        let c = ErosionConfig::default();
        assert!(c.pyramid_levels >= 4 && c.k_iters_per_level >= 8);
        assert!(c.incision_clamp > 0.0 && c.incision_clamp < 0.01);
        assert!(c.beta >= 1.0, "β is the §5.5 detail-restoration gain; sub-unity net-smooths");
        assert!(c.thermal_cadence >= 1, "thermal runs every Nth K-iter; cadence must be >=1");
        assert!(c.uplift == 0.0, "U MUST be 0 (spec §3): no equilibrium attractor");
        assert!(c.erodibility > 0.0 && c.erodibility < 1e-2, "erodibility sane (catches 5e-5 vs 5e5 typo)");
        assert!(c.talus_angle > 0.0 && c.talus_angle < 1.0, "talus_angle normalized slope in (0,1)");
        assert!(c.deposition_g >= 1.0, "Davy-Lague G must be >= 1.0 for physical deposition");
        assert!(c.base_face_res >= 8 && c.k_iters_per_level <= 64, "grid/iter bounds sane");
    }
}
