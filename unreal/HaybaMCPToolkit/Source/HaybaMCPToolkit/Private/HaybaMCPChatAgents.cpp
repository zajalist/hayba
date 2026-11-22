#include "HaybaMCPChatPanel.h"
#include "HaybaMCPAgentClient.h"
#include "Async/Async.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "HAL/PlatformTime.h"

namespace
{
    bool ChildId(const FString& Id)
    {
        if (Id.IsEmpty() || Id.Len() > 128) return false;
        for (const TCHAR C : Id) if (!FChar::IsAlnum(C) && C != '_' && C != '-') return false;
        return true;
    }

    bool ActiveChild(const FJsonObject& Agent)
    {
        const FString Status = Agent.GetStringField(TEXT("status"));
        return Status == TEXT("queued") || Status == TEXT("running");
    }
}

void SHaybaMCPChatPanel::RequestChildAgents(const FString& Suffix, const FString& Verb, const TSharedRef<FJsonObject>& Body,
    TFunction<void(TSharedPtr<FJsonObject>, FString)> Completion)
{
    FString Base;
    if (!AgentClient || !ChildId(AgentClient->GetSessionId()) ||
        !FHaybaMCPModelDiscoveryClient::TryCanonicalLoopbackBase(FHaybaMCPSettings::Get().SidecarURL, Base))
    { Completion(nullptr, TEXT("Start a conversation with a local Hayba sidecar first.")); return; }
    const FString SessionId = AgentClient->GetSessionId(), Generation = TranscriptGeneration;
    const FString Url = Base / TEXT("chat/sessions") / SessionId / TEXT("subagents") + Suffix;
    TWeakPtr<SHaybaMCPChatPanel> Weak = SharedThis(this);
    const auto Complete = MakeShared<TFunction<void(TSharedPtr<FJsonObject>, FString)>>(MoveTemp(Completion));
    const auto Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(Url); Request->SetVerb(Verb); Request->SetTimeout(15.f);
    if (Verb == TEXT("POST"))
    {
        FString Json; FJsonSerializer::Serialize(Body, TJsonWriterFactory<>::Create(&Json));
        Request->SetHeader(TEXT("Content-Type"), TEXT("application/json")); Request->SetContentAsString(Json);
    }
    Request->OnProcessRequestComplete().BindLambda([Weak, Generation, Url, Complete](FHttpRequestPtr Sent, FHttpResponsePtr Response, bool bConnected)
    {
        AsyncTask(ENamedThreads::GameThread, [Weak, Generation, Url, Complete, Sent, Response, bConnected]()
        {
            const auto Current = Weak.Pin();
            if (!Current || Current->TranscriptGeneration != Generation) return;
            TSharedPtr<FJsonObject> Parsed;
            if (!bConnected || !Sent || !Response || Sent->GetEffectiveURL() != Url || Response->GetResponseCode() < 200 ||
                Response->GetResponseCode() >= 300 || Response->GetContent().Num() > 1024 * 1024 ||
                !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Parsed) || !Parsed)
            {
                const int32 Code = Response ? Response->GetResponseCode() : 0;
                (*Complete)(nullptr, FString::Printf(TEXT("Could not update delegated agents (HTTP %d). Retry after checking the local sidecar."), Code));
                return;
            }
            (*Complete)(Parsed, FString());
        });
    });
    if (!Request->ProcessRequest()) (*Complete)(nullptr, TEXT("Could not start the local subagent request."));
}

void SHaybaMCPChatPanel::SetChildAgents(const TSharedPtr<FJsonObject>& Response)
{
    if (!Response || !AgentClient) return;
    TArray<TSharedPtr<FJsonValue>> Values;
    const TArray<TSharedPtr<FJsonValue>>* Listed = nullptr;
    const bool bFullList = Response->TryGetArrayField(TEXT("agents"), Listed);
    if (bFullList) Values = *Listed;
    else
    {
        const TSharedPtr<FJsonObject>* Agent = nullptr;
        if (Response->TryGetObjectField(TEXT("agent"), Agent) && Agent && *Agent) Values.Add(MakeShared<FJsonValueObject>(*Agent));
    }
    TArray<TSharedPtr<FJsonObject>> Projected;
    for (const auto& Value : Values)
    {
        const auto Source = Value.IsValid() && Value->Type == EJson::Object ? Value->AsObject() : nullptr;
        FString Id, Parent, Status;
        if (!Source || !Source->TryGetStringField(TEXT("id"), Id) || !ChildId(Id) ||
            !Source->TryGetStringField(TEXT("parent_session_id"), Parent) || Parent != AgentClient->GetSessionId() ||
            !Source->TryGetStringField(TEXT("status"), Status) ||
            (Status != TEXT("queued") && Status != TEXT("running") && Status != TEXT("succeeded") && Status != TEXT("failed") && Status != TEXT("cancelled"))) continue;
        auto Agent = MakeShared<FJsonObject>();
        Agent->SetStringField(TEXT("id"), Id); Agent->SetStringField(TEXT("parent_session_id"), Parent); Agent->SetStringField(TEXT("status"), Status);
        for (const FString& Field : { FString(TEXT("task")), FString(TEXT("output")), FString(TEXT("specialist_id")), FString(TEXT("created_at")), FString(TEXT("updated_at")), FString(TEXT("error")) })
        { FString Text; if (Source->HasTypedField<EJson::String>(Field) && Source->TryGetStringField(Field, Text)) Agent->SetStringField(Field, Text.Left(Field == TEXT("task") || Field == TEXT("output") ? 4000 : 256)); }
        for (const FString& Field : { FString(TEXT("output_truncated")), FString(TEXT("tools_truncated")) })
        { bool Flag = false; if (Source->TryGetBoolField(Field, Flag)) Agent->SetBoolField(Field, Flag); }
        TArray<TSharedPtr<FJsonValue>> Tools;
        const TArray<TSharedPtr<FJsonValue>>* SourceTools = nullptr;
        if (Source->TryGetArrayField(TEXT("tools"), SourceTools))
            for (const auto& ToolValue : *SourceTools)
            {
                const auto Tool = ToolValue && ToolValue->Type == EJson::Object ? ToolValue->AsObject() : nullptr;
                FString ToolId, Name, ToolStatus;
                if (!Tool || Tools.Num() >= 16 || !Tool->TryGetStringField(TEXT("id"), ToolId) || !Tool->TryGetStringField(TEXT("name"), Name) ||
                    !Tool->TryGetStringField(TEXT("status"), ToolStatus) || (ToolStatus != TEXT("running") && ToolStatus != TEXT("succeeded") && ToolStatus != TEXT("failed"))) continue;
                auto Entry = MakeShared<FJsonObject>();
                Entry->SetStringField(TEXT("id"), ToolId.Left(128)); Entry->SetStringField(TEXT("name"), Name.Left(128)); Entry->SetStringField(TEXT("status"), ToolStatus);
                Tools.Add(MakeShared<FJsonValueObject>(Entry));
            }
        Agent->SetArrayField(TEXT("tools"), Tools);
        if (Projected.Num() < 100) Projected.Add(Agent);
    }
    if (bFullList) ChildAgents = MoveTemp(Projected);
    else for (const auto& Agent : Projected)
    {
        const FString Id = Agent->GetStringField(TEXT("id"));
        const int32 Existing = ChildAgents.IndexOfByPredicate([&Id](const auto& Item) { return Item->GetStringField(TEXT("id")) == Id; });
        if (Existing == INDEX_NONE) ChildAgents.Add(Agent); else ChildAgents[Existing] = Agent;
    }
    if (!bFullList && Projected.IsEmpty()) ChildAgentsError = TEXT("The sidecar returned an invalid subagent record.");
    if (NextChildAgentPoll >= 0) NextChildAgentPoll = FPlatformTime::Seconds() + 4;
    bTranscriptDirty = true;
}

void SHaybaMCPChatPanel::RefreshChildAgents()
{
    if (!AgentClient || AgentClient->GetSessionId().IsEmpty() || bChildAgentsLoading) return;
    bChildAgentsLoading = true; ChildAgentsError.Empty(); bTranscriptDirty = true;
    NextChildAgentPoll = FPlatformTime::Seconds() + 4;
    TWeakPtr<SHaybaMCPChatPanel> Weak = SharedThis(this);
    RequestChildAgents(FString(), TEXT("GET"), MakeShared<FJsonObject>(), [Weak](TSharedPtr<FJsonObject> Response, FString Error)
    {
        if (const auto Self = Weak.Pin())
        { Self->bChildAgentsLoading = false; Self->ChildAgentsError = Error; Self->SetChildAgents(Response);
            if (Self->NextChildAgentPoll >= 0) Self->NextChildAgentPoll = FPlatformTime::Seconds() + 4;
            Self->bTranscriptDirty = true; }
    });
}

void SHaybaMCPChatPanel::CancelChildAgent(const FString& Id)
{
    const auto* Agent = ChildAgents.FindByPredicate([&Id](const auto& Item) { return Item->GetStringField(TEXT("id")) == Id; });
    if (!Agent || !ActiveChild(**Agent) || bChildAgentsLoading || !ChildId(Id)) return;
    bChildAgentsLoading = true; bTranscriptDirty = true;
    TWeakPtr<SHaybaMCPChatPanel> Weak = SharedThis(this);
    RequestChildAgents(TEXT("/") + Id + TEXT("/cancel"), TEXT("POST"), MakeShared<FJsonObject>(), [Weak](TSharedPtr<FJsonObject> Response, FString Error)
    { if (const auto Self = Weak.Pin()) { Self->bChildAgentsLoading = false; Self->ChildAgentsError = Error; Self->SetChildAgents(Response); Self->bTranscriptDirty = true; } });
}

void SHaybaMCPChatPanel::CancelAllChildAgents()
{
    FString Base;
    if ((!bChildAgentsLoading && !ChildAgents.ContainsByPredicate([](const auto& Agent) { return Agent && ActiveChild(*Agent); })) ||
        !AgentClient || !ChildId(AgentClient->GetSessionId()) ||
        !FHaybaMCPModelDiscoveryClient::TryCanonicalLoopbackBase(FHaybaMCPSettings::Get().SidecarURL, Base)) return;
    auto Body = MakeShared<FJsonObject>(); Body->SetStringField(TEXT("session_id"), AgentClient->GetSessionId());
    FString Json; FJsonSerializer::Serialize(Body, TJsonWriterFactory<>::Create(&Json));
    const auto Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(Base / TEXT("chat/cancel")); Request->SetVerb(TEXT("POST")); Request->SetTimeout(5.f);
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json")); Request->SetContentAsString(Json);
    Request->ProcessRequest(); // Cancellation remains valid after the widget's generation changes.
}

void SHaybaMCPChatPanel::TickChildAgents(double Time)
{
    if (!bChildAgentsLoading && Time >= NextChildAgentPoll && (bIsStreaming || NextChildAgentPoll < 0 ||
        ChildAgents.ContainsByPredicate([](const auto& Agent) { return Agent && ActiveChild(*Agent); })))
        RefreshChildAgents();
}
