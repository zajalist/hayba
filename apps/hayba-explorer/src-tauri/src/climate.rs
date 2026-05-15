//! Annual-mean scientific climate model. Pure function of (grid topology,
//! per-cell elevation/ocean, seed). Recomputed every sim step inside
//! `snapshot_model`, so every algorithm here is strictly O(cells).
//! Grounded in the worldbuildingpasta simplified climate model.

use glam::Vec3;
use hayba_tectonics_v2::model::Model;

/// User-tunable climate constants. Every default is byte-identical to the
/// hardcoded constant / inline magic it replaces, so `ClimateParams::default()`
/// reproduces today's behaviour exactly. Deserialized from the Tauri command
/// payload; `#[serde(default)]` means a missing/partial JSON object still
/// yields the full default set (per-field defaults via the Default impl).
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(default)]
pub struct ClimateParams {
    /// Sea-level equatorial mean temperature (°C).
    pub t_equator: f32,
    /// Equator→pole annual-mean cooling (°C) at sea level.
    pub t_lat_drop: f32,
    /// Environmental lapse rate (°C per km).
    pub lapse_c_per_km: f32,
    /// vElevation 1.0 ≈ this many km (matches the shader's elevKm scaling).
    pub elev_km_scale: f32,
    /// Coastalness → inland cooling amplitude (°C). Inline `coastalness * 6.0`.
    pub continental_cool: f32,
    /// Warm-side coastal current SST anomaly cap (°C).
    pub current_warm: f32,
    /// Cold-side coastal current SST anomaly cap (°C).
    pub current_cold: f32,
    /// Per-hop downwind moisture decay factor in the relaxation sweep.
    pub moisture_decay: f32,
    /// ITCZ band half-width (deg) in `zonal_precip`.
    pub itcz_width_deg: f32,
    /// Multiplier on the windward orographic precip enhancement.
    pub orographic_gain: f32,
    /// Multiplier on the lee rain-shadow precip cut.
    pub rain_shadow: f32,
    /// Boreal/tundra→colder thermal boundary (°C) in `classify_biome`.
    pub biome_cold_c: f32,
    /// Tropical-onset thermal boundary (°C) in `classify_biome`.
    pub biome_hot_c: f32,
}

impl Default for ClimateParams {
    fn default() -> Self {
        Self {
            t_equator: 30.0,
            t_lat_drop: 50.0,
            lapse_c_per_km: 4.46,
            elev_km_scale: 8.0,
            continental_cool: 6.0,
            current_warm: 12.0,
            current_cold: 10.0,
            moisture_decay: 0.94,
            itcz_width_deg: 16.0,
            orographic_gain: 0.6,
            rain_shadow: 0.5,
            biome_cold_c: 6.0,
            biome_hot_c: 18.0,
        }
    }
}

/// Latitude in radians from a unit-sphere position (Y-up). 0 = equator,
/// ±π/2 = poles.
pub fn latitude_rad(p: Vec3) -> f32 {
    p.y.clamp(-1.0, 1.0).asin()
}

/// Annual-mean base surface temperature (°C) before continentality /
/// currents. Latitude falloff uses sin²(lat) (smooth, peaks at equator),
/// minus the elevation lapse.
pub fn base_temperature_c(p: Vec3, elevation: f32, params: &ClimateParams) -> f32 {
    let s = p.y.clamp(-1.0, 1.0); // sin(lat)
    let elev_km = elevation.max(0.0) * params.elev_km_scale;
    params.t_equator - params.t_lat_drop * (s * s) - params.lapse_c_per_km * elev_km
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

/// The neighbour the wind blows FROM (max dot of (p_i - p_nb)·wind).
fn upwind_neighbour(pos: &[Vec3], neighbours: &[Vec<u32>], i: usize, wind: Vec3) -> i64 {
    let mut best = -1i64;
    let mut best_d = -2.0f32;
    for &nb in &neighbours[i] {
        let dir = (pos[i] - pos[nb as usize]).normalize_or_zero();
        let d = dir.dot(wind);
        if d > best_d {
            best_d = d;
            best = nb as i64;
        }
    }
    best
}

/// Coastal SST anomaly (°C). Warm if the adjacent ocean lies equatorward
/// of the cell (warm water advected poleward up the coast); cold if it
/// lies poleward (cold equatorward current / upwelling). Peaks mid-high
/// latitude (~45–60°), decays to ~0 inland. Geography-driven from the
/// per-cell mean ocean direction — no fixed-longitude basins.
pub fn current_temp_anomaly(
    p: Vec3,
    ocean_dir: Vec3,
    coastalness: f32,
    params: &ClimateParams,
) -> f32 {
    if ocean_dir.length_squared() < 1e-6 {
        return 0.0; // landlocked: no nearby ocean to advect anything
    }
    let lat = latitude_rad(p);
    // Equatorward unit tangent at p: take the world vector toward the
    // equator (-sign(lat)·Y), remove its radial (p) component so it lies
    // in p's tangent plane, then normalize. Same tangent-projection
    // trick as `prevailing_wind`'s meridional term.
    let to_eq = -(Vec3::Y * lat.signum());
    let equatorward = (to_eq - p * to_eq.dot(p)).normalize_or_zero();
    // +1: ocean lies equatorward → warm water advected poleward up the
    // coast (warm anomaly). −1: ocean lies poleward → cold current /
    // upwelling (cold anomaly).
    let s = ocean_dir.dot(equatorward);
    let lat_deg = lat.abs().to_degrees();
    let strength = (1.0 - ((lat_deg - 52.0) / 38.0).powi(2)).clamp(0.0, 1.0);
    let coastal = (1.0 - coastalness).clamp(0.0, 1.0);
    // Warm side up to +current_warm °C, cold side down to −current_cold °C.
    let amp = if s >= 0.0 { params.current_warm } else { params.current_cold };
    s * strength * coastal * coastal * amp
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

/// Single-argument smoothstep on a value already in roughly [0,1].
fn smoothstep01(x: f32) -> f32 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Latitudinal precipitation base (worldbuildingpasta cells): wet ITCZ
/// (~0°), dry subtropics (~30°), wet mid-lats (~55–60°), dry poles.
/// Returns ~[0,1].
pub fn zonal_precip(lat_rad: f32, params: &ClimateParams) -> f32 {
    let d = lat_rad.abs().to_degrees();
    let itcz    = 1.0 - smoothstep(0.0, params.itcz_width_deg, d);
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

// Biome ids — order matches the SatMap slot order in mesh.ts.
pub const BIOME_TROPICAL_RAINFOREST: u8 = 0;
pub const BIOME_TROPICAL_SAVANNA: u8 = 1;
pub const BIOME_HOT_DESERT: u8 = 2;
pub const BIOME_TEMPERATE_RAINFOREST: u8 = 3;
pub const BIOME_TEMPERATE_FOREST: u8 = 4;
pub const BIOME_WOODLAND_SHRUB: u8 = 5;
pub const BIOME_GRASSLAND: u8 = 6;
pub const BIOME_BOREAL: u8 = 7;
pub const BIOME_TUNDRA: u8 = 8;
pub const BIOME_ICE: u8 = 9;

/// Whittaker classification from annual mean temperature (°C) and
/// precipitation (0..1). Hard cut by temperature first (Köppen-style
/// thermal limits), then precipitation within the thermal band.
pub fn classify_biome(temp_c: f32, precip: f32, params: &ClimateParams) -> u8 {
    if temp_c < -15.0 {
        return BIOME_ICE;
    }
    if temp_c < -2.0 {
        return BIOME_TUNDRA;
    }
    if temp_c < params.biome_cold_c {
        return BIOME_BOREAL;
    }
    if temp_c < params.biome_hot_c {
        if precip > 0.7 {
            return BIOME_TEMPERATE_RAINFOREST;
        }
        if precip > 0.4 {
            return BIOME_TEMPERATE_FOREST;
        }
        if precip > 0.2 {
            return BIOME_WOODLAND_SHRUB;
        }
        return BIOME_GRASSLAND;
    }
    if precip > 0.6 {
        return BIOME_TROPICAL_RAINFOREST;
    }
    if precip > 0.2 {
        return BIOME_TROPICAL_SAVANNA;
    }
    BIOME_HOT_DESERT
}

/// Always-shipped per-cell climate output (floats for direct upload as
/// Three.js buffer attributes; biome id stored as f32).
pub struct ClimateFields {
    pub temperature: Vec<f32>, // °C
    pub precip: Vec<f32>,      // 0..1
    pub biome: Vec<f32>,       // primary biome id 0..9 as f32
    pub biome2: Vec<f32>,      // secondary (perturbed) biome id 0..9 as f32
    pub biome_blend: Vec<f32>, // primary→secondary blend weight, 0..0.5
    /// Per-cell STABLE pseudo-random unit vec3 (n*3), keyed on the
    /// immutable cell INDEX (not its drifting position). The shader keys
    /// its within-biome surface texture noise on this so the texture rides
    /// with the crust instead of crawling through a world-locked field.
    pub cell_seed: Vec<f32>,
    pub debug: Option<ClimateDebug>,
}

/// Inspectable intermediates (only when `want_debug`). One f32 per cell
/// each; wind packed as (x,y,z) triples.
pub struct ClimateDebug {
    pub insolation: Vec<f32>,
    pub base_temp: Vec<f32>,
    pub dist_to_ocean: Vec<f32>, // km
    pub wind: Vec<f32>,          // n*3
    pub current_dt: Vec<f32>,
    pub orographic: Vec<f32>,
    pub continental_dry: Vec<f32>,
}

/// Run the full annual-mean climate model. O(cells): one BFS + per-cell
/// analytic passes + one bounded orographic neighbour read.
pub fn compute_climate(
    model: &Model,
    seed: u64,
    want_debug: bool,
    params: &ClimateParams,
) -> ClimateFields {
    let grid = &model.grid;
    let n = grid.n_fields() as usize;

    let mut pos: Vec<Vec3> = Vec::with_capacity(n);
    let mut elev: Vec<f32> = Vec::with_capacity(n);
    let mut is_ocean: Vec<bool> = Vec::with_capacity(n);
    for fid in 0..n as u32 {
        let p = grid.position(fid);
        let f = &model.fields[fid as usize];
        pos.push(p);
        elev.push(f.elevation);
        is_ocean.push(!f.is_continent_crust() || f.elevation < 0.0);
    }

    let neighbours: Vec<Vec<u32>> =
        (0..n as u32).map(|fid| grid.neighbours(fid).to_vec()).collect();
    let hops = distance_to_ocean_hops(&neighbours, &is_ocean);

    let km_per_hop = grid.field_area_km2().sqrt();
    let max_hop = (*hops.iter().filter(|&&h| h != u32::MAX).max().unwrap_or(&1)).max(1);

    // Per-cell unit mean direction toward nearby ocean (1- and 2-ring
    // neighbours, 2-ring half-weighted). Drives the geography-derived
    // coastal current anomaly — replaces the old fixed-longitude basins.
    // O(cells): bounded neighbour fan-out, single pass.
    let ocean_dir: Vec<Vec3> = (0..n)
        .map(|i| {
            let mut acc = Vec3::ZERO;
            for &nb in &neighbours[i] {
                if is_ocean[nb as usize] {
                    acc += pos[nb as usize] - pos[i];
                }
                for &nb2 in &neighbours[nb as usize] {
                    if is_ocean[nb2 as usize] {
                        acc += 0.5 * (pos[nb2 as usize] - pos[i]);
                    }
                }
            }
            acc.normalize_or_zero()
        })
        .collect();

    // Downwind moisture transport. Moisture sourced at oceans (=1.0) is
    // carried inland along the prevailing wind, decayed per hop, and
    // blocked where terrain rises into the wind → real lee deserts.
    let winds: Vec<Vec3> = (0..n).map(|i| prevailing_wind(pos[i])).collect();
    let up: Vec<i64> = (0..n)
        .map(|i| upwind_neighbour(&pos, &neighbours, i, winds[i]))
        .collect();
    let mut moist = vec![0.0f32; n];
    for i in 0..n {
        if is_ocean[i] {
            moist[i] = 1.0;
        }
    }
    // Bounded relaxation (K = 6): O(cells·K). Moisture carried from the
    // upwind cell, decayed per hop, blocked where terrain rises into the wind.
    for _ in 0..6 {
        for i in 0..n {
            if is_ocean[i] {
                continue;
            }
            let u = up[i];
            if u < 0 {
                continue;
            }
            let ui = u as usize;
            let rise = (elev[i] - elev[ui]).max(0.0);
            let block = 1.0 - smoothstep(0.06, 0.20, rise);
            moist[i] = moist[i].max(moist[ui] * params.moisture_decay * block);
        }
    }

    let mut temperature = vec![0.0f32; n];
    let mut precip = vec![0.0f32; n];
    let mut biome = vec![0.0f32; n];
    let mut biome2 = vec![0.0f32; n];
    let mut biome_blend = vec![0.0f32; n];
    let mut cell_seed = vec![0.0f32; n * 3];

    let mut dbg = if want_debug {
        Some(ClimateDebug {
            insolation: vec![0.0; n],
            base_temp: vec![0.0; n],
            dist_to_ocean: vec![0.0; n],
            wind: vec![0.0; n * 3],
            current_dt: vec![0.0; n],
            orographic: vec![0.0; n],
            continental_dry: vec![0.0; n],
        })
    } else {
        None
    };

    for i in 0..n {
        let p = pos[i];
        let lat = latitude_rad(p);
        let coastalness = if hops[i] == u32::MAX {
            1.0
        } else {
            (hops[i] as f32 / max_hop as f32).clamp(0.0, 1.0)
        };

        let base_t = base_temperature_c(p, elev[i], params);
        let cur_dt = current_temp_anomaly(p, ocean_dir[i], coastalness, params);
        let cont_cool = coastalness * params.continental_cool;
        let t = base_t + cur_dt - cont_cool;
        temperature[i] = t;

        let wind = prevailing_wind(p);
        let mut up_grad = 0.0f32;
        for &nb in &neighbours[i] {
            let to_nb = (pos[nb as usize] - p).normalize_or_zero();
            let de = elev[nb as usize] - elev[i];
            up_grad += de * to_nb.dot(wind);
        }
        let orographic = (up_grad * 6.0).clamp(-1.0, 1.0);

        let zonal = zonal_precip(lat, params);
        let cont = continental_factor(if hops[i] == u32::MAX { max_hop } else { hops[i] });
        let pn = value_noise(p * 3.5, seed) - 0.5;
        // Physically-ordered precip: humid air supply (zonal vs.
        // transported ocean moisture) lifted on windward slopes (oro),
        // wrung out on the lee (lee), with residual continental drying.
        let base_h = zonal.max(moist[i] * 0.85);
        let oro = orographic.max(0.0) * params.orographic_gain;
        let lee = (-orographic).max(0.0) * params.rain_shadow;
        let dry = 1.0 - cont;
        let pr =
            (base_h + oro - lee - dry * 0.5 + pn * 0.12).clamp(0.0, 1.0);
        precip[i] = pr;

        let primary = classify_biome(t, pr, params);
        let nt = (value_noise(p * 9.0, seed ^ 0x9E37) - 0.5) * 6.0;
        let np = (value_noise(p * 9.0, seed ^ 0x1234) - 0.5) * 0.20;
        let secondary = classify_biome(t + nt, (pr + np).clamp(0.0, 1.0), params);
        let blend = if secondary == primary {
            0.0
        } else {
            0.5 * smoothstep01((nt.abs() / 3.0 + np.abs() / 0.10) * 0.5)
        };
        biome[i] = primary as f32;
        biome2[i] = secondary as f32;
        biome_blend[i] = blend;

        // Cell-stable texture seed (flaw A3): a deterministic
        // pseudo-random unit vec3 derived ONLY from the immutable cell
        // index `i` + the planet `seed`. Independent of position, so it
        // does NOT change as the plate (and this cell) drifts — the
        // shader paints its within-biome texture on THIS, so the surface
        // rides with the crust instead of crawling through world space.
        let sx = value_noise(Vec3::new(i as f32 * 0.1373, 7.1, 2.3), seed ^ 0xA53F) * 2.0 - 1.0;
        let sy = value_noise(Vec3::new(i as f32 * 0.2917, 3.7, 9.1), seed ^ 0x91E7) * 2.0 - 1.0;
        let sz = value_noise(Vec3::new(i as f32 * 0.4519, 1.9, 5.5), seed ^ 0x7C2B) * 2.0 - 1.0;
        let s = Vec3::new(sx, sy, sz).normalize_or_zero();
        cell_seed[i * 3] = s.x;
        cell_seed[i * 3 + 1] = s.y;
        cell_seed[i * 3 + 2] = s.z;

        if let Some(d) = dbg.as_mut() {
            d.insolation[i] = (1.0 - (p.y * p.y)).clamp(0.0, 1.0);
            d.base_temp[i] = base_t;
            d.dist_to_ocean[i] = if hops[i] == u32::MAX {
                max_hop as f32 * km_per_hop
            } else {
                hops[i] as f32 * km_per_hop
            };
            d.wind[i * 3] = wind.x;
            d.wind[i * 3 + 1] = wind.y;
            d.wind[i * 3 + 2] = wind.z;
            d.current_dt[i] = cur_dt;
            d.orographic[i] = orographic;
            d.continental_dry[i] = 1.0 - cont;
        }
    }

    ClimateFields { temperature, precip, biome, biome2, biome_blend, cell_seed, debug: dbg }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equator_warmer_than_pole() {
        let cp = ClimateParams::default();
        let eq = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 0.0, &cp);
        let pole = base_temperature_c(Vec3::new(0.0, 1.0, 0.0), 0.0, &cp);
        assert!(eq > 25.0, "equator should be warm, got {}", eq);
        assert!(pole < 0.0, "pole should be freezing, got {}", pole);
        assert!(eq - pole > 40.0, "equator-pole gradient too small");
    }

    #[test]
    fn mountains_are_colder() {
        let cp = ClimateParams::default();
        let lowland = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 0.0, &cp);
        let peak = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 1.0, &cp);
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
        let cp = ClimateParams::default();
        // ~45°N mid-latitude coastal cell.
        let p = Vec3::new(0.5, 0.7, 0.5).normalize();
        // Equatorward unit tangent at p (toward equator, in tangent plane).
        let to_eq = -(Vec3::Y * latitude_rad(p).signum());
        let equatorward = (to_eq - p * to_eq.dot(p)).normalize_or_zero();
        let poleward = -equatorward;

        // Ocean equatorward → warm water advected poleward → warm anomaly,
        // and the magnitude must stay inside the ±12 °C envelope.
        let warm = current_temp_anomaly(p, equatorward, 0.05, &cp);
        assert!(warm.abs() <= 12.001, "anomaly out of range: {}", warm);
        assert!(warm > 0.0, "ocean equatorward should warm the coast: {}", warm);

        // Same cell, ocean poleward → cold current / upwelling → cold.
        let cold = current_temp_anomaly(p, poleward, 0.05, &cp);
        assert!(cold.abs() <= 12.001, "anomaly out of range: {}", cold);
        assert!(cold < 0.0, "ocean poleward should cool the coast: {}", cold);

        // Deep interior: effect decays to ~0 regardless of ocean dir.
        let deep_inland = current_temp_anomaly(p, equatorward, 0.95, &cp);
        assert!(deep_inland.abs() < 1.0, "interior should be ~unaffected: {}", deep_inland);

        // Landlocked (zero ocean direction) → exactly no anomaly.
        let landlocked = current_temp_anomaly(p, Vec3::ZERO, 0.05, &cp);
        assert_eq!(landlocked, 0.0, "no nearby ocean → no anomaly");
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
        let cp = ClimateParams::default();
        let itcz   = zonal_precip(0.0_f32.to_radians(), &cp);
        let dry30  = zonal_precip(30.0_f32.to_radians(), &cp);
        let mid55  = zonal_precip(55.0_f32.to_radians(), &cp);
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

    #[test]
    fn whittaker_classifies_canonical_points() {
        let cp = ClimateParams::default();
        assert_eq!(classify_biome(28.0, 0.9, &cp), BIOME_TROPICAL_RAINFOREST);
        assert_eq!(classify_biome(28.0, 0.1, &cp), BIOME_HOT_DESERT);
        assert_eq!(classify_biome(28.0, 0.45, &cp), BIOME_TROPICAL_SAVANNA);
        assert_eq!(classify_biome(12.0, 0.9, &cp), BIOME_TEMPERATE_RAINFOREST);
        assert_eq!(classify_biome(12.0, 0.2, &cp), BIOME_GRASSLAND);
        assert_eq!(classify_biome(2.0, 0.6, &cp), BIOME_BOREAL);
        assert_eq!(classify_biome(-8.0, 0.5, &cp), BIOME_TUNDRA);
        assert_eq!(classify_biome(-25.0, 0.5, &cp), BIOME_ICE);
    }

    #[test]
    fn equatorial_peak_is_cold_not_rainforest() {
        let cp = ClimateParams::default();
        let t = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 1.0, &cp);
        let b = classify_biome(t, 0.9, &cp);
        assert!(b == BIOME_TUNDRA || b == BIOME_ICE || b == BIOME_BOREAL,
                "tall equatorial peak must be a cold biome, got {}", b);
    }

    #[test]
    fn compute_climate_smoke_on_demo_model() {
        use hayba_tectonics_v2::model::Model;
        let model = Model::new(16, 7);
        let n = model.grid.n_fields() as usize;
        let cp = ClimateParams::default();
        let cf = compute_climate(&model, 7, true, &cp);
        assert_eq!(cf.temperature.len(), n);
        assert_eq!(cf.precip.len(), n);
        assert_eq!(cf.biome.len(), n);
        let dbg = cf.debug.expect("debug requested");
        assert_eq!(dbg.dist_to_ocean.len(), n);
        assert!(cf.biome.iter().all(|&b| b <= 9.0));
        let cf2 = compute_climate(&model, 7, false, &cp);
        assert!(cf2.debug.is_none());
    }

    #[test]
    fn compute_climate_secondary_biome_and_blend() {
        use hayba_tectonics_v2::model::Model;
        let model = Model::new(16, 7);
        let n = model.grid.n_fields() as usize;
        let cf = compute_climate(&model, 7, false, &ClimateParams::default());
        assert_eq!(cf.biome2.len(), n);
        assert_eq!(cf.biome_blend.len(), n);
        assert!(
            cf.biome_blend.iter().all(|&b| (0.0..=0.5).contains(&b)),
            "blend must stay in 0..=0.5"
        );
        // A whole planet always has biome boundaries somewhere.
        let has_boundary = (0..n)
            .any(|i| cf.biome2[i] != cf.biome[i] && cf.biome_blend[i] > 0.0);
        assert!(has_boundary, "expected at least one mixed cell");
    }

    #[test]
    fn cell_seed_is_stable_and_unitish() {
        use hayba_tectonics_v2::model::Model;
        let model = Model::new(16, 7);
        let n = model.grid.n_fields() as usize;

        let a = compute_climate(&model, 7, false, &ClimateParams::default());
        let b = compute_climate(&model, 7, false, &ClimateParams::default());
        assert_eq!(a.cell_seed.len(), n * 3, "cell_seed must be n*3");
        // Index-derived only → bit-identical across calls on the same model.
        assert_eq!(
            a.cell_seed, b.cell_seed,
            "cell_seed must be deterministic / stable"
        );
        // Each per-cell vec3 is a normalized unit vector (or exactly zero
        // from normalize_or_zero on the astronomically-unlikely all-zero).
        for i in 0..n {
            let x = a.cell_seed[i * 3];
            let y = a.cell_seed[i * 3 + 1];
            let z = a.cell_seed[i * 3 + 2];
            let len = (x * x + y * y + z * z).sqrt();
            assert!(
                len == 0.0 || (0.9..=1.1).contains(&len),
                "cell {} seed length out of range: {}",
                i,
                len
            );
        }
    }

    #[test]
    fn upwind_neighbour_picks_cell_wind_blows_from() {
        // 3-cell line along +X: 0 at x=-1, 1 at x=0, 2 at x=+1.
        // Wind blows toward +X, so the upwind neighbour of cell 1 is
        // cell 0 (the −X side, the cell the wind came from).
        let pos = vec![
            Vec3::new(-1.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
        ];
        let neighbours: Vec<Vec<u32>> = vec![vec![1], vec![0, 2], vec![1]];
        let wind = Vec3::new(1.0, 0.0, 0.0);
        let u = upwind_neighbour(&pos, &neighbours, 1, wind);
        assert_eq!(u, 0, "wind +X → upwind of middle cell is the −X cell");
        // Edge cell still resolves to its only neighbour.
        assert_eq!(upwind_neighbour(&pos, &neighbours, 2, wind), 1);
        // No neighbours → −1 sentinel.
        let empty: Vec<Vec<u32>> = vec![vec![]];
        assert_eq!(
            upwind_neighbour(&[Vec3::ZERO], &empty, 0, wind),
            -1,
            "no neighbours yields the -1 sentinel"
        );
    }

    #[test]
    fn moisture_relaxation_produces_lee_rain_shadow() {
        // 4-cell chain, wind blows ocean→inland (0→1→2→3):
        //   0 = ocean (moisture source)
        //   1 = low land  (pre-mountain, windward)
        //   2 = HIGH land (the mountain — rises into the wind)
        //   3 = low land  (post-mountain, the lee)
        // Upwind of i is i-1. Run the exact 6-iteration recurrence
        // from compute_climate inline and assert the lee cell ends up
        // drier than the windward cell.
        let elev = [0.0f32, 0.05, 0.40, 0.05];
        let is_ocean = [true, false, false, false];
        let up: [i64; 4] = [-1, 0, 1, 2];
        let mut moist = [0.0f32; 4];
        moist[0] = 1.0; // ocean source

        for _ in 0..6 {
            for i in 0..4 {
                if is_ocean[i] {
                    continue;
                }
                let u = up[i];
                if u < 0 {
                    continue;
                }
                let ui = u as usize;
                let rise = (elev[i] - elev[ui]).max(0.0);
                let block = 1.0 - smoothstep(0.06, 0.20, rise);
                moist[i] = moist[i].max(moist[ui] * 0.94 * block);
            }
        }

        let windward = moist[1]; // pre-mountain
        let lee = moist[3]; // post-mountain (rain shadow)
        assert!(
            lee < windward,
            "lee cell ({}) must be drier than windward cell ({})",
            lee,
            windward
        );
        // The mountain itself should heavily block transport.
        assert!(
            lee < 0.5,
            "lee should be substantially dried by the mountain, got {}",
            lee
        );
        // Sanity: the windward side still gets near-source moisture.
        assert!(
            windward > 0.5,
            "windward side should stay humid, got {}",
            windward
        );
    }
}
