//! Stream-power incision on the v2 Voronoi sphere.
//!
//! Port of v1 `hayba-tectonics::erosion::compute_slope` + the stream-power
//! term of v1's `erosion_step`, adapted to f32 elevation and the spherical
//! adjacency exposed by [`crate::sphere::VoronoiSphere`].
//!
//! Phase 5.1 scope: a single passed-in `base_k` constant. Climate coupling
//! (precipitation / temperature multipliers) and sediment transport land in
//! Phase 5.2.
//!
//! Formula:
//!
//! ```text
//! erosion_rate[c] = base_k * slope[c] * sqrt(flow_accum[c])
//! ```
//!
//! The square-root on discharge is the Whipple-Tucker n=1, m=1/2 family —
//! the same exponent v1 picked.

use crate::sphere::VoronoiSphere;

use super::drainage::{NO_FLOW, SEA_LEVEL};

/// Approximate Earth radius in metres. Used to scale unit-sphere chord
/// distances into a real-world horizontal so the slope value has dimensions
/// of `elevation_unit / metre`.
pub const EARTH_RADIUS_M: f32 = 6.371e6;

/// Per-cell slope (radians) = max(atan(|de| / arc_length)) over neighbours.
///
/// Uses the actual great-circle arc between unit-sphere positions (scaled
/// by `EARTH_RADIUS_M`) rather than v1's average-edge-length approximation.
/// On the spherical mesh this is essentially free since positions are
/// already cached.
pub fn compute_slope(elev: &[f32], sphere: &VoronoiSphere) -> Vec<f32> {
    let n = elev.len();
    assert_eq!(n, sphere.n_fields() as usize);
    let mut slope = vec![0.0f32; n];
    for c in 0..n {
        let p_c = sphere.position(c as u32);
        let mut max_grad = 0.0f32;
        for &nb in sphere.neighbours(c as u32) {
            let p_n = sphere.position(nb);
            // Great-circle arc length on unit sphere = acos(dot). Clamp to
            // avoid NaN from f32 dot drifting slightly outside [-1, 1].
            let dot = p_c.dot(p_n).clamp(-1.0, 1.0);
            let arc = dot.acos();
            let dist_m = arc * EARTH_RADIUS_M;
            if dist_m <= 0.0 {
                continue;
            }
            let de = (elev[c] - elev[nb as usize]).abs();
            let grad = (de / dist_m).atan();
            if grad > max_grad {
                max_grad = grad;
            }
        }
        slope[c] = max_grad;
    }
    slope
}

/// Stream-power erosion rate per cell (positive value = material to remove).
///
/// `rate[c] = base_k * slope[c] * sqrt(flow_accum[c])` for land cells;
/// 0 for ocean cells and cells with no downstream receiver (sinks).
///
/// `base_k` carries the units that turn `slope * sqrt(area)` into the
/// elevation unit per simulation step. Callers multiply by their `dt` and
/// any climate factor before subtracting from `elev`.
pub fn stream_power_erosion(
    elev: &[f32],
    flow_accum: &[u32],
    flow_dirs: &[u32],
    slope: &[f32],
    base_k: f32,
) -> Vec<f32> {
    let n = elev.len();
    assert_eq!(flow_accum.len(), n);
    assert_eq!(flow_dirs.len(), n);
    assert_eq!(slope.len(), n);
    let mut rate = vec![0.0f32; n];
    for c in 0..n {
        if elev[c] <= SEA_LEVEL {
            continue;
        }
        if flow_dirs[c] == NO_FLOW {
            continue;
        }
        let area = flow_accum[c] as f32;
        rate[c] = base_k * slope[c] * area.sqrt();
    }
    rate
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::erosion::drainage::{compute_flow_accum, compute_flow_dirs, fill_pits};
    use crate::sphere::VoronoiSphere;

    fn single_peak_elev(sphere: &VoronoiSphere, peak: f32) -> Vec<f32> {
        sphere
            .positions()
            .iter()
            .map(|p| {
                let h = p.y * peak;
                h.max(-peak * 0.5)
            })
            .collect()
    }

    fn run_pipeline(sphere: &VoronoiSphere, elev: &[f32], base_k: f32) -> Vec<f32> {
        let filled = fill_pits(elev, sphere);
        let dirs = compute_flow_dirs(&filled, sphere);
        let accum = compute_flow_accum(&dirs, &filled);
        let slope = compute_slope(&filled, sphere);
        stream_power_erosion(&filled, &accum, &dirs, &slope, base_k)
    }

    #[test]
    fn slope_zero_on_flat_field() {
        let sphere = VoronoiSphere::new(8);
        let elev = vec![1000.0f32; sphere.n_fields() as usize];
        let s = compute_slope(&elev, &sphere);
        for &v in &s {
            assert!(v.abs() < 1e-6, "expected zero slope on flat field, got {}", v);
        }
    }

    #[test]
    fn slope_positive_on_smooth_peak() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let s = compute_slope(&elev, &sphere);
        // Some land cell must have nonzero slope.
        let any_positive = s.iter().any(|&v| v > 0.0);
        assert!(any_positive, "expected some positive slope on a peak");
    }

    #[test]
    fn ocean_cells_have_zero_erosion() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let rate = run_pipeline(&sphere, &elev, 1.0);
        for c in 0..elev.len() {
            if elev[c] <= SEA_LEVEL {
                assert!(
                    rate[c] == 0.0,
                    "ocean cell {} got nonzero erosion {}",
                    c,
                    rate[c]
                );
            }
        }
    }

    #[test]
    fn erosion_proportional_to_base_k() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let r1 = run_pipeline(&sphere, &elev, 1.0);
        let r2 = run_pipeline(&sphere, &elev, 2.0);
        for c in 0..elev.len() {
            if r1[c] == 0.0 {
                continue;
            }
            let ratio = r2[c] / r1[c];
            assert!(
                (ratio - 2.0).abs() < 1e-3,
                "rate not linear in base_k at cell {}: {} vs {}",
                c,
                r1[c],
                r2[c]
            );
        }
    }

    #[test]
    fn erosion_grows_with_drainage_area_along_a_flow_path() {
        // Along a flow path within ~uniform slope, sqrt(flow_accum) should
        // be non-decreasing downstream, so erosion rate should also be
        // non-decreasing (modulo slope variations). We test the weaker
        // claim: at least one downstream step on the peak shows higher
        // erosion than its upstream contributor.
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let filled = fill_pits(&elev, &sphere);
        let dirs = compute_flow_dirs(&filled, &sphere);
        let accum = compute_flow_accum(&dirs, &filled);
        let slope = compute_slope(&filled, &sphere);
        let rate = stream_power_erosion(&filled, &accum, &dirs, &slope, 1.0);

        let mut found = false;
        for c in 0..filled.len() {
            let fd = dirs[c];
            if fd == NO_FLOW {
                continue;
            }
            if filled[fd as usize] <= SEA_LEVEL {
                continue;
            }
            if rate[fd as usize] > rate[c] {
                found = true;
                break;
            }
        }
        assert!(found, "expected at least one downstream cell with higher erosion rate");
    }
}
