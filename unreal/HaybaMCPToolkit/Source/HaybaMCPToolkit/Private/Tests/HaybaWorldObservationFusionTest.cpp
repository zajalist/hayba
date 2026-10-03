#include "Misc/AutomationTest.h"
#include "HaybaMCPWorldObservationFusion.h"
#include "Engine/World.h"
#include "HAL/PlatformTime.h"
#include "HaybaMCPLatentTest.h"
#include "HaybaMCPSceneMapWebPanel.h"
#include "FileHelpers.h"
#include "Editor.h"
#include "LevelEditorViewport.h"
#include "Framework/Application/SlateApplication.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "RHI.h"
#include "Widgets/SWindow.h"
#include "GameFramework/Actor.h"
#include "Components/StaticMeshComponent.h"

#if WITH_DEV_AUTOMATION_TESTS
namespace
{
bool IsIdentifiedScratch()
{
    FString Named = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_SCRATCH_HOST_DIR"));
    if (Named.IsEmpty()) return false;
    Named = FPaths::ConvertRelativePathToFull(Named);
    FString Project = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
    FPaths::NormalizeDirectoryName(Named);
    FPaths::NormalizeDirectoryName(Project);
    return Named.Equals(Project, ESearchCase::IgnoreCase) &&
        FPaths::FileExists(Project / TEXT(".hayba-disposable-project"));
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldObservationFusionTest,
    "Hayba.MCP.World.ObservationFusionTwoViews",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaWorldObservationFusionTest::RunTest(const FString&)
{
    using namespace HaybaWorldObservationFusion;
    UWorld* FirstWorld = NewObject<UWorld>(GetTransientPackage());
    UWorld* SecondWorld = NewObject<UWorld>(GetTransientPackage());
    FStore Store(3);
    Store.BindWorld(FirstWorld, FVector::ZeroVector);
    const uint32 First = Store.BeginCapture(TEXT("view-a"), TEXT("2026-10-03T00:00:00Z"),
        FVector::ZeroVector, FRotator::ZeroRotator);
    TestTrue(TEXT("first capture registered"), First != 0);
    Store.Add(First, FVector(0, 0, 0), FVector::UpVector, FColor::Red,
        HaybaWorldDepth::EColorSource::RenderedMaterialBaseColor, 4, 9, 12);
    Store.Add(First, FVector(100, 0, 0), FVector::UpVector, FColor::Green,
        HaybaWorldDepth::EColorSource::RenderedMaterialBaseColor);
    const uint32 Second = Store.BeginCapture(TEXT("view-b"), TEXT("2026-10-03T00:01:00Z"),
        FVector(50, 0, 0), FRotator(0, 90, 0));
    Store.Add(Second, FVector(2, 0, 0), FVector::UpVector, FColor::Blue,
        HaybaWorldDepth::EColorSource::RenderedSceneColor);
    Store.Add(Second, FVector(200, 0, 0), FVector::UpVector, FColor::Blue,
        HaybaWorldDepth::EColorSource::RenderedMaterialBaseColor);
    TestEqual(TEXT("overlap deduplicated, non-overlap retained"), Store.Num(), 3);
    TestEqual(TEXT("one overlapping voxel"), Store.DuplicateCount(), int64(1));
    TestEqual(TEXT("higher quality first BaseColor retained"), Store.PointAt(0).Color, FColor::Red);
    TestEqual(TEXT("first view provenance retained on overlap"),
        Store.CaptureFor(Store.PointAt(0).CaptureOrdinal)->Id, FString(TEXT("view-a")));
    TestEqual(TEXT("exact ray-attributed actor retained on overlap"), Store.PointAt(0).VerifiedActorIndex, 4);
    TestEqual(TEXT("exact ray-attributed node retained on overlap"), Store.PointAt(0).VerifiedNodeIndex, 9);
    TestEqual(TEXT("attribution bound to original geometry generation"), Store.PointAt(0).AttributionGeneration, 12);
    TestEqual(TEXT("unverified second-view pixel stays unknown"), Store.PointAt(2).VerifiedActorIndex, INDEX_NONE);
    TestEqual(TEXT("second view contributes new surface"),
        Store.CaptureFor(Store.PointAt(2).CaptureOrdinal)->Id, FString(TEXT("view-b")));
    TestTrue(TEXT("resident bytes include points and voxel index"),
        Store.AllocatedBytes() > uint64(Store.PointSizeBytes() * Store.Num()));

    Store.Add(Second, FVector(300, 0, 0), FVector::UpVector, FColor::Blue,
        HaybaWorldDepth::EColorSource::RenderedMaterialBaseColor);
    TestEqual(TEXT("resident cap enforced"), Store.Num(), 3);
    TestEqual(TEXT("oldest slot deterministically evicted"), Store.PointAt(0).PositionCm,
        FVector(300, 0, 0));
    TestEqual(TEXT("one deterministic eviction"), Store.EvictionCount(), int64(1));
    Store.BindWorld(FirstWorld, FVector::ZeroVector);
    TestEqual(TEXT("same world and origin retain observations"), Store.Num(), 3);
    Store.BindWorld(FirstWorld, FVector(1000, 0, 0));
    TestEqual(TEXT("origin rebase invalidates observations"), Store.Num(), 0);
    Store.BindWorld(SecondWorld, FVector::ZeroVector);
    TestEqual(TEXT("new world starts empty"), Store.Num(), 0);

    // The panel's explicit refresh compares this fingerprint before deciding
    // whether an older view may remain fused with the new camera observation.
    UWorld* SceneWorld = UWorld::CreateWorld(EWorldType::Editor, false);
    AActor* SceneActor = SceneWorld->SpawnActor<AActor>();
    TestNotNull(TEXT("scene actor spawned for mutation fingerprint"), SceneActor);
    if (SceneActor)
    {
        UStaticMeshComponent* Mesh = NewObject<UStaticMeshComponent>(SceneActor);
        SceneActor->SetRootComponent(Mesh);
        SceneActor->AddInstanceComponent(Mesh);
        const uint32 Before = SceneFingerprint(SceneWorld);
        TestTrue(TEXT("test actor with root moves"), SceneActor->SetActorLocation(FVector(400, 0, 0)));
        TestEqual(TEXT("test actor reached changed location"), SceneActor->GetActorLocation(), FVector(400, 0, 0));
        TestNotEqual(TEXT("moving an actor invalidates older observations"), SceneFingerprint(SceneWorld), Before);
        const uint32 Moved = SceneFingerprint(SceneWorld);
        UStaticMeshComponent* AnotherMesh = NewObject<UStaticMeshComponent>(SceneActor);
        SceneActor->AddInstanceComponent(AnotherMesh);
        TestNotEqual(TEXT("adding renderable component invalidates older observations"),
            SceneFingerprint(SceneWorld), Moved);
    }
    SceneWorld->DestroyWorld(false);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldObservationFusionMemoryTest,
    "Hayba.MCP.World.ObservationFusionMemory",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaWorldObservationFusionMemoryTest::RunTest(const FString&)
{
    using namespace HaybaWorldObservationFusion;
    if (!IsIdentifiedScratch())
    { AddInfo(TEXT("Memory measurement is scratch-only.")); return true; }
    UWorld* World = NewObject<UWorld>(GetTransientPackage());
    FStore Store(MaxResidentPoints);
    Store.BindWorld(World, FVector::ZeroVector);
    const uint32 Capture = Store.BeginCapture(TEXT("memory-sample"), TEXT("2026-10-03T00:00:00Z"),
        FVector::ZeroVector, FRotator::ZeroRotator);
    const double Started = FPlatformTime::Seconds();
    for (int32 I = 0; I < MaxResidentPoints; ++I)
        Store.Add(Capture, FVector(static_cast<double>(I) * VoxelSizeCm, 0, 0),
            FVector::UpVector, FColor::White,
            HaybaWorldDepth::EColorSource::RenderedMaterialBaseColor);
    const double InsertMs = (FPlatformTime::Seconds() - Started) * 1000.0;
    const uint64 ResidentBytes = Store.AllocatedBytes();
    AddInfo(FString::Printf(TEXT("2M resident: FPoint=%d B, allocated=%llu B (%.1f MiB), insert=%.1f ms"),
        Store.PointSizeBytes(), static_cast<unsigned long long>(ResidentBytes),
        static_cast<double>(ResidentBytes) / (1024.0 * 1024.0), InsertMs));
    TestEqual(TEXT("full resident cap"), Store.Num(), MaxResidentPoints);
    TestTrue(TEXT("native 2M allocation stays below 1 GiB"),
        ResidentBytes < 1024ull * 1024ull * 1024ull);
    Store.Add(Capture, FVector(static_cast<double>(MaxResidentPoints) * VoxelSizeCm, 0, 0),
        FVector::UpVector, FColor::White,
        HaybaWorldDepth::EColorSource::RenderedMaterialBaseColor);
    TestEqual(TEXT("cap remains after eviction"), Store.Num(), MaxResidentPoints);
    TestEqual(TEXT("eviction recorded"), Store.EvictionCount(), int64(1));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldObservationFusionScratchTest,
    "Hayba.MCP.World.ObservationFusionScratchTwoViews",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaWorldObservationFusionScratchTest::RunTest(const FString&)
{
    if (!IsIdentifiedScratch() ||
        !FParse::Param(FCommandLine::Get(), TEXT("HaybaWorldFusionReview")) || GUsingNullRHI)
    { AddInfo(TEXT("Two-view renderer evidence requires opt-in scratch editor with RHI.")); return true; }
    FString MapPath;
    if (!FParse::Value(FCommandLine::Get(), TEXT("HaybaWorldVisualMap="), MapPath) ||
        !FPaths::FileExists(MapPath) || !FEditorFileUtils::LoadMap(MapPath, false, false))
    { AddError(TEXT("Pass a loadable scratch map with -HaybaWorldVisualMap=.")); return false; }
    struct FContext
    {
        TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel;
        TSharedPtr<SWindow> Window;
        int32 FirstPoints = 0;
        double FirstProcessingTickMs = 0.0;
        double FirstInsertionTickMs = 0.0;
        double FirstReplayTickMs = 0.0;
        double FirstReplayBuildMs = 0.0;
        double FirstReplayEncodeMs = 0.0;
        double FirstReplayInjectionMs = 0.0;
        double FirstStartedAt = 0.0;
        double SecondStartedAt = 0.0;
        double FirstWallMs = 0.0;
    };
    TSharedRef<FContext> Context = MakeShared<FContext>();
    Context->FirstStartedAt = FPlatformTime::Seconds();
    Context->Panel = SNew(SHaybaMCPSceneMapWebPanel);
    Context->Window = SNew(SWindow).ClientSize(FVector2D(1000, 720))
        .Title(FText::FromString(TEXT("Hayba World fusion review")))
        .SupportsMaximize(false).SupportsMinimize(false)[Context->Panel.ToSharedRef()];
    FSlateApplication::Get().AddWindow(Context->Window.ToSharedRef());
    ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this,
        TEXT("first rendered World view"), [Context]()
        {
            return Context->Panel.IsValid() && Context->Panel->IsScanDone() &&
                Context->Panel->GetFusedCaptureCount() == 1 &&
                Context->Panel->GetFusedObservedPointCount() > 0;
        }, 90.0));
    ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Context]()
    {
        Context->FirstPoints = Context->Panel->GetFusedObservedPointCount();
        Context->FirstProcessingTickMs = Context->Panel->GetDepthMaxTickCpuMs();
        Context->FirstInsertionTickMs = Context->Panel->GetFusionInsertionMaxTickMs();
        Context->FirstReplayTickMs = Context->Panel->GetFusionReplayMaxTickMs();
        Context->FirstReplayBuildMs = Context->Panel->GetFusionReplayBuildMaxTickMs();
        Context->FirstReplayEncodeMs = Context->Panel->GetFusionReplayEncodeMaxTickMs();
        Context->FirstReplayInjectionMs = Context->Panel->GetFusionReplayInjectionMaxTickMs();
        Context->FirstWallMs = (FPlatformTime::Seconds() - Context->FirstStartedAt) * 1000.0;
        UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
        FLevelEditorViewportClient* View = GCurrentLevelEditingViewportClient;
        if (!View || View->GetWorld() != World || !View->IsPerspective())
        {
            View = nullptr;
            if (GEditor) for (FLevelEditorViewportClient* Candidate : GEditor->GetLevelViewportClients())
                if (Candidate && Candidate->GetWorld() == World && Candidate->IsPerspective())
                { View = Candidate; break; }
        }
        if (!TestNotNull(TEXT("scratch perspective viewport"), View)) return true;
        View->SetViewLocation(View->GetViewLocation() + FVector(100, 0, 0));
        View->SetViewRotation(View->GetViewRotation() + FRotator(0, 10, 0));
        Context->SecondStartedAt = FPlatformTime::Seconds();
        Context->Panel->Refresh();
        return true;
    }));
    ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this,
        TEXT("second moved-camera World view"), [Context]()
        {
            return Context->Panel.IsValid() && Context->Panel->IsScanDone() &&
                Context->Panel->GetFusedCaptureCount() >= 2;
        }, 90.0));
    ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Context]()
    {
        if (Context->Panel.IsValid())
        {
            AddInfo(FString::Printf(TEXT("Two-view World: first=%d resident, second=%d resident, captures=%d, overlap=%lld voxels; tick processing %.2f/%.2f ms, fusion insert %.2f/%.2f ms, replay %.2f/%.2f ms; native allocated=%.1f MiB"),
                Context->FirstPoints, Context->Panel->GetFusedObservedPointCount(),
                Context->Panel->GetFusedCaptureCount(),
                static_cast<long long>(Context->Panel->GetFusedDeduplicatedCount()),
                Context->FirstProcessingTickMs, Context->Panel->GetDepthMaxTickCpuMs(),
                Context->FirstInsertionTickMs, Context->Panel->GetFusionInsertionMaxTickMs(),
                Context->FirstReplayTickMs, Context->Panel->GetFusionReplayMaxTickMs(),
                static_cast<double>(Context->Panel->GetFusedAllocatedBytes()) / (1024.0 * 1024.0)));
            AddInfo(FString::Printf(TEXT("Replay phase max first/second: build %.2f/%.2f ms, JSON encode %.2f/%.2f ms, CEF injection %.2f/%.2f ms"),
                Context->FirstReplayBuildMs, Context->Panel->GetFusionReplayBuildMaxTickMs(),
                Context->FirstReplayEncodeMs, Context->Panel->GetFusionReplayEncodeMaxTickMs(),
                Context->FirstReplayInjectionMs, Context->Panel->GetFusionReplayInjectionMaxTickMs()));
            AddInfo(FString::Printf(TEXT("Two-view scan wall time first/second: %.1f/%.1f ms"),
                Context->FirstWallMs, (FPlatformTime::Seconds() - Context->SecondStartedAt) * 1000.0));
            TestTrue(TEXT("moved view retains first observation and adds non-overlap"),
                Context->Panel->GetFusedObservedPointCount() > Context->FirstPoints);
            TestTrue(TEXT("moved view overlaps first view"),
                Context->Panel->GetFusedDeduplicatedCount() > 0);
        }
        if (Context->Window.IsValid())
            FSlateApplication::Get().RequestDestroyWindow(Context->Window.ToSharedRef());
        return true;
    }));
    return true;
}
#endif
