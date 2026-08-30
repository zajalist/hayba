// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCapabilitiesPanel.cpp
#include "HaybaMCPCapabilitiesPanel.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPStyle.h"
#include "HaybaMCPModule.h"

#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Layout/SExpandableArea.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SSearchBox.h"
#include "Styling/AppStyle.h"

#define LOCTEXT_NAMESPACE "HaybaMCPCapabilities"

void SHaybaMCPCapabilitiesPanel::Construct(const FArguments& InArgs)
{
    Module = InArgs._Module;
    BuildCatalog();

    ChildSlot
    [
        SNew(SVerticalBox)
        // Hero header with MCP logo and explainer copy.
        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 12.f, 12.f, 6.f)
        [ BuildHeader() ]

        // Live status strip: online + agent count.
        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 0.f, 12.f, 8.f)
        [ BuildStatusStrip() ]

        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 0.f)
        [ SNew(SSeparator).Thickness(1.f) ]

        // Search + bulk actions.
        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 8.f)
        [ BuildToolbar() ]

        // Scrollable categorized list.
        + SVerticalBox::Slot().FillHeight(1.f).Padding(8.f, 0.f, 8.f, 8.f)
        [
            SNew(SScrollBox)
            + SScrollBox::Slot()
            [ SAssignNew(CategoryList, SVerticalBox) ]
        ]
    ];

    RebuildCategoryList();
}

// ── Header (logo + explainer) ─────────────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPCapabilitiesPanel::BuildHeader()
{
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 14.f, 0.f)
        [
            SNew(SBox).WidthOverride(64.f).HeightOverride(64.f)
            [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.MCP.Hero"))) ]
        ]
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 4.f)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
                .Text(LOCTEXT("HeaderTitle", "Model Context Protocol"))
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 2.f)
            [
                SNew(STextBlock)
                .ColorAndOpacity(FSlateColor(FLinearColor(0.78f, 0.80f, 0.88f)))
                .AutoWrapText(true)
                .Text_Lambda([this]()
                {
                    return FText::FromString(FString::Printf(
                        TEXT("Hayba exposes %d tools across %d domains to your AI agent. Toggle individual tools or whole categories off to limit what the remote agent can see and call."),
                        TotalTools(), Categories.Num()));
                })
            ]
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(STextBlock)
                .ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.57f, 0.65f)))
                .Text_Lambda([this]()
                {
                    return FText::FromString(FString::Printf(
                        TEXT("Currently exposing %d / %d tools."), TotalEnabledTools(), TotalTools()));
                })
            ]
        ];
}

// ── Status strip (online + agent count, live via lambdas) ────────────────

TSharedRef<SWidget> SHaybaMCPCapabilitiesPanel::BuildStatusStrip()
{
    // Two-line status: top = live status (dot + state + agent count),
    // bottom = static transport (TCP port + protocol). Avoids the right-side
    // crowding when the panel is narrow.
    const FLinearColor ColorOnline (0.40f, 0.95f, 0.55f);
    const FLinearColor ColorOffline(1.00f, 0.40f, 0.40f);
    const FLinearColor ColorMuted  (0.55f, 0.57f, 0.65f);

    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("Brushes.Panel"))
        .Padding(FMargin(10.f, 6.f))
        [
            SNew(SVerticalBox)
            // Top row: live state.
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 6.f, 0.f)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(TEXT("●")))
                    .ColorAndOpacity_Lambda([this, ColorOnline, ColorOffline]() -> FSlateColor
                    {
                        const bool bUp = Module && Module->IsTcpServerRunning();
                        return FSlateColor(bUp ? ColorOnline : ColorOffline);
                    })
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
                    .Text_Lambda([this]()
                    {
                        const bool bUp = Module && Module->IsTcpServerRunning();
                        return bUp
                            ? NSLOCTEXT("HaybaMCP", "Status.Online", "MCP server online")
                            : NSLOCTEXT("HaybaMCP", "Status.Offline", "MCP server offline");
                    })
                    .ColorAndOpacity_Lambda([this, ColorOnline, ColorOffline]() -> FSlateColor
                    {
                        const bool bUp = Module && Module->IsTcpServerRunning();
                        return FSlateColor(bUp ? ColorOnline : ColorOffline);
                    })
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 8.f, 0.f)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(TEXT("·")))
                    .ColorAndOpacity(FSlateColor(ColorMuted))
                ]
                + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
                    .ColorAndOpacity(FSlateColor(ColorMuted))
                    .Text_Lambda([this]()
                    {
                        const int32 N = Module ? Module->GetTcpClientCount() : 0;
                        return FText::FromString(FString::Printf(TEXT("%d agent%s connected"),
                            N, N == 1 ? TEXT("") : TEXT("s")));
                    })
                ]
            ]
            // Bottom row: transport info, muted.
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f, 0.f, 0.f)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
                .ColorAndOpacity(FSlateColor(ColorMuted))
                .Text(NSLOCTEXT("HaybaMCP", "Status.Port", "Transport: TCP :52342 · stdio"))
            ]
        ];
}

// ── Toolbar (search + bulk actions) ───────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPCapabilitiesPanel::BuildToolbar()
{
    // Stock UE5 button (not SimpleButton) so Enable/Disable read as buttons
    // rather than text links. Short search hint so it doesn't truncate at
    // narrow panel widths.
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
        [
            SNew(SSearchBox)
            .HintText(LOCTEXT("MCPSearchHint", "Search..."))
            .OnTextChanged(this, &SHaybaMCPCapabilitiesPanel::OnSearchChanged)
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(8.f, 0.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ContentPadding(FMargin(10.f, 3.f))
            .ToolTipText(LOCTEXT("EnableAllTT", "Re-enable every tool"))
            .OnClicked(this, &SHaybaMCPCapabilitiesPanel::OnEnableAll)
            [ SNew(STextBlock).Text(LOCTEXT("EnableAll", "Enable all")) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(4.f, 0.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ContentPadding(FMargin(10.f, 3.f))
            .ToolTipText(LOCTEXT("DisableAllTT", "Hide every tool from the agent"))
            .OnClicked(this, &SHaybaMCPCapabilitiesPanel::OnDisableAll)
            [ SNew(STextBlock).Text(LOCTEXT("DisableAll", "Disable all")) ]
        ];
}

// ── Catalog (hardcoded, mirrors the schema registry in tools/index.ts) ────

void SHaybaMCPCapabilitiesPanel::BuildCatalog()
{
    Categories.Reset();

    auto AddCategory = [this](const FText& Title, const FString& Description, std::initializer_list<TPair<const TCHAR*, const TCHAR*>> Tools)
    {
        FCategoryEntry Cat;
        Cat.Title = Title;
        Cat.Description = Description;
        for (const auto& T : Tools)
        {
            FToolEntry Entry;
            Entry.Name = T.Key;
            Entry.Description = T.Value;
            Cat.Tools.Add(MoveTemp(Entry));
        }
        Categories.Add(MoveTemp(Cat));
    };

    AddCategory(LOCTEXT("Cat.Meta", "Code Mode (meta-tools)"),
        TEXT("The three meta-tools the agent always sees first. Disabling these is rarely useful."),
        {
            { TEXT("list_tool_categories"), TEXT("Domain overview the agent calls first.") },
            { TEXT("get_tool_signature"),   TEXT("Returns the JSON schema for a specific tool.") },
            { TEXT("python_run"),           TEXT("Constrained embedded Unreal Python; Tier-3 host I/O is always refused. This is not process isolation (#392/#414).") },
        });

    AddCategory(LOCTEXT("Cat.Actor", "Actor"),
        TEXT("Spawn, transform, list, and inspect actors in the active level."),
        {
            { TEXT("actor_spawn"),     TEXT("Spawn a new actor by class path.") },
            { TEXT("actor_delete"),    TEXT("Destroy an existing actor.") },
            { TEXT("actor_transform"), TEXT("Move / rotate / scale an actor.") },
            { TEXT("actor_list"),      TEXT("Enumerate actors with optional class/tag filter.") },
        });

    AddCategory(LOCTEXT("Cat.Scene", "Scene"),
        TEXT("Export the scene graph for LLM reasoning and validate physics."),
        {
            { TEXT("scene_export"),            TEXT("Flat/relational/hierarchical scene export.") },
            { TEXT("scene_validate_physics"),  TEXT("Detect floating / interpenetrating actors.") },
        });

    AddCategory(LOCTEXT("Cat.Editor", "Editor"),
        TEXT("Run editor commands, capture the viewport, tail logs, PIE controls."),
        {
            { TEXT("editor_capture_viewport"),     TEXT("Take a screenshot of the active viewport.") },
            { TEXT("editor_start_pie"),            TEXT("Start Play-In-Editor.") },
            { TEXT("editor_stream_log"),           TEXT("Tail recent UE log lines.") },
        });

    AddCategory(LOCTEXT("Cat.PCGEx", "PCGEx — Catalog & Authoring"),
        TEXT("PCGExtendedToolkit catalog browsing, graph authoring, and validation."),
        {
            // TODO(gh#15): include_thumbnails support — node catalog is static PCGEx
            // metadata, not asset-backed, so GetAssetThumbnailBase64Png does not
            // apply here. Wire up when nodes carry preview UTexture2D refs.
            { TEXT("hayba_search_node_catalog"),         TEXT("Search the 344-node PCGEx catalog.") },
            { TEXT("hayba_get_node_details"),            TEXT("Get full pin + property docs for one node.") },
            { TEXT("hayba_create_pcg_graph"),            TEXT("Author a new PCG graph asset.") },
            { TEXT("hayba_validate_pcg_graph"),          TEXT("Structural validation of a graph JSON.") },
            { TEXT("hayba_list_pcg_assets"),             TEXT("List PCG assets under a content path.") },
            { TEXT("hayba_export_pcg_graph"),            TEXT("Export an existing PCG asset back to JSON.") },
            { TEXT("hayba_execute_pcg_graph"),           TEXT("Execute a graph on its components.") },
            { TEXT("hayba_scrape_node_registry"),        TEXT("Re-scan the PCGEx C++ source into the registry.") },
            { TEXT("hayba_match_pin_names"),             TEXT("Fuzzy-match a pin name across nodes.") },
            { TEXT("hayba_validate_attribute_flow"),     TEXT("Trace attribute reads/writes across a graph.") },
            { TEXT("hayba_diff_against_working_asset"),  TEXT("Diff a WIP graph against an in-UE asset.") },
            { TEXT("hayba_format_graph_topology"),       TEXT("Layout a graph (layered / grid algorithms).") },
            { TEXT("hayba_abstract_to_subgraph"),        TEXT("Extract a subgraph from a node selection.") },
            { TEXT("hayba_parameterize_graph_inputs"),   TEXT("Promote hardcoded values to parameters.") },
            { TEXT("hayba_query_pcgex_docs"),            TEXT("Free-text search of PCGEx docs.") },
            { TEXT("hayba_initiate_infrastructure_brainstorm"), TEXT("Plan a complex graph architecture (proposal only).") },
        });

    AddCategory(LOCTEXT("Cat.Conventions", "Conventions"),
        TEXT("Folder structure, naming conventions, project workflow."),
        {
            { TEXT("hayba_setup_conventions"),   TEXT("Multi-stage wizard to configure conventions.") },
            { TEXT("hayba_analyze_conventions"), TEXT("Infer conventions from an existing project.") },
        });

    AddCategory(LOCTEXT("Cat.Landscape", "Landscape & Zone Painter"),
        TEXT("Terrain ingestion and biome-painter dashboard."),
        {
            { TEXT("hayba_import_landscape"),     TEXT("Import a heightmap as a UE landscape actor.") },
            { TEXT("hayba_open_zone_painter"),    TEXT("Open the browser zone-painter dashboard.") },
            { TEXT("hayba_read_zones"),           TEXT("Read painted zones from a project session.") },
            { TEXT("hayba_set_painter_heightmap"),TEXT("Associate a heightmap with a painter project.") },
        });

    AddCategory(LOCTEXT("Cat.Status", "Status"),
        TEXT("Connectivity and meta queries."),
        {
            { TEXT("hayba_check_ue_status"), TEXT("Ping UE → returns version + plugin info.") },
        });
}

// ── Selection helpers ─────────────────────────────────────────────────────

bool SHaybaMCPCapabilitiesPanel::IsToolEnabled(const FString& ToolName) const
{
    return !FHaybaMCPSettings::Get().DisabledTools.Contains(ToolName);
}

void SHaybaMCPCapabilitiesPanel::SetToolEnabled(const FString& ToolName, bool bEnabled)
{
    if (bEnabled) FHaybaMCPSettings::Get().DisabledTools.Remove(ToolName);
    else          FHaybaMCPSettings::Get().DisabledTools.Add(ToolName);
}

void SHaybaMCPCapabilitiesPanel::SetCategoryEnabled(const FCategoryEntry& Cat, bool bEnabled)
{
    for (const FToolEntry& Tool : Cat.Tools) SetToolEnabled(Tool.Name, bEnabled);
}

int32 SHaybaMCPCapabilitiesPanel::EnabledCountInCategory(const FCategoryEntry& Cat) const
{
    int32 N = 0;
    for (const FToolEntry& Tool : Cat.Tools) if (IsToolEnabled(Tool.Name)) ++N;
    return N;
}

int32 SHaybaMCPCapabilitiesPanel::TotalToolsInCategory(const FCategoryEntry& Cat) const
{
    return Cat.Tools.Num();
}

int32 SHaybaMCPCapabilitiesPanel::TotalEnabledTools() const
{
    int32 N = 0;
    for (const FCategoryEntry& Cat : Categories) N += EnabledCountInCategory(Cat);
    return N;
}

int32 SHaybaMCPCapabilitiesPanel::TotalTools() const
{
    int32 N = 0;
    for (const FCategoryEntry& Cat : Categories) N += Cat.Tools.Num();
    return N;
}

bool SHaybaMCPCapabilitiesPanel::ToolMatchesFilter(const FToolEntry& Tool) const
{
    if (FilterQuery.IsEmpty()) return true;
    return Tool.Name.Contains(FilterQuery, ESearchCase::IgnoreCase)
        || Tool.Description.Contains(FilterQuery, ESearchCase::IgnoreCase);
}

bool SHaybaMCPCapabilitiesPanel::CategoryMatchesFilter(const FCategoryEntry& Cat) const
{
    if (FilterQuery.IsEmpty()) return true;
    if (Cat.Title.ToString().Contains(FilterQuery, ESearchCase::IgnoreCase)) return true;
    for (const FToolEntry& Tool : Cat.Tools) if (ToolMatchesFilter(Tool)) return true;
    return false;
}

// ── Toolbar handlers ──────────────────────────────────────────────────────

void SHaybaMCPCapabilitiesPanel::OnSearchChanged(const FText& InText)
{
    FilterQuery = InText.ToString().TrimStartAndEnd();
    RebuildCategoryList();
}

FReply SHaybaMCPCapabilitiesPanel::OnEnableAll()
{
    FHaybaMCPSettings::Get().DisabledTools.Empty();
    PersistAndNotify();
    return FReply::Handled();
}

FReply SHaybaMCPCapabilitiesPanel::OnDisableAll()
{
    auto& S = FHaybaMCPSettings::Get();
    for (const FCategoryEntry& Cat : Categories)
        for (const FToolEntry& Tool : Cat.Tools)
            S.DisabledTools.Add(Tool.Name);
    PersistAndNotify();
    return FReply::Handled();
}

void SHaybaMCPCapabilitiesPanel::PersistAndNotify()
{
    FHaybaMCPSettings::Get().Save();   // also writes Saved/HaybaMCP/disabled-tools.json
    RebuildCategoryList();
}

// ── List rebuild ──────────────────────────────────────────────────────────

void SHaybaMCPCapabilitiesPanel::RebuildCategoryList()
{
    if (!CategoryList.IsValid()) return;
    CategoryList->ClearChildren();

    for (int32 i = 0; i < Categories.Num(); ++i)
    {
        const FCategoryEntry& Cat = Categories[i];
        if (!CategoryMatchesFilter(Cat)) continue;

        CategoryList->AddSlot().AutoHeight().Padding(4.f, 3.f)
        [ BuildCategoryRow(i) ];
    }
}

TSharedRef<SWidget> SHaybaMCPCapabilitiesPanel::BuildCategoryRow(int32 CategoryIndex)
{
    if (!Categories.IsValidIndex(CategoryIndex)) return SNullWidget::NullWidget;
    const FCategoryEntry& Cat = Categories[CategoryIndex];

    TSharedRef<SVerticalBox> Body = SNew(SVerticalBox);
    for (int32 t = 0; t < Cat.Tools.Num(); ++t)
    {
        if (!ToolMatchesFilter(Cat.Tools[t])) continue;
        Body->AddSlot().AutoHeight().Padding(0.f, 1.f)
        [ BuildToolRow(CategoryIndex, t) ];
    }

    // Category checkbox state: checked when all enabled, unchecked when all
    // disabled, undetermined when partial.
    auto GetCategoryState = [this, CategoryIndex]()
    {
        const FCategoryEntry& C = Categories[CategoryIndex];
        const int32 En = EnabledCountInCategory(C);
        if (En == 0) return ECheckBoxState::Unchecked;
        if (En == C.Tools.Num()) return ECheckBoxState::Checked;
        return ECheckBoxState::Undetermined;
    };

    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("Brushes.Panel"))
        .Padding(FMargin(8.f, 6.f))
        [
            SNew(SExpandableArea)
            .InitiallyCollapsed(true)
            .HeaderContent()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 8.f, 0.f)
                [
                    SNew(SCheckBox)
                    .IsChecked_Lambda(GetCategoryState)
                    .OnCheckStateChanged_Lambda([this, CategoryIndex](ECheckBoxState NewState)
                    {
                        const bool bOn = (NewState != ECheckBoxState::Unchecked);
                        SetCategoryEnabled(Categories[CategoryIndex], bOn);
                        PersistAndNotify();
                    })
                ]
                + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
                    .Text(Cat.Title)
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
                [
                    SNew(STextBlock)
                    .ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.57f, 0.65f)))
                    .Text_Lambda([this, CategoryIndex]()
                    {
                        const FCategoryEntry& C = Categories[CategoryIndex];
                        return FText::FromString(FString::Printf(TEXT("%d / %d"),
                            EnabledCountInCategory(C), TotalToolsInCategory(C)));
                    })
                ]
            ]
            .BodyContent()
            [
                SNew(SVerticalBox)
                // Category description: small, italic-styled, muted. Less
                // visual competition with the tool list below.
                + SVerticalBox::Slot().AutoHeight().Padding(30.f, 4.f, 8.f, 8.f)
                [
                    SNew(STextBlock)
                    .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
                    .Text(FText::FromString(Cat.Description))
                    .ColorAndOpacity(FSlateColor(FLinearColor(0.50f, 0.52f, 0.60f)))
                    .AutoWrapText(true)
                ]
                + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f, 0.f, 4.f)
                [ Body ]
            ]
        ];
}

TSharedRef<SWidget> SHaybaMCPCapabilitiesPanel::BuildToolRow(int32 CategoryIndex, int32 ToolIndex)
{
    if (!Categories.IsValidIndex(CategoryIndex)) return SNullWidget::NullWidget;
    const FCategoryEntry& Cat = Categories[CategoryIndex];
    if (!Cat.Tools.IsValidIndex(ToolIndex)) return SNullWidget::NullWidget;
    const FString ToolName = Cat.Tools[ToolIndex].Name;
    const FString ToolDesc = Cat.Tools[ToolIndex].Description;

    // Use a mono font for the tool identifier so it reads as a callable name.
    const FSlateFontInfo MonoFont = FCoreStyle::GetDefaultFontStyle("Mono", 9);

    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Top).Padding(8.f, 4.f, 10.f, 0.f)
        [
            SNew(SCheckBox)
            .IsChecked_Lambda([this, ToolName]()
            {
                return IsToolEnabled(ToolName) ? ECheckBoxState::Checked : ECheckBoxState::Unchecked;
            })
            .OnCheckStateChanged_Lambda([this, ToolName](ECheckBoxState NewState)
            {
                SetToolEnabled(ToolName, NewState == ECheckBoxState::Checked);
                PersistAndNotify();
            })
        ]
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(0.f, 3.f, 0.f, 3.f)
        [
            SNew(SVerticalBox)
            // Tool identifier on top — primary visual weight.
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(STextBlock)
                .Font(MonoFont)
                .Text(FText::FromString(ToolName))
                .ColorAndOpacity(FSlateColor(FLinearColor(0.92f, 0.93f, 0.96f)))
            ]
            // Description below — supporting text, muted, wraps cleanly.
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 1.f, 0.f, 0.f)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
                .Text(FText::FromString(ToolDesc))
                .ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.57f, 0.65f)))
                .AutoWrapText(true)
            ]
        ];
}

#undef LOCTEXT_NAMESPACE
