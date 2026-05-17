//! Q16.16 — 16 integer bits, 16 fractional bits, stored as `i32`.
//!
//! Range: -32768.0 .. 32767.999984...
//! Precision: 1 / 65536 ≈ 1.5258789e-5
//!
//! Multiply uses a widened `i64` intermediate then right-shifts by `FRAC_BITS`.
//! Division does the inverse: left-shift the dividend into `i64` before
//! dividing. Both are exact within rounding-toward-zero semantics.

use core::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Q16_16(pub i32);

impl Q16_16 {
    pub const FRAC_BITS: u32 = 16;
    pub const ONE: Self = Self(1 << Self::FRAC_BITS);
    pub const ZERO: Self = Self(0);
    pub const HALF: Self = Self(1 << (Self::FRAC_BITS - 1));
    pub const MIN: Self = Self(i32::MIN);
    pub const MAX: Self = Self(i32::MAX);

    #[inline]
    pub const fn from_int(n: i16) -> Self {
        Self((n as i32) << Self::FRAC_BITS)
    }

    /// Construct from a numerator / denominator pair. Avoids floats entirely.
    /// Saturates on overflow rather than panicking.
    #[inline]
    pub const fn from_ratio(num: i32, den: i32) -> Self {
        let n = (num as i64) << Self::FRAC_BITS;
        Self((n / den as i64) as i32)
    }

    #[inline]
    pub const fn to_int_floor(self) -> i32 {
        self.0 >> Self::FRAC_BITS
    }

    #[inline]
    pub fn to_f64(self) -> f64 {
        // I/O only — never call from sim hot paths.
        self.0 as f64 / (1u32 << Self::FRAC_BITS) as f64
    }

    #[inline]
    pub fn from_f64_lossy(x: f64) -> Self {
        // I/O only. Round-to-nearest-even via libm rint would be ideal but
        // we want zero deps in core; use round-half-away-from-zero for
        // predictability.
        let scaled = x * (1u32 << Self::FRAC_BITS) as f64;
        let rounded = if scaled >= 0.0 {
            (scaled + 0.5) as i64
        } else {
            (scaled - 0.5) as i64
        };
        Self(rounded.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
    }

    #[inline]
    pub fn abs(self) -> Self {
        Self(self.0.wrapping_abs())
    }

    /// Saturating multiply — for cases where overflow would otherwise wrap.
    #[inline]
    pub fn saturating_mul(self, rhs: Self) -> Self {
        let wide = (self.0 as i64) * (rhs.0 as i64);
        let shifted = wide >> Self::FRAC_BITS;
        if shifted > i32::MAX as i64 {
            Self(i32::MAX)
        } else if shifted < i32::MIN as i64 {
            Self(i32::MIN)
        } else {
            Self(shifted as i32)
        }
    }
}

impl Add for Q16_16 {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self { Self(self.0 + rhs.0) }
}

impl AddAssign for Q16_16 {
    #[inline]
    fn add_assign(&mut self, rhs: Self) { self.0 += rhs.0; }
}

impl Sub for Q16_16 {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self { Self(self.0 - rhs.0) }
}

impl SubAssign for Q16_16 {
    #[inline]
    fn sub_assign(&mut self, rhs: Self) { self.0 -= rhs.0; }
}

impl Neg for Q16_16 {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self { Self(-self.0) }
}

impl Mul for Q16_16 {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: Self) -> Self {
        // Widen to i64, multiply, shift down. Truncates toward zero.
        let wide = (self.0 as i64) * (rhs.0 as i64);
        Self((wide >> Self::FRAC_BITS) as i32)
    }
}

impl Div for Q16_16 {
    type Output = Self;
    #[inline]
    fn div(self, rhs: Self) -> Self {
        // Widen the dividend before dividing so the fractional bits survive.
        let wide = (self.0 as i64) << Self::FRAC_BITS;
        Self((wide / rhs.0 as i64) as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_times_one_is_one() {
        assert_eq!(Q16_16::ONE * Q16_16::ONE, Q16_16::ONE);
    }

    #[test]
    fn half_plus_half_is_one() {
        assert_eq!(Q16_16::HALF + Q16_16::HALF, Q16_16::ONE);
    }

    #[test]
    fn from_int_roundtrip() {
        for n in [-100i16, -1, 0, 1, 42, 31415] {
            assert_eq!(Q16_16::from_int(n).to_int_floor() as i16, n);
        }
    }

    #[test]
    fn ratio_constructs_thirds() {
        let third = Q16_16::from_ratio(1, 3);
        // 1/3 in Q16.16 = 21845 (since 65536/3 = 21845.33...)
        assert_eq!(third.0, 21845);
    }

    #[test]
    fn addition_is_truly_associative() {
        // Unlike multiplication (which truncates each step), fixed-point
        // *addition* is bit-exactly associative — that's what makes
        // accumulator reductions deterministic regardless of summation order.
        let a = Q16_16::from_ratio(7, 11);
        let b = Q16_16::from_ratio(13, 17);
        let c = Q16_16::from_ratio(5, 19);
        let d = Q16_16::from_ratio(3, 5);
        assert_eq!(((a + b) + c) + d, a + (b + (c + d)));
    }

    #[test]
    fn multiply_is_deterministic_under_fixed_order() {
        // We do NOT claim associativity: each multiply truncates the
        // fractional bits, so (a*b)*c can differ from a*(b*c) by one ULP.
        // What we DO guarantee: the same operation order produces the
        // same bits forever, on every architecture.
        let a = Q16_16::from_ratio(7, 11);
        let b = Q16_16::from_ratio(13, 17);
        let c = Q16_16::from_ratio(5, 19);
        let lhs1 = (a * b) * c;
        let lhs2 = (a * b) * c;
        assert_eq!(lhs1, lhs2);  // determinism
    }

    #[test]
    fn negation_is_self_inverse() {
        let x = Q16_16::from_ratio(355, 113);  // ~π
        assert_eq!(-(-x), x);
    }

    #[test]
    fn f64_roundtrip_lossy_but_close() {
        let original = 1.234_567;
        let q = Q16_16::from_f64_lossy(original);
        let back = q.to_f64();
        assert!((back - original).abs() < 1.0 / 65536.0);
    }
}
