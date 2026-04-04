#include "PCGExBridgeCommandHandler.h"
#include "Json.h"
#include "JsonUtilities.h"
#include "PCGSettings.h"
#include "PCGPin.h"
#include "PCGGraph.h"
#include "PCGNode.h"
#include "PCGEdge.h"
#include "Data/Registry/PCGDataTypeIdentifier.h"
#include "PCGComponent.h"
#include "UObject/UObjectIterator.h"
#include "UObject/SavePackage.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Editor.h"
#include "EngineUtils.h"

DEFINE_LOG_CATEGORY_STATIC(LogPCGExBridgeCmd, Log, All);

// Helper: serialize FJsonObject to compact string
static FString JsonToString(const TSharedRef<FJsonObject>& Obj)
{
	FString Output;
	TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
	FJsonSerializer::Serialize(Obj, Writer);
	return Output;
}

FPCGExBridgeCommandHandler::FPCGExBridgeCommandHandler()
{
	CommandMap.Add(TEXT("ping"), &FPCGExBridgeCommandHandler::Cmd_Ping);
	CommandMap.Add(TEXT("list_node_classes"), &FPCGExBridgeCommandHandler::Cmd_ListNodeClasses);
	CommandMap.Add(TEXT("get_node_details"), &FPCGExBridgeCommandHandler::Cmd_GetNodeDetails);
	CommandMap.Add(TEXT("list_pcg_assets"), &FPCGExBridgeCommandHandler::Cmd_ListPCGAssets);
	CommandMap.Add(TEXT("export_graph"), &FPCGExBridgeCommandHandler::Cmd_ExportGraph);
	CommandMap.Add(TEXT("create_graph"), &FPCGExBridgeCommandHandler::Cmd_CreateGraph);
	CommandMap.Add(TEXT("validate_graph"), &FPCGExBridgeCommandHandler::Cmd_ValidateGraph);
	CommandMap.Add(TEXT("execute_graph"), &FPCGExBridgeCommandHandler::Cmd_ExecuteGraph);
	CommandMap.Add(TEXT("wizard_chat"), &FPCGExBridgeCommandHandler::Cmd_WizardChat);

	UE_LOG(LogPCGExBridgeCmd, Log, TEXT("Command handler initialized with %d commands"), CommandMap.Num());
}

FPCGExBridgeCommandHandler::~FPCGExBridgeCommandHandler()
{
}

FString FPCGExBridgeCommandHandler::ProcessCommand(const FString& CommandJson)
{
	// Parse incoming JSON
	TSharedPtr<FJsonObject> Parsed;
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(CommandJson);
	if (!FJsonSerializer::Deserialize(Reader, Parsed) || !Parsed.IsValid())
	{
		UE_LOG(LogPCGExBridgeCmd, Warning, TEXT("Failed to parse command JSON"));
		return MakeErrorResponse(TEXT(""), TEXT("Invalid JSON"));
	}

	FString Cmd = Parsed->GetStringField(TEXT("cmd"));
	FString Id = Parsed->GetStringField(TEXT("id"));

	TSharedPtr<FJsonObject> Params = Parsed->GetObjectField(TEXT("params"));
	if (!Params.IsValid())
	{
		Params = MakeShareable(new FJsonObject());
	}

	UE_LOG(LogPCGExBridgeCmd, Log, TEXT("Processing command: %s (id: %s)"), *Cmd, *Id);

	FCommandFunc* Handler = CommandMap.Find(Cmd);
	if (!Handler)
	{
		return MakeErrorResponse(Id, FString::Printf(TEXT("Unknown command: %s"), *Cmd));
	}

	return (this->**Handler)(Params, Id);
}

FString FPCGExBridgeCommandHandler::MakeOkResponse(const FString& Id, const TSharedPtr<FJsonObject>& Data)
{
	TSharedRef<FJsonObject> Response = MakeShareable(new FJsonObject());
	Response->SetStringField(TEXT("id"), Id);
	Response->SetBoolField(TEXT("ok"), true);
	Response->SetObjectField(TEXT("data"), Data.IsValid() ? Data.ToSharedRef() : MakeShareable(new FJsonObject()));
	return JsonToString(Response);
}

FString FPCGExBridgeCommandHandler::MakeErrorResponse(const FString& Id, const FString& ErrorMessage)
{
	TSharedRef<FJsonObject> Response = MakeShareable(new FJsonObject());
	Response->SetStringField(TEXT("id"), Id);
	Response->SetBoolField(TEXT("ok"), false);
	Response->SetStringField(TEXT("error"), ErrorMessage);
	return JsonToString(Response);
}

// --- Command implementations ---

FString FPCGExBridgeCommandHandler::Cmd_Ping(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
	TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
	Data->SetStringField(TEXT("status"), TEXT("ok"));
	Data->SetStringField(TEXT("ueVersion"), TEXT("5.7"));
	Data->SetStringField(TEXT("plugin"), TEXT("PCGExBridge"));
	Data->SetStringField(TEXT("pluginVersion"), TEXT("0.2.0"));

	UE_LOG(LogPCGExBridgeCmd, Log, TEXT("Ping command processed"));
	return MakeOkResponse(Id, Data);
}

FString FPCGExBridgeCommandHandler::Cmd_ListNodeClasses(const TSharedPtr<FJsonObject>& Params, const FString& Id)
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
	return MakeOkResponse(Id, Data);
}

TArray<UClass*> FPCGExBridgeCommandHandler::FindPCGExNodeClasses() const
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

void FPCGExBridgeCommandHandler::GetPinInfo(const UClass* SettingsClass, TArray<TSharedPtr<FJsonValue>>& OutInputs, TArray<TSharedPtr<FJsonValue>>& OutOutputs) const
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

FString FPCGExBridgeCommandHandler::Cmd_GetNodeDetails(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    FString ClassName;
    if (!Params->TryGetStringField(TEXT("class"), ClassName))
    {
        return MakeErrorResponse(Id, TEXT("Missing required param: class"));
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
        return MakeErrorResponse(Id, FString::Printf(TEXT("Class not found: %s"), *ClassName));
    }

    const UPCGSettings* CDO = FoundClass->GetDefaultObject<UPCGSettings>();
    if (!CDO)
    {
        return MakeErrorResponse(Id, FString::Printf(TEXT("Cannot create CDO for: %s"), *ClassName));
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
    return MakeOkResponse(Id, Data);
}

FString FPCGExBridgeCommandHandler::Cmd_ListPCGAssets(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
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
    return MakeOkResponse(Id, Data);
}

FString FPCGExBridgeCommandHandler::Cmd_ExportGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    FString AssetPath;
    if (!Params->TryGetStringField(TEXT("assetPath"), AssetPath))
    {
        return MakeErrorResponse(Id, TEXT("Missing required param: assetPath"));
    }

    UPCGGraph* Graph = LoadObject<UPCGGraph>(nullptr, *AssetPath);
    if (!Graph)
    {
        return MakeErrorResponse(Id, FString::Printf(TEXT("Graph not found: %s"), *AssetPath));
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
    return MakeOkResponse(Id, Data);
}

FString FPCGExBridgeCommandHandler::Cmd_CreateGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    FString Name;
    if (!Params->TryGetStringField(TEXT("name"), Name))
    {
        return MakeErrorResponse(Id, TEXT("Missing required param: name"));
    }

    const TSharedPtr<FJsonObject>* GraphObj;
    if (!Params->TryGetObjectField(TEXT("graph"), GraphObj) || !GraphObj->IsValid())
    {
        return MakeErrorResponse(Id, TEXT("Missing required param: graph"));
    }

    // Validate first
    TArray<TSharedPtr<FJsonValue>> ValidationErrors = ValidateGraphJson(*GraphObj);
    if (ValidationErrors.Num() > 0)
    {
        TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
        Data->SetBoolField(TEXT("created"), false);
        Data->SetArrayField(TEXT("errors"), ValidationErrors);
        return MakeOkResponse(Id, Data);
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

    FString PackagePath = TEXT("/Game/PCGExBridge/Generated");
    FString FullPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *SafeName);

    UPackage* Package = CreatePackage(*FullPath);
    if (!Package)
    {
        return MakeErrorResponse(Id, TEXT("Failed to create package"));
    }

    UPCGGraph* NewGraph = NewObject<UPCGGraph>(Package, *SafeName, RF_Public | RF_Standalone);
    if (!NewGraph)
    {
        return MakeErrorResponse(Id, TEXT("Failed to create PCGGraph object"));
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
    return MakeOkResponse(Id, Data);
}

FString FPCGExBridgeCommandHandler::Cmd_ValidateGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id)
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
        return MakeOkResponse(Id, Data);
    }

    TArray<TSharedPtr<FJsonValue>> Errors = ValidateGraphJson(*GraphObj);

    TSharedPtr<FJsonObject> Data = MakeShareable(new FJsonObject());
    Data->SetBoolField(TEXT("valid"), Errors.Num() == 0);
    Data->SetArrayField(TEXT("errors"), Errors);
    Data->SetNumberField(TEXT("errorCount"), Errors.Num());
    return MakeOkResponse(Id, Data);
}

TArray<TSharedPtr<FJsonValue>> FPCGExBridgeCommandHandler::ValidateGraphJson(const TSharedPtr<FJsonObject>& Graph) const
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
                                if ((static_cast<EPCGDataType>(FromPinType) & static_cast<EPCGDataType>(Pin.AllowedTypes)) == EPCGDataType::None)
                                {
                                    AddError(TEXT("incompatible_connection"), FromNode, FromPin,
                                        FString::Printf(TEXT("Cannot connect %s:%s (type %s) to %s:%s (accepts %s)"),
                                            *FromNode, *FromPin, *UEnum::GetValueAsString(static_cast<EPCGDataType>(FromPinType)),
                                            *ToNode, *ToPin, *UEnum::GetValueAsString(static_cast<EPCGDataType>(Pin.AllowedTypes))));
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

FString FPCGExBridgeCommandHandler::Cmd_ExecuteGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id)
{
    FString AssetPath;
    if (!Params->TryGetStringField(TEXT("assetPath"), AssetPath))
    {
        return MakeErrorResponse(Id, TEXT("Missing required param: assetPath"));
    }

    UPCGGraph* Graph = LoadObject<UPCGGraph>(nullptr, *AssetPath);
    if (!Graph)
    {
        return MakeErrorResponse(Id, FString::Printf(TEXT("Graph not found: %s"), *AssetPath));
    }

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        return MakeErrorResponse(Id, TEXT("No editor world available"));
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

    return MakeOkResponse(Id, Data);
}

FString FPCGExBridgeCommandHandler::Cmd_WizardChat(const TSharedPtr<FJsonObject>& Params, const FString& Id)
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

    return MakeOkResponse(Id, Data);
}
