# Slivers — User-Authorable Deterministic Abstractions

**Status:** Draft v1
**Date:** 2026-05-21
**Owner:** saracensaray
**Related:** Gemini three-layer architecture (Layer 2 — Deterministic Abstraction); `.scratch/mcp-architectural-issues.md` items #8, #9, #10, #11, #12

## Problem

The Hayba MCP toolkit ships verified plumbing for Layer 2 (`wait_for_idle`, `render_camera`) but no Layer 2 *primitives*. Gemini's architectural guidance is explicit: the LLM must never emit raw coordinates, fluid dynamics, or geometric intersections — it must emit bounded parameters that deterministic compiled code resolves. We have nothing in that shape today.

Building one-off C++ tools for every Layer 2 need (PCG diff, ASP constraint, lighting preset, frame_target, time_of_day, …) scales linearly with the design space. We need a **container format** that lets us ship many deterministic abstractions cheaply, with a consistent LLM-facing schema and a consistent user-facing tuning UI.

## Concept: Slivers

A **Sliver** is a small, parameterized, deterministic abstraction with:

- A declared parameter schema (the dials the user/LLM can turn)
- A deterministic executor (the code that consumes params and produces output)
- A declared determinism contract (purity, declared outputs, declared side effects)
- A generic slider/widget UI rendered in the UE plugin Details panel
- A portable JSON spec that's shareable as a single file

The LLM emits intent ("frame the hero from above"); the user (or the LLM) selects a sliver and provides params; the sliver's deterministic executor produces the result. Sliders let the human close the spatial-reasoning gap LLMs can't.

This is the operational form of Voyager's "executable skill library" cited by Gemini, adapted for an in-editor MCP context.

## Goals

- One container format covers every Layer 2 category we'll ship (composition, lighting, PCG diff, sim params, ASP constraint, visibility queries, executable skills).
- Adding a new category = new TS executor module + new param-widget registration. No new UI framework, no new tool wiring per sliver.
- A sliver is shareable as a single JSON file. Importable from local path or URL. No registry server.
- The LLM's discovery surface stays small — sliver tooling lives in `ALWAYS_ON_META` (4 tools) and slivers themselves are discovered via `hayba_sliver_list`, not by registering each as an MCP tool.
- Determinism is documented and conventional in v1, with a path to verifier-enforced determinism in v2.

## Non-goals (v1)

- No node editor. Slivers are authored as JSON + TS. The "graph" of sliver-calls-sliver is implicit in code, not visual.
- No public registry/database. Sharing is file + URL + optional GitHub blessed-slivers repo (deferred).
- No AI authoring loop (`sliver_draft`). Hand-authored only in v1.
- No sandbox / determinism enforcement. Convention only.
- No per-sliver MCP tool registration. All sliver execution flows through `hayba_sliver_run`.

## Architecture

### Identity & namespacing

Sliver IDs are **reverse-DNS** strings, e.g. `com.hayba.composition.frame_target`, `com.saracensaray.world.coastal_town`.

- Eliminates collision risk on URL import from untrusted authors.
- The `com.hayba.*` namespace is reserved for core/blessed slivers.
- Community slivers use the author's chosen domain or handle namespace.
- IDs are case-sensitive and use lowercase + dots.

### Storage layout

```
%APPDATA%\Hayba\slivers\
  com.hayba.composition.frame_target.sliver.json
  com.hayba.composition.frame_target.preset.json   (optional, per-sliver saved presets)
  com.hayba.lighting.time_of_day.sliver.json
  com.saracensaray.world.coastal_town.sliver.json
```

Per-user, cross-project. The UE plugin and MCP server both read from this directory.

TS executors ship inside the MCP server:

```
mcp-tools/hayba-mcp/src/slivers/
  registry.ts                          # category → executor lookup
  types.ts                             # SliverSpec, SliverParam, SliverOutput, etc.
  runtime.ts                           # runSliver(id, params) → output (with cycle detection)
  loader.ts                            # reads %APPDATA%\Hayba\slivers\*.sliver.json
  composition/
    frame_target.ts
  lighting/
    time_of_day.ts
```

Each TS executor registers itself with the runtime against an `executor.kind` string. The JSON spec is the LLM/UI-facing contract; the TS is the implementation. Loading a sliver whose `executor.kind` isn't registered yields a clear error at list/run time.

### Sliver JSON spec v1

```jsonc
{
  "id": "com.hayba.composition.frame_target",
  "version": "1.0.0",
  "category": "composition",
  "title": "Frame Target",
  "description": "Compute a camera transform that frames an actor from a given orbit angle, distance, and height offset.",
  "author": "core",

  "params": [
    {
      "id": "target",
      "type": "actor_ref",
      "label": "Target",
      "required": true
    },
    {
      "id": "distance",
      "type": "float",
      "label": "Distance (m)",
      "range": [1, 100],
      "default": 10
    },
    {
      "id": "height",
      "type": "float",
      "label": "Height offset (m)",
      "range": [-10, 50],
      "default": 2
    },
    {
      "id": "fov",
      "type": "float",
      "label": "Field of view (deg)",
      "range": [20, 120],
      "default": 70
    },
    {
      "id": "yaw_deg",
      "type": "float",
      "label": "Orbit angle (deg)",
      "range": [0, 360],
      "default": 45
    }
  ],

  "executor": {
    "kind": "composition.frame_target"
  },

  "determinism": {
    "pure": true,
    "declared_outputs": ["camera_transform"],
    "side_effects": [],
    "seed_param": null
  }
}
```

### Param types (v1)

| Type | Widget | Notes |
|---|---|---|
| `float` | slider | `range: [min, max]`, optional `step` |
| `int` | slider | integer step |
| `bool` | checkbox | |
| `string` | text input | optional `maxLength` |
| `enum` | dropdown | `options: [{value, label}]` |
| `color` | color picker | sRGB hex string in/out |
| `actor_ref` | scene actor picker (UE-side) | optional `class_filter` |
| `asset_ref` | Content Browser picker (UE-side) | optional `class_filter` |
| `vector3` | three-float widget | optional `range` per axis |
| `transform` | location + rotation + scale composite widget | |

Adding a param type = (1) extend the discriminated union in `types.ts`, (2) add a widget in the UE plugin Details panel, (3) document. This is the explicit extensibility seam.

### Determinism contract

A sliver declares:

- `pure: bool` — true means same params → same output, no observable side effects. False means it mutates editor state (spawns actors, changes lighting, etc.).
- `declared_outputs: string[]` — names of fields the executor returns. The runtime validates the executor's return value matches this set.
- `side_effects: string[]` — vocabulary of declared mutations: `actor_spawn`, `actor_modify`, `asset_load`, `asset_create`, `lighting_change`, `pcg_generate`, etc. Used by the future dependency-DAG.
- `seed_param: string | null` — name of the param that seeds any RNG. If non-null, the runtime requires the executor to be deterministic given the same seed.

V1 is **convention only** — we document, we don't enforce. Trust authors; rely on social review for blessed slivers. V2 ships `hayba_sliver_verify` that re-runs with the same params and diffs outputs.

### Composability (sliver calls sliver)

A TS executor is an `async (params) => output` function. It can `await runSliver(id, params)` to compose primitives. Example: a hypothetical `com.hayba.world.coastal_town` executor might call `com.hayba.lighting.time_of_day` internally to pin the lighting for its preview render.

Guardrails:

- **Cycle detection** via per-invocation call stack (Set of IDs). Throws `SliverCycleError` if a sliver re-enters its own call stack.
- **Max depth** = 8 by default. Configurable via UE plugin setting `MaxSliverDepth`.
- **Output binding** — callers consume outputs by name from `declared_outputs[]`. Schema mismatch throws at runtime.
- **Side-effect aggregation** — the runtime accumulates `side_effects[]` across the call tree and returns them in the top-level result, so the caller can see what was actually touched.

Sliver-to-sliver edges form the foundation of the dependency-DAG (phase 3): the runtime can record these edges, and downstream dirty-flag propagation can walk them.

### MCP tool surface

Four tools added to `ALWAYS_ON_META` (joining the existing 10):

| Tool | Signature | Behavior |
|---|---|---|
| `hayba_sliver_list` | `{ category?, namespace? }` → `{ slivers: [{id, title, category, version}] }` | Lists installed slivers from `%APPDATA%\Hayba\slivers\`. Optional filters. |
| `hayba_sliver_get` | `{ id }` → `{ spec, last_params? }` | Full JSON spec + most-recently-used param values if any. |
| `hayba_sliver_run` | `{ id, params }` → `{ ok, outputs, side_effects, durationMs, error? }` | Validates params against spec, dispatches to executor, returns outputs. |
| `hayba_sliver_import` | `{ source: file_path \| url }` → `{ id, installed }` | Fetches, validates against JSON schema, installs to `%APPDATA%\Hayba\slivers\`. |

Slivers themselves are **not** registered as MCP tools — the LLM discovers them via `hayba_sliver_list` and invokes via `hayba_sliver_run`. This keeps the LLM's tool surface bounded regardless of how many slivers exist.

### UE plugin — Slivers tab

New tab in the existing Hayba Details panel:

- **Left rail:** installed slivers, grouped by category (collapsible)
- **Right pane:** selected sliver — title, description, generated param widgets (one per `params[]` entry), "Run" button, last-run output preview
- **Preset row:** "Save preset" writes `<sliver_id>.preset.json` next to the spec; "Load preset" dropdown lists saved presets
- **Settings (plugin settings panel, not per-sliver):**
  - `SliverRunMode: Manual | AutoDebounced250ms`
  - `MaxSliverDepth: int (default 8)`

Auto-debounced mode re-runs the sliver 250ms after the last slider change. Manual requires "Run" click. Per-project setting; lets users opt into the live feel for cheap slivers and opt out for heavy ones (full tectonics re-runs).

### Sharing — v1 mechanics, v2 ecosystem

V1:

- A sliver is a single `.sliver.json` file. Self-contained, copy-paste-able, attach-to-email-able.
- `hayba_sliver_import` accepts a local path or URL. URL import validates schema before installing and warns on first import per author: *"This sliver will execute on your machine. Source: <url>. Author: <id>. Proceed?"*
- Trust model is social, not platform — same as installing a UE plugin. No sandbox claim.

V2 (deferred):

- A `blessed-slivers` GitHub repo bundled with the toolkit. Pull requests = de facto review.
- Optional manifest with `dependencies: [other sliver IDs]` for slivers that compose others.
- Possible registry server if the social/git model proves insufficient.

## V1 categories and shipped slivers

| Category | First sliver | Executor | Determinism |
|---|---|---|---|
| `composition` | `com.hayba.composition.frame_target` | Computes camera transform from actor bounds + orbit + distance + height + FOV. Pure math, returns `camera_transform`. | `pure: true` |
| `lighting` | `com.hayba.lighting.time_of_day` | Atomic update of DirectionalLight angle + intensity, SkyLight intensity, SkyAtmosphere sun rotation, ExpHeightFog scattering, PostProcess exposure compensation, from a single `time_of_day: [0..1]` param. | `pure: false`, `side_effects: ['lighting_change']` |

These two prove the format generalizes (one pure return-value sliver, one mutating side-effect sliver) without hand-wave.

## Phase plan

1. **v1 ship (this design):** runtime + JSON spec + UE Slivers tab + 4 MCP tools + `frame_target` + `time_of_day`. One PR.
2. `pcg_diff` category — Gemini's headline Layer 2 primitive. PCG graph param overrides via JSON patch.
3. Dependency-DAG + dirty-flag — leverages the sliver-call graph already being recorded by the runtime.
4. `sim_params` category — `tectonics_init` sliver, pairs with the in-flight baking-pipeline rework.
5. `com.hayba.sliver_draft` AI authoring tool — LLM generates draft slivers from intent, saves to `%APPDATA%\Hayba\slivers\draft\` for user promotion.
6. `visibility` category — `is_visible`, `frustum_query`. Composes naturally with `composition`.
7. `asp_constraint` category — heaviest swing. ASP solver for urban/cultural layouts.
8. URL import polish + blessed-slivers GitHub repo seeded with the first 5+ categories.

## Risks & open questions

- **Convention-only determinism may be too loose.** A community sliver claiming `pure: true` but secretly mutating state could break the DAG once we ship it. Mitigation: v2 `sliver_verify`; until then, trust author + blessed-repo PR review.
- **`actor_ref` and `asset_ref` widgets require UE-side picker UI.** That's plugin work, not pure TS. Scope this honestly in the implementation plan.
- **Composability + side effects = surprising rollback semantics.** If `coastal_town` calls `time_of_day` mid-execution and then errors, lighting stays changed. V1 accepts this — no transaction layer. V2 could add the operation journal (post-mortem #12) and use it for rollback.
- **Reverse-DNS IDs are unfun to type.** Acceptable trade-off for unambiguous URL import. UE picker uses `title` for display; reverse-DNS is only seen in JSON and CLI.

## Out of scope

- Public registry, moderation, sandboxing of community slivers (v2+).
- Visual node editor (intentionally rejected — see "Non-goals").
- Sliver versioning beyond semver string in JSON (no migration tooling in v1).
- Cross-engine slivers (UE-only; Unity/Godot not considered).

## Success criteria

- Both shipped slivers are usable end-to-end from the UE Slivers tab without restarting the editor.
- The LLM can list, fetch, and execute slivers using only the 4 always-on tools.
- Adding a third category requires changes only in `mcp-tools/hayba-mcp/src/slivers/<new-category>/` and the UE param-widget registry — no MCP tool surface changes, no spec changes.
- One sliver imported from a local path via `hayba_sliver_import` works identically to a built-in one.
