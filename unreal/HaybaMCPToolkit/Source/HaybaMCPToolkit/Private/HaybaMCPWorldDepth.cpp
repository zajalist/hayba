#include "HaybaMCPWorldDepth.h"

#include "Math/RotationMatrix.h"

HaybaWorldDepth::FProjection HaybaWorldDepth::MakeProjection(const FVector& CameraCm,
    const FRotator& Rotation, double HorizontalFovDegrees)
{
    FProjection Result;
    if (CameraCm.ContainsNaN() || Rotation.ContainsNaN() ||
        !FMath::IsFinite(HorizontalFovDegrees) ||
        HorizontalFovDegrees < 5.0 || HorizontalFovDegrees > 170.0) return Result;
    const FRotationMatrix Basis(Rotation);
    Result.CameraCm = CameraCm;
    Result.Forward = Basis.GetUnitAxis(EAxis::X);
    Result.Right = Basis.GetUnitAxis(EAxis::Y);
    Result.Up = Basis.GetUnitAxis(EAxis::Z);
    Result.TanHalfHorizontal = FMath::Tan(FMath::DegreesToRadians(HorizontalFovDegrees * 0.5));
    Result.TanHalfVertical = Result.TanHalfHorizontal * static_cast<double>(Height) / Width;
    Result.bValid = true;
    return Result;
}

bool HaybaWorldDepth::FProjection::Unproject(int32 X, int32 Y, double DepthCm,
    FVector& OutPointCm) const
{
    if (!bValid || X < 0 || X >= Width || Y < 0 || Y >= Height ||
        !FMath::IsFinite(DepthCm) || DepthCm <= 0.0 || DepthCm > MaxDepthCm) return false;
    const double U = (2.0 * (X + 0.5) / Width - 1.0) * TanHalfHorizontal;
    const double V = (1.0 - 2.0 * (Y + 0.5) / Height) * TanHalfVertical;
    OutPointCm = CameraCm + DepthCm * (Forward + U * Right + V * Up);
    return !OutPointCm.ContainsNaN();
}

bool HaybaWorldDepth::Unproject(int32 X, int32 Y, double DepthCm, const FVector& CameraCm,
    const FRotator& Rotation, double HorizontalFovDegrees, FVector& OutPointCm)
{
    return MakeProjection(CameraCm, Rotation, HorizontalFovDegrees)
        .Unproject(X, Y, DepthCm, OutPointCm);
}

int32 HaybaWorldDepth::PixelAtOrdinal(int32 Ordinal)
{
    if (Ordinal < 0 || Ordinal >= Width * Height) return INDEX_NONE;
    int32 X = 0, Y = 0;
    for (int32 Bit = 0; Bit < RasterBitsPerAxis; ++Bit)
    {
        X |= ((Ordinal >> (2 * Bit)) & 1) << (RasterBitsPerAxis - Bit - 1);
        Y |= ((Ordinal >> (2 * Bit + 1)) & 1) << (RasterBitsPerAxis - Bit - 1);
    }
    return Y * Width + X;
}

bool HaybaWorldDepth::TraceMatchesDepth(double DepthCm, double RasterRayDistanceCm,
    double TraceDistanceCm)
{
    if (!FMath::IsFinite(DepthCm) || DepthCm <= 0.0 ||
        !FMath::IsFinite(RasterRayDistanceCm) || !FMath::IsFinite(TraceDistanceCm) ||
        RasterRayDistanceCm <= 0.0 || TraceDistanceCm <= 0.0) return false;
    const double ToleranceCm = FMath::Clamp(DepthCm * 0.001, 2.0, MaxAttributionErrorCm);
    return FMath::Abs(RasterRayDistanceCm - TraceDistanceCm) <= ToleranceCm;
}
