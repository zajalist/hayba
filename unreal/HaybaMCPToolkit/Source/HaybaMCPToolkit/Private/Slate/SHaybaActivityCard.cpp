#include "Slate/SHaybaActivityCard.h"

#include "Styling/AppStyle.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "HaybaActivityCard"

namespace
{
    FString StateLabel(EHaybaActivityState State, const FString& Outcome = FString())
    {
        if (Outcome == TEXT("cancelled")) return TEXT("Cancelled");
        switch (State)
        {
            case EHaybaActivityState::Planning: return TEXT("Planning");
            case EHaybaActivityState::AwaitingApproval: return TEXT("Awaiting approval");
            case EHaybaActivityState::Running: return TEXT("Running");
            case EHaybaActivityState::Succeeded: return TEXT("Succeeded");
            case EHaybaActivityState::Failed: return TEXT("Failed");
            case EHaybaActivityState::Unknown: return TEXT("Connection uncertain");
        }
        return TEXT("Unknown");
    }
}

FHaybaActivityCardPresentation SHaybaActivityCard::Describe(const FHaybaActivity& Activity)
{
    return { Activity.Title, StateLabel(Activity.State, Activity.Outcome), Activity.State == EHaybaActivityState::AwaitingApproval && Activity.Approval.IsSet() };
}

void SHaybaActivityCard::Construct(const FArguments& InArgs)
{
    ActivityModel = InArgs._ActivityModel;
    ActivityId = InArgs._ActivityId;
    bExpanded = InArgs._InitiallyExpanded;
    OnExpansionChanged = InArgs._OnExpansionChanged;
    OnApprove = InArgs._OnApprove;
    OnReject = InArgs._OnReject;
    OnCancel = InArgs._OnCancel;
    OnRetry = InArgs._OnRetry;
    OnUndo = InArgs._OnUndo;
    OnSaveAsRecipe = InArgs._OnSaveAsRecipe;
    Rebuild();
}

void SHaybaActivityCard::Rebuild()
{
    const FHaybaActivity* Current = Activity();
    if (!Current)
    {
        ChildSlot [ SNullWidget::NullWidget ];
        return;
    }
    const FHaybaActivityCardPresentation Presentation = Describe(*Current);
    TSharedRef<SVerticalBox> Body = SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
            [
                SNew(SButton)
                .ButtonStyle(FAppStyle::Get(), "SimpleButton")
                .ToolTipText(LOCTEXT("ExpandActivity", "Show activity details"))
                .ContentPadding(FMargin(4.f, 4.f))
                .OnClicked(this, &SHaybaActivityCard::ToggleExpanded)
                [
                    SNew(STextBlock).Text(FText::FromString(FString::Printf(TEXT("%s  ·  %s  %s"),
                        bExpanded ? TEXT("⌄") : TEXT("›"), *Presentation.Title, *Presentation.StateLabel)))
                ]
            ]
        ];

    if (Current->State == EHaybaActivityState::AwaitingApproval && Current->Approval.IsSet())
    {
        const FString Scope = Current->Approval->Call.Name.IsEmpty() ? TEXT("proposed action") : Current->Approval->Call.Name;
        const FString Risk = Current->Approval->Hint.IsEmpty() ? TEXT("Review scope and reversibility before approval.") : Current->Approval->Hint;
        Body->AddSlot().AutoHeight().Padding(4.f, 4.f, 4.f, 0.f)
        [ SNew(STextBlock).Text(FText::FromString(FString::Printf(TEXT("Scope: %s. %s"), *Scope, *Risk))).AutoWrapText(true) ];
        TSharedRef<SHorizontalBox> Actions = SNew(SHorizontalBox);
        if (OnApprove.IsBound()) Actions->AddSlot().AutoWidth().Padding(0.f, 0.f, 8.f, 0.f)
            [ BuildAction(LOCTEXT("Approve", "Approve"), LOCTEXT("ApproveTip", "Approve this exact planned action"), OnApprove) ];
        if (OnReject.IsBound()) Actions->AddSlot().AutoWidth()
            [ BuildAction(LOCTEXT("Reject", "Reject"), LOCTEXT("RejectTip", "Reject and cancel this planned action"), OnReject) ];
        Body->AddSlot().AutoHeight().Padding(4.f, 8.f, 0.f, 0.f)[ Actions ];
    }
    else if (Current->State == EHaybaActivityState::Running && OnCancel.IsBound())
    {
        Body->AddSlot().AutoHeight().Padding(4.f, 4.f, 0.f, 0.f) [ BuildAction(LOCTEXT("Cancel", "Cancel"), LOCTEXT("CancelTip", "Cancel this running activity"), OnCancel) ];
    }
    else if (Current->State == EHaybaActivityState::Failed && Current->Outcome != TEXT("cancelled") && OnRetry.IsBound())
    {
        Body->AddSlot().AutoHeight().Padding(4.f, 4.f, 0.f, 0.f) [ BuildAction(LOCTEXT("Retry", "Retry"), LOCTEXT("RetryTip", "Retry only when this activity declares it safe"), OnRetry) ];
    }
    else if (Current->State == EHaybaActivityState::Succeeded)
    {
        if (OnUndo.IsBound()) Body->AddSlot().AutoHeight().Padding(4.f, 4.f, 0.f, 0.f) [ BuildAction(LOCTEXT("Undo", "Undo"), LOCTEXT("UndoTip", "Undo this activity when its transaction supports it"), OnUndo) ];
        if (OnSaveAsRecipe.IsBound()) Body->AddSlot().AutoHeight().Padding(4.f, 4.f, 0.f, 0.f) [ BuildAction(LOCTEXT("SaveRecipe", "Save as recipe"), LOCTEXT("SaveRecipeTip", "Save this reviewed workflow as a reusable recipe"), OnSaveAsRecipe) ];
    }
    if (bExpanded) Body->AddSlot().AutoHeight().Padding(4.f, 6.f, 4.f, 2.f) [ BuildDetails(*Current) ];

    ChildSlot
    [
        SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("Brushes.Recessed"))
        .Padding(FMargin(6.f, 4.f))
        [ Body ]
    ];
}

const FHaybaActivity* SHaybaActivityCard::Activity() const
{
    return ActivityModel ? ActivityModel->FindActivity(ActivityId) : nullptr;
}

FReply SHaybaActivityCard::ToggleExpanded()
{
    bExpanded = !bExpanded;
    OnExpansionChanged.ExecuteIfBound(ActivityId, bExpanded);
    Rebuild();
    return FReply::Handled();
}

FReply SHaybaActivityCard::Execute(FSimpleDelegate Action)
{
    if (Action.IsBound()) Action.Execute();
    return FReply::Handled();
}

TSharedRef<SWidget> SHaybaActivityCard::BuildAction(const FText& Label, const FText& Tooltip, FSimpleDelegate Action)
{
    return SNew(SBox).HeightOverride(32.f)
    [
        SNew(SButton)
        .ButtonStyle(FAppStyle::Get(), "SimpleButton")
        .Text(Label)
        .ContentPadding(FMargin(12.f, 4.f))
        .ToolTipText(Tooltip)
        .OnClicked(this, &SHaybaActivityCard::Execute, Action)
    ];
}

TSharedRef<SWidget> SHaybaActivityCard::BuildDetails(const FHaybaActivity& Current)
{
    TSharedRef<SVerticalBox> Details = SNew(SVerticalBox);
    if (!Current.SpecialistId.IsEmpty()) Details->AddSlot().AutoHeight()[SNew(STextBlock).Text(FText::FromString(FString::Printf(TEXT("Specialist: %s"), *Current.SpecialistId)))];
    for (const FHaybaActivityStep& Step : Current.Steps)
    {
        Details->AddSlot().AutoHeight().Padding(0.f, 2.f)
        [ SNew(STextBlock).Text(FText::FromString(FString::Printf(TEXT("%s — %s"), *StateLabel(Step.State), *Step.Name))).AutoWrapText(true) ];
        // Inputs, results, and diagnostics remain raw and appear only after expansion.
        if (!Step.InputJson.IsEmpty()) Details->AddSlot().AutoHeight().Padding(8.f, 0.f)[SNew(STextBlock).Text(FText::FromString(Step.InputJson)).AutoWrapText(true)];
        if (!Step.ResultJson.IsEmpty()) Details->AddSlot().AutoHeight().Padding(8.f, 0.f)[SNew(STextBlock).Text(FText::FromString(Step.ResultJson)).AutoWrapText(true)];
    }
    for (const FHaybaActivityVerdict& Verdict : Current.Verdicts)
        Details->AddSlot().AutoHeight().Padding(0.f, 2.f)[SNew(STextBlock).Text(FText::FromString(FString::Printf(TEXT("%s: %s"), *Verdict.Severity, *Verdict.Message))).AutoWrapText(true)];
    if (!Current.Error.IsEmpty()) Details->AddSlot().AutoHeight().Padding(0.f, 2.f)[SNew(STextBlock).Text(FText::FromString(Current.Error)).AutoWrapText(true)];
    return Details;
}

#undef LOCTEXT_NAMESPACE
