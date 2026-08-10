#include "Misc/AutomationTest.h"
#include "HaybaMCPFrameReadPolicy.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPFrameReadPolicyTest,
	"Hayba.MCP.Transport.FrameReadPolicy",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPFrameReadPolicyTest::RunTest(const FString& Parameters)
{
	{
		FHaybaMCPFrameReadPolicy Policy(0.0, 5.0);
		TestFalse(TEXT("idle client remains connected before deadline"), Policy.ShouldDisconnect(4.999, false));
		TestTrue(TEXT("idle client is bounded at deadline"), Policy.ShouldDisconnect(5.0, false));
	}

	{
		FHaybaMCPFrameReadPolicy Policy(0.0, 5.0, 0);
		TestFalse(TEXT(">5s handler does not lose its response connection"), Policy.ShouldDisconnect(6.0, true));
		TestFalse(TEXT("very long handler remains response-safe"), Policy.ShouldDisconnect(60.0, true));
		TestFalse(TEXT("response completion starts a fresh idle window"), Policy.ShouldDisconnect(60.0, false, 1));
		TestFalse(TEXT("fresh post-response idle window remains open"), Policy.ShouldDisconnect(64.999, false, 1));
		TestTrue(TEXT("post-response idle client is eventually bounded"), Policy.ShouldDisconnect(65.0, false, 1));
	}

	{
		FHaybaMCPFrameReadPolicy Policy(0.0, 5.0, 0);
		// The reader never sampled pending=true; generation still proves a
		// response completed while it was descheduled.
		TestFalse(TEXT("missed pending pulse still refreshes idle deadline"), Policy.ShouldDisconnect(10.0, false, 1));
		TestTrue(TEXT("refreshed missed-pulse deadline remains bounded"), Policy.ShouldDisconnect(15.0, false, 1));
	}

	{
		FHaybaMCPFrameReadPolicy Policy(0.0, 5.0);
		Policy.MarkFrameStarted(1.0);
		TestFalse(TEXT("partial frame remains open before its deadline"), Policy.ShouldDisconnect(5.999, true));
		TestTrue(TEXT("partial-frame slowloris expires despite pending response"), Policy.ShouldDisconnect(6.0, true));
	}

	{
		FHaybaMCPFrameReadPolicy Policy(0.0, 5.0);
		Policy.MarkFrameStarted(1.0);
		Policy.MarkFrameStarted(4.0);
		TestTrue(TEXT("later bytes cannot extend the partial-frame deadline"), Policy.ShouldDisconnect(6.0, false));
	}

	{
		FHaybaMCPSendDeadlinePolicy Policy(0.0, 5.0, 30.0);
		TestFalse(TEXT("send may progress before stall deadline"), Policy.ShouldAbort(4.0));
		Policy.MarkProgress(4.0);
		TestFalse(TEXT("progress refreshes only the stall window"), Policy.ShouldAbort(8.9));
		TestTrue(TEXT("stalled send aborts"), Policy.ShouldAbort(9.0));
	}

	{
		FHaybaMCPSendDeadlinePolicy Policy(0.0, 5.0, 30.0);
		for (int32 Second = 4; Second < 30; Second += 4)
		{
			Policy.MarkProgress(static_cast<double>(Second));
		}
		TestTrue(TEXT("tiny progress cannot hold a sender forever"), Policy.ShouldAbort(30.0));
	}

	return true;
}

#endif
