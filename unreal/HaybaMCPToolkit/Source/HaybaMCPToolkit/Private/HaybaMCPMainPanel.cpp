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
#include "Slivers/SSliversPanel.h"
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
#include "Widgets/Input/SComboButton.h"
#include "Framework/MultiBox/MultiBoxBuilder.h"
#include "Styling/AppStyle.h"
#include "Styling/CoreStyle.h"

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

    const FSlateBrush* PanelIcon(EHaybaPanel P)
    {
        switch (P)
        {
            case EHaybaPanel::Chat:     return FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Nav.Chat"));
            case EHaybaPanel::Activity: return FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Nav.Activity"));
            case EHaybaPanel::Rules:    return FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Nav.Rules"));
            case EHaybaPanel::World:    return FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Nav.World"));
            case EHaybaPanel::Library:  return FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Nav.Library"));
            case EHaybaPanel::Settings: return FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Nav.Settings"));
        }
        return nullptr;
    }

    FText SectionLabel(EHaybaSection S)
    {
        switch (S)
        {
            case EHaybaSection::Chat:       return NSLOCTEXT("Hayba", "Sec.Chat",       "Chat");
            case EHaybaSection::MCP:        return NSLOCTEXT("Hayba", "Sec.MCP",        "Tools");
            case EHaybaSection::Slivers:    return NSLOCTEXT("Hayba", "Sec.Recipes",    "Recipes");
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
        case EHaybaPanel::Library:  return { EHaybaSection::Memory, EHaybaSection::Slivers };
        case EHaybaPanel::Rules:    return { EHaybaSection::Validation, EHaybaSection::Lessons };
        case EHaybaPanel::Activity: return { EHaybaSection::ToolStream, EHaybaSection::Plan, EHaybaSection::Diff };
        case EHaybaPanel::Chat:     return { EHaybaSection::Chat };
        case EHaybaPanel::Settings: return { EHaybaSection::Settings, EHaybaSection::MCP };
    }
    return {};
}

EHaybaPanel SHaybaMCPMainPanel::PanelForSection(EHaybaSection Section)
{
    for (EHaybaPanel P : { EHaybaPanel::Chat, EHaybaPanel::World,
                           EHaybaPanel::Activity, EHaybaPanel::Rules,
                           EHaybaPanel::Library, EHaybaPanel::Settings })
    {
        if (SectionsFor(P).Contains(Section)) return P;
    }
    return EHaybaPanel::Chat;
}

TArray<EHaybaPanel> SHaybaMCPMainPanel::RailDestinations()
{
    return { EHaybaPanel::Chat, EHaybaPanel::World };
}

void SHaybaMCPMainPanel::Construct(const FArguments& InArgs, FHaybaMCPModule* InModule)
{
    Module = InModule;
    if (Module) Module->MainPanel = SharedThis(this);
    TSharedRef<SWidget> InitialChat = BuildPanelContent(EHaybaSection::Chat);
    PanelCache.Add(EHaybaSection::Chat, InitialChat);
    LastSectionByPanel.Add(EHaybaPanel::Chat, EHaybaSection::Chat);

    ChildSlot
    [
        SNew(SBorder)
        .BorderImage(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Brush.Dock")))
        .Padding(0.f)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [ BuildHeader() ]
            + SVerticalBox::Slot().FillHeight(1.f)
            [
                SAssignNew(ContentArea, SBox)
                .Padding(0.f)
                [ InitialChat ]
            ]
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
            .ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.57f, 0.65f)))
            .Text(FText::FromString(Version.IsEmpty()
                ? FString(TEXT("Hayba"))
                : FString::Printf(TEXT("Hayba v%s"), *Version)))
        ];
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildHeader()
{
    // The chat owns the task state; the dock owns the single shared header.
    check(ChatPanel.IsValid());
    return SNew(SBorder)
        .BorderImage(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Brush.Dock")))
        .Padding(FMargin(12.f, 8.f, 12.f, 8.f))
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(SBox).HeightOverride(22.f).WidthOverride(18.f)
                [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Logo.Small"))) ]
            ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(9.f, 0.f, 5.f, 0.f)
            [ ChatPanel->BuildTaskSwitcher() ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(SButton)
                .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Icon"))
                .ContentPadding(FMargin(6.f))
                .ToolTipText(NSLOCTEXT("Hayba", "GoToChat", "Return to conversation"))
                .Visibility_Lambda([this]() { return CurrentPanel == EHaybaPanel::Chat ? EVisibility::Collapsed : EVisibility::Visible; })
                .OnClicked(this, &SHaybaMCPMainPanel::OnSidebarClick, EHaybaPanel::Chat)
                [ SNew(SImage).Image(PanelIcon(EHaybaPanel::Chat)) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(SButton)
                .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Icon"))
                .ContentPadding(FMargin(6.f))
                .ToolTipText(NSLOCTEXT("Hayba", "GoToWorld", "World"))
                .OnClicked(this, &SHaybaMCPMainPanel::OnSidebarClick, EHaybaPanel::World)
                [ SNew(SImage).Image(PanelIcon(EHaybaPanel::World))
                    .ColorAndOpacity_Lambda([this]() { return FSlateColor(FHaybaMCPStyle::Colour(
                        CurrentPanel == EHaybaPanel::World ? "Hayba.Color.Accent.Ochre" : "Hayba.Color.Text.Secondary")); }) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(SButton)
                .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Icon"))
                .ContentPadding(FMargin(6.f))
                .ToolTipText(NSLOCTEXT("Hayba", "NewTask", "New conversation"))
                .OnClicked_Lambda([this]()
                {
                    if (ChatPanel.IsValid()) ChatPanel->OnNewConversation();
                    ShowPanel(EHaybaPanel::Chat);
                    return FReply::Handled();
                })
                [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.New"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(SComboButton)
                .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Icon"))
                .HasDownArrow(false)
                .ContentPadding(FMargin(6.f))
                .ToolTipText(NSLOCTEXT("Hayba", "MoreViewsTip", "More views and settings"))
                .ButtonContent()
                [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Nav.More"))) ]
                .OnGetMenuContent(this, &SHaybaMCPMainPanel::BuildMoreMenu)
            ]
        ];
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildMoreMenu()
{
    FMenuBuilder Menu(true, nullptr);
    auto Add = [this, &Menu](EHaybaSection Section, const FText& Label)
    {
        Menu.AddMenuEntry(Label, FText::GetEmpty(), FSlateIcon(),
            FUIAction(FExecuteAction::CreateSP(this, &SHaybaMCPMainPanel::ShowSection, Section)));
    };
    Menu.AddMenuEntry(NSLOCTEXT("Hayba", "More.InspectWorld", "Inspect loaded world in chat"), FText::GetEmpty(), FSlateIcon(),
        FUIAction(FExecuteAction::CreateLambda([this]()
        {
            if (ChatPanel.IsValid()) ChatPanel->OnInspectWorld();
            ShowPanel(EHaybaPanel::Chat);
        })));
    Menu.AddMenuSeparator();
    Add(EHaybaSection::ToolStream, NSLOCTEXT("Hayba", "More.AgentActivity", "Agent activity"));
    Add(EHaybaSection::Plan, NSLOCTEXT("Hayba", "More.Plans", "Plans and approvals"));
    Add(EHaybaSection::Diff, NSLOCTEXT("Hayba", "More.Changes", "Changed objects"));
    Add(EHaybaSection::Validation, NSLOCTEXT("Hayba", "More.Checks", "Checks and warnings"));
    Menu.AddMenuSeparator();
    Add(EHaybaSection::Memory, NSLOCTEXT("Hayba", "More.Profiles", "Asset profiles"));
    Add(EHaybaSection::Slivers, NSLOCTEXT("Hayba", "More.Recipes", "Recipes"));
    Add(EHaybaSection::Lessons, NSLOCTEXT("Hayba", "More.Lessons", "Learned constraints"));
    Menu.AddMenuSeparator();
    Add(EHaybaSection::MCP, NSLOCTEXT("Hayba", "More.ToolPermissions", "Tool permissions"));
    Add(EHaybaSection::Settings, NSLOCTEXT("Hayba", "More.Settings", "Settings"));
    return Menu.MakeWidget();
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildSidebar()
{
    SAssignNew(Sidebar, SVerticalBox);

    // Chat is the starting point. Settings stays at the foot of the rail so it
    // reads as configuration rather than a sixth workspace destination.
    for (EHaybaPanel P : RailDestinations())
    {
        if (P == EHaybaPanel::Settings) continue;
        Sidebar->AddSlot().AutoHeight().Padding(FMargin(4.f, 1.f))
        [ BuildSidebarItem(P, PanelLabel(P)) ];
    }
    Sidebar->AddSlot().FillHeight(1.f) [ SNew(SBox) ];
    Sidebar->AddSlot().AutoHeight().Padding(FMargin(4.f, 1.f))
    [ BuildSidebarItem(EHaybaPanel::Settings, PanelLabel(EHaybaPanel::Settings)) ];
    return Sidebar.ToSharedRef();
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildSidebarItem(EHaybaPanel Panel, const FText& Label)
{
    // Destination names carry recognition. The selected edge and surface carry
    // state for every row, including Settings in its separate footer.
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("WhiteBrush"))
        .BorderBackgroundColor_Lambda([this, Panel]()
        {
            return FHaybaMCPStyle::Colour(CurrentPanel == Panel
                ? "Hayba.Color.Surface.Raised" : "Hayba.Color.Surface.Panel");
        })
        .Padding(0.f)
        [
        SNew(SButton)
        .ButtonStyle(FAppStyle::Get(), "HoverHintOnly")
        .ContentPadding(FMargin(4.f, 5.f))
        .HAlign(HAlign_Fill)
        .ToolTipText(Label)
        .OnClicked(this, &SHaybaMCPMainPanel::OnSidebarClick, Panel)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Fill).Padding(0.f, 0.f, 5.f, 0.f)
            [
                SNew(SBox).WidthOverride(FHaybaMCPStyle::Metric("Hayba.Metric.ActiveEdge"))
                [
                    SNew(SBorder)
                    .BorderImage(FAppStyle::GetBrush("WhiteBrush"))
                    .BorderBackgroundColor(FHaybaMCPStyle::Colour("Hayba.Color.Accent.Ochre"))
                    .Visibility_Lambda([this, Panel]()
                    {
                        return CurrentPanel == Panel ? EVisibility::Visible : EVisibility::Hidden;
                    })
                ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(4.f, 0.f, 8.f, 0.f)
            [
                SNew(SImage)
                .Image(PanelIcon(Panel))
                .ColorAndOpacity_Lambda([this, Panel]()
                {
                    return FSlateColor(FHaybaMCPStyle::Colour(CurrentPanel == Panel
                        ? "Hayba.Color.Text.Primary" : "Hayba.Color.Text.Secondary"));
                })
            ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
                .Text(Label)
                .ColorAndOpacity_Lambda([this, Panel]()
                {
                    return FSlateColor(FHaybaMCPStyle::Colour(CurrentPanel == Panel
                        ? "Hayba.Color.Text.Primary" : "Hayba.Color.Text.Secondary"));
                })
            ]
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

    const EHaybaSection* Remembered = LastSectionByPanel.Find(Panel);
    const EHaybaSection Target = Remembered && Sections.Contains(*Remembered)
        ? *Remembered : Sections[0];
    // Re-selecting the open view must not restart an in-progress World scan.
    // World has an explicit refresh control when the user wants a new scan.
    if (CurrentPanel == Panel && CurrentSection == Target && PanelCache.Contains(Target)) return;
    CurrentPanel = Panel;
    ShowSection(Target);
}

void SHaybaMCPMainPanel::ShowSection(EHaybaSection Section)
{
    CurrentSection = Section;
    CurrentPanel = PanelForSection(Section);
    LastSectionByPanel.Add(CurrentPanel, Section);
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

    ContentArea->SetContent(Content);
}

TSharedPtr<SHaybaMCPPlanPanel> SHaybaMCPMainPanel::PreparePlanReview()
{
    // Plan is normally built only when the user opens Activity > Plans. Build
    // and cache it now so the first Chat proposal has a real review surface.
    if (!PanelCache.Contains(EHaybaSection::Plan))
    {
        PanelCache.Add(EHaybaSection::Plan, BuildPanelContent(EHaybaSection::Plan));
    }

    return PlanPanel.Pin();
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
            SAssignNew(ChatPanel, SHaybaMCPChatPanel, Module);
            Body = ChatPanel;
            break;
        case EHaybaSection::MCP:
            Subtitle = NSLOCTEXT("Hayba", "MCP.Sub", "Pick which tools your AI agent can see.");
            Body = SNew(SHaybaMCPCapabilitiesPanel).Module(Module);
            break;
        case EHaybaSection::Slivers:
        {
            Subtitle = NSLOCTEXT("Hayba", "Slivers.Sub",
                "Deterministic abstractions — pick a sliver, set its parameters, run it.");
            auto Panel2 = SNew(SSliversPanel);
            // Re-shown from cache → re-scan the installed slivers directory.
            PanelRefreshHook.Add(EHaybaSection::Slivers, [Panel2]() { Panel2->Refresh(); });
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
            // World owns the full canvas. Its compact controls and honest
            // coverage state live over the surface, not in a separate header
            // or inspector column.
            TSharedRef<SHaybaMCPSceneMapWebPanel> W = SNew(SHaybaMCPSceneMapWebPanel);
            Body = W;
            PanelRefreshHook.Add(EHaybaSection::SceneMap, [W]() { W->Refresh(); });
            break;
        }
        case EHaybaSection::Plan:
        {
            Subtitle = NSLOCTEXT("Hayba", "Plan.Sub", "AI-proposed plan steps before destructive actions.");
            auto Panel2 = SNew(SHaybaMCPPlanPanel);
            PlanPanel = Panel2;
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

    if ((Section == EHaybaSection::Chat || Section == EHaybaSection::SceneMap ||
         Section == EHaybaSection::Settings) && Body.IsValid())
    {
        return Body.ToSharedRef();
    }

    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ Heading(Subtitle) ]
        + SVerticalBox::Slot().FillHeight(1.f)
        [ Body.IsValid() ? Body.ToSharedRef() : SNullWidget::NullWidget ];
}
