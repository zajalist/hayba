#include "HaybaMCPToolStreamPanel.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonReader.h"
#include "HaybaMCPStatusVocabulary.h"
#include "HaybaMCPStyle.h"
#include "HaybaMCPModule.h"
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

namespace
{
    // Domain colour palette. Picked for contrast against the dark editor
    // background — each domain gets a hue strong enough to scan at a glance.
    FLinearColor ColorForRenderer(EHaybaRendererType T)
    {
        switch (T)
        {
            // The style set's categorical ramp is named for these exact types,
            // and this panel drew its own colours anyway. The ramp is an evenly
            // spaced hue sweep; these literals were picked one at a time, so
            // they never sat together as a set.
            case EHaybaRendererType::Actor:       return FHaybaMCPStyle::Colour("Hayba.Color.Cat.Actor");
            case EHaybaRendererType::Scene:       return FHaybaMCPStyle::Colour("Hayba.Color.Cat.Scene");
            case EHaybaRendererType::Asset:       return FHaybaMCPStyle::Colour("Hayba.Color.Cat.Asset");
            case EHaybaRendererType::Image:       return FHaybaMCPStyle::Colour("Hayba.Color.Cat.Image");
            case EHaybaRendererType::Script:      return FHaybaMCPStyle::Colour("Hayba.Color.Cat.Script");
            case EHaybaRendererType::Performance: return FHaybaMCPStyle::Colour("Hayba.Color.Cat.Performance");
            // Error is a STATUS, not a category: it means the call failed,
            // which is a different kind of fact from what the call was about.
            case EHaybaRendererType::Error:       return FHaybaMCPStyle::Colour("Hayba.Color.Status.Fail");
            case EHaybaRendererType::Memory:      return FHaybaMCPStyle::Colour("Hayba.Color.Cat.Memory");
            case EHaybaRendererType::Plan:        return FHaybaMCPStyle::Colour("Hayba.Color.Cat.Plan");
            default:                              return FHaybaMCPStyle::Colour("Hayba.Color.Cat.Neutral");
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

    // JSON-escape — minimal, just the chars that would break parsing.
    FString JsonEscape(const FString& In)
    {
        FString Out; Out.Reserve(In.Len() + 8);
        for (TCHAR C : In)
        {
            switch (C)
            {
                case TEXT('"'):  Out += TEXT("\\\""); break;
                case TEXT('\\'): Out += TEXT("\\\\"); break;
                case TEXT('\n'): Out += TEXT("\\n");  break;
                case TEXT('\r'): Out += TEXT("\\r");  break;
                case TEXT('\t'): Out += TEXT("\\t");  break;
                default: Out.AppendChar(C);
            }
        }
        return Out;
    }

    FString CallToJsonLine(const FHaybaToolCall& Call)
    {
        return FString::Printf(
            TEXT("{\"tool\":\"%s\",\"timestamp\":\"%s\",\"params\":\"%s\",\"result\":\"%s\"}"),
            *JsonEscape(Call.ToolName),
            *JsonEscape(Call.Timestamp.ToString(TEXT("%Y-%m-%dT%H:%M:%S"))),
            *JsonEscape(Call.ParamsJson),
            *JsonEscape(Call.ResultJson));
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
            Call.ToolName     = R.ToolName;
            Call.ParamsJson   = R.ParamsJson;
            Call.ResultJson   = R.ResultJson;
            Call.RendererType = ResolveRenderer(R.ToolName);
            Call.Timestamp    = R.Timestamp;
            // A restored call needs the same verdict as a live one. Missing
            // this is what made history render as uniformly successful.
            Call.Classify();
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
            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
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
                    // The turn's verdict. A header reading "3 calls" while one
                    // of them broke a constraint hides the only part that needs
                    // a decision.
                    + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                    .Padding(8.f, 0.f, 4.f, 0.f)
                    [
                        SNew(STextBlock)
                        // Word AND colour. A coloured dot alone is unreadable
                        // to anyone who cannot separate the hues, and needs-
                        // attention and needs-approval share the same ochre by
                        // design.
                        .Text_Lambda([Turn]()
                        {
                            if (!Turn.IsValid() || Turn->Calls.Num() == 0) return FText::GetEmpty();
                            const EHaybaStatus S = Turn->Status();
                            return FText::FromString(FString::Printf(TEXT("%s %s"),
                                HaybaStatus::Glyph(S), *HaybaStatus::Label(S).ToString()));
                        })
                        .ColorAndOpacity_Lambda([Turn]()
                        {
                            if (!Turn.IsValid() || Turn->Calls.Num() == 0)
                                return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted"));
                            return HaybaStatus::Colour(Turn->Status());
                        })
                        .ToolTipText_Lambda([Turn]() -> FText
                        {
                            if (!Turn.IsValid()) return FText::GetEmpty();
                            // Name the rule and the amount, not just the state.
                            for (const FHaybaToolCall& C : Turn->Calls)
                            {
                                if (C.bNeedsAttention)
                                {
                                    return FText::FromString(FString::Printf(
                                        TEXT("%s is short by %+.2f%s. Open Rules to fix it."),
                                        *C.WorstRuleId, C.WorstMargin, *C.WorstMarginUnit));
                                }
                            }
                            for (const FHaybaToolCall& C : Turn->Calls)
                            {
                                if (C.bIsError)
                                    return FText::FromString(TEXT("A tool call in this turn failed."));
                            }
                            return FText::FromString(TEXT("Every call in this turn completed."));
                        })
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
            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Accent.Ochre")))
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
            if (Call.ResultJson.StartsWith(TEXT("ERROR:"))) ++Errors;
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
        .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
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
        .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
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

/** Look for a rule that came back with a negative margin.
 *
 *  The validator attaches `{"validator":{"findings":[{...,"measurement":
 *  {"value":-0.62,"unit":"m"}}]}}` to a result. A negative value is the IA's
 *  "needs attention": the tool succeeded and the outcome breaks a constraint.
 *
 *  A finding with NO measurement is not treated as attention-worthy here. It
 *  may still be a warning, but without an amount there is nothing to show
 *  beside it, and the whole point of this state is carrying the amount.
 */
static bool FindWorstNegativeMargin(const FString& ResultJson,
    double& OutValue, FString& OutUnit, FString& OutRuleId)
{
    // Cheap reject first. Parsing every result would mean running a JSON
    // reader over every tool response, most of which have no validator block.
    if (!ResultJson.Contains(TEXT("\"validator\""))) return false;

    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResultJson);
    TSharedPtr<FJsonObject> Root;
    if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid()) return false;

    const TSharedPtr<FJsonObject>* Validator = nullptr;
    if (!Root->TryGetObjectField(TEXT("validator"), Validator) || !Validator || !Validator->IsValid())
        return false;

    const TArray<TSharedPtr<FJsonValue>>* Findings = nullptr;
    if (!(*Validator)->TryGetArrayField(TEXT("findings"), Findings) || !Findings) return false;

    bool bFound = false;
    for (const TSharedPtr<FJsonValue>& V : *Findings)
    {
        const TSharedPtr<FJsonObject>* F = nullptr;
        if (!V.IsValid() || !V->TryGetObject(F) || !F || !F->IsValid()) continue;

        const TSharedPtr<FJsonObject>* Meas = nullptr;
        if (!(*F)->TryGetObjectField(TEXT("measurement"), Meas) || !Meas || !Meas->IsValid()) continue;

        double Value = 0.0;
        if (!(*Meas)->TryGetNumberField(TEXT("value"), Value)) continue;
        if (Value >= 0.0) continue;

        // Worst-wins, so the chip reports the biggest problem rather than
        // whichever finding happened to be listed first.
        if (!bFound || Value < OutValue)
        {
            bFound = true;
            OutValue = Value;
            (*Meas)->TryGetStringField(TEXT("unit"), OutUnit);
            (*F)->TryGetStringField(TEXT("ruleId"), OutRuleId);
        }
    }
    return bFound;
}

void FHaybaToolCall::Classify()
{
    bIsError = ResultJson.StartsWith(TEXT("ERROR:"));
    bNeedsAttention = false;
    WorstMargin = 0.0;
    WorstMarginUnit.Reset();
    WorstRuleId.Reset();

    // An outright failure is not "needs attention": there is no margin to
    // report and nothing to move.
    if (bIsError) return;

    bNeedsAttention = FindWorstNegativeMargin(
        ResultJson, WorstMargin, WorstMarginUnit, WorstRuleId);
}

void SHaybaMCPToolStreamPanel::AddToolCall(const FString& ToolName, const FString& ParamsJson, const FString& ResultJson)
{
    if (Turns.IsEmpty()) BeginNewTurn();
    FHaybaToolCall Call;
    Call.ToolName     = ToolName;
    Call.ParamsJson   = ParamsJson;
    Call.ResultJson   = ResultJson;
    Call.RendererType = ResolveRenderer(ToolName);
    Call.Timestamp    = FDateTime::Now();
    Call.Classify();
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
    // Classified when the call was recorded, not re-derived here. The two used
    // to be computed in different places from the same string.
    const bool bIsError = Call.bIsError;
    const FLinearColor DomainColor = bIsError
        ? FHaybaMCPStyle::Colour("Hayba.Color.Status.Fail")
        : ColorForRenderer(Call.RendererType);
    const FString TypeChip = bIsError ? TEXT("ERROR") : LabelForRenderer(Call.RendererType);
    const FString TimeStr  = Call.Timestamp.ToString(TEXT("%H:%M:%S"));
    const FString PreviewParams = (Call.ParamsJson.IsEmpty() || Call.ParamsJson == TEXT("{}"))
        ? TEXT("") : Call.ParamsJson.Left(140);
    const FString PreviewResult = Call.ResultJson.Left(220);
    // One vocabulary. This dot used to be a local error/pass choice, so a call
    // that succeeded while breaking a rule showed a clean green tick.
    const EHaybaStatus CallStatus = bIsError
        ? EHaybaStatus::Error
        : (Call.bNeedsAttention ? EHaybaStatus::NeedsAttention : EHaybaStatus::Done);
    const FSlateColor StatusDot = HaybaStatus::Colour(CallStatus);

    // Copy this row -- captured by value so the lambda survives.
    FHaybaToolCall CallCopy = Call;

    return SNew(SBorder)
        .BorderImage(FAppStyle::Get().GetBrush("Brushes.Panel"))
        .Padding(FMargin(10.f, 8.f))
        [
            SNew(SVerticalBox)
            // Header row.
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 4.f)
            [
                SNew(SHorizontalBox)
                // Status dot — selection now lives on the turn header, not per call.
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 8.f, 0.f)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(StatusDot)
                    // The glyph comes from the vocabulary too, so a state that
                    // is not "done" does not silently reuse the done shape.
                    .Text(FText::FromString(HaybaStatus::Glyph(CallStatus)))
                    .ToolTipText(FText::FromString(
                        CallStatus == EHaybaStatus::NeedsAttention
                            ? FString::Printf(TEXT("%s: %+.2f%s - needs attention"),
                                *Call.WorstRuleId, Call.WorstMargin, *Call.WorstMarginUnit)
                            : HaybaStatus::Label(CallStatus).ToString()))
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 8.f, 0.f)
                [
                    SNew(SBorder)
                    .BorderImage(FAppStyle::Get().GetBrush("Brushes.Header"))
                    .Padding(FMargin(6.f, 2.f))
                    [
                        SNew(STextBlock)
                        .ColorAndOpacity(FSlateColor(DomainColor))
                        .Text(FText::FromString(TypeChip))
                    ]
                ]
                + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(DomainColor))
                    .Text(FText::FromString(Call.ToolName))
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 6.f, 0.f)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
                    .Text(FText::FromString(TimeStr))
                ]
                // Per-row copy button — UE5 stock simple-button.
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(SButton)
                    .ButtonStyle(FAppStyle::Get(), "SimpleButton")
                    .ToolTipText(NSLOCTEXT("Hayba", "Stream.CopyRowTT", "Copy this tool call as JSON"))
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
            // Params line.
            + SVerticalBox::Slot().AutoHeight().Padding(18.f, 2.f, 0.f, 2.f)
            [
                SNew(SHorizontalBox)
                .Visibility(PreviewParams.IsEmpty() ? EVisibility::Collapsed : EVisibility::Visible)
                + SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 6.f, 0.f)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
                    .Text(FText::FromString(TEXT("params")))
                ]
                + SHorizontalBox::Slot().FillWidth(1.f)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary")))
                    .AutoWrapText(true)
                    .Text(FText::FromString(PreviewParams))
                ]
            ]
            // Result line.
            + SVerticalBox::Slot().AutoHeight().Padding(18.f, 2.f, 0.f, 0.f)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 6.f, 0.f)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
                    .Text(FText::FromString(bIsError ? TEXT("error") : TEXT("→")))
                ]
                + SHorizontalBox::Slot().FillWidth(1.f)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(bIsError
                        ? FHaybaMCPStyle::Colour("Hayba.Color.Status.Fail")
                        : FHaybaMCPStyle::Colour("Hayba.Color.Text.Primary")))
                    .AutoWrapText(true)
                    .Text(FText::FromString(PreviewResult))
                ]
            ]
        ];
}
