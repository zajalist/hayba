//! Deterministic sphere-domain noise for erosion (spec §5.4).
//!
//! All functions take a 3D world-space position on the unit sphere plus an
//! explicit `seed: u64` so every call is fully deterministic and seam-free:
//! the domain is 3D world position (continuous everywhere on the sphere),
//! so no per-face UV discontinuities can arise.

use glam::Vec3;

// ---------------------------------------------------------------------------
// Internal hash / gradient helpers
// ---------------------------------------------------------------------------

/// 3D lattice hash → pseudo-random u32.
///
/// Uses the Murmur3-inspired finalizer; the seed is mixed in before hashing
/// so distinct seeds produce statistically independent noise fields.
#[inline(always)]
fn hash3(ix: i32, iy: i32, iz: i32, seed: u64) -> u32 {
    // Pack coordinates and seed into a 64-bit word, then apply fast mixing.
    let mut h = seed
        .wrapping_add((ix as u64).wrapping_mul(0x9E3779B97F4A7C15))
        .wrapping_add((iy as u64).wrapping_mul(0x6C62272E07BB0142))
        .wrapping_add((iz as u64).wrapping_mul(0x94D049BB133111EB));
    // Finalizer (similar to splitmix64 steps)
    h ^= h >> 30;
    h = h.wrapping_mul(0xBF58476D1CE4E5B9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94D049BB133111EB);
    h ^= h >> 31;
    (h ^ (h >> 32)) as u32
}

/// Map a hash to a gradient vector in {-1,0,+1}^3 \ {0} (12 directions from a cube).
#[inline(always)]
fn grad(h: u32) -> Vec3 {
    // 12 gradient directions (cube edges midpoints), indexed by h % 12
    const GRADS: [(f32, f32, f32); 12] = [
        (1.0, 1.0, 0.0),
        (-1.0, 1.0, 0.0),
        (1.0, -1.0, 0.0),
        (-1.0, -1.0, 0.0),
        (1.0, 0.0, 1.0),
        (-1.0, 0.0, 1.0),
        (1.0, 0.0, -1.0),
        (-1.0, 0.0, -1.0),
        (0.0, 1.0, 1.0),
        (0.0, -1.0, 1.0),
        (0.0, 1.0, -1.0),
        (0.0, -1.0, -1.0),
    ];
    let g = GRADS[(h % 12) as usize];
    Vec3::new(g.0, g.1, g.2)
}

/// Quintic smoothstep — C2-continuous, removes lattice discontinuities.
#[inline(always)]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

// ---------------------------------------------------------------------------
// 3D gradient (Perlin-style) noise on an integer lattice.
//
// Returns a value in approximately [-1, 1] (not exactly; typical range ~[-0.7,0.7]).
// The seed is mixed into every lattice-point hash so distinct seeds are independent.
// ---------------------------------------------------------------------------

fn gradient_noise_raw(pos: Vec3, seed: u64) -> f32 {
    let fx = pos.x.floor() as i32;
    let fy = pos.y.floor() as i32;
    let fz = pos.z.floor() as i32;

    // Fractional part
    let dx = pos.x - fx as f32;
    let dy = pos.y - fy as f32;
    let dz = pos.z - fz as f32;

    // Quintic fade for C2 continuity
    let u = fade(dx);
    let v = fade(dy);
    let w = fade(dz);

    // Contributions from the 8 lattice corners
    let g000 = grad(hash3(fx, fy, fz, seed)).dot(Vec3::new(dx, dy, dz));
    let g100 = grad(hash3(fx + 1, fy, fz, seed)).dot(Vec3::new(dx - 1.0, dy, dz));
    let g010 = grad(hash3(fx, fy + 1, fz, seed)).dot(Vec3::new(dx, dy - 1.0, dz));
    let g110 = grad(hash3(fx + 1, fy + 1, fz, seed)).dot(Vec3::new(dx - 1.0, dy - 1.0, dz));
    let g001 = grad(hash3(fx, fy, fz + 1, seed)).dot(Vec3::new(dx, dy, dz - 1.0));
    let g101 = grad(hash3(fx + 1, fy, fz + 1, seed)).dot(Vec3::new(dx - 1.0, dy, dz - 1.0));
    let g011 = grad(hash3(fx, fy + 1, fz + 1, seed)).dot(Vec3::new(dx, dy - 1.0, dz - 1.0));
    let g111 = grad(hash3(fx + 1, fy + 1, fz + 1, seed))
        .dot(Vec3::new(dx - 1.0, dy - 1.0, dz - 1.0));

    // Trilinear interpolation
    let x00 = lerp(g000, g100, u);
    let x10 = lerp(g010, g110, u);
    let x01 = lerp(g001, g101, u);
    let x11 = lerp(g011, g111, u);
    let y0 = lerp(x00, x10, v);
    let y1 = lerp(x01, x11, v);
    lerp(y0, y1, w)
}

#[inline(always)]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + t * (b - a)
}

// ---------------------------------------------------------------------------
// Scale factor for normalising raw gradient noise.
//
// Gradient noise with the 12-direction gradient set peaks at ~0.707 in theory;
// empirically with this hash the raw range is roughly [-0.7, 0.7].
// We scale so that a single octave spans approximately [-1, 1].
// ---------------------------------------------------------------------------
const NOISE_SCALE: f32 = 1.0 / 0.7;

/// Single-octave value in [-1, 1] (approximately).
#[inline(always)]
fn noise1(pos: Vec3, seed: u64) -> f32 {
    (gradient_noise_raw(pos, seed) * NOISE_SCALE).clamp(-1.0, 1.0)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Fractal Brownian Motion — multi-octave layered noise.
///
/// Returns a value in `[0, 1]`.  Same `(pos, octaves, seed)` → identical `f32`.
pub fn fbm(pos: Vec3, octaves: u32, seed: u64) -> f32 {
    if octaves == 0 { return 0.5; }
    let mut value = 0.0f32;
    let mut amplitude = 0.5f32;
    let mut frequency = 1.0f32;
    let mut max_value = 0.0f32;

    for i in 0..octaves {
        // Each octave uses a seed derived from the master seed and the octave index
        // so octaves are independent (different seeds → different gradient tables).
        let oct_seed = seed.wrapping_add((i as u64).wrapping_mul(0x9E3779B97F4A7C15));
        value += amplitude * noise1(pos * frequency, oct_seed);
        max_value += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    // Remap from ~[-max_value, max_value] to [0, 1]
    ((value / max_value) * 0.5 + 0.5).clamp(0.0, 1.0)
}

/// Ridged multifractal noise — folded so ridges appear as bright lines.
///
/// Returns a value in `[0, 1]`.
pub fn ridged(pos: Vec3, octaves: u32, seed: u64) -> f32 {
    let mut value = 0.0f32;
    let mut amplitude = 0.5f32;
    let mut frequency = 1.0f32;
    let mut max_value = 0.0f32;
    let mut weight = 1.0f32;

    for i in 0..octaves {
        let oct_seed = seed
            .wrapping_add(0xDEAD_BEEF_CAFE_0000)
            .wrapping_add((i as u64).wrapping_mul(0x6C62272E07BB0142));
        let n = noise1(pos * frequency, oct_seed);
        // Fold: 1 - |n| gives ridges at sign changes; weight previous ridge sharpness
        let signal = (1.0 - n.abs()) * weight;
        value += signal * amplitude;
        max_value += amplitude;
        // Weight next octave by squared signal (sharpens ridges)
        weight = (signal * 2.0).clamp(0.0, 1.0).powi(2);
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    if max_value > 0.0 {
        (value / max_value).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Worley (cellular / F1) noise — distance to nearest feature point.
///
/// Returns a value in `[0, 1]`.  Feature points are seeded deterministically
/// via `seed`.
pub fn worley(pos: Vec3, seed: u64) -> f32 {
    // Work in a scaled space where lattice cells have density ~1 feature/cell.
    // We search a 3×3×3 neighbourhood of cells.
    let scale = 1.0f32;
    let sp = pos * scale;

    let fx = sp.x.floor() as i32;
    let fy = sp.y.floor() as i32;
    let fz = sp.z.floor() as i32;

    let mut min_dist_sq = f32::MAX;

    for dz in -1i32..=1 {
        for dy in -1i32..=1 {
            for dx in -1i32..=1 {
                let cx = fx + dx;
                let cy = fy + dy;
                let cz = fz + dz;

                // Generate 1–2 feature points per cell using hash-based jitter.
                // We use 1 point per cell for speed; sufficient for smoothly varying F1.
                let h0 = hash3(cx, cy, cz, seed);
                let h1 = hash3(cx, cy, cz, seed.wrapping_add(0x1234_5678_9ABC_DEF0));
                let h2 = hash3(cx, cy, cz, seed.wrapping_add(0xFEDC_BA98_7654_3210));

                // Feature point in [0,1)^3 within the lattice cell
                let jx = (h0 & 0xFFFF) as f32 / 65535.0;
                let jy = (h1 & 0xFFFF) as f32 / 65535.0;
                let jz = (h2 & 0xFFFF) as f32 / 65535.0;

                let fp = Vec3::new(cx as f32 + jx, cy as f32 + jy, cz as f32 + jz);
                let d2 = (sp - fp).length_squared();
                if d2 < min_dist_sq {
                    min_dist_sq = d2;
                }
            }
        }
    }

    // Max possible F1 distance in a 3x3x3 search with full [0,1) per-cell jitter
    // approaches sqrt(3) ≈ 1.732 (unit-cell space diagonal). Normalizing by this
    // keeps output in [0,1]; the clamp below handles any overshoot.
    let max_dist = 3.0f32.sqrt();
    (min_dist_sq.sqrt() / max_dist).clamp(0.0, 1.0)
}

/// Domain-warped position: `pos + small fbm-driven offset vector`.
///
/// Returns a `Vec3` displaced by a seed-derived fbm field.  Used to
/// introduce non-repeating, organic warp into erosion patterns.
pub fn domain_warp(pos: Vec3, seed: u64) -> Vec3 {
    // Three independent fbm evaluations for x/y/z offset components.
    let seed_x = seed.wrapping_add(0x1111_1111_1111_1111);
    let seed_y = seed.wrapping_add(0x2222_2222_2222_2222);
    let seed_z = seed.wrapping_add(0x3333_3333_3333_3333);

    let warp_strength = 0.25f32;
    let wx = (fbm(pos, 3, seed_x) * 2.0 - 1.0) * warp_strength;
    let wy = (fbm(pos, 3, seed_y) * 2.0 - 1.0) * warp_strength;
    let wz = (fbm(pos, 3, seed_z) * 2.0 - 1.0) * warp_strength;

    pos + Vec3::new(wx, wy, wz)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    #[test]
    fn fbm_is_deterministic_and_seam_continuous() {
        let a = fbm(Vec3::new(0.3, 0.4, 0.5).normalize(), 5, 7);
        let b = fbm(Vec3::new(0.3, 0.4, 0.5).normalize(), 5, 7);
        assert_eq!(a, b, "same pos+seed → same value (determinism)");
        // continuity: tiny position delta → tiny value delta (no seam jump)
        let p = Vec3::new(1.0, 1e-4, 0.0).normalize();
        let q = Vec3::new(1.0, -1e-4, 0.0).normalize();
        assert!(
            (fbm(p, 5, 7) - fbm(q, 5, 7)).abs() < 0.05,
            "seam continuity violated: delta = {}",
            (fbm(p, 5, 7) - fbm(q, 5, 7)).abs()
        );
    }

    #[test]
    fn ridged_and_worley_in_range() {
        let p = Vec3::X;
        assert!(
            (0.0..=1.0).contains(&ridged(p, 4, 1)),
            "ridged out of [0,1]: {}",
            ridged(p, 4, 1)
        );
        assert!(
            (0.0..=1.0).contains(&worley(p, 1)),
            "worley out of [0,1]: {}",
            worley(p, 1)
        );
    }
}
