# UE Landscape Import — Design

**Date:** 2026-04-06  
**Status:** Approved  
**Scope:** Spec 3 of 4 (Unification → Conventions System → Landscape Import → Joint Workflow)

---

## Problem

After baking a Gaea terrain, the user has a heightmap on disk but no way to get it into Unreal Engine through the MCP toolkit. They must manually import via the UE landscape editor, set scale values, and assign a material — an error-prone multi-step process that breaks the single-prompt workflow.

---

## Goal

A single `hayba_import_landscape` MCP tool that takes a heightmap path (defaulting to the last baked terrain), computes correct UE landscape scale from real-world dimensions using the Gaea2Unreal formulas, assigns a landscape material from conventions or user input, and spawns the landscape actor via the existing TCP command channel.

---

## Tool: `hayba_import_landscape`

**File:** `packages/hayba/src/tools/hayba-import-landscape.ts`

### Parameters

```ts
{
  heightmapPath?: string;      // absolute path to .r16 or .png heightmap
                               // defaults to last baked heightmap from session
  worldSizeKm?: number;        // real-world X and Y extent in km (default: 8.0)
  maxHeightM?: number;         // max terrain height in meters (default: 600.0)
  landscapeMaterial?: string;  // UE asset path e.g. "/Game/Materials/Landscape/M_Terrain"
                               // resolved from conventions if omitted; "" = no material
  actorLabel?: string;         // default: "Hayba_Terrain"
  projectRoot?: string;        // UE project root — used to read project conventions
}
```

### Material Resolution

When `landscapeMaterial` is not provided:

1. Call `readConventions(projectRoot?)` from `src/conventions.ts`
2. If `conventions.folders.landscapeMaterials` is set → use it as the material path
3. If no conventions → return a non-error message prompting Claude to ask the user for a material path before proceeding

Explicit `landscapeMaterial: ""` skips material assignment entirely with no prompt.

### Handler Flow

```ts
// 1. Resolve heightmap path
const heightmapPath = args.heightmapPath ?? session.lastBakedHeightmap;
if (!heightmapPath) return error("no heightmap available — bake a terrain first or provide heightmapPath");

// 2. Resolve material
let material = args.landscapeMaterial;
if (material === undefined) {
  const conventions = readConventions(args.projectRoot);
  material = conventions?.folders.landscapeMaterials ?? undefined;
  if (!material) return prompt("no landscape material set — provide landscapeMaterial or run hayba_setup_conventions");
}

// 3. Send TCP command — C++ computes scale
const response = await tcpClient.send({
  cmd: "import_landscape",
  heightmapPath,
  worldSizeKm: args.worldSizeKm ?? 8.0,
  maxHeightM: args.maxHeightM ?? 600.0,
  landscapeMaterial: material ?? "",
  actorLabel: args.actorLabel ?? "Hayba_Terrain",
});

// 4. Return result
```

---

## Scale Computation (Gaea2Unreal Formulas)

Scale is computed in C++ after reading the heightmap descriptor (which gives the actual resolution). Source: [Gaea2Unreal](https://github.com/QuadSpinner/Gaea2Unreal) `GaeaSubsystem.cpp`.

```cpp
const int32 Resolution = OutDescriptor.ImportResolutions[0].Width;
const float ScaleXY = (Params.WorldSizeKm * 1000.f * 100.f) / Resolution;
const float ScaleZ  = (Params.MaxHeightM * 100.f) / 512.f;
const float LocationZ = (Params.MaxHeightM * 100.f) / 2.f;

LandscapeTransform.SetLocation(FVector(0.f, 0.f, LocationZ));
LandscapeTransform.SetScale3D(FVector(ScaleXY, ScaleXY, ScaleZ));
```

**Why this formula:**
- `ScaleXY`: UE landscape scale is cm/pixel. `worldSizeKm * 1000 * 100 = world size in cm`, divided by resolution = cm per pixel.
- `ScaleZ`: Gaea normalises height to a 0–1 range mapped to a 512-unit internal baseline. `maxHeightM * 100 / 512` gives the correct UE Z scale in cm.
- `LocationZ`: Centers the landscape vertically so the midpoint of the height range sits at Z=0.

---

## C++ Changes

### `HaybaMCPCommandHandler`

Register the new command:

```cpp
CommandMap.Add(TEXT("import_landscape"), &FHaybaMCPCommandHandler::Cmd_ImportLandscape);
```

`Cmd_ImportLandscape` parses the JSON payload and calls `FHaybaMCPLandscapeImporter::ImportHeightmap(Params)`.

Response on success:
```json
{ "ok": true, "actorLabel": "Hayba_Terrain", "scaleXY": 97.7, "scaleZ": 117.2 }
```

Response on error:
```json
{ "error": "Heightmap not found: ..." }
```

### `FHaybaMCPLandscapeImporter`

Replace the current single-argument `ImportHeightmap(FString)` with a params struct:

```cpp
struct FHaybaMCPImportParams {
    FString HeightmapPath;
    float   WorldSizeKm       = 8.0f;
    float   MaxHeightM        = 600.0f;
    FString LandscapeMaterial;          // empty = no material
    FString ActorLabel        = TEXT("Hayba_Terrain");
};

bool ImportHeightmap(const FHaybaMCPImportParams& Params);
```

Material assignment after `Landscape->Import(...)`:

```cpp
if (!Params.LandscapeMaterial.IsEmpty()) {
    UMaterialInterface* Mat = LoadObject<UMaterialInterface>(
        nullptr, *Params.LandscapeMaterial);
    if (Mat) Landscape->LandscapeMaterial = Mat;
}

Landscape->SetActorLabel(Params.ActorLabel);
```

### `HaybaMCPLandscapeImporter.h`

Update header to declare `FHaybaMCPImportParams` and the new `ImportHeightmap` signature.

---

## Tool Registration

In `src/tools/index.ts` `registerTools()`:

```ts
server.tool(
  'hayba_import_landscape',
  {
    heightmapPath: z.string().optional().describe('Absolute path to .r16 or .png heightmap (uses last baked if omitted)'),
    worldSizeKm: z.number().optional().describe('Real-world terrain width/depth in km (default: 8.0)'),
    maxHeightM: z.number().optional().describe('Maximum terrain height in meters (default: 600.0)'),
    landscapeMaterial: z.string().optional().describe('UE asset path for landscape material. Empty string = no material. Resolved from conventions if omitted.'),
    actorLabel: z.string().optional().describe('Actor label in the UE level (default: Hayba_Terrain)'),
    projectRoot: z.string().optional().describe('UE project root path for reading project-level conventions'),
  },
  async (params) => {
    const result = await importLandscapeHandler(params as Record<string, unknown>, session);
    return { content: result.content, isError: result.isError };
  }
);
```

---

## Session Change

`SessionManager` needs to track the last baked heightmap path so `hayba_import_landscape` can default to it. Add to `session.ts`:

```ts
lastBakedHeightmap: string | null = null;
```

Set in `hayba-bake-terrain.ts` after a successful bake when `exported.heightmap` is present:

```ts
session.lastBakedHeightmap = exported.heightmap;
```

---

## Data Flow

```
Claude
  └── hayba_import_landscape(heightmapPath?, worldSizeKm, maxHeightM, landscapeMaterial?)
        ├── readConventions() → resolve material if needed
        ├── tcp-client.send({ cmd: "import_landscape", ... })
        │     └── HaybaMCPCommandHandler::Cmd_ImportLandscape
        │           ├── FHaybaMCPLandscapeImporter::ImportHeightmap(Params)
        │           │     ├── GetHeightmapImportDescriptor → resolution
        │           │     ├── compute ScaleXY, ScaleZ, LocationZ
        │           │     ├── Landscape->Import(...)
        │           │     └── Landscape->LandscapeMaterial = Mat
        │           └── return { ok, actorLabel, scaleXY, scaleZ }
        └── return result to Claude
```

---

## Testing

**`tests/tools/hayba-import-landscape.test.ts`** (vitest, TCP mocked):

- Missing `heightmapPath` + no `session.lastBakedHeightmap` → returns error
- Missing `heightmapPath` + `session.lastBakedHeightmap` set → sends that path
- No `landscapeMaterial` + conventions has `folders.landscapeMaterials` → sends conventions path
- No `landscapeMaterial` + no conventions → returns prompt message, `isError: false`
- Explicit `landscapeMaterial: ""` → sends empty string to UE, no prompt
- TCP success response → tool returns actor label and scale values
- TCP error response → tool returns `isError: true` with error message
- Default `worldSizeKm: 8.0` and `maxHeightM: 600.0` used when not provided

---

## Out of Scope

- Weightmap / splatmap import (future — Gaea2Unreal supports this, we do not yet)
- Tiled landscape import
- Re-import / update existing landscape actor
- Landscape layer setup beyond material assignment
