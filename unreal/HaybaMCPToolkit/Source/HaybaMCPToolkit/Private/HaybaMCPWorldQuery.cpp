#include "HaybaMCPWorldQuery.h"

#include "Dom/JsonValue.h"

namespace HaybaWorldQuery
{
namespace
{
constexpr int32 MaxInputPoints = 8192;
constexpr int32 MaxInputPages = 512;
constexpr int32 MaxPairEvaluations = 16384;
constexpr int32 MaxResultMatches = 1024;
constexpr int32 MaxPageRows = 32;
constexpr int32 MaxEvidenceIds = 8;

struct FSource
{
    FString NodeId;
    FString Kind;
    FString ActorPath;
    FString ComponentNodeId;
    FString Folder;
    FString ActorClass;
    FString MeshAsset;
    FString FolderOwnerNodeId;
    FString ActorClassOwnerNodeId;
    FString MeshAssetOwnerNodeId;
    FString GeometryStatus;
    TMap<FString, FString> TagOwnerByValue;
    int32 InstanceIndex = INDEX_NONE;
    int32 PointCount = 0;
    FBox BoundsCm = FBox(EForceInit::ForceInit);
    FString MinPointId[3];
    FString MaxPointId[3];
};

bool Same(const FString& Left, const FString& Right)
{
    return Left.Equals(Right, ESearchCase::CaseSensitive);
}

bool ValidFactKind(const FString& Kind)
{
    return Kind == TEXT("tag") || Kind == TEXT("folder") ||
        Kind == TEXT("actor_class") || Kind == TEXT("mesh_asset");
}

bool ValidRelationKind(const FString& Kind)
{
    return Kind == TEXT("near_sampled_bounds") ||
        Kind == TEXT("above_sampled_bounds") ||
        Kind == TEXT("sampled_bounds_overlap") ||
        Kind == TEXT("sampled_bounds_contains");
}

void MarkPartial(FResult& Result, const TCHAR* Gap)
{
    Result.bPartial = true;
    Result.Gaps.AddUnique(Gap);
}

FString PointId(const HaybaWorldTileSnapshot::FTile& Tile, int32 PageId, int32 PointIndex)
{
    return FString::Printf(TEXT("%s/%s/page:%d/point:%d"),
        *Tile.CaptureId, *Tile.TileId, PageId, PointIndex);
}

void AddPoint(FSource& Source, const FVector& Position, const FString& EvidenceId)
{
    if (!Source.BoundsCm.IsValid)
    {
        for (int32 Axis = 0; Axis < 3; ++Axis)
            Source.MinPointId[Axis] = Source.MaxPointId[Axis] = EvidenceId;
    }
    else
    {
        for (int32 Axis = 0; Axis < 3; ++Axis)
        {
            if (Position[Axis] < Source.BoundsCm.Min[Axis] ||
                (Position[Axis] == Source.BoundsCm.Min[Axis] &&
                    EvidenceId < Source.MinPointId[Axis]))
                Source.MinPointId[Axis] = EvidenceId;
            if (Position[Axis] > Source.BoundsCm.Max[Axis] ||
                (Position[Axis] == Source.BoundsCm.Max[Axis] &&
                    EvidenceId < Source.MaxPointId[Axis]))
                Source.MaxPointId[Axis] = EvidenceId;
        }
    }
    Source.BoundsCm += Position;
    ++Source.PointCount;
}

void AddEvidence(TArray<FString>& Evidence, const FString& Id)
{
    if (!Id.IsEmpty() && Evidence.Num() < MaxEvidenceIds) Evidence.AddUnique(Id);
}

TArray<FString> BoundaryEvidence(const FSource& A, const FSource* B = nullptr)
{
    TArray<FString> Evidence;
    for (int32 Axis = 0; Axis < 3; ++Axis)
    {
        AddEvidence(Evidence, A.MinPointId[Axis]);
        AddEvidence(Evidence, A.MaxPointId[Axis]);
        if (B)
        {
            AddEvidence(Evidence, B->MinPointId[Axis]);
            AddEvidence(Evidence, B->MaxPointId[Axis]);
        }
    }
    return Evidence;
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

bool Overlaps(const FBox& A, const FBox& B)
{
    for (int32 Axis = 0; Axis < 3; ++Axis)
        if (A.Max[Axis] < B.Min[Axis] || B.Max[Axis] < A.Min[Axis]) return false;
    return true;
}

bool StrictlyContains(const FBox& Outer, const FBox& Inner)
{
    bool bStrict = false;
    for (int32 Axis = 0; Axis < 3; ++Axis)
    {
        if (Outer.Min[Axis] > Inner.Min[Axis] || Outer.Max[Axis] < Inner.Max[Axis]) return false;
        bStrict |= Outer.Min[Axis] < Inner.Min[Axis] || Outer.Max[Axis] > Inner.Max[Axis];
    }
    return bStrict;
}

void ReadSourceMetadata(const HaybaWorldGeometry::FSnapshot& Geometry,
    int32 NodeIndex, FSource& Source, FResult& Result)
{
    const HaybaWorldGeometry::FNode& Node = Geometry.Nodes[NodeIndex];
    Source.NodeId = Node.Id;
    Source.Kind = Node.Kind;
    Source.Folder = Node.Folder;
    Source.ActorClass = Node.ActorClass;
    Source.MeshAsset = Node.MeshAsset;
    Source.InstanceIndex = Node.InstanceIndex;
    Source.GeometryStatus = Node.GeometryStatus;
    if (Geometry.Actors.IsValidIndex(Node.ActorIndex))
        Source.ActorPath = Geometry.Actors[Node.ActorIndex].Path;
    else MarkPartial(Result, TEXT("source_actor_index_missing"));
    TSet<int32> Visited;
    for (int32 At = NodeIndex; Geometry.Nodes.IsValidIndex(At) && !Visited.Contains(At);
        At = Geometry.Nodes[At].ParentIndex)
    {
        Visited.Add(At);
        const HaybaWorldGeometry::FNode& Ancestor = Geometry.Nodes[At];
        if (Ancestor.Kind == TEXT("component") && Source.ComponentNodeId.IsEmpty())
            Source.ComponentNodeId = Ancestor.Id;
        if (Ancestor.Kind == TEXT("folder") && Source.FolderOwnerNodeId.IsEmpty())
            Source.FolderOwnerNodeId = Ancestor.Id;
        if (Ancestor.Kind == TEXT("actor") && Source.ActorClassOwnerNodeId.IsEmpty())
            Source.ActorClassOwnerNodeId = Ancestor.Id;
        if (Ancestor.Kind == TEXT("component") && Source.MeshAssetOwnerNodeId.IsEmpty())
            Source.MeshAssetOwnerNodeId = Ancestor.Id;
        if (Ancestor.bTagsTruncated) MarkPartial(Result, TEXT("authored_tags_truncated"));
        for (const FString& Tag : Ancestor.Tags)
            if (!Tag.IsEmpty() && !Source.TagOwnerByValue.Contains(Tag))
                Source.TagOwnerByValue.Add(Tag, Ancestor.Id);
    }
    if (Visited.Num() >= Geometry.Nodes.Num() &&
        Geometry.Nodes.IsValidIndex(Node.ParentIndex) && Visited.Contains(Node.ParentIndex))
        MarkPartial(Result, TEXT("source_ancestry_cycle"));
    if (Source.FolderOwnerNodeId.IsEmpty()) Source.FolderOwnerNodeId = Node.Id;
    if (Source.ActorClassOwnerNodeId.IsEmpty()) Source.ActorClassOwnerNodeId = Node.Id;
    if (Source.MeshAssetOwnerNodeId.IsEmpty()) Source.MeshAssetOwnerNodeId = Node.Id;
}

bool MatchesFact(const FSource& Source, const FFact& Fact, FString* OwnerNodeId = nullptr)
{
    const FString* Owner = nullptr;
    if (Fact.Kind == TEXT("tag")) Owner = Source.TagOwnerByValue.Find(Fact.Value);
    else if (Fact.Kind == TEXT("folder") && Same(Source.Folder, Fact.Value))
        Owner = &Source.FolderOwnerNodeId;
    else if (Fact.Kind == TEXT("actor_class") && Same(Source.ActorClass, Fact.Value))
        Owner = &Source.ActorClassOwnerNodeId;
    else if (Fact.Kind == TEXT("mesh_asset") && Same(Source.MeshAsset, Fact.Value))
        Owner = &Source.MeshAssetOwnerNodeId;
    if (!Owner) return false;
    if (OwnerNodeId) *OwnerNodeId = *Owner;
    return true;
}

bool MatchesRelation(const FSource& Target, const FSource& Reference,
    const FRequest& Request, FMatch& Match)
{
    if (!Target.BoundsCm.IsValid || !Reference.BoundsCm.IsValid) return false;
    const FBox& A = Target.BoundsCm;
    const FBox& B = Reference.BoundsCm;
    const double Gap = BoundsGap(A, B);
    if (!FMath::IsFinite(Gap)) return false;
    Match.BoundsGapCm = Gap;
    if (Request.RelationKind == TEXT("near_sampled_bounds"))
    {
        if (Gap <= 0.0 || Gap > Request.NearThresholdCm) return false;
        Match.ThresholdCm = Request.NearThresholdCm;
        Match.EvidencePointIds = BoundaryEvidence(Target, &Reference);
        return true;
    }
    if (Request.RelationKind == TEXT("above_sampled_bounds"))
    {
        const double VerticalGap = A.Min.Z - B.Max.Z;
        if (PlanarGap(A, B) > Request.NearThresholdCm ||
            VerticalGap <= 0.0 || VerticalGap < Request.AboveMinimumGapCm ||
            VerticalGap > Request.AboveMaximumGapCm) return false;
        Match.VerticalGapCm = VerticalGap;
        Match.ThresholdCm = Request.AboveMaximumGapCm;
        AddEvidence(Match.EvidencePointIds, Target.MinPointId[2]);
        AddEvidence(Match.EvidencePointIds, Reference.MaxPointId[2]);
        return true;
    }
    if (Request.RelationKind == TEXT("sampled_bounds_contains"))
    {
        if (!StrictlyContains(A, B)) return false;
        Match.EvidencePointIds = BoundaryEvidence(Target, &Reference);
        return true;
    }
    if (Request.RelationKind == TEXT("sampled_bounds_overlap"))
    {
        if (!Overlaps(A, B) || StrictlyContains(A, B) || StrictlyContains(B, A)) return false;
        Match.EvidencePointIds = BoundaryEvidence(Target, &Reference);
        return true;
    }
    return false;
}

TArray<TSharedPtr<FJsonValue>> VectorJson(const FVector& Value)
{
    return {MakeShared<FJsonValueNumber>(Value.X), MakeShared<FJsonValueNumber>(Value.Y),
        MakeShared<FJsonValueNumber>(Value.Z)};
}

TSharedRef<FJsonObject> BoundsJson(const FBox& Bounds)
{
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("valid"), Bounds.IsValid != 0);
    Out->SetArrayField(TEXT("min"), VectorJson(Bounds.IsValid ? Bounds.Min : FVector::ZeroVector));
    Out->SetArrayField(TEXT("max"), VectorJson(Bounds.IsValid ? Bounds.Max : FVector::ZeroVector));
    return Out;
}

TSharedRef<FJsonObject> FactJson(const FFact& Fact)
{
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("kind"), Fact.Kind);
    Out->SetStringField(TEXT("value"), Fact.Value);
    Out->SetStringField(TEXT("provenance"), TEXT("authored_editor_metadata"));
    Out->SetStringField(TEXT("match_mode"), TEXT("exact_case_sensitive"));
    return Out;
}
}

bool ValidateRequest(const FRequest& Request, FString& OutError)
{
    OutError.Reset();
    if (!ValidFactKind(Request.Target.Kind) || Request.Target.Value.IsEmpty() ||
        Request.Target.Value.Len() > 1024)
        OutError = TEXT("invalid_target_fact");
    else if (Request.Reference.IsSet() &&
        (!ValidFactKind(Request.Reference.Kind) || Request.Reference.Value.IsEmpty() ||
            Request.Reference.Value.Len() > 1024))
        OutError = TEXT("invalid_reference_fact");
    else if (Request.ReferenceSourceNodeId.Len() > 2048)
        OutError = TEXT("invalid_reference_source_node_id");
    else if (Request.RelationKind.IsEmpty())
    {
        if (!Request.ReferenceSourceNodeId.IsEmpty() || Request.Reference.IsSet())
            OutError = TEXT("reference_requires_relation");
    }
    else if (!ValidRelationKind(Request.RelationKind))
        OutError = TEXT("invalid_relation_kind");
    else if (Request.ReferenceSourceNodeId.IsEmpty() == Request.Reference.IsSet())
        OutError = TEXT("relation_requires_one_reference");
    if (OutError.IsEmpty() &&
        (!FMath::IsFinite(Request.NearThresholdCm) ||
            Request.NearThresholdCm < 0.0 || Request.NearThresholdCm > 2000.0 ||
            !FMath::IsFinite(Request.AboveMinimumGapCm) ||
            Request.AboveMinimumGapCm < 0.0 || Request.AboveMinimumGapCm > 1000.0 ||
            !FMath::IsFinite(Request.AboveMaximumGapCm) ||
            Request.AboveMaximumGapCm < Request.AboveMinimumGapCm ||
            Request.AboveMaximumGapCm > 5000.0))
        OutError = TEXT("invalid_relation_threshold");
    if (OutError.IsEmpty() && (Request.MaxPairs < 1 ||
        Request.MaxPairs > MaxPairEvaluations || Request.MaxMatches < 1 ||
        Request.MaxMatches > MaxResultMatches))
        OutError = TEXT("invalid_query_cap");
    return OutError.IsEmpty();
}

FResult Build(const HaybaWorldTileSnapshot::FTile& Tile, const FRequest& Request)
{
    FResult Result;
    Result.CaptureId = Tile.CaptureId;
    Result.TileId = Tile.TileId;
    Result.CapturedAtUtc = Tile.CapturedAtUtc;
    Result.Request = Request;
    Result.bPartial = Tile.bPartial;
    Result.Gaps = Tile.Gaps;
    FString Error;
    if (!ValidateRequest(Request, Error))
    {
        Result.Status = TEXT("invalid_query");
        Result.bPartial = true;
        Result.Gaps.AddUnique(Error);
        return Result;
    }
    if (Tile.PointCount < 0 || Tile.PointCount > MaxInputPoints ||
        Tile.Pages.Num() > MaxInputPages)
    {
        Result.Status = TEXT("query_limit_exceeded");
        MarkPartial(Result, TEXT("query_input_cap"));
        return Result;
    }
    TMap<FString, FSource> SourcesById;
    for (const HaybaWorldTileSnapshot::FPage& Page : Tile.Pages)
    {
        const HaybaWorldGeometry::FSnapshot& Geometry = Page.Geometry;
        for (int32 PointIndex = 0; PointIndex < Geometry.Splats.Num(); ++PointIndex)
        {
            if (Result.ObservedPointCount >= MaxInputPoints)
            {
                Result.Status = TEXT("query_limit_exceeded");
                MarkPartial(Result, TEXT("query_input_cap"));
                return Result;
            }
            ++Result.ObservedPointCount;
            const HaybaWorldGeometry::FSplat& Point = Geometry.Splats[PointIndex];
            if (!Geometry.Nodes.IsValidIndex(Point.NodeIndex))
            {
                MarkPartial(Result, TEXT("source_node_index_missing"));
                continue;
            }
            const HaybaWorldGeometry::FNode& Node = Geometry.Nodes[Point.NodeIndex];
            const FVector Position = Point.PositionCm + Geometry.OriginCm;
            if (Node.Id.IsEmpty() || Position.ContainsNaN() ||
                !FMath::IsFinite(Position.X) || !FMath::IsFinite(Position.Y) ||
                !FMath::IsFinite(Position.Z))
            {
                MarkPartial(Result, TEXT("source_geometry_invalid"));
                continue;
            }
            FSource* Source = SourcesById.Find(Node.Id);
            if (!Source)
            {
                FSource NewSource;
                ReadSourceMetadata(Geometry, Point.NodeIndex, NewSource, Result);
                Source = &SourcesById.Add(Node.Id, MoveTemp(NewSource));
            }
            else if (!Same(Source->ActorPath,
                Geometry.Actors.IsValidIndex(Node.ActorIndex)
                    ? Geometry.Actors[Node.ActorIndex].Path : FString()) ||
                !Same(Source->MeshAsset, Node.MeshAsset))
                MarkPartial(Result, TEXT("source_metadata_conflict"));
            AddPoint(*Source, Position, PointId(Tile, Page.PageId, PointIndex));
        }
    }
    if (Result.ObservedPointCount != Tile.PointCount)
        MarkPartial(Result, TEXT("tile_point_count_mismatch"));
    Result.IndexedSourceCount = SourcesById.Num();
    TArray<const FSource*> Sources;
    Sources.Reserve(SourcesById.Num());
    for (const TPair<FString, FSource>& Entry : SourcesById)
        if (Entry.Value.PointCount > 0 && Entry.Value.BoundsCm.IsValid)
            Sources.Add(&Entry.Value);
    Sources.Sort([](const FSource& A, const FSource& B)
        { return A.NodeId < B.NodeId; });
    TArray<const FSource*> Targets;
    TArray<const FSource*> References;
    for (const FSource* Source : Sources)
    {
        if (MatchesFact(*Source, Request.Target)) Targets.Add(Source);
        if (!Request.RelationKind.IsEmpty())
        {
            if (!Request.ReferenceSourceNodeId.IsEmpty()
                ? Same(Source->NodeId, Request.ReferenceSourceNodeId)
                : MatchesFact(*Source, Request.Reference))
                References.Add(Source);
        }
    }
    Result.MatchingTargetCount = Targets.Num();
    Result.MatchingReferenceCount = References.Num();
    if (!Request.RelationKind.IsEmpty() && References.IsEmpty() &&
        !Request.ReferenceSourceNodeId.IsEmpty())
        MarkPartial(Result, TEXT("reference_source_not_observed"));
    for (const FSource* Target : Targets)
    {
        FString FactOwner;
        MatchesFact(*Target, Request.Target, &FactOwner);
        auto BaseMatch = [Target, &FactOwner]()
        {
            FMatch Match;
            Match.SourceNodeId = Target->NodeId;
            Match.SourceKind = Target->Kind;
            Match.ActorPath = Target->ActorPath;
            Match.ComponentNodeId = Target->ComponentNodeId;
            Match.InstanceIndex = Target->InstanceIndex;
            Match.GeometryStatus = Target->GeometryStatus;
            Match.MatchedFactOwnerNodeId = FactOwner;
            Match.SampledPointCount = Target->PointCount;
            Match.SampledBoundsCm = Target->BoundsCm;
            return Match;
        };
        if (Request.RelationKind.IsEmpty())
        {
            if (Result.Matches.Num() >= Request.MaxMatches)
            {
                MarkPartial(Result, TEXT("match_cap"));
                break;
            }
            FMatch Match = BaseMatch();
            Match.EvidencePointIds = BoundaryEvidence(*Target);
            Result.Matches.Add(MoveTemp(Match));
            continue;
        }
        for (const FSource* Reference : References)
        {
            if (Same(Target->NodeId, Reference->NodeId)) continue;
            if (Result.EvaluatedPairCount >= Request.MaxPairs)
            {
                MarkPartial(Result, TEXT("pair_cap"));
                Result.Status = TEXT("partial");
                return Result;
            }
            ++Result.EvaluatedPairCount;
            FMatch Match = BaseMatch();
            if (!MatchesRelation(*Target, *Reference, Request, Match)) continue;
            if (Result.Matches.Num() >= Request.MaxMatches)
            {
                MarkPartial(Result, TEXT("match_cap"));
                Result.Status = TEXT("partial");
                return Result;
            }
            Match.ReferenceSourceNodeId = Reference->NodeId;
            Match.ReferenceActorPath = Reference->ActorPath;
            Result.Matches.Add(MoveTemp(Match));
        }
    }
    Result.Status = Result.bPartial ? TEXT("partial") : TEXT("captured");
    return Result;
}

TSharedRef<FJsonObject> BuildPage(const FResult& Result, int32 Offset, int32 Limit)
{
    const int32 Start = FMath::Clamp(Offset, 0, Result.Matches.Num());
    const int32 Count = FMath::Clamp(Limit, 1, MaxPageRows);
    const int32 End = FMath::Min(Start + Count, Result.Matches.Num());
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("source"), TEXT("captured_mesh_tile_query"));
    Out->SetStringField(TEXT("status"), Result.Status);
    Out->SetStringField(TEXT("freshness"), TEXT("captured_observation"));
    Out->SetStringField(TEXT("capture_id"), Result.CaptureId);
    Out->SetStringField(TEXT("tile_id"), Result.TileId);
    Out->SetStringField(TEXT("captured_at_utc"), Result.CapturedAtUtc);
    Out->SetStringField(TEXT("relation_kind"), Result.Request.RelationKind);
    Out->SetObjectField(TEXT("target_fact"), FactJson(Result.Request.Target));
    Out->SetStringField(TEXT("reference_source_node_id"), Result.Request.ReferenceSourceNodeId);
    if (Result.Request.Reference.IsSet())
        Out->SetObjectField(TEXT("reference_fact"), FactJson(Result.Request.Reference));
    Out->SetStringField(TEXT("relation_scope"), TEXT("candidates_from_sampled_axis_aligned_bounds"));
    Out->SetStringField(TEXT("evidence_role"), TEXT("sampled_bounds_extrema_not_surface_distance_witnesses"));
    Out->SetBoolField(TEXT("absence_proven"), false);
    Out->SetBoolField(TEXT("whole_world_coverage"), false);
    Out->SetNumberField(TEXT("near_threshold_cm"), Result.Request.NearThresholdCm);
    Out->SetNumberField(TEXT("above_minimum_gap_cm"), Result.Request.AboveMinimumGapCm);
    Out->SetNumberField(TEXT("above_maximum_gap_cm"), Result.Request.AboveMaximumGapCm);
    Out->SetNumberField(TEXT("observed_point_count"), Result.ObservedPointCount);
    Out->SetNumberField(TEXT("indexed_source_count"), Result.IndexedSourceCount);
    Out->SetNumberField(TEXT("matching_target_count"), Result.MatchingTargetCount);
    Out->SetNumberField(TEXT("matching_reference_count"), Result.MatchingReferenceCount);
    Out->SetNumberField(TEXT("evaluated_pair_count"), Result.EvaluatedPairCount);
    Out->SetNumberField(TEXT("max_pairs"), Result.Request.MaxPairs);
    Out->SetNumberField(TEXT("max_matches"), Result.Request.MaxMatches);
    Out->SetNumberField(TEXT("total_matches"), Result.Matches.Num());
    Out->SetNumberField(TEXT("offset"), Start);
    Out->SetNumberField(TEXT("limit"), Count);
    if (End < Result.Matches.Num()) Out->SetNumberField(TEXT("next_offset"), End);
    TArray<TSharedPtr<FJsonValue>> Gaps;
    for (const FString& Gap : Result.Gaps)
        Gaps.Add(MakeShared<FJsonValueString>(Gap));
    Out->SetArrayField(TEXT("gaps"), MoveTemp(Gaps));
    TArray<TSharedPtr<FJsonValue>> Items;
    Items.Reserve(End - Start);
    for (int32 Index = Start; Index < End; ++Index)
    {
        const FMatch& Match = Result.Matches[Index];
        TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("source_node_id"), Match.SourceNodeId);
        Item->SetStringField(TEXT("source_kind"), Match.SourceKind);
        Item->SetStringField(TEXT("actor_path"), Match.ActorPath);
        Item->SetStringField(TEXT("component_node_id"), Match.ComponentNodeId);
        Item->SetNumberField(TEXT("instance_index"), Match.InstanceIndex);
        Item->SetStringField(TEXT("geometry_status"), Match.GeometryStatus);
        Item->SetStringField(TEXT("matched_fact_owner_node_id"), Match.MatchedFactOwnerNodeId);
        Item->SetStringField(TEXT("matched_fact_provenance"), TEXT("authored_editor_metadata"));
        Item->SetNumberField(TEXT("sampled_point_count"), Match.SampledPointCount);
        Item->SetObjectField(TEXT("sampled_bounds_cm"), BoundsJson(Match.SampledBoundsCm));
        Item->SetStringField(TEXT("reference_source_node_id"), Match.ReferenceSourceNodeId);
        Item->SetStringField(TEXT("reference_actor_path"), Match.ReferenceActorPath);
        Item->SetStringField(TEXT("relation_status"),
            Result.Request.RelationKind.IsEmpty()
                ? TEXT("source_match") : TEXT("candidate_from_sampled_bounds"));
        Item->SetNumberField(TEXT("bounds_gap_cm"), Match.BoundsGapCm);
        Item->SetNumberField(TEXT("vertical_gap_cm"), Match.VerticalGapCm);
        Item->SetNumberField(TEXT("threshold_cm"), Match.ThresholdCm);
        TArray<TSharedPtr<FJsonValue>> Evidence;
        for (const FString& Id : Match.EvidencePointIds)
            Evidence.Add(MakeShared<FJsonValueString>(Id));
        Item->SetArrayField(TEXT("evidence_point_ids"), MoveTemp(Evidence));
        Items.Add(MakeShared<FJsonValueObject>(Item));
    }
    Out->SetArrayField(TEXT("items"), MoveTemp(Items));
    return Out;
}
}
