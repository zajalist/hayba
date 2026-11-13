#include "Misc/AutomationTest.h"
#include "HaybaMCPAgentClient.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPSettings.h"
#include "Interfaces/IHttpRequest.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaAgentSidecarIdentityTest,
    "Hayba.MCP.Agent.SidecarIdentity",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAgentSidecarIdentityTest::RunTest(const FString&)
{
    FJsonObject Health;
    Health.SetStringField(TEXT("service"), TEXT("hayba-mcp"));
    Health.SetStringField(TEXT("chatProtocol"), TEXT("hayba-chat-2026-10-03"));
    Health.SetStringField(TEXT("status"), TEXT("ok"));
    TestTrue(TEXT("matching sidecar is accepted before key handoff"),
        FHaybaMCPAgentClient::HasCompatibleSidecarIdentity(Health));

    Health.SetStringField(TEXT("service"), TEXT("another-service"));
    TestFalse(TEXT("unrelated listener is rejected"),
        FHaybaMCPAgentClient::HasCompatibleSidecarIdentity(Health));
    Health.SetStringField(TEXT("service"), TEXT("hayba-mcp"));

    Health.SetStringField(TEXT("chatProtocol"), TEXT("old-chat"));
    TestFalse(TEXT("stale sidecar protocol is rejected"),
        FHaybaMCPAgentClient::HasCompatibleSidecarIdentity(Health));
    Health.SetStringField(TEXT("chatProtocol"), TEXT("hayba-chat-2026-10-03"));

    Health.SetStringField(TEXT("status"), TEXT("starting"));
    TestFalse(TEXT("unready sidecar is rejected"),
        FHaybaMCPAgentClient::HasCompatibleSidecarIdentity(Health));
    Health.RemoveField(TEXT("status"));
    TestFalse(TEXT("malformed response is rejected"),
        FHaybaMCPAgentClient::HasCompatibleSidecarIdentity(Health));

    for (const bool bAutoStart : {false, true})
    {
        TGuardValue<bool> AutoStart(FHaybaMCPSettings::Get().bAutoStartSidecar, bAutoStart);
        auto Client = MakeShared<FHaybaMCPAgentClient>();
        Client->bTurnPending = true;
        Client->TurnSidecarURL = TEXT("http://127.0.0.1:7821");
        int32 DoneCount = 0;
        Client->OnDone.AddLambda([&](const FHaybaChatDone&) { ++DoneCount; });
        const auto Request = Client->CreateSidecarIdentityRequest(TEXT("hello"));
        TestTrue(TEXT("preflight can be prepared without sending credentials or a request"),
            Request->GetStatus() == EHttpRequestStatus::NotStarted);
        Request->OnProcessRequestComplete().Execute(Request, nullptr, false);
        TestEqual(TEXT("auto-start waits for recovery instead of discarding the turn"),
            Client->IsTurnActive(), bAutoStart);
        TestEqual(TEXT("disabled auto-start reports one terminal result"), DoneCount, bAutoStart ? 0 : 1);
        if (bAutoStart)
        {
            Client->Cancel();
            TestFalse(TEXT("Stop wins during the startup delay"), Client->IsTurnActive());
            TestEqual(TEXT("Stop finalizes once"), DoneCount, 1);
        }
    }

    auto Exhausted = MakeShared<FHaybaMCPAgentClient>();
    Exhausted->bTurnPending = true;
    Exhausted->TurnSidecarURL = TEXT("http://127.0.0.1:7821");
    const auto Request = Exhausted->CreateSidecarIdentityRequest(TEXT("hello"), 8);
    Request->OnProcessRequestComplete().Execute(Request, nullptr, false);
    TestFalse(TEXT("startup retries are bounded"), Exhausted->IsTurnActive());
    return true;
}

#endif
