#include "HaybaMCPWorldGeometry.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/Level.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "HAL/PlatformTime.h"
#include "LandscapeComponent.h"
#include "StaticMeshResources.h"

namespace HaybaWorldGeometry
{
namespace
{
constexpr int32 MaxActors = 400;
constexpr int32 MaxMetadataActors = 64;
constexpr int32 MaxVisitedActors = 8192;
constexpr int32 MaxEligibilityComponentsPerActor = 64;
constexpr int32 MaxEligibilityComponents = 32768;
constexpr int32 MaxComponents = 800;
constexpr int32 MaxInstances = 1024;
constexpr int32 MaxSources = 1024;
constexpr int32 MaxInstancesPerComponent = 16;
constexpr int32 MaxSplats = 4096;
constexpr int32 MaxTrianglesVisited = 32768;
constexpr int32 MaxTrianglesPerSource = 512;
constexpr int32 MaxTileTrianglesPerSource = 4096;
constexpr int32 MaxTileFragmentsPerSource = 8192;
constexpr int32 MaxTileInstanceVisitsPerComponent = 4096;
constexpr int32 MaxTagsPerNode = 32;
constexpr int32 MaxTagsPerCluster = 16;
constexpr double MaxActorVisitSeconds = 0.050;
constexpr double MaxActorProcessSeconds = 0.085;
constexpr double MaxSourceCollectSeconds = 0.095;
constexpr double MaxSurfaceSampleSeconds = 0.110;
constexpr double MaxTotalSeconds = 0.120;
constexpr int64 MaxObservedInstances = 1000000000;

struct FSelectedActor
{
    TWeakObjectPtr<AActor> Actor;
    FString Path;
    uint32 Priority = 0;
};

struct FSource
{
    UStaticMeshComponent* Component = nullptr;
    const FStaticMeshLODResources* LOD = nullptr;
    FTransform Transform;
    int32 ActorIndex = INDEX_NONE;
    int32 NodeIndex = INDEX_NONE;
};

struct FCandidate
{
    UStaticMeshComponent* Component = nullptr;
    const FStaticMeshLODResources* LOD = nullptr;
    int32 ActorIndex = INDEX_NONE;
    int32 InstanceCount = 1;
    int32 ComponentNodeIndex = INDEX_NONE;
    TArray<int32> TileInstances;
};

struct FSurfaceTriangle
{
    FVector A, B, C, Normal;
    double CumulativeArea = 0.0;
};

/** Clip a real transformed mesh triangle to a world-space tile. This avoids
 * both invented points and rejection-sampling holes on large boundary faces. */
void AddClippedTriangle(const FVector& A, const FVector& B, const FVector& C,
    const FVector& Normal, const FBox& Region, TArray<FSurfaceTriangle>& Surface,
    double& TotalArea)
{
    TArray<FVector, TInlineAllocator<12>> Polygon;
    TArray<FVector, TInlineAllocator<12>> Next;
    Polygon.Add(A);
    Polygon.Add(B);
    Polygon.Add(C);
    for (int32 Axis = 0; Axis < 3; ++Axis)
    {
        for (int32 Side = 0; Side < 2; ++Side)
        {
            const double Plane = Side == 0 ? Region.Min[Axis] : Region.Max[Axis];
            const double Direction = Side == 0 ? 1.0 : -1.0;
            Next.Reset();
            if (Polygon.IsEmpty()) return;
            FVector Previous = Polygon.Last();
            double PreviousDistance = Direction * (Previous[Axis] - Plane);
            for (const FVector& Current : Polygon)
            {
                const double CurrentDistance = Direction * (Current[Axis] - Plane);
                if ((CurrentDistance >= 0.0) != (PreviousDistance >= 0.0))
                {
                    const double Denominator = PreviousDistance - CurrentDistance;
                    const double T = FMath::IsNearlyZero(Denominator) ? 0.0 :
                        FMath::Clamp(PreviousDistance / Denominator, 0.0, 1.0);
                    Next.Add(FMath::Lerp(Previous, Current, T));
                }
                if (CurrentDistance >= 0.0) Next.Add(Current);
                Previous = Current;
                PreviousDistance = CurrentDistance;
            }
            Polygon = MoveTemp(Next);
        }
    }
    for (int32 Index = 1; Index + 1 < Polygon.Num(); ++Index)
    {
        const FVector& P0 = Polygon[0];
        const FVector& P1 = Polygon[Index];
        const FVector& P2 = Polygon[Index + 1];
        const double Area = FVector::CrossProduct(P1 - P0, P2 - P0).Size() * 0.5;
        if (!FMath::IsFinite(Area) || Area <= UE_DOUBLE_SMALL_NUMBER) continue;
        TotalArea += Area;
        Surface.Add({P0, P1, P2, Normal, TotalArea});
    }
}

double RadicalInverse(uint32 Number, uint32 Base)
{
    double Result = 0.0, Scale = 1.0 / Base;
    while (Number)
    {
        Result += (Number % Base) * Scale;
        Number /= Base;
        Scale /= Base;
    }
    return Result;
}

void Count(FSnapshot& Result, const TCHAR* Kind)
{
    Result.UnsupportedByKind.FindOrAdd(Kind)++;
}

bool TimedOut(double Start, double Limit)
{
    return FPlatformTime::Seconds() - Start >= Limit;
}

void MarkPartial(FSnapshot& Result, const TCHAR* Reason)
{
    Result.bTruncated = true;
    if (Result.StopReason.IsEmpty()) Result.StopReason = Reason;
    Result.StopReasons.AddUnique(Reason);
}

bool ComesBefore(const FSelectedActor& A, const FSelectedActor& B)
{
    return A.Priority < B.Priority || (A.Priority == B.Priority && A.Path < B.Path);
}

void RetainByPriority(TArray<FSelectedActor>& Pool, int32 Capacity, FSelectedActor&& Candidate)
{
    if (Pool.Num() < Capacity) { Pool.Add(MoveTemp(Candidate)); return; }
    int32 Worst = 0;
    for (int32 Index = 1; Index < Pool.Num(); ++Index)
        if (ComesBefore(Pool[Worst], Pool[Index])) Worst = Index;
    if (ComesBefore(Candidate, Pool[Worst])) Pool[Worst] = MoveTemp(Candidate);
}

void CopyTags(const TArray<FName>& Tags, TArray<FString>& Out, bool& bTruncated)
{
    Out.Reserve(FMath::Min(Tags.Num(), MaxTagsPerNode));
    for (const FName Tag : Tags)
    {
        if (Out.Num() >= MaxTagsPerNode) { bTruncated = true; break; }
        Out.Add(Tag.ToString());
    }
    Out.Sort();
}

void AddToAncestry(FSnapshot& Result, int32 NodeIndex, const FVector* Point)
{
    for (int32 At = NodeIndex; Result.Nodes.IsValidIndex(At); At = Result.Nodes[At].ParentIndex)
    {
        FNode& Node = Result.Nodes[At];
        if (Point)
        {
            ++Node.SplatCount;
            Node.BoundsCm += *Point;
            if (Node.Kind == TEXT("component") || Node.Kind == TEXT("instance"))
                Node.GeometryStatus = TEXT("surface_sampled");
        }
        else
        {
            ++Node.SourceCount;
            if (Node.Kind == TEXT("component") || Node.Kind == TEXT("instance"))
                Node.GeometryStatus = TEXT("source_collected");
        }
    }
}

struct FSourceTags
{
    TArray<FString> Tags;
    bool bTruncated = false;
};

void BuildSpatialClusters(FSnapshot& Result, double Start, double Deadline)
{
    if (Result.Splats.IsEmpty() || !Result.BoundsCm.IsValid) return;
    if (TimedOut(Start, Deadline))
    {
        Result.bClusterPartial = true;
        MarkPartial(Result, TEXT("cluster_time_budget"));
        return;
    }
    FCluster& Root = Result.Clusters.AddDefaulted_GetRef();
    Root.Id = TEXT("spatial:root");
    TArray<TSet<int32>> ActorMembers, NodeMembers;
    ActorMembers.AddDefaulted(); NodeMembers.AddDefaulted();
    const FVector Size = Result.BoundsCm.GetSize();
    int32 CoarseByCell[8];
    int32 FineByCell[64];
    TMap<int32, FSourceTags> TagsBySourceNode;
    for (int32& Cell : CoarseByCell) Cell = INDEX_NONE;
    for (int32& Cell : FineByCell) Cell = INDEX_NONE;
    for (int32 SplatIndex = 0; SplatIndex < Result.Splats.Num(); ++SplatIndex)
    {
        if ((SplatIndex & 63) == 0 && TimedOut(Start, Deadline))
        {
            Result.bClusterPartial = true;
            MarkPartial(Result, TEXT("cluster_time_budget"));
            break;
        }
        FSplat& Splat = Result.Splats[SplatIndex];
        const FVector Point = Splat.PositionCm + Result.OriginCm;
        auto Axis = [](double Position, double Min, double Extent)
        {
            return Extent > UE_DOUBLE_SMALL_NUMBER
                ? FMath::Clamp(FMath::FloorToInt(4.0 * (Position - Min) / Extent), 0, 3)
                : 0;
        };
        const int32 X = Axis(Point.X, Result.BoundsCm.Min.X, Size.X);
        const int32 Y = Axis(Point.Y, Result.BoundsCm.Min.Y, Size.Y);
        const int32 Z = Axis(Point.Z, Result.BoundsCm.Min.Z, Size.Z);
        const int32 CoarseCell = (X / 2) + 2 * (Y / 2) + 4 * (Z / 2);
        const int32 FineCell = X + 4 * Y + 16 * Z;
        if (CoarseByCell[CoarseCell] == INDEX_NONE)
        {
            const int32 Index = Result.Clusters.AddDefaulted();
            ActorMembers.AddDefaulted(); NodeMembers.AddDefaulted();
            CoarseByCell[CoarseCell] = Index;
            FCluster& Cluster = Result.Clusters[Index];
            Cluster.Id = FString::Printf(TEXT("spatial:coarse:%d"), CoarseCell);
            Cluster.ParentIndex = 0;
            Cluster.Level = 1;
        }
        if (FineByCell[FineCell] == INDEX_NONE)
        {
            const int32 Index = Result.Clusters.AddDefaulted();
            ActorMembers.AddDefaulted(); NodeMembers.AddDefaulted();
            FineByCell[FineCell] = Index;
            FCluster& Cluster = Result.Clusters[Index];
            Cluster.Id = FString::Printf(TEXT("spatial:fine:%d"), FineCell);
            Cluster.ParentIndex = CoarseByCell[CoarseCell];
            Cluster.Level = 2;
        }
        Splat.ClusterIndex = FineByCell[FineCell];
        FSourceTags* CachedTags = TagsBySourceNode.Find(Splat.NodeIndex);
        if (!CachedTags)
        {
            FSourceTags Built;
            for (int32 NodeAt = Splat.NodeIndex; Result.Nodes.IsValidIndex(NodeAt); NodeAt = Result.Nodes[NodeAt].ParentIndex)
            {
                const FNode& Node = Result.Nodes[NodeAt];
                Built.bTruncated |= Node.bTagsTruncated;
                for (const FString& Tag : Node.Tags) Built.Tags.AddUnique(Tag);
            }
            CachedTags = &TagsBySourceNode.Add(Splat.NodeIndex, MoveTemp(Built));
        }
        for (int32 At = Splat.ClusterIndex; Result.Clusters.IsValidIndex(At); At = Result.Clusters[At].ParentIndex)
        {
            FCluster& Cluster = Result.Clusters[At];
            Cluster.CentroidCm += Point;
            Cluster.BoundsCm += Point;
            ++Cluster.SplatCount;
            if (Splat.ActorIndex != INDEX_NONE && !ActorMembers[At].Contains(Splat.ActorIndex))
            {
                ActorMembers[At].Add(Splat.ActorIndex);
                Cluster.ActorIndices.Add(Splat.ActorIndex);
            }
            if (Splat.NodeIndex != INDEX_NONE && !NodeMembers[At].Contains(Splat.NodeIndex))
            {
                NodeMembers[At].Add(Splat.NodeIndex);
                Cluster.NodeIndices.Add(Splat.NodeIndex);
            }
            Cluster.bTagsTruncated |= CachedTags->bTruncated;
            for (const FString& Tag : CachedTags->Tags)
            {
                if (Cluster.Tags.Contains(Tag)) continue;
                if (Cluster.Tags.Num() >= MaxTagsPerCluster) { Cluster.bTagsTruncated = true; continue; }
                Cluster.Tags.Add(Tag);
            }
        }
        ++Result.ClusteredSplatCount;
    }
    for (FCluster& Cluster : Result.Clusters)
    {
        Cluster.Tags.Sort();
        if (Cluster.SplatCount > 0)
        {
            Cluster.CentroidCm /= Cluster.SplatCount;
            const FVector ToMin = (Cluster.BoundsCm.Min - Cluster.CentroidCm).GetAbs();
            const FVector ToMax = (Cluster.BoundsCm.Max - Cluster.CentroidCm).GetAbs();
            Cluster.RadiusCm = FVector(FMath::Max(ToMin.X, ToMax.X),
                FMath::Max(ToMin.Y, ToMax.Y), FMath::Max(ToMin.Z, ToMax.Z)).Size();
        }
    }
}
}

static FSnapshot BuildInternal(UWorld* World,
    const TArray<TWeakObjectPtr<AActor>>* BatchActors, int32 PointLimit,
    double TimeLimitSeconds, const FBox* RegionCm = nullptr)
{
    FSnapshot Result;
    if (!World) return Result;
    const double Start = FPlatformTime::Seconds();
    PointLimit = FMath::Clamp(PointLimit, 1, MaxSplats);
    const int32 SourceLimit = BatchActors ? FMath::Min(MaxSources, PointLimit) : MaxSources;
    const int32 InstanceLimit = BatchActors ? FMath::Min(MaxInstances, PointLimit) : MaxInstances;
    const int32 InstancesPerComponentLimit = BatchActors ? 256 : MaxInstancesPerComponent;
    const double Scale = FMath::Clamp(TimeLimitSeconds / MaxTotalSeconds, 0.05, 1.0);
    const double VisitDeadline = MaxActorVisitSeconds * Scale;
    const double ProcessDeadline = MaxActorProcessSeconds * Scale;
    const double CollectDeadline = MaxSourceCollectSeconds * Scale;
    const double SurfaceDeadline = MaxSurfaceSampleSeconds * Scale;
    const double TotalDeadline = MaxTotalSeconds * Scale;
    Result.OriginCm = FVector(World->OriginLocation);
    if (BatchActors) Result.ActorSelectionProvenance = TEXT("loaded_level_cursor");
    FNode& WorldNode = Result.Nodes.AddDefaulted_GetRef();
    WorldNode.Id = World->GetPathName();
    WorldNode.Kind = TEXT("world");
    WorldNode.Label = World->GetName();
    WorldNode.Path = WorldNode.Id;
    TMap<FString, int32> LevelNodes;
    TMap<FString, int32> FolderNodes;
    TArray<FSource> Sources;
    TArray<FCandidate> Candidates;

    // Visit a bounded cross-section of loaded actors before building source
    // metadata. Non-mesh actors do not consume the geometry actor budget.
    // Lowest stable path hashes form a deterministic reservoir independent of
    // the iterator's ordering. This never loads World Partition cells.
    TArray<FSelectedActor> MeshActors;
    TArray<FSelectedActor> MetadataActors;
    bool bVisitStopped = false;
    if (BatchActors)
    {
        // These actors came from the panel's loaded-level cursor. Keep order and
        // identities stable within the slice; do not apply the global 400-actor
        // reservoir to a page of eight actors.
        for (const TWeakObjectPtr<AActor>& WeakActor : *BatchActors)
        {
            if (TimedOut(Start, VisitDeadline)) { MarkPartial(Result, TEXT("actor_visit_time_budget")); break; }
            ++Result.VisitedActorCount;
            AActor* Actor = WeakActor.Get();
            if (!IsValid(Actor) || Actor->GetWorld() != World || Actor->IsEditorOnly()) continue;
            FSelectedActor Selected{Actor, Actor->GetPathName(), GetTypeHash(Actor->GetPathName())};
            MeshActors.Add(MoveTemp(Selected));
        }
        bVisitStopped = Result.VisitedActorCount < BatchActors->Num();
    }
    else for (TActorIterator<AActor> It(World); It; ++It)
    {
        if (Result.VisitedActorCount >= MaxVisitedActors)
        {
            MarkPartial(Result, TEXT("actor_visit_cap"));
            bVisitStopped = true;
            break;
        }
        if (TimedOut(Start, VisitDeadline))
        {
            MarkPartial(Result, TEXT("actor_visit_time_budget"));
            bVisitStopped = true;
            break;
        }
        ++Result.VisitedActorCount;
        AActor* Actor = *It;
        if (!IsValid(Actor) || Actor->IsEditorOnly()) continue;
        bool bHasMesh = false;
        bool bMetadataOnly = false;
        int32 InspectedForActor = 0;
        for (UActorComponent* RawComponent : Actor->GetComponents())
        {
            if (InspectedForActor >= MaxEligibilityComponentsPerActor ||
                Result.EligibilityComponentCount >= MaxEligibilityComponents)
            {
                MarkPartial(Result, TEXT("eligibility_component_cap"));
                break;
            }
            ++InspectedForActor;
            ++Result.EligibilityComponentCount;
            if (!IsValid(RawComponent) || !RawComponent->IsRegistered()) continue;
            if (const UStaticMeshComponent* Static = Cast<UStaticMeshComponent>(RawComponent))
            {
                if (IsValid(Static->GetStaticMesh())) { bHasMesh = true; break; }
                bMetadataOnly = true;
            }
            else if (RawComponent->IsA<ULandscapeComponent>() || RawComponent->IsA<USkeletalMeshComponent>())
                bMetadataOnly = true;
        }
        if (!bHasMesh && !bMetadataOnly) continue;
        FSelectedActor Selected{Actor, Actor->GetPathName(), 0};
        Selected.Priority = GetTypeHash(Selected.Path);
        if (bHasMesh)
        {
            ++Result.EligibleMeshActorCount;
            RetainByPriority(MeshActors, MaxActors, MoveTemp(Selected));
        }
        else
        {
            ++Result.EligibleMetadataActorCount;
            RetainByPriority(MetadataActors, MaxMetadataActors, MoveTemp(Selected));
        }
        if (Result.EligibilityComponentCount >= MaxEligibilityComponents)
        {
            MarkPartial(Result, TEXT("eligibility_component_cap"));
            bVisitStopped = true;
            break;
        }
    }
    Result.bActorIteratorComplete = !bVisitStopped;
    if (!BatchActors)
    {
        MeshActors.Sort([](const FSelectedActor& A, const FSelectedActor& B) { return ComesBefore(A, B); });
        MetadataActors.Sort([](const FSelectedActor& A, const FSelectedActor& B) { return ComesBefore(A, B); });
    }
    TArray<FSelectedActor> SelectedActors;
    SelectedActors.Reserve(MaxActors);
    SelectedActors.Append(MoveTemp(MeshActors));
    for (FSelectedActor& Selected : MetadataActors)
    {
        if (SelectedActors.Num() >= MaxActors) break;
        SelectedActors.Add(MoveTemp(Selected));
    }
    Result.SelectedActorCount = SelectedActors.Num();
    if (Result.EligibleMeshActorCount + Result.EligibleMetadataActorCount > Result.SelectedActorCount)
        MarkPartial(Result, TEXT("actor_selection_cap"));

    for (const FSelectedActor& Selected : SelectedActors)
    {
        if (TimedOut(Start, ProcessDeadline))
        {
            MarkPartial(Result, TEXT("actor_process_time_budget"));
            break;
        }
        AActor* Actor = Selected.Actor.Get();
        if (!IsValid(Actor) || Actor->GetWorld() != World) { MarkPartial(Result, TEXT("selected_actor_unavailable")); continue; }
        if (RegionCm && !Actor->GetComponentsBoundingBox(true).Intersect(*RegionCm)) continue;
        ++Result.ActorCount;
        const int32 ActorIndex = Result.Actors.Add({Actor->GetActorLabel(), Actor->GetFolderPath().ToString(), Actor->GetPathName(), Actor});
        const ULevel* Level = Actor->GetLevel();
        const FString LevelPath = Level ? Level->GetPathName() : TEXT("unknown_level");
        int32* ExistingLevel = LevelNodes.Find(LevelPath);
        int32 LevelIndex = INDEX_NONE;
        if (ExistingLevel) LevelIndex = *ExistingLevel;
        else
        {
            LevelIndex = Result.Nodes.AddDefaulted();
            LevelNodes.Add(LevelPath, LevelIndex);
            FNode& Node = Result.Nodes[LevelIndex];
            Node.Id = LevelPath;
            Node.ParentIndex = 0;
            Node.Kind = TEXT("level");
            Node.Label = Level ? Level->GetName() : TEXT("Unknown level");
            Node.Path = LevelPath;
            Node.Level = LevelPath;
        }
        int32 ParentIndex = LevelIndex;
        const FString Folder = Actor->GetFolderPath().ToString();
        TArray<FString> Segments;
        Folder.ParseIntoArray(Segments, TEXT("/"), true);
        FString CumulativeFolder;
        for (const FString& Segment : Segments)
        {
            CumulativeFolder = CumulativeFolder.IsEmpty() ? Segment : CumulativeFolder + TEXT("/") + Segment;
            const FString FolderId = LevelPath + TEXT("|folder:") + CumulativeFolder;
            if (int32* ExistingFolder = FolderNodes.Find(FolderId)) ParentIndex = *ExistingFolder;
            else
            {
                const int32 FolderIndex = Result.Nodes.AddDefaulted();
                FolderNodes.Add(FolderId, FolderIndex);
                FNode& Node = Result.Nodes[FolderIndex];
                Node.Id = FolderId;
                Node.ParentIndex = ParentIndex;
                Node.Kind = TEXT("folder");
                Node.Label = Segment;
                Node.Path = CumulativeFolder;
                Node.Level = LevelPath;
                Node.Folder = CumulativeFolder;
                ParentIndex = FolderIndex;
            }
        }
        const int32 ActorNodeIndex = Result.Nodes.AddDefaulted();
        {
            FNode& Node = Result.Nodes[ActorNodeIndex];
            Node.Id = Actor->GetPathName();
            Node.ParentIndex = ParentIndex;
            Node.Kind = TEXT("actor");
            Node.Label = Actor->GetActorLabel();
            Node.Path = Node.Id;
            Node.Level = LevelPath;
            Node.Folder = Folder;
            Node.ActorClass = Actor->GetClass()->GetPathName();
            Node.ActorIndex = ActorIndex;
            CopyTags(Actor->Tags, Node.Tags, Node.bTagsTruncated);
        }
        bool bEligibleMeshInActor = false;
        bool bEligibleMetadataInActor = false;
        // Iterate the actor-owned set directly; copying it first would bypass
        // the component and time limits for actors with enormous component sets.
        for (UActorComponent* RawComponent : Actor->GetComponents())
        {
            if (Result.ComponentCount >= MaxComponents || TimedOut(Start, ProcessDeadline))
            {
                MarkPartial(Result, Result.ComponentCount >= MaxComponents
                    ? TEXT("component_cap") : TEXT("actor_process_time_budget"));
                break;
            }
            if (!IsValid(RawComponent) || !RawComponent->IsRegistered()) continue;
            if (RegionCm)
            {
                const UPrimitiveComponent* Primitive = Cast<UPrimitiveComponent>(RawComponent);
                if (Primitive && !Primitive->Bounds.GetBox().Intersect(*RegionCm)) continue;
            }
            const bool bLandscape = RawComponent->IsA<ULandscapeComponent>();
            const bool bSkeletal = RawComponent->IsA<USkeletalMeshComponent>();
            UStaticMeshComponent* Component = Cast<UStaticMeshComponent>(RawComponent);
            if (!Component && !bLandscape && !bSkeletal) continue;
            ++Result.ComponentCount;
            UStaticMesh* Mesh = Component ? Component->GetStaticMesh() : nullptr;
            bEligibleMeshInActor |= IsValid(Mesh);
            bEligibleMetadataInActor |= (Component && !IsValid(Mesh)) || bLandscape || bSkeletal;
            const UInstancedStaticMeshComponent* Instanced = Cast<UInstancedStaticMeshComponent>(Component);
            const int32 Instances = Instanced ? Instanced->GetInstanceCount() : (Component ? 1 : 0);
            if (Component)
            {
                if (Result.ObservedInstanceCount > MaxObservedInstances - Instances)
                {
                    Result.ObservedInstanceCount = MaxObservedInstances;
                    Result.bObservedInstanceCountSaturated = true;
                }
                else Result.ObservedInstanceCount += Instances;
            }
            const int32 ComponentNodeIndex = Result.Nodes.AddDefaulted();
            {
                FNode& Node = Result.Nodes[ComponentNodeIndex];
                Node.Id = RawComponent->GetPathName();
                Node.ParentIndex = ActorNodeIndex;
                Node.Kind = TEXT("component");
                Node.Label = RawComponent->GetName();
                Node.Path = Node.Id;
                Node.Level = LevelPath;
                Node.Folder = Folder;
                Node.ActorClass = Actor->GetClass()->GetPathName();
                Node.MeshAsset = IsValid(Mesh) ? Mesh->GetPathName() : FString();
                Node.ActorIndex = ActorIndex;
                Node.ObservedInstanceCount = Instances;
                CopyTags(RawComponent->ComponentTags, Node.Tags, Node.bTagsTruncated);
            }
            if (bLandscape)
            {
                Result.Nodes[ComponentNodeIndex].GeometryStatus = TEXT("unsupported_landscape");
                Count(Result, TEXT("landscape"));
                continue;
            }
            if (bSkeletal)
            {
                Result.Nodes[ComponentNodeIndex].GeometryStatus = TEXT("unsupported_skeletal_mesh");
                Count(Result, TEXT("skeletal_mesh"));
                continue;
            }
            if (IsValid(Mesh)) Result.bNaniteProxy |= Mesh->IsNaniteEnabled();
            if (!IsValid(Mesh) || !Mesh->HasValidRenderData())
            {
                Result.Nodes[ComponentNodeIndex].GeometryStatus = TEXT("missing_render_lod");
                Count(Result, TEXT("missing_render_lod"));
                continue;
            }
            const FStaticMeshRenderData* RenderData = Mesh->GetRenderData();
            if (!RenderData || RenderData->LODResources.IsEmpty())
            {
                Result.Nodes[ComponentNodeIndex].GeometryStatus = TEXT("missing_render_lod");
                Count(Result, TEXT("missing_render_lod"));
                continue;
            }
            const FStaticMeshLODResources& LOD = RenderData->LODResources[0];
            const FPositionVertexBuffer& Positions = LOD.VertexBuffers.PositionVertexBuffer;
            const FRawStaticIndexBuffer& Indices = LOD.IndexBuffer;
            // Cached index counts can remain nonzero after GPU upload discarded
            // the CPU array. Check actual allocation before any GetIndex call.
            if (!Positions.GetAllowCPUAccess() || !Positions.GetVertexData() ||
                Positions.GetNumVertices() < 3 || !Indices.GetAllowCPUAccess() ||
                Indices.GetAllocatedSize() == 0 || Indices.GetIndexDataSize() == 0 ||
                Indices.GetNumIndices() < 3)
            {
                Result.Nodes[ComponentNodeIndex].GeometryStatus = TEXT("cpu_lod_unavailable");
                Count(Result, TEXT("cpu_lod_unavailable"));
                continue;
            }
            if (Instances > 0)
            {
                Result.Nodes[ComponentNodeIndex].GeometryStatus = TEXT("eligible_no_source");
                FCandidate Candidate{Component, &LOD, ActorIndex, Instances, ComponentNodeIndex};
                if (RegionCm && Instanced)
                {
                    const int32 VisitCount = FMath::Min(Instances, MaxTileInstanceVisitsPerComponent);
                    if (VisitCount < Instances) MarkPartial(Result, TEXT("tile_instance_visit_cap"));
                    const FBox MeshBounds = Mesh->GetBoundingBox();
                    for (int32 Visit = 0; Visit < VisitCount; ++Visit)
                    {
                        if ((Visit & 127) == 0 && TimedOut(Start, ProcessDeadline))
                        { MarkPartial(Result, TEXT("tile_instance_time_budget")); break; }
                        const int32 InstanceIndex = VisitCount == Instances ? Visit :
                            static_cast<int32>((static_cast<int64>(2 * Visit + 1) * Instances) / (2 * VisitCount));
                        FTransform InstanceTransform;
                        if (!Instanced->GetInstanceTransform(InstanceIndex, InstanceTransform, true)) continue;
                        if (MeshBounds.TransformBy(InstanceTransform).Intersect(*RegionCm))
                            Candidate.TileInstances.Add(InstanceIndex);
                        if (Candidate.TileInstances.Num() >= 256)
                        { MarkPartial(Result, TEXT("tile_instance_source_cap")); break; }
                    }
                    Candidate.InstanceCount = Candidate.TileInstances.Num();
                }
                if (Candidate.InstanceCount > 0) Candidates.Add(MoveTemp(Candidate));
                else Result.Nodes[ComponentNodeIndex].GeometryStatus = TEXT("outside_tile_or_unvisited");
            }
            else Result.Nodes[ComponentNodeIndex].GeometryStatus = TEXT("empty_instance_set");
        }
        if (BatchActors)
        {
            if (bEligibleMeshInActor) ++Result.EligibleMeshActorCount;
            else if (bEligibleMetadataInActor) ++Result.EligibleMetadataActorCount;
        }
        if (Result.ComponentCount >= MaxComponents || TimedOut(Start, ProcessDeadline)) break;
    }

    // Give every accepted component one opportunity before taking a second
    // instance from any component. Large foliage clusters cannot monopolize
    // all sources simply because their actor was visited first.
    for (int32 Pass = 0; Pass < InstancesPerComponentLimit; ++Pass)
    {
        for (const FCandidate& Candidate : Candidates)
        {
            if (TimedOut(Start, CollectDeadline) || Sources.Num() >= SourceLimit || Result.InstanceCount >= InstanceLimit)
            {
                MarkPartial(Result, TimedOut(Start, CollectDeadline) ? TEXT("source_time_budget") :
                    (Sources.Num() >= SourceLimit ? TEXT("source_cap") : TEXT("sampled_instance_cap")));
                break;
            }
            const int32 Allowed = FMath::Min(Candidate.InstanceCount, InstancesPerComponentLimit);
            if (Pass >= Allowed) continue;
            if (Candidate.InstanceCount > Allowed) MarkPartial(Result, TEXT("instance_per_component_cap"));
            FTransform Transform = Candidate.Component->GetComponentTransform();
            if (UInstancedStaticMeshComponent* Instanced = Cast<UInstancedStaticMeshComponent>(Candidate.Component))
            {
                const int32 CandidateIndex = static_cast<int32>(FMath::Min<int64>(Candidate.InstanceCount - 1,
                    (static_cast<int64>(2 * Pass + 1) * Candidate.InstanceCount) / (2 * Allowed)));
                const int32 Index = RegionCm ? Candidate.TileInstances[CandidateIndex] : CandidateIndex;
                if (!Instanced->GetInstanceTransform(Index, Transform, true))
                {
                    Count(Result, TEXT("instance_transform_unavailable"));
                    continue;
                }
                ++Result.InstanceCount;
                const int32 InstanceNodeIndex = Result.Nodes.AddDefaulted();
                FNode& Node = Result.Nodes[InstanceNodeIndex];
                const FNode& Parent = Result.Nodes[Candidate.ComponentNodeIndex];
                Node.Id = Parent.Id + FString::Printf(TEXT("#instance:%d"), Index);
                Node.ParentIndex = Candidate.ComponentNodeIndex;
                Node.Kind = TEXT("instance");
                Node.Label = FString::Printf(TEXT("Instance %d"), Index);
                Node.Path = Node.Id;
                Node.Level = Parent.Level;
                Node.Folder = Parent.Folder;
                Node.ActorClass = Parent.ActorClass;
                Node.MeshAsset = Parent.MeshAsset;
                Node.ActorIndex = Candidate.ActorIndex;
                Node.InstanceIndex = Index;
                Node.GeometryStatus = TEXT("source_collected");
                Sources.Add({Candidate.Component, Candidate.LOD, Transform, Candidate.ActorIndex, InstanceNodeIndex});
                AddToAncestry(Result, InstanceNodeIndex, nullptr);
                continue;
            }
            Sources.Add({Candidate.Component, Candidate.LOD, Transform, Candidate.ActorIndex, Candidate.ComponentNodeIndex});
            AddToAncestry(Result, Candidate.ComponentNodeIndex, nullptr);
        }
        if (TimedOut(Start, CollectDeadline) || Sources.Num() >= SourceLimit || Result.InstanceCount >= InstanceLimit) break;
    }

    // Give each collected mesh/instance a quota before a large mesh consumes
    // the point budget. Inspect a bounded, stratified subset of its LOD
    // triangles, then distribute points by their transformed surface area.
    int32 TrianglesVisited = 0;
    for (int32 SourceIndex = 0; SourceIndex < Sources.Num(); ++SourceIndex)
    {
        if (TimedOut(Start, SurfaceDeadline) || Result.Splats.Num() >= PointLimit || TrianglesVisited >= MaxTrianglesVisited)
        {
            MarkPartial(Result, TimedOut(Start, SurfaceDeadline) ? TEXT("surface_time_budget") :
                (Result.Splats.Num() >= PointLimit ? TEXT("splat_cap") : TEXT("triangle_visit_cap")));
            break;
        }
        const FSource& Source = Sources[SourceIndex];
        const FStaticMeshLODResources& LOD = *Source.LOD;
        const FPositionVertexBuffer& Positions = LOD.VertexBuffers.PositionVertexBuffer;
        const FRawStaticIndexBuffer& Indices = LOD.IndexBuffer;
        const int32 TriangleCount = Indices.GetNumIndices() / 3;
        const int32 SourcesLeft = Sources.Num() - SourceIndex;
        const int32 Quota = FMath::Max(1, (PointLimit - Result.Splats.Num()) / SourcesLeft);
        const int32 TriangleBudget = FMath::Max(1,
            (MaxTrianglesVisited - TrianglesVisited) / SourcesLeft);
        const int32 CountToInspect = FMath::Min3(TriangleCount,
            RegionCm ? MaxTileTrianglesPerSource : MaxTrianglesPerSource, TriangleBudget);
        TArray<FSurfaceTriangle> Surface;
        Surface.Reserve(CountToInspect);
        double TotalArea = 0.0;
        for (int32 Sample = 0; Sample < CountToInspect; ++Sample)
        {
            if ((Sample & 31) == 0 && TimedOut(Start, SurfaceDeadline))
            { MarkPartial(Result, TEXT("surface_time_budget")); break; }
            ++TrianglesVisited;
            const int32 Triangle = static_cast<int32>((static_cast<int64>(Sample) * TriangleCount) / CountToInspect);
            const int32 Base = Triangle * 3;
            const uint32 I0 = Indices.GetIndex(Base);
            const uint32 I1 = Indices.GetIndex(Base + 1);
            const uint32 I2 = Indices.GetIndex(Base + 2);
            if (I0 >= Positions.GetNumVertices() || I1 >= Positions.GetNumVertices() || I2 >= Positions.GetNumVertices())
            {
                Count(Result, TEXT("invalid_lod_triangle"));
                continue;
            }
            const FVector A = Source.Transform.TransformPosition(FVector(Positions.VertexPosition(I0)));
            const FVector B = Source.Transform.TransformPosition(FVector(Positions.VertexPosition(I1)));
            const FVector C = Source.Transform.TransformPosition(FVector(Positions.VertexPosition(I2)));
            const FVector Cross = FVector::CrossProduct(B - A, C - A);
            const double Area = Cross.Size() * 0.5;
            if (A.ContainsNaN() || B.ContainsNaN() || C.ContainsNaN() ||
                !FMath::IsFinite(Area) || Area <= UE_DOUBLE_SMALL_NUMBER) continue;
            if (RegionCm)
            {
                if (TriangleBoundsIntersectsTile(A, B, C, *RegionCm))
                    AddClippedTriangle(A, B, C, Cross.GetSafeNormal(), *RegionCm, Surface, TotalArea);
                if (Surface.Num() >= MaxTileFragmentsPerSource)
                { MarkPartial(Result, TEXT("tile_triangle_fragment_cap")); break; }
            }
            else
            {
                TotalArea += Area;
                Surface.Add({A, B, C, Cross.GetSafeNormal(), TotalArea});
            }
            if (!FMath::IsFinite(TotalArea)) { MarkPartial(Result, TEXT("surface_area_overflow")); break; }
        }
        if (CountToInspect < TriangleCount) Result.bDownsampled = true;
        if (Result.bTruncated && (TimedOut(Start, SurfaceDeadline) || !FMath::IsFinite(TotalArea))) break;
        if (Surface.IsEmpty()) continue;
        const uint32 ColorHash = GetTypeHash(Result.Actors[Source.ActorIndex].Path);
        // Stable visualization swatches distinguish overlapping source shapes.
        // These are not sampled Unreal material or texture colors.
        static constexpr uint8 Stone[][3] = {
            {205, 190, 168}, {184, 173, 158}, {212, 184, 153},
            {170, 163, 151}, {194, 174, 153}
        };
        const uint8* Tone = Stone[(ColorHash >> 8) % UE_ARRAY_COUNT(Stone)];
        const int32 Jitter = static_cast<int32>(ColorHash & 7) - 3;
        for (int32 Sample = 0; Sample < Quota; ++Sample)
        {
            if ((Sample & 127) == 0 && TimedOut(Start, SurfaceDeadline))
            { MarkPartial(Result, TEXT("surface_time_budget")); break; }
            // A midpoint area quantile covers large faces proportionally;
            // Halton barycentrics spread repeats across each selected face.
            const double AreaPosition = (static_cast<double>(Sample) + 0.5) * TotalArea / Quota;
            int32 Low = 0, High = Surface.Num() - 1;
            while (Low < High)
            {
                const int32 Mid = (Low + High) / 2;
                if (Surface[Mid].CumulativeArea < AreaPosition) Low = Mid + 1;
                else High = Mid;
            }
            const FSurfaceTriangle& Triangle = Surface[Low];
            const uint32 Sequence = static_cast<uint32>(Sample + 1) + static_cast<uint32>(SourceIndex) * 8191u;
            const double U = FMath::Sqrt(RadicalInverse(Sequence, 2));
            const double V = RadicalInverse(Sequence, 3);
            const FVector Point = (1.0 - U) * Triangle.A + U * (1.0 - V) * Triangle.B + U * V * Triangle.C;
            if (Point.ContainsNaN()) continue;
            if (RegionCm && !RegionCm->IsInsideOrOn(Point)) continue;
            FSplat& Splat = Result.Splats.AddDefaulted_GetRef();
            Splat.PositionCm = Point - Result.OriginCm;
            Splat.Normal = Triangle.Normal;
            Splat.R = static_cast<uint8>(FMath::Clamp(static_cast<int32>(Tone[0]) + Jitter, 0, 255));
            Splat.G = static_cast<uint8>(FMath::Clamp(static_cast<int32>(Tone[1]) + Jitter, 0, 255));
            Splat.B = static_cast<uint8>(FMath::Clamp(static_cast<int32>(Tone[2]) + Jitter, 0, 255));
            Splat.ActorIndex = Source.ActorIndex;
            Splat.NodeIndex = Source.NodeIndex;
            Result.BoundsCm += Point;
            AddToAncestry(Result, Source.NodeIndex, &Point);
        }
        if (Quota < TriangleCount) Result.bDownsampled = true;
        if (Result.bTruncated && (TimedOut(Start, SurfaceDeadline) || TrianglesVisited >= MaxTrianglesVisited)) break;
    }
    BuildSpatialClusters(Result, Start, TotalDeadline);
    Result.ElapsedMs = (FPlatformTime::Seconds() - Start) * 1000.0;
    return Result;
}

FSnapshot Build(UWorld* World)
{
    return BuildInternal(World, nullptr, MaxSplats, MaxTotalSeconds);
}

FSnapshot BuildBatch(UWorld* World, const TArray<TWeakObjectPtr<AActor>>& LoadedActors,
    int32 PointLimit, double TimeLimitSeconds)
{
    return BuildInternal(World, &LoadedActors, PointLimit, TimeLimitSeconds);
}

FSnapshot BuildTileBatch(UWorld* World, const TArray<TWeakObjectPtr<AActor>>& LoadedActors,
    const FBox& RegionCm, int32 PointLimit, double TimeLimitSeconds)
{
    if (!RegionCm.IsValid) return FSnapshot();
    return BuildInternal(World, &LoadedActors, PointLimit, TimeLimitSeconds, &RegionCm);
}

bool TileBounds(int32 LOD, int32 X, int32 Y, int32 Z, FBox& OutBounds)
{
    if (LOD < 0 || LOD > 2 || FMath::Abs(static_cast<int64>(X)) > 100000 ||
        FMath::Abs(static_cast<int64>(Y)) > 100000 || FMath::Abs(static_cast<int64>(Z)) > 100000)
        return false;
    const double Edge = 4000.0 / static_cast<double>(1 << LOD);
    const FVector Min(static_cast<double>(X) * Edge, static_cast<double>(Y) * Edge,
        static_cast<double>(Z) * Edge);
    OutBounds = FBox(Min, Min + FVector(Edge, Edge, Edge));
    return true;
}

FString TileId(int32 LOD, int32 X, int32 Y, int32 Z)
{
    return FString::Printf(TEXT("tile:%d:%d:%d:%d"), LOD, X, Y, Z);
}

bool TriangleBoundsIntersectsTile(const FVector& A, const FVector& B, const FVector& C,
    const FBox& RegionCm)
{
    FBox TriangleBounds(EForceInit::ForceInit);
    TriangleBounds += A;
    TriangleBounds += B;
    TriangleBounds += C;
    return TriangleBounds.Intersect(RegionCm);
}

TSharedPtr<FJsonValue> SplatToJson(const FSplat& Splat)
{
    TArray<TSharedPtr<FJsonValue>> Row;
    Row.Reserve(12);
    for (double Value : {Splat.PositionCm.X, Splat.PositionCm.Y, Splat.PositionCm.Z,
        Splat.Normal.X, Splat.Normal.Y, Splat.Normal.Z,
        static_cast<double>(Splat.R), static_cast<double>(Splat.G), static_cast<double>(Splat.B),
        static_cast<double>(Splat.ActorIndex), static_cast<double>(Splat.NodeIndex),
        static_cast<double>(Splat.ClusterIndex)})
    {
        Row.Add(MakeShared<FJsonValueNumber>(Value));
    }
    return MakeShared<FJsonValueArray>(MoveTemp(Row));
}

TSharedRef<FJsonObject> ToMetadataJson(const FSnapshot& Snapshot, bool bIncludeSplats,
    const FString& Section, int32 Start, int32 Limit)
{
    auto VectorJson = [](const FVector& Vector)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        Values.Reserve(3);
        Values.Add(MakeShared<FJsonValueNumber>(Vector.X));
        Values.Add(MakeShared<FJsonValueNumber>(Vector.Y));
        Values.Add(MakeShared<FJsonValueNumber>(Vector.Z));
        return Values;
    };
    auto BoundsJson = [&VectorJson](const FBox& Box)
    {
        TSharedRef<FJsonObject> Value = MakeShared<FJsonObject>();
        Value->SetBoolField(TEXT("valid"), Box.IsValid != 0);
        Value->SetArrayField(TEXT("min"), VectorJson(Box.IsValid ? Box.Min : FVector::ZeroVector));
        Value->SetArrayField(TEXT("max"), VectorJson(Box.IsValid ? Box.Max : FVector::ZeroVector));
        return Value;
    };
    auto IntArrayJson = [](const TArray<int32>& Indices)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        Values.Reserve(Indices.Num());
        for (const int32 Index : Indices) Values.Add(MakeShared<FJsonValueNumber>(Index));
        return Values;
    };
    auto StringArrayJson = [](const TArray<FString>& Strings)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        Values.Reserve(Strings.Num());
        for (const FString& String : Strings) Values.Add(MakeShared<FJsonValueString>(String));
        return Values;
    };
    auto PageRange = [&Section, Start, Limit](int32 Total)
    {
        const int32 Begin = Section.IsEmpty() ? 0 : FMath::Clamp(Start, 0, Total);
        const int32 Count = Section.IsEmpty() ? Total : FMath::Clamp(Limit, 0, Total - Begin);
        return FIntPoint(Begin, Begin + Count);
    };

    TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetArrayField(TEXT("originCm"), VectorJson(Snapshot.OriginCm));
    Root->SetObjectField(TEXT("boundsCm"), BoundsJson(Snapshot.BoundsCm));
    TSharedRef<FJsonObject> Coverage = MakeShared<FJsonObject>();
    Coverage->SetBoolField(TEXT("loadedOnly"), true);
    Coverage->SetNumberField(TEXT("actorCount"), Snapshot.ActorCount);
    Coverage->SetNumberField(TEXT("visitedActorCount"), Snapshot.VisitedActorCount);
    Coverage->SetNumberField(TEXT("eligibleMeshActorCount"), Snapshot.EligibleMeshActorCount);
    Coverage->SetNumberField(TEXT("eligibleMetadataActorCount"), Snapshot.EligibleMetadataActorCount);
    Coverage->SetNumberField(TEXT("selectedActorCount"), Snapshot.SelectedActorCount);
    Coverage->SetNumberField(TEXT("eligibilityComponentCount"), Snapshot.EligibilityComponentCount);
    Coverage->SetNumberField(TEXT("componentCount"), Snapshot.ComponentCount);
    Coverage->SetNumberField(TEXT("observedInstanceCount"), static_cast<double>(Snapshot.ObservedInstanceCount));
    Coverage->SetBoolField(TEXT("observedInstanceCountSaturated"), Snapshot.bObservedInstanceCountSaturated);
    Coverage->SetStringField(TEXT("observedInstanceCountScope"), TEXT("processed_registered_static_mesh_components"));
    Coverage->SetNumberField(TEXT("instanceCount"), Snapshot.InstanceCount);
    Coverage->SetNumberField(TEXT("sampledInstanceCount"), Snapshot.InstanceCount);
    Coverage->SetNumberField(TEXT("sampledInstancedTransformCount"), Snapshot.InstanceCount);
    Coverage->SetStringField(TEXT("componentCountScope"), TEXT("processed_relevant_components"));
    Coverage->SetNumberField(TEXT("sourceCount"), Snapshot.Nodes.IsEmpty() ? 0 : Snapshot.Nodes[0].SourceCount);
    Coverage->SetNumberField(TEXT("splatCount"), Snapshot.Splats.Num());
    Coverage->SetNumberField(TEXT("clusteredSplatCount"), Snapshot.ClusteredSplatCount);
    Coverage->SetNumberField(TEXT("nodeCount"), Snapshot.Nodes.Num());
    Coverage->SetNumberField(TEXT("clusterCount"), Snapshot.Clusters.Num());
    Coverage->SetNumberField(TEXT("maxSplats"), MaxSplats);
    Coverage->SetNumberField(TEXT("maxVisitedActors"), MaxVisitedActors);
    Coverage->SetNumberField(TEXT("budgetMs"), MaxTotalSeconds * 1000.0);
    Coverage->SetNumberField(TEXT("elapsedMs"), Snapshot.ElapsedMs);
    Coverage->SetStringField(TEXT("stopReason"), Snapshot.StopReason);
    Coverage->SetArrayField(TEXT("stopReasons"), StringArrayJson(Snapshot.StopReasons));
    Coverage->SetBoolField(TEXT("truncated"), Snapshot.bTruncated);
    Coverage->SetBoolField(TEXT("actorIteratorComplete"), Snapshot.bActorIteratorComplete);
    Coverage->SetBoolField(TEXT("clustersComplete"), !Snapshot.bClusterPartial && Snapshot.ClusteredSplatCount == Snapshot.Splats.Num());
    Coverage->SetBoolField(TEXT("downsampled"), Snapshot.bDownsampled);
    Coverage->SetBoolField(TEXT("naniteProxy"), Snapshot.bNaniteProxy);
    Coverage->SetBoolField(TEXT("clustersCoverSampledPointsOnly"), true);
    Coverage->SetBoolField(TEXT("nodesCoverScannedActorsOnly"), true);
    Coverage->SetBoolField(TEXT("nodesCoverProcessedSelectedActorsOnly"), true);
    Coverage->SetStringField(TEXT("boundsProvenance"), TEXT("sampled_points"));
    Coverage->SetStringField(TEXT("source"), TEXT("cpu_render_lod"));
    Coverage->SetStringField(TEXT("pointColorProvenance"), TEXT("visualization_source_hash"));
    Coverage->SetBoolField(TEXT("materialColorSampled"), false);
    Coverage->SetStringField(TEXT("actorSelectionProvenance"), Snapshot.ActorSelectionProvenance);
    Coverage->SetStringField(TEXT("semanticProvenance"), TEXT("editor_metadata"));
    Coverage->SetStringField(TEXT("clusterProvenance"), TEXT("derived_spatial"));
    TSharedRef<FJsonObject> Unsupported = MakeShared<FJsonObject>();
    for (const TPair<FString, int32>& Item : Snapshot.UnsupportedByKind)
        Unsupported->SetNumberField(Item.Key, Item.Value);
    Unsupported->SetStringField(TEXT("unloaded_world_partition"), TEXT("not_scanned"));
    Coverage->SetObjectField(TEXT("unsupportedByKind"), Unsupported);
    Root->SetObjectField(TEXT("coverage"), Coverage);

    if (Section.IsEmpty() || Section == TEXT("actors"))
    {
        const FIntPoint Range = PageRange(Snapshot.Actors.Num());
        TArray<TSharedPtr<FJsonValue>> Actors;
        Actors.Reserve(Range.Y - Range.X);
        for (int32 Index = Range.X; Index < Range.Y; ++Index)
        {
            const FActor& Entry = Snapshot.Actors[Index];
            TSharedRef<FJsonObject> Actor = MakeShared<FJsonObject>();
            Actor->SetStringField(TEXT("path"), Entry.Path);
            Actor->SetStringField(TEXT("label"), Entry.Label);
            Actor->SetStringField(TEXT("folder"), Entry.Folder);
            Actor->SetNumberField(TEXT("selectionIndex"), Index);
            Actors.Add(MakeShared<FJsonValueObject>(Actor));
        }
        Root->SetArrayField(TEXT("actors"), MoveTemp(Actors));
    }

    if (Section.IsEmpty() || Section == TEXT("nodes"))
    {
        const FIntPoint Range = PageRange(Snapshot.Nodes.Num());
        TArray<TSharedPtr<FJsonValue>> Nodes;
        Nodes.Reserve(Range.Y - Range.X);
        for (int32 Index = Range.X; Index < Range.Y; ++Index)
        {
            const FNode& Entry = Snapshot.Nodes[Index];
            TSharedRef<FJsonObject> Node = MakeShared<FJsonObject>();
            Node->SetStringField(TEXT("id"), Entry.Id);
            Node->SetNumberField(TEXT("parentIndex"), Entry.ParentIndex);
            Node->SetStringField(TEXT("kind"), Entry.Kind);
            Node->SetStringField(TEXT("label"), Entry.Label);
            Node->SetStringField(TEXT("path"), Entry.Path);
            Node->SetStringField(TEXT("level"), Entry.Level);
            Node->SetStringField(TEXT("folder"), Entry.Folder);
            Node->SetStringField(TEXT("actorClass"), Entry.ActorClass);
            Node->SetStringField(TEXT("meshAsset"), Entry.MeshAsset);
            Node->SetStringField(TEXT("geometryStatus"), Entry.GeometryStatus);
            Node->SetArrayField(TEXT("tags"), StringArrayJson(Entry.Tags));
            Node->SetBoolField(TEXT("tagsTruncated"), Entry.bTagsTruncated);
            Node->SetStringField(TEXT("tagsProvenance"), TEXT("editor_metadata"));
            Node->SetNumberField(TEXT("actorIndex"), Entry.ActorIndex);
            Node->SetNumberField(TEXT("instanceIndex"), Entry.InstanceIndex);
            Node->SetNumberField(TEXT("observedInstanceCount"), Entry.ObservedInstanceCount);
            Node->SetNumberField(TEXT("sourceCount"), Entry.SourceCount);
            Node->SetNumberField(TEXT("splatCount"), Entry.SplatCount);
            Node->SetObjectField(TEXT("boundsCm"), BoundsJson(Entry.BoundsCm));
            Node->SetStringField(TEXT("boundsProvenance"), TEXT("sampled_points"));
            Nodes.Add(MakeShared<FJsonValueObject>(Node));
        }
        Root->SetArrayField(TEXT("nodes"), MoveTemp(Nodes));
    }

    if (Section.IsEmpty() || Section == TEXT("clusters"))
    {
        const FIntPoint Range = PageRange(Snapshot.Clusters.Num());
        TArray<TSharedPtr<FJsonValue>> Clusters;
        Clusters.Reserve(Range.Y - Range.X);
        for (int32 Index = Range.X; Index < Range.Y; ++Index)
        {
            const FCluster& Entry = Snapshot.Clusters[Index];
            TSharedRef<FJsonObject> Cluster = MakeShared<FJsonObject>();
            Cluster->SetStringField(TEXT("id"), Entry.Id);
            Cluster->SetNumberField(TEXT("parentIndex"), Entry.ParentIndex);
            Cluster->SetNumberField(TEXT("level"), Entry.Level);
            Cluster->SetArrayField(TEXT("centroidCm"), VectorJson(Entry.CentroidCm));
            Cluster->SetNumberField(TEXT("radiusCm"), Entry.RadiusCm);
            Cluster->SetObjectField(TEXT("boundsCm"), BoundsJson(Entry.BoundsCm));
            Cluster->SetStringField(TEXT("boundsProvenance"), TEXT("sampled_points"));
            Cluster->SetArrayField(TEXT("actorIndices"), IntArrayJson(Entry.ActorIndices));
            Cluster->SetArrayField(TEXT("nodeIndices"), IntArrayJson(Entry.NodeIndices));
            Cluster->SetNumberField(TEXT("splatCount"), Entry.SplatCount);
            Cluster->SetArrayField(TEXT("tags"), StringArrayJson(Entry.Tags));
            Cluster->SetBoolField(TEXT("tagsTruncated"), Entry.bTagsTruncated);
            Cluster->SetStringField(TEXT("tagsProvenance"), TEXT("union_of_source_editor_tags"));
            Cluster->SetStringField(TEXT("provenance"), TEXT("derived_spatial"));
            Clusters.Add(MakeShared<FJsonValueObject>(Cluster));
        }
        Root->SetArrayField(TEXT("clusters"), MoveTemp(Clusters));
    }

    if (bIncludeSplats && (Section.IsEmpty() || Section == TEXT("splats")))
    {
        const FIntPoint Range = PageRange(Snapshot.Splats.Num());
        TArray<TSharedPtr<FJsonValue>> Splats;
        Splats.Reserve(Range.Y - Range.X);
        for (int32 Index = Range.X; Index < Range.Y; ++Index)
            Splats.Add(SplatToJson(Snapshot.Splats[Index]));
        Root->SetArrayField(TEXT("splats"), MoveTemp(Splats));
    }
    if (!Section.IsEmpty())
    {
        int32 Total = 0;
        if (Section == TEXT("actors")) Total = Snapshot.Actors.Num();
        else if (Section == TEXT("nodes")) Total = Snapshot.Nodes.Num();
        else if (Section == TEXT("clusters")) Total = Snapshot.Clusters.Num();
        else if (Section == TEXT("splats") && bIncludeSplats) Total = Snapshot.Splats.Num();
        const FIntPoint Range = PageRange(Total);
        TSharedRef<FJsonObject> Page = MakeShared<FJsonObject>();
        Page->SetStringField(TEXT("section"), Section);
        Page->SetNumberField(TEXT("start"), Range.X);
        Page->SetNumberField(TEXT("count"), Range.Y - Range.X);
        Page->SetNumberField(TEXT("total"), Total);
        Root->SetObjectField(TEXT("page"), Page);
    }
    return Root;
}
}
