#include "HaybaMCPTestHandler.h"

#if WITH_EDITOR
#include "Misc/AutomationTest.h"
#include "Misc/App.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "Dom/JsonValue.h"
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

    static FHaybaHandlerResult Cmd_TestList(const TSharedPtr<FJsonObject>& Params)
    {
        FString FilterPattern;
        FString CategoryFilter;
        if (Params.IsValid())
        {
            Params->TryGetStringField(TEXT("filter_pattern"), FilterPattern);
            Params->TryGetStringField(TEXT("category"),       CategoryFilter);
        }

        TArray<FAutomationTestInfo> AllTests;
        CollectAllTests(AllTests);

        TArray<TSharedPtr<FJsonValue>> JsonTests;
        for (const FAutomationTestInfo& Info : AllTests)
        {
            const FString DisplayName = Info.GetDisplayName();
            const FString FullPath    = Info.GetFullTestPath();

            if (!FilterPattern.IsEmpty()
                && !DisplayName.Contains(FilterPattern)
                && !FullPath.Contains(FilterPattern))
            {
                continue;
            }
            if (!CategoryFilter.IsEmpty() && !FullPath.StartsWith(CategoryFilter))
            {
                continue;
            }

            JsonTests.Add(MakeShared<FJsonValueObject>(TestInfoToJson(Info)));
        }

        auto Out = MakeShared<FJsonObject>();
        Out->SetArrayField(TEXT("tests"), JsonTests);
        Out->SetNumberField(TEXT("count"), JsonTests.Num());
        Out->SetNumberField(TEXT("total_discovered"), AllTests.Num());
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

        // Expand "all"
        TArray<FAutomationTestInfo> Discovered;
        CollectAllTests(Discovered);
        if (bRunAll)
        {
            RequestedNames.Reset();
            for (const FAutomationTestInfo& Info : Discovered)
            {
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

        if (RequestedNames.Num() == 0)
        {
            auto Empty = MakeShared<FJsonObject>();
            Empty->SetArrayField(TEXT("passed"),  {});
            Empty->SetArrayField(TEXT("failed"),  {});
            Empty->SetArrayField(TEXT("skipped"), {});
            Empty->SetNumberField(TEXT("elapsed_seconds"), 0.0);
            Empty->SetStringField(TEXT("note"), TEXT("no matching tests"));
            return FHaybaHandlerResult::Ok(Empty);
        }

        // Resolve display->fullpath where needed (StartTestByName accepts either).
        FAutomationTestFramework& Framework = FAutomationTestFramework::Get();

        // Per-run timeout from params (seconds), default 120 per test.
        double PerTestTimeoutSec = 120.0;
        Params->TryGetNumberField(TEXT("timeout_seconds"), PerTestTimeoutSec);
        if (PerTestTimeoutSec <= 0.0) PerTestTimeoutSec = 120.0;

        TArray<TSharedPtr<FJsonValue>> PassedArr;
        TArray<TSharedPtr<FJsonValue>> FailedArr;
        TArray<TSharedPtr<FJsonValue>> SkippedArr;

        GLastTestInfos.Reset();
        GLastTestExecInfos.Reset();
        GLastTestNames.Reset();

        const double RunStart = FPlatformTime::Seconds();

        for (const FString& Name : RequestedNames)
        {
            // Default to first role (typically Editor/Client).
            FAutomationTestExecutionInfo ExecInfo;
            const int32 RoleIndex = 0;

            // UE 5.7: StartTestByName returns void. Detect failure via GetCurrentTest().
            Framework.StartTestByName(Name, RoleIndex);
            const bool bStarted = Framework.GetCurrentTest() != nullptr;
            if (!bStarted)
            {
                SkippedArr.Add(MakeStr(Name));
                continue;
            }

            const double TestStart = FPlatformTime::Seconds();
            // Pump latent commands until the running test completes or we time out.
            while (!Framework.ExecuteLatentCommands())
            {
                if (FPlatformTime::Seconds() - TestStart > PerTestTimeoutSec)
                {
                    break;
                }
                FPlatformProcess::Sleep(0.01f);
            }

            const bool bSuccess = Framework.StopTest(ExecInfo);
            const double TestDuration = FPlatformTime::Seconds() - TestStart;

            GLastTestNames.Add(Name);
            GLastTestExecInfos.Add(ExecInfo);

            if (bSuccess && !ExecInfo.GetErrorTotal())
            {
                PassedArr.Add(MakeStr(Name));
            }
            else
            {
                auto FailObj = MakeShared<FJsonObject>();
                FailObj->SetStringField(TEXT("name"), Name);
                FailObj->SetNumberField(TEXT("duration_seconds"), TestDuration);
                TArray<TSharedPtr<FJsonValue>> Errors;
                for (const FAutomationExecutionEntry& Entry : ExecInfo.GetEntries())
                {
                    if (Entry.Event.Type == EAutomationEventType::Error)
                    {
                        Errors.Add(MakeStr(Entry.Event.Message));
                    }
                }
                FailObj->SetArrayField(TEXT("errors"), Errors);
                FailedArr.Add(MakeShared<FJsonValueObject>(FailObj));
            }
        }

        const double Elapsed = FPlatformTime::Seconds() - RunStart;

        auto Out = MakeShared<FJsonObject>();
        Out->SetArrayField(TEXT("passed"),  PassedArr);
        Out->SetArrayField(TEXT("failed"),  FailedArr);
        Out->SetArrayField(TEXT("skipped"), SkippedArr);
        Out->SetNumberField(TEXT("elapsed_seconds"), Elapsed);
        Out->SetNumberField(TEXT("total"), RequestedNames.Num());
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
