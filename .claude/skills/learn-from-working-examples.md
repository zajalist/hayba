---
name: learn-from-working-examples
description: Use before constructing PCG graphs, materials, or blueprints from first principles. Mandates exporting a working example asset first (hayba_list_pcg_assets → asset_search → hayba_export_pcg_graph) and cloning its topology rather than guessing at node/pin/parameter requirements.
---

# learn-from-working-examples

UE has many "looks reasonable, runs silently wrong" patterns. PCG nodes accept inputs that don't error but produce zero output. Material parameters take values that compile but render checker. Blueprint event graphs can have valid-looking wires that never fire. The cost of guessing at these patterns is debugging a graph that runs and produces nothing. The cost of reading a working example is two MCP calls.

## The rule

**Before** you build a PCG graph / material / blueprint from scratch, find the closest working example in the project and clone its topology.

## The 4-step flow

### 1. Inventory
- For PCG: `hayba_list_pcg_assets` — every PCG graph in `/Game`.
- For materials: `hayba_asset_search` filtered by `Material` / `MaterialInstance`.
- For blueprints: `hayba_asset_search` filtered by `Blueprint`.
- For any asset class: glob through `/Game` for the matching naming pattern.

### 2. Pick the closest match
- Match by intent first ("trees on terrain"), not by name ("PCG_Trees").
- If the project has a verified marketplace pack (UB-Landscape-Auto, Sealed Vault, etc.), prefer assets from those — they're known-good.

### 3. Export
- For PCG: `hayba_export_pcg_graph <asset_path>` returns the full topology — nodes, pins, parameters, defaults.
- For materials / blueprints: use the asset-introspection tools in the matching domain (`material_describe`, `blueprint_describe`, etc.) or fall back to `hayba_get_node_details` for individual nodes.

### 4. Clone topology, vary parameters
- Recreate the structure (nodes + pins + connections) exactly.
- Vary only the meshes / textures / parameters that need to change for your scene.
- Build from scratch **only** if no working example exists.

## Concrete examples

### PCG forest scatter
- Wrong: build `PCGSurfaceSamplerSettings` fed by `PCGDataFromActorSettings` pointing at a `StaticMeshActor`-tagged ground plane. Graph runs, returns `componentsExecuted: 1`, spawns zero instances.
- Right: `hayba_export_pcg_graph /Game/UB-Landscape-Auto/.../PCG_Trees` → see that Surface is fed by `PCGGetLandscapeSettings(ActorSelection=ByClass, ActorSelectionClass=LandscapeProxy)` with `bUnbounded=True`. Clone, swap mesh references, run.

### Landscape master material
- Wrong: hand-roll a `MM_Custom` from scratch, miss the layer-info parameter set that the project's tooling expects.
- Right: pick one of the project's existing `MM_*` masters (e.g. `MM_Temperate_Forest`), duplicate, edit base colors / roughness — the layer interface is preserved.

### Foliage type config
- Wrong: spawn `FoliageType_InstancedStaticMesh` with default density curves, get random scale chaos that fails `foliage_scale_chaos`.
- Right: copy a `FoliageType` asset from a working pack; the density curve, scale range, and rotation jitter are already tuned.

## Why this beats "construct from first principles"

- **Most PCG node interactions are undocumented.** `PCGSurfaceSampler` requiring a Landscape (not just any spatial input) is one of dozens.
- **Working examples encode constraint sets you can't see in the schema.** Pin types accept many sources at the schema level but only one shape at runtime.
- **Marketplace packs were authored by people who shipped products.** Their parameter defaults are battle-tested; yours are guesses.

If "clone working example" feels lazy, remember that the user's scene in the 2026-05-23 session was never delivered because the agent built three PCG graphs from first principles before exporting the working one. The working pattern was visible in the export. **Read it first.**
