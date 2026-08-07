#include "HaybaMCPBlueprintHandler.h"
#include "HaybaMCPReflection.h"
#include "Json.h"
#include "Editor.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Logging/TokenizedMessage.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/SimpleConstructionScript.h"
#include "Engine/SCS_Node.h"
#include "EdGraphSchema_K2.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphPin.h"
#include "K2Node.h"
#include "K2Node_Event.h"
#include "K2Node_CallFunction.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Misc/PackageName.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPBlueprint, Log, All);
// Initiative #6 — per-compile audit log. The top-level command journal
// (FHaybaMCPSecurityManager::Journal) captures command ok/err, but compile
// counts/first-error are domain-specific and live here.
DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPBP, Log, All);

TArray<FString> FHaybaMCPBlueprintHandler::GetCommands() const
{
    return {
        TEXT("blueprint_create"),
        TEXT("blueprint_get_info"),
        TEXT("blueprint_add_component"),
        TEXT("blueprint_add_variable"),
        TEXT("blueprint_add_function"),
        TEXT("blueprint_add_node"),
        TEXT("blueprint_connect_nodes"),
        TEXT("blueprint_compile"),
        TEXT("blueprint_document"),
        TEXT("blueprint_add_event"),
        TEXT("blueprint_set_defaults"),
        TEXT("blueprint_set_pin_default"),
    };
}

TSet<FString>& FHaybaMCPBlueprintHandler::BrokenBlueprintsRef()
{
    static TSet<FString> S;
    return S;
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::MaybeRejectIfBroken(const TSharedPtr<FJsonObject>& P) const
{
    FString Path;
    if (P.IsValid() && P->TryGetStringField(TEXT("path"), Path) && BrokenBlueprintsRef().Contains(Path))
    {
        auto Data = MakeShared<FJsonObject>();
        Data->SetStringField(TEXT("status"), TEXT("bp_compile_required"));
        Data->SetStringField(TEXT("path"), Path);
        Data->SetStringField(TEXT("hint"),
            TEXT("This Blueprint failed its last compile. Call blueprint_compile to inspect errors and run a clean compile before mutating it further."));
        return FHaybaHandlerResult::Ok(Data);
    }
    return FHaybaHandlerResult::Ok(MakeShared<FJsonObject>());  // marker — caller proceeds
}

static void AttachCompileReport(const TSharedPtr<FJsonObject>& Out, bool bClean,
    const TArray<FString>& Errors, const TArray<FString>& Warnings)
{
    Out->SetBoolField(TEXT("compiled_clean"), bClean);
    if (!bClean)
    {
        TArray<TSharedPtr<FJsonValue>> ErrJson;
        for (const FString& E : Errors) ErrJson.Add(MakeShared<FJsonValueString>(E));
        Out->SetArrayField(TEXT("compile_errors"), ErrJson);
        Out->SetStringField(TEXT("hint"),
            TEXT("Blueprint is now in a broken state — subsequent mutating commands will be rejected with bp_compile_required until a clean compile."));
    }
    if (Warnings.Num() > 0)
    {
        TArray<TSharedPtr<FJsonValue>> WJson;
        for (const FString& W : Warnings) WJson.Add(MakeShared<FJsonValueString>(W));
        Out->SetArrayField(TEXT("compile_warnings"), WJson);
    }
}

bool FHaybaMCPBlueprintHandler::RecompileAndTrack(UBlueprint* BP, TArray<FString>& OutErrors, TArray<FString>& OutWarnings)
{
    if (!BP) return false;
    FCompilerResultsLog ResultsLog;
    ResultsLog.SetSourcePath(BP->GetPathName());
    ResultsLog.BeginEvent(TEXT("Compile"));
    FKismetEditorUtilities::CompileBlueprint(BP, EBlueprintCompileOptions::None, &ResultsLog);
    ResultsLog.EndEvent();

    for (const TSharedRef<FTokenizedMessage>& Msg : ResultsLog.Messages)
    {
        const FString Text = Msg->ToText().ToString();
        const EMessageSeverity::Type Sev = Msg->GetSeverity();
        if (Sev == EMessageSeverity::Error)   OutErrors.Add(Text);
        else if (Sev == EMessageSeverity::Warning) OutWarnings.Add(Text);
    }
    const bool bOk = (BP->Status == BS_UpToDate || BP->Status == BS_UpToDateWithWarnings);
    const FString Path = BP->GetPathName();
    if (bOk) BrokenBlueprintsRef().Remove(Path);
    else     BrokenBlueprintsRef().Add(Path);

    // Initiative #6 — execution-journal logging. The top-level
    // FHaybaMCPSecurityManager::Journal captures command ok/err per request;
    // compile-error counts + first-error are domain-specific and recorded here
    // via LogHaybaMCPBP. Always emit so a clean compile is also auditable.
    const FString FirstError = OutErrors.Num() > 0 ? OutErrors[0] : TEXT("(none)");
    UE_LOG(LogHaybaMCPBP, Warning,
        TEXT("BP compile %s: ok=%d errors=%d warnings=%d first=%s"),
        *Path, bOk ? 1 : 0, OutErrors.Num(), OutWarnings.Num(), *FirstError);
    return bOk;
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    // Compile-gate every mutating BP command. Reads + blueprint_compile bypass.
    static const TSet<FString> MutatingCommands = {
        TEXT("blueprint_add_component"), TEXT("blueprint_add_variable"),
        TEXT("blueprint_add_function"),  TEXT("blueprint_add_node"),
        TEXT("blueprint_connect_nodes"), TEXT("blueprint_add_event"),
        TEXT("blueprint_set_defaults"), TEXT("blueprint_set_pin_default"),
    };
    if (MutatingCommands.Contains(Cmd))
    {
        FHaybaHandlerResult Gate = MaybeRejectIfBroken(P);
        FString Status;
        if (Gate.bOk && Gate.Data.IsValid() && Gate.Data->TryGetStringField(TEXT("status"), Status)
            && Status == TEXT("bp_compile_required"))
        {
            return Gate;
        }
    }

    if (Cmd == TEXT("blueprint_create"))         return Create(P);
    if (Cmd == TEXT("blueprint_get_info"))       return GetInfo(P);
    if (Cmd == TEXT("blueprint_add_component"))  return AddComponent(P);
    if (Cmd == TEXT("blueprint_add_variable"))   return AddVariable(P);
    if (Cmd == TEXT("blueprint_add_function"))   return AddFunction(P);
    if (Cmd == TEXT("blueprint_add_node"))       return AddNode(P);
    if (Cmd == TEXT("blueprint_connect_nodes")) return ConnectNodes(P);
    if (Cmd == TEXT("blueprint_compile"))        return Compile(P);
    if (Cmd == TEXT("blueprint_document"))       return Document(P);
    if (Cmd == TEXT("blueprint_add_event"))      return AddEvent(P);
    if (Cmd == TEXT("blueprint_set_defaults"))   return SetDefaults(P);
    if (Cmd == TEXT("blueprint_set_pin_default")) return SetPinDefault(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("BlueprintHandler: unknown command %s"), *Cmd));
}

static UBlueprint* LoadBPByPath(const FString& Path)
{
    return LoadObject<UBlueprint>(nullptr, *Path);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::Create(const TSharedPtr<FJsonObject>& P)
{
    FString ParentPath, PkgPath, Name;
    if (!P->TryGetStringField(TEXT("parent_class_path"), ParentPath) || ParentPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("blueprint_create: missing parent_class_path"));
    if (!P->TryGetStringField(TEXT("package_path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("blueprint_create: missing package_path"));
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("blueprint_create: missing name"));

    UClass* ParentClass = LoadClass<UObject>(nullptr, *ParentPath);
    if (!ParentClass)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("blueprint_create: parent class not found: %s"), *ParentPath));

    // package_path follows the same contract as material_create: it is the
    // full intended asset path (its trailing component is the asset name).
    // Strip to the directory and re-compose <dir>/<name> so the asset lands at
    // the standard /Game/Dir/Name.Name — NOT the malformed /Game/Dir.Name that
    // results from using package_path directly as the package and Name as a
    // sub-object inside it.
    const FString Dir = FPackageName::GetLongPackagePath(PkgPath);
    const FString FullPackageName = Dir / Name;
    UPackage* Package = CreatePackage(*FullPackageName);
    if (!Package)
        return FHaybaHandlerResult::Err(TEXT("blueprint_create: CreatePackage failed"));

    UBlueprint* BP = FKismetEditorUtilities::CreateBlueprint(
        ParentClass, Package, *Name, BPTYPE_Normal,
        UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass());
    if (!BP)
        return FHaybaHandlerResult::Err(TEXT("blueprint_create: CreateBlueprint failed"));

    FAssetRegistryModule::AssetCreated(BP);
    Package->MarkPackageDirty();

    // Persist immediately: CreateBlueprint only builds the asset in memory, so a
    // crash before the next edit would lose it. Save the .uasset to disk now.
    bool bSaved = false;
    {
        const FString FileName = FPackageName::LongPackageNameToFilename(
            Package->GetName(), FPackageName::GetAssetPackageExtension());
        FSavePackageArgs SaveArgs;
        SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
        SaveArgs.SaveFlags = SAVE_NoError;
        bSaved = UPackage::SavePackage(Package, BP, *FileName, SaveArgs);
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), BP->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    Out->SetBoolField(TEXT("saved"), bSaved);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::GetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("blueprint_get_info: missing path"));
    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_get_info: blueprint not found"));

    TArray<TSharedPtr<FJsonValue>> Vars;
    for (const FBPVariableDescription& V : BP->NewVariables)
    {
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), V.VarName.ToString());
        Entry->SetStringField(TEXT("type"), V.VarType.PinCategory.ToString());
        Vars.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TArray<TSharedPtr<FJsonValue>> Funcs;
    for (UEdGraph* G : BP->FunctionGraphs)
    {
        if (G) Funcs.Add(MakeShared<FJsonValueString>(G->GetName()));
    }

    TArray<TSharedPtr<FJsonValue>> Comps;
    if (BP->SimpleConstructionScript)
    {
        for (USCS_Node* Node : BP->SimpleConstructionScript->GetAllNodes())
        {
            if (!Node) continue;
            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("name"),  Node->GetVariableName().ToString());
            Entry->SetStringField(TEXT("class"), Node->ComponentClass ? Node->ComponentClass->GetName() : TEXT(""));
            Comps.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("name"), BP->GetName());
    Out->SetStringField(TEXT("parent_class"), BP->ParentClass ? BP->ParentClass->GetPathName() : TEXT(""));
    Out->SetArrayField(TEXT("variables"), Vars);
    Out->SetArrayField(TEXT("functions"), Funcs);
    Out->SetArrayField(TEXT("components"), Comps);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddComponent(const TSharedPtr<FJsonObject>& P)
{
    FString Path, CompClassPath, CompName;
    if (!P->TryGetStringField(TEXT("path"), Path)) return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: missing path"));
    if (!P->TryGetStringField(TEXT("component_class_path"), CompClassPath)) return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: missing component_class_path"));
    if (!P->TryGetStringField(TEXT("component_name"), CompName)) return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: missing component_name"));

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: blueprint not found"));
    UClass* CompClass = LoadClass<UActorComponent>(nullptr, *CompClassPath);
    if (!CompClass) return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: component class not found"));
    if (!BP->SimpleConstructionScript)
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: blueprint has no SCS"));

    USCS_Node* Node = BP->SimpleConstructionScript->CreateNode(CompClass, FName(*CompName));
    if (!Node) return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: CreateNode failed"));
    BP->SimpleConstructionScript->AddNode(Node);
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("component_name"), CompName);
    AttachCompileReport(Out, bClean, Errors, Warnings);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddVariable(const TSharedPtr<FJsonObject>& P)
{
    FString Path, VarName, VarType;
    if (!P->TryGetStringField(TEXT("path"), Path)) return FHaybaHandlerResult::Err(TEXT("blueprint_add_variable: missing path"));
    if (!P->TryGetStringField(TEXT("variable_name"), VarName)) return FHaybaHandlerResult::Err(TEXT("blueprint_add_variable: missing variable_name"));
    if (!P->TryGetStringField(TEXT("variable_type"), VarType)) return FHaybaHandlerResult::Err(TEXT("blueprint_add_variable: missing variable_type"));

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_add_variable: blueprint not found"));

    FEdGraphPinType PinType;
    FString L = VarType.ToLower();
    if (L == TEXT("float") || L == TEXT("double"))      PinType.PinCategory = UEdGraphSchema_K2::PC_Real, PinType.PinSubCategory = UEdGraphSchema_K2::PC_Double;
    else if (L == TEXT("int") || L == TEXT("integer"))  PinType.PinCategory = UEdGraphSchema_K2::PC_Int;
    else if (L == TEXT("bool") || L == TEXT("boolean")) PinType.PinCategory = UEdGraphSchema_K2::PC_Boolean;
    else if (L == TEXT("string") || L == TEXT("fstring")) PinType.PinCategory = UEdGraphSchema_K2::PC_String;
    else if (L == TEXT("name") || L == TEXT("fname"))   PinType.PinCategory = UEdGraphSchema_K2::PC_Name;
    else if (L == TEXT("text") || L == TEXT("ftext"))   PinType.PinCategory = UEdGraphSchema_K2::PC_Text;
    else PinType.PinCategory = UEdGraphSchema_K2::PC_String;

    bool bAdded = FBlueprintEditorUtils::AddMemberVariable(BP, FName(*VarName), PinType);
    if (!bAdded) return FHaybaHandlerResult::Err(TEXT("blueprint_add_variable: AddMemberVariable failed"));

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("variable_name"), VarName);
    Out->SetStringField(TEXT("type"), VarType);
    AttachCompileReport(Out, bClean, Errors, Warnings);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddFunction(const TSharedPtr<FJsonObject>& P)
{
    FString Path, FuncName;
    if (!P->TryGetStringField(TEXT("path"), Path)) return FHaybaHandlerResult::Err(TEXT("blueprint_add_function: missing path"));
    if (!P->TryGetStringField(TEXT("function_name"), FuncName)) return FHaybaHandlerResult::Err(TEXT("blueprint_add_function: missing function_name"));

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_add_function: blueprint not found"));

    UEdGraph* NewGraph = FBlueprintEditorUtils::CreateNewGraph(
        BP, FName(*FuncName), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
    if (!NewGraph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_function: CreateNewGraph failed"));

    FBlueprintEditorUtils::AddFunctionGraph<UClass>(BP, NewGraph, /*bIsUserCreated*/true, nullptr);

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("function_name"), FuncName);
    AttachCompileReport(Out, bClean, Errors, Warnings);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// Blueprint graph authoring.
//
// add_node / connect_nodes / add_event shipped as not_implemented_in_v1 stubs while
// still being ADVERTISED by GetCommands, so an agent asked to build UI logic in
// Blueprint hit a dead end and had no option but to write C++ instead. These are the
// real implementations.
// ---------------------------------------------------------------------------

/** Resolve a graph by name, defaulting to the primary event graph. */
static UEdGraph* HaybaFindGraph(UBlueprint* BP, const FString& GraphName)
{
    if (!BP) return nullptr;
    TArray<UEdGraph*> All;
    BP->GetAllGraphs(All);
    if (GraphName.IsEmpty())
    {
        if (BP->UbergraphPages.Num() > 0) { return BP->UbergraphPages[0]; }
        return All.Num() > 0 ? All[0] : nullptr;
    }
    for (UEdGraph* G : All)
    {
        if (G && G->GetName().Equals(GraphName, ESearchCase::IgnoreCase)) return G;
    }
    return nullptr;
}

/** Find a node by the GUID string that add_node hands back. */
static UEdGraphNode* HaybaFindNode(UEdGraph* Graph, const FString& NodeId)
{
    if (!Graph) return nullptr;
    for (UEdGraphNode* N : Graph->Nodes)
    {
        if (N && N->NodeGuid.ToString() == NodeId) return N;
    }
    return nullptr;
}

/** Report a node with its pins, because pin names are what callers need next. */
static TSharedPtr<FJsonObject> HaybaDescribeNode(UEdGraphNode* Node)
{
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    if (!Node) return Out;
    Out->SetStringField(TEXT("node_id"), Node->NodeGuid.ToString());
    Out->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
    TArray<TSharedPtr<FJsonValue>> Pins;
    for (UEdGraphPin* Pin : Node->Pins)
    {
        if (!Pin) continue;
        TSharedPtr<FJsonObject> PinObj = MakeShared<FJsonObject>();
        PinObj->SetStringField(TEXT("name"), Pin->PinName.ToString());
        PinObj->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Input ? TEXT("input") : TEXT("output"));
        PinObj->SetStringField(TEXT("type"), Pin->PinType.PinCategory.ToString());
        Pins.Add(MakeShared<FJsonValueObject>(PinObj));
    }
    Out->SetArrayField(TEXT("pins"), Pins);
    return Out;
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddNode(const TSharedPtr<FJsonObject>& P)
{
    FString Path, FunctionName, GraphName, ClassPath;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: missing path"));
    if (!P->TryGetStringField(TEXT("function_name"), FunctionName))
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: missing function_name"));
    P->TryGetStringField(TEXT("graph_name"), GraphName);
    P->TryGetStringField(TEXT("class_path"), ClassPath);

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: blueprint not found"));

    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: graph not found"));

    // Default to the blueprint's own generated class, which is what makes self-calls and
    // anything inherited resolve without the caller naming a class.
    UClass* OwnerClass = nullptr;
    if (!ClassPath.IsEmpty())
    {
        OwnerClass = LoadObject<UClass>(nullptr, *ClassPath);
        if (!OwnerClass)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("blueprint_add_node: class not found: %s"), *ClassPath));
    }
    else
    {
        OwnerClass = BP->GeneratedClass ? BP->GeneratedClass.Get() : BP->ParentClass.Get();
    }

    UFunction* Fn = OwnerClass ? OwnerClass->FindFunctionByName(FName(*FunctionName)) : nullptr;
    if (!Fn)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_node: no function '%s' on %s. Pass class_path to call one on another class."),
            *FunctionName, OwnerClass ? *OwnerClass->GetName() : TEXT("<null>")));
    }

    BP->Modify();
    Graph->Modify();

    UK2Node_CallFunction* Node = NewObject<UK2Node_CallFunction>(Graph);
    Node->CreateNewGuid();
    Node->SetFromFunction(Fn);
    double X = 0.0, Y = 0.0;
    P->TryGetNumberField(TEXT("x"), X);
    P->TryGetNumberField(TEXT("y"), Y);
    Node->NodePosX = (int32)X;
    Node->NodePosY = (int32)Y;
    Graph->AddNode(Node, false, false);
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TSharedPtr<FJsonObject> Out = HaybaDescribeNode(Node);
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::SetPinDefault(const TSharedPtr<FJsonObject>& P)
{
    // The third leg of graph authoring. add_node places a node and connect_nodes wires the
    // ones that carry data, but most real graphs also need LITERALS on unconnected inputs —
    // which subsystem class to fetch, a format string, a flag. Without this, a graph can be
    // built and wired and still do nothing useful.
    FString Path, NodeId, PinName, Value, GraphName;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_pin_default: missing path"));
    if (!P->TryGetStringField(TEXT("node_id"), NodeId))
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_pin_default: missing node_id"));
    if (!P->TryGetStringField(TEXT("pin_name"), PinName))
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_pin_default: missing pin_name"));
    if (!P->TryGetStringField(TEXT("value"), Value))
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_pin_default: missing value"));
    P->TryGetStringField(TEXT("graph_name"), GraphName);

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_set_pin_default: blueprint not found"));
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_set_pin_default: graph not found"));
    UEdGraphNode* Node = HaybaFindNode(Graph, NodeId);
    if (!Node) return FHaybaHandlerResult::Err(TEXT("blueprint_set_pin_default: node id not found"));

    UEdGraphPin* Pin = Node->FindPin(FName(*PinName), EGPD_Input);
    if (!Pin)
    {
        FString Available;
        for (UEdGraphPin* Other : Node->Pins)
        {
            if (Other && Other->Direction == EGPD_Input)
            {
                Available += Other->PinName.ToString();
                Available += TEXT(" ");
            }
        }
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_set_pin_default: no input pin '%s'. Input pins: %s"), *PinName, *Available));
    }

    if (Pin->LinkedTo.Num() > 0)
    {
        // A literal on a connected pin is silently ignored by the compiler, which looks like
        // the value "not sticking". Refuse loudly instead.
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_set_pin_default: pin '%s' is connected; a literal there would be ignored. Disconnect it first."),
            *PinName));
    }

    BP->Modify();
    Graph->Modify();

    const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
    // Object/class pins take an asset reference rather than a string literal.
    if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Object
        || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Class
        || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftObject
        || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftClass)
    {
        UObject* Asset = LoadObject<UObject>(nullptr, *Value);
        if (!Asset)
        {
            Asset = LoadClass<UObject>(nullptr, *Value);
        }
        if (!Asset)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_set_pin_default: could not load '%s' for object/class pin '%s'"), *Value, *PinName));
        }
        Schema->TrySetDefaultObject(*Pin, Asset);
    }
    else
    {
        Schema->TrySetDefaultValue(*Pin, Value);
    }

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), NodeId);
    Out->SetStringField(TEXT("pin_name"), PinName);
    Out->SetStringField(TEXT("applied"), Pin->DefaultObject ? Pin->DefaultObject->GetPathName() : Pin->DefaultValue);
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::ConnectNodes(const TSharedPtr<FJsonObject>& P)
{
    FString Path, FromId, FromPin, ToId, ToPin, GraphName;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("blueprint_connect_nodes: missing path"));
    if (!P->TryGetStringField(TEXT("from_node"), FromId) || !P->TryGetStringField(TEXT("to_node"), ToId))
        return FHaybaHandlerResult::Err(TEXT("blueprint_connect_nodes: missing from_node / to_node"));
    if (!P->TryGetStringField(TEXT("from_pin"), FromPin) || !P->TryGetStringField(TEXT("to_pin"), ToPin))
        return FHaybaHandlerResult::Err(TEXT("blueprint_connect_nodes: missing from_pin / to_pin"));
    P->TryGetStringField(TEXT("graph_name"), GraphName);

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_connect_nodes: blueprint not found"));
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_connect_nodes: graph not found"));

    UEdGraphNode* From = HaybaFindNode(Graph, FromId);
    UEdGraphNode* To = HaybaFindNode(Graph, ToId);
    if (!From || !To)
        return FHaybaHandlerResult::Err(TEXT("blueprint_connect_nodes: node id not found in that graph"));

    UEdGraphPin* OutPin = From->FindPin(FName(*FromPin), EGPD_Output);
    UEdGraphPin* InPin = To->FindPin(FName(*ToPin), EGPD_Input);
    if (!OutPin || !InPin)
    {
        // Name the pins that DO exist. A wrong pin name is the usual failure, and guessing
        // blind is what makes graph authoring feel impossible.
        FString Available;
        UEdGraphNode* Failing = OutPin ? To : From;
        for (UEdGraphPin* Pin : Failing->Pins)
        {
            if (Pin) { Available += Pin->PinName.ToString(); Available += TEXT(" "); }
        }
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_connect_nodes: pin not found. Pins on the failing node: %s"), *Available));
    }

    const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
    const FPinConnectionResponse Response = Schema->CanCreateConnection(OutPin, InPin);
    if (Response.Response == CONNECT_RESPONSE_DISALLOW)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_connect_nodes: schema refused the connection: %s"), *Response.Message.ToString()));
    }

    BP->Modify();
    Graph->Modify();
    if (!Schema->TryCreateConnection(OutPin, InPin))
        return FHaybaHandlerResult::Err(TEXT("blueprint_connect_nodes: TryCreateConnection failed"));

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("from"), FromId + TEXT(".") + FromPin);
    Result->SetStringField(TEXT("to"), ToId + TEXT(".") + ToPin);
    Result->SetBoolField(TEXT("connected"), true);
    Result->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::Compile(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path)) return FHaybaHandlerResult::Err(TEXT("blueprint_compile: missing path"));
    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_compile: blueprint not found"));

    FCompilerResultsLog ResultsLog;
    ResultsLog.SetSourcePath(BP->GetPathName());
    ResultsLog.BeginEvent(TEXT("Compile"));

    FKismetEditorUtilities::CompileBlueprint(BP, EBlueprintCompileOptions::None, &ResultsLog);

    ResultsLog.EndEvent();

    bool bOk = (BP->Status == BS_UpToDate || BP->Status == BS_UpToDateWithWarnings);
    // Mirror RecompileAndTrack's broken-set bookkeeping so a manual
    // blueprint_compile call can also clear or set the gate.
    if (bOk) BrokenBlueprintsRef().Remove(BP->GetPathName());
    else     BrokenBlueprintsRef().Add(BP->GetPathName());

    TArray<TSharedPtr<FJsonValue>> Errors;
    TArray<TSharedPtr<FJsonValue>> Warnings;
    FString FirstError;
    for (const TSharedRef<FTokenizedMessage>& Msg : ResultsLog.Messages)
    {
        const FString Text = Msg->ToText().ToString();
        const EMessageSeverity::Type Sev = Msg->GetSeverity();
        if (Sev == EMessageSeverity::Error)
        {
            if (FirstError.IsEmpty()) FirstError = Text;
            Errors.Add(MakeShared<FJsonValueString>(Text));
        }
        else if (Sev == EMessageSeverity::Warning)
            Warnings.Add(MakeShared<FJsonValueString>(Text));
    }

    UE_LOG(LogHaybaMCPBP, Warning,
        TEXT("BP compile %s: ok=%d errors=%d warnings=%d first=%s"),
        *BP->GetPathName(), bOk ? 1 : 0,
        ResultsLog.NumErrors, ResultsLog.NumWarnings,
        FirstError.IsEmpty() ? TEXT("(none)") : *FirstError);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), bOk);            // Issue #6 contract
    Out->SetBoolField(TEXT("compiled"), bOk);      // legacy alias
    Out->SetNumberField(TEXT("status"), (int32)BP->Status);
    Out->SetNumberField(TEXT("error_count"),   ResultsLog.NumErrors);
    Out->SetNumberField(TEXT("warning_count"), ResultsLog.NumWarnings);
    Out->SetNumberField(TEXT("num_errors"),   ResultsLog.NumErrors);   // legacy alias
    Out->SetNumberField(TEXT("num_warnings"), ResultsLog.NumWarnings); // legacy alias
    Out->SetArrayField(TEXT("errors"),   Errors);
    Out->SetArrayField(TEXT("warnings"), Warnings);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::Document(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path)) return FHaybaHandlerResult::Err(TEXT("blueprint_document: missing path"));
    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_document: blueprint not found"));

    FString Doc;
    for (UEdGraph* Graph : BP->UbergraphPages)
    {
        if (!Graph) continue;
        for (UEdGraphNode* Node : Graph->Nodes)
        {
            UK2Node_Event* Event = Cast<UK2Node_Event>(Node);
            if (!Event) continue;
            FString EventName = Event->GetNodeTitle(ENodeTitleType::ListView).ToString();
            Doc += FString::Printf(TEXT("WHEN %s THEN "), *EventName);

            // walk linked nodes from the exec output
            UEdGraphPin* Then = nullptr;
            for (UEdGraphPin* Pin : Event->Pins)
            {
                if (Pin && Pin->Direction == EGPD_Output && Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec)
                {
                    Then = Pin;
                    break;
                }
            }
            int32 Steps = 0;
            while (Then && Then->LinkedTo.Num() > 0 && Steps < 32)
            {
                UEdGraphPin* Next = Then->LinkedTo[0];
                UEdGraphNode* NextNode = Next ? Next->GetOwningNode() : nullptr;
                if (!NextNode) break;
                Doc += NextNode->GetNodeTitle(ENodeTitleType::ListView).ToString() + TEXT(" -> ");
                Then = nullptr;
                for (UEdGraphPin* Pin : NextNode->Pins)
                {
                    if (Pin && Pin->Direction == EGPD_Output && Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec)
                    {
                        Then = Pin; break;
                    }
                }
                ++Steps;
            }
            Doc += TEXT("END\n");
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("documentation"), Doc);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddEvent(const TSharedPtr<FJsonObject>& P)
{
    // Adds (or finds) an overridable event node such as Construct / Tick / PreConstruct. It is
    // idempotent: an event that already exists in the graph is returned rather than duplicated,
    // because two Construct nodes is a compile error, not a second entry point.
    FString Path, EventName, GraphName;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_event: missing path"));
    if (!P->TryGetStringField(TEXT("event_name"), EventName))
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_event: missing event_name (e.g. \"Construct\", \"Tick\")"));
    P->TryGetStringField(TEXT("graph_name"), GraphName);

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_add_event: blueprint not found"));
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_event: graph not found"));

    UClass* ParentClass = BP->ParentClass.Get();
    UFunction* EventFn = ParentClass ? ParentClass->FindFunctionByName(FName(*EventName)) : nullptr;
    if (!EventFn)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_event: no overridable event '%s' on %s"),
            *EventName, ParentClass ? *ParentClass->GetName() : TEXT("<null>")));
    }

    for (UEdGraphNode* N : Graph->Nodes)
    {
        UK2Node_Event* Existing = Cast<UK2Node_Event>(N);
        if (Existing && Existing->EventReference.GetMemberName() == EventFn->GetFName())
        {
            TSharedPtr<FJsonObject> Found = HaybaDescribeNode(Existing);
            Found->SetBoolField(TEXT("already_existed"), true);
            return FHaybaHandlerResult::Ok(Found);
        }
    }

    BP->Modify();
    Graph->Modify();

    UK2Node_Event* Node = NewObject<UK2Node_Event>(Graph);
    Node->CreateNewGuid();
    Node->EventReference.SetExternalMember(EventFn->GetFName(), ParentClass);
    Node->bOverrideFunction = true;
    double X = 0.0, Y = 0.0;
    P->TryGetNumberField(TEXT("x"), X);
    P->TryGetNumberField(TEXT("y"), Y);
    Node->NodePosX = (int32)X;
    Node->NodePosY = (int32)Y;
    Graph->AddNode(Node, false, false);
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TSharedPtr<FJsonObject> Out = HaybaDescribeNode(Node);
    Out->SetBoolField(TEXT("already_existed"), false);
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::SetDefaults(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path)) return FHaybaHandlerResult::Err(TEXT("blueprint_set_defaults: missing path"));
    const TSharedPtr<FJsonObject>* PropsObj;
    if (!P->TryGetObjectField(TEXT("properties"), PropsObj) || !PropsObj->IsValid())
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_defaults: missing properties"));

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("blueprint_set_defaults: blueprint not found"));
    if (!BP->GeneratedClass)
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_defaults: GeneratedClass missing — compile first"));

    UObject* CDO = BP->GeneratedClass->GetDefaultObject();
    if (!CDO) return FHaybaHandlerResult::Err(TEXT("blueprint_set_defaults: CDO missing"));

    TArray<TSharedPtr<FJsonValue>> SetNames;
    TArray<TSharedPtr<FJsonValue>> Skipped;

    auto AddSkipped = [&Skipped](const FString& Key, const TCHAR* Reason)
    {
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Key);
        Entry->SetStringField(TEXT("reason"), Reason);
        Skipped.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    };

    for (const auto& Pair : (*PropsObj)->Values)
    {
        FProperty* Prop = BP->GeneratedClass->FindPropertyByName(FName(*Pair.Key));
        if (!Prop)
        {
            AddSkipped(FString(*Pair.Key), TEXT("property_not_found"));
            continue;
        }

        // Routed through the shared reflection module rather than a local
        // stringify-then-ImportText pass.
        //
        // The old code guessed the struct from the ARRAY LENGTH: 3 numbers
        // became "(X=,Y=,Z=)", 4 became "(R=,G=,B=,A=)", 2 became "(X=,Y=)".
        // That is right only when the property happens to match the guess — a
        // 4-number array on a Vector4 was formatted as a colour and failed to
        // parse, and a 3-number array on a Rotator (which imports as
        // Pitch/Yaw/Roll) failed the same way. SetValueFromJson dispatches on
        // the property's ACTUAL struct type instead, and handles nested JSON
        // objects, enums by name and object references, none of which the text
        // path could express.
        if (!HaybaReflection::SetValueFromJson(Prop, CDO, Pair.Value, CDO))
        {
            AddSkipped(FString(*Pair.Key), TEXT("value_could_not_be_applied"));
            continue;
        }
        SetNames.Add(MakeShared<FJsonValueString>(FString(*Pair.Key)));
    }

    FBlueprintEditorUtils::MarkBlueprintAsModified(BP);

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("set"), SetNames);
    Out->SetArrayField(TEXT("skipped"), Skipped);
    AttachCompileReport(Out, bClean, Errors, Warnings);
    return FHaybaHandlerResult::Ok(Out);
}
