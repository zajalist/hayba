#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Docking/SDockTab.h"
#include "Input/Reply.h"

enum class EHaybaOnboardingScreen : uint8
{
    Splash, Hub, TCP, CapToken, PlanMode, VisualSidecar, AgentArchetypes, UITour, SampleScene, Done
};

class SHaybaMCPOnboardingWidget : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPOnboardingWidget) {}
        SLATE_ARGUMENT(bool, bSkipSplash)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs, TSharedRef<SDockTab> InOwnerTab);

protected:
    virtual void Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime) override;
    FSlateColor GetSplashTextColor() const;
    TOptional<FSlateRenderTransform> GetSplashLogoTransform() const;

private:
    TWeakPtr<SDockTab> OwnerTab;
    EHaybaOnboardingScreen CurrentScreen = EHaybaOnboardingScreen::Splash;
    TMap<EHaybaOnboardingScreen, bool> OptionalChecked;

    TSharedPtr<class SBox> ScreenSwitcher;
    float SplashTimer = 0.f;
    float TotalTime = 0.f;
    bool bSplashComplete = false;

    void ShowScreen(EHaybaOnboardingScreen Screen);

    TSharedRef<SWidget> BuildSplashScreen();
    TSharedRef<SWidget> BuildHubScreen();
    TSharedRef<SWidget> BuildSubScreen(const FText& Title, const FText& Body, EHaybaOnboardingScreen Next);
    TSharedRef<SWidget> BuildDoneScreen();

    TSharedRef<SWidget> BuildMandatoryItem(const FText& Label, EHaybaOnboardingScreen Target);
    TSharedRef<SWidget> BuildOptionalItem(const FText& Label, EHaybaOnboardingScreen Target);

    FReply OnFinish();
    FReply OnGoTo(EHaybaOnboardingScreen Screen);
};
