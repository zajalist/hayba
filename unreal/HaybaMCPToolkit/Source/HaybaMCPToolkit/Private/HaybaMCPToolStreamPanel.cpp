#include "HaybaMCPToolStreamPanel.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPSecretRedaction.h"
#include "HaybaMCPStyle.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Widgets/Layout/SExpandableArea.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Input/SSearchBox.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SComboButton.h"
#include "Widgets/Images/SImage.h"
#include "Modules/ModuleManager.h"
#include "Styling/AppStyle.h"
#include "Styling/SlateTypes.h"
#include "Brushes/SlateColorBrush.h"
#include "HAL/PlatformApplicationMisc.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"
#include "Framework/MultiBox/MultiBoxBuilder.h"
#include <initializer_list>
#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#endif

namespace
{
    // Domain colour palette. Picked for contrast against the dark editor
    // background — each domain gets a hue strong enough to scan at a glance.
    FLinearColor ColorForRenderer(EHaybaRendererType T)
    {
        switch (T)
        {
            case EHaybaRendererType::Actor:       return FLinearColor(0.45f, 0.85f, 1.00f);
            case EHaybaRendererType::Scene:       return FLinearColor(1.00f, 0.78f, 0.30f);
            case EHaybaRendererType::Asset:       return FLinearColor(0.85f, 0.65f, 1.00f);
            case EHaybaRendererType::Image:       return FLinearColor(1.00f, 0.55f, 0.85f);
            case EHaybaRendererType::Script:      return FLinearColor(0.60f, 1.00f, 0.55f);
            case EHaybaRendererType::Performance: return FLinearColor(1.00f, 0.65f, 0.30f);
            case EHaybaRendererType::Error:       return FLinearColor(1.00f, 0.40f, 0.40f);
            case EHaybaRendererType::Memory:      return FLinearColor(0.70f, 0.55f, 1.00f);
            case EHaybaRendererType::Plan:        return FLinearColor(0.50f, 0.80f, 1.00f);
            default:                              return FLinearColor(0.70f, 0.72f, 0.78f);
        }
    }

    const TCHAR* LabelForRenderer(EHaybaRendererType T)
    {
        switch (T)
        {
            case EHaybaRendererType::Actor:       return TEXT("ACTOR");
            case EHaybaRendererType::Scene:       return TEXT("SCENE");
            case EHaybaRendererType::Asset:       return TEXT("ASSET");
            case EHaybaRendererType::Image:       return TEXT("IMAGE");
            case EHaybaRendererType::Script:      return TEXT("SCRIPT");
            case EHaybaRendererType::Performance: return TEXT("PERF");
            case EHaybaRendererType::Error:       return TEXT("ERROR");
            case EHaybaRendererType::Memory:      return TEXT("MEM");
            case EHaybaRendererType::Plan:        return TEXT("PLAN");
            default:                              return TEXT("TOOL");
        }
    }

    constexpr int32 MaxInputChars = 256 * 1024;
    constexpr int32 MaxPayloadChars = 32 * 1024;

    // A lease ID is a bearer handle and must not travel through Activity copy.
    void HideActivityHandles(const TSharedPtr<FJsonValue>& Value)
    {
        if (!Value.IsValid()) return;
        if (Value->Type == EJson::Array)
        {
            for (const TSharedPtr<FJsonValue>& Child : Value->AsArray()) HideActivityHandles(Child);
        }
        else if (Value->Type == EJson::Object)
        {
            const TSharedPtr<FJsonObject>& Object = Value->AsObject();
            if (!Object.IsValid()) return;
            TArray<FString> Keys;
            for (const auto& Pair : Object->Values) Keys.Add(FString(*Pair.Key));
            for (const FString& Key : Keys)
            {
                const FString Lower = Key.ToLower();
                const TSharedPtr<FJsonValue> Child = Object->TryGetField(Key);
                const bool bScalarLease = Lower == TEXT("lease") && Child.IsValid() && Child->Type != EJson::Object;
                if (Lower == TEXT("lease_id") || Lower == TEXT("leaseid") || bScalarLease ||
                    Lower == TEXT("ticket") || Lower == TEXT("approval_token"))
                    Object->SetStringField(Key, TEXT("[REDACTED]"));
                else
                    HideActivityHandles(Child);
            }
        }
    }

    FString SafeActivityPayload(const FString& Input)
    {
        if (Input.IsEmpty()) return TEXT("");
        if (Input.Len() > MaxInputChars)
            return TEXT("{\"_truncated\":true,\"reason\":\"input_limit\"}");

        TSharedPtr<FJsonObject> Parsed;
        if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Input), Parsed) || !Parsed.IsValid())
        {
            // Non-JSON errors remain useful; malformed JSON is never copied raw.
            if (!Input.StartsWith(TEXT("ERROR:")))
                return TEXT("{\"_truncated\":true,\"reason\":\"invalid_json\"}");
            if (Input.Len() > 4096)
                return TEXT("ERROR: [TRUNCATED:input_limit]");
            const FString SafeText = HaybaMCPSecretRedaction::RedactTextForLog(Input, 4096);
            if (SafeText.Contains(TEXT("lease_id"), ESearchCase::IgnoreCase) ||
                SafeText.Contains(TEXT("leaseid"), ESearchCase::IgnoreCase) ||
                SafeText.Contains(TEXT("ticket"), ESearchCase::IgnoreCase))
                return TEXT("ERROR: [REDACTED:unstructured_handle]");
            return SafeText;
        }

        HaybaMCPSecretRedaction::FLimits Limits;
        Limits.MaxDepth = 12;
        Limits.MaxNodes = 4096;
        Limits.MaxArrayItems = 128;
        Limits.MaxObjectKeys = 128;
        Limits.MaxKeyChars = 128;
        Limits.MaxStringChars = 4096;
        Limits.MaxTotalStringChars = MaxPayloadChars;
        const HaybaMCPSecretRedaction::FResult Redacted = HaybaMCPSecretRedaction::Redact(Parsed, Limits);
        HideActivityHandles(MakeShared<FJsonValueObject>(Redacted.Value));

        FString Output;
        const auto Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
        if (!FJsonSerializer::Serialize(Redacted.Value.ToSharedRef(), Writer) || Output.Len() > MaxPayloadChars)
            return TEXT("{\"_truncated\":true,\"reason\":\"output_limit\"}");
        if (Redacted.Summary.bTruncated)
        {
            // The redactor's own markers identify omitted fields in place.
            // A top-level marker makes truncation clear even when collapsed.
            Redacted.Value->SetBoolField(TEXT("_truncated"), true);
            Output.Reset();
            const auto MarkedWriter = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
            if (!FJsonSerializer::Serialize(Redacted.Value.ToSharedRef(), MarkedWriter) || Output.Len() > MaxPayloadChars)
                return TEXT("{\"_truncated\":true,\"reason\":\"output_limit\"}");
        }
        return Output;
    }

    FString CallToJsonLine(const FHaybaToolCall& Call)
    {
        TSharedRef<FJsonObject> Line = MakeShared<FJsonObject>();
        Line->SetStringField(TEXT("tool"), Call.ToolName);
        Line->SetStringField(TEXT("timestamp"), Call.Timestamp.ToString(TEXT("%Y-%m-%dT%H:%M:%S")));
        Line->SetStringField(TEXT("params"), Call.ParamsJson);
        Line->SetStringField(TEXT("result"), Call.ResultJson);
        FString Output;
        FJsonSerializer::Serialize(Line, TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output));
        return Output;
    }

    FString FirstStringField(const TSharedPtr<FJsonObject>& Object, std::initializer_list<const TCHAR*> Keys)
    {
        if (!Object.IsValid()) return TEXT("");
        FString Value;
        for (const TCHAR* Key : Keys)
            if (Object->TryGetStringField(Key, Value) && !Value.IsEmpty()) return Value;
        return TEXT("");
    }

    TSharedPtr<FJsonObject> ParseObject(const FString& Input)
    {
        TSharedPtr<FJsonObject> Object;
        FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Input), Object);
        return Object;
    }

    FString ShortLabel(const FString& Value, int32 MaxChars = 48)
    {
        const FString SingleLine = Value.Replace(TEXT("\n"), TEXT(" ")).Replace(TEXT("\r"), TEXT(" "));
        return SingleLine.Len() <= MaxChars ? SingleLine : SingleLine.Left(MaxChars - 1) + TEXT("…");
    }

    struct FCallPresentation
    {
        FString Action;
        FString Target;
        FString Outcome;
        FName OutcomeColor = TEXT("Hayba.Color.Status.Info");
    };

    FCallPresentation PresentCall(const FHaybaToolCall& Call)
    {
        FCallPresentation P;
        static const TMap<FString, FString> Actions = {
            {TEXT("actor_tag"), TEXT("Tag actor")},
            {TEXT("actor_spawn"), TEXT("Spawn actor")},
            {TEXT("actor_delete"), TEXT("Delete actor")},
            {TEXT("actor_set_transform"), TEXT("Set actor transform")},
            {TEXT("actor_set_visibility"), TEXT("Set actor visibility")},
            {TEXT("actor_set_properties"), TEXT("Set actor properties")},
            {TEXT("lease_acquire"), TEXT("Reserve edit scope")},
            {TEXT("lease_release"), TEXT("Release edit scope")},
            {TEXT("scene_get_graph"), TEXT("Read scene graph")},
            {TEXT("editor_capture_viewport"), TEXT("Capture viewport")}
        };
        if (const FString* Known = Actions.Find(Call.ToolName)) P.Action = *Known;
        else
        {
            P.Action = Call.ToolName;
            P.Action.ReplaceInline(TEXT("_"), TEXT(" "));
            if (!P.Action.IsEmpty()) P.Action[0] = FChar::ToUpper(P.Action[0]);
        }
        P.Action = ShortLabel(P.Action, 56);

        const TSharedPtr<FJsonObject> Params = ParseObject(Call.ParamsJson);
        P.Target = FirstStringField(Params, {TEXT("actor_id"), TEXT("actorId"), TEXT("asset_path"), TEXT("object_path"), TEXT("path"), TEXT("name")});
        if (P.Target.IsEmpty() && Params.IsValid())
        {
            const TArray<TSharedPtr<FJsonValue>>* Resources = nullptr;
            if (Params->TryGetArrayField(TEXT("resources"), Resources) && Resources && Resources->Num() > 0 && (*Resources)[0].IsValid())
                P.Target = (*Resources)[0]->AsString();
        }
        P.Target = ShortLabel(P.Target);

        if (Call.ResultJson.IsEmpty()) P.Outcome = TEXT("Requested");
        else if (Call.ResultJson.StartsWith(TEXT("ERROR:")))
        {
            P.Outcome = TEXT("Failed");
            P.OutcomeColor = TEXT("Hayba.Color.Status.Fail");
        }
        else
        {
            const TSharedPtr<FJsonObject> Result = ParseObject(Call.ResultJson);
            bool bOk = true;
            const bool bHasError = Result.IsValid() && Result->HasField(TEXT("error")) &&
                Result->TryGetField(TEXT("error")).IsValid() &&
                Result->TryGetField(TEXT("error"))->Type != EJson::Null;
            const FString Status = FirstStringField(Result, {TEXT("status")}).ToLower();
            if (Result.IsValid())
            {
                Result->TryGetBoolField(TEXT("ok"), bOk);
            }
            if (!bOk || bHasError || Status == TEXT("error") || Status == TEXT("failed") || Status == TEXT("refused"))
            {
                P.Outcome = TEXT("Failed");
                P.OutcomeColor = TEXT("Hayba.Color.Status.Fail");
            }
            else if (Status == TEXT("pending") || Status == TEXT("plan_mode_required"))
            {
                P.Outcome = TEXT("Pending");
                P.OutcomeColor = TEXT("Hayba.Color.Status.Warn");
            }
            else P.Outcome = TEXT("Returned");
        }
        if (Call.ParamsJson.Contains(TEXT("_truncated")) || Call.ResultJson.Contains(TEXT("_truncated")) ||
            Call.ParamsJson.Contains(TEXT("[TRUNCATED:")) || Call.ResultJson.Contains(TEXT("[TRUNCATED:")))
            P.Outcome += TEXT(" · truncated");
        return P;
    }

    FString WrapDetailText(const FString& Input)
    {
        FString Out;
        Out.Reserve(Input.Len() + Input.Len() / 40 + 1);
        int32 Column = 0;
        for (TCHAR C : Input)
        {
            if (C == TEXT('\n')) Column = 0;
            else if (++Column > 40) { Out.AppendChar(TEXT('\n')); Column = 1; }
            Out.AppendChar(C);
        }
        return Out;
    }

    void Toast(const FText& Msg)
    {
        FNotificationInfo Info(Msg);
        Info.ExpireDuration = 2.5f;
        Info.bUseSuccessFailIcons = false;
        FSlateNotificationManager::Get().AddNotification(Info);
    }
}

const TMap<FString, EHaybaRendererType>& SHaybaMCPToolStreamPanel::GetRendererMap()
{
    static TMap<FString, EHaybaRendererType> Map = {
        { TEXT("actor_spawn"),            EHaybaRendererType::Actor },
        { TEXT("actor_delete"),           EHaybaRendererType::Actor },
        { TEXT("actor_set_transform"),    EHaybaRendererType::Actor },
        { TEXT("actor_list"),             EHaybaRendererType::Actor },
        { TEXT("scene_get_graph"),        EHaybaRendererType::Scene },
        { TEXT("scene_validate_physics"), EHaybaRendererType::Scene },
        { TEXT("editor_capture_viewport"),EHaybaRendererType::Image },
        { TEXT("editor_execute_console"), EHaybaRendererType::Script },
        { TEXT("editor_stream_log"),      EHaybaRendererType::Script },
        { TEXT("python_exec"),            EHaybaRendererType::Script },
        { TEXT("visual_moodboard"),       EHaybaRendererType::Image },
        { TEXT("visual_clip_compare"),    EHaybaRendererType::Image },
        { TEXT("memory_write"),           EHaybaRendererType::Memory },
        { TEXT("memory_query"),           EHaybaRendererType::Memory },
        { TEXT("hayba_propose_plan"),     EHaybaRendererType::Plan },
    };
    return Map;
}

EHaybaRendererType SHaybaMCPToolStreamPanel::ResolveRenderer(const FString& ToolName)
{
    const auto& Map = GetRendererMap();
    if (const EHaybaRendererType* T = Map.Find(ToolName)) return *T;
    if (ToolName == TEXT("ping") || ToolName.StartsWith(TEXT("hayba_check_"))) return EHaybaRendererType::Script;
    if (ToolName.StartsWith(TEXT("hayba_search_")) ||
        ToolName.StartsWith(TEXT("hayba_get_node_")) ||
        ToolName.StartsWith(TEXT("hayba_query_")) ||
        ToolName.StartsWith(TEXT("hayba_list_pcg")) ||
        ToolName.StartsWith(TEXT("hayba_initiate_")))
        return EHaybaRendererType::Asset;
    if (ToolName.StartsWith(TEXT("hayba_create_pcg")) ||
        ToolName.StartsWith(TEXT("hayba_execute_pcg")) ||
        ToolName.StartsWith(TEXT("hayba_validate_")) ||
        ToolName.StartsWith(TEXT("hayba_export_pcg")) ||
        ToolName.StartsWith(TEXT("hayba_abstract_")) ||
        ToolName.StartsWith(TEXT("hayba_parameterize_")) ||
        ToolName.StartsWith(TEXT("hayba_format_")) ||
        ToolName.StartsWith(TEXT("hayba_match_")) ||
        ToolName.StartsWith(TEXT("hayba_diff_")) ||
        ToolName.StartsWith(TEXT("hayba_scrape_")))
        return EHaybaRendererType::Plan;
    if (ToolName == TEXT("list_tool_categories") ||
        ToolName == TEXT("get_tool_signature") ||
        ToolName == TEXT("python_run"))
        return EHaybaRendererType::Script;
    if (ToolName.StartsWith(TEXT("hayba_open_zone")) ||
        ToolName.StartsWith(TEXT("hayba_read_zones")) ||
        ToolName.StartsWith(TEXT("hayba_set_painter")) ||
        ToolName.StartsWith(TEXT("hayba_setup_")) ||
        ToolName.StartsWith(TEXT("hayba_analyze_")) ||
        ToolName.StartsWith(TEXT("hayba_import_")))
        return EHaybaRendererType::Performance;
    if (ToolName.StartsWith(TEXT("visual_"))) return EHaybaRendererType::Image;
    if (ToolName.StartsWith(TEXT("memory_"))) return EHaybaRendererType::Memory;
    if (ToolName.StartsWith(TEXT("actor_")))  return EHaybaRendererType::Actor;
    if (ToolName.StartsWith(TEXT("scene_")))  return EHaybaRendererType::Scene;
    if (ToolName.StartsWith(TEXT("editor_"))) return EHaybaRendererType::Script;
    return EHaybaRendererType::Generic;
}

void SHaybaMCPToolStreamPanel::Construct(const FArguments& InArgs)
{
    auto FirstTurn = MakeShared<FHaybaTurn>();
    FirstTurn->TurnIndex = 0;
    FirstTurn->Summary = TEXT("Turn 1");
    Turns.Add(FirstTurn);

    // Hydrate from the module-level history.
    if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
    {
        TArray<FHaybaToolCallRecord> Hist = M->SnapshotToolCalls();
        for (const FHaybaToolCallRecord& R : Hist)
        {
            FHaybaToolCall Call;
            Call.ToolName     = HaybaMCPSecretRedaction::RedactTextForLog(R.ToolName, 128);
            Call.ParamsJson   = SafeActivityPayload(R.ParamsJson);
            Call.ResultJson   = SafeActivityPayload(R.ResultJson);
            Call.RendererType = ResolveRenderer(R.ToolName);
            Call.Timestamp    = R.Timestamp;
            Turns.Last()->Calls.Add(MoveTemp(Call));
        }
        if (Hist.Num() > 0) RebuildSummary(Turns.Last());
    }

    ChildSlot
    [
        SNew(SVerticalBox)
        // ── Toolbar ───────────────────────────────────────────────────────────
        + SVerticalBox::Slot().AutoHeight().Padding(8.f, 8.f, 8.f, 4.f)
        [ BuildToolbar() ]
        + SVerticalBox::Slot().AutoHeight()
        [ SNew(SSeparator).Thickness(1.f) ]

        // ── Empty-state hint ──────────────────────────────────────────────────
        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 8.f)
        [
            SNew(STextBlock)
            .Visibility_Lambda([this]()
            {
                return (Turns.Num() == 1 && Turns[0]->Calls.IsEmpty())
                    ? EVisibility::Visible : EVisibility::Collapsed;
            })
            .ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.7f)))
            .AutoWrapText(true)
            .Text(NSLOCTEXT("Hayba", "Stream.Empty",
                "No tool calls yet. Invoke any Hayba MCP tool from your client and they will stream in here, grouped by turn."))
        ]

        // ── Scrollable list of turn cards ─────────────────────────────────────
        // SScrollBox over SVerticalBox avoids the SListView row-height cache
        // staleness that causes scroll to die after a turn collapse/expand.
        + SVerticalBox::Slot().FillHeight(1.f)
        [
            SNew(SScrollBox)
            + SScrollBox::Slot()
            [
                SAssignNew(TurnsContainer, SVerticalBox)
            ]
        ]
    ];

    RebuildTurnsContainer();
}

void SHaybaMCPToolStreamPanel::RebuildTurnsContainer()
{
    if (!TurnsContainer.IsValid()) return;
    TurnsContainer->ClearChildren();
    for (int32 TurnIdx = 0; TurnIdx < Turns.Num(); ++TurnIdx)
    {
        const TSharedPtr<FHaybaTurn>& Turn = Turns[TurnIdx];
        // Skip empty turns entirely — no hollow expander cards after Clear.
        if (Turn->Calls.IsEmpty()) continue;
        // Skip turns whose calls all filter out (avoid empty cards under search).
        if (!FilterQuery.IsEmpty() && !TurnHasAnyMatch(Turn)) continue;

        TSharedRef<SVerticalBox> Body = SNew(SVerticalBox);
        for (int32 CallIdx = 0; CallIdx < Turn->Calls.Num(); ++CallIdx)
        {
            const FHaybaToolCall& Call = Turn->Calls[CallIdx];
            if (!CallMatchesFilter(Call)) continue;
            Body->AddSlot().AutoHeight().Padding(0.f, 3.f)
            [ BuildCallRow(Call, TurnIdx, CallIdx) ];
        }

        const bool bIsLatest = (Turn == Turns.Last());
        TurnsContainer->AddSlot().AutoHeight().Padding(8.f, 4.f)
        [
            SNew(SBorder)
            .BorderImage(FAppStyle::Get().GetBrush("Brushes.Panel"))
            .Padding(FMargin(8.f, 6.f))
            [
                SNew(SExpandableArea)
                .InitiallyCollapsed(!bIsLatest)
                .AreaTitleFont(FAppStyle::GetFontStyle("DetailsView.CategoryFontStyle"))
                .HeaderContent()
                [
                    SNew(SHorizontalBox)
                    // Per-turn selection — drives Copy / Archive bulk actions.
                    + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 8.f, 0.f)
                    [
                        SNew(SCheckBox)
                        .ToolTipText(NSLOCTEXT("Hayba", "Stream.SelectTurnTT",
                            "Include every call in this turn when you Copy or Archive."))
                        .IsChecked_Lambda([Turn]()
                        {
                            return (Turn.IsValid() && Turn->bSelected) ? ECheckBoxState::Checked : ECheckBoxState::Unchecked;
                        })
                        .OnCheckStateChanged_Lambda([Turn, this](ECheckBoxState S)
                        {
                            if (Turn.IsValid())
                            {
                                Turn->bSelected = (S == ECheckBoxState::Checked);
                                Invalidate(EInvalidateWidgetReason::Paint);
                            }
                        })
                    ]
                    + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                    [
                        SNew(STextBlock).Text_Lambda([Turn](){ return FText::FromString(Turn->Summary); })
                    ]
                ]
                .BodyContent()
                [ Body ]
            ]
        ];
    }
}

TSharedRef<SWidget> SHaybaMCPToolStreamPanel::BuildToolbar()
{
    // UE5-stock layout: SSearchBox on the left filling, then small action buttons.
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
        [
            SNew(SSearchBox)
            .HintText(NSLOCTEXT("Hayba", "Stream.SearchHint", "Search tool name, params, or result..."))
            .OnTextChanged(this, &SHaybaMCPToolStreamPanel::OnSearchChanged)
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(8.f, 0.f, 0.f, 0.f)
        [
            SNew(SComboButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .HasDownArrow(true)
            .ContentPadding(FMargin(8.f, 4.f))
            .ButtonContent()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(SImage).Image(FAppStyle::GetBrush("Profiler.Tab"))
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(4.f, 0.f, 0.f, 0.f)
                [
                    SNew(STextBlock).Text(NSLOCTEXT("Hayba", "Stream.Stats", "Stats"))
                ]
            ]
            .OnGetMenuContent_Lambda([this]() { return BuildStatsMenu(); })
        ]
        // Selection count chip — only visible when something is selected.
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .Visibility_Lambda([this](){ return CountSelected() > 0 ? EVisibility::Visible : EVisibility::Collapsed; })
            .ColorAndOpacity(FSlateColor(FLinearColor(1.0f, 0.78f, 0.30f)))
            .Text_Lambda([this](){ return FText::FromString(FString::Printf(TEXT("%d turn%s selected"),
                CountSelected(), CountSelected() == 1 ? TEXT("") : TEXT("s"))); })
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(4.f, 0.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .ToolTipText(NSLOCTEXT("Hayba", "Stream.ClearSelTT", "Clear selection"))
            .Visibility_Lambda([this](){ return CountSelected() > 0 ? EVisibility::Visible : EVisibility::Collapsed; })
            .ContentPadding(FMargin(6.f, 2.f))
            .OnClicked(this, &SHaybaMCPToolStreamPanel::OnClearSelection)
            [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "Stream.ClearSel", "Clear")) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(6.f, 0.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .ToolTipText_Lambda([this]()
            {
                return CountSelected() > 0
                    ? NSLOCTEXT("Hayba", "Stream.CopySelTT",     "Copy every call in the selected turns to clipboard as JSONL")
                    : NSLOCTEXT("Hayba", "Stream.CopyAllTT",     "Copy all visible calls to clipboard as JSONL");
            })
            .ContentPadding(FMargin(6.f))
            .OnClicked(this, &SHaybaMCPToolStreamPanel::OnCopyAll)
            [
                SNew(SImage).Image(FAppStyle::GetBrush("Icons.Duplicate"))
            ]
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(6.f, 0.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .ToolTipText_Lambda([this]()
            {
                return CountSelected() > 0
                    ? NSLOCTEXT("Hayba", "Stream.ArchiveSelTT", "Archive every call in the selected turns and remove those turns from the panel")
                    : NSLOCTEXT("Hayba", "Stream.ArchiveAllTT", "Archive all calls and clear the panel");
            })
            .ContentPadding(FMargin(6.f))
            .OnClicked(this, &SHaybaMCPToolStreamPanel::OnArchive)
            [
                SNew(SImage).Image(FAppStyle::GetBrush("Icons.Save"))
            ]
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(6.f, 0.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .ToolTipText(NSLOCTEXT("Hayba", "Stream.ClearAllTT", "Clear the panel without archiving"))
            .ContentPadding(FMargin(6.f))
            .OnClicked(this, &SHaybaMCPToolStreamPanel::OnClear)
            [
                SNew(SImage).Image(FAppStyle::GetBrush("Icons.Delete"))
            ]
        ];
}

TSharedRef<SWidget> SHaybaMCPToolStreamPanel::BuildStatsMenu()
{
    // Aggregate live from current Turns. Drop into a fixed-width box so the
    // popup looks like other UE5 dropdown menus.
    TMap<FString, int32> ToolCounts;
    TMap<EHaybaRendererType, int32> DomainCounts;
    int32 Total = 0;
    int32 Errors = 0;
    for (const auto& Turn : Turns)
    {
        for (const auto& Call : Turn->Calls)
        {
            ++Total;
            ToolCounts.FindOrAdd(Call.ToolName)++;
            DomainCounts.FindOrAdd(Call.RendererType)++;
            if (PresentCall(Call).Outcome.StartsWith(TEXT("Failed"))) ++Errors;
        }
    }

    // Sort tool counts descending.
    TArray<TPair<FString, int32>> SortedTools;
    for (const auto& KV : ToolCounts) SortedTools.Add(KV);
    SortedTools.Sort([](const TPair<FString,int32>& A, const TPair<FString,int32>& B){ return A.Value > B.Value; });

    TSharedRef<SVerticalBox> Box = SNew(SVerticalBox);
    Box->AddSlot().AutoHeight().Padding(12.f, 8.f)
    [
        SNew(STextBlock)
        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
        .Text(FText::FromString(FString::Printf(TEXT("%d calls  -  %d turns  -  %d errors"),
            Total, Turns.Num(), Errors)))
    ];
    Box->AddSlot().AutoHeight().Padding(12.f, 0.f, 12.f, 6.f)
    [ SNew(SSeparator).Thickness(1.f) ];
    Box->AddSlot().AutoHeight().Padding(12.f, 2.f)
    [
        SNew(STextBlock)
        .ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.62f, 0.72f)))
        .Text(NSLOCTEXT("Hayba", "Stream.StatsByDomain", "By domain"))
    ];
    for (const auto& KV : DomainCounts)
    {
        Box->AddSlot().AutoHeight().Padding(20.f, 1.f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f)
            [
                SNew(STextBlock)
                .ColorAndOpacity(FSlateColor(ColorForRenderer(KV.Key)))
                .Text(FText::FromString(LabelForRenderer(KV.Key)))
            ]
            + SHorizontalBox::Slot().AutoWidth()
            [
                SNew(STextBlock)
                .Text(FText::FromString(FString::FromInt(KV.Value)))
            ]
        ];
    }
    Box->AddSlot().AutoHeight().Padding(12.f, 8.f, 12.f, 2.f)
    [
        SNew(STextBlock)
        .ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.62f, 0.72f)))
        .Text(NSLOCTEXT("Hayba", "Stream.StatsTopTools", "Top tools"))
    ];
    int32 Shown = 0;
    for (const auto& KV : SortedTools)
    {
        if (Shown++ >= 8) break;
        Box->AddSlot().AutoHeight().Padding(20.f, 1.f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f)
            [ SNew(STextBlock).Text(FText::FromString(KV.Key)) ]
            + SHorizontalBox::Slot().AutoWidth()
            [ SNew(STextBlock).Text(FText::FromString(FString::FromInt(KV.Value))) ]
        ];
    }

    return SNew(SBox).MinDesiredWidth(280.f).Padding(FMargin(0.f, 4.f, 0.f, 8.f)) [ Box ];
}

void SHaybaMCPToolStreamPanel::BeginNewTurn()
{
    CurrentTurnIndex++;
    auto Turn = MakeShared<FHaybaTurn>();
    Turn->TurnIndex = CurrentTurnIndex;
    Turn->Summary = FString::Printf(TEXT("Turn %d"), CurrentTurnIndex + 1);
    Turns.Add(Turn);
    RebuildTurnsContainer();
}

void SHaybaMCPToolStreamPanel::AddToolCall(const FString& ToolName, const FString& ParamsJson, const FString& ResultJson)
{
    if (Turns.IsEmpty()) BeginNewTurn();
    FHaybaToolCall Call;
    Call.ToolName     = HaybaMCPSecretRedaction::RedactTextForLog(ToolName, 128);
    Call.ParamsJson   = SafeActivityPayload(ParamsJson);
    Call.ResultJson   = SafeActivityPayload(ResultJson);
    Call.RendererType = ResolveRenderer(ToolName);
    Call.Timestamp    = FDateTime::Now();
    Turns.Last()->Calls.Add(Call);
    RebuildSummary(Turns.Last());
    RebuildTurnsContainer();
}

void SHaybaMCPToolStreamPanel::RebuildSummary(TSharedPtr<FHaybaTurn> Turn) const
{
    TArray<FString> Names;
    for (const auto& C : Turn->Calls)
    {
        Names.AddUnique(C.ToolName);
        if (Names.Num() >= 3) break;
    }
    Turn->Summary = FString::Printf(TEXT("Turn %d  -  %d call%s  (%s)"),
        Turn->TurnIndex + 1,
        Turn->Calls.Num(),
        Turn->Calls.Num() == 1 ? TEXT("") : TEXT("s"),
        *FString::Join(Names, TEXT(", ")));
}

bool SHaybaMCPToolStreamPanel::CallMatchesFilter(const FHaybaToolCall& Call) const
{
    if (FilterQuery.IsEmpty()) return true;
    return Call.ToolName.Contains(FilterQuery, ESearchCase::IgnoreCase)
        || Call.ParamsJson.Contains(FilterQuery, ESearchCase::IgnoreCase)
        || Call.ResultJson.Contains(FilterQuery, ESearchCase::IgnoreCase);
}

bool SHaybaMCPToolStreamPanel::TurnHasAnyMatch(const TSharedPtr<FHaybaTurn>& Turn) const
{
    for (const auto& C : Turn->Calls) if (CallMatchesFilter(C)) return true;
    return false;
}

void SHaybaMCPToolStreamPanel::OnSearchChanged(const FText& InText)
{
    FilterQuery = InText.ToString().TrimStartAndEnd();
    RebuildTurnsContainer();
}

int32 SHaybaMCPToolStreamPanel::CountSelected() const
{
    // Selection lives at turn granularity now — bulk actions target whole turns.
    int32 N = 0;
    for (const auto& Turn : Turns) if (Turn->bSelected) ++N;
    return N;
}

FReply SHaybaMCPToolStreamPanel::OnSelectAllVisible()
{
    for (auto& Turn : Turns) if (TurnHasAnyMatch(Turn)) Turn->bSelected = true;
    RebuildTurnsContainer();
    return FReply::Handled();
}

FReply SHaybaMCPToolStreamPanel::OnClearSelection()
{
    for (auto& Turn : Turns) Turn->bSelected = false;
    RebuildTurnsContainer();
    return FReply::Handled();
}

FReply SHaybaMCPToolStreamPanel::OnCopyAll()
{
    const bool bUseSelection = CountSelected() > 0;
    FString Lines;
    int32 Count = 0;
    for (const auto& Turn : Turns)
    {
        if (bUseSelection && !Turn->bSelected) continue;
        for (const auto& Call : Turn->Calls)
        {
            if (!bUseSelection && !CallMatchesFilter(Call)) continue;
            Lines += CallToJsonLine(Call) + TEXT("\n");
            ++Count;
        }
    }
    FPlatformApplicationMisc::ClipboardCopy(*Lines);
    Toast(FText::FromString(FString::Printf(TEXT("Copied %d %s call%s to clipboard"),
        Count, bUseSelection ? TEXT("selected") : TEXT("visible"),
        Count == 1 ? TEXT("") : TEXT("s"))));
    return FReply::Handled();
}

void SHaybaMCPToolStreamPanel::CopyCallToClipboard(const FHaybaToolCall& Call) const
{
    FPlatformApplicationMisc::ClipboardCopy(*CallToJsonLine(Call));
    Toast(FText::FromString(FString::Printf(TEXT("Copied %s to clipboard"), *Call.ToolName)));
}

FReply SHaybaMCPToolStreamPanel::OnArchive()
{
    const bool bUseSelection = CountSelected() > 0;
    const FString Dir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("HaybaMCP"), TEXT("ToolStream"));
    IFileManager::Get().MakeDirectory(*Dir, /*Tree*/ true);
    const FString Stamp = FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S"));
    const FString FilePath = FPaths::Combine(Dir, FString::Printf(TEXT("Archive_%s.jsonl"), *Stamp));

    FString Lines;
    int32 Count = 0;
    for (const auto& Turn : Turns)
    {
        if (bUseSelection && !Turn->bSelected) continue;
        for (const auto& Call : Turn->Calls)
        {
            Lines += CallToJsonLine(Call) + TEXT("\n");
            ++Count;
        }
    }
    if (Count == 0)
    {
        Toast(NSLOCTEXT("Hayba", "Stream.ArchiveNothing", "Nothing to archive."));
        return FReply::Handled();
    }
    const bool bSaved = FFileHelper::SaveStringToFile(Lines, *FilePath);
    if (!bSaved)
    {
        Toast(NSLOCTEXT("Hayba", "Stream.ArchiveFail", "Archive failed — check write permissions on Saved/"));
        return FReply::Handled();
    }

    Toast(FText::FromString(FString::Printf(TEXT("Archived %d call%s -> %s"),
        Count, Count == 1 ? TEXT("") : TEXT("s"), *FilePath)));

    if (bUseSelection)
    {
        // Drop the selected turns entirely — the calls in them just got archived.
        Turns.RemoveAll([](const TSharedPtr<FHaybaTurn>& T) { return T.IsValid() && T->bSelected; });
        // Always keep at least one turn so AddToolCall has somewhere to land.
        if (Turns.IsEmpty()) { CurrentTurnIndex = 0; BeginNewTurn(); }
    }
    else
    {
        // Archive-all: reset to a fresh empty turn.
        Turns.Empty();
        CurrentTurnIndex = 0;
        BeginNewTurn();
    }
    RebuildTurnsContainer();
    return FReply::Handled();
}

FReply SHaybaMCPToolStreamPanel::OnClear()
{
    Turns.Empty();
    CurrentTurnIndex = 0;
    BeginNewTurn();
    if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
    {
        M->ClearToolCallHistory();
    }
    Toast(NSLOCTEXT("Hayba", "Stream.Cleared", "Tool Stream cleared."));
    return FReply::Handled();
}

TSharedRef<SWidget> SHaybaMCPToolStreamPanel::BuildCallRow(const FHaybaToolCall& Call, int32 TurnIdx, int32 CallIdx)
{
    return BuildGenericRenderer(Call, TurnIdx, CallIdx);
}

TSharedRef<SWidget> SHaybaMCPToolStreamPanel::BuildGenericRenderer(const FHaybaToolCall& Call, int32 TurnIdx, int32 CallIdx)
{
    const FCallPresentation Presentation = PresentCall(Call);
    const FString TimeStr = Call.Timestamp.ToString(TEXT("%H:%M:%S"));
    const FHaybaToolCall CallCopy = Call;
    const FLinearColor Primary = FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Primary"));
    const FLinearColor Secondary = FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary"));
    const FLinearColor Muted = FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Muted"));

    return SNew(SBorder)
        .BorderImage(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Brush.Settings.Section")))
        .Padding(FMargin(10.f, 8.f))
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(Primary))
                    .AutoWrapText(true)
                    .ToolTipText(FText::FromString(Call.ToolName))
                    .Text(FText::FromString(Presentation.Action))
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6.f, 0.f)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(Muted))
                    .Text(FText::FromString(TimeStr))
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(SButton)
                    .ButtonStyle(FAppStyle::Get(), "SimpleButton")
                    .ToolTipText(NSLOCTEXT("Hayba", "Stream.CopyRowTT", "Copy redacted tool call as JSONL"))
                    .ContentPadding(FMargin(4.f))
                    .OnClicked_Lambda([this, CallCopy]()
                    {
                        CopyCallToClipboard(CallCopy);
                        return FReply::Handled();
                    })
                    [
                        SNew(SImage).Image(FAppStyle::GetBrush("Icons.Duplicate"))
                    ]
                ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 4.f, 0.f, 0.f)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .Visibility(Presentation.Target.IsEmpty() ? EVisibility::Collapsed : EVisibility::Visible)
                    .ColorAndOpacity(FSlateColor(Secondary))
                    .Text(FText::FromString(Presentation.Target))
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour(Presentation.OutcomeColor)))
                    .Text(FText::FromString(Presentation.Outcome))
                ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 4.f, 0.f, 0.f)
            [
                SNew(SExpandableArea)
                .InitiallyCollapsed(true)
                .AreaTitleFont(FHaybaMCPStyle::Font(10))
                .HeaderContent()
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(Muted))
                    .Text(NSLOCTEXT("Hayba", "Stream.Details", "Details"))
                ]
                .BodyContent()
                [
                    SNew(SBox)
                    .MaxDesiredHeight(220.f)
                    [
                        SNew(SScrollBox)
                        + SScrollBox::Slot()
                        [
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 5.f, 0.f, 2.f)
                            [
                                SNew(STextBlock)
                                .ColorAndOpacity(FSlateColor(Muted))
                                .Text(NSLOCTEXT("Hayba", "Stream.Request", "Request"))
                            ]
                            + SVerticalBox::Slot().AutoHeight()
                            [
                                SNew(STextBlock)
                                .ColorAndOpacity(FSlateColor(Secondary))
                                .AutoWrapText(true)
                                .Text(FText::FromString(WrapDetailText(Call.ParamsJson.IsEmpty() ? TEXT("{}") : Call.ParamsJson)))
                            ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 8.f, 0.f, 2.f)
                            [
                                SNew(STextBlock)
                                .ColorAndOpacity(FSlateColor(Muted))
                                .Text(NSLOCTEXT("Hayba", "Stream.Response", "Response"))
                            ]
                            + SVerticalBox::Slot().AutoHeight()
                            [
                                SNew(STextBlock)
                                .ColorAndOpacity(FSlateColor(Secondary))
                                .AutoWrapText(true)
                                .Text(FText::FromString(WrapDetailText(Call.ResultJson.IsEmpty()
                                    ? TEXT("No response recorded") : Call.ResultJson)))
                            ]
                        ]
                    ]
                ]
            ]
        ];
}

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaToolStreamSafeActivityTest,
    "Hayba.ToolStream.SafeActivity", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaToolStreamSafeActivityTest::RunTest(const FString& Parameters)
{
    FHaybaToolCall Call;
    Call.ToolName = TEXT("actor_tag");
    Call.Timestamp = FDateTime(2026, 1, 1);
    Call.ParamsJson = SafeActivityPayload(TEXT("{\"actor_id\":\"Actor.synthetic\",\"count\":3,\"nested\":{\"lease_id\":\"synthetic-handle\",\"api_key\":\"synthetic-secret\"}}"));
    Call.ResultJson = SafeActivityPayload(TEXT("{\"ok\":true,\"tag\":\"synthetic-tag\"}"));
    const FString Line = CallToJsonLine(Call);
    TestTrue(TEXT("Non-secret target and diagnostic field survive"),
        Line.Contains(TEXT("Actor.synthetic")) && Line.Contains(TEXT("synthetic-tag")) && Line.Contains(TEXT("count")));
    TestFalse(TEXT("Lease handle never enters copied JSONL"), Line.Contains(TEXT("synthetic-handle")));
    TestFalse(TEXT("Nested API key never enters copied JSONL"), Line.Contains(TEXT("synthetic-secret")));
    TSharedPtr<FJsonObject> ParsedLine = ParseObject(Line);
    TestTrue(TEXT("Copied line remains structured JSONL"), ParsedLine.IsValid() && ParsedLine->HasField(TEXT("params")) && ParsedLine->HasField(TEXT("result")));
    TestFalse(TEXT("One call occupies one JSONL line"), Line.Contains(TEXT("\n")));

    TestEqual(TEXT("Returned is not verification"), PresentCall(Call).Outcome, FString(TEXT("Returned")));
    Call.ResultJson.Empty();
    TestEqual(TEXT("Unanswered call is requested"), PresentCall(Call).Outcome, FString(TEXT("Requested")));
    Call.ResultJson = SafeActivityPayload(TEXT("{\"error\":{\"code\":\"denied\"}}"));
    TestEqual(TEXT("Error object is failure"), PresentCall(Call).Outcome, FString(TEXT("Failed")));
    Call.ResultJson = SafeActivityPayload(TEXT("{\"verified\":true}"));
    TestEqual(TEXT("A claimed verification without readback remains returned"), PresentCall(Call).Outcome, FString(TEXT("Returned")));

    const FString Oversize = SafeActivityPayload(TEXT("{\"value\":\"") + FString::ChrN(MaxInputChars, TEXT('x')) + TEXT("\"}"));
    TestTrue(TEXT("Oversize payload is visibly truncated"), Oversize.Contains(TEXT("_truncated")));
    TestTrue(TEXT("Payload remains bounded"), Oversize.Len() <= MaxPayloadChars);
    TestEqual(TEXT("Unstructured lease error cannot copy bearer handle"),
        SafeActivityPayload(TEXT("ERROR: lease_id=synthetic-handle")),
        FString(TEXT("ERROR: [REDACTED:unstructured_handle]")));
    TestTrue(TEXT("Malformed JSON fails closed with explicit marker"),
        SafeActivityPayload(TEXT("{\"api_key\":\"synthetic-secret\"" )).Contains(TEXT("_truncated")));
    return true;
}
#endif
