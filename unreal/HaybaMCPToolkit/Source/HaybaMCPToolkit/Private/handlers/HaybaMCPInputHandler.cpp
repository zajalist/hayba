#include "HaybaMCPInputHandler.h"
#include "Json.h"
#include "AssetToolsModule.h"
#include "HaybaMCPAssetGuard.h"
#include "IAssetTools.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "InputTriggers.h"
#include "InputCoreTypes.h"
#include "Misc/PackageName.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/Class.h"
#include "UObject/UnrealType.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPInput, Log, All);

TArray<FString> FHaybaMCPInputHandler::GetCommands() const
{
    return {
        TEXT("input_create_action"),
        TEXT("input_create_mapping"),
        TEXT("input_add_mapping")
    };
}

static bool ParseValueType(const FString& In, EInputActionValueType& Out)
{
    const FString S = In.ToLower();
    if (S == TEXT("boolean") || S == TEXT("bool")) { Out = EInputActionValueType::Boolean; return true; }
    if (S == TEXT("axis1d") || S == TEXT("float") || S == TEXT("1d")) { Out = EInputActionValueType::Axis1D; return true; }
    if (S == TEXT("axis2d") || S == TEXT("vector2d") || S == TEXT("2d")) { Out = EInputActionValueType::Axis2D; return true; }
    if (S == TEXT("axis3d") || S == TEXT("vector") || S == TEXT("3d")) { Out = EInputActionValueType::Axis3D; return true; }
    return false;
}

// Resolve a short class-name (e.g. "InputModifierNegate" or "Negate") to a UClass*
// derived from BaseClass. Tries an exact lookup first, then a "U"+name variant,
// then a scan of derived classes by short name.
static UClass* FindInputClass(const FString& Name, UClass* BaseClass)
{
    if (Name.IsEmpty() || !BaseClass) return nullptr;

    if (UClass* Direct = FindFirstObjectSafe<UClass>(*Name))
    {
        if (Direct->IsChildOf(BaseClass) && !Direct->HasAnyClassFlags(CLASS_Abstract))
            return Direct;
    }

    const FString WithU = Name.StartsWith(TEXT("U")) ? Name : (TEXT("U") + Name);
    if (UClass* WithUCls = FindFirstObjectSafe<UClass>(*WithU))
    {
        if (WithUCls->IsChildOf(BaseClass) && !WithUCls->HasAnyClassFlags(CLASS_Abstract))
            return WithUCls;
    }

    // Fallback: scan derived classes for a name match (strip "U"/"InputModifier"/"InputTrigger" prefixes for comparison)
    auto Normalize = [](FString N)
    {
        if (N.StartsWith(TEXT("U"))) N.RemoveAt(0, 1);
        N.RemoveFromStart(TEXT("InputModifier"));
        N.RemoveFromStart(TEXT("InputTrigger"));
        return N.ToLower();
    };
    const FString Target = Normalize(Name);

    for (TObjectIterator<UClass> It; It; ++It)
    {
        UClass* C = *It;
        if (!C || C->HasAnyClassFlags(CLASS_Abstract)) continue;
        if (!C->IsChildOf(BaseClass)) continue;
        if (Normalize(C->GetName()) == Target) return C;
    }
    return nullptr;
}

FHaybaHandlerResult FHaybaMCPInputHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid())
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("%s: missing params"), *Cmd));

    if (Cmd == TEXT("input_create_action"))
    {
        FString PkgPath, Name, ValueTypeStr;
        if (!P->TryGetStringField(TEXT("path"), PkgPath) || PkgPath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("input_create_action: missing path"));
        if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("input_create_action: missing name"));
        if (!P->TryGetStringField(TEXT("value_type"), ValueTypeStr) || ValueTypeStr.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("input_create_action: missing value_type"));

        EInputActionValueType VT;
        if (!ParseValueType(ValueTypeStr, VT))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("input_create_action: unknown value_type '%s' (expected Boolean|Axis1D|Axis2D|Axis3D)"), *ValueTypeStr));

        IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
        // Refuse a taken name instead of letting CreateAsset raise a modal
        // overwrite dialog, which would block the game thread and hang every
        // queued MCP request. See HaybaMCPAssetGuard.h.
        if (HaybaAssetGuard::AssetNameTaken(PkgPath, Name))
        {
            return FHaybaHandlerResult::Err(
                HaybaAssetGuard::NameTakenError(TEXT("input_create_action"), PkgPath, Name));
        }

        UObject* Created = Tools.CreateAsset(Name, PkgPath, UInputAction::StaticClass(), nullptr);
        if (!Created) return FHaybaHandlerResult::Err(TEXT("input_create_action: CreateAsset failed"));

        UInputAction* Action = Cast<UInputAction>(Created);
        if (!Action) return FHaybaHandlerResult::Err(TEXT("input_create_action: created object is not a UInputAction"));
        Action->ValueType = VT;
        Action->MarkPackageDirty();
        Action->PostEditChange();

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Action->GetPathName());
        Out->SetStringField(TEXT("name"), Name);
        Out->SetStringField(TEXT("value_type"), ValueTypeStr);
        return FHaybaHandlerResult::Ok(Out);
    }

    if (Cmd == TEXT("input_create_mapping"))
    {
        FString PkgPath, Name;
        if (!P->TryGetStringField(TEXT("path"), PkgPath) || PkgPath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("input_create_mapping: missing path"));
        if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("input_create_mapping: missing name"));

        IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
        // Refuse a taken name instead of letting CreateAsset raise a modal
        // overwrite dialog, which would block the game thread and hang every
        // queued MCP request. See HaybaMCPAssetGuard.h.
        if (HaybaAssetGuard::AssetNameTaken(PkgPath, Name))
        {
            return FHaybaHandlerResult::Err(
                HaybaAssetGuard::NameTakenError(TEXT("input_create_mapping"), PkgPath, Name));
        }

        UObject* Created = Tools.CreateAsset(Name, PkgPath, UInputMappingContext::StaticClass(), nullptr);
        if (!Created) return FHaybaHandlerResult::Err(TEXT("input_create_mapping: CreateAsset failed"));

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Created->GetPathName());
        Out->SetStringField(TEXT("name"), Name);
        return FHaybaHandlerResult::Ok(Out);
    }

    if (Cmd == TEXT("input_add_mapping"))
    {
        FString MappingPath, ActionPath, KeyName;
        if (!P->TryGetStringField(TEXT("mapping_path"), MappingPath))
            return FHaybaHandlerResult::Err(TEXT("input_add_mapping: missing mapping_path"));
        if (!P->TryGetStringField(TEXT("action_path"), ActionPath))
            return FHaybaHandlerResult::Err(TEXT("input_add_mapping: missing action_path"));
        if (!P->TryGetStringField(TEXT("key_name"), KeyName) || KeyName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("input_add_mapping: missing key_name"));

        UInputMappingContext* Mapping = LoadObject<UInputMappingContext>(nullptr, *MappingPath);
        if (!Mapping) return FHaybaHandlerResult::Err(FString::Printf(TEXT("input_add_mapping: mapping not found: %s"), *MappingPath));

        UInputAction* Action = LoadObject<UInputAction>(nullptr, *ActionPath);
        if (!Action) return FHaybaHandlerResult::Err(FString::Printf(TEXT("input_add_mapping: action not found: %s"), *ActionPath));

        const FKey Key(*KeyName);
        if (!Key.IsValid())
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("input_add_mapping: invalid key '%s'"), *KeyName));

        FEnhancedActionKeyMapping& KeyMapping = Mapping->MapKey(Action, Key);

        TArray<FString> AddedModifiers;
        TArray<FString> AddedTriggers;
        TArray<FString> FailedClasses;

        const TArray<TSharedPtr<FJsonValue>>* ModArr = nullptr;
        if (P->TryGetArrayField(TEXT("modifiers"), ModArr))
        {
            for (const TSharedPtr<FJsonValue>& V : *ModArr)
            {
                if (!V.IsValid() || V->Type != EJson::String) continue;
                const FString ClsName = V->AsString();
                UClass* Cls = FindInputClass(ClsName, UInputModifier::StaticClass());
                if (!Cls) { FailedClasses.Add(ClsName); continue; }
                UInputModifier* Mod = NewObject<UInputModifier>(Mapping, Cls);
                if (Mod)
                {
                    KeyMapping.Modifiers.Add(Mod);
                    AddedModifiers.Add(Cls->GetName());
                }
                else FailedClasses.Add(ClsName);
            }
        }

        const TArray<TSharedPtr<FJsonValue>>* TrigArr = nullptr;
        if (P->TryGetArrayField(TEXT("triggers"), TrigArr))
        {
            for (const TSharedPtr<FJsonValue>& V : *TrigArr)
            {
                if (!V.IsValid() || V->Type != EJson::String) continue;
                const FString ClsName = V->AsString();
                UClass* Cls = FindInputClass(ClsName, UInputTrigger::StaticClass());
                if (!Cls) { FailedClasses.Add(ClsName); continue; }
                UInputTrigger* Trig = NewObject<UInputTrigger>(Mapping, Cls);
                if (Trig)
                {
                    KeyMapping.Triggers.Add(Trig);
                    AddedTriggers.Add(Cls->GetName());
                }
                else FailedClasses.Add(ClsName);
            }
        }

        Mapping->MarkPackageDirty();
        Mapping->PostEditChange();

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("mapping_path"), Mapping->GetPathName());
        Out->SetStringField(TEXT("action_path"), Action->GetPathName());
        Out->SetStringField(TEXT("key"), KeyName);

        TArray<TSharedPtr<FJsonValue>> ModsJson;
        for (const FString& S : AddedModifiers) ModsJson.Add(MakeShared<FJsonValueString>(S));
        Out->SetArrayField(TEXT("modifiers"), ModsJson);

        TArray<TSharedPtr<FJsonValue>> TrigsJson;
        for (const FString& S : AddedTriggers) TrigsJson.Add(MakeShared<FJsonValueString>(S));
        Out->SetArrayField(TEXT("triggers"), TrigsJson);

        if (FailedClasses.Num() > 0)
        {
            TArray<TSharedPtr<FJsonValue>> FailJson;
            for (const FString& S : FailedClasses) FailJson.Add(MakeShared<FJsonValueString>(S));
            Out->SetArrayField(TEXT("unresolved_classes"), FailJson);
        }
        return FHaybaHandlerResult::Ok(Out);
    }

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("InputHandler: unknown command %s"), *Cmd));
}
