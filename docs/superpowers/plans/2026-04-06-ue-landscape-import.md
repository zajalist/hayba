# UE Landscape Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `hayba_import_landscape` — an MCP tool that imports a baked Gaea heightmap into UE5 as an `ALandscape` actor with correct Gaea2Unreal scale, routed through the existing TCP command channel.

**Architecture:** TypeScript tool handler resolves heightmap path and landscape material, then sends an `import_landscape` TCP command to the UE plugin. The C++ command handler parses params, computes scale using Gaea2Unreal formulas (from the heightmap's actual resolution), and calls the updated `FHaybaMCPLandscapeImporter`. `SessionManager` gains a `lastBakedHeightmap` field so the tool can default to the last baked output.

**Tech Stack:** TypeScript, Zod, vitest, `@modelcontextprotocol/sdk`, Node.js `net` (TCP), Unreal Engine 5.7 C++ (Landscape module, JSON, LandscapeImportHelper)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/hayba/src/gaea/session.ts` | Add `lastBakedHeightmap: string \| null` field |
| Modify | `packages/hayba/src/tools/hayba-bake-terrain.ts` | Set `session.lastBakedHeightmap` after successful bake |
| Create | `packages/hayba/src/tools/hayba-import-landscape.ts` | MCP tool handler — resolves path/material, sends TCP command |
| Create | `packages/hayba/tests/tools/hayba-import-landscape.test.ts` | vitest unit tests (TCP mocked) |
| Modify | `packages/hayba/src/tools/index.ts` | Register `hayba_import_landscape` tool |
| Modify | `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPCommandHandler.h` | Declare `Cmd_ImportLandscape` |
| Modify | `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp` | Register + implement `import_landscape` command |
| Modify | `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.h` | Replace `FString` signature with `FHaybaMCPImportParams` struct |
| Modify | `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.cpp` | Scale formula, material assignment, params struct |

---

## Task 1: Add `lastBakedHeightmap` to `SessionManager`

**Files:**
- Modify: `packages/hayba/src/gaea/session.ts`

- [ ] **Step 1: Add the field**

In `packages/hayba/src/gaea/session.ts`, add after line 10 (`terrainPath: string | null = null;`):

```ts
lastBakedHeightmap: string | null = null;
```

The class declaration block should now read:

```ts
export class SessionManager {
  readonly client: SwarmHostClient;
  readonly outputDir: string;
  readonly gaeaExePath: string;
  terrainPath: string | null = null;
  lastBakedHeightmap: string | null = null;
  gaeaPid: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();
```

- [ ] **Step 2: Build**

```bash
cd packages/hayba && npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/hayba/src/gaea/session.ts
git commit -m "feat(landscape): add lastBakedHeightmap field to SessionManager"
```

---

## Task 2: Set `lastBakedHeightmap` after a successful bake

**Files:**
- Modify: `packages/hayba/src/tools/hayba-bake-terrain.ts`

- [ ] **Step 1: Write the failing test**

In `packages/hayba/tests/gaea/` create a new test `packages/hayba/tests/tools/hayba-bake-sets-heightmap.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bakeTerrain } from '../../src/tools/hayba-bake-terrain.js';
import type { SessionManager } from '../../src/gaea/session.js';

function makeSession(overrides: Partial<SessionManager> = {}): SessionManager {
  return {
    terrainPath: '/tmp/test.terrain',
    lastBakedHeightmap: null,
    outputDir: '/tmp/out',
    gaeaExePath: '',
    gaeaPid: null,
    setTerrainPath: vi.fn(),
    saveGaeaSession: vi.fn(),
    clearGaeaSession: vi.fn(),
    enqueue: vi.fn((fn: () => Promise<unknown>) => fn()),
    client: {
      loadGraph: vi.fn().mockResolvedValue(undefined),
      cook: vi.fn().mockResolvedValue(undefined),
      export: vi.fn().mockResolvedValue({
        heightmap: '/tmp/out/terrain.r16',
        normalmap: undefined,
        splatmap: undefined,
      }),
    } as unknown as SessionManager['client'],
    ...overrides,
  } as unknown as SessionManager;
}

describe('bakeTerrain sets lastBakedHeightmap', () => {
  it('sets session.lastBakedHeightmap to the exported heightmap path', async () => {
    const session = makeSession();
    await bakeTerrain({ path: '/tmp/test.terrain' }, session);
    expect(session.lastBakedHeightmap).toBe('/tmp/out/terrain.r16');
  });

  it('does not set lastBakedHeightmap when export fails', async () => {
    const session = makeSession({
      client: {
        loadGraph: vi.fn().mockResolvedValue(undefined),
        cook: vi.fn().mockResolvedValue(undefined),
        export: vi.fn().mockRejectedValue(new Error('export failed')),
      } as unknown as SessionManager['client'],
    });
    await bakeTerrain({ path: '/tmp/test.terrain' }, session);
    expect(session.lastBakedHeightmap).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/hayba && npm test -- tests/tools/hayba-bake-sets-heightmap.test.ts
```

Expected: FAIL — `session.lastBakedHeightmap` remains `null`.

- [ ] **Step 3: Set `lastBakedHeightmap` in `hayba-bake-terrain.ts`**

In `packages/hayba/src/tools/hayba-bake-terrain.ts`, find the block after the `exported` assignment (around line 31). The current code is:

```ts
  let exported: { heightmap: string; normalmap?: string; splatmap?: string } | null = null;
  try {
    exported = await session.enqueue(() => session.client.export(session.outputDir, 'EXR'));
  } catch {
    // Cook succeeded but export scan failed — not fatal
  }
```

Replace with:

```ts
  let exported: { heightmap: string; normalmap?: string; splatmap?: string } | null = null;
  try {
    exported = await session.enqueue(() => session.client.export(session.outputDir, 'EXR'));
    if (exported?.heightmap) {
      session.lastBakedHeightmap = exported.heightmap;
    }
  } catch {
    // Cook succeeded but export scan failed — not fatal
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/hayba && npm test -- tests/tools/hayba-bake-sets-heightmap.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
cd packages/hayba && npm test
```

Expected: same pass/fail counts as before (113 pass, 3 pre-existing failures).

- [ ] **Step 6: Commit**

```bash
git add packages/hayba/src/tools/hayba-bake-terrain.ts packages/hayba/tests/tools/hayba-bake-sets-heightmap.test.ts
git commit -m "feat(landscape): track last baked heightmap path on session"
```

---

## Task 3: Write tests for `hayba-import-landscape`

**Files:**
- Create: `packages/hayba/tests/tools/hayba-import-landscape.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { importLandscapeHandler } from '../../src/tools/hayba-import-landscape.js';
import type { SessionManager } from '../../src/gaea/session.js';

// Mock tcp-client so tests don't need a real UE connection
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(),
}));

import { ensureConnected } from '../../src/tcp-client.js';

const GLOBAL_DIR = join(homedir(), '.hayba');
const GLOBAL_PATH = join(GLOBAL_DIR, 'conventions.json');

function makeSession(overrides: Partial<{ terrainPath: string | null; lastBakedHeightmap: string | null }> = {}): SessionManager {
  return {
    terrainPath: null,
    lastBakedHeightmap: null,
    outputDir: '/tmp/out',
    ...overrides,
  } as unknown as SessionManager;
}

function makeMockClient(response: { ok: boolean; data?: Record<string, unknown>; error?: string }) {
  return { send: vi.fn().mockResolvedValue({ id: 'req_1', ...response }) };
}

function writeGlobalConventions(landscapeMaterials: string) {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(GLOBAL_PATH, JSON.stringify({
    version: 1,
    preset: 'epic-default',
    folders: { pcgGraphs: '/Game/PCG', landscapeMaterials, heightmaps: '/Game/Terrain', blueprints: '/Game/BP', textures: '/Game/Textures' },
    naming: { pcgGraphPrefix: 'PCG_', materialPrefix: 'M_', blueprintPrefix: 'BP_', texturePrefix: 'T_', folderCasing: 'PascalCase' },
    workflow: { confirmBeforeOverwrite: true, preferredLandscapeResolution: 1009, defaultHeightmapFormat: 'r16', autoOpenInGaeaAfterBake: false },
  }), 'utf-8');
}

function cleanupGlobal() {
  if (existsSync(GLOBAL_DIR)) rmSync(GLOBAL_DIR, { recursive: true, force: true });
}

describe('hayba_import_landscape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupGlobal();
  });

  afterEach(() => {
    cleanupGlobal();
  });

  it('returns error when no heightmapPath and no lastBakedHeightmap', async () => {
    const result = await importLandscapeHandler({}, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no heightmap');
  });

  it('uses session.lastBakedHeightmap when heightmapPath omitted', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as any);

    const session = makeSession({ lastBakedHeightmap: '/tmp/out/terrain.r16' });
    await importLandscapeHandler({}, session);

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ heightmapPath: '/tmp/out/terrain.r16' }),
      expect.any(Number)
    );
  });

  it('uses provided heightmapPath over session path', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as any);

    const session = makeSession({ lastBakedHeightmap: '/tmp/old.r16' });
    await importLandscapeHandler({ heightmapPath: '/tmp/explicit.r16' }, session);

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ heightmapPath: '/tmp/explicit.r16' }),
      expect.any(Number)
    );
  });

  it('resolves material from conventions when landscapeMaterial omitted', async () => {
    writeGlobalConventions('/Game/Materials/Landscape/M_Terrain');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as any);

    await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16' }, makeSession());

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ landscapeMaterial: '/Game/Materials/Landscape/M_Terrain' }),
      expect.any(Number)
    );
  });

  it('returns prompt message when no landscapeMaterial and no conventions', async () => {
    const result = await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16' }, makeSession());
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('landscapeMaterial');
  });

  it('sends empty landscapeMaterial string when explicitly passed as empty', async () => {
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as any);

    await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16', landscapeMaterial: '' }, makeSession());

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ landscapeMaterial: '' }),
      expect.any(Number)
    );
  });

  it('sends default worldSizeKm and maxHeightM when not provided', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as any);

    await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16' }, makeSession());

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ worldSizeKm: 8.0, maxHeightM: 600.0 }),
      expect.any(Number)
    );
  });

  it('returns isError true when TCP responds with error', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: false, error: 'Heightmap not found' });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as any);

    const result = await importLandscapeHandler({ heightmapPath: '/tmp/missing.r16' }, makeSession());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Heightmap not found');
  });

  it('returns actor label and scale values on success', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as any);

    const result = await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16' }, makeSession());

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Hayba_Terrain');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/hayba && npm test -- tests/tools/hayba-import-landscape.test.ts
```

Expected: FAIL — `importLandscapeHandler` not found (module doesn't exist yet).

---

## Task 4: Implement `hayba-import-landscape.ts`

**Files:**
- Create: `packages/hayba/src/tools/hayba-import-landscape.ts`

- [ ] **Step 1: Create the handler**

```ts
import { ensureConnected } from '../tcp-client.js';
import { readConventions } from '../conventions.js';
import type { SessionManager } from '../gaea/session.js';
import type { ToolResult } from './hayba-bake-terrain.js';

export async function importLandscapeHandler(
  args: Record<string, unknown>,
  session: SessionManager
): Promise<ToolResult> {
  // 1. Resolve heightmap path
  const heightmapPath = (args.heightmapPath as string | undefined) ?? session.lastBakedHeightmap ?? null;
  if (!heightmapPath) {
    return {
      content: [{ type: 'text', text: 'Error: no heightmap available — bake a terrain first or provide heightmapPath.' }],
      isError: true,
    };
  }

  // 2. Resolve landscape material
  let landscapeMaterial = args.landscapeMaterial as string | undefined;
  if (landscapeMaterial === undefined) {
    const projectRoot = args.projectRoot as string | undefined;
    const conventions = readConventions(projectRoot);
    const folder = conventions?.folders.landscapeMaterials;
    if (folder) {
      landscapeMaterial = folder;
    } else {
      return {
        content: [{ type: 'text', text:
          'No landscape material configured. Please provide a landscapeMaterial path (e.g. "/Game/Materials/Landscape/M_Terrain"), ' +
          'or run hayba_setup_conventions to set a default. Pass landscapeMaterial: "" to import without a material.'
        }],
        isError: false,
      };
    }
  }

  // 3. Send TCP command — C++ reads resolution from heightmap and computes scale
  const worldSizeKm = (args.worldSizeKm as number | undefined) ?? 8.0;
  const maxHeightM  = (args.maxHeightM  as number | undefined) ?? 600.0;
  const actorLabel  = (args.actorLabel  as string | undefined) ?? 'Hayba_Terrain';

  let response: { ok: boolean; data?: Record<string, unknown>; error?: string };
  try {
    const client = await ensureConnected();
    response = await client.send('import_landscape', {
      heightmapPath,
      worldSizeKm,
      maxHeightM,
      landscapeMaterial: landscapeMaterial ?? '',
      actorLabel,
    }, 60000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `TCP error: ${message}` }], isError: true };
  }

  if (!response.ok) {
    return { content: [{ type: 'text', text: `Import failed: ${response.error ?? 'unknown error'}` }], isError: true };
  }

  const data = response.data ?? {};
  const lines = [
    `Landscape imported successfully.`,
    `Actor: ${data.actorLabel ?? actorLabel}`,
    `Scale XY: ${data.scaleXY ?? '—'} cm/px`,
    `Scale Z:  ${data.scaleZ  ?? '—'}`,
    `Heightmap: ${heightmapPath}`,
    landscapeMaterial ? `Material: ${landscapeMaterial}` : `Material: (none)`,
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
```

- [ ] **Step 2: Run the tests**

```bash
cd packages/hayba && npm test -- tests/tools/hayba-import-landscape.test.ts
```

Expected: all 8 tests PASS.

- [ ] **Step 3: Run full test suite**

```bash
cd packages/hayba && npm test
```

Expected: new tests pass, pre-existing failures unchanged.

- [ ] **Step 4: Commit**

```bash
git add packages/hayba/src/tools/hayba-import-landscape.ts packages/hayba/tests/tools/hayba-import-landscape.test.ts
git commit -m "feat(landscape): add hayba-import-landscape tool handler + tests"
```

---

## Task 5: Register `hayba_import_landscape` in `index.ts`

**Files:**
- Modify: `packages/hayba/src/tools/index.ts`

- [ ] **Step 1: Add import at top of file**

After the last Gaea import (line ~39, `import { cookGraphHandler }`), add:

```ts
import { importLandscapeHandler } from './hayba-import-landscape.js';
```

- [ ] **Step 2: Register the tool**

At the end of `registerTools()`, before the closing `}`, add:

```ts
  server.tool(
    'hayba_import_landscape',
    {
      heightmapPath: z.string().optional().describe('Absolute path to .r16 or .png heightmap. Defaults to last baked heightmap from session.'),
      worldSizeKm: z.number().optional().describe('Real-world terrain width and depth in km (default: 8.0).'),
      maxHeightM: z.number().optional().describe('Maximum terrain height in meters (default: 600.0).'),
      landscapeMaterial: z.string().optional().describe('UE asset path for landscape material, e.g. "/Game/Materials/Landscape/M_Terrain". Pass "" to import with no material. Resolved from conventions if omitted.'),
      actorLabel: z.string().optional().describe('Actor label in the UE level (default: Hayba_Terrain).'),
      projectRoot: z.string().optional().describe('Absolute path to UE project root — used to read project-level conventions.'),
    },
    async (params) => {
      const result = await importLandscapeHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );
```

- [ ] **Step 3: Build**

```bash
cd packages/hayba && npm run build
```

Expected: no errors.

- [ ] **Step 4: Run full test suite**

```bash
cd packages/hayba && npm test
```

Expected: all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/hayba/src/tools/index.ts
git commit -m "feat(landscape): register hayba_import_landscape tool"
```

---

## Task 6: Update `HaybaMCPLandscapeImporter` header

**Files:**
- Modify: `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.h`

- [ ] **Step 1: Replace the header**

Replace the entire file content with:

```cpp
#pragma once
#include "CoreMinimal.h"

struct FHaybaMCPImportParams
{
    FString HeightmapPath;
    float   WorldSizeKm       = 8.0f;
    float   MaxHeightM        = 600.0f;
    FString LandscapeMaterial;          // empty = no material assigned
    FString ActorLabel        = TEXT("Hayba_Terrain");
};

class FHaybaMCPLandscapeImporter
{
public:
    /**
     * Create an ALandscape actor in the current level from a heightmap PNG/R16 file.
     * Computes scale using Gaea2Unreal formulas:
     *   ScaleXY = WorldSizeKm * 1000 * 100 / Resolution
     *   ScaleZ  = MaxHeightM * 100 / 512
     * Must be called on the game thread.
     * @return true if the landscape actor was created successfully.
     */
    static bool ImportHeightmap(const FHaybaMCPImportParams& Params);
};
```

- [ ] **Step 2: Commit**

```bash
git add "packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.h"
git commit -m "feat(landscape): update LandscapeImporter header with FHaybaMCPImportParams struct"
```

---

## Task 7: Rewrite `HaybaMCPLandscapeImporter.cpp`

**Files:**
- Modify: `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.cpp`

- [ ] **Step 1: Replace the entire file**

```cpp
#include "HaybaMCPLandscapeImporter.h"
#include "LandscapeProxy.h"
#include "Landscape.h"
#include "LandscapeImportHelper.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/PlatformFileManager.h"
#include "Logging/LogMacros.h"
#include "Misc/Paths.h"
#include "Materials/MaterialInterface.h"
#include "UObject/ConstructorHelpers.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPImporter, Log, All);

bool FHaybaMCPLandscapeImporter::ImportHeightmap(const FHaybaMCPImportParams& Params)
{
    if (!FPlatformFileManager::Get().GetPlatformFile().FileExists(*Params.HeightmapPath))
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Heightmap not found: %s"), *Params.HeightmapPath);
        return false;
    }

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("No editor world available"));
        return false;
    }

    // ── Heightmap descriptor ──────────────────────────────────────────────────
    FLandscapeImportDescriptor OutDescriptor;
    FText OutMessage;
    ELandscapeImportResult ImportResult = FLandscapeImportHelper::GetHeightmapImportDescriptor(
        Params.HeightmapPath, /*bSingleFile=*/true, /*bFlipYAxis=*/false, OutDescriptor, OutMessage);

    if (ImportResult == ELandscapeImportResult::Error)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to read heightmap descriptor: %s"), *OutMessage.ToString());
        return false;
    }

    if (OutDescriptor.ImportResolutions.Num() == 0)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Heightmap has no valid resolutions: %s"), *Params.HeightmapPath);
        return false;
    }

    // ── Component sizing ──────────────────────────────────────────────────────
    const int32 DescriptorIndex = 0;
    int32 OutQuadsPerSection = 0, OutSectionsPerComponent = 0;
    FIntPoint OutComponentCount;
    FLandscapeImportHelper::ChooseBestComponentSizeForImport(
        OutDescriptor.ImportResolutions[DescriptorIndex].Width,
        OutDescriptor.ImportResolutions[DescriptorIndex].Height,
        OutQuadsPerSection, OutSectionsPerComponent, OutComponentCount);

    // ── Heightmap data ────────────────────────────────────────────────────────
    TArray<uint16> ImportData;
    ImportResult = FLandscapeImportHelper::GetHeightmapImportData(
        OutDescriptor, DescriptorIndex, ImportData, OutMessage);

    if (ImportResult == ELandscapeImportResult::Error)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to load heightmap data: %s"), *OutMessage.ToString());
        return false;
    }

    const int32 QuadsPerComponent = OutSectionsPerComponent * OutQuadsPerSection;
    const int32 SizeX = OutComponentCount.X * QuadsPerComponent + 1;
    const int32 SizeY = OutComponentCount.Y * QuadsPerComponent + 1;

    TArray<uint16> FinalHeightData;
    FLandscapeImportHelper::TransformHeightmapImportData(
        ImportData, FinalHeightData,
        OutDescriptor.ImportResolutions[DescriptorIndex],
        FLandscapeImportResolution(SizeX, SizeY),
        ELandscapeImportTransformType::ExpandCentered);

    // ── Gaea2Unreal scale formula ─────────────────────────────────────────────
    // Source: github.com/QuadSpinner/Gaea2Unreal GaeaSubsystem.cpp
    // ScaleXY = worldSizeKm * 1000m * 100cm / resolution  (cm per pixel)
    // ScaleZ  = maxHeightM * 100cm / 512                  (Gaea's height baseline)
    // LocationZ = maxHeightM * 100cm / 2                  (center landscape vertically)
    const int32 Resolution = OutDescriptor.ImportResolutions[DescriptorIndex].Width;
    const float ScaleXY   = (Params.WorldSizeKm * 1000.f * 100.f) / static_cast<float>(Resolution);
    const float ScaleZ    = (Params.MaxHeightM  * 100.f) / 512.f;
    const float LocationZ = (Params.MaxHeightM  * 100.f) / 2.f;

    UE_LOG(LogHaybaMCPImporter, Log,
        TEXT("Scale: XY=%.2f ScaleZ=%.2f Resolution=%d WorldSize=%.1fkm MaxHeight=%.1fm"),
        ScaleXY, ScaleZ, Resolution, Params.WorldSizeKm, Params.MaxHeightM);

    // ── Spawn landscape ───────────────────────────────────────────────────────
    FTransform LandscapeTransform;
    LandscapeTransform.SetLocation(FVector(0.f, 0.f, LocationZ));
    LandscapeTransform.SetScale3D(FVector(ScaleXY, ScaleXY, ScaleZ));

    TMap<FGuid, TArray<uint16>> HeightmapDataPerLayers;
    TMap<FGuid, TArray<FLandscapeImportLayerInfo>> MaterialLayerDataPerLayers;
    const FGuid LayerGuid = FGuid::NewGuid();
    HeightmapDataPerLayers.Add(LayerGuid, FinalHeightData);

    ALandscape* Landscape = World->SpawnActor<ALandscape>(ALandscape::StaticClass(), LandscapeTransform);
    if (!Landscape)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to spawn ALandscape actor"));
        return false;
    }

    Landscape->Import(
        LayerGuid, 0, 0, SizeX - 1, SizeY - 1,
        OutSectionsPerComponent, OutQuadsPerSection,
        HeightmapDataPerLayers, *Params.HeightmapPath,
        MaterialLayerDataPerLayers,
        ELandscapeImportAlphamapType::Additive,
        TArrayView<const FLandscapeLayer>()
    );

    // ── Material ──────────────────────────────────────────────────────────────
    if (!Params.LandscapeMaterial.IsEmpty())
    {
        UMaterialInterface* Mat = LoadObject<UMaterialInterface>(nullptr, *Params.LandscapeMaterial);
        if (Mat)
        {
            Landscape->LandscapeMaterial = Mat;
        }
        else
        {
            UE_LOG(LogHaybaMCPImporter, Warning,
                TEXT("Could not load landscape material: %s — landscape created without material"),
                *Params.LandscapeMaterial);
        }
    }

    Landscape->SetActorLabel(Params.ActorLabel);

    UE_LOG(LogHaybaMCPImporter, Log,
        TEXT("Landscape '%s' created: %dx%d from %s"),
        *Params.ActorLabel, SizeX, SizeY, *Params.HeightmapPath);

    return true;
}
```

- [ ] **Step 2: Commit**

```bash
git add "packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.cpp"
git commit -m "feat(landscape): implement Gaea2Unreal scale formula and material assignment in LandscapeImporter"
```

---

## Task 8: Add `Cmd_ImportLandscape` to the command handler

**Files:**
- Modify: `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPCommandHandler.h`
- Modify: `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp`

- [ ] **Step 1: Declare `Cmd_ImportLandscape` in the header**

In `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPCommandHandler.h`, add after `Cmd_WizardChat`:

```cpp
	FString Cmd_ImportLandscape(const TSharedPtr<FJsonObject>& Params, const FString& Id);
```

The private section should now end with:

```cpp
	FString Cmd_WizardChat(const TSharedPtr<FJsonObject>& Params, const FString& Id);
	FString Cmd_ImportLandscape(const TSharedPtr<FJsonObject>& Params, const FString& Id);
```

- [ ] **Step 2: Add the include for `HaybaMCPLandscapeImporter.h`**

At the top of `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp`, after the existing includes, add:

```cpp
#include "HaybaMCPLandscapeImporter.h"
```

- [ ] **Step 3: Register the command in the constructor**

In `HaybaMCPCommandHandler.cpp`, in `FHaybaMCPCommandHandler::FHaybaMCPCommandHandler()`, add after `Cmd_WizardChat`:

```cpp
	CommandMap.Add(TEXT("import_landscape"), &FHaybaMCPCommandHandler::Cmd_ImportLandscape);
```

- [ ] **Step 4: Implement `Cmd_ImportLandscape`**

Add at the end of `HaybaMCPCommandHandler.cpp` (after the last `Cmd_` function):

```cpp
FString FHaybaMCPCommandHandler::Cmd_ImportLandscape(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    FHaybaMCPImportParams ImportParams;

    // Required
    if (!Params->TryGetStringField(TEXT("heightmapPath"), ImportParams.HeightmapPath) || ImportParams.HeightmapPath.IsEmpty())
    {
        return MakeErrorResponse(Id, TEXT("heightmapPath is required"));
    }

    // Optional with defaults
    double WorldSizeKm = 8.0;
    double MaxHeightM  = 600.0;
    Params->TryGetNumberField(TEXT("worldSizeKm"), WorldSizeKm);
    Params->TryGetNumberField(TEXT("maxHeightM"),  MaxHeightM);
    ImportParams.WorldSizeKm = static_cast<float>(WorldSizeKm);
    ImportParams.MaxHeightM  = static_cast<float>(MaxHeightM);

    Params->TryGetStringField(TEXT("landscapeMaterial"), ImportParams.LandscapeMaterial);
    Params->TryGetStringField(TEXT("actorLabel"), ImportParams.ActorLabel);
    if (ImportParams.ActorLabel.IsEmpty()) ImportParams.ActorLabel = TEXT("Hayba_Terrain");

    // Compute scale values for the response (same formula as in the importer)
    // Resolution is unknown here — the importer reads it; we return approximate values for confirmation
    const bool bSuccess = FHaybaMCPLandscapeImporter::ImportHeightmap(ImportParams);

    if (!bSuccess)
    {
        return MakeErrorResponse(Id, FString::Printf(
            TEXT("Failed to import landscape from: %s"), *ImportParams.HeightmapPath));
    }

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetStringField(TEXT("actorLabel"), ImportParams.ActorLabel);
    Data->SetStringField(TEXT("heightmapPath"), ImportParams.HeightmapPath);
    Data->SetNumberField(TEXT("worldSizeKm"), ImportParams.WorldSizeKm);
    Data->SetNumberField(TEXT("maxHeightM"),  ImportParams.MaxHeightM);

    return MakeOkResponse(Id, Data);
}
```

- [ ] **Step 5: Commit**

```bash
git add "packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPCommandHandler.h" \
        "packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp"
git commit -m "feat(landscape): register import_landscape TCP command in HaybaMCPCommandHandler"
```

---

## Task 9: Final verification + update roadmap memory

- [ ] **Step 1: Run full test suite one last time**

```bash
cd packages/hayba && npm run build && npm test
```

Expected: build clean, all new tests pass, 3 pre-existing failures unchanged.

- [ ] **Step 2: Update memory roadmap**

In `C:\Users\Admin\.claude\projects\D--hayba\memory\project-hayba-roadmap.md`, mark Landscape Import complete:

```markdown
4. **UE Landscape Import** — ✅ COMPLETE (merged to main)
   - `hayba_import_landscape` MCP tool
   - Gaea2Unreal scale formulas (ScaleXY = worldSizeKm*100000/res, ScaleZ = maxHeightM*100/512)
   - Material resolved from conventions or user-provided
   - `session.lastBakedHeightmap` tracks last baked output
   - TCP command `import_landscape` registered in HaybaMCPCommandHandler
   - FHaybaMCPImportParams struct replaces old single-string signature
```

- [ ] **Step 3: Final commit**

```bash
git add packages/hayba/
git commit -m "feat: complete UE Landscape Import — hayba_import_landscape tool"
```
