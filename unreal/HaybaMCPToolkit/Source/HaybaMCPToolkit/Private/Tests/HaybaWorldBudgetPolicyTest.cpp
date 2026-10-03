#include "Misc/AutomationTest.h"
#include "HaybaWorldBudgetPolicy.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldBudgetPolicyTest,
    "Hayba.MCP.World.BudgetPolicy",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorldBudgetPolicyTest::RunTest(const FString& Parameters)
{
    using namespace HaybaWorldBudget;
    TestEqual(TEXT("normalizes nested paths"), NormalizeFolder(TEXT(" /City\\Market//Stalls/ ")), FString(TEXT("City/Market/Stalls")));
    TestTrue(TEXT("parent includes descendants"), ContainsFolder(TEXT("City/Market"), TEXT("City/Market/Stalls")));
    TestTrue(TEXT("folder includes itself"), ContainsFolder(TEXT("City/Market"), TEXT("City/Market")));
    TestFalse(TEXT("prefix alone is not descendant"), ContainsFolder(TEXT("City/Market"), TEXT("City/Marketplace")));

    TMap<FString, int32> Direct, Descendants;
    AddFolderCounts(TEXT("City/Market/Stalls"), Direct, Descendants);
    AddFolderCounts(TEXT("City/Market"), Direct, Descendants);
    AddFolderCounts(TEXT("City/Roads"), Direct, Descendants);
    TestEqual(TEXT("direct stall count"), Direct.FindRef(TEXT("City/Market/Stalls")), 1);
    TestEqual(TEXT("direct market count"), Direct.FindRef(TEXT("City/Market")), 1);
    TestEqual(TEXT("market descendant count"), Descendants.FindRef(TEXT("City/Market")), 2);
    TestEqual(TEXT("city descendant count"), Descendants.FindRef(TEXT("City")), 3);
    TestEqual(TEXT("root descendant count"), Descendants.FindRef(TEXT("")), 3);
    // Two loaded folder roots with the same path are intentionally aggregated:
    // this policy only receives GetFolderPath(), not folder-root identity.
    TMap<FString, int32> AcrossRootsDirect, AcrossRootsDescendants;
    AddFolderCounts(TEXT("Village/Market"), AcrossRootsDirect, AcrossRootsDescendants);
    AddFolderCounts(TEXT("Village/Market"), AcrossRootsDirect, AcrossRootsDescendants);
    TestEqual(TEXT("same path in two roots aggregates"), AcrossRootsDirect.FindRef(TEXT("Village/Market")), 2);
    TestEqual(TEXT("aggregate ancestor includes both roots"), AcrossRootsDescendants.FindRef(TEXT("Village")), 2);
    TestEqual(TEXT("row bound"), BoundedRowCount(1000), 50);
    TestFalse(TEXT("exact bound has no truncation"), RowsTruncated(50));
    TestTrue(TEXT("over bound reports truncation"), RowsTruncated(51));
    TestEqual(TEXT("incomplete scan has no passing verdict"), FString(StructuralTargetVerdict(false, 2, 10)),
        FString(TEXT("unknown_incomplete_scan")));
    TestEqual(TEXT("complete loaded count only"), FString(StructuralTargetVerdict(true, 2, 10)),
        FString(TEXT("within_user_structural_limit_for_loaded_scope")));
    TestEqual(TEXT("exceeding structural target"), FString(StructuralTargetVerdict(true, 11, 10)),
        FString(TEXT("exceeds_user_structural_limit")));
    return true;
}
#endif
