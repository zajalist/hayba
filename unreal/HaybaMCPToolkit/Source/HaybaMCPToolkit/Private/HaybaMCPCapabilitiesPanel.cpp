// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCapabilitiesPanel.cpp
#include "HaybaMCPCapabilitiesPanel.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPStyle.h"

#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Styling/CoreStyle.h"

#define LOCTEXT_NAMESPACE "HaybaMCPCapabilities"

void SHaybaMCPCapabilitiesPanel::Construct(const FArguments& InArgs)
{
    (void)InArgs;
    BuildCatalog();

    ChildSlot
    [
        SNew(SBorder)
        .BorderImage(FHaybaMCPStyle::GetBrush("Hayba.Brush.Dock"))
        .Padding(FMargin(0.f))
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(12.f, 12.f, 12.f, 8.f)
            [ BuildHeader() ]
            + SVerticalBox::Slot().AutoHeight().Padding(12.f, 0.f, 12.f, 10.f)
            [ BuildToolbar() ]
            + SVerticalBox::Slot().FillHeight(1.f).Padding(8.f, 0.f, 8.f, 8.f)
            [
                SNew(SScrollBox)
                + SScrollBox::Slot()
                [ SAssignNew(CategoryList, SVerticalBox) ]
            ]
        ]
    ];

    RebuildCategoryList();
}

// ── Header ────────────────────────────────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPCapabilitiesPanel::BuildHeader()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 5.f)
        [
            SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Heading"))
            .Text(LOCTEXT("HeaderTitle", "Tool permissions"))
        ]
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Body"))
            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary")))
            .AutoWrapText(true)
            .Text(LOCTEXT("PermissionConsequence",
                "Changes save immediately. Turning off a listed tool hides it from agents and rejects direct calls. Earlier changes remain."))
        ];
}

// ── Toolbar (search + bulk actions) ───────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPCapabilitiesPanel::BuildToolbar()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SEditableTextBox)
            .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
            .HintText(LOCTEXT("MCPSearchHint", "Search tools or categories"))
            .OnTextChanged(this, &SHaybaMCPCapabilitiesPanel::OnSearchChanged)
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(0.f, 8.f, 0.f, 0.f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth()
            [
                SNew(SButton)
                .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                .ContentPadding(FMargin(10.f, 5.f))
                .ToolTipText(LOCTEXT("EnableAllTT", "Enable every tool managed on this page, including tools hidden by search"))
                .OnClicked(this, &SHaybaMCPCapabilitiesPanel::OnEnableAll)
                .Text(LOCTEXT("EnableAll", "Enable managed tools"))
            ]
            + SHorizontalBox::Slot().AutoWidth().Padding(6.f, 0.f, 0.f, 0.f)
            [
                SNew(SButton)
                .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                .ContentPadding(FMargin(10.f, 5.f))
                .ToolTipText(LOCTEXT("DisableAllTT", "Disable every tool managed on this page, including tools hidden by search"))
                .OnClicked(this, &SHaybaMCPCapabilitiesPanel::OnDisableAll)
                .Text(LOCTEXT("DisableAll", "Disable managed tools"))
            ]
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
        TEXT("Tool discovery and constrained Python access. Disabling discovery can prevent agents from finding other tools."),
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

bool SHaybaMCPCapabilitiesPanel::IsCategoryOpen(const FCategoryEntry& Cat) const
{
    return FilterQuery.IsEmpty() ? Cat.bExpanded : !Cat.bSearchCollapsed;
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
    if (Cat.Title.ToString().Contains(FilterQuery, ESearchCase::IgnoreCase) ||
        Cat.Description.Contains(FilterQuery, ESearchCase::IgnoreCase)) return true;
    for (const FToolEntry& Tool : Cat.Tools) if (ToolMatchesFilter(Tool)) return true;
    return false;
}

// ── Toolbar handlers ──────────────────────────────────────────────────────

void SHaybaMCPCapabilitiesPanel::OnSearchChanged(const FText& InText)
{
    FilterQuery = InText.ToString().TrimStartAndEnd();
    for (FCategoryEntry& Cat : Categories) Cat.bSearchCollapsed = false;
    RebuildCategoryList();
}

FReply SHaybaMCPCapabilitiesPanel::OnEnableAll()
{
    for (const FCategoryEntry& Cat : Categories)
        for (const FToolEntry& Tool : Cat.Tools)
            SetToolEnabled(Tool.Name, true);
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
    // Row labels read the setting directly. Keep the focused permission control
    // and the user's expanded categories in place after a toggle.
    Invalidate(EInvalidateWidgetReason::Layout);
}

// ── List rebuild ──────────────────────────────────────────────────────────

void SHaybaMCPCapabilitiesPanel::RebuildCategoryList()
{
    if (!CategoryList.IsValid()) return;
    CategoryList->ClearChildren();

    int32 Matches = 0;
    for (int32 i = 0; i < Categories.Num(); ++i)
    {
        const FCategoryEntry& Cat = Categories[i];
        if (!CategoryMatchesFilter(Cat)) continue;
        ++Matches;

        CategoryList->AddSlot().AutoHeight().Padding(4.f, 0.f, 4.f, 8.f)
        [ BuildCategoryRow(i) ];
    }
    if (Matches == 0)
        CategoryList->AddSlot().AutoHeight().Padding(8.f, 12.f)
        [ SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Caption"))
            .Text(LOCTEXT("NoMatchingTools", "No matching tools or categories.")) ];
}

TSharedRef<SWidget> SHaybaMCPCapabilitiesPanel::BuildCategoryRow(int32 CategoryIndex)
{
    if (!Categories.IsValidIndex(CategoryIndex)) return SNullWidget::NullWidget;
    const FCategoryEntry& Cat = Categories[CategoryIndex];
    const bool bCategoryTextMatches = !FilterQuery.IsEmpty() &&
        (Cat.Title.ToString().Contains(FilterQuery, ESearchCase::IgnoreCase) ||
         Cat.Description.Contains(FilterQuery, ESearchCase::IgnoreCase));

    TSharedRef<SVerticalBox> Body = SNew(SVerticalBox);
    for (int32 t = 0; t < Cat.Tools.Num(); ++t)
    {
        if (!bCategoryTextMatches && !ToolMatchesFilter(Cat.Tools[t])) continue;
        Body->AddSlot().AutoHeight()
        [ BuildToolRow(CategoryIndex, t) ];
    }

    return SNew(SBorder)
        .BorderImage(FHaybaMCPStyle::GetBrush("Hayba.Brush.Settings.Section"))
        .Padding(FMargin(11.f, 8.f))
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                [
                    SNew(SButton)
                    .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Task"))
                    .ContentPadding(FMargin(0.f, 5.f))
                    .ToolTipText(LOCTEXT("CategoryDisclosureTT", "Show or hide tools in this category"))
                    .OnClicked_Lambda([this, CategoryIndex]()
                    {
                        FCategoryEntry& Current = Categories[CategoryIndex];
                        if (FilterQuery.IsEmpty()) Current.bExpanded = !Current.bExpanded;
                        else Current.bSearchCollapsed = !Current.bSearchCollapsed;
                        Invalidate(EInvalidateWidgetReason::Layout);
                        return FReply::Handled();
                    })
                    [
                        SNew(SHorizontalBox)
                        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                        [ SNew(STextBlock)
                            .Font(FHaybaMCPStyle::Font(13, true))
                            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Primary")))
                            .AutoWrapText(true)
                            .Text(Cat.Title) ]
                        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(7.f, 0.f, 2.f, 0.f)
                        [ SNew(SImage)
                            .Image_Lambda([this, CategoryIndex]() { return FHaybaMCPStyle::GetBrush(
                                IsCategoryOpen(Categories[CategoryIndex]) ? "Hayba.Icon.Chevron.Up" : "Hayba.Icon.Chevron.Down"); })
                            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary"))) ]
                    ]
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
                [
                    SNew(SButton)
                    .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                    .ContentPadding(FMargin(8.f, 5.f))
                    .ToolTipText(LOCTEXT("CategoryPermissionTT", "Applies to every tool in this category, including tools hidden by search"))
                    .Text_Lambda([this, CategoryIndex]()
                    {
                        const FCategoryEntry& Current = Categories[CategoryIndex];
                        return EnabledCountInCategory(Current) == Current.Tools.Num()
                            ? LOCTEXT("DisableGroup", "Disable group") : LOCTEXT("EnableGroup", "Enable group");
                    })
                    .OnClicked_Lambda([this, CategoryIndex]()
                    {
                        const FCategoryEntry& Current = Categories[CategoryIndex];
                        SetCategoryEnabled(Current, EnabledCountInCategory(Current) != Current.Tools.Num());
                        PersistAndNotify();
                        return FReply::Handled();
                    })
                ]
            ]
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SBox)
                .Visibility_Lambda([this, CategoryIndex]()
                { return IsCategoryOpen(Categories[CategoryIndex]) ? EVisibility::Visible : EVisibility::Collapsed; })
                [
                    SNew(SVerticalBox)
                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 8.f, 0.f, 7.f)
                    [ SNew(STextBlock)
                        .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Caption"))
                        .AutoWrapText(true)
                        .Text(FText::FromString(Cat.Description)) ]
                    + SVerticalBox::Slot().AutoHeight()
                    [ SNew(SSeparator).Thickness(1.f)
                        .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Border.Subtle"))) ]
                    + SVerticalBox::Slot().AutoHeight()
                    [ Body ]
                ]
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

    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(0.f, 8.f, 0.f, 0.f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
            [
                SNew(STextBlock)
                .Font(FCoreStyle::GetDefaultFontStyle("Mono", 10))
                .Text(FText::FromString(ToolName))
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Primary")))
                .AutoWrapText(true)
                .WrappingPolicy(ETextWrappingPolicy::AllowPerCharacterWrapping)
            ]
            + SHorizontalBox::Slot().AutoWidth().Padding(8.f, 0.f, 0.f, 0.f)
            [
                SNew(SButton)
                .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                .ContentPadding(FMargin(8.f, 4.f))
                .ToolTipText_Lambda([this, ToolName]()
                {
                    return IsToolEnabled(ToolName)
                        ? FText::Format(LOCTEXT("DisableToolTT", "Disable {0}; agents will no longer see or call it"), FText::FromString(ToolName))
                        : FText::Format(LOCTEXT("EnableToolTT", "Enable {0} for agents"), FText::FromString(ToolName));
                })
                .OnClicked_Lambda([this, ToolName]()
                {
                    SetToolEnabled(ToolName, !IsToolEnabled(ToolName));
                    PersistAndNotify();
                    return FReply::Handled();
                })
                [ SNew(STextBlock)
                    .Text_Lambda([this, ToolName]()
                    { return IsToolEnabled(ToolName) ? LOCTEXT("ToolEnabled", "Enabled") : LOCTEXT("ToolDisabled", "Disabled"); })
                    .ColorAndOpacity_Lambda([this, ToolName]() -> FSlateColor
                    { return FSlateColor(FHaybaMCPStyle::Colour(IsToolEnabled(ToolName)
                        ? "Hayba.Color.Text.Primary" : "Hayba.Color.Text.Secondary")); }) ]
            ]
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f, 0.f, 8.f)
        [
            SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Caption"))
            .Text(FText::FromString(ToolDesc))
            .AutoWrapText(true)
        ]
        + SVerticalBox::Slot().AutoHeight()
        [ SNew(SSeparator).Thickness(1.f)
            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Border.Subtle")))
        ];
}

#undef LOCTEXT_NAMESPACE
