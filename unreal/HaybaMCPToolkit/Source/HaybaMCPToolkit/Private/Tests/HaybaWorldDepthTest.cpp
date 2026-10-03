#include "Misc/AutomationTest.h"
#include "HaybaMCPWorldDepth.h"
#include "Containers/BitArray.h"
#include <limits>

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldDepthProjectionTest,
    "Hayba.MCP.World.DepthProjection",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorldDepthProjectionTest::RunTest(const FString& Parameters)
{
    FVector Point;
    TestFalse(TEXT("reject background or invalid depth"), HaybaWorldDepth::Unproject(
        128, 128, 0.0, FVector::ZeroVector, FRotator::ZeroRotator, 90.0, Point));
    TestFalse(TEXT("reject distance beyond bounded capture range"), HaybaWorldDepth::Unproject(
        128, 128, HaybaWorldDepth::MaxDepthCm + 1.0, FVector::ZeroVector,
        FRotator::ZeroRotator, 90.0, Point));
    TestFalse(TEXT("reject pixel outside capture"), HaybaWorldDepth::Unproject(
        HaybaWorldDepth::Width, 0, 100.0, FVector::ZeroVector,
        FRotator::ZeroRotator, 90.0, Point));
    const FVector Camera(100.0, 200.0, 300.0);
    TestTrue(TEXT("unproject near center"), HaybaWorldDepth::Unproject(
        128, 128, 1000.0, Camera, FRotator::ZeroRotator, 90.0, Point));
    TestTrue(TEXT("scene depth is forward-axis distance in centimeters"),
        FMath::IsNearlyEqual(Point.X, 1100.0, 0.001));
    TestTrue(TEXT("center pixel remains near view axis"),
        FMath::Abs(Point.Y - Camera.Y) < 6.0 && FMath::Abs(Point.Z - Camera.Z) < 6.0);
    TestTrue(TEXT("unproject rightmost pixel"), HaybaWorldDepth::Unproject(
        255, 128, 1000.0, Camera, FRotator::ZeroRotator, 90.0, Point));
    TestTrue(TEXT("rightmost pixel moves along camera right"), Point.Y > Camera.Y + 900.0);
    const HaybaWorldDepth::FProjection Projection = HaybaWorldDepth::MakeProjection(
        Camera, FRotator(15.0, 35.0, 0.0), 72.0);
    FVector ReusedPoint, OneOffPoint;
    TestTrue(TEXT("reusable projection unprojects a valid depth pixel"),
        Projection.Unproject(37, 191, 2345.0, ReusedPoint));
    TestTrue(TEXT("one-off projection unprojects the same pixel"),
        HaybaWorldDepth::Unproject(37, 191, 2345.0, Camera,
            FRotator(15.0, 35.0, 0.0), 72.0, OneOffPoint));
    TestTrue(TEXT("reusing camera basis preserves projection"),
        ReusedPoint.Equals(OneOffPoint, 0.001));
    TestFalse(TEXT("reusable projection rejects invalid depth"),
        Projection.Unproject(37, 191, 0.0, ReusedPoint));
    const double NaN = std::numeric_limits<double>::quiet_NaN();
    TestFalse(TEXT("invalid camera position is rejected before capture"),
        HaybaWorldDepth::MakeProjection(FVector(NaN, 0.0, 0.0), FRotator::ZeroRotator, 90.0).bValid);
    TestFalse(TEXT("invalid field of view is rejected before capture"),
        HaybaWorldDepth::MakeProjection(Camera, FRotator::ZeroRotator, NaN).bValid);
    TestTrue(TEXT("near-coplanar trace may verify its own pixel"),
        HaybaWorldDepth::TraceMatchesDepth(100000.0, 100000.0, 100015.0));
    TestFalse(TEXT("a distant collision surface cannot label a one-kilometer depth pixel"),
        HaybaWorldDepth::TraceMatchesDepth(100000.0, 100000.0, 100100.0));
    TestFalse(TEXT("invalid trace distance is never evidence"),
        HaybaWorldDepth::TraceMatchesDepth(1000.0, 1000.0, NaN));
    // Two adjacent coplanar meshes can fall in one 16x16 depth cell. Only
    // the actual ray pixel may inherit the hit actor's identity.
    TestTrue(TEXT("anchor pixel can carry a ray-verified source"),
        HaybaWorldDepth::IsRayVerifiedPixel(8, 8));
    TestFalse(TEXT("adjacent same-depth pixel cannot inherit that source"),
        HaybaWorldDepth::IsRayVerifiedPixel(9, 8));
    TestFalse(TEXT("nearby cell-edge pixel cannot inherit that source"),
        HaybaWorldDepth::IsRayVerifiedPixel(15, 8));
    TestTrue(TEXT("next cell has its own independent ray pixel"),
        HaybaWorldDepth::IsRayVerifiedPixel(24, 8));
    TestEqual(TEXT("one capture pixel can become one observed depth point"),
        HaybaWorldDepth::MaxPoints, HaybaWorldDepth::Width * HaybaWorldDepth::Height);
    TestEqual(TEXT("native and browser combined point budget"),
        HaybaWorldDepth::TotalPointBudget, 163840);
    const int32 Quarter = HaybaWorldDepth::Width / 2;
    TestEqual(TEXT("first pixel starts first image quadrant"),
        HaybaWorldDepth::PixelAtOrdinal(0), 0);
    TestEqual(TEXT("second pixel reaches the next horizontal quadrant"),
        HaybaWorldDepth::PixelAtOrdinal(1), Quarter);
    TestEqual(TEXT("third pixel reaches the next vertical quadrant"),
        HaybaWorldDepth::PixelAtOrdinal(2), Quarter * HaybaWorldDepth::Width);
    TestEqual(TEXT("fourth pixel reaches the opposite quadrant"),
        HaybaWorldDepth::PixelAtOrdinal(3), Quarter * HaybaWorldDepth::Width + Quarter);
    TestEqual(TEXT("negative ordinal is rejected"), HaybaWorldDepth::PixelAtOrdinal(-1), INDEX_NONE);
    TestEqual(TEXT("out-of-range ordinal is rejected"),
        HaybaWorldDepth::PixelAtOrdinal(HaybaWorldDepth::MaxPoints), INDEX_NONE);
    TBitArray<> Seen(false, HaybaWorldDepth::MaxPoints);
    bool bUnique = true;
    for (int32 Ordinal = 0; Ordinal < HaybaWorldDepth::MaxPoints; ++Ordinal)
    {
        const int32 Pixel = HaybaWorldDepth::PixelAtOrdinal(Ordinal);
        if (Pixel < 0 || Pixel >= Seen.Num() || Seen[Pixel]) { bUnique = false; break; }
        Seen[Pixel] = true;
    }
    TestTrue(TEXT("coarse-to-fine traversal covers every raster pixel once"), bUnique);
    return true;
}
#endif
