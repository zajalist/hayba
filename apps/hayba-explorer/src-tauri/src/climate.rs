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

/// Coastal temperature anomaly (°C) from analytic subtropical gyres.
/// Warm poleward western-boundary currents (up to +12°C), cold
/// equatorward eastern-boundary currents (down to −10°C → coastal
/// deserts). `coastalness` is the normalized inland fraction (0 = coast,
/// 1 = deep interior); the effect decays to ~0 inland.
pub fn current_temp_anomaly(p: Vec3, coastalness: f32) -> f32 {
    let lat = latitude_rad(p);
    let lat_deg = lat.abs().to_degrees();
    let lon = p.z.atan2(p.x); // −π..π
    let basin_phase = (lon / (std::f32::consts::PI * 2.0 / 3.0)).fract();
    let west_side = if basin_phase < 0.5 { 1.0 } else { -1.0 };
    let strength = (1.0 - ((lat_deg - 50.0) / 40.0).powi(2)).clamp(0.0, 1.0);
    let warm = west_side * lat.signum() * lat.signum(); // ±1
    let raw = warm * strength * if west_side > 0.0 { 12.0 } else { -10.0 };
    let coastal = (1.0 - coastalness).clamp(0.0, 1.0);
    raw * coastal * coastal
}

fn hash3(x: i32, y: i32, z: i32, seed: u64) -> f32 {
    let mut h = (x as i64).wrapping_mul(374_761_393)
        ^ (y as i64).wrapping_mul(668_265_263)
        ^ (z as i64).wrapping_mul(2_147_483_647)
        ^ seed as i64;
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h = h ^ (h >> 16);
    ((h as u64 & 0xFFFF_FFFF) as f32) / 4_294_967_296.0
}

/// Trilinear value noise in [0, 1]. Deterministic given `seed`.
pub fn value_noise(p: Vec3, seed: u64) -> f32 {
    let ix = p.x.floor() as i32;
    let iy = p.y.floor() as i32;
    let iz = p.z.floor() as i32;
    let fx = p.x - ix as f32;
    let fy = p.y - iy as f32;
    let fz = p.z - iz as f32;
    let sx = fx * fx * (3.0 - 2.0 * fx);
    let sy = fy * fy * (3.0 - 2.0 * fy);
    let sz = fz * fz * (3.0 - 2.0 * fz);
    let c = |dx, dy, dz| hash3(ix + dx, iy + dy, iz + dz, seed);
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let x00 = lerp(c(0, 0, 0), c(1, 0, 0), sx);
    let x10 = lerp(c(0, 1, 0), c(1, 1, 0), sx);
    let x01 = lerp(c(0, 0, 1), c(1, 0, 1), sx);
    let x11 = lerp(c(0, 1, 1), c(1, 1, 1), sx);
    let y0 = lerp(x00, x10, sy);
    let y1 = lerp(x01, x11, sy);
    lerp(y0, y1, sz)
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Latitudinal precipitation base (worldbuildingpasta cells): wet ITCZ
/// (~0°), dry subtropics (~30°), wet mid-lats (~55–60°), dry poles.
/// Returns ~[0,1].
pub fn zonal_precip(lat_rad: f32) -> f32 {
    let d = lat_rad.abs().to_degrees();
    let itcz    = 1.0 - smoothstep(0.0, 16.0, d);
    let subtrop = 1.0 - smoothstep(0.0, 12.0, (d - 30.0).abs());
    let midlat  = 1.0 - smoothstep(0.0, 14.0, (d - 58.0).abs());
    let polar   = smoothstep(62.0, 82.0, d);
    (0.85 * itcz - 0.6 * subtrop + 0.55 * midlat - 0.4 * polar + 0.35)
        .clamp(0.0, 1.0)
}

/// Continental drying multiplier from ocean hop-distance. Coast → ~1,
/// deep interior → ~0.25.
pub fn continental_factor(hops_from_ocean: u32) -> f32 {
    let h = hops_from_ocean as f32;
    1.0 - 0.75 * smoothstep(2.0, 45.0, h)
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

    #[test]
    fn current_anomaly_bounded_and_signed() {
        let coastal_west = current_temp_anomaly(
            Vec3::new(0.5, 0.7, 0.5).normalize(), 0.05);
        assert!(coastal_west.abs() <= 12.001, "anomaly out of range: {}", coastal_west);
        let deep_inland = current_temp_anomaly(
            Vec3::new(0.5, 0.7, 0.5).normalize(), 0.95);
        assert!(deep_inland.abs() < 1.0, "interior should be ~unaffected: {}", deep_inland);
    }

    #[test]
    fn vnoise_deterministic_and_bounded() {
        let a = value_noise(Vec3::new(1.2, 3.4, 5.6), 42);
        let b = value_noise(Vec3::new(1.2, 3.4, 5.6), 42);
        assert_eq!(a, b, "must be deterministic");
        for i in 0..50 {
            let v = value_noise(Vec3::new(i as f32 * 0.7, 1.3, -2.1), 7);
            assert!(v >= 0.0 && v <= 1.0, "out of [0,1]: {}", v);
        }
    }

    #[test]
    fn zonal_precip_wet_itcz_dry_subtropics() {
        let itcz   = zonal_precip(0.0_f32.to_radians());
        let dry30  = zonal_precip(30.0_f32.to_radians());
        let mid55  = zonal_precip(55.0_f32.to_radians());
        assert!(itcz > dry30, "ITCZ ({}) must be wetter than 30° ({})", itcz, dry30);
        assert!(mid55 > dry30, "mid-lat ({}) wetter than 30° ({})", mid55, dry30);
        assert!((0.0..=1.0).contains(&itcz));
    }

    #[test]
    fn continental_drying_reduces_precip_inland() {
        let coast  = continental_factor(2);
        let deep   = continental_factor(60);
        assert!(coast > deep, "coast ({}) wetter factor than interior ({})", coast, deep);
        assert!((0.0..=1.0).contains(&deep));
    }
}
