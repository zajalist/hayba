#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPJobRegistry.h"

/**
 * Single-flight ownership for the in-process automation framework.
 *
 * A bare boolean cannot tell a caller which job owns the framework and cannot
 * recover when a live-code/module reload recreates the job registry while a
 * function-local static survives. Keep the pollable job id as the authority
 * and reconcile it against the registry before rejecting another run.
 *
 * This object is game-thread confined. The registry it observes is itself
 * thread-safe because build jobs also use it from worker threads.
 */
class FHaybaMCPTestRunLease
{
public:
    bool TryAcquire(const FString& JobId)
    {
        if (JobId.IsEmpty() || !ActiveJobId.IsEmpty())
        {
            return false;
        }
        ActiveJobId = JobId;
        return true;
    }

    /**
     * Returns true only while ActiveJobId still names a pollable running test
     * job. Callers must use this only after proving no live ticker state exists;
     * registry absence alone never establishes automation-framework idleness.
     */
    bool Reconcile(const FHaybaJobState& Job)
    {
        if (ActiveJobId.IsEmpty())
        {
            return false;
        }

        const bool bOwnsPollableRunningTest =
            Job.bFound
            && Job.JobId == ActiveJobId
            && Job.OpName == TEXT("test_run")
            && Job.Status == EHaybaJobStatus::Running;
        if (!bOwnsPollableRunningTest)
        {
            ActiveJobId.Reset();
        }
        return bOwnsPollableRunningTest;
    }

    void Release(const FString& JobId)
    {
        // A stale callback must never unlock a newer run.
        if (ActiveJobId == JobId)
        {
            ActiveJobId.Reset();
        }
    }

    bool IsActive() const { return !ActiveJobId.IsEmpty(); }
    const FString& GetActiveJobId() const { return ActiveJobId; }

private:
    FString ActiveJobId;
};

/** Releases the lease if any early return or abnormal ticker teardown destroys state. */
class FHaybaMCPTestRunLeaseGuard
{
public:
    FHaybaMCPTestRunLeaseGuard(FHaybaMCPTestRunLease& InLease, FString InJobId)
        : Lease(InLease)
        , JobId(MoveTemp(InJobId))
    {
    }

    ~FHaybaMCPTestRunLeaseGuard()
    {
        Lease.Release(JobId);
    }

    FHaybaMCPTestRunLeaseGuard(const FHaybaMCPTestRunLeaseGuard&) = delete;
    FHaybaMCPTestRunLeaseGuard& operator=(const FHaybaMCPTestRunLeaseGuard&) = delete;

private:
    FHaybaMCPTestRunLease& Lease;
    FString JobId;
};
