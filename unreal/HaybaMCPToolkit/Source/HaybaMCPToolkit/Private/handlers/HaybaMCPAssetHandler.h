#pragma once
#include "IHaybaMCPHandler.h"

struct FAssetData;

namespace HaybaAssetImport
{
    enum class EKind : uint8
    {
        TexturePng,
        TextureJpeg,
        SoundWave,
        StaticMeshFbx,
    };

    struct FRequest
    {
        FString SourceFile;
        FString DestinationPath;
        FString AssetType;
        FString AssetName;
        FString ExpectedPackageName;
        FString ExpectedObjectPath;
        FString Extension;
        EKind Kind = EKind::TexturePng;
        int64 MaxFileBytes = 0;
    };

    /** Pure request/type/path parsing. No filesystem, module, or editor access. */
    bool ParseAndValidateRequest(const TSharedPtr<FJsonObject>& Json, FRequest& Out, FString& Error);

    /** Pure bounded format-header validation over bytes read from the pinned source handle. */
    bool ValidateFileHeader(EKind Kind, TConstArrayView<uint8> Header, int64 FileBytes, FString& Error);

    /** Pure per-kind byte cap used by both request shaping and the pinned-handle check. */
    int64 MaxFileBytesForKind(EKind Kind);
    bool ValidateFileSize(EKind Kind, int64 FileBytes, FString& Error);
}

class FHaybaMCPAssetHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("asset"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult AssetSearch(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetRegistryQuery(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetGetInfo(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetImport(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetDuplicate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetDelete(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetGetReferences(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetValidate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetRename(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetMove(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetFixRedirectors(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetGetDependencies(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetGetReferencers(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult ObjectGetProperty(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult ObjectSetProperty(const TSharedPtr<FJsonObject>& P);

    // gh#15: base64-PNG thumbnail preview for an asset. Returns empty string if
    // thumbnail cannot be produced.
    static FString GetAssetThumbnailBase64Png(const FAssetData& AssetData, int32 Size = 256);
};
