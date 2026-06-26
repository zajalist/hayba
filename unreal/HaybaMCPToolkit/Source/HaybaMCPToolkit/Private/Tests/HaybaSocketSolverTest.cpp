#include "Misc/AutomationTest.h"
#include "pcg/HaybaSocketSolver.h"

namespace
{
    static FHaybaSocketContract MakeSocket(const TCHAR* Name, const TArray<FString>& Provides,
        const TArray<FString>& RequiresAll, bool bRelaxable, const TArray<FString>& Exclude = {})
    {
        FHaybaSocketContract C;
        C.Name = FName(Name);
        C.Provides = Provides;
        C.Requires.All = RequiresAll;
        C.Requires.Exclude = Exclude;
        C.bRelaxable = bRelaxable;
        return C;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaSocketSolverUnitTest,
    "Hayba.Socket.Solver",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaSocketSolverUnitTest::RunTest(const FString& Parameters)
{
    using namespace HaybaSocketSolver;

    // CLEAN: both sides satisfied -> cost 0, bonded, not relaxed.
    {
        const FHaybaSocketContract F = MakeSocket(TEXT("main_wall"),
            { TEXT("Connection.Bore"), TEXT("Style.Native") }, { TEXT("Connection.Bore") }, true);
        const FHaybaSocketContract C = MakeSocket(TEXT("branch_mouth"),
            { TEXT("Connection.Bore"), TEXT("Style.Native") }, { TEXT("Connection.Bore") }, true);
        const FHaybaBondOutcome O = SolveBond(F, { C });
        TestTrue (TEXT("clean: ok"), O.bOk);
        TestFalse(TEXT("clean: not relaxed"), O.bRelaxed);
        TestEqual(TEXT("clean: cost 0"), O.Cost, 0.0);
        TestEqual(TEXT("clean: chose index 0"), O.ChosenIndex, 0);
    }

    // HARD FAIL: branch (hard) requires Connection.Road; main does not provide it.
    {
        const FHaybaSocketContract Main = MakeSocket(TEXT("main_wall"),
            { TEXT("Connection.Bore"), TEXT("Style.Native") }, { TEXT("Connection.Bore") }, true);
        const FHaybaSocketContract Branch = MakeSocket(TEXT("branch_mouth"),
            { TEXT("Connection.Bore"), TEXT("Style.Native") }, { TEXT("Connection.Road") }, /*relaxable=*/false);
        const FHaybaBondOutcome O = SolveBond(Branch, { Main }); // frontier=branch (the requirer)
        TestFalse(TEXT("hard: not ok"), O.bOk);
        TestTrue (TEXT("hard: cost >= HardPenalty"), O.Cost >= HardPenalty);
        TestEqual(TEXT("hard: requirer is branch_mouth"), O.RequirerName, FName(TEXT("branch_mouth")));
        TestEqual(TEXT("hard: provider is main_wall"),    O.ProviderName, FName(TEXT("main_wall")));
        TestEqual(TEXT("hard: one missing tag"), O.MissingRequired.Num(), 1);
        TestEqual(TEXT("hard: missing is Connection.Road"), O.MissingRequired[0], FString(TEXT("Connection.Road")));
        TestTrue (TEXT("hard: provided lists Connection.Bore"),
            O.NeighborProvided.Contains(TEXT("Connection.Bore")));
    }

    // RELAXED: same mismatch but branch is relaxable -> bonded by downgrade.
    {
        const FHaybaSocketContract Main = MakeSocket(TEXT("main_wall"),
            { TEXT("Connection.Bore") }, { TEXT("Connection.Bore") }, true);
        const FHaybaSocketContract Branch = MakeSocket(TEXT("branch_mouth"),
            { TEXT("Connection.Bore") }, { TEXT("Connection.Road") }, /*relaxable=*/true);
        const FHaybaBondOutcome O = SolveBond(Branch, { Main });
        TestTrue (TEXT("relaxed: ok"), O.bOk);
        TestTrue (TEXT("relaxed: flagged relaxed"), O.bRelaxed);
        TestTrue (TEXT("relaxed: cost in [Relaxable,Hard)"),
            O.Cost >= RelaxablePenalty && O.Cost < HardPenalty);
        TestEqual(TEXT("relaxed: still names the downgraded tag"), O.MissingRequired[0], FString(TEXT("Connection.Road")));
    }

    // CHOICE: lowest-cost candidate wins (clean beats relaxable-miss).
    {
        const FHaybaSocketContract F = MakeSocket(TEXT("f"),
            { TEXT("Connection.Bore") }, { TEXT("Connection.Bore") }, true);
        const FHaybaSocketContract Bad  = MakeSocket(TEXT("bad"),
            { TEXT("Connection.Bore") }, { TEXT("Connection.Road") }, true); // relaxable miss
        const FHaybaSocketContract Good = MakeSocket(TEXT("good"),
            { TEXT("Connection.Bore") }, { TEXT("Connection.Bore") }, true); // clean
        const FHaybaBondOutcome O = SolveBond(F, { Bad, Good });
        TestTrue (TEXT("choice: ok"), O.bOk);
        TestEqual(TEXT("choice: picked the clean one (index 1)"), O.ChosenIndex, 1);
        TestEqual(TEXT("choice: cost 0"), O.Cost, 0.0);
    }

    // MULTI-MISS: a relaxable frontier missing TWO required tags costs RelaxablePenalty * 2.
    {
        const FHaybaSocketContract F = MakeSocket(TEXT("f"),
            { TEXT("X") }, { TEXT("A"), TEXT("B") }, /*relaxable=*/true); // requires A,B (relaxable)
        const FHaybaSocketContract C = MakeSocket(TEXT("c"),
            { TEXT("X") }, {}, true);                                     // provides neither A nor B; requires nothing
        const FHaybaBondOutcome O = SolveBond(F, { C });
        TestTrue (TEXT("multi-miss: ok (relaxed)"), O.bOk);
        TestTrue (TEXT("multi-miss: relaxed"), O.bRelaxed);
        TestEqual(TEXT("multi-miss: cost == RelaxablePenalty*2"), O.Cost, RelaxablePenalty * 2.0);
        TestEqual(TEXT("multi-miss: two missing tags"), O.MissingRequired.Num(), 2);
    }

    // EMPTY CANDIDATES: no bond, INDEX_NONE.
    {
        const FHaybaSocketContract F = MakeSocket(TEXT("f"), { TEXT("X") }, {}, true);
        const TArray<FHaybaSocketContract> None;
        const FHaybaBondOutcome O = SolveBond(F, None);
        TestFalse(TEXT("empty candidates: not ok"), O.bOk);
        TestEqual(TEXT("empty candidates: INDEX_NONE"), O.ChosenIndex, (int32)INDEX_NONE);
    }

    // EXCLUDE HIT: a provided excluded tag hard-fails (never relaxed).
    {
        FHaybaSocketContract F = MakeSocket(TEXT("f"), { TEXT("X") }, {}, /*relaxable=*/true);
        F.Requires.Exclude = { TEXT("Style.Native") };                 // exclude
        const FHaybaSocketContract C = MakeSocket(TEXT("c"),
            { TEXT("Style.Native") }, {}, true);                       // provides the excluded tag
        const FHaybaBondOutcome O = SolveBond(F, { C });
        TestFalse(TEXT("exclude hit: not ok"), O.bOk);
        TestTrue (TEXT("exclude hit: cost >= HardPenalty"), O.Cost >= HardPenalty);
    }
    return true;
}
