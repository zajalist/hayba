#include "Misc/AutomationTest.h"
#include "Slate/SHaybaChatTranscript.h"
#include "HaybaMCPChatPanel.h"
#include "HaybaMCPAgentClient.h"
#include "Serialization/JsonSerializer.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaChatTranscriptBridgeTest, "Hayba.Chat.Transcript.Bridge",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatTranscriptBridgeTest::RunTest(const FString&)
{
    FJsonObject Event;
    Event.SetStringField(TEXT("token"), TEXT("document"));
    Event.SetStringField(TEXT("generation"), TEXT("conversation"));
    Event.SetStringField(TEXT("action"), TEXT("copy"));
    Event.SetStringField(TEXT("value"), TEXT("message"));
    TestTrue(TEXT("Current local action accepted"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("action"), TEXT("diagnostics"));
    Event.SetStringField(TEXT("value"), TEXT(""));
    TestTrue(TEXT("Read-only diagnostics refresh accepted"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("action"), TEXT("enable_updates"));
    TestTrue(TEXT("Current document can opt into incremental updates"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("action"), TEXT("fab_browser"));
    TestTrue(TEXT("User can open native Fab"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    TestFalse(TEXT("Other document rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("other"), TEXT("conversation")));
    TestFalse(TEXT("Old conversation rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("new")));
    Event.SetStringField(TEXT("action"), TEXT("resync"));
    TestTrue(TEXT("A missing generation snapshot can be recovered"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("new")));
    TestFalse(TEXT("Recovery still requires this document token"), SHaybaChatTranscript::ValidateAction(Event, TEXT("other"), TEXT("new")));
    Event.SetStringField(TEXT("value"), TEXT("not-a-read-only-refresh"));
    TestFalse(TEXT("Recovery cannot carry an operation"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("new")));
    Event.SetStringField(TEXT("value"), TEXT(""));
    Event.SetStringField(TEXT("action"), TEXT("execute_console"));
    TestFalse(TEXT("Arbitrary editor commands rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("action"), TEXT("draft_changed"));
    TestFalse(TEXT("Draft without sequence rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("seq"), TEXT("1"));
    TestFalse(TEXT("String sequence rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetNumberField(TEXT("seq"), 1.5);
    TestFalse(TEXT("Fractional sequence rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetNumberField(TEXT("seq"), -1);
    TestFalse(TEXT("Negative sequence rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetNumberField(TEXT("seq"), 9007199254740992.0);
    TestFalse(TEXT("Unsafe integer sequence rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetNumberField(TEXT("seq"), 12);
    TestTrue(TEXT("Typed current draft accepted"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("action"), TEXT("send"));
    TestTrue(TEXT("Typed send accepted"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    TestFalse(TEXT("Send from old conversation rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("different")));
    Event.RemoveField(TEXT("seq"));
    Event.SetStringField(TEXT("action"), TEXT("connect_provider"));
    Event.SetStringField(TEXT("value"), TEXT("meshy"));
    TestTrue(TEXT("Native provider dialog accepted"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("api_key"), TEXT("must-never-cross-the-page"));
    TestFalse(TEXT("Page cannot submit credentials"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.RemoveField(TEXT("api_key"));
    Event.SetStringField(TEXT("value"), TEXT("arbitrary-provider"));
    TestFalse(TEXT("Unknown provider rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("action"), TEXT("generate_3d"));
    Event.SetStringField(TEXT("value"), TEXT("tripo"));
    Event.SetStringField(TEXT("prompt"), TEXT("A stone arch"));
    TestTrue(TEXT("Explicit generation accepted"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetObjectField(TEXT("model"), MakeShared<FJsonObject>());
    TestFalse(TEXT("Nested generation parameters rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetNumberField(TEXT("model"), 12);
    TestFalse(TEXT("Numeric generation parameters rejected without coercion"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.RemoveField(TEXT("model"));
    Event.SetStringField(TEXT("value"), TEXT("fal"));
    Event.SetStringField(TEXT("kind"), TEXT("video"));
    TestTrue(TEXT("Video provider and typed kind accepted"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.RemoveField(TEXT("kind"));
    Event.RemoveField(TEXT("prompt"));
    Event.SetStringField(TEXT("action"), TEXT("history"));
    Event.SetStringField(TEXT("query"), TEXT("arch")); Event.SetNumberField(TEXT("offset"), 50);
    TestTrue(TEXT("Bounded history page accepted"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetNumberField(TEXT("offset"), 1.5);
    TestFalse(TEXT("Fractional history page rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.RemoveField(TEXT("query")); Event.RemoveField(TEXT("offset"));
    Event.SetStringField(TEXT("action"), TEXT("start_subagent")); Event.SetStringField(TEXT("value"), TEXT("Inspect the level for missing lighting"));
    Event.SetStringField(TEXT("specialist"), TEXT("director"));
    TestFalse(TEXT("Manual child launch is not a page action"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("api_key"), TEXT("forbidden"));
    TestFalse(TEXT("Child task cannot carry a page credential"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.RemoveField(TEXT("api_key")); Event.RemoveField(TEXT("specialist"));
    Event.SetStringField(TEXT("action"), TEXT("approve"));
    TestFalse(TEXT("Approval requires exact approval id"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("approval"), TEXT("approval-id"));
    TestTrue(TEXT("Typed approval accepted for native resolution guard"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.RemoveField(TEXT("approval"));
    Event.SetStringField(TEXT("action"), TEXT("ready"));
    Event.SetStringField(TEXT("generation"), TEXT(""));
    Event.SetStringField(TEXT("value"), TEXT(""));
    TestTrue(TEXT("Ready handshake before snapshot"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.SetStringField(TEXT("api_key"), TEXT("never-accepted"));
    TestFalse(TEXT("Handshake rejects additional fields"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    Event.RemoveField(TEXT("api_key"));
    Event.RemoveField(TEXT("token"));
    TestFalse(TEXT("Tokenless handshake rejected"), SHaybaChatTranscript::ValidateAction(Event, TEXT("document"), TEXT("conversation")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaChatWorkspaceStateTest, "Hayba.Chat.Workspace.State",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatWorkspaceStateTest::RunTest(const FString&)
{
    // Build only the native composer: no browser, sidecar, vault writes or provider calls.
    const auto Panel = MakeShared<SHaybaMCPChatPanel>();
    const auto Composer = Panel->BuildInput();
    FJsonObject Event;
    Event.SetStringField(TEXT("generation"), Panel->TranscriptGeneration);
    Event.SetStringField(TEXT("action"), TEXT("draft_changed"));
    Event.SetStringField(TEXT("value"), TEXT("Keep this draft"));
    Event.SetNumberField(TEXT("seq"), 1);
    Panel->HandleTranscriptAction(Event);
    TestEqual(TEXT("Draft accepted"), Panel->InputBox->GetText().ToString(), FString(TEXT("Keep this draft")));
    TestEqual(TEXT("Sequence acknowledged"), Panel->DraftAck, 1.0);
    const double InitialRevision = Panel->DraftRevision;
    Event.SetStringField(TEXT("value"), TEXT("Stale draft"));
    Event.SetNumberField(TEXT("seq"), 0);
    Panel->HandleTranscriptAction(Event);
    TestEqual(TEXT("Old sequence cannot replace draft"), Panel->InputBox->GetText().ToString(), FString(TEXT("Keep this draft")));
    Panel->AddContextReference(TEXT("/Game/Props/Arch.Arch"), TEXT("asset"));
    Panel->bLoadingSession = true;
    Event.SetStringField(TEXT("action"), TEXT("send"));
    Event.SetStringField(TEXT("value"), TEXT("Blocked send"));
    Event.SetNumberField(TEXT("seq"), 2);
    Panel->HandleTranscriptAction(Event);
    TestEqual(TEXT("Blocked send keeps submitted draft"), Panel->InputBox->GetText().ToString(), FString(TEXT("Blocked send")));
    TestEqual(TEXT("Blocked send retains context"), Panel->ContextReferences.Num(), 1);
    TestTrue(TEXT("Native draft changes advance revision"), Panel->DraftRevision > InitialRevision);
    Panel->OnNewConversation();
    TestEqual(TEXT("New conversation resets sequence acknowledgement"), Panel->DraftAck, 0.0);
    TestEqual(TEXT("New conversation clears old context"), Panel->ContextReferences.Num(), 0);
    Panel->HandleTranscriptAction(Event);
    TestEqual(TEXT("Old conversation cannot change the draft"), Panel->InputBox->GetText().ToString(), FString(TEXT("Blocked send")));

    SHaybaMCPChatPanel::FGeneration3DJob Job;
    Job.Id = TEXT("local-job"); Job.Provider = TEXT("meshy"); Job.Status = TEXT("queued");
    Panel->Generation3DJobs.Add(Job);
    Panel->bGeneration3DBusy = true;
    auto Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("provider"), TEXT("meshy")); Result->SetStringField(TEXT("task_id"), TEXT("preview-task"));
    Result->SetStringField(TEXT("status"), TEXT("succeeded")); Result->SetNumberField(TEXT("progress"), 100);
    Result->SetStringField(TEXT("model_url"), TEXT("file:///secret.glb"));
    Panel->Apply3DResult(Job.Id, Result, FString());
    TestTrue(TEXT("Unsafe result URLs never enter page state"), Panel->Generation3DJobs[0].ModelUrl.IsEmpty());
    TestFalse(TEXT("Completed task releases generation gate"), Panel->bGeneration3DBusy);
    Result->SetStringField(TEXT("task_id"), TEXT("different-task"));
    Panel->Apply3DResult(Job.Id, Result, FString());
    TestEqual(TEXT("Mismatched task response is rejected"), Panel->Generation3DJobs[0].Status, FString(TEXT("failed")));
    Panel->AgentClient = MakeShared<FHaybaMCPAgentClient>();
    Panel->AgentClient->SetSessionId(TEXT("parent-test"));
    auto Child = MakeShared<FJsonObject>();
    Child->SetStringField(TEXT("id"), TEXT("child-test")); Child->SetStringField(TEXT("parent_session_id"), TEXT("parent-test"));
    Child->SetStringField(TEXT("status"), TEXT("succeeded")); Child->SetStringField(TEXT("output"), TEXT("Lighting review complete"));
    Child->SetStringField(TEXT("api_key"), TEXT("must-not-be-projected"));
    auto Roster = MakeShared<FJsonObject>(); Roster->SetObjectField(TEXT("agent"), Child);
    Panel->NextChildAgentPoll = -1;
    Panel->SetChildAgents(Roster);
    TestTrue(TEXT("Final roster refresh survives an in-flight poll response"), Panel->NextChildAgentPoll < 0);
    TestEqual(TEXT("Current child summary projected"), Panel->ChildAgents.Num(), 1);
    if (!Panel->ChildAgents.IsEmpty()) TestFalse(TEXT("Unexpected child fields never enter page state"), Panel->ChildAgents[0]->HasField(TEXT("api_key")));
    Child->SetStringField(TEXT("parent_session_id"), TEXT("another-parent"));
    Roster->SetArrayField(TEXT("agents"), TArray<TSharedPtr<FJsonValue>>{ MakeShared<FJsonValueObject>(Child) });
    Panel->SetChildAgents(Roster);
    TestEqual(TEXT("Other parent children rejected"), Panel->ChildAgents.Num(), 0);
    return true;
}
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaChatTranscriptUpdatesTest, "Hayba.Chat.Transcript.Updates",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatTranscriptUpdatesTest::RunTest(const FString&)
{
    FHaybaTranscriptUpdates Updates;
    auto State = MakeShared<FJsonObject>();
    State->SetStringField(TEXT("generation"), TEXT("one"));
    TArray<TSharedPtr<FJsonValue>> Messages;
    for (int32 Index = 0; Index < 1000; ++Index)
    {
        auto Row = MakeShared<FJsonObject>();
        Row->SetNumberField(TEXT("id"), Index);
        Row->SetStringField(TEXT("text"), FString::ChrN(1024, TCHAR('x')));
        Messages.Add(MakeShared<FJsonValueObject>(Row));
    }
    State->SetArrayField(TEXT("messages"), Messages);
    const FString Full = Updates.Serialize(State);
    TestTrue(TEXT("first snapshot retains the whole history"), Full.Len() > 1024 * 1000);
    Messages.Last()->AsObject()->SetStringField(TEXT("text"), TEXT("streamed update"));
    State->SetBoolField(TEXT("busy"), true);
    const FString Delta = Updates.Serialize(State);
    TestTrue(TEXT("single-row update stays below 1 KiB for a 1 MiB history"), Delta.Len() < 1024);
    TSharedPtr<FJsonObject> Parsed;
    FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Delta), Parsed);
    if (!TestTrue(TEXT("delta parses"), Parsed.IsValid())) return false;
    TestFalse(TEXT("delta does not retransmit history"), Parsed->HasField(TEXT("messages")));
    const auto Patch = Parsed->GetObjectField(TEXT("messagePatch"));
    TestEqual(TEXT("delta identifies the previous revision"), Patch->GetNumberField(TEXT("base")), 1.0);
    TestEqual(TEXT("all rows remain addressable"), Patch->GetNumberField(TEXT("length")), 1000.0);
    TestEqual(TEXT("only one changed row is sent"), Patch->GetArrayField(TEXT("updates")).Num(), 1);
    TestTrue(TEXT("non-message state survives"), Parsed->GetBoolField(TEXT("busy")));
    Messages.SetNum(20);
    State->SetArrayField(TEXT("messages"), Messages);
    FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Updates.Serialize(State)), Parsed);
    TestEqual(TEXT("removal is explicit"), Parsed->GetObjectField(TEXT("messagePatch"))->GetNumberField(TEXT("length")), 20.0);
    Updates.Reset();
    FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Updates.Serialize(State)), Parsed);
    TestEqual(TEXT("resync restores complete current history"), Parsed->GetArrayField(TEXT("messages")).Num(), 20);
    State->SetStringField(TEXT("generation"), TEXT("two"));
    FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Updates.Serialize(State)), Parsed);
    TestTrue(TEXT("new conversation always starts with a full snapshot"), Parsed->HasField(TEXT("messages")));
    return true;
}
#endif
