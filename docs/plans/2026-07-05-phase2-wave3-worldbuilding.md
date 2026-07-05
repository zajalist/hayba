# Phase 2 Wave 3 — Worldbuilding domains (landscape / foliage / lighting)

Third breadth wave. Leans Hayba's worldbuilding moat: landscape, foliage/scatter,
and lighting+post-process P0s via the pyTemplate factory. Same Global Constraints
as Waves 1–2 (`docs/plans/2026-07-04-phase2-wave2-editor-asset-mesh.md`):

- NET-NEW only — check overlap vs existing tools, the 55 surfaced legacy commands
  (`src/legacy-commands/sidecar.json`), and Waves 1/2 tools before building each.
- pyTemplate factory + `toToolDescriptor` into `STANDARD_DESCRIPTORS`; defensive
  python (`_emit`/`_err`, `pyStr`/JSON.stringify for ALL embedded values — raw
  interpolation is an injection/parse bug); inspection-first returns.
- NON_IDEMPOTENT classification for mutating tools.
- Gates: `npx tsc --noEmit` clean + `npx vitest run` green + `npm run
  lint:legacy-wrappers` green, run in mcp-tools/hayba-mcp before commit.
- Commits omit the Co-Authored-By trailer; stage only your files (no git add -A);
  do not create/switch branches (work on feat/mcp-wave3-worldbuilding).
- Authoritative designs: extract each domain's P0/P1 entries from
  `docs/plans/2026-06-28-mcp-supertooling-tools.json` with node before designing.
- Prefer high-confidence UE 5.7 python; wrap anything uncertain to degrade to a
  structured error (never a silent wrong answer) and flag it for live validation.

## Task 1 — Landscape & terrain P0s  [TS]
**Files:** new `src/tools/landscape/landscape-py-tools.ts` (+ test); `index.ts` splice.
From the catalog `landscape-and-terrain` domain (6 P0s + strong P1s), ~8-12
net-new tools. Candidate verbs (verify vs the existing landscape_import wrapper +
sidecar): `landscape_list` (enumerate Landscape actors + proxies + resolution/
component layout), `landscape_get_info` (size, section/component counts, material,
layer names), `landscape_get_layers` / `landscape_set_layer_weight` (paint-layer
introspection/set on a region — mutating), `landscape_sculpt_region` (apply a
heightmap delta / flatten / ramp to a bounds — mutating), `landscape_import_layer`
(weightmap import), `landscape_add_spline_control_point` if not already surfaced.
Use `unreal.LandscapeProxy`/`ALandscape` reflection + EditorActorSubsystem; note
sculpt/paint may need the landscape edit-layer API — wrap defensively.

## Task 2 — Foliage & scatter P0s  [TS]
**Files:** new `src/tools/foliage/foliage-py-tools.ts` (+ test); `index.ts` splice.
From `foliage-and-scatter` (8 P0s), ~8-12 net-new tools. Candidates: `foliage_list_types`
(InstancedFoliageActor foliage types in the level), `foliage_get_type_settings`,
`foliage_set_type_settings` (density/scale/align — mutating), `foliage_add_type`
(add a foliage type from a static mesh — mutating), `foliage_paint_region`
(procedural/scatter instances across a bounds with density+seed, grounded via
line-trace — mutating, NON_IDEMPOTENT), `foliage_get_instance_count`,
`foliage_remove_in_bounds` (mutating). Use `unreal.EditorFoliageLibrary` /
`InstancedFoliageActor` + FoliageType reflection. This overlaps conceptually with
world_generate — differentiate (this is direct foliage-system authoring, not the
validated-scatter flagship). Grounded placement mirrors the actor snap-to-floor idiom.

## Task 3 — Lighting & post-process P0s  [TS]
**Files:** new `src/tools/lighting/lighting-py-tools.ts` (+ test); `index.ts` splice.
From `lighting-postprocess-and-rendering` (12 P0s), ~10-14 net-new tools.
Candidates: `light_list` (all light actors + type/intensity/color/mobility),
`light_get` / `light_set` (intensity/color/temperature/attenuation/mobility on a
light — mutating), `light_spawn` (directional/point/spot/rect/sky — mutating,
NON_IDEMPOTENT), `postprocess_list_volumes`, `postprocess_get` /
`postprocess_set` (exposure/bloom/GI/color-grade settings on a PPV or the global —
mutating), `exposure_set`, `lumen_configure` (project/PPV Lumen toggles),
`sky_setup` (SkyAtmosphere/SkyLight/DirectionalLight sun triad — mutating),
`lightmass_get_settings`. Use light-component reflection
(`unreal.DirectionalLightComponent` etc.), `PostProcessVolume.settings`
(FPostProcessSettings with bOverride_* flags — set the override bool alongside each
value or the set is ignored; this is the key gotcha — handle it). Defensive wraps.

## Task 4 — Live validation of Wave 3  [smoke]
TCP battery-style run against the live editor: `get_tool_signature` for a sample
per domain; execute read-only tools (`landscape_list`, `foliage_list_types`,
`light_list`, `postprocess_list_volumes`) and confirm structured results; verify a
couple of set tools' python is well-formed (dry check). Extend
`.scratch/battery.mts` with the new tools' params. Record results in the ledger.
