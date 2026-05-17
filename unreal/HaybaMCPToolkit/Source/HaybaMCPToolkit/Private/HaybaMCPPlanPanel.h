#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"

class SVerticalBox;
class SScrollBox;

struct FHaybaPlanStep
{
    int32   Index = 0;
    FString Title;
    FString Description;   // optional explainer
    FString Tool;          // optional: which tool will execute this step

    enum class EStatus : uint8 { Pending, Running, Completed, Failed };
    EStatus Status = EStatus::Pending;

    // Compat shim — old callers set bCompleted / bPending directly.
    bool bCompleted = false;
    bool bPending = true;
};

class SHaybaMCPPlanPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPPlanPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    /** Replace the current plan. AwaitSeconds is how long the agent will wait
        for human approval before timing out. */
    void LoadPlan(const TArray<FHaybaPlanStep>& InSteps, int32 AwaitSeconds);

    /** Mark a specific step completed (called from the destructive-op gate). */
    void MarkStepCompleted(int32 StepIndex);

    /** Wipe the plan and reset approval. */
    void Clear();

    /** True after the user has clicked Approve. The destructive-op gate
        reads this through the module to decide whether to proceed. */
    bool IsApproved() const { return bApproved; }

private:
    TArray<TSharedPtr<FHaybaPlanStep>> Steps;
    TSharedPtr<SVerticalBox> StepContainer;
    int32 AwaitSeconds = 0;
    bool  bApproved = false;
    FDateTime LoadedAt = FDateTime::MinValue();

    TSharedRef<SWidget> BuildHeader();
    TSharedRef<SWidget> BuildEmptyState();
    TSharedRef<SWidget> BuildStepRow(const TSharedPtr<FHaybaPlanStep>& Step);
    TSharedRef<SWidget> BuildActionBar();
    void RebuildSteps();

    // Test action — populate with a sample plan so the tab can be
    // exercised end-to-end without an agent.
    FReply OnLoadSamplePlan();
    FReply OnApprove();
    FReply OnReject();
};
