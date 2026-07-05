// Regression fixtures = the exact broken scenes of 2026-07-05 (spec §4.1).
// The audit invariant from the live sessions is the acceptance test:
//   every wall run covered lo..hi, exactly one socket interval per junction, zero gaps/overlaps.
#include "Misc/AutomationTest.h"
#include "pcg/PlumbWallPlanner.h"

namespace
{
    using namespace PlumbWallPlanner;

    FPlumbStructure Room(const TCHAR* Id, const FVector& Min, const FVector& Max, double FloorZ = 0.0)
    {
        FPlumbStructure S;
        S.Id = FName(Id); S.Kind = EPlumbStructureKind::Room; S.bClosed = true; S.FloorZ = FloorZ;
        S.Points = { FVector(Min.X,Min.Y,FloorZ), FVector(Max.X,Min.Y,FloorZ),
                     FVector(Max.X,Max.Y,FloorZ), FVector(Min.X,Max.Y,FloorZ) };
        return S;
    }

    FPlumbStructure Corridor(const TCHAR* Id, std::initializer_list<FVector> Pts, double FloorZ = 0.0)
    {
        FPlumbStructure S;
        S.Id = FName(Id); S.Kind = EPlumbStructureKind::Corridor; S.bClosed = false; S.FloorZ = FloorZ;
        for (const FVector& P : Pts) S.Points.Add(FVector(P.X, P.Y, FloorZ));
        return S;
    }

    // The live-session interval audit, as code: segments + socket widths must tile each run exactly.
    double CoveredLength(const FPlumbWallPlan& Plan)
    {
        double L = 0.0;
        for (const FPlumbSegmentPlan& S : Plan.Segments) L += FVector::Dist2D(S.A, S.B);
        return L;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FPlumbWallPlannerUnitTest,
    "Plumb.WallPlanner",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FPlumbWallPlannerUnitTest::RunTest(const FString& Parameters)
{
    FPlumbPlanParams P; // defaults: opening 150x220, thickness 30, corner 30deg

    // ---- Fixture 1: Demo_RoomB_Plain + Demo_Corridor_L (the "whole north wall became doorframes" bug)
    {
        const FPlumbStructure RoomB = Room(TEXT("RoomB"), FVector(1200,0,0), FVector(1800,600,0));
        const FPlumbStructure CorrL = Corridor(TEXT("CorrL"), { FVector(1500,600,0), FVector(1500,1200,0), FVector(2100,1200,0) });

        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(RoomB, { CorrL }, P);

        TestEqual(TEXT("f1: exactly ONE socket"), Plan.Sockets.Num(), 1);
        if (Plan.Sockets.Num() == 1)
        {
            TestEqual(TEXT("f1: socket on north wall y=600"), Plan.Sockets[0].Center.Y, 600.0, 1.0);
            TestEqual(TEXT("f1: centered on the mouth x=1500"), Plan.Sockets[0].Center.X, 1500.0, 1.0);
            TestTrue (TEXT("f1: room owns"), Plan.Sockets[0].bOwned);
            TestEqual(TEXT("f1: opening is type-sized 150, not span-sized"), Plan.Sockets[0].Width, 150.0, 0.1);
        }
        // audit: perimeter 2400, one 150 opening -> segments cover 2250, no gaps
        TestEqual(TEXT("f1: coverage = perimeter - opening"), CoveredLength(Plan), 2400.0 - 150.0, 0.5);
        TestEqual(TEXT("f1: no rejects"), Plan.Rejects.Num(), 0);
    }

    // ---- Fixture 2: symmetric derivation (Q1) — corridor's own plan lands the identical socket
    {
        const FPlumbStructure RoomB = Room(TEXT("RoomB"), FVector(1200,0,0), FVector(1800,600,0));
        const FPlumbStructure CorrL = Corridor(TEXT("CorrL"), { FVector(1500,600,0), FVector(1500,1200,0), FVector(2100,1200,0) });

        const FPlumbWallPlan RoomPlan = PlumbWallPlanner::Plan(RoomB, { CorrL }, P);
        const FPlumbWallPlan CorrPlan = PlumbWallPlanner::Plan(CorrL, { RoomB }, P);

        TestEqual(TEXT("f2: corridor sees the same single junction"), CorrPlan.Sockets.Num(), 1);
        if (RoomPlan.Sockets.Num() == 1 && CorrPlan.Sockets.Num() == 1)
        {
            TestEqual(TEXT("f2: identical center X"), CorrPlan.Sockets[0].Center.X, RoomPlan.Sockets[0].Center.X, 0.01);
            TestEqual(TEXT("f2: identical center Y"), CorrPlan.Sockets[0].Center.Y, RoomPlan.Sockets[0].Center.Y, 0.01);
            TestEqual(TEXT("f2: identical Z0"),       CorrPlan.Sockets[0].Z0,       RoomPlan.Sockets[0].Z0,       0.01);
            TestTrue (TEXT("f2: corridor does NOT own (yields)"), !CorrPlan.Sockets[0].bOwned);
        }
    }

    // ---- Fixture 3: Demo_RoomA + straight corridor (east-wall junction; the gap/overshoot bug)
    {
        const FPlumbStructure RoomA  = Room(TEXT("RoomA"), FVector(0,0,0), FVector(600,600,0));
        const FPlumbStructure CorrAB = Corridor(TEXT("CorrAB"), { FVector(600,300,0), FVector(1400,300,0) });

        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(RoomA, { CorrAB }, P);
        TestEqual(TEXT("f3: one socket"), Plan.Sockets.Num(), 1);
        if (Plan.Sockets.Num() == 1)
        {
            TestEqual(TEXT("f3: on east wall x=600"), Plan.Sockets[0].Center.X, 600.0, 1.0);
            TestEqual(TEXT("f3: at the mouth y=300"), Plan.Sockets[0].Center.Y, 300.0, 1.0);
        }
        TestEqual(TEXT("f3: coverage"), CoveredLength(Plan), 2400.0 - 150.0, 0.5);
    }

    // ---- Fixture 4: cap coverage (the "caps produce no bays" bug) — corridor alone, no neighbors
    {
        const FPlumbStructure CorrAB = Corridor(TEXT("CorrAB"), { FVector(600,300,0), FVector(1400,300,0) });
        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(CorrAB, {}, P);
        TestEqual(TEXT("f4: open centerline plans its own runs w/o sockets"), Plan.Sockets.Num(), 0);
        TestTrue (TEXT("f4: guaranteed coverage (segments exist)"), CoveredLength(Plan) > 0.0);
    }

    // ---- Fixture 5: split-level Z (Q12) — corridor floor at 60 meets room floor at 0
    // (delta must leave the 220 opening under the 300 shared ceiling: 60+220=280 < 300;
    //  a delta of 90 correctly REJECTS with the ceiling reason — that's fixture 6's territory)
    {
        const FPlumbStructure RoomA  = Room(TEXT("RoomA"), FVector(0,0,0), FVector(600,600,0), /*FloorZ*/0.0);
        const FPlumbStructure CorrHi = Corridor(TEXT("CorrHi"), { FVector(600,300,0), FVector(1400,300,0) }, /*FloorZ*/60.0);

        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(RoomA, { CorrHi }, P);
        TestEqual(TEXT("f5: one socket"), Plan.Sockets.Num(), 1);
        if (Plan.Sockets.Num() == 1)
        {
            TestEqual(TEXT("f5: walk level = max floor = 60"), Plan.Sockets[0].Z0, 60.0, 0.01);
            TestEqual(TEXT("f5: room-side floor delta = 60 (stairs hook)"), Plan.Sockets[0].FloorDeltaSelf, 60.0, 0.01);
        }
    }

    // ---- Fixture 6: ceiling reject (Q12 validation + Q13 reason)
    {
        FPlumbStructure RoomA = Room(TEXT("RoomA"), FVector(0,0,0), FVector(600,600,0));
        FPlumbStructure CorrLo = Corridor(TEXT("CorrLo"), { FVector(600,300,0), FVector(1400,300,0) });
        CorrLo.WallHeight = 150.0; // opening 220 cannot fit under a 150 ceiling

        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(RoomA, { CorrLo }, P);
        TestEqual(TEXT("f6: no socket"), Plan.Sockets.Num(), 0);
        TestEqual(TEXT("f6: one reject"), Plan.Rejects.Num(), 1);
        if (Plan.Rejects.Num() == 1)
        {
            TestTrue(TEXT("f6: human reason mentions ceiling"), Plan.Rejects[0].Reason.Contains(TEXT("ceiling")));
        }
        TestEqual(TEXT("f6: wall fully intact"), CoveredLength(Plan), 2400.0, 0.5);
    }

    // ---- Fixture 7: identity self-exclusion is structural — planning with yourself in Others is a no-op
    {
        const FPlumbStructure RoomA = Room(TEXT("RoomA"), FVector(0,0,0), FVector(600,600,0));
        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(RoomA, { RoomA }, P);
        TestEqual(TEXT("f7: no self-sockets"), Plan.Sockets.Num(), 0);
        TestEqual(TEXT("f7: full coverage"), CoveredLength(Plan), 2400.0, 0.5);
    }

    return true;
}
