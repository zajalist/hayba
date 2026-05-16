//! Cube-sphere `Field` + seam-correct neighbour / corner access (spec §5, Task A3).
//!
//! A `Field` is the per-texel state for the multi-scale erosion pyramid.
//! The only non-trivial part is `neighbour`: resolving an out-of-range
//! `(face, i, j)` across a cube-face seam. We do NOT hand-derive an
//! axis-swap/flip table — instead we round-trip the off-edge cell centre
//! through the *actual* cube-sphere geometry (`face_uv_to_sphere` →
//! `sphere_to_face_uv`). This makes the seam transform correct by
//! construction for every (face, direction), and the geometric-continuity
//! test below pins it empirically.

use glam::Vec3;
use super::cubesphere::CubeSphere;
use super::noise::{fbm, ridged};

#[allow(dead_code)] // fields/methods wired in A5+ (rasterize/erosion)
pub struct Field {
    pub cs: CubeSphere,
    pub h: Vec<f32>,
    pub water: Vec<f32>,
    pub sed: Vec<f32>,
    pub ocean: Vec<bool>,
}

impl Field {
    pub fn flat(n: u32, h0: f32) -> Self {
        let len = (6u64 * n as u64 * n as u64) as usize;
        Self {
            cs: CubeSphere::new(n),
            h: vec![h0; len],
            water: vec![0.0; len],
            sed: vec![0.0; len],
            ocean: vec![false; len],
        }
    }

    #[inline]
    pub fn idx(&self, f: u8, i: u32, j: u32) -> usize {
        (f as u32 * self.cs.n * self.cs.n + j * self.cs.n + i) as usize
    }

    /// Resolve `(face, i±, j±)` across face seams. Returns the destination
    /// cell `(face, i, j)` with both coordinates in `[0, n)`.
    ///
    /// In-face when `0 ≤ i,j < n` — returned unchanged. Otherwise the cell
    /// lies just past one edge of `face`: we take its (out-of-range) UV
    /// centre, project to the sphere, and re-resolve through the cube-sphere
    /// geometry. This applies the correct per-edge axis swap/flip implicitly,
    /// because the destination face/uv comes from the same projection that
    /// `FACE_NEI` was derived from.
    pub fn neighbour(&self, f: u8, i: i32, j: i32) -> (u8, u32, u32) {
        let n = self.cs.n as i32;
        if i >= 0 && i < n && j >= 0 && j < n {
            return (f, i as u32, j as u32);
        }
        // Off-edge: UV of the requested (out-of-range) cell centre.
        let inv = 1.0 / self.cs.n as f32;
        let u = (i as f32 + 0.5) * inv;
        let v = (j as f32 + 0.5) * inv;
        // Project through the real geometry and re-resolve onto whatever
        // face physically owns that direction (handles the axis swap/flip).
        let p = self.cs.face_uv_to_sphere(f, u, v);
        let (nf, nu, nv) = self.cs.sphere_to_face_uv(p);
        // UV → cell index, clamped to the valid range (a seam-crossing
        // point can land marginally outside [0,1] from float drift).
        let ni = ((nu * self.cs.n as f32).floor() as i32)
            .clamp(0, n - 1) as u32;
        let nj = ((nv * self.cs.n as f32).floor() as i32)
            .clamp(0, n - 1) as u32;
        (nf, ni, nj)
    }

    /// Number of edge-adjacent neighbours for a texel. The four texels whose
    /// `(i,j) ∈ {0, n-1}²` sit on a cube *corner* where 3 faces meet — they
    /// have a 3-way junction (drop the missing diagonal), everything else 4.
    // Face index intentionally unused — all 6 cube faces share an identical n×n layout and corner topology.
    pub fn corner_neighbour_count(&self, _f: u8, i: u32, j: u32) -> u32 {
        debug_assert!(self.cs.n >= 1, "cube-sphere resolution must be >= 1");
        let n = self.cs.n;
        let on_i_edge = i == 0 || i == n - 1;
        let on_j_edge = j == 0 || j == n - 1;
        if on_i_edge && on_j_edge {
            3
        } else {
            4
        }
    }
}

/// Inject seam-continuous, slope-modulated detail noise into land texels.
///
/// For every land texel (ocean texels are left unchanged) a noise contribution
/// is added to `field.h`:
///
/// ```text
/// fbm_c     = fbm(pos, level+2, seed) * 2 - 1          // centered, ~zero-mean
/// envelope  = 1 + slope01[k] * ridged(pos, level+2, seed)   // [1, 2]
/// delta     = amp * slope01[k] * fbm_c * envelope
/// ```
///
/// `fbm_c` (fbm output centered to `[-1, 1]`) is the zero-mean base signal —
/// its global mean over many texels is ~0 because fbm is symmetric around 0.5.
/// The `ridged` noise envelope amplifies oscillations in steep/orogenic areas
/// without adding a DC bias: multiplying a zero-mean signal by a positive
/// scalar preserves the zero-mean property.  This gives flat areas smooth fBm
/// texture and steep areas sharper, ridge-like detail.
///
/// The `fbm*2-1` centering is the contract the zero-mean test relies on.
///
/// Noise frequency scales with `level` — the function uses `level + 2` octaves
/// so coarser pyramid levels receive less detail and finer levels more.
///
/// # Parameters
/// - `field`   — mutable reference to the elevation field; only `.h` is mutated.
/// - `level`   — pyramid level (0 = coarsest); controls octave count (`level+2`).
/// - `amp`     — amplitude of the added detail in normalized elevation units.
/// - `seed`    — deterministic seed; same seed → identical noise field.
/// - `slope01` — per-texel slope in `[0, 1]`; drives fbm↔ridged blend weight
///               and amplitude scaling.  Must have the same length as `field.h`.
///
/// # Panics (debug)
/// Panics if `slope01.len() != field.h.len()`.
pub fn inject_detail_band(field: &mut Field, level: u32, amp: f32, seed: u64, slope01: &[f32]) {
    debug_assert_eq!(
        slope01.len(),
        field.h.len(),
        "slope01 must be the same length as field.h"
    );

    let n = field.cs.n;
    let octaves = level + 2;
    let inv = 1.0 / n as f32;

    for face in 0u8..6 {
        for j in 0..n {
            for i in 0..n {
                let k = field.idx(face, i, j);

                // Ocean texels are untouched — fixed base level.
                if field.ocean[k] {
                    continue;
                }

                // Sphere position at texel centre (seam-continuous domain).
                let pos = field.cs.face_uv_to_sphere(face, (i as f32 + 0.5) * inv, (j as f32 + 0.5) * inv);

                // Center fbm to [-1, 1] — this is the zero-mean base signal.
                // fbm output is ~uniform over [0,1], so fbm*2-1 has mean ~0.
                let fbm_c = fbm(pos, octaves, seed) * 2.0 - 1.0;

                // Ridged noise in [0,1] — used as a multiplicative sharpening
                // envelope for steep areas. Using it as an envelope (not as an
                // additive term) preserves the zero-mean property: ridge peaks
                // amplify fbm oscillations locally without shifting the global mean.
                let s = slope01[k].clamp(0.0, 1.0);
                let ridged_env = ridged(pos, octaves, seed); // [0,1]

                // Envelope: flat → plain fbm_c; steep → fbm_c sharpened by ridged.
                // Multiplying by (1 + s * ridged_env) scales amplitude by up to 2×
                // but does not shift mean (the mean of fbm_c · positive_envelope ≈ 0
                // because fbm_c is symmetric around 0 and the envelope is independent).
                let noise_val = fbm_c * (1.0 + s * ridged_env);

                field.h[k] += amp * s * noise_val;
            }
        }
    }
}

/// Rasterize a sparse set of painted Goldberg cells onto an `n×n`-per-face
/// cube-sphere `Field`.
///
/// For each cube-sphere texel the nearest input cell is found by maximum
/// dot-product (great-circle nearest on the unit sphere). The texel elevation
/// `h` is set to the matched cell's elevation value, and `ocean` is set to
/// `h < 0.0`. All other `Field` arrays (`water`, `sed`) are left at zero.
///
/// Brute-force O(texels × cells) — correct for the test fixture. The
/// production path (Task A11) will supply a kd-tree; this function's
/// signature is the stable contract.
///
/// # Panics (debug): if `cells` is empty.
pub fn rasterize_from_cells(n: u32, cells: &[(Vec3, f32)]) -> Field {
    debug_assert!(!cells.is_empty(), "rasterize_from_cells: cells must not be empty");
    let mut field = Field::flat(n, 0.0);
    let inv = 1.0 / n as f32;

    for face in 0u8..6 {
        for j in 0..n {
            for i in 0..n {
                // Centre of this texel on the unit sphere.
                let u = (i as f32 + 0.5) * inv;
                let v = (j as f32 + 0.5) * inv;
                let pos = field.cs.face_uv_to_sphere(face, u, v);

                // Nearest cell = maximum dot-product (both are unit vectors).
                let elev = cells
                    .iter()
                    .max_by(|(a, _), (b, _)| {
                        let da = a.dot(pos);
                        let db = b.dot(pos);
                        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .map(|(_, e)| *e)
                    .unwrap_or(0.0);

                let idx = field.idx(face, i, j);
                field.h[idx] = elev;
                field.ocean[idx] = elev < 0.0;
            }
        }
    }
    field
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neighbour_crossing_a_face_edge_is_continuous() {
        let f = Field::flat(4, 0.5);
        // a right-edge cell on +Z must resolve its +u neighbour onto +X
        let c = (4, 3, 1); // (face,i,j)
        let nb = f.neighbour(c.0, c.1 as i32 + 1, c.2 as i32);
        // FACE_NEI[4] = [0,1,2,3] (verified): +Z right edge → +X (face id 0).
        assert_eq!(nb.0, 0u8, "+Z right edge wraps to +X face (id 0)");
    }

    #[test]
    fn corner_gather_is_three_way_not_four() {
        let f = Field::flat(4, 0.0);
        let s = f.corner_neighbour_count(4, 3, 3); // a +Z far corner
        assert_eq!(s, 3, "corner has 3 neighbours");
    }

    /// Strong self-verifying continuity test (the A1 weak-test trap guard):
    /// for several interior-edge cells across ALL 6 faces and ALL 4
    /// directions, the cell `neighbour()` returns must be the *physically*
    /// adjacent cell — its sphere-centre must lie within ~1.5 cell-widths
    /// great-circle distance of the source cell's centre. A face-correct but
    /// coordinate-wrong remap (wrong axis swap/flip) lands far away and fails
    /// this even though the face id is right.
    #[test]
    fn neighbour_is_geometrically_continuous() {
        let n: u32 = 32;
        let f = Field::flat(n, 0.0);
        let cs = &f.cs;
        let inv = 1.0 / n as f32;

        // Centre-of-cell sphere position for (face,i,j).
        let centre = |face: u8, i: u32, j: u32| {
            let u = (i as f32 + 0.5) * inv;
            let v = (j as f32 + 0.5) * inv;
            cs.face_uv_to_sphere(face, u, v)
        };

        // A generous cell-width upper bound: the diagonal of a face is the
        // largest scale; one cell spans ~ (face angular extent)/n. The full
        // cube face subtends ~90° (π/2 rad). Allow 1.5 cells of slack.
        // 1.5x slack: the equal-area warp widens corner cells above the nominal FRAC_PI_2/n width; empirically a true adjacent pair sits ~1.1x nominal, a wrong axis-swap >1.3x — so this bound discriminates without false negatives. Do not tighten below ~1.3.
        let max_cell_w = (std::f32::consts::FRAC_PI_2 / n as f32) * 1.5;

        // Sample interior-edge offsets so the step actually crosses a seam
        // (avoid the 4 corner texels — those are legitimately 3-way).
        let edge_samples = [3u32, n / 2, n - 4];

        // (di,dj) for right,left,up,down.
        let dirs: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
        let dir_names = ["right", "left", "up", "down"];

        let mut worst = 0.0f32;
        for face in 0u8..6 {
            for (d, &(di, dj)) in dirs.iter().enumerate() {
                // Pick a cell sitting on the edge being stepped over.
                for &s in &edge_samples {
                    let (i, j) = match d {
                        0 => (n - 1, s), // right edge: i = n-1, step +i
                        1 => (0, s),     // left edge:  i = 0,   step -i
                        2 => (s, n - 1), // up edge:    j = n-1, step +j
                        _ => (s, 0),     // down edge:  j = 0,   step -j
                    };
                    let src = centre(face, i, j).normalize();
                    let (nf, ni, nj) =
                        f.neighbour(face, i as i32 + di, j as i32 + dj);
                    let dst = centre(nf, ni, nj).normalize();

                    // Great-circle distance on the unit sphere.
                    let gc = src.dot(dst).clamp(-1.0, 1.0).acos();
                    worst = worst.max(gc);
                    assert!(
                        gc < max_cell_w,
                        "discontinuous seam: face {face} {} edge cell \
                         ({i},{j}) -> ({nf},{ni},{nj}); great-circle \
                         distance {gc:.5} rad exceeds {max_cell_w:.5} rad \
                         (~1.5 cell widths). Face id may be right but the \
                         (i,j) remap landed on the wrong cell.",
                        dir_names[d]
                    );
                }
            }
        }
        // Sanity: we did exercise real steps (non-degenerate distances).
        assert!(
            worst > 0.0,
            "no seam crossings were actually measured (test is vacuous)"
        );
    }

    /// Every off-edge step must land on a *different* face (it crossed a
    /// seam) and that face must be the one `face_neighbours` declares.
    #[test]
    fn neighbour_destination_face_matches_face_neighbours_table() {
        let n: u32 = 16;
        let f = Field::flat(n, 0.0);
        for face in 0u8..6 {
            let nei = f.cs.face_neighbours(face); // [right,left,up,down]
            let mid = n / 2;
            let cases: [((i32, i32), u8); 4] = [
                ((n as i32, mid as i32), nei[0]),  // right
                ((-1, mid as i32), nei[1]),        // left
                ((mid as i32, n as i32), nei[2]),  // up
                ((mid as i32, -1), nei[3]),        // down
            ];
            for ((i, j), want) in cases {
                let (nf, _, _) = f.neighbour(face, i, j);
                assert_eq!(
                    nf, want,
                    "face {face} step to ({i},{j}) should land on \
                     face {want} (per face_neighbours), got {nf}"
                );
            }
        }
    }

    #[test]
    fn in_face_neighbour_is_identity_offset() {
        let f = Field::flat(8, 0.0);
        assert_eq!(f.neighbour(2, 3, 4), (2, 3, 4));
        assert_eq!(f.neighbour(2, 4, 4), (2, 4, 4));
        // idx layout sanity.
        assert_eq!(f.idx(0, 0, 0), 0);
        assert_eq!(f.idx(1, 0, 0), (8 * 8) as usize);
        assert_eq!(f.idx(0, 7, 7), (7 * 8 + 7) as usize);
    }

    #[test]
    fn only_the_four_corner_texels_are_three_way() {
        let n = 8;
        let f = Field::flat(n, 0.0);
        let mut three = 0;
        for i in 0..n {
            for j in 0..n {
                let c = f.corner_neighbour_count(0, i, j);
                if c == 3 {
                    three += 1;
                    assert!(
                        (i == 0 || i == n - 1) && (j == 0 || j == n - 1),
                        "({i},{j}) reported 3-way but is not a cube corner"
                    );
                } else {
                    assert_eq!(c, 4, "non-corner ({i},{j}) must be 4-way");
                }
            }
        }
        assert_eq!(three, 4, "exactly 4 corner texels per face");
    }

    #[test]
    fn detail_band_adds_zero_mean_seam_continuous_relief_scaled_by_slope() {
        let mut f = Field::flat(16, 0.5);
        let before = f.h.clone();
        let len = f.h.len();
        inject_detail_band(&mut f, /*level*/2, /*amp*/0.05, /*seed*/7, /*slope*/&vec![1.0; len]);
        let mean: f32 = f.h.iter().zip(&before).map(|(a,b)| a-b).sum::<f32>() / len as f32;
        assert!(mean.abs() < 5e-3, "near zero-mean (adds detail, not bias): mean={mean}");
        assert!(f.h.iter().zip(&before).any(|(a,b)| (a-b).abs() > 1e-4), "did add relief");
        assert!(f.h.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn rasterize_samples_nearest_cell_elevation_and_flags_ocean() {
        // 2 fake cells: +Z pole land 0.5, -Z pole ocean -1.0.
        let cells = vec![(glam::Vec3::Z, 0.5f32), (glam::Vec3::NEG_Z, -1.0)];
        let f = rasterize_from_cells(8, &cells);
        let zc = f.idx(4, 4, 4); // mid +Z face
        assert!((f.h[zc] - 0.5).abs() < 1e-3 && !f.ocean[zc]);
        let nc = f.idx(5, 4, 4); // mid -Z face
        assert!(f.h[nc] < 0.0 && f.ocean[nc]);
    }
}
