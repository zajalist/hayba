#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HaybaMCPAgentClient.h"
#include "Interfaces/IHttpRequest.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaAgentHttpDeferralTest,
    "Hayba.Chat.HTTP.StreamStartsAfterCallbackTick",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAgentHttpDeferralTest::RunTest(const FString&)
{
	TestFalse(TEXT("built-in Anthropic endpoint is implicit"),
		HaybaChatEndpoint::IsCustom(TEXT("anthropic"), TEXT("https://api.anthropic.com")));
	TestFalse(TEXT("legacy Anthropic default route is implicit"),
		HaybaChatEndpoint::IsCustom(TEXT("anthropic"), TEXT("https://api.anthropic.com/v1/messages")));
	TestFalse(TEXT("built-in OpenAI endpoint tolerates trailing slash"),
		HaybaChatEndpoint::IsCustom(TEXT("openai"), TEXT("https://api.openai.com/v1/")));
	TestTrue(TEXT("custom endpoint stays explicit for sidecar Pro refusal"),
		HaybaChatEndpoint::IsCustom(TEXT("openai"), TEXT("https://local.example/v1")));
    // StartStream is the config and approval callback handoff. The request must
    // not enter FHttpManager's active array until the following editor tick.
    TSharedPtr<FHaybaMCPAgentClient> Client = MakeShared<FHaybaMCPAgentClient>();
    Client->StartStream(FString());
    TestTrue(TEXT("stream request was prepared"), Client->StreamRequest.IsValid());
    if (Client->StreamRequest.IsValid())
    {
        TestTrue(TEXT("stream HTTP request has not started in this callback tick"),
            Client->StreamRequest->GetStatus() == EHttpRequestStatus::NotStarted);
    }
    // The queued callback holds only a weak client. Destruction must cancel
    // the unstarted request and prevent a later network send.
    Client.Reset();
    return true;
}

#endif
