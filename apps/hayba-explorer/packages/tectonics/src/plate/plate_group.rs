//! `PlateGroup`: aggregate of fused plates sharing momentum.
//!
//! Port target: tectonic-explorer's `src/plates-model/plate-group.ts`.
//! Frozen reference: `docs/research/te-snapshot/plates-model/plate-group.ts`.
//!
//! In TE a `PlateGroup` is a set of plates that, while connected, behave like
//! a single rigid body: their `momentOfInertia` is summed, and the combined
//! `angularAcceleration` is recomputed from the combined inverse tensor.
//!
//! ## TE → Rust mapping
//!
//! * TS `Set<Plate>` → Rust `Vec<u32>` of plate ids, kept sorted for
//!   determinism. Lookup is `binary_search`.
//! * TS `PlateGroup.totalTorque` walks plate refs; the Rust orchestrator
//!   passes in `&[&Plate]` (already-resolved references) to avoid storing
//!   back-pointers.
//! * The TS `serialize` / `deserialize` round-trip is captured by `serde`
//!   derives.

use glam::{Mat3, Vec3};
use serde::{Deserialize, Serialize};

use super::plate::Plate;
use crate::field::Field;

/// Combined rigid-body state computed across a set of grouped plates.
///
/// Mirrors TE `PlateGroup.angularAcceleration` (`plate-group.ts:64-66`)
/// exactly: no velocity is mass-weighted across constituents (TE preserves
/// each member plate's `angularVelocity` independently between steps;
/// see model.ts:200-204 for the acceleration-distribution pattern).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct AngularMotion {
    /// Sum of constituent live torques applied through the combined inverse
    /// inertia tensor — i.e. the group-level angular acceleration. This
    /// SAME value is then distributed to each member plate (TE's pattern at
    /// `model.ts:200-204`).
    /// TE: `PlateGroup.angularAcceleration` (`plate-group.ts:64-66`).
    pub angular_acceleration: Vec3,
    /// Sum of constituent live torques.
    pub total_torque: Vec3,
    /// Combined mass (TE `PlateGroup.mass`).
    pub mass: f32,
}

/// A rigid-body grouping of plates.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PlateGroup {
    /// Stable group id assigned by the orchestrator. TE doesn't expose this
    /// directly — groups are object identities. We keep an id so it can be
    /// referenced from `Plate.group`.
    pub id: u32,
    /// Sorted plate ids participating in the group.
    pub plates: Vec<u32>,
    pub mass: f32,
    pub moment_of_inertia: Mat3,
    pub inv_moment_of_inertia: Mat3,
}

impl PlateGroup {
    /// Construct from a list of plate ids. The list is sorted and
    /// deduplicated for determinism (TE uses `Set<Plate>` insertion order,
    /// but iteration order isn't observable through serialised state — we
    /// pick the sort to make round-trips deterministic).
    pub fn new(id: u32, mut plates: Vec<u32>) -> Self {
        plates.sort_unstable();
        plates.dedup();
        Self {
            id,
            plates,
            mass: 0.0,
            moment_of_inertia: Mat3::ZERO,
            inv_moment_of_inertia: Mat3::ZERO,
        }
    }

    pub fn has(&self, plate_id: u32) -> bool {
        self.plates.binary_search(&plate_id).is_ok()
    }

    pub fn size(&self) -> usize {
        self.plates.len()
    }

    /// Recompute the combined mass + inertia tensor from member plates.
    /// Port of `PlateGroup.updateInertiaTensor` (`plate-group.ts:68-84`).
    /// `plates` must contain all member references; missing members are
    /// silently skipped to mirror TE's permissive iteration.
    pub fn update_inertia_tensor(&mut self, plates: &[&Plate]) {
        let mut mass = 0.0f32;
        let mut sum = Mat3::ZERO;
        // Iterate `self.plates` in sorted order so float-sum is deterministic.
        for &pid in &self.plates {
            // Linear scan over the (usually small) provided slice.
            let Some(p) = plates.iter().find(|p| p.id == pid) else {
                continue;
            };
            mass += p.mass;
            sum = add_mat3(sum, p.moment_of_inertia);
        }
        self.mass = mass;
        self.moment_of_inertia = sum;
        self.inv_moment_of_inertia = if mass > 0.0 {
            sum.inverse()
        } else {
            Mat3::ZERO
        };
    }

    /// Sum of per-plate *live* `compute_total_torque` results, applied
    /// through the combined inverse inertia tensor. Port of
    /// `PlateGroup.totalTorque` + `PlateGroup.angularAcceleration`
    /// (`plate-group.ts:55-66`).
    ///
    /// `all_fields` is the global field slice (indexed by field id);
    /// `field_area_km2` is `grid.field_area_km2()`. The torque is sourced
    /// LIVE from each member's `compute_total_torque` — not from cached
    /// `angular_acceleration * moment_of_inertia` (which the previous impl
    /// did and which loses the position/velocity-dependent terms when the
    /// orchestrator hasn't just refreshed those caches).
    ///
    /// The other-plates argument (used for orogenic-drag lookups) is the
    /// same `plates` slice; we filter out self-references inside the
    /// helper to avoid double-counting the current plate as its own drag
    /// target.
    pub fn compute_combined_motion(
        &self,
        plates: &[&Plate],
        all_fields: &[Field],
        field_area_km2: f32,
    ) -> AngularMotion {
        let mut total_torque = Vec3::ZERO;
        let mut mass = 0.0f32;
        // Materialise an owned `Vec<Plate>` slice for the cross-plate
        // dragging lookup — `compute_total_torque` takes `&[Plate]`, not
        // `&[&Plate]`. Cheap for the typical group size (≤ a handful).
        let other_plates: Vec<Plate> = plates.iter().map(|p| (*p).clone()).collect();
        for &pid in &self.plates {
            let Some(p) = plates.iter().find(|p| p.id == pid) else {
                continue;
            };
            total_torque += p.compute_total_torque(all_fields, &other_plates, field_area_km2);
            mass += p.mass;
        }
        let accel = if mass > 0.0 {
            self.inv_moment_of_inertia * total_torque
        } else {
            Vec3::ZERO
        };
        AngularMotion {
            angular_acceleration: accel,
            total_torque,
            mass,
        }
    }

    /// Merge another group into this one (TE `mergeGroup`,
    /// `plate-group.ts:43-48`). The merged plate ids are inserted in sort
    /// order; the inertia tensor is refreshed immediately using the supplied
    /// `plates` lookup (matching TE's eager `updateInertiaTensor` call at
    /// `plate-group.ts:47`).
    pub fn merge(mut self, other: PlateGroup, plates: &[&Plate]) -> PlateGroup {
        for pid in other.plates {
            if let Err(idx) = self.plates.binary_search(&pid) {
                self.plates.insert(idx, pid);
            }
        }
        self.update_inertia_tensor(plates);
        self
    }

    /// Split the group along the supplied seam — fields where the seam
    /// runs. Caller passes a partitioning of plate ids; this method returns
    /// the resulting disjoint groups (one per partition).
    ///
    /// TE handles breakage implicitly through `model.removeEmptyPlates`. The
    /// explicit `break` API here lets the orchestrator drive breakage from
    /// rift / collision events deterministically.
    ///
    /// The new groups' ids start at `next_id` and increment. The seam ids
    /// themselves (`at_field_ids`) are not used directly here — they're a
    /// hint for callers building the partition; this function consumes a
    /// list-of-lists already produced from that hint.
    pub fn break_into(self, partitions: Vec<Vec<u32>>, next_id: u32) -> Vec<PlateGroup> {
        partitions
            .into_iter()
            .enumerate()
            .map(|(i, plates)| PlateGroup::new(next_id + i as u32, plates))
            .collect()
    }
}

#[inline]
fn add_mat3(a: Mat3, b: Mat3) -> Mat3 {
    Mat3::from_cols(
        a.col(0) + b.col(0),
        a.col(1) + b.col(1),
        a.col(2) + b.col(2),
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plate::plate::{Plate, OCEAN_DENSITY};

    fn p(id: u32, mass: f32) -> Plate {
        let mut pl = Plate::new(id, 0, OCEAN_DENSITY);
        pl.mass = mass;
        // Set up a trivial isotropic inertia tensor so it's invertible.
        pl.moment_of_inertia = Mat3::IDENTITY * mass.max(1e-6);
        pl.inv_moment_of_inertia = Mat3::IDENTITY * (1.0 / mass.max(1e-6));
        pl
    }

    #[test]
    fn plate_group_creates_sorted_unique() {
        let g = PlateGroup::new(0, vec![3, 1, 2, 1]);
        assert_eq!(g.plates, vec![1, 2, 3]);
    }

    #[test]
    fn plate_group_has_membership() {
        let g = PlateGroup::new(0, vec![1, 2, 3]);
        assert!(g.has(2));
        assert!(!g.has(99));
        assert_eq!(g.size(), 3);
    }

    #[test]
    fn plate_group_inertia_tensor_sums_member_inertias() {
        let pa = p(0, 2.0);
        let pb = p(1, 3.0);
        let mut g = PlateGroup::new(0, vec![0, 1]);
        g.update_inertia_tensor(&[&pa, &pb]);
        assert_eq!(g.mass, 5.0);
        // Sum of two diagonal-scaled identities.
        assert!((g.moment_of_inertia.col(0).x - 5.0).abs() < 1e-5);
    }

    #[test]
    fn plate_group_combined_motion_sums_live_torques() {
        // Two plates with non-singular inertia tensors. Each carries a
        // force_accumulator (so compute_total_torque returns something
        // non-zero), and the group's combined angular_acceleration should
        // equal sum(torque) / sum(I).
        let mut pa = p(0, 1.0);
        pa.apply_force(Vec3::Z, Vec3::X); // synthesise some torque
        let mut pb = p(1, 3.0);
        pb.apply_force(Vec3::Y, Vec3::Z);
        let mut g = PlateGroup::new(0, vec![0, 1]);
        g.update_inertia_tensor(&[&pa, &pb]);
        let m = g.compute_combined_motion(&[&pa, &pb], &[], 1.0);
        assert_eq!(m.mass, 4.0);
        // The combined torque should be approximately the sum of each
        // plate's individual torque.
        let t_a = pa.compute_total_torque(&[], &[pa.clone(), pb.clone()], 1.0);
        let t_b = pb.compute_total_torque(&[], &[pa.clone(), pb.clone()], 1.0);
        let expected = t_a + t_b;
        assert!((m.total_torque - expected).length() < 1e-5);
    }

    #[test]
    fn plate_group_merge_combines_field_lists_and_refreshes_inertia() {
        let pa = p(0, 2.0);
        let pb = p(1, 3.0);
        let pc = p(2, 5.0);
        let g1 = PlateGroup::new(0, vec![0, 1]);
        let g2 = PlateGroup::new(1, vec![1, 2]);
        let merged = g1.merge(g2, &[&pa, &pb, &pc]);
        assert_eq!(merged.plates, vec![0, 1, 2]);
        // Inertia tensor must be refreshed — mass should match sum of all
        // unique constituents.
        assert!((merged.mass - 10.0).abs() < 1e-5);
    }

    #[test]
    fn plate_group_break_separates_disjoint() {
        let g = PlateGroup::new(0, vec![0, 1, 2, 3]);
        let parts = g.break_into(vec![vec![0, 1], vec![2, 3]], 10);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].plates, vec![0, 1]);
        assert_eq!(parts[1].plates, vec![2, 3]);
        assert_eq!(parts[0].id, 10);
        assert_eq!(parts[1].id, 11);
    }

    #[test]
    fn serialization_round_trip() {
        let mut g = PlateGroup::new(7, vec![1, 2, 5]);
        g.mass = 12.0;
        g.moment_of_inertia = Mat3::IDENTITY * 12.0;
        g.inv_moment_of_inertia = Mat3::IDENTITY / 12.0;
        let bytes = bincode::serialize(&g).unwrap();
        let h: PlateGroup = bincode::deserialize(&bytes).unwrap();
        assert_eq!(g, h);
    }
}
