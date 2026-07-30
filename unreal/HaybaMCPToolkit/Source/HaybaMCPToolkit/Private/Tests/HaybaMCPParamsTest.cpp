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
