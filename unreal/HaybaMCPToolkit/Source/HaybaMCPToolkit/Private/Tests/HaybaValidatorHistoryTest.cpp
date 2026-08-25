#include "Misc/AutomationTest.h"

#include "Slate/SHaybaValidatorPanel.h"

#if WITH_EDITOR

// The panel reads .scratch/validator-history.jsonl itself rather than going
// through the server, so it has to understand both spellings of a finding's
// detail object: `data` since the verdict collapse, `context` for records
// already on a user's machine.
//
// This gets a test because the rename went the other way once already. The
// wire format was preserved and the field the panel actually parses was
// renamed, so every new finding lost its graph path and its "Jump to actor"
// button, and nothing failed loudly -- an empty column looks like a finding
// that simply had no context.

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaValidatorHistoryFieldTest,
    "Hayba.Validator.History.DetailFieldSpelling",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaValidatorHistoryFieldTest::RunTest(const FString& Parameters)
{
    // Post-collapse: `data`.
    {
        const FString Line = TEXT(R"({"ruleId":"r1","category":"pcg","severity":"warning",)")
            TEXT(R"("message":"m","hint":"h","timestamp":"2026-08-25T00:00:00.000Z",)")
            TEXT(R"("toolName":"probe",)")
            TEXT(R"("data":{"graph":"/Game/Probe/New","actor_label":"ProbeNew","actor_id":"A_1"}})");

        TSharedPtr<FHaybaValidatorFinding> F = SHaybaValidatorPanel::ParseFindingLine(Line);
        TestTrue(TEXT("a data-shaped line parses"), F.IsValid());
        if (F.IsValid())
        {
            TestEqual(TEXT("graph read from data"), F->GraphPath, FString(TEXT("/Game/Probe/New")));
            TestEqual(TEXT("actor label read from data"), F->ActorLabel, FString(TEXT("ProbeNew")));
            TestEqual(TEXT("actor id read from data"), F->ActorId, FString(TEXT("A_1")));
        }
    }

    // Pre-collapse: `context`. Still on disk for anyone who used this before.
    {
        const FString Line = TEXT(R"({"ruleId":"r2","severity":"warning","message":"m","hint":"h",)")
            TEXT(R"("timestamp":"2026-08-25T00:00:01.000Z","toolName":"probe",)")
            TEXT(R"("context":{"graph":"/Game/Probe/Old","actor_label":"ProbeOld"}})");

        TSharedPtr<FHaybaValidatorFinding> F = SHaybaValidatorPanel::ParseFindingLine(Line);
        TestTrue(TEXT("a context-shaped line still parses"), F.IsValid());
        if (F.IsValid())
        {
            TestEqual(TEXT("graph read from context"), F->GraphPath, FString(TEXT("/Game/Probe/Old")));
            TestEqual(TEXT("actor label read from context"), F->ActorLabel, FString(TEXT("ProbeOld")));
        }
    }

    // A finding with neither is fine -- plenty carry no detail at all.
    {
        const FString Line = TEXT(R"({"ruleId":"r3","severity":"info","message":"m","hint":"h",)")
            TEXT(R"("timestamp":"2026-08-25T00:00:02.000Z","toolName":"probe"})");

        TSharedPtr<FHaybaValidatorFinding> F = SHaybaValidatorPanel::ParseFindingLine(Line);
        TestTrue(TEXT("a detail-less line parses"), F.IsValid());
        if (F.IsValid())
        {
            TestTrue(TEXT("no graph path invented"), F->GraphPath.IsEmpty());
        }
    }

    // `data` wins when a record somehow carries both, because that is the one
    // written since the collapse.
    {
        const FString Line = TEXT(R"({"ruleId":"r4","severity":"warning","message":"m","hint":"h",)")
            TEXT(R"("timestamp":"2026-08-25T00:00:03.000Z","toolName":"probe",)")
            TEXT(R"("data":{"graph":"/Game/New"},"context":{"graph":"/Game/Old"}})");

        TSharedPtr<FHaybaValidatorFinding> F = SHaybaValidatorPanel::ParseFindingLine(Line);
        if (F.IsValid())
        {
            TestEqual(TEXT("data takes precedence"), F->GraphPath, FString(TEXT("/Game/New")));
        }
    }

    return true;
}

#endif // WITH_EDITOR
