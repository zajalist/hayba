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
        SkeletalMeshFbx,
        /** .gltf (JSON + referenced files) and .glb, read only from a TrustedImportRoots folder. */
        StaticMeshGltf,
        StaticMeshGlb,
    };

    // glTF policy limits (approved for FoA): JSON, each referenced file, and their total.
    constexpr int64 MaxGltfJsonBytes = 64ll * 1024ll * 1024ll;
    constexpr int64 MaxGltfFileBytes = 512ll * 1024ll * 1024ll;
    constexpr int64 MaxGltfTotalBytes = 1024ll * 1024ll * 1024ll;

    /** asset_type "skeletal_mesh" only, from the request's `options` object. */
    struct FSkeletalOptions
    {
        /** Existing USkeleton object path; empty creates <Name>_Skeleton. */
        FString Skeleton;
        /** false = animation-only import onto Skeleton (required then). */
        bool bImportMesh = true;
        bool bCreatePhysicsAsset = true;
        /** Existing UPhysicsAsset to use instead of creating one. */
        FString PhysicsAsset;
        bool bImportAnimations = false;
        bool bImportMaterials = false;
        bool bImportTextures = false;
        bool bImportMorphTargets = false;
        /** "import" (default), "compute" or "import_and_tangents". */
        FString NormalImportMethod = TEXT("import");
        bool bUseT0AsRefPose = false;
        bool bUpdateSkeletonReferencePose = false;
    };

    struct FRequest
    {
        FSkeletalOptions Skeletal;
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

    /** Pure: the first asset name in the destination folder that a skeletal import
     *  could create or overwrite (mesh, <Name>_Skeleton, <Name>_PhysicsAsset, or the
     *  animation prefix), or empty when the folder is clear. */
    FString SkeletalCollision(const FRequest& Request, const TArray<FString>& ExistingNames);

    /** Pure: a glTF buffer/image URI that names a file below the .gltf's own folder
     *  (no scheme, drive, root, "..", escapes, query or excessive depth). */
    bool IsSafeRelativeUri(const FString& Uri);

    /** Pure: glTF 2.0 policy over the JSON. Rejects other versions, required
     *  extensions outside KHR_materials_* / KHR_texture_transform /
     *  KHR_mesh_quantization, skins or animations (static_mesh only), and any URI
     *  that is neither a data: URI nor IsSafeRelativeUri. OutRelativeUris lists the
     *  files that must be pinned before import. */
    bool ValidateGltfJson(const FString& JsonText, TArray<FString>& OutRelativeUris, FString& Error);

    /** Pure: the GLB container header, returning the JSON chunk's length. */
    bool ValidateGlbHeader(TConstArrayView<uint8> Header, int64 FileBytes, uint32& OutJsonBytes, FString& Error);
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
    /** Save named, loaded, dirty content packages natively (never maps, never "all dirty"). */
    FHaybaHandlerResult AssetSave(const TSharedPtr<FJsonObject>& P);
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
