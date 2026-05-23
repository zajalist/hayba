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
#include "Styling/AppStyle.h"

namespace
{
    FText PanelLabel(EHaybaPanel P)
    {
        switch (P)
        {
            case EHaybaPanel::Chat:       return NSLOCTEXT("Hayba", "Tab.Chat",       "Chat");
            case EHaybaPanel::MCP:        return NSLOCTEXT("Hayba", "Tab.MCP",        "MCP");
            case EHaybaPanel::Slivers:    return NSLOCTEXT("Hayba", "Tab.Slivers",    "Slivers");
            case EHaybaPanel::ToolStream: return NSLOCTEXT("Hayba", "Tab.ToolStream", "Tool Stream");
            case EHaybaPanel::SceneMap:   return NSLOCTEXT("Hayba", "Tab.SceneMap",   "Scene Map");
            case EHaybaPanel::Plan:       return NSLOCTEXT("Hayba", "Tab.Plan",       "Plan");
            case EHaybaPanel::Diff:       return NSLOCTEXT("Hayba", "Tab.Diff",       "Diff");
            case EHaybaPanel::Validation: return NSLOCTEXT("Hayba", "Tab.Validation", "Validation");
            case EHaybaPanel::Memory:     return NSLOCTEXT("Hayba", "Tab.Memory",     "Memory");
            case EHaybaPanel::Settings:   return NSLOCTEXT("Hayba", "Tab.Settings",   "Settings");
        }
        return FText::GetEmpty();
    }

    FName PanelIcon(EHaybaPanel P)
    {
        switch (P)
        {
            case EHaybaPanel::Chat:       return TEXT("Hayba.Icon.Chat");
            case EHaybaPanel::MCP:        return TEXT("Hayba.Icon.MCP");
            case EHaybaPanel::Slivers:    return TEXT("Hayba.Icon.Slivers");
            case EHaybaPanel::ToolStream: return TEXT("Hayba.Icon.ToolStream");
            case EHaybaPanel::SceneMap:   return TEXT("Hayba.Icon.SceneMap");
            case EHaybaPanel::Plan:       return TEXT("Hayba.Icon.Plan");
            case EHaybaPanel::Diff:       return TEXT("Hayba.Icon.Diff");
            case EHaybaPanel::Validation: return TEXT("Hayba.Icon.Validation");
            case EHaybaPanel::Memory:     return TEXT("Hayba.Icon.Memory");
            case EHaybaPanel::Settings:   return TEXT("Hayba.Icon.Settings");
        }
        return NAME_None;
    }
}

void SHaybaMCPMainPanel::Construct(const FArguments& InArgs, FHaybaMCPModule* InModule)
{
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
                    [ BuildPanelContent(
                        FHaybaMCPSettings::Get().OperationMode == EHaybaMCPOperationMode::Integrated
                            ? EHaybaPanel::ToolStream : EHaybaPanel::Chat) ]
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
            .ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.57f, 0.65f)))
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
        ];
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildSidebar()
{
    SAssignNew(Sidebar, SVerticalBox);

    // Q19: Integrated mode users never type in our Chat tab — they're talking
    // to Claude in their MCP host (Claude Desktop / Code / Cursor). Hide the
    // Chat sidebar item entirely in that mode; the observability tabs
    // (Tool Stream, Plan, etc.) carry the value.
    const bool bIntegrated = FHaybaMCPSettings::Get().OperationMode == EHaybaMCPOperationMode::Integrated;

    TArray<EHaybaPanel> Items;
    if (!bIntegrated) Items.Add(EHaybaPanel::Chat);
    Items.Append({
        EHaybaPanel::MCP, EHaybaPanel::Slivers, EHaybaPanel::ToolStream, EHaybaPanel::SceneMap,
        EHaybaPanel::Plan, EHaybaPanel::Diff, EHaybaPanel::Validation,
        EHaybaPanel::Memory, EHaybaPanel::Settings,
    });
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
    CurrentPanel = Panel;
    if (!ContentArea.IsValid()) return;

    // Cache-on-first-build: heavy widgets (CEF for Scene Map, Memory SQLite
    // hookups) keep their state across tab switches instead of re-initializing.
    if (TSharedRef<SWidget>* Cached = PanelCache.Find(Panel))
    {
        ContentArea->SetContent(*Cached);
        if (TFunction<void()>* Hook = PanelRefreshHook.Find(Panel)) (*Hook)();
        return;
    }
    TSharedRef<SWidget> Content = BuildPanelContent(Panel);
    PanelCache.Add(Panel, Content);
    ContentArea->SetContent(Content);
}

void SHaybaMCPMainPanel::ShowOnboardingFromSplash()
{
    if (!ContentArea.IsValid()) return;
    TSharedRef<SDockTab> DummyOwner = SNew(SDockTab).TabRole(ETabRole::PanelTab);
    ContentArea->SetContent(SNew(SHaybaMCPOnboardingWidget, DummyOwner));
}

TSharedRef<SWidget> SHaybaMCPMainPanel::BuildPanelContent(EHaybaPanel Panel)
{
    auto Heading = [this, Panel](const FText& Sub)
    {
        // Compact, single-row heading: panel name + muted subtitle inline.
        // Sized to match Details / Outliner section headers.
        return SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
                .Text(PanelLabel(Panel))
            ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(10.f, 0.f, 0.f, 0.f)
            [
                SNew(STextBlock)
                .ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.57f, 0.65f)))
                .Text(Sub)
            ];
    };

    TSharedPtr<SWidget> Body;
    FText Subtitle;
    switch (Panel)
    {
        case EHaybaPanel::Chat:
            Subtitle = NSLOCTEXT("Hayba", "Chat.Sub", "Talk to your AI in the editor.");
            // No accent stripe, no wrapping border — the Chat panel owns its
            // own layout and matches UE5's flat panel aesthetic.
            Body = SNew(SHaybaMCPChatPanel, Module).MainPanel(this);
            break;
        case EHaybaPanel::MCP:
            Subtitle = NSLOCTEXT("Hayba", "MCP.Sub", "Pick which tools your AI agent can see.");
            Body = SNew(SHaybaMCPCapabilitiesPanel).Module(Module);
            break;
        case EHaybaPanel::Slivers:
        {
            Subtitle = NSLOCTEXT("Hayba", "Slivers.Sub",
                "Deterministic abstractions — pick a sliver, set its parameters, run it.");
            auto Panel2 = SNew(SSliversPanel);
            // Re-shown from cache → re-scan the installed slivers directory.
            PanelRefreshHook.Add(EHaybaPanel::Slivers, [Panel2]() { Panel2->Refresh(); });
            Body = Panel2;
            break;
        }
        case EHaybaPanel::ToolStream:
        {
            Subtitle = NSLOCTEXT("Hayba", "Stream.Sub", "Live trace of every tool call.");
            auto Panel2 = SNew(SHaybaMCPToolStreamPanel);
            if (Module) Module->ToolStreamPanel = Panel2;
            Body = Panel2;
            break;
        }
        case EHaybaPanel::SceneMap:
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
                if (Module) Module->SceneMapPanel = N;
                Canvas = N;
                DoRefresh = [N]() { N->Refresh(); };
                DoFit     = [N]() { N->FitView(); };
                DoReset   = [N]() { N->ResetView(); };
                GetCount  = [N]() { return N->GetCellCount(); };
            }
            // Re-shown from cache → re-scan the world.
            PanelRefreshHook.Add(EHaybaPanel::SceneMap, DoRefresh);

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
                        .ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.57f, 0.65f)))
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
        case EHaybaPanel::Plan:
        {
            Subtitle = NSLOCTEXT("Hayba", "Plan.Sub", "AI-proposed plan steps before destructive actions.");
            auto Panel2 = SNew(SHaybaMCPPlanPanel);
            if (Module) Module->PlanPanel = Panel2;
            Body = Panel2;
            break;
        }
        case EHaybaPanel::Diff:
        {
            Subtitle = NSLOCTEXT("Hayba", "Diff.Sub", "Before / after for every destructive op.");
            auto Panel2 = SNew(SHaybaMCPDiffPanel);
            if (Module) Module->DiffPanel = Panel2;
            Body = Panel2;
            break;
        }
        case EHaybaPanel::Validation:
        {
            Subtitle = NSLOCTEXT("Hayba", "Val.Sub",
                "Runtime validator: post-condition findings and AI-floppy hints. Findings persist in .scratch/validator-history.jsonl.");
            auto Panel2 = SNew(SHaybaValidatorPanel);
            // Re-shown from cache → re-read the JSONL file.
            PanelRefreshHook.Add(EHaybaPanel::Validation, [Panel2]() { Panel2->Refresh(); });
            Body = Panel2;
            break;
        }
        case EHaybaPanel::Memory:
        {
            Subtitle = NSLOCTEXT("Hayba", "Mem.Sub", "Shared collaborative memory across runs.");
            auto Panel2 = SNew(SHaybaMCPMemoryPanel);
            if (Module) Module->MemoryPanel = Panel2;
            Body = Panel2;
            break;
        }
        case EHaybaPanel::Settings:
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
