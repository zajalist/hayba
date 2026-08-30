#include "Misc/AutomationTest.h"
#include "HaybaMCPAdvisory.h"
#include "Dom/JsonValue.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPAdvisoryStatesTest,
    "Hayba.MCP.Advisory.AllStates",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPAdvisoryStatesTest::RunTest(const FString&)
{
    using namespace HaybaMCPAdvisory;

    struct FCase
    {
        FString Label;
        FHaybaMCPAdvisorySignals Signals;
        EHaybaMCPAdvisoryState ExpectedState;
        FString ExpectedCode;
    };
    TArray<FCase> Cases;
    auto AddCase = [&Cases](const TCHAR* Label, const FHaybaMCPAdvisorySignals& Signals,
                            EHaybaMCPAdvisoryState State, const TCHAR* Code)
    {
        FCase& Case = Cases.AddDefaulted_GetRef();
        Case.Label = Label;
        Case.Signals = Signals;
        Case.ExpectedState = State;
        Case.ExpectedCode = Code;
    };

    FHaybaMCPAdvisorySignals Signals;
    Signals.Operation = TEXT("probe");
    AddCase(TEXT("plain success"), Signals, EHaybaMCPAdvisoryState::Success, TEXT("ok"));

    Signals.bNeedsVerification = true;
    Signals.MutationStatus = EHaybaMCPMutationStatus::Applied;
    AddCase(TEXT("successful write needs verification"), Signals,
        EHaybaMCPAdvisoryState::SuccessNeedsVerification, TEXT("verification_required"));

    Signals = FHaybaMCPAdvisorySignals();
    Signals.SucceededCount = 2;
    Signals.FailedCount = 1;
    AddCase(TEXT("mixed item outcomes"), Signals,
        EHaybaMCPAdvisoryState::PartialSuccess, TEXT("partial_success"));

    Signals = FHaybaMCPAdvisorySignals();
    Signals.bOperationSucceeded = false;
    Signals.FailureKind = EHaybaMCPFailureKind::InputRejected;
    AddCase(TEXT("clean input rejection"), Signals,
        EHaybaMCPAdvisoryState::InputRejected, TEXT("invalid_request"));

    Signals = FHaybaMCPAdvisorySignals();
    Signals.bCrashGuardRejected = true;
    AddCase(TEXT("crash guard policy block"), Signals,
        EHaybaMCPAdvisoryState::PolicyBlocked, TEXT("crash_guard_blocked"));

    Signals = FHaybaMCPAdvisorySignals();
    Signals.bOperationSucceeded = false;
    Signals.FailureKind = EHaybaMCPFailureKind::Retryable;
    AddCase(TEXT("explicit retryable failure"), Signals,
        EHaybaMCPAdvisoryState::RetryableFailure, TEXT("transient_failure"));

    Signals = FHaybaMCPAdvisorySignals();
    Signals.bTimedOut = true;
    Signals.Phase = EHaybaMCPCommandPhase::Execute;
    Signals.MutationStatus = EHaybaMCPMutationStatus::Applied;
    AddCase(TEXT("timeout after execute"), Signals,
        EHaybaMCPAdvisoryState::UnknownOutcome, TEXT("timeout_after_execute"));

    Signals = FHaybaMCPAdvisorySignals();
    Signals.bStructuredException = true;
    AddCase(TEXT("caught SEH makes session suspect"), Signals,
        EHaybaMCPAdvisoryState::SessionSuspect, TEXT("structured_exception"));

    Signals = FHaybaMCPAdvisorySignals();
    Signals.bOperationSucceeded = false;
    Signals.FailureKind = EHaybaMCPFailureKind::Fatal;
    AddCase(TEXT("fatal editor failure"), Signals,
        EHaybaMCPAdvisoryState::FatalError, TEXT("fatal_error"));

    for (const FCase& Case : Cases)
    {
        const FHaybaMCPAdvisoryResult Result = Evaluate(Case.Signals);
        TestTrue(Case.Label + TEXT(" has expected state"), Result.State == Case.ExpectedState);
        TestEqual(Case.Label + TEXT(" has stable code"), Result.Code, Case.ExpectedCode);
    }

    Signals = FHaybaMCPAdvisorySignals();
    Signals.bSaveAttempted = true;
    Signals.bSaveSucceeded = false;
    Signals.MutationStatus = EHaybaMCPMutationStatus::Applied;
    const FHaybaMCPAdvisoryResult SaveFailed = Evaluate(Signals);
    TestTrue(TEXT("save failure is partial success"), SaveFailed.State == EHaybaMCPAdvisoryState::PartialSuccess);
    TestTrue(TEXT("save failure declares unsaved mutation"),
        SaveFailed.MutationStatus == EHaybaMCPMutationStatus::AppliedUnsaved);
    TestTrue(TEXT("save failure recovery is mandatory"), SaveFailed.MandatoryRecovery.Num() > 0);

    Signals = FHaybaMCPAdvisorySignals();
    Signals.bTimedOut = true;
    Signals.Phase = EHaybaMCPCommandPhase::Preflight;
    Signals.bRetryUnchangedSafe = true;
    const FHaybaMCPAdvisoryResult BeforeExecute = Evaluate(Signals);
    TestTrue(TEXT("pre-execute timeout can be retryable when explicitly safe"),
        BeforeExecute.State == EHaybaMCPAdvisoryState::RetryableFailure && BeforeExecute.bRetryable);

    Signals = FHaybaMCPAdvisorySignals();
    Signals.FailureKind = EHaybaMCPFailureKind::Retryable;
    Signals.MutationStatus = EHaybaMCPMutationStatus::Applied;
    const FHaybaMCPAdvisoryResult UnsafeRetry = Evaluate(Signals);
    TestTrue(TEXT("retry is forbidden after observed mutation"),
        UnsafeRetry.State == EHaybaMCPAdvisoryState::UnknownOutcome && !UnsafeRetry.bRetryable);

    Signals = FHaybaMCPAdvisorySignals();
    Signals.bCrashGuardRejected = true;
    Signals.MutationStatus = EHaybaMCPMutationStatus::PartiallyApplied;
    TestTrue(TEXT("late crash guard rejection makes session suspect"),
        Evaluate(Signals).State == EHaybaMCPAdvisoryState::SessionSuspect);

    Signals = FHaybaMCPAdvisorySignals();
    Signals.FailureKind = EHaybaMCPFailureKind::SessionSuspect;
    const FHaybaMCPAdvisoryResult Suspect = Evaluate(Signals);
    TestTrue(TEXT("session suspect may have mutated"), Suspect.bMayHaveMutated);
    TestTrue(TEXT("session suspect carries mandatory recovery"), Suspect.MandatoryRecovery.Num() > 0);
    TestTrue(TEXT("session suspect tells caller not to trust session"),
        Suspect.SessionHealth == EHaybaMCPSessionHealth::Suspect);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPAdvisoryVerbosityTest,
    "Hayba.MCP.Advisory.Verbosity",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPAdvisoryVerbosityTest::RunTest(const FString&)
{
    using namespace HaybaMCPAdvisory;

    auto ResponseWithLegacyGuidance = []()
    {
        TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
        Response->SetStringField(TEXT("error"), TEXT("transport timed out"));
        Response->SetStringField(TEXT("warning"), TEXT("legacy warning"));
        Response->SetStringField(TEXT("tip"), TEXT("legacy tip"));
        Response->SetStringField(TEXT("mandatory_recovery"), TEXT("legacy required action"));
        TSharedRef<FJsonObject> Nested = MakeShared<FJsonObject>();
        TArray<TSharedPtr<FJsonValue>> CompileWarnings;
        CompileWarnings.Add(MakeShared<FJsonValueString>(TEXT("w")));
        Nested->SetArrayField(TEXT("compile_warnings"), CompileWarnings);
        TArray<TSharedPtr<FJsonValue>> Hints;
        Hints.Add(MakeShared<FJsonValueString>(TEXT("h")));
        Nested->SetArrayField(TEXT("hints"), Hints);
        Nested->SetStringField(TEXT("error_detail"), TEXT("must survive"));
        Nested->SetStringField(TEXT("recovery_required"), TEXT("must survive"));
        Nested->SetNumberField(TEXT("warning_count"), 1);
        Nested->SetNumberField(TEXT("failed"), 2);
        Response->SetObjectField(TEXT("data"), Nested);
        return Response;
    };

    FHaybaMCPAdvisorySignals Signals;
    Signals.Operation = TEXT("asset_write");
    Signals.bOperationSucceeded = false;
    Signals.FailureKind = EHaybaMCPFailureKind::UnknownOutcome;
    Signals.Error = TEXT("transport timed out");
    Signals.Warnings = { TEXT("could have written before timeout") };
    Signals.Tips = { TEXT("inspect the asset") };
    Signals.MandatoryRecovery = { TEXT("read back before retry") };

    {
        TSharedRef<FJsonObject> Response = ResponseWithLegacyGuidance();
        ApplyToResponse(Response, Signals, EHaybaMCPAdvisoryVerbosity::ErrorsOnly);
        TestTrue(TEXT("ErrorsOnly preserves the response error"), Response->HasField(TEXT("error")));
        TestFalse(TEXT("ErrorsOnly removes legacy warnings"), Response->HasField(TEXT("warning")));
        TestFalse(TEXT("ErrorsOnly removes legacy tips"), Response->HasField(TEXT("tip")));
        TestTrue(TEXT("ErrorsOnly preserves legacy mandatory recovery"), Response->HasField(TEXT("mandatory_recovery")));
        const TSharedPtr<FJsonObject> Nested = Response->GetObjectField(TEXT("data"));
        TestFalse(TEXT("ErrorsOnly removes nested compile warnings"), Nested->HasField(TEXT("compile_warnings")));
        TestFalse(TEXT("ErrorsOnly removes nested hints"), Nested->HasField(TEXT("hints")));
        TestTrue(TEXT("ErrorsOnly preserves nested error detail"), Nested->HasField(TEXT("error_detail")));
        TestTrue(TEXT("ErrorsOnly preserves nested required recovery"), Nested->HasField(TEXT("recovery_required")));
        TestTrue(TEXT("ErrorsOnly preserves machine-readable warning count"), Nested->HasField(TEXT("warning_count")));
        TestTrue(TEXT("ErrorsOnly preserves failure count"), Nested->HasField(TEXT("failed")));
        const TSharedPtr<FJsonObject> Advisory = Response->GetObjectField(TEXT("advisory"));
        TestTrue(TEXT("ErrorsOnly keeps advisory errors"), Advisory->HasField(TEXT("errors")));
        TestTrue(TEXT("ErrorsOnly keeps mandatory advisory recovery"), Advisory->HasField(TEXT("mandatory_recovery")));
        TestTrue(TEXT("ErrorsOnly keeps stable state"), Advisory->HasField(TEXT("state")));
        TestTrue(TEXT("ErrorsOnly keeps stable severity"), Advisory->HasField(TEXT("severity")));
        TestTrue(TEXT("ErrorsOnly keeps stable code"), Advisory->HasField(TEXT("code")));
        TestTrue(TEXT("ErrorsOnly keeps mutation status"), Advisory->HasField(TEXT("mutation_status")));
        TestTrue(TEXT("ErrorsOnly keeps session health"), Advisory->HasField(TEXT("session_health")));
        TestTrue(TEXT("ErrorsOnly keeps required next action"), Advisory->HasField(TEXT("next_action")));
        TestFalse(TEXT("ErrorsOnly removes advisory warnings"), Advisory->HasField(TEXT("warnings")));
        TestFalse(TEXT("ErrorsOnly removes advisory tips"), Advisory->HasField(TEXT("tips")));
    }

    {
        TSharedRef<FJsonObject> Response = ResponseWithLegacyGuidance();
        ApplyToResponse(Response, Signals, EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings);
        TestTrue(TEXT("warning mode preserves warnings"), Response->HasField(TEXT("warning")));
        TestFalse(TEXT("warning mode removes tips"), Response->HasField(TEXT("tip")));
        const TSharedPtr<FJsonObject> Advisory = Response->GetObjectField(TEXT("advisory"));
        TestTrue(TEXT("warning mode emits advisory warnings"), Advisory->HasField(TEXT("warnings")));
        TestFalse(TEXT("warning mode omits advisory tips"), Advisory->HasField(TEXT("tips")));
    }

    {
        TSharedRef<FJsonObject> Response = ResponseWithLegacyGuidance();
        ApplyToResponse(Response, Signals, EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips);
        TestTrue(TEXT("full mode preserves warnings"), Response->HasField(TEXT("warning")));
        TestTrue(TEXT("full mode preserves tips"), Response->HasField(TEXT("tip")));
        const TSharedPtr<FJsonObject> Advisory = Response->GetObjectField(TEXT("advisory"));
        TestTrue(TEXT("full mode emits advisory warnings"), Advisory->HasField(TEXT("warnings")));
        TestTrue(TEXT("full mode emits advisory tips"), Advisory->HasField(TEXT("tips")));
    }

    {
        // Optional success guidance must not add payload noise in ErrorsOnly.
        TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
        FHaybaMCPAdvisorySignals Success;
        Success.bNeedsVerification = true;
        ApplyToResponse(Response, Success, EHaybaMCPAdvisoryVerbosity::ErrorsOnly);
        TestFalse(TEXT("ErrorsOnly omits optional success advisory"), Response->HasField(TEXT("advisory")));
    }

    {
        TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
        FHaybaMCPAdvisorySignals Rejected;
        Rejected.bOperationSucceeded = false;
        Rejected.FailureKind = EHaybaMCPFailureKind::InputRejected;
        Rejected.Error = TEXT("bad input");
        ApplyToResponse(Response, Rejected, EHaybaMCPAdvisoryVerbosity::ErrorsOnly);
        const TSharedPtr<FJsonObject> Advisory = Response->GetObjectField(TEXT("advisory"));
        TestFalse(TEXT("ErrorsOnly does not leak an optional tip through next_action"),
            Advisory->HasField(TEXT("next_action")));
        TestTrue(TEXT("ErrorsOnly still preserves the actual error"), Advisory->HasField(TEXT("errors")));
    }

    // Golden presence matrix: optional success/partial guidance disappears at
    // lower levels, while rejected/unknown/session error guidance never does.
    struct FGoldenCase
    {
        FString Label;
        FHaybaMCPAdvisorySignals Signals;
        bool bExpectedInErrorsOnly = false;
        bool bExpectedInWarnings = false;
        bool bExpectedInFull = false;
    };
    TArray<FGoldenCase> Goldens;
    auto AddGolden = [&Goldens](const TCHAR* Label, const FHaybaMCPAdvisorySignals& In,
                                bool bErrors, bool bWarnings, bool bFull)
    {
        FGoldenCase& Case = Goldens.AddDefaulted_GetRef();
        Case.Label = Label;
        Case.Signals = In;
        Case.bExpectedInErrorsOnly = bErrors;
        Case.bExpectedInWarnings = bWarnings;
        Case.bExpectedInFull = bFull;
    };

    FHaybaMCPAdvisorySignals Golden;
    Golden.Tips = { TEXT("optional success coaching") };
    AddGolden(TEXT("success"), Golden, false, false, true);
    Golden = FHaybaMCPAdvisorySignals();
    Golden.SucceededCount = 1;
    Golden.FailedCount = 1;
    AddGolden(TEXT("partial"), Golden, false, true, true);
    Golden = FHaybaMCPAdvisorySignals();
    Golden.FailureKind = EHaybaMCPFailureKind::InputRejected;
    AddGolden(TEXT("rejected"), Golden, true, true, true);
    Golden = FHaybaMCPAdvisorySignals();
    Golden.bTimedOut = true;
    Golden.Phase = EHaybaMCPCommandPhase::Execute;
    AddGolden(TEXT("timeout"), Golden, true, true, true);
    Golden = FHaybaMCPAdvisorySignals();
    Golden.bStructuredException = true;
    AddGolden(TEXT("session suspect"), Golden, true, true, true);

    const EHaybaMCPAdvisoryVerbosity Levels[] = {
        EHaybaMCPAdvisoryVerbosity::ErrorsOnly,
        EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings,
        EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips,
    };
    for (const FGoldenCase& Case : Goldens)
    {
        const bool Expected[] = {
            Case.bExpectedInErrorsOnly,
            Case.bExpectedInWarnings,
            Case.bExpectedInFull,
        };
        for (int32 Index = 0; Index < UE_ARRAY_COUNT(Levels); ++Index)
        {
            TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
            ApplyToResponse(Response, Case.Signals, Levels[Index]);
            TestEqual(Case.Label + FString::Printf(TEXT(" at verbosity %d"), Index),
                Response->HasField(TEXT("advisory")), Expected[Index]);
            if (Levels[Index] == EHaybaMCPAdvisoryVerbosity::ErrorsOnly && Response->HasField(TEXT("advisory")))
            {
                const TSharedPtr<FJsonObject> Advisory = Response->GetObjectField(TEXT("advisory"));
                TestFalse(Case.Label + TEXT(" ErrorsOnly has no warnings"), Advisory->HasField(TEXT("warnings")));
                TestFalse(Case.Label + TEXT(" ErrorsOnly has no tips"), Advisory->HasField(TEXT("tips")));
            }
        }
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
