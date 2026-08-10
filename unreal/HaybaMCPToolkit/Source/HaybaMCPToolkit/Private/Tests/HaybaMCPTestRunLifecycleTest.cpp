#include "Misc/AutomationTest.h"
#include "handlers/HaybaMCPTestRunLifecycle.h"
#include "Misc/Guid.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPTestRunLifecycleTest,
    "Hayba.MCP.Tests.RunLifecycle",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPTestRunLifecycleTest::RunTest(const FString& Parameters)
{
    FHaybaMCPTestRunLease Lease;
    TestFalse(TEXT("new lease is idle"), Lease.IsActive());
    TestFalse(TEXT("empty job id cannot acquire"), Lease.TryAcquire(FString()));
    TestTrue(TEXT("valid job acquires"), Lease.TryAcquire(TEXT("job-a")));
    TestFalse(TEXT("overlap cannot acquire"), Lease.TryAcquire(TEXT("job-b")));

    FHaybaJobState Running;
    Running.bFound = true;
    Running.JobId = TEXT("job-a");
    Running.OpName = TEXT("test_run");
    Running.Status = EHaybaJobStatus::Running;
    TestTrue(TEXT("matching running job remains active"), Lease.Reconcile(Running));

    Lease.Release(TEXT("stale-job"));
    TestTrue(TEXT("stale completion cannot release current owner"), Lease.IsActive());
    Lease.Release(TEXT("job-a"));
    TestFalse(TEXT("owner completion releases lease"), Lease.IsActive());

    TestTrue(TEXT("lease can be reacquired after completion"), Lease.TryAcquire(TEXT("job-done")));
    FHaybaJobState Done = Running;
    Done.JobId = TEXT("job-done");
    Done.Status = EHaybaJobStatus::Done;
    TestFalse(TEXT("completed registry job self-heals stale lease"), Lease.Reconcile(Done));
    TestFalse(TEXT("completed job leaves lease idle"), Lease.IsActive());

    TestTrue(TEXT("lease can be acquired before reload simulation"), Lease.TryAcquire(TEXT("job-old")));
    TestFalse(TEXT("missing post-reload registry job self-heals"), Lease.Reconcile(FHaybaJobState{}));
    TestFalse(TEXT("missing job leaves lease idle"), Lease.IsActive());

    TestTrue(TEXT("lease acquires for early-return guard"), Lease.TryAcquire(TEXT("job-guard")));
    {
        FHaybaMCPTestRunLeaseGuard Guard(Lease, TEXT("job-guard"));
        TestTrue(TEXT("guard holds ownership inside scope"), Lease.IsActive());
        // Scope destruction is the UE-safe equivalent of exception/early-return
        // unwinding; UE modules are built with C++ exceptions disabled.
    }
    TestFalse(TEXT("guard destruction releases abnormal path"), Lease.IsActive());

    TestTrue(TEXT("lease acquires wrong-op scenario"), Lease.TryAcquire(TEXT("job-build")));
    FHaybaJobState WrongOp = Running;
    WrongOp.JobId = TEXT("job-build");
    WrongOp.OpName = TEXT("build_project");
    TestFalse(TEXT("non-test registry owner cannot block test runs"), Lease.Reconcile(WrongOp));

    const FString RestoredId = TEXT("test-restore-")
        + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    TestTrue(TEXT("lost live job can be restored pollably"),
        FHaybaMCPJobRegistry::Get().RestoreRunningJob(
            RestoredId, TEXT("test_run"), FDateTime::UtcNow()));
    const FHaybaJobState Restored = FHaybaMCPJobRegistry::Get().GetJob(RestoredId);
    TestTrue(TEXT("restored job exists"), Restored.bFound);
    TestEqual(TEXT("restored job operation"), Restored.OpName, FString(TEXT("test_run")));
    TestTrue(TEXT("restored job is running"), Restored.Status == EHaybaJobStatus::Running);
    FHaybaMCPJobRegistry::Get().SetDone(RestoredId, 1, TEXT("{}"));
    TestTrue(TEXT("restored job completes"),
        FHaybaMCPJobRegistry::Get().GetJob(RestoredId).Status == EHaybaJobStatus::Done);

    return true;
}

#endif
