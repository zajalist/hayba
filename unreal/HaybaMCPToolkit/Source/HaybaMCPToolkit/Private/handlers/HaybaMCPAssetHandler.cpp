#include "HaybaMCPAssetHandler.h"
#include "HaybaMCPAssetRegistryQuery.h"
#include "Json.h"
#include "Editor.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/AssetData.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AutomatedAssetImportData.h"
#include "EditorAssetLibrary.h"
#include "EditorValidatorSubsystem.h"
#include "DataValidationModule.h"
#include "Misc/DataValidation.h"
#include "Logging/MessageLog.h"
#include "Logging/TokenizedMessage.h"
#include "Misc/UObjectToken.h"
#include "FileHelpers.h"
#include "Misc/PackageName.h"
#include "HAL/FileManager.h"
#include "ObjectTools.h"
#include "AssetRegistry/AssetRegistryHelpers.h"
#include "Misc/Base64.h"
#include "IImageWrapperModule.h"
#include "IImageWrapper.h"
#include "Modules/ModuleManager.h"
#include "HaybaMCPReflection.h"  // HaybaReflection::SetProp — generic reflection setter
#include "UObject/UnrealType.h"  // FProperty::ExportText_InContainer

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPAsset, Log, All);

TArray<FString> FHaybaMCPAssetHandler::GetCommands() const
{
    return {
        TEXT("asset_search"),
        TEXT("asset_registry_query"),
        TEXT("asset_get_info"),
        TEXT("asset_import"),
        TEXT("asset_duplicate"),
        TEXT("asset_delete"),
        TEXT("asset_get_references"),
        TEXT("asset_validate"),
        TEXT("asset_rename"),
        TEXT("asset_move"),
        TEXT("asset_fix_redirectors"),
        TEXT("asset_get_dependencies"),
        TEXT("asset_get_referencers"),
        TEXT("object_get_property"),
        TEXT("object_set_property"),
    };
}

FHaybaHandlerResult FHaybaMCPAssetHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("asset_search"))         return AssetSearch(P);
    if (Cmd == TEXT("asset_registry_query")) return AssetRegistryQuery(P);
    if (Cmd == TEXT("asset_get_info"))       return AssetGetInfo(P);
    if (Cmd == TEXT("asset_import"))         return AssetImport(P);
    if (Cmd == TEXT("asset_duplicate"))      return AssetDuplicate(P);
    if (Cmd == TEXT("asset_delete"))         return AssetDelete(P);
    if (Cmd == TEXT("asset_get_references")) return AssetGetReferences(P);
    if (Cmd == TEXT("asset_validate"))       return AssetValidate(P);
    if (Cmd == TEXT("asset_rename"))         return AssetRename(P);
    if (Cmd == TEXT("asset_move"))           return AssetMove(P);
    if (Cmd == TEXT("asset_fix_redirectors"))return AssetFixRedirectors(P);
    if (Cmd == TEXT("asset_get_dependencies"))return AssetGetDependencies(P);
    if (Cmd == TEXT("asset_get_referencers"))return AssetGetReferencers(P);
    if (Cmd == TEXT("object_get_property"))  return ObjectGetProperty(P);
    if (Cmd == TEXT("object_set_property"))  return ObjectSetProperty(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("AssetHandler: unknown command %s"), *Cmd));
}

namespace HaybaAssetRegistryQuery
{
namespace
{
bool ReadOptionalString(const TSharedPtr<FJsonObject>& Json, const TCHAR* Key, FString& Out, FString& Error)
{
    if (!Json->HasField(Key)) return true;
    if (!Json->HasTypedField<EJson::String>(Key) || !Json->TryGetStringField(Key, Out))
    {
        Error = FString::Printf(TEXT("asset_registry_query: %s must be a string"), Key);
        return false;
    }
    Out.TrimStartAndEndInline();
    if (Out.IsEmpty())
    {
        Error = FString::Printf(TEXT("asset_registry_query: %s must not be blank"), Key);
        return false;
    }
    return true;
}

bool ReadInteger(const TSharedPtr<FJsonObject>& Json, const TCHAR* Key, int32 DefaultValue,
    int32 Minimum, int32 Maximum, int32& Out, FString& Error)
{
    Out = DefaultValue;
    if (!Json->HasField(Key)) return true;
    double Value = 0.0;
    if (!Json->HasTypedField<EJson::Number>(Key) || !Json->TryGetNumberField(Key, Value) || !FMath::IsFinite(Value)
        || Value != FMath::FloorToDouble(Value) || Value < Minimum || Value > Maximum)
    {
        Error = FString::Printf(TEXT("asset_registry_query: %s must be an integer from %d to %d"),
            Key, Minimum, Maximum);
        return false;
    }
    Out = static_cast<int32>(Value);
    return true;
}
}

bool ParseParams(const TSharedPtr<FJsonObject>& Json, FParams& Out, FString& Error)
{
    Out = FParams{};
    if (!Json.IsValid())
    {
        Error = TEXT("asset_registry_query: params must be an object");
        return false;
    }
    if (!ReadOptionalString(Json, TEXT("class_filter"), Out.ClassFilter, Error)
        || !ReadOptionalString(Json, TEXT("name_contains"), Out.NameContains, Error)
        || !ReadOptionalString(Json, TEXT("path_prefix"), Out.PathPrefix, Error)
        || !ReadInteger(Json, TEXT("limit"), 50, 1, 500, Out.Limit, Error)
        || !ReadInteger(Json, TEXT("offset"), 0, 0, MAX_int32, Out.Offset, Error))
        return false;

    if (Json->HasField(TEXT("recursive"))
        && (!Json->HasTypedField<EJson::Boolean>(TEXT("recursive"))
            || !Json->TryGetBoolField(TEXT("recursive"), Out.bRecursive)))
    {
        Error = TEXT("asset_registry_query: recursive must be a boolean");
        return false;
    }
    if (!Out.PathPrefix.IsEmpty()
        && (!FPackageName::IsValidLongPackageName(Out.PathPrefix, true)
            || (Out.PathPrefix.Len() > 1 && Out.PathPrefix.EndsWith(TEXT("/")))))
    {
        Error = TEXT("asset_registry_query: path_prefix must be a long package path such as /Game/Meshes");
        return false;
    }
    return true;
}

bool ValidateRegistryRead(bool bSucceeded, FString& Error)
{
    if (bSucceeded) return true;
    Error = TEXT("asset_registry_query: AssetRegistry query failed");
    return false;
}

void FilterSortAndPage(const TArray<FRow>& Rows, const FParams& Params,
    TArray<FRow>& Page, int32& Total, bool& bHasMore, int32& NextOffset)
{
    TArray<FRow> Filtered;
    const FString PrefixWithSlash = Params.PathPrefix.IsEmpty() ? FString() : Params.PathPrefix + TEXT("/");
    for (const FRow& Row : Rows)
    {
        if (!Params.ClassFilter.IsEmpty() && Row.Class != Params.ClassFilter) continue;
        if (!Params.NameContains.IsEmpty() && !Row.Name.Contains(Params.NameContains, ESearchCase::IgnoreCase)) continue;
        if (!Params.PathPrefix.IsEmpty())
        {
            const FString Folder = FPackageName::GetLongPackagePath(Row.Path);
            const bool bPathMatches = Params.bRecursive
                ? (Folder.Equals(Params.PathPrefix, ESearchCase::IgnoreCase)
                    || Folder.StartsWith(PrefixWithSlash, ESearchCase::IgnoreCase))
                : Folder.Equals(Params.PathPrefix, ESearchCase::IgnoreCase);
            if (!bPathMatches) continue;
        }
        Filtered.Add(Row);
    }
    Filtered.Sort([](const FRow& A, const FRow& B)
    {
        const int32 PathOrder = A.Path.Compare(B.Path, ESearchCase::CaseSensitive);
        return PathOrder == 0 ? A.Name.Compare(B.Name, ESearchCase::CaseSensitive) < 0 : PathOrder < 0;
    });

    Total = Filtered.Num();
    Page.Reset();
    const int32 Start = FMath::Min(Params.Offset, Total);
    const int32 End = static_cast<int32>(
        FMath::Min<int64>(static_cast<int64>(Start) + Params.Limit, Total));
    for (int32 Index = Start; Index < End; ++Index) Page.Add(Filtered[Index]);
    NextOffset = End;
    bHasMore = End < Total;
}
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetRegistryQuery(const TSharedPtr<FJsonObject>& P)
{
    using namespace HaybaAssetRegistryQuery;
    FParams Params;
    FString Error;
    if (!ParseParams(P, Params, Error)) return FHaybaHandlerResult::Err(Error);

    IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    if (Registry.IsLoadingAssets())
        return FHaybaHandlerResult::Err(TEXT("asset_registry_query: AssetRegistry is still discovering assets; retry after it is ready"));

    TArray<FAssetData> AssetData;
    bool bQuerySucceeded = false;
    if (Params.PathPrefix.IsEmpty())
    {
        bQuerySucceeded = Registry.GetAllAssets(AssetData, false);
    }
    else
    {
        FARFilter Filter;
        Filter.PackagePaths.Add(FName(*Params.PathPrefix));
        Filter.bRecursivePaths = Params.bRecursive;
        bQuerySucceeded = Registry.GetAssets(Filter, AssetData);
    }
    if (!ValidateRegistryRead(bQuerySucceeded, Error)) return FHaybaHandlerResult::Err(Error);
    TArray<FRow> Rows;
    Rows.Reserve(AssetData.Num());
    for (const FAssetData& Asset : AssetData)
    {
        Rows.Add({Asset.AssetName.ToString(), Asset.PackageName.ToString(),
            Asset.AssetClassPath.GetAssetName().ToString()});
    }

    TArray<FRow> Page;
    int32 Total = 0;
    bool bHasMore = false;
    int32 NextOffset = 0;
    FilterSortAndPage(Rows, Params, Page, Total, bHasMore, NextOffset);

    TArray<TSharedPtr<FJsonValue>> Assets;
    Assets.Reserve(Page.Num());
    for (const FRow& Row : Page)
    {
        TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("name"), Row.Name);
        Item->SetStringField(TEXT("path"), Row.Path);
        Item->SetStringField(TEXT("class"), Row.Class);
        Assets.Add(MakeShared<FJsonValueObject>(Item));
    }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), true);
    Out->SetArrayField(TEXT("assets"), Assets);
    Out->SetNumberField(TEXT("total"), Total);
    Out->SetBoolField(TEXT("has_more"), bHasMore);
    Out->SetNumberField(TEXT("next_offset"), NextOffset);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// object_get_property / object_set_property — generic reflection on any loadable
// UObject (asset) by path. Replaces the scattered get_editor_property /
// set_editor_property python_run pokes with a first-class, typed tool.
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPAssetHandler::ObjectGetProperty(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("object_get_property: missing path"));
    UObject* Obj = FSoftObjectPath(Path).TryLoad();
    if (!Obj) return FHaybaHandlerResult::Err(FString::Printf(TEXT("object_get_property: cannot load %s"), *Path));

    // Optional explicit name list; otherwise dump all editable properties.
    TArray<FString> Wanted;
    const TArray<TSharedPtr<FJsonValue>>* NamesArr = nullptr;
    if (P->TryGetArrayField(TEXT("names"), NamesArr) && NamesArr)
        for (const TSharedPtr<FJsonValue>& V : *NamesArr) { FString S; if (V->TryGetString(S)) Wanted.Add(S); }

    TSharedPtr<FJsonObject> Props = MakeShared<FJsonObject>();
    for (TFieldIterator<FProperty> It(Obj->GetClass()); It; ++It)
    {
        FProperty* Prop = *It;
        if (Wanted.Num() == 0 && !Prop->HasAnyPropertyFlags(CPF_Edit)) continue;
        const FString Name = Prop->GetName();
        if (Wanted.Num() > 0 && !Wanted.ContainsByPredicate([&](const FString& W){ return W.Equals(Name, ESearchCase::IgnoreCase); })) continue;
        FString ValueStr;
        Prop->ExportText_InContainer(0, ValueStr, Obj, Obj, Obj, PPF_None);
        Props->SetStringField(Name, ValueStr);
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Path);
    Out->SetStringField(TEXT("class"), Obj->GetClass()->GetName());
    Out->SetObjectField(TEXT("properties"), Props);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::ObjectSetProperty(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("object_set_property: missing path"));
    const TSharedPtr<FJsonObject>* PropsObj = nullptr;
    if (!P->TryGetObjectField(TEXT("properties"), PropsObj) || !PropsObj->IsValid())
        return FHaybaHandlerResult::Err(TEXT("object_set_property: missing properties object"));
    UObject* Obj = FSoftObjectPath(Path).TryLoad();
    if (!Obj) return FHaybaHandlerResult::Err(FString::Printf(TEXT("object_set_property: cannot load %s"), *Path));

#if WITH_EDITOR
    Obj->Modify();
#endif
    TArray<TSharedPtr<FJsonValue>> Applied;
    TArray<TSharedPtr<FJsonValue>> Failed;
    for (const auto& Pair : (*PropsObj)->Values)
    {
        const FString Key = FString(*Pair.Key);
        if (HaybaReflection::SetProp(Obj, Key, Pair.Value)) Applied.Add(MakeShared<FJsonValueString>(Key));
        else Failed.Add(MakeShared<FJsonValueString>(Key));
    }
#if WITH_EDITOR
    Obj->PostEditChange();
#endif
    Obj->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Path);
    Out->SetArrayField(TEXT("applied"), Applied);
    if (Failed.Num() > 0) Out->SetArrayField(TEXT("failed"), Failed);
    Out->SetBoolField(TEXT("ok"), Failed.Num() == 0);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetSearch(const TSharedPtr<FJsonObject>& P)
{
    FString Path = TEXT("/Game");
    P->TryGetStringField(TEXT("path"), Path);
    FString NameFilter, ClassFilter;
    P->TryGetStringField(TEXT("name_filter"), NameFilter);
    P->TryGetStringField(TEXT("class_filter"), ClassFilter);

    // gh#15: optional thumbnail preview (base64 PNG). Off by default; capped at 50.
    bool bIncludeThumbnails = false;
    P->TryGetBoolField(TEXT("include_thumbnails"), bIncludeThumbnails);
    int32 ThumbSize = 256;
    {
        int32 ReqSize = 0;
        if (P->TryGetNumberField(TEXT("thumbnail_size"), ReqSize) && ReqSize > 0)
            ThumbSize = FMath::Clamp(ReqSize, 32, 1024);
    }
    const int32 ThumbnailCap = 50;
    int32 ThumbnailsEmitted = 0;

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    TArray<FAssetData> Assets;
    AR.GetAssetsByPath(FName(*Path), Assets, /*Recursive*/true);

    const int32 Cap = 200;
    TArray<TSharedPtr<FJsonValue>> Out;
    bool bCapped = false;
    for (const FAssetData& A : Assets)
    {
        if (!NameFilter.IsEmpty() && !A.PackageName.ToString().Contains(NameFilter)) continue;
        if (!ClassFilter.IsEmpty()
            && A.AssetClassPath.GetAssetName().ToString() != ClassFilter
            && A.AssetClassPath.ToString() != ClassFilter) continue;

        if (Out.Num() >= Cap) { bCapped = true; break; }

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"),  A.AssetName.ToString());
        Entry->SetStringField(TEXT("path"),  A.GetObjectPathString());
        Entry->SetStringField(TEXT("class"), A.AssetClassPath.GetAssetName().ToString());
        if (bIncludeThumbnails && ThumbnailsEmitted < ThumbnailCap)
        {
            const FString B64 = GetAssetThumbnailBase64Png(A, ThumbSize);
            if (!B64.IsEmpty())
            {
                Entry->SetStringField(TEXT("thumbnail_b64"), B64);
                ++ThumbnailsEmitted;
            }
        }
        Out.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("assets"), Out);
    Result->SetNumberField(TEXT("count"), Out.Num());
    Result->SetBoolField(TEXT("capped"), bCapped);
    if (bIncludeThumbnails)
    {
        Result->SetNumberField(TEXT("thumbnails_emitted"), ThumbnailsEmitted);
        Result->SetBoolField(TEXT("thumbnails_capped"), ThumbnailsEmitted >= ThumbnailCap);
    }
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetGetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_get_info: missing path"));

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    // Accept package paths as well as canonical object paths. SoundWave imports
    // commonly return /Game/Audio/Foo while AssetRegistry expects
    // /Game/Audio/Foo.Foo here.
    Path.TrimStartAndEndInline();
    if (!Path.Contains(TEXT(".")) && Path.StartsWith(TEXT("/")))
        Path += TEXT(".") + FPackageName::GetShortName(Path);
    FAssetData Data = AR.GetAssetByObjectPath(FSoftObjectPath(Path));
    if (!Data.IsValid())
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("asset_get_info: asset not found: %s"), *Path));

    TSharedPtr<FJsonObject> Tags = MakeShared<FJsonObject>();
    for (const auto& Pair : Data.TagsAndValues)
    {
        Tags->SetStringField(Pair.Key.ToString(), Pair.Value.GetValue());
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("name"),         Data.AssetName.ToString());
    Out->SetStringField(TEXT("package_name"), Data.PackageName.ToString());
    Out->SetStringField(TEXT("asset_class"),  Data.AssetClassPath.GetAssetName().ToString());
    Out->SetObjectField(TEXT("tags"),         Tags);

    // gh#15: optional thumbnail preview (base64 PNG).
    bool bIncludeThumbnails = false;
    P->TryGetBoolField(TEXT("include_thumbnails"), bIncludeThumbnails);
    if (bIncludeThumbnails)
    {
        int32 ThumbSize = 256;
        int32 ReqSize = 0;
        if (P->TryGetNumberField(TEXT("thumbnail_size"), ReqSize) && ReqSize > 0)
            ThumbSize = FMath::Clamp(ReqSize, 32, 1024);
        const FString B64 = GetAssetThumbnailBase64Png(Data, ThumbSize);
        if (!B64.IsEmpty())
            Out->SetStringField(TEXT("thumbnail_b64"), B64);
    }
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetImport(const TSharedPtr<FJsonObject>& P)
{
    FString SourceFile, DestPath;
    if (!P->TryGetStringField(TEXT("source_file"), SourceFile) || SourceFile.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_import: missing source_file"));
    if (!P->TryGetStringField(TEXT("destination_path"), DestPath) || DestPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_import: missing destination_path"));

    UAutomatedAssetImportData* ImportData = NewObject<UAutomatedAssetImportData>();
    ImportData->Filenames.Add(SourceFile);
    ImportData->DestinationPath = DestPath;
    ImportData->bReplaceExisting = true;

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    TArray<UObject*> Imported = Tools.ImportAssetsAutomated(ImportData);
    if (Imported.Num() == 0)
        return FHaybaHandlerResult::Err(TEXT("asset_import: ImportAssetsAutomated returned no assets"));

    TArray<TSharedPtr<FJsonValue>> Paths;
    for (UObject* Obj : Imported)
    {
        if (Obj) Paths.Add(MakeShared<FJsonValueString>(Obj->GetPathName()));
    }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("imported"), Paths);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetDuplicate(const TSharedPtr<FJsonObject>& P)
{
    FString Src, Dst;
    if (!P->TryGetStringField(TEXT("source_path"), Src) || Src.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_duplicate: missing source_path"));
    if (!P->TryGetStringField(TEXT("destination_path"), Dst) || Dst.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_duplicate: missing destination_path"));

    UObject* New = UEditorAssetLibrary::DuplicateAsset(Src, Dst);
    if (!New)
        return FHaybaHandlerResult::Err(TEXT("asset_duplicate: DuplicateAsset failed"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("new_path"), New->GetPathName());
    return FHaybaHandlerResult::Ok(Out);
}

// Delete assets, and confirm on the FILESYSTEM that they are gone.
//
// The asset registry and the disk can disagree, and when they do the registry
// is the one that lies. Reproduced 2026-07-30: after a force-delete invalidated
// a neighbour, `does_asset_exist` returned false for an asset whose .uasset was
// still on disk, and a subsequent DeleteAsset returned false because the
// registry could no longer find it. The file is then orphaned — invisible to
// every registry query, permanently present on disk.
//
// That is why verification here reads the filesystem. Anything that checks
// does_asset_exist after deleting is asking the component that was already
// wrong, and will report success for files it never removed. A batch loop doing
// that is how "34 deleted" came back with 34 files still on disk.
static FString PackageFileOnDisk(const FString& AssetPath)
{
    // Accept /Game/X/Y or /Game/X/Y.Y — the object suffix is not part of the
    // package name and breaks the filename lookup if left on.
    FString PackageName = AssetPath;
    int32 Dot;
    if (PackageName.FindChar(TEXT('.'), Dot)) PackageName.LeftInline(Dot);

    FString Filename;
    if (!FPackageName::TryConvertLongPackageNameToFilename(
            PackageName, Filename, FPackageName::GetAssetPackageExtension()))
    {
        return FString();
    }
    return Filename;
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetDelete(const TSharedPtr<FJsonObject>& P)
{
    // Accept one path or many. Deleting a set is the real use, and doing it one
    // call at a time is what made a partial failure look like a clean sweep.
    TArray<FString> Paths;
    FString Single;
    if (P->TryGetStringField(TEXT("path"), Single) && !Single.IsEmpty())
    {
        Paths.Add(Single);
    }
    const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
    if (P->TryGetArrayField(TEXT("paths"), Arr) && Arr)
    {
        for (const TSharedPtr<FJsonValue>& V : *Arr)
        {
            const FString S = V->AsString();
            if (!S.IsEmpty()) Paths.Add(S);
        }
    }
    if (Paths.Num() == 0)
        return FHaybaHandlerResult::Err(TEXT("asset_delete: give `path` (string) or `paths` (array of strings)"));

    TArray<TSharedPtr<FJsonValue>> Results;
    int32 DeletedCount = 0;
    int32 StillOnDisk = 0;
    TArray<FString> Orphans;

    for (const FString& Path : Paths)
    {
        TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("path"), Path);

        const FString File = PackageFileOnDisk(Path);
        const bool bFileBefore = !File.IsEmpty() && IFileManager::Get().FileExists(*File);
        const bool bRegistryBefore = UEditorAssetLibrary::DoesAssetExist(Path);
        E->SetBoolField(TEXT("existed_on_disk"), bFileBefore);
        E->SetBoolField(TEXT("existed_in_registry"), bRegistryBefore);

        // An asset the registry has lost but whose file remains cannot be
        // deleted through the asset APIs at all — say so instead of returning a
        // bare false the caller will read as "already gone".
        if (!bRegistryBefore && bFileBefore)
        {
            E->SetBoolField(TEXT("deleted"), false);
            E->SetStringField(TEXT("reason"),
                TEXT("ORPHANED: the asset registry does not know this asset but its .uasset is on disk, so the "
                     "asset APIs cannot delete it. Usually caused by an earlier force-delete invalidating it. "
                     "It must be removed from disk directly, then the registry rescanned."));
            E->SetStringField(TEXT("file"), File);
            Results.Add(MakeShared<FJsonValueObject>(E));
            ++StillOnDisk;
            Orphans.Add(Path);
            continue;
        }

        const bool bReported = UEditorAssetLibrary::DeleteAsset(Path);
        const bool bFileAfter = !File.IsEmpty() && IFileManager::Get().FileExists(*File);

        E->SetBoolField(TEXT("engine_reported_deleted"), bReported);
        E->SetBoolField(TEXT("file_gone"), !bFileAfter);
        if (!File.IsEmpty()) E->SetStringField(TEXT("file"), File);

        // `deleted` means the FILE is gone. Nothing else is deletion.
        const bool bReallyDeleted = bFileBefore && !bFileAfter;
        E->SetBoolField(TEXT("deleted"), bReallyDeleted);

        if (bReallyDeleted)
        {
            ++DeletedCount;
        }
        else if (bFileAfter)
        {
            ++StillOnDisk;
            E->SetStringField(TEXT("reason"), bReported
                ? TEXT("The engine reported success but the .uasset is STILL ON DISK. The file may be read-only "
                       "or locked (source control, another process), or the delete was only applied in memory.")
                : TEXT("The engine refused the delete and the .uasset is still on disk. Check asset_get_references "
                       "— a referenced asset needs the references cleared first."));
        }
        else if (!bFileBefore)
        {
            E->SetStringField(TEXT("reason"), TEXT("Nothing to delete: no .uasset at this path."));
        }

        Results.Add(MakeShared<FJsonValueObject>(E));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("requested"), Paths.Num());
    Out->SetNumberField(TEXT("deleted_count"), DeletedCount);
    Out->SetNumberField(TEXT("still_on_disk_count"), StillOnDisk);
    Out->SetArrayField(TEXT("results"), Results);

    if (StillOnDisk > 0)
    {
        Out->SetStringField(TEXT("warning"), FString::Printf(
            TEXT("%d of %d assets are STILL ON DISK. deleted_count counts files actually removed, verified on the "
                 "filesystem — do NOT read `requested` as a success count, and do NOT verify a delete with "
                 "does_asset_exist: the registry can report an asset gone while its file remains."),
            StillOnDisk, Paths.Num()));
    }

    // Every path failed → this is a failure, not a partial success.
    if (DeletedCount == 0 && Paths.Num() > 0)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("asset_delete: nothing was deleted (%d requested, %d still on disk). See the per-path reasons."),
            Paths.Num(), StillOnDisk));
    }

    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetGetReferences(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_get_references: missing path"));

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

    // Convert object path -> package name
    FString PackageName = Path;
    int32 Dot;
    if (PackageName.FindChar('.', Dot)) PackageName = PackageName.Left(Dot);

    TArray<FName> Referencers;
    AR.GetReferencers(FName(*PackageName), Referencers);
    TArray<FName> Dependencies;
    AR.GetDependencies(FName(*PackageName), Dependencies);

    const int32 Cap = 100;
    TArray<TSharedPtr<FJsonValue>> RefArr, DepArr;
    const bool bRefCapped = Referencers.Num() > Cap;
    const bool bDepCapped = Dependencies.Num() > Cap;
    for (int32 i = 0; i < Referencers.Num() && i < Cap; ++i)
        RefArr.Add(MakeShared<FJsonValueString>(Referencers[i].ToString()));
    for (int32 i = 0; i < Dependencies.Num() && i < Cap; ++i)
        DepArr.Add(MakeShared<FJsonValueString>(Dependencies[i].ToString()));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("referencers"),  RefArr);
    Out->SetArrayField(TEXT("dependencies"), DepArr);
    Out->SetBoolField(TEXT("capped"), bRefCapped || bDepCapped);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetValidate(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_validate: missing path"));

    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("asset_validate: GEditor unavailable"));

    UEditorValidatorSubsystem* Validator = GEditor->GetEditorSubsystem<UEditorValidatorSubsystem>();
    if (!Validator)
        return FHaybaHandlerResult::Err(TEXT("asset_validate: EditorValidatorSubsystem unavailable"));

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    Path.TrimStartAndEndInline();
    TArray<FAssetData> ToValidate;

    // The public contract accepts either an asset or a folder. For an asset,
    // normalize the common package-only spelling (/Game/A/B) to the canonical
    // object path (/Game/A/B.B). Appending the full package name produced the
    // malformed `/Game/A/B./Game/A/B` load observed with imported SoundWaves.
    FString ObjectPath = Path;
    if (!ObjectPath.Contains(TEXT(".")) && ObjectPath.StartsWith(TEXT("/")))
        ObjectPath += TEXT(".") + FPackageName::GetShortName(ObjectPath);
    FAssetData Data = AR.GetAssetByObjectPath(FSoftObjectPath(ObjectPath));
    if (Data.IsValid())
    {
        ToValidate.Add(Data);
    }
    else
    {
        AR.GetAssetsByPath(FName(*Path), ToValidate, /*bRecursive*/true);
    }
    if (ToValidate.IsEmpty())
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("asset_validate: asset or folder not found: %s"), *Path));
    FValidateAssetsSettings Settings;
    Settings.bSkipExcludedDirectories = true;
    Settings.bCollectPerAssetDetails = true;
    Settings.ValidationUsecase = EDataValidationUsecase::Manual;

    // Spin up a fresh AssetCheck message-log page so we can capture per-message
    // results emitted by validators (the FValidateAssetsResults summary only
    // exposes counts in this UE version).
    FMessageLog AssetCheckLog("AssetCheck");
    AssetCheckLog.NewPage(FText::FromString(TEXT("Hayba asset_validate")));

    FValidateAssetsResults Results;
    Validator->ValidateAssetsWithSettings(ToValidate, Settings, Results);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("valid"), Results.NumInvalid == 0);
    Out->SetNumberField(TEXT("num_valid"),   Results.NumValid);
    Out->SetNumberField(TEXT("num_invalid"), Results.NumInvalid);
    Out->SetNumberField(TEXT("num_warnings"), Results.NumWarnings);
    Out->SetNumberField(TEXT("num_requested"), Results.NumRequested);
    Out->SetNumberField(TEXT("num_checked"), Results.NumChecked);
    Out->SetNumberField(TEXT("num_skipped"), Results.NumSkipped);
    Out->SetNumberField(TEXT("num_unable_to_validate"), Results.NumUnableToValidate);

    TArray<TSharedPtr<FJsonValue>> Errors, Warnings, AssetResults;
    for (const TPair<FString, FValidateAssetsDetails>& Pair : Results.AssetsDetails)
    {
        TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
        Detail->SetStringField(TEXT("path"), Pair.Key);
        Detail->SetStringField(TEXT("result"), StaticEnum<EDataValidationResult>()->GetNameStringByValue(static_cast<int64>(Pair.Value.Result)));
        TArray<TSharedPtr<FJsonValue>> DetailErrors, DetailWarnings;
        for (const FText& Message : Pair.Value.ValidationErrors)
        {
            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>(); Entry->SetStringField(TEXT("path"), Pair.Key); Entry->SetStringField(TEXT("message"), Message.ToString());
            Errors.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef())); DetailErrors.Add(MakeShared<FJsonValueString>(Message.ToString()));
        }
        for (const FText& Message : Pair.Value.ValidationWarnings)
        {
            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>(); Entry->SetStringField(TEXT("path"), Pair.Key); Entry->SetStringField(TEXT("message"), Message.ToString());
            Warnings.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef())); DetailWarnings.Add(MakeShared<FJsonValueString>(Message.ToString()));
        }
        Detail->SetArrayField(TEXT("errors"), DetailErrors); Detail->SetArrayField(TEXT("warnings"), DetailWarnings); AssetResults.Add(MakeShared<FJsonValueObject>(Detail.ToSharedRef()));
    }
    Out->SetArrayField(TEXT("errors"), Errors);
    Out->SetArrayField(TEXT("warnings"), Warnings);
    Out->SetArrayField(TEXT("assets"), AssetResults);
    Out->SetBoolField(TEXT("details_available"), true);
    Out->SetBoolField(TEXT("details_in_message_log"),
        Results.NumInvalid > 0 || Results.NumWarnings > 0);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetRename(const TSharedPtr<FJsonObject>& P)
{
    FString Path, NewName;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_rename: missing path"));
    if (!P->TryGetStringField(TEXT("new_name"), NewName) || NewName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_rename: missing new_name"));

    // Build new path = directory + / + new_name
    FString PackageName = Path;
    int32 Dot;
    if (PackageName.FindChar('.', Dot)) PackageName = PackageName.Left(Dot);

    FString Dir = FPackageName::GetLongPackagePath(PackageName);
    FString NewPath = Dir + TEXT("/") + NewName;

    bool bRenamed = UEditorAssetLibrary::RenameAsset(Path, NewPath);
    if (!bRenamed)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("asset_rename: RenameAsset failed (%s -> %s)"), *Path, *NewPath));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("old_path"), Path);
    Out->SetStringField(TEXT("new_path"), NewPath);
    return FHaybaHandlerResult::Ok(Out);
}

// Initiative #6: reference-preserving move using IAssetTools::RenameAssets.
// Unlike UEditorAssetLibrary::RenameAsset, IAssetTools updates referencers
// in-place so the project doesn't leak redirectors after every AI mutation.
FHaybaHandlerResult FHaybaMCPAssetHandler::AssetMove(const TSharedPtr<FJsonObject>& P)
{
    FString Path, TargetDir;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_move: missing path"));
    if (!P->TryGetStringField(TEXT("target_dir"), TargetDir) || TargetDir.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_move: missing target_dir"));

    FString PackageName = Path;
    int32 Dot;
    if (PackageName.FindChar('.', Dot)) PackageName = PackageName.Left(Dot);

    UObject* Asset = UEditorAssetLibrary::LoadAsset(Path);
    if (!Asset)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("asset_move: could not load %s"), *Path));

    const FString AssetName  = FPackageName::GetShortName(PackageName);
    const FString NewPackage = TargetDir / AssetName;

    FAssetToolsModule& M = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools");
    TArray<FAssetRenameData> Renames;
    Renames.Emplace(Asset, TargetDir, AssetName);
    const bool bOk = M.Get().RenameAssets(Renames);

    auto Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), bOk);
    Out->SetStringField(TEXT("old_path"), Path);
    Out->SetStringField(TEXT("new_path"), NewPackage);
    if (!bOk) return FHaybaHandlerResult::Err(FString::Printf(TEXT("asset_move: RenameAssets failed (%s)"), *Path));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetFixRedirectors(const TSharedPtr<FJsonObject>& P)
{
    FString Path = TEXT("/Game");
    P->TryGetStringField(TEXT("path"), Path);

    IAssetRegistry& Reg = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
    FARFilter Filter;
    Filter.bRecursivePaths = true;
    Filter.bRecursiveClasses = true;
    Filter.PackagePaths.Add(*Path);
    Filter.ClassPaths.Add(UObjectRedirector::StaticClass()->GetClassPathName());
    TArray<FAssetData> Redirectors;
    Reg.GetAssets(Filter, Redirectors);

    TArray<UObjectRedirector*> Objs;
    for (const FAssetData& AD : Redirectors)
        if (UObjectRedirector* R = Cast<UObjectRedirector>(AD.GetAsset())) Objs.Add(R);

    if (Objs.Num() > 0)
    {
        FAssetToolsModule& M = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools");
        M.Get().FixupReferencers(Objs);
    }

    auto Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("fixed_count"), Objs.Num());
    Out->SetStringField(TEXT("path"), Path);
    return FHaybaHandlerResult::Ok(Out);
}

// Initiative #10: asset dependency graph. Returns assets THIS asset depends on
// (its includes) — useful for AI to assess what edits to a base material would
// ripple to.
FHaybaHandlerResult FHaybaMCPAssetHandler::AssetGetDependencies(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_get_dependencies: missing path"));

    FString PackageName = Path;
    int32 Dot;
    if (PackageName.FindChar('.', Dot)) PackageName = PackageName.Left(Dot);

    IAssetRegistry& Reg = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
    TArray<FName> Deps;
    Reg.GetDependencies(FName(*PackageName), Deps);

    TArray<TSharedPtr<FJsonValue>> Items;
    for (const FName& D : Deps) Items.Add(MakeShared<FJsonValueString>(D.ToString()));

    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Path);
    Out->SetArrayField(TEXT("dependencies"), Items);
    Out->SetNumberField(TEXT("count"), Items.Num());
    return FHaybaHandlerResult::Ok(Out);
}

// gh#15: render an asset's stored/generated thumbnail as a base64-encoded PNG.
// Uses ThumbnailTools to load from the package; falls back to generating one
// if the package has no cached thumbnail. Returns "" on any failure.
FString FHaybaMCPAssetHandler::GetAssetThumbnailBase64Png(const FAssetData& AssetData, int32 Size)
{
    if (!AssetData.IsValid()) return FString();

    // Render an in-memory thumbnail from the loaded asset. We deliberately avoid
    // ThumbnailTools::LoadThumbnailsFromPackage / ConditionallyLoadThumbnailsForObjects
    // (API surface drifts between UE 5.x minor versions) and just always render —
    // mirrors the pattern used by McpAutomationBridge in this same project.
    UObject* Asset = AssetData.GetAsset();
    if (!Asset) return FString();

    FObjectThumbnail Generated;
    ThumbnailTools::RenderThumbnail(
        Asset,
        Size, Size,
        ThumbnailTools::EThumbnailTextureFlushMode::NeverFlush,
        nullptr,
        &Generated);

    const TArray<uint8>& Raw = Generated.GetUncompressedImageData();
    const int32 W = Generated.GetImageWidth();
    const int32 H = Generated.GetImageHeight();
    if (Raw.Num() == 0 || W <= 0 || H <= 0) return FString();

    IImageWrapperModule& ImageWrapperModule =
        FModuleManager::LoadModuleChecked<IImageWrapperModule>(FName("ImageWrapper"));
    TSharedPtr<IImageWrapper> PngWrapper =
        ImageWrapperModule.CreateImageWrapper(EImageFormat::PNG);
    if (!PngWrapper.IsValid()) return FString();

    // FObjectThumbnail stores BGRA8 (per engine convention).
    if (!PngWrapper->SetRaw(Raw.GetData(), Raw.Num(), W, H, ERGBFormat::BGRA, 8))
        return FString();

    const TArray64<uint8>& Compressed = PngWrapper->GetCompressed(85);
    if (Compressed.Num() == 0) return FString();

    // FBase64::Encode wants TArray<uint8>; copy from 64-bit array.
    TArray<uint8> Compressed32;
    Compressed32.Append(Compressed.GetData(), Compressed.Num());
    return FBase64::Encode(Compressed32);
}

// Reverse direction — who references THIS asset. The blast-radius query.
FHaybaHandlerResult FHaybaMCPAssetHandler::AssetGetReferencers(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_get_referencers: missing path"));

    FString PackageName = Path;
    int32 Dot;
    if (PackageName.FindChar('.', Dot)) PackageName = PackageName.Left(Dot);

    IAssetRegistry& Reg = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
    TArray<FName> Refs;
    Reg.GetReferencers(FName(*PackageName), Refs);

    TArray<TSharedPtr<FJsonValue>> Items;
    for (const FName& R : Refs) Items.Add(MakeShared<FJsonValueString>(R.ToString()));

    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Path);
    Out->SetArrayField(TEXT("referencers"), Items);
    Out->SetNumberField(TEXT("count"), Items.Num());
    return FHaybaHandlerResult::Ok(Out);
}
