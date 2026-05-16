//! Equal-area cube-sphere erosion subsystem (spec §5).

#[derive(Clone, Debug, serde::Deserialize)]
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
    pub talus_angle: f32,       // critical slope (rad-ish, normalized)
    pub deposition_g: f32,      // Davy-Lague G (~1.6)
    pub beta: f32,              // frequency-sep macro restore (0..1)
    pub uplift: f32,            // MUST be 0.0
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
            deposition_g: 1.6,
            beta: 0.2,
            uplift: 0.0,
            seed: 0x9E37_79B9,
        }
    }
}

pub mod cubesphere;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_defaults_are_sane() {
        let c = ErosionConfig::default();
        assert!(c.pyramid_levels >= 4 && c.k_iters_per_level >= 8);
        assert!(c.incision_clamp > 0.0 && c.incision_clamp < 0.01);
        assert!(c.beta > 0.0 && c.beta <= 1.0);
        assert!(c.uplift == 0.0, "U MUST be 0 (spec §3): no equilibrium attractor");
    }
}
