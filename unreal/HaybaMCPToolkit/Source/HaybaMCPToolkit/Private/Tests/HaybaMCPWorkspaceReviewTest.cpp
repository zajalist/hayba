#include "Misc/AutomationTest.h"
#include "HaybaMCPPlanOverlay.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPCommandHandler.h"
#include "GameFramework/Actor.h"
#include "Components/SceneComponent.h"
#include "HaybaMCPMainPanel.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "RHI.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaExactActorFingerprintTest, "Hayba.MCP.Workspace.ExactActorFingerprint",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaExactActorFingerprintTest::RunTest(const FString&)
{
    AActor* Actor = NewObject<AActor>(GetTransientPackage(), NAME_None, RF_Transient);
    USceneComponent* Root = NewObject<USceneComponent>(Actor, NAME_None, RF_Transient);
    Actor->SetRootComponent(Root);
    FString Before;
    FString Repeated;
    FString AfterTransform;
    FString AfterTag;
    FString AfterVisibility;
    FString AfterProperty;
    TestTrue(TEXT("transient actor can be fingerprinted"),
        FHaybaMCPCommandHandler::FingerprintActorForApproval(Actor, Before));
    TestTrue(TEXT("unchanged actor can be fingerprinted again"),
        FHaybaMCPCommandHandler::FingerprintActorForApproval(Actor, Repeated));
    TestEqual(TEXT("unchanged actor keeps its version"), Repeated, Before);
    Root->SetRelativeLocation(FVector(10, 20, 30));
    TestTrue(TEXT("transformed actor can be fingerprinted"),
        FHaybaMCPCommandHandler::FingerprintActorForApproval(Actor, AfterTransform));
    TestTrue(TEXT("transform invalidates target version"), AfterTransform != Before);
    Actor->Tags.Add(TEXT("approval-test-edited"));
    TestTrue(TEXT("retagged actor can be fingerprinted"),
        FHaybaMCPCommandHandler::FingerprintActorForApproval(Actor, AfterTag));
    TestTrue(TEXT("tag edit invalidates target version"), AfterTag != AfterTransform);
    Actor->SetIsTemporarilyHiddenInEditor(true);
    TestTrue(TEXT("hidden actor can be fingerprinted"),
        FHaybaMCPCommandHandler::FingerprintActorForApproval(Actor, AfterVisibility));
    TestTrue(TEXT("visibility edit invalidates target version"), AfterVisibility != AfterTag);
    Actor->InitialLifeSpan += 12.f;
    TestTrue(TEXT("property-edited actor can be fingerprinted"),
        FHaybaMCPCommandHandler::FingerprintActorForApproval(Actor, AfterProperty));
    TestTrue(TEXT("property edit invalidates target version"), AfterProperty != AfterVisibility);
    return true;
}

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
    const FString ProseId = Module.PendingExternalPlanId;
    TestFalse(TEXT("prose plan cannot authorize a native command"), Module.ResolveExternalPlan(ProseId, true));
    TestTrue(TEXT("prose rejection resolves proposal"), Module.ResolveExternalPlan(ProseId, false));
    TestFalse(TEXT("prose rejection grants no approval"), Module.bPlanApproved);

    FString UnsupportedRef;
    FString UnsupportedVersion;
    TestFalse(TEXT("batch has no exact target adapter and must refuse under Plan Mode"),
        FHaybaMCPCommandHandler::CaptureExactApprovalTarget(TEXT("editor_batch"),
            MakeShared<FJsonObject>(), UnsupportedRef, UnsupportedVersion));
    TSharedPtr<FJsonObject> ConflictingActorIds = MakeShared<FJsonObject>();
    ConflictingActorIds->SetStringField(TEXT("actor_id"), TEXT("ExecutedActor"));
    ConflictingActorIds->SetStringField(TEXT("actorId"), TEXT("DifferentReviewedActor"));
    TestFalse(TEXT("router snapshot refuses a second actor identifier"),
        FHaybaMCPCommandHandler::CaptureExactApprovalTarget(TEXT("actor_delete"),
            ConflictingActorIds, UnsupportedRef, UnsupportedVersion));

    FHaybaExactExternalApproval First;
    First.Command = TEXT("actor_transform");
    First.Owner = TEXT("agent-a");
    First.OperationDigest = TEXT("digest-a");
    First.ReviewParamsJson = TEXT("{\"actor_id\":\"TestActor\"}");
    First.TargetRef = TEXT("/Temp/TestWorld.TestActor#guid");
    First.TargetFingerprint = TEXT("version-a");
    First.LeaseBinding = TEXT("lease-a");
    First.Source = TEXT("external (connection 1)");
    First.SourceBinding = TEXT("source-a");
    First.PolicyVersion = TEXT("native-exact-v1");
    First.ExpiresAt = FDateTime::UtcNow() + FTimespan::FromMinutes(5);
    Module.ProposeExactExternalOperation(First);
    const FString FirstId = Module.PendingExternalPlanId;
    TestTrue(TEXT("exact proposal visible"), Module.PendingExternalPlanIsExact);
    TestFalse(TEXT("new exact proposal does not grant approval"), Module.bPlanApproved);
    TestFalse(TEXT("changed target refuses approval"), Module.PendingExternalOperation.Matches(
        First.Owner, First.Command, First.OperationDigest, TEXT("version-b"), First.LeaseBinding, First.SourceBinding,
        First.PolicyVersion, FDateTime::UtcNow()));
    TestFalse(TEXT("changed operation refuses approval"), Module.PendingExternalOperation.Matches(
        First.Owner, First.Command, TEXT("digest-b"), First.TargetFingerprint, First.LeaseBinding, First.SourceBinding,
        First.PolicyVersion, FDateTime::UtcNow()));
    TestFalse(TEXT("changed lease refuses approval"), Module.PendingExternalOperation.Matches(
        First.Owner, First.Command, First.OperationDigest, First.TargetFingerprint, TEXT("lease-b"), First.SourceBinding,
        First.PolicyVersion, FDateTime::UtcNow()));
    TestFalse(TEXT("changed source refuses approval"), Module.PendingExternalOperation.Matches(
        First.Owner, First.Command, First.OperationDigest, First.TargetFingerprint, First.LeaseBinding,
        TEXT("source-b"), First.PolicyVersion, FDateTime::UtcNow()));

    FHaybaExactExternalApproval Second = First;
    Second.OperationDigest = TEXT("digest-b");
    Module.ProposeExactExternalOperation(Second);
    TestFalse(TEXT("revised proposal invalidates old token"), Module.ResolveExternalPlan(FirstId, true));
    const FString SecondId = Module.PendingExternalPlanId;
    TestTrue(TEXT("exact rejection resolves proposal"), Module.ResolveExternalPlan(SecondId, false));
    TestFalse(TEXT("double rejection refused"), Module.ResolveExternalPlan(SecondId, false));

    // The module's one-use gate also refuses a second dispatch, even for the
    // same immutable call. Approval resolution itself is tested by the live
    // editor test because it must re-read the actual target object.
    First.ProposalId = TEXT("approved-token");
    Module.ApprovedExternalOperation = First;
    TestTrue(TEXT("first exact dispatch consumes approval"), Module.ConsumeExactExternalApproval(
        First.Owner, First.Command, First.OperationDigest, First.TargetFingerprint,
        First.LeaseBinding, First.SourceBinding, First.PolicyVersion));
    TestFalse(TEXT("second dispatch cannot replay approval"), Module.ConsumeExactExternalApproval(
        First.Owner, First.Command, First.OperationDigest, First.TargetFingerprint,
        First.LeaseBinding, First.SourceBinding, First.PolicyVersion));
    Module.ProposeExactExternalOperation(First);
    Module.InvalidateExternalApproval();
    TestFalse(TEXT("unsupported next operation invalidates pending review"), Module.PendingExternalPlanIsExact);
    TestFalse(TEXT("unsupported next operation invalidates unused approval"), Module.ApprovedExternalOperation.IsValid());
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
