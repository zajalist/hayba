#include "HaybaMCPLegacyHandler.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPLandscapeImporter.h"
#include "Json.h"
#include "JsonUtilities.h"
#include "PCGSettings.h"
#include "PCGPin.h"
#include "PCGGraph.h"
#include "PCGNode.h"
#include "PCGEdge.h"
#include "Data/PCGPointData.h"
#include "Data/PCGSplineData.h"
#include "Data/PCGPolyLineData.h"
#include "Metadata/PCGMetadata.h"
#include "Data/Registry/PCGDataTypeIdentifier.h"
#include "PCGComponent.h"
#include "UObject/UObjectIterator.h"
#include "UObject/SavePackage.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/AssetData.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Async/Async.h"
#include "HAL/Event.h"
#include "HAL/PlatformProcess.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPLegacy, Log, All);

FHaybaMCPLegacyHandler::FHaybaMCPLegacyHandler() {}

TArray<FString> FHaybaMCPLegacyHandler::GetCommands() const
{
    return {
        TEXT("ping"),
        TEXT("list_node_classes"),       TEXT("pcg_list_node_classes"),
        TEXT("get_node_details"),        TEXT("pcg_get_node_details"),
        TEXT("list_pcg_assets"),         TEXT("pcg_list_assets"),
        TEXT("export_graph"),            TEXT("pcg_export_graph"),
        TEXT("create_graph"),            TEXT("pcg_create_graph"),
        TEXT("validate_graph"),          TEXT("pcg_validate_graph"),
        TEXT("execute_graph"),           TEXT("pcg_execute_graph"),
        TEXT("wizard_chat"),
        TEXT("import_landscape"),        TEXT("landscape_import"),
        TEXT("read_node_output"),        TEXT("pcg_read_node_output"),
        TEXT("describe_assets"),         TEXT("asset_browse"),
    };
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::RunOnGameThread(TFunction<FHaybaHandlerResult()> Work)
{
    if (IsInGameThread())
    {
        return Work();
    }

    // Shared state so the marshaled lambda and the waiting caller both keep
    // it alive across the thread hop — by-reference capture would be a
    // use-after-free risk if the wait timed out and the caller frame unwound.
    //
    // We deliberately do NOT return the FEvent to the pool on timeout: if the
    // marshaled lambda eventually runs after we've given up, it would trigger
    // a recycled event and clobber unrelated waiters. Leaking one event per
    // (rare) timeout is the lesser evil. The shared Box and event ownership
    // are passed into the lambda by-value so they outlive the waiter.
    struct FState
    {
        FHaybaHandlerResult Result;
        FEvent* Done = nullptr;
    };
    TSharedRef<FState, ESPMode::ThreadSafe> State = MakeShared<FState, ESPMode::ThreadSafe>();
    State->Done = FPlatformProcess::GetSynchEventFromPool(/*bIsManualReset=*/true);

    AsyncTask(ENamedThreads::GameThread, [Work = MoveTemp(Work), State]()
    {
        State->Result = Work();
        if (State->Done) State->Done->Trigger();
    });

    // 30s ceiling: long enough for landscape import (~5-10s on big heightmaps)
    // and PCG execution, short enough to surface a real deadlock instead of
    // hanging the TS client forever.
    const bool bSignalled = State->Done->Wait(FTimespan::FromSeconds(30));

    if (bSignalled)
    {
        FPlatformProcess::ReturnSynchEventToPool(State->Done);
        State->Done = nullptr;
        return State->Result;
    }

    // Timeout: leak the event (see comment above). The shared State outlives
    // this frame because the AsyncTask lambda still holds a reference.
    return FHaybaHandlerResult::Err(
        TEXT("Game-thread marshal timed out after 30s — editor may be stalled "
             "or running a long blocking task. Try again once the editor is idle."));
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Handle(const FString& Cmd,
    const TSharedPtr<FJsonObject>& Params)
{
    // Read-only / thread-safe commands run inline.
    if (Cmd == TEXT("ping")) return Cmd_Ping(Params);
    if (Cmd == TEXT("list_node_classes") || Cmd == TEXT("pcg_list_node_classes"))
        return Cmd_ListNodeClasses(Params);
    if (Cmd == TEXT("get_node_details") || Cmd == TEXT("pcg_get_node_details"))
        return Cmd_GetNodeDetails(Params);
    if (Cmd == TEXT("validate_graph") || Cmd == TEXT("pcg_validate_graph"))
        return Cmd_ValidateGraph(Params);
    if (Cmd == TEXT("wizard_chat")) return Cmd_WizardChat(Params);

    // World-mutating or LoadObject-touching commands MUST run on the game
    // thread. The TCP server already marshals before dispatch today, but we
    // re-marshal here defensively so any future direct caller (python_run,
    // sliver runtime, another handler) can't hit the race that crashed UE
    // in the 2026-05-23 postmortem.
    if (Cmd == TEXT("list_pcg_assets") || Cmd == TEXT("pcg_list_assets"))
        return RunOnGameThread([this, Params]() { return Cmd_ListPCGAssets(Params); });
    if (Cmd == TEXT("export_graph") || Cmd == TEXT("pcg_export_graph"))
        return RunOnGameThread([this, Params]() { return Cmd_ExportGraph(Params); });
    if (Cmd == TEXT("create_graph") || Cmd == TEXT("pcg_create_graph"))
        return RunOnGameThread([this, Params]() { return Cmd_CreateGraph(Params); });
    if (Cmd == TEXT("execute_graph") || Cmd == TEXT("pcg_execute_graph"))
        return RunOnGameThread([this, Params]() { return Cmd_ExecuteGraph(Params); });
    if (Cmd == TEXT("import_landscape") || Cmd == TEXT("landscape_import"))
        return RunOnGameThread([this, Params]() { return Cmd_ImportLandscape(Params); });
    if (Cmd == TEXT("read_node_output") || Cmd == TEXT("pcg_read_node_output"))
        return RunOnGameThread([this, Params]() { return Cmd_ReadNodeOutput(Params); });
    if (Cmd == TEXT("describe_assets") || Cmd == TEXT("asset_browse"))
        return RunOnGameThread([this, Params]() { return Cmd_DescribeAssets(Params); });

    return FHaybaHandlerResult::Err(
        FString::Printf(TEXT("Legacy handler: unknown command %s"), *Cmd));
}

// --- Command implementations ---

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_Ping(const TSharedPtr<FJsonObject>& Params)
{
	TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
	Data->SetStringField(TEXT("status"), TEXT("ok"));
	Data->SetStringField(TEXT("ueVersion"), TEXT("5.7"));
	Data->SetStringField(TEXT("plugin"), TEXT("HaybaMCPToolkit"));
	Data->SetStringField(TEXT("pluginVersion"), TEXT("0.2.0"));

	UE_LOG(LogHaybaMCPLegacy, Log, TEXT("Ping command processed"));
	return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_ListNodeClasses(const TSharedPtr<FJsonObject>& Params)
{
	FString CategoryFilter;
	Params->TryGetStringField(TEXT("category"), CategoryFilter);

	TArray<UClass*> Classes = FindPCGExNodeClasses();

	TArray<TSharedPtr<FJsonValue>> ClassArray;
	for (UClass* Class : Classes)
	{
		const UPCGSettings* CDO = Class->GetDefaultObject<UPCGSettings>();
		if (!CDO) continue;

		// Derive category from class name
		FString Category;
		FString ClassName = Class->GetName();
		if (ClassName.StartsWith(TEXT("PCGEx")))
		{
			if (ClassName.Contains(TEXT("Pathfinding"))) Category = TEXT("Pathfinding");
			else if (ClassName.Contains(TEXT("Delaunay")) || ClassName.Contains(TEXT("Voronoi")) || ClassName.Contains(TEXT("ConvexHull"))) Category = TEXT("Clusters/Diagrams");
			else if (ClassName.Contains(TEXT("Cluster")) || ClassName.Contains(TEXT("Vtx"))) Category = TEXT("Clusters");
			else if (ClassName.Contains(TEXT("Path")) || ClassName.Contains(TEXT("Spline")) || ClassName.Contains(TEXT("Smooth")) || ClassName.Contains(TEXT("Subdivide")) || ClassName.Contains(TEXT("Bevel"))) Category = TEXT("Paths");
			else if (ClassName.Contains(TEXT("Sample")) || ClassName.Contains(TEXT("Pruning")) || ClassName.Contains(TEXT("Overlap"))) Category = TEXT("Sampling");
			else if (ClassName.Contains(TEXT("Topology")) || ClassName.Contains(TEXT("Surface"))) Category = TEXT("Topology");
			else if (ClassName.Contains(TEXT("Tensor"))) Category = TEXT("Tensors");
			else if (ClassName.Contains(TEXT("Shape"))) Category = TEXT("Shapes");
			else if (ClassName.Contains(TEXT("Layout")) || ClassName.Contains(TEXT("BinPack"))) Category = TEXT("Layout");
			else if (ClassName.Contains(TEXT("Lloyd")) || ClassName.Contains(TEXT("Fuse")) || ClassName.Contains(TEXT("Normalize"))) Category = TEXT("Spatial");
			else if (ClassName.Contains(TEXT("Attribute")) || ClassName.Contains(TEXT("Blend")) || ClassName.Contains(TEXT("Remap")) || ClassName.Contains(TEXT("Index")) || ClassName.Contains(TEXT("Noise"))) Category = TEXT("Meta");
			else if (ClassName.Contains(TEXT("FloodFill")) || ClassName.Contains(TEXT("BFS"))) Category = TEXT("FloodFill");
			else if (ClassName.Contains(TEXT("Refine"))) Category = TEXT("Clusters/Refine");
			else if (ClassName.Contains(TEXT("Connect"))) Category = TEXT("Probing");
			else Category = TEXT("Misc");
		}
		else
		{
			Category = TEXT("PCG/Vanilla");
		}

		// Apply category filter
		if (!CategoryFilter.IsEmpty() && !Category.Contains(CategoryFilter))
		{
			continue;
		}

		TArray<TSharedPtr<FJsonValue>> Inputs;
		TArray<TSharedPtr<FJsonValue>> Outputs;
		GetPinInfo(Class, Inputs, Outputs);

		TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
		Entry->SetStringField(TEXT("class"), ClassName);
		Entry->SetStringField(TEXT("category"), Category);
		Entry->SetArrayField(TEXT("inputs"), Inputs);
		Entry->SetArrayField(TEXT("outputs"), Outputs);
		ClassArray.Add(MakeShareable(new FJsonValueObject(Entry.ToSharedRef())));
	}

	TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
	Data->SetArrayField(TEXT("classes"), ClassArray);
	Data->SetNumberField(TEXT("count"), ClassArray.Num());
	return FHaybaHandlerResult::Ok(Data);
}

TArray<UClass*> FHaybaMCPLegacyHandler::FindPCGExNodeClasses() const
{
	TArray<UClass*> Result;
	for (TObjectIterator<UClass> It; It; ++It)
	{
		UClass* Class = *It;
		if (!Class || Class->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated)) continue;
		if (!Class->IsChildOf(UPCGSettings::StaticClass())) continue;
		FString ClassName = Class->GetName();
		if (ClassName.StartsWith(TEXT("PCGEx")) || ClassName.StartsWith(TEXT("PCG")))
		{
			Result.Add(Class);
		}
	}
	Result.Sort([](const UClass& A, const UClass& B) { return A.GetName() < B.GetName(); });
	return Result;
}

void FHaybaMCPLegacyHandler::GetPinInfo(const UClass* SettingsClass, TArray<TSharedPtr<FJsonValue>>& OutInputs, TArray<TSharedPtr<FJsonValue>>& OutOutputs) const
{
	if (!SettingsClass) return;
	const UPCGSettings* CDO = SettingsClass->GetDefaultObject<UPCGSettings>();
	if (!CDO) return;

	TArray<FPCGPinProperties> InputPins = CDO->InputPinProperties();
	for (const FPCGPinProperties& Pin : InputPins)
	{
		TSharedPtr<FJsonObject> PinJson = MakeShareable(new FJsonObject());
		PinJson->SetStringField(TEXT("pin"), Pin.Label.ToString());
		PinJson->SetStringField(TEXT("type"), UEnum::GetValueAsString(static_cast<EPCGDataType>(Pin.AllowedTypes)));
		PinJson->SetBoolField(TEXT("required"), Pin.IsRequiredPin());
		OutInputs.Add(MakeShareable(new FJsonValueObject(PinJson.ToSharedRef())));
	}

	TArray<FPCGPinProperties> OutputPins = CDO->OutputPinProperties();
	for (const FPCGPinProperties& Pin : OutputPins)
	{
		TSharedPtr<FJsonObject> PinJson = MakeShareable(new FJsonObject());
		PinJson->SetStringField(TEXT("pin"), Pin.Label.ToString());
		PinJson->SetStringField(TEXT("type"), UEnum::GetValueAsString(static_cast<EPCGDataType>(Pin.AllowedTypes)));
		PinJson->SetBoolField(TEXT("required"), false);
		OutOutputs.Add(MakeShareable(new FJsonValueObject(PinJson.ToSharedRef())));
	}
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_GetNodeDetails(const TSharedPtr<FJsonObject>& Params)
{
    FString ClassName;
    if (!Params->TryGetStringField(TEXT("class"), ClassName))
    {
        return FHaybaHandlerResult::Err(TEXT("Missing required param: class"));
    }

    // Strip U/A prefix if present
    if (ClassName.Len() > 1 && (ClassName[0] == TEXT('U') || ClassName[0] == TEXT('A')) && FChar::IsUpper(ClassName[1]))
    {
        ClassName = ClassName.Mid(1);
    }

    // Find the class
    UClass* FoundClass = nullptr;
    for (TObjectIterator<UClass> It; It; ++It)
    {
        if (It->GetName() == ClassName && It->IsChildOf(UPCGSettings::StaticClass()))
        {
            FoundClass = *It;
            break;
        }
    }

    if (!FoundClass)
    {
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("Class not found: %s"), *ClassName));
    }

    const UPCGSettings* CDO = FoundClass->GetDefaultObject<UPCGSettings>();
    if (!CDO)
    {
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("Cannot create CDO for: %s"), *ClassName));
    }

    // Pins
    TArray<TSharedPtr<FJsonValue>> Inputs;
    TArray<TSharedPtr<FJsonValue>> Outputs;
    GetPinInfo(FoundClass, Inputs, Outputs);

    // Properties — iterate UProperties exposed to the editor
    TArray<TSharedPtr<FJsonValue>> Properties;
    for (TFieldIterator<FProperty> PropIt(FoundClass, EFieldIterationFlags::IncludeSuper); PropIt; ++PropIt)
    {
        FProperty* Prop = *PropIt;
        if (!Prop->HasAnyPropertyFlags(CPF_Edit))
        {
            continue;
        }

        // Skip base class properties
        if (Prop->GetOwnerClass() == UObject::StaticClass() ||
            Prop->GetOwnerClass() == UPCGSettings::StaticClass())
        {
            continue;
        }

        TSharedPtr<FJsonObject> PropJson = MakeShareable(new FJsonObject());
        PropJson->SetStringField(TEXT("name"), Prop->GetName());
        PropJson->SetStringField(TEXT("type"), Prop->GetCPPType());

        // Get default value as string
        FString DefaultValue;
        Prop->ExportTextItem_Direct(DefaultValue, Prop->ContainerPtrToValuePtr<void>(CDO), nullptr, nullptr, PPF_None);
        PropJson->SetStringField(TEXT("default"), DefaultValue);

        // Check if it's an enum property
        if (const FEnumProperty* EnumProp = CastField<FEnumProperty>(Prop))
        {
            if (UEnum* Enum = EnumProp->GetEnum())
            {
                TArray<TSharedPtr<FJsonValue>> EnumValues;
                for (int32 i = 0; i < Enum->NumEnums() - 1; ++i)
                {
                    EnumValues.Add(MakeShareable(new FJsonValueString(Enum->GetNameStringByIndex(i))));
                }
                PropJson->SetArrayField(TEXT("enum_values"), EnumValues);
            }
        }
        else if (const FByteProperty* ByteProp = CastField<FByteProperty>(Prop))
        {
            if (UEnum* Enum = ByteProp->GetIntPropertyEnum())
            {
                TArray<TSharedPtr<FJsonValue>> EnumValues;
                for (int32 i = 0; i < Enum->NumEnums() - 1; ++i)
                {
                    EnumValues.Add(MakeShareable(new FJsonValueString(Enum->GetNameStringByIndex(i))));
                }
                PropJson->SetArrayField(TEXT("enum_values"), EnumValues);
            }
        }

        // Bool properties
        if (CastField<FBoolProperty>(Prop))
        {
            PropJson->SetStringField(TEXT("type"), TEXT("bool"));
        }

        Properties.Add(MakeShareable(new FJsonValueObject(PropJson.ToSharedRef())));
    }

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetStringField(TEXT("class"), ClassName);
    Data->SetArrayField(TEXT("inputs"), Inputs);
    Data->SetArrayField(TEXT("outputs"), Outputs);
    Data->SetArrayField(TEXT("properties"), Properties);
    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_ListPCGAssets(const TSharedPtr<FJsonObject>& Params)
{
    // Asset->GetAsset() force-loads UObjects; must run on the game thread.
    check(IsInGameThread());

    FString PathFilter = TEXT("/Game/");
    Params->TryGetStringField(TEXT("path"), PathFilter);

    FAssetRegistryModule& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
    IAssetRegistry& Registry = AssetRegistry.Get();

    FARFilter Filter;
    Filter.ClassPaths.Add(UPCGGraph::StaticClass()->GetClassPathName());
    Filter.PackagePaths.Add(FName(*PathFilter));
    Filter.bRecursivePaths = true;

    TArray<FAssetData> Assets;
    Registry.GetAssets(Filter, Assets);

    TArray<TSharedPtr<FJsonValue>> AssetArray;
    for (const FAssetData& Asset : Assets)
    {
        TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
        Entry->SetStringField(TEXT("name"), Asset.AssetName.ToString());
        Entry->SetStringField(TEXT("path"), Asset.GetObjectPathString());

        if (UPCGGraph* Graph = Cast<UPCGGraph>(Asset.GetAsset()))
        {
            const TArray<UPCGNode*>& Nodes = Graph->GetNodes();
            Entry->SetNumberField(TEXT("nodeCount"), Nodes.Num());

            int32 EdgeCount = 0;
            for (const UPCGNode* Node : Nodes)
            {
                if (Node)
                {
                    EdgeCount += Node->GetOutputPins().Num();
                }
            }
            Entry->SetNumberField(TEXT("edgeCount"), EdgeCount);
        }

        AssetArray.Add(MakeShareable(new FJsonValueObject(Entry.ToSharedRef())));
    }

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetArrayField(TEXT("assets"), AssetArray);
    Data->SetNumberField(TEXT("count"), AssetArray.Num());
    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_ExportGraph(const TSharedPtr<FJsonObject>& Params)
{
    // LoadObject + UPCGGraph traversal must run on the game thread.
    check(IsInGameThread());

    FString AssetPath;
    if (!Params->TryGetStringField(TEXT("assetPath"), AssetPath))
    {
        return FHaybaHandlerResult::Err(TEXT("Missing required param: assetPath"));
    }

    UPCGGraph* Graph = LoadObject<UPCGGraph>(nullptr, *AssetPath);
    if (!Graph)
    {
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("Graph not found: %s"), *AssetPath));
    }

    // Build graph JSON
    TSharedPtr<FJsonObject> GraphJson = MakeShareable(new FJsonObject());
    GraphJson->SetStringField(TEXT("version"), TEXT("2.0.0"));

    // Meta
    TSharedPtr<FJsonObject> Meta = MakeShareable(new FJsonObject());
    Meta->SetStringField(TEXT("sourceGraph"), AssetPath);
    Meta->SetStringField(TEXT("ueVersion"), TEXT("5.7"));
    Meta->SetStringField(TEXT("exportedAt"), FDateTime::UtcNow().ToIso8601());
    TArray<TSharedPtr<FJsonValue>> Tags;
    TArray<FString> PathParts;
    AssetPath.ParseIntoArray(PathParts, TEXT("/"));
    for (const FString& Part : PathParts)
    {
        if (Part != TEXT("Game") && Part != TEXT("Engine") && !Part.Contains(TEXT(".")))
        {
            Tags.Add(MakeShareable(new FJsonValueString(Part.ToLower())));
        }
    }
    Meta->SetArrayField(TEXT("tags"), Tags);
    GraphJson->SetObjectField(TEXT("meta"), Meta);

    // Nodes
    const TArray<UPCGNode*>& Nodes = Graph->GetNodes();
    TMap<UPCGNode*, FString> NodeIdMap;
    TArray<TSharedPtr<FJsonValue>> NodesArray;

    for (int32 i = 0; i < Nodes.Num(); ++i)
    {
        UPCGNode* Node = Nodes[i];
        if (!Node) continue;

        FString NodeId = FString::Printf(TEXT("node_%03d"), i);
        NodeIdMap.Add(Node, NodeId);

        TSharedPtr<FJsonObject> NodeJson = MakeShareable(new FJsonObject());
        NodeJson->SetStringField(TEXT("id"), NodeId);

        if (const UPCGSettings* Settings = Node->GetSettings())
        {
            NodeJson->SetStringField(TEXT("class"), Settings->GetClass()->GetName());
        }
        else
        {
            NodeJson->SetStringField(TEXT("class"), TEXT("Unknown"));
        }

        NodeJson->SetStringField(TEXT("label"), Node->GetNodeTitle(EPCGNodeTitleType::ListView).ToString());

        // Position
        TSharedPtr<FJsonObject> Pos = MakeShareable(new FJsonObject());
        FVector2D NodePos = FVector2D(Node->PositionX, Node->PositionY);
        Pos->SetNumberField(TEXT("x"), NodePos.X);
        Pos->SetNumberField(TEXT("y"), NodePos.Y);
        NodeJson->SetObjectField(TEXT("position"), Pos);

        // Properties
        TSharedPtr<FJsonObject> Props = MakeShareable(new FJsonObject());
        if (const UPCGSettings* Settings = Node->GetSettings())
        {
            for (TFieldIterator<FProperty> PropIt(Settings->GetClass()); PropIt; ++PropIt)
            {
                FProperty* Prop = *PropIt;
                if (!Prop->HasAnyPropertyFlags(CPF_Edit)) continue;
                if (Prop->GetOwnerClass() == UObject::StaticClass() ||
                    Prop->GetOwnerClass() == UPCGSettings::StaticClass()) continue;

                FString Value;
                Prop->ExportTextItem_Direct(Value, Prop->ContainerPtrToValuePtr<void>(Settings), nullptr, nullptr, PPF_None);
                Props->SetStringField(Prop->GetName(), Value);
            }
        }
        NodeJson->SetObjectField(TEXT("properties"), Props);
        NodeJson->SetObjectField(TEXT("customData"), MakeShareable(new FJsonObject()));

        NodesArray.Add(MakeShareable(new FJsonValueObject(NodeJson.ToSharedRef())));
    }
    GraphJson->SetArrayField(TEXT("nodes"), NodesArray);

    // Edges
    TArray<TSharedPtr<FJsonValue>> EdgesArray;
    for (const UPCGNode* Node : Nodes)
    {
        if (!Node) continue;
        const FString* FromId = NodeIdMap.Find(const_cast<UPCGNode*>(Node));
        if (!FromId) continue;

        for (const UPCGPin* OutputPin : Node->GetOutputPins())
        {
            if (!OutputPin) continue;
            for (const UPCGEdge* Edge : OutputPin->Edges)
            {
                // InputPin = upstream (source), OutputPin = downstream (target)
                if (!Edge || !Edge->OutputPin || !Edge->OutputPin->Node) continue;

                const FString* ToId = NodeIdMap.Find(Edge->OutputPin->Node);
                if (!ToId) continue;

                TSharedPtr<FJsonObject> EdgeJson = MakeShareable(new FJsonObject());
                EdgeJson->SetStringField(TEXT("fromNode"), *FromId);
                EdgeJson->SetStringField(TEXT("fromPin"), OutputPin->Properties.Label.ToString());
                EdgeJson->SetStringField(TEXT("toNode"), *ToId);
                EdgeJson->SetStringField(TEXT("toPin"), Edge->OutputPin->Properties.Label.ToString());
                EdgesArray.Add(MakeShareable(new FJsonValueObject(EdgeJson.ToSharedRef())));
            }
        }
    }
    GraphJson->SetArrayField(TEXT("edges"), EdgesArray);

    // Metadata
    TSharedPtr<FJsonObject> Metadata = MakeShareable(new FJsonObject());
    Metadata->SetObjectField(TEXT("inputSettings"), MakeShareable(new FJsonObject()));
    Metadata->SetObjectField(TEXT("outputSettings"), MakeShareable(new FJsonObject()));
    Metadata->SetObjectField(TEXT("graphSettings"), MakeShareable(new FJsonObject()));
    GraphJson->SetObjectField(TEXT("metadata"), Metadata);

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetObjectField(TEXT("graph"), GraphJson);
    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_CreateGraph(const TSharedPtr<FJsonObject>& Params)
{
    // CreatePackage / NewObject / SavePackage / AssetCreated all require
    // the game thread. Dispatcher marshals via RunOnGameThread.
    check(IsInGameThread());

    FString Name;
    if (!Params->TryGetStringField(TEXT("name"), Name))
    {
        return FHaybaHandlerResult::Err(TEXT("Missing required param: name"));
    }

    const TSharedPtr<FJsonObject>* GraphObj;
    if (!Params->TryGetObjectField(TEXT("graph"), GraphObj) || !GraphObj->IsValid())
    {
        return FHaybaHandlerResult::Err(TEXT("Missing required param: graph"));
    }

    // Validate first
    TArray<TSharedPtr<FJsonValue>> ValidationErrors = ValidateGraphJson(*GraphObj);
    if (ValidationErrors.Num() > 0)
    {
        TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
        Data->SetBoolField(TEXT("created"), false);
        Data->SetArrayField(TEXT("errors"), ValidationErrors);
        return FHaybaHandlerResult::Ok(Data);
    }

    // Sanitize name
    FString SafeName = Name;
    for (TCHAR& Ch : SafeName)
    {
        if (!FChar::IsAlnum(Ch) && Ch != '_' && Ch != '-')
        {
            Ch = '_';
        }
    }

    FString PackagePath = TEXT("/Game/Hayba/Generated");
    FString FullPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *SafeName);

    UPackage* Package = CreatePackage(*FullPath);
    if (!Package)
    {
        return FHaybaHandlerResult::Err(TEXT("Failed to create package"));
    }

    UPCGGraph* NewGraph = NewObject<UPCGGraph>(Package, *SafeName, RF_Public | RF_Standalone);
    if (!NewGraph)
    {
        return FHaybaHandlerResult::Err(TEXT("Failed to create PCGGraph object"));
    }

    // Add nodes
    const TArray<TSharedPtr<FJsonValue>>& NodesArray = (*GraphObj)->GetArrayField(TEXT("nodes"));
    TMap<FString, UPCGNode*> CreatedNodes;

    for (const TSharedPtr<FJsonValue>& NodeValue : NodesArray)
    {
        const TSharedPtr<FJsonObject>& NodeObj = NodeValue->AsObject();
        FString NodeId = NodeObj->GetStringField(TEXT("id"));
        FString NodeClass = NodeObj->GetStringField(TEXT("class"));

        // Strip U/A prefix if present
        if (NodeClass.Len() > 1 && (NodeClass[0] == TEXT('U') || NodeClass[0] == TEXT('A')) && FChar::IsUpper(NodeClass[1]))
        {
            NodeClass = NodeClass.Mid(1);
        }

        UClass* SettingsClass = nullptr;
        for (TObjectIterator<UClass> It; It; ++It)
        {
            if (It->GetName() == NodeClass && It->IsChildOf(UPCGSettings::StaticClass()))
            {
                SettingsClass = *It;
                break;
            }
        }
        if (!SettingsClass) continue;

        UPCGSettings* Settings = nullptr;
        UPCGNode* NewNode = NewGraph->AddNodeOfType(SettingsClass, Settings);

        if (NewNode)
        {
            // Position: use explicit position if provided, otherwise auto-layout later
            bool bHasExplicitPosition = false;
            const TSharedPtr<FJsonObject>* PosObjPtr = nullptr;
            if (NodeObj->TryGetObjectField(TEXT("position"), PosObjPtr) && PosObjPtr && PosObjPtr->IsValid())
            {
                double X = 0, Y = 0;
                if ((*PosObjPtr)->TryGetNumberField(TEXT("x"), X) && (*PosObjPtr)->TryGetNumberField(TEXT("y"), Y)
                    && (X != 0.0 || Y != 0.0))
                {
                    NewNode->PositionX = static_cast<int32>(X);
                    NewNode->PositionY = static_cast<int32>(Y);
                    bHasExplicitPosition = true;
                }
            }

            const TSharedPtr<FJsonObject>& PropsObj = NodeObj->GetObjectField(TEXT("properties"));
            if (PropsObj.IsValid() && Settings)
            {
                for (const auto& Pair : PropsObj->Values)
                {
                    FProperty* Prop = SettingsClass->FindPropertyByName(FName(*Pair.Key));
                    if (Prop && Prop->HasAnyPropertyFlags(CPF_Edit))
                    {
                        FString ValueStr;
                        if (Pair.Value->TryGetString(ValueStr))
                        {
                            Prop->ImportText_Direct(*ValueStr, Prop->ContainerPtrToValuePtr<void>(Settings), Settings, PPF_None);
                        }
                    }
                }
            }

            CreatedNodes.Add(NodeId, NewNode);

            // Track for auto-layout
            if (!bHasExplicitPosition)
            {
                NewNode->PositionX = CreatedNodes.Num() * 400;
                NewNode->PositionY = 0;
            }
        }
    }

    // Add edges
    const TArray<TSharedPtr<FJsonValue>>& EdgesArray = (*GraphObj)->GetArrayField(TEXT("edges"));
    for (const TSharedPtr<FJsonValue>& EdgeValue : EdgesArray)
    {
        const TSharedPtr<FJsonObject>& EdgeObj = EdgeValue->AsObject();
        FString FromNode, FromPin, ToNode, ToPin;
        if (!EdgeObj->TryGetStringField(TEXT("fromNode"), FromNode))
            EdgeObj->TryGetStringField(TEXT("from"), FromNode);
        EdgeObj->TryGetStringField(TEXT("fromPin"), FromPin);
        if (!EdgeObj->TryGetStringField(TEXT("toNode"), ToNode))
            EdgeObj->TryGetStringField(TEXT("to"), ToNode);
        EdgeObj->TryGetStringField(TEXT("toPin"), ToPin);

        UPCGNode** FromNodePtr = CreatedNodes.Find(FromNode);
        UPCGNode** ToNodePtr = CreatedNodes.Find(ToNode);

        if (FromNodePtr && *FromNodePtr && ToNodePtr && *ToNodePtr)
        {
            UPCGPin* OutputPin = (*FromNodePtr)->GetOutputPin(FName(*FromPin));
            UPCGPin* InputPin = (*ToNodePtr)->GetInputPin(FName(*ToPin));

            if (OutputPin && InputPin)
            {
                OutputPin->AddEdgeTo(InputPin);
            }
        }
    }

    // Save
    FAssetRegistryModule::AssetCreated(NewGraph);
    Package->MarkPackageDirty();

    FString FilePath = FPackageName::LongPackageNameToFilename(FullPath, FPackageName::GetAssetPackageExtension());
    FSavePackageArgs SaveArgs;
    SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
    UPackage::SavePackage(Package, NewGraph, *FilePath, SaveArgs);

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetBoolField(TEXT("created"), true);
    Data->SetStringField(TEXT("assetPath"), FullPath);
    Data->SetNumberField(TEXT("nodeCount"), CreatedNodes.Num());
    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_ValidateGraph(const TSharedPtr<FJsonObject>& Params)
{
    const TSharedPtr<FJsonObject>* GraphObj;
    if (!Params->TryGetObjectField(TEXT("graph"), GraphObj) || !GraphObj->IsValid())
    {
        TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
        Data->SetBoolField(TEXT("valid"), false);
        TArray<TSharedPtr<FJsonValue>> Errors;
        TSharedPtr<FJsonObject> Err = MakeShareable(new FJsonObject());
        Err->SetStringField(TEXT("type"), TEXT("schema"));
        Err->SetStringField(TEXT("detail"), TEXT("Missing required param: graph"));
        Errors.Add(MakeShareable(new FJsonValueObject(Err.ToSharedRef())));
        Data->SetArrayField(TEXT("errors"), Errors);
        Data->SetNumberField(TEXT("errorCount"), 1);
        return FHaybaHandlerResult::Ok(Data);
    }

    TArray<TSharedPtr<FJsonValue>> Errors = ValidateGraphJson(*GraphObj);

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetBoolField(TEXT("valid"), Errors.Num() == 0);
    Data->SetArrayField(TEXT("errors"), Errors);
    Data->SetNumberField(TEXT("errorCount"), Errors.Num());
    return FHaybaHandlerResult::Ok(Data);
}

TArray<TSharedPtr<FJsonValue>> FHaybaMCPLegacyHandler::ValidateGraphJson(const TSharedPtr<FJsonObject>& Graph) const
{
    TArray<TSharedPtr<FJsonValue>> Errors;

    auto AddError = [&Errors](const FString& Type, const FString& Node, const FString& Pin, const FString& Detail)
    {
        TSharedPtr<FJsonObject> Err = MakeShareable(new FJsonObject());
        Err->SetStringField(TEXT("type"), Type);
        Err->SetStringField(TEXT("node"), Node);
        Err->SetStringField(TEXT("pin"), Pin);
        Err->SetStringField(TEXT("detail"), Detail);
        Errors.Add(MakeShareable(new FJsonValueObject(Err.ToSharedRef())));
    };

    // Layer 1: Schema validation
    // version is optional — don't error if missing

    const TArray<TSharedPtr<FJsonValue>>* NodesArray;
    if (!Graph->TryGetArrayField(TEXT("nodes"), NodesArray))
    {
        AddError(TEXT("schema"), TEXT(""), TEXT(""), TEXT("Missing required field: nodes"));
        return Errors;
    }

    const TArray<TSharedPtr<FJsonValue>>* EdgesArray;
    if (!Graph->TryGetArrayField(TEXT("edges"), EdgesArray))
    {
        AddError(TEXT("schema"), TEXT(""), TEXT(""), TEXT("Missing required field: edges"));
        return Errors;
    }

    // Build node maps
    TMap<FString, FString> NodeClassMap;
    TMap<FString, UClass*> NodeUClassMap;

    for (int32 i = 0; i < NodesArray->Num(); ++i)
    {
        const TSharedPtr<FJsonObject>* NodeObj;
        if (!(*NodesArray)[i]->TryGetObject(NodeObj) || !NodeObj->IsValid())
        {
            AddError(TEXT("schema"), FString::Printf(TEXT("node_%d"), i), TEXT(""), TEXT("Invalid node object"));
            continue;
        }

        FString NodeId, NodeClass;
        if (!(*NodeObj)->TryGetStringField(TEXT("id"), NodeId))
        {
            AddError(TEXT("schema"), FString::Printf(TEXT("node_%d"), i), TEXT(""), TEXT("Missing node id"));
            continue;
        }
        if (!(*NodeObj)->TryGetStringField(TEXT("class"), NodeClass))
        {
            AddError(TEXT("schema"), NodeId, TEXT(""), TEXT("Missing node class"));
            continue;
        }

        // Strip U/A prefix if present (catalog uses UClassName but UE GetName() returns ClassName)
        FString LookupClass = NodeClass;
        if (LookupClass.Len() > 1 && (LookupClass[0] == TEXT('U') || LookupClass[0] == TEXT('A')) && FChar::IsUpper(LookupClass[1]))
        {
            LookupClass = LookupClass.Mid(1);
        }
        NodeClassMap.Add(NodeId, LookupClass);

        // Layer 2: Check class exists
        UClass* FoundClass = nullptr;
        for (TObjectIterator<UClass> It; It; ++It)
        {
            if (It->GetName() == LookupClass && It->IsChildOf(UPCGSettings::StaticClass()))
            {
                FoundClass = *It;
                break;
            }
        }

        if (!FoundClass)
        {
            AddError(TEXT("missing_class"), NodeId, TEXT(""), FString::Printf(TEXT("Node class not found: %s"), *NodeClass));
            continue;
        }

        NodeUClassMap.Add(NodeId, FoundClass);
    }

    // Validate edges
    TSet<FString> SeenEdges;

    for (int32 i = 0; i < EdgesArray->Num(); ++i)
    {
        const TSharedPtr<FJsonObject>* EdgeObj;
        if (!(*EdgesArray)[i]->TryGetObject(EdgeObj) || !EdgeObj->IsValid())
        {
            AddError(TEXT("schema"), TEXT(""), TEXT(""), FString::Printf(TEXT("Invalid edge object at index %d"), i));
            continue;
        }

        FString FromNode, FromPin, ToNode, ToPin;
        if (!(*EdgeObj)->TryGetStringField(TEXT("fromNode"), FromNode))
            (*EdgeObj)->TryGetStringField(TEXT("from"), FromNode);
        (*EdgeObj)->TryGetStringField(TEXT("fromPin"), FromPin);
        if (!(*EdgeObj)->TryGetStringField(TEXT("toNode"), ToNode))
            (*EdgeObj)->TryGetStringField(TEXT("to"), ToNode);
        (*EdgeObj)->TryGetStringField(TEXT("toPin"), ToPin);

        // Layer 5: Edge integrity
        if (!NodeClassMap.Contains(FromNode))
        {
            AddError(TEXT("dangling_edge"), FromNode, FromPin, FString::Printf(TEXT("Edge references non-existent source node: %s"), *FromNode));
            continue;
        }
        if (!NodeClassMap.Contains(ToNode))
        {
            AddError(TEXT("dangling_edge"), ToNode, ToPin, FString::Printf(TEXT("Edge references non-existent target node: %s"), *ToNode));
            continue;
        }

        if (FromNode == ToNode)
        {
            AddError(TEXT("self_loop"), FromNode, FromPin, TEXT("Edge creates a self-loop"));
            continue;
        }

        FString EdgeKey = FString::Printf(TEXT("%s:%s->%s:%s"), *FromNode, *FromPin, *ToNode, *ToPin);
        if (SeenEdges.Contains(EdgeKey))
        {
            AddError(TEXT("duplicate_edge"), FromNode, FromPin, FString::Printf(TEXT("Duplicate edge: %s"), *EdgeKey));
            continue;
        }
        SeenEdges.Add(EdgeKey);

        // Layer 3 & 4: Pin existence and compatibility
        UClass** FromClass = NodeUClassMap.Find(FromNode);
        UClass** ToClass = NodeUClassMap.Find(ToNode);

        if (FromClass && *FromClass)
        {
            const UPCGSettings* FromCDO = (*FromClass)->GetDefaultObject<UPCGSettings>();
            if (FromCDO)
            {
                TArray<FPCGPinProperties> OutPins = FromCDO->OutputPinProperties();
                bool bFoundPin = false;
                FPCGDataTypeIdentifier FromPinType = FPCGDataTypeIdentifier{EPCGDataType::None};
                for (const FPCGPinProperties& Pin : OutPins)
                {
                    if (Pin.Label.ToString() == FromPin)
                    {
                        bFoundPin = true;
                        FromPinType = Pin.AllowedTypes;
                        break;
                    }
                }
                if (!bFoundPin)
                {
                    FString AvailablePins;
                    for (const FPCGPinProperties& Pin : OutPins)
                    {
                        if (!AvailablePins.IsEmpty()) AvailablePins += TEXT(", ");
                        AvailablePins += Pin.Label.ToString();
                    }
                    AddError(TEXT("invalid_pin"), FromNode, FromPin,
                        FString::Printf(TEXT("Output pin '%s' does not exist on %s. Available: %s"), *FromPin, *NodeClassMap[FromNode], *AvailablePins));
                }

                // Pin compatibility
                if (bFoundPin && ToClass && *ToClass)
                {
                    const UPCGSettings* ToCDO = (*ToClass)->GetDefaultObject<UPCGSettings>();
                    if (ToCDO)
                    {
                        TArray<FPCGPinProperties> InPins = ToCDO->InputPinProperties();
                        for (const FPCGPinProperties& Pin : InPins)
                        {
                            if (Pin.Label.ToString() == ToPin)
                            {
                                // Allow None<->None: both pins are param/opaque types that bypass the data type system
                                const EPCGDataType FromType = static_cast<EPCGDataType>(FromPinType);
                                const EPCGDataType ToType   = static_cast<EPCGDataType>(Pin.AllowedTypes);
                                const bool bBothNone = (FromType == EPCGDataType::None && ToType == EPCGDataType::None);
                                if (!bBothNone && (FromType & ToType) == EPCGDataType::None)
                                {
                                    AddError(TEXT("incompatible_connection"), FromNode, FromPin,
                                        FString::Printf(TEXT("Cannot connect %s:%s (type %s) to %s:%s (accepts %s)"),
                                            *FromNode, *FromPin, *UEnum::GetValueAsString(FromType),
                                            *ToNode, *ToPin, *UEnum::GetValueAsString(ToType)));
                                }
                                break;
                            }
                        }
                    }
                }
            }
        }

        if (ToClass && *ToClass)
        {
            const UPCGSettings* ToCDO = (*ToClass)->GetDefaultObject<UPCGSettings>();
            if (ToCDO)
            {
                TArray<FPCGPinProperties> InPins = ToCDO->InputPinProperties();
                bool bFoundPin = false;
                for (const FPCGPinProperties& Pin : InPins)
                {
                    if (Pin.Label.ToString() == ToPin)
                    {
                        bFoundPin = true;
                        break;
                    }
                }
                if (!bFoundPin)
                {
                    FString AvailablePins;
                    for (const FPCGPinProperties& Pin : InPins)
                    {
                        if (!AvailablePins.IsEmpty()) AvailablePins += TEXT(", ");
                        AvailablePins += Pin.Label.ToString();
                    }
                    AddError(TEXT("invalid_pin"), ToNode, ToPin,
                        FString::Printf(TEXT("Input pin '%s' does not exist on %s. Available: %s"), *ToPin, *NodeClassMap[ToNode], *AvailablePins));
                }
            }
        }
    }

    // Layer 6: DAG check — Kahn's algorithm
    TMap<FString, TArray<FString>> AdjList;
    TMap<FString, int32> InDegree;
    for (const auto& Pair : NodeClassMap)
    {
        AdjList.Add(Pair.Key, TArray<FString>());
        InDegree.Add(Pair.Key, 0);
    }

    for (int32 i = 0; i < EdgesArray->Num(); ++i)
    {
        const TSharedPtr<FJsonObject>* EdgeObj;
        if (!(*EdgesArray)[i]->TryGetObject(EdgeObj)) continue;

        FString FromNode, ToNode;
        if (!(*EdgeObj)->TryGetStringField(TEXT("fromNode"), FromNode))
            (*EdgeObj)->TryGetStringField(TEXT("from"), FromNode);
        if (!(*EdgeObj)->TryGetStringField(TEXT("toNode"), ToNode))
            (*EdgeObj)->TryGetStringField(TEXT("to"), ToNode);

        if (AdjList.Contains(FromNode) && InDegree.Contains(ToNode))
        {
            AdjList[FromNode].Add(ToNode);
            InDegree[ToNode]++;
        }
    }

    TQueue<FString> Queue;
    for (const auto& Pair : InDegree)
    {
        if (Pair.Value == 0) Queue.Enqueue(Pair.Key);
    }

    int32 Visited = 0;
    while (!Queue.IsEmpty())
    {
        FString Current;
        Queue.Dequeue(Current);
        Visited++;

        if (AdjList.Contains(Current))
        {
            for (const FString& Neighbor : AdjList[Current])
            {
                InDegree[Neighbor]--;
                if (InDegree[Neighbor] == 0) Queue.Enqueue(Neighbor);
            }
        }
    }

    if (Visited < NodeClassMap.Num())
    {
        AddError(TEXT("cycle"), TEXT(""), TEXT(""), TEXT("Graph contains a cycle — PCG graphs must be directed acyclic graphs (DAGs)"));
    }

    // Check required inputs are connected
    TSet<FString> ConnectedInputs;
    for (int32 i = 0; i < EdgesArray->Num(); ++i)
    {
        const TSharedPtr<FJsonObject>* EdgeObj;
        if (!(*EdgesArray)[i]->TryGetObject(EdgeObj)) continue;
        FString ToNode, ToPin;
        if (!(*EdgeObj)->TryGetStringField(TEXT("toNode"), ToNode))
            (*EdgeObj)->TryGetStringField(TEXT("to"), ToNode);
        (*EdgeObj)->TryGetStringField(TEXT("toPin"), ToPin);
        ConnectedInputs.Add(FString::Printf(TEXT("%s:%s"), *ToNode, *ToPin));
    }

    for (const auto& Pair : NodeUClassMap)
    {
        const UPCGSettings* CDO = Pair.Value->GetDefaultObject<UPCGSettings>();
        if (!CDO) continue;

        TArray<FPCGPinProperties> InPins = CDO->InputPinProperties();
        for (const FPCGPinProperties& Pin : InPins)
        {
            if (Pin.IsRequiredPin())
            {
                FString Key = FString::Printf(TEXT("%s:%s"), *Pair.Key, *Pin.Label.ToString());
                if (!ConnectedInputs.Contains(Key))
                {
                    AddError(TEXT("missing_required_input"), Pair.Key, Pin.Label.ToString(),
                        FString::Printf(TEXT("Required input pin '%s' on %s is not connected"), *Pin.Label.ToString(), *NodeClassMap[Pair.Key]));
                }
            }
        }
    }

    return Errors;
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_ExecuteGraph(const TSharedPtr<FJsonObject>& Params)
{
    // LoadObject, TActorIterator on the editor world, and UPCGComponent::Generate
    // all require the game thread. Dispatcher marshals via RunOnGameThread.
    check(IsInGameThread());

    FString AssetPath;
    if (!Params->TryGetStringField(TEXT("assetPath"), AssetPath))
    {
        return FHaybaHandlerResult::Err(TEXT("Missing required param: assetPath"));
    }

    UPCGGraph* Graph = LoadObject<UPCGGraph>(nullptr, *AssetPath);
    if (!Graph)
    {
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("Graph not found: %s"), *AssetPath));
    }

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        return FHaybaHandlerResult::Err(TEXT("No editor world available"));
    }

    int32 ExecutedCount = 0;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* Actor = *It;
        TArray<UPCGComponent*> PCGComponents;
        Actor->GetComponents<UPCGComponent>(PCGComponents);

        for (UPCGComponent* Comp : PCGComponents)
        {
            if (Comp && Comp->GetGraph() == Graph)
            {
                Comp->Generate();
                ExecutedCount++;
            }
        }
    }

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetBoolField(TEXT("success"), true);
    Data->SetNumberField(TEXT("componentsExecuted"), ExecutedCount);

    if (ExecutedCount == 0)
    {
        Data->SetStringField(TEXT("note"), TEXT("No PCGComponents found using this graph. Place an actor with a PCGComponent referencing this graph to see results."));
    }

    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_WizardChat(const TSharedPtr<FJsonObject>& Params)
{
    FString SessionId, Message, Goal;
    Params->TryGetStringField(TEXT("sessionId"), SessionId);
    Params->TryGetStringField(TEXT("message"), Message);
    Params->TryGetStringField(TEXT("goal"), Goal);

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());

    if (Message.StartsWith(TEXT("[INIT]")))
    {
        TArray<TSharedPtr<FJsonValue>> Steps;
        auto AddStep = [&Steps](const FString& Name)
        {
            TSharedPtr<FJsonObject> Step = MakeShareable(new FJsonObject());
            Step->SetStringField(TEXT("name"), Name);
            Steps.Add(MakeShareable(new FJsonValueObject(Step.ToSharedRef())));
        };

        FString GoalLower = Goal.ToLower();
        if (GoalLower.Contains(TEXT("city")) || GoalLower.Contains(TEXT("urban")))
        {
            AddStep(TEXT("Base Layout"));
            AddStep(TEXT("Road Network"));
            AddStep(TEXT("Parceling"));
            AddStep(TEXT("Building Placement"));
        }
        else if (GoalLower.Contains(TEXT("dungeon")) || GoalLower.Contains(TEXT("room")))
        {
            AddStep(TEXT("Room Generation"));
            AddStep(TEXT("Corridors"));
            AddStep(TEXT("Doors & Connections"));
            AddStep(TEXT("Props & Details"));
        }
        else if (GoalLower.Contains(TEXT("forest")) || GoalLower.Contains(TEXT("path")))
        {
            AddStep(TEXT("Point Scatter"));
            AddStep(TEXT("Path Network"));
            AddStep(TEXT("Path Smoothing"));
            AddStep(TEXT("Foliage Placement"));
        }
        else
        {
            AddStep(TEXT("Base Points"));
            AddStep(TEXT("Graph Structure"));
            AddStep(TEXT("Refinement"));
            AddStep(TEXT("Output"));
        }

        Data->SetArrayField(TEXT("steps"), Steps);

        // Build step list string
        FString StepList;
        for (int32 i = 0; i < Steps.Num(); i++)
        {
            FString Name;
            Steps[i]->AsObject()->TryGetStringField(TEXT("name"), Name);
            StepList += FString::Printf(TEXT("  Step %d: %s\n"), i + 1, *Name);
        }
        FString FirstStep;
        if (Steps.Num() > 0) Steps[0]->AsObject()->TryGetStringField(TEXT("name"), FirstStep);

        Data->SetStringField(TEXT("message"),
            FString::Printf(TEXT("I'll break this into %d steps:\n\n%s\nLet's start with %s. What kind of layout do you want?"),
                Steps.Num(), *StepList, *FirstStep));
    }
    else if (Message.StartsWith(TEXT("[FINALIZE]")))
    {
        Data->SetStringField(TEXT("message"), TEXT("All steps complete! The final combined graph is ready. Use 'Create in UE' to generate the full result."));
    }
    else
    {
        Data->SetStringField(TEXT("message"), TEXT("Got it. Based on your input, I'm generating the graph for this step. One moment..."));
    }

    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_ImportLandscape(const TSharedPtr<FJsonObject>& Params)
{
    // Hard guarantee: this command calls World->SpawnActor + LoadObject +
    // ALandscape::Import, all of which require the game thread. The dispatch
    // in Handle() marshals via RunOnGameThread, so a fail here would mean a
    // future regression broke that contract — better to die loudly than
    // silently corrupt UObject state (as in the 2026-05-23 crash).
    check(IsInGameThread());

    FHaybaMCPImportParams ImportParams;

    // Required
    if (!Params->TryGetStringField(TEXT("heightmapPath"), ImportParams.HeightmapPath) || ImportParams.HeightmapPath.IsEmpty())
    {
        return FHaybaHandlerResult::Err(TEXT("heightmapPath is required"));
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

    const bool bSuccess = FHaybaMCPLandscapeImporter::ImportHeightmap(ImportParams);

    if (!bSuccess)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("Failed to import landscape from: %s"), *ImportParams.HeightmapPath));
    }

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetStringField(TEXT("actorLabel"), ImportParams.ActorLabel);
    Data->SetStringField(TEXT("heightmapPath"), ImportParams.HeightmapPath);
    Data->SetNumberField(TEXT("worldSizeKm"), ImportParams.WorldSizeKm);
    Data->SetNumberField(TEXT("maxHeightM"),  ImportParams.MaxHeightM);

    return FHaybaHandlerResult::Ok(Data);
}

// Cmd_ReadNodeOutput
// Reads the output point/spline data for a specific node in a PCG graph after execution.
// The graph must already have been executed (via execute_graph) before calling this.
// Params: { assetPath: string, nodeId: string }
// Response data: { geometry_type, point_count, attributes[], value_ranges{} }
//
// NOTE: PCG executes the full graph, not individual nodes. This command reads the cached
// output data stored on the PCGComponent after the last Generate() call. If the graph has
// not been executed yet, the output data will be empty and point_count will be 0.
FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_ReadNodeOutput(const TSharedPtr<FJsonObject>& Params)
{
    // LoadObject + TActorIterator on the editor world must run on the game thread.
    check(IsInGameThread());

    FString AssetPath;
    FString NodeId;

    if (!Params->TryGetStringField(TEXT("assetPath"), AssetPath) || AssetPath.IsEmpty())
    {
        return FHaybaHandlerResult::Err(TEXT("Missing required param: assetPath"));
    }
    if (!Params->TryGetStringField(TEXT("nodeId"), NodeId) || NodeId.IsEmpty())
    {
        return FHaybaHandlerResult::Err(TEXT("Missing required param: nodeId"));
    }

    UPCGGraph* Graph = LoadObject<UPCGGraph>(nullptr, *AssetPath);
    if (!Graph)
    {
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("Graph not found: %s"), *AssetPath));
    }

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        return FHaybaHandlerResult::Err(TEXT("No editor world available"));
    }

    // Build response features
    TSharedPtr<FJsonObject> Features = MakeShareable(new FJsonObject());
    int32 TotalPointCount = 0;
    TArray<TSharedPtr<FJsonValue>> AttrNames;
    TSharedPtr<FJsonObject> ValueRanges = MakeShareable(new FJsonObject());
    FString GeometryType = TEXT("unknown");

    // Walk all actors with a PCGComponent referencing this graph
    // and read their cached output data after the last Generate() call.
    bool bFoundAnyComponent = false;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        TArray<UPCGComponent*> PCGComponents;
        (*It)->GetComponents<UPCGComponent>(PCGComponents);

        for (UPCGComponent* Comp : PCGComponents)
        {
            if (!Comp || Comp->GetGraph() != Graph) continue;
            bFoundAnyComponent = true;

            TArray<FPCGTaggedData> OutputData = Comp->GetGeneratedGraphOutput().TaggedData;
            for (const FPCGTaggedData& Tagged : OutputData)
            {
                if (!Tagged.Data) continue;

                if (const UPCGPointData* PointData = Cast<UPCGPointData>(Tagged.Data))
                {
                    GeometryType = TEXT("points");
                    TotalPointCount += PointData->GetPoints().Num();

                    if (const UPCGMetadata* Meta = PointData->ConstMetadata())
                    {
                        TArray<FName> AttrNamesList;
                        TArray<EPCGMetadataTypes> AttrTypesUnused;
                        Meta->GetAttributes(AttrNamesList, AttrTypesUnused);
                        for (const FName& AttrName : AttrNamesList)
                        {
                            const FString AttrStr = AttrName.ToString();
                            bool bAlreadyAdded = false;
                            for (const auto& V : AttrNames)
                            {
                                if (V->AsString() == AttrStr) { bAlreadyAdded = true; break; }
                            }
                            if (!bAlreadyAdded)
                            {
                                AttrNames.Add(MakeShared<FJsonValueString>(AttrStr));
                            }
                        }
                    }
                }
                else if (Tagged.Data->IsA<UPCGSplineData>() || Tagged.Data->IsA<UPCGPolyLineData>())
                {
                    GeometryType = TEXT("splines");
                }
            }
        }
    }

    Features->SetStringField(TEXT("geometry_type"), GeometryType);
    Features->SetNumberField(TEXT("point_count"), TotalPointCount);
    Features->SetArrayField(TEXT("attributes"), AttrNames);
    Features->SetObjectField(TEXT("value_ranges"), ValueRanges);

    if (!bFoundAnyComponent)
    {
        Features->SetStringField(TEXT("note"), TEXT("No PCGComponents found for this graph. Place an actor with a PCGComponent referencing this graph."));
    }

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetBoolField(TEXT("success"), true);
    Data->SetObjectField(TEXT("features"), Features);

    return FHaybaHandlerResult::Ok(Data);
}

// Cmd_DescribeAssets
// Lists assets from the AssetRegistry under one or more package paths.
//
// Params (all optional):
//   path:   string    — single root, default "/Game" (recursive)
//   paths:  string[]  — explicit object-path list; each entry queried
//                       individually. Takes precedence over `path`.
//   class:  string    — case-insensitive class-name substring filter
//                       (e.g. "StaticMesh", "Material", "PCGGraph")
//   tag:    string    — case-insensitive substring filter on asset tags
//                       (matches any tag key or value)
//   limit:  int       — default 200, max 2000
//   offset: int       — default 0
//
// Response shape matches what the TS asset-retriever expects:
//   { assets: [{ path, name, class, tags[], lastModified, package_name,
//                asset_name, asset_class }], total, offset, limit }
//
// AssetRegistry reads are documented thread-safe, but the dispatcher routes
// this through RunOnGameThread so any future caller pattern stays safe.
FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_DescribeAssets(const TSharedPtr<FJsonObject>& Params)
{
    check(IsInGameThread());

    FString SinglePath = TEXT("/Game");
    FString ClassFilter;
    FString TagFilter;
    int32 Limit = 200;
    int32 Offset = 0;

    if (Params.IsValid())
    {
        Params->TryGetStringField(TEXT("path"), SinglePath);
        Params->TryGetStringField(TEXT("class"), ClassFilter);
        Params->TryGetStringField(TEXT("tag"), TagFilter);
        int32 RawLimit = 0;
        if (Params->TryGetNumberField(TEXT("limit"), RawLimit) && RawLimit > 0)
        {
            Limit = FMath::Clamp(RawLimit, 1, 2000);
        }
        int32 RawOffset = 0;
        if (Params->TryGetNumberField(TEXT("offset"), RawOffset) && RawOffset >= 0)
        {
            Offset = RawOffset;
        }
    }

    // Normalize "/Game/" -> "/Game" so AssetRegistry accepts it as a package path
    auto NormalizePath = [](const FString& In) -> FString
    {
        FString P = In;
        while (P.Len() > 1 && P.EndsWith(TEXT("/")))
        {
            P = P.LeftChop(1);
        }
        if (P.IsEmpty()) P = TEXT("/Game");
        return P;
    };

    TArray<FString> QueryPaths;
    bool bExplicitPaths = false;
    if (Params.IsValid())
    {
        const TArray<TSharedPtr<FJsonValue>>* PathsArr = nullptr;
        if (Params->TryGetArrayField(TEXT("paths"), PathsArr) && PathsArr)
        {
            bExplicitPaths = true;
            for (const TSharedPtr<FJsonValue>& V : *PathsArr)
            {
                FString S;
                if (V.IsValid() && V->TryGetString(S) && !S.IsEmpty())
                {
                    QueryPaths.Add(NormalizePath(S));
                }
            }
        }
    }
    if (QueryPaths.Num() == 0)
    {
        QueryPaths.Add(NormalizePath(SinglePath));
    }

    FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
    IAssetRegistry& Registry = ARM.Get();

    TArray<FAssetData> Collected;
    for (const FString& Q : QueryPaths)
    {
        if (bExplicitPaths)
        {
            // Explicit-paths form: each entry may be either an object path
            // ("/Game/Foo/Bar.Bar") or a package directory ("/Game/Foo").
            // Try object lookup first, then fall back to non-recursive
            // directory listing so the caller gets exactly what they asked
            // for rather than a recursive dump.
            FAssetData Hit = Registry.GetAssetByObjectPath(FSoftObjectPath(Q));
            if (Hit.IsValid())
            {
                Collected.Add(MoveTemp(Hit));
            }
            else
            {
                TArray<FAssetData> Bucket;
                Registry.GetAssetsByPath(FName(*Q), Bucket, /*bRecursive=*/false);
                Collected.Append(MoveTemp(Bucket));
            }
        }
        else
        {
            TArray<FAssetData> Bucket;
            Registry.GetAssetsByPath(FName(*Q), Bucket, /*bRecursive=*/true);
            Collected.Append(MoveTemp(Bucket));
        }
    }

    // Filter by class name (substring, case-insensitive)
    if (!ClassFilter.IsEmpty())
    {
        Collected.RemoveAll([&ClassFilter](const FAssetData& A)
        {
            return !A.AssetClassPath.GetAssetName().ToString().Contains(
                ClassFilter, ESearchCase::IgnoreCase);
        });
    }

    // Filter by tag (substring, case-insensitive) — checks both key and value
    if (!TagFilter.IsEmpty())
    {
        Collected.RemoveAll([&TagFilter](const FAssetData& A)
        {
            for (const auto& Pair : A.TagsAndValues)
            {
                if (Pair.Key.ToString().Contains(TagFilter, ESearchCase::IgnoreCase)
                    || Pair.Value.GetValue().Contains(TagFilter, ESearchCase::IgnoreCase))
                {
                    return false; // keep
                }
            }
            return true; // drop
        });
    }

    const int32 Total = Collected.Num();
    const int32 Start = FMath::Clamp(Offset, 0, Total);
    const int32 End   = FMath::Clamp(Start + Limit, Start, Total);

    TArray<TSharedPtr<FJsonValue>> AssetsJson;
    AssetsJson.Reserve(End - Start);
    for (int32 i = Start; i < End; ++i)
    {
        const FAssetData& A = Collected[i];
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();

        // TS-side asset-retriever expects: path, name, class, tags[], lastModified.
        // package_name + asset_name + asset_class are also surfaced so future
        // TS consumers can avoid re-parsing the object path.
        Entry->SetStringField(TEXT("path"), A.GetObjectPathString());
        Entry->SetStringField(TEXT("name"), A.AssetName.ToString());
        Entry->SetStringField(TEXT("class"), A.AssetClassPath.GetAssetName().ToString());
        Entry->SetStringField(TEXT("package_name"), A.PackageName.ToString());
        Entry->SetStringField(TEXT("asset_name"), A.AssetName.ToString());
        Entry->SetStringField(TEXT("asset_class"), A.AssetClassPath.GetAssetName().ToString());

        TArray<TSharedPtr<FJsonValue>> TagsJson;
        for (const auto& Pair : A.TagsAndValues)
        {
            const FString Combined = FString::Printf(TEXT("%s=%s"),
                *Pair.Key.ToString(), *Pair.Value.GetValue());
            TagsJson.Add(MakeShared<FJsonValueString>(Combined));
        }
        Entry->SetArrayField(TEXT("tags"), TagsJson);

        // lastModified is not directly tracked by AssetRegistry; emit 0 so the
        // TS normalizer's default kicks in cleanly. (Could be wired up via
        // IFileManager::GetTimeStamp on the package filename if needed later.)
        Entry->SetNumberField(TEXT("lastModified"), 0);

        AssetsJson.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
    Data->SetArrayField(TEXT("assets"), AssetsJson);
    Data->SetNumberField(TEXT("total"), Total);
    Data->SetNumberField(TEXT("offset"), Start);
    Data->SetNumberField(TEXT("limit"), Limit);
    return FHaybaHandlerResult::Ok(Data);
}
