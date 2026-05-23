# Agentic Guardrails + Sliver Library — Post-Mortem & Roadmap

**Date:** 2026-05-22
**Status:** Spec — pending approval
**Trigger:** A live scene-building session through MCP produced consistent, embarrassing failures (floating foliage, upside-down trees, default checkerboard landscape, blown-out brazier light, an editor crash). The session is the natural failure-case catalog: this document turns it into deterministic guardrails so an autonomous agent cannot make the same class of mistake again, and into a sliver library that gives the agent the right primitives instead of an escape-hatch `python_run`.

---

## Part 1 — What broke this session, and why

A ruthless list. Each row is something the MCP failed to prevent or actively encouraged.

| # | Failure | Root cause | Why the MCP let it happen |
|---|---|---|---|
| 1 | Every actor spawned at `z=100`, terrain ignored → **all foliage floating** | Agent hardcoded a Z value rather than querying terrain | `actor_spawn` takes a free `[x,y,z]` location and has no "snap-to-surface" mode |
| 2 | `SM_GiantTree_02` placed upside down with `Rotator(0, 200, 0)` | UE Python `Rotator()` positional args are `(roll, pitch, yaw)`, not `(pitch, yaw, roll)` | Agent worked through `python_run` where there is **no schema** to catch the arg-order swap; nothing flagged a tree with 200° roll/pitch |
| 3 | One canopy-vine asset spawned at `z=380` over flat ground → **floating in mid-air** | Hardcoded z for a "canopy" asset; no terrain awareness | Same as #1 — placement has no contract |
| 4 | Brazier `PointLight` intensity set to `120000 cd` (stadium-floodlight range; real brazier ≈ 3000 cd) — blew the foreground out | No range guard on light intensity | The `actor_spawn` path doesn't know "this is a PointLight" — properties are set via `python_run` which has zero domain knowledge |
| 5 | Default landscape material left unassigned → checkerboard ground in every shot | Agent never touched the Landscape's `LandscapeMaterial` | No `landscape_set_material` tool; no validation that "scene has a non-default landscape material" |
| 6 | Spent the session re-implementing scatter inside `python_run` (for-loops over `actor_spawn`) instead of PCG | `python_run` is the path of least resistance; PCG requires constructing `PCGGraphJSON` by hand | No "scatter on landscape / volume / actor" sliver was exposed; pcg_biome sliver shipped in unmerged PR #224 |
| 7 | `wait_for_shaders(45s)` crashed UE — use-after-free in `HaybaMCPIdleHandler::PollOnce` (fix in PR #225) | Raw `FWaitState*` shared between TCP and game-thread ticker | Caught and fixed — but the pattern (raw cross-thread pointer) probably recurs in other handlers; no audit |
| 8 | Agent re-tried the spawn batch after the crash without `level_save` between mutations — would have lost everything again if it crashed twice | No checkpointing pattern in the MCP; `level_save` is a separate manual call | Mutation tools should opt-in/opt-out auto-save, or at least surface "scene has unsaved changes from N mutations" |
| 9 | `python_run` failed silently on `cast_shadows = True` (property read-only in Python — needs `set_cast_shadows`) | UE Python API has dozens of pitfalls (read-only attrs, `niagara_component` vs `get_niagara_component()`, etc.) | Each pitfall is a `python_run` script's problem; typed handlers (e.g. `niagara_spawn`) would hide this once correctly |
| 10 | Camera rotation returned by `editor_capture_viewport` reverse-ordered vs the rotation set by `set_level_viewport_camera_info` (`[34, 0, -18]` came back when `[-18, 34, 0]` went in) | Inconsistent rotation array convention between the editor-Python world and the MCP response | Rotation as a positional 3-array is intrinsically ambiguous; should be a named struct |
| 11 | I told the user "I'm building the scene" while it was visibly junk (Niagara at runtime + floating props) — never verified visually | I captured a screenshot, looked away, claimed success | The MCP gives a screenshot back but the agent has no checklist of "things to look for" |
| 12 | Spawned 150 individual `StaticMeshActor`s for foliage; UE foliage *system* exists (`foliage_paint_at`, `ism_*`) and produces hierarchical instanced static meshes (HISM) with far better performance | Agent reached for the most familiar primitive | Need a clear "if N > 10, you should be using foliage/ISM/PCG" heuristic surfaced by the tool catalog |

**Common thread:** the typed handler set is anaemic — it accepts whatever you throw at it, then forwards to UE, and only fails when UE itself complains. There is no semantic enforcement (rotation plausibility, light unit sanity, snap-to-ground). The escape hatch (`python_run`) is much more powerful but skips all guards entirely. Every failure above is the agent reaching for the more powerful tool because the safer tool is too weak.

---

## Part 2 — Deterministic MCP guardrails

Concrete API changes that make each failure above structurally impossible (or surface a clear "you're doing it wrong" warning).

### 2.1 Rotation as a named struct, never a positional array

**Problem:** `Rotator(0, 200, 0)` could be `(roll, pitch, yaw)` or `(pitch, yaw, roll)`. The agent guessed wrong → upside-down tree.

**Fix:** every tool that takes a rotation accepts ONLY a named struct:

```ts
{ rotation: { pitch: number; yaw: number; roll: number } }   // ← new shape
```

The legacy positional `rotation: [a, b, c]` is rejected by the Zod schema with a clear migration hint: `"rotation must be { pitch, yaw, roll } — positional arrays are ambiguous and are no longer accepted."`

Touches: `actor_spawn`, `actor_transform`, `ism_add_instance`, `foliage_add_instance`, the `placement.*` slivers below, and any sliver that emits a transform.

### 2.2 `placement_mode` on every spawn

**Problem:** hardcoded `z=100`; nothing snaps to terrain.

**Fix:** `actor_spawn` and `actor_transform` grow a `placement_mode` enum:

```ts
placement_mode: 'exact' | 'snap_ground' | 'snap_landscape' | 'snap_to_actor';
placement_target?: string;   // required when mode = 'snap_to_actor'
align_to_normal?: boolean;   // default false; when true, rotate to surface normal
```

- `exact` — keep the supplied location as-is.
- `snap_ground` — line-trace down from `(x, y, +10000)` to `(x, y, -10000)` across all collidable surfaces; place at the first hit. Z in the input is ignored. If no hit, return `{ ok: false, error: "no surface under (x,y)" }` (does NOT silently spawn floating).
- `snap_landscape` — same, but only hits Landscape actors. Skips overlapping props.
- `snap_to_actor` — snap onto a specific actor's surface (placing debris on a boulder).

The UE-side implementation is one `SystemLibrary::LineTraceSingle` call per spawn. Default `placement_mode` is `snap_ground` when the input's `z` is `0` or missing; `exact` when `z` is explicitly supplied. That default means **the next agent that forgets to query the terrain still gets placement right.**

### 2.3 Class-aware rotation plausibility

**Problem:** trees ended up with 200° pitch. There's no "trees stand upright" rule in the system.

**Fix:** an asset-class metadata layer + a validator. For known classes, declare the plausible rotation range:

| Class / tag | Pitch | Roll | Yaw |
|---|---|---|---|
| `tree`, `pillar`, `column`, `statue`, `wall` | ±5° | ±5° | any |
| `boulder`, `large_rock` | ±35° | ±35° | any |
| `foliage_ground` (ferns, grass) | ±15° | ±15° | any |
| `prop_freestanding` (chest, pot, brazier) | ±10° | ±10° | any |
| `vine_canopy` | any | any | any |
| `door` | ±2° | ±2° | any |

`actor_spawn` cross-references the mesh's tags (or path-pattern fallback: `SM_Tree*` → `tree`, `SM_*Rock*` → `boulder`, etc.) and **rejects** spawns with implausible rotations, returning a warning that suggests the closest valid rotation.

For Mesh assets without tags, the agent gets a one-time hint: `"asset has no class tag — defaulting to ±10° / ±10° / any. Tag the asset to tighten."`

### 2.4 Light unit + intensity range guards

**Problem:** 120,000 cd on a brazier.

**Fix:** the `actor_spawn` path for any `*Light` class takes a structured `light` block:

```ts
light: {
  preset: 'candle' | 'torch' | 'brazier' | 'lantern' | 'lamp' | 'rim' | 'fill' | 'key' | 'sun';
  intensity?: number;       // candelas; default per preset
  intensity_units?: 'candelas' | 'lumens' | 'unitless';   // default candelas
  color_temp?: number;      // Kelvin; e.g. 1800 for brazier
  attenuation_radius?: number;
}
```

Each preset carries a sane default + a clamp range. `brazier` defaults to `2500 cd, 800 cm radius, 1800 K`. The agent supplies the *role*; the system supplies the right *magnitude*. An explicit `intensity` outside the preset's plausible range gets a warning, and is clamped if the bounds are hard.

`python_run`-set intensities can't be guarded, but the validator (Part 3) flags any out-of-range light intensity post-hoc.

### 2.5 Auto-validate on mutation

**Problem:** I spawned everything then captured the viewport. No automatic check.

**Fix:** every mutating tool (`actor_spawn`, `actor_transform`, `actor_set_properties`, `foliage_add_instance`, `pcg_execute_graph`, …) optionally runs `scene_validate v2` (Part 3) on the affected actors and returns its findings in a `validation` block:

```ts
{
  ok: true,
  actor_id: "...",
  validation: {
    warnings: [
      { rule: "floating", severity: "error", suggestion: "use placement_mode=snap_ground" },
      { rule: "rotation_implausible", severity: "warn", actual: [0, 200, 0], expected: "tree: pitch±5, roll±5" }
    ]
  }
}
```

Default: on for the typed handlers (cost is one extra line-trace per mutation). The agent reads the `validation` block and self-corrects without needing a separate explicit call.

### 2.6 `python_run` discourager + escape-hatch tax

**Problem:** `python_run` is too easy. Agents reach for it as a first option.

**Fix:** `python_run`'s response includes a `consider_instead` block when a typed handler covers what was attempted:

```ts
{
  ok: true,
  stdout: "...",
  consider_instead: [
    { detected_pattern: "for ... spawn_actor_from_class(StaticMeshActor)",
      suggested_tool: "foliage_paint_at or actor_batch_spawn (placement_mode=snap_ground)" },
    { detected_pattern: "actor.point_light_component.set_intensity",
      suggested_tool: "actor_spawn { light: { preset: 'brazier' } }" }
  ]
}
```

Detection is regex over the script body — coarse but useful. The hint shows up *next to the result* so the agent sees it on the next turn.

### 2.7 Crash-known tool catalog

**Problem:** `wait_for_shaders` under heavy load crashed UE this session (fix shipped PR #225 but not built).

**Fix:** the MCP server maintains a `known_pitfalls.yaml` per plugin version:

```yaml
- versions: ["0.2.0"]
  tool: wait_for_shaders
  pitfall: "Use-after-free under sustained heavy load — see PR #225"
  safe_alternative: "wait_for_idle({ subsystems: ['shaders'], timeout_s: 15 }) — shorter window reduces race likelihood"
```

`hayba_check_ue_status` returns the matching pitfall list at the top of every session, so the agent knows what to avoid against the current plugin build.

### 2.8 Mutation checkpointing

**Problem:** UE crashed; everything I'd spawned was lost.

**Fix:** the routing handle gains a `mutationCounter`. After every N mutations (default 25) — or after any `pcg_execute_graph` — the MCP server auto-calls `level_save` and emits a `checkpoint: { savedAt: ts, level: path }` entry into the operation journal. Crash recovery: the agent reads the journal, sees the last checkpoint, knows what's safe.

### 2.9 Visual-verification checklist for screenshots

**Problem:** I screenshot, looked away, claimed success.

**Fix:** `editor_capture_viewport` returns a `visual_checklist` array the agent is expected to acknowledge in its next reply:

```ts
{
  image_base64: "...",
  visual_checklist: [
    "Does the landscape have a non-default material (not the gray-checker pattern)?",
    "Is every spawned actor visibly contacting the ground (no floating)?",
    "Is any light visibly blowing out (saturated white blob) the foreground?",
    "Is the framing of the intended subject the dominant element?"
  ]
}
```

It's a soft guard, but it forces a moment of "look at the image". Trivially implementable.

---

## Part 3 — `scene_validate v2` spec

Replaces `scene_validate_physics`. Runs as the validator behind 2.5 and as a standalone audit tool.

**Tool name:** `scene_validate` (extending the existing one).
**Inputs:**
```ts
{
  scope?: 'level' | 'tagged' | 'actors';
  tag?: string;               // when scope='tagged'
  actor_ids?: string[];       // when scope='actors'
  rules?: string[];           // omit = all
}
```
**Output:**
```ts
{
  ok: boolean;
  findings: Array<{
    rule: string;
    severity: 'error' | 'warn' | 'info';
    actor_id: string;
    actor_label: string;
    detail: string;
    suggestion?: string;
    autofix?: { tool: string; args: object };   // optional, machine-applyable
  }>;
  counts: { error: number; warn: number; info: number };
}
```

### Rule set (each is one self-contained function)

| Rule id | What it checks | How |
|---|---|---|
| `floating` | Actor's bounds origin is more than 200cm above the nearest geometry below it | Line-trace down from origin; if no hit within 5000cm OR hit-distance > 200cm flag |
| `buried` | Actor's bounds origin is below the nearest geometry by > 50cm | Line-trace down; hit point is *above* the origin |
| `rotation_implausible` | Pitch/Roll outside class-based range (see 2.3) | Lookup actor class/tag in the table |
| `scale_extreme` | Per-axis scale outside [0.1, 10] OR per-axis scale ratio > 5 (non-uniform stretch) | Read actor's transform |
| `intersecting_world_geometry` | Actor's collision bounds penetrate another actor's collision bounds by > 10% volume | UE collision overlap query (already in the legacy `scene_validate_physics` — keep and extend) |
| `light_intensity_implausible` | PointLight/SpotLight in candelas outside [50, 50000]; SkyLight/DirectionalLight outside [0.1, 15] | Read component property |
| `light_attenuation_implausible` | PointLight/SpotLight attenuation > 10000 cm (probably a typo — most props don't light a whole map) | Read |
| `default_label` | Label matches the auto-generated `<Class>_<n>` pattern | Regex on label |
| `default_material` | StaticMeshComponent uses the engine's `M_WorldGridMaterial` / default-grey | Read material slot 0 |
| `landscape_no_material` | Active level's `Landscape` has the engine default material or no material | Read landscape's `LandscapeMaterial` |
| `missing_mesh` | StaticMeshActor with no static mesh assigned | Read `static_mesh_component.static_mesh` |
| `actor_below_killz` | Actor Z below world's `KillZ` (would despawn at runtime) | Read WorldSettings |
| `niagara_no_asset` | NiagaraActor with no asset assigned | Read |
| `pcg_no_components` | PCG actor present but PCGComponent missing or empty graph | Read |
| `excessive_actor_count` | More than 50 identical-class actors with identical scale exist (should be HISM/PCG/foliage instances, not separate actors) | Count by class+scale signature |
| `unsaved_long_lived_changes` | Level has been dirty for > 100 mutations without `level_save` | Read mutation counter |
| `light_redundancy` | Two lights within 50cm of each other (probably an accidental duplicate) | Spatial query |
| `actor_outside_used_world_partition_cells` | Spawned outside any loaded WP cell (effectively invisible) | Cross-reference WP loaded cells |
| `default_skybox_below_atmospheric` | Skybox material is the engine default while a SkyAtmosphere is present (looks wrong) | Read sky |

`autofix` is populated for rules where the fix is mechanical and unambiguous:

| Rule | Autofix |
|---|---|
| `floating` | `actor_transform { actor_id, placement_mode: 'snap_ground' }` |
| `rotation_implausible` | `actor_transform { actor_id, rotation: { pitch: clamp, roll: clamp, yaw: keep } }` |
| `light_intensity_implausible` | `actor_set_properties { intensity: <clamp> }` |
| `default_label` | none — labels are agent's responsibility |

A `--apply-autofix` flag on the tool lets the agent batch-correct everything in one call.

### Implementation notes

- Validator runs on the game thread (line traces need GWorld); single-pass over the requested actor set.
- Class lookup table loaded once at startup from `Plugins/HaybaMCPToolkit/Config/HaybaMCPValidation.json` so non-engineers can extend it.
- Each rule is a pure function `(World*, AActor*) → findings[]`; testable in isolation.

---

## Part 4 — Sliver library mined from the Learttes packs

Surveyed 7 of the 44 packs (`JungleRuins`, `MayanCave`, `Temple`, `LightingTool`, `Fishing_Dock_5.1`, `HauntedVillage`, `Lakeside_Village_Environment_5.1`). The patterns below recur across all of them, not just one.

### The placement primitives (the missing safety nets — highest priority)

These are the slivers the agent should have reached for *this session* instead of `python_run` loops. They are the deterministic-placement layer.

#### `com.hayba.placement.snap_to_surface`

Take a mesh + an (x,y) and place it correctly on the terrain. Pure: returns the resolved transform; does *not* spawn.

```jsonc
params:
  mesh:           asset_ref (StaticMesh)
  xy:             vector3 [x, y, 0]          // z ignored
  align_to_normal: bool, default false
  yaw_deg:        float [0, 360], default 0
  scale:          float [0.05, 20], default 1
  surface_filter: enum ['any', 'landscape', 'actor'], default 'any'
outputs:
  transform:      { location: [x,y,z], rotation: { pitch, yaw, roll }, scale: [s,s,s] }
  hit_actor:      string                       // what we landed on
```

#### `com.hayba.placement.batch_snap`

Same as above for a list of (mesh, xy) tuples; returns the full transform list. Pure. The agent computes its grid/cluster/spline points in pure code (or via another sliver) and then asks this sliver to ground-snap them all at once — one batched line-trace per item.

#### `com.hayba.scatter.pcg_on_landscape`

Build a PCG topology that scatters a mesh (or weighted mesh set) onto the Landscape's surface, sampled by a density. Side-effecting (creates + executes a PCG graph). Supersedes the earlier `pcg_biome` sliver shape by handling the source-actor question correctly (Landscape, not a generic volume).

```jsonc
params:
  meshes:           [{ asset_ref, weight: float }]    // weighted picker
  bounds:           { min: [x,y,z], max: [x,y,z] }    // restrict scatter to this AABB
  density:          float [0.0001, 100]               // points / m²
  min_distance:     float [0, 5000]                   // Poisson-ish spacing
  align_to_normal:  bool, default true                // terrain-aware
  scale_range:      [float, float]
  yaw_jitter:       float [0, 360]
  layer_mask:       string?                            // landscape paint layer name (only scatter where painted)
  seed:             int
outputs:
  graph_asset:      string
  instance_count:   int
side_effects:       ['pcg.graph.create', 'pcg.graph.execute']
```

#### `com.hayba.scatter.pcg_on_volume`

Same shape but bound to a volume actor (Box/Cylinder Brush) rather than the landscape. Same param shape minus `layer_mask`, plus `area_actor: actor_ref`.

#### `com.hayba.scatter.pcg_on_actor_surface`

Scatter onto another mesh's surface — debris on a boulder, moss on a wall. `target_actor: actor_ref`, the PCG topology uses `PCGSurfaceSamplerSettings` against the target's mesh.

#### `com.hayba.placement.array_along_spline`

Distribute N copies of a mesh along a spline (recurring HauntedVillage `BP_Fence_Spline` pattern + every modular kit). Side-effecting (creates the spline if needed). Or pure: returns the transform list, caller spawns.

```jsonc
params:
  mesh:           asset_ref
  spline_points:  [{ location: vec3, tangent: vec3 }]
  spacing:        float                       // cm between instances
  yaw_alignment:  enum ['spline_tangent', 'fixed', 'random']
  scale_range:    [float, float]
  seed:           int
outputs:
  transforms:     [{ location, rotation, scale }, ...]
```

### The content slivers (mined from recurring assets across packs)

Each of these bundles a recurring asset pattern. Lower priority than the placement primitives — but each one is what the agent actually needs to "place a candle" or "drop a campfire" in one call instead of `python_run`-ing several lines.

#### `com.hayba.lighting.candle`

Mined from MayanCave's `BP_Candle_01..05`. Bundle: a candle mesh + a small Niagara flame + a warm point light. Drops a complete candle in one call.

```jsonc
params:
  location:       vector3, snap_to_surface implicit
  flame_scale:    float [0.5, 2], default 1
  light_color:    color hex, default '#FFB860'
  light_intensity: float [1, 50] (candelas), default 8
outputs:
  candle_actor:   string
  flame_actor:    string
  light_actor:    string
side_effects:     ['actor.spawn', 'niagara.spawn']
```

#### `com.hayba.lighting.torch`

Mined from MayanCave's `BP_FireTourch` + JungleRuins `NS_NS1_Fire_Torch`. Same shape as candle but bigger flame, hotter color, wall-mountable. Optional `wall_actor: actor_ref` snaps it to a wall surface.

#### `com.hayba.props.fire_camp`

Mined from `NS_NS1_Fire_Camp` (appears in JungleRuins AND MayanCave — same asset shipped across packs). A campfire = ring of stones + central log + flame + warm light + subtle smoke. Light defaults to `brazier` preset (2500 cd, 1800 K, 800 cm radius — the right numbers, not 120000).

#### `com.hayba.lighting.god_ray`

Mined from JungleRuins `BP_GodRay` + `SM_GodRay_Plane`. A volumetric shaft of light through a canopy gap. Params: source direction (yaw + pitch), intensity, color, length. Bundles a mesh plane with the god-ray material + a SpotLight along the same axis for the ground splash.

#### `com.hayba.atmosphere.particle_volume`

Mined from MayanCave's `NS_NS1_Dust_01`, `NS_NS1_Fog_01`, `NS_NS1_Leaves_01` (three siblings). A bounded atmospheric particle effect.

```jsonc
params:
  preset:        enum ['dust', 'fog', 'leaves', 'embers', 'pollen']
  bounds:        { min: vec3, max: vec3 }    // emission volume
  intensity:     float [0, 5], default 1
  wind:          vec3                          // optional bias
```

Each `preset` resolves to a specific Niagara System in the Learttes packs.

#### `com.hayba.atmosphere.local_fog_card`

Mined from HauntedVillage's `BP_Fog_Card` + `BP_Local_Fog`. A localized fog card oriented at a normal — useful for low-lying ground fog around a clearing.

#### `com.hayba.composition.handcam_shake`

Mined from JungleRuins's `BP_CameraShake` + `BP_CameraShake_Handcam`. A composition sliver that applies a hand-held shake profile to a camera, with parameters for amplitude / freq / damping. Pure: returns the shake curve; caller applies via `seq_add_track`.

#### `com.hayba.cinematic.stills_set`

Mined from JungleRuins's `LL_Stills_Showcase_Cinematic` + 22 `LS_Stills_*` sequences. A composition sliver that builds a "cinematic stills tour" of N camera framings around a target actor (or set of actors). Returns a Level Sequence path. Side-effecting.

#### `com.hayba.lighting.three_point`

Mined from LightingTool's `BP_DynamicLight_AC`. A classic key + fill + rim three-point setup around a target actor. Parameters: target_actor, key_intensity, key_color_temp, fill_ratio, rim_intensity. Side-effecting.

#### `com.hayba.composition.shrine_ensemble`

Composition sliver mined from this session — the shrine + 2 serpent-guardian statues + offering bowl + pots layout pattern. Pure: returns transforms. Lets the agent say "give me a shrine ensemble centered at X facing Y" instead of placing six props one-by-one with hardcoded offsets.

### Layered architecture (what calls what)

```
                ┌────────────────────────────────┐
                │  Content slivers (candle,       │
                │  fire_camp, god_ray, …)         │
                └──────────────┬─────────────────┘
                               │ uses
                ┌──────────────▼─────────────────┐
                │  Placement primitives          │
                │  (snap_to_surface, pcg_on_*)   │
                └──────────────┬─────────────────┘
                               │ uses
                ┌──────────────▼─────────────────┐
                │  Typed MCP handlers (actor_*,  │
                │  pcg_*, niagara_*) — guarded   │
                │  by Part 2 + Part 3.            │
                └────────────────────────────────┘
```

The content slivers (candle/torch/etc) are thin recipes calling the placement primitives. The placement primitives are thin recipes calling the guarded typed handlers. Nothing reaches for `python_run`.

---

## Part 5 — Sequencing

What ships first, ordered by `(impact × prerequisites)`:

| Order | Item | Why first | Touches |
|---|---|---|---|
| 1 | **Crash fix** PR #225 (`wait_for_idle` use-after-free) | Already done — must merge + rebuild before any other UE work | UE plugin |
| 2 | **2.1 Named rotation struct** + **2.3 class-aware rotation plausibility** | Prevents the upside-down tree class of bug across every spawn path | MCP TS schemas + UE handler |
| 3 | **2.2 `placement_mode=snap_ground`** | Prevents the floating-foliage class of bug. Single line-trace per spawn; cheap. | UE handler |
| 4 | **Part 3 `scene_validate v2`** (rules `floating`, `rotation_implausible`, `default_material`, `light_intensity_implausible`, `missing_mesh` to start) | Catches existing scene rot, supports autofix | UE handler |
| 5 | **2.5 Auto-validate on mutation** | Closes the feedback loop — agent self-corrects without explicit calls | MCP TS + UE handler |
| 6 | **Placement primitive slivers** (`snap_to_surface`, `batch_snap`, `array_along_spline`) | Gives the agent a clean alternative to `python_run` loops | TS slivers (composition.* / placement.*) — uses 2.2 internally |
| 7 | **PCG scatter slivers** (`pcg_on_landscape`, `pcg_on_volume`, `pcg_on_actor_surface`) | Replaces hand-rolled scatter with the correct PCG path; supersedes the unmerged `pcg_biome` from PR #224 with the right shape | TS slivers — uses the existing `create_graph`/`execute_graph` UE commands via the just-merged `ctx.dispatch` seam (assuming PR #224 also merges) |
| 8 | **Content slivers** (`candle`, `torch`, `fire_camp`, `god_ray`, `particle_volume`, `local_fog_card`, `handcam_shake`, `three_point`, `shrine_ensemble`) | Cheap to add once 6 + 7 land — each is ~30 lines of TS calling the lower layers | TS slivers |
| 9 | **2.6 `python_run` discourager** + **2.7 crash-known catalog** | Soft guards — value compounds with everything above | MCP TS |
| 10 | **2.8 Mutation checkpointing** | Insurance — value depends on UE crash rate, which Part 5.1 reduces | MCP TS |
| 11 | **2.9 Visual-verification checklist** + **`cinematic.stills_set`** sliver | Polish — once the rest is right | MCP TS |

Items 2 through 4 land in one PR-able batch (~5 files of TS, ~3 files of UE C++). That batch alone would have made this session's scene buildable correctly on the first attempt.

---

## Out of scope (explicit)

- Re-mining the other 37 Learttes packs in detail — patterns surveyed cover the recurring asset categories (lit flames, atmospheric particles, modular spline kits, cinematic stills). Per-pack drill-down can grow the catalog later but isn't a prerequisite.
- New PCG node authoring — the slivers compose existing standard-PCG nodes via the on-disk `pcgex_registry.db`.
- Replacing `python_run` — it stays as the escape hatch. The fix is making the right tools attractive enough that the agent doesn't reach for it.
- UE-side validation of the typed `light` block at C++ level (a v2 if the TS schema isn't enough).
