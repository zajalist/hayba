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
    Module.ProposeExternalPlan(TEXT("Spawn one blockout cube"));
    TestFalse(TEXT("proposal does not grant approval"), Module.bPlanApproved);
    TestTrue(TEXT("explicit approval succeeds"), Module.ResolveExternalPlan(true));
    TestTrue(TEXT("native gate receives approval"), Module.bPlanApproved);
    TestTrue(TEXT("resolved proposal cleared"), Module.PendingExternalPlan.IsEmpty());
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
        for (const FString View : { FString(TEXT("Agent")), FString(TEXT("Proposal")), FString(TEXT("World")), FString(TEXT("Settings")) })
        {
            if (View == TEXT("Proposal")) Module.ProposeExternalPlan(TEXT("1. Place three blockout volumes in the selected room.\n2. Check player clearances before saving."));
            if (View == TEXT("World")) Panel->ShowPanel(EHaybaPanel::World);
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
