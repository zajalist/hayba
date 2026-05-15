//! Per-field state struct.
//!
//! Port target: tectonic-explorer's `src/plates-model/field.ts` (and the
//! flattened-in `field-base.ts`). The TS class hierarchy is collapsed into a
//! single Rust struct. Adjacency, position and grid lookups live on the
//! [`crate::sphere::Grid`]; only mutable per-field state lives here.
//!
//! Substructures whose full port belongs to later phases (Crust composition,
//! Subduction physics, VolcanicActivity) are present as placeholder structs so
//! the field shape is correct and serializers/deserialisers round-trip cleanly.

use glam::Vec3;
use serde::{Deserialize, Serialize};

pub use crate::crust::{
    CrustColumn, DEFAULT_CONTINENTAL_BASEMENT_THICKNESS_M,
    DEFAULT_OCEANIC_BASEMENT_THICKNESS_M,
};
pub use crate::mantle::LithosphericColumn;

/// Default oceanic crust thickness, in meters. Re-export with the TE name
/// for call-sites that previously referenced the placeholder constant.
pub const BASE_OCEANIC_CRUST_THICKNESS: f32 = DEFAULT_OCEANIC_BASEMENT_THICKNESS_M;
/// Default continental crust thickness, in meters.
pub const BASE_CONTINENTAL_CRUST_THICKNESS: f32 = DEFAULT_CONTINENTAL_BASEMENT_THICKNESS_M;
/// TE: elevation threshold at which a field counts as continent (>0 => land).
pub const SEA_LEVEL_ELEVATION: f32 = 0.0;

/// `Crust` alias for the multi-layer column. Phase 2 promotes the
/// Phase-1 placeholder to the real type — the old name is kept so call
/// sites (`crate::field::Crust::new_continental()` etc.) continue to
/// compile.
pub type Crust = CrustColumn;

/// `Subduction` lives in [`crate::subduction`] (Phase 1.4 port). Re-exported
/// here so existing call sites that referenced `field::Subduction` continue
/// to compile.
pub use crate::subduction::Subduction;

/// Placeholder for `VolcanicActivity` (Phase 4). See note on [`Subduction`].
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct VolcanicActivity;

/// Per-field state.
///
/// This is a flattened equivalent of TS `Field extends FieldBase`. Adjacency
/// and `localPos` live in [`crate::sphere::Grid`]; this struct carries only the
/// mutable per-field state that the simulation evolves over time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub id: u32,
    pub local_pos: Vec3,
    pub plate_id: Option<u32>,
    pub boundary: bool,
    pub marked: bool,
    /// Elevation relative to sea level. >0 land, <0 ocean (TE convention).
    pub elevation: f32,
    /// Crust age in simulation units (great-circle distance travelled, like TE).
    pub age: f32,
    pub crust: Crust,
    pub subduction: Option<Subduction>,
    pub volcanic_activity: Option<VolcanicActivity>,
    /// TE: bending progress accumulated during plate subduction.
    pub bending_progress: f32,
    /// TE: `noCollisionDist` for adjacent / buffer fields.
    pub no_collision_dist: f32,
    pub block_faulting: f32,
    /// TE: `shouldPropagateBending` — drives plate-bending propagation to
    /// neighbours during subduction. Plain state, not a derived predicate.
    /// Ported from `ISerializedField.shouldPropagateBending` in
    /// `field.ts` (snapshot lines 41, 100, 161, 177, 359, 434, 448, 451).
    pub should_propagate_bending: bool,
    /// TE: `field.draggingPlate` — id of an *other* plate that is being
    /// dragged by orogeny at this field. Set by `applyDragForces` in TE
    /// `fields-collision.ts:10-11`. `None` means basic drag only.
    pub dragging_plate: Option<u32>,
    /// TE: `field.colliding` — set whenever any `fieldsCollision` is
    /// recorded for this field this step. Used by the collision optimization
    /// fast-path (`model.ts:332`). Cleared at the start of each step by the
    /// orchestrator (`resetCollisions`).
    pub colliding: bool,
    /// TE: `field.isContinentBuffer` — used by the subduction branch in
    /// `fields-collision.ts:41` to decide whether to apply drag forces when
    /// a continent is "trying" to subduct under an ocean. Phase 1 wires the
    /// flag; Phase 2 populates it.
    pub is_continent_buffer: bool,
    /// Hayba Phase 3 — lithospheric mantle column under the crust.
    /// Oceanic fields recompute this from `age` each step (Stein-Stein
    /// 1992 half-space cooling); continental fields keep a static
    /// thick column (Artemieva 2009).
    #[serde(default)]
    pub lithospheric_column: LithosphericColumn,
    /// Recent orogenic uplift rate at this cell, normalized to [0, 1].
    /// Bumped to 1.0 each step the cell participates in an Orogeny collision;
    /// decays toward 0 with `orogenic_uplift *= 0.92` each step.
    #[serde(default)]
    pub orogenic_uplift: f32,
    /// Steps since this cell was spawned at a mid-ocean ridge.
    /// 0 = just spawned. Saturates at u16::MAX (which the renderer caps).
    #[serde(default)]
    pub mor_age_steps: u16,
}

impl Field {
    /// Create a fresh oceanic field with no plate assignment.
    pub fn new(id: u32, local_pos: Vec3) -> Self {
        Self {
            id,
            local_pos,
            plate_id: None,
            boundary: false,
            marked: false,
            elevation: 0.0,
            age: 0.0,
            crust: Crust::new_oceanic(),
            subduction: None,
            volcanic_activity: None,
            bending_progress: 0.0,
            no_collision_dist: 0.0,
            block_faulting: 0.0,
            should_propagate_bending: false,
            dragging_plate: None,
            colliding: false,
            is_continent_buffer: false,
            // Default oceanic at age 0 — neutral buoyancy, zero thickness.
            // Owners that promote the field to continental should reassign
            // this via `Field::become_continental_lithosphere`.
            lithospheric_column: LithosphericColumn::default(),
            orogenic_uplift: 0.0,
            mor_age_steps: 0,
        }
    }

    /// Refresh the lithospheric column for an oceanic field based on its
    /// current `age`. Continental fields are not affected — call
    /// [`Self::become_continental_lithosphere`] explicitly to set those.
    #[inline]
    pub fn refresh_oceanic_lithosphere(&mut self) {
        if self.is_oceanic_crust() {
            self.lithospheric_column =
                LithosphericColumn::oceanic_from_age(self.age);
        }
    }

    /// Mark this field as carrying a continental lithospheric column at
    /// the given thickness (km). Use the default 200 km if unsure.
    #[inline]
    pub fn become_continental_lithosphere(&mut self, thickness_km: f32) {
        self.lithospheric_column = LithosphericColumn::continental(thickness_km);
    }

    /// Record that `plate_id` is being dragged at this field. Port of the
    /// `field.draggingPlate = topField.plate` assignment in
    /// `fields-collision.ts:10-11` (called from `applyDragForces`).
    #[inline]
    pub fn set_dragging_plate(&mut self, plate_id: u32) {
        self.dragging_plate = Some(plate_id);
    }

    /// Clear the dragging-plate link. Called by the orchestrator at the
    /// start of each step (mirrors TE `Field.resetCollisions`).
    #[inline]
    pub fn clear_dragging_plate(&mut self) {
        self.dragging_plate = None;
    }

    /// TE: `field.elevation > 0` — purely an above-sea-level predicate.
    ///
    /// Note this is orthogonal to crust composition (see
    /// [`Field::is_continent_crust`]); a continental-crust field can sit below
    /// sea level (continental shelf) and an oceanic-crust field can sit above
    /// sea level (volcanic island). Use this predicate when you mean "is this
    /// land?", not "is this continental crust?".
    #[inline]
    pub fn is_above_sea_level(&self) -> bool {
        self.elevation > SEA_LEVEL_ELEVATION
    }

    /// Composition-based, ported from TE `field.continentalCrust`
    /// (`field.ts:211`). True when the crust basement is granite-class.
    #[inline]
    pub fn is_continent_crust(&self) -> bool {
        self.crust.is_continental()
    }

    /// Composition-based, ported from TE `field.oceanicCrust`
    /// (`field.ts:207`). True when the crust basement is basalt-class.
    #[inline]
    pub fn is_oceanic_crust(&self) -> bool {
        self.crust.is_oceanic()
    }

    /// Total crust thickness summed across every layer, in meters.
    #[inline]
    pub fn crust_thickness(&self) -> f32 {
        self.crust.total_thickness_m()
    }

    /// Proportionally rescale every layer so the column totals `value`
    /// meters. Mirrors TE `Crust.setThickness`.
    #[inline]
    pub fn set_crust_thickness(&mut self, value: f32) {
        self.crust.rescale_total(value);
    }

    #[inline]
    pub fn is_assigned(&self) -> bool {
        self.plate_id.is_some()
    }

    // -----------------------------------------------------------------
    // Force composition — port of TE `Field.force` / `Field.torque`.
    // -----------------------------------------------------------------

    /// Port of TE `basicDrag(field)` (`physics/forces.ts:10-13`).
    ///
    /// Arguments are passed in pre-computed (rather than queried off a back-
    /// pointer) to avoid the plate ↔ field cycle:
    ///   * `linear_velocity_at_field` — `plate.linearVelocity(field.absolutePos)`
    ///   * `field_area_km2`           — `field.area` (`grid.field_area_km2()`)
    ///   * `basic_drag_force_mod`     — TE `BASIC_DRAG_FORCE_MOD`
    ///   * `constant_hot_spots`       — TE `config.constantHotSpots`
    pub fn basic_drag(
        &self,
        linear_velocity_at_field: Vec3,
        field_area_km2: f32,
        basic_drag_force_mod: f32,
        constant_hot_spots: bool,
    ) -> Vec3 {
        let k = (if constant_hot_spots { -0.15 } else { -0.0005 })
            * field_area_km2
            * basic_drag_force_mod;
        linear_velocity_at_field * k
    }

    /// Port of TE `orogenicDrag(field, plate)` (`physics/forces.ts:17-32`).
    ///
    /// Arguments:
    ///   * `field_linear_velocity` — `field.linearVelocity` (on owning plate).
    ///   * `dragging_plate_linear_velocity_at_field_pos` —
    ///     `draggingPlate.linearVelocity(field.absolutePos)`.
    ///   * `field_area_km2`         — `field.area`.
    ///   * `orogeny_force_mod`      — `BASIC_DRAG_FORCE_MOD / orogenyStrength`.
    ///   * `constant_hot_spots`     — TE `config.constantHotSpots`.
    ///
    /// If `self.subduction` is `Some`, scales by `1 + progress * 20`.
    pub fn orogenic_drag(
        &self,
        field_linear_velocity: Vec3,
        dragging_plate_linear_velocity_at_field_pos: Vec3,
        field_area_km2: f32,
        orogeny_force_mod: f32,
        constant_hot_spots: bool,
    ) -> Vec3 {
        let mut force = field_linear_velocity - dragging_plate_linear_velocity_at_field_pos;
        let force_len = force.length();
        if force_len > 0.0 {
            let exp = if constant_hot_spots { 0.3 } else { 0.5 };
            let mut modifier = 1.0f32;
            if let Some(s) = &self.subduction {
                modifier = 1.0 + s.progress() * 20.0;
            }
            let new_len = -force_len.powf(exp) * modifier;
            force = (force / force_len) * new_len;
        }
        force * (field_area_km2 * orogeny_force_mod)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_field_has_zero_orogenic_uplift_and_mor_age() {
        let f = Field::new(0, glam::Vec3::X);
        assert_eq!(f.orogenic_uplift, 0.0);
        assert_eq!(f.mor_age_steps, 0);
    }

    #[test]
    fn field_construction_round_trip() {
        let f = Field::new(42, Vec3::new(1.0, 0.0, 0.0));
        assert_eq!(f.id, 42);
        assert!(f.plate_id.is_none());
        assert_eq!(f.elevation, 0.0);
        assert!(!f.is_above_sea_level());
        assert!(f.is_oceanic_crust());
        assert!(!f.is_continent_crust());
        assert!(!f.should_propagate_bending);
    }

    #[test]
    fn is_above_sea_level_threshold() {
        let mut f = Field::new(0, Vec3::Z);
        f.elevation = -0.1;
        assert!(!f.is_above_sea_level());
        f.elevation = 0.1;
        assert!(f.is_above_sea_level());
    }

    #[test]
    fn crust_composition_orthogonal_to_elevation() {
        // Continental crust below sea level (continental shelf) — TE allows this.
        let mut f = Field::new(0, Vec3::X);
        f.crust = Crust::new_continental();
        f.elevation = -0.05;
        assert!(f.is_continent_crust());
        assert!(!f.is_oceanic_crust());
        assert!(!f.is_above_sea_level());
        // Oceanic crust above sea level (volcanic island).
        let mut g = Field::new(1, Vec3::Y);
        g.crust = Crust::new_oceanic();
        g.elevation = 0.05;
        assert!(g.is_oceanic_crust());
        assert!(!g.is_continent_crust());
        assert!(g.is_above_sea_level());
    }

    #[test]
    fn should_propagate_bending_round_trips_through_bincode() {
        let mut f = Field::new(7, Vec3::Z);
        f.should_propagate_bending = true;
        let bytes = bincode::serialize(&f).unwrap();
        let g: Field = bincode::deserialize(&bytes).unwrap();
        assert!(g.should_propagate_bending);
        assert_eq!(f, g);
    }

    #[test]
    fn serialize_field_round_trip() {
        let mut f = Field::new(7, Vec3::new(0.0, 1.0, 0.0));
        f.elevation = 0.5;
        f.age = 100.0;
        f.plate_id = Some(3);
        f.crust = Crust::new_continental();
        f.subduction = Some(Subduction::start(0.0));
        f.should_propagate_bending = true;
        let bytes = bincode::serialize(&f).unwrap();
        let g: Field = bincode::deserialize(&bytes).unwrap();
        assert_eq!(f, g);
    }

    #[test]
    fn set_crust_thickness_round_trip() {
        let mut f = Field::new(1, Vec3::X);
        // Rescale to 12 km of crust. (Real meters, not model units now.)
        f.set_crust_thickness(12_000.0);
        assert!((f.crust_thickness() - 12_000.0).abs() < 1.0);
    }

    #[test]
    fn default_field_is_oceanic() {
        let f = Field::new(0, Vec3::X);
        assert!(!f.crust.is_continental());
        assert!(f.crust.is_oceanic());
        assert!((f.crust_thickness() - BASE_OCEANIC_CRUST_THICKNESS).abs() < 1.0);
    }

    #[test]
    fn default_field_has_no_dragging_plate_or_buffer() {
        let f = Field::new(0, Vec3::X);
        assert!(f.dragging_plate.is_none());
        assert!(!f.is_continent_buffer);
        assert!(!f.colliding);
    }

    #[test]
    fn set_dragging_plate_round_trips() {
        let mut f = Field::new(0, Vec3::X);
        f.set_dragging_plate(7);
        assert_eq!(f.dragging_plate, Some(7));
        f.clear_dragging_plate();
        assert!(f.dragging_plate.is_none());
    }

    #[test]
    fn basic_drag_opposes_linear_velocity() {
        let f = Field::new(0, Vec3::X);
        let v = Vec3::Y;
        let force = f.basic_drag(v, 100.0, 1.0e-6, false);
        // k < 0, so the result is anti-parallel to v.
        assert!(force.dot(v) < 0.0);
    }

    #[test]
    fn orogenic_drag_scales_with_subduction_progress() {
        let mut f = Field::new(0, Vec3::X);
        let field_v = Vec3::X;
        let drag_v = Vec3::ZERO;
        let no_subduction =
            f.orogenic_drag(field_v, drag_v, 100.0, 1.0e-6, false).length();
        // Mid-progress subduction increases the magnitude (mod = 1 + 0.5*20 = 11).
        let mut s = Subduction::start(0.0);
        s.dist = MAX_SUBDUCTION_DIST_FOR_TEST_HALF;
        f.subduction = Some(s);
        let with_subduction =
            f.orogenic_drag(field_v, drag_v, 100.0, 1.0e-6, false).length();
        assert!(with_subduction > no_subduction);
    }

    // Test helper — half of MAX_SUBDUCTION_DIST (progress ≈ 0.25).
    const MAX_SUBDUCTION_DIST_FOR_TEST_HALF: f32 = 0.117_722_88; // ≈ 1500/6371/2
}
