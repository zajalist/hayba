#include "HaybaMCPTestHandler.h"
#include "HaybaMCPAutomationIsolationPolicy.h"
#include "HaybaMCPTestSelectionOps.h"
#include "HaybaMCPTestRunLifecycle.h"
#include "CoreGlobals.h"

#if WITH_EDITOR
#include "HaybaMCPJobRegistry.h"
#include "HaybaMCPSecurityManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/App.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformFileManager.h"
#include "HAL/PlatformTime.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonWriter.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#endif

namespace
{
#if WITH_EDITOR
    // Last results captured from the most recent test_run, for test_get_log.
    static TArray<FAutomationTestInfo>          GLastTestInfos;
    static TArray<FAutomationTestExecutionInfo> GLastTestExecInfos;
    static TArray<FString>                      GLastTestNames;

    static TSharedPtr<FJsonValue> MakeStr(const FString& S)
    {
        return MakeShared<FJsonValueString>(S);
    }

    static TSharedPtr<FJsonObject> TestInfoToJson(const FAutomationTestInfo& Info)
    {
        auto Obj = MakeShared<FJsonObject>();
        Obj->SetStringField(TEXT("name"),        Info.GetDisplayName());
        Obj->SetStringField(TEXT("category"),    Info.GetTestName().Contains(TEXT(".")) ? Info.GetTestName() : Info.GetTestName());
        Obj->SetStringField(TEXT("full_test_path"), Info.GetFullTestPath());
        Obj->SetStringField(TEXT("file_name"),   Info.GetSourceFile());
        Obj->SetNumberField(TEXT("line_number"), Info.GetSourceFileLine());
        return Obj;
    }

    static void CollectAllTests(TArray<FAutomationTestInfo>& OutTests)
    {
        OutTests.Reset();
        FAutomationTestFramework& Framework = FAutomationTestFramework::Get();
        // Ensure discovery has run for all relevant flags.
        Framework.SetRequestedTestFilter(EAutomationTestFlags::EditorContext
            | EAutomationTestFlags::ClientContext
            | EAutomationTestFlags::ServerContext
            | EAutomationTestFlags::CommandletContext
            | EAutomationTestFlags::SmokeFilter
            | EAutomationTestFlags::EngineFilter
            | EAutomationTestFlags::ProductFilter
            | EAutomationTestFlags::PerfFilter
            | EAutomationTestFlags::StressFilter
            | EAutomationTestFlags::NegativeFilter);
        Framework.GetValidTestNames(OutTests);
    }

    /**
     * Map whatever the caller supplied to the name StartTestByName accepts.
     *
     * GetValidTestNames reports two different strings per test and they are not
     * interchangeable: GetFullTestPath()/GetDisplayName() is the dotted pretty
     * name ("Hayba.MCP.Params.Reader") and GetTestName() is the registered name
     * ("FHaybaMCPParamReaderTest"). Only the latter starts a test. Accept
     * either, so callers can paste any field test_list showed them.
     */
    static FString ResolveRegisteredTestName(
        const FString& Requested,
        const TArray<FAutomationTestInfo>& Discovered)
    {
        for (const FAutomationTestInfo& Info : Discovered)
        {
            if (Info.GetTestName() == Requested) return Requested;  // already registered form
        }
        for (const FAutomationTestInfo& Info : Discovered)
        {
            if (Info.GetFullTestPath() == Requested || Info.GetDisplayName() == Requested)
            {
                return Info.GetTestName();
            }
        }
        return Requested;  // unknown — let StartTestByName report it
    }

    static FString ResolveCanonicalTestPath(
        const FString& Requested,
        const TArray<FAutomationTestInfo>& Discovered)
    {
        for (const FAutomationTestInfo& Info : Discovered)
        {
            if (Info.GetTestName() == Requested
                || Info.GetFullTestPath() == Requested
                || Info.GetDisplayName() == Requested)
            {
                return Info.GetFullTestPath();
            }
        }
        return FString();
    }

    static void ReadTestSelectors(
        const TSharedPtr<FJsonObject>& Params,
        FString& OutFilterPattern,
        FString& OutCategoryFilter)
    {
        OutFilterPattern.Reset();
        OutCategoryFilter.Reset();
        if (!Params.IsValid()) return;

        Params->TryGetStringField(TEXT("filter_pattern"), OutFilterPattern);
        if (OutFilterPattern.IsEmpty())
        {
            Params->TryGetStringField(TEXT("filter"), OutFilterPattern);
        }
        Params->TryGetStringField(TEXT("category"), OutCategoryFilter);
    }

    static bool MatchesTestSelectors(
        const FAutomationTestInfo& Info,
        const FString& FilterPattern,
        const FString& CategoryFilter)
    {
        return HaybaTestSelection::Matches(
            Info.GetDisplayName(), Info.GetFullTestPath(), FilterPattern, CategoryFilter);
    }


    static FHaybaHandlerResult Cmd_TestList(const TSharedPtr<FJsonObject>& Params)
    {
        FString FilterPattern;
        FString CategoryFilter;
        // `filter` is what callers actually type. Both list and run use this
        // exact selector reader so a successful discovery query can be passed
        // unchanged to test_run without accidentally selecting every test.
        ReadTestSelectors(Params, FilterPattern, CategoryFilter);

        TArray<FAutomationTestInfo> AllTests;
        CollectAllTests(AllTests);

        TArray<TSharedPtr<FJsonValue>> JsonTests;
        for (const FAutomationTestInfo& Info : AllTests)
        {
            if (!MatchesTestSelectors(Info, FilterPattern, CategoryFilter)) continue;

            JsonTests.Add(MakeShared<FJsonValueObject>(TestInfoToJson(Info)));
        }

        auto Out = MakeShared<FJsonObject>();
        Out->SetArrayField(TEXT("tests"), JsonTests);
        Out->SetNumberField(TEXT("count"), JsonTests.Num());
        Out->SetNumberField(TEXT("total_discovered"), AllTests.Num());
        // Echo what was actually applied, so "the filter didn't filter" and
        // "the filter never arrived" are distinguishable from the response.
        if (!FilterPattern.IsEmpty()) Out->SetStringField(TEXT("filter"),   FilterPattern);
        if (!CategoryFilter.IsEmpty()) Out->SetStringField(TEXT("category"), CategoryFilter);
        return FHaybaHandlerResult::Ok(Out);
    }

    // ── Async test-run job (non-freezing) ────────────────────────────────────
    //
    // test_run used to busy-sleep the game thread up to 120s/test, which froze
    // the editor (ProcessCommand runs on the game thread). The automation
    // framework MUST be driven on the game thread, and ExecuteLatentCommands may
    // pump the task graph / async loads — so we cannot push it onto a background
    // thread. Instead we drive the run from the core ticker (FTSTicker), exactly
    // like HaybaMCPTcpServer drains commands: ticker callbacks fire on the game
    // thread OUTSIDE task-graph task execution, so latent commands are safe.
    // test_run returns { job_id, status:"running" } immediately and the pump
    // advances one step per frame; build_status { job_id } reports the result.

    // Only one automation run at a time — concurrent FAutomationTestFramework
    // drives corrupt each other's state. The lease records the pollable owner;
    // unlike the former boolean, it can detect and clear orphaned ownership.
    static FHaybaMCPTestRunLease& GetTestRunLease()
    {
        // Intentionally process-lifetime: ticker-owned guards may be destroyed
        // during engine shutdown after ordinary static destruction has begun.
        static FHaybaMCPTestRunLease* Lease = new FHaybaMCPTestRunLease();
        return *Lease;
    }

    static FString MakeLifecycleFailureResultsJson(
        const TArray<FString>& Names,
        const FString& Error)
    {
        const int32 FailureCount = FMath::Max(Names.Num(), 1);
        TArray<TSharedPtr<FJsonValue>> Failures;
        if (Names.IsEmpty())
        {
            auto Failure = MakeShared<FJsonObject>();
            Failure->SetStringField(TEXT("name"), TEXT("test_run lifecycle"));
            Failure->SetStringField(TEXT("error"), Error);
            Failures.Add(MakeShared<FJsonValueObject>(Failure));
        }
        else
        {
            for (const FString& Name : Names)
            {
                auto Failure = MakeShared<FJsonObject>();
                Failure->SetStringField(TEXT("name"), Name);
                Failure->SetStringField(TEXT("error"), Error);
                Failures.Add(MakeShared<FJsonValueObject>(Failure));
            }
        }

        TSharedRef<FJsonObject> Results = MakeShared<FJsonObject>();
        const TArray<TSharedPtr<FJsonValue>> Empty;
        Results->SetArrayField(TEXT("passed"), Empty);
        Results->SetArrayField(TEXT("failed"), Failures);
        Results->SetArrayField(TEXT("skipped"), Empty);
        Results->SetNumberField(TEXT("passed_count"), 0);
        Results->SetNumberField(TEXT("failed_count"), FailureCount);
        Results->SetNumberField(TEXT("skipped_count"), 0);
        Results->SetBoolField(TEXT("all_passed"), false);
        Results->SetNumberField(TEXT("elapsed_seconds"), 0);
        Results->SetNumberField(TEXT("total"), FailureCount);

        FString ResultsJson;
        const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&ResultsJson);
        FJsonSerializer::Serialize(Results, Writer);
        return ResultsJson;
    }

    constexpr int32 GAutomationChildOutputLimitChars = 16 * 1024;
    constexpr double GAutomationChildDefaultTimeoutSeconds = 300.0;
    constexpr double GAutomationChildMaximumTimeoutSeconds = 900.0;

    struct FOwnedAutomationChildState
    {
        FString JobId;
        FString OwnershipToken;
        FString ReportDirectory;
        TArray<FString> Names;
        double TimeoutSeconds = GAutomationChildDefaultTimeoutSeconds;
        double StartedAtSeconds = 0.0;
        FDateTime StartedAtUtc;
        FProcHandle Process;
        uint32 ProcessId = 0;
        void* ReadPipe = nullptr;
        void* WritePipe = nullptr;
        FString OutputTail;
        int64 OutputChars = 0;
        bool bOutputTruncated = false;
        bool bCancelRequested = false;
        bool bTimedOut = false;
        bool bFinalized = false;
        FTSTicker::FDelegateHandle TickHandle;
        TUniquePtr<FHaybaMCPTestRunLeaseGuard> LeaseGuard;

        ~FOwnedAutomationChildState()
        {
            if (!bFinalized && Process.IsValid()
                && FPlatformProcess::IsProcRunning(Process))
            {
                // The state owns this exact handle. Abnormal ticker teardown
                // must not strand an untracked UnrealEditor-Cmd process.
                FPlatformProcess::TerminateProc(Process, true);
            }
            if (Process.IsValid())
            {
                FPlatformProcess::CloseProc(Process);
            }
            if (ReadPipe || WritePipe)
            {
                FPlatformProcess::ClosePipe(ReadPipe, WritePipe);
            }
        }
    };

    static TWeakPtr<FOwnedAutomationChildState>& GetActiveOwnedChildState()
    {
        static TWeakPtr<FOwnedAutomationChildState>* State =
            new TWeakPtr<FOwnedAutomationChildState>();
        return *State;
    }

    static FString MakeOwnedChildNeverStartedResultsJson(
        const TSharedRef<FOwnedAutomationChildState>& State,
        const FString& Reason)
    {
        TArray<TSharedPtr<FJsonValue>> Failed;
        for (const FString& Name : State->Names)
        {
            auto Failure = MakeShared<FJsonObject>();
            Failure->SetStringField(TEXT("name"), Name);
            Failure->SetStringField(TEXT("outcome"), TEXT("never_started"));
            Failure->SetStringField(TEXT("reason"), Reason);
            Failed.Add(MakeShared<FJsonValueObject>(Failure));
        }

        TSharedRef<FJsonObject> Results = MakeShared<FJsonObject>();
        const TArray<TSharedPtr<FJsonValue>> Empty;
        Results->SetArrayField(TEXT("passed"), Empty);
        Results->SetArrayField(TEXT("failed"), Failed);
        Results->SetArrayField(TEXT("skipped"), Empty);
        Results->SetNumberField(TEXT("passed_count"), 0);
        Results->SetNumberField(TEXT("failed_count"), FMath::Max(Failed.Num(), 1));
        Results->SetNumberField(TEXT("skipped_count"), 0);
        Results->SetNumberField(TEXT("total"), State->Names.Num());
        Results->SetBoolField(TEXT("all_passed"), false);
        Results->SetNumberField(TEXT("elapsed_seconds"), 0);
        Results->SetStringField(TEXT("execution_mode"), TEXT("owned_child"));
        Results->SetStringField(TEXT("ownership_token"), State->OwnershipToken);
        Results->SetNumberField(TEXT("child_pid"), 0);
        Results->SetBoolField(TEXT("child_started"), false);
        Results->SetBoolField(TEXT("never_started"), true);
        Results->SetNumberField(TEXT("process_exit_code"), -1);
        Results->SetBoolField(TEXT("report_valid"), false);
        Results->SetBoolField(TEXT("timed_out"), false);
        Results->SetBoolField(TEXT("cancelled"), false);
        Results->SetBoolField(TEXT("crashed"), false);
        Results->SetNumberField(TEXT("crash_artifact_count"), 0);
        Results->SetNumberField(TEXT("captured_output_chars"), 0);
        Results->SetBoolField(TEXT("output_truncated"), false);

        FString Json;
        const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json);
        FJsonSerializer::Serialize(Results, Writer);
        return Json;
    }

    static void CaptureBoundedChildOutput(
        const TSharedRef<FOwnedAutomationChildState>& State)
    {
        const FString Chunk = FPlatformProcess::ReadPipe(State->ReadPipe);
        if (Chunk.IsEmpty()) return;

        State->OutputChars += Chunk.Len();
        State->OutputTail.Append(Chunk);
        if (State->OutputTail.Len() > GAutomationChildOutputLimitChars)
        {
            State->OutputTail.RightChopInline(
                State->OutputTail.Len() - GAutomationChildOutputLimitChars,
                EAllowShrinking::No);
            State->bOutputTruncated = true;
        }
    }

    static bool TryGetNumberEither(
        const TSharedPtr<FJsonObject>& Object,
        const TCHAR* LowerName,
        const TCHAR* UpperName,
        double& OutValue)
    {
        return Object.IsValid()
            && (Object->TryGetNumberField(LowerName, OutValue)
                || Object->TryGetNumberField(UpperName, OutValue));
    }

    static bool TryGetArrayEither(
        const TSharedPtr<FJsonObject>& Object,
        const TCHAR* LowerName,
        const TCHAR* UpperName,
        const TArray<TSharedPtr<FJsonValue>>*& OutValue)
    {
        return Object.IsValid()
            && (Object->TryGetArrayField(LowerName, OutValue)
                || Object->TryGetArrayField(UpperName, OutValue));
    }

    static FString ReadStringEither(
        const TSharedPtr<FJsonObject>& Object,
        const TCHAR* LowerName,
        const TCHAR* UpperName)
    {
        FString Value;
        if (Object.IsValid())
        {
            if (!Object->TryGetStringField(LowerName, Value))
            {
                Object->TryGetStringField(UpperName, Value);
            }
        }
        return Value;
    }

    static bool ReadOwnedChildReport(
        const TSharedRef<FOwnedAutomationChildState>& State,
        TArray<TSharedPtr<FJsonValue>>& OutPassed,
        TArray<TSharedPtr<FJsonValue>>& OutFailed,
        TArray<TSharedPtr<FJsonValue>>& OutSkipped,
        double& OutDuration,
        bool& bOutSelectionMatched)
    {
        const FString ReportFile = State->ReportDirectory / TEXT("index.json");
        if (!FPaths::FileExists(ReportFile)) return false;

        const FDateTime Timestamp = IFileManager::Get().GetTimeStamp(*ReportFile);
        if (Timestamp < State->StartedAtUtc - FTimespan::FromSeconds(1.0)) return false;

        FString Json;
        if (!FFileHelper::LoadFileToString(Json, *ReportFile)) return false;

        TSharedPtr<FJsonObject> Root;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
        if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid()) return false;

        double Succeeded = 0.0;
        double SucceededWithWarnings = 0.0;
        double Failed = 0.0;
        double NotRun = 0.0;
        double InProcess = 0.0;
        if (!TryGetNumberEither(Root, TEXT("succeeded"), TEXT("Succeeded"), Succeeded)
            || !TryGetNumberEither(Root, TEXT("failed"), TEXT("Failed"), Failed)
            || !TryGetNumberEither(Root, TEXT("notRun"), TEXT("NotRun"), NotRun))
        {
            return false;
        }
        TryGetNumberEither(
            Root, TEXT("succeededWithWarnings"), TEXT("SucceededWithWarnings"),
            SucceededWithWarnings);
        TryGetNumberEither(Root, TEXT("inProcess"), TEXT("InProcess"), InProcess);
        TryGetNumberEither(Root, TEXT("totalDuration"), TEXT("TotalDuration"), OutDuration);

        const TArray<TSharedPtr<FJsonValue>>* Tests = nullptr;
        if (!TryGetArrayEither(Root, TEXT("tests"), TEXT("Tests"), Tests) || !Tests)
        {
            return false;
        }

        for (const TSharedPtr<FJsonValue>& Value : *Tests)
        {
            const TSharedPtr<FJsonObject> Test = Value.IsValid() ? Value->AsObject() : nullptr;
            if (!Test.IsValid()) continue;

            FString Name = ReadStringEither(Test, TEXT("fullTestPath"), TEXT("FullTestPath"));
            if (Name.IsEmpty())
            {
                Name = ReadStringEither(Test, TEXT("testDisplayName"), TEXT("TestDisplayName"));
            }
            const FString StateName = ReadStringEither(Test, TEXT("state"), TEXT("State"));
            if (StateName.Equals(TEXT("Success"), ESearchCase::IgnoreCase)
                || StateName.Equals(TEXT("SuccessWithWarnings"), ESearchCase::IgnoreCase))
            {
                OutPassed.Add(MakeStr(Name));
            }
            else if (StateName.Equals(TEXT("NotRun"), ESearchCase::IgnoreCase)
                || StateName.Equals(TEXT("InProcess"), ESearchCase::IgnoreCase))
            {
                OutSkipped.Add(MakeStr(Name));
            }
            else
            {
                auto Failure = MakeShared<FJsonObject>();
                Failure->SetStringField(TEXT("name"), Name);
                Failure->SetStringField(TEXT("outcome"), TEXT("failed"));
                OutFailed.Add(MakeShared<FJsonValueObject>(Failure));
            }
        }

        const int32 ReportedTotal = FMath::RoundToInt(
            Succeeded + SucceededWithWarnings + Failed + NotRun + InProcess);
        bOutSelectionMatched = ReportedTotal == State->Names.Num()
            && Tests->Num() == State->Names.Num();
        return true;
    }

    static int32 CountAttributedCrashArtifacts(
        const TSharedRef<FOwnedAutomationChildState>& State)
    {
        const FString CrashRoot = FPaths::ProjectSavedDir() / TEXT("Crashes");
        TArray<FString> ContextFiles;
        IFileManager::Get().FindFilesRecursive(
            ContextFiles,
            *CrashRoot,
            TEXT("CrashContext.runtime-xml"),
            true,
            false,
            false);

        int32 Count = 0;
        const FString TokenMarker = TEXT("-HaybaAutomationChild=") + State->OwnershipToken;
        for (const FString& ContextFile : ContextFiles)
        {
            if (IFileManager::Get().GetTimeStamp(*ContextFile)
                < State->StartedAtUtc - FTimespan::FromSeconds(1.0))
            {
                continue;
            }
            FString Context;
            if (FFileHelper::LoadFileToString(Context, *ContextFile)
                && Context.Contains(TokenMarker, ESearchCase::CaseSensitive))
            {
                ++Count;
            }
        }
        return Count;
    }

    static FString MakeOwnedChildResultsJson(
        const TSharedRef<FOwnedAutomationChildState>& State,
        int32 ExitCode)
    {
        TArray<TSharedPtr<FJsonValue>> Passed;
        TArray<TSharedPtr<FJsonValue>> Failed;
        TArray<TSharedPtr<FJsonValue>> Skipped;
        double ReportDuration = 0.0;
        bool bSelectionMatched = false;
        const bool bReportValid = ReadOwnedChildReport(
            State, Passed, Failed, Skipped, ReportDuration, bSelectionMatched);
        const HaybaAutomationIsolation::EChildOutcome Outcome =
            HaybaAutomationIsolation::ClassifyChildOutcome(
                true, bReportValid, State->bTimedOut, State->bCancelRequested, ExitCode);

        if (Outcome != HaybaAutomationIsolation::EChildOutcome::Reported)
        {
            Passed.Reset();
            Skipped.Reset();
            Failed.Reset();
            for (const FString& Name : State->Names)
            {
                auto Failure = MakeShared<FJsonObject>();
                Failure->SetStringField(TEXT("name"), Name);
                Failure->SetStringField(TEXT("outcome"),
                    Outcome == HaybaAutomationIsolation::EChildOutcome::TimedOut ? TEXT("timed_out") :
                    Outcome == HaybaAutomationIsolation::EChildOutcome::Cancelled ? TEXT("cancelled") :
                    Outcome == HaybaAutomationIsolation::EChildOutcome::NeverStarted ? TEXT("never_started") :
                    TEXT("child_crashed"));
                Failed.Add(MakeShared<FJsonValueObject>(Failure));
            }
        }
        else if (!bSelectionMatched)
        {
            auto Failure = MakeShared<FJsonObject>();
            Failure->SetStringField(TEXT("name"), TEXT("test_run selection contract"));
            Failure->SetStringField(TEXT("outcome"), TEXT("report_selection_mismatch"));
            Failed.Add(MakeShared<FJsonValueObject>(Failure));
        }

        const double Elapsed = FPlatformTime::Seconds() - State->StartedAtSeconds;
        TSharedRef<FJsonObject> Results = MakeShared<FJsonObject>();
        Results->SetArrayField(TEXT("passed"), Passed);
        Results->SetArrayField(TEXT("failed"), Failed);
        Results->SetArrayField(TEXT("skipped"), Skipped);
        Results->SetNumberField(TEXT("passed_count"), Passed.Num());
        Results->SetNumberField(TEXT("failed_count"), Failed.Num());
        Results->SetNumberField(TEXT("skipped_count"), Skipped.Num());
        Results->SetNumberField(TEXT("total"), State->Names.Num());
        Results->SetBoolField(TEXT("all_passed"),
            bReportValid && bSelectionMatched && ExitCode == 0
            && Failed.IsEmpty() && Skipped.IsEmpty() && Passed.Num() == State->Names.Num());
        Results->SetNumberField(TEXT("elapsed_seconds"), Elapsed);
        Results->SetNumberField(TEXT("report_duration_seconds"), ReportDuration);
        Results->SetStringField(TEXT("execution_mode"), TEXT("owned_child"));
        Results->SetStringField(TEXT("ownership_token"), State->OwnershipToken);
        Results->SetNumberField(TEXT("child_pid"), State->ProcessId);
        Results->SetBoolField(TEXT("child_started"), true);
        Results->SetNumberField(TEXT("process_exit_code"), ExitCode);
        Results->SetBoolField(TEXT("report_valid"), bReportValid);
        Results->SetBoolField(TEXT("report_selection_matched"), bSelectionMatched);
        Results->SetBoolField(TEXT("timed_out"), State->bTimedOut);
        Results->SetBoolField(TEXT("cancelled"), State->bCancelRequested);
        Results->SetBoolField(TEXT("crashed"),
            Outcome == HaybaAutomationIsolation::EChildOutcome::Crashed);
        Results->SetNumberField(TEXT("crash_artifact_count"), CountAttributedCrashArtifacts(State));
        Results->SetNumberField(TEXT("captured_output_chars"), State->OutputChars);
        Results->SetBoolField(TEXT("output_truncated"), State->bOutputTruncated);

        FString Json;
        const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json);
        FJsonSerializer::Serialize(Results, Writer);
        return Json;
    }

    static void FinalizeOwnedChild(
        const TSharedRef<FOwnedAutomationChildState>& State,
        int32 ExitCode)
    {
        CaptureBoundedChildOutput(State);
        const FString ResultsJson = MakeOwnedChildResultsJson(State, ExitCode);
        TSharedPtr<FJsonObject> Results;
        FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(ResultsJson), Results);
        double FailedCount = 1.0;
        if (Results.IsValid()) Results->TryGetNumberField(TEXT("failed_count"), FailedCount);
        FHaybaMCPJobRegistry::Get().SetDone(
            State->JobId, FMath::Max(ExitCode, FMath::RoundToInt(FailedCount)), ResultsJson);
        State->bFinalized = true;
        State->LeaseGuard.Reset();
        GetActiveOwnedChildState().Reset();
    }

    static bool OwnedChildPump(
        float /*Dt*/,
        TSharedRef<FOwnedAutomationChildState> State)
    {
        CaptureBoundedChildOutput(State);
        if (FPlatformProcess::IsProcRunning(State->Process))
        {
            if (State->bCancelRequested)
            {
                FPlatformProcess::TerminateProc(State->Process, true);
            }
            else if (FPlatformTime::Seconds() - State->StartedAtSeconds > State->TimeoutSeconds)
            {
                State->bTimedOut = true;
                FPlatformProcess::TerminateProc(State->Process, true);
            }
            return true;
        }

        int32 ExitCode = -1;
        FPlatformProcess::GetProcReturnCode(State->Process, &ExitCode);
        FinalizeOwnedChild(State, ExitCode);
        return false;
    }

    struct FTestRunState
    {
        FString          JobId;
        TArray<FString>  Names;
        TArray<FString>  RegisteredNames;
        double           PerTestTimeoutSec = 120.0;

        int32            Index       = 0;
        bool             bInProgress = false;
        double           TestStart   = 0.0;
        double           RunStart    = 0.0;

        TArray<TSharedPtr<FJsonValue>> Passed;
        TArray<TSharedPtr<FJsonValue>> Failed;
        TArray<TSharedPtr<FJsonValue>> Skipped;

        // Mirrored into GLastTest* for test_get_log when the run finishes.
        TArray<FString>                      ResultNames;
        TArray<FAutomationTestExecutionInfo> ResultExecs;

        FTSTicker::FDelegateHandle TickHandle;
        TUniquePtr<FHaybaMCPTestRunLeaseGuard> LeaseGuard;
        bool bFinalized = false;

        ~FTestRunState()
        {
            if (!bFinalized && !JobId.IsEmpty())
            {
                // Delegate removal/module teardown can destroy the last strong
                // state reference without another pump. Never leave its job
                // reporting "running" forever.
                FHaybaMCPJobRegistry::Get().SetDone(
                    JobId,
                    FMath::Max(Names.Num(), 1),
                    MakeLifecycleFailureResultsJson(
                        Names, TEXT("test_run state was destroyed before completion")));
            }
        }
    };

    static TWeakPtr<FTestRunState>& GetActiveTestRunState()
    {
        // See GetTestRunLease: survive until explicit module shutdown removes
        // the ticker and drops the last owning reference.
        static TWeakPtr<FTestRunState>* State = new TWeakPtr<FTestRunState>();
        return *State;
    }

    // Runs on the game thread (core ticker). Serializes the accumulated results
    // into the job registry + operation journal and clears the run lock.
    static void FinalizeTestRun(TSharedRef<FTestRunState> S)
    {
        const double Elapsed = FPlatformTime::Seconds() - S->RunStart;

        // Stash for test_get_log (also read on the game thread).
        GLastTestNames     = S->ResultNames;
        GLastTestExecInfos = S->ResultExecs;
        GLastTestInfos.Reset();

        TSharedRef<FJsonObject> Results = MakeShared<FJsonObject>();
        Results->SetArrayField(TEXT("passed"),  S->Passed);
        Results->SetArrayField(TEXT("failed"),  S->Failed);
        Results->SetArrayField(TEXT("skipped"), S->Skipped);
        Results->SetNumberField(TEXT("passed_count"), S->Passed.Num());
        Results->SetNumberField(TEXT("failed_count"), S->Failed.Num());
        Results->SetNumberField(TEXT("skipped_count"), S->Skipped.Num());
        Results->SetBoolField(TEXT("all_passed"),
            S->Passed.Num() == S->Names.Num() && S->Failed.IsEmpty() && S->Skipped.IsEmpty());
        Results->SetNumberField(TEXT("elapsed_seconds"), Elapsed);
        Results->SetNumberField(TEXT("total"), S->Names.Num());

        FString ResultsJson;
        TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&ResultsJson);
        FJsonSerializer::Serialize(Results, Writer);

        // exit_code == failure count (0 => all passed), output == results JSON.
        const int32 FailCount = S->Failed.Num();
        FHaybaMCPJobRegistry::Get().SetDone(S->JobId, FailCount, ResultsJson);
        S->bFinalized = true;

        // Release before non-essential reporting. The old boolean was cleared
        // after Journal(), so any abnormal reporting path could strand Hayba in
        // a permanent, unpollable busy state even though SetDone had succeeded.
        S->LeaseGuard.Reset();
        GetActiveTestRunState().Reset();

        // Append job completion to the operation journal.
        FHaybaJournalEntry Entry;
        Entry.Timestamp    = FDateTime::UtcNow();
        Entry.Command      = FString::Printf(TEXT("test_job:%s:exit"), *S->JobId);
        Entry.ParamsHash   = TEXT("");
        Entry.DurationMs   = (int64)(Elapsed * 1000.0);
        Entry.bOk          = (FailCount == 0);
        Entry.ErrorMessage = FString::Printf(TEXT("passed=%d failed=%d skipped=%d"),
            S->Passed.Num(), FailCount, S->Skipped.Num());
        FHaybaMCPSecurityManager::Get().Journal(Entry);

    }

    // One pump step per frame. Returns false to unregister the ticker.
    static bool TestRunPump(float /*Dt*/, TSharedRef<FTestRunState> S)
    {
        FAutomationTestFramework& Framework = FAutomationTestFramework::Get();
        bool bTimedOut = false;

        if (!S->bInProgress)
        {
            if (S->Index >= S->Names.Num())
            {
                FinalizeTestRun(S);
                return false; // done — stop ticking
            }

            const FString& Name = S->Names[S->Index];

            // StartTestByName wants the REGISTERED name, which for
            // IMPLEMENT_SIMPLE_AUTOMATION_TEST is the C++ class name — NOT the
            // dotted pretty name the same framework reports from
            // GetValidTestNames(). Passing the pretty name (the obvious thing,
            // and what test_list shows as `name`) makes UE log "Test <x> does
            // not exist" and start nothing, which this handler then recorded as
            // "skipped". Every test_run ever made returned skipped for
            // everything, and skipped reads like a decision rather than a
            // failure — so the harness looked like it worked.
            const FString& Registered = S->RegisteredNames[S->Index];
            bTimedOut = false;

            Framework.StartTestByName(Registered, /*RoleIndex=*/0);
            // BOTH conditions matter. GetCurrentTest() says a test object was
            // selected; GIsAutomationTesting says the framework actually
            // entered testing mode. ExecuteLatentCommands and StopTest are
            // check()'d on the latter — a hard assert that takes the editor
            // down, not an error return.
            if (Framework.GetCurrentTest() == nullptr || !GIsAutomationTesting)
            {
                auto FailObj = MakeShared<FJsonObject>();
                FailObj->SetStringField(TEXT("name"), Name);
                FailObj->SetStringField(TEXT("error"),
                    FString::Printf(TEXT("no such test: '%s' (tried registered name '%s'). Use the `name` or "
                                         "`category` field from test_list."), *Name, *Registered));
                S->Failed.Add(MakeShared<FJsonValueObject>(FailObj));
                S->Index++;
                return true;
            }

            // Run this test to completion NOW, in this one tick.
            //
            // The original design spread start / pump / stop across frames to
            // keep the editor responsive. That cannot work here: a simple
            // automation test executes its body inside StartTestByName, and the
            // framework leaves testing mode before the next tick — so the pump
            // always found GIsAutomationTesting false and either asserted or
            // reported the test abandoned. Unit tests of this kind finish in
            // milliseconds; the frame budget below is what protects the editor,
            // not spreading the work out.
            {
                const double Budget = FMath::Min(S->PerTestTimeoutSec, 30.0);
                const double Began  = FPlatformTime::Seconds();
                while (GIsAutomationTesting && !Framework.ExecuteLatentCommands())
                {
                    if (FPlatformTime::Seconds() - Began > Budget) break;
                }
                S->TestStart = Began;
                bTimedOut = (FPlatformTime::Seconds() - Began) > Budget;
            }
        }

        // Fall straight through to the stop below, in this same tick. Splitting
        // start from stop across frames is what broke: nothing holds the
        // framework in testing mode between them.

        // StopTest does check(GIsAutomationTesting) and takes the whole editor
        // down when it is false — an assert, not an error return. Reached that
        // exactly once by fixing the name resolution above, which is a poor way
        // to find out. Only stop a test the framework still believes is running.
        FAutomationTestExecutionInfo ExecInfo;
        bool bSuccess = false;
        if (Framework.GetCurrentTest() != nullptr && GIsAutomationTesting)
        {
            bSuccess = Framework.StopTest(ExecInfo);
        }
        else
        {
            ExecInfo.AddError(TEXT("the automation framework dropped this test before it could be stopped"));
        }
        const double TestDuration = FPlatformTime::Seconds() - S->TestStart;
        const FString Name = S->Names[S->Index];

        S->ResultNames.Add(Name);
        S->ResultExecs.Add(ExecInfo);

        if (bSuccess && !ExecInfo.GetErrorTotal() && !bTimedOut)
        {
            S->Passed.Add(MakeStr(Name));
        }
        else
        {
            auto FailObj = MakeShared<FJsonObject>();
            FailObj->SetStringField(TEXT("name"), Name);
            FailObj->SetNumberField(TEXT("duration_seconds"), TestDuration);
            if (bTimedOut) FailObj->SetBoolField(TEXT("timed_out"), true);
            TArray<TSharedPtr<FJsonValue>> Errors;
            for (const FAutomationExecutionEntry& Entry : ExecInfo.GetEntries())
            {
                if (Entry.Event.Type == EAutomationEventType::Error)
                {
                    Errors.Add(MakeStr(Entry.Event.Message));
                }
            }
            FailObj->SetArrayField(TEXT("errors"), Errors);
            S->Failed.Add(MakeShared<FJsonValueObject>(FailObj));
        }

        S->Index++;
        S->bInProgress = false;
        return true;
    }

    static FHaybaHandlerResult StartOwnedChildRun(
        TArray<FString> Names,
        double TimeoutSeconds,
        const FString& FilterPattern,
        const FString& CategoryFilter,
        bool bSmokeOnly)
    {
        FHaybaMCPTestRunLease& Lease = GetTestRunLease();
        TSharedRef<FOwnedAutomationChildState> State =
            MakeShared<FOwnedAutomationChildState>();
        State->JobId = FHaybaMCPJobRegistry::Get().AllocateJob(TEXT("test_run"));
        State->OwnershipToken = FGuid::NewGuid().ToString(EGuidFormats::Digits);
        State->Names = MoveTemp(Names);
        State->TimeoutSeconds = FMath::Clamp(
            TimeoutSeconds, 1.0, GAutomationChildMaximumTimeoutSeconds);
        State->StartedAtSeconds = FPlatformTime::Seconds();
        State->StartedAtUtc = FDateTime::UtcNow();
        State->ReportDirectory = FPaths::ProjectSavedDir()
            / TEXT("HaybaMCP/TestRuns") / State->OwnershipToken;

        if (!Lease.TryAcquire(State->JobId))
        {
            FHaybaMCPJobRegistry::Get().SetDone(
                State->JobId, -1,
                MakeOwnedChildNeverStartedResultsJson(
                    State, TEXT("failed to acquire test-run lease")));
            State->bFinalized = true;
            return FHaybaHandlerResult::Err(TEXT("failed to acquire test-run lease"));
        }
        State->LeaseGuard = MakeUnique<FHaybaMCPTestRunLeaseGuard>(Lease, State->JobId);

        if (!IFileManager::Get().MakeDirectory(*State->ReportDirectory, true)
            || !FPlatformProcess::CreatePipe(State->ReadPipe, State->WritePipe))
        {
            FHaybaMCPJobRegistry::Get().SetDone(
                State->JobId, -1,
                MakeOwnedChildNeverStartedResultsJson(
                    State, TEXT("owned automation child setup failed")));
            State->bFinalized = true;
            State->LeaseGuard.Reset();
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("owned automation child setup failed; job %s completed as failed"),
                *State->JobId));
        }

        const FString Editor = FPaths::ConvertRelativePathToFull(
            FPaths::EngineDir() / TEXT("Binaries/Win64/UnrealEditor-Cmd.exe"));
        if (!FPaths::FileExists(Editor))
        {
            FHaybaMCPJobRegistry::Get().SetDone(
                State->JobId, -1,
                MakeOwnedChildNeverStartedResultsJson(
                    State, TEXT("UnrealEditor-Cmd is unavailable")));
            State->bFinalized = true;
            State->LeaseGuard.Reset();
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("UnrealEditor-Cmd is unavailable; job %s completed as failed"),
                *State->JobId));
        }

        for (const FString& Name : State->Names)
        {
            if (Name.Contains(TEXT("+")) || Name.Contains(TEXT(";"))
                || Name.Contains(TEXT("\"")) || Name.Contains(TEXT("\r"))
                || Name.Contains(TEXT("\n")))
            {
                FHaybaMCPJobRegistry::Get().SetDone(
                    State->JobId, -1,
                    MakeOwnedChildNeverStartedResultsJson(
                        State, TEXT("test name cannot be represented safely on the child command line")));
                State->bFinalized = true;
                State->LeaseGuard.Reset();
                return FHaybaHandlerResult::Err(TEXT("unsafe automation test name rejected"));
            }
        }

        const FString ProjectPath = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
        const FString TestExpression = FString::Join(State->Names, TEXT("+"));
        const FString Args = FString::Printf(
            TEXT("\"%s\" -unattended -nop4 -nullrhi -nosplash -nosound -stdout "
                 "-FullStdOutLogOutput -ReportExportPath=\"%s\" "
                 "-HaybaAutomationChild=%s "
                 "-ExecCmds=\"Automation RunTests %s;Quit\" "
                 "-TestExit=\"Automation Test Queue Empty\""),
            *ProjectPath,
            *State->ReportDirectory,
            *State->OwnershipToken,
            *TestExpression);

        State->Process = FPlatformProcess::CreateProc(
            *Editor,
            *Args,
            false,
            true,
            true,
            &State->ProcessId,
            0,
            nullptr,
            State->WritePipe,
            nullptr);
        if (!State->Process.IsValid())
        {
            FHaybaMCPJobRegistry::Get().SetDone(
                State->JobId, -1,
                MakeOwnedChildNeverStartedResultsJson(
                    State, TEXT("UnrealEditor-Cmd child did not start")));
            State->bFinalized = true;
            State->LeaseGuard.Reset();
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("UnrealEditor-Cmd child did not start; job %s completed as failed"),
                *State->JobId));
        }

        State->TickHandle = FTSTicker::GetCoreTicker().AddTicker(
            FTickerDelegate::CreateLambda(
                [State](float Dt){ return OwnedChildPump(Dt, State); }));
        if (!State->TickHandle.IsValid())
        {
            FPlatformProcess::TerminateProc(State->Process, true);
            FHaybaMCPJobRegistry::Get().SetDone(
                State->JobId, -1,
                MakeOwnedChildNeverStartedResultsJson(
                    State, TEXT("owned child monitor did not start")));
            State->bFinalized = true;
            State->LeaseGuard.Reset();
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("owned child monitor did not start; job %s completed as failed"),
                *State->JobId));
        }
        GetActiveOwnedChildState() = State;

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("command"), TEXT("test_run"));
        Out->SetStringField(TEXT("job_id"), State->JobId);
        Out->SetStringField(TEXT("status"), TEXT("running"));
        Out->SetStringField(TEXT("execution_mode"), TEXT("owned_child"));
        Out->SetStringField(TEXT("ownership_token"), State->OwnershipToken);
        Out->SetNumberField(TEXT("child_pid"), State->ProcessId);
        Out->SetNumberField(TEXT("total"), State->Names.Num());
        Out->SetNumberField(TEXT("timeout_seconds"), State->TimeoutSeconds);
        Out->SetBoolField(TEXT("ok"), true);
        if (!FilterPattern.IsEmpty()) Out->SetStringField(TEXT("filter"), FilterPattern);
        if (!CategoryFilter.IsEmpty()) Out->SetStringField(TEXT("category"), CategoryFilter);
        Out->SetBoolField(TEXT("smoke_only"), bSmokeOnly);
        Out->SetStringField(TEXT("note"),
            TEXT("Tests are running in a tagged owned UnrealEditor-Cmd child. Poll build_status { job_id }; use test_cancel { job_id } to terminate only that child."));
        return FHaybaHandlerResult::Ok(Out);
    }

    static FHaybaHandlerResult Cmd_TestRun(const TSharedPtr<FJsonObject>& Params)
    {
        if (!Params.IsValid())
        {
            return FHaybaHandlerResult::Err(TEXT("test_run requires params"));
        }

        bool bSmokeOnly = false;
        Params->TryGetBoolField(TEXT("smoke_only"), bSmokeOnly);

        FString FilterPattern;
        FString CategoryFilter;
        ReadTestSelectors(Params, FilterPattern, CategoryFilter);
        const bool bHasSelector = !FilterPattern.IsEmpty() || !CategoryFilter.IsEmpty();

        // Resolve list of test names to run.
        TArray<FString> RequestedNames;
        bool bRunAll = false;

        const TArray<TSharedPtr<FJsonValue>>* NamesArr = nullptr;
        if (Params->TryGetArrayField(TEXT("test_names"), NamesArr) && NamesArr)
        {
            for (const auto& V : *NamesArr)
            {
                FString S;
                if (V.IsValid() && V->TryGetString(S) && !S.IsEmpty())
                {
                    if (S.Equals(TEXT("all"), ESearchCase::IgnoreCase))
                    {
                        bRunAll = true;
                    }
                    else
                    {
                        RequestedNames.Add(S);
                    }
                }
            }
        }
        else
        {
            FString OneName;
            if (Params->TryGetStringField(TEXT("test_names"), OneName))
            {
                if (OneName.Equals(TEXT("all"), ESearchCase::IgnoreCase))
                {
                    bRunAll = true;
                }
                else if (!OneName.IsEmpty())
                {
                    RequestedNames.Add(OneName);
                }
            }
        }

        if (const FString CombinationError = HaybaTestSelection::ValidateCombination(
            bRunAll, RequestedNames.Num(), bHasSelector); !CombinationError.IsEmpty())
        {
            return FHaybaHandlerResult::Err(CombinationError);
        }

        // Expand "all"
        TArray<FAutomationTestInfo> Discovered;
        CollectAllTests(Discovered);
        if (bRunAll || bHasSelector)
        {
            RequestedNames.Reset();
            for (const FAutomationTestInfo& Info : Discovered)
            {
                if (!MatchesTestSelectors(Info, FilterPattern, CategoryFilter)) continue;
                if (bSmokeOnly && !EnumHasAnyFlags(static_cast<EAutomationTestFlags>(Info.GetTestFlags()),
                                                    EAutomationTestFlags::SmokeFilter))
                {
                    continue;
                }
                RequestedNames.Add(Info.GetFullTestPath());
            }
        }
        else if (bSmokeOnly)
        {
            // Filter requested set to smoke-tagged tests only.
            TSet<FString> SmokeNames;
            for (const FAutomationTestInfo& Info : Discovered)
            {
                if (EnumHasAnyFlags(static_cast<EAutomationTestFlags>(Info.GetTestFlags()),
                                    EAutomationTestFlags::SmokeFilter))
                {
                    SmokeNames.Add(Info.GetFullTestPath());
                    SmokeNames.Add(Info.GetDisplayName());
                }
            }
            RequestedNames = RequestedNames.FilterByPredicate(
                [&SmokeNames](const FString& N){ return SmokeNames.Contains(N); });
        }

        const FString SelectionError = HaybaTestSelection::ValidateResolvedSelection(
            bRunAll, bHasSelector, RequestedNames.Num());
        if (!SelectionError.IsEmpty())
        {
            if (SelectionError != TEXT("test_run matched no tests"))
            {
                return FHaybaHandlerResult::Err(SelectionError);
            }

            FString SelectorDescription;
            if (!CategoryFilter.IsEmpty())
            {
                SelectorDescription += FString::Printf(TEXT(" category='%s'"), *CategoryFilter);
            }
            if (!FilterPattern.IsEmpty())
            {
                SelectorDescription += FString::Printf(TEXT(" filter='%s'"), *FilterPattern);
            }
            if (bSmokeOnly) SelectorDescription += TEXT(" smoke_only=true");
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("%s.%s Use test_list with the same selectors to inspect discovery."),
                *SelectionError,
                *SelectorDescription));
        }

        // Resolve every caller-facing display/path alias against the discovery
        // snapshot once. The old pump called CollectAllTests for every selected
        // test; a 331-test project suite therefore rediscovered ~7,000 engine
        // tests 331 times and flooded the log with MetaSound registration work.
        // Deduplicate aliases that resolve to the same registered test while
        // preserving the first caller-facing name for results.
        TArray<FString> UniqueNames;
        TArray<FString> RegisteredNames;
        TSet<FString> SeenRegisteredNames;
        for (const FString& RequestedName : RequestedNames)
        {
            const FString RegisteredName = ResolveRegisteredTestName(RequestedName, Discovered);
            const FString CanonicalName = ResolveCanonicalTestPath(RequestedName, Discovered);
            if (CanonicalName.IsEmpty())
            {
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("test_run could not resolve '%s' to a currently registered test; use test_list and retry"),
                    *RequestedName));
            }
            if (SeenRegisteredNames.Contains(RegisteredName)) continue;
            SeenRegisteredNames.Add(RegisteredName);
            UniqueNames.Add(CanonicalName);
            RegisteredNames.Add(RegisteredName);
        }
        RequestedNames = MoveTemp(UniqueNames);

        // In-process runs interpret this per test. Owned-child runs interpret
        // it as a total process deadline and clamp it to a hard maximum.
        double PerTestTimeoutSec = 120.0;
        Params->TryGetNumberField(TEXT("timeout_seconds"), PerTestTimeoutSec);
        if (PerTestTimeoutSec <= 0.0) PerTestTimeoutSec = 120.0;

        // Reject only a pollable, running owner. Module/live-code reloads and
        // abnormal ticker teardown can otherwise leave process-static state
        // behind while the job registry no longer contains that job.
        FHaybaMCPTestRunLease& Lease = GetTestRunLease();
        if (const TSharedPtr<FOwnedAutomationChildState> ActiveChild =
                GetActiveOwnedChildState().Pin())
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("a test_run job %s owns UnrealEditor-Cmd PID %u; poll build_status { job_id: '%s' } or cancel it with test_cancel"),
                *ActiveChild->JobId, ActiveChild->ProcessId, *ActiveChild->JobId));
        }
        if (const TSharedPtr<FTestRunState> ActiveState = GetActiveTestRunState().Pin())
        {
            // A live state owns a ticker (the lambda holds the strong ref), so
            // registry absence cannot safely prove the framework is idle. Make
            // the owner pollable again and continue to reject overlap.
            const FHaybaJobState ActiveJob =
                FHaybaMCPJobRegistry::Get().GetJob(ActiveState->JobId);
            if (!ActiveJob.bFound)
            {
                FHaybaMCPJobRegistry::Get().RestoreRunningJob(
                    ActiveState->JobId, TEXT("test_run"), FDateTime::UtcNow());
            }
            if (!ActiveJob.bFound || ActiveJob.Status == EHaybaJobStatus::Running)
            {
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("a test_run job %s is already in progress; poll build_status { job_id: '%s' } before starting another"),
                    *ActiveState->JobId, *ActiveState->JobId));
            }

            // A done registry entry and a live ticker cannot both own the same
            // generation. Stop the stale callback before admitting a new run.
            FTSTicker::GetCoreTicker().RemoveTicker(ActiveState->TickHandle);
            ActiveState->TickHandle.Reset();
            ActiveState->bFinalized = true;
            GetActiveTestRunState().Reset();
            ActiveState->LeaseGuard.Reset();
        }
        if (Lease.IsActive())
        {
            const FString ActiveJobId = Lease.GetActiveJobId();
            FHaybaJobState ActiveJob = FHaybaMCPJobRegistry::Get().GetJob(ActiveJobId);
            if (ActiveJob.bFound && ActiveJob.Status == EHaybaJobStatus::Running)
            {
                // The ticker lambda owns a strong FTestRunState reference. No
                // live state therefore proves this running registry entry has
                // no executable owner; complete it instead of blocking forever.
                FHaybaMCPJobRegistry::Get().SetDone(
                    ActiveJobId,
                    1,
                    MakeLifecycleFailureResultsJson(
                        TArray<FString>(), TEXT("test_run lost its ticker state before completion")));
                ActiveJob = FHaybaMCPJobRegistry::Get().GetJob(ActiveJobId);
            }
            Lease.Reconcile(ActiveJob);
            UE_LOG(LogTemp, Warning,
                TEXT("[test_run] recovered orphaned single-flight lease for job %s"),
                *ActiveJobId);
        }

        bool bRequiresOwnedChild = false;
        for (const FString& Name : RequestedNames)
        {
            if (HaybaAutomationIsolation::Classify(Name)
                == HaybaAutomationIsolation::EExecutionMode::OwnedChild)
            {
                bRequiresOwnedChild = true;
                break;
            }
        }
        if (bRequiresOwnedChild)
        {
            const double ChildTimeout = PerTestTimeoutSec == 120.0
                ? GAutomationChildDefaultTimeoutSeconds
                : PerTestTimeoutSec;
            return StartOwnedChildRun(
                MoveTemp(RequestedNames), ChildTimeout,
                FilterPattern, CategoryFilter, bSmokeOnly);
        }

        // Long-running: drive the run on the game-thread core ticker (fires
        // OUTSIDE task-graph task execution, so latent commands that pump the
        // task graph / async loads are safe — same reason TcpServer drains
        // commands from a ticker). Return { job_id, status:"running" }
        // immediately; the agent polls build_status { job_id } for the result.
        // This replaces the old busy-sleep loop that froze the game thread.
        TSharedRef<FTestRunState> S = MakeShared<FTestRunState>();
        S->JobId             = FHaybaMCPJobRegistry::Get().AllocateJob(TEXT("test_run"));
        S->Names             = MoveTemp(RequestedNames);
        S->RegisteredNames   = MoveTemp(RegisteredNames);
        S->PerTestTimeoutSec = PerTestTimeoutSec;
        S->RunStart          = FPlatformTime::Seconds();

        if (!Lease.TryAcquire(S->JobId))
        {
            FHaybaMCPJobRegistry::Get().SetDone(
                S->JobId, -1, TEXT("{\"error\":\"failed to acquire test-run lease\"}"));
            S->bFinalized = true;
            return FHaybaHandlerResult::Err(TEXT("failed to acquire test-run lease"));
        }
        S->LeaseGuard = MakeUnique<FHaybaMCPTestRunLeaseGuard>(Lease, S->JobId);

        // Clear the per-run last-results stash now; the pump fills it on finish.
        GLastTestInfos.Reset();
        GLastTestExecInfos.Reset();
        GLastTestNames.Reset();

        S->TickHandle = FTSTicker::GetCoreTicker().AddTicker(
            FTickerDelegate::CreateLambda([S](float Dt){ return TestRunPump(Dt, S); }));
        if (!S->TickHandle.IsValid())
        {
            FHaybaMCPJobRegistry::Get().SetDone(
                S->JobId, -1, TEXT("{\"error\":\"failed to register test-run ticker\"}"));
            S->bFinalized = true;
            S->LeaseGuard.Reset();
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("failed to register test-run ticker; job %s was completed as failed"), *S->JobId));
        }
        GetActiveTestRunState() = S;

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("command"), TEXT("test_run"));
        Out->SetStringField(TEXT("job_id"), S->JobId);
        Out->SetStringField(TEXT("status"), TEXT("running"));
        Out->SetStringField(TEXT("execution_mode"), TEXT("in_process_allowlisted"));
        Out->SetNumberField(TEXT("total"), S->Names.Num());
        Out->SetBoolField(TEXT("ok"), true);
        if (!FilterPattern.IsEmpty()) Out->SetStringField(TEXT("filter"), FilterPattern);
        if (!CategoryFilter.IsEmpty()) Out->SetStringField(TEXT("category"), CategoryFilter);
        Out->SetBoolField(TEXT("smoke_only"), bSmokeOnly);
        Out->SetStringField(TEXT("note"),
            TEXT("Tests started asynchronously. Poll build_status { job_id } for {passed, failed, skipped, elapsed_seconds, total}, or test_get_log for the last run's detailed entries."));
        return FHaybaHandlerResult::Ok(Out);
    }

    static FHaybaHandlerResult Cmd_TestCancel(const TSharedPtr<FJsonObject>& Params)
    {
        FString JobId;
        if (!Params.IsValid()
            || !Params->TryGetStringField(TEXT("job_id"), JobId)
            || JobId.IsEmpty())
        {
            return FHaybaHandlerResult::Err(TEXT("test_cancel requires { job_id: string }"));
        }

        const TSharedPtr<FOwnedAutomationChildState> State =
            GetActiveOwnedChildState().Pin();
        if (!State.IsValid() || State->JobId != JobId)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("job %s is not the active owned automation child; no process was terminated"),
                *JobId));
        }

        State->bCancelRequested = true;
        if (State->Process.IsValid() && FPlatformProcess::IsProcRunning(State->Process))
        {
            FPlatformProcess::TerminateProc(State->Process, true);
        }

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("job_id"), State->JobId);
        Out->SetStringField(TEXT("status"), TEXT("cancelling"));
        Out->SetStringField(TEXT("execution_mode"), TEXT("owned_child"));
        Out->SetStringField(TEXT("ownership_token"), State->OwnershipToken);
        Out->SetNumberField(TEXT("child_pid"), State->ProcessId);
        Out->SetBoolField(TEXT("cancel_requested"), true);
        Out->SetStringField(TEXT("note"),
            TEXT("Only the tagged child owned by this job was terminated; poll build_status for terminal evidence."));
        return FHaybaHandlerResult::Ok(Out);
    }

    static FHaybaHandlerResult Cmd_TestGetLog(const TSharedPtr<FJsonObject>& /*Params*/)
    {
        TArray<TSharedPtr<FJsonValue>> Tests;
        for (int32 i = 0; i < GLastTestExecInfos.Num(); ++i)
        {
            const FAutomationTestExecutionInfo& Exec = GLastTestExecInfos[i];
            const FString Name = GLastTestNames.IsValidIndex(i) ? GLastTestNames[i] : FString();

            auto Obj = MakeShared<FJsonObject>();
            Obj->SetStringField(TEXT("name"), Name);
            Obj->SetBoolField  (TEXT("success"), Exec.GetErrorTotal() == 0);
            Obj->SetNumberField(TEXT("duration_seconds"), Exec.Duration);

            TArray<TSharedPtr<FJsonValue>> Errors, Warnings;
            for (const FAutomationExecutionEntry& Entry : Exec.GetEntries())
            {
                if (Entry.Event.Type == EAutomationEventType::Error)
                {
                    Errors.Add(MakeStr(Entry.Event.Message));
                }
                else if (Entry.Event.Type == EAutomationEventType::Warning)
                {
                    Warnings.Add(MakeStr(Entry.Event.Message));
                }
            }
            Obj->SetArrayField(TEXT("errors"),   Errors);
            Obj->SetArrayField(TEXT("warnings"), Warnings);
            Tests.Add(MakeShared<FJsonValueObject>(Obj));
        }

        auto Out = MakeShared<FJsonObject>();
        Out->SetArrayField(TEXT("tests"), Tests);
        Out->SetNumberField(TEXT("count"), Tests.Num());
        return FHaybaHandlerResult::Ok(Out);
    }
#endif // WITH_EDITOR
}

TArray<FString> FHaybaMCPTestHandler::GetCommands() const
{
    return {
        TEXT("test_list"),
        TEXT("test_run"),
        TEXT("test_cancel"),
        TEXT("test_get_log")
    };
}

FHaybaHandlerResult FHaybaMCPTestHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
#if WITH_EDITOR
    if (Cmd == TEXT("test_list"))    return Cmd_TestList(Params);
    if (Cmd == TEXT("test_run"))     return Cmd_TestRun(Params);
    if (Cmd == TEXT("test_cancel"))  return Cmd_TestCancel(Params);
    if (Cmd == TEXT("test_get_log")) return Cmd_TestGetLog(Params);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("Unknown test command: %s"), *Cmd));
#else
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("editor_only"));
    Out->SetStringField(TEXT("domain"), TEXT("test"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
#endif
}

void FHaybaMCPTestHandler::ShutdownActiveRun()
{
#if WITH_EDITOR
    if (const TSharedPtr<FOwnedAutomationChildState> Child =
            GetActiveOwnedChildState().Pin())
    {
        GetActiveOwnedChildState().Reset();
        if (Child->TickHandle.IsValid())
        {
            FTSTicker::GetCoreTicker().RemoveTicker(Child->TickHandle);
            Child->TickHandle.Reset();
        }
        Child->bCancelRequested = true;
        if (Child->Process.IsValid() && FPlatformProcess::IsProcRunning(Child->Process))
        {
            // This handle was created by this job and carries its unique token.
            // Never enumerate or terminate an unrelated UnrealEditor process.
            FPlatformProcess::TerminateProc(Child->Process, true);
        }
        FHaybaMCPJobRegistry::Get().SetDone(
            Child->JobId,
            1,
            MakeOwnedChildResultsJson(Child.ToSharedRef(), -1));
        Child->bFinalized = true;
        Child->LeaseGuard.Reset();
    }

    const TSharedPtr<FTestRunState> ActiveState = GetActiveTestRunState().Pin();
    GetActiveTestRunState().Reset();
    if (!ActiveState.IsValid())
    {
        return;
    }

    // Module shutdown and live coding must remove callbacks before their code
    // can unload. This runs on the game thread, so it cannot interleave with a
    // pump step.
    if (ActiveState->TickHandle.IsValid())
    {
        FTSTicker::GetCoreTicker().RemoveTicker(ActiveState->TickHandle);
        ActiveState->TickHandle.Reset();
    }

    FAutomationTestFramework& Framework = FAutomationTestFramework::Get();
    if (Framework.GetCurrentTest() != nullptr && GIsAutomationTesting)
    {
        FAutomationTestExecutionInfo Ignored;
        Framework.StopTest(Ignored);
    }

    const FString Error = TEXT("test_run was interrupted by Hayba module shutdown");
    FHaybaMCPJobRegistry::Get().SetDone(
        ActiveState->JobId,
        FMath::Max(ActiveState->Names.Num(), 1),
        MakeLifecycleFailureResultsJson(ActiveState->Names, Error));
    ActiveState->bFinalized = true;

    GLastTestNames = ActiveState->Names;
    GLastTestExecInfos.Reset();
    for (int32 Index = 0; Index < ActiveState->Names.Num(); ++Index)
    {
        FAutomationTestExecutionInfo Exec;
        Exec.AddError(Error);
        GLastTestExecInfos.Add(MoveTemp(Exec));
    }

    // Release before the remainder of module shutdown can early-return or
    // touch services that are themselves tearing down.
    ActiveState->LeaseGuard.Reset();
#endif
}
