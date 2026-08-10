#include "Misc/AutomationTest.h"
#include "HaybaMCPParams.h"
#include "HaybaMCPSettings.h"
#include <limits>

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

    // Wrong type is distinct from missing — reading a string field as a number
    // must not silently yield 0 or tell the caller that it omitted the field.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("size"), TEXT("not-a-number"));
        FHaybaParamReader R(P, TEXT("cmd"));
        R.RequiredNumber(TEXT("size"));
        TestTrue(TEXT("wrong-typed required field is an error"), R.HasErrors());
    }

    // JSON numbers can decode to non-finite doubles (or exceed an int32) even
    // though Unreal transforms, array indices and allocation sizes cannot use
    // them safely. The shared reader is the earliest common rejection point.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetNumberField(TEXT("required"), std::numeric_limits<double>::infinity());
        P->SetNumberField(TEXT("optional"), std::numeric_limits<double>::quiet_NaN());
        P->SetNumberField(TEXT("integer"), static_cast<double>(MAX_int32) + 1.0);
        TArray<TSharedPtr<FJsonValue>> Vec = {
            MakeShared<FJsonValueNumber>(1.0),
            MakeShared<FJsonValueNumber>(std::numeric_limits<double>::infinity()),
            MakeShared<FJsonValueNumber>(3.0),
        };
        P->SetArrayField(TEXT("location"), Vec);

        FHaybaParamReader R(P, TEXT("cmd"));
        TestEqual(TEXT("non-finite required number falls back safely"), R.RequiredNumber(TEXT("required")), 0.0);
        TestEqual(TEXT("non-finite optional number uses its default"), R.OptionalNumber(TEXT("optional"), 7.0), 7.0);
        TestEqual(TEXT("out-of-range integer uses its default"), R.OptionalInt(TEXT("integer"), 9), 9);
        TestFalse(TEXT("non-finite vector is unset"), R.OptionalVec3(TEXT("location")).IsSet());
        TestTrue(TEXT("all hostile numeric shapes are errors"), R.HasErrors());
        TestTrue(TEXT("error identifies finite requirement"), R.ErrorMessage().Contains(TEXT("finite")));
        TestTrue(TEXT("error identifies integer requirement"), R.ErrorMessage().Contains(TEXT("integer in")));
    }

    // Structured primitives keep their contract and diagnostics in the reader
    // instead of asking every handler to re-invent enum/path/color/transform
    // parsing immediately before it calls an engine API.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("mode"), TEXT("safe"));
        P->SetStringField(TEXT("asset"), TEXT("/Game/Foo/Bar.Bar"));
        P->SetArrayField(TEXT("color"), {
            MakeShared<FJsonValueNumber>(0.1),
            MakeShared<FJsonValueNumber>(0.2),
            MakeShared<FJsonValueNumber>(0.3),
            MakeShared<FJsonValueNumber>(0.4),
        });
        TSharedPtr<FJsonObject> Transform = MakeShared<FJsonObject>();
        Transform->SetArrayField(TEXT("location"), {
            MakeShared<FJsonValueNumber>(1.0),
            MakeShared<FJsonValueNumber>(2.0),
            MakeShared<FJsonValueNumber>(3.0),
        });
        Transform->SetArrayField(TEXT("rotation"), {
            MakeShared<FJsonValueNumber>(10.0),
            MakeShared<FJsonValueNumber>(20.0),
            MakeShared<FJsonValueNumber>(30.0),
        });
        Transform->SetArrayField(TEXT("scale"), {
            MakeShared<FJsonValueNumber>(1.0),
            MakeShared<FJsonValueNumber>(2.0),
            MakeShared<FJsonValueNumber>(1.0),
        });
        P->SetObjectField(TEXT("transform"), Transform);
        P->SetNumberField(TEXT("radius"), 250.0);
        P->SetNumberField(TEXT("density"), 0.75);
        P->SetArrayField(TEXT("items"), { MakeShared<FJsonValueString>(TEXT("one")) });

        FHaybaParamReader R(P, TEXT("structured"));
        TestEqual(TEXT("enum normalizes to canonical spelling"),
            R.RequiredEnum(TEXT("mode"), { TEXT("Fast"), TEXT("Safe") }),
            FString(TEXT("Safe")));
        TestEqual(TEXT("safe game path survives"),
            R.RequiredGamePath(TEXT("asset")), FString(TEXT("/Game/Foo/Bar.Bar")));
        const TOptional<FLinearColor> Color = R.OptionalColor(TEXT("color"));
        TestTrue(TEXT("normalized color parses"), Color.IsSet());
        if (Color.IsSet()) TestEqual(TEXT("color alpha"), Color->A, 0.4f);
        const TOptional<FTransform> ParsedTransform = R.OptionalTransform(TEXT("transform"));
        TestTrue(TEXT("transform parses"), ParsedTransform.IsSet());
        if (ParsedTransform.IsSet())
        {
            TestEqual(TEXT("transform location"), ParsedTransform->GetLocation(), FVector(1.0, 2.0, 3.0));
            TestEqual(TEXT("transform scale"), ParsedTransform->GetScale3D(), FVector(1.0, 2.0, 1.0));
        }
        TestEqual(TEXT("bounded radius"), R.RequiredRadius(TEXT("radius"), 1000.0), 250.0);
        TestEqual(TEXT("bounded density"), R.OptionalDensity(TEXT("density"), 1.0, 10.0), 0.75);
        TestNotNull(TEXT("required non-empty array"), R.RequiredArray(TEXT("items"), 1, 4));
        TestFalse(TEXT("valid structured payload has no errors"), R.HasErrors());
    }

    // Hostile nested shapes report precise field paths and observed value
    // classes without echoing the payload. Independent problems accumulate.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetNumberField(TEXT("mode"), 2.0);
        P->SetStringField(TEXT("asset"), TEXT("/Game/Good/../Private"));
        P->SetArrayField(TEXT("color"), {
            MakeShared<FJsonValueNumber>(0.0),
            MakeShared<FJsonValueNumber>(2.0),
            MakeShared<FJsonValueString>(TEXT("secret-untrusted-value")),
        });
        TSharedPtr<FJsonObject> Transform = MakeShared<FJsonObject>();
        Transform->SetArrayField(TEXT("location"), {
            MakeShared<FJsonValueNumber>(1.0),
            MakeShared<FJsonValueString>(TEXT("private-large-value")),
            MakeShared<FJsonValueNumber>(std::numeric_limits<double>::infinity()),
        });
        P->SetObjectField(TEXT("transform"), Transform);
        P->SetNumberField(TEXT("radius"), -1.0);
        P->SetNumberField(TEXT("density"), 1.0e300);
        P->SetArrayField(TEXT("empty_items"), {});
        P->SetObjectField(TEXT("empty_object"), MakeShared<FJsonObject>());
        P->SetField(TEXT("null_object"), MakeShared<FJsonValueNull>());

        FHaybaParamReader R(P, TEXT("structured_hostile"));
        R.RequiredEnum(TEXT("mode"), { TEXT("Fast"), TEXT("Safe") });
        R.RequiredGamePath(TEXT("asset"));
        TestFalse(TEXT("bad color is unset"), R.OptionalColor(TEXT("color")).IsSet());
        TestFalse(TEXT("bad transform is unset"), R.OptionalTransform(TEXT("transform")).IsSet());
        R.RequiredRadius(TEXT("radius"), 1000.0);
        R.OptionalDensity(TEXT("density"), 1.0, 100.0);
        TestNull(TEXT("required empty array is rejected"), R.RequiredArray(TEXT("empty_items"), 1, 4));
        TestFalse(TEXT("required empty object is rejected"),
            R.RequiredObject(TEXT("empty_object"), 1, 4).IsValid());
        TestFalse(TEXT("explicit null object is rejected"),
            R.RequiredObject(TEXT("null_object"), 1, 4).IsValid());
        TestTrue(TEXT("hostile structured payload accumulates errors"), R.HasErrors());
        const FString Msg = R.ErrorMessage();
        for (const TCHAR* Evidence : {
            TEXT("mode"), TEXT("observed number"), TEXT("asset"), TEXT("color[1]"),
            TEXT("color[2]"), TEXT("transform.location[1]"), TEXT("transform.location[2]"),
            TEXT("radius"), TEXT("density"), TEXT("empty_items"), TEXT("empty_object"),
            TEXT("null_object"), TEXT("observed null") })
        {
            TestTrue(FString::Printf(TEXT("diagnostic contains %s"), Evidence), Msg.Contains(Evidence));
        }
        TestFalse(TEXT("diagnostic never echoes untrusted color text"),
            Msg.Contains(TEXT("secret-untrusted-value")));
        TestFalse(TEXT("diagnostic never echoes untrusted nested text"),
            Msg.Contains(TEXT("private-large-value")));
    }

    // Numeric boundary table: valid int32 edges survive; fractional, overflow,
    // infinities and values outside a declared range are all rejected.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetNumberField(TEXT("min_int"), static_cast<double>(MIN_int32));
        P->SetNumberField(TEXT("max_int"), static_cast<double>(MAX_int32));
        P->SetNumberField(TEXT("fractional"), 0.5);
        P->SetNumberField(TEXT("overflow"), static_cast<double>(MAX_int32) + 1.0);
        P->SetNumberField(TEXT("negative_inf"), -std::numeric_limits<double>::infinity());
        P->SetNumberField(TEXT("huge"), 1.0e300);
        FHaybaParamReader R(P, TEXT("numeric_boundaries"));
        TestEqual(TEXT("minimum int32 accepted"), R.RequiredInt(TEXT("min_int")), MIN_int32);
        TestEqual(TEXT("maximum int32 accepted"), R.RequiredInt(TEXT("max_int")), MAX_int32);
        TestEqual(TEXT("fractional integer rejected"), R.RequiredInt(TEXT("fractional")), 0);
        TestEqual(TEXT("overflow integer rejected"), R.RequiredInt(TEXT("overflow")), 0);
        TestEqual(TEXT("negative infinity rejected"), R.RequiredNumber(TEXT("negative_inf")), 0.0);
        TestEqual(TEXT("huge range value rejected"),
            R.RequiredNumberInRange(TEXT("huge"), -1000.0, 1000.0), 0.0);
        TestTrue(TEXT("hostile numeric boundary table reports errors"), R.HasErrors());
    }

    // Deterministic property sweep: every generated finite value either passes
    // unchanged inside the declared interval or is rejected to the safe
    // in-range fallback. This catches future casts/coercions at more than a few
    // hand-picked boundary literals without making the test nondeterministic.
    {
        uint32 State = 0xA17E5EEDu;
        for (int32 Iteration = 0; Iteration < 512; ++Iteration)
        {
            State = State * 1664525u + 1013904223u;
            const int32 SignedBucket = static_cast<int32>(State % 40001u) - 20000;
            const double Value = static_cast<double>(SignedBucket) / 10.0;
            TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
            P->SetNumberField(TEXT("value"), Value);
            FHaybaParamReader R(P, TEXT("seeded_numeric_property"));
            const double Parsed = R.RequiredNumberInRange(TEXT("value"), -100.0, 100.0);
            const bool bExpectedValid = Value >= -100.0 && Value <= 100.0;
            TestEqual(FString::Printf(TEXT("seeded numeric validity %d"), Iteration),
                !R.HasErrors(), bExpectedValid);
            TestEqual(FString::Printf(TEXT("seeded numeric value %d"), Iteration),
                Parsed, bExpectedValid ? Value : 0.0);
        }
    }

    // "Optional" describes absence, not malformed presence. Wrong JSON kinds
    // used to turn into defaults silently, so a caller could send `false` as a
    // string, an object as an array, or a four-component vector and still reach
    // editor mutation with values it never asked for.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetNumberField(TEXT("maybe_string"), 1.0);
        P->SetStringField(TEXT("maybe_bool"), TEXT("true"));
        P->SetStringField(TEXT("maybe_array"), TEXT("not-an-array"));
        P->SetArrayField(TEXT("maybe_object"), {});
        P->SetStringField(TEXT("maybe_vec"), TEXT("1,2,3"));
        P->SetStringField(TEXT("bounded_string"), TEXT("four"));
        P->SetArrayField(TEXT("bounded_array"), {
            MakeShared<FJsonValueNumber>(1.0),
            MakeShared<FJsonValueNumber>(2.0),
            MakeShared<FJsonValueNumber>(3.0),
        });
        TSharedPtr<FJsonObject> TooWide = MakeShared<FJsonObject>();
        TooWide->SetBoolField(TEXT("a"), true);
        TooWide->SetBoolField(TEXT("b"), true);
        P->SetObjectField(TEXT("bounded_object"), TooWide);
        P->SetArrayField(TEXT("four_vector"), {
            MakeShared<FJsonValueNumber>(1.0),
            MakeShared<FJsonValueNumber>(2.0),
            MakeShared<FJsonValueNumber>(3.0),
            MakeShared<FJsonValueNumber>(4.0),
        });
        P->SetNumberField(TEXT("radius"), -1.0);
        P->SetNumberField(TEXT("steps"), 99.0);
        P->SetNumberField(TEXT("required_range"), 11.0);
        P->SetNumberField(TEXT("required_integer"), 1.5);

        FHaybaParamReader R(P, TEXT("hostile_shapes"));
        TestEqual(TEXT("wrong optional string uses default"),
            R.OptionalString(TEXT("maybe_string"), TEXT("fallback")), FString(TEXT("fallback")));
        TestTrue(TEXT("wrong optional bool uses default"), R.OptionalBool(TEXT("maybe_bool"), true));
        TestNull(TEXT("wrong optional array is unset"), R.OptionalArray(TEXT("maybe_array")));
        TestFalse(TEXT("wrong optional object is unset"), R.OptionalObject(TEXT("maybe_object")).IsValid());
        TestFalse(TEXT("wrong optional vector is unset"), R.OptionalVec3(TEXT("maybe_vec")).IsSet());
        TestEqual(TEXT("oversized optional string uses default"),
            R.OptionalString(TEXT("bounded_string"), TEXT("fallback"), 3), FString(TEXT("fallback")));
        TestNull(TEXT("oversized array is unset"), R.OptionalArray(TEXT("bounded_array"), 2));
        TestFalse(TEXT("oversized object is unset"), R.OptionalObject(TEXT("bounded_object"), 1).IsValid());
        TestFalse(TEXT("vector requires exactly three components"), R.OptionalVec3(TEXT("four_vector")).IsSet());
        TestEqual(TEXT("number range violation uses default"),
            R.OptionalNumberInRange(TEXT("radius"), 5.0, 0.0, 10.0), 5.0);
        TestEqual(TEXT("integer range violation uses default"),
            R.OptionalIntInRange(TEXT("steps"), 4, 1, 16), 4);
        TestEqual(TEXT("required range violation returns a safe in-range fallback"),
            R.RequiredNumberInRange(TEXT("required_range"), 0.0, 10.0), 0.0);
        TestEqual(TEXT("fractional required integer returns a safe fallback"),
            R.RequiredInt(TEXT("required_integer")), 0);
        TestFalse(TEXT("missing required vector is unset"),
            R.RequiredVec3(TEXT("required_vector")).IsSet());
        TestTrue(TEXT("all malformed present optionals are errors"), R.HasErrors());
        const FString Msg = R.ErrorMessage();
        for (const TCHAR* Field : {
            TEXT("maybe_string"), TEXT("maybe_bool"), TEXT("maybe_array"), TEXT("maybe_object"),
            TEXT("maybe_vec"), TEXT("bounded_string"), TEXT("bounded_array"), TEXT("bounded_object"),
            TEXT("four_vector"), TEXT("radius"), TEXT("steps"), TEXT("required_range"),
            TEXT("required_integer"), TEXT("required_vector") })
        {
            TestTrue(FString::Printf(TEXT("error names %s"), Field), Msg.Contains(Field));
        }
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

    // Diagnostics expose the active verbosity without adding it to every
    // ordinary response. The value is a stable wire spelling, not enum ordinal.
    {
        TestEqual(TEXT("ErrorsOnly wire spelling"),
            FString(FHaybaMCPSettings::AdvisoryVerbosityWireName(
                EHaybaMCPAdvisoryVerbosity::ErrorsOnly)),
            FString(TEXT("errors_only")));
        TestEqual(TEXT("ErrorsAndWarnings wire spelling"),
            FString(FHaybaMCPSettings::AdvisoryVerbosityWireName(
                EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings)),
            FString(TEXT("errors_and_warnings")));
        TestEqual(TEXT("ErrorsWarningsAndTips wire spelling"),
            FString(FHaybaMCPSettings::AdvisoryVerbosityWireName(
                EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips)),
            FString(TEXT("errors_warnings_and_tips")));

        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("key"), TEXT("advisory_verbosity"));
        const FHaybaHandlerResult R = Handler.Handle(TEXT("get_setting"), P);
        TestTrue(TEXT("advisory verbosity is introspectable"), R.bOk);
        if (R.bOk && R.Data.IsValid())
        {
            FString Value;
            TestTrue(TEXT("verbosity has a string value"),
                R.Data->TryGetStringField(TEXT("value"), Value));
            TestTrue(TEXT("verbosity uses a stable wire spelling"),
                Value == TEXT("errors_only")
                || Value == TEXT("errors_and_warnings")
                || Value == TEXT("errors_warnings_and_tips"));
        }
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
