#include "HaybaMCPViewDepthSnapshot.h"

#include "HaybaMCPWorldDepth.h"
#include "Engine/World.h"

namespace
{
TSharedPtr<const HaybaViewDepthSnapshot::FSnapshot> PublishedSnapshot;

TArray<TSharedPtr<FJsonValue>> VectorJson(const FVector& Value)
{
    return { MakeShared<FJsonValueNumber>(Value.X), MakeShared<FJsonValueNumber>(Value.Y),
        MakeShared<FJsonValueNumber>(Value.Z) };
}

TSharedRef<FJsonObject> BoundsJson(const FBox& Bounds)
{
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("min"), VectorJson(Bounds.Min));
    Out->SetArrayField(TEXT("max"), VectorJson(Bounds.Max));
    return Out;
}
}

FInt64Vector HaybaViewDepthSnapshot::CellFor(const FVector& PositionCm)
{
    return FInt64Vector(
        FMath::FloorToInt64(PositionCm.X / SpatialCellSizeCm),
        FMath::FloorToInt64(PositionCm.Y / SpatialCellSizeCm),
        FMath::FloorToInt64(PositionCm.Z / SpatialCellSizeCm));
}

FString HaybaViewDepthSnapshot::GroupIdFor(const FInt64Vector& Cell)
{
    return FString::Printf(TEXT("cell:%lld:%lld:%lld"), Cell.X, Cell.Y, Cell.Z);
}

void HaybaViewDepthSnapshot::FSnapshot::AddPoint(FPoint&& Point)
{
    if (Points.Num() >= HaybaWorldDepth::MaxPoints) return;
    Point.SpatialCell = CellFor(Point.PositionCm);
    const int32* Existing = GroupIndexByCell.Find(Point.SpatialCell);
    const int32 GroupIndex = Existing ? *Existing : Groups.AddDefaulted();
    if (!Existing) {
        Groups[GroupIndex].Cell = Point.SpatialCell;
        GroupIndexByCell.Add(Point.SpatialCell, GroupIndex);
    }
    FGroup& Group = Groups[GroupIndex];
    ++Group.PointCount;
    Group.BoundsCm += Point.PositionCm;
    if (!Point.SourceActorPath.IsEmpty()) ++MatchedRayPointCount;
    Points.Add(MoveTemp(Point));
}

TSharedRef<FJsonObject> HaybaViewDepthSnapshot::BuildPage(const FSnapshot& Snapshot,
    const FString& Section, int32 Offset, int32 Limit, const FString& GroupId)
{
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("source"), TEXT("view_depth"));
    Out->SetStringField(TEXT("capture_id"), Snapshot.CaptureId);
    Out->SetStringField(TEXT("captured_at_utc"), Snapshot.CapturedAtUtc);
    Out->SetStringField(TEXT("world_path"), Snapshot.WorldPath);
    Out->SetStringField(TEXT("status"), Snapshot.Status);
    Out->SetStringField(TEXT("section"), Section);
    Out->SetNumberField(TEXT("offset"), Offset);
    Out->SetNumberField(TEXT("limit"), Limit);
    Out->SetBoolField(TEXT("group_ids_capture_local"), true);
    Out->SetNumberField(TEXT("spatial_cell_size_cm"), SpatialCellSizeCm);
    Out->SetStringField(TEXT("spatial_grouping"), TEXT("fixed_world_space_grid"));
    Out->SetBoolField(TEXT("spatial_group_ids_match_world_preview"), false);
    Out->SetNumberField(TEXT("resolution_x"), HaybaWorldDepth::Width);
    Out->SetNumberField(TEXT("resolution_y"), HaybaWorldDepth::Height);
    Out->SetNumberField(TEXT("processed_pixel_count"), Snapshot.ProcessedPixelCount);
    Out->SetNumberField(TEXT("valid_depth_point_count"), Snapshot.Points.Num());
    Out->SetNumberField(TEXT("matched_ray_point_count"), Snapshot.MatchedRayPointCount);
    Out->SetNumberField(TEXT("readback_ms"), Snapshot.ReadbackMs);
    Out->SetBoolField(TEXT("readback_budget_exceeded"), Snapshot.bReadbackBudgetExceeded);
    Out->SetNumberField(TEXT("processing_cpu_ms"), Snapshot.ProcessingCpuMs);
    if (Snapshot.bCameraValid)
    {
        TSharedRef<FJsonObject> Camera = MakeShared<FJsonObject>();
        Camera->SetArrayField(TEXT("position_cm"), VectorJson(Snapshot.CameraCm));
        Camera->SetArrayField(TEXT("rotation_degrees"), {
            MakeShared<FJsonValueNumber>(Snapshot.CameraRotationDegrees.Pitch),
            MakeShared<FJsonValueNumber>(Snapshot.CameraRotationDegrees.Yaw),
            MakeShared<FJsonValueNumber>(Snapshot.CameraRotationDegrees.Roll) });
        Camera->SetNumberField(TEXT("horizontal_fov_degrees"), Snapshot.HorizontalFovDegrees);
        Out->SetObjectField(TEXT("camera"), Camera);
    }
    else Out->SetField(TEXT("camera"), MakeShared<FJsonValueNull>());
    TSharedRef<FJsonObject> Coverage = MakeShared<FJsonObject>();
    Coverage->SetStringField(TEXT("visibility"), TEXT("first_depth_surface_from_one_editor_view"));
    Coverage->SetBoolField(TEXT("loaded_world_only"), true);
    Coverage->SetBoolField(TEXT("occluded_geometry_included"), false);
    Coverage->SetBoolField(TEXT("whole_world_coverage"), false);
    Coverage->SetBoolField(TEXT("partial"), Snapshot.Status != TEXT("complete_visible_subset"));
    Coverage->SetStringField(TEXT("source_attribution"), TEXT("exact_pixel_depth_matched_physics_ray_or_unknown"));
    Out->SetObjectField(TEXT("coverage"), Coverage);
    TArray<TSharedPtr<FJsonValue>> Gaps;
    for (const FString& Gap : Snapshot.Gaps) Gaps.Add(MakeShared<FJsonValueString>(Gap));
    Out->SetArrayField(TEXT("gaps"), MoveTemp(Gaps));
    TSharedRef<FJsonObject> Totals = MakeShared<FJsonObject>();
    Totals->SetNumberField(TEXT("groups"), Snapshot.Groups.Num());
    Totals->SetNumberField(TEXT("points"), Snapshot.Points.Num());
    Out->SetObjectField(TEXT("totals"), Totals);

    TArray<TSharedPtr<FJsonValue>> Items;
    Items.Reserve(Limit);
    int32 TotalItems = 0;
    if (Section == TEXT("groups"))
    {
        TotalItems = Snapshot.Groups.Num();
        for (int32 Index = Offset; Index < FMath::Min(Offset + Limit, TotalItems); ++Index)
        {
            const FGroup& Group = Snapshot.Groups[Index];
            TSharedRef<FJsonObject> Row = MakeShared<FJsonObject>();
            Row->SetStringField(TEXT("id"), GroupIdFor(Group.Cell));
            Row->SetStringField(TEXT("kind"), TEXT("derived_spatial_cell"));
            Row->SetNumberField(TEXT("point_count"), Group.PointCount);
            Row->SetObjectField(TEXT("bounds_cm"), BoundsJson(Group.BoundsCm));
            Items.Add(MakeShared<FJsonValueObject>(Row));
        }
    }
    else if (Section == TEXT("points"))
    {
        if (!GroupId.IsEmpty()) Out->SetStringField(TEXT("group_id"), GroupId);
        for (const FPoint& Point : Snapshot.Points)
        {
            if (!GroupId.IsEmpty() && GroupIdFor(Point.SpatialCell) != GroupId) continue;
            if (TotalItems >= Offset && Items.Num() < Limit)
            {
                TSharedRef<FJsonObject> Row = MakeShared<FJsonObject>();
                Row->SetArrayField(TEXT("position_cm"), VectorJson(Point.PositionCm));
                Row->SetArrayField(TEXT("pixel"), { MakeShared<FJsonValueNumber>(Point.PixelX),
                    MakeShared<FJsonValueNumber>(Point.PixelY) });
                Row->SetNumberField(TEXT("depth_cm"), Point.DepthCm);
                Row->SetStringField(TEXT("spatial_group_id"), GroupIdFor(Point.SpatialCell));
                const bool bMatched = !Point.SourceActorPath.IsEmpty();
                Row->SetStringField(TEXT("source_attribution"), bMatched ? TEXT("depth_matched_physics_ray") : TEXT("unknown"));
                if (bMatched)
                {
                    Row->SetStringField(TEXT("source_actor_path"), Point.SourceActorPath);
                    Row->SetStringField(TEXT("source_actor_label"), Point.SourceActorLabel);
                }
                Items.Add(MakeShared<FJsonValueObject>(Row));
            }
            ++TotalItems;
        }
    }
    Out->SetNumberField(TEXT("total_items"), TotalItems);
    if (Offset + Items.Num() < TotalItems) Out->SetNumberField(TEXT("next_offset"), Offset + Items.Num());
    else Out->SetField(TEXT("next_offset"), MakeShared<FJsonValueNull>());
    Out->SetArrayField(TEXT("items"), MoveTemp(Items));
    return Out;
}

TSharedRef<FJsonObject> HaybaViewDepthSnapshot::BuildNotCaptured()
{
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("source"), TEXT("view_depth"));
    Out->SetStringField(TEXT("status"), TEXT("not_captured"));
    Out->SetField(TEXT("capture_id"), MakeShared<FJsonValueNull>());
    Out->SetField(TEXT("camera"), MakeShared<FJsonValueNull>());
    Out->SetField(TEXT("coverage"), MakeShared<FJsonValueNull>());
    Out->SetArrayField(TEXT("gaps"), { MakeShared<FJsonValueString>(TEXT("no_observed_view_depth_capture")) });
    TSharedRef<FJsonObject> Totals = MakeShared<FJsonObject>();
    Totals->SetNumberField(TEXT("groups"), 0);
    Totals->SetNumberField(TEXT("points"), 0);
    Out->SetObjectField(TEXT("totals"), Totals);
    Out->SetNumberField(TEXT("total_items"), 0);
    Out->SetField(TEXT("next_offset"), MakeShared<FJsonValueNull>());
    Out->SetArrayField(TEXT("items"), {});
    return Out;
}

void HaybaViewDepthSnapshot::Publish(FSnapshot&& Snapshot)
{
    check(IsInGameThread());
    PublishedSnapshot = MakeShared<FSnapshot>(MoveTemp(Snapshot));
}

TSharedPtr<const HaybaViewDepthSnapshot::FSnapshot> HaybaViewDepthSnapshot::GetForWorld(const UWorld* World)
{
    check(IsInGameThread());
    return IsValid(World) && PublishedSnapshot.IsValid() && PublishedSnapshot->World.Get() == World
        ? PublishedSnapshot : nullptr;
}

void HaybaViewDepthSnapshot::Invalidate()
{
    check(IsInGameThread());
    PublishedSnapshot.Reset();
}
