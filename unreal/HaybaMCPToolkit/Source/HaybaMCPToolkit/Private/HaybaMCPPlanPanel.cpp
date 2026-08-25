#include "HaybaMCPPlanPanel.h"
#include "HaybaMCPStyle.h"
#include "HaybaMCPStatusVocabulary.h"
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
    // These used to be six literal FLinearColors defined right here. They
    // bypassed the style tokens, which meant style-token-check could not see
    // them at all -- it verifies that referenced tokens exist, and a hardcoded
    // colour never references one. The old ColorAccent was (1.00, 0.78, 0.30),
    // a bright yellow-orange, while the product's ochre is #C47A28. This
    // panel's accent was simply a different colour from every other accent in
    // the dock.
    FSlateColor Muted()
    {
        return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted"));
    }

    /** A plan step's status in the product's shared vocabulary.
     *
     *  Pending maps to NotStarted, not to NeedsApproval: a step that has not
     *  run yet is not waiting on a decision from the user, and saying it is
     *  would put an approval prompt where there is nothing to approve. */
    EHaybaStatus ToStatus(FHaybaPlanStep::EStatus S)
    {
        switch (S)
        {
            case FHaybaPlanStep::EStatus::Running:   return EHaybaStatus::Running;
            case FHaybaPlanStep::EStatus::Completed: return EHaybaStatus::Done;
            case FHaybaPlanStep::EStatus::Failed:    return EHaybaStatus::Error;
            default:                                  return EHaybaStatus::NotStarted;
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
            .ColorAndOpacity(Muted())
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
                .ColorAndOpacity(Muted())
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
    const EHaybaStatus Status = ToStatus(S->Status);
    const TCHAR* Glyph = HaybaStatus::Glyph(Status);
    const FSlateColor Color = HaybaStatus::Colour(Status);

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
            .ColorAndOpacity(Muted())
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
            // Secondary text, not a tint. This was a hardcoded pale blue,
            // which the visual brief rules out: "If a shape is ochre, it
            // means something" -- and the same goes for any colour. A tool
            // name is supporting detail, so it reads as supporting detail.
            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary")))
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
                // Ochre because this is the IA's "needs approval": the work
                // is paused on the user. Green once they have said yes.
                return HaybaStatus::Colour(bApproved
                    ? EHaybaStatus::Done
                    : EHaybaStatus::NeedsApproval);
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
    // Make sure rejecting clears the approval flag in case it was somehow set,
    // then notify the chat panel so it disarms and cancels the paused turn.
    // Without this broadcast the chat panel would stay armed and a later,
    // unrelated Approve would resume this rejected turn (wrong-context fan-out).
    if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
    {
        M->bPlanApproved = false;
        M->OnPlanRejected.Broadcast();
    }
    Clear();
    return FReply::Handled();
}

#undef LOCTEXT_NAMESPACE
