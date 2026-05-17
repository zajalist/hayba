//! Icosphere — recursively subdivided icosahedron projected onto the unit sphere.
//!
//! Subdivision count guide:
//!   level 0 →     12 vertices /     20 faces (raw icosahedron)
//!   level 1 →     42 vertices /     80 faces
//!   level 2 →    162 vertices /    320 faces
//!   level 3 →    642 vertices /  1,280 faces
//!   level 4 →  2,562 vertices /  5,120 faces
//!   level 5 → 10,242 vertices / 20,480 faces
//!   level 6 → 40,962 vertices / 81,920 faces
//!
//! Pro-grade target (~250k cells) lands around level 7-8.

use std::collections::HashMap;

#[derive(Copy, Clone, Debug, Default, PartialEq)]
pub struct Vec3f { pub x: f64, pub y: f64, pub z: f64 }

impl Vec3f {
    pub fn new(x: f64, y: f64, z: f64) -> Self { Self { x, y, z } }

    pub fn normalize(self) -> Self {
        let len = (self.x * self.x + self.y * self.y + self.z * self.z).sqrt();
        Self::new(self.x / len, self.y / len, self.z / len)
    }

    pub fn midpoint(self, other: Self) -> Self {
        Self::new(
            (self.x + other.x) * 0.5,
            (self.y + other.y) * 0.5,
            (self.z + other.z) * 0.5,
        )
    }

    pub fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    pub fn sub(self, other: Self) -> Self {
        Self::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }

    pub fn cross(self, other: Self) -> Self {
        Self::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }

    pub fn scale(self, s: f64) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }

    pub fn length(self) -> f64 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }

    /// Normalize to unit length; if length is below 1e-12 (numerically
    /// degenerate), return `fallback` instead. Useful in spherical geometry
    /// where antipodal or coincident inputs can produce zero-length results.
    pub fn normalize_or(self, fallback: Self) -> Self {
        let len = self.length();
        if len < 1e-12 { fallback } else {
            Self::new(self.x / len, self.y / len, self.z / len)
        }
    }
}

#[derive(Debug)]
pub struct Icosphere {
    pub vertices: Vec<Vec3f>,
    pub triangles: Vec<[u32; 3]>,
}

impl Icosphere {
    pub fn new(subdivisions: u32) -> Self {
        Self::new_rotated(subdivisions, 0.0, 0.0, 0.0)
    }

    /// Build the icosphere and rotate it by Euler angles `(rx, ry, rz)` in
    /// radians. Used to break the "always same hex pattern" feel across
    /// different seed worlds — each seed picks a random rotation, so the
    /// underlying mesh symmetry doesn't dominate the visual character.
    pub fn new_rotated(subdivisions: u32, rx: f64, ry: f64, rz: f64) -> Self {
        let (mut vertices, mut triangles) = icosahedron();

        for _ in 0..subdivisions {
            let mut midpoint_cache: HashMap<(u32, u32), u32> = HashMap::new();
            let mut new_triangles = Vec::with_capacity(triangles.len() * 4);

            let mut get_midpoint = |a: u32, b: u32, verts: &mut Vec<Vec3f>| -> u32 {
                let key = if a < b { (a, b) } else { (b, a) };
                if let Some(&i) = midpoint_cache.get(&key) { return i; }
                let m = verts[a as usize].midpoint(verts[b as usize]).normalize();
                let idx = verts.len() as u32;
                verts.push(m);
                midpoint_cache.insert(key, idx);
                idx
            };

            for tri in &triangles {
                let [a, b, c] = *tri;
                let ab = get_midpoint(a, b, &mut vertices);
                let bc = get_midpoint(b, c, &mut vertices);
                let ca = get_midpoint(c, a, &mut vertices);
                new_triangles.push([a, ab, ca]);
                new_triangles.push([b, bc, ab]);
                new_triangles.push([c, ca, bc]);
                new_triangles.push([ab, bc, ca]);
            }
            triangles = new_triangles;
        }

        // Apply Euler-angle rotation. Standard ZYX intrinsic.
        if rx != 0.0 || ry != 0.0 || rz != 0.0 {
            let (cx, sx) = (rx.cos(), rx.sin());
            let (cy, sy) = (ry.cos(), ry.sin());
            let (cz, sz) = (rz.cos(), rz.sin());
            for v in vertices.iter_mut() {
                // Rx
                let (y, z) = (v.y, v.z);
                v.y = y * cx - z * sx;
                v.z = y * sx + z * cx;
                // Ry
                let (x, z) = (v.x, v.z);
                v.x = x * cy + z * sy;
                v.z = -x * sy + z * cy;
                // Rz
                let (x, y) = (v.x, v.y);
                v.x = x * cz - y * sz;
                v.y = x * sz + y * cz;
            }
        }

        Self { vertices, triangles }
    }
}

/// Base icosahedron — 12 vertices, 20 faces. Vertices already on the unit sphere.
fn icosahedron() -> (Vec<Vec3f>, Vec<[u32; 3]>) {
    // Golden ratio. Constructing icosahedron from three orthogonal golden rectangles.
    let t = (1.0 + 5.0_f64.sqrt()) / 2.0;
    let verts_unnorm = [
        (-1.0,  t,  0.0), ( 1.0,  t,  0.0), (-1.0, -t,  0.0), ( 1.0, -t,  0.0),
        ( 0.0, -1.0,  t), ( 0.0,  1.0,  t), ( 0.0, -1.0, -t), ( 0.0,  1.0, -t),
        (  t,  0.0, -1.0), (  t,  0.0,  1.0), ( -t,  0.0, -1.0), ( -t,  0.0,  1.0),
    ];
    let vertices: Vec<Vec3f> = verts_unnorm.iter()
        .map(|&(x, y, z)| Vec3f::new(x, y, z).normalize())
        .collect();

    let triangles = vec![
        [0, 11,  5], [0,  5,  1], [0,  1,  7], [0,  7, 10], [0, 10, 11],
        [1,  5,  9], [5, 11,  4], [11, 10,  2], [10,  7,  6], [7,  1,  8],
        [3,  9,  4], [3,  4,  2], [3,  2,  6], [3,  6,  8], [3,  8,  9],
        [4,  9,  5], [2,  4, 11], [6,  2, 10], [8,  6,  7], [9,  8,  1],
    ];

    (vertices, triangles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_0_is_raw_icosahedron() {
        let s = Icosphere::new(0);
        assert_eq!(s.vertices.len(), 12);
        assert_eq!(s.triangles.len(), 20);
    }

    #[test]
    fn subdivision_grows_4x_faces() {
        let a = Icosphere::new(0);
        let b = Icosphere::new(1);
        assert_eq!(b.triangles.len(), a.triangles.len() * 4);
    }

    #[test]
    fn all_vertices_on_unit_sphere() {
        let s = Icosphere::new(4);
        for v in &s.vertices {
            let r = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
            assert!((r - 1.0).abs() < 1e-9, "vertex off sphere: r={}", r);
        }
    }
}
