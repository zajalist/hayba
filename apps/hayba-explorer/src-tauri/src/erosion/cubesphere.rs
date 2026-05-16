use glam::Vec3;

#[derive(Clone, Copy, Debug)]
pub struct Cell { pub face: u8, pub i: u32, pub j: u32 }

pub struct CornerJunction { pub faces: [u8; 3] }

pub struct CubeSphere { pub n: u32 } // n×n texels per face

const FACE_NEI: [[u8;4];6] = // +X,-X,+Y,-Y,+Z,-Z adjacency (right,left,up,down)
    [[4,5,2,3],[5,4,2,3],[1,0,5,4],[1,0,4,5],[1,0,2,3],[0,1,2,3]];

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
    pub fn face_neighbours(&self, f: u8) -> [u8;4] { FACE_NEI[f as usize] }
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
        assert_eq!(g.face_neighbours(0).len(), 4);
        assert_eq!(g.corner_junctions().len(), 8);
        for j in g.corner_junctions() { assert_eq!(j.faces.len(), 3); }
    }
}
