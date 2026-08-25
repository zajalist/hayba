#include "Misc/AutomationTest.h"

#if WITH_EDITOR

#include "HaybaMCPToolStreamPanel.h"

/**
 * Activity's verdict: how a tool call is classified, and how a turn summarises
 * its calls.
 *
 * The bug this pins was not in the logic — it was that the logic ran in only
 * ONE of the two places a call gets built. A row reading "ERROR: source file
 * not found" rendered with a green tick, because the panel hydrates from
 * history on first show and that path skipped classification. Classify() is
 * now the single owner; these tests cover what it must decide.
 *
 * The case that matters most is the middle one: a call that SUCCEEDED and
 * broke a rule. That is the IA's "needs attention", and before this it was
 * indistinguishable from a clean success.
 */
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaActivityStatusTest,
    "Hayba.UI.Activity.CallAndTurnStatus",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

namespace
{
    FHaybaToolCall MakeCall(const FString& Result)
    {
        FHaybaToolCall C;
        C.ToolName = TEXT("actor_spawn");
        C.ResultJson = Result;
        C.Classify();
        return C;
    }

    /** A result carrying one validator finding with the given margin. */
    FString ResultWithMargin(double Value, const TCHAR* Unit = TEXT("m"),
        const TCHAR* RuleId = TEXT("clearance.doorway"))
    {
        return FString::Printf(
            TEXT("{\"ok\":true,\"validator\":{\"findings\":[")
            TEXT("{\"ruleId\":\"%s\",\"measurement\":{\"value\":%f,\"unit\":\"%s\"}}]}}"),
            RuleId, Value, Unit);
    }
}

bool FHaybaActivityStatusTest::RunTest(const FString& Parameters)
{
    // ── A plain success ────────────────────────────────────────────────
    {
        const FHaybaToolCall C = MakeCall(TEXT("{\"ok\":true,\"actor_id\":\"SM_Crate_01\"}"));
        TestFalse(TEXT("a plain success is not an error"), C.bIsError);
        TestFalse(TEXT("a plain success needs no attention"), C.bNeedsAttention);
    }

    // ── An outright failure ────────────────────────────────────────────
    {
        const FHaybaToolCall C = MakeCall(TEXT("ERROR: source file not found"));
        TestTrue(TEXT("an ERROR result is an error"), C.bIsError);
        // Not both. There is no margin to report and nothing to move, so
        // offering "needs attention" would promise a fix that does not exist.
        TestFalse(TEXT("an error does not also need attention"), C.bNeedsAttention);
    }

    // ── Succeeded, and broke a rule ────────────────────────────────────
    {
        const FHaybaToolCall C = MakeCall(ResultWithMargin(-0.62));
        TestFalse(TEXT("a rule violation is not a tool error"), C.bIsError);
        TestTrue(TEXT("a negative margin needs attention"), C.bNeedsAttention);
        TestEqual(TEXT("the margin is carried for the tooltip"), C.WorstMargin, -0.62, 1e-6);
        TestEqual(TEXT("the unit is carried"), C.WorstMarginUnit, FString(TEXT("m")));
        TestEqual(TEXT("the rule is named"), C.WorstRuleId, FString(TEXT("clearance.doorway")));
    }

    // ── A satisfied margin is not a violation ──────────────────────────
    {
        const FHaybaToolCall C = MakeCall(ResultWithMargin(1.82));
        TestFalse(TEXT("a positive margin needs no attention"), C.bNeedsAttention);
    }
    {
        // Exactly on the limit satisfies the constraint. Treating 0 as a
        // violation would flag every object sitting precisely at its bound.
        const FHaybaToolCall C = MakeCall(ResultWithMargin(0.0));
        TestFalse(TEXT("a zero margin is satisfied, not violated"), C.bNeedsAttention);
    }

    // ── Worst-wins across findings ─────────────────────────────────────
    {
        const FString Result =
            TEXT("{\"ok\":true,\"validator\":{\"findings\":[")
            TEXT("{\"ruleId\":\"a\",\"measurement\":{\"value\":-0.10,\"unit\":\"m\"}},")
            TEXT("{\"ruleId\":\"b\",\"measurement\":{\"value\":-2.50,\"unit\":\"m\"}},")
            TEXT("{\"ruleId\":\"c\",\"measurement\":{\"value\":-0.30,\"unit\":\"m\"}}]}}");
        const FHaybaToolCall C = MakeCall(Result);
        // The biggest problem, not whichever was listed first.
        TestEqual(TEXT("the worst margin wins"), C.WorstMargin, -2.50, 1e-6);
        TestEqual(TEXT("and names its own rule"), C.WorstRuleId, FString(TEXT("b")));
    }

    // ── A finding with no measurement ──────────────────────────────────
    {
        const FString Result =
            TEXT("{\"ok\":true,\"validator\":{\"findings\":[")
            TEXT("{\"ruleId\":\"naming\",\"severity\":\"warning\",\"message\":\"m\"}]}}");
        const FHaybaToolCall C = MakeCall(Result);
        // Without an amount there is nothing to show beside it, and carrying
        // the amount is the entire point of this state.
        TestFalse(TEXT("a finding with no measurement is not attention"), C.bNeedsAttention);
    }

    // ── Malformed input must not throw or false-positive ───────────────
    {
        const FHaybaToolCall A = MakeCall(TEXT("{not json at all"));
        TestFalse(TEXT("unparseable JSON is not attention"), A.bNeedsAttention);

        const FHaybaToolCall B = MakeCall(TEXT("{\"validator\":\"a string, not an object\"}"));
        TestFalse(TEXT("a validator field of the wrong type is not attention"), B.bNeedsAttention);

        const FHaybaToolCall C = MakeCall(TEXT("{\"validator\":{\"findings\":{}}}"));
        TestFalse(TEXT("findings of the wrong type is not attention"), C.bNeedsAttention);

        // The word appearing in unrelated output must not trip the cheap
        // pre-filter into reporting a violation.
        const FHaybaToolCall D = MakeCall(TEXT("{\"ok\":true,\"log\":\"ran the validator\"}"));
        TestFalse(TEXT("the word validator in prose is not attention"), D.bNeedsAttention);
    }

    // ── Turn status is worst-wins across calls ─────────────────────────
    {
        FHaybaTurn Turn;
        TestEqual(TEXT("an empty turn is done"),
            (int32)Turn.Status(), (int32)EHaybaStatus::Done);

        Turn.Calls.Add(MakeCall(TEXT("{\"ok\":true}")));
        TestEqual(TEXT("all-clear is done"),
            (int32)Turn.Status(), (int32)EHaybaStatus::Done);

        Turn.Calls.Add(MakeCall(ResultWithMargin(-0.62)));
        TestEqual(TEXT("one violation makes the turn need attention"),
            (int32)Turn.Status(), (int32)EHaybaStatus::NeedsAttention);

        Turn.Calls.Add(MakeCall(TEXT("ERROR: boom")));
        TestEqual(TEXT("an error outranks needing attention"),
            (int32)Turn.Status(), (int32)EHaybaStatus::Error);
    }

    return true;
}

#endif // WITH_EDITOR
