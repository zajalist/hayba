#include "HaybaMCPDataAssetHandler.h"

#include "Json.h"
#include "JsonObjectConverter.h"
#include "Engine/DataAsset.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "HaybaMCPAssetGuard.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "EditorAssetLibrary.h"
#include "UObject/UnrealType.h"
#include "UObject/Class.h"
#include "UObject/Package.h"
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
}

// ---------- handler ----------

FHaybaHandlerResult FHaybaMCPDataAssetHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    using namespace HaybaMCPDataAssetHelpers;

    // ---------- data_create ----------
    if (Cmd == TEXT("data_create"))
    {
        FString PackagePath, AssetName, ClassName;
        if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), PackagePath) || PackagePath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("data_create: missing path"));
        if (!P->TryGetStringField(TEXT("name"), AssetName) || AssetName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("data_create: missing name"));
        if (!P->TryGetStringField(TEXT("class_name"), ClassName) || ClassName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("data_create: missing class_name"));

        UClass* Class = ResolveClass(ClassName);
        if (!Class)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_create: class not found: %s"), *ClassName));

        if (!Class->IsChildOf(UDataAsset::StaticClass()))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_create: class %s does not inherit UDataAsset"), *ClassName));

        FAssetToolsModule& AssetToolsModule =
            FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools");
        IAssetTools& AssetTools = AssetToolsModule.Get();

        // Refuse a taken name instead of letting CreateAsset raise a modal
        // overwrite dialog, which would block the game thread and hang every
        // queued MCP request. See HaybaMCPAssetGuard.h.
        if (HaybaAssetGuard::AssetNameTaken(PackagePath, AssetName))
        {
            return FHaybaHandlerResult::Err(
                HaybaAssetGuard::NameTakenError(TEXT("data_create"), PackagePath, AssetName));
        }

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

        UObject* Asset = LoadDataAsset(Path);
        if (!Asset)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: could not load %s"), *Path));

        UClass* Class = Asset->GetClass();
        FProperty* Prop = FindFProperty<FProperty>(Class, *PropertyName);
        if (!Prop)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: property %s not found on %s"),
                *PropertyName, *Class->GetName()));

        void* ValuePtr = Prop->ContainerPtrToValuePtr<void>(Asset);

        // FJsonObjectConverter handles Bool/Int/Float/String/Name/Enum/Struct/Array
        // /Map/Set/ObjectRef etc. PPF_None flags are fine for in-editor use.
        const bool bOk = FJsonObjectConverter::JsonValueToUProperty(
            Value, Prop, ValuePtr, /*CheckFlags*/0, /*SkipFlags*/0);

        if (!bOk)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: failed to deserialize JSON into property %s (%s)"),
                *PropertyName, *Prop->GetCPPType()));

        // Property notifications + dirty + save.
        Asset->Modify();
        FPropertyChangedEvent Evt(Prop, EPropertyChangeType::ValueSet);
        Asset->PostEditChangeProperty(Evt);

        // The save result used to be discarded and ok:true returned regardless.
        // A save can fail for ordinary reasons -- the file is read-only, or
        // wants a source-control checkout -- and the caller was told the
        // property had been persisted when it existed only in memory and would
        // be gone at the next editor restart. Silently losing an edit is worse
        // than refusing one.
        bool bSaved = false;
        if (UPackage* Pkg = Asset->GetOutermost())
        {
            Pkg->MarkPackageDirty();
            bSaved = UEditorAssetLibrary::SaveLoadedAsset(Asset, /*bOnlyIfDirty*/false);
        }

        if (!bSaved)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: %s was set on %s in memory, but saving the asset failed ")
                TEXT("— the change will be lost when the editor closes. The file may be ")
                TEXT("read-only or need a source-control checkout."),
                *PropertyName, *Asset->GetPathName()));
        }

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Asset->GetPathName());
        Out->SetStringField(TEXT("property"), PropertyName);
        Out->SetBoolField(TEXT("saved"), true);
        Out->SetBoolField(TEXT("ok"), true);
        return FHaybaHandlerResult::Ok(Out);
    }

    return FHaybaHandlerResult::Err(FString::Printf(
        TEXT("DataAssetHandler: unknown command %s"), *Cmd));
}
