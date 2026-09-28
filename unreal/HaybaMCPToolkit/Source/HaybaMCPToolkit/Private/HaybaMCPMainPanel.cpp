#include "HaybaMCPMainPanel.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPStyle.h"
#include "HaybaMCPChatPanel.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPSettings.h"
#include "Widgets/Layout/SWrapBox.h"
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
    WorldInspection = NSLOCTEXT("Hayba", "World.Initial", "Inspect this world to see partition, landscape, and save status.");
    TSharedRef<SWidget> InitialAgent = BuildPanelContent(EHaybaPanel::Agent);
    PanelCache.Add(EHaybaPanel::Agent, InitialAgent);
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
                .Padding(FMargin(5.f, 8.f))
                [ BuildSidebar() ]
            ]
            + SSplitter::Slot().Value(0.84f)
            [
                SAssignNew(ContentArea, SBox)
                .Padding(FMargin(8.f, 6.f))
                [ InitialAgent ]
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
    Sidebar->AddSlot().AutoHeight().Padding(7.f, 8.f, 4.f, 20.f)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [ SNew(SBox).WidthOverride(24.f).HeightOverride(29.f)
          [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Logo.Small"))) ] ]
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(9.f, 0.f)
        [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "Brand", "Hayba"))
            .Font(FCoreStyle::GetDefaultFontStyle("Bold", 14))
            .Visibility_Lambda([this]() { return IsSidebarCompact() ? EVisibility::Collapsed : EVisibility::Visible; }) ]
    ];
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
    return SNew(SBox).HeightOverride(42.f)
    [
        SNew(SButton)
        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Nav"))
        .ButtonColorAndOpacity_Lambda([this, Panel]() { return CurrentPanel == Panel
            ? FLinearColor(0.14f, 0.105f, 0.065f) : FLinearColor::Transparent; })
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
                            : FSlateColor(FLinearColor::FromSRGBColor(FColor(222, 212, 195)));
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
                        : FSlateColor(FLinearColor::FromSRGBColor(FColor(222, 212, 195)));
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
        return SAssignNew(AgentPanel, SHaybaMCPChatPanel, Module).MainPanel(this);

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
                [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "World.Heading", "World")).Font(FCoreStyle::GetDefaultFontStyle("Bold", 18)) ]
                + SHorizontalBox::Slot().AutoWidth()
                [ SNew(SButton).Text(NSLOCTEXT("Hayba", "World.Refresh", "Refresh"))
                    .ToolTipText(NSLOCTEXT("Hayba", "World.RefreshTip", "Rescan loaded actors and findings"))
                    .OnClicked_Lambda([Map, Findings]() { Map->Refresh(); Findings->Refresh(); return FReply::Handled(); }) ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(6.f, 4.f, 6.f, 10.f)
            [
                SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.f, 8.f))
                + SWrapBox::Slot()
                [ SNew(SButton).Text(NSLOCTEXT("Hayba", "World.Inspect", "Inspect"))
                    .ContentPadding(FMargin(14.f, 8.f))
                    .ToolTipText(NSLOCTEXT("Hayba", "World.InspectTip", "Read current world, partition, landscape and save status. Does not change the level."))
                    .OnClicked_Lambda([this, Map, Findings]() { InspectWorld(); Map->Refresh(); Findings->Refresh(); return FReply::Handled(); }) ]
                + SWrapBox::Slot()
                [ SNew(SButton).Text(NSLOCTEXT("Hayba", "World.Import", "Import with Agent"))
                    .ContentPadding(FMargin(14.f, 8.f))
                    .ToolTipText(NSLOCTEXT("Hayba", "World.ImportTip", "Draft a guided world import request. Review and send it in Agent."))
                    .OnClicked_Lambda([this]() { DraftWorldTask(TEXT("Help me import terrain or a scene. Inspect the current world first, then ask for the source files and target area. Propose world_ingest with partition placement, material, collision, LOD and Nanite policies where supported. Show unsupported stages and dry-run results before any writes.")); return FReply::Handled(); }) ]
                + SWrapBox::Slot()
                [ SNew(SButton).Text(NSLOCTEXT("Hayba", "World.Validate", "Validate with Agent"))
                    .ContentPadding(FMargin(14.f, 8.f))
                    .ToolTipText(NSLOCTEXT("Hayba", "World.ValidateTip", "Draft a validation request in Agent. This button does not run checks yet."))
                    .OnClicked_Lambda([this]() { DraftWorldTask(TEXT("Inspect the current world and run available read-only validation, including validator_run if enabled. Report concrete findings, evidence, loaded-world coverage, and checks that could not run. Do not change or save the project.")); return FReply::Handled(); }) ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(6.f, 0.f, 6.f, 10.f)
            [ SNew(STextBlock).Text_Lambda([this]() { return WorldInspection; }).AutoWrapText(true) ]
            + SVerticalBox::Slot().AutoHeight().Padding(6.f, 0.f, 6.f, 5.f)
            [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "World.Coverage", "Coverage: loaded actors only. Unloaded World Partition regions are not indexed."))
                .ColorAndOpacity(FSlateColor(FLinearColor(0.64f, 0.66f, 0.69f))).AutoWrapText(true) ]
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

void SHaybaMCPMainPanel::DraftWorldTask(const FString& Prompt)
{
    ShowPanel(EHaybaPanel::Agent);
    if (AgentPanel.IsValid()) AgentPanel->DraftPrompt(Prompt);
}

void SHaybaMCPMainPanel::InspectWorld()
{
    if (!Module)
    {
        WorldInspection = NSLOCTEXT("Hayba", "World.Unavailable", "Inspection unavailable: reopen the Hayba toolkit.");
        return;
    }
    TWeakPtr<SHaybaMCPMainPanel> WeakSelf = SharedThis(this);
    Module->SendTcpCommand(TEXT("world_inspect"), MakeShared<FJsonObject>(),
        [WeakSelf](bool bOk, const TSharedPtr<FJsonObject>& Data)
        {
            const auto Self = WeakSelf.Pin();
            if (!Self.IsValid()) return;
            const TSharedPtr<FJsonObject>* World = nullptr;
            const TSharedPtr<FJsonObject>* Partition = nullptr;
            if (!bOk || !Data.IsValid() || !Data->TryGetObjectField(TEXT("world"), World)
                || !Data->TryGetObjectField(TEXT("partition"), Partition))
            {
                Self->WorldInspection = NSLOCTEXT("Hayba", "World.InspectFailed", "Could not inspect this world. Check the editor connection and try Inspect again.");
                return;
            }
            FString Package;
            (*World)->TryGetStringField(TEXT("package"), Package);
            bool bPartition = false, bSaveReady = false;
            (*Partition)->TryGetBoolField(TEXT("enabled"), bPartition);
            Data->TryGetBoolField(TEXT("save_ready"), bSaveReady);
            const TArray<TSharedPtr<FJsonValue>>* Landscapes = nullptr;
            const int32 Count = Data->TryGetArrayField(TEXT("landscape"), Landscapes) ? Landscapes->Num() : 0;
            Self->WorldInspection = FText::FromString(FString::Printf(
                TEXT("%s\nWorld Partition: %s    Loaded landscapes: %d\nCurrent map file: %s. External actor packages and checkout have not been checked."),
                *Package, bPartition ? TEXT("enabled") : TEXT("disabled"), Count,
                bSaveReady ? TEXT("existing and writable") : TEXT("not confirmed writable")));
        });
}
