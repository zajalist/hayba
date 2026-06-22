# Semantic Studio — Plan B: UE Editor Window Implementation Plan

> **For agentic workers:** This plan is UE 5.7 C++ / Slate. Unlike Plan A, tasks are NOT unit-testable — verification is **compile clean + visual confirmation in the editor**. Steps use checkbox (`- [ ]`) syntax. Execute SERIALLY (UE builds lock `UnrealEditor-HaybaMCPToolkit.dll`; the editor must be CLOSED for each rebuild). Do not parallelize.

**Goal:** Build the standalone "Hayba Semantic Studio" editor window — a Material-Editor-style window with the SM as canvas — for authoring masks + constraints on a StaticMesh, per `docs/superpowers/specs/2026-06-19-semantic-studio-design.md`.

**Architecture:** A new nomad tab `TabStudio` registered in `FHaybaMCPModule` (mirrors the existing `TabMain` pattern), hosting a new `SHaybaSemanticStudio` Slate widget with a 4-region `SSplitter` layout: mask list / `AdvancedPreviewScene` viewport / inspector / constraint node graph. The Studio reads/writes the PLUMB stores under `ProjectDir/.scratch/` (`profiles.json`) the same no-bridge way the Memory + Validator panels already do. The constraint graph uses a custom `UEdGraph` + `UEdGraphSchema` with exactly the 5 typed node kinds; it compiles to the Plan-A graph model and persists onto the profile.

**Tech Stack:** UE 5.7 Editor module C++, Slate (`SDockTab`, `SSplitter`, `SListView`), `AdvancedPreviewScene`/`SEditorViewport`, `FPrimitiveDrawInterface` for mask overlays, `GraphEditor`/`UEdGraph`/`SGraphEditor` for the node graph, `Json`/`JsonUtilities` for store IO.

## Global Constraints

- Build: editor CLOSED, then `& "C:\Program Files\Epic Games\UE_5.7\Engine\Build\BatchFiles\Build.bat" UnrealEditor Win64 Development -Project="D:\UnrealEngine\template\template.uproject"`. Relaunch editor to verify.
- The plugin module is `HaybaMCPToolkit` (Editor type). New modules: add deps to `HaybaMCPToolkit.Build.cs` ONLY (no new .uplugin — these are core editor UI, always available).
- New Build.cs dependencies needed across Plan B: `AdvancedPreview`, `InputCore`, `GraphEditor`, `UnrealEd`, `EditorStyle`, `ToolMenus`, `Json`, `JsonUtilities`, `RenderCore`, `MeshDescription`, `StaticMeshDescription` — add each in the task that first needs it, never speculatively.
- Store paths: `ProjectDir/.scratch/profiles.json` (env `HAYBA_PROFILES` dir override), mirroring `HaybaMCPMemoryPanel.cpp`'s `ScratchDir()` helper — reuse that resolution logic, do not reinvent a different path.
- Mask shape JSON matches Plan A's `Mask` type verbatim: `{ id, type:'surface'|'volume', color, source, confidence, locked, triangles?:int[], shape?:{kind,transform:{pos,quat,scale},extents?,radius?,points?}, detail? }`.
- The constraint graph is CLOSED: exactly 5 node kinds (mask|geometry|primitive|gate|verdict), typed pins, no operator/expression/branch nodes.
- Commit per task; no `Co-Authored-By` trailer.
- C++ style: match surrounding files (tabs, `F`/`S`/`U` prefixes, `TEXT()`, `UE_LOG(LogHaybaMCP, ...)`).

---

### Task B1: Studio tab scaffold + 4-region layout

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Studio/SHaybaSemanticStudio.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Studio/SHaybaSemanticStudio.cpp`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp` (register `TabStudio`)
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.h` (declare `TabStudio` + `SpawnStudioTab`)

**Interfaces:**
- Produces: `SHaybaSemanticStudio` Slate widget with `SLATE_BEGIN_ARGS` taking an optional `FString InAssetPath`; a static `FName FHaybaMCPModule::TabStudio`; `TSharedRef<SDockTab> FHaybaMCPModule::SpawnStudioTab(const FSpawnTabArgs&)`; console command `Hayba.Studio.Open`.

- [ ] **Step 1: Create `SHaybaSemanticStudio.h`** — widget with an `SSplitter`-based 4-region layout, asset-path arg, and placeholders.

```cpp
#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"

class SHaybaSemanticStudio : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaSemanticStudio) {}
        SLATE_ARGUMENT(FString, AssetPath)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    FString AssetPath;
};
```

- [ ] **Step 2: Create `SHaybaSemanticStudio.cpp`** — the 4-region shell (top toolbar row, then a horizontal splitter: mask list | viewport | inspector, then a bottom region for the graph).

```cpp
#include "Studio/SHaybaSemanticStudio.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"

void SHaybaSemanticStudio::Construct(const FArguments& InArgs)
{
    AssetPath = InArgs._AssetPath;

    ChildSlot
    [
        SNew(SVerticalBox)
        // Toolbar row
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(2)[ SNew(SButton).Text(NSLOCTEXT("Hayba","StudyAI","Study with AI ▸")) ]
            + SHorizontalBox::Slot().AutoWidth().Padding(2)[ SNew(SButton).Text(NSLOCTEXT("Hayba","BakeGeo","Bake Geometry")) ]
            + SHorizontalBox::Slot().FillWidth(1.f)[ SNew(STextBlock).Text(FText::FromString(AssetPath.IsEmpty() ? TEXT("(no asset)") : AssetPath)) ]
        ]
        // Middle: mask list | viewport | inspector
        + SVerticalBox::Slot().FillHeight(0.7f)
        [
            SNew(SSplitter).Orientation(Orient_Horizontal)
            + SSplitter::Slot().Value(0.2f)[ SNew(SBorder)[ SNew(STextBlock).Text(NSLOCTEXT("Hayba","Masks","MASKS")) ] ]
            + SSplitter::Slot().Value(0.55f)[ SNew(SBorder)[ SNew(STextBlock).Text(NSLOCTEXT("Hayba","Viewport","VIEWPORT")) ] ]
            + SSplitter::Slot().Value(0.25f)[ SNew(SBorder)[ SNew(STextBlock).Text(NSLOCTEXT("Hayba","Inspector","INSPECTOR")) ] ]
        ]
        // Bottom: constraint graph
        + SVerticalBox::Slot().FillHeight(0.3f)
        [
            SNew(SBorder)[ SNew(STextBlock).Text(NSLOCTEXT("Hayba","Graph","CONSTRAINT GRAPH")) ]
        ]
    ];
}
```

- [ ] **Step 3: Declare the tab in `HaybaMCPModule.h`** — add next to `TabMain`/`SpawnMainTab`:

```cpp
    static const FName TabStudio;
    TSharedRef<class SDockTab> SpawnStudioTab(const class FSpawnTabArgs& Args);
```

- [ ] **Step 4: Register the tab in `HaybaMCPModule.cpp`** — define the FName near `TabMain`'s definition, register the spawner in `StartupModule` (after the `TabMain` registration), unregister in `ShutdownModule`, and add a console command. Include `"Studio/SHaybaSemanticStudio.h"` at the top.

```cpp
// near other FName definitions:
const FName FHaybaMCPModule::TabStudio(TEXT("HaybaSemanticStudio"));

// in StartupModule, after TabMain registration:
TM->RegisterNomadTabSpawner(TabStudio, FOnSpawnTab::CreateRaw(this, &FHaybaMCPModule::SpawnStudioTab))
    .SetDisplayName(NSLOCTEXT("Hayba", "StudioTab", "Hayba Semantic Studio"))
    .SetGroup(ToolsGroup)
    .SetIcon(FSlateIcon(FHaybaMCPStyle::GetStyleSetName(), "Hayba.Icon.Toolkit"));

IConsoleManager::Get().RegisterConsoleCommand(
    TEXT("Hayba.Studio.Open"),
    TEXT("Opens the Hayba Semantic Studio"),
    FConsoleCommandDelegate::CreateLambda([]() { FGlobalTabmanager::Get()->TryInvokeTab(FHaybaMCPModule::TabStudio); }),
    ECVF_Default);

// in ShutdownModule, near UnregisterNomadTabSpawner(TabMain):
TM->UnregisterNomadTabSpawner(TabStudio);

// the spawner:
TSharedRef<SDockTab> FHaybaMCPModule::SpawnStudioTab(const FSpawnTabArgs&)
{
    return SNew(SDockTab).TabRole(ETabRole::NomadTab)
        [ SNew(SHaybaSemanticStudio) ];
}
```

- [ ] **Step 5: Build (editor closed) and verify.** Close the editor, run the Build.bat command from Global Constraints. Expected: `Result: Succeeded`, `EXITCODE=0`.

- [ ] **Step 6: Visual check.** Relaunch the editor, run console `Hayba.Studio.Open` (or Window ▸ Tools ▸ Hayba Semantic Studio). Expected: a tab opens showing the toolbar row, three side-by-side bordered regions (MASKS/VIEWPORT/INSPECTOR), and a bottom CONSTRAINT GRAPH region.

- [ ] **Step 7: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Studio unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.h
git commit -m "feat(studio): Semantic Studio tab scaffold + 4-region layout"
```

---

### Task B2: Profile loading + mask list + inspector

**Files:**
- Modify: `SHaybaSemanticStudio.h` / `.cpp` (load profile JSON, populate mask list + inspector)
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Studio/HaybaStudioModel.h` (plain structs mirroring the Mask/Profile JSON)

**Interfaces:**
- Produces: `FHaybaStudioMask` (POD: `FString Id; FString Type; FLinearColor Color; float Confidence; bool bLocked; FString Detail; ... shape fields`), `FHaybaStudioProfile` (`FString AssetId; TArray<FHaybaStudioMask> Masks; ...`), and `bool LoadProfile(const FString& AssetPath, FHaybaStudioProfile& Out)` that reads `ScratchDir()/profiles.json` and parses the entry for `AssetPath`.

- [ ] **Step 1: Create `HaybaStudioModel.h`** — POD structs + a `LoadProfile` declaration. Mirror the Mask JSON fields exactly (see Global Constraints). Reuse the BOM-free JSON read pattern from `HaybaMCPMemoryPanel.cpp` (`ReadJsonObject`) and its `ScratchDir()` (env `HAYBA_PROFILES` dir else `ProjectDir/.scratch`). Add `Json`, `JsonUtilities` to `HaybaMCPToolkit.Build.cs` if not present.

- [ ] **Step 2: Implement `LoadProfile`** — read `profiles.json`, find the object keyed by `AssetPath`, parse `masks[]` into `FHaybaStudioMask` (color via `FLinearColor::FromSRGBColor`/hex parse; type/confidence/locked/detail; volume `shape`). Code written against the compiler; verify with Step 5.

- [ ] **Step 3: Wire the mask list (left region)** — replace the MASKS placeholder with an `SListView<TSharedPtr<FHaybaStudioMask>>`: each row shows a color swatch (`SColorBlock`), the mask id, a type tag, and an eye `SCheckBox` for visibility (store visibility in a `TSet<FString> HiddenMaskIds`). Selecting a row sets `SelectedMask`.

- [ ] **Step 4: Wire the inspector (right region)** — bind to `SelectedMask`: id (read-only text), type, an `SColorBlock`, confidence, a lock `SCheckBox`, detail. (Editing persists in Task B-later; for now display + lock toggle that writes back to `profiles.json` via a `SaveProfile` helper.)

- [ ] **Step 5: Build (editor closed) + visual check.** Bake a profile with a mask first (run `plumb_profile_bake` + `plumb_mask_add` via MCP, or hand-author `.scratch/profiles.json`). Open the Studio via `Hayba.Studio.Open` — but it needs an asset path; temporarily default `AssetPath` in `SpawnStudioTab` to a known baked asset for this check. Expected: the mask appears in the left list with its color + eye, and clicking it fills the inspector.

- [ ] **Step 6: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Studio unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Source/HaybaMCPToolkit.Build.cs
git commit -m "feat(studio): profile loading + mask list + inspector"
```

---

### Task B3: AdvancedPreviewScene viewport with the SM

**Files:**
- Create: `Studio/SHaybaStudioViewport.h` / `.cpp` (a `SEditorViewport` subclass with an `FAdvancedPreviewScene`)
- Create: `Studio/HaybaStudioViewportClient.h` / `.cpp` (`FEditorViewportClient` subclass)
- Modify: `SHaybaSemanticStudio.cpp` (host the viewport in the center region)
- Modify: `HaybaMCPToolkit.Build.cs` (add `AdvancedPreview`, `InputCore`, `UnrealEd`, `RenderCore`)

**Interfaces:**
- Produces: `SHaybaStudioViewport` exposing `void SetPreviewMesh(UStaticMesh*)`; an `FAdvancedPreviewScene PreviewScene`; a `UStaticMeshComponent* PreviewComponent` added to the scene.

- [ ] **Step 1: Add Build.cs deps** (`AdvancedPreview`, `InputCore`, `UnrealEd`, `RenderCore`).

- [ ] **Step 2: Create the viewport client** — `FHaybaStudioViewportClient : public FEditorViewportClient`, constructed with the `FAdvancedPreviewScene*`; default perspective camera; `Draw` override left to call `Super` for now (mask overlays land in B4/B5).

- [ ] **Step 3: Create `SHaybaStudioViewport`** — `class SHaybaStudioViewport : public SEditorViewport, public FGCObject`. Hold `FAdvancedPreviewScene PreviewScene` (constructed with `FPreviewScene::ConstructionValues()`), a `UStaticMeshComponent* PreviewComponent`. Override `MakeEditorViewportClient()` to return the B2 client. `SetPreviewMesh(UStaticMesh*)` sets the component's mesh and calls `PreviewScene.AddComponent`. Implement `AddReferencedObjects` (FGCObject) for `PreviewComponent`.

- [ ] **Step 4: Host it** — in `SHaybaSemanticStudio`, replace the VIEWPORT placeholder with `SAssignNew(Viewport, SHaybaStudioViewport)`, and after `LoadProfile`, `LoadObject<UStaticMesh>(nullptr, *AssetPath)` → `Viewport->SetPreviewMesh(Mesh)`.

- [ ] **Step 5: Build (editor closed) + visual check.** Open the Studio on a baked SM. Expected: the mesh renders in the center region; orbit/pan/zoom work.

- [ ] **Step 6: Commit** — `feat(studio): AdvancedPreviewScene viewport renders the SM`.

---

### Task B4: Volume mask rendering (translucent shapes) + selection

**Files:**
- Modify: `HaybaStudioViewportClient.h` / `.cpp` (draw volume masks in `Draw`/`DrawCanvas` via `FPrimitiveDrawInterface`)
- Modify: `SHaybaStudioViewport` (expose the current `TArray<FHaybaStudioMask>` + hidden set + selected id to the client)

**Interfaces:**
- Produces: `FHaybaStudioViewportClient::SetMasks(const TArray<FHaybaStudioMask>&, const TSet<FString>& Hidden, const FString& Selected)`; volume masks drawn as translucent boxes/spheres at `shape.transform` with `shape.extents`/`radius`, in the mask color, brighter when selected.

- [ ] **Step 1: Pass mask data to the client** — store masks/hidden/selected on the client; the Studio calls `SetMasks` whenever the list selection or visibility changes (and on load).

- [ ] **Step 2: Draw volume masks** — in the client's `Draw(const FSceneView*, FPrimitiveDrawInterface* PDI)` override, for each non-hidden volume mask: `DrawWireBox`/`DrawWireSphere` for the outline + a translucent solid via `DrawBox` with a translucent `FMaterialRenderProxy` (or `DrawDebugSolidBox`-equivalent in editor preview). Selected mask drawn thicker/brighter. Box transform = mask `shape.transform`.

- [ ] **Step 3: Build (editor closed) + visual check.** Author a volume mask (`plumb_mask_add type=volume shape=box`). Open Studio. Expected: a translucent colored box appears around the mesh at the right place; toggling the eye hides/shows it; selecting it brightens it.

- [ ] **Step 4: Commit** — `feat(studio): volume mask rendering as translucent shapes`.

---

### Task B5: Surface mask rendering (triangle overlay)

**Files:**
- Modify: `HaybaStudioViewportClient.cpp` (highlight the mask's triangle set)
- Modify: `HaybaMCPToolkit.Build.cs` (add `MeshDescription`, `StaticMeshDescription` if reading triangle data)

**Interfaces:**
- Produces: surface masks (with `triangles:int[]`) rendered as a colored overlay on those faces of the preview mesh.

- [ ] **Step 1: Add Build.cs deps** (`MeshDescription`, `StaticMeshDescription`).

- [ ] **Step 2: Render the triangle set** — in the client `Draw`, for each non-hidden surface mask, read the preview mesh LOD0 vertex/index buffer (`UStaticMesh::GetRenderData()->LODResources[0]`), and for each triangle index in `mask.triangles`, `PDI->DrawLine` the three edges (and optionally a translucent filled tri) in the mask color. (Filled overlay via a dynamic mesh is an optional refinement; wire-tri overlay is the v1 gate.)

- [ ] **Step 3: Build (editor closed) + visual check.** Author a surface mask with a few triangle indices. Open Studio. Expected: those faces are outlined/tinted in the mask color; eye toggle works.

- [ ] **Step 4: Commit** — `feat(studio): surface mask rendering (triangle overlay)`.

---

### Task B6: Constraint node graph (SGraphEditor, typed closed schema)

**Files:**
- Create: `Studio/Graph/HaybaConstraintGraph.h`/`.cpp` (`UEdGraph` subclass)
- Create: `Studio/Graph/HaybaConstraintGraphSchema.h`/`.cpp` (`UEdGraphSchema` subclass — the closed palette + typed pins)
- Create: `Studio/Graph/HaybaConstraintGraphNode.h`/`.cpp` (`UEdGraphNode` subclass with a `kind` enum: Mask/Geometry/Primitive/Gate/Verdict)
- Modify: `SHaybaSemanticStudio.cpp` (host an `SGraphEditor` in the bottom region)
- Modify: `HaybaMCPToolkit.Build.cs` (add `GraphEditor`, `ToolMenus`, `EditorStyle`)

**Interfaces:**
- Produces: a typed constraint graph editor. Node kinds limited to the 5; pins typed by a category string (`Region`/`Geometry`/`Result`/`Flow`); the schema's `GetGraphContextActions` offers ONLY the closed palette (mask nodes from the loaded profile, the geometry node, the 11 primitive nodes, gate nodes, the verdict node). `CanCreateConnection` enforces pin-type compatibility (Region/Geometry → primitive input; Result → gate; gate → verdict).

- [ ] **Step 1: Add Build.cs deps** (`GraphEditor`, `ToolMenus`, `EditorStyle`).

- [ ] **Step 2: Node + schema classes** — `UHaybaConstraintGraphNode` with an `EHaybaNodeKind` and (for primitive nodes) a `FString PrimitiveId` + a params map; `AllocateDefaultPins` creates typed pins per kind. `UHaybaConstraintGraphSchema::GetGraphContextActions` lists the closed palette; `CanCreateConnection` returns disallowed for type-mismatched pins (this is the typed-closed guarantee). Written against the compiler.

- [ ] **Step 3: Host the SGraphEditor** — replace the bottom placeholder with `SGraphEditor` bound to a `UHaybaConstraintGraph` instance; populate mask nodes from the loaded profile's masks.

- [ ] **Step 4: Persistence + compile-to-constraints** — serialize the graph (nodes+edges) into the profile JSON under a `constraint_graph` key, and on save also compile it to `constraints.json` entries (mirror Plan A's `compileGraph`: one constraint per primitive node, mask edge → `params.mask`, binding = `{asset: AssetPath}`). The plugin writes the JSON directly (same stores the TS reads).

- [ ] **Step 5: Build (editor closed) + visual check.** Open Studio. Expected: the bottom shows a UE5 node graph; right-click offers only the closed palette; mask nodes appear; wiring a Region pin into a `grounded` (Geometry) node is rejected; wiring a mask into `inside_outside` then saving writes a constraint to `constraints.json` (verify with `plumb_constraint_list`).

- [ ] **Step 6: Commit** — `feat(studio): closed typed constraint node graph + compile to stores`.

---

### Task B7: Integration pass + memory update

- [ ] **Step 1: Full visual smoke** — close/reopen editor; open Studio on a baked SM with a volume mask, a surface mask, and a 2-node graph. Confirm: masks list + render, inspector lock toggle persists to `profiles.json`, graph saves + compiles to `constraints.json`, and `plumb_validate` over a sample instance reflects the authored constraint.
- [ ] **Step 2: Confirm core still loads with optional satellites disabled** (no regression to the satellite decoupling) — launch once with the GAS satellite disabled, confirm no load error and the Studio still opens.
- [ ] **Step 3: Update `project_mcp_ux_validation_overhaul` memory** with Plan B completion + what remains (Plan C: library browser, bulk ops, green/red overlay, QoL; the `plumb_study` AI-orchestration tool).
- [ ] **Step 4: No extra commit** (covered by per-task commits).

---

## Self-Review

**Spec coverage (design §3, §4, §5):**
- §3.1 window shell (4 regions) → B1. ✔
- §5 mask data model load + §3.1 mask list/inspector → B2. ✔
- §3.1 viewport (SM canvas) → B3. ✔
- §2.1 volume masks as translucent shapes → B4. ✔
- §2.1 surface masks (painted faces / triangle set) → B5. ✔
- §4 closed typed node graph + compile to evaluator → B6. ✔
- §6 `plumb_study` AI orchestration → deferred to Plan C (needs the "Study" button to signal the agent via a plan-events-style file). Noted.
- §7/§8/§10 library/bulk/QoL/overlay → Plan C. Out of scope.

**Placeholder scan:** UE Slate/UEdGraph code in B3-B6 is described structurally with exact classes/signatures + compile+visual gates rather than full verbatim bodies, because these APIs require compiler iteration; this is an intentional, flagged deviation from the TDD/complete-code format (see the plan header). B1-B2 carry complete code.

**Type consistency:** `FHaybaStudioMask`/`FHaybaStudioProfile` (B2) are the single mask/profile representation consumed by B3-B6; the graph compile (B6) emits the same `constraints.json` shape Plan A's `compileGraph` produces; node kinds are the same 5 across B6 and the spec.

**Scope:** Plan B is the UE window only; library/bulk/overlay/study are Plan C. Serial execution, editor-closed builds. ✔
