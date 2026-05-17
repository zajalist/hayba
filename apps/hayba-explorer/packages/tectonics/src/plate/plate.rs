//! Single plate: rotation axis, angular velocity, Verlet integration.
//!
//! Port target: tectonic-explorer's `src/plates-model/plate.ts` (+ `plate-base.ts`,
//! `physics/helpers.ts`, `physics/verlet-integrator.ts`, `physics/forces.ts`).
//! Frozen reference: `docs/research/te-snapshot/plates-model/plate.ts`.
//!
//! ## TE → Rust mapping
//!
//! * TS `Plate` extends `PlateBase`. We flatten into a single Rust `Plate`.
//! * TS uses `THREE.Quaternion` / `THREE.Vector3`. We use `glam::Quat`,
//!   `glam::Vec3`.
//! * TS stores fields in `Map<number, Field>`; Rust stores `Vec<u32>` of owned
//!   field ids and looks the field state up in a separate `&[Field]` array. This
//!   keeps the per-plate struct small and avoids back-references for the
//!   borrow checker. Iteration is `id`-sorted for determinism (TE explicitly
//!   sorts in `Plate.sortFields` for the same reason — see `plate.ts:381-388`).
//! * TS `Plate.totalTorque` walks fields and pulls per-field torque from
//!   `Field.torque`. In Rust the caller passes precomputed per-field forces
//!   (the field doesn't carry a back-reference to its plate), so the torque
//!   computation lives in [`Plate::compute_total_torque`].
//! * TS uses `THREE.Matrix3` for inertia; we use `glam::Mat3` (column-major,
//!   same math, deterministic).
//!
//! ## Verlet integration
//!
//! Faithful port of `physics/verlet-integrator.ts` for a single plate (the TE
//! version operates over the whole model). The single-plate step is the same
//! modified velocity-Verlet algorithm:
//!
//! ```text
//!     v_half = v + a * dt/2
//!     q'     = integrate_rotation(q, v_half, dt)
//!     v'     = v + a * dt          (provisional new velocity)
//!     a'     = forces / inertia    (caller supplies via Forces)
//!     v'     = v' + (a' - a) * dt/2
//! ```
//!
//! The rotation integration matches `integrateRotationQuaternion` in
//! `physics/helpers.ts`:
//!
//! ```text
//!     dq = 0.5 * (w_quat * dt * q)
//!     q' = normalize(q + dq)
//! ```
//!
//! For deterministic builds we never call `Quat::from_xyzw` with random data;
//! every operation is a pure function of the prior state.

use glam::{Mat3, Quat, Vec3};
use serde::{Deserialize, Serialize};

use crate::field::Field;

// ---------------------------------------------------------------------------
// TE constants (from `src-root/config.ts` and `src-root/constants.ts`)
// ---------------------------------------------------------------------------

/// TE `config.oceanDensity` (note the perhaps counter-intuitive naming —
/// in TE the *lower* number is oceanic and the *higher* is continental, and
/// this density value is used as a mass scaling for the inertia tensor, NOT
/// for "which sinks under which" — that decision is made by
/// `Crust::canSubduct`).
pub const OCEAN_DENSITY: f32 = 1.0;
/// TE `config.continentDensity`.
pub const CONTINENT_DENSITY: f32 = 3.0;

/// TE `MASS_MODIFIER` from `plates-model/field.ts:80`.
pub const MASS_MODIFIER: f32 = 0.000_005;

/// TE `config.userForce` from `src-root/config.ts:146`.
pub const USER_FORCE: f32 = 10.0;
/// TE `config.friction` from `src-root/config.ts:150`.
pub const FRICTION: f32 = 8.0;
/// TE `config.orogenyStrength` from `src-root/config.ts:152`.
pub const OROGENY_STRENGTH: f32 = 0.5;
/// TE `config.constantHotSpots` (defaulted to `false` in `src-root/config.ts:91`).
pub const CONSTANT_HOT_SPOTS: bool = false;

/// TE `HOT_SPOT_TORQUE_DECREASE` from `plates-model/plate.ts:11`. Mirrors the
/// formula `constantHotSpots ? 0 : 0.2 * userForce`.
pub const HOT_SPOT_TORQUE_DECREASE: f32 = if CONSTANT_HOT_SPOTS {
    0.0
} else {
    0.2 * USER_FORCE
};

/// TE `BASIC_DRAG_FORCE_MOD` from `physics/forces.ts:5`. Matches
/// `0.000001 * config.friction`.
pub const BASIC_DRAG_FORCE_MOD: f32 = 0.000_001 * FRICTION;

/// TE `OROGENY_FORCE_MOD` from `physics/forces.ts:7`. Matches
/// `BASIC_DRAG_FORCE_MOD / config.orogenyStrength`.
pub const OROGENY_FORCE_MOD: f32 = BASIC_DRAG_FORCE_MOD / OROGENY_STRENGTH;

/// TE `MIN_PLATE_SIZE` from `plates-model/plate.ts:12` (in km²).
pub const MIN_PLATE_SIZE_KM2: f32 = 100_000.0;

// ---------------------------------------------------------------------------
// Hot spot / subplate placeholders (Phase 4 ports)
// ---------------------------------------------------------------------------

/// Force / position pair attached to a plate (port of TE
/// `Plate.hotSpot`, `plates-model/plate.ts:63-66`).
///
/// Phase 1 ports only the data shape and the `updateHotSpot` decay rule from
/// TE; full plate-bending dynamics arrive in Phase 4.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct HotSpot {
    pub position: Vec3,
    pub force: Vec3,
}

impl HotSpot {
    pub fn new(position: Vec3, force: Vec3) -> Self {
        Self { position, force }
    }
}

/// Container for fields detached from a parent plate (subducted, accreted).
/// Port of TE `Subplate` (`plates-model/subplate.ts`).
///
/// Phase 1 ports the data shape only. Dynamics arrive in Phase 4.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SubPlate {
    /// Field ids attached as "ghost" fields (TE: `subplate.fields`).
    pub fields: Vec<u32>,
}

// ---------------------------------------------------------------------------
// Forces struct (caller-supplied per-plate net force/torque overrides)
// ---------------------------------------------------------------------------

/// Caller-supplied force inputs for a Verlet step.
///
/// TE computes per-field forces from `Field.force` (basic drag + orogenic
/// drag) and sums their cross-products with `absolutePos` to get a total
/// torque (`plate.ts:141-147`). We expose this as a precomputed structure so
/// callers (or the orchestrator) can stage forces from multiple physics
/// passes without re-iterating fields inside `update_motion`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Forces {
    /// External torque applied to the plate this step (already summed; this
    /// is the equivalent of TE's `totalTorque` after collecting field
    /// contributions). Zero by default.
    pub external_torque: Vec3,
}

impl Forces {
    pub fn new(external_torque: Vec3) -> Self {
        Self { external_torque }
    }
}

// ---------------------------------------------------------------------------
// Plate
// ---------------------------------------------------------------------------

/// Tectonic plate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plate {
    pub id: u32,
    /// RGB color used by the viewer (TE keeps a `hue`; we keep RGB so the
    /// renderer doesn't have to know the TE-specific palette).
    pub color: u32,
    /// TE `Plate.density`. See note on `OCEAN_DENSITY`/`CONTINENT_DENSITY`.
    pub density: f32,
    pub mass: f32,
    pub moment_of_inertia: Mat3,
    pub inv_moment_of_inertia: Mat3,
    /// Orientation (TE `Plate.quaternion`).
    pub quaternion: Quat,
    /// Body-frame angular velocity. TE `Plate.angularVelocity`. Lives in
    /// world axes (Euler pole).
    pub angular_velocity: Vec3,
    /// Cached current angular acceleration, used by Verlet. Computed from
    /// last applied `Forces.external_torque`.
    pub angular_acceleration: Vec3,
    /// Previous angular acceleration, for the Verlet correction step.
    pub prev_angular_acceleration: Vec3,
    /// Optional geographic center in world coords (TE `Plate.center`).
    pub center: Option<Vec3>,
    pub hot_spot: HotSpot,
    /// Hayba Phase 3 — auxiliary plume-anchor list mirroring the
    /// [`crate::mantle::PlumeRegistry`] plumes that currently lie
    /// underneath this plate. Each entry is a `position + force` pair
    /// matching the TE `HotSpot` shape (reused as the data shape, not
    /// the concept — TE's `Plate.hotSpot` is the singular bending hot
    /// spot tracked in `hot_spot` above). Updaters that own the plume
    /// registry refresh the list once per step (after the plume step
    /// and before torque accumulation). Empty until a plume is wired in.
    #[serde(default, alias = "hot_spots")]
    pub plume_anchors: Vec<HotSpot>,
    /// Field ids owned by this plate, kept sorted for determinism. Matches
    /// TE `Plate.sortFields` (`plate.ts:381-388`).
    pub fields: Vec<u32>,
    pub subplate: SubPlate,
    /// Optional `PlateGroup` id (TE `Plate.plateGroup`).
    pub group: Option<u32>,
    /// Accumulator for cross-plate / orchestrator-injected torques applied
    /// via [`Plate::apply_force`]. Reset to zero at the start of each motion
    /// step by the orchestrator (`reset_force_accumulator`). Distinct from
    /// the hot-spot pathway, which is reserved for genuine `setHotSpot`
    /// inputs (TE `plate.ts:236-238`).
    #[serde(default)]
    pub force_accumulator: Vec3,
}

impl Plate {
    pub fn new(id: u32, color: u32, density: f32) -> Self {
        Self {
            id,
            color,
            density,
            mass: 0.0,
            moment_of_inertia: Mat3::ZERO,
            inv_moment_of_inertia: Mat3::ZERO,
            quaternion: Quat::IDENTITY,
            angular_velocity: Vec3::ZERO,
            angular_acceleration: Vec3::ZERO,
            prev_angular_acceleration: Vec3::ZERO,
            center: None,
            hot_spot: HotSpot::default(),
            plume_anchors: Vec::new(),
            fields: Vec::new(),
            subplate: SubPlate::default(),
            group: None,
            force_accumulator: Vec3::ZERO,
        }
    }

    /// Inverse moment-of-inertia accessor. Falls back to identity when mass
    /// hasn't been set, so unit tests that don't initialise the inertia tensor
    /// can still produce sensible torque-to-acceleration math.
    #[inline]
    pub fn inv_moment_of_inertia(&self) -> Mat3 {
        if self.mass > 0.0 {
            self.inv_moment_of_inertia
        } else {
            Mat3::IDENTITY
        }
    }

    /// Reset the force accumulator. Called by the orchestrator at the start
    /// of each motion step before re-applying cross-plate forces.
    #[inline]
    pub fn reset_force_accumulator(&mut self) {
        self.force_accumulator = Vec3::ZERO;
    }

    // -----------------------------------------------------------------
    // Field membership
    // -----------------------------------------------------------------

    /// Add a field id (TE `Plate.addExistingField`). Maintains sort order.
    pub fn add_field(&mut self, field_id: u32) {
        match self.fields.binary_search(&field_id) {
            Ok(_) => {} // already present, idempotent
            Err(idx) => self.fields.insert(idx, field_id),
        }
    }

    /// Remove a field id (TE `Plate.deleteField`). No-op if not present.
    pub fn remove_field(&mut self, field_id: u32) -> bool {
        if let Ok(idx) = self.fields.binary_search(&field_id) {
            self.fields.remove(idx);
            true
        } else {
            false
        }
    }

    pub fn contains_field(&self, field_id: u32) -> bool {
        self.fields.binary_search(&field_id).is_ok()
    }

    /// TE `Plate.isActive` — has any owned fields.
    pub fn is_active(&self) -> bool {
        !self.fields.is_empty()
    }

    /// TE `PlateBase.size`.
    pub fn size(&self) -> usize {
        self.fields.len()
    }

    // -----------------------------------------------------------------
    // Geometry helpers — port of `PlateBase`.
    // -----------------------------------------------------------------

    /// TE `PlateBase.absolutePosition` — rotates a field's local position
    /// by the plate quaternion.
    pub fn compute_field_position(&self, local_pos: Vec3) -> Vec3 {
        self.quaternion * local_pos
    }

    /// TE `PlateBase.localPosition`.
    pub fn local_position(&self, absolute_pos: Vec3) -> Vec3 {
        self.quaternion.conjugate() * absolute_pos
    }

    /// TE `PlateBase.linearVelocity`.
    pub fn linear_velocity(&self, absolute_pos: Vec3) -> Vec3 {
        self.angular_velocity.cross(absolute_pos)
    }

    /// TE `PlateBase.angularSpeed`.
    pub fn angular_speed(&self) -> f32 {
        self.angular_velocity.length()
    }

    /// TE `PlateBase.axisOfRotation` (Euler pole).
    pub fn axis_of_rotation(&self) -> Vec3 {
        if self.angular_speed() == 0.0 {
            Vec3::X
        } else {
            self.angular_velocity.normalize()
        }
    }

    // -----------------------------------------------------------------
    // Mass + inertia tensor — port of `Plate.updateInertiaTensor`.
    // -----------------------------------------------------------------

    /// Recompute mass / moment-of-inertia from owned fields.
    /// Matches TE `Plate.updateInertiaTensor` (`plate.ts:204-227`).
    pub fn update_inertia_tensor(&mut self, fields: &[Field], field_area_km2: f32) {
        let mut mass: f32 = 0.0;
        let (mut ixx, mut iyy, mut izz) = (0.0f32, 0.0f32, 0.0f32);
        let (mut ixy, mut ixz, mut iyz) = (0.0f32, 0.0f32, 0.0f32);
        // Iterate `self.fields` (sorted asc by id) — deterministic.
        for &fid in &self.fields {
            let Some(f) = fields.get(fid as usize) else {
                continue;
            };
            let p = self.compute_field_position(f.local_pos);
            let density = if f.is_continent_crust() {
                CONTINENT_DENSITY
            } else {
                OCEAN_DENSITY
            };
            let m = MASS_MODIFIER * field_area_km2 * density;
            ixx += m * (p.y * p.y + p.z * p.z);
            iyy += m * (p.x * p.x + p.z * p.z);
            izz += m * (p.x * p.x + p.y * p.y);
            ixy -= m * p.x * p.y;
            ixz -= m * p.x * p.z;
            iyz -= m * p.y * p.z;
            mass += m;
        }
        self.mass = mass;
        // glam::Mat3 is column-major. Inertia tensor is symmetric, so layout
        // is the same either way.
        self.moment_of_inertia = Mat3::from_cols(
            Vec3::new(ixx, ixy, ixz),
            Vec3::new(ixy, iyy, iyz),
            Vec3::new(ixz, iyz, izz),
        );
        self.inv_moment_of_inertia = if mass > 0.0 {
            self.moment_of_inertia.inverse()
        } else {
            Mat3::ZERO
        };
    }

    // -----------------------------------------------------------------
    // Force / torque application — port of `Field.force` + `Plate.totalTorque`.
    // -----------------------------------------------------------------

    /// TE `basicDrag` (`physics/forces.ts:10`).
    ///
    /// `field_area_km2` should match `grid.field_area_km2()` (TE `field.area`).
    pub fn basic_drag(&self, absolute_pos: Vec3, field_area_km2: f32) -> Vec3 {
        let k = (if CONSTANT_HOT_SPOTS { -0.15 } else { -0.0005 })
            * field_area_km2
            * BASIC_DRAG_FORCE_MOD;
        self.linear_velocity(absolute_pos) * k
    }

    /// Compute the sum of `field.absolutePos × field.force` across all owned
    /// fields, plus the hot-spot contribution and the cross-plate force
    /// accumulator. Matches TE `Plate.totalTorque` (`plate.ts:141-147`) where
    /// `field.force = basicDrag + orogenicDrag` (`field.ts:219-225`).
    ///
    /// `other_plates` must contain (at least) every plate referenced by
    /// `field.dragging_plate` for owned fields; missing entries fall back to
    /// basic drag only (matching TE's permissive iteration).
    pub fn compute_total_torque(
        &self,
        fields: &[Field],
        other_plates: &[Plate],
        field_area_km2: f32,
    ) -> Vec3 {
        // Hot-spot torque term (TE `plate.ts:142`).
        let mut total = self.hot_spot.position.cross(self.hot_spot.force);
        // Cross-plate / orchestrator-staged torque accumulator. The
        // accumulator stores torques already in plate-local frame; we rotate
        // them back into world space so they compose with the field-pass
        // torque (which is computed in world space).
        total += self.quaternion * self.force_accumulator;
        for &fid in &self.fields {
            let Some(f) = fields.get(fid as usize) else {
                continue;
            };
            let abs = self.compute_field_position(f.local_pos);
            let v_self = self.linear_velocity(abs);
            // Basic drag — always present (TE `field.ts:220`).
            let mut force = f.basic_drag(v_self, field_area_km2, BASIC_DRAG_FORCE_MOD, CONSTANT_HOT_SPOTS);
            // Orogenic drag when this field is dragging another plate (TE
            // `field.ts:221-223`).
            if let Some(other_id) = f.dragging_plate {
                if let Some(other) = other_plates.iter().find(|p| p.id == other_id) {
                    let v_other = other.linear_velocity(abs);
                    force += f.orogenic_drag(
                        v_self,
                        v_other,
                        field_area_km2,
                        OROGENY_FORCE_MOD,
                        CONSTANT_HOT_SPOTS,
                    );
                }
            }
            total += abs.cross(force);
        }
        total
    }

    /// Apply an external force at a world-space position. Accumulates the
    /// resulting torque into `force_accumulator` (in plate-local frame) so
    /// the next `compute_total_torque` includes the contribution.
    ///
    /// Unlike the pre-fix version, this does NOT mutate `hot_spot`. The
    /// hot-spot pathway is reserved for genuine `setHotSpot`-style inputs
    /// (TE `plate.ts:236-238`).
    pub fn apply_force(&mut self, position: Vec3, force: Vec3) {
        let inv_q = self.quaternion.conjugate();
        let local_pos = inv_q * position;
        let local_force = inv_q * force;
        self.force_accumulator += local_pos.cross(local_force);
    }

    /// TE `Plate.updateHotSpot` (`plate.ts:229-234`). Decays the hot-spot
    /// force toward zero at rate `HOT_SPOT_TORQUE_DECREASE * dt`.
    pub fn update_hot_spot(&mut self, dt: f32) {
        let len = self.hot_spot.force.length();
        if len > 0.0 {
            let new_len = (len - dt * HOT_SPOT_TORQUE_DECREASE).max(0.0);
            self.hot_spot.force = if len > 0.0 {
                self.hot_spot.force * (new_len / len)
            } else {
                Vec3::ZERO
            };
        }
    }

    // -----------------------------------------------------------------
    // Verlet integration step.
    // -----------------------------------------------------------------

    /// Modified velocity-Verlet step. Faithful port of
    /// `physics/verlet-integrator.ts:11-30` specialised to a single plate.
    ///
    /// **Tests only.** Production stepping goes through `Model::step_verlet`
    /// which advances all plates' quaternions before evaluating a2 — the
    /// global a1/a2 fidelity contract. Calling this per-plate breaks that
    /// contract (a2 is evaluated against THIS plate's new state but other
    /// plates' OLD state), which is fine for kinematic unit tests but wrong
    /// for production.
    ///
    /// This version takes a `recompute_torque` closure that the caller uses
    /// to evaluate the new torque at the post-rotation state. This is
    /// required for fidelity to TE because `Plate.totalTorque` depends on
    /// `field.absolutePos` (which changes with the quaternion) and
    /// `field.linearVelocity` (which changes with `angularVelocity`).
    ///
    /// Callers that don't have a recompute path (e.g. tests asserting pure
    /// kinematics) can pass `|_| Vec3::ZERO`. For Euler-only behaviour use
    /// [`Plate::update_motion_euler`].
    #[doc(hidden)]
    #[deprecated(
        note = "Tests only. Use Model::step_verlet for production. Per-plate use breaks the global a1/a2 fidelity contract."
    )]
    pub fn update_motion_single_for_test(
        &mut self,
        dt: f32,
        torque_a1: Vec3,
        recompute_torque: impl FnOnce(&Plate) -> Vec3,
    ) {
        let v1 = self.angular_velocity;
        let q1 = self.quaternion;
        let a1 = self.acceleration_from_torque(torque_a1);

        // v_half = v + a * dt/2
        let v_half = update_angular_velocity(v1, a1, dt * 0.5);
        // q' = integrate_rotation(q, v_half, dt)
        let q2 = integrate_rotation_quaternion(q1, v_half, dt);
        // provisional v' = v + a * dt
        let v2_provisional = update_angular_velocity(v1, a1, dt);

        // Commit the post-half-step state so the recompute closure observes
        // the updated quaternion / velocity (matching TE's `setQuaternions`
        // + `setAngularVelocities` before `getAngularAccelerations`).
        self.quaternion = q2;
        self.angular_velocity = v2_provisional;

        // Re-evaluate the torque at the new state.
        let torque_a2 = recompute_torque(self);
        let a2 = self.acceleration_from_torque(torque_a2);

        // Apply the correction term: v += (a2 - a1) * dt/2.
        let a_diff = a2 - a1;
        self.angular_velocity = update_angular_velocity(v2_provisional, a_diff, dt * 0.5);
        self.prev_angular_acceleration = a1;
        self.angular_acceleration = a2;
        self.update_hot_spot(dt);
    }

    /// Cheap-test-fixture Verlet step that collapses the corrector
    /// (`a2 = a1`). Equivalent to symplectic Euler. Useful for unit tests
    /// that exercise pure kinematics without setting up a torque recompute.
    ///
    /// Deprecated for production use — prefer [`Plate::update_motion`] with
    /// a real recompute closure.
    #[deprecated(note = "Euler-only fallback for tests; use Model::step_verlet for production.")]
    pub fn update_motion_euler(&mut self, dt: f32, forces: &Forces) {
        let torque = forces.external_torque;
        #[allow(deprecated)]
        self.update_motion_single_for_test(dt, torque, |_| torque);
    }

    /// Apply inverse moment of inertia to a torque vector. If the inertia
    /// tensor hasn't been initialised (mass = 0) the torque is treated as a
    /// direct angular acceleration with unit inertia.
    fn acceleration_from_torque(&self, torque: Vec3) -> Vec3 {
        if self.mass > 0.0 {
            self.inv_moment_of_inertia * torque
        } else {
            torque
        }
    }
}

// ---------------------------------------------------------------------------
// Integration helpers — port of `physics/helpers.ts`.
// ---------------------------------------------------------------------------

/// Port of TE `updateAngularVelocity` (`physics/helpers.ts:5-7`).
pub fn update_angular_velocity(velocity: Vec3, acceleration: Vec3, timestep: f32) -> Vec3 {
    velocity + acceleration * timestep
}

/// Port of TE `integrateRotationQuaternion` (`physics/helpers.ts:16-20`).
///
/// ```text
///     w_quat = (vx*dt, vy*dt, vz*dt, 0)
///     dq     = 0.5 * (w_quat * q)
///     q'     = normalize(q + dq)
/// ```
pub fn integrate_rotation_quaternion(quaternion: Quat, velocity: Vec3, timestep: f32) -> Quat {
    let w_quat = Quat::from_xyzw(
        velocity.x * timestep,
        velocity.y * timestep,
        velocity.z * timestep,
        0.0,
    );
    // glam `Quat` multiplication == THREE Hamilton product.
    let prod = w_quat * quaternion;
    let dq = scale_quat(prod, 0.5);
    add_quats(quaternion, dq).normalize()
}

#[inline]
fn scale_quat(q: Quat, s: f32) -> Quat {
    Quat::from_xyzw(q.x * s, q.y * s, q.z * s, q.w * s)
}

#[inline]
fn add_quats(a: Quat, b: Quat) -> Quat {
    Quat::from_xyzw(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;
    use crate::field::Field;

    fn make_plate() -> Plate {
        Plate::new(0, 0xFF_00_00, OCEAN_DENSITY)
    }

    #[test]
    fn plate_creates_with_no_fields() {
        let p = make_plate();
        assert_eq!(p.id, 0);
        assert_eq!(p.color, 0xFF_00_00);
        assert!(p.fields.is_empty());
        assert!(!p.is_active());
        assert_eq!(p.quaternion, Quat::IDENTITY);
        assert_eq!(p.angular_velocity, Vec3::ZERO);
        assert!(p.group.is_none());
    }

    #[test]
    fn add_field_increments_count_and_remembers() {
        let mut p = make_plate();
        p.add_field(5);
        p.add_field(3);
        p.add_field(7);
        // Sorted insertion (TE Plate.sortFields).
        assert_eq!(p.fields, vec![3, 5, 7]);
        assert!(p.contains_field(5));
        assert!(!p.contains_field(99));
        assert!(p.is_active());
        // Idempotent.
        p.add_field(5);
        assert_eq!(p.fields, vec![3, 5, 7]);
    }

    #[test]
    fn remove_field_works() {
        let mut p = make_plate();
        p.add_field(1);
        p.add_field(2);
        assert!(p.remove_field(1));
        assert!(!p.remove_field(99));
        assert_eq!(p.fields, vec![2]);
    }

    #[test]
    fn plate_motion_verlet_advances_quaternion() {
        let mut p = make_plate();
        p.angular_velocity = Vec3::new(0.0, 1.0, 0.0); // 1 rad/sec around y
        let dt = 0.1;
        p.update_motion_single_for_test(dt, Vec3::ZERO, |_| Vec3::ZERO);
        // Quaternion should rotate ~0.1 rad around y.
        let euler = p.quaternion.to_euler(glam::EulerRot::XYZ);
        assert!(
            (euler.1 - 0.1).abs() < 0.01,
            "expected ~0.1 rad y rotation, got {:?}",
            euler
        );
    }

    #[test]
    fn integrate_rotation_quaternion_unit_rotation() {
        let q = Quat::IDENTITY;
        // 90 deg/sec around z, dt=1 ⇒ ~π/2 rotation.
        let q2 = integrate_rotation_quaternion(q, Vec3::new(0.0, 0.0, std::f32::consts::FRAC_PI_2), 1.0);
        let euler = q2.to_euler(glam::EulerRot::XYZ);
        // For an axis-z spin the Z euler component should be close to PI/4
        // after one Verlet sub-step (because the formula is dq = 0.5 * w * q,
        // a half-step approximation that matches TE behaviour). The point is
        // that some non-zero rotation around z occurs and the quaternion
        // stays normalised.
        assert!(q2.is_normalized());
        assert!(euler.2.abs() > 0.0);
    }

    #[test]
    fn linear_velocity_zero_for_zero_angular_velocity() {
        let p = make_plate();
        assert_eq!(p.linear_velocity(Vec3::X), Vec3::ZERO);
    }

    #[test]
    fn linear_velocity_perpendicular_to_axis() {
        let mut p = make_plate();
        p.angular_velocity = Vec3::Y;
        let v = p.linear_velocity(Vec3::X);
        // ω×r = ŷ × x̂ = -ẑ
        assert!((v - Vec3::new(0.0, 0.0, -1.0)).length() < 1e-6);
    }

    #[test]
    fn compute_field_position_applies_quaternion() {
        let mut p = make_plate();
        // 90° rotation around z.
        p.quaternion = Quat::from_axis_angle(Vec3::Z, std::f32::consts::FRAC_PI_2);
        let world = p.compute_field_position(Vec3::X);
        assert!((world - Vec3::Y).length() < 1e-5);
    }

    #[test]
    fn local_position_is_inverse_of_absolute() {
        let mut p = make_plate();
        p.quaternion = Quat::from_axis_angle(Vec3::Y, 0.7);
        let local = Vec3::new(0.3, 0.6, 0.74).normalize();
        let world = p.compute_field_position(local);
        let back = p.local_position(world);
        assert!((back - local).length() < 1e-5);
    }

    #[test]
    fn inertia_tensor_zero_when_no_fields() {
        let mut p = make_plate();
        p.update_inertia_tensor(&[], 1.0);
        assert_eq!(p.mass, 0.0);
        assert_eq!(p.moment_of_inertia, Mat3::ZERO);
    }

    #[test]
    fn inertia_tensor_nonzero_for_field_off_axis() {
        let mut p = make_plate();
        let f = Field::new(0, Vec3::X);
        let fields = vec![f];
        p.add_field(0);
        p.update_inertia_tensor(&fields, 1.0);
        assert!(p.mass > 0.0);
        // Position is (1,0,0), so I_xx = 0, I_yy = m, I_zz = m.
        let m = p.moment_of_inertia;
        // glam Mat3 indexed by `[col].x/.y/.z` => col 0 is column 0.
        // moment_of_inertia col0 = (ixx, ixy, ixz). col1 = (ixy, iyy, iyz).
        assert!(m.col(0).x.abs() < 1e-6, "ixx should be ~0");
        assert!(m.col(1).y > 0.0, "iyy should be positive");
        assert!(m.col(2).z > 0.0, "izz should be positive");
    }

    #[test]
    fn slab_pull_force_increases_velocity_toward_trench() {
        // Set up an external torque around y. After one Verlet step, the
        // plate should have gained angular velocity in that direction.
        // Use three fields off the y axis so the inertia tensor is
        // non-singular (TE always has many fields per plate; a one-point
        // mass distribution gives a degenerate inertia tensor).
        let mut p = make_plate();
        let fa = Field::new(0, Vec3::new(1.0, 0.0, 0.1).normalize());
        let fb = Field::new(1, Vec3::new(0.0, 0.2, 1.0).normalize());
        let fc = Field::new(2, Vec3::new(0.3, 1.0, 0.0).normalize());
        p.add_field(0);
        p.add_field(1);
        p.add_field(2);
        p.update_inertia_tensor(&[fa, fb, fc], 1.0);
        let pre = p.angular_velocity;
        let t = Vec3::new(0.0, 1.0, 0.0);
        p.update_motion_single_for_test(0.1, t, |_| t);
        assert!(
            p.angular_velocity.y > pre.y,
            "expected positive y angular acceleration, got {:?}",
            p.angular_velocity
        );
    }

    #[test]
    fn update_hot_spot_decays_force_toward_zero() {
        let mut p = make_plate();
        p.hot_spot.force = Vec3::new(10.0, 0.0, 0.0);
        let before = p.hot_spot.force.length();
        p.update_hot_spot(0.5);
        assert!(p.hot_spot.force.length() < before);
    }

    #[test]
    fn determinism_two_plates_byte_identical() {
        // Run two independent plates through the same scripted simulation;
        // their final state must be bit-identical.
        fn run() -> Plate {
            let mut p = make_plate();
            let fa = Field::new(0, Vec3::X);
            let fb = Field::new(1, Vec3::Y);
            p.add_field(0);
            p.add_field(1);
            p.update_inertia_tensor(&[fa.clone(), fb.clone()], 100.0);
            p.angular_velocity = Vec3::new(0.1, 0.05, -0.02);
            for _ in 0..100 {
                let fields = [fa.clone(), fb.clone()];
                let torque = p.compute_total_torque(&fields, &[], 100.0);
                p.update_motion_single_for_test(0.05, torque, |pp| pp.compute_total_torque(&fields, &[], 100.0));
            }
            p
        }
        let a = run();
        let b = run();
        let aa = bincode::serialize(&a).unwrap();
        let bb = bincode::serialize(&b).unwrap();
        assert_eq!(aa, bb);
    }

    #[test]
    fn serialization_round_trip() {
        let mut p = make_plate();
        p.add_field(0);
        p.add_field(2);
        p.hot_spot = HotSpot::new(Vec3::X, Vec3::Y);
        p.angular_velocity = Vec3::new(0.1, 0.2, 0.3);
        let bytes = bincode::serialize(&p).unwrap();
        let q: Plate = bincode::deserialize(&bytes).unwrap();
        assert_eq!(p, q);
    }

    // ---------------------------------------------------------------
    // BLOCKER 1 — Verlet must NOT be degenerate when torque depends on state.
    // ---------------------------------------------------------------
    #[test]
    fn verlet_recompute_diverges_from_constant_torque_path() {
        // Run two trajectories from identical initial state. In path A, the
        // recompute closure returns the same torque as a1 (Euler-equivalent).
        // In path B, the recompute closure returns a STATE-DEPENDENT torque
        // (here: torque flipped in sign when quaternion deviates from
        // identity — a stand-in for the position-dependent term in
        // `compute_total_torque`).
        //
        // The fix is correct iff the two paths produce *different* final
        // angular velocities — proving a2 != a1 and the corrector actually
        // contributed.
        fn run(state_dependent: bool) -> Plate {
            let mut p = make_plate();
            // Give it a non-singular inertia tensor.
            let fa = Field::new(0, Vec3::new(1.0, 0.0, 0.1).normalize());
            let fb = Field::new(1, Vec3::new(0.0, 0.2, 1.0).normalize());
            let fc = Field::new(2, Vec3::new(0.3, 1.0, 0.0).normalize());
            p.add_field(0);
            p.add_field(1);
            p.add_field(2);
            p.update_inertia_tensor(&[fa, fb, fc], 1.0);
            // Start with non-zero angular velocity so the half-step
            // quaternion drift is meaningful.
            p.angular_velocity = Vec3::new(0.5, 0.0, 0.0);
            let torque_initial = Vec3::new(0.0, 1.0, 0.0);
            for _ in 0..5 {
                p.update_motion_single_for_test(0.5, torque_initial, |pp| {
                    if state_dependent {
                        // Torque "flips" based on how far the quaternion has
                        // drifted from identity. Magnitude scales with the
                        // imaginary part length — a proxy for position
                        // dependence.
                        let drift = pp.quaternion.xyz().length();
                        Vec3::new(0.0, 1.0 - 4.0 * drift, 0.0)
                    } else {
                        torque_initial
                    }
                });
            }
            p
        }
        let a = run(false);
        let b = run(true);
        let diff = (a.angular_velocity - b.angular_velocity).length();
        eprintln!(
            "verlet trajectory divergence: |Δω| = {:.6}  (a={:?}, b={:?})",
            diff, a.angular_velocity, b.angular_velocity
        );
        // Trajectory divergence proving the corrector applied.
        assert!(
            diff > 1e-3,
            "expected the recompute path to diverge from the constant-torque path; got diff={}",
            diff
        );
    }

    // ---------------------------------------------------------------
    // BLOCKER 2 — apply_force must accumulate into force_accumulator
    // (not overwrite hot_spot.position).
    // ---------------------------------------------------------------
    #[test]
    fn apply_force_accumulates_without_touching_hot_spot() {
        let mut p = make_plate();
        let initial_hot_spot_position = Vec3::new(7.0, 8.0, 9.0);
        let initial_hot_spot_force = Vec3::new(0.1, 0.2, 0.3);
        p.hot_spot = HotSpot::new(initial_hot_spot_position, initial_hot_spot_force);
        p.apply_force(Vec3::X, Vec3::Y);
        // Hot spot must NOT be clobbered.
        assert_eq!(p.hot_spot.position, initial_hot_spot_position);
        assert_eq!(p.hot_spot.force, initial_hot_spot_force);
        // Accumulator should be non-zero.
        assert!(p.force_accumulator.length() > 0.0);
        // A second apply_force adds to the accumulator.
        let after_one = p.force_accumulator;
        p.apply_force(Vec3::X, Vec3::Y);
        assert!((p.force_accumulator - after_one * 2.0).length() < 1e-5);
    }

    #[test]
    fn reset_force_accumulator_clears() {
        let mut p = make_plate();
        p.apply_force(Vec3::X, Vec3::Y);
        assert!(p.force_accumulator.length() > 0.0);
        p.reset_force_accumulator();
        assert_eq!(p.force_accumulator, Vec3::ZERO);
    }

    #[test]
    fn compute_total_torque_includes_force_accumulator() {
        let mut p = make_plate();
        let fa = Field::new(0, Vec3::new(1.0, 0.0, 0.1).normalize());
        p.add_field(0);
        p.update_inertia_tensor(&[fa.clone()], 1.0);
        let baseline = p.compute_total_torque(&[fa.clone()], &[], 1.0);
        p.apply_force(Vec3::Y, Vec3::Z);
        let with_accum = p.compute_total_torque(&[fa], &[], 1.0);
        assert!(
            (with_accum - baseline).length() > 0.0,
            "force_accumulator must contribute to total torque"
        );
    }

    // ---------------------------------------------------------------
    // BLOCKER 3 — orogenic drag must be included when dragging_plate is set.
    // ---------------------------------------------------------------
    #[test]
    fn compute_total_torque_orogenic_drag_increases_magnitude() {
        // Plate A has a single field that drags plate B.
        let mut plate_a = Plate::new(0, 0, OCEAN_DENSITY);
        let mut field = Field::new(0, Vec3::new(1.0, 0.0, 0.1).normalize());
        plate_a.add_field(0);
        plate_a.angular_velocity = Vec3::new(0.0, 0.1, 0.0);
        plate_a.update_inertia_tensor(&[field.clone()], 100.0);

        let mut plate_b = Plate::new(1, 0, OCEAN_DENSITY);
        plate_b.angular_velocity = Vec3::new(0.0, -0.1, 0.0); // opposite spin

        // Baseline torque (no orogenic drag).
        let baseline = plate_a.compute_total_torque(&[field.clone()], &[plate_b.clone()], 100.0);

        // Set the dragging-plate link and recompute.
        field.set_dragging_plate(plate_b.id);
        let with_drag = plate_a.compute_total_torque(&[field], &[plate_b], 100.0);
        assert!(
            with_drag.length() > baseline.length(),
            "orogenic drag should increase total-torque magnitude (baseline={}, with_drag={})",
            baseline.length(),
            with_drag.length()
        );
    }
}
