//! Deterministic fixed-point trig via precomputed tables + linear interpolation.
//!
//! Angles are encoded as "binary angles": one full revolution = `2^32`, so
//! wraparound is automatic on `u32` arithmetic and there's never any `π`
//! constant lurking in the inner loop. This is the same trick MIDI sequencers
//! and old game consoles used; it composes naturally with deterministic
//! integer arithmetic.
//!
//! Table resolution: 1024 entries covering one quadrant. Sub-entry positions
//! use linear interpolation. Worst-case error: ~5e-7, well below the
//! Q31.32 precision floor of 2.3e-10 (so this is the dominant error source,
//! and it's small enough for our needs).

use crate::Q31_32;

/// Binary angle. One revolution = 2^32. `wrapping_add` gives free modular arithmetic.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BinaryAngle(pub u32);

impl BinaryAngle {
    /// Half a revolution = π.
    pub const HALF_TURN: Self = Self(1 << 31);
    /// Quarter revolution = π/2.
    pub const QUARTER_TURN: Self = Self(1 << 30);
    pub const ZERO: Self = Self(0);

    /// Construct from `f64` radians. I/O only — never call from hot loops.
    pub fn from_radians_lossy(rad: f64) -> Self {
        let turns = rad / (2.0 * core::f64::consts::PI);
        let full = (u64::from(u32::MAX) + 1) as f64;
        // Manual modular wrap, no_std-friendly.
        let scaled = turns * full;
        let wrapped = scaled - (scaled / full).floor() * full;
        Self(wrapped as u32)
    }

    pub fn to_radians_lossy(self) -> f64 {
        (self.0 as f64 / (u64::from(u32::MAX) + 1) as f64) * 2.0 * core::f64::consts::PI
    }
}

impl core::ops::Add for BinaryAngle {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self { Self(self.0.wrapping_add(rhs.0)) }
}

impl core::ops::Sub for BinaryAngle {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self { Self(self.0.wrapping_sub(rhs.0)) }
}

/// Quadrant-1 sine table, 1024 entries. Generated at compile time.
/// Entry `i` is `sin(i / 1024 * π/2)` in Q31.32 form.
const SIN_TABLE: [i64; 1025] = build_sin_table();

const fn build_sin_table() -> [i64; 1025] {
    let mut t = [0i64; 1025];
    let mut i = 0;
    while i <= 1024 {
        // Compute sin(i * π/2 / 1024) without f64 in const context.
        // We accept f64 const eval here because const-fn allows it on
        // stable since 1.83. The table is computed once at compile time;
        // every machine sees the same bytes.
        let rad = (i as f64) * (core::f64::consts::PI / 2.0) / 1024.0;
        // Tiny Taylor series sufficient for table generation (we have 1025
        // entries to dial in). Use the libm-equivalent built into the
        // Rust standard library at const eval time.
        //
        // Note: `f64::sin` is not const yet. We approximate via Taylor
        // series instead, since the table is fixed at compile time and we
        // need const fn.
        let s = const_sin(rad);
        // Scale into Q31.32.
        let scaled = s * ((1u64 << 32) as f64);
        // Round half-away-from-zero.
        let rounded = if scaled >= 0.0 { scaled + 0.5 } else { scaled - 0.5 };
        t[i] = rounded as i64;
        i += 1;
    }
    t
}

/// Const-friendly Taylor-series sin. Good enough for table generation
/// since inputs are bounded to [0, π/2].
const fn const_sin(x: f64) -> f64 {
    let mut term = x;
    let mut sum = x;
    let mut n = 1u32;
    while n < 11 {
        // term *= -x*x / ((2n)(2n+1))
        let denom = ((2 * n) * (2 * n + 1)) as f64;
        term = term * (-x * x) / denom;
        sum += term;
        n += 1;
    }
    sum
}

/// Sine of a binary angle. Bit-exact across architectures.
pub fn sin(angle: BinaryAngle) -> Q31_32 {
    // Map the full revolution into one quadrant by reflection / sign.
    // Bit 31 = sign (second half of revolution is negative).
    // Bit 30 = mirror within half (second quadrant mirrors first).
    let neg = (angle.0 >> 31) & 1 == 1;
    let mirror = (angle.0 >> 30) & 1 == 1;
    let in_quadrant = angle.0 & ((1 << 30) - 1);  // 30-bit position within quadrant
    let q = if mirror {
        (1u32 << 30) - in_quadrant
    } else {
        in_quadrant
    };

    // Map [0, 2^30] to [0, 1024] for table index + fractional bits for interpolation.
    // table_index uses the top 10 bits of q, fractional uses the bottom 20.
    // When `mirror` is true and `in_quadrant == 0`, q can equal exactly 2^30,
    // landing on table[1024] (= sin(π/2) = 1). Saturate the index to avoid OOB.
    let table_index = ((q >> 20) as usize).min(1024);
    let frac = q & ((1 << 20) - 1);

    let lo = SIN_TABLE[table_index];
    let hi = SIN_TABLE[(table_index + 1).min(1024)];
    let delta = hi - lo;

    // Linear interpolation: lo + delta * frac / 2^20.
    let interp = lo + ((delta as i128 * frac as i128) >> 20) as i64;

    let signed = if neg { -interp } else { interp };
    Q31_32(signed)
}

/// Cosine of a binary angle. Defined via `sin(angle + π/2)`.
#[inline]
pub fn cos(angle: BinaryAngle) -> Q31_32 {
    sin(angle + BinaryAngle::QUARTER_TURN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_zero_is_zero() {
        assert_eq!(sin(BinaryAngle::ZERO), Q31_32::ZERO);
    }

    #[test]
    fn sin_quarter_turn_is_one() {
        // sin(π/2) = 1, exactly hits a table entry.
        let v = sin(BinaryAngle::QUARTER_TURN);
        // Should be very close to Q31_32::ONE. Table accuracy + interp
        // means we accept tiny deviation from the exact 1.0.
        let diff = (v.0 - Q31_32::ONE.0).abs();
        assert!(diff < 100, "got {} expected ~{}", v.0, Q31_32::ONE.0);
    }

    #[test]
    fn sin_half_turn_is_zero() {
        let v = sin(BinaryAngle::HALF_TURN);
        assert!(v.0.abs() < 100);
    }

    #[test]
    fn cos_zero_is_one() {
        let v = cos(BinaryAngle::ZERO);
        let diff = (v.0 - Q31_32::ONE.0).abs();
        assert!(diff < 100);
    }

    #[test]
    fn sin_negation_symmetry() {
        // sin(-θ) = -sin(θ) for any θ.
        for i in 0..32 {
            let theta = BinaryAngle(i * 0x0800_0000);  // span the revolution
            let neg_theta = BinaryAngle::ZERO - theta;
            assert_eq!(sin(theta), -sin(neg_theta));
        }
    }

    #[test]
    fn approximates_libm_within_table_error() {
        // Sample a few angles, compare against f64::sin.
        for &deg in &[0, 15, 30, 45, 60, 75, 90, 135, 180, 225, 270, 359] {
            let rad = (deg as f64).to_radians();
            let our = sin(BinaryAngle::from_radians_lossy(rad)).to_f64();
            let theirs = rad.sin();
            let diff = (our - theirs).abs();
            assert!(diff < 1e-5, "deg={} ours={} theirs={} diff={}", deg, our, theirs, diff);
        }
    }
}
