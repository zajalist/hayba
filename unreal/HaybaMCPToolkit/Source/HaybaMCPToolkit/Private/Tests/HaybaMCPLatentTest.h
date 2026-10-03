// HaybaMCPLatentTest.h - latent automation helpers with a hard cap.
//
// The headless run is one process with no per-test timeout (R-6): a latent
// wait that never ends would stall every later test and truncate the log.
// Every wait here has a cap, and reaching it is an error, so the report shows
// Fail rather than a test that merely finished.

#pragma once

#include "CoreMinimal.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

class FHaybaWaitUntilLatentCommand : public IAutomationLatentCommand
{
public:
	FHaybaWaitUntilLatentCommand(FAutomationTestBase* InTest, FString InWhat, TFunction<bool()> InDone, double InHardCapSeconds = 10.0)
		: Test(InTest)
		, What(MoveTemp(InWhat))
		, Done(MoveTemp(InDone))
		, HardCapSeconds(InHardCapSeconds)
	{
	}

	virtual bool Update() override
	{
		if (Done && Done())
		{
			return true;
		}
		if (GetCurrentRunTime() >= HardCapSeconds)
		{
			if (Test)
			{
				Test->AddError(FString::Printf(TEXT("latent wait '%s' hit its %.1f s hard cap"), *What, HardCapSeconds));
			}
			return true;
		}
		return false;
	}

private:
	FAutomationTestBase* Test = nullptr;
	FString What;
	TFunction<bool()> Done;
	double HardCapSeconds = 10.0;
};

#endif // WITH_DEV_AUTOMATION_TESTS
