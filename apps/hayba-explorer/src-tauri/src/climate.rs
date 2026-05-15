//! Annual-mean scientific climate model. Pure function of (grid topology,
//! per-cell elevation/ocean, seed). Recomputed every sim step inside
//! `snapshot_model`, so every algorithm here is strictly O(cells).
//! Grounded in the worldbuildingpasta simplified climate model.

use glam::Vec3;

/// Sea-level equatorial mean temperature (°C).
const T_EQUATOR: f32 = 30.0;
/// Equator→pole annual-mean cooling (°C) at sea level.
const T_LAT_DROP: f32 = 50.0;
/// Environmental lapse rate (°C per km) — worldbuildingpasta.
const LAPSE_C_PER_KM: f32 = 4.46;
/// vElevation 1.0 ≈ this many km (matches the shader's elevKm scaling).
const ELEV_KM_SCALE: f32 = 8.0;

/// Latitude in radians from a unit-sphere position (Y-up). 0 = equator,
/// ±π/2 = poles.
pub fn latitude_rad(p: Vec3) -> f32 {
    p.y.clamp(-1.0, 1.0).asin()
}

/// Annual-mean base surface temperature (°C) before continentality /
/// currents. Latitude falloff uses sin²(lat) (smooth, peaks at equator),
/// minus the elevation lapse.
pub fn base_temperature_c(p: Vec3, elevation: f32) -> f32 {
    let s = p.y.clamp(-1.0, 1.0); // sin(lat)
    let elev_km = elevation.max(0.0) * ELEV_KM_SCALE;
    T_EQUATOR - T_LAT_DROP * (s * s) - LAPSE_C_PER_KM * elev_km
}

/// Multi-source BFS from every ocean cell simultaneously. Returns hop
/// distance to the nearest ocean per cell. O(cells): each cell is
/// enqueued/dequeued at most once. `u32::MAX` only if a land cell is
/// unreachable (no ocean at all) — callers treat that as "max inland".
pub fn distance_to_ocean_hops(neighbours: &[Vec<u32>], is_ocean: &[bool]) -> Vec<u32> {
    use std::collections::VecDeque;
    let n = neighbours.len();
    let mut dist = vec![u32::MAX; n];
    let mut q: VecDeque<u32> = VecDeque::with_capacity(n);
    for i in 0..n {
        if is_ocean[i] {
            dist[i] = 0;
            q.push_back(i as u32);
        }
    }
    while let Some(c) = q.pop_front() {
        let dc = dist[c as usize];
        for &nb in &neighbours[c as usize] {
            if dist[nb as usize] == u32::MAX {
                dist[nb as usize] = dc + 1;
                q.push_back(nb);
            }
        }
    }
    dist
}

/// Prevailing surface wind as a unit tangent vector at `p`
/// (worldbuildingpasta bands): trades 0–30° (E→W), westerlies 30–60°
/// (W→E), polar easterlies 60–90° (E→W). Small equatorward meridional
/// component added for realism.
pub fn prevailing_wind(p: Vec3) -> Vec3 {
    let lat_deg = latitude_rad(p).abs().to_degrees();
    let east = Vec3::new(0.0, 1.0, 0.0).cross(p).normalize_or_zero();
    let sign = if lat_deg < 30.0 {
        -1.0 // trades, E→W
    } else if lat_deg < 60.0 {
        1.0 // westerlies, W→E
    } else {
        -1.0 // polar easterlies, E→W
    };
    let toward_eq = -p.y.signum();
    let north = p.cross(east).normalize_or_zero();
    (east * sign + north * toward_eq * 0.15).normalize_or_zero()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equator_warmer_than_pole() {
        let eq = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 0.0);
        let pole = base_temperature_c(Vec3::new(0.0, 1.0, 0.0), 0.0);
        assert!(eq > 25.0, "equator should be warm, got {}", eq);
        assert!(pole < 0.0, "pole should be freezing, got {}", pole);
        assert!(eq - pole > 40.0, "equator-pole gradient too small");
    }

    #[test]
    fn mountains_are_colder() {
        let lowland = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 0.0);
        let peak = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 1.0);
        assert!(lowland - peak > 30.0, "8km peak should be ~35°C colder");
    }

    #[test]
    fn dist_to_ocean_zero_at_ocean_and_grows_inland() {
        let neighbours: Vec<Vec<u32>> = vec![
            vec![1], vec![0, 2], vec![1, 3], vec![2, 4], vec![3],
        ];
        let is_ocean = vec![true, false, false, false, false];
        let d = distance_to_ocean_hops(&neighbours, &is_ocean);
        assert_eq!(d[0], 0);
        assert_eq!(d[1], 1);
        assert_eq!(d[4], 4);
    }

    #[test]
    fn dist_to_ocean_all_ocean_is_zero() {
        let neighbours: Vec<Vec<u32>> = vec![vec![1], vec![0]];
        let is_ocean = vec![true, true];
        let d = distance_to_ocean_hops(&neighbours, &is_ocean);
        assert_eq!(d, vec![0, 0]);
    }

    #[test]
    fn trade_winds_blow_west_westerlies_blow_east() {
        let p_trades = Vec3::new(0.966, 0.259, 0.0).normalize(); // ~15°N
        let w_trades = prevailing_wind(p_trades);
        let east = Vec3::new(0.0, 1.0, 0.0).cross(p_trades).normalize();
        assert!(w_trades.dot(east) < 0.0, "trades should blow westward");

        let p_west = Vec3::new(0.707, 0.707, 0.0).normalize(); // ~45°N
        let w_west = prevailing_wind(p_west);
        let east_w = Vec3::new(0.0, 1.0, 0.0).cross(p_west).normalize();
        assert!(w_west.dot(east_w) > 0.0, "westerlies should blow eastward");
    }
}
