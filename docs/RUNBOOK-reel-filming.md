# Reel Filming — Wake-Up Runbook

State captured 2026-07-07 (overnight). Read top-to-bottom; it's the exact path from
"here" to "recording a reel."

## What's DONE and persists
- **CC0 conifer assets imported** → `/Game/ReelAssets/` (saved to disk, survives crashes & the 5.8 move):
  `fir_tree_01` (hero), `pine_sapling_small/medium`, `fir_sapling_medium`, `dandelion_01`, `celandine_01`. (The 982 MB `pine_tree_01` was dropped — too heavy for a scatter; not needed.)
- **Anchors** in the clean `NewMap` level: `Field_Center`, `Scratch_A`, `Scratch_B`.
- **Keyless CLI copilot** — branch `local/claude-cli-copilot-backend` (NOT pushed). Provider `claude-cli` drives the copilot via this machine's authenticated `claude` CLI, no API key, warm ~1.5s/turn. Proven through the full SSE panel path.
- **Native scatter fix** — branch `fix/native-scatter-path` (NOT pushed): world_generate class-filter, pcg_biome landscape source + `MeshSelectorWeighted`, C++ `asset_search` type filter. (Mesh-selector nesting may need one live-validation pass.)
- **Website**: auto-deploy disabled (`vercel.json`), GitHub deployments pruned to 1.

## The core blocker (why filming stalled)
1. **The running MCP server is an OLD build** — missing `render_camera`, `foliage_*`, `seq_*`, `niagara_*`, and the CLI copilot. (`list_tool_categories` shows these as unavailable.)
2. **The 5.7 editor is thrashed** — crashed/stalled ~6× (Water shader compile, gigabyte import, reindex, scatter). You're on **5.8** now anyway.
3. A correct **native scatter** needs the `fix/native-scatter-path` code **deployed + validated live**.

## Path to filming (in order)

### Step 1 — Get onto a stable editor + current build
Recommended: **do the 5.8 plugin port** (you're on 5.8):
- Bump `unreal/HaybaMCPToolkit/HaybaMCPToolkit.uplugin` EngineVersion → 5.8.
- Regenerate project files + rebuild the plugin (editor CLOSED). Fix any 5.7→5.8 C++ breaks.
- Open the project on a **fresh** 5.8 editor.
This also picks up the C++ `asset_search` fix from `fix/native-scatter-path`.

### Step 2 — Run the current MCP node build as the recording server
- Merge (or stack) `local/claude-cli-copilot-backend` + `fix/native-scatter-path` into a recording branch.
- `cd mcp-tools/hayba-mcp && npm run build`, then point the `hayba-toolkit` MCP server at this build and reconnect. Now available: `render_camera`, `foliage_scatter_paint`, `seq_*`, `niagara_*`, and the `claude-cli` provider.

### Step 3 — Build the scene (native tools, NO python one-shots)
Prefer the purpose-built tool over hand-rolled PCG:
- **Scatter:** `foliage_scatter_paint` (current build) with the ReelAssets conifers on the landscape — OR the fixed `scatter.pcg_biome` Recipe (`hayba_recipe_run com.hayba.scatter.pcg_biome`), area_actor = the Landscape. Validate a small count first, then scale.
- **Water:** `water_body_lake_create` in the low ground (Water plugin already enabled).
- **Light/sky:** the Open World template has sun/sky/fog; tune to the "misty morning" look.
- **Verify each beat** with `render_camera` (magic-byte-verified PNG).

### Step 4 — Film
The reel = the **keyless CLI copilot** building the world live. Select provider
**"Local Claude CLI (this machine, no key)"** in the panel. Record split-screen
(UE viewport left, copilot panel right) per `docs/demo-reels-script.md`.
Capture with **Cap** (auto-zoom) → edit in **DaVinci Resolve**.

## Landmines (learned the hard way)
- **Do NOT scatter/seed in the old geoforge/grammar level** — its PCG asserts `IsRotationNormalized` on actor spawn (see `project_template_level_pcg_crash`). Use the clean `NewMap`/`ReelStage`.
- **Gate every editor op behind a "port stably open ~20s" check** — the plugin flaps its TCP port during heavy synchronous work.
- **No gigabyte PolyHaven hero meshes in a scatter** — saplings + one mid tree only.
- **Map create/switch = UE UI only** — the python_run world-switch guardrail (PR #301) correctly blocks it from code.
- **PCGSurfaceSampler pins are `Surface` (required) + `Bounding Shape`**, not `In`. `PCGGetLandscapeSettings.Out` feeds `Surface`.
- **PCG node properties must be STRING-valued in the graph JSON.** The plugin's property applier (`HaybaMCPLegacyHandler.cpp`) only calls `FProperty::ImportText_Direct` on values that stringify — nested JSON objects/arrays are silently dropped. So the mesh spawner's `MeshSelectorParameters` is set as a UE export-text string: `(MeshEntries=((Descriptor=(StaticMesh="/Game/ReelAssets/.../fir_tree_01_a_LOD0.fir_tree_01_a_LOD0"),Weight=1)))`. **This one line needs LIVE validation** — whether `ImportText` imports the inline sub-object onto the instanced `MeshSelectorParameters` is unproven (there's a `TODO(live-validate)` in `pcg_biome.ts`; fallback is `pcg_set_prop` with nested path `mesh_selector_parameters/mesh_entries`). Validate this the moment the current build is live, before trusting the Recipe.
