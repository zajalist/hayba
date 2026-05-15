//! Eccentricity, obliquity, precession cycles.
//!
//! Hayba extension. No direct tectonic-explorer counterpart.

use crate::wizard::OrbitalParams;
use std::f64::consts::PI;

/// Solar constant at `current_ma` (Ma). Includes a small +/-0.1%
/// short-term oscillation (period ~100 ka) about the nominal value.
pub fn current_solar_constant(orbital: &OrbitalParams, current_ma: f64) -> f64 {
    let t_ka = current_ma * 1000.0;
    orbital.solar_constant_w_m2 * (1.0 + 0.001 * (2.0 * PI * t_ka / 100.0).sin())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solar_constant_oscillates_within_one_tenth_percent() {
        let orb = OrbitalParams::earth();
        let s0 = orb.solar_constant_w_m2;
        for i in 0..50 {
            let ma = i as f64 * 0.01;
            let s = current_solar_constant(&orb, ma);
            let dev = (s - s0).abs() / s0;
            assert!(dev <= 0.0011, "deviation {} too large", dev);
        }
    }

    #[test]
    fn solar_constant_at_zero_is_nominal() {
        let orb = OrbitalParams::earth();
        let s = current_solar_constant(&orb, 0.0);
        assert!((s - orb.solar_constant_w_m2).abs() < 1e-9);
    }
}
