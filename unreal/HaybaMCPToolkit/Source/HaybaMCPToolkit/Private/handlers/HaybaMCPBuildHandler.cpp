// HaybaMCPBuildHandler.cpp
//
// Implements three commands:
//   * build_project                 — invoke UnrealBuildTool.exe
//   * build_cook                    — invoke the editor in -run=cook mode
//   * build_generate_project_files  — invoke RunUAT GenerateProjectFiles
//
// Subprocess launches are always async (CreateProc on a background thread)
// with stdout captured via a pipe. Short jobs (<= ShortJobTimeoutSec) block
// until exit and return {ok, exit_code, log_excerpt}. Longer jobs return a
// {job_id, status:"running"} envelope immediately and continue streaming
// progress through FHaybaMCPSecurityManager::Journal so the same UI channels
// other handlers use can observe it.

#include "HaybaMCPBuildHandler.h"
#include "HaybaMCPSecurityManager.h"

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
    // Block in-process for at most this long. Longer jobs return a job_id and
    // continue streaming through the journal. 5 min matches the task brief.
    constexpr double kShortJobTimeoutSec = 300.0;

    // Bounded excerpt size in the synchronous response payload.
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
     * Dispatch a subprocess: tries to complete inline (<= kShortJobTimeoutSec).
     * If the process is still alive at the deadline, switches to background
     * mode: returns {ok, job_id, status:"running"} and continues pumping the
     * pipe on the worker thread, emitting Journal entries for each chunk.
     */
    TSharedRef<FJsonObject> RunOrBackground(const FString& OpName,
                                            const FString& URL,
                                            const FString& Params)
    {
        const FString JobId = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);

        UE_LOG(LogHaybaMCPBuild, Log, TEXT("[%s] launching: %s %s"), *OpName, *URL, *Params);
        JournalProgress(JobId, TEXT("launch"),
            FString::Printf(TEXT("%s | %s %s"), *OpName, *URL, *Params));

        // Run the entire job on a background thread so we never block the
        // game/editor thread, then synchronously wait up to kShortJobTimeoutSec
        // for completion from the calling (handler) thread. The handler is
        // already invoked off the game thread by the TCP server, but we keep
        // the OnChunk journaling separate from the response payload.
        TSharedRef<TPromise<FProcRunResult>> Promise = MakeShared<TPromise<FProcRunResult>>();
        TFuture<FProcRunResult> Future = Promise->GetFuture();

        AsyncTask(ENamedThreads::AnyBackgroundThreadNormalTask, [Promise, OpName, URL, Params, JobId]()
        {
            FProcRunResult R = RunCapture(URL, Params, /*MaxSeconds=*/ 0.0,
                [JobId, OpName](const FString& Chunk)
                {
                    // Trim chunk for journal sanity.
                    const FString Short = Chunk.Len() > 1024 ? Chunk.Right(1024) : Chunk;
                    JournalProgress(JobId, TEXT("stdout"), Short);
                    UE_LOG(LogHaybaMCPBuild, Verbose, TEXT("[%s] %s"), *OpName, *Short);
                });
            JournalProgress(JobId, TEXT("exit"),
                FString::Printf(TEXT("%s exit_code=%d"), *OpName, R.ExitCode), R.ExitCode == 0);
            Promise->SetValue(R);
        });

        const bool bFinished = Future.WaitFor(FTimespan::FromSeconds(kShortJobTimeoutSec));

        TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("command"), OpName);
        Out->SetStringField(TEXT("job_id"), JobId);

        if (!bFinished)
        {
            // Long job — return immediately, the AsyncTask keeps logging via
            // Journal. Subsequent build_job_status calls (future work) can
            // look up the journal entries by job_id.
            Out->SetStringField(TEXT("status"), TEXT("running"));
            Out->SetBoolField(TEXT("ok"), true);
            Out->SetStringField(TEXT("note"),
                TEXT("job exceeded 5min; streaming progress to Saved/hayba-execution.log"));
            return Out;
        }

        const FProcRunResult& R = Future.Get();
        Out->SetStringField(TEXT("status"), TEXT("done"));
        Out->SetBoolField(TEXT("ok"), R.bLaunched && R.ExitCode == 0);
        Out->SetNumberField(TEXT("exit_code"), R.ExitCode);
        Out->SetStringField(TEXT("log_excerpt"), TailExcerpt(R.CapturedOutput));
        if (!R.ErrorMessage.IsEmpty())
        {
            Out->SetStringField(TEXT("error"), R.ErrorMessage);
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
        TEXT("build_generate_project_files")
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

    return FHaybaHandlerResult::Err(FString::Printf(
        TEXT("Unknown build command: %s"), *Cmd));
}
