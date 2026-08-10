#include "HaybaMCPTestHandler.h"
#include "HaybaMCPTestSelectionOps.h"
#include "CoreGlobals.h"

#if WITH_EDITOR
#include "HaybaMCPJobRegistry.h"
#include "HaybaMCPSecurityManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/App.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"
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
    // drives corrupt each other's state. Set on start, cleared on finalize.
    static bool GTestRunActive = false;

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
    };

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

        GTestRunActive = false;
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
            if (SeenRegisteredNames.Contains(RegisteredName)) continue;
            SeenRegisteredNames.Add(RegisteredName);
            UniqueNames.Add(RequestedName);
            RegisteredNames.Add(RegisteredName);
        }
        RequestedNames = MoveTemp(UniqueNames);

        // Per-run timeout from params (seconds), default 120 per test.
        double PerTestTimeoutSec = 120.0;
        Params->TryGetNumberField(TEXT("timeout_seconds"), PerTestTimeoutSec);
        if (PerTestTimeoutSec <= 0.0) PerTestTimeoutSec = 120.0;

        // Reject overlapping runs — the automation framework is single-flight.
        if (GTestRunActive)
        {
            return FHaybaHandlerResult::Err(
                TEXT("a test_run job is already in progress; poll build_status for it before starting another"));
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

        // Clear the per-run last-results stash now; the pump fills it on finish.
        GLastTestInfos.Reset();
        GLastTestExecInfos.Reset();
        GLastTestNames.Reset();

        GTestRunActive = true;
        S->TickHandle = FTSTicker::GetCoreTicker().AddTicker(
            FTickerDelegate::CreateLambda([S](float Dt){ return TestRunPump(Dt, S); }));

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("command"), TEXT("test_run"));
        Out->SetStringField(TEXT("job_id"), S->JobId);
        Out->SetStringField(TEXT("status"), TEXT("running"));
        Out->SetNumberField(TEXT("total"), S->Names.Num());
        Out->SetBoolField(TEXT("ok"), true);
        if (!FilterPattern.IsEmpty()) Out->SetStringField(TEXT("filter"), FilterPattern);
        if (!CategoryFilter.IsEmpty()) Out->SetStringField(TEXT("category"), CategoryFilter);
        Out->SetBoolField(TEXT("smoke_only"), bSmokeOnly);
        Out->SetStringField(TEXT("note"),
            TEXT("Tests started asynchronously. Poll build_status { job_id } for {passed, failed, skipped, elapsed_seconds, total}, or test_get_log for the last run's detailed entries."));
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
        TEXT("test_get_log")
    };
}

FHaybaHandlerResult FHaybaMCPTestHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
#if WITH_EDITOR
    if (Cmd == TEXT("test_list"))    return Cmd_TestList(Params);
    if (Cmd == TEXT("test_run"))     return Cmd_TestRun(Params);
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
