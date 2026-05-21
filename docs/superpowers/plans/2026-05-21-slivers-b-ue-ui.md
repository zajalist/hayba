# Slivers v1 Plan B — UE Plugin Slivers Tab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user-facing UE plugin Slivers tab — a Slate dockable panel that lists installed slivers, renders sliders/inputs from each spec, lets the user run the sliver, and shows the result. After this plan, a user can pick `Window → Slivers`, select `Frame Target`, scrub the `distance` and `yaw_deg` sliders, hit Run, and see the camera_transform JSON come back.

**Architecture:** UE plugin opens a Slate `SSliversPanel` from a dock tab. The panel reads sliver specs from `%APPDATA%/Hayba/slivers/*.sliver.json` (same directory the MCP server uses — UE just re-parses the JSON in C++). When the user clicks Run, the plugin sends an HTTP POST to a new MCP-server endpoint (`localhost:3091/sliver/run`) and renders the response. A small `UHaybaSliverSettings` UDeveloperSettings holds the MCP URL.

**Tech Stack:** UE 5.7 Slate + Editor (`SCompoundWidget`, `FGlobalTabmanager`, `FWorkspaceMenuStructure`), `Json`/`JsonUtilities` modules for spec parsing, `HTTP` module for the MCP round-trip. TS side: minor addition to `mcp-tools/hayba-mcp/src/dashboard/server.ts` (or equivalent existing Express setup) to expose 4 sliver routes.

**Spec reference:** `docs/superpowers/specs/2026-05-21-slivers-design.md` — section "UE plugin — Slivers tab".
**Companion plans:** Plan A (TS runtime, PR #217 — shipped) defines the JSON spec shape and the MCP tools. Plan C (time_of_day + lighting handler) will add the second sliver but is independent of this UI work.

---

## Scope cuts vs the spec (intentional, deferred to v2)

| Spec item | v1 status |
|---|---|
| All 10 param widget types | v1 ships 6 (Float, Int, Bool, String, Enum, ActorRef). Vector3 / Color / Transform / AssetRef widgets → v2 |
| `SliverRunMode: AutoDebounced250ms` | Manual only in v1 |
| Per-sliver `Save preset` button + `.preset.json` files | Deferred |
| Rich output preview (parse `camera_transform`, etc.) | v1 shows raw JSON in a read-only text panel |
| Live sliver list refresh on disk change | v1 has a manual "Refresh" button |
| `MaxSliverDepth` config | Server-side default (8) only; no UI surface |

Each cut is small and additive — v2 extends the existing widget registry without restructuring.

---

## Architectural decisions (locked)

1. **UI shell:** Slate dockable tab via `FGlobalTabmanager::Get()->RegisterNomadTabSpawner`, opened from `Window → Slivers`. Not UMG / Editor Utility Widget. Pure C++ keeps it editor-only, no runtime UMG dependency.

2. **Spec parsing:** UE plugin re-implements `parseSliverSpec` in C++ (small — discriminated union over `type` strings, lift fields from `FJsonObject`). UE reads from the same `%APPDATA%/Hayba/slivers/` directory the MCP server seeds. No coupling beyond the on-disk JSON shape.

3. **Sliver execution:** new HTTP endpoint on the MCP server. UE plugin posts JSON to `http://localhost:3091/sliver/run` and parses the response. Port + host configurable via `UHaybaSliverSettings`. No new IPC primitive; UE already uses the `HTTP` module elsewhere for asset downloads.

4. **Param widget extensibility:** `SSliverParamWidget` is an abstract Slate widget. Each concrete type registers a factory at module startup. Adding `vector3` later = one new file + one registration line.

5. **No actor picker dropdown in v1.** `ActorRef` widget is a `SEditableTextBox` plus a small "Pick from selection" button that fills it from `GEditor->GetSelectedActors()`. The full `SObjectPropertyEntryBox` integration is v2 — it requires `PropertyEditor` module wiring that's worth its own task.

---

## File Structure

```
mcp-tools/hayba-mcp/
├── src/
│   └── http/
│       ├── sliver-routes.ts             # Express router: /sliver/{list,get,run,import}
│       ├── sliver-routes.test.ts
│       └── server.ts                    # Tiny Express bootstrap (port from env, default 3091)
├── package.json                          # modified: add "start:http" + "main" hint if needed
└── src/index.ts                          # modified: start HTTP server alongside MCP stdio

unreal/HaybaMCPToolkit/
├── HaybaMCPToolkit.uplugin               # modified: add "Slate", "SlateCore", "EditorStyle", "HTTP", "Json", "JsonUtilities" deps if missing
├── Source/HaybaMCPToolkit/
│   ├── HaybaMCPToolkit.Build.cs          # modified: add modules listed above
│   ├── Public/Slivers/
│   │   └── HaybaSliverSettings.h         # UDeveloperSettings — MCP URL/port
│   ├── Private/Slivers/
│   │   ├── HaybaSliverSettings.cpp
│   │   ├── HaybaSliverTypes.h            # C++ mirror of SliverSpec/SliverParam discriminated union
│   │   ├── HaybaSliverTypes.cpp          # ParseSliverSpec(FJsonObject) + reverse-DNS validator
│   │   ├── HaybaSliverLoader.h           # Reads %APPDATA%/Hayba/slivers/*.sliver.json
│   │   ├── HaybaSliverLoader.cpp
│   │   ├── HaybaSliverClient.h           # HTTP client (POST /sliver/run etc.)
│   │   ├── HaybaSliverClient.cpp
│   │   ├── SSliversPanel.h               # Top-level Slate widget: list + detail split
│   │   ├── SSliversPanel.cpp
│   │   ├── SSliverDetailPanel.h          # Param widgets + Run + output
│   │   ├── SSliverDetailPanel.cpp
│   │   ├── SSliverParamWidget.h          # Abstract base + factory registry
│   │   ├── SSliverParamWidget.cpp
│   │   ├── SSliverParamFloat.h/.cpp      # Float slider
│   │   ├── SSliverParamInt.h/.cpp        # Int slider
│   │   ├── SSliverParamBool.h/.cpp       # Checkbox
│   │   ├── SSliverParamString.h/.cpp     # Text input
│   │   ├── SSliverParamEnum.h/.cpp       # Dropdown
│   │   ├── SSliverParamActorRef.h/.cpp   # Text + "Pick from selection" button
│   │   └── HaybaSliverTabRegistration.cpp # Registers nomad tab + Window menu entry
│   └── HaybaMCPModule.cpp                 # modified: call HaybaSliver_RegisterTab on StartupModule
```

Each Slate widget is one .h/.cpp pair with one responsibility. Param widgets share a base class with a factory map keyed by the spec's `type` string.

---

### Task 1: TS-side — sliver routes module (TDD)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/http/sliver-routes.ts`
- Create: `mcp-tools/hayba-mcp/src/http/sliver-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/http/sliver-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setupSliverSystem } from '../slivers/index.js';
import { mountSliverRoutes } from './sliver-routes.js';

describe('sliver HTTP routes', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupSliverSystem>>;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-http-'));
    sys = await setupSliverSystem({ userDir, bundledDir: 'src/slivers/specs', maxDepth: 4 });
    const app = express();
    app.use(express.json());
    mountSliverRoutes(app, sys);
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;
  });
  afterEach(() => {
    server.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('GET /sliver/list returns installed slivers', async () => {
    const r = await fetch(`${url}/sliver/list`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.slivers.length).toBeGreaterThan(0);
    expect(body.slivers[0].id).toBe('com.hayba.composition.frame_target');
  });

  it('GET /sliver/list?category=composition filters', async () => {
    const r = await fetch(`${url}/sliver/list?category=composition`);
    const body = await r.json();
    expect(body.slivers.every((s: { category: string }) => s.category === 'composition')).toBe(true);
  });

  it('GET /sliver/get?id=... returns the full spec', async () => {
    const r = await fetch(`${url}/sliver/get?id=com.hayba.composition.frame_target`);
    const body = await r.json();
    expect(body.found).toBe(true);
    expect(body.spec.params.length).toBeGreaterThan(0);
  });

  it('POST /sliver/run executes and returns outputs', async () => {
    const r = await fetch(`${url}/sliver/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'com.hayba.composition.frame_target', params: { target: '/Game/X.X' } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.outputs).toHaveProperty('camera_transform');
  });

  it('POST /sliver/run returns ok=false on validation failure', async () => {
    const r = await fetch(`${url}/sliver/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'com.hayba.composition.frame_target', params: { target: '/Game/X.X', distance: 9999 } }),
    });
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/distance/);
  });

  it('POST /sliver/import installs from a JSON body', async () => {
    const spec = {
      id: 'com.test.http.demo',
      version: '1.0.0',
      category: 'demo',
      title: 'HTTP Demo',
      description: '',
      author: 'test',
      params: [],
      executor: { kind: 'demo.http' },
      determinism: { pure: true, declared_outputs: [], side_effects: [], seed_param: null },
    };
    const r = await fetch(`${url}/sliver/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(sys.loader.get('com.test.http.demo')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/http/sliver-routes.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the routes module**

```ts
// mcp-tools/hayba-mcp/src/http/sliver-routes.ts
//
// Express router exposing the four sliver tools over HTTP. Used by the
// UE plugin's Slivers panel; the LLM-facing MCP tools (hayba_sliver_*)
// remain stdio-based via the MCP server. Both surfaces share the same
// SliverSystem so installed slivers are visible from either side.

import type { Express, Request, Response } from 'express';
import type { SliverSystem } from '../slivers/index.js';
import { sliverListHandler } from '../tools/sliver/list.js';
import { sliverGetHandler }  from '../tools/sliver/get.js';
import { sliverRunHandler }  from '../tools/sliver/run.js';

export function mountSliverRoutes(app: Express, sys: SliverSystem): void {
  app.get('/sliver/list', async (req: Request, res: Response) => {
    const r = await sliverListHandler({
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      namespace: typeof req.query.namespace === 'string' ? req.query.namespace : undefined,
    }, { loader: sys.loader });
    res.json(r);
  });

  app.get('/sliver/get', async (req: Request, res: Response) => {
    if (typeof req.query.id !== 'string' || !req.query.id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    const r = await sliverGetHandler({ id: req.query.id }, { loader: sys.loader });
    res.json(r);
  });

  app.post('/sliver/run', async (req: Request, res: Response) => {
    const body = req.body as { id?: unknown; params?: unknown };
    if (typeof body.id !== 'string' || !body.id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    const r = await sliverRunHandler({
      id: body.id,
      params: (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>,
    }, { runtime: sys.runtime });
    res.json(r);
  });

  app.post('/sliver/import', async (req: Request, res: Response) => {
    const body = req.body as { spec?: unknown };
    if (!body.spec || typeof body.spec !== 'object') {
      res.status(400).json({ error: 'missing spec' });
      return;
    }
    const r = sys.loader.install(body.spec);
    res.json(r);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/http/sliver-routes.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/http/sliver-routes.ts mcp-tools/hayba-mcp/src/http/sliver-routes.test.ts
git commit -m "feat(slivers): HTTP routes exposing list/get/run/import to UE plugin"
```

---

### Task 2: TS-side — HTTP server bootstrap + index.ts wiring

**Files:**
- Create: `mcp-tools/hayba-mcp/src/http/server.ts`
- Modify: `mcp-tools/hayba-mcp/src/index.ts` (start the HTTP server alongside the MCP stdio server)

- [ ] **Step 1: Read `mcp-tools/hayba-mcp/src/index.ts`**

Identify where `registerDeferredRouting` is called and where the returned `RoutingHandle` is available. The new HTTP server needs `routingHandle.slivers` (the `SliverSystem`).

- [ ] **Step 2: Create the HTTP bootstrap**

```ts
// mcp-tools/hayba-mcp/src/http/server.ts
//
// Tiny Express bootstrap. Port comes from env HAYBA_MCP_HTTP_PORT, or
// 3091 by default. Bound to 127.0.0.1 only — local-machine traffic
// only, never exposed to the network.

import express from 'express';
import type { Server } from 'node:http';
import type { SliverSystem } from '../slivers/index.js';
import { mountSliverRoutes } from './sliver-routes.js';

export function startHttpServer(slivers: SliverSystem): Server {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountSliverRoutes(app, slivers);
  const port = Number(process.env.HAYBA_MCP_HTTP_PORT ?? 3091);
  const server = app.listen(port, '127.0.0.1', () => {
    console.error(`[hayba-mcp] HTTP listening on 127.0.0.1:${port}`);
  });
  return server;
}
```

- [ ] **Step 3: Wire into index.ts**

Add the import:

```ts
import { startHttpServer } from './http/server.js';
```

After `registerDeferredRouting(...)` resolves (the line where the `RoutingHandle` is captured), add:

```ts
startHttpServer(routingHandle.slivers);
```

Use the actual variable name the existing code uses for the routing handle — read the file first to find it.

- [ ] **Step 4: Verify build + smoke**

```bash
cd mcp-tools/hayba-mcp
npm run build:server
# Start the server in the background:
node dist/index.js &
HAYBA_PID=$!
sleep 1
# Hit the endpoint:
curl -s http://127.0.0.1:3091/sliver/list | head -c 200
echo
kill $HAYBA_PID
```

Expected: `{"slivers":[{"id":"com.hayba.composition.frame_target",...}]}`.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/http/server.ts mcp-tools/hayba-mcp/src/index.ts
git commit -m "feat(slivers): start HTTP server on 127.0.0.1:3091 for UE plugin"
```

---

### Task 3: UE — Build.cs dependencies + plugin manifest

**Files:**
- Modify: `unreal/HaybaMCPToolkit/HaybaMCPToolkit.uplugin`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/HaybaMCPToolkit.Build.cs`

- [ ] **Step 1: Read both files**

Identify the current module dependency list. The plugin already depends on Core/CoreUObject/Engine/Editor (verify). It needs to add: `Slate`, `SlateCore`, `EditorStyle`, `EditorWidgets`, `WorkspaceMenuStructure`, `ToolMenus`, `InputCore`, `HTTP`, `Json`, `JsonUtilities`, `DeveloperSettings`, `UnrealEd`. Skip any already present.

- [ ] **Step 2: Update Build.cs**

In the `PublicDependencyModuleNames.AddRange(new string[] { ... })` block (or `PrivateDependencyModuleNames` if the existing pattern uses that), add the missing modules. Keep alphabetical order if the existing file does. Example final state for the Private list:

```csharp
PrivateDependencyModuleNames.AddRange(new string[] {
    "Core", "CoreUObject", "Engine", "Slate", "SlateCore",
    "EditorStyle", "EditorWidgets", "WorkspaceMenuStructure",
    "ToolMenus", "InputCore", "HTTP", "Json", "JsonUtilities",
    "DeveloperSettings", "UnrealEd",
    // ... existing deps preserved
});
```

- [ ] **Step 3: Verify the plugin still compiles**

Run from a shell that can build UE (the user may need to do this from the editor; document it as a manual step):

```
The user opens Unreal Editor. On first open after this change UE will
prompt "Modules out of date, rebuild?" — click Yes.
```

The agent cannot build UE itself; mark this as a manual verification step in the report.

- [ ] **Step 4: Commit**

```bash
git add unreal/HaybaMCPToolkit/HaybaMCPToolkit.uplugin unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/HaybaMCPToolkit.Build.cs
git commit -m "build(slivers): add Slate + HTTP + Json + Editor module deps for Slivers tab"
```

---

### Task 4: UE — `UHaybaSliverSettings` UDeveloperSettings

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/Slivers/HaybaSliverSettings.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverSettings.cpp`

- [ ] **Step 1: Header**

```cpp
// HaybaSliverSettings.h — DeveloperSettings exposing the MCP HTTP URL
// and the Slivers tab run mode. Lives in Project Settings → Plugins →
// Hayba MCP → Slivers. Per-project (DefaultEditor.ini).

#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "HaybaSliverSettings.generated.h"

UENUM(BlueprintType)
enum class EHaybaSliverRunMode : uint8
{
    Manual           UMETA(DisplayName = "Manual"),
    // AutoDebounced — v2; placeholder enum value keeps the future widget render flat.
    AutoDebounced250 UMETA(DisplayName = "Auto (debounced 250 ms) — v2 only"),
};

UCLASS(config = EditorPerProjectUserSettings, defaultconfig, meta = (DisplayName = "Hayba Slivers"))
class HAYBAMCPTOOLKIT_API UHaybaSliverSettings : public UDeveloperSettings
{
    GENERATED_BODY()
public:
    UHaybaSliverSettings();

    /** Base URL of the MCP server's HTTP listener. Set by hayba-mcp on startup; default matches its default port. */
    UPROPERTY(EditAnywhere, config, Category = "Hayba Slivers")
    FString McpHttpBaseUrl;

    /** v1 ships Manual only. AutoDebounced lands in v2. */
    UPROPERTY(EditAnywhere, config, Category = "Hayba Slivers")
    EHaybaSliverRunMode RunMode;

    /** Maximum recursion depth when slivers call each other. */
    UPROPERTY(EditAnywhere, config, Category = "Hayba Slivers", meta = (ClampMin = "1", ClampMax = "32"))
    int32 MaxSliverDepth;

    static const UHaybaSliverSettings* GetChecked();
};
```

- [ ] **Step 2: Implementation**

```cpp
// HaybaSliverSettings.cpp
#include "Slivers/HaybaSliverSettings.h"

UHaybaSliverSettings::UHaybaSliverSettings()
    : McpHttpBaseUrl(TEXT("http://127.0.0.1:3091"))
    , RunMode(EHaybaSliverRunMode::Manual)
    , MaxSliverDepth(8)
{}

const UHaybaSliverSettings* UHaybaSliverSettings::GetChecked()
{
    const UHaybaSliverSettings* S = GetDefault<UHaybaSliverSettings>();
    check(S);
    return S;
}
```

- [ ] **Step 3: Manual verification (after Task 12 wires the tab open)**

Document: After implementing this task the settings are not visible until UE is rebuilt. They will appear under Project Settings → Plugins → Hayba Slivers once the plugin is reloaded.

- [ ] **Step 4: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/Slivers/HaybaSliverSettings.h \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverSettings.cpp
git commit -m "feat(slivers): UHaybaSliverSettings (MCP URL, run mode, max depth)"
```

---

### Task 5: UE — `FHaybaSliverSpec` C++ types + JSON parser

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverTypes.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverTypes.cpp`

- [ ] **Step 1: Header — mirror the TS shapes in plain C++ structs**

```cpp
// HaybaSliverTypes.h — C++ mirror of the on-disk SliverSpec JSON shape.
// Only the v1 param types are decoded (Float, Int, Bool, String, Enum,
// ActorRef); other type strings parse into FHaybaSliverParam with
// Type=Unsupported and are surfaced by the panel as "not yet supported".

#pragma once

#include "CoreMinimal.h"
#include "Templates/SharedPointer.h"

class FJsonObject;

enum class EHaybaSliverParamType : uint8
{
    Float,
    Int,
    Bool,
    String,
    Enum,
    ActorRef,
    Unsupported,
};

struct FHaybaSliverEnumOption
{
    FString Value;
    FString Label;
};

struct FHaybaSliverParam
{
    FString Id;
    FString Label;
    bool bRequired = false;
    EHaybaSliverParamType Type = EHaybaSliverParamType::Unsupported;
    FString OriginalTypeString;   // verbatim from JSON, used for the Unsupported message

    // Numeric (float / int)
    TOptional<double> RangeMin;
    TOptional<double> RangeMax;
    TOptional<double> DefaultNumber;

    // Bool
    TOptional<bool>   DefaultBool;

    // String / Enum / ActorRef
    TOptional<FString> DefaultString;
    TArray<FHaybaSliverEnumOption> EnumOptions;

    // ActorRef
    FString ClassFilter;
};

struct FHaybaSliverDeterminism
{
    bool bPure = true;
    TArray<FString> DeclaredOutputs;
    TArray<FString> SideEffects;
    TOptional<FString> SeedParam;
};

struct FHaybaSliverSpec
{
    FString Id;
    FString Version;
    FString Category;
    FString Title;
    FString Description;
    FString Author;
    FString ExecutorKind;
    TArray<FHaybaSliverParam> Params;
    FHaybaSliverDeterminism Determinism;
};

/** Returns true and fills OutSpec on success; false and OutError on validation failure. */
bool ParseHaybaSliverSpec(const TSharedRef<FJsonObject>& In, FHaybaSliverSpec& OutSpec, FString& OutError);

/** Reverse-DNS check: at least 3 dot-separated segments, lowercase + underscores. */
bool IsReverseDnsId(const FString& Id);
```

- [ ] **Step 2: Implementation**

```cpp
// HaybaSliverTypes.cpp
#include "Slivers/HaybaSliverTypes.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Internationalization/Regex.h"

bool IsReverseDnsId(const FString& Id)
{
    // Mirrors src/slivers/spec-schema.ts: ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$
    const FRegexPattern Pattern(TEXT("^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){2,}$"));
    FRegexMatcher M(Pattern, Id);
    return M.FindNext();
}

static bool ParseRange(const TSharedPtr<FJsonValue>& V, TOptional<double>& OutMin, TOptional<double>& OutMax)
{
    if (!V.IsValid() || V->Type != EJson::Array) return false;
    const TArray<TSharedPtr<FJsonValue>>& A = V->AsArray();
    if (A.Num() != 2) return false;
    OutMin = A[0]->AsNumber();
    OutMax = A[1]->AsNumber();
    return true;
}

static EHaybaSliverParamType ParamTypeFromString(const FString& S)
{
    if (S == TEXT("float"))     return EHaybaSliverParamType::Float;
    if (S == TEXT("int"))       return EHaybaSliverParamType::Int;
    if (S == TEXT("bool"))      return EHaybaSliverParamType::Bool;
    if (S == TEXT("string"))    return EHaybaSliverParamType::String;
    if (S == TEXT("enum"))      return EHaybaSliverParamType::Enum;
    if (S == TEXT("actor_ref")) return EHaybaSliverParamType::ActorRef;
    return EHaybaSliverParamType::Unsupported;
}

static bool ParseParam(const TSharedPtr<FJsonObject>& Obj, FHaybaSliverParam& Out, FString& OutError)
{
    if (!Obj->TryGetStringField(TEXT("id"), Out.Id) || Out.Id.IsEmpty())
    { OutError = TEXT("param missing id"); return false; }
    Obj->TryGetStringField(TEXT("label"), Out.Label);
    Obj->TryGetBoolField(TEXT("required"), Out.bRequired);

    FString TypeStr;
    if (!Obj->TryGetStringField(TEXT("type"), TypeStr))
    { OutError = FString::Printf(TEXT("param %s missing type"), *Out.Id); return false; }
    Out.OriginalTypeString = TypeStr;
    Out.Type = ParamTypeFromString(TypeStr);

    // Range
    if (Out.Type == EHaybaSliverParamType::Float || Out.Type == EHaybaSliverParamType::Int)
    {
        const TArray<TSharedPtr<FJsonValue>>* RangeArr = nullptr;
        if (Obj->TryGetArrayField(TEXT("range"), RangeArr) && RangeArr && RangeArr->Num() == 2)
        {
            Out.RangeMin = (*RangeArr)[0]->AsNumber();
            Out.RangeMax = (*RangeArr)[1]->AsNumber();
        }
        double DefNum;
        if (Obj->TryGetNumberField(TEXT("default"), DefNum)) Out.DefaultNumber = DefNum;
    }
    if (Out.Type == EHaybaSliverParamType::Bool)
    {
        bool DefB;
        if (Obj->TryGetBoolField(TEXT("default"), DefB)) Out.DefaultBool = DefB;
    }
    if (Out.Type == EHaybaSliverParamType::String || Out.Type == EHaybaSliverParamType::Enum || Out.Type == EHaybaSliverParamType::ActorRef)
    {
        FString DefS;
        if (Obj->TryGetStringField(TEXT("default"), DefS)) Out.DefaultString = DefS;
    }
    if (Out.Type == EHaybaSliverParamType::Enum)
    {
        const TArray<TSharedPtr<FJsonValue>>* OptArr = nullptr;
        if (Obj->TryGetArrayField(TEXT("options"), OptArr) && OptArr)
        {
            for (const TSharedPtr<FJsonValue>& Opt : *OptArr)
            {
                if (Opt->Type != EJson::Object) continue;
                FHaybaSliverEnumOption O;
                Opt->AsObject()->TryGetStringField(TEXT("value"), O.Value);
                Opt->AsObject()->TryGetStringField(TEXT("label"), O.Label);
                Out.EnumOptions.Add(O);
            }
        }
    }
    if (Out.Type == EHaybaSliverParamType::ActorRef)
    {
        Obj->TryGetStringField(TEXT("class_filter"), Out.ClassFilter);
    }
    return true;
}

bool ParseHaybaSliverSpec(const TSharedRef<FJsonObject>& In, FHaybaSliverSpec& OutSpec, FString& OutError)
{
    if (!In->TryGetStringField(TEXT("id"), OutSpec.Id) || !IsReverseDnsId(OutSpec.Id))
    { OutError = TEXT("invalid or missing reverse-DNS id"); return false; }
    if (!In->TryGetStringField(TEXT("version"), OutSpec.Version))   { OutError = TEXT("missing version"); return false; }
    if (!In->TryGetStringField(TEXT("category"), OutSpec.Category)) { OutError = TEXT("missing category"); return false; }
    if (!In->TryGetStringField(TEXT("title"), OutSpec.Title))       { OutError = TEXT("missing title"); return false; }
    In->TryGetStringField(TEXT("description"), OutSpec.Description);
    if (!In->TryGetStringField(TEXT("author"), OutSpec.Author))     { OutError = TEXT("missing author"); return false; }

    const TSharedPtr<FJsonObject>* ExecObj = nullptr;
    if (!In->TryGetObjectField(TEXT("executor"), ExecObj) || !(*ExecObj)->TryGetStringField(TEXT("kind"), OutSpec.ExecutorKind))
    { OutError = TEXT("missing executor.kind"); return false; }

    const TArray<TSharedPtr<FJsonValue>>* ParamsArr = nullptr;
    if (In->TryGetArrayField(TEXT("params"), ParamsArr) && ParamsArr)
    {
        TSet<FString> SeenIds;
        for (const TSharedPtr<FJsonValue>& V : *ParamsArr)
        {
            if (V->Type != EJson::Object) continue;
            FHaybaSliverParam P;
            FString Err;
            if (!ParseParam(V->AsObject(), P, Err)) { OutError = Err; return false; }
            if (SeenIds.Contains(P.Id)) { OutError = FString::Printf(TEXT("duplicate param id \"%s\""), *P.Id); return false; }
            SeenIds.Add(P.Id);
            OutSpec.Params.Add(P);
        }
    }

    const TSharedPtr<FJsonObject>* DetObj = nullptr;
    if (In->TryGetObjectField(TEXT("determinism"), DetObj))
    {
        (*DetObj)->TryGetBoolField(TEXT("pure"), OutSpec.Determinism.bPure);
        const TArray<TSharedPtr<FJsonValue>>* Outs = nullptr;
        if ((*DetObj)->TryGetArrayField(TEXT("declared_outputs"), Outs) && Outs)
            for (const TSharedPtr<FJsonValue>& V : *Outs) OutSpec.Determinism.DeclaredOutputs.Add(V->AsString());
        const TArray<TSharedPtr<FJsonValue>>* Effects = nullptr;
        if ((*DetObj)->TryGetArrayField(TEXT("side_effects"), Effects) && Effects)
            for (const TSharedPtr<FJsonValue>& V : *Effects) OutSpec.Determinism.SideEffects.Add(V->AsString());
        FString Seed;
        if ((*DetObj)->TryGetStringField(TEXT("seed_param"), Seed) && !Seed.IsEmpty())
            OutSpec.Determinism.SeedParam = Seed;
    }
    return true;
}
```

- [ ] **Step 3: Commit**

No UE-side runtime test framework is wired up in this plugin (verify by reading any existing `*Test*.cpp` — likely absent). Skip a separate test; the integration smoke in Task 13 covers the parser end-to-end.

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverTypes.h \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverTypes.cpp
git commit -m "feat(slivers): C++ FHaybaSliverSpec + JSON parser (v1 param types)"
```

---

### Task 6: UE — `FHaybaSliverLoader` (disk read)

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverLoader.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverLoader.cpp`

- [ ] **Step 1: Header**

```cpp
// HaybaSliverLoader.h — Scans %APPDATA%/Hayba/slivers/*.sliver.json,
// parses each one into FHaybaSliverSpec, exposes a flat list + lookup.
// Cheap to refresh on demand (no watcher; the panel exposes a Refresh
// button).

#pragma once

#include "CoreMinimal.h"
#include "Slivers/HaybaSliverTypes.h"

class FHaybaSliverLoader
{
public:
    /** %APPDATA%/Hayba/slivers on Windows, $HOME/.hayba/Hayba/slivers elsewhere. */
    static FString DefaultUserSliversDir();

    /** Reads + parses every *.sliver.json in UserDir. Replaces in-memory state. */
    void Refresh(const FString& UserDir);

    const TArray<FHaybaSliverSpec>& List() const { return Specs; }
    const FHaybaSliverSpec* Find(const FString& Id) const;
    const TArray<FString>& Errors() const { return LoadErrors; }

private:
    TArray<FHaybaSliverSpec> Specs;
    TArray<FString> LoadErrors;
};
```

- [ ] **Step 2: Implementation**

```cpp
// HaybaSliverLoader.cpp
#include "Slivers/HaybaSliverLoader.h"

#include "Dom/JsonObject.h"
#include "HAL/PlatformProcess.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

FString FHaybaSliverLoader::DefaultUserSliversDir()
{
#if PLATFORM_WINDOWS
    FString Appdata = FPlatformMisc::GetEnvironmentVariable(TEXT("APPDATA"));
    if (Appdata.IsEmpty()) Appdata = FPaths::ProjectSavedDir();
    return FPaths::Combine(Appdata, TEXT("Hayba"), TEXT("slivers"));
#else
    FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("HOME"));
    if (Home.IsEmpty()) Home = FPaths::ProjectSavedDir();
    return FPaths::Combine(Home, TEXT(".hayba"), TEXT("Hayba"), TEXT("slivers"));
#endif
}

void FHaybaSliverLoader::Refresh(const FString& UserDir)
{
    Specs.Reset();
    LoadErrors.Reset();

    if (!IFileManager::Get().DirectoryExists(*UserDir)) return;

    TArray<FString> Files;
    IFileManager::Get().FindFiles(Files, *FPaths::Combine(UserDir, TEXT("*.sliver.json")), /*Files*/true, /*Dirs*/false);

    for (const FString& Name : Files)
    {
        const FString Full = FPaths::Combine(UserDir, Name);
        FString Raw;
        if (!FFileHelper::LoadFileToString(Raw, *Full))
        { LoadErrors.Add(FString::Printf(TEXT("%s: failed to read"), *Name)); continue; }

        TSharedPtr<FJsonObject> Obj;
        TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
        if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid())
        { LoadErrors.Add(FString::Printf(TEXT("%s: invalid JSON"), *Name)); continue; }

        FHaybaSliverSpec Spec;
        FString Err;
        if (!ParseHaybaSliverSpec(Obj.ToSharedRef(), Spec, Err))
        { LoadErrors.Add(FString::Printf(TEXT("%s: %s"), *Name, *Err)); continue; }

        Specs.Add(MoveTemp(Spec));
    }
}

const FHaybaSliverSpec* FHaybaSliverLoader::Find(const FString& Id) const
{
    for (const FHaybaSliverSpec& S : Specs) if (S.Id == Id) return &S;
    return nullptr;
}
```

- [ ] **Step 3: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverLoader.h \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverLoader.cpp
git commit -m "feat(slivers): FHaybaSliverLoader reads %APPDATA%/Hayba/slivers"
```

---

### Task 7: UE — `FHaybaSliverClient` HTTP client

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverClient.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverClient.cpp`

- [ ] **Step 1: Header**

```cpp
// HaybaSliverClient.h — Thin HTTP client over the MCP server's
// /sliver/run endpoint. Async: caller passes a completion delegate
// fired on the game thread.

#pragma once

#include "CoreMinimal.h"

DECLARE_DELEGATE_TwoParams(FHaybaSliverRunCallback, bool /*bOk*/, const FString& /*JsonResponseOrError*/);

class FHaybaSliverClient
{
public:
    /** POST /sliver/run with the given id + params (JSON-serialised). */
    static void RunSliver(
        const FString& BaseUrl,
        const FString& Id,
        const FString& ParamsJson,
        FHaybaSliverRunCallback OnDone);
};
```

- [ ] **Step 2: Implementation**

```cpp
// HaybaSliverClient.cpp
#include "Slivers/HaybaSliverClient.h"

#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

void FHaybaSliverClient::RunSliver(
    const FString& BaseUrl,
    const FString& Id,
    const FString& ParamsJson,
    FHaybaSliverRunCallback OnDone)
{
    const FString Url = BaseUrl + TEXT("/sliver/run");
    const FString Body = FString::Printf(TEXT("{\"id\":\"%s\",\"params\":%s}"), *Id, *ParamsJson);

    const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
    Req->SetVerb(TEXT("POST"));
    Req->SetURL(Url);
    Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Req->SetContentAsString(Body);

    Req->OnProcessRequestComplete().BindLambda(
        [OnDone](FHttpRequestPtr, FHttpResponsePtr Resp, bool bSucceeded)
        {
            if (!bSucceeded || !Resp.IsValid())
            { OnDone.ExecuteIfBound(false, TEXT("HTTP request failed")); return; }
            const int32 Code = Resp->GetResponseCode();
            const FString Content = Resp->GetContentAsString();
            OnDone.ExecuteIfBound(Code >= 200 && Code < 300, Content);
        });
    Req->ProcessRequest();
}
```

- [ ] **Step 3: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverClient.h \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverClient.cpp
git commit -m "feat(slivers): FHaybaSliverClient HTTP wrapper for /sliver/run"
```

---

### Task 8: UE — `SSliverParamWidget` base + factory

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamWidget.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamWidget.cpp`

- [ ] **Step 1: Header — abstract base + factory map**

```cpp
// SSliverParamWidget.h — Abstract base for every param widget. Each
// concrete widget knows how to (a) render a Slate row for one param
// and (b) report its current value back to the panel when Run is
// pressed.
//
// Widgets register themselves at module startup via
// FSliverParamWidgetRegistry::Register("float", &Make).

#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Slivers/HaybaSliverTypes.h"

class SSliverParamWidget : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamWidget) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs) { Param = InArgs._Param; }

    /** JSON fragment for this param's current value: e.g. `12.5`, `"hello"`, `true`. */
    virtual FString GetValueAsJson() const = 0;

    const FHaybaSliverParam& GetParam() const { return Param; }

protected:
    FHaybaSliverParam Param;
};

class FSliverParamWidgetRegistry
{
public:
    using FFactory = TFunction<TSharedRef<SSliverParamWidget>(const FHaybaSliverParam&)>;

    static FSliverParamWidgetRegistry& Get();
    void Register(EHaybaSliverParamType Type, FFactory Make);
    TSharedRef<SSliverParamWidget> Create(const FHaybaSliverParam& Param) const;

private:
    TMap<EHaybaSliverParamType, FFactory> Factories;
};

/** Called once on module startup to register all built-in widgets. */
void HaybaSliver_RegisterBuiltinParamWidgets();
```

- [ ] **Step 2: Implementation skeleton + an "unsupported" fallback widget**

```cpp
// SSliverParamWidget.cpp
#include "Slivers/SSliverParamWidget.h"

#include "Widgets/Text/STextBlock.h"

namespace
{
    class SUnsupportedParamWidget : public SSliverParamWidget
    {
    public:
        SLATE_BEGIN_ARGS(SUnsupportedParamWidget) {}
            SLATE_ARGUMENT(FHaybaSliverParam, Param)
        SLATE_END_ARGS()

        void Construct(const FArguments& InArgs)
        {
            SSliverParamWidget::FArguments BaseArgs;
            BaseArgs._Param = InArgs._Param;
            SSliverParamWidget::Construct(BaseArgs);

            ChildSlot
            [
                SNew(STextBlock).Text(FText::FromString(FString::Printf(
                    TEXT("[unsupported param type: %s]"), *Param.OriginalTypeString)))
            ];
        }

        virtual FString GetValueAsJson() const override { return TEXT("null"); }
    };
}

FSliverParamWidgetRegistry& FSliverParamWidgetRegistry::Get()
{
    static FSliverParamWidgetRegistry Singleton;
    return Singleton;
}

void FSliverParamWidgetRegistry::Register(EHaybaSliverParamType Type, FFactory Make)
{
    Factories.Add(Type, MoveTemp(Make));
}

TSharedRef<SSliverParamWidget> FSliverParamWidgetRegistry::Create(const FHaybaSliverParam& Param) const
{
    if (const FFactory* F = Factories.Find(Param.Type)) return (*F)(Param);
    return SNew(SUnsupportedParamWidget).Param(Param);
}
```

The `HaybaSliver_RegisterBuiltinParamWidgets` function is defined in Task 11 once all widgets exist.

- [ ] **Step 3: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamWidget.h \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamWidget.cpp
git commit -m "feat(slivers): SSliverParamWidget base + factory registry + unsupported fallback"
```

---

### Task 9: UE — Float + Int + Bool param widgets

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamFloat.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamFloat.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamInt.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamInt.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamBool.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamBool.cpp`

- [ ] **Step 1: Float — `SSpinBox<float>` with min/max from `RangeMin/Max`**

```cpp
// SSliverParamFloat.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamFloat : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamFloat) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    float Value = 0.f;
};
```

```cpp
// SSliverParamFloat.cpp
#include "Slivers/SSliverParamFloat.h"
#include "Widgets/Input/SSpinBox.h"

void SSliverParamFloat::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    Value = static_cast<float>(Param.DefaultNumber.Get(0.0));

    auto Spin = SNew(SSpinBox<float>)
        .Value_Lambda([this]() { return Value; })
        .OnValueChanged_Lambda([this](float V) { Value = V; });
    if (Param.RangeMin.IsSet()) Spin->SetMinValue(static_cast<float>(Param.RangeMin.GetValue()));
    if (Param.RangeMax.IsSet()) Spin->SetMaxValue(static_cast<float>(Param.RangeMax.GetValue()));

    ChildSlot [ Spin ];
}

FString SSliverParamFloat::GetValueAsJson() const
{
    return FString::SanitizeFloat(Value);
}
```

- [ ] **Step 2: Int — same shape with `SSpinBox<int32>`**

```cpp
// SSliverParamInt.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamInt : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamInt) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    int32 Value = 0;
};
```

```cpp
// SSliverParamInt.cpp
#include "Slivers/SSliverParamInt.h"
#include "Widgets/Input/SSpinBox.h"

void SSliverParamInt::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    Value = static_cast<int32>(Param.DefaultNumber.Get(0.0));

    auto Spin = SNew(SSpinBox<int32>)
        .Value_Lambda([this]() { return Value; })
        .OnValueChanged_Lambda([this](int32 V) { Value = V; });
    if (Param.RangeMin.IsSet()) Spin->SetMinValue(static_cast<int32>(Param.RangeMin.GetValue()));
    if (Param.RangeMax.IsSet()) Spin->SetMaxValue(static_cast<int32>(Param.RangeMax.GetValue()));

    ChildSlot [ Spin ];
}

FString SSliverParamInt::GetValueAsJson() const { return FString::FromInt(Value); }
```

- [ ] **Step 3: Bool — `SCheckBox`**

```cpp
// SSliverParamBool.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamBool : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamBool) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    bool bValue = false;
};
```

```cpp
// SSliverParamBool.cpp
#include "Slivers/SSliverParamBool.h"
#include "Widgets/Input/SCheckBox.h"

void SSliverParamBool::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    bValue = Param.DefaultBool.Get(false);

    ChildSlot
    [
        SNew(SCheckBox)
        .IsChecked_Lambda([this]() { return bValue ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
        .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bValue = (S == ECheckBoxState::Checked); })
    ];
}

FString SSliverParamBool::GetValueAsJson() const { return bValue ? TEXT("true") : TEXT("false"); }
```

- [ ] **Step 4: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamFloat.* \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamInt.* \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamBool.*
git commit -m "feat(slivers): Float / Int / Bool Slate param widgets"
```

---

### Task 10: UE — String + Enum + ActorRef param widgets

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamString.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamString.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamEnum.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamEnum.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamActorRef.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamActorRef.cpp`

- [ ] **Step 1: String — `SEditableTextBox`**

```cpp
// SSliverParamString.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamString : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamString) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    FString Value;
};
```

```cpp
// SSliverParamString.cpp
#include "Slivers/SSliverParamString.h"
#include "Widgets/Input/SEditableTextBox.h"

static FString JsonEscape(const FString& In)
{
    FString S = In;
    S.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
    S.ReplaceInline(TEXT("\""), TEXT("\\\""));
    S.ReplaceInline(TEXT("\n"), TEXT("\\n"));
    S.ReplaceInline(TEXT("\r"), TEXT("\\r"));
    S.ReplaceInline(TEXT("\t"), TEXT("\\t"));
    return S;
}

void SSliverParamString::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    Value = Param.DefaultString.Get(FString());

    ChildSlot
    [
        SNew(SEditableTextBox)
        .Text_Lambda([this]() { return FText::FromString(Value); })
        .OnTextChanged_Lambda([this](const FText& T) { Value = T.ToString(); })
    ];
}

FString SSliverParamString::GetValueAsJson() const
{
    return FString::Printf(TEXT("\"%s\""), *JsonEscape(Value));
}
```

- [ ] **Step 2: Enum — `SComboBox<TSharedPtr<FString>>`**

```cpp
// SSliverParamEnum.h
#pragma once
#include "Slivers/SSliverParamWidget.h"
#include "Widgets/Input/SComboBox.h"

class SSliverParamEnum : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamEnum) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    TArray<TSharedPtr<FString>> Options;
    TSharedPtr<FString> Selected;
};
```

```cpp
// SSliverParamEnum.cpp
#include "Slivers/SSliverParamEnum.h"
#include "Widgets/Text/STextBlock.h"

static FString JsonEscape2(const FString& In)
{
    FString S = In;
    S.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
    S.ReplaceInline(TEXT("\""), TEXT("\\\""));
    return S;
}

void SSliverParamEnum::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    for (const FHaybaSliverEnumOption& O : Param.EnumOptions)
        Options.Add(MakeShared<FString>(O.Value));

    const FString Def = Param.DefaultString.Get(Options.Num() > 0 ? *Options[0] : FString());
    for (const TSharedPtr<FString>& Opt : Options) if (*Opt == Def) { Selected = Opt; break; }
    if (!Selected.IsValid() && Options.Num() > 0) Selected = Options[0];

    ChildSlot
    [
        SNew(SComboBox<TSharedPtr<FString>>)
        .OptionsSource(&Options)
        .OnGenerateWidget_Lambda([](TSharedPtr<FString> Item)
        { return SNew(STextBlock).Text(FText::FromString(*Item)); })
        .OnSelectionChanged_Lambda([this](TSharedPtr<FString> Item, ESelectInfo::Type)
        { Selected = Item; })
        .InitiallySelectedItem(Selected)
        [
            SNew(STextBlock).Text_Lambda([this]()
            { return Selected.IsValid() ? FText::FromString(*Selected) : FText::GetEmpty(); })
        ]
    ];
}

FString SSliverParamEnum::GetValueAsJson() const
{
    if (!Selected.IsValid()) return TEXT("null");
    return FString::Printf(TEXT("\"%s\""), *JsonEscape2(*Selected));
}
```

- [ ] **Step 3: ActorRef — text box + "Pick from selection" button**

```cpp
// SSliverParamActorRef.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamActorRef : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamActorRef) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    FString Value;
    FReply OnPickFromSelection();
};
```

```cpp
// SSliverParamActorRef.cpp
#include "Slivers/SSliverParamActorRef.h"
#include "Editor.h"
#include "GameFramework/Actor.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

static FString JsonEscapeA(const FString& In)
{
    FString S = In;
    S.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
    S.ReplaceInline(TEXT("\""), TEXT("\\\""));
    return S;
}

void SSliverParamActorRef::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    Value = Param.DefaultString.Get(FString());

    ChildSlot
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(1.0f).Padding(2)
        [
            SNew(SEditableTextBox)
            .Text_Lambda([this]() { return FText::FromString(Value); })
            .OnTextChanged_Lambda([this](const FText& T) { Value = T.ToString(); })
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(2)
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("Pick from selection")))
            .OnClicked(this, &SSliverParamActorRef::OnPickFromSelection)
        ]
    ];
}

FReply SSliverParamActorRef::OnPickFromSelection()
{
    if (!GEditor) return FReply::Handled();
    TArray<AActor*> Sel;
    GEditor->GetSelectedActors()->GetSelectedObjects<AActor>(Sel);
    if (Sel.Num() > 0 && Sel[0]) Value = Sel[0]->GetPathName();
    return FReply::Handled();
}

FString SSliverParamActorRef::GetValueAsJson() const
{
    return FString::Printf(TEXT("\"%s\""), *JsonEscapeA(Value));
}
```

- [ ] **Step 4: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamString.* \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamEnum.* \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamActorRef.*
git commit -m "feat(slivers): String / Enum / ActorRef Slate param widgets"
```

---

### Task 11: UE — Register all built-in param widget factories

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamWidget.cpp` (or add a new file `HaybaSliverParamWidgetRegistration.cpp`)

- [ ] **Step 1: Implement `HaybaSliver_RegisterBuiltinParamWidgets`**

Add at the end of `SSliverParamWidget.cpp`:

```cpp
#include "Slivers/SSliverParamFloat.h"
#include "Slivers/SSliverParamInt.h"
#include "Slivers/SSliverParamBool.h"
#include "Slivers/SSliverParamString.h"
#include "Slivers/SSliverParamEnum.h"
#include "Slivers/SSliverParamActorRef.h"

void HaybaSliver_RegisterBuiltinParamWidgets()
{
    FSliverParamWidgetRegistry& R = FSliverParamWidgetRegistry::Get();
    R.Register(EHaybaSliverParamType::Float,    [](const FHaybaSliverParam& P) -> TSharedRef<SSliverParamWidget>
        { return SNew(SSliverParamFloat).Param(P); });
    R.Register(EHaybaSliverParamType::Int,      [](const FHaybaSliverParam& P) -> TSharedRef<SSliverParamWidget>
        { return SNew(SSliverParamInt).Param(P); });
    R.Register(EHaybaSliverParamType::Bool,     [](const FHaybaSliverParam& P) -> TSharedRef<SSliverParamWidget>
        { return SNew(SSliverParamBool).Param(P); });
    R.Register(EHaybaSliverParamType::String,   [](const FHaybaSliverParam& P) -> TSharedRef<SSliverParamWidget>
        { return SNew(SSliverParamString).Param(P); });
    R.Register(EHaybaSliverParamType::Enum,     [](const FHaybaSliverParam& P) -> TSharedRef<SSliverParamWidget>
        { return SNew(SSliverParamEnum).Param(P); });
    R.Register(EHaybaSliverParamType::ActorRef, [](const FHaybaSliverParam& P) -> TSharedRef<SSliverParamWidget>
        { return SNew(SSliverParamActorRef).Param(P); });
}
```

- [ ] **Step 2: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverParamWidget.cpp
git commit -m "feat(slivers): register built-in param widget factories"
```

---

### Task 12: UE — `SSliverDetailPanel` (param widgets + Run + output)

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverDetailPanel.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverDetailPanel.cpp`

- [ ] **Step 1: Header**

```cpp
// SSliverDetailPanel.h — Shows a single sliver: title, description,
// generated param widgets, Run button, output text box.

#pragma once

#include "CoreMinimal.h"
#include "Slivers/HaybaSliverTypes.h"
#include "Slivers/SSliverParamWidget.h"
#include "Widgets/SCompoundWidget.h"

class SMultiLineEditableTextBox;

class SSliverDetailPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverDetailPanel) {}
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);

    /** Switch the panel to display + run this spec. Resets all param widgets. */
    void SetSpec(const FHaybaSliverSpec& InSpec);

private:
    FHaybaSliverSpec Spec;
    TArray<TSharedRef<SSliverParamWidget>> ParamWidgets;
    TSharedPtr<SMultiLineEditableTextBox> OutputBox;
    TSharedPtr<class SVerticalBox> ParamBox;
    TSharedPtr<class STextBlock> TitleText;
    TSharedPtr<class STextBlock> DescriptionText;
    bool bRunning = false;

    FReply OnRunClicked();
    FString BuildParamsJson() const;
    void RebuildParamUI();
};
```

- [ ] **Step 2: Implementation**

```cpp
// SSliverDetailPanel.cpp
#include "Slivers/SSliverDetailPanel.h"

#include "Slivers/HaybaSliverClient.h"
#include "Slivers/HaybaSliverSettings.h"
#include "Async/Async.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

void SSliverDetailPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ SAssignNew(TitleText, STextBlock) ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ SAssignNew(DescriptionText, STextBlock) ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ SAssignNew(ParamBox, SVerticalBox) ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("Run")))
            .OnClicked(this, &SSliverDetailPanel::OnRunClicked)
        ]
        + SVerticalBox::Slot().FillHeight(1.0f).Padding(4)
        [
            SNew(SBorder)
            [
                SAssignNew(OutputBox, SMultiLineEditableTextBox)
                .IsReadOnly(true)
                .Text(FText::FromString(TEXT("(no run yet)")))
            ]
        ]
    ];
}

void SSliverDetailPanel::SetSpec(const FHaybaSliverSpec& InSpec)
{
    Spec = InSpec;
    if (TitleText)       TitleText->SetText(FText::FromString(Spec.Title + TEXT("  (") + Spec.Id + TEXT(")")));
    if (DescriptionText) DescriptionText->SetText(FText::FromString(Spec.Description));
    if (OutputBox)       OutputBox->SetText(FText::FromString(TEXT("(no run yet)")));
    RebuildParamUI();
}

void SSliverDetailPanel::RebuildParamUI()
{
    if (!ParamBox.IsValid()) return;
    ParamBox->ClearChildren();
    ParamWidgets.Reset();

    for (const FHaybaSliverParam& P : Spec.Params)
    {
        TSharedRef<SSliverParamWidget> W = FSliverParamWidgetRegistry::Get().Create(P);
        ParamWidgets.Add(W);

        const FString LabelText = (!P.Label.IsEmpty() ? P.Label : P.Id) + (P.bRequired ? TEXT(" *") : TEXT(""));
        ParamBox->AddSlot().AutoHeight().Padding(2)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(0.4f).VAlign(VAlign_Center)
            [ SNew(STextBlock).Text(FText::FromString(LabelText)) ]
            + SHorizontalBox::Slot().FillWidth(0.6f)
            [ W ]
        ];
    }
}

FString SSliverDetailPanel::BuildParamsJson() const
{
    TArray<FString> Parts;
    for (const TSharedRef<SSliverParamWidget>& W : ParamWidgets)
    {
        const FString Id = W->GetParam().Id;
        FString Esc = Id; Esc.ReplaceInline(TEXT("\""), TEXT("\\\""));
        Parts.Add(FString::Printf(TEXT("\"%s\":%s"), *Esc, *W->GetValueAsJson()));
    }
    return TEXT("{") + FString::Join(Parts, TEXT(",")) + TEXT("}");
}

FReply SSliverDetailPanel::OnRunClicked()
{
    if (bRunning) return FReply::Handled();
    bRunning = true;
    if (OutputBox) OutputBox->SetText(FText::FromString(TEXT("(running…)")));

    const UHaybaSliverSettings* S = UHaybaSliverSettings::GetChecked();
    const FString BaseUrl = S->McpHttpBaseUrl;
    const FString Id = Spec.Id;
    const FString ParamsJson = BuildParamsJson();

    FHaybaSliverRunCallback OnDone = FHaybaSliverRunCallback::CreateLambda(
        [this](bool bOk, const FString& Body)
        {
            AsyncTask(ENamedThreads::GameThread, [this, bOk, Body]()
            {
                bRunning = false;
                if (OutputBox)
                {
                    OutputBox->SetText(FText::FromString(bOk ? Body : (TEXT("HTTP error:\n") + Body)));
                }
            });
        });

    FHaybaSliverClient::RunSliver(BaseUrl, Id, ParamsJson, OnDone);
    return FReply::Handled();
}
```

- [ ] **Step 3: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverDetailPanel.h \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliverDetailPanel.cpp
git commit -m "feat(slivers): SSliverDetailPanel — params, Run, output"
```

---

### Task 13: UE — `SSliversPanel` (list + detail split) + tab registration

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliversPanel.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliversPanel.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverTabRegistration.cpp`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp` (call `HaybaSliver_RegisterTab` + `HaybaSliver_RegisterBuiltinParamWidgets` on StartupModule, unregister on ShutdownModule)

- [ ] **Step 1: SSliversPanel header**

```cpp
// SSliversPanel.h — Top-level Slate panel: list of installed slivers
// on the left, SSliverDetailPanel on the right.

#pragma once

#include "CoreMinimal.h"
#include "Slivers/HaybaSliverLoader.h"
#include "Slivers/SSliverDetailPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"

class SSliversPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SSliversPanel) {}
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);

private:
    FHaybaSliverLoader Loader;
    TArray<TSharedPtr<FHaybaSliverSpec>> ListItems;
    TSharedPtr<SListView<TSharedPtr<FHaybaSliverSpec>>> ListView;
    TSharedPtr<SSliverDetailPanel> DetailPanel;

    void Refresh();
    FReply OnRefreshClicked() { Refresh(); return FReply::Handled(); }
    TSharedRef<ITableRow> OnGenerateRow(TSharedPtr<FHaybaSliverSpec> Item, const TSharedRef<STableViewBase>& Owner);
    void OnSelectionChanged(TSharedPtr<FHaybaSliverSpec> Item, ESelectInfo::Type);
};
```

- [ ] **Step 2: SSliversPanel implementation**

```cpp
// SSliversPanel.cpp
#include "Slivers/SSliversPanel.h"

#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Views/STableRow.h"

void SSliversPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(2)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Refresh")))
                .OnClicked(this, &SSliversPanel::OnRefreshClicked)
            ]
            + SHorizontalBox::Slot().FillWidth(1.0f).VAlign(VAlign_Center).Padding(8, 0)
            [
                SNew(STextBlock).Text(FText::FromString(TEXT("Slivers (deterministic abstractions)")))
            ]
        ]
        + SVerticalBox::Slot().FillHeight(1.0f)
        [
            SNew(SSplitter)
            + SSplitter::Slot().Value(0.3f)
            [
                SAssignNew(ListView, SListView<TSharedPtr<FHaybaSliverSpec>>)
                .ListItemsSource(&ListItems)
                .OnGenerateRow(this, &SSliversPanel::OnGenerateRow)
                .OnSelectionChanged(this, &SSliversPanel::OnSelectionChanged)
                .SelectionMode(ESelectionMode::Single)
            ]
            + SSplitter::Slot().Value(0.7f)
            [
                SAssignNew(DetailPanel, SSliverDetailPanel)
            ]
        ]
    ];

    Refresh();
}

void SSliversPanel::Refresh()
{
    Loader.Refresh(FHaybaSliverLoader::DefaultUserSliversDir());
    ListItems.Reset();
    for (const FHaybaSliverSpec& S : Loader.List())
        ListItems.Add(MakeShared<FHaybaSliverSpec>(S));
    if (ListView) ListView->RequestListRefresh();
}

TSharedRef<ITableRow> SSliversPanel::OnGenerateRow(TSharedPtr<FHaybaSliverSpec> Item, const TSharedRef<STableViewBase>& Owner)
{
    const FString DisplayText = Item.IsValid()
        ? FString::Printf(TEXT("%s   [%s]"), *Item->Title, *Item->Category)
        : FString();
    return SNew(STableRow<TSharedPtr<FHaybaSliverSpec>>, Owner)
        [ SNew(STextBlock).Text(FText::FromString(DisplayText)) ];
}

void SSliversPanel::OnSelectionChanged(TSharedPtr<FHaybaSliverSpec> Item, ESelectInfo::Type)
{
    if (Item.IsValid() && DetailPanel) DetailPanel->SetSpec(*Item);
}
```

- [ ] **Step 3: Tab registration**

```cpp
// HaybaSliverTabRegistration.cpp — Registers the Slivers nomad tab and
// the Window menu entry. Public callable: HaybaSliver_RegisterTab() /
// HaybaSliver_UnregisterTab().

#include "Slivers/SSliversPanel.h"

#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "Widgets/Docking/SDockTab.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"

static const FName SliversTabName(TEXT("HaybaSlivers"));

static TSharedRef<SDockTab> SpawnSliversTab(const FSpawnTabArgs&)
{
    return SNew(SDockTab)
        .TabRole(ETabRole::NomadTab)
        .Label(NSLOCTEXT("HaybaSlivers", "TabLabel", "Slivers"))
        [
            SNew(SSliversPanel)
        ];
}

void HaybaSliver_RegisterTab()
{
    FGlobalTabmanager::Get()->RegisterNomadTabSpawner(SliversTabName, FOnSpawnTab::CreateStatic(&SpawnSliversTab))
        .SetDisplayName(NSLOCTEXT("HaybaSlivers", "TabTitle", "Slivers"))
        .SetTooltipText(NSLOCTEXT("HaybaSlivers", "TabTooltip", "Hayba Slivers — deterministic abstractions"))
        .SetGroup(WorkspaceMenu::GetMenuStructure().GetToolsCategory());
}

void HaybaSliver_UnregisterTab()
{
    if (FSlateApplication::IsInitialized())
        FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(SliversTabName);
}
```

- [ ] **Step 4: Wire startup/shutdown in `HaybaMCPModule.cpp`**

Read `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp`. Find `StartupModule()` and `ShutdownModule()`. At the bottom of `StartupModule`, add:

```cpp
extern void HaybaSliver_RegisterTab();
extern void HaybaSliver_RegisterBuiltinParamWidgets();
HaybaSliver_RegisterBuiltinParamWidgets();
HaybaSliver_RegisterTab();
```

At the top of `ShutdownModule`, add:

```cpp
extern void HaybaSliver_UnregisterTab();
HaybaSliver_UnregisterTab();
```

- [ ] **Step 5: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliversPanel.h \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/SSliversPanel.cpp \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/HaybaSliverTabRegistration.cpp \
        unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp
git commit -m "feat(slivers): SSliversPanel + Window → Slivers tab registration"
```

---

### Task 14: End-to-end smoke verification

**Files:** none (manual verification — record results in PR description)

- [ ] **Step 1: TS-side smoke**

```bash
cd mcp-tools/hayba-mcp && npm run build:server
node dist/index.js &
sleep 1
curl -s http://127.0.0.1:3091/sliver/list
curl -s -X POST http://127.0.0.1:3091/sliver/run \
  -H 'content-type: application/json' \
  -d '{"id":"com.hayba.composition.frame_target","params":{"target":"/Game/X.X","distance":12,"height":1.5,"fov":60,"yaw_deg":30}}'
kill %1
```

Expect: list returns frame_target; run returns `"ok":true` with a `camera_transform`.

- [ ] **Step 2: UE-side smoke (manual, requires the user)**

Document the steps in the PR body for the user to perform:

1. Open Unreal Editor on the live geoforge project. When prompted "Modules out of date, rebuild?" — click Yes.
2. Start the MCP server (it must be running for the panel to talk to it): the user runs Claude Code as normal, which spawns `hayba-mcp`.
3. In the editor: `Window → Slivers`. The Slivers panel appears as a dock tab.
4. The left list shows `Frame Target  [composition]`. Click it.
5. The right pane shows: title, description, five labelled rows (target text+button, distance spinner, height spinner, fov spinner, yaw_deg spinner).
6. Pick any actor in the level → click "Pick from selection" → the `target` text field fills with its path.
7. Drag the `distance` spinner to 15. Drag `yaw_deg` to 90.
8. Click Run. The output text box shows the JSON response (`ok: true`, `camera_transform.location` approximately `[0, 1500, 200]`, `fov: 70`).

- [ ] **Step 3: Commit nothing** (manual verification — no diff)

---

### Task 15: Push branch + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/slivers-b-ue-ui
```

(Create the branch before any code work: `git checkout -b feat/slivers-b-ue-ui` from main or from the merged Plan A tip.)

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --head feat/slivers-b-ue-ui \
  --title "Slivers v1 plan B: UE Slivers tab + HTTP routes" \
  --body "$(cat <<'EOF'
## Summary
- New Slate dockable tab `Window → Slivers` listing every installed sliver and rendering its param widgets.
- Six param widgets shipped: Float, Int, Bool, String, Enum, ActorRef (covers frame_target and the time_of_day to-be-shipped in Plan C).
- New MCP-server HTTP endpoint on 127.0.0.1:3091 with /sliver/{list,get,run,import}; UE plugin posts to /sliver/run.
- C++-side sliver spec parser + loader + HTTP client wired in.
- UHaybaSliverSettings (Project Settings → Plugins → Hayba Slivers) for the MCP URL + RunMode + MaxSliverDepth.

Implements Plan B of the Slivers v1 spec
(docs/superpowers/specs/2026-05-21-slivers-design.md). Builds on Plan A
(#217). Plan C (time_of_day + lighting handler) is next.

## Scope cuts deferred to v2
- AutoDebounced run mode (Manual only in v1)
- Save preset
- Rich output preview (raw JSON in v1)
- Vector3 / Color / Transform / AssetRef widgets
- Live disk-watcher (manual Refresh button only)

## Test plan
- [x] vitest src/http/sliver-routes.test.ts — 6/6 green
- [x] node dist/index.js starts the HTTP listener on 127.0.0.1:3091
- [x] curl /sliver/list returns frame_target
- [x] curl /sliver/run returns ok:true with camera_transform
- [ ] Editor rebuilds modules cleanly on first launch
- [ ] Window → Slivers opens the panel
- [ ] Clicking Frame Target shows 5 param widgets
- [ ] Pick from selection fills the target field
- [ ] Run posts to the MCP server and shows the JSON response
EOF
)"
```

Expected: PR URL printed.

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| UE plugin Slivers tab | Tasks 12, 13 |
| Left rail grouped (by category) | Task 13 lists by title + category column; full grouping deferred |
| Generic widget renderer per `params[]` | Tasks 8-11 (factory + 6 widgets) |
| Per-project settings (`SliverRunMode`, `MaxSliverDepth`) | Task 4 |
| Save preset → sibling `.preset.json` | Deferred (documented) |
| MCP execution path | Tasks 1-2 (HTTP routes) + Task 7 (UE client) + Task 12 (Run button wiring) |
| actor_ref scene picker | Task 10 ("Pick from selection" simplified) |
| asset_ref Content Browser picker | Deferred |

**Out-of-scope items correctly deferred:**
- Vector3 / Color / Transform / AssetRef widgets (post-mortem #1 + future slivers will need them — v2)
- AutoDebounced run mode (needs FTSTicker + a debounce primitive — small but additive)
- Live disk watcher (FDirectoryWatcher; nice-to-have, not blocker)
- Output rich preview (per-sliver result type; v2 builds on JSON)

**Placeholder scan:** Every code step contains the actual code, every command has expected output, no TBDs.

**Type consistency:** `EHaybaSliverParamType` enum values match the JSON `type` strings (`float` / `int` / etc.) consistently from parser (Task 5) through factory keys (Task 8) through registrations (Task 11). `GetValueAsJson()` is the same virtual signature across all six widget tasks. `UHaybaSliverSettings::McpHttpBaseUrl` is the single source consumed by `SSliverDetailPanel::OnRunClicked` via `FHaybaSliverClient::RunSliver`.

**Cross-plan consistency:** All routes added in Tasks 1-2 are read by URLs Tasks 7+12 use. The bundled `frame_target` spec from Plan A is what the loader (Task 6) finds and the panel (Task 13) lists.
