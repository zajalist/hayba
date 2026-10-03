#include "HaybaMCPWorldTileSnapshot.h"

#include "Dom/JsonValue.h"
#include "Engine/World.h"

namespace
{
constexpr int32 MaxResidentCaptures = 32;
constexpr int32 MaxQueryRows = 256;
constexpr int32 MaxSemanticGroups = 256;
constexpr int32 MaxSourceNodeIdsPerGroup = 16;
TMap<FString, TSharedPtr<const HaybaWorldTileSnapshot::FTile>> CapturesById;
TMap<FString, FString> LatestCaptureIdByTile;
TArray<FString> CapturePublishOrder;

bool Matches(const HaybaWorldTileSnapshot::FTile& Capture,
    const UWorld* World, const FString& TileId)
{
    return IsValid(World) && Capture.TileId == TileId && Capture.World.Get() == World &&
        Capture.OriginCm.Equals(FVector(World->OriginLocation), 0.0);
}

void RefreshLatestForTile(const FString& TileId)
{
    LatestCaptureIdByTile.Remove(TileId);
    for (int32 Index = CapturePublishOrder.Num() - 1; Index >= 0; --Index)
    {
        const FString& CandidateId = CapturePublishOrder[Index];
        const TSharedPtr<const HaybaWorldTileSnapshot::FTile>* Candidate = CapturesById.Find(CandidateId);
        if (Candidate && Candidate->IsValid() && (*Candidate)->TileId == TileId)
        {
            LatestCaptureIdByTile.Add(TileId, CandidateId);
            return;
        }
    }
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

struct FSourceAggregate
{
    int32 PointCount = 0;
    FBox BoundsCm = FBox(EForceInit::ForceInit);
};

void BuildSemanticIndex(HaybaWorldTileSnapshot::FTile& Tile)
{
    TMap<FString, int32> GroupByKey;
    for (const HaybaWorldTileSnapshot::FPage& Page : Tile.Pages)
    {
        const HaybaWorldGeometry::FSnapshot& Geometry = Page.Geometry;
        TMap<int32, FSourceAggregate> Sources;
        for (const HaybaWorldGeometry::FSplat& Point : Geometry.Splats)
        {
            if (!Geometry.Nodes.IsValidIndex(Point.NodeIndex)) continue;
            FSourceAggregate& Source = Sources.FindOrAdd(Point.NodeIndex);
            ++Source.PointCount;
            Source.BoundsCm += Point.PositionCm + Geometry.OriginCm;
        }
        for (const TPair<int32, FSourceAggregate>& SourceEntry : Sources)
        {
            const int32 NodeIndex = SourceEntry.Key;
            const HaybaWorldGeometry::FNode& Node = Geometry.Nodes[NodeIndex];
            const FSourceAggregate& Source = SourceEntry.Value;
            if (Node.Id.IsEmpty() || !Source.BoundsCm.IsValid) continue;
            TSet<FString> SeenFacts;
            auto AddFact = [&](const FString& Kind, const FString& Value)
            {
                if (Value.IsEmpty()) return;
                const FString Key = Kind + TEXT("\x1f") + Value;
                if (SeenFacts.Contains(Key)) return;
                SeenFacts.Add(Key);
                int32* Existing = GroupByKey.Find(Key);
                if (!Existing && Tile.SemanticGroups.Num() >= MaxSemanticGroups)
                {
                    Tile.bPartial = true;
                    Tile.Gaps.AddUnique(TEXT("semantic_group_cap"));
                    return;
                }
                const int32 GroupIndex = Existing ? *Existing : Tile.SemanticGroups.AddDefaulted();
                if (!Existing)
                {
                    GroupByKey.Add(Key, GroupIndex);
                    Tile.SemanticGroups[GroupIndex].Kind = Kind;
                    Tile.SemanticGroups[GroupIndex].Value = Value;
                }
                HaybaWorldTileSnapshot::FSemanticGroup& Group = Tile.SemanticGroups[GroupIndex];
                ++Group.SourceCount;
                Group.PointCount += Source.PointCount;
                Group.BoundsCm += Source.BoundsCm.Min;
                Group.BoundsCm += Source.BoundsCm.Max;
                if (Group.SourceNodeIds.Num() < MaxSourceNodeIdsPerGroup)
                    Group.SourceNodeIds.Add(Node.Id);
                else Group.bSourceNodeIdsTruncated = true;
            };
            AddFact(TEXT("folder"), Node.Folder);
            AddFact(TEXT("actor_class"), Node.ActorClass);
            AddFact(TEXT("mesh_asset"), Node.MeshAsset);
            for (int32 At = NodeIndex; Geometry.Nodes.IsValidIndex(At);
                At = Geometry.Nodes[At].ParentIndex)
            {
                if (Geometry.Nodes[At].bTagsTruncated)
                {
                    Tile.bPartial = true;
                    Tile.Gaps.AddUnique(TEXT("authored_tags_truncated"));
                }
                for (const FString& Tag : Geometry.Nodes[At].Tags)
                    AddFact(TEXT("tag"), Tag);
            }
        }
    }
    Tile.SemanticGroups.Sort([](const HaybaWorldTileSnapshot::FSemanticGroup& A,
        const HaybaWorldTileSnapshot::FSemanticGroup& B)
    {
        return A.Kind == B.Kind ? A.Value < B.Value : A.Kind < B.Kind;
    });
}
}

void HaybaWorldTileSnapshot::Publish(FTile&& Tile)
{
    if (Tile.TileId.IsEmpty() || Tile.CaptureId.IsEmpty() || !Tile.World.IsValid() ||
        CapturesById.Contains(Tile.CaptureId)) return;
    const FString CaptureKey = Tile.CaptureId;
    const FString TileKey = Tile.TileId;
    BuildSemanticIndex(Tile);
    CapturesById.Add(CaptureKey, MakeShared<const FTile>(MoveTemp(Tile)));
    CapturePublishOrder.Add(CaptureKey);
    LatestCaptureIdByTile.Add(TileKey, CaptureKey);
    while (CapturePublishOrder.Num() > MaxResidentCaptures)
    {
        const FString EvictedId = CapturePublishOrder[0];
        const TSharedPtr<const FTile>* Evicted = CapturesById.Find(EvictedId);
        const FString EvictedTileId = Evicted && Evicted->IsValid() ? (*Evicted)->TileId : FString();
        CapturesById.Remove(EvictedId);
        CapturePublishOrder.RemoveAt(0);
        if (!EvictedTileId.IsEmpty())
        {
            const FString* Latest = LatestCaptureIdByTile.Find(EvictedTileId);
            if (Latest && *Latest == EvictedId) RefreshLatestForTile(EvictedTileId);
        }
    }
}

TSharedPtr<const HaybaWorldTileSnapshot::FTile> HaybaWorldTileSnapshot::GetForWorld(
    const UWorld* World, const FString& TileId, const FString& CaptureId)
{
    if (!IsValid(World) || TileId.IsEmpty()) return nullptr;
    if (!CaptureId.IsEmpty())
    {
        const TSharedPtr<const FTile> Exact = GetByCaptureIdForWorld(World, CaptureId);
        return Exact.IsValid() && Exact->TileId == TileId ? Exact : nullptr;
    }
    if (const FString* LatestId = LatestCaptureIdByTile.Find(TileId))
    {
        const TSharedPtr<const FTile>* Latest = CapturesById.Find(*LatestId);
        if (Latest && Latest->IsValid() && Matches(**Latest, World, TileId)) return *Latest;
    }
    // Another loaded world may have published a newer capture of this tile.
    // The bounded reverse scan resolves the newest capture for this world.
    for (int32 Index = CapturePublishOrder.Num() - 1; Index >= 0; --Index)
    {
        const TSharedPtr<const FTile>* Candidate = CapturesById.Find(CapturePublishOrder[Index]);
        if (Candidate && Candidate->IsValid() && Matches(**Candidate, World, TileId))
            return *Candidate;
    }
    return nullptr;
}

TSharedPtr<const HaybaWorldTileSnapshot::FTile> HaybaWorldTileSnapshot::GetByCaptureIdForWorld(
    const UWorld* World, const FString& CaptureId)
{
    if (!IsValid(World) || CaptureId.IsEmpty()) return nullptr;
    const TSharedPtr<const FTile>* Exact = CapturesById.Find(CaptureId);
    if (Exact && Exact->IsValid() && Matches(**Exact, World, (*Exact)->TileId)) return *Exact;
    // Public wire IDs accept uppercase or lowercase hexadecimal. The cache
    // is tiny and bounded, so a case-folded fallback is safe.
    for (const TPair<FString, TSharedPtr<const FTile>>& Entry : CapturesById)
        if (Entry.Key.Equals(CaptureId, ESearchCase::IgnoreCase) &&
            Entry.Value.IsValid() && Matches(*Entry.Value, World, Entry.Value->TileId))
            return Entry.Value;
    return nullptr;
}

void HaybaWorldTileSnapshot::Invalidate()
{
    CapturesById.Reset();
    LatestCaptureIdByTile.Reset();
    CapturePublishOrder.Reset();
}

TSharedRef<FJsonObject> HaybaWorldTileSnapshot::BuildNotCaptured(const FString& TileId)
{
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("source"), TEXT("cpu_render_lod_world_tile"));
    Out->SetStringField(TEXT("tile_id"), TileId);
    Out->SetStringField(TEXT("status"), TEXT("not_captured"));
    Out->SetStringField(TEXT("freshness"), TEXT("not_captured"));
    Out->SetBoolField(TEXT("loaded_only"), true);
    Out->SetBoolField(TEXT("whole_world_coverage"), false);
    Out->SetNumberField(TEXT("point_count"), 0);
    Out->SetArrayField(TEXT("gaps"), {MakeShared<FJsonValueString>(TEXT("tile_not_captured"))});
    return Out;
}

TSharedRef<FJsonObject> HaybaWorldTileSnapshot::BuildPage(const FTile& Tile,
    const FString& Section, int32 PageId, int32 Offset, int32 Limit)
{
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("source"), TEXT("cpu_render_lod_world_tile"));
    Out->SetStringField(TEXT("status"), Tile.bPartial ? TEXT("partial") : TEXT("captured"));
    Out->SetStringField(TEXT("freshness"), TEXT("captured_observation"));
    Out->SetBoolField(TEXT("indices_page_local"), true);
    Out->SetStringField(TEXT("tile_id"), Tile.TileId);
    Out->SetStringField(TEXT("capture_id"), Tile.CaptureId);
    Out->SetStringField(TEXT("captured_at_utc"), Tile.CapturedAtUtc);
    Out->SetStringField(TEXT("world_path"), Tile.WorldPath);
    Out->SetNumberField(TEXT("lod"), Tile.LOD);
    Out->SetNumberField(TEXT("point_count"), Tile.PointCount);
    Out->SetNumberField(TEXT("max_resident_captures"), MaxResidentCaptures);
    Out->SetStringField(TEXT("capture_cache_key"), TEXT("capture_id"));
    Out->SetStringField(TEXT("cache_eviction"), TEXT("oldest_published_first"));
    Out->SetNumberField(TEXT("page_count"), Tile.Pages.Num());
    Out->SetNumberField(TEXT("semantic_group_count"), Tile.SemanticGroups.Num());
    Out->SetNumberField(TEXT("scanned_actor_slots"), Tile.ScannedActorSlots);
    Out->SetNumberField(TEXT("eligible_actor_count"), Tile.EligibleActorCount);
    Out->SetBoolField(TEXT("loaded_only"), true);
    Out->SetBoolField(TEXT("whole_world_coverage"), false);
    Out->SetStringField(TEXT("geometry_provenance"), TEXT("cpu_render_lod_triangle_surface_clipped_to_tile"));
    Out->SetStringField(TEXT("semantic_provenance"), TEXT("editor_actor_component_instance_metadata"));
    Out->SetObjectField(TEXT("bounds_cm"), BoundsJson(Tile.BoundsCm));
    Out->SetArrayField(TEXT("origin_cm"), VectorJson(Tile.OriginCm));
    TArray<TSharedPtr<FJsonValue>> Gaps;
    for (const FString& Gap : Tile.Gaps) Gaps.Add(MakeShared<FJsonValueString>(Gap));
    Out->SetArrayField(TEXT("gaps"), MoveTemp(Gaps));
    Out->SetStringField(TEXT("section"), Section);
    if (Section == TEXT("summary")) return Out;
    const int32 Start = FMath::Clamp(Offset, 0, 100000);
    const int32 Count = FMath::Clamp(Limit, 1, MaxQueryRows);
    Out->SetNumberField(TEXT("offset"), Start);
    Out->SetNumberField(TEXT("limit"), Count);
    TArray<TSharedPtr<FJsonValue>> Items;
    if (Section == TEXT("pages"))
    {
        const int32 End = FMath::Min(Start + Count, Tile.Pages.Num());
        for (int32 Index = Start; Index < End; ++Index)
        {
            const FPage& Page = Tile.Pages[Index];
            TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
            Item->SetNumberField(TEXT("page_id"), Page.PageId);
            Item->SetNumberField(TEXT("point_count"), Page.Geometry.Splats.Num());
            Item->SetNumberField(TEXT("actor_count"), Page.Geometry.Actors.Num());
            Item->SetNumberField(TEXT("node_count"), Page.Geometry.Nodes.Num());
            Item->SetObjectField(TEXT("sampled_bounds_cm"), BoundsJson(Page.Geometry.BoundsCm));
            Items.Add(MakeShared<FJsonValueObject>(Item));
        }
        Out->SetArrayField(TEXT("items"), MoveTemp(Items));
        Out->SetNumberField(TEXT("total_items"), Tile.Pages.Num());
        if (End < Tile.Pages.Num()) Out->SetNumberField(TEXT("next_offset"), End);
        return Out;
    }
    if (Section == TEXT("semantic"))
    {
        const int32 End = FMath::Min(Start + Count, Tile.SemanticGroups.Num());
        for (int32 Index = Start; Index < End; ++Index)
        {
            const FSemanticGroup& Group = Tile.SemanticGroups[Index];
            TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("id"), Group.Kind + TEXT(":") + Group.Value);
            Item->SetStringField(TEXT("kind"), Group.Kind);
            Item->SetStringField(TEXT("value"), Group.Value);
            Item->SetStringField(TEXT("provenance"), TEXT("authored_editor_metadata"));
            Item->SetStringField(TEXT("membership"), TEXT("sampled_source_ancestry"));
            Item->SetStringField(TEXT("bounds_provenance"), TEXT("captured_triangle_points"));
            Item->SetNumberField(TEXT("source_count"), Group.SourceCount);
            Item->SetNumberField(TEXT("point_count"), Group.PointCount);
            Item->SetObjectField(TEXT("bounds_cm"), BoundsJson(Group.BoundsCm));
            TArray<TSharedPtr<FJsonValue>> NodeIds;
            for (const FString& NodeId : Group.SourceNodeIds)
                NodeIds.Add(MakeShared<FJsonValueString>(NodeId));
            Item->SetArrayField(TEXT("source_node_ids"), MoveTemp(NodeIds));
            Item->SetBoolField(TEXT("source_node_ids_truncated"), Group.bSourceNodeIdsTruncated);
            Items.Add(MakeShared<FJsonValueObject>(Item));
        }
        Out->SetArrayField(TEXT("items"), MoveTemp(Items));
        Out->SetNumberField(TEXT("total_items"), Tile.SemanticGroups.Num());
        if (End < Tile.SemanticGroups.Num()) Out->SetNumberField(TEXT("next_offset"), End);
        return Out;
    }
    Out->SetNumberField(TEXT("page_id"), PageId);
    const FPage* Page = Tile.Pages.FindByPredicate([PageId](const FPage& Candidate)
        { return Candidate.PageId == PageId; });
    if (!Page)
    {
        Out->SetStringField(TEXT("status"), TEXT("page_not_found"));
        Out->SetArrayField(TEXT("items"), MoveTemp(Items));
        return Out;
    }
    if (Section == TEXT("nodes"))
    {
        const TSharedRef<FJsonObject> Nodes = HaybaWorldGeometry::ToMetadataJson(
            Page->Geometry, false, TEXT("nodes"), Start, Count);
        TArray<TSharedPtr<FJsonValue>> NodeItems = Nodes->GetArrayField(TEXT("nodes"));
        for (int32 Index = 0; Index < NodeItems.Num(); ++Index)
            if (const TSharedPtr<FJsonObject> Node = NodeItems[Index]->AsObject())
                Node->SetNumberField(TEXT("node_index"), Start + Index);
        Out->SetArrayField(TEXT("items"), MoveTemp(NodeItems));
        Out->SetNumberField(TEXT("total_items"), Page->Geometry.Nodes.Num());
        if (Start + Count < Page->Geometry.Nodes.Num())
            Out->SetNumberField(TEXT("next_offset"), Start + Count);
    }
    else if (Section == TEXT("points"))
    {
        const int32 End = FMath::Min(Start + Count, Page->Geometry.Splats.Num());
        for (int32 Index = Start; Index < End; ++Index)
        {
            const HaybaWorldGeometry::FSplat& Point = Page->Geometry.Splats[Index];
            TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("id"), FString::Printf(TEXT("%s/%s/page:%d/point:%d"),
                *Tile.CaptureId, *Tile.TileId, PageId, Index));
            Item->SetNumberField(TEXT("point_index"), Index);
            Item->SetArrayField(TEXT("position_cm"), VectorJson(Point.PositionCm + Page->Geometry.OriginCm));
            Item->SetArrayField(TEXT("normal"), VectorJson(Point.Normal));
            Item->SetNumberField(TEXT("actor_index"), Point.ActorIndex);
            Item->SetNumberField(TEXT("node_index"), Point.NodeIndex);
            if (Page->Geometry.Actors.IsValidIndex(Point.ActorIndex))
                Item->SetStringField(TEXT("actor_path"), Page->Geometry.Actors[Point.ActorIndex].Path);
            if (Page->Geometry.Nodes.IsValidIndex(Point.NodeIndex))
                Item->SetStringField(TEXT("source_node_id"), Page->Geometry.Nodes[Point.NodeIndex].Id);
            Items.Add(MakeShared<FJsonValueObject>(Item));
        }
        Out->SetArrayField(TEXT("items"), MoveTemp(Items));
        Out->SetNumberField(TEXT("total_items"), Page->Geometry.Splats.Num());
        if (End < Page->Geometry.Splats.Num()) Out->SetNumberField(TEXT("next_offset"), End);
    }
    else Out->SetStringField(TEXT("status"), TEXT("invalid_section"));
    return Out;
}
