#include "HaybaMCPDocsHandler.h"
#include "Json.h"
#include "UObject/Class.h"
#include "UObject/UnrealType.h"
#include "UObject/UObjectIterator.h"
#include "UObject/Field.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPDocs, Log, All);

namespace
{
    static UClass* ResolveClass(const FString& Path)
    {
        if (Path.IsEmpty()) return nullptr;

        // Try direct path first.
        if (UClass* C = FindObject<UClass>(nullptr, *Path))
            return C;

        // Try common module prefixes for short names.
        if (!Path.Contains(TEXT(".")))
        {
            static const TCHAR* CommonModules[] = {
                TEXT("/Script/Engine."),
                TEXT("/Script/CoreUObject."),
                TEXT("/Script/UnrealEd."),
                TEXT("/Script/Landscape."),
                TEXT("/Script/Foliage."),
                TEXT("/Script/Niagara."),
            };
            for (const TCHAR* Prefix : CommonModules)
            {
                FString Full = FString(Prefix) + Path;
                if (UClass* C = FindObject<UClass>(nullptr, *Full))
                    return C;
            }

            // Last resort: iterate all loaded classes by short name.
            for (TObjectIterator<UClass> It; It; ++It)
            {
                if (It->GetName() == Path)
                    return *It;
            }
        }

        return nullptr;
    }

    static void AddClassFlag(TArray<TSharedPtr<FJsonValue>>& Out, UClass* C, EClassFlags Flag, const TCHAR* Name)
    {
        if (C->HasAnyClassFlags(Flag))
            Out.Add(MakeShared<FJsonValueString>(Name));
    }
}

TArray<FString> FHaybaMCPDocsHandler::GetCommands() const
{
    return {
        TEXT("docs_search"),
        TEXT("docs_lookup_class"),
        TEXT("docs_lookup_api"),
    };
}

FHaybaHandlerResult FHaybaMCPDocsHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("docs_search"))        return Search(P);
    if (Cmd == TEXT("docs_lookup_class"))  return LookupClass(P);
    if (Cmd == TEXT("docs_lookup_api"))    return LookupApi(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("DocsHandler: unknown command %s"), *Cmd));
}

FHaybaHandlerResult FHaybaMCPDocsHandler::Search(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("docs_search: missing params"));

    FString Query;
    if (!P->TryGetStringField(TEXT("query"), Query) || Query.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("docs_search: missing query"));

    FString Kind = TEXT("class");
    P->TryGetStringField(TEXT("kind"), Kind);

    const int32 Cap = 50;
    TArray<TSharedPtr<FJsonValue>> Results;
    bool bCapped = false;

    if (Kind == TEXT("class") || Kind == TEXT("all"))
    {
        for (TObjectIterator<UClass> It; It; ++It)
        {
            UClass* C = *It;
            if (!C) continue;
            if (C->GetName().Contains(Query, ESearchCase::IgnoreCase))
            {
                if (Results.Num() >= Cap) { bCapped = true; break; }
                TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
                Obj->SetStringField(TEXT("name"), C->GetName());
                Obj->SetStringField(TEXT("path"), C->GetPathName());
                Obj->SetStringField(TEXT("kind"), TEXT("class"));
                Results.Add(MakeShared<FJsonValueObject>(Obj));
            }
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("results"), Results);
    Out->SetNumberField(TEXT("count"), Results.Num());
    Out->SetBoolField(TEXT("capped"), bCapped);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPDocsHandler::LookupClass(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("docs_lookup_class: missing params"));

    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("docs_lookup_class: missing path"));

    UClass* Class = ResolveClass(Path);
    if (!Class) return FHaybaHandlerResult::Err(FString::Printf(TEXT("docs_lookup_class: class not found: %s"), *Path));

    TArray<TSharedPtr<FJsonValue>> Parents;
    for (UClass* Super = Class->GetSuperClass(); Super; Super = Super->GetSuperClass())
    {
        Parents.Add(MakeShared<FJsonValueString>(Super->GetPathName()));
    }

    TArray<TSharedPtr<FJsonValue>> Flags;
    AddClassFlag(Flags, Class, CLASS_Abstract,             TEXT("CLASS_Abstract"));
    AddClassFlag(Flags, Class, CLASS_Native,               TEXT("CLASS_Native"));
    AddClassFlag(Flags, Class, CLASS_NotPlaceable,         TEXT("CLASS_NotPlaceable"));
    AddClassFlag(Flags, Class, CLASS_Transient,            TEXT("CLASS_Transient"));
    AddClassFlag(Flags, Class, CLASS_Deprecated,           TEXT("CLASS_Deprecated"));
    AddClassFlag(Flags, Class, CLASS_Hidden,               TEXT("CLASS_Hidden"));
    AddClassFlag(Flags, Class, CLASS_Const,                TEXT("CLASS_Const"));
    AddClassFlag(Flags, Class, CLASS_Interface,            TEXT("CLASS_Interface"));
    AddClassFlag(Flags, Class, CLASS_DefaultConfig,        TEXT("CLASS_DefaultConfig"));
    AddClassFlag(Flags, Class, CLASS_PerObjectConfig,      TEXT("CLASS_PerObjectConfig"));
    AddClassFlag(Flags, Class, CLASS_Config,               TEXT("CLASS_Config"));
    AddClassFlag(Flags, Class, CLASS_HasInstancedReference,TEXT("CLASS_HasInstancedReference"));
    AddClassFlag(Flags, Class, CLASS_NeedsConfig,          TEXT("CLASS_NeedsConfig"));

    int32 PropertyCount = 0;
    for (TFieldIterator<FProperty> It(Class, EFieldIterationFlags::None); It; ++It) ++PropertyCount;
    int32 FunctionCount = 0;
    for (TFieldIterator<UFunction> It(Class, EFieldIterationFlags::None); It; ++It) ++FunctionCount;

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("name"), Class->GetName());
    Out->SetStringField(TEXT("path"), Class->GetPathName());
    Out->SetArrayField(TEXT("parent_chain"), Parents);
    Out->SetArrayField(TEXT("flags"), Flags);
    Out->SetNumberField(TEXT("property_count"), PropertyCount);
    Out->SetNumberField(TEXT("function_count"), FunctionCount);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPDocsHandler::LookupApi(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("docs_lookup_api: missing params"));

    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("docs_lookup_api: missing path"));

    bool bIncludeInherited = false;
    P->TryGetBoolField(TEXT("include_inherited"), bIncludeInherited);

    UClass* Class = ResolveClass(Path);
    if (!Class) return FHaybaHandlerResult::Err(FString::Printf(TEXT("docs_lookup_api: class not found: %s"), *Path));

    const EFieldIterationFlags IterFlags = bIncludeInherited
        ? EFieldIterationFlags::IncludeSuper
        : EFieldIterationFlags::None;

    const int32 PropCap = 200;
    const int32 FuncCap = 100;

    TArray<TSharedPtr<FJsonValue>> Properties;
    bool bPropertyCapped = false;
    for (TFieldIterator<FProperty> It(Class, IterFlags); It; ++It)
    {
        if (Properties.Num() >= PropCap) { bPropertyCapped = true; break; }
        FProperty* Prop = *It;
        TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
        Obj->SetStringField(TEXT("name"), Prop->GetName());
        Obj->SetStringField(TEXT("type"), Prop->GetCPPType());
#if WITH_EDITORONLY_DATA
        Obj->SetStringField(TEXT("category"), Prop->GetMetaData(TEXT("Category")));
        Obj->SetStringField(TEXT("tooltip"), Prop->GetMetaData(TEXT("ToolTip")));
#else
        Obj->SetStringField(TEXT("category"), TEXT(""));
        Obj->SetStringField(TEXT("tooltip"), TEXT(""));
#endif
        Obj->SetBoolField(TEXT("is_editable"), Prop->HasAnyPropertyFlags(CPF_Edit));
        Obj->SetBoolField(TEXT("is_blueprint_visible"), Prop->HasAnyPropertyFlags(CPF_BlueprintVisible));
        Properties.Add(MakeShared<FJsonValueObject>(Obj));
    }

    TArray<TSharedPtr<FJsonValue>> Functions;
    bool bFunctionCapped = false;
    for (TFieldIterator<UFunction> It(Class, IterFlags); It; ++It)
    {
        if (Functions.Num() >= FuncCap) { bFunctionCapped = true; break; }
        UFunction* Func = *It;
        TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
        Obj->SetStringField(TEXT("name"), Func->GetName());
        Obj->SetBoolField(TEXT("is_blueprint_callable"), Func->HasAnyFunctionFlags(FUNC_BlueprintCallable));
        Obj->SetBoolField(TEXT("is_event"), Func->HasAnyFunctionFlags(FUNC_BlueprintEvent));
#if WITH_EDITORONLY_DATA
        Obj->SetStringField(TEXT("tooltip"), Func->GetMetaData(TEXT("ToolTip")));
#else
        Obj->SetStringField(TEXT("tooltip"), TEXT(""));
#endif

        TArray<TSharedPtr<FJsonValue>> Params;
        for (TFieldIterator<FProperty> PIt(Func); PIt; ++PIt)
        {
            FProperty* PProp = *PIt;
            if (!PProp->HasAnyPropertyFlags(CPF_Parm)) continue;
            TSharedPtr<FJsonObject> PObj = MakeShared<FJsonObject>();
            PObj->SetStringField(TEXT("name"), PProp->GetName());
            PObj->SetStringField(TEXT("type"), PProp->GetCPPType());
            PObj->SetBoolField(TEXT("is_return"), PProp->HasAnyPropertyFlags(CPF_ReturnParm));
            PObj->SetBoolField(TEXT("is_out"), PProp->HasAnyPropertyFlags(CPF_OutParm));
            Params.Add(MakeShared<FJsonValueObject>(PObj));
        }
        Obj->SetArrayField(TEXT("parameters"), Params);

        Functions.Add(MakeShared<FJsonValueObject>(Obj));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("class"), Class->GetName());
    Out->SetArrayField(TEXT("properties"), Properties);
    Out->SetArrayField(TEXT("functions"), Functions);
    Out->SetBoolField(TEXT("property_capped"), bPropertyCapped);
    Out->SetBoolField(TEXT("function_capped"), bFunctionCapped);
    return FHaybaHandlerResult::Ok(Out);
}
