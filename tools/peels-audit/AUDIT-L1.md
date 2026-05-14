# Peels Audit — Layer 1 (positions)

**Date:** 2026-05-14
**Verdict:** PASS

## Setup
- TS source: `tectonic-explorer/packages/tecrock-simulation/src/peels/sphere/index.ts`
- Rust source: `packages/hayba-tectonics-v2/src/sphere/voronoi.rs` (via `Grid`)
- `divisions = 32`, `n_cells = 10242`

## Coordinate convention
TS peels uses (phi, lambda) → Z-up xyz natively. The audit normalizes TS output to Rust's Y-up convention:

```
x = cos(phi) * cos(lambda)
y = sin(phi)                  // poles on Y
z = cos(phi) * sin(lambda)
```

This is the convention the Rust crate already emits and the same one Three.js expects (see `dump-ts-peels.ts:14-17`).

## Result
- Max position delta: **7.7e-8** at cell 2924
- Drifters > 1e-4: **0**

Pure floating-point noise — Rust uses f32, TS uses f64. The port produces identical positions to the limit of single-precision.

## Implications
- Frame-stream cell IDs from the Rust backend are 1:1 with TE's peels cell IDs at the same `divisions`.
- The mismatch we observed in the original Phase 10.1 diagnosis was **purely a config mismatch** — TE's default `divisions: 32` (~10k cells) vs the bundled `viz/data/world.bin` baked at `divisions: 128` (~164k cells).
- No port fix needed for Layer 1.
