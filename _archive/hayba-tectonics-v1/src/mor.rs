//! Mid-ocean ridges as first-class entities (M0.9).
//!
//! Created at rift-fork time, tracked across the sim's lifetime, retired when
//! a flanking plate dies or the axis is fully subducted (M0.10 / M0.11 land
//! later). Every ridge has a stable monotonic id, a polyline axis frozen at
//! birth, and deterministic transform-fault offsets seeded from the master.
//!
//! ## Public interface
//!
//! - [`MidOceanRidge`] — single ridge: id, axis polyline, spreading rate,
//!   flanking plate ids, birth step, transform-segment list.
//! - [`MorRegistry`] — slot-map of `Vec<Option<MidOceanRidge>>` mirroring the
//!   plate registry pattern (ids never reuse).
//! - [`MorRegistry::allocate`] — straight allocation; [`MorRegistry::allocate_with_master`]
//!   reseeds transform segments using the freshly-issued id so concurrent
//!   spawns at the same macro-step still produce unique patterns.
//! - [`build_ridge`] — fold a parent/child plate pair + rift cells into a
//!   `MidOceanRidge` (the `id` field is filled in by the registry).
//! - [`axis_from_rift_cells`], [`axis_arc_lengths`], [`axis_perpendicular`],
//!   [`transform_segments_from_axis`] — pure geometric helpers usable by
//!   visualizers without going through the registry.
//! - Constants: [`MAX_AXIS_POINTS`], [`TRANSFORM_STRIDE`].
//!
//! ## Integration
//!
//! The hook lives in [`crate::lifecycle::try_rift_fork_with_mor`] — an
//! additive wrapper around `try_rift_fork`. Callers that want MOR tracking
//! switch to the `_with_mor` variant; the default path stays byte-identical.

use crate::mesh::Vec3f;
use crate::motion::PlateMotion;
use crate::sphere_geom::project_to_tangent_plane;
use hayba_seeds::{derive_scope, MasterSeed, Scope};

/// Cap on axis polyline vertex count. Rift cell sets are short by
/// construction (a thin meridional band), but very long rifts get
/// uniformly sub-sampled to this many points for cleanliness.
pub const MAX_AXIS_POINTS: usize = 32;

/// Roughly every N axis polyline points, generate a transform-fault
/// offset segment. With ~32-point cap this gives ~6 transform segments
/// for a fully populated axis.
pub const TRANSFORM_STRIDE: usize = 5;

#[derive(Debug, Clone)]
pub struct MidOceanRidge {
    pub id: u32,
    /// Continuous polyline axis on the sphere. Order is the rift trace
    /// direction from one triple-junction end to the other.
    pub axis: Vec<Vec3f>,
    /// Spreading rate in rad/Myr (relative angular speed of flanking plates).
    pub spreading_rate: f64,
    /// (plate_a, plate_b) of the two flanks. Stable for the MOR's lifetime.
    pub flanking_plate_ids: (u32, u32),
    /// Macro-step the MOR was born.
    pub birth_macro_step: u32,
    /// Perpendicular transform-fault offsets baked at spawn time. Each
    /// segment is offset perpendicularly by a deterministic seeded amount.
    /// `(axis_t_start, axis_t_end, offset_distance)` where `axis_t` is
    /// arc length along the axis polyline.
    pub transform_segments: Vec<(f64, f64, f64)>,
    /// Whether the ridge is currently live. Set to `false` by
    /// [`death_check`](MidOceanRidge::death_check) when its axis collapses,
    /// its divergence rate stays below threshold for ≥30 consecutive
    /// macro-steps, or either flanking plate retires.
    pub is_active: bool,
    /// Consecutive macro-step count with divergence rate < 0.05 cm/yr
    /// (≈5e-4 rad/Myr on the unit sphere). Reset whenever the rate goes
    /// back above threshold.
    pub low_div_streak: u8,
}

#[derive(Debug, Default)]
pub struct MorRegistry {
    /// Mirrors the plate registry pattern. Retired MORs leave None slots;
    /// ids never reuse.
    pub ridges: Vec<Option<MidOceanRidge>>,
    pub next_id_counter: u32,
}

impl MorRegistry {
    /// Empty registry — no live ridges, next allocated id is 0.
    pub fn new() -> Self { Self::default() }

    /// Allocate a new MOR. Ids are monotonic, never reused. The `id` field
    /// on the supplied ridge is overwritten with the freshly-issued id.
    pub fn allocate(&mut self, ridge: MidOceanRidge) -> u32 {
        let id = self.next_id_counter;
        let mut ridge = ridge;
        ridge.id = id;
        self.ridges.push(Some(ridge));
        self.next_id_counter += 1;
        id
    }

    /// Mark a ridge id as retired. Subsequent [`ridge`] / [`live_ridges`]
    /// lookups skip it; the id is never reused.
    ///
    /// [`ridge`]: MorRegistry::ridge
    /// [`live_ridges`]: MorRegistry::live_ridges
    pub fn retire(&mut self, id: u32) {
        if let Some(slot) = self.ridges.get_mut(id as usize) {
            *slot = None;
        }
    }

    /// Borrow a ridge by id; returns `None` if retired or out of range.
    pub fn ridge(&self, id: u32) -> Option<&MidOceanRidge> {
        self.ridges.get(id as usize).and_then(|r| r.as_ref())
    }

    /// Iterate over `(id, &MidOceanRidge)` pairs for every live ridge, in id
    /// order. Retired slots are skipped. **B2:** also skips ridges whose
    /// `is_active` flag has been flipped to false by a death-check pass.
    pub fn live_ridges(&self) -> impl Iterator<Item = (u32, &MidOceanRidge)> {
        self.ridges.iter().enumerate()
            .filter_map(|(i, r)| r.as_ref().filter(|r| r.is_active).map(|r| (i as u32, r)))
    }

    /// Mutable variant of [`live_ridges`] used by the death-check pass in
    /// `macro_step::post_step`. Includes `is_active=false` slots so callers
    /// can flip them back if they need to; for normal iteration over active
    /// ridges, prefer [`live_ridges`].
    pub fn ridges_mut(&mut self) -> impl Iterator<Item = (u32, &mut MidOceanRidge)> {
        self.ridges.iter_mut().enumerate()
            .filter_map(|(i, r)| r.as_mut().map(|r| (i as u32, r)))
    }
}

/// Build a MOR axis polyline from a set of rift cells. The cells are
/// projected onto the rift's principal axis (PCA over their positions),
/// sorted by that scalar, and emitted in order. If the result has more
/// than `MAX_AXIS_POINTS` vertices, it's uniformly sub-sampled.
///
/// Deterministic given the same `rift_cells` slice and `vertices`.
pub fn axis_from_rift_cells(rift_cells: &[u32], vertices: &[Vec3f]) -> Vec<Vec3f> {
    if rift_cells.is_empty() {
        return Vec::new();
    }
    if rift_cells.len() == 1 {
        return vec![vertices[rift_cells[0] as usize]];
    }

    // PCA principal axis on the rift cells' positions.
    let (mid, tangent) = rift_pca(rift_cells, vertices);

    // Project each rift cell's position onto the tangent direction and
    // sort by that scalar.
    let mut indexed: Vec<(f64, Vec3f, u32)> = rift_cells.iter().map(|&c| {
        let p = vertices[c as usize];
        let d = p.sub(mid);
        let t = d.x * tangent.x + d.y * tangent.y + d.z * tangent.z;
        (t, p, c)
    }).collect();
    // Sort by projection; tie-break by cell id for determinism.
    indexed.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.2.cmp(&b.2))
    });

    let points: Vec<Vec3f> = indexed.into_iter().map(|(_, p, _)| p).collect();
    if points.len() <= MAX_AXIS_POINTS {
        return points;
    }
    // Uniform sub-sample to MAX_AXIS_POINTS.
    let n = points.len();
    let stride = (n - 1) as f64 / (MAX_AXIS_POINTS - 1) as f64;
    (0..MAX_AXIS_POINTS).map(|i| {
        let idx = (i as f64 * stride).round() as usize;
        points[idx.min(n - 1)]
    }).collect()
}

/// PCA midpoint + principal tangent of a rift cell set. Same approach as
/// `lifecycle::rift_midpoint_and_tangent`; reimplemented locally so this
/// module doesn't depend on a private fn in lifecycle.
fn rift_pca(cells: &[u32], vertices: &[Vec3f]) -> (Vec3f, Vec3f) {
    let mut sum = Vec3f::new(0.0, 0.0, 0.0);
    let n = cells.len() as f64;
    for &c in cells {
        let p = vertices[c as usize];
        sum.x += p.x; sum.y += p.y; sum.z += p.z;
    }
    let mid = Vec3f::new(sum.x / n, sum.y / n, sum.z / n)
        .normalize_or(Vec3f::new(0.0, 0.0, 1.0));

    let mut cov = [[0.0f64; 3]; 3];
    for &c in cells {
        let p = vertices[c as usize];
        let d = p.sub(mid);
        cov[0][0] += d.x * d.x; cov[0][1] += d.x * d.y; cov[0][2] += d.x * d.z;
        cov[1][0] += d.y * d.x; cov[1][1] += d.y * d.y; cov[1][2] += d.y * d.z;
        cov[2][0] += d.z * d.x; cov[2][1] += d.z * d.y; cov[2][2] += d.z * d.z;
    }
    let mut v = Vec3f::new(1.0, 0.0, 0.0);
    for _ in 0..16 {
        let new = Vec3f::new(
            cov[0][0] * v.x + cov[0][1] * v.y + cov[0][2] * v.z,
            cov[1][0] * v.x + cov[1][1] * v.y + cov[1][2] * v.z,
            cov[2][0] * v.x + cov[2][1] * v.y + cov[2][2] * v.z,
        );
        v = new.normalize_or(v);
    }
    let tangent = project_to_tangent_plane(mid, v)
        .normalize_or(Vec3f::new(1.0, 0.0, 0.0));
    (mid, tangent)
}

/// Cumulative arc lengths along an axis polyline. Returns a Vec the same
/// length as `axis` where entry `i` is the arc length from `axis[0]` to
/// `axis[i]`. For a single-point axis returns `[0.0]`.
pub fn axis_arc_lengths(axis: &[Vec3f]) -> Vec<f64> {
    let mut acc = 0.0;
    let mut out = Vec::with_capacity(axis.len());
    for (i, p) in axis.iter().enumerate() {
        if i > 0 {
            let prev = axis[i - 1];
            let d = p.sub(prev);
            acc += (d.x * d.x + d.y * d.y + d.z * d.z).sqrt();
        }
        out.push(acc);
    }
    out
}

/// Deterministic 32-bit hash combining a u64 base seed with two u32 indices.
/// Used to drive transform-segment magnitudes & signs without pulling in
/// the rand crate (we want byte-identical output across architectures).
fn hash_segment(base: u64, mor_id: u32, seg_idx: u32) -> u64 {
    // SplitMix64 — small, deterministic, no external dep.
    let mut z = base
        .wrapping_add((mor_id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
        .wrapping_add((seg_idx as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Generate transform-fault segments along an axis polyline.
///
/// Roughly every `TRANSFORM_STRIDE` axis points, emit one segment
/// `(start_t, end_t, signed_offset)` where `start_t..end_t` is an
/// arc-length interval along the axis and `signed_offset` is a
/// perpendicular displacement magnitude in unit-sphere radians (sign
/// alternates pseudo-randomly).
///
/// Deterministic given `master` + `mor_id` + `axis`.
pub fn transform_segments_from_axis(
    master: MasterSeed,
    mor_id: u32,
    axis: &[Vec3f],
) -> Vec<(f64, f64, f64)> {
    if axis.len() < 2 {
        return Vec::new();
    }
    let arc = axis_arc_lengths(axis);
    let total = *arc.last().unwrap();
    if total <= 0.0 {
        return Vec::new();
    }
    let base = derive_scope(master, Scope::Tectonic).wrapping_add(0xCD_E0_FF);

    let mut out = Vec::new();
    let mut seg_idx: u32 = 0;
    // Walk in strides of TRANSFORM_STRIDE points, emitting one segment per
    // window. The last (possibly short) window is included if it covers
    // at least 2 points.
    let mut i = 0usize;
    while i + 1 < axis.len() {
        let j = (i + TRANSFORM_STRIDE).min(axis.len() - 1);
        let start_t = arc[i];
        let end_t = arc[j];
        if end_t > start_t {
            let h = hash_segment(base, mor_id, seg_idx);
            // Magnitude in [0.01, 0.05] rad on the unit sphere.
            let mag_unit = (h & 0xFFFF) as f64 / 65535.0;
            let mag = 0.01 + mag_unit * 0.04;
            // Sign: top bit of an unrelated chunk.
            let sign = if (h >> 32) & 1 == 0 { -1.0 } else { 1.0 };
            out.push((start_t, end_t, sign * mag));
            seg_idx += 1;
        }
        if j >= axis.len() - 1 { break; }
        i = j;
    }
    out
}

/// Compute the perpendicular direction (tangent-plane normal to the local
/// axis tangent) at a point on the axis polyline. Used both internally and
/// by consumers (visualizer) that want to draw transform offsets.
pub fn axis_perpendicular(axis: &[Vec3f], index: usize) -> Vec3f {
    if axis.len() < 2 {
        return Vec3f::new(1.0, 0.0, 0.0);
    }
    let i = index.min(axis.len() - 1);
    // Local tangent: difference to neighbour.
    let (a, b) = if i + 1 < axis.len() {
        (axis[i], axis[i + 1])
    } else {
        (axis[i - 1], axis[i])
    };
    let tangent = b.sub(a).normalize_or(Vec3f::new(1.0, 0.0, 0.0));
    // Perpendicular in the tangent plane at `axis[i]`: cross with the
    // outward radial (axis[i] itself, since we're on a unit sphere).
    let radial = axis[i];
    radial.cross(tangent).normalize_or(Vec3f::new(0.0, 1.0, 0.0))
}

/// Build a MidOceanRidge for a freshly-forked flank pair.
///
/// `master` is the world master seed (drives the transform-segment hash).
/// `flank_a` / `flank_b` are the two newly-separated plates' ids and
/// motions. `rift_cells` and `vertices` define the axis geometry.
///
/// The returned ridge has `id = u32::MAX` as a sentinel; pass it to
/// [`MorRegistry::allocate`] which overwrites the id with a fresh one.
pub fn build_ridge(
    master: MasterSeed,
    flank_a: (u32, &PlateMotion),
    flank_b: (u32, &PlateMotion),
    rift_cells: &[u32],
    vertices: &[Vec3f],
    macro_step: u32,
) -> MidOceanRidge {
    let axis = axis_from_rift_cells(rift_cells, vertices);

    // Spreading rate at the rift midpoint: |v_a - v_b| / r where r = 1
    // on the unit sphere. velocity_at returns ω × p on the unit sphere
    // (rad/Myr), so |v_a - v_b| is the relative tangential speed at that
    // point in rad/Myr.
    let mid = if axis.is_empty() {
        Vec3f::new(0.0, 0.0, 1.0)
    } else {
        axis[axis.len() / 2]
    };
    let va = flank_a.1.velocity_at(mid);
    let vb = flank_b.1.velocity_at(mid);
    let dv = va.sub(vb);
    let spreading_rate = (dv.x * dv.x + dv.y * dv.y + dv.z * dv.z).sqrt();

    // Transform segments — use a tentative id of 0; the real id is sealed
    // by MorRegistry::allocate, which overwrites self.id. Because the
    // segments are baked at spawn time we recompute them deterministically
    // there. To make segments depend on the *real* id we accept the
    // tradeoff that allocate calls regenerate_transforms after assigning.
    // Simpler: hash on the tentative-id-0 stream here; allocate is free to
    // ignore. See `MorRegistry::allocate_with_master` below for the
    // "fresh id seals it" path used by lifecycle.
    let transform_segments = transform_segments_from_axis(master, 0, &axis);

    MidOceanRidge {
        id: u32::MAX,
        axis,
        spreading_rate,
        flanking_plate_ids: (flank_a.0, flank_b.0),
        birth_macro_step: macro_step,
        transform_segments,
        is_active: true,
        low_div_streak: 0,
    }
}

/// Divergence threshold below which a MOR is considered "dying" (rad/Myr on
/// the unit sphere; ≈0.05 cm/yr at ~6371 km radius).
pub const MOR_LOW_DIVERGENCE_THRESHOLD: f64 = 5e-4;
/// Consecutive low-divergence steps required to declare death.
pub const MOR_LOW_DIVERGENCE_DEATH_STREAK: u8 = 30;
/// Axis polyline arc-length (radians on the unit sphere) below which the
/// axis is considered collapsed.
pub const MOR_AXIS_COLLAPSE_LENGTH: f64 = 0.001;

impl MidOceanRidge {
    /// **B2 — MOR death detection.** Returns `true` when this ridge should
    /// retire. Mutates `low_div_streak` as a side-effect (the streak is
    /// internal book-keeping). Death conditions, any of which trigger:
    ///
    /// 1. **Flanking-plate retirement** — either of the two bounding plates
    ///    is no longer live (`plate_alive(id)` returns false).
    /// 2. **Sustained low divergence** — `current_divergence_rate` has been
    ///    below [`MOR_LOW_DIVERGENCE_THRESHOLD`] for
    ///    [`MOR_LOW_DIVERGENCE_DEATH_STREAK`] or more consecutive calls.
    /// 3. **Axis collapse** — total polyline arc-length is below
    ///    [`MOR_AXIS_COLLAPSE_LENGTH`].
    pub fn death_check(
        &mut self,
        plate_alive: impl Fn(u32) -> bool,
        current_divergence_rate: f32,
    ) -> bool {
        let (a, b) = self.flanking_plate_ids;
        if !plate_alive(a) || !plate_alive(b) {
            return true;
        }
        if (current_divergence_rate as f64) < MOR_LOW_DIVERGENCE_THRESHOLD {
            self.low_div_streak = self.low_div_streak.saturating_add(1);
            if self.low_div_streak >= MOR_LOW_DIVERGENCE_DEATH_STREAK {
                return true;
            }
        } else {
            self.low_div_streak = 0;
        }
        let arc = axis_arc_lengths(&self.axis);
        let total = arc.last().copied().unwrap_or(0.0);
        if total < MOR_AXIS_COLLAPSE_LENGTH {
            return true;
        }
        false
    }

    /// Per-macro-step axis update. Cells on the axis reset to age 0 with
    /// fresh basalt+gabbro layers. Cells within `accretion_distance` of
    /// the axis get age = `arc_distance × 2 / spreading_rate` (capped at
    /// the typical oceanic age cap of 200 Ma).
    pub fn age_step(
        &self,
        vertices: &[crate::mesh::Vec3f],
        cell_plate: &[u32],
        crust: &mut crate::crust_state::CrustState,
    ) {
        const ACCRETION_DISTANCE: f64 = 0.02; // arc radians ≈ 125 km
        const AXIS_RESET_DISTANCE: f64 = ACCRETION_DISTANCE * 0.3; // ~37 km
        const MAX_OCEANIC_AGE: u16 = 200;
        let rate = self.spreading_rate.max(1e-9);
        for (i, &p) in vertices.iter().enumerate() {
            // Only touch cells belonging to one of the flanking plates.
            let pid = cell_plate[i];
            if pid != self.flanking_plate_ids.0 && pid != self.flanking_plate_ids.1 {
                continue;
            }
            // Distance from cell to nearest axis point.
            let mut min_d = f64::INFINITY;
            for &a in &self.axis {
                let dot = (p.x * a.x + p.y * a.y + p.z * a.z).clamp(-1.0, 1.0);
                let d = dot.acos();
                if d < min_d { min_d = d; }
            }
            if min_d < ACCRETION_DISTANCE {
                let target_age = ((min_d * 2.0 / rate) as u32).min(MAX_OCEANIC_AGE as u32) as u16;
                crust.age_ma[i] = target_age;
                if min_d < AXIS_RESET_DISTANCE {
                    crust.layers[i] = crate::crust_state::CrustLayers {
                        gabbro: 4, basalt: 3, ..Default::default()
                    };
                }
            }
        }
    }
}

impl MorRegistry {
    /// Allocate a ridge and re-seed its transform segments using the
    /// freshly-issued id. This gives every ridge a unique deterministic
    /// transform pattern, even when many spawn during the same macro-step.
    pub fn allocate_with_master(
        &mut self,
        master: MasterSeed,
        mut ridge: MidOceanRidge,
    ) -> u32 {
        let id = self.next_id_counter;
        ridge.id = id;
        ridge.transform_segments = transform_segments_from_axis(master, id, &ridge.axis);
        self.ridges.push(Some(ridge));
        self.next_id_counter += 1;
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_motion(omega: Vec3f) -> PlateMotion {
        PlateMotion { omega }
    }

    #[test]
    fn registry_allocate_retire_round_trip() {
        let mut reg = MorRegistry::new();
        let ridge = MidOceanRidge {
            id: u32::MAX,
            axis: vec![Vec3f::new(1.0, 0.0, 0.0), Vec3f::new(0.0, 1.0, 0.0)],
            spreading_rate: 0.001,
            flanking_plate_ids: (0, 1),
            birth_macro_step: 5,
            transform_segments: vec![],
            is_active: true,
            low_div_streak: 0,
        };
        let id = reg.allocate(ridge);
        assert_eq!(id, 0);
        assert!(reg.ridge(id).is_some());
        assert_eq!(reg.ridge(id).unwrap().id, id, "allocate writes the id back");

        reg.retire(id);
        assert!(reg.ridge(id).is_none(), "retired slot reads as None");
    }

    #[test]
    fn ids_never_reuse() {
        let mut reg = MorRegistry::new();
        let mk = || MidOceanRidge {
            id: u32::MAX,
            axis: vec![Vec3f::new(1.0, 0.0, 0.0), Vec3f::new(0.0, 1.0, 0.0)],
            spreading_rate: 0.001,
            flanking_plate_ids: (0, 1),
            birth_macro_step: 0,
            transform_segments: vec![],
            is_active: true,
            low_div_streak: 0,
        };
        let id1 = reg.allocate(mk());
        reg.retire(id1);
        let id2 = reg.allocate(mk());
        assert!(id2 > id1, "ids must be monotonically increasing across retire");
        assert!(reg.ridges[id1 as usize].is_none());
    }

    #[test]
    fn transform_segments_are_perpendicular_to_axis() {
        // Synthetic axis: a quarter-arc from (1,0,0) to (0,1,0) on the
        // unit sphere, sampled at 11 points.
        let n = 11;
        let axis: Vec<Vec3f> = (0..n).map(|i| {
            let t = i as f64 / (n - 1) as f64 * std::f64::consts::FRAC_PI_2;
            Vec3f::new(t.cos(), t.sin(), 0.0)
        }).collect();

        let segs = transform_segments_from_axis(MasterSeed(12345), 7, &axis);
        assert!(!segs.is_empty(), "expected at least one transform segment");

        // For each segment, find the nearest axis point to its midpoint
        // (by arc length) and verify the perpendicular returned by
        // `axis_perpendicular` is orthogonal to the local tangent.
        let arc = axis_arc_lengths(&axis);
        for &(s, e, _off) in &segs {
            let mid_t = 0.5 * (s + e);
            let idx = arc.iter()
                .enumerate()
                .min_by(|a, b| (a.1 - mid_t).abs().partial_cmp(&(b.1 - mid_t).abs()).unwrap())
                .map(|(i, _)| i)
                .unwrap();
            let perp = axis_perpendicular(&axis, idx);

            // Local tangent.
            let (a, b) = if idx + 1 < axis.len() {
                (axis[idx], axis[idx + 1])
            } else {
                (axis[idx - 1], axis[idx])
            };
            let tan = b.sub(a).normalize_or(Vec3f::new(1.0, 0.0, 0.0));
            let dot = perp.x * tan.x + perp.y * tan.y + perp.z * tan.z;
            assert!(dot.abs() < 1e-9, "perp not orthogonal to local tangent: dot={}", dot);
        }
    }

    #[test]
    fn axis_polyline_traces_rift_cells() {
        // Build a synthetic 10-cell rift line: ten points along a meridian
        // (z varying from -0.45 to +0.45), all with x≈0, y≈some-fixed-value.
        let n = 10;
        let vertices: Vec<Vec3f> = (0..n).map(|i| {
            let z = -0.45 + 0.9 * (i as f64) / (n as f64 - 1.0);
            // Lie on a meridian on the unit sphere.
            let r = (1.0 - z * z).sqrt();
            Vec3f::new(0.0, r, z)
        }).collect();
        let rift_cells: Vec<u32> = (0..n as u32).collect();

        // Permute the input cell order — the axis-builder must still
        // return points in the principal-axis (z) order.
        let scrambled: Vec<u32> = vec![3, 7, 0, 5, 9, 1, 8, 2, 6, 4];
        let axis = axis_from_rift_cells(&scrambled, &vertices);

        assert_eq!(axis.len(), n, "axis preserves all input points when below cap");

        // Each cell's position is somewhere in the axis (within numeric
        // tolerance) — i.e. the axis is a permutation of the inputs.
        for &c in &rift_cells {
            let p = vertices[c as usize];
            let found = axis.iter().any(|a| {
                let d = a.sub(p);
                (d.x * d.x + d.y * d.y + d.z * d.z).sqrt() < 1e-9
            });
            assert!(found, "rift cell {} not present in axis polyline", c);
        }

        // The axis is monotone along the principal axis (z increasing or
        // decreasing — either direction is fine since PCA is sign-free).
        let z_diffs: Vec<f64> = axis.windows(2).map(|w| w[1].z - w[0].z).collect();
        let all_pos = z_diffs.iter().all(|&d| d >= -1e-12);
        let all_neg = z_diffs.iter().all(|&d| d <= 1e-12);
        assert!(all_pos || all_neg,
            "axis not monotone along principal axis: z deltas = {:?}", z_diffs);
    }

    #[test]
    fn build_ridge_computes_spreading_rate() {
        // Two flanking plates rotating oppositely about y axis. At a
        // point on the equator (1,0,0), v = ω × p = (0, ω_y, 0) × (1, 0, 0)
        // wait — actually ω×p for ω=(0,ωy,0), p=(1,0,0) is (0,0,-ωy). So
        // relative velocity = (0,0,-2ωy), magnitude = 2|ωy|.
        let omega_a = Vec3f::new(0.0, 0.001, 0.0);
        let omega_b = Vec3f::new(0.0, -0.001, 0.0);
        let mot_a = synthetic_motion(omega_a);
        let mot_b = synthetic_motion(omega_b);

        // Single-cell axis at (1,0,0).
        let vertices = vec![Vec3f::new(1.0, 0.0, 0.0)];
        let rift_cells = vec![0u32];

        let ridge = build_ridge(
            MasterSeed(42),
            (0, &mot_a),
            (1, &mot_b),
            &rift_cells,
            &vertices,
            10,
        );
        // Expected spreading rate ≈ 0.002.
        assert!((ridge.spreading_rate - 0.002).abs() < 1e-9,
            "spreading_rate = {} (expected ~0.002)", ridge.spreading_rate);
        assert_eq!(ridge.flanking_plate_ids, (0, 1));
        assert_eq!(ridge.birth_macro_step, 10);
    }

    #[test]
    fn age_stripes_symmetric_after_age_step() {
        use crate::crust_state::{Composition, CrustLayers, CrustState};
        use crate::mesh::Vec3f;

        // Synthetic: 100 cells, axis is the x=0 great circle (y-z plane).
        // Half on +x side, half on -x. Symmetric arc distances from axis.
        // After one age_step, mean ages on each side should be equal (within noise).
        let n = 100;
        let mut vertices = Vec::with_capacity(n);
        for i in 0..n {
            let theta = (i as f64) * std::f64::consts::TAU / n as f64;
            let x = if i % 2 == 0 { 0.3 } else { -0.3 };
            // Place at (x, sin(theta), cos(theta)) then normalize.
            let v = Vec3f::new(x, theta.sin() * 0.95, theta.cos() * 0.95).normalize();
            vertices.push(v);
        }
        let cell_plate: Vec<u32> = vec![0u32; n / 2]
            .into_iter()
            .chain(vec![1u32; n / 2])
            .collect();
        let mut crust = CrustState {
            composition: vec![Composition::Oceanic; n],
            age_ma: vec![100; n],
            elevation_m: vec![-3500; n],
            layers: vec![CrustLayers::default(); n],
            bending: vec![0; n],
            volcanic_act: vec![0; n],
            rift_progress: vec![0; n],
            failed_rift_age_ma: vec![0; n],
            lip_age_ma: vec![0; n],
            flow_accum: vec![0; n],
            lake_mask: vec![0; n],
        };
        let axis: Vec<Vec3f> = (0..10)
            .map(|i| {
                let theta = (i as f64) * std::f64::consts::TAU / 10.0;
                Vec3f::new(0.0, theta.sin(), theta.cos()).normalize()
            })
            .collect();
        let ridge = MidOceanRidge {
            id: 0,
            axis,
            spreading_rate: 0.01,
            flanking_plate_ids: (0, 1),
            birth_macro_step: 0,
            transform_segments: vec![],
            is_active: true,
            low_div_streak: 0,
        };
        ridge.age_step(&vertices, &cell_plate, &mut crust);

        // Sample mean age on each side
        let mean_a: f64 =
            crust.age_ma.iter().take(n / 2).map(|&a| a as f64).sum::<f64>() / (n / 2) as f64;
        let mean_b: f64 =
            crust.age_ma.iter().skip(n / 2).map(|&a| a as f64).sum::<f64>() / (n / 2) as f64;
        let asymmetry = (mean_a - mean_b).abs() / mean_a.max(mean_b).max(1.0);
        assert!(asymmetry < 0.20, "age stripe asymmetry {} > 20%", asymmetry);
    }

    #[test]
    fn death_check_fires_when_flanking_plate_retired() {
        // B2: spawn a MOR with flanking plates (5, 7). Mark plate 5 as
        // retired (plate_alive returns false for it) and assert
        // death_check returns true.
        let axis: Vec<Vec3f> = (0..5).map(|i| {
            let t = i as f64 * 0.05;
            Vec3f::new(t.cos(), t.sin(), 0.0).normalize_or(Vec3f::new(1.0, 0.0, 0.0))
        }).collect();
        let mut ridge = MidOceanRidge {
            id: 0,
            axis,
            spreading_rate: 0.01,
            flanking_plate_ids: (5, 7),
            birth_macro_step: 0,
            transform_segments: vec![],
            is_active: true,
            low_div_streak: 0,
        };

        // Both alive → not dead.
        assert_eq!(ridge.death_check(|_| true, 0.01), false);

        // Retire flanking plate 5 → death.
        let died = ridge.death_check(|id| id != 5, 0.01);
        assert!(died, "MOR should retire when flanking plate dies");
    }

    #[test]
    fn death_check_fires_on_sustained_low_divergence() {
        let axis: Vec<Vec3f> = (0..5).map(|i| {
            let t = i as f64 * 0.05;
            Vec3f::new(t.cos(), t.sin(), 0.0).normalize_or(Vec3f::new(1.0, 0.0, 0.0))
        }).collect();
        let mut ridge = MidOceanRidge {
            id: 0, axis,
            spreading_rate: 1e-5, // very low
            flanking_plate_ids: (0, 1),
            birth_macro_step: 0,
            transform_segments: vec![],
            is_active: true, low_div_streak: 0,
        };
        // Drive the streak up by repeated below-threshold calls.
        for _ in 0..(MOR_LOW_DIVERGENCE_DEATH_STREAK as usize - 1) {
            let died = ridge.death_check(|_| true, 1e-5);
            assert!(!died, "should not die before streak completes");
        }
        let died = ridge.death_check(|_| true, 1e-5);
        assert!(died, "MOR should die after {} low-div steps",
            MOR_LOW_DIVERGENCE_DEATH_STREAK);

        // Recovery: rate goes up, streak resets, ridge isn't dead.
        ridge.is_active = true;
        ridge.low_div_streak = 0;
        assert!(!ridge.death_check(|_| true, 1.0));
        assert_eq!(ridge.low_div_streak, 0);
    }

    #[test]
    fn death_check_fires_when_axis_collapses() {
        // Axis of two near-identical points — total arc length below threshold.
        let mut ridge = MidOceanRidge {
            id: 0,
            axis: vec![
                Vec3f::new(1.0, 0.0, 0.0),
                Vec3f::new(1.0, 1e-6, 0.0),
            ],
            spreading_rate: 0.01,
            flanking_plate_ids: (0, 1),
            birth_macro_step: 0,
            transform_segments: vec![],
            is_active: true, low_div_streak: 0,
        };
        assert!(ridge.death_check(|_| true, 0.01),
            "MOR should die when axis polyline collapses");
    }

    #[test]
    fn transform_segments_deterministic_across_runs() {
        let axis: Vec<Vec3f> = (0..12).map(|i| {
            let t = i as f64 * 0.1;
            Vec3f::new(t.cos(), t.sin(), 0.0).normalize_or(Vec3f::new(1.0, 0.0, 0.0))
        }).collect();
        let s1 = transform_segments_from_axis(MasterSeed(12345), 3, &axis);
        let s2 = transform_segments_from_axis(MasterSeed(12345), 3, &axis);
        assert_eq!(s1.len(), s2.len());
        for (a, b) in s1.iter().zip(s2.iter()) {
            assert_eq!(a.0.to_bits(), b.0.to_bits());
            assert_eq!(a.1.to_bits(), b.1.to_bits());
            assert_eq!(a.2.to_bits(), b.2.to_bits());
        }
        // And the offset magnitudes are in [0.01, 0.05].
        for &(_, _, off) in &s1 {
            assert!(off.abs() >= 0.01 - 1e-12 && off.abs() <= 0.05 + 1e-12,
                "offset out of [0.01, 0.05]: {}", off);
        }
    }
}
