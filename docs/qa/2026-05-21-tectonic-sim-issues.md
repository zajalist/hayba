# Tectonic simulation — issues audit

_Date: 2026-05-21  ·  Branch: `feat/baking-pipeline`_

Honest playthrough audit based on Rust code-reading + IPC probes. I can't
reliably playtest visually (HMR keeps wiping React state); the issues
below are derived from reading the simulation code paths.

## LIVE PLAYTEST EVIDENCE (post-3713372)

Drove the running app via browser-harness end-to-end:
Compose → Load Earth → Bake → Next: Densities → Start simulation →
Save & start. Then sampled `step_planet_tick` + `step_planet` IPC
directly for 630 Ma of sim time.

**Headline metrics:**

| Metric | Value |
|---|---|
| Sim time advance rate | ~30 Hz (16 Ma per real second at speed 1×) |
| max cell drift | 0.237 over 100 steps (plates DO rotate) |
| `[sim] swapped to per-cell sim mesh` log | ✅ fires |
| Visible relief during play | ✅ continents drift visibly |
| Tick IPC counter sniff | ⚠️  Reports 0 even when sim advances — my window.invoke hook gets overwritten somehow, but sim_time + position deltas confirm real ticks. |
| max elevation pre-play | 0.69229287 |
| max elevation +500 Ma | 0.69229287 (IDENTICAL — zero growth) |
| cells with elevation > 0.5 | 167 → 167 (zero new mountains) |
| `n_orog` (cells with orogenic_uplift > 0) | **0** |
| `collision_kind_hist` after 5 steps | `{0: 40962}` (ALL cells non-colliding) |

**Root cause for "no orogeny":** It's not the orogeny→elevation conversion
(my fix in `2fbbebe` is correctly wired). It's that
`detect_field_collisions_opt` returns **empty** every step — no
collisions are ever firing despite plates rotating freely for 630 Ma.

So the orogeny fix is *correct* but downstream of a dead upstream signal.
Continents drift past each other without ever flagging a contact event.

This is suspected bug #6 (no drag-on-collision) compounded with what
appears to be a collision-detection threshold or topology issue. The
`detect_field_collisions_opt` logic projects each plate's cells into
every other plate's local frame and asks `grid.nearest_field`+
`plate.contains_field` — but this never resolves true. Worth checking
whether `grid.nearest_field` is finding the right index, or whether
`plate.contains_field` is testing a stale ownership map.

This needs a targeted Rust test: build a 2-plate model with deliberately
overlapping cell ownership (force the topology), step once, assert
`detect_field_collisions` returns a non-empty Vec.

## FIX VERIFIED (5f82e63)

Root cause was the optimized-mode short-circuit. `model.step()` ends with
`self.optimized_collision_detection = true`. Step 1 runs full-scan
(works). Steps 2+ use `optimize=true` which only scans cells where
`field.boundary || field.colliding` is true. `colliding` was reset at
top of every step, and **`field.boundary` was declared but never
assigned anywhere in the codebase**. So from step 2 onwards, the
detector's "considered" set was empty → zero collisions detected
forever → orogeny never fires → no mountains rise.

TE maintains `field.boundary` incrementally in `plate.ts::addField` /
`deleteField`. We never ported that wiring.

**Fix:** at the start of every `model.step()` (before collision reset),
walk all cells and set `field.boundary = (any neighbour has a different
plate_id)`. O(n × 6) per step, trivial at 1.5M cells.

**Verified by 2 new Rust tests:**

```
test subduction::collision::tests::
    collisions_fire_under_180deg_rotation_with_partitioned_plates ... ok
test subduction::collision::tests::
    orogeny_actually_fires_when_continents_collide                ... ok
```

The E2E test:
- Builds a Model::new(4, 7) with two continental plates partitioning
  the sphere (Y > 0 vs Y <= 0).
- Plate B gets ω = (0.02, 0, 0) so it rotates southern continent into
  northern.
- Steps 50× at dt=1.
- Asserts: n_colliding > 0, n_orog > 0, post_max_elev > pre_max + 0.01.
- Pre-fix: all three assertions fail (counts = 0, no elevation change).
- Post-fix: all three pass.

Full tectonics suite: 217 passed, 0 failed.

## CONFIRMED BUGS

### 1. [SHIPPED THIS BRANCH] globeMeshRef never assigned → sim invisible
`globeMeshRef` was declared in App.tsx:263 but the only writes were
attempts that never executed. The play loop's `updateFromTickSnapshot`
called `.current?.update...` on null forever. Tectonic sim advanced in
Rust but the visible mesh was the static equirect-baked sphere. **Fixed
in `6a18311` + `simMesh.ts`**: post-bake we build a per-cell mesh with
the same relief ramp as the painter preview; `handleConfirmStartSimulation`
swaps it in as the visible globe.

### 2. [SHIPPED THIS BRANCH] orogeny → elevation conversion missing
`subduction/collision.rs::orogeny` sets `field.orogenic_uplift = 1.0` on
convergent contact, but **no code converted that flag into actual
elevation gain**. Mountains never rose because the lift channel was a
dead-end. **Fixed in `2fbbebe`**: `model.rs::step` now integrates
`uplift × OROGENY_UPLIFT_RATE × dt` into `f.elevation` each step,
capped at OROGENY_ELEV_CAP = 1.0.

### 3. UI sim-time was frozen at bake value (cosmetic)
TickSnapshot perf path stopped calling setSnapshot, so the SimulatePanel
"Time" readout + StatusBar Era/Time chips read `snapshot.sim_time_ma`
which never advanced during play. **Fixed in `65b660d`**: added
`liveSimTimeMa` state updated from each tick; display layer prefers it
over the stale snapshot value.

### 4. Per-tick boundary lines update was no-op (consequence of #1+#2)
`boundaryLinesRef.current?.updatePositions(tickSnap.cell_positions)`
streams new positions into the seam-line buffer every frame. Worked
correctly, but since the *globe* didn't actually move (bug #1) AND the
*plate quaternions weren't applied to snapshot positions* (5c458d2 fixed
that earlier), the streamed positions were byte-identical every frame.
Now that #1 and the quaternion bug are both fixed, boundary lines
should drift visibly.

## SUSPECTED BUGS (not verified)

### 5. Plate group/split + plate death not visible
`group_and_split_plates` and `remove_empty_plates` exist in
`tectonics/src/model/model.rs` but are only called at bake time, not
during step. So **new plates can't form mid-sim, dead plates aren't
culled**. Verify by stepping a long sim and counting `model.plates.len()`
vs initial. Need a runtime call to these from `step()`.

### 6. Collisions don't slow plates down (no momentum exchange)
TE's `fields-collision.ts::applyDragForces` makes two converging plates
record each other as `draggingPlate`, then in `field.ts:222` the orogenic
drag force opposes plate motion. **Our Rust port has no drag-on-contact**.
Plates clash through each other rather than decelerating. Reading our
`compute_total_torque`: only ridge-push + slab-pull + basic drag, no
collision-coupled reaction force.

### 7. Subducted oceanic field never dies
TE marks an oceanic field between two converging continents as
`alive = false` so the continents can actually collide. Our Rust port
doesn't have `field.alive` (only `crust_age` + subduction progress).
Subduction proceeds but the cell is never removed from its plate, so
two continents trying to close an ocean basin push slab indefinitely.

### 8. Continents don't deform (cells stay in place relative to plate)
A plate is a rigid-body rotation: every cell on it follows the same
quaternion. There's no intra-plate deformation. **Real continents stretch
in extension, fold in compression** — neither happens. This is a TE
limitation too, not unique to our port. Out of scope for "TE parity".

### 9. Elevation can exceed the cap on multiple-tick orogeny
The `OROGENY_ELEV_CAP = 1.0` clamp I added applies *per step*; a cell
with elevation already at 1.0 and uplift 1.0 → still adds lift → then
clamps. Harmless but means the cap isn't a hard ceiling, it's a per-step
clamp. Need to be aware of this for tuning.

### 10. No earthquake / volcanic events
TE has `earthquake.ts` (stochastic boundary events) and
`volcanic-activity.ts` (subduction-zone volcanism). Our Rust port has
neither. Phase 5+6 of the TE port plan.

## VISUAL ARTIFACTS TO WATCH FOR (post-fix)

When you re-bake + Start simulation + Play on the new code:

- **Pink boundary lines should drift** with the plates (issue #4 fix).
- **Convergent seams should accumulate cream/brown elevation over ~20-50 Ma**
  of sim time (issue #2 fix). Look for new mountain belts forming
  along arrows where convergent flags are set.
- **Plate count stays constant** (issue #5 not fixed) — no new plates
  spawning, no plates dying. Sim is geologically static at the
  plate-population level.
- **Plates can drift through each other** (issue #6 not fixed) — without
  collision drag, expect velocities to NOT decrease on impact. The
  Himalayas-style "India crashes and decelerates" geology won't happen.
- **No volcanoes, no quakes** (issue #10 not fixed). Pure plate motion
  + orogeny.

## Test plan you can run after rebake

In DevTools console (F12 inside the Tauri WebView):

```js
// (1) Confirm sim is live + cells move:
const inv = window.__TAURI_INTERNALS__.invoke;
const a = await inv("step_planet_tick", { nSteps: 0 });
const b = await inv("step_planet_tick", { nSteps: 100 });
let max_dx = 0;
for (let i = 0; i < a.cell_positions.length; i += 3) {
  const dx = b.cell_positions[i] - a.cell_positions[i];
  const dy = b.cell_positions[i+1] - a.cell_positions[i+1];
  const dz = b.cell_positions[i+2] - a.cell_positions[i+2];
  max_dx = Math.max(max_dx, Math.hypot(dx, dy, dz));
}
console.log("max cell drift over 100 steps:", max_dx); // should be > 0.1

// (2) Confirm orogeny lifts elevation:
let max_e = 0, count_above_05 = 0;
for (const e of b.cell_elevation) { max_e = Math.max(max_e, e); if (e > 0.5) count_above_05++; }
console.log("max elevation:", max_e, "cells > 0.5:", count_above_05);
// After 100 steps of post-bake play, max_e should be 0.5-1.0 if any
// convergent collision happened; count > 0 indicates mountain belts.
```

If max_dx > 0 and max_e > pre-play-max, the Rust sim is fully working
and any "doesn't move" report is a frontend/material issue, not a sim issue.
