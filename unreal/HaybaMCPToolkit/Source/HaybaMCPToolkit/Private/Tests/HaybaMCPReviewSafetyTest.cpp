#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "HaybaMCPDiffPanel.h"
#include "HaybaMCPPlanPanel.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
    bool ContainsText(const TSharedRef<SWidget>& Widget, const FString& Needle)
    {
        if (Widget->GetType() == TEXT("STextBlock"))
        {
            const TSharedRef<STextBlock> Text = StaticCastSharedRef<STextBlock>(Widget);
            if (Text->GetText().ToString().Contains(Needle)) return true;
        }
        FChildren* Children = Widget->GetChildren();
        for (int32 Index = 0; Children && Index < Children->Num(); ++Index)
        {
            if (ContainsText(Children->GetChildAt(Index), Needle)) return true;
        }
        return false;
    }

    TSharedPtr<SButton> FindButtonWithLabel(const TSharedRef<SWidget>& Widget, const FString& Label)
    {
        if (Widget->GetType() == TEXT("SButton") && ContainsText(Widget, Label))
            return StaticCastSharedRef<SButton>(Widget);

        FChildren* Children = Widget->GetChildren();
        for (int32 Index = 0; Children && Index < Children->Num(); ++Index)
        {
            if (TSharedPtr<SButton> Found = FindButtonWithLabel(Children->GetChildAt(Index), Label))
                return Found;
        }
        return nullptr;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaReviewSafetyTest, "Hayba.MCP.Review.SafeActions",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaReviewSafetyTest::RunTest(const FString&)
{
    const TSharedRef<SHaybaMCPPlanPanel> Plan = SNew(SHaybaMCPPlanPanel);
    const TSharedPtr<SButton> Approve = FindButtonWithLabel(Plan, TEXT("Approve plan"));
    if (!TestTrue(TEXT("real plan approval remains available"), Approve.IsValid())) return false;
    TestFalse(TEXT("empty plan cannot be approved"), Approve->IsEnabled());
    // Exercise the handler directly as a belt-and-braces check: even if a
    // caller bypasses the button's disabled state, an empty plan cannot arm it.
    Plan->OnApprove();
    TestFalse(TEXT("empty approval cannot arm a plan"), Plan->IsApproved());
    TestFalse(TEXT("live review has no sample-plan action"),
        FindButtonWithLabel(Plan, TEXT("Load sample plan")).IsValid());

    FHaybaPlanStep Step;
    Step.Title = TEXT("Review proposed action");
    TArray<FHaybaPlanStep> Steps;
    Steps.Add(Step);
    Plan->LoadPlan(Steps, 120);
    TestTrue(TEXT("a proposed plan can be reviewed"), Approve->IsEnabled());
    TestFalse(TEXT("loading a proposal does not approve it"), Plan->IsApproved());

    const TSharedRef<SHaybaMCPDiffPanel> Diff = SNew(SHaybaMCPDiffPanel);
    FHaybaDiffEntry Entry;
    Entry.ActorLabel = TEXT("Test actor");
    Entry.Property = TEXT("Location");
    Entry.Before = TEXT("0");
    Entry.After = TEXT("1");
    Diff->AddEntry(Entry);
    TestTrue(TEXT("property review remains available"),
        FindButtonWithLabel(Diff, TEXT("Mark reviewed")).IsValid());
    TestFalse(TEXT("row cannot claim to revert an unrelated editor transaction"),
        FindButtonWithLabel(Diff, TEXT("Revert")).IsValid());
    TestFalse(TEXT("bulk review cannot unwind the global editor undo stack"),
        FindButtonWithLabel(Diff, TEXT("Undo")).IsValid());
    return true;
}
#endif
