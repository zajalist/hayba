#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPWorldTileSnapshot.h"

/** Deterministic spatial candidates from one immutable, captured mesh tile.
 * These relationships describe sampled axis-aligned bounds. They do not prove
 * physical contact, containment in a mesh volume, visibility, or occlusion. */
namespace HaybaWorldRelations
{
struct FOptions
{
    double NearThresholdCm = 250.0;
    double AboveMinimumGapCm = 10.0;
    double AboveMaximumGapCm = 500.0;
    int32 MaxSources = 256;
    int32 MaxRelations = 1024;
};

struct FRelation
{
    FString Id;
    FString Kind;
    FString SourceNodeId;
    FString TargetNodeId;
    int32 SourcePointCount = 0;
    int32 TargetPointCount = 0;
    double BoundsGapCm = 0.0;
    double VerticalGapCm = 0.0;
    double ThresholdCm = 0.0;
    TArray<FString> EvidencePointIds;
};

struct FResult
{
    FString CaptureId;
    FString TileId;
    FOptions Options;
    int32 ObservedSourceCount = 0;
    int32 EvaluatedSourceCount = 0;
    int32 EvaluatedPairCount = 0;
    bool bPartial = false;
    TArray<FString> Gaps;
    TArray<FRelation> Relations;
};

FResult Build(const HaybaWorldTileSnapshot::FTile& Tile,
    const FOptions& RequestedOptions = FOptions());
TSharedRef<FJsonObject> BuildPage(const FResult& Result, int32 Offset, int32 Limit);
}
