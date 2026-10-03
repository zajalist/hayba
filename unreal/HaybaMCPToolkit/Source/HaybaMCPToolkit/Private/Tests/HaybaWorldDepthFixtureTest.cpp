#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HaybaMCPWorldDepth.h"
#include "HaybaMCPWorldDepthReadback.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Components/StaticMeshComponent.h"
#include "DynamicRHI.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/ScopeExit.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "RHIGlobals.h"
#include "RenderUtils.h"
#include "RenderingThread.h"
#include "SceneInterface.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

// This renderer fixture is intentionally opt-in. It owns a disposable world and
// uses only an Engine mesh, so it never changes the open editor map or game assets.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldDepthFixtureTest,
    "Hayba.MCP.World.DepthRendererFixture",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorldDepthFixtureTest::RunTest(const FString&)
{
    if (!FParse::Param(FCommandLine::Get(), TEXT("HaybaWorldDepthFixture")))
    {
        AddInfo(TEXT("Pass -HaybaWorldDepthFixture in a scratch editor to run the renderer fixture."));
        return true;
    }
    if (GUsingNullRHI || !GDynamicRHI)
    {
        AddInfo(TEXT("Scene-depth fixture skipped: a real initialized RHI is required."));
        return true;
    }
    if (!TestNotNull(TEXT("engine is available"), GEngine)) return false;

    TStrongObjectPtr<UWorld> World(NewObject<UWorld>(GetTransientPackage(), NAME_None, RF_Transient));
    if (!TestNotNull(TEXT("transient fixture world"), World.Get())) return false;
    World->WorldType = EWorldType::Game;
    FWorldContext& WorldContext = GEngine->CreateNewWorldContext(EWorldType::Game);
    WorldContext.SetCurrentWorld(World.Get());
    USceneCaptureComponent2D* Capture = nullptr;
    USceneCaptureComponent2D* BaseCapture = nullptr;
    ON_SCOPE_EXIT
    {
        if (BaseCapture && BaseCapture->IsRegistered()) BaseCapture->UnregisterComponent();
        if (Capture && Capture->IsRegistered()) Capture->UnregisterComponent();
        FlushRenderingCommands();
        GEngine->DestroyWorldContext(World.Get());
        World->DestroyWorld(false);
    };

    World->InitializeNewWorld(UWorld::InitializationValues()
        .AllowAudioPlayback(false)
        .RequiresHitProxies(false)
        .CreatePhysicsScene(false)
        .CreateNavigation(false)
        .CreateAISystem(false)
        .ShouldSimulatePhysics(false)
        .CreateFXSystem(false)
        .SetTransactional(false));
    if (!TestTrue(TEXT("fixture world has a render scene"), World->IsInitialized() && World->Scene))
        return false;

    UStaticMesh* CubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    if (!TestNotNull(TEXT("built-in Engine cube mesh"), CubeMesh)) return false;
    const FBox Bounds = CubeMesh->GetBoundingBox();
    if (!TestTrue(TEXT("cube mesh has nonzero dimensions"),
        Bounds.GetSize().X > 0.0 && Bounds.GetSize().Y > 0.0 && Bounds.GetSize().Z > 0.0))
        return false;

    constexpr double ExpectedDepthCm = 1000.0;
    constexpr double SideScale = 4.0;
    // The near X face is exactly 1,000 cm from the origin. Scaling Y and Z
    // makes the two center pixels safely interior to the face at a 90 degree FOV.
    const FVector CubeLocation(ExpectedDepthCm - Bounds.Min.X,
        -Bounds.GetCenter().Y * SideScale, -Bounds.GetCenter().Z * SideScale);
    FActorSpawnParameters Spawn;
    Spawn.ObjectFlags = RF_Transient;
    Spawn.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
    AStaticMeshActor* CubeActor = World->SpawnActor<AStaticMeshActor>(
        CubeLocation, FRotator::ZeroRotator, Spawn);
    if (!TestNotNull(TEXT("fixture cube actor"), CubeActor)) return false;
    UStaticMeshComponent* CubeComponent = CubeActor->GetStaticMeshComponent();
    if (!TestNotNull(TEXT("fixture cube component"), CubeComponent)) return false;
    CubeComponent->SetMobility(EComponentMobility::Movable);
    CubeComponent->SetStaticMesh(CubeMesh);
    CubeActor->SetActorScale3D(FVector(1.0, SideScale, SideScale));

    UTextureRenderTarget2D* Target = NewObject<UTextureRenderTarget2D>(World.Get(), NAME_None, RF_Transient);
    if (!TestNotNull(TEXT("floating-point depth target"), Target)) return false;
    Target->ClearColor = FLinearColor::Black;
    Target->InitCustomFormat(HaybaWorldDepth::Width, HaybaWorldDepth::Height,
        PF_A32B32G32R32F, true);
    Target->UpdateResourceImmediate(true);

    Capture = NewObject<USceneCaptureComponent2D>(World.Get(), NAME_None, RF_Transient);
    if (!TestNotNull(TEXT("scene-depth capture"), Capture)) return false;
    Capture->bCaptureEveryFrame = false;
    Capture->bCaptureOnMovement = false;
    Capture->CaptureSource = ESceneCaptureSource::SCS_SceneColorSceneDepth;
    Capture->FOVAngle = 90.0f;
    Capture->TextureTarget = Target;
    Capture->RegisterComponentWithWorld(World.Get());
    Capture->SetWorldLocationAndRotation(FVector::ZeroVector, FRotator::ZeroRotator);
    Capture->CaptureScene();
    FTextureRenderTargetResource* Resource = Target->GameThread_GetRenderTargetResource();
    if (!TestNotNull(TEXT("depth target render resource"), Resource)) return false;
    TSharedPtr<FHaybaWorldDepthReadback, ESPMode::ThreadSafe> Async =
        FHaybaWorldDepthReadback::Start(Resource);
    if (!TestTrue(TEXT("RGBA32f asynchronous readback queued"), Async.IsValid())) return false;
    const double AsyncStarted = FPlatformTime::Seconds();
    while (!Async->IsComplete() && FPlatformTime::Seconds() - AsyncStarted < 10.0)
    {
        Async->Poll();
        FlushRenderingCommands();
        FPlatformProcess::Sleep(0.01f);
    }
    if (!TestTrue(TEXT("asynchronous readback completed"), Async->IsComplete())) return false;
    TArray<FLinearColor> AsyncPixels;
    double AsyncCopyMs = 0.0;
    if (!TestTrue(TEXT("asynchronous readback returned every pixel"),
        Async->TakePixels(AsyncPixels, AsyncCopyMs))) return false;
    AddInfo(FString::Printf(TEXT("Async staging readback: wait %.2f ms, render-thread map/copy %.2f ms"),
        (FPlatformTime::Seconds() - AsyncStarted) * 1000.0, AsyncCopyMs));

    TArray<FLinearColor> Pixels;
    if (!TestTrue(TEXT("RGBA32f scene-depth readback"), Resource->ReadLinearColorPixels(Pixels)))
        return false;
    if (!TestEqual(TEXT("depth readback pixel count"), Pixels.Num(), HaybaWorldDepth::MaxPoints))
        return false;

    const int32 CenterX = HaybaWorldDepth::Width / 2;
    const int32 CenterY = HaybaWorldDepth::Height / 2;
    const FLinearColor& Center = Pixels[CenterY * HaybaWorldDepth::Width + CenterX];
    const FLinearColor& AsyncCenter = AsyncPixels[CenterY * HaybaWorldDepth::Width + CenterX];
    TestTrue(TEXT("asynchronous center pixel matches standard readback"),
        FMath::Abs(Center.A - AsyncCenter.A) <= 0.01f &&
        FMath::Abs(Center.R - AsyncCenter.R) <= 0.01f &&
        FMath::Abs(Center.G - AsyncCenter.G) <= 0.01f &&
        FMath::Abs(Center.B - AsyncCenter.B) <= 0.01f);
    const double DepthCm = static_cast<double>(Center.A);
    AddInfo(FString::Printf(TEXT("Synthetic cube face: expected %.2f cm, aligned SceneDepth A %.2f cm"),
        ExpectedDepthCm, DepthCm));
    if (!TestTrue(TEXT("scene depth is a linear forward distance in centimeters"),
        FMath::IsFinite(DepthCm) && FMath::Abs(DepthCm - ExpectedDepthCm) <= 5.0))
        return false;
    FColor DisplayColor = FColor::Black;
    TestTrue(TEXT("center pixel has finite rendered scene RGB"),
        HaybaWorldDepth::SceneColorToDisplay(Center, DisplayColor));

    const HaybaWorldDepth::FProjection Projection = HaybaWorldDepth::MakeProjection(
        FVector::ZeroVector, FRotator::ZeroRotator, 90.0);
    FVector WorldPoint;
    if (!TestTrue(TEXT("captured center pixel unprojects"),
        Projection.Unproject(CenterX, CenterY, DepthCm, WorldPoint)))
        return false;
    TestTrue(TEXT("unprojected point lies near the known cube face center"),
        FVector::Dist(WorldPoint, FVector(ExpectedDepthCm, 0.0, 0.0)) <= 10.0);

    if (!TestFalse(TEXT("scratch renderer supports material BaseColor capture"),
        IsForwardShadingEnabled(World->Scene->GetShaderPlatform()))) return false;
    UTextureRenderTarget2D* BaseTarget = NewObject<UTextureRenderTarget2D>(World.Get(), NAME_None, RF_Transient);
    if (!TestNotNull(TEXT("material BaseColor target"), BaseTarget)) return false;
    BaseTarget->InitCustomFormat(HaybaWorldDepth::Width, HaybaWorldDepth::Height,
        PF_A32B32G32R32F, true);
    BaseTarget->UpdateResourceImmediate(true);
    BaseCapture = NewObject<USceneCaptureComponent2D>(World.Get(), NAME_None, RF_Transient);
    if (!TestNotNull(TEXT("material BaseColor capture"), BaseCapture)) return false;
    BaseCapture->bCaptureEveryFrame = false;
    BaseCapture->bCaptureOnMovement = false;
    BaseCapture->CaptureSource = ESceneCaptureSource::SCS_BaseColor;
    BaseCapture->FOVAngle = Capture->FOVAngle;
    BaseCapture->TextureTarget = BaseTarget;
    BaseCapture->RegisterComponentWithWorld(World.Get());
    BaseCapture->SetWorldLocationAndRotation(Capture->GetComponentLocation(),
        Capture->GetComponentRotation());
    BaseCapture->CaptureScene();
    TSharedPtr<FHaybaWorldDepthReadback, ESPMode::ThreadSafe> AsyncBase =
        FHaybaWorldDepthReadback::Start(BaseTarget->GameThread_GetRenderTargetResource());
    if (!TestTrue(TEXT("aligned material BaseColor readback queued"), AsyncBase.IsValid())) return false;
    const double BaseStarted = FPlatformTime::Seconds();
    while (!AsyncBase->IsComplete() && FPlatformTime::Seconds() - BaseStarted < 10.0)
    {
        AsyncBase->Poll();
        FlushRenderingCommands();
        FPlatformProcess::Sleep(0.01f);
    }
    if (!TestTrue(TEXT("material BaseColor readback completed"), AsyncBase->IsComplete())) return false;
    TArray<FLinearColor> BasePixels;
    double BaseCopyMs = 0.0;
    if (!TestTrue(TEXT("material BaseColor readback returned every pixel"),
        AsyncBase->TakePixels(BasePixels, BaseCopyMs))) return false;
    TArray<FLinearColor> StandardBasePixels;
    if (!TestTrue(TEXT("standard material BaseColor reference readback"),
        BaseTarget->GameThread_GetRenderTargetResource()->ReadLinearColorPixels(StandardBasePixels))) return false;
    const FLinearColor& BaseCenter = BasePixels[CenterY * HaybaWorldDepth::Width + CenterX];
    const FLinearColor& StandardBaseCenter = StandardBasePixels[CenterY * HaybaWorldDepth::Width + CenterX];
    TestTrue(TEXT("asynchronous material BaseColor channels match standard readback"),
        FMath::Abs(BaseCenter.R - StandardBaseCenter.R) <= 0.01f &&
        FMath::Abs(BaseCenter.G - StandardBaseCenter.G) <= 0.01f &&
        FMath::Abs(BaseCenter.B - StandardBaseCenter.B) <= 0.01f);
    AddInfo(FString::Printf(TEXT("Aligned material BaseColor: RGB %.3f %.3f %.3f, wait %.2f ms, render copy %.2f ms"),
        BaseCenter.R, BaseCenter.G, BaseCenter.B,
        (FPlatformTime::Seconds() - BaseStarted) * 1000.0, BaseCopyMs));
    TestTrue(TEXT("known opaque cube face has observed material BaseColor"),
        BaseCenter.R + BaseCenter.G + BaseCenter.B > 0.1f);
    FColor Chosen = FColor::Black;
    TestEqual(TEXT("aligned material BaseColor is preferred over lit scene appearance"),
        HaybaWorldDepth::SelectDisplayColor(Center, &BaseCenter, Chosen),
        HaybaWorldDepth::EColorSource::RenderedMaterialBaseColor);
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
