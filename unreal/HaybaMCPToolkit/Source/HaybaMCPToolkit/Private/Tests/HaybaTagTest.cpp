#include "Misc/AutomationTest.h"
#include "pcg/HaybaTag.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaTagUnitTest,
    "Hayba.Socket.Tag",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaTagUnitTest::RunTest(const FString& Parameters)
{
    // Ancestor expansion: every dotted prefix is present.
    const TSet<FString> Abc = HaybaTag::ExpandAncestors(TEXT("A.B.C"));
    TestEqual(TEXT("A.B.C expands to 3"), Abc.Num(), 3);
    TestTrue(TEXT("has A"),     Abc.Contains(TEXT("A")));
    TestTrue(TEXT("has A.B"),   Abc.Contains(TEXT("A.B")));
    TestTrue(TEXT("has A.B.C"), Abc.Contains(TEXT("A.B.C")));

    // Single segment and empty input.
    TestEqual(TEXT("single segment -> 1"), HaybaTag::ExpandAncestors(TEXT("A")).Num(), 1);
    TestEqual(TEXT("empty -> 0"),          HaybaTag::ExpandAncestors(TEXT("")).Num(), 0);

    // ExpandAll unions and de-dups overlapping ancestry.
    const TSet<FString> All = HaybaTag::ExpandAll({ TEXT("Style.Imperial.Vent"), TEXT("Style.Imperial") });
    TestTrue(TEXT("ExpandAll has Style"),                 All.Contains(TEXT("Style")));
    TestTrue(TEXT("ExpandAll has Style.Imperial"),        All.Contains(TEXT("Style.Imperial")));
    TestTrue(TEXT("ExpandAll has Style.Imperial.Vent"),   All.Contains(TEXT("Style.Imperial.Vent")));
    TestEqual(TEXT("ExpandAll de-dups to 3"), All.Num(), 3);

    // Provides: a required ancestor is satisfied by a deeper provided tag.
    const TSet<FString> Prov = HaybaTag::ExpandAll({ TEXT("Connection.Bore"), TEXT("Style.Native") });
    TestTrue (TEXT("provides Connection.Bore"),  HaybaTag::Provides(Prov, TEXT("Connection.Bore")));
    TestTrue (TEXT("provides Connection (anc.)"), HaybaTag::Provides(Prov, TEXT("Connection")));
    TestFalse(TEXT("does not provide Connection.Road"), HaybaTag::Provides(Prov, TEXT("Connection.Road")));

    return true;
}
