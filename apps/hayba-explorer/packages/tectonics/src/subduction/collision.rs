//! Plate-plate collision detection + resolution.
//!
//! Port target: tectonic-explorer's `src/plates-model/fields-collision.ts`
//! plus the collision loop in `model.ts:340-374`.
//! Frozen reference: `docs/research/te-snapshot/plates-model/`.
//!
//! ## TE → Rust mapping
//!
//! TE's collision loop walks every "possibly colliding" field on a plate,
//! and for each one looks at the next plate down (and up) in density-sorted
//! order, querying `fieldAtAbsolutePos` to see if their plate overlaps. When
//! it does, `fieldsCollision(bottom, top)` is called.
//!
//! `fieldsCollision` branches:
//!   * If `bottom.crust.canSubduct()` (i.e. bottom is oceanic): start
//!     subduction (`Subduction::start`/`set_collision`) on the bottom field,
//!     plus a continent-buffer edge-case drag.
//!   * Else if `top.crust.canSubduct()` is also false (both continental):
//!     orogeny — drag + subduction record on the bottom side.
//!   * Else if the top field is a continent buffer: kill the ocean field
//!     between them (so the continents can collide next step).
//!   * Otherwise (continent trying to subduct under an ocean): drag both
//!     plates.
//!
//! The Rust port:
//!   1. `detect_field_collisions(plates, grid, fields)` returns a sorted
//!      `Vec<FieldCollision>` describing each overlap, with `bottom`/`top`
//!      always ordered so that the *denser* plate (or, on ties, the lower
//!      plate id) is the bottom. This matches TE's density-sorted iteration.
//!   2. `resolve_field_collision(...)` mutates the field state to start
//!      subduction or apply drag, mirroring `fieldsCollision`.
//!
//! Plates are passed by index (so `plates[i]` is plate `i`); fields are
//! passed as a flat slice indexed by `field_id`.

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::field::Field;
use crate::plate::Plate;
use crate::sphere::Grid;
use crate::subduction::Subduction;

// ---------------------------------------------------------------------------
// Collision record
// ---------------------------------------------------------------------------

/// The kind of resolution chosen for this collision — mirrors TE
/// `fields-collision.ts:35-58` branches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CollisionKind {
    /// `bottom` is oceanic and is sinking under `top`. TE: `subduction()`
    /// branch.
    Subduction,
    /// Both fields are continental. TE: `orogeny()` branch.
    Orogeny,
    /// `top` is a continent buffer and `bottom` is ocean trying to "go
    /// under": kill the ocean field. TE: `topField.alive = false` branch.
    KillBottomOcean,
    /// Continent trying to ride over an ocean (no subduction): just apply
    /// drag forces. TE: `applyDragForces` branch.
    DragOnly,
}

/// A detected collision between two fields owned by different plates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldCollision {
    /// Field id of the (subducting / lower) field.
    pub bottom_field: u32,
    /// Plate id owning `bottom_field`.
    pub bottom_plate: u32,
    /// Field id of the overriding field.
    pub top_field: u32,
    /// Plate id owning `top_field`.
    pub top_plate: u32,
    /// World-space contact position (the world position of `bottom_field`
    /// on the bottom plate; the top plate had a field at the same
    /// approximate position).
    pub contact_pos: Vec3,
    /// Pre-classified resolution branch.
    pub kind: CollisionKind,
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Detect field-level collisions between all plates.
///
/// For each plate and each owned field:
///   1. Compute world position via `plate.compute_field_position`.
///   2. Use the grid's nearest-field lookup to find the sphere field id
///      whose Voronoi cell that world position falls in.
///   3. For each *other* plate, if that other plate also owns the grid
///      field id we landed in, we have a collision.
///
/// The bottom/top assignment is made by density: the denser plate becomes
/// `bottom_plate`. On ties, the smaller plate id wins (deterministic).
///
/// Returns a `Vec<FieldCollision>` sorted by `(bottom_plate, bottom_field)`
/// for determinism.
pub fn detect_field_collisions(
    plates: &[Plate],
    grid: &Grid,
    fields: &[Field],
) -> Vec<FieldCollision> {
    detect_field_collisions_opt(plates, grid, fields, /*optimize=*/ false)
}

/// Like [`detect_field_collisions`] but, when `optimize=true`, restricts
/// iteration to fields whose `boundary` or `colliding` flag is set, plus
/// their direct neighbours. Mirrors TE `Model.detectCollisions(optimize)`
/// (`model.ts:325-374`).
///
/// The orchestrator is expected to call this with `optimize=true` after the
/// first step, having marked `field.boundary` / `field.colliding` from the
/// prior step's results.
pub fn detect_field_collisions_opt(
    plates: &[Plate],
    grid: &Grid,
    fields: &[Field],
    optimize: bool,
) -> Vec<FieldCollision> {
    let mut out: Vec<FieldCollision> = Vec::new();

    // Density-sorted plate references, matching TE `model.plates` (sorted
    // ASC by density — model.ts:269 + the order_by_density tie-break we
    // already use here). The "lower" plates (index > self) are the ones
    // that subduct beneath self; "upper" plates (index < self) ride over.
    let mut plate_order: Vec<&Plate> = plates.iter().collect();
    plate_order.sort_by(|a, b| {
        a.density
            .partial_cmp(&b.density)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.id.cmp(&b.id))
    });

    // Build the `fields_possibly_colliding` set per TE `model.ts:325-341`.
    // We track a bitset over field ids per plate; if !optimize, every owned
    // field is included.
    for (plate_idx, plate) in plate_order.iter().enumerate() {
        // Iterate owned fields. For optimize mode, also include any
        // neighbour of a `boundary || colliding` owned field.
        let mut considered: Vec<u32> = Vec::with_capacity(plate.fields.len());
        if optimize {
            let mut seen = std::collections::BTreeSet::<u32>::new();
            for &fid in &plate.fields {
                let Some(f) = fields.get(fid as usize) else {
                    continue;
                };
                if f.boundary || f.colliding {
                    if seen.insert(fid) {
                        considered.push(fid);
                    }
                    for &n in grid.neighbours(fid) {
                        if plate.contains_field(n) && seen.insert(n) {
                            considered.push(n);
                        }
                    }
                }
            }
            considered.sort_unstable();
        } else {
            considered.extend(plate.fields.iter().copied());
        }

        for field_id in considered {
            let Some(field) = fields.get(field_id as usize) else {
                continue;
            };
            let world = plate.compute_field_position(field.local_pos);
            // Density-stratified inner loop: walk outwards in density-order
            // pairs (idx + i / idx - i) and stop on the first hit. Mirrors
            // `model.ts:354-372`.
            let mut i: usize = 1;
            let total = plate_order.len();
            loop {
                let lower_idx = plate_idx.checked_add(i).filter(|&x| x < total);
                let upper_idx = plate_idx.checked_sub(i);
                if lower_idx.is_none() && upper_idx.is_none() {
                    break;
                }
                // Lower plate first (denser ⇒ subducts under self).
                if let Some(li) = lower_idx {
                    let lower_plate = plate_order[li];
                    let lower_local = lower_plate.local_position(world);
                    let lower_field_id = grid.nearest_field(lower_local);
                    if lower_plate.contains_field(lower_field_id) {
                        let Some(lower_state) = fields.get(lower_field_id as usize) else {
                            i += 1;
                            continue;
                        };
                        let kind = classify_collision(lower_state, field);
                        out.push(FieldCollision {
                            bottom_field: lower_field_id,
                            bottom_plate: lower_plate.id,
                            top_field: field_id,
                            top_plate: plate.id,
                            contact_pos: world,
                            kind,
                        });
                        break;
                    }
                }
                // Upper plate (less dense ⇒ self subducts under it).
                if let Some(ui) = upper_idx {
                    let upper_plate = plate_order[ui];
                    let upper_local = upper_plate.local_position(world);
                    let upper_field_id = grid.nearest_field(upper_local);
                    if upper_plate.contains_field(upper_field_id) {
                        let Some(upper_state) = fields.get(upper_field_id as usize) else {
                            i += 1;
                            continue;
                        };
                        let kind = classify_collision(field, upper_state);
                        out.push(FieldCollision {
                            bottom_field: field_id,
                            bottom_plate: plate.id,
                            top_field: upper_field_id,
                            top_plate: upper_plate.id,
                            contact_pos: world,
                            kind,
                        });
                        break;
                    }
                }
                i += 1;
            }
        }
    }

    // Deduplicate collisions emitted from both sides — keep the canonical
    // `(bottom_plate, bottom_field, top_plate, top_field)` first occurrence.
    out.sort_by_key(|c| (c.bottom_plate, c.bottom_field, c.top_plate, c.top_field));
    out.dedup_by_key(|c| (c.bottom_plate, c.bottom_field, c.top_plate, c.top_field));
    out
}

/// Classify the collision into one of TE's four branches in
/// `fieldsCollision`.
fn classify_collision(bottom: &Field, top: &Field) -> CollisionKind {
    let bottom_can_subduct = bottom.is_oceanic_crust();
    let top_can_subduct = top.is_oceanic_crust();
    if bottom_can_subduct {
        // Subduction. (Continent-buffer drag is applied during resolution
        // — see TE `fields-collision.ts:41-46`.)
        CollisionKind::Subduction
    } else if !top_can_subduct {
        // Both continental ⇒ orogeny.
        CollisionKind::Orogeny
    } else if top.is_continent_buffer {
        // Continents are next to each other; killing the ocean field lets
        // them collide next step. TE `fields-collision.ts:50-52`.
        CollisionKind::KillBottomOcean
    } else {
        // Continent trying to subduct under an ocean — apply drag forces.
        // TE `fields-collision.ts:53-56`.
        CollisionKind::DragOnly
    }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// Apply a single collision to the field state. Port of TE
/// `fieldsCollision` (`fields-collision.ts:35-58`).
///
/// Returns true if a state mutation actually happened.
pub fn resolve_field_collision(
    collision: &FieldCollision,
    plates: &[Plate],
    fields: &mut [Field],
) -> bool {
    // Resolve plate references (immutable handles to plate state).
    let bottom_plate = plates.iter().find(|p| p.id == collision.bottom_plate);
    let top_plate = plates.iter().find(|p| p.id == collision.top_plate);
    let (Some(bottom_plate), Some(top_plate)) = (bottom_plate, top_plate) else {
        return false;
    };

    // Compute linear velocities at the contact for the rel-velocity term.
    // (Used by the Subduction / Orogeny branches; KillBottomOcean and
    // DragOnly do not need them.)
    let bottom_v = bottom_plate.linear_velocity(collision.contact_pos);
    let top_v = top_plate.linear_velocity(collision.contact_pos);

    match collision.kind {
        CollisionKind::Subduction => {
            // Snapshot the bottom field's age and continent-buffer flag
            // before mutably borrowing.
            let (age, bottom_is_buffer) = fields
                .get(collision.bottom_field as usize)
                .map(|f| (f.age, f.is_continent_buffer))
                .unwrap_or((0.0, false));
            // Snapshot the top field's relevant flags too.
            let (top_continental, top_is_buffer) = fields
                .get(collision.top_field as usize)
                .map(|f| (f.is_continent_crust(), f.is_continent_buffer))
                .unwrap_or((false, false));
            let Some(bottom) = fields.get_mut(collision.bottom_field as usize) else {
                return false;
            };
            bottom.colliding = true;
            if bottom.subduction.is_none() {
                bottom.subduction = Some(Subduction::start(age));
            }
            if let Some(s) = bottom.subduction.as_mut() {
                s.set_collision(collision.top_plate, bottom_v, top_v);
            }
            // Continent-buffer drag sub-case — TE `fields-collision.ts:41-46`.
            // When the bottom is a continent buffer and the top is neither
            // continental nor a buffer, the continent is "trying" to
            // subduct under the ocean; apply drag on both sides to stop the
            // motion. (Until Phase 2 populates `is_continent_buffer`, this
            // branch is unreachable in practice.)
            if bottom_is_buffer && !top_continental && !top_is_buffer {
                bottom.set_dragging_plate(collision.top_plate);
                if let Some(top) = fields.get_mut(collision.top_field as usize) {
                    top.set_dragging_plate(collision.bottom_plate);
                    top.colliding = true;
                }
            } else if let Some(top) = fields.get_mut(collision.top_field as usize) {
                top.colliding = true;
            }
            true
        }
        CollisionKind::Orogeny => {
            let age = fields
                .get(collision.bottom_field as usize)
                .map(|f| f.age)
                .unwrap_or(0.0);
            // Apply drag forces (TE `orogeny` calls `applyDragForces` first,
            // `fields-collision.ts:28`).
            if let Some(top) = fields.get_mut(collision.top_field as usize) {
                top.set_dragging_plate(collision.bottom_plate);
                top.colliding = true;
                top.orogenic_uplift = 1.0;
            }
            let Some(bottom) = fields.get_mut(collision.bottom_field as usize) else {
                return false;
            };
            bottom.set_dragging_plate(collision.top_plate);
            bottom.colliding = true;
            bottom.orogenic_uplift = 1.0;
            if bottom.subduction.is_none() {
                bottom.subduction = Some(Subduction::start(age));
            }
            if let Some(s) = bottom.subduction.as_mut() {
                s.set_collision(collision.top_plate, bottom_v, top_v);
            }
            true
        }
        CollisionKind::KillBottomOcean => {
            // TE: `topField.alive = false`. We don't have an `alive` flag on
            // the Rust `Field` (the orchestrator removes the id from the
            // plate's `fields` list instead). Mark via a sentinel: clearing
            // crust.thickness to 0.
            //
            // This branch is not currently emitted by `classify_collision`
            // because `is_continent_buffer` isn't ported yet. The
            // implementation is here for completeness once Phase 2 lands.
            let Some(top) = fields.get_mut(collision.top_field as usize) else {
                return false;
            };
            top.crust.clear();
            true
        }
        CollisionKind::DragOnly => {
            // TE `applyDragForces` (fields-collision.ts:10-11): set both
            // fields' `draggingPlate` link to the other plate.
            if let Some(top) = fields.get_mut(collision.top_field as usize) {
                top.set_dragging_plate(collision.bottom_plate);
                top.colliding = true;
            }
            if let Some(bottom) = fields.get_mut(collision.bottom_field as usize) {
                bottom.set_dragging_plate(collision.top_plate);
                bottom.colliding = true;
            }
            true
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::{Crust, Field};
    use crate::plate::Plate;
    use crate::sphere::Grid;

    fn small_grid() -> Grid {
        // Tiny sphere is enough for these synthetic tests.
        Grid::new(2)
    }

    /// Build a plate at identity-orientation that owns the field with the
    /// given grid id. The field state slice is sized to `grid.n_fields()`.
    fn plate_owning(id: u32, density: f32, fid: u32, _grid: &Grid) -> (Plate, u32) {
        let mut p = Plate::new(id, 0, density);
        p.add_field(fid);
        (p, fid)
    }

    fn fresh_fields(grid: &Grid) -> Vec<Field> {
        (0..grid.n_fields())
            .map(|i| Field::new(i, grid.position(i)))
            .collect()
    }

    #[test]
    fn no_collisions_when_plates_dont_overlap() {
        let grid = small_grid();
        let fields = fresh_fields(&grid);
        // Two plates, each owning a single distinct field id; at identity
        // orientation those fields are at distinct world positions ⇒ no
        // overlap.
        let (a, _) = plate_owning(0, 1.0, 0, &grid);
        let (b, _) = plate_owning(1, 1.0, 10, &grid);
        let collisions = detect_field_collisions(&[a, b], &grid, &fields);
        assert!(collisions.is_empty(), "got: {:?}", collisions);
    }

    #[test]
    fn collisions_detected_when_plates_overlap() {
        let grid = small_grid();
        let fields = fresh_fields(&grid);
        // Both plates own the SAME grid field — guaranteed overlap.
        let (a, _) = plate_owning(0, 1.0, 5, &grid);
        let (b, _) = plate_owning(1, 1.0, 5, &grid);
        let collisions = detect_field_collisions(&[a, b], &grid, &fields);
        assert!(!collisions.is_empty());
        let c = &collisions[0];
        assert_eq!(c.bottom_field, 5);
        assert_eq!(c.top_field, 5);
    }

    /// END-TO-END REGRESSION for issue #6 (no orogeny under play). The
    /// scenario: full Model with two continental plates + non-zero omega
    /// on plate B, step for many ticks, assert that at least one cell
    /// reports orogenic_uplift > 0 AND elevation grew. Pre-fix this was
    /// 0 across the board (the optimize-after-step-1 short-circuit kept
    /// the detector blind to subsequent collisions).
    #[test]
    fn orogeny_actually_fires_when_continents_collide() {
        use crate::model::Model;

        let mut m = Model::new(4, 7); // ~162 cells, plenty for a 2-plate test
        let n = m.grid.n_fields();

        // Carve two continental plates from the partition: A = northern
        // hemisphere (Y > 0), B = southern (Y <= 0). Continental crust so
        // collisions trigger Orogeny branch.
        let mut a_ids = Vec::new();
        let mut b_ids = Vec::new();
        for fid in 0..n {
            let p = m.grid.position(fid);
            m.fields[fid as usize].crust = crate::field::Crust::new_continental();
            m.fields[fid as usize].become_continental_lithosphere(200.0);
            m.fields[fid as usize].elevation = 0.1;
            if p.y > 0.0 {
                a_ids.push(fid);
            } else {
                b_ids.push(fid);
            }
        }

        // Give plate B a non-zero omega around X so it rotates the southern
        // continent into the northern continent over many sim steps. omega
        // magnitude tuned so cells sweep ~one cell-diameter per step.
        m.add_plate(0, 0, 3.0, &a_ids, true, Vec3::ZERO);
        m.add_plate(
            1, 1, 3.0, &b_ids, true,
            Vec3::new(0.02, 0.0, 0.0),
        );

        // Snapshot pre-step max elevation.
        let pre_max: f32 = m.fields.iter().map(|f| f.elevation).fold(0.0, f32::max);

        // Step the model. With omega=0.02 around X, plate B rotates at
        // 0.02 rad/Ma. After dt=1, 50 steps = 1 rad = ~57° rotation —
        // plenty to push southern cells into the northern plate.
        for _ in 0..50 {
            m.step(1.0);
        }

        // Verify collisions fired AND orogeny ran.
        let n_colliding = m.fields.iter().filter(|f| f.colliding).count();
        let n_orog = m.fields.iter().filter(|f| f.orogenic_uplift > 0.0).count();
        let post_max: f32 = m.fields.iter().map(|f| f.elevation).fold(0.0, f32::max);

        assert!(
            n_colliding > 0,
            "after 50 steps with non-zero plate B omega, expected colliding cells > 0 (got 0); \
             this means the optimize-mode short-circuit is still blocking collision detection",
        );
        assert!(
            n_orog > 0,
            "expected orogenic_uplift to be set on at least one cell (got 0)",
        );
        assert!(
            post_max > pre_max + 0.01,
            "expected max elevation to grow by > 0.01 from orogeny (pre={}, post={}); \
             this means orogeny → elevation conversion is not lifting cells",
            pre_max, post_max,
        );
    }

    /// REGRESSION TEST FOR PRODUCTION TOPOLOGY: when plates fully partition
    /// the sphere (every cell owned by exactly one plate, no overlap) and
    /// then rotate by ~180° relative to each other, do collisions fire?
    ///
    /// This is the case the wizard produces — plates collectively cover
    /// the sphere via voronoi assignment, then drift via integrated
    /// angular velocity. The 2026-05-21 sim playtest showed ZERO
    /// collisions detected over 630 Ma at this topology; this test
    /// reproduces that scenario at small scale.
    #[test]
    fn collisions_fire_under_180deg_rotation_with_partitioned_plates() {
        use glam::Quat;
        let grid = small_grid();
        let mut fields = fresh_fields(&grid);
        let n = grid.n_fields();

        // Two plates partition the sphere: A owns first half, B owns
        // second half. Every cell is owned by exactly one plate — the
        // realistic case.
        let mut a = Plate::new(0, 0, 3.0);
        let mut b = Plate::new(1, 0, 3.0);
        for fid in 0..n {
            if fid % 2 == 0 {
                a.add_field(fid);
                fields[fid as usize].plate_id = Some(0);
            } else {
                b.add_field(fid);
                fields[fid as usize].plate_id = Some(1);
            }
        }
        // Pre-rotation, all cells of A live at world positions of plate-A
        // cells; B at B's. Plate A and B own DIFFERENT field ids, so a
        // straight collision check at identity finds nothing (as for the
        // wizard's initial state).
        let before = detect_field_collisions(
            &[a.clone(), b.clone()], &grid, &fields,
        );
        assert!(
            before.is_empty(),
            "at identity, partitioned plates own disjoint cells → expected 0 collisions, got {}",
            before.len(),
        );

        // Rotate plate B by 180° around the Y axis. Now B's cells (in
        // world space) land where A's cells used to be — every B cell at
        // world W means there's an A cell at world W too. So detection
        // should find LOTS of collisions.
        b.quaternion = Quat::from_axis_angle(Vec3::Y, std::f32::consts::PI);

        let after = detect_field_collisions(&[a, b], &grid, &fields);
        assert!(
            !after.is_empty(),
            "after 180° rotation of plate B around Y, collisions MUST be \
             detected — every B cell now occupies A territory in world \
             space, got {} (this means detect_field_collisions is broken \
             for the realistic partitioned-plate topology)",
            after.len(),
        );
        // Sanity: at least 10% of cells should be flagged at full 180°.
        assert!(
            after.len() > (n / 10) as usize,
            "expected hundreds of collisions at 180°, got only {}",
            after.len(),
        );
    }

    #[test]
    fn oceanic_subducts_under_continental() {
        // Bottom plate denser (oceanic = 3.3); top plate less dense (continental = 2.8).
        // Wait — TE convention is the OPPOSITE for the mass-modifier density
        // constants (ocean=1, continent=3). But Plate.density is a separate
        // value used purely for the "who sinks" ordering — TE's preset code
        // assigns higher density to oceanic plates so they subduct.
        //
        // Our `order_by_density` follows that convention. So the oceanic
        // plate gets the higher density value and ends up as `bottom`.
        let grid = small_grid();
        let mut fields = fresh_fields(&grid);
        // Mark field 0 as oceanic, field 7 as continental.
        fields[0].crust = Crust::new_oceanic();
        fields[7].crust = Crust::new_continental();
        let mut oceanic = Plate::new(0, 0, /*density=*/ 3.3);
        oceanic.add_field(0);
        let mut continental = Plate::new(1, 0, /*density=*/ 2.8);
        continental.add_field(0); // both own field 0 ⇒ collision

        let collisions = detect_field_collisions(&[oceanic, continental.clone()], &grid, &fields);
        assert_eq!(collisions.len(), 1, "got: {:?}", collisions);
        let c = &collisions[0];
        assert_eq!(c.bottom_plate, 0, "denser (oceanic) plate should be bottom");
        assert_eq!(c.top_plate, 1);
        assert_eq!(c.kind, CollisionKind::Subduction);

        // Resolve: bottom field's Subduction record should be populated.
        let plates = vec![Plate::new(0, 0, 3.3), continental];
        // Refresh plate references with their fields list.
        let mut plates = plates;
        plates[0].add_field(0);
        let _ = resolve_field_collision(c, &plates, &mut fields);
        let bf = &fields[0];
        assert!(bf.subduction.is_some());
        let s = bf.subduction.as_ref().unwrap();
        assert_eq!(s.top_plate, Some(1));
    }

    #[test]
    fn subduction_completes_after_full_progress_via_resolve() {
        // Set up a single collision and tick subduction to completion via
        // direct Subduction::update calls (full integration with the model
        // arrives later — this only exercises the resolution wiring).
        let grid = small_grid();
        let mut fields = fresh_fields(&grid);
        fields[0].crust = Crust::new_oceanic();
        let mut bottom = Plate::new(0, 0, 3.3);
        bottom.add_field(0);
        bottom.angular_velocity = Vec3::X * 0.1;
        let mut top = Plate::new(1, 0, 2.8);
        top.add_field(0);
        let plates = vec![bottom, top];
        let collisions = detect_field_collisions(&plates, &grid, &fields);
        assert_eq!(collisions.len(), 1);
        let _ = resolve_field_collision(&collisions[0], &plates, &mut fields);
        // Advance many steps with a huge artificial relative velocity until
        // dist saturates.
        let f = &mut fields[0];
        let s = f.subduction.as_mut().unwrap();
        s.set_collision(1, Vec3::X * 100.0, Vec3::ZERO);
        for _ in 0..200 {
            s.update(0.1, s.dist, grid.field_diameter());
        }
        // The clamp `min_neighbour + field_diameter` allows growth one
        // field-diameter per step, eventually exceeding MAX_SUBDUCTION_DIST.
        assert!(s.is_complete() || s.progress() > 0.5);
    }

    #[test]
    fn orogeny_collision_marks_both_fields_with_uplift() {
        // Two continental fields on different plates both owning the same
        // grid field ⇒ Orogeny collision. After resolution, both fields
        // must have orogenic_uplift == 1.0.
        let grid = small_grid();
        let mut fields = fresh_fields(&grid);
        // Make field 5 continental on both plates ⇒ classify_collision
        // will pick Orogeny (both non-oceanic).
        fields[5].crust = Crust::new_continental();

        let (mut bottom_plate, _) = plate_owning(0, /*density=*/ 3.0, 5, &grid);
        let (mut top_plate, _)    = plate_owning(1, /*density=*/ 2.0, 5, &grid);

        // Ensure the field is also marked continental on the top plate's copy
        // (fresh_fields gives oceanic defaults — we mutated index 5 above,
        // which is shared across the slice).
        bottom_plate.update_inertia_tensor(&fields, grid.field_area_km2());
        top_plate.update_inertia_tensor(&fields, grid.field_area_km2());

        let collisions = detect_field_collisions(&[bottom_plate.clone(), top_plate.clone()], &grid, &fields);
        assert!(!collisions.is_empty(), "expected at least one collision");
        let c = collisions.iter().find(|c| c.kind == CollisionKind::Orogeny)
            .expect("expected an Orogeny collision");

        let plates = vec![bottom_plate, top_plate];
        resolve_field_collision(c, &plates, &mut fields);

        assert_eq!(
            fields[c.bottom_field as usize].orogenic_uplift, 1.0,
            "bottom field must have orogenic_uplift == 1.0 after orogeny"
        );
        assert_eq!(
            fields[c.top_field as usize].orogenic_uplift, 1.0,
            "top field must have orogenic_uplift == 1.0 after orogeny"
        );
    }

    #[test]
    fn determinism_collision_detection_is_stable() {
        let grid = small_grid();
        let fields = fresh_fields(&grid);
        let mut a = Plate::new(0, 0, 1.0);
        a.add_field(5);
        let mut b = Plate::new(1, 0, 1.0);
        b.add_field(5);
        let r1 = detect_field_collisions(&[a.clone(), b.clone()], &grid, &fields);
        let r2 = detect_field_collisions(&[a, b], &grid, &fields);
        assert_eq!(
            bincode::serialize(&r1).unwrap(),
            bincode::serialize(&r2).unwrap()
        );
    }
}
