# TE-vs-Hayba structural audit

_Date: 2026-05-21  ·  Branch: `feat/baking-pipeline`  ·  Author: deep dive after a day of patch-by-patch fixes_

## TL;DR

We've been fixing **symptoms**. The architecture is missing **3 load-bearing invariants** that TE maintains and we don't. Until those land, the simulation will keep producing artifacts (ghost-loop islands, drift smear, fake hard-cliff collisions) no matter how many edge cases we patch.

The three missing invariants:

1. **MOR field generation** (`generateNewFields`) — cells spawn behind plates as they drift apart at divergent boundaries. Without this, the cell-to-plate map only ever loses cells (subduction), never gains them. Gaps open between plates that the renderer has to fake.

2. **`field.alive` + `removeUnnecessaryFields`** — fully-subducted cells are flagged dead and removed from their plate's cell set. Without this, subducted cells linger in the plate, distorting boundary computation.

3. **Crust thickness as the elevation source** (TE's `field.elevation` is a getter from `crust.thicknessAboveZeroElevation()`, not a stored field that we add/subtract from). Orogeny grows mountains by **thickening crust**, not by adding to elevation. Our `elevation += lift × dt` is a cheap proxy that misses the gradient + neighbour averaging that makes TE's mountain belts look organic.

Everything else (volcanism, earthquakes, drag forces, plate split/merge) is **additive flavor** on top of those three load-bearing pieces. Build those first.

---

## TE step orchestration (model.ts:255)

```
step(timestep):
  1. INTEGRATE   verletStep / rk4Step / eulerStep
  2. SPEED CLAMP   plate.ω clipped to MAX_PLATE_SPEED
  3. simulatePlatesInteractions:
     a. forEachField: performGeologicalProcesses(dt)
                      ↳ handles subduction advance, crust update, orogeny lift
                        based on flags SET LAST STEP
     b. forEachPlate: removeUnnecessaryFields()
                      ↳ drop cells with alive=false
     c. removeEmptyPlates()
                      ↳ cull plates that lost all cells
     d. generateNewFields(dt)
                      ↳ for each plate's adjacentFields halo, if no collision
                        with another plate at that world position, accumulate
                        noCollisionDist; when it exceeds 0.9 × cellDiameter,
                        SPAWN a new cell in the plate (continent if stretching
                        existing continental neighbour, ocean otherwise)
     e. updateInertiaTensor for each plate (cells added/removed)
     f. updateCenter every N steps
     g. tryToGroupPlates / splitPlates / dividePlatesByAge
  4. calculateDynamicProperties(optimize=true):
     a. plate.calculateContinentBuffers — sets is_continent_buffer on oceanic
        cells whose continental neighbours are about to collide
     b. detectCollisions(true):
        For each plate's adjacentFields (or boundary cells in optimize mode):
          project world position into every OTHER plate; if that plate also
          has a cell there, call fieldsCollision(bottom, top) which MARKS:
            - field.colliding = true
            - field.draggingPlate = otherPlate
            - field.subduction = new Subduction(...) (for oceanic bottom)
        Marks persist into NEXT step's performGeologicalProcesses.
  5. Divergence check (kineticEnergy > 500 → abort)
```

## Hayba step orchestration (model.rs:240)

```
step(dt):
  A.  PHASE A: integrate (step_verlet)
  B.  PHASE B: speed clamp + plume update
  C.  PHASE C-pre: boundary flag recompute  [Hayba addition]
                   (because we don't maintain adjacentFields like TE does)
  D.  PHASE C: reset colliding flag
  E.  PHASE D: detect_field_collisions + resolve_field_collision IN-LINE
                ↳ sets orogenic_uplift, colliding, dragging_plate,
                  subduction NOW (TE does this at END of step instead)
  F.  PHASE D-late: subducted-cell ownership transfer  [Hayba addition]
                    with edge-guard
  G.  PHASE D-mid: orogeny → elevation (spread + lift + smooth)  [Hayba addition]
  H.  PHASE D-end: orogenic_uplift decay, mor_age_steps++
  I.  PHASE E: advance_subduction
  J.  PHASE F: try-detach loop  [STUB — TODO Phase 4]
  K.  PHASE G: bookkeeping (step_count++, sim_time_ma += dt,
               optimized_collision_detection = true)
```

### Critical structural differences

| TE | Hayba |
|---|---|
| `generateNewFields` SPAWNS new cells at divergent boundaries every step | **STUB** — no field generation. Gaps open as plates drift apart. |
| `removeUnnecessaryFields` drops alive=false cells | **STUB** — subducted cells linger forever |
| `field.elevation` is a **getter** derived from `crust.thicknessAboveZeroElevation()` + ridge/bending modifiers | `field.elevation` is a stored f32, mutated by `elev += uplift × rate × dt` |
| `adjacentFields` set maintained per plate via `addField`/`deleteField` | **NOT MAINTAINED** — we recompute `boundary` flag from scratch every step |
| `performGeologicalProcesses` runs at TOP of step using flags set LAST step | Collision detect+resolve+lift all run IN ONE STEP — flags don't persist |
| `markIslands` tags small landmasses as "island" crust composition | **NOT PORTED** |
| `calculateContinentBuffers` flags oceanic cells about to be crushed between converging continents | Continent-buffer logic exists (model.rs:568) but `KillBottomOcean` collision branch isn't emitted by `classify_collision` because `is_continent_buffer` is never set in our flow |

---

## Why the user's screenshots look wrong

### Ghost-loop islands (image #3)

User screenshot: small closed-loop pink boundary chains snaking along the main seam, looking like Hawaii-style island chains.

**Root cause hypothesis (in priority order):**

1. **boundaryLines.ts cached stale topology** — `updatePositions` only re-streamed positions, never rebuilt the segment list when cells transferred plates. **FIXED today in `8c28c60`** by detecting plate-id changes and triggering a full triangle-walk rebuild.

2. **Voronoi bake-time noise** — wizard assigns each cell to its nearest plate centroid. Near triple junctions, this can produce single-cell or 2-cell isolated clusters that LOOK like islands from day 1. TE avoids this by using image-presets (clean color partitions) instead of voronoi from centroids.

3. **Subduction transfers strand cells** — when neighbours of a B-cell all transfer to A but the B-cell itself doesn't (because its A-neighbours don't qualify under the edge-guard), the B-cell becomes a 1-cell island marooned in A territory. **Not the cause this time** (user said so explicitly), but a real edge case.

**The fix for #1 ships today. #2 and #3 likely also contribute and will need a bake-time + post-step island-merge sweep — but only after a real visual audit confirms each.**

### Drift smear (image #2)

Triangles that span 2 plates stretch into long thin strips when those plates rotate independently. The triangle has one vertex on plate A and one on plate B; A rotates one way, B the other; the triangle becomes a streak.

**FIXED today in `170dcfe`** — sim mesh index buffer filters out triangles whose 3 vertices don't share a plate_id.

### Fake hard-cliff collisions (image #5)

User screenshot: a flat green plateau meeting blue ocean with a sharp vertical cliff, no gradient.

**Root cause: our elevation model is wrong.**

TE: `field.elevation` is a GETTER:
```ts
get elevation() {
  let modifier = 0;
  if (this.bendingProgress && this.oceanicCrust) {
    modifier += config.subductionMinElevation * this.bendingProgress;
  }
  if (this.normalizedAge < 1) {
    modifier += config.oceanicRidgeElevation * Math.pow(1 - this.normalizedAge, 0.5);
  }
  return this.crust.thicknessAboveZeroElevation() - CRUST_BELOW_ZERO_ELEVATION + modifier;
}
```

So elevation = `crustThickness above zero` − constant + bending/ridge modifier. As crust thickens (orogeny adds to thickness), elevation rises NATURALLY because thickness is the source. Adjacent cells with similar thickness have similar elevation → no cliffs.

Hayba: `f.elevation` is a stored f32. We bump it with `f.elevation += uplift × rate × dt`. The uplift spread+smooth I added partially mimics gradient growth, but it's a band-aid. Cells with high uplift jump up; their neighbours with zero uplift stay flat → cliff.

**Fix path:** model `crust.thickness` as the primary state, derive `elevation` from it (TE-style getter). Orogeny THICKENS crust over a band; thickness diffuses to neighbours; elevation derives naturally. This is a real refactor of the data model.

### Plate boundaries not breathing organically

TE: `addField` and `deleteField` on a plate update `adjacentFields` (the halo set) + flip `field.boundary` on touched cells. The boundary set EVOLVES INCREMENTALLY as cells get added/removed. Combined with `generateNewFields` spawning cells behind drifting plates and `removeUnnecessaryFields` killing subducted cells, the cell-to-plate map continuously evolves.

Hayba: cells transfer only via my Subduction transfer code (★ shipped `f765519`). No spawning of new cells, no removal of subducted ones (other than ownership flip). The cell SET each plate owns mostly stays the same; only ownership flips on a few cells per step. Boundaries don't really BREATHE — they shift slightly via subduction transfers and that's it.

---

## What's load-bearing vs flavor

### Load-bearing (without these, nothing else will look right)

| # | What | Why | Effort |
|---|---|---|---|
| **L1** | **MOR field generation** (`generateNewFields` proper port) | Divergent boundaries need new cells to spawn. Without it, plates drift apart and leave gaps that nothing fills — visual smear, no realistic mid-ocean ridges, no organic plate growth | 6-8h |
| **L2** | **`field.alive` + cell removal pipeline** | Subducted cells need to genuinely disappear, not just transfer plates. Fully-buried slab cells shouldn't keep showing up as territory of the overriding plate | 3-4h |
| **L3** | **Crust-thickness → elevation getter** | Mountains rise organically when crust thickens, not when we bump elevation directly. Removes the cliff artifacts and makes orogeny look like real geology | 4-6h |

### Flavor (look great but pointless if L1/L2/L3 aren't in)

| # | What | Effort | Visual impact when L* in place |
|---|---|---|---|
| F1 | Drag forces on collision (plate decelerate) | 2-3h | Plates slow on impact, India-Asia geology |
| F2 | Continent buffer + alive flag combo (kill oceanic between continents) | 3h | India-Asia closure works properly |
| F3 | Subduction state machine (per-field crust thinning, slab pull) | 3-4h | Trench → arc → backarc band structure visible |
| F4 | Volcanic activity + eruptions | 3-4h | Volcano cones at arcs, secondary lift |
| F5 | Earthquakes | 2h | Cosmetic + slope noise |
| F6 | Kernel-based orogeny typing (Andean / Himalayan / island arc / rift) | 4-6h | Correct mountain shapes per geology |

### Tooling (force-multiplier — build before the heavy lifts)

| # | What | Why | Effort |
|---|---|---|---|
| **T1** | **Headless sim oracle binary** — Rust bin that runs N sim steps, dumps equirect relief PNG + cell-plate-id PNG + boundary-line PNG. **No Tauri, no React, no HMR.** | Decouples sim correctness from the UI rebuild cycle that's been wasting 90% of every iteration today. Every L*/F* fix can be verified deterministically. | 2-3h |
| **T2** | Bake-time plate-assignment cleanup — sweep voronoi result, absorb 1-cell and 2-cell pockets into majority neighbour plate | Prevents the bake-time noise that compounds with sim-time transfers to produce ghost loops | 1h |

---

## Recommended sequence

1. **T1 (oracle binary)** — 2h. Builds the loop. Everything below benchmarks against PNG diffs, no harness/HMR roulette.
2. **T2 (bake cleanup)** — 1h. Quick win, eliminates baseline noise.
3. **L1 (MOR generation)** — 6h. The biggest "boundaries are alive" payoff. Cells spawning behind drifting plates means no more gaps + ridge boundaries get real shape.
4. **L2 (field.alive + removal)** — 4h. Pairs with L1 — what spawns must die.
5. **L3 (crust→elevation getter)** — 6h. Refactor data model so `elevation` is derived. Kills the cliff artifacts and makes orogeny gradient-organic by construction.
6. **F1 (drag)** — once L1/L2/L3 in place, real geology emerges
7. **F2 (continent buffer)** — needs L2's alive flag
8. **F3–F6** — flavor on top of a now-correct sim

**Total: ≈ 30-35h of careful work to reach a structurally TE-faithful sim.** Half that gets us to "looks believable at a glance". Each milestone is independently shippable.

---

## What I'd NOT do

- ❌ More boundary-line filtering / island-cleanup sweeps. They're symptom patches. Once L1 spawns cells properly, the underlying plate-id map won't have these pathological pockets and the boundary-line drawer won't need to defend against them.
- ❌ More live click-through harness verification while HMR is in the loop. T1 (oracle binary) gives 100× tighter iteration. Spend 2h there, save dozens of hours later.
- ❌ Keep refining orogeny shape parameters (decay rate, spread coupling, lift rate). Until L3 is in, those parameters are tuning the wrong model.

---

## What's shipped today on `feat/baking-pipeline`

| Commit | Fix |
|---|---|
| `5f82e63` | Per-step `field.boundary` recompute → collisions actually fire |
| `2fbbebe` | Orogeny → elevation conversion (cells with uplift > 0 get lifted) |
| `202ecc6` | Band-shaped uplift (spread + smooth) instead of point spikes |
| `f765519` | ★ Subducted cells transfer ownership (boundaries shift over time) |
| `170dcfe` | Cross-plate triangles dropped from sim mesh (no more drift smear) |
| `8c28c60` | Boundary-line segment topology rebuilt when plate ids change |

Total: 6 commits closing real bugs. None of them get us past the L1/L2/L3 ceiling. The audit above is the next session's compass.
