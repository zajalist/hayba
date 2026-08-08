#include "HaybaMCPStaticMeshHandler.h"
#include "HaybaMCPParams.h"

#include "Engine/StaticMesh.h"
#include "StaticMeshResources.h"
#include "Materials/MaterialInterface.h"
#include "UObject/SoftObjectPath.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/ARFilter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
// mesh_extract — read back geometry + topology health from a dynamic/static mesh
#include "DynamicMesh/DynamicMesh3.h"
#include "Selections/MeshConnectedComponents.h"
#include "MeshBoundaryLoops.h"                         // FMeshBoundaryLoops — open-hole loop count
#include "MeshQueries.h"                               // TMeshQueries::GetVolumeArea
#include "DynamicMesh/Operations/MergeCoincidentMeshEdges.h" // weld render verts -> real topology
#include "Components/DynamicMeshComponent.h"   // UDynamicMeshComponent (GeometryFramework)
#include "UDynamicMesh.h"                        // UDynamicMesh::GetMeshRef (GeometryFramework)
#include "IndexTypes.h"                          // FIndex3i
#include "GeometryTypes.h"                       // EValidityCheckFailMode
#if WITH_EDITOR
#include "Editor.h"                              // GEditor
#include "EngineUtils.h"                         // TActorIterator
#include "GameFramework/Actor.h"
#endif

TArray<FString> FHaybaMCPStaticMeshHandler::GetCommands() const
{
    return {
        TEXT("mesh_get_info"),
        TEXT("mesh_set_lod"),
        TEXT("mesh_list"),
        TEXT("mesh_extract"),
        TEXT("mesh_topology_stats"),
        TEXT("mesh_list_dynamic")
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
    FHaybaParamReader ParamR(P, TEXT("mesh_get_info"));
    Path = ParamR.RequiredString(TEXT("path"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

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
    FHaybaParamReader ParamR(P, TEXT("mesh_set_lod"));
    Path = ParamR.RequiredString(TEXT("path"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());
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

    // Guard the engine-killing assert: PostEditChange() below rebuilds the mesh,
    // and the lightmap-UV setup asserts check(NumUVs > 0) (StaticMesh.cpp) if any
    // LOD has zero UV channels — an uncatchable crash. Refuse up front. Use the
    // built render data's UV count (no MeshDescription module dependency); a
    // loaded asset always has render data.
    if (FStaticMeshRenderData* RD = Mesh->GetRenderData())
    {
        for (int32 LOD = 0; LOD < RD->LODResources.Num(); ++LOD)
        {
            if (RD->LODResources[LOD].GetNumTexCoords() == 0)
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("mesh_set_lod: LOD %d has no UV channels; rebuilding this mesh would crash the editor (check(NumUVs>0)). Add UVs to the mesh before changing LOD settings."), LOD));
        }
    }

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

// ---------------------------------------------------------------------------
// mesh_extract / mesh_topology_stats
//
// Reads back the geometry of a mesh already in the editor and returns
// topology-quality stats as JSON. Screenshots can't tell whether two rings are
// welded or merely overlapping — these numbers can: bowtie (non-manifold)
// vertices, degenerate triangles, connected-component count, and open-boundary
// edges diagnose broken welds / bad winding / holes. Stats are computed over
// the WHOLE mesh; raw arrays are opt-in and bounded (region filter +
// max_elements) so payloads stay small.
// ---------------------------------------------------------------------------
namespace
{
    TSharedRef<FJsonObject> Box3dToJson(const UE::Geometry::FAxisAlignedBox3d& Box)
    {
        auto Bounds = MakeShared<FJsonObject>();
        Bounds->SetObjectField(TEXT("min"), Vec3ToJson((FVector)Box.Min));
        Bounds->SetObjectField(TEXT("max"), Vec3ToJson((FVector)Box.Max));
        Bounds->SetObjectField(TEXT("extents"), Vec3ToJson((FVector)(Box.Diagonal() * 0.5)));
        return Bounds;
    }

    // Whole-mesh stats + (optional, bounded) arrays for a FDynamicMesh3.
    void FillDynamicMeshResult(
        const UE::Geometry::FDynamicMesh3& Mesh,
        bool bIncludeTriangles, bool bIncludePositions, bool bIncludeNormals,
        int32 MaxElements, bool bHasBBox,
        const FVector3d& BBoxMin, const FVector3d& BBoxMax,
        const TSharedRef<FJsonObject>& Out)
    {
        using namespace UE::Geometry;

        // ── counts ────────────────────────────────────────────────────────────
        const int32 NumT = Mesh.TriangleCount();
        const int32 NumV = Mesh.VertexCount();
        const int32 NumE = Mesh.EdgeCount();
        auto Counts = MakeShared<FJsonObject>();
        Counts->SetNumberField(TEXT("triangles"), NumT);
        Counts->SetNumberField(TEXT("vertices"), NumV);
        Counts->SetNumberField(TEXT("edges"), NumE);
        Out->SetObjectField(TEXT("counts"), Counts);

        auto Topo = MakeShared<FJsonObject>();

        // Empty-mesh guard: report zeros instead of running loops/measures on nothing.
        if (NumT == 0)
        {
            Topo->SetNumberField(TEXT("boundary_edges"), 0);
            Topo->SetNumberField(TEXT("boundary_loops"), 0);
            Topo->SetNumberField(TEXT("non_manifold_vertices"), 0);
            Topo->SetNumberField(TEXT("degenerate_triangles"), 0);
            Topo->SetNumberField(TEXT("connected_components"), 0);
            Topo->SetBoolField(TEXT("has_open_boundaries"), false);
            Topo->SetBoolField(TEXT("is_closed"), false);
            Topo->SetBoolField(TEXT("is_valid"), true);
            Topo->SetStringField(TEXT("note"), TEXT("empty mesh (0 triangles)"));
            Out->SetObjectField(TEXT("topology"), Topo);
            Out->SetObjectField(TEXT("bounds"), Box3dToJson(Mesh.GetBounds()));
            return;
        }

        // ── topology health (whole mesh, never capped) ─────────────────────────
        int32 BoundaryEdges = 0;
        for (int32 eid : Mesh.EdgeIndicesItr())
            if (Mesh.IsBoundaryEdge(eid)) ++BoundaryEdges;

        // FDynamicMesh3 is edge-manifold by construction: true >2-tri fan-ins
        // surface as BOWTIE vertices, not 3-triangle edges. Bowties are the
        // honest non-manifold signal for a welded mesh.
        int32 NonManifoldVerts = 0;
        for (int32 vid : Mesh.VertexIndicesItr())
            if (Mesh.IsBowtieVertex(vid)) ++NonManifoldVerts;

        int32 Degenerate = 0;
        for (int32 tid : Mesh.TriangleIndicesItr())
        {
            const FIndex3i T = Mesh.GetTriangle(tid);
            if (T.A == T.B || T.B == T.C || T.A == T.C) { ++Degenerate; continue; }
            const FVector3d A = Mesh.GetVertex(T.A);
            const FVector3d B = Mesh.GetVertex(T.B);
            const FVector3d C = Mesh.GetVertex(T.C);
            if ((B - A).Cross(C - A).SquaredLength() < 1e-12) ++Degenerate;
        }

        // Connected components + per-component triangle counts, so an unwelded
        // shell ("4 patches, not 1 solid") is diagnosable at a glance.
        FMeshConnectedComponents Components(&Mesh);
        Components.FindConnectedTriangles();
        const int32 NumComponents = Components.Num();
        TArray<TSharedPtr<FJsonValue>> CompSizes;
        for (int32 ci = 0; ci < NumComponents; ++ci)
            CompSizes.Add(MakeShared<FJsonValueNumber>(Components.GetComponent(ci).Indices.Num()));

        // Open-boundary LOOP count (holes), not just edges: 4 loops = 4 holes.
        FMeshBoundaryLoops Loops(&Mesh, /*bAutoCompute=*/true);
        const int32 NumBoundaryLoops = Loops.GetLoopCount();

        const bool bClosed = (BoundaryEdges == 0);
        const bool bValid = Mesh.CheckValidity(
            FDynamicMesh3::FValidityOptions(), EValidityCheckFailMode::ReturnOnly);

        // Surface area + signed volume (volume only physically meaningful when closed).
        const FVector2d VolArea = TMeshQueries<FDynamicMesh3>::GetVolumeArea(Mesh);

        // Euler characteristic V-E+F; genus for a clean closed orientable single
        // shell: X = 2 - 2g - b  =>  g = (2 - b - X) / 2.
        const int32 Euler = NumV - NumE + NumT;

        Topo->SetNumberField(TEXT("boundary_edges"), BoundaryEdges);
        Topo->SetNumberField(TEXT("boundary_loops"), NumBoundaryLoops);
        Topo->SetNumberField(TEXT("non_manifold_vertices"), NonManifoldVerts);
        Topo->SetNumberField(TEXT("degenerate_triangles"), Degenerate);
        Topo->SetNumberField(TEXT("connected_components"), NumComponents);
        Topo->SetArrayField(TEXT("component_triangle_counts"), CompSizes);
        Topo->SetBoolField(TEXT("has_open_boundaries"), BoundaryEdges > 0);
        Topo->SetBoolField(TEXT("is_closed"), bClosed);
        Topo->SetBoolField(TEXT("is_valid"), bValid);
        Topo->SetNumberField(TEXT("surface_area"), VolArea.Y);
        Topo->SetNumberField(TEXT("volume"), VolArea.X);
        Topo->SetNumberField(TEXT("euler_characteristic"), Euler);
        if (NumComponents == 1 && NonManifoldVerts == 0 && bClosed)
            Topo->SetNumberField(TEXT("genus"), (2 - NumBoundaryLoops - Euler) / 2);
        Out->SetObjectField(TEXT("topology"), Topo);

        Out->SetObjectField(TEXT("bounds"), Box3dToJson(Mesh.GetBounds()));

        // ── optional bounded arrays ────────────────────────────────────────────
        if (!bIncludeTriangles && !bIncludePositions && !bIncludeNormals) return;

        const FBox FilterBox(bHasBBox ? (FVector)BBoxMin : FVector::ZeroVector,
                             bHasBBox ? (FVector)BBoxMax : FVector::ZeroVector);
        bool bTruncated = false;

        if (bIncludeTriangles || bIncludeNormals)
        {
            TArray<TSharedPtr<FJsonValue>> Tris, Normals;
            int32 Emitted = 0;
            for (int32 tid : Mesh.TriangleIndicesItr())
            {
                const FIndex3i T = Mesh.GetTriangle(tid);
                const FVector3d A = Mesh.GetVertex(T.A);
                const FVector3d B = Mesh.GetVertex(T.B);
                const FVector3d C = Mesh.GetVertex(T.C);
                if (bHasBBox)
                {
                    const FVector Centroid = (FVector)((A + B + C) / 3.0);
                    if (!FilterBox.IsInsideOrOn(Centroid)) continue;
                }
                if (Emitted >= MaxElements) { bTruncated = true; break; }
                if (bIncludeTriangles)
                {
                    TArray<TSharedPtr<FJsonValue>> IJK = {
                        MakeShared<FJsonValueNumber>(T.A),
                        MakeShared<FJsonValueNumber>(T.B),
                        MakeShared<FJsonValueNumber>(T.C) };
                    Tris.Add(MakeShared<FJsonValueArray>(IJK));
                }
                if (bIncludeNormals)
                {
                    const FVector3d N = (B - A).Cross(C - A);
                    const FVector3d Nn = N.SquaredLength() > 1e-12 ? N.GetSafeNormal() : FVector3d::ZeroVector;
                    TArray<TSharedPtr<FJsonValue>> NXYZ = {
                        MakeShared<FJsonValueNumber>(Nn.X),
                        MakeShared<FJsonValueNumber>(Nn.Y),
                        MakeShared<FJsonValueNumber>(Nn.Z) };
                    Normals.Add(MakeShared<FJsonValueArray>(NXYZ));
                }
                ++Emitted;
            }
            if (bIncludeTriangles) Out->SetArrayField(TEXT("triangles"), Tris);
            if (bIncludeNormals)   Out->SetArrayField(TEXT("face_normals"), Normals);
        }

        if (bIncludePositions)
        {
            TArray<TSharedPtr<FJsonValue>> Verts;
            int32 Emitted = 0;
            for (int32 vid : Mesh.VertexIndicesItr())
            {
                const FVector3d V = Mesh.GetVertex(vid);
                if (bHasBBox && !FilterBox.IsInsideOrOn((FVector)V)) continue;
                if (Emitted >= MaxElements) { bTruncated = true; break; }
                TArray<TSharedPtr<FJsonValue>> XYZ = {
                    MakeShared<FJsonValueNumber>(V.X),
                    MakeShared<FJsonValueNumber>(V.Y),
                    MakeShared<FJsonValueNumber>(V.Z) };
                Verts.Add(MakeShared<FJsonValueArray>(XYZ));
                ++Emitted;
            }
            Out->SetArrayField(TEXT("vertices"), Verts);
        }

        Out->SetBoolField(TEXT("truncated"), bTruncated);
    }

    bool ReadVec3Param(const TSharedPtr<FJsonObject>& P, const TCHAR* Field, FVector3d& Out)
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (!P->TryGetArrayField(Field, Arr) || !Arr || Arr->Num() < 3) return false;
        Out = FVector3d((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
        return true;
    }
}

static FHaybaHandlerResult MeshExtract(const TSharedPtr<FJsonObject>& P, bool bStatsOnly)
{
    using namespace UE::Geometry;
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("mesh_extract: missing params"));

    // Output shaping (alias mesh_topology_stats forces arrays off).
    bool bIncTris = false, bIncPos = false, bIncNorm = false;
    if (!bStatsOnly)
    {
        P->TryGetBoolField(TEXT("include_triangles"), bIncTris);
        P->TryGetBoolField(TEXT("include_positions"), bIncPos);
        P->TryGetBoolField(TEXT("include_normals"), bIncNorm);
    }
    int32 MaxElements = 2000;
    { int32 M; if (P->TryGetNumberField(TEXT("max_elements"), M) && M > 0) MaxElements = M; }
    FVector3d BBoxMin, BBoxMax;
    const bool bHasBBox = ReadVec3Param(P, TEXT("bbox_min"), BBoxMin) && ReadVec3Param(P, TEXT("bbox_max"), BBoxMax);

    auto Out = MakeShared<FJsonObject>();

    // ── Source A: a UDynamicMeshComponent on an editor actor (primary path) ────
    FString ActorLabel;
    if (P->TryGetStringField(TEXT("actor_label"), ActorLabel) && !ActorLabel.IsEmpty())
    {
#if WITH_EDITOR
        if (!GEditor) return FHaybaHandlerResult::Err(TEXT("mesh_extract: GEditor is null"));
        UWorld* World = GEditor->GetEditorWorldContext().World();
        if (!World) return FHaybaHandlerResult::Err(TEXT("mesh_extract: no editor world"));

        AActor* Found = nullptr;
        for (TActorIterator<AActor> It(World); It; ++It)
            if (*It && (*It)->GetActorLabel() == ActorLabel) { Found = *It; break; }
        if (!Found) return FHaybaHandlerResult::Err(FString::Printf(TEXT("mesh_extract: actor not found by label: %s"), *ActorLabel));

        TArray<UDynamicMeshComponent*> Comps;
        Found->GetComponents(Comps);
        if (Comps.Num() == 0) return FHaybaHandlerResult::Err(FString::Printf(TEXT("mesh_extract: actor '%s' has no UDynamicMeshComponent"), *ActorLabel));

        UDynamicMeshComponent* DMC = nullptr;
        FString CompName;
        if (P->TryGetStringField(TEXT("component_name"), CompName) && !CompName.IsEmpty())
        {
            for (UDynamicMeshComponent* C : Comps) if (C && C->GetName() == CompName) { DMC = C; break; }
            if (!DMC) return FHaybaHandlerResult::Err(FString::Printf(TEXT("mesh_extract: no DynamicMeshComponent named '%s'"), *CompName));
        }
        else
        {
            int32 Idx = 0; P->TryGetNumberField(TEXT("component_index"), Idx);
            if (Idx < 0 || Idx >= Comps.Num()) return FHaybaHandlerResult::Err(FString::Printf(TEXT("mesh_extract: component_index %d out of range (%d components)"), Idx, Comps.Num()));
            DMC = Comps[Idx];
        }

        UDynamicMesh* DynMeshObj = DMC ? DMC->GetDynamicMesh() : nullptr;
        if (!DynMeshObj) return FHaybaHandlerResult::Err(TEXT("mesh_extract: component has no UDynamicMesh"));
        const FDynamicMesh3& Mesh = DynMeshObj->GetMeshRef(); // read-only

        Out->SetStringField(TEXT("source"), TEXT("dynamic_mesh_component"));
        Out->SetStringField(TEXT("actor_label"), ActorLabel);
        if (DMC) Out->SetStringField(TEXT("component"), DMC->GetName());
        FillDynamicMeshResult(Mesh, bIncTris, bIncPos, bIncNorm, MaxElements, bHasBBox, BBoxMin, BBoxMax, Out);
        return FHaybaHandlerResult::Ok(Out);
#else
        return FHaybaHandlerResult::Err(TEXT("mesh_extract: actor_label source is editor-only"));
#endif
    }

    // ── Source B: a UStaticMesh asset (render data — counts + bounds + arrays) ─
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("mesh_extract: provide exactly one source — actor_label or path"));

    UStaticMesh* SMesh = Cast<UStaticMesh>(FSoftObjectPath(Path).TryLoad());
    if (!SMesh) return FHaybaHandlerResult::Err(FString::Printf(TEXT("mesh_extract: failed to load %s"), *Path));
    FStaticMeshRenderData* RD = SMesh->GetRenderData();
    if (!RD || RD->LODResources.Num() == 0) return FHaybaHandlerResult::Err(TEXT("mesh_extract: static mesh has no render data"));

    int32 Lod = 0; P->TryGetNumberField(TEXT("lod"), Lod);
    if (Lod < 0 || Lod >= RD->LODResources.Num()) Lod = 0;
    const FStaticMeshLODResources& LOD = RD->LODResources[Lod];

    Out->SetStringField(TEXT("source"), TEXT("static_mesh"));
    Out->SetStringField(TEXT("path"), Path);
    Out->SetNumberField(TEXT("lod"), Lod);

    // Build a welded FDynamicMesh3 from the render LOD so static meshes get the
    // SAME rigorous topology as the dynamic-mesh path. Render vertices are split
    // at UV/normal seams; FMergeCoincidentMeshEdges re-welds coincident edges to
    // recover the authoring connectivity (real components / boundaries / genus).
    using namespace UE::Geometry;
    FDynamicMesh3 DMesh;
    {
        const FPositionVertexBuffer& PosBuf = LOD.VertexBuffers.PositionVertexBuffer;
        const uint32 NV = PosBuf.GetNumVertices();
        TArray<int32> VMap; VMap.Reserve(NV);
        for (uint32 i = 0; i < NV; ++i)
            VMap.Add(DMesh.AppendVertex((FVector3d)(FVector)PosBuf.VertexPosition(i)));
        TArray<uint32> Indices;
        LOD.IndexBuffer.GetCopy(Indices);
        for (int32 i = 0; i + 2 < Indices.Num(); i += 3)
        {
            const int32 A = VMap.IsValidIndex(Indices[i])     ? VMap[Indices[i]]     : INDEX_NONE;
            const int32 B = VMap.IsValidIndex(Indices[i + 1]) ? VMap[Indices[i + 1]] : INDEX_NONE;
            const int32 C = VMap.IsValidIndex(Indices[i + 2]) ? VMap[Indices[i + 2]] : INDEX_NONE;
            if (A != INDEX_NONE && B != INDEX_NONE && C != INDEX_NONE)
                DMesh.AppendTriangle(FIndex3i(A, B, C));
        }
    }
    FMergeCoincidentMeshEdges Merger(&DMesh);
    Merger.Apply();

    // Report the pre-weld render vertex count too, so the UV/normal-split count
    // is still visible alongside the true (welded) vertex count in counts{}.
    Out->SetNumberField(TEXT("render_vertices"), LOD.GetNumVertices());
    FillDynamicMeshResult(DMesh, bIncTris, bIncPos, bIncNorm, MaxElements, bHasBBox, BBoxMin, BBoxMax, Out);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// mesh_list_dynamic — enumerate every UDynamicMeshComponent in the editor level
// with tri/vert/material counts. Replaces the hand-rolled "loop all level actors
// -> get_components_by_class(DynamicMeshComponent) -> print tris" python_run that
// agents run constantly to inspect PCG / grammar output.
// ---------------------------------------------------------------------------
static FHaybaHandlerResult MeshListDynamic(const TSharedPtr<FJsonObject>& P)
{
#if WITH_EDITOR
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("mesh_list_dynamic: GEditor is null"));
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World) return FHaybaHandlerResult::Err(TEXT("mesh_list_dynamic: no editor world"));

    FString LabelContains;
    if (P.IsValid()) P->TryGetStringField(TEXT("label_contains"), LabelContains);

    TArray<TSharedPtr<FJsonValue>> Items;
    int32 TotalTris = 0;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* A = *It;
        if (!A) continue;
        if (!LabelContains.IsEmpty() && !A->GetActorLabel().Contains(LabelContains)) continue;
        TArray<UDynamicMeshComponent*> Comps;
        A->GetComponents(Comps);
        for (UDynamicMeshComponent* C : Comps)
        {
            if (!C) continue;
            UDynamicMesh* DM = C->GetDynamicMesh();
            const int32 Tris  = DM ? DM->GetMeshRef().TriangleCount() : 0;
            const int32 Verts = DM ? DM->GetMeshRef().VertexCount()   : 0;
            TotalTris += Tris;
            TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
            E->SetStringField(TEXT("actor_label"), A->GetActorLabel());
            E->SetStringField(TEXT("component"), C->GetName());
            E->SetNumberField(TEXT("triangles"), Tris);
            E->SetNumberField(TEXT("vertices"), Verts);
            E->SetNumberField(TEXT("num_materials"), C->GetNumMaterials());
            E->SetBoolField(TEXT("empty"), Tris == 0);
            Items.Add(MakeShared<FJsonValueObject>(E.ToSharedRef()));
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("dynamic_meshes"), Items);
    Out->SetNumberField(TEXT("count"), Items.Num());
    Out->SetNumberField(TEXT("total_triangles"), TotalTris);
    return FHaybaHandlerResult::Ok(Out);
#else
    return FHaybaHandlerResult::Err(TEXT("mesh_list_dynamic: editor-only"));
#endif
}

FHaybaHandlerResult FHaybaMCPStaticMeshHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("mesh_get_info")) return MeshGetInfo(Params);
    if (Cmd == TEXT("mesh_set_lod"))  return MeshSetLOD(Params);
    if (Cmd == TEXT("mesh_list"))     return MeshList(Params);
    if (Cmd == TEXT("mesh_extract"))         return MeshExtract(Params, /*bStatsOnly=*/false);
    if (Cmd == TEXT("mesh_topology_stats"))  return MeshExtract(Params, /*bStatsOnly=*/true);
    if (Cmd == TEXT("mesh_list_dynamic"))    return MeshListDynamic(Params);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("StaticMeshHandler: unknown command %s"), *Cmd));
}
