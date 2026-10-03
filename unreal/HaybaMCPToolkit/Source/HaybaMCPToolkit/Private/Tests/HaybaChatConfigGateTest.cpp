#include "Misc/AutomationTest.h"

#if WITH_EDITOR

#include "HaybaMCPChatConfigGate.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaChatConfigGateTest,
    "Hayba.Chat.ConfigGate.StopBeforeStream",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatConfigGateTest::RunTest(const FString& Parameters)
{
    FHaybaMCPChatConfigGate Gate;
    const uint64 First = Gate.Begin();
    TestTrue(TEXT("config is pending"), Gate.IsPending());
    TestTrue(TEXT("Stop cancels config"), Gate.Cancel());
    TestFalse(TEXT("late config response cannot start stream"), Gate.Complete(First));
    TestFalse(TEXT("config is no longer pending"), Gate.IsPending());

    const uint64 Second = Gate.Begin();
    TestFalse(TEXT("a previous response cannot complete the next turn"), Gate.Complete(First));
    TestTrue(TEXT("the next config can complete"), Gate.Complete(Second));
    TestFalse(TEXT("completed config is not pending"), Gate.IsPending());
    return true;
}

#endif
