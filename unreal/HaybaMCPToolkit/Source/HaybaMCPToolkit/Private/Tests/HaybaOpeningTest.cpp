#include "Misc/AutomationTest.h"
#include "pcg/HaybaOpening.h"
#include "DynamicMesh/DynamicMesh3.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaOpeningUnitTest,
    "Hayba.Socket.Opening",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaOpeningUnitTest::RunTest(const FString& Parameters)
{
    using namespace UE::Geometry;

    // Build a 600cm-wide x 400cm-tall wall as 12x8 quads (= 192 triangles).
    FDynamicMesh3 Wall;
    HaybaOpening::AppendWallGrid(Wall, /*HalfWidth=*/300.0, /*Height=*/400.0, /*Cols=*/12, /*Rows=*/8);
    const int32 Before = Wall.TriangleCount();
    TestEqual(TEXT("wall has 192 tris"), Before, 192);

    // Punch a 120x200 doorway centered laterally, at the floor, identity bond xf.
    const int32 Removed = HaybaOpening::PunchDoorway(Wall, FTransform::Identity,
        /*Width=*/120.0, /*Height=*/200.0, /*Depth=*/50.0);
    TestTrue(TEXT("some triangles removed"), Removed > 0);
    TestEqual(TEXT("triangle count dropped by Removed"), Wall.TriangleCount(), Before - Removed);

    // The doorway centre must now be empty: no triangle centroid inside the hole.
    bool bCentreEmpty = true;
    for (const int32 tid : Wall.TriangleIndicesItr())
    {
        const FVector3d C = Wall.GetTriCentroid(tid);
        if (FMath::Abs(C.Y) <= 60.0 && C.Z >= 0.0 && C.Z <= 200.0 && FMath::Abs(C.X) <= 25.0)
        {
            bCentreEmpty = false; break;
        }
    }
    TestTrue(TEXT("doorway interior is empty"), bCentreEmpty);

    // A wall corner (outside the doorway) must survive.
    bool bCornerSurvives = false;
    for (const int32 tid : Wall.TriangleIndicesItr())
    {
        const FVector3d C = Wall.GetTriCentroid(tid);
        if (C.Y > 200.0 && C.Z > 300.0) { bCornerSurvives = true; break; }
    }
    TestTrue(TEXT("far corner survives"), bCornerSurvives);

    return true;
}
