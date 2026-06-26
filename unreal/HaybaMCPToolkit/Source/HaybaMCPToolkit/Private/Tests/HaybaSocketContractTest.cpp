#include "Misc/AutomationTest.h"
#include "pcg/HaybaSocketContract.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaSocketContractUnitTest,
    "Hayba.Socket.Contract",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaSocketContractUnitTest::RunTest(const FString& Parameters)
{
    const TArray<FString> NeighborProvides = { TEXT("Connection.Bore"), TEXT("Style.Native") };

    // Satisfied: requires a tag the neighbor provides (directly).
    {
        FHaybaRequire Req; Req.All = { TEXT("Connection.Bore") };
        const FHaybaRequireResult R = HaybaSocketContract::Evaluate(Req, NeighborProvides);
        TestTrue(TEXT("satisfied"), R.bSatisfied);
        TestEqual(TEXT("no missing"), R.MissingRequired.Num(), 0);
    }
    // Satisfied by ancestry: requires "Connection", neighbor provides "Connection.Bore".
    {
        FHaybaRequire Req; Req.All = { TEXT("Connection") };
        TestTrue(TEXT("satisfied by ancestor"), HaybaSocketContract::Evaluate(Req, NeighborProvides).bSatisfied);
    }
    // Unsatisfied: requires a tag absent from the neighbor — the unsat case.
    {
        FHaybaRequire Req; Req.All = { TEXT("Connection.Road") };
        const FHaybaRequireResult R = HaybaSocketContract::Evaluate(Req, NeighborProvides);
        TestFalse(TEXT("unsatisfied"), R.bSatisfied);
        TestEqual(TEXT("one missing"), R.MissingRequired.Num(), 1);
        TestEqual(TEXT("names the missing tag"), R.MissingRequired[0], FString(TEXT("Connection.Road")));
    }
    // Exclude hit: neighbor provides an excluded tag.
    {
        FHaybaRequire Req; Req.All = { TEXT("Connection.Bore") }; Req.Exclude = { TEXT("Style.Native") };
        const FHaybaRequireResult R = HaybaSocketContract::Evaluate(Req, NeighborProvides);
        TestFalse(TEXT("excluded -> unsatisfied"), R.bSatisfied);
        TestEqual(TEXT("one excluded hit"), R.HitExcluded.Num(), 1);
    }
    // Sorted expanded provides are stable + de-duplicated. The two provided tags
    // "Connection.Bore" and "Style.Native" expand to 4 ancestors total:
    // {Connection, Connection.Bore, Style, Style.Native}.
    {
        const TArray<FString> S = HaybaSocketContract::SortedExpandedProvides(NeighborProvides);
        TestEqual(TEXT("expanded count"), S.Num(), 4);
        TestTrue(TEXT("sorted ascending"), S == TArray<FString>({ TEXT("Connection"), TEXT("Connection.Bore"), TEXT("Style"), TEXT("Style.Native") }));
    }
    return true;
}
