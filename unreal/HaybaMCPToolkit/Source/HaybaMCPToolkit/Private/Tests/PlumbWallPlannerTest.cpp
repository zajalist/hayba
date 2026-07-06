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
            TestEqual(TEXT("f1: frame centered on the gap (wall+thickness/2)"), Plan.Sockets[0].Center.Y, 615.0, 1.0);
            TestEqual(TEXT("f1: centered on the mouth x=1500"), Plan.Sockets[0].Center.X, 1500.0, 1.0);
            TestTrue (TEXT("f1: room owns"), Plan.Sockets[0].bOwned);
            TestEqual(TEXT("f1: opening is type-sized 150, not span-sized"), Plan.Sockets[0].Width, 150.0, 0.1);
        }
        // audit: perimeter 2400, one 150 opening -> segments cover 2250, no gaps
        TestEqual(TEXT("f1: coverage = perimeter - opening"), CoveredLength(Plan), 2400.0 - 150.0, 0.5);
        TestEqual(TEXT("f1: no rejects"), Plan.Rejects.Num(), 0);
        // over-door band: a fill patch from opening top (220) to ceiling (300) over the 150 span
        TestTrue (TEXT("f1: over-door fill exists"), Plan.Fills.Num() >= 1);
        if (Plan.Fills.Num() >= 1)
        {
            TestEqual(TEXT("f1: fill starts at opening top"), Plan.Fills[0].Z0, 220.0, 0.1);
            TestEqual(TEXT("f1: fill ends at ceiling"),      Plan.Fills[0].Z1, 300.0, 0.1);
        }
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
            TestEqual(TEXT("f3: frame centered on the gap x=615"), Plan.Sockets[0].Center.X, 615.0, 1.0);
            TestEqual(TEXT("f3: at the mouth y=300"), Plan.Sockets[0].Center.Y, 300.0, 1.0);
        }
        TestEqual(TEXT("f3: coverage"), CoveredLength(Plan), 2400.0 - 150.0, 0.5);
    }

    // ---- Fixture 4: corridor = offset TUNNEL loop (Q2) — two sides + two caps, full coverage
    {
        const FPlumbStructure CorrAB = Corridor(TEXT("CorrAB"), { FVector(600,300,0), FVector(1400,300,0) });
        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(CorrAB, {}, P);
        TestEqual(TEXT("f4: no sockets alone"), Plan.Sockets.Num(), 0);
        // tunnel loop: 2 sides (800) + 2 caps (300) = 2200
        TestEqual(TEXT("f4: tunnel loop coverage 2200"), CoveredLength(Plan), 2200.0, 1.0);
        TestEqual(TEXT("f4: four wall runs (L, far cap, R, near cap)"), Plan.Segments.Num(), 4);
    }

    // ---- Fixture 4b: junction — corridor yields the span ON ITS NEAR CAP (retiled around it)
    {
        const FPlumbStructure RoomB = Room(TEXT("RoomB"), FVector(1200,0,0), FVector(1800,600,0));
        const FPlumbStructure CorrIn = Corridor(TEXT("CorrIn"), { FVector(1800,300,0), FVector(2600,300,0) });
        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(CorrIn, { RoomB }, P);
        TestEqual(TEXT("f4b: one yielded socket"), Plan.Sockets.Num(), 1);
        if (Plan.Sockets.Num() == 1) TestTrue(TEXT("f4b: corridor does not own"), !Plan.Sockets[0].bOwned);
        // socketed mouth insets by WallThickness(30): sides 770x2 + caps 300x2 = 2140; minus 150 opening
        // cap flanks (75x2) are now FILL patches, not grammar segments
        TestEqual(TEXT("f4b: grammar coverage = sides + far cap"), CoveredLength(Plan), 770.0*2 + 300.0, 1.0);
        TestTrue (TEXT("f4b: cap flanks became fills"), Plan.Fills.Num() >= 2);
        TestEqual(TEXT("f4b: floor loop follows inset footprint"), Plan.FloorLoop.Num(), 4);
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

    // ---- Fixture 8: typed sockets — Arch offered both sides -> clean bond, Arch dims win
    {
        FPlumbSocketTypeDecl Arch;
        Arch.Contract.Name = FName(TEXT("Arch"));
        Arch.Contract.Provides = { TEXT("Entrance.Arch") };
        Arch.Contract.Requires.All = { TEXT("Entrance.Arch") };
        Arch.OpeningWidth = 180.0; Arch.OpeningHeight = 240.0; Arch.TransitionRadius = 80.0;

        FPlumbStructure RoomA  = Room(TEXT("RoomA"), FVector(0,0,0), FVector(600,600,0));
        FPlumbStructure CorrAB = Corridor(TEXT("CorrAB"), { FVector(600,300,0), FVector(1400,300,0) });
        RoomA.SocketTypes  = { Arch };
        CorrAB.SocketTypes = { Arch };

        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(RoomA, { CorrAB }, P);
        TestEqual(TEXT("f8: one socket"), Plan.Sockets.Num(), 1);
        if (Plan.Sockets.Num() == 1)
        {
            TestEqual(TEXT("f8: Arch chosen"), Plan.Sockets[0].TypeName, FName(TEXT("Arch")));
            TestEqual(TEXT("f8: Arch width 180"), Plan.Sockets[0].Width, 180.0, 0.1);
            TestEqual(TEXT("f8: transition radius carried"), Plan.Sockets[0].TransitionRadius, 80.0, 0.1);
            TestTrue (TEXT("f8: clean, not relaxed"), !Plan.Sockets[0].bRelaxedBond);
        }
    }

    // ---- Fixture 9: incompatible non-relaxable types -> reject with missing-tag reason (the moat)
    {
        FPlumbSocketTypeDecl Vault;   // vault door demands a vault entrance back, non-negotiable
        Vault.Contract.Name = FName(TEXT("Vault"));
        Vault.Contract.Provides = { TEXT("Entrance.Vault") };
        Vault.Contract.Requires.All = { TEXT("Entrance.Vault") };
        Vault.Contract.bRelaxable = false;
        FPlumbSocketTypeDecl Rough;
        Rough.Contract.Name = FName(TEXT("Rough"));
        Rough.Contract.Provides = { TEXT("Entrance.Rough") };
        Rough.Contract.bRelaxable = false;

        FPlumbStructure RoomA  = Room(TEXT("RoomA"), FVector(0,0,0), FVector(600,600,0));
        FPlumbStructure CorrAB = Corridor(TEXT("CorrAB"), { FVector(600,300,0), FVector(1400,300,0) });
        RoomA.SocketTypes  = { Vault };
        CorrAB.SocketTypes = { Rough };

        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(RoomA, { CorrAB }, P);
        TestEqual(TEXT("f9: no socket"), Plan.Sockets.Num(), 0);
        TestEqual(TEXT("f9: one reject"), Plan.Rejects.Num(), 1);
        if (Plan.Rejects.Num() == 1)
        {
            TestTrue(TEXT("f9: reason names the missing tag"), Plan.Rejects[0].Reason.Contains(TEXT("Entrance.Vault")));
        }
        TestEqual(TEXT("f9: wall stays sealed at full coverage"), CoveredLength(Plan), 2400.0, 0.5);
    }

    // ---- Fixture 10: cost-min picks the compatible pair among mixed candidates
    {
        FPlumbSocketTypeDecl Vault; // won't match
        Vault.Contract.Name = FName(TEXT("Vault"));
        Vault.Contract.Provides = { TEXT("Entrance.Vault") };
        Vault.Contract.Requires.All = { TEXT("Entrance.Vault") };
        Vault.Contract.bRelaxable = false;
        FPlumbSocketTypeDecl Arch;  // will match cleanly
        Arch.Contract.Name = FName(TEXT("Arch"));
        Arch.Contract.Provides = { TEXT("Entrance.Arch") };
        Arch.Contract.Requires.All = { TEXT("Entrance.Arch") };
        Arch.OpeningWidth = 200.0;

        FPlumbStructure RoomA  = Room(TEXT("RoomA"), FVector(0,0,0), FVector(600,600,0));
        FPlumbStructure CorrAB = Corridor(TEXT("CorrAB"), { FVector(600,300,0), FVector(1400,300,0) });
        RoomA.SocketTypes  = { Vault, Arch };  // vault preferred by order, but incompatible
        CorrAB.SocketTypes = { Arch };

        const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(RoomA, { CorrAB }, P);
        TestEqual(TEXT("f10: one socket"), Plan.Sockets.Num(), 1);
        if (Plan.Sockets.Num() == 1)
        {
            TestEqual(TEXT("f10: solver picked Arch over incompatible Vault"), Plan.Sockets[0].TypeName, FName(TEXT("Arch")));
            TestEqual(TEXT("f10: Arch dims used (200)"), Plan.Sockets[0].Width, 200.0, 0.1);
        }
        TestEqual(TEXT("f10: coverage = perimeter - 200"), CoveredLength(Plan), 2400.0 - 200.0, 0.5);
    }

    return true;
}
