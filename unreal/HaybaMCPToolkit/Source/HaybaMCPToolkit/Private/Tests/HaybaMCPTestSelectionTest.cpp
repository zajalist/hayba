#include "Misc/AutomationTest.h"
#include "handlers/HaybaMCPTestSelectionOps.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPTestSelectionContractTest,
    "Hayba.MCP.TestSelection.SelectorsAndFailuresAreTruthful",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPTestSelectionContractTest::RunTest(const FString& Parameters)
{
    using namespace HaybaTestSelection;

    TestTrue(TEXT("category prefix matches case-insensitively"),
        Matches(TEXT("Readable Name"), TEXT("Hayba.MCP.TestSelection.Case"),
            FString(), TEXT("hayba.mcp.testselection")));
    TestTrue(TEXT("substring matches display name case-insensitively"),
        Matches(TEXT("SelectorsAndFailuresAreTruthful"), TEXT("Hayba.Other"),
            TEXT("failuresaretruthful"), FString()));
    TestFalse(TEXT("both selectors must match when both are supplied"),
        Matches(TEXT("SelectorsAndFailuresAreTruthful"), TEXT("Hayba.Other"),
            TEXT("failures"), TEXT("Aphrosia")));
    TestFalse(TEXT("partial category outside the prefix is rejected"),
        Matches(TEXT("Aphrosia"), TEXT("Other.Aphrosia.Test"),
            FString(), TEXT("Aphrosia")));

    TestTrue(TEXT("all plus explicit names is rejected"),
        !ValidateCombination(true, 1, false).IsEmpty());
    TestTrue(TEXT("selectors plus explicit names are rejected"),
        !ValidateCombination(false, 1, true).IsEmpty());
    TestTrue(TEXT("selector-only request is valid"),
        ValidateCombination(false, 0, true).IsEmpty());
    TestTrue(TEXT("empty request fails closed"),
        ValidateResolvedSelection(false, false, 0).Contains(TEXT("requires")));
    TestTrue(TEXT("zero-match selector fails closed"),
        ValidateResolvedSelection(false, true, 0).Contains(TEXT("matched no tests")));
    TestTrue(TEXT("non-empty selection is accepted"),
        ValidateResolvedSelection(false, true, 1).IsEmpty());
    return true;
}
