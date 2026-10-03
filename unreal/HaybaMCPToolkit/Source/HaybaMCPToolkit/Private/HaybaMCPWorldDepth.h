#pragma once

#include "CoreMinimal.h"

namespace HaybaWorldDepth
{
constexpr int32 Width = 256;
constexpr int32 Height = 256;
constexpr int32 MaxPoints = Width * Height;
constexpr int32 MeshPointBudget = 98304;
constexpr int32 TotalPointBudget = MeshPointBudget + MaxPoints;
// An explicit scan may use up to 1.5 s total CPU, spread over short editor ticks.
constexpr int32 MaxProcessingCpuMs = 1500;
constexpr int32 PointsPerTick = 128;
constexpr double ReadbackWarningMs = 50.0;
constexpr int32 RasterBitsPerAxis = 8;
constexpr int32 AttributionCellSize = 16;
constexpr int32 MaxPhysicsRays = (Width / AttributionCellSize) * (Height / AttributionCellSize);
static_assert(Width % AttributionCellSize == 0 && Height % AttributionCellSize == 0);
static_assert(Width == (1 << RasterBitsPerAxis) && Height == Width);
constexpr double MaxDepthCm = 1000000.0;
constexpr double MaxAttributionErrorCm = 20.0;

// Each physics ray checks exactly one raster pixel. Depth similarity within a
// cell is geometric evidence, never proof that its other pixels share an actor.
constexpr bool IsRayVerifiedPixel(int32 X, int32 Y)
{
    return X % AttributionCellSize == AttributionCellSize / 2 &&
        Y % AttributionCellSize == AttributionCellSize / 2;
}

struct FProjection
{
    FVector CameraCm = FVector::ZeroVector;
    FVector Forward = FVector::ZeroVector;
    FVector Right = FVector::ZeroVector;
    FVector Up = FVector::ZeroVector;
    double TanHalfHorizontal = 0.0;
    double TanHalfVertical = 0.0;
    bool bValid = false;

    /** SceneDepth is linear distance along the capture's forward axis, in cm. */
    bool Unproject(int32 X, int32 Y, double DepthCm, FVector& OutPointCm) const;
};

FProjection MakeProjection(const FVector& CameraCm, const FRotator& Rotation,
    double HorizontalFovDegrees);

/** Convenience for one-off queries; batch scans should reuse FProjection. */
bool Unproject(int32 X, int32 Y, double DepthCm, const FVector& CameraCm,
    const FRotator& Rotation, double HorizontalFovDegrees, FVector& OutPointCm);

/** A coarse-to-fine permutation of the raster: every prefix spreads over the view. */
int32 PixelAtOrdinal(int32 Ordinal);

/** Collision is corroborating evidence only; large depth mismatches stay unknown. */
bool TraceMatchesDepth(double DepthCm, double RasterRayDistanceCm,
    double TraceDistanceCm);
}
