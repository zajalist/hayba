#include "HaybaMCPActivityModel.h"
#include "Serialization/JsonSerializer.h"
#include <initializer_list>

namespace
{
    using FKeys = std::initializer_list<const TCHAR*>;
    bool IsOneOf(const FString& Value, FKeys Choices)
    {
        for (const TCHAR* Choice : Choices) if (Value == Choice) return true;
        return false;
    }
    bool Only(const FJsonObject& Object, FKeys Keys)
    {
        for (const auto& Field : Object.Values) if (!IsOneOf(FString(*Field.Key), Keys)) return false;
        return true;
    }
    bool String(const FJsonObject& Object, const TCHAR* Key, bool bNonempty = true, bool bOptional = false)
    {
        if (!Object.HasField(Key)) return bOptional;
        FString Value;
        return Object.HasTypedField<EJson::String>(Key) && Object.TryGetStringField(Key, Value) && (!bNonempty || !Value.IsEmpty());
    }
    bool Enum(const FJsonObject& Object, const TCHAR* Key, FKeys Choices, bool bOptional = false)
    {
        if (!Object.HasField(Key)) return bOptional;
        return String(Object, Key) && IsOneOf(Object.GetStringField(Key), Choices);
    }
    const FJsonObject* ObjectField(const FJsonObject& Object, const TCHAR* Key)
    {
        const TSharedPtr<FJsonObject>* Value = nullptr;
        return Object.TryGetObjectField(Key, Value) && Value && Value->IsValid() ? Value->Get() : nullptr;
    }
    bool Usage(const FJsonObject& Object)
    {
        if (!Only(Object, { TEXT("inputTokens"), TEXT("outputTokens"), TEXT("cacheCreationInputTokens"), TEXT("cacheReadInputTokens") })) return false;
        for (const auto& Field : Object.Values)
        {
            if (!Field.Value.IsValid() || Field.Value->Type != EJson::Number) return false;
            const double Value = Field.Value->AsNumber();
            if (!FMath::IsFinite(Value) || Value < 0 || FMath::FloorToDouble(Value) != Value) return false;
        }
        return true;
    }
    bool Termination(const FJsonObject& Object)
    {
        if (!Enum(Object, TEXT("reason"), { TEXT("end_turn"), TEXT("max_tokens"), TEXT("context_window_exceeded"), TEXT("provider_refusal"),
            TEXT("provider_protocol_error"), TEXT("provider_stop"), TEXT("max_steps"), TEXT("token_budget"), TEXT("aborted") })) return false;
        if (!Enum(Object, TEXT("stopReason"), { TEXT("end_turn"), TEXT("tool_use"), TEXT("max_tokens"), TEXT("stop_sequence"), TEXT("pause_turn"),
            TEXT("refusal"), TEXT("model_context_window_exceeded"), TEXT("content_filter"), TEXT("unknown") }, true)) return false;
        const FJsonObject* Tokens = ObjectField(Object, TEXT("usage"));
        return !Object.HasField(TEXT("usage")) || (Tokens && Usage(*Tokens));
    }
    bool Call(const FJsonObject& Object)
    {
        return String(Object, TEXT("id")) && String(Object, TEXT("name")) && ObjectField(Object, TEXT("input"));
    }
    FString Serialize(const FJsonObject& Object)
    {
        FString Result;
        FJsonSerializer::Serialize(MakeShared<FJsonObject>(Object), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Result));
        return Result;
    }
    FString SerializeField(const FJsonObject& Object, const TCHAR* Key)
    {
        FString Result;
        const auto Value = Object.TryGetField(Key);
        if (Value.IsValid()) FJsonSerializer::Serialize(Value.ToSharedRef(), TEXT(""), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Result));
        return Result;
    }
    FHaybaActivityStep ReadStep(const FJsonObject& Object)
    {
        FHaybaActivityStep Step;
        Step.Id = Object.GetStringField(TEXT("id"));
        Step.Name = Object.GetStringField(TEXT("name"));
        FString Status;
        Object.TryGetStringField(TEXT("status"), Status);
        Step.State = Status == TEXT("failed") ? EHaybaActivityState::Failed :
            Status == TEXT("succeeded") ? EHaybaActivityState::Succeeded : EHaybaActivityState::Running;
        Step.InputJson = SerializeField(Object, TEXT("input"));
        Step.ResultJson = SerializeField(Object, TEXT("result"));
        return Step;
    }
}

bool FHaybaActivityModel::ValidateEvent(const FJsonObject& Event)
{
    if (!String(Event, TEXT("type")) || !String(Event, TEXT("activityId"))) return false;
    const FString Type = Event.GetStringField(TEXT("type"));
    if (Type == TEXT("activity_started"))
        return Only(Event, { TEXT("type"), TEXT("activityId"), TEXT("title"), TEXT("resumeApprovalId"), TEXT("specialistId") }) &&
            String(Event, TEXT("title")) && String(Event, TEXT("resumeApprovalId"), true, true) && String(Event, TEXT("specialistId"), true, true);
    if (Type == TEXT("message_delta"))
        return Only(Event, { TEXT("type"), TEXT("activityId"), TEXT("text") }) && String(Event, TEXT("text"), false);
    if (Type == TEXT("activity_step"))
    {
        const FJsonObject* Step = ObjectField(Event, TEXT("step"));
        if (!Only(Event, { TEXT("type"), TEXT("activityId"), TEXT("step"), TEXT("specialistId") }) ||
            !String(Event, TEXT("specialistId"), true, true) || !Step || !String(*Step, TEXT("status"))) return false;
        if (Step->GetStringField(TEXT("status")) == TEXT("running"))
            return Only(*Step, { TEXT("status"), TEXT("id"), TEXT("name"), TEXT("input") }) && Call(*Step);
        return Enum(*Step, TEXT("status"), { TEXT("succeeded"), TEXT("failed") }) &&
            Only(*Step, { TEXT("status"), TEXT("id"), TEXT("name"), TEXT("result") }) &&
            String(*Step, TEXT("id")) && String(*Step, TEXT("name")) && Step->HasField(TEXT("result"));
    }
    if (Type == TEXT("approval_requested"))
    {
        const FJsonObject* Pending = ObjectField(Event, TEXT("call"));
        return Only(Event, { TEXT("type"), TEXT("activityId"), TEXT("approvalId"), TEXT("call"), TEXT("argsHash"), TEXT("source"), TEXT("hint") }) &&
            String(Event, TEXT("approvalId")) && String(Event, TEXT("argsHash")) && Enum(Event, TEXT("source"), { TEXT("ts"), TEXT("ue") }) &&
            String(Event, TEXT("hint"), false, true) && Pending && Only(*Pending, { TEXT("id"), TEXT("name"), TEXT("input") }) && Call(*Pending);
    }
    if (Type == TEXT("artifact_proposed"))
    {
        const FJsonObject* Artifact = ObjectField(Event, TEXT("artifact"));
        return Only(Event, { TEXT("type"), TEXT("activityId"), TEXT("artifact") }) && Artifact &&
            Only(*Artifact, { TEXT("kind"), TEXT("id"), TEXT("path") }) && String(*Artifact, TEXT("kind")) &&
            String(*Artifact, TEXT("id")) && String(*Artifact, TEXT("path"), true, true);
    }
    if (Type == TEXT("verdict_emitted"))
    {
        const FJsonObject* Verdict = ObjectField(Event, TEXT("verdict"));
        return Only(Event, { TEXT("type"), TEXT("activityId"), TEXT("verdict") }) && Verdict &&
            Only(*Verdict, { TEXT("code"), TEXT("message"), TEXT("severity"), TEXT("direction") }) &&
            String(*Verdict, TEXT("code")) && String(*Verdict, TEXT("message")) &&
            Enum(*Verdict, TEXT("severity"), { TEXT("info"), TEXT("warning"), TEXT("error") }) &&
            Enum(*Verdict, TEXT("direction"), { TEXT("proceed"), TEXT("review"), TEXT("block") });
    }
    if (Type == TEXT("activity_completed"))
        return Only(Event, { TEXT("type"), TEXT("activityId"), TEXT("outcome"), TEXT("reason"), TEXT("stopReason"), TEXT("usage") }) &&
            Enum(Event, TEXT("outcome"), { TEXT("succeeded"), TEXT("failed"), TEXT("cancelled") }) && Termination(Event);
    if (Type == TEXT("error"))
    {
        const FJsonObject* End = ObjectField(Event, TEXT("termination"));
        return Only(Event, { TEXT("type"), TEXT("activityId"), TEXT("error"), TEXT("kind"), TEXT("termination") }) &&
            String(Event, TEXT("error"), false) && String(Event, TEXT("kind"), true, true) &&
            (!Event.HasField(TEXT("termination")) || (End && Only(*End, { TEXT("reason"), TEXT("stopReason"), TEXT("usage") }) && Termination(*End)));
    }
    return false;
}

const FHaybaActivity* FHaybaActivityModel::FindActivity(const FString& ActivityId) const
{
    return Activities.FindByPredicate([&](const FHaybaActivity& Activity) { return Activity.ActivityId == ActivityId; });
}

bool FHaybaActivityModel::Reject(const TCHAR* Error)
{
    LastError = Error;
    return false;
}

bool FHaybaActivityModel::ApplyEvent(const FJsonObject& Event)
{
    if (!ValidateEvent(Event)) return Reject(TEXT("INVALID_EVENT"));
    const FString Id = Event.GetStringField(TEXT("activityId"));
    const FString Type = Event.GetStringField(TEXT("type"));
    FHaybaActivity* Activity = Activities.FindByPredicate([&](const FHaybaActivity& Item) { return Item.ActivityId == Id; });
    if (!Activity)
    {
        if (Type != TEXT("activity_started")) return Reject(TEXT("ACTIVITY_NOT_STARTED"));
        if (Event.HasField(TEXT("resumeApprovalId"))) return Reject(TEXT("APPROVAL_MISMATCH"));
        FHaybaActivity NewActivity;
        NewActivity.ActivityId = Id;
        NewActivity.Title = Event.GetStringField(TEXT("title"));
        Event.TryGetStringField(TEXT("specialistId"), NewActivity.SpecialistId);
        Activities.Add(MoveTemp(NewActivity));
    }
    else
    {
        if (Activity->IsTerminal()) return Reject(TEXT("ACTIVITY_TERMINAL"));
        // Work on a value copy: rejected reconciliation keeps Unknown and all prior data.
        FHaybaActivity Next = *Activity;
        if (Next.State == EHaybaActivityState::Unknown) Next.State = Next.StateBeforeDisconnect;
        if (Type == TEXT("activity_started"))
        {
            if (Next.State != EHaybaActivityState::AwaitingApproval) return Reject(TEXT("ACTIVITY_ALREADY_STARTED"));
            FString ApprovalId;
            Event.TryGetStringField(TEXT("resumeApprovalId"), ApprovalId);
            if (!Next.Approval.IsSet() || ApprovalId != Next.Approval->ApprovalId) return Reject(TEXT("APPROVAL_MISMATCH"));
            const FString CallId = Next.Approval->Call.Id;
            Next.Steps.RemoveAll([&](const FHaybaActivityStep& Step) { return Step.Id == CallId && Step.State == EHaybaActivityState::Running; });
            Next.Approval.Reset();
            Next.State = EHaybaActivityState::Running;
        }
        else if (Type == TEXT("message_delta")) Next.Text += Event.GetStringField(TEXT("text"));
        else if (Type == TEXT("activity_step"))
        {
            if (Next.State == EHaybaActivityState::AwaitingApproval) return Reject(TEXT("APPROVAL_REQUIRED"));
            FHaybaActivityStep Step = ReadStep(*ObjectField(Event, TEXT("step")));
            Event.TryGetStringField(TEXT("specialistId"), Step.SpecialistId);
            const int32 Index = Next.Steps.IndexOfByPredicate([&](const FHaybaActivityStep& Item) { return Item.Id == Step.Id; });
            if (Step.State == EHaybaActivityState::Running ? Index != INDEX_NONE :
                Index == INDEX_NONE || Next.Steps[Index].State != EHaybaActivityState::Running || Next.Steps[Index].Name != Step.Name)
                return Reject(TEXT("INVALID_STEP_TRANSITION"));
            if (Index == INDEX_NONE) Next.Steps.Add(MoveTemp(Step));
            else Next.Steps[Index] = MoveTemp(Step);
            Next.State = EHaybaActivityState::Running;
        }
        else if (Type == TEXT("approval_requested"))
        {
            if (Next.State == EHaybaActivityState::AwaitingApproval) return Reject(TEXT("APPROVAL_REQUIRED"));
            FHaybaActivityApproval Approval;
            Approval.ApprovalId = Event.GetStringField(TEXT("approvalId"));
            Approval.Call = ReadStep(*ObjectField(Event, TEXT("call")));
            Approval.ArgsHash = Event.GetStringField(TEXT("argsHash"));
            Approval.Source = Event.GetStringField(TEXT("source"));
            Event.TryGetStringField(TEXT("hint"), Approval.Hint);
            Next.Approval = MoveTemp(Approval);
            Next.State = EHaybaActivityState::AwaitingApproval;
        }
        else if (Type == TEXT("artifact_proposed"))
        {
            const FJsonObject& Object = *ObjectField(Event, TEXT("artifact"));
            FHaybaActivityArtifact Artifact;
            Artifact.Kind = Object.GetStringField(TEXT("kind"));
            Artifact.Id = Object.GetStringField(TEXT("id"));
            Object.TryGetStringField(TEXT("path"), Artifact.Path);
            Next.Artifacts.Add(MoveTemp(Artifact));
        }
        else if (Type == TEXT("verdict_emitted"))
        {
            const FJsonObject& Object = *ObjectField(Event, TEXT("verdict"));
            Next.Verdicts.Add({ Object.GetStringField(TEXT("code")), Object.GetStringField(TEXT("message")),
                Object.GetStringField(TEXT("severity")), Object.GetStringField(TEXT("direction")) });
        }
        else if (Type == TEXT("activity_completed"))
        {
            Next.Outcome = Event.GetStringField(TEXT("outcome"));
            if (Next.State == EHaybaActivityState::AwaitingApproval && Next.Outcome == TEXT("succeeded")) return Reject(TEXT("APPROVAL_REQUIRED"));
            Next.State = Next.Outcome == TEXT("succeeded") ? EHaybaActivityState::Succeeded : EHaybaActivityState::Failed;
            Next.CompletionJson = Serialize(Event);
            Next.Approval.Reset();
        }
        else if (Type == TEXT("error"))
        {
            Next.State = EHaybaActivityState::Failed;
            Next.Outcome = TEXT("failed");
            Next.Error = Event.GetStringField(TEXT("error"));
            Event.TryGetStringField(TEXT("kind"), Next.ErrorKind);
            Next.ErrorJson = Serialize(Event);
            Next.Approval.Reset();
        }
        *Activity = MoveTemp(Next);
    }
    LastError.Empty();
    OnActivityChanged.Broadcast(Id);
    return true;
}

bool FHaybaActivityModel::MarkDisconnected(const FString& ActivityId)
{
    FHaybaActivity* Activity = Activities.FindByPredicate([&](const FHaybaActivity& Item) { return Item.ActivityId == ActivityId; });
    if (!Activity || Activity->IsTerminal() || Activity->State == EHaybaActivityState::Unknown) return false;
    Activity->StateBeforeDisconnect = Activity->State;
    Activity->State = EHaybaActivityState::Unknown;
    OnActivityChanged.Broadcast(ActivityId);
    return true;
}

void FHaybaActivityModel::Clear()
{
    Activities.Reset();
    LastError.Empty();
    OnActivityChanged.Broadcast(FString());
}

bool FHaybaActivityModel::CanResolveApproval(const FString& ActivityId, const FString& ApprovalId) const
{
    const FHaybaActivity* Activity = FindActivity(ActivityId);
    return Activity && Activity->State == EHaybaActivityState::AwaitingApproval && Activity->Approval.IsSet() &&
        Activity->Approval->ApprovalId == ApprovalId;
}
