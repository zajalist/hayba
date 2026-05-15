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

use crate::rock::Rock;
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

/// Per-rock stream-power erodibility coefficient (relative).
///
/// Phase 5.2: rocks erode at different rates. Hard mafic plutonics (granite,
/// gabbro, eclogite) resist incision; soft sedimentaries (shale, sandstone,
/// limestone) wash away quickly. The chemically-soluble limestone is rated
/// well above its mechanical hardness would suggest because karst dissolution
/// dominates in humid climates. Unknown / unmatched rock ids return 1.0.
///
/// Values are unitless multipliers on `base_k`; the absolute scale is set by
/// the caller's `dt` and the climate term in [`climate_coupled_erosion`].
pub fn base_k_for_rock(rock_id: u8) -> f32 {
    // Match by numeric discriminant so callers passing a raw u8 from the
    // frame stream / crust column don't need to construct a Rock.
    if rock_id == Rock::Granite as u8 {
        0.5
    } else if rock_id == Rock::Basalt as u8 {
        0.7
    } else if rock_id == Rock::Gabbro as u8 {
        0.6
    } else if rock_id == Rock::Diorite as u8 {
        0.55
    } else if rock_id == Rock::Rhyolite as u8 {
        0.8
    } else if rock_id == Rock::Andesite as u8 {
        0.75
    } else if rock_id == Rock::Schist as u8 {
        0.9
    } else if rock_id == Rock::Gneiss as u8 {
        0.55
    } else if rock_id == Rock::Eclogite as u8 {
        0.4
    } else if rock_id == Rock::Blueschist as u8 {
        0.65
    } else if rock_id == Rock::Limestone as u8 {
        1.4
    } else if rock_id == Rock::Sandstone as u8 {
        1.6
    } else if rock_id == Rock::Shale as u8 {
        2.0
    } else if rock_id == Rock::OceanicSediment as u8 {
        1.8
    } else if rock_id == Rock::ContinentalSediment as u8 {
        1.7
    } else {
        1.0
    }
}

/// Climate-coupled stream-power erosion rate per cell.
///
/// `rate[c] = base_k_for_rock(top_rock[c]) * humidity[c] * slope[c] * sqrt(accum[c])`
/// for land cells with a downstream receiver; 0 elsewhere.
///
/// Combines Phase 5.1's stream-power kernel with Phase 6.1 humidity and
/// the topmost exposed rock from the crust column. Ocean / sink cells
/// return 0.
pub fn climate_coupled_erosion(
    elev: &[f32],
    flow_accum: &[u32],
    flow_dirs: &[u32],
    slope: &[f32],
    humidity: &[f32],
    top_rock_per_cell: &[u8],
) -> Vec<f32> {
    let n = elev.len();
    assert_eq!(flow_accum.len(), n);
    assert_eq!(flow_dirs.len(), n);
    assert_eq!(slope.len(), n);
    assert_eq!(humidity.len(), n);
    assert_eq!(top_rock_per_cell.len(), n);
    let mut rate = vec![0.0f32; n];
    for c in 0..n {
        if elev[c] <= SEA_LEVEL {
            continue;
        }
        if flow_dirs[c] == NO_FLOW {
            continue;
        }
        if slope[c] <= 0.0 {
            continue;
        }
        let area = flow_accum[c] as f32;
        let k = base_k_for_rock(top_rock_per_cell[c]);
        let h = humidity[c].max(0.0);
        rate[c] = k * h * slope[c] * area.sqrt();
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

    // -------------------------------------------------------------------
    // Phase 5.2 — climate-coupled erosion
    // -------------------------------------------------------------------

    #[test]
    fn base_k_orders_hard_below_soft() {
        // Hard plutonics (granite, eclogite) erode slowest; sediments fastest.
        assert!(base_k_for_rock(Rock::Granite as u8) < base_k_for_rock(Rock::Basalt as u8));
        assert!(base_k_for_rock(Rock::Eclogite as u8) < base_k_for_rock(Rock::Granite as u8));
        assert!(base_k_for_rock(Rock::Shale as u8) > base_k_for_rock(Rock::Sandstone as u8));
        assert!(base_k_for_rock(Rock::Sandstone as u8) > base_k_for_rock(Rock::Limestone as u8));
        assert!(base_k_for_rock(Rock::Limestone as u8) > base_k_for_rock(Rock::Granite as u8));
        // Unknown id falls back to 1.0.
        assert_eq!(base_k_for_rock(255), 1.0);
    }

    #[test]
    fn humid_mountain_erodes_at_least_4x_faster_than_arid() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let filled = fill_pits(&elev, &sphere);
        let dirs = compute_flow_dirs(&filled, &sphere);
        let accum = compute_flow_accum(&dirs, &filled);
        let slope = compute_slope(&filled, &sphere);
        let n = filled.len();
        let rocks = vec![Rock::Granite as u8; n];
        let humid = vec![0.9f32; n];
        let arid = vec![0.15f32; n];
        let r_humid = climate_coupled_erosion(&filled, &accum, &dirs, &slope, &humid, &rocks);
        let r_arid = climate_coupled_erosion(&filled, &accum, &dirs, &slope, &arid, &rocks);
        let sum_h: f32 = r_humid.iter().sum();
        let sum_a: f32 = r_arid.iter().sum();
        assert!(sum_a > 0.0, "arid total should be > 0");
        let ratio = sum_h / sum_a;
        // 0.9 / 0.15 = 6x. Allow a healthy floor of 4x.
        assert!(ratio >= 4.0, "humid/arid ratio {} too small", ratio);
    }

    #[test]
    fn granite_peak_erodes_slower_than_shale_peak() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let filled = fill_pits(&elev, &sphere);
        let dirs = compute_flow_dirs(&filled, &sphere);
        let accum = compute_flow_accum(&dirs, &filled);
        let slope = compute_slope(&filled, &sphere);
        let n = filled.len();
        let humid = vec![0.7f32; n];
        let granite = vec![Rock::Granite as u8; n];
        let shale = vec![Rock::Shale as u8; n];
        let r_g = climate_coupled_erosion(&filled, &accum, &dirs, &slope, &humid, &granite);
        let r_s = climate_coupled_erosion(&filled, &accum, &dirs, &slope, &humid, &shale);
        let sum_g: f32 = r_g.iter().sum();
        let sum_s: f32 = r_s.iter().sum();
        assert!(sum_g > 0.0);
        assert!(sum_s > sum_g, "shale {} should exceed granite {}", sum_s, sum_g);
        // base_k ratio = 2.0 / 0.5 = 4x exactly.
        let ratio = sum_s / sum_g;
        assert!((ratio - 4.0).abs() < 1e-3, "ratio {}", ratio);
    }

    #[test]
    fn ocean_cells_return_zero_climate_erosion() {
        let sphere = VoronoiSphere::new(8);
        let elev = single_peak_elev(&sphere, 4000.0);
        let filled = fill_pits(&elev, &sphere);
        let dirs = compute_flow_dirs(&filled, &sphere);
        let accum = compute_flow_accum(&dirs, &filled);
        let slope = compute_slope(&filled, &sphere);
        let n = filled.len();
        let humid = vec![0.9f32; n];
        let rocks = vec![Rock::Shale as u8; n];
        let rate = climate_coupled_erosion(&filled, &accum, &dirs, &slope, &humid, &rocks);
        for c in 0..n {
            if filled[c] <= SEA_LEVEL {
                assert_eq!(rate[c], 0.0, "ocean cell {} got nonzero erosion {}", c, rate[c]);
            }
        }
    }

    #[test]
    fn integration_100ma_humid_lowers_peak_more_than_arid() {
        // Synthetic 100 Ma erosion drop on a single-peak field. Apply the
        // rate * (some dt scale) once to mimic 100 Ma worth of average
        // incision; the humid case must drop the peak elevation more than
        // the arid case.
        let sphere = VoronoiSphere::new(16);
        let elev = single_peak_elev(&sphere, 4000.0);
        let filled = fill_pits(&elev, &sphere);
        let dirs = compute_flow_dirs(&filled, &sphere);
        let accum = compute_flow_accum(&dirs, &filled);
        let slope = compute_slope(&filled, &sphere);
        let n = filled.len();
        let rocks = vec![Rock::Granite as u8; n];
        let humid = vec![0.9f32; n];
        let arid = vec![0.15f32; n];
        let r_h = climate_coupled_erosion(&filled, &accum, &dirs, &slope, &humid, &rocks);
        let r_a = climate_coupled_erosion(&filled, &accum, &dirs, &slope, &arid, &rocks);

        // Notional "100 Ma" lump-sum dt — magnitudes don't matter for the
        // comparison, only the relative drop on the same peak cell.
        let dt = 100.0f32;
        let peak_idx = filled
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .unwrap()
            .0;
        let drop_h = (r_h[peak_idx] * dt).min(filled[peak_idx]);
        let drop_a = (r_a[peak_idx] * dt).min(filled[peak_idx]);
        let elev_h_after = filled[peak_idx] - drop_h;
        let elev_a_after = filled[peak_idx] - drop_a;
        // Humid peak ends up lower than arid peak. (If both saturate at the
        // sea floor the test is meaningless — guard against that.)
        assert!(drop_h > 0.0 && drop_a >= 0.0);
        assert!(
            elev_h_after < elev_a_after,
            "humid post-elev {} should be below arid post-elev {}",
            elev_h_after,
            elev_a_after
        );
    }
}
