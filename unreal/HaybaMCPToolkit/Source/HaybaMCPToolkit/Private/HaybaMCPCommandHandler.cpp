#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPGameThread.h"
#include "IHaybaMCPHandler.h"
#include "HaybaMCPSeh.h"
#include "HaybaMCPSecurityManager.h"
#include "HaybaMCPResponseBuilder.h"
#include "HaybaMCPAdvisory.h"
#include "HaybaMCPSecretRedaction.h"
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

static bool IsDestructiveCommand(const FString& Cmd);

namespace
{
    constexpr int32 MaxPromotedFailureChars = 4096;

    FString BoundFailureDiagnostic(const FString& Input)
    {
        FString Diagnostic = Input;
        Diagnostic.TrimStartAndEndInline();
        if (Diagnostic.IsEmpty()) return FString();
        return HaybaMCPSecretRedaction::RedactTextForLog(
            Diagnostic,
            MaxPromotedFailureChars);
    }

    FString LogicalFailureDiagnostic(const TSharedPtr<FJsonObject>& Data)
    {
        if (Data.IsValid())
        {
            FString Diagnostic;
            if (Data->TryGetStringField(TEXT("error"), Diagnostic))
            {
                Diagnostic = BoundFailureDiagnostic(Diagnostic);
                if (!Diagnostic.IsEmpty()) return Diagnostic;
            }

            const TArray<TSharedPtr<FJsonValue>>* Errors = nullptr;
            if (Data->TryGetArrayField(TEXT("errors"), Errors) && Errors)
            {
                FString Joined;
                for (const TSharedPtr<FJsonValue>& Value : *Errors)
                {
                    FString Item;
                    if (!Value.IsValid() || !Value->TryGetString(Item)) continue;
                    Item.TrimStartAndEndInline();
                    if (Item.IsEmpty()) continue;
                    if (!Joined.IsEmpty()) Joined += TEXT("; ");
                    const int32 Remaining = MaxPromotedFailureChars - Joined.Len();
                    if (Remaining <= 0) break;
                    Joined += Item.Left(Remaining);
                }
                Joined = BoundFailureDiagnostic(Joined);
                if (!Joined.IsEmpty()) return Joined;
            }

            if (Data->TryGetStringField(TEXT("stderr"), Diagnostic))
            {
                Diagnostic = BoundFailureDiagnostic(Diagnostic);
                if (!Diagnostic.IsEmpty()) return Diagnostic;
            }
        }

        return TEXT("The handler reported a logical failure without a diagnostic; the operation's final state is unknown.");
    }

    void CopyStringGuidanceField(
        const TSharedPtr<FJsonObject>& Data,
        const TCHAR* Singular,
        const TCHAR* Plural,
        TArray<FString>& Out)
    {
        if (!Data.IsValid()) return;
        FString One;
        if (Data->TryGetStringField(Singular, One) && !One.IsEmpty()) Out.AddUnique(One);
        const TArray<TSharedPtr<FJsonValue>>* Many = nullptr;
        if (Data->TryGetArrayField(Plural, Many) && Many)
        {
            for (const TSharedPtr<FJsonValue>& Value : *Many)
            {
                FString Text;
                if (Value.IsValid() && Value->TryGetString(Text) && !Text.IsEmpty()) Out.AddUnique(Text);
            }
        }
    }

    FHaybaMCPAdvisorySignals SignalsForSuccess(
        const FString& Operation,
        const TSharedPtr<FJsonObject>& Data)
    {
        FHaybaMCPAdvisorySignals Signals;
        Signals.Operation = Operation;
        Signals.Phase = EHaybaMCPCommandPhase::Verify;
        Signals.bOperationSucceeded = true;

        if (!Data.IsValid()) return Signals;

        double Succeeded = 0.0;
        double Failed = 0.0;
        if (Data->TryGetNumberField(TEXT("succeeded"), Succeeded)
            && FMath::IsFinite(Succeeded) && Succeeded >= 0.0)
        {
            Signals.SucceededCount = FMath::Clamp(
                static_cast<int32>(FMath::Min(Succeeded, static_cast<double>(MAX_int32))), 0, MAX_int32);
        }
        if (Data->TryGetNumberField(TEXT("failed"), Failed)
            && FMath::IsFinite(Failed) && Failed >= 0.0)
        {
            Signals.FailedCount = FMath::Clamp(
                static_cast<int32>(FMath::Min(Failed, static_cast<double>(MAX_int32))), 0, MAX_int32);
        }
        if (Signals.FailedCount > 0)
        {
            if (Signals.SucceededCount > 0)
            {
                Signals.MutationStatus = EHaybaMCPMutationStatus::PartiallyApplied;
            }
            else
            {
                // An all-rejected batch is not a successful partial mutation.
                // Several legacy handlers historically returned ok:true with
                // succeeded:0, which teaches an agent the exact opposite of
                // what happened.
                Signals.bOperationSucceeded = false;
                Signals.FailureKind = EHaybaMCPFailureKind::InputRejected;
                Signals.Code = TEXT("all_items_rejected");
                Signals.Error = TEXT("Every requested item was rejected; no item was applied.");
                Signals.MutationStatus = EHaybaMCPMutationStatus::NotStarted;
            }
        }
        else if (Signals.SucceededCount > 0)
        {
            Signals.MutationStatus = EHaybaMCPMutationStatus::Applied;
        }

        bool bSaved = true;
        if (Data->HasField(TEXT("saved")) && Data->TryGetBoolField(TEXT("saved"), bSaved))
        {
            Signals.bSaveAttempted = true;
            Signals.bSaveSucceeded = bSaved;
            if (!bSaved) Signals.MutationStatus = EHaybaMCPMutationStatus::AppliedUnsaved;
        }

        bool bDirty = false;
        if (Data->TryGetBoolField(TEXT("dirty"), bDirty) && bDirty)
        {
            Signals.bDirtyAfterOperation = true;
        }
        double DirtyCount = 0.0;
        if (Data->TryGetNumberField(TEXT("dirty_count"), DirtyCount)
            && FMath::IsFinite(DirtyCount) && DirtyCount > 0.0)
        {
            Signals.bDirtyAfterOperation = true;
        }

        bool bCompiledClean = true;
        if (Data->HasField(TEXT("compiled_clean"))
            && Data->TryGetBoolField(TEXT("compiled_clean"), bCompiledClean))
        {
            Signals.bVerificationAttempted = true;
            Signals.bVerificationSucceeded = bCompiledClean;
            Signals.bNeedsVerification = !bCompiledClean;
            if (!bCompiledClean && Signals.Code.IsEmpty()) Signals.Code = TEXT("compile_not_clean");
        }

        // A handler can explicitly prove its readback/verification. Absent
        // that evidence, successful destructive commands stay honest:
        // success_needs_verification is optional guidance and therefore
        // disappears entirely for users who selected ErrorsOnly.
        bool bVerified = false;
        const bool bHasVerified = Data->TryGetBoolField(TEXT("verified"), bVerified)
            || Data->TryGetBoolField(TEXT("readback_verified"), bVerified);
        if (bHasVerified)
        {
            Signals.bVerificationAttempted = true;
            Signals.bVerificationSucceeded = bVerified;
            Signals.bNeedsVerification = !bVerified;
            if (!bVerified && Signals.Code.IsEmpty()) Signals.Code = TEXT("verification_failed");
        }
        else if (Signals.bOperationSucceeded && !Signals.bVerificationAttempted
            && IsDestructiveCommand(Operation))
        {
            Signals.bNeedsVerification = true;
            if (Signals.MutationStatus == EHaybaMCPMutationStatus::None)
            {
                Signals.MutationStatus = EHaybaMCPMutationStatus::Applied;
            }
        }

        // Some handlers return structured diagnostics even when their inner
        // operation failed. Preserve that data, but never infer success solely
        // because the native handler returned a data object. Promote the most
        // useful bounded diagnostic without assuming which handler produced it.
        bool bExplicitHandlerOk = true;
        if (Data->TryGetBoolField(TEXT("ok"), bExplicitHandlerOk) && !bExplicitHandlerOk)
        {
            Signals.bOperationSucceeded = false;
            Signals.FailureKind = EHaybaMCPFailureKind::UnknownOutcome;
            Signals.Code = TEXT("handler_reported_failure");
            Signals.Error = LogicalFailureDiagnostic(Data);
            Signals.MutationStatus = IsDestructiveCommand(Operation)
                ? EHaybaMCPMutationStatus::Unknown
                : EHaybaMCPMutationStatus::None;
        }

        FString Status;
        if (Data->TryGetStringField(TEXT("status"), Status)
            && Status.Equals(TEXT("plan_mode_required"), ESearchCase::IgnoreCase))
        {
            Signals.bOperationSucceeded = false;
            Signals.FailureKind = EHaybaMCPFailureKind::PolicyBlocked;
            Signals.Code = TEXT("plan_mode_required");
            Signals.Error = TEXT("The command requires an approved plan before execution.");
            Signals.MutationStatus = EHaybaMCPMutationStatus::NotStarted;
        }

        CopyStringGuidanceField(Data, TEXT("warning"), TEXT("warnings"), Signals.Warnings);
        CopyStringGuidanceField(Data, TEXT("tip"), TEXT("tips"), Signals.Tips);
        CopyStringGuidanceField(Data, TEXT("hint"), TEXT("hints"), Signals.Tips);
        return Signals;
    }

    FHaybaMCPAdvisorySignals SignalsForError(
        const FString& Operation,
        const FString& Error,
        bool bSessionSuspect,
        bool bKnownPreflight)
    {
        FHaybaMCPAdvisorySignals Signals;
        Signals.Operation = Operation;
        Signals.bOperationSucceeded = false;
        Signals.Error = Error;
        Signals.Phase = bKnownPreflight
            ? EHaybaMCPCommandPhase::Preflight
            : EHaybaMCPCommandPhase::Execute;
        Signals.MutationStatus = bKnownPreflight
            ? EHaybaMCPMutationStatus::NotStarted
            : EHaybaMCPMutationStatus::Unknown;

        const FString Lower = Error.ToLower();
        if (bSessionSuspect || Lower.Contains(TEXT("structured exception"))
            || Lower.Contains(TEXT("session as suspect")) || Lower.Contains(TEXT("seh")))
        {
            Signals.bStructuredException = true;
            Signals.FailureKind = EHaybaMCPFailureKind::SessionSuspect;
            Signals.Code = TEXT("structured_exception");
            Signals.Phase = EHaybaMCPCommandPhase::Execute;
            Signals.MutationStatus = EHaybaMCPMutationStatus::Unknown;
        }
        else if (Lower.Contains(TEXT("hcr-")) || (bKnownPreflight && (
            Lower.Contains(TEXT("policy_blocked")) || Lower.Contains(TEXT("blocked permanently"))
            || Lower.Contains(TEXT("not permitted")) || Lower.Contains(TEXT("forbidden"))
            || Lower.Contains(TEXT("approval")) || Lower.Contains(TEXT("plan mode"))
            || Lower.Contains(TEXT("unauthorized")) || Lower.Contains(TEXT("authentication")))))
        {
            Signals.bCrashGuardRejected = Lower.Contains(TEXT("hcr-"))
                || Lower.Contains(TEXT("crash")) || Lower.Contains(TEXT("deadlock"));
            Signals.FailureKind = EHaybaMCPFailureKind::PolicyBlocked;
            Signals.Code = Signals.bCrashGuardRejected ? TEXT("crash_guard_blocked") : TEXT("policy_blocked");
            // Stable HCR codes are emitted only by guards that reject before
            // Execute. Generic handler prose is never allowed to make this
            // claim, but a named crash guard is an authoritative phase fact.
            Signals.Phase = EHaybaMCPCommandPhase::Preflight;
            Signals.MutationStatus = EHaybaMCPMutationStatus::NotStarted;
        }
        else if (bKnownPreflight && (Lower.Contains(TEXT("missing")) || Lower.Contains(TEXT("invalid"))
            || Lower.Contains(TEXT("required")) || Lower.Contains(TEXT("must be"))
            || Lower.Contains(TEXT("not found")) || Lower.Contains(TEXT("unknown command"))
            || Lower.Contains(TEXT("out of range")) || Lower.Contains(TEXT("rejected"))))
        {
            Signals.FailureKind = EHaybaMCPFailureKind::InputRejected;
            Signals.Code = TEXT("invalid_request");
            Signals.bRetryUnchangedSafe = false;
        }
        else if (Lower.Contains(TEXT("timeout")) || Lower.Contains(TEXT("timed out"))
            || Lower.Contains(TEXT("disconnect")))
        {
            Signals.FailureKind = EHaybaMCPFailureKind::UnknownOutcome;
            Signals.Code = Lower.Contains(TEXT("disconnect")) ? TEXT("disconnected") : TEXT("timeout");
            Signals.Phase = EHaybaMCPCommandPhase::Execute;
            Signals.MutationStatus = EHaybaMCPMutationStatus::Unknown;
        }
        else if (bKnownPreflight && (Lower.Contains(TEXT("busy")) || Lower.Contains(TEXT("not ready"))
            || Lower.Contains(TEXT("already running")) || Lower.Contains(TEXT("try again"))))
        {
            Signals.FailureKind = EHaybaMCPFailureKind::Retryable;
            Signals.Code = TEXT("temporarily_unavailable");
            Signals.bRetryUnchangedSafe = true;
        }
        else
        {
            // Legacy handlers do not yet expose phase/mutation facts. Do not
            // invent a clean retry or call every domain error fatal; state is
            // conservatively unknown until that handler adopts typed signals.
            Signals.FailureKind = EHaybaMCPFailureKind::UnknownOutcome;
            Signals.Code = TEXT("unclassified_handler_failure");
            Signals.Phase = EHaybaMCPCommandPhase::Execute;
            Signals.MutationStatus = EHaybaMCPMutationStatus::Unknown;
        }
        return Signals;
    }
}

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
        TEXT("editor_save_all_and_quit"),
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
        TEXT("blueprint_add_node"),
        TEXT("blueprint_connect_nodes"),
        TEXT("blueprint_set_pin_default"),
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
        // Audio asset/runtime authoring and capture
        TEXT("audio_asset_create"),
        TEXT("audio_asset_set"),
        TEXT("audio_asset_save"),
        TEXT("audio_component_play"),
        TEXT("audio_component_control"),
        TEXT("audio_meter_start"),
        TEXT("audio_meter_stop"),
        TEXT("audio_recording_start"),
        TEXT("audio_recording_stop"),
        // Sequencer / Niagara / MetaSound / GAS / UI / Input authoring
        TEXT("seq_create"),
        TEXT("niagara_spawn"),
        TEXT("metasound_create"),
        TEXT("metasound_add_node"),
        TEXT("metasound_connect"),
        TEXT("metasound_set_input"),
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
    return FHaybaMCPCommandHandler::MakeOkResponse(Id, Data, TEXT("hayba_propose_plan"));
}

// Helper: serialize FJsonObject to compact string
static FString JsonToString(const TSharedRef<FJsonObject>& Obj)
{
    const TSharedPtr<FJsonObject> Safe = HaybaMCPSecretRedaction::RedactFinalEnvelope(Obj);
    FString Output;
    TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
    FJsonSerializer::Serialize(Safe.ToSharedRef(), Writer);
    return Output;
}

static FString ShapeOkResponse(
    const FString& Id,
    const TSharedPtr<FJsonObject>& Data,
    const FHaybaMCPAdvisorySignals& Signals)
{
    TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
    Response->SetStringField(TEXT("id"), Id);
    Response->SetBoolField(TEXT("ok"), Signals.bOperationSucceeded);
    if (!Signals.bOperationSucceeded && !Signals.Error.IsEmpty())
    {
        Response->SetStringField(TEXT("error"), Signals.Error);
    }
    Response->SetObjectField(TEXT("data"),
        Data.IsValid() ? Data.ToSharedRef() : MakeShared<FJsonObject>());
    HaybaMCPAdvisory::ApplyToResponse(
        Response,
        Signals,
        FHaybaMCPSettings::Get().AdvisoryVerbosity);
    return JsonToString(Response);
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

void FHaybaMCPCommandHandler::RebuildCommandMap()
{
    // Ask every live handler what it currently answers to. GetCommands() is
    // ordinary code, so Live Coding keeps it current even though the map built
    // from it at startup is not.
    const int32 Before = CommandToHandler.Num();
    CommandToHandler.Reset();
    for (const TSharedRef<IHaybaMCPHandler>& Handler : Handlers)
    {
        for (const FString& Cmd : Handler->GetCommands())
        {
            CommandToHandler.Add(Cmd, Handler);
        }
    }
    if (CommandToHandler.Num() != Before)
    {
        UE_LOG(LogHaybaMCPCmd, Log, TEXT("Command map rebuilt: %d -> %d commands"), Before, CommandToHandler.Num());
    }
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
        return MakeErrorResponse(TEXT(""), TEXT("Invalid JSON"), TEXT("protocol"), false, true);
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
            TEXT("Request rejected: 'id' field is required and must be non-empty"),
            Cmd.IsEmpty() ? FString(TEXT("protocol")) : Cmd, false, true);
    }

    if (Cmd.IsEmpty())
    {
        return MakeErrorResponse(Id,
            TEXT("Request rejected: 'cmd' field is required and must be non-empty"), TEXT("protocol"), false, true);
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
        return MakeErrorResponse(Id, AuthReason, Cmd, false, true);
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
        return MakeOkResponse(Id, Data, Cmd);
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
        return MakeOkResponse(Id, Data, Cmd);
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

        // This route is normally called by the Node mirror after its own final
        // redaction boundary, but it is also reachable over raw TCP.  Treating
        // the caller's strings as already safe let a direct client place a
        // credential in native Tool Stream history.  Redact the two dynamic
        // fields again at this native observability boundary; exact markers are
        // idempotent, so the ordinary Node path remains stable.
        TSharedPtr<FJsonObject> MirrorText = MakeShared<FJsonObject>();
        MirrorText->SetStringField(TEXT("params"), PStr);
        MirrorText->SetStringField(TEXT("result"), RStr);
        const HaybaMCPSecretRedaction::FResult SafeMirror =
            HaybaMCPSecretRedaction::Redact(MirrorText);
        if (!SafeMirror.Value.IsValid() ||
            !SafeMirror.Value->TryGetStringField(TEXT("params"), PStr) ||
            !SafeMirror.Value->TryGetStringField(TEXT("result"), RStr))
        {
            PStr = TEXT("[TRUNCATED:nodes]");
            RStr = TEXT("[TRUNCATED:nodes]");
        }
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
        return MakeOkResponse(Id, Data, Cmd);
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
                // Under strict consume the previous Approve was SPENT by the
                // last destructive command. Without saying so, the second call
                // in a sequence looks exactly like Approve never worked, and
                // the user clicks it again wondering what broke.
                Data->SetStringField(TEXT("approval_mode"),
                    S.bPlanApprovalStrictConsume ? TEXT("per_call_consume") : TEXT("per_plan_persist"));
                if (S.bPlanApprovalStrictConsume)
                {
                    Data->SetStringField(TEXT("approval_mode_note"),
                        TEXT("Strict consume is on: each Approve authorises exactly ONE destructive command, so an "
                             "earlier approval in this sequence has already been used. Set "
                             "bPlanApprovalStrictConsume=false in the Hayba settings for one Approve to cover a whole plan."));
                }
                return MakeOkResponse(Id, Data, Cmd);
            }
            // How long one Approve lasts is now a SETTING rather than a
            // commented-out line, because both answers are right for different
            // sessions and the choice was previously made by editing source.
            //
            // Default (false) keeps the existing per-plan behaviour: a plan
            // whose steps are "delete these six assets" must not stop dead
            // after the first one. Strict consume spends the approval on the
            // first destructive command, which is what an unattended agent
            // against content that matters wants.
            if (S.bPlanApprovalStrictConsume && M)
            {
                M->bPlanApproved = false;
            }
        }
        S.PlanModeToolCallCount++;
        S.Save();
        MaybeShowPlanModePrompt();
    }

    // get_setting and the copilot_* key-vault commands used to be written out
    // here, ahead of the registry lookup below. They now live in
    // FHaybaMCPVaultHandler and arrive through the same dispatch as everything
    // else, so GetRegisteredCommands() reports the surface the router actually
    // has.
    //
    // Still inline above, with reasons:
    //   hayba_propose_plan  — the Plan Mode gate's own control command; it has
    //                         to be answerable before the gate it feeds.
    //   ui_memory_set,
    //   ui_tool_stream,
    //   ui_tool_stream_new_turn
    //                       — editor-panel mirrors that call this file's
    //                         Push*ToPanel statics, which the post-dispatch
    //                         path below also uses. Moving them means moving
    //                         those, which is a separate change.

    auto* Found = CommandToHandler.Find(Cmd);
    if (!Found)
    {
        // The map is a CACHE derived from the handlers, not a snapshot of them.
        // It was built once at module load, so a command added to an existing
        // handler was unreachable until the editor restarted — Live Coding
        // patches GetCommands() but nothing rebuilt this map, and the caller
        // saw "Unknown command" for a command whose code was demonstrably
        // loaded. Rebuild from the live handlers and try once more before
        // declaring anything unknown.
        RebuildCommandMap();
        Found = CommandToHandler.Find(Cmd);
    }
    if (!Found)
    {
        FHaybaJournalEntry E{ FDateTime::UtcNow(), Cmd,
            FHaybaMCPSecurityManager::HashParams(Params), 0, false,
            TEXT("Unknown command") };
        FHaybaMCPSecurityManager::Get().Journal(E);
        // Naming the restart case matters: a command belonging to a handler
        // class that did not exist at startup has no instance to ask, so no
        // rebuild can find it and only a restart will.
        return MakeErrorResponse(Id, FString::Printf(
            TEXT("Unknown command: %s. If this command was just added to the plugin, its handler class may be new ")
            TEXT("since the editor started — Live Coding cannot register a handler that did not exist at module load, ")
            TEXT("so restart the editor."), *Cmd), Cmd, false, true);
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

    // Canonicalization allocates JSON writer state. Do it before entering an
    // SEH-guarded native handler: if that handler faults, continuing with
    // allocation-heavy post-processing is unsafe and previously turned a
    // caught handler fault into a second fatal access violation in HashParams.
    const FString ParamsHash = FHaybaMCPSecurityManager::HashParams(Params);
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
    bool bHandlerCrashed = false;
    {
        struct FDispatchCtx
        {
            IHaybaMCPHandler* Handler;
            const FString* Cmd;
            const TSharedPtr<FJsonObject>* Params;
            FHaybaHandlerResult* Out;
        } Ctx{ &Found->Get(), &Cmd, &Params, &Result };

        HaybaSeh::RunGuarded(+[](void* P)
        {
            FDispatchCtx* C = static_cast<FDispatchCtx*>(P);
            *C->Out = C->Handler->Handle(*C->Cmd, *C->Params);
        }, &Ctx, bHandlerCrashed);

        if (bHandlerCrashed)
        {
            UE_LOG(LogHaybaMCPCmd, Error,
                TEXT("SEH guard caught a structured exception in handler for command '%s' (id: %s) — skipping post-processing"),
                *Cmd, *Id);
            Result = FHaybaHandlerResult::Err(FString::Printf(
                TEXT("handler crashed (SEH): command '%s' faulted with a structured exception ")
                TEXT("(e.g. a null/stale UObject in the handler, or a stale Python-registered editor delegate ")
                TEXT("firing on a GC'd target). Post-processing was skipped and the operation did NOT complete. ")
                TEXT("Treat the editor session as suspect and restart it before mutating more state."),
                *Cmd));
        }
    }

    const int64 DurMs = (int64)((FPlatformTime::Seconds() - Start) * 1000.0);

    if (bHandlerCrashed)
    {
        // Never continue through transaction completion, diff capture, panel
        // dispatch, response trimming, or a second params serialization after
        // a native fault. The 2026-08-09 test_run incident proved that the old
        // "keep going" path could immediately double-fault in HashParams and
        // terminate UE despite the SEH guard's recovery claim.
        if (bDestructive && GEditor && !bInPIE)
        {
            GEditor->CancelTransaction(0);
        }
        FHaybaJournalEntry CrashEntry{
            FDateTime::UtcNow(), Cmd, ParamsHash, DurMs, false, Result.ErrorMessage };
        FHaybaMCPSecurityManager::Get().Journal(CrashEntry);
        return MakeErrorResponse(Id, Result.ErrorMessage, Cmd, /*bSessionSuspect=*/true);
    }

    // Classify the handler's complete typed result before ANY success-dependent
    // side effect. A native bOk=true is only transport-level success: handlers
    // can truthfully return diagnostics with data.ok=false, all-rejected counts,
    // or a policy status. Those logical failures must cancel the transaction and
    // be recorded consistently as failures everywhere, not merely be corrected
    // later while shaping the TCP envelope.
    const TSharedPtr<FJsonObject> DataObj =
        Result.Data.IsValid() ? Result.Data : MakeShared<FJsonObject>();
    FHaybaMCPAdvisorySignals SuccessSignals;
    if (Result.bOk)
    {
        SuccessSignals = SignalsForSuccess(Cmd, DataObj);
    }
    const bool bEffectiveOk = Result.bOk && SuccessSignals.bOperationSucceeded;
    const FString EffectiveError = BoundFailureDiagnostic(Result.bOk && !bEffectiveOk
        ? SuccessSignals.Error
        : Result.ErrorMessage);

    if (bDestructive && GEditor && !bInPIE)
    {
        // A nested logical failure is a failure here too: never commit an undo
        // record for an operation whose own result says it did not succeed.
        if (bEffectiveOk) GEditor->EndTransaction();
        else              GEditor->CancelTransaction(0);
    }

    // Journal the effective outcome, not merely the handler envelope flag.
    FHaybaJournalEntry E{ FDateTime::UtcNow(), Cmd,
        ParamsHash, DurMs, bEffectiveOk, EffectiveError };
    FHaybaMCPSecurityManager::Get().Journal(E);

    // Push scene-shaped results into their dedicated panels.
    if (bEffectiveOk && Result.Data.IsValid())
    {
        if (Cmd == TEXT("scene_get_graph"))           PushSceneGraphToPanel(Result.Data);
        else if (Cmd == TEXT("scene_validate_physics")) PushPhysicsResultsToPanel(Result.Data);
        else if (Cmd == TEXT("memory_query"))           PushMemoryResultsToPanel(Result.Data);
        // ui_report_findings carries its payload in the REQUEST, not the
        // response, because the findings were judged MCP-side.
        else if (Cmd == TEXT("ui_report_findings"))      PushExternalFindingsToPanel(Params);
    }
    // Log destructive ops to the Diff panel with true Before / requested After.
    if (bEffectiveOk)
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
        if (bEffectiveOk && Result.Data.IsValid())
        {
            ResultStr = JsonToString(Result.Data.ToSharedRef());
        }
        else
        {
            // The tool stream is a second output boundary.  Passing a raw
            // error string here bypassed the final-envelope secret redactor
            // even though the TCP reply was safe.  Shape it as JSON and send
            // it through the same bounded redaction path before recording.
            TSharedRef<FJsonObject> StreamError = MakeShared<FJsonObject>();
            StreamError->SetStringField(TEXT("error"), EffectiveError);
            if (Result.Data.IsValid())
            {
                // Keep bounded stdout/stderr and structured handler diagnostics
                // visible even though the lifecycle entry is correctly failed.
                StreamError->SetObjectField(TEXT("data"), Result.Data.ToSharedRef());
            }
            ResultStr = JsonToString(StreamError);
        }

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
        // Apply response limits only after classification. Correctness facts
        // also live on the response builder's fixed never-drop allowlist so
        // callers retain their raw machine values alongside the advisory.
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
        return ShapeOkResponse(Id, Trimmed, SuccessSignals);
    }
    else
    {
        return MakeErrorResponse(Id, EffectiveError, Cmd);
    }
}

FString FHaybaMCPCommandHandler::MakeOkResponse(
    const FString& Id,
    const TSharedPtr<FJsonObject>& Data,
    const FString& Operation)
{
    const FHaybaMCPAdvisorySignals Signals = SignalsForSuccess(Operation, Data);
    return ShapeOkResponse(Id, Data, Signals);
}

FString FHaybaMCPCommandHandler::MakeErrorResponse(
    const FString& Id,
    const FString& ErrorMessage,
    const FString& Operation,
    bool bSessionSuspect,
    bool bKnownPreflight)
{
    TSharedRef<FJsonObject> Response = MakeShareable(new FJsonObject());
    Response->SetStringField(TEXT("id"), Id);
    Response->SetBoolField(TEXT("ok"), false);
    Response->SetStringField(TEXT("error"), ErrorMessage);
    HaybaMCPAdvisory::ApplyToResponse(
        Response,
        SignalsForError(Operation, ErrorMessage, bSessionSuspect, bKnownPreflight),
        FHaybaMCPSettings::Get().AdvisoryVerbosity);
    return JsonToString(Response);
}
