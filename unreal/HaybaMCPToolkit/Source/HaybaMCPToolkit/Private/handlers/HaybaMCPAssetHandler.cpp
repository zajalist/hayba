#include "HaybaMCPAssetHandler.h"
#include "HaybaMCPSaveVerify.h"
#include "HaybaMCPAssetRegistryQuery.h"
#include "Json.h"
#include "Editor.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/AssetData.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AutomatedAssetImportData.h"
#include "Factories/Factory.h"
#include "Factories/TextureFactory.h"
#include "Factories/FbxFactory.h"
#include "Factories/FbxImportUI.h"
#include "Factories/FbxStaticMeshImportData.h"
#include "Factories/FbxSkeletalMeshImportData.h"
#include "Factories/FbxAnimSequenceImportData.h"
#include "Engine/SkeletalMesh.h"
#include "Animation/Skeleton.h"
#include "Animation/AnimSequence.h"
#include "PhysicsEngine/PhysicsAsset.h"
#include "Materials/MaterialInterface.h"
#include "AssetImportTask.h"
#include "HaybaMCPDeveloperSettings.h"
#include "Factories/SoundFactory.h"
#include "Engine/Texture2D.h"
#include "Engine/StaticMesh.h"
#include "Sound/SoundWave.h"
#include "EditorAssetLibrary.h"
#include "EditorValidatorSubsystem.h"
#include "DataValidationModule.h"
#include "Misc/DataValidation.h"
#include "Logging/MessageLog.h"
#include "Logging/TokenizedMessage.h"
#include "Misc/UObjectToken.h"
#include "FileHelpers.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "HAL/PlatformProcess.h"
#include "HAL/FileManager.h"
#include "ObjectTools.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "AssetRegistry/AssetRegistryHelpers.h"
#include "Misc/Base64.h"
#include "Misc/CoreMisc.h"
#include "IImageWrapperModule.h"
#include "IImageWrapper.h"
#include "Modules/ModuleManager.h"
#include "HaybaMCPReflection.h"  // HaybaReflection::SetProp — generic reflection setter
#include "UObject/UnrealType.h"  // FProperty::ExportText_InContainer
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/SavePackage.h"
#include "UObject/UObjectHash.h"
#include "UObject/GarbageCollection.h"
#include "Engine/Blueprint.h"
#include "HaybaMCPParams.h"

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPAsset, Log, All);

TArray<FString> FHaybaMCPAssetHandler::GetCommands() const
{
    return {
        TEXT("asset_search"),
        TEXT("asset_registry_query"),
        TEXT("asset_get_info"),
        TEXT("asset_import"),
        TEXT("asset_save"),
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
    if (Cmd == TEXT("asset_save"))           return AssetSave(P);
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

namespace HaybaAssetImport
{
namespace
{
constexpr int64 MaxTextureBytes = 64ll * 1024ll * 1024ll;
constexpr int64 MaxWaveBytes = 128ll * 1024ll * 1024ll;
constexpr int64 MaxFbxBytes = 256ll * 1024ll * 1024ll;
constexpr uint32 MaxImageDimension = 8192;
constexpr uint64 MaxImagePixels = 64ull * 1024ull * 1024ull;

bool HasControlCharacter(const FString& Value)
{
    for (const TCHAR Character : Value)
    {
        if (Character < 0x20 || Character == 0x7f) return true;
    }
    return false;
}

bool IsAsciiAssetName(const FString& Value)
{
    if (Value.IsEmpty() || Value.Len() > 64) return false;
    const auto IsAlpha = [](TCHAR C)
    {
        return (C >= TEXT('A') && C <= TEXT('Z')) || (C >= TEXT('a') && C <= TEXT('z'));
    };
    const auto IsDigit = [](TCHAR C) { return C >= TEXT('0') && C <= TEXT('9'); };
    if (!IsAlpha(Value[0])) return false;
    for (const TCHAR Character : Value)
    {
        if (!IsAlpha(Character) && !IsDigit(Character) && Character != TEXT('_')) return false;
    }
    return true;
}

uint16 ReadLe16(TConstArrayView<uint8> Bytes, int32 Offset)
{
    return static_cast<uint16>(Bytes[Offset])
        | (static_cast<uint16>(Bytes[Offset + 1]) << 8);
}

uint32 ReadLe32(TConstArrayView<uint8> Bytes, int32 Offset)
{
    return static_cast<uint32>(Bytes[Offset])
        | (static_cast<uint32>(Bytes[Offset + 1]) << 8)
        | (static_cast<uint32>(Bytes[Offset + 2]) << 16)
        | (static_cast<uint32>(Bytes[Offset + 3]) << 24);
}

uint32 ReadBe32(TConstArrayView<uint8> Bytes, int32 Offset)
{
    return (static_cast<uint32>(Bytes[Offset]) << 24)
        | (static_cast<uint32>(Bytes[Offset + 1]) << 16)
        | (static_cast<uint32>(Bytes[Offset + 2]) << 8)
        | static_cast<uint32>(Bytes[Offset + 3]);
}

bool ValidateImageDimensions(uint32 Width, uint32 Height, FString& Error)
{
    if (Width == 0 || Height == 0 || Width > MaxImageDimension || Height > MaxImageDimension
        || static_cast<uint64>(Width) * static_cast<uint64>(Height) > MaxImagePixels)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: image dimensions exceed the 8192x8192 / 64-Mpixel policy");
        return false;
    }
    return true;
}

bool ValidatePng(TConstArrayView<uint8> Header, FString& Error)
{
    static constexpr uint8 Signature[] = { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a };
    if (Header.Num() < 33 || FMemory::Memcmp(Header.GetData(), Signature, UE_ARRAY_COUNT(Signature)) != 0
        || ReadBe32(Header, 8) != 13 || FMemory::Memcmp(Header.GetData() + 12, "IHDR", 4) != 0)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: .png requires a canonical PNG signature and first IHDR chunk");
        return false;
    }
    if (Header[24] != 8 || (Header[25] != 0 && Header[25] != 2 && Header[25] != 4 && Header[25] != 6)
        || Header[26] != 0 || Header[27] != 0 || Header[28] > 1)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: PNG bit depth, colour type, compression, filter, or interlace policy is unsupported");
        return false;
    }
    return ValidateImageDimensions(ReadBe32(Header, 16), ReadBe32(Header, 20), Error);
}

bool IsJpegSof(uint8 Marker)
{
    // Limit the native decoder surface to ordinary Huffman baseline and
    // progressive frames. Lossless, differential, and arithmetic JPEG modes
    // are unnecessary for connector textures and exercise different parsers.
    return Marker == 0xc0 || Marker == 0xc2;
}

bool ValidateJpeg(TConstArrayView<uint8> Header, FString& Error)
{
    if (Header.Num() < 12 || Header[0] != 0xff || Header[1] != 0xd8 || Header[2] != 0xff)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: .jpg/.jpeg requires a JPEG SOI signature");
        return false;
    }
    int32 Cursor = 2;
    while (Cursor + 4 <= Header.Num())
    {
        if (Header[Cursor] != 0xff) break;
        while (Cursor < Header.Num() && Header[Cursor] == 0xff) ++Cursor;
        if (Cursor >= Header.Num()) break;
        const uint8 Marker = Header[Cursor++];
        if (Marker == 0xd9 || Marker == 0xda) break;
        if (Marker == 0x01 || (Marker >= 0xd0 && Marker <= 0xd7)) continue;
        if (Cursor + 2 > Header.Num()) break;
        const uint16 SegmentBytes = static_cast<uint16>(Header[Cursor] << 8) | Header[Cursor + 1];
        if (SegmentBytes < 2 || Cursor + SegmentBytes > Header.Num()) break;
        if (IsJpegSof(Marker))
        {
            if (SegmentBytes < 11 || Header[Cursor + 2] != 8)
            {
                Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: JPEG must use an 8-bit bounded baseline/progressive SOF frame");
                return false;
            }
            const uint8 Components = Header[Cursor + 7];
            if ((Components != 1 && Components != 3)
                || SegmentBytes != static_cast<uint16>(8 + 3 * Components))
            {
                Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: JPEG SOF must contain exactly one grayscale or three colour components");
                return false;
            }
            const uint32 Height = static_cast<uint32>(Header[Cursor + 3] << 8) | Header[Cursor + 4];
            const uint32 Width = static_cast<uint32>(Header[Cursor + 5] << 8) | Header[Cursor + 6];
            return ValidateImageDimensions(Width, Height, Error);
        }
        Cursor += SegmentBytes;
    }
    Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: JPEG SOF dimensions were not found in the bounded 64-KiB header window");
    return false;
}

bool ValidateWave(TConstArrayView<uint8> Header, int64 FileBytes, FString& Error)
{
    if (Header.Num() < 44 || FMemory::Memcmp(Header.GetData(), "RIFF", 4) != 0
        || FMemory::Memcmp(Header.GetData() + 8, "WAVE", 4) != 0
        || static_cast<uint64>(ReadLe32(Header, 4)) + 8ull != static_cast<uint64>(FileBytes))
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: .wav requires one size-consistent RIFF/WAVE container");
        return false;
    }
    bool bFoundFormat = false;
    bool bFoundData = false;
    int32 Cursor = 12;
    while (Cursor + 8 <= Header.Num())
    {
        const uint32 ChunkBytes = ReadLe32(Header, Cursor + 4);
        const uint64 ChunkEnd = static_cast<uint64>(Cursor) + 8ull + ChunkBytes;
        if (ChunkEnd > static_cast<uint64>(FileBytes))
        {
            Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: WAV chunk size escapes the pinned file");
            return false;
        }
        if (FMemory::Memcmp(Header.GetData() + Cursor, "fmt ", 4) == 0)
        {
            if (ChunkBytes < 16 || Cursor + 24 > Header.Num()) break;
            const uint16 Format = ReadLe16(Header, Cursor + 8);
            const uint16 Channels = ReadLe16(Header, Cursor + 10);
            const uint32 SampleRate = ReadLe32(Header, Cursor + 12);
            const uint32 ByteRate = ReadLe32(Header, Cursor + 16);
            const uint16 BlockAlign = ReadLe16(Header, Cursor + 20);
            const uint16 BitsPerSample = ReadLe16(Header, Cursor + 22);
            const bool bDepthSupported = (Format == 1
                    && (BitsPerSample == 8 || BitsPerSample == 16
                        || BitsPerSample == 24 || BitsPerSample == 32))
                || (Format == 3 && BitsPerSample == 32);
            const uint32 ExpectedBlockAlign = static_cast<uint32>(Channels) * BitsPerSample / 8u;
            const uint64 ExpectedByteRate = static_cast<uint64>(SampleRate) * ExpectedBlockAlign;
            if ((Format != 1 && Format != 3) || Channels < 1 || Channels > 8
                || SampleRate < 8000 || SampleRate > 192000
                || !bDepthSupported || BlockAlign == 0 || BlockAlign != ExpectedBlockAlign
                || ExpectedByteRate > MAX_uint32 || ByteRate != ExpectedByteRate)
            {
                Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: WAV must be internally consistent bounded PCM or 32-bit float audio (1-8 channels, 8-192 kHz)");
                return false;
            }
            bFoundFormat = true;
        }
        else if (FMemory::Memcmp(Header.GetData() + Cursor, "data", 4) == 0)
        {
            if (ChunkBytes == 0)
            {
                Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: WAV data chunk is empty");
                return false;
            }
            bFoundData = true;
        }
        const uint64 Next = ChunkEnd + (ChunkBytes & 1u);
        if (Next > static_cast<uint64>(MAX_int32) || Next <= static_cast<uint64>(Cursor)) break;
        Cursor = static_cast<int32>(Next);
        if (bFoundFormat && bFoundData) return true;
    }
    Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: WAV fmt/data chunks were not found in the bounded 64-KiB header window");
    return false;
}

bool ValidateFbx(TConstArrayView<uint8> Header, FString& Error)
{
    static constexpr uint8 Signature[] = {
        'K','a','y','d','a','r','a',' ','F','B','X',' ','B','i','n','a','r','y',' ',' ',0x00,0x1a,0x00
    };
    if (Header.Num() < 27 || FMemory::Memcmp(Header.GetData(), Signature, UE_ARRAY_COUNT(Signature)) != 0)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: only binary .fbx with the canonical Kaydara header is accepted; OBJ/ASCII FBX/external-reference formats are rejected");
        return false;
    }
    const uint32 Version = ReadLe32(Header, 23);
    if (Version < 7100 || Version > 7700)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: binary FBX version must be between 7100 and 7700");
        return false;
    }
    return true;
}
}

bool ParseAndValidateRequest(const TSharedPtr<FJsonObject>& Json, FRequest& Out, FString& Error)
{
    Out = FRequest{};
    if (!Json.IsValid())
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: params must be an object");
        return false;
    }
    static const TSet<FString> AllowedFields = {
        TEXT("source_file"), TEXT("destination_path"), TEXT("asset_type"), TEXT("options")
    };
    for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Json->Values)
    {
        if (!AllowedFields.Contains(Pair.Key))
        {
            Error = TEXT("asset_import [HAI_INVALID_REQUEST]: only source_file, destination_path, asset_type and (skeletal_mesh) options are accepted");
            return false;
        }
    }
    if (!Json->HasTypedField<EJson::String>(TEXT("source_file"))
        || !Json->TryGetStringField(TEXT("source_file"), Out.SourceFile))
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: source_file must be a string");
        return false;
    }
    if (!Json->HasTypedField<EJson::String>(TEXT("destination_path"))
        || !Json->TryGetStringField(TEXT("destination_path"), Out.DestinationPath))
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: destination_path must be a string");
        return false;
    }
    if (!Json->HasTypedField<EJson::String>(TEXT("asset_type"))
        || !Json->TryGetStringField(TEXT("asset_type"), Out.AssetType))
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: asset_type is required and must be texture, sound_wave, or static_mesh");
        return false;
    }
    if (Out.SourceFile.IsEmpty() || Out.SourceFile.Len() > 1024 || HasControlCharacter(Out.SourceFile)
        || !Out.SourceFile.Equals(Out.SourceFile.TrimStartAndEnd()))
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: source_file must be a non-blank bounded path without controls or surrounding whitespace");
        return false;
    }
    if (Out.SourceFile.StartsWith(TEXT("\\\\")) || Out.SourceFile.StartsWith(TEXT("//"))
        || Out.SourceFile.Contains(TEXT("\\\\?\\")) || Out.SourceFile.Contains(TEXT("\\\\.\\"))
        || FPaths::IsRelative(Out.SourceFile))
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: source_file must be a local absolute drive path; UNC/device/relative paths are rejected");
        return false;
    }
    for (int32 Index = 0; Index < Out.SourceFile.Len(); ++Index)
    {
        if (Out.SourceFile[Index] == TEXT(':') && Index != 1)
        {
            Error = TEXT("asset_import [HAI_INVALID_REQUEST]: source_file alternate streams and embedded drive/device separators are rejected");
            return false;
        }
    }
    FPaths::NormalizeFilename(Out.SourceFile);
    const bool bDriveAbsolute = Out.SourceFile.Len() >= 4
        && ((Out.SourceFile[0] >= TEXT('A') && Out.SourceFile[0] <= TEXT('Z'))
            || (Out.SourceFile[0] >= TEXT('a') && Out.SourceFile[0] <= TEXT('z')))
        && Out.SourceFile[1] == TEXT(':') && Out.SourceFile[2] == TEXT('/');
    if (!bDriveAbsolute)
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: source_file must use an explicit local drive-root form such as C:/path/file.png");
        return false;
    }
    TArray<FString> SourceSegments;
    Out.SourceFile.ParseIntoArray(SourceSegments, TEXT("/"), true);
    if (SourceSegments.Num() > 64 || SourceSegments.Contains(TEXT(".")) || SourceSegments.Contains(TEXT("..")))
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: source_file traversal or excessive path depth is rejected");
        return false;
    }
    Out.SourceFile = FPaths::ConvertRelativePathToFull(Out.SourceFile);

    if (Out.DestinationPath.IsEmpty() || Out.DestinationPath.Len() > 256
        || HasControlCharacter(Out.DestinationPath)
        || !Out.DestinationPath.Equals(Out.DestinationPath.TrimStartAndEnd())
        || !Out.DestinationPath.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive)
        || Out.DestinationPath.EndsWith(TEXT("/")) || Out.DestinationPath.Contains(TEXT("."))
        || !FPackageName::IsValidLongPackageName(Out.DestinationPath, false))
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: destination_path must be a bounded canonical /Game folder without a trailing slash");
        return false;
    }
    TArray<FString> DestinationSegments;
    Out.DestinationPath.ParseIntoArray(DestinationSegments, TEXT("/"), true);
    if (DestinationSegments.Num() > 16)
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: destination_path exceeds 16 segments");
        return false;
    }

    Out.AssetType.ToLowerInline();
    Out.Extension = FPaths::GetExtension(Out.SourceFile, true).ToLower();
    if (Out.Extension == TEXT(".png") && Out.AssetType == TEXT("texture"))
    {
        Out.Kind = EKind::TexturePng;
    }
    else if ((Out.Extension == TEXT(".jpg") || Out.Extension == TEXT(".jpeg"))
        && Out.AssetType == TEXT("texture"))
    {
        Out.Kind = EKind::TextureJpeg;
    }
    else if (Out.Extension == TEXT(".wav") && Out.AssetType == TEXT("sound_wave"))
    {
        Out.Kind = EKind::SoundWave;
    }
    else if (Out.Extension == TEXT(".fbx") && Out.AssetType == TEXT("static_mesh"))
    {
        Out.Kind = EKind::StaticMeshFbx;
    }
    else if (Out.Extension == TEXT(".fbx") && Out.AssetType == TEXT("skeletal_mesh"))
    {
        Out.Kind = EKind::SkeletalMeshFbx;
    }
    else if (Out.Extension == TEXT(".gltf") && Out.AssetType == TEXT("static_mesh"))
    {
        Out.Kind = EKind::StaticMeshGltf;
    }
    else if (Out.Extension == TEXT(".glb") && Out.AssetType == TEXT("static_mesh"))
    {
        Out.Kind = EKind::StaticMeshGlb;
    }
    else
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: extension and asset_type must match png/jpeg+texture, wav+sound_wave, binary fbx+static_mesh/skeletal_mesh, or gltf/glb+static_mesh (from a TrustedImportRoots folder only); OBJ/USD and other dependency-reading formats are not accepted");
        return false;
    }

    const TSharedPtr<FJsonObject>* Options = nullptr;
    if (Json->HasField(TEXT("options")))
    {
        if (Out.Kind != EKind::SkeletalMeshFbx || !Json->TryGetObjectField(TEXT("options"), Options))
        {
            Error = TEXT("asset_import [HAI_INVALID_REQUEST]: options is an object and only applies to asset_type skeletal_mesh");
            return false;
        }
        FSkeletalOptions& S = Out.Skeletal;
        static const TMap<FString, bool FSkeletalOptions::*> Bools = {
            { TEXT("import_mesh"), &FSkeletalOptions::bImportMesh },
            { TEXT("create_physics_asset"), &FSkeletalOptions::bCreatePhysicsAsset },
            { TEXT("import_animations"), &FSkeletalOptions::bImportAnimations },
            { TEXT("import_materials"), &FSkeletalOptions::bImportMaterials },
            { TEXT("import_textures"), &FSkeletalOptions::bImportTextures },
            { TEXT("import_morph_targets"), &FSkeletalOptions::bImportMorphTargets },
            { TEXT("use_t0_as_ref_pose"), &FSkeletalOptions::bUseT0AsRefPose },
            { TEXT("update_skeleton_reference_pose"), &FSkeletalOptions::bUpdateSkeletonReferencePose },
        };
        static const TMap<FString, FString FSkeletalOptions::*> Strings = {
            { TEXT("skeleton"), &FSkeletalOptions::Skeleton },
            { TEXT("physics_asset"), &FSkeletalOptions::PhysicsAsset },
            { TEXT("normal_import_method"), &FSkeletalOptions::NormalImportMethod },
        };
        for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : (*Options)->Values)
        {
            const FString Key(Pair.Key);
            if (bool FSkeletalOptions::* const* B = Bools.Find(Key))
            {
                if (!Pair.Value.IsValid() || Pair.Value->Type != EJson::Boolean)
                {
                    Error = FString::Printf(TEXT("asset_import [HAI_INVALID_REQUEST]: options.%s must be a boolean"), *Key);
                    return false;
                }
                S.**B = Pair.Value->AsBool();
            }
            else if (FString FSkeletalOptions::* const* Str = Strings.Find(Key))
            {
                if (!Pair.Value.IsValid() || Pair.Value->Type != EJson::String || Pair.Value->AsString().Len() > 512
                    || HasControlCharacter(Pair.Value->AsString()))
                {
                    Error = FString::Printf(TEXT("asset_import [HAI_INVALID_REQUEST]: options.%s must be a short string"), *Key);
                    return false;
                }
                S.**Str = Pair.Value->AsString();
            }
            else
            {
                Error = FString::Printf(TEXT("asset_import [HAI_INVALID_REQUEST]: unknown options.%s"), *Key);
                return false;
            }
        }
        for (const FString* Ref : { &S.Skeleton, &S.PhysicsAsset })
        {
            if (!Ref->IsEmpty() && (!FPackageName::IsValidObjectPath(*Ref) || Ref->StartsWith(TEXT("/Temp/"))))
            {
                Error = FString::Printf(TEXT("asset_import [HAI_INVALID_REQUEST]: '%s' is not an object path such as /Game/Chars/SK_Hero_Skeleton.SK_Hero_Skeleton"), **Ref);
                return false;
            }
        }
        if (S.NormalImportMethod != TEXT("import") && S.NormalImportMethod != TEXT("compute")
            && S.NormalImportMethod != TEXT("import_and_tangents"))
        {
            Error = TEXT("asset_import [HAI_INVALID_REQUEST]: options.normal_import_method must be import, compute or import_and_tangents");
            return false;
        }
        if (!S.PhysicsAsset.IsEmpty() && S.bCreatePhysicsAsset && (*Options)->HasField(TEXT("create_physics_asset")))
        {
            Error = TEXT("asset_import [HAI_INVALID_REQUEST]: pass physics_asset or create_physics_asset:true, not both");
            return false;
        }
        if (!S.PhysicsAsset.IsEmpty()) S.bCreatePhysicsAsset = false;
        if (!S.bImportMesh)
        {
            if (S.Skeleton.IsEmpty())
            {
                Error = TEXT("asset_import [HAI_INVALID_REQUEST]: an animation-only import (import_mesh:false) needs options.skeleton");
                return false;
            }
            S.bImportAnimations = true;
            S.bCreatePhysicsAsset = false;
        }
    }
    Out.MaxFileBytes = MaxFileBytesForKind(Out.Kind);

    Out.AssetName = FPaths::GetBaseFilename(Out.SourceFile);
    if (!IsAsciiAssetName(Out.AssetName))
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: source basename must be 1-64 ASCII letters/digits/underscores and begin with a letter");
        return false;
    }
    Out.ExpectedPackageName = Out.DestinationPath / Out.AssetName;
    Out.ExpectedObjectPath = FString::Printf(TEXT("%s.%s"), *Out.ExpectedPackageName, *Out.AssetName);
    if (!FPackageName::IsValidLongPackageName(Out.ExpectedPackageName, false)
        || !FPackageName::IsValidObjectPath(Out.ExpectedObjectPath))
    {
        Error = TEXT("asset_import [HAI_INVALID_REQUEST]: source basename does not form a valid exact Unreal object path");
        return false;
    }
    return true;
}

bool ValidateFileHeader(EKind Kind, TConstArrayView<uint8> Header, int64 FileBytes, FString& Error)
{
    if (FileBytes <= 0 || Header.Num() <= 0)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: source file is empty");
        return false;
    }
    switch (Kind)
    {
        case EKind::TexturePng:     return ValidatePng(Header, Error);
        case EKind::TextureJpeg:    return ValidateJpeg(Header, Error);
        case EKind::SoundWave:      return ValidateWave(Header, FileBytes, Error);
        case EKind::StaticMeshFbx:
        case EKind::SkeletalMeshFbx: return ValidateFbx(Header, Error);
        case EKind::StaticMeshGlb:
        {
            uint32 JsonBytes = 0;
            return ValidateGlbHeader(Header, FileBytes, JsonBytes, Error);
        }
        case EKind::StaticMeshGltf:
        {
            for (const uint8 Byte : Header)
            {
                if (Byte == ' ' || Byte == '\t' || Byte == '\r' || Byte == '\n') continue;
                if (Byte == '{') return true;
                break;
            }
            Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: .gltf must be a JSON object");
            return false;
        }
        default:
            Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: no fixed format policy exists");
            return false;
    }
}

int64 MaxFileBytesForKind(EKind Kind)
{
    switch (Kind)
    {
        case EKind::TexturePng:
        case EKind::TextureJpeg:   return MaxTextureBytes;
        case EKind::SoundWave:     return MaxWaveBytes;
        case EKind::StaticMeshFbx:
        case EKind::SkeletalMeshFbx: return MaxFbxBytes;
        case EKind::StaticMeshGltf:  return MaxGltfJsonBytes;
        case EKind::StaticMeshGlb:   return MaxGltfFileBytes;
        default:                   return 0;
    }
}

bool ValidateFileSize(EKind Kind, int64 FileBytes, FString& Error)
{
    const int64 Maximum = MaxFileBytesForKind(Kind);
    if (Maximum <= 0 || FileBytes <= 0 || FileBytes > Maximum)
    {
        Error = FString::Printf(
            TEXT("asset_import [HAI_FILE_REJECTED]: source size must be 1..%lld bytes for this asset_type"),
            Maximum);
        return false;
    }
    return true;
}

FString SkeletalCollision(const FRequest& Request, const TArray<FString>& ExistingNames)
{
    const FString& Name = Request.AssetName;
    const FSkeletalOptions& S = Request.Skeletal;
    for (const FString& Existing : ExistingNames)
    {
        const bool bMesh = Existing.Equals(Name, ESearchCase::IgnoreCase);
        const bool bSkeleton = S.bImportMesh && S.Skeleton.IsEmpty()
            && Existing.Equals(Name + TEXT("_Skeleton"), ESearchCase::IgnoreCase);
        const bool bPhysics = S.bImportMesh && S.bCreatePhysicsAsset
            && Existing.Equals(Name + TEXT("_PhysicsAsset"), ESearchCase::IgnoreCase);
        // Animation names depend on the FBX take names, so the importer's whole
        // prefix is reserved: an existing AnimSequence there would be reimported into.
        const bool bAnim = S.bImportAnimations && (S.bImportMesh
            ? Existing.StartsWith(Name + TEXT("_Anim"), ESearchCase::IgnoreCase)
            : Existing.StartsWith(Name + TEXT("_"), ESearchCase::IgnoreCase));
        if (bMesh || bSkeleton || bPhysics || bAnim) return Existing;
    }
    return FString();
}

bool IsSafeRelativeUri(const FString& Uri)
{
    if (Uri.IsEmpty() || Uri.Len() > 260 || HasControlCharacter(Uri)) return false;
    // ':' covers schemes and drives; '%' would let "..%2f" smuggle a parent segment.
    static const TCHAR Forbidden[] = TEXT(":%?#*\"<>|");
    for (int32 I = 0; Forbidden[I] != 0; ++I)
    {
        int32 At = INDEX_NONE;
        if (Uri.FindChar(Forbidden[I], At)) return false;
    }
    if (Uri.StartsWith(TEXT("/")) || Uri.StartsWith(TEXT("\\"))) return false;
    FString Normal = Uri.Replace(TEXT("\\"), TEXT("/"));
    TArray<FString> Segments;
    Normal.ParseIntoArray(Segments, TEXT("/"), true);
    if (Segments.Num() == 0 || Segments.Num() > 5) return false;
    for (const FString& S : Segments)
    {
        if (S == TEXT(".") || S == TEXT("..") || S.EndsWith(TEXT(".")) || S.EndsWith(TEXT(" "))) return false;
    }
    return true;
}

bool ValidateGlbHeader(TConstArrayView<uint8> Header, int64 FileBytes, uint32& OutJsonBytes, FString& Error)
{
    if (Header.Num() < 20 || FMemory::Memcmp(Header.GetData(), "glTF", 4) != 0 || ReadLe32(Header, 4) != 2
        || static_cast<int64>(ReadLe32(Header, 8)) != FileBytes || ReadLe32(Header, 16) != 0x4E4F534Au)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: .glb requires a glTF 2 container whose stated length matches the file and whose first chunk is JSON");
        return false;
    }
    OutJsonBytes = ReadLe32(Header, 12);
    if (OutJsonBytes == 0 || OutJsonBytes > MaxGltfJsonBytes || 20ll + OutJsonBytes > FileBytes)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: .glb JSON chunk is empty, larger than 64 MiB, or runs past the file");
        return false;
    }
    return true;
}

bool ValidateGltfJson(const FString& JsonText, TArray<FString>& OutRelativeUris, FString& Error)
{
    OutRelativeUris.Reset();
    // The JSON parser recurses per nesting level; real glTF is a few levels deep.
    int32 Depth = 0, MaxDepth = 0;
    bool bInString = false, bEscaped = false;
    for (const TCHAR C : JsonText)
    {
        if (bInString)
        {
            if (bEscaped) bEscaped = false;
            else if (C == TEXT('\\')) bEscaped = true;
            else if (C == TEXT('"')) bInString = false;
            continue;
        }
        if (C == TEXT('"')) bInString = true;
        else if (C == TEXT('{') || C == TEXT('[')) MaxDepth = FMath::Max(MaxDepth, ++Depth);
        else if (C == TEXT('}') || C == TEXT(']')) --Depth;
    }
    if (MaxDepth > 64)
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: glTF JSON nests deeper than 64 levels");
        return false;
    }
    TSharedPtr<FJsonObject> Root;
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(JsonText), Root) || !Root.IsValid())
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: glTF JSON does not parse");
        return false;
    }
    const TSharedPtr<FJsonObject>* Asset = nullptr;
    FString Version;
    if (!Root->TryGetObjectField(TEXT("asset"), Asset) || !(*Asset)->TryGetStringField(TEXT("version"), Version)
        || !Version.StartsWith(TEXT("2.")))
    {
        Error = TEXT("asset_import [HAI_FORMAT_REJECTED]: only glTF 2.x is accepted");
        return false;
    }
    const TArray<TSharedPtr<FJsonValue>>* Required = nullptr;
    if (Root->TryGetArrayField(TEXT("extensionsRequired"), Required))
    {
        for (const TSharedPtr<FJsonValue>& V : *Required)
        {
            const FString Ext = V.IsValid() ? V->AsString() : FString();
            if (!Ext.StartsWith(TEXT("KHR_materials_")) && Ext != TEXT("KHR_texture_transform") && Ext != TEXT("KHR_mesh_quantization"))
            {
                Error = FString::Printf(TEXT("asset_import [HAI_FORMAT_REJECTED]: required glTF extension '%s' is outside the allow-list (KHR_materials_*, KHR_texture_transform, KHR_mesh_quantization)"), *Ext);
                return false;
            }
        }
    }
    for (const TCHAR* Key : { TEXT("skins"), TEXT("animations") })
    {
        const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
        if (Root->TryGetArrayField(Key, List) && List->Num() > 0)
        {
            Error = FString::Printf(TEXT("asset_import [HAI_FORMAT_REJECTED]: this glTF has %s; asset_type static_mesh imports static geometry only"), Key);
            return false;
        }
    }
    for (const TCHAR* Key : { TEXT("buffers"), TEXT("images") })
    {
        const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
        if (!Root->TryGetArrayField(Key, List)) continue;
        if (List->Num() > 1024)
        {
            Error = FString::Printf(TEXT("asset_import [HAI_FORMAT_REJECTED]: more than 1024 %s"), Key);
            return false;
        }
        for (const TSharedPtr<FJsonValue>& V : *List)
        {
            const TSharedPtr<FJsonObject>* Entry = nullptr;
            FString Uri;
            if (!V.IsValid() || !V->TryGetObject(Entry) || !(*Entry)->TryGetStringField(TEXT("uri"), Uri)) continue;
            if (Uri.StartsWith(TEXT("data:"))) continue; // bounded by the 64 MiB JSON cap
            if (!IsSafeRelativeUri(Uri))
            {
                Error = FString::Printf(TEXT("asset_import [HAI_FORMAT_REJECTED]: %s uri '%s' must be a data: URI or a plain relative path below the .gltf's folder"), Key, *Uri.Left(120));
                return false;
            }
            OutRelativeUris.AddUnique(Uri.Replace(TEXT("\\"), TEXT("/")));
        }
    }
    return true;
}
}

namespace
{
TSharedPtr<FJsonObject> MakeAssetImportState(
    bool bOk,
    const FString& Code,
    const FString& Error,
    const TCHAR* Phase,
    const TCHAR* MutationStatus)
{
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), bOk);
    Out->SetStringField(TEXT("code"), Code);
    if (!Error.IsEmpty()) Out->SetStringField(TEXT("error"), Error);
    Out->SetStringField(TEXT("phase"), Phase);
    Out->SetStringField(TEXT("mutation_status"), MutationStatus);
    Out->SetNumberField(TEXT("succeeded"), 0);
    Out->SetNumberField(TEXT("failed"), bOk ? 0 : 1);
    Out->SetBoolField(TEXT("verified"), false);
    Out->SetBoolField(TEXT("readback_verified"), false);
    Out->SetBoolField(TEXT("save_attempted"), false);
    Out->SetBoolField(TEXT("saved"), false);
    Out->SetBoolField(TEXT("dirty_known"), false);
    Out->SetBoolField(TEXT("dirty"), false);
    Out->SetBoolField(TEXT("partial"), false);
    Out->SetBoolField(TEXT("unknown_outcome"), false);
    Out->SetBoolField(TEXT("session_suspect"), false);
    Out->SetStringField(TEXT("crafted_format_safety"), TEXT("not_proven"));
    return Out;
}

FHaybaHandlerResult AssetImportPreflightFailure(
    const FString& Code,
    const FString& Error,
    const TCHAR* FailureKind = TEXT("input_rejected"))
{
    TSharedPtr<FJsonObject> Out = MakeAssetImportState(
        false, Code, Error, TEXT("preflight"), TEXT("not_started"));
    Out->SetStringField(TEXT("failure_kind"), FailureKind);
    return FHaybaHandlerResult::Ok(Out);
}

FString AssetImportCodeFromError(const FString& Error, const TCHAR* Fallback)
{
    static const TCHAR* KnownCodes[] = {
        TEXT("HAI_INVALID_REQUEST"),
        TEXT("HAI_AUTHORITY_REJECTED"),
        TEXT("HAI_FILE_REJECTED"),
        TEXT("HAI_FORMAT_REJECTED"),
        TEXT("HAI_IDENTITY_CHANGED"),
        TEXT("HAI_FACTORY_UNAVAILABLE"),
        TEXT("HAI_COLLISION"),
    };
    for (const TCHAR* Code : KnownCodes)
    {
        if (Error.Contains(FString::Printf(TEXT("[%s]"), Code))) return Code;
    }
    return Fallback;
}

#if PLATFORM_WINDOWS
FString NormalizeFinalWinPath(FString Value)
{
    if (Value.StartsWith(TEXT("\\\\?\\UNC\\"), ESearchCase::IgnoreCase))
    {
        Value = TEXT("\\\\") + Value.RightChop(8);
    }
    else
    {
        Value.RemoveFromStart(TEXT("\\\\?\\"), ESearchCase::IgnoreCase);
    }
    FPaths::NormalizeFilename(Value);
    FPaths::CollapseRelativeDirectories(Value);
    Value.RemoveFromEnd(TEXT("/"));
    return Value;
}

bool WinFinalPath(HANDLE Handle, FString& Out)
{
    const DWORD Chars = GetFinalPathNameByHandleW(
        Handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (Chars == 0 || Chars > 32768) return false;
    TArray<WCHAR> Buffer;
    Buffer.SetNumZeroed(static_cast<int32>(Chars) + 1);
    const DWORD Written = GetFinalPathNameByHandleW(
        Handle, Buffer.GetData(), Chars + 1, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (Written == 0 || Written > Chars) return false;
    Out = NormalizeFinalWinPath(FString(Buffer.GetData()));
    return true;
}

bool SameWinIdentity(const BY_HANDLE_FILE_INFORMATION& A, const BY_HANDLE_FILE_INFORMATION& B)
{
    return A.dwVolumeSerialNumber == B.dwVolumeSerialNumber
        && A.nFileIndexHigh == B.nFileIndexHigh && A.nFileIndexLow == B.nFileIndexLow
        && A.nFileSizeHigh == B.nFileSizeHigh && A.nFileSizeLow == B.nFileSizeLow
        && A.nNumberOfLinks == B.nNumberOfLinks && A.dwFileAttributes == B.dwFileAttributes
        && A.ftLastWriteTime.dwHighDateTime == B.ftLastWriteTime.dwHighDateTime
        && A.ftLastWriteTime.dwLowDateTime == B.ftLastWriteTime.dwLowDateTime;
}

class FWinAssetSourceLease
{
public:
    ~FWinAssetSourceLease()
    {
        if (FileHandle != INVALID_HANDLE_VALUE) CloseHandle(FileHandle);
        for (HANDLE Handle : DirectoryHandles)
        {
            if (Handle != INVALID_HANDLE_VALUE) CloseHandle(Handle);
        }
    }

    bool Open(const HaybaAssetImport::FRequest& Request, FString& Error)
    {
        return OpenUnder(Request.SourceFile,
            FPaths::Combine(FPlatformProcess::UserTempDir(), TEXT("hayba-asset-connectors")),
            3, HaybaAssetImport::MaxFileBytesForKind(Request.Kind), Error);
    }

    /** Pin SourceFile under Authority (at least MinSegments path entries below it), with
     *  the same no-link/no-reparse/fixed-disk identity rules. Used for the connector cache
     *  and, for glTF, a settings-configured trusted root and the files a .gltf references. */
    bool OpenUnder(const FString& SourceFile, FString Authority, int32 MinSegments, int64 MaxBytes, FString& Error)
    {
        Authority = FPaths::ConvertRelativePathToFull(Authority);
        FString Source = FPaths::ConvertRelativePathToFull(SourceFile);
        FPaths::NormalizeFilename(Authority);
        FPaths::NormalizeFilename(Source);
        Authority.RemoveFromEnd(TEXT("/"));

        const FString AuthorityPrefix = Authority + TEXT("/");
        if (!Source.StartsWith(AuthorityPrefix, ESearchCase::IgnoreCase))
        {
            Error = TEXT("asset_import [HAI_AUTHORITY_REJECTED]: source_file is outside the fixed request-owned connector cache authority");
            return false;
        }
        FString Relative = Source.RightChop(AuthorityPrefix.Len());
        TArray<FString> Segments;
        Relative.ParseIntoArray(Segments, TEXT("/"), true);
        if (Segments.Num() < MinSegments || Segments.Num() > 34)
        {
            Error = TEXT("asset_import [HAI_AUTHORITY_REJECTED]: source_file must be inside a source/request directory and stay within 32 nested entries");
            return false;
        }
        FString DriveRoot = Source.Left(3);
        DriveRoot.ReplaceInline(TEXT("/"), TEXT("\\"));
        if (GetDriveTypeW(*DriveRoot) != DRIVE_FIXED)
        {
            Error = TEXT("asset_import [HAI_AUTHORITY_REJECTED]: connector imports require a fixed local disk");
            return false;
        }

        FString Current = Authority;
        if (!OpenDirectory(Current, Error)) return false;
        for (int32 Index = 0; Index + 1 < Segments.Num(); ++Index)
        {
            Current /= Segments[Index];
            if (!OpenDirectory(Current, Error)) return false;
        }

        FileHandle = CreateFileW(
            *Source,
            GENERIC_READ,
            FILE_SHARE_READ,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
            nullptr);
        if (FileHandle == INVALID_HANDLE_VALUE)
        {
            Error = TEXT("asset_import [HAI_FILE_REJECTED]: source could not be pinned for exclusive identity/read access");
            return false;
        }
        if (GetFileType(FileHandle) != FILE_TYPE_DISK
            || !GetFileInformationByHandle(FileHandle, &Identity))
        {
            Error = TEXT("asset_import [HAI_FILE_REJECTED]: source is not a regular local disk file");
            return false;
        }
        const DWORD ForbiddenAttributes = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_DEVICE
            | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_OFFLINE;
        if ((Identity.dwFileAttributes & ForbiddenAttributes) != 0 || Identity.nNumberOfLinks != 1)
        {
            Error = TEXT("asset_import [HAI_FILE_REJECTED]: source links, reparse points, devices, offline files, directories, and multiply-linked files are rejected");
            return false;
        }
        ULARGE_INTEGER Size;
        Size.HighPart = Identity.nFileSizeHigh;
        Size.LowPart = Identity.nFileSizeLow;
        if (Size.QuadPart > static_cast<uint64>(MAX_int64))
        {
            Error = TEXT("asset_import [HAI_FILE_REJECTED]: source size cannot be represented safely");
            return false;
        }
        FileBytes = static_cast<int64>(Size.QuadPart);
        if (MaxBytes <= 0 || FileBytes <= 0 || FileBytes > MaxBytes)
        {
            Error = FString::Printf(
                TEXT("asset_import [HAI_FILE_REJECTED]: source size must be 1..%lld bytes for this asset_type"), MaxBytes);
            return false;
        }

        FString FinalSource;
        if (!WinFinalPath(FileHandle, FinalSource)
            || !FinalSource.Equals(Source, ESearchCase::IgnoreCase)
            || !FinalSource.StartsWith(CanonicalAuthority + TEXT("/"), ESearchCase::IgnoreCase))
        {
            Error = TEXT("asset_import [HAI_AUTHORITY_REJECTED]: source canonical identity escaped or redirected from the connector cache");
            return false;
        }
        return true;
    }

    bool ReadHeader(TArray<uint8>& Out, FString& Error) const
    {
        constexpr int32 HeaderLimit = 64 * 1024;
        const DWORD BytesToRead = static_cast<DWORD>(FMath::Min<int64>(FileBytes, HeaderLimit));
        Out.SetNumUninitialized(static_cast<int32>(BytesToRead));
        LARGE_INTEGER Start;
        Start.QuadPart = 0;
        if (!SetFilePointerEx(FileHandle, Start, nullptr, FILE_BEGIN))
        {
            Error = TEXT("asset_import [HAI_FILE_REJECTED]: pinned source header could not be positioned");
            return false;
        }
        DWORD BytesRead = 0;
        if (!ReadFile(FileHandle, Out.GetData(), BytesToRead, &BytesRead, nullptr)
            || BytesRead != BytesToRead)
        {
            Error = TEXT("asset_import [HAI_FILE_REJECTED]: pinned source header could not be read completely");
            return false;
        }
        return true;
    }

    /** Read Count bytes at Offset through the pinned handle (the glTF JSON). */
    bool ReadRange(int64 Offset, int64 Count, TArray<uint8>& Out, FString& Error) const
    {
        if (Offset < 0 || Count <= 0 || Count > MAX_int32 || Offset + Count > FileBytes)
        {
            Error = TEXT("asset_import [HAI_FILE_REJECTED]: requested range is outside the pinned source");
            return false;
        }
        Out.SetNumUninitialized(static_cast<int32>(Count));
        LARGE_INTEGER Start;
        Start.QuadPart = Offset;
        if (!SetFilePointerEx(FileHandle, Start, nullptr, FILE_BEGIN))
        {
            Error = TEXT("asset_import [HAI_FILE_REJECTED]: pinned source could not be positioned");
            return false;
        }
        int64 Done = 0;
        while (Done < Count)
        {
            DWORD Got = 0;
            const DWORD Want = static_cast<DWORD>(FMath::Min<int64>(Count - Done, 16 * 1024 * 1024));
            if (!ReadFile(FileHandle, Out.GetData() + Done, Want, &Got, nullptr) || Got == 0)
            {
                Error = TEXT("asset_import [HAI_FILE_REJECTED]: pinned source could not be read completely");
                return false;
            }
            Done += Got;
        }
        return true;
    }

    bool Recheck(FString& Error) const
    {
        BY_HANDLE_FILE_INFORMATION Current{};
        if (!GetFileInformationByHandle(FileHandle, &Current) || !SameWinIdentity(Identity, Current)
            || Current.nNumberOfLinks != 1)
        {
            Error = TEXT("asset_import [HAI_IDENTITY_CHANGED]: pinned source identity changed before the import call");
            return false;
        }
        return true;
    }

    int64 GetFileBytes() const { return FileBytes; }

private:
    bool OpenDirectory(FString Directory, FString& Error)
    {
        FPaths::NormalizeFilename(Directory);
        Directory.RemoveFromEnd(TEXT("/"));
        HANDLE Handle = CreateFileW(
            *Directory,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            nullptr,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            nullptr);
        if (Handle == INVALID_HANDLE_VALUE)
        {
            Error = TEXT("asset_import [HAI_AUTHORITY_REJECTED]: connector cache ancestor could not be pinned");
            return false;
        }
        BY_HANDLE_FILE_INFORMATION Info{};
        FString FinalPath;
        if (!GetFileInformationByHandle(Handle, &Info)
            || (Info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
            || (Info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE | FILE_ATTRIBUTE_OFFLINE)) != 0
            || !WinFinalPath(Handle, FinalPath)
            || !FinalPath.Equals(Directory, ESearchCase::IgnoreCase))
        {
            CloseHandle(Handle);
            Error = TEXT("asset_import [HAI_AUTHORITY_REJECTED]: connector cache ancestors must be real, local, non-reparse directories");
            return false;
        }
        if (DirectoryHandles.Num() == 0) CanonicalAuthority = FinalPath;
        DirectoryHandles.Add(Handle);
        return true;
    }

    HANDLE FileHandle = INVALID_HANDLE_VALUE;
    TArray<HANDLE> DirectoryHandles;
    BY_HANDLE_FILE_INFORMATION Identity{};
    FString CanonicalAuthority;
    int64 FileBytes = 0;
};
#endif

UFactory* CreatePinnedImportFactory(
    const HaybaAssetImport::FRequest& Request,
    UClass*& ExpectedClass,
    FString& FactoryName,
    FString& Error)
{
    switch (Request.Kind)
    {
        case HaybaAssetImport::EKind::TexturePng:
        case HaybaAssetImport::EKind::TextureJpeg:
        {
            UTextureFactory* Factory = NewObject<UTextureFactory>(GetTransientPackage());
            if (!Factory)
            {
                Error = TEXT("asset_import [HAI_FACTORY_UNAVAILABLE]: TextureFactory could not be created");
                return nullptr;
            }
            Factory->bCreateMaterial = false;
            Factory->bDeferCompression = true;
            Factory->UdimRegexPattern = TEXT("a^");
            ExpectedClass = UTexture2D::StaticClass();
            FactoryName = TEXT("TextureFactory");
            return Factory;
        }
        case HaybaAssetImport::EKind::SoundWave:
        {
            USoundFactory* Factory = NewObject<USoundFactory>(GetTransientPackage());
            if (!Factory)
            {
                Error = TEXT("asset_import [HAI_FACTORY_UNAVAILABLE]: SoundFactory could not be created");
                return nullptr;
            }
            Factory->bAutoCreateCue = false;
            Factory->SuppressImportDialogs();
            ExpectedClass = USoundWave::StaticClass();
            FactoryName = TEXT("SoundFactory");
            return Factory;
        }
        case HaybaAssetImport::EKind::StaticMeshFbx:
        {
            UFbxFactory* Factory = NewObject<UFbxFactory>(GetTransientPackage());
            if (!Factory || !Factory->ImportUI || !Factory->ImportUI->StaticMeshImportData)
            {
                Error = TEXT("asset_import [HAI_FACTORY_UNAVAILABLE]: FBX static-mesh factory options are unavailable");
                return nullptr;
            }
            Factory->SetDetectImportTypeOnImport(false);
            Factory->ImportUI->bAutomatedImportShouldDetectType = false;
            Factory->ImportUI->MeshTypeToImport = FBXIT_StaticMesh;
            Factory->ImportUI->OriginalImportType = FBXIT_StaticMesh;
            Factory->ImportUI->bImportAsSkeletal = false;
            Factory->ImportUI->bImportMesh = true;
            Factory->ImportUI->bImportAnimations = false;
            Factory->ImportUI->bImportMaterials = false;
            Factory->ImportUI->bImportTextures = false;
            Factory->ImportUI->bCreatePhysicsAsset = false;
            Factory->ImportUI->bOverrideFullName = true;
            Factory->ImportUI->bAllowContentTypeImport = false;
            Factory->ImportUI->StaticMeshImportData->bCombineMeshes = true;
            Factory->ImportUI->StaticMeshImportData->bImportMeshLODs = false;
            Factory->ImportUI->StaticMeshImportData->bBuildNanite = false;
            Factory->ImportUI->StaticMeshImportData->bGenerateLightmapUVs = false;
            Factory->ImportUI->StaticMeshImportData->bAutoGenerateCollision = false;
            ExpectedClass = UStaticMesh::StaticClass();
            FactoryName = TEXT("FbxFactory.StaticMeshOnly");
            return Factory;
        }
        case HaybaAssetImport::EKind::SkeletalMeshFbx:
        {
            const HaybaAssetImport::FSkeletalOptions& S = Request.Skeletal;
            USkeleton* Skeleton = nullptr;
            if (!S.Skeleton.IsEmpty() && !(Skeleton = LoadObject<USkeleton>(nullptr, *S.Skeleton)))
            {
                Error = FString::Printf(TEXT("asset_import [HAI_INVALID_REQUEST]: options.skeleton '%s' is not a loadable Skeleton"), *S.Skeleton);
                return nullptr;
            }
            UPhysicsAsset* Physics = nullptr;
            if (!S.PhysicsAsset.IsEmpty() && !(Physics = LoadObject<UPhysicsAsset>(nullptr, *S.PhysicsAsset)))
            {
                Error = FString::Printf(TEXT("asset_import [HAI_INVALID_REQUEST]: options.physics_asset '%s' is not a loadable PhysicsAsset"), *S.PhysicsAsset);
                return nullptr;
            }
            UFbxFactory* Factory = NewObject<UFbxFactory>(GetTransientPackage());
            if (!Factory || !Factory->ImportUI || !Factory->ImportUI->SkeletalMeshImportData || !Factory->ImportUI->AnimSequenceImportData)
            {
                Error = TEXT("asset_import [HAI_FACTORY_UNAVAILABLE]: FBX skeletal-mesh factory options are unavailable");
                return nullptr;
            }
            UFbxImportUI* UI = Factory->ImportUI;
            Factory->SetDetectImportTypeOnImport(false);
            UI->bAutomatedImportShouldDetectType = false;
            UI->MeshTypeToImport = S.bImportMesh ? FBXIT_SkeletalMesh : FBXIT_Animation;
            UI->OriginalImportType = UI->MeshTypeToImport;
            UI->bImportAsSkeletal = S.bImportMesh;
            UI->bImportMesh = S.bImportMesh;
            UI->Skeleton = Skeleton;
            UI->bCreatePhysicsAsset = S.bCreatePhysicsAsset;
            UI->PhysicsAsset = Physics;
            UI->bImportAnimations = S.bImportAnimations;
            UI->bImportMaterials = S.bImportMaterials;
            UI->bImportTextures = S.bImportTextures;
            UI->bOverrideFullName = true;
            UI->bAllowContentTypeImport = false;
            UFbxSkeletalMeshImportData* Mesh = UI->SkeletalMeshImportData;
            Mesh->bImportMorphTargets = S.bImportMorphTargets;
            Mesh->bUseT0AsRefPose = S.bUseT0AsRefPose;
            Mesh->bUpdateSkeletonReferencePose = S.bUpdateSkeletonReferencePose;
            Mesh->bImportMeshLODs = false;
            Mesh->NormalImportMethod = S.NormalImportMethod == TEXT("compute") ? FBXNIM_ComputeNormals
                : S.NormalImportMethod == TEXT("import_and_tangents") ? FBXNIM_ImportNormalsAndTangents
                : FBXNIM_ImportNormals;
            ExpectedClass = S.bImportMesh ? USkeletalMesh::StaticClass() : UAnimSequence::StaticClass();
            FactoryName = S.bImportMesh ? TEXT("FbxFactory.SkeletalMesh") : TEXT("FbxFactory.AnimationOnly");
            return Factory;
        }
        default:
            Error = TEXT("asset_import [HAI_FACTORY_UNAVAILABLE]: no exact factory policy exists");
            return nullptr;
    }
}
}

#if PLATFORM_WINDOWS
/** glTF/GLB under the approved policy: a TrustedImportRoots source (settings only, never the
 *  request), every referenced buffer and texture pinned under the .gltf's own folder, a
 *  new-or-empty destination folder, the project's Interchange asset pipeline through one
 *  synchronous automated task, and verification by folder readback. */
static FHaybaHandlerResult ImportGltf(const HaybaAssetImport::FRequest& Request)
{
    using namespace HaybaAssetImport;
    FString Error;

    FString Root;
    for (FString Candidate : GetDefault<UHaybaMCPDeveloperSettings>()->TrustedImportRoots)
    {
        FPaths::NormalizeFilename(Candidate);
        Candidate.RemoveFromEnd(TEXT("/"));
        if (Candidate.Len() > 3 && Request.SourceFile.StartsWith(Candidate + TEXT("/"), ESearchCase::IgnoreCase))
        {
            Root = Candidate;
            break;
        }
    }
    if (Root.IsEmpty())
        return AssetImportPreflightFailure(TEXT("HAI_AUTHORITY_REJECTED"),
            TEXT("asset_import [HAI_AUTHORITY_REJECTED]: glTF/GLB is read only from a TrustedImportRoots folder (Project Settings > Hayba MCP Toolkit > Security); this source is not under one"),
            TEXT("policy_blocked"));

    FWinAssetSourceLease Source;
    if (!Source.OpenUnder(Request.SourceFile, Root, 1, MaxFileBytesForKind(Request.Kind), Error))
        return AssetImportPreflightFailure(AssetImportCodeFromError(Error, TEXT("HAI_AUTHORITY_REJECTED")), Error, TEXT("policy_blocked"));
    TArray<uint8> Header;
    if (!Source.ReadHeader(Header, Error) || !ValidateFileHeader(Request.Kind, Header, Source.GetFileBytes(), Error))
        return AssetImportPreflightFailure(AssetImportCodeFromError(Error, TEXT("HAI_FORMAT_REJECTED")), Error, TEXT("policy_blocked"));

    TArray<uint8> JsonBytes;
    uint32 GlbJsonBytes = 0;
    const bool bRead = Request.Kind == EKind::StaticMeshGlb
        ? ValidateGlbHeader(Header, Source.GetFileBytes(), GlbJsonBytes, Error) && Source.ReadRange(20, GlbJsonBytes, JsonBytes, Error)
        : Source.ReadRange(0, Source.GetFileBytes(), JsonBytes, Error);
    if (!bRead)
        return AssetImportPreflightFailure(AssetImportCodeFromError(Error, TEXT("HAI_FILE_REJECTED")), Error, TEXT("policy_blocked"));
    const FUTF8ToTCHAR Converted(reinterpret_cast<const ANSICHAR*>(JsonBytes.GetData()), JsonBytes.Num());
    const FString JsonText(Converted.Length(), Converted.Get());
    TArray<FString> Uris;
    if (!ValidateGltfJson(JsonText, Uris, Error))
        return AssetImportPreflightFailure(TEXT("HAI_FORMAT_REJECTED"), Error, TEXT("policy_blocked"));

    // Pin what the importer will read next to the .gltf, so nothing is swapped mid-import.
    const FString Dir = FPaths::GetPath(Request.SourceFile);
    TArray<TUniquePtr<FWinAssetSourceLease>> Referenced;
    int64 TotalBytes = Source.GetFileBytes();
    for (const FString& Uri : Uris)
    {
        TUniquePtr<FWinAssetSourceLease> Lease = MakeUnique<FWinAssetSourceLease>();
        if (!Lease->OpenUnder(Dir / Uri, Dir, 1, MaxGltfFileBytes, Error))
            return AssetImportPreflightFailure(AssetImportCodeFromError(Error, TEXT("HAI_FILE_REJECTED")),
                FString::Printf(TEXT("%s (referenced file '%s')"), *Error, *Uri), TEXT("policy_blocked"));
        TotalBytes += Lease->GetFileBytes();
        if (TotalBytes > MaxGltfTotalBytes)
            return AssetImportPreflightFailure(TEXT("HAI_FILE_REJECTED"),
                TEXT("asset_import [HAI_FILE_REJECTED]: the glTF and its referenced files exceed 1 GiB together"), TEXT("policy_blocked"));
        Referenced.Add(MoveTemp(Lease));
    }

    FAssetRegistryModule* RegistryModule = FModuleManager::LoadModulePtr<FAssetRegistryModule>(TEXT("AssetRegistry"));
    if (!RegistryModule || RegistryModule->Get().IsLoadingAssets())
        return AssetImportPreflightFailure(TEXT("HAI_REGISTRY_BUSY"),
            TEXT("asset_import [HAI_REGISTRY_BUSY]: AssetRegistry is unavailable or still discovering assets; retry after it is ready"), TEXT("retryable"));
    IAssetRegistry& Registry = RegistryModule->Get();

    // glTF asset names come from inside the file, so the only honest no-overwrite
    // guarantee is a destination that holds nothing, in the registry or on disk.
    TArray<FAssetData> Existing;
    Registry.GetAssetsByPath(FName(*Request.DestinationPath), Existing, /*bRecursive*/ true);
    TArray<FString> OnDisk;
    FString DestDir;
    if (FPackageName::TryConvertLongPackageNameToFilename(Request.DestinationPath + TEXT("/"), DestDir))
        IFileManager::Get().FindFilesRecursive(OnDisk, *DestDir, TEXT("*.uasset"), true, false);
    if (Existing.Num() > 0 || OnDisk.Num() > 0)
        return AssetImportPreflightFailure(TEXT("HAI_COLLISION"), FString::Printf(
            TEXT("asset_import [HAI_COLLISION]: %s is not empty; glTF imports go into a new or empty folder so nothing can be overwritten. Skipped."),
            *Request.DestinationPath));

    FAssetToolsModule* AssetToolsModule = FModuleManager::LoadModulePtr<FAssetToolsModule>(TEXT("AssetTools"));
    if (!AssetToolsModule)
        return AssetImportPreflightFailure(TEXT("HAI_MODULE_UNAVAILABLE"),
            TEXT("asset_import [HAI_MODULE_UNAVAILABLE]: AssetTools module is unavailable; no import was started"), TEXT("retryable"));
    TStrongObjectPtr<UAssetImportTask> Task(NewObject<UAssetImportTask>(GetTransientPackage()));
    Task->Filename = Request.SourceFile;
    Task->DestinationPath = Request.DestinationPath;
    Task->bAutomated = true;
    Task->bReplaceExisting = false;
    Task->bReplaceExistingSettings = false;
    Task->bSave = false;
    Task->bAsync = false;
    if (!Source.Recheck(Error))
        return AssetImportPreflightFailure(TEXT("HAI_IDENTITY_CHANGED"), Error, TEXT("policy_blocked"));

    AssetToolsModule->Get().ImportAssetTasks({ Task.Get() });

    FString PostError;
    bool bStable = Source.Recheck(PostError);
    for (const TUniquePtr<FWinAssetSourceLease>& Lease : Referenced) bStable = Lease->Recheck(PostError) && bStable;

    TArray<FAssetData> After;
    Registry.GetAssetsByPath(FName(*Request.DestinationPath), After, /*bRecursive*/ true);
    TArray<TSharedPtr<FJsonValue>> Created, Meshes, Materials, Textures, Unexpected;
    for (const FAssetData& A : After)
    {
        const FString Path = A.GetObjectPathString();
        const FString Class = A.AssetClassPath.GetAssetName().ToString();
        TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("path"), Path);
        Item->SetStringField(TEXT("class"), Class);
        Created.Add(MakeShared<FJsonValueObject>(Item));
        if (A.AssetClassPath == UStaticMesh::StaticClass()->GetClassPathName()) Meshes.Add(MakeShared<FJsonValueString>(Path));
        else if (Class.StartsWith(TEXT("Material"))) Materials.Add(MakeShared<FJsonValueString>(Path));
        else if (Class.StartsWith(TEXT("Texture"))) Textures.Add(MakeShared<FJsonValueString>(Path));
        else Unexpected.Add(MakeShared<FJsonValueObject>(Item));
    }

    const bool bOk = bStable && Meshes.Num() > 0 && Unexpected.Num() == 0;
    TSharedPtr<FJsonObject> Out = MakeAssetImportState(
        bOk,
        bOk ? TEXT("HAI_IMPORTED") : (bStable ? TEXT("HAI_READBACK_MISMATCH") : TEXT("HAI_IDENTITY_CHANGED")),
        bOk ? FString() : (bStable
            ? FString::Printf(TEXT("asset_import [HAI_READBACK_MISMATCH]: expected only static meshes, materials and textures; got %d mesh(es) and %d other asset(s). Inspect created[] before retrying."), Meshes.Num(), Unexpected.Num())
            : PostError),
        TEXT("verify"),
        bOk ? TEXT("applied_unsaved") : (Created.Num() > 0 ? TEXT("partially_applied") : TEXT("unknown")));
    Out->SetStringField(TEXT("asset_type"), Request.AssetType);
    Out->SetStringField(TEXT("factory"), TEXT("Interchange (project default asset pipeline)"));
    Out->SetNumberField(TEXT("source_size_bytes"), static_cast<double>(TotalBytes));
    Out->SetNumberField(TEXT("referenced_files"), Referenced.Num());
    if (Meshes.Num() > 0) Out->SetStringField(TEXT("path"), Meshes[0]->AsString());
    Out->SetArrayField(TEXT("static_meshes"), Meshes);
    Out->SetArrayField(TEXT("materials"), Materials);
    Out->SetArrayField(TEXT("textures"), Textures);
    Out->SetArrayField(TEXT("created"), Created);
    Out->SetArrayField(TEXT("unexpected"), Unexpected);
    Out->SetNumberField(TEXT("succeeded"), bOk ? Created.Num() : 0);
    Out->SetBoolField(TEXT("verified"), bOk);
    Out->SetBoolField(TEXT("readback_verified"), bOk);
    Out->SetBoolField(TEXT("partial"), !bOk && Created.Num() > 0);
    Out->SetBoolField(TEXT("unknown_outcome"), !bOk);
    if (!bOk) Out->SetStringField(TEXT("failure_kind"), bStable ? TEXT("unknown_outcome") : TEXT("session_suspect"));
    Out->SetArrayField(TEXT("warnings"), {
        MakeShared<FJsonValueString>(TEXT("Trusted-root and reference checks do not prove a crafted file safe for the in-process importer; only import files you produced.")),
        MakeShared<FJsonValueString>(TEXT("Nothing is on disk yet: call asset_save with the created paths.")),
    });
    return FHaybaHandlerResult::Ok(Out);
}
#endif

/** A skeletal import creates a set of assets whose names depend on the file's takes and
 *  materials, so it is verified by what appeared in the folder, never by the returned
 *  pointers (import callbacks may invalidate those). */
static FHaybaHandlerResult VerifySkeletalImport(const HaybaAssetImport::FRequest& Request, IAssetRegistry& Registry,
    const TSet<FString>& BeforeImport, bool bSourceIdentityStable, const FString& PostIdentityError,
    const FString& FactoryName, int64 SourceBytes)
{
    const HaybaAssetImport::FSkeletalOptions& S = Request.Skeletal;
    TArray<FAssetData> InFolder;
    Registry.GetAssetsByPath(FName(*Request.DestinationPath), InFolder, /*bRecursive*/ false);

    FString MeshPath, SkeletonPath, PhysicsPath;
    TArray<TSharedPtr<FJsonValue>> Created, Anims, Materials, Textures;
    for (const FAssetData& A : InFolder)
    {
        const FString Path = A.GetObjectPathString();
        if (BeforeImport.Contains(Path)) continue;
        const FTopLevelAssetPath Class = A.AssetClassPath;
        TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("path"), Path);
        Item->SetStringField(TEXT("class"), Class.GetAssetName().ToString());
        Created.Add(MakeShared<FJsonValueObject>(Item));
        if (Class == USkeletalMesh::StaticClass()->GetClassPathName() && Path == Request.ExpectedObjectPath) MeshPath = Path;
        else if (Class == USkeleton::StaticClass()->GetClassPathName()) SkeletonPath = Path;
        else if (Class == UPhysicsAsset::StaticClass()->GetClassPathName()) PhysicsPath = Path;
        else if (Class == UAnimSequence::StaticClass()->GetClassPathName()) Anims.Add(MakeShared<FJsonValueString>(Path));
        else if (Class.GetAssetName().ToString().StartsWith(TEXT("Material"))) Materials.Add(MakeShared<FJsonValueString>(Path));
        else if (Class.GetAssetName().ToString().StartsWith(TEXT("Texture"))) Textures.Add(MakeShared<FJsonValueString>(Path));
    }

    TArray<FString> Missing;
    TArray<TSharedPtr<FJsonValue>> Warnings;
    if (S.bImportMesh && MeshPath.IsEmpty()) Missing.Add(TEXT("the skeletal mesh ") + Request.ExpectedObjectPath);
    if (S.bImportMesh && S.Skeleton.IsEmpty() && SkeletonPath.IsEmpty()) Missing.Add(TEXT("a new Skeleton"));
    if (!S.bImportMesh && Anims.Num() == 0) Missing.Add(TEXT("any AnimSequence"));
    if (S.bImportMesh && S.bCreatePhysicsAsset && PhysicsPath.IsEmpty())
        Warnings.Add(MakeShared<FJsonValueString>(TEXT("No PhysicsAsset was created (a mesh without suitable bones gets none).")));
    if (S.bImportMesh && S.bImportAnimations && Anims.Num() == 0)
        Warnings.Add(MakeShared<FJsonValueString>(TEXT("import_animations was on but the FBX produced no AnimSequence (no takes?).")));

    int32 BoneCount = 0;
    TSharedPtr<FJsonObject> Bounds;
    if (const USkeletalMesh* Mesh = MeshPath.IsEmpty() ? nullptr : LoadObject<USkeletalMesh>(nullptr, *MeshPath))
    {
        BoneCount = Mesh->GetRefSkeleton().GetNum();
        const FBoxSphereBounds B = Mesh->GetBounds();
        Bounds = MakeShared<FJsonObject>();
        Bounds->SetArrayField(TEXT("origin"), { MakeShared<FJsonValueNumber>(B.Origin.X), MakeShared<FJsonValueNumber>(B.Origin.Y), MakeShared<FJsonValueNumber>(B.Origin.Z) });
        Bounds->SetArrayField(TEXT("extent"), { MakeShared<FJsonValueNumber>(B.BoxExtent.X), MakeShared<FJsonValueNumber>(B.BoxExtent.Y), MakeShared<FJsonValueNumber>(B.BoxExtent.Z) });
        Bounds->SetNumberField(TEXT("radius"), B.SphereRadius);
    }
    else if (const USkeleton* Target = S.Skeleton.IsEmpty() ? nullptr : LoadObject<USkeleton>(nullptr, *S.Skeleton))
    {
        BoneCount = Target->GetReferenceSkeleton().GetNum();
    }

    const bool bOk = bSourceIdentityStable && Missing.Num() == 0;
    TSharedPtr<FJsonObject> Out = MakeAssetImportState(
        bOk,
        bOk ? TEXT("HAI_IMPORTED") : (bSourceIdentityStable ? TEXT("HAI_READBACK_MISMATCH") : TEXT("HAI_IDENTITY_CHANGED")),
        bOk ? FString() : (bSourceIdentityStable
            ? TEXT("asset_import [HAI_READBACK_MISMATCH]: the skeletal import did not produce ") + FString::Join(Missing, TEXT(", ")) + TEXT("; inspect created[] before retrying")
            : PostIdentityError),
        TEXT("verify"),
        bOk ? TEXT("applied_unsaved") : (Created.Num() > 0 ? TEXT("partially_applied") : TEXT("unknown")));
    Out->SetStringField(TEXT("asset_type"), Request.AssetType);
    Out->SetStringField(TEXT("factory"), FactoryName);
    Out->SetNumberField(TEXT("source_size_bytes"), static_cast<double>(SourceBytes));
    if (!MeshPath.IsEmpty()) Out->SetStringField(TEXT("path"), MeshPath);
    Out->SetStringField(TEXT("skeletal_mesh"), MeshPath);
    Out->SetStringField(TEXT("skeleton"), SkeletonPath.IsEmpty() ? S.Skeleton : SkeletonPath);
    Out->SetStringField(TEXT("physics_asset"), PhysicsPath.IsEmpty() ? S.PhysicsAsset : PhysicsPath);
    Out->SetArrayField(TEXT("anim_sequences"), Anims);
    Out->SetArrayField(TEXT("materials"), Materials);
    Out->SetArrayField(TEXT("textures"), Textures);
    Out->SetArrayField(TEXT("created"), Created);
    Out->SetNumberField(TEXT("bone_count"), BoneCount);
    if (Bounds.IsValid()) Out->SetObjectField(TEXT("bounds"), Bounds);
    Out->SetNumberField(TEXT("succeeded"), bOk ? Created.Num() : 0);
    Out->SetBoolField(TEXT("verified"), bOk);
    Out->SetBoolField(TEXT("readback_verified"), bOk);
    Out->SetBoolField(TEXT("partial"), !bOk && Created.Num() > 0);
    Out->SetBoolField(TEXT("unknown_outcome"), !bOk);
    if (!bOk) Out->SetStringField(TEXT("failure_kind"), bSourceIdentityStable ? TEXT("unknown_outcome") : TEXT("session_suspect"));
    Warnings.Add(MakeShared<FJsonValueString>(TEXT("Nothing is on disk yet: call asset_save with the created paths.")));
    Out->SetArrayField(TEXT("warnings"), Warnings);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetImport(const TSharedPtr<FJsonObject>& P)
{
    using namespace HaybaAssetImport;
    FRequest Request;
    FString Error;
    if (!ParseAndValidateRequest(P, Request, Error))
        return AssetImportPreflightFailure(TEXT("HAI_INVALID_REQUEST"), Error);

#if !PLATFORM_WINDOWS
    return AssetImportPreflightFailure(
        TEXT("HAI_PLATFORM_UNSUPPORTED"),
        TEXT("asset_import [HAI_PLATFORM_UNSUPPORTED]: this platform cannot provide the required no-follow pinned-handle authority; no import was started"),
        TEXT("policy_blocked"));
#else
    // glTF reads several files from a trusted root, not one file from the connector cache.
    if (Request.Kind == EKind::StaticMeshGltf || Request.Kind == EKind::StaticMeshGlb) return ImportGltf(Request);

    FWinAssetSourceLease SourceLease;
    if (!SourceLease.Open(Request, Error))
        return AssetImportPreflightFailure(
            AssetImportCodeFromError(Error, TEXT("HAI_AUTHORITY_REJECTED")),
            Error,
            TEXT("policy_blocked"));

    TArray<uint8> Header;
    if (!SourceLease.ReadHeader(Header, Error)
        || !ValidateFileHeader(Request.Kind, Header, SourceLease.GetFileBytes(), Error))
    {
        return AssetImportPreflightFailure(
            AssetImportCodeFromError(Error, TEXT("HAI_FORMAT_REJECTED")),
            Error,
            TEXT("policy_blocked"));
    }

    FAssetRegistryModule* RegistryModule =
        FModuleManager::LoadModulePtr<FAssetRegistryModule>(TEXT("AssetRegistry"));
    if (!RegistryModule)
        return AssetImportPreflightFailure(
            TEXT("HAI_MODULE_UNAVAILABLE"),
            TEXT("asset_import [HAI_MODULE_UNAVAILABLE]: AssetRegistry module is unavailable; retry after editor startup completes"),
            TEXT("retryable"));
    IAssetRegistry& Registry = RegistryModule->Get();
    if (Registry.IsLoadingAssets())
        return AssetImportPreflightFailure(
            TEXT("HAI_REGISTRY_BUSY"),
            TEXT("asset_import [HAI_REGISTRY_BUSY]: AssetRegistry is still discovering assets; retry after it is ready"),
            TEXT("retryable"));

    const FSoftObjectPath ExpectedSoftPath(Request.ExpectedObjectPath);
    if (Registry.GetAssetByObjectPath(ExpectedSoftPath).IsValid()
        || FindObject<UObject>(nullptr, *Request.ExpectedObjectPath) != nullptr
        || FindPackage(nullptr, *Request.ExpectedPackageName) != nullptr
        || FPackageName::DoesPackageExist(Request.ExpectedPackageName))
    {
        return AssetImportPreflightFailure(
            TEXT("HAI_COLLISION"),
            TEXT("asset_import [HAI_COLLISION]: the exact destination object/package already exists in registry, memory, or on disk; overwrite is never attempted"));
    }

    // A skeletal import creates several assets; snapshot the folder so every name it
    // could take is checked now and everything it created is found afterwards.
    TSet<FString> BeforeImport;
    if (Request.Kind == EKind::SkeletalMeshFbx)
    {
        TArray<FAssetData> InFolder;
        Registry.GetAssetsByPath(FName(*Request.DestinationPath), InFolder, /*bRecursive*/ false);
        TArray<FString> Names;
        for (const FAssetData& A : InFolder)
        {
            BeforeImport.Add(A.GetObjectPathString());
            Names.Add(A.AssetName.ToString());
        }
        const FString Clash = SkeletalCollision(Request, Names);
        if (!Clash.IsEmpty())
            return AssetImportPreflightFailure(TEXT("HAI_COLLISION"), FString::Printf(
                TEXT("asset_import [HAI_COLLISION]: '%s' already exists in %s and this skeletal import could create or overwrite it; skipped. Import into a fresh folder or rename the source."),
                *Clash, *Request.DestinationPath));
    }

    FAssetToolsModule* AssetToolsModule =
        FModuleManager::LoadModulePtr<FAssetToolsModule>(TEXT("AssetTools"));
    if (!AssetToolsModule)
        return AssetImportPreflightFailure(
            TEXT("HAI_MODULE_UNAVAILABLE"),
            TEXT("asset_import [HAI_MODULE_UNAVAILABLE]: AssetTools module is unavailable; no import was started"),
            TEXT("retryable"));

    UClass* ExpectedClass = nullptr;
    FString FactoryName;
    TStrongObjectPtr<UFactory> Factory(
        CreatePinnedImportFactory(Request, ExpectedClass, FactoryName, Error));
    if (!Factory.IsValid() || !ExpectedClass)
    {
        const FString Code = AssetImportCodeFromError(Error, TEXT("HAI_FACTORY_UNAVAILABLE"));
        return AssetImportPreflightFailure(Code, Error,
            Code == TEXT("HAI_INVALID_REQUEST") ? TEXT("input_rejected") : TEXT("retryable"));
    }
    if (!Factory->FactoryCanImport(Request.SourceFile))
        return AssetImportPreflightFailure(
            TEXT("HAI_FACTORY_REJECTED"),
            TEXT("asset_import [HAI_FACTORY_REJECTED]: the exact allowlisted factory rejected the extension; fallback factory selection is forbidden"));
    TStrongObjectPtr<UAutomatedAssetImportData> ImportData(
        NewObject<UAutomatedAssetImportData>(GetTransientPackage()));
    if (!ImportData.IsValid())
        return AssetImportPreflightFailure(
            TEXT("HAI_IMPORT_SETUP_FAILED"),
            TEXT("asset_import [HAI_IMPORT_SETUP_FAILED]: bounded import task allocation failed; no import was started"),
            TEXT("retryable"));
    ImportData->GroupName = TEXT("HaybaPinnedSingleFileImport");
    ImportData->Filenames = { Request.SourceFile };
    ImportData->DestinationPath = Request.DestinationPath;
    ImportData->Factory = Factory.Get();
    ImportData->FactoryName = Factory->GetClass()->GetPathName();
    ImportData->bReplaceExisting = false;
    ImportData->bSkipReadOnly = true;
    const FTopLevelAssetPath ExpectedClassPath = ExpectedClass->GetClassPathName();

    // Recheck the collision immediately at the mutation seam. The earlier
    // check avoids loading/configuring editor factories for an obvious
    // refusal; this second check closes that setup window. AssetTools also
    // receives bReplaceExisting=false, so a later race remains a refusal.
    if (Registry.GetAssetByObjectPath(ExpectedSoftPath).IsValid()
        || FindObject<UObject>(nullptr, *Request.ExpectedObjectPath) != nullptr
        || FindPackage(nullptr, *Request.ExpectedPackageName) != nullptr
        || FPackageName::DoesPackageExist(Request.ExpectedPackageName))
    {
        return AssetImportPreflightFailure(
            TEXT("HAI_COLLISION"),
            TEXT("asset_import [HAI_COLLISION]: the exact destination appeared during preflight; no import was started and overwrite remains forbidden"));
    }
    if (!SourceLease.Recheck(Error))
        return AssetImportPreflightFailure(TEXT("HAI_IDENTITY_CHANGED"), Error, TEXT("policy_blocked"));

    // The verified source handle and every ancestor handle remain open with no
    // write/delete sharing across this synchronous call. UE5.8's exact
    // SpecifiedFactory path disables Interchange auto-selection. The returned
    // UObject pointers are intentionally never dereferenced: import callbacks
    // may invalidate them. Only the bounded count survives to fresh registry
    // and package re-resolution below.
    TArray<UObject*> ImportedPointers = AssetToolsModule->Get().ImportAssetsAutomated(ImportData.Get());
    const int32 ReturnedPointerCount = ImportedPointers.Num();
    FString PostIdentityError;
    const bool bSourceIdentityStable = SourceLease.Recheck(PostIdentityError);

    if (Request.Kind == EKind::SkeletalMeshFbx)
        return VerifySkeletalImport(Request, Registry, BeforeImport, bSourceIdentityStable, PostIdentityError,
            FactoryName, SourceLease.GetFileBytes());

    const FAssetData Readback = Registry.GetAssetByObjectPath(ExpectedSoftPath);
    const bool bReadbackExists = Readback.IsValid();
    const bool bPathMatches = bReadbackExists
        && Readback.GetObjectPathString().Equals(Request.ExpectedObjectPath, ESearchCase::CaseSensitive)
        && Readback.PackageName.ToString().Equals(Request.ExpectedPackageName, ESearchCase::CaseSensitive)
        && Readback.AssetName.ToString().Equals(Request.AssetName, ESearchCase::CaseSensitive);
    const bool bClassMatches = bPathMatches && Readback.AssetClassPath == ExpectedClassPath;
    UPackage* FreshPackage = FindPackage(nullptr, *Request.ExpectedPackageName);
    const bool bDirtyKnown = FreshPackage != nullptr;
    const bool bDirty = FreshPackage && FreshPackage->IsDirty();
    const bool bSaved = FPackageName::DoesPackageExist(Request.ExpectedPackageName);
    const bool bVerified = bSourceIdentityStable && ReturnedPointerCount == 1
        && bPathMatches && bClassMatches && FreshPackage != nullptr;

    if (!bVerified)
    {
        const bool bMayHaveMutated = ReturnedPointerCount > 0 || bReadbackExists || FreshPackage != nullptr || bSaved;
        const bool bSessionSuspect = !bSourceIdentityStable || ReturnedPointerCount > 1
            || (ReturnedPointerCount > 0 && !bReadbackExists) || (bReadbackExists && (!bPathMatches || !bClassMatches));
        TSharedPtr<FJsonObject> Out = MakeAssetImportState(
            false,
            bSourceIdentityStable ? TEXT("HAI_READBACK_MISMATCH") : TEXT("HAI_IDENTITY_CHANGED"),
            bSourceIdentityStable
                ? TEXT("asset_import [HAI_READBACK_MISMATCH]: import returned without exactly one expected registry/path/class/package identity; do not retry unchanged")
                : PostIdentityError,
            TEXT("verify"),
            bMayHaveMutated ? TEXT("partially_applied") : TEXT("unknown"));
        Out->SetStringField(TEXT("asset_type"), Request.AssetType);
        Out->SetStringField(TEXT("factory"), FactoryName);
        Out->SetNumberField(TEXT("source_size_bytes"), static_cast<double>(SourceLease.GetFileBytes()));
        Out->SetNumberField(TEXT("returned_pointer_count"), ReturnedPointerCount);
        Out->SetNumberField(TEXT("succeeded"), bPathMatches && bClassMatches ? 1 : 0);
        Out->SetBoolField(TEXT("saved"), bSaved);
        Out->SetBoolField(TEXT("dirty_known"), bDirtyKnown);
        Out->SetBoolField(TEXT("dirty"), bDirty);
        Out->SetBoolField(TEXT("partial"), bMayHaveMutated);
        Out->SetBoolField(TEXT("unknown_outcome"), true);
        Out->SetBoolField(TEXT("session_suspect"), bSessionSuspect);
        Out->SetStringField(TEXT("failure_kind"), bSessionSuspect
            ? TEXT("session_suspect") : TEXT("unknown_outcome"));
        Out->SetArrayField(TEXT("warnings"), {
            MakeShared<FJsonValueString>(TEXT("Header, size, factory, and pinned-handle checks reduce exposure but do not prove crafted-format parser safety; use an isolated sanitizer for untrusted remote files."))
        });
        return FHaybaHandlerResult::Ok(Out);
    }

    TSharedPtr<FJsonObject> Out = MakeAssetImportState(
        true, TEXT("HAI_IMPORTED"), FString(), TEXT("verify"),
        bSaved ? TEXT("applied") : TEXT("applied_unsaved"));
    Out->SetStringField(TEXT("path"), Readback.GetObjectPathString());
    Out->SetStringField(TEXT("class"), Readback.AssetClassPath.ToString());
    Out->SetStringField(TEXT("asset_type"), Request.AssetType);
    Out->SetStringField(TEXT("factory"), FactoryName);
    Out->SetNumberField(TEXT("source_size_bytes"), static_cast<double>(SourceLease.GetFileBytes()));
    Out->SetNumberField(TEXT("returned_pointer_count"), ReturnedPointerCount);
    Out->SetNumberField(TEXT("succeeded"), 1);
    Out->SetBoolField(TEXT("verified"), true);
    Out->SetBoolField(TEXT("readback_verified"), true);
    Out->SetBoolField(TEXT("saved"), bSaved);
    Out->SetBoolField(TEXT("dirty_known"), bDirtyKnown);
    Out->SetBoolField(TEXT("dirty"), bDirty);
    Out->SetStringField(TEXT("persistence"), bSaved
        ? TEXT("disk_present")
        : (bDirty ? TEXT("dirty_in_memory") : TEXT("unsaved_in_memory")));
    Out->SetArrayField(TEXT("warnings"), {
        MakeShared<FJsonValueString>(TEXT("Format header and size checks do not prove a crafted file safe for the in-process UE factory. The exact imported object was registry-verified, but untrusted remote files still need an isolated sanitizer."))
    });
    Out->SetArrayField(TEXT("tips"), {
        MakeShared<FJsonValueString>(bSaved
            ? TEXT("The package is present on disk; inspect the returned class/path before using it.")
            : TEXT("The verified asset is not on disk yet. Call asset_save on the exact returned path before relying on persistence."))
    });
    return FHaybaHandlerResult::Ok(Out);
#endif
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

/** Strip whitespace/newlines agents inject via line-wrapping. UE object paths
 *  never contain whitespace; leaving it in breaks DoesAssetExist / load. */
static FString NormalizeAssetObjectPath(const FString& In)
{
    FString Out;
    Out.Reserve(In.Len());
    for (TCHAR C : In)
    {
        if (!FChar::IsWhitespace(C))
        {
            Out.AppendChar(C);
        }
    }
    return Out;
}

/** Force-delete one asset without raising a confirmation / save modal. */
static bool ForceDeleteAssetNoModal(const FString& Path)
{
    TGuardValue<bool> Unattended(GIsRunningUnattendedScript, true);

    UObject* Obj = StaticLoadObject(UObject::StaticClass(), nullptr, *Path);
    if (Obj && GEditor)
    {
        if (UAssetEditorSubsystem* Editors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>())
        {
            Editors->CloseAllEditorsForAsset(Obj);
        }

        TArray<UObject*> ToDelete;
        ToDelete.Add(Obj);
        return ObjectTools::ForceDeleteObjects(ToDelete, /*bShowConfirmation=*/false) > 0;
    }

    return UEditorAssetLibrary::DeleteAsset(Path);
}

FHaybaHandlerResult FHaybaMCPAssetHandler::AssetDelete(const TSharedPtr<FJsonObject>& P)
{
    // Accept one path or many. Deleting a set is the real use, and doing it one
    // call at a time is what made a partial failure look like a clean sweep.
    TArray<FString> Paths;
    FString Single;
    if (P->TryGetStringField(TEXT("path"), Single) && !Single.IsEmpty())
    {
        const FString Clean = NormalizeAssetObjectPath(Single);
        if (!Clean.IsEmpty()) Paths.Add(Clean);
    }
    const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
    if (P->TryGetArrayField(TEXT("paths"), Arr) && Arr)
    {
        for (const TSharedPtr<FJsonValue>& V : *Arr)
        {
            const FString Clean = NormalizeAssetObjectPath(V->AsString());
            if (!Clean.IsEmpty()) Paths.Add(Clean);
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

        const bool bReported = ForceDeleteAssetNoModal(Path);
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

// ---------------------------------------------------------------------------
// asset_save: the native replacement for the python-backed save and for
// EditorAssetLibrary.save_asset in lane scripts. Named packages only: the old
// "no paths = save every dirty package" mode wrote other agents' half-built
// work to disk in a shared editor. Maps are refused (level_save owns them).
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPAssetHandler::AssetSave(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("asset_save"));
    const TArray<TSharedPtr<FJsonValue>>* Paths = R.RequiredArray(TEXT("asset_paths"), 1, 64);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());
    if (GEditor && GEditor->IsPlaySessionInProgress())
        return FHaybaHandlerResult::Err(TEXT("asset_save: a Play-In-Editor session is running; stop it first. Nothing was saved."));
    if (UE::IsSavingPackage() || IsGarbageCollecting())
        return FHaybaHandlerResult::Err(TEXT("asset_save: the editor is already saving or collecting garbage; retry in a moment. Nothing was saved."));

    TArray<TSharedPtr<FJsonValue>> Saved, Skipped, Failed;
    auto Note = [](TArray<TSharedPtr<FJsonValue>>& List, const FString& Path, const FString& Reason)
    {
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("path"), Path);
        Entry->SetStringField(TEXT("reason"), Reason);
        List.Add(MakeShared<FJsonValueObject>(Entry));
    };

    for (const TSharedPtr<FJsonValue>& V : *Paths)
    {
        const FString Path = V.IsValid() && V->Type == EJson::String ? V->AsString() : FString();
        // "/Game/X/Y.Y" and "/Game/X/Y" name the same package.
        FString PackageName = Path;
        int32 Dot = INDEX_NONE;
        if (PackageName.FindChar(TEXT('.'), Dot)) PackageName.LeftInline(Dot);
        if (!PackageName.StartsWith(TEXT("/Game/")) || !FPackageName::IsValidLongPackageName(PackageName))
        {
            Note(Failed, Path, TEXT("not a /Game/ asset path"));
            continue;
        }
        UPackage* Package = FindPackage(nullptr, *PackageName);
        if (!Package) { Note(Skipped, Path, TEXT("not loaded, so nothing in memory to save")); continue; }
        if (Package->ContainsMap()) { Note(Failed, Path, TEXT("is a map; save levels with level_save")); continue; }
        if (!Package->IsDirty()) { Note(Skipped, Path, TEXT("already saved (not dirty)")); continue; }

        // A Blueprint mid-compile would serialize a half-built class.
        bool bCompiling = false;
        ForEachObjectWithPackage(Package, [&bCompiling](UObject* Object)
        {
            if (const UBlueprint* BP = Cast<UBlueprint>(Object)) bCompiling |= BP->bBeingCompiled;
            return !bCompiling;
        }, false);
        if (bCompiling) { Note(Failed, Path, TEXT("a Blueprint in it is compiling; retry after blueprint_compile returns")); continue; }

        FString Filename;
        if (!FPackageName::TryConvertLongPackageNameToFilename(PackageName, Filename, FPackageName::GetAssetPackageExtension()))
        {
            Note(Failed, Path, TEXT("has no file location"));
            continue;
        }
        // A read-only file would make the save fail, or prompt and stall the game thread.
        const TArray<FString> ReadOnly = HaybaSaveVerify::FindReadOnlyPackageFiles(Package);
        if (ReadOnly.Num() > 0)
        {
            Note(Failed, Path, TEXT("read-only on disk; nothing was saved. ") + HaybaSaveVerify::MakeWritableHint(ReadOnly, FString()));
            continue;
        }

        const FDateTime Before = FDateTime::UtcNow() - FTimespan::FromSeconds(2);
        // The toolkit's one raw SavePackage: SAVE_NoError, so no modal error dialog mid-command.
        const bool bSaveReturned = HaybaSaveVerify::Detail::SavePackageNoError(Package, nullptr, Filename);
        // Verify the effect, not the reply: clean in memory and a fresh file on disk.
        const FDateTime Stamp = IFileManager::Get().GetTimeStamp(*Filename);
        if (bSaveReturned && !Package->IsDirty() && Stamp != FDateTime::MinValue() && Stamp >= Before)
        {
            Saved.Add(MakeShared<FJsonValueString>(Path));
        }
        else
        {
            Note(Failed, Path, bSaveReturned
                ? TEXT("SavePackage returned true but the package is still dirty or the file did not update; check it before relying on it")
                : TEXT("SavePackage failed; see the Output Log. The package is still dirty in memory"));
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), Failed.Num() == 0);
    Out->SetArrayField(TEXT("saved"), Saved);
    Out->SetNumberField(TEXT("saved_count"), Saved.Num());
    Out->SetArrayField(TEXT("skipped"), Skipped);
    Out->SetArrayField(TEXT("failed"), Failed);
    Out->SetBoolField(TEXT("verified"), Failed.Num() == 0);
    return FHaybaHandlerResult::Ok(Out);
}
