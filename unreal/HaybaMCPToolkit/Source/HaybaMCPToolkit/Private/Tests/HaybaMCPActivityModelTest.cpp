#include "Misc/AutomationTest.h"
#include "HaybaMCPActivityModel.h"
#include "HaybaMCPAgentClient.h"
#include "HaybaMCPModule.h"
#include "Slate/SHaybaActivityCard.h"
#include "Serialization/JsonSerializer.h"

#if WITH_DEV_AUTOMATION_TESTS
namespace HaybaActivityTests
{
    TSharedRef<FJsonObject> Json(const TCHAR* Text)
    {
        TSharedPtr<FJsonObject> Object;
        check(FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Object));
        return Object.ToSharedRef();
    }
    const TCHAR* Start = TEXT(R"({"type":"activity_started","activityId":"a1","title":"Inspect world","specialistId":"world"})");
    const TCHAR* Running = TEXT(R"({"type":"activity_step","activityId":"a1","step":{"status":"running","id":"c1","name":"actor_spawn","input":{"label":"Tree"}}})");
    const TCHAR* Finished = TEXT(R"({"type":"activity_step","activityId":"a1","step":{"status":"succeeded","id":"c1","name":"actor_spawn","result":{"ok":true}}})");
    const TCHAR* Approval = TEXT(R"({"type":"approval_requested","activityId":"a1","approvalId":"p1","call":{"id":"c1","name":"actor_spawn","input":{}},"argsHash":"hash","source":"ts"})");
    const TCHAR* Resume = TEXT(R"({"type":"activity_started","activityId":"a1","title":"Continue","resumeApprovalId":"p1"})");
    const TCHAR* Complete = TEXT(R"({"type":"activity_completed","activityId":"a1","outcome":"succeeded","reason":"end_turn","usage":{"inputTokens":3}})");
}
using namespace HaybaActivityTests;

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityCardPresentationTest, "Hayba.MCP.Agent.ActivityCard.Presentation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityCardPresentationTest::RunTest(const FString&)
{
    const TArray<TPair<EHaybaActivityState, FString>> States = {
        { EHaybaActivityState::Planning, TEXT("Planning") },
        { EHaybaActivityState::AwaitingApproval, TEXT("Awaiting approval") },
        { EHaybaActivityState::Running, TEXT("Running") },
        { EHaybaActivityState::Succeeded, TEXT("Succeeded") },
        { EHaybaActivityState::Failed, TEXT("Failed") },
    };
    for (const TPair<EHaybaActivityState, FString>& Entry : States)
    {
        FHaybaActivity Activity;
        Activity.ActivityId = TEXT("card-state");
        Activity.Title = TEXT("Inspect world");
        Activity.State = Entry.Key;
        if (Entry.Key == EHaybaActivityState::AwaitingApproval)
        {
            FHaybaActivityApproval PendingApproval;
            PendingApproval.ApprovalId = TEXT("approval");
            PendingApproval.Call.Name = TEXT("actor_spawn");
            PendingApproval.Hint = TEXT("Creates one actor; reversible with Undo.");
            Activity.Approval = PendingApproval;
        }
        const FHaybaActivityCardPresentation Presentation = SHaybaActivityCard::Describe(Activity);
        TestEqual(TEXT("state is an explicit label"), Presentation.StateLabel, Entry.Value);
        TestEqual(TEXT("title comes from the model"), Presentation.Title, FString(TEXT("Inspect world")));
        TestEqual(TEXT("approval actions are model-driven"), Presentation.bShowsApprovalActions,
            Entry.Key == EHaybaActivityState::AwaitingApproval);
    }
    FHaybaActivity Cancelled;
    Cancelled.Title = TEXT("Cancelled import");
    Cancelled.State = EHaybaActivityState::Failed;
    Cancelled.Outcome = TEXT("cancelled");
    TestEqual(TEXT("cancelled is a terminal outcome label"), SHaybaActivityCard::Describe(Cancelled).StateLabel,
        FString(TEXT("Cancelled")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityLifecycleTest, "Hayba.MCP.ActivityModel.Lifecycle",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityLifecycleTest::RunTest(const FString&)
{
    FHaybaActivityModel Model;
    int32 Changes = 0;
    Model.OnActivityChanged.AddLambda([&Changes](const FString&) { ++Changes; });
    TestTrue(TEXT("starts"), Model.ApplyEvent(*Json(Start)));
    TestTrue(TEXT("planning"), Model.FindActivity(TEXT("a1"))->State == EHaybaActivityState::Planning);
    TestTrue(TEXT("runs"), Model.ApplyEvent(*Json(Running)));
    TestTrue(TEXT("running"), Model.FindActivity(TEXT("a1"))->State == EHaybaActivityState::Running);
    TestTrue(TEXT("delta"), Model.ApplyEvent(*Json(TEXT(R"({"type":"message_delta","activityId":"a1","text":"Hello"})"))));
    TestTrue(TEXT("artifact"), Model.ApplyEvent(*Json(TEXT(R"({"type":"artifact_proposed","activityId":"a1","artifact":{"kind":"plan","id":"plan1","path":"/plans/1"}})"))));
    TestTrue(TEXT("verdict"), Model.ApplyEvent(*Json(TEXT(R"({"type":"verdict_emitted","activityId":"a1","verdict":{"code":"ready","message":"Ready","severity":"info","direction":"proceed"}})"))));
    TestTrue(TEXT("step completes"), Model.ApplyEvent(*Json(Finished)));
    TestTrue(TEXT("activity completes"), Model.ApplyEvent(*Json(Complete)));
    const FHaybaActivity& Activity = *Model.FindActivity(TEXT("a1"));
    TestTrue(TEXT("success"), Activity.State == EHaybaActivityState::Succeeded);
    TestEqual(TEXT("text"), Activity.Text, FString(TEXT("Hello")));
    TestEqual(TEXT("specialist"), Activity.SpecialistId, FString(TEXT("world")));
    TestEqual(TEXT("artifact count"), Activity.Artifacts.Num(), 1);
    TestEqual(TEXT("verdict count"), Activity.Verdicts.Num(), 1);
    TestTrue(TEXT("step success"), Activity.Steps[0].State == EHaybaActivityState::Succeeded);
    TestEqual(TEXT("one notification per change"), Changes, 7);
    TestFalse(TEXT("duplicate terminal"), Model.ApplyEvent(*Json(Complete)));
    TestEqual(TEXT("stable rejection"), Model.GetLastError(), FString(TEXT("ACTIVITY_TERMINAL")));
    TestEqual(TEXT("no rejected notification"), Changes, 7);
    TestTrue(TEXT("another independent activity"), Model.ApplyEvent(*Json(TEXT(R"({"type":"activity_started","activityId":"a2","title":"Second"})"))));
    TestEqual(TEXT("history survives next activity"), Model.GetActivities().Num(), 2);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityApprovalTest, "Hayba.MCP.ActivityModel.ApprovalIdentity",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityApprovalTest::RunTest(const FString&)
{
    FHaybaActivityModel Model;
    Model.ApplyEvent(*Json(Start));
    Model.ApplyEvent(*Json(Running));
    TestTrue(TEXT("approval requested"), Model.ApplyEvent(*Json(Approval)));
    TestTrue(TEXT("awaiting"), Model.FindActivity(TEXT("a1"))->State == EHaybaActivityState::AwaitingApproval);
    TestTrue(TEXT("matching action identity"), Model.CanResolveApproval(TEXT("a1"), TEXT("p1")));
    TestFalse(TEXT("wrong activity action"), Model.CanResolveApproval(TEXT("a2"), TEXT("p1")));
    TestFalse(TEXT("wrong approval action"), Model.CanResolveApproval(TEXT("a1"), TEXT("p2")));
    TestFalse(TEXT("completion cannot bypass approval"), Model.ApplyEvent(*Json(Complete)));
    TestFalse(TEXT("step cannot bypass approval"), Model.ApplyEvent(*Json(Finished)));
    TestFalse(TEXT("duplicate approval"), Model.ApplyEvent(*Json(Approval)));
    auto Wrong = Json(Resume);
    Wrong->SetStringField(TEXT("resumeApprovalId"), TEXT("wrong"));
    TestFalse(TEXT("wrong resume identity"), Model.ApplyEvent(*Wrong));
    TestEqual(TEXT("approval error"), Model.GetLastError(), FString(TEXT("APPROVAL_MISMATCH")));
    TestTrue(TEXT("matching resume"), Model.ApplyEvent(*Json(Resume)));
    TestTrue(TEXT("resumed state"), Model.FindActivity(TEXT("a1"))->State == EHaybaActivityState::Running);
    TestEqual(TEXT("unexecuted gated step retired"), Model.FindActivity(TEXT("a1"))->Steps.Num(), 0);
    TestFalse(TEXT("consumed identity"), Model.CanResolveApproval(TEXT("a1"), TEXT("p1")));
    TestTrue(TEXT("same call ID may be announced again"), Model.ApplyEvent(*Json(Running)));
    TestTrue(TEXT("resumed result"), Model.ApplyEvent(*Json(Finished)));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityTerminalTest, "Hayba.MCP.ActivityModel.TerminalTransitions",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityTerminalTest::RunTest(const FString&)
{
    for (const FString Outcome : { FString(TEXT("succeeded")), FString(TEXT("failed")), FString(TEXT("cancelled")) })
    {
        for (int32 Phase = 0; Phase < 3; ++Phase)
        {
            FHaybaActivityModel Model;
            Model.ApplyEvent(*Json(Start));
            if (Phase >= 1) Model.ApplyEvent(*Json(Running));
            if (Phase == 2) Model.ApplyEvent(*Json(Approval));
            auto Terminal = Json(Complete);
            Terminal->SetStringField(TEXT("outcome"), Outcome);
            const bool bAllowed = Phase != 2 || Outcome != TEXT("succeeded");
            TestEqual(TEXT("terminal transition"), Model.ApplyEvent(*Terminal), bAllowed);
            if (!bAllowed) continue;
            TestEqual(TEXT("preserved outcome"), Model.FindActivity(TEXT("a1"))->Outcome, Outcome);
            TestTrue(TEXT("terminal state"), Model.FindActivity(TEXT("a1"))->State ==
                (Outcome == TEXT("succeeded") ? EHaybaActivityState::Succeeded : EHaybaActivityState::Failed));
            TestFalse(TEXT("identical completion rejected"), Model.ApplyEvent(*Terminal));
            Terminal->SetStringField(TEXT("outcome"), Outcome == TEXT("failed") ? TEXT("succeeded") : TEXT("failed"));
            TestFalse(TEXT("conflicting completion rejected"), Model.ApplyEvent(*Terminal));
            TestFalse(TEXT("post-terminal start rejected"), Model.ApplyEvent(*Json(Start)));
            TestFalse(TEXT("post-terminal step rejected"), Model.ApplyEvent(*Json(Running)));
            TestFalse(TEXT("post-terminal delta rejected"), Model.ApplyEvent(*Json(TEXT(R"({"type":"message_delta","activityId":"a1","text":"late"})"))));
        }
    }
    for (int32 Phase = 0; Phase < 3; ++Phase)
    {
        FHaybaActivityModel Model;
        Model.ApplyEvent(*Json(Start));
        if (Phase >= 1) Model.ApplyEvent(*Json(Running));
        if (Phase == 2) Model.ApplyEvent(*Json(Approval));
        TestTrue(TEXT("error terminates active states"), Model.ApplyEvent(*Json(TEXT(R"({"type":"error","activityId":"a1","error":"Offline","kind":"network"})"))));
        TestTrue(TEXT("error failed"), Model.FindActivity(TEXT("a1"))->State == EHaybaActivityState::Failed);
        TestFalse(TEXT("error clears approval"), Model.CanResolveApproval(TEXT("a1"), TEXT("p1")));
        TestFalse(TEXT("error terminal"), Model.ApplyEvent(*Json(Complete)));
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityReconnectTest, "Hayba.MCP.ActivityModel.ReconnectUnknown",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityReconnectTest::RunTest(const FString&)
{
    FHaybaActivityModel Model;
    Model.ApplyEvent(*Json(Start));
    Model.ApplyEvent(*Json(Running));
    TestTrue(TEXT("connection loss changes active state"), Model.MarkDisconnected(TEXT("a1")));
    TestTrue(TEXT("unknown, never success"), Model.FindActivity(TEXT("a1"))->State == EHaybaActivityState::Unknown);
    TestTrue(TEXT("no inferred outcome"), Model.FindActivity(TEXT("a1"))->Outcome.IsEmpty());
    TestFalse(TEXT("repeated disconnect no change"), Model.MarkDisconnected(TEXT("a1")));
    TestTrue(TEXT("authoritative result reconciles"), Model.ApplyEvent(*Json(Finished)));
    TestTrue(TEXT("running again"), Model.FindActivity(TEXT("a1"))->State == EHaybaActivityState::Running);
    Model.ApplyEvent(*Json(Approval));
    Model.MarkDisconnected(TEXT("a1"));
    TestFalse(TEXT("unknown cannot authorize UI action"), Model.CanResolveApproval(TEXT("a1"), TEXT("p1")));
    TestFalse(TEXT("unknown cannot bypass pending approval"), Model.ApplyEvent(*Json(Complete)));
    TestTrue(TEXT("matching resume reconciles"), Model.ApplyEvent(*Json(Resume)));
    Model.MarkDisconnected(TEXT("a1"));
    TestTrue(TEXT("terminal reconciliation"), Model.ApplyEvent(*Json(Complete)));
    TestFalse(TEXT("disconnect preserves terminal"), Model.MarkDisconnected(TEXT("a1")));
    TestFalse(TEXT("missing activity disconnect"), Model.MarkDisconnected(TEXT("missing")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityInvalidTransitionTest, "Hayba.MCP.ActivityModel.InvalidTransitions",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityInvalidTransitionTest::RunTest(const FString&)
{
    FHaybaActivityModel Model;
    TestFalse(TEXT("missing start"), Model.ApplyEvent(*Json(Complete)));
    TestEqual(TEXT("missing start code"), Model.GetLastError(), FString(TEXT("ACTIVITY_NOT_STARTED")));
    TestFalse(TEXT("resume cannot create activity"), Model.ApplyEvent(*Json(Resume)));
    Model.ApplyEvent(*Json(Start));
    TestFalse(TEXT("duplicate start"), Model.ApplyEvent(*Json(Start)));
    TestFalse(TEXT("result without call"), Model.ApplyEvent(*Json(Finished)));
    Model.ApplyEvent(*Json(Running));
    TestFalse(TEXT("duplicate call"), Model.ApplyEvent(*Json(Running)));
    auto WrongName = Json(Finished);
    WrongName->GetObjectField(TEXT("step"))->SetStringField(TEXT("name"), TEXT("wrong"));
    TestFalse(TEXT("wrong result name"), Model.ApplyEvent(*WrongName));
    auto Failure = Json(Finished);
    Failure->GetObjectField(TEXT("step"))->SetStringField(TEXT("status"), TEXT("failed"));
    TestTrue(TEXT("failed step accepted"), Model.ApplyEvent(*Failure));
    TestTrue(TEXT("step failure does not terminate activity"), Model.FindActivity(TEXT("a1"))->State == EHaybaActivityState::Running);
    TestFalse(TEXT("result only once"), Model.ApplyEvent(*Json(Finished)));
    TestFalse(TEXT("call only once"), Model.ApplyEvent(*Json(Running)));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityDecodingTest, "Hayba.MCP.ActivityModel.StrictDecoding",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityDecodingTest::RunTest(const FString&)
{
    for (const TCHAR* Valid : { Start, Running, Finished, Approval, Resume, Complete,
        TEXT(R"({"type":"message_delta","activityId":"a1","text":""})"),
        TEXT(R"({"type":"artifact_proposed","activityId":"a1","artifact":{"kind":"plan","id":"p"}})"),
        TEXT(R"({"type":"verdict_emitted","activityId":"a1","verdict":{"code":"ok","message":"Ready","severity":"info","direction":"proceed"}})"),
        TEXT(R"({"type":"error","activityId":"a1","error":"","termination":{"reason":"aborted","stopReason":"unknown","usage":{"outputTokens":0}}})") })
    {
        auto Object = Json(Valid);
        TSharedPtr<FJsonObject> Decoded;
        const FString Type = Object->GetStringField(TEXT("type"));
        TestTrue(TEXT("schema kind decodes"), FHaybaMCPAgentClient::DecodeActivityEvent(Type, Valid, Decoded));
        TestFalse(TEXT("envelope mismatch"), FHaybaMCPAgentClient::DecodeActivityEvent(TEXT("wrong"), Valid, Decoded));
        Object->SetBoolField(TEXT("unexpected"), true);
        TestFalse(TEXT("extra root field"), FHaybaActivityModel::ValidateEvent(*Object));
    }
    for (const TCHAR* Invalid : {
        TEXT(R"({"type":"activity_started","activityId":"","title":"Title"})"),
        TEXT(R"({"type":"activity_started","activityId":"a1","title":3})"),
        TEXT(R"({"type":"activity_started","activityId":"a1","title":"Title","specialistId":null})"),
        TEXT(R"({"type":"activity_step","activityId":"a1","step":{"status":"running","id":"c","name":"n","input":[]}})"),
        TEXT(R"({"type":"activity_step","activityId":"a1","step":{"status":"succeeded","id":"c","name":"n"}})"),
        TEXT(R"({"type":"activity_step","activityId":"a1","step":{"status":"failed","id":"c","name":"n","result":null,"extra":1}})"),
        TEXT(R"({"type":"approval_requested","activityId":"a1","approvalId":"p","call":{"id":"c","name":"n","input":{},"extra":1},"argsHash":"h","source":"ts"})"),
        TEXT(R"({"type":"artifact_proposed","activityId":"a1","artifact":{"kind":"plan","id":"p","extra":1}})"),
        TEXT(R"({"type":"verdict_emitted","activityId":"a1","verdict":{"code":"ok","message":"Ready","severity":"fatal","direction":"proceed"}})"),
        TEXT(R"({"type":"activity_completed","activityId":"a1","outcome":"unknown","reason":"end_turn"})"),
        TEXT(R"({"type":"activity_completed","activityId":"a1","outcome":"succeeded","reason":"end_turn","usage":{"inputTokens":-1}})"),
        TEXT(R"({"type":"activity_completed","activityId":"a1","outcome":"succeeded","reason":"end_turn","usage":{"inputTokens":1.5}})"),
        TEXT(R"({"type":"activity_completed","activityId":"a1","outcome":"succeeded","reason":"end_turn","usage":{"raw":0}})"),
        TEXT(R"({"type":"error","activityId":"a1","error":"bad","termination":{"reason":"bad"}})") })
    {
        FHaybaActivityModel Model;
        TestFalse(TEXT("invalid structured boundary"), Model.ApplyEvent(*Json(Invalid)));
        TestEqual(TEXT("invalid input leaves model untouched"), Model.GetActivities().Num(), 0);
    }
    TSharedPtr<FJsonObject> Decoded;
    TestFalse(TEXT("invalid JSON"), FHaybaMCPAgentClient::DecodeActivityEvent(TEXT("activity_started"), TEXT("{"), Decoded));
    TestFalse(TEXT("legacy payload isn't semantic"), FHaybaMCPAgentClient::DecodeActivityEvent(TEXT("error"), TEXT(R"({"error":"offline","kind":"transport"})"), Decoded));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityOwnershipTest, "Hayba.MCP.ActivityModel.ModuleOwnership",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityOwnershipTest::RunTest(const FString&)
{
    FHaybaMCPModule& Module = FModuleManager::LoadModuleChecked<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
    int32 Changes = 0;
    const FDelegateHandle Handle = Module.OnActivityChanged.AddLambda([&Changes](const FString&) { ++Changes; });
    FHaybaActivityModel& Model = Module.GetActivityModel();
    auto Event = Json(Start);
    Event->SetStringField(TEXT("activityId"), FGuid::NewGuid().ToString());
    TestTrue(TEXT("module model applies without a widget"), Model.ApplyEvent(*Event));
    TestTrue(TEXT("access returns persistent model"), &Model == &Module.GetActivityModel());
    TestEqual(TEXT("module forwards changes"), Changes, 1);
    Module.OnActivityChanged.Remove(Handle);
    return true;
}
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityClientFramesTest, "Hayba.MCP.ActivityModel.ClientFrames",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityClientFramesTest::RunTest(const FString&)
{
    FHaybaMCPModule& Module = FModuleManager::LoadModuleChecked<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
    auto Client = MakeShared<FHaybaMCPAgentClient>();
    const FString Id = FGuid::NewGuid().ToString();
    auto Frame = [&Id](const TCHAR* Type, const TCHAR* Payload, const TCHAR* Separator = TEXT("\n\n"))
    {
        return FString::Printf(TEXT("event: %s\ndata: %s%s"), Type, *FString(Payload).Replace(TEXT("a1"), *Id), Separator);
    };
    int32 Events = 0;
    int32 Errors = 0;
    int32 Deltas = 0;
    Client->OnActivityEvent.AddLambda([&Events](const FJsonObject&) { ++Events; });
    Client->OnError.AddLambda([&Errors](const FHaybaChatError&) { ++Errors; });
    Client->OnTextDelta.AddLambda([&Deltas](const FString&) { ++Deltas; });
    FString Body = Frame(TEXT("activity_started"), Start, TEXT("\r\n\r\n"));
    Client->ParseNewFrames(Body.LeftChop(1));
    TestEqual(TEXT("partial frame buffered"), Events, 0);
    Client->ParseNewFrames(Body);
    TestEqual(TEXT("CRLF frame decoded"), Events, 1);
    Body += Frame(TEXT("activity_step"), Running);
    Client->ParseNewFrames(Body);
    TestEqual(TEXT("incremental frames only once"), Events, 2);
    Client->ParseNewFrames(Body);
    TestEqual(TEXT("no repeat body dispatch"), Events, 2);
    Client->EmitLocalDone(TEXT("end_turn"), false);
    TestTrue(TEXT("synthetic end cannot mark success"), Module.GetActivityModel().FindActivity(Id)->State == EHaybaActivityState::Unknown);
    Client->bTerminalEmitted = false;
    Client->DispatchFrame(Frame(TEXT("activity_completed"), Complete));
    TestTrue(TEXT("semantic completion reconciles"), Module.GetActivityModel().FindActivity(Id)->State == EHaybaActivityState::Succeeded);
    TestEqual(TEXT("completion notification"), Events, 3);
    Client->DispatchFrame(Frame(TEXT("activity_completed"), Complete));
    TestEqual(TEXT("duplicate terminal not broadcast"), Events, 3);
    Client->DispatchFrame(TEXT("event: error\ndata: {\"type\":\"error\",\"activityId\":\"bad\",\"error\":42}"));
    TestEqual(TEXT("malformed semantic error cannot fall back"), Errors, 0);
    Client->DispatchFrame(TEXT("event: error\ndata: {\"error\":\"offline\",\"kind\":\"transport\"}"));
    Client->DispatchFrame(TEXT("event: text_delta\ndata: {\"text\":\"legacy\"}"));
    TestEqual(TEXT("legacy error delegate retained"), Errors, 1);
    TestEqual(TEXT("legacy text delegate retained"), Deltas, 1);
    return true;
}
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaActivityResumeDisconnectTest, "Hayba.MCP.ActivityModel.ResumeDisconnect",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaActivityResumeDisconnectTest::RunTest(const FString&)
{
    FHaybaActivityModel& Model = FModuleManager::LoadModuleChecked<FHaybaMCPModule>(TEXT("HaybaMCPToolkit")).GetActivityModel();
    for (const bool bResumeGap : { false, true })
    {
        auto Client = MakeShared<FHaybaMCPAgentClient>();
        const FString Id = FGuid::NewGuid().ToString();
        auto Frame = [&Id](const TCHAR* Type, const TCHAR* Payload)
        {
            return FString::Printf(TEXT("event: %s\ndata: %s"), Type, *FString(Payload).Replace(TEXT("a1"), *Id));
        };
        Client->DispatchFrame(Frame(TEXT("activity_started"), Start));
        Client->DispatchFrame(Frame(TEXT("approval_requested"), Approval));
        TestTrue(TEXT("approval identity is initially resolvable"), Model.CanResolveApproval(Id, TEXT("p1")));

        // Same request preparation as StartStream after PostApprove succeeds.
        // Do not send HTTP: inject the outcome through the real request callback.
        Client->bTerminalEmitted = false;
        const auto Request = Client->CreateStreamRequest(FString());
        if (bResumeGap)
        {
            Client->DispatchFrame(TEXT("event: error\ndata: {\"code\":\"resume_gap\"}"));
        }
        else
        {
            Request->OnProcessRequestComplete().Execute(Request, nullptr, false);
        }
        TestTrue(bResumeGap ? TEXT("gap before semantic frame becomes Unknown") : TEXT("transport failure before semantic frame becomes Unknown"),
            Model.FindActivity(Id)->State == EHaybaActivityState::Unknown);
        TestFalse(TEXT("uncertain resume cannot resolve approval again"), Model.CanResolveApproval(Id, TEXT("p1")));
        TestTrue(TEXT("approval identity retained for reconciliation"), Model.FindActivity(Id)->Approval.IsSet());
        TestTrue(TEXT("disconnect never infers success or cancellation"), Model.FindActivity(Id)->Outcome.IsEmpty());
        Request->OnRequestProgress64().Unbind();
        Request->OnProcessRequestComplete().Unbind();
        Client->StreamRequest.Reset();
    }
    return true;
}
#endif
