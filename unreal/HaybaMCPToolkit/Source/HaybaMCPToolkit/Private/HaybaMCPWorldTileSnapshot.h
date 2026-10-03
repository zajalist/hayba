#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPWorldGeometry.h"

class UWorld;

/** Immutable, captured loaded-world CPU geometry tiles. The cache is bounded
 * and read-only queries never sample meshes or invoke the renderer. */
namespace HaybaWorldTileSnapshot
{
struct FPage
{
    int32 PageId = 0;
    HaybaWorldGeometry::FSnapshot Geometry;
};

/** Authored metadata category over sampled source nodes. Bounds derive only
 * from points observed in this captured tile. */
struct FSemanticGroup
{
    FString Kind;
    FString Value;
    int32 SourceCount = 0;
    int32 PointCount = 0;
    FBox BoundsCm = FBox(EForceInit::ForceInit);
    TArray<FString> SourceNodeIds;
    bool bSourceNodeIdsTruncated = false;
};

struct FTile
{
    FString TileId;
    FString CaptureId;
    FString CapturedAtUtc;
    FString WorldPath;
    TWeakObjectPtr<UWorld> World;
    FBox BoundsCm = FBox(EForceInit::ForceInit);
    FVector OriginCm = FVector::ZeroVector;
    int32 LOD = 0;
    int32 PointCount = 0;
    int32 ScannedActorSlots = 0;
    int32 EligibleActorCount = 0;
    bool bPartial = false;
    TArray<FString> Gaps;
    TArray<FPage> Pages;
    TArray<FSemanticGroup> SemanticGroups;
};

void Publish(FTile&& Tile);
/** Empty CaptureId resolves the newest retained capture of this tile for the
 * requested world; a nonempty ID resolves that immutable capture exactly. */
TSharedPtr<const FTile> GetForWorld(const UWorld* World, const FString& TileId,
    const FString& CaptureId = FString());
/** Resolve an exact capture when its job record has already been pruned. */
TSharedPtr<const FTile> GetByCaptureIdForWorld(const UWorld* World,
    const FString& CaptureId);
void Invalidate();

/** Bounded machine-readable captured observation. Section is summary,
 * pages, semantic, nodes, or points. PageId is required for nodes/points. */
TSharedRef<FJsonObject> BuildPage(const FTile& Tile, const FString& Section,
    int32 PageId, int32 Offset, int32 Limit);
TSharedRef<FJsonObject> BuildNotCaptured(const FString& TileId);
}
