#include "HaybaMCPOnboardingWidget.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPStyle.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/SBoxPanel.h"
#include "Styling/AppStyle.h"

void SHaybaMCPOnboardingWidget::Construct(const FArguments& InArgs, TSharedRef<SDockTab> InOwnerTab)
{
    OwnerTab = InOwnerTab;
    OptionalChecked = {
        { EHaybaOnboardingScreen::VisualSidecar, false },
        { EHaybaOnboardingScreen::AgentArchetypes, false },
        { EHaybaOnboardingScreen::UITour, false },
        { EHaybaOnboardingScreen::SampleScene, false },
    };

    ChildSlot
    [
        SAssignNew(ScreenSwitcher, SBox)
        .HAlign(HAlign_Fill).VAlign(VAlign_Fill)
        [ BuildSplashScreen() ]
    ];
}

void SHaybaMCPOnboardingWidget::Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime)
{
    SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
    if (CurrentScreen == EHaybaOnboardingScreen::Splash && !bSplashComplete)
    {
        SplashTimer += InDeltaTime;
        if (SplashTimer >= 2.0f)
        {
            bSplashComplete = true;
            ShowScreen(EHaybaOnboardingScreen::Hub);
        }
    }
}

void SHaybaMCPOnboardingWidget::ShowScreen(EHaybaOnboardingScreen Screen)
{
    CurrentScreen = Screen;
    if (!ScreenSwitcher.IsValid()) return;

    switch (Screen)
    {
        case EHaybaOnboardingScreen::Splash:
            ScreenSwitcher->SetContent(BuildSplashScreen());
            break;
        case EHaybaOnboardingScreen::Hub:
            ScreenSwitcher->SetContent(BuildHubScreen());
            break;
        case EHaybaOnboardingScreen::TCP:
            ScreenSwitcher->SetContent(BuildSubScreen(
                NSLOCTEXT("Hayba", "TCPTitle", "TCP Connection"),
                NSLOCTEXT("Hayba", "TCPDesc", "Hayba MCP communicates with Claude Code (or any MCP client) over a local TCP connection on port 52342. Start the TCP server from the Hayba Chat panel — you will see 'TCP server started' in the output log."),
                EHaybaOnboardingScreen::CapToken));
            break;
        case EHaybaOnboardingScreen::CapToken:
            ScreenSwitcher->SetContent(BuildSubScreen(
                NSLOCTEXT("Hayba", "CapTokenTitle", "Capability Token"),
                NSLOCTEXT("Hayba", "CapTokenDesc", "Set a capability token in Project Settings → Plugins → Hayba MCP Toolkit. When set, every TCP request must include matching `auth`. Leave empty to disable auth (development only)."),
                EHaybaOnboardingScreen::PlanMode));
            break;
        case EHaybaOnboardingScreen::PlanMode:
            ScreenSwitcher->SetContent(BuildSubScreen(
                NSLOCTEXT("Hayba", "PlanModeTitle", "Plan Mode — AI Safety"),
                NSLOCTEXT("Hayba", "PlanModeDesc", "Plan Mode prevents the AI from modifying your scene without showing you a plan first. It is ON by default. You can disable it from the toolbar once you trust your workflow."),
                EHaybaOnboardingScreen::VisualSidecar));
            break;
        case EHaybaOnboardingScreen::VisualSidecar:
            ScreenSwitcher->SetContent(BuildSubScreen(
                NSLOCTEXT("Hayba", "SidecarTitle", "Visual Sidecar (Optional)"),
                NSLOCTEXT("Hayba", "SidecarDesc", "The visual sidecar runs CLIP / SpatialCLIP / OWL-ViT embeddings for image-based tools (moodboards, references). Install via `uv pip install -r addons/visual-embeddings/requirements.txt` and run `addons/visual-embeddings/start.bat`."),
                EHaybaOnboardingScreen::AgentArchetypes));
            break;
        case EHaybaOnboardingScreen::AgentArchetypes:
            ScreenSwitcher->SetContent(BuildSubScreen(
                NSLOCTEXT("Hayba", "ArchetypesTitle", "Agent Archetypes (Optional)"),
                NSLOCTEXT("Hayba", "ArchetypesDesc", "hayba.agents.json defines specialist roles (Director, Asset Manager, Pattern Expert, Node Expert, Blueprint Generator). Edit it to customize tool filters and system prompts."),
                EHaybaOnboardingScreen::UITour));
            break;
        case EHaybaOnboardingScreen::UITour:
            ScreenSwitcher->SetContent(BuildSubScreen(
                NSLOCTEXT("Hayba", "UITourTitle", "UI Panels Tour"),
                NSLOCTEXT("Hayba", "UITourDesc", "Window → Hayba opens any of the 7 panels: Chat, Tool Stream, Scene Map, Wireframe/Plan, Diff, Validation Report, Memory Inspector."),
                EHaybaOnboardingScreen::SampleScene));
            break;
        case EHaybaOnboardingScreen::SampleScene:
            ScreenSwitcher->SetContent(BuildSubScreen(
                NSLOCTEXT("Hayba", "SampleTitle", "Import a Sample Scene (Optional)"),
                NSLOCTEXT("Hayba", "SampleDesc", "Try a sample scene with pre-built terrain and PCG graphs to explore Hayba's capabilities. (Coming soon — see addons/samples.)"),
                EHaybaOnboardingScreen::Done));
            break;
        case EHaybaOnboardingScreen::Done:
            ScreenSwitcher->SetContent(BuildDoneScreen());
            break;
    }
}

TSharedRef<SWidget> SHaybaMCPOnboardingWidget::BuildSplashScreen()
{
    const FSlateBrush* LogoBrush     = FHaybaMCPStyle::GetBrush(TEXT("Hayba.Logo"));
    const FSlateBrush* WordmarkBrush = FHaybaMCPStyle::GetBrush(TEXT("Hayba.Wordmark"));

    return SNew(SBox).HAlign(HAlign_Center).VAlign(VAlign_Center)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
        [
            SNew(SBox).WidthOverride(160).HeightOverride(160)
            [ SNew(SImage).Image(LogoBrush) ]
        ]
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(0, 16, 0, 0)
        [
            SNew(SBox).WidthOverride(280).HeightOverride(60)
            [ SNew(SImage).Image(WordmarkBrush) ]
        ]
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(0, 12)
        [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "Loading", "Setting up...")) ]
    ];
}

TSharedRef<SWidget> SHaybaMCPOnboardingWidget::BuildHubScreen()
{
    return SNew(SVerticalBox)
    + SVerticalBox::Slot().AutoHeight().Padding(16, 16, 16, 8)
    [ SNew(STextBlock)
        .Text(NSLOCTEXT("Hayba", "HubTitle", "Welcome to Hayba MCP Toolkit"))
        .TextStyle(FAppStyle::Get(), "LargeText") ]
    + SVerticalBox::Slot().AutoHeight().Padding(16, 0, 16, 8)
    [ SNew(STextBlock).AutoWrapText(true)
        .Text(NSLOCTEXT("Hayba", "HubSubtitle", "Let's get you set up. Required items are already checked.")) ]

    + SVerticalBox::Slot().AutoHeight().Padding(16, 4)
    [ BuildMandatoryItem(NSLOCTEXT("Hayba", "TCP", "TCP Connection"), EHaybaOnboardingScreen::TCP) ]
    + SVerticalBox::Slot().AutoHeight().Padding(16, 4)
    [ BuildMandatoryItem(NSLOCTEXT("Hayba", "CapTok", "Capability Token (Security)"), EHaybaOnboardingScreen::CapToken) ]
    + SVerticalBox::Slot().AutoHeight().Padding(16, 4)
    [ BuildMandatoryItem(NSLOCTEXT("Hayba", "PlanModeItem", "Plan Mode — AI Safety"), EHaybaOnboardingScreen::PlanMode) ]

    + SVerticalBox::Slot().AutoHeight().Padding(16, 12, 16, 4)
    [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "OptionalLabel", "Optional — configure now or later:")) ]
    + SVerticalBox::Slot().AutoHeight().Padding(16, 4)
    [ BuildOptionalItem(NSLOCTEXT("Hayba", "Sidecar", "Visual Sidecar (CLIP embeddings)"), EHaybaOnboardingScreen::VisualSidecar) ]
    + SVerticalBox::Slot().AutoHeight().Padding(16, 4)
    [ BuildOptionalItem(NSLOCTEXT("Hayba", "Agents", "Agent Archetypes (multi-agent)"), EHaybaOnboardingScreen::AgentArchetypes) ]
    + SVerticalBox::Slot().AutoHeight().Padding(16, 4)
    [ BuildOptionalItem(NSLOCTEXT("Hayba", "UITour", "UI Panels Tour"), EHaybaOnboardingScreen::UITour) ]
    + SVerticalBox::Slot().AutoHeight().Padding(16, 4)
    [ BuildOptionalItem(NSLOCTEXT("Hayba", "Sample", "Import a Sample Scene"), EHaybaOnboardingScreen::SampleScene) ]

    + SVerticalBox::Slot().AutoHeight().Padding(16, 16).HAlign(HAlign_Right)
    [
        SNew(SButton)
        .Text(NSLOCTEXT("Hayba", "StartSetup", "Start Setup"))
        .OnClicked(this, &SHaybaMCPOnboardingWidget::OnGoTo, EHaybaOnboardingScreen::TCP)
    ];
}

TSharedRef<SWidget> SHaybaMCPOnboardingWidget::BuildSubScreen(const FText& Title, const FText& Body, EHaybaOnboardingScreen Next)
{
    return SNew(SVerticalBox)
    + SVerticalBox::Slot().AutoHeight().Padding(16)
    [ SNew(STextBlock).Text(Title).TextStyle(FAppStyle::Get(), "LargeText") ]
    + SVerticalBox::Slot().FillHeight(1.f).Padding(16, 0)
    [ SNew(STextBlock).AutoWrapText(true).Text(Body) ]
    + SVerticalBox::Slot().AutoHeight().Padding(16, 16).HAlign(HAlign_Right)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 8, 0)
        [
            SNew(SButton).Text(NSLOCTEXT("Hayba", "BackToHub", "Back to Hub"))
            .OnClicked(this, &SHaybaMCPOnboardingWidget::OnGoTo, EHaybaOnboardingScreen::Hub)
        ]
        + SHorizontalBox::Slot().AutoWidth()
        [
            SNew(SButton).Text(NSLOCTEXT("Hayba", "Next", "Next"))
            .OnClicked(this, &SHaybaMCPOnboardingWidget::OnGoTo, Next)
        ]
    ];
}

TSharedRef<SWidget> SHaybaMCPOnboardingWidget::BuildDoneScreen()
{
    return SNew(SVerticalBox)
    + SVerticalBox::Slot().FillHeight(1.f).HAlign(HAlign_Center).VAlign(VAlign_Center)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
        [ SNew(STextBlock).TextStyle(FAppStyle::Get(), "LargeText").Text(NSLOCTEXT("Hayba", "DoneTitle", "You're all set!")) ]
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(0, 16)
        [
            SNew(SButton).Text(NSLOCTEXT("Hayba", "Finish", "Finish"))
            .OnClicked(this, &SHaybaMCPOnboardingWidget::OnFinish)
        ]
    ];
}

TSharedRef<SWidget> SHaybaMCPOnboardingWidget::BuildMandatoryItem(const FText& Label, EHaybaOnboardingScreen Target)
{
    return SNew(SHorizontalBox)
    + SHorizontalBox::Slot().AutoWidth()
    [ SNew(SCheckBox).IsChecked(ECheckBoxState::Checked).IsEnabled(false) ]
    + SHorizontalBox::Slot().AutoWidth().Padding(8, 0)
    [
        SNew(SButton).ButtonStyle(FAppStyle::Get(), "HoverHintOnly")
        .Text(Label)
        .OnClicked(this, &SHaybaMCPOnboardingWidget::OnGoTo, Target)
    ];
}

TSharedRef<SWidget> SHaybaMCPOnboardingWidget::BuildOptionalItem(const FText& Label, EHaybaOnboardingScreen Target)
{
    return SNew(SHorizontalBox)
    + SHorizontalBox::Slot().AutoWidth()
    [
        SNew(SCheckBox)
        .OnCheckStateChanged_Lambda([this, Target](ECheckBoxState S){ OptionalChecked.FindOrAdd(Target) = (S == ECheckBoxState::Checked); })
    ]
    + SHorizontalBox::Slot().AutoWidth().Padding(8, 0)
    [
        SNew(SButton).ButtonStyle(FAppStyle::Get(), "HoverHintOnly")
        .Text(Label)
        .OnClicked(this, &SHaybaMCPOnboardingWidget::OnGoTo, Target)
    ];
}

FReply SHaybaMCPOnboardingWidget::OnGoTo(EHaybaOnboardingScreen Screen)
{
    ShowScreen(Screen);
    return FReply::Handled();
}

FReply SHaybaMCPOnboardingWidget::OnFinish()
{
    FHaybaMCPSettings::Get().bHasSeenOnboarding = true;
    FHaybaMCPSettings::Get().Save();
    if (TSharedPtr<SDockTab> Pinned = OwnerTab.Pin())
    {
        Pinned->RequestCloseTab();
    }
    return FReply::Handled();
}
