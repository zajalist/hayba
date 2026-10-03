// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapWebPanel.cpp
#include "HaybaMCPSceneMapWebPanel.h"
#include "HaybaMCPEditorHealth.h"
#include "HaybaMCPWorldDepth.h"
#include "HaybaMCPWorldDepthReadback.h"
#include "RenderUtils.h"
#include "SceneInterface.h"

#include "SWebBrowser.h"
#include "IWebBrowserWindow.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Input/SButton.h"
#include "FileHelpers.h"
#include "Widgets/Text/STextBlock.h"
#include "Styling/AppStyle.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Editor.h"
#include "GameFramework/Actor.h"
#include "Components/StaticMeshComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Engine/Level.h"
#include "Engine/World.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Components/PrimitiveComponent.h"
#include "LevelEditorViewport.h"
#include "CollisionQueryParams.h"
#include "HAL/PlatformTime.h"
#include "LandscapeComponent.h"
#include "Async/Async.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Misc/DateTime.h"
#include "Misc/Guid.h"

SHaybaMCPSceneMapWebPanel::~SHaybaMCPSceneMapWebPanel()
{
    TileQueue.Reset(); ActiveTile.Reset(); TilePageActors.Reset();
    ReleaseDepthCapture();
}

void SHaybaMCPSceneMapWebPanel::Construct(const FArguments& InArgs)
{
    const FString Url = ResolveHtmlUrl();
    PageLoadStartedAt = FPlatformTime::Seconds();
    TWeakPtr<SHaybaMCPSceneMapWebPanel> WeakPanel = SharedThis(this);

    // Build the SWebBrowser, defer page-loaded callback until DOM is ready.
    SAssignNew(Browser, SWebBrowser)
        .InitialURL(Url)
        .ShowControls(false)
        .ShowAddressBar(false)
        .SupportsTransparency(false)
        .OnBeforeNavigation_Lambda([WeakPanel, Url](const FString& TargetUrl, const FWebNavigationRequest& Request)
        {
            static const FString Prefix = TEXT("hayba-scene-map://select/");
            static const FString RefreshPrefix = TEXT("hayba-scene-map://refresh/");
            static const FString OpenLevelPrefix = TEXT("hayba-scene-map://open-level/");
            static const FString RefinePrefix = TEXT("hayba-scene-map://refine/");
            static const FString SelectTilePrefix = TEXT("hayba-scene-map://select-tile/");
            auto ParseRoute = [&TargetUrl](const FString& Prefix, int32 Expected, TArray<int32>& Values)
            {
                TArray<FString> Parts;
                TargetUrl.Mid(Prefix.Len()).ParseIntoArray(Parts, TEXT("/"), true);
                if (Parts.Num() != Expected) return false;
                for (const FString& Part : Parts)
                {
                    int32 Value = 0;
                    if (!LexTryParseString(Value, *Part)) return false;
                    Values.Add(Value);
                }
                return true;
            };
            if (TargetUrl.StartsWith(RefinePrefix))
            {
                TArray<int32> Values;
                if (!Request.bIsMainFrame || !ParseRoute(RefinePrefix, 5, Values)) return true;
                AsyncTask(ENamedThreads::GameThread, [WeakPanel, Values]()
                {
                    if (TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel = WeakPanel.Pin())
                        Panel->QueueTile(Values[0], Values[1], Values[2], Values[3], Values[4]);
                });
                return true;
            }
            if (TargetUrl.StartsWith(SelectTilePrefix))
            {
                TArray<int32> Values;
                if (!Request.bIsMainFrame || !ParseRoute(SelectTilePrefix, 7, Values)) return true;
                AsyncTask(ENamedThreads::GameThread, [WeakPanel, Values]()
                {
                    if (TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel = WeakPanel.Pin())
                        Panel->SelectLoadedTileActor(Values[0], Values[1], Values[2], Values[3],
                            Values[4], Values[5], Values[6]);
                });
                return true;
            }
            if (TargetUrl == TEXT("hayba-scene-map://page-error"))
            {
                if (Request.bIsMainFrame)
                {
                    if (TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel = WeakPanel.Pin())
                    { Panel->bPageLoadFailed = true; Panel->bPageLoaded = false; }
                }
                return true;
            }
            if (TargetUrl.StartsWith(OpenLevelPrefix))
            {
                int32 Generation = 0;
                const FString Argument = TargetUrl.Mid(OpenLevelPrefix.Len());
                if (!Request.bIsMainFrame || !Argument.IsNumeric() ||
                    !LexTryParseString(Generation, *Argument) || Generation <= 0) return true;
                AsyncTask(ENamedThreads::GameThread, [WeakPanel, Generation]()
                {
                    if (TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel = WeakPanel.Pin())
                    {
                        if (Generation == Panel->ScanGeneration && GEditor && !GEditor->PlayWorld &&
                            !GEditor->IsPlaySessionRequestQueued())
                        { FEditorFileUtils::LoadMap(); Panel->Refresh(); }
                    }
                });
                return true;
            }
            // The panel has one local document. No actor-derived content may
            // navigate its main frame to a network or another local page.
            if (TargetUrl.StartsWith(RefreshPrefix))
            {
                if (!Request.bIsMainFrame) return true;
                int32 Generation = 0;
                const FString GenerationText = TargetUrl.Mid(RefreshPrefix.Len());
                if (!GenerationText.IsNumeric() || !LexTryParseString(Generation, *GenerationText) || Generation <= 0) return true;
                AsyncTask(ENamedThreads::GameThread, [WeakPanel, Generation]()
                {
                    if (TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel = WeakPanel.Pin())
                    {
                        if (Generation == Panel->ScanGeneration) Panel->Refresh();
                    }
                });
                return true;
            }
            if (!TargetUrl.StartsWith(Prefix))
            {
                const bool bLocalDocument = TargetUrl.Equals(Url, ESearchCase::IgnoreCase) ||
                    FGenericPlatformHttp::UrlDecode(TargetUrl).Equals(Url, ESearchCase::IgnoreCase);
                if (bLocalDocument)
                    if (TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel = WeakPanel.Pin())
                        Panel->bExpectDocumentLoad = true;
                return !bLocalDocument;
            }
            // Always cancel our command URL. Reject malformed or subframe
            // requests, and perform editor selection on the game thread.
            if (!Request.bIsMainFrame) return true;
            FString GenerationText, IndexText;
            const FString Argument = TargetUrl.Mid(Prefix.Len());
            if (!Argument.Split(TEXT("/"), &GenerationText, &IndexText)) return true;
            int32 Generation = 0, ActorIndex = INDEX_NONE;
            if (!GenerationText.IsNumeric() || !IndexText.IsNumeric() ||
                !LexTryParseString(Generation, *GenerationText) ||
                !LexTryParseString(ActorIndex, *IndexText) ||
                Generation <= 0 || ActorIndex < 0) return true;
            AsyncTask(ENamedThreads::GameThread, [WeakPanel, Generation, ActorIndex]()
            {
                if (TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel = WeakPanel.Pin())
                {
                    Panel->SelectLoadedActor(Generation, ActorIndex);
                }
            });
            return true;
        })
        .OnLoadStarted_Lambda([this]()
        { if (bExpectDocumentLoad)
          { bPageLoaded = false; bPageLoadFailed = false; PageLoadStartedAt = FPlatformTime::Seconds(); } })
        .OnLoadError_Lambda([this]() { if (bExpectDocumentLoad)
          { bPageLoadFailed = true; bPageLoaded = false; bExpectDocumentLoad = false; } })
        .OnLoadCompleted_Lambda([this]() { if (bExpectDocumentLoad)
          { bExpectDocumentLoad = false; OnPageLoaded(); } });

    ChildSlot
    [
        SNew(SOverlay)
        + SOverlay::Slot()
        [ Browser.ToSharedRef() ]
        + SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)
        [
            SNew(SBorder).Padding(18.f)
            .Visibility_Lambda([this]() { return bPageLoadFailed ? EVisibility::Visible : EVisibility::Collapsed; })
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 10.f)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("World preview could not load. Retry to reopen it."))) ]
                + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
                [ SNew(SButton).Text(FText::FromString(TEXT("Retry"))).OnClicked_Lambda([this]()
                  { bPageLoadFailed = false; bPageLoaded = false; PageLoadStartedAt = FPlatformTime::Seconds();
                    bExpectDocumentLoad = true; Refresh(); Browser->Reload(); return FReply::Handled(); }) ]
            ]
        ]
    ];

    // The first slice runs on Tick after the local page is ready.
    Refresh();
}

FString SHaybaMCPSceneMapWebPanel::ResolveHtmlUrl() const
{
    TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"));
    if (!Plugin.IsValid()) return TEXT("about:blank");
    const FString Path = FPaths::ConvertRelativePathToFull(
        Plugin->GetBaseDir() / TEXT("Resources/cognitive-map/index.html"));
    return FString::Printf(TEXT("file:///%s"), *Path.Replace(TEXT("\\"), TEXT("/")));
}

void SHaybaMCPSceneMapWebPanel::Refresh()
{
    if (FHaybaEditorHealth::IsUnsafe())
    {
        TileQueue.Reset(); ActiveTile.Reset();
        bScanDone = true; bScanPartial = true;
        ScanGaps.AddUnique(TEXT("editor_unsafe"));
        return;
    }
    ReleaseDepthCapture();
    HaybaViewDepthSnapshot::Invalidate();
    // Refreshing this panel must not erase an agent's independent tile capture.
    // Stored tiles remain timestamped observations; the capture service drops
    // them on editor-world/origin changes or PIE.
    ObservedDepth = HaybaViewDepthSnapshot::FSnapshot();
    bDepthSnapshotPublished = false;
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    ScannedWorld = World;
    Geometry = HaybaWorldGeometry::FSnapshot();
    TileQueue.Reset(); ActiveTile.Reset(); TilePageActors.Reset(); TileSelectionCacheOrder.Reset();
    Geometry.OriginCm = World ? FVector(World->OriginLocation) : FVector::ZeroVector;
    PendingGeometry = HaybaWorldGeometry::FSnapshot();
    PendingPointCursor = TotalPoints = ScannedActorSlots = TotalActorSlots = 0;
    NodeIndexBase = 1;
    ActorIndexByPath.Reset(); NodeIndexByPath.Reset(); DepthPixels.Reset(); BaseColorPixels.Reset();
    DepthPixelCursor = DepthPointCount = DepthAttributedCount = MaterialBaseColorPointCount = 0;
    DepthAnchorCursor = 0; DepthAnchors.Reset();
    DepthReadbackMs = DepthReadbackWaitMs = DepthReadbackStartedAt = 0.0;
    DepthReadbackGameThreadMaxMs = 0.0;
    BaseColorReadbackStartedAt = BaseColorReadbackMs = BaseColorReadbackWaitMs = 0.0;
    BaseColorStatus = TEXT("not_attempted");
    DepthCpuMs = DepthMaxTickCpuMs = 0.0;
    bDepthReadbackBudgetExceeded = false;
    DepthCaptureId.Reset();
    DepthPhase = EDepthPhase::NotStarted; DepthStatus = TEXT("not_attempted");
    LevelCursor = ActorCursor = 0;
    LoadedLevels.Reset(); LevelActorCounts.Reset(); DeferredActors.Reset(); DeferredAttempts.Reset(); ScanGaps.Reset();
    bScanDone = !World;
    bScanPartial = false;
    if (World)
    {
        for (ULevel* Level : World->GetLevels())
        {
            if (!IsValid(Level)) continue;
            LoadedLevels.Add(Level);
            const int32 Count = Level->Actors.Num();
            LevelActorCounts.Add(Count);
            TotalActorSlots += Count;
        }
    }
    ++ScanGeneration;
    if (bPageLoaded) PushGeometryToPage();
}

void SHaybaMCPSceneMapWebPanel::OnPageLoaded()
{
    bPageLoaded = true;
    bPageLoadFailed = false;
    // Reloads replay the scan, rather than metadata without its point chunks.
    Refresh();
}

void SHaybaMCPSceneMapWebPanel::FitView()  { Run(TEXT("window.haybaFit && window.haybaFit();")); }
void SHaybaMCPSceneMapWebPanel::ResetView(){ Run(TEXT("window.haybaReset && window.haybaReset();")); }

bool SHaybaMCPSceneMapWebPanel::FocusTile(int32 LOD, int32 X, int32 Y, int32 Z)
{
    if (FHaybaEditorHealth::IsUnsafe()) return false;
    FBox Bounds(EForceInit::ForceInit);
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!bPageLoaded || !bScanDone || !IsValid(World) || World != ScannedWorld.Get() ||
        !HaybaWorldGeometry::TileBounds(LOD, X, Y, Z, Bounds)) return false;
    const FString TileId = HaybaWorldGeometry::TileId(LOD, X, Y, Z);
    Run(FString::Printf(TEXT("window.haybaFocusTile && window.haybaFocusTile('%s');"), *TileId));
    // Native callers already know the exact tile. Do not depend on a second
    // custom-URL round trip through CEF to begin its capture.
    QueueTile(ScanGeneration, LOD, X, Y, Z);
    return true;
}

void SHaybaMCPSceneMapWebPanel::PushGeometryToPage()
{
    Run(FString::Printf(TEXT("if (window.haybaLoadGeometry) { window.haybaLoadGeometry(%s); } else { window.location.href='hayba-scene-map://page-error'; }"), *GeometryToJson()));
    if (bScanDone) FinishScan();
}

void SHaybaMCPSceneMapWebPanel::Tick(const FGeometry& AllottedGeometry,
    const double InCurrentTime, const float InDeltaTime)
{
    SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
    if (!bPageLoaded && !bPageLoadFailed && FPlatformTime::Seconds() - PageLoadStartedAt > 20.0)
        bPageLoadFailed = true;
    if (!bPageLoaded) return;
    if (FHaybaEditorHealth::IsUnsafe())
    {
        // Native health is sticky until restart. Do not touch editor UObjects,
        // publish a partial tile, or start a depth readback after a fault.
        TileQueue.Reset();
        ActiveTile.Reset();
        bScanDone = true;
        bScanPartial = true;
        ScanGaps.AddUnique(TEXT("editor_unsafe"));
        return;
    }
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (ActiveTile.IsSet() || !TileQueue.IsEmpty()) ProcessTile(World);
    if (bScanDone)
    {
        // A completed preview belongs to its observed world, never the level
        // opened afterward. Interrupted scans keep their explicit Retry state.
        if (ScannedWorld.Get() != World && !ScanGaps.Contains(TEXT("editor_world_changed"))) Refresh();
        return;
    }
    if (!IsValid(World) || ScannedWorld.Get() != World)
    {
        bScanPartial = true; ScanGaps.AddUnique(TEXT("editor_world_changed"));
        if (DepthPhase == EDepthPhase::AwaitReadback || DepthPhase == EDepthPhase::Processing)
        {
            DepthStatus = TEXT("editor_world_changed"); DepthPhase = EDepthPhase::Complete;
            if (BaseColorStatus == TEXT("capture_queued")) BaseColorStatus = TEXT("editor_world_changed");
            DepthPixels.Reset(); DepthAnchors.Reset(); ReleaseDepthCapture();
        }
        FinishScan(); return;
    }
    if ((DepthPhase == EDepthPhase::AwaitReadback || DepthPhase == EDepthPhase::Processing) &&
        GEditor && (GEditor->PlayWorld || GEditor->IsPlaySessionRequestQueued()))
    {
        DepthStatus = TEXT("pie_started_during_capture"); DepthPhase = EDepthPhase::Complete;
        if (BaseColorStatus == TEXT("capture_queued")) BaseColorStatus = TEXT("pie_started_during_capture");
        DepthPixels.Reset(); DepthAnchors.Reset(); ReleaseDepthCapture(); FinishScan(); return;
    }
    if (DepthPhase == EDepthPhase::AwaitReadback)
    {
        const double PollStarted = FPlatformTime::Seconds();
        bool bDepthFailed = false;
        if (DepthReadback.IsValid() && !DepthReadback->IsComplete()) DepthReadback->Poll();
        if (DepthReadback.IsValid() && DepthReadback->IsComplete())
        {
            const bool bRead = DepthReadback->TakePixels(DepthPixels, DepthReadbackMs);
            DepthReadbackWaitMs = (FPlatformTime::Seconds() - DepthReadbackStartedAt) * 1000.0;
            bDepthReadbackBudgetExceeded = DepthReadbackMs > HaybaWorldDepth::ReadbackWarningMs;
            DepthReadback.Reset();
            if (!bRead) { DepthStatus = TEXT("readback_unavailable"); bDepthFailed = true; }
        }
        if (BaseColorReadback.IsValid() && !BaseColorReadback->IsComplete())
            BaseColorReadback->Poll();
        if (BaseColorReadback.IsValid() && BaseColorReadback->IsComplete())
        {
            const bool bRead = BaseColorReadback->TakePixels(BaseColorPixels, BaseColorReadbackMs);
            BaseColorReadbackWaitMs = (FPlatformTime::Seconds() - BaseColorReadbackStartedAt) * 1000.0;
            BaseColorStatus = bRead ? TEXT("captured") : TEXT("readback_unavailable");
            ReleaseBaseColorCapture();
        }
        if (BaseColorReadback.IsValid() &&
            FPlatformTime::Seconds() - BaseColorReadbackStartedAt > 10.0)
        {
            BaseColorStatus = TEXT("readback_timeout");
            ReleaseBaseColorCapture();
        }
        if (!bDepthFailed && DepthPixels.Num() != HaybaWorldDepth::MaxPoints &&
            FPlatformTime::Seconds() - DepthReadbackStartedAt > 10.0)
        { DepthStatus = TEXT("readback_timeout"); bDepthFailed = true; }
        if (!bDepthFailed && DepthPixels.Num() == HaybaWorldDepth::MaxPoints &&
            !BaseColorReadback.IsValid())
        { DepthPhase = EDepthPhase::Processing; DepthStatus = TEXT("depth_visible"); }
        DepthReadbackGameThreadMaxMs = FMath::Max(DepthReadbackGameThreadMaxMs,
            (FPlatformTime::Seconds() - PollStarted) * 1000.0);
        if (bDepthFailed)
        {
            DepthPhase = EDepthPhase::Complete;
            if (BaseColorStatus == TEXT("capture_queued")) BaseColorStatus = TEXT("depth_unavailable");
            DepthPixels.Reset(); BaseColorPixels.Reset(); ReleaseDepthCapture(); FinishScan();
        }
        return;
    }
    if (DepthPhase == EDepthPhase::Processing) { ProcessDepthPixels(World); return; }
    if (PendingPointCursor < PendingGeometry.Splats.Num())
    {
        SendPendingPointChunk();
        return;
    }
    PendingGeometry = HaybaWorldGeometry::FSnapshot();
    PendingPointCursor = 0;
    constexpr int32 TotalPointLimit = HaybaWorldDepth::MeshPointBudget;
    constexpr int32 BatchActorLimit = 8;
    constexpr int32 SlotVisitLimit = 128;
    if (TotalPoints >= TotalPointLimit)
    {
        bScanPartial = true; ScanGaps.AddUnique(TEXT("total_point_cap"));
        FinishScan(); return;
    }
    TArray<TWeakObjectPtr<AActor>> Batch;
    Batch.Reserve(BatchActorLimit);
    while (!DeferredActors.IsEmpty() && Batch.Num() < BatchActorLimit)
        Batch.Add(DeferredActors.Pop(EAllowShrinking::No));
    int32 SlotsThisTick = 0;
    const double ScanStart = FPlatformTime::Seconds();
    while (Batch.Num() < BatchActorLimit && SlotsThisTick < SlotVisitLimit && LevelCursor < LoadedLevels.Num()
        && FPlatformTime::Seconds() - ScanStart < 0.004)
    {
        ULevel* Level = LoadedLevels[LevelCursor].Get();
        const int32 OriginalCount = LevelActorCounts[LevelCursor];
        if (!IsValid(Level))
        {
            bScanPartial = true; ScanGaps.AddUnique(TEXT("loaded_level_unavailable"));
            ++LevelCursor; ActorCursor = 0; continue;
        }
        if (Level->Actors.Num() != OriginalCount)
        {
            bScanPartial = true; ScanGaps.AddUnique(TEXT("loaded_level_changed"));
        }
        if (ActorCursor >= OriginalCount)
        {
            ++LevelCursor; ActorCursor = 0; continue;
        }
        const int32 Slot = ActorCursor++;
        ++SlotsThisTick; ++ScannedActorSlots;
        if (!Level->Actors.IsValidIndex(Slot)) continue;
        AActor* Actor = Level->Actors[Slot];
        if (!IsValid(Actor) || Actor->GetWorld() != World || Actor->IsEditorOnly()) continue;
        int32 Inspected = 0;
        bool bRelevant = false;
        for (UActorComponent* Component : Actor->GetComponents())
        {
            if (++Inspected > 64)
            {
                bScanPartial = true; ScanGaps.AddUnique(TEXT("eligibility_component_cap"));
                break;
            }
            if (!IsValid(Component) || !Component->IsRegistered()) continue;
            if (Component->IsA<UStaticMeshComponent>() || Component->IsA<USkeletalMeshComponent>() ||
                Component->IsA<ULandscapeComponent>()) { bRelevant = true; break; }
        }
        if (bRelevant) Batch.Add(Actor);
    }
    if (Batch.IsEmpty())
    {
        if (LevelCursor >= LoadedLevels.Num() && DeferredActors.IsEmpty()) FinishScan();
        return;
    }
    // Allocate the fixed point budget across the loaded actor slots. Sparse
    // metadata actors leave headroom; small scenes receive much denser surfaces.
    const int32 PointsPerActor = FMath::Clamp(TotalPointLimit / FMath::Max(1, TotalActorSlots), 24, 512);
    const int32 PagePointLimit = FMath::Min3(4096, TotalPointLimit - TotalPoints,
        PointsPerActor * Batch.Num());
    PendingGeometry = HaybaWorldGeometry::BuildBatch(World, Batch, PagePointLimit, 0.020);
    for (const TWeakObjectPtr<AActor>& Input : Batch)
    {
        AActor* Actor = Input.Get();
        if (!IsValid(Actor) || Actor->GetWorld() != World) continue;
        const bool bProcessed = PendingGeometry.Actors.ContainsByPredicate(
            [Actor](const HaybaWorldGeometry::FActor& Entry) { return Entry.LoadedActor.Get() == Actor; });
        if (!bProcessed)
        {
            int32& Attempts = DeferredAttempts.FindOrAdd(Actor->GetPathName());
            if (++Attempts < 2) DeferredActors.Add(Actor);
            else { bScanPartial = true; ScanGaps.AddUnique(TEXT("actor_process_time_budget")); }
        }
    }
    for (const FString& Gap : PendingGeometry.StopReasons)
    {
        // A per-page point cap is planned density reduction, not lost actors.
        if (Gap != TEXT("splat_cap")) { bScanPartial = true; ScanGaps.AddUnique(Gap); }
    }
    const int32 ActorBase = Geometry.Actors.Num();
    for (int32 Index = 0; Index < PendingGeometry.Actors.Num(); ++Index)
        ActorIndexByPath.Add(PendingGeometry.Actors[Index].Path, ActorBase + Index);
    for (int32 Index = 1; Index < PendingGeometry.Nodes.Num(); ++Index)
        if (!PendingGeometry.Nodes[Index].Path.IsEmpty())
            NodeIndexByPath.Add(PendingGeometry.Nodes[Index].Path, NodeIndexBase + Index - 1);
    NodeIndexBase += FMath::Max(0, PendingGeometry.Nodes.Num() - 1);
    Geometry.Actors.Append(PendingGeometry.Actors);
    TSharedRef<FJsonObject> Metadata = HaybaWorldGeometry::ToMetadataJson(PendingGeometry);
    Metadata->SetNumberField(TEXT("actorBase"), ActorBase);
    FString Json;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
    FJsonSerializer::Serialize(Metadata, Writer);
    Run(FString::Printf(TEXT("window.haybaAppendGeometry(%d,%s);"), ScanGeneration, *Json));
    TotalPoints += PendingGeometry.Splats.Num();
    if (PendingGeometry.Splats.IsEmpty() && LevelCursor >= LoadedLevels.Num() && DeferredActors.IsEmpty())
        FinishScan();
}

void SHaybaMCPSceneMapWebPanel::SendPendingPointChunk()
{
    // One ordinary eight-actor page now fits in one bounded browser message.
    // This avoids a second hidden-window Slate tick per page.
    constexpr int32 ChunkSize = 1024;
    const int32 Start = PendingPointCursor;
    const int32 End = FMath::Min(Start + ChunkSize, PendingGeometry.Splats.Num());
    if (Start < End)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        Values.Reserve(End - Start);
        for (int32 Index = Start; Index < End; ++Index)
            Values.Add(HaybaWorldGeometry::SplatToJson(PendingGeometry.Splats[Index]));
        FString Json;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
        FJsonSerializer::Serialize(Values, Writer);
        Run(FString::Printf(TEXT("window.haybaAppendSplats(%d,%s);"), ScanGeneration, *Json));
    }
    PendingPointCursor = End;
    if (PendingPointCursor >= PendingGeometry.Splats.Num() &&
        LevelCursor >= LoadedLevels.Num() && DeferredActors.IsEmpty()) FinishScan();
}

void SHaybaMCPSceneMapWebPanel::ReleaseBaseColorCapture()
{
    BaseColorReadback.Reset();
    if (BaseColorCapture.IsValid())
    {
        BaseColorCapture->TextureTarget = nullptr;
        BaseColorCapture->UnregisterComponent();
    }
    BaseColorCapture.Reset();
    if (BaseColorTarget.IsValid()) BaseColorTarget->ReleaseResource();
    BaseColorTarget.Reset();
}

void SHaybaMCPSceneMapWebPanel::ReleaseDepthCapture()
{
    ReleaseBaseColorCapture();
    BaseColorPixels.Reset();
    DepthReadback.Reset();
    if (DepthCapture.IsValid())
    {
        DepthCapture->TextureTarget = nullptr;
        DepthCapture->UnregisterComponent();
    }
    DepthCapture.Reset();
    if (DepthTarget.IsValid()) DepthTarget->ReleaseResource();
    DepthTarget.Reset();
}

void SHaybaMCPSceneMapWebPanel::BeginDepthCapture()
{
    DepthPhase = EDepthPhase::Complete;
    UWorld* World = ScannedWorld.Get();
    ObservedDepth = HaybaViewDepthSnapshot::FSnapshot();
    DepthCaptureId = FGuid::NewGuid().ToString(EGuidFormats::Digits);
    ObservedDepth.CaptureId = DepthCaptureId;
    ObservedDepth.World = World;
    ObservedDepth.WorldPath = IsValid(World) ? World->GetPathName() : FString();
    ObservedDepth.CapturedAtUtc = FDateTime::UtcNow().ToIso8601();
    FLevelEditorViewportClient* View = GCurrentLevelEditingViewportClient;
    if (GEditor && (GEditor->PlayWorld || GEditor->IsPlaySessionRequestQueued()))
    {
        DepthStatus = TEXT("pie_active_or_queued"); return;
    }
    if (IsValid(World) && (!View || View->GetWorld() != World || !View->IsPerspective()) && GEditor)
    {
        // A docked World panel need not own focus. Use another perspective
        // viewport of this same editor world, never a different asset world.
        View = nullptr;
        for (FLevelEditorViewportClient* Candidate : GEditor->GetLevelViewportClients())
        {
            if (Candidate && Candidate->GetWorld() == World && Candidate->IsPerspective())
            { View = Candidate; break; }
        }
    }
    if (!IsValid(World) || !View)
    {
        DepthStatus = TEXT("perspective_editor_view_unavailable"); return;
    }
    // One render target per explicit panel scan: 256² RGBA32f = 1 MiB.
    // Capture only the first visible surface, never infer unloaded or occluded geometry.
    DepthCameraCm = View->GetViewLocation();
    DepthRotation = View->GetViewRotation();
    const double RequestedFov = static_cast<double>(View->ViewFOV);
    if (DepthCameraCm.ContainsNaN() || DepthRotation.ContainsNaN() ||
        !FMath::IsFinite(RequestedFov))
    {
        DepthStatus = TEXT("invalid_capture_camera"); return;
    }
    DepthFov = FMath::Clamp(RequestedFov, 5.0, 170.0);
    ObservedDepth.CameraCm = DepthCameraCm;
    ObservedDepth.CameraRotationDegrees = DepthRotation;
    ObservedDepth.HorizontalFovDegrees = DepthFov;
    ObservedDepth.bCameraValid = true;
    DepthTarget.Reset(NewObject<UTextureRenderTarget2D>(World, NAME_None, RF_Transient));
    DepthCapture.Reset(NewObject<USceneCaptureComponent2D>(World, NAME_None, RF_Transient));
    if (!DepthTarget.IsValid() || !DepthCapture.IsValid())
    {
        DepthStatus = TEXT("capture_allocation_failed"); ReleaseDepthCapture(); return;
    }
    DepthTarget->InitCustomFormat(HaybaWorldDepth::Width, HaybaWorldDepth::Height, PF_A32B32G32R32F, true);
    DepthTarget->UpdateResourceImmediate(true);
    DepthCapture->bCaptureEveryFrame = false;
    DepthCapture->bCaptureOnMovement = false;
    // This pass supplies visible-surface depth and lit scene-color fallback.
    // A second aligned pass samples material BaseColor where supported.
    // Offscreen/occluded mesh points keep their unknown-color presentation.
    DepthCapture->CaptureSource = ESceneCaptureSource::SCS_SceneColorSceneDepth;
    DepthCapture->FOVAngle = static_cast<float>(DepthFov);
    DepthCapture->TextureTarget = DepthTarget.Get();
    DepthCapture->RegisterComponentWithWorld(World);
    DepthCapture->SetWorldLocationAndRotation(DepthCameraCm, DepthRotation);
    DepthCapture->CaptureScene();
    DepthReadback = FHaybaWorldDepthReadback::Start(DepthTarget->GameThread_GetRenderTargetResource());
    if (!DepthReadback.IsValid())
    {
        DepthStatus = TEXT("readback_unavailable"); ReleaseDepthCapture(); return;
    }
    BeginBaseColorCapture(World);
    DepthReadbackStartedAt = FPlatformTime::Seconds();
    DepthPhase = EDepthPhase::AwaitReadback;
    DepthStatus = TEXT("capture_queued");
}

void SHaybaMCPSceneMapWebPanel::BeginBaseColorCapture(UWorld* World)
{
    // UE 5.8 silently substitutes lit scene color for SCS_BaseColor in forward
    // shading. That value is never advertised as material BaseColor here.
    if (!World || !World->Scene ||
        IsForwardShadingEnabled(World->Scene->GetShaderPlatform()))
    { BaseColorStatus = TEXT("unsupported_forward_renderer"); return; }

    BaseColorTarget.Reset(NewObject<UTextureRenderTarget2D>(World, NAME_None, RF_Transient));
    BaseColorCapture.Reset(NewObject<USceneCaptureComponent2D>(World, NAME_None, RF_Transient));
    if (!BaseColorTarget.IsValid() || !BaseColorCapture.IsValid())
    { BaseColorStatus = TEXT("allocation_failed"); ReleaseBaseColorCapture(); return; }
    BaseColorTarget->InitCustomFormat(HaybaWorldDepth::Width, HaybaWorldDepth::Height,
        PF_A32B32G32R32F, true);
    BaseColorTarget->UpdateResourceImmediate(true);
    BaseColorCapture->bCaptureEveryFrame = false;
    BaseColorCapture->bCaptureOnMovement = false;
    BaseColorCapture->CaptureSource = ESceneCaptureSource::SCS_BaseColor;
    BaseColorCapture->FOVAngle = static_cast<float>(DepthFov);
    BaseColorCapture->TextureTarget = BaseColorTarget.Get();
    BaseColorCapture->RegisterComponentWithWorld(World);
    BaseColorCapture->SetWorldLocationAndRotation(DepthCameraCm, DepthRotation);
    BaseColorCapture->CaptureScene();
    BaseColorReadback = FHaybaWorldDepthReadback::Start(
        BaseColorTarget->GameThread_GetRenderTargetResource());
    if (!BaseColorReadback.IsValid())
    { BaseColorStatus = TEXT("readback_unavailable"); ReleaseBaseColorCapture(); return; }
    BaseColorReadbackStartedAt = FPlatformTime::Seconds();
    BaseColorStatus = TEXT("capture_queued");
}

void SHaybaMCPSceneMapWebPanel::ProcessDepthPixels(UWorld* World)
{
    constexpr int32 CellSize = HaybaWorldDepth::AttributionCellSize;
    constexpr int32 AnchorsPerAxis = HaybaWorldDepth::Width / CellSize;
    constexpr int32 AnchorCount = AnchorsPerAxis * AnchorsPerAxis;
    constexpr double SliceSeconds = 0.002;
    const double Start = FPlatformTime::Seconds();
    const HaybaWorldDepth::FProjection Projection = HaybaWorldDepth::MakeProjection(
        DepthCameraCm, DepthRotation, DepthFov);
    if (DepthCpuMs > HaybaWorldDepth::MaxProcessingCpuMs)
    {
        DepthStatus = TEXT("processing_time_budget"); DepthPhase = EDepthPhase::Complete;
        DepthPixels.Reset(); DepthAnchors.Reset(); ReleaseDepthCapture(); FinishScan(); return;
    }
    const auto AccountCpuTime = [this, Start]()
    {
        const double TickMs = (FPlatformTime::Seconds() - Start) * 1000.0;
        DepthCpuMs += TickMs;
        DepthMaxTickCpuMs = FMath::Max(DepthMaxTickCpuMs, TickMs);
    };
    if (DepthAnchors.IsEmpty()) DepthAnchors.SetNum(AnchorCount);
    // Sparse physics rays supply depth-matched collision labels, which can be
    // ambiguous where invisible or coplanar collision matches the surface.
    // Raster depth,
    // rather than collision geometry, supplies all point positions.
    while (DepthAnchorCursor < AnchorCount &&
        FPlatformTime::Seconds() - Start < SliceSeconds)
    {
        const int32 Anchor = DepthAnchorCursor++;
        const int32 X = (Anchor % AnchorsPerAxis) * CellSize + CellSize / 2;
        const int32 Y = (Anchor / AnchorsPerAxis) * CellSize + CellSize / 2;
        const double DepthCm = DepthPixels[Y * HaybaWorldDepth::Width + X].A;
        FDepthAnchor& Label = DepthAnchors[Anchor];
        Label.DepthCm = DepthCm;
        FVector Point;
        if (!Projection.Unproject(X, Y, DepthCm, Point)) continue;
        const FVector Direction = (Point - DepthCameraCm).GetSafeNormal();
        FHitResult Hit;
        if (!World->LineTraceSingleByChannel(Hit, DepthCameraCm, Point + Direction * 50.0,
            ECC_Visibility, FCollisionQueryParams(SCENE_QUERY_STAT(HaybaWorldDepthAttribution), true))) continue;
        if (!HaybaWorldDepth::TraceMatchesDepth(DepthCm,
            FVector::Dist(DepthCameraCm, Point),
            FVector::Dist(DepthCameraCm, Hit.ImpactPoint))) continue;
        AActor* Actor = Hit.GetActor();
        if (!IsValid(Actor) || Actor->GetWorld() != World) continue;
        Label.SourceActorPath = Actor->GetPathName();
        Label.SourceActorLabel = Actor->GetActorLabel();
        const int32* ActorIndex = ActorIndexByPath.Find(Actor->GetPathName());
        if (!ActorIndex) continue;
        Label.Actor = *ActorIndex;
        if (UPrimitiveComponent* Component = Hit.GetComponent())
            if (const int32* NodeIndex = NodeIndexByPath.Find(Component->GetPathName())) Label.Node = *NodeIndex;
    }
    if (DepthAnchorCursor < AnchorCount) { AccountCpuTime(); return; }
    TArray<TSharedPtr<FJsonValue>> Rows;
    Rows.Reserve(HaybaWorldDepth::PointsPerTick);
    while (DepthPixelCursor < DepthPixels.Num() && Rows.Num() < HaybaWorldDepth::PointsPerTick &&
        DepthPointCount < HaybaWorldDepth::MaxPoints && FPlatformTime::Seconds() - Start < SliceSeconds)
    {
        // Coarse-to-fine image order makes a time-budgeted partial capture
        // spatially representative instead of emitting only the top rows.
        const int32 Pixel = HaybaWorldDepth::PixelAtOrdinal(DepthPixelCursor++);
        const int32 X = Pixel % HaybaWorldDepth::Width;
        const int32 Y = Pixel / HaybaWorldDepth::Width;
        const FLinearColor& ColorDepth = DepthPixels[Pixel];
        const double DepthCm = ColorDepth.A;
        FVector Point;
        if (!Projection.Unproject(X, Y, DepthCm, Point)) continue;
        const int32 Cell = (Y / CellSize) * AnchorsPerAxis + X / CellSize;
        const FDepthAnchor& Anchor = DepthAnchors[Cell];
        // The one physics ray verifies only its own raster pixel. Nearby
        // coplanar actors can share a cell and depth, so never propagate that
        // actor identity to the other visible pixels in the cell.
        const bool bVerifiedPixel = HaybaWorldDepth::IsRayVerifiedPixel(X, Y);
        const bool bMatchedRayPixel = bVerifiedPixel &&
            !Anchor.SourceActorPath.IsEmpty() && FMath::IsFinite(Anchor.DepthCm) &&
            FMath::Abs(DepthCm - Anchor.DepthCm) <= KINDA_SMALL_NUMBER;
        const bool bAttributed = bVerifiedPixel &&
            Anchor.Actor != INDEX_NONE && Anchor.Node != INDEX_NONE &&
            FMath::IsFinite(Anchor.DepthCm) &&
            FMath::Abs(DepthCm - Anchor.DepthCm) <= KINDA_SMALL_NUMBER;
        HaybaWorldGeometry::FSplat Splat;
        Splat.PositionCm = Point - Geometry.OriginCm;
        Splat.Normal = (DepthCameraCm - Point).GetSafeNormal();
        FColor DisplayColor = FColor::Black;
        const FLinearColor* BaseColor = BaseColorPixels.IsValidIndex(Pixel)
            ? &BaseColorPixels[Pixel] : nullptr;
        const HaybaWorldDepth::EColorSource ColorSource =
            HaybaWorldDepth::SelectDisplayColor(ColorDepth, BaseColor, DisplayColor);
        const bool bColorObserved = ColorSource != HaybaWorldDepth::EColorSource::Unobserved;
        if (ColorSource == HaybaWorldDepth::EColorSource::RenderedMaterialBaseColor)
            ++MaterialBaseColorPointCount;
        Splat.R = bColorObserved ? DisplayColor.R : 145;
        Splat.G = bColorObserved ? DisplayColor.G : 138;
        Splat.B = bColorObserved ? DisplayColor.B : 129;
        Splat.ActorIndex = bAttributed ? Anchor.Actor : INDEX_NONE;
        Splat.NodeIndex = bAttributed ? Anchor.Node : INDEX_NONE;
        HaybaViewDepthSnapshot::FPoint ObservedPoint;
        ObservedPoint.PositionCm = Point;
        ObservedPoint.PixelX = X;
        ObservedPoint.PixelY = Y;
        ObservedPoint.DepthCm = DepthCm;
        ObservedPoint.DisplayColor = DisplayColor;
        ObservedPoint.ColorSource = ColorSource;
        if (bMatchedRayPixel)
        {
            ObservedPoint.SourceActorPath = Anchor.SourceActorPath;
            ObservedPoint.SourceActorLabel = Anchor.SourceActorLabel;
        }
        ObservedDepth.AddPoint(MoveTemp(ObservedPoint));
        Rows.Add(HaybaWorldGeometry::SplatToJson(Splat));
        ++DepthPointCount;
        if (bAttributed) ++DepthAttributedCount;
    }
    if (!Rows.IsEmpty())
    {
        FString Json;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
        FJsonSerializer::Serialize(Rows, Writer);
        Run(FString::Printf(TEXT("window.haybaAppendDepthSplats(%d,%s);"), ScanGeneration, *Json));
    }
    if (DepthPixelCursor < DepthPixels.Num() && DepthPointCount < HaybaWorldDepth::MaxPoints)
    { AccountCpuTime(); return; }
    AccountCpuTime();
    DepthPhase = EDepthPhase::Complete;
    DepthStatus = DepthPointCount > 0 ? TEXT("complete_visible_subset") : TEXT("no_valid_depth");
    DepthPixels.Reset(); BaseColorPixels.Reset(); DepthAnchors.Reset();
    ReleaseDepthCapture(); FinishScan();
}

void SHaybaMCPSceneMapWebPanel::FinishScan()
{
    if (DepthPhase == EDepthPhase::NotStarted && IsValid(ScannedWorld.Get()) &&
        !ScanGaps.Contains(TEXT("editor_world_changed")))
    {
        BeginDepthCapture();
        if (DepthPhase != EDepthPhase::Complete) return;
    }
    if (DepthPhase == EDepthPhase::AwaitReadback || DepthPhase == EDepthPhase::Processing) return;
    if (!bDepthSnapshotPublished && DepthPhase == EDepthPhase::Complete &&
        !ObservedDepth.CaptureId.IsEmpty())
    {
        ObservedDepth.Status = DepthStatus;
        ObservedDepth.ProcessedPixelCount = DepthPixelCursor;
        ObservedDepth.ReadbackMs = DepthReadbackMs;
        ObservedDepth.ReadbackWaitMs = DepthReadbackWaitMs;
        ObservedDepth.ReadbackGameThreadMaxMs = DepthReadbackGameThreadMaxMs;
        ObservedDepth.BaseColorStatus = BaseColorStatus;
        ObservedDepth.BaseColorReadbackMs = BaseColorReadbackMs;
        ObservedDepth.BaseColorReadbackWaitMs = BaseColorReadbackWaitMs;
        if (DepthPointCount > 0 && MaterialBaseColorPointCount != DepthPointCount)
            ObservedDepth.Gaps.AddUnique(BaseColorStatus == TEXT("captured")
                ? FString(TEXT("base_color_invalid_pixels"))
                : FString::Printf(TEXT("base_color_%s"), *BaseColorStatus));
        ObservedDepth.bReadbackBudgetExceeded = bDepthReadbackBudgetExceeded;
        ObservedDepth.ProcessingCpuMs = DepthCpuMs;
        if (DepthStatus != TEXT("complete_visible_subset"))
            ObservedDepth.Gaps.Add(FString::Printf(TEXT("depth_%s"), *DepthStatus));
        HaybaViewDepthSnapshot::Publish(MoveTemp(ObservedDepth));
        bDepthSnapshotPublished = true;
    }
    if (bScanDone && !bPageLoaded) return;
    bScanDone = true;
    const bool bDepthPartial = DepthStatus != TEXT("complete_visible_subset") &&
        DepthStatus != TEXT("not_attempted");
    if (bDepthPartial) ScanGaps.AddUnique(FString::Printf(TEXT("depth_%s"), *DepthStatus));
    const bool bColorPartial = DepthPointCount > 0 && MaterialBaseColorPointCount != DepthPointCount;
    if (bColorPartial) ScanGaps.AddUnique(BaseColorStatus == TEXT("captured")
        ? FString(TEXT("base_color_invalid_pixels"))
        : FString::Printf(TEXT("base_color_%s"), *BaseColorStatus));
    const bool bAnyPartial = bScanPartial || bDepthPartial || bColorPartial;
    TSharedRef<FJsonObject> Completion = MakeShared<FJsonObject>();
    Completion->SetBoolField(TEXT("partial"), bAnyPartial);
    Completion->SetStringField(TEXT("worldState"), !ScannedWorld.IsValid() ? TEXT("no_world") :
        ScanGaps.Contains(TEXT("editor_world_changed")) ? TEXT("failed") :
        bAnyPartial ? TEXT("partial") : TEXT("complete"));
    Completion->SetNumberField(TEXT("scannedActorSlots"), ScannedActorSlots);
    Completion->SetNumberField(TEXT("totalActorSlots"), TotalActorSlots);
    Completion->SetNumberField(TEXT("totalPointLimit"), HaybaWorldDepth::TotalPointBudget);
    TSharedRef<FJsonObject> Depth = MakeShared<FJsonObject>();
    Depth->SetStringField(TEXT("source"), TEXT("scene_depth_visible_surface"));
    if (!DepthCaptureId.IsEmpty()) Depth->SetStringField(TEXT("captureId"), DepthCaptureId);
    else Depth->SetField(TEXT("captureId"), MakeShared<FJsonValueNull>());
    Depth->SetStringField(TEXT("status"), DepthStatus);
    Depth->SetBoolField(TEXT("partial"), DepthStatus != TEXT("complete_visible_subset"));
    Depth->SetNumberField(TEXT("resolutionX"), HaybaWorldDepth::Width);
    Depth->SetNumberField(TEXT("resolutionY"), HaybaWorldDepth::Height);
    Depth->SetNumberField(TEXT("pointCount"), DepthPointCount);
    Depth->SetNumberField(TEXT("processedPixelCount"), DepthPixelCursor);
    Depth->SetNumberField(TEXT("maximumPoints"), HaybaWorldDepth::MaxPoints);
    Depth->SetNumberField(TEXT("attributedPointCount"), DepthAttributedCount);
    Depth->SetNumberField(TEXT("maximumPhysicsRays"), HaybaWorldDepth::MaxPhysicsRays);
    Depth->SetNumberField(TEXT("readbackMs"), DepthReadbackMs);
    Depth->SetNumberField(TEXT("readbackWaitMs"), DepthReadbackWaitMs);
    Depth->SetNumberField(TEXT("readbackGameThreadMaxMs"), DepthReadbackGameThreadMaxMs);
    Depth->SetStringField(TEXT("baseColorStatus"), BaseColorStatus);
    Depth->SetNumberField(TEXT("materialBaseColorPointCount"), MaterialBaseColorPointCount);
    Depth->SetNumberField(TEXT("baseColorReadbackMs"), BaseColorReadbackMs);
    Depth->SetNumberField(TEXT("baseColorReadbackWaitMs"), BaseColorReadbackWaitMs);
    Depth->SetBoolField(TEXT("readbackBudgetExceeded"), bDepthReadbackBudgetExceeded);
    Depth->SetNumberField(TEXT("processingCpuMs"), DepthCpuMs);
    Depth->SetNumberField(TEXT("maxProcessingTickMs"), DepthMaxTickCpuMs);
    Depth->SetNumberField(TEXT("processingBudgetMs"), HaybaWorldDepth::MaxProcessingCpuMs);
    Depth->SetStringField(TEXT("readbackMode"), TEXT("async_gpu_staging_render_thread_copy"));
    Depth->SetNumberField(TEXT("readbackWarningMs"), HaybaWorldDepth::ReadbackWarningMs);
    Depth->SetStringField(TEXT("attribution"), TEXT("anchor_pixel_physics_ray_verified_or_unknown"));
    Depth->SetStringField(TEXT("normalProvenance"), TEXT("view_facing_estimate"));
    Depth->SetStringField(TEXT("pointColorProvenance"),
        TEXT("rendered_material_base_color_or_scene_color_or_unobserved"));
    Depth->SetStringField(TEXT("visibility"), TEXT("first_depth_surface_from_one_editor_view"));
    TArray<TSharedPtr<FJsonValue>> CameraValues;
    CameraValues.Add(MakeShared<FJsonValueNumber>(DepthCameraCm.X));
    CameraValues.Add(MakeShared<FJsonValueNumber>(DepthCameraCm.Y));
    CameraValues.Add(MakeShared<FJsonValueNumber>(DepthCameraCm.Z));
    Depth->SetArrayField(TEXT("cameraCm"), MoveTemp(CameraValues));
    TArray<TSharedPtr<FJsonValue>> RotationValues;
    RotationValues.Add(MakeShared<FJsonValueNumber>(DepthRotation.Pitch));
    RotationValues.Add(MakeShared<FJsonValueNumber>(DepthRotation.Yaw));
    RotationValues.Add(MakeShared<FJsonValueNumber>(DepthRotation.Roll));
    Depth->SetArrayField(TEXT("cameraRotationDegrees"), MoveTemp(RotationValues));
    Depth->SetNumberField(TEXT("horizontalFovDegrees"), DepthFov);
    Depth->SetBoolField(TEXT("occludedGeometryIncluded"), false);
    Depth->SetBoolField(TEXT("wholeWorldCoverage"), false);
    Completion->SetObjectField(TEXT("depthCapture"), Depth);
    TArray<TSharedPtr<FJsonValue>> Gaps;
    for (const FString& Gap : ScanGaps) Gaps.Add(MakeShared<FJsonValueString>(Gap));
    Completion->SetArrayField(TEXT("gaps"), Gaps);
    FString Json;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
    FJsonSerializer::Serialize(Completion, Writer);
    Run(FString::Printf(TEXT("window.haybaGeometryDone(%d,%s);"), ScanGeneration, *Json));
}

void SHaybaMCPSceneMapWebPanel::Run(const FString& Js)
{
    if (Browser.IsValid()) Browser->ExecuteJavascript(Js);
}

void SHaybaMCPSceneMapWebPanel::SelectLoadedActor(int32 Generation, int32 ActorIndex)
{
    if (Generation != ScanGeneration || !GEditor) return;
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World || World != ScannedWorld.Get()) return;
    if (!Geometry.Actors.IsValidIndex(ActorIndex)) return;
    const HaybaWorldGeometry::FActor& Entry = Geometry.Actors[ActorIndex];
    AActor* Actor = Entry.LoadedActor.Get();
    if (IsValid(Actor) && Actor->GetWorld() == World && Actor->GetPathName() == Entry.Path)
    {
        GEditor->SelectNone(false, true);
        GEditor->SelectActor(Actor, true, /*bNotify=*/false, /*bSelectEvenIfHidden=*/true);
        GEditor->NoteSelectionChange();
    }
}

FString SHaybaMCPSceneMapWebPanel::GeometryToJson() const
{
    // The in-editor preview and read-only MCP world snapshot share one
    // provenance-preserving metadata contract. The page adds only its live
    // generation and editor-selection capability.
    TSharedRef<FJsonObject> Root = HaybaWorldGeometry::ToMetadataJson(Geometry);
    Root->SetNumberField(TEXT("generation"), ScanGeneration);
    Root->SetBoolField(TEXT("nativeSelection"), true);
    Root->SetStringField(TEXT("worldState"), ScannedWorld.IsValid() ? TEXT("loading") : TEXT("no_world"));
    FString Json;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
    FJsonSerializer::Serialize(Root, Writer);
    return Json;
}

void SHaybaMCPSceneMapWebPanel::QueueTile(int32 Generation, int32 LOD, int32 X, int32 Y, int32 Z)
{
    if (FHaybaEditorHealth::IsUnsafe() ||
        Generation != ScanGeneration || !bPageLoaded || !bScanDone || !ScannedWorld.IsValid() ||
        !GEditor || GEditor->PlayWorld || GEditor->IsPlaySessionRequestQueued()) return;
    FBox Bounds(EForceInit::ForceInit);
    if (!HaybaWorldGeometry::TileBounds(LOD, X, Y, Z, Bounds)) return;
    FTileAddress Address;
    Address.LOD = LOD; Address.X = X; Address.Y = Y; Address.Z = Z;
    Address.Id = HaybaWorldGeometry::TileId(LOD, X, Y, Z);
    Address.BoundsCm = Bounds;
    if ((ActiveTile.IsSet() && ActiveTile->Address.Id == Address.Id) ||
        TileQueue.ContainsByPredicate([&Address](const FTileAddress& Item) { return Item.Id == Address.Id; })) return;
    if (TileQueue.Num() >= 8)
    {
        TSharedRef<FJsonObject> Done = MakeShared<FJsonObject>();
        Done->SetStringField(TEXT("tileId"), Address.Id);
        Done->SetBoolField(TEXT("partial"), true);
        Done->SetArrayField(TEXT("gaps"), {MakeShared<FJsonValueString>(TEXT("tile_request_queue_full"))});
        Done->SetNumberField(TEXT("pointCount"), 0);
        FString Json;
        FJsonSerializer::Serialize(Done, TJsonWriterFactory<>::Create(&Json));
        Run(FString::Printf(TEXT("window.haybaTileDone(%d,%s);"), ScanGeneration, *Json));
        return;
    }
    TileQueue.Add(MoveTemp(Address));
}

void SHaybaMCPSceneMapWebPanel::ProcessTile(UWorld* World)
{
    if (!ActiveTile.IsSet())
    {
        if (TileQueue.IsEmpty() || !bScanDone || !IsValid(World) || World != ScannedWorld.Get()) return;
        FTileRequest Request;
        Request.Address = TileQueue[0];
        Request.CaptureId = FGuid::NewGuid().ToString(EGuidFormats::Digits);
        Request.Generation = ScanGeneration;
        Request.OriginCm = FVector(World->OriginLocation);
        TileQueue.RemoveAt(0);
        for (ULevel* Level : World->GetLevels())
        {
            if (!IsValid(Level)) continue;
            Request.Levels.Add(Level);
            Request.ActorCounts.Add(Level->Actors.Num());
        }
        TSharedRef<FJsonObject> Begin = MakeShared<FJsonObject>();
        Begin->SetStringField(TEXT("tileId"), Request.Address.Id);
        Begin->SetStringField(TEXT("captureId"), Request.CaptureId);
        Begin->SetNumberField(TEXT("lod"), Request.Address.LOD);
        Begin->SetArrayField(TEXT("originCm"), {
            MakeShared<FJsonValueNumber>(World->OriginLocation.X),
            MakeShared<FJsonValueNumber>(World->OriginLocation.Y),
            MakeShared<FJsonValueNumber>(World->OriginLocation.Z)});
        TSharedRef<FJsonObject> Bounds = MakeShared<FJsonObject>();
        Bounds->SetArrayField(TEXT("min"), {
            MakeShared<FJsonValueNumber>(Request.Address.BoundsCm.Min.X),
            MakeShared<FJsonValueNumber>(Request.Address.BoundsCm.Min.Y),
            MakeShared<FJsonValueNumber>(Request.Address.BoundsCm.Min.Z)});
        Bounds->SetArrayField(TEXT("max"), {
            MakeShared<FJsonValueNumber>(Request.Address.BoundsCm.Max.X),
            MakeShared<FJsonValueNumber>(Request.Address.BoundsCm.Max.Y),
            MakeShared<FJsonValueNumber>(Request.Address.BoundsCm.Max.Z)});
        Begin->SetObjectField(TEXT("boundsCm"), Bounds);
        FString Json;
        FJsonSerializer::Serialize(Begin, TJsonWriterFactory<>::Create(&Json));
        Run(FString::Printf(TEXT("window.haybaTileBegin(%d,%s);"), ScanGeneration, *Json));
        TilePageActors.FindOrAdd(Request.Address.Id).Reset();
        TileSelectionCacheOrder.Remove(Request.Address.Id);
        TileSelectionCacheOrder.Add(Request.Address.Id);
        if (TileSelectionCacheOrder.Num() > 32)
        {
            TilePageActors.Remove(TileSelectionCacheOrder[0]);
            TileSelectionCacheOrder.RemoveAt(0);
        }
        ActiveTile.Emplace(MoveTemp(Request));
    }
    FTileRequest& Tile = ActiveTile.GetValue();
    if (Tile.Generation != ScanGeneration || !IsValid(World) || World != ScannedWorld.Get() ||
        !GEditor || GEditor->PlayWorld || GEditor->IsPlaySessionRequestQueued())
    {
        Tile.bPartial = true;
        Tile.Gaps.AddUnique(TEXT("editor_state_changed"));
        FinishTile();
        return;
    }
    if (!Tile.OriginCm.Equals(FVector(World->OriginLocation), 0.0))
    {
        Tile.bPartial = true;
        Tile.Gaps.AddUnique(TEXT("world_origin_changed"));
        FinishTile();
        return;
    }
    if (!Tile.bGatherComplete)
    {
        constexpr int32 SlotLimitPerTick = 256;
        constexpr int32 ActorLimit = 512;
        const double Started = FPlatformTime::Seconds();
        int32 Slots = 0;
        while (Tile.LevelCursor < Tile.Levels.Num() && Slots < SlotLimitPerTick &&
            FPlatformTime::Seconds() - Started < 0.003)
        {
            ULevel* Level = Tile.Levels[Tile.LevelCursor].Get();
            if (!IsValid(Level))
            {
                Tile.bPartial = true; Tile.Gaps.AddUnique(TEXT("loaded_level_unavailable"));
                ++Tile.LevelCursor; Tile.ActorCursor = 0; continue;
            }
            if (Level->Actors.Num() != Tile.ActorCounts[Tile.LevelCursor])
            {
                Tile.bPartial = true; Tile.Gaps.AddUnique(TEXT("loaded_level_changed"));
            }
            if (Tile.ActorCursor >= Tile.ActorCounts[Tile.LevelCursor])
            { ++Tile.LevelCursor; Tile.ActorCursor = 0; continue; }
            const int32 Index = Tile.ActorCursor++;
            ++Slots; ++Tile.ScannedActorSlots;
            if (!Level->Actors.IsValidIndex(Index)) continue;
            AActor* Actor = Level->Actors[Index];
            if (!IsValid(Actor) || Actor->GetWorld() != World || Actor->IsEditorOnly()) continue;
            if (!Actor->GetComponentsBoundingBox(true).Intersect(Tile.Address.BoundsCm)) continue;
            bool bRelevant = false;
            int32 InspectedComponents = 0;
            for (UActorComponent* Component : Actor->GetComponents())
            {
                if (++InspectedComponents > 64)
                {
                    Tile.bPartial = true;
                    Tile.Gaps.AddUnique(TEXT("tile_eligibility_component_cap"));
                    break;
                }
                if (!IsValid(Component) || !Component->IsRegistered()) continue;
                if (Component->IsA<UStaticMeshComponent>() || Component->IsA<USkeletalMeshComponent>() ||
                    Component->IsA<ULandscapeComponent>()) { bRelevant = true; break; }
            }
            if (!bRelevant) continue;
            if (Tile.EligibleActors.Num() >= ActorLimit)
            {
                Tile.bPartial = true; Tile.Gaps.AddUnique(TEXT("tile_actor_cap"));
                Tile.bGatherComplete = true; break;
            }
            Tile.EligibleActors.Add(Actor);
        }
        if (Tile.LevelCursor >= Tile.Levels.Num()) Tile.bGatherComplete = true;
        if (!Tile.bGatherComplete) return;
        // Stable source ordering makes tile pages repeatable across overview
        // rescans while preserving canonical actor/component/node paths.
        Tile.EligibleActors.Sort([](const TWeakObjectPtr<AActor>& A,
            const TWeakObjectPtr<AActor>& B)
        {
            const AActor* Left = A.Get();
            const AActor* Right = B.Get();
            return Left && Right ? Left->GetPathName() < Right->GetPathName() : Left != nullptr;
        });
        if (Tile.EligibleActors.IsEmpty()) { FinishTile(); return; }
    }
    if (Tile.PendingPointCursor < Tile.PendingPage.Splats.Num())
    {
        constexpr int32 ChunkSize = 1024;
        const int32 Start = Tile.PendingPointCursor;
        const int32 End = FMath::Min(Start + ChunkSize, Tile.PendingPage.Splats.Num());
        TSharedRef<FJsonObject> Packet = MakeShared<FJsonObject>();
        Packet->SetNumberField(TEXT("pageId"), Tile.PageId);
        Packet->SetNumberField(TEXT("chunkIndex"), Start / ChunkSize);
        Packet->SetArrayField(TEXT("originCm"), {
            MakeShared<FJsonValueNumber>(Tile.PendingPage.OriginCm.X),
            MakeShared<FJsonValueNumber>(Tile.PendingPage.OriginCm.Y),
            MakeShared<FJsonValueNumber>(Tile.PendingPage.OriginCm.Z)});
        if (Start == 0)
        {
            const TSharedRef<FJsonObject> Metadata = HaybaWorldGeometry::ToMetadataJson(Tile.PendingPage);
            Packet->SetArrayField(TEXT("actors"), Metadata->GetArrayField(TEXT("actors")));
            Packet->SetArrayField(TEXT("nodes"), Metadata->GetArrayField(TEXT("nodes")));
            Packet->SetObjectField(TEXT("coverage"), Metadata->GetObjectField(TEXT("coverage")).ToSharedRef());
        }
        TArray<TSharedPtr<FJsonValue>> Rows;
        Rows.Reserve(End - Start);
        for (int32 Index = Start; Index < End; ++Index)
            Rows.Add(HaybaWorldGeometry::SplatToJson(Tile.PendingPage.Splats[Index]));
        Packet->SetArrayField(TEXT("splats"), MoveTemp(Rows));
        FString Json;
        FJsonSerializer::Serialize(Packet, TJsonWriterFactory<>::Create(&Json));
        Run(FString::Printf(TEXT("window.haybaTileAppend(%d,'%s',%s);"),
            ScanGeneration, *Tile.Address.Id, *Json));
        Tile.PendingPointCursor = End;
        if (End < Tile.PendingPage.Splats.Num()) return;
    }
    if (Tile.PendingPage.Splats.Num() > 0)
    {
        HaybaWorldTileSnapshot::FPage Captured;
        Captured.PageId = Tile.PageId;
        Captured.Geometry = MoveTemp(Tile.PendingPage);
        Tile.CapturedPages.Add(MoveTemp(Captured));
        ++Tile.PageId;
        Tile.PendingPage = HaybaWorldGeometry::FSnapshot();
        Tile.PendingPointCursor = 0;
    }
    if (Tile.PointCount >= 8192 || Tile.ActorPageCursor >= Tile.EligibleActors.Num())
    {
        if (Tile.ActorPageCursor < Tile.EligibleActors.Num())
        { Tile.bPartial = true; Tile.Gaps.AddUnique(TEXT("tile_point_cap")); }
        FinishTile();
        return;
    }
    TArray<TWeakObjectPtr<AActor>> Batch;
    for (int32 Index = Tile.ActorPageCursor;
        Index < FMath::Min(Tile.ActorPageCursor + 8, Tile.EligibleActors.Num()); ++Index)
        Batch.Add(Tile.EligibleActors[Index]);
    const int32 RemainingActors = Tile.EligibleActors.Num() - Tile.ActorPageCursor;
    const int32 RemainingPoints = 8192 - Tile.PointCount;
    const int32 PageLimit = FMath::Min3(4096, RemainingPoints,
        FMath::Max(1, (RemainingPoints * Batch.Num()) / FMath::Max(1, RemainingActors)));
    Tile.PendingPage = HaybaWorldGeometry::BuildTileBatch(World, Batch,
        Tile.Address.BoundsCm, PageLimit, 0.020);
    Tile.ActorPageCursor += Batch.Num();
    Tile.PointCount += Tile.PendingPage.Splats.Num();
    if (Tile.PendingPage.ActorCount < Batch.Num())
    { Tile.bPartial = true; Tile.Gaps.AddUnique(TEXT("tile_actor_processing_incomplete")); }
    for (const FString& Gap : Tile.PendingPage.StopReasons)
    {
        if (Gap != TEXT("splat_cap"))
        { Tile.bPartial = true; Tile.Gaps.AddUnique(Gap); }
    }
    if (Tile.PendingPage.bDownsampled)
    { Tile.bPartial = true; Tile.Gaps.AddUnique(TEXT("triangle_or_source_downsampled")); }
    for (const TPair<FString, int32>& Unsupported : Tile.PendingPage.UnsupportedByKind)
    {
        if (Unsupported.Value <= 0) continue;
        Tile.bPartial = true;
        Tile.Gaps.AddUnique(FString::Printf(TEXT("unsupported_%s"), *Unsupported.Key));
    }
    if (!Tile.PendingPage.Splats.IsEmpty())
        TilePageActors.FindOrAdd(Tile.Address.Id).Add(Tile.PageId, Tile.PendingPage.Actors);
    else if (Tile.ActorPageCursor >= Tile.EligibleActors.Num()) FinishTile();
}

void SHaybaMCPSceneMapWebPanel::FinishTile()
{
    if (!ActiveTile.IsSet()) return;
    const FTileRequest& Tile = ActiveTile.GetValue();
    TSharedPtr<const HaybaWorldTileSnapshot::FTile> PublishedSnapshot;
    if (!FHaybaEditorHealth::IsUnsafe() && ScannedWorld.IsValid() &&
        Tile.Generation == ScanGeneration &&
        !Tile.Gaps.Contains(TEXT("editor_state_changed")) &&
        !Tile.Gaps.Contains(TEXT("editor_unsafe")) &&
        !Tile.Gaps.Contains(TEXT("world_origin_changed")) &&
        Tile.OriginCm.Equals(FVector(ScannedWorld->OriginLocation), 0.0))
    {
        HaybaWorldTileSnapshot::FTile Published;
        Published.TileId = Tile.Address.Id;
        Published.CaptureId = Tile.CaptureId;
        Published.CapturedAtUtc = FDateTime::UtcNow().ToIso8601();
        Published.World = ScannedWorld.Get();
        Published.WorldPath = ScannedWorld->GetPathName();
        Published.BoundsCm = Tile.Address.BoundsCm;
        Published.OriginCm = Tile.OriginCm;
        Published.LOD = Tile.Address.LOD;
        Published.PointCount = Tile.PointCount;
        Published.ScannedActorSlots = Tile.ScannedActorSlots;
        Published.EligibleActorCount = Tile.EligibleActors.Num();
        Published.bPartial = Tile.bPartial;
        Published.Gaps = Tile.Gaps;
        Published.Pages = MoveTemp(ActiveTile->CapturedPages);
        HaybaWorldTileSnapshot::Publish(MoveTemp(Published));
        PublishedSnapshot = HaybaWorldTileSnapshot::GetForWorld(
            ScannedWorld.Get(), Tile.Address.Id, Tile.CaptureId);
    }
    const bool bPartial = PublishedSnapshot.IsValid() ? PublishedSnapshot->bPartial : true;
    const TArray<FString>& ReportedGaps = PublishedSnapshot.IsValid() ? PublishedSnapshot->Gaps : Tile.Gaps;
    TSharedRef<FJsonObject> Done = MakeShared<FJsonObject>();
    Done->SetStringField(TEXT("tileId"), Tile.Address.Id);
    Done->SetStringField(TEXT("captureId"), Tile.CaptureId);
    Done->SetNumberField(TEXT("lod"), Tile.Address.LOD);
    Done->SetNumberField(TEXT("pointCount"), Tile.PointCount);
    Done->SetNumberField(TEXT("scannedActorSlots"), Tile.ScannedActorSlots);
    Done->SetNumberField(TEXT("eligibleActorCount"), Tile.EligibleActors.Num());
    Done->SetNumberField(TEXT("maxPointsPerTile"), 8192);
    Done->SetBoolField(TEXT("partial"), bPartial);
    Done->SetStringField(TEXT("source"), TEXT("cpu_render_lod_clipped_to_world_tile"));
    Done->SetBoolField(TEXT("loadedOnly"), true);
    Done->SetBoolField(TEXT("wholeWorldCoverage"), false);
    TArray<TSharedPtr<FJsonValue>> Gaps;
    for (const FString& Gap : ReportedGaps) Gaps.Add(MakeShared<FJsonValueString>(Gap));
    Done->SetArrayField(TEXT("gaps"), MoveTemp(Gaps));
    FString Json;
    FJsonSerializer::Serialize(Done, TJsonWriterFactory<>::Create(&Json));
    Run(FString::Printf(TEXT("window.haybaTileDone(%d,%s);"), ScanGeneration, *Json));
    ActiveTile.Reset();
}

void SHaybaMCPSceneMapWebPanel::SelectLoadedTileActor(int32 Generation, int32 LOD,
    int32 X, int32 Y, int32 Z, int32 PageId, int32 ActorIndex)
{
    const FString TileId = HaybaWorldGeometry::TileId(LOD, X, Y, Z);
    auto Report = [this, Generation, &TileId, PageId, ActorIndex](bool bSelected, const TCHAR* Reason)
    {
        TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("tileId"), TileId);
        Result->SetNumberField(TEXT("pageId"), PageId);
        Result->SetNumberField(TEXT("actorIndex"), ActorIndex);
        Result->SetBoolField(TEXT("selected"), bSelected);
        Result->SetStringField(TEXT("reason"), Reason);
        FString Json;
        FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&Json));
        Run(FString::Printf(TEXT("window.haybaTileSelectionResult(%d,%s);"), Generation, *Json));
    };
    if (Generation != ScanGeneration) { Report(false, TEXT("stale_generation")); return; }
    if (!GEditor || GEditor->PlayWorld || GEditor->IsPlaySessionRequestQueued())
    { Report(false, TEXT("editor_busy")); return; }
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!IsValid(World) || World != ScannedWorld.Get())
    { Report(false, TEXT("world_changed")); return; }
    FBox Bounds(EForceInit::ForceInit);
    if (!HaybaWorldGeometry::TileBounds(LOD, X, Y, Z, Bounds))
    { Report(false, TEXT("invalid_tile")); return; }
    const TMap<int32, TArray<HaybaWorldGeometry::FActor>>* Pages =
        TilePageActors.Find(TileId);
    const TArray<HaybaWorldGeometry::FActor>* Actors = Pages ? Pages->Find(PageId) : nullptr;
    if (!Actors || !Actors->IsValidIndex(ActorIndex))
    { Report(false, TEXT("not_cached")); return; }
    const HaybaWorldGeometry::FActor& Entry = (*Actors)[ActorIndex];
    AActor* Actor = Entry.LoadedActor.Get();
    if (!IsValid(Actor) || Actor->GetWorld() != World || Actor->GetPathName() != Entry.Path ||
        !Actor->GetComponentsBoundingBox(true).Intersect(Bounds))
    { Report(false, TEXT("source_unavailable")); return; }
    GEditor->SelectNone(false, true);
    GEditor->SelectActor(Actor, true, false, true);
    GEditor->NoteSelectionChange();
    Report(true, TEXT("selected"));
}
