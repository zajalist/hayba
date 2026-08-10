#include "HaybaMCPDataAssetHandler.h"

#include "Json.h"
#include "JsonObjectConverter.h"
#include "Engine/DataAsset.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "HaybaMCPAssetGuard.h"
#include "HaybaMCPParams.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "EditorAssetLibrary.h"
#include "UObject/UnrealType.h"
#include "UObject/Class.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/SavePackage.h"
#include "Misc/PackageName.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPDataAsset, Log, All);

TArray<FString> FHaybaMCPDataAssetHandler::GetCommands() const
{
    return {
        TEXT("data_create"),
        TEXT("data_get"),
        TEXT("data_set")
    };
}

// ---------- helpers ----------

namespace HaybaMCPDataAssetHelpers
{
    constexpr int32 MaxDataAssetPathChars = 1024;
    constexpr int32 MaxDataAssetNameChars = 256;
    constexpr int32 MaxDataAssetClassChars = 1024;

    static bool IsSafeAssetName(const FString& Value)
    {
        if (Value.IsEmpty()) return false;
        for (const TCHAR Ch : Value)
        {
            // Keep untrusted names out of FName/package internals until their
            // lexical shape is known. Package/object names do not need control
            // characters, separators, or punctuation when the folder is a
            // separate parameter.
            if (Ch == TEXT('\0') || FChar::IsControl(Ch)
                || !(FChar::IsAlnum(Ch) || Ch == TEXT('_')))
            {
                return false;
            }
        }
        return true;
    }

    static bool IsSafeClassReference(const FString& Value)
    {
        if (Value.IsEmpty()
            || Value.Contains(TEXT(".."))
            || Value.Contains(TEXT("//"))
            || Value.Contains(TEXT("\\")))
        {
            return false;
        }
        for (const TCHAR Ch : Value)
        {
            // ResolveClass accepts short names, Module.Class, and /Game or
            // /Script object paths. None requires quotes, whitespace, control
            // characters, or punctuation beyond slash/dot/underscore.
            if (Ch == TEXT('\0') || FChar::IsControl(Ch)
                || !(FChar::IsAlnum(Ch)
                    || Ch == TEXT('_') || Ch == TEXT('/') || Ch == TEXT('.')))
            {
                return false;
            }
        }
        if (Value.StartsWith(TEXT("/"), ESearchCase::CaseSensitive))
        {
            if (!(Value.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive)
                    || Value.StartsWith(TEXT("/Script/"), ESearchCase::CaseSensitive)))
            {
                return false;
            }
            int32 LastSlash = INDEX_NONE;
            int32 FirstDot = INDEX_NONE;
            int32 LastDot = INDEX_NONE;
            Value.FindLastChar(TEXT('/'), LastSlash);
            Value.FindChar(TEXT('.'), FirstDot);
            Value.FindLastChar(TEXT('.'), LastDot);
            return FirstDot == LastDot
                && FirstDot > LastSlash + 1
                && FirstDot < Value.Len() - 1;
        }
        if (Value.Contains(TEXT("/"))) return false;
        int32 FirstDot = INDEX_NONE;
        int32 LastDot = INDEX_NONE;
        if (!Value.FindChar(TEXT('.'), FirstDot)) return true;
        Value.FindLastChar(TEXT('.'), LastDot);
        return FirstDot == LastDot && FirstDot > 0 && FirstDot < Value.Len() - 1;
    }

    // Resolve a UClass* by user-supplied name. Accepts:
    //   "/Script/MyGame.MyClass"  (path)
    //   "MyClass" or "MyClass_C"  (short name)
    //   "MyGame.MyClass"          (module.class)
    static UClass* ResolveClass(const FString& InName)
    {
        if (InName.IsEmpty()) return nullptr;

        FString Name = InName;
        // Strip trailing _C if user passed a blueprint generated class short name —
        // FindFirstObject works on the UClass name.
        // For full paths, prefer LoadClass / LoadObject.
        if (Name.StartsWith(TEXT("/")))
        {
            if (UClass* C = LoadClass<UObject>(nullptr, *Name)) return C;
            if (UClass* C = LoadObject<UClass>(nullptr, *Name)) return C;
        }

        // Try as-is, then with _C, then short name.
        if (UClass* C = FindFirstObject<UClass>(*Name, EFindFirstObjectOptions::NativeFirst))
            return C;

        if (Name.EndsWith(TEXT("_C")))
        {
            FString Trim = Name.LeftChop(2);
            if (UClass* C = FindFirstObject<UClass>(*Trim, EFindFirstObjectOptions::NativeFirst))
                return C;
        }
        else
        {
            FString WithC = Name + TEXT("_C");
            if (UClass* C = FindFirstObject<UClass>(*WithC, EFindFirstObjectOptions::NativeFirst))
                return C;
        }

        // Module.Class form -> /Script/Module.Class
        int32 Dot;
        if (Name.FindChar('.', Dot))
        {
            FString ScriptPath = FString::Printf(TEXT("/Script/%s"), *Name);
            if (UClass* C = LoadClass<UObject>(nullptr, *ScriptPath)) return C;
            if (UClass* C = LoadObject<UClass>(nullptr, *ScriptPath)) return C;
        }

        return nullptr;
    }

    // Reflect every property on Object into a JSON object.
    // Uses FJsonObjectConverter::UPropertyToJsonValue for the heavy lifting and
    // falls back to "<unsupported:cpp_type>" for anything it cannot serialize.
    static TSharedPtr<FJsonObject> ReflectObjectProperties(const UObject* Object)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        if (!Object) return Out;

        const UClass* Class = Object->GetClass();
        for (TFieldIterator<FProperty> It(Class); It; ++It)
        {
            FProperty* Prop = *It;
            if (!Prop) continue;

            const FString PropName = Prop->GetName();
            const void* ValuePtr = Prop->ContainerPtrToValuePtr<void>(Object);

            TSharedPtr<FJsonValue> JsonVal =
                FJsonObjectConverter::UPropertyToJsonValue(Prop, ValuePtr, 0, 0);

            if (JsonVal.IsValid())
            {
                Out->SetField(PropName, JsonVal);
            }
            else
            {
                Out->SetStringField(PropName,
                    FString::Printf(TEXT("<unsupported:%s>"), *Prop->GetCPPType()));
            }
        }
        return Out;
    }

    static bool ValidateMutationJsonShape(
        const TSharedPtr<FJsonValue>& Value,
        int32 Depth,
        int32& Nodes,
        FString& OutReason)
    {
        if (!Value.IsValid()) { OutReason = TEXT("invalid JSON value"); return false; }
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
                if (!ValidateMutationJsonShape(Child, Depth + 1, Nodes, OutReason)) return false;
        }
        else if (Value->Type == EJson::Object)
        {
            if (Value->AsObject()->Values.Num() > 256)
            {
                OutReason = TEXT("contains an object larger than 256 fields");
                return false;
            }
            for (const auto& Pair : Value->AsObject()->Values)
                if (!ValidateMutationJsonShape(Pair.Value, Depth + 1, Nodes, OutReason)) return false;
        }
        return true;
    }
}

// ---------- handler ----------

FHaybaHandlerResult FHaybaMCPDataAssetHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    using namespace HaybaMCPDataAssetHelpers;

    // ---------- data_create ----------
    if (Cmd == TEXT("data_create"))
    {
        // Parse and bound every attacker-controlled string before any path
        // concatenation, object/class lookup, module load, or asset mutation.
        FHaybaParamReader R(P, TEXT("data_create"));
        const FString PackagePath = R.RequiredGamePath(TEXT("path"), MaxDataAssetPathChars);
        const FString AssetName = R.RequiredString(TEXT("name"), MaxDataAssetNameChars);
        const FString ClassName = R.RequiredString(TEXT("class_name"), MaxDataAssetClassChars);
        if (!PackagePath.IsEmpty() && !FPackageName::IsValidLongPackageName(PackagePath))
        {
            R.AddError(TEXT("'path' must name a /Game content folder, not an object path"));
        }
        if (!AssetName.IsEmpty() && !IsSafeAssetName(AssetName))
        {
            R.AddError(TEXT("'name' must contain only letters, numbers, or underscores; control characters and separators are not allowed"));
        }
        if (!ClassName.IsEmpty() && !IsSafeClassReference(ClassName))
        {
            R.AddError(TEXT("'class_name' must be a bounded short class name, Module.Class, or /Game or /Script class path without control characters or traversal"));
        }
        if (R.HasErrors())
            return FHaybaHandlerResult::Err(R.ErrorMessage());

        const FString IntendedPackage = PackagePath / AssetName;
        if (!(PackagePath == TEXT("/Game") || PackagePath.StartsWith(TEXT("/Game/")))
            || !FPackageName::IsValidLongPackageName(IntendedPackage))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_create: target must resolve to a valid package under /Game; got '%s'. Nothing was created."),
                *IntendedPackage));
        }

        UClass* Class = ResolveClass(ClassName);
        if (!Class)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_create: class not found: %s"), *ClassName));

        if (!Class->IsChildOf(UDataAsset::StaticClass())
            || Class->HasAnyClassFlags(
                CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_create: class %s must be a current, non-deprecated, concrete UDataAsset subclass; nothing was created"), *ClassName));

        // Refuse a taken name instead of letting CreateAsset raise a modal
        // overwrite dialog, which would block the game thread and hang every
        // queued MCP request. See HaybaMCPAssetGuard.h.
        if (HaybaAssetGuard::AssetNameTaken(PackagePath, AssetName))
        {
            return FHaybaHandlerResult::Err(
                HaybaAssetGuard::NameTakenError(TEXT("data_create"), PackagePath, AssetName));
        }

        FAssetToolsModule* AssetToolsModule =
            FModuleManager::LoadModulePtr<FAssetToolsModule>(TEXT("AssetTools"));
        if (!AssetToolsModule)
            return FHaybaHandlerResult::Err(TEXT("data_create: AssetTools module is unavailable; nothing was created"));
        IAssetTools& AssetTools = AssetToolsModule->Get();

        UObject* NewAsset = AssetTools.CreateAsset(AssetName, PackagePath, Class, nullptr);
        if (!NewAsset)
            return FHaybaHandlerResult::Err(TEXT("data_create: CreateAsset failed"));

        // Mark dirty + best-effort save so callers can immediately re-load it.
        // The save result was discarded, and it does fail — creating into a
        // content folder that does not exist yet leaves nothing on disk. The
        // reply then said the asset was created and ready to re-load while
        // data_get answered "could not load", which reads as a bug in data_get.
        bool bSaved = false;
        if (UPackage* Pkg = NewAsset->GetOutermost())
        {
            Pkg->MarkPackageDirty();
            bSaved = UEditorAssetLibrary::SaveLoadedAsset(NewAsset, /*bOnlyIfDirty*/false);
        }

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), NewAsset->GetPathName());
        Out->SetStringField(TEXT("class"), Class->GetPathName());
        Out->SetStringField(TEXT("name"), AssetName);
        // The asset exists either way — in memory at minimum. `saved` says
        // whether it also reached disk, which is the difference between an edit
        // that survives an editor restart and one that does not.
        Out->SetBoolField(TEXT("saved"), bSaved);
        Out->SetBoolField(TEXT("dirty"), NewAsset->GetOutermost()->IsDirty());
        if (!bSaved)
        {
            Out->SetStringField(TEXT("save_note"),
                TEXT("created in memory but NOT written to disk — call asset_save, or create into an existing content folder"));
        }
        return FHaybaHandlerResult::Ok(Out);
    }

    // ---------- data_get ----------
    // UEditorAssetLibrary::LoadAsset resolves through the asset registry, which
    // only knows assets that are ON DISK. data_create does not save, so
    // create -> get -> set on a brand-new asset failed with "could not load" on
    // an object that was sitting in memory the whole time. LoadObject finds the
    // in-memory object first and falls back to loading from disk, which is what
    // the behavior-tree and animation handlers already do.
    const auto LoadDataAsset = [](const FString& Path) -> UObject*
    {
        if (UObject* InMemory = LoadObject<UObject>(nullptr, *Path)) return InMemory;
        return UEditorAssetLibrary::LoadAsset(Path);
    };

    if (Cmd == TEXT("data_get"))
    {
        FString Path;
        if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("data_get: missing path"));

        UObject* Asset = LoadDataAsset(Path);
        if (!Asset)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_get: could not load %s"), *Path));
        if (!Asset->IsA<UDataAsset>())
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_get: %s is a %s, not a UDataAsset; no state was changed"),
                *Path, *Asset->GetClass()->GetName()));

        TSharedPtr<FJsonObject> Props = ReflectObjectProperties(Asset);

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Asset->GetPathName());
        Out->SetStringField(TEXT("class"), Asset->GetClass()->GetPathName());
        Out->SetObjectField(TEXT("properties"), Props);
        return FHaybaHandlerResult::Ok(Out);
    }

    // ---------- data_set ----------
    if (Cmd == TEXT("data_set"))
    {
        FString Path, PropertyName;
        if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("data_set: missing path"));
        if (!P->TryGetStringField(TEXT("property_name"), PropertyName) || PropertyName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("data_set: missing property_name"));

        TSharedPtr<FJsonValue> Value = P->TryGetField(TEXT("value"));
        if (!Value.IsValid())
            return FHaybaHandlerResult::Err(TEXT("data_set: missing value"));
        int32 JsonNodes = 0;
        FString ShapeReason;
        if (!ValidateMutationJsonShape(Value, 0, JsonNodes, ShapeReason))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: value %s; nothing was changed"), *ShapeReason));

        UObject* Asset = LoadDataAsset(Path);
        if (!Asset)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: could not load %s"), *Path));
        if (!Asset->IsA<UDataAsset>())
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: %s is a %s, not a UDataAsset; nothing was changed"),
                *Path, *Asset->GetClass()->GetName()));

        UClass* Class = Asset->GetClass();
        FProperty* Prop = FindFProperty<FProperty>(Class, *PropertyName);
        if (!Prop)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: property %s not found on %s"),
                *PropertyName, *Class->GetName()));
        if (!Prop->HasAnyPropertyFlags(CPF_Edit)
            || Prop->HasAnyPropertyFlags(CPF_EditConst | CPF_Transient | CPF_Deprecated))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: property %s (%s) is not a mutable persisted editor property; nothing was changed"),
                *PropertyName, *Prop->GetCPPType()));
        }

        // Deserialize into a transient same-class object first. JsonValueToUProperty can
        // resize a container or write some struct members before returning
        // false; pointing it at the live DataAsset made a rejected request a
        // partial mutation. Only a completely converted property crosses the
        // mutation boundary below.
        UObject* StagedAsset = NewObject<UObject>(GetTransientPackage(), Asset->GetClass());
        if (!StagedAsset)
            return FHaybaHandlerResult::Err(TEXT("data_set: could not allocate a staging copy; nothing was changed"));
        Prop->CopyCompleteValue_InContainer(StagedAsset, Asset);
        void* StagedValuePtr = Prop->ContainerPtrToValuePtr<void>(StagedAsset);
        const bool bOk = FJsonObjectConverter::JsonValueToUProperty(
            Value, Prop, StagedValuePtr, /*CheckFlags*/0, /*SkipFlags*/0);

        if (!bOk)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: failed to deserialize JSON into property %s (%s); conversion was staged and the live asset was not changed"),
                *PropertyName, *Prop->GetCPPType()));

        // Execute: from here on the request is fully resolved and typed.
        Asset->Modify();
        Asset->PreEditChange(Prop);
        Prop->CopyCompleteValue_InContainer(Asset, StagedAsset);
        FPropertyChangedEvent Evt(Prop, EPropertyChangeType::ValueSet);
        Asset->PostEditChangeProperty(Evt);

        // PostEditChange may normalize a value. Compare to the staged value so
        // silent refusal/coercion is visible rather than reported as success.
        const bool bVerified = Prop->Identical_InContainer(
            Asset, StagedAsset, 0, PPF_DeepComparison);
        bool bSaved = false;
        if (UPackage* Pkg = Asset->GetOutermost())
        {
            Pkg->MarkPackageDirty();
            bSaved = UEditorAssetLibrary::SaveLoadedAsset(Asset, /*bOnlyIfDirty*/false);
        }

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Asset->GetPathName());
        Out->SetStringField(TEXT("property"), PropertyName);
        Out->SetBoolField(TEXT("applied"), true);
        Out->SetBoolField(TEXT("verified"), bVerified);
        Out->SetBoolField(TEXT("saved"), bSaved);
        Out->SetBoolField(TEXT("dirty"), Asset->GetOutermost()->IsDirty());
        if (TSharedPtr<FJsonValue> Observed =
                FJsonObjectConverter::UPropertyToJsonValue(
                    Prop, Prop->ContainerPtrToValuePtr<void>(Asset), 0, 0))
        {
            Out->SetField(TEXT("observed_value"), Observed);
        }
        if (!bVerified)
        {
            Out->SetStringField(TEXT("warning"),
                TEXT("The property notification normalized or rejected the staged value. Read observed_value before making a dependent edit; do not retry blindly."));
        }
        if (!bSaved)
        {
            Out->SetStringField(TEXT("save_error"),
                TEXT("The property changed in memory but SaveLoadedAsset failed. Save the package before closing the editor."));
        }
        return FHaybaHandlerResult::Ok(Out);
    }

    return FHaybaHandlerResult::Err(FString::Printf(
        TEXT("DataAssetHandler: unknown command %s"), *Cmd));
}
