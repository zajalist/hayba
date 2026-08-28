#include "Misc/AutomationTest.h"
#include "handlers/HaybaMCPAutomationIsolationPolicy.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPAutomationIsolationPolicyTest,
    "Hayba.MCP.Tests.AutomationIsolationPolicy",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPAutomationIsolationPolicyTest::RunTest(const FString& Parameters)
{
    using namespace HaybaAutomationIsolation;

    TestEqual(
        TEXT("an explicitly audited pure Hayba contract stays in process"),
        Classify(FString(TEXT("Hayba.MCP.Params.Reader"))),
        EExecutionMode::InProcess);
    TestEqual(
        TEXT("an unknown Hayba test is isolated instead of trusted by namespace"),
        Classify(FString(TEXT("Hayba.MCP.Future.Unreviewed"))),
        EExecutionMode::OwnedChild);
    TestEqual(
        TEXT("an arbitrary project test defaults to an owned child"),
        Classify(FString(TEXT("Aphrosia.GameInstance.InvalidOuter"))),
        EExecutionMode::OwnedChild);
    TestEqual(
        TEXT("an engine test defaults to an owned child despite EditorContext"),
        Classify(FString(TEXT("Engine.Editor.ContextFixture"))),
        EExecutionMode::OwnedChild);

    return true;
}

#endif
