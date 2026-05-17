//! Spherical-tangent geometry helpers shared by the CA inner loop, boundary
//! classification, and lifecycle / rift-fork code (REFACTOR #1).
//!
//! ## Public interface
//!
//! - [`project_to_tangent_plane`] — strip the radial component of a free
//!   3-vector at a given point on the sphere.
//! - [`mean_position`] — centroid of a slice of unit-sphere positions,
//!   renormalized; falls back to `(0,0,1)` on empty or antipodal input.
//!
//! All inputs are expected to be in unit-sphere coordinates (`length ≈ 1`)
//! unless noted; helpers degrade gracefully on near-zero inputs via
//! [`Vec3f::normalize_or`].

use crate::mesh::Vec3f;

/// Subtract the radial component of `vec` at the point `at`. The result lies
/// in the tangent plane at `at`. Does not normalize — callers normalize if
/// they need a unit direction.
pub fn project_to_tangent_plane(at: Vec3f, vec: Vec3f) -> Vec3f {
    let radial = vec.dot(at);
    Vec3f::new(
        vec.x - radial * at.x,
        vec.y - radial * at.y,
        vec.z - radial * at.z,
    )
}

/// Mean of a list of positions, renormalized to the unit sphere. Returns
/// `(0, 0, 1)` for an empty slice or near-antipodal inputs whose centroid
/// collapses to the origin.
pub fn mean_position(points: &[Vec3f]) -> Vec3f {
    if points.is_empty() {
        return Vec3f::new(0.0, 0.0, 1.0);
    }
    let n = points.len() as f64;
    let mut sum = Vec3f::new(0.0, 0.0, 0.0);
    for p in points {
        sum.x += p.x;
        sum.y += p.y;
        sum.z += p.z;
    }
    Vec3f::new(sum.x / n, sum.y / n, sum.z / n)
        .normalize_or(Vec3f::new(0.0, 0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_zeroes_radial_component() {
        let at = Vec3f::new(1.0, 0.0, 0.0);
        let v = Vec3f::new(3.0, 2.0, -1.0);
        let p = project_to_tangent_plane(at, v);
        assert!(p.dot(at).abs() < 1e-12, "radial component not zero: {}", p.dot(at));
        // Tangential pieces are preserved.
        assert!((p.y - 2.0).abs() < 1e-12);
        assert!((p.z + 1.0).abs() < 1e-12);
    }

    #[test]
    fn cross_is_orthogonal_to_inputs() {
        let a = Vec3f::new(1.0, 2.0, 3.0);
        let b = Vec3f::new(-2.0, 0.5, 4.0);
        let c = a.cross(b);
        assert!(c.dot(a).abs() < 1e-12);
        assert!(c.dot(b).abs() < 1e-12);
    }

    #[test]
    fn normalize_or_returns_fallback_on_near_zero() {
        let fallback = Vec3f::new(0.0, 1.0, 0.0);
        let tiny = Vec3f::new(1e-20, 0.0, 0.0);
        let n = tiny.normalize_or(fallback);
        assert_eq!(n, fallback);
    }

    #[test]
    fn normalize_or_normalizes_otherwise() {
        let v = Vec3f::new(3.0, 0.0, 4.0);
        let n = v.normalize_or(Vec3f::new(1.0, 0.0, 0.0));
        assert!((n.length() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn mean_position_antipodal_collapses_to_fallback() {
        let a = Vec3f::new(0.0, 0.0, 1.0);
        let b = Vec3f::new(0.0, 0.0, -1.0);
        let m = mean_position(&[a, b]);
        // Sum is zero → normalize_or falls back to (0,0,1).
        assert_eq!(m, Vec3f::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn mean_position_empty_returns_fallback() {
        let m = mean_position(&[]);
        assert_eq!(m, Vec3f::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn mean_position_on_unit_sphere() {
        let a = Vec3f::new(1.0, 0.0, 0.0);
        let b = Vec3f::new(0.0, 1.0, 0.0);
        let m = mean_position(&[a, b]);
        assert!((m.length() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn scale_and_length_round_trip() {
        let v = Vec3f::new(1.0, 0.0, 0.0).scale(5.0);
        assert!((v.length() - 5.0).abs() < 1e-12);
    }
}
