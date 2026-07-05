#include "HaybaMCPPlanPanel.h"
#include "HaybaMCPModule.h"
#include "Modules/ModuleManager.h"

#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Styling/AppStyle.h"

#define LOCTEXT_NAMESPACE "HaybaMCPPlan"

namespace
{
    const FLinearColor ColorPending  (0.55f, 0.57f, 0.65f);
    const FLinearColor ColorRunning  (0.45f, 0.85f, 1.00f);
    const FLinearColor ColorCompleted(0.40f, 0.95f, 0.55f);
    const FLinearColor ColorFailed   (1.00f, 0.40f, 0.40f);
    const FLinearColor ColorMuted    (0.55f, 0.57f, 0.65f);
    const FLinearColor ColorAccent   (1.00f, 0.78f, 0.30f);

    const TCHAR* StatusGlyph(FHaybaPlanStep::EStatus S)
    {
        switch (S)
        {
            case FHaybaPlanStep::EStatus::Running:   return TEXT("●");
            case FHaybaPlanStep::EStatus::Completed: return TEXT("✓");
            case FHaybaPlanStep::EStatus::Failed:    return TEXT("✕");
            default:                                  return TEXT("○");
        }
    }
    FLinearColor StatusColor(FHaybaPlanStep::EStatus S)
    {
        switch (S)
        {
            case FHaybaPlanStep::EStatus::Running:   return ColorRunning;
            case FHaybaPlanStep::EStatus::Completed: return ColorCompleted;
            case FHaybaPlanStep::EStatus::Failed:    return ColorFailed;
            default:                                  return ColorPending;
        }
    }
}

void SHaybaMCPPlanPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 10.f, 12.f, 6.f)
        [ BuildHeader() ]

        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 0.f)
        [ SNew(SSeparator).Thickness(1.f) ]

        + SVerticalBox::Slot().FillHeight(1.f)
        [
            SNew(SScrollBox)
            + SScrollBox::Slot()
            [ SAssignNew(StepContainer, SVerticalBox) ]
        ]

        + SVerticalBox::Slot().AutoHeight()
        [ SNew(SSeparator).Thickness(1.f) ]

        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 8.f)
        [ BuildActionBar() ]
    ];

    RebuildSteps();
}

TSharedRef<SWidget> SHaybaMCPPlanPanel::BuildHeader()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
            .Text(LOCTEXT("HeaderTitle", "AI Plan"))
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
            .ColorAndOpacity(FSlateColor(ColorMuted))
            .AutoWrapText(true)
            .Text_Lambda([this]()
            {
                if (Steps.Num() == 0)
                    return LOCTEXT("HeaderEmpty",
                        "When Plan Mode is on, destructive tools (spawn / delete / set_property) require the agent to call hayba_propose_plan first. The proposed steps will land here for your approval before they run.");

                const int32 N = Steps.Num();
                if (bApproved)
                    return FText::FromString(FString::Printf(
                        TEXT("Plan approved · %d step%s · agent may proceed."),
                        N, N == 1 ? TEXT("") : TEXT("s")));

                return FText::FromString(FString::Printf(
                    TEXT("Proposed plan · %d step%s · awaiting your approval."),
                    N, N == 1 ? TEXT("") : TEXT("s")));
            })
        ];
}

TSharedRef<SWidget> SHaybaMCPPlanPanel::BuildEmptyState()
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("Brushes.Panel"))
        .Padding(FMargin(16.f, 14.f))
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
                .ColorAndOpacity(FSlateColor(ColorMuted))
                .AutoWrapText(true)
                .Text(LOCTEXT("EmptyHint",
                    "No plan proposed yet. The agent will call hayba_propose_plan with a steps[] array; you'll see those steps here and can Approve or Reject before any destructive op runs.\n\nWant to see what it looks like? Load a sample plan."))
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 12.f, 0.f, 0.f).HAlign(HAlign_Left)
            [
                SNew(SButton)
                .ContentPadding(FMargin(12.f, 4.f))
                .Text(LOCTEXT("LoadSample", "Load sample plan"))
                .OnClicked(this, &SHaybaMCPPlanPanel::OnLoadSamplePlan)
            ]
        ];
}

TSharedRef<SWidget> SHaybaMCPPlanPanel::BuildStepRow(const TSharedPtr<FHaybaPlanStep>& Step)
{
    if (!Step.IsValid()) return SNullWidget::NullWidget;
    const FHaybaPlanStep* S = Step.Get();
    const TCHAR* Glyph = StatusGlyph(S->Status);
    const FLinearColor Color = StatusColor(S->Status);

    TSharedRef<SVerticalBox> Body = SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
            .Text(FText::FromString(FString::Printf(TEXT("%d. %s"), S->Index + 1, *S->Title)))
        ];
    if (!S->Description.IsEmpty())
    {
        Body->AddSlot().AutoHeight().Padding(0.f, 2.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
            .ColorAndOpacity(FSlateColor(ColorMuted))
            .AutoWrapText(true)
            .Text(FText::FromString(S->Description))
        ];
    }
    if (!S->Tool.IsEmpty())
    {
        Body->AddSlot().AutoHeight().Padding(0.f, 2.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .Font(FCoreStyle::GetDefaultFontStyle("Mono", 9))
            .ColorAndOpacity(FSlateColor(FLinearColor(0.65f, 0.78f, 1.0f, 0.85f)))
            .Text(FText::FromString(FString::Printf(TEXT("→ %s"), *S->Tool)))
        ];
    }

    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("Brushes.Panel"))
        .Padding(FMargin(10.f, 8.f))
        [
            SNew(SHorizontalBox)
            // Status glyph
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Top).Padding(0.f, 0.f, 10.f, 0.f)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
                .ColorAndOpacity(FSlateColor(Color))
                .Text(FText::FromString(Glyph))
            ]
            + SHorizontalBox::Slot().FillWidth(1.f) [ Body ]
        ];
}

TSharedRef<SWidget> SHaybaMCPPlanPanel::BuildActionBar()
{
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth()
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "PrimaryButton")
            .ContentPadding(FMargin(14.f, 5.f))
            .IsEnabled_Lambda([this]() { return Steps.Num() > 0 && !bApproved; })
            .ToolTipText(LOCTEXT("ApproveTT",
                "Approve the proposed plan. Destructive tools blocked by Plan Mode will be allowed to run."))
            .OnClicked(this, &SHaybaMCPPlanPanel::OnApprove)
            [ SNew(STextBlock).Text(LOCTEXT("Approve", "Approve plan")) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(6.f, 0.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ContentPadding(FMargin(12.f, 5.f))
            .IsEnabled_Lambda([this]() { return Steps.Num() > 0; })
            .ToolTipText(LOCTEXT("RejectTT", "Discard the proposed plan."))
            .OnClicked(this, &SHaybaMCPPlanPanel::OnReject)
            [ SNew(STextBlock).Text(LOCTEXT("Reject", "Reject")) ]
        ]
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(12.f, 0.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
            .ColorAndOpacity_Lambda([this]() -> FSlateColor
            {
                return FSlateColor(bApproved ? ColorCompleted : ColorAccent);
            })
            .Text_Lambda([this]()
            {
                if (Steps.Num() == 0) return FText::GetEmpty();
                return bApproved
                    ? LOCTEXT("StateApproved", "✓ Approved — agent will proceed.")
                    : LOCTEXT("StateAwait",    "Awaiting your approval.");
            })
        ];
}

void SHaybaMCPPlanPanel::RebuildSteps()
{
    if (!StepContainer.IsValid()) return;
    StepContainer->ClearChildren();

    if (Steps.IsEmpty())
    {
        StepContainer->AddSlot().AutoHeight().Padding(12.f, 8.f)
        [ BuildEmptyState() ];
        return;
    }
    for (int32 i = 0; i < Steps.Num(); ++i)
    {
        StepContainer->AddSlot().AutoHeight().Padding(12.f, 4.f)
        [ BuildStepRow(Steps[i]) ];
    }
}

void SHaybaMCPPlanPanel::LoadPlan(const TArray<FHaybaPlanStep>& InSteps, int32 InAwait)
{
    Steps.Reset();
    for (const auto& S : InSteps) Steps.Add(MakeShared<FHaybaPlanStep>(S));
    AwaitSeconds = InAwait;
    LoadedAt = FDateTime::Now();
    bApproved = false;
    RebuildSteps();
}

void SHaybaMCPPlanPanel::MarkStepCompleted(int32 StepIndex)
{
    for (auto& S : Steps)
    {
        if (S->Index == StepIndex)
        {
            S->Status = FHaybaPlanStep::EStatus::Completed;
            S->bCompleted = true;
            S->bPending = false;
        }
    }
    RebuildSteps();
}

void SHaybaMCPPlanPanel::Clear()
{
    Steps.Reset();
    bApproved = false;
    AwaitSeconds = 0;
    RebuildSteps();
}

FReply SHaybaMCPPlanPanel::OnLoadSamplePlan()
{
    TArray<FHaybaPlanStep> Sample;
    {
        FHaybaPlanStep S; S.Index = 0;
        S.Title       = TEXT("Spawn a directional light at the origin");
        S.Description = TEXT("Adds a key light pointing south-east, 45° down.");
        S.Tool        = TEXT("actor_spawn");
        Sample.Add(S);
    }
    {
        FHaybaPlanStep S; S.Index = 1;
        S.Title       = TEXT("Generate Voronoi PCG graph for a 3x3 km region");
        S.Description = TEXT("Builds a PCGEx graph with bMarkHull, prunes out-of-bounds points.");
        S.Tool        = TEXT("hayba_create_pcg_graph");
        Sample.Add(S);
    }
    {
        FHaybaPlanStep S; S.Index = 2;
        S.Title       = TEXT("Execute the graph and import as a static mesh");
        S.Description = TEXT("Runs the PCGEx graph and bakes its output points into an ISM actor.");
        S.Tool        = TEXT("hayba_execute_pcg_graph");
        Sample.Add(S);
    }
    {
        FHaybaPlanStep S; S.Index = 3;
        S.Title       = TEXT("Validate physics across the new placements");
        S.Description = TEXT("Runs scene_validate_physics to catch floating or interpenetrating actors before the user looks at the result.");
        S.Tool        = TEXT("scene_validate_physics");
        Sample.Add(S);
    }
    LoadPlan(Sample, /*AwaitSecs=*/30);
    return FReply::Handled();
}

FReply SHaybaMCPPlanPanel::OnApprove()
{
    bApproved = true;
    if (Steps.Num() > 0) Steps[0]->Status = FHaybaPlanStep::EStatus::Running;
    // Tell the destructive-op gate (Module->bPlanApproved) that this plan
    // is cleared to proceed. Gate consumes the flag per command.
    if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
    {
        M->bPlanApproved = true;
        // Notify the chat panel (and any observer) so a paused streaming turn
        // can POST /chat/approve and resume. Broadcast AFTER the flag is set.
        M->OnPlanApproved.Broadcast();
    }
    RebuildSteps();
    return FReply::Handled();
}

FReply SHaybaMCPPlanPanel::OnReject()
{
    // Make sure rejecting clears the approval flag in case it was somehow set.
    if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
    {
        M->bPlanApproved = false;
    }
    Clear();
    return FReply::Handled();
}

#undef LOCTEXT_NAMESPACE
