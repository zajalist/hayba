#include "HaybaMCPStaticMeshHandler.h"

#include "Engine/StaticMesh.h"
#include "StaticMeshResources.h"
#include "Materials/MaterialInterface.h"
#include "UObject/SoftObjectPath.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/ARFilter.h"
#include "Dom/JsonObject.h"

TArray<FString> FHaybaMCPStaticMeshHandler::GetCommands() const
{
    return {
        TEXT("mesh_get_info"),
        TEXT("mesh_set_lod"),
        TEXT("mesh_list")
    };
}

static TSharedRef<FJsonObject> Vec3ToJson(const FVector& V)
{
    auto O = MakeShared<FJsonObject>();
    O->SetNumberField(TEXT("x"), V.X);
    O->SetNumberField(TEXT("y"), V.Y);
    O->SetNumberField(TEXT("z"), V.Z);
    return O;
}

static FHaybaHandlerResult MeshGetInfo(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("mesh_get_info: missing params"));
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("mesh_get_info: missing arg path"));

    UStaticMesh* Mesh = Cast<UStaticMesh>(FSoftObjectPath(Path).TryLoad());
    if (!Mesh) return FHaybaHandlerResult::Err(FString::Printf(TEXT("mesh_get_info: failed to load %s"), *Path));

    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Path);
    Out->SetStringField(TEXT("name"), Mesh->GetName());

    int32 LodCount = Mesh->GetNumLODs();
    Out->SetNumberField(TEXT("lod_count"), LodCount);

    int32 TriLOD0 = 0;
    int32 NumVertsLOD0 = 0;
    if (Mesh->GetRenderData() && Mesh->GetRenderData()->LODResources.Num() > 0)
    {
        const FStaticMeshLODResources& LOD0 = Mesh->GetRenderData()->LODResources[0];
        TriLOD0 = LOD0.GetNumTriangles();
        NumVertsLOD0 = LOD0.GetNumVertices();
    }
    Out->SetNumberField(TEXT("triangle_count_lod0"), TriLOD0);
    Out->SetNumberField(TEXT("num_vertices_lod0"), NumVertsLOD0);

    TArray<TSharedPtr<FJsonValue>> ScreenSizes;
#if WITH_EDITOR
    for (int32 i = 0; i < Mesh->GetNumSourceModels(); ++i)
    {
        ScreenSizes.Add(MakeShared<FJsonValueNumber>(Mesh->GetSourceModel(i).ScreenSize.Default));
    }
#else
    if (Mesh->GetRenderData())
    {
        for (const FStaticMeshLODResources& LR : Mesh->GetRenderData()->LODResources)
        {
            ScreenSizes.Add(MakeShared<FJsonValueNumber>(0.0));
        }
    }
#endif
    Out->SetArrayField(TEXT("lod_screen_sizes"), ScreenSizes);

    TArray<TSharedPtr<FJsonValue>> Slots;
    for (const FStaticMaterial& SM : Mesh->GetStaticMaterials())
    {
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), SM.MaterialSlotName.ToString());
        Entry->SetStringField(TEXT("material_path"),
            SM.MaterialInterface ? SM.MaterialInterface->GetPathName() : FString());
        Slots.Add(MakeShared<FJsonValueObject>(Entry));
    }
    Out->SetArrayField(TEXT("material_slots"), Slots);

    const FBoxSphereBounds B = Mesh->GetBounds();
    const FVector Min = B.Origin - B.BoxExtent;
    const FVector Max = B.Origin + B.BoxExtent;
    auto Bounds = MakeShared<FJsonObject>();
    Bounds->SetObjectField(TEXT("min"), Vec3ToJson(Min));
    Bounds->SetObjectField(TEXT("max"), Vec3ToJson(Max));
    Bounds->SetObjectField(TEXT("extents"), Vec3ToJson(B.BoxExtent));
    Out->SetObjectField(TEXT("bounds"), Bounds);

    return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult MeshSetLOD(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("mesh_set_lod: missing params"));
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("mesh_set_lod: missing arg path"));
    int32 LodIndex = 0;
    if (!P->TryGetNumberField(TEXT("lod_index"), LodIndex))
        return FHaybaHandlerResult::Err(TEXT("mesh_set_lod: missing arg lod_index"));
    double ScreenSize = 0.0;
    if (!P->TryGetNumberField(TEXT("screen_size"), ScreenSize))
        return FHaybaHandlerResult::Err(TEXT("mesh_set_lod: missing arg screen_size"));

    UStaticMesh* Mesh = Cast<UStaticMesh>(FSoftObjectPath(Path).TryLoad());
    if (!Mesh) return FHaybaHandlerResult::Err(FString::Printf(TEXT("mesh_set_lod: failed to load %s"), *Path));

#if WITH_EDITOR
    if (LodIndex < 0 || LodIndex >= Mesh->GetNumSourceModels())
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("mesh_set_lod: lod_index %d out of range"), LodIndex));

    Mesh->Modify();
    FStaticMeshSourceModel& SM = Mesh->GetSourceModel(LodIndex);
    SM.ScreenSize = (float)ScreenSize;

    double ReductionPercent;
    if (P->TryGetNumberField(TEXT("reduction_percent_triangles"), ReductionPercent))
    {
        SM.ReductionSettings.PercentTriangles = (float)ReductionPercent;
    }
    Mesh->PostEditChange();

    auto Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), true);
    Out->SetStringField(TEXT("path"), Path);
    Out->SetNumberField(TEXT("lod_index"), LodIndex);
    Out->SetNumberField(TEXT("screen_size"), ScreenSize);
    return FHaybaHandlerResult::Ok(Out);
#else
    return FHaybaHandlerResult::Err(TEXT("mesh_set_lod: editor-only command"));
#endif
}

static FHaybaHandlerResult MeshList(const TSharedPtr<FJsonObject>& P)
{
    FString Prefix;
    if (P.IsValid()) P->TryGetStringField(TEXT("path_prefix"), Prefix);

    FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
    IAssetRegistry& AR = ARM.Get();

    TArray<FAssetData> Assets;
    AR.GetAssetsByClass(UStaticMesh::StaticClass()->GetClassPathName(), Assets);

    TArray<TSharedPtr<FJsonValue>> Items;
    for (const FAssetData& A : Assets)
    {
        const FString ObjPath = A.GetObjectPathString();
        if (!Prefix.IsEmpty() && !ObjPath.StartsWith(Prefix)) continue;
        auto E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("path"), ObjPath);
        E->SetStringField(TEXT("name"), A.AssetName.ToString());
        E->SetStringField(TEXT("package_path"), A.PackagePath.ToString());
        Items.Add(MakeShared<FJsonValueObject>(E));
    }

    auto Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("meshes"), Items);
    Out->SetNumberField(TEXT("count"), Items.Num());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPStaticMeshHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("mesh_get_info")) return MeshGetInfo(Params);
    if (Cmd == TEXT("mesh_set_lod"))  return MeshSetLOD(Params);
    if (Cmd == TEXT("mesh_list"))     return MeshList(Params);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("StaticMeshHandler: unknown command %s"), *Cmd));
}
