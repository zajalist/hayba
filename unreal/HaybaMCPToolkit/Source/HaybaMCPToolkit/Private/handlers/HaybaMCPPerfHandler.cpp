#include "HaybaMCPPerfHandler.h"
#include "Json.h"
#include "Misc/App.h"
#include "HAL/PlatformMemory.h"
#include "RHI.h"
#include "RHIGlobals.h"
#include "RHIStats.h"
#include "DynamicRHI.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Engine/Texture.h"
#include "Engine/Texture2D.h"
#include "Engine/StaticMesh.h"
#include "PixelFormat.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPPerf, Log, All);

extern ENGINE_API float GAverageFPS;
extern ENGINE_API float GAverageMS;

TArray<FString> FHaybaMCPPerfHandler::GetCommands() const
{
    return {
        TEXT("editor_get_perf_stats"),
        TEXT("texture_audit"),
        TEXT("mesh_audit"),
    };
}

FHaybaHandlerResult FHaybaMCPPerfHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("editor_get_perf_stats")) return GetPerfStats(P);
    if (Cmd == TEXT("texture_audit"))         return TextureAudit(P);
    if (Cmd == TEXT("mesh_audit"))            return MeshAudit(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("PerfHandler: unknown command %s"), *Cmd));
}

FHaybaHandlerResult FHaybaMCPPerfHandler::GetPerfStats(const TSharedPtr<FJsonObject>& P)
{
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();

    // Frame timing
    const float DeltaSec = FApp::GetDeltaTime();
    const float DeltaMs  = DeltaSec * 1000.0f;
    Out->SetNumberField(TEXT("avg_fps"), GAverageFPS);
    Out->SetNumberField(TEXT("avg_frame_ms"), GAverageMS);
    Out->SetNumberField(TEXT("last_delta_ms"), DeltaMs);

    // RHI counters: in UE 5.7 GNumDrawCallsRHI / GNumPrimitivesDrawnRHI are
    // per-GPU global int32 arrays declared in RHIStats.h. Index 0 == primary GPU.
    Out->SetNumberField(TEXT("draw_calls"), (double)GNumDrawCallsRHI[0]);
    Out->SetNumberField(TEXT("primitives_drawn"), (double)GNumPrimitivesDrawnRHI[0]);

    // Memory
    const FPlatformMemoryStats MemStats = FPlatformMemory::GetStats();
    Out->SetNumberField(TEXT("cpu_used_physical_mb"), (double)(MemStats.UsedPhysical  / (1024.0 * 1024.0)));
    Out->SetNumberField(TEXT("cpu_used_virtual_mb"),  (double)(MemStats.UsedVirtual   / (1024.0 * 1024.0)));
    Out->SetNumberField(TEXT("cpu_peak_physical_mb"), (double)(MemStats.PeakUsedPhysical / (1024.0 * 1024.0)));
    Out->SetNumberField(TEXT("cpu_avail_physical_mb"),(double)(MemStats.AvailablePhysical / (1024.0 * 1024.0)));

    // GPU memory (best-effort; not all RHIs report it).
    // In UE 5.7 DedicatedVideoMemory lives on FTextureMemoryStats, queried via
    // RHIGetTextureMemoryStats. Value is -1 when the RHI can't report it.
    uint64 GpuDedicatedMB = 0;
    if (GDynamicRHI)
    {
        FTextureMemoryStats TexMemStats;
        RHIGetTextureMemoryStats(TexMemStats);
        if (TexMemStats.DedicatedVideoMemory > 0)
        {
            GpuDedicatedMB = (uint64)TexMemStats.DedicatedVideoMemory / (1024 * 1024);
        }
    }
    Out->SetNumberField(TEXT("gpu_dedicated_mb"), (double)GpuDedicatedMB);

    return FHaybaHandlerResult::Ok(Out);
}

static FString PixelFormatName(EPixelFormat Fmt)
{
    return GPixelFormats[Fmt].Name ? FString(GPixelFormats[Fmt].Name) : FString::Printf(TEXT("PF_%d"), (int32)Fmt);
}

static bool IsApprovedCompression(EPixelFormat Fmt)
{
    // BC1 / BC5 / BC7 mapped pixel formats
    return Fmt == PF_DXT1 || Fmt == PF_DXT5
        || Fmt == PF_BC4  || Fmt == PF_BC5
        || Fmt == PF_BC6H || Fmt == PF_BC7;
}

FHaybaHandlerResult FHaybaMCPPerfHandler::TextureAudit(const TSharedPtr<FJsonObject>& P)
{
    int32 TopN = 25;
    P->TryGetNumberField(TEXT("top_n"), TopN);
    TopN = FMath::Clamp(TopN, 1, 500);

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    TArray<FAssetData> Assets;
    AR.GetAssetsByClass(UTexture2D::StaticClass()->GetClassPathName(), Assets, /*bSearchSubClasses*/ true);

    struct FRow
    {
        FString Path;
        FString Format;
        int32 SizeX = 0;
        int32 SizeY = 0;
        int64 MemBytes = 0;
        FString LODGroup;
        FString Compression;
        bool bOutlier = false;
    };
    TArray<FRow> Rows;
    Rows.Reserve(Assets.Num());

    for (const FAssetData& A : Assets)
    {
        UTexture2D* Tex = Cast<UTexture2D>(A.GetAsset());
        if (!Tex) continue;

        FRow R;
        R.Path = A.GetObjectPathString();
        R.SizeX = (int32)Tex->GetSizeX();
        R.SizeY = (int32)Tex->GetSizeY();
        EPixelFormat Fmt = Tex->GetPixelFormat();
        R.Format = PixelFormatName(Fmt);
        R.MemBytes = Tex->GetResourceSizeBytes(EResourceSizeMode::Exclusive);

        const UEnum* LODEnum = StaticEnum<TextureGroup>();
        R.LODGroup = LODEnum ? LODEnum->GetNameStringByValue((int64)Tex->LODGroup) : FString::Printf(TEXT("%d"), (int32)Tex->LODGroup);

        const UEnum* CompEnum = StaticEnum<TextureCompressionSettings>();
        R.Compression = CompEnum ? CompEnum->GetNameStringByValue((int64)Tex->CompressionSettings) : FString::Printf(TEXT("%d"), (int32)Tex->CompressionSettings);

        // Flag: name hints at Albedo/Normal but compression isn't BC1/BC5/BC7-class
        const FString NameU = A.AssetName.ToString().ToLower();
        const bool bAlbedoLike = NameU.Contains(TEXT("albedo")) || NameU.Contains(TEXT("diffuse")) || NameU.Contains(TEXT("basecolor"));
        const bool bNormalLike = NameU.Contains(TEXT("normal")) || NameU.Contains(TEXT("_n_")) || NameU.EndsWith(TEXT("_n"));
        if ((bAlbedoLike || bNormalLike) && !IsApprovedCompression(Fmt))
        {
            R.bOutlier = true;
        }

        Rows.Add(MoveTemp(R));
    }

    Rows.Sort([](const FRow& A, const FRow& B){ return A.MemBytes > B.MemBytes; });
    if (Rows.Num() > TopN) Rows.SetNum(TopN);

    TArray<TSharedPtr<FJsonValue>> Arr;
    int64 TotalBytes = 0;
    for (const FRow& R : Rows)
    {
        TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("path"), R.Path);
        E->SetStringField(TEXT("format"), R.Format);
        E->SetNumberField(TEXT("size_x"), R.SizeX);
        E->SetNumberField(TEXT("size_y"), R.SizeY);
        E->SetNumberField(TEXT("memory_kb"), (double)(R.MemBytes / 1024.0));
        E->SetStringField(TEXT("lod_group"), R.LODGroup);
        E->SetStringField(TEXT("compression"), R.Compression);
        E->SetBoolField(TEXT("outlier"), R.bOutlier);
        Arr.Add(MakeShared<FJsonValueObject>(E.ToSharedRef()));
        TotalBytes += R.MemBytes;
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("textures"), Arr);
    Out->SetNumberField(TEXT("count"), Arr.Num());
    Out->SetNumberField(TEXT("scanned"), Assets.Num());
    Out->SetNumberField(TEXT("top_n_total_kb"), (double)(TotalBytes / 1024.0));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPPerfHandler::MeshAudit(const TSharedPtr<FJsonObject>& P)
{
    int32 TopN = 25;
    P->TryGetNumberField(TEXT("top_n"), TopN);
    TopN = FMath::Clamp(TopN, 1, 500);

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    TArray<FAssetData> Assets;
    AR.GetAssetsByClass(UStaticMesh::StaticClass()->GetClassPathName(), Assets, /*bSearchSubClasses*/ true);

    struct FRow
    {
        FString Path;
        int32 TrisLod0 = 0;
        int32 LodCount = 0;
        bool bMissingLods = false;
        int32 MaterialSlots = 0;
        int32 ReferencerCount = 0;
    };
    TArray<FRow> Rows;
    Rows.Reserve(Assets.Num());

    for (const FAssetData& A : Assets)
    {
        UStaticMesh* Mesh = Cast<UStaticMesh>(A.GetAsset());
        if (!Mesh) continue;

        FRow R;
        R.Path = A.GetObjectPathString();
        R.LodCount = Mesh->GetNumLODs();
        R.bMissingLods = (R.LodCount <= 1);
        R.MaterialSlots = Mesh->GetStaticMaterials().Num();
        if (R.LodCount > 0 && Mesh->GetRenderData())
        {
            const FStaticMeshLODResources& LOD0 = Mesh->GetRenderData()->LODResources[0];
            R.TrisLod0 = LOD0.GetNumTriangles();
        }

        // Best-effort referencer count for instance hotspot flagging
        TArray<FName> Refs;
        AR.GetReferencers(A.PackageName, Refs);
        R.ReferencerCount = Refs.Num();

        Rows.Add(MoveTemp(R));
    }

    Rows.Sort([](const FRow& A, const FRow& B){ return A.TrisLod0 > B.TrisLod0; });
    if (Rows.Num() > TopN) Rows.SetNum(TopN);

    TArray<TSharedPtr<FJsonValue>> Arr;
    for (const FRow& R : Rows)
    {
        TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("path"), R.Path);
        E->SetNumberField(TEXT("tris_lod0"), R.TrisLod0);
        E->SetNumberField(TEXT("lod_count"), R.LodCount);
        E->SetBoolField(TEXT("missing_lods"), R.bMissingLods);
        E->SetNumberField(TEXT("material_slot_count"), R.MaterialSlots);
        E->SetNumberField(TEXT("referencer_count"), R.ReferencerCount);
        E->SetBoolField(TEXT("instance_hotspot"), R.ReferencerCount >= 20);
        Arr.Add(MakeShared<FJsonValueObject>(E.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("meshes"), Arr);
    Out->SetNumberField(TEXT("count"), Arr.Num());
    Out->SetNumberField(TEXT("scanned"), Assets.Num());
    return FHaybaHandlerResult::Ok(Out);
}
