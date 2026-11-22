#include "Misc/AutomationTest.h"
#include "HaybaMCPWorldObservationFusion.h"
#include "Engine/World.h"
#include "HAL/PlatformTime.h"
#include "Misc/Paths.h"
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

    // Compare this fingerprint before deciding
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

#endif
