#include "HaybaMCPCommandHandler.h"
#include "IHaybaMCPHandler.h"
#include "HaybaMCPSecurityManager.h"
#include "HaybaMCPResponseBuilder.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPPlanPanel.h"
#include "HaybaMCPToolStreamPanel.h"
#include "HaybaMCPSceneMapPanel.h"
#include "HaybaMCPSceneMapData.h"
#include "HaybaMCPValidationPanel.h"
#include "HaybaMCPMemoryPanel.h"
#include "HaybaMCPDiffPanel.h"
#include "Json.h"
#include "Async/Async.h"
#include "Modules/ModuleManager.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPCmd, Log, All);

static bool IsDestructiveCommand(const FString& Cmd)
{
    return Cmd == TEXT("actor_delete")
        || Cmd == TEXT("actor_spawn")
        || Cmd == TEXT("python_exec")
        || Cmd == TEXT("memory_clear")
        || Cmd == TEXT("editor_execute_console")
        || Cmd == TEXT("landscape_import")
        || Cmd == TEXT("pcg_execute_graph");
}

static void MaybeShowPlanModePrompt()
{
    auto& S = FHaybaMCPSettings::Get();
    if (!S.bPlanModeEnabled || S.bShownPlanModePrompt) return;
    if (S.PlanModeFirstUseDate == FDateTime()) S.PlanModeFirstUseDate = FDateTime::Now();
    const bool bOver7Days = (FDateTime::Now() - S.PlanModeFirstUseDate).GetDays() >= 7;
    const bool bOver50Calls = S.PlanModeToolCallCount >= 50;
    if (!bOver7Days && !bOver50Calls) return;

    S.bShownPlanModePrompt = true;
    S.Save();
    AsyncTask(ENamedThreads::GameThread, []()
    {
        FNotificationInfo Info(NSLOCTEXT("Hayba", "PlanModePrompt",
            "You've been using Plan Mode for a while — consider disabling it from the toolbar if you trust your workflow."));
        Info.ExpireDuration = 10.f;
        FSlateNotificationManager::Get().AddNotification(Info);
    });
}

static EHaybaNodeSemantic SemanticFromString(const FString& S)
{
    if (S.Equals(TEXT("foliage"),   ESearchCase::IgnoreCase)) return EHaybaNodeSemantic::Foliage;
    if (S.Equals(TEXT("building"),  ESearchCase::IgnoreCase)) return EHaybaNodeSemantic::Building;
    if (S.Equals(TEXT("light"),     ESearchCase::IgnoreCase)) return EHaybaNodeSemantic::Light;
    if (S.Equals(TEXT("trigger"),   ESearchCase::IgnoreCase)) return EHaybaNodeSemantic::Trigger;
    if (S.Equals(TEXT("character"), ESearchCase::IgnoreCase)) return EHaybaNodeSemantic::Character;
    if (S.Equals(TEXT("blueprint"), ESearchCase::IgnoreCase)) return EHaybaNodeSemantic::Blueprint;
    if (S.Equals(TEXT("ism"),       ESearchCase::IgnoreCase)) return EHaybaNodeSemantic::ISM;
    return EHaybaNodeSemantic::Other;
}

static void PushSceneGraphToPanel(const TSharedPtr<FJsonObject>& Data)
{
    if (!Data.IsValid()) return;
    TArray<FHaybaSceneNode> Nodes;
    TArray<FHaybaSceneEdge> Edges;
    TMap<FString, int32> IdToIdx;

    const TArray<TSharedPtr<FJsonValue>>* NodesArr = nullptr;
    if (Data->TryGetArrayField(TEXT("nodes"), NodesArr))
    {
        for (const auto& V : *NodesArr)
        {
            const TSharedPtr<FJsonObject> N = V->AsObject();
            if (!N.IsValid()) continue;
            FHaybaSceneNode SN;
            N->TryGetStringField(TEXT("actorId"), SN.ActorId);
            N->TryGetStringField(TEXT("label"),   SN.Label);
            const TSharedPtr<FJsonObject>* Loc = nullptr;
            if (N->TryGetObjectField(TEXT("location"), Loc) && Loc && (*Loc).IsValid())
            {
                double X = 0, Y = 0;
                (*Loc)->TryGetNumberField(TEXT("x"), X);
                (*Loc)->TryGetNumberField(TEXT("y"), Y);
                SN.WorldPos = FVector2D(X, Y);
            }
            FString SemStr;
            N->TryGetStringField(TEXT("semantic"), SemStr);
            SN.Semantic = SemanticFromString(SemStr);
            IdToIdx.Add(SN.ActorId, Nodes.Num());
            Nodes.Add(MoveTemp(SN));
        }
    }

    const TArray<TSharedPtr<FJsonValue>>* EdgesArr = nullptr;
    if (Data->TryGetArrayField(TEXT("edges"), EdgesArr))
    {
        for (const auto& V : *EdgesArr)
        {
            const TSharedPtr<FJsonObject> E = V->AsObject();
            if (!E.IsValid()) continue;
            FString From, To;
            E->TryGetStringField(TEXT("from"), From);
            E->TryGetStringField(TEXT("to"),   To);
            const int32* FromIdx = IdToIdx.Find(From);
            const int32* ToIdx   = IdToIdx.Find(To);
            if (FromIdx && ToIdx)
            {
                FHaybaSceneEdge SE;
                SE.FromIdx = *FromIdx;
                SE.ToIdx = *ToIdx;
                E->TryGetBoolField(TEXT("hierarchical"), SE.bHierarchical);
                Edges.Add(SE);
            }
        }
    }

    AsyncTask(ENamedThreads::GameThread, [Nodes = MoveTemp(Nodes), Edges = MoveTemp(Edges)]()
    {
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPSceneMapPanel> Panel = M->SceneMapPanel.Pin())
            {
                Panel->LoadSceneGraph(Nodes, Edges);
            }
        }
    });
}

static void PushPhysicsResultsToPanel(const TSharedPtr<FJsonObject>& Data)
{
    if (!Data.IsValid()) return;
    TArray<FHaybaValidationIssue> Issues;
    const TArray<TSharedPtr<FJsonValue>>* OverlapsArr = nullptr;
    if (Data->TryGetArrayField(TEXT("overlaps"), OverlapsArr))
    {
        for (const auto& V : *OverlapsArr)
        {
            const TSharedPtr<FJsonObject> O = V->AsObject();
            if (!O.IsValid()) continue;
            FHaybaValidationIssue I;
            I.IssueType = TEXT("Physics Overlap");
            I.Severity = EHaybaSeverity::Warning;
            FString A, B;
            O->TryGetStringField(TEXT("a"), A);
            O->TryGetStringField(TEXT("b"), B);
            I.ActorLabel = A;
            I.Description = FString::Printf(TEXT("overlaps %s"), *B);
            Issues.Add(MoveTemp(I));
        }
    }
    AsyncTask(ENamedThreads::GameThread, [Issues = MoveTemp(Issues)]()
    {
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPValidationPanel> Panel = M->ValidationPanel.Pin())
            {
                Panel->Clear();
                for (const auto& I : Issues) Panel->AddIssue(I);
            }
        }
    });
}

static void PushMemoryResultsToPanel(const TSharedPtr<FJsonObject>& Data)
{
    if (!Data.IsValid()) return;
    TArray<FString> Entries;
    const TArray<TSharedPtr<FJsonValue>>* ResultsArr = nullptr;
    if (Data->TryGetArrayField(TEXT("results"), ResultsArr))
    {
        for (const auto& V : *ResultsArr)
        {
            const TSharedPtr<FJsonObject> R = V->AsObject();
            if (!R.IsValid()) continue;
            FString Role, Content, Scope;
            R->TryGetStringField(TEXT("agentRole"), Role);
            R->TryGetStringField(TEXT("scope"),     Scope);
            R->TryGetStringField(TEXT("content"),   Content);
            Entries.Add(FString::Printf(TEXT("[%s/%s] %s"), *Scope, *Role, *Content));
        }
    }
    AsyncTask(ENamedThreads::GameThread, [Entries = MoveTemp(Entries)]()
    {
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPMemoryPanel> Panel = M->MemoryPanel.Pin())
            {
                Panel->SetResults(Entries);
            }
        }
    });
}

static FString JsonValueToString(const TSharedPtr<FJsonValue>& V)
{
    if (!V.IsValid()) return TEXT("");
    switch (V->Type)
    {
        case EJson::String: return V->AsString();
        case EJson::Number: return FString::SanitizeFloat(V->AsNumber());
        case EJson::Boolean: return V->AsBool() ? TEXT("true") : TEXT("false");
        case EJson::Null:   return TEXT("null");
        default: {
            FString Out;
            TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
                TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
            FJsonSerializer::Serialize(V.ToSharedRef(), TEXT(""), Writer);
            return Out;
        }
    }
}

static void PushDiffEntries(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (!Params.IsValid()) return;
    TArray<FHaybaDiffEntry> Entries;
    FString ActorId;
    Params->TryGetStringField(TEXT("actorId"), ActorId);

    if (Cmd == TEXT("actor_delete"))
    {
        FHaybaDiffEntry E;
        E.ActorLabel = ActorId.IsEmpty() ? TEXT("(unknown)") : ActorId;
        E.Property = TEXT("exists");
        E.Before = TEXT("true");
        E.After = TEXT("DELETED");
        Entries.Add(MoveTemp(E));
    }
    else if (Cmd == TEXT("actor_spawn"))
    {
        FString Cls;
        Params->TryGetStringField(TEXT("class"), Cls);
        FHaybaDiffEntry E;
        E.ActorLabel = Cls.IsEmpty() ? TEXT("(unknown class)") : Cls;
        E.Property = TEXT("exists");
        E.Before = TEXT("(none)");
        E.After = TEXT("SPAWNED");
        Entries.Add(MoveTemp(E));
    }
    else if (Cmd == TEXT("actor_set_transform"))
    {
        for (const TCHAR* Field : { TEXT("location"), TEXT("rotation"), TEXT("scale") })
        {
            const TSharedPtr<FJsonObject>* Sub = nullptr;
            if (Params->TryGetObjectField(Field, Sub) && Sub && (*Sub).IsValid())
            {
                FHaybaDiffEntry E;
                E.ActorLabel = ActorId;
                E.Property = Field;
                E.Before = TEXT("(unknown)");
                E.After = JsonValueToString(MakeShared<FJsonValueObject>(*Sub));
                Entries.Add(MoveTemp(E));
            }
        }
    }
    else if (Cmd == TEXT("actor_set_property"))
    {
        FString Prop;
        Params->TryGetStringField(TEXT("property"), Prop);
        const TSharedPtr<FJsonValue> Val = Params->TryGetField(TEXT("value"));
        FHaybaDiffEntry E;
        E.ActorLabel = ActorId;
        E.Property = Prop;
        E.Before = TEXT("(unknown)");
        E.After = JsonValueToString(Val);
        Entries.Add(MoveTemp(E));
    }
    else if (Cmd == TEXT("actor_set_tags"))
    {
        const TArray<TSharedPtr<FJsonValue>>* Tags = nullptr;
        if (Params->TryGetArrayField(TEXT("tags"), Tags) && Tags)
        {
            FString After;
            for (const auto& V : *Tags) After += (After.IsEmpty() ? TEXT("") : TEXT(", ")) + V->AsString();
            FHaybaDiffEntry E;
            E.ActorLabel = ActorId;
            E.Property = TEXT("tags");
            E.Before = TEXT("(unknown)");
            E.After = After;
            Entries.Add(MoveTemp(E));
        }
    }

    if (Entries.IsEmpty()) return;

    AsyncTask(ENamedThreads::GameThread, [Entries = MoveTemp(Entries)]()
    {
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPDiffPanel> Panel = M->DiffPanel.Pin())
            {
                for (const auto& E : Entries) Panel->AddEntry(E);
            }
        }
    });
}

static FString HandleProposePlan(const FString& Id, const TSharedPtr<FJsonObject>& Params)
{
    TArray<FHaybaPlanStep> Steps;
    const TArray<TSharedPtr<FJsonValue>>* StepsArr = nullptr;
    if (Params.IsValid() && Params->TryGetArrayField(TEXT("steps"), StepsArr))
    {
        for (int32 i = 0; i < StepsArr->Num(); i++)
        {
            FHaybaPlanStep S;
            S.Index = i;
            S.Title = (*StepsArr)[i]->AsString();
            Steps.Add(S);
        }
    }
    int32 AwaitSecs = 30;
    if (Params.IsValid()) Params->TryGetNumberField(TEXT("await_seconds"), AwaitSecs);

    AsyncTask(ENamedThreads::GameThread, [Steps, AwaitSecs]()
    {
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPPlanPanel> Panel = M->PlanPanel.Pin())
            {
                Panel->LoadPlan(Steps, AwaitSecs);
            }
        }
    });

    auto Data = MakeShared<FJsonObject>();
    Data->SetBoolField(TEXT("received"), true);
    Data->SetNumberField(TEXT("step_count"), Steps.Num());
    return FHaybaMCPCommandHandler::MakeOkResponse(Id, Data);
}

// Helper: serialize FJsonObject to compact string
static FString JsonToString(const TSharedRef<FJsonObject>& Obj)
{
    FString Output;
    TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
    FJsonSerializer::Serialize(Obj, Writer);
    return Output;
}

FHaybaMCPCommandHandler::FHaybaMCPCommandHandler() {}
FHaybaMCPCommandHandler::~FHaybaMCPCommandHandler() {}

void FHaybaMCPCommandHandler::RegisterHandler(TSharedRef<IHaybaMCPHandler> Handler)
{
    Handlers.Add(Handler);
    for (const FString& Cmd : Handler->GetCommands())
    {
        CommandToHandler.Add(Cmd, Handler);
    }
    UE_LOG(LogHaybaMCPCmd, Log, TEXT("Registered handler '%s' with %d commands"),
        *Handler->GetDomain(), Handler->GetCommands().Num());
}

TArray<FString> FHaybaMCPCommandHandler::GetAllCommands() const
{
    TArray<FString> Out;
    CommandToHandler.GenerateKeyArray(Out);
    return Out;
}

FString FHaybaMCPCommandHandler::ProcessCommand(const FString& CommandJson)
{
    TSharedPtr<FJsonObject> Parsed;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(CommandJson);
    if (!FJsonSerializer::Deserialize(Reader, Parsed) || !Parsed.IsValid())
    {
        UE_LOG(LogHaybaMCPCmd, Warning, TEXT("Failed to parse command JSON"));
        return MakeErrorResponse(TEXT(""), TEXT("Invalid JSON"));
    }

    const FString Cmd = Parsed->GetStringField(TEXT("cmd"));
    const FString Id = Parsed->GetStringField(TEXT("id"));
    TSharedPtr<FJsonObject> Params = Parsed->GetObjectField(TEXT("params"));
    if (!Params.IsValid()) Params = MakeShared<FJsonObject>();

    UE_LOG(LogHaybaMCPCmd, Log, TEXT("Processing command: %s (id: %s)"), *Cmd, *Id);

    // Auth gate
    FString AuthReason;
    if (!FHaybaMCPSecurityManager::Get().ValidateRequest(Parsed, AuthReason))
    {
        return MakeErrorResponse(Id, AuthReason);
    }

    // Special-case: hayba_propose_plan pushes to the UI Plan panel (no domain handler).
    if (Cmd == TEXT("hayba_propose_plan"))
    {
        return HandleProposePlan(Id, Params);
    }

    // Special-case: ui_memory_set pushes memory rows into the Memory Inspector
    // (called by the TS-side memoryQuery tool after the sqlite read).
    if (Cmd == TEXT("ui_memory_set"))
    {
        PushMemoryResultsToPanel(Params);
        auto Data = MakeShared<FJsonObject>();
        Data->SetBoolField(TEXT("received"), true);
        return MakeOkResponse(Id, Data);
    }

    // Plan Mode safety gate: block destructive commands until a plan is acknowledged.
    {
        auto& S = FHaybaMCPSettings::Get();
        if (S.bPlanModeEnabled && IsDestructiveCommand(Cmd))
        {
            auto Data = MakeShared<FJsonObject>();
            Data->SetStringField(TEXT("status"), TEXT("plan_mode_required"));
            Data->SetStringField(TEXT("hint"), TEXT("Plan Mode is ON. Call hayba_propose_plan with a steps[] array before invoking destructive commands."));
            return MakeOkResponse(Id, Data);
        }
        S.PlanModeToolCallCount++;
        S.Save();
        MaybeShowPlanModePrompt();
    }

    auto* Found = CommandToHandler.Find(Cmd);
    if (!Found)
    {
        FHaybaJournalEntry E{ FDateTime::UtcNow(), Cmd,
            FHaybaMCPSecurityManager::HashParams(Params), 0, false,
            TEXT("Unknown command") };
        FHaybaMCPSecurityManager::Get().Journal(E);
        return MakeErrorResponse(Id, FString::Printf(TEXT("Unknown command: %s"), *Cmd));
    }

    const double Start = FPlatformTime::Seconds();
    FHaybaHandlerResult Result = (*Found)->Handle(Cmd, Params);
    const int64 DurMs = (int64)((FPlatformTime::Seconds() - Start) * 1000.0);

    // Journal using result directly — no need to re-parse the response string
    FHaybaJournalEntry E{ FDateTime::UtcNow(), Cmd,
        FHaybaMCPSecurityManager::HashParams(Params), DurMs, Result.bOk, Result.ErrorMessage };
    FHaybaMCPSecurityManager::Get().Journal(E);

    // Push scene-shaped results into their dedicated panels.
    if (Result.bOk && Result.Data.IsValid())
    {
        if (Cmd == TEXT("scene_get_graph"))           PushSceneGraphToPanel(Result.Data);
        else if (Cmd == TEXT("scene_validate_physics")) PushPhysicsResultsToPanel(Result.Data);
        else if (Cmd == TEXT("memory_query"))           PushMemoryResultsToPanel(Result.Data);
    }
    // Log destructive ops to the Diff panel (params describe the requested change).
    if (Result.bOk)
    {
        PushDiffEntries(Cmd, Params);
    }

    // Push to Tool Stream panel for live observability.
    {
        const FString ParamsStr = JsonToString(Params.ToSharedRef());
        FString ResultStr;
        if (Result.bOk && Result.Data.IsValid()) ResultStr = JsonToString(Result.Data.ToSharedRef());
        else if (!Result.bOk) ResultStr = FString::Printf(TEXT("ERROR: %s"), *Result.ErrorMessage);

        AsyncTask(ENamedThreads::GameThread, [Cmd, ParamsStr, ResultStr]()
        {
            if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
            {
                if (TSharedPtr<SHaybaMCPToolStreamPanel> Panel = M->ToolStreamPanel.Pin())
                {
                    Panel->AddToolCall(Cmd, ParamsStr, ResultStr);
                }
            }
        });
    }

    if (Result.bOk)
    {
        // Apply response limits via FHaybaMCPResponseBuilder before serializing
        TSharedPtr<FJsonObject> DataObj = Result.Data.IsValid() ? Result.Data : MakeShared<FJsonObject>();
        FHaybaResponseLimits Limits;
        Limits.MaxArrayItems = 50;
        Limits.MaxStringChars = 512;
        Limits.MaxTopLevelFields = 20;
        FHaybaMCPResponseBuilder Builder(Limits);
        TSharedRef<FJsonObject> Trimmed = Builder.Build(DataObj.ToSharedRef());
        return MakeOkResponse(Id, Trimmed);
    }
    else
    {
        return MakeErrorResponse(Id, Result.ErrorMessage);
    }
}

FString FHaybaMCPCommandHandler::MakeOkResponse(const FString& Id, const TSharedPtr<FJsonObject>& Data)
{
    TSharedRef<FJsonObject> Response = MakeShareable(new FJsonObject());
    Response->SetStringField(TEXT("id"), Id);
    Response->SetBoolField(TEXT("ok"), true);
    Response->SetObjectField(TEXT("data"), Data.IsValid() ? Data.ToSharedRef() : MakeShareable(new FJsonObject()));
    return JsonToString(Response);
}

FString FHaybaMCPCommandHandler::MakeErrorResponse(const FString& Id, const FString& ErrorMessage)
{
    TSharedRef<FJsonObject> Response = MakeShareable(new FJsonObject());
    Response->SetStringField(TEXT("id"), Id);
    Response->SetBoolField(TEXT("ok"), false);
    Response->SetStringField(TEXT("error"), ErrorMessage);
    return JsonToString(Response);
}
