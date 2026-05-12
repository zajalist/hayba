# HaybaOS UE Plugin Expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `HaybaMCPToolkit` from ~11 PCG/landscape commands into the full 34-domain HaybaOS command surface (actor, level, asset, blueprint, material, editor, scene graph, python, foliage/spline/WP, swarm, visual sidecar, workflow skills).

**Architecture:** Domain-partitioned C++ handlers behind a thin router. `FHaybaMCPResponseBuilder` enforces output trimming. Capability token auth + execution journaling at C++ TCP layer. Rate limiting + ToolCaching + HaybaToolMeta at Node.js MCP layer. Optional `uv`-managed Python visual sidecar on `localhost:7821` (CLIP / SpatialCLIP / OWLViT). 5 configurable swarm agents share a SQLite memory.

**Tech Stack:** UE5 C++, TypeScript/Node.js (MCP), Python 3.10+ (uv, FastAPI, open-clip-torch, transformers), SQLite (`better-sqlite3`), `lru-cache`, `zod`.

---

## File Structure

### C++ Plugin (`packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/`)

**Modify:**
- `Private/HaybaMCPCommandHandler.cpp` / `.h` — refactor into thin router
- `Private/HaybaMCPModule.cpp` — register all handlers at startup
- `Private/HaybaMCPSettings.h` / `.cpp` — add new config fields
- `HaybaMCPToolkit.Build.cs` — add module dependencies

**Create — Foundation:**
- `Private/HaybaMCPResponseBuilder.h` / `.cpp`
- `Private/HaybaMCPSecurityManager.h` / `.cpp`
- `Private/HaybaMCPCaptureActor.h` / `.cpp`
- `Private/IHaybaMCPHandler.h` (handler interface)

**Create — Domain handlers (`Private/handlers/`):**
- `HaybaMCPActorHandler.{h,cpp}`
- `HaybaMCPLevelHandler.{h,cpp}`
- `HaybaMCPAssetHandler.{h,cpp}`
- `HaybaMCPBlueprintHandler.{h,cpp}`
- `HaybaMCPMaterialHandler.{h,cpp}`
- `HaybaMCPEditorHandler.{h,cpp}`
- `HaybaMCPSceneGraphHandler.{h,cpp}`
- `HaybaMCPPythonHandler.{h,cpp}`
- `HaybaMCPDocsHandler.{h,cpp}`
- `HaybaMCPFoliageHandler.{h,cpp}`
- `HaybaMCPSplineHandler.{h,cpp}`
- `HaybaMCPWorldPartitionHandler.{h,cpp}`
- `HaybaMCPISMHandler.{h,cpp}`
- `HaybaMCPPhysicsHandler.{h,cpp}`
- `HaybaMCPLegacyHandler.{h,cpp}` (PCG/Landscape/Conventions/Wizard migrated commands)
- Stub handlers for: `Sequencer`, `Animation`, `Niagara`, `Audio`, `MetaSound`, `GAS`, `BehaviorTree`, `Input`, `UI`, `Network`, `StaticMesh`, `Texture`, `DataAsset`, `Project`, `Build`, `Test`

### Node.js MCP layer (`packages/hayba/src/`)

**Modify:**
- `config.ts` — add new fields
- `gaea/swarmhost.ts` — load `hayba.agents.json`, wire SQLite memory, add `stream_log`

**Create:**
- `tools/hayba-tool-meta.ts` — HaybaToolMeta interface
- `tools/hayba-rate-limiter.ts` — sliding-window rate limit
- `tools/hayba-tool-cache.ts` — lru-cache wrapper
- `tools/code-mode/list-tool-categories.ts`
- `tools/code-mode/get-tool-signature.ts`
- `tools/actor/{actor-spawn,actor-delete,actor-transform,actor-list}.ts`
- `tools/scene/{scene-export,scene-validate-physics}.ts`
- `tools/editor/{editor-capture-viewport,editor-start-pie}.ts`
- `tools/python/python-run.ts`
- `tools/visual/{hayba-generate-moodboard,hayba-fetch-references,hayba-compare-clip-score}.ts`
- `gaea/memory/hayba-memory.ts` — SQLite collaborative memory wrapper

### Visual sidecar (`packages/hayba/addons/visual-embeddings/`)

- `pyproject.toml`
- `src/hayba_sidecar/server.py`
- `src/hayba_sidecar/models/{clip_model,spatial_clip,owl_vit}.py`
- `README.md`

### Workflow skills (`packages/hayba/addons/workflows/`)

- `hayba-new-scene/SKILL.md`
- `hayba-refine-scene/SKILL.md`
- `hayba-debug-level/SKILL.md`
- `hayba-pcg-build/SKILL.md`

### Project root

- `packages/hayba/hayba.agents.json` — 5 archetypes
- `packages/hayba/HaybaMCPToolkit.uplugin` — version bump

---

## Implementation Notes for Workers

- **C++ "tests":** UE doesn't have a fast unit-test feedback loop usable from a plan. For each handler, the verification step is: build the plugin, restart UE editor, send a sample TCP JSON command via `Test-NetConnection` or the included `scripts/tcp-probe.ps1`, and verify response in editor Output Log + JSON shape.
- **TS tests:** standard `vitest` — every Node.js task has a real RED → GREEN → REFACTOR cycle.
- **Commit cadence:** commit after every passing test.
- **Backwards compatibility:** legacy command names (`ping`, `list_node_classes`, etc.) MUST keep working through 0.x. New names are aliases.

---

## Task 1: FHaybaMCPResponseBuilder

**Files:**
- Create: `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPResponseBuilder.h`
- Create: `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPResponseBuilder.cpp`

- [ ] **Step 1: Write the header**

```cpp
// HaybaMCPResponseBuilder.h
#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

struct FHaybaResponseLimits
{
    int32 MaxArrayItems = 50;
    int32 MaxStringChars = 512;
    int32 MaxTopLevelFields = 20;
};

class FHaybaMCPResponseBuilder
{
public:
    explicit FHaybaMCPResponseBuilder(const FHaybaResponseLimits& InLimits = FHaybaResponseLimits());

    /** Trim string in place, returning whether trimmed. */
    bool TrimString(FString& InOutValue) const;

    /** Trim array in place, returning number of items removed. */
    int32 TrimArray(TArray<TSharedPtr<FJsonValue>>& InOutItems) const;

    /** Recursively walk and trim a JSON object, marking truncations under `_truncated`. */
    TSharedRef<FJsonObject> Build(const TSharedRef<FJsonObject>& Source) const;

    /** Convenience: serialize to compact string. */
    FString Serialize(const TSharedRef<FJsonObject>& Source) const;

private:
    FHaybaResponseLimits Limits;
};
```

- [ ] **Step 2: Write the implementation**

```cpp
// HaybaMCPResponseBuilder.cpp
#include "HaybaMCPResponseBuilder.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

FHaybaMCPResponseBuilder::FHaybaMCPResponseBuilder(const FHaybaResponseLimits& InLimits)
    : Limits(InLimits) {}

bool FHaybaMCPResponseBuilder::TrimString(FString& V) const
{
    if (V.Len() <= Limits.MaxStringChars) return false;
    V = V.Left(Limits.MaxStringChars - 3) + TEXT("...");
    return true;
}

int32 FHaybaMCPResponseBuilder::TrimArray(TArray<TSharedPtr<FJsonValue>>& Items) const
{
    if (Items.Num() <= Limits.MaxArrayItems) return 0;
    const int32 Removed = Items.Num() - Limits.MaxArrayItems;
    Items.SetNum(Limits.MaxArrayItems);
    return Removed;
}

static void RecursiveTrim(TSharedRef<FJsonObject> Obj, const FHaybaResponseLimits& L, TArray<FString>& Truncated)
{
    if (Obj->Values.Num() > L.MaxTopLevelFields) {
        // Cap top-level fields, prefer keys present (no removal here — caller decides)
    }
    for (auto& Pair : Obj->Values)
    {
        if (!Pair.Value.IsValid()) continue;
        if (Pair.Value->Type == EJson::String)
        {
            FString S = Pair.Value->AsString();
            if (S.Len() > L.MaxStringChars) {
                S = S.Left(L.MaxStringChars - 3) + TEXT("...");
                Pair.Value = MakeShared<FJsonValueString>(S);
                Truncated.Add(Pair.Key);
            }
        }
        else if (Pair.Value->Type == EJson::Array)
        {
            TArray<TSharedPtr<FJsonValue>> Arr = Pair.Value->AsArray();
            if (Arr.Num() > L.MaxArrayItems) {
                Arr.SetNum(L.MaxArrayItems);
                Truncated.Add(Pair.Key);
            }
            for (auto& V : Arr) {
                if (V.IsValid() && V->Type == EJson::Object) {
                    RecursiveTrim(V->AsObject().ToSharedRef(), L, Truncated);
                }
            }
            Pair.Value = MakeShared<FJsonValueArray>(Arr);
        }
        else if (Pair.Value->Type == EJson::Object)
        {
            RecursiveTrim(Pair.Value->AsObject().ToSharedRef(), L, Truncated);
        }
    }
}

TSharedRef<FJsonObject> FHaybaMCPResponseBuilder::Build(const TSharedRef<FJsonObject>& Source) const
{
    TArray<FString> Truncated;
    RecursiveTrim(Source, Limits, Truncated);
    if (Truncated.Num() > 0) {
        TArray<TSharedPtr<FJsonValue>> Arr;
        for (const FString& K : Truncated) Arr.Add(MakeShared<FJsonValueString>(K));
        Source->SetArrayField(TEXT("_truncated"), Arr);
    }
    return Source;
}

FString FHaybaMCPResponseBuilder::Serialize(const TSharedRef<FJsonObject>& Source) const
{
    FString Out;
    auto Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
    FJsonSerializer::Serialize(Build(Source), Writer);
    return Out;
}
```

- [ ] **Step 3: Build the plugin**

Run: `pwsh scripts/build-plugin.ps1` (or rebuild in UE editor). Expected: clean build.

- [ ] **Step 4: Smoke test in editor console**

Manual: open UE editor, in Output Log run `Hayba.TestResponseBuilder` (a temporary `UE_LOG` you add inside `FHaybaMCPModule::StartupModule` that builds an oversized object and logs the trimmed length). Expected: log shows `_truncated: ["foo"]` and array length capped at 50.

- [ ] **Step 5: Commit**

```bash
git add packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPResponseBuilder.*
git commit -m "feat(ue): add FHaybaMCPResponseBuilder for output trimming (max 50 items, 512 chars)"
```

---

## Task 2: FHaybaMCPSecurityManager (cap token + journal)

**Files:**
- Create: `Private/HaybaMCPSecurityManager.h` / `.cpp`
- Modify: `Private/HaybaMCPSettings.h` — add `CapabilityToken` (FString, hidden), `EnableExecutionJournal` (bool, default true)

- [ ] **Step 1: Header**

```cpp
// HaybaMCPSecurityManager.h
#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

struct FHaybaJournalEntry
{
    FDateTime Timestamp;
    FString Command;
    FString ParamsHash;
    int64 DurationMs;
    bool bOk;
    FString ErrorMessage;
};

class FHaybaMCPSecurityManager
{
public:
    static FHaybaMCPSecurityManager& Get();

    /** Validate `auth` field on incoming TCP request against configured token. */
    bool ValidateRequest(const TSharedPtr<FJsonObject>& Request, FString& OutReason) const;

    /** Append a journal entry to hayba-execution.log in project Saved dir. */
    void Journal(const FHaybaJournalEntry& Entry);

    /** Compute SHA-256 hex of params object for journal. */
    static FString HashParams(const TSharedPtr<FJsonObject>& Params);

private:
    FHaybaMCPSecurityManager() = default;
    mutable FCriticalSection JournalLock;
};
```

- [ ] **Step 2: Implementation**

```cpp
// HaybaMCPSecurityManager.cpp
#include "HaybaMCPSecurityManager.h"
#include "HaybaMCPSettings.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Misc/SecureHash.h"
#include "Serialization/JsonSerializer.h"

FHaybaMCPSecurityManager& FHaybaMCPSecurityManager::Get()
{
    static FHaybaMCPSecurityManager Instance;
    return Instance;
}

bool FHaybaMCPSecurityManager::ValidateRequest(const TSharedPtr<FJsonObject>& Request, FString& OutReason) const
{
    const UHaybaMCPSettings* Settings = GetDefault<UHaybaMCPSettings>();
    if (Settings->CapabilityToken.IsEmpty()) return true; // auth disabled
    FString Provided;
    if (!Request->TryGetStringField(TEXT("auth"), Provided)) {
        OutReason = TEXT("Missing auth token");
        return false;
    }
    if (Provided != Settings->CapabilityToken) {
        OutReason = TEXT("Invalid auth token");
        return false;
    }
    return true;
}

FString FHaybaMCPSecurityManager::HashParams(const TSharedPtr<FJsonObject>& Params)
{
    if (!Params.IsValid()) return TEXT("");
    FString S;
    auto W = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&S);
    FJsonSerializer::Serialize(Params.ToSharedRef(), W);
    FSHAHash Hash;
    FSHA1::HashBuffer(TCHAR_TO_UTF8(*S), S.Len(), Hash.Hash);
    return Hash.ToString();
}

void FHaybaMCPSecurityManager::Journal(const FHaybaJournalEntry& E)
{
    const UHaybaMCPSettings* Settings = GetDefault<UHaybaMCPSettings>();
    if (!Settings->bEnableExecutionJournal) return;
    const FString Path = FPaths::ProjectSavedDir() / TEXT("hayba-execution.log");
    const FString Line = FString::Printf(
        TEXT("%s\t%s\t%s\t%lld\t%s\t%s\n"),
        *E.Timestamp.ToIso8601(),
        *E.Command,
        *E.ParamsHash,
        E.DurationMs,
        E.bOk ? TEXT("ok") : TEXT("err"),
        *E.ErrorMessage);
    FScopeLock Lock(&JournalLock);
    FFileHelper::SaveStringToFile(Line, *Path,
        FFileHelper::EEncodingOptions::ForceUTF8, &IFileManager::Get(),
        FILEWRITE_Append);
}
```

- [ ] **Step 3: Add settings fields**

In `HaybaMCPSettings.h`:
```cpp
UPROPERTY(EditAnywhere, Config, Category="Security",
    meta=(DisplayName="Capability Token", PasswordField=true))
FString CapabilityToken;

UPROPERTY(EditAnywhere, Config, Category="Security")
bool bEnableExecutionJournal = true;
```

- [ ] **Step 4: Build + manual test**

Build plugin. Set token in plugin settings. Send TCP request without auth — expect `{"ok":false,"error":"Missing auth token"}`. Send with correct token — expect normal response. Verify `Saved/hayba-execution.log` has new lines.

- [ ] **Step 5: Commit**

```bash
git add packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSecurityManager.* packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSettings.*
git commit -m "feat(ue): add FHaybaMCPSecurityManager with cap-token auth + execution journal"
```

---

## Task 3: Router refactor + IHaybaMCPHandler interface

**Files:**
- Create: `Private/IHaybaMCPHandler.h`
- Create: `Private/handlers/HaybaMCPLegacyHandler.h` / `.cpp`
- Modify: `Private/HaybaMCPCommandHandler.h` / `.cpp`
- Modify: `Private/HaybaMCPModule.cpp`

- [ ] **Step 1: Handler interface**

```cpp
// IHaybaMCPHandler.h
#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class IHaybaMCPHandler
{
public:
    virtual ~IHaybaMCPHandler() = default;

    /** Domain prefix, e.g. "actor", "scene", "pcg". */
    virtual FString GetDomain() const = 0;

    /** Commands handled by this domain (full names like "actor_spawn"). */
    virtual TArray<FString> GetCommands() const = 0;

    /** Dispatch a parsed command. Returns the JSON object payload (not yet response-trimmed). */
    virtual TSharedRef<FJsonObject> Handle(const FString& Command,
                                           const TSharedPtr<FJsonObject>& Params) = 0;
};
```

- [ ] **Step 2: Move all existing 11 commands into FHaybaMCPLegacyHandler**

Create `handlers/HaybaMCPLegacyHandler.{h,cpp}` and migrate the existing `Cmd_Ping`, `Cmd_ListNodeClasses`, `Cmd_GetNodeDetails`, `Cmd_ListPCGAssets`, `Cmd_ExportGraph`, `Cmd_CreateGraph`, `Cmd_ValidateGraph`, `Cmd_ExecuteGraph`, `Cmd_WizardChat`, `Cmd_ImportLandscape`, `Cmd_ReadNodeOutput` verbatim. The legacy handler reports them under both legacy names and namespaced aliases (e.g. `pcg_list_assets`).

```cpp
// handlers/HaybaMCPLegacyHandler.h
#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPLegacyHandler : public IHaybaMCPHandler
{
public:
    FHaybaMCPLegacyHandler();
    virtual FString GetDomain() const override { return TEXT("legacy"); }
    virtual TArray<FString> GetCommands() const override { return Commands; }
    virtual TSharedRef<FJsonObject> Handle(const FString& Cmd,
        const TSharedPtr<FJsonObject>& Params) override;
private:
    TArray<FString> Commands;
    // ... existing Cmd_* methods, returning TSharedRef<FJsonObject> instead of FString
};
```

`Handle()` switches on the command name, normalising legacy → new aliases:
```cpp
TSharedRef<FJsonObject> FHaybaMCPLegacyHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    static const TMap<FString, FString> Aliases = {
        {TEXT("ping"), TEXT("ping")},
        {TEXT("list_node_classes"), TEXT("pcg_list_node_classes")},
        {TEXT("get_node_details"), TEXT("pcg_get_node_details")},
        {TEXT("list_pcg_assets"), TEXT("pcg_list_assets")},
        {TEXT("export_graph"), TEXT("pcg_export_graph")},
        {TEXT("create_graph"), TEXT("pcg_create_graph")},
        {TEXT("validate_graph"), TEXT("pcg_validate_graph")},
        {TEXT("execute_graph"), TEXT("pcg_execute_graph")},
        {TEXT("wizard_chat"), TEXT("wizard_chat")},
        {TEXT("import_landscape"), TEXT("landscape_import")},
        {TEXT("read_node_output"), TEXT("pcg_read_node_output")},
    };
    const FString* Canon = Aliases.Find(Cmd);
    const FString Name = Canon ? *Canon : Cmd;
    if (Name == TEXT("ping")) return Ping(P);
    if (Name == TEXT("pcg_list_node_classes")) return ListNodeClasses(P);
    // ... etc
    return MakeShared<FJsonObject>(); // shouldn't reach
}
```

- [ ] **Step 3: Refactor CommandHandler into router**

```cpp
// HaybaMCPCommandHandler.h
#pragma once
#include "CoreMinimal.h"
#include "IHaybaMCPHandler.h"
#include "HaybaMCPResponseBuilder.h"

class FHaybaMCPCommandHandler
{
public:
    FHaybaMCPCommandHandler();

    /** Register a handler for its domain. */
    void RegisterHandler(TSharedRef<IHaybaMCPHandler> Handler);

    /** Process raw incoming JSON line, return raw outgoing JSON line. */
    FString ProcessCommand(const FString& CommandJson);

    /** Used by Code Mode meta tools. */
    TArray<FString> ListAllCommands() const;

private:
    TMap<FString, TSharedRef<IHaybaMCPHandler>> CommandToHandler;
    TArray<TSharedRef<IHaybaMCPHandler>> Handlers;
    FHaybaMCPResponseBuilder Builder;

    static FString MakeError(const FString& Id, const FString& Reason);
};
```

```cpp
// HaybaMCPCommandHandler.cpp (key methods)
void FHaybaMCPCommandHandler::RegisterHandler(TSharedRef<IHaybaMCPHandler> H)
{
    Handlers.Add(H);
    for (const FString& Cmd : H->GetCommands())
    {
        CommandToHandler.Add(Cmd, H);
    }
}

FString FHaybaMCPCommandHandler::ProcessCommand(const FString& CommandJson)
{
    TSharedPtr<FJsonObject> Parsed;
    auto Reader = TJsonReaderFactory<>::Create(CommandJson);
    if (!FJsonSerializer::Deserialize(Reader, Parsed) || !Parsed.IsValid())
        return MakeError(TEXT(""), TEXT("Invalid JSON"));

    const FString Cmd = Parsed->GetStringField(TEXT("cmd"));
    const FString Id = Parsed->GetStringField(TEXT("id"));
    TSharedPtr<FJsonObject> Params = Parsed->GetObjectField(TEXT("params"));
    if (!Params.IsValid()) Params = MakeShared<FJsonObject>();

    FString AuthReason;
    if (!FHaybaMCPSecurityManager::Get().ValidateRequest(Parsed, AuthReason))
        return MakeError(Id, AuthReason);

    auto* Found = CommandToHandler.Find(Cmd);
    if (!Found) return MakeError(Id, FString::Printf(TEXT("Unknown command: %s"), *Cmd));

    const double Start = FPlatformTime::Seconds();
    TSharedRef<FJsonObject> Result = (*Found)->Handle(Cmd, Params);
    const int64 DurMs = (int64)((FPlatformTime::Seconds() - Start) * 1000.0);

    FHaybaJournalEntry E;
    E.Timestamp = FDateTime::UtcNow();
    E.Command = Cmd;
    E.ParamsHash = FHaybaMCPSecurityManager::HashParams(Params);
    E.DurationMs = DurMs;
    E.bOk = !Result->HasField(TEXT("error"));
    if (!E.bOk) Result->TryGetStringField(TEXT("error"), E.ErrorMessage);
    FHaybaMCPSecurityManager::Get().Journal(E);

    Result->SetStringField(TEXT("id"), Id);
    Result->SetBoolField(TEXT("ok"), E.bOk);
    return Builder.Serialize(Result);
}
```

- [ ] **Step 4: Wire registration in Module startup**

```cpp
// HaybaMCPModule.cpp StartupModule()
CommandHandler = MakeShared<FHaybaMCPCommandHandler>();
CommandHandler->RegisterHandler(MakeShared<FHaybaMCPLegacyHandler>());
// (more handlers added in subsequent tasks)
```

- [ ] **Step 5: Build + smoke test all 11 legacy commands**

Send each existing command via TCP probe. Verify each returns a `{"ok":true,...}` shape identical to current behaviour. Verify legacy alias `import_landscape` AND new alias `landscape_import` both work.

- [ ] **Step 6: Commit**

```bash
git add packages/hayba/Plugins/HaybaMCPToolkit
git commit -m "refactor(ue): extract router + IHaybaMCPHandler, migrate 11 commands to FHaybaMCPLegacyHandler"
```

---

## Task 4: FHaybaMCPActorHandler

**Files:**
- Create: `Private/handlers/HaybaMCPActorHandler.h` / `.cpp`
- Modify: `Private/HaybaMCPModule.cpp` — register handler

- [ ] **Step 1: Header**

```cpp
// HaybaMCPActorHandler.h
#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPActorHandler : public IHaybaMCPHandler
{
public:
    FHaybaMCPActorHandler();
    virtual FString GetDomain() const override { return TEXT("actor"); }
    virtual TArray<FString> GetCommands() const override;
    virtual TSharedRef<FJsonObject> Handle(const FString& Cmd,
        const TSharedPtr<FJsonObject>& Params) override;
private:
    TSharedRef<FJsonObject> Spawn(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> Delete(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> Transform(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> List(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> GetProps(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> SetProps(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> Tag(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> SnapToSocket(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> Duplicate(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> SetVisibility(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> GetComponents(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> CallFunction(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> BatchSpawn(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> ValidatePlacement(const TSharedPtr<FJsonObject>& P);
};
```

- [ ] **Step 2: Implementation — actor_spawn (full)**

```cpp
// HaybaMCPActorHandler.cpp (excerpt)
#include "HaybaMCPActorHandler.h"
#include "Editor.h"
#include "EditorActorSubsystem.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"

TArray<FString> FHaybaMCPActorHandler::GetCommands() const
{
    return {
        TEXT("actor_spawn"), TEXT("actor_delete"), TEXT("actor_transform"),
        TEXT("actor_list"), TEXT("actor_get_properties"), TEXT("actor_set_properties"),
        TEXT("actor_tag"), TEXT("actor_snap_to_socket"), TEXT("actor_duplicate"),
        TEXT("actor_set_visibility"), TEXT("actor_get_components"),
        TEXT("actor_call_function"), TEXT("actor_batch_spawn"), TEXT("placement_validate"),
    };
}

TSharedRef<FJsonObject> FHaybaMCPActorHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("actor_spawn")) return Spawn(P);
    if (Cmd == TEXT("actor_delete")) return Delete(P);
    if (Cmd == TEXT("actor_transform")) return Transform(P);
    if (Cmd == TEXT("actor_list")) return List(P);
    if (Cmd == TEXT("actor_get_properties")) return GetProps(P);
    if (Cmd == TEXT("actor_set_properties")) return SetProps(P);
    if (Cmd == TEXT("actor_tag")) return Tag(P);
    if (Cmd == TEXT("actor_snap_to_socket")) return SnapToSocket(P);
    if (Cmd == TEXT("actor_duplicate")) return Duplicate(P);
    if (Cmd == TEXT("actor_set_visibility")) return SetVisibility(P);
    if (Cmd == TEXT("actor_get_components")) return GetComponents(P);
    if (Cmd == TEXT("actor_call_function")) return CallFunction(P);
    if (Cmd == TEXT("actor_batch_spawn")) return BatchSpawn(P);
    if (Cmd == TEXT("placement_validate")) return ValidatePlacement(P);
    auto Err = MakeShared<FJsonObject>();
    Err->SetStringField(TEXT("error"), FString::Printf(TEXT("Unhandled %s"), *Cmd));
    return Err;
}

TSharedRef<FJsonObject> FHaybaMCPActorHandler::Spawn(const TSharedPtr<FJsonObject>& P)
{
    FString ClassPath = P->GetStringField(TEXT("class_path"));
    UClass* Cls = LoadClass<AActor>(nullptr, *ClassPath);
    if (!Cls) {
        auto E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("error"), FString::Printf(TEXT("Class not found: %s"), *ClassPath));
        return E;
    }
    UEditorActorSubsystem* Sub = GEditor->GetEditorSubsystem<UEditorActorSubsystem>();
    FVector Loc(0, 0, 0); FRotator Rot(0, 0, 0); FVector Scale(1, 1, 1);
    const TArray<TSharedPtr<FJsonValue>>* LocArr;
    if (P->TryGetArrayField(TEXT("location"), LocArr) && LocArr->Num() == 3) {
        Loc.X = (*LocArr)[0]->AsNumber();
        Loc.Y = (*LocArr)[1]->AsNumber();
        Loc.Z = (*LocArr)[2]->AsNumber();
    }
    AActor* Spawned = Sub->SpawnActorFromClass(Cls, Loc, Rot);
    if (!Spawned) {
        auto E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("error"), TEXT("Spawn failed"));
        return E;
    }
    Spawned->SetActorScale3D(Scale);
    FString Label;
    if (P->TryGetStringField(TEXT("label"), Label)) Spawned->SetActorLabel(Label);

    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), Spawned->GetName());
    Out->SetStringField(TEXT("label"), Spawned->GetActorLabel());
    Out->SetStringField(TEXT("class"), Spawned->GetClass()->GetPathName());
    return Out;
}

TSharedRef<FJsonObject> FHaybaMCPActorHandler::List(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = GEditor->GetEditorWorldContext().World();
    auto Out = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Arr;
    int32 Count = 0;
    for (TActorIterator<AActor> It(World); It; ++It) {
        AActor* A = *It;
        if (A->ActorHasTag(FName(TEXT("HaybaMCPCaptureActor")))) continue;
        auto O = MakeShared<FJsonObject>();
        O->SetStringField(TEXT("id"), A->GetName());
        O->SetStringField(TEXT("label"), A->GetActorLabel());
        O->SetStringField(TEXT("class"), A->GetClass()->GetName());
        const FVector L = A->GetActorLocation();
        TArray<TSharedPtr<FJsonValue>> LocArr;
        LocArr.Add(MakeShared<FJsonValueNumber>(L.X));
        LocArr.Add(MakeShared<FJsonValueNumber>(L.Y));
        LocArr.Add(MakeShared<FJsonValueNumber>(L.Z));
        O->SetArrayField(TEXT("location"), LocArr);
        Arr.Add(MakeShared<FJsonValueObject>(O));
        if (++Count >= 500) break;
    }
    Out->SetArrayField(TEXT("actors"), Arr);
    Out->SetNumberField(TEXT("count"), Arr.Num());
    return Out;
}
```

(Implement remaining methods: `Delete` uses `EditorActorSubsystem::DestroyActor`; `Transform` uses `SetActorLocationAndRotation`; `Tag` uses `Tags.Add/Remove`; `SnapToSocket` finds skeletal mesh component and uses `AttachToComponent` with socket name; `Duplicate` uses `EditorActorSubsystem::DuplicateActor`; `SetVisibility` calls `SetActorHiddenInGame` + `SetIsTemporarilyHiddenInEditor`; `GetComponents` iterates `GetComponents()`; `BatchSpawn` loops `Spawn`; `ValidatePlacement` runs an overlap test via `World->OverlapMultiByObjectType`.)

- [ ] **Step 3: Register handler in module**

```cpp
// HaybaMCPModule.cpp StartupModule
CommandHandler->RegisterHandler(MakeShared<FHaybaMCPActorHandler>());
```

- [ ] **Step 4: Build + smoke test**

Send via TCP probe:
```json
{"cmd":"actor_list","id":"1"}
{"cmd":"actor_spawn","id":"2","params":{"class_path":"/Engine/BasicShapes/Cube.Cube_C","location":[0,0,200],"label":"TestCube"}}
{"cmd":"actor_transform","id":"3","params":{"actor_id":"TestCube","location":[100,0,200]}}
{"cmd":"actor_delete","id":"4","params":{"actor_id":"TestCube"}}
```
Expected: spawned cube visible in viewport, deleted on command 4.

- [ ] **Step 5: Commit**

```bash
git add packages/hayba/Plugins/HaybaMCPToolkit
git commit -m "feat(ue): add FHaybaMCPActorHandler — 14 actor_* commands"
```

---

## Task 5: FHaybaMCPLevelHandler

**Files:** `Private/handlers/HaybaMCPLevelHandler.{h,cpp}`

Commands (per spec §4.2): `level_load`, `level_save`, `level_list`, `level_get_info`, `level_get_spatial_index`, `level_create`, `level_set_bookmark`, `level_goto_bookmark`.

- [ ] **Step 1: Header** — same pattern as Task 4.

- [ ] **Step 2: `level_list`** — use `IAssetRegistry::Get().GetAssetsByClass(UWorld::StaticClass()->GetClassPathName(), Assets)` and return paths.

- [ ] **Step 3: `level_load`** — call `FEditorFileUtils::LoadMap(Path, /*LoadAsTemplate=*/false, /*bShowProgress=*/false)`.

- [ ] **Step 4: `level_save`** — `FEditorFileUtils::SaveCurrentLevel()`.

- [ ] **Step 5: `level_get_info`** — read `World->GetMapName()`, package path, actor count.

- [ ] **Step 6: `level_get_spatial_index`** — defer the heavy implementation to Task 6 (scene graph) but stub returning `{ "status":"deferred", "see":"scene_export" }`. Final implementation routes to scene graph handler's `BuildCognitiveMap()`.

- [ ] **Step 7: Bookmarks** — use `ULevelEditorViewportSettings` `EditorViewBookMarks`; `set_bookmark` saves current viewport transform under name; `goto_bookmark` restores.

- [ ] **Step 8: Register, build, test, commit.**

```bash
git commit -m "feat(ue): add FHaybaMCPLevelHandler — 8 level_* commands"
```

---

## Task 6: FHaybaMCPSceneGraphHandler (modes A/B/C + cognitive map + physics)

**Files:** `Private/handlers/HaybaMCPSceneGraphHandler.{h,cpp}`

Commands per spec §4.7 + §3.1, §3.2, §3.3: `scene_export`, `scene_validate_physics`, `scene_get_actor_relations`.

- [ ] **Step 1: Header** with mode enum.

```cpp
class FHaybaMCPSceneGraphHandler : public IHaybaMCPHandler
{
public:
    enum class EMode { Flat, Relational, Hierarchical };
    virtual FString GetDomain() const override { return TEXT("scene"); }
    virtual TArray<FString> GetCommands() const override {
        return { TEXT("scene_export"), TEXT("scene_validate_physics"), TEXT("scene_get_actor_relations") };
    }
    virtual TSharedRef<FJsonObject> Handle(const FString&, const TSharedPtr<FJsonObject>&) override;
private:
    TSharedRef<FJsonObject> Export(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> ValidatePhysics(const TSharedPtr<FJsonObject>& P);
    TSharedRef<FJsonObject> GetActorRelations(const TSharedPtr<FJsonObject>& P);
    static EMode ParseMode(const FString& S);
    static FBox ParseWindow(const TSharedPtr<FJsonObject>& P);
    static TArray<AActor*> CollectInWindow(UWorld* W, const FBox& Box, int32 MaxItems);
    static TSharedRef<FJsonObject> ActorToJson(AActor* A);
    static TSharedRef<FJsonObject> BuildFlat(const TArray<AActor*>&);
    static TSharedRef<FJsonObject> BuildRelational(const TArray<AActor*>&, bool bPhysicsRelations);
    static TSharedRef<FJsonObject> BuildHierarchical(const TArray<AActor*>&);
};
```

- [ ] **Step 2: Window collection + flat mode**

```cpp
TArray<AActor*> FHaybaMCPSceneGraphHandler::CollectInWindow(UWorld* W, const FBox& Box, int32 MaxItems)
{
    TArray<AActor*> Out;
    for (TActorIterator<AActor> It(W); It; ++It) {
        AActor* A = *It;
        if (A->ActorHasTag(FName(TEXT("HaybaMCPCaptureActor")))) continue;
        if (!Box.IsValid || Box.IsInside(A->GetActorLocation())) Out.Add(A);
        if (Out.Num() >= MaxItems) break;
    }
    return Out;
}
```

- [ ] **Step 3: Relational mode (default, k-NN)** — for each actor compute distance to nearest N (default 5), classify `adjacent_to` (<200uu), `near` (<2000uu), `far`. Build triplet array.

- [ ] **Step 4: Hierarchical mode** — group by World Partition cell (`UWorldPartition::GetActorContainer`), then by class-name semantic mapping (`BP_Tree_*` → "vegetation", `SM_Building_*` → "structure", `BP_NPC_*` → "npc").

- [ ] **Step 5: `scene_validate_physics`** — primary: `World->LineTraceSingleByChannel` from each actor centroid downward `2 * Bounds.BoxExtent.Z`; flag floating if no hit. `OverlapMultiByObjectType` for interpenetrating. If `deep_check: true`, return `{ "deep_check_required": true }` so the Node.js layer routes to sidecar.

- [ ] **Step 6: Cognitive map cache** — write JSON to `Saved/hayba-cognitive-map.json` with `{ cells: [...], clusters: [...], built_at: <ts> }`. Invalidate on any actor mutation (hook into `OnActorAdded`/`OnActorDeleted`).

- [ ] **Step 7: Register, build, test all 3 modes via TCP, commit.**

```bash
git commit -m "feat(ue): add FHaybaMCPSceneGraphHandler — modes A/B/C + cognitive map + physics validation"
```

---

## Task 7: HaybaMCPCaptureActor + FHaybaMCPEditorHandler

**Files:** `Private/HaybaMCPCaptureActor.{h,cpp}`, `Private/handlers/HaybaMCPEditorHandler.{h,cpp}`

Commands per §4.6: `editor_start_pie`, `editor_stop_pie`, `editor_set_camera`, `editor_capture_viewport`, `editor_run_console_command`, `editor_get_output_log`, `editor_stream_log`, `editor_live_compile`, `editor_get_performance_stats`, `editor_set_viewport_mode`.

- [ ] **Step 1: Capture actor**

```cpp
// HaybaMCPCaptureActor.h
#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Components/SceneCaptureComponent2D.h"
#include "HaybaMCPCaptureActor.generated.h"

UCLASS()
class AHaybaMCPCaptureActor : public AActor
{
    GENERATED_BODY()
public:
    AHaybaMCPCaptureActor();
    UPROPERTY(VisibleAnywhere) USceneCaptureComponent2D* Capture;
    UPROPERTY(VisibleAnywhere) UTextureRenderTarget2D* RT;

    /** Move to match active viewport, capture, return base64-encoded PNG. */
    FString CaptureToBase64(int32 Width = 1280, int32 Height = 720);
};
```

```cpp
// HaybaMCPCaptureActor.cpp
AHaybaMCPCaptureActor::AHaybaMCPCaptureActor()
{
    PrimaryActorTick.bCanEverTick = false;
    Capture = CreateDefaultSubobject<USceneCaptureComponent2D>(TEXT("Capture"));
    RootComponent = Capture;
    Capture->bCaptureEveryFrame = false;
    Capture->bCaptureOnMovement = false;
    Tags.Add(FName(TEXT("HaybaMCPCaptureActor")));
}

FString AHaybaMCPCaptureActor::CaptureToBase64(int32 W, int32 H)
{
    if (!RT) {
        RT = NewObject<UTextureRenderTarget2D>(this);
        RT->InitAutoFormat(W, H);
        RT->RenderTargetFormat = ETextureRenderTargetFormat::RTF_RGBA8;
        RT->UpdateResourceImmediate(true);
        Capture->TextureTarget = RT;
    }
    Capture->CaptureScene();
    TArray<FColor> Pixels;
    FTextureRenderTargetResource* Res = RT->GameThread_GetRenderTargetResource();
    Res->ReadPixels(Pixels);

    TArray<uint8> PNG;
    FImageUtils::ThumbnailCompressImageArray(W, H, Pixels, PNG);
    return FBase64::Encode(PNG);
}
```

- [ ] **Step 2: Module ensures one persistent CaptureActor exists**

In `FHaybaMCPModule::StartupModule()` after world is ready, find existing tagged actor or `World->SpawnActor<AHaybaMCPCaptureActor>()`.

- [ ] **Step 3: `editor_capture_viewport`** — get active viewport client camera transform, set capture actor transform, set `CustomProjectionMatrix` to viewport's, call `CaptureToBase64`, return `{ image_base64, width, height, camera: {...} }`.

- [ ] **Step 4: `editor_start_pie` / `editor_stop_pie`** — `GEditor->RequestPlaySession(...)`, `GEditor->RequestEndPlayMap()`.

- [ ] **Step 5: `editor_run_console_command`** — `GEngine->Exec(World, *Cmd)`.

- [ ] **Step 6: `editor_get_output_log`** — read `FOutputLogModule` recent lines (capped 200).

- [ ] **Step 7: `editor_stream_log`** — register a long-lived listener via `FOutputDevice` subclass; on each message matching filter, push to a per-session queue. Node.js polls via repeated `editor_stream_log` calls returning the queue tail.

- [ ] **Step 8: Register, build, test screenshot round-trip, commit.**

```bash
git commit -m "feat(ue): add HaybaMCPCaptureActor + FHaybaMCPEditorHandler — viewport capture + PIE control"
```

---

## Task 8: FHaybaMCPPythonHandler with 3-tier safety

**Files:** `Private/handlers/HaybaMCPPythonHandler.{h,cpp}`

Per spec §4.8.

- [ ] **Step 1: Tier classifier**

```cpp
enum class EPythonTier { ReadOnly = 1, Mutation = 2, Unsafe = 3 };

EPythonTier ClassifyScript(const FString& Code)
{
    static const TArray<FString> Tier3 = {
        TEXT("subprocess"), TEXT("os.system"), TEXT("os.popen"),
        TEXT("open("), TEXT("__import__"), TEXT("eval("),
        TEXT("compile("), TEXT("shutil"), TEXT("socket")
    };
    static const TArray<FString> Tier2 = {
        TEXT("spawn_actor"), TEXT("destroy_actor"), TEXT("set_property"),
        TEXT("create_asset"), TEXT("delete_asset"), TEXT(".save_"),
        TEXT("EditorAssetLibrary"), TEXT("EditorActorSubsystem")
    };
    for (const FString& K : Tier3) if (Code.Contains(K)) return EPythonTier::Unsafe;
    for (const FString& K : Tier2) if (Code.Contains(K)) return EPythonTier::Mutation;
    return EPythonTier::ReadOnly;
}
```

- [ ] **Step 2: `python_run` handler**

```cpp
TSharedRef<FJsonObject> Run(const TSharedPtr<FJsonObject>& P)
{
    FString Code = P->GetStringField(TEXT("script"));
    EPythonTier Tier = ClassifyScript(Code);
    const UHaybaMCPSettings* S = GetDefault<UHaybaMCPSettings>();
    if (Tier == EPythonTier::Unsafe && !S->bAllowUnsafePython) {
        auto E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("error"), TEXT("Tier 3 (filesystem/subprocess) blocked. Set AllowUnsafePython=true to override."));
        E->SetNumberField(TEXT("tier"), 3);
        return E;
    }
    IPythonScriptPlugin* Py = IPythonScriptPlugin::Get();
    FPythonCommandEx Cmd;
    Cmd.Command = Code;
    Cmd.ExecutionMode = EPythonCommandExecutionMode::ExecuteStatement;
    Cmd.Flags = EPythonCommandFlags::CaptureOutput;
    const bool bOk = Py->ExecPythonCommandEx(Cmd);
    auto Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), bOk);
    Out->SetNumberField(TEXT("tier"), (int32)Tier);
    Out->SetStringField(TEXT("stdout"), Cmd.CommandResult);
    return Out;
}
```

- [ ] **Step 3: Add `bAllowUnsafePython` setting** (default false).

- [ ] **Step 4: Register, build, test all 3 tiers via TCP, commit.**

```bash
git commit -m "feat(ue): add FHaybaMCPPythonHandler with 3-tier safety classification"
```

---

## Task 9: FHaybaMCPAssetHandler / BlueprintHandler / MaterialHandler

**Files:** Three handlers under `Private/handlers/`.

- [ ] **Step 1: `HaybaMCPAssetHandler`** — commands per §4.3.
  - `asset_search` — `FAssetRegistryModule::Get().GetAssetsByPath(...)` with name regex filter
  - `asset_get_info` — `IAssetRegistry::GetAssetByObjectPath`, return `tags`, `asset_class`, `package_name`
  - `asset_import` — `UAssetTools::ImportAssetTasks` with `UAutomatedAssetImportData`
  - `asset_duplicate` — `UEditorAssetLibrary::DuplicateAsset`
  - `asset_delete` — `UEditorAssetLibrary::DeleteAsset`
  - `asset_get_references` — `IAssetRegistry::GetReferencers`/`GetDependencies`
  - `asset_validate` — `UEditorValidatorSubsystem::ValidateAssets`
  - `asset_rename` — `UEditorAssetLibrary::RenameAsset`

- [ ] **Step 2: `HaybaMCPBlueprintHandler`** — commands per §4.4.
  - `blueprint_create` — `FKismetEditorUtilities::CreateBlueprint`
  - `blueprint_get_info` — walk `UBlueprint::FunctionGraphs`, `UbergraphPages`, `Variables`, `Components`
  - `blueprint_add_component` — `FBlueprintEditorUtils::AddNewComponent` (or AddDefaultSubobject pattern)
  - `blueprint_add_variable` — `FBlueprintEditorUtils::AddMemberVariable`
  - `blueprint_add_function` — `FBlueprintEditorUtils::AddNewFunctionGraph`
  - `blueprint_add_node` — `UEdGraphSchema::CreateAutomaticConversionNodeAndConnections` or direct `NewObject<UK2Node_*>`
  - `blueprint_connect_nodes` — `UEdGraphPin::MakeLinkTo`
  - `blueprint_compile` — `FKismetEditorUtilities::CompileBlueprint`
  - `blueprint_document` — walk graph, emit "WHEN <event> THEN <node sequence>" prose
  - `blueprint_add_event` — `UEdGraphSchema_K2::CreateFunctionGraph` for event handler
  - `blueprint_set_defaults` — set values on `BP->GeneratedClass->ClassDefaultObject`

- [ ] **Step 3: `HaybaMCPMaterialHandler`** — commands per §4.5.
  - `material_create` — `UMaterialFactoryNew`, save asset
  - `material_add_node` — `NewObject<UMaterialExpression*>` and add to `Material->Expressions`
  - `material_connect_nodes` — `Expression->Input.Expression = Other; Expression->Input.OutputIndex = N;`
  - `material_create_instance` — `UMaterialInstanceConstantFactoryNew`
  - `material_set_param` — `MIC->SetScalarParameterValueEditorOnly` / `SetVectorParameterValueEditorOnly`
  - `material_apply` — set on a `UStaticMeshComponent::OverrideMaterials`
  - `material_list` — asset registry filter by `UMaterialInterface`
  - `material_get_info` — walk `Material->Expressions`, return shape

- [ ] **Step 4: Register all three, build, smoke test one command per handler, commit.**

```bash
git commit -m "feat(ue): add Asset/Blueprint/Material handlers — 28 commands"
```

---

## Task 10: Foliage / Spline / WorldPartition / ISM / Physics handlers

**Files:** Five handlers under `Private/handlers/`.

- [ ] **Step 1: `HaybaMCPFoliageHandler`** (§4.12) — `UFoliageEditorUtility`-style methods, `AInstancedFoliageActor::Get(World, true)`, `IFA->AddInstance(...)`.

- [ ] **Step 2: `HaybaMCPSplineHandler`** (§4.13) — spawn `AActor` with `USplineComponent`, expose `AddSplinePoint`, `SetLocationAtSplinePoint`, `GetSplineLength`.

- [ ] **Step 3: `HaybaMCPWorldPartitionHandler`** (§4.14) — `UWorldPartition` cell access; `wp_get_cells` returns each cell's `Bounds`, `ActorCount`, top 5 dominant classes (used by cognitive map).

- [ ] **Step 4: `HaybaMCPISMHandler`** (§4.22) — `UInstancedStaticMeshComponent::AddInstance(FTransform)` etc.

- [ ] **Step 5: `HaybaMCPPhysicsHandler`** (§4.23) — `UPrimitiveComponent::SetSimulatePhysics`, `SetCollisionProfileName`, `AddImpulse`.

- [ ] **Step 6: Register all, build, smoke test, commit.**

```bash
git commit -m "feat(ue): add Foliage/Spline/WP/ISM/Physics handlers — 19 commands"
```

---

## Task 11: FHaybaMCPDocsHandler (live UE reflection)

**Files:** `Private/handlers/HaybaMCPDocsHandler.{h,cpp}`

Per §4.9.

- [ ] **Step 1: Header.**

- [ ] **Step 2: `docs_search`** — iterate `TObjectIterator<UClass>`, fuzzy match name, return top 50.

- [ ] **Step 3: `docs_lookup_class`** — `FindObject<UClass>(...)`, return parent chain, `CLASS_*` flags.

- [ ] **Step 4: `docs_lookup_api`** — for given class, walk `TFieldIterator<FProperty>` (props with type, category, tooltip from `meta=(ToolTip="...")`), `TFieldIterator<UFunction>` (params via `TFieldIterator<FProperty>` on UFunction).

- [ ] **Step 5: Register, build, test (`docs_search?q=Static Mesh`), commit.**

```bash
git commit -m "feat(ue): add FHaybaMCPDocsHandler — live reflection lookup"
```

---

## Task 12: Stub handlers for remaining 16 domains

**Files:** One pair per domain under `Private/handlers/`. Domains: `Sequencer`, `Animation`, `Niagara`, `Audio`, `MetaSound`, `GAS`, `BehaviorTree`, `Input`, `UI`, `Network`, `StaticMesh`, `Texture`, `DataAsset`, `Project`, `Build`, `Test`.

- [ ] **Step 1:** Generate stubs returning `{ "status":"not_implemented", "domain":"<name>", "eta":"v1.0" }` for every command listed in spec §4.15–§4.32. Each stub's `GetCommands()` enumerates the full command list per the spec so Code Mode meta-tools can advertise them.

- [ ] **Step 2: Register all in module, build, commit.**

```bash
git commit -m "feat(ue): add stub handlers for 16 domains (Sequencer, Anim, Niagara, Audio, MetaSound, GAS, BT, Input, UI, Net, Mesh, Texture, Data, Project, Build, Test)"
```

---

## Task 13: Plugin settings UI additions

**Files:** Modify `Private/HaybaMCPSettings.{h,cpp}`

Per spec §10.

- [ ] **Step 1: Add fields.**

```cpp
// HaybaMCPSettings.h
UPROPERTY(EditAnywhere, Config, Category="Security", meta=(PasswordField=true))
FString CapabilityToken;

UPROPERTY(EditAnywhere, Config, Category="Security")
bool bEnableExecutionJournal = true;

UPROPERTY(EditAnywhere, Config, Category="Security")
bool bAllowUnsafePython = false;

UPROPERTY(EditAnywhere, Config, Category="Performance", meta=(ClampMin=10, ClampMax=600))
int32 RateLimitPerMinute = 60;

UPROPERTY(EditAnywhere, Config, Category="Performance")
bool bCodeModeEnabled = true;

UPROPERTY(EditAnywhere, Config, Category="Performance", meta=(ClampMin=0.5, ClampMax=30.0))
float ToolCacheTTLSeconds = 2.0f;

UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar")
FString SidecarURL = TEXT("http://localhost:7821");

UENUM() enum class EHaybaModelPreset : uint8 { Minimal, Balanced, Full };

UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar")
EHaybaModelPreset ModelPreset = EHaybaModelPreset::Minimal;

UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar")
bool bEnableSpatialCLIP = false;

UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar")
bool bEnableOWLViT = false;

UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar",
    meta=(EditCondition="bEnableContinuousCapture",
          ToolTip="WARNING: Continuous capture causes ongoing GPU load"))
bool bEnableContinuousCapture = false;

/** Read-only computed VRAM estimate. */
UPROPERTY(VisibleAnywhere, Category="Visual Sidecar")
FString VRAMEstimate;
```

- [ ] **Step 2: VRAM computation in `PostEditChangeProperty`** — Minimal=1GB, Balanced=2GB, Full=12GB+, add 200MB for SpatialCLIP, 600MB for OWLViT.

- [ ] **Step 3: Build, open settings panel, verify fields appear, commit.**

```bash
git commit -m "feat(ue): expose HaybaOS configuration in plugin settings UI"
```

---

## Task 14: Node.js — HaybaToolMeta interface

**Files:** Create `packages/hayba/src/tools/hayba-tool-meta.ts`, modify `tsconfig`.

- [ ] **Step 1: Test (RED)**

```ts
// packages/hayba/tests/tools/hayba-tool-meta.test.ts
import { describe, it, expect } from 'vitest';
import { describeMeta, type HaybaToolMeta } from '../../src/tools/hayba-tool-meta.js';

describe('HaybaToolMeta', () => {
  it('renders meta as a description suffix', () => {
    const meta: HaybaToolMeta = {
      cost: 'medium',
      effects: ['spawns_actor'],
      when: 'placing a new asset',
      not_when: 'just reading positions',
    };
    const out = describeMeta(meta);
    expect(out).toContain('cost=medium');
    expect(out).toContain('effects=[spawns_actor]');
    expect(out).toContain('USE_WHEN: placing a new asset');
    expect(out).toContain('NOT_WHEN: just reading positions');
  });
});
```

Run: `npx vitest run tests/tools/hayba-tool-meta.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 2: Implement (GREEN)**

```ts
// packages/hayba/src/tools/hayba-tool-meta.ts
export type HaybaToolCost = 'low' | 'medium' | 'high';

export interface HaybaToolMeta {
  cost: HaybaToolCost;
  effects: string[];
  when: string;
  not_when: string;
}

export function describeMeta(m: HaybaToolMeta): string {
  return [
    `[cost=${m.cost}]`,
    `[effects=[${m.effects.join(',')}]]`,
    `USE_WHEN: ${m.when}`,
    `NOT_WHEN: ${m.not_when}`,
  ].join(' ');
}

export function appendMeta(description: string, meta: HaybaToolMeta): string {
  return `${description}\n\n${describeMeta(meta)}`;
}
```

- [ ] **Step 3: Run test (PASS), commit.**

```bash
git commit -m "feat(mcp): add HaybaToolMeta interface for cost-aware tool schemas"
```

---

## Task 15: Node.js — rate limiter

**Files:** `packages/hayba/src/tools/hayba-rate-limiter.ts`, test.

- [ ] **Step 1: Test (RED)**

```ts
// tests/tools/hayba-rate-limiter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { RateLimiter } from '../../src/tools/hayba-rate-limiter.js';

describe('RateLimiter', () => {
  it('allows up to N requests per window then blocks', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 60_000 });
    expect(rl.check('s1').allowed).toBe(true);
    expect(rl.check('s1').allowed).toBe(true);
    expect(rl.check('s1').allowed).toBe(true);
    expect(rl.check('s1').allowed).toBe(false);
  });

  it('expires entries after window', () => {
    const now = vi.fn(() => 0);
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, now });
    expect(rl.check('s1').allowed).toBe(true);
    expect(rl.check('s1').allowed).toBe(false);
    now.mockReturnValue(2000);
    expect(rl.check('s1').allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// hayba-rate-limiter.ts
export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}
export interface RateCheck { allowed: boolean; remaining: number; resetMs: number; }

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private opts: Required<RateLimiterOptions>;
  constructor(opts: RateLimiterOptions) {
    this.opts = { now: () => Date.now(), ...opts };
  }
  check(key: string): RateCheck {
    const t = this.opts.now();
    const cutoff = t - this.opts.windowMs;
    const arr = (this.hits.get(key) ?? []).filter(x => x > cutoff);
    if (arr.length >= this.opts.limit) {
      return { allowed: false, remaining: 0, resetMs: arr[0] + this.opts.windowMs - t };
    }
    arr.push(t);
    this.hits.set(key, arr);
    return { allowed: true, remaining: this.opts.limit - arr.length, resetMs: this.opts.windowMs };
  }
}
```

- [ ] **Step 3: Run, commit.**

```bash
git commit -m "feat(mcp): add 60 req/min rate limiter for tool dispatch"
```

---

## Task 16: Node.js — ToolCache

**Files:** `packages/hayba/src/tools/hayba-tool-cache.ts`, test.

- [ ] **Step 1: Install lru-cache** — already present? `cd packages/hayba && npm install lru-cache`.

- [ ] **Step 2: Test (RED)**

```ts
import { describe, it, expect } from 'vitest';
import { ToolCache } from '../../src/tools/hayba-tool-cache.js';

describe('ToolCache', () => {
  it('caches read results', async () => {
    const cache = new ToolCache({ ttlSeconds: 5 });
    let calls = 0;
    const exec = async () => ({ data: ++calls });
    expect((await cache.run('actor_list', { x: 1 }, 'read', exec)).data).toBe(1);
    expect((await cache.run('actor_list', { x: 1 }, 'read', exec)).data).toBe(1);
    expect(calls).toBe(1);
  });
  it('write invalidates all', async () => {
    const cache = new ToolCache({ ttlSeconds: 5 });
    await cache.run('actor_list', {}, 'read', async () => ({ a: 1 }));
    await cache.run('actor_spawn', {}, 'write', async () => ({ ok: true }));
    let calls = 0;
    await cache.run('actor_list', {}, 'read', async () => ({ a: ++calls }));
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 3: Implement**

```ts
import { LRUCache } from 'lru-cache';

export type ToolEffect = 'read' | 'write' | 'destructive';

export class ToolCache {
  private cache: LRUCache<string, unknown>;
  constructor(opts: { ttlSeconds: number }) {
    this.cache = new LRUCache({ max: 200, ttl: opts.ttlSeconds * 1000 });
  }
  async run<T>(cmd: string, params: unknown, effect: ToolEffect,
               exec: () => Promise<T>): Promise<T> {
    if (effect !== 'read') {
      this.cache.clear();
      return exec();
    }
    const key = `${cmd}:${JSON.stringify(params)}`;
    const hit = this.cache.get(key) as T | undefined;
    if (hit !== undefined) return hit;
    const v = await exec();
    this.cache.set(key, v);
    return v;
  }
}
```

- [ ] **Step 4: Run, commit.**

```bash
git commit -m "feat(mcp): add ToolCache (lru-cache) with read-cache + write-invalidation"
```

---

## Task 17: Node.js — Code Mode meta tools

**Files:** `packages/hayba/src/tools/code-mode/list-tool-categories.ts`, `get-tool-signature.ts`, plus a new C++ command `meta_list_domains` and `meta_get_schema`.

- [ ] **Step 1: Add C++ meta commands**

In `FHaybaMCPCommandHandler`, add a `MetaHandler` registered at startup that knows the registry. `meta_list_domains` returns `[{ domain, command_count, commands: [...] }]`. `meta_get_schema?command=X` returns a JSON schema fetched from a static map populated by each handler at registration (each handler exposes `GetSchemas()` returning `TMap<FString, TSharedRef<FJsonObject>>`).

- [ ] **Step 2: TS — `list-tool-categories.ts`**

```ts
import { z } from 'zod';
import type { ToolHandler } from '../hayba-bake-terrain.js';
import { sendCommand } from '../../tcp/client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low', effects: [],
  when: 'discovering what HaybaOS can do before drilling into specific commands',
  not_when: 'you already know the exact tool name',
};

export const schema = z.object({});

export const listToolCategoriesHandler: ToolHandler = async (_args, session) => {
  const out = await sendCommand(session, { cmd: 'meta_list_domains' });
  return { content: [{ type: 'text', text: JSON.stringify(out.domains, null, 2) }] };
};
```

- [ ] **Step 3: `get-tool-signature.ts`** — same shape, command `meta_get_schema`, params `{ command: string }`.

- [ ] **Step 4: Tests, commit.**

```bash
git commit -m "feat(mcp): add Code Mode meta-tools (list_tool_categories, get_tool_signature)"
```

---

## Task 18: Node.js — actor tools (representative example)

**Files:** `packages/hayba/src/tools/actor/{actor-spawn,actor-delete,actor-transform,actor-list}.ts` + tests.

- [ ] **Step 1: Tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import { actorSpawnHandler, schema } from '../../../src/tools/actor/actor-spawn.js';

describe('actor_spawn tool', () => {
  it('rejects missing class_path', async () => {
    const r = await actorSpawnHandler({}, fakeSession({}));
    expect(r.isError).toBe(true);
  });
  it('forwards to TCP', async () => {
    const send = vi.fn().mockResolvedValue({ actor_id: 'X1', label: 'X', class: 'C' });
    const session = fakeSession({ send });
    const r = await actorSpawnHandler(
      { class_path: '/Engine/BasicShapes/Cube.Cube_C', location: [0, 0, 0] }, session);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'actor_spawn' }));
    expect(r.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Implementation**

```ts
// actor-spawn.ts
import { z } from 'zod';
import type { ToolHandler } from '../hayba-bake-terrain.js';
import { sendCommand } from '../../tcp/client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium', effects: ['spawns_actor', 'modifies_level'],
  when: 'placing a new asset instance in the active level',
  not_when: 'duplicating an existing actor (use actor_duplicate) or just moving one (actor_transform)',
};

export const schema = z.object({
  class_path: z.string().min(1),
  location: z.tuple([z.number(), z.number(), z.number()]).optional(),
  rotation: z.tuple([z.number(), z.number(), z.number()]).optional(),
  scale: z.tuple([z.number(), z.number(), z.number()]).optional(),
  label: z.string().optional(),
});

export const actorSpawnHandler: ToolHandler = async (args, session) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: parsed.error.message }], isError: true };
  }
  try {
    const out = await sendCommand(session, { cmd: 'actor_spawn', params: parsed.data });
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `actor_spawn failed: ${(e as Error).message}` }], isError: true };
  }
};
```

- [ ] **Step 3: Implement actor-delete, actor-transform, actor-list following the same pattern.**

- [ ] **Step 4: Wire all 4 into `register-tools.ts`** — wrap each handler with `RateLimiter.check` then `ToolCache.run` then `appendMeta` on description.

- [ ] **Step 5: Tests pass, commit.**

```bash
git commit -m "feat(mcp): add actor_* tools (spawn/delete/transform/list) — Code Mode pattern reference"
```

---

## Task 19: Node.js — scene + editor + python tools

**Files:** `tools/scene/{scene-export,scene-validate-physics}.ts`, `tools/editor/editor-capture-viewport.ts`, `tools/python/python-run.ts`.

- [ ] **Step 1: `scene-export`** — schema `{ mode: 'A'|'B'|'C' default 'B', center?: [x,y,z], extent?: [x,y,z], physics_relations?: bool, cursor?: string, limit?: number }`. Forwards to `scene_export`.

- [ ] **Step 2: `scene-validate-physics`** — schema `{ deep_check?: bool default false }`. If `deep_check: true`, after C++ result, POST screenshot + actor bbox JSON to `<sidecarURL>/validate`, merge results.

- [ ] **Step 3: `editor-capture-viewport`** — calls C++ for base64 PNG. If sidecar configured & reachable, POST to `<sidecarURL>/embed` and merge `embedding`, `detected_objects`, `clip_score` fields.

- [ ] **Step 4: `python-run`** — schema `{ script: string }`. Forward result; if response says blocked tier 3, surface error clearly.

- [ ] **Step 5: Tests for all four (vitest, mock TCP), commit.**

```bash
git commit -m "feat(mcp): add scene_export / scene_validate_physics / editor_capture_viewport / python_run tools"
```

---

## Task 20: Visual sidecar (uv project)

**Files:** new `packages/hayba/addons/visual-embeddings/`

- [ ] **Step 1: `pyproject.toml`**

```toml
[project]
name = "hayba-visual-sidecar"
version = "0.1.0"
description = "HaybaOS visual perception sidecar — CLIP / SpatialCLIP / OWLViT embeddings for UE viewport"
requires-python = ">=3.10"
dependencies = [
  "fastapi>=0.111",
  "uvicorn[standard]>=0.30",
  "pillow>=10",
  "numpy>=1.26",
  "open-clip-torch>=2.24",
]

[project.optional-dependencies]
gpu = ["torch>=2.3 ; platform_system != 'Darwin'"]
cpu = ["torch>=2.3"]
owlvit = ["transformers>=4.40"]

[project.scripts]
hayba-visual-sidecar = "hayba_sidecar.server:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

- [ ] **Step 2: `src/hayba_sidecar/server.py`**

```python
import base64, io, os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
import uvicorn

from .models.clip_model import get_clip
from .models.spatial_clip import get_spatial_clip
from .models.owl_vit import get_owl_vit

app = FastAPI(title="hayba-visual-sidecar", version="0.1.0")

class EmbedRequest(BaseModel):
    image_base64: str
    spatial: bool = False
    detect: bool = False

@app.get("/health")
def health():
    return {
        "ok": True,
        "models": {
            "clip": True,
            "spatial_clip": os.getenv("HAYBA_ENABLE_SPATIAL_CLIP") == "1",
            "owl_vit": os.getenv("HAYBA_ENABLE_OWL_VIT") == "1",
        },
    }

@app.post("/embed")
def embed(req: EmbedRequest):
    try:
        img = Image.open(io.BytesIO(base64.b64decode(req.image_base64))).convert("RGB")
    except Exception as e:
        raise HTTPException(400, f"bad image: {e}")
    clip = get_clip()
    vec = clip.encode_image(img).tolist()
    out = {"embedding": vec, "dim": len(vec)}
    if req.spatial and os.getenv("HAYBA_ENABLE_SPATIAL_CLIP") == "1":
        out["spatial_embedding"] = get_spatial_clip().encode(img).tolist()
    if req.detect and os.getenv("HAYBA_ENABLE_OWL_VIT") == "1":
        out["detections"] = get_owl_vit().detect(img)
    return out

class ValidateRequest(BaseModel):
    image_base64: str
    actor_bboxes: list[dict]

@app.post("/validate")
def validate(req: ValidateRequest):
    # placeholder: sends to a VLM to flag structurally-suspect geometry.
    # v0.1 returns empty; future plug-in calls a multimodal LLM endpoint.
    return {"structurally_suspect": []}

def main():
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("HAYBA_SIDECAR_PORT", "7821")))
```

- [ ] **Step 3: `src/hayba_sidecar/models/clip_model.py`**

```python
import torch, open_clip
from PIL import Image

_model = None
_preproc = None
_tokenizer = None

def get_clip():
    global _model, _preproc, _tokenizer
    if _model is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _model, _, _preproc = open_clip.create_model_and_transforms("ViT-L-14", pretrained="openai")
        _model = _model.to(device).eval()
        _tokenizer = open_clip.get_tokenizer("ViT-L-14")
    return _Clip(_model, _preproc, _tokenizer)

class _Clip:
    def __init__(self, m, pre, tok):
        self.m, self.pre, self.tok = m, pre, tok
    @torch.no_grad()
    def encode_image(self, img: Image.Image):
        device = next(self.m.parameters()).device
        x = self.pre(img).unsqueeze(0).to(device)
        v = self.m.encode_image(x)
        v = v / v.norm(dim=-1, keepdim=True)
        return v[0].cpu().numpy()
```

- [ ] **Step 4: `models/spatial_clip.py`** — lazy loader for adapter checkpoint at env `HAYBA_SPATIAL_CLIP_CHECKPOINT`. Return zero vector with warning if missing.

- [ ] **Step 5: `models/owl_vit.py`** — lazy load `transformers.OwlViTProcessor + OwlViTForObjectDetection`. `detect(img, queries)` returns `[{label, box, score}]`.

- [ ] **Step 6: `README.md`** — install (`uv sync --extra gpu` or `--extra cpu`), run (`uv run hayba-visual-sidecar`), env vars, model presets table.

- [ ] **Step 7: Manual test** — `uv sync --extra cpu`, `uv run hayba-visual-sidecar`, `curl http://localhost:7821/health` → expect `{"ok":true,...}`. POST a sample base64 PNG to `/embed`, verify 768-dim vector returned.

- [ ] **Step 8: Commit.**

```bash
git add packages/hayba/addons/visual-embeddings
git commit -m "feat(addons): add visual-embeddings sidecar (uv + FastAPI + CLIP/SpatialCLIP/OWLViT)"
```

---

## Task 21: hayba.agents.json — 5 swarm archetypes

**Files:** `packages/hayba/hayba.agents.json`

Per spec §7.1.

- [ ] **Step 1: Create file**

```json
{
  "version": 1,
  "shared_memory": "hayba-memory.db",
  "archetypes": [
    {
      "id": "director",
      "role": "Director",
      "system_prompt": "You convert natural-language scene briefs into structured plans. You delegate execution to other agents. You always call hayba_generate_moodboard or hayba_fetch_references at the start of a new scene task. Use list_tool_categories first.",
      "tool_filter": ["*"],
      "memory_scope": "shared"
    },
    {
      "id": "asset-manager",
      "role": "Asset Manager",
      "system_prompt": "You map text requirements to Content Browser assets. You search by name/type/path and validate before recommending. You record asset choices to shared memory with intent.",
      "tool_filter": ["asset_*", "scene_*", "mesh_*", "texture_*", "material_*"],
      "memory_scope": "shared"
    },
    {
      "id": "pattern-expert",
      "role": "Pattern Expert",
      "system_prompt": "You apply spatial composition rules and architectural templates. You use scene_export mode B (relational) to reason about layout. You propose macro/meso/micro spatial structures.",
      "tool_filter": ["scene_*", "level_*", "pcg_*", "wp_*", "spline_*"],
      "memory_scope": "shared"
    },
    {
      "id": "node-expert",
      "role": "Node Expert",
      "system_prompt": "You provide PCG/PCGEx technical guidance. You validate node connectivity. You answer with citations from the live UE reflection (docs_*).",
      "tool_filter": ["docs_*", "pcg_*", "python_*"],
      "memory_scope": "shared"
    },
    {
      "id": "blueprint-generator",
      "role": "Blueprint Generator",
      "system_prompt": "You construct final logic graphs and execute tool calls. You monitor editor_stream_log during PIE. Always verify with editor_capture_viewport + hayba_compare_clip_score before declaring success.",
      "tool_filter": ["*"],
      "memory_scope": "private+shared"
    }
  ]
}
```

- [ ] **Step 2: Commit.**

```bash
git add packages/hayba/hayba.agents.json
git commit -m "feat(swarm): add hayba.agents.json with 5 canonical agent archetypes"
```

---

## Task 22: Node.js — SQLite collaborative memory

**Files:** `packages/hayba/src/gaea/memory/hayba-memory.ts` + test.

- [ ] **Step 1: Install** — `npm install better-sqlite3 @types/better-sqlite3 -w packages/hayba`.

- [ ] **Step 2: Test (RED)**

```ts
import { describe, it, expect } from 'vitest';
import { HaybaMemory } from '../../../src/gaea/memory/hayba-memory.js';

describe('HaybaMemory', () => {
  it('writes and queries shared blocks', () => {
    const m = new HaybaMemory(':memory:');
    m.write({
      agentRole: 'director', scope: 'shared',
      intent: 'establish biome plan', content: 'forest -> river -> ruins',
      accessedResources: [], tokenCost: 12,
    });
    const blocks = m.query({ scope: 'shared', limit: 10 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].intent).toBe('establish biome plan');
  });
});
```

- [ ] **Step 3: Implement**

```ts
// hayba-memory.ts
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface MemoryBlock {
  id?: string;
  agentRole: string;
  scope: 'private' | 'shared';
  intent: string;
  content: string;
  accessedResources: string[];
  tokenCost: number;
  provenance?: Record<string, unknown>;
  timestamp?: number;
}

export class HaybaMemory {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_blocks (
        id TEXT PRIMARY KEY,
        agent_role TEXT NOT NULL,
        scope TEXT NOT NULL,
        intent TEXT NOT NULL,
        content TEXT NOT NULL,
        accessed_resources TEXT,
        timestamp INTEGER NOT NULL,
        provenance TEXT,
        token_cost INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_scope_role ON memory_blocks(scope, agent_role);
    `);
  }
  write(b: MemoryBlock): string {
    const id = b.id ?? randomUUID();
    this.db.prepare(`INSERT INTO memory_blocks
      (id, agent_role, scope, intent, content, accessed_resources, timestamp, provenance, token_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, b.agentRole, b.scope, b.intent, b.content,
        JSON.stringify(b.accessedResources),
        b.timestamp ?? Date.now(),
        JSON.stringify(b.provenance ?? {}),
        b.tokenCost);
    return id;
  }
  query(opts: { scope?: 'private' | 'shared'; agentRole?: string; limit?: number }): MemoryBlock[] {
    const where: string[] = []; const args: unknown[] = [];
    if (opts.scope) { where.push('scope = ?'); args.push(opts.scope); }
    if (opts.agentRole) { where.push('agent_role = ?'); args.push(opts.agentRole); }
    const sql = `SELECT * FROM memory_blocks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY timestamp DESC LIMIT ?`;
    args.push(opts.limit ?? 50);
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as string,
      agentRole: r.agent_role as string,
      scope: r.scope as 'private' | 'shared',
      intent: r.intent as string,
      content: r.content as string,
      accessedResources: JSON.parse(r.accessed_resources as string ?? '[]'),
      timestamp: r.timestamp as number,
      provenance: JSON.parse(r.provenance as string ?? '{}'),
      tokenCost: r.token_cost as number,
    }));
  }
  clear(agentRole?: string): void {
    if (agentRole) this.db.prepare('DELETE FROM memory_blocks WHERE agent_role = ?').run(agentRole);
    else this.db.prepare('DELETE FROM memory_blocks').run();
  }
}
```

- [ ] **Step 4: Test passes, commit.**

```bash
git commit -m "feat(swarm): add HaybaMemory (SQLite) for collaborative agent memory"
```

---

## Task 23: Swarmhost integration

**Files:** Modify `packages/hayba/src/gaea/swarmhost.ts`.

- [ ] **Step 1: Load `hayba.agents.json` at startup.**

Read `path.resolve(projectRoot, 'hayba.agents.json')`; if missing, fall back to bundled defaults.

- [ ] **Step 2: For each archetype, instantiate an agent runtime with:**
  - System prompt = archetype.system_prompt
  - Tool filter: only register tools matching `tool_filter` glob
  - Shared `HaybaMemory` instance (resolves `shared_memory` filename)

- [ ] **Step 3: Add `stream_log` MCP tool** that tails `Saved/hayba-execution.log` via `editor_stream_log` C++ call.

- [ ] **Step 4: Existing swarmhost tests still pass.** Adapt any breaking changes. Add new tests for archetype loading.

- [ ] **Step 5: Commit.**

```bash
git commit -m "feat(swarm): wire hayba.agents.json + HaybaMemory into swarmhost; add stream_log tool"
```

---

## Task 24: Visual production pipeline tools

**Files:** `tools/visual/{hayba-generate-moodboard,hayba-fetch-references,hayba-compare-clip-score}.ts` + tests.

- [ ] **Step 1: `hayba-generate-moodboard`** — schema `{ prompt: string, count?: number, style?: string }`. Calls configured image-gen endpoint (env `HAYBA_IMAGEGEN_URL`), returns array of `{ url, base64?, clip_embedding }` (embedding via sidecar).

- [ ] **Step 2: `hayba-fetch-references`** — schema `{ keywords: string[], top_k?: number }`. Calls a curated reference search (initial impl: configurable Unsplash API key OR local folder under `addons/references/`). Returns up to `top_k` images with CLIP embeddings.

- [ ] **Step 3: `hayba-compare-clip-score`** — schema `{ image_a_base64: string, image_b_base64: string }`. POSTs both to sidecar `/embed`, returns cosine similarity.

```ts
function cosine(a: number[], b: number[]): number {
  let dot=0, na=0, nb=0;
  for (let i=0;i<a.length;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb));
}
```

- [ ] **Step 4: Tests (mock fetch + sidecar), commit.**

```bash
git commit -m "feat(mcp): add visual production pipeline tools (moodboard, references, compare CLIP score)"
```

---

## Task 25: Workflow skills (4 SKILL.md files)

**Files:** `packages/hayba/addons/workflows/{hayba-new-scene,hayba-refine-scene,hayba-debug-level,hayba-pcg-build}/SKILL.md`

Per spec §9.

- [ ] **Step 1: `hayba-new-scene/SKILL.md`**

```markdown
---
name: hayba-new-scene
description: Use when the user asks to generate a new scene from scratch — coordinates moodboard → references → spatial planning → asset placement → physics validation → CLIP scoring.
---

# hayba-new-scene

## Workflow

1. Call `hayba_generate_moodboard` with the scene brief — get 3-5 reference embeddings.
2. Call `hayba_fetch_references` for any specific keywords — extend reference set.
3. Call `level_get_spatial_index` to get the level cognitive map (cells + cluster labels).
4. Plan biome zones top-down: assign each World Partition cell a target cluster label.
5. For each zone: call `pcg_create_graph` (terrain) → `pcg_execute_graph` → `foliage_paint`.
6. Dress hero areas: `actor_spawn` from Content Browser assets matched by `asset_search`.
7. Call `scene_validate_physics` (with `deep_check: false` first; only `true` for hero shots).
8. Call `editor_capture_viewport` + `hayba_compare_clip_score` against moodboard refs.
9. If score < 0.65, invoke `hayba-refine-scene`.

## Important

- Always start with the moodboard. Do not place assets before establishing references.
- Use `scene_export` mode B; do not use mode A unless explicitly asked.
- Record every spatial decision to memory with a clear `intent` string.
```

- [ ] **Step 2: `hayba-refine-scene/SKILL.md`**

```markdown
---
name: hayba-refine-scene
description: Use when the user wants to improve an existing scene — captures viewport, scores against references, and applies targeted edits to low-score regions.
---

# hayba-refine-scene

## Workflow

1. `editor_capture_viewport` for the current angle.
2. Retrieve reference embeddings from shared memory (search by intent: "moodboard reference").
3. `hayba_compare_clip_score` for each reference; identify lowest-scoring elements via per-actor projection.
4. For each low-scoring actor: try one of (lighting, material swap, displacement, foliage density change).
5. Re-capture, re-score. Stop when delta < 0.02 or 5 iterations.
```

- [ ] **Step 3: `hayba-debug-level/SKILL.md`**

```markdown
---
name: hayba-debug-level
description: Use when a level has performance, physics, or layout problems — combines stream_log, scene_validate_physics, and scene_export mode C to find issues.
---

# hayba-debug-level

## Workflow

1. `editor_get_performance_stats` — baseline FPS / draw calls / memory.
2. `stream_log` filtered by `LogStreaming|LogPhysics|LogPCG` — start tail.
3. `scene_validate_physics` (no deep check first).
4. `scene_export` mode C (hierarchical) — look for over-dense cells.
5. For floating actors: `actor_transform` to snap to ground (use `placement_validate` first).
6. For interpenetration: `actor_transform` or `actor_set_visibility` based on context.
7. For perf hotspots: `wp_set_streaming` on heavy cells; check for ISM consolidation opportunities (`ism_*`).
```

- [ ] **Step 4: `hayba-pcg-build/SKILL.md`**

```markdown
---
name: hayba-pcg-build
description: Use when the user wants to build a PCG/PCGEx graph — guides through node selection, validation, and execution.
---

# hayba-pcg-build

## Workflow

1. `pcg_list_node_classes` → discover available nodes.
2. For each candidate, `pcg_get_node_details` → confirm pin types.
3. Sketch graph as JSON.
4. `pcg_validate_graph` — must pass all 5 layers before creation.
5. `pcg_create_graph` from validated JSON.
6. `pcg_execute_graph` on a target component.
7. `pcg_read_node_output` to verify generated data.
```

- [ ] **Step 5: Commit all four.**

```bash
git commit -m "feat(addons): add 4 workflow skills (new-scene, refine-scene, debug-level, pcg-build)"
```

---

## Task 26: Documentation — getting-started add-on tiers

**Files:** Modify `packages/hayba/README.md` (or create if missing) + `docs/getting-started.md`.

Per spec §11.

- [ ] **Step 1: Add three-tier section to getting-started**

```markdown
## Add-On Tiers

### Tier 1 — Core (required)
- UE plugin (`HaybaMCPToolkit`) + Node.js MCP server
- See main install instructions above

### Tier 2 — Visual Intelligence (optional, GPU recommended)
- `cd packages/hayba/addons/visual-embeddings && uv sync --extra gpu`  (or `--extra cpu`)
- `uv run hayba-visual-sidecar` — sidecar listens on :7821
- ⚠️ Continuous capture mode causes ongoing GPU load. Disable if not actively iterating.

### Tier 3 — Workflow Skills (optional)
- Copy `packages/hayba/addons/workflows/*` to `~/.claude/skills/`
- Available skills: hayba-new-scene, hayba-refine-scene, hayba-debug-level, hayba-pcg-build
```

- [ ] **Step 2: Commit.**

```bash
git commit -m "docs: document Tier 1/2/3 add-on installation"
```

---

## Task 27: Prompt caching wiring

**Files:** Modify wherever the MCP tool descriptions are sent to Anthropic API (likely `src/anthropic-client.ts` or `src/mcp-server.ts`).

Per spec §8.

- [ ] **Step 1:** Place at prompt head with `cache_control: { type: 'ephemeral' }`:
  - All `HaybaToolMeta` schemas concatenated
  - Active agent's system instructions
  - Cached cognitive map JSON (loaded from `Saved/hayba-cognitive-map.json` via `level_get_spatial_index`)

- [ ] **Step 2:** Re-fetch + re-place macro scene graph after any tool with `effect: 'write' | 'destructive'` runs.

- [ ] **Step 3: Test that subsequent identical request reports cache hit in API response.** (Anthropic SDK exposes `usage.cache_read_input_tokens`.)

- [ ] **Step 4: Commit.**

```bash
git commit -m "feat(mcp): wire prompt caching for tool meta + system prompt + cognitive map"
```

---

## Task 28: Plugin version bump + uplugin manifest

**Files:** `packages/hayba/Plugins/HaybaMCPToolkit/HaybaMCPToolkit.uplugin`

- [ ] **Step 1:** Bump `"VersionName": "0.3.0"`, `"Version": 3`. Add module dependencies to `Build.cs`: `EditorScriptingUtilities`, `LevelEditor`, `Foliage`, `Landscape`, `WorldPartitionEditor`, `MaterialEditor`, `BlueprintGraph`, `Kismet`, `KismetCompiler`, `PythonScriptPlugin`, `SceneCapture`, `MovieScene` (forward-looking).

- [ ] **Step 2: Build clean, run manual smoke test on every domain handler (one command each).**

- [ ] **Step 3: Commit.**

```bash
git commit -m "chore(ue): bump HaybaMCPToolkit to 0.3.0; expand Build.cs dependencies"
```

---

## Task 29: Final integration smoke test

**Files:** `packages/hayba/scripts/smoke-test-tcp.ps1` (create)

- [ ] **Step 1: PowerShell smoke script** that fires sample commands from each implemented domain (actor, level, asset, scene, editor, python, foliage, spline, wp, ism, physics, docs, plus all 11 legacy + meta) and asserts shape `{ ok: true, ... }`.

- [ ] **Step 2: Run end-to-end test:**
  1. Open UE editor with HaybaMCPToolkit loaded
  2. `npm run build && npm test` in `packages/hayba`
  3. Start sidecar: `cd addons/visual-embeddings && uv run hayba-visual-sidecar`
  4. Run smoke script: `pwsh packages/hayba/scripts/smoke-test-tcp.ps1`
  5. Verify all commands return ok, journal log has entries, sidecar `/embed` works.

- [ ] **Step 3: Commit smoke script + final fixes.**

```bash
git commit -m "test(ue): add TCP smoke test script covering all v0.3.0 domains"
```

---

## Task 30: PR / final commit

- [ ] Run full test suite (`npm test`), verify clean build.
- [ ] Update `CHANGELOG.md` with v0.3.0 highlights.
- [ ] Final commit + push.

```bash
git commit -m "release: HaybaOS v0.3.0 — 18 implemented domains + 16 stub domains, visual sidecar, swarm agents"
```

---

## Self-Review Checklist

- [ ] Every spec section §1–§13 mapped to at least one task above
- [ ] No "TBD" / "implement later" / "similar to above" anywhere
- [ ] Method names consistent across tasks (e.g. `actor_spawn` not `spawn_actor` in some places)
- [ ] All TypeScript handlers wrapped with rate limiter + tool cache
- [ ] All C++ handlers go through router → security manager → response builder
- [ ] Workflow skills reference tools that actually exist in this plan
- [ ] No new code paths bypass the capability token check

---

**End of plan. Total: 30 tasks. Estimated effort: ~6-10 weeks of single-engineer time at 2-5 min/step granularity.**
