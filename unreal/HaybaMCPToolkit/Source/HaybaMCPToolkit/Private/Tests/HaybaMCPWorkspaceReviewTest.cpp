#include "Misc/AutomationTest.h"
#include "HaybaMCPPlanOverlay.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPCommandHandler.h"
#include "GameFramework/Actor.h"
#include "Components/SceneComponent.h"
#include "HaybaMCPMainPanel.h"
#include "HaybaMCPToolStreamPanel.h"
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPSettings.h"
#include "Tests/HaybaMCPLeaseTestUtil.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "HAL/FileManager.h"
#include "RHI.h"
#include "Editor.h"
#include "Engine/World.h"

namespace HaybaMCPExactApproval
{
    FString HashOperation(const TSharedPtr<FJsonObject>& Operation);
    FString HashBinding(const FString& Domain, const FString& First, const FString& Second);
}

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaExactApprovalDigestTest, "Hayba.MCP.Workspace.ExactApprovalDigest",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaExactApprovalDigestTest::RunTest(const FString&)
{
    TSharedPtr<FJsonObject> NestedA = MakeShared<FJsonObject>();
    NestedA->SetNumberField(TEXT("z"), 40);
    NestedA->SetStringField(TEXT("a"), TEXT("marker"));
    TSharedPtr<FJsonObject> ParamsA = MakeShared<FJsonObject>();
    ParamsA->SetObjectField(TEXT("location"), NestedA);
    ParamsA->SetStringField(TEXT("actor_id"), TEXT("ScratchActor"));
    TSharedPtr<FJsonObject> OperationA = MakeShared<FJsonObject>();
    OperationA->SetObjectField(TEXT("params"), ParamsA);
    OperationA->SetStringField(TEXT("cmd"), TEXT("actor_transform"));

    TSharedPtr<FJsonObject> NestedB = MakeShared<FJsonObject>();
    NestedB->SetStringField(TEXT("a"), TEXT("marker"));
    NestedB->SetNumberField(TEXT("z"), 40);
    TSharedPtr<FJsonObject> ParamsB = MakeShared<FJsonObject>();
    ParamsB->SetStringField(TEXT("actor_id"), TEXT("ScratchActor"));
    ParamsB->SetObjectField(TEXT("location"), NestedB);
    TSharedPtr<FJsonObject> OperationB = MakeShared<FJsonObject>();
    OperationB->SetStringField(TEXT("cmd"), TEXT("actor_transform"));
    OperationB->SetObjectField(TEXT("params"), ParamsB);

    const FString Digest = HaybaMCPExactApproval::HashOperation(OperationA);
    TestEqual(TEXT("operation digest is a full BLAKE3 hex hash"), Digest.Len(), 64);
    TestEqual(TEXT("nested JSON key insertion order is immaterial"),
        HaybaMCPExactApproval::HashOperation(OperationB), Digest);
    NestedB->SetNumberField(TEXT("z"), 41);
    TestTrue(TEXT("changed operation input changes digest"),
        HaybaMCPExactApproval::HashOperation(OperationB) != Digest);
    NestedB->SetNumberField(TEXT("z"), 40);
    OperationB->SetStringField(TEXT("cmd"), TEXT("actor_delete"));
    TestTrue(TEXT("changed command changes digest"),
        HaybaMCPExactApproval::HashOperation(OperationB) != Digest);
    TestTrue(TEXT("missing operation has no digest"),
        HaybaMCPExactApproval::HashOperation(TSharedPtr<FJsonObject>()).IsEmpty());

    const FString Lease = HaybaMCPExactApproval::HashBinding(TEXT("native-exact-lease-v2"),
        TEXT("ticket:alpha"), TEXT("bound"));
    TestEqual(TEXT("lease binding is a full BLAKE3 hex hash"), Lease.Len(), 64);
    TestEqual(TEXT("lease binding is deterministic"),
        HaybaMCPExactApproval::HashBinding(TEXT("native-exact-lease-v2"), TEXT("ticket:alpha"), TEXT("bound")), Lease);
    TestTrue(TEXT("framed fields cannot be confused by delimiters"),
        HaybaMCPExactApproval::HashBinding(TEXT("native-exact-lease-v2"), TEXT("ticket"), TEXT("alpha:bound")) != Lease);
    TestTrue(TEXT("binding domains are isolated"),
        HaybaMCPExactApproval::HashBinding(TEXT("native-exact-source-v2"), TEXT("ticket:alpha"), TEXT("bound")) != Lease);
    const FString UnicodeSource = TEXT("source \u00E9");
    TestTrue(TEXT("UTF-8 source changes remain bound"),
        HaybaMCPExactApproval::HashBinding(TEXT("native-exact-source-v2"), UnicodeSource, FString()) !=
        HaybaMCPExactApproval::HashBinding(TEXT("native-exact-source-v2"), TEXT("source e"), FString()));
    return true;
}

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
    First.PolicyVersion = TEXT("native-exact-v2");
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

// The router test mutates only an explicitly identified scratch project. It
// creates a disposable actor and never saves its level.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaExactApprovalRouterScratchTest,
    "Hayba.MCP.Workspace.ExactApprovalRouterScratch",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaExactApprovalRouterScratchTest::RunTest(const FString&)
{
    FString ScratchDir = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_SCRATCH_HOST_DIR"));
    FString ProjectDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
    if (ScratchDir.IsEmpty())
    {
        AddInfo(TEXT("Exact approval router test skipped: scratch host is not identified."));
        return true;
    }
    ScratchDir = FPaths::ConvertRelativePathToFull(ScratchDir);
    FPaths::NormalizeDirectoryName(ScratchDir);
    FPaths::NormalizeDirectoryName(ProjectDir);
    if (!ScratchDir.Equals(ProjectDir, ESearchCase::IgnoreCase))
    {
        AddInfo(TEXT("Exact approval router test skipped outside the identified scratch project."));
        return true;
    }

    using namespace HaybaMCPLeaseTest;
    FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
    const TSharedPtr<FHaybaMCPCommandHandler> Router = Module ? Module->GetCommandHandler() : nullptr;
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!TestTrue(TEXT("scratch router and editor world available"), Router.IsValid() && World)) return false;
    FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
    if (!Settings.CapabilityToken.IsEmpty())
    {
        AddInfo(TEXT("Exact approval router test skipped while native auth is configured."));
        return true;
    }
    const bool bPlanWas = Settings.bPlanModeEnabled;
    const FString Owner = UniqueOwner(TEXT("exact"));
    constexpr int32 Conn = 900971;
    double Advanced = 0.0;
    AActor* Actor = World->SpawnActor<AActor>(FVector::ZeroVector, FRotator::ZeroRotator);
    if (!TestNotNull(TEXT("scratch actor spawned"), Actor)) return false;
    ON_SCOPE_EXIT
    {
        FHaybaMCPLeaseManager::Get().AdvanceClockForTests(-Advanced);
        FHaybaMCPLeaseManager::Get().ForgetOwnerForTests(Owner);
        Router->NotifyConnectionClosed(Conn);
        Module->InvalidateExternalApproval();
        Settings.bPlanModeEnabled = bPlanWas;
        Settings.Save();
        if (IsValid(Actor)) World->DestroyActor(Actor);
    };
    Settings.bPlanModeEnabled = true;
    const FString ActorId = Actor->GetName();
    auto SendRequired = [&Router, Conn, &Owner](const FString& Cmd, const TSharedPtr<FJsonObject>& Params,
        bool bRequired = true)
    {
        TSharedPtr<FJsonObject> EnvelopeObject = Json(Envelope(Owner, Cmd, Params));
        EnvelopeObject->SetBoolField(TEXT("require_exact_review"), bRequired);
        FString Request;
        FJsonSerializer::Serialize(EnvelopeObject.ToSharedRef(), TJsonWriterFactory<>::Create(&Request));
        return Json(Router->ProcessCommand(Request, Conn));
    };
    auto TagParams = [&ActorId](const TCHAR* Tag)
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("actor_id"), ActorId);
        Params->SetArrayField(TEXT("add"), { MakeShared<FJsonValueString>(Tag) });
        return Params;
    };
    const TSharedPtr<FJsonObject> First = TagParams(TEXT("approved-once"));
    FString Status;
    DataOf(Send(*Router, Conn, Owner, TEXT("actor_tag"), First))->TryGetStringField(TEXT("status"), Status);
    TestEqual(TEXT("router requires exact review"), Status, FString(TEXT("plan_mode_required")));
    const FString FirstId = Module->PendingExternalPlanId;
    TestTrue(TEXT("native card is exact"), Module->PendingExternalPlanIsExact);
    TestEqual(TEXT("router uses BLAKE3 operation digest"), Module->PendingExternalOperation.OperationDigest.Len(), 64);
    TestEqual(TEXT("router uses BLAKE3 source binding"), Module->PendingExternalOperation.SourceBinding.Len(), 64);
    TestEqual(TEXT("router uses BLAKE3 lease binding"), Module->PendingExternalOperation.LeaseBinding.Len(), 64);
    TestTrue(TEXT("first click approves frozen target"), Module->ResolveExternalPlan(FirstId, true));
    TestFalse(TEXT("double approval click refused"), Module->ResolveExternalPlan(FirstId, true));
    TestEqual(TEXT("approved command executes"), CodeOf(Send(*Router, Conn, Owner, TEXT("actor_tag"), First)), FString());
    TestTrue(TEXT("approved command changed actor"), Actor->Tags.Contains(TEXT("approved-once")));
    Status.Empty();
    DataOf(Send(*Router, Conn, Owner, TEXT("actor_tag"), First))->TryGetStringField(TEXT("status"), Status);
    TestEqual(TEXT("consumed command cannot replay"), Status, FString(TEXT("plan_mode_required")));
    const FString StaleId = Module->PendingExternalPlanId;
    Actor->Tags.Add(TEXT("outside-edit"));
    TestFalse(TEXT("edited target refuses pending approval"), Module->ResolveExternalPlan(StaleId, true));
    TestFalse(TEXT("stale token cannot be clicked twice"), Module->ResolveExternalPlan(StaleId, true));

    TSharedPtr<FJsonObject> Conflicting = TagParams(TEXT("must-not-run"));
    Conflicting->SetStringField(TEXT("actorId"), TEXT("DifferentActor"));
    TestEqual(TEXT("conflicting actor alias refuses at router"),
        CodeOf(Send(*Router, Conn, Owner, TEXT("actor_tag"), Conflicting)),
        FString(TEXT("exact_approval_unavailable")));
    TestFalse(TEXT("conflicting alias did not mutate actor"), Actor->Tags.Contains(TEXT("must-not-run")));

    const FString LeaseId = AcquireId(*Router, Conn, Owner,
        TEXT("{\"resources\":[\"global\"],\"ttl_s\":60,\"bind_connection\":false}"));
    if (TestFalse(TEXT("scratch lease acquired"), LeaseId.IsEmpty()))
    {
        const TSharedPtr<FJsonObject> Leased = TagParams(TEXT("expired-lease-must-not-run"));
        Status.Empty();
        DataOf(Send(*Router, Conn, Owner, TEXT("actor_tag"), Leased, LeaseId))->TryGetStringField(TEXT("status"), Status);
        TestEqual(TEXT("leased operation reaches exact review"), Status, FString(TEXT("plan_mode_required")));
        const FString LeaseProposal = Module->PendingExternalPlanId;
        FHaybaMCPLeaseManager::Get().AdvanceClockForTests(61.0);
        Advanced += 61.0;
        TestFalse(TEXT("expired lease invalidates approval at click"), Module->ResolveExternalPlan(LeaseProposal, true));
        TestFalse(TEXT("expired lease operation did not run"), Actor->Tags.Contains(TEXT("expired-lease-must-not-run")));
    }
    Status.Empty();
    DataOf(Send(*Router, Conn, Owner, TEXT("actor_tag"), TagParams(TEXT("disconnect-must-not-run"))))->TryGetStringField(TEXT("status"), Status);
    TestEqual(TEXT("disconnect case reaches exact review"), Status, FString(TEXT("plan_mode_required")));
    Router->NotifyConnectionClosed(Conn);
    TestFalse(TEXT("connection close invalidates pending approval"), Module->PendingExternalPlanIsExact);
    TestFalse(TEXT("disconnected operation did not run"), Actor->Tags.Contains(TEXT("disconnect-must-not-run")));

    // Production Chat requires this gate even when the project preference is
    // off. The policy version binds the click to the restrictive envelope.
    Settings.bPlanModeEnabled = false;
    const TSharedPtr<FJsonObject> Required = TagParams(TEXT("request-required"));
    Status.Empty();
    DataOf(SendRequired(TEXT("actor_tag"), Required))->TryGetStringField(TEXT("status"), Status);
    TestEqual(TEXT("request policy gates while global Plan Mode is off"), Status,
        FString(TEXT("plan_mode_required")));
    TestEqual(TEXT("proposal binds request policy"), Module->PendingExternalOperation.PolicyVersion,
        FString(TEXT("native-exact-v2-request-required")));
    const FString RequiredId = Module->PendingExternalPlanId;
    TestTrue(TEXT("request-required proposal approves while global mode is off"),
        Module->ResolveExternalPlan(RequiredId, true));
    Settings.bPlanModeEnabled = true;
    Status.Empty();
    DataOf(SendRequired(TEXT("actor_tag"), Required, false))->TryGetStringField(TEXT("status"), Status);
    TestEqual(TEXT("ordinary envelope cannot consume request-required token"), Status,
        FString(TEXT("plan_mode_required")));
    TestFalse(TEXT("policy downgrade did not mutate actor"), Actor->Tags.Contains(TEXT("request-required")));
    Settings.bPlanModeEnabled = false;
    Status.Empty();
    DataOf(SendRequired(TEXT("actor_tag"), Required))->TryGetStringField(TEXT("status"), Status);
    TestEqual(TEXT("request policy needs a fresh token after downgrade attempt"), Status,
        FString(TEXT("plan_mode_required")));
    const FString FreshRequiredId = Module->PendingExternalPlanId;
    TestTrue(TEXT("fresh request-required proposal approves"),
        Module->ResolveExternalPlan(FreshRequiredId, true));
    TestEqual(TEXT("request-required approved call executes once"),
        CodeOf(SendRequired(TEXT("actor_tag"), Required)), FString());
    TestTrue(TEXT("request-required mutation landed"), Actor->Tags.Contains(TEXT("request-required")));
    Status.Empty();
    DataOf(SendRequired(TEXT("actor_tag"), Required))->TryGetStringField(TEXT("status"), Status);
    TestEqual(TEXT("request-required approval cannot replay"), Status,
        FString(TEXT("plan_mode_required")));

    for (const FString& Unsupported : { TEXT("python_run"), TEXT("editor_batch"),
        TEXT("blueprint_create"), TEXT("asset_import") })
    {
        TestEqual(*FString::Printf(TEXT("%s fails closed without an exact target"), *Unsupported),
            CodeOf(SendRequired(Unsupported, MakeShared<FJsonObject>())),
            FString(TEXT("exact_approval_unavailable")));
    }

    // A false envelope flag cannot cancel the global preference.
    Settings.bPlanModeEnabled = true;
    Status.Empty();
    DataOf(SendRequired(TEXT("actor_tag"), TagParams(TEXT("false-cannot-bypass")), false))
        ->TryGetStringField(TEXT("status"), Status);
    TestEqual(TEXT("false flag cannot bypass global Plan Mode"), Status,
        FString(TEXT("plan_mode_required")));
    TestFalse(TEXT("false-flag operation did not run"), Actor->Tags.Contains(TEXT("false-cannot-bypass")));
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
                FHaybaExactExternalApproval Proposal;
                Proposal.Command = TEXT("actor_transform");
                Proposal.Owner = TEXT("external-test-client");
                Proposal.Source = TEXT("External MCP client (connection 7)");
                Proposal.SourceBinding = TEXT("visual-fixture-source");
                Proposal.OperationDigest = TEXT("f22e5863a18f746e3d588d811560a45ff22e5863a18f746e3d588d811560a45f");
                Proposal.ReviewParamsJson = TEXT("{\"actor_id\":\"BlockoutMarker\",\"location\":[120,0,40]}");
                Proposal.TargetRef = TEXT("/Scratch/Map.BlockoutMarker#sample");
                Proposal.TargetFingerprint = TEXT("visual-fixture-version");
                Proposal.LeaseBinding = TEXT("visual-fixture-lease");
                Proposal.PolicyVersion = TEXT("native-exact-v2");
                Proposal.Consequence = TEXT("Moves the blockout marker in the loaded editor world. Save is separate.");
                Proposal.ExpiresAt = FDateTime::UtcNow() + FTimespan::FromMinutes(5);
                Module.ProposeExactExternalOperation(MoveTemp(Proposal));
            }
            if (View == TEXT("World")) Panel->ShowPanel(EHaybaPanel::World);
            if (View == TEXT("Activity"))
            {
                Panel->ShowPanel(EHaybaPanel::Activity);
                if (TSharedPtr<SHaybaMCPToolStreamPanel> Activity = Module.ToolStreamPanel.Pin())
                {
                    Activity->AddToolCall(TEXT("actor_transform"),
                        TEXT("{\"actor_id\":\"/Scratch/BlockoutMarker\",\"location\":[120,0,40]}"),
                        TEXT("{\"ok\":true,\"after\":{\"location\":[120,0,40]}}"));
                    Activity->AddToolCall(TEXT("asset_import"),
                        TEXT("{\"asset_path\":\"/Scratch/Props/MarketStall\"}"),
                        TEXT("{\"ok\":false,\"error\":{\"code\":\"read_only\"}}"));
                }
            }
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
