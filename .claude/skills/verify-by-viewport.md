---
name: verify-by-viewport
description: Use after any UE scene mutation (spawn, scatter, PCG execute, foliage paint, landscape edit). Mandates capture_viewport + instance-count verification BEFORE claiming success. "componentsExecuted: 1 with zero instances" is the canonical false-success pattern — never trust a tool's return value as proof of visible effect.
---

# verify-by-viewport

A tool returning `ok: true` is not evidence the scene changed. PCG returning `componentsExecuted: 1` is not evidence anything spawned. A spawn returning a handle is not evidence the actor is visible at the expected location. Every mutation needs **three** independent verifications before you claim success.

## The 3-step checklist (run all of them, in order)

### 1. `actor_list` — count and tags match expectation
- Filter by tag or class for the actors you just touched.
- Assert: count matches what you intended to create.
- Assert: scales, transforms, and tags match what you set.
- If you mutated an existing actor, diff against the previous `actor_list` snapshot; isolated, round-number, single-axis changes likely came from the **user**, not a bug — see `[[actor-position-drift-after-user-edit]]` rule before "correcting" them.

### 2. HISM instance counts (mandatory for PCG / Foliage)
- After `hayba_execute_pcg_graph`, query the HISM components on the relevant actor(s).
- **Zero instances == failure**, even if `componentsExecuted: 1`. The graph ran; it produced nothing.
- Canonical cause: `PCGSurfaceSamplerSettings` fed by a non-Landscape source (see `[[pcg-surface-sampler-needs-landscape]]`).
- For Foliage paint: read the `InstancedFoliageActor` per-type instance count.

### 3. `editor_capture_viewport` — visible result
- Capture a screenshot from a camera that frames the change.
- Look at the image. Don't just save it.
- For hero props: are they at the expected pixel location? Are their bases seated on the ground (watch for pivot offsets — see `[[gianttree-01-pivot-offset]]`)?
- For PCG / Foliage: is the density what you'd expect? Are there bald patches around hero props (`foliage_no_edge_density`)?
- For lighting / PPV: are exposure and color what you intended? Hero objects not blown out?

## The canonical false-success pattern

```
hayba_execute_pcg_graph → { componentsExecuted: 1 }
agent: "✓ PCG executed — ~140 trees, ~800 shrubs, ~4800 grass clusters"
reality: HISM instance count == 0 across all components
```

This happened in the 2026-05-23 PCG/landscape session. The agent reported four nested wrong counts as success, the user had to point out empty viewport. **`componentsExecuted` is a "graph evaluation attempted" counter, not a spawn count.** Always read instance counts before claiming spawn success.

## Other failure modes this catches

- **Pivot drift:** `actor_spawn` returns success but the mesh's authoring pivot is above the visual base, so the actor floats. Caught by viewport screenshot.
- **Wrong-tab spawn:** the mutation hit a different sublevel / WP cell that isn't loaded. Caught by `actor_list` returning 0.
- **Silent material fallback:** texture/material path was invalid, engine substituted default. Caught by viewport — the asset looks checker / grey.
- **User edit overwrite:** user manually moved a tree to z=-380 to seat the roots; agent reads `actor_list` diff, assumes drift, clamps back to z=0. Caught by *not* auto-correcting isolated user-style edits.

## Do this even when you're confident

Especially when you're confident. Confidence is the failure mode. The cost of a screenshot is seconds; the cost of "PCG executed" reported four times across an unfinished scene is the user's afternoon.
