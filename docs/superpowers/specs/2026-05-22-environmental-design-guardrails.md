# Environmental-Design Guardrails

**Date:** 2026-05-22
**Status:** Spec — pending approval
**Companion:** Extends `2026-05-22-agentic-guardrails-and-sliver-library.md` with environment-specific rules + slivers. The parent spec covers the universal failures (rotation, snap-to-ground, lights). This one covers **how environment artists actually compose scenes** — what foliage workflow, landscape painting, and atmospheric layering look like in shipping content — and converts those conventions into deterministic guardrails so an agent's "build a jungle clearing" doesn't end up as 150 floating StaticMeshActors on a checker landscape.

---

## Part 0 — Cross-pack survey

Walked 9 Learttes packs across biomes. The relevant asset categories per pack:

| Pack | Biome | FoliageType assets | Landscape LayerInfos | PCG components | Niagara atmospherics | PostProcess volumes |
|---|---|--:|--:|--:|--:|--:|
| **JungleRuins** | jungle | **40** | 5 (Dirt/Grass/JungleFloor/Marsh/Mud) | 2 | Fire_Camp, Fire_Torch | 0 |
| **AfricanVillage** | savanna village | 10 | **9** | 0 | (none shipped) | **2** |
| **CastleIsland** | grass / hills | 15 | 3 | 1 | (none) | 0 |
| **HauntedVillage** | woods / fog | 3 | 3 | 0 | (none) | 1 |
| **MayanCave** | cave interior | **0** | 0 | 0 | **Dust + Fog + Leaves + Fire_Camp** | 0 |
| **Crystal_Cave** | cave interior | 0 | 9 (floor variants) | 0 | (none shipped) | 0 |
| **Lakeside_Village** | modular kit | 0 | 0 | 0 | (none) | 0 |
| **Temple** | static set | 0 | 0 | 0 | (none) | 0 |
| **Fishing_Dock** | static set | 0 | 0 | 0 | (none) | 0 |

Plus across packs: **spline-driven assemblies** (HauntedVillage `BP_Fence_Spline`, AfricanVillage `BP_Spline_fence` + `BP_Spline_log_house`).

### What the survey says about how good environments are actually composed

1. **Outdoor scenes use the UE Foliage System.** Every outdoor pack ships FoliageType assets (3–40), pre-tuned per species: density, scale range, ground slope cutoff, cull distance. The foliage system writes painted instances into a single `InstancedFoliageActor` per level — orders-of-magnitude fewer draw calls than the 150 StaticMeshActor approach. **None of them ship loose StaticMeshActors for ground foliage.** Reaching for `actor_spawn` to "place a fern" is wrong on the first call.
2. **Landscapes are multi-material via paint layers.** Outdoor packs ship 3–9 `LayerInfo` assets. The landscape master material switches per-layer (Grass under foliage, Dirt under paths, JungleFloor in the clearing). A single-material checker landscape is the visual signature of *no environmental composition at all* — exactly what this session produced.
3. **Foliage targets specific paint layers.** FoliageType assets carry a `Landscape Layer` filter (e.g. ferns only spawn where the `JungleFloor` layer is painted). This is what makes biome boundaries readable — not a random scatter that bleeds into every surface.
4. **PCG is the exception, not the rule.** Only 3 of 9 packs ship PCG components, all sparingly (1–2 per pack). PCG is for the *one tricky thing* per scene (a procedural debris field, a wind-driven grass band). The 95% workflow is painted Foliage + painted Landscape.
5. **Cave / interior scenes invert the stack.** No foliage, no landscape layers; instead, atmospheric Niagara volumes (Dust, Fog, Leaves) doing the heavy lifting for sense-of-place. The Mayan/Crystal caves don't have grass — they have dust shafts.
6. **Spline-driven kits handle linear repetition.** Fences, log walls, paths — never spawned as N separate actors. One spline BP draws them; one tool call should set the spline points.
7. **PostProcessVolume is authored content.** AfricanVillage ships two — a global one + a local one inside huts. Auto-exposure + fog inscattering are tuned to the biome.

The validator and the sliver library below are derived directly from these conventions.

---

## Part 1 — Environmental-design validator rules

Extends Part 3 of the parent spec. Rules below are added to `scene_validate v2` and are categorised by what they catch.

### A. Foliage workflow rules (catch "the agent did it the wrong way")

| Rule id | What it catches | Detection |
|---|---|---|
| `foliage_as_actors` | Many `StaticMeshActor`s with same mesh + same scale ±10% within a 5000cm radius — strong signal someone scattered "foliage" as actors instead of painting it | Spatial bucket actors by (mesh_path, scale_bucket); flag any cluster of ≥ 20 |
| `foliage_mesh_monoculture` | A foliage cluster (defined as ≥10 actors with foliage-tagged meshes within 3000cm) uses only 1 species | Per cluster, count distinct mesh paths; flag if 1 |
| `foliage_no_layer_filter` | A FoliageType placed on landscape lacks a paint-layer filter — it scatters everywhere instead of respecting biome boundaries | Read `LandscapeLayer` property of FoliageType asset; warn if empty |
| `foliage_scale_chaos` | Foliage instances have stddev/mean of scale > 0.25 — looks like random `0.5–1.5`, reads as visual noise | Per mesh cluster, compute stddev(scale)/mean(scale) |
| `foliage_pitch_roll_nonzero` | Ground foliage with pitch or roll outside ±10° — should be upright | Per foliage actor, check rotation |
| `foliage_inside_prop_collision` | Foliage instance bounds intersect a hero prop's collision bounds | Spatial query foliage vs hero-tagged props |
| `foliage_no_negative_space` | A foliage instance within 50cm of a hero-tagged prop's origin — the scene reads cluttered, hero props should breathe | Distance query around each hero |
| `foliage_density_uniform` | Foliage density (instances per unit area) varies by < 1.3× across the scene — biomes have gradients, uniform density reads procedural-flat | Grid the scene into 500×500 cells, compute density variance |
| `foliage_no_edge_density` | Hero props (boulders, tree trunks, walls) with **zero** ground foliage within 200cm of their base — bare stone in a jungle is uncanny | For each hero, count foliage within radius |

### B. Landscape composition rules

| Rule id | What it catches | Detection |
|---|---|---|
| `landscape_default_material` | Active Landscape uses `M_Landscape` engine default / `M_WorldGridMaterial` (the **checker pattern**) | Read `landscape.LandscapeMaterial.GetPath()` and match the known-default set |
| `landscape_single_layer_used` | Landscape has multiple LayerInfos available but only 1 is painted across > 95% of the area | Count painted-area per layer |
| `landscape_no_layer_blend` | Layer-paint boundaries are sharp (no transition layer) — a Grass↔Dirt transition without a blend reads obviously fake | Inspect layer weight maps for hard edges |
| `landscape_layer_orphan` | A LayerInfo exists in the project but is never painted on any landscape — likely a missing-step in the build | Cross-reference assets vs landscape painted layers |

### C. Atmospheric / lighting composition rules

| Rule id | What it catches | Detection |
|---|---|---|
| `scene_no_postprocess_volume` | Outdoor scene with no `PostProcessVolume` — exposure is auto-uncontrolled, the brazier blows out (this session) | Count PPVs in level |
| `scene_no_atmospheric_niagara` | Cave/interior scene with no `Dust`/`Fog`/`Leaves`-class Niagara — feels lifeless. (Rule fires only when the level is "cave-type": ceiling-dominant, no DirectionalLight visible from origin) | Niagara count + heuristic cave detection |
| `single_dominant_light_blowout` | One light's effective intensity (intensity × 1/r² at scene origin) is > 10× the next-brightest — blown highlight inevitable | Compute per-light luminance contribution at sampling points |
| `unlit_dark_zone` | A spawned hero prop sits in a zone where the brightest contribution from any light is < 0.1 cd/m² — invisible | Sample illuminance per prop |
| `light_color_temp_clash` | Two lights within 800cm with color temps > 3500K apart (one warm 1800K brazier next to one cool 6500K rim) — feels Halloween, not jungle | Pairwise distance + color-temp delta |
| `directional_sunless_with_skyatmosphere` | SkyAtmosphere present but no DirectionalLight at all — sky has no sun source, gradients break | Read level actor list |

### D. Spline / kit rules

| Rule id | What it catches | Detection |
|---|---|---|
| `linear_actor_array` | ≥ 6 actors of the same mesh arranged in a line within 5° angular variance — should be a spline-driven assembly | RANSAC line fit over actor positions |
| `wall_no_endpoint_cap` | Wall-class actors at a chain endpoint without a corner/end-cap mesh — reads as the wall just stops mid-air | Wall-tagged actors with no other wall within 200cm on one side AND no cap-tagged actor |

### E. World Partition / instancing rules

| Rule id | What it catches | Detection |
|---|---|---|
| `non_hism_when_foliage_capable` | StaticMeshActor uses a mesh that has a FoliageType variant in the project — should be a foliage instance, not an actor | Cross-reference mesh paths |
| `actor_in_unloaded_wp_cell` | Spawned actor in a cell that is not currently loaded in the editor view — invisible to the agent during build | Read WP streaming state |

### F. Postmortem-driven rules (2026-05-23 PCG/landscape session)

Added from `docs/superpowers/specs/2026-05-23-pcg-landscape-mcp-postmortem.md` §6. These five rules close the loopholes exposed in the session where PCG returned `componentsExecuted: 1` with zero instances, a `LandscapePlaceholder` stub got mistaken for a real Landscape, and a TCP-socket workaround crashed the editor.

| Rule | Detect | Fix |
|---|---|---|
| `pcg_zero_instances_after_execute` | `hayba_execute_pcg_graph` returned `componentsExecuted > 0` but no HISM instances spawned within 5s of completion | Warning: surface the affected component output, suggest checking the `Surface` input type (likely not a `LandscapeProxy`) |
| `pcg_surface_source_not_landscape` | `PCGSurfaceSamplerSettings.Surface` is fed by `PCGDataFromActorSettings` whose actor selector targets a non-`Landscape` class | Hard error — known not to work; suggest `PCGGetLandscapeSettings(ActorSelection=ByClass, ActorSelectionClass=LandscapeProxy)` |
| `unreal_landscape_placeholder` | World contains a `LandscapePlaceholder` actor with no `LandscapeProxy` within proximity | Hint: use `hayba_import_landscape` instead of `spawn_actor_from_class(unreal.Landscape, ...)` (which only produces a stub in UE 5.7) |
| `tcp_socket_to_self_in_python_run` | A script passed to `python_run` calls `socket.connect(('127.0.0.1', <port>))` where port ∈ 52342..52350 | Hard reject — guaranteed crash; instruct the agent to add the missing TS wrapper instead of smuggling through a side channel |
| `actor_position_drift_after_user_edit` | `actor_list` diff between consecutive calls shows an isolated actor with a single-axis, round-number change (matches a user-style edit profile) | Don't auto-correct; surface as "user edit detected, preserving" and require explicit agent confirmation before any re-write |

All rules surface `autofix` when mechanical:

| Rule | Autofix |
|---|---|
| `landscape_default_material` | none — agent must pick a material; suggestion lists available `MM_*` masters in the project |
| `foliage_as_actors` | `foliage_migrate_actors_to_instances { actor_ids: [...], foliage_type: <picked> }` — new tool that destroys the actors and re-creates as foliage instances |
| `foliage_pitch_roll_nonzero` | `actor_transform { rotation: { pitch:0, yaw:keep, roll:0 } }` |
| `foliage_no_layer_filter` | none — agent must choose a layer; suggestion lists landscape's painted layers |
| `scene_no_postprocess_volume` | `actor_spawn { class_path: PostProcessVolume, unbound: true, preset: 'outdoor_default' }` |
| `linear_actor_array` | `placement_array_along_spline { points: <fit line>, mesh: <detected> }` then delete the source actors |

---

## Part 2 — Environmental-design slivers

Each sliver below is the **correct primitive** for one environment-design step. Together they form a workflow that produces a competent outdoor scene without ever touching `python_run` or `actor_spawn` directly for foliage.

### `com.hayba.landscape.set_material`

Replace the active Landscape's master material. Trivial wrapper around the missing typed handler. Side-effecting.

```jsonc
params:
  material:        asset_ref (Material/MaterialInstance)
  rebuild_layers:  bool, default true
side_effects:      ['landscape.material.set']
```

### `com.hayba.landscape.paint_layer`

Paint a Landscape Layer in a region (rect, circle, or polygon). Side-effecting.

```jsonc
params:
  layer:          asset_ref (LandscapeLayerInfo)
  region:         { kind: 'rect'|'circle'|'polygon', ... }
  strength:       float [0,1], default 0.8
  falloff:        float [0,1], default 0.5    // soft edge
  erase:          bool, default false
side_effects:     ['landscape.layer.paint']
```

### `com.hayba.foliage.add_type`

Add a FoliageType to the level's `InstancedFoliageActor` (so it's available to paint). Side-effecting.

```jsonc
params:
  foliage_type:   asset_ref (FoliageType)
outputs:
  type_index:     int                          // for use by paint sliver
```

### `com.hayba.foliage.scatter_paint`

The Foliage equivalent of `scatter.pcg_on_landscape` — paints instances of a FoliageType onto the landscape in a region, respecting layer filters. Side-effecting. Uses the UE Foliage System under the hood (HISM, batched, efficient).

```jsonc
params:
  foliage_type:    asset_ref
  region:          { kind: 'rect'|'circle'|'polygon', ... }
  density:         float [0.0001, 50]          // instances per m²
  layer_filter:    asset_ref?                   // only paint where this LayerInfo is painted
  scale_range:     [float, float], default [0.9, 1.15]   // tight by default — the chaos default fights us
  yaw_jitter:      float [0, 360], default 360
  align_to_normal: bool, default true
  seed:            int
outputs:
  instance_count:  int
side_effects:      ['foliage.paint']
```

### `com.hayba.foliage.scatter_kit`

The "biome in one call" sliver — paints a curated set of FoliageType assets at coordinated densities + layer filters. Replaces `python_run`-loop foliage placement entirely. Composed of multiple `scatter_paint` calls.

```jsonc
params:
  kit:             enum ['jungle_floor', 'savanna', 'temperate_meadow', 'high_grass', 'forest_floor', 'cave_floor']
  region:          { ... }
  density_scale:   float [0.1, 3], default 1   // global multiplier
  seed:            int
outputs:
  layers_used:     [string, ...]
  total_instances: int
side_effects:      ['foliage.paint']
```

Each `kit` resolves to a tuned recipe (set of FoliageType assets + their densities + layer filters), mined from the corresponding Learttes pack:

| Kit | Source pack | Recipe |
|---|---|---|
| `jungle_floor` | JungleRuins | FernSm + FernMd + BroadleafSm + BroadleafMd + MonsteraSm + Clover + GrassCluster01–04 at descending densities |
| `savanna` | AfricanVillage | DryGrassPatches + Acacia foliage + DesertShrub at low density |
| `temperate_meadow` | HauntedVillage | TallGrass + Daisy + Thistle + sparse ScrubBush |
| `cave_floor` | MayanCave | (sparse) Moss + Lichen + RockDebris (no grass) |

### `com.hayba.atmosphere.stack`

Build the atmospheric layer for a scene in one call. Side-effecting.

```jsonc
params:
  preset:          enum ['outdoor_jungle', 'outdoor_savanna_dusk', 'cave_dusty', 'foggy_morning', 'rainy_dusk']
  region:          { ... }?                    // bounded if specified, else unbound PostProcessVolume
  override_fog:    { density?, color? }?       // optional fine-tune
outputs:
  ppv_actor:       string
  fog_actors:      [string]
  niagara_actors:  [string]
side_effects:      ['atmosphere.spawn']
```

Each preset bundles the right combination: PostProcessVolume settings (exposure / bloom / vignette), ExponentialHeightFog tuning, optional Niagara volumes (Dust/Fog/Leaves), color grading. Mined from the AfricanVillage + JungleRuins + MayanCave shipped scenes.

### `com.hayba.composition.clearing`

Carve a clearing around a hero point — paints negative-space into the surrounding foliage layer, then optionally drops a path/debris layer in. Side-effecting (composed of paint + foliage erases).

```jsonc
params:
  center:          vec3
  radius:          float                       // cm
  inner_falloff:   float, default 0.4          // sharp inner edge → soft outer
  path_to:         vec3?                       // optional path leading to this clearing
side_effects:      ['landscape.layer.paint', 'foliage.paint']
```

### `com.hayba.placement.spline_kit`

Drives any spline-driven assembly (fence, wall, log_house, path stones). Side-effecting.

```jsonc
params:
  kit:             enum ['fence_wood', 'fence_stone', 'log_wall', 'path_stones', 'rope_bridge']
  points:          [vec3, ...]
  spacing:         float?                       // cm, default per kit
  endpoint_caps:   bool, default true            // adds the corner/cap meshes the validator otherwise warns about
outputs:
  spline_actor:    string
  instance_count:  int
side_effects:      ['actor.spawn']
```

Each kit maps to a specific spline BP from the surveyed packs (`BP_Fence_Spline`, `BP_Spline_log_house`, etc.).

---

## Part 3 — Workflow guardrails

Soft guards that funnel the agent toward the correct primitive.

### 3.1 `placement_intent` parameter on `actor_spawn`

```ts
placement_intent?: 'hero' | 'kit_piece' | 'foliage' | 'debris' | 'light' | 'volume';
```

When `placement_intent: 'foliage'`, the response **rejects** the call with:

```
{ ok: false, error: "Use foliage.scatter_paint or foliage.scatter_kit — placing foliage as StaticMeshActors blocks instancing/HISM and fails environmental-design validation." }
```

It's not just a hint — for `'foliage'` intent, `actor_spawn` refuses. The agent has to use the foliage system.

### 3.2 Foliage-actor count threshold

Independent of intent: when an `actor_spawn` would create a `StaticMeshActor` whose mesh has a known FoliageType variant in the project AND the agent has already spawned ≥ 5 of the same mesh in the last 60 seconds, refuse with the same migration suggestion.

This catches the "I forgot to set intent" case.

### 3.3 "Show me your biome plan first"

A meta-tool: `hayba_environment_plan` that the agent is expected to call once per scene. Input:

```ts
{
  biome: 'jungle' | 'savanna' | 'cave' | ...,
  region: { ... },
  hero_props: [{ class, location, importance }]
}
```

Output: a recommended sequence of sliver calls (`landscape.set_material`, `landscape.paint_layer`, `foliage.scatter_kit`, `atmosphere.stack`, `composition.clearing` around each high-importance hero, etc.) — a plan the agent can either execute as-is or modify. This converts "improvise scene-building" into "fill out a structured plan", which is much more reliable for an LLM.

### 3.4 Asset-class tagger

A one-time pass over the project's Content/ that tags every StaticMesh asset with a class hint (`tree`, `pillar`, `boulder`, `vine`, `foliage_ground`, `prop_freestanding`, `wall`, etc.) based on the asset name + folder + bound shape. Validator rules (rotation plausibility, foliage vs prop) become reliable once meshes are tagged. Stored in a SQLite alongside `pcgex_registry.db`.

### 3.5 "Suggest landscape material" hint

When the validator fires `landscape_default_material`, the suggestion lists the project's available landscape master materials with one-line descriptions (heuristic: read material's exposed parameters and infer "rocky desert vs lush jungle vs temperate"). Agent picks one and the `landscape.set_material` sliver does the rest.

---

## Part 4 — Sequencing

How this ships, on top of the parent spec's sequencing:

| Order | Item | Why | Touches |
|---|---|---|---|
| 1 | **Asset-class tagger (3.4)** — one-time index | Prereq for many validator rules and intent enforcement | TS (new) |
| 2 | **`landscape.set_material` + `landscape_default_material` validator** | Single-step elimination of the checker landscape | TS sliver + UE handler + validator rule |
| 3 | **`foliage.scatter_paint` + `foliage.scatter_kit`** | Replaces `python_run` foliage with the correct UE Foliage System path | TS slivers — uses existing `foliage_add_instance` / `foliage_paint_at` UE handlers |
| 4 | **`placement_intent='foliage'` rejection (3.1)** + **foliage-actor count threshold (3.2)** | Funnel the agent away from `actor_spawn` for foliage | MCP TS schema + count tracking |
| 5 | **Foliage workflow validator rules** (A block) | Catches existing scene rot + flags ongoing mistakes | UE handler |
| 6 | **`atmosphere.stack` sliver** + atmospheric validator rules (C block) | One call for the lighting / fog / PPV layer | TS sliver |
| 7 | **`composition.clearing` + landscape paint rules (B block)** | Carves negative space; eliminates the "buried hero" failure | TS sliver + UE handler |
| 8 | **`placement.spline_kit` + spline rules (D block)** | Replaces linear-actor-array placements with spline-driven assemblies | TS sliver |
| 9 | **`hayba_environment_plan` meta-tool (3.3)** | Structural — converts ad-hoc into structured | TS |
| 10 | **WP / instancing rules (E block)** | Polish — value compounds once everything above is in | UE handler |

Items 1–3 are the bare minimum that would have prevented this session's scene-build failure on its own.

---

## Cross-cutting note: what mining more packs would buy

The 9 packs surveyed already cover **jungle, savanna, cave×2, temperate woods, modular village kit, ruins, dock, lighting tool**. Adding the remaining 35 packs is unlikely to surface a *new* category — most of them are variants (Castle, Cathedral, Mansion, Crypt, …). What they would do is **populate more `foliage.scatter_kit` presets** + provide more `atmosphere.stack` presets per setting. That's a fill-in-the-catalog task that can run in the background once the workflow is in place; not a prereq for the sequencing above.

### Confirming addendum — 3 extra packs surveyed

After writing the body, three more packs landed (`Attic_Environment`, `FoggyJapaneseStreet`, `MedievalCastleVillage`). They behave exactly as the cross-cutting note predicted — no new categories, only fill-in presets:

| Pack | Adds | Preset suggestion |
|---|---|---|
| `Attic_Environment_5.5` | Interior set — zero foliage/landscape/niagara (interior pack convention confirmed) | none |
| `FoggyJapaneseStreet_5.6` | `NS_Leafs_OnGRND` (street leaves) + `NS_NS1_Rain_Light_01` | `atmosphere.stack` preset `urban_rainy_dusk` |
| `MedievalCastleVillage` | `NS_FireFlies` + `NS_Fog` + `NS_Smoke` + 4 LayerInfos + `MI_Rope_Splines` | `atmosphere.stack` preset `medieval_evening_fireflies`; `placement.spline_kit` adds a `rope` kit |

12 packs total now, 13 across the body + this addendum. The conventions (FoliageType + LayerInfos + Niagara atmospherics + spline-driven assemblies for linear repetition) hold consistently.

---

## Out of scope (explicit)

- Procedural landscape sculpting (height maps, erosion) — out; we paint on the existing landscape.
- Authoring new FoliageType assets — out; we use the ones shipped with the packs.
- Multi-level streaming choreography (LOD-based crowd density) — out for v1.
- Photo-real real-time lighting bake — out; the slivers configure the lighting, the artist tweaks if needed.
