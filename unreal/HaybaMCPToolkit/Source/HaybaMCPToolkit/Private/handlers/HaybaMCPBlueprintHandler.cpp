#include "HaybaMCPBlueprintHandler.h"
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
        TEXT("blueprint_set_defaults"),
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

    UPackage* Package = CreatePackage(*PkgPath);
    if (!Package)
        return FHaybaHandlerResult::Err(TEXT("blueprint_create: CreatePackage failed"));

    UBlueprint* BP = FKismetEditorUtilities::CreateBlueprint(
        ParentClass, Package, *Name, BPTYPE_Normal,
        UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass());
    if (!BP)
        return FHaybaHandlerResult::Err(TEXT("blueprint_create: CreateBlueprint failed"));

    FAssetRegistryModule::AssetCreated(BP);
    Package->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), BP->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
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

FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddNode(const TSharedPtr<FJsonObject>& P)
{
    return FHaybaHandlerResult::Err(TEXT("blueprint_add_node: not_implemented_in_v1"));
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::ConnectNodes(const TSharedPtr<FJsonObject>& P)
{
    return FHaybaHandlerResult::Err(TEXT("blueprint_connect_nodes: not_implemented_in_v1"));
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
    return FHaybaHandlerResult::Err(TEXT("blueprint_add_event: not_implemented_in_v1"));
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
            AddSkipped(Pair.Key, TEXT("property_not_found"));
            continue;
        }

        FString ValueStr;
        bool bHaveValue = Pair.Value->TryGetString(ValueStr);
        if (!bHaveValue)
        {
            switch (Pair.Value->Type)
            {
            case EJson::Number:
                ValueStr = FString::SanitizeFloat(Pair.Value->AsNumber());
                bHaveValue = true;
                break;
            case EJson::Boolean:
                ValueStr = Pair.Value->AsBool() ? TEXT("True") : TEXT("False");
                bHaveValue = true;
                break;
            case EJson::Array:
            {
                const TArray<TSharedPtr<FJsonValue>>& Arr = Pair.Value->AsArray();
                // Numeric vector/rotator/color coercion.
                bool bAllNumbers = Arr.Num() > 0;
                for (const TSharedPtr<FJsonValue>& V : Arr)
                {
                    if (!V.IsValid() || V->Type != EJson::Number) { bAllNumbers = false; break; }
                }
                if (bAllNumbers && Arr.Num() == 3)
                {
                    ValueStr = FString::Printf(TEXT("(X=%f,Y=%f,Z=%f)"),
                        Arr[0]->AsNumber(), Arr[1]->AsNumber(), Arr[2]->AsNumber());
                    bHaveValue = true;
                }
                else if (bAllNumbers && Arr.Num() == 4)
                {
                    ValueStr = FString::Printf(TEXT("(R=%f,G=%f,B=%f,A=%f)"),
                        Arr[0]->AsNumber(), Arr[1]->AsNumber(),
                        Arr[2]->AsNumber(), Arr[3]->AsNumber());
                    bHaveValue = true;
                }
                else if (bAllNumbers && Arr.Num() == 2)
                {
                    ValueStr = FString::Printf(TEXT("(X=%f,Y=%f)"),
                        Arr[0]->AsNumber(), Arr[1]->AsNumber());
                    bHaveValue = true;
                }
                break;
            }
            default:
                break;
            }
        }

        if (!bHaveValue)
        {
            AddSkipped(Pair.Key, TEXT("unsupported_value_type"));
            continue;
        }

        Prop->ImportText_Direct(*ValueStr, Prop->ContainerPtrToValuePtr<void>(CDO), CDO, PPF_None);
        SetNames.Add(MakeShared<FJsonValueString>(Pair.Key));
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
