#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Input/Reply.h"

class FHaybaMCPModule;
class SBox;
class SVerticalBox;
class SHorizontalBox;

enum class EHaybaPanel : uint8
{
    Chat, MCP, Slivers, ToolStream, SceneMap, Plan, Diff, Validation, Memory, Settings
};

class SHaybaMCPMainPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPMainPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs, FHaybaMCPModule* InModule);

    void ShowPanel(EHaybaPanel Panel);

    /** Triggered by Settings → Redo Setup. Replaces the active content area with the onboarding splash flow. */
    void ShowOnboardingFromSplash();

private:
    FHaybaMCPModule* Module = nullptr;
    EHaybaPanel CurrentPanel = EHaybaPanel::Chat;

    TSharedPtr<SBox> ContentArea;
    TSharedPtr<SVerticalBox> Sidebar;
    TSharedPtr<class SBorder> SidebarWrapper;  // measured for compact-mode threshold

    // Per-panel widget cache — built lazily on first show, reused on every
    // subsequent click so CEF browsers / heavy widgets don't reinitialize.
    TMap<EHaybaPanel, TSharedRef<SWidget>> PanelCache;
    // Optional refresh hooks fired when a cached panel is re-shown. Lets
    // panels like Scene Map / Plan rescan their data source without
    // re-creating the underlying widget.
    TMap<EHaybaPanel, TFunction<void()>> PanelRefreshHook;

    TSharedRef<SWidget> BuildHeader();
    TSharedRef<SWidget> BuildWatermark();
    TSharedRef<SWidget> BuildSidebar();

    // Responsive collapse — when the *sidebar itself* is narrower than this
    // threshold (driven by user-dragging the splitter), labels hide and the
    // bar becomes icon-only. Updated each Tick from the SidebarWrapper's
    // last allotted geometry.
    mutable float LastSidebarWidth = 160.f;
    static constexpr float CompactSidebarThresholdPx = 90.f;
    bool IsSidebarCompact() const { return LastSidebarWidth < CompactSidebarThresholdPx; }

    virtual void Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime) override;
    TSharedRef<SWidget> BuildSidebarItem(EHaybaPanel Panel, const FName& IconBrushName, const FText& Label);

    TSharedRef<SWidget> BuildPanelContent(EHaybaPanel Panel);

    FReply OnSidebarClick(EHaybaPanel Panel);
};
