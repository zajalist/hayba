//! Surface ocean currents + temperature redistribution (Phase 6.2).
//!
//! Detects ocean basins via BFS over the Voronoi neighbour graph, places one
//! gyre per basin (centered at the spherical centroid, signed by hemisphere),
//! and advects per-cell temperature along the resulting surface-tangent field.
//!
//! Hayba extension beyond stock tectonic-explorer.

use crate::sphere::VoronoiSphere;
use glam::Vec3;

/// A single rotating ocean gyre.
#[derive(Debug, Clone, Copy)]
pub struct Gyre {
    /// Unit-sphere position of the gyre center.
    pub center_pos: Vec3,
    /// Angular extent of the gyre on the unit sphere (radians).
    pub radius_rad: f32,
    /// +1 = clockwise (northern hemisphere), -1 = counter-clockwise (southern).
    pub direction: f32,
    /// Scale factor proportional to sqrt(basin_size / total_ocean_cells).
    pub strength: f32,
}

/// Connected components on the ocean cell subgraph, traversed via
/// [`VoronoiSphere::neighbours`].
pub fn detect_ocean_basins(sphere: &VoronoiSphere, is_ocean: &[bool]) -> Vec<Vec<u32>> {
    let n = sphere.n_fields() as usize;
    assert_eq!(is_ocean.len(), n, "is_ocean length must match n_fields");
    let mut visited = vec![false; n];
    let mut basins: Vec<Vec<u32>> = Vec::new();

    for seed in 0..n {
        if !is_ocean[seed] || visited[seed] {
            continue;
        }
        let mut basin = Vec::new();
        let mut queue: Vec<u32> = Vec::new();
        queue.push(seed as u32);
        visited[seed] = true;
        while let Some(cell) = queue.pop() {
            basin.push(cell);
            for &nb in sphere.neighbours(cell) {
                let i = nb as usize;
                if is_ocean[i] && !visited[i] {
                    visited[i] = true;
                    queue.push(nb);
                }
            }
        }
        basins.push(basin);
    }

    basins
}

/// Place one [`Gyre`] per basin.
pub fn place_gyres(sphere: &VoronoiSphere, basins: &[Vec<u32>]) -> Vec<Gyre> {
    let total: usize = basins.iter().map(|b| b.len()).sum();
    if total == 0 {
        return Vec::new();
    }
    let mut gyres = Vec::with_capacity(basins.len());
    for basin in basins {
        if basin.is_empty() {
            continue;
        }
        // Spherical centroid = normalized sum of positions.
        let mut sum = Vec3::ZERO;
        for &c in basin {
            sum += sphere.position(c);
        }
        let center = if sum.length_squared() > 1e-12 {
            sum.normalize()
        } else {
            // Degenerate (antipodal cancellation) — pick first cell.
            sphere.position(basin[0])
        };
        // Angular extent: max angle from centroid, halved.
        let mut max_ang: f32 = 0.0;
        for &c in basin {
            let cos_a = center.dot(sphere.position(c)).clamp(-1.0, 1.0);
            let ang = cos_a.acos();
            if ang > max_ang {
                max_ang = ang;
            }
        }
        let radius_rad = (max_ang * 0.5).max(1e-3);
        let direction = if center.y > 0.0 { 1.0 } else { -1.0 };
        let strength = ((basin.len() as f32) / (total as f32)).sqrt();
        gyres.push(Gyre {
            center_pos: center,
            radius_rad,
            direction,
            strength,
        });
    }
    gyres
}

/// Surface-tangent current vector contributed by one gyre at `cell_pos`.
///
/// Returns zero outside the gyre's `radius_rad`. Magnitude is
/// `strength * (1 - angular_dist / radius_rad)`. The tangent direction is the
/// unit vector perpendicular to (cell_pos - center) within the local tangent
/// plane, with sign from `direction`.
pub fn surface_current_at(cell_pos: Vec3, gyre: &Gyre) -> [f32; 3] {
    let cp = cell_pos.normalize_or_zero();
    if cp.length_squared() < 0.5 {
        return [0.0, 0.0, 0.0];
    }
    let cos_a = cp.dot(gyre.center_pos).clamp(-1.0, 1.0);
    let ang = cos_a.acos();
    if ang >= gyre.radius_rad || gyre.radius_rad <= 0.0 {
        return [0.0, 0.0, 0.0];
    }
    // Outward-tangent direction along the surface from center → cell:
    //   t_out = normalize(cp - cos_a * center)
    // Rotate 90° around the cell's local up (cp) to get cyclonic flow:
    //   t_cyc = cp × t_out   (right-hand rule)
    let t_out = cp - gyre.center_pos * cos_a;
    let t_out_n = t_out.normalize_or_zero();
    if t_out_n.length_squared() < 0.5 {
        return [0.0, 0.0, 0.0];
    }
    let t_cyc = cp.cross(t_out_n).normalize_or_zero();
    let mag = gyre.strength * (1.0 - ang / gyre.radius_rad);
    let v = t_cyc * (gyre.direction * mag);
    [v.x, v.y, v.z]
}

/// Sum every gyre's surface current at every ocean cell. Non-ocean cells get
/// the zero vector.
pub fn compute_cell_currents(
    sphere: &VoronoiSphere,
    is_ocean: &[bool],
    gyres: &[Gyre],
) -> Vec<[f32; 3]> {
    let n = sphere.n_fields() as usize;
    assert_eq!(is_ocean.len(), n, "is_ocean length must match n_fields");
    let mut out = vec![[0.0f32; 3]; n];
    if gyres.is_empty() {
        return out;
    }
    for i in 0..n {
        if !is_ocean[i] {
            continue;
        }
        let pos = sphere.position(i as u32);
        let mut sum = [0.0f32; 3];
        for g in gyres {
            let v = surface_current_at(pos, g);
            sum[0] += v[0];
            sum[1] += v[1];
            sum[2] += v[2];
        }
        out[i] = sum;
    }
    out
}

/// Simple advective smoothing: for each ocean cell, pull a small fraction of
/// temperature from its upstream neighbour each step.
///
/// Upstream neighbour = the neighbour whose offset direction best matches
/// `-currents[c]` (i.e. lies most in the direction the water is flowing FROM).
/// Cells with zero current are unchanged.
pub fn redistribute_temperature(
    temp_k: &mut [f32],
    currents: &[[f32; 3]],
    sphere: &VoronoiSphere,
    dt_steps: usize,
) {
    let n = sphere.n_fields() as usize;
    assert_eq!(temp_k.len(), n);
    assert_eq!(currents.len(), n);
    if dt_steps == 0 {
        return;
    }
    for _ in 0..dt_steps {
        let snapshot = temp_k.to_vec();
        for c in 0..n {
            let cur = currents[c];
            let mag2 = cur[0] * cur[0] + cur[1] * cur[1] + cur[2] * cur[2];
            if mag2 < 1e-12 {
                continue;
            }
            // -currents direction (upstream).
            let inv_mag = 1.0 / mag2.sqrt();
            let up = Vec3::new(-cur[0] * inv_mag, -cur[1] * inv_mag, -cur[2] * inv_mag);
            let pos_c = sphere.position(c as u32);
            let mut best: Option<(u32, f32)> = None;
            for &nb in sphere.neighbours(c as u32) {
                let pos_n = sphere.position(nb);
                let off = (pos_n - pos_c).normalize_or_zero();
                if off.length_squared() < 0.5 {
                    continue;
                }
                let score = off.dot(up);
                match best {
                    None => best = Some((nb, score)),
                    Some((_, s)) if score > s => best = Some((nb, score)),
                    _ => {}
                }
            }
            if let Some((nb, score)) = best {
                if score > 0.0 {
                    temp_k[c] = snapshot[c] * 0.9 + snapshot[nb as usize] * 0.1;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::climate::zonal::cell_latitude_rad;

    fn small_sphere() -> VoronoiSphere {
        VoronoiSphere::new(4)
    }

    #[test]
    fn all_land_world_yields_no_gyres_and_zero_currents() {
        let sphere = small_sphere();
        let n = sphere.n_fields() as usize;
        let is_ocean = vec![false; n];
        let basins = detect_ocean_basins(&sphere, &is_ocean);
        assert!(basins.is_empty(), "no ocean -> no basins");
        let gyres = place_gyres(&sphere, &basins);
        assert!(gyres.is_empty());
        let currents = compute_cell_currents(&sphere, &is_ocean, &gyres);
        assert_eq!(currents.len(), n);
        assert!(currents.iter().all(|v| v == &[0.0, 0.0, 0.0]));
    }

    #[test]
    fn single_ocean_world_detects_one_basin_and_one_gyre() {
        let sphere = small_sphere();
        let n = sphere.n_fields() as usize;
        let is_ocean = vec![true; n];
        let basins = detect_ocean_basins(&sphere, &is_ocean);
        assert_eq!(basins.len(), 1);
        assert_eq!(basins[0].len(), n);
        let gyres = place_gyres(&sphere, &basins);
        assert_eq!(gyres.len(), 1);
        let g = gyres[0];
        assert!(g.radius_rad > 0.0);
        assert!((g.strength - 1.0).abs() < 1e-5);
    }

    #[test]
    fn cell_currents_length_matches_sphere() {
        let sphere = small_sphere();
        let n = sphere.n_fields() as usize;
        let is_ocean: Vec<bool> = (0..n).map(|i| i % 2 == 0).collect();
        let basins = detect_ocean_basins(&sphere, &is_ocean);
        let gyres = place_gyres(&sphere, &basins);
        let currents = compute_cell_currents(&sphere, &is_ocean, &gyres);
        assert_eq!(currents.len(), n);
        for (i, v) in currents.iter().enumerate() {
            if !is_ocean[i] {
                assert_eq!(*v, [0.0, 0.0, 0.0], "land cell {} must have zero current", i);
            }
        }
    }

    #[test]
    fn two_basins_detected_when_land_separates_them() {
        // Force two ocean basins by partitioning cells along the equator:
        // northern hemisphere = ocean, equatorial band = land, southern = ocean.
        // Whether this yields exactly 2 components depends on the mesh, so
        // mark anything within ±15° lat as land and verify >= 2 basins.
        let sphere = small_sphere();
        let n = sphere.n_fields() as usize;
        let mut is_ocean = vec![true; n];
        for i in 0..n {
            let lat = cell_latitude_rad(sphere.position(i as u32));
            if lat.abs() < 0.30 {
                is_ocean[i] = false;
            }
        }
        let basins = detect_ocean_basins(&sphere, &is_ocean);
        assert!(basins.len() >= 2, "expected >=2 basins, got {}", basins.len());
        let gyres = place_gyres(&sphere, &basins);
        assert_eq!(gyres.len(), basins.len());
        // At least one northern (direction > 0) and one southern (< 0).
        let has_n = gyres.iter().any(|g| g.direction > 0.0);
        let has_s = gyres.iter().any(|g| g.direction < 0.0);
        assert!(has_n && has_s, "expected gyres in both hemispheres: {:?}", gyres);
    }

    #[test]
    fn current_is_zero_outside_radius_and_nonzero_inside() {
        let sphere = small_sphere();
        let g = Gyre {
            center_pos: Vec3::new(1.0, 0.0, 0.0),
            radius_rad: 0.5,
            direction: 1.0,
            strength: 1.0,
        };
        // Antipode -> zero.
        let antipode = surface_current_at(Vec3::new(-1.0, 0.0, 0.0), &g);
        assert_eq!(antipode, [0.0, 0.0, 0.0]);
        // Tilted just inside radius -> nonzero, surface-tangent.
        let inside = Vec3::new(1.0, 0.2, 0.0).normalize();
        let v = surface_current_at(inside, &g);
        let mag2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        assert!(mag2 > 0.0, "current inside should be nonzero, got {:?}", v);
        // Tangent to surface: v · inside ≈ 0.
        let dot = v[0] * inside.x + v[1] * inside.y + v[2] * inside.z;
        assert!(dot.abs() < 1e-4, "current should be tangent, dot={}", dot);
        let _ = sphere;
    }

    #[test]
    fn temperature_redistribution_runs_and_polar_warms_with_gyre() {
        let sphere = small_sphere();
        let n = sphere.n_fields() as usize;
        let is_ocean = vec![true; n];
        let basins = detect_ocean_basins(&sphere, &is_ocean);
        let gyres = place_gyres(&sphere, &basins);
        let currents = compute_cell_currents(&sphere, &is_ocean, &gyres);

        // Initial temperature: equatorial warm, polar cold (cosine band).
        let mut temp_with: Vec<f32> = (0..n)
            .map(|i| {
                let lat = cell_latitude_rad(sphere.position(i as u32)) as f32;
                273.0 + 30.0 * lat.cos()
            })
            .collect();
        let mut temp_no = temp_with.clone();
        let no_currents = vec![[0.0f32; 3]; n];

        redistribute_temperature(&mut temp_with, &currents, &sphere, 20);
        redistribute_temperature(&mut temp_no, &no_currents, &sphere, 20);

        // Mean polar temp (|lat| > 60°) should be warmer in the gyre case.
        let mut sum_with = 0.0f32;
        let mut sum_no = 0.0f32;
        let mut count = 0usize;
        for i in 0..n {
            let lat = cell_latitude_rad(sphere.position(i as u32));
            if lat.abs() > 1.05 {
                sum_with += temp_with[i];
                sum_no += temp_no[i];
                count += 1;
            }
        }
        assert!(count > 0, "small sphere should have some polar cells");
        let mean_with = sum_with / count as f32;
        let mean_no = sum_no / count as f32;
        assert!(
            mean_with > mean_no,
            "polar mean with currents {} should exceed without {}",
            mean_with,
            mean_no
        );
    }
}
