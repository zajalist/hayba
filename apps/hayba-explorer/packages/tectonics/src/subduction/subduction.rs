//! Subduction dynamics: slab descent, dip, melt generation.
//!
//! Port target: tectonic-explorer's `src/plates-model/subduction.ts`.
//! Frozen reference: `docs/research/te-snapshot/plates-model/subduction.ts`.
//!
//! ## TE → Rust mapping
//!
//! TE keeps a `Subduction` instance per field on the *bottom* (subducting)
//! side. The instance carries:
//!   * `dist` — cumulative subduction distance (unit-sphere units), the only
//!     persistent state.
//!   * `topPlate` — transient handle to the overriding plate; reset every
//!     simulation step.
//!   * `relativeVelocity` — transient velocity vector used to advance
//!     `dist`; also reset every step.
//!
//! Progress is derived: `progress = min(1, (dist / MAX_SUBDUCTION_DIST)^2)`.
//!
//! `update(dt)` advances `dist` by `|relativeVelocity| * dt` (or reverts at
//! `REVERT_SUBDUCTION_VEL` when there's no current collision), clamped to
//! one `fieldDiameter` beyond the minimum neighbour subduction distance.
//! When `dist > MAX_SUBDUCTION_DIST` the field is marked dead.
//!
//! The Rust port preserves these semantics. Persistent state lives on the
//! `Subduction` struct, transient fields are `Option<...>` and the
//! orchestrator clears them at the end of each step.

use glam::Vec3;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// TE constants (from `plates-model/subduction.ts` + `src-root/constants.ts`)
// ---------------------------------------------------------------------------

/// TE `c.earthRadius` (in km).
pub const EARTH_RADIUS_KM: f32 = 6_371.0;

/// TE `c.subductionWidth` (in km).
pub const SUBDUCTION_WIDTH_KM: f32 = 1_500.0;

/// TE `MAX_SUBDUCTION_DIST` (`subduction.ts:13`):
/// `subductionWidth / earthRadius` — unit-sphere distance.
pub const MAX_SUBDUCTION_DIST: f32 = SUBDUCTION_WIDTH_KM / EARTH_RADIUS_KM;

/// TE `REVERT_SUBDUCTION_VEL` (`subduction.ts:17`).
pub const REVERT_SUBDUCTION_VEL: f32 = -10.0;

/// TE `MIN_PROGRESS_TO_DETACH` (`subduction.ts:19`).
pub const MIN_PROGRESS_TO_DETACH: f32 = 0.3;
/// TE `MIN_SPEED_TO_DETACH`.
pub const MIN_SPEED_TO_DETACH: f32 = 0.000_5;
/// TE `MIN_ANGLE_TO_DETACH`.
pub const MIN_ANGLE_TO_DETACH: f32 = std::f32::consts::PI * 0.55;

/// TE `MIN_PROGRESS` (`subduction.ts:22`).
pub const MIN_PROGRESS: f32 = 0.0;

// ---------------------------------------------------------------------------
// Subduction state
// ---------------------------------------------------------------------------

/// Per-field subduction state.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Subduction {
    /// Cumulative subducted distance in unit-sphere radians (TE
    /// `Subduction.dist`). Persistent across steps — the only state TE
    /// serialises.
    pub dist: f32,
    /// Slab dip angle. Not used by TE's core loop (it derives dip from
    /// `calcSlabGradient`) but exposed for downstream consumers (rendering,
    /// volcanic activity heuristics).
    pub dip: f32,
    /// Direction of the pull at this field (used by Phase 4 slab-pull
    /// forces; populated from the relative velocity when a collision is set).
    pub force_dir: Vec3,
    /// Transient: relative velocity vs the top plate at this field. Reset
    /// every step.
    pub relative_velocity: Option<Vec3>,
    /// Transient: id of the overriding plate at this field. Reset every
    /// step. TE: `Subduction.topPlate`.
    pub top_plate: Option<u32>,
    /// Crust age (in TE simulation units) at the moment subduction started.
    /// Tracked here so Phase 4 volcanic activity can scale arc magmatism by
    /// the age of the descending slab.
    pub age_at_subduction_ma: f32,
}

impl Subduction {
    /// Begin a new subduction record on `bottom_field`. Sets persistent
    /// `dist = 0` and records the field's age. Caller (the collision pass)
    /// is responsible for calling `set_collision` afterwards to populate
    /// the transient `top_plate` / `relative_velocity` fields.
    ///
    /// Port of TE `new Subduction(field)` (`subduction.ts:31-36`).
    pub fn start(age_at_subduction_ma: f32) -> Self {
        Self {
            dist: 0.0,
            dip: 0.0,
            force_dir: Vec3::ZERO,
            relative_velocity: None,
            top_plate: None,
            age_at_subduction_ma,
        }
    }

    /// Record a fresh collision with the overriding plate's field.
    /// Port of `Subduction.setCollision` (`subduction.ts:95-102`).
    pub fn set_collision(
        &mut self,
        top_plate_id: u32,
        bottom_linear_velocity: Vec3,
        top_linear_velocity: Vec3,
    ) {
        self.top_plate = Some(top_plate_id);
        let rel = bottom_linear_velocity - top_linear_velocity;
        self.relative_velocity = Some(rel);
        // Force direction is just the unit relative velocity (or zero if
        // they happen to be exactly parallel — caller can substitute a
        // boundary-normal fallback if needed).
        let len = rel.length();
        self.force_dir = if len > 0.0 { rel / len } else { Vec3::ZERO };
    }

    /// Clear transient collision data. Port of
    /// `Subduction.resetCollision` (`subduction.ts:104-108`).
    pub fn reset_collision(&mut self) {
        self.top_plate = None;
        self.relative_velocity = None;
    }

    /// Subduction progress in [0, 1]. Port of
    /// `Subduction.progress` getter (`subduction.ts:50-52`).
    pub fn progress(&self) -> f32 {
        let p = MIN_PROGRESS + (self.dist / MAX_SUBDUCTION_DIST).powi(2);
        if p < 1.0 {
            p
        } else {
            1.0
        }
    }

    /// TE `Subduction.active` getter (`subduction.ts:54-56`).
    pub fn active(&self) -> bool {
        self.dist >= 0.0
    }

    /// TE `Subduction.is_complete` semantic: progress at saturation.
    pub fn is_complete(&self) -> bool {
        self.dist >= MAX_SUBDUCTION_DIST
    }

    /// Advance `dist` by one timestep. Port of
    /// `Subduction.update` (`subduction.ts:121-133`), specialised for a
    /// per-field call. `min_neighbour_dist` is the smallest `dist` among
    /// neighbour subduction fields (or 0 if none); `field_diameter` is the
    /// grid's `fieldDiameter` (unit-sphere units).
    ///
    /// Returns `true` if the field has saturated and should be marked
    /// dead by the caller (TE: `field.alive = false`).
    pub fn update(&mut self, dt: f32, min_neighbour_dist: f32, field_diameter: f32) -> bool {
        let diff = match self.relative_velocity {
            Some(v) => v.length() * dt,
            None => REVERT_SUBDUCTION_VEL,
        };
        let candidate = self.dist + diff;
        let clamp = min_neighbour_dist + field_diameter;
        self.dist = candidate.min(clamp);
        self.dist > MAX_SUBDUCTION_DIST
    }
}

/// Outcome of a detach evaluation. The orchestrator is expected to act on
/// this by moving the subducting field from its current plate into the
/// `to_subplate_of` plate's subplate (TE `Plate.addToSubplate`,
/// `subduction.ts:151-155`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetachDecision {
    pub from_plate_id: u32,
    pub to_subplate_of_plate_id: u32,
}

impl Subduction {
    /// Port of TE `Subduction.tryToDetachFromPlate` (`subduction.ts:135-149`).
    ///
    /// Returns `Some(DetachDecision)` when the slab's relative velocity has
    /// turned far enough off the slab gradient that the field should detach
    /// from its current (bottom) plate and be re-attached to the top plate's
    /// subplate. Returns `None` otherwise.
    ///
    /// Arguments:
    ///   * `current_plate_id`  — id of the plate currently owning this field
    ///   * `slab_gradient`     — pre-computed slab gradient (TE
    ///     `calcSlabGradient`). The orchestrator computes this from the
    ///     subducting neighbours; `None` indicates "fewer than 5 subducting
    ///     neighbours" and the detach attempt is skipped (matches TE).
    pub fn try_to_detach_from_plate(
        &self,
        current_plate_id: u32,
        slab_gradient: Option<Vec3>,
    ) -> Option<DetachDecision> {
        let top = self.top_plate?;
        if self.progress() < MIN_PROGRESS_TO_DETACH {
            return None;
        }
        let rel = self.relative_velocity?;
        if rel.length() <= MIN_SPEED_TO_DETACH {
            return None;
        }
        let grad = slab_gradient?;
        if grad.length() == 0.0 || rel.length() == 0.0 {
            return None;
        }
        // Angle between the slab gradient and the relative velocity.
        let cos = (grad.dot(rel) / (grad.length() * rel.length())).clamp(-1.0, 1.0);
        let angle = cos.acos();
        if angle <= MIN_ANGLE_TO_DETACH {
            return None;
        }
        Some(DetachDecision {
            from_plate_id: current_plate_id,
            to_subplate_of_plate_id: top,
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subduction_start_zero_progress() {
        let s = Subduction::start(12.5);
        assert_eq!(s.dist, 0.0);
        assert_eq!(s.progress(), 0.0);
        assert!(s.top_plate.is_none());
        assert!(s.relative_velocity.is_none());
        assert_eq!(s.age_at_subduction_ma, 12.5);
    }

    #[test]
    fn subduction_progress_advances_with_dt() {
        let mut s = Subduction::start(0.0);
        s.set_collision(99, Vec3::X * 0.1, Vec3::ZERO);
        // After a step the relative velocity (0.1) over dt=1.0 advances dist
        // by 0.1 units (clamped above MAX_SUBDUCTION_DIST + field_diameter).
        let saturated = s.update(1.0, 0.0, 1.0);
        assert!(!saturated);
        assert!(s.dist > 0.0);
        assert!(s.progress() > 0.0);
    }

    #[test]
    fn subduction_clamps_to_neighbour_plus_field_diameter() {
        let mut s = Subduction::start(0.0);
        s.set_collision(0, Vec3::X * 100.0, Vec3::ZERO); // huge rel velocity
        let _ = s.update(1.0, 0.05, 0.01); // clamp = 0.06
        assert!((s.dist - 0.06).abs() < 1e-6);
    }

    #[test]
    fn subduction_reverts_without_collision() {
        let mut s = Subduction::start(0.0);
        s.dist = 0.5;
        let _ = s.update(0.01, 1.0, 0.1); // no rel_velocity ⇒ revert
        assert!(s.dist < 0.5);
    }

    #[test]
    fn subduction_completes_after_full_progress() {
        let mut s = Subduction::start(0.0);
        s.dist = MAX_SUBDUCTION_DIST + 0.001;
        assert!(s.is_complete());
        assert!((s.progress() - 1.0).abs() < 1e-5);
    }

    #[test]
    fn subduction_progress_clamps_at_one() {
        let mut s = Subduction::start(0.0);
        s.dist = MAX_SUBDUCTION_DIST * 10.0;
        assert_eq!(s.progress(), 1.0);
    }

    #[test]
    fn set_collision_populates_relative_velocity_and_top_plate() {
        let mut s = Subduction::start(0.0);
        s.set_collision(42, Vec3::X, Vec3::ZERO);
        assert_eq!(s.top_plate, Some(42));
        assert_eq!(s.relative_velocity, Some(Vec3::X));
        assert!((s.force_dir - Vec3::X).length() < 1e-6);
    }

    #[test]
    fn reset_collision_clears_transients_but_keeps_dist() {
        let mut s = Subduction::start(0.0);
        s.set_collision(1, Vec3::X, Vec3::ZERO);
        s.dist = 0.3;
        s.reset_collision();
        assert!(s.top_plate.is_none());
        assert!(s.relative_velocity.is_none());
        assert_eq!(s.dist, 0.3);
    }

    #[test]
    fn try_to_detach_returns_none_when_progress_below_threshold() {
        let mut s = Subduction::start(0.0);
        s.set_collision(1, Vec3::X, Vec3::ZERO);
        // dist = 0 → progress = 0 < MIN_PROGRESS_TO_DETACH
        assert!(s.try_to_detach_from_plate(7, Some(Vec3::Y)).is_none());
    }

    #[test]
    fn try_to_detach_returns_none_without_top_plate() {
        let s = Subduction::start(0.0);
        assert!(s.try_to_detach_from_plate(7, Some(Vec3::Y)).is_none());
    }

    #[test]
    fn try_to_detach_returns_none_without_gradient() {
        let mut s = Subduction::start(0.0);
        s.set_collision(1, Vec3::X * 0.01, Vec3::ZERO);
        s.dist = MAX_SUBDUCTION_DIST * 0.7; // progress ≈ 0.49 > MIN_PROGRESS_TO_DETACH
        // gradient = None → skip
        assert!(s.try_to_detach_from_plate(0, None).is_none());
    }

    #[test]
    fn try_to_detach_fires_when_velocity_opposes_gradient() {
        let mut s = Subduction::start(0.0);
        s.dist = MAX_SUBDUCTION_DIST * 0.8;
        // relative velocity pointing in +X
        s.set_collision(99, Vec3::X * 0.01, Vec3::ZERO);
        // Gradient pointing in -X (angle = PI > MIN_ANGLE_TO_DETACH).
        let decision = s.try_to_detach_from_plate(3, Some(-Vec3::X));
        assert_eq!(
            decision,
            Some(DetachDecision {
                from_plate_id: 3,
                to_subplate_of_plate_id: 99,
            })
        );
    }

    #[test]
    fn try_to_detach_returns_none_when_velocity_aligned_with_gradient() {
        let mut s = Subduction::start(0.0);
        s.dist = MAX_SUBDUCTION_DIST * 0.8;
        s.set_collision(99, Vec3::X * 0.01, Vec3::ZERO);
        // Aligned: angle = 0 < MIN_ANGLE_TO_DETACH.
        assert!(s.try_to_detach_from_plate(3, Some(Vec3::X)).is_none());
    }

    #[test]
    fn serialization_round_trip() {
        let mut s = Subduction::start(7.5);
        s.dist = 0.42;
        s.set_collision(3, Vec3::X, Vec3::Y);
        let bytes = bincode::serialize(&s).unwrap();
        let t: Subduction = bincode::deserialize(&bytes).unwrap();
        assert_eq!(s, t);
    }
}
