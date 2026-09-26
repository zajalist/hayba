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
#include "K2Node_ComponentBoundEvent.h"
#include "K2Node_ExecutionSequence.h"
#include "K2Node_Self.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_FunctionResult.h"
#include "K2Node_AddPinInterface.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "Blueprint/UserWidget.h"
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
        TEXT("blueprint_add_custom_event"),
        TEXT("blueprint_add_bound_event"),
        TEXT("blueprint_remove_node"),
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
        TEXT("blueprint_add_custom_event"), TEXT("blueprint_add_bound_event"),
        TEXT("blueprint_remove_node"),
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
    if (Cmd == TEXT("blueprint_inspect_graph"))  return InspectGraph(P);
    if (Cmd == TEXT("blueprint_add_event"))      return AddEvent(P);
    if (Cmd == TEXT("blueprint_set_defaults"))   return SetDefaults(P);
    if (Cmd == TEXT("blueprint_set_pin_default")) return SetPinDefault(P);
    if (Cmd == TEXT("blueprint_add_custom_event")) return AddCustomEvent(P);
    if (Cmd == TEXT("blueprint_add_bound_event")) return AddBoundEvent(P);
    if (Cmd == TEXT("blueprint_remove_node"))    return RemoveNode(P);
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

/** Turn a parsed type into the pin type the editor builds variables, function
 *  parameters and event inputs from. The parse is pure (HaybaBlueprintOps); this
 *  half loads the class/struct/enum a reference names, so a typo fails here with
 *  the path in the message instead of compiling into a wildcard pin. */
static bool HaybaMakePinType(const HaybaBlueprintOps::FTypeSpec& Spec, FEdGraphPinType& Out, FString& OutError)
{
    using HaybaBlueprintOps::ETypeKind;
    Out = FEdGraphPinType();
    switch (Spec.Kind)
    {
    case ETypeKind::Bool:   Out.PinCategory = UEdGraphSchema_K2::PC_Boolean; break;
    case ETypeKind::Int:    Out.PinCategory = UEdGraphSchema_K2::PC_Int; break;
    case ETypeKind::Int64:  Out.PinCategory = UEdGraphSchema_K2::PC_Int64; break;
    case ETypeKind::Real:
        Out.PinCategory = UEdGraphSchema_K2::PC_Real;
        Out.PinSubCategory = UEdGraphSchema_K2::PC_Double;
        break;
    case ETypeKind::String: Out.PinCategory = UEdGraphSchema_K2::PC_String; break;
    case ETypeKind::Name:   Out.PinCategory = UEdGraphSchema_K2::PC_Name; break;
    case ETypeKind::Text:   Out.PinCategory = UEdGraphSchema_K2::PC_Text; break;
    case ETypeKind::Byte:   Out.PinCategory = UEdGraphSchema_K2::PC_Byte; break;
    case ETypeKind::Enum:
    {
        UEnum* Enum = LoadObject<UEnum>(nullptr, *Spec.ObjectPath);
        if (!Enum) { OutError = FString::Printf(TEXT("no enum at '%s'"), *Spec.ObjectPath); return false; }
        Out.PinCategory = UEdGraphSchema_K2::PC_Byte;
        Out.PinSubCategoryObject = Enum;
        break;
    }
    case ETypeKind::Struct:
    {
        UScriptStruct* Struct = LoadObject<UScriptStruct>(nullptr, *Spec.ObjectPath);
        if (!Struct) { OutError = FString::Printf(TEXT("no struct at '%s'"), *Spec.ObjectPath); return false; }
        Out.PinCategory = UEdGraphSchema_K2::PC_Struct;
        Out.PinSubCategoryObject = Struct;
        break;
    }
    case ETypeKind::Object:
    case ETypeKind::Class:
    case ETypeKind::SoftObject:
    case ETypeKind::SoftClass:
    {
        UClass* Class = LoadObject<UClass>(nullptr, *Spec.ObjectPath);
        if (!Class) { Class = LoadClass<UObject>(nullptr, *Spec.ObjectPath); }
        if (!Class)
        {
            OutError = FString::Printf(
                TEXT("no class at '%s' (a Blueprint class path ends in _C, e.g. /Game/UI/WBP_Menu.WBP_Menu_C)"), *Spec.ObjectPath);
            return false;
        }
        Out.PinCategory = Spec.Kind == ETypeKind::Object     ? UEdGraphSchema_K2::PC_Object
                        : Spec.Kind == ETypeKind::Class      ? UEdGraphSchema_K2::PC_Class
                        : Spec.Kind == ETypeKind::SoftObject ? UEdGraphSchema_K2::PC_SoftObject
                                                             : UEdGraphSchema_K2::PC_SoftClass;
        Out.PinSubCategoryObject = Class;
        break;
    }
    default:
        OutError = TEXT("type did not parse");
        return false;
    }
    if (Spec.bArray) Out.ContainerType = EPinContainerType::Array;
    return true;
}

/** One declared parameter of a function or custom event. */
struct FHaybaParamDecl
{
    FString Name;
    FString TypeSpec;
    FEdGraphPinType PinType;
};

/** Read `Field` as an array of {name, type}, parse and resolve every type, and
 *  check the names. Returns an error and fills nothing usable on the first
 *  problem, so a caller can refuse before touching the blueprint. An absent
 *  field is an empty list. */
static FString HaybaReadParamDecls(const TSharedPtr<FJsonObject>& P, const TCHAR* Command, const TCHAR* Field,
                                   TArray<FHaybaParamDecl>& Out)
{
    Out.Reset();
    if (!P.IsValid() || !P->HasField(Field)) return FString();
    const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
    if (!P->TryGetArrayField(Field, Items) || !Items)
        return FString::Printf(TEXT("%s: '%s' must be an array of {\"name\", \"type\"} objects; nothing was changed."), Command, Field);
    if (Items->Num() > 32)
        return FString::Printf(TEXT("%s: '%s' has %d entries; 32 is the limit. Nothing was changed."), Command, Field, Items->Num());

    for (int32 I = 0; I < Items->Num(); ++I)
    {
        const TSharedPtr<FJsonObject>* Item = nullptr;
        FString Name, Type;
        if (!(*Items)[I].IsValid() || !(*Items)[I]->TryGetObject(Item) || !Item
            || !(*Item)->TryGetStringField(TEXT("name"), Name) || !(*Item)->TryGetStringField(TEXT("type"), Type))
        {
            return FString::Printf(TEXT("%s: %s[%d] must be {\"name\": string, \"type\": string}; nothing was changed."), Command, Field, I);
        }
        const HaybaBlueprintOps::FTypeSpec Spec = HaybaBlueprintOps::ParseTypeSpec(Type);
        FEdGraphPinType PinType;
        FString ResolveError = Spec.Error;
        if (!Spec.IsValid() || !HaybaMakePinType(Spec, PinType, ResolveError))
        {
            return FString::Printf(TEXT("%s: %s[%d] '%s': %s Nothing was changed."), Command, Field, I, *Name, *ResolveError);
        }
        Out.Add({ Name.TrimStartAndEnd(), Type, PinType });
    }
    return FString();
}

/** The parameter list the COMPILED function really has — read from the UFunction,
 *  not echoed from the request, so a pin the editor renamed or dropped shows. */
static TSharedPtr<FJsonObject> HaybaDescribeSignature(const UFunction* Fn)
{
    TSharedPtr<FJsonObject> Sig = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Inputs, Outputs;
    if (Fn)
    {
        for (TFieldIterator<FProperty> It(Fn); It && It->HasAnyPropertyFlags(CPF_Parm); ++It)
        {
            // Function libraries carry a hidden world-context parameter.
            if (It->GetName().StartsWith(TEXT("__"))) continue;
            TSharedPtr<FJsonObject> Param = MakeShared<FJsonObject>();
            Param->SetStringField(TEXT("name"), It->GetName());
            Param->SetStringField(TEXT("type"), It->GetCPPType());
            const bool bOutput = It->HasAnyPropertyFlags(CPF_OutParm | CPF_ReturnParm)
                && !It->HasAnyPropertyFlags(CPF_ReferenceParm);
            (bOutput ? Outputs : Inputs).Add(MakeShared<FJsonValueObject>(Param));
        }
    }
    Sig->SetArrayField(TEXT("inputs"), Inputs);
    Sig->SetArrayField(TEXT("outputs"), Outputs);
    Sig->SetBoolField(TEXT("pure"), Fn && Fn->HasAnyFunctionFlags(FUNC_BlueprintPure));
    return Sig;
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

    // A function library is a different kind of blueprint, not a normal one with a
    // library parent: only BPTYPE_FunctionLibrary makes its functions static with a
    // world-context pin, so they can be called from anywhere. Created as a normal
    // blueprint it compiles, looks right, and its functions need a target instance.
    const EBlueprintType BlueprintType = ParentClass->IsChildOf(UBlueprintFunctionLibrary::StaticClass())
        ? BPTYPE_FunctionLibrary
        : BPTYPE_Normal;
    UBlueprint* BP = FKismetEditorUtilities::CreateBlueprint(
        ParentClass, Package, *Name, BlueprintType,
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
    // Read back from the asset rather than echoing the decision above.
    Out->SetStringField(TEXT("blueprint_type"),
        BP->BlueprintType == BPTYPE_FunctionLibrary ? TEXT("function_library") : TEXT("normal"));
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
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

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

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddVariable(const TSharedPtr<FJsonObject>& P)
{
    FString Path, VarName, VarType;
    FHaybaParamReader ParamR(P, TEXT("blueprint_add_variable"));
    Path = ParamR.RequiredString(TEXT("path"));
    VarName = ParamR.RequiredString(TEXT("variable_name"));
    VarType = ParamR.RequiredString(TEXT("variable_type"));
    const FString DefaultValue = ParamR.OptionalString(TEXT("default_value"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_add_variable"), Path));

    // One grammar for variables, function parameters and event inputs, so a type
    // that works in one place works in all of them.
    const HaybaBlueprintOps::FTypeSpec Spec = HaybaBlueprintOps::ParseTypeSpec(VarType);
    FEdGraphPinType PinType;
    FString TypeError = Spec.Error;
    if (!Spec.IsValid() || !HaybaMakePinType(Spec, PinType, TypeError))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_variable: variable_type '%s': %s Nothing was changed."), *VarType, *TypeError));

    for (const FBPVariableDescription& Existing : BP->NewVariables)
    {
        if (Existing.VarName.ToString().Equals(VarName, ESearchCase::IgnoreCase))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_add_variable: variable '%s' already exists; nothing was changed"), *VarName));
    }

    bool bAdded = FBlueprintEditorUtils::AddMemberVariable(BP, FName(*VarName), PinType, DefaultValue);
    if (!bAdded) return FHaybaHandlerResult::Err(TEXT("blueprint_add_variable: AddMemberVariable failed"));

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("variable_name"), VarName);
    Out->SetStringField(TEXT("type"), VarType);
    AttachCompileReport(Out, bClean, Errors, Warnings);
    // Verified means the variable exists with the type that was asked for — and,
    // when a default was given, that the default is the one stored.
    bool bVerified = false;
    for (const FBPVariableDescription& Current : BP->NewVariables)
    {
        if (Current.VarName != FName(*VarName)) continue;
        bVerified = Current.VarType == PinType && (DefaultValue.IsEmpty() || Current.DefaultValue == DefaultValue);
        Out->SetStringField(TEXT("pin_category"), Current.VarType.PinCategory.ToString());
        Out->SetBoolField(TEXT("is_array"), Current.VarType.IsArray());
        if (Current.VarType.PinSubCategoryObject.IsValid())
            Out->SetStringField(TEXT("resolved_type"), Current.VarType.PinSubCategoryObject->GetPathName());
        if (!Current.DefaultValue.IsEmpty()) Out->SetStringField(TEXT("default_value"), Current.DefaultValue);
        break;
    }
    Out->SetBoolField(TEXT("verified"), bVerified);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddFunction(const TSharedPtr<FJsonObject>& P)
{
    FString Path, FuncName;
    FHaybaParamReader ParamR(P, TEXT("blueprint_add_function"));
    Path = ParamR.RequiredString(TEXT("path"));
    FuncName = ParamR.RequiredString(TEXT("function_name"));
    const bool bPure = ParamR.OptionalBool(TEXT("pure"), false);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    // The whole signature is checked before the graph exists: a function created
    // and then left without its parameters is a worse outcome than a refusal.
    TArray<FHaybaParamDecl> Inputs, Outputs;
    {
        FString Problem = HaybaReadParamDecls(P, TEXT("blueprint_add_function"), TEXT("inputs"), Inputs);
        if (Problem.IsEmpty()) Problem = HaybaReadParamDecls(P, TEXT("blueprint_add_function"), TEXT("outputs"), Outputs);
        if (!Problem.IsEmpty()) return FHaybaHandlerResult::Err(Problem);
        // Inputs and outputs become properties of one UFunction, so they share a namespace.
        TArray<FString> Names;
        for (const FHaybaParamDecl& D : Inputs) Names.Add(D.Name);
        for (const FHaybaParamDecl& D : Outputs) Names.Add(D.Name);
        const FString NameProblem = HaybaBlueprintOps::ParamNamesProblem(Names);
        if (!NameProblem.IsEmpty())
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("blueprint_add_function: %s Nothing was changed."), *NameProblem));
    }

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

    UEdGraph* NewGraph = FBlueprintEditorUtils::CreateNewGraph(
        BP, FName(*FuncName), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
    if (!NewGraph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_function: CreateNewGraph failed"));

    FBlueprintEditorUtils::AddFunctionGraph<UClass>(BP, NewGraph, /*bIsUserCreated*/true, nullptr);

    // The signature lives on the terminator nodes: inputs are outputs of the entry
    // node, outputs are inputs of the result node.
    TArray<UK2Node_FunctionEntry*> Entries;
    NewGraph->GetNodesOfClass(Entries);
    UK2Node_FunctionEntry* Entry = Entries.Num() > 0 ? Entries[0] : nullptr;
    UK2Node_FunctionResult* Result = nullptr;
    if (Entry)
    {
        for (const FHaybaParamDecl& D : Inputs)
            Entry->CreateUserDefinedPin(FName(*D.Name), D.PinType, EGPD_Output, /*bUseUniqueName*/ false);
        if (Outputs.Num() > 0)
        {
            Result = FBlueprintEditorUtils::FindOrCreateFunctionResultNode(Entry);
            if (Result)
            {
                for (const FHaybaParamDecl& D : Outputs)
                    Result->CreateUserDefinedPin(FName(*D.Name), D.PinType, EGPD_Input, /*bUseUniqueName*/ false);
            }
        }
        if (bPure) Entry->AddExtraFlags(FUNC_BlueprintPure);
        FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
    }

    TArray<FString> Errors, Warnings;
    const bool bClean = RecompileAndTrack(BP, Errors, Warnings);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("function_name"), FuncName);
    AttachCompileReport(Out, bClean, Errors, Warnings);
    bool bGraphExists = false;
    for (const UEdGraph* Current : BP->FunctionGraphs)
        if (Current && Current->GetFName() == FName(*FuncName)) { bGraphExists = true; break; }

    // Verified means the compiled function has every parameter that was asked for,
    // on the side it was asked for, and the purity asked for — read from the class.
    const UFunction* Compiled = BP->GeneratedClass ? BP->GeneratedClass->FindFunctionByName(FName(*FuncName)) : nullptr;
    const TSharedPtr<FJsonObject> Signature = HaybaDescribeSignature(Compiled);
    auto HasAll = [&Signature](const TCHAR* Side, const TArray<FHaybaParamDecl>& Wanted)
    {
        const TArray<TSharedPtr<FJsonValue>>& Have = Signature->GetArrayField(Side);
        if (Have.Num() != Wanted.Num()) return false;
        for (const FHaybaParamDecl& D : Wanted)
        {
            bool bFound = false;
            for (const TSharedPtr<FJsonValue>& V : Have)
                if (V->AsObject()->GetStringField(TEXT("name")).Equals(D.Name, ESearchCase::IgnoreCase)) { bFound = true; break; }
            if (!bFound) return false;
        }
        return true;
    };
    const bool bSignatureMatches = Compiled && HasAll(TEXT("inputs"), Inputs) && HasAll(TEXT("outputs"), Outputs)
        && Compiled->HasAnyFunctionFlags(FUNC_BlueprintPure) == bPure;
    Out->SetObjectField(TEXT("signature"), Signature);
    if (Entry) Out->SetStringField(TEXT("entry_node_id"), Entry->NodeGuid.ToString());
    if (Result) Out->SetStringField(TEXT("result_node_id"), Result->NodeGuid.ToString());
    Out->SetBoolField(TEXT("verified"), bGraphExists && bSignatureMatches);
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
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    static const TSet<FString> SupportedNodeTypes = {
        TEXT("call_function"), TEXT("branch"), TEXT("select"), TEXT("timer_by_function"),
        TEXT("variable_get"), TEXT("variable_set"), TEXT("cast"),
        TEXT("sequence"), TEXT("self"), TEXT("create_widget")
    };
    if (!SupportedNodeTypes.Contains(NodeType))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_node: unknown node_type '%s'. Supported: %s. Nothing was changed."),
            *NodeType, *FString::Join(SupportedNodeTypes.Array(), TEXT(", "))));
    }

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_add_node"), Path));

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
        FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
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

    // Nodes that grow pins after placement are described again, so the caller
    // gets the pins that now exist rather than the defaults they started with.
    auto Redescribe = [&](FHaybaHandlerResult Placed, UK2Node* Node) -> FHaybaHandlerResult
    {
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
    };

    if (NodeType.Equals(TEXT("select"), ESearchCase::IgnoreCase))
    {
        UK2Node_Select* Node = NewObject<UK2Node_Select>(Graph);
        FHaybaHandlerResult Placed = Place(Node);
        for (int32 I = 2; I < OptionCount && Node->CanAddPin(); ++I) Node->AddInputPin();
        return Redescribe(Placed, Node);
    }

    if (NodeType.Equals(TEXT("sequence"), ESearchCase::IgnoreCase))
    {
        // option_count is the number of `then_N` outputs. Grown through the
        // add-pin interface: the node's own AddInputPin is not exported.
        UK2Node_ExecutionSequence* Node = NewObject<UK2Node_ExecutionSequence>(Graph);
        FHaybaHandlerResult Placed = Place(Node);
        if (IK2Node_AddPinInterface* AddPins = Cast<IK2Node_AddPinInterface>(Node))
        {
            for (int32 I = 2; I < OptionCount && AddPins->CanAddPin(); ++I) AddPins->AddInputPin();
        }
        return Redescribe(Placed, Node);
    }

    if (NodeType.Equals(TEXT("self"), ESearchCase::IgnoreCase))
    {
        return Place(NewObject<UK2Node_Self>(Graph));
    }

    if (NodeType.Equals(TEXT("create_widget"), ESearchCase::IgnoreCase))
    {
        if (ClassPath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: create_widget needs class_path — the widget class, e.g. /Game/UI/WBP_Menu.WBP_Menu_C. Nothing was changed."));
        UClass* WidgetClass = LoadObject<UClass>(nullptr, *ClassPath);
        if (!WidgetClass) { WidgetClass = LoadClass<UObject>(nullptr, *ClassPath); }
        if (!WidgetClass || !WidgetClass->IsChildOf(UUserWidget::StaticClass()))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_add_node: create_widget class '%s' is not a loadable UserWidget class (a Widget Blueprint's class ends in _C). Nothing was changed."),
                *ClassPath));
        // The node class lives in UMGEditor's private headers, so it is created
        // through reflection and driven through the base-node API.
        UClass* NodeClass = LoadObject<UClass>(nullptr, TEXT("/Script/UMGEditor.K2Node_CreateWidget"));
        if (!NodeClass || !NodeClass->IsChildOf(UK2Node::StaticClass()))
            return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: the Create Widget node class (UMGEditor) is not loaded. Nothing was changed."));
        UK2Node* Node = NewObject<UK2Node>(Graph, NodeClass);
        FHaybaHandlerResult Placed = Place(Node);
        // Setting the class pin is what the editor does when a class is picked:
        // the node rebuilds its return pin to the chosen type.
        if (UEdGraphPin* ClassPin = Node->FindPin(TEXT("Class"), EGPD_Input))
        {
            GetDefault<UEdGraphSchema_K2>()->TrySetDefaultObject(*ClassPin, WidgetClass);
        }
        UEdGraphPin* ReturnPin = Node->FindPin(UEdGraphSchema_K2::PN_ReturnValue, EGPD_Output);
        if (ReturnPin && ReturnPin->PinType.PinSubCategoryObject != WidgetClass)
        {
            Node->ReconstructNode();
            ReturnPin = Node->FindPin(UEdGraphSchema_K2::PN_ReturnValue, EGPD_Output);
        }
        FHaybaHandlerResult Described = Redescribe(Placed, Node);
        if (Described.Data.IsValid())
        {
            const UObject* Returned = ReturnPin ? ReturnPin->PinType.PinSubCategoryObject.Get() : nullptr;
            Described.Data->SetStringField(TEXT("return_class"), Returned ? Returned->GetPathName() : TEXT(""));
            Described.Data->SetBoolField(TEXT("verified"), Graph->Nodes.Contains(Node) && Returned == WidgetClass);
        }
        return Described;
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

        UClass* VarScope = BP->SkeletonGeneratedClass ? BP->SkeletonGeneratedClass.Get() : BP->GeneratedClass.Get();
        if (!VarScope || !FindFProperty<FProperty>(VarScope, FName(*VarName)))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_add_node: no variable '%s' on this blueprint. Create it with blueprint_add_variable."),
                *VarName));
        }

        if (NodeType.Equals(TEXT("variable_get"), ESearchCase::IgnoreCase))
        {
            UK2Node_VariableGet* Node = NewObject<UK2Node_VariableGet>(Graph);
            Node->VariableReference.SetSelfMember(FName(*VarName));
            return Place(Node);
        }
        UK2Node_VariableSet* Node = NewObject<UK2Node_VariableSet>(Graph);
        Node->VariableReference.SetSelfMember(FName(*VarName));
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

    UK2Node_CallFunction* Node = NewObject<UK2Node_CallFunction>(Graph);
    Node->CreateNewGuid();
    Node->SetFromFunction(Fn);
    Node->NodePosX = NX;
    Node->NodePosY = NY;
    Graph->AddNode(Node, false, false);
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

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

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

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

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

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

FHaybaHandlerResult FHaybaMCPBlueprintHandler::InspectGraph(const TSharedPtr<FJsonObject>& P)
{
    FString Path, GraphName;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty()) return FHaybaHandlerResult::Err(TEXT("blueprint_inspect_graph: missing path"));
    P->TryGetStringField(TEXT("graph_name"), GraphName);
    UBlueprint* BP = LoadBPByPath(Path); if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_inspect_graph"), Path));
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName); if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_inspect_graph: graph not found"));
    TArray<TSharedPtr<FJsonValue>> Nodes, Edges;
    for (UEdGraphNode* Node : Graph->Nodes)
    {
        Nodes.Add(MakeShared<FJsonValueObject>(HaybaDescribeNode(Node).ToSharedRef()));
        for (UEdGraphPin* Pin : Node->Pins)
        {
            if (!Pin || Pin->Direction != EGPD_Output) continue;
            for (UEdGraphPin* Linked : Pin->LinkedTo)
            {
                if (!Linked) continue;
                TSharedPtr<FJsonObject> Edge=MakeShared<FJsonObject>(); Edge->SetStringField(TEXT("from_node"),Node->NodeGuid.ToString()); Edge->SetStringField(TEXT("from_pin"),Pin->PinName.ToString()); Edge->SetStringField(TEXT("to_node"),Linked->GetOwningNode()->NodeGuid.ToString()); Edge->SetStringField(TEXT("to_pin"),Linked->PinName.ToString()); Edges.Add(MakeShared<FJsonValueObject>(Edge.ToSharedRef()));
            }
        }
    }
    TSharedPtr<FJsonObject> Out=MakeShared<FJsonObject>(); Out->SetStringField(TEXT("path"),BP->GetPathName()); Out->SetStringField(TEXT("graph"),Graph->GetName()); Out->SetArrayField(TEXT("nodes"),Nodes); Out->SetArrayField(TEXT("edges"),Edges); Out->SetNumberField(TEXT("node_count"),Nodes.Num()); Out->SetNumberField(TEXT("edge_count"),Edges.Num()); Out->SetBoolField(TEXT("dirty"),BP->GetOutermost()->IsDirty()); return FHaybaHandlerResult::Ok(Out);
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
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_event: graph not found"));

    UClass* ParentClass = BP->ParentClass.Get();
    // "BeginPlay" is what the node says; "ReceiveBeginPlay" is the UFunction.
    const FString FunctionName = HaybaBlueprintOps::CanonicalEventFunctionName(EventName);
    UFunction* EventFn = ParentClass ? ParentClass->FindFunctionByName(FName(*FunctionName)) : nullptr;
    if (!EventFn)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_event: no overridable event '%s' (looked up as '%s') on %s. For your own events use blueprint_add_custom_event; for a button click use ui_bind_event."),
            *EventName, *FunctionName, ParentClass ? *ParentClass->GetName() : TEXT("<null>")));
    }

    for (UEdGraphNode* N : Graph->Nodes)
    {
        UK2Node_Event* Existing = Cast<UK2Node_Event>(N);
        if (Existing && Existing->EventReference.GetMemberName() == EventFn->GetFName())
        {
            TSharedPtr<FJsonObject> Found = HaybaDescribeNode(Existing);
            Found->SetStringField(TEXT("event_function"), EventFn->GetName());
            Found->SetBoolField(TEXT("already_existed"), true);
            // A new blueprint's default events are disabled "ghost" nodes. Wiring a
            // pin enables one; until then it will not run, so say which it is.
            Found->SetBoolField(TEXT("enabled"), !Existing->IsAutomaticallyPlacedGhostNode());
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

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TSharedPtr<FJsonObject> Out = HaybaDescribeNode(Node);
    Out->SetStringField(TEXT("event_function"), EventFn->GetName());
    Out->SetBoolField(TEXT("already_existed"), false);
    Out->SetBoolField(TEXT("enabled"), Node->IsNodeEnabled());
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
// Events a graph can be entered through, and removing what was placed wrong.
//
// Without these a Blueprint could only start from the default BeginPlay/Tick
// nodes: no custom event for a timer to call, no button click, no way to take
// back a mistaken node. The Pallbearer title menu polled its Start button on
// Tick for exactly that reason.
// ---------------------------------------------------------------------------

/** Event graphs only: events, bound events and timers cannot live in a function graph. */
static bool HaybaIsEventGraph(const UBlueprint* BP, const UEdGraph* Graph)
{
    return BP && Graph && BP->UbergraphPages.Contains(Graph);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddCustomEvent(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("blueprint_add_custom_event"));
    const FString Path = ParamR.RequiredString(TEXT("path"));
    const FString EventName = ParamR.RequiredString(TEXT("event_name"), 128).TrimStartAndEnd();
    const FString GraphName = ParamR.OptionalString(TEXT("graph_name"));
    const int32 X = ParamR.OptionalInt(TEXT("x"));
    const int32 Y = ParamR.OptionalInt(TEXT("y"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    TArray<FHaybaParamDecl> Inputs;
    {
        const FString Problem = HaybaReadParamDecls(P, TEXT("blueprint_add_custom_event"), TEXT("inputs"), Inputs);
        if (!Problem.IsEmpty()) return FHaybaHandlerResult::Err(Problem);
        TArray<FString> Names;
        for (const FHaybaParamDecl& D : Inputs) Names.Add(D.Name);
        const FString NameProblem = HaybaBlueprintOps::ParamNamesProblem(Names);
        if (!NameProblem.IsEmpty())
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("blueprint_add_custom_event: %s Nothing was changed."), *NameProblem));
    }

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_add_custom_event"), Path));
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_custom_event: graph not found"));
    if (!HaybaIsEventGraph(BP, Graph))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_custom_event: '%s' is a function graph; custom events live in an event graph. Omit graph_name for the main one. Nothing was changed."),
            *Graph->GetName()));

    // The name must be free across every event, function and graph, including
    // inherited functions — a clash compiles to "already in use" and breaks the
    // blueprint rather than failing here.
    {
        TArray<UEdGraph*> AllGraphs;
        BP->GetAllGraphs(AllGraphs);
        TArray<FString> Taken;
        for (const UEdGraph* G : AllGraphs)
        {
            if (!G) continue;
            Taken.Add(G->GetName());
            for (const UEdGraphNode* N : G->Nodes)
            {
                if (const UK2Node_CustomEvent* E = Cast<UK2Node_CustomEvent>(N)) Taken.Add(E->CustomFunctionName.ToString());
            }
        }
        const UClass* Parent = BP->ParentClass.Get();
        if (Parent && Parent->FindFunctionByName(FName(*EventName))) Taken.Add(EventName);
        for (const FString& Existing : Taken)
        {
            if (Existing.Equals(EventName, ESearchCase::IgnoreCase))
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("blueprint_add_custom_event: '%s' is already used on this blueprint (as '%s'); two events or functions cannot share a name. Nothing was changed."),
                    *EventName, *Existing));
        }
    }

    BP->Modify();
    Graph->Modify();
    UK2Node_CustomEvent* Node = NewObject<UK2Node_CustomEvent>(Graph);
    Node->CustomFunctionName = FName(*EventName);
    Node->CreateNewGuid();
    Node->NodePosX = X;
    Node->NodePosY = Y;
    Graph->AddNode(Node, false, false);
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();
    // An event's parameters are OUTPUT pins on its node — data flows out of it.
    for (const FHaybaParamDecl& D : Inputs)
        Node->CreateUserDefinedPin(FName(*D.Name), D.PinType, EGPD_Output, /*bUseUniqueName*/ false);
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    bool bVerified = Graph->Nodes.Contains(Node) && Node->CustomFunctionName == FName(*EventName);
    for (const FHaybaParamDecl& D : Inputs)
        bVerified = bVerified && Node->FindPin(FName(*D.Name), EGPD_Output) != nullptr;

    TSharedPtr<FJsonObject> Out = HaybaDescribeNode(Node);
    Out->SetStringField(TEXT("event_name"), Node->CustomFunctionName.ToString());
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetBoolField(TEXT("verified"), bVerified);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("note"),
        TEXT("Staged. Call blueprint_compile to apply. Its OutputDelegate pin feeds a Set Timer by Event node; blueprint_add_node call_function can call it by name."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddBoundEvent(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("blueprint_add_bound_event"));
    const FString Path = ParamR.RequiredString(TEXT("path"));
    const FString Target = ParamR.RequiredString(TEXT("target"), 256);
    const FString EventName = ParamR.RequiredString(TEXT("event_name"), 256);
    const FString GraphName = ParamR.OptionalString(TEXT("graph_name"));
    const int32 X = ParamR.OptionalInt(TEXT("x"));
    const int32 Y = ParamR.OptionalInt(TEXT("y"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_add_bound_event"), Path));

    // A bound event addresses its source through a property of the class: a
    // component variable, or a widget marked Is Variable. Without one there is
    // nothing for the node to bind to.
    UClass* Scope = BP->SkeletonGeneratedClass ? BP->SkeletonGeneratedClass.Get() : BP->GeneratedClass.Get();
    FObjectProperty* SourceProperty = Scope ? FindFProperty<FObjectProperty>(Scope, FName(*Target)) : nullptr;
    if (!SourceProperty || !SourceProperty->PropertyClass)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_bound_event: '%s' has no component or widget variable named '%s'. For a widget, expose it with ui_set_variable and compile first; for a component, check blueprint_get_info. Nothing was changed."),
            *BP->GetName(), *Target));
    }

    UClass* SourceClass = SourceProperty->PropertyClass;
    FMulticastDelegateProperty* Delegate = FindFProperty<FMulticastDelegateProperty>(SourceClass, FName(*EventName));
    if (!Delegate || !Delegate->HasAnyPropertyFlags(CPF_BlueprintAssignable))
    {
        TArray<FString> Bindable;
        for (TFieldIterator<FMulticastDelegateProperty> It(SourceClass); It; ++It)
        {
            if (It->HasAnyPropertyFlags(CPF_BlueprintAssignable)) Bindable.Add(It->GetName());
        }
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_bound_event: '%s' (%s) has no event '%s'. Bindable events: %s. Nothing was changed."),
            *Target, *SourceClass->GetName(), *EventName,
            Bindable.Num() > 0 ? *FString::Join(Bindable, TEXT(" ")) : TEXT("(none)")));
    }

    // Binding twice is a compile error ("event already bound"), so a repeat call
    // returns the node that already exists instead of stacking a second one.
    if (const UK2Node_ComponentBoundEvent* Existing =
            FKismetEditorUtilities::FindBoundEventForComponent(BP, Delegate->GetFName(), SourceProperty->GetFName()))
    {
        TSharedPtr<FJsonObject> Found = HaybaDescribeNode(const_cast<UK2Node_ComponentBoundEvent*>(Existing));
        Found->SetStringField(TEXT("target"), SourceProperty->GetName());
        Found->SetStringField(TEXT("event_name"), Delegate->GetName());
        if (const UEdGraph* ExistingGraph = Existing->GetGraph()) Found->SetStringField(TEXT("graph"), ExistingGraph->GetName());
        Found->SetBoolField(TEXT("already_existed"), true);
        Found->SetBoolField(TEXT("verified"), true);
        Found->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
        return FHaybaHandlerResult::Ok(Found);
    }

    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_add_bound_event: graph not found"));
    if (!HaybaIsEventGraph(BP, Graph))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_add_bound_event: '%s' is a function graph; bound events live in an event graph. Omit graph_name for the main one. Nothing was changed."),
            *Graph->GetName()));

    BP->Modify();
    Graph->Modify();
    UK2Node_ComponentBoundEvent* Node = NewObject<UK2Node_ComponentBoundEvent>(Graph);
    Node->InitializeComponentBoundEventParams(SourceProperty, Delegate);
    Node->CreateNewGuid();
    Node->NodePosX = X;
    Node->NodePosY = Y;
    Graph->AddNode(Node, false, false);
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TSharedPtr<FJsonObject> Out = HaybaDescribeNode(Node);
    Out->SetStringField(TEXT("target"), SourceProperty->GetName());
    Out->SetStringField(TEXT("event_name"), Delegate->GetName());
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetBoolField(TEXT("already_existed"), false);
    Out->SetBoolField(TEXT("verified"), Graph->Nodes.Contains(Node)
        && Node->DelegatePropertyName == Delegate->GetFName()
        && Node->ComponentPropertyName == SourceProperty->GetFName());
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("note"), TEXT("Staged. Wire its 'then' pin, then call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::RemoveNode(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("blueprint_remove_node"));
    const FString Path = ParamR.RequiredString(TEXT("path"));
    const FString NodeId = ParamR.RequiredString(TEXT("node_id"), 64);
    const FString GraphName = ParamR.OptionalString(TEXT("graph_name"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_remove_node"), Path));
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_remove_node: graph not found"));
    UEdGraphNode* Node = HaybaFindNode(Graph, NodeId);
    if (!Node)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_remove_node: no node '%s' in graph '%s' (blueprint_inspect_graph lists the ids). Nothing was changed."),
            *NodeId, *Graph->GetName()));

    const FString Title = Node->GetNodeTitle(ENodeTitleType::ListView).ToString();
    // A function graph is its entry and result nodes; removing one leaves a
    // graph that no longer compiles and cannot be repaired by adding nodes.
    if (Cast<UK2Node_FunctionEntry>(Node) || Cast<UK2Node_FunctionResult>(Node))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_remove_node: refusing to remove '%s' — it is the function's entry/result node and the function cannot exist without it. Remove the whole function instead. Nothing was changed."),
            *Title));
    if (!Node->CanUserDeleteNode())
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_remove_node: the editor does not allow deleting '%s'. Nothing was changed."), *Title));

    BP->Modify();
    Graph->Modify();
    FBlueprintEditorUtils::RemoveNode(BP, Node, /*bDontRecompile*/ true);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("removed_node_id"), NodeId);
    Out->SetStringField(TEXT("title"), Title);
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetBoolField(TEXT("verified"), HaybaFindNode(Graph, NodeId) == nullptr);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}
