# PCGEx MCP Debug Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured AI debugging protocol to the PCGEx MCP — per-node execution data from UE, debug node cleanup, and a plugin UI mode dial that controls how inquisitive Claude is during debugging.

**Architecture:** Three new C++ TCP commands expose execution data + config + debug node removal. Four new TypeScript MCP tools wrap these commands and implement the Fast (single-pass) and Thorough (5-phase doctor) debug workflows. A new Slate UI section in the wizard panel lets the user select the inquisitiveness mode, which Claude reads via `get_bridge_config` before every debug session.

**Tech Stack:** Unreal Engine 5.7 C++ (Slate, PCG API, GConfig), TypeScript 5.6, Zod 3.x, MCP SDK, Vitest

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `Plugins/.../Private/PCGExBridgeSettings.h` | Add `EPCGExInquisitivenessMode` enum + 2 new fields |
| Modify | `Plugins/.../Private/PCGExBridgeSettings.cpp` | Load/save 2 new fields from GConfig |
| Modify | `Plugins/.../Public/PCGExBridgeCommandHandler.h` | Declare 3 new command methods |
| Modify | `Plugins/.../Private/PCGExBridgeCommandHandler.cpp` | Register + implement 3 new commands |
| Modify | `Plugins/.../Private/PCGExWizardWidget.h` | Add `BuildDebugBehaviorPanel()` declaration + combo box member |
| Modify | `Plugins/.../Private/PCGExWizardWidget.cpp` | Implement + wire `BuildDebugBehaviorPanel()` into settings |
| Create | `src/tools/read-node-output.ts` | MCP tool: wraps `get_node_execution_data` |
| Create | `src/tools/remove-debug-nodes.ts` | MCP tool: wraps `remove_debug_nodes`, never silent |
| Create | `src/tools/debug-graph.ts` | MCP tool: Fast mode single-pass debug workflow |
| Create | `src/tools/start-debug-session.ts` | MCP tool: Thorough mode 5-phase doctor workflow |
| Modify | `src/tools/index.ts` | Register 4 new tools |
| Modify | `src/dashboard/api.ts` | Add 2 new REST endpoints for new commands |

All C++ files are under:
`D:/hayba/packages/pcgex/Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/`

All TS files are under:
`D:/hayba/packages/pcgex/src/`

---

## Task 1: Add inquisitiveness settings to C++ settings class

**Files:**
- Modify: `Private/PCGExBridgeSettings.h`
- Modify: `Private/PCGExBridgeSettings.cpp`

- [ ] **Step 1: Add enum and fields to header**

Open `Private/PCGExBridgeSettings.h`. Add before the class declaration:

```cpp
/** Controls how many confirmation steps Claude performs during a debug session. */
enum class EPCGExInquisitivenessMode : uint8
{
    Silent,   // Claude diagnoses and fixes automatically; only cleanup asks
    Fast,     // Single diagnosis confirmation + single fix confirmation
    Thorough  // 5-phase doctor protocol: confirm symptoms, hypothesis, evidence, fix, cleanup
};
```

Inside the `FPCGExBridgeSettings` class body, after `HasApiKey()`:

```cpp
// AI debug behavior
EPCGExInquisitivenessMode InquisitivenessMode = EPCGExInquisitivenessMode::Thorough;
bool bAlwaysConfirmDebugNodeRemoval = true;

/** Returns "silent" | "fast" | "thorough" as a lowercase string for the TCP response. */
FString GetInquisitivenessModeString() const
{
    switch (InquisitivenessMode)
    {
    case EPCGExInquisitivenessMode::Silent:   return TEXT("silent");
    case EPCGExInquisitivenessMode::Fast:     return TEXT("fast");
    default:                                  return TEXT("thorough");
    }
}

/** Sets InquisitivenessMode from a lowercase string. */
void SetInquisitivenessModeFromString(const FString& Value)
{
    if (Value == TEXT("silent"))       InquisitivenessMode = EPCGExInquisitivenessMode::Silent;
    else if (Value == TEXT("fast"))    InquisitivenessMode = EPCGExInquisitivenessMode::Fast;
    else                               InquisitivenessMode = EPCGExInquisitivenessMode::Thorough;
}
```

Add private key constants (alongside the existing `KeyOutputPath`):

```cpp
static constexpr const TCHAR* KeyInquisitivenessMode          = TEXT("InquisitivenessMode");
static constexpr const TCHAR* KeyAlwaysConfirmDebugNodeRemoval = TEXT("AlwaysConfirmDebugNodeRemoval");
```

- [ ] **Step 2: Load/save new fields in settings cpp**

Open `Private/PCGExBridgeSettings.cpp`. In `Load()`, after the existing four `GConfig->GetString` lines:

```cpp
FString InquisitivenessStr;
GConfig->GetString(Section, KeyInquisitivenessMode, InquisitivenessStr, GEditorPerProjectIni);
if (!InquisitivenessStr.IsEmpty()) SetInquisitivenessModeFromString(InquisitivenessStr);

bool bConfirm = true;
GConfig->GetBool(Section, KeyAlwaysConfirmDebugNodeRemoval, bConfirm, GEditorPerProjectIni);
bAlwaysConfirmDebugNodeRemoval = bConfirm;
```

In `Save()`, after the existing four `GConfig->SetString` lines:

```cpp
GConfig->SetString(Section, KeyInquisitivenessMode,
    *GetInquisitivenessModeString(), GEditorPerProjectIni);
GConfig->SetBool(Section, KeyAlwaysConfirmDebugNodeRemoval,
    bAlwaysConfirmDebugNodeRemoval, GEditorPerProjectIni);
```

- [ ] **Step 3: Verify the project compiles**

```bash
"C:/Program Files/Epic Games/UE_5.7/Engine/Build/BatchFiles/Build.bat" Hayba_PcgEx_MCPEditor Win64 Development "D:/UnrealEngine/geoforge/geoforge.uproject" -waitmutex 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL` with no errors.

- [ ] **Step 4: Commit**

```bash
cd D:/hayba
git add packages/pcgex/Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExBridgeSettings.h
git add packages/pcgex/Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExBridgeSettings.cpp
git commit -m "feat(pcgex-cpp): add InquisitivenessMode + AlwaysConfirmDebugNodeRemoval to settings"
```

---

## Task 2: Add `get_bridge_config` TCP command

**Files:**
- Modify: `Public/PCGExBridgeCommandHandler.h`
- Modify: `Private/PCGExBridgeCommandHandler.cpp`

- [ ] **Step 1: Declare the command in the header**

Open `Public/PCGExBridgeCommandHandler.h`. In the private section, after `Cmd_WizardChat`:

```cpp
FString Cmd_GetBridgeConfig(const TSharedPtr<FJsonObject>& Params, const FString& Id);
FString Cmd_GetNodeExecutionData(const TSharedPtr<FJsonObject>& Params, const FString& Id);
FString Cmd_RemoveDebugNodes(const TSharedPtr<FJsonObject>& Params, const FString& Id);
```

(All three declared together — they will be implemented in Tasks 2, 3, and 4.)

- [ ] **Step 2: Register the command in the constructor**

Open `Private/PCGExBridgeCommandHandler.cpp`. In `FPCGExBridgeCommandHandler::FPCGExBridgeCommandHandler()`, after the `wizard_chat` line:

```cpp
CommandMap.Add(TEXT("get_bridge_config"),       &FPCGExBridgeCommandHandler::Cmd_GetBridgeConfig);
CommandMap.Add(TEXT("get_node_execution_data"), &FPCGExBridgeCommandHandler::Cmd_GetNodeExecutionData);
CommandMap.Add(TEXT("remove_debug_nodes"),      &FPCGExBridgeCommandHandler::Cmd_RemoveDebugNodes);
```

- [ ] **Step 3: Add the include for settings**

At the top of `PCGExBridgeCommandHandler.cpp`, after existing includes, add if not already present:

```cpp
#include "PCGExBridgeSettings.h"
```

- [ ] **Step 4: Implement `Cmd_GetBridgeConfig`**

At the bottom of `PCGExBridgeCommandHandler.cpp`, add:

```cpp
FString FPCGExBridgeCommandHandler::Cmd_GetBridgeConfig(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetStringField(TEXT("inquisitivenessMode"), S.GetInquisitivenessModeString());
    Data->SetBoolField(TEXT("alwaysConfirmDebugNodeRemoval"), S.bAlwaysConfirmDebugNodeRemoval);
    Data->SetNumberField(TEXT("tcpPort"), 52342);
    Data->SetNumberField(TEXT("dashboardPort"), 52341);
    Data->SetStringField(TEXT("pluginVersion"), TEXT("0.2.0"));

    return MakeOkResponse(Id, Data);
}
```

- [ ] **Step 5: Add stub implementations for the two remaining commands (so it compiles)**

```cpp
FString FPCGExBridgeCommandHandler::Cmd_GetNodeExecutionData(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    return MakeErrorResponse(Id, TEXT("get_node_execution_data: not yet implemented"));
}

FString FPCGExBridgeCommandHandler::Cmd_RemoveDebugNodes(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    return MakeErrorResponse(Id, TEXT("remove_debug_nodes: not yet implemented"));
}
```

- [ ] **Step 6: Build and verify**

```bash
"C:/Program Files/Epic Games/UE_5.7/Engine/Build/BatchFiles/Build.bat" Hayba_PcgEx_MCPEditor Win64 Development "D:/UnrealEngine/geoforge/geoforge.uproject" -waitmutex 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 7: Commit**

```bash
cd D:/hayba
git add packages/pcgex/Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Public/PCGExBridgeCommandHandler.h
git add packages/pcgex/Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExBridgeCommandHandler.cpp
git commit -m "feat(pcgex-cpp): add get_bridge_config command + stubs for get_node_execution_data and remove_debug_nodes"
```

---

## Task 3: Implement `get_node_execution_data` TCP command

**Files:**
- Modify: `Private/PCGExBridgeCommandHandler.cpp`

This command loads the graph, finds or creates a PCG component pointing at it, forces execution, then walks each node's output pins to collect point counts, attribute names, sample rows, and execution status.

- [ ] **Step 1: Add required includes**

At the top of `PCGExBridgeCommandHandler.cpp`, add after existing includes:

```cpp
#include "PCGComponent.h"
#include "PCGSubsystem.h"
#include "Data/PCGPointData.h"
#include "EngineUtils.h"
```

- [ ] **Step 2: Replace the stub with the full implementation**

Replace the `Cmd_GetNodeExecutionData` stub with:

```cpp
FString FPCGExBridgeCommandHandler::Cmd_GetNodeExecutionData(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    FString AssetPath;
    if (!Params->TryGetStringField(TEXT("assetPath"), AssetPath))
        return MakeErrorResponse(Id, TEXT("Missing required param: assetPath"));

    int32 MaxSampleRows = 10;
    Params->TryGetNumberField(TEXT("maxSampleRows"), MaxSampleRows);

    UPCGGraph* Graph = LoadObject<UPCGGraph>(nullptr, *AssetPath);
    if (!Graph)
        return MakeErrorResponse(Id, FString::Printf(TEXT("Graph not found: %s"), *AssetPath));

    // Find a UPCGComponent using this graph in the current world
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
        return MakeErrorResponse(Id, TEXT("No editor world available"));

    UPCGComponent* TargetComp = nullptr;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        UPCGComponent* Comp = It->FindComponentByClass<UPCGComponent>();
        if (Comp && Comp->GetGraph() == Graph)
        {
            TargetComp = Comp;
            break;
        }
    }

    if (!TargetComp)
        return MakeErrorResponse(Id, TEXT("No actor with this PCGGraph found in the current level. Place an actor with a PCGComponent using this graph, then retry."));

    // Force a fresh execution (synchronous)
    TargetComp->GenerateLocal(/*bForce=*/true);

    // Walk nodes and collect output data
    const TArray<UPCGNode*>& Nodes = Graph->GetNodes();
    TArray<TSharedPtr<FJsonValue>> NodesArray;

    for (int32 i = 0; i < Nodes.Num(); ++i)
    {
        UPCGNode* Node = Nodes[i];
        if (!Node) continue;

        FString NodeId = FString::Printf(TEXT("node_%03d"), i);
        FString NodeClass = Node->GetSettings()
            ? Node->GetSettings()->GetClass()->GetName()
            : TEXT("Unknown");
        FString NodeLabel = Node->GetNodeTitle(EPCGNodeTitleType::ListView).ToString();

        TSharedPtr<FJsonObject> NodeJson = MakeShareable(new FJsonObject());
        NodeJson->SetStringField(TEXT("id"), NodeId);
        NodeJson->SetStringField(TEXT("class"), NodeClass);
        NodeJson->SetStringField(TEXT("label"), NodeLabel);

        // Collect output pin data
        TArray<TSharedPtr<FJsonValue>> OutputPinNames;
        TArray<TSharedPtr<FJsonValue>> AttributeNames;
        TArray<TSharedPtr<FJsonValue>> SampleRows;
        int32 TotalPointCount = 0;
        FString Status = TEXT("executed");
        FString ErrorMessage;

        for (const UPCGPin* OutPin : Node->GetOutputPins())
        {
            if (!OutPin) continue;
            OutputPinNames.Add(MakeShareable(new FJsonValueString(OutPin->Properties.Label.ToString())));

            // Try to get cached output data from the component
            FPCGDataCollection PinOutput;
            if (TargetComp->GetGeneratedGraphOutput(Node, OutPin->Properties.Label, PinOutput))
            {
                for (const FPCGTaggedData& TaggedData : PinOutput.TaggedData)
                {
                    if (const UPCGPointData* PointData = Cast<UPCGPointData>(TaggedData.Data))
                    {
                        const TArray<FPCGPoint>& Points = PointData->GetPoints();
                        TotalPointCount += Points.Num();

                        // Collect attribute names from metadata
                        if (const UPCGMetadata* Meta = PointData->ConstMetadata())
                        {
                            TArray<FName> AttrNames;
                            Meta->GetAllAttributeNames(AttrNames);
                            for (const FName& AttrName : AttrNames)
                            {
                                FString AttrStr = AttrName.ToString();
                                // Avoid duplicates
                                bool bFound = false;
                                for (const TSharedPtr<FJsonValue>& Existing : AttributeNames)
                                {
                                    if (Existing->AsString() == AttrStr) { bFound = true; break; }
                                }
                                if (!bFound)
                                    AttributeNames.Add(MakeShareable(new FJsonValueString(AttrStr)));
                            }

                            // Sample rows (up to MaxSampleRows across all point data on this node)
                            int32 Remaining = MaxSampleRows - SampleRows.Num();
                            for (int32 pi = 0; pi < FMath::Min(Points.Num(), Remaining); ++pi)
                            {
                                const FPCGPoint& Pt = Points[pi];
                                TSharedPtr<FJsonObject> Row = MakeShareable(new FJsonObject());
                                Row->SetNumberField(TEXT("index"), pi);
                                Row->SetNumberField(TEXT("x"), Pt.Transform.GetLocation().X);
                                Row->SetNumberField(TEXT("y"), Pt.Transform.GetLocation().Y);
                                Row->SetNumberField(TEXT("z"), Pt.Transform.GetLocation().Z);
                                Row->SetNumberField(TEXT("density"), Pt.Density);
                                Row->SetNumberField(TEXT("seed"), Pt.Seed);
                                SampleRows.Add(MakeShareable(new FJsonValueObject(Row.ToSharedRef())));
                            }
                        }
                    }
                }
            }
            else
            {
                // Pin produced no output — node may have been skipped
                Status = TEXT("skipped");
            }
        }

        NodeJson->SetNumberField(TEXT("outputPointCount"), TotalPointCount);
        NodeJson->SetArrayField(TEXT("outputPins"), OutputPinNames);
        NodeJson->SetArrayField(TEXT("attributes"), AttributeNames);
        NodeJson->SetArrayField(TEXT("sampleRows"), SampleRows);
        NodeJson->SetStringField(TEXT("status"), Status);
        if (!ErrorMessage.IsEmpty())
            NodeJson->SetStringField(TEXT("errorMessage"), ErrorMessage);
        else
            NodeJson->SetNullField(TEXT("errorMessage"));

        NodesArray.Add(MakeShareable(new FJsonValueObject(NodeJson.ToSharedRef())));
    }

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetStringField(TEXT("assetPath"), AssetPath);
    Data->SetStringField(TEXT("executedAt"), FDateTime::UtcNow().ToIso8601());
    Data->SetArrayField(TEXT("nodes"), NodesArray);
    return MakeOkResponse(Id, Data);
}
```

**Note for implementer:** If `UPCGComponent::GetGeneratedGraphOutput()` does not exist in your UE5.7 PCG API, use the equivalent: iterate `TargetComp->GetGeneratedGraphOutput()` returning `FPCGDataCollection`, or use `UPCGSubsystem::GetOutputData()` with the graph's task ID. The interface varies across PCG versions — adapt accordingly. The key contract is: per-node, per-pin output point count + attribute names + sample rows.

- [ ] **Step 3: Build and verify**

```bash
"C:/Program Files/Epic Games/UE_5.7/Engine/Build/BatchFiles/Build.bat" Hayba_PcgEx_MCPEditor Win64 Development "D:/UnrealEngine/geoforge/geoforge.uproject" -waitmutex 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
cd D:/hayba
git add packages/pcgex/Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExBridgeCommandHandler.cpp
git commit -m "feat(pcgex-cpp): implement get_node_execution_data — per-node point count, attributes, sample rows"
```

---

## Task 4: Implement `remove_debug_nodes` TCP command

**Files:**
- Modify: `Private/PCGExBridgeCommandHandler.cpp`

This command finds all nodes whose label starts with `labelPrefix`, removes them from the graph, and rewires the edges that passed through them.

- [ ] **Step 1: Replace the `remove_debug_nodes` stub with the full implementation**

```cpp
FString FPCGExBridgeCommandHandler::Cmd_RemoveDebugNodes(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    FString AssetPath;
    if (!Params->TryGetStringField(TEXT("assetPath"), AssetPath))
        return MakeErrorResponse(Id, TEXT("Missing required param: assetPath"));

    FString LabelPrefix = TEXT("DBG");
    Params->TryGetStringField(TEXT("labelPrefix"), LabelPrefix);

    UPCGGraph* Graph = LoadObject<UPCGGraph>(nullptr, *AssetPath);
    if (!Graph)
        return MakeErrorResponse(Id, FString::Printf(TEXT("Graph not found: %s"), *AssetPath));

    // Collect debug nodes by label prefix
    TArray<UPCGNode*> DebugNodes;
    for (UPCGNode* Node : Graph->GetNodes())
    {
        if (!Node) continue;
        FString Label = Node->GetNodeTitle(EPCGNodeTitleType::ListView).ToString();
        if (Label.StartsWith(LabelPrefix))
            DebugNodes.Add(Node);
    }

    int32 Removed = 0;
    int32 Rewired = 0;

    for (UPCGNode* DebugNode : DebugNodes)
    {
        // For each debug node: find upstream source and downstream target
        // A debug node has exactly one input pin connected to an upstream node
        // and one output pin connected to the downstream node it was injected between.
        for (const UPCGPin* InPin : DebugNode->GetInputPins())
        {
            if (!InPin) continue;
            for (const UPCGEdge* InEdge : InPin->Edges)
            {
                if (!InEdge || !InEdge->InputPin) continue;
                UPCGPin* UpstreamOutputPin = const_cast<UPCGPin*>(InEdge->InputPin);

                // Find downstream nodes connected to this debug node's output
                for (const UPCGPin* OutPin : DebugNode->GetOutputPins())
                {
                    if (!OutPin) continue;
                    for (const UPCGEdge* OutEdge : OutPin->Edges)
                    {
                        if (!OutEdge || !OutEdge->OutputPin) continue;
                        UPCGPin* DownstreamInputPin = const_cast<UPCGPin*>(OutEdge->OutputPin);

                        // Rewire: connect upstream → downstream directly
                        Graph->AddEdge(UpstreamOutputPin->Node,
                                       UpstreamOutputPin->Properties.Label,
                                       DownstreamInputPin->Node,
                                       DownstreamInputPin->Properties.Label);
                        ++Rewired;
                    }
                }
            }
        }

        // Remove the debug node
        Graph->RemoveNode(DebugNode);
        ++Removed;
    }

    // Mark the graph package dirty so it can be saved
    if (Removed > 0)
    {
        Graph->MarkPackageDirty();
    }

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetNumberField(TEXT("removed"), Removed);
    Data->SetNumberField(TEXT("rewired"), Rewired);
    Data->SetStringField(TEXT("assetPath"), AssetPath);
    return MakeOkResponse(Id, Data);
}
```

**Note for implementer:** `UPCGGraph::RemoveNode()` and `UPCGGraph::AddEdge()` are the standard PCG graph mutation API. If the exact method signatures differ in UE5.7, check `PCGGraph.h` — the pattern is consistent. Ensure you call `Graph->NotifyGraphChanged()` if required by your PCG version to refresh the editor view.

- [ ] **Step 2: Build and verify**

```bash
"C:/Program Files/Epic Games/UE_5.7/Engine/Build/BatchFiles/Build.bat" Hayba_PcgEx_MCPEditor Win64 Development "D:/UnrealEngine/geoforge/geoforge.uproject" -waitmutex 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
cd D:/hayba
git add packages/pcgex/Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExBridgeCommandHandler.cpp
git commit -m "feat(pcgex-cpp): implement remove_debug_nodes — remove by label prefix and rewire edges"
```

---

## Task 5: Add AI Debug Behavior UI section to the wizard widget

**Files:**
- Modify: `Private/PCGExWizardWidget.h`
- Modify: `Private/PCGExWizardWidget.cpp`

- [ ] **Step 1: Add declaration to the header**

Open `Private/PCGExWizardWidget.h`. In the private section, after `BuildSettingsPanel()`:

```cpp
TSharedRef<SWidget> BuildDebugBehaviorPanel();
FReply OnSaveDebugSettings();
```

Add a member for the combo selection (after `bSettingsVisible`):

```cpp
TSharedPtr<FString> SelectedInquisitivenessMode;
TArray<TSharedPtr<FString>> InquisitivenessModeOptions;
bool bAlwaysConfirmRemoval = true;
```

- [ ] **Step 2: Implement `BuildDebugBehaviorPanel()`**

Open `Private/PCGExWizardWidget.cpp`. Add after the `BuildSettingsPanel()` function body:

```cpp
TSharedRef<SWidget> SPCGExWizardWidget::BuildDebugBehaviorPanel()
{
    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    bAlwaysConfirmRemoval = S.bAlwaysConfirmDebugNodeRemoval;

    // Build options list
    InquisitivenessModeOptions = {
        MakeShareable(new FString(TEXT("silent"))),
        MakeShareable(new FString(TEXT("fast"))),
        MakeShareable(new FString(TEXT("thorough")))
    };

    // Set current selection
    FString CurrentMode = S.GetInquisitivenessModeString();
    SelectedInquisitivenessMode = InquisitivenessModeOptions[2]; // default: thorough
    for (auto& Opt : InquisitivenessModeOptions)
    {
        if (*Opt == CurrentMode) { SelectedInquisitivenessMode = Opt; break; }
    }

    return SNew(SBorder)
        .BorderBackgroundColor(ColorPanel)
        .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
        .Padding(FMargin(12, 8))
        [
            SNew(SVerticalBox)

            // Section title
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 6)
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("AI Debug Behavior")))
                .Font(BoldFont(9))
                .ColorAndOpacity(ColorAccent)
            ]

            // Mode label
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("Inquisitiveness Mode")))
                .Font(RegFont(8))
                .ColorAndOpacity(ColorSubtext)
            ]

            // Combo box
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                SNew(SComboBox<TSharedPtr<FString>>)
                .OptionsSource(&InquisitivenessModeOptions)
                .InitiallySelectedItem(SelectedInquisitivenessMode)
                .OnSelectionChanged_Lambda([this](TSharedPtr<FString> NewVal, ESelectInfo::Type)
                {
                    SelectedInquisitivenessMode = NewVal;
                })
                .OnGenerateWidget_Lambda([](TSharedPtr<FString> Item) -> TSharedRef<SWidget>
                {
                    FString Label = Item.IsValid() ? *Item : TEXT("thorough");
                    FString Desc;
                    if (Label == TEXT("silent"))        Desc = TEXT("silent — diagnose & fix automatically");
                    else if (Label == TEXT("fast"))     Desc = TEXT("fast — single diagnosis, one confirmation");
                    else                                Desc = TEXT("thorough — confirm each step (recommended)");
                    return SNew(STextBlock)
                        .Text(FText::FromString(Desc))
                        .Font(RegFont(8))
                        .Margin(FMargin(4, 2));
                })
                [
                    SNew(STextBlock)
                    .Text_Lambda([this]() -> FText
                    {
                        if (!SelectedInquisitivenessMode.IsValid()) return FText::FromString(TEXT("thorough"));
                        return FText::FromString(*SelectedInquisitivenessMode);
                    })
                    .Font(RegFont(8))
                ]
            ]

            // Always-confirm checkbox
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                SNew(SCheckBox)
                .IsChecked_Lambda([this]() { return bAlwaysConfirmRemoval ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
                .OnCheckStateChanged_Lambda([this](ECheckBoxState State)
                {
                    bAlwaysConfirmRemoval = (State == ECheckBoxState::Checked);
                })
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(TEXT("Always ask before removing debug nodes")))
                    .Font(RegFont(8))
                    .ColorAndOpacity(ColorText)
                ]
            ]

            // Save button
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SButton)
                .ButtonColorAndOpacity(ColorAccentDim)
                .OnClicked(this, &SPCGExWizardWidget::OnSaveDebugSettings)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(TEXT("Save Debug Settings")))
                    .Font(BoldFont(8))
                    .ColorAndOpacity(ColorText)
                    .Justification(ETextJustify::Center)
                ]
            ]
        ];
}

FReply SPCGExWizardWidget::OnSaveDebugSettings()
{
    FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    if (SelectedInquisitivenessMode.IsValid())
        S.SetInquisitivenessModeFromString(*SelectedInquisitivenessMode);
    S.bAlwaysConfirmDebugNodeRemoval = bAlwaysConfirmRemoval;
    S.Save();
    UE_LOG(LogPCGExWizard, Log, TEXT("Debug settings saved: mode=%s, confirmRemoval=%d"),
        *S.GetInquisitivenessModeString(), (int32)S.bAlwaysConfirmDebugNodeRemoval);
    return FReply::Handled();
}
```

- [ ] **Step 3: Wire the panel into the settings section**

In `Construct()`, inside the settings panel slot (the `SBox` with `GetSettingsPanelVisibility`), the widget currently calls `BuildSettingsPanel()`. Wrap both panels in a `SVerticalBox`:

Find the block:
```cpp
SNew(SBox)
.Visibility(this, &SPCGExWizardWidget::GetSettingsPanelVisibility)
[
    BuildSettingsPanel()
]
```

Replace with:
```cpp
SNew(SBox)
.Visibility(this, &SPCGExWizardWidget::GetSettingsPanelVisibility)
[
    SNew(SVerticalBox)
    + SVerticalBox::Slot().AutoHeight()
    [ BuildSettingsPanel() ]
    + SVerticalBox::Slot().AutoHeight().Padding(0, 4, 0, 0)
    [ BuildDebugBehaviorPanel() ]
]
```

- [ ] **Step 4: Build and verify**

```bash
"C:/Program Files/Epic Games/UE_5.7/Engine/Build/BatchFiles/Build.bat" Hayba_PcgEx_MCPEditor Win64 Development "D:/UnrealEngine/geoforge/geoforge.uproject" -waitmutex 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit**

```bash
cd D:/hayba
git add packages/pcgex/Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExWizardWidget.h
git add packages/pcgex/Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExWizardWidget.cpp
git commit -m "feat(pcgex-cpp): add AI Debug Behavior panel to wizard widget with inquisitiveness mode combo + confirm checkbox"
```

---

## Task 6: TypeScript tool — `read_node_output`

**Files:**
- Create: `src/tools/read-node-output.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/read-node-output.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../tcp-client.js', () => ({
  ensureConnected: vi.fn().mockResolvedValue({
    send: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        assetPath: '/Game/Test/Graph',
        executedAt: '2026-04-05T00:00:00Z',
        nodes: [
          {
            id: 'node_000',
            class: 'PCGExBuildDelaunayGraph2DSettings',
            label: 'Delaunay 2D',
            outputPointCount: 0,
            outputPins: ['Vtx', 'Edges'],
            attributes: [],
            sampleRows: [],
            status: 'skipped',
            errorMessage: null,
          },
        ],
      },
    }),
  }),
}));

import { readNodeOutput } from './read-node-output.js';

describe('readNodeOutput', () => {
  it('returns execution data for a valid asset path', async () => {
    const result = await readNodeOutput({ assetPath: '/Game/Test/Graph' });
    expect(result).toHaveProperty('nodes');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('node_000');
    expect(result.nodes[0].outputPointCount).toBe(0);
  });

  it('passes maxSampleRows to the command', async () => {
    const { ensureConnected } = await import('../tcp-client.js');
    const mockSend = vi.fn().mockResolvedValue({ ok: true, data: { nodes: [] } });
    (ensureConnected as any).mockResolvedValue({ send: mockSend });

    await readNodeOutput({ assetPath: '/Game/Test/Graph', maxSampleRows: 5 });
    expect(mockSend).toHaveBeenCalledWith('get_node_execution_data', {
      assetPath: '/Game/Test/Graph',
      maxSampleRows: 5,
    });
  });

  it('throws when UE returns an error', async () => {
    const { ensureConnected } = await import('../tcp-client.js');
    (ensureConnected as any).mockResolvedValue({
      send: vi.fn().mockResolvedValue({ ok: false, error: 'Graph not found' }),
    });

    await expect(readNodeOutput({ assetPath: '/Game/Missing' }))
      .rejects.toThrow('Graph not found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd D:/hayba/packages/pcgex && npx vitest run src/tools/read-node-output.test.ts 2>&1
```

Expected: `FAIL` — `Cannot find module './read-node-output.js'`

- [ ] **Step 3: Implement the tool**

Create `src/tools/read-node-output.ts`:

```typescript
import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph, e.g. /Game/PCGExBridge/Generated/MyGraph'),
  maxSampleRows: z.number().int().min(1).max(100).optional()
    .describe('Max attribute rows to return per node (default 10). Use lower values for large graphs.'),
});

export type ReadNodeOutputParams = z.infer<typeof schema>;

export interface NodeExecutionData {
  id: string;
  class: string;
  label: string;
  outputPointCount: number;
  outputPins: string[];
  attributes: string[];
  sampleRows: Array<{ index: number; x: number; y: number; z: number; density: number; seed: number }>;
  status: 'executed' | 'skipped' | 'error';
  errorMessage: string | null;
}

export interface GraphExecutionData {
  assetPath: string;
  executedAt: string;
  nodes: NodeExecutionData[];
}

export async function readNodeOutput(params: ReadNodeOutputParams): Promise<GraphExecutionData> {
  const { assetPath, maxSampleRows } = schema.parse(params);

  const client = await ensureConnected();
  const response = await client.send('get_node_execution_data', {
    assetPath,
    ...(maxSampleRows !== undefined && { maxSampleRows }),
  });

  if (!response.ok) {
    throw new Error(response.error || 'get_node_execution_data failed');
  }

  return response.data as GraphExecutionData;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/hayba/packages/pcgex && npx vitest run src/tools/read-node-output.test.ts 2>&1
```

Expected: all 3 tests `PASS`.

- [ ] **Step 5: Type-check**

```bash
cd D:/hayba/packages/pcgex && npx tsc --noEmit 2>&1
```

Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
cd D:/hayba
git add packages/pcgex/src/tools/read-node-output.ts packages/pcgex/src/tools/read-node-output.test.ts
git commit -m "feat(pcgex-mcp): add read_node_output tool — wraps get_node_execution_data"
```

---

## Task 7: TypeScript tool — `remove_debug_nodes`

**Files:**
- Create: `src/tools/remove-debug-nodes.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/remove-debug-nodes.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../tcp-client.js', () => ({
  ensureConnected: vi.fn().mockResolvedValue({
    send: vi.fn().mockResolvedValue({
      ok: true,
      data: { removed: 3, rewired: 3, assetPath: '/Game/Test/Graph' },
    }),
  }),
}));

import { removeDebugNodes } from './remove-debug-nodes.js';

describe('removeDebugNodes', () => {
  it('returns removed and rewired counts', async () => {
    const result = await removeDebugNodes({ assetPath: '/Game/Test/Graph' });
    expect(result.removed).toBe(3);
    expect(result.rewired).toBe(3);
  });

  it('uses default labelPrefix DBG when not specified', async () => {
    const { ensureConnected } = await import('../tcp-client.js');
    const mockSend = vi.fn().mockResolvedValue({ ok: true, data: { removed: 0, rewired: 0 } });
    (ensureConnected as any).mockResolvedValue({ send: mockSend });

    await removeDebugNodes({ assetPath: '/Game/Test/Graph' });
    expect(mockSend).toHaveBeenCalledWith('remove_debug_nodes', {
      assetPath: '/Game/Test/Graph',
      labelPrefix: 'DBG',
    });
  });

  it('throws when UE returns an error', async () => {
    const { ensureConnected } = await import('../tcp-client.js');
    (ensureConnected as any).mockResolvedValue({
      send: vi.fn().mockResolvedValue({ ok: false, error: 'Graph not found' }),
    });

    await expect(removeDebugNodes({ assetPath: '/Game/Missing' }))
      .rejects.toThrow('Graph not found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd D:/hayba/packages/pcgex && npx vitest run src/tools/remove-debug-nodes.test.ts 2>&1
```

Expected: `FAIL` — `Cannot find module './remove-debug-nodes.js'`

- [ ] **Step 3: Implement the tool**

Create `src/tools/remove-debug-nodes.ts`:

```typescript
import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph'),
  labelPrefix: z.string().optional().default('DBG')
    .describe('Label prefix used to identify debug nodes (default: DBG). Only nodes whose label starts with this prefix are removed.'),
});

export type RemoveDebugNodesParams = z.infer<typeof schema>;

export async function removeDebugNodes(params: RemoveDebugNodesParams) {
  const { assetPath, labelPrefix } = schema.parse(params);

  const client = await ensureConnected();
  const response = await client.send('remove_debug_nodes', { assetPath, labelPrefix });

  if (!response.ok) {
    throw new Error(response.error || 'remove_debug_nodes failed');
  }

  return response.data as { removed: number; rewired: number; assetPath: string };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/hayba/packages/pcgex && npx vitest run src/tools/remove-debug-nodes.test.ts 2>&1
```

Expected: all 3 tests `PASS`.

- [ ] **Step 5: Type-check**

```bash
cd D:/hayba/packages/pcgex && npx tsc --noEmit 2>&1
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd D:/hayba
git add packages/pcgex/src/tools/remove-debug-nodes.ts packages/pcgex/src/tools/remove-debug-nodes.test.ts
git commit -m "feat(pcgex-mcp): add remove_debug_nodes tool — removes DBG-prefixed nodes and rewires edges"
```

---

## Task 8: TypeScript tool — `debug_graph` (Fast mode)

**Files:**
- Create: `src/tools/debug-graph.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/debug-graph.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

const mockExecutionData = {
  assetPath: '/Game/Test/Graph',
  executedAt: '2026-04-05T00:00:00Z',
  nodes: [
    { id: 'node_000', class: 'PCGPointSamplerSettings', label: 'Surface Sampler',
      outputPointCount: 100, outputPins: ['Points'], attributes: ['Position'], sampleRows: [], status: 'executed', errorMessage: null },
    { id: 'node_001', class: 'PCGExBuildDelaunayGraph2DSettings', label: 'Delaunay 2D',
      outputPointCount: 0, outputPins: ['Vtx', 'Edges'], attributes: [], sampleRows: [], status: 'skipped', errorMessage: null },
    { id: 'node_002', class: 'PCGExPathfindingSettings', label: 'Pathfinding',
      outputPointCount: 0, outputPins: ['Paths'], attributes: [], sampleRows: [], status: 'skipped', errorMessage: null },
  ],
};

vi.mock('./read-node-output.js', () => ({
  readNodeOutput: vi.fn().mockResolvedValue(mockExecutionData),
}));

import { findFirstFailingNode, buildDebugContext } from './debug-graph.js';

describe('findFirstFailingNode', () => {
  it('returns the first node with outputPointCount === 0 on a non-first node', () => {
    const suspect = findFirstFailingNode(mockExecutionData.nodes);
    expect(suspect?.id).toBe('node_001');
  });

  it('returns null when all nodes have output', () => {
    const allHealthy = mockExecutionData.nodes.map(n => ({ ...n, outputPointCount: 10, status: 'executed' as const }));
    expect(findFirstFailingNode(allHealthy)).toBeNull();
  });

  it('returns error-status nodes first', () => {
    const withError = [
      { ...mockExecutionData.nodes[0], status: 'error' as const, outputPointCount: 0, errorMessage: 'crash' },
      ...mockExecutionData.nodes.slice(1),
    ];
    const suspect = findFirstFailingNode(withError);
    expect(suspect?.status).toBe('error');
  });
});

describe('buildDebugContext', () => {
  it('returns a human-readable summary of the execution state', () => {
    const ctx = buildDebugContext(mockExecutionData.nodes);
    expect(ctx).toContain('node_001');
    expect(ctx).toContain('0 points');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd D:/hayba/packages/pcgex && npx vitest run src/tools/debug-graph.test.ts 2>&1
```

Expected: `FAIL` — `Cannot find module './debug-graph.js'`

- [ ] **Step 3: Implement the tool**

Create `src/tools/debug-graph.ts`:

```typescript
import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';
import { readNodeOutput, type NodeExecutionData, type GraphExecutionData } from './read-node-output.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph to debug'),
  suspectedNodes: z.array(z.string()).optional()
    .describe('Optional list of node IDs to focus the debug overlay on. If omitted, Claude picks the first node with 0 output.'),
});

export type DebugGraphParams = z.infer<typeof schema>;

/** Returns the first node that produced 0 output and is not the first node in the graph.
 *  Error-status nodes take priority. Returns null if all nodes look healthy. */
export function findFirstFailingNode(nodes: NodeExecutionData[]): NodeExecutionData | null {
  // Check for explicit errors first
  const errorNode = nodes.find(n => n.status === 'error');
  if (errorNode) return errorNode;

  // Skip index 0 (input/seed nodes legitimately have no upstream)
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i].outputPointCount === 0 || nodes[i].status === 'skipped') {
      return nodes[i];
    }
  }
  return null;
}

/** Builds a human-readable execution summary for Claude to include in its diagnosis. */
export function buildDebugContext(nodes: NodeExecutionData[]): string {
  return nodes.map(n =>
    `${n.id} (${n.label}): ${n.outputPointCount} points [${n.status}]${n.errorMessage ? ` — ERROR: ${n.errorMessage}` : ''}`
  ).join('\n');
}

export async function debugGraph(params: DebugGraphParams) {
  const { assetPath, suspectedNodes } = schema.parse(params);

  // Step 1: Read execution data to find the failing node
  const executionData: GraphExecutionData = await readNodeOutput({ assetPath, maxSampleRows: 10 });
  const suspect = suspectedNodes?.length
    ? executionData.nodes.find(n => suspectedNodes.includes(n.id)) ?? findFirstFailingNode(executionData.nodes)
    : findFirstFailingNode(executionData.nodes);

  const context = buildDebugContext(executionData.nodes);

  if (!suspect) {
    return {
      assetPath,
      allNodesHealthy: true,
      message: 'All nodes produced output. The issue may be downstream of the graph (spawning, filtering, or level placement).',
      executionSummary: context,
    };
  }

  // Step 2: Find edges going into the suspect node for targeted debug injection
  const client = await ensureConnected();
  const exportResp = await client.send('export_graph', { assetPath });
  if (!exportResp.ok) throw new Error(exportResp.error || 'export_graph failed');

  const graph = (exportResp.data as any)?.graph ?? exportResp.data;
  const suspectEdges = (graph?.edges ?? []).filter(
    (e: { toNode: string }) => e.toNode === suspect.id
  );

  return {
    assetPath,
    allNodesHealthy: false,
    suspectNode: {
      id: suspect.id,
      class: suspect.class,
      label: suspect.label,
      outputPointCount: suspect.outputPointCount,
      status: suspect.status,
      errorMessage: suspect.errorMessage,
      attributes: suspect.attributes,
      sampleRows: suspect.sampleRows,
    },
    suspectEdges,
    executionSummary: context,
    diagnosisPrompt:
      `I can see that "${suspect.label}" (${suspect.id}) produced ${suspect.outputPointCount} points` +
      (suspect.status === 'error' ? ` with error: ${suspect.errorMessage}` : ' (status: skipped)') +
      `. All nodes upstream appear healthy. ` +
      `I believe [CLAUDE: state your hypothesis here based on the node class and upstream output]. ` +
      `Does that match what you see?`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/hayba/packages/pcgex && npx vitest run src/tools/debug-graph.test.ts 2>&1
```

Expected: all 4 tests `PASS`.

- [ ] **Step 5: Type-check**

```bash
cd D:/hayba/packages/pcgex && npx tsc --noEmit 2>&1
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd D:/hayba
git add packages/pcgex/src/tools/debug-graph.ts packages/pcgex/src/tools/debug-graph.test.ts
git commit -m "feat(pcgex-mcp): add debug_graph tool — Fast mode single-pass debug with suspect node identification"
```

---

## Task 9: TypeScript tool — `start_debug_session` (Thorough mode)

**Files:**
- Create: `src/tools/start-debug-session.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/start-debug-session.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('./read-node-output.js', () => ({
  readNodeOutput: vi.fn().mockResolvedValue({
    assetPath: '/Game/Test/Graph',
    executedAt: '2026-04-05T00:00:00Z',
    nodes: [
      { id: 'node_000', class: 'PCGPointSamplerSettings', label: 'Surface Sampler',
        outputPointCount: 50, outputPins: ['Points'], attributes: ['Position'], sampleRows: [], status: 'executed', errorMessage: null },
      { id: 'node_001', class: 'PCGExBuildDelaunayGraph2DSettings', label: 'Delaunay 2D',
        outputPointCount: 0, outputPins: ['Vtx', 'Edges'], attributes: [], sampleRows: [], status: 'skipped', errorMessage: null },
    ],
  }),
}));

import { buildPhase1Response } from './start-debug-session.js';

describe('buildPhase1Response', () => {
  it('returns a phase 1 confirmation prompt citing the suspect node', async () => {
    const { readNodeOutput } = await import('./read-node-output.js');
    const execData = await (readNodeOutput as any)({});

    const resp = buildPhase1Response(execData.nodes, 'Graph generates nothing visible');
    expect(resp.phase).toBe(1);
    expect(resp.suspectNodeId).toBe('node_001');
    expect(resp.confirmationPrompt).toContain('node_001');
    expect(resp.confirmationPrompt).toContain('0 points');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd D:/hayba/packages/pcgex && npx vitest run src/tools/start-debug-session.test.ts 2>&1
```

Expected: `FAIL` — `Cannot find module './start-debug-session.js'`

- [ ] **Step 3: Implement the tool**

Create `src/tools/start-debug-session.ts`:

```typescript
import { z } from 'zod';
import { readNodeOutput, type NodeExecutionData, type GraphExecutionData } from './read-node-output.js';
import { findFirstFailingNode, buildDebugContext } from './debug-graph.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph to debug'),
  symptom: z.string().min(1)
    .describe('Description of the problem as observed by the user, e.g. "graph generates nothing", "wrong shape", "half the edges are missing"'),
});

export type StartDebugSessionParams = z.infer<typeof schema>;

export interface Phase1Response {
  phase: 1;
  assetPath: string;
  symptom: string;
  executionSummary: string;
  suspectNodeId: string | null;
  confirmationPrompt: string;
}

/** Builds the Phase 1 response: symptom confirmation with execution data. */
export function buildPhase1Response(nodes: NodeExecutionData[], symptom: string): Phase1Response {
  const suspect = findFirstFailingNode(nodes);
  const summary = buildDebugContext(nodes);

  const zeroOutputNodes = nodes.filter(n => n.outputPointCount === 0 && n.id !== nodes[0]?.id);
  const skippedNodes = nodes.filter(n => n.status === 'skipped');

  let prompt = `I read the execution data for this graph. Here's what I see:\n\n${summary}\n\n`;

  if (suspect) {
    prompt += `The first node with no output is **${suspect.label}** (${suspect.id}) — it produced ${suspect.outputPointCount} points (status: ${suspect.status}).`;
    if (suspect.errorMessage) prompt += ` Error: ${suspect.errorMessage}.`;
    prompt += ` All nodes upstream appear healthy.`;
  } else if (zeroOutputNodes.length > 0) {
    prompt += `Multiple nodes produced 0 points: ${zeroOutputNodes.map(n => n.label).join(', ')}.`;
  } else {
    prompt += `All nodes appear to have produced output — the issue may be downstream.`;
  }

  prompt += `\n\nYou reported: "${symptom}". Is this consistent with what you observed, or is the problem somewhere else?`;

  return {
    phase: 1,
    assetPath: nodes[0] ? '' : '',  // filled by caller
    symptom,
    executionSummary: summary,
    suspectNodeId: suspect?.id ?? null,
    confirmationPrompt: prompt,
  };
}

export async function startDebugSession(params: StartDebugSessionParams) {
  const { assetPath, symptom } = schema.parse(params);

  // Phase 1: read execution data and build symptom confirmation
  const executionData: GraphExecutionData = await readNodeOutput({ assetPath, maxSampleRows: 10 });
  const phase1 = buildPhase1Response(executionData.nodes, symptom);
  phase1.assetPath = assetPath;

  return {
    ...phase1,
    instructions:
      'PHASE 1 of 5 — SYMPTOM CONFIRMATION\n' +
      'Present the confirmationPrompt to the user and wait for their response.\n' +
      'If they confirm the diagnosis, proceed to Phase 2 by calling start_debug_session again with phase=2.\n' +
      'If they redirect, update your suspectNodeId and call start_debug_session with the corrected suspectedNode.\n\n' +
      'DO NOT inject any debug nodes yet. DO NOT propose any fixes yet.',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/hayba/packages/pcgex && npx vitest run src/tools/start-debug-session.test.ts 2>&1
```

Expected: all tests `PASS`.

- [ ] **Step 5: Type-check**

```bash
cd D:/hayba/packages/pcgex && npx tsc --noEmit 2>&1
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd D:/hayba
git add packages/pcgex/src/tools/start-debug-session.ts packages/pcgex/src/tools/start-debug-session.test.ts
git commit -m "feat(pcgex-mcp): add start_debug_session tool — Thorough mode 5-phase doctor debug protocol"
```

---

## Task 10: Register all 4 new tools + dashboard endpoints

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/dashboard/api.ts`

- [ ] **Step 1: Add imports to tools/index.ts**

Open `src/tools/index.ts`. After the existing `autoWireDebugOverlay` import line, add:

```typescript
import { readNodeOutput } from './read-node-output.js';
import { removeDebugNodes } from './remove-debug-nodes.js';
import { debugGraph } from './debug-graph.js';
import { startDebugSession } from './start-debug-session.js';
import { getUEClient } from '../tcp-client.js';
```

- [ ] **Step 2: Register `read_node_output`**

At the bottom of `registerTools()`, after the `auto_wire_debug_overlay` registration, add:

```typescript
  // ── Phase C tools — structured debug ──────────────────────────────────────────

  server.tool(
    'read_node_output',
    'Read per-node execution data from a PCGGraph after running it in UE. ' +
    'Returns outputPointCount, attributes, sample rows, and status (executed/skipped/error) for every node. ' +
    'Use this FIRST when a graph produces bad or empty output — a node with outputPointCount:0 marks where data flow stopped. ' +
    'Requires UE to be running with the TCP bridge active and an actor using this graph present in the current level.',
    {
      assetPath: z.string().describe('Full UE asset path to the PCGGraph'),
      maxSampleRows: z.number().int().min(1).max(100).optional()
        .describe('Max attribute rows to return per node (default 10)'),
    },
    async (params) => {
      const result = await readNodeOutput(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
```

- [ ] **Step 3: Register `remove_debug_nodes`**

```typescript
  server.tool(
    'remove_debug_nodes',
    'Remove debug nodes (injected by inject_debug_nodes or auto_wire_debug_overlay) from a PCGGraph and rewire the original edges. ' +
    'IMPORTANT: Never call this silently. Always present this message to the user first: ' +
    '"Debugging complete. I injected N debug nodes with prefix DBG. Should I remove them, or would you like to keep them to inspect in the PCG editor?" ' +
    'Only call this tool after the user approves removal.',
    {
      assetPath: z.string().describe('Full UE asset path to the PCGGraph'),
      labelPrefix: z.string().optional().describe('Label prefix identifying debug nodes (default: DBG)'),
    },
    async (params) => {
      const result = await removeDebugNodes(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
```

- [ ] **Step 4: Register `debug_graph`**

```typescript
  server.tool(
    'debug_graph',
    'FAST MODE debug workflow for a PCGGraph. Use when get_bridge_config returns inquisitivenessMode:"fast" or "silent". ' +
    'Workflow: (1) read_node_output to find first node with 0 output or error status, ' +
    '(2) auto_wire_debug_overlay on edges into the suspect node, ' +
    '(3) execute_pcg_graph, ' +
    '(4) read_node_output again to read debug data, ' +
    '(5) form diagnosis — present to user as: "I believe [X] because [evidence from sampleRows/attributes]. Does that match what you see?", ' +
    '(6) on confirmation apply fix, ' +
    '(7) call remove_debug_nodes with user confirmation. ' +
    'In SILENT mode: skip step 5 user confirmation and go straight to fix, but still confirm cleanup.',
    {
      assetPath: z.string().describe('Full UE asset path to the PCGGraph to debug'),
      suspectedNodes: z.array(z.string()).optional()
        .describe('Optional node IDs to focus on. If omitted, the tool identifies the suspect automatically.'),
    },
    async (params) => {
      const result = await debugGraph(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
```

- [ ] **Step 5: Register `start_debug_session`**

```typescript
  server.tool(
    'start_debug_session',
    'THOROUGH MODE debug workflow — 5-phase doctor protocol. Use when get_bridge_config returns inquisitivenessMode:"thorough". ' +
    'PHASE 1 (this call): read execution data, present symptom confirmation to user, wait for response. ' +
    'PHASE 2: state hypothesis, ask user to approve debug node injection before injecting anything. ' +
    'PHASE 3: inject targeted debug nodes on suspect edges, execute, read data, present evidence table, ask user to confirm diagnosis. ' +
    'PHASE 4: propose exact fix with specifics, wait for approval before changing anything. ' +
    'PHASE 5: apply fix, then call remove_debug_nodes with user confirmation. ' +
    'CRITICAL: Each phase waits for user response before proceeding. Never skip a phase. Never apply fixes without phase 4 approval.',
    {
      assetPath: z.string().describe('Full UE asset path to the PCGGraph to debug'),
      symptom: z.string().describe('The problem as described by the user, e.g. "graph generates nothing visible" or "wrong shape"'),
    },
    async (params) => {
      const result = await startDebugSession(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
```

- [ ] **Step 6: Add dashboard REST endpoints**

Open `src/dashboard/api.ts`. At the bottom of `registerApiRoutes()`, before the closing `}`, add:

```typescript
  // Bridge config (inquisitiveness mode + settings)
  app.get('/api/bridge/config', async (_req: Request, res: Response) => {
    try {
      const client = getUEClient();
      const response = await client.send('get_bridge_config', {});
      if (response.ok) {
        res.json(response.data);
      } else {
        res.status(500).json({ error: response.error });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // Per-node execution data
  app.get('/api/ue/execution', async (req: Request, res: Response) => {
    const assetPath = req.query.assetPath as string;
    if (!assetPath) return res.status(400).json({ error: 'Missing assetPath' });
    const maxSampleRows = req.query.maxSampleRows ? parseInt(req.query.maxSampleRows as string, 10) : 10;
    try {
      const client = getUEClient();
      const response = await client.send('get_node_execution_data', { assetPath, maxSampleRows });
      if (response.ok) {
        res.json(response.data);
      } else {
        res.status(500).json({ error: response.error });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // Remove debug nodes
  app.post('/api/ue/debug/remove', async (req: Request, res: Response) => {
    const { assetPath, labelPrefix } = req.body;
    if (!assetPath) return res.status(400).json({ error: 'Missing assetPath in body' });
    try {
      const client = getUEClient();
      const response = await client.send('remove_debug_nodes', {
        assetPath,
        labelPrefix: labelPrefix ?? 'DBG',
      });
      if (response.ok) {
        res.json(response.data);
      } else {
        res.status(500).json({ error: response.error });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });
```

- [ ] **Step 7: Type-check**

```bash
cd D:/hayba/packages/pcgex && npx tsc --noEmit 2>&1
```

Expected: no output.

- [ ] **Step 8: Run all tests**

```bash
cd D:/hayba/packages/pcgex && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
cd D:/hayba
git add packages/pcgex/src/tools/index.ts packages/pcgex/src/dashboard/api.ts
git commit -m "feat(pcgex-mcp): register 4 Phase C debug tools + 3 dashboard endpoints"
```

---

## Task 11: Build dist and sync to plugin

- [ ] **Step 1: Build TypeScript**

```bash
cd D:/hayba/packages/pcgex && npm run build 2>&1 | tail -20
```

Expected: `dist/` updated, no errors.

- [ ] **Step 2: Sync to plugin ThirdParty folder**

```bash
rsync -a --delete /d/hayba/packages/pcgex/dist/ /d/hayba/packages/pcgex/Plugins/Hayba_PcgEx_MCP/ThirdParty/mcp_server/dist/
rsync -a --delete /d/hayba/packages/pcgex/dashboard/ /d/hayba/packages/pcgex/Plugins/Hayba_PcgEx_MCP/ThirdParty/mcp_server/dashboard/
```

Expected: no errors.

- [ ] **Step 3: Build the UE plugin one final time**

```bash
"C:/Program Files/Epic Games/UE_5.7/Engine/Build/BatchFiles/Build.bat" Hayba_PcgEx_MCPEditor Win64 Development "D:/UnrealEngine/geoforge/geoforge.uproject" -waitmutex 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Final commit**

```bash
cd D:/hayba
git add packages/pcgex/Plugins/Hayba_PcgEx_MCP/ThirdParty/mcp_server/
git commit -m "build: sync compiled MCP server dist to plugin ThirdParty"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Plugin UI (inquisitiveness mode + always-confirm checkbox) — Task 5
- ✅ `get_bridge_config` TCP command — Task 2
- ✅ `get_node_execution_data` TCP command — Task 3
- ✅ `remove_debug_nodes` TCP command — Task 4
- ✅ `read_node_output` MCP tool — Task 6
- ✅ `remove_debug_nodes` MCP tool — Task 7
- ✅ `debug_graph` Fast mode — Task 8
- ✅ `start_debug_session` Thorough mode — Task 9
- ✅ Behavior routing (mode dial → tool selection) — encoded in tool descriptions, Task 10
- ✅ `bAlwaysConfirmDebugNodeRemoval` persisted and returned in config — Tasks 1, 2
- ✅ Dashboard endpoints — Task 10
- ✅ Error handling (UE not connected, no nodes with 0 output) — handled in tool implementations

**Type consistency:**
- `GraphExecutionData` / `NodeExecutionData` defined in `read-node-output.ts`, imported in `debug-graph.ts` and `start-debug-session.ts` ✅
- `findFirstFailingNode` / `buildDebugContext` defined in `debug-graph.ts`, imported in `start-debug-session.ts` ✅
- `removeDebugNodes` params use `labelPrefix` consistently across tool + registration ✅
- `DEBUG_SUBGRAPHS` exported from `inject-debug-nodes.ts`, imported in `auto-wire-debug-overlay.ts` and `index.ts` ✅
