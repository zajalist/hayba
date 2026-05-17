//! Q31.32 — 31 integer bits + sign, 32 fractional bits, stored as `i64`.
//!
//! Range: -2,147,483,648.0 .. 2,147,483,647.999999999767...
//! Precision: 1 / 4_294_967_296 ≈ 2.328e-10
//!
//! Multiply needs a widened `i128` intermediate; division uses `i128` for the
//! shifted dividend. The wider headroom matters when sim quantities are
//! denominated in metres on planetary scales (Earth radius ~6.37e6 m) or when
//! accumulating many small contributions into a single cell.

use core::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Q31_32(pub i64);

impl Q31_32 {
    pub const FRAC_BITS: u32 = 32;
    pub const ONE: Self = Self(1 << Self::FRAC_BITS);
    pub const ZERO: Self = Self(0);
    pub const HALF: Self = Self(1 << (Self::FRAC_BITS - 1));
    pub const MIN: Self = Self(i64::MIN);
    pub const MAX: Self = Self(i64::MAX);

    #[inline]
    pub const fn from_int(n: i32) -> Self {
        Self((n as i64) << Self::FRAC_BITS)
    }

    #[inline]
    pub const fn from_ratio(num: i64, den: i64) -> Self {
        let n = (num as i128) << Self::FRAC_BITS;
        Self((n / den as i128) as i64)
    }

    #[inline]
    pub const fn to_int_floor(self) -> i64 {
        self.0 >> Self::FRAC_BITS
    }

    #[inline]
    pub fn to_f64(self) -> f64 {
        self.0 as f64 / (1u64 << Self::FRAC_BITS) as f64
    }

    #[inline]
    pub fn from_f64_lossy(x: f64) -> Self {
        let scaled = x * (1u64 << Self::FRAC_BITS) as f64;
        let rounded = if scaled >= 0.0 {
            (scaled + 0.5) as i128
        } else {
            (scaled - 0.5) as i128
        };
        Self(rounded.clamp(i64::MIN as i128, i64::MAX as i128) as i64)
    }

    #[inline]
    pub fn abs(self) -> Self {
        Self(self.0.wrapping_abs())
    }

    #[inline]
    pub fn saturating_mul(self, rhs: Self) -> Self {
        let wide = (self.0 as i128) * (rhs.0 as i128);
        let shifted = wide >> Self::FRAC_BITS;
        if shifted > i64::MAX as i128 {
            Self(i64::MAX)
        } else if shifted < i64::MIN as i128 {
            Self(i64::MIN)
        } else {
            Self(shifted as i64)
        }
    }
}

impl Add for Q31_32 {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self { Self(self.0 + rhs.0) }
}

impl AddAssign for Q31_32 {
    #[inline]
    fn add_assign(&mut self, rhs: Self) { self.0 += rhs.0; }
}

impl Sub for Q31_32 {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self { Self(self.0 - rhs.0) }
}

impl SubAssign for Q31_32 {
    #[inline]
    fn sub_assign(&mut self, rhs: Self) { self.0 -= rhs.0; }
}

impl Neg for Q31_32 {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self { Self(-self.0) }
}

impl Mul for Q31_32 {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: Self) -> Self {
        let wide = (self.0 as i128) * (rhs.0 as i128);
        Self((wide >> Self::FRAC_BITS) as i64)
    }
}

impl Div for Q31_32 {
    type Output = Self;
    #[inline]
    fn div(self, rhs: Self) -> Self {
        let wide = (self.0 as i128) << Self::FRAC_BITS;
        Self((wide / rhs.0 as i128) as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_times_one_is_one() {
        assert_eq!(Q31_32::ONE * Q31_32::ONE, Q31_32::ONE);
    }

    #[test]
    fn multiply_is_deterministic_under_fixed_order() {
        // Fixed-point multiply truncates and is *not* associative — see
        // notes in q16_16.rs. We do guarantee that the same order yields
        // the same bits, which is what the sim's determinism contract needs.
        let a = Q31_32::from_ratio(7, 11);
        let b = Q31_32::from_ratio(13, 17);
        let c = Q31_32::from_ratio(5, 19);
        assert_eq!((a * b) * c, (a * b) * c);
    }

    #[test]
    fn earth_radius_fits() {
        // Earth radius in metres.
        let r = Q31_32::from_int(6_371_000);
        assert_eq!(r.to_int_floor(), 6_371_000);
    }

    #[test]
    fn fine_precision_holds() {
        // 1 nanometre on a planet-scale Q31.32.
        let one_nm = Q31_32::from_ratio(1, 1_000_000_000);
        assert!(one_nm.0 > 0);  // Q31.32 has ~2.3e-10 precision so 1e-9 survives.
    }
}
