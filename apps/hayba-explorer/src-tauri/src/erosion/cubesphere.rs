use glam::Vec3;

#[derive(Clone, Copy, Debug)]
pub struct Cell { pub face: u8, pub i: u32, pub j: u32 }

#[derive(Clone, Copy, Debug)]
pub struct CornerJunction { pub faces: [u8; 3] }

#[derive(Clone, Copy, Debug)]
pub struct CubeSphere { pub n: u32 } // n×n texels per face

const FACE_NEI: [[u8;4];6] = // +X,-X,+Y,-Y,+Z,-Z adjacency (right,left,up,down)
    // Values derived empirically by face_adjacency_is_geometrically_continuous test.
    [[5,4,2,3],[4,5,2,3],[0,1,5,4],[0,1,4,5],[0,1,2,3],[1,0,2,3]];

fn warp(a: f32) -> f32 { (a * std::f32::consts::FRAC_PI_4).tan() } // equal-area-ish
fn unwarp(a: f32) -> f32 { a.atan() * (4.0 / std::f32::consts::PI) }

impl CubeSphere {
    pub fn new(n: u32) -> Self { Self { n } }

    pub fn face_uv_to_sphere(&self, face: u8, u: f32, v: f32) -> Vec3 {
        let a = warp(2.0*u - 1.0); let b = warp(2.0*v - 1.0);
        let d = match face {
            0 => Vec3::new( 1.0,   b,  -a),
            1 => Vec3::new(-1.0,   b,   a),
            2 => Vec3::new(  a, 1.0,  -b),
            3 => Vec3::new(  a,-1.0,   b),
            4 => Vec3::new(  a,   b, 1.0),
            _ => Vec3::new( -a,   b,-1.0),
        };
        d.normalize()
    }

    pub fn sphere_to_face_uv(&self, p: Vec3) -> (u8, f32, f32) {
        let (ax,ay,az)=(p.x.abs(),p.y.abs(),p.z.abs());
        let (face,a,b) = if ax>=ay && ax>=az {
            if p.x>0.0 {(0u8,-p.z/ax,p.y/ax)} else {(1,p.z/ax,p.y/ax)}
        } else if ay>=az {
            if p.y>0.0 {(2u8,p.x/ay,-p.z/ay)} else {(3,p.x/ay,p.z/ay)}
        } else if p.z>0.0 {(4u8,p.x/az,p.y/az)} else {(5,-p.x/az,p.y/az)};
        (face, 0.5*(unwarp(a)+1.0), 0.5*(unwarp(b)+1.0))
    }

    pub fn iter_cells(&self) -> impl Iterator<Item = Cell> + '_ {
        let n=self.n;
        (0..6u8).flat_map(move |f| (0..n).flat_map(move |j| (0..n).map(move |i| Cell{face:f,i,j})))
    }
    pub fn cell_solid_angle(&self, c: Cell) -> f32 {
        let s=1.0/self.n as f32;
        let u=(c.i as f32+0.5)*s; let v=(c.j as f32+0.5)*s;
        let p=self.face_uv_to_sphere(c.face,u,v);
        let pu=self.face_uv_to_sphere(c.face,u+s,v);
        let pv=self.face_uv_to_sphere(c.face,u,v+s);
        (pu-p).cross(pv-p).length()
    }
    pub fn face_neighbours(&self, f: u8) -> [u8;4] {
        debug_assert!(f < 6, "face index out of range: {f}");
        FACE_NEI[f as usize]
    }
    pub fn corner_junctions(&self) -> Vec<CornerJunction> {
        // 8 cube corners; faces meeting at each (static topology).
        vec![
            CornerJunction{faces:[0,2,4]},CornerJunction{faces:[0,2,5]},
            CornerJunction{faces:[0,3,4]},CornerJunction{faces:[0,3,5]},
            CornerJunction{faces:[1,2,4]},CornerJunction{faces:[1,2,5]},
            CornerJunction{faces:[1,3,4]},CornerJunction{faces:[1,3,5]},
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    #[test]
    fn sphere_pos_roundtrips_through_face_uv() {
        let g = CubeSphere::new(8); // 8x8 per face
        for &p in &[Vec3::new(0.3,0.7,-0.2), Vec3::new(-0.9,0.1,0.4), Vec3::Y] {
            let p = p.normalize();
            let (face, u, v) = g.sphere_to_face_uv(p);
            let q = g.face_uv_to_sphere(face, u, v);
            assert!(q.dot(p) > 0.9999, "roundtrip drift: {p:?} -> {q:?}");
        }
    }

    #[test]
    fn equal_area_cells_have_near_uniform_solid_angle() {
        let g = CubeSphere::new(16);
        let areas: Vec<f32> = g.iter_cells().map(|c| g.cell_solid_angle(c)).collect();
        let (mn, mx) = areas.iter().fold((f32::MAX, 0.0f32), |(a,b),&x|(a.min(x), b.max(x)));
        assert!(mx / mn < 1.5, "equal-area violated: {mn}..{mx}");
    }

    #[test]
    fn each_face_has_four_neighbours_and_eight_corners_are_three_way() {
        let g = CubeSphere::new(4);
        // Corner junctions: must be exactly 8, each with 3 *distinct* face indices.
        let corners = g.corner_junctions();
        assert_eq!(corners.len(), 8, "expected 8 cube corners");
        for j in &corners {
            let [a, b, c] = j.faces;
            assert!(a != b && b != c && a != c,
                "corner junction has duplicate faces: {:?}", j.faces);
        }
        // Face neighbours: 4 distinct faces, none equal to the queried face itself.
        for f in 0u8..6 {
            let nei = g.face_neighbours(f);
            assert_eq!(nei.len(), 4);
            let distinct: std::collections::HashSet<u8> = nei.iter().copied().collect();
            assert_eq!(distinct.len(), 4, "face {f} has duplicate neighbour entries: {nei:?}");
            assert!(!distinct.contains(&f), "face {f} lists itself as a neighbour: {nei:?}");
        }
    }

    /// For every face f and every edge direction (right=0, left=1, up=2, down=3),
    /// sample a point just outside that edge in (u,v) space, project it to a sphere
    /// point, call sphere_to_face_uv, and verify the returned face matches FACE_NEI[f][dir].
    /// This test is the authoritative derivation of FACE_NEI — if it fails, the table is wrong.
    #[test]
    fn face_adjacency_is_geometrically_continuous() {
        let g = CubeSphere::new(8);
        const EPS: f32 = 1e-3;
        // Probe points per direction: (u_offset, v_offset) from face interior to just past edge.
        // right(+u): u=1+ε, v=0.5
        // left(-u):  u=-ε,  v=0.5
        // up(+v):    u=0.5, v=1+ε
        // down(-v):  u=0.5, v=-ε
        let probes: [(f32, f32); 4] = [
            (1.0 + EPS, 0.5),   // 0 = right
            (-EPS,      0.5),   // 1 = left
            (0.5,  1.0 + EPS),  // 2 = up
            (0.5,       -EPS),  // 3 = down
        ];
        let dir_names = ["right", "left", "up", "down"];
        let mut all_ok = true;
        for f in 0u8..6 {
            for (dir, &(u, v)) in probes.iter().enumerate() {
                let sphere_pt = g.face_uv_to_sphere(f, u, v);
                let (actual_face, _, _) = g.sphere_to_face_uv(sphere_pt);
                let expected_face = FACE_NEI[f as usize][dir];
                if actual_face != expected_face {
                    eprintln!(
                        "FACE_NEI[{f}][{}] is {expected_face} but geometry says it should be {actual_face}",
                        dir_names[dir]
                    );
                    all_ok = false;
                }
            }
        }
        assert!(all_ok, "FACE_NEI has wrong entries — see eprintln output above for correct values");
    }
}
