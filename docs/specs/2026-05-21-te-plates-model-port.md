# TE plates-model → Hayba Rust port

_Date: 2026-05-21  ·  Branch: `feat/baking-pipeline`  ·  Scope: ~4700 LOC TS → Rust_

## Goal

Port TE (`tectonic-explorer/packages/tecrock-simulation/src/plates-model/`)
into the Rust `hayba-tectonics-v2` crate so the simulation has full TE
parity: drag-on-collision, plate split/merge, oceanic-field death
between converging continents, volcanic activity, earthquakes, subduction
state machine.

Current Rust crate has the bones (`resolve_field_collision`,
`group_and_split_plates`, `orogenic_uplift`, `advance_subduction`) but is
missing most of the dynamics that make TE feel alive.

## TE module inventory (4687 LOC)

| TE file | LOC | Maps to (Rust) | Status |
|---|---|---|---|
| `field.ts` | 460 | `field/field.rs` | partial — needs `draggingPlate`, `colliding`, `alive`, `isContinentBuffer` |
| `fields-collision.ts` | 58 | `subduction/collision.rs` | partial — `applyDragForces` + buffer logic missing |
| `subduction.ts` | 156 | `subduction/` | partial — state machine, `setCollision` missing |
| `model.ts` | 611 | `model/model.rs` | partial — orogeny→elevation FIX SHIPPED; plate lifecycle missing |
| `plate.ts` | 389 | `plate/plate.rs` | partial — `sortFields`, `mergePlate`, group logic missing |
| `plate-group.ts` | 85 | `plate/` | missing entirely |
| `volcanic-activity.ts` | 227 | new `subduction/volcanism.rs` | missing entirely |
| `earthquake.ts` | 93 | new `subduction/earthquake.rs` | missing entirely |
| `volcanic-eruption.ts` | 48 | (folded into volcanism) | missing |
| `crust.ts` | (in shared) | `field/crust.rs` | partial — rock layering ok, needs more types |
| `subplate.ts` | 73 | (folded into plate) | missing |
| `generate-plates.ts` | 53 | (in `wizard.rs`) | done, port the rest as needed |
| `mark-islands.ts` | 56 | new `model/islands.rs` | missing |
| `get-temp-and-pressure.ts` | 109 | `model/temperature.rs` etc. | partial |
| `get-cross-section.ts` | 481 | (UI tool, lower priority) | not needed for sim |
| `model-output.ts` | 243 | (UI snapshot, equiv to `planet.rs`) | done equiv |

## Phased plan

Each phase ships independently. The PR can be merged after any phase
delivers visible improvement without breaking the existing flow.

### Phase 1 — Make existing collisions visible **(SHIPPED)**
Orogeny → elevation in `model.rs::step()` end-of-D-phase loop. Already
in this branch. Mountains rise at convergent boundaries where
`resolve_field_collision` flags uplift.

### Phase 2 — Drag forces (the "collisions stop movement" feel)
- Port `applyDragForces` (TE `fields-collision.ts:5-12`) into
  `subduction/collision.rs`.
- Field needs a `dragging_plate: Option<u32>` to record which plate is
  pulling on it.
- In `compute_total_torque` (or `step_verlet`), accumulate the drag
  reaction force from `dragging_plate` against the field's plate so
  contacts decelerate both bodies.
- Verify two convergent plates slow down on impact.

### Phase 3 — Plate lifecycle (form & die)
- Port TE `model.ts::removeDeadFields` + `splitPlates` + `mergePlates`.
- `field.alive` flag. Oceanic fields between two continental buffers
  flip to `alive=false`, then get removed.
- `Plate.sortFields`, `Plate.mergePlate` for joining halves.
- Wizard's existing `group_and_split_plates` becomes the runtime split
  trigger when a plate fractures along a divergent boundary.

### Phase 4 — Subduction state machine
- Port TE `subduction.ts` (156 LOC). Subduction is per-field: has its
  own `dist`, `topField`, lifecycle. Drives crust thinning, melt
  generation upstream of volcanism.

### Phase 5 — Volcanic activity + eruptions
- TE `volcanic-activity.ts` (227 LOC) + `volcanic-eruption.ts` (48).
- Per-field VolcanicActivity instances bound to subduction. Emits
  eruptions at intervals → adds elevation + volcanic-rock layer.

### Phase 6 — Earthquakes
- TE `earthquake.ts` (93 LOC). Stochastic events at boundary fields,
  proportional to local plate-relative speed. Mostly visual but they
  ripple into surface elevation noise.

### Phase 7 — Snapshot extensions
- TickSnapshot grows `cell_dragging_plate`, `cell_alive`, etc. so the
  JS side can visualize collision drag + dying cells.
- Boundary lines redraw per tick when cell→plate assignments change
  (subduction reassigns the bottom field's plate to absorbed).

## Risk register

- **Determinism**: TE uses Math.random in a few spots
  (earthquake placement). Rust port must use a seeded PRNG so the same
  bake replays identically.
- **Performance**: 1.5M cells. TE never ran at this scale (~64K typical).
  Phases 2-3 are O(boundary cells), so safe; Phase 5-6 are O(active
  subductions). Profile after each phase before next.
- **Snapshot bandwidth**: per-tick TickSnapshot already 1.5M floats.
  Adding `cell_alive`, `cell_dragging_plate` doubles IPC payload.
  Mitigate: only ship structural deltas every N ticks (every ~10
  frames feels live enough for second-scale processes like orogeny).

## What I'm shipping tonight

Phase 1 only (orogeny → elevation). Phases 2-6 require careful design
discussion before commit because they touch field memory layout +
boundary line topology + the snapshot bandwidth contract. Will scope a
Phase 2 PR for tomorrow once you've seen Phase 1 in action.
