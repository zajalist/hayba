#include "HaybaMCPAdvisory.h"

#include "Dom/JsonValue.h"

namespace
{
    FString OperationName(const FHaybaMCPAdvisorySignals& Signals)
    {
        return Signals.Operation.IsEmpty() ? TEXT("operation") : Signals.Operation;
    }

    bool PhaseCanHaveExecuted(EHaybaMCPCommandPhase Phase)
    {
        return Phase == EHaybaMCPCommandPhase::Execute
            || Phase == EHaybaMCPCommandPhase::Verify
            || Phase == EHaybaMCPCommandPhase::Shape;
    }

    bool MutationMayHaveOccurred(EHaybaMCPMutationStatus Status)
    {
        return Status == EHaybaMCPMutationStatus::Applied
            || Status == EHaybaMCPMutationStatus::PartiallyApplied
            || Status == EHaybaMCPMutationStatus::AppliedUnsaved
            || Status == EHaybaMCPMutationStatus::Unknown;
    }

    void AddUniqueNonEmpty(TArray<FString>& Target, const FString& Value)
    {
        if (!Value.IsEmpty()) Target.AddUnique(Value);
    }

    void AddUniqueNonEmpty(TArray<FString>& Target, const TArray<FString>& Values)
    {
        for (const FString& Value : Values) AddUniqueNonEmpty(Target, Value);
    }

    bool IsWarningField(const FString& Field)
    {
        const FString Name = Field.ToLower();
        return Name == TEXT("warning") || Name == TEXT("warnings")
            || Name.EndsWith(TEXT("_warning")) || Name.EndsWith(TEXT("_warnings"));
    }

    bool IsTipField(const FString& Field)
    {
        const FString Name = Field.ToLower();
        return Name == TEXT("tip") || Name == TEXT("tips")
            || Name == TEXT("hint") || Name == TEXT("hints")
            || Name == TEXT("suggestion") || Name == TEXT("suggestions")
            || Name.EndsWith(TEXT("_tip")) || Name.EndsWith(TEXT("_tips"))
            || Name.EndsWith(TEXT("_hint")) || Name.EndsWith(TEXT("_hints"))
            || Name.EndsWith(TEXT("_suggestion")) || Name.EndsWith(TEXT("_suggestions"));
    }

    void FilterValue(const TSharedPtr<FJsonValue>& Value, EHaybaMCPAdvisoryVerbosity Verbosity);

    void FilterObject(const TSharedPtr<FJsonObject>& Object, EHaybaMCPAdvisoryVerbosity Verbosity)
    {
        if (!Object.IsValid()) return;

        TArray<FString> Keys;
        // UE 5.8 changed FJsonObject::Values keys to TSharedString. Copy them
        // through the public string view instead of asking TMap::GetKeys for a
        // mismatched TArray<FString> (which does not compile on 5.8).
        for (const auto& Pair : Object->Values)
        {
            Keys.Add(FString(*Pair.Key));
        }
        for (const FString& Key : Keys)
        {
            const bool bHideWarnings = Verbosity == EHaybaMCPAdvisoryVerbosity::ErrorsOnly;
            const bool bHideTips = Verbosity != EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips;
            if ((bHideWarnings && IsWarningField(Key)) || (bHideTips && IsTipField(Key)))
            {
                Object->RemoveField(Key);
                continue;
            }

            if (const TSharedPtr<FJsonValue> Value = Object->TryGetField(Key))
            {
                FilterValue(Value, Verbosity);
            }
        }
    }

    void FilterValue(const TSharedPtr<FJsonValue>& Value, EHaybaMCPAdvisoryVerbosity Verbosity)
    {
        if (!Value.IsValid()) return;
        if (Value->Type == EJson::Object)
        {
            FilterObject(Value->AsObject(), Verbosity);
        }
        else if (Value->Type == EJson::Array)
        {
            for (const TSharedPtr<FJsonValue>& Item : Value->AsArray())
            {
                FilterValue(Item, Verbosity);
            }
        }
    }

    TArray<TSharedPtr<FJsonValue>> StringArray(const TArray<FString>& Values)
    {
        TArray<TSharedPtr<FJsonValue>> Out;
        Out.Reserve(Values.Num());
        for (const FString& Value : Values)
        {
            Out.Add(MakeShared<FJsonValueString>(Value));
        }
        return Out;
    }
}

namespace HaybaMCPAdvisory
{
    const TCHAR* StateName(EHaybaMCPAdvisoryState State)
    {
        switch (State)
        {
        case EHaybaMCPAdvisoryState::Success:           return TEXT("success");
        case EHaybaMCPAdvisoryState::SuccessNeedsVerification: return TEXT("success_needs_verification");
        case EHaybaMCPAdvisoryState::PartialSuccess:    return TEXT("partial_success");
        case EHaybaMCPAdvisoryState::InputRejected:     return TEXT("input_rejected");
        case EHaybaMCPAdvisoryState::PolicyBlocked:     return TEXT("policy_blocked");
        case EHaybaMCPAdvisoryState::RetryableFailure:  return TEXT("retryable_failure");
        case EHaybaMCPAdvisoryState::UnknownOutcome:    return TEXT("unknown_outcome");
        case EHaybaMCPAdvisoryState::SessionSuspect:    return TEXT("session_suspect");
        case EHaybaMCPAdvisoryState::FatalError:        return TEXT("fatal_error");
        default:                                        return TEXT("fatal_error");
        }
    }

    const TCHAR* SeverityName(EHaybaMCPAdvisorySeverity Severity)
    {
        switch (Severity)
        {
        case EHaybaMCPAdvisorySeverity::Info:    return TEXT("info");
        case EHaybaMCPAdvisorySeverity::Warning: return TEXT("warning");
        case EHaybaMCPAdvisorySeverity::Error:   return TEXT("error");
        case EHaybaMCPAdvisorySeverity::Fatal:   return TEXT("fatal");
        default:                                  return TEXT("fatal");
        }
    }

    const TCHAR* MutationStatusName(EHaybaMCPMutationStatus Status)
    {
        switch (Status)
        {
        case EHaybaMCPMutationStatus::None:             return TEXT("none");
        case EHaybaMCPMutationStatus::NotStarted:       return TEXT("not_started");
        case EHaybaMCPMutationStatus::Applied:          return TEXT("applied");
        case EHaybaMCPMutationStatus::PartiallyApplied: return TEXT("partially_applied");
        case EHaybaMCPMutationStatus::AppliedUnsaved:   return TEXT("applied_unsaved");
        case EHaybaMCPMutationStatus::Unknown:          return TEXT("unknown");
        default:                                         return TEXT("unknown");
        }
    }

    const TCHAR* SessionHealthName(EHaybaMCPSessionHealth Health)
    {
        switch (Health)
        {
        case EHaybaMCPSessionHealth::Healthy:         return TEXT("healthy");
        case EHaybaMCPSessionHealth::Suspect:         return TEXT("suspect");
        case EHaybaMCPSessionHealth::RestartRequired: return TEXT("restart_required");
        default:                                       return TEXT("restart_required");
        }
    }

    FHaybaMCPAdvisoryResult Evaluate(const FHaybaMCPAdvisorySignals& Signals)
    {
        FHaybaMCPAdvisoryResult Result;
        const FString Operation = OperationName(Signals);
        Result.MutationStatus = Signals.MutationStatus;
        Result.bMayHaveMutated = MutationMayHaveOccurred(Result.MutationStatus);
        AddUniqueNonEmpty(Result.Warnings, Signals.Warnings);
        AddUniqueNonEmpty(Result.Tips, Signals.Tips);
        AddUniqueNonEmpty(Result.MandatoryRecovery, Signals.MandatoryRecovery);
        AddUniqueNonEmpty(Result.Errors, Signals.Error);

        EHaybaMCPFailureKind FailureKind = Signals.FailureKind;
        FString Code = Signals.Code;
        if (Signals.bStructuredException)
        {
            FailureKind = EHaybaMCPFailureKind::SessionSuspect;
            if (Code.IsEmpty()) Code = TEXT("structured_exception");
        }
        else if (Signals.bTimedOut || Signals.bDisconnected)
        {
            const bool bCouldHaveExecuted = PhaseCanHaveExecuted(Signals.Phase)
                || MutationMayHaveOccurred(Signals.MutationStatus);
            FailureKind = (!bCouldHaveExecuted && Signals.bRetryUnchangedSafe)
                ? EHaybaMCPFailureKind::Retryable
                : EHaybaMCPFailureKind::UnknownOutcome;
            if (Code.IsEmpty())
            {
                Code = bCouldHaveExecuted
                    ? (Signals.bTimedOut ? TEXT("timeout_after_execute") : TEXT("disconnect_after_execute"))
                    : (Signals.bTimedOut ? TEXT("timeout_before_execute") : TEXT("disconnect_before_execute"));
            }
        }
        else if (Signals.bCrashGuardRejected)
        {
            FailureKind = EHaybaMCPFailureKind::PolicyBlocked;
            if (Code.IsEmpty()) Code = TEXT("crash_guard_blocked");
        }

        // Never advertise a blind retry, clean rejection, or preflight policy
        // block after mutation was observed. Those combinations mean the
        // handler boundary itself is inconsistent and state must be read back.
        if (MutationMayHaveOccurred(Signals.MutationStatus))
        {
            if (FailureKind == EHaybaMCPFailureKind::Retryable)
            {
                FailureKind = EHaybaMCPFailureKind::UnknownOutcome;
                if (Signals.Code.IsEmpty()) Code = TEXT("retry_after_mutation_unsafe");
            }
            else if (FailureKind == EHaybaMCPFailureKind::InputRejected
                || FailureKind == EHaybaMCPFailureKind::PolicyBlocked)
            {
                FailureKind = EHaybaMCPFailureKind::SessionSuspect;
                if (Signals.Code.IsEmpty()) Code = TEXT("rejection_after_mutation");
            }
        }

        switch (FailureKind)
        {
        case EHaybaMCPFailureKind::Fatal:
            Result.State = EHaybaMCPAdvisoryState::FatalError;
            Result.Severity = EHaybaMCPAdvisorySeverity::Fatal;
            Result.Code = Code.IsEmpty() ? TEXT("fatal_error") : Code;
            Result.bOutcomeKnown = false;
            Result.bMayHaveMutated = true;
            Result.MutationStatus = EHaybaMCPMutationStatus::Unknown;
            Result.SessionHealth = EHaybaMCPSessionHealth::RestartRequired;
            Result.Summary = FString::Printf(TEXT("%s hit a fatal editor-side failure."), *Operation);
            Result.NextAction = TEXT("Stop MCP activity, preserve diagnostics, and restart the editor before continuing.");
            AddUniqueNonEmpty(Result.Errors, Result.Summary);
            AddUniqueNonEmpty(Result.MandatoryRecovery, Result.NextAction);
            break;

        case EHaybaMCPFailureKind::SessionSuspect:
            Result.State = EHaybaMCPAdvisoryState::SessionSuspect;
            Result.Severity = EHaybaMCPAdvisorySeverity::Error;
            Result.Code = Code.IsEmpty() ? TEXT("session_suspect") : Code;
            Result.bOutcomeKnown = false;
            Result.bMayHaveMutated = true;
            Result.MutationStatus = EHaybaMCPMutationStatus::Unknown;
            Result.SessionHealth = EHaybaMCPSessionHealth::Suspect;
            Result.Summary = FString::Printf(TEXT("%s left editor session integrity uncertain."), *Operation);
            Result.NextAction = TEXT("Stop mutations, inspect the editor log, restart the editor, then verify the target state.");
            AddUniqueNonEmpty(Result.Errors, Result.Summary);
            AddUniqueNonEmpty(Result.MandatoryRecovery, Result.NextAction);
            break;

        case EHaybaMCPFailureKind::UnknownOutcome:
            Result.State = EHaybaMCPAdvisoryState::UnknownOutcome;
            Result.Severity = EHaybaMCPAdvisorySeverity::Error;
            Result.Code = Code.IsEmpty() ? TEXT("unknown_outcome") : Code;
            Result.bOutcomeKnown = false;
            Result.bMayHaveMutated = true;
            Result.MutationStatus = EHaybaMCPMutationStatus::Unknown;
            Result.Summary = FString::Printf(TEXT("%s ended without a trustworthy completion result."), *Operation);
            Result.NextAction = TEXT("Read back the target state before retrying; the operation may already have completed.");
            AddUniqueNonEmpty(Result.Errors, Result.Summary);
            AddUniqueNonEmpty(Result.MandatoryRecovery, Result.NextAction);
            break;

        case EHaybaMCPFailureKind::PolicyBlocked:
            Result.State = EHaybaMCPAdvisoryState::PolicyBlocked;
            Result.Severity = EHaybaMCPAdvisorySeverity::Error;
            Result.Code = Code.IsEmpty() ? TEXT("policy_blocked") : Code;
            Result.MutationStatus = EHaybaMCPMutationStatus::NotStarted;
            Result.Summary = FString::Printf(TEXT("%s was blocked by an active safety policy."), *Operation);
            Result.NextAction = TEXT("Use the documented safe workflow or obtain the required approval; do not bypass the guard.");
            AddUniqueNonEmpty(Result.Errors, Result.Summary);
            if (Result.Code == TEXT("crash_guard_blocked"))
            {
                // Recovery from a named crash/deadlock guard is safety data,
                // not optional coaching, and survives ErrorsOnly.
                AddUniqueNonEmpty(Result.MandatoryRecovery, Result.NextAction);
            }
            else
            {
                AddUniqueNonEmpty(Result.Tips, Result.NextAction);
            }
            break;

        case EHaybaMCPFailureKind::InputRejected:
            Result.State = EHaybaMCPAdvisoryState::InputRejected;
            Result.Severity = EHaybaMCPAdvisorySeverity::Error;
            Result.Code = Code.IsEmpty() ? TEXT("invalid_request") : Code;
            Result.MutationStatus = EHaybaMCPMutationStatus::NotStarted;
            Result.Summary = FString::Printf(TEXT("%s rejected the request before execution."), *Operation);
            Result.NextAction = TEXT("Correct all reported parameter problems together, then retry once with the current tool signature.");
            AddUniqueNonEmpty(Result.Errors, Result.Summary);
            AddUniqueNonEmpty(Result.Tips, Result.NextAction);
            break;

        case EHaybaMCPFailureKind::Retryable:
            Result.State = EHaybaMCPAdvisoryState::RetryableFailure;
            Result.Severity = EHaybaMCPAdvisorySeverity::Error;
            Result.Code = Code.IsEmpty() ? TEXT("transient_failure") : Code;
            Result.bRetryable = true;
            if (Result.MutationStatus == EHaybaMCPMutationStatus::None)
                Result.MutationStatus = EHaybaMCPMutationStatus::NotStarted;
            Result.Summary = FString::Printf(TEXT("%s failed before producing a result, but the failure may be transient."), *Operation);
            Result.NextAction = TEXT("Confirm editor readiness and retry with bounded backoff.");
            AddUniqueNonEmpty(Result.Errors, Result.Summary);
            AddUniqueNonEmpty(Result.Warnings,
                TEXT("Retry only after the reported prerequisite is healthy; repeated immediate retries can overload the editor."));
            AddUniqueNonEmpty(Result.Tips, Result.NextAction);
            break;

        case EHaybaMCPFailureKind::None:
        default:
            if (!Signals.bOperationSucceeded)
            {
                Result.State = EHaybaMCPAdvisoryState::FatalError;
                Result.Severity = EHaybaMCPAdvisorySeverity::Fatal;
                Result.Code = Code.IsEmpty() ? TEXT("unclassified_failure") : Code;
                Result.bOutcomeKnown = false;
                Result.bMayHaveMutated = true;
                Result.MutationStatus = EHaybaMCPMutationStatus::Unknown;
                Result.SessionHealth = EHaybaMCPSessionHealth::Suspect;
                Result.Summary = FString::Printf(TEXT("%s failed without a classified outcome."), *Operation);
                Result.NextAction = TEXT("Stop and inspect the editor log before retrying; classify the failure at the command boundary first.");
                AddUniqueNonEmpty(Result.Errors, Result.Summary);
                AddUniqueNonEmpty(Result.MandatoryRecovery, Result.NextAction);
            }
            else if (Signals.bSaveAttempted && !Signals.bSaveSucceeded)
            {
                Result.State = EHaybaMCPAdvisoryState::PartialSuccess;
                Result.Severity = EHaybaMCPAdvisorySeverity::Error;
                Result.Code = Code.IsEmpty() ? TEXT("save_failed") : Code;
                Result.bMayHaveMutated = true;
                Result.MutationStatus = EHaybaMCPMutationStatus::AppliedUnsaved;
                Result.Summary = FString::Printf(TEXT("%s changed editor state but failed to persist it."), *Operation);
                Result.NextAction = TEXT("Resolve the save failure and save the affected package before closing the editor or relying on persistence.");
                AddUniqueNonEmpty(Result.Errors, Result.Summary);
                AddUniqueNonEmpty(Result.MandatoryRecovery, Result.NextAction);
            }
            else if (Signals.FailedCount > 0 || Signals.MutationStatus == EHaybaMCPMutationStatus::PartiallyApplied)
            {
                Result.State = EHaybaMCPAdvisoryState::PartialSuccess;
                Result.Severity = EHaybaMCPAdvisorySeverity::Warning;
                Result.Code = Code.IsEmpty() ? TEXT("partial_success") : Code;
                Result.bMayHaveMutated = Signals.SucceededCount > 0
                    || MutationMayHaveOccurred(Signals.MutationStatus);
                Result.MutationStatus = EHaybaMCPMutationStatus::PartiallyApplied;
                Result.Summary = FString::Printf(TEXT("%s applied %d item(s) and rejected %d item(s)."),
                    *Operation, Signals.SucceededCount, Signals.FailedCount);
                Result.NextAction = TEXT("Inspect rejected-item details and retry only those items; successful items are already applied.");
                AddUniqueNonEmpty(Result.Warnings, Result.Summary);
                AddUniqueNonEmpty(Result.Tips, Result.NextAction);
            }
            else if (Signals.bNeedsVerification
                || (Signals.bVerificationAttempted && !Signals.bVerificationSucceeded)
                || Signals.bDirtyAfterOperation)
            {
                Result.State = EHaybaMCPAdvisoryState::SuccessNeedsVerification;
                Result.Severity = EHaybaMCPAdvisorySeverity::Warning;
                Result.Code = Code.IsEmpty() ? TEXT("verification_required") : Code;
                Result.bMayHaveMutated = true;
                Result.MutationStatus = Signals.bDirtyAfterOperation
                    ? EHaybaMCPMutationStatus::AppliedUnsaved
                    : EHaybaMCPMutationStatus::Applied;
                Result.Summary = FString::Printf(TEXT("%s reported success but still needs independent verification."), *Operation);
                Result.NextAction = TEXT("Read the changed object back before making a dependent edit or reporting the result as final.");
                AddUniqueNonEmpty(Result.Warnings, Result.Summary);
                AddUniqueNonEmpty(Result.Tips, Result.NextAction);
            }
            else
            {
                Result.State = EHaybaMCPAdvisoryState::Success;
                Result.Severity = EHaybaMCPAdvisorySeverity::Info;
                Result.Code = Code.IsEmpty() ? TEXT("ok") : Code;
                Result.Summary = FString::Printf(TEXT("%s completed successfully."), *Operation);
            }
            break;
        }

        return Result;
    }

    void ApplyToResponse(
        const TSharedRef<FJsonObject>& Response,
        const FHaybaMCPAdvisorySignals& Signals,
        EHaybaMCPAdvisoryVerbosity Verbosity)
    {
        // Filter the pre-existing handler payload too. Otherwise an ErrorsOnly
        // setting would hide generated guidance while legacy `warnings` fields
        // continued leaking through unchanged.
        FilterObject(Response, Verbosity);
        Response->RemoveField(TEXT("advisory"));

        const FHaybaMCPAdvisoryResult Result = Evaluate(Signals);
        const bool bShowWarnings = Verbosity != EHaybaMCPAdvisoryVerbosity::ErrorsOnly;
        const bool bShowTips = Verbosity == EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips;
        const bool bHasRequiredContent = Result.Errors.Num() > 0 || Result.MandatoryRecovery.Num() > 0;
        const bool bHasOptionalContent = (bShowWarnings && Result.Warnings.Num() > 0)
            || (bShowTips && Result.Tips.Num() > 0);
        if (!bHasRequiredContent && !bHasOptionalContent)
        {
            return;
        }

        TSharedRef<FJsonObject> Advisory = MakeShared<FJsonObject>();
        Advisory->SetStringField(TEXT("state"), StateName(Result.State));
        Advisory->SetStringField(TEXT("severity"), SeverityName(Result.Severity));
        Advisory->SetStringField(TEXT("code"), Result.Code);
        Advisory->SetBoolField(TEXT("retryable"), Result.bRetryable);
        Advisory->SetBoolField(TEXT("outcome_known"), Result.bOutcomeKnown);
        Advisory->SetBoolField(TEXT("may_have_mutated"), Result.bMayHaveMutated);
        Advisory->SetStringField(TEXT("mutation_status"), MutationStatusName(Result.MutationStatus));
        Advisory->SetStringField(TEXT("session_health"), SessionHealthName(Result.SessionHealth));
        Advisory->SetStringField(TEXT("summary"), Result.Summary);
        const bool bNextActionIsMandatory = Result.MandatoryRecovery.Contains(Result.NextAction);
        if (!Result.NextAction.IsEmpty() && (bShowTips || bNextActionIsMandatory))
            Advisory->SetStringField(TEXT("next_action"), Result.NextAction);
        if (Result.Errors.Num() > 0)
            Advisory->SetArrayField(TEXT("errors"), StringArray(Result.Errors));
        if (Result.MandatoryRecovery.Num() > 0)
            Advisory->SetArrayField(TEXT("mandatory_recovery"), StringArray(Result.MandatoryRecovery));
        if (bShowWarnings && Result.Warnings.Num() > 0)
            Advisory->SetArrayField(TEXT("warnings"), StringArray(Result.Warnings));
        if (bShowTips && Result.Tips.Num() > 0)
            Advisory->SetArrayField(TEXT("tips"), StringArray(Result.Tips));
        Response->SetObjectField(TEXT("advisory"), Advisory);
    }
}
