//! Wilson-cycle Ma (megayears) calibration: sim-tick <-> geological time.
//!
//! Port target: tectonic-explorer's time scaling (`MODEL_STEP` etc.).
//! Frozen reference: `docs/research/te-snapshot/plates-model/`.
//!
//! `DT_MA` is the canonical real-megayears advance per macro-step. Callers
//! of [`crate::model::Model::step`] should pass this value (or use it as the
//! authoritative reference) so that the simulation clock and on-screen
//! Earth-history era overlay stay calibrated to the same Wilson-cycle.

/// Real megayears per macro-step. The TE/Hayba sim advances `sim_time_ma`
/// by this amount on each successful `Model::step` call.
pub const DT_MA: f64 = 0.5;

/// Map an "Ma ago" value to the canonical Earth-history era name.
///
/// Boundaries follow ICS 2023:
/// * 0 – 66 Ma     → Cenozoic
/// * 66 – 145 Ma   → Cretaceous
/// * 145 – 201 Ma  → Jurassic
/// * 201 – 252 Ma  → Triassic
/// * 252 – 299 Ma  → Permian
/// * 299 – 359 Ma  → Carboniferous
/// * 359 – 419 Ma  → Devonian
/// * 419 – 444 Ma  → Silurian
/// * 444 – 485 Ma  → Ordovician
/// * 485 – 541 Ma  → Cambrian
/// * 541 Ma+       → Precambrian
///
/// Boundary convention: lower bound is inclusive, upper bound exclusive.
/// Negative inputs are clamped to 0 (treated as "present day").
pub fn era_for_ma(ma: f64) -> &'static str {
    let ma = if ma < 0.0 { 0.0 } else { ma };
    if ma < 66.0 {
        "Cenozoic"
    } else if ma < 145.0 {
        "Cretaceous"
    } else if ma < 201.0 {
        "Jurassic"
    } else if ma < 252.0 {
        "Triassic"
    } else if ma < 299.0 {
        "Permian"
    } else if ma < 359.0 {
        "Carboniferous"
    } else if ma < 419.0 {
        "Devonian"
    } else if ma < 444.0 {
        "Silurian"
    } else if ma < 485.0 {
        "Ordovician"
    } else if ma < 541.0 {
        "Cambrian"
    } else {
        "Precambrian"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dt_ma_is_half_megayear() {
        assert!((DT_MA - 0.5).abs() < 1e-12);
    }

    #[test]
    fn era_present_day_is_cenozoic() {
        assert_eq!(era_for_ma(0.0), "Cenozoic");
        assert_eq!(era_for_ma(10.0), "Cenozoic");
        assert_eq!(era_for_ma(65.999), "Cenozoic");
    }

    #[test]
    fn era_boundary_values_use_lower_inclusive_upper_exclusive() {
        // Each canonical lower bound belongs to the older era.
        assert_eq!(era_for_ma(66.0), "Cretaceous");
        assert_eq!(era_for_ma(145.0), "Jurassic");
        assert_eq!(era_for_ma(201.0), "Triassic");
        assert_eq!(era_for_ma(252.0), "Permian");
        assert_eq!(era_for_ma(299.0), "Carboniferous");
        assert_eq!(era_for_ma(359.0), "Devonian");
        assert_eq!(era_for_ma(419.0), "Silurian");
        assert_eq!(era_for_ma(444.0), "Ordovician");
        assert_eq!(era_for_ma(485.0), "Cambrian");
        assert_eq!(era_for_ma(541.0), "Precambrian");
    }

    #[test]
    fn era_mid_range_samples() {
        assert_eq!(era_for_ma(100.0), "Cretaceous");
        assert_eq!(era_for_ma(175.0), "Jurassic");
        assert_eq!(era_for_ma(230.0), "Triassic");
        assert_eq!(era_for_ma(275.0), "Permian");
        assert_eq!(era_for_ma(330.0), "Carboniferous");
        assert_eq!(era_for_ma(400.0), "Devonian");
        assert_eq!(era_for_ma(430.0), "Silurian");
        assert_eq!(era_for_ma(460.0), "Ordovician");
        assert_eq!(era_for_ma(510.0), "Cambrian");
        assert_eq!(era_for_ma(1000.0), "Precambrian");
        assert_eq!(era_for_ma(4500.0), "Precambrian");
    }

    #[test]
    fn era_negative_clamps_to_present() {
        assert_eq!(era_for_ma(-1.0), "Cenozoic");
        assert_eq!(era_for_ma(-1000.0), "Cenozoic");
    }
}
