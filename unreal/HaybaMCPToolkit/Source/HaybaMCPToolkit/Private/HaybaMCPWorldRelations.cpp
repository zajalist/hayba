#include "HaybaMCPWorldRelations.h"

#include "Dom/JsonValue.h"

namespace HaybaWorldRelations
{
namespace
{
constexpr int32 MaxPageRows = 64;

struct FSource
{
    FString NodeId;
    FBox BoundsCm = FBox(EForceInit::ForceInit);
    int32 PointCount = 0;
    FString MinEvidence[3];
    FString MaxEvidence[3];
};

FString PointId(const HaybaWorldTileSnapshot::FTile& Tile, int32 PageId, int32 PointIndex)
{
    return FString::Printf(TEXT("%s/%s/page:%d/point:%d"),
        *Tile.CaptureId, *Tile.TileId, PageId, PointIndex);
}

void AddPoint(FSource& Source, const FVector& Position, const FString& EvidenceId)
{
    if (!Source.BoundsCm.IsValid)
    {
        Source.BoundsCm += Position;
        for (int32 Axis = 0; Axis < 3; ++Axis)
            Source.MinEvidence[Axis] = Source.MaxEvidence[Axis] = EvidenceId;
    }
    else
    {
        for (int32 Axis = 0; Axis < 3; ++Axis)
        {
            if (Position[Axis] < Source.BoundsCm.Min[Axis] ||
                (Position[Axis] == Source.BoundsCm.Min[Axis] && EvidenceId < Source.MinEvidence[Axis]))
                Source.MinEvidence[Axis] = EvidenceId;
            if (Position[Axis] > Source.BoundsCm.Max[Axis] ||
                (Position[Axis] == Source.BoundsCm.Max[Axis] && EvidenceId < Source.MaxEvidence[Axis]))
                Source.MaxEvidence[Axis] = EvidenceId;
        }
        Source.BoundsCm += Position;
    }
    ++Source.PointCount;
}

double AxisGap(double AMin, double AMax, double BMin, double BMax)
{
    return FMath::Max3(0.0, BMin - AMax, AMin - BMax);
}

double BoundsGap(const FBox& A, const FBox& B)
{
    const double X = AxisGap(A.Min.X, A.Max.X, B.Min.X, B.Max.X);
    const double Y = AxisGap(A.Min.Y, A.Max.Y, B.Min.Y, B.Max.Y);
    const double Z = AxisGap(A.Min.Z, A.Max.Z, B.Min.Z, B.Max.Z);
    return FMath::Sqrt(X * X + Y * Y + Z * Z);
}

double PlanarGap(const FBox& A, const FBox& B)
{
    const double X = AxisGap(A.Min.X, A.Max.X, B.Min.X, B.Max.X);
    const double Y = AxisGap(A.Min.Y, A.Max.Y, B.Min.Y, B.Max.Y);
    return FMath::Sqrt(X * X + Y * Y);
}

bool BoundsOverlap(const FBox& A, const FBox& B)
{
    for (int32 Axis = 0; Axis < 3; ++Axis)
        if (A.Max[Axis] < B.Min[Axis] || B.Max[Axis] < A.Min[Axis]) return false;
    return true;
}

bool BoundsContains(const FBox& Outer, const FBox& Inner)
{
    bool bStrict = false;
    for (int32 Axis = 0; Axis < 3; ++Axis)
    {
        if (Outer.Min[Axis] > Inner.Min[Axis] || Outer.Max[Axis] < Inner.Max[Axis]) return false;
        bStrict |= Outer.Min[Axis] < Inner.Min[Axis] || Outer.Max[Axis] > Inner.Max[Axis];
    }
    return bStrict;
}

void AddUniqueEvidence(TArray<FString>& Evidence, const FString& Id)
{
    if (!Id.IsEmpty()) Evidence.AddUnique(Id);
}

TArray<FString> BoundaryEvidence(const FSource& A, const FSource& B)
{
    TArray<FString> Evidence;
    Evidence.Reserve(12);
    for (int32 Axis = 0; Axis < 3; ++Axis)
    {
        AddUniqueEvidence(Evidence, A.MinEvidence[Axis]);
        AddUniqueEvidence(Evidence, A.MaxEvidence[Axis]);
        AddUniqueEvidence(Evidence, B.MinEvidence[Axis]);
        AddUniqueEvidence(Evidence, B.MaxEvidence[Axis]);
    }
    return Evidence;
}

TArray<FString> GapEvidence(const FSource& A, const FSource& B)
{
    int32 Axis = 0;
    double LargestGap = -1.0;
    for (int32 Candidate = 0; Candidate < 3; ++Candidate)
    {
        const double Gap = AxisGap(A.BoundsCm.Min[Candidate], A.BoundsCm.Max[Candidate],
            B.BoundsCm.Min[Candidate], B.BoundsCm.Max[Candidate]);
        if (Gap > LargestGap) { LargestGap = Gap; Axis = Candidate; }
    }
    TArray<FString> Evidence;
    if (A.BoundsCm.Max[Axis] < B.BoundsCm.Min[Axis])
    {
        AddUniqueEvidence(Evidence, A.MaxEvidence[Axis]);
        AddUniqueEvidence(Evidence, B.MinEvidence[Axis]);
    }
    else
    {
        AddUniqueEvidence(Evidence, A.MinEvidence[Axis]);
        AddUniqueEvidence(Evidence, B.MaxEvidence[Axis]);
    }
    return Evidence;
}

TArray<FString> VerticalEvidence(const FSource& Above, const FSource& Below)
{
    TArray<FString> Evidence;
    AddUniqueEvidence(Evidence, Above.MinEvidence[2]);
    AddUniqueEvidence(Evidence, Below.MaxEvidence[2]);
    return Evidence;
}

FString RelationId(const FResult& Result, const FString& Kind,
    const FString& SourceNodeId, const FString& TargetNodeId)
{
    // Length delimiters preserve identity even when Unreal object paths carry
    // separators or the same node appears on another captured tile.
    return FString::Printf(TEXT("%s/%s/rel:%s:%d:%s:%d:%s"),
        *Result.CaptureId, *Result.TileId, *Kind, SourceNodeId.Len(), *SourceNodeId,
        TargetNodeId.Len(), *TargetNodeId);
}

void Emit(FResult& Result, const TCHAR* Kind, const FSource& Source,
    const FSource& Target, double GapCm, double VerticalGapCm,
    double ThresholdCm, TArray<FString>&& Evidence)
{
    if (Result.Relations.Num() >= Result.Options.MaxRelations)
    {
        Result.bPartial = true;
        Result.Gaps.AddUnique(TEXT("relation_cap"));
        return;
    }
    FRelation& Relation = Result.Relations.AddDefaulted_GetRef();
    Relation.Kind = Kind;
    Relation.SourceNodeId = Source.NodeId;
    Relation.TargetNodeId = Target.NodeId;
    Relation.Id = RelationId(Result, Relation.Kind, Source.NodeId, Target.NodeId);
    Relation.SourcePointCount = Source.PointCount;
    Relation.TargetPointCount = Target.PointCount;
    Relation.BoundsGapCm = GapCm;
    Relation.VerticalGapCm = VerticalGapCm;
    Relation.ThresholdCm = ThresholdCm;
    Relation.EvidencePointIds = MoveTemp(Evidence);
}
}

FResult Build(const HaybaWorldTileSnapshot::FTile& Tile, const FOptions& RequestedOptions)
{
    FResult Result;
    Result.CaptureId = Tile.CaptureId;
    Result.TileId = Tile.TileId;
    Result.Options.NearThresholdCm = FMath::Clamp(RequestedOptions.NearThresholdCm, 0.0, 2000.0);
    Result.Options.AboveMinimumGapCm = FMath::Clamp(RequestedOptions.AboveMinimumGapCm, 0.0, 1000.0);
    Result.Options.AboveMaximumGapCm = FMath::Clamp(RequestedOptions.AboveMaximumGapCm,
        Result.Options.AboveMinimumGapCm, 5000.0);
    Result.Options.MaxSources = FMath::Clamp(RequestedOptions.MaxSources, 2, 256);
    Result.Options.MaxRelations = FMath::Clamp(RequestedOptions.MaxRelations, 1, 1024);
    Result.bPartial = Tile.bPartial;
    Result.Gaps = Tile.Gaps;
    if (Tile.CaptureId.IsEmpty())
    {
        Result.bPartial = true;
        Result.Gaps.AddUnique(TEXT("capture_id_missing"));
    }
    int32 ObservedPointCount = 0;
    TMap<FString, FSource> SourcesById;
    for (const HaybaWorldTileSnapshot::FPage& Page : Tile.Pages)
    {
        const HaybaWorldGeometry::FSnapshot& Geometry = Page.Geometry;
        for (int32 PointIndex = 0; PointIndex < Geometry.Splats.Num(); ++PointIndex)
        {
            ++ObservedPointCount;
            const HaybaWorldGeometry::FSplat& Point = Geometry.Splats[PointIndex];
            if (!Geometry.Nodes.IsValidIndex(Point.NodeIndex))
            {
                Result.bPartial = true;
                Result.Gaps.AddUnique(TEXT("source_node_index_missing"));
                continue;
            }
            const FString& NodeId = Geometry.Nodes[Point.NodeIndex].Id;
            const FVector Position = Point.PositionCm + Geometry.OriginCm;
            if (NodeId.IsEmpty() || Position.ContainsNaN() ||
                !FMath::IsFinite(Position.X) || !FMath::IsFinite(Position.Y) ||
                !FMath::IsFinite(Position.Z))
            {
                Result.bPartial = true;
                Result.Gaps.AddUnique(TEXT("source_geometry_invalid"));
                continue;
            }
            FSource& Source = SourcesById.FindOrAdd(NodeId);
            Source.NodeId = NodeId;
            AddPoint(Source, Position, PointId(Tile, Page.PageId, PointIndex));
        }
    }
    if (ObservedPointCount != Tile.PointCount)
    {
        Result.bPartial = true;
        Result.Gaps.AddUnique(TEXT("tile_point_count_mismatch"));
    }
    Result.ObservedSourceCount = SourcesById.Num();
    TArray<FSource> Sources;
    Sources.Reserve(SourcesById.Num());
    for (TPair<FString, FSource>& Entry : SourcesById)
        if (Entry.Value.PointCount > 0 && Entry.Value.BoundsCm.IsValid)
            Sources.Add(MoveTemp(Entry.Value));
    Sources.Sort([](const FSource& A, const FSource& B) { return A.NodeId < B.NodeId; });
    if (Sources.Num() > Result.Options.MaxSources)
    {
        Result.bPartial = true;
        Result.Gaps.AddUnique(TEXT("source_cap"));
        Sources.SetNum(Result.Options.MaxSources, EAllowShrinking::Yes);
    }
    Result.EvaluatedSourceCount = Sources.Num();
    for (int32 AIndex = 0; AIndex < Sources.Num(); ++AIndex)
    {
        for (int32 BIndex = AIndex + 1; BIndex < Sources.Num(); ++BIndex)
        {
            if (Result.Relations.Num() >= Result.Options.MaxRelations)
            {
                Result.bPartial = true;
                Result.Gaps.AddUnique(TEXT("relation_cap"));
                return Result;
            }
            ++Result.EvaluatedPairCount;
            const FSource& A = Sources[AIndex];
            const FSource& B = Sources[BIndex];
            const double Gap = BoundsGap(A.BoundsCm, B.BoundsCm);
            if (!FMath::IsFinite(Gap))
            {
                Result.bPartial = true;
                Result.Gaps.AddUnique(TEXT("non_finite_bounds_gap"));
                continue;
            }
            const bool bAContainsB = BoundsContains(A.BoundsCm, B.BoundsCm);
            const bool bBContainsA = BoundsContains(B.BoundsCm, A.BoundsCm);
            if (bAContainsB)
                Emit(Result, TEXT("sampled_bounds_contains"), A, B, 0.0, 0.0, 0.0,
                    BoundaryEvidence(A, B));
            else if (bBContainsA)
                Emit(Result, TEXT("sampled_bounds_contains"), B, A, 0.0, 0.0, 0.0,
                    BoundaryEvidence(B, A));
            else if (BoundsOverlap(A.BoundsCm, B.BoundsCm))
                Emit(Result, TEXT("sampled_bounds_overlap"), A, B, 0.0, 0.0, 0.0,
                    BoundaryEvidence(A, B));

            const double XYGap = PlanarGap(A.BoundsCm, B.BoundsCm);
            const double AAboveB = A.BoundsCm.Min.Z - B.BoundsCm.Max.Z;
            const double BAboveA = B.BoundsCm.Min.Z - A.BoundsCm.Max.Z;
            bool bAbove = false;
            if (FMath::IsFinite(XYGap) && XYGap <= Result.Options.NearThresholdCm)
            {
                if (AAboveB > 0.0 && AAboveB >= Result.Options.AboveMinimumGapCm &&
                    AAboveB <= Result.Options.AboveMaximumGapCm)
                {
                    Emit(Result, TEXT("above_sampled_bounds"), A, B, Gap, AAboveB,
                        Result.Options.AboveMaximumGapCm,
                        VerticalEvidence(A, B));
                    bAbove = true;
                }
                else if (BAboveA > 0.0 && BAboveA >= Result.Options.AboveMinimumGapCm &&
                    BAboveA <= Result.Options.AboveMaximumGapCm)
                {
                    Emit(Result, TEXT("above_sampled_bounds"), B, A, Gap, BAboveA,
                        Result.Options.AboveMaximumGapCm,
                        VerticalEvidence(B, A));
                    bAbove = true;
                }
            }
            if (!bAbove && Gap > 0.0 && Gap <= Result.Options.NearThresholdCm)
                Emit(Result, TEXT("near_sampled_bounds"), A, B, Gap, 0.0,
                    Result.Options.NearThresholdCm, GapEvidence(A, B));
        }
    }
    return Result;
}

TSharedRef<FJsonObject> BuildPage(const FResult& Result, int32 Offset, int32 Limit)
{
    const int32 Start = FMath::Clamp(Offset, 0, Result.Relations.Num());
    const int32 Count = FMath::Clamp(Limit, 1, MaxPageRows);
    const int32 End = FMath::Min(Start + Count, Result.Relations.Num());
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("source"), TEXT("captured_mesh_tile_relations"));
    Out->SetStringField(TEXT("capture_id"), Result.CaptureId);
    Out->SetStringField(TEXT("tile_id"), Result.TileId);
    Out->SetStringField(TEXT("status"), Result.bPartial ? TEXT("partial") : TEXT("captured"));
    Out->SetStringField(TEXT("freshness"), TEXT("captured_observation"));
    Out->SetStringField(TEXT("relation_scope"), TEXT("candidates_from_sampled_axis_aligned_bounds"));
    Out->SetBoolField(TEXT("physical_contact_proven"), false);
    Out->SetBoolField(TEXT("occlusion_or_visibility_inferred"), false);
    Out->SetNumberField(TEXT("near_threshold_cm"), Result.Options.NearThresholdCm);
    Out->SetNumberField(TEXT("above_minimum_gap_cm"), Result.Options.AboveMinimumGapCm);
    Out->SetNumberField(TEXT("above_maximum_gap_cm"), Result.Options.AboveMaximumGapCm);
    Out->SetNumberField(TEXT("observed_source_count"), Result.ObservedSourceCount);
    Out->SetNumberField(TEXT("evaluated_source_count"), Result.EvaluatedSourceCount);
    Out->SetNumberField(TEXT("evaluated_pair_count"), Result.EvaluatedPairCount);
    Out->SetNumberField(TEXT("total_relations"), Result.Relations.Num());
    Out->SetNumberField(TEXT("offset"), Start);
    Out->SetNumberField(TEXT("limit"), Count);
    if (End < Result.Relations.Num()) Out->SetNumberField(TEXT("next_offset"), End);
    TArray<TSharedPtr<FJsonValue>> Gaps;
    for (const FString& Gap : Result.Gaps) Gaps.Add(MakeShared<FJsonValueString>(Gap));
    Out->SetArrayField(TEXT("gaps"), MoveTemp(Gaps));
    TArray<TSharedPtr<FJsonValue>> Items;
    Items.Reserve(End - Start);
    for (int32 Index = Start; Index < End; ++Index)
    {
        const FRelation& Relation = Result.Relations[Index];
        TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("id"), Relation.Id);
        Item->SetStringField(TEXT("kind"), Relation.Kind);
        Item->SetStringField(TEXT("source_node_id"), Relation.SourceNodeId);
        Item->SetStringField(TEXT("target_node_id"), Relation.TargetNodeId);
        Item->SetStringField(TEXT("status"), TEXT("candidate_from_sampled_bounds"));
        Item->SetNumberField(TEXT("source_point_count"), Relation.SourcePointCount);
        Item->SetNumberField(TEXT("target_point_count"), Relation.TargetPointCount);
        Item->SetNumberField(TEXT("bounds_gap_cm"), Relation.BoundsGapCm);
        Item->SetNumberField(TEXT("vertical_gap_cm"), Relation.VerticalGapCm);
        Item->SetNumberField(TEXT("threshold_cm"), Relation.ThresholdCm);
        TArray<TSharedPtr<FJsonValue>> Evidence;
        for (const FString& Id : Relation.EvidencePointIds)
            Evidence.Add(MakeShared<FJsonValueString>(Id));
        Item->SetArrayField(TEXT("evidence_point_ids"), MoveTemp(Evidence));
        Items.Add(MakeShared<FJsonValueObject>(Item));
    }
    Out->SetArrayField(TEXT("items"), MoveTemp(Items));
    return Out;
}
}
