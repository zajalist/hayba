#include "HaybaMCPAssetHandler.h"
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

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPAsset, Log, All);

TArray<FString> FHaybaMCPAssetHandler::GetCommands() const
{
    return {
        TEXT("asset_search"),
        TEXT("asset_get_info"),
        TEXT("asset_import"),
        TEXT("asset_duplicate"),
        TEXT("asset_delete"),
        TEXT("asset_get_references"),
        TEXT("asset_validate"),
        TEXT("asset_rename"),
    };
}

FHaybaHandlerResult FHaybaMCPAssetHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("asset_search"))         return AssetSearch(P);
    if (Cmd == TEXT("asset_get_info"))       return AssetGetInfo(P);
    if (Cmd == TEXT("asset_import"))         return AssetImport(P);
    if (Cmd == TEXT("asset_duplicate"))      return AssetDuplicate(P);
    if (Cmd == TEXT("asset_delete"))         return AssetDelete(P);
    if (Cmd == TEXT("asset_get_references")) return AssetGetReferences(P);
    if (Cmd == TEXT("asset_validate"))       return AssetValidate(P);
    if (Cmd == TEXT("asset_rename"))         return AssetRename(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("AssetHandler: unknown command %s"), *Cmd));
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetSearch(const TSharedPtr<FJsonObject>& P)
{
    FString Path = TEXT("/Game");
    P->TryGetStringField(TEXT("path"), Path);
    FString NameFilter, ClassFilter;
    P->TryGetStringField(TEXT("name_filter"), NameFilter);
    P->TryGetStringField(TEXT("class_filter"), ClassFilter);

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
        Out.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("assets"), Out);
    Result->SetNumberField(TEXT("count"), Out.Num());
    Result->SetBoolField(TEXT("capped"), bCapped);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetGetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_get_info: missing path"));

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
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

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetDelete(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("asset_delete: missing path"));

    bool bDeleted = UEditorAssetLibrary::DeleteAsset(Path);
    if (!bDeleted)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("asset_delete: failed for %s"), *Path));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("deleted"), true);
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
    FAssetData Data = AR.GetAssetByObjectPath(FSoftObjectPath(Path));
    if (!Data.IsValid())
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("asset_validate: asset not found: %s"), *Path));

    TArray<FAssetData> ToValidate = { Data };
    FValidateAssetsSettings Settings;
    Settings.bSkipExcludedDirectories = true;
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

    // FMessageLog::GetMessages is not part of the public API across UE 5.x, so
    // we cannot portably extract individual tokenized messages here. Surface a
    // hint so callers know to consult the editor's Message Log → Asset Check.
    // TODO(v1.1): wire up message capture when the API stabilizes (e.g. via a
    // custom IMessageLogListing or by iterating Results.AssetsResults once that
    // surface is consistently available).
    Out->SetArrayField(TEXT("errors"),   TArray<TSharedPtr<FJsonValue>>());
    Out->SetArrayField(TEXT("warnings"), TArray<TSharedPtr<FJsonValue>>());
    Out->SetBoolField(TEXT("details_available"), false);
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
