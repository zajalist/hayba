#include "Misc/AutomationTest.h"
#include "HaybaMCPAgentClient.h"
#include "HaybaMCPActivityModel.h"
#include "HaybaMCPModule.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Misc/Guid.h"
#include "Modules/ModuleManager.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaAgentStreamTerminalTest,
    "Hayba.MCP.Agent.StreamTerminal",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAgentStreamTerminalTest::RunTest(const FString&)
{
    FHaybaActivityModel& Model =
        FModuleManager::LoadModuleChecked<FHaybaMCPModule>(TEXT("HaybaMCPToolkit")).GetActivityModel();
    auto Semantic = [](const TCHAR* Type, const FString& Id, const TCHAR* Fields)
    {
        return FString::Printf(TEXT("event: %s\ndata: {\"type\":\"%s\",\"activityId\":\"%s\",%s}"),
            Type, Type, *Id, Fields);
    };
    auto Started = [&Semantic](const FString& Id)
    {
        return Semantic(TEXT("activity_started"), Id, TEXT("\"title\":\"Terminal fixture\""));
    };

    // A semantic activity result is not the SSE done frame. A dropped stream
    // must still notify Chat exactly once so its Responding row can finalize.
    for (const bool bSemanticError : {false, true})
    {
        const FString Id = FGuid::NewGuid().ToString(EGuidFormats::Digits);
        auto Client = MakeShared<FHaybaMCPAgentClient>();
        Client->bForceCommunityThisChat = true;
        const auto Request = Client->CreateStreamRequest(FString());
        int32 DoneCount = 0;
        int32 ErrorCount = 0;
        FString DoneReason;
        Client->OnDone.AddLambda([&](const FHaybaChatDone& Done)
        {
            ++DoneCount;
            DoneReason = Done.Reason;
        });
        Client->OnError.AddLambda([&](const FHaybaChatError&) { ++ErrorCount; });
        Client->DispatchFrame(Started(Id));
        if (bSemanticError)
            Client->DispatchFrame(Semantic(TEXT("approval_requested"), Id,
                TEXT("\"approvalId\":\"p1\",\"call\":{\"id\":\"c1\",\"name\":\"actor_spawn\",\"input\":{}},\"argsHash\":\"hash\",\"source\":\"ts\"")));
        Client->DispatchFrame(bSemanticError
            ? Semantic(TEXT("error"), Id, TEXT("\"error\":\"Provider failed\",\"kind\":\"provider\""))
            : Semantic(TEXT("activity_completed"), Id,
                TEXT("\"outcome\":\"succeeded\",\"reason\":\"end_turn\"")));
        const FHaybaActivity* Activity = Model.FindActivity(Id);
        if (!TestNotNull(TEXT("semantic result reached the activity model"), Activity)) return false;
        TestEqual(TEXT("semantic outcome is retained"), Activity->State,
            bSemanticError ? EHaybaActivityState::Failed : EHaybaActivityState::Succeeded);
        TestEqual(TEXT("semantic result has not emitted Chat done"), DoneCount, 0);
        TestFalse(TEXT("semantic result does not close the Chat terminal gate"), Client->bTerminalEmitted);
        TestTrue(TEXT("semantic result is not an approval pause"), !Client->bApprovalPauseSeen);
        Request->OnProcessRequestComplete().Execute(Request, nullptr, false);
        TestEqual(TEXT("transport EOF emits one Chat done"), DoneCount, 1);
        TestEqual(TEXT("transport EOF reports failure"), DoneReason, FString(TEXT("error")));
        TestEqual(TEXT("transport error reported once"), ErrorCount, 1);
        TestFalse(TEXT("transport EOF clears streaming"), Client->IsStreaming());
        Request->OnProcessRequestComplete().Execute(Request, nullptr, false);
        TestEqual(TEXT("repeat completion cannot emit another done"), DoneCount, 1);
        TestEqual(TEXT("repeat completion cannot emit another error"), ErrorCount, 1);
    }

    // A real done after semantic completion takes precedence over EOF fallback,
    // and a duplicate done frame cannot finalize the row twice.
    {
        const FString Id = FGuid::NewGuid().ToString(EGuidFormats::Digits);
        auto Client = MakeShared<FHaybaMCPAgentClient>();
        Client->bForceCommunityThisChat = true;
        const auto Request = Client->CreateStreamRequest(FString());
        int32 DoneCount = 0;
        int32 ErrorCount = 0;
        FString AssistantText;
        Client->OnDone.AddLambda([&](const FHaybaChatDone& Done)
        {
            ++DoneCount;
            AssistantText = Done.AssistantText;
        });
        Client->OnError.AddLambda([&](const FHaybaChatError&) { ++ErrorCount; });
        Client->DispatchFrame(Started(Id));
        Client->DispatchFrame(Semantic(TEXT("activity_completed"), Id,
            TEXT("\"outcome\":\"succeeded\",\"reason\":\"end_turn\"")));
        const FString DoneFrame = TEXT("event: done\ndata: {\"reason\":\"end_turn\",\"assistant_text\":\"Ready\"}");
        Client->DispatchFrame(DoneFrame);
        Client->DispatchFrame(DoneFrame);
        Request->OnProcessRequestComplete().Execute(Request, nullptr, false);
        TestEqual(TEXT("server done is delivered exactly once"), DoneCount, 1);
        TestEqual(TEXT("server answer survives completion"), AssistantText, FString(TEXT("Ready")));
        TestEqual(TEXT("EOF after server done is not a transport error"), ErrorCount, 0);
    }

    // The approval event parks a turn when its done is missing, while an actual
    // plan_request done still reaches Chat once. Approval itself stays gated.
    for (const bool bServerDone : {false, true})
    {
        const FString Id = FGuid::NewGuid().ToString(EGuidFormats::Digits);
        auto Client = MakeShared<FHaybaMCPAgentClient>();
        Client->bForceCommunityThisChat = true;
        const auto Request = Client->CreateStreamRequest(FString());
        int32 DoneCount = 0;
        FString Reason;
        Client->OnDone.AddLambda([&](const FHaybaChatDone& Done)
        {
            ++DoneCount;
            Reason = Done.Reason;
        });
        Client->DispatchFrame(Started(Id));
        Client->DispatchFrame(Semantic(TEXT("approval_requested"), Id,
            TEXT("\"approvalId\":\"p1\",\"call\":{\"id\":\"c1\",\"name\":\"actor_spawn\",\"input\":{}},\"argsHash\":\"hash\",\"source\":\"ts\"")));
        TestTrue(TEXT("approval remains resolvable"), Model.CanResolveApproval(Id, TEXT("p1")));
        TestTrue(TEXT("approval pause is tracked separately from Chat done"), Client->bApprovalPauseSeen);
        TestFalse(TEXT("approval event alone does not emit Chat done"), Client->bTerminalEmitted);
        if (!bServerDone)
        {
            const FString OtherId = FGuid::NewGuid().ToString(EGuidFormats::Digits);
            Client->DispatchFrame(Started(OtherId));
            Client->DispatchFrame(Semantic(TEXT("activity_completed"), OtherId,
                TEXT("\"outcome\":\"succeeded\",\"reason\":\"end_turn\"")));
            TestTrue(TEXT("another activity cannot clear this approval"), Client->bApprovalPauseSeen);
        }
        if (bServerDone)
            Client->DispatchFrame(TEXT("event: done\ndata: {\"reason\":\"plan_request\",\"assistant_text\":\"\"}"));
        Request->OnProcessRequestComplete().Execute(Request, nullptr, false);
        TestEqual(TEXT("approval receives only its server terminal frame"), DoneCount, bServerDone ? 1 : 0);
        if (bServerDone)
            TestEqual(TEXT("approval terminal reason is preserved"), Reason, FString(TEXT("plan_request")));
        Model.MarkDisconnected(Id);
    }
    return true;
}

#endif
