#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class UWorld;

/** An observed editor-view depth capture. Grouping is derived from positions,
 * never from guessed render, mesh, tag, or actor identity. */
namespace HaybaViewDepthSnapshot
{
constexpr int32 SpatialCellSizeCm = 2000;

struct FPoint
{
    FVector PositionCm = FVector::ZeroVector;
    FInt64Vector SpatialCell = FInt64Vector::ZeroValue;
    int32 PixelX = 0;
    int32 PixelY = 0;
    double DepthCm = 0.0;
    FColor DisplayColor = FColor::Black;
    bool bColorObserved = false;
    // Set only on the exact pixel checked by a depth-matched physics ray.
    FString SourceActorPath;
    FString SourceActorLabel;
};

struct FGroup
{
    FInt64Vector Cell = FInt64Vector::ZeroValue;
    int32 PointCount = 0;
    FBox BoundsCm = FBox(ForceInit);
};

struct FSnapshot
{
    FString CaptureId;
    FString WorldPath;
    FString CapturedAtUtc;
    TWeakObjectPtr<UWorld> World;
    FVector CameraCm = FVector::ZeroVector;
    FRotator CameraRotationDegrees = FRotator::ZeroRotator;
    double HorizontalFovDegrees = 0.0;
    bool bCameraValid = false;
    FString Status = TEXT("not_captured");
    TArray<FString> Gaps;
    int32 ProcessedPixelCount = 0;
    int32 MatchedRayPointCount = 0;
    double ReadbackMs = 0.0;
    double ReadbackWaitMs = 0.0;
    double ReadbackGameThreadMaxMs = 0.0;
    bool bReadbackBudgetExceeded = false;
    double ProcessingCpuMs = 0.0;
    TArray<FPoint> Points;
    TArray<FGroup> Groups;

    void AddPoint(FPoint&& Point);

private:
    TMap<FInt64Vector, int32> GroupIndexByCell;
};

FInt64Vector CellFor(const FVector& PositionCm);
FString GroupIdFor(const FInt64Vector& Cell);
TSharedRef<FJsonObject> BuildPage(const FSnapshot& Snapshot, const FString& Section,
    int32 Offset, int32 Limit, const FString& GroupId);
TSharedRef<FJsonObject> BuildNotCaptured();

/** Called only on the editor game thread. Publication freezes a complete or
 * explicitly partial observation; pagination never touches the GPU. */
void Publish(FSnapshot&& Snapshot);
TSharedPtr<const FSnapshot> GetForWorld(const UWorld* World);
void Invalidate();
}
