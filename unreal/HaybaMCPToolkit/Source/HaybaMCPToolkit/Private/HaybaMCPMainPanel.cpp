#include "HaybaMCPMainPanel.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPStyle.h"
#include "HaybaMCPChatPanel.h"
#include "HaybaMCPSceneMapWebPanel.h"
#include "HaybaMCPMemoryPanel.h"
#include "HaybaMCPCapabilitiesPanel.h"
#include "HaybaMCPOnboardingWidget.h"
#include "HaybaMCPSettingsPanel.h"
#include "Slate/SHaybaValidatorPanel.h"
#include "Slivers/SSliversPanel.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/Layout/SWidgetSwitcher.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Docking/SDockTab.h"
#include "Styling/AppStyle.h"
#include "Interfaces/IPluginManager.h"

namespace
{
    FText PanelLabel(EHaybaPanel Panel)
    {
        switch (Panel)
        {
            case EHaybaPanel::Agent: return NSLOCTEXT("Hayba", "Nav.Agent", "Agent");
            case EHaybaPanel::World: return NSLOCTEXT("Hayba", "Nav.World", "World");
            case EHaybaPanel::Library: return NSLOCTEXT("Hayba", "Nav.Library", "Library");
            case EHaybaPanel::Settings: return NSLOCTEXT("Hayba", "Nav.Settings", "Settings");
        }
        return FText::GetEmpty();
    }

    FName PanelIcon(EHaybaPanel Panel)
    {
        switch (Panel)
        {
            case EHaybaPanel::Agent: return TEXT("Hayba.Icon.Agent");
            case EHaybaPanel::World: return TEXT("Hayba.Icon.World");
            case EHaybaPanel::Library: return TEXT("Hayba.Icon.Library");
            case EHaybaPanel::Settings: return TEXT("Hayba.Icon.Settings");
        }
        return NAME_None;
    }

    TSharedRef<SWidget> SectionButton(const FText& Label, const TSharedRef<SWidgetSwitcher>& Switcher, int32 Index)
    {
        return SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .Text(Label)
            .ContentPadding(FMargin(12.f, 7.f))
            .OnClicked_Lambda([Switcher, Index]()
            {
                Switcher->SetActiveWidgetIndex(Index);
                return FReply::Handled();
            });
    }
}

void SHaybaMCPMainPanel::Construct(const FArguments&, FHaybaMCPModule* InModule)
{
    Module = InModule;
    ChildSlot
    [
        SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
        .Padding(0.f)
        [
            SNew(SSplitter)
            .Orientation(Orient_Horizontal)
            .PhysicalSplitterHandleSize(2.f)
            .HitDetectionSplitterHandleSize(6.f)
            + SSplitter::Slot().Value(0.16f).MinSize(44.f)
            [
                SAssignNew(SidebarWrapper, SBorder)
                .BorderImage(FAppStyle::GetBrush("Brushes.Header"))
                .Padding(FMargin(3.f, 6.f))
                [ BuildSidebar() ]
            ]
            + SSplitter::Slot().Value(0.84f)
            [
                SAssignNew(ContentArea, SBox)
                .Padding(FMargin(8.f, 6.f))
                [ BuildPanelContent(EHaybaPanel::Agent) ]
            ]
        ]
    ];
}

TArray<EHaybaPanel> SHaybaMCPMainPanel::RailDestinations()
{
    return { EHaybaPanel::Agent, EHaybaPanel::World, EHaybaPanel::Library };
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildSidebar()
{
    SAssignNew(Sidebar, SVerticalBox);
    for (EHaybaPanel Panel : RailDestinations())
    {
        Sidebar->AddSlot().AutoHeight().Padding(1.f, 1.f)
        [ BuildSidebarItem(Panel, PanelIcon(Panel), PanelLabel(Panel)) ];
    }
    Sidebar->AddSlot().FillHeight(1.f) [ SNew(SBox) ];
    Sidebar->AddSlot().AutoHeight().Padding(1.f, 1.f)
    [ BuildSidebarItem(EHaybaPanel::Settings, PanelIcon(EHaybaPanel::Settings), PanelLabel(EHaybaPanel::Settings)) ];
    return Sidebar.ToSharedRef();
}

void SHaybaMCPMainPanel::Tick(const FGeometry& Geometry, double Time, float Delta)
{
    SCompoundWidget::Tick(Geometry, Time, Delta);
    if (SidebarWrapper.IsValid()) LastSidebarWidth = SidebarWrapper->GetTickSpaceGeometry().GetLocalSize().X;
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildSidebarItem(EHaybaPanel Panel, const FName& IconBrushName, const FText& Label)
{
    return SNew(SBox).HeightOverride(36.f)
    [
        SNew(SButton)
        .ButtonStyle(FAppStyle::Get(), "HoverHintOnly")
        .ContentPadding(FMargin(6.f, 3.f))
        .HAlign(HAlign_Fill)
        .ToolTipText(Label)
        .OnClicked(this, &SHaybaMCPMainPanel::OnSidebarClick, Panel)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(SBox).WidthOverride(24.f).HeightOverride(24.f)
                [
                    SNew(SImage)
                    .Image(FHaybaMCPStyle::GetBrush(IconBrushName))
                    .ColorAndOpacity_Lambda([this, Panel]()
                    {
                        return CurrentPanel == Panel ? FHaybaMCPStyle::Get().GetColor(TEXT("Hayba.Color.Active"))
                            : FSlateColor(FLinearColor(0.64f, 0.66f, 0.69f));
                    })
                ]
            ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(9.f, 0.f, 0.f, 0.f)
            [
                SNew(STextBlock)
                .Text(Label)
                .ColorAndOpacity_Lambda([this, Panel]()
                {
                    return CurrentPanel == Panel ? FHaybaMCPStyle::Get().GetColor(TEXT("Hayba.Color.Active"))
                        : FSlateColor(FLinearColor(0.76f, 0.78f, 0.81f));
                })
                .Visibility_Lambda([this]() { return IsSidebarCompact() ? EVisibility::Collapsed : EVisibility::Visible; })
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
    CurrentPanel = Panel;
    if (!ContentArea.IsValid()) return;
    if (TSharedRef<SWidget>* Cached = PanelCache.Find(Panel))
    {
        ContentArea->SetContent(*Cached);
        if (TFunction<void()>* Refresh = PanelRefreshHook.Find(Panel)) (*Refresh)();
        return;
    }
    TSharedRef<SWidget> Content = BuildPanelContent(Panel);
    PanelCache.Add(Panel, Content);
    ContentArea->SetContent(Content);
}

void SHaybaMCPMainPanel::ShowOnboardingFromSplash()
{
    if (!ContentArea.IsValid()) return;
    TSharedRef<SDockTab> Owner = SNew(SDockTab).TabRole(ETabRole::PanelTab);
    ContentArea->SetContent(SNew(SHaybaMCPOnboardingWidget, Owner));
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildPanelContent(EHaybaPanel Panel)
{
    if (Panel == EHaybaPanel::Agent)
        return SNew(SHaybaMCPChatPanel, Module).MainPanel(this);

    if (Panel == EHaybaPanel::World)
    {
        TSharedRef<SHaybaMCPSceneMapWebPanel> Map = SNew(SHaybaMCPSceneMapWebPanel);
        TSharedRef<SHaybaValidatorPanel> Findings = SNew(SHaybaValidatorPanel);
        PanelRefreshHook.Add(EHaybaPanel::World, [Map, Findings]() { Map->Refresh(); Findings->Refresh(); });
        return SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(6.f, 3.f, 6.f, 7.f)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "World.Heading", "World")) ]
                + SHorizontalBox::Slot().AutoWidth()
                [ SNew(SButton).Text(NSLOCTEXT("Hayba", "World.Refresh", "Refresh"))
                    .ToolTipText(NSLOCTEXT("Hayba", "World.RefreshTip", "Rescan loaded actors and findings"))
                    .OnClicked_Lambda([Map, Findings]() { Map->Refresh(); Findings->Refresh(); return FReply::Handled(); }) ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(6.f, 0.f, 6.f, 5.f)
            [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "World.Coverage", "Loaded actor map · unloaded World Partition regions are not yet indexed"))
                .ColorAndOpacity(FSlateColor(FLinearColor(0.64f, 0.66f, 0.69f))) ]
            + SVerticalBox::Slot().FillHeight(1.f)
            [
                SNew(SSplitter).Orientation(Orient_Vertical)
                + SSplitter::Slot().Value(0.72f) [ Map ]
                + SSplitter::Slot().Value(0.28f) [ Findings ]
            ];
    }

    if (Panel == EHaybaPanel::Library)
    {
        TSharedRef<SHaybaMCPMemoryPanel> Assets = SNew(SHaybaMCPMemoryPanel);
        TSharedRef<SSliversPanel> Recipes = SNew(SSliversPanel);
        TSharedRef<SWidgetSwitcher> Sections = SNew(SWidgetSwitcher)
            + SWidgetSwitcher::Slot() [ Assets ]
            + SWidgetSwitcher::Slot() [ Recipes ];
        PanelRefreshHook.Add(EHaybaPanel::Library, [Assets, Recipes]() { Assets->RefreshLibrary(); Recipes->Refresh(); });
        return SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(5.f, 2.f, 5.f, 6.f)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth() [ SectionButton(NSLOCTEXT("Hayba", "Library.Assets", "Assets & profiles"), Sections, 0) ]
                + SHorizontalBox::Slot().AutoWidth().Padding(5.f, 0.f, 0.f, 0.f)
                  [ SectionButton(NSLOCTEXT("Hayba", "Library.Recipes", "Recipes"), Sections, 1) ]
            ]
            + SVerticalBox::Slot().FillHeight(1.f) [ Sections ];
    }

    TSharedRef<SWidgetSwitcher> SettingsSections = SNew(SWidgetSwitcher)
        + SWidgetSwitcher::Slot() [ SNew(SHaybaMCPSettingsPanel).MainPanel(this) ]
        + SWidgetSwitcher::Slot() [ SNew(SHaybaMCPCapabilitiesPanel).Module(Module) ];
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(5.f, 2.f, 5.f, 6.f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth() [ SectionButton(NSLOCTEXT("Hayba", "Settings.Preferences", "Preferences"), SettingsSections, 0) ]
            + SHorizontalBox::Slot().AutoWidth().Padding(5.f, 0.f, 0.f, 0.f)
              [ SectionButton(NSLOCTEXT("Hayba", "Settings.Tools", "Tool access"), SettingsSections, 1) ]
        ]
        + SVerticalBox::Slot().FillHeight(1.f) [ SettingsSections ];
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildHeader()
{
    return SNew(STextBlock).Text(NSLOCTEXT("Hayba", "AppName", "Hayba"));
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildWatermark()
{
    return SNew(SBox);
}
