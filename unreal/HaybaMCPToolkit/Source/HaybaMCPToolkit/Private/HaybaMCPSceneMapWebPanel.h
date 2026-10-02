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

class SWebBrowser;
class UWorld;
class ULevel;

class SHaybaMCPSceneMapWebPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPSceneMapWebPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    /** Re-scan and re-render. */
    void Refresh();
    void FitView();
    void ResetView();
    int32 GetCellCount() const { return Geometry.Actors.Num(); }
    virtual void Tick(const FGeometry& AllottedGeometry, const double InCurrentTime,
        const float InDeltaTime) override;

private:
    HaybaWorldGeometry::FSnapshot Geometry;
    TSharedPtr<SWebBrowser>  Browser;
    bool                     bPageLoaded = false;
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
    bool bScanDone = false;
    bool bScanPartial = false;
    TArray<FString> ScanGaps;

    FString ResolveHtmlUrl() const;
    FString GeometryToJson() const;

    void OnPageLoaded();
    void PushGeometryToPage();
    void SendPendingPointChunk();
    void FinishScan();
    void Run(const FString& Js);
    void SelectLoadedActor(int32 Generation, int32 ActorIndex);
};
