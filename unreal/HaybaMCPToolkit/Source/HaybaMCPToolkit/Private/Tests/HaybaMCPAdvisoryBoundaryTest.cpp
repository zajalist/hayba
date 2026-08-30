#include "Misc/AutomationTest.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPAdvisoryTypes.h"
#include "Misc/ScopeExit.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Async/Async.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
    TSharedPtr<FJsonObject> ParseEnvelope(const FString& Text)
    {
        TSharedPtr<FJsonObject> Out;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
        FJsonSerializer::Deserialize(Reader, Out);
        return Out;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPAdvisoryBoundaryTest,
    "Hayba.MCP.Advisory.ResponseBoundary",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPAdvisoryBoundaryTest::RunTest(const FString&)
{
    FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
    const EHaybaMCPAdvisoryVerbosity Original = Settings.AdvisoryVerbosity;
    ON_SCOPE_EXIT
    {
        Settings.AdvisoryVerbosity = Original;
    };

    Settings.AdvisoryVerbosity = EHaybaMCPAdvisoryVerbosity::ErrorsOnly;
    {
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeErrorResponse(
                TEXT("1"),
                TEXT("python_run policy_blocked [HCR-WORLD-001]: retry unchanged forbidden"),
                TEXT("python_run")));
        TestTrue(TEXT("error envelope parses"), Envelope.IsValid());
        TestFalse(TEXT("error remains an error"), Envelope->GetBoolField(TEXT("ok")));
        TestTrue(TEXT("original error is never suppressed"), Envelope->HasField(TEXT("error")));
        const TSharedPtr<FJsonObject> Advisory = Envelope->GetObjectField(TEXT("advisory"));
        TestEqual(TEXT("policy state is machine readable"),
            Advisory->GetStringField(TEXT("state")), FString(TEXT("policy_blocked")));
        TestTrue(TEXT("ErrorsOnly keeps mandatory next action"), Advisory->HasField(TEXT("next_action")));
        TestFalse(TEXT("ErrorsOnly has no warnings"), Advisory->HasField(TEXT("warnings")));
        TestFalse(TEXT("ErrorsOnly has no tips"), Advisory->HasField(TEXT("tips")));
    }

    Settings.AdvisoryVerbosity = EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings;
    {
        TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
        Data->SetNumberField(TEXT("succeeded"), 2);
        Data->SetNumberField(TEXT("failed"), 1);
        Data->SetArrayField(TEXT("warnings"), {
            MakeShared<FJsonValueString>(TEXT("one item was rejected")) });
        Data->SetArrayField(TEXT("tips"), {
            MakeShared<FJsonValueString>(TEXT("retry only the rejected item")) });
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeOkResponse(TEXT("2"), Data, TEXT("batch_write")));
        const TSharedPtr<FJsonObject> Advisory = Envelope->GetObjectField(TEXT("advisory"));
        TestEqual(TEXT("mixed counts become partial success"),
            Advisory->GetStringField(TEXT("state")), FString(TEXT("partial_success")));
        TestTrue(TEXT("warning mode keeps warning guidance"), Advisory->HasField(TEXT("warnings")));
        TestFalse(TEXT("warning mode strips generated tips"), Advisory->HasField(TEXT("tips")));
        const TSharedPtr<FJsonObject> FilteredData = Envelope->GetObjectField(TEXT("data"));
        TestTrue(TEXT("machine success count survives filtering"), FilteredData->HasField(TEXT("succeeded")));
        TestTrue(TEXT("machine failure count survives filtering"), FilteredData->HasField(TEXT("failed")));
        TestFalse(TEXT("legacy tips are centrally filtered"), FilteredData->HasField(TEXT("tips")));
    }

    {
        TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
        Data->SetNumberField(TEXT("succeeded"), 0);
        Data->SetNumberField(TEXT("failed"), 3);
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeOkResponse(TEXT("2b"), Data, TEXT("material_set_param")));
        TestFalse(TEXT("an all-rejected batch cannot remain ok:true"), Envelope->GetBoolField(TEXT("ok")));
        TestTrue(TEXT("all-rejected batch carries an actionable top-level error"), Envelope->HasField(TEXT("error")));
        TestEqual(TEXT("all-rejected batch is input_rejected, not partial_success"),
            Envelope->GetObjectField(TEXT("advisory"))->GetStringField(TEXT("state")),
            FString(TEXT("input_rejected")));
    }

    {
        TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
        Data->SetBoolField(TEXT("ok"), false);
        Data->SetStringField(TEXT("stdout"), TEXT("before failure\n"));
        Data->SetStringField(TEXT("stderr"), TEXT("RuntimeError: boom\n"));
        Data->SetStringField(TEXT("error"), TEXT("operation rejected the input"));
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeOkResponse(TEXT("2logical"), Data, TEXT("generic_operation")));
        TestFalse(TEXT("a nested logical failure cannot remain top-level ok:true"),
            Envelope->GetBoolField(TEXT("ok")));
        TestEqual(TEXT("the handler's bounded error is promoted without operation-specific guessing"),
            Envelope->GetStringField(TEXT("error")), FString(TEXT("operation rejected the input")));
        const TSharedPtr<FJsonObject> PreservedData = Envelope->GetObjectField(TEXT("data"));
        TestEqual(TEXT("structured stderr survives truthful failure shaping"),
            PreservedData->GetStringField(TEXT("stderr")), FString(TEXT("RuntimeError: boom\n")));
        TestEqual(TEXT("logical failure has an honest unknown-outcome state"),
            Envelope->GetObjectField(TEXT("advisory"))->GetStringField(TEXT("state")),
            FString(TEXT("unknown_outcome")));
    }

    {
        TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
        Data->SetBoolField(TEXT("ok"), false);
        Data->SetStringField(TEXT("stderr"), FString::ChrN(10000, TEXT('x')));
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeOkResponse(TEXT("2bounded"), Data, TEXT("any_handler")));
        TestTrue(TEXT("promoted diagnostics have a hard bound"),
            Envelope->GetStringField(TEXT("error")).Len() <= 4096);
        TestFalse(TEXT("generic failure prose does not assume Python"),
            Envelope->GetStringField(TEXT("error")).Contains(TEXT("python"), ESearchCase::IgnoreCase));
    }

    {
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeOkResponse(
                TEXT("2c"), MakeShared<FJsonObject>(), TEXT("actor_set_transform")));
        TestEqual(TEXT("unverified mutation warns by default"),
            Envelope->GetObjectField(TEXT("advisory"))->GetStringField(TEXT("state")),
            FString(TEXT("success_needs_verification")));

        TSharedPtr<FJsonObject> VerifiedData = MakeShared<FJsonObject>();
        VerifiedData->SetBoolField(TEXT("readback_verified"), true);
        const TSharedPtr<FJsonObject> VerifiedEnvelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeOkResponse(TEXT("2d"), VerifiedData, TEXT("actor_set_transform")));
        TestFalse(TEXT("verified mutation does not emit optional warning noise"),
            VerifiedEnvelope->HasField(TEXT("advisory")));
    }

    Settings.AdvisoryVerbosity = EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips;
    {
        TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
        Data->SetNumberField(TEXT("succeeded"), 1);
        Data->SetNumberField(TEXT("failed"), 1);
        Data->SetArrayField(TEXT("warnings"), {
            MakeShared<FJsonValueString>(TEXT("partial")) });
        Data->SetArrayField(TEXT("tips"), {
            MakeShared<FJsonValueString>(TEXT("retry rejected only")) });
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeOkResponse(TEXT("3"), Data, TEXT("batch_write")));
        const TSharedPtr<FJsonObject> Advisory = Envelope->GetObjectField(TEXT("advisory"));
        TestTrue(TEXT("full mode keeps warnings"), Advisory->HasField(TEXT("warnings")));
        TestTrue(TEXT("full mode keeps AI tips"), Advisory->HasField(TEXT("tips")));
    }

    Settings.AdvisoryVerbosity = EHaybaMCPAdvisoryVerbosity::ErrorsOnly;
    {
        TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
        Data->SetStringField(TEXT("status"), TEXT("plan_mode_required"));
        Data->SetStringField(TEXT("hint"), TEXT("approve a plan"));
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeOkResponse(TEXT("4"), Data, TEXT("actor_delete")));
        TestFalse(TEXT("a policy block cannot masquerade as ok:true"), Envelope->GetBoolField(TEXT("ok")));
        TestTrue(TEXT("policy block has a top-level error"), Envelope->HasField(TEXT("error")));
        TestFalse(TEXT("ErrorsOnly strips legacy hint prose"),
            Envelope->GetObjectField(TEXT("data"))->HasField(TEXT("hint")));
        TestFalse(TEXT("ErrorsOnly strips optional policy coaching from next_action"),
            Envelope->GetObjectField(TEXT("advisory"))->HasField(TEXT("next_action")));
    }

    {
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeErrorResponse(
                TEXT("5"), TEXT("handler crashed (SEH)"), TEXT("test_run"), true));
        const TSharedPtr<FJsonObject> Advisory = Envelope->GetObjectField(TEXT("advisory"));
        TestEqual(TEXT("SEH marks the session suspect"),
            Advisory->GetStringField(TEXT("state")), FString(TEXT("session_suspect")));
        TestEqual(TEXT("SEH requires a restart-capable recovery state"),
            Advisory->GetStringField(TEXT("session_health")), FString(TEXT("suspect")));
        TestTrue(TEXT("SEH mandatory recovery survives ErrorsOnly"),
            Advisory->HasField(TEXT("mandatory_recovery")));
    }

    {
        TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
        Data->SetBoolField(TEXT("ok"), false);
        Data->SetBoolField(TEXT("compiled_clean"), true);
        Data->SetBoolField(TEXT("saved"), true);
        Data->SetBoolField(TEXT("session_suspect"), true);
        Data->SetStringField(TEXT("error"), TEXT("native stats inspection faulted after save"));
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeOkResponse(
                TEXT("5b"), Data, TEXT("material_compile")));
        TestFalse(TEXT("nested guarded native fault cannot remain ok:true"),
            Envelope->GetBoolField(TEXT("ok")));
        const TSharedPtr<FJsonObject> Advisory = Envelope->GetObjectField(TEXT("advisory"));
        TestEqual(TEXT("nested guarded native fault marks the session suspect"),
            Advisory->GetStringField(TEXT("state")), FString(TEXT("session_suspect")));
        TestTrue(TEXT("nested guarded native fault retains mandatory recovery"),
            Advisory->HasField(TEXT("mandatory_recovery")));
    }

    {
        FHaybaMCPCommandHandler Router;
        TFuture<TPair<FString, FString>> OffThread = Async(EAsyncExecution::Thread, [&Router]()
        {
            return TPair<FString, FString>(
                Router.ProcessCommand(TEXT("{\"id\":\"thread\",\"cmd\":\"ping\",\"params\":{}}")),
                Router.ProcessCommand(TEXT("not valid JSON")));
        });
        const TPair<FString, FString> Responses = OffThread.Get();
        TestEqual(TEXT("off-thread refusal is fixed before JSON parsing"),
            Responses.Key, Responses.Value);
        const TSharedPtr<FJsonObject> Envelope = ParseEnvelope(Responses.Key);
        TestTrue(TEXT("off-thread command refusal parses"), Envelope.IsValid());
        TestFalse(TEXT("off-thread command never dispatches"), Envelope->GetBoolField(TEXT("ok")));
        TestEqual(TEXT("off-thread refusal does not parse or echo the request id"),
            Envelope->GetStringField(TEXT("id")), FString());
        TestTrue(TEXT("off-thread refusal proves no operation started"),
            Envelope->GetStringField(TEXT("error")).Contains(TEXT("no operation was started")));
    }

    {
        const FString SameError = TEXT("target asset not found");
        const TSharedPtr<FJsonObject> PostDispatch = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeErrorResponse(
                TEXT("6"), SameError, TEXT("asset_mutate")));
        TestEqual(TEXT("handler prose cannot invent that mutation never started"),
            PostDispatch->GetObjectField(TEXT("advisory"))->GetStringField(TEXT("state")),
            FString(TEXT("unknown_outcome")));

        const TSharedPtr<FJsonObject> KnownPreflight = ParseEnvelope(
            FHaybaMCPCommandHandler::MakeErrorResponse(
                TEXT("7"), SameError, TEXT("asset_mutate"), false, true));
        TestEqual(TEXT("the same error is input_rejected only with a proven preflight fact"),
            KnownPreflight->GetObjectField(TEXT("advisory"))->GetStringField(TEXT("state")),
            FString(TEXT("input_rejected")));
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
