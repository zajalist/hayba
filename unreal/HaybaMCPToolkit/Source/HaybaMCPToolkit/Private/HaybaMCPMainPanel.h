#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Input/Reply.h"

class FHaybaMCPModule;
class SBox;
class SVerticalBox;
class SHorizontalBox;

/**
 * A view. These are the eleven surfaces that used to be sidebar tabs in their
 * own right, and they still build the same bodies -- only the navigation above
 * them changed.
 */
enum class EHaybaSection : uint8
{
    Chat, MCP, Slivers, ToolStream, SceneMap, Plan, Diff, Validation, Memory, Lessons, Settings
};

/**
 * A destination. The sidebar has five of these plus Settings, and they are
 * named for what a user wants rather than for the subsystem that implements it.
 *
 * The eleven sections answered six questions between them: three tabs competed
 * to answer "what is the agent doing", two to answer "what must be true", two
 * "what can I use", and two "configure". A user with one question had to know
 * which tab held the answer. Sections did not go away -- they became the views
 * inside the destination that owns them, so nothing is unreachable and the
 * sidebar stops being a list of implementation names.
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

    /** Navigate to a destination, landing on its first section. */
    void ShowPanel(EHaybaPanel Panel);

    /** Triggered by Settings → Redo Setup. Replaces the active content area with the onboarding splash flow. */
    void ShowOnboardingFromSplash();

    /** The sections a destination owns, in the order they appear. */
    static TArray<EHaybaSection> SectionsFor(EHaybaPanel Panel);
    /** The destination that owns a section. */
    static EHaybaPanel PanelForSection(EHaybaSection Section);

private:
    FHaybaMCPModule* Module = nullptr;
    EHaybaPanel CurrentPanel = EHaybaPanel::Chat;
    EHaybaSection CurrentSection = EHaybaSection::Chat;

    TSharedPtr<SBox> ContentArea;
    TSharedPtr<SVerticalBox> Sidebar;
    TSharedPtr<class SBorder> SidebarWrapper;  // measured for compact-mode threshold

    // Per-section widget cache — built lazily on first show, reused on every
    // subsequent click so CEF browsers / heavy widgets don't reinitialize.
    TMap<EHaybaSection, TSharedRef<SWidget>> PanelCache;
    // Optional refresh hooks fired when a cached section is re-shown. Lets
    // views like Scene Map / Plan rescan their data source without
    // re-creating the underlying widget.
    TMap<EHaybaSection, TFunction<void()>> PanelRefreshHook;

    TSharedRef<SWidget> BuildHeader();
    TSharedRef<SWidget> BuildWatermark();
    TSharedRef<SWidget> BuildSidebar();

    /** The row of section tabs shown when a destination owns more than one. */
    TSharedRef<SWidget> BuildSectionTabs(EHaybaPanel Panel);

    // Responsive collapse — when the *sidebar itself* is narrower than this
    // threshold (driven by user-dragging the splitter), labels hide and the
    // bar becomes icon-only. Updated each Tick from the SidebarWrapper's
    // last allotted geometry.
    mutable float LastSidebarWidth = 160.f;
    static constexpr float CompactSidebarThresholdPx = 90.f;
    bool IsSidebarCompact() const { return LastSidebarWidth < CompactSidebarThresholdPx; }

    virtual void Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime) override;
    TSharedRef<SWidget> BuildSidebarItem(EHaybaPanel Panel, const FName& IconBrushName, const FText& Label);

    TSharedRef<SWidget> BuildPanelContent(EHaybaSection Section);

    FReply OnSidebarClick(EHaybaPanel Panel);
    FReply OnSectionClick(EHaybaSection Section);
};
