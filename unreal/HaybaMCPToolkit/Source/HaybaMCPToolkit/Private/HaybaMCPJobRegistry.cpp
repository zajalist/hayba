#include "HaybaMCPJobRegistry.h"

#include "Misc/Guid.h"
#include "Misc/ScopeLock.h"

FHaybaMCPJobRegistry& FHaybaMCPJobRegistry::Get()
{
    static FHaybaMCPJobRegistry Instance;
    return Instance;
}

FString FHaybaMCPJobRegistry::AllocateJob(const FString& OpName)
{
    const FString JobId = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);

    FHaybaJobState State;
    State.JobId     = JobId;
    State.OpName    = OpName;
    State.Status    = EHaybaJobStatus::Running;
    State.StartedAt = FDateTime::UtcNow();

    FScopeLock ScopeLock(&Lock);
    Jobs.Add(JobId, MoveTemp(State));
    return JobId;
}

void FHaybaMCPJobRegistry::SetDone(const FString& JobId, int32 ExitCode, const FString& Output)
{
    FScopeLock ScopeLock(&Lock);
    if (FHaybaJobState* State = Jobs.Find(JobId))
    {
        State->Status     = EHaybaJobStatus::Done;
        State->FinishedAt = FDateTime::UtcNow();
        State->ExitCode   = ExitCode;
        State->Output     = Output;
    }
}

bool FHaybaMCPJobRegistry::RestoreRunningJob(
    const FString& JobId,
    const FString& OpName,
    const FDateTime& StartedAt)
{
    if (JobId.IsEmpty() || OpName.IsEmpty())
    {
        return false;
    }

    FScopeLock ScopeLock(&Lock);
    if (const FHaybaJobState* Existing = Jobs.Find(JobId))
    {
        return Existing->OpName == OpName;
    }

    FHaybaJobState State;
    State.JobId = JobId;
    State.OpName = OpName;
    State.Status = EHaybaJobStatus::Running;
    State.StartedAt = StartedAt;
    Jobs.Add(JobId, MoveTemp(State));
    return true;
}

FHaybaJobState FHaybaMCPJobRegistry::GetJob(const FString& JobId) const
{
    FScopeLock ScopeLock(&Lock);
    if (const FHaybaJobState* Found = Jobs.Find(JobId))
    {
        FHaybaJobState Copy = *Found;
        Copy.bFound = true;
        return Copy;
    }
    return FHaybaJobState{}; // bFound = false => unknown id
}
