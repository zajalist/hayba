#include "HaybaMCPCommandHandler.h"
#include "IHaybaMCPHandler.h"
#include "HaybaMCPSecurityManager.h"
#include "HaybaMCPResponseBuilder.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPDeveloperSettings.h"
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
#include "Async/Future.h"
#include "HaybaMCPThreading.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
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
    HaybaThreading::ExecuteOnGameThread([]()
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

    HaybaThreading::ExecuteOnGameThread([Nodes = MoveTemp(Nodes), Edges = MoveTemp(Edges)]()
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
    HaybaThreading::ExecuteOnGameThread([Issues = MoveTemp(Issues)]()
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
    HaybaThreading::ExecuteOnGameThread([Entries = MoveTemp(Entries)]()
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

/**
 * Find an actor by its label in the editor world. Must run on the game thread.
 */
static AActor* FindActorByLabel_GameThread(const FString& Label)
{
    if (!GEditor) return nullptr;
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World) return nullptr;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        if (It->GetActorLabel() == Label) return *It;
    }
    return nullptr;
}

/**
 * Snapshot relevant fields of an actor BEFORE a destructive command runs.
 * Returns a map of "Property" -> "Before-value string".
 * Synchronously marshals to the game thread.
 */
static TMap<FString, FString> CaptureBeforeState(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    TMap<FString, FString> Before;
    if (!Params.IsValid()) return Before;
    FString ActorId;
    if (!Params->TryGetStringField(TEXT("actorId"), ActorId) || ActorId.IsEmpty()) return Before;

    // For commands that read existing state, snapshot synchronously on the game thread.
    const bool bWantTransform = (Cmd == TEXT("actor_set_transform"));
    const bool bWantTags      = (Cmd == TEXT("actor_set_tags"));
    const bool bWantProperty  = (Cmd == TEXT("actor_set_property"));
    const bool bWantDelete    = (Cmd == TEXT("actor_delete"));
    if (!bWantTransform && !bWantTags && !bWantProperty && !bWantDelete) return Before;

    FString PropertyName;
    if (bWantProperty) Params->TryGetStringField(TEXT("property"), PropertyName);

    HaybaThreading::RunOnGameThreadAndWait([&Before, ActorId, Cmd, PropertyName, bWantTransform, bWantTags, bWantProperty, bWantDelete]()
    {
        if (AActor* Actor = FindActorByLabel_GameThread(ActorId))
        {
            if (bWantDelete)
            {
                Before.Add(TEXT("exists"), TEXT("true"));
            }
            if (bWantTransform)
            {
                const FVector L  = Actor->GetActorLocation();
                const FRotator R = Actor->GetActorRotation();
                const FVector S  = Actor->GetActorScale3D();
                Before.Add(TEXT("location"), FString::Printf(TEXT("(%.1f, %.1f, %.1f)"), L.X, L.Y, L.Z));
                Before.Add(TEXT("rotation"), FString::Printf(TEXT("(p=%.1f y=%.1f r=%.1f)"), R.Pitch, R.Yaw, R.Roll));
                Before.Add(TEXT("scale"),    FString::Printf(TEXT("(%.2f, %.2f, %.2f)"), S.X, S.Y, S.Z));
            }
            if (bWantTags)
            {
                FString Joined;
                for (const FName& T : Actor->Tags) Joined += (Joined.IsEmpty() ? TEXT("") : TEXT(", ")) + T.ToString();
                Before.Add(TEXT("tags"), Joined.IsEmpty() ? TEXT("(none)") : Joined);
            }
            if (bWantProperty && !PropertyName.IsEmpty())
            {
                if (FProperty* Prop = Actor->GetClass()->FindPropertyByName(*PropertyName))
                {
                    FString Out;
                    Prop->ExportText_InContainer(0, Out, Actor, Actor, Actor, PPF_None);
                    Before.Add(PropertyName, Out);
                }
                else
                {
                    Before.Add(PropertyName, TEXT("(no such property)"));
                }
            }
        }
        else
        {
            Before.Add(TEXT("__missing__"), TEXT("(actor not found)"));
        }
    }, /*TimeoutSeconds=*/ 2.0);
    return Before;
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

static void PushDiffEntries(const FString& Cmd, const TSharedPtr<FJsonObject>& Params, const TMap<FString, FString>& Before)
{
    if (!Params.IsValid()) return;
    TArray<FHaybaDiffEntry> Entries;
    FString ActorId;
    Params->TryGetStringField(TEXT("actorId"), ActorId);

    auto BeforeOr = [&](const FString& Key, const TCHAR* Fallback) -> FString
    {
        const FString* V = Before.Find(Key);
        return V ? *V : FString(Fallback);
    };

    if (Cmd == TEXT("actor_delete"))
    {
        FHaybaDiffEntry E;
        E.ActorLabel = ActorId.IsEmpty() ? TEXT("(unknown)") : ActorId;
        E.Property = TEXT("exists");
        E.Before = BeforeOr(TEXT("exists"), TEXT("(unknown)"));
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
                E.Before = BeforeOr(Field, TEXT("(unknown)"));
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
        E.Before = BeforeOr(Prop, TEXT("(unknown)"));
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
            E.Before = BeforeOr(TEXT("tags"), TEXT("(unknown)"));
            E.After = After;
            Entries.Add(MoveTemp(E));
        }
    }

    if (Entries.IsEmpty()) return;

    HaybaThreading::ExecuteOnGameThread([Entries = MoveTemp(Entries)]()
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
            const TSharedPtr<FJsonValue>& Val = (*StepsArr)[i];
            // Accept either a bare string ("Spawn a light") OR a rich object
            // {"title":"…","description":"…","tool":"actor_spawn"} — the
            // richer shape lets the panel render proper context per step.
            const TSharedPtr<FJsonObject>* AsObj;
            if (Val.IsValid() && Val->TryGetObject(AsObj) && AsObj->IsValid())
            {
                (*AsObj)->TryGetStringField(TEXT("title"), S.Title);
                (*AsObj)->TryGetStringField(TEXT("description"), S.Description);
                (*AsObj)->TryGetStringField(TEXT("tool"), S.Tool);
            }
            else if (Val.IsValid())
            {
                S.Title = Val->AsString();
            }
            Steps.Add(S);
        }
    }
    int32 AwaitSecs = 30;
    if (Params.IsValid()) Params->TryGetNumberField(TEXT("await_seconds"), AwaitSecs);

    // Always buffer first — the Plan tab might not be constructed yet (it's
    // lazy; the panel weak-ref stays null until the user opens the tab).
    // Without this buffer, plans proposed before first tab visit were silently
    // dropped on the floor and the handler still returned received:true.
    FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit");
    if (M)
    {
        M->StashPendingPlan(Steps, AwaitSecs);
    }

    // Try to deliver to a live panel immediately too — if it's alive
    // RIGHT NOW, the user sees the plan without having to switch tabs.
    // The buffer is consumed in lockstep so the next tab open does not
    // show a stale copy. Goes through HaybaThreading so the inline-if-
    // on-game-thread path is handled centrally — no per-handler
    // IsInGameThread sprinkle.
    bool bPanelOpen = false;
    HaybaThreading::RunOnGameThreadAndWait([&bPanelOpen, &Steps, AwaitSecs]()
    {
        if (FHaybaMCPModule* M2 = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPPlanPanel> Panel = M2->PlanPanel.Pin())
            {
                Panel->LoadPlan(Steps, AwaitSecs);
                TArray<FHaybaPlanStep> _DiscardSteps; int32 _DiscardAwait;
                M2->ConsumePendingPlan(_DiscardSteps, _DiscardAwait);
                bPanelOpen = true;
            }
        }
    }, /*TimeoutSeconds=*/ 2.0);

    auto Data = MakeShared<FJsonObject>();
    Data->SetBoolField(TEXT("received"), true);
    Data->SetNumberField(TEXT("step_count"), Steps.Num());
    Data->SetBoolField(TEXT("buffered"), M != nullptr);
    Data->SetBoolField(TEXT("panel_visible"), bPanelOpen);
    if (!bPanelOpen)
    {
        Data->SetStringField(TEXT("hint"),
            TEXT("Plan was buffered but the Plan tab isn't open yet. Open Hayba → Plan to see it; the buffered plan is consumed on first construction."));
    }
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

    // Use TryGet* so a missing field doesn't spam LogJson warnings, and so
    // we can reject malformed frames explicitly below.
    FString Cmd;
    FString Id;
    Parsed->TryGetStringField(TEXT("cmd"), Cmd);
    Parsed->TryGetStringField(TEXT("id"), Id);

    // Empty / missing id was silently processed before, which masked client-
    // side request/response mismatches (the 2026-05-23 postmortem traced
    // several "unreliable" outcomes back to frames whose ack the TS client
    // could never correlate). Reject early with a framed error so the caller
    // notices instead of waiting on a response that will never arrive.
    if (Id.IsEmpty())
    {
        UE_LOG(LogHaybaMCPCmd, Warning,
            TEXT("Rejected request with missing/empty id (cmd='%s')"), *Cmd);
        return MakeErrorResponse(TEXT(""),
            TEXT("Request rejected: 'id' field is required and must be non-empty"));
    }

    if (Cmd.IsEmpty())
    {
        return MakeErrorResponse(Id,
            TEXT("Request rejected: 'cmd' field is required and must be non-empty"));
    }

    TSharedPtr<FJsonObject> Params;
    const TSharedPtr<FJsonObject>* ParamsObj = nullptr;
    if (Parsed->TryGetObjectField(TEXT("params"), ParamsObj) && ParamsObj && ParamsObj->IsValid())
    {
        Params = *ParamsObj;
    }
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

    // Special-case: ui_tool_stream_new_turn — the Node mirror detected an
    // idle gap (Claude started a new reply), so split the Tool Stream into
    // a fresh collapsible turn group.
    if (Cmd == TEXT("ui_tool_stream_new_turn"))
    {
        HaybaThreading::ExecuteOnGameThread([]()
        {
            if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
            {
                if (TSharedPtr<SHaybaMCPToolStreamPanel> Panel = M->ToolStreamPanel.Pin())
                {
                    Panel->BeginNewTurn();
                }
            }
        });
        auto Data = MakeShared<FJsonObject>();
        Data->SetBoolField(TEXT("received"), true);
        return MakeOkResponse(Id, Data);
    }

    // Special-case: ui_tool_stream lets the Node MCP side mirror its own
    // tool-call lifecycle into the UE Tool Stream panel. PCGEx catalog tools
    // and other TS-only handlers don't route through the UE command dispatch,
    // so without this they'd be invisible. Fire-and-forget: just record and
    // ack.
    if (Cmd == TEXT("ui_tool_stream"))
    {
        FString TName, PStr, RStr;
        Params->TryGetStringField(TEXT("tool"), TName);
        Params->TryGetStringField(TEXT("params"), PStr);
        Params->TryGetStringField(TEXT("result"), RStr);
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            M->RecordToolCall(TName, PStr, RStr);
            HaybaThreading::ExecuteOnGameThread([TName, PStr, RStr]()
            {
                if (FHaybaMCPModule* Mod = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
                {
                    if (TSharedPtr<SHaybaMCPToolStreamPanel> Panel = Mod->ToolStreamPanel.Pin())
                    {
                        Panel->AddToolCall(TName, PStr, RStr);
                    }
                }
            });
        }
        auto Data = MakeShared<FJsonObject>();
        Data->SetBoolField(TEXT("received"), true);
        return MakeOkResponse(Id, Data);
    }

    // Plan Mode safety gate: destructive commands require an approved plan.
    {
        auto& S = FHaybaMCPSettings::Get();
        if (S.bPlanModeEnabled && IsDestructiveCommand(Cmd))
        {
            FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit");
            const bool bApproved = (M && M->bPlanApproved);
            if (!bApproved)
            {
                auto Data = MakeShared<FJsonObject>();
                Data->SetStringField(TEXT("status"), TEXT("plan_mode_required"));
                Data->SetStringField(TEXT("hint"), TEXT("Plan Mode is ON. Call hayba_propose_plan with a steps[] array, then the user must click Approve in the Plan tab before destructive commands run."));
                return MakeOkResponse(Id, Data);
            }
            // Consume the approval: subsequent destructive calls need a fresh plan.
            // Comment out the next line if you want approval to persist across
            // a multi-step destructive sequence.
            // M->bPlanApproved = false;
        }
        S.PlanModeToolCallCount++;
        S.Save();
        MaybeShowPlanModePrompt();
    }

    // get_setting: allowlisted read of UHaybaMCPDeveloperSettings fields so
    // the Node MCP server can pick up tokens (e.g. SketchfabApiToken) the user
    // entered in Project Settings → Plugins → Hayba MCP Toolkit, without env vars.
    if (Cmd == TEXT("get_setting"))
    {
        FString Key;
        if (!Params.IsValid() || !Params->TryGetStringField(TEXT("key"), Key))
        {
            return MakeErrorResponse(Id, TEXT("get_setting requires { key: string }"));
        }
        static const TSet<FString> Allow = { TEXT("sketchfab_api_token") };
        if (!Allow.Contains(Key))
        {
            return MakeErrorResponse(Id,
                FString::Printf(TEXT("Setting '%s' is not exposed via get_setting"), *Key));
        }
        const UHaybaMCPDeveloperSettings* DS = GetDefault<UHaybaMCPDeveloperSettings>();
        FString Value;
        if (Key == TEXT("sketchfab_api_token")) Value = DS->SketchfabApiToken;
        TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
        Data->SetStringField(TEXT("key"), Key);
        if (Value.IsEmpty())
        {
            Data->SetField(TEXT("value"), MakeShared<FJsonValueNull>());
            Data->SetBoolField(TEXT("set"), false);
        }
        else
        {
            Data->SetStringField(TEXT("value"), Value);
            Data->SetBoolField(TEXT("set"), true);
        }
        return MakeOkResponse(Id, Data);
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

    // Capture actor before-state for destructive ops so the Diff panel shows true Before -> After.
    const TMap<FString, FString> BeforeState = CaptureBeforeState(Cmd, Params);

    // Initiative #1: wrap every destructive op in a native editor transaction
    // so the user can revert AI mutations with Ctrl+Z. Read-only commands
    // skip this for zero overhead.
    const bool bDestructive = IsDestructiveCommand(Cmd);
    if (bDestructive && GEditor)
    {
        const FText TxText = FText::FromString(FString::Printf(TEXT("Hayba: %s"), *Cmd));
        GEditor->BeginTransaction(TxText);
    }

    const double Start = FPlatformTime::Seconds();
    FHaybaHandlerResult Result = (*Found)->Handle(Cmd, Params);
    const int64 DurMs = (int64)((FPlatformTime::Seconds() - Start) * 1000.0);

    if (bDestructive && GEditor)
    {
        // Cancel the transaction if the handler reported failure — leaves no
        // empty undo entry. Otherwise end normally so Ctrl+Z reverts the op.
        if (Result.bOk) GEditor->EndTransaction();
        else            GEditor->CancelTransaction(0);
    }

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
    // Log destructive ops to the Diff panel with true Before / requested After.
    if (Result.bOk)
    {
        PushDiffEntries(Cmd, Params, BeforeState);
    }

    // Push to Tool Stream — first into the module-level history buffer (which
    // survives panel teardown), then into the live panel widget if one is
    // currently mounted. The buffer is the source of truth; the panel just
    // mirrors it.
    {
        const FString ParamsStr = JsonToString(Params.ToSharedRef());
        FString ResultStr;
        if (Result.bOk && Result.Data.IsValid()) ResultStr = JsonToString(Result.Data.ToSharedRef());
        else if (!Result.bOk) ResultStr = FString::Printf(TEXT("ERROR: %s"), *Result.ErrorMessage);

        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            M->RecordToolCall(Cmd, ParamsStr, ResultStr);
        }

        HaybaThreading::ExecuteOnGameThread([Cmd, ParamsStr, ResultStr]()
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
