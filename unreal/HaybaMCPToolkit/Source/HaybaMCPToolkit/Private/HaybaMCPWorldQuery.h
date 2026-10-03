#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPWorldTileSnapshot.h"

/** Read-only, bounded source and relation retrieval from one immutable mesh tile.
 * Geometry predicates describe sampled point bounds, never full mesh contact,
 * visibility, navigation, or an inferred gameplay label. */
namespace HaybaWorldQuery
{
struct FFact
{
    // tag, folder, actor_class, or mesh_asset; Value is matched exactly.
    FString Kind;
    FString Value;

    bool IsSet() const { return !Kind.IsEmpty() || !Value.IsEmpty(); }
};

struct FRequest
{
    FFact Target;
    // A relation requires exactly one reference: canonical sampled source ID
    // or an authored fact selector. Without a relation, omit both.
    FString ReferenceSourceNodeId;
    FFact Reference;
    // near_sampled_bounds, above_sampled_bounds, sampled_bounds_overlap,
    // sampled_bounds_contains, or empty for source-only retrieval.
    FString RelationKind;
    double NearThresholdCm = 250.0;
    double AboveMinimumGapCm = 10.0;
    double AboveMaximumGapCm = 500.0;
    int32 MaxPairs = 16384;
    int32 MaxMatches = 1024;
};

struct FMatch
{
    FString SourceNodeId;
    FString SourceKind;
    FString ActorPath;
    FString ComponentNodeId;
    int32 InstanceIndex = INDEX_NONE;
    FString GeometryStatus;
    FString MatchedFactOwnerNodeId;
    int32 SampledPointCount = 0;
    FBox SampledBoundsCm = FBox(EForceInit::ForceInit);
    FString ReferenceSourceNodeId;
    FString ReferenceActorPath;
    double BoundsGapCm = 0.0;
    double VerticalGapCm = 0.0;
    double ThresholdCm = 0.0;
    TArray<FString> EvidencePointIds;
};

struct FResult
{
    FString CaptureId;
    FString TileId;
    FString CapturedAtUtc;
    FString Status;
    FRequest Request;
    int32 ObservedPointCount = 0;
    int32 IndexedSourceCount = 0;
    int32 MatchingTargetCount = 0;
    int32 MatchingReferenceCount = 0;
    int32 EvaluatedPairCount = 0;
    bool bPartial = false;
    TArray<FString> Gaps;
    TArray<FMatch> Matches;
};

bool ValidateRequest(const FRequest& Request, FString& OutError);
FResult Build(const HaybaWorldTileSnapshot::FTile& Tile, const FRequest& Request);
TSharedRef<FJsonObject> BuildPage(const FResult& Result, int32 Offset, int32 Limit);
}
