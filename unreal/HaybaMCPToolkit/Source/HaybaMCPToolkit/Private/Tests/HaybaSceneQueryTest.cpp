// The ambiguity contract, tested without an editor.
//
// Actor labels are not unique in Unreal. Every handler that resolved one used
// to take the first match, so a command targeting a duplicated label acted on
// an arbitrary actor and reported success. Two of those were still live on
// 2026-08-25 and were fixed:
//
//   net_set_replication  — resolved by label, first match, then WROTE
//                          (SetReplicates / bAlwaysRelevant / NetDormancy)
//   editor_pie_assert    — matched a path SUFFIX, first match, then asserted
//
// Both were verified against a live editor. Neither had a regression test, so
// both could quietly come back. `FindActor` needs a UWorld and cannot run
// here, but the two things every caller depends on are pure: what counts as
// ambiguous, and whether the refusal tells you how to proceed.

#include "Misc/AutomationTest.h"
#include "HaybaSceneQuery.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaSceneQueryAmbiguityTest,
    "Hayba.MCP.SceneQuery.Ambiguity",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaSceneQueryAmbiguityTest::RunTest(const FString&)
{
    using namespace HaybaSceneQuery;

    {
        // A clean hit leaves Candidates empty. Callers branch on IsAmbiguous()
        // rather than inventing their own count, so this is the whole contract.
        FActorLookup Hit;
        Hit.Actor = nullptr;
        TestFalse(TEXT("no candidates is not ambiguous"), Hit.IsAmbiguous());
    }

    {
        // ONE candidate must not be ambiguous. If it were, every ordinary
        // label lookup would refuse and the tools would be unusable -- the
        // failure mode of an over-eager guard.
        FActorLookup Hit;
        Hit.Candidates.Add(TEXT("StaticMeshActor_0"));
        TestFalse(TEXT("a single candidate resolves"), Hit.IsAmbiguous());
    }

    {
        FActorLookup Hit;
        Hit.Candidates.Add(TEXT("StaticMeshActor_0"));
        Hit.Candidates.Add(TEXT("StaticMeshActor_1"));
        TestTrue(TEXT("two candidates is ambiguous"), Hit.IsAmbiguous());
    }

    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaSceneQueryErrorTextTest,
    "Hayba.MCP.SceneQuery.ErrorText",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaSceneQueryErrorTextTest::RunTest(const FString&)
{
    using namespace HaybaSceneQuery;

    TArray<FString> Candidates;
    Candidates.Add(TEXT("StaticMeshActor_0"));
    Candidates.Add(TEXT("StaticMeshActor_1"));

    const FString Msg = AmbiguousError(TEXT("net_set_replication"), TEXT("Crate"), Candidates);

    TestTrue(TEXT("names the command, so the caller knows what refused"),
             Msg.Contains(TEXT("net_set_replication")));
    TestTrue(TEXT("quotes the label that was ambiguous"), Msg.Contains(TEXT("\"Crate\"")));
    TestTrue(TEXT("states how many matched"), Msg.Contains(TEXT("2 actors")));

    // The part that makes it an instruction rather than a complaint. "Be more
    // specific" without saying what to be specific WITH leaves the caller
    // guessing, and an agent will usually guess by retrying the same thing.
    TestTrue(TEXT("lists the first alternative"), Msg.Contains(TEXT("StaticMeshActor_0")));
    TestTrue(TEXT("lists the second alternative"), Msg.Contains(TEXT("StaticMeshActor_1")));
    TestTrue(TEXT("says what to do next"), Msg.Contains(TEXT("unique names")));

    // It must read as a refusal, not as a failure to find anything: "not
    // found" would send someone looking for a missing actor that is right
    // there, twice.
    TestTrue(TEXT("frames it as refusing to guess"), Msg.Contains(TEXT("refusing to guess")));
    TestFalse(TEXT("does not claim the actor is missing"), Msg.Contains(TEXT("not found")));

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
