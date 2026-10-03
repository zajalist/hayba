#include "Misc/AutomationTest.h"
#include "HaybaMCPAgentClient.h"
#include "Dom/JsonObject.h"

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
    return true;
}

#endif
