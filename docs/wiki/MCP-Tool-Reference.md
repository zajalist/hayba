# MCP Tool Reference

This page explains **how** to discover the tool surface — it deliberately
does not enumerate every tool, because the catalog is derived at runtime, not
maintained by hand.

## The surface is derived from Zod schemas

Each tool registers a Zod schema. At registration time
(`mcp-tools/hayba-mcp/src/tools/index.ts`) the server also calls
`recordSchema(...)` into the schema registry
(`src/tools/schema-registry.ts`). `get_tool_signature` then **derives** a
command's parameter documentation by walking that exact Zod shape — so the
documented signature can never drift from the schema used to validate
inputs. There is no hand-maintained tool dictionary.

## Discovery is runtime, via Code Mode

By default the server exposes only **3 meta-tools**:

- **`list_tool_categories`** — enumerates the domains and their command
  names (filters out tools disabled in the MCP panel).
- **`get_tool_signature`** — returns the derived JSON schema for one
  command, with a "did you mean" hint on a miss.
- **`python_run`** — escape hatch into UE's `PythonScriptPlugin` for
  anything not covered by a typed command.

The full ~100-tool catalog is only registered eagerly when
`HAYBA_CODE_MODE=off`. To know what exists at any moment, call
`list_tool_categories` against the running server — that is the source of
truth, not this page.

## World ingestion and asset preparation

These four tools share the runtime catalog and are discoverable in both eager
and Code Mode registration. Use `get_tool_signature` for their current schemas.

| Tool | Input and result |
|---|---|
| `world_inspect` | `{}`; read-only world identity, landscapes, partition/grid/layer facts, save readiness, capability flags, warnings and recommended defaults. Engine capability flags do not imply a workflow writer is available. |
| `world_ingest` | Required `source` and `destination`, optional `terrain`, `partition`, `assets`, `materials`, `validation`, `execution`; returns a staged `WorkflowResult`. |
| `asset_inspect` | `{ "asset_path": "/Game/Terrain/SM_Tile" }`; existing Python-backed metadata inspection: asset class, dirty flag, dependency/referencer counts and optional disk metadata. It does not return preparation-policy decisions. |
| `asset_prepare` | `{ "assetPath": "...", "policy": { "intent": "terrain", ... } }`; inspects a StaticMesh and applies supported preparation settings, returning a `WorkflowResult`. |

The preparation-specific inspector is internal; `asset_inspect_preparation` is
not a published tool. Note the existing `asset_path` spelling on `asset_inspect`
and `assetPath` on `asset_prepare`.

### Request policies and current support

The request schema allows future source/destination adapters. Schema acceptance
does not guarantee native execution support.

| Field | Accepted values and current behavior |
|---|---|
| `source.kind` | `heightmap` (`path`, optional `format`), `landscape_export` (`path`), `mesh_terrain` (`path`), `connector_artifact` (`connector`, `artifactId`). Native ingestion currently supports only a single heightmap file; declared formats are `png` or `r16`. There is no tile-manifest/assembly support. File decoding and dimensions are checked by the existing native importer during execution. |
| `destination.mode` | `open_world`, `new_world` (optional `path`), `managed_update` (required `importId`). Only `open_world` is currently executable; other modes return `destination_mode_unavailable` before mutation. |
| `terrain` | Optional `worldSizeKm`, `maxHeightM`, `actorLabel`, `material`, `scale`. Heightmap defaults are `8`, `600`, and `Hayba_Terrain`; `material` assigns an existing landscape material. Explicit `scale` is currently unsupported. |
| `partition.mode` | `preserve`, `configure`, `require`. `preserve` accepts no configuration fields. The other modes allow `runtimeGrid` (`name`, positive `cellSize`, positive `loadingRange`), `dataLayers` (`include`, `exclude`), and `hlod` (`layer`, `build`: `preserve`, `auto`, `require`). Native partition/HLOD writers are unavailable: optional requests report limitations; unavailable requirements stop before import. Omitted partition policy defaults to `preserve` for a partitioned world and `configure` otherwise. |
| `assets.intent` / `policy.intent` | Required when supplying an asset policy: `environment`, `hero`, `foliage`, `terrain`, `custom`. Heightmap ingestion creates landscapes, so mesh preparation is skipped when no mesh assets were imported. Use `asset_prepare` for an existing StaticMesh. |
| `nanite` | `preserve`, `auto`, `enable`, `disable`. No Nanite writer is available. Explicit `enable`/`disable` fail before any asset mutation; `auto` does not enable Nanite. |
| `collision` | `preserve`, `auto`, `simple`, `complex`, `none`. No collision writer is available; these policies do not change collision. |
| `lods` | `preserve`, `auto`, or `{ "count": positiveInteger, "reduction": numberFrom0To1 }` (both object fields optional). Only reduction of existing non-base LODs is implemented, preserving inspected screen sizes. A supplied count must match the existing count; LOD creation is unavailable. `auto` currently performs no LOD mutation. |
| `lightmapUvs` | `preserve`, `generate`, `require`. Generation is unavailable; `generate` skips it and `require` fails before asset mutation. |
| `materialInstances` | `preserve`, `create`, `require`. Creation is unavailable; `create` skips it and `require` fails before asset mutation. |
| `materials.mode` | `preserve`, `create`, `require`. World material creation is unavailable: `create` reports unsupported and may continue; `require` stops before import. |
| `validation.mode` | `skip`, `report`, `require`; default `report`. Native validation checks current-world identity and presence of imported landscape paths only. It does not validate geometry, performance or PLUMB constraints. |
| `execution` | Optional booleans `dryRun`, `planMode`. `dryRun:true` performs inspection, normalization and planning, then skips execution. Unsupported requests still fail preflight in dry run. `planMode:true` returns `plan_mode_control_unavailable`; `false` does not disable native Plan Mode gates. |

Native successful ingestion requires an existing writable, open, non-partitioned
world. Partitioned worlds can reach import, but the workflow warns during
normalization and stops at `saveVerify` with
`external_actor_persistence_unavailable`, retaining imported resources. Map-only
saving cannot verify World Partition external actor packages. No partition
conversion, runtime-grid tuning or HLOD building is implemented here.

### Heightmap example

Call `world_ingest` with this request to preview a supported single-file import:

```json
{
  "source": { "kind": "heightmap", "path": "D:/Terrain/tile_x0_y0.r16", "format": "r16" },
  "destination": { "mode": "open_world" },
  "terrain": { "worldSizeKm": 2, "maxHeightM": 350, "actorLabel": "Tile_0_0" },
  "partition": { "mode": "preserve" },
  "validation": { "mode": "report" },
  "execution": { "dryRun": true }
}
```

Set `dryRun` to `false` to execute against the open world. A tile-like filename
is still one heightmap, with no inferred neighboring tiles or placement offsets.
Dry run does not decode the file or prove that import/save will succeed.

### Mesh terrain and Nanite example (currently unsupported)

This valid `world_ingest` request returns `source_kind_unavailable` before mutation:

```json
{
  "source": { "kind": "mesh_terrain", "path": "/Game/Terrain/SM_Tile" },
  "destination": { "mode": "open_world" },
  "assets": { "intent": "terrain", "nanite": "enable" }
}
```

For an already imported mesh, `asset_prepare` with
`{ "assetPath": "/Game/Terrain/SM_Tile", "policy": { "intent": "terrain", "nanite": "enable" } }`
also fails before mutation because the Nanite writer is unavailable. To edit
existing LODs, use a policy such as
`{ "intent": "terrain", "nanite": "preserve", "lods": { "count": 2, "reduction": 0.5 } }`
on a mesh that already has two LODs. Optional unavailable asset policies may be
skipped while `ok` is true; that result does not prove Nanite, collision, UVs or
materials changed, or that the asset package was saved and verified.

### Results, interruption and migration

`world_ingest` runs `inspect → normalize → plan → terrain → partition → assets →
saveVerify → validate`. Its result includes `ok`, `operationId`, `summary`,
ordered `stages`, `affectedResources`, directional `verdicts`, `remediation` and
an undo description. Stage statuses are `pending`, `running`, `succeeded`,
`failed`, `skipped`, `unsupported`; incomplete dependency results are returned
as a failed stage, not successful ingestion. Optional unsupported stages may
coexist with `ok:true`; hard failures stop the workflow and set MCP `isError`.

Import verification requires newly observed landscape paths in the original
world. Save verification requires native `saved:true`, `verified:true` and
`dirty:false`. A partial failure retains known affected resources for inspection
and remediation; there is no automatic rollback. If post-import inspection
fails, the outcome is explicitly unknown and resources cannot be enumerated.
Programmatic callers of `runWorldIngest` can supply an `AbortSignal`; cancellation
stops before the next stage and retains completed work. The published MCP tool
does not currently wire MCP cancellation into that signal or interrupt an
in-flight native operation.

`hayba_import_landscape` and `import_landscape` remain callable for one release
and are deprecated in favor of `world_ingest`. Their responses now carry the
staged workflow result plus
`deprecation: { deprecated: true, replacement: "world_ingest", removal: "after_one_release" }`.
Clients should read `ok`/`stages` rather than depend on the former import reply.

| Legacy input | Generalized request |
|---|---|
| `heightmapPath` | `source: { kind: "heightmap", path: ... }` |
| Implicit current level | `destination: { mode: "open_world" }`, `partition: { mode: "preserve" }` |
| `worldSizeKm`, `maxHeightM`, `actorLabel` | Same names under `terrain`; defaults remain `8`, `600`, `Hayba_Terrain` |
| `landscapeMaterial` | `terrain.material`; an empty legacy material is treated as omitted |

The executable contract suite is
`mcp-tools/hayba-mcp/src/tools/world/world-ingest.contract.test.ts`. It exercises
published descriptors and a scripted UE executor, including refusals, partial
failure and programmatic cancellation. These tests do not establish live editor
compilation, routing or persistence acceptance.

## UE-side handler domains

The agent-facing commands are executed by the UE plugin's command handlers.
There is one `*Handler.cpp` per domain in
`unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/` — **33
concrete handler files**:

`Actor` · `Animation` · `Asset` · `Audio` · `BehaviorTree` · `Blueprint` ·
`Build` · `DataAsset` · `Docs` · `Editor` · `Foliage` · `ISM` · `Idle` ·
`Input` · `Legacy` · `Level` · `Material` · `Network` · `PIE` · `Perf` ·
`Physics` · `Project` · `Python` · `Render` · `SceneGraph` · `Spline` ·
`StaticMesh` · `Test` · `Texture` · `UI` · `UILayout` · `Vault` ·
`WorldPartition`

Each implements `GetCommands()` / `Handle()`, dispatched by `HaybaMCPModule`.

### Satellite plugins (not in the list above)

`GAS` and `MetaSound` handlers live in their own UE modules —
`unreal/HaybaMCPGAS` and `unreal/HaybaMCPMetaSound` — installed into a host
project only when wanted, not part of the always-loaded `HaybaMCPToolkit`
count above. `Niagara` and `Sequencer` handler modules **used to exist** the
same way and were deleted: their commands duplicated `niagara_*` / `seq_*`
tools the TS/python layer already shipped under different names. See
[ADR-0008](../adr/0008-satellite-plugins-earn-their-place.md).

> The Node-side `list_tool_categories` groups commands into agent-facing
> categories (e.g. `actor`, `pcg`, `seq`) that map onto these handlers plus
> Node-only meta tools. Treat the running server's
> `list_tool_categories` output as authoritative for command names.

See also: [UE-Plugin](UE-Plugin.md), [Architecture](Architecture.md),
[`../../mcp-tools/hayba-mcp/README.md`](../../mcp-tools/hayba-mcp/README.md).
