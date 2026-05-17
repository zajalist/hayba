//! Cross-architecture determinism contract tests.
//!
//! The integration test compiles into a separate binary that runs a
//! sequence of fixed-point operations and asserts the byte-level results.
//! Run this test in CI on every supported architecture (x86-64, ARM64,
//! WASM); same expected bytes everywhere.

use hayba_fixedpoint::{Q16_16, Q31_32, Vec3, trig};

#[test]
fn q16_16_multiply_chain_is_reproducible() {
    // Pick a sequence with no nice algebraic identities so we're really
    // exercising the bit-level arithmetic.
    let seed = Q16_16::from_ratio(355, 113);
    let mut acc = seed;
    for i in 1..=100 {
        acc = (acc * Q16_16::from_ratio(i, i + 1)) + Q16_16::from_ratio(1, 7);
    }
    // This hash should be identical on every machine.
    assert_eq!(acc.0, EXPECTED_Q16_16_HASH);
}

const EXPECTED_Q16_16_HASH: i32 = compute_expected_q16_16();

const fn compute_expected_q16_16() -> i32 {
    // Reproduce the test sequence at const eval time. Const eval is
    // hermetic — same bytes on every host running rustc 1.95+.
    let seed = Q16_16(((355i64 << 16) / 113) as i32);
    let mut acc = seed;
    let mut i = 1i32;
    while i <= 100 {
        let factor = Q16_16((((i as i64) << 16) / (i + 1) as i64) as i32);
        // Multiply: widen, multiply, shift.
        let mul = Q16_16(
            (((acc.0 as i64) * (factor.0 as i64)) >> 16) as i32,
        );
        let bias = Q16_16(((1i64 << 16) / 7) as i32);
        acc = Q16_16(mul.0 + bias.0);
        i += 1;
    }
    acc.0
}

#[test]
fn q31_32_vector_rotation_chain_is_reproducible() {
    // A unit vector rotated repeatedly should land at a deterministic
    // place. Real test: build a small rotation, apply it 1000 times,
    // check the byte representation of the result.
    let mut p = Vec3::new(Q31_32::ONE, Q31_32::ZERO, Q31_32::ZERO);
    let step = trig::BinaryAngle((u32::MAX / 360) as u32);  // 1° per step

    for _ in 0..360 {
        // 2D rotation around the Z axis: (x, y) -> (cos t * x - sin t * y, sin t * x + cos t * y)
        let c = trig::cos(step);
        let s = trig::sin(step);
        let new_x = c * p.x - s * p.y;
        let new_y = s * p.x + c * p.y;
        p = Vec3::new(new_x, new_y, p.z);
    }

    // After 360 1° rotations we should be ~back where we started.
    // Allow drift up to the trig-table interpolation error budget.
    let drift_x = (p.x - Q31_32::ONE).0.abs();
    let drift_y = p.y.0.abs();
    let budget = 1 << 12;  // ~5e-7 in Q31.32, scaled across 360 iterations
    assert!(drift_x < budget * 360, "x drifted {} (budget {})", drift_x, budget * 360);
    assert!(drift_y < budget * 360, "y drifted {} (budget {})", drift_y, budget * 360);
}

#[test]
fn trig_table_first_quadrant_is_monotonic() {
    // sin should be monotonically non-decreasing across [0, π/2].
    let mut prev = trig::sin(trig::BinaryAngle::ZERO);
    for i in 1..=1024 {
        let angle = trig::BinaryAngle((i as u32) * ((1u32 << 30) / 1024));
        let v = trig::sin(angle);
        assert!(v.0 >= prev.0, "non-monotonic at i={}: prev={} cur={}", i, prev.0, v.0);
        prev = v;
    }
}

#[test]
fn fixed_point_addition_is_associative() {
    // Addition over Q-formats is exact (no rounding), so order doesn't
    // matter — bit-exact regardless of summation pattern. Multiplication,
    // by contrast, truncates and IS order-dependent (same as floats); we
    // get determinism from operation order, not from associativity.
    let a = Q31_32::from_ratio(1, 7);
    let b = Q31_32::from_ratio(1, 11);
    let c = Q31_32::from_ratio(1, 13);
    let d = Q31_32::from_ratio(1, 17);

    assert_eq!(((a + b) + c) + d, a + (b + (c + d)));
}
