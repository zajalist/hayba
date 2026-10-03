#include "Misc/AutomationTest.h"
#include "HaybaPIECapturePolicy.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaPIECapturePolicyTest,
    "Hayba.MCP.PIE.CaptureBoundsAndLifecycle",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaPIECapturePolicyTest::RunTest(const FString&)
{
    using namespace HaybaPIECapturePolicy;
    TestTrue(TEXT("minimum capture"), ValidRequest(1, 0));
    TestTrue(TEXT("maximum capture"), ValidRequest(600, 120));
    TestFalse(TEXT("zero samples rejected"), ValidRequest(0, 0));
    TestFalse(TEXT("over 600 samples rejected"), ValidRequest(601, 0));
    TestFalse(TEXT("over 120 warmup rejected"), ValidRequest(1, 121));

    TestFalse(TEXT("warmup is not a result"), ReachedTickLimit(120, 600, 120));
    TestFalse(TEXT("one sample short"), ReachedTickLimit(719, 600, 120));
    TestTrue(TEXT("exact final tick completes"), ReachedTickLimit(720, 600, 120));
    TestTrue(TEXT("missing measurements are truncated at completion"), SamplesTruncated(true, 4, 5));
    TestFalse(TEXT("in-progress partial data is not truncation"), SamplesTruncated(false, 4, 5));
    TestFalse(TEXT("complete samples are not truncated"), SamplesTruncated(true, 5, 5));

    TestFalse(TEXT("healthy same PIE world continues"), MustAbort(false, true, true, true, true));
    TestTrue(TEXT("PIE stop aborts"), MustAbort(false, false, true, true, true));
    TestTrue(TEXT("end serial change aborts"), MustAbort(false, true, false, true, true));
    TestTrue(TEXT("destroyed world aborts"), MustAbort(false, true, true, false, false));
    TestTrue(TEXT("switched world aborts"), MustAbort(false, true, true, true, false));
    TestTrue(TEXT("unsafe editor aborts"), MustAbort(true, true, true, true, true));
    return true;
}

#endif
