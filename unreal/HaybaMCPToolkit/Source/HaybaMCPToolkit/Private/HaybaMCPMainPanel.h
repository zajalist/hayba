#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Input/Reply.h"

class FHaybaMCPModule;
class SBox;
class SVerticalBox;
class SHorizontalBox;
class SComboButton;
class SHaybaMCPPlanPanel;
class SHaybaMCPChatPanel;

/**
 * A view. Plan and Lessons remain for legacy direct callers, while current
 * navigation lists the sections used by active workflows.
 */
enum class EHaybaSection : uint8
{
    Chat, MCP, Slivers, ToolStream, SceneMap, Plan, Diff, Validation, Memory, Lessons, Settings
};

/**
 * A destination. Chat and World are primary; Activity, Checks, Library, and
 * Settings are available through More, with section tabs where useful.
 */
enum class EHaybaPanel : uint8
{
    World, Library, Rules, Activity, Chat, Settings
};

class SHaybaMCPMainPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPMainPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs, FHaybaMCPModule* InModule);

    /** Navigate to a section, selecting whichever destination owns it. */
    void ShowSection(EHaybaSection Section);

    /** Build the Plan view for a Chat proposal without navigating away. */
    TSharedPtr<SHaybaMCPPlanPanel> PreparePlanReview();

    /** Navigate to a destination, landing on its first section. */
    void ShowPanel(EHaybaPanel Panel);

    /** Triggered by Settings → Redo Setup. Replaces the active content area with the onboarding splash flow. */
    void ShowOnboardingFromSplash();

    /** The sections a destination owns, in the order they appear. */
    static TArray<EHaybaSection> SectionsFor(EHaybaPanel Panel);
    /** The destination that owns a section. */
    static EHaybaPanel PanelForSection(EHaybaSection Section);

    /** Primary destinations shown in the task header. */
    static TArray<EHaybaPanel> RailDestinations();

private:
    friend class FHaybaWorkspaceNavigationTest;

    FHaybaMCPModule* Module = nullptr;
    EHaybaPanel CurrentPanel = EHaybaPanel::Chat;
    EHaybaSection CurrentSection = EHaybaSection::Chat;
    // Onboarding temporarily replaces ContentArea without becoming a section.
    // A later Settings click must restore its cached section, even if the
    // remembered panel and section still say Settings.
    bool bShowingOnboarding = false;

    TSharedPtr<SBox> ContentArea;
    TSharedPtr<SHaybaMCPChatPanel> ChatPanel;
    TSharedPtr<SVerticalBox> Sidebar;
    TSharedPtr<SComboButton> MoreButton;

    // Per-section widget cache — built lazily on first show, reused on every
    // subsequent click so CEF browsers / heavy widgets don't reinitialize.
    TMap<EHaybaSection, TSharedRef<SWidget>> PanelCache;
    TWeakPtr<SHaybaMCPPlanPanel> PlanPanel;
    TMap<EHaybaPanel, EHaybaSection> LastSectionByPanel;
    // Optional refresh hooks fired when a cached section is re-shown. Lets
    // views like Scene Map / Plan rescan their data source without
    // re-creating the underlying widget.
    TMap<EHaybaSection, TFunction<void()>> PanelRefreshHook;

    TSharedRef<SWidget> BuildHeader();
    TSharedRef<SWidget> BuildMoreMenu();
    TSharedRef<SWidget> BuildWatermark();
    TSharedRef<SWidget> BuildSidebar();

    /** The row of section tabs shown when a destination owns more than one. */
    TSharedRef<SWidget> BuildSectionTabs(EHaybaPanel Panel);

    TSharedRef<SWidget> BuildSidebarItem(EHaybaPanel Panel, const FText& Label);

    TSharedRef<SWidget> BuildPanelContent(EHaybaSection Section);

    FReply OnSidebarClick(EHaybaPanel Panel);
    FReply OnSectionClick(EHaybaSection Section);
};
