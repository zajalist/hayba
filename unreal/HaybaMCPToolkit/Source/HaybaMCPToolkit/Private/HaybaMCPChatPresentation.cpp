#include "HaybaMCPChatPanel.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPActivityModel.h"
#include "HaybaMCPAgentClient.h"
#include "HaybaMCPMainPanel.h"
#include "Slate/SHaybaChatTranscript.h"
#include "Slate/SHaybaActivityCard.h"
#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformProcess.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "ContentBrowserModule.h"
#include "IContentBrowserSingleton.h"
#include "Misc/App.h"
#include "Misc/Paths.h"
#include "DesktopPlatformModule.h"
#include "IDesktopPlatform.h"
#include "Editor.h"
#include "Engine/Selection.h"
#include "GameFramework/Actor.h"
#include "HaybaMCPEditorHealth.h"
#include "Misc/EngineVersion.h"
#include "Misc/DateTime.h"
#include "HaybaMCPFab.h"

namespace
{
    FString StepState(EHaybaActivityState State)
    {
        FHaybaActivity Activity;
        Activity.State = State;
        return SHaybaActivityCard::Describe(Activity).StateLabel;
    }
}

bool SHaybaMCPChatPanel::IsWebWorkspaceReady() const
{
    return WebTranscript.IsValid() && WebTranscript->IsReady();
}

void SHaybaMCPChatPanel::AddContextReference(const FString& Path, const FString& Kind)
{
    if (Path.IsEmpty() || Path.Len() > 4096 || ContextReferences.Num() >= 32 ||
        ContextReferences.ContainsByPredicate([&Path](const FContextReference& Item) { return Item.Path == Path; })) return;
    FContextReference Item;
    Item.Id = FGuid::NewGuid().ToString(EGuidFormats::Digits);
    Item.Label = FPaths::GetCleanFilename(Path);
    Item.Path = Path;
    Item.Kind = Kind;
    ContextReferences.Add(MoveTemp(Item));
    bTranscriptDirty = true;
}

void SHaybaMCPChatPanel::AttachWorkspaceContext(bool bFile)
{
    if (bFile)
    {
        const FString Generation = TranscriptGeneration;
        TArray<FString> Files;
        IDesktopPlatform* Desktop = FDesktopPlatformModule::Get();
        if (Desktop && Desktop->OpenFileDialog(nullptr, TEXT("Attach file references"), FString(), FString(),
            TEXT("All files (*.*)|*.*"), EFileDialogFlags::Multiple, Files) && Generation == TranscriptGeneration)
            for (const FString& File : Files) AddContextReference(File, TEXT("file"));
        return;
    }
    TArray<FAssetData> Assets;
    FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser")).Get().GetSelectedAssets(Assets);
    for (const FAssetData& Asset : Assets) AddContextReference(Asset.GetObjectPathString(), TEXT("asset"));
    if (GEditor)
        for (FSelectionIterator It(*GEditor->GetSelectedActors()); It; ++It)
            if (const AActor* Actor = Cast<AActor>(*It)) AddContextReference(Actor->GetPathName(), TEXT("actor"));
}

void SHaybaMCPChatPanel::UpdateWebTranscript()
{
    if (!WebTranscript.IsValid() || WebTranscript->HasFailed()) return;
    const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
    const FString SettingsState = Settings.SelectedProviderId + TEXT("\n") + Settings.Model + TEXT("\n") +
        Settings.BrainLlmMode + TEXT("\n") + Settings.BaseURL + TEXT("\n") + Settings.SidecarURL +
        (Settings.bUseHaybaPro ? TEXT("\npro") : TEXT("\ncommunity")) +
        (FHaybaMCPSettings::HasProviderKey(Settings.SelectedProviderId) ? TEXT("\nkey") : TEXT("\nno-key"));
    if (SettingsState != LastWorkspaceSettings)
    {
        LastWorkspaceSettings = SettingsState;
        bTranscriptDirty = true;
        if (bCredentialSetupRequired && !NeedsCredentialSetup()) bCredentialSetupRequired = false;
        if (DiscoveredModels.IsSet() && DiscoveredModels->Provider != Settings.SelectedProviderId) DiscoveredModels.Reset();
    }
    const uint32 Flags = uint32(bIsStreaming) | uint32(bInspectInFlight) << 1 | uint32(bLoadingSession) << 2 |
        uint32(bAwaitingPlanApproval) << 3 | uint32(CanSend()) << 4 |
        uint32(Module && !Module->PendingExternalPlan.IsEmpty()) << 5 | uint32(bCredentialSetupRequired) << 6;
    if (!bTranscriptDirty && LastTranscriptFlags == Flags) return;
    bTranscriptDirty = false;
    LastTranscriptFlags = Flags;
    auto Root = MakeShared<FJsonObject>();
    Root->SetStringField(TEXT("generation"), TranscriptGeneration);
    Root->SetBoolField(TEXT("busy"), bIsStreaming || bInspectInFlight || bLoadingSession);
    Root->SetBoolField(TEXT("inspecting"), bInspectInFlight);
    Root->SetBoolField(TEXT("awaitingApproval"), bAwaitingPlanApproval);
    Root->SetBoolField(TEXT("canSend"), CanSend() && !bInspectInFlight && (!Module || Module->PendingExternalPlan.IsEmpty()));
    Root->SetBoolField(TEXT("externalReview"), Module && !Module->PendingExternalPlan.IsEmpty());
    TArray<TSharedPtr<FJsonValue>> Messages;
    for (int32 Index = 0; Index < Session.Messages.Num(); ++Index)
    {
        const FHaybaMCPChatMessage& Message = Session.Messages[Index];
        auto Row = MakeShared<FJsonObject>();
        Row->SetNumberField(TEXT("id"), Index);
        Row->SetStringField(TEXT("role"), Message.bFromUser ? TEXT("user") : Message.bToolResult ? TEXT("inspection") : TEXT("assistant"));
        Row->SetStringField(TEXT("text"), Message.Text);
        Row->SetBoolField(TEXT("notice"), !Message.bFromUser && Message.Text.StartsWith(TEXT("⚠")));
        Row->SetBoolField(TEXT("retry"), Index == RetryMessageIndex && !RetryPromptText.IsEmpty());
        Row->SetBoolField(TEXT("community"), Index == CommunityFallbackMessageIndex);
        const FHaybaActivity* Activity = Module && !Message.ActivityId.IsEmpty() ? Module->GetActivityModel().FindActivity(Message.ActivityId) : nullptr;
        if (Activity)
        {
            auto Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("id"), Activity->ActivityId);
            Item->SetStringField(TEXT("specialistId"), Activity->SpecialistId);
            Item->SetStringField(TEXT("title"), Activity->Title);
            Item->SetStringField(TEXT("state"), SHaybaActivityCard::Describe(*Activity).StateLabel);
            Item->SetStringField(TEXT("error"), Activity->Error);
            TArray<TSharedPtr<FJsonValue>> Steps, Verdicts;
            for (const FHaybaActivityStep& Step : Activity->Steps)
            {
                auto Entry = MakeShared<FJsonObject>();
                Entry->SetStringField(TEXT("id"), Step.Id);
                Entry->SetStringField(TEXT("specialistId"), Step.SpecialistId);
                Entry->SetStringField(TEXT("name"), Step.Name);
                Entry->SetStringField(TEXT("state"), StepState(Step.State));
                Entry->SetStringField(TEXT("input"), Step.InputJson);
                Entry->SetStringField(TEXT("result"), Step.ResultJson);
                Steps.Add(MakeShared<FJsonValueObject>(Entry));
            }
            for (const FHaybaActivityVerdict& Verdict : Activity->Verdicts)
                Verdicts.Add(MakeShared<FJsonValueString>(Verdict.Severity + TEXT(": ") + Verdict.Message));
            Item->SetArrayField(TEXT("steps"), Steps);
            Item->SetArrayField(TEXT("verdicts"), Verdicts);
            if (Activity->State == EHaybaActivityState::AwaitingApproval && Activity->Approval.IsSet())
            {
                auto Approval = MakeShared<FJsonObject>();
                Approval->SetStringField(TEXT("id"), Activity->Approval->ApprovalId);
                Approval->SetStringField(TEXT("hint"), Activity->Approval->Hint);
                Approval->SetStringField(TEXT("input"), Activity->Approval->Call.Name + TEXT("\n") + Activity->Approval->Call.InputJson);
                Approval->SetBoolField(TEXT("native"), Activity->Approval->Source == TEXT("ue"));
                Approval->SetBoolField(TEXT("enabled"), bAwaitingPlanApproval && PendingActivityId == Activity->ActivityId &&
                    AgentClient.IsValid() && !AgentClient->IsStreaming());
                Item->SetObjectField(TEXT("approval"), Approval);
            }
            Row->SetObjectField(TEXT("activity"), Item);
        }
        Messages.Add(MakeShared<FJsonValueObject>(Row));
    }
    Root->SetArrayField(TEXT("messages"), Messages);
    auto Workspace = MakeShared<FJsonObject>();
    Workspace->SetStringField(TEXT("sessionId"), AgentClient.IsValid() ? AgentClient->GetSessionId() : FString());
    Workspace->SetBoolField(TEXT("credentialSetupRequired"), bCredentialSetupRequired && NeedsCredentialSetup());
    Workspace->SetStringField(TEXT("title"), Session.Goal.IsEmpty() ? TEXT("New conversation") : Session.Goal.Left(80));
    Workspace->SetStringField(TEXT("project"), FApp::GetProjectName());
    auto Diagnostics = MakeShared<FJsonObject>();
    const auto Health = FHaybaEditorHealth::Snapshot();
    Diagnostics->SetStringField(TEXT("observedAt"), FDateTime::UtcNow().ToIso8601());
    Diagnostics->SetStringField(TEXT("engine"), FEngineVersion::Current().ToString());
    Diagnostics->SetNumberField(TEXT("processId"), FPlatformProcess::GetCurrentProcessId());
    Diagnostics->SetBoolField(TEXT("bridgeRunning"), Module && Module->IsTcpServerRunning());
    Diagnostics->SetBoolField(TEXT("restartRequired"), Health.bUnsafe);
    Diagnostics->SetBoolField(TEXT("mustNotSave"), HaybaMCPHealth::IsStatusOnlyCause(Health.GateCause));
    Diagnostics->SetBoolField(TEXT("credentialsReady"), !NeedsCredentialSetup());
    Workspace->SetObjectField(TEXT("diagnostics"), Diagnostics);
    auto Draft = MakeShared<FJsonObject>();
    Draft->SetStringField(TEXT("text"), InputBox.IsValid() ? InputBox->GetText().ToString() : FString());
    Draft->SetNumberField(TEXT("revision"), DraftRevision);
    Draft->SetNumberField(TEXT("ack"), DraftAck);
    Workspace->SetObjectField(TEXT("draft"), Draft);
    Workspace->SetStringField(TEXT("mode"), WorkMode);
    auto Model = MakeShared<FJsonObject>();
    Model->SetStringField(TEXT("id"), EffectiveModelId());
    Model->SetStringField(TEXT("name"), ModelDisplayName());
    Model->SetStringField(TEXT("provider"), FHaybaMCPSettings::Get().SelectedProviderId);
    Model->SetBoolField(TEXT("locked"), IsSubscriptionModel() || bIsStreaming || bAwaitingPlanApproval || bLoadingSession);
    Model->SetBoolField(TEXT("loading"), bModelDiscoveryLoading);
    FString ModelMessage = ModelMenuMessage;
    if (DiscoveredModels.IsSet() && ModelMessage.IsEmpty())
        ModelMessage = !DiscoveredModels->Error.IsEmpty() ? DiscoveredModels->Error : DiscoveredModels->Note;
    if (bCredentialSetupRequired) ModelMessage = TEXT("Configure your chat provider in Settings before sending. Your draft is saved.");
    Model->SetStringField(TEXT("message"), ModelMessage);
    Model->SetBoolField(TEXT("manualAllowed"), !IsSubscriptionModel() && (!DiscoveredModels.IsSet() || DiscoveredModels->bManualEntryAllowed));
    TArray<TSharedPtr<FJsonValue>> Models;
    if (DiscoveredModels.IsSet() && DiscoveredModels->Provider == FHaybaMCPSettings::Get().SelectedProviderId)
        for (const FHaybaMCPDiscoveredModel& Available : DiscoveredModels->Models)
        {
            auto Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("id"), Available.Id);
            Item->SetStringField(TEXT("name"), Available.Name);
            const bool bSuitable = Available.ChatCapability != EHaybaMCPModelChatCapability::No && Available.ToolUse != EHaybaMCPModelToolUse::No;
            const bool bVerified = Available.ChatCapability == EHaybaMCPModelChatCapability::Yes &&
                (Available.ToolUse == EHaybaMCPModelToolUse::Yes || Available.ToolUse == EHaybaMCPModelToolUse::Trained);
            Item->SetBoolField(TEXT("available"), bSuitable);
            Item->SetStringField(TEXT("description"), !bSuitable ? TEXT("Not suitable for chat tools") : !bVerified
                ? PendingUnverifiedModelId == Available.Id ? TEXT("Select again to confirm unverified tool support") : TEXT("Tool support unverified; confirmation required")
                : TEXT("Supports chat tools"));
            Models.Add(MakeShared<FJsonValueObject>(Item));
        }
    Model->SetArrayField(TEXT("models"), Models);
    Workspace->SetObjectField(TEXT("model"), Model);
    auto Effort = MakeShared<FJsonObject>();
    Effort->SetStringField(TEXT("value"), EffectiveReasoningEffort());
    TArray<TSharedPtr<FJsonValue>> Efforts;
    for (const FString& Value : AvailableReasoningEfforts()) Efforts.Add(MakeShared<FJsonValueString>(Value));
    Effort->SetArrayField(TEXT("options"), Efforts);
    Workspace->SetObjectField(TEXT("effort"), Effort);
    TArray<TSharedPtr<FJsonValue>> Sessions, Context, Connections, Jobs;
    for (const FRecentSession& Recent : RecentSessions)
    {
        auto Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("id"), Recent.Id);
        Item->SetStringField(TEXT("title"), Recent.Title);
        Item->SetStringField(TEXT("updatedAt"), Recent.UpdatedAt);
        Sessions.Add(MakeShared<FJsonValueObject>(Item));
    }
    Workspace->SetArrayField(TEXT("sessions"), Sessions);
    Workspace->SetStringField(TEXT("sessionStatus"), RecentSessionsStatus);
    auto History = MakeShared<FJsonObject>();
    History->SetStringField(TEXT("query"), HistoryQuery); History->SetNumberField(TEXT("offset"), HistoryOffset);
    History->SetNumberField(TEXT("total"), HistoryTotal); History->SetBoolField(TEXT("hasMore"), bHistoryHasMore);
    History->SetNumberField(TEXT("nextOffset"), HistoryNextOffset);
    Workspace->SetObjectField(TEXT("history"), History);
    auto Subagents = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Agents;
    for (const auto& Agent : ChildAgents) Agents.Add(MakeShared<FJsonValueObject>(Agent));
    Subagents->SetArrayField(TEXT("agents"), Agents); Subagents->SetBoolField(TEXT("loading"), bChildAgentsLoading);
    Subagents->SetStringField(TEXT("error"), ChildAgentsError);
    Workspace->SetObjectField(TEXT("subagents"), Subagents);
    for (const FContextReference& Reference : ContextReferences)
    {
        auto Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("id"), Reference.Id); Item->SetStringField(TEXT("label"), Reference.Label);
        Item->SetStringField(TEXT("path"), Reference.Path); Item->SetStringField(TEXT("kind"), Reference.Kind);
        Context.Add(MakeShared<FJsonValueObject>(Item));
    }
    Workspace->SetArrayField(TEXT("context"), Context);
    for (const FString& Provider : { FString(TEXT("meshy")), FString(TEXT("tripo")), FString(TEXT("aholo")), FString(TEXT("fal")), FString(TEXT("worldlabs")) })
    {
        auto Item = MakeShared<FJsonObject>();
        const FString VaultId = TEXT("3d-") + Provider;
        const bool bConfigured = FHaybaMCPSettings::HasProviderKey(VaultId);
        Item->SetStringField(TEXT("id"), Provider);
        Item->SetStringField(TEXT("name"), Provider == TEXT("meshy") ? TEXT("Meshy") : Provider == TEXT("tripo") ? TEXT("Tripo") :
            Provider == TEXT("fal") ? TEXT("fal.ai") : Provider == TEXT("worldlabs") ? TEXT("World Labs") : TEXT("Aholo / Lux3D"));
        Item->SetBoolField(TEXT("configured"), bConfigured);
        const FString Key = FHaybaMCPSettings::GetProviderKey(VaultId);
        if (Key.Len() > 4) Item->SetStringField(TEXT("keyLast4"), Key.Right(4));
        Item->SetStringField(TEXT("state"), !bConfigured ? TEXT("not_connected") : ConnectionStates.Contains(Provider) ? ConnectionStates[Provider] : TEXT("configured"));
        Item->SetStringField(TEXT("message"), ConnectionMessages.FindRef(Provider));
        Connections.Add(MakeShared<FJsonValueObject>(Item));
    }
    Workspace->SetArrayField(TEXT("connections"), Connections);
    for (const FGeneration3DJob& Job : Generation3DJobs)
    {
        auto Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("id"), Job.Id); Item->SetStringField(TEXT("provider"), Job.Provider);
        Item->SetStringField(TEXT("kind"), Job.Kind);
        Item->SetStringField(TEXT("task_id"), Job.TaskId); Item->SetStringField(TEXT("prompt"), Job.Prompt);
        Item->SetStringField(TEXT("status"), Job.Status);
        if (Job.bProgressKnown) Item->SetNumberField(TEXT("progress"), Job.Progress);
        else Item->SetField(TEXT("progress"), MakeShared<FJsonValueNull>());
        if (!Job.ModelUrl.IsEmpty()) Item->SetStringField(TEXT("model_url"), Job.ModelUrl);
        if (!Job.ResultUrl.IsEmpty()) Item->SetStringField(TEXT("result_url"), Job.ResultUrl);
        if (!Job.ThumbnailUrl.IsEmpty()) Item->SetStringField(TEXT("thumbnail_url"), Job.ThumbnailUrl);
        if (!Job.Error.IsEmpty()) Item->SetStringField(TEXT("error"), Job.Error);
        if (!Job.Phase.IsEmpty()) Item->SetStringField(TEXT("phase"), Job.Phase);
        Jobs.Add(MakeShared<FJsonValueObject>(Item));
    }
    Workspace->SetArrayField(TEXT("jobs"), Jobs);
    auto Generation3D = MakeShared<FJsonObject>();
    Generation3D->SetBoolField(TEXT("busy"), bGeneration3DBusy);
    if (!Generation3DError.IsEmpty()) Generation3D->SetStringField(TEXT("error"), Generation3DError);
    Workspace->SetObjectField(TEXT("generation3d"), Generation3D);
    Root->SetObjectField(TEXT("workspace"), Workspace);
    WebTranscript->SetSnapshot(Root);
}

void SHaybaMCPChatPanel::HandleTranscriptAction(const FJsonObject& Event)
{
    // Recheck on the game thread: a queued browser click may outlive its conversation.
    if (Event.GetStringField(TEXT("generation")) != TranscriptGeneration)
    {
        if (Event.GetStringField(TEXT("action")) == TEXT("copy") && WebTranscript) WebTranscript->AcknowledgeCopy(false);
        return;
    }
    const FString Action = Event.GetStringField(TEXT("action"));
    const FString Value = Event.GetStringField(TEXT("value"));
    bTranscriptDirty = true;
    const bool bIdle = CanSend() && !bIsStreaming && !bInspectInFlight && (!Module || Module->PendingExternalPlan.IsEmpty());
    if (Action == TEXT("send") || Action == TEXT("draft_changed"))
    {
        const double Seq = Event.GetNumberField(TEXT("seq"));
        if (Seq <= DraftAck || !InputBox) return;
        DraftAck = Seq;
        InputBox->SetText(FText::FromString(Value));
        if (Action == TEXT("send")) OnSendCurrentInput();
    }
    else if (Action == TEXT("diagnostics")) { return; } // Dirty projection refreshes the local snapshot without changing the draft.
    else if (Action == TEXT("fab_browser"))
    {
        FString Error;
        if (FHaybaEditorHealth::IsUnsafe()) AddSystemError(TEXT("Restart the editor before opening Fab; the native fault guard is active. Check Editor status for recovery details."), FString());
        else if (!HaybaFab::OpenBrowser(Error)) AddSystemError(Error, FString());
    }
    else if (Action == TEXT("stop")) { if (bIsStreaming || bAwaitingPlanApproval) StopGeneration(); }
    else if (Action == TEXT("new")) { if (bIdle) OnNewConversation(); }
    else if (Action == TEXT("history"))
    {
        FString Query;
        if (Event.TryGetStringField(TEXT("query"), Query)) { HistoryQuery = Query; HistoryOffset = 0; }
        double Offset = 0;
        if (Event.TryGetNumberField(TEXT("offset"), Offset)) HistoryOffset = int32(Offset);
        RefreshRecentSessions();
    }
    else if (Action == TEXT("session") && bIdle && RecentSessions.ContainsByPredicate([&Value](const FRecentSession& Recent) { return Recent.Id == Value; })) OpenSavedSession(Value);
    else if (Action == TEXT("models")) { if (bIdle && !IsSubscriptionModel() && !bModelDiscoveryLoading) BuildModelMenu(); }
    else if (Action == TEXT("model") && bIdle && !IsSubscriptionModel())
    {
        const FHaybaMCPDiscoveredModel* Selected = DiscoveredModels.IsSet() && DiscoveredModels->Provider == FHaybaMCPSettings::Get().SelectedProviderId
            ? DiscoveredModels->Models.FindByPredicate([&Value](const FHaybaMCPDiscoveredModel& Model) { return Model.Id == Value; }) : nullptr;
        if (Selected)
        {
            const bool bImpossible = Selected->ChatCapability == EHaybaMCPModelChatCapability::No || Selected->ToolUse == EHaybaMCPModelToolUse::No;
            const bool bVerified = Selected->ChatCapability == EHaybaMCPModelChatCapability::Yes &&
                (Selected->ToolUse == EHaybaMCPModelToolUse::Yes || Selected->ToolUse == EHaybaMCPModelToolUse::Trained);
            if (!bImpossible && (bVerified || PendingUnverifiedModelId == Value)) OnSetModel(Value);
            else if (!bImpossible) { PendingUnverifiedModelId = Value; ModelMenuMessage = TEXT("Select this model again to confirm unverified tool support."); }
        }
        else if (!DiscoveredModels.IsSet() || DiscoveredModels->bManualEntryAllowed)
            OnManualModelCommitted(FText::FromString(Value), ETextCommit::OnEnter);
    }
    else if (Action == TEXT("effort") && bIdle) OnSetEffort(Value);
    else if (Action == TEXT("mode") && bIdle) OnSetWorkMode(Value);
    else if ((Action == TEXT("settings") || Action == TEXT("activity")) && Module)
    {
        if (const auto Main = Module->MainPanel.Pin()) Main->ShowPanel(Action == TEXT("settings") ? EHaybaPanel::Settings : EHaybaPanel::Activity);
    }
    else if (Action == TEXT("attach_selection") || Action == TEXT("attach_file")) AttachWorkspaceContext(Action == TEXT("attach_file"));
    else if (Action == TEXT("remove_context")) ContextReferences.RemoveAll([&Value](const FContextReference& Reference) { return Reference.Id == Value; });
    else if (Action == TEXT("connections"))
    {
        for (const FString& Provider : { FString(TEXT("meshy")), FString(TEXT("tripo")), FString(TEXT("aholo")), FString(TEXT("fal")), FString(TEXT("worldlabs")) })
            if (FHaybaMCPSettings::HasProviderKey(TEXT("3d-") + Provider)) Check3DConnection(Provider);
    }
    else if (Action == TEXT("connect_provider") && bIdle) Configure3DProvider(Value);
    else if (Action == TEXT("disconnect_provider") && bIdle && !bGeneration3DBusy &&
        !Generation3DJobs.ContainsByPredicate([&Value](const FGeneration3DJob& Job) { return Job.Provider == Value && (Job.Status == TEXT("queued") || Job.Status == TEXT("running")); }))
    {
        ++ConnectionGenerations.FindOrAdd(Value);
        FHaybaMCPSettings::ClearProviderKey(TEXT("3d-") + Value);
        ConnectionStates.Remove(Value); ConnectionMessages.Remove(Value);
    }
    else if (Action == TEXT("generate_3d") && bIdle) Start3DGeneration(Event);
    else if (Action == TEXT("refresh_3d")) Refresh3DJob(Value);
    else if (Action == TEXT("open_result") || Action == TEXT("use_result"))
    {
        const FGeneration3DJob* Job = Generation3DJobs.FindByPredicate([&Value](const FGeneration3DJob& Item) { return Item.Id == Value; });
        const FString Url = Job ? Job->ResultUrl.IsEmpty() ? Job->ModelUrl : Job->ResultUrl : FString();
        if (Job && Job->Status == TEXT("succeeded") && Url.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase) && HaybaChatText::IsSafeWebLink(Url))
        {
            if (Action == TEXT("open_result")) FPlatformProcess::LaunchURL(*Url, nullptr, nullptr);
            else DraftPrompt(TEXT("Review this generated ") + Job->Kind + TEXT(" result and propose how to use it in the project: ") + Url);
        }
    }
    else if (Action == TEXT("subagents")) RefreshChildAgents();
    else if (Action == TEXT("cancel_subagent")) CancelChildAgent(Value);
    else if (Action == TEXT("use_subagent_result"))
    {
        const auto* Agent = ChildAgents.FindByPredicate([&Value](const auto& Item) { return Item->GetStringField(TEXT("id")) == Value; });
        if (Agent && (*Agent)->GetStringField(TEXT("status")) == TEXT("succeeded"))
        { FString Output; if ((*Agent)->TryGetStringField(TEXT("output"), Output) && !Output.IsEmpty()) DraftPrompt(TEXT("Review this subagent result and propose the next step:\n\n") + Output); }
    }
    else if (Action == TEXT("copy"))
    {
        FPlatformApplicationMisc::ClipboardCopy(*Value);
        FString Copied; FPlatformApplicationMisc::ClipboardPaste(Copied);
        if (WebTranscript) WebTranscript->AcknowledgeCopy(Copied == Value);
    }
    else if (Action == TEXT("inspect")) OnInspectWorld();
    else if (Action == TEXT("draft") && CanSend()) DraftPrompt(Value);
    else if (Action == TEXT("retry") && Value == FString::FromInt(RetryMessageIndex)) RestoreRetryPrompt();
    else if (Action == TEXT("community") && Value == FString::FromInt(CommunityFallbackMessageIndex)) OnUseCommunityForThisChat();
    else if (Action == TEXT("link"))
    {
        if (HaybaChatText::IsSafeAssetReference(Value))
        {
            const FAssetData Asset = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get().GetAssetByObjectPath(FSoftObjectPath(Value));
            if (Asset.IsValid()) FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser")).Get().SyncBrowserToAssets(TArray<FAssetData>{Asset});
        }
        else if (HaybaChatText::IsSafeWebLink(Value)) FPlatformProcess::LaunchURL(*Value, nullptr, nullptr);
    }
    else if ((Action == TEXT("approve") || Action == TEXT("reject")) && Module)
    {
        FString ApprovalId;
        const FHaybaActivity* Activity = Module->GetActivityModel().FindActivity(Value);
        if (!Event.TryGetStringField(TEXT("approval"), ApprovalId) || !Activity || !Activity->Approval.IsSet() ||
            Activity->Approval->Source == TEXT("ue") || !Module->GetActivityModel().CanResolveApproval(Value, ApprovalId)) return;
        if (Action == TEXT("approve")) ApproveActivity(Value);
        else RejectActivity(Value);
    }
}
