#include "Misc/AutomationTest.h"
#include "HaybaMCPPlanOverlay.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPMainPanel.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "RHI.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaExternalProposalTest, "Hayba.MCP.Workspace.ExternalProposal",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaExternalProposalTest::RunTest(const FString&)
{
    FHaybaMCPModule Module;
    TestFalse(TEXT("cannot approve without a proposal"), Module.ResolveExternalPlan(true));
    FHaybaExternalPlanStep Step;
    Step.Title = TEXT("Spawn one blockout cube");
    Step.Tool = TEXT("actor_spawn");
    Module.ProposeExternalPlan(TEXT("Spawn one blockout cube"), { Step });
    TestFalse(TEXT("proposal does not grant approval"), Module.bPlanApproved);
    TestEqual(TEXT("structured step retained for review"), Module.PendingExternalSteps.Num(), 1);
    TestFalse(TEXT("proposal ID assigned"), Module.PendingExternalPlanId.IsEmpty());
    TestTrue(TEXT("explicit approval succeeds"), Module.ResolveExternalPlan(true));
    TestTrue(TEXT("native gate receives approval"), Module.bPlanApproved);
    TestTrue(TEXT("resolved proposal cleared"), Module.PendingExternalPlan.IsEmpty());
    TestTrue(TEXT("resolved review data cleared"), Module.PendingExternalSteps.IsEmpty() && Module.PendingExternalPlanId.IsEmpty());
    Module.ProposeExternalPlan(TEXT("Delete that cube"));
    TestFalse(TEXT("new proposal revokes old approval"), Module.bPlanApproved);
    TestTrue(TEXT("rejection resolves proposal"), Module.ResolveExternalPlan(false));
    TestFalse(TEXT("rejection grants no approval"), Module.bPlanApproved);
    return true;
}

// Explicit visual review: real Slate renderer at both dock widths; no agent execution.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorkspaceVisualReview, "Hayba.MCP.Workspace.VisualReview",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaWorkspaceVisualReview::RunTest(const FString&)
{
    if (GUsingNullRHI) { AddInfo(TEXT("Visual capture skipped under NullRHI.")); return true; }
    const FString Dir = FPaths::ProjectSavedDir() / TEXT("Screenshots/HaybaReview");
    IFileManager::Get().MakeDirectory(*Dir, true);
    for (const int32 Width : { 1000, 460, 360 })
    {
        FHaybaMCPModule Module;
        TSharedRef<SHaybaMCPMainPanel> Panel = SNew(SHaybaMCPMainPanel, &Module);
        TSharedRef<SWindow> Window = SNew(SWindow).ClientSize(FVector2D(Width, 720))
            .Title(FText::FromString(TEXT("Hayba workspace review")))
            .SupportsMaximize(false).SupportsMinimize(false)[ Panel ];
        FSlateApplication::Get().AddWindow(Window);
        for (const FString View : { FString(TEXT("Agent")), FString(TEXT("Proposal")),
            FString(TEXT("World")), FString(TEXT("Activity")), FString(TEXT("Rules")),
            FString(TEXT("Library")), FString(TEXT("Settings")) })
        {
            if (View == TEXT("Proposal"))
            {
                FHaybaExternalPlanStep Place;
                Place.Title = TEXT("Place three blockout volumes in the selected room");
                Place.Tool = TEXT("actor_spawn");
                FHaybaExternalPlanStep Check;
                Check.Title = TEXT("Check player clearances before saving");
                Check.Tool = TEXT("actor_get_bounds");
                Module.ProposeExternalPlan(TEXT("Place blockout volumes and check clearances"), { Place, Check });
            }
            if (View == TEXT("World")) Panel->ShowPanel(EHaybaPanel::World);
            if (View == TEXT("Activity")) Panel->ShowPanel(EHaybaPanel::Activity);
            if (View == TEXT("Rules")) Panel->ShowPanel(EHaybaPanel::Rules);
            if (View == TEXT("Library")) Panel->ShowPanel(EHaybaPanel::Library);
            if (View == TEXT("Settings")) Panel->ShowPanel(EHaybaPanel::Settings);
            FSlateApplication::Get().Tick();
            FSlateApplication::Get().ForceRedrawWindow(Window);
            TArray<FColor> Pixels;
            FIntVector Size;
            const bool bCaptured = FSlateApplication::Get().TakeScreenshot(Panel, Pixels, Size);
            TestTrue(TEXT("Slate screenshot captured"), bCaptured);
            if (bCaptured)
            {
                TArray64<uint8> Png;
                FImageUtils::PNGCompressImageArray(Size.X, Size.Y, Pixels, Png);
                TestTrue(TEXT("capture saved"), FFileHelper::SaveArrayToFile(Png,
                    *(Dir / FString::Printf(TEXT("%s-%d.png"), *View, Width))));
            }
        }
        FSlateApplication::Get().RequestDestroyWindow(Window);
        FSlateApplication::Get().Tick();
    }
    return true;
}
#endif
