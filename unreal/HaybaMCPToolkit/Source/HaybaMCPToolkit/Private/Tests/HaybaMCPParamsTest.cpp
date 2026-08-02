#include "Misc/AutomationTest.h"
#include "HaybaMCPParams.h"

#if WITH_EDITOR
#include "handlers/HaybaMCPVaultHandler.h"
#endif

// ── FHaybaParamReader ───────────────────────────────────────────────────────

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPParamReaderTest,
    "Hayba.MCP.Params.Reader",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPParamReaderTest::RunTest(const FString& Parameters)
{
    // Reads what is there.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("path"), TEXT("/Game/Foo"));
        P->SetNumberField(TEXT("size"), 24.0);
        P->SetBoolField(TEXT("flag"), true);

        FHaybaParamReader R(P, TEXT("cmd"));
        TestEqual(TEXT("required string reads"), R.RequiredString(TEXT("path")), FString(TEXT("/Game/Foo")));
        TestEqual(TEXT("required number reads"), R.RequiredNumber(TEXT("size")), 24.0);
        TestTrue(TEXT("optional bool reads"), R.OptionalBool(TEXT("flag")));
        TestFalse(TEXT("no errors when everything is present"), R.HasErrors());
    }

    // Defaults for absent optionals — and absent optionals are NOT errors.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        FHaybaParamReader R(P, TEXT("cmd"));
        TestEqual(TEXT("optional string default"), R.OptionalString(TEXT("nope"), TEXT("fallback")), FString(TEXT("fallback")));
        TestEqual(TEXT("optional number default"), R.OptionalNumber(TEXT("nope"), 7.5), 7.5);
        TestTrue(TEXT("optional bool default"), R.OptionalBool(TEXT("nope"), true));
        TestEqual(TEXT("optional int default"), R.OptionalInt(TEXT("nope"), 3), 3);
        TestFalse(TEXT("absent optionals are not errors"), R.HasErrors());
    }

    // The whole point: every problem reported at once, not one per round trip.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        FHaybaParamReader R(P, TEXT("copilot_key_set"));
        R.RequiredString(TEXT("provider"));
        R.RequiredString(TEXT("api_key"));
        TestTrue(TEXT("missing required fields are errors"), R.HasErrors());

        const FString Msg = R.ErrorMessage();
        TestTrue(TEXT("message names the command"), Msg.Contains(TEXT("copilot_key_set")));
        TestTrue(TEXT("message names the first missing field"), Msg.Contains(TEXT("provider")));
        TestTrue(TEXT("message names the second missing field too"), Msg.Contains(TEXT("api_key")));
    }

    // A present-but-empty required string is the shape of a caller that built a
    // value and got nothing. Caught here rather than failing further away.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("provider"), TEXT(""));
        FHaybaParamReader R(P, TEXT("cmd"));
        R.RequiredString(TEXT("provider"));
        TestTrue(TEXT("empty required string is an error"), R.HasErrors());
        TestTrue(TEXT("message says present-but-empty"), R.ErrorMessage().Contains(TEXT("empty")));
    }

    // A null params object is a different bug from "every field missing", and
    // must not produce one error per field the handler happens to ask for.
    {
        FHaybaParamReader R(nullptr, TEXT("cmd"));
        R.RequiredString(TEXT("a"));
        R.RequiredString(TEXT("b"));
        R.RequiredNumber(TEXT("c"));
        TestTrue(TEXT("null params is an error"), R.HasErrors());
        const FString Msg = R.ErrorMessage();
        TestTrue(TEXT("says no params object"), Msg.Contains(TEXT("no params object")));
        TestFalse(TEXT("does not also list individual fields"), Msg.Contains(TEXT("'a'")));
    }

    // Wrong type counts as missing — reading a string field as a number must
    // not silently yield 0.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("size"), TEXT("not-a-number"));
        FHaybaParamReader R(P, TEXT("cmd"));
        R.RequiredNumber(TEXT("size"));
        TestTrue(TEXT("wrong-typed required field is an error"), R.HasErrors());
    }

    // AddError lets a handler report a problem the reader cannot see, and it
    // joins the same message.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("provider"), TEXT("openai"));
        FHaybaParamReader R(P, TEXT("cmd"));
        R.RequiredString(TEXT("provider"));
        TestFalse(TEXT("valid so far"), R.HasErrors());
        R.AddError(TEXT("scale must be between 0.1 and 4.0"));
        TestTrue(TEXT("AddError registers"), R.HasErrors());
        TestTrue(TEXT("AddError text is in the message"), R.ErrorMessage().Contains(TEXT("scale must be")));
    }

    return true;
}

// ── Vault handler ───────────────────────────────────────────────────────────

#if WITH_EDITOR

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPVaultHandlerTest,
    "Hayba.MCP.Vault.Handler",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPVaultHandlerTest::RunTest(const FString& Parameters)
{
    FHaybaMCPVaultHandler Handler;

    // The five commands moved out of ProcessCommand must all be declared, or
    // they are unreachable — the exact failure this extraction could cause.
    {
        const TArray<FString> Cmds = Handler.GetCommands();
        TestEqual(TEXT("declares five commands"), Cmds.Num(), 5);
        for (const TCHAR* Expected : { TEXT("get_setting"), TEXT("copilot_key_status"),
                                       TEXT("copilot_get_key"), TEXT("copilot_key_set"),
                                       TEXT("copilot_key_clear") })
        {
            TestTrue(FString::Printf(TEXT("declares %s"), Expected), Cmds.Contains(FString(Expected)));
        }
        TestEqual(TEXT("domain is vault"), Handler.GetDomain(), FString(TEXT("vault")));
    }

    // get_setting is an ALLOWLIST, not a general settings reader: an arbitrary
    // field read would expose every developer setting, including ones added
    // later by someone who never considered this command.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("key"), TEXT("some_other_setting"));
        const FHaybaHandlerResult R = Handler.Handle(TEXT("get_setting"), P);
        TestFalse(TEXT("non-allowlisted setting is refused"), R.bOk);
        TestTrue(TEXT("refusal names the key"), R.ErrorMessage.Contains(TEXT("some_other_setting")));
    }

    // The allowlisted key is readable and reports whether it is configured
    // WITHOUT the caller having to guess from a null.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("key"), TEXT("sketchfab_api_token"));
        const FHaybaHandlerResult R = Handler.Handle(TEXT("get_setting"), P);
        TestTrue(TEXT("allowlisted setting is readable"), R.bOk);
        if (R.bOk && R.Data.IsValid())
        {
            bool bSet = true;
            TestTrue(TEXT("reports a `set` flag"), R.Data->TryGetBoolField(TEXT("set"), bSet));
        }
    }

    // Missing required params come back named, through the reader.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        const FHaybaHandlerResult R = Handler.Handle(TEXT("get_setting"), P);
        TestFalse(TEXT("missing key is rejected"), R.bOk);
        TestTrue(TEXT("error names the command"), R.ErrorMessage.Contains(TEXT("get_setting")));
        TestTrue(TEXT("error names the field"), R.ErrorMessage.Contains(TEXT("key")));
    }

    // copilot_key_set reports BOTH missing fields at once — the regression the
    // param reader exists to prevent.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        const FHaybaHandlerResult R = Handler.Handle(TEXT("copilot_key_set"), P);
        TestFalse(TEXT("missing provider+api_key is rejected"), R.bOk);
        TestTrue(TEXT("names provider"), R.ErrorMessage.Contains(TEXT("provider")));
        TestTrue(TEXT("names api_key in the SAME message"), R.ErrorMessage.Contains(TEXT("api_key")));
    }

    // copilot_key_status must never return key material, only a last-4.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        const FHaybaHandlerResult R = Handler.Handle(TEXT("copilot_key_status"), P);
        TestTrue(TEXT("key_status succeeds with no provider"), R.bOk);
        if (R.bOk && R.Data.IsValid())
        {
            const TArray<TSharedPtr<FJsonValue>>* Providers = nullptr;
            TestTrue(TEXT("returns a providers array"), R.Data->TryGetArrayField(TEXT("providers"), Providers));
            TestFalse(TEXT("never returns a `key` field"), R.Data->HasField(TEXT("key")));
        }
    }

    // An unknown command reaching this handler is a routing bug; it must say so
    // rather than return an empty success.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        const FHaybaHandlerResult R = Handler.Handle(TEXT("not_a_vault_command"), P);
        TestFalse(TEXT("unknown command is an error"), R.bOk);
    }

    return true;
}

#endif // WITH_EDITOR

// ── PIE input coordinate space ──────────────────────────────────────────────
//
// Regression test for the 24px click offset. Before the fix, editor_pie_mouse
// added the game window's on-screen origin to whatever it was given — including
// the absolute desktop coordinates editor_pie_widget_tree reports and tells
// callers to pass straight through. Every click landed low and right by the
// window chrome, which is invisible on a 60px button and fatal on a 26px text
// field or a 33px tab.
//
// The assertion that would have failed before the fix is the first one: an
// absolute coordinate must come back UNCHANGED.

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPPieCoordSpaceTest,
    "Hayba.MCP.PIE.CoordinateSpace",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPPieCoordSpaceTest::RunTest(const FString& Parameters)
{
    // The measured case: PIE window at desktop (0,24), username field reported
    // by editor_pie_widget_tree at desktop y=576.11, rendering at window-
    // relative y=552.
    const FVector2D WindowOrigin(0.0, 24.0);
    const FVector2D ReportedByWidgetTree(959.9999030828476, 576.1105942858376);

    {
        const FVector2D Out = HaybaPieCoords::ToAbsolute(ReportedByWidgetTree, WindowOrigin, /*bViewportRelative=*/false);
        // THE REGRESSION. The old code returned 600.11 here and the click missed
        // the 26px-tall field entirely.
        TestEqual(TEXT("absolute input passes through untouched (x)"), Out.X, ReportedByWidgetTree.X);
        TestEqual(TEXT("absolute input passes through untouched (y)"), Out.Y, ReportedByWidgetTree.Y);
    }

    {
        // Viewport-relative input still gets the origin, so a caller who really
        // did measure from the window is unaffected.
        const FVector2D WindowRelative(959.9999030828476, 552.1105942858376);
        const FVector2D Out = HaybaPieCoords::ToAbsolute(WindowRelative, WindowOrigin, /*bViewportRelative=*/true);
        TestEqual(TEXT("viewport-relative input gains the window origin"), Out.Y, ReportedByWidgetTree.Y);
    }

    {
        // The offset must never be a constant. A borderless window at the origin
        // has none, and the same input must then resolve identically in both
        // spaces — a hardcoded 24 would break exactly here.
        const FVector2D NoChrome(0.0, 0.0);
        const FVector2D P(100.0, 200.0);
        TestEqual(TEXT("no chrome, absolute"), HaybaPieCoords::ToAbsolute(P, NoChrome, false).Y, 200.0);
        TestEqual(TEXT("no chrome, viewport-relative"), HaybaPieCoords::ToAbsolute(P, NoChrome, true).Y, 200.0);
    }

    {
        // A window moved away from the screen origin offsets both axes, so the
        // X component has to be carried too — the bug was symmetrical and only
        // looked vertical because the window happened to sit at x=0.
        const FVector2D Moved(640.0, 480.0);
        const FVector2D P(10.0, 20.0);
        const FVector2D Out = HaybaPieCoords::ToAbsolute(P, Moved, true);
        TestEqual(TEXT("moved window offsets x"), Out.X, 650.0);
        TestEqual(TEXT("moved window offsets y"), Out.Y, 500.0);
    }

    return true;
}

// ── PIE drag gesture planning ───────────────────────────────────────────────
//
// Regression test for the dead-drag defect (Aphrosia docs/gauntlet/scroll-dossier.md,
// 2026-08-02): a press on a scrollbar thumb followed by moves left the scroll
// offset at exactly 0.000000, across both action:"drag" and manual
// press/move/move/release, and right-click drag-scrolling on the content failed
// identically.
//
// SScrollBar::OnMouseMove is the reference consumer and is unambiguous:
//
//     if (this->HasMouseCapture())
//         if (!MouseEvent.GetCursorDelta().IsZero())
//             ... scroll ...
//     return FReply::Unhandled();
//
// So the ONE property every dispatched move must have is a non-zero cursor
// delta. The runtime half of that (read the origin before SetCursorPos, because
// FSlateUser::UpdatePointerPosition writes the destination to BOTH the current
// and the previous position) needs a live FSlateApplication and is covered by
// docs/VERIFY-pie-input-gestures.md. This test covers the half that is pure
// arithmetic: that the planned path never contains a step Slate would quantise
// down to a zero delta, and that it ends where the caller said.

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPPieDragPathTest,
    "Hayba.MCP.PIE.DragPath",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPPieDragPathTest::RunTest(const FString& Parameters)
{
    using namespace HaybaPieGesture;

    // The measured case: dragging the Profile chronicle scrollbar thumb down the
    // track, desktop (1424.6, 700) -> (1424.6, 1000).
    {
        const FVector2D Start(1424.6, 700.0);
        const FVector2D End(1424.6, 1000.0);
        const TArray<FVector2D> Path = PlanDragPath(Start, End, 8);

        TestEqual(TEXT("a 300px drag in 8 steps plans 8 waypoints"), Path.Num(), 8);

        // THE REGRESSION. Every consecutive pair must differ, because a repeated
        // position is a zero delta and a zero delta is not a small move — it is
        // no move at all as far as SScrollBar is concerned.
        FVector2D Prev = QuantiseToPixel(Start);
        for (int32 i = 0; i < Path.Num(); ++i)
        {
            const FVector2D Delta = Path[i] - Prev;
            TestTrue(FString::Printf(TEXT("step %d carries a non-zero cursor delta"), i), !Delta.IsZero());
            Prev = Path[i];
        }

        // A drag has to finish where it was told to finish, or the caller's
        // arithmetic about "how far did the thumb travel" is wrong.
        TestEqual(TEXT("the path ends on the destination"), Path.Last().Y, 1000.0);
        TestEqual(TEXT("the path holds the unchanging axis"), Path.Last().X, 1424.0);
    }

    // Sub-pixel steps are the trap. Slate truncates pointer positions to whole
    // pixels (FSlateUser::SetCursorPosition takes int32), so a 3px drag split
    // into 8 steps has five waypoints that land on a pixel already visited.
    // Dispatching those is dispatching zero-delta moves.
    {
        const TArray<FVector2D> Path = PlanDragPath(FVector2D(100.0, 100.0), FVector2D(100.0, 103.0), 8);
        TestEqual(TEXT("a 3px drag plans exactly 3 whole-pixel waypoints"), Path.Num(), 3);
        TestEqual(TEXT("first waypoint"), Path[0].Y, 101.0);
        TestEqual(TEXT("last waypoint is the destination"), Path.Last().Y, 103.0);
    }

    // A zero-length drag must plan NOTHING rather than a move that cannot move.
    // Reporting "0 moves delivered" is the honest answer; silently dispatching
    // eight no-ops and returning dispatched:true is how a harness fault gets
    // read as a widget fault.
    {
        const TArray<FVector2D> Path = PlanDragPath(FVector2D(500.0, 500.0), FVector2D(500.4, 500.4), 8);
        TestEqual(TEXT("a sub-pixel drag plans no moves at all"), Path.Num(), 0);
    }

    // Diagonal, and backwards: the fix must not be axis- or sign-specific. The
    // right-click drag-scroll path reads the same delta with the opposite sign.
    {
        const TArray<FVector2D> Path = PlanDragPath(FVector2D(800.0, 600.0), FVector2D(700.0, 500.0), 4);
        TestEqual(TEXT("backwards diagonal plans 4 waypoints"), Path.Num(), 4);
        TestEqual(TEXT("ends at the destination x"), Path.Last().X, 700.0);
        TestEqual(TEXT("ends at the destination y"), Path.Last().Y, 500.0);
        FVector2D Prev = QuantiseToPixel(FVector2D(800.0, 600.0));
        for (const FVector2D& Pt : Path)
        {
            TestTrue(TEXT("every backwards step moves"), !(Pt - Prev).IsZero());
            Prev = Pt;
        }
    }

    // Steps is clamped, not trusted: steps:0 would divide by zero and a caller
    // asking for 100000 would hang the game thread inside one command.
    {
        TestEqual(TEXT("steps:0 still plans the gesture"), PlanDragPath(FVector2D(0, 0), FVector2D(0, 50), 0).Num(), 1);
        TestTrue(TEXT("steps is clamped from above"), PlanDragPath(FVector2D(0, 0), FVector2D(0, 5000), 100000).Num() <= 256);
    }

    // The quantiser must model the engine's cast, not a rounding of convenience.
    // FSlateUser::SetCursorPosition does (int32)X — truncation toward zero.
    {
        TestEqual(TEXT("truncates, does not round"), QuantiseToPixel(FVector2D(10.9, 10.9)).X, 10.0);
        TestEqual(TEXT("truncates toward zero on the left of the primary display"),
                  QuantiseToPixel(FVector2D(-10.9, 0.0)).X, -10.0);
    }

    // DeltaFor is what callers should reason with: the delta Slate will REPORT,
    // not the one they asked for.
    {
        TestEqual(TEXT("a sub-pixel request reports a zero delta"),
                  DeltaFor(FVector2D(10.1, 10.1), FVector2D(10.9, 10.9)).Y, 0.0);
        TestEqual(TEXT("a whole-pixel request reports it"),
                  DeltaFor(FVector2D(10.0, 10.0), FVector2D(10.0, 25.0)).Y, 15.0);
    }

    return true;
}
