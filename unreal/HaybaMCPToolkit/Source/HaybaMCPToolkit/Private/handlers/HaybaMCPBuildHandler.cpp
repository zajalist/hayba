// HaybaMCPBuildHandler.cpp
//
// Implements four commands:
//   * build_project                 — invoke UnrealBuildTool.exe
//   * build_cook                    — invoke the editor in -run=cook mode
//   * build_generate_project_files  — invoke RunUAT GenerateProjectFiles
//   * build_status                  — read an async job's result by job_id
//
// Every build is a NON-BLOCKING async job. ProcessCommand runs on the game
// thread (HaybaMCPTcpServer::DrainPendingCommands drains the queue from the
// engine tick), so blocking here freezes the editor — that was the old
// Future.WaitFor(300s) bug. Instead each command allocates a job id in the
// shared FHaybaMCPJobRegistry, kicks the subprocess on a background thread, and
// returns { job_id, status:"running" } immediately. The background task pumps
// stdout (journalled live via FHaybaMCPSecurityManager::Journal), then writes
// { exit_code, output } into the registry under its lock. Callers poll
// build_status { job_id } (or watch hayba_journal_tail) for the result.
// build_status is also the reader for test_run's async jobs (same registry).

#include "HaybaMCPBuildHandler.h"
#include "HaybaMCPSecurityManager.h"
#include "HaybaMCPJobRegistry.h"

#include "Async/Async.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformFilemanager.h"
#include "HAL/PlatformMisc.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/ScopeLock.h"
#include "Dom/JsonObject.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPBuild, Log, All);

namespace
{
    // Bounded excerpt size for the captured output stored in the job registry.
    constexpr int32 kLogExcerptBytes = 16 * 1024;

    FString ResolveUBTPath()
    {
        return FPaths::ConvertRelativePathToFull(
            FPaths::EngineDir() / TEXT("Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.exe"));
    }

    FString ResolveRunUATPath()
    {
        // RunUAT.bat on Windows, RunUAT.sh elsewhere.
#if PLATFORM_WINDOWS
        return FPaths::ConvertRelativePathToFull(
            FPaths::EngineDir() / TEXT("Build/BatchFiles/RunUAT.bat"));
#else
        return FPaths::ConvertRelativePathToFull(
            FPaths::EngineDir() / TEXT("Build/BatchFiles/RunUAT.sh"));
#endif
    }

    FString ResolveEditorExe()
    {
        // UE 5.7: UnrealEditor.exe (formerly UE4Editor.exe).
        return FPaths::ConvertRelativePathToFull(
            FPaths::EngineDir() / TEXT("Binaries/Win64/UnrealEditor-Cmd.exe"));
    }

    FString DefaultPlatform()
    {
#if PLATFORM_WINDOWS
        return TEXT("Win64");
#elif PLATFORM_LINUX
        return TEXT("Linux");
#elif PLATFORM_MAC
        return TEXT("Mac");
#else
        return TEXT("Win64");
#endif
    }

    FString GetProjectPath()
    {
        return FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
    }

    FString GetProjectTargetBase()
    {
        // Project target name = the .uproject filename without extension.
        return FPaths::GetBaseFilename(FPaths::GetProjectFilePath());
    }

    void JournalProgress(const FString& JobId, const FString& Phase, const FString& Detail, bool bOk = true)
    {
        FHaybaJournalEntry Entry;
        Entry.Timestamp = FDateTime::UtcNow();
        Entry.Command = FString::Printf(TEXT("build_job:%s:%s"), *JobId, *Phase);
        Entry.ParamsHash = TEXT("");
        Entry.DurationMs = 0;
        Entry.bOk = bOk;
        Entry.ErrorMessage = Detail;
        FHaybaMCPSecurityManager::Get().Journal(Entry);
    }

    // Result of running a subprocess to completion.
    struct FProcRunResult
    {
        bool bLaunched = false;
        int32 ExitCode = -1;
        FString CapturedOutput;
        FString ErrorMessage;
        bool bTimedOut = false;
    };

    /**
     * Launch URL with Params, stream stdout into CapturedOutput. Pumps the pipe
     * on the calling thread (must NOT be the game thread for blocking waits).
     * If MaxSeconds > 0 and the process is still running, returns with
     * bTimedOut=true and leaves the process running (caller may keep draining).
     *
     * OnChunk fires for each pipe drain pass with the accumulated new bytes;
     * use it to journal progress for long-running jobs.
     */
    FProcRunResult RunCapture(const FString& URL,
                              const FString& Params,
                              double MaxSeconds,
                              TFunction<void(const FString&)> OnChunk = nullptr)
    {
        FProcRunResult Out;

        void* ReadPipe = nullptr;
        void* WritePipe = nullptr;
        if (!FPlatformProcess::CreatePipe(ReadPipe, WritePipe))
        {
            Out.ErrorMessage = TEXT("CreatePipe failed");
            return Out;
        }

        uint32 PID = 0;
        FProcHandle Proc = FPlatformProcess::CreateProc(
            *URL,
            *Params,
            /*bLaunchDetached=*/ false,
            /*bLaunchHidden=*/  true,
            /*bLaunchReallyHidden=*/ true,
            &PID,
            /*PriorityModifier=*/ 0,
            /*OptionalWorkingDirectory=*/ nullptr,
            /*PipeWriteChild=*/ WritePipe,
            /*PipeReadChild=*/  nullptr);

        if (!Proc.IsValid())
        {
            FPlatformProcess::ClosePipe(ReadPipe, WritePipe);
            Out.ErrorMessage = FString::Printf(TEXT("CreateProc failed: %s %s"), *URL, *Params);
            return Out;
        }

        Out.bLaunched = true;
        const double StartTime = FPlatformTime::Seconds();

        while (FPlatformProcess::IsProcRunning(Proc))
        {
            const FString Chunk = FPlatformProcess::ReadPipe(ReadPipe);
            if (!Chunk.IsEmpty())
            {
                Out.CapturedOutput.Append(Chunk);
                if (OnChunk)
                {
                    OnChunk(Chunk);
                }
            }

            if (MaxSeconds > 0.0 && (FPlatformTime::Seconds() - StartTime) > MaxSeconds)
            {
                Out.bTimedOut = true;
                FPlatformProcess::ClosePipe(ReadPipe, WritePipe);
                // Leave Proc running; caller owns the handle via a separate
                // path. Here we just abandon it (the long-job branch uses its
                // own RunCapture call without a timeout).
                return Out;
            }

            FPlatformProcess::Sleep(0.05f);
        }

        // Drain residual output.
        const FString Tail = FPlatformProcess::ReadPipe(ReadPipe);
        if (!Tail.IsEmpty())
        {
            Out.CapturedOutput.Append(Tail);
            if (OnChunk)
            {
                OnChunk(Tail);
            }
        }

        int32 ExitCode = -1;
        FPlatformProcess::GetProcReturnCode(Proc, &ExitCode);
        Out.ExitCode = ExitCode;

        FPlatformProcess::CloseProc(Proc);
        FPlatformProcess::ClosePipe(ReadPipe, WritePipe);
        return Out;
    }

    /** Trim CapturedOutput from the end to <= kLogExcerptBytes (utf-8 chars approx). */
    FString TailExcerpt(const FString& In)
    {
        if (In.Len() <= kLogExcerptBytes) return In;
        return In.RightChop(In.Len() - kLogExcerptBytes);
    }

    /**
     * Launch a subprocess as an async job. Allocates a job id in the shared
     * registry, kicks the run on a background thread, and returns
     * { job_id, status:"running" } IMMEDIATELY. We NEVER block the game thread
     * (ProcessCommand runs on it — see HaybaMCPTcpServer::DrainPendingCommands),
     * which is what the old Future.WaitFor(300s) did and why the editor froze.
     *
     * RunCapture only pumps a pipe and sleeps on the worker thread; it never
     * touches the game thread or the task graph, so AnyBackgroundThreadNormalTask
     * is safe here. On completion the task publishes { exit_code, output } into
     * the registry under its lock and appends to the operation journal. Poll
     * build_status { job_id } for the result.
     */
    TSharedRef<FJsonObject> RunOrBackground(const FString& OpName,
                                            const FString& URL,
                                            const FString& Params)
    {
        const FString JobId = FHaybaMCPJobRegistry::Get().AllocateJob(OpName);

        UE_LOG(LogHaybaMCPBuild, Log, TEXT("[%s] launching job %s: %s %s"), *OpName, *JobId, *URL, *Params);
        JournalProgress(JobId, TEXT("launch"),
            FString::Printf(TEXT("%s | %s %s"), *OpName, *URL, *Params));

        AsyncTask(ENamedThreads::AnyBackgroundThreadNormalTask, [OpName, URL, Params, JobId]()
        {
            FProcRunResult R = RunCapture(URL, Params, /*MaxSeconds=*/ 0.0,
                [JobId, OpName](const FString& Chunk)
                {
                    // Trim chunk for journal sanity.
                    const FString Short = Chunk.Len() > 1024 ? Chunk.Right(1024) : Chunk;
                    JournalProgress(JobId, TEXT("stdout"), Short);
                    UE_LOG(LogHaybaMCPBuild, Verbose, TEXT("[%s] %s"), *OpName, *Short);
                });

            const int32 ExitCode = R.bLaunched ? R.ExitCode : -1;
            FString Output = TailExcerpt(R.CapturedOutput);
            if (!R.ErrorMessage.IsEmpty())
            {
                Output = R.ErrorMessage + (Output.IsEmpty() ? FString() : (TEXT("\n") + Output));
            }

            // Publish the result under the registry lock so a concurrent
            // build_status read always sees a consistent {status, exit_code, output}.
            FHaybaMCPJobRegistry::Get().SetDone(JobId, ExitCode, Output);

            // Append job completion to the operation journal.
            JournalProgress(JobId, TEXT("exit"),
                FString::Printf(TEXT("%s exit_code=%d"), *OpName, ExitCode), ExitCode == 0);
        });

        TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("command"), OpName);
        Out->SetStringField(TEXT("job_id"), JobId);
        Out->SetStringField(TEXT("status"), TEXT("running"));
        Out->SetBoolField(TEXT("ok"), true);
        Out->SetStringField(TEXT("note"),
            TEXT("Job started asynchronously. Poll build_status { job_id } for {status, exit_code, output}, or watch hayba_journal_tail."));
        return Out;
    }

    /**
     * build_status { job_id } — read an async job's state from the shared
     * registry under its lock. Works for build_* AND test_run jobs (one
     * registry). Returns {status:"running"} while in flight, or
     * {status:"done", ok, exit_code, output} once complete; {status:"unknown"}
     * if the id is not in the registry (e.g. it predates the last editor start).
     */
    TSharedRef<FJsonObject> Cmd_BuildStatus(const TSharedPtr<FJsonObject>& Params)
    {
        FString JobId;
        if (!Params.IsValid() || !Params->TryGetStringField(TEXT("job_id"), JobId) || JobId.IsEmpty())
        {
            TSharedRef<FJsonObject> Err = MakeShared<FJsonObject>();
            Err->SetBoolField(TEXT("ok"), false);
            Err->SetStringField(TEXT("error"), TEXT("build_status requires { job_id: string }"));
            return Err;
        }

        const FHaybaJobState Job = FHaybaMCPJobRegistry::Get().GetJob(JobId);

        TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("job_id"), JobId);
        if (!Job.bFound)
        {
            Out->SetBoolField(TEXT("ok"), false);
            Out->SetStringField(TEXT("status"), TEXT("unknown"));
            Out->SetStringField(TEXT("error"),
                FString::Printf(TEXT("no job with id %s (it may predate the last editor restart)"), *JobId));
            return Out;
        }

        Out->SetStringField(TEXT("command"), Job.OpName);
        if (Job.Status == EHaybaJobStatus::Done)
        {
            Out->SetStringField(TEXT("status"), TEXT("done"));
            Out->SetBoolField(TEXT("ok"), Job.ExitCode == 0);
            Out->SetNumberField(TEXT("exit_code"), Job.ExitCode);
            // For builds this is the log tail; for test_run it is a JSON string
            // of {passed, failed, skipped, elapsed_seconds, total}.
            Out->SetStringField(TEXT("output"), Job.Output);
        }
        else
        {
            Out->SetStringField(TEXT("status"), TEXT("running"));
            Out->SetBoolField(TEXT("ok"), true);
        }
        return Out;
    }

    // -------- per-command builders --------

    TSharedRef<FJsonObject> Cmd_BuildProject(const TSharedPtr<FJsonObject>& Params)
    {
        FString TargetSuffix = TEXT("Editor"); // "Editor" | "Game"
        FString Configuration = TEXT("Development");
        FString Platform = DefaultPlatform();

        if (Params.IsValid())
        {
            Params->TryGetStringField(TEXT("target"), TargetSuffix);
            Params->TryGetStringField(TEXT("configuration"), Configuration);
            Params->TryGetStringField(TEXT("platform"), Platform);
        }

        // Normalize target: "Editor" → <Project>Editor, "Game" → <Project>.
        const FString ProjBase = GetProjectTargetBase();
        FString TargetName;
        if (TargetSuffix.Equals(TEXT("Editor"), ESearchCase::IgnoreCase))
        {
            TargetName = ProjBase + TEXT("Editor");
        }
        else
        {
            TargetName = ProjBase;
        }

        const FString UBT = ResolveUBTPath();
        if (!FPaths::FileExists(UBT))
        {
            TSharedRef<FJsonObject> Err = MakeShared<FJsonObject>();
            Err->SetBoolField(TEXT("ok"), false);
            Err->SetStringField(TEXT("error"),
                FString::Printf(TEXT("UnrealBuildTool not found: %s"), *UBT));
            return Err;
        }

        const FString ProjectPath = GetProjectPath();
        // UBT command line: <TargetName> <Platform> <Configuration> -Project="<path>"
        const FString CmdLine = FString::Printf(
            TEXT("%s %s %s -Project=\"%s\" -WaitMutex -FromMsBuild"),
            *TargetName, *Platform, *Configuration, *ProjectPath);

        return RunOrBackground(TEXT("build_project"), UBT, CmdLine);
    }

    TSharedRef<FJsonObject> Cmd_BuildCook(const TSharedPtr<FJsonObject>& Params)
    {
        FString Platform = TEXT("WindowsNoEditor");
        bool bIterate = true;
        bool bUnversioned = false;

        if (Params.IsValid())
        {
            Params->TryGetStringField(TEXT("platform"), Platform);
            Params->TryGetBoolField(TEXT("iterate"), bIterate);
            Params->TryGetBoolField(TEXT("unversioned"), bUnversioned);
        }

        const FString Editor = ResolveEditorExe();
        if (!FPaths::FileExists(Editor))
        {
            TSharedRef<FJsonObject> Err = MakeShared<FJsonObject>();
            Err->SetBoolField(TEXT("ok"), false);
            Err->SetStringField(TEXT("error"),
                FString::Printf(TEXT("UnrealEditor-Cmd not found: %s"), *Editor));
            return Err;
        }

        const FString ProjectPath = GetProjectPath();
        FString CmdLine = FString::Printf(
            TEXT("\"%s\" -run=cook -targetplatform=%s -unattended -nop4 -nullrhi -stdout"),
            *ProjectPath, *Platform);
        if (bIterate)
        {
            CmdLine += TEXT(" -iterate");
        }
        if (bUnversioned)
        {
            CmdLine += TEXT(" -unversioned");
        }

        // Note: FUnrealEdMisc::CookByTheBookForPlatforms would couple the cook
        // to the in-process editor thread; the brief requires async + output
        // capture, so we always subprocess UnrealEditor-Cmd instead.
        return RunOrBackground(TEXT("build_cook"), Editor, CmdLine);
    }

    TSharedRef<FJsonObject> Cmd_GenerateProjectFiles(const TSharedPtr<FJsonObject>& /*Params*/)
    {
        const FString UAT = ResolveRunUATPath();
        if (!FPaths::FileExists(UAT))
        {
            TSharedRef<FJsonObject> Err = MakeShared<FJsonObject>();
            Err->SetBoolField(TEXT("ok"), false);
            Err->SetStringField(TEXT("error"),
                FString::Printf(TEXT("RunUAT not found: %s"), *UAT));
            return Err;
        }

        const FString ProjectPath = GetProjectPath();
        const FString CmdLine = FString::Printf(
            TEXT("GenerateProjectFiles -project=\"%s\""), *ProjectPath);

#if PLATFORM_WINDOWS
        // Invoke .bat through cmd.exe so console redirection works.
        const FString Shell = TEXT("cmd.exe");
        const FString ShellArgs = FString::Printf(TEXT("/c \"\"%s\" %s\""), *UAT, *CmdLine);
        return RunOrBackground(TEXT("build_generate_project_files"), Shell, ShellArgs);
#else
        return RunOrBackground(TEXT("build_generate_project_files"), UAT, CmdLine);
#endif
    }
}

TArray<FString> FHaybaMCPBuildHandler::GetCommands() const
{
    return {
        TEXT("build_project"),
        TEXT("build_cook"),
        TEXT("build_generate_project_files"),
        TEXT("build_status")
    };
}

FHaybaHandlerResult FHaybaMCPBuildHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("build_project"))
    {
        return FHaybaHandlerResult::Ok(Cmd_BuildProject(Params));
    }
    if (Cmd == TEXT("build_cook"))
    {
        return FHaybaHandlerResult::Ok(Cmd_BuildCook(Params));
    }
    if (Cmd == TEXT("build_generate_project_files"))
    {
        return FHaybaHandlerResult::Ok(Cmd_GenerateProjectFiles(Params));
    }
    if (Cmd == TEXT("build_status"))
    {
        return FHaybaHandlerResult::Ok(Cmd_BuildStatus(Params));
    }

    return FHaybaHandlerResult::Err(FString::Printf(
        TEXT("Unknown build command: %s"), *Cmd));
}
