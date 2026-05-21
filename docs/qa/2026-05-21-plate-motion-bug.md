# Critical bug: plates weren't moving during Simulate

_Date: 2026-05-21  ·  Branch: `feat/baking-pipeline`  ·  Severity: P0_

## TL;DR

The Simulate phase advanced sim time but cell positions never changed. Plates
appeared completely frozen. **Root cause:** `snapshot_model` and
`tick_snapshot_model` were serializing `grid.position(fid)` — the immutable
icosphere base coordinate — instead of multiplying by each cell's plate
quaternion. The plate.quaternion accumulator was working correctly inside Rust;
it just never reached the JS side.

**Fix shipped** (`5c458d2`) + regression test (`e4a7d40`). The full sweep of
behaviour described in earlier QA reports presumed plates were moving even
when subtly — they weren't. The boundary-line per-tick updatePositions
(`44de9c4`) was correct code but had no effect because positions never
actually changed across ticks.

## How I found it

Direct Tauri IPC call from the browser-harness, comparing `cell_positions`
across calls with increasing `nSteps`:

```js
const inv = window.__TAURI_INTERNALS__.invoke;
const a = await inv("step_planet_tick", { nSteps:   0 });
const c = await inv("step_planet_tick", { nSteps: 100 });
// a.sim_time_ma = 2.5,  c.sim_time_ma = 62.5  — model is stepping ✓
// a.cell_positions[0..3] === c.cell_positions[0..3]              ✗
// dx (cell 0)    = 0
// dx (cell 20000) = 0
```

Sim time advances normally. Cell positions are byte-identical. So
`model.step(dt)` runs, plate.angular_velocity integrates, plate.quaternion
accumulates — but the snapshot reads `grid.position(fid)` which is the
fixed icosphere base coordinate.

## The fix

`apps/hayba-explorer/src-tauri/src/planet.rs`:

```rust
let plate_q: HashMap<u32, Quat> = model.plates.iter()
    .map(|p| (p.id, p.quaternion))
    .collect();
for fid in 0..n_cells {
    let local = model.grid.position(fid);
    let q = match model.fields[fid as usize].plate_id {
        Some(pid) => plate_q.get(&pid).copied().unwrap_or(Quat::IDENTITY),
        None      => Quat::IDENTITY,
    };
    let world = q * local;    // ← rotation applied here
    cell_positions.extend([world.x, world.y, world.z]);
}
```

Applied to both `tick_snapshot_model` (per-rAF hot path) and `snapshot_model`
(post-bake / pause refresh).

## Regression test

`tick_snapshot_positions_move_with_plate_rotation` in `planet.rs` builds a
4-plate model with non-zero omegas, snapshots positions, runs 5 sim steps,
re-snapshots, asserts at least one cell drifted >1e-4. The pre-fix code
yielded `max_dx == 0`. Now passes.

## What this unblocks

- The boundary-line `updatePositions(cellPositions)` per-tick fast path
  (shipped in `44de9c4`) is now actually doing visual work — before, it
  was re-streaming identical positions every frame.
- The per-tick `TickSnapshot` perf path (`d8d062b`) is also doing real
  work now.
- The user's repeated reports of "plates aren't moving" / "barely any plate
  movement" were 100% accurate — not a perception or omega-magnitude issue.

## What's still missing

- `plateLabels.update()` and `forceArrows.update()` are still snapshot-bound,
  not per-tick. They'll re-render correctly on pause but freeze during
  active play. Same kind of `updatePositions(cellPositions)` extension that
  `boundaryLines` got would unfreeze them.
- The pole labels ("N" / "S" sprites) sit on the world axis, not on a
  rotating plate, so they correctly stay anchored regardless.

The QA pass should be re-run after a Rust rebuild to validate motion is
visible end-to-end. Earlier visual screenshots in `.scratch/qa/` were taken
under the broken code; the planet may now look noticeably more alive.
