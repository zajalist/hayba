#include "HaybaMCPMainPanel.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPStyle.h"
#include "HaybaMCPChatPanel.h"
#include "HaybaMCPToolStreamPanel.h"
#include "HaybaMCPSceneMapPanel.h"
#include "HaybaMCPPlanPanel.h"
#include "HaybaMCPDiffPanel.h"
#include "HaybaMCPValidationPanel.h"
#include "Slate/SHaybaValidatorPanel.h"
#include "HaybaMCPMemoryPanel.h"
#include "HaybaMCPLessonsPanel.h"
#include "HaybaMCPCapabilitiesPanel.h"
#include "HaybaMCPSceneMapWebPanel.h"
#include "HaybaMCPOnboardingWidget.h"
#include "HaybaMCPSettingsPanel.h"
#include "HaybaMCPSettings.h"
#include "Recipes/SRecipesPanel.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Layout/SSplitter.h"
#include "Interfaces/IPluginManager.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Styling/AppStyle.h"

namespace
{
    // Destination labels: the five nouns plus the gear. The old tab names live
    // on as section labels below.
    FText PanelLabel(EHaybaPanel P)
    {
        switch (P)
        {
            case EHaybaPanel::World:    return NSLOCTEXT("Hayba", "Nav.World",    "World");
            case EHaybaPanel::Library:  return NSLOCTEXT("Hayba", "Nav.Library",  "Library");
            case EHaybaPanel::Rules:    return NSLOCTEXT("Hayba", "Nav.Rules",    "Rules");
            case EHaybaPanel::Activity: return NSLOCTEXT("Hayba", "Nav.Activity", "Activity");
            case EHaybaPanel::Chat:     return NSLOCTEXT("Hayba", "Nav.Chat",     "Chat");
            case EHaybaPanel::Settings: return NSLOCTEXT("Hayba", "Nav.Settings", "Settings");
        }
        return FText::GetEmpty();
    }

    // The enum name, the label and the icon key now agree. They previously
    // disagreed badly enough that Memory drew the Library icon while Lessons
    // drew Memory's.
    FName PanelIcon(EHaybaPanel P)
    {
        switch (P)
        {
            case EHaybaPanel::World:    return TEXT("Hayba.Icon.World");
            case EHaybaPanel::Library:  return TEXT("Hayba.Icon.Library");
            case EHaybaPanel::Rules:    return TEXT("Hayba.Icon.Rules");
            case EHaybaPanel::Activity: return TEXT("Hayba.Icon.Activity");
            case EHaybaPanel::Chat:     return TEXT("Hayba.Icon.Chat");
            case EHaybaPanel::Settings: return TEXT("Hayba.Icon.Settings");
        }
        return NAME_None;
    }

    FText SectionLabel(EHaybaSection S)
    {
        switch (S)
        {
            case EHaybaSection::Chat:       return NSLOCTEXT("Hayba", "Sec.Chat",       "Chat");
            case EHaybaSection::MCP:        return NSLOCTEXT("Hayba", "Sec.MCP",        "Tools");
            case EHaybaSection::Recipes:    return NSLOCTEXT("Hayba", "Sec.Recipes",    "Recipes");
            case EHaybaSection::ToolStream: return NSLOCTEXT("Hayba", "Sec.Stream",     "Live");
            case EHaybaSection::SceneMap:   return NSLOCTEXT("Hayba", "Sec.SceneMap",   "Map");
            case EHaybaSection::Plan:       return NSLOCTEXT("Hayba", "Sec.Plan",       "Plans");
            case EHaybaSection::Diff:       return NSLOCTEXT("Hayba", "Sec.Diff",       "Changes");
            case EHaybaSection::Validation: return NSLOCTEXT("Hayba", "Sec.Validation", "Verdicts");
            case EHaybaSection::Memory:     return NSLOCTEXT("Hayba", "Sec.Profiles",   "Profiles");
            case EHaybaSection::Lessons:    return NSLOCTEXT("Hayba", "Sec.Lessons",    "Lessons");
            case EHaybaSection::Settings:   return NSLOCTEXT("Hayba", "Sec.Settings",   "Connection");
        }
        return FText::GetEmpty();
    }
}

// Which views each destination owns. Every one of the eleven sections appears
// exactly once, so this moves navigation without hiding anything: the three
// "what is the agent doing" tabs become Activity's views, the two "what must be
// true" tabs become Rules', and so on.
TArray<EHaybaSection> SHaybaMCPMainPanel::SectionsFor(EHaybaPanel Panel)
{
    switch (Panel)
    {
        case EHaybaPanel::World:    return { EHaybaSection::SceneMap };
        case EHaybaPanel::Library:  return { EHaybaSection::Memory, EHaybaSection::Recipes };
        case EHaybaPanel::Rules:    return { EHaybaSection::Validation, EHaybaSection::Lessons };
        case EHaybaPanel::Activity: return { EHaybaSection::ToolStream, EHaybaSection::Plan, EHaybaSection::Diff };
        case EHaybaPanel::Chat:     return { EHaybaSection::Chat };
        case EHaybaPanel::Settings: return { EHaybaSection::Settings, EHaybaSection::MCP };
    }
    return {};
}

EHaybaPanel SHaybaMCPMainPanel::PanelForSection(EHaybaSection Section)
{
    for (EHaybaPanel P : { EHaybaPanel::World, EHaybaPanel::Library, EHaybaPanel::Rules,
                           EHaybaPanel::Activity, EHaybaPanel::Chat, EHaybaPanel::Settings })
    {
        if (SectionsFor(P).Contains(Section)) return P;
    }
    return EHaybaPanel::Chat;
}

void SHaybaMCPMainPanel::Construct(const FArguments& InArgs, FHaybaMCPModule* InModule)
{
    // Register the dock root so ui_capture_panel can screenshot it. Done first
    // so a capture during construction still finds a valid widget.
    if (InModule) InModule->MainPanel = SharedThis(this);

    Module = InModule;

    ChildSlot
    [
        SNew(SBorder)
        .BorderImage(FAppStyle::Get().GetBrush("ToolPanel.GroupBorder"))
        .Padding(0)
        [
            // Overlay so the watermark sits at bottom-right above everything.
            SNew(SOverlay)
            + SOverlay::Slot()
            [
                // SSplitter lets the user drag the sidebar boundary. We track
                // the resulting sidebar width via Tick on the sidebar wrapper
                // and drive IsSidebarCompact() from that, so dragging it
                // narrow → labels collapse to icons.
                SNew(SSplitter)
                .Orientation(Orient_Horizontal)
                .PhysicalSplitterHandleSize(2.f)
                .HitDetectionSplitterHandleSize(6.f)
                + SSplitter::Slot()
                .Value(0.16f).MinSize(40.f)
                [
                    SAssignNew(SidebarWrapper, SBorder)
                    .BorderImage(FAppStyle::Get().GetBrush("Brushes.Header"))
                    .Padding(FMargin(0, 6))
                    [ BuildSidebar() ]
                ]
                + SSplitter::Slot()
                .Value(0.84f)
                [
                    SAssignNew(ContentArea, SBox)
                    .Padding(FMargin(10.f, 8.f))
                    [ BuildPanelContent(EHaybaSection::Chat) ]
                ]
            ]
            // Watermark — tiny logo + version, bottom-right, low opacity.
            + SOverlay::Slot()
            .HAlign(HAlign_Right)
            .VAlign(VAlign_Bottom)
            .Padding(FMargin(0, 0, 10, 6))
            [ BuildWatermark() ]
        ]
    ];
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildWatermark()
{
    // Resolve the plugin's version from its descriptor so a uplugin bump
    // shows up here automatically.
    FString Version = TEXT("");
    if (TSharedPtr<IPlugin> Plug = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit")))
    {
        Version = Plug->GetDescriptor().VersionName;
    }

    return SNew(SHorizontalBox)
        .RenderOpacity(0.45f)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(SBox).HeightOverride(12.f).WidthOverride(10.f)
            [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Logo.Small"))) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(4.f, 0.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
            .Text(FText::FromString(Version.IsEmpty()
                ? FString(TEXT("Hayba"))
                : FString::Printf(TEXT("Hayba v%s"), *Version)))
        ];
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildHeader()
{
    // Compact header — matches the height of stock UE5 panel toolbars
    // (Outliner, Details) so docking next to them looks consistent.
    return SNew(SBorder)
        .BorderImage(FAppStyle::Get().GetBrush("Brushes.Background"))
        .Padding(FMargin(10.f, 6.f))
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(SBox).HeightOverride(20.f).WidthOverride(16.f)
                [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Logo.Small"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
                .Text(NSLOCTEXT("Hayba", "AppTitle", "Hayba MCP Toolkit"))
            ]
            + SHorizontalBox::Slot().FillWidth(1.f)
            [ SNew(SBox) ]
            // The gear. Right-aligned in the chrome so configuration is
            // reachable without standing beside the five nouns as a peer.
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(SButton)
                .ButtonStyle(FAppStyle::Get(), "HoverHintOnly")
                .ToolTipText(NSLOCTEXT("Hayba", "OpenSettings",
                    "Settings — connection, backend, sidecar, Plan Mode, capabilities"))
                .ContentPadding(FMargin(4.f, 2.f))
                .OnClicked(this, &SHaybaMCPMainPanel::OnSidebarClick, EHaybaPanel::Settings)
                [
                    SNew(SBox).WidthOverride(16.f).HeightOverride(16.f)
                    [
                        SNew(SImage)
                        .Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Settings")))
                        .ColorAndOpacity_Lambda([this]()
                        {
                            // Ochre marks the ACTIVE destination throughout the
                            // dock; the gear follows the same rule so it reads
                            // as selected when Settings is open.
                            return CurrentPanel == EHaybaPanel::Settings
                                ? FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Accent.Ochre"))
                                : FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary"));
                        })
                    ]
                ]
            ]
        ];
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildSidebar()
{
    SAssignNew(Sidebar, SVerticalBox);

    // FIVE destinations, ordered the way the work flows: ask, watch it happen,
    // check it against the rules, look at the world it changed, reach for what
    // to place next.
    //
    // Settings is deliberately NOT here. The IA is explicit: "Settings is a
    // gear action in the chrome, not a peer destination ... so configuration
    // does not compete with the five nouns." It lived in this list with
    // identical treatment, which made it a sixth noun. It is now the gear in
    // the header.
    TArray<EHaybaPanel> Items = {
        EHaybaPanel::Chat, EHaybaPanel::Activity, EHaybaPanel::Rules,
        EHaybaPanel::World, EHaybaPanel::Library,
    };
    for (EHaybaPanel P : Items)
    {
        Sidebar->AddSlot().AutoHeight().Padding(FMargin(4.f, 1.f))
        [ BuildSidebarItem(P, PanelIcon(P), PanelLabel(P)) ];
    }
    return Sidebar.ToSharedRef();
}

void SHaybaMCPMainPanel::Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime)
{
    SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
    if (SidebarWrapper.IsValid())
    {
        LastSidebarWidth = SidebarWrapper->GetTickSpaceGeometry().GetLocalSize().X;
    }
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildSidebarItem(EHaybaPanel Panel, const FName& IconBrushName, const FText& Label)
{
    // Icon size: when the sidebar is compact (no labels), icons get bigger
    // to claim the full available strip — easier to hit and easier to scan.
    // When expanded, icons stay at standard tab size since the label carries
    // most of the recognition load.
    auto IconSize = [this]() -> FOptionalSize
    {
        if (IsSidebarCompact())
        {
            // Compact: ~80% of the strip width, room for some breathing.
            const float Sz = FMath::Clamp(LastSidebarWidth * 0.65f, 22.f, 30.f);
            return FOptionalSize(Sz);
        }
        return FOptionalSize(20.f);
    };

    return SNew(SButton)
        .ButtonStyle(FAppStyle::Get(), "HoverHintOnly")
        .ContentPadding(FMargin(4.f, 5.f))
        .HAlign(HAlign_Fill)
        .ToolTipText(Label)
        .OnClicked(this, &SHaybaMCPMainPanel::OnSidebarClick, Panel)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).HAlign(HAlign_Center)
            [
                SNew(SBox)
                .WidthOverride_Lambda(IconSize)
                .HeightOverride_Lambda(IconSize)
                [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(IconBrushName)) ]
            ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
                .Text(Label)
                .Visibility_Lambda([this]()
                {
                    return IsSidebarCompact() ? EVisibility::Collapsed : EVisibility::Visible;
                })
            ]
        ];
}

FReply SHaybaMCPMainPanel::OnSidebarClick(EHaybaPanel Panel)
{
    ShowPanel(Panel);
    return FReply::Handled();
}

void SHaybaMCPMainPanel::ShowPanel(EHaybaPanel Panel)
{
    const TArray<EHaybaSection> Sections = SectionsFor(Panel);
    if (Sections.Num() == 0) return;

    // Returning to a destination lands on the view you left it on, not on its
    // first one -- switching to Chat and back should not lose your place in
    // Activity.
    const EHaybaSection Target = Sections.Contains(CurrentSection) ? CurrentSection : Sections[0];
    CurrentPanel = Panel;
    ShowSection(Target);
}

void SHaybaMCPMainPanel::ShowSection(EHaybaSection Section)
{
    CurrentSection = Section;
    CurrentPanel = PanelForSection(Section);
    if (!ContentArea.IsValid()) return;

    // Cache-on-first-build: heavy widgets (CEF for the Map, the Library's file
    // reads) keep their state across switches instead of re-initializing.
    TSharedRef<SWidget> Content = SNullWidget::NullWidget;
    if (TSharedRef<SWidget>* Cached = PanelCache.Find(Section))
    {
        Content = *Cached;
        if (TFunction<void()>* Hook = PanelRefreshHook.Find(Section)) (*Hook)();
    }
    else
    {
        Content = BuildPanelContent(Section);
        PanelCache.Add(Section, Content);
    }

    // A destination with one view needs no tab strip; showing a single tab
    // would be chrome that explains nothing.
    const TArray<EHaybaSection> Siblings = SectionsFor(CurrentPanel);
    if (Siblings.Num() <= 1)
    {
        ContentArea->SetContent(Content);
        return;
    }

    ContentArea->SetContent(
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ BuildSectionTabs(CurrentPanel) ]
        + SVerticalBox::Slot().FillHeight(1.f)
        [ Content ]
    );
}

FReply SHaybaMCPMainPanel::OnSectionClick(EHaybaSection Section)
{
    ShowSection(Section);
    return FReply::Handled();
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildSectionTabs(EHaybaPanel Panel)
{
    TSharedRef<SHorizontalBox> Row = SNew(SHorizontalBox);
    for (EHaybaSection S : SectionsFor(Panel))
    {
        const bool bActive = (S == CurrentSection);
        Row->AddSlot().AutoWidth().Padding(FMargin(0.f, 0.f, 6.f, 0.f))
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .OnClicked(this, &SHaybaMCPMainPanel::OnSectionClick, S)
            .ContentPadding(FMargin(10.f, 4.f))
            [
                SNew(STextBlock)
                .Text(SectionLabel(S))
                .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.TabLabel"))
                // Ochre marks the active view, which is one of the four things
                // that token is reserved for.
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour(
                    bActive ? "Hayba.Color.Accent.Ochre" : "Hayba.Color.Text.Muted")))
            ]
        ];
    }
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("NoBorder"))
        .Padding(FMargin(10.f, 6.f, 10.f, 2.f))
        [ Row ];
}

void SHaybaMCPMainPanel::ShowOnboardingFromSplash()
{
    if (!ContentArea.IsValid()) return;
    TSharedRef<SDockTab> DummyOwner = SNew(SDockTab).TabRole(ETabRole::PanelTab);
    ContentArea->SetContent(SNew(SHaybaMCPOnboardingWidget, DummyOwner));
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildPanelContent(EHaybaSection Section)
{
    auto Heading = [this, Section](const FText& Sub)
    {
        // Compact, single-row heading: panel name + muted subtitle inline.
        // Sized to match Details / Outliner section headers.
        return SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
                .Text(SectionLabel(Section))
            ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(10.f, 0.f, 0.f, 0.f)
            [
                SNew(STextBlock)
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
                .Text(Sub)
            ];
    };

    TSharedPtr<SWidget> Body;
    FText Subtitle;
    switch (Section)
    {
        case EHaybaSection::Chat:
            Subtitle = NSLOCTEXT("Hayba", "Chat.Sub", "Talk to your AI in the editor.");
            // No accent stripe, no wrapping border — the Chat panel owns its
            // own layout and matches UE5's flat panel aesthetic.
            Body = SNew(SHaybaMCPChatPanel, Module).MainPanel(this);
            break;
        case EHaybaSection::MCP:
            Subtitle = NSLOCTEXT("Hayba", "MCP.Sub", "Pick which tools your AI agent can see.");
            Body = SNew(SHaybaMCPCapabilitiesPanel).Module(Module);
            break;
        case EHaybaSection::Recipes:
        {
            Subtitle = NSLOCTEXT("Hayba", "Recipes.Sub",
                "Deterministic abstractions — pick a recipe, set its parameters, run it.");
            auto Panel2 = SNew(SRecipesPanel);
            // Re-shown from cache → re-scan the installed recipes directory.
            PanelRefreshHook.Add(EHaybaSection::Recipes, [Panel2]() { Panel2->Refresh(); });
            Body = Panel2;
            break;
        }
        case EHaybaSection::ToolStream:
        {
            Subtitle = NSLOCTEXT("Hayba", "Stream.Sub", "Live trace of every tool call.");
            auto Panel2 = SNew(SHaybaMCPToolStreamPanel);
            if (Module) Module->ToolStreamPanel = Panel2;
            Body = Panel2;
            break;
        }
        case EHaybaSection::SceneMap:
        {
            Subtitle = NSLOCTEXT("Hayba", "Map.Sub",
                "Cognitive map of the level — cells labelled by dominant content. Click to select, drag to pan, wheel to zoom.");

            // Pick the renderer per user setting. Auto → Web for now; Phase 2
            // can later add a GPU heuristic. The two renderers share the
            // Refresh/Fit/Reset/GetCellCount surface but aren't a common type,
            // so we wire the toolbar lambdas to each in their own branch.
            const auto Pick = FHaybaMCPSettings::Get().SceneMapRenderer;
            const bool bUseWeb = (Pick == FHaybaMCPSettings::ESceneMapRenderer::Web
                              ||  Pick == FHaybaMCPSettings::ESceneMapRenderer::Auto);

            TSharedRef<SWidget> Canvas = SNullWidget::NullWidget;
            TFunction<void()> DoRefresh, DoFit, DoReset;
            TFunction<int32()> GetCount;

            if (bUseWeb)
            {
                TSharedRef<SHaybaMCPSceneMapWebPanel> W = SNew(SHaybaMCPSceneMapWebPanel);
                Canvas = W;
                DoRefresh = [W]() { W->Refresh(); };
                DoFit     = [W]() { W->FitView(); };
                DoReset   = [W]() { W->ResetView(); };
                GetCount  = [W]() { return W->GetCellCount(); };
            }
            else
            {
                TSharedRef<SHaybaMCPSceneMapPanel> N = SNew(SHaybaMCPSceneMapPanel);
                Canvas = N;
                DoRefresh = [N]() { N->Refresh(); };
                DoFit     = [N]() { N->FitView(); };
                DoReset   = [N]() { N->ResetView(); };
                GetCount  = [N]() { return N->GetCellCount(); };
            }
            // Re-shown from cache → re-scan the world.
            PanelRefreshHook.Add(EHaybaSection::SceneMap, DoRefresh);

            Body = SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(4.f, 4.f, 4.f, 4.f)
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().AutoWidth()
                    [
                        SNew(SButton)
                        .ContentPadding(FMargin(10.f, 3.f))
                        .ToolTipText(NSLOCTEXT("Hayba", "Map.RefreshTT",
                            "Re-scan the active level and rebuild the cognitive map."))
                        .OnClicked_Lambda([DoRefresh](){ DoRefresh(); return FReply::Handled(); })
                        [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "Map.Refresh", "Refresh")) ]
                    ]
                    + SHorizontalBox::Slot().AutoWidth().Padding(4.f, 0.f, 0.f, 0.f)
                    [
                        SNew(SButton)
                        .ContentPadding(FMargin(10.f, 3.f))
                        .ToolTipText(NSLOCTEXT("Hayba", "Map.FitTT",
                            "Center and zoom to fit all cells in view."))
                        .OnClicked_Lambda([DoFit](){ DoFit(); return FReply::Handled(); })
                        [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "Map.Fit", "Fit")) ]
                    ]
                    + SHorizontalBox::Slot().AutoWidth().Padding(4.f, 0.f, 0.f, 0.f)
                    [
                        SNew(SButton)
                        .ContentPadding(FMargin(10.f, 3.f))
                        .ToolTipText(NSLOCTEXT("Hayba", "Map.ResetTT",
                            "Reset pan to origin and zoom to 1×."))
                        .OnClicked_Lambda([DoReset](){ DoReset(); return FReply::Handled(); })
                        [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "Map.Reset", "Reset")) ]
                    ]
                    + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(12.f, 0.f, 0.f, 0.f)
                    [
                        SNew(STextBlock)
                        .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
                        .Text_Lambda([GetCount]()
                        {
                            const int32 N = GetCount();
                            return FText::FromString(FString::Printf(TEXT("%d cell%s · %s renderer"),
                                N, N == 1 ? TEXT("") : TEXT("s"),
                                FHaybaMCPSettings::Get().SceneMapRenderer == FHaybaMCPSettings::ESceneMapRenderer::Native
                                    ? TEXT("native") : TEXT("web")));
                        })
                    ]
                ]
                + SVerticalBox::Slot().AutoHeight()
                [ SNew(SSeparator).Thickness(1.f) ]
                + SVerticalBox::Slot().FillHeight(1.f)
                [
                    SNew(SBorder)
                    .BorderImage(FAppStyle::Get().GetBrush("Brushes.Recessed"))
                    .Padding(FMargin(0.f))
                    [ Canvas ]
                ];
            break;
        }
        case EHaybaSection::Plan:
        {
            Subtitle = NSLOCTEXT("Hayba", "Plan.Sub", "AI-proposed plan steps before destructive actions.");
            auto Panel2 = SNew(SHaybaMCPPlanPanel);
            if (Module) Module->PlanPanel = Panel2;
            Body = Panel2;
            break;
        }
        case EHaybaSection::Diff:
        {
            Subtitle = NSLOCTEXT("Hayba", "Diff.Sub", "Before / after for every destructive op.");
            auto Panel2 = SNew(SHaybaMCPDiffPanel);
            if (Module) Module->DiffPanel = Panel2;
            Body = Panel2;
            break;
        }
        case EHaybaSection::Validation:
        {
            Subtitle = NSLOCTEXT("Hayba", "Val.Sub",
                "Runtime validator: post-condition findings and AI-floppy hints. Findings persist in .scratch/validator-history.jsonl.");
            auto Panel2 = SNew(SHaybaValidatorPanel);
            // Re-shown from cache → re-read the JSONL file.
            PanelRefreshHook.Add(EHaybaSection::Validation, [Panel2]() { Panel2->Refresh(); });
            Body = Panel2;
            break;
        }
        case EHaybaSection::Memory:
        {
            Subtitle = NSLOCTEXT("Hayba", "Lib.Sub", "Semantic Library — every profiled asset, its masks/constraints, and Open-in-Studio.");
            auto Panel2 = SNew(SHaybaMCPMemoryPanel);
            if (Module) Module->MemoryPanel = Panel2;
            Body = Panel2;
            break;
        }
        case EHaybaSection::Lessons:
        {
            Subtitle = NSLOCTEXT("Hayba", "Lessons.Sub", "Accumulated [[slug]] lessons that explain why constraints exist.");
            Body = SNew(SHaybaLessonsPanel);
            break;
        }
        case EHaybaSection::Settings:
        {
            Subtitle = NSLOCTEXT("Hayba", "Settings.Sub", "Configuration for connection, AI backend, sidecar, plan mode, and onboarding.");
            Body = SNew(SHaybaMCPSettingsPanel).MainPanel(this);
            break;
        }
    }

    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ Heading(Subtitle) ]
        + SVerticalBox::Slot().FillHeight(1.f)
        [ Body.IsValid() ? Body.ToSharedRef() : SNullWidget::NullWidget ];
}
