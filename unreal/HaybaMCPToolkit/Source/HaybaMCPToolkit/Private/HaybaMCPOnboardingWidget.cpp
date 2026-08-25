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
    };

    const bool bSkipSplash = InArgs._bSkipSplash;
    if (bSkipSplash)
    {
        CurrentScreen = EHaybaOnboardingScreen::Hub;
        bSplashComplete = true;
    }

    ChildSlot
    [
        SAssignNew(ScreenSwitcher, SBox)
        .HAlign(HAlign_Fill).VAlign(VAlign_Fill)
        [ bSkipSplash ? BuildHubScreen() : BuildSplashScreen() ]
    ];
}

void SHaybaMCPOnboardingWidget::Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime)
{
    SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
    TotalTime += InDeltaTime;

    if (CurrentScreen == EHaybaOnboardingScreen::Splash && !bSplashComplete)
    {
        SplashTimer += InDeltaTime;
        if (SplashTimer >= 3.5f)
        {
            bSplashComplete = true;
            ShowScreen(EHaybaOnboardingScreen::Hub);
        }
        // Force redraw for the splash animation.
        Invalidate(EInvalidateWidgetReason::Paint);
    }
}

FSlateColor SHaybaMCPOnboardingWidget::GetSplashTextColor() const
{
    // Cycle through a warm-cool gradient using the cream + brand orange (#B56A1D) tones.
    const float t = 0.5f + 0.5f * FMath::Sin(TotalTime * 2.5f);
    const FLinearColor Cool(0.87f, 0.83f, 0.76f, 1.f); // cream #DED4C3
    const FLinearColor Warm(0.71f, 0.42f, 0.11f, 1.f); // brand orange #B56A1D
    return FSlateColor(FMath::Lerp(Cool, Warm, t));
}

TOptional<FSlateRenderTransform> SHaybaMCPOnboardingWidget::GetSplashLogoTransform() const
{
    // Cute float: bob vertically + slight rotation.
    const float Bob   = FMath::Sin(TotalTime * 1.6f) * 8.0f;
    const float Tilt  = FMath::Sin(TotalTime * 0.9f) * 0.04f;  // ~2.3 deg
    return FSlateRenderTransform(
        FQuat2D(Tilt),
        FVector2D(0.f, Bob)
    );
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
                // Described by what each surface does rather than by a tab list.
                // The old copy named "7 panels" when there were 11, and three of
                // the names it used existed nowhere in the product -- a list in
                // prose drifts the moment anyone renames a tab, so this one does
                // not carry a list.
                NSLOCTEXT("Hayba", "UITourDesc", "Window → Hayba opens the toolkit. One panel holds everything, with a sidebar to switch surface: talk to the agent, watch tool calls as they run, browse the scene it understands, review plans and diffs before they apply, and configure the connection."),
                EHaybaOnboardingScreen::Done));
            break;
        case EHaybaOnboardingScreen::Done:
            ScreenSwitcher->SetContent(BuildDoneScreen());
            break;
    }
}

TSharedRef<SWidget> SHaybaMCPOnboardingWidget::BuildSplashScreen()
{
    // Animated splash: logo gently bobs + tilts; "Setting up..." color cycles between cream and brand orange.
    return SNew(SBox).HAlign(HAlign_Center).VAlign(VAlign_Center)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
        [
            SNew(SBox).WidthOverride(166).HeightOverride(201)
            [
                SNew(SImage)
                .Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Logo.Large")))
                .RenderTransform(this, &SHaybaMCPOnboardingWidget::GetSplashLogoTransform)
                .RenderTransformPivot(FVector2D(0.5f, 0.5f))
            ]
        ]
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(0, 32, 0, 0)
        [
            SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Heading"))
            .ColorAndOpacity(this, &SHaybaMCPOnboardingWidget::GetSplashTextColor)
            .Text(NSLOCTEXT("Hayba", "Loading", "Setting up..."))
        ]
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
