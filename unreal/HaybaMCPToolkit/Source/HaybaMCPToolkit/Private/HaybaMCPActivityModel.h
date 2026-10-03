#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Unknown is local connection uncertainty, never a server terminal outcome. */
enum class EHaybaActivityState : uint8
{
    Planning, AwaitingApproval, Running, Succeeded, Failed, Unknown
};

struct FHaybaActivityStep
{
    FString Id;
    FString Name;
    EHaybaActivityState State = EHaybaActivityState::Running;
    FString InputJson;
    FString ResultJson;
    FString SpecialistId;
};

struct FHaybaActivityApproval
{
    FString ApprovalId;
    FHaybaActivityStep Call;
    FString ArgsHash;
    FString Source;
    FString Hint;
    /** Exact native proposal identity, required when Source is ue. */
    FString NativeProposalId;
    FString NativeOperationDigest;
    FString NativeTargetRef;
    FString NativeTargetFingerprint;
};

struct FHaybaActivityArtifact
{
    FString Kind;
    FString Id;
    FString Path;
};

struct FHaybaActivityVerdict
{
    FString Code;
    FString Message;
    FString Severity;
    FString Direction;
};

struct FHaybaActivity
{
    FString ActivityId;
    FString Title;
    FString SpecialistId;
    EHaybaActivityState State = EHaybaActivityState::Planning;
    // Retained only to reconcile an interrupted activity with authoritative events.
    EHaybaActivityState StateBeforeDisconnect = EHaybaActivityState::Planning;
    FString Text;
    TArray<FHaybaActivityStep> Steps;
    TArray<FHaybaActivityArtifact> Artifacts;
    TArray<FHaybaActivityVerdict> Verdicts;
    TOptional<FHaybaActivityApproval> Approval;
    FString Outcome;
    FString CompletionJson;
    FString Error;
    FString ErrorKind;
    FString ErrorJson;

    bool IsTerminal() const { return State == EHaybaActivityState::Succeeded || State == EHaybaActivityState::Failed; }
};

/** Game-thread, in-memory state. No UI, execution, or authorization side effects. */
class FHaybaActivityModel
{
public:
    /** Exact counterpart of ActivityEventSchema, including nested strict objects. */
    static bool ValidateEvent(const FJsonObject& Event);
    /** Rejects malformed or invalid transitions without changing history or notifying. */
    bool ApplyEvent(const FJsonObject& Event);
    bool MarkDisconnected(const FString& ActivityId);
    /** Discard the current conversation's activity projection on New Conversation. */
    void Clear();
    /** UI guard only: a matching identity does not authorize or execute a call. */
    bool CanResolveApproval(const FString& ActivityId, const FString& ApprovalId) const;
    const FHaybaActivity* FindActivity(const FString& ActivityId) const;
    const TArray<FHaybaActivity>& GetActivities() const { return Activities; }
    const FString& GetLastError() const { return LastError; }

    DECLARE_MULTICAST_DELEGATE_OneParam(FOnActivityChanged, const FString& /*ActivityId*/);
    FOnActivityChanged OnActivityChanged;

private:
    bool Reject(const TCHAR* Error);
    TArray<FHaybaActivity> Activities;
    FString LastError;
};
