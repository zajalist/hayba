#pragma once

#include "CoreMinimal.h"

class UWorld;
class AActor;
class FJsonObject;
class FJsonValue;

namespace HaybaWorldGeometry
{
struct FActor
{
    FString Label;
    FString Folder;
    FString Path;
    TWeakObjectPtr<AActor> LoadedActor;
};

struct FSplat
{
    FVector PositionCm = FVector::ZeroVector;
    FVector Normal = FVector::UpVector;
    uint8 R = 0, G = 0, B = 0;
    int32 ActorIndex = INDEX_NONE;
    // Indices into snapshot metadata. A point carries no duplicated labels.
    int32 NodeIndex = INDEX_NONE;
    int32 ClusterIndex = INDEX_NONE;
};

/** Authored scene ancestry and source facts; Kind is world/level/folder/actor/component/instance. */
struct FNode
{
    FString Id;
    int32 ParentIndex = INDEX_NONE;
    FString Kind;
    FString Label;
    FString Path;
    FString Level;
    FString Folder;
    FString ActorClass;
    FString MeshAsset;
    FString GeometryStatus;
    TArray<FString> Tags;
    bool bTagsTruncated = false;
    int32 ActorIndex = INDEX_NONE;
    int32 InstanceIndex = INDEX_NONE;
    int32 ObservedInstanceCount = 0;
    int32 SourceCount = 0;
    int32 SplatCount = 0;
    FBox BoundsCm = FBox(EForceInit::ForceInit);
};

/** Computed spatial grouping, never an authored semantic classification. */
struct FCluster
{
    FString Id;
    int32 ParentIndex = INDEX_NONE;
    int32 Level = 0;
    FVector CentroidCm = FVector::ZeroVector;
    double RadiusCm = 0.0;
    FBox BoundsCm = FBox(EForceInit::ForceInit);
    TArray<int32> ActorIndices;
    TArray<int32> NodeIndices;
    int32 SplatCount = 0;
    TArray<FString> Tags;
    bool bTagsTruncated = false;
};

struct FSnapshot
{
    FVector OriginCm = FVector::ZeroVector;
    FBox BoundsCm = FBox(EForceInit::ForceInit);
    TArray<FActor> Actors;
    TArray<FNode> Nodes;
    TArray<FCluster> Clusters;
    TArray<FSplat> Splats;
    TMap<FString, int32> UnsupportedByKind;
    int32 ActorCount = 0;
    int32 VisitedActorCount = 0;
    int32 EligibleMeshActorCount = 0;
    int32 EligibleMetadataActorCount = 0;
    int32 SelectedActorCount = 0;
    int32 EligibilityComponentCount = 0;
    int32 ComponentCount = 0;
    int64 ObservedInstanceCount = 0;
    int32 InstanceCount = 0;
    int32 ClusteredSplatCount = 0;
    double ElapsedMs = 0.0;
    FString StopReason;
    FString ActorSelectionProvenance = TEXT("stable_path_hash_reservoir");
    TArray<FString> StopReasons;
    bool bActorIteratorComplete = false;
    bool bObservedInstanceCountSaturated = false;
    bool bClusterPartial = false;
    bool bTruncated = false;
    bool bDownsampled = false;
    bool bNaniteProxy = false;
};

/** Bounded, loaded-world CPU render-LOD triangle samples. Never reads GPU-only buffers. */
FSnapshot Build(UWorld* World);

/** A small game-thread slice for the World panel. Call with distinct loaded actors
 *  over successive Slate ticks; the caller owns scan progress and the total cap.
 *  No actor is loaded, and every returned index is local to this slice. */
FSnapshot BuildBatch(UWorld* World, const TArray<TWeakObjectPtr<AActor>>& LoadedActors,
    int32 PointLimit, double TimeLimitSeconds = 0.012);

/** Shared UI/MCP metadata shape. Defaults to compact summaries without point positions. */
TSharedRef<FJsonObject> ToMetadataJson(const FSnapshot& Snapshot, bool bIncludeSplats = false,
    const FString& Section = FString(), int32 Start = 0, int32 Limit = MAX_int32);

/** One point row for focused machine-readable pages. */
TSharedPtr<FJsonValue> SplatToJson(const FSplat& Splat);
}
