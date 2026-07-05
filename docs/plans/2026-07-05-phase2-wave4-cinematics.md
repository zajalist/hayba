# Phase 2 Wave 4 — Cinematics & VFX (sequencer / niagara / water)

Fourth tool wave: the "author a shot / populate a world with motion, effects, and
water" surface. Sequencer, Niagara, and the UE Water plugin P0s via the pyTemplate
factory. Same Global Constraints as Waves 1–3:

- NET-NEW only. **3-SURFACE overlap audit before naming any tool**: (a) sidecar.json,
  (b) existing TS tools in index.ts, (c) compiled C++ handlers under
  `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/` (grep GetCommands()
  + HaybaMCPModule.cpp registrations + the documented C++ domains in
  list-tool-categories.ts). A compiled-but-unwired C++ name is still a collision.
- pyTemplate factory + `toToolDescriptor` into `STANDARD_DESCRIPTORS`; defensive python
  (`_emit`/`_err`, `pyStr`/JSON.stringify for ALL embedded values); inspection-first
  returns; a `*_capability_probe` (or `*_check_plugin`) tool per uncertain-API/plugin
  domain that degrades to a structured error, never a fabricated value.
- NON_IDEMPOTENT for mutators (create/spawn/add/keyframe-append/render) + a local
  `<DOMAIN>_NON_IDEMPOTENT` export mirroring the Wave-3 files.
- Gates: `npx tsc --noEmit` clean + `npx vitest run` green + `npm run lint:legacy-wrappers`
  green (run in mcp-tools/hayba-mcp) before commit. Per-tool unit tests in the
  established mocked-sender style.
- Commits omit the Co-Authored-By trailer; stage only your files; no branch switching
  (work on feat/mcp-wave4-cinematics). No competitor names anywhere.
- Extract each domain's P0/P1 entries from `docs/plans/2026-06-28-mcp-supertooling-tools.json`
  before designing. Ship confident tools; wrap-and-skip speculative ones (note skips).
- Reference patterns: `src/tools/landscape/landscape-py-tools.ts`,
  `src/tools/lighting/lighting-py-tools.ts` (defensive `_prop`/`_set`, warnings[]),
  `src/tools/pcg/pcg-cook-and-wait.ts` (the async generate→wait→read orchestrator, for
  render-job shapes).

## Task 1 — Sequencer & cinematics P0s  [TS]
**Files:** new `src/tools/sequencer/sequencer-py-tools.ts` (+ test); `index.ts` splice.
From the catalog `sequencer-and-cinematics` P0s (~12). Ship the AUTHORING set
confidently: `seq_create`, `seq_inspect`, `seq_bind_actor`, `seq_add_track`,
`seq_transform_keyframe`, `seq_add_camera_cut`, `seq_set_playback_range`, `seq_open`,
`seq_validate` (PLUMB-style: dangling bindings / empty tracks / out-of-range keys).
Use `unreal.LevelSequence`, `unreal.MovieSceneSequenceExtensions` / `LevelSequenceEditorBlueprintLibrary`,
`unreal.SequencerTools`. RENDER tools (`seq_render_movie`, `seq_render_status`,
`seq_render_still`) go through MovieRenderQueue (`unreal.MoviePipelineQueueSubsystem` /
`MoviePipelineEditorLibrary`) which is heavier + async — implement `seq_render_still`
(single frame → PNG content block, the vision-loop win) if a clean synchronous path
exists; for `seq_render_movie` prefer a job-envelope shape (kick + `seq_render_status`
poll) mirroring the build/test registry, OR wrap-and-skip with a clear note if the MRQ
python API is speculative. Non-idempotent: create/bind/add_track/keyframe/camera_cut/render.

## Task 2 — Niagara & VFX P0s  [TS]
**Files:** new `src/tools/niagara/niagara-py-tools.ts` (+ test); `index.ts` splice.
From `niagara-and-vfx` P0s (~5) + strong P1s (~8-12 total): `niagara_capability_probe`,
`niagara_list`, `niagara_system_inspect` (emitter handles / enabled / sim-target),
`niagara_param_list` (USER params + type + current value), `niagara_spawn` (transient
auto-destroy system at a world transform — non-idempotent), `niagara_set_param` (set a
user var on a live component — float/int/bool/vec3/color/object). Use
`unreal.NiagaraSystem`, `unreal.NiagaraComponent`, `unreal.NiagaraFunctionLibrary`
(spawn_system_at_location), and the set_niagara_variable_* setters (probe names
defensively). Overlap: there's a HaybaMCPNiagara C++ module — grep it in the 3-surface
audit and differentiate/avoid collisions.

## Task 3 — Water system P0s  [TS]
**Files:** new `src/tools/water/water-py-tools.ts` (+ test); `index.ts` splice.
From the `Water system` catalog P0s (~11). MUST start with `water_check_plugin` (probe
the Water plugin is enabled + report version; every other water tool returns a clean
"plugin disabled" error if not). Then: `water_body_list`, `water_body_inspect`,
`water_body_ocean_create` / `water_body_lake_create` / `water_body_river_create`
(non-idempotent spawns), `water_waves_inspect`, `water_waves_set_gerstner`,
`water_zone_create` (non-idempotent), `water_zone_inspect`, `water_validate` (PLUMB-style:
bodies below terrain, missing zone, etc.). Use `unreal.WaterBodyOcean/Lake/River`,
`unreal.WaterZone`, Gerstner wave generator reflection. Water is worldbuilding-core
(leans the moat). Defensive throughout — the plugin may be absent.

## Task 4 — Live validation of Wave 4  [smoke]
TCP validation vs the live editor: `get_tool_signature` for a sample per domain; run the
read/probe tools (`seq_inspect` on a scratch seq or list, `niagara_list`,
`niagara_capability_probe`, `water_check_plugin`, `water_body_list`) and confirm
structured results (water/niagara may report plugin/absence cleanly — that's a PASS, not
a fail); confirm all Wave-4 buildScripts generate valid python. Extend
`.scratch/battery.mts`. Record in the ledger.
