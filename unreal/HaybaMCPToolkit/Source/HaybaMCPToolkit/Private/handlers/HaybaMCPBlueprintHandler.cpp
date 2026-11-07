#include "HaybaMCPBlueprintHandler.h"
#include "HaybaBlueprintOps.h"
#include "HaybaMCPParams.h"
#include "HaybaMCPReflection.h"
#include "HaybaMCPAssetGuard.h"
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
#include "K2Node_IfThenElse.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "K2Node_DynamicCast.h"
#include "K2Node_Select.h"
#include "K2Node_CustomEvent.h"
#include "K2Node_MacroInstance.h"
#include "K2Node_BreakStruct.h"
#include "K2Node_MakeStruct.h"
#include "K2Node_CallDelegate.h"
#include "K2Node_Message.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_FunctionResult.h"
#include "EdGraphNode_Comment.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "SGraphPanel.h"
#include "Framework/Application/SlateApplication.h"
#include "Kismet/KismetSystemLibrary.h"
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

// Reflection converters recurse through attacker-controlled JSON. Bound the
// shape before giving it a UObject so a single MCP request cannot exhaust the
// game-thread stack or allocate an unbounded container during staging.
static bool HaybaValidateMutationJsonShape(
    const TSharedPtr<FJsonValue>& Value,
    int32 Depth,
    int32& Nodes,
    FString& OutReason)
{
    if (!Value.IsValid()) { OutReason = TEXT("contains an invalid JSON value"); return false; }
    if (++Nodes > 4096) { OutReason = TEXT("exceeds the 4096-value mutation limit"); return false; }
    if (Depth > 32) { OutReason = TEXT("exceeds the 32-level mutation depth limit"); return false; }
    if (Value->Type == EJson::Array)
    {
        if (Value->AsArray().Num() > 1024)
        {
            OutReason = TEXT("contains an array larger than 1024 items");
            return false;
        }
        for (const TSharedPtr<FJsonValue>& Child : Value->AsArray())
            if (!HaybaValidateMutationJsonShape(Child, Depth + 1, Nodes, OutReason)) return false;
    }
    else if (Value->Type == EJson::Object)
    {
        if (Value->AsObject()->Values.Num() > 256)
        {
            OutReason = TEXT("contains an object larger than 256 fields");
            return false;
        }
        for (const auto& Pair : Value->AsObject()->Values)
            if (!HaybaValidateMutationJsonShape(Pair.Value, Depth + 1, Nodes, OutReason)) return false;
    }
    return true;
}

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
        TEXT("blueprint_inspect_graph"),
        TEXT("blueprint_add_event"),
        TEXT("blueprint_set_defaults"),
        TEXT("blueprint_set_pin_default"),
        TEXT("blueprint_add_comment"),
        TEXT("blueprint_move_nodes"),
        TEXT("blueprint_remove_nodes"),
        TEXT("blueprint_disconnect"),
        TEXT("blueprint_graph_batch"),
        TEXT("blueprint_measure_nodes"),
        TEXT("blueprint_fit_comments"),
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
        TEXT("blueprint_add_comment"), TEXT("blueprint_move_nodes"),
        TEXT("blueprint_remove_nodes"), TEXT("blueprint_disconnect"),
        TEXT("blueprint_graph_batch"), TEXT("blueprint_fit_comments"),
    };
    if (MutatingCommands.Contains(Cmd) || Cmd == TEXT("blueprint_compile"))
    {
        // Compiling reinstances every live instance of the class. During PIE those
        // are game objects mid-tick, the crash class FoA hit repeatedly.
        if (GEditor && GEditor->IsPlaySessionInProgress())
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("%s: a Play-In-Editor session is running; stop it (editor_stop_pie) before editing or compiling Blueprints. Nothing was changed."), *Cmd));
    }
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
    if (Cmd == TEXT("blueprint_inspect_graph"))  return InspectGraph(P);
    if (Cmd == TEXT("blueprint_add_event"))      return AddEvent(P);
    if (Cmd == TEXT("blueprint_set_defaults"))   return SetDefaults(P);
    if (Cmd == TEXT("blueprint_set_pin_default")) return SetPinDefault(P);
    if (Cmd == TEXT("blueprint_add_comment"))    return AddComment(P);
    if (Cmd == TEXT("blueprint_move_nodes"))     return MoveNodes(P);
    if (Cmd == TEXT("blueprint_remove_nodes"))   return RemoveNodes(P);
    if (Cmd == TEXT("blueprint_disconnect"))     return Disconnect(P);
    if (Cmd == TEXT("blueprint_graph_batch"))    return GraphBatch(P);
    if (Cmd == TEXT("blueprint_measure_nodes"))  return MeasureNodes(P);
    if (Cmd == TEXT("blueprint_fit_comments"))   return FitComments(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("BlueprintHandler: unknown command %s"), *Cmd));
}

/**
 * Load a blueprint by any of the spellings a caller reasonably arrives with.
 *
 * The asset path must NOT carry `_C`, while class VALUES inside `properties`
 * must — so a caller holding one class path naturally pastes it into `path` and
 * gets "blueprint not found", which sends them hunting for a missing asset that
 * is sitting right there. Accept both and normalise.
 *
 * Tries, in order: the path as given; the same path with a trailing `_C`
 * stripped from the object name; and the package-only form `/Game/X/WBP_A`
 * expanded to `/Game/X/WBP_A.WBP_A`.
 */
static UBlueprint* LoadBPByPath(const FString& Path, FString* OutResolvedPath = nullptr)
{
    auto Try = [OutResolvedPath](const FString& Candidate) -> UBlueprint*
    {
        if (Candidate.IsEmpty()) return nullptr;
        if (UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *Candidate))
        {
            if (OutResolvedPath) *OutResolvedPath = Candidate;
            return BP;
        }
        return nullptr;
    };

    if (UBlueprint* BP = Try(Path)) return BP;

    // "/Game/X/WBP_A.WBP_A_C" -> "/Game/X/WBP_A.WBP_A"
    if (Path.EndsWith(TEXT("_C")))
    {
        if (UBlueprint* BP = Try(Path.LeftChop(2))) return BP;
    }

    // "/Game/X/WBP_A" -> "/Game/X/WBP_A.WBP_A"
    if (!Path.Contains(TEXT(".")))
    {
        FString Leaf = Path;
        int32 Slash = INDEX_NONE;
        if (Path.FindLastChar(TEXT('/'), Slash) && Slash != INDEX_NONE)
        {
            Leaf = Path.Mid(Slash + 1);
        }
        if (UBlueprint* BP = Try(Path + TEXT(".") + Leaf)) return BP;
    }

    return nullptr;
}

/** The error to hand back when none of the spellings resolved. Names the forms
 *  that work, because "not found" alone sends the caller looking for the wrong
 *  problem — the asset usually exists and the path shape is what is wrong. */
static FString BlueprintNotFoundError(const TCHAR* Command, const FString& Path)
{
    return FString::Printf(
        TEXT("%s: no blueprint at '%s'. Accepted forms: '/Game/Dir/WBP_Name', "
             "'/Game/Dir/WBP_Name.WBP_Name', or the class path '/Game/Dir/WBP_Name.WBP_Name_C' "
             "(the '_C' is stripped for you). Note the asset must have been SAVED at least once — "
             "a freshly created, never-saved blueprint cannot be loaded by path."),
        Command, *Path);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::Create(const TSharedPtr<FJsonObject>& P)
{
    FString ParentPath, PkgPath, Name;
    FHaybaParamReader ParamR(P, TEXT("blueprint_create"));
    ParentPath = ParamR.RequiredString(TEXT("parent_class_path"));
    PkgPath = ParamR.RequiredString(TEXT("package_path"));
    Name = ParamR.RequiredString(TEXT("name"), 256);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UClass* ParentClass = LoadClass<UObject>(nullptr, *ParentPath);
    if (!ParentClass)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("blueprint_create: parent class not found: %s"), *ParentPath));

    // package_path follows the same contract as material_create: it is the
    // full intended asset path (its trailing component is the asset name).
    // Strip to the directory and re-compose <dir>/<name> so the asset lands at
    // the standard /Game/Dir/Name.Name — NOT the malformed /Game/Dir.Name that
    // results from using package_path directly as the package and Name as a
    // sub-object inside it.
    // Composed in HaybaBlueprintOps so the rule — and the case where a caller
    // passed a folder and lands one directory up — is testable without an editor.
    const HaybaBlueprintOps::FResolvedPackage Resolved =
        HaybaBlueprintOps::ResolvePackage(PkgPath, Name);
    const FString FullPackageName = Resolved.PackageName;
    if (!FullPackageName.StartsWith(TEXT("/Game/"))
        || !FPackageName::IsValidLongPackageName(FullPackageName))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_create: target must be a valid unused package under /Game; resolved '%s'. Nothing was created."),
            *FullPackageName));
    }
    if (FPackageName::DoesPackageExist(FullPackageName)
        || HaybaAssetGuard::AssetNameTaken(Resolved.Directory, Name))
    {
        return FHaybaHandlerResult::Err(
            HaybaAssetGuard::NameTakenError(TEXT("blueprint_create"), Resolved.Directory, Name));
    }
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
    Out->SetBoolField(TEXT("dirty"), Package->IsDirty());
    if (!bSaved)
    {
        Out->SetStringField(TEXT("save_error"),
            TEXT("The Blueprint exists in memory but SavePackage failed. Save or delete the new asset before closing the editor; do not retry creation with the same name."));
    }
    // Say where it went when that is probably not where the caller meant. The
    // path above has always been accurate; nobody reads it until something is
    // missing, and by then the asset is sitting a directory up.
    const FString PathNote = HaybaBlueprintOps::PackagePathNote(Resolved, PkgPath);
    if (!PathNote.IsEmpty()) Out->SetStringField(TEXT("package_path_note"), PathNote);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::GetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("blueprint_get_info: missing path"));
    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_get_info"), Path));

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
    FHaybaParamReader ParamR(P, TEXT("blueprint_add_component"));
    Path = ParamR.RequiredString(TEXT("path"));
    CompClassPath = ParamR.RequiredString(TEXT("component_class_path"));
    CompName = ParamR.RequiredString(TEXT("component_name"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_add_component"), Path));
    UClass* CompClass = LoadClass<UActorComponent>(nullptr, *CompClassPath);
    if (!CompClass) return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: component class not found"));
    if (!CompClass->IsChildOf<UActorComponent>() || CompClass->HasAnyClassFlags(CLASS_Abstract))
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: component_class_path must name a concrete UActorComponent class; nothing was changed"));
    if (!BP->SimpleConstructionScript)
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: blueprint has no SCS"));

    for (const USCS_Node* Existing : BP->SimpleConstructionScript->GetAllNodes())
    {
        if (Existing && Existing->GetVariableName().ToString().Equals(CompName, ESearchCase::IgnoreCase))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_add_component: component name '%s' already exists; nothing was changed"),
                *CompName));
        }
    }

    USCS_Node* Node = BP->SimpleConstructionScript->CreateNode(CompClass, FName(*CompName));
    if (!Node) return FHaybaHandlerResult::Err(TEXT("blueprint_add_component: CreateNode failed"));
    BP->SimpleConstructionScript->AddNode(Node);
    MarkStructural(BP);

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("component_name"), CompName);
    AttachCompileReport(Out, bClean, Errors, Warnings);
    Out->SetBoolField(TEXT("verified"), BP->SimpleConstructionScript
        && BP->SimpleConstructionScript->GetAllNodes().Contains(Node));
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

/** A K2 pin type from a type spec ("float", "object:/Script/Engine.Actor", ...) plus an
 *  optional container ("array", "set", or "map" with MapValueSpec). Loads the referenced
 *  class/struct/enum; nothing is created. */
static bool HaybaResolvePinType(const FString& Spec, const FString& Container, const FString& MapValueSpec,
    FEdGraphPinType& Out, FString& Error)
{
    auto Single = [&Error](const FString& S, FEdGraphPinType& T) -> bool
    {
        HaybaBlueprintOps::FPinTypeSpec Parsed;
        if (!HaybaBlueprintOps::ParsePinTypeSpec(S, Parsed, Error)) return false;
        T = FEdGraphPinType();
        const FString& K = Parsed.Kind;
        if (K == TEXT("bool"))         T.PinCategory = UEdGraphSchema_K2::PC_Boolean;
        else if (K == TEXT("int"))     T.PinCategory = UEdGraphSchema_K2::PC_Int;
        else if (K == TEXT("int64"))   T.PinCategory = UEdGraphSchema_K2::PC_Int64;
        else if (K == TEXT("byte"))    T.PinCategory = UEdGraphSchema_K2::PC_Byte;
        else if (K == TEXT("float"))   { T.PinCategory = UEdGraphSchema_K2::PC_Real; T.PinSubCategory = UEdGraphSchema_K2::PC_Double; }
        else if (K == TEXT("string"))  T.PinCategory = UEdGraphSchema_K2::PC_String;
        else if (K == TEXT("name"))    T.PinCategory = UEdGraphSchema_K2::PC_Name;
        else if (K == TEXT("text"))    T.PinCategory = UEdGraphSchema_K2::PC_Text;
        else if (K == TEXT("vector"))  { T.PinCategory = UEdGraphSchema_K2::PC_Struct; T.PinSubCategoryObject = TBaseStructure<FVector>::Get(); }
        else if (K == TEXT("rotator")) { T.PinCategory = UEdGraphSchema_K2::PC_Struct; T.PinSubCategoryObject = TBaseStructure<FRotator>::Get(); }
        else if (K == TEXT("transform")) { T.PinCategory = UEdGraphSchema_K2::PC_Struct; T.PinSubCategoryObject = TBaseStructure<FTransform>::Get(); }
        else if (K == TEXT("linear_color")) { T.PinCategory = UEdGraphSchema_K2::PC_Struct; T.PinSubCategoryObject = TBaseStructure<FLinearColor>::Get(); }
        else if (K == TEXT("struct"))
        {
            UScriptStruct* Struct = LoadObject<UScriptStruct>(nullptr, *Parsed.ObjectPath);
            if (!Struct) { Error = FString::Printf(TEXT("struct '%s' not found"), *Parsed.ObjectPath); return false; }
            T.PinCategory = UEdGraphSchema_K2::PC_Struct;
            T.PinSubCategoryObject = Struct;
        }
        else if (K == TEXT("enum"))
        {
            UEnum* Enum = LoadObject<UEnum>(nullptr, *Parsed.ObjectPath);
            if (!Enum) { Error = FString::Printf(TEXT("enum '%s' not found"), *Parsed.ObjectPath); return false; }
            T.PinCategory = UEdGraphSchema_K2::PC_Byte;
            T.PinSubCategoryObject = Enum;
        }
        else
        {
            UClass* Class = LoadObject<UClass>(nullptr, *Parsed.ObjectPath);
            if (!Class) { Error = FString::Printf(TEXT("class '%s' not found (Blueprint classes end in _C)"), *Parsed.ObjectPath); return false; }
            T.PinCategory = K == TEXT("object") ? UEdGraphSchema_K2::PC_Object
                : K == TEXT("class") ? UEdGraphSchema_K2::PC_Class
                : K == TEXT("soft_object") ? UEdGraphSchema_K2::PC_SoftObject
                : UEdGraphSchema_K2::PC_SoftClass;
            T.PinSubCategoryObject = Class;
        }
        return true;
    };

    if (!Single(Spec, Out)) return false;
    const FString C = Container.ToLower();
    if (C.IsEmpty() || C == TEXT("none")) return true;
    if (C == TEXT("array")) { Out.ContainerType = EPinContainerType::Array; return true; }
    if (C == TEXT("set"))   { Out.ContainerType = EPinContainerType::Set; return true; }
    if (C == TEXT("map"))
    {
        FEdGraphPinType Value;
        if (MapValueSpec.IsEmpty()) { Error = TEXT("a map needs map_value_type"); return false; }
        if (!Single(MapValueSpec, Value)) return false;
        Out.ContainerType = EPinContainerType::Map;
        Out.PinValueType = FEdGraphTerminalType::FromPinType(Value);
        return true;
    }
    Error = FString::Printf(TEXT("container '%s' must be none, array, set or map"), *Container);
    return false;
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddVariable(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("blueprint_add_variable"));
    const FString Path = ParamR.RequiredString(TEXT("path"));
    const FString VarName = ParamR.RequiredString(TEXT("variable_name"), 256);
    const FString VarType = ParamR.RequiredString(TEXT("variable_type"), 1024);
    const FString Container = ParamR.OptionalString(TEXT("container"));
    const FString MapValue = ParamR.OptionalString(TEXT("map_value_type"), FString(), 1024);
    const FString DefaultValue = ParamR.OptionalString(TEXT("default_value"), FString(), 4096);
    const FString Category = ParamR.OptionalString(TEXT("category"), FString(), 256);
    const FString Tooltip = ParamR.OptionalString(TEXT("tooltip"), FString(), 4096);
    const bool bInstanceEditable = ParamR.OptionalBool(TEXT("instance_editable"), false);
    const bool bExposeOnSpawn = ParamR.OptionalBool(TEXT("expose_on_spawn"), false);
    const bool bReadOnly = ParamR.OptionalBool(TEXT("read_only"), false);
    const bool bUpdateExisting = ParamR.OptionalBool(TEXT("update_existing"), false);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_add_variable"), Path));

    FEdGraphPinType PinType;
    FString TypeError;
    if (!HaybaResolvePinType(VarType, Container, MapValue, PinType, TypeError))
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_variable: ") + TypeError + TEXT(". Nothing was changed."));

    const FName Name(*VarName);
    const FBPVariableDescription* Existing = BP->NewVariables.FindByPredicate(
        [&VarName](const FBPVariableDescription& V) { return V.VarName.ToString().Equals(VarName, ESearchCase::IgnoreCase); });
    if (Existing && !bUpdateExisting)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_variable: variable '%s' already exists; nothing was changed (pass update_existing:true to only set its flags)"), *VarName));
    // Re-typing in place would invalidate every node that reads it; that is a rename-level change.
    if (Existing && Existing->VarType != PinType)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_variable: '%s' exists with a different type; nothing was changed. Retyping is not done in place."), *VarName));

    const bool bCreated = !Existing;
    if (bCreated && !FBlueprintEditorUtils::AddMemberVariable(BP, Name, PinType, DefaultValue))
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_variable: AddMemberVariable refused the name or type; nothing was changed"));

    // Flags as editor Python's set_blueprint_variable_* calls set them, in C++.
    FBlueprintEditorUtils::SetBlueprintOnlyEditableFlag(BP, Name, !bInstanceEditable);
    FBlueprintEditorUtils::SetBlueprintPropertyReadOnlyFlag(BP, Name, bReadOnly);
    if (bExposeOnSpawn) FBlueprintEditorUtils::SetBlueprintVariableMetaData(BP, Name, nullptr, FBlueprintMetadata::MD_ExposeOnSpawn, TEXT("true"));
    else FBlueprintEditorUtils::RemoveBlueprintVariableMetaData(BP, Name, nullptr, FBlueprintMetadata::MD_ExposeOnSpawn);
    if (!Category.IsEmpty()) FBlueprintEditorUtils::SetBlueprintVariableCategory(BP, Name, nullptr, FText::FromString(Category), true);
    if (!Tooltip.IsEmpty()) FBlueprintEditorUtils::SetBlueprintVariableMetaData(BP, Name, nullptr, TEXT("tooltip"), Tooltip);

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("variable_name"), VarName);
    Out->SetStringField(TEXT("type"), VarType);
    Out->SetBoolField(TEXT("created"), bCreated);
    AttachCompileReport(Out, bClean, Errors, Warnings);
    const FBPVariableDescription* Now = BP->NewVariables.FindByPredicate(
        [&Name](const FBPVariableDescription& V) { return V.VarName == Name; });
    const bool bVerified = Now && Now->VarType == PinType
        && ((Now->PropertyFlags & CPF_DisableEditOnInstance) == 0) == bInstanceEditable;
    Out->SetBoolField(TEXT("verified"), bVerified);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddFunction(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("blueprint_add_function"));
    const FString Path = ParamR.RequiredString(TEXT("path"));
    const FString FuncName = ParamR.RequiredString(TEXT("function_name"), 256);
    const TArray<TSharedPtr<FJsonValue>>* Inputs = ParamR.OptionalArray(TEXT("inputs"), 64);
    const TArray<TSharedPtr<FJsonValue>>* Outputs = ParamR.OptionalArray(TEXT("outputs"), 64);
    const TArray<TSharedPtr<FJsonValue>>* Locals = ParamR.OptionalArray(TEXT("locals"), 128);
    const bool bPure = ParamR.OptionalBool(TEXT("pure"), false);
    const bool bConst = ParamR.OptionalBool(TEXT("const"), false);
    // FKismetUserDeclaredFunctionMetadata::bThreadSafe (BlueprintThreadSafe), which editor Python cannot reach. Anim
    // node functions need it, and with it every call inside the function must be thread safe too.
    const bool bThreadSafe = ParamR.OptionalBool(TEXT("thread_safe"), false);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_add_function"), Path));

    // Refuse a name the blueprint already has, BEFORE creating anything. Adding
    // a second graph with the same name compiles to "Found more than one
    // function with the same name" and is not rolled back, so the old behaviour
    // left the asset broken and still answered ok. The rule itself is pure and
    // lives in HaybaBlueprintOps where a test can reach it.
    {
        TArray<UEdGraph*> AllGraphs;
        BP->GetAllGraphs(AllGraphs);
        TArray<FString> Names;
        Names.Reserve(AllGraphs.Num());
        for (const UEdGraph* G : AllGraphs)
        {
            if (G) Names.Add(G->GetName());
        }
        const FString Conflict = HaybaBlueprintOps::FunctionNameConflict(Names, FuncName);
        if (!Conflict.IsEmpty()) return FHaybaHandlerResult::Err(Conflict);
    }

    // Resolve the whole signature before creating the graph, so a bad type changes nothing.
    struct FParam { FName Name; FEdGraphPinType Type; FString Default; };
    auto ReadParams = [](const TArray<TSharedPtr<FJsonValue>>* List, const TCHAR* What, TArray<FParam>& Out, FString& Error,
        bool bAllowRef = false) -> bool
    {
        if (!List) return true;
        for (const TSharedPtr<FJsonValue>& V : *List)
        {
            const TSharedPtr<FJsonObject>* O = nullptr;
            FString Name, Type, Container, MapValue, Default;
            if (!V.IsValid() || !V->TryGetObject(O) || !(*O)->TryGetStringField(TEXT("name"), Name)
                || !(*O)->TryGetStringField(TEXT("type"), Type) || Name.IsEmpty())
            {
                Error = FString::Printf(TEXT("each %s entry needs name and type"), What);
                return false;
            }
            (*O)->TryGetStringField(TEXT("container"), Container);
            (*O)->TryGetStringField(TEXT("map_value_type"), MapValue);
            (*O)->TryGetStringField(TEXT("default_value"), Default);
            FParam Param{ FName(*Name), FEdGraphPinType(), Default };
            if (!HaybaResolvePinType(Type, Container, MapValue, Param.Type, Error))
            {
                Error = FString::Printf(TEXT("%s '%s': %s"), What, *Name, *Error);
                return false;
            }
            // Pass-by-reference and const: an input declared `const FAnimUpdateContext&` compiles to the
            // CPF_OutParm|CPF_ReferenceParm|CPF_ConstParm parameter a native prototype has.
            bool bByRef = false, bConstParam = false;
            (*O)->TryGetBoolField(TEXT("by_ref"), bByRef);
            (*O)->TryGetBoolField(TEXT("const"), bConstParam);
            if ((bByRef || bConstParam) && !bAllowRef)
            {
                Error = FString::Printf(TEXT("%s '%s': by_ref and const apply to inputs only"), What, *Name);
                return false;
            }
            Param.Type.bIsReference = bByRef;
            Param.Type.bIsConst = bConstParam;
            Out.Add(Param);
        }
        return true;
    };
    TArray<FParam> In, OutParams, Local;
    FString SigError;
    if (!ReadParams(Inputs, TEXT("inputs"), In, SigError, true) || !ReadParams(Outputs, TEXT("outputs"), OutParams, SigError)
        || !ReadParams(Locals, TEXT("locals"), Local, SigError))
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_function: ") + SigError + TEXT(". Nothing was changed."));

    UEdGraph* NewGraph = FBlueprintEditorUtils::CreateNewGraph(
        BP, FName(*FuncName), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
    if (!NewGraph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_function: CreateNewGraph failed"));

    FBlueprintEditorUtils::AddFunctionGraph<UClass>(BP, NewGraph, /*bIsUserCreated*/true, nullptr);

    UK2Node_FunctionEntry* Entry = nullptr;
    for (UEdGraphNode* N : NewGraph->Nodes) if ((Entry = Cast<UK2Node_FunctionEntry>(N)) != nullptr) break;
    int32 PinsMade = 0;
    if (Entry)
    {
        for (const FParam& Param : In) PinsMade += Entry->CreateUserDefinedPin(Param.Name, Param.Type, EGPD_Output, false) ? 1 : 0;
        if (OutParams.Num() > 0)
        {
            if (UK2Node_FunctionResult* Result = FBlueprintEditorUtils::FindOrCreateFunctionResultNode(Entry))
                for (const FParam& Param : OutParams) PinsMade += Result->CreateUserDefinedPin(Param.Name, Param.Type, EGPD_Input, false) ? 1 : 0;
        }
        if (bPure) Entry->AddExtraFlags(FUNC_BlueprintPure);
        if (bConst) Entry->AddExtraFlags(FUNC_Const);
        Entry->MetaData.bThreadSafe = bThreadSafe;
    }
    for (const FParam& Param : Local) FBlueprintEditorUtils::AddLocalVariable(BP, NewGraph, Param.Name, Param.Type, Param.Default);

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("function_name"), FuncName);
    Out->SetStringField(TEXT("graph"), NewGraph->GetName());
    Out->SetNumberField(TEXT("pins_created"), PinsMade);
    AttachCompileReport(Out, bClean, Errors, Warnings);
    // Read back from the compiled skeleton class: the flag only counts once it is BlueprintThreadSafe metadata there.
    const UFunction* Compiled = BP->SkeletonGeneratedClass ? BP->SkeletonGeneratedClass->FindFunctionByName(FName(*FuncName)) : nullptr;
    const bool bCompiledThreadSafe = Compiled && FBlueprintEditorUtils::HasFunctionBlueprintThreadSafeMetaData(Compiled);
    Out->SetBoolField(TEXT("thread_safe"), bCompiledThreadSafe);
    bool bVerified = bCompiledThreadSafe == bThreadSafe;
    bool bFound = false;
    for (const UEdGraph* Current : BP->FunctionGraphs)
        if (Current && Current->GetFName() == FName(*FuncName)) { bFound = true; break; }
    bVerified = bVerified && bFound;
    Out->SetBoolField(TEXT("verified"), bVerified && Entry != nullptr && PinsMade == In.Num() + OutParams.Num());
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
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
        // Literal defaults are part of the graph's meaning; only the ones that are set, to keep the reply small.
        if (!Pin->DefaultValue.IsEmpty()) PinObj->SetStringField(TEXT("default_value"), Pin->DefaultValue);
        if (Pin->DefaultObject) PinObj->SetStringField(TEXT("default_object"), Pin->DefaultObject->GetPathName());
        if (!Pin->DefaultTextValue.IsEmpty()) PinObj->SetStringField(TEXT("default_text"), Pin->DefaultTextValue.ToString());
        Pins.Add(MakeShared<FJsonValueObject>(PinObj));
    }
    Out->SetArrayField(TEXT("pins"), Pins);
    return Out;
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddNode(const TSharedPtr<FJsonObject>& P)
{
    FString Path, FunctionName, GraphName, ClassPath, NodeType;
    FHaybaParamReader ParamR(P, TEXT("blueprint_add_node"));
    Path = ParamR.RequiredString(TEXT("path"));
    GraphName = ParamR.OptionalString(TEXT("graph_name"));
    ClassPath = ParamR.OptionalString(TEXT("class_path"));
    NodeType = ParamR.OptionalString(TEXT("node_type"), TEXT("call_function")).ToLower();
    FunctionName = ParamR.OptionalString(TEXT("function_name"));
    const FString VariableName = ParamR.OptionalString(TEXT("variable_name"));
    const int32 NX = ParamR.OptionalInt(TEXT("x"));
    const int32 NY = ParamR.OptionalInt(TEXT("y"));
    const int32 OptionCount = ParamR.OptionalIntInRange(TEXT("option_count"), 2, 2, 32);
    const FString EventName = ParamR.OptionalString(TEXT("event_name"));
    const FString MacroName = ParamR.OptionalString(TEXT("macro_name"));
    const FString MacroLibrary = ParamR.OptionalString(TEXT("macro_library"),
        TEXT("/Engine/EditorBlueprintResources/StandardMacros.StandardMacros"));
    const FString StructPath = ParamR.OptionalString(TEXT("struct_path"));
    const FString DispatcherName = ParamR.OptionalString(TEXT("dispatcher_name"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    // Config-free node classes: placing them needs nothing but the class. Loaded by
    // path so UMGEditor's private K2Node_CreateWidget needs no header.
    static const TMap<FString, FString> SimpleNodeClasses = {
        { TEXT("sequence"),               TEXT("/Script/BlueprintGraph.K2Node_ExecutionSequence") },
        { TEXT("make_array"),             TEXT("/Script/BlueprintGraph.K2Node_MakeArray") },
        { TEXT("self"),                   TEXT("/Script/BlueprintGraph.K2Node_Self") },
        { TEXT("format_text"),            TEXT("/Script/BlueprintGraph.K2Node_FormatText") },
        { TEXT("get_data_table_row"),     TEXT("/Script/BlueprintGraph.K2Node_GetDataTableRow") },
        { TEXT("spawn_actor_from_class"), TEXT("/Script/BlueprintGraph.K2Node_SpawnActorFromClass") },
        { TEXT("create_widget"),          TEXT("/Script/UMGEditor.K2Node_CreateWidget") },
        { TEXT("reroute"),                TEXT("/Script/BlueprintGraph.K2Node_Knot") },
        { TEXT("get_array_item"),         TEXT("/Script/BlueprintGraph.K2Node_GetArrayItem") },
        { TEXT("switch_int"),             TEXT("/Script/BlueprintGraph.K2Node_SwitchInteger") },
        { TEXT("switch_string"),          TEXT("/Script/BlueprintGraph.K2Node_SwitchString") },
        { TEXT("switch_name"),            TEXT("/Script/BlueprintGraph.K2Node_SwitchName") },
    };
    static const TSet<FString> SupportedNodeTypes = {
        TEXT("call_function"), TEXT("branch"), TEXT("select"), TEXT("timer_by_function"),
        TEXT("variable_get"), TEXT("variable_set"), TEXT("cast"), TEXT("custom_event"),
        TEXT("macro"), TEXT("break_struct"), TEXT("make_struct"), TEXT("call_dispatcher"),
        TEXT("message"), TEXT("function_entry"), TEXT("function_result"),
    };
    if (!SupportedNodeTypes.Contains(NodeType) && !SimpleNodeClasses.Contains(NodeType))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_node: unknown node_type '%s'. Supported: call_function, message, branch, select, timer_by_function, variable_get, variable_set, cast, custom_event, macro, break_struct, make_struct, call_dispatcher, function_entry, function_result, sequence, make_array, self, format_text, get_data_table_row, spawn_actor_from_class, create_widget, reroute, get_array_item, switch_int, switch_string, switch_name. Nothing was changed."),
            *NodeType));
    }
    // "Class:Function", the form editor Python's add_call_function_node takes.
    if (FunctionName.Contains(TEXT(":")) && ClassPath.IsEmpty())
    {
        FunctionName.Split(TEXT(":"), &ClassPath, &FunctionName, ESearchCase::CaseSensitive, ESearchDir::FromEnd);
    }

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_add_node"), Path));
    if (BP->bBeingCompiled)
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: the Blueprint is compiling right now; retry when blueprint_compile has returned. Nothing was changed."));

    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: graph not found"));

    // Non-function node kinds. A graph that can only place function calls cannot express
    // "if a character is assumed, show their holdings" — the shape every real panel needs —
    // so branch / variable / cast are first-class here rather than a later addition.
    auto Place = [&](UK2Node* Node) -> FHaybaHandlerResult
    {
        BP->Modify();
        Graph->Modify();
        Node->CreateNewGuid();
        Node->NodePosX = NX;
        Node->NodePosY = NY;
        Graph->AddNode(Node, false, false);
        Node->PostPlacedNewNode();
        Node->AllocateDefaultPins();
        MarkStructural(BP);
        TSharedPtr<FJsonObject> Out = HaybaDescribeNode(Node);
        Out->SetStringField(TEXT("graph"), Graph->GetName());
        Out->SetStringField(TEXT("node_type"), NodeType);
        Out->SetBoolField(TEXT("verified"), Graph->Nodes.Contains(Node));
        Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
        Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
        return FHaybaHandlerResult::Ok(Out);
    };

    if (NodeType.Equals(TEXT("branch"), ESearchCase::IgnoreCase))
    {
        return Place(NewObject<UK2Node_IfThenElse>(Graph));
    }

    if (NodeType.Equals(TEXT("select"), ESearchCase::IgnoreCase))
    {
        UK2Node_Select* Node = NewObject<UK2Node_Select>(Graph);
        FHaybaHandlerResult Placed = Place(Node);
        for (int32 I = 2; I < OptionCount && Node->CanAddPin(); ++I) Node->AddInputPin();
        if (Placed.Data.IsValid())
        {
            Placed.Data = HaybaDescribeNode(Node);
            Placed.Data->SetStringField(TEXT("graph"), Graph->GetName());
            Placed.Data->SetStringField(TEXT("node_type"), NodeType);
            Placed.Data->SetBoolField(TEXT("verified"), Graph->Nodes.Contains(Node));
            Placed.Data->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
            Placed.Data->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
        }
        return Placed;
    }

    if (const FString* SimpleClassPath = SimpleNodeClasses.Find(NodeType))
    {
        UClass* NodeClass = LoadObject<UClass>(nullptr, **SimpleClassPath);
        if (!NodeClass || !NodeClass->IsChildOf(UK2Node::StaticClass()) || NodeClass->HasAnyClassFlags(CLASS_Abstract))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("blueprint_add_node: node class %s is not available in this editor"), **SimpleClassPath));
        return Place(NewObject<UK2Node>(Graph, NodeClass));
    }

    // Entry and result nodes belong to function graphs. The entry always exists, so it is
    // only ever found; a result node is found or created, never duplicated.
    if (NodeType == TEXT("function_entry") || NodeType == TEXT("function_result"))
    {
        const bool bEntry = NodeType == TEXT("function_entry");
        for (UEdGraphNode* N : Graph->Nodes)
        {
            if ((bEntry && Cast<UK2Node_FunctionEntry>(N)) || (!bEntry && Cast<UK2Node_FunctionResult>(N)))
            {
                TSharedPtr<FJsonObject> Found = HaybaDescribeNode(N);
                Found->SetStringField(TEXT("graph"), Graph->GetName());
                Found->SetStringField(TEXT("node_type"), NodeType);
                Found->SetBoolField(TEXT("already_existed"), true);
                Found->SetBoolField(TEXT("verified"), true);
                return FHaybaHandlerResult::Ok(Found);
            }
        }
        if (bEntry || !BP->FunctionGraphs.Contains(Graph))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_add_node: %s needs a function graph; '%s' is not one. Pass graph_name of a function."),
                *NodeType, *Graph->GetName()));
        return Place(NewObject<UK2Node_FunctionResult>(Graph));
    }

    if (NodeType == TEXT("custom_event"))
    {
        if (EventName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: custom_event needs event_name"));
        // Idempotent like add_event: a second event with the same name is a compile
        // error, and deleting then re-adding a name is what crashed FoA's editor.
        if (UK2Node_Event* Existing = FBlueprintEditorUtils::FindCustomEventNode(BP, FName(*EventName)))
        {
            TSharedPtr<FJsonObject> Found = HaybaDescribeNode(Existing);
            Found->SetStringField(TEXT("graph"), Existing->GetGraph() ? Existing->GetGraph()->GetName() : FString());
            Found->SetStringField(TEXT("node_type"), NodeType);
            Found->SetBoolField(TEXT("already_existed"), true);
            Found->SetBoolField(TEXT("verified"), true);
            return FHaybaHandlerResult::Ok(Found);
        }
        if (!BP->UbergraphPages.Contains(Graph))
            return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: custom events live in an event graph, not a function graph"));
        TArray<UEdGraph*> AllGraphs;
        BP->GetAllGraphs(AllGraphs);
        for (const UEdGraph* G : AllGraphs)
        {
            if (G && G->GetFName() == FName(*EventName))
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("blueprint_add_node: '%s' is already a graph/function name on this Blueprint; pick another event name"), *EventName));
        }
        UK2Node_CustomEvent* Node = NewObject<UK2Node_CustomEvent>(Graph);
        Node->CustomFunctionName = FName(*EventName);
        return Place(Node);
    }

    // Macro instances made by C++ the way the palette makes them. FoA's crash was editor
    // Python calling BlueprintEditorLibrary on a script-made macro node, not the node itself.
    if (NodeType == TEXT("macro"))
    {
        if (MacroName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: macro needs macro_name (e.g. ForEachLoop, IsValid, DoOnce)"));
        UBlueprint* Library = LoadObject<UBlueprint>(nullptr, *MacroLibrary);
        UEdGraph* MacroGraph = nullptr;
        for (UBlueprint* Source : { BP, Library })
        {
            if (!Source || MacroGraph) continue;
            for (UEdGraph* G : Source->MacroGraphs)
            {
                if (G && G->GetName().Equals(MacroName, ESearchCase::IgnoreCase)) { MacroGraph = G; break; }
            }
        }
        if (!MacroGraph)
        {
            FString Available;
            if (Library)
                for (const UEdGraph* G : Library->MacroGraphs) if (G) { Available += G->GetName(); Available += TEXT(" "); }
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_add_node: no macro '%s' on this Blueprint or in %s. Available there: %s"), *MacroName, *MacroLibrary, *Available));
        }
        UK2Node_MacroInstance* Node = NewObject<UK2Node_MacroInstance>(Graph);
        Node->SetMacroGraph(MacroGraph);
        return Place(Node);
    }

    if (NodeType == TEXT("break_struct") || NodeType == TEXT("make_struct"))
    {
        UScriptStruct* Struct = StructPath.IsEmpty() ? nullptr : LoadObject<UScriptStruct>(nullptr, *StructPath);
        if (!Struct)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_add_node: %s needs struct_path of a loadable struct, e.g. /Script/CoreUObject.Vector or /Game/Data/S_Item.S_Item (got '%s')"),
                *NodeType, *StructPath));
        if (NodeType == TEXT("make_struct"))
        {
            if (!UK2Node_MakeStruct::CanBeMade(Struct))
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("blueprint_add_node: %s cannot be made in Blueprint"), *StructPath));
            UK2Node_MakeStruct* Node = NewObject<UK2Node_MakeStruct>(Graph);
            Node->StructType = Struct;
            return Place(Node);
        }
        UK2Node_BreakStruct* Node = NewObject<UK2Node_BreakStruct>(Graph);
        Node->StructType = Struct;
        return Place(Node);
    }

    if (NodeType == TEXT("call_dispatcher"))
    {
        UClass* Scope = BP->SkeletonGeneratedClass ? BP->SkeletonGeneratedClass.Get() : BP->GeneratedClass.Get();
        const FMulticastDelegateProperty* Dispatcher = Scope && !DispatcherName.IsEmpty()
            ? FindFProperty<FMulticastDelegateProperty>(Scope, FName(*DispatcherName)) : nullptr;
        if (!Dispatcher)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_add_node: call_dispatcher needs dispatcher_name of an event dispatcher on this Blueprint (got '%s'); compile after adding a dispatcher"),
                *DispatcherName));
        UK2Node_CallDelegate* Node = NewObject<UK2Node_CallDelegate>(Graph);
        Node->SetFromProperty(Dispatcher, true, Dispatcher->GetOwnerClass());
        return Place(Node);
    }

    if (NodeType.Equals(TEXT("timer_by_function"), ESearchCase::IgnoreCase))
    {
        FunctionName = TEXT("K2_SetTimer");
        ClassPath = UKismetSystemLibrary::StaticClass()->GetPathName();
        NodeType = TEXT("call_function");
    }

    if (NodeType.Equals(TEXT("variable_get"), ESearchCase::IgnoreCase)
        || NodeType.Equals(TEXT("variable_set"), ESearchCase::IgnoreCase))
    {
        const FString& VarName = VariableName;
        if (VarName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: variable_get/set needs variable_name"));

        // Resolution order: another class's member when class_path is given, else this
        // Blueprint's member, else a local variable of the function graph being edited.
        const FName VarFName(*VarName);
        auto Bind = [&](FMemberReference& Ref) -> FString
        {
            if (!ClassPath.IsEmpty())
            {
                UClass* External = LoadObject<UClass>(nullptr, *ClassPath);
                if (!External || !FindFProperty<FProperty>(External, VarFName))
                    return FString::Printf(TEXT("no variable '%s' on class %s"), *VarName, *ClassPath);
                Ref.SetExternalMember(VarFName, External);
                return FString();
            }
            UClass* VarScope = BP->SkeletonGeneratedClass ? BP->SkeletonGeneratedClass.Get() : BP->GeneratedClass.Get();
            if (VarScope && FindFProperty<FProperty>(VarScope, VarFName))
            {
                Ref.SetSelfMember(VarFName);
                return FString();
            }
            if (const FBPVariableDescription* Local = FBlueprintEditorUtils::FindLocalVariable(BP, Graph, VarFName))
            {
                Ref.SetLocalMember(VarFName, Graph->GetName(), Local->VarGuid);
                return FString();
            }
            return FString::Printf(
                TEXT("no variable '%s' on this blueprint or as a local of graph '%s'. Create it with blueprint_add_variable, or pass class_path for another class's member."),
                *VarName, *Graph->GetName());
        };

        FMemberReference VarRef;
        const FString Why = Bind(VarRef);
        if (!Why.IsEmpty()) return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: ") + Why);
        if (NodeType.Equals(TEXT("variable_get"), ESearchCase::IgnoreCase))
        {
            UK2Node_VariableGet* Node = NewObject<UK2Node_VariableGet>(Graph);
            Node->VariableReference = VarRef;
            return Place(Node);
        }
        UK2Node_VariableSet* Node = NewObject<UK2Node_VariableSet>(Graph);
        Node->VariableReference = VarRef;
        return Place(Node);
    }

    if (NodeType.Equals(TEXT("cast"), ESearchCase::IgnoreCase))
    {
        if (ClassPath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: cast needs class_path (the target type)"));
        UClass* Target = LoadObject<UClass>(nullptr, *ClassPath);
        if (!Target) { Target = LoadClass<UObject>(nullptr, *ClassPath); }
        if (!Target)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("blueprint_add_node: cast target not found: %s"), *ClassPath));
        UK2Node_DynamicCast* Node = NewObject<UK2Node_DynamicCast>(Graph);
        Node->TargetType = Target;
        Node->SetPurity(false);
        return Place(Node);
    }

    if (FunctionName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: missing function_name"));

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

    // An interface message calls through any object without a cast; same placement otherwise.
    if (NodeType == TEXT("message") && !(OwnerClass && OwnerClass->HasAnyClassFlags(CLASS_Interface)))
        return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: message needs class_path of a Blueprint interface (e.g. /Game/X/BPI_Y.BPI_Y_C)"));
    UK2Node_CallFunction* Node = NodeType == TEXT("message")
        ? NewObject<UK2Node_Message>(Graph)
        : NewObject<UK2Node_CallFunction>(Graph);
    Node->CreateNewGuid();
    Node->SetFromFunction(Fn);
    Node->NodePosX = NX;
    Node->NodePosY = NY;
    Graph->AddNode(Node, false, false);
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();

    MarkStructural(BP);

    TSharedPtr<FJsonObject> Out = HaybaDescribeNode(Node);
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetBoolField(TEXT("verified"), Graph->Nodes.Contains(Node));
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
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
    FHaybaParamReader ParamR(P, TEXT("blueprint_set_pin_default"));
    Path = ParamR.RequiredString(TEXT("path"));
    NodeId = ParamR.RequiredString(TEXT("node_id"));
    PinName = ParamR.RequiredString(TEXT("pin_name"));
    Value = ParamR.RequiredString(TEXT("value"));
    GraphName = ParamR.OptionalString(TEXT("graph_name"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_set_pin_default"), Path));
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

    const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
    UObject* ResolvedDefaultObject = nullptr;
    const bool bHardObjectPin = Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Object
        || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Class;
    const bool bSoftObjectPin = Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftObject
        || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftClass;

    // Object/class pins take an asset reference rather than a string literal.
    if (bHardObjectPin || bSoftObjectPin)
    {
        ResolvedDefaultObject = LoadObject<UObject>(nullptr, *Value);
        if (!ResolvedDefaultObject)
        {
            ResolvedDefaultObject = LoadClass<UObject>(nullptr, *Value);
        }
        if (!ResolvedDefaultObject)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_set_pin_default: could not load '%s' for object/class pin '%s'; nothing was changed"), *Value, *PinName));
        }
    }

    const FString ValidationError = Schema->IsPinDefaultValid(
        Pin,
        bHardObjectPin ? FString() : Value,
        bHardObjectPin ? ResolvedDefaultObject : nullptr,
        FText::GetEmpty());
    if (!ValidationError.IsEmpty())
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_set_pin_default: invalid value for pin '%s': %s. Nothing was changed."),
            *PinName, *ValidationError));
    }

    // Execute only after path resolution and schema validation have succeeded.
    BP->Modify();
    Graph->Modify();
    // The schema setters return void in UE 5.8, so their only trustworthy
    // outcome is the readback below.
    if (bHardObjectPin) Schema->TrySetDefaultObject(*Pin, ResolvedDefaultObject);
    else                Schema->TrySetDefaultValue(*Pin, Value);

    MarkStructural(BP);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), NodeId);
    Out->SetStringField(TEXT("pin_name"), PinName);
    Out->SetStringField(TEXT("applied"), Pin->DefaultObject ? Pin->DefaultObject->GetPathName() : Pin->DefaultValue);
    const bool bVerified = bHardObjectPin
        ? Pin->DefaultObject == ResolvedDefaultObject
        : Pin->DefaultValue == Value;
    Out->SetBoolField(TEXT("verified"), bVerified);
    if (!bVerified)
    {
        Out->SetStringField(TEXT("warning"), FString::Printf(
            TEXT("The schema setter returned but pin '%s' did not retain '%s'. State was re-read and does not match; inspect the pin before retrying."),
            *PinName, *Value));
    }
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::ConnectNodes(const TSharedPtr<FJsonObject>& P)
{
    FString Path, FromId, FromPin, ToId, ToPin, GraphName;
    FHaybaParamReader ParamR(P, TEXT("blueprint_connect_nodes"));
    Path = ParamR.RequiredString(TEXT("path"));
    FromId = ParamR.RequiredString(TEXT("from_node"));
    ToId = ParamR.RequiredString(TEXT("to_node"));
    FromPin = ParamR.RequiredString(TEXT("from_pin"));
    ToPin = ParamR.RequiredString(TEXT("to_pin"));
    GraphName = ParamR.OptionalString(TEXT("graph_name"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_connect_nodes"), Path));
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

    MarkStructural(BP);

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("from"), FromId + TEXT(".") + FromPin);
    Result->SetStringField(TEXT("to"), ToId + TEXT(".") + ToPin);
    const bool bVerified = OutPin->LinkedTo.Contains(InPin) && InPin->LinkedTo.Contains(OutPin);
    Result->SetBoolField(TEXT("connected"), bVerified);
    Result->SetBoolField(TEXT("verified"), bVerified);
    Result->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    if (!bVerified)
    {
        Result->SetStringField(TEXT("warning"),
            TEXT("The schema reported success but the bidirectional pin link was not present on readback. State is unknown; inspect both nodes before retrying."));
    }
    Result->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::Compile(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    FHaybaParamReader ParamR(P, TEXT("blueprint_compile"));
    Path = ParamR.RequiredString(TEXT("path"));
    const bool bSave = ParamR.OptionalBool(TEXT("save"), true);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());
    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_compile"), Path));

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
    bool bSaved = false;
    if (bOk && bSave)
    {
        UPackage* Package = BP->GetOutermost();
        const FString Filename = FPackageName::LongPackageNameToFilename(Package->GetName(), FPackageName::GetAssetPackageExtension());
        FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone;
        bSaved = UPackage::SavePackage(Package, BP, *Filename, Args);
        if (!bSaved)
            Out->SetStringField(TEXT("save_error"),
                TEXT("Compile succeeded but SavePackage failed. The Blueprint is changed in memory and remains dirty; save it before closing the editor. Do not retry the mutation that preceded this compile."));
    }
    if (bSave) Out->SetBoolField(TEXT("saved"), bSaved);
    else       Out->SetBoolField(TEXT("save_requested"), false);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

// The command layer caps every reply array at 50 items (HaybaMCPCommandHandler.cpp, Limits.MaxArrayItems), so a
// graph read pages instead: a page never exceeds the cap, and the totals say how far there is to go.
static constexpr int32 HaybaGraphPageMax = 50;

/** Clamp [Offset, Offset + Limit) to Total; describe the page as {offset, returned, total, next_offset|null}. */
static TSharedPtr<FJsonObject> HaybaPage(int32 Total, int32 Offset, int32 Limit, int32& OutBegin, int32& OutEnd)
{
    OutBegin = FMath::Clamp(Offset, 0, Total);
    OutEnd = FMath::Min(Total, OutBegin + Limit);
    TSharedPtr<FJsonObject> Page = MakeShared<FJsonObject>();
    Page->SetNumberField(TEXT("offset"), OutBegin);
    Page->SetNumberField(TEXT("returned"), OutEnd - OutBegin);
    Page->SetNumberField(TEXT("total"), Total);
    if (OutEnd < Total) Page->SetNumberField(TEXT("next_offset"), OutEnd);
    else Page->SetField(TEXT("next_offset"), MakeShared<FJsonValueNull>());
    return Page;
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::InspectGraph(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("blueprint_inspect_graph"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString GraphName = R.OptionalString(TEXT("graph_name"));
    const int32 Offset = R.OptionalIntInRange(TEXT("offset"), 0, 0, MAX_int32);
    const int32 Limit = R.OptionalIntInRange(TEXT("limit"), HaybaGraphPageMax, 1, HaybaGraphPageMax);
    const int32 EdgeOffset = R.OptionalIntInRange(TEXT("edge_offset"), 0, 0, MAX_int32);
    const int32 EdgeLimit = R.OptionalIntInRange(TEXT("edge_limit"), HaybaGraphPageMax, 1, HaybaGraphPageMax);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());
    UBlueprint* BP = LoadBPByPath(Path); if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_inspect_graph"), Path));
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName); if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_inspect_graph: graph not found"));

    // Every edge in a fixed order (node order, then output pin order, then link order) so edge pages are stable.
    struct FEdge { const UEdGraphNode* From; const UEdGraphPin* FromPin; const UEdGraphPin* To; };
    TArray<UEdGraphNode*> AllNodes;
    TArray<FEdge> AllEdges;
    for (UEdGraphNode* Node : Graph->Nodes)
    {
        if (!Node) continue;
        AllNodes.Add(Node);
        for (UEdGraphPin* Pin : Node->Pins)
        {
            if (!Pin || Pin->Direction != EGPD_Output) continue;
            for (UEdGraphPin* Linked : Pin->LinkedTo)
                if (Linked && Linked->GetOwningNode()) AllEdges.Add({ Node, Pin, Linked });
        }
    }
    int32 NodeBegin, NodeEnd, EdgeBegin, EdgeEnd;
    TSharedPtr<FJsonObject> Page = MakeShared<FJsonObject>();
    Page->SetObjectField(TEXT("nodes"), HaybaPage(AllNodes.Num(), Offset, Limit, NodeBegin, NodeEnd));
    Page->SetObjectField(TEXT("edges"), HaybaPage(AllEdges.Num(), EdgeOffset, EdgeLimit, EdgeBegin, EdgeEnd));

    TArray<TSharedPtr<FJsonValue>> Nodes, Edges;
    for (int32 I = NodeBegin; I < NodeEnd; ++I)
        Nodes.Add(MakeShared<FJsonValueObject>(HaybaDescribeNode(AllNodes[I]).ToSharedRef()));
    for (int32 I = EdgeBegin; I < EdgeEnd; ++I)
    {
        TSharedPtr<FJsonObject> Edge = MakeShared<FJsonObject>();
        Edge->SetStringField(TEXT("from_node"), AllEdges[I].From->NodeGuid.ToString());
        Edge->SetStringField(TEXT("from_pin"), AllEdges[I].FromPin->PinName.ToString());
        Edge->SetStringField(TEXT("to_node"), AllEdges[I].To->GetOwningNode()->NodeGuid.ToString());
        Edge->SetStringField(TEXT("to_pin"), AllEdges[I].To->PinName.ToString());
        Edges.Add(MakeShared<FJsonValueObject>(Edge.ToSharedRef()));
    }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), BP->GetPathName());
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetArrayField(TEXT("nodes"), Nodes);
    Out->SetArrayField(TEXT("edges"), Edges);
    Out->SetNumberField(TEXT("node_count"), AllNodes.Num());
    Out->SetNumberField(TEXT("edge_count"), AllEdges.Num());
    Out->SetObjectField(TEXT("page"), Page);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::Document(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    FHaybaParamReader ParamR(P, TEXT("blueprint_document"));
    Path = ParamR.RequiredString(TEXT("path"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());
    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_document"), Path));

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
    FHaybaParamReader ParamR(P, TEXT("blueprint_add_event"));
    Path = ParamR.RequiredString(TEXT("path"));
    EventName = ParamR.RequiredString(TEXT("event_name"));
    GraphName = ParamR.OptionalString(TEXT("graph_name"));
    const int32 X = ParamR.OptionalInt(TEXT("x"));
    const int32 Y = ParamR.OptionalInt(TEXT("y"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_add_event"), Path));

    UClass* ParentClass = BP->ParentClass.Get();
    UFunction* EventFn = ParentClass ? ParentClass->FindFunctionByName(FName(*EventName)) : nullptr;
    if (!EventFn)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_event: no overridable event '%s' on %s"),
            *EventName, ParentClass ? *ParentClass->GetName() : TEXT("<null>")));
    }

    // A parent event with a return value or out params (UUserWidget::OnKeyDown -> FEventReply) cannot be an
    // event node. Implement it the way the editor's Override menu does (SMyBlueprint::ImplementFunction): a
    // function graph built from the parent's signature, so its entry and result nodes match it. graph_name is
    // ignored here; the graph takes the function's name. Idempotent like the event path.
    if (!UEdGraphSchema_K2::FunctionCanBePlacedAsEvent(EventFn))
    {
        UFunction* OverrideFn = nullptr;
        UClass* const OverrideClass = FBlueprintEditorUtils::GetOverrideFunctionClass(BP, EventFn->GetFName(), &OverrideFn);
        if (!OverrideClass || !OverrideFn || !UEdGraphSchema_K2::CanKismetOverrideFunction(OverrideFn))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_add_event: '%s' on %s is not a Blueprint-overridable function. Nothing was changed."),
                *EventName, *ParentClass->GetName()));
        }
        UEdGraph* FnGraph = FindObject<UEdGraph>(BP, *EventFn->GetName());
        const bool bExisted = FnGraph != nullptr;
        if (!FnGraph)
        {
            BP->Modify();
            FnGraph = FBlueprintEditorUtils::CreateNewGraph(BP, EventFn->GetFName(), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
            if (!FnGraph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_event: CreateNewGraph failed for the override graph"));
            FBlueprintEditorUtils::AddFunctionGraph(BP, FnGraph, /*bIsUserCreated*/ false, OverrideClass);
            MarkStructural(BP);
        }
        UK2Node_FunctionEntry* Entry = nullptr;
        UK2Node_FunctionResult* Result = nullptr;
        for (UEdGraphNode* N : FnGraph->Nodes)
        {
            if (!Entry) Entry = Cast<UK2Node_FunctionEntry>(N);
            if (!Result) Result = Cast<UK2Node_FunctionResult>(N);
        }
        // node_id is the entry, so a blueprint_graph_batch add_event ref binds to the override's entry point.
        TSharedPtr<FJsonObject> Out = HaybaDescribeNode(Entry);
        Out->SetStringField(TEXT("kind"), TEXT("function_override"));
        Out->SetStringField(TEXT("graph_name"), FnGraph->GetName());
        Out->SetStringField(TEXT("override_of"), OverrideClass->GetName() + TEXT("::") + EventFn->GetName());
        Out->SetStringField(TEXT("entry_node_id"), Entry ? Entry->NodeGuid.ToString() : FString());
        Out->SetStringField(TEXT("result_node_id"), Result ? Result->NodeGuid.ToString() : FString());
        Out->SetObjectField(TEXT("result_node"), HaybaDescribeNode(Result));
        Out->SetBoolField(TEXT("already_existed"), bExisted);
        Out->SetBoolField(TEXT("verified"), Entry != nullptr && BP->FunctionGraphs.Contains(FnGraph));
        Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
        Out->SetStringField(TEXT("note"), TEXT("Staged. Build the body in graph_name, then call blueprint_compile."));
        return FHaybaHandlerResult::Ok(Out);
    }

    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_event: graph not found"));

    for (UEdGraphNode* N : Graph->Nodes)
    {
        UK2Node_Event* Existing = Cast<UK2Node_Event>(N);
        if (Existing && Existing->EventReference.GetMemberName() == EventFn->GetFName())
        {
            TSharedPtr<FJsonObject> Found = HaybaDescribeNode(Existing);
            Found->SetBoolField(TEXT("already_existed"), true);
            Found->SetBoolField(TEXT("verified"), true);
            Found->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
            return FHaybaHandlerResult::Ok(Found);
        }
    }

    BP->Modify();
    Graph->Modify();

    UK2Node_Event* Node = NewObject<UK2Node_Event>(Graph);
    Node->CreateNewGuid();
    Node->EventReference.SetExternalMember(EventFn->GetFName(), ParentClass);
    Node->bOverrideFunction = true;
    Node->NodePosX = X;
    Node->NodePosY = Y;
    Graph->AddNode(Node, false, false);
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();

    MarkStructural(BP);

    TSharedPtr<FJsonObject> Out = HaybaDescribeNode(Node);
    Out->SetBoolField(TEXT("already_existed"), false);
    Out->SetBoolField(TEXT("verified"), Graph->Nodes.Contains(Node));
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::SetDefaults(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("blueprint_set_defaults"));
    const FString Path = ParamR.RequiredString(TEXT("path"));
    const TSharedPtr<FJsonObject> PropsObj = ParamR.RequiredObject(TEXT("properties"), 1, 128);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_set_defaults"), Path));
    if (!BP->GeneratedClass)
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_defaults: GeneratedClass missing — compile first"));

    UObject* CDO = BP->GeneratedClass->GetDefaultObject();
    if (!CDO) return FHaybaHandlerResult::Err(TEXT("blueprint_set_defaults: CDO missing"));
    if (CDO->GetClass()->HasAnyClassFlags(CLASS_Abstract))
    {
        return FHaybaHandlerResult::Err(
            TEXT("blueprint_set_defaults: generated class is abstract and cannot be safely instantiated for staging; nothing was changed. Make a concrete child Blueprint and set its defaults instead."));
    }

    UObject* StagedCDO = NewObject<UObject>(GetTransientPackage(), CDO->GetClass());
    if (!StagedCDO)
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_defaults: could not allocate a staging CDO; nothing was changed"));

    TArray<TSharedPtr<FJsonValue>> SetNames;
    TArray<TSharedPtr<FJsonValue>> Skipped;
    struct FStagedDefault
    {
        FString Name;
        FProperty* Property = nullptr;
        FString ExpectedText;
    };
    TArray<FStagedDefault> Staged;

    auto AddSkipped = [&Skipped](const FString& Key, const TCHAR* Reason)
    {
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Key);
        Entry->SetStringField(TEXT("reason"), Reason);
        Skipped.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    };

    int32 JsonNodes = 0;
    for (const auto& Pair : PropsObj->Values)
    {
        FString ShapeReason;
        if (!HaybaValidateMutationJsonShape(Pair.Value, 0, JsonNodes, ShapeReason))
        {
            AddSkipped(FString(*Pair.Key), *ShapeReason);
            continue;
        }
        FProperty* Prop = BP->GeneratedClass->FindPropertyByName(FName(*Pair.Key));
        if (!Prop)
        {
            AddSkipped(FString(*Pair.Key), TEXT("property_not_found"));
            continue;
        }

        // Preserve unspecified members of nested structs/containers while the
        // JSON patch is staged, without duplicating the entire CDO/subobject
        // graph and running unrelated PostDuplicate work.
        Prop->CopyCompleteValue_InContainer(StagedCDO, CDO);

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
        if (!HaybaReflection::SetValueFromJson(Prop, StagedCDO, Pair.Value, StagedCDO))
        {
            AddSkipped(FString(*Pair.Key), TEXT("value_could_not_be_applied"));
            continue;
        }
        Staged.Add({ FString(*Pair.Key), Prop, FString() });
    }

    if (Staged.Num() == 0)
    {
        return FHaybaHandlerResult::Err(
            TEXT("blueprint_set_defaults: none of the requested properties could be staged; the CDO, Blueprint dirty state, and compile state were not changed"));
    }

    // Execute only after every property has either been staged or assigned an
    // explicit rejection. Copying completed FProperty values avoids repeating
    // fallible JSON conversion against the live CDO.
    CDO->Modify();
    for (FStagedDefault& Item : Staged)
    {
        Item.Property->CopyCompleteValue_InContainer(CDO, StagedCDO);
        const void* ValuePtr = Item.Property->ContainerPtrToValuePtr<void>(CDO);
        Item.Property->ExportTextItem_Direct(
            Item.ExpectedText, ValuePtr, nullptr, CDO, PPF_None);
        SetNames.Add(MakeShared<FJsonValueString>(Item.Name));
    }

    FBlueprintEditorUtils::MarkBlueprintAsModified(BP);

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    // Compiling may reinstate the GeneratedClass and replace its CDO. Never
    // trust the pointer captured before that boundary: re-resolve and verify
    // each property by name on the post-compile object.
    UObject* ObservedCDO = BP->GeneratedClass
        ? BP->GeneratedClass->GetDefaultObject()
        : nullptr;
    TArray<TSharedPtr<FJsonValue>> VerificationFailed;
    int32 VerifiedCount = 0;
    for (const FStagedDefault& Item : Staged)
    {
        FProperty* ObservedProp = ObservedCDO
            ? BP->GeneratedClass->FindPropertyByName(FName(*Item.Name))
            : nullptr;
        FString ObservedText;
        if (ObservedProp)
        {
            const void* ValuePtr = ObservedProp->ContainerPtrToValuePtr<void>(ObservedCDO);
            ObservedProp->ExportTextItem_Direct(
                ObservedText, ValuePtr, nullptr, ObservedCDO, PPF_None);
        }
        if (ObservedProp && ObservedText == Item.ExpectedText)
        {
            ++VerifiedCount;
        }
        else
        {
            VerificationFailed.Add(MakeShared<FJsonValueString>(Item.Name));
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("set"), SetNames);
    Out->SetArrayField(TEXT("skipped"), Skipped);
    Out->SetNumberField(TEXT("succeeded"), VerifiedCount);
    Out->SetNumberField(TEXT("failed"), Skipped.Num() + VerificationFailed.Num());
    Out->SetArrayField(TEXT("verification_failed"), VerificationFailed);
    Out->SetBoolField(TEXT("verified"), VerificationFailed.Num() == 0);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    if (VerificationFailed.Num() > 0)
    {
        Out->SetStringField(TEXT("warning"),
            TEXT("One or more staged defaults did not survive Blueprint compilation. Read the CDO back before retrying; the listed properties have an unknown postcondition."));
    }
    AttachCompileReport(Out, bClean, Errors, Warnings);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// Graph tidying and bulk authoring: comments, moves, removal, disconnects and a
// batch that runs many of them in one call. FoA's lanes built graphs through
// editor Python because one MCP call per link was impractical; these replace
// that path. All staging only: compile with blueprint_compile (or compile:true).
// ---------------------------------------------------------------------------

void FHaybaMCPBlueprintHandler::MarkStructural(UBlueprint* BP)
{
    if (bDeferStructuralMark) { bStructuralPending = true; return; }
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
}

/** Shared preamble: load, refuse a compiling Blueprint, resolve the graph. */
static UEdGraph* HaybaGraphForEdit(const FString& Command, const FString& Path, const FString& GraphName,
    UBlueprint*& OutBP, FString& OutError)
{
    OutBP = LoadBPByPath(Path);
    if (!OutBP) { OutError = BlueprintNotFoundError(*Command, Path); return nullptr; }
    if (OutBP->bBeingCompiled)
    {
        OutError = Command + TEXT(": the Blueprint is compiling right now; retry when that compile has returned. Nothing was changed.");
        return nullptr;
    }
    UEdGraph* Graph = HaybaFindGraph(OutBP, GraphName);
    if (!Graph) OutError = Command + TEXT(": graph not found");
    return Graph;
}

/** Title and pin-label estimate, for when Slate cannot measure (commandlet, -nullrhi). */
static HaybaBlueprintOps::FNodeBox HaybaEstimateBox(const UEdGraphNode* N)
{
    int32 In = 0, Out = 0, MaxIn = 0, MaxOut = 0;
    for (const UEdGraphPin* Pin : N->Pins)
    {
        if (!Pin || Pin->bHidden) continue;
        const int32 Chars = Pin->GetDisplayName().ToString().Len();
        if (Pin->Direction == EGPD_Input) { ++In; MaxIn = FMath::Max(MaxIn, Chars); }
        else { ++Out; MaxOut = FMath::Max(MaxOut, Chars); }
    }
    return HaybaBlueprintOps::EstimateNodeBox(N->NodePosX, N->NodePosY, N->NodeWidth, N->NodeHeight,
        N->GetNodeTitle(ENodeTitleType::FullTitle).ToString().Len(), In, Out, MaxIn, MaxOut);
}

/** Every node's box in Graph. Real rendered sizes come from a private SGraphPanel that is
 *  built, measured at 1:1 and dropped, never shown: K2 node sizes exist only in Slate
 *  widgets, which is why comment boxes sized from estimates clipped their nodes. Comments
 *  use their stored rect. Returns false when Slate is unavailable (every box then estimated). */
static bool HaybaNodeBoxes(UEdGraph* Graph, TMap<const UEdGraphNode*, HaybaBlueprintOps::FNodeBox>& Out)
{
    bool bMeasured = false;
    if (FSlateApplication::IsInitialized() && !IsRunningCommandlet())
    {
        TSharedRef<SGraphPanel> Panel = SNew(SGraphPanel)
            .GraphObj(Graph)
            .IsEditable(false)
            .InitialZoomToFit(false)
            .ShowGraphStateOverlay(false);
        Panel->Update();          // one widget per node
        Panel->SlatePrepass(1.f); // desired sizes at 1:1
        for (const UEdGraphNode* Node : Graph->Nodes)
        {
            FVector2f Min, Max;
            if (Node && !Node->IsA<UEdGraphNode_Comment>() && Panel->GetBoundsForNode(Node, Min, Max, 0.f))
            {
                Out.Add(Node, HaybaBlueprintOps::FNodeBox{ FMath::FloorToInt32(Min.X), FMath::FloorToInt32(Min.Y),
                    FMath::CeilToInt32(Max.X - Min.X), FMath::CeilToInt32(Max.Y - Min.Y) });
                bMeasured = true;
            }
        }
    }
    for (const UEdGraphNode* Node : Graph->Nodes)
    {
        if (!Node || Out.Contains(Node)) continue;
        if (Node->IsA<UEdGraphNode_Comment>())
            Out.Add(Node, HaybaBlueprintOps::FNodeBox{ Node->NodePosX, Node->NodePosY, Node->NodeWidth, Node->NodeHeight });
        else
            Out.Add(Node, HaybaEstimateBox(Node));
    }
    return bMeasured;
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddComment(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("blueprint_add_comment"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString GraphName = R.OptionalString(TEXT("graph_name"));
    const FString Title = R.RequiredString(TEXT("title"), 1024);
    const FString Description = R.OptionalString(TEXT("description"), FString(), 4096);
    const TArray<TSharedPtr<FJsonValue>>* NodeIds = R.OptionalArray(TEXT("node_ids"), 1024, 1);
    const TArray<TSharedPtr<FJsonValue>>* ColorArr = R.OptionalArray(TEXT("color"), 4, 3);
    const int32 Pad = R.OptionalIntInRange(TEXT("padding"), 40, 0, 1000);
    const int32 FontSize = R.OptionalIntInRange(TEXT("font_size"), 18, 1, 1000);
    const bool bBubble = R.OptionalBool(TEXT("bubble"), true);
    const int32 X = R.OptionalInt(TEXT("x"));
    const int32 Y = R.OptionalInt(TEXT("y"));
    const int32 W = R.OptionalIntInRange(TEXT("width"), 400, 16, 100000);
    const int32 H = R.OptionalIntInRange(TEXT("height"), 100, 16, 100000);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    UBlueprint* BP = nullptr;
    FString Error;
    UEdGraph* Graph = HaybaGraphForEdit(TEXT("blueprint_add_comment"), Path, GraphName, BP, Error);
    if (!Graph) return FHaybaHandlerResult::Err(Error);

    // Resolve every enclosed node before creating anything.
    HaybaBlueprintOps::FNodeBox Box{ X, Y, W, H };
    TArray<UEdGraphNode*> Enclosed;
    bool bMeasured = false;
    if (NodeIds)
    {
        for (const TSharedPtr<FJsonValue>& V : *NodeIds)
        {
            UEdGraphNode* N = V.IsValid() ? HaybaFindNode(Graph, V->AsString()) : nullptr;
            if (!N)
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("blueprint_add_comment: node '%s' is not in graph '%s'; nothing was changed"),
                    V.IsValid() ? *V->AsString() : TEXT("?"), *Graph->GetName()));
            Enclosed.Add(N);
        }
        TMap<const UEdGraphNode*, HaybaBlueprintOps::FNodeBox> AllBoxes;
        bMeasured = HaybaNodeBoxes(Graph, AllBoxes);
        TArray<HaybaBlueprintOps::FNodeBox> Boxes;
        for (const UEdGraphNode* N : Enclosed) Boxes.Add(AllBoxes.FindRef(N));
        Box = HaybaBlueprintOps::CommentAround(Boxes, Pad, FontSize * 2);
    }

    FLinearColor Color(0.3f, 0.3f, 0.3f, 1.f);
    if (ColorArr)
    {
        auto C = [ColorArr](int32 I, float D) { return ColorArr->IsValidIndex(I) ? (float)(*ColorArr)[I]->AsNumber() : D; };
        Color = FLinearColor(C(0, 0.3f), C(1, 0.3f), C(2, 0.3f), C(3, 1.f));
    }

    BP->Modify();
    Graph->Modify();
    UEdGraphNode_Comment* Comment = NewObject<UEdGraphNode_Comment>(Graph);
    Comment->CreateNewGuid();
    Graph->AddNode(Comment, false, false);
    // PostPlacedNewNode applies the editor's default colour, bubble and title, so
    // every caller value is written after it.
    Comment->PostPlacedNewNode();
    Comment->NodePosX = Box.X;
    Comment->NodePosY = Box.Y;
    Comment->NodeWidth = Box.W;
    Comment->NodeHeight = Box.H;
    Comment->NodeComment = Title;
    Comment->NodeDetails = FText::FromString(Description);
    Comment->CommentColor = Color;
    Comment->FontSize = FontSize;
    // "Show Bubble When Zoomed" + "Color Bubble". The editor mirrors the first into the
    // node's visible/pinned bubble flags in PostEditChangeProperty, so set those too.
    Comment->bCommentBubbleVisible_InDetailsPanel = bBubble;
    Comment->bColorCommentBubble = bBubble;
    Comment->bCommentBubbleVisible = bBubble;
    Comment->bCommentBubblePinned = bBubble;
    for (UEdGraphNode* N : Enclosed) Comment->AddNodeUnderComment(N);
    FBlueprintEditorUtils::MarkBlueprintAsModified(BP);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), Comment->NodeGuid.ToString());
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetArrayField(TEXT("rect"), { MakeShared<FJsonValueNumber>(Box.X), MakeShared<FJsonValueNumber>(Box.Y),
        MakeShared<FJsonValueNumber>(Box.W), MakeShared<FJsonValueNumber>(Box.H) });
    Out->SetNumberField(TEXT("enclosed"), Enclosed.Num());
    Out->SetBoolField(TEXT("measured"), bMeasured);
    Out->SetBoolField(TEXT("bubble"), bBubble);
    Out->SetBoolField(TEXT("verified"), Graph->Nodes.Contains(Comment) && Comment->NodeComment == Title);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    if (Enclosed.Num() > 0 && !bMeasured)
        Out->SetStringField(TEXT("note"), TEXT("Slate was unavailable, so the box was sized from estimated node sizes; run blueprint_fit_comments in a UI session."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::MoveNodes(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("blueprint_move_nodes"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString GraphName = R.OptionalString(TEXT("graph_name"));
    const TArray<TSharedPtr<FJsonValue>>* Moves = R.RequiredArray(TEXT("moves"), 1, 4096);
    const bool bPack = R.OptionalBool(TEXT("pack"), false);
    const int32 Gap = R.OptionalIntInRange(TEXT("gap"), 40, 0, 2000);
    const bool bFit = R.OptionalBool(TEXT("fit_comments"), false);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    UBlueprint* BP = nullptr;
    FString Error;
    UEdGraph* Graph = HaybaGraphForEdit(TEXT("blueprint_move_nodes"), Path, GraphName, BP, Error);
    if (!Graph) return FHaybaHandlerResult::Err(Error);

    struct FMove { UEdGraphNode* Node; int32 X, Y, W, H; };
    TArray<FMove> Planned;
    for (const TSharedPtr<FJsonValue>& V : *Moves)
    {
        const TSharedPtr<FJsonObject>* M = nullptr;
        FString Id;
        double X = 0, Y = 0, W = 0, H = 0;
        if (!V.IsValid() || !V->TryGetObject(M) || !(*M)->TryGetStringField(TEXT("node_id"), Id)
            || !(*M)->TryGetNumberField(TEXT("x"), X) || !(*M)->TryGetNumberField(TEXT("y"), Y))
            return FHaybaHandlerResult::Err(TEXT("blueprint_move_nodes: each move needs node_id, x and y; nothing was moved"));
        UEdGraphNode* Node = HaybaFindNode(Graph, Id);
        if (!Node)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_move_nodes: node '%s' is not in graph '%s'; nothing was moved"), *Id, *Graph->GetName()));
        (*M)->TryGetNumberField(TEXT("width"), W);
        (*M)->TryGetNumberField(TEXT("height"), H);
        if ((W > 0 || H > 0) && !Node->IsA<UEdGraphNode_Comment>())
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_move_nodes: width/height apply to comment boxes only; '%s' is not one. Nothing was moved."), *Id));
        Planned.Add({ Node, FMath::RoundToInt32(X), FMath::RoundToInt32(Y), FMath::RoundToInt32(W), FMath::RoundToInt32(H) });
    }

    // Position only: no pins, links or structure change, so no skeleton work.
    Graph->Modify();
    int32 Verified = 0;
    for (const FMove& M : Planned)
    {
        M.Node->Modify();
        M.Node->NodePosX = M.X;
        M.Node->NodePosY = M.Y;
        if (M.W > 0) M.Node->NodeWidth = M.W;
        if (M.H > 0) M.Node->NodeHeight = M.H;
        if (M.Node->NodePosX == M.X && M.Node->NodePosY == M.Y) ++Verified;
    }

    // pack: the requested positions are a plan; real sizes decide the final Y so no moved
    // node overlaps another node. Unmoved nodes and comments stay where they are.
    int32 Packed = 0;
    bool bMeasured = false;
    if (bPack)
    {
        TMap<const UEdGraphNode*, HaybaBlueprintOps::FNodeBox> AllBoxes;
        bMeasured = HaybaNodeBoxes(Graph, AllBoxes);
        TSet<const UEdGraphNode*> MovedSet;
        for (const FMove& M : Planned) MovedSet.Add(M.Node);
        TArray<UEdGraphNode*> Items;
        TArray<HaybaBlueprintOps::FNodeBox> Boxes;
        TArray<bool> Movable;
        for (UEdGraphNode* N : Graph->Nodes)
        {
            if (!N || N->IsA<UEdGraphNode_Comment>()) continue;
            Items.Add(N);
            Boxes.Add(AllBoxes.FindRef(N));
            Movable.Add(MovedSet.Contains(N));
        }
        Packed = HaybaBlueprintOps::PushApart(Boxes, Movable, Gap);
        for (int32 I = 0; I < Items.Num(); ++I)
        {
            if (Movable[I] && Items[I]->NodePosY != Boxes[I].Y) Items[I]->NodePosY = Boxes[I].Y;
        }
    }
    FBlueprintEditorUtils::MarkBlueprintAsModified(BP);
    Graph->NotifyGraphChanged();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("moved"), Verified);
    // A packed node legitimately ends below its requested Y, so it still counts as moved.
    Out->SetBoolField(TEXT("verified"), Verified == Planned.Num());
    if (bPack)
    {
        Out->SetNumberField(TEXT("packed"), Packed);
        Out->SetBoolField(TEXT("measured"), bMeasured);
    }
    if (bFit)
    {
        TSharedPtr<FJsonObject> FitParams = MakeShared<FJsonObject>();
        FitParams->SetStringField(TEXT("path"), Path);
        FitParams->SetStringField(TEXT("graph_name"), Graph->GetName());
        const FHaybaHandlerResult Fit = FitComments(FitParams);
        if (Fit.bOk && Fit.Data.IsValid()) Out->SetObjectField(TEXT("fit"), Fit.Data);
        else Out->SetStringField(TEXT("fit_error"), Fit.ErrorMessage);
    }
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::RemoveNodes(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("blueprint_remove_nodes"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString GraphName = R.OptionalString(TEXT("graph_name"));
    const TArray<TSharedPtr<FJsonValue>>* Ids = R.RequiredArray(TEXT("node_ids"), 1, 1024);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    UBlueprint* BP = nullptr;
    FString Error;
    UEdGraph* Graph = HaybaGraphForEdit(TEXT("blueprint_remove_nodes"), Path, GraphName, BP, Error);
    if (!Graph) return FHaybaHandlerResult::Err(Error);

    TArray<UEdGraphNode*> Doomed;
    TArray<FString> DoomedIds;
    for (const TSharedPtr<FJsonValue>& V : *Ids)
    {
        const FString Id = V.IsValid() ? V->AsString() : FString();
        UEdGraphNode* Node = HaybaFindNode(Graph, Id);
        if (!Node)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_remove_nodes: node '%s' is not in graph '%s'; nothing was removed"), *Id, *Graph->GetName()));
        if (Node->IsA<UK2Node_FunctionEntry>() || !Node->CanUserDeleteNode())
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_remove_nodes: '%s' (%s) cannot be deleted; nothing was removed"),
                *Id, *Node->GetNodeTitle(ENodeTitleType::ListView).ToString()));
        Doomed.AddUnique(Node);
        DoomedIds.Add(Id);
    }

    // An open graph panel keeps widgets for the nodes it shows; removing nodes under it is
    // the stale-widget crash FoA's rules guard against, so its editors close first.
    int32 ClosedEditors = 0;
    if (GEditor)
    {
        if (UAssetEditorSubsystem* Editors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>())
            ClosedEditors = Editors->CloseAllEditorsForAsset(BP);
    }

    BP->Modify();
    Graph->Modify();
    for (UEdGraphNode* Node : Doomed) FBlueprintEditorUtils::RemoveNode(BP, Node, /*bDontRecompile*/ true);
    MarkStructural(BP);

    int32 StillThere = 0;
    for (const FString& Id : DoomedIds) if (HaybaFindNode(Graph, Id)) ++StillThere;
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("removed"), Doomed.Num() - StillThere);
    Out->SetNumberField(TEXT("closed_editors"), ClosedEditors);
    Out->SetBoolField(TEXT("verified"), StillThere == 0);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::Disconnect(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("blueprint_disconnect"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString GraphName = R.OptionalString(TEXT("graph_name"));
    const FString NodeId = R.RequiredString(TEXT("node_id"));
    const FString PinName = R.RequiredString(TEXT("pin_name"));
    const FString ToId = R.OptionalString(TEXT("to_node"));
    const FString ToPin = R.OptionalString(TEXT("to_pin"));
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());
    if (ToId.IsEmpty() != ToPin.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("blueprint_disconnect: pass to_node and to_pin together, or neither to cut every link on the pin"));

    UBlueprint* BP = nullptr;
    FString Error;
    UEdGraph* Graph = HaybaGraphForEdit(TEXT("blueprint_disconnect"), Path, GraphName, BP, Error);
    if (!Graph) return FHaybaHandlerResult::Err(Error);
    UEdGraphNode* Node = HaybaFindNode(Graph, NodeId);
    UEdGraphPin* Pin = Node ? Node->FindPin(FName(*PinName)) : nullptr;
    if (!Pin) return FHaybaHandlerResult::Err(TEXT("blueprint_disconnect: node or pin not found; nothing was changed"));

    UEdGraphPin* Other = nullptr;
    if (!ToId.IsEmpty())
    {
        UEdGraphNode* ToNode = HaybaFindNode(Graph, ToId);
        Other = ToNode ? ToNode->FindPin(FName(*ToPin)) : nullptr;
        if (!Other || !Pin->LinkedTo.Contains(Other))
            return FHaybaHandlerResult::Err(TEXT("blueprint_disconnect: those two pins are not linked; nothing was changed"));
    }

    const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
    const int32 Before = Pin->LinkedTo.Num();
    BP->Modify();
    Graph->Modify();
    if (Other) Schema->BreakSinglePinLink(Pin, Other);
    else       Schema->BreakPinLinks(*Pin, true);
    MarkStructural(BP);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("broken"), Before - Pin->LinkedTo.Num());
    Out->SetBoolField(TEXT("verified"), Other ? !Pin->LinkedTo.Contains(Other) : Pin->LinkedTo.Num() == 0);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::GraphBatch(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("blueprint_graph_batch"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString GraphName = R.OptionalString(TEXT("graph_name"));
    const TArray<TSharedPtr<FJsonValue>>* Ops = R.RequiredArray(TEXT("ops"), 1, 2048);
    const bool bCompile = R.OptionalBool(TEXT("compile"), false);
    const bool bSave = R.OptionalBool(TEXT("save"), false);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    UBlueprint* BP = nullptr;
    FString Error;
    if (!HaybaGraphForEdit(TEXT("blueprint_graph_batch"), Path, GraphName, BP, Error))
        return FHaybaHandlerResult::Err(Error);

    TMap<FString, FString> Refs;
    TArray<TSharedPtr<FJsonValue>> Results;
    int32 Applied = 0;
    FString FailedError;
    int32 FailedIndex = INDEX_NONE;

    // One skeleton regeneration at the end instead of one per op.
    bDeferStructuralMark = true;
    bStructuralPending = false;
    for (int32 I = 0; I < Ops->Num(); ++I)
    {
        const TSharedPtr<FJsonObject>* OpObj = nullptr;
        if (!(*Ops)[I].IsValid() || !(*Ops)[I]->TryGetObject(OpObj))
        {
            FailedIndex = I;
            FailedError = TEXT("each op must be an object");
            break;
        }
        const HaybaBlueprintOps::FBatchStep Step = HaybaBlueprintOps::TranslateBatchOp(*OpObj, Path, GraphName, Refs);
        if (!Step.Error.IsEmpty()) { FailedIndex = I; FailedError = Step.Error; break; }

        FHaybaHandlerResult Res = FHaybaHandlerResult::Err(TEXT("op has no handler"));
        if      (Step.Command == TEXT("blueprint_add_node"))        Res = AddNode(Step.Params);
        else if (Step.Command == TEXT("blueprint_add_event"))       Res = AddEvent(Step.Params);
        else if (Step.Command == TEXT("blueprint_connect_nodes"))   Res = ConnectNodes(Step.Params);
        else if (Step.Command == TEXT("blueprint_set_pin_default")) Res = SetPinDefault(Step.Params);
        else if (Step.Command == TEXT("blueprint_add_comment"))     Res = AddComment(Step.Params);
        else if (Step.Command == TEXT("blueprint_move_nodes"))      Res = MoveNodes(Step.Params);
        else if (Step.Command == TEXT("blueprint_remove_nodes"))    Res = RemoveNodes(Step.Params);
        else if (Step.Command == TEXT("blueprint_disconnect"))      Res = Disconnect(Step.Params);
        else if (Step.Command == TEXT("blueprint_fit_comments"))    Res = FitComments(Step.Params);

        bool bVerified = false;
        if (Res.bOk && Res.Data.IsValid()) Res.Data->TryGetBoolField(TEXT("verified"), bVerified);
        if (!Res.bOk || !bVerified)
        {
            FailedIndex = I;
            FailedError = Res.bOk ? FString(TEXT("the op reported verified:false; its effect is unknown")) : Res.ErrorMessage;
            break;
        }
        TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
        Item->SetNumberField(TEXT("i"), I);
        Item->SetStringField(TEXT("op"), (*OpObj)->GetStringField(TEXT("op")));
        FString NodeId;
        if (Res.Data->TryGetStringField(TEXT("node_id"), NodeId))
        {
            Item->SetStringField(TEXT("node_id"), NodeId);
            if (!Step.Ref.IsEmpty()) Refs.Add(Step.Ref, NodeId);
        }
        else if (!Step.Ref.IsEmpty())
        {
            FailedIndex = I;
            FailedError = FString::Printf(TEXT("ref '%s' was given but this op creates no node"), *Step.Ref);
            break;
        }
        Results.Add(MakeShared<FJsonValueObject>(Item));
        ++Applied;
    }
    bDeferStructuralMark = false;
    if (bStructuralPending) FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
    bStructuralPending = false;

    const bool bAllApplied = FailedIndex == INDEX_NONE;
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), bAllApplied);
    Out->SetNumberField(TEXT("applied"), Applied);
    Out->SetNumberField(TEXT("total"), Ops->Num());
    TSharedPtr<FJsonObject> RefJson = MakeShared<FJsonObject>();
    for (const TPair<FString, FString>& Pair : Refs) RefJson->SetStringField(Pair.Key, Pair.Value);
    Out->SetObjectField(TEXT("refs"), RefJson);
    Out->SetArrayField(TEXT("results"), Results);
    Out->SetStringField(TEXT("mutation_status"), Applied == 0 ? TEXT("not_started")
        : bAllApplied ? TEXT("applied_unsaved") : TEXT("partially_applied"));
    if (!bAllApplied)
    {
        Out->SetNumberField(TEXT("failed_index"), FailedIndex);
        Out->SetStringField(TEXT("error"), FString::Printf(TEXT("blueprint_graph_batch: op %d failed: %s"), FailedIndex, *FailedError));
        Out->SetStringField(TEXT("hint"), TEXT("Ops before failed_index are staged and stay. The batch is one editor transaction, so Ctrl+Z recovers; or fix the failing op and send only the remaining ops, using the node_ids in refs."));
    }
    // Compile only a fully applied batch: a half-built graph's compile errors would hide the real failure.
    if (bAllApplied && bCompile)
    {
        TSharedPtr<FJsonObject> CompileParams = MakeShared<FJsonObject>();
        CompileParams->SetStringField(TEXT("path"), Path);
        CompileParams->SetBoolField(TEXT("save"), bSave);
        const FHaybaHandlerResult Compiled = Compile(CompileParams);
        if (Compiled.bOk && Compiled.Data.IsValid()) Out->SetObjectField(TEXT("compile"), Compiled.Data);
        else Out->SetStringField(TEXT("compile_error"), Compiled.ErrorMessage);
    }
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

static TSharedPtr<FJsonValue> HaybaRectJson(const HaybaBlueprintOps::FNodeBox& B)
{
    return MakeShared<FJsonValueArray>(TArray<TSharedPtr<FJsonValue>>{ MakeShared<FJsonValueNumber>(B.X),
        MakeShared<FJsonValueNumber>(B.Y), MakeShared<FJsonValueNumber>(B.W), MakeShared<FJsonValueNumber>(B.H) });
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::MeasureNodes(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("blueprint_measure_nodes"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString GraphName = R.OptionalString(TEXT("graph_name"));
    const int32 Offset = R.OptionalIntInRange(TEXT("offset"), 0, 0, MAX_int32);
    const int32 Limit = R.OptionalIntInRange(TEXT("limit"), HaybaGraphPageMax, 1, HaybaGraphPageMax);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    UBlueprint* BP = nullptr;
    FString Error;
    UEdGraph* Graph = HaybaGraphForEdit(TEXT("blueprint_measure_nodes"), Path, GraphName, BP, Error);
    if (!Graph) return FHaybaHandlerResult::Err(Error);

    TMap<const UEdGraphNode*, HaybaBlueprintOps::FNodeBox> Boxes;
    const bool bMeasured = HaybaNodeBoxes(Graph, Boxes);
    TArray<const UEdGraphNode*> Items;
    TArray<HaybaBlueprintOps::FNodeBox> ItemBoxes;
    TArray<bool> IsComment;
    for (const UEdGraphNode* N : Graph->Nodes)
    {
        if (!N) continue;
        Items.Add(N);
        ItemBoxes.Add(Boxes.FindRef(N));
        IsComment.Add(N->IsA<UEdGraphNode_Comment>());
    }
    // Owners need every box; only the page is reported.
    const TArray<int32> Owners = HaybaBlueprintOps::AssignOwners(ItemBoxes, IsComment);
    int32 Begin, End;
    TSharedPtr<FJsonObject> Page = HaybaPage(Items.Num(), Offset, Limit, Begin, End);

    TArray<TSharedPtr<FJsonValue>> Nodes;
    for (int32 I = Begin; I < End; ++I)
    {
        TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("node_id"), Items[I]->NodeGuid.ToString());
        Item->SetStringField(TEXT("title"), Items[I]->GetNodeTitle(ENodeTitleType::ListView).ToString());
        Item->SetField(TEXT("rect"), HaybaRectJson(ItemBoxes[I]));
        Item->SetBoolField(TEXT("comment"), IsComment[I]);
        Item->SetStringField(TEXT("in_comment"), Owners[I] == INDEX_NONE ? FString() : Items[Owners[I]]->NodeGuid.ToString());
        Nodes.Add(MakeShared<FJsonValueObject>(Item));
    }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetBoolField(TEXT("measured"), bMeasured);
    Out->SetArrayField(TEXT("nodes"), Nodes);
    Out->SetNumberField(TEXT("node_count"), Items.Num());
    Out->SetObjectField(TEXT("page"), Page);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::FitComments(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("blueprint_fit_comments"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString GraphName = R.OptionalString(TEXT("graph_name"));
    const int32 Pad = R.OptionalIntInRange(TEXT("padding"), 40, 0, 1000);
    const int32 TitlePad = R.OptionalIntInRange(TEXT("title_pad"), -1, -1, 1000);
    const TArray<TSharedPtr<FJsonValue>>* OnlyIds = R.OptionalArray(TEXT("comment_ids"), 1024, 1);
    const TSharedPtr<FJsonObject> Members = R.OptionalObject(TEXT("members"), 512);
    const bool bResolve = R.OptionalBool(TEXT("resolve_overlaps"), false);
    const int32 Gap = R.OptionalIntInRange(TEXT("gap"), 60, 0, 2000);
    const bool bTitleOnly = R.OptionalBool(TEXT("title_only"), false);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    UBlueprint* BP = nullptr;
    FString Error;
    UEdGraph* Graph = HaybaGraphForEdit(TEXT("blueprint_fit_comments"), Path, GraphName, BP, Error);
    if (!Graph) return FHaybaHandlerResult::Err(Error);

    TMap<const UEdGraphNode*, HaybaBlueprintOps::FNodeBox> AllBoxes;
    const bool bMeasured = HaybaNodeBoxes(Graph, AllBoxes);
    TArray<UEdGraphNode*> Items;
    TArray<HaybaBlueprintOps::FNodeBox> Boxes;
    TArray<bool> IsComment;
    TMap<FString, int32> IndexOf;
    for (UEdGraphNode* N : Graph->Nodes)
    {
        if (!N) continue;
        IndexOf.Add(N->NodeGuid.ToString(), Items.Num());
        Items.Add(N);
        Boxes.Add(AllBoxes.FindRef(N));
        IsComment.Add(N->IsA<UEdGraphNode_Comment>());
    }

    // Membership: explicit `members` first, then the editor's own grouping, then geometry.
    TArray<int32> Owners = HaybaBlueprintOps::AssignOwners(Boxes, IsComment);
    for (int32 C = 0; C < Items.Num(); ++C)
    {
        if (!IsComment[C]) continue;
        const UEdGraphNode_Comment* Comment = CastChecked<UEdGraphNode_Comment>(Items[C]);
        const TArray<TSharedPtr<FJsonValue>>* Explicit = nullptr;
        if (Members.IsValid() && Members->TryGetArrayField(Comment->NodeGuid.ToString(), Explicit))
        {
            for (int32 I = 0; I < Owners.Num(); ++I) if (Owners[I] == C) Owners[I] = INDEX_NONE;
            for (const TSharedPtr<FJsonValue>& V : *Explicit)
            {
                const int32* Index = V.IsValid() ? IndexOf.Find(V->AsString()) : nullptr;
                if (!Index || *Index == C)
                    return FHaybaHandlerResult::Err(FString::Printf(
                        TEXT("blueprint_fit_comments: members of %s names '%s', which is not another node in this graph; nothing was changed"),
                        *Comment->NodeGuid.ToString(), V.IsValid() ? *V->AsString() : TEXT("?")));
                Owners[*Index] = C;
            }
            continue;
        }
        for (UObject* Under : Comment->GetNodesUnderComment())
        {
            if (const UEdGraphNode* UnderNode = Cast<UEdGraphNode>(Under))
                if (const int32* Index = IndexOf.Find(UnderNode->NodeGuid.ToString()); Index && *Index != C)
                    Owners[*Index] = C;
        }
    }

    TSet<int32> Wanted;
    if (OnlyIds)
    {
        for (const TSharedPtr<FJsonValue>& V : *OnlyIds)
        {
            const int32* Index = V.IsValid() ? IndexOf.Find(V->AsString()) : nullptr;
            if (!Index || !IsComment[*Index])
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("blueprint_fit_comments: '%s' is not a comment in this graph; nothing was changed"), V.IsValid() ? *V->AsString() : TEXT("?")));
            Wanted.Add(*Index);
        }
    }

    // Inner comments first, so an outer box encloses its fitted children.
    TArray<int32> Order;
    for (int32 I = 0; I < Items.Num(); ++I) if (IsComment[I]) Order.Add(I);
    Order.Sort([&Boxes](int32 A, int32 B)
    {
        return static_cast<int64>(Boxes[A].W) * Boxes[A].H < static_cast<int64>(Boxes[B].W) * Boxes[B].H;
    });
    const TArray<HaybaBlueprintOps::FNodeBox> Before = Boxes;
    TArray<TSharedPtr<FJsonValue>> Fitted, Skipped;
    int32 Verified = 0;
    for (const int32 C : Order)
    {
        if (OnlyIds && !Wanted.Contains(C)) continue;
        const UEdGraphNode_Comment* Comment = CastChecked<UEdGraphNode_Comment>(Items[C]);
        TArray<HaybaBlueprintOps::FNodeBox> MemberBoxes;
        for (int32 I = 0; I < Items.Num(); ++I) if (Owners[I] == C) MemberBoxes.Add(Boxes[I]);
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("node_id"), Comment->NodeGuid.ToString());
        Entry->SetStringField(TEXT("title"), Comment->NodeComment);
        if (MemberBoxes.Num() == 0)
        {
            Entry->SetStringField(TEXT("reason"), TEXT("no nodes start inside it and none were named in members"));
            Skipped.Add(MakeShared<FJsonValueObject>(Entry));
            continue;
        }
        Boxes[C] = HaybaBlueprintOps::CommentAround(MemberBoxes, Pad, TitlePad >= 0 ? TitlePad : Comment->FontSize * 2);
        Entry->SetField(TEXT("rect"), HaybaRectJson(Boxes[C]));
        Entry->SetNumberField(TEXT("members"), MemberBoxes.Num());
        Fitted.Add(MakeShared<FJsonValueObject>(Entry));
    }

    // Optionally move whole top-level groups down until no group box overlaps another
    // group or a loose node. Each group's members (nested comments too) move with it.
    int32 GroupsMoved = 0;
    if (bResolve)
    {
        TArray<int32> Tops;
        TArray<HaybaBlueprintOps::FNodeBox> Layout;
        TArray<bool> Movable;
        for (int32 I = 0; I < Items.Num(); ++I)
        {
            if (Owners[I] != INDEX_NONE) continue;
            Tops.Add(I);
            Layout.Add(Boxes[I]);
            Movable.Add(IsComment[I]);
        }
        GroupsMoved = HaybaBlueprintOps::PushApart(Layout, Movable, Gap);
        TMap<int32, int32> DeltaY;
        for (int32 T = 0; T < Tops.Num(); ++T) if (Layout[T].Y != Boxes[Tops[T]].Y) DeltaY.Add(Tops[T], Layout[T].Y - Boxes[Tops[T]].Y);
        for (int32 I = 0; I < Items.Num(); ++I)
        {
            int32 Root = I;
            for (int32 Guard = 0; Owners[Root] != INDEX_NONE && Guard < Items.Num(); ++Guard) Root = Owners[Root];
            if (const int32* Dy = DeltaY.Find(Root)) Boxes[I].Y += *Dy;
        }
    }

    // Apply. Only position and size change; colour and bubble flags are left as they are.
    Graph->Modify();
    int32 Changed = 0;
    for (int32 I = 0; I < Items.Num(); ++I)
    {
        UEdGraphNode* N = Items[I];
        UEdGraphNode_Comment* Comment = Cast<UEdGraphNode_Comment>(N);
        const bool bStrip = bTitleOnly && Comment
            && (Comment->NodeComment.Contains(TEXT("\n")) || !Comment->NodeDetails.IsEmpty());
        const bool bBoxChanged = Boxes[I].X != Before[I].X || Boxes[I].Y != Before[I].Y
            || (Comment && (Boxes[I].W != Before[I].W || Boxes[I].H != Before[I].H));
        if (!bBoxChanged && !bStrip) continue;
        N->Modify();
        if (bBoxChanged)
        {
            N->NodePosX = Boxes[I].X;
            N->NodePosY = Boxes[I].Y;
            if (Comment) { Comment->NodeWidth = Boxes[I].W; Comment->NodeHeight = Boxes[I].H; }
        }
        if (bStrip)
        {
            // The house rule: a comment box is its title. Keep the first line, drop the rest.
            FString FirstLine = Comment->NodeComment;
            int32 Break = INDEX_NONE;
            if (FirstLine.FindChar(TEXT('\n'), Break)) FirstLine.LeftInline(Break);
            Comment->NodeComment = FirstLine.TrimEnd();
            Comment->NodeDetails = FText::GetEmpty();
        }
        ++Changed;
    }
    for (int32 C = 0; C < Items.Num(); ++C)
    {
        if (!IsComment[C]) continue;
        UEdGraphNode_Comment* Comment = CastChecked<UEdGraphNode_Comment>(Items[C]);
        Comment->ClearNodesUnderComment();
        for (int32 I = 0; I < Items.Num(); ++I) if (Owners[I] == C) Comment->AddNodeUnderComment(Items[I]);
    }
    if (Changed > 0)
    {
        FBlueprintEditorUtils::MarkBlueprintAsModified(BP);
        Graph->NotifyGraphChanged();
    }

    // Readback: every fitted comment must now enclose every member it owns.
    for (const int32 C : Order)
    {
        if (OnlyIds && !Wanted.Contains(C)) continue;
        const HaybaBlueprintOps::FNodeBox Now{ Items[C]->NodePosX, Items[C]->NodePosY, Items[C]->NodeWidth, Items[C]->NodeHeight };
        bool bAll = true, bAny = false;
        for (int32 I = 0; I < Items.Num(); ++I)
        {
            if (Owners[I] != C) continue;
            bAny = true;
            HaybaBlueprintOps::FNodeBox Member = Boxes[I];
            Member.X = Items[I]->NodePosX;
            Member.Y = Items[I]->NodePosY;
            bAll &= HaybaBlueprintOps::Encloses(Now, Member);
        }
        if (bAny && bAll) ++Verified;
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("measured"), bMeasured);
    Out->SetArrayField(TEXT("fitted"), Fitted);
    Out->SetArrayField(TEXT("skipped"), Skipped);
    Out->SetNumberField(TEXT("changed"), Changed);
    Out->SetNumberField(TEXT("groups_moved"), GroupsMoved);
    Out->SetBoolField(TEXT("verified"), Verified == Fitted.Num());
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    if (!bMeasured)
        Out->SetStringField(TEXT("warning"), TEXT("Slate was unavailable, so node sizes were estimated, not measured; the boxes may still clip."));
    return FHaybaHandlerResult::Ok(Out);
}
