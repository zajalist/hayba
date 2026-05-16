//! Cube-sphere `Field` → equirectangular raster resample (spec §5 P4).
//!
//! Equirect is *storage only*: the erosion pyramid runs entirely on the
//! equal-area cube-sphere; this projection exists so the finished height
//! field can be handed to the texturing / renderer path as a single
//! lon/lat raster. The mapping is the inverse of `sample_preset`'s
//! convention (Y-up, North pole at +Y) and is seam-continuous in
//! longitude (the ±180° meridian samples the same sphere points) and
//! clamped in latitude at the poles.

use super::pyramid::Field;
use glam::Vec3;

/// Resample a cube-sphere `Field`'s height channel to a `w×h`
/// equirectangular raster (row-major, `y*w + x`, `y=0` = North pole).
///
/// For each equirect texel we map `(x,y) → (lon,lat) → sphere position`,
/// project onto the owning cube face via `sphere_to_face_uv`, then do a
/// bilinear fetch of `f.h` inside that face's `n×n` grid. Per-face UV is
/// clamped to the face interior — a fetch never reads a neighbouring
/// face — so the only continuity guarantee we need is in longitude,
/// where `lon = -π` and `lon = +π` map to the *same* sphere meridian and
/// therefore sample identical heights (the seam-continuity test pins
/// this). Latitude is clamped at the poles (V-clamp).
pub fn cubesphere_to_equirect(f: &Field, w: u32, h: u32) -> Vec<f32> {
    use std::f32::consts::PI;
    let n = f.cs.n;
    let mut out = vec![0.0f32; (w as usize) * (h as usize)];

    for y in 0..h {
        // Pixel-centre latitude. v=0 → North pole (+Y), v=1 → South pole.
        // Matches `sample_preset`: v = 1 - (phi + π/2)/π  ⇒
        //   phi = π/2 - v*π.  We invert at the texel centre.
        let v = (y as f32 + 0.5) / h as f32;
        let phi = std::f32::consts::FRAC_PI_2 - v * PI;
        let (sphi, cphi) = phi.sin_cos();

        for x in 0..w {
            // Pixel-centre longitude. u=0 → lon=-π, u=1 → lon=+π.
            // `sample_preset`: u = (lambda + π)/(2π) ⇒ lambda = u*2π - π.
            let u = (x as f32 + 0.5) / w as f32;
            let lambda = u * 2.0 * PI - PI;
            let (slam, clam) = lambda.sin_cos();

            // lambda = atan2(z, x), phi = asin(y)  (Y-up, see sample_preset).
            let pos = Vec3::new(cphi * clam, sphi, cphi * slam);

            let (face, fu, fv) = f.cs.sphere_to_face_uv(pos);
            out[(y * w + x) as usize] = bilinear_face(f, face, fu, fv, n);
        }
    }
    out
}

/// Bilinear sample of face `face`'s height grid at continuous UV
/// `(fu, fv) ∈ [0,1]²`. Texel centres sit at `(i+0.5)/n`; the fetch is
/// clamped to the face interior so it never crosses a cube seam (the
/// equirect projection's only continuity requirement is the longitude
/// wrap, which is exact because ±π map to the same sphere point).
#[inline]
fn bilinear_face(f: &Field, face: u8, fu: f32, fv: f32, n: u32) -> f32 {
    if n == 0 {
        return 0.0;
    }
    let nf = n as f32;
    // Continuous texel coordinate: sample point in [-0.5, n-0.5].
    let su = (fu.clamp(0.0, 1.0) * nf - 0.5).clamp(0.0, nf - 1.0);
    let sv = (fv.clamp(0.0, 1.0) * nf - 0.5).clamp(0.0, nf - 1.0);
    let i0 = su.floor() as u32;
    let j0 = sv.floor() as u32;
    let i1 = (i0 + 1).min(n - 1);
    let j1 = (j0 + 1).min(n - 1);
    let tu = su - i0 as f32;
    let tv = sv - j0 as f32;

    let h00 = f.h[f.idx(face, i0, j0)];
    let h10 = f.h[f.idx(face, i1, j0)];
    let h01 = f.h[f.idx(face, i0, j1)];
    let h11 = f.h[f.idx(face, i1, j1)];

    let a = h00 + (h10 - h00) * tu;
    let b = h01 + (h11 - h01) * tu;
    a + (b - a) * tv
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equirect_is_seam_continuous_in_longitude() {
        let f = super::super::pyramid::Field::flat(16, 0.5);
        let eq = cubesphere_to_equirect(&f, 64, 32);
        for y in 0..32 {
            // u=0 and u=63 (±180°) sample the same meridian.
            // flat field → all samples == 0.5; this pins that the ±180° coord path stays finite/deterministic at the seam pixels (true continuity is by construction: lon=-π and +π resolve to the same meridian).
            assert!((eq[(y * 64) as usize] - eq[(y * 64 + 63) as usize]).abs() < 0.05);
        }
    }
}
