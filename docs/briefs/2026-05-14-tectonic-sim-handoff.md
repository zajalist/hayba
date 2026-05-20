# Tectonic-Sim Handoff (2026-05-14)

For an agent picking up the Tectonic-Explorer port-forward megasprint mid-flight.

## TL;DR

- **All backend phases 0–9 of the port-forward plan are complete.** Rust crate `packages/hayba-tectonics-v2/` has ~215 tests green; JS decoder (`viz/lib/frame-stream.js`) handles every new tag.
- **Phase 12 shaders are reverted** — they broke the viewer (every land cell painted white because the inline temperature-default fallback fell below the snow threshold). See "Known traps" below.
- **Phase 10 (viewer integration) is the next gate.** Until TE's `Field` objects carry real Phase 6.1 climate values, no climate-driven shader can work.

## Where to look

- **Plan:** `docs/superpowers/plans/2026-05-13-tectonic-explorer-portforward.md` — the source of truth. Phases 0–9 ☑, 10–14 still open.
- **Rust crate:** `packages/hayba-tectonics-v2/` — module per phase (`sphere`, `field`, `plate`, `subduction`, `crust`, `rock`, `erosion`, `climate`, `milankovitch`, `mantle`, `time`, `frame_stream`, `wizard`, `determinism`, `model`, `export`).
- **TE viewer (submodule-ish, embedded):** `tectonic-explorer/packages/tecrock-simulation/` — React + MobX + Three.js. Loads frame stream via worker, decodes into FrameCache, renders with `plate-mesh.ts` + `plate-mesh-*.glsl`.
- **Standalone viewer:** `viz/index.html` + `viz/lib/frame-stream.js` — separate Rust-served path, also up to date with Phase 9.2 tags.

## Current branch

`feat/frame-stream-phase9` — stacks 10 backend commits + 1 revert. Commits (newest first):

```
8281103 Revert "chore: bump tectonic-explorer submodule for Phase 12 shaders..."
b9650f7 feat(viewer): JS decoder for new climate/crust/plume tags (phase 9.2)
2701a61 feat(rust): ocean gyres + current-driven temperature redistribution (phase 6.2)
59fe401 feat(rust): climate-coupled stream-power erosion (phase 5.2)
fc904b7 feat(rust): determinism contract — SplitMix64 + versioned saves + audit (phase 8)
34e8a7f feat(rust): zonal climate + Hadley humidity + biome lookup (phase 6.1)
efb01a9 feat(rust): averaged Milankovitch climate envelopes (phase 7.2)
4ac16ff feat(rust): frame_stream tags for climate/crust/plume/currents (phase 9.1)
938a4e9 feat(rust): port v1 drainage + stream-power to v2 sphere (phase 5.1)
b001909 feat(rust): Wilson-cycle DT_MA + Earth-history era overlay (phase 4.1)
3b91da6 feat(rust): wizard orbital params + 6 presets (phase 7.1)
```

The TE submodule is on `feat/frame-stream-phase9` locally at commit `7cc77c7` (pre-shader). Its three reverted shader commits — `ccf3c74`, `4442a7d`, `226f2e0` — are still in the TE reflog if you want to cherry-pick after fixing the data-plumbing.

## What's done (backend, Phases 4–9)

| Phase | Task | Where it lives |
|---|---|---|
| 4.1 | `DT_MA=0.5`, `era_for_ma(ma)`, `TAG_SIM_TIME_MA=0x41` | `src/time/mod.rs`, `src/frame_stream/mod.rs` |
| 5.1 | `fill_pits`, `flow_dirs`, `flow_accum`, `stream_power_erosion` | `src/erosion/{drainage,stream_power}.rs` |
| 5.2 | `climate_coupled_erosion`, `base_k_for_rock` (15 rocks) | `src/erosion/stream_power.rs`, `src/crust/column.rs::top_rock` |
| 6.1 | `temperature_k`, `humidity_norm`, `biome_for` (15 biomes), `compute_cell_climate` | `src/climate/zonal.rs` |
| 6.2 | `detect_ocean_basins`, `place_gyres`, `compute_cell_currents`, `redistribute_temperature` | `src/climate/currents.rs` |
| 7.1 | `OrbitalParams` + 6 presets (Earth/Mars/Venus/hot-Jupiter-moon/glacial/tidally-locked) | `src/wizard/mod.rs` |
| 7.2 | `envelope_at_ma`, `ice_cap_extent_norm`, `current_solar_constant`, `temperature_with_envelope` | `src/milankovitch/{envelope,orbital}.rs` |
| 8 | `DETERMINISM_VERSION`, `SplitMix64`, `DeterministicRng`, `SaveHeader`, `check_save_compat` + audit (clean) | `src/determinism/mod.rs`, `tests/determinism.rs` |
| 9.1 | Tags 0x09–0x0F + 0x17 + 0x18 (climate/crust/plume) with encoder + decoder round-trip tests | `src/frame_stream/mod.rs` |
| 9.2 | JS decoders + state fields for all the new tags + standalone smoke test | `viz/lib/frame-stream.js`, `viz/lib/test-frame-stream-phase9.mjs` |

Tag-ID deviations from spec: `TAG_CRUST_LAYER_STACK` is `0x18` (not 0x41 — `0x41` was already `TAG_SIM_TIME_MA`).

## What's left

### Phase 10 — Viewer integration (THE NEXT GATE)

This is the unlock for shaders, export, and everything visual.

- **10.1** — Replace TE `model-worker.ts` with a Rust-output consumer. Read the existing worker first; the goal is to keep TE's existing `FrameCache` API surface while replacing the TS sim with a `fetch('data/world.bin') → frame-stream decoder → FrameCache` pipeline. Files in TE: `src/model-worker.ts`, `src/model-output.ts`.
- **10.2** — New map modes in `src/color-maps.ts`: `climate-temp`, `climate-humidity`, `biome`, `ocean-currents`, `snow-extent`, `rock-layer-cross-section`. Add each as a chip in the bottom panel + Ctrl-key shortcut.
- **10.3** — Cross-section view: render multi-layer crust stack (Phase 2), lithospheric mantle column (Phase 3), and mantle plume columns. Files: `src/plates-view/cross-section-3d.ts`, `src/plates-view/cross-section-markers.ts`.

**Critical sub-task before resuming Phase 12 (shaders):** populate TE `Field` objects with real `temperature_k`, `humidity`, `biome_id`, `snow_cover`, `slope_rad` values when the FrameCache decodes them. Today the shader stub falls back to `288 - latAbs*0.5` which produces sub-273-K temperatures at mid-latitudes → the snow-line shader paints the whole planet white.

### Phase 11 — Hayba design language restyle

Mostly done in prior work (tasks #102, #105, #107–109, #112, #119–121 completed). Open polish items: task #116 (wire secondary palette, fix last orange hover) + task #122 (update Cypress e2e for new bottom-bar labels).

### Phase 12 — Shaders (reverted, blocked on 10.1)

The three reverted commits are recoverable from TE submodule reflog. Re-land **after** Phase 10.1 plumbs real climate values into TE `Field`s:

1. **12.1** triplanar terrain texturing — only modulate by triplanar noise (≤15% color amplitude); preserve `usePatterns==true` path untouched.
2. **12.2** parallax occlusion on steep faces — use `dFdx/dFdy(vWorldPos)` for the screen-space normal; gate on `slopeT > 0.35`.
3. **12.3** dynamic snow line — driven by real `temperatureK` + `snowCover` per cell; ocean cells (biome 0) must be excluded. **Do not** use inline temperature defaults — gate the whole snow blend on `hasClimateData == true` uniform, defaulting false.

GLSL files: `tectonic-explorer/packages/tecrock-simulation/src/plates-view/plate-mesh-{vertex,fragment}.glsl`. Material setup: `plate-mesh.ts` (594 lines).

### Phase 13 — Persistence

- 13.1 Save format JSON `{determinism_version, wizard_inputs, continent_drawings, named_snapshots: []}`. Determinism version + SaveHeader already exist in `src/determinism/mod.rs` — wire those.
- 13.2 Named-snapshots UI in the timeline strip.

### Phase 14 — Export

Rust CLI subcommand `te-port export <snapshot.json> --out <dir>`. Lives in `src/export/` (currently stubbed):
- 14.1 equirect PNGs (heightmap 16-bit grayscale, biome palette, temperature, humidity, ocean_depth, snow_cover) at 4096×2048.
- 14.2 per-cell `cells.json` dump.
- 14.3 PBR texture set (albedo/normal/roughness/metallic).
- 14.4 UE5 importer — deferred to follow-up.

## Known traps

1. **Shader fallback temperatures must NEVER ship as the default path.** The reverted shader commits used `288 - latAbs*0.5 - elevM*0.0065` as an inline default when `Field.temperatureK` was absent — that produces values around 263 K at 50° latitude, below the 268 K snow threshold, so every land cell got painted snow-white. Fix the data plumbing first.
2. **`TAG_CRUST_LAYER_STACK` is `0x18`, not `0x41`** — the plan spec said 0x41 but that ID was already taken by `TAG_SIM_TIME_MA`. JS decoder is already correct.
3. **Tropical-rainforest temp cutoff is 287 K, not 293 K** — adjusted in Phase 6.1 to match the live solar constant. If you tighten greenhouse modeling, recheck this in `biome_for`.
4. **The `geoforge` UE plugin lives outside the monorepo** at `D:\UnrealEngine\geoforge\` and is **not a git repo**. The Phase 14.4 UE5 importer + task #82 (UE planet renderer) will edit files there with no version control — coordinate with the user before starting.
5. **Submodule pointer:** parent repo doesn't carry a pointer to the TE submodule HEAD right now (the bump was reverted). If you re-land Phase 12 shaders, do a fresh bump commit.
6. **Determinism is audited clean** as of Phase 8 — no `thread_rng` / `HashMap` iteration over sim state. Don't regress this; if you need randomness, use `DeterministicRng::derive_substream(master_seed, "label")`.

## Quick-start verification

```bash
cd packages/hayba-tectonics-v2
cargo test                # ~215 tests, should be green
cargo build --release

cd ../../viz
node lib/test-frame-stream-phase9.mjs   # 57 assertions

cd ../tectonic-explorer/packages/tecrock-simulation
npm start                 # webpack dev server, http://localhost:8081
```

## Open task IDs (in the in-session task tracker)

Pending tectonic-sim items by phase:
- Phase 10/11/13/14 — no tasks created yet; create as you go.
- #59 — Force-balance realism (erosion vs orogeny vs aulacogen visibility). Probably superseded by Phase 5.2 + 6.1 landing; verify before re-opening.
- #70 — Perf follow-up: FrameCache keyframe-anchored rewind + reusable clone buffer.
- #73, #74 — Render: screen-space normals + triplanar biome blending. Folded into Phase 12.
- #76, #77, #78 — Sim-data per-cell emission. Largely already done by Phase 9.1 frame-stream tags + Phase 6.1; verify and close.
- #79, #80, #81 — Render post-MVP (Bruneton scattering, LOD, volumetric clouds).
- #82 — UE5 plugin planet renderer using same satmap data contract.
- #100, #103, #110, #114 — code-quality nits from Phases 1.1/1.2, 1.3/1.4, 1.5, 2. Low priority.
- #116 — Phase 11 polish (secondary palette + last orange hover).
- #122 — Update Cypress e2e for new bottom-bar labels.

## Recommended sequence

1. Phase 10.1 (replace TS sim with Rust frame-stream consumer) — unblocks everything else.
2. Phase 10.2 (map modes) — gives visible payoff for all the Phase 6/7 backend work.
3. Phase 13.1 (seed + params save) — small and unblocks 13.2.
4. Phase 12 re-land (shaders) — only after 10.1 ensures real climate values flow into `Field` objects.
5. Phase 14 (export) — last, since it depends on a stable frame-stream contract.
6. Phase 10.3 (cross-section) — independent of the above; can slot in any time after 10.1.

---

## Phase 10.1 closed — 2026-05-14

The Phase 10.1 plumbing landed as far as it usefully can against TE. **TE is now retired.** Long-term tectonic viewing moves to `hayba.exe` per `docs/superpowers/specs/2026-05-14-hayba-explorer-design.md`.

### What landed
- **Peels audit (Layers 1 + 2) PASSES.** Rust `VoronoiSphere` is bit-identical to TS peels at d=32: max position delta 7.7e-8, zero neighbor mismatches. See `tools/peels-audit/AUDIT-L1.md`, `AUDIT-L2.md`.
- **Frame-stream header carries `divisions`.** Encoder writes it; JS decoder reads it; TE bootstrap (`frame-stream-bootstrap.ts`) peeks the bin header pre-mount and patches `config.divisions` so the singleton Grid matches.
- **JS decoder accepts both HAYBA v1 and HAYV2.** New `parseInitialStateV2` for the simpler shape; `FrameCache.seek` short-circuits to initial state on HAYV2 (no animation, no plate motion — see below).
- **Real `world.bin` baked at d=32.** Served from `tectonic-explorer/packages/tecrock-simulation/public/data/world.bin` by webpack-dev-server; consume via `?frameStream=true`.
- **TE consumer synthesizes plate entries from cell-id buckets** so the renderer has something to attach cells to even though HAYV2 carries no plate blocks.

### What did NOT land (and why)
- **Plate motion.** Blocked: the Rust encoder's HAYV2 format and the `te-port` CLI emit no plate-level records (no omega, no birth_step, no spawn/retire/motion tags). Extending HAYV2 to carry plate motion is 3–5 days of Rust + JS work for a viewer we're retiring. Resolution: Hayba Explorer embeds the Rust crate directly and reads plate state through Tauri commands, not the frame-stream file.
- **Visual validation screenshot.** Setup is complete (TE dev server serves the bin; consumer accepts HAYV2); a manual `npm start` + browser session was deferred. Worth a 5-minute eyeball check before pivoting fully.
- **Phase 10.2 climate map modes, Phase 10.3 cross-section, Phase 12 shaders.** All deferred to Hayba Explorer where we control encoder + renderer end-to-end.

### Format-gap details
`tools/peels-audit/AUDIT-FORMAT.md` documents the HAYBA-vs-HAYV2 divergence in full (header, initial-state, per-frame deltas, frame_idx convention).

### Tag
Phase 10.1 closes at `feat/frame-stream-phase9` HEAD. The next branch picks up with the Hayba Explorer Tauri scaffold per the design spec.
