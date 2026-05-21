//! Global step loop. Faithful port of TE's `model.ts:255-287` (`step`)
//! +`model.ts:296-323` (`simulatePlatesInteractions`)
//! +`model.ts:291-294` (`calculateDynamicProperties`)
//! +`model.ts:325-337` (`detectCollisions` reset-inside semantics)
//! + `verlet-integrator.ts`.
//!
//! ## TE step order (frozen reference, `model.ts:255-287`)
//!
//! 1. integrator (verlet / euler / rk4)            — `model.ts:259-265`
//! 2. speed-clamp (`MAX_PLATE_SPEED = 0.04`)        — `model.ts:268-272`
//! 3. `simulatePlatesInteractions`                  — `model.ts:274`
//!    a. `performGeologicalProcesses`               — `model.ts:298`   (STUB — Phase 2)
//!    b. `removeUnnecessaryFields`                  — `model.ts:299`   (STUB — Phase 2)
//!    c. `removeEmptyPlates`                        — `model.ts:300`   (STUB — Phase 4)
//!    d. `generateNewFields` / MOR                  — `model.ts:301`   (STUB — Phase 2)
//!    e. `updateInertiaTensor` (per plate)          — `model.ts:306-313` (IMPLEMENTED)
//!    f. `updateCenter` (per CENTER_UPDATE_INTERVAL)— `model.ts:314-318` (STUB — Phase 2 cosmetic)
//!    g. `updateHotSpot` (per plate)                — `model.ts:320`   (folded into PHASE A — see note)
//!    h. `tryToGroupPlates` / `splitPlates`         — `model.ts:321-322` (STUB — Phase 4)
//!    i. `dividePlatesByAge`                        — `model.ts:322`   (STUB — Phase 4)
//! 4. `calculateDynamicProperties`                  — `model.ts:275`
//!    a. `calculateContinentBuffers`                — `model.ts:292`   (STUB — Phase 2)
//!    b. `detectCollisions`                         — `model.ts:293`
//!         · TE resets per-field collision state INSIDE detectCollisions
//!           BEFORE scanning (`model.ts:336 → field.resetCollisions()`).
//!           We mirror that — reset happens at the START of PHASE C below,
//!           before `detect_field_collisions_opt`.
//! 5. resolve_field_collision (Hayba addition — TE handles it inside the
//!    detectCollisions inner loop).
//! 6. advance_subduction (Hayba addition — TE folds slab-dist advance into
//!    `performGeologicalProcesses` per-field).
//!
//! ## TE → Rust deviations
//!
//! * TE keeps a `time` and `stepIdx`; we keep `sim_time_ma` and `step_count`.
//! * TE's verlet integrator runs over the whole `Model` at once
//!   (`verlet-integrator.ts:11-30`): collect a1 for all plates first, advance
//!   ALL quaternions + provisional velocities, then collect a2 from the new
//!   state and apply the corrector. We mirror that exactly in
//!   [`Model::step_verlet`].
//! * `tryToDetachFromPlate` requires a slab-gradient calculator that walks
//!   neighbours of every subducting field — that's Phase 4. We stub it as a
//!   no-op here (with a `TODO`).
//! * Frame-stream emission is owned by the caller (`run_steps` writes one
//!   frame per call); the encoder is not stored on the Model.

use std::collections::HashMap;

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::field::Field;
use crate::mantle::PlumeRegistry;
use crate::perf_timing::{Phase, PhaseTimer};
use crate::plate::plate::{Plate, OCEAN_DENSITY};
use crate::plate::plate_group::PlateGroup;
use crate::sphere::Grid;
use crate::subduction::{detect_field_collisions_opt, resolve_field_collision};

/// Default plume population spawned by [`Model::new`] when the caller
/// doesn't customise. 3–7 anchored plumes per Earth-sized world is
/// roughly in line with the count of major hotspots observed today
/// (Morgan 1971, Sleep 1990).
pub const DEFAULT_PLUME_COUNT: u32 = 5;

/// Per-plate angular-speed clamp applied after the integrator.
///
/// TE source: `plates-model/model.ts:268-272`
/// (`if (plate.angularVelocity.length() > MAX_PLATE_SPEED) plate.angularVelocity.setLength(MAX_PLATE_SPEED)`).
/// The numeric value comes from `plates-model/model.ts` constants
/// (`MAX_PLATE_SPEED = 0.04`).
pub const MAX_PLATE_SPEED: f32 = 0.04;

/// Global tectonic simulation state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    pub grid: Grid,
    pub fields: Vec<Field>,
    pub plates: Vec<Plate>,
    pub plate_groups: Vec<PlateGroup>,
    pub step_count: u32,
    pub sim_time_ma: f32,
    pub master_seed: u64,
    /// After the first step, the orchestrator switches collision detection
    /// to the `optimize=true` path that only considers boundary / colliding
    /// fields. Matches TE `Model.detectCollisions(stepIdx > 0)` semantics
    /// (`model.ts:328-332`).
    pub optimized_collision_detection: bool,
    /// Hayba Phase 3 — discrete mantle plumes anchored to the mantle.
    /// Updated once per [`Self::step`] after the per-plate inertia /
    /// integrator passes.
    #[serde(default)]
    pub plume_registry: PlumeRegistry,

    /// SD — reused scratch buffer for `advance_subduction`'s per-field
    /// min-neighbour-distance pass. Hoisted out of the function body to
    /// eliminate the per-step `Vec<f32>` allocation (was the dominant
    /// `subduction` phase cost per the TS+1 measurement). Reset to
    /// `Vec::new()` on deserialize so save/load is byte-equal; the next
    /// `advance_subduction` call resize()s it to `fields.len()`.
    #[serde(skip, default)]
    subduction_scratch: Vec<f32>,

    /// SD T2 — reused list of field ids with an active subduction record.
    /// Only ~5–10% of fields have one; iterating sparsely instead of
    /// scanning all F fields × 6 neighbours per step cuts inner-loop
    /// body executions by ~95%. Rebuilt each `advance_subduction` call
    /// from the current `fields` slice (cheap O(F) scan).
    #[serde(skip, default)]
    subduction_active_fids: Vec<u32>,
}

impl Model {
    /// Build an empty model around a freshly-initialised grid. `fields` is
    /// sized to `grid.n_fields()` with default (oceanic, sea-level) values.
    pub fn new(divisions: u32, master_seed: u64) -> Self {
        let grid = Grid::new(divisions);
        let n = grid.n_fields();
        let fields: Vec<Field> = (0..n).map(|i| Field::new(i, grid.position(i))).collect();
        let mut plume_registry = PlumeRegistry::new();
        plume_registry.spawn_default_population(DEFAULT_PLUME_COUNT, master_seed);
        Self {
            grid,
            fields,
            plates: Vec::new(),
            plate_groups: Vec::new(),
            step_count: 0,
            sim_time_ma: 0.0,
            master_seed,
            optimized_collision_detection: false,
            plume_registry,
            subduction_scratch: Vec::new(),
            subduction_active_fids: Vec::new(),
        }
    }

    /// Add a plate and assign the given field ids to it. The fields are
    /// marked with `plate_id`, optionally upgraded to continental crust, and
    /// their `local_pos` is preserved (= the grid position at the plate's
    /// identity orientation). Inertia is recomputed.
    pub fn add_plate(
        &mut self,
        id: u32,
        color: u32,
        density: f32,
        field_ids: &[u32],
        continental: bool,
        initial_omega: Vec3,
    ) {
        let mut plate = Plate::new(id, color, density);
        plate.angular_velocity = initial_omega;
        for &fid in field_ids {
            if let Some(f) = self.fields.get_mut(fid as usize) {
                f.plate_id = Some(id);
                if continental {
                    f.crust = crate::field::Crust::new_continental();
                    f.elevation = 0.5; // crude land elevation
                    f.become_continental_lithosphere(200.0);
                } else {
                    f.crust = crate::field::Crust::new_oceanic();
                    f.elevation = -0.3;
                    f.refresh_oceanic_lithosphere();
                }
                plate.add_field(fid);
            }
        }
        plate.update_inertia_tensor(&self.fields, self.grid.field_area_km2());
        self.plates.push(plate);
        // Keep plates sorted by id for determinism.
        self.plates.sort_by_key(|p| p.id);
    }

    // -----------------------------------------------------------------
    // The step loop.
    // -----------------------------------------------------------------

    /// Run a single global step. Order mirrors TE `model.ts:255-287` exactly
    /// — see the module docstring for the phase table.
    ///
    /// Plate iteration order throughout this loop is `self.plates` (id-sorted
    /// after every `add_plate`); inertia / torque / clamp passes therefore
    /// see plates in ascending id order — deterministic.
    /// Advance the simulation by the canonical Wilson-cycle step
    /// ([`crate::time::DT_MA`]). Prefer this over [`Self::step`] in new code
    /// so the sim clock and Earth-history era overlay stay calibrated.
    pub fn step_default(&mut self) {
        self.step(crate::time::DT_MA as f32);
    }

    /// Current Earth-history era for `sim_time_ma`. Convenience wrapper
    /// around [`crate::time::era_for_ma`].
    pub fn current_era(&self) -> &'static str {
        crate::time::era_for_ma(self.sim_time_ma as f64)
    }

    pub fn step(&mut self, dt: f32) {
        let mut t = PhaseTimer::start();
        // ── PHASE A: verlet integrate all plates (TE step 1) ───────────
        self.step_verlet(dt);
        t.lap(Phase::Verlet);

        // ── PHASE B: speed-clamp (TE step 2, `model.ts:268-272`) ───────
        // Applied to every plate after the integrator regardless of mass.
        for p in self.plates.iter_mut() {
            let len = p.angular_velocity.length();
            if len > MAX_PLATE_SPEED {
                p.angular_velocity = p.angular_velocity * (MAX_PLATE_SPEED / len);
            }
        }

        // ── PHASE 3 (TE `simulatePlatesInteractions`, `model.ts:297-323`)
        // ── PHASE 3a: per-field geological processes ────────────────────
        self.perform_geological_processes(dt);
        // ── PHASE 3b: subducted-field cleanup ───────────────────────────
        self.remove_unnecessary_fields();
        // ── PHASE 3c: remove empty plates ───────────────────────────────
        self.remove_empty_plates();
        // ── PHASE 3d: spawn new fields (MOR) ────────────────────────────
        self.generate_new_fields(dt);
        t.lap(Phase::Geo);
        // ── PHASE 3e: refresh per-plate inertia tensors ─────────────────
        self.update_inertia_tensors();
        // ── PHASE 3f: refresh per-plate geographic centers ──────────────
        self.update_centers();
        // ── PHASE 3g: hot-spot decay ────────────────────────────────────
        // TE calls `forEachPlate(p => p.updateHotSpot(timestep))` here
        // (`model.ts:320`, INSIDE simulatePlatesInteractions, AFTER Verlet,
        // near the end). We fold it into `step_verlet`'s corrector pass for
        // efficiency (one less iteration over the plate list, same numeric
        // result because `update_hot_spot` depends only on `dt`).
        // ── PHASE 3h: group/split plates ────────────────────────────────
        self.group_and_split_plates();
        // ── PHASE 3i: divide plates by age ──────────────────────────────
        self.divide_plates_by_age();
        t.lap(Phase::Inertia);
        // ── PHASE 3j (Hayba) — mantle dynamics ──────────────────────────
        // Lithospheric column refresh + plume ageing / track recording.
        // Lives at the end of `simulatePlatesInteractions` so plates have
        // already moved to their post-step orientation (plumes deposit
        // onto whichever cells are above them *now*).
        self.update_lithospheric_columns(dt);
        self.plume_registry.step(dt);
        self.plume_registry
            .record_tracks(&self.grid, &mut self.fields, self.sim_time_ma + dt, dt);

        // ── PHASE 4 (TE `calculateDynamicProperties`, `model.ts:291-294`)
        // ── PHASE 4a: continent-buffer flag refresh ─────────────────────
        self.calculate_continent_buffers();

        // ── PHASE C-pre: recompute per-cell `boundary` flag. A cell is
        // on a plate boundary if ANY of its grid neighbours is owned by a
        // different plate. Required by detect_field_collisions_opt's
        // "considered" set (TE maintains this incrementally in
        // plate.ts::addField/deleteField; we recompute each step instead
        // because our plate-ownership graph is stable until plate
        // lifecycle ships).
        //
        // Without this, after step 1 `optimize=true` + colliding cleared
        // + boundary never set ⇒ considered set is empty ⇒ ZERO
        // collisions detected forever. This is the documented
        // root-cause of issue #6 (sim works but no orogeny).
        let n_fields = self.fields.len();
        for fid in 0..n_fields {
            let owner = self.fields[fid].plate_id;
            let mut is_boundary = false;
            if owner.is_some() {
                for &n in self.grid.neighbours(fid as u32) {
                    if let Some(nf) = self.fields.get(n as usize) {
                        if nf.plate_id != owner {
                            is_boundary = true;
                            break;
                        }
                    }
                }
            }
            self.fields[fid].boundary = is_boundary;
        }

        // ── PHASE C (TE step 4b — detectCollisions): per-field collision
        // state reset happens INSIDE detectCollisions in TE
        // (`model.ts:336 → field.resetCollisions()`), BEFORE scanning. We
        // mirror that here: reset first, then scan.
        for f in self.fields.iter_mut() {
            f.colliding = false;
            f.clear_dragging_plate();
            // TE also resets subduction transients each step
            // (`subduction.ts:104-108`).
            if let Some(s) = f.subduction.as_mut() {
                s.reset_collision();
            }
        }
        for p in self.plates.iter_mut() {
            p.reset_force_accumulator();
        }
        t.lap(Phase::Plume);
        let optimize = self.optimized_collision_detection;
        let collisions =
            detect_field_collisions_opt(&self.plates, &self.grid, &self.fields, optimize);
        t.lap(Phase::Collisions);

        // ── PHASE D: resolve each collision (Hayba addition) ───────────
        let plates_snapshot: Vec<Plate> = self.plates.clone();
        for c in &collisions {
            resolve_field_collision(c, &plates_snapshot, &mut self.fields);
        }

        // ── PHASE D-late: subducted-cell ownership transfer (★) ────────
        // For Subduction collisions, hand the bottom (denser, sinking) cell
        // to the overriding plate. This is the minimum-viable plate
        // lifecycle: plate boundaries breathe over time as cells migrate
        // from subducting → over-riding plate. Without this, the cell-to-
        // plate map is frozen at bake time and boundary shapes stay rigid
        // forever — the "boundaries look static" feel.
        //
        // Limit to one transfer per (top_plate, bottom_field) per step
        // (collisions can be reported from both directions; dedupe handles
        // that, but we still guard against re-removing).
        //
        // Skip Orogeny — both cells stay on their own plates so the
        // contact continues to register on subsequent steps and the
        // mountain belt sustains uplift. Skip DragOnly + KillBottomOcean
        // — neither transfers ownership in TE either.
        for c in &collisions {
            use crate::subduction::collision::CollisionKind;
            if !matches!(c.kind, CollisionKind::Subduction) {
                continue;
            }
            let fid = c.bottom_field;
            // Sanity: is the bottom cell still owned by the bottom plate?
            // (resolve_field_collision may have flipped it via subduction
            // setup. Only transfer if ownership is still the original.)
            let still_bottom = matches!(
                self.fields.get(fid as usize).and_then(|f| f.plate_id),
                Some(pid) if pid == c.bottom_plate
            );
            if !still_bottom {
                continue;
            }
            // EDGE-ONLY GUARD: only transfer if `fid` already has at least
            // one grid neighbour owned by the TOP plate. This ensures the
            // cell joins the edge of the receiving plate — extending its
            // boundary by one cell — rather than appearing as an island
            // marooned inside bottom-plate territory.
            //
            // Without this guard, collisions reported at the *interior* of
            // the bottom plate (which can happen when a fast plate's
            // rotation projects a far-away cell into the top plate's
            // frame) create disconnected single-cell pockets. Visually:
            // tiny closed-loop boundaries floating in the ocean, like the
            // "islands around Hawaii" reported.
            let has_top_neighbour = self
                .grid
                .neighbours(fid)
                .iter()
                .any(|&n| {
                    self.fields
                        .get(n as usize)
                        .and_then(|f| f.plate_id)
                        .is_some_and(|pid| pid == c.top_plate)
                });
            if !has_top_neighbour {
                continue;
            }
            // Remove from bottom plate.
            if let Some(p) = self.plates.iter_mut().find(|p| p.id == c.bottom_plate) {
                p.remove_field(fid);
            }
            // Add to top plate.
            if let Some(p) = self.plates.iter_mut().find(|p| p.id == c.top_plate) {
                p.add_field(fid);
            }
            // Update the field's plate_id pointer.
            if let Some(f) = self.fields.get_mut(fid as usize) {
                f.plate_id = Some(c.top_plate);
            }
        }

        // ── PHASE D-mid: orogeny → elevation, with band-shaped lift ────
        //
        // `resolve_field_collision` sets `orogenic_uplift = 1.0` at the exact
        // contact cell. Naively integrating that lift produces ISOLATED
        // SPIKES at the contact points — exactly the "delayed + unnatural,
        // inorganic" look the user reported.
        //
        // Real orogeny produces a 100-200km wide belt because the lithosphere
        // is stiff: stress at the contact gets distributed across many cells.
        // TE achieves this implicitly via `subduction.avgProgress` averaging
        // over neighbours + cumulative crust thickness driving elevation.
        //
        // We approximate the effect in a 3-step phase:
        //   1. SPREAD: blur orogenic_uplift one step into neighbours (0.55
        //      coupling). This widens the belt — a single contact cell
        //      seeds uplift across 7 cells (itself + 6 neighbours) the
        //      first step, growing more on subsequent steps as decay
        //      lags spread.
        //   2. LIFT:   integrate uplift × rate × dt into elevation, capped.
        //   3. SMOOTH: one pass of (0.5 self + 0.5 neighbour-mean) on
        //      cells with active uplift — removes per-cell spikiness so
        //      the band reads as a connected ridge.
        //
        // Decay slowed from 0.92 → 0.97 (uplift half-life ~22 steps vs 8)
        // so a single collision sustains lift over the time it takes a
        // mountain belt to build (~50-100 Ma at our scale).
        const OROGENY_UPLIFT_RATE: f32 = 0.012; // elev units per Ma at uplift=1
        const OROGENY_ELEV_CAP: f32 = 1.0;       // ≈ 9km, Himalaya ceiling
        const SPREAD_COUPLING: f32 = 0.55;       // 0..1, how much neighbour avg pulls up
        const UPLIFT_DECAY: f32 = 0.97;          // per-step (slower than before)

        // Step 1: SPREAD uplift to neighbours.
        let n_fields = self.fields.len();
        let mut spread: Vec<f32> = Vec::with_capacity(n_fields);
        for fid in 0..n_fields {
            let self_u = self.fields[fid].orogenic_uplift;
            let mut neigh_sum: f32 = 0.0;
            let mut count: u32 = 0;
            for &n in self.grid.neighbours(fid as u32) {
                if let Some(nf) = self.fields.get(n as usize) {
                    neigh_sum += nf.orogenic_uplift;
                    count += 1;
                }
            }
            let neigh_avg = if count > 0 { neigh_sum / count as f32 } else { 0.0 };
            // max(self, coupling × neigh_avg): never pulls a cell ABOVE
            // its existing uplift, only adds to cells with smaller values.
            // Result: tall central peak, broad shoulders.
            spread.push(self_u.max(SPREAD_COUPLING * neigh_avg));
        }
        for (i, v) in spread.iter().enumerate() {
            self.fields[i].orogenic_uplift = *v;
        }

        // Step 2: LIFT.
        for f in self.fields.iter_mut() {
            if f.orogenic_uplift > 0.0 {
                let lift = f.orogenic_uplift * OROGENY_UPLIFT_RATE * dt;
                f.elevation = (f.elevation + lift).min(OROGENY_ELEV_CAP);
            }
            f.orogenic_uplift *= UPLIFT_DECAY;
            if f.orogenic_uplift < 0.005 {
                f.orogenic_uplift = 0.0;
            }
            if f.plate_id.is_some() {
                f.mor_age_steps = f.mor_age_steps.saturating_add(1);
            }
        }

        // Step 3: SMOOTH elevation across the orogenic band. Only touches
        // cells with active uplift (above a small threshold) so the rest
        // of the planet is unaffected. Equal-weight average of self +
        // neighbour-mean → softens spikes into a rolling ridge.
        let elev_snapshot: Vec<f32> = self.fields.iter().map(|f| f.elevation).collect();
        for fid in 0..n_fields {
            if self.fields[fid].orogenic_uplift > 0.05 {
                let mut sum = elev_snapshot[fid];
                let mut count: u32 = 1;
                for &n in self.grid.neighbours(fid as u32) {
                    if let Some(nf) = self.fields.get(n as usize) {
                        // Only blend with continental cells so the smooth
                        // doesn't drag mountain elevation back toward
                        // adjacent ocean.
                        if nf.elevation > 0.0 {
                            sum += nf.elevation;
                            count += 1;
                        }
                    }
                }
                let neigh_mean = sum / count as f32;
                self.fields[fid].elevation =
                    0.5 * elev_snapshot[fid] + 0.5 * neigh_mean;
            }
        }
        t.lap(Phase::Resolve);

        // ── PHASE E: advance subduction (Hayba addition) ───────────────
        let field_diam = self.grid.field_diameter();
        self.advance_subduction(dt, field_diam);
        t.lap(Phase::Subduction);

        // ── PHASE F: try-detach loop. TODO Phase 4 — needs the slab
        // gradient calculator. Skipped for now.

        // ── PHASE G: bookkeeping ───────────────────────────────────────
        self.step_count += 1;
        self.sim_time_ma += dt;
        self.optimized_collision_detection = true;
        t.report(self.step_count);
    }

    /// Faithful port of TE's `verletStep` over all plates simultaneously.
    fn step_verlet(&mut self, dt: f32) {
        let area = self.grid.field_area_km2();
        let n = self.plates.len();
        if n == 0 {
            return;
        }

        // SV: build id→index map ONCE; reused by both predictor + corrector.
        let id_to_idx: HashMap<u32, usize> = self
            .plates
            .iter()
            .enumerate()
            .map(|(i, p)| (p.id, i))
            .collect();

        // a1 = torques at current state for ALL plates. SV-RAY: parallel
        // via rayon. Each plate's torque depends only on shared immutable
        // references (&fields, &plates, &id_to_idx, area) — no cross-plate
        // mutation, no shared accumulator. `collect::<Vec<_>>()` preserves
        // index order, so a1[i] is bit-identical to the serial version
        // (each plate's compute_total_torque_indexed sums over its OWN
        // fields in the SAME order on any thread).
        use rayon::prelude::*;
        let fields_ref = &self.fields;
        let plates_ref = &self.plates;
        let idx_ref = &id_to_idx;
        let a1: Vec<Vec3> = (0..n)
            .into_par_iter()
            .map(|i| {
                let t = plates_ref[i].compute_total_torque_indexed(
                    fields_ref, plates_ref, i, idx_ref, area,
                );
                acceleration_for(&plates_ref[i], t)
            })
            .collect();

        // v1, q1 saved per plate.
        let v1: Vec<Vec3> = self.plates.iter().map(|p| p.angular_velocity).collect();
        let q1: Vec<glam::Quat> = self.plates.iter().map(|p| p.quaternion).collect();

        // Advance ALL plates' quaternion + provisional velocity simultaneously.
        for i in 0..n {
            let v_half = v1[i] + a1[i] * (dt * 0.5);
            let q_new = crate::plate::plate::integrate_rotation_quaternion(q1[i], v_half, dt);
            let v_prov = v1[i] + a1[i] * dt;
            self.plates[i].quaternion = q_new;
            self.plates[i].angular_velocity = v_prov;
        }

        // a2 = torques at NEW state for ALL plates. SV-RAY: same rayon
        // pattern as a1 above. Re-bind the references because the
        // intermediate `for i in 0..n` provisional-update loop took
        // &mut self.plates[i].
        let fields_ref = &self.fields;
        let plates_ref = &self.plates;
        let idx_ref = &id_to_idx;
        let a2: Vec<Vec3> = (0..n)
            .into_par_iter()
            .map(|i| {
                let t = plates_ref[i].compute_total_torque_indexed(
                    fields_ref, plates_ref, i, idx_ref, area,
                );
                acceleration_for(&plates_ref[i], t)
            })
            .collect();

        // Apply the corrector + hot-spot decay per plate.
        for i in 0..n {
            let v_prov = self.plates[i].angular_velocity;
            let a_diff = a2[i] - a1[i];
            self.plates[i].angular_velocity = v_prov + a_diff * (dt * 0.5);
            self.plates[i].prev_angular_acceleration = a1[i];
            self.plates[i].angular_acceleration = a2[i];
            self.plates[i].update_hot_spot(dt);
        }
    }

    // -----------------------------------------------------------------
    // Phase 2/4 stubs — preserve TE call order on paper.
    // -----------------------------------------------------------------

    /// TE `model.ts:298 → forEachField(performGeologicalProcesses)`.
    /// Phase 2 — crust evolution, age, subducted-field marking. Stub no-op.
    fn perform_geological_processes(&mut self, _dt: f32) {
        // TODO Phase 2: per-field crust evolution.
    }

    /// TE `model.ts:299 → forEachPlate(plate.removeUnnecessaryFields)`.
    /// Phase 2 — drop fields that finished subducting. Stub no-op.
    fn remove_unnecessary_fields(&mut self) {
        // TODO Phase 2: subducted-field cleanup will go here.
    }

    /// TE `model.ts:300 → removeEmptyPlates`. Phase 4. Stub no-op.
    fn remove_empty_plates(&mut self) {
        // TODO Phase 4.
    }

    /// TE `model.ts:301 → generateNewFields` (mid-ocean-ridge spawning).
    /// Phase 2. Stub no-op.
    fn generate_new_fields(&mut self, _dt: f32) {
        // TODO Phase 2: MOR field generation. When a new field is spawned here,
        // set `field.mor_age_steps = 0` immediately after initialization so the
        // renderer correctly treats it as freshly-born crust. Example:
        //   field.mor_age_steps = 0;
    }

    /// TE `model.ts:306-313 → forEachPlate(plate.updateInertiaTensor)` (and
    /// `plateGroups.forEach(group.updateInertiaTensor)`). Implemented now
    /// because the cost is O(plates × fields_per_plate) per step and the
    /// inertia tensor must reflect the post-integrator field positions.
    fn update_inertia_tensors(&mut self) {
        let area = self.grid.field_area_km2();
        // PlateGroup-level recompute (TE updates group first, then any
        // ungrouped plates). Group bookkeeping is Phase 4 — we just iterate
        // standalone plates here.
        //
        // INE-RAY: each plate's update_inertia_tensor is independent —
        // it sums over the plate's OWN field-id list (no cross-plate
        // mutation) and reads only &self.fields immutably. Rayon
        // par_iter_mut splits the &mut self.plates safely; result is
        // byte-equal because per-plate sums are in fixed Vec order.
        use rayon::prelude::*;
        let fields_ref = &self.fields;
        self.plates.par_iter_mut().for_each(|p| {
            if p.group.is_none() {
                p.update_inertia_tensor(fields_ref, area);
            }
        });
        // TODO Phase 4: group.updateInertiaTensor() once PlateGroup carries
        // member plates.
    }

    /// TE `model.ts:314-318 → forEachPlate(plate.updateCenter)` on a stride.
    /// Phase 2 cosmetic. Stub no-op.
    fn update_centers(&mut self) {
        // TODO Phase 2: recompute Plate.center on CENTER_UPDATE_INTERVAL.
    }

    /// TE `model.ts:321-322 → tryToGroupPlates() + splitPlates`. Phase 4.
    fn group_and_split_plates(&mut self) {
        // TODO Phase 4.
    }

    /// TE `model.ts:322 → dividePlatesByAge`. Phase 4.
    fn divide_plates_by_age(&mut self) {
        // TODO Phase 4.
    }

    /// TE `model.ts:292 → forEachPlate(plate.calculateContinentBuffers)`.
    /// Phase 2 — sets `Field.is_continent_buffer = true` on oceanic fields
    /// adjacent to continental crust within N steps' worth of plate motion.
    ///
    /// The collision code already reads `is_continent_buffer`
    /// (`subduction/collision.rs:251`, `:294`, `:299`); the flag is
    /// permanently `false` until this routine is implemented.
    fn calculate_continent_buffers(&mut self) {
        // TODO Phase 2: walk continental fields' neighbours and mark
        // is_continent_buffer = true within `CONTINENT_BUFFER_RADIUS`.
    }

    /// Hayba Phase 3 — refresh the lithospheric mantle column under every
    /// oceanic field. Half-space cooling (Stein-Stein 1992) says oceanic
    /// lithospheric thickness grows as √age, so we recompute the column
    /// from `field.age` each step. Continental columns stay static
    /// (Artemieva 2009 — cratonic lithosphere does not thin appreciably
    /// on simulation timescales).
    ///
    /// `_dt` is accepted for symmetry with other per-step phases; the
    /// recomputation reads `field.age` directly rather than integrating.
    fn update_lithospheric_columns(&mut self, _dt: f32) {
        for f in self.fields.iter_mut() {
            if f.is_oceanic_crust() {
                f.refresh_oceanic_lithosphere();
            }
        }
    }

    /// Initialize a field's elevation + crust + lithosphere from the
    /// painted/preset wizard input. `continental` selects the branch;
    /// elevation is clamped to land (≥0) or ocean (<0) as appropriate.
    /// Mirrors wizard.rs:701-711 / bake_equirect.rs:106-116 byte-for-byte.
    pub fn apply_field_initial_state(&mut self, fid: usize, elevation: f32, continental: bool) {
        if let Some(f) = self.fields.get_mut(fid) {
            if continental {
                f.crust = crate::field::Crust::new_continental();
                f.elevation = elevation.max(0.0);
                f.become_continental_lithosphere(200.0);
            } else {
                f.crust = crate::field::Crust::new_oceanic();
                f.elevation = elevation.min(-0.0001);
                f.refresh_oceanic_lithosphere();
            }
        }
    }

    /// Assign a field to a plate: sets `f.plate_id` and calls
    /// `plate.add_field(fid)`. Used by `planet.rs::demo_model` to bucket
    /// unclaimed ocean cells into ocean plates.
    pub fn assign_field_to_plate(&mut self, fid: usize, pid: u32) {
        if let Some(f) = self.fields.get_mut(fid) {
            f.plate_id = Some(pid);
        }
        if let Some(p) = self.plates.iter_mut().find(|p| p.id == pid) {
            p.add_field(fid as u32);
        }
    }

    /// Recompute inertia for every plate using the current `fields` snapshot
    /// and grid area. Mirrors wizard.rs:714-718 / planet.rs:197-201 byte-for-byte
    /// (the clone is load-bearing: `update_inertia_tensor` borrows `&[Field]`
    /// while iterating `&mut self.plates`).
    pub fn refresh_plate_inertias(&mut self) {
        let area = self.grid.field_area_km2();
        let fields_ref = self.fields.clone();
        for p in self.plates.iter_mut() {
            p.update_inertia_tensor(&fields_ref, area);
        }
    }

    /// Set a single plate's angular velocity by id. Used by
    /// `apply_boundary_types` (wizard.rs:342-362).
    pub fn set_plate_angular_velocity(&mut self, pid: u32, omega: Vec3) {
        if let Some(p) = self.plates.iter_mut().find(|p| p.id == pid) {
            p.angular_velocity = omega;
        }
    }

    /// Set a single plate's density by id. Used by `apply_density_rank`
    /// (wizard.rs:384-386).
    pub fn set_plate_density(&mut self, pid: u32, density: f32) {
        if let Some(p) = self.plates.iter_mut().find(|p| p.id == pid) {
            p.density = density;
        }
    }

    /// Write back a slice of eroded elevations (land only — ocean cells
    /// untouched). Mirrors wizard.rs:743-748 byte-for-byte: applies
    /// `.max(0.0)` clamp and the `if !is_ocean[i]` predicate.
    pub fn apply_eroded_elevation(&mut self, elev: &[f32], is_ocean: &[bool]) {
        for i in 0..elev.len() {
            if let Some(f) = self.fields.get_mut(i) {
                if !is_ocean[i] { f.elevation = elev[i].max(0.0); }
            }
        }
    }

    /// Advance the `Subduction.dist` on each subducting field by one timestep.
    /// Mirrors the per-field call to `Subduction.update` that TE does inside
    /// `simulatePlatesInteractions` via `performGeologicalProcesses`.
    fn advance_subduction(&mut self, dt: f32, field_diameter: f32) {
        // Precompute neighbour-min dist for every field with an active
        // subduction record (TE: `update`'s `min_neighbour_dist` argument
        // — derived from neighbour subduction records). Iterate in id
        // order for determinism.
        //
        // SD: scratch buffer hoisted to `self.subduction_scratch` to avoid a
        // per-step allocation. Take it out via mem::take, write into the
        // local, swap back at end — preserves capacity across calls.
        //
        // SD T2: sparse outer iteration. Only fields where `f.subduction
        // .is_some()` need their scratch[fid] computed (Loop 2 only reads
        // scratch[fid] for those same fields). Building active_fids is a
        // single O(F) scan; both subsequent loops become O(active) instead
        // of O(F·6). Byte-equal: same arithmetic, same iteration order,
        // scratch values for inactive fields are never read.
        let n = self.fields.len();
        let mut scratch = std::mem::take(&mut self.subduction_scratch);
        scratch.clear();
        scratch.resize(n, 0.0);
        let mut active_fids = std::mem::take(&mut self.subduction_active_fids);
        active_fids.clear();
        for i in 0..n {
            if self.fields[i].subduction.is_some() {
                active_fids.push(i as u32);
            }
        }
        for &fid in &active_fids {
            let mut m = f32::INFINITY;
            for &nid in self.grid.neighbours(fid) {
                if let Some(nf) = self.fields.get(nid as usize) {
                    if let Some(s) = &nf.subduction {
                        if s.dist < m {
                            m = s.dist;
                        }
                    }
                }
            }
            scratch[fid as usize] = if m.is_finite() { m } else { 0.0 };
        }
        for &fid in &active_fids {
            let i = fid as usize;
            if let Some(s) = self.fields[i].subduction.as_mut() {
                let _ = s.update(dt, scratch[i], field_diameter);
            }
        }
        self.subduction_scratch = scratch;
        self.subduction_active_fids = active_fids;
    }
}

#[inline]
fn acceleration_for(p: &Plate, torque: Vec3) -> Vec3 {
    if p.mass > 0.0 {
        p.inv_moment_of_inertia * torque
    } else {
        torque
    }
}

/// Convenience: ensure the unused warning for OCEAN_DENSITY doesn't trip.
#[allow(dead_code)]
const _: f32 = OCEAN_DENSITY;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    fn tiny_world() -> Model {
        // Divisions=2 ⇒ 42 fields. Cheap.
        Model::new(2, 12345)
    }

    #[test]
    fn model_construction_initializes_grid_and_fields() {
        let m = tiny_world();
        assert_eq!(m.step_count, 0);
        assert_eq!(m.sim_time_ma, 0.0);
        assert_eq!(m.master_seed, 12345);
        assert_eq!(m.fields.len() as u32, m.grid.n_fields());
        assert!(m.plates.is_empty());
    }

    #[test]
    fn step_default_advances_by_dt_ma_and_reports_era() {
        let mut m = tiny_world();
        m.add_plate(0, 0xFF0000, OCEAN_DENSITY, &[0, 1, 2], false, Vec3::ZERO);
        m.step_default();
        assert!((m.sim_time_ma as f64 - crate::time::DT_MA).abs() < 1e-5);
        // sim_time_ma is in the present-day Cenozoic window.
        assert_eq!(m.current_era(), "Cenozoic");
    }

    #[test]
    fn model_step_advances_time_and_count() {
        let mut m = tiny_world();
        m.add_plate(0, 0xFF0000, OCEAN_DENSITY, &[0, 1, 2], false, Vec3::ZERO);
        m.step(5.0);
        assert_eq!(m.step_count, 1);
        assert!((m.sim_time_ma - 5.0).abs() < 1e-6);
        m.step(5.0);
        assert_eq!(m.step_count, 2);
        assert!((m.sim_time_ma - 10.0).abs() < 1e-6);
    }

    #[test]
    fn model_step_zero_plates_is_a_noop() {
        let mut m = tiny_world();
        m.step(1.0);
        assert_eq!(m.step_count, 1);
    }

    #[test]
    fn model_step_is_deterministic() {
        fn run() -> Vec<u8> {
            let mut m = Model::new(2, 99);
            m.add_plate(0, 0xAA3333, 3.0, &[0, 1, 2, 3, 4, 5], true, Vec3::new(0.0, 0.001, 0.0));
            m.add_plate(1, 0x3333AA, 1.0, &[20, 21, 22, 23, 24], false, Vec3::new(0.001, 0.0, 0.0));
            for _ in 0..50 {
                m.step(5.0);
            }
            // Serialise just the plates+fields summary so transient grid
            // bytes don't dominate.
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&bincode::serialize(&m.plates).unwrap());
            bytes.extend_from_slice(&bincode::serialize(&m.fields).unwrap());
            bytes.extend_from_slice(&m.step_count.to_le_bytes());
            bytes.extend_from_slice(&m.sim_time_ma.to_le_bytes());
            bytes
        }
        let a = run();
        let b = run();
        assert_eq!(a, b);
    }

    #[test]
    fn full_phase_pipeline_completes_for_simple_3_plate_setup() {
        let mut m = Model::new(2, 7);
        m.add_plate(0, 0, 3.0, &[0, 1, 2], true, Vec3::new(0.0, 0.001, 0.0));
        m.add_plate(1, 0, 1.0, &[10, 11, 12], false, Vec3::new(0.001, 0.0, 0.0));
        m.add_plate(2, 0, 2.0, &[20, 21, 22], false, Vec3::new(0.0, 0.0, 0.001));
        for _ in 0..100 {
            m.step(5.0);
        }
        assert_eq!(m.step_count, 100);
        assert!((m.sim_time_ma - 500.0).abs() < 1e-3);
    }

    #[test]
    fn collision_detected_when_two_plates_converge() {
        // Two plates both owning field 5 ⇒ immediate overlap. After one step
        // the collision should have flipped at least one field's `colliding`
        // OR set a subduction record.
        let mut m = Model::new(2, 1);
        // Different densities so subduction kind is decided deterministically.
        m.add_plate(0, 0, 3.0, &[5], false, Vec3::ZERO);
        m.add_plate(1, 0, 1.0, &[5], false, Vec3::ZERO);
        m.step(1.0);
        // Either a subduction record was created on the bottom field, or the
        // `colliding` flag was raised before the per-step reset. We assert on
        // the subduction record (persists across the reset).
        let f = &m.fields[5];
        assert!(
            f.subduction.is_some(),
            "expected subduction record on overlapping field; got {:?}",
            f
        );
    }

    // ---------------------------------------------------------------
    // BLOCKER 1 — MAX_PLATE_SPEED clamp must engage after the integrator.
    // ---------------------------------------------------------------
    #[test]
    fn max_plate_speed_clamp_engages_on_runaway_torque() {
        // Hand-set an absurd angular velocity directly on a plate and run
        // one step. Even if the integrator adds more, the post-step clamp
        // must bring the magnitude down to MAX_PLATE_SPEED exactly (within
        // float epsilon for the rescale).
        let mut m = Model::new(2, 1);
        m.add_plate(0, 0, 3.0, &[0, 1, 2, 3, 4], true, Vec3::ZERO);
        // Inject runaway angular velocity: 100× the clamp.
        m.plates[0].angular_velocity = Vec3::new(4.0, 0.0, 0.0);
        m.step(0.1);
        let len = m.plates[0].angular_velocity.length();
        assert!(
            (len - MAX_PLATE_SPEED).abs() < 1e-5,
            "expected clamp to bring magnitude to {}, got {}",
            MAX_PLATE_SPEED,
            len
        );
    }

    // ---------------------------------------------------------------
    // MAJOR 3 — `field.colliding` reset semantics must match TE
    // (reset BEFORE the scan, so post-step participating fields stay `true`).
    // ---------------------------------------------------------------
    #[test]
    fn field_colliding_flag_persists_after_step_for_participants() {
        // Two plates overlap on field 5 — collision detector flips
        // `field.colliding = true` during the scan; with the corrected reset
        // order, that flag must still be true at end-of-step.
        let mut m = Model::new(2, 1);
        m.add_plate(0, 0, 3.0, &[5], false, Vec3::ZERO);
        m.add_plate(1, 0, 1.0, &[5], false, Vec3::ZERO);
        m.step(1.0);
        assert!(
            m.fields[5].colliding,
            "expected field.colliding to remain true post-step (TE detectCollisions resets BEFORE the scan)"
        );
    }

    // ---------------------------------------------------------------
    // MAJOR 6 — inertia tensor must be recomputed every step.
    // ---------------------------------------------------------------
    #[test]
    fn inertia_tensor_recomputed_each_step() {
        let mut m = Model::new(2, 1);
        m.add_plate(0, 0, 3.0, &[0, 1, 2, 3, 4], true, Vec3::new(0.0, 0.01, 0.0));
        let m0_before = m.plates[0].moment_of_inertia;
        // Drive a non-trivial rotation so absolute field positions change
        // appreciably.
        for _ in 0..5 {
            m.step(5.0);
        }
        let m0_after = m.plates[0].moment_of_inertia;
        // World-frame inertia tensor depends on field absolute positions,
        // which rotate with the plate quaternion. After 5 steps with non-zero
        // angular velocity, the tensor must have moved at least a little.
        let diff = (m0_after.col(0) - m0_before.col(0)).length()
            + (m0_after.col(1) - m0_before.col(1)).length()
            + (m0_after.col(2) - m0_before.col(2)).length();
        assert!(
            diff > 1e-7,
            "expected inertia tensor to refresh each step; diff = {}",
            diff
        );
    }
}
