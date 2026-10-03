#include "Misc/AutomationTest.h"

#if WITH_EDITOR
#include "HaybaMCPMainPanel.h"
#include "HaybaMCPPlanPanel.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaChatPlanFirstUseTest,
    "Hayba.MCP.Chat.PlanFirstUse",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatPlanFirstUseTest::RunTest(const FString& Parameters)
{
    TSharedRef<SHaybaMCPMainPanel> MainPanel = SNew(SHaybaMCPMainPanel, nullptr);

    FHaybaPlanStep First;
    First.Title = TEXT("Review first proposed action");
    TArray<FHaybaPlanStep> Steps;
    Steps.Add(First);
    TSharedPtr<SHaybaMCPPlanPanel> PlanPanel = MainPanel->PreparePlanReview();
    if (!TestTrue(TEXT("first proposal creates a review surface"), PlanPanel.IsValid())) return false;
    PlanPanel->LoadPlan(Steps, 120);
    TestEqual(TEXT("first proposal is present"), PlanPanel->GetStepCount(), 1);
    TestFalse(TEXT("loading never approves the proposal"), PlanPanel->IsApproved());

    MainPanel->ShowSection(EHaybaSection::Plan);
    TestTrue(TEXT("opening Plan reuses the loaded review surface"),
        MainPanel->PreparePlanReview() == PlanPanel);
    TestEqual(TEXT("proposal survives navigation"), PlanPanel->GetStepCount(), 1);

    FHaybaPlanStep Second;
    Second.Title = TEXT("Review second proposed action");
    Steps.Add(Second);
    MainPanel->PreparePlanReview()->LoadPlan(Steps, 120);
    TestEqual(TEXT("later proposal replaces review contents"), PlanPanel->GetStepCount(), 2);
    TestFalse(TEXT("later proposal remains unapproved"), PlanPanel->IsApproved());
    return true;
}
#endif
