// HaybaMCPJobRegistry.h
//
// Process-global async-job registry. A "job" is a long-running command
// (build_project / build_cook / build_generate_project_files / test_run) that
// returns a {job_id, status:"running"} envelope IMMEDIATELY instead of blocking
// the game thread, then writes its result here when it finishes — either on a
// background worker thread (the build subprocess) or on a deferred game-thread
// core-ticker pump (the automation test run). Readers (build_status) look the
// job up by id under the same lock.
//
// Why the lock: a job entry is touched by the game thread that allocates it AND
// by the background worker / ticker that completes it, so it is genuinely
// cross-thread. Every access goes through a single FCriticalSection.
//
// Shared on purpose: wait_for_idle and other future deferred commands can reuse
// the same "long-running command" seam rather than each inventing its own
// (see docs/audit/2026-06-22-mcp-async-command-conversions.md — Shared note).
#pragma once

#include "CoreMinimal.h"

enum class EHaybaJobStatus : uint8
{
    Running,
    Done,
};

struct FHaybaJobState
{
    FString          JobId;
    FString          OpName;                              // originating command, e.g. "build_project"
    EHaybaJobStatus  Status     = EHaybaJobStatus::Running;
    FDateTime        StartedAt  = FDateTime::UtcNow();
    FDateTime        FinishedAt;                          // valid when Status == Done
    int32            ExitCode   = -1;                     // valid when Status == Done
    FString          Output;                              // log tail (build) or results JSON (test); valid when Done
    bool             bFound     = false;                  // set on GetJob() copies; false => unknown id
};

class FHaybaMCPJobRegistry
{
public:
    static FHaybaMCPJobRegistry& Get();

    /** Allocate a fresh job id, insert a Running entry, and return the id. Thread-safe. */
    FString AllocateJob(const FString& OpName);

    /** Mark a job Done with its exit code + output. No-op for an unknown id. Thread-safe. */
    void SetDone(const FString& JobId, int32 ExitCode, const FString& Output);

    /** Copy out a job's state by id. Returned.bFound==false when the id is unknown. Thread-safe. */
    FHaybaJobState GetJob(const FString& JobId) const;

private:
    FHaybaMCPJobRegistry() = default;

    mutable FCriticalSection      Lock;
    TMap<FString, FHaybaJobState> Jobs;
};
