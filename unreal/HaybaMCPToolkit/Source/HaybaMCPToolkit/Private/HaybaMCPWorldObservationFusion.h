#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPWorldDepth.h"

class UWorld;

// Bounded, world-space observations from explicit editor-view depth captures.
// These are not CPU mesh samples. Sparse-ray identity is retained only for
// the exact verified pixel and the geometry generation that assigned indices.
namespace HaybaWorldObservationFusion
{
constexpr int32 MaxResidentPoints = 2000000;
constexpr double VoxelSizeCm = 5.0;
uint32 SceneFingerprint(UWorld* World);

struct FPoint
{
    FVector PositionCm = FVector::ZeroVector;
    FVector Normal = FVector::UpVector; // view-facing estimate, not a mesh normal
    FColor Color = FColor::Black;
    HaybaWorldDepth::EColorSource ColorSource = HaybaWorldDepth::EColorSource::Unobserved;
    uint32 CaptureOrdinal = 0;
    int32 VerifiedActorIndex = INDEX_NONE;
    int32 VerifiedNodeIndex = INDEX_NONE;
    int32 AttributionGeneration = 0;
};

struct FCapture
{
    FString Id;
    FString CapturedAtUtc;
    FVector CameraCm = FVector::ZeroVector;
    FRotator Rotation = FRotator::ZeroRotator;
    int32 ResidentPoints = 0;
};

class FStore
{
public:
    explicit FStore(int32 InResidentLimit = 0);
    static int32 RecommendedResidentLimit();
    void BindWorld(UWorld* World, const FVector& OriginCm);
    bool Matches(const UWorld* World, const FVector& OriginCm) const;
    void Reset();
    uint32 BeginCapture(const FString& Id, const FString& CapturedAtUtc,
        const FVector& CameraCm, const FRotator& Rotation);
    void PruneEmptyCaptures();
    bool Add(uint32 CaptureOrdinal, const FVector& PositionCm, const FVector& Normal,
        const FColor& Color, HaybaWorldDepth::EColorSource ColorSource,
        int32 VerifiedActorIndex = INDEX_NONE, int32 VerifiedNodeIndex = INDEX_NONE,
        int32 AttributionGeneration = 0);
    int32 Num() const { return Points.Num(); }
    int32 Limit() const { return ResidentLimit; }
    int32 CaptureCount() const { return Captures.Num(); }
    int64 DuplicateCount() const { return Duplicates; }
    int64 EvictionCount() const { return Evictions; }
    uint64 AllocatedBytes() const;
    static int32 PointSizeBytes() { return sizeof(FPoint); }
    const FPoint& PointAt(int32 Index) const { return Points[Index]; }
    const FCapture* CaptureFor(uint32 Ordinal) const { return Captures.Find(Ordinal); }

private:
    static FInt64Vector VoxelFor(const FVector& PositionCm);
    TWeakObjectPtr<UWorld> BoundWorld;
    int32 ResidentLimit = MaxResidentPoints;
    FVector BoundOriginCm = FVector::ZeroVector;
    TArray<FPoint> Points;
    TMap<FInt64Vector, int32> IndexByVoxel;
    TMap<uint32, FCapture> Captures;
    uint32 NextCaptureOrdinal = 1;
    int32 NextEviction = 0;
    int64 Duplicates = 0;
    int64 Evictions = 0;
};
}
