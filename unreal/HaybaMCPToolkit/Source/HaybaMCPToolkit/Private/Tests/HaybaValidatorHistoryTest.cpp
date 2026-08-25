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

    // ── The signed margin, and the fix vector ───────────────────────────
    //
    // The IA's verdict contract needs an amount, a direction and a next
    // action. All three come from `measurement`, which the panel ignored
    // entirely until now. Every way of misreading this shape fails SOFT --
    // you get "no measurement", never an error -- so it has to be pinned.
    {
        const FString Line =
            TEXT(R"({"ruleId":"clearance.doorway","severity":"error",)")
            TEXT(R"("message":"short","hint":"move it","timestamp":"t","toolName":"actor_spawn",)")
            TEXT(R"("measurement":{"value":-0.62,"unit":"m","detail":"0.58m < 1.20m",)")
            TEXT(R"("fix":{"translate":[0,62,0]}}})");

        TSharedPtr<FHaybaValidatorFinding> F = SHaybaValidatorPanel::ParseFindingLine(Line);
        if (TestTrue(TEXT("a finding with a measurement parses"), F.IsValid()))
        {
            TestTrue(TEXT("the measurement is recorded as present"), F->bHasMeasurement);
            TestEqual(TEXT("the margin keeps its sign"), F->MarginValue, -0.62, 1e-9);
            TestEqual(TEXT("the unit survives"), F->MarginUnit, FString(TEXT("m")));
            TestEqual(TEXT("the detail survives"), F->MarginDetail, FString(TEXT("0.58m < 1.20m")));

            // translate is an ARRAY. Reading it as {x,y,z} finds nothing and
            // silently offers no Fix button.
            TestTrue(TEXT("the fix vector is found"), F->bHasFix);
            TestEqual(TEXT("the fix vector is read in order"),
                F->FixTranslate, FVector(0.0, 62.0, 0.0));
        }
    }
    {
        const FString Line =
            TEXT(R"({"ruleId":"r","severity":"info","message":"m","hint":"h",)")
            TEXT(R"("timestamp":"t","toolName":"tool","measurement":{"value":1.8,"unit":"m"}})");

        TSharedPtr<FHaybaValidatorFinding> F = SHaybaValidatorPanel::ParseFindingLine(Line);
        if (F.IsValid())
        {
            TestTrue(TEXT("a measurement without a fix still measures"), F->bHasMeasurement);
            // Not a zero fix. No fix at all -- otherwise the panel would offer
            // a Fix button that moves the actor nowhere.
            TestFalse(TEXT("no fix vector means no fix offered"), F->bHasFix);
        }
    }
    {
        // Zero is a measurement: it means sitting exactly on the limit. A
        // bare double cannot tell that from "not measured", which is why the
        // struct carries a separate flag.
        const FString Line =
            TEXT(R"({"ruleId":"r","severity":"info","message":"m","hint":"h",)")
            TEXT(R"("timestamp":"t","toolName":"tool","measurement":{"value":0,"unit":"m"}})");

        TSharedPtr<FHaybaValidatorFinding> F = SHaybaValidatorPanel::ParseFindingLine(Line);
        if (F.IsValid())
        {
            TestTrue(TEXT("a measured zero is still a measurement"), F->bHasMeasurement);
            TestEqual(TEXT("a measured zero keeps its value"), F->MarginValue, 0.0, 1e-9);
        }
    }
    {
        // A partial vector is not a fix. Applying one would move the actor
        // somewhere nobody computed.
        const FString Line =
            TEXT(R"({"ruleId":"r","severity":"error","message":"m","hint":"h",)")
            TEXT(R"("timestamp":"t","toolName":"tool",)")
            TEXT(R"("measurement":{"value":-1,"unit":"m","fix":{"translate":[1,2]}}})");

        TSharedPtr<FHaybaValidatorFinding> F = SHaybaValidatorPanel::ParseFindingLine(Line);
        if (F.IsValid())
        {
            TestTrue(TEXT("a malformed fix does not lose the margin"), F->bHasMeasurement);
            TestFalse(TEXT("a two-element translate is refused"), F->bHasFix);
        }
    }
    {
        // No measurement at all: the common case for non-spatial rules. The
        // panel renders an em dash for this, which must not be confused with
        // a measured zero.
        const FString Line =
            TEXT(R"({"ruleId":"naming","severity":"warning","message":"m","hint":"h",)")
            TEXT(R"("timestamp":"t","toolName":"tool"})");

        TSharedPtr<FHaybaValidatorFinding> F = SHaybaValidatorPanel::ParseFindingLine(Line);
        if (F.IsValid())
        {
            TestFalse(TEXT("a finding without a measurement reports none"), F->bHasMeasurement);
            TestFalse(TEXT("and offers no fix"), F->bHasFix);
        }
    }

    return true;
}

#endif // WITH_EDITOR
