# Frame-Stream Format Gap (HAYBA v1 vs HAYV2)

**Date:** 2026-05-14
**Status:** Documented; resolution deferred to Hayba Explorer build

## Summary

The Rust crate (`hayba-tectonics-v2`) emits a frame-stream format called **HAYV2** that is **strictly simpler** than the legacy **HAYBA v1** format the JS decoder was written for. They share the per-frame record framing (`u32 frame_idx | u32 payload_size | <payload>`) and the 32-byte header layout, but everything else diverges.

## Differences

### Initial-state block

| HAYBA v1 (per cell) | HAYV2 (per cell) |
|---|---|
| `u32` plate id | `u16` plate id (`0xFFFF` = NO_PLATE) |
| `i16` elevation (meters) | `f32` elevation (sim units) |
| `u8` composition | — |
| `u8` rift progress | — |
| `u16` failed-rift age | — |
| `u16` LIP age | — |
| `u8` volcanic activity | — |
| `u16` age (Ma) | — |
| `u8` is_continental | `u8` is_continental |
| Plate blocks: `u32 n` + 28-byte block × n | — (no plate blocks) |
| MOR blocks: `u32 n` + variable-size block × n | — (no MOR blocks) |

HAYV2 carries **no plate-level metadata** — no omega, no birth_step, no hue/color, no MOR. Plates exist only implicitly as the set of cells sharing a plate-id.

### Per-frame deltas

HAYBA v1 (single-record tags):
- `0x01 CELL_PLATE`: `u32 idx | u32 new_plate`
- `0x02 CELL_ELEV`: `u32 idx | i16 elev`
- ...

HAYV2 (count-prefixed batches):
- `0x01 CELL_PLATE_DELTA`: `u32 count | count × (u32 cell, u16 plate_id_or_0xFFFF)`
- `0x02 CELL_ELEV_DELTA`: `u32 count | count × (u32 cell, f32 elevation)`
- `0x03 CELL_CONTINENTAL_DELTA`: `u32 count | count × (u32 cell, u8 is_continental)`
- `0x40 KEYFRAME`: duplicate of initial-state block
- `0x41 SIM_TIME_MA`: `f32 sim_time_ma | u16 era_len | utf8 era_name`

HAYV2 carries no `PLATE_SPAWN`, `PLATE_RETIRE`, `PLATE_MOTION`, `PLATE_SEED`, `PLATE_DEATH`, `MOR_SPAWN`, `MOR_RETIRE`, `BOUNDARY_POLYLINES`, climate, or plume records — even though the v2 encoder module **does** define tag IDs for many of these. The CLI surface (`te-port run`) wires only the minimal three deltas plus keyframe + sim-time.

### frame_idx convention

- HAYBA: `frame_idx` is 0-indexed, range `[0, total_frames)`.
- HAYV2: `frame_idx` is 1-indexed, range `[1, total_frames]`.

The frame-zero state is the initial-state block; HAYV2 writes its first delta at `frame_idx=1`.

## What the JS decoder now does

`packages/frame-stream/index.js` accepts both magic strings:

- On **HAYBA** stream: full legacy path — all tags supported, animation replays correctly. (Existing 57-assertion smoke test still green.)
- On **HAYV2** stream:
  - Parses the simpler initial state via `parseInitialStateV2`.
  - `FrameCache.seek(i)` short-circuits — returns the initial state for every `i`. No animation. This is enough to validate geography (which cells are continental vs ocean, plate-id assignments per cell) but not plate motion or time evolution.
  - Skips the frame-offset scan (HAYV2 frame_idx range diverges from HAYBA's).

## What this means for Phase 10.1 acceptance

Original bar (geography + plate motion correct):
- ✅ **Geography** — readable. JS decoder loads HAYV2; TE consumer (`frame-stream-consumer.ts`) synthesizes plate entries from per-cell plate-id buckets; cells render at correct sphere positions (validated by L1 audit).
- ❌ **Plate motion** — blocked. HAYV2 carries no plate-motion data. Validating plate rotation against the sim is not possible against the current `te-port` output.

## Resolution path

Two options exist; the design spec at `docs/superpowers/specs/2026-05-14-hayba-explorer-design.md` picks the second:

### A. Extend HAYV2 + JS decoder
- Wire plate blocks (id, color, density, omega, birth_step) into HAYV2's initial-state block.
- Emit per-frame plate-motion records.
- Teach the JS decoder HAYV2-shaped tag handlers + bidirectional seek.
- Estimate: 3–5 days. Throws away the legacy HAYBA codepath eventually.

### B. Build Hayba Explorer against the Rust crate directly (chosen)
- Tauri app embeds `hayba-tectonics-v2` as a Rust dependency.
- Renderer reads sim state through Tauri commands, not the frame-stream file.
- Frame-stream becomes export-only (snapshots written to disk for offline viewers).
- HAYV2 stays simple; the rich state stays in-process.

The Phase 10.1 plumbing lands as far as it can. TE retires; future viewer work is Hayba Explorer.
