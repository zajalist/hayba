#include "HaybaMCPPlanPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/SBoxPanel.h"

void SHaybaMCPPlanPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(8)
        [ SNew(STextBlock).Text(NSLOCTEXT("Hayba", "PlanTitle", "AI Plan")) ]
        + SVerticalBox::Slot().FillHeight(1.f)
        [
            SAssignNew(StepList, SListView<TSharedPtr<FHaybaPlanStep>>)
            .ListItemsSource(&Steps)
            .OnGenerateRow(this, &SHaybaMCPPlanPanel::GenerateStepRow)
        ]
    ];
}

void SHaybaMCPPlanPanel::LoadPlan(const TArray<FHaybaPlanStep>& InSteps, int32 AwaitSeconds)
{
    Steps.Reset();
    for (const auto& S : InSteps) Steps.Add(MakeShared<FHaybaPlanStep>(S));
    PendingAwaitSeconds = AwaitSeconds;
    if (StepList.IsValid()) StepList->RequestListRefresh();
}

void SHaybaMCPPlanPanel::MarkStepCompleted(int32 StepIndex)
{
    for (auto& S : Steps)
    {
        if (S->Index == StepIndex) { S->bCompleted = true; S->bPending = false; }
    }
    if (StepList.IsValid()) StepList->RequestListRefresh();
}

void SHaybaMCPPlanPanel::Clear()
{
    Steps.Reset();
    if (StepList.IsValid()) StepList->RequestListRefresh();
}

TSharedRef<ITableRow> SHaybaMCPPlanPanel::GenerateStepRow(TSharedPtr<FHaybaPlanStep> Step, const TSharedRef<STableViewBase>& Owner)
{
    const TCHAR* Marker = Step->bCompleted ? TEXT("[x]") : (Step->bPending ? TEXT("[ ]") : TEXT("[>]"));
    const FText Label = FText::FromString(FString::Printf(TEXT("%s %d. %s"), Marker, Step->Index + 1, *Step->Title));
    return SNew(STableRow<TSharedPtr<FHaybaPlanStep>>, Owner)
        [ SNew(STextBlock).Text(Label) ];
}
