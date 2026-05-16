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

use super::cubesphere::CubeSphere;

pub struct Field {
    pub cs: CubeSphere,
    pub h: Vec<f32>,
    pub water: Vec<f32>,
    pub sed: Vec<f32>,
    pub ocean: Vec<bool>,
}

impl Field {
    pub fn flat(n: u32, h0: f32) -> Self {
        let len = (6 * n * n) as usize;
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
    pub fn corner_neighbour_count(&self, _f: u8, i: u32, j: u32) -> u32 {
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
}
