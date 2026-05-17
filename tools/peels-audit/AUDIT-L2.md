# Peels Audit — Layer 2 (neighbors)

**Date:** 2026-05-14
**Verdict:** PASS

## Setup
Same dumpers as Layer 1 (`dump-ts-peels.ts`, `dump_peels.rs`). Both emit a `neighbors: number[6]` array per cell, with `null` filling the 6th slot for pentagon-pole cells.

## Result
- Length mismatches: **0**
- Set mismatches: **0**
- Order mismatches: **0**

Neighbor adjacency is bit-identical between TS peels and the Rust port — same neighbors in the same canonical order for all 10,242 cells.

## Implications
- Any sim code relying on neighbor walks (flow accumulation, boundary detection, etc.) produces identical traversals on both sides.
- No port fix needed for Layer 2.

## Combined verdict (L1 + L2)
The Rust port of peels is **faithful**. The Phase 10.1 backend↔frontend mismatch we originally diagnosed was purely a `divisions` config mismatch between TE and the bundled `world.bin`. The fix is to plumb `divisions` through the frame-stream header so both sides agree by construction.
