#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"

struct FHaybaPlanStep
{
    int32 Index = 0;
    FString Title;
    bool bCompleted = false;
    bool bPending = true;
};

class SHaybaMCPPlanPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPPlanPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    void LoadPlan(const TArray<FHaybaPlanStep>& InSteps, int32 AwaitSeconds);
    void MarkStepCompleted(int32 StepIndex);
    void Clear();

private:
    TArray<TSharedPtr<FHaybaPlanStep>> Steps;
    TSharedPtr<SListView<TSharedPtr<FHaybaPlanStep>>> StepList;
    int32 PendingAwaitSeconds = 0;

    TSharedRef<ITableRow> GenerateStepRow(TSharedPtr<FHaybaPlanStep> Step, const TSharedRef<STableViewBase>& Owner);
};
