//! Vertex adjacency on the icosphere — needed for Lloyd relaxation, junction
//! detection, and boundary extraction.

use crate::mesh::Icosphere;

/// CSR-style neighbor list: `neighbors[ranges[i]..ranges[i+1]]` are the
/// vertices adjacent to vertex `i`.
pub struct Adjacency {
    pub ranges: Vec<u32>,
    pub neighbors: Vec<u32>,
}

impl Adjacency {
    pub fn build(sphere: &Icosphere) -> Self {
        let n = sphere.vertices.len();
        let mut neighbor_sets: Vec<Vec<u32>> = vec![Vec::new(); n];

        for tri in &sphere.triangles {
            for k in 0..3 {
                let a = tri[k];
                let b = tri[(k + 1) % 3];
                if !neighbor_sets[a as usize].contains(&b) {
                    neighbor_sets[a as usize].push(b);
                }
                if !neighbor_sets[b as usize].contains(&a) {
                    neighbor_sets[b as usize].push(a);
                }
            }
        }

        // Flatten to CSR for cache-friendly iteration.
        let mut ranges = Vec::with_capacity(n + 1);
        ranges.push(0u32);
        let mut neighbors = Vec::with_capacity(n * 6);
        for set in &neighbor_sets {
            // Sort for deterministic iteration order — critical for the
            // determinism contract.
            let mut sorted = set.clone();
            sorted.sort_unstable();
            neighbors.extend(sorted);
            ranges.push(neighbors.len() as u32);
        }

        Self { ranges, neighbors }
    }

    #[inline]
    pub fn of(&self, vertex: u32) -> &[u32] {
        let start = self.ranges[vertex as usize] as usize;
        let end = self.ranges[vertex as usize + 1] as usize;
        &self.neighbors[start..end]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icosahedron_vertices_have_degree_5() {
        let s = Icosphere::new(0);
        let adj = Adjacency::build(&s);
        for v in 0..s.vertices.len() as u32 {
            assert_eq!(adj.of(v).len(), 5, "vertex {} expected degree 5", v);
        }
    }

    #[test]
    fn subdivided_interior_vertices_are_degree_6() {
        let s = Icosphere::new(2);
        let adj = Adjacency::build(&s);
        // First 12 are the original icosahedron vertices (degree 5).
        // All subdivision-introduced vertices should be degree 6.
        let mut fives = 0;
        let mut sixes = 0;
        for v in 0..s.vertices.len() as u32 {
            match adj.of(v).len() {
                5 => fives += 1,
                6 => sixes += 1,
                d => panic!("vertex {} has unexpected degree {}", v, d),
            }
        }
        assert_eq!(fives, 12);
        assert_eq!(sixes, s.vertices.len() - 12);
    }
}
