//! Fixed-point vectors.
//!
//! Two-component and three-component vectors over `Q31_32`. The tectonic sim
//! operates on a unit sphere; positions are 3D direction vectors with a
//! magnitude of one. Q31.32 gives enough precision (~2.3e-10) that
//! accumulated rotations over millions of steps don't drift the magnitude
//! visibly off the sphere.

use core::ops::{Add, Mul, Neg, Sub};

use crate::Q31_32;

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Vec2 {
    pub x: Q31_32,
    pub y: Q31_32,
}

impl Vec2 {
    pub const ZERO: Self = Self { x: Q31_32::ZERO, y: Q31_32::ZERO };

    #[inline]
    pub const fn new(x: Q31_32, y: Q31_32) -> Self { Self { x, y } }

    #[inline]
    pub fn dot(self, rhs: Self) -> Q31_32 { self.x * rhs.x + self.y * rhs.y }
}

impl Add for Vec2 {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self { Self::new(self.x + rhs.x, self.y + rhs.y) }
}

impl Sub for Vec2 {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self { Self::new(self.x - rhs.x, self.y - rhs.y) }
}

impl Neg for Vec2 {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self { Self::new(-self.x, -self.y) }
}

impl Mul<Q31_32> for Vec2 {
    type Output = Self;
    #[inline]
    fn mul(self, s: Q31_32) -> Self { Self::new(self.x * s, self.y * s) }
}

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Vec3 {
    pub x: Q31_32,
    pub y: Q31_32,
    pub z: Q31_32,
}

impl Vec3 {
    pub const ZERO: Self = Self { x: Q31_32::ZERO, y: Q31_32::ZERO, z: Q31_32::ZERO };
    pub const X: Self = Self { x: Q31_32::ONE, y: Q31_32::ZERO, z: Q31_32::ZERO };
    pub const Y: Self = Self { x: Q31_32::ZERO, y: Q31_32::ONE, z: Q31_32::ZERO };
    pub const Z: Self = Self { x: Q31_32::ZERO, y: Q31_32::ZERO, z: Q31_32::ONE };

    #[inline]
    pub const fn new(x: Q31_32, y: Q31_32, z: Q31_32) -> Self { Self { x, y, z } }

    #[inline]
    pub fn dot(self, rhs: Self) -> Q31_32 {
        self.x * rhs.x + self.y * rhs.y + self.z * rhs.z
    }

    #[inline]
    pub fn cross(self, rhs: Self) -> Self {
        Self::new(
            self.y * rhs.z - self.z * rhs.y,
            self.z * rhs.x - self.x * rhs.z,
            self.x * rhs.y - self.y * rhs.x,
        )
    }

    /// Squared magnitude. Avoids the sqrt cost when you only need to
    /// compare distances.
    #[inline]
    pub fn length_squared(self) -> Q31_32 { self.dot(self) }
}

impl Add for Vec3 {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self { Self::new(self.x + rhs.x, self.y + rhs.y, self.z + rhs.z) }
}

impl Sub for Vec3 {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self { Self::new(self.x - rhs.x, self.y - rhs.y, self.z - rhs.z) }
}

impl Neg for Vec3 {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self { Self::new(-self.x, -self.y, -self.z) }
}

impl Mul<Q31_32> for Vec3 {
    type Output = Self;
    #[inline]
    fn mul(self, s: Q31_32) -> Self { Self::new(self.x * s, self.y * s, self.z * s) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_of_unit_axes() {
        // x cross y == z, the right-hand rule.
        assert_eq!(Vec3::X.cross(Vec3::Y), Vec3::Z);
    }

    #[test]
    fn dot_of_perpendiculars_is_zero() {
        assert_eq!(Vec3::X.dot(Vec3::Y), Q31_32::ZERO);
    }

    #[test]
    fn vector_addition_is_commutative() {
        let a = Vec3::new(Q31_32::from_int(3), Q31_32::from_int(4), Q31_32::from_int(5));
        let b = Vec3::new(Q31_32::from_int(7), Q31_32::from_int(11), Q31_32::from_int(13));
        assert_eq!(a + b, b + a);
    }
}
