// Blueprint rules that decide things, tested without an editor.
//
// Both were found by calling the commands against a live editor while writing
// their descriptions, and both had the same shape: the command answered ok for
// work that had gone somewhere the caller did not intend.

#include "Misc/AutomationTest.h"
#include "HaybaBlueprintOps.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsResolvePackageTest,
    "Hayba.MCP.BlueprintOps.ResolvePackage",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsResolvePackageTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;

    {
        // The documented usage: package_path IS the intended asset path.
        const FResolvedPackage R = ResolvePackage(TEXT("/Game/UI/BP_Menu"), TEXT("BP_Menu"));
        TestEqual(TEXT("lands where the caller said"), R.PackageName, FString(TEXT("/Game/UI/BP_Menu")));
        TestFalse(TEXT("nothing surprising to report"), R.bTrailingIsNotName);
        TestTrue(TEXT("so no note"), PackagePathNote(R, TEXT("/Game/UI/BP_Menu")).IsEmpty());
    }

    {
        // The trap. A caller reading the parameter name passes a FOLDER, and the
        // asset is created one directory up from where they meant. This put a
        // probe asset at the content root twice in one afternoon.
        const FResolvedPackage R = ResolvePackage(TEXT("/Game/Temp"), TEXT("BP_Probe"));
        TestEqual(TEXT("the trailing component is discarded, not treated as a folder"),
                  R.PackageName, FString(TEXT("/Game/BP_Probe")));
        TestTrue(TEXT("and that is flagged"), R.bTrailingIsNotName);

        const FString Note = PackagePathNote(R, TEXT("/Game/Temp"));
        TestFalse(TEXT("a note is produced"), Note.IsEmpty());
        TestTrue(TEXT("naming where it actually went"), Note.Contains(TEXT("/Game/BP_Probe")));
        TestTrue(TEXT("and how to get what was meant"), Note.Contains(TEXT("/Game/Temp/<name>")));
    }

    {
        // Case should not decide whether the caller gets a warning.
        const FResolvedPackage R = ResolvePackage(TEXT("/Game/UI/bp_menu"), TEXT("BP_Menu"));
        TestFalse(TEXT("trailing matches the name case-insensitively"), R.bTrailingIsNotName);
    }

    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsFunctionNameTest,
    "Hayba.MCP.BlueprintOps.FunctionNameConflict",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsFunctionNameTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;

    const TArray<FString> Existing = { TEXT("EventGraph"), TEXT("ProbeFunc"), TEXT("ConstructionScript") };

    {
        TestTrue(TEXT("a free name is free"),
                 FunctionNameConflict(Existing, TEXT("NewThing")).IsEmpty());
    }

    {
        // The bug this exists for: adding a duplicate compiled to "Found more
        // than one function with the same name", left the blueprint broken, and
        // still answered ok.
        const FString Err = FunctionNameConflict(Existing, TEXT("ProbeFunc"));
        TestFalse(TEXT("a taken name is refused"), Err.IsEmpty());
        TestTrue(TEXT("the message names the collision"), Err.Contains(TEXT("ProbeFunc")));
        TestTrue(TEXT("and says nothing was changed, because nothing was"),
                 Err.Contains(TEXT("nothing was changed")));
    }

    {
        // FName comparison is case-insensitive, so "probefunc" collides too —
        // letting it through would produce the same broken blueprint by a route
        // the check appeared to cover.
        TestFalse(TEXT("case does not create a second slot"),
                  FunctionNameConflict(Existing, TEXT("probefunc")).IsEmpty());
    }

    {
        TestTrue(TEXT("no graphs, no conflict"),
                 FunctionNameConflict({}, TEXT("Anything")).IsEmpty());
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
