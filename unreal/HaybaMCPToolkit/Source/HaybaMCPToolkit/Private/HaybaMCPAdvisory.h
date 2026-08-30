#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPAdvisoryTypes.h"

/** A compact, machine-readable lifecycle for one MCP operation. */
enum class EHaybaMCPAdvisoryState : uint8
{
    Success,
    SuccessNeedsVerification,
    PartialSuccess,
    InputRejected,
    PolicyBlocked,
    RetryableFailure,
    UnknownOutcome,
    SessionSuspect,
    FatalError,
};

/** Where the command stopped; used to distinguish a safe retry from ambiguity. */
enum class EHaybaMCPCommandPhase : uint8
{
    Parse,
    Preflight,
    Execute,
    Verify,
    Shape,
};

/** Machine-readable mutation fact, independent of response prose. */
enum class EHaybaMCPMutationStatus : uint8
{
    None,
    NotStarted,
    Applied,
    PartiallyApplied,
    AppliedUnsaved,
    Unknown,
};

enum class EHaybaMCPSessionHealth : uint8
{
    Healthy,
    Suspect,
    RestartRequired,
};

enum class EHaybaMCPAdvisorySeverity : uint8
{
    Info,
    Warning,
    Error,
    Fatal,
};

/**
 * The failure fact supplied by the command boundary. This is deliberately
 * explicit: guessing retryability or session health from prose would make a
 * wording change alter control flow.
 */
enum class EHaybaMCPFailureKind : uint8
{
    None,
    InputRejected,
    PolicyBlocked,
    Retryable,
    UnknownOutcome,
    SessionSuspect,
    Fatal,
};

/** Facts known at the command boundary, independent of presentation. */
struct FHaybaMCPAdvisorySignals
{
    FString Operation;
    bool bOperationSucceeded = true;
    bool bNeedsVerification = false;
    bool bVerificationAttempted = false;
    bool bVerificationSucceeded = false;
    bool bSaveAttempted = false;
    bool bSaveSucceeded = false;
    bool bDirtyAfterOperation = false;
    bool bTimedOut = false;
    bool bDisconnected = false;
    bool bCrashGuardRejected = false;
    bool bStructuredException = false;
    bool bRetryUnchangedSafe = false;
    int32 SucceededCount = 0;
    int32 FailedCount = 0;
    EHaybaMCPCommandPhase Phase = EHaybaMCPCommandPhase::Parse;
    EHaybaMCPMutationStatus MutationStatus = EHaybaMCPMutationStatus::None;
    EHaybaMCPFailureKind FailureKind = EHaybaMCPFailureKind::None;
    FString Code;
    FString Error;
    TArray<FString> Warnings;
    TArray<FString> Tips;
    TArray<FString> MandatoryRecovery;
};

/** Evaluated state plus presentation-ready guidance. */
struct FHaybaMCPAdvisoryResult
{
    EHaybaMCPAdvisoryState State = EHaybaMCPAdvisoryState::Success;
    EHaybaMCPAdvisorySeverity Severity = EHaybaMCPAdvisorySeverity::Info;
    FString Code;
    bool bRetryable = false;
    bool bOutcomeKnown = true;
    bool bMayHaveMutated = false;
    EHaybaMCPMutationStatus MutationStatus = EHaybaMCPMutationStatus::None;
    EHaybaMCPSessionHealth SessionHealth = EHaybaMCPSessionHealth::Healthy;
    FString Summary;
    FString NextAction;
    TArray<FString> Errors;
    TArray<FString> Warnings;
    TArray<FString> Tips;
    TArray<FString> MandatoryRecovery;
};

namespace HaybaMCPAdvisory
{
    /** Pure deterministic transition from command facts to one lifecycle state. */
    FHaybaMCPAdvisoryResult Evaluate(const FHaybaMCPAdvisorySignals& Signals);

    /** Stable wire spelling used by agents to branch without parsing prose. */
    const TCHAR* StateName(EHaybaMCPAdvisoryState State);
    const TCHAR* SeverityName(EHaybaMCPAdvisorySeverity Severity);
    const TCHAR* MutationStatusName(EHaybaMCPMutationStatus Status);
    const TCHAR* SessionHealthName(EHaybaMCPSessionHealth Health);

    /**
     * Narrow integration seam for the command boundary.
     *
     * It removes conventional optional warning/tip fields recursively from the
     * whole response according to Verbosity, then attaches a typed `advisory`
     * object when the selected level has something useful to say. Existing
     * error and mandatory-recovery fields are never removed.
     */
    void ApplyToResponse(
        const TSharedRef<FJsonObject>& Response,
        const FHaybaMCPAdvisorySignals& Signals,
        EHaybaMCPAdvisoryVerbosity Verbosity);
}
