// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapWebPanel.h
//
// Browser host for the loaded-world mesh-surface preview.
//
// Falls back to a "WebBrowser not available" message when the WebBrowser
// module isn't initialized (e.g. headless editor / commandlet).
#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "HaybaMCPWorldGeometry.h"
#include "HaybaMCPViewDepthSnapshot.h"
#include "HaybaMCPWorldTileSnapshot.h"
#include "UObject/StrongObjectPtr.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/TextureRenderTarget2D.h"

class SWebBrowser;
class UWorld;
class ULevel;
class FHaybaWorldDepthReadback;

class SHaybaMCPSceneMapWebPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPSceneMapWebPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    virtual ~SHaybaMCPSceneMapWebPanel() override;

    /** Re-scan and re-render. */
    void Refresh();
    void FitView();
    void ResetView();
    /** Navigate to a loaded-world mesh tile and request its local detail. */
    bool FocusTile(int32 LOD, int32 X, int32 Y, int32 Z);
    int32 GetCellCount() const { return Geometry.Actors.Num(); }
    bool IsScanDone() const { return bScanDone; }
    int32 GetDepthPointCount() const { return DepthPointCount; }
    const FString& GetDepthStatus() const { return DepthStatus; }
    double GetDepthReadbackMs() const { return DepthReadbackMs; }
    double GetDepthReadbackGameThreadMaxMs() const { return DepthReadbackGameThreadMaxMs; }
    int32 GetMaterialBaseColorPointCount() const { return MaterialBaseColorPointCount; }
    const FString& GetBaseColorStatus() const { return BaseColorStatus; }
    double GetBaseColorReadbackMs() const { return BaseColorReadbackMs; }
    bool DidDepthReadbackExceedBudget() const { return bDepthReadbackBudgetExceeded; }
    double GetDepthProcessingCpuMs() const { return DepthCpuMs; }
    double GetDepthMaxTickCpuMs() const { return DepthMaxTickCpuMs; }
    int32 GetDepthProcessedPixelCount() const { return DepthPixelCursor; }
    virtual void Tick(const FGeometry& AllottedGeometry, const double InCurrentTime,
        const float InDeltaTime) override;

private:
    HaybaWorldGeometry::FSnapshot Geometry;
    TSharedPtr<SWebBrowser>  Browser;
    bool                     bPageLoaded = false;
    bool                     bPageLoadFailed = false;
    // Custom hayba-scene-map:// commands can emit CEF load callbacks even
    // though their navigation is cancelled. Only the local HTML document may
    // restart a world scan.
    bool                     bExpectDocumentLoad = true;
    double                   PageLoadStartedAt = 0.0;
    int32                    ScanGeneration = 0;
    TWeakObjectPtr<UWorld>   ScannedWorld;
    TArray<TWeakObjectPtr<ULevel>> LoadedLevels;
    TArray<int32> LevelActorCounts;
    TArray<TWeakObjectPtr<AActor>> DeferredActors;
    TMap<FString, int32> DeferredAttempts;
    HaybaWorldGeometry::FSnapshot PendingGeometry;
    int32 LevelCursor = 0;
    int32 ActorCursor = 0;
    int32 PendingPointCursor = 0;
    int32 TotalActorSlots = 0;
    int32 ScannedActorSlots = 0;
    int32 TotalPoints = 0;
    int32 NodeIndexBase = 1;
    TMap<FString, int32> ActorIndexByPath;
    TMap<FString, int32> NodeIndexByPath;
    TStrongObjectPtr<USceneCaptureComponent2D> DepthCapture;
    TStrongObjectPtr<UTextureRenderTarget2D> DepthTarget;
    TSharedPtr<FHaybaWorldDepthReadback, ESPMode::ThreadSafe> DepthReadback;
    TStrongObjectPtr<USceneCaptureComponent2D> BaseColorCapture;
    TStrongObjectPtr<UTextureRenderTarget2D> BaseColorTarget;
    TSharedPtr<FHaybaWorldDepthReadback, ESPMode::ThreadSafe> BaseColorReadback;
    TArray<FLinearColor> DepthPixels;
    TArray<FLinearColor> BaseColorPixels;
    FVector DepthCameraCm = FVector::ZeroVector;
    FRotator DepthRotation = FRotator::ZeroRotator;
    double DepthFov = 90.0;
    int32 DepthPixelCursor = 0;
    int32 DepthAnchorCursor = 0;
    struct FDepthAnchor
    {
        int32 Actor = INDEX_NONE;
        int32 Node = INDEX_NONE;
        double DepthCm = 0.0;
        FString SourceActorPath;
        FString SourceActorLabel;
    };
    TArray<FDepthAnchor> DepthAnchors;
    int32 DepthPointCount = 0;
    int32 DepthAttributedCount = 0;
    int32 MaterialBaseColorPointCount = 0;
    double DepthReadbackMs = 0.0;
    double DepthReadbackWaitMs = 0.0;
    double DepthReadbackStartedAt = 0.0;
    double DepthReadbackGameThreadMaxMs = 0.0;
    double BaseColorReadbackStartedAt = 0.0;
    double BaseColorReadbackMs = 0.0;
    double BaseColorReadbackWaitMs = 0.0;
    FString BaseColorStatus = TEXT("not_attempted");
    bool bDepthReadbackBudgetExceeded = false;
    FString DepthCaptureId;
    double DepthCpuMs = 0.0;
    double DepthMaxTickCpuMs = 0.0;
    FString DepthStatus = TEXT("not_attempted");
    enum class EDepthPhase : uint8 { NotStarted, AwaitReadback, Processing, Complete };
    EDepthPhase DepthPhase = EDepthPhase::NotStarted;
    HaybaViewDepthSnapshot::FSnapshot ObservedDepth;
    bool bDepthSnapshotPublished = false;
    bool bScanDone = false;
    bool bScanPartial = false;
    TArray<FString> ScanGaps;

    struct FTileAddress
    {
        int32 LOD = 0, X = 0, Y = 0, Z = 0;
        FString Id;
        FBox BoundsCm = FBox(EForceInit::ForceInit);
    };
    struct FTileRequest
    {
        FTileAddress Address;
        FString CaptureId;
        int32 Generation = 0;
        FVector OriginCm = FVector::ZeroVector;
        TArray<TWeakObjectPtr<ULevel>> Levels;
        TArray<int32> ActorCounts;
        TArray<TWeakObjectPtr<AActor>> EligibleActors;
        TArray<FString> Gaps;
        int32 LevelCursor = 0, ActorCursor = 0, ScannedActorSlots = 0;
        int32 ActorPageCursor = 0, PageId = 0, PendingPointCursor = 0;
        int32 PointCount = 0;
        HaybaWorldGeometry::FSnapshot PendingPage;
        TArray<HaybaWorldTileSnapshot::FPage> CapturedPages;
        bool bGatherComplete = false;
        bool bPartial = false;
    };
    TArray<FTileAddress> TileQueue;
    TOptional<FTileRequest> ActiveTile;
    TMap<FString, TMap<int32, TArray<HaybaWorldGeometry::FActor>>> TilePageActors;
    TArray<FString> TileSelectionCacheOrder;

    FString ResolveHtmlUrl() const;
    FString GeometryToJson() const;

    void OnPageLoaded();
    void PushGeometryToPage();
    void SendPendingPointChunk();
    void FinishScan();
    void BeginDepthCapture();
    void BeginBaseColorCapture(UWorld* World);
    void ProcessDepthPixels(UWorld* World);
    void ReleaseBaseColorCapture();
    void ReleaseDepthCapture();
    void Run(const FString& Js);
    void SelectLoadedActor(int32 Generation, int32 ActorIndex);
    void QueueTile(int32 Generation, int32 LOD, int32 X, int32 Y, int32 Z);
    void ProcessTile(UWorld* World);
    void FinishTile();
    void SelectLoadedTileActor(int32 Generation, int32 LOD, int32 X, int32 Y,
        int32 Z, int32 PageId, int32 ActorIndex);
};
