#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPGameThread.h"
#include "IHaybaMCPHandler.h"
#include "HaybaMCPSeh.h"
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
#include "Editor.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "Modules/ModuleManager.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPCmd, Log, All);

static bool IsDestructiveCommand(const FString& Cmd)
{
    // Plan-Mode gate coverage. Audited (2026-07-04) against every mutating
    // command in legacy-commands/sidecar.json AND the TS NON_IDEMPOTENT set in
    // tools/tool-executor.ts. Rule: gate anything that creates / adds / sets /
    // deletes / removes / duplicates / imports / renames scene or asset state,
    // plus the two wildcard-invocation escape hatches (actor_call_function,
    // editor_run_console_command) and arbitrary code exec (python_run). Pure
    // reads (get/list/info/search/validate/export/focus/ping) are NOT gated.
    //
    // Prior bugs this fixes: (1) "editor_execute_console" was a non-existent
    // name — the real command is "editor_run_console_command", so console exec
    // silently bypassed the gate (same class as the old python_exec typo).
    // (2) actor_batch_spawn (live-testing finding) spawned actors with no plan
    // approval while actor_delete WAS gated.
    //
    // NB: many TS-only tools reach C++ as "python_run" (already gated) so their
    // own names never hit ProcessCommand; they are listed anyway so a direct
    // hayba_invoke of a registered handler is still covered and intent is clear.
    //
    // ENFORCED (2026-07-29): this set must contain every command in the TS
    // NON_IDEMPOTENT set — a command whose double-execution has real
    // side-effects is by definition state-changing, so it must also require an
    // approved plan. `plan-mode-gate.test.ts` parses both lists and fails on
    // drift. That audit found 26 commands added to NON_IDEMPOTENT over time and
    // never mirrored here; they are now present. Both of this gate's earlier
    // bugs were drift of exactly this kind, which is why it is a test and not a
    // comment asking the next person to remember.
    static const TSet<FString> DestructiveCommands = {
        // Arbitrary code / wildcard invocation
        TEXT("python_run"),
        TEXT("actor_call_function"),
        TEXT("editor_run_console_command"),
        // Actor lifecycle + mutation
        TEXT("actor_spawn"),
        TEXT("actor_delete"),
        TEXT("actor_duplicate"),
        TEXT("actor_batch_spawn"),
        TEXT("actor_spawn_from_asset"),
        TEXT("actor_set_properties"),
        TEXT("actor_set_visibility"),
        TEXT("actor_snap_to_socket"),
        TEXT("actor_tag"),
        // Object reflection write
        TEXT("object_set_property"),
        // Asset lifecycle
        TEXT("asset_import"),
        TEXT("asset_duplicate"),
        TEXT("asset_delete"),
        TEXT("asset_rename"),
        // Blueprint authoring
        TEXT("blueprint_create"),
        TEXT("blueprint_add_component"),
        TEXT("blueprint_add_variable"),
        TEXT("blueprint_set_defaults"),
        // Material authoring
        TEXT("material_create"),
        TEXT("material_create_instance"),
        TEXT("material_add_node"),
        TEXT("material_add_comment"),
        TEXT("material_add_reroute_declaration"),
        TEXT("material_add_reroute_usage"),
        TEXT("material_connect_nodes"),
        // PCG (both legacy alias + namespaced form)
        TEXT("create_graph"),
        TEXT("pcg_create_graph"),
        TEXT("execute_graph"),
        TEXT("pcg_execute_graph"),
        TEXT("pcg_add_node"),
        TEXT("pcg_wire"),
        // Landscape (legacy alias + namespaced form)
        TEXT("landscape_import"),
        TEXT("import_landscape"),
        // ISM
        TEXT("ism_create_actor"),
        TEXT("ism_add_instance"),
        TEXT("ism_add_instances"),
        TEXT("ism_clear_instances"),
        // Foliage
        TEXT("foliage_remove_instances"),
        // Spline
        TEXT("spline_create"),
        TEXT("spline_add_point"),
        TEXT("spline_set_point"),
        TEXT("spline_remove_point"),
        // Level / Data authoring
        TEXT("level_create"),
        TEXT("data_create"),
        TEXT("data_set"),
        // Sequencer / Niagara / MetaSound / GAS / UI / Input authoring
        TEXT("seq_create"),
        TEXT("niagara_spawn"),
        TEXT("metasound_create"),
        TEXT("gas_create_ability"),
        TEXT("gas_create_effect"),
        TEXT("ui_create_widget"),
        TEXT("ui_set_widget_properties"),
        TEXT("ui_mutate_tree"),
        TEXT("ui_save_widget"),
        TEXT("input_create_action"),
        TEXT("input_create_mapping"),
        // Asset move — moves FROM a path, so it is as consequential as rename.
        TEXT("asset_move"),
        // Landscape layer authoring
        TEXT("landscape_add_layer"),
        // PCG graph-edit destructive family
        TEXT("pcg_remove_node"),
        TEXT("pcg_disconnect"),
        // Foliage factory tools
        TEXT("foliage_type_create"),
        TEXT("foliage_add_instances"),
        TEXT("foliage_scatter_paint"),
        TEXT("foliage_remove_in_bounds"),
        TEXT("foliage_clear_type"),
        // Lighting factory tools
        TEXT("light_spawn"),
        TEXT("postprocess_spawn_volume"),
        TEXT("sky_setup"),
        // Sequencer factory tools
        TEXT("seq_new"),
        TEXT("seq_bind_actor"),
        TEXT("seq_track_add"),
        TEXT("seq_transform_keyframe"),
        TEXT("seq_camera_cut"),
        // Niagara factory tools
        TEXT("niagara_spawn_transient"),
        TEXT("niagara_place_actor"),
        TEXT("niagara_create_from_template"),
        TEXT("niagara_advance_simulation"),
        // Water factory tools
        TEXT("water_body_ocean_create"),
        TEXT("water_body_lake_create"),
        TEXT("water_body_river_create"),
        TEXT("water_zone_create"),
        // UI authoring
        TEXT("ui_compile_widget"),
        // Memory
        TEXT("memory_clear"),
        // Credential mutation — writing/clearing an API key is as consequential
        // as memory_clear. (copilot_get_key is a read → NOT gated here; it is
        // separately fail-closed on capability-token config below.)
        TEXT("copilot_key_set"),
        TEXT("copilot_key_clear"),
    };
    return DestructiveCommands.Contains(Cmd);
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

/** Push findings produced OUTSIDE the editor into the Validation panel.
 *  The panel is push-only from in here, so MCP-side validators (ui_validate
 *  and anything else that judges a snapshot rather than the live world) have
 *  no other way to surface. Without this their findings only ever exist in a
 *  tool response the user never opens.
 *
 *  Params: { findings: [{ rule_id, severity, message, hint?, widget? }],
 *            append?: bool }  — append keeps earlier findings on screen. */
static void PushExternalFindingsToPanel(const TSharedPtr<FJsonObject>& Data)
{
    if (!Data.IsValid()) return;

    TArray<FHaybaValidationIssue> Issues;
    const TArray<TSharedPtr<FJsonValue>>* FindingsArr = nullptr;
    if (Data->TryGetArrayField(TEXT("findings"), FindingsArr) && FindingsArr)
    {
        for (const auto& V : *FindingsArr)
        {
            const TSharedPtr<FJsonObject> F = V->AsObject();
            if (!F.IsValid()) continue;

            FHaybaValidationIssue I;
            F->TryGetStringField(TEXT("rule_id"), I.IssueType);
            F->TryGetStringField(TEXT("widget"), I.ActorLabel);

            FString Message, Hint;
            F->TryGetStringField(TEXT("message"), Message);
            F->TryGetStringField(TEXT("hint"), Hint);
            // The hint is the actionable half of a finding; keeping it out of
            // the panel would strip the part that says what to actually do.
            I.Description = Hint.IsEmpty() ? Message : FString::Printf(TEXT("%s — %s"), *Message, *Hint);

            FString Severity;
            F->TryGetStringField(TEXT("severity"), Severity);
            if (Severity.Equals(TEXT("error"), ESearchCase::IgnoreCase))        I.Severity = EHaybaSeverity::Error;
            else if (Severity.Equals(TEXT("warning"), ESearchCase::IgnoreCase)) I.Severity = EHaybaSeverity::Warning;
            else                                                                I.Severity = EHaybaSeverity::Info;

            Issues.Add(MoveTemp(I));
        }
    }

    bool bAppend = false;
    Data->TryGetBoolField(TEXT("append"), bAppend);

    AsyncTask(ENamedThreads::GameThread, [Issues = MoveTemp(Issues), bAppend]()
    {
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPValidationPanel> Panel = M->ValidationPanel.Pin())
            {
                if (!bAppend) Panel->Clear();
                for (const auto& I : Issues) Panel->AddIssue(I);
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
    // The Semantic Library now reads the PLUMB stores directly; a memory_query
    // just asks it to refresh from disk on the game thread.
    AsyncTask(ENamedThreads::GameThread, []()
    {
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPMemoryPanel> Panel = M->MemoryPanel.Pin())
            {
                Panel->RefreshLibrary();
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

    // ProcessCommand (hence this) already executes on the game thread, so the
    // seam runs the snapshot INLINE — no AsyncTask, no FEvent. The old
    // AsyncTask(GameThread)+Wait(2s) self-deadlocked (the queued task could
    // never run while this blocked), always timed out after 2s, and — capturing
    // &Before by reference — risked a use-after-free (#283/#284) when the late
    // task wrote into the already-unwound frame.
    //
    // Capture-safety: the work lambda OWNS its result map (`Snapshot`) and the
    // seam returns it BY VALUE. Nothing captures the caller's local by
    // reference, so even on the (never-taken under the current dispatch model)
    // off-game-thread timeout path — where the seam keeps the work alive in
    // shared state past this frame — there is no &-ref to a destroyed TMap and
    // no pooled FEvent touched after return.
    Before = HaybaGameThread::RunSync<TMap<FString, FString>>(
        [ActorId, PropertyName, bWantTransform, bWantTags, bWantProperty, bWantDelete]() -> TMap<FString, FString>
    {
        TMap<FString, FString> Snapshot;
        if (AActor* Actor = FindActorByLabel_GameThread(ActorId))
        {
            if (bWantDelete)
            {
                Snapshot.Add(TEXT("exists"), TEXT("true"));
            }
            if (bWantTransform)
            {
                const FVector L  = Actor->GetActorLocation();
                const FRotator R = Actor->GetActorRotation();
                const FVector S  = Actor->GetActorScale3D();
                Snapshot.Add(TEXT("location"), FString::Printf(TEXT("(%.1f, %.1f, %.1f)"), L.X, L.Y, L.Z));
                Snapshot.Add(TEXT("rotation"), FString::Printf(TEXT("(p=%.1f y=%.1f r=%.1f)"), R.Pitch, R.Yaw, R.Roll));
                Snapshot.Add(TEXT("scale"),    FString::Printf(TEXT("(%.2f, %.2f, %.2f)"), S.X, S.Y, S.Z));
            }
            if (bWantTags)
            {
                FString Joined;
                for (const FName& T : Actor->Tags) Joined += (Joined.IsEmpty() ? TEXT("") : TEXT(", ")) + T.ToString();
                Snapshot.Add(TEXT("tags"), Joined.IsEmpty() ? TEXT("(none)") : Joined);
            }
            if (bWantProperty && !PropertyName.IsEmpty())
            {
                if (FProperty* Prop = Actor->GetClass()->FindPropertyByName(*PropertyName))
                {
                    FString Out;
                    Prop->ExportText_InContainer(0, Out, Actor, Actor, Actor, PPF_None);
                    Snapshot.Add(PropertyName, Out);
                }
                else
                {
                    Snapshot.Add(PropertyName, TEXT("(no such property)"));
                }
            }
        }
        else
        {
            Snapshot.Add(TEXT("__missing__"), TEXT("(actor not found)"));
        }
        return Snapshot;
    }, /*TimeoutSeconds=*/2.0, /*TimeoutValue=*/TMap<FString, FString>());
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

void FHaybaMCPCommandHandler::UnregisterHandler(const TSharedRef<IHaybaMCPHandler>& Handler)
{
    for (const FString& Cmd : Handler->GetCommands())
    {
        if (const TSharedRef<IHaybaMCPHandler>* Found = CommandToHandler.Find(Cmd))
        {
            if (*Found == Handler) CommandToHandler.Remove(Cmd);
        }
    }
    Handlers.Remove(Handler);
    UE_LOG(LogHaybaMCPCmd, Log, TEXT("Unregistered handler '%s'"), *Handler->GetDomain());
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
        AsyncTask(ENamedThreads::GameThread, []()
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
            AsyncTask(ENamedThreads::GameThread, [TName, PStr, RStr]()
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

    // ── copilot_* BYOK key-vault proxy ──────────────────────────────────────
    // The TS copilot tools (copilot_key_*) and the local chat sidecar reach the
    // DPAPI key vault (FHaybaMCPSettings) ONLY through these four commands. They
    // have already cleared the capability-token auth gate above, and the TCP
    // listener is bound to 127.0.0.1 only (HaybaMCPTcpServer.cpp:51). Key
    // material stays on the local machine SO LONG AS the bind remains loopback
    // AND — for copilot_get_key specifically — a capability token is configured:
    // that command fails CLOSED (below) and refuses to return a decrypted key
    // when auth is unconfigured, even though the rest of the surface fails open.
    // copilot_get_key is the ONLY command that returns a plaintext key; nothing
    // here is written to the journal or a UE_LOG (the generic dispatch logger
    // only records cmd+id, never params).
    if (Cmd == TEXT("copilot_key_status"))
    {
        auto Emit = [](const FString& ProviderId) -> TSharedPtr<FJsonObject>
        {
            auto O = MakeShared<FJsonObject>();
            O->SetStringField(TEXT("provider"), ProviderId);
            const FString Last4 = FHaybaMCPSettings::GetProviderKeyLast4(ProviderId);
            O->SetBoolField(TEXT("configured"), !Last4.IsEmpty());
            if (Last4.IsEmpty()) O->SetField(TEXT("last4"), MakeShared<FJsonValueNull>());
            else                 O->SetStringField(TEXT("last4"), Last4);
            return O;
        };
        FString Provider;
        Params->TryGetStringField(TEXT("provider"), Provider);
        if (!Provider.IsEmpty())
        {
            return MakeOkResponse(Id, Emit(Provider));
        }
        // No provider given → report the whole catalog.
        auto Data = MakeShared<FJsonObject>();
        TArray<TSharedPtr<FJsonValue>> Arr;
        for (const FHaybaProviderInfo& P : FHaybaMCPSettings::GetProviderCatalog())
            Arr.Add(MakeShared<FJsonValueObject>(Emit(FString(P.Id))));
        Data->SetArrayField(TEXT("providers"), Arr);
        return MakeOkResponse(Id, Data);
    }

    if (Cmd == TEXT("copilot_get_key"))
    {
        // FAIL CLOSED: this is the only command that returns a plaintext key.
        // ValidateRequest fails OPEN when no capability token is configured
        // (usability default), which would let any local process read the
        // decrypted key unauthenticated. Refuse unless auth is actually
        // configured — regardless of the global fail-open posture.
        if (!FHaybaMCPSecurityManager::Get().IsAuthConfigured())
        {
            return MakeErrorResponse(Id, TEXT("copilot_get_key requires a configured capability token (set one in Hayba settings); refusing to return a decrypted key without authentication"));
        }
        FString Provider;
        Params->TryGetStringField(TEXT("provider"), Provider);
        if (Provider.IsEmpty()) Provider = FHaybaMCPSettings::Get().SelectedProviderId;
        const FString Key = FHaybaMCPSettings::GetProviderKey(Provider);
        auto Data = MakeShared<FJsonObject>();
        Data->SetStringField(TEXT("provider"), Provider);
        Data->SetBoolField(TEXT("set"), !Key.IsEmpty());
        if (Key.IsEmpty()) Data->SetField(TEXT("key"), MakeShared<FJsonValueNull>());
        else               Data->SetStringField(TEXT("key"), Key);
        return MakeOkResponse(Id, Data);
    }

    if (Cmd == TEXT("copilot_key_set"))
    {
        FString Provider, Key;
        Params->TryGetStringField(TEXT("provider"), Provider);
        Params->TryGetStringField(TEXT("api_key"), Key);
        if (Provider.IsEmpty()) return MakeErrorResponse(Id, TEXT("copilot_key_set requires { provider, api_key }"));
        if (Key.IsEmpty())      return MakeErrorResponse(Id, TEXT("copilot_key_set requires a non-empty api_key"));
        FHaybaMCPSettings::SetProviderKey(Provider, Key);
        auto Data = MakeShared<FJsonObject>();
        Data->SetStringField(TEXT("provider"), Provider);
        Data->SetBoolField(TEXT("ok"), true);
        // Echo the masked last-4 only — never the raw key.
        Data->SetStringField(TEXT("key_last4"), FHaybaMCPSettings::GetProviderKeyLast4(Provider));
        return MakeOkResponse(Id, Data);
    }

    if (Cmd == TEXT("copilot_key_clear"))
    {
        FString Provider;
        Params->TryGetStringField(TEXT("provider"), Provider);
        if (Provider.IsEmpty()) return MakeErrorResponse(Id, TEXT("copilot_key_clear requires { provider }"));
        const bool bHad = FHaybaMCPSettings::HasProviderKey(Provider);
        FHaybaMCPSettings::ClearProviderKey(Provider);
        auto Data = MakeShared<FJsonObject>();
        Data->SetStringField(TEXT("provider"), Provider);
        Data->SetBoolField(TEXT("ok"), true);
        Data->SetBoolField(TEXT("cleared"), bHad);
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
    //
    // Skipped entirely during an active PIE session: the global transaction
    // buffer (GEditor->Trans) can end up retaining a reference into the PIE
    // world/GameInstance, which crashes the editor on PIE stop with
    // "Object 'GameInstance ...' from PIE level still referenced". AI-driven
    // edits made mid-PIE don't need undo support badly enough to risk that.
    const bool bDestructive = IsDestructiveCommand(Cmd);
    const bool bInPIE = GEditor && GEditor->PlayWorld != nullptr;
    if (bDestructive && GEditor && !bInPIE)
    {
        const FText TxText = FText::FromString(FString::Printf(TEXT("Hayba: %s"), *Cmd));
        GEditor->BeginTransaction(TxText);
    }

    const double Start = FPlatformTime::Seconds();

    // SEH-guard the handler-dispatch seam so a NATIVE structured exception
    // (access violation, etc.) inside ANY of the registered handlers is converted
    // into a recoverable error envelope instead of taking down the whole editor.
    // Previously only the python and material handlers self-guarded their
    // crash-prone calls (ExecPythonGuarded / HaybaSeh::RunGuarded), leaving the
    // other ~31 handlers unrecoverable; wrapping this single dispatch point makes
    // the entire handler surface recoverable in one place. Those per-handler
    // guards are KEPT (a caught fault there yields a clean FHaybaHandlerResult, so
    // this outer guard never sees it — no double-fault, no behaviour change).
    //
    // The thunk MUST be a captureless lambda (-> function pointer) and the result
    // is written back through a pointer in the context struct, because MSVC forbids
    // C++ object unwinding across __try (C2712) — RunGuarded isolates the __try in
    // its own translation unit and only ever invokes a function pointer. Mirrors
    // the FStatsCtx usage in HaybaMCPMaterialHandler.cpp.
    FHaybaHandlerResult Result;
    {
        struct FDispatchCtx
        {
            IHaybaMCPHandler* Handler;
            const FString* Cmd;
            const TSharedPtr<FJsonObject>* Params;
            FHaybaHandlerResult* Out;
        } Ctx{ &Found->Get(), &Cmd, &Params, &Result };

        bool bHandlerCrashed = false;
        HaybaSeh::RunGuarded(+[](void* P)
        {
            FDispatchCtx* C = static_cast<FDispatchCtx*>(P);
            *C->Out = C->Handler->Handle(*C->Cmd, *C->Params);
        }, &Ctx, bHandlerCrashed);

        if (bHandlerCrashed)
        {
            UE_LOG(LogHaybaMCPCmd, Error,
                TEXT("SEH guard caught a structured exception in handler for command '%s' (id: %s) — editor kept alive"),
                *Cmd, *Id);
            Result = FHaybaHandlerResult::Err(FString::Printf(
                TEXT("handler crashed (SEH): command '%s' faulted with a structured exception ")
                TEXT("(e.g. a null/stale UObject in the handler, or a stale Python-registered editor delegate ")
                TEXT("firing on a GC'd target). The editor was kept alive by the SEH guard and the operation ")
                TEXT("did NOT complete."),
                *Cmd));
        }
    }

    const int64 DurMs = (int64)((FPlatformTime::Seconds() - Start) * 1000.0);

    if (bDestructive && GEditor && !bInPIE)
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
        // ui_report_findings carries its payload in the REQUEST, not the
        // response, because the findings were judged MCP-side.
        else if (Cmd == TEXT("ui_report_findings"))      PushExternalFindingsToPanel(Params);
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
        if (Cmd == TEXT("python_run"))
        {
            // python_run's stdout carries the HAYBA_JSON result line for every
            // python-factory tool; the 512-char cap clipped it mid-JSON
            // ("Unterminated string at position 501" — live-battery finding,
            // broke actor_find/object_inspect/outliner_tree/reflect_class).
            // The TS layer already spills >12k outputs to a temp file, so a
            // 64K ceiling here is ample and still bounds the frame size.
            Limits.MaxStringChars = 64 * 1024;
            Limits.MaxArrayItems = 200;
        }
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
